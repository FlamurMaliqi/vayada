import logging
from datetime import UTC, datetime
from decimal import ROUND_HALF_UP, Decimal

from app.config import settings
from app.database import AuthDatabase, Database
from app.repositories.hotel_payment_settings_repo import HotelPaymentSettingsRepository
from app.services import hotel_identity_service, stripe_service

logger = logging.getLogger(__name__)

ACTIVE_SUBSCRIPTION_STATUSES = {"active", "past_due", "trialing"}
TERMINAL_SUBSCRIPTION_STATUSES = {"canceled", "incomplete_expired", "unpaid"}


def _amount_cents(config: dict, room_count: int) -> int:
    extras = max(0, room_count - int(config["fixed_rooms_included"]))
    amount = Decimal(str(config["fixed_base_fee"])) + extras * Decimal(
        str(config["fixed_per_extra_room_fee"])
    )
    return int((amount * 100).quantize(Decimal("1"), rounding=ROUND_HALF_UP))


def _period_end(timestamp: int | None) -> datetime | None:
    return datetime.fromtimestamp(timestamp, tz=UTC) if timestamp else None


async def fixed_plan_quote(hotel_id: str) -> dict:
    config = await hotel_identity_service.get_fixed_plan_config(hotel_id)
    if not config:
        raise RuntimeError("Fixed-plan configuration is unavailable")
    room_count = int(
        await Database.fetchval(
            """
            SELECT COUNT(*)
              FROM rooms r
              JOIN room_types rt ON rt.id = r.room_type_id
             WHERE r.hotel_id = $1
               AND rt.is_active = TRUE
            """,
            hotel_id,
        )
        or 0
    )
    return {
        "amount_cents": _amount_cents(config, room_count),
        "currency": "EUR",
        "room_count": room_count,
        "config": config,
    }


async def billing_status(hotel_id: str) -> dict:
    payment_settings = await HotelPaymentSettingsRepository.get_by_hotel_id(hotel_id)
    if payment_settings and payment_settings.get("stripe_billing_status") == "active":
        await sync_subscription_price(payment_settings)
        payment_settings = await HotelPaymentSettingsRepository.get_by_hotel_id(hotel_id)
    quote = await fixed_plan_quote(hotel_id)
    config = quote["config"]
    return {
        "plan": config["billing_active_plan"],
        "status": (payment_settings or {}).get("stripe_billing_status"),
        "amount": quote["amount_cents"] / 100,
        "currency": quote["currency"],
        "roomCount": quote["room_count"],
        "currentPeriodEnd": (
            payment_settings["stripe_billing_current_period_end"].isoformat()
            if payment_settings and payment_settings.get("stripe_billing_current_period_end")
            else None
        ),
        "cancelAtPeriodEnd": bool(
            (payment_settings or {}).get("stripe_billing_cancel_at_period_end")
        ),
        "canManageBilling": bool((payment_settings or {}).get("stripe_billing_customer_id")),
    }


async def create_checkout(hotel_id: str, user_id: str) -> str:
    payment_settings = await HotelPaymentSettingsRepository.get_by_hotel_id(hotel_id)
    if (
        payment_settings
        and payment_settings.get("stripe_billing_status") in ACTIVE_SUBSCRIPTION_STATUSES
    ):
        raise ValueError("This property already has a Fixed-plan subscription")

    pending_session_id = (payment_settings or {}).get("stripe_billing_checkout_session_id")
    if (
        pending_session_id
        and (payment_settings or {}).get("stripe_billing_status") == "checkout_pending"
    ):
        try:
            pending = await stripe_service.retrieve_checkout_session(pending_session_id)
            if pending["status"] == "open" and pending.get("url"):
                return pending["url"]
            if pending["status"] != "expired":
                raise ValueError("Your Fixed-plan payment is being processed")
        except Exception as exc:
            if isinstance(exc, ValueError):
                raise
            raise RuntimeError("Could not verify the pending Stripe Checkout") from exc

    customer_id = (payment_settings or {}).get("stripe_billing_customer_id")
    if not customer_id:
        email = await AuthDatabase.fetchval("SELECT email FROM users WHERE id = $1", user_id)
        if not email:
            raise RuntimeError("Billing email is unavailable")
        customer_id = await stripe_service.create_billing_customer(str(email), hotel_id)

    quote = await fixed_plan_quote(hotel_id)
    settings_url = f"{settings.BOOKING_ADMIN_URL.rstrip('/')}/settings"
    checkout = await stripe_service.create_fixed_plan_checkout(
        customer_id=customer_id,
        hotel_id=hotel_id,
        amount_cents=quote["amount_cents"],
        success_url=f"{settings_url}?section=billing&checkout=success",
        cancel_url=f"{settings_url}?section=billing&checkout=cancelled",
        idempotency_key=(f"vayada-fixed-checkout:{hotel_id}:{pending_session_id or 'initial'}"),
    )
    await HotelPaymentSettingsRepository.upsert(
        hotel_id,
        {
            "stripe_billing_customer_id": customer_id,
            "stripe_billing_checkout_session_id": checkout["id"],
            "stripe_billing_status": "checkout_pending",
            "stripe_billing_room_count": quote["room_count"],
            "stripe_billing_amount_cents": quote["amount_cents"],
        },
    )
    return checkout["url"]


async def _backfill_pre_switch_bookings(hotel_id: str, config: dict) -> None:
    await Database.execute(
        """
        UPDATE bookings
           SET billing_plan_at_creation = 'commission',
               booking_engine_fee_pct_at_creation = $2,
               channel_manager_fee_pct_at_creation = $3,
               affiliate_platform_fee_pct_at_creation = $4
         WHERE hotel_id = $1
           AND billing_plan_at_creation IS NULL
        """,
        hotel_id,
        config["booking_engine_fee_pct"],
        config["channel_manager_fee_pct"],
        config["affiliate_platform_fee_pct"],
    )


async def activate_subscription(hotel_id: str, subscription_id: str) -> None:
    subscription = await stripe_service.retrieve_billing_subscription(subscription_id)
    metadata = subscription.get("metadata") or {}
    if (
        metadata.get("vayada_payment_kind") != "fixed_plan"
        or str(metadata.get("hotel_id")) != hotel_id
    ):
        raise ValueError("Stripe subscription does not belong to this property")

    payment_settings = await HotelPaymentSettingsRepository.get_by_hotel_id(hotel_id)
    current_subscription_id = (payment_settings or {}).get("stripe_billing_subscription_id")
    if subscription["status"] not in ACTIVE_SUBSCRIPTION_STATUSES:
        if current_subscription_id and current_subscription_id != subscription_id:
            return
        await HotelPaymentSettingsRepository.upsert(
            hotel_id,
            {
                "stripe_billing_customer_id": subscription["customer_id"],
                "stripe_billing_subscription_id": subscription["id"],
                "stripe_billing_subscription_item_id": subscription["item_id"],
                "stripe_billing_product_id": subscription["product_id"],
                "stripe_billing_status": subscription["status"],
                "stripe_billing_current_period_end": _period_end(
                    subscription["current_period_end"]
                ),
                "stripe_billing_cancel_at_period_end": subscription["cancel_at_period_end"],
            },
        )
        if subscription["status"] in TERMINAL_SUBSCRIPTION_STATUSES:
            await hotel_identity_service.set_billing_plan(hotel_id, "commission")
        return

    if (
        current_subscription_id
        and current_subscription_id != subscription_id
        and (payment_settings or {}).get("stripe_billing_status") in ACTIVE_SUBSCRIPTION_STATUSES
    ):
        raise ValueError("A different Fixed-plan subscription is already active")

    quote = await fixed_plan_quote(hotel_id)
    is_initial_activation = quote["config"]["billing_active_plan"] != "fixed"
    if is_initial_activation:
        await _backfill_pre_switch_bookings(hotel_id, quote["config"])
    await hotel_identity_service.set_billing_plan(hotel_id, "fixed")
    subscription_state = {
        "stripe_billing_customer_id": subscription["customer_id"],
        "stripe_billing_subscription_id": subscription["id"],
        "stripe_billing_subscription_item_id": subscription["item_id"],
        "stripe_billing_product_id": subscription["product_id"],
        "stripe_billing_status": subscription["status"],
        "stripe_billing_current_period_end": _period_end(subscription["current_period_end"]),
        "stripe_billing_cancel_at_period_end": subscription["cancel_at_period_end"],
    }
    if is_initial_activation or not (payment_settings or {}).get("stripe_billing_subscription_id"):
        subscription_state.update(
            {
                "stripe_billing_room_count": quote["room_count"],
                "stripe_billing_amount_cents": subscription["unit_amount"] or quote["amount_cents"],
            }
        )
    checkout_amount_cents = subscription["unit_amount"] or quote["amount_cents"]
    initial_quote_changed = is_initial_activation and checkout_amount_cents != quote["amount_cents"]
    updated_settings = await HotelPaymentSettingsRepository.upsert(
        hotel_id,
        subscription_state,
    )
    if (
        not is_initial_activation
        or initial_quote_changed
        or updated_settings.get("stripe_billing_price_dirty")
    ):
        await sync_subscription_price(updated_settings)


async def update_subscription_state(subscription_id: str) -> dict | None:
    payment_settings = await HotelPaymentSettingsRepository.get_by_billing_subscription_id(
        subscription_id
    )
    if not payment_settings:
        return None
    subscription = await stripe_service.retrieve_billing_subscription(subscription_id)
    hotel_id = str(payment_settings["hotel_id"])
    if subscription["status"] in TERMINAL_SUBSCRIPTION_STATUSES:
        await hotel_identity_service.set_billing_plan(hotel_id, "commission")
    await HotelPaymentSettingsRepository.upsert(
        hotel_id,
        {
            "stripe_billing_status": subscription["status"],
            "stripe_billing_current_period_end": _period_end(subscription["current_period_end"]),
            "stripe_billing_cancel_at_period_end": subscription["cancel_at_period_end"],
        },
    )
    return payment_settings


async def mark_payment_failed(subscription_id: str) -> dict | None:
    payment_settings = await HotelPaymentSettingsRepository.get_by_billing_subscription_id(
        subscription_id
    )
    if not payment_settings:
        return None
    await HotelPaymentSettingsRepository.upsert(
        str(payment_settings["hotel_id"]),
        {"stripe_billing_status": "past_due"},
    )
    return payment_settings


async def end_subscription(subscription_id: str, fallback_hotel_id: str | None = None) -> None:
    payment_settings = await HotelPaymentSettingsRepository.get_by_billing_subscription_id(
        subscription_id
    )
    if payment_settings and payment_settings.get("stripe_billing_status") == "checkout_pending":
        return
    if not payment_settings and fallback_hotel_id:
        current_settings = await HotelPaymentSettingsRepository.get_by_hotel_id(fallback_hotel_id)
        current_subscription_id = (current_settings or {}).get("stripe_billing_subscription_id")
        if (current_settings or {}).get("stripe_billing_status") == "checkout_pending" or (
            current_subscription_id and current_subscription_id != subscription_id
        ):
            return
    if (
        payment_settings
        and fallback_hotel_id
        and str(payment_settings["hotel_id"]) != fallback_hotel_id
    ):
        raise ValueError("Stripe subscription is linked to a different property")
    hotel_id = str(payment_settings["hotel_id"]) if payment_settings else fallback_hotel_id
    if not hotel_id:
        return
    await hotel_identity_service.set_billing_plan(hotel_id, "commission")
    await HotelPaymentSettingsRepository.upsert(
        hotel_id,
        {
            "stripe_billing_subscription_id": subscription_id,
            "stripe_billing_status": "canceled",
            "stripe_billing_cancel_at_period_end": False,
        },
    )


async def create_portal(hotel_id: str) -> str:
    payment_settings = await HotelPaymentSettingsRepository.get_by_hotel_id(hotel_id)
    customer_id = (payment_settings or {}).get("stripe_billing_customer_id")
    if not customer_id:
        raise ValueError("No Stripe billing customer found")
    return await stripe_service.create_billing_portal_session(
        customer_id,
        f"{settings.BOOKING_ADMIN_URL.rstrip('/')}/settings?section=billing",
    )


async def cancel_at_period_end(hotel_id: str) -> datetime | None:
    payment_settings = await HotelPaymentSettingsRepository.get_by_hotel_id(hotel_id)
    subscription_id = (payment_settings or {}).get("stripe_billing_subscription_id")
    if not subscription_id:
        raise ValueError("No Fixed-plan subscription found")
    result = await stripe_service.cancel_billing_subscription_at_period_end(subscription_id)
    period_end = _period_end(result["current_period_end"])
    await HotelPaymentSettingsRepository.upsert(
        hotel_id,
        {
            "stripe_billing_cancel_at_period_end": True,
            "stripe_billing_current_period_end": period_end,
        },
    )
    return period_end


async def sync_subscription_price(payment_settings: dict) -> None:
    hotel_id = str(payment_settings["hotel_id"])
    pool = await Database.get_pool()
    async with pool.acquire() as connection:
        locked = await connection.fetchval(
            "SELECT pg_try_advisory_lock(hashtextextended($1, 1084))",
            hotel_id,
        )
        if not locked:
            return
        try:
            latest_settings = await HotelPaymentSettingsRepository.get_by_hotel_id(hotel_id)
            if (
                not latest_settings
                or latest_settings.get("stripe_billing_status") not in ACTIVE_SUBSCRIPTION_STATUSES
            ):
                return
            await _sync_subscription_price_locked(latest_settings)
        finally:
            await connection.execute(
                "SELECT pg_advisory_unlock(hashtextextended($1, 1084))",
                hotel_id,
            )


async def _sync_subscription_price_locked(payment_settings: dict) -> None:
    hotel_id = str(payment_settings["hotel_id"])
    price_version = int(payment_settings.get("stripe_billing_price_version") or 0)
    if payment_settings.get("stripe_billing_cancel_at_period_end"):
        await HotelPaymentSettingsRepository.complete_billing_price_sync(hotel_id, price_version)
        return
    quote = await fixed_plan_quote(hotel_id)
    if (
        payment_settings.get("stripe_billing_room_count") == quote["room_count"]
        and payment_settings.get("stripe_billing_amount_cents") == quote["amount_cents"]
    ):
        await HotelPaymentSettingsRepository.complete_billing_price_sync(hotel_id, price_version)
        return

    item_id = payment_settings.get("stripe_billing_subscription_item_id")
    product_id = payment_settings.get("stripe_billing_product_id")
    if not item_id or not product_id:
        subscription = await stripe_service.retrieve_billing_subscription(
            payment_settings["stripe_billing_subscription_id"]
        )
        item_id = subscription["item_id"]
        product_id = subscription["product_id"]
    await stripe_service.update_fixed_plan_price(
        hotel_id=hotel_id,
        subscription_item_id=item_id,
        product_id=product_id,
        amount_cents=quote["amount_cents"],
        room_count=quote["room_count"],
    )
    await HotelPaymentSettingsRepository.upsert(
        hotel_id,
        {
            "stripe_billing_subscription_item_id": item_id,
            "stripe_billing_product_id": product_id,
            "stripe_billing_room_count": quote["room_count"],
            "stripe_billing_amount_cents": quote["amount_cents"],
        },
    )
    await HotelPaymentSettingsRepository.complete_billing_price_sync(hotel_id, price_version)


async def sync_all_subscription_prices() -> None:
    for payment_settings in await HotelPaymentSettingsRepository.list_fixed_plan_subscriptions():
        try:
            await sync_subscription_price(payment_settings)
        except Exception as exc:
            logger.error(
                "Failed to sync Fixed-plan price for hotel %s: %s",
                payment_settings["hotel_id"],
                exc,
            )


async def sync_subscription_price_for_hotel(hotel_id: str) -> None:
    """Best-effort update after room inventory changes; the billing worker retries failures."""
    try:
        await sync_subscription_price({"hotel_id": hotel_id})
    except Exception:
        logger.exception("Failed to sync Fixed-plan price for hotel %s", hotel_id)
