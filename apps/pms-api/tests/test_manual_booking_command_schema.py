"""VAY-1248 legacy manual-booking command schema invariants."""

import json
from datetime import date

import asyncpg
import pytest
from app.database import Database

from tests.conftest import (
    create_test_booking,
    create_test_hotel,
    create_test_room,
    create_test_room_type,
    create_test_user,
)


async def _stay(executor, booking: dict, room: dict, room_type: dict, **overrides) -> dict:
    values = {
        "booking_id": booking["id"],
        "hotel_id": booking["hotel_id"],
        "position": 1,
        "room_id": room["id"],
        "room_type_id": room_type["id"],
        "check_in": date(2026, 9, 1),
        "check_out": date(2026, 9, 4),
        "adults": 2,
        "children": 0,
        "rate_plan_id": "flexible:room_only",
        "currency": "EUR",
    }
    values.update(overrides)
    row = await executor.fetchrow(
        """
        INSERT INTO manual_booking_stays (
            booking_id, hotel_id, position, room_id, room_type_id,
            check_in, check_out, adults, children, rate_plan_id, currency
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
        RETURNING *
        """,
        *values.values(),
    )
    return dict(row)


async def _booking_setup():
    user = await create_test_user()
    hotel = await create_test_hotel(str(user["id"]))
    room_type = await create_test_room_type(str(hotel["id"]))
    room = await create_test_room(str(hotel["id"]), str(room_type["id"]), "A1")
    booking = await create_test_booking(str(hotel["id"]), str(room_type["id"]))
    return hotel, room_type, room, booking


class TestManualBookingCommandSchema:
    async def test_stores_exact_nights_and_rejects_reparenting(self, cleanup_database):
        hotel, first_type, first_room, booking = await _booking_setup()
        second_type = await create_test_room_type(str(hotel["id"]), name="Studio", max_occupancy=2)
        second_room = await create_test_room(str(hotel["id"]), str(second_type["id"]), "B1")

        pool = await Database.get_pool()
        async with pool.acquire() as conn, conn.transaction():
            first = await _stay(conn, booking, first_room, first_type)
            second = await _stay(
                conn,
                booking,
                second_room,
                second_type,
                position=2,
                check_in=date(2026, 9, 2),
                check_out=date(2026, 9, 5),
                adults=1,
                children=1,
                rate_plan_id="non_refundable:breakfast",
            )
            await conn.execute(
                """
                INSERT INTO manual_booking_stay_nights
                    (stay_id, service_date, standard_amount, applied_amount)
                VALUES ($1, '2026-09-01', 150.00, 140.00),
                       ($1, '2026-09-02', 175.00, 165.00),
                       ($1, '2026-09-03', 175.00, 165.00),
                       ($2, '2026-09-02', 90.00, 90.00),
                       ($2, '2026-09-03', 90.00, 90.00),
                       ($2, '2026-09-04', 95.00, 95.00)
                """,
                first["id"],
                second["id"],
            )
        with pytest.raises(asyncpg.CheckViolationError):
            async with pool.acquire() as conn, conn.transaction():
                await conn.execute(
                    "DELETE FROM manual_booking_stay_nights WHERE stay_id = $1 AND service_date = '2026-09-02'",
                    second["id"],
                )
                await conn.execute(
                    "UPDATE manual_booking_stay_nights SET stay_id = $1 WHERE stay_id = $2 AND service_date = '2026-09-02'",
                    second["id"],
                    first["id"],
                )
        stays = await Database.fetch(
            """SELECT position, room_id, room_type_id, check_in, check_out,
                      adults, children, rate_plan_id, currency
               FROM manual_booking_stays WHERE booking_id = $1 ORDER BY position""",
            booking["id"],
        )
        nights = await Database.fetchval(
            "SELECT COUNT(*) FROM manual_booking_stay_nights WHERE stay_id = $1",
            first["id"],
        )
        assert [row["position"] for row in stays] == [1, 2]
        assert stays[1]["room_type_id"] == second_type["id"]
        assert stays[1]["adults"] == 1
        assert stays[1]["children"] == 1
        assert stays[1]["rate_plan_id"] == "non_refundable:breakfast"
        assert nights == 3

    @pytest.mark.parametrize(
        "method",
        ["pay_at_property", "bank_transfer", "manual_card", "cash", "other"],
    )
    async def test_expected_payment_method_round_trips(self, cleanup_database, method):
        _, _, _, booking = await _booking_setup()
        stored = await Database.fetchval(
            """UPDATE bookings SET expected_payment_method = $1
               WHERE id = $2 RETURNING expected_payment_method""",
            method,
            booking["id"],
        )
        assert stored == method

    async def test_historical_direct_stays_unknown_without_snapshots(self, cleanup_database):
        _, _, _, booking = await _booking_setup()
        row = await Database.fetchrow(
            """SELECT channel, manual_direct_source, expected_payment_method
               FROM bookings WHERE id = $1""",
            booking["id"],
        )
        stay_count = await Database.fetchval(
            "SELECT COUNT(*) FROM manual_booking_stays WHERE booking_id = $1",
            booking["id"],
        )
        assert dict(row) == {
            "channel": "direct",
            "manual_direct_source": "unknown",
            "expected_payment_method": "unknown",
        }
        assert stay_count == 0

    async def test_rejects_cross_property_room(self, cleanup_database):
        _, _, _, booking = await _booking_setup()
        other_user = await create_test_user()
        other_hotel = await create_test_hotel(str(other_user["id"]))
        other_type = await create_test_room_type(str(other_hotel["id"]))
        other_room = await create_test_room(str(other_hotel["id"]), str(other_type["id"]), "X1")

        with pytest.raises(asyncpg.ForeignKeyViolationError):
            await _stay(Database, booking, other_room, other_type)

    @pytest.mark.parametrize(
        "overrides",
        [
            {"position": 0},
            {"check_out": date(2026, 9, 1)},
            {"adults": 0},
            {"children": -1},
            {"currency": "eur"},
        ],
    )
    async def test_rejects_invalid_stay_evidence(self, cleanup_database, overrides):
        _, room_type, room, booking = await _booking_setup()
        with pytest.raises(asyncpg.CheckViolationError):
            await _stay(Database, booking, room, room_type, **overrides)

    @pytest.mark.parametrize("bad_date", [None, date(2027, 1, 1)])
    async def test_requires_exact_service_night_coverage(self, cleanup_database, bad_date):
        _, room_type, room, booking = await _booking_setup()
        pool = await Database.get_pool()
        with pytest.raises(asyncpg.CheckViolationError):
            async with pool.acquire() as conn, conn.transaction():
                stay = await _stay(conn, booking, room, room_type)
                dates = [date(2026, 9, 1), date(2026, 9, 2)]
                if bad_date:
                    dates.append(bad_date)
                await conn.executemany(
                    """INSERT INTO manual_booking_stay_nights
                           (stay_id, service_date, applied_amount)
                       VALUES ($1, $2, 150.00)""",
                    [(stay["id"], service_date) for service_date in dates],
                )

    async def test_rejects_stay_currency_mismatch(self, cleanup_database):
        _, room_type, room, booking = await _booking_setup()
        with pytest.raises(asyncpg.ForeignKeyViolationError):
            await _stay(Database, booking, room, room_type, currency="USD")

    async def test_sources_and_commands_are_property_scoped(self, cleanup_database):
        hotel, _, _, booking = await _booking_setup()
        for source in ("call", "email", "whatsapp", "walk_in", "social_media", "other"):
            stored = await Database.fetchval(
                """UPDATE bookings SET manual_direct_source = $1
                   WHERE id = $2 RETURNING manual_direct_source""",
                source,
                booking["id"],
            )
            assert stored == source

        command_args = (
            hotel["id"],
            "cmd-1",
            "key-1",
            "a" * 64,
            booking["id"],
            '{"outcome":"created"}',
        )
        await Database.execute(
            """INSERT INTO manual_booking_commands (
                   hotel_id, command_id, idempotency_key, request_hash,
                   booking_id, result_snapshot, completed_at
               ) VALUES ($1, $2, $3, $4, $5, $6::jsonb, now())""",
            *command_args,
        )
        with pytest.raises(asyncpg.UniqueViolationError):
            await Database.execute(
                """INSERT INTO manual_booking_commands (
                       hotel_id, command_id, idempotency_key, request_hash
                   ) VALUES ($1, 'cmd-2', $2, $3)""",
                hotel["id"],
                "key-1",
                "b" * 64,
            )

        await Database.execute("DELETE FROM bookings WHERE id = $1", booking["id"])
        tombstone = await Database.fetchrow(
            """SELECT booking_id, idempotency_key, result_snapshot
               FROM manual_booking_commands WHERE hotel_id = $1""",
            hotel["id"],
        )
        assert tombstone["booking_id"] is None
        assert tombstone["idempotency_key"] == "key-1"
        assert json.loads(tombstone["result_snapshot"]) == {"outcome": "created"}
        with pytest.raises(asyncpg.UniqueViolationError):
            await Database.execute(
                """INSERT INTO manual_booking_commands (
                       hotel_id, command_id, idempotency_key, request_hash
                   ) VALUES ($1, 'cmd-3', 'key-1', $2)""",
                hotel["id"],
                "c" * 64,
            )
