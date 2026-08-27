import asyncio
from datetime import UTC, datetime
from unittest.mock import AsyncMock, MagicMock, patch
from uuid import uuid4

import pytest
from app.database import Database
from app.repositories.hotel_payment_settings_repo import HotelPaymentSettingsRepository
from app.repositories.room_repo import RoomRepository
from app.services import fixed_plan_billing, stripe_service
from app.services.payout_service import billing_config_for_booking


def _subscription(**overrides) -> dict:
    return {
        "id": "sub_fixed",
        "customer_id": "cus_fixed",
        "metadata": {"hotel_id": "hotel-1", "vayada_payment_kind": "fixed_plan"},
        "status": "active",
        "cancel_at_period_end": False,
        "current_period_end": 1_800_000_000,
        "item_id": "si_fixed",
        "product_id": "prod_fixed",
        "unit_amount": 3_000,
        **overrides,
    }


def _quote(*, plan: str = "commission", rooms: int = 1, amount: int = 3_000) -> dict:
    return {
        "amount_cents": amount,
        "currency": "EUR",
        "room_count": rooms,
        "config": {
            "billing_active_plan": plan,
            "fixed_base_fee": 30,
            "fixed_rooms_included": 1,
            "fixed_per_extra_room_fee": 5,
            "booking_engine_fee_pct": 10,
            "channel_manager_fee_pct": 4,
            "affiliate_platform_fee_pct": 3,
        },
    }


def test_fixed_plan_price_is_30_eur_plus_5_eur_per_extra_room():
    config = _quote()["config"]

    assert fixed_plan_billing._amount_cents(config, 0) == 3_000
    assert fixed_plan_billing._amount_cents(config, 1) == 3_000
    assert fixed_plan_billing._amount_cents(config, 2) == 3_500
    assert fixed_plan_billing._amount_cents(config, 5) == 5_000


def test_booking_uses_plan_snapshot_instead_of_current_plan():
    current = {
        "active_plan": "fixed",
        "booking_engine_fee_pct": 0,
        "channel_manager_fee_pct": 0,
        "affiliate_platform_fee_pct": 0,
    }
    booking = {
        "billing_plan_at_creation": "commission",
        "booking_engine_fee_pct_at_creation": 10,
        "channel_manager_fee_pct_at_creation": 4,
        "affiliate_platform_fee_pct_at_creation": 3,
    }

    assert billing_config_for_booking(booking, current) == {
        "active_plan": "commission",
        "booking_engine_fee_pct": 10.0,
        "channel_manager_fee_pct": 4.0,
        "affiliate_platform_fee_pct": 3.0,
    }


async def test_first_payment_syncs_when_inventory_changed_before_checkout_was_reserved():
    stored = {
        "hotel_id": "hotel-1",
        "stripe_billing_subscription_id": "sub_fixed",
        "stripe_billing_status": "active",
        "stripe_billing_room_count": 2,
        "stripe_billing_amount_cents": 3_000,
        "stripe_billing_price_dirty": False,
    }
    with (
        patch.object(
            fixed_plan_billing.stripe_service,
            "retrieve_billing_subscription",
            new=AsyncMock(return_value=_subscription()),
        ),
        patch.object(
            fixed_plan_billing,
            "fixed_plan_quote",
            new=AsyncMock(return_value=_quote(rooms=2, amount=3_500)),
        ),
        patch.object(
            fixed_plan_billing.HotelPaymentSettingsRepository,
            "get_by_hotel_id",
            new=AsyncMock(return_value=None),
        ),
        patch.object(
            fixed_plan_billing,
            "_backfill_pre_switch_bookings",
            new=AsyncMock(),
        ) as backfill,
        patch.object(
            fixed_plan_billing.hotel_identity_service,
            "set_billing_plan",
            new=AsyncMock(),
        ) as set_plan,
        patch.object(
            fixed_plan_billing.HotelPaymentSettingsRepository,
            "upsert",
            new=AsyncMock(return_value=stored),
        ) as upsert,
        patch.object(
            fixed_plan_billing,
            "sync_subscription_price",
            new=AsyncMock(),
        ) as sync_price,
    ):
        await fixed_plan_billing.activate_subscription("hotel-1", "sub_fixed")

    backfill.assert_awaited_once_with("hotel-1", _quote(rooms=2, amount=3_500)["config"])
    set_plan.assert_awaited_once_with("hotel-1", "fixed")
    assert upsert.await_args.args[1]["stripe_billing_amount_cents"] == 3_000
    sync_price.assert_awaited_once_with(stored)


async def test_renewal_keeps_old_price_snapshot_then_updates_next_charge():
    existing = {
        "hotel_id": "hotel-1",
        "stripe_billing_subscription_id": "sub_fixed",
        "stripe_billing_status": "active",
        "stripe_billing_room_count": 1,
        "stripe_billing_amount_cents": 3_000,
    }
    updated = {**existing, "stripe_billing_current_period_end": datetime.now(UTC)}
    with (
        patch.object(
            fixed_plan_billing.stripe_service,
            "retrieve_billing_subscription",
            new=AsyncMock(return_value=_subscription()),
        ),
        patch.object(
            fixed_plan_billing,
            "fixed_plan_quote",
            new=AsyncMock(return_value=_quote(plan="fixed", rooms=2, amount=3_500)),
        ),
        patch.object(
            fixed_plan_billing.HotelPaymentSettingsRepository,
            "get_by_hotel_id",
            new=AsyncMock(return_value=existing),
        ),
        patch.object(
            fixed_plan_billing,
            "_backfill_pre_switch_bookings",
            new=AsyncMock(),
        ) as backfill,
        patch.object(
            fixed_plan_billing.hotel_identity_service,
            "set_billing_plan",
            new=AsyncMock(),
        ),
        patch.object(
            fixed_plan_billing.HotelPaymentSettingsRepository,
            "upsert",
            new=AsyncMock(return_value=updated),
        ) as upsert,
        patch.object(
            fixed_plan_billing,
            "sync_subscription_price",
            new=AsyncMock(),
        ) as sync_price,
    ):
        await fixed_plan_billing.activate_subscription("hotel-1", "sub_fixed")

    backfill.assert_not_awaited()
    assert "stripe_billing_room_count" not in upsert.await_args.args[1]
    assert "stripe_billing_amount_cents" not in upsert.await_args.args[1]
    sync_price.assert_awaited_once_with(updated)


async def test_room_change_replaces_price_without_proration():
    price = MagicMock(id="price_next")
    with (
        patch.object(stripe_service.stripe.Price, "create", return_value=price) as create_price,
        patch.object(stripe_service.stripe.SubscriptionItem, "modify") as modify_item,
    ):
        await stripe_service.update_fixed_plan_price(
            hotel_id="hotel-1",
            subscription_item_id="si_fixed",
            product_id="prod_fixed",
            amount_cents=3_500,
            room_count=2,
        )

    assert create_price.call_args.kwargs["recurring"] == {
        "interval": "day",
        "interval_count": 30,
    }
    modify_item.assert_called_once_with(
        "si_fixed",
        price="price_next",
        proration_behavior="none",
    )


async def test_checkout_uses_cards_eur_and_an_exact_30_day_interval():
    session = MagicMock(id="cs_fixed", url="https://checkout.stripe.test/fixed", status="open")
    with patch.object(
        stripe_service.stripe.checkout.Session,
        "create",
        return_value=session,
    ) as create_session:
        result = await stripe_service.create_fixed_plan_checkout(
            customer_id="cus_fixed",
            hotel_id="hotel-1",
            amount_cents=3_500,
            success_url="https://admin.test/settings?checkout=success",
            cancel_url="https://admin.test/settings?checkout=cancelled",
            idempotency_key="fixed-checkout-test",
        )

    args = create_session.call_args.kwargs
    assert result["url"] == "https://checkout.stripe.test/fixed"
    assert args["payment_method_types"] == ["card"]
    assert args["idempotency_key"] == "fixed-checkout-test"
    assert args["line_items"][0]["price_data"] == {
        "currency": "eur",
        "product_data": {"name": "Vayada Fixed Plan"},
        "recurring": {"interval": "day", "interval_count": 30},
        "unit_amount": 3_500,
    }


async def test_concurrent_checkout_attempts_use_the_same_stripe_idempotency_key():
    checkout = {
        "id": "cs_fixed",
        "url": "https://checkout.stripe.test/fixed",
        "status": "open",
    }
    with (
        patch.object(
            fixed_plan_billing.HotelPaymentSettingsRepository,
            "get_by_hotel_id",
            new=AsyncMock(return_value=None),
        ),
        patch.object(
            fixed_plan_billing.AuthDatabase,
            "fetchval",
            new=AsyncMock(return_value="hotel@example.test"),
        ),
        patch.object(
            fixed_plan_billing.stripe_service,
            "create_billing_customer",
            new=AsyncMock(return_value="cus_fixed"),
        ),
        patch.object(
            fixed_plan_billing,
            "fixed_plan_quote",
            new=AsyncMock(return_value=_quote()),
        ),
        patch.object(
            fixed_plan_billing.stripe_service,
            "create_fixed_plan_checkout",
            new=AsyncMock(return_value=checkout),
        ) as create_checkout,
        patch.object(
            fixed_plan_billing.HotelPaymentSettingsRepository,
            "upsert",
            new=AsyncMock(),
        ),
    ):
        urls = await asyncio.gather(
            fixed_plan_billing.create_checkout("hotel-1", "user-1"),
            fixed_plan_billing.create_checkout("hotel-1", "user-1"),
        )

    assert urls == [checkout["url"], checkout["url"]]
    assert {call.kwargs["idempotency_key"] for call in create_checkout.await_args_list} == {
        "vayada-fixed-checkout:hotel-1:initial"
    }


async def test_billing_customer_creation_is_idempotent_per_hotel():
    customer = MagicMock(id="cus_fixed")
    with patch.object(stripe_service.stripe.Customer, "create", return_value=customer) as create:
        await stripe_service.create_billing_customer("hotel@example.test", "hotel-1")

    assert create.call_args.kwargs["idempotency_key"] == "vayada-fixed-customer:hotel-1"


async def test_subscription_end_reverts_hotel_to_commission():
    payment_settings = {
        "hotel_id": "hotel-1",
        "stripe_billing_subscription_id": "sub_fixed",
    }
    with (
        patch.object(
            fixed_plan_billing.HotelPaymentSettingsRepository,
            "get_by_billing_subscription_id",
            new=AsyncMock(return_value=payment_settings),
        ),
        patch.object(
            fixed_plan_billing.hotel_identity_service,
            "set_billing_plan",
            new=AsyncMock(),
        ) as set_plan,
        patch.object(
            fixed_plan_billing.HotelPaymentSettingsRepository,
            "upsert",
            new=AsyncMock(),
        ) as upsert,
    ):
        await fixed_plan_billing.end_subscription("sub_fixed")

    set_plan.assert_awaited_once_with("hotel-1", "commission")
    upsert.assert_awaited_once_with(
        "hotel-1",
        {
            "stripe_billing_subscription_id": "sub_fixed",
            "stripe_billing_status": "canceled",
            "stripe_billing_cancel_at_period_end": False,
        },
    )


async def test_completed_checkout_cannot_create_a_second_subscription():
    payment_settings = {
        "hotel_id": "hotel-1",
        "stripe_billing_status": "checkout_pending",
        "stripe_billing_checkout_session_id": "cs_paid",
    }
    with (
        patch.object(
            fixed_plan_billing.HotelPaymentSettingsRepository,
            "get_by_hotel_id",
            new=AsyncMock(return_value=payment_settings),
        ),
        patch.object(
            fixed_plan_billing.stripe_service,
            "retrieve_checkout_session",
            new=AsyncMock(
                return_value={
                    "id": "cs_paid",
                    "url": "https://checkout.stripe.test/paid",
                    "status": "complete",
                    "payment_status": "paid",
                }
            ),
        ),
        patch.object(
            fixed_plan_billing.stripe_service,
            "create_fixed_plan_checkout",
            new=AsyncMock(),
        ) as create_checkout,
    ):
        with pytest.raises(ValueError, match="being processed"):
            await fixed_plan_billing.create_checkout("hotel-1", "user-1")

    create_checkout.assert_not_awaited()


async def test_stale_paid_event_does_not_reactivate_a_canceled_subscription():
    canceled = _subscription(status="canceled")
    with (
        patch.object(
            fixed_plan_billing.stripe_service,
            "retrieve_billing_subscription",
            new=AsyncMock(return_value=canceled),
        ),
        patch.object(
            fixed_plan_billing.HotelPaymentSettingsRepository,
            "get_by_hotel_id",
            new=AsyncMock(return_value=None),
        ),
        patch.object(
            fixed_plan_billing.HotelPaymentSettingsRepository,
            "upsert",
            new=AsyncMock(),
        ),
        patch.object(
            fixed_plan_billing.hotel_identity_service,
            "set_billing_plan",
            new=AsyncMock(),
        ) as set_plan,
        patch.object(
            fixed_plan_billing,
            "fixed_plan_quote",
            new=AsyncMock(),
        ) as quote,
    ):
        await fixed_plan_billing.activate_subscription("hotel-1", "sub_fixed")

    set_plan.assert_awaited_once_with("hotel-1", "commission")
    quote.assert_not_awaited()


async def test_stale_terminal_event_cannot_replace_a_new_active_subscription():
    current = {
        "hotel_id": "hotel-1",
        "stripe_billing_subscription_id": "sub_new",
        "stripe_billing_status": "active",
    }
    with (
        patch.object(
            fixed_plan_billing.stripe_service,
            "retrieve_billing_subscription",
            new=AsyncMock(return_value=_subscription(id="sub_old", status="canceled")),
        ),
        patch.object(
            fixed_plan_billing.HotelPaymentSettingsRepository,
            "get_by_hotel_id",
            new=AsyncMock(return_value=current),
        ),
        patch.object(
            fixed_plan_billing.HotelPaymentSettingsRepository,
            "upsert",
            new=AsyncMock(),
        ) as upsert,
        patch.object(
            fixed_plan_billing.hotel_identity_service,
            "set_billing_plan",
            new=AsyncMock(),
        ) as set_plan,
    ):
        await fixed_plan_billing.activate_subscription("hotel-1", "sub_old")

    upsert.assert_not_awaited()
    set_plan.assert_not_awaited()


async def test_stale_deletion_cannot_end_a_new_active_subscription():
    current = {
        "hotel_id": "hotel-1",
        "stripe_billing_subscription_id": "sub_new",
        "stripe_billing_status": "active",
    }
    with (
        patch.object(
            fixed_plan_billing.HotelPaymentSettingsRepository,
            "get_by_billing_subscription_id",
            new=AsyncMock(return_value=None),
        ),
        patch.object(
            fixed_plan_billing.HotelPaymentSettingsRepository,
            "get_by_hotel_id",
            new=AsyncMock(return_value=current),
        ),
        patch.object(
            fixed_plan_billing.HotelPaymentSettingsRepository,
            "upsert",
            new=AsyncMock(),
        ) as upsert,
        patch.object(
            fixed_plan_billing.hotel_identity_service,
            "set_billing_plan",
            new=AsyncMock(),
        ) as set_plan,
    ):
        await fixed_plan_billing.end_subscription("sub_old", "hotel-1")

    upsert.assert_not_awaited()
    set_plan.assert_not_awaited()


async def test_terminal_subscription_update_reverts_to_commission():
    payment_settings = {
        "hotel_id": "hotel-1",
        "stripe_billing_subscription_id": "sub_fixed",
        "stripe_billing_status": "active",
    }
    with (
        patch.object(
            fixed_plan_billing.HotelPaymentSettingsRepository,
            "get_by_billing_subscription_id",
            new=AsyncMock(return_value=payment_settings),
        ),
        patch.object(
            fixed_plan_billing.stripe_service,
            "retrieve_billing_subscription",
            new=AsyncMock(return_value=_subscription(status="unpaid")),
        ),
        patch.object(
            fixed_plan_billing.hotel_identity_service,
            "set_billing_plan",
            new=AsyncMock(),
        ) as set_plan,
        patch.object(
            fixed_plan_billing.HotelPaymentSettingsRepository,
            "upsert",
            new=AsyncMock(),
        ) as upsert,
    ):
        await fixed_plan_billing.update_subscription_state("sub_fixed")

    set_plan.assert_awaited_once_with("hotel-1", "commission")
    assert upsert.await_args.args[1]["stripe_billing_status"] == "unpaid"


async def test_subscription_metadata_must_match_the_hotel():
    wrong_hotel = _subscription(
        metadata={"hotel_id": "hotel-2", "vayada_payment_kind": "fixed_plan"}
    )
    with patch.object(
        fixed_plan_billing.stripe_service,
        "retrieve_billing_subscription",
        new=AsyncMock(return_value=wrong_hotel),
    ):
        with pytest.raises(ValueError, match="does not belong"):
            await fixed_plan_billing.activate_subscription("hotel-1", "sub_fixed")


async def test_stale_webhook_claim_is_retryable_after_lease_expires():
    event_id = f"evt_{uuid4().hex}"
    await Database.execute(
        """
        INSERT INTO stripe_billing_webhook_events (
            event_id, event_type, processing_started_at, processed_at
        ) VALUES ($1, 'invoice.paid', NOW() - INTERVAL '6 minutes', NULL)
        """,
        event_id,
    )
    try:
        assert (
            await HotelPaymentSettingsRepository.claim_billing_webhook_event(
                event_id, "invoice.paid"
            )
            == "claimed"
        )
        await HotelPaymentSettingsRepository.complete_billing_webhook_event(event_id)
        assert (
            await HotelPaymentSettingsRepository.claim_billing_webhook_event(
                event_id, "invoice.paid"
            )
            == "completed"
        )
    finally:
        await Database.execute(
            "DELETE FROM stripe_billing_webhook_events WHERE event_id = $1",
            event_id,
        )


async def test_room_inventory_change_marks_fixed_plan_price_dirty(hotel_with_rooms):
    hotel_id = str(hotel_with_rooms["hotel"]["id"])
    room_type_id = str(hotel_with_rooms["room"]["id"])
    await HotelPaymentSettingsRepository.upsert(
        hotel_id,
        {
            "stripe_billing_subscription_id": "sub_dirty_test",
            "stripe_billing_status": "active",
            "stripe_billing_price_dirty": False,
        },
    )

    await RoomRepository.create(
        {
            "hotel_id": hotel_id,
            "room_type_id": room_type_id,
            "room_number": "dirty-trigger-room",
            "floor": "",
            "status": "available",
            "sort_order": 999,
        }
    )

    first_version = await Database.fetchval(
        """
        SELECT stripe_billing_price_version
          FROM hotel_payment_settings
         WHERE hotel_id = $1
        """,
        hotel_id,
    )
    assert first_version == 1

    await RoomRepository.create(
        {
            "hotel_id": hotel_id,
            "room_type_id": room_type_id,
            "room_number": "newer-dirty-trigger-room",
            "floor": "",
            "status": "available",
            "sort_order": 1_000,
        }
    )
    await HotelPaymentSettingsRepository.complete_billing_price_sync(hotel_id, first_version)

    state = await Database.fetchrow(
        """
        SELECT stripe_billing_price_dirty, stripe_billing_price_version
          FROM hotel_payment_settings
         WHERE hotel_id = $1
        """,
        hotel_id,
    )
    assert state["stripe_billing_price_dirty"] is True
    assert state["stripe_billing_price_version"] == 2


async def test_room_change_during_checkout_is_queued_for_post_activation_sync(hotel_with_rooms):
    hotel_id = str(hotel_with_rooms["hotel"]["id"])
    room_type_id = str(hotel_with_rooms["room"]["id"])
    await HotelPaymentSettingsRepository.upsert(
        hotel_id,
        {
            "stripe_billing_checkout_session_id": "cs_pending_dirty",
            "stripe_billing_status": "checkout_pending",
            "stripe_billing_price_dirty": False,
        },
    )

    await RoomRepository.create(
        {
            "hotel_id": hotel_id,
            "room_type_id": room_type_id,
            "room_number": "checkout-dirty-trigger-room",
            "floor": "",
            "status": "available",
            "sort_order": 999,
        }
    )

    state = await Database.fetchrow(
        """
        SELECT stripe_billing_price_dirty, stripe_billing_price_version
          FROM hotel_payment_settings
         WHERE hotel_id = $1
        """,
        hotel_id,
    )
    assert state["stripe_billing_price_dirty"] is True
    assert state["stripe_billing_price_version"] == 1


async def test_room_sync_lookup_failure_does_not_fail_the_room_mutation_path():
    with patch.object(
        fixed_plan_billing.HotelPaymentSettingsRepository,
        "get_by_hotel_id",
        new=AsyncMock(side_effect=RuntimeError("database unavailable")),
    ):
        await fixed_plan_billing.sync_subscription_price_for_hotel("hotel-1")
