"""Server-side guest contact visibility for property-facing PMS surfaces."""

import logging
from typing import Literal

from app.config import settings
from app.database import BookingEngineDatabase

logger = logging.getLogger(__name__)

HIDDEN_GUEST_CONTACT = "Hidden until you accept"
GuestContactPlan = Literal["fixed", "commission"]

_ACCEPTED_STATUSES = frozenset({"confirmed", "checked_in", "in_house", "checked_out", "no_show"})


async def fetch_guest_contact_plan(hotel_id: str) -> GuestContactPlan:
    """Return the effective plan, failing closed to commission privacy."""
    if not settings.BOOKING_ENGINE_DATABASE_URL:
        return "commission"
    try:
        row = await BookingEngineDatabase.fetchrow(
            """
            SELECT CASE
                     WHEN billing_pending_switch IS NOT NULL
                      AND billing_switch_effective_date IS NOT NULL
                      AND billing_switch_effective_date <= CURRENT_DATE
                       THEN billing_pending_switch
                     ELSE billing_active_plan
                   END AS effective_plan
              FROM booking_hotels
             WHERE id = $1
            """,
            hotel_id,
        )
    except Exception as exc:
        logger.error(
            "Failed to fetch guest-contact plan for hotel %s: %s — masking contact details",
            hotel_id,
            exc,
        )
        return "commission"
    if not row:
        logger.error(
            "No booking_hotels row found for hotel %s — masking guest contact details",
            hotel_id,
        )
        return "commission"
    return "fixed" if row["effective_plan"] == "fixed" else "commission"


def booking_has_ever_been_accepted(booking: dict) -> bool:
    """Use durable acceptance evidence; payment alone is deliberately insufficient."""
    return bool(
        booking.get("contact_details_revealed_at")
        or booking.get("finalization_started_at")
        or booking.get("finalization_completed_at")
        or booking.get("status") in _ACCEPTED_STATUSES
    )


def guest_contacts_are_visible(booking: dict, plan: GuestContactPlan) -> bool:
    return plan == "fixed" or booking_has_ever_been_accepted(booking)


def mask_booking_guest_contacts(booking: dict, plan: GuestContactPlan) -> dict:
    if guest_contacts_are_visible(booking, plan):
        return booking
    return {
        **booking,
        "guest_email": HIDDEN_GUEST_CONTACT,
        "guest_phone": HIDDEN_GUEST_CONTACT,
    }
