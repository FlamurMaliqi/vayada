"""
Tests for /admin endpoints — hotel registration, setup status, room CRUD, booking management.
"""

from unittest.mock import AsyncMock, patch

import pytest

from tests.conftest import (
    create_test_booking,
    create_test_hotel,
    create_test_room,
    create_test_room_type,
    create_test_user,
    generate_test_slug,
    get_auth_headers,
)

# ── Hotel Registration ────────────────────────────────────────────


class TestRegisterHotel:
    async def test_register_hotel(self, client, cleanup_database):
        user = await create_test_user()
        slug = generate_test_slug()
        resp = await client.post(
            "/admin/register-hotel",
            json={"name": "My Hotel", "slug": slug, "contactEmail": "info@hotel.com"},
            headers=get_auth_headers(user["token"]),
        )
        assert resp.status_code == 201
        body = resp.json()
        assert body["name"] == "My Hotel"
        assert body["slug"] == slug
        assert body["contactEmail"] == "info@hotel.com"
        assert body["userId"] == str(user["id"])

    async def test_register_hotel_idempotent(self, client, cleanup_database):
        user = await create_test_user()
        slug = generate_test_slug()
        payload = {"name": "Hotel One", "slug": slug, "contactEmail": "a@b.com"}
        headers = get_auth_headers(user["token"])

        resp1 = await client.post("/admin/register-hotel", json=payload, headers=headers)
        assert resp1.status_code == 201
        hotel_id = resp1.json()["id"]

        # Second call updates slug/name to keep in sync with booking engine
        resp2 = await client.post(
            "/admin/register-hotel",
            json={"name": "Updated Name", "slug": "updated-slug", "contactEmail": "updated@b.com"},
            headers=headers,
        )
        assert resp2.status_code == 201
        assert resp2.json()["id"] == hotel_id
        assert resp2.json()["name"] == "Updated Name"
        assert resp2.json()["slug"] == "updated-slug"

    async def test_register_hotel_requires_auth(self, client):
        resp = await client.post(
            "/admin/register-hotel",
            json={"name": "X", "slug": "x", "contactEmail": "x@x.com"},
        )
        assert resp.status_code == 401

    async def test_register_hotel_non_hotel_user(self, client, cleanup_database):
        user = await create_test_user(user_type="creator")
        resp = await client.post(
            "/admin/register-hotel",
            json={"name": "X", "slug": "x", "contactEmail": "x@x.com"},
            headers=get_auth_headers(user["token"]),
        )
        assert resp.status_code == 403


# ── Setup Status ──────────────────────────────────────────────────


class TestSetupStatus:
    async def test_setup_status_no_hotel(self, client, cleanup_database):
        """Setup-status auto-registers a hotel from auth profile."""
        user = await create_test_user()
        resp = await client.get(
            "/admin/setup-status",
            headers=get_auth_headers(user["token"]),
        )
        assert resp.status_code == 200
        body = resp.json()
        # Auto-register creates hotel from auth profile, so registered is True
        assert body["registered"] is True
        assert body["setupComplete"] is False
        assert body["roomCount"] == 0

    async def test_setup_status_registered_no_rooms(self, client, cleanup_database):
        user = await create_test_user()
        await create_test_hotel(str(user["id"]))

        resp = await client.get(
            "/admin/setup-status",
            headers=get_auth_headers(user["token"]),
        )
        body = resp.json()
        assert body["registered"] is True
        assert body["setupComplete"] is False
        assert body["roomCount"] == 0

    async def test_setup_status_complete(self, client, hotel_with_rooms):
        user = hotel_with_rooms["user"]
        resp = await client.get(
            "/admin/setup-status",
            headers=get_auth_headers(user["token"]),
        )
        body = resp.json()
        assert body["registered"] is True
        assert body["setupComplete"] is True
        assert body["roomCount"] == 1


# ── Admin Room Types ──────────────────────────────────────────────


class TestAdminRoomTypes:
    async def test_list_room_types_empty(self, client, cleanup_database):
        user = await create_test_user()
        await create_test_hotel(str(user["id"]))

        resp = await client.get(
            "/admin/room-types",
            headers=get_auth_headers(user["token"]),
        )
        assert resp.status_code == 200
        assert resp.json() == []

    async def test_create_room_type(self, client, cleanup_database):
        user = await create_test_user()
        await create_test_hotel(str(user["id"]))

        resp = await client.post(
            "/admin/room-types",
            json={
                "name": "Standard Room",
                "description": "A nice room",
                "baseRate": 100.0,
                "maxOccupancy": 2,
                "totalRooms": 10,
                "bedType": "Queen",
                "amenities": ["WiFi", "TV"],
                "features": ["City View"],
            },
            headers=get_auth_headers(user["token"]),
        )
        assert resp.status_code == 201
        body = resp.json()
        assert body["name"] == "Standard Room"
        assert body["baseRate"] == 100.0
        assert body["totalRooms"] == 10
        assert body["bedType"] == "Queen"
        assert body["amenities"] == ["WiFi", "TV"]
        assert body["isActive"] is True

    async def test_create_room_type_auto_creates_rooms(self, client, cleanup_database):
        user = await create_test_user()
        await create_test_hotel(str(user["id"]))

        resp = await client.post(
            "/admin/room-types",
            json={
                "name": "Garden King",
                "baseRate": 120.0,
                "maxOccupancy": 2,
                "totalRooms": 3,
            },
            headers=get_auth_headers(user["token"]),
        )
        assert resp.status_code == 201
        room_type_id = resp.json()["id"]

        rooms_resp = await client.get(
            "/admin/rooms",
            headers=get_auth_headers(user["token"]),
        )
        assert rooms_resp.status_code == 200
        rooms = [r for r in rooms_resp.json() if r["roomTypeId"] == room_type_id]
        assert len(rooms) == 3
        assert {r["roomNumber"] for r in rooms} == {
            "Garden King 1",
            "Garden King 2",
            "Garden King 3",
        }

    async def test_duplicate_room_type_auto_creates_rooms(self, client, cleanup_database):
        user = await create_test_user()
        await create_test_hotel(str(user["id"]))

        create_resp = await client.post(
            "/admin/room-types",
            json={
                "name": "Garden King",
                "baseRate": 120.0,
                "maxOccupancy": 2,
                "totalRooms": 2,
            },
            headers=get_auth_headers(user["token"]),
        )
        assert create_resp.status_code == 201
        original_id = create_resp.json()["id"]

        dup_resp = await client.post(
            f"/admin/room-types/{original_id}/duplicate",
            headers=get_auth_headers(user["token"]),
        )
        assert dup_resp.status_code == 201
        clone_id = dup_resp.json()["id"]
        assert dup_resp.json()["name"] == "Garden King (Copy)"

        rooms_resp = await client.get(
            "/admin/rooms",
            headers=get_auth_headers(user["token"]),
        )
        assert rooms_resp.status_code == 200
        clone_rooms = [r for r in rooms_resp.json() if r["roomTypeId"] == clone_id]
        assert len(clone_rooms) == 2
        assert {r["roomNumber"] for r in clone_rooms} == {
            "Garden King (Copy) 1",
            "Garden King (Copy) 2",
        }

    async def test_rename_room_type_renames_auto_named_rooms(self, client, cleanup_database):
        """VAY-322: when a room type is renamed, the auto-generated room
        numbers ("Garden King 1", "Garden King 2", ...) must adopt the new
        name so the calendar stops showing the stale prefix."""
        user = await create_test_user()
        await create_test_hotel(str(user["id"]))

        create_resp = await client.post(
            "/admin/room-types",
            json={
                "name": "Garden King",
                "baseRate": 120.0,
                "maxOccupancy": 2,
                "totalRooms": 3,
            },
            headers=get_auth_headers(user["token"]),
        )
        assert create_resp.status_code == 201
        room_type_id = create_resp.json()["id"]

        rename_resp = await client.patch(
            f"/admin/room-types/{room_type_id}",
            json={"name": "Garden Queen"},
            headers=get_auth_headers(user["token"]),
        )
        assert rename_resp.status_code == 200
        assert rename_resp.json()["name"] == "Garden Queen"

        rooms_resp = await client.get(
            "/admin/rooms",
            headers=get_auth_headers(user["token"]),
        )
        assert rooms_resp.status_code == 200
        rooms = [r for r in rooms_resp.json() if r["roomTypeId"] == room_type_id]
        assert len(rooms) == 3
        assert {r["roomNumber"] for r in rooms} == {
            "Garden Queen 1",
            "Garden Queen 2",
            "Garden Queen 3",
        }

    async def test_rename_room_type_preserves_manually_named_rooms(self, client, cleanup_database):
        """VAY-322: rooms whose numbers don't follow the auto pattern (e.g.
        the user renamed one to "101") must NOT be rewritten on rename."""
        user = await create_test_user()
        await create_test_hotel(str(user["id"]))

        create_resp = await client.post(
            "/admin/room-types",
            json={
                "name": "Garden King",
                "baseRate": 120.0,
                "maxOccupancy": 2,
                "totalRooms": 2,
            },
            headers=get_auth_headers(user["token"]),
        )
        assert create_resp.status_code == 201
        room_type_id = create_resp.json()["id"]

        rooms_resp = await client.get(
            "/admin/rooms",
            headers=get_auth_headers(user["token"]),
        )
        room_to_rename = next(
            r
            for r in rooms_resp.json()
            if r["roomTypeId"] == room_type_id and r["roomNumber"] == "Garden King 1"
        )
        manual_rename = await client.patch(
            f"/admin/rooms/{room_to_rename['id']}",
            json={"roomNumber": "Penthouse"},
            headers=get_auth_headers(user["token"]),
        )
        assert manual_rename.status_code == 200

        rename_resp = await client.patch(
            f"/admin/room-types/{room_type_id}",
            json={"name": "Garden Queen"},
            headers=get_auth_headers(user["token"]),
        )
        assert rename_resp.status_code == 200

        rooms_resp = await client.get(
            "/admin/rooms",
            headers=get_auth_headers(user["token"]),
        )
        rooms = [r for r in rooms_resp.json() if r["roomTypeId"] == room_type_id]
        assert {r["roomNumber"] for r in rooms} == {"Penthouse", "Garden Queen 2"}

    async def test_rename_room_type_renames_bare_name_room(self, client, cleanup_database):
        """VAY-322: a single room whose room_number exactly matches the room
        type name (no numeric suffix) must follow the rename. This is the
        case the original ticket reporter hit — "Deluxe Room" stayed as
        "Deluxe Room" after the type was renamed to "Deluxe Party Room"."""
        user = await create_test_user()
        await create_test_hotel(str(user["id"]))

        create_resp = await client.post(
            "/admin/room-types",
            json={
                "name": "Deluxe Room",
                "baseRate": 120.0,
                "maxOccupancy": 2,
                "totalRooms": 1,
            },
            headers=get_auth_headers(user["token"]),
        )
        assert create_resp.status_code == 201
        room_type_id = create_resp.json()["id"]

        rooms_resp = await client.get(
            "/admin/rooms",
            headers=get_auth_headers(user["token"]),
        )
        only_room = next(r for r in rooms_resp.json() if r["roomTypeId"] == room_type_id)
        # Drop the auto-generated " 1" suffix to reproduce the production
        # state where a single room is named exactly after its room type.
        bare_rename = await client.patch(
            f"/admin/rooms/{only_room['id']}",
            json={"roomNumber": "Deluxe Room"},
            headers=get_auth_headers(user["token"]),
        )
        assert bare_rename.status_code == 200

        rename_resp = await client.patch(
            f"/admin/room-types/{room_type_id}",
            json={"name": "Deluxe Party Room"},
            headers=get_auth_headers(user["token"]),
        )
        assert rename_resp.status_code == 200

        rooms_resp = await client.get(
            "/admin/rooms",
            headers=get_auth_headers(user["token"]),
        )
        rooms = [r for r in rooms_resp.json() if r["roomTypeId"] == room_type_id]
        assert {r["roomNumber"] for r in rooms} == {"Deluxe Party Room"}

    async def test_rename_room_type_handles_mixed_fleet(self, client, cleanup_database):
        """VAY-322: bare ("Deluxe Room"), numbered ("Deluxe Room 2"), and
        custom ("Penthouse") room names side by side — bare and numbered
        must adopt the new prefix; custom must be untouched."""
        user = await create_test_user()
        await create_test_hotel(str(user["id"]))

        create_resp = await client.post(
            "/admin/room-types",
            json={
                "name": "Deluxe Room",
                "baseRate": 120.0,
                "maxOccupancy": 2,
                "totalRooms": 3,
            },
            headers=get_auth_headers(user["token"]),
        )
        assert create_resp.status_code == 201
        room_type_id = create_resp.json()["id"]

        rooms_resp = await client.get(
            "/admin/rooms",
            headers=get_auth_headers(user["token"]),
        )
        rooms = [r for r in rooms_resp.json() if r["roomTypeId"] == room_type_id]
        room_1 = next(r for r in rooms if r["roomNumber"] == "Deluxe Room 1")
        room_3 = next(r for r in rooms if r["roomNumber"] == "Deluxe Room 3")
        # Room 1 → bare name, room 3 → fully custom name.
        bare = await client.patch(
            f"/admin/rooms/{room_1['id']}",
            json={"roomNumber": "Deluxe Room"},
            headers=get_auth_headers(user["token"]),
        )
        assert bare.status_code == 200
        custom = await client.patch(
            f"/admin/rooms/{room_3['id']}",
            json={"roomNumber": "Penthouse"},
            headers=get_auth_headers(user["token"]),
        )
        assert custom.status_code == 200

        rename_resp = await client.patch(
            f"/admin/room-types/{room_type_id}",
            json={"name": "Deluxe Party Room"},
            headers=get_auth_headers(user["token"]),
        )
        assert rename_resp.status_code == 200

        rooms_resp = await client.get(
            "/admin/rooms",
            headers=get_auth_headers(user["token"]),
        )
        rooms = [r for r in rooms_resp.json() if r["roomTypeId"] == room_type_id]
        assert {r["roomNumber"] for r in rooms} == {
            "Deluxe Party Room",
            "Deluxe Party Room 2",
            "Penthouse",
        }

    async def test_update_room_type_without_name_change_keeps_room_numbers(
        self, client, cleanup_database
    ):
        """A PATCH that doesn't include a name change must not touch the
        room_number column."""
        user = await create_test_user()
        await create_test_hotel(str(user["id"]))

        create_resp = await client.post(
            "/admin/room-types",
            json={
                "name": "Garden King",
                "baseRate": 120.0,
                "maxOccupancy": 2,
                "totalRooms": 2,
            },
            headers=get_auth_headers(user["token"]),
        )
        room_type_id = create_resp.json()["id"]

        rate_only = await client.patch(
            f"/admin/room-types/{room_type_id}",
            json={"baseRate": 200.0},
            headers=get_auth_headers(user["token"]),
        )
        assert rate_only.status_code == 200

        rooms_resp = await client.get(
            "/admin/rooms",
            headers=get_auth_headers(user["token"]),
        )
        rooms = [r for r in rooms_resp.json() if r["roomTypeId"] == room_type_id]
        assert {r["roomNumber"] for r in rooms} == {"Garden King 1", "Garden King 2"}

    async def test_save_room_type_unchanged_heals_stale_lone_room(self, client, cleanup_database):
        """VAY-322 backfill: hotels that renamed a room type before the
        on-rename fix shipped end up with stale room_numbers (the
        screenshot scenario — single "#Deluxe Room" under "Deluxe Party
        Room"). A subsequent save with the same name must heal them."""
        user = await create_test_user()
        await create_test_hotel(str(user["id"]))

        create_resp = await client.post(
            "/admin/room-types",
            json={
                "name": "Deluxe Party Room",
                "baseRate": 120.0,
                "maxOccupancy": 2,
                "totalRooms": 1,
            },
            headers=get_auth_headers(user["token"]),
        )
        assert create_resp.status_code == 201
        room_type_id = create_resp.json()["id"]

        rooms_resp = await client.get(
            "/admin/rooms",
            headers=get_auth_headers(user["token"]),
        )
        only_room = next(r for r in rooms_resp.json() if r["roomTypeId"] == room_type_id)
        # Reproduce the broken pre-fix state: room still carries the
        # previous type name even though the type is now "Deluxe Party Room".
        await client.patch(
            f"/admin/rooms/{only_room['id']}",
            json={"roomNumber": "Deluxe Room"},
            headers=get_auth_headers(user["token"]),
        )

        # No-op save (rate change, name unchanged) should still heal.
        same_name = await client.patch(
            f"/admin/room-types/{room_type_id}",
            json={"baseRate": 130.0},
            headers=get_auth_headers(user["token"]),
        )
        assert same_name.status_code == 200

        rooms_resp = await client.get(
            "/admin/rooms",
            headers=get_auth_headers(user["token"]),
        )
        rooms = [r for r in rooms_resp.json() if r["roomTypeId"] == room_type_id]
        assert {r["roomNumber"] for r in rooms} == {"Deluxe Party Room"}

    async def test_save_room_type_heals_shared_stale_prefix(self, client, cleanup_database):
        """VAY-322 backfill: in a multi-room type, multiple rooms sharing
        the same stale prefix is a strong auto-naming signal — heal them
        all on next save, even without a name change."""
        user = await create_test_user()
        await create_test_hotel(str(user["id"]))

        create_resp = await client.post(
            "/admin/room-types",
            json={
                "name": "Garden Queen",
                "baseRate": 120.0,
                "maxOccupancy": 2,
                "totalRooms": 3,
            },
            headers=get_auth_headers(user["token"]),
        )
        room_type_id = create_resp.json()["id"]

        rooms_resp = await client.get(
            "/admin/rooms",
            headers=get_auth_headers(user["token"]),
        )
        rooms = [r for r in rooms_resp.json() if r["roomTypeId"] == room_type_id]
        # Force two rooms into the stale "Garden King N" naming and
        # leave one with a custom name that must be preserved.
        sorted_rooms = sorted(rooms, key=lambda r: r["roomNumber"])
        await client.patch(
            f"/admin/rooms/{sorted_rooms[0]['id']}",
            json={"roomNumber": "Garden King 1"},
            headers=get_auth_headers(user["token"]),
        )
        await client.patch(
            f"/admin/rooms/{sorted_rooms[1]['id']}",
            json={"roomNumber": "Garden King 2"},
            headers=get_auth_headers(user["token"]),
        )
        await client.patch(
            f"/admin/rooms/{sorted_rooms[2]['id']}",
            json={"roomNumber": "Penthouse"},
            headers=get_auth_headers(user["token"]),
        )

        same_name = await client.patch(
            f"/admin/room-types/{room_type_id}",
            json={"baseRate": 130.0},
            headers=get_auth_headers(user["token"]),
        )
        assert same_name.status_code == 200

        rooms_resp = await client.get(
            "/admin/rooms",
            headers=get_auth_headers(user["token"]),
        )
        rooms = [r for r in rooms_resp.json() if r["roomTypeId"] == room_type_id]
        assert {r["roomNumber"] for r in rooms} == {
            "Garden Queen 1",
            "Garden Queen 2",
            "Penthouse",
        }

    async def test_save_room_type_heal_skips_sibling_type_prefix(self, client, cleanup_database):
        """VAY-322 backfill: don't steal a sibling room type's prefix.
        If "Deluxe Suite" exists in the hotel and a "Garden King" room
        happens to be named "Deluxe Suite 1", saving "Garden King" must
        leave it alone — that prefix legitimately belongs elsewhere."""
        user = await create_test_user()
        await create_test_hotel(str(user["id"]))

        await client.post(
            "/admin/room-types",
            json={
                "name": "Deluxe Suite",
                "baseRate": 200.0,
                "maxOccupancy": 2,
                "totalRooms": 1,
            },
            headers=get_auth_headers(user["token"]),
        )
        target_resp = await client.post(
            "/admin/room-types",
            json={
                "name": "Garden King",
                "baseRate": 120.0,
                "maxOccupancy": 2,
                "totalRooms": 1,
            },
            headers=get_auth_headers(user["token"]),
        )
        target_id = target_resp.json()["id"]

        rooms_resp = await client.get(
            "/admin/rooms",
            headers=get_auth_headers(user["token"]),
        )
        target_room = next(r for r in rooms_resp.json() if r["roomTypeId"] == target_id)
        await client.patch(
            f"/admin/rooms/{target_room['id']}",
            json={"roomNumber": "Deluxe Suite 7"},
            headers=get_auth_headers(user["token"]),
        )

        same_name = await client.patch(
            f"/admin/room-types/{target_id}",
            json={"baseRate": 130.0},
            headers=get_auth_headers(user["token"]),
        )
        assert same_name.status_code == 200

        rooms_resp = await client.get(
            "/admin/rooms",
            headers=get_auth_headers(user["token"]),
        )
        rooms = [r for r in rooms_resp.json() if r["roomTypeId"] == target_id]
        assert {r["roomNumber"] for r in rooms} == {"Deluxe Suite 7"}

    async def test_save_room_type_heal_idempotent(self, client, cleanup_database):
        """VAY-322 backfill: running twice must be a no-op the second
        time. Guards against the script and the on-save heal stepping on
        each other after deploy."""
        user = await create_test_user()
        await create_test_hotel(str(user["id"]))

        create_resp = await client.post(
            "/admin/room-types",
            json={
                "name": "Deluxe Party Room",
                "baseRate": 120.0,
                "maxOccupancy": 2,
                "totalRooms": 1,
            },
            headers=get_auth_headers(user["token"]),
        )
        room_type_id = create_resp.json()["id"]

        rooms_resp = await client.get(
            "/admin/rooms",
            headers=get_auth_headers(user["token"]),
        )
        only_room = next(r for r in rooms_resp.json() if r["roomTypeId"] == room_type_id)
        await client.patch(
            f"/admin/rooms/{only_room['id']}",
            json={"roomNumber": "Deluxe Room"},
            headers=get_auth_headers(user["token"]),
        )

        for _ in range(2):
            resp = await client.patch(
                f"/admin/room-types/{room_type_id}",
                json={"baseRate": 130.0},
                headers=get_auth_headers(user["token"]),
            )
            assert resp.status_code == 200

        rooms_resp = await client.get(
            "/admin/rooms",
            headers=get_auth_headers(user["token"]),
        )
        rooms = [r for r in rooms_resp.json() if r["roomTypeId"] == room_type_id]
        assert {r["roomNumber"] for r in rooms} == {"Deluxe Party Room"}

    async def test_get_room_type(self, client, hotel_with_rooms):
        user = hotel_with_rooms["user"]
        room = hotel_with_rooms["room"]

        resp = await client.get(
            f"/admin/room-types/{room['id']}",
            headers=get_auth_headers(user["token"]),
        )
        assert resp.status_code == 200
        assert resp.json()["name"] == "Deluxe Suite"

    async def test_get_room_type_not_found(self, client, cleanup_database):
        user = await create_test_user()
        await create_test_hotel(str(user["id"]))

        resp = await client.get(
            "/admin/room-types/00000000-0000-0000-0000-000000000000",
            headers=get_auth_headers(user["token"]),
        )
        assert resp.status_code == 404

    async def test_resolved_rate_uses_season_when_base_rate_zero(self, client, cleanup_database):
        """When base_rate=0 and a season covers the check-in date, the
        resolved-rate endpoint must return the season rate — same logic the
        booking engine uses — so the calendar's New Booking modal pre-fills
        the actual price the guest would pay."""
        import json

        from app.database import Database

        user = await create_test_user()
        hotel = await create_test_hotel(str(user["id"]))
        room = await create_test_room_type(str(hotel["id"]), base_rate=0.0)
        seasons = [
            {
                "name": "High Season",
                "start_date": "2026-06-01",
                "end_date": "2026-08-31",
                "rate": 250.0,
            }
        ]
        await Database.execute(
            "UPDATE room_types SET seasons = $1::jsonb WHERE id = $2",
            json.dumps(seasons),
            room["id"],
        )

        resp = await client.get(
            f"/admin/room-types/{room['id']}/resolved-rate?check_in=2026-07-15",
            headers=get_auth_headers(user["token"]),
        )
        assert resp.status_code == 200
        body = resp.json()
        assert body["nightlyRate"] == 250.0
        assert body["currency"] == "EUR"

    async def test_resolved_rate_invalid_check_in(self, client, hotel_with_rooms):
        user = hotel_with_rooms["user"]
        room = hotel_with_rooms["room"]

        resp = await client.get(
            f"/admin/room-types/{room['id']}/resolved-rate?check_in=not-a-date",
            headers=get_auth_headers(user["token"]),
        )
        assert resp.status_code == 400

    async def test_resolved_rate_not_found(self, client, cleanup_database):
        user = await create_test_user()
        await create_test_hotel(str(user["id"]))

        resp = await client.get(
            "/admin/room-types/00000000-0000-0000-0000-000000000000/resolved-rate?check_in=2026-07-15",
            headers=get_auth_headers(user["token"]),
        )
        assert resp.status_code == 404

    async def test_update_room_type(self, client, hotel_with_rooms):
        user = hotel_with_rooms["user"]
        room = hotel_with_rooms["room"]

        resp = await client.patch(
            f"/admin/room-types/{room['id']}",
            json={"name": "Updated Suite", "baseRate": 200.0},
            headers=get_auth_headers(user["token"]),
        )
        assert resp.status_code == 200
        body = resp.json()
        assert body["name"] == "Updated Suite"
        assert body["baseRate"] == 200.0

    async def test_delete_room_type(self, client, cleanup_database):
        user = await create_test_user()
        hotel = await create_test_hotel(str(user["id"]))
        room = await create_test_room_type(str(hotel["id"]))

        resp = await client.delete(
            f"/admin/room-types/{room['id']}",
            headers=get_auth_headers(user["token"]),
        )
        assert resp.status_code == 204

        # Verify gone
        resp2 = await client.get(
            f"/admin/room-types/{room['id']}",
            headers=get_auth_headers(user["token"]),
        )
        assert resp2.status_code == 404

    async def test_delete_room_type_with_bookings_fails(self, client, hotel_with_booking):
        user = hotel_with_booking["user"]
        room = hotel_with_booking["room"]

        resp = await client.delete(
            f"/admin/room-types/{room['id']}",
            headers=get_auth_headers(user["token"]),
        )
        assert resp.status_code == 409

    async def test_list_room_types(self, client, hotel_with_rooms):
        user = hotel_with_rooms["user"]

        resp = await client.get(
            "/admin/room-types",
            headers=get_auth_headers(user["token"]),
        )
        assert resp.status_code == 200
        rooms = resp.json()
        assert len(rooms) == 1
        assert rooms[0]["name"] == "Deluxe Suite"

    async def test_create_room_type_with_non_refundable_rate(self, client, cleanup_database):
        user = await create_test_user()
        await create_test_hotel(str(user["id"]))

        resp = await client.post(
            "/admin/room-types",
            json={
                "name": "NR Room",
                "description": "Room with non-refundable rate",
                "baseRate": 200.0,
                "nonRefundableRate": 170.0,
                "maxOccupancy": 2,
                "totalRooms": 5,
                "bedType": "King",
                "amenities": ["WiFi"],
                "features": [],
            },
            headers=get_auth_headers(user["token"]),
        )
        assert resp.status_code == 201
        body = resp.json()
        assert body["nonRefundableRate"] == 170.0

    async def test_create_room_type_without_non_refundable_rate(self, client, cleanup_database):
        user = await create_test_user()
        await create_test_hotel(str(user["id"]))

        resp = await client.post(
            "/admin/room-types",
            json={
                "name": "Flex Only Room",
                "description": "Room without non-refundable rate",
                "baseRate": 100.0,
                "maxOccupancy": 2,
                "totalRooms": 3,
                "bedType": "Queen",
                "amenities": [],
                "features": [],
            },
            headers=get_auth_headers(user["token"]),
        )
        assert resp.status_code == 201
        body = resp.json()
        assert body["nonRefundableRate"] is None

    async def test_update_non_refundable_rate(self, client, hotel_with_rooms):
        user = hotel_with_rooms["user"]
        room = hotel_with_rooms["room"]

        resp = await client.patch(
            f"/admin/room-types/{room['id']}",
            json={"nonRefundableRate": 120.0},
            headers=get_auth_headers(user["token"]),
        )
        assert resp.status_code == 200
        assert resp.json()["nonRefundableRate"] == 120.0

    async def test_clear_non_refundable_rate(self, client, cleanup_database):
        user = await create_test_user()
        hotel = await create_test_hotel(str(user["id"]))
        room = await create_test_room_type(str(hotel["id"]), non_refundable_rate=130.0)

        # Verify it was set
        resp = await client.get(
            f"/admin/room-types/{room['id']}",
            headers=get_auth_headers(user["token"]),
        )
        assert resp.json()["nonRefundableRate"] == 130.0

        # Clear it by setting to null
        resp2 = await client.patch(
            f"/admin/room-types/{room['id']}",
            json={"nonRefundableRate": None},
            headers=get_auth_headers(user["token"]),
        )
        assert resp2.status_code == 200
        assert resp2.json()["nonRefundableRate"] is None

    async def test_cannot_access_other_hotels_room(self, client, hotel_with_rooms):
        """A second hotel user cannot access the first hotel's rooms."""
        other_user = await create_test_user()
        await create_test_hotel(str(other_user["id"]))

        room = hotel_with_rooms["room"]
        resp = await client.get(
            f"/admin/room-types/{room['id']}",
            headers=get_auth_headers(other_user["token"]),
        )
        assert resp.status_code == 404

    async def test_create_room_defaults_flexible_cancellation_type_to_free(
        self, client, cleanup_database
    ):
        user = await create_test_user()
        await create_test_hotel(str(user["id"]))

        resp = await client.post(
            "/admin/room-types",
            json={
                "name": "Default Room",
                "description": "",
                "baseRate": 100.0,
                "maxOccupancy": 2,
                "totalRooms": 1,
                "bedType": "Queen",
                "amenities": [],
                "features": [],
            },
            headers=get_auth_headers(user["token"]),
        )
        assert resp.status_code == 201
        body = resp.json()
        assert body["flexibleCancellationType"] == "free"
        assert body["partialRefundCancelWindowDays"] == 30
        assert body["partialRefundAmountPercent"] == 50

    async def test_update_to_partial_refund_cancellation_type(self, client, hotel_with_rooms):
        user = hotel_with_rooms["user"]
        room = hotel_with_rooms["room"]

        resp = await client.patch(
            f"/admin/room-types/{room['id']}",
            json={
                "flexibleCancellationType": "partial_refund",
                "partialRefundCancelWindowDays": 14,
                "partialRefundAmountPercent": 75,
            },
            headers=get_auth_headers(user["token"]),
        )
        assert resp.status_code == 200
        body = resp.json()
        assert body["flexibleCancellationType"] == "partial_refund"
        assert body["partialRefundCancelWindowDays"] == 14
        assert body["partialRefundAmountPercent"] == 75

    async def test_invalid_flexible_cancellation_type_rejected(self, client, hotel_with_rooms):
        user = hotel_with_rooms["user"]
        room = hotel_with_rooms["room"]

        resp = await client.patch(
            f"/admin/room-types/{room['id']}",
            json={"flexibleCancellationType": "bogus"},
            headers=get_auth_headers(user["token"]),
        )
        assert resp.status_code == 422

    async def test_invalid_partial_refund_percent_rejected(self, client, hotel_with_rooms):
        user = hotel_with_rooms["user"]
        room = hotel_with_rooms["room"]

        resp = await client.patch(
            f"/admin/room-types/{room['id']}",
            json={"partialRefundAmountPercent": 150},
            headers=get_auth_headers(user["token"]),
        )
        assert resp.status_code == 422

    async def test_patch_triggers_channex_cancellation_push(self, client, hotel_with_rooms):
        """Changing flexible-cancellation fields fires the Channex sync."""
        user = hotel_with_rooms["user"]
        room = hotel_with_rooms["room"]

        with patch(
            "app.routers.admin_room_types.push_cancellation_policy_for_room_type",
            new_callable=AsyncMock,
        ) as push:
            resp = await client.patch(
                f"/admin/room-types/{room['id']}",
                json={"flexibleCancellationType": "partial_refund"},
                headers=get_auth_headers(user["token"]),
            )
            assert resp.status_code == 200
            # asyncio.create_task schedules but may not complete before
            # the request returns; await any pending task explicitly.
            import asyncio

            await asyncio.sleep(0)
            push.assert_awaited_once()
            assert push.await_args.args[1] == str(room["id"])

    async def test_patch_unrelated_field_does_not_trigger_channex_push(
        self, client, hotel_with_rooms
    ):
        """A PATCH that doesn't touch cancellation fields skips the sync."""
        user = hotel_with_rooms["user"]
        room = hotel_with_rooms["room"]

        with patch(
            "app.routers.admin_room_types.push_cancellation_policy_for_room_type",
            new_callable=AsyncMock,
        ) as push:
            resp = await client.patch(
                f"/admin/room-types/{room['id']}",
                json={"name": "Renamed"},
                headers=get_auth_headers(user["token"]),
            )
            assert resp.status_code == 200
            import asyncio

            await asyncio.sleep(0)
            push.assert_not_awaited()

    async def test_patch_meal_plans_triggers_channex_reprovision(self, client, hotel_with_rooms):
        """Adding a meal plan re-provisions Channex (so breakfast variants
        like 'BDC Standard (Breakfast)' get created) and pushes ARI."""
        user = hotel_with_rooms["user"]
        room = hotel_with_rooms["room"]

        with (
            patch(
                "app.routers.admin_room_types.provision_property",
                new_callable=AsyncMock,
            ) as provision,
            patch(
                "app.routers.admin_room_types.push_ari_for_hotel",
                new_callable=AsyncMock,
            ) as ari,
        ):
            resp = await client.patch(
                f"/admin/room-types/{room['id']}",
                json={"mealPlans": [{"code": 1, "surcharge": 100000, "chargePer": "person"}]},
                headers=get_auth_headers(user["token"]),
            )
            assert resp.status_code == 200
            import asyncio

            await asyncio.sleep(0)
            provision.assert_awaited_once()
            ari.assert_awaited_once()
            assert provision.await_args.args[0] == str(room["hotel_id"])

    async def test_patch_meal_plans_swallows_no_connection_error(self, client, hotel_with_rooms):
        """ValueError from provision_property (no Channex connection) is
        swallowed silently — meal plans on hotels without a CM still save."""
        user = hotel_with_rooms["user"]
        room = hotel_with_rooms["room"]

        with (
            patch(
                "app.routers.admin_room_types.provision_property",
                new_callable=AsyncMock,
                side_effect=ValueError("No active Channex connection"),
            ),
            patch(
                "app.routers.admin_room_types.push_ari_for_hotel",
                new_callable=AsyncMock,
            ) as ari,
        ):
            resp = await client.patch(
                f"/admin/room-types/{room['id']}",
                json={"mealPlans": [{"code": 1, "surcharge": 100000}]},
                headers=get_auth_headers(user["token"]),
            )
            assert resp.status_code == 200
            import asyncio

            await asyncio.sleep(0)
            ari.assert_not_awaited()

    async def test_patch_unrelated_field_does_not_trigger_meal_plan_resync(
        self, client, hotel_with_rooms
    ):
        """PATCH without mealPlans should NOT re-provision."""
        user = hotel_with_rooms["user"]
        room = hotel_with_rooms["room"]

        with patch(
            "app.routers.admin_room_types.provision_property",
            new_callable=AsyncMock,
        ) as provision:
            resp = await client.patch(
                f"/admin/room-types/{room['id']}",
                json={"name": "Renamed"},
                headers=get_auth_headers(user["token"]),
            )
            assert resp.status_code == 200
            import asyncio

            await asyncio.sleep(0)
            provision.assert_not_awaited()


# ── Admin Bookings ────────────────────────────────────────────────


class TestAdminBookings:
    async def test_list_bookings_empty(self, client, cleanup_database):
        user = await create_test_user()
        await create_test_hotel(str(user["id"]))

        resp = await client.get(
            "/admin/bookings",
            headers=get_auth_headers(user["token"]),
        )
        assert resp.status_code == 200
        body = resp.json()
        assert body["bookings"] == []
        assert body["total"] == 0

    async def test_create_admin_booking_above_max_stay_is_blocked(self, client, cleanup_database):
        import json

        from app.database import Database

        user = await create_test_user()
        hotel = await create_test_hotel(str(user["id"]))
        room_type = await create_test_room_type(str(hotel["id"]))
        room = await create_test_room(str(hotel["id"]), str(room_type["id"]))
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
            json.dumps(seasons),
            room_type["id"],
        )

        resp = await client.post(
            "/admin/bookings",
            headers=get_auth_headers(user["token"]),
            json={
                "roomId": str(room["id"]),
                "guestFirstName": "Test",
                "guestLastName": "User",
                "guestEmail": "test@example.com",
                "checkIn": "2026-08-10",
                "checkOut": "2026-08-15",
                "adults": 1,
                "children": 0,
            },
        )
        assert resp.status_code == 400
        assert "maximum stay of 3 nights" in resp.json()["detail"].lower()

    async def test_update_admin_booking_above_max_stay_is_blocked(self, client, cleanup_database):
        import json

        from app.database import Database

        user = await create_test_user()
        hotel = await create_test_hotel(str(user["id"]))
        room_type = await create_test_room_type(str(hotel["id"]))
        booking = await create_test_booking(
            str(hotel["id"]),
            str(room_type["id"]),
            check_in="2026-08-10",
            check_out="2026-08-12",
        )
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
            json.dumps(seasons),
            room_type["id"],
        )

        resp = await client.patch(
            f"/admin/bookings/{booking['id']}",
            headers=get_auth_headers(user["token"]),
            json={"checkOut": "2026-08-15"},
        )
        assert resp.status_code == 400
        assert "maximum stay of 3 nights" in resp.json()["detail"].lower()

    async def test_list_bookings(self, client, hotel_with_booking):
        user = hotel_with_booking["user"]

        resp = await client.get(
            "/admin/bookings",
            headers=get_auth_headers(user["token"]),
        )
        assert resp.status_code == 200
        body = resp.json()
        assert body["total"] == 1
        assert len(body["bookings"]) == 1
        assert body["bookings"][0]["guestEmail"] == "Hidden until you accept"
        assert body["bookings"][0]["guestPhone"] == "Hidden until you accept"

    async def test_fixed_plan_sees_pending_booking_contact(self, client, hotel_with_booking):
        user = hotel_with_booking["user"]

        with patch(
            "app.routers.admin_bookings.fetch_guest_contact_plan",
            AsyncMock(return_value="fixed"),
        ):
            resp = await client.get(
                "/admin/bookings",
                headers=get_auth_headers(user["token"]),
            )

        assert resp.status_code == 200
        assert resp.json()["bookings"][0]["guestEmail"] == "guest@example.com"

    async def test_payment_alone_does_not_reveal_pending_contact(self, client, hotel_with_booking):
        from app.database import Database

        user = hotel_with_booking["user"]
        booking = hotel_with_booking["booking"]
        await Database.execute(
            "UPDATE bookings SET payment_status = 'captured' WHERE id = $1",
            booking["id"],
        )

        resp = await client.get(
            f"/admin/bookings/{booking['id']}",
            headers=get_auth_headers(user["token"]),
        )

        assert resp.status_code == 200
        assert resp.json()["guestEmail"] == "Hidden until you accept"

    async def test_pending_commission_edit_preserves_hidden_contact(
        self, client, hotel_with_booking
    ):
        from app.database import Database

        user = hotel_with_booking["user"]
        booking = hotel_with_booking["booking"]

        resp = await client.patch(
            f"/admin/bookings/{booking['id']}",
            headers=get_auth_headers(user["token"]),
            json={
                "guestFirstName": "Updated",
                "guestEmail": "Hidden until you accept",
                "guestPhone": "Hidden until you accept",
            },
        )

        assert resp.status_code == 200
        assert resp.json()["guestFirstName"] == "Updated"
        assert resp.json()["guestEmail"] == "Hidden until you accept"
        stored = await Database.fetchrow(
            "SELECT guest_email, guest_phone FROM bookings WHERE id = $1",
            booking["id"],
        )
        assert stored["guest_email"] == "guest@example.com"
        assert stored["guest_phone"] == "+1234567890"

    async def test_accepted_commission_edit_can_update_contact(self, client, hotel_with_booking):
        from app.database import Database

        user = hotel_with_booking["user"]
        booking = hotel_with_booking["booking"]
        await Database.execute(
            "UPDATE bookings SET status = 'confirmed' WHERE id = $1",
            booking["id"],
        )

        resp = await client.patch(
            f"/admin/bookings/{booking['id']}",
            headers=get_auth_headers(user["token"]),
            json={"guestEmail": "updated@example.test", "guestPhone": "+4987654321"},
        )

        assert resp.status_code == 200
        assert resp.json()["guestEmail"] == "updated@example.test"
        assert resp.json()["guestPhone"] == "+4987654321"

    async def test_list_bookings_filter_status(self, client, hotel_with_booking):
        user = hotel_with_booking["user"]

        resp = await client.get(
            "/admin/bookings?status=pending",
            headers=get_auth_headers(user["token"]),
        )
        assert resp.status_code == 200
        assert resp.json()["total"] == 1

        resp2 = await client.get(
            "/admin/bookings?status=confirmed",
            headers=get_auth_headers(user["token"]),
        )
        assert resp2.json()["total"] == 0

    async def test_get_booking(self, client, hotel_with_booking):
        user = hotel_with_booking["user"]
        booking = hotel_with_booking["booking"]

        resp = await client.get(
            f"/admin/bookings/{booking['id']}",
            headers=get_auth_headers(user["token"]),
        )
        assert resp.status_code == 200
        body = resp.json()
        assert body["guestFirstName"] == "John"
        assert body["guestLastName"] == "Doe"
        assert body["status"] == "pending"

    async def test_get_booking_not_found(self, client, cleanup_database):
        user = await create_test_user()
        await create_test_hotel(str(user["id"]))

        resp = await client.get(
            "/admin/bookings/00000000-0000-0000-0000-000000000000",
            headers=get_auth_headers(user["token"]),
        )
        assert resp.status_code == 404

    async def test_confirm_booking(self, client, hotel_with_booking):
        user = hotel_with_booking["user"]
        booking = hotel_with_booking["booking"]

        resp = await client.patch(
            f"/admin/bookings/{booking['id']}/status",
            json={"status": "confirmed"},
            headers=get_auth_headers(user["token"]),
        )
        assert resp.status_code == 200
        assert resp.json()["status"] == "confirmed"
        assert resp.json()["guestEmail"] == "guest@example.com"

        cancelled = await client.patch(
            f"/admin/bookings/{booking['id']}/status",
            json={"status": "cancelled"},
            headers=get_auth_headers(user["token"]),
        )
        assert cancelled.status_code == 200
        assert cancelled.json()["guestEmail"] == "guest@example.com"

    async def test_cancel_booking(self, client, hotel_with_booking):
        user = hotel_with_booking["user"]
        booking = hotel_with_booking["booking"]

        resp = await client.patch(
            f"/admin/bookings/{booking['id']}/status",
            json={"status": "cancelled"},
            headers=get_auth_headers(user["token"]),
        )
        assert resp.status_code == 200
        assert resp.json()["status"] == "cancelled"

    async def test_complete_check_in_persists_pending_flags(self, client, hotel_with_booking):
        user = hotel_with_booking["user"]
        booking = hotel_with_booking["booking"]

        await client.patch(
            f"/admin/bookings/{booking['id']}/status",
            json={"status": "confirmed"},
            headers=get_auth_headers(user["token"]),
        )
        resp = await client.post(
            f"/admin/bookings/{booking['id']}/check-in",
            json={"pendingFlags": ["Guest 2 ID", "Payment EUR 600"]},
            headers=get_auth_headers(user["token"]),
        )

        assert resp.status_code == 200
        body = resp.json()
        assert body["status"] == "checked_in"
        assert body["checkInPendingFlags"] == ["Guest 2 ID", "Payment EUR 600"]
        assert body["checkedInAt"]

    async def test_mark_paid_and_arrival_charge_update_booking(self, client, hotel_with_booking):
        user = hotel_with_booking["user"]
        booking = hotel_with_booking["booking"]

        paid = await client.post(
            f"/admin/bookings/{booking['id']}/mark-paid",
            headers=get_auth_headers(user["token"]),
        )
        assert paid.status_code == 200
        assert paid.json()["paymentStatus"] == "captured"

        charged = await client.post(
            f"/admin/bookings/{booking['id']}/arrival-charge",
            json={"amount": 25, "description": "Late arrival snack"},
            headers=get_auth_headers(user["token"]),
        )

        assert charged.status_code == 200
        assert charged.json()["totalAmount"] == 625
        assert charged.json()["paymentStatus"] == "unpaid"

    async def test_invalid_booking_status(self, client, hotel_with_booking):
        user = hotel_with_booking["user"]
        booking = hotel_with_booking["booking"]

        resp = await client.patch(
            f"/admin/bookings/{booking['id']}/status",
            json={"status": "invalid_status"},
            headers=get_auth_headers(user["token"]),
        )
        assert resp.status_code == 400

    async def test_checked_in_status_requires_check_in_endpoint(self, client, hotel_with_booking):
        user = hotel_with_booking["user"]
        booking = hotel_with_booking["booking"]

        resp = await client.patch(
            f"/admin/bookings/{booking['id']}/status",
            json={"status": "checked_in"},
            headers=get_auth_headers(user["token"]),
        )

        assert resp.status_code == 400
        assert "check-in endpoint" in resp.json()["detail"]

    async def test_list_bookings_pagination(self, client, cleanup_database):
        user = await create_test_user()
        hotel = await create_test_hotel(str(user["id"]))
        room = await create_test_room_type(str(hotel["id"]))

        # Create 3 bookings
        for i in range(3):
            await create_test_booking(
                str(hotel["id"]),
                str(room["id"]),
                check_in=f"2026-0{i + 7}-01",
                check_out=f"2026-0{i + 7}-05",
                guest_email=f"guest{i}@example.com",
            )

        resp = await client.get(
            "/admin/bookings?limit=2&offset=0",
            headers=get_auth_headers(user["token"]),
        )
        body = resp.json()
        assert body["total"] == 3
        assert len(body["bookings"]) == 2
        assert body["limit"] == 2
        assert body["offset"] == 0

        resp2 = await client.get(
            "/admin/bookings?limit=2&offset=2",
            headers=get_auth_headers(user["token"]),
        )
        body2 = resp2.json()
        assert len(body2["bookings"]) == 1


# ── Hotel Deletion ────────────────────────────────────────────────


class TestHotelDeletionImpact:
    async def test_no_bookings_no_channels(self, client, cleanup_database):
        user = await create_test_user()
        await create_test_hotel(str(user["id"]))

        resp = await client.get(
            "/admin/hotel/deletion-impact",
            headers=get_auth_headers(user["token"]),
        )
        assert resp.status_code == 200
        body = resp.json()
        assert body["upcomingBookingsCount"] == 0
        assert body["connectedChannelsCount"] == 0

    async def test_counts_upcoming_bookings(self, client, cleanup_database):
        from datetime import date, timedelta

        user = await create_test_user()
        hotel = await create_test_hotel(str(user["id"]))
        room = await create_test_room_type(str(hotel["id"]))

        future_in = (date.today() + timedelta(days=10)).isoformat()
        future_out = (date.today() + timedelta(days=12)).isoformat()
        past_in = (date.today() - timedelta(days=20)).isoformat()
        past_out = (date.today() - timedelta(days=18)).isoformat()

        await create_test_booking(
            str(hotel["id"]),
            str(room["id"]),
            check_in=future_in,
            check_out=future_out,
            guest_email="future@example.com",
        )
        await create_test_booking(
            str(hotel["id"]),
            str(room["id"]),
            check_in=future_in,
            check_out=future_out,
            guest_email="cancelled@example.com",
            status="cancelled",
        )
        await create_test_booking(
            str(hotel["id"]),
            str(room["id"]),
            check_in=past_in,
            check_out=past_out,
            guest_email="past@example.com",
        )

        resp = await client.get(
            "/admin/hotel/deletion-impact",
            headers=get_auth_headers(user["token"]),
        )
        # Cancelled and past bookings excluded; only the one upcoming counts.
        assert resp.json()["upcomingBookingsCount"] == 1


class TestDeleteHotel:
    async def test_delete_owned_hotel(self, client, cleanup_database):
        user = await create_test_user()
        hotel = await create_test_hotel(str(user["id"]))

        resp = await client.delete(
            "/admin/hotel",
            headers=get_auth_headers(user["token"]),
        )
        assert resp.status_code == 204

        # Subsequent GET is a 404 because no hotel exists for the user
        # (setup-status would auto-create one — use a direct repo lookup
        # via the admin endpoint instead).
        from app.repositories.hotel_repo import HotelRepository

        assert await HotelRepository.get_by_id(str(hotel["id"])) is None

    async def test_delete_cascades_bookings(self, client, cleanup_database):
        user = await create_test_user()
        hotel = await create_test_hotel(str(user["id"]))
        room = await create_test_room_type(str(hotel["id"]))
        await create_test_booking(str(hotel["id"]), str(room["id"]))

        resp = await client.delete(
            "/admin/hotel",
            headers=get_auth_headers(user["token"]),
        )
        assert resp.status_code == 204

        from app.database import Database

        remaining = await Database.fetchval(
            "SELECT COUNT(*) FROM bookings WHERE hotel_id = $1", str(hotel["id"])
        )
        assert remaining == 0

    async def test_delete_other_users_hotel_forbidden(self, client, cleanup_database):
        owner = await create_test_user()
        owned = await create_test_hotel(str(owner["id"]))
        attacker = await create_test_user()

        resp = await client.delete(
            "/admin/hotel",
            headers={
                **get_auth_headers(attacker["token"]),
                "X-Hotel-Id": str(owned["id"]),
            },
        )
        # X-Hotel-Id mismatch — 403 from get_hotel_id ownership check
        assert resp.status_code == 403

    async def test_delete_calls_channex_when_connected(self, client, cleanup_database):
        user = await create_test_user()
        hotel = await create_test_hotel(str(user["id"]))

        from app.repositories.channex_mapping_repo import ChannexConnectionRepository

        await ChannexConnectionRepository.upsert(str(hotel["id"]))
        await ChannexConnectionRepository.set_property_id(
            str(hotel["id"]), "11111111-1111-1111-1111-111111111111"
        )

        with (
            patch(
                "app.services.channex_service.delete_property",
                new=AsyncMock(return_value=None),
            ) as mock_delete,
            patch(
                "app.services.channex_service.get_platform_api_key",
                return_value="test-key",
            ),
        ):
            resp = await client.delete(
                "/admin/hotel",
                headers=get_auth_headers(user["token"]),
            )

        assert resp.status_code == 204
        mock_delete.assert_awaited_once()
        # Called with the configured property id and force=True
        args, kwargs = mock_delete.call_args
        assert str(args[1]) == "11111111-1111-1111-1111-111111111111"
        assert kwargs.get("force") is True

    async def test_delete_succeeds_even_if_channex_fails(self, client, cleanup_database):
        user = await create_test_user()
        hotel = await create_test_hotel(str(user["id"]))

        from app.repositories.channex_mapping_repo import ChannexConnectionRepository

        await ChannexConnectionRepository.upsert(str(hotel["id"]))
        await ChannexConnectionRepository.set_property_id(
            str(hotel["id"]), "11111111-1111-1111-1111-111111111111"
        )

        with (
            patch(
                "app.services.channex_service.delete_property",
                new=AsyncMock(side_effect=Exception("Channex 500")),
            ),
            patch(
                "app.services.channex_service.get_platform_api_key",
                return_value="test-key",
            ),
        ):
            resp = await client.delete(
                "/admin/hotel",
                headers=get_auth_headers(user["token"]),
            )

        # The user has been warned manual OTA cleanup may be needed —
        # don't block the local delete on a Channex hiccup.
        assert resp.status_code == 204
        from app.repositories.hotel_repo import HotelRepository

        assert await HotelRepository.get_by_id(str(hotel["id"])) is None
