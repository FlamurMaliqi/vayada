from app.services.scheduler import (
    LEGACY_SCHEDULER_JOBS,
    build_scheduler_status,
    setup_fixed_plan_billing_scheduler,
)
from apscheduler.schedulers.asyncio import AsyncIOScheduler

EXPECTED_JOB_IDS = [
    "expire_pending_bookings",
    "cancel_stale_unpaid_bookings",
    "cleanup_expired_drafts",
    "process_property_payouts",
    "process_affiliate_payouts",
    "poll_xendit_processing_payouts",
    "poll_channex_bookings",
    "full_channex_ari_sync",
    "advance_calendar_auto_open_windows",
]


def test_scheduler_registry_maps_freeze_matrix_jobs_one_to_one():
    assert [job.id for job in LEGACY_SCHEDULER_JOBS] == EXPECTED_JOB_IDS


def test_scheduler_environment_disable_freezes_every_job():
    status = build_scheduler_status(
        scheduler_enabled=False,
        allowlist_raw="",
        blocklist_raw="",
    )

    assert status["active_jobs"] == []
    assert [job["id"] for job in status["frozen_jobs"]] == EXPECTED_JOB_IDS
    assert {job["reason"] for job in status["frozen_jobs"]} == {"scheduler_disabled"}


def test_scheduler_allowlist_keeps_only_listed_jobs_active():
    status = build_scheduler_status(
        scheduler_enabled=True,
        allowlist_raw="poll_channex_bookings, full_channex_ari_sync",
        blocklist_raw="",
    )

    assert status["active_jobs"] == ["poll_channex_bookings", "full_channex_ari_sync"]
    frozen = {job["id"]: job["reason"] for job in status["frozen_jobs"]}
    assert frozen["expire_pending_bookings"] == "not_in_allowlist"
    assert frozen["advance_calendar_auto_open_windows"] == "not_in_allowlist"


def test_scheduler_blocklist_freezes_listed_jobs_and_wins_over_allowlist():
    status = build_scheduler_status(
        scheduler_enabled=True,
        allowlist_raw="poll_channex_bookings, full_channex_ari_sync",
        blocklist_raw="full_channex_ari_sync",
    )

    assert status["active_jobs"] == ["poll_channex_bookings"]
    frozen = {job["id"]: job["reason"] for job in status["frozen_jobs"]}
    assert frozen["full_channex_ari_sync"] == "blocklisted"
    assert frozen["expire_pending_bookings"] == "not_in_allowlist"


def test_scheduler_status_fails_closed_for_unknown_job_ids():
    status = build_scheduler_status(
        scheduler_enabled=True,
        allowlist_raw="poll_channex_bookings,missing_job",
        blocklist_raw="another_missing_job",
    )

    assert status["unknown_allowlist"] == ["missing_job"]
    assert status["unknown_blocklist"] == ["another_missing_job"]
    assert status["configuration_valid"] is False
    assert status["active_jobs"] == []
    assert [job["id"] for job in status["frozen_jobs"]] == EXPECTED_JOB_IDS
    assert {job["reason"] for job in status["frozen_jobs"]} == {"invalid_job_id"}


def test_fixed_plan_billing_worker_is_independent_of_legacy_freeze():
    billing_scheduler = setup_fixed_plan_billing_scheduler(AsyncIOScheduler())

    job = billing_scheduler.get_job("sync_fixed_plan_subscription_prices")
    assert job is not None
    assert str(job.trigger) == "interval[0:05:00]"
