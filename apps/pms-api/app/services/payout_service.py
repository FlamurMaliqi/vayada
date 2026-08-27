import logging
from datetime import UTC, datetime, timedelta

from app.config import settings as app_settings
from app.database import BookingEngineDatabase
from app.repositories.cancellation_policy_repo import CancellationPolicyRepository
from app.repositories.payout_repo import PayoutRepository
from app.services import stripe_service, xendit_service

logger = logging.getLogger(__name__)


MAX_PAYOUT_RETRIES = 3


# Safe-by-default fallback: when we can't read the hotel's real billing config we
# bill *nothing* rather than guess a percentage. Guessing previously caused
# Fixed-plan hotels to be charged a per-booking fee on top of their monthly
# subscription, and Commission-plan hotels with non-default rates to be
# under-billed (see VAY-318). Hitting this fallback in production means the
# booking_hotels row is missing or the cross-DB read failed — both are logged as
# errors so the data issue gets fixed instead of silently mis-billing.
DEFAULT_BILLING_CONFIG = {
    "active_plan": "fixed",
    "booking_engine_fee_pct": 0.00,
    "channel_manager_fee_pct": 0.00,
    "affiliate_platform_fee_pct": 0.00,
}

KNOWN_DIRECT_CHANNELS = {"direct"}


async def fetch_billing_config(hotel_id: str) -> dict:
    """Read per-hotel platform-fee config from booking_db.

    Falls back to ``DEFAULT_BILLING_CONFIG`` (zero fees) when booking_db is
    unconfigured (test path), unreachable, or has no row for ``hotel_id``. In
    production any miss here is a data-integrity issue — we log an ``error``
    so it surfaces, rather than silently charging a default percentage.
    """
    if not app_settings.BOOKING_ENGINE_DATABASE_URL:
        return dict(DEFAULT_BILLING_CONFIG)
    try:
        row = await BookingEngineDatabase.fetchrow(
            """
            SELECT billing_active_plan,
                   booking_engine_fee_pct,
                   channel_manager_fee_pct,
                   affiliate_platform_fee_pct
              FROM booking_hotels
             WHERE id = $1
            """,
            hotel_id,
        )
    except Exception as exc:
        logger.error(
            "Failed to fetch billing config from booking_db for hotel %s: %s — "
            "falling back to zero-fee defaults",
            hotel_id,
            exc,
        )
        return dict(DEFAULT_BILLING_CONFIG)
    if not row:
        logger.error(
            "No booking_hotels row found for hotel %s — falling back to zero-fee "
            "defaults. The hotel needs a billing config row before fees can be billed.",
            hotel_id,
        )
        return dict(DEFAULT_BILLING_CONFIG)
    return {
        "active_plan": row["billing_active_plan"],
        "booking_engine_fee_pct": float(row["booking_engine_fee_pct"]),
        "channel_manager_fee_pct": float(row["channel_manager_fee_pct"]),
        "affiliate_platform_fee_pct": float(row["affiliate_platform_fee_pct"]),
    }


def billing_snapshot_fields(config: dict) -> dict:
    return {
        "billing_plan_at_creation": config["active_plan"],
        "booking_engine_fee_pct_at_creation": config["booking_engine_fee_pct"],
        "channel_manager_fee_pct_at_creation": config["channel_manager_fee_pct"],
        "affiliate_platform_fee_pct_at_creation": config["affiliate_platform_fee_pct"],
    }


def billing_config_for_booking(booking: dict, current_config: dict) -> dict:
    plan = booking.get("billing_plan_at_creation")
    if plan not in {"commission", "fixed"}:
        return current_config
    return {
        "active_plan": plan,
        "booking_engine_fee_pct": float(
            booking.get("booking_engine_fee_pct_at_creation")
            if booking.get("booking_engine_fee_pct_at_creation") is not None
            else current_config["booking_engine_fee_pct"]
        ),
        "channel_manager_fee_pct": float(
            booking.get("channel_manager_fee_pct_at_creation")
            if booking.get("channel_manager_fee_pct_at_creation") is not None
            else current_config["channel_manager_fee_pct"]
        ),
        "affiliate_platform_fee_pct": float(
            booking.get("affiliate_platform_fee_pct_at_creation")
            if booking.get("affiliate_platform_fee_pct_at_creation") is not None
            else current_config["affiliate_platform_fee_pct"]
        ),
    }


def calculate_split(
    total_amount: float,
    *,
    plan: str,
    channel: str,
    booking_engine_fee_pct: float,
    channel_manager_fee_pct: float,
    affiliate_platform_fee_pct: float,
    has_affiliate: bool,
    effective_affiliate_commission_pct: float = 0.0,
) -> dict:
    """Split a booking total into platform fee, affiliate commission, and property payout.

    Fee matrix:
      Fixed plan:      0% on non-affiliate bookings (covered by monthly base + per-room).
                       +affiliate_platform_fee_pct on affiliate bookings.
      Commission plan: booking_engine_fee_pct on direct bookings,
                       channel_manager_fee_pct on OTA bookings.
                       Affiliate bookings do NOT add the affiliate platform fee — the
                       channel fee (direct or OTA) already covers the platform cut.
      Affiliate commission is additive — paid by the property on top of the platform fee.

    A missing/empty channel is treated as ``direct`` with a warning logged — the
    direct rate is the lower of the two on every plan we support, so this is the
    safer fallback when the booking source can't be determined.
    """
    if not channel:
        logger.warning("calculate_split called with empty channel — defaulting to 'direct' rate")
        channel = "direct"
    is_channel_booking = channel not in KNOWN_DIRECT_CHANNELS

    platform_fee_pct = 0.0
    if plan == "commission":
        platform_fee_pct += (
            channel_manager_fee_pct if is_channel_booking else booking_engine_fee_pct
        )
    elif has_affiliate:
        platform_fee_pct += affiliate_platform_fee_pct

    platform_fee = round(total_amount * platform_fee_pct / 100, 2)
    affiliate_commission = (
        round(total_amount * effective_affiliate_commission_pct / 100, 2) if has_affiliate else 0.0
    )
    property_payout = round(total_amount - platform_fee - affiliate_commission, 2)

    return {
        "platform_fee": platform_fee,
        "affiliate_commission": affiliate_commission,
        "property_payout": property_payout,
    }


async def schedule_payouts(
    booking_id: str,
    hotel_id: str,
    total_amount: float,
    currency: str,
    affiliate_id: str | None,
    affiliate_commission: float,
    property_payout: float,
    check_out,
    *,
    schedule_hotel: bool = True,
) -> None:
    """Schedule hotel payout (after cancellation window) and affiliate payout (monthly batch)."""
    policy = await CancellationPolicyRepository.get_by_hotel_id(hotel_id)
    free_days = policy["free_cancellation_days"] if policy else 7

    hotel_payout_date = datetime.combine(check_out, datetime.min.time(), tzinfo=UTC) + timedelta(
        days=free_days
    )

    if schedule_hotel:
        await PayoutRepository.create(
            booking_id=booking_id,
            recipient_type="hotel",
            recipient_id=hotel_id,
            amount=property_payout,
            currency=currency,
            scheduled_for=hotel_payout_date,
        )

    if affiliate_id and affiliate_commission > 0:
        checkout_dt = datetime.combine(check_out, datetime.min.time(), tzinfo=UTC)
        if checkout_dt.month == 12:
            batch_date = checkout_dt.replace(year=checkout_dt.year + 1, month=1, day=1)
        else:
            batch_date = checkout_dt.replace(month=checkout_dt.month + 1, day=1)

        await PayoutRepository.create(
            booking_id=booking_id,
            recipient_type="affiliate",
            recipient_id=affiliate_id,
            amount=affiliate_commission,
            currency=currency,
            scheduled_for=batch_date,
        )


# ── Provider dispatchers ─────────────────────────────────────────────


async def dispatch_stripe_transfer(
    payout_id: str,
    amount: float,
    currency: str,
    destination_account: str,
    metadata: dict,
) -> str:
    """Submit a Stripe Connect transfer and mark the payout completed.
    Stripe transfers are synchronous, so we go straight to ``completed``.
    Returns the Stripe transfer id."""
    amount_cents = int(amount * 100)
    result = await stripe_service.create_transfer(
        amount=amount_cents,
        currency=currency,
        destination_account=destination_account,
        metadata=metadata,
    )
    await PayoutRepository.update_status(payout_id, "completed", stripe_transfer_id=result["id"])
    return result["id"]


async def dispatch_xendit_payout(
    payout_id: str,
    amount: float,
    currency: str,
    *,
    reference_id: str,
    channel_code: str,
    account_number: str,
    account_holder_name: str,
    description: str,
) -> str:
    """Submit a Xendit payout. Xendit payouts are async — the row stays in
    ``processing`` and is finalized either by webhook or
    ``poll_xendit_processing_payouts``. Returns the Xendit payout id."""
    result = await xendit_service.create_payout(
        reference_id=reference_id,
        channel_code=channel_code,
        account_number=account_number,
        account_holder_name=account_holder_name,
        amount=int(amount),
        currency=currency,
        description=description,
    )
    await PayoutRepository.update_status(payout_id, "processing", xendit_payout_id=result["id"])
    return result["id"]


async def handle_payout_failure(
    payout_id: str,
    retry_count: int,
    error: Exception,
    label: str = "Payout",
) -> None:
    """Either schedule a retry or mark the payout permanently failed."""
    if retry_count < MAX_PAYOUT_RETRIES:
        await PayoutRepository.increment_retry(payout_id, str(error))
        logger.info(
            "%s %s scheduled for retry (%d/%d)",
            label,
            payout_id,
            retry_count + 1,
            MAX_PAYOUT_RETRIES,
        )
    else:
        await PayoutRepository.update_status(payout_id, "failed")
        logger.error(
            "%s %s permanently failed after %d retries",
            label,
            payout_id,
            MAX_PAYOUT_RETRIES,
        )
