"""Guest-initiated booking change request flow (VAY-379).

Guests can ask to amend a confirmed booking — change dates, add or
remove add-ons, tweak add-on quantities/dates. The change does NOT
apply immediately: a row is written to ``booking_change_requests`` and
the host gets an email with approve/decline buttons (also accessible
from the PMS booking detail page). The booking row only mutates once
the host approves.

Pricing rules:
- Reuses the same primitives as ``booking_service`` so the diff the
  guest sees matches what they'd pay if they re-booked: stay pricing
  + add-on total + promo discount + last-minute discount remain locked
  to their original-booking values (we don't re-apply promo on a change;
  we don't re-resolve last-minute discounts).
- Price-reducing changes are blocked when the booking is already paid
  (status ``captured``/``refunded`` etc.). Pay-at-property and
  awaiting-transfer bookings can still change in either direction.

Concurrency:
- A ``UNIQUE INDEX … WHERE status = 'pending'`` on
  ``booking_change_requests`` enforces "one pending request per
  booking" at the DB level. Submitting while another is pending
  raises ``ValueError``.
"""

import asyncio
import json
import logging
from datetime import date

from app.database import Database
from app.repositories.booking_change_request_repo import BookingChangeRequestRepository
from app.repositories.booking_repo import BookingRepository
from app.repositories.linked_inventory_group_repo import LinkedInventoryGroupRepository
from app.repositories.room_type_repo import RoomTypeRepository
from app.services.availability_service import compute_stay_pricing
from app.services.booking_service import _compute_addon_total
from app.services.channex.ari_push import push_availability_for_room_type
from app.services.channex.orchestrator import push_ari_for_booking
from app.services.email_service import (
    send_guest_change_request_approved,
    send_guest_change_request_declined,
    send_guest_change_request_received,
    send_host_change_request,
    send_host_change_request_decision,
)

logger = logging.getLogger(__name__)


# Payment statuses that mean the guest's money has already moved (vs.
# pay-at-property or awaiting-transfer where it hasn't).
PAID_PAYMENT_STATUSES = {
    "captured",
    "refunded",
    "partially_refunded",
    "authorized",  # treat held card as already-paid for the price-down rule
}


def _nights(ci: date, co: date) -> int:
    return (co - ci).days


def _parse_json_field(value, default):
    if value is None:
        return default
    if isinstance(value, str):
        try:
            return json.loads(value)
        except (TypeError, ValueError):
            return default
    return value


def _booking_paid(booking: dict) -> bool:
    method = booking.get("payment_method") or "card"
    status = (booking.get("payment_status") or "").lower()
    if method in ("pay_at_property", "bank_transfer"):
        # Bank-transfer can be marked 'captured' once the host confirms it
        # arrived. Treat that as paid for the price-reducing rule too.
        return status in PAID_PAYMENT_STATUSES
    return status in PAID_PAYMENT_STATUSES


async def _compute_change_pricing(
    slug: str,
    booking: dict,
    room_type: dict,
    new_check_in: date,
    new_check_out: date,
    addon_ids: list[str],
    addon_quantities: dict,
    addon_dates: dict,
) -> tuple[float, float, float, list[str], int]:
    """Re-price the booking under the requested change. Returns
    (new_total, new_nightly_rate, new_addon_total, new_addon_names, nights).

    The promo discount and last-minute discount that were locked in at
    booking time are preserved — the guest doesn't lose them, but they
    also don't get re-resolved against today's date (which would let
    them lose a stacked discount mid-stay-edit).
    """
    nights = _nights(new_check_in, new_check_out)
    pricing = compute_stay_pricing(
        room_type,
        new_check_in,
        new_check_out,
        booking.get("adults"),
        booking.get("rate_type") or "flexible",
    )
    rooms = int(booking.get("number_of_rooms") or 1)
    room_total = round(pricing.room_total * rooms, 2)

    # Preserve last-minute discount as a flat amount (VAY-379 rule: don't
    # let the change request silently nullify a stacked discount).
    lm_amount = float(booking.get("last_minute_discount_amount") or 0)
    if lm_amount > 0:
        # Treat the original lm discount as a flat reduction; cap at room_total.
        lm_amount = min(lm_amount, room_total)
        room_total = round(room_total - lm_amount, 2)

    new_nightly_rate = round(room_total / max(1, nights * rooms), 2)

    new_addon_total, new_addon_names = await _compute_addon_total(
        slug,
        addon_ids,
        addon_quantities,
        booking["currency"],
        booking.get("adults") or 1,
        nights,
        addon_dates,
    )

    promo_discount = float(booking.get("promo_discount") or 0)
    new_total = round(room_total + new_addon_total - promo_discount, 2)
    if new_total < 0:
        new_total = 0.0
    return new_total, new_nightly_rate, new_addon_total, new_addon_names, nights


async def _validate_and_price_change(
    slug: str,
    booking: dict,
    payload_check_in: date,
    payload_check_out: date,
    addon_ids: list[str],
    addon_quantities: dict,
    addon_dates: dict,
) -> dict:
    """Run the full pre-flight check for a change. Returns a dict with
    ``available``, ``new_total``, ``price_difference``, ``blocked``,
    ``block_reason`` plus the recomputed pricing components used to
    persist or apply the change.

    Does not raise on policy blocks — surfaces them in ``blocked`` so
    the UI can show "you can't do this and here's why" without
    pretending to crash.
    """
    nights = _nights(payload_check_in, payload_check_out)
    if nights <= 0:
        raise ValueError("Check-out must be after check-in")

    room_type = await RoomTypeRepository.get_by_id(str(booking["room_type_id"]))
    if not room_type:
        raise ValueError("Room type not found")

    rooms_needed = int(booking.get("number_of_rooms") or 1)

    linked_stopped = await LinkedInventoryGroupRepository.has_activity(
        str(booking["room_type_id"]),
        payload_check_in,
        payload_check_out,
        exclude_booking_id=str(booking["id"]),
    )

    # Availability — only the "extra" nights matter for room availability,
    # but the simplest correct implementation is: availability of the new
    # window minus the rooms this booking already holds in the overlap.
    # We do that by counting bookings excluding ourselves.
    from app.repositories.room_type_repo import RoomTypeRepository as RTR

    booked_others = await RTR.count_booked(
        str(booking["room_type_id"]),
        payload_check_in,
        payload_check_out,
    )
    blocked = await RTR.count_blocked(
        str(booking["room_type_id"]),
        payload_check_in,
        payload_check_out,
    )
    # The current booking is itself counted in `booked_others` for the
    # overlap of new dates with old dates, so subtract its share when the
    # windows actually overlap.
    overlap_start = max(booking["check_in"], payload_check_in)
    overlap_end = min(booking["check_out"], payload_check_out)
    self_overlaps = overlap_start < overlap_end
    self_share = rooms_needed if self_overlaps else 0
    effective_booked = max(0, booked_others - self_share)
    remaining = max(0, room_type["total_rooms"] - effective_booked - blocked)
    available = not linked_stopped and remaining >= rooms_needed

    (
        new_total,
        new_nightly_rate,
        new_addon_total,
        new_addon_names,
        nights,
    ) = await _compute_change_pricing(
        slug,
        booking,
        room_type,
        payload_check_in,
        payload_check_out,
        addon_ids,
        addon_quantities,
        addon_dates,
    )
    old_total = float(booking["total_amount"])
    price_diff = round(new_total - old_total, 2)

    blocked_flag = False
    block_reason: str | None = None
    if not available:
        blocked_flag = True
        block_reason = "The selected dates are not available for this room."
    elif _booking_paid(booking) and price_diff < 0:
        blocked_flag = True
        block_reason = (
            "Price-reducing changes are not available for already paid "
            "bookings. Please contact the property."
        )

    return {
        "available": available,
        "new_total": new_total,
        "old_total": old_total,
        "price_difference": price_diff,
        "currency": booking["currency"],
        "blocked": blocked_flag,
        "block_reason": block_reason,
        "new_nightly_rate": new_nightly_rate,
        "new_addon_total": new_addon_total,
        "new_addon_names": new_addon_names,
        "nights": nights,
    }


def _ensure_change_allowed(booking: dict) -> None:
    """Common front-door checks before preview or submit."""
    if booking["status"] != "confirmed":
        raise ValueError("Only confirmed bookings can be changed")


async def _load_booking_for_guest(slug: str, booking_id: str, guest_email: str) -> dict:
    """Resolve a booking by id and verify it belongs to this hotel slug
    and the guest email matches. Raises ValueError on any mismatch."""
    booking = await BookingRepository.get_by_id(booking_id)
    if not booking:
        raise ValueError("Booking not found")
    hotel = await Database.fetchrow("SELECT id FROM hotels WHERE slug = $1", slug)
    if not hotel or str(booking["hotel_id"]) != str(hotel["id"]):
        raise ValueError("Booking not found")
    if booking["guest_email"].lower() != guest_email.lower():
        raise ValueError("Email does not match booking")
    return booking


async def preview_change(
    slug: str,
    booking_id: str,
    guest_email: str,
    *,
    check_in: date,
    check_out: date,
    addon_ids: list[str],
    addon_quantities: dict,
    addon_dates: dict,
) -> dict:
    """Compute the price diff and any block reason for a hypothetical
    change. Does not persist anything."""
    booking = await _load_booking_for_guest(slug, booking_id, guest_email)
    _ensure_change_allowed(booking)
    pending = await BookingChangeRequestRepository.get_pending_for_booking(booking_id)
    preview = await _validate_and_price_change(
        slug,
        booking,
        check_in,
        check_out,
        addon_ids,
        addon_quantities,
        addon_dates,
    )
    if pending:
        # Surface the existing-pending state so the UI can hide the form
        # rather than letting the guest type into a dead form.
        preview["blocked"] = True
        preview["block_reason"] = "A change request is already pending approval for this booking."
    return {
        "oldTotal": preview["old_total"],
        "newTotal": preview["new_total"],
        "priceDifference": preview["price_difference"],
        "currency": preview["currency"],
        "blocked": preview["blocked"],
        "blockReason": preview["block_reason"],
        "available": preview["available"],
    }


async def submit_change(
    slug: str,
    booking_id: str,
    guest_email: str,
    *,
    check_in: date,
    check_out: date,
    addon_ids: list[str],
    addon_quantities: dict,
    addon_dates: dict,
) -> dict:
    """Persist a new pending change request and notify the host."""
    booking = await _load_booking_for_guest(slug, booking_id, guest_email)
    _ensure_change_allowed(booking)
    if await BookingChangeRequestRepository.get_pending_for_booking(booking_id):
        raise ValueError("A change request is already pending approval for this booking.")

    preview = await _validate_and_price_change(
        slug,
        booking,
        check_in,
        check_out,
        addon_ids,
        addon_quantities,
        addon_dates,
    )
    if preview["blocked"]:
        raise ValueError(preview["block_reason"] or "Change not allowed")

    # Reject no-op changes — saves the host an email about a request
    # that doesn't actually change anything.
    same_dates = check_in == booking["check_in"] and check_out == booking["check_out"]
    old_addon_ids = sorted(_parse_json_field(booking.get("addon_ids"), []))
    new_addon_ids = sorted(addon_ids)
    same_addons = (
        old_addon_ids == new_addon_ids
        and _parse_json_field(booking.get("addon_quantities"), {}) == addon_quantities
        and _parse_json_field(booking.get("addon_dates"), {}) == addon_dates
    )
    if same_dates and same_addons:
        raise ValueError("No changes detected")

    cr_row = await BookingChangeRequestRepository.create(
        {
            "booking_id": booking_id,
            "old_check_in": booking["check_in"],
            "old_check_out": booking["check_out"],
            "old_addon_ids": _parse_json_field(booking.get("addon_ids"), []),
            "old_addon_quantities": _parse_json_field(booking.get("addon_quantities"), {}),
            "old_addon_dates": _parse_json_field(booking.get("addon_dates"), {}),
            "old_total": float(booking["total_amount"]),
            "requested_check_in": check_in,
            "requested_check_out": check_out,
            "requested_addon_ids": addon_ids,
            "requested_addon_quantities": addon_quantities,
            "requested_addon_dates": addon_dates,
            "requested_nightly_rate": preview["new_nightly_rate"],
            "requested_addon_total": preview["new_addon_total"],
            "requested_addon_names": preview["new_addon_names"],
            "new_total": preview["new_total"],
            "price_difference": preview["price_difference"],
            "currency": booking["currency"],
        }
    )

    hotel = await Database.fetchrow(
        "SELECT contact_email FROM hotels WHERE id = $1", booking["hotel_id"]
    )
    if hotel:
        asyncio.create_task(send_host_change_request(hotel["contact_email"], booking, cr_row))
    asyncio.create_task(send_guest_change_request_received(booking["guest_email"], booking, cr_row))
    return cr_row


async def get_change_request_for_guest(slug: str, booking_id: str, guest_email: str) -> dict | None:
    """Return the latest change request for a booking the guest can see.
    None when none exists — the UI uses this to decide whether to render
    the 'Change request pending' badge."""
    booking = await _load_booking_for_guest(slug, booking_id, guest_email)
    return await BookingChangeRequestRepository.get_latest_for_booking(str(booking["id"]))


async def approve_change(change_request_id: str, *, hotel_id: str | None = None) -> dict:
    """Apply an approved change to the booking. ``hotel_id`` is optional
    — when supplied (admin path), we double-check ownership."""
    cr = await BookingChangeRequestRepository.get_by_id(change_request_id)
    if not cr:
        raise ValueError("Change request not found")
    if cr["status"] != "pending":
        raise ValueError("Change request is not pending")

    booking = await BookingRepository.get_by_id(str(cr["booking_id"]))
    if not booking:
        raise ValueError("Booking not found")
    if hotel_id and str(booking["hotel_id"]) != str(hotel_id):
        raise ValueError("Booking does not belong to this hotel")

    # Re-validate availability at decision time — the inventory may have
    # shifted while the host was thinking. We don't recompute price (the
    # snapshot the guest agreed to is what we apply), but we do need to
    # be sure rooms are still bookable.
    room_type = await RoomTypeRepository.get_by_id(str(booking["room_type_id"]))
    if room_type:
        from app.repositories.room_type_repo import RoomTypeRepository as RTR

        linked_stopped = await LinkedInventoryGroupRepository.has_activity(
            str(booking["room_type_id"]),
            cr["requested_check_in"],
            cr["requested_check_out"],
            exclude_booking_id=str(booking["id"]),
        )
        booked_others = await RTR.count_booked(
            str(booking["room_type_id"]),
            cr["requested_check_in"],
            cr["requested_check_out"],
        )
        blocked = await RTR.count_blocked(
            str(booking["room_type_id"]),
            cr["requested_check_in"],
            cr["requested_check_out"],
        )
        rooms_needed = int(booking.get("number_of_rooms") or 1)
        overlap_start = max(booking["check_in"], cr["requested_check_in"])
        overlap_end = min(booking["check_out"], cr["requested_check_out"])
        self_share = rooms_needed if overlap_start < overlap_end else 0
        effective_booked = max(0, booked_others - self_share)
        remaining = max(0, room_type["total_rooms"] - effective_booked - blocked)
        if linked_stopped or remaining < rooms_needed:
            raise ValueError(
                "Requested dates are no longer available — please decline this "
                "request and ask the guest to pick different dates."
            )

    requested_addon_ids = _parse_json_field(cr.get("requested_addon_ids"), [])
    requested_addon_quantities = _parse_json_field(cr.get("requested_addon_quantities"), {})
    requested_addon_dates = _parse_json_field(cr.get("requested_addon_dates"), {})
    requested_addon_names = _parse_json_field(cr.get("requested_addon_names"), [])

    updated = await BookingRepository.apply_change_request(
        str(booking["id"]),
        check_in=cr["requested_check_in"],
        check_out=cr["requested_check_out"],
        nightly_rate=float(cr["requested_nightly_rate"]),
        addon_ids=requested_addon_ids,
        addon_quantities=requested_addon_quantities,
        addon_dates=requested_addon_dates,
        addon_names=requested_addon_names,
        addon_total=float(cr["requested_addon_total"]),
        total_amount=float(cr["new_total"]),
    )

    # Price-up: mark the booking as awaiting a top-up payment so the
    # guest sees a "complete payment" link. Re-charging Stripe / Xendit
    # for the difference is deferred (see VAY-379 plan).
    price_diff = float(cr["price_difference"])
    if price_diff > 0 and not _booking_paid(booking):
        # Unpaid booking — the new total simply replaces the old one and
        # is paid at property / on transfer / etc. Nothing more to do.
        pass
    elif price_diff > 0:
        await BookingRepository.update_payment_status(str(booking["id"]), "awaiting_top_up")

    cr_decided = await BookingChangeRequestRepository.mark_decided(change_request_id, "approved")

    refreshed = await BookingRepository.get_by_id(str(booking["id"]))
    asyncio.create_task(
        send_guest_change_request_approved(refreshed["guest_email"], refreshed, cr_decided)
    )
    hotel = await Database.fetchrow(
        "SELECT contact_email FROM hotels WHERE id = $1", booking["hotel_id"]
    )
    if hotel:
        asyncio.create_task(
            send_host_change_request_decision(
                hotel["contact_email"], refreshed, cr_decided, approved=True
            )
        )

    # Inventory shifted — refresh OTAs.
    asyncio.create_task(
        push_availability_for_room_type(str(booking["hotel_id"]), str(booking["room_type_id"]))
    )
    asyncio.create_task(push_ari_for_booking(str(booking["id"])))

    return cr_decided


async def decline_change(
    change_request_id: str,
    reason: str | None = None,
    *,
    hotel_id: str | None = None,
) -> dict:
    """Decline a pending change request. Booking row stays untouched."""
    cr = await BookingChangeRequestRepository.get_by_id(change_request_id)
    if not cr:
        raise ValueError("Change request not found")
    if cr["status"] != "pending":
        raise ValueError("Change request is not pending")

    booking = await BookingRepository.get_by_id(str(cr["booking_id"]))
    if not booking:
        raise ValueError("Booking not found")
    if hotel_id and str(booking["hotel_id"]) != str(hotel_id):
        raise ValueError("Booking does not belong to this hotel")

    cr_decided = await BookingChangeRequestRepository.mark_decided(
        change_request_id,
        "declined",
        decline_reason=reason,
    )

    asyncio.create_task(
        send_guest_change_request_declined(booking["guest_email"], booking, cr_decided)
    )
    hotel = await Database.fetchrow(
        "SELECT contact_email FROM hotels WHERE id = $1", booking["hotel_id"]
    )
    if hotel:
        asyncio.create_task(
            send_host_change_request_decision(
                hotel["contact_email"], booking, cr_decided, approved=False
            )
        )
    return cr_decided
