"""Reads + writes against the booking-engine DB, which owns hotel-identity
fields (currency, slug, payment-method flags, terms text). PMS reads from
here rather than its own ``hotels`` table for those fields — see
memory/project_hotel_data_ownership.md.

All cross-DB SQL funnels through this module so the boundary stays
auditable. Reads swallow failures and return ``None`` / defaults so guest
endpoints can degrade gracefully; writes propagate exceptions so admin
endpoints can return 502.
"""

import logging

from app.config import settings as app_settings
from app.database import BookingEngineDatabase

logger = logging.getLogger(__name__)

DEFAULT_CURRENCY = "EUR"

_PAYMENT_FLAG_COLUMNS = {
    "pay_at_property_enabled",
    "online_card_payment",
    "bank_transfer",
    "paypal_enabled",
}


def _is_configured() -> bool:
    return bool(app_settings.BOOKING_ENGINE_DATABASE_URL)


# ── Reads (lenient — log + None on failure) ──────────────────────────


async def get_name(hotel_id: str) -> str | None:
    """Return the hotel's authoritative display name from booking_db, or
    ``None`` if booking_db is unconfigured / unreachable / the row is
    missing. Callers should fall back to whatever local copy they have
    so guest-facing flows still render on a BE-DB outage.

    Hotel renames happen in booking_db (the identity layer); pms.hotels
    keeps a stale copy that's only refreshed by the backfill script —
    so emails / receipts must read through here, not the JOIN.
    """
    if not _is_configured():
        return None
    try:
        name = await BookingEngineDatabase.fetchval(
            "SELECT name FROM booking_hotels WHERE id = $1",
            hotel_id,
        )
    except Exception as e:
        logger.warning("booking_db name lookup failed for hotel %s: %s", hotel_id, e)
        return None
    return name or None


async def get_currency(hotel_id: str) -> str:
    """Return the hotel's authoritative currency, or ``DEFAULT_CURRENCY``
    if booking_db is unconfigured / unreachable / the row is missing.

    The fallback is a hedge against an outage, not the expected path —
    hotel ids are unified across PMS and booking_db, so the row should
    exist whenever the connection works.
    """
    if not _is_configured():
        return DEFAULT_CURRENCY
    try:
        currency = await BookingEngineDatabase.fetchval(
            "SELECT currency FROM booking_hotels WHERE id = $1",
            hotel_id,
        )
        return currency or DEFAULT_CURRENCY
    except Exception as e:
        logger.warning(
            "booking_db currency lookup failed for hotel %s: %s; using %s",
            hotel_id,
            e,
            DEFAULT_CURRENCY,
        )
        return DEFAULT_CURRENCY


async def get_fixed_plan_config(hotel_id: str) -> dict | None:
    """Return the legacy Fixed-plan price configuration."""
    if not _is_configured():
        return None
    row = await BookingEngineDatabase.fetchrow(
        """
        SELECT billing_active_plan,
               fixed_base_fee,
               fixed_rooms_included,
               fixed_per_extra_room_fee,
               booking_engine_fee_pct,
               channel_manager_fee_pct,
               affiliate_platform_fee_pct
          FROM booking_hotels
         WHERE id = $1
        """,
        hotel_id,
    )
    return dict(row) if row else None


async def get_payment_flags_by_slug(slug: str) -> dict | None:
    """Read payment-method flags from the Booking Engine DB
    for a hotel by slug. Returns ``None`` if BE-DB is unconfigured, the
    row is missing, or the query fails (failure is logged)."""
    if not _is_configured():
        return None
    try:
        row = await BookingEngineDatabase.fetchrow(
            "SELECT pay_at_property_enabled, online_card_payment, bank_transfer "
            ", paypal_enabled "
            "FROM booking_hotels WHERE slug = $1",
            slug,
        )
    except Exception as e:
        logger.warning("booking_db payment-flag lookup failed for slug %s: %s", slug, e)
        return None
    return dict(row) if row else None


async def get_guest_payment_info_by_slug(slug: str) -> dict | None:
    """Read pay-at-hotel methods, bank details, terms + cancellation
    policy text for a hotel by slug. Returns ``None`` on any failure."""
    if not _is_configured():
        return None
    try:
        row = await BookingEngineDatabase.fetchrow(
            "SELECT pay_at_hotel_methods, payout_account_holder, payout_iban, "
            "payout_account_type, payout_account_number, payout_bank_name, "
            "payout_swift, terms_text, cancellation_policy_text, "
            "paypal_email, paypal_payment_window_hours "
            "FROM booking_hotels WHERE slug = $1",
            slug,
        )
    except Exception as e:
        logger.warning("booking_db pay-at-hotel lookup failed for slug %s: %s", slug, e)
        return None
    return dict(row) if row else None


async def list_addons(hotel_id: str) -> list[dict]:
    """List a hotel's addons (id, price, currency). Empty list if BE-DB
    is unconfigured. DB errors propagate."""
    if not _is_configured():
        return []
    rows = await BookingEngineDatabase.fetch(
        "SELECT id, price, currency FROM booking_addons WHERE hotel_id = $1",
        hotel_id,
    )
    return [dict(r) for r in rows]


# ── Writes (strict — propagate errors so caller can 502) ─────────────


async def set_currency(hotel_id: str, currency: str) -> None:
    """Write the authoritative currency. No-op if BE-DB is unconfigured."""
    if not _is_configured():
        return
    await BookingEngineDatabase.execute(
        "UPDATE booking_hotels SET currency = $2 WHERE id = $1",
        hotel_id,
        currency,
    )


async def update_addon_price(addon_id: str, price: float, currency: str) -> None:
    """Update a single addon's price + currency."""
    if not _is_configured():
        return
    await BookingEngineDatabase.execute(
        "UPDATE booking_addons SET price = $1, currency = $2 WHERE id = $3",
        price,
        currency,
        addon_id,
    )


async def set_payment_flags(hotel_id: str, fields: dict) -> None:
    """Write the allow-listed payment-method flags
    (pay_at_property_enabled / online_card_payment / bank_transfer).
    No-op if no allowed fields remain or BE-DB unconfigured."""
    filtered = {k: v for k, v in fields.items() if k in _PAYMENT_FLAG_COLUMNS}
    if not filtered or not _is_configured():
        return
    sets = ", ".join(f"{k} = ${i + 2}" for i, k in enumerate(filtered))
    vals = list(filtered.values())
    await BookingEngineDatabase.execute(
        f"UPDATE booking_hotels SET {sets} WHERE id = $1",
        hotel_id,
        *vals,
    )


async def set_billing_plan(hotel_id: str, plan: str) -> None:
    """Set the paid plan and clear the retired calendar-month switch."""
    if not _is_configured():
        raise RuntimeError("Booking engine database is not configured")
    await BookingEngineDatabase.execute(
        """
        UPDATE booking_hotels
           SET billing_active_plan = $2,
               billing_pending_switch = NULL,
               billing_switch_effective_date = NULL
         WHERE id = $1
        """,
        hotel_id,
        plan,
    )


async def set_instant_book(hotel_id: str, instant_book: bool) -> None:
    """Write the instant_book flag (drives checkout-CTA copy on the
    booking-engine frontend)."""
    if not _is_configured():
        return
    await BookingEngineDatabase.execute(
        "UPDATE booking_hotels SET instant_book = $2 WHERE id = $1",
        hotel_id,
        bool(instant_book),
    )
