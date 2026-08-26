"""Tests for the new booking-detail endpoints introduced in VAY-495:

- Internal notes (list/create/delete).
- Additional guests (list/create/update/delete + capacity cap).
- Reason-required cancel.
"""

from app.database import Database

from tests.conftest import (
    create_test_booking,
    create_test_hotel,
    create_test_user,
    generate_test_email,
    get_auth_headers,
)


class TestBookingNotes:
    async def test_create_and_list_notes(self, client, hotel_with_booking):
        token = hotel_with_booking["user"]["token"]
        booking_id = str(hotel_with_booking["booking"]["id"])

        # Empty to start.
        resp = await client.get(
            f"/admin/bookings/{booking_id}/notes",
            headers=get_auth_headers(token),
        )
        assert resp.status_code == 200
        assert resp.json() == {"notes": []}

        # Create one.
        resp = await client.post(
            f"/admin/bookings/{booking_id}/notes",
            json={"body": "Guest is allergic to peanuts."},
            headers=get_auth_headers(token),
        )
        assert resp.status_code == 201, resp.text
        created = resp.json()
        assert created["body"] == "Guest is allergic to peanuts."
        assert created["bookingId"] == booking_id
        assert created["authorName"]  # captured from auth user

        # Listed back.
        resp = await client.get(
            f"/admin/bookings/{booking_id}/notes",
            headers=get_auth_headers(token),
        )
        notes = resp.json()["notes"]
        assert len(notes) == 1
        assert notes[0]["id"] == created["id"]

    async def test_empty_body_rejected(self, client, hotel_with_booking):
        token = hotel_with_booking["user"]["token"]
        booking_id = str(hotel_with_booking["booking"]["id"])
        resp = await client.post(
            f"/admin/bookings/{booking_id}/notes",
            json={"body": "   "},
            headers=get_auth_headers(token),
        )
        assert resp.status_code == 400

    async def test_other_hotel_cannot_access(self, client, hotel_with_booking):
        booking_id = str(hotel_with_booking["booking"]["id"])

        other = await create_test_user(email=generate_test_email())
        await create_test_hotel(str(other["id"]))
        resp = await client.get(
            f"/admin/bookings/{booking_id}/notes",
            headers=get_auth_headers(other["token"]),
        )
        assert resp.status_code == 404

    async def test_delete_note(self, client, hotel_with_booking):
        token = hotel_with_booking["user"]["token"]
        booking_id = str(hotel_with_booking["booking"]["id"])

        resp = await client.post(
            f"/admin/bookings/{booking_id}/notes",
            json={"body": "Temp"},
            headers=get_auth_headers(token),
        )
        note_id = resp.json()["id"]

        resp = await client.delete(
            f"/admin/bookings/{booking_id}/notes/{note_id}",
            headers=get_auth_headers(token),
        )
        assert resp.status_code == 204

        resp = await client.get(
            f"/admin/bookings/{booking_id}/notes",
            headers=get_auth_headers(token),
        )
        assert resp.json()["notes"] == []


class TestAdditionalGuests:
    async def test_contact_is_masked_until_booking_acceptance(self, client, hotel_with_booking):
        token = hotel_with_booking["user"]["token"]
        booking_id = str(hotel_with_booking["booking"]["id"])
        await Database.execute(
            "UPDATE room_types SET max_occupancy = 2 WHERE id = $1",
            hotel_with_booking["booking"]["room_type_id"],
        )

        created = await client.post(
            f"/admin/bookings/{booking_id}/additional-guests",
            json={
                "firstName": "Grace",
                "lastName": "Hopper",
                "nationality": "US",
                "email": "grace@example.test",
                "phone": "+12025550123",
            },
            headers=get_auth_headers(token),
        )

        assert created.status_code == 201
        assert created.json()["firstName"] == "Grace"
        assert created.json()["nationality"] == "US"
        assert created.json()["email"] == "Hidden until you accept"
        assert created.json()["phone"] == "Hidden until you accept"

        accepted = await client.patch(
            f"/admin/bookings/{booking_id}/status",
            json={"status": "confirmed"},
            headers=get_auth_headers(token),
        )
        assert accepted.status_code == 200

        listed = await client.get(
            f"/admin/bookings/{booking_id}/additional-guests",
            headers=get_auth_headers(token),
        )
        assert listed.json()["guests"][0]["email"] == "grace@example.test"
        assert listed.json()["guests"][0]["phone"] == "+12025550123"

    async def test_pending_edit_preserves_additional_guest_contact(
        self, client, hotel_with_booking
    ):
        token = hotel_with_booking["user"]["token"]
        booking_id = str(hotel_with_booking["booking"]["id"])
        await Database.execute(
            "UPDATE room_types SET max_occupancy = 2 WHERE id = $1",
            hotel_with_booking["booking"]["room_type_id"],
        )
        created = await client.post(
            f"/admin/bookings/{booking_id}/additional-guests",
            json={
                "firstName": "Grace",
                "email": "grace@example.test",
                "phone": "+12025550123",
            },
            headers=get_auth_headers(token),
        )
        guest_id = created.json()["id"]

        updated = await client.patch(
            f"/admin/bookings/{booking_id}/additional-guests/{guest_id}",
            json={
                "firstName": "Updated",
                "email": "Hidden until you accept",
                "phone": "Hidden until you accept",
            },
            headers=get_auth_headers(token),
        )

        assert updated.status_code == 200
        assert updated.json()["firstName"] == "Updated"
        assert updated.json()["email"] == "Hidden until you accept"
        stored = await Database.fetchrow(
            "SELECT email, phone FROM booking_additional_guests WHERE id = $1",
            guest_id,
        )
        assert stored["email"] == "grace@example.test"
        assert stored["phone"] == "+12025550123"

    async def test_capacity_capped_at_room_capacity_minus_booker(self, client, hotel_with_booking):
        """A room that sleeps 4 allows the booker + 3 additional registered guests."""
        token = hotel_with_booking["user"]["token"]
        booking_id = str(hotel_with_booking["booking"]["id"])

        await Database.execute(
            "UPDATE room_types SET max_occupancy = 4 WHERE id = $1",
            hotel_with_booking["booking"]["room_type_id"],
        )
        await Database.execute(
            "UPDATE bookings SET adults = 1, children = 0 WHERE id = $1",
            hotel_with_booking["booking"]["id"],
        )

        for idx, name in enumerate(["Alex", "Beta", "Casey"], start=1):
            resp = await client.post(
                f"/admin/bookings/{booking_id}/additional-guests",
                json={"firstName": name},
                headers=get_auth_headers(token),
            )
            assert resp.status_code == 201, resp.text
            assert resp.json()["position"] == idx

        resp = await client.post(
            f"/admin/bookings/{booking_id}/additional-guests",
            json={"firstName": "Delta"},
            headers=get_auth_headers(token),
        )
        assert resp.status_code == 400
        assert resp.json()["detail"] == "Room capacity reached (4 guests maximum)."

    async def test_multi_room_capacity_sums_room_type_capacity(self, client, hotel_with_booking):
        token = hotel_with_booking["user"]["token"]
        booking_id = str(hotel_with_booking["booking"]["id"])

        await Database.execute(
            "UPDATE room_types SET max_occupancy = 2 WHERE id = $1",
            hotel_with_booking["booking"]["room_type_id"],
        )
        await Database.execute(
            "UPDATE bookings SET adults = 1, children = 0, number_of_rooms = 2 WHERE id = $1",
            hotel_with_booking["booking"]["id"],
        )

        for name in ["Alex", "Beta", "Casey"]:
            resp = await client.post(
                f"/admin/bookings/{booking_id}/additional-guests",
                json={"firstName": name},
                headers=get_auth_headers(token),
            )
            assert resp.status_code == 201, resp.text

        resp = await client.post(
            f"/admin/bookings/{booking_id}/additional-guests",
            json={"firstName": "Delta"},
            headers=get_auth_headers(token),
        )
        assert resp.status_code == 400

    async def test_room_position_round_trip_and_bounds(self, client, hotel_with_booking):
        """room_position 0..number_of_rooms-1 round-trips; out-of-range 400s."""
        token = hotel_with_booking["user"]["token"]
        booking_id = str(hotel_with_booking["booking"]["id"])
        # 2-room booking so positions 0 and 1 are valid, 2 is not.
        await Database.execute(
            "UPDATE bookings SET adults = 4, number_of_rooms = 2 WHERE id = $1",
            hotel_with_booking["booking"]["id"],
        )

        # Assigned at create time.
        resp = await client.post(
            f"/admin/bookings/{booking_id}/additional-guests",
            json={"firstName": "Anna", "roomPosition": 1},
            headers=get_auth_headers(token),
        )
        assert resp.status_code == 201, resp.text
        assert resp.json()["roomPosition"] == 1
        guest_id = resp.json()["id"]

        # Reassigned to room 0 via PATCH.
        resp = await client.patch(
            f"/admin/bookings/{booking_id}/additional-guests/{guest_id}",
            json={"roomPosition": 0},
            headers=get_auth_headers(token),
        )
        assert resp.status_code == 200
        assert resp.json()["roomPosition"] == 0

        # Unassigned (null) round-trips.
        resp = await client.patch(
            f"/admin/bookings/{booking_id}/additional-guests/{guest_id}",
            json={"roomPosition": None},
            headers=get_auth_headers(token),
        )
        assert resp.status_code == 200
        assert resp.json()["roomPosition"] is None

        # Out-of-range rejected on create.
        resp = await client.post(
            f"/admin/bookings/{booking_id}/additional-guests",
            json={"firstName": "Bad", "roomPosition": 2},
            headers=get_auth_headers(token),
        )
        assert resp.status_code == 400

        # Out-of-range rejected on update too.
        resp = await client.patch(
            f"/admin/bookings/{booking_id}/additional-guests/{guest_id}",
            json={"roomPosition": 99},
            headers=get_auth_headers(token),
        )
        assert resp.status_code == 400

    async def test_update_then_delete(self, client, hotel_with_booking):
        token = hotel_with_booking["user"]["token"]
        booking_id = str(hotel_with_booking["booking"]["id"])
        await Database.execute(
            "UPDATE bookings SET adults = 4 WHERE id = $1",
            hotel_with_booking["booking"]["id"],
        )

        resp = await client.post(
            f"/admin/bookings/{booking_id}/additional-guests",
            json={"firstName": "Old"},
            headers=get_auth_headers(token),
        )
        guest_id = resp.json()["id"]

        resp = await client.patch(
            f"/admin/bookings/{booking_id}/additional-guests/{guest_id}",
            json={"firstName": "New", "passportNumber": "P12345"},
            headers=get_auth_headers(token),
        )
        assert resp.status_code == 200
        assert resp.json()["firstName"] == "New"
        assert resp.json()["passportNumber"] == "P12345"

        resp = await client.delete(
            f"/admin/bookings/{booking_id}/additional-guests/{guest_id}",
            headers=get_auth_headers(token),
        )
        assert resp.status_code == 204


class TestCancelWithReason:
    async def test_reason_required(self, client, hotel_with_booking):
        token = hotel_with_booking["user"]["token"]
        booking_id = str(hotel_with_booking["booking"]["id"])
        resp = await client.post(
            f"/admin/bookings/{booking_id}/cancel",
            json={"reason": "   "},
            headers=get_auth_headers(token),
        )
        assert resp.status_code == 400

    async def test_cancel_records_reason_as_note(self, client, hotel_with_booking):
        token = hotel_with_booking["user"]["token"]
        booking_id = str(hotel_with_booking["booking"]["id"])
        # Mark confirmed so the cancel path runs normally.
        await Database.execute(
            "UPDATE bookings SET status = 'confirmed' WHERE id = $1",
            hotel_with_booking["booking"]["id"],
        )

        resp = await client.post(
            f"/admin/bookings/{booking_id}/cancel",
            json={"reason": "Guest no longer travelling"},
            headers=get_auth_headers(token),
        )
        assert resp.status_code == 200, resp.text
        assert resp.json()["status"] == "cancelled"

        resp = await client.get(
            f"/admin/bookings/{booking_id}/notes",
            headers=get_auth_headers(token),
        )
        notes = resp.json()["notes"]
        assert any("Guest no longer travelling" in n["body"] for n in notes)

    async def test_double_cancel_rejected(self, client, hotel_with_booking):
        token = hotel_with_booking["user"]["token"]
        booking_id = str(hotel_with_booking["booking"]["id"])
        await Database.execute(
            "UPDATE bookings SET status = 'cancelled' WHERE id = $1",
            hotel_with_booking["booking"]["id"],
        )
        resp = await client.post(
            f"/admin/bookings/{booking_id}/cancel",
            json={"reason": "again"},
            headers=get_auth_headers(token),
        )
        assert resp.status_code == 400
