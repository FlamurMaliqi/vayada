"""VAY-1266 regression coverage for frozen card-booking acceptance."""

import asyncio
import json
from contextlib import ExitStack, contextmanager
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

import pytest
from app.database import Database
from app.repositories.booking_repo import BookingRepository
from app.repositories.payment_repo import PaymentRepository
from app.repositories.payout_repo import PayoutRepository
from app.services.booking_service import expire_booking
from app.services.payout_service import DEFAULT_BILLING_CONFIG

from tests.conftest import (
    create_test_affiliate,
    create_test_cancellation_policy,
    create_test_hotel,
    create_test_payment_settings,
    create_test_room_type,
    create_test_user,
    get_auth_headers,
)


async def _create_card_draft(
    client,
    *,
    instant_book: bool,
    pi_id: str,
    deposit_required: bool = False,
    billing_config: dict | None = None,
    expected_application_fee_cents: int = 0,
    expected_platform_fee_amount: float = 0,
    expected_affiliate_commission_amount: float = 0,
    affiliate_commission_pct: float | None = None,
):
    user = await create_test_user()
    hotel = await create_test_hotel(str(user["id"]))
    room = await create_test_room_type(str(hotel["id"]))
    await Database.execute(
        "UPDATE hotels SET instant_book = $2 WHERE id = $1",
        hotel["id"],
        instant_book,
    )
    await create_test_payment_settings(
        str(hotel["id"]),
        stripe_connect_account_id=f"acct_{pi_id}",
        stripe_connect_onboarded=True,
    )
    affiliate = None
    if affiliate_commission_pct is not None:
        affiliate = await create_test_affiliate(str(hotel["id"]))
        await Database.execute(
            """
            UPDATE affiliates
            SET status = 'approved', commission_pct_override = $2
            WHERE id = $1
            """,
            affiliate["id"],
            affiliate_commission_pct,
        )
    if deposit_required:
        await Database.execute(
            "UPDATE room_types SET rate_deposit_settings = $1::jsonb WHERE id = $2",
            json.dumps({"flexible": {"enabled": True, "percentage": 50}}),
            room["id"],
        )

    with ExitStack() as stack:
        create_intent = stack.enter_context(
            patch(
                "app.services.stripe_service.create_payment_intent",
                new_callable=AsyncMock,
                return_value={
                    "id": pi_id,
                    "client_secret": f"{pi_id}_secret",
                    "status": "requires_payment_method",
                },
            )
        )
        if billing_config is not None:
            stack.enter_context(
                patch(
                    "app.services.booking_service.fetch_billing_config",
                    new_callable=AsyncMock,
                    return_value=billing_config,
                )
            )
        response = await client.post(
            f"/api/hotels/{hotel['slug']}/bookings",
            json={
                "roomTypeId": str(room["id"]),
                "guestFirstName": "Instant",
                "guestLastName": "Guest",
                "guestEmail": "instant@example.com",
                "guestPhone": "+1234567890",
                "checkIn": "2026-10-10",
                "checkOut": "2026-10-13",
                "adults": 2,
                "paymentMethod": "card",
                "rateType": "flexible",
                "referralCode": affiliate["referral_code"] if affiliate else None,
            },
        )

    assert response.status_code == 200, response.text
    body = response.json()
    draft = await Database.fetchrow("SELECT * FROM booking_drafts WHERE id = $1", body["draftId"])
    payload = draft["payload"]
    if isinstance(payload, str):
        payload = json.loads(payload)
    expected_capture_method = "manual" if not instant_book and not deposit_required else "automatic"
    assert payload["use_request_flow"] == (not instant_book)
    assert payload["capture_method"] == expected_capture_method
    assert body["stripeAccountId"] == f"acct_{pi_id}"
    assert draft["stripe_account_id"] == f"acct_{pi_id}"
    assert float(draft["stripe_application_fee_amount"]) == (expected_application_fee_cents / 100)
    assert float(draft["stripe_platform_fee_amount"]) == expected_platform_fee_amount
    assert (
        float(draft["stripe_affiliate_commission_amount"]) == expected_affiliate_commission_amount
    )
    assert create_intent.call_args.kwargs["capture_method"] == expected_capture_method
    assert create_intent.call_args.kwargs["stripe_account"] == f"acct_{pi_id}"
    assert (
        create_intent.call_args.kwargs["application_fee_amount"] == expected_application_fee_cents
    )
    return user, hotel, room, body


async def _confirm(client, hotel, draft_id: str, pi_id: str, status: str, capture_method: str):
    with patch(
        "app.services.stripe_service.retrieve_payment_intent",
        new_callable=AsyncMock,
        return_value={
            "id": pi_id,
            "status": status,
            "capture_method": capture_method,
        },
    ) as retrieve_intent:
        response = await client.post(
            f"/api/hotels/{hotel['slug']}/bookings/{draft_id}/confirm-authorization"
        )
    retrieve_intent.assert_awaited_once_with(pi_id, stripe_account=f"acct_{pi_id}")
    return response


async def _stripe_webhook(
    client,
    event_type: str,
    object_id: str,
    object_status: str | None = None,
    **object_fields,
):
    with patch("app.services.stripe_service.construct_webhook_event") as construct_event:
        stripe_object = {"id": object_id, **object_fields}
        if object_status:
            stripe_object["status"] = object_status
        construct_event.return_value = {
            "type": event_type,
            "data": {"object": stripe_object},
        }
        return await client.post(
            "/webhooks/stripe",
            content=b"{}",
            headers={"stripe-signature": "test"},
        )


class _StripeObjectWithoutGet:
    def __init__(self, **values):
        self._values = values

    def __getitem__(self, key):
        return self._values[key]

    def to_dict(self):
        return dict(self._values)


@contextmanager
def _lifecycle_spies():
    targets = {
        "guest_confirmed": "app.services.booking_service.send_guest_booking_accepted",
        "host_notified": "app.services.booking_service.send_host_booking_accepted_to",
        "guest_requested": "app.services.booking_service.send_guest_booking_requested",
        "host_requested": "app.services.booking_service.send_booking_request_notification",
        "push_ari": "app.services.booking_service.push_ari_for_booking",
        "push_availability": ("app.services.booking_service.push_availability_for_room_type"),
        "payment_email": "app.services.email_service.send_guest_payment_confirmed",
        "guest_rejected": "app.services.booking_service.send_guest_booking_rejected",
        "host_rejected": "app.services.booking_service.send_host_booking_rejected",
        "guest_withdrawn": "app.services.booking_service.send_guest_booking_withdrawn",
        "host_withdrawn": "app.services.booking_service.send_host_booking_withdrawn",
        "guest_expired": "app.services.booking_service.send_guest_booking_expired",
        "host_expired": "app.services.booking_service.send_host_booking_expired",
        "guest_cancelled": "app.services.booking_service.send_guest_cancellation_refund",
        "host_cancelled": "app.services.booking_service.send_host_guest_cancelled",
        "cancel_channex": "app.services.booking_service.channex_handle_cancellation",
    }
    with ExitStack() as stack:
        spies = {
            name: stack.enter_context(patch(target, new_callable=AsyncMock))
            for name, target in targets.items()
        }
        spies["host_recipients"] = stack.enter_context(
            patch(
                "app.services.booking_service.booking_host_notification_recipients",
                return_value=["host@example.com"],
            )
        )
        yield SimpleNamespace(**spies)


@pytest.mark.parametrize("webhook_first", [False, True], ids=["browser-first", "webhook-first"])
async def test_instant_card_ordering_uses_frozen_decision_once(
    client, cleanup_database, webhook_first
):
    pi_id = f"pi_instant_{'webhook' if webhook_first else 'browser'}_first"
    _user, hotel, _room, draft = await _create_card_draft(
        client,
        instant_book=True,
        pi_id=pi_id,
    )

    with _lifecycle_spies() as effects:
        if webhook_first:
            await Database.execute(
                "UPDATE hotels SET instant_book = false WHERE id = $1", hotel["id"]
            )
            webhook = await _stripe_webhook(client, "payment_intent.succeeded", pi_id)

        confirmed = await _confirm(
            client,
            hotel,
            draft["draftId"],
            pi_id,
            "succeeded",
            "automatic",
        )
        if not webhook_first:
            # A mutable hotel setting must not alter the accepted checkout.
            await Database.execute(
                "UPDATE hotels SET instant_book = false WHERE id = $1", hotel["id"]
            )
            webhook = await _stripe_webhook(client, "payment_intent.succeeded", pi_id)

        webhook_retry = await _stripe_webhook(client, "payment_intent.succeeded", pi_id)
        browser_retry = await _confirm(
            client, hotel, draft["draftId"], pi_id, "succeeded", "automatic"
        )
        await asyncio.sleep(0)

    assert webhook.status_code == 200
    assert webhook_retry.status_code == 200
    assert confirmed.status_code == 200, confirmed.text
    assert confirmed.json()["status"] == "confirmed"
    assert confirmed.json()["paymentStatus"] == "captured"
    assert browser_retry.status_code == 200
    assert browser_retry.json()["status"] == "confirmed"
    effects.guest_confirmed.assert_awaited_once()
    effects.host_notified.assert_awaited_once()
    effects.push_ari.assert_awaited_once()
    effects.guest_requested.assert_not_awaited()
    effects.host_requested.assert_not_awaited()
    effects.payment_email.assert_not_awaited()

    booking_id = confirmed.json()["id"]
    assert (
        await Database.fetchval("SELECT COUNT(*) FROM payouts WHERE booking_id = $1", booking_id)
        == 0
    )


async def test_browser_waits_for_concurrent_webhook_materialization(client, cleanup_database):
    pi_id = "pi_concurrent_materialization"
    _user, hotel, _room, draft = await _create_card_draft(
        client,
        instant_book=True,
        pi_id=pi_id,
    )
    create_entered = asyncio.Event()
    allow_create = asyncio.Event()
    original_create = BookingRepository.create

    async def slow_create(data):
        create_entered.set()
        await allow_create.wait()
        return await original_create(data)

    with (
        _lifecycle_spies(),
        patch.object(BookingRepository, "create", side_effect=slow_create),
    ):
        webhook_task = asyncio.create_task(
            _stripe_webhook(client, "payment_intent.succeeded", pi_id)
        )
        await asyncio.wait_for(create_entered.wait(), timeout=2)
        browser_task = asyncio.create_task(
            _confirm(client, hotel, draft["draftId"], pi_id, "succeeded", "automatic")
        )
        await asyncio.sleep(0.1)
        assert not browser_task.done()
        allow_create.set()
        webhook, browser = await asyncio.gather(webhook_task, browser_task)

    assert webhook.status_code == 200
    assert browser.status_code == 200
    assert browser.json()["status"] == "confirmed"


async def test_request_card_no_deposit_stays_authorized_and_pending(client, cleanup_database):
    _user, hotel, _room, draft = await _create_card_draft(
        client,
        instant_book=False,
        pi_id="pi_request_no_deposit",
    )

    with _lifecycle_spies() as effects:
        response = await _confirm(
            client,
            hotel,
            draft["draftId"],
            "pi_request_no_deposit",
            "requires_capture",
            "manual",
        )
        await Database.execute("UPDATE hotels SET instant_book = true WHERE id = $1", hotel["id"])
        webhook = await _stripe_webhook(
            client,
            "payment_intent.amount_capturable_updated",
            "pi_request_no_deposit",
        )
        await asyncio.sleep(0)

    assert response.status_code == 200, response.text
    assert webhook.status_code == 200
    assert response.json()["status"] == "pending"
    assert response.json()["paymentStatus"] == "authorized"
    assert response.json()["hostResponseDeadline"] is not None
    effects.guest_requested.assert_awaited_once()
    effects.host_requested.assert_awaited_once()
    effects.push_availability.assert_awaited_once()
    effects.guest_confirmed.assert_not_awaited()


async def test_host_capture_retry_reuses_idempotency_key_after_db_failure(client, cleanup_database):
    user, hotel, _room, draft = await _create_card_draft(
        client,
        instant_book=False,
        pi_id="pi_capture_crash",
    )
    pending = await _confirm(
        client,
        hotel,
        draft["draftId"],
        "pi_capture_crash",
        "requires_capture",
        "manual",
    )
    booking_id = pending.json()["id"]

    with (
        _lifecycle_spies(),
        patch(
            "app.services.stripe_service.capture_payment_intent",
            new_callable=AsyncMock,
            return_value={"id": "pi_capture_crash", "status": "succeeded"},
        ) as capture,
    ):
        with patch(
            "app.services.booking_service.PaymentRepository.update_status",
            new_callable=AsyncMock,
            side_effect=RuntimeError("database unavailable after capture"),
        ):
            with pytest.raises(RuntimeError, match="database unavailable after capture"):
                await client.post(
                    f"/admin/bookings/{booking_id}/accept",
                    headers=get_auth_headers(user["token"]),
                )
        recovered = await client.post(
            f"/admin/bookings/{booking_id}/accept",
            headers=get_auth_headers(user["token"]),
        )

    assert recovered.status_code == 200, recovered.text
    assert recovered.json()["status"] == "confirmed"
    assert capture.await_count == 2
    for capture_call in capture.await_args_list:
        assert capture_call.args == ("pi_capture_crash",)
        assert capture_call.kwargs == {
            "idempotency_key": f"booking-capture-{booking_id}",
            "stripe_account": "acct_pi_capture_crash",
        }


async def test_request_card_deposit_is_captured_but_stays_pending(client, cleanup_database):
    user, hotel, _room, draft = await _create_card_draft(
        client,
        instant_book=False,
        deposit_required=True,
        pi_id="pi_request_deposit",
    )

    with (
        _lifecycle_spies() as effects,
        patch(
            "app.services.stripe_service.capture_payment_intent",
            new_callable=AsyncMock,
        ) as capture_intent,
    ):
        response = await _confirm(
            client,
            hotel,
            draft["draftId"],
            "pi_request_deposit",
            "succeeded",
            "automatic",
        )
        accepted = await client.post(
            f"/admin/bookings/{response.json()['id']}/accept",
            headers=get_auth_headers(user["token"]),
        )
        await asyncio.sleep(0)

    assert response.status_code == 200, response.text
    assert response.json()["status"] == "pending"
    assert response.json()["paymentStatus"] == "captured"
    assert response.json()["depositRequired"] is True
    assert accepted.status_code == 200, accepted.text
    assert accepted.json()["status"] == "confirmed"
    capture_intent.assert_not_awaited()
    effects.guest_requested.assert_awaited_once()
    effects.host_requested.assert_awaited_once()
    effects.guest_confirmed.assert_awaited_once()


async def test_browser_does_not_materialize_unsettled_stripe_payment(client, cleanup_database):
    _user, hotel, _room, draft = await _create_card_draft(
        client,
        instant_book=True,
        pi_id="pi_instant_unsettled",
    )

    response = await _confirm(
        client,
        hotel,
        draft["draftId"],
        "pi_instant_unsettled",
        "requires_payment_method",
        "automatic",
    )

    assert response.status_code == 400
    assert "has not completed" in response.json()["detail"]
    assert (
        await Database.fetchval(
            "SELECT COUNT(*) FROM bookings WHERE booking_reference = $1",
            draft["bookingReference"],
        )
        == 0
    )


async def test_failed_card_attempt_can_succeed_on_same_intent(client, cleanup_database):
    _user, hotel, _room, draft = await _create_card_draft(
        client,
        instant_book=True,
        pi_id="pi_instant_retry",
    )

    with _lifecycle_spies() as effects:
        failed = await _stripe_webhook(client, "payment_intent.payment_failed", "pi_instant_retry")
        succeeded = await _stripe_webhook(client, "payment_intent.succeeded", "pi_instant_retry")
        browser = await _confirm(
            client,
            hotel,
            draft["draftId"],
            "pi_instant_retry",
            "succeeded",
            "automatic",
        )
        delayed_failure = await _stripe_webhook(
            client, "payment_intent.payment_failed", "pi_instant_retry"
        )

    assert failed.status_code == 200
    assert succeeded.status_code == 200
    assert browser.status_code == 200, browser.text
    assert delayed_failure.status_code == 200
    assert browser.json()["status"] == "confirmed"
    effects.guest_confirmed.assert_awaited_once()
    effects.host_notified.assert_awaited_once()
    effects.push_ari.assert_awaited_once()
    assert (
        await Database.fetchval(
            "SELECT COUNT(*) FROM bookings WHERE booking_reference = $1",
            draft["bookingReference"],
        )
        == 1
    )
    persisted = await Database.fetchrow(
        """
        SELECT b.status AS booking_status, b.payment_status, p.status AS provider_status
        FROM bookings b JOIN payments p ON p.booking_id = b.id
        WHERE b.booking_reference = $1
        """,
        draft["bookingReference"],
    )
    assert dict(persisted) == {
        "booking_status": "confirmed",
        "payment_status": "captured",
        "provider_status": "captured",
    }


async def test_commission_plan_is_collected_as_application_fee(client, cleanup_database):
    billing = {
        **DEFAULT_BILLING_CONFIG,
        "active_plan": "commission",
        "booking_engine_fee_pct": 5.0,
    }
    _user, _hotel, _room, draft = await _create_card_draft(
        client,
        instant_book=True,
        pi_id="pi_commission_fee",
        billing_config=billing,
        expected_application_fee_cents=2250,
        expected_platform_fee_amount=22.5,
    )

    assert draft["booking"]["totalAmount"] == 450


@pytest.mark.parametrize(
    ("plan", "platform_pct", "affiliate_platform_pct", "application_fee_cents"),
    [
        ("commission", 5.0, 0.0, 6750),
        ("fixed", 0.0, 2.0, 5400),
    ],
)
async def test_affiliate_commission_is_funded_by_direct_charge_application_fee(
    client,
    cleanup_database,
    plan,
    platform_pct,
    affiliate_platform_pct,
    application_fee_cents,
):
    billing = {
        **DEFAULT_BILLING_CONFIG,
        "active_plan": plan,
        "booking_engine_fee_pct": platform_pct,
        "affiliate_platform_fee_pct": affiliate_platform_pct,
    }
    _user, hotel, _room, draft = await _create_card_draft(
        client,
        instant_book=True,
        pi_id=f"pi_affiliate_{plan}",
        billing_config=billing,
        expected_application_fee_cents=application_fee_cents,
        expected_platform_fee_amount=22.5 if plan == "commission" else 9,
        expected_affiliate_commission_amount=45,
        affiliate_commission_pct=10,
    )

    with _lifecycle_spies():
        confirmed = await _confirm(
            client,
            hotel,
            draft["draftId"],
            f"pi_affiliate_{plan}",
            "succeeded",
            "automatic",
        )

    assert confirmed.status_code == 200, confirmed.text
    booking_id = confirmed.json()["id"]
    booking = await Database.fetchrow(
        """
        SELECT platform_fee_amount, affiliate_commission_amount, property_payout_amount
        FROM bookings WHERE id = $1
        """,
        booking_id,
    )
    assert float(booking["platform_fee_amount"]) == (22.5 if plan == "commission" else 9)
    assert float(booking["affiliate_commission_amount"]) == 45
    assert float(booking["property_payout_amount"]) == (382.5 if plan == "commission" else 396)
    payouts = await Database.fetch(
        "SELECT recipient_type, amount FROM payouts WHERE booking_id = $1", booking_id
    )
    assert [(row["recipient_type"], float(row["amount"])) for row in payouts] == [("affiliate", 45)]


@pytest.mark.parametrize(
    ("free_days", "partial_pct", "refund_cents", "payment_status"),
    [
        (7, 0, None, "refunded"),
        (365, 50, 22_500, "partially_refunded"),
    ],
    ids=["full", "partial"],
)
async def test_direct_charge_refund_returns_application_fee(
    client,
    cleanup_database,
    free_days,
    partial_pct,
    refund_cents,
    payment_status,
):
    billing = {
        **DEFAULT_BILLING_CONFIG,
        "active_plan": "commission",
        "booking_engine_fee_pct": 5.0,
    }
    _user, hotel, _room, draft = await _create_card_draft(
        client,
        instant_book=True,
        pi_id=f"pi_cancel_{payment_status}",
        billing_config=billing,
        expected_application_fee_cents=2250,
        expected_platform_fee_amount=22.5,
    )
    await create_test_cancellation_policy(
        str(hotel["id"]),
        free_cancellation_days=free_days,
        partial_refund_pct=partial_pct,
    )
    with _lifecycle_spies():
        confirmed = await _confirm(
            client,
            hotel,
            draft["draftId"],
            f"pi_cancel_{payment_status}",
            "succeeded",
            "automatic",
        )

    booking_id = confirmed.json()["id"]
    with patch(
        "app.services.stripe_service.create_refund",
        new_callable=AsyncMock,
        return_value={"id": "re_direct", "status": "succeeded"},
    ) as refund:
        response = await client.post(
            f"/api/hotels/{hotel['slug']}/bookings/{booking_id}/cancel",
            json={"guest_email": "instant@example.com"},
        )

    assert response.status_code == 200, response.text
    payment = await Database.fetchrow(
        "SELECT id, status, currency FROM payments WHERE booking_id = $1", booking_id
    )
    command_id = f"guest-cancellation-refund-{booking_id}-{refund_cents or 'full'}"
    refund.assert_awaited_once_with(
        f"pi_cancel_{payment_status}",
        amount=refund_cents,
        idempotency_key=command_id,
        metadata={
            "booking_id": booking_id,
            "payment_id": str(payment["id"]),
            "refund_command_id": command_id,
            "refund_amount_minor": str(refund_cents or 45_000),
            "refund_currency": payment["currency"].lower(),
        },
        stripe_account=f"acct_pi_cancel_{payment_status}",
        refund_application_fee=True,
    )
    assert payment["status"] == payment_status


async def test_failed_direct_charge_refund_keeps_booking_confirmed(client, cleanup_database):
    billing = {
        **DEFAULT_BILLING_CONFIG,
        "active_plan": "commission",
        "booking_engine_fee_pct": 5.0,
    }
    _user, hotel, _room, draft = await _create_card_draft(
        client,
        instant_book=True,
        pi_id="pi_cancel_failure",
        billing_config=billing,
        expected_application_fee_cents=2250,
        expected_platform_fee_amount=22.5,
    )
    await create_test_cancellation_policy(str(hotel["id"]), free_cancellation_days=7)
    with _lifecycle_spies():
        confirmed = await _confirm(
            client,
            hotel,
            draft["draftId"],
            "pi_cancel_failure",
            "succeeded",
            "automatic",
        )

    booking_id = confirmed.json()["id"]
    with patch(
        "app.services.stripe_service.create_refund",
        new_callable=AsyncMock,
        side_effect=RuntimeError("Stripe unavailable"),
    ):
        response = await client.post(
            f"/api/hotels/{hotel['slug']}/bookings/{booking_id}/cancel",
            json={"guest_email": "instant@example.com"},
        )

    assert response.status_code == 500
    booking = await Database.fetchrow(
        "SELECT status, payment_status FROM bookings WHERE id = $1", booking_id
    )
    payment = await Database.fetchrow(
        "SELECT status FROM payments WHERE booking_id = $1", booking_id
    )
    assert dict(booking) == {"status": "confirmed", "payment_status": "captured"}
    assert payment["status"] == "captured"


async def test_returned_failed_refund_is_persisted_without_cancelling_booking(
    client, cleanup_database
):
    _user, hotel, _room, draft = await _create_card_draft(
        client,
        instant_book=True,
        pi_id="pi_refund_failed_status",
    )
    await create_test_cancellation_policy(str(hotel["id"]), free_cancellation_days=7)
    with _lifecycle_spies():
        confirmed = await _confirm(
            client,
            hotel,
            draft["draftId"],
            "pi_refund_failed_status",
            "succeeded",
            "automatic",
        )
    booking_id = confirmed.json()["id"]

    with patch(
        "app.services.stripe_service.create_refund",
        new_callable=AsyncMock,
        return_value={"id": "re_failed_status", "status": "failed"},
    ):
        response = await client.post(
            f"/api/hotels/{hotel['slug']}/bookings/{booking_id}/cancel",
            json={"guest_email": "instant@example.com"},
        )

    assert response.status_code == 500
    booking = await Database.fetchrow(
        "SELECT status, payment_status FROM bookings WHERE id = $1", booking_id
    )
    payment = await Database.fetchrow(
        "SELECT status, stripe_refund_id, stripe_refund_status FROM payments WHERE booking_id = $1",
        booking_id,
    )
    assert dict(booking) == {"status": "confirmed", "payment_status": "captured"}
    assert dict(payment) == {
        "status": "captured",
        "stripe_refund_id": "re_failed_status",
        "stripe_refund_status": "failed",
    }


async def test_refund_webhook_normalizes_legacy_stripe_objects(client):
    refund = _StripeObjectWithoutGet(id="re_legacy_object", status="succeeded")
    with (
        patch("app.services.stripe_service.construct_webhook_event") as construct_event,
        patch(
            "app.services.booking_service.reconcile_stripe_refund_event",
            new_callable=AsyncMock,
            return_value={"id": "payment_1"},
        ) as reconcile,
    ):
        construct_event.return_value = {
            "type": "refund.updated",
            "data": {"object": refund},
        }
        response = await client.post(
            "/webhooks/stripe/connect",
            content=b"{}",
            headers={"stripe-signature": "test"},
    )

    assert response.status_code == 200, response.text
    normalized = reconcile.await_args.args[0]
    assert type(normalized) is dict
    assert normalized == {"id": "re_legacy_object", "status": "succeeded"}


@pytest.mark.parametrize(
    ("event_type", "event_status", "expected_booking_status", "expected_payment_status"),
    [
        ("refund.updated", "succeeded", "cancelled", "refunded"),
        ("refund.failed", "failed", "confirmed", "captured"),
        ("refund.updated", "canceled", "confirmed", "captured"),
    ],
)
async def test_pending_refund_is_reconciled_by_webhook(
    client,
    cleanup_database,
    event_type,
    event_status,
    expected_booking_status,
    expected_payment_status,
):
    pi_id = f"pi_refund_async_{event_status}"
    refund_id = f"re_async_{event_status}"
    _user, hotel, _room, draft = await _create_card_draft(
        client,
        instant_book=True,
        pi_id=pi_id,
    )
    await create_test_cancellation_policy(str(hotel["id"]), free_cancellation_days=7)
    with _lifecycle_spies():
        confirmed = await _confirm(
            client,
            hotel,
            draft["draftId"],
            pi_id,
            "succeeded",
            "automatic",
        )
    booking_id = confirmed.json()["id"]

    with (
        _lifecycle_spies() as effects,
        patch(
            "app.services.stripe_service.create_refund",
            new_callable=AsyncMock,
            return_value={"id": refund_id, "status": "pending"},
        ),
    ):
        pending = await client.post(
            f"/api/hotels/{hotel['slug']}/bookings/{booking_id}/cancel",
            json={"guest_email": "instant@example.com"},
        )
        webhook = await _stripe_webhook(client, event_type, refund_id, event_status)
        await asyncio.sleep(0)

    assert pending.status_code == 500
    assert webhook.status_code == 200
    booking = await Database.fetchrow(
        "SELECT status, payment_status, stripe_refund_processing FROM bookings WHERE id = $1",
        booking_id,
    )
    payment = await Database.fetchrow(
        "SELECT status, stripe_refund_status FROM payments WHERE booking_id = $1",
        booking_id,
    )
    assert dict(booking) == {
        "status": expected_booking_status,
        "payment_status": expected_payment_status,
        "stripe_refund_processing": False,
    }
    assert dict(payment) == {
        "status": expected_payment_status,
        "stripe_refund_status": event_status,
    }
    if event_status == "succeeded":
        effects.guest_cancelled.assert_awaited_once()
        effects.host_cancelled.assert_awaited_once()
        effects.cancel_channex.assert_awaited_once_with(booking_id)
    else:
        effects.guest_cancelled.assert_not_awaited()
        effects.host_cancelled.assert_not_awaited()
        effects.cancel_channex.assert_not_awaited()


async def test_refund_created_recovers_provider_success_before_local_attach(
    client, cleanup_database
):
    pi_id = "pi_refund_attach_recovery"
    refund_id = "re_attach_recovery"
    _user, hotel, _room, draft = await _create_card_draft(
        client,
        instant_book=True,
        pi_id=pi_id,
    )
    await create_test_cancellation_policy(str(hotel["id"]), free_cancellation_days=7)
    with _lifecycle_spies():
        confirmed = await _confirm(client, hotel, draft["draftId"], pi_id, "succeeded", "automatic")
    booking_id = confirmed.json()["id"]

    with (
        patch(
            "app.services.stripe_service.create_refund",
            new_callable=AsyncMock,
            return_value={"id": refund_id, "status": "succeeded"},
        ),
        patch.object(
            PaymentRepository,
            "attach_stripe_refund",
            new_callable=AsyncMock,
            side_effect=RuntimeError("database unavailable after Stripe refund"),
        ),
    ):
        failed = await client.post(
            f"/api/hotels/{hotel['slug']}/bookings/{booking_id}/cancel",
            json={"guest_email": "instant@example.com"},
        )

    assert failed.status_code == 500
    prepared = await Database.fetchrow(
        "SELECT id, currency, stripe_refund_command_id, stripe_refund_amount_minor "
        "FROM payments WHERE booking_id = $1",
        booking_id,
    )
    assert prepared["stripe_refund_command_id"]

    with _lifecycle_spies() as effects:
        recovered = await _stripe_webhook(
            client,
            "refund.created",
            refund_id,
            "succeeded",
            payment_intent=pi_id,
            amount=prepared["stripe_refund_amount_minor"],
            currency=prepared["currency"],
            metadata={
                "payment_id": str(prepared["id"]),
                "refund_command_id": prepared["stripe_refund_command_id"],
                "refund_amount_minor": str(prepared["stripe_refund_amount_minor"]),
                "refund_currency": prepared["currency"].lower(),
            },
        )

    assert recovered.status_code == 200, recovered.text
    booking = await Database.fetchrow(
        "SELECT status, payment_status, stripe_refund_processing FROM bookings WHERE id = $1",
        booking_id,
    )
    payment = await Database.fetchrow(
        "SELECT status, stripe_refund_id, stripe_refund_status, stripe_refund_completed_at "
        "FROM payments WHERE booking_id = $1",
        booking_id,
    )
    assert dict(booking) == {
        "status": "cancelled",
        "payment_status": "refunded",
        "stripe_refund_processing": False,
    }
    assert payment["status"] == "refunded"
    assert payment["stripe_refund_id"] == refund_id
    assert payment["stripe_refund_status"] == "succeeded"
    assert payment["stripe_refund_completed_at"] is not None
    effects.guest_cancelled.assert_awaited_once()
    effects.host_cancelled.assert_awaited_once()


async def test_succeeded_refund_replays_only_unfinished_effects(client, cleanup_database):
    pi_id = "pi_refund_effect_replay"
    refund_id = "re_effect_replay"
    _user, hotel, _room, draft = await _create_card_draft(
        client,
        instant_book=True,
        pi_id=pi_id,
    )
    await create_test_cancellation_policy(str(hotel["id"]), free_cancellation_days=7)
    with _lifecycle_spies():
        confirmed = await _confirm(client, hotel, draft["draftId"], pi_id, "succeeded", "automatic")
    booking_id = confirmed.json()["id"]

    with (
        _lifecycle_spies() as effects,
        patch(
            "app.services.stripe_service.create_refund",
            new_callable=AsyncMock,
            return_value={"id": refund_id, "status": "succeeded"},
        ),
    ):
        effects.cancel_channex.side_effect = RuntimeError("channel manager unavailable")
        interrupted = await client.post(
            f"/api/hotels/{hotel['slug']}/bookings/{booking_id}/cancel",
            json={"guest_email": "instant@example.com"},
        )
        effects.cancel_channex.side_effect = None
        replayed = await _stripe_webhook(client, "refund.updated", refund_id, "succeeded")

    assert interrupted.status_code == 500
    assert replayed.status_code == 200, replayed.text
    effects.guest_cancelled.assert_awaited_once()
    effects.host_cancelled.assert_awaited_once()
    assert effects.cancel_channex.await_count == 2
    effects.push_ari.assert_awaited_once_with(booking_id)
    payment = await Database.fetchrow(
        "SELECT stripe_refund_completed_at FROM payments WHERE booking_id = $1", booking_id
    )
    assert payment["stripe_refund_completed_at"] is not None
    assert not await Database.fetchval(
        "SELECT stripe_refund_processing FROM bookings WHERE id = $1", booking_id
    )


async def test_delayed_refund_event_cannot_overwrite_retry_command(client, cleanup_database):
    pi_id = "pi_refund_command_retry"
    _user, hotel, _room, draft = await _create_card_draft(
        client,
        instant_book=True,
        pi_id=pi_id,
    )
    await create_test_cancellation_policy(str(hotel["id"]), free_cancellation_days=7)
    with _lifecycle_spies():
        confirmed = await _confirm(client, hotel, draft["draftId"], pi_id, "succeeded", "automatic")
    booking_id = confirmed.json()["id"]

    with patch(
        "app.services.stripe_service.create_refund",
        new_callable=AsyncMock,
        side_effect=[
            {"id": "re_command_a", "status": "failed"},
            {"id": "re_command_b", "status": "pending"},
        ],
    ):
        first = await client.post(
            f"/api/hotels/{hotel['slug']}/bookings/{booking_id}/cancel",
            json={"guest_email": "instant@example.com"},
        )
        second = await client.post(
            f"/api/hotels/{hotel['slug']}/bookings/{booking_id}/cancel",
            json={"guest_email": "instant@example.com"},
        )

    assert first.status_code == 500
    assert second.status_code == 500
    payment = await Database.fetchrow(
        "SELECT id, currency, stripe_refund_command_id, stripe_refund_id, "
        "stripe_refund_status, stripe_refund_amount_minor "
        "FROM payments WHERE booking_id = $1",
        booking_id,
    )
    retry_command = payment["stripe_refund_command_id"]
    assert retry_command.endswith("-after-re_command_a")

    stale = await _stripe_webhook(
        client,
        "refund.updated",
        "re_command_a",
        "succeeded",
        payment_intent=pi_id,
        amount=payment["stripe_refund_amount_minor"],
        currency=payment["currency"],
        metadata={
            "payment_id": str(payment["id"]),
            "refund_command_id": f"guest-cancellation-refund-{booking_id}-full",
            "refund_amount_minor": str(payment["stripe_refund_amount_minor"]),
            "refund_currency": payment["currency"].lower(),
        },
    )

    assert stale.status_code == 200, stale.text
    current = await Database.fetchrow(
        "SELECT stripe_refund_command_id, stripe_refund_id, stripe_refund_status "
        "FROM payments WHERE booking_id = $1",
        booking_id,
    )
    assert dict(current) == {
        "stripe_refund_command_id": retry_command,
        "stripe_refund_id": "re_command_b",
        "stripe_refund_status": "pending",
    }
    booking = await Database.fetchrow(
        "SELECT status, payment_status, stripe_refund_processing FROM bookings WHERE id = $1",
        booking_id,
    )
    assert dict(booking) == {
        "status": "confirmed",
        "payment_status": "captured",
        "stripe_refund_processing": True,
    }


async def test_refund_reservation_races_booking_finalization_atomically(client, cleanup_database):
    pi_id = "pi_refund_finalize_race"
    _user, hotel, _room, draft = await _create_card_draft(
        client,
        instant_book=False,
        deposit_required=True,
        pi_id=pi_id,
    )
    with _lifecycle_spies():
        pending = await _confirm(client, hotel, draft["draftId"], pi_id, "succeeded", "automatic")
    booking_id = pending.json()["id"]
    payment = await PaymentRepository.get_by_booking_id(booking_id)

    prepared, claimed = await asyncio.gather(
        PaymentRepository.prepare_stripe_refund(
            str(payment["id"]),
            command_id=f"race-refund-{booking_id}",
            target_status="refunded",
            target_booking_status="declined",
            expected_booking_status="pending",
            refund_amount=float(payment["amount"]),
            refund_percentage=100,
            refund_amount_minor=int(float(payment["amount"]) * 100),
            refund_currency=payment["currency"].lower(),
        ),
        BookingRepository.claim_finalization(booking_id, "00000000-0000-0000-0000-000000000001"),
    )

    assert bool(prepared) != claimed


async def test_refund_reservation_races_payout_claim_atomically(client, cleanup_database):
    pi_id = "pi_refund_payout_race"
    billing = {
        **DEFAULT_BILLING_CONFIG,
        "active_plan": "commission",
        "booking_engine_fee_pct": 5.0,
    }
    _user, hotel, _room, draft = await _create_card_draft(
        client,
        instant_book=True,
        pi_id=pi_id,
        billing_config=billing,
        expected_application_fee_cents=6750,
        expected_platform_fee_amount=22.5,
        expected_affiliate_commission_amount=45,
        affiliate_commission_pct=10,
    )
    with _lifecycle_spies():
        confirmed = await _confirm(client, hotel, draft["draftId"], pi_id, "succeeded", "automatic")
    booking_id = confirmed.json()["id"]
    payment = await PaymentRepository.get_by_booking_id(booking_id)
    payout = await Database.fetchrow(
        "SELECT id FROM payouts WHERE booking_id = $1 AND status = 'scheduled'", booking_id
    )

    prepared, claimed = await asyncio.gather(
        PaymentRepository.prepare_stripe_refund(
            str(payment["id"]),
            command_id=f"race-refund-{booking_id}",
            target_status="refunded",
            target_booking_status="cancelled",
            expected_booking_status="confirmed",
            refund_amount=float(payment["amount"]),
            refund_percentage=100,
            refund_amount_minor=int(float(payment["amount"]) * 100),
            refund_currency=payment["currency"].lower(),
        ),
        PayoutRepository.claim_for_processing(str(payout["id"])),
    )

    assert bool(prepared) != bool(claimed)


async def test_instant_finalize_failure_recovers_on_webhook(client, cleanup_database):
    _user, hotel, _room, draft = await _create_card_draft(
        client,
        instant_book=True,
        pi_id="pi_instant_recovery",
    )

    with patch(
        "app.services.booking_service.schedule_payouts",
        new_callable=AsyncMock,
        side_effect=RuntimeError("payout scheduling unavailable"),
    ):
        failed = await _confirm(
            client,
            hotel,
            draft["draftId"],
            "pi_instant_recovery",
            "succeeded",
            "automatic",
        )
    assert failed.status_code == 500

    pending = await Database.fetchrow(
        "SELECT id, status, payment_status FROM bookings WHERE booking_reference = $1",
        draft["bookingReference"],
    )
    assert pending["status"] == "pending"
    assert pending["payment_status"] == "captured"
    assert (
        await Database.fetchval(
            "SELECT finalization_token FROM bookings WHERE id = $1", pending["id"]
        )
        is None
    )

    finalizer_entered = asyncio.Event()
    allow_finalizer = asyncio.Event()

    async def slow_schedule_payouts(**_kwargs):
        finalizer_entered.set()
        await allow_finalizer.wait()

    with (
        _lifecycle_spies() as effects,
        patch(
            "app.services.booking_service.schedule_payouts",
            new_callable=AsyncMock,
            side_effect=slow_schedule_payouts,
        ),
    ):
        webhook_task = asyncio.create_task(
            _stripe_webhook(client, "payment_intent.succeeded", "pi_instant_recovery")
        )
        await asyncio.wait_for(finalizer_entered.wait(), timeout=2)

        concurrent_browser_task = asyncio.create_task(
            _confirm(
                client,
                hotel,
                draft["draftId"],
                "pi_instant_recovery",
                "succeeded",
                "automatic",
            )
        )
        await asyncio.sleep(0.1)
        assert not concurrent_browser_task.done()
        allow_finalizer.set()
        recovered, concurrent_browser = await asyncio.gather(webhook_task, concurrent_browser_task)
        webhook_retry = await _stripe_webhook(
            client, "payment_intent.succeeded", "pi_instant_recovery"
        )
        browser_retry = await _confirm(
            client,
            hotel,
            draft["draftId"],
            "pi_instant_recovery",
            "succeeded",
            "automatic",
        )
        await asyncio.sleep(0)

    assert concurrent_browser.status_code == 200
    assert recovered.status_code == 200
    assert webhook_retry.status_code == 200
    assert browser_retry.status_code == 200
    booking = await Database.fetchrow(
        "SELECT status, payment_status FROM bookings WHERE id = $1", pending["id"]
    )
    assert booking["status"] == "confirmed"
    assert booking["payment_status"] == "captured"
    effects.guest_confirmed.assert_awaited_once()
    effects.host_notified.assert_awaited_once()
    effects.push_ari.assert_awaited_once()
    assert (
        await Database.fetchval("SELECT COUNT(*) FROM payouts WHERE booking_id = $1", pending["id"])
        == 0
    )


async def test_confirmed_effect_failure_retries_only_missing_effects(client, cleanup_database):
    _user, hotel, _room, draft = await _create_card_draft(
        client,
        instant_book=True,
        pi_id="pi_instant_effect_recovery",
    )

    with _lifecycle_spies() as effects:
        effects.host_recipients.return_value = [
            "host@example.com",
            "ops-one@example.com",
            "ops-two@example.com",
        ]
        effects.host_notified.side_effect = [
            None,
            None,
            RuntimeError("mail unavailable"),
        ]
        failed = await _confirm(
            client,
            hotel,
            draft["draftId"],
            "pi_instant_effect_recovery",
            "succeeded",
            "automatic",
        )
        assert failed.status_code == 200
        assert failed.json()["status"] == "confirmed"

        interrupted = await Database.fetchrow(
            """
            SELECT id, status, finalization_token, finalization_completed_at,
                   guest_confirmation_sent_at, host_confirmation_sent_at,
                   ari_handoff_completed_at
            FROM bookings WHERE booking_reference = $1
            """,
            draft["bookingReference"],
        )
        assert interrupted["status"] == "confirmed"
        assert interrupted["finalization_token"] is None
        assert interrupted["finalization_completed_at"] is None
        assert interrupted["guest_confirmation_sent_at"] is not None
        assert interrupted["host_confirmation_sent_at"] is None
        assert interrupted["ari_handoff_completed_at"] is None

        effects.host_notified.side_effect = None
        recovered = await _stripe_webhook(
            client, "payment_intent.succeeded", "pi_instant_effect_recovery"
        )
        browser_retry = await _confirm(
            client,
            hotel,
            draft["draftId"],
            "pi_instant_effect_recovery",
            "succeeded",
            "automatic",
        )

    assert recovered.status_code == 200
    assert browser_retry.status_code == 200
    effects.guest_confirmed.assert_awaited_once()
    assert [call.args[0] for call in effects.host_notified.await_args_list] == [
        "host@example.com",
        "ops-one@example.com",
        "ops-two@example.com",
        "ops-two@example.com",
    ]
    effects.push_ari.assert_awaited_once()
    assert (
        await Database.fetchval(
            "SELECT COUNT(*) FROM booking_notification_deliveries WHERE booking_id = $1",
            interrupted["id"],
        )
        == 4
    )
    completed = await Database.fetchrow(
        """
        SELECT finalization_completed_at, guest_confirmation_sent_at,
               host_confirmation_sent_at, ari_handoff_completed_at
        FROM bookings WHERE id = $1
        """,
        interrupted["id"],
    )
    assert all(completed.values())


@pytest.mark.parametrize("action", ["reject", "withdraw", "expire"])
async def test_captured_request_deposit_is_refunded_when_closed(client, cleanup_database, action):
    billing = {
        **DEFAULT_BILLING_CONFIG,
        "active_plan": "commission",
        "booking_engine_fee_pct": 5.0,
    }
    user, hotel, _room, draft = await _create_card_draft(
        client,
        instant_book=False,
        deposit_required=True,
        pi_id=f"pi_request_deposit_{action}",
        billing_config=billing,
        expected_application_fee_cents=2250,
        expected_platform_fee_amount=22.5,
    )
    confirmed = await _confirm(
        client,
        hotel,
        draft["draftId"],
        f"pi_request_deposit_{action}",
        "succeeded",
        "automatic",
    )
    booking_id = confirmed.json()["id"]

    with (
        _lifecycle_spies() as effects,
        patch(
            "app.services.stripe_service.create_refund",
            new_callable=AsyncMock,
            return_value={"id": f"re_{action}", "status": "succeeded"},
        ) as create_refund,
        patch(
            "app.services.stripe_service.cancel_payment_intent",
            new_callable=AsyncMock,
        ) as cancel_intent,
    ):
        if action == "reject":
            response = await client.post(
                f"/admin/bookings/{booking_id}/reject",
                headers=get_auth_headers(user["token"]),
                json={},
            )
        elif action == "withdraw":
            response = await client.post(
                f"/api/hotels/{hotel['slug']}/bookings/{booking_id}/withdraw",
                json={"guest_email": "instant@example.com"},
            )
        else:
            await expire_booking(booking_id)
            response = SimpleNamespace(status_code=200, text="")
        webhook = await _stripe_webhook(
            client, "payment_intent.succeeded", f"pi_request_deposit_{action}"
        )
        await asyncio.sleep(0)

    assert response.status_code == 200, response.text
    assert webhook.status_code == 200
    payment = await Database.fetchrow(
        "SELECT id, status, refunded_at, refund_amount, amount, currency FROM payments "
        "WHERE booking_id = $1",
        booking_id,
    )
    command_id = f"booking-request-refund-{booking_id}"
    create_refund.assert_awaited_once_with(
        f"pi_request_deposit_{action}",
        amount=None,
        idempotency_key=command_id,
        metadata={
            "booking_id": booking_id,
            "payment_id": str(payment["id"]),
            "refund_command_id": command_id,
            "refund_amount_minor": str(int(float(payment["amount"]) * 100)),
            "refund_currency": payment["currency"].lower(),
        },
        stripe_account=f"acct_pi_request_deposit_{action}",
        refund_application_fee=True,
    )
    cancel_intent.assert_not_awaited()

    booking = await Database.fetchrow(
        "SELECT status, payment_status FROM bookings WHERE id = $1", booking_id
    )
    expected_status = {
        "reject": "declined",
        "withdraw": "cancelled",
        "expire": "expired",
    }[action]
    assert booking["status"] == expected_status
    assert booking["payment_status"] == "refunded"
    assert payment["status"] == "refunded"
    assert payment["refunded_at"] is not None
    assert payment["refund_amount"] == payment["amount"]
    effects.cancel_channex.assert_awaited_once_with(booking_id)
    effects.push_ari.assert_awaited_once_with(booking_id)


async def test_instant_bank_transfer_remains_manual_and_pending(client, cleanup_database):
    user = await create_test_user()
    hotel = await create_test_hotel(str(user["id"]))
    room = await create_test_room_type(str(hotel["id"]))
    await Database.execute("UPDATE hotels SET instant_book = true WHERE id = $1", hotel["id"])
    await create_test_payment_settings(str(hotel["id"]))
    bank_details = {
        "payout_account_holder": "Test Hotel GmbH",
        "payout_account_type": "iban",
        "payout_iban": "DE89370400440532013000",
        "payout_bank_name": "Test Bank",
        "payout_swift": "TESTDEF0",
    }

    with (
        patch(
            "app.services.booking_service.hotel_identity_service.get_payment_flags_by_slug",
            new_callable=AsyncMock,
            return_value={"bank_transfer": True, "pay_at_property_enabled": True},
        ),
        patch(
            "app.services.booking_service.hotel_identity_service.get_guest_payment_info_by_slug",
            new_callable=AsyncMock,
            return_value=bank_details,
        ),
    ):
        response = await client.post(
            f"/api/hotels/{hotel['slug']}/bookings",
            json={
                "roomTypeId": str(room["id"]),
                "guestFirstName": "Manual",
                "guestLastName": "Guest",
                "guestEmail": "manual@example.com",
                "guestPhone": "+1234567890",
                "checkIn": "2026-10-10",
                "checkOut": "2026-10-13",
                "adults": 2,
                "paymentMethod": "bank_transfer",
            },
        )

    assert response.status_code == 200, response.text
    booking = response.json()["booking"]
    assert booking["status"] == "pending"
    assert booking["paymentStatus"] == "awaiting_transfer"
    assert booking["hostResponseDeadline"] is not None
