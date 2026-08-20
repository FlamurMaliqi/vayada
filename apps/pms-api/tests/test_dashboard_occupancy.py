from datetime import UTC, date, datetime

from app.services.availability_service import occupancy_for_range

NOW = datetime(2026, 6, 24, 12, tzinfo=UTC)


def room_type(room_type_id="type-1", **overrides):
    value = {
        "id": room_type_id,
        "is_active": True,
        "base_rate": 100,
        "daily_rates": {},
        "seasons": [],
        "operating_periods": [],
        "minimum_advance_days": 0,
    }
    value.update(overrides)
    return value


def room(room_id, *, room_type_id="type-1", status="available"):
    return {"id": room_id, "room_type_id": room_type_id, "status": status}


def booking(
    booking_id,
    room_id=None,
    *,
    room_type_id="type-1",
    check_in=date(2026, 6, 24),
    check_out=date(2026, 6, 26),
    status="confirmed",
    number_of_rooms=1,
):
    return {
        "id": booking_id,
        "room_type_id": room_type_id,
        "room_id": room_id,
        "check_in": check_in,
        "check_out": check_out,
        "status": status,
        "number_of_rooms": number_of_rooms,
    }


def occupancy(
    *,
    start=date(2026, 6, 24),
    end=date(2026, 6, 25),
    room_types=None,
    rooms=None,
    bookings=None,
    extra_rooms=None,
    blocks=None,
    drafts=None,
    hotel=None,
    calendar_settings=None,
    now=NOW,
):
    return occupancy_for_range(
        start=start,
        end=end,
        room_types=room_types if room_types is not None else [room_type()],
        rooms=rooms or [],
        bookings=bookings or [],
        extra_rooms=extra_rooms or [],
        blocks=blocks or [],
        drafts=drafts or [],
        hotel=hotel or {"timezone": "UTC", "same_day_bookings_enabled": True},
        calendar_settings=calendar_settings,
        now=now,
    )


def test_checkout_exclusive_turnover_and_distinct_multi_room_units():
    days = occupancy(
        start=date(2026, 6, 25),
        end=date(2026, 6, 26),
        rooms=[room("room-1"), room("room-2"), room("room-3")],
        bookings=[
            booking(
                "departing",
                "room-1",
                check_in=date(2026, 6, 23),
                check_out=date(2026, 6, 25),
            ),
            booking(
                "arriving",
                "room-1",
                check_in=date(2026, 6, 25),
                check_out=date(2026, 6, 27),
            ),
            booking("multi", "room-2", number_of_rooms=2),
            booking("duplicate", "room-3"),
        ],
        extra_rooms=[{"booking_id": "multi", "room_id": "room-3", "position": 1}],
    )

    assert len(days) == 1
    assert days[0].occupied_units == 3
    assert days[0].remaining_sellable_units == 0
    assert days[0].denominator_units == 3
    assert days[0].percentage == 100


def test_unavailable_and_blocked_rooms_leave_sellable_inventory_but_occupied_ooo_counts():
    day = occupancy(
        rooms=[
            room("room-1"),
            room("room-2"),
            room("room-3", status="out_of_order"),
            room("room-4"),
            room("room-5"),
        ],
        bookings=[booking("occupied", "room-3"), booking("pending", "room-4", status="pending")],
        blocks=[
            {
                "room_type_id": "type-1",
                "room_id": "room-1",
                "start_date": date(2026, 6, 24),
                "end_date": date(2026, 6, 25),
                "blocked_count": 1,
            },
            {
                "room_type_id": "type-1",
                "room_id": None,
                "start_date": date(2026, 6, 24),
                "end_date": date(2026, 6, 25),
                "blocked_count": 1,
            },
        ],
    )[0]

    assert day.occupied_units == 1
    assert day.remaining_sellable_units == 1
    assert day.denominator_units == 2
    assert day.percentage == 50


def test_active_drafts_consume_inventory_and_ineligible_stays_do_not_count():
    day = occupancy(
        rooms=[room("room-1"), room("room-2"), room("room-3")],
        bookings=[
            booking("confirmed", "room-1"),
            booking("cancelled", "room-2", status="cancelled"),
            booking("declined", None, status="declined"),
            booking("expired", None, status="expired"),
        ],
        drafts=[
            {
                "room_type_id": "type-1",
                "check_in": date(2026, 6, 24),
                "check_out": date(2026, 6, 25),
                "number_of_rooms": 1,
            }
        ],
    )[0]

    assert day.occupied_units == 1
    assert day.remaining_sellable_units == 1
    assert day.denominator_units == 2
    assert day.percentage == 50


def test_overbooking_is_100_by_construction_instead_of_clamping():
    day = occupancy(
        rooms=[room("room-1")],
        bookings=[booking("one"), booking("two")],
    )[0]

    assert day.occupied_units == 2
    assert day.remaining_sellable_units == 0
    assert day.denominator_units == 2
    assert day.percentage == 100


def test_property_local_cutoff_and_existing_sellability_rules_remove_free_rooms():
    instant = datetime(2026, 6, 24, 17, 30, tzinfo=UTC)  # June 25 in Asia/Makassar
    days = occupancy(
        start=date(2026, 6, 25),
        end=date(2026, 6, 27),
        rooms=[room("room-1")],
        hotel={"timezone": "Asia/Makassar", "same_day_bookings_enabled": False},
        now=instant,
    )

    assert days[0].date == date(2026, 6, 25)
    assert days[0].denominator_units == 0
    assert days[0].percentage is None
    assert days[1].remaining_sellable_units == 1

    closed_cases = [
        {"room_types": [room_type(base_rate=0)]},
        {"room_types": [room_type(minimum_advance_days=1)]},
        {"room_types": [room_type(operating_periods=[{"from": "07-01", "to": "07-31"}])]},
        {
            "calendar_settings": {
                "calendar_auto_open_enabled": True,
                "calendar_auto_open_through": date(2026, 6, 23),
            }
        },
    ]
    for case in closed_cases:
        closed = occupancy(rooms=[room("room-1")], **case)[0]
        assert closed.denominator_units == 0


def test_inactive_types_have_no_free_inventory_but_an_occupied_unit_remains_visible():
    day = occupancy(
        room_types=[room_type(is_active=False)],
        rooms=[room("room-1")],
        bookings=[booking("occupied", "room-1")],
    )[0]

    assert day.occupied_units == 1
    assert day.remaining_sellable_units == 0
    assert day.denominator_units == 1
    assert day.percentage == 100
