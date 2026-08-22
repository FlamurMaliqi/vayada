"""
Tests for public /api/hotels/{slug}/bookings endpoints (create + lookup).
"""

from datetime import date, timedelta
from unittest.mock import AsyncMock, patch

import pytest

from tests.conftest import (
    create_test_booking,
    create_test_hotel,
    create_test_payment_settings,
    create_test_room,
    create_test_room_type,
    create_test_user,
)


class TestCreateBooking:
    @patch("app.services.stripe_service.create_payment_intent", new_callable=AsyncMock)
    @patch("app.services.email_service.send_booking_request_notification", new_callable=AsyncMock)
    @patch("app.services.email_service.send_guest_booking_requested", new_callable=AsyncMock)
    async def test_create_booking(
        self, mock_guest_email, mock_host_email, mock_stripe, client, hotel_with_rooms
    ):
        # VAY-388: card-payment requests now produce a soft-hold draft
        # instead of a real booking row. The response carries a draftId
        # and a preview shaped like a booking; the row only appears once
        # Stripe authorizes the card (covered in test_card_draft_flow).
        mock_stripe.return_value = {
            "id": "pi_test_123",
            "client_secret": "pi_test_123_secret_abc",
            "status": "requires_confirmation",
        }
        hotel = hotel_with_rooms["hotel"]
        room = hotel_with_rooms["room"]
        from app.database import Database

        await Database.execute(
            "UPDATE room_types SET max_occupancy = 3, max_children = 1 WHERE id = $1",
            str(room["id"]),
        )
        await create_test_payment_settings(
            str(hotel["id"]),
            stripe_connect_account_id="acct_test_123",
            stripe_connect_onboarded=True,
        )

        resp = await client.post(
            f"/api/hotels/{hotel['slug']}/bookings",
            json={
                "roomTypeId": str(room["id"]),
                "guestFirstName": "Jane",
                "guestLastName": "Smith",
                "guestEmail": "jane@example.com",
                "guestPhone": "+9876543210",
                "checkIn": "2026-08-10",
                "checkOut": "2026-08-15",
                "adults": 2,
                "children": 1,
            },
        )
        assert resp.status_code == 200
        body = resp.json()
        preview = body["booking"]
        assert preview["guestFirstName"] == "Jane"
        assert preview["guestLastName"] == "Smith"
        assert preview["hotelName"] == "Test Hotel"
        assert preview["roomName"] == "Deluxe Suite"
        assert preview["nights"] == 5
        assert preview["nightlyRate"] == 150.0
        assert preview["totalAmount"] == 750.0
        assert preview["status"] == "draft"
        assert preview["bookingReference"].startswith("VAY-")
        assert body["clientSecret"] == "pi_test_123_secret_abc"
        assert body["paymentMethod"] == "card"
        assert body["draftId"]
        assert body["bookingReference"] == preview["bookingReference"]

        # And critically: no booking row exists yet, so inventory is not
        # blocked beyond the soft-hold the draft provides.
        booking_count = await Database.fetchval(
            "SELECT COUNT(*) FROM bookings WHERE hotel_id = $1",
            str(hotel["id"]),
        )
        assert booking_count == 0
        draft_count = await Database.fetchval(
            "SELECT COUNT(*) FROM booking_drafts WHERE hotel_id = $1",
            str(hotel["id"]),
        )
        assert draft_count == 1

    async def test_create_booking_invalid_room(self, client, hotel_with_rooms):
        hotel = hotel_with_rooms["hotel"]

        resp = await client.post(
            f"/api/hotels/{hotel['slug']}/bookings",
            json={
                "roomTypeId": "00000000-0000-0000-0000-000000000000",
                "guestFirstName": "Test",
                "guestLastName": "User",
                "guestEmail": "test@example.com",
                "guestPhone": "+1234",
                "checkIn": "2026-08-10",
                "checkOut": "2026-08-15",
            },
        )
        assert resp.status_code == 400

    async def test_create_booking_rejects_invalid_guest_mix(self, client, cleanup_database):
        user = await create_test_user()
        hotel = await create_test_hotel(str(user["id"]))
        room = await create_test_room_type(
            str(hotel["id"]),
            max_occupancy=3,
            max_adults=2,
            max_children=1,
        )

        resp = await client.post(
            f"/api/hotels/{hotel['slug']}/bookings",
            json={
                "roomTypeId": str(room["id"]),
                "guestFirstName": "Test",
                "guestLastName": "User",
                "guestEmail": "test@example.com",
                "guestPhone": "+1234",
                "checkIn": "2026-08-10",
                "checkOut": "2026-08-15",
                "adults": 3,
                "children": 0,
            },
        )
        assert resp.status_code == 400
        assert "occupancy limits" in resp.json()["detail"]

    async def test_create_booking_checkout_before_checkin(self, client, hotel_with_rooms):
        hotel = hotel_with_rooms["hotel"]
        room = hotel_with_rooms["room"]

        resp = await client.post(
            f"/api/hotels/{hotel['slug']}/bookings",
            json={
                "roomTypeId": str(room["id"]),
                "guestFirstName": "Test",
                "guestLastName": "User",
                "guestEmail": "test@example.com",
                "guestPhone": "+1234",
                "checkIn": "2026-08-15",
                "checkOut": "2026-08-10",
            },
        )
        assert resp.status_code == 400

    async def test_create_booking_no_availability(self, client, cleanup_database):
        user = await create_test_user()
        hotel = await create_test_hotel(str(user["id"]))
        room = await create_test_room_type(str(hotel["id"]), total_rooms=1)

        # Book the only room
        await create_test_booking(
            str(hotel["id"]),
            str(room["id"]),
            check_in="2026-08-01",
            check_out="2026-08-05",
        )

        # Try to book overlapping dates
        resp = await client.post(
            f"/api/hotels/{hotel['slug']}/bookings",
            json={
                "roomTypeId": str(room["id"]),
                "guestFirstName": "Second",
                "guestLastName": "Guest",
                "guestEmail": "second@example.com",
                "guestPhone": "+1111",
                "checkIn": "2026-08-02",
                "checkOut": "2026-08-04",
            },
        )
        assert resp.status_code == 400

    @patch("app.services.booking_service.push_availability_for_room_type", new_callable=AsyncMock)
    @patch("app.services.booking_service.send_booking_request_notification", new_callable=AsyncMock)
    async def test_create_booking_allows_checkout_on_sold_out_day(
        self, mock_host_email, mock_push, client, cleanup_database
    ):
        from app.database import Database

        base_date = date.today()
        check_in = (base_date + timedelta(days=30)).isoformat()
        sold_out_date = (base_date + timedelta(days=31)).isoformat()
        check_out = (base_date + timedelta(days=32)).isoformat()
        user = await create_test_user()
        hotel = await create_test_hotel(str(user["id"]))
        room = await create_test_room_type(str(hotel["id"]), total_rooms=1)
        unit = await create_test_room(str(hotel["id"]), str(room["id"]), room_number="101")
        await create_test_payment_settings(str(hotel["id"]), pay_at_property_enabled=True)
        sold_out_night = await create_test_booking(
            str(hotel["id"]),
            str(room["id"]),
            check_in=sold_out_date,
            check_out=check_out,
        )
        await Database.execute(
            "UPDATE bookings SET room_id = $1 WHERE id = $2",
            str(unit["id"]),
            str(sold_out_night["id"]),
        )

        resp = await client.post(
            f"/api/hotels/{hotel['slug']}/bookings",
            json={
                "roomTypeId": str(room["id"]),
                "guestFirstName": "Checkout",
                "guestLastName": "Guest",
                "guestEmail": "checkout@example.com",
                "guestPhone": "+1111",
                "checkIn": check_in,
                "checkOut": sold_out_date,
                "paymentMethod": "pay_at_property",
            },
        )

        assert resp.status_code == 200, resp.text
        booking = resp.json()["booking"]
        assert booking["checkIn"] == check_in
        assert booking["checkOut"] == sold_out_date
        assert booking["nights"] == 1

    @patch("app.services.booking_service.push_availability_for_room_type", new_callable=AsyncMock)
    @patch("app.services.booking_service.send_booking_request_notification", new_callable=AsyncMock)
    async def test_create_booking_allows_auto_rearrange_packable_stay(
        self, mock_host_email, mock_push, client, hotel_with_rooms
    ):
        from app.database import Database

        hotel = hotel_with_rooms["hotel"]
        room = hotel_with_rooms["room"]
        rooms = hotel_with_rooms["rooms"]
        await create_test_payment_settings(str(hotel["id"]), pay_at_property_enabled=True)
        await Database.execute(
            "UPDATE hotels SET auto_rearrange_enabled = TRUE WHERE id = $1",
            hotel["id"],
        )
        request_check_in = date.today() + timedelta(days=30)
        for idx, (check_in_offset, check_out_offset) in enumerate(
            [
                (1, 4),
                (3, 6),
                (0, 2),
                (-1, 1),
                (4, 7),
            ]
        ):
            existing = await create_test_booking(
                str(hotel["id"]),
                str(room["id"]),
                check_in=(request_check_in + timedelta(days=check_in_offset)).isoformat(),
                check_out=(request_check_in + timedelta(days=check_out_offset)).isoformat(),
                status="confirmed",
                guest_email=f"packable-{idx}@example.com",
            )
            await Database.execute(
                "UPDATE bookings SET room_id = $1 WHERE id = $2",
                str(rooms[idx]["id"]),
                str(existing["id"]),
            )

        resp = await client.post(
            f"/api/hotels/{hotel['slug']}/bookings",
            json={
                "roomTypeId": str(room["id"]),
                "guestFirstName": "Packable",
                "guestLastName": "Guest",
                "guestEmail": "packable@example.com",
                "guestPhone": "+1111",
                "checkIn": request_check_in.isoformat(),
                "checkOut": (request_check_in + timedelta(days=5)).isoformat(),
                "paymentMethod": "pay_at_property",
            },
        )

        assert resp.status_code == 200, resp.text
        booking_id = resp.json()["booking"]["id"]
        assigned_room = await Database.fetchval(
            "SELECT room_id FROM bookings WHERE id = $1",
            booking_id,
        )
        assert assigned_room is not None

    async def test_create_booking_unknown_hotel(self, client, init_database):
        resp = await client.post(
            "/api/hotels/nonexistent-hotel/bookings",
            json={
                "roomTypeId": "00000000-0000-0000-0000-000000000000",
                "guestFirstName": "Test",
                "guestLastName": "User",
                "guestEmail": "test@example.com",
                "guestPhone": "+1234",
                "checkIn": "2026-08-10",
                "checkOut": "2026-08-15",
            },
        )
        assert resp.status_code == 400

    async def test_create_booking_inactive_room(self, client, cleanup_database):
        user = await create_test_user()
        hotel = await create_test_hotel(str(user["id"]))
        room = await create_test_room_type(str(hotel["id"]), is_active=False)

        resp = await client.post(
            f"/api/hotels/{hotel['slug']}/bookings",
            json={
                "roomTypeId": str(room["id"]),
                "guestFirstName": "Test",
                "guestLastName": "User",
                "guestEmail": "test@example.com",
                "guestPhone": "+1234",
                "checkIn": "2026-08-10",
                "checkOut": "2026-08-15",
            },
        )
        assert resp.status_code == 400

    @patch("app.services.channex_sync_service.push_ari_for_booking", new_callable=AsyncMock)
    async def test_create_booking_instant_book_pay_at_property(
        self,
        mock_channex,
        client,
        hotel_with_rooms,
    ):
        """When hotel.instant_book is true, pay-at-property bookings skip the
        request flow: status='confirmed', no host_response_deadline, payouts
        scheduled, payment_status='pay_at_property'.
        """
        from app.database import Database

        hotel = hotel_with_rooms["hotel"]
        room = hotel_with_rooms["room"]
        await create_test_payment_settings(str(hotel["id"]), pay_at_property_enabled=True)
        await Database.execute("UPDATE hotels SET instant_book = true WHERE id = $1", hotel["id"])

        resp = await client.post(
            f"/api/hotels/{hotel['slug']}/bookings",
            json={
                "roomTypeId": str(room["id"]),
                "guestFirstName": "Jane",
                "guestLastName": "Smith",
                "guestEmail": "jane@example.com",
                "guestPhone": "+9876543210",
                "checkIn": "2026-09-10",
                "checkOut": "2026-09-13",
                "adults": 2,
                "children": 0,
                "paymentMethod": "pay_at_property",
            },
        )
        assert resp.status_code == 200, resp.text
        body = resp.json()
        booking_resp = body["booking"]
        assert booking_resp["status"] == "confirmed"
        assert booking_resp["hostResponseDeadline"] is None
        assert body["paymentMethod"] == "pay_at_property"

        # Verify the row in the DB reflects the finalized state.
        row = await Database.fetchrow(
            "SELECT status, payment_status, host_response_deadline, "
            "       property_payout_amount, platform_fee_amount "
            "FROM bookings WHERE id = $1",
            booking_resp["id"],
        )
        assert row["status"] == "confirmed"
        assert row["payment_status"] == "pay_at_property"
        assert row["host_response_deadline"] is None
        # _finalize_accepted_booking ran the split + write, so payout and fee
        # amounts should be populated (not the row defaults of NULL/0).
        assert row["property_payout_amount"] is not None

    @patch("app.services.channex_sync_service.push_ari_for_booking", new_callable=AsyncMock)
    async def test_create_booking_request_flow_pay_at_property(
        self,
        mock_channex,
        client,
        hotel_with_rooms,
    ):
        """Sanity: when instant_book is false (default), pay-at-property still
        creates a pending booking with a host_response_deadline.
        """
        from app.database import Database

        hotel = hotel_with_rooms["hotel"]
        room = hotel_with_rooms["room"]
        await create_test_payment_settings(str(hotel["id"]), pay_at_property_enabled=True)

        resp = await client.post(
            f"/api/hotels/{hotel['slug']}/bookings",
            json={
                "roomTypeId": str(room["id"]),
                "guestFirstName": "Jane",
                "guestLastName": "Smith",
                "guestEmail": "jane@example.com",
                "guestPhone": "+9876543210",
                "checkIn": "2026-09-10",
                "checkOut": "2026-09-13",
                "adults": 2,
                "children": 0,
                "paymentMethod": "pay_at_property",
            },
        )
        assert resp.status_code == 200, resp.text
        booking_resp = resp.json()["booking"]
        assert booking_resp["status"] == "pending"
        assert booking_resp["hostResponseDeadline"] is not None

        row = await Database.fetchrow(
            "SELECT status, host_response_deadline FROM bookings WHERE id = $1",
            booking_resp["id"],
        )
        assert row["status"] == "pending"
        assert row["host_response_deadline"] is not None

    async def test_create_booking_below_min_stay(self, client, cleanup_database):
        import json as _json

        from app.database import Database

        user = await create_test_user()
        hotel = await create_test_hotel(str(user["id"]))
        room = await create_test_room_type(str(hotel["id"]))

        seasons = [
            {
                "name": "All year",
                "tier": "Mid",
                "from": "01-01",
                "to": "12-31",
                "rate": "150",
                "minStay": 2,
            }
        ]
        await Database.execute(
            "UPDATE room_types SET seasons = $1::jsonb WHERE id = $2",
            _json.dumps(seasons),
            room["id"],
        )

        resp = await client.post(
            f"/api/hotels/{hotel['slug']}/bookings",
            json={
                "roomTypeId": str(room["id"]),
                "guestFirstName": "Test",
                "guestLastName": "User",
                "guestEmail": "test@example.com",
                "guestPhone": "+1234",
                "checkIn": "2026-08-10",
                "checkOut": "2026-08-11",
            },
        )
        assert resp.status_code == 400
        assert "minimum stay" in resp.json()["detail"].lower()

    async def test_create_booking_above_max_stay(self, client, cleanup_database):
        import json as _json

        from app.database import Database

        user = await create_test_user()
        hotel = await create_test_hotel(str(user["id"]))
        room = await create_test_room_type(str(hotel["id"]))

        seasons = [
            {
                "name": "All year",
                "tier": "Mid",
                "from": "01-01",
                "to": "12-31",
                "rate": "150",
                "minStay": 1,
                "maxStay": 3,
            }
        ]
        await Database.execute(
            "UPDATE room_types SET seasons = $1::jsonb WHERE id = $2",
            _json.dumps(seasons),
            room["id"],
        )

        resp = await client.post(
            f"/api/hotels/{hotel['slug']}/bookings",
            json={
                "roomTypeId": str(room["id"]),
                "guestFirstName": "Test",
                "guestLastName": "User",
                "guestEmail": "test@example.com",
                "guestPhone": "+1234",
                "checkIn": "2026-08-10",
                "checkOut": "2026-08-15",
            },
        )
        assert resp.status_code == 400
        assert "maximum stay of 3 nights" in resp.json()["detail"].lower()


class TestBookingLookup:
    async def test_lookup_booking(self, client, hotel_with_booking):
        hotel = hotel_with_booking["hotel"]
        booking = hotel_with_booking["booking"]

        resp = await client.post(
            f"/api/hotels/{hotel['slug']}/bookings/lookup",
            json={
                "bookingReference": booking["booking_reference"],
                "guestEmail": "guest@example.com",
            },
        )
        assert resp.status_code == 200
        body = resp.json()
        assert body["bookingReference"] == booking["booking_reference"]
        assert body["guestFirstName"] == "John"

    async def test_lookup_booking_case_insensitive_email(self, client, hotel_with_booking):
        hotel = hotel_with_booking["hotel"]
        booking = hotel_with_booking["booking"]

        resp = await client.post(
            f"/api/hotels/{hotel['slug']}/bookings/lookup",
            json={
                "bookingReference": booking["booking_reference"],
                "guestEmail": "GUEST@EXAMPLE.COM",
            },
        )
        assert resp.status_code == 200

    async def test_lookup_booking_not_found(self, client, hotel_with_rooms):
        hotel = hotel_with_rooms["hotel"]

        resp = await client.post(
            f"/api/hotels/{hotel['slug']}/bookings/lookup",
            json={
                "bookingReference": "VAY-NONEXIST",
                "guestEmail": "nobody@example.com",
            },
        )
        assert resp.status_code == 404

    async def test_lookup_booking_wrong_hotel(self, client, cleanup_database):
        """Booking exists but lookup is against wrong hotel slug."""
        user1 = await create_test_user()
        hotel1 = await create_test_hotel(str(user1["id"]), name="Hotel 1")
        room1 = await create_test_room_type(str(hotel1["id"]))
        booking = await create_test_booking(str(hotel1["id"]), str(room1["id"]))

        user2 = await create_test_user()
        hotel2 = await create_test_hotel(str(user2["id"]), name="Hotel 2")

        resp = await client.post(
            f"/api/hotels/{hotel2['slug']}/bookings/lookup",
            json={
                "bookingReference": booking["booking_reference"],
                "guestEmail": "guest@example.com",
            },
        )
        assert resp.status_code == 404
