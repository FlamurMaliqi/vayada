from unittest.mock import AsyncMock, patch

import pytest
from app.services.channex.ari_push import AriPushResult, push_availability_for_room_type

from tests.conftest import (
    create_test_booking,
    create_test_hotel,
    create_test_room_block,
    create_test_room_type,
    create_test_user,
    get_auth_headers,
)


async def create_group(client, user, name: str, room_type_ids: list[str]):
    with patch(
        "app.routers.admin_linked_inventory.push_ari_for_hotel",
        new=AsyncMock(return_value=True),
    ):
        return await client.post(
            "/admin/linked-inventory-groups",
            json={"name": name, "memberRoomTypeIds": room_type_ids},
            headers=get_auth_headers(user["token"]),
        )


class TestLinkedInventoryGroups:
    async def test_group_crud(self, client, cleanup_database):
        user = await create_test_user()
        hotel = await create_test_hotel(str(user["id"]))
        room_types = [
            await create_test_room_type(str(hotel["id"]), name=f"Option {index}")
            for index in range(3)
        ]
        headers = get_auth_headers(user["token"])

        created = await create_group(
            client,
            user,
            "Family options",
            [str(room_types[0]["id"]), str(room_types[1]["id"])],
        )
        assert created.status_code == 201
        group_id = created.json()["groupId"]

        listed = await client.get("/admin/linked-inventory-groups", headers=headers)
        assert listed.status_code == 200
        assert listed.json() == [created.json()]

        guarded_delete = await client.delete(
            f"/admin/room-types/{room_types[0]['id']}", headers=headers
        )
        assert guarded_delete.status_code == 409

        with patch(
            "app.routers.admin_linked_inventory.push_ari_for_hotel",
            new=AsyncMock(return_value=True),
        ):
            updated = await client.put(
                f"/admin/linked-inventory-groups/{group_id}",
                json={
                    "name": "Updated options",
                    "memberRoomTypeIds": [
                        str(room_types[1]["id"]),
                        str(room_types[2]["id"]),
                    ],
                },
                headers=headers,
            )
            deleted = await client.delete(
                f"/admin/linked-inventory-groups/{group_id}", headers=headers
            )

        assert updated.status_code == 200
        assert updated.json()["name"] == "Updated options"
        assert deleted.status_code == 204
        assert (await client.get("/admin/linked-inventory-groups", headers=headers)).json() == []

    @pytest.mark.parametrize("cause", ["booking", "block"])
    async def test_any_member_activity_stops_every_group_member(
        self, client, cleanup_database, cause
    ):
        user = await create_test_user()
        hotel = await create_test_hotel(str(user["id"]))
        first = await create_test_room_type(str(hotel["id"]), name="One bedroom", total_rooms=2)
        second = await create_test_room_type(str(hotel["id"]), name="Two bedrooms", total_rooms=2)
        created = await create_group(
            client,
            user,
            "Same apartment",
            [str(first["id"]), str(second["id"])],
        )
        assert created.status_code == 201

        if cause == "booking":
            await create_test_booking(
                str(hotel["id"]),
                str(first["id"]),
                check_in="2026-10-01",
                check_out="2026-10-03",
            )
        else:
            await create_test_room_block(
                str(hotel["id"]),
                str(first["id"]),
                start_date="2026-10-01",
                end_date="2026-10-03",
            )

        response = await client.get(
            f"/api/hotels/{hotel['slug']}/rooms",
            params={"check_in": "2026-10-01", "check_out": "2026-10-03"},
        )
        unavailable = await client.get(
            "/admin/linked-inventory-groups/unavailable-room-type-ids",
            params={"check_in": "2026-10-01", "check_out": "2026-10-03"},
            headers=get_auth_headers(user["token"]),
        )

        assert response.status_code == 200
        assert {room["name"]: room["remainingRooms"] for room in response.json()} == {
            "One bedroom": 0,
            "Two bedrooms": 0,
        }
        assert unavailable.status_code == 200
        assert unavailable.json() == [str(first["id"]), str(second["id"])]

        with patch(
            "app.routers.admin_linked_inventory.push_ari_for_hotel",
            new=AsyncMock(return_value=True),
        ):
            deleted = await client.delete(
                f"/admin/linked-inventory-groups/{created.json()['groupId']}",
                headers=get_auth_headers(user["token"]),
            )
        assert deleted.status_code == 204

        reopened = await client.get(
            f"/api/hotels/{hotel['slug']}/rooms",
            params={"check_in": "2026-10-01", "check_out": "2026-10-03"},
        )
        assert {room["name"]: room["remainingRooms"] for room in reopened.json()} == {
            "One bedroom": 1,
            "Two bedrooms": 2,
        }

    async def test_admin_date_and_status_changes_respect_linked_stop_sell(
        self, client, cleanup_database
    ):
        user = await create_test_user()
        hotel = await create_test_hotel(str(user["id"]))
        first = await create_test_room_type(str(hotel["id"]), name="One bedroom")
        second = await create_test_room_type(str(hotel["id"]), name="Two bedrooms")
        created = await create_group(
            client,
            user,
            "Same apartment",
            [str(first["id"]), str(second["id"])],
        )
        assert created.status_code == 201

        await create_test_booking(
            str(hotel["id"]),
            str(second["id"]),
            check_in="2026-10-01",
            check_out="2026-10-03",
        )
        booking_to_move = await create_test_booking(
            str(hotel["id"]),
            str(first["id"]),
            check_in="2026-10-10",
            check_out="2026-10-12",
        )
        cancelled = await create_test_booking(
            str(hotel["id"]),
            str(first["id"]),
            check_in="2026-10-01",
            check_out="2026-10-03",
            status="cancelled",
        )
        headers = get_auth_headers(user["token"])

        moved = await client.patch(
            f"/admin/bookings/{booking_to_move['id']}",
            json={"checkIn": "2026-10-01", "checkOut": "2026-10-03"},
            headers=headers,
        )
        reactivated = await client.patch(
            f"/admin/bookings/{cancelled['id']}/status",
            json={"status": "confirmed"},
            headers=headers,
        )

        assert moved.status_code == 409
        assert reactivated.status_code == 409


async def test_channex_push_expands_to_every_linked_room_type():
    single_push = AsyncMock(return_value=AriPushResult(True))
    with (
        patch(
            "app.services.channex.ari_push.LinkedInventoryGroupRepository.list_member_ids_for_room_type",
            new=AsyncMock(return_value=["room-a", "room-b"]),
        ),
        patch("app.services.channex.ari_push._push_availability_for_room_type", single_push),
    ):
        result = await push_availability_for_room_type(
            "hotel-1", "room-a", start_date=None, end_date=None
        )

    assert result == AriPushResult(True)
    assert [call.args[1] for call in single_push.await_args_list] == ["room-a", "room-b"]


async def test_channex_fan_out_attempts_every_member_after_failure():
    single_push = AsyncMock(
        side_effect=[AriPushResult(False, "room-a failed"), AriPushResult(True)]
    )
    with (
        patch(
            "app.services.channex.ari_push.LinkedInventoryGroupRepository.list_member_ids_for_room_type",
            new=AsyncMock(return_value=["room-a", "room-b"]),
        ),
        patch("app.services.channex.ari_push._push_availability_for_room_type", single_push),
    ):
        result = await push_availability_for_room_type("hotel-1", "room-a")

    assert result == AriPushResult(False, "room-a failed")
    assert [call.args[1] for call in single_push.await_args_list] == ["room-a", "room-b"]
