"""Stay-level availability + pricing primitives.

These wrap ``RoomTypeRepository.count_booked`` / ``count_blocked`` /
``resolve_rate`` so the same rules apply consistently in booking creation
and the guest-facing rooms endpoint. Per-day scans (room blocks,
unavailable-dates, channex availability push) keep their own loops because
each one needs distinct loop-body logic (operating periods, exclude-block,
local-only blocks).
"""

from dataclasses import dataclass
from datetime import date, datetime, timedelta

from app.repositories.booking_draft_repo import BookingDraftRepository
from app.repositories.room_type_repo import RoomTypeRepository
from app.services.calendar_auto_open_service import has_sellable_rate_on_date, is_date_auto_open
from app.services.same_day_booking import is_same_day_booking_closed, property_today


@dataclass
class StayPricing:
    nightly_rates: list[float]
    room_total: float
    average_nightly_rate: float


@dataclass(frozen=True)
class NightOccupancy:
    date: date
    occupied_units: int
    remaining_sellable_units: int

    @property
    def denominator_units(self) -> int:
        return self.occupied_units + self.remaining_sellable_units

    @property
    def percentage(self) -> int | None:
        denominator = self.denominator_units
        if denominator == 0:
            return None
        percentage = (self.occupied_units * 100 + denominator // 2) // denominator
        if percentage > 100:
            raise ValueError(
                f"Invalid occupancy on {self.date}: {self.occupied_units}/{denominator}"
            )
        return percentage


_INVENTORY_STATUSES = {"pending", "confirmed", "checked_in", "in_house"}
_OCCUPIED_STATUSES = {"confirmed", "checked_in", "in_house"}


def occupancy_for_range(
    *,
    start: date,
    end: date,
    room_types: list[dict],
    rooms: list[dict],
    bookings: list[dict],
    extra_rooms: list[dict],
    blocks: list[dict],
    drafts: list[dict],
    hotel: dict | None,
    calendar_settings: dict | None,
    now: datetime | None = None,
) -> list[NightOccupancy]:
    """Build the dashboard's occupied + still-sellable inventory per night.

    Physical rooms are the base inventory. Maintenance/out-of-order rooms are
    excluded while occupied units remain visible. Existing booking-engine
    predicates decide whether otherwise-free inventory is sellable.
    """
    if start >= end:
        return []

    room_types_by_id = {str(room_type["id"]): room_type for room_type in room_types}
    available_room_ids: dict[str, set[str]] = {}
    for room in rooms:
        room_type_id = str(room["room_type_id"])
        room_type = room_types_by_id.get(room_type_id)
        if room["status"] != "available" or not room_type or not room_type.get("is_active", True):
            continue
        available_room_ids.setdefault(room_type_id, set()).add(str(room["id"]))

    extras_by_booking: dict[str, dict[int, str]] = {}
    for extra in extra_rooms:
        extras_by_booking.setdefault(str(extra["booking_id"]), {})[int(extra["position"])] = str(
            extra["room_id"]
        )

    timezone = hotel.get("timezone") if hotel else None
    today = property_today(timezone, now=now)
    result: list[NightOccupancy] = []
    current = start
    while current < end:
        next_day = current + timedelta(days=1)
        same_day_closed = bool(
            hotel
            and is_same_day_booking_closed(
                current,
                same_day_bookings_enabled=bool(hotel.get("same_day_bookings_enabled", True)),
                same_day_booking_cutoff_time=hotel.get("same_day_booking_cutoff_time"),
                timezone=timezone,
                now=now,
            )
        )
        remaining_by_type: dict[str, set[str]] = {}
        for room_type_id, room_ids in available_room_ids.items():
            room_type = room_types_by_id[room_type_id]
            min_advance = int(room_type.get("minimum_advance_days") or 0)
            is_sellable = (
                not same_day_closed
                and (current - today).days >= min_advance
                and is_date_auto_open(calendar_settings, current)
                and has_sellable_rate_on_date(room_type, current)
            )
            remaining_by_type[room_type_id] = set(room_ids) if is_sellable else set()

        type_block_counts: dict[str, int] = {}
        for block in blocks:
            if block["start_date"] >= next_day or block["end_date"] <= current:
                continue
            room_type_id = str(block["room_type_id"])
            if block.get("room_id"):
                remaining_by_type.get(room_type_id, set()).discard(str(block["room_id"]))
            else:
                type_block_counts[room_type_id] = type_block_counts.get(room_type_id, 0) + int(
                    block.get("blocked_count") or 1
                )

        occupied_keys: set[str] = set()
        unassigned_consumed: dict[str, int] = {}
        for booking in bookings:
            status = booking["status"]
            if (
                status not in _INVENTORY_STATUSES
                or booking["check_in"] >= next_day
                or booking["check_out"] <= current
            ):
                continue
            booking_id = str(booking["id"])
            room_type_id = str(booking["room_type_id"])
            positions = extras_by_booking.get(booking_id, {}).copy()
            if booking.get("room_id"):
                positions[0] = str(booking["room_id"])
            number_of_rooms = max(int(booking.get("number_of_rooms") or 1), 1)
            for position in range(number_of_rooms):
                room_id = positions.get(position)
                unit_key = f"room:{room_id}" if room_id else f"booking:{booking_id}:{position}"
                if status in _OCCUPIED_STATUSES:
                    occupied_keys.add(unit_key)
                if room_id:
                    remaining_by_type.get(room_type_id, set()).discard(room_id)
                else:
                    unassigned_consumed[room_type_id] = unassigned_consumed.get(room_type_id, 0) + 1

        draft_counts: dict[str, int] = {}
        for draft in drafts:
            if draft["check_in"] >= next_day or draft["check_out"] <= current:
                continue
            room_type_id = str(draft["room_type_id"])
            draft_counts[room_type_id] = draft_counts.get(room_type_id, 0) + int(
                draft.get("number_of_rooms") or 1
            )

        remaining_sellable = sum(
            max(
                0,
                len(room_ids)
                - type_block_counts.get(room_type_id, 0)
                - unassigned_consumed.get(room_type_id, 0)
                - draft_counts.get(room_type_id, 0),
            )
            for room_type_id, room_ids in remaining_by_type.items()
        )
        result.append(
            NightOccupancy(
                date=current,
                occupied_units=len(occupied_keys),
                remaining_sellable_units=remaining_sellable,
            )
        )
        current = next_day

    return result


def compute_non_refundable_rate(
    room_type: dict, base_rate: float, explicit_rate: float | None
) -> float:
    """Resolve the non-refundable rate for one night from the room config."""
    if not room_type.get("flexible_rate_enabled", True):
        return round(float(base_rate), 2)

    discount = room_type.get("non_refundable_discount")
    if discount is not None:
        discount_pct = float(discount)
        if discount_pct > 0:
            return round(float(base_rate) * (1 - discount_pct / 100), 2)
        if explicit_rate is not None and explicit_rate > 0:
            return round(float(explicit_rate), 2)
        return round(float(base_rate), 2)

    if explicit_rate is not None and explicit_rate > 0:
        return round(float(explicit_rate), 2)

    return round(float(base_rate) * 0.85, 2)


async def remaining_for_stay(
    room_type_id: str,
    total_rooms: int,
    check_in: date,
    check_out: date,
) -> int:
    """Rooms of this type still bookable across the given stay.

    Returns the minimum free inventory across each occupied night, where
    active card-payment drafts (VAY-388) count as soft holds. A room type
    with staggered bookings/blocks across different nights should remain
    bookable as long as every night still has a free unit.
    """
    if check_in >= check_out:
        return 0

    remaining = total_rooms
    current = check_in
    while current < check_out:
        next_day = current + timedelta(days=1)
        booked = await RoomTypeRepository.count_booked(room_type_id, current, next_day)
        blocked = await RoomTypeRepository.count_blocked(room_type_id, current, next_day)
        soft_held = await BookingDraftRepository.count_active_for_stay(
            room_type_id, current, next_day
        )
        remaining = min(remaining, total_rooms - booked - blocked - soft_held)
        current = next_day

    return max(0, remaining)


def compute_stay_pricing(
    room_type: dict,
    check_in: date,
    check_out: date,
    adults: int | None = None,
    rate_type: str = "flexible",
) -> StayPricing:
    """Resolve nightly rates for a stay (seasons, weekend, occupancy,
    daily-rate overrides) and sum into a per-room total.

    Does not apply promo / addon / last-minute discounts — those layer on
    top at the booking level.
    """
    nights = (check_out - check_in).days
    if nights <= 0:
        return StayPricing(nightly_rates=[], room_total=0.0, average_nightly_rate=0.0)

    nightly_rates: list[float] = []
    for i in range(nights):
        night_date = check_in + timedelta(days=i)
        resolved_base, resolved_nr = RoomTypeRepository.resolve_rate(room_type, night_date, adults)
        if rate_type == "nonrefundable":
            night_rate = compute_non_refundable_rate(room_type, resolved_base, resolved_nr)
        else:
            night_rate = resolved_base
        nightly_rates.append(night_rate)

    room_total = round(sum(nightly_rates), 2)
    average = round(room_total / nights, 2)
    return StayPricing(
        nightly_rates=nightly_rates,
        room_total=room_total,
        average_nightly_rate=average,
    )
