"""
Tests for GET /admin/calendar endpoint.
"""

from datetime import UTC, datetime, timedelta

from app.database import Database

from tests.conftest import (
    create_test_booking,
    create_test_hotel,
    create_test_room_block,
    create_test_room_type,
    create_test_user,
    get_auth_headers,
)


class TestCalendar:
    async def test_calendar_rejects_unsupported_ranges(self, client, hotel_with_rooms):
        headers = get_auth_headers(hotel_with_rooms["user"]["token"])
        empty = await client.get(
            "/admin/calendar?start=2026-06-01&end=2026-06-01",
            headers=headers,
        )
        too_large = await client.get(
            "/admin/calendar?start=2026-01-01&end=2026-07-03",
            headers=headers,
        )

        assert empty.status_code == 422
        assert too_large.status_code == 422

    async def test_calendar_empty(self, client, cleanup_database):
        """Calendar with no bookings or blocks returns empty lists."""
        user = await create_test_user()
        hotel = await create_test_hotel(str(user["id"]))
        await create_test_room_type(str(hotel["id"]))

        resp = await client.get(
            "/admin/calendar?start=2026-06-01&end=2026-06-30",
            headers=get_auth_headers(user["token"]),
        )
        assert resp.status_code == 200
        body = resp.json()
        assert len(body["roomTypes"]) == 1
        assert body["bookings"] == []
        assert body["blocks"] == []
        assert len(body["occupancyDays"]) == 29
        assert body["occupancyDays"][0]["date"] == "2026-06-01"

    async def test_calendar_with_bookings(self, client, hotel_with_booking):
        """Calendar returns bookings within the date range."""
        user = hotel_with_booking["user"]

        resp = await client.get(
            "/admin/calendar?start=2026-05-01&end=2026-07-01",
            headers=get_auth_headers(user["token"]),
        )
        assert resp.status_code == 200
        body = resp.json()
        assert len(body["bookings"]) == 1
        assert body["bookings"][0]["guestFirstName"] == "John"
        assert body["bookings"][0]["guestLastName"] == "Doe"
        assert "checkIn" in body["bookings"][0]
        assert "checkOut" in body["bookings"][0]
        assert "status" in body["bookings"][0]

    async def test_calendar_bookings_outside_range(self, client, hotel_with_booking):
        """Calendar does not return bookings outside the date range."""
        user = hotel_with_booking["user"]

        resp = await client.get(
            "/admin/calendar?start=2026-01-01&end=2026-01-31",
            headers=get_auth_headers(user["token"]),
        )
        assert resp.status_code == 200
        assert resp.json()["bookings"] == []

    async def test_calendar_excludes_stale_unpaid_pending(self, client, hotel_with_rooms):
        data = hotel_with_rooms
        booking = await create_test_booking(
            str(data["hotel"]["id"]),
            str(data["room"]["id"]),
            check_in="2026-06-10",
            check_out="2026-06-12",
            status="pending",
            payment_status="unpaid",
        )
        await Database.execute(
            "UPDATE bookings SET created_at = NOW() - INTERVAL '31 minutes' WHERE id = $1",
            booking["id"],
        )

        resp = await client.get(
            "/admin/calendar?start=2026-06-01&end=2026-07-01",
            headers=get_auth_headers(data["user"]["token"]),
        )

        assert resp.status_code == 200
        assert resp.json()["bookings"] == []

    async def test_calendar_returns_occupancy_projection(self, client, hotel_with_rooms):
        data = hotel_with_rooms
        await Database.execute(
            "UPDATE hotels SET timezone = 'UTC', same_day_booking_cutoff_time = NULL WHERE id = $1",
            data["hotel"]["id"],
        )
        today = datetime.now(UTC).date()
        tomorrow = today + timedelta(days=1)
        booking = await create_test_booking(
            str(data["hotel"]["id"]),
            str(data["room"]["id"]),
            check_in=today.isoformat(),
            check_out=tomorrow.isoformat(),
            status="confirmed",
        )
        await Database.execute(
            "UPDATE bookings SET room_id = $2 WHERE id = $1",
            booking["id"],
            data["rooms"][0]["id"],
        )

        resp = await client.get(
            f"/admin/calendar?start={today}&end={tomorrow}",
            headers=get_auth_headers(data["user"]["token"]),
        )

        assert resp.status_code == 200
        assert resp.json()["occupancyDays"] == [
            {
                "date": today.isoformat(),
                "occupiedUnits": 1,
                "remainingSellableUnits": 4,
                "denominatorUnits": 5,
                "percentage": 20,
            }
        ]

    async def test_calendar_with_room_blocks(self, client, cleanup_database):
        """Calendar returns room blocks within the date range."""
        user = await create_test_user()
        hotel = await create_test_hotel(str(user["id"]))
        room = await create_test_room_type(str(hotel["id"]))
        await create_test_room_block(
            str(hotel["id"]),
            str(room["id"]),
            start_date="2026-07-01",
            end_date="2026-07-05",
            reason="Renovation",
        )

        resp = await client.get(
            "/admin/calendar?start=2026-07-01&end=2026-07-31",
            headers=get_auth_headers(user["token"]),
        )
        assert resp.status_code == 200
        body = resp.json()
        assert len(body["blocks"]) == 1
        assert body["blocks"][0]["reason"] == "Renovation"
        assert body["blocks"][0]["blockedCount"] == 1

    async def test_calendar_room_types_shape(self, client, hotel_with_rooms):
        """Room types include id, name, totalRooms."""
        user = hotel_with_rooms["user"]

        resp = await client.get(
            "/admin/calendar?start=2026-06-01&end=2026-06-30",
            headers=get_auth_headers(user["token"]),
        )
        rt = resp.json()["roomTypes"][0]
        assert "id" in rt
        assert rt["name"] == "Deluxe Suite"
        assert rt["totalRooms"] == 5

    async def test_calendar_requires_auth(self, client):
        resp = await client.get("/admin/calendar?start=2026-06-01&end=2026-06-30")
        assert resp.status_code == 401

    async def test_calendar_requires_dates(self, client, hotel_with_rooms):
        """Missing start/end params → 422."""
        user = hotel_with_rooms["user"]
        resp = await client.get(
            "/admin/calendar",
            headers=get_auth_headers(user["token"]),
        )
        assert resp.status_code == 422

    async def test_calendar_no_hotel(self, client, cleanup_database):
        """User with no hotel → 404."""
        user = await create_test_user()
        resp = await client.get(
            "/admin/calendar?start=2026-06-01&end=2026-06-30",
            headers=get_auth_headers(user["token"]),
        )
        assert resp.status_code == 404
