from datetime import UTC, datetime
from pathlib import Path
from unittest.mock import AsyncMock, patch

import pytest
from app.repositories.booking_repo import BookingRepository
from app.routers.admin_bookings import _guest_to_response
from app.services import guest_contact_access
from app.services.guest_contact_access import (
    HIDDEN_GUEST_CONTACT,
    booking_has_ever_been_accepted,
    fetch_guest_contact_plan,
    mask_booking_guest_contacts,
)


def test_commission_plan_masks_only_contact_before_acceptance():
    booking = {
        "status": "pending",
        "payment_status": "captured",
        "guest_first_name": "Ada",
        "guest_country": "DE",
        "guest_email": "ada@example.test",
        "guest_phone": "+491234",
    }

    masked = mask_booking_guest_contacts(booking, "commission")

    assert masked["guest_email"] == HIDDEN_GUEST_CONTACT
    assert masked["guest_phone"] == HIDDEN_GUEST_CONTACT
    assert masked["guest_first_name"] == "Ada"
    assert masked["guest_country"] == "DE"
    assert booking["guest_email"] == "ada@example.test"
    assert not booking_has_ever_been_accepted(booking)


@pytest.mark.parametrize(
    "evidence",
    [
        {"status": "confirmed"},
        {"status": "checked_in"},
        {"status": "checked_out"},
        {"status": "no_show"},
        {"status": "cancelled", "finalization_started_at": datetime.now(UTC)},
        {"status": "cancelled", "contact_details_revealed_at": datetime.now(UTC)},
    ],
)
def test_commission_plan_reveals_after_acceptance_and_keeps_revealing(evidence):
    booking = {
        **evidence,
        "guest_email": "ada@example.test",
        "guest_phone": "+491234",
    }

    assert mask_booking_guest_contacts(booking, "commission") is booking


def test_fixed_plan_always_reveals_contact():
    booking = {
        "status": "pending",
        "guest_email": "ada@example.test",
        "guest_phone": "+491234",
    }

    assert mask_booking_guest_contacts(booking, "fixed") is booking


def test_ambiguous_historical_cancellation_stays_masked():
    booking = {
        "status": "cancelled",
        "host_response_deadline": None,
        "payment_status": "captured",
        "guest_email": "ada@example.test",
        "guest_phone": "+491234",
    }

    masked = mask_booking_guest_contacts(booking, "commission")

    assert masked["guest_email"] == HIDDEN_GUEST_CONTACT
    assert not booking_has_ever_been_accepted(booking)


def test_migration_backfills_only_durable_acceptance_evidence():
    sql = (
        Path(__file__).parents[1] / "migrations" / "092_guest_contact_reveal_evidence.sql"
    ).read_text()

    assert "finalization_started_at IS NOT NULL" in sql
    assert "status IN ('confirmed', 'checked_in', 'in_house', 'checked_out', 'no_show')" in sql
    assert "host_response_deadline" not in sql


def test_additional_guest_masks_contact_but_keeps_identity():
    guest = {
        "id": "guest-1",
        "booking_id": "booking-1",
        "position": 1,
        "first_name": "Grace",
        "last_name": "Hopper",
        "nationality": "US",
        "email": "grace@example.test",
        "phone": "+12025550123",
        "created_at": datetime.now(UTC),
        "updated_at": datetime.now(UTC),
    }

    response = _guest_to_response(guest, guest_contact_visible=False)

    assert response.first_name == "Grace"
    assert response.nationality == "US"
    assert response.email == HIDDEN_GUEST_CONTACT
    assert response.phone == HIDDEN_GUEST_CONTACT


@pytest.mark.asyncio
async def test_commission_search_does_not_match_hidden_email():
    with patch(
        "app.repositories.booking_repo.Database.fetch",
        AsyncMock(return_value=[]),
    ) as fetch:
        await BookingRepository.list_by_hotel_id(
            "hotel-1",
            search="secret@example.test",
            hide_unaccepted_guest_contact=True,
        )

    sql = fetch.await_args.args[0]
    assert "b.guest_email ILIKE" in sql
    assert "b.contact_details_revealed_at IS NOT NULL" in sql


@pytest.mark.asyncio
async def test_plan_lookup_uses_effective_fixed_plan():
    with (
        patch.object(
            guest_contact_access.settings,
            "BOOKING_ENGINE_DATABASE_URL",
            "postgresql://booking.test/db",
        ),
        patch.object(
            guest_contact_access.BookingEngineDatabase,
            "fetchrow",
            AsyncMock(return_value={"effective_plan": "fixed"}),
        ) as fetchrow,
    ):
        assert await fetch_guest_contact_plan("hotel-1") == "fixed"

    assert "billing_pending_switch" in fetchrow.await_args.args[0]


@pytest.mark.asyncio
async def test_plan_lookup_failure_masks_contact():
    with (
        patch.object(
            guest_contact_access.settings,
            "BOOKING_ENGINE_DATABASE_URL",
            "postgresql://booking.test/db",
        ),
        patch.object(
            guest_contact_access.BookingEngineDatabase,
            "fetchrow",
            AsyncMock(side_effect=RuntimeError("unavailable")),
        ),
    ):
        assert await fetch_guest_contact_plan("hotel-1") == "commission"
