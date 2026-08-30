import logging
from datetime import date, timedelta

from fastapi import APIRouter, HTTPException, Query

from app.database import Database
from app.models.room_type import RoomTypeResponse, UnavailableDatesResponse
from app.repositories.hotel_repo import HotelRepository
from app.repositories.linked_inventory_group_repo import LinkedInventoryGroupRepository
from app.repositories.room_type_repo import RoomTypeRepository
from app.services.calendar_auto_open_service import has_sellable_rate_on_date, is_date_auto_open
from app.services.room_type_service import get_hotel_id_by_slug, get_rooms_for_guest
from app.services.same_day_booking import is_same_day_booking_closed, property_today

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/hotels", tags=["rooms"])


@router.get("/{slug}/rooms", response_model=list[RoomTypeResponse])
async def get_rooms(
    slug: str,
    check_in: date | None = Query(None),
    check_out: date | None = Query(None),
    adults: int | None = Query(None),
    children: int | None = Query(None),
):
    try:
        rooms = await get_rooms_for_guest(slug, check_in, check_out, adults, children)
    except Exception as e:
        logger.error("Error fetching rooms for %s: %s", slug, e)
        raise HTTPException(status_code=500, detail="Internal server error") from e
    return rooms


@router.get("/{slug}/unavailable-dates", response_model=UnavailableDatesResponse)
async def get_unavailable_dates(
    slug: str,
    start: date = Query(...),
    end: date = Query(...),
):
    """Return dates where ALL room types are fully booked, plus per-arrival
    stay-length constraints across the active rooms in the requested range.

    `min_stay_by_arrival` only includes arrival dates where the smallest
    available room min-stay is greater than 1 — clients can default to 1
    for any date not present in the map.

    `max_stay_by_arrival` only includes arrival dates where every available
    room type has a maximum stay. Clients can treat missing dates as unlimited.
    """
    hotel_id = await get_hotel_id_by_slug(slug)
    if not hotel_id:
        return UnavailableDatesResponse()

    hotel_row = await Database.fetchrow(
        "SELECT timezone, same_day_bookings_enabled, same_day_booking_cutoff_time "
        "FROM hotels WHERE id = $1",
        hotel_id,
    )
    hotel = dict(hotel_row) if hotel_row else None
    rooms = await RoomTypeRepository.list_by_hotel_id(hotel_id, active_only=True)
    if not rooms:
        return UnavailableDatesResponse()

    calendar_settings = await HotelRepository.get_calendar_settings(hotel_id)
    seasons_by_room = {str(r["id"]): RoomTypeRepository._parse_seasons(r) for r in rooms}

    hotel_timezone = hotel.get("timezone") if hotel else None
    today = property_today(hotel_timezone)
    unavailable = []
    min_stay_by_arrival: dict[str, int] = {}
    max_stay_by_arrival: dict[str, int] = {}
    current = start
    while current < end:
        next_day = current + timedelta(days=1)
        if hotel and is_same_day_booking_closed(
            current,
            same_day_bookings_enabled=bool(hotel.get("same_day_bookings_enabled", True)),
            same_day_booking_cutoff_time=hotel.get("same_day_booking_cutoff_time"),
            timezone=hotel_timezone,
        ):
            unavailable.append(current.isoformat())
            current = next_day
            continue
        all_full = True
        days_until = (current - today).days
        eligible_min_stays: list[int] = []
        eligible_max_stays: list[int | None] = []
        for room in rooms:
            total = room["total_rooms"]
            if not is_date_auto_open(calendar_settings, current):
                continue
            if not has_sellable_rate_on_date(room, current):
                continue  # not operating = skip, don't count as available
            # Check minimum advance days requirement
            min_advance = room.get("minimum_advance_days") or 0
            if min_advance > 0 and days_until < min_advance:
                continue  # too soon for this room type, skip
            if await LinkedInventoryGroupRepository.has_activity(
                str(room["id"]), current, next_day
            ):
                continue
            booked = await RoomTypeRepository.count_booked(str(room["id"]), current, next_day)
            blocked = await RoomTypeRepository.count_blocked(str(room["id"]), current, next_day)
            remaining = total - booked - blocked
            if remaining > 0:
                all_full = False
                room_min = (
                    RoomTypeRepository._find_season_min_stay(
                        seasons_by_room[str(room["id"])], current
                    )
                    or 1
                )
                eligible_min_stays.append(room_min)
                room_max = RoomTypeRepository._find_arrival_max_stay(
                    seasons_by_room[str(room["id"])], current
                )
                eligible_max_stays.append(room_max)
        if all_full:
            unavailable.append(current.isoformat())
        elif eligible_min_stays:
            lowest = min(eligible_min_stays)
            if lowest > 1:
                min_stay_by_arrival[current.isoformat()] = lowest
            if eligible_max_stays and all(max_stay is not None for max_stay in eligible_max_stays):
                max_stay_by_arrival[current.isoformat()] = max(
                    max_stay for max_stay in eligible_max_stays if max_stay is not None
                )
        current = next_day

    return UnavailableDatesResponse(
        dates=unavailable,
        min_stay_by_arrival=min_stay_by_arrival,
        max_stay_by_arrival=max_stay_by_arrival,
    )
