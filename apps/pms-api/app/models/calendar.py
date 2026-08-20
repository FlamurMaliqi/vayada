"""Response shape for GET /admin/calendar — the rooms-eye view of bookings,
blocks, and room types over a date range. Frontend expects camelCase keys."""

from pydantic import BaseModel, ConfigDict


def to_camel(string: str) -> str:
    parts = string.split("_")
    return parts[0] + "".join(w.capitalize() for w in parts[1:])


class _CamelModel(BaseModel):
    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True)


class CalendarRoomType(_CamelModel):
    id: str
    name: str
    category: str = ""
    total_rooms: int
    base_rate: float
    max_occupancy: int = 2
    currency: str
    seasons: list[dict] = []


class CalendarRoom(_CamelModel):
    id: str
    room_type_id: str
    room_type_name: str
    room_number: str
    floor: str
    status: str


class CalendarBooking(_CamelModel):
    id: str
    room_type_id: str
    room_name: str
    guest_first_name: str
    guest_last_name: str
    check_in: str
    check_out: str
    status: str
    room_id: str | None = None
    room_number: str | None = None
    channel: str = "direct"
    booking_reference: str
    # VAY-403: a multi-room booking emits one entry per assigned room so
    # every room is blocked. number_of_rooms is the booked quantity;
    # room_position is 0 for the primary room and 1..N-1 for the extras —
    # the frontend groups entries sharing an id/reference as one reservation.
    number_of_rooms: int = 1
    room_position: int = 0


class CalendarBlock(_CamelModel):
    id: str
    room_type_id: str
    room_id: str | None = None
    room_number: str | None = None
    start_date: str
    end_date: str
    blocked_count: int
    reason: str | None = None
    created_at: str


class CalendarOccupancyDay(_CamelModel):
    date: str
    occupied_units: int
    remaining_sellable_units: int
    denominator_units: int
    percentage: int | None = None


class CalendarResponse(_CamelModel):
    room_types: list[CalendarRoomType] = []
    rooms: list[CalendarRoom] = []
    bookings: list[CalendarBooking] = []
    blocks: list[CalendarBlock] = []
    occupancy_days: list[CalendarOccupancyDay] = []
