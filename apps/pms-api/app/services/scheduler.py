import logging
from collections.abc import Callable
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Any

from apscheduler.schedulers.asyncio import AsyncIOScheduler
from apscheduler.triggers.cron import CronTrigger
from apscheduler.triggers.interval import IntervalTrigger

from app.config import settings as app_settings
from app.database import Database
from app.repositories.affiliate_repo import AffiliateRepository
from app.repositories.booking_draft_repo import BookingDraftRepository
from app.repositories.booking_repo import BookingRepository
from app.repositories.channex_mapping_repo import ChannexConnectionRepository
from app.repositories.hotel_payment_settings_repo import HotelPaymentSettingsRepository
from app.repositories.hotel_repo import HotelRepository
from app.repositories.payout_repo import PayoutRepository
from app.services import xendit_service
from app.services.booking_service import expire_booking
from app.services.calendar_auto_open_service import apply_auto_open_for_hotel
from app.services.channex.inbound import poll_bookings_for_hotel
from app.services.channex.messaging import poll_messages_for_all_hotels
from app.services.channex.orchestrator import push_ari_for_hotel
from app.services.email_service import send_affiliate_payout_notification
from app.services.fixed_plan_billing import sync_all_subscription_prices
from app.services.payout_service import (
    dispatch_stripe_transfer,
    dispatch_xendit_payout,
    handle_payout_failure,
)
from app.services.xendit_service import XenditError

logger = logging.getLogger(__name__)

scheduler = AsyncIOScheduler()
fixed_plan_billing_scheduler = AsyncIOScheduler()
SchedulerStatus = dict[str, Any]


@dataclass(frozen=True)
class SchedulerJobDefinition:
    id: str
    func: Callable
    trigger_factory: Callable[[], object]
    cadence: str
    effect: str
    target_owner: str


_scheduler_status: SchedulerStatus | None = None


async def expire_pending_bookings():
    """Find and expire bookings where host hasn't responded in time."""
    now = datetime.now(UTC)
    expired = await BookingRepository.list_expired_pending(now)
    for row in expired:
        booking_id = str(row["id"])
        try:
            await expire_booking(booking_id)
            logger.info("Expired booking: %s", booking_id)
        except Exception as e:
            logger.error("Failed to expire booking %s: %s", booking_id, e)


async def process_property_payouts():
    """Process due hotel payouts via Stripe Connect transfers / Xendit."""
    now = datetime.now(UTC)
    due = await PayoutRepository.list_due_payouts(now)

    for payout in due:
        if payout["recipient_type"] != "hotel":
            continue

        payout_id = str(payout["id"])
        hotel_id = str(payout["recipient_id"])

        try:
            settings = await HotelPaymentSettingsRepository.get_by_hotel_id(hotel_id)
            if not settings:
                logger.warning(
                    "No payment settings for hotel %s, skipping payout %s", hotel_id, payout_id
                )
                continue

            provider = settings.get("payment_provider", "stripe")
            if provider == "vayada":
                # vayada Payment: payouts are handled manually — skip auto-processing
                logger.info(
                    "Skipping auto-payout %s for hotel %s (vayada provider, manual payout)",
                    payout_id,
                    hotel_id,
                )
                continue

            await PayoutRepository.update_status(payout_id, "processing")

            if provider == "xendit":
                if not settings.get("xendit_account_number"):
                    logger.warning(
                        "No Xendit bank details for hotel %s, skipping payout %s",
                        hotel_id,
                        payout_id,
                    )
                    await PayoutRepository.update_status(payout_id, "scheduled")
                    continue
                xendit_id = await dispatch_xendit_payout(
                    payout_id,
                    float(payout["amount"]),
                    payout["currency"],
                    reference_id=f"hotel-{payout_id}",
                    channel_code=settings["xendit_channel_code"],
                    account_number=settings["xendit_account_number"],
                    account_holder_name=settings["xendit_account_holder_name"],
                    description=f"Hotel payout for booking {payout.get('booking_reference', '')}",
                )
                logger.info(
                    "Submitted hotel payout %s to Xendit, xendit_id=%s", payout_id, xendit_id
                )
            else:
                if not settings.get("stripe_connect_account_id"):
                    logger.warning(
                        "No Stripe Connect account for hotel %s, skipping payout %s",
                        hotel_id,
                        payout_id,
                    )
                    await PayoutRepository.update_status(payout_id, "scheduled")
                    continue
                transfer_id = await dispatch_stripe_transfer(
                    payout_id,
                    float(payout["amount"]),
                    payout["currency"],
                    destination_account=settings["stripe_connect_account_id"],
                    metadata={
                        "payout_id": payout_id,
                        "booking_id": str(payout["booking_id"]),
                    },
                )
                logger.info(
                    "Completed hotel payout %s via Stripe, transfer %s", payout_id, transfer_id
                )

        except Exception as e:
            logger.error("Failed to process payout %s: %s", payout_id, e)
            await handle_payout_failure(
                payout_id, payout.get("retry_count", 0) or 0, e, label="Payout"
            )


async def process_affiliate_payouts():
    """Monthly batch: process affiliate payouts via Stripe Connect / Xendit."""
    now = datetime.now(UTC)
    # Process previous month
    if now.month == 1:
        month, year = 12, now.year - 1
    else:
        month, year = now.month - 1, now.year

    payouts = await PayoutRepository.list_monthly_affiliate_payouts(month, year)
    for payout in payouts:
        payout_id = str(payout["id"])
        affiliate_id = str(payout["recipient_id"])

        try:
            affiliate = await AffiliateRepository.get_by_id(affiliate_id)
            if not affiliate:
                logger.warning(
                    "Affiliate %s not found, skipping payout %s", affiliate_id, payout_id
                )
                continue

            payment_method = affiliate.get("payment_method")

            if payment_method == "xendit":
                if not affiliate.get("xendit_account_number"):
                    logger.info(
                        "Affiliate %s missing Xendit bank details, skipping payout %s",
                        affiliate_id,
                        payout_id,
                    )
                    continue
                await PayoutRepository.update_status(payout_id, "processing")
                xendit_id = await dispatch_xendit_payout(
                    payout_id,
                    float(payout["amount"]),
                    payout["currency"],
                    reference_id=f"affiliate-{payout_id}",
                    channel_code=affiliate["xendit_channel_code"],
                    account_number=affiliate["xendit_account_number"],
                    account_holder_name=affiliate["xendit_account_holder_name"],
                    description=f"Affiliate payout for booking {payout.get('booking_reference', '')}",
                )
                logger.info(
                    "Submitted affiliate payout %s to Xendit, xendit_id=%s", payout_id, xendit_id
                )

            elif payment_method == "stripe":
                if not affiliate.get("stripe_connect_account_id") or not affiliate.get(
                    "stripe_connect_onboarded"
                ):
                    logger.info(
                        "Affiliate %s not Stripe-onboarded, skipping payout %s for manual handling",
                        affiliate_id,
                        payout_id,
                    )
                    continue
                await PayoutRepository.update_status(payout_id, "processing")
                transfer_id = await dispatch_stripe_transfer(
                    payout_id,
                    float(payout["amount"]),
                    payout["currency"],
                    destination_account=affiliate["stripe_connect_account_id"],
                    metadata={
                        "payout_id": payout_id,
                        "booking_id": str(payout["booking_id"]),
                        "affiliate_id": affiliate_id,
                    },
                )
                logger.info(
                    "Completed affiliate payout %s via Stripe, transfer %s", payout_id, transfer_id
                )
                await send_affiliate_payout_notification(
                    affiliate_email=affiliate["email"],
                    affiliate_name=affiliate["full_name"],
                    payout_amount=float(payout["amount"]),
                    currency=payout["currency"],
                    payout_method="stripe",
                )

            else:
                # paypal / bank — skip for manual handling
                logger.info(
                    "Affiliate %s uses %s, skipping payout %s for manual handling",
                    affiliate_id,
                    payment_method,
                    payout_id,
                )
                continue

        except Exception as e:
            logger.error("Failed to process affiliate payout %s: %s", payout_id, e)
            await handle_payout_failure(
                payout_id, payout.get("retry_count", 0) or 0, e, label="Affiliate payout"
            )


async def poll_xendit_processing_payouts():
    """Poll Xendit for payouts stuck in 'processing' in case webhooks failed."""
    stale = await PayoutRepository.list_processing_xendit(older_than_minutes=30)
    for payout in stale:
        payout_id = str(payout["id"])
        xendit_id = payout["xendit_payout_id"]
        try:
            result = await xendit_service.get_payout(xendit_id)
            xendit_status = result["status"]

            if xendit_status == "SUCCEEDED":
                await PayoutRepository.update_status(
                    payout_id, "completed", xendit_payout_id=xendit_id
                )
                logger.info("Xendit poll: payout %s completed (xendit %s)", payout_id, xendit_id)

                if payout.get("recipient_type") == "affiliate":
                    affiliate = await AffiliateRepository.get_by_id(str(payout["recipient_id"]))
                    if affiliate:
                        await send_affiliate_payout_notification(
                            affiliate_email=affiliate["email"],
                            affiliate_name=affiliate["full_name"],
                            payout_amount=float(payout["amount"]),
                            currency=payout["currency"],
                            payout_method="xendit",
                        )
            elif xendit_status in ("FAILED", "REVERSED"):
                await PayoutRepository.update_status(payout_id, "failed")
                logger.warning(
                    "Xendit poll: payout %s failed (xendit %s, status=%s)",
                    payout_id,
                    xendit_id,
                    xendit_status,
                )
            else:
                logger.debug("Xendit poll: payout %s still %s", payout_id, xendit_status)
        except XenditError as e:
            logger.error("Xendit poll error for payout %s: %s", payout_id, e)
        except Exception as e:
            logger.error("Unexpected error polling Xendit payout %s: %s", payout_id, e)


async def cleanup_expired_drafts():
    """Sweep abandoned booking drafts (VAY-388) once their soft hold has
    been expired for an hour. Lazy filtering in count_active_for_stay
    already prevents stale rows from blocking inventory; this just keeps
    the table from growing forever."""
    deleted = await BookingDraftRepository.delete_expired(grace_minutes=60)
    if deleted:
        logger.info("Cleaned up %d expired booking draft(s)", deleted)


async def cancel_stale_unpaid_bookings():
    """Cancel pending bookings where payment was never completed (30+ min old)."""
    result = await Database.fetch(
        """
        UPDATE bookings
        SET status = 'cancelled'
        WHERE status = 'pending'
          AND payment_status = 'unpaid'
          AND payment_method = 'card'
          AND created_at < NOW() - INTERVAL '30 minutes'
        RETURNING id
        """
    )
    for row in result:
        logger.info("Cancelled stale unpaid booking: %s", row["id"])


async def poll_channex_bookings():
    """Poll all active Channex connections for new booking revisions."""
    connections = await ChannexConnectionRepository.list_active()
    for conn in connections:
        hotel_id = str(conn["hotel_id"])
        try:
            await poll_bookings_for_hotel(hotel_id)
        except Exception as e:
            logger.error("Failed to poll Channex bookings for hotel %s: %s", hotel_id, e)


async def full_channex_ari_sync():
    """Daily full availability + rates push to Channex for all active connections."""
    connections = await ChannexConnectionRepository.list_active()
    for conn in connections:
        hotel_id = str(conn["hotel_id"])
        try:
            await push_ari_for_hotel(hotel_id)
        except Exception as e:
            logger.error("Failed to sync Channex ARI for hotel %s: %s", hotel_id, e)


async def advance_calendar_auto_open_windows():
    """Advance rolling auto-open horizons. Idempotent and safe to run daily."""
    hotels = await HotelRepository.list_rolling_auto_open_hotels()
    for hotel in hotels:
        hotel_id = str(hotel["id"])
        try:
            result = await apply_auto_open_for_hotel(hotel_id)
            if result.changed:
                logger.info(
                    "Advanced calendar auto-open horizon for hotel %s through %s",
                    hotel_id,
                    result.open_through,
                )
        except Exception as e:
            logger.error("Failed to advance calendar auto-open for hotel %s: %s", hotel_id, e)


async def poll_channex_messages():
    """Manual reconciliation sweep — no longer scheduled. Channex requested we
    stop polling their `BookingMessages` list/feed; we rely on the `message`
    webhook instead. This function remains available for on-demand admin
    recovery if a webhook is suspected to have been missed."""
    try:
        await poll_messages_for_all_hotels()
    except Exception as e:
        logger.error("Channex message sweep failed: %s", e)


LEGACY_SCHEDULER_JOBS: tuple[SchedulerJobDefinition, ...] = (
    SchedulerJobDefinition(
        id="expire_pending_bookings",
        func=expire_pending_bookings,
        trigger_factory=lambda: IntervalTrigger(minutes=1),
        cadence="every minute",
        effect="Expires host-response-deadline bookings",
        target_owner="Booking/checkout",
    ),
    SchedulerJobDefinition(
        id="cancel_stale_unpaid_bookings",
        func=cancel_stale_unpaid_bookings,
        trigger_factory=lambda: IntervalTrigger(minutes=10),
        cadence="every 10 minutes",
        effect="Cancels pending unpaid card bookings older than 30 minutes",
        target_owner="Booking/checkout",
    ),
    SchedulerJobDefinition(
        id="cleanup_expired_drafts",
        func=cleanup_expired_drafts,
        trigger_factory=lambda: IntervalTrigger(minutes=10),
        cadence="every 10 minutes",
        effect="Deletes expired booking drafts",
        target_owner="Booking/checkout",
    ),
    SchedulerJobDefinition(
        id="process_property_payouts",
        func=process_property_payouts,
        trigger_factory=lambda: IntervalTrigger(hours=1),
        cadence="hourly",
        effect="Dispatches hotel Stripe/Xendit payouts",
        target_owner="Finance",
    ),
    SchedulerJobDefinition(
        id="process_affiliate_payouts",
        func=process_affiliate_payouts,
        trigger_factory=lambda: CronTrigger(day=1, hour=2, minute=0),
        cadence="monthly day 1 at 02:00",
        effect="Dispatches affiliate payouts and notifications",
        target_owner="Finance/marketplace affiliate",
    ),
    SchedulerJobDefinition(
        id="poll_xendit_processing_payouts",
        func=poll_xendit_processing_payouts,
        trigger_factory=lambda: IntervalTrigger(minutes=30),
        cadence="every 30 minutes",
        effect="Polls Xendit for processing payouts if webhook failed",
        target_owner="Finance",
    ),
    SchedulerJobDefinition(
        id="poll_channex_bookings",
        func=poll_channex_bookings,
        trigger_factory=lambda: IntervalTrigger(minutes=app_settings.CHANNEX_POLL_INTERVAL_MINUTES),
        cadence="interval from CHANNEX_POLL_INTERVAL_MINUTES",
        effect="Ingests Channex booking feed",
        target_owner="PMS channel-connectivity",
    ),
    SchedulerJobDefinition(
        id="full_channex_ari_sync",
        func=full_channex_ari_sync,
        trigger_factory=lambda: CronTrigger(hour=app_settings.CHANNEX_FULL_SYNC_HOUR, minute=0),
        cadence="daily at CHANNEX_FULL_SYNC_HOUR",
        effect="Pushes full ARI to Channex",
        target_owner="PMS channel-connectivity",
    ),
    SchedulerJobDefinition(
        id="advance_calendar_auto_open_windows",
        func=advance_calendar_auto_open_windows,
        trigger_factory=lambda: CronTrigger(hour=1, minute=15),
        cadence="daily at 01:15",
        effect="Opens rolling inventory/calendar windows",
        target_owner="PMS operations",
    ),
)


def _parse_job_id_list(raw_value: str) -> list[str]:
    return [job_id.strip() for job_id in raw_value.split(",") if job_id.strip()]


def build_scheduler_status(
    *,
    scheduler_enabled: bool,
    allowlist_raw: str,
    blocklist_raw: str,
    scheduler_running: bool = False,
) -> SchedulerStatus:
    job_ids = {job.id for job in LEGACY_SCHEDULER_JOBS}
    allowlist = _parse_job_id_list(allowlist_raw)
    blocklist = _parse_job_id_list(blocklist_raw)
    known_allowlist = [job_id for job_id in allowlist if job_id in job_ids]
    known_blocklist = [job_id for job_id in blocklist if job_id in job_ids]
    unknown_allowlist = [job_id for job_id in allowlist if job_id not in job_ids]
    unknown_blocklist = [job_id for job_id in blocklist if job_id not in job_ids]
    invalid_job_config = bool(unknown_allowlist or unknown_blocklist)

    jobs = []
    active_jobs = []
    frozen_jobs = []
    allowlist_filter_enabled = bool(allowlist)
    known_allowlist_set = set(known_allowlist)
    known_blocklist_set = set(known_blocklist)

    for job in LEGACY_SCHEDULER_JOBS:
        freeze_reason = None
        if invalid_job_config:
            freeze_reason = "invalid_job_id"
        elif not scheduler_enabled:
            freeze_reason = "scheduler_disabled"
        elif allowlist_filter_enabled and job.id not in known_allowlist_set:
            freeze_reason = "not_in_allowlist"
        elif job.id in known_blocklist_set:
            freeze_reason = "blocklisted"

        status = "frozen" if freeze_reason else "active"
        job_status = {
            "id": job.id,
            "status": status,
            "freeze_reason": freeze_reason,
            "cadence": job.cadence,
            "effect": job.effect,
            "target_owner": job.target_owner,
        }
        jobs.append(job_status)
        if status == "active":
            active_jobs.append(job.id)
        else:
            frozen_jobs.append({"id": job.id, "reason": freeze_reason})

    return {
        "enabled": scheduler_enabled,
        "running": scheduler_running,
        "allowlist": known_allowlist,
        "blocklist": known_blocklist,
        "unknown_allowlist": unknown_allowlist,
        "unknown_blocklist": unknown_blocklist,
        "configuration_valid": not invalid_job_config,
        "active_jobs": active_jobs,
        "frozen_jobs": frozen_jobs,
        "jobs": jobs,
    }


def _status_from_settings(target_scheduler: AsyncIOScheduler) -> SchedulerStatus:
    return build_scheduler_status(
        scheduler_enabled=app_settings.PMS_SCHEDULER_ENABLED,
        allowlist_raw=app_settings.PMS_SCHEDULER_JOB_ALLOWLIST,
        blocklist_raw=app_settings.PMS_SCHEDULER_JOB_BLOCKLIST,
        scheduler_running=target_scheduler.running,
    )


def _log_scheduler_status(status: SchedulerStatus) -> None:
    if status["unknown_allowlist"] or status["unknown_blocklist"]:
        logger.error(
            "Refusing to start legacy PMS scheduler jobs because unknown job ids were configured: "
            "allowlist=%s blocklist=%s",
            status["unknown_allowlist"],
            status["unknown_blocklist"],
        )

    logger.info(
        "Legacy PMS scheduler freeze status: enabled=%s active_jobs=%s frozen_jobs=%s",
        status["enabled"],
        status["active_jobs"],
        [job["id"] for job in status["frozen_jobs"]],
    )

    for job in status["jobs"]:
        if job["status"] == "active":
            logger.info("Legacy PMS scheduler job active: %s", job["id"])
        else:
            logger.info(
                "Legacy PMS scheduler job frozen: %s reason=%s",
                job["id"],
                job["freeze_reason"],
            )


def setup_scheduler(target_scheduler: AsyncIOScheduler | None = None):
    """Configure and return the scheduler with active legacy jobs."""
    global _scheduler_status

    target_scheduler = target_scheduler or scheduler
    target_scheduler.remove_all_jobs()
    status = _status_from_settings(target_scheduler)
    active_job_ids = set(status["active_jobs"])

    for job in LEGACY_SCHEDULER_JOBS:
        if job.id not in active_job_ids:
            continue
        target_scheduler.add_job(
            job.func,
            trigger=job.trigger_factory(),
            id=job.id,
            replace_existing=True,
        )

    # Channex message polling is disabled — Channex flagged the volume; we now
    # rely on the `message` webhook (handled in routers/webhooks.py). The
    # `poll_channex_messages` function is kept for manual recovery.

    _scheduler_status = status
    _log_scheduler_status(status)
    return target_scheduler


def setup_fixed_plan_billing_scheduler(
    target_scheduler: AsyncIOScheduler | None = None,
) -> AsyncIOScheduler:
    """Configure the billing outbox worker independently of frozen legacy jobs."""
    target_scheduler = target_scheduler or fixed_plan_billing_scheduler
    target_scheduler.remove_all_jobs()
    target_scheduler.add_job(
        sync_all_subscription_prices,
        trigger=IntervalTrigger(minutes=5),
        id="sync_fixed_plan_subscription_prices",
        replace_existing=True,
    )
    return target_scheduler


def get_scheduler_status() -> SchedulerStatus:
    if _scheduler_status is None:
        return _status_from_settings(scheduler)
    return {
        **_scheduler_status,
        "running": scheduler.running,
    }


def get_scheduler_health_status() -> SchedulerStatus:
    status = get_scheduler_status()
    return {
        "enabled": status["enabled"],
        "running": status["running"],
        "configuration_valid": status["configuration_valid"],
        "active_job_count": len(status["active_jobs"]),
        "frozen_job_count": len(status["frozen_jobs"]),
        "unknown_job_count": len(status["unknown_allowlist"]) + len(status["unknown_blocklist"]),
    }
