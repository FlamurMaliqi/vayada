import asyncio
import json
import logging
from datetime import date

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel

from app.database import AuthDatabase, Database
from app.dependencies import require_hotel_admin
from app.models.booking import (
    AdminBookingCreate,
    AssignedRoom,
    BookingAdditionalGuestPayload,
    BookingAdditionalGuestResponse,
    BookingAdminResponse,
    BookingArrivalCharge,
    BookingCheckInComplete,
    BookingDetailsUpdate,
    BookingNoteCreate,
    BookingNoteResponse,
    BookingRoomAssign,
    BookingRoomSwap,
    BookingStatusUpdate,
    CancelBookingRequest,
)
from app.models.payment import PayoutResponse
from app.repositories.booking_additional_guest_repo import (
    BookingAdditionalGuestRepository,
)
from app.repositories.booking_change_request_repo import BookingChangeRequestRepository
from app.repositories.booking_event_repo import BookingEventRepository
from app.repositories.booking_note_repo import BookingNoteRepository
from app.repositories.booking_repo import BookingRepository
from app.repositories.booking_room_repo import BookingRoomRepository
from app.repositories.checkin_checklist_repo import CheckinChecklistRepository
from app.repositories.payment_repo import PaymentRepository
from app.repositories.payout_repo import PayoutRepository
from app.repositories.room_repo import RoomRepository
from app.repositories.room_type_repo import RoomTypeRepository
from app.services.booking_change_service import (
    approve_change as approve_booking_change,
)
from app.services.booking_change_service import (
    decline_change as decline_booking_change,
)
from app.services.booking_service import (
    _compute_addon_total,
    _fetch_hotel_addons,
    host_accept_booking,
    host_reject_booking,
)
from app.services.channex_sync_service import push_availability_for_room_type
from app.services.email_service import (
    send_guest_admin_booking_confirmed,
    send_guest_cancellation,
    send_guest_confirmation,
)
from app.services.guest_contact_access import (
    HIDDEN_GUEST_CONTACT,
    fetch_guest_contact_plan,
    guest_contacts_are_visible,
    mask_booking_guest_contacts,
)
from app.services.room_assignment import try_place_unassigned_after_cancellation
from app.utils import get_hotel_id

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/admin", tags=["admin-bookings"])

ADDON_LOCK_PAYMENT_STATUSES = {"captured", "refunded", "partially_refunded", "paid"}


def _parse_json_field(value, default):
    if value is None:
        return default
    if isinstance(value, str):
        try:
            return json.loads(value)
        except (TypeError, ValueError):
            return default
    return value


def _as_date(value) -> date:
    if isinstance(value, date):
        return value
    return date.fromisoformat(str(value))


def _is_direct_channel(channel: str | None) -> bool:
    return (channel or "direct").strip().lower() in {"direct", "website", "booking_engine"}


def _validate_max_stay(room_type: dict, check_in: date, check_out: date) -> None:
    nights = max(1, (check_out - check_in).days)
    try:
        seasons = RoomTypeRepository._parse_seasons(room_type)
        max_stay = RoomTypeRepository._find_stay_max_stay(seasons, check_in, check_out)
    except Exception as exc:
        logger.warning(
            "Failed to evaluate max-stay for room type %s: %s",
            room_type.get("id") if room_type else None,
            exc,
        )
        raise HTTPException(
            status_code=400,
            detail="Unable to validate max-stay for selected dates",
        ) from exc
    if max_stay and nights > max_stay:
        raise HTTPException(
            status_code=400,
            detail=(
                f"This room has a maximum stay of {max_stay} nights for the selected dates. "
                "Please shorten your stay."
            ),
        )


async def _has_captured_payment(booking: dict) -> bool:
    if (booking.get("payment_status") or "").lower() in ADDON_LOCK_PAYMENT_STATUSES:
        return True
    payments = await PaymentRepository.list_by_booking_ids([str(booking["id"])])
    return any((p.get("status") or "").lower() in ADDON_LOCK_PAYMENT_STATUSES for p in payments)


def _addons_changed(booking: dict, updates: dict) -> bool:
    current_ids = _parse_json_field(booking.get("addon_ids"), [])
    current_quantities = _parse_json_field(booking.get("addon_quantities"), {})
    current_dates = _parse_json_field(booking.get("addon_dates"), {})
    ids_changed = "addon_ids" in updates and updates["addon_ids"] != current_ids
    quantities_changed = (
        "addon_quantities" in updates and updates["addon_quantities"] != current_quantities
    )
    dates_changed = "addon_dates" in updates and updates["addon_dates"] != current_dates
    return ids_changed or quantities_changed or dates_changed


async def _normalize_addon_selection(
    *,
    slug: str,
    addon_ids: list[str],
    addon_quantities: dict,
    adults: int,
    nights: int,
    addon_dates: dict | None = None,
) -> tuple[list[str], dict[str, int]]:
    if not addon_ids:
        return [], {}

    all_addons = await _fetch_hotel_addons(slug)
    addon_map = {addon["id"]: addon for addon in all_addons}
    unknown_ids = [addon_id for addon_id in addon_ids if addon_id not in addon_map]
    if unknown_ids:
        raise HTTPException(status_code=400, detail="Unknown add-on selected")

    normalized_quantities: dict[str, int] = {}
    addon_dates = addon_dates or {}
    for addon_id in addon_ids:
        addon = addon_map[addon_id]
        per_person = bool(addon.get("perPerson"))
        per_night = bool(addon.get("perNight"))
        if per_person:
            fallback = max(1, adults)
            maximum = max(1, adults)
        elif per_night:
            fallback = len(addon_dates.get(addon_id) or []) or max(1, nights)
            maximum = max(1, nights)
        else:
            fallback = 1
            maximum = 99
        raw_quantity = addon_quantities.get(addon_id, fallback)
        try:
            quantity = int(raw_quantity)
        except (TypeError, ValueError):
            quantity = fallback
        normalized_quantities[addon_id] = max(1, min(quantity, maximum))
    return addon_ids, normalized_quantities


def _booking_to_admin(b: dict, extra_rooms: list | None = None) -> BookingAdminResponse:
    ci = b["check_in"]
    co = b["check_out"]
    nights = (co - ci).days
    room_id = b.get("room_id")
    deadline = b.get("host_response_deadline")
    room_max_occupancy = max(1, int(b.get("room_max_occupancy") or 1))
    number_of_rooms = max(1, int(b.get("number_of_rooms") or 1))

    # Full assigned-room list: primary (position 0) + any extras (VAY-403).
    assigned_rooms: list[AssignedRoom] = []
    if room_id:
        assigned_rooms.append(
            AssignedRoom(
                room_id=str(room_id),
                room_number=b.get("room_number"),
                position=0,
            )
        )
    for er in extra_rooms or []:
        assigned_rooms.append(
            AssignedRoom(
                room_id=str(er["room_id"]),
                room_number=er.get("room_number"),
                position=er["position"],
            )
        )
    pf = b.get("platform_fee_amount")
    ac = b.get("affiliate_commission_amount")
    pp = b.get("property_payout_amount")
    return BookingAdminResponse(
        id=str(b["id"]),
        booking_reference=b["booking_reference"],
        room_type_id=str(b["room_type_id"]),
        room_name=b["room_name"],
        room_max_occupancy=room_max_occupancy,
        total_room_capacity=room_max_occupancy * number_of_rooms,
        guest_first_name=b["guest_first_name"],
        guest_last_name=b["guest_last_name"],
        guest_email=b["guest_email"],
        guest_phone=b["guest_phone"],
        guest_country=b.get("guest_country") or "",
        guest_gender=b.get("guest_gender") or "",
        guest_date_of_birth=(
            str(b["guest_date_of_birth"]) if b.get("guest_date_of_birth") else None
        ),
        guest_passport_number=b.get("guest_passport_number") or "",
        special_requests=b["special_requests"],
        check_in=str(ci),
        check_out=str(co),
        nights=nights,
        adults=b["adults"],
        children=b["children"],
        nightly_rate=float(b["nightly_rate"]),
        number_of_rooms=number_of_rooms,
        total_amount=float(b["total_amount"]),
        deposit_required=bool(b.get("deposit_required", False)),
        deposit_percentage=b.get("deposit_percentage"),
        deposit_amount=float(b.get("deposit_amount") or 0),
        balance_amount=float(
            b.get("balance_amount") if b.get("balance_amount") is not None else b["total_amount"]
        ),
        currency=b["currency"],
        status=b["status"],
        room_id=str(room_id) if room_id else None,
        room_number=b.get("room_number"),
        assigned_rooms=assigned_rooms,
        channel=b.get("channel", "direct"),
        payment_method=b.get("payment_method"),
        payment_status=b.get("payment_status"),
        check_in_pending_flags=b.get("check_in_pending_flags") or [],
        checked_in_at=b["checked_in_at"].isoformat() if b.get("checked_in_at") else None,
        checked_out_at=b.get("checked_out_at").isoformat() if b.get("checked_out_at") else None,
        host_response_deadline=deadline.isoformat() if deadline else None,
        platform_fee_amount=float(pf) if pf is not None else None,
        affiliate_commission_amount=float(ac) if ac is not None else None,
        property_payout_amount=float(pp) if pp is not None else None,
        addon_ids=b.get("addon_ids") or [],
        addon_names=b.get("addon_names") or [],
        addon_total=float(b["addon_total"]) if b.get("addon_total") else 0,
        addon_quantities=b.get("addon_quantities") or {},
        addon_dates=b.get("addon_dates") or {},
        guest_withdrawn=b.get("guest_withdrawn", False),
        created_at=b["created_at"].isoformat(),
        updated_at=b["updated_at"].isoformat(),
    )


async def _admin_response(b: dict) -> BookingAdminResponse:
    """_booking_to_admin enriched with the booking's extra rooms so the
    detail panel / single-booking responses list every assigned room of a
    multi-room booking (VAY-403). Single-room bookings have no extras, so
    this is one cheap indexed lookup that returns nothing extra."""
    extras = await BookingRoomRepository.list_extra_rooms(str(b["id"]))
    plan = await fetch_guest_contact_plan(str(b["hotel_id"]))
    return _booking_to_admin(mask_booking_guest_contacts(b, plan), extras)


# ── Bookings ────────────────────────────────────────────────────────


@router.post("/bookings", response_model=BookingAdminResponse, status_code=201)
async def create_admin_booking(
    data: AdminBookingCreate,
    user_id: str = Depends(require_hotel_admin),
):
    hotel_id = await get_hotel_id(user_id)

    # Validate room belongs to hotel
    room = await RoomRepository.get_by_id(data.room_id)
    if not room or str(room["hotel_id"]) != hotel_id:
        raise HTTPException(status_code=404, detail="Room not found")

    # Validate dates
    if data.check_out <= data.check_in:
        raise HTTPException(status_code=400, detail="check_out must be after check_in")

    # Check room availability
    available = await BookingRepository.is_room_available(
        data.room_id, data.check_in, data.check_out
    )
    if not available:
        raise HTTPException(status_code=409, detail="Room is not available for the selected dates")

    # Get room type for pricing
    room_type = await RoomTypeRepository.get_by_id(str(room["room_type_id"]))
    nights = (data.check_out - data.check_in).days
    _validate_max_stay(room_type, data.check_in, data.check_out)
    if data.nightly_rate is not None:
        nightly_rate = data.nightly_rate
    else:
        resolved_base, _ = RoomTypeRepository.resolve_rate(room_type, data.check_in)
        nightly_rate = resolved_base
    hotel_slug = await Database.fetchval("SELECT slug FROM hotels WHERE id = $1", hotel_id)
    addon_ids, addon_quantities = await _normalize_addon_selection(
        slug=hotel_slug,
        addon_ids=data.addon_ids or [],
        addon_quantities=data.addon_quantities or {},
        adults=data.adults,
        nights=nights,
    )
    addon_total, addon_names = await _compute_addon_total(
        hotel_slug,
        addon_ids,
        addon_quantities,
        room_type["currency"],
        data.adults,
        nights,
        {},
    )
    total_amount = nightly_rate * nights + addon_total

    booking = await BookingRepository.create(
        {
            "hotel_id": hotel_id,
            "room_type_id": str(room["room_type_id"]),
            "guest_first_name": data.guest_first_name,
            "guest_last_name": data.guest_last_name,
            "guest_email": data.guest_email,
            "guest_phone": data.guest_phone,
            "guest_country": data.guest_country,
            "special_requests": data.special_requests,
            "check_in": data.check_in,
            "check_out": data.check_out,
            "adults": data.adults,
            "children": data.children,
            "nightly_rate": nightly_rate,
            "total_amount": total_amount,
            "currency": room_type["currency"],
            "room_id": data.room_id,
            "channel": data.channel,
            "status": "confirmed",
            "addon_ids": addon_ids,
            "addon_names": addon_names,
            "addon_quantities": addon_quantities,
            "addon_total": addon_total,
        }
    )

    # Re-fetch with JOINs for full response
    full_booking = await BookingRepository.get_by_id(str(booking["id"]))

    # Push updated availability to Channex (only affected dates)
    asyncio.create_task(
        push_availability_for_room_type(
            hotel_id,
            str(room["room_type_id"]),
            start_date=data.check_in,
            end_date=data.check_out,
        )
    )

    # Notify guest of their confirmed booking
    if full_booking.get("guest_email"):
        asyncio.create_task(
            send_guest_admin_booking_confirmed(full_booking["guest_email"], full_booking)
        )

    return await _admin_response(full_booking)


@router.get("/bookings")
async def list_bookings(
    status: str | None = Query(None),
    search: str | None = Query(None),
    limit: int = Query(50, ge=1, le=500),
    offset: int = Query(0, ge=0),
    user_id: str = Depends(require_hotel_admin),
):
    hotel_id = await get_hotel_id(user_id)
    plan = await fetch_guest_contact_plan(hotel_id)
    bookings = await BookingRepository.list_by_hotel_id(
        hotel_id,
        status=status,
        search=search,
        hide_unaccepted_guest_contact=plan == "commission",
        limit=limit,
        offset=offset,
    )
    total = await BookingRepository.count_by_hotel_id(hotel_id, status=status)

    # One batched lookup of extra rooms for the whole page so a multi-room
    # reservation shows its real room count in the list (VAY-403), without
    # an N+1 over every row.
    extras_by_booking: dict[str, list] = {}
    extra_rows = await BookingRoomRepository.list_extra_rooms_for_bookings(
        [str(b["id"]) for b in bookings]
    )
    for er in extra_rows:
        extras_by_booking.setdefault(str(er["booking_id"]), []).append(er)

    return {
        "bookings": [
            _booking_to_admin(
                mask_booking_guest_contacts(b, plan),
                extras_by_booking.get(str(b["id"])),
            )
            for b in bookings
        ],
        "total": total,
        "limit": limit,
        "offset": offset,
    }


@router.get("/bookings/{booking_id}", response_model=BookingAdminResponse)
async def get_booking(
    booking_id: str,
    user_id: str = Depends(require_hotel_admin),
):
    hotel_id = await get_hotel_id(user_id)
    booking = await BookingRepository.get_by_id(booking_id)
    if not booking or str(booking["hotel_id"]) != hotel_id:
        raise HTTPException(status_code=404, detail="Booking not found")
    return await _admin_response(booking)


@router.patch("/bookings/{booking_id}", response_model=BookingAdminResponse)
async def update_booking_details(
    booking_id: str,
    data: BookingDetailsUpdate,
    user_id: str = Depends(require_hotel_admin),
):
    hotel_id = await get_hotel_id(user_id)
    booking = await BookingRepository.get_by_id(booking_id)
    if not booking or str(booking["hotel_id"]) != hotel_id:
        raise HTTPException(status_code=404, detail="Booking not found")

    updates = data.model_dump(exclude_none=True)
    plan = await fetch_guest_contact_plan(hotel_id)
    if not guest_contacts_are_visible(booking, plan):
        updates.pop("guest_email", None)
        updates.pop("guest_phone", None)
    if _addons_changed(booking, updates):
        if not _is_direct_channel(booking.get("channel")):
            raise HTTPException(status_code=400, detail="OTA bookings cannot edit add-ons in PMS")
        if await _has_captured_payment(booking):
            raise HTTPException(status_code=400, detail="Add-ons locked after payment")

    should_reprice_addons = any(
        key in updates
        for key in (
            "check_in",
            "check_out",
            "adults",
            "addon_ids",
            "addon_quantities",
            "addon_dates",
        )
    )
    current_addon_ids = _parse_json_field(booking.get("addon_ids"), [])
    next_addon_ids = updates.get("addon_ids", current_addon_ids)
    if "check_in" in updates or "check_out" in updates:
        next_check_in = _as_date(updates.get("check_in", booking["check_in"]))
        next_check_out = _as_date(updates.get("check_out", booking["check_out"]))
        if next_check_out <= next_check_in:
            raise HTTPException(status_code=400, detail="check_out must be after check_in")
        room_type = await RoomTypeRepository.get_by_id(str(booking["room_type_id"]))
        _validate_max_stay(room_type, next_check_in, next_check_out)
    if should_reprice_addons and next_addon_ids:
        check_in = _as_date(updates.get("check_in", booking["check_in"]))
        check_out = _as_date(updates.get("check_out", booking["check_out"]))
        nights = max(1, (check_out - check_in).days)
        addon_quantities = updates.get(
            "addon_quantities",
            _parse_json_field(booking.get("addon_quantities"), {}),
        )
        addon_dates = updates.get("addon_dates", _parse_json_field(booking.get("addon_dates"), {}))
        addon_quantities = {
            addon_id: addon_quantities[addon_id]
            for addon_id in next_addon_ids
            if addon_id in addon_quantities
        }
        addon_dates = {
            addon_id: addon_dates[addon_id]
            for addon_id in next_addon_ids
            if addon_id in addon_dates
        }
        next_addon_ids, addon_quantities = await _normalize_addon_selection(
            slug=booking["hotel_slug"],
            addon_ids=next_addon_ids,
            addon_quantities=addon_quantities,
            adults=int(updates.get("adults", booking["adults"])),
            nights=nights,
            addon_dates=addon_dates,
        )
        addon_total, addon_names = await _compute_addon_total(
            booking["hotel_slug"],
            next_addon_ids,
            addon_quantities,
            booking["currency"],
            int(updates.get("adults", booking["adults"])),
            nights,
            addon_dates,
        )
        updates["addon_ids"] = next_addon_ids
        updates["addon_quantities"] = addon_quantities
        updates["addon_dates"] = addon_dates
        updates["addon_names"] = addon_names
        updates["addon_total"] = addon_total
    elif "addon_ids" in updates and not updates["addon_ids"]:
        updates["addon_quantities"] = {}
        updates["addon_dates"] = {}
        updates["addon_names"] = []
        updates["addon_total"] = 0

    updated = await BookingRepository.update_details(booking_id, updates)
    if not updated:
        raise HTTPException(status_code=404, detail="Booking not found")

    # Push availability if dates changed (cover both old and new date ranges)
    if data.check_in is not None or data.check_out is not None:
        old_start = booking["check_in"]
        old_end = booking["check_out"]
        new_start = _as_date(data.check_in) if data.check_in is not None else old_start
        new_end = _as_date(data.check_out) if data.check_out is not None else old_end
        asyncio.create_task(
            push_availability_for_room_type(
                hotel_id,
                str(booking["room_type_id"]),
                start_date=min(old_start, new_start),
                end_date=max(old_end, new_end),
            )
        )

    return await _admin_response(updated)


@router.get("/bookings/addons/available")
async def list_available_addons_for_new_booking(
    room_id: str = Query(...),
    user_id: str = Depends(require_hotel_admin),
):
    hotel_id = await get_hotel_id(user_id)
    room = await RoomRepository.get_by_id(room_id)
    if not room or str(room["hotel_id"]) != hotel_id:
        raise HTTPException(status_code=404, detail="Room not found")
    slug = await Database.fetchval("SELECT slug FROM hotels WHERE id = $1", hotel_id)
    return await _fetch_hotel_addons(slug)


@router.get("/bookings/{booking_id}/addons")
async def list_booking_addons(
    booking_id: str,
    user_id: str = Depends(require_hotel_admin),
):
    hotel_id = await get_hotel_id(user_id)
    booking = await BookingRepository.get_by_id(booking_id)
    if not booking or str(booking["hotel_id"]) != hotel_id:
        raise HTTPException(status_code=404, detail="Booking not found")
    return await _fetch_hotel_addons(booking["hotel_slug"])


@router.patch("/bookings/{booking_id}/status", response_model=BookingAdminResponse)
async def update_booking_status(
    booking_id: str,
    data: BookingStatusUpdate,
    user_id: str = Depends(require_hotel_admin),
):
    if data.status == "checked_in":
        raise HTTPException(
            status_code=400,
            detail="Use the check-in endpoint to mark a booking as checked in",
        )
    if data.status not in ("confirmed", "cancelled"):
        raise HTTPException(
            status_code=400,
            detail="Status must be 'confirmed' or 'cancelled'",
        )

    hotel_id = await get_hotel_id(user_id)
    booking = await BookingRepository.get_by_id(booking_id)
    if not booking or str(booking["hotel_id"]) != hotel_id:
        raise HTTPException(status_code=404, detail="Booking not found")
    if await PaymentRepository.has_active_stripe_refund(booking_id):
        raise HTTPException(status_code=409, detail="A refund is still processing")

    updated_status = (
        await BookingRepository.cancel_with_promo_reversal(booking_id)
        if data.status == "cancelled"
        else await BookingRepository.update_status(booking_id, data.status)
    )
    if not updated_status:
        raise HTTPException(status_code=409, detail="Booking status is currently locked")
    updated = await BookingRepository.get_by_id(booking_id)

    # Push availability to Channex (only affected dates)
    asyncio.create_task(
        push_availability_for_room_type(
            hotel_id,
            str(booking["room_type_id"]),
            start_date=booking["check_in"],
            end_date=booking["check_out"],
        )
    )

    # Fire-and-forget: notify guest of status change
    if data.status == "confirmed":
        asyncio.create_task(send_guest_confirmation(updated["guest_email"], updated))
    elif data.status == "cancelled":
        asyncio.create_task(send_guest_cancellation(updated["guest_email"], updated))
        # VAY-397: cancellation may have freed a slot that an unassigned
        # booking can take. Fire-and-forget so the admin doesn't wait.
        if booking.get("room_id"):
            asyncio.create_task(
                try_place_unassigned_after_cancellation(
                    hotel_id,
                    str(booking["room_type_id"]),
                    booking["check_in"],
                    booking["check_out"],
                )
            )

    return await _admin_response(updated)


@router.post("/bookings/{booking_id}/check-in", response_model=BookingAdminResponse)
async def complete_booking_check_in(
    booking_id: str,
    data: BookingCheckInComplete,
    user_id: str = Depends(require_hotel_admin),
):
    hotel_id = await get_hotel_id(user_id)
    booking = await BookingRepository.get_by_id(booking_id)
    if not booking or str(booking["hotel_id"]) != hotel_id:
        raise HTTPException(status_code=404, detail="Booking not found")
    if await PaymentRepository.has_active_stripe_refund(booking_id):
        raise HTTPException(status_code=409, detail="A refund is still processing")

    if booking["status"] not in ("confirmed", "checked_in"):
        raise HTTPException(status_code=400, detail="Only confirmed bookings can be checked in")

    pending_flag_details = (
        [flag.model_dump(mode="json") for flag in data.pending_flag_details]
        if data.pending_flag_details
        else [{"step_id": flag, "label": flag} for flag in data.pending_flags]
    )
    if data.pending_flag_details:
        labels_from_details = {flag["label"] for flag in pending_flag_details}
        labels_from_flags = set(data.pending_flags)
        if labels_from_details != labels_from_flags:
            raise HTTPException(
                status_code=400, detail="pendingFlagDetails must match pendingFlags"
            )

    pool = await Database.get_pool()
    async with pool.acquire() as conn:
        async with conn.transaction():
            updated = await BookingRepository.complete_check_in(
                booking_id, data.pending_flags, conn=conn
            )
            if not updated:
                raise HTTPException(status_code=409, detail="Booking check-in is currently locked")

            await CheckinChecklistRepository.create_record(
                booking_id=booking_id,
                completed_by=user_id,
                step_results=[result.model_dump(mode="json") for result in data.step_results],
                pending_flags=pending_flag_details,
                conn=conn,
            )

            await BookingEventRepository.record(
                booking_id=booking_id,
                hotel_id=hotel_id,
                event_type="guest_checked_in",
                payload={
                    "pending_flags": data.pending_flags,
                    "pending_flag_details": pending_flag_details,
                },
                actor_user_id=user_id,
                conn=conn,
            )

    return await _admin_response(await BookingRepository.get_by_id(booking_id))


@router.post("/bookings/{booking_id}/mark-paid", response_model=BookingAdminResponse)
async def mark_booking_paid(
    booking_id: str,
    user_id: str = Depends(require_hotel_admin),
):
    hotel_id = await get_hotel_id(user_id)
    booking = await BookingRepository.get_by_id(booking_id)
    if not booking or str(booking["hotel_id"]) != hotel_id:
        raise HTTPException(status_code=404, detail="Booking not found")

    if booking.get("payment_method") == "paypal" and booking.get("status") == "pending":
        try:
            updated = await host_accept_booking(booking_id, user_id)
        except ValueError as e:
            raise HTTPException(status_code=400, detail=str(e)) from e
        return await _admin_response(updated)

    updated = await BookingRepository.mark_balance_paid(booking_id)
    if not updated:
        raise HTTPException(status_code=404, detail="Booking not found")

    await BookingEventRepository.record(
        booking_id=booking_id,
        hotel_id=hotel_id,
        event_type="arrival_payment_marked_paid",
        payload={
            "amount": float(
                booking.get("balance_amount")
                if booking.get("balance_amount") is not None
                else booking.get("total_amount") or 0
            ),
            "currency": booking.get("currency"),
        },
        actor_user_id=user_id,
    )
    return await _admin_response(await BookingRepository.get_by_id(booking_id))


@router.post("/bookings/{booking_id}/arrival-charge", response_model=BookingAdminResponse)
async def add_booking_arrival_charge(
    booking_id: str,
    data: BookingArrivalCharge,
    user_id: str = Depends(require_hotel_admin),
):
    if data.amount <= 0:
        raise HTTPException(status_code=400, detail="Amount must be greater than zero")

    hotel_id = await get_hotel_id(user_id)
    booking = await BookingRepository.get_by_id(booking_id)
    if not booking or str(booking["hotel_id"]) != hotel_id:
        raise HTTPException(status_code=404, detail="Booking not found")

    pool = await Database.get_pool()
    async with pool.acquire() as conn:
        async with conn.transaction():
            updated = await BookingRepository.add_arrival_charge(booking_id, data.amount, conn=conn)
            if not updated:
                raise HTTPException(status_code=404, detail="Booking not found")

            await BookingEventRepository.record(
                booking_id=booking_id,
                hotel_id=hotel_id,
                event_type="arrival_charge_added",
                payload={"amount": data.amount, "description": data.description},
                actor_user_id=user_id,
                conn=conn,
            )
    return await _admin_response(await BookingRepository.get_by_id(booking_id))


# ── Room Assignment ───────────────────────────────────────────────


@router.patch("/bookings/{booking_id}/assign-room", response_model=BookingAdminResponse)
async def assign_room_to_booking(
    booking_id: str,
    data: BookingRoomAssign,
    user_id: str = Depends(require_hotel_admin),
):
    hotel_id = await get_hotel_id(user_id)
    booking = await BookingRepository.get_by_id(booking_id)
    if not booking or str(booking["hotel_id"]) != hotel_id:
        raise HTTPException(status_code=404, detail="Booking not found")

    # Validate room belongs to hotel and matches room type
    room = await RoomRepository.get_by_id(data.room_id)
    if not room or str(room["hotel_id"]) != hotel_id:
        raise HTTPException(status_code=404, detail="Room not found")
    if str(room["room_type_id"]) != str(booking["room_type_id"]):
        raise HTTPException(
            status_code=400,
            detail="Room does not belong to the same room type as the booking",
        )

    # Check room availability for the booking dates
    available = await BookingRepository.is_room_available(
        data.room_id, booking["check_in"], booking["check_out"]
    )
    if not available:
        raise HTTPException(
            status_code=409,
            detail="Room is not available for the booking dates",
        )

    await BookingRepository.assign_room(booking_id, data.room_id)
    updated = await BookingRepository.get_by_id(booking_id)
    return await _admin_response(updated)


@router.patch("/bookings/{booking_id}/move-room", response_model=BookingAdminResponse)
async def move_booking_to_room(
    booking_id: str,
    data: BookingRoomAssign,
    user_id: str = Depends(require_hotel_admin),
):
    hotel_id = await get_hotel_id(user_id)
    booking = await BookingRepository.get_by_id(booking_id)
    if not booking or str(booking["hotel_id"]) != hotel_id:
        raise HTTPException(status_code=404, detail="Booking not found")

    if booking["status"] == "cancelled":
        raise HTTPException(
            status_code=400,
            detail="Cancelled bookings cannot be moved",
        )

    # VAY-403: a multi-room booking has a primary room (bookings.room_id)
    # plus extra rooms (booking_rooms). The caller says which one to move
    # via from_room_id; omitting it moves the primary, exactly as before.
    primary_room_id = str(booking["room_id"]) if booking.get("room_id") else None
    extras = await BookingRoomRepository.list_extra_rooms(booking_id)
    extra_room_ids = {str(er["room_id"]) for er in extras}
    own_room_ids = ({primary_room_id} if primary_room_id else set()) | extra_room_ids

    from_room_id = data.from_room_id or primary_room_id
    if from_room_id and from_room_id not in own_room_ids:
        raise HTTPException(
            status_code=400,
            detail="from_room_id is not one of this booking's rooms",
        )
    if from_room_id == data.room_id:
        raise HTTPException(
            status_code=400,
            detail="Booking is already assigned to this room",
        )

    room = await RoomRepository.get_by_id(data.room_id)
    if not room or str(room["hotel_id"]) != hotel_id:
        raise HTTPException(status_code=404, detail="Room not found")
    if str(room["room_type_id"]) != str(booking["room_type_id"]):
        raise HTTPException(
            status_code=400,
            detail="Room does not belong to the same room type as the booking",
        )

    # Target must be free of every OTHER booking's rooms (primary + extras),
    # and must not collide with another room this same booking already holds.
    occupied = await BookingRoomRepository.occupied_room_ids_for_room_type(
        str(booking["room_type_id"]), booking["check_in"], booking["check_out"]
    )
    if data.room_id in (occupied - own_room_ids) or data.room_id in own_room_ids:
        raise HTTPException(
            status_code=409,
            detail="Room is not available for the booking dates",
        )

    if from_room_id == primary_room_id:
        await BookingRepository.assign_room(booking_id, data.room_id)
    else:
        await BookingRoomRepository.reassign_extra_room(booking_id, from_room_id, data.room_id)
    await BookingEventRepository.record(
        booking_id=booking_id,
        hotel_id=hotel_id,
        event_type="room_moved",
        payload={
            "from_room_id": from_room_id,
            "to_room_id": data.room_id,
        },
        actor_user_id=user_id,
    )

    asyncio.create_task(
        push_availability_for_room_type(
            hotel_id,
            str(booking["room_type_id"]),
            start_date=booking["check_in"],
            end_date=booking["check_out"],
        )
    )

    updated = await BookingRepository.get_by_id(booking_id)
    return await _admin_response(updated)


@router.patch("/bookings/{booking_id}/unassign-room", response_model=BookingAdminResponse)
async def unassign_booking_room(
    booking_id: str,
    user_id: str = Depends(require_hotel_admin),
):
    """Push an assigned booking back to Unassigned (clears room_id).

    Used by the calendar's room picker when the user wants to free a room so a
    different (currently unassigned) booking can be placed there. The displaced
    booking simply joins the Unassigned row and can be reassigned later.
    """
    hotel_id = await get_hotel_id(user_id)
    booking = await BookingRepository.get_by_id(booking_id)
    if not booking or str(booking["hotel_id"]) != hotel_id:
        raise HTTPException(status_code=404, detail="Booking not found")

    if booking["status"] not in ("pending", "confirmed"):
        raise HTTPException(
            status_code=400,
            detail="Only pending or confirmed bookings can be unassigned",
        )

    current_room_id = str(booking["room_id"]) if booking.get("room_id") else None
    if not current_room_id:
        raise HTTPException(
            status_code=400,
            detail="Booking is already unassigned",
        )

    await BookingRepository.unassign_room(booking_id)
    await BookingEventRepository.record(
        booking_id=booking_id,
        hotel_id=hotel_id,
        event_type="room_unassigned",
        payload={"from_room_id": current_room_id},
        actor_user_id=user_id,
    )

    asyncio.create_task(
        push_availability_for_room_type(
            hotel_id,
            str(booking["room_type_id"]),
            start_date=booking["check_in"],
            end_date=booking["check_out"],
        )
    )

    updated = await BookingRepository.get_by_id(booking_id)
    return await _admin_response(updated)


@router.patch("/bookings/{booking_id}/swap-room", response_model=BookingAdminResponse)
async def swap_booking_rooms(
    booking_id: str,
    data: BookingRoomSwap,
    user_id: str = Depends(require_hotel_admin),
):
    """Swap room assignments between two reservations.

    Two-way swap: source booking takes partner's current room and vice versa.
    Unassigned-source case: source takes partner's room and partner moves to a
    free room provided in `partner_destination_room_id`. Both updates happen
    atomically in one SQL statement so the swap can never half-apply.
    """
    if data.partner_booking_id == booking_id:
        raise HTTPException(
            status_code=400,
            detail="Cannot swap a booking with itself",
        )

    hotel_id = await get_hotel_id(user_id)

    source = await BookingRepository.get_by_id(booking_id)
    if not source or str(source["hotel_id"]) != hotel_id:
        raise HTTPException(status_code=404, detail="Booking not found")

    partner = await BookingRepository.get_by_id(data.partner_booking_id)
    if not partner or str(partner["hotel_id"]) != hotel_id:
        raise HTTPException(status_code=404, detail="Partner booking not found")

    # Both bookings must be in a swappable status. Cancelled is excluded
    # outright; checked-in/checked-out are deferred to a future iteration.
    SWAPPABLE_STATUSES = {"pending", "confirmed"}
    for label, b in (("source", source), ("partner", partner)):
        if b["status"] not in SWAPPABLE_STATUSES:
            raise HTTPException(
                status_code=400,
                detail=f"{label.capitalize()} booking is not in a swappable status",
            )

    # v1 only swaps within the same room type — the move-room endpoint
    # already enforces this and rate-plan implications of cross-type moves
    # are out of scope for this ticket.
    if str(source["room_type_id"]) != str(partner["room_type_id"]):
        raise HTTPException(
            status_code=400,
            detail="Bookings must belong to the same room type to swap",
        )

    source_room_id = str(source["room_id"]) if source.get("room_id") else None
    partner_room_id = str(partner["room_id"]) if partner.get("room_id") else None

    if not partner_room_id:
        raise HTTPException(
            status_code=400,
            detail="Partner booking has no room assigned — nothing to swap",
        )

    # Determine target room for each booking.
    new_source_room_id = partner_room_id
    if source_room_id:
        # Standard 2-way swap: partner takes source's room.
        new_partner_room_id = source_room_id
        if data.partner_destination_room_id and data.partner_destination_room_id != source_room_id:
            raise HTTPException(
                status_code=400,
                detail="partnerDestinationRoomId is only used when source is unassigned",
            )
    else:
        # Unassigned source: partner must move to a free room provided by caller.
        if not data.partner_destination_room_id:
            raise HTTPException(
                status_code=400,
                detail="partnerDestinationRoomId is required when source booking is unassigned",
            )
        new_partner_room_id = data.partner_destination_room_id
        # The free room must belong to this hotel and the same room type.
        free_room = await RoomRepository.get_by_id(new_partner_room_id)
        if not free_room or str(free_room["hotel_id"]) != hotel_id:
            raise HTTPException(status_code=404, detail="Destination room not found")
        if str(free_room["room_type_id"]) != str(partner["room_type_id"]):
            raise HTTPException(
                status_code=400,
                detail="Destination room does not belong to the same room type",
            )

    if new_source_room_id == source_room_id and new_partner_room_id == partner_room_id:
        raise HTTPException(
            status_code=400,
            detail="Swap is a no-op — bookings already in target rooms",
        )

    # Conflict check: after the swap, neither room may overlap any other booking.
    # Both bookings are excluded from each room's check because they are the
    # ones moving.
    excluded = [booking_id, data.partner_booking_id]
    source_room_ok = await BookingRepository.is_room_available_excluding(
        new_source_room_id,
        source["check_in"],
        source["check_out"],
        excluded,
    )
    if not source_room_ok:
        raise HTTPException(
            status_code=409,
            detail="Target room for source booking has a conflict",
        )
    partner_room_ok = await BookingRepository.is_room_available_excluding(
        new_partner_room_id,
        partner["check_in"],
        partner["check_out"],
        excluded,
    )
    if not partner_room_ok:
        raise HTTPException(
            status_code=409,
            detail="Target room for partner booking has a conflict",
        )

    # Atomic two-row update.
    await BookingRepository.swap_room_assignments(
        booking_id,
        new_source_room_id,
        data.partner_booking_id,
        new_partner_room_id,
    )

    # Audit: one event per booking, each pointing at the other.
    await BookingEventRepository.record(
        booking_id=booking_id,
        hotel_id=hotel_id,
        event_type="room_swapped",
        payload={
            "from_room_id": source_room_id,
            "to_room_id": new_source_room_id,
            "paired_booking_id": data.partner_booking_id,
        },
        actor_user_id=user_id,
    )
    await BookingEventRepository.record(
        booking_id=data.partner_booking_id,
        hotel_id=hotel_id,
        event_type="room_swapped",
        payload={
            "from_room_id": partner_room_id,
            "to_room_id": new_partner_room_id,
            "paired_booking_id": booking_id,
        },
        actor_user_id=user_id,
    )

    # Push availability for the affected room type. Same room type for both
    # bookings (enforced above), and Channex tracks availability per type, so
    # one push covering the union of both date ranges is sufficient.
    asyncio.create_task(
        push_availability_for_room_type(
            hotel_id,
            str(source["room_type_id"]),
            start_date=min(source["check_in"], partner["check_in"]),
            end_date=max(source["check_out"], partner["check_out"]),
        )
    )

    updated = await BookingRepository.get_by_id(booking_id)
    return await _admin_response(updated)


# ── Accept / Reject (new payment flow) ────────────────────────────


@router.post("/bookings/{booking_id}/accept", response_model=BookingAdminResponse)
async def accept_booking(
    booking_id: str,
    user_id: str = Depends(require_hotel_admin),
):
    try:
        updated = await host_accept_booking(booking_id, user_id)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e)) from e
    return await _admin_response(updated)


class RejectBookingRequest(BaseModel):
    reason: str | None = None


@router.post("/bookings/{booking_id}/reject", response_model=BookingAdminResponse)
async def reject_booking(
    booking_id: str,
    body: RejectBookingRequest = RejectBookingRequest(),
    user_id: str = Depends(require_hotel_admin),
):
    try:
        updated = await host_reject_booking(booking_id, user_id, reason=body.reason)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e)) from e
    return await _admin_response(updated)


# ── Change requests (VAY-379) ─────────────────────────────────────


def _change_request_admin(cr: dict) -> dict:
    """Serialize a change_request DB row for the admin/PMS UI."""
    import json as _json

    def _decode(val, default):
        if val is None:
            return default
        if isinstance(val, str):
            try:
                return _json.loads(val)
            except (TypeError, ValueError):
                return default
        return val

    return {
        "id": str(cr["id"]),
        "bookingId": str(cr["booking_id"]),
        "status": cr["status"],
        "oldCheckIn": str(cr["old_check_in"]),
        "oldCheckOut": str(cr["old_check_out"]),
        "oldAddonIds": _decode(cr.get("old_addon_ids"), []),
        "oldAddonQuantities": _decode(cr.get("old_addon_quantities"), {}),
        "oldAddonDates": _decode(cr.get("old_addon_dates"), {}),
        "oldTotal": float(cr["old_total"]),
        "requestedCheckIn": str(cr["requested_check_in"]),
        "requestedCheckOut": str(cr["requested_check_out"]),
        "requestedAddonIds": _decode(cr.get("requested_addon_ids"), []),
        "requestedAddonQuantities": _decode(cr.get("requested_addon_quantities"), {}),
        "requestedAddonDates": _decode(cr.get("requested_addon_dates"), {}),
        "requestedAddonNames": _decode(cr.get("requested_addon_names"), []),
        "newTotal": float(cr["new_total"]),
        "priceDifference": float(cr["price_difference"]),
        "currency": cr["currency"],
        "declineReason": cr.get("decline_reason"),
        "decidedAt": cr["decided_at"].isoformat() if cr.get("decided_at") else None,
        "createdAt": cr["created_at"].isoformat() if cr.get("created_at") else None,
    }


@router.get("/bookings/{booking_id}/change-request")
async def admin_get_change_request(
    booking_id: str,
    user_id: str = Depends(require_hotel_admin),
):
    hotel_id = await get_hotel_id(user_id)
    booking = await BookingRepository.get_by_id(booking_id)
    if not booking or str(booking["hotel_id"]) != hotel_id:
        raise HTTPException(status_code=404, detail="Booking not found")
    cr = await BookingChangeRequestRepository.get_latest_for_booking(booking_id)
    if not cr:
        return None
    return _change_request_admin(cr)


@router.post("/bookings/{booking_id}/change-request/approve")
async def admin_approve_change_request(
    booking_id: str,
    user_id: str = Depends(require_hotel_admin),
):
    hotel_id = await get_hotel_id(user_id)
    booking = await BookingRepository.get_by_id(booking_id)
    if not booking or str(booking["hotel_id"]) != hotel_id:
        raise HTTPException(status_code=404, detail="Booking not found")
    pending = await BookingChangeRequestRepository.get_pending_for_booking(booking_id)
    if not pending:
        raise HTTPException(status_code=404, detail="No pending change request")
    try:
        cr = await approve_booking_change(str(pending["id"]), hotel_id=hotel_id)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e)) from e
    return _change_request_admin(cr)


class DeclineChangeRequestBody(BaseModel):
    reason: str | None = None


@router.post("/bookings/{booking_id}/change-request/decline")
async def admin_decline_change_request(
    booking_id: str,
    body: DeclineChangeRequestBody = DeclineChangeRequestBody(),
    user_id: str = Depends(require_hotel_admin),
):
    hotel_id = await get_hotel_id(user_id)
    booking = await BookingRepository.get_by_id(booking_id)
    if not booking or str(booking["hotel_id"]) != hotel_id:
        raise HTTPException(status_code=404, detail="Booking not found")
    pending = await BookingChangeRequestRepository.get_pending_for_booking(booking_id)
    if not pending:
        raise HTTPException(status_code=404, detail="No pending change request")
    try:
        cr = await decline_booking_change(
            str(pending["id"]),
            reason=body.reason,
            hotel_id=hotel_id,
        )
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e)) from e
    return _change_request_admin(cr)


# ── Booking detail page — notes, additional guests, cancel (VAY-495) ──


def _note_to_response(n: dict) -> BookingNoteResponse:
    return BookingNoteResponse(
        id=str(n["id"]),
        booking_id=str(n["booking_id"]),
        author_user_id=str(n["author_user_id"]),
        author_name=n.get("author_name") or "",
        body=n["body"],
        source=n.get("source"),
        created_at=n["created_at"].isoformat(),
    )


def _guest_to_response(
    g: dict, *, guest_contact_visible: bool = True
) -> BookingAdditionalGuestResponse:
    dob = g.get("date_of_birth")
    return BookingAdditionalGuestResponse(
        id=str(g["id"]),
        booking_id=str(g["booking_id"]),
        position=g["position"],
        first_name=g.get("first_name") or "",
        last_name=g.get("last_name") or "",
        gender=g.get("gender") or "",
        nationality=g.get("nationality") or "",
        date_of_birth=str(dob) if dob else None,
        email=(g.get("email") or "") if guest_contact_visible else HIDDEN_GUEST_CONTACT,
        phone=(g.get("phone") or "") if guest_contact_visible else HIDDEN_GUEST_CONTACT,
        passport_number=g.get("passport_number") or "",
        room_position=g.get("room_position"),
        created_at=g["created_at"].isoformat(),
        updated_at=g["updated_at"].isoformat(),
    )


def _validate_room_position(booking: dict, room_position: int | None) -> None:
    """0..number_of_rooms-1 or None. Raise 400 otherwise."""
    if room_position is None:
        return
    n = int(booking.get("number_of_rooms") or 1)
    if room_position < 0 or room_position >= n:
        raise HTTPException(
            status_code=400,
            detail=f"roomPosition must be between 0 and {n - 1} for this booking",
        )


async def _booking_owned_by_hotel(booking_id: str, user_id: str) -> tuple[dict, str]:
    """Load a booking and assert it belongs to the caller's hotel. Raises 404
    on miss to avoid leaking which IDs exist for other hotels."""
    hotel_id = await get_hotel_id(user_id)
    booking = await BookingRepository.get_by_id(booking_id)
    if not booking or str(booking["hotel_id"]) != hotel_id:
        raise HTTPException(status_code=404, detail="Booking not found")
    return booking, hotel_id


@router.get("/bookings/{booking_id}/notes")
async def list_booking_notes(
    booking_id: str,
    user_id: str = Depends(require_hotel_admin),
):
    await _booking_owned_by_hotel(booking_id, user_id)
    notes = await BookingNoteRepository.list_for_booking(booking_id)
    return {"notes": [_note_to_response(n).model_dump(by_alias=True) for n in notes]}


@router.post("/bookings/{booking_id}/notes", response_model=BookingNoteResponse, status_code=201)
async def create_booking_note(
    booking_id: str,
    data: BookingNoteCreate,
    user_id: str = Depends(require_hotel_admin),
):
    body = data.body.strip()
    if not body:
        raise HTTPException(status_code=400, detail="Note body is required")
    _, hotel_id = await _booking_owned_by_hotel(booking_id, user_id)
    user = await AuthDatabase.fetchrow("SELECT name, email FROM users WHERE id = $1", user_id)
    author_name = (user["name"] if user else None) or (user["email"] if user else None) or ""
    note = await BookingNoteRepository.create(
        booking_id=booking_id,
        hotel_id=hotel_id,
        author_user_id=user_id,
        author_name=author_name,
        body=body,
        source=data.source,
    )
    return _note_to_response(note)


@router.delete("/bookings/{booking_id}/notes/{note_id}", status_code=204)
async def delete_booking_note(
    booking_id: str,
    note_id: str,
    user_id: str = Depends(require_hotel_admin),
):
    _, hotel_id = await _booking_owned_by_hotel(booking_id, user_id)
    note = await BookingNoteRepository.get_by_id(note_id)
    if not note or str(note["booking_id"]) != booking_id or str(note["hotel_id"]) != hotel_id:
        raise HTTPException(status_code=404, detail="Note not found")
    await BookingNoteRepository.delete(note_id)


@router.get("/bookings/{booking_id}/additional-guests")
async def list_additional_guests(
    booking_id: str,
    user_id: str = Depends(require_hotel_admin),
):
    booking, hotel_id = await _booking_owned_by_hotel(booking_id, user_id)
    plan = await fetch_guest_contact_plan(hotel_id)
    contact_visible = guest_contacts_are_visible(booking, plan)
    guests = await BookingAdditionalGuestRepository.list_for_booking(booking_id)
    return {
        "guests": [
            _guest_to_response(g, guest_contact_visible=contact_visible).model_dump(by_alias=True)
            for g in guests
        ]
    }


@router.post(
    "/bookings/{booking_id}/additional-guests",
    response_model=BookingAdditionalGuestResponse,
    status_code=201,
)
async def create_additional_guest(
    booking_id: str,
    data: BookingAdditionalGuestPayload,
    user_id: str = Depends(require_hotel_admin),
):
    booking, hotel_id = await _booking_owned_by_hotel(booking_id, user_id)
    room_type = await RoomTypeRepository.get_by_id(str(booking["room_type_id"]))
    room_capacity = max(1, int((room_type or {}).get("max_occupancy") or 1))
    capacity = max(0, room_capacity * max(1, int(booking.get("number_of_rooms") or 1)) - 1)
    existing = await BookingAdditionalGuestRepository.list_for_booking(booking_id)
    if len(existing) >= capacity:
        raise HTTPException(
            status_code=400,
            detail=f"Room capacity reached ({capacity + 1} guests maximum).",
        )
    position = await BookingAdditionalGuestRepository.next_position(booking_id)
    payload = data.model_dump(exclude_unset=True)
    _validate_room_position(booking, payload.get("room_position"))
    guest = await BookingAdditionalGuestRepository.create(
        booking_id=booking_id,
        hotel_id=hotel_id,
        position=position,
        data=payload,
    )
    plan = await fetch_guest_contact_plan(hotel_id)
    return _guest_to_response(
        guest,
        guest_contact_visible=guest_contacts_are_visible(booking, plan),
    )


@router.patch(
    "/bookings/{booking_id}/additional-guests/{guest_id}",
    response_model=BookingAdditionalGuestResponse,
)
async def update_additional_guest(
    booking_id: str,
    guest_id: str,
    data: BookingAdditionalGuestPayload,
    user_id: str = Depends(require_hotel_admin),
):
    booking, hotel_id = await _booking_owned_by_hotel(booking_id, user_id)
    existing = await BookingAdditionalGuestRepository.get_by_id(guest_id)
    if (
        not existing
        or str(existing["booking_id"]) != booking_id
        or str(existing["hotel_id"]) != hotel_id
    ):
        raise HTTPException(status_code=404, detail="Guest not found")
    payload = data.model_dump(exclude_unset=True)
    if "room_position" in payload:
        _validate_room_position(booking, payload["room_position"])
    plan = await fetch_guest_contact_plan(hotel_id)
    if not guest_contacts_are_visible(booking, plan):
        payload.pop("email", None)
        payload.pop("phone", None)
    updated = await BookingAdditionalGuestRepository.update(guest_id, payload)
    return _guest_to_response(
        updated,
        guest_contact_visible=guest_contacts_are_visible(booking, plan),
    )


@router.delete("/bookings/{booking_id}/additional-guests/{guest_id}", status_code=204)
async def delete_additional_guest(
    booking_id: str,
    guest_id: str,
    user_id: str = Depends(require_hotel_admin),
):
    _, hotel_id = await _booking_owned_by_hotel(booking_id, user_id)
    existing = await BookingAdditionalGuestRepository.get_by_id(guest_id)
    if (
        not existing
        or str(existing["booking_id"]) != booking_id
        or str(existing["hotel_id"]) != hotel_id
    ):
        raise HTTPException(status_code=404, detail="Guest not found")
    await BookingAdditionalGuestRepository.delete(guest_id)


@router.post("/bookings/{booking_id}/cancel", response_model=BookingAdminResponse)
async def cancel_booking_with_reason(
    booking_id: str,
    data: CancelBookingRequest,
    user_id: str = Depends(require_hotel_admin),
):
    """Reason-required cancel (VAY-495). Internally records the reason as a
    booking note then defers to the existing status-update path so the
    Channex availability push + guest email side effects stay identical."""
    reason = data.reason.strip()
    if not reason:
        raise HTTPException(status_code=400, detail="A cancellation reason is required")

    booking, hotel_id = await _booking_owned_by_hotel(booking_id, user_id)
    if booking["status"] == "cancelled":
        raise HTTPException(status_code=400, detail="Booking is already cancelled")

    user = await AuthDatabase.fetchrow("SELECT name, email FROM users WHERE id = $1", user_id)
    author_name = (user["name"] if user else None) or (user["email"] if user else None) or ""
    await BookingNoteRepository.create(
        booking_id=booking_id,
        hotel_id=hotel_id,
        author_user_id=user_id,
        author_name=author_name,
        body=f"Cancellation reason: {reason}",
        source="booking-detail",
    )

    await BookingRepository.cancel_with_promo_reversal(booking_id)
    updated = await BookingRepository.get_by_id(booking_id)

    asyncio.create_task(
        push_availability_for_room_type(
            hotel_id,
            str(booking["room_type_id"]),
            start_date=booking["check_in"],
            end_date=booking["check_out"],
        )
    )
    asyncio.create_task(send_guest_cancellation(updated["guest_email"], updated))
    if booking.get("room_id"):
        asyncio.create_task(
            try_place_unassigned_after_cancellation(
                hotel_id,
                str(booking["room_type_id"]),
                booking["check_in"],
                booking["check_out"],
            )
        )

    return await _admin_response(updated)


@router.post("/bookings/{booking_id}/no-show", response_model=BookingAdminResponse)
async def mark_booking_no_show(
    booking_id: str,
    user_id: str = Depends(require_hotel_admin),
):
    """VAY-560: Mark a confirmed booking as no-show when the guest never arrived."""
    booking, hotel_id = await _booking_owned_by_hotel(booking_id, user_id)

    if booking["status"] != "confirmed":
        raise HTTPException(
            status_code=400,
            detail="Only confirmed bookings (never checked in) can be marked as no-show",
        )

    check_out = booking["check_out"]
    if isinstance(check_out, str):
        check_out = date.fromisoformat(check_out)
    if check_out > date.today():
        raise HTTPException(
            status_code=400,
            detail="Cannot mark future departure as no-show",
        )

    await BookingRepository.update_status(booking_id, "no_show")
    updated = await BookingRepository.get_by_id(booking_id)

    asyncio.create_task(
        push_availability_for_room_type(
            hotel_id,
            str(booking["room_type_id"]),
            start_date=booking["check_in"],
            end_date=booking["check_out"],
        )
    )
    if booking.get("room_id"):
        asyncio.create_task(
            try_place_unassigned_after_cancellation(
                hotel_id,
                str(booking["room_type_id"]),
                booking["check_in"],
                booking["check_out"],
            )
        )
    # Guest notification intentionally omitted: marking no-show is an
    # operational staff action, not a status change the guest needs to know about.
    await BookingEventRepository.record(
        booking_id=booking_id,
        hotel_id=hotel_id,
        event_type="guest_no_show",
        payload={},
        actor_user_id=user_id,
    )

    return await _admin_response(updated)


# ── Payouts ───────────────────────────────────────────────────────


@router.get("/payouts")
async def list_payouts(
    status: str | None = Query(None),
    limit: int = Query(50, ge=1, le=500),
    offset: int = Query(0, ge=0),
    user_id: str = Depends(require_hotel_admin),
):
    hotel_id = await get_hotel_id(user_id)
    payouts = await PayoutRepository.list_by_hotel(
        hotel_id, status=status, limit=limit, offset=offset
    )
    total = await PayoutRepository.count_by_hotel(hotel_id, status=status)
    return {
        "payouts": [
            PayoutResponse(
                id=str(p["id"]),
                booking_id=str(p["booking_id"]),
                booking_reference=p.get("booking_reference"),
                recipient_type=p["recipient_type"],
                amount=float(p["amount"]),
                currency=p["currency"],
                status=p["status"],
                scheduled_for=p["scheduled_for"].isoformat(),
                completed_at=p["completed_at"].isoformat() if p.get("completed_at") else None,
            ).model_dump(by_alias=True)
            for p in payouts
        ],
        "total": total,
        "limit": limit,
        "offset": offset,
    }
