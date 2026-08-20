import logging
from datetime import date

from fastapi import APIRouter, Depends, HTTPException, Query

from app.dependencies import require_hotel_admin
from app.models.calendar import (
    CalendarBlock,
    CalendarBooking,
    CalendarOccupancyDay,
    CalendarResponse,
    CalendarRoom,
    CalendarRoomType,
)
from app.models.room import RoomCreate, RoomReorder, RoomResponse, RoomUpdate
from app.repositories.booking_draft_repo import BookingDraftRepository
from app.repositories.booking_repo import BookingRepository
from app.repositories.booking_room_repo import BookingRoomRepository
from app.repositories.hotel_repo import HotelRepository
from app.repositories.room_block_repo import RoomBlockRepository
from app.repositories.room_repo import RoomRepository
from app.repositories.room_type_repo import RoomTypeRepository
from app.services.availability_service import occupancy_for_range
from app.utils import get_hotel_id, parse_jsonb

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/admin", tags=["admin-rooms"])
MAX_CALENDAR_RANGE_DAYS = 182


def _room_to_response(r: dict) -> RoomResponse:
    return RoomResponse(
        id=str(r["id"]),
        hotel_id=str(r["hotel_id"]),
        room_type_id=str(r["room_type_id"]),
        room_type_name=r["room_type_name"],
        room_number=r["room_number"],
        floor=r["floor"],
        status=r["status"],
        sort_order=r["sort_order"],
        created_at=r["created_at"].isoformat(),
        updated_at=r["updated_at"].isoformat(),
    )


@router.get("/rooms", response_model=list[RoomResponse])
async def list_rooms(user_id: str = Depends(require_hotel_admin)):
    hotel_id = await get_hotel_id(user_id)
    rooms = await RoomRepository.list_by_hotel_id(hotel_id)
    return [_room_to_response(r) for r in rooms]


@router.post("/rooms", response_model=RoomResponse, status_code=201)
async def create_room(
    data: RoomCreate,
    user_id: str = Depends(require_hotel_admin),
):
    hotel_id = await get_hotel_id(user_id)

    # Validate room type belongs to hotel
    room_type = await RoomTypeRepository.get_by_id(data.room_type_id)
    if not room_type or str(room_type["hotel_id"]) != hotel_id:
        raise HTTPException(status_code=404, detail="Room type not found")

    if data.status not in ("available", "maintenance", "out_of_order"):
        raise HTTPException(
            status_code=400,
            detail="Status must be 'available', 'maintenance', or 'out_of_order'",
        )

    try:
        room = await RoomRepository.create(
            {
                "hotel_id": hotel_id,
                "room_type_id": data.room_type_id,
                "room_number": data.room_number,
                "floor": data.floor,
                "status": data.status,
                "sort_order": data.sort_order,
            }
        )
    except Exception as e:
        raise HTTPException(
            status_code=409,
            detail="A room with this number already exists",
        ) from e
    return _room_to_response(room)


@router.patch("/rooms/reorder", status_code=204)
async def reorder_rooms(
    data: RoomReorder,
    user_id: str = Depends(require_hotel_admin),
):
    """Persist a new vertical room order for the PMS Calendar (VAY-307).

    Rejects partial lists — caller must send all of the hotel's room
    IDs to keep the per-property order globally consistent. Order is
    saved per property; nothing is stored per user.
    """
    hotel_id = await get_hotel_id(user_id)

    if not data.ordered_room_ids:
        raise HTTPException(status_code=400, detail="orderedRoomIds is required")

    if len(set(data.ordered_room_ids)) != len(data.ordered_room_ids):
        raise HTTPException(status_code=400, detail="orderedRoomIds contains duplicates")

    existing_rooms = await RoomRepository.list_by_hotel_id(hotel_id)
    existing_ids = {str(r["id"]) for r in existing_rooms}
    submitted_ids = set(data.ordered_room_ids)
    if submitted_ids != existing_ids:
        raise HTTPException(
            status_code=400,
            detail="orderedRoomIds must contain every room of this hotel exactly once",
        )

    pairs = [(rid, idx + 1) for idx, rid in enumerate(data.ordered_room_ids)]
    await RoomRepository.bulk_set_sort_order(hotel_id, pairs)


@router.patch("/rooms/{room_id}", response_model=RoomResponse)
async def update_room(
    room_id: str,
    data: RoomUpdate,
    user_id: str = Depends(require_hotel_admin),
):
    hotel_id = await get_hotel_id(user_id)
    existing = await RoomRepository.get_by_id(room_id)
    if not existing or str(existing["hotel_id"]) != hotel_id:
        raise HTTPException(status_code=404, detail="Room not found")

    updates = data.model_dump(exclude_unset=True)
    if "status" in updates and updates["status"] not in (
        "available",
        "maintenance",
        "out_of_order",
    ):
        raise HTTPException(
            status_code=400,
            detail="Status must be 'available', 'maintenance', or 'out_of_order'",
        )

    room = await RoomRepository.update(room_id, updates)
    return _room_to_response(room)


@router.delete("/rooms/{room_id}", status_code=204)
async def delete_room(
    room_id: str,
    user_id: str = Depends(require_hotel_admin),
):
    hotel_id = await get_hotel_id(user_id)
    existing = await RoomRepository.get_by_id(room_id)
    if not existing or str(existing["hotel_id"]) != hotel_id:
        raise HTTPException(status_code=404, detail="Room not found")

    try:
        await RoomRepository.delete(room_id)
    except Exception as e:
        raise HTTPException(
            status_code=409,
            detail="Cannot delete room with existing bookings",
        ) from e


@router.get("/calendar", response_model=CalendarResponse)
async def get_calendar(
    start: date = Query(...),
    end: date = Query(...),
    user_id: str = Depends(require_hotel_admin),
):
    range_days = (end - start).days
    if range_days <= 0 or range_days > MAX_CALENDAR_RANGE_DAYS:
        raise HTTPException(
            status_code=422,
            detail=f"Calendar range must be between 1 and {MAX_CALENDAR_RANGE_DAYS} days",
        )

    hotel_id = await get_hotel_id(user_id)
    room_types = await RoomTypeRepository.list_by_hotel_id(hotel_id)
    rooms = await RoomRepository.list_by_hotel_id(hotel_id)
    bookings = await BookingRepository.list_by_hotel_in_range(hotel_id, start, end)
    blocks = await RoomBlockRepository.list_by_hotel_in_range(hotel_id, start, end)
    drafts = await BookingDraftRepository.list_active_by_hotel_in_range(hotel_id, start, end)
    hotel = await HotelRepository.get_by_id(hotel_id)
    calendar_settings = await HotelRepository.get_calendar_settings(hotel_id)

    # VAY-403: multi-room bookings occupy more than the primary room. Pull
    # every booking's extra rooms in one batched query and emit an extra
    # calendar entry per room so each one is blocked on the grid, not just
    # the first. Entries share the booking id + reference so the frontend
    # can render them as one linked reservation.
    extra_rows = await BookingRoomRepository.list_extra_rooms_for_bookings(
        [str(b["id"]) for b in bookings]
    )
    extras_by_booking: dict[str, list] = {}
    for er in extra_rows:
        extras_by_booking.setdefault(str(er["booking_id"]), []).append(er)

    occupancy_days = occupancy_for_range(
        start=start,
        end=end,
        room_types=room_types,
        rooms=rooms,
        bookings=bookings,
        extra_rooms=extra_rows,
        blocks=blocks,
        drafts=drafts,
        hotel=hotel,
        calendar_settings=calendar_settings,
    )

    def _calendar_entries(b: dict) -> list[CalendarBooking]:
        n_rooms = int(b.get("number_of_rooms") or 1)
        entries = [
            CalendarBooking(
                id=str(b["id"]),
                room_type_id=str(b["room_type_id"]),
                room_name=b["room_name"],
                guest_first_name=b["guest_first_name"],
                guest_last_name=b["guest_last_name"],
                check_in=str(b["check_in"]),
                check_out=str(b["check_out"]),
                status=b["status"],
                room_id=str(b["room_id"]) if b.get("room_id") else None,
                room_number=b.get("room_number"),
                channel=b.get("channel", "direct") or "direct",
                booking_reference=b["booking_reference"],
                number_of_rooms=n_rooms,
                room_position=0,
            )
        ]
        for er in extras_by_booking.get(str(b["id"]), []):
            entries.append(
                CalendarBooking(
                    id=str(b["id"]),
                    room_type_id=str(b["room_type_id"]),
                    room_name=b["room_name"],
                    guest_first_name=b["guest_first_name"],
                    guest_last_name=b["guest_last_name"],
                    check_in=str(b["check_in"]),
                    check_out=str(b["check_out"]),
                    status=b["status"],
                    room_id=str(er["room_id"]),
                    room_number=er.get("room_number"),
                    channel=b.get("channel", "direct") or "direct",
                    booking_reference=b["booking_reference"],
                    number_of_rooms=n_rooms,
                    room_position=er["position"],
                )
            )
        return entries

    return CalendarResponse(
        room_types=[
            CalendarRoomType(
                id=str(rt["id"]),
                name=rt["name"],
                category=rt.get("category", "") or "",
                total_rooms=rt["total_rooms"],
                base_rate=float(rt["base_rate"]),
                max_occupancy=rt.get("max_occupancy", 2),
                currency=rt["currency"],
                seasons=parse_jsonb(rt.get("seasons", [])),
            )
            for rt in room_types
        ],
        rooms=[
            CalendarRoom(
                id=str(r["id"]),
                room_type_id=str(r["room_type_id"]),
                room_type_name=r["room_type_name"],
                room_number=r["room_number"],
                floor=r["floor"],
                status=r["status"],
            )
            for r in rooms
        ],
        bookings=[entry for b in bookings for entry in _calendar_entries(b)],
        blocks=[
            CalendarBlock(
                id=str(bl["id"]),
                room_type_id=str(bl["room_type_id"]),
                room_id=str(bl["room_id"]) if bl.get("room_id") else None,
                room_number=bl.get("room_number"),
                start_date=str(bl["start_date"]),
                end_date=str(bl["end_date"]),
                blocked_count=bl["blocked_count"],
                reason=bl["reason"],
                created_at=bl["created_at"].isoformat(),
            )
            for bl in blocks
        ],
        occupancy_days=[
            CalendarOccupancyDay(
                date=str(day.date),
                occupied_units=day.occupied_units,
                remaining_sellable_units=day.remaining_sellable_units,
                denominator_units=day.denominator_units,
                percentage=day.percentage,
            )
            for day in occupancy_days
        ],
    )
