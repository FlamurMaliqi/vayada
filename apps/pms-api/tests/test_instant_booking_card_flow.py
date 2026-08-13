"""VAY-1266 regression coverage for frozen card-booking acceptance."""

import asyncio
import json
from contextlib import ExitStack, contextmanager
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

import pytest
from app.database import Database
from app.services.booking_service import expire_booking
from app.services.payout_service import DEFAULT_BILLING_CONFIG

from tests.conftest import (
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
    if deposit_required:
        await Database.execute(
            "UPDATE room_types SET rate_deposit_settings = $1::jsonb WHERE id = $2",
            json.dumps({"flexible": {"enabled": True, "percentage": 50}}),
            room["id"],
        )

    with patch(
        "app.services.stripe_service.create_payment_intent",
        new_callable=AsyncMock,
        return_value={
            "id": pi_id,
            "client_secret": f"{pi_id}_secret",
            "status": "requires_payment_method",
        },
    ) as create_intent:
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
    assert create_intent.call_args.kwargs["capture_method"] == expected_capture_method
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
    retrieve_intent.assert_awaited_once_with(pi_id)
    return response


async def _stripe_webhook(client, event_type: str, pi_id: str):
    with patch("app.services.stripe_service.construct_webhook_event") as construct_event:
        construct_event.return_value = {
            "type": event_type,
            "data": {"object": {"id": pi_id}},
        }
        return await client.post(
            "/webhooks/stripe",
            content=b"{}",
            headers={"stripe-signature": "test"},
        )


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
        == 1
    )


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


async def test_instant_finalize_failure_recovers_on_webhook(client, cleanup_database):
    _user, hotel, _room, draft = await _create_card_draft(
        client,
        instant_book=True,
        pi_id="pi_instant_recovery",
    )

    with patch(
        "app.services.booking_service.fetch_billing_config",
        new_callable=AsyncMock,
        side_effect=RuntimeError("billing unavailable"),
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

    async def slow_billing_config(_hotel_id):
        finalizer_entered.set()
        await allow_finalizer.wait()
        return dict(DEFAULT_BILLING_CONFIG)

    with (
        _lifecycle_spies() as effects,
        patch(
            "app.services.booking_service.fetch_billing_config",
            new_callable=AsyncMock,
            side_effect=slow_billing_config,
        ),
    ):
        webhook_task = asyncio.create_task(
            _stripe_webhook(client, "payment_intent.succeeded", "pi_instant_recovery")
        )
        await asyncio.wait_for(finalizer_entered.wait(), timeout=2)

        concurrent_browser = await _confirm(
            client,
            hotel,
            draft["draftId"],
            "pi_instant_recovery",
            "succeeded",
            "automatic",
        )
        allow_finalizer.set()
        recovered = await webhook_task
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

    assert concurrent_browser.status_code == 500
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
        == 1
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
        assert failed.status_code == 500

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
    user, hotel, _room, draft = await _create_card_draft(
        client,
        instant_book=False,
        deposit_required=True,
        pi_id=f"pi_request_deposit_{action}",
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
    create_refund.assert_awaited_once_with(
        f"pi_request_deposit_{action}",
        idempotency_key=f"booking-request-refund-{booking_id}",
    )
    cancel_intent.assert_not_awaited()

    booking = await Database.fetchrow(
        "SELECT status, payment_status FROM bookings WHERE id = $1", booking_id
    )
    payment = await Database.fetchrow(
        "SELECT status, refunded_at, refund_amount, amount FROM payments WHERE booking_id = $1",
        booking_id,
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
