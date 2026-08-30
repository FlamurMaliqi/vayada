from datetime import date

import asyncpg

from app.database import Database


class LinkedInventoryConflict(ValueError):
    pass


class LinkedInventoryGroupRepository:
    @staticmethod
    async def list_by_hotel_id(hotel_id: str) -> list[dict]:
        rows = await Database.fetch(
            """
            SELECT groups.id::text AS group_id,
                   groups.name,
                   array_agg(members.room_type_id::text ORDER BY room_types.sort_order, room_types.name)
                       AS member_room_type_ids
            FROM linked_inventory_groups groups
            JOIN linked_inventory_group_members members ON members.group_id = groups.id
            JOIN room_types ON room_types.id = members.room_type_id
            WHERE groups.hotel_id = $1
            GROUP BY groups.id, groups.name, groups.created_at
            ORDER BY groups.created_at, groups.name
            """,
            hotel_id,
        )
        return [dict(row) for row in rows]

    @staticmethod
    async def get_by_id(group_id: str, hotel_id: str) -> dict | None:
        row = await Database.fetchrow(
            """
            SELECT groups.id::text AS group_id,
                   groups.name,
                   array_agg(members.room_type_id::text ORDER BY room_types.sort_order, room_types.name)
                       AS member_room_type_ids
            FROM linked_inventory_groups groups
            JOIN linked_inventory_group_members members ON members.group_id = groups.id
            JOIN room_types ON room_types.id = members.room_type_id
            WHERE groups.id = $1 AND groups.hotel_id = $2
            GROUP BY groups.id, groups.name
            """,
            group_id,
            hotel_id,
        )
        return dict(row) if row else None

    @staticmethod
    async def create(hotel_id: str, name: str, member_room_type_ids: list[str]) -> dict:
        return await LinkedInventoryGroupRepository._write(
            hotel_id, None, name, member_room_type_ids
        )

    @staticmethod
    async def update(
        hotel_id: str,
        group_id: str,
        name: str,
        member_room_type_ids: list[str],
    ) -> dict | None:
        return await LinkedInventoryGroupRepository._write(
            hotel_id, group_id, name, member_room_type_ids
        )

    @staticmethod
    async def _write(
        hotel_id: str,
        group_id: str | None,
        name: str,
        member_room_type_ids: list[str],
    ) -> dict | None:
        if not name:
            raise LinkedInventoryConflict("Give the group a name")
        member_ids = list(dict.fromkeys(member_room_type_ids))
        if len(member_ids) < 2:
            raise LinkedInventoryConflict("Select at least two different room types")

        pool = await Database.get_pool()
        try:
            async with pool.acquire() as conn, conn.transaction():
                if group_id:
                    existing = await conn.fetchrow(
                        """
                        SELECT id FROM linked_inventory_groups
                        WHERE id = $1 AND hotel_id = $2
                        FOR UPDATE
                        """,
                        group_id,
                        hotel_id,
                    )
                    if not existing:
                        return None

                room_types = await conn.fetch(
                    """
                    SELECT id FROM room_types
                    WHERE hotel_id = $1 AND id = ANY($2::uuid[])
                    FOR UPDATE
                    """,
                    hotel_id,
                    member_ids,
                )
                if len(room_types) != len(member_ids):
                    raise LinkedInventoryConflict("Every room type must belong to this hotel")

                membership_conflict = await conn.fetchval(
                    """
                    SELECT EXISTS (
                        SELECT 1
                        FROM linked_inventory_group_members members
                        JOIN linked_inventory_groups groups ON groups.id = members.group_id
                        WHERE groups.hotel_id = $1
                          AND members.room_type_id = ANY($2::uuid[])
                          AND ($3::uuid IS NULL OR groups.id <> $3)
                    )
                    """,
                    hotel_id,
                    member_ids,
                    group_id,
                )
                if membership_conflict:
                    raise LinkedInventoryConflict("A room type already belongs to another group")

                if group_id:
                    await conn.execute(
                        """
                        UPDATE linked_inventory_groups
                        SET name = $1, updated_at = now()
                        WHERE id = $2
                        """,
                        name,
                        group_id,
                    )
                    await conn.execute(
                        "DELETE FROM linked_inventory_group_members WHERE group_id = $1",
                        group_id,
                    )
                else:
                    group_id = str(
                        await conn.fetchval(
                            """
                            INSERT INTO linked_inventory_groups (hotel_id, name)
                            VALUES ($1, $2)
                            RETURNING id
                            """,
                            hotel_id,
                            name,
                        )
                    )

                await conn.executemany(
                    """
                    INSERT INTO linked_inventory_group_members (group_id, room_type_id)
                    VALUES ($1, $2)
                    """,
                    [(group_id, room_type_id) for room_type_id in member_ids],
                )
        except asyncpg.UniqueViolationError as exc:
            raise LinkedInventoryConflict("Group name and room types must be unique") from exc

        return await LinkedInventoryGroupRepository.get_by_id(group_id, hotel_id)

    @staticmethod
    async def delete(group_id: str, hotel_id: str) -> bool:
        deleted = await Database.fetchval(
            """
            DELETE FROM linked_inventory_groups
            WHERE id = $1 AND hotel_id = $2
            RETURNING id
            """,
            group_id,
            hotel_id,
        )
        return deleted is not None

    @staticmethod
    async def list_member_ids_for_room_type(room_type_id: str) -> list[str]:
        rows = await Database.fetch(
            """
            SELECT siblings.room_type_id::text
            FROM linked_inventory_group_members source
            JOIN linked_inventory_group_members siblings ON siblings.group_id = source.group_id
            WHERE source.room_type_id = $1
            ORDER BY siblings.room_type_id
            """,
            room_type_id,
        )
        return [row["room_type_id"] for row in rows]

    @staticmethod
    async def has_activity(
        room_type_id: str,
        start_date: date,
        end_date: date,
        *,
        exclude_booking_id: str | None = None,
        exclude_block_id: str | None = None,
        include_soft_holds: bool = True,
    ) -> bool:
        """Whether any active booking, soft hold, or block stops this linked group."""
        return bool(
            await Database.fetchval(
                """
                WITH member_scope AS (
                    SELECT siblings.room_type_id
                    FROM linked_inventory_group_members source
                    JOIN linked_inventory_group_members siblings
                      ON siblings.group_id = source.group_id
                    WHERE source.room_type_id = $1
                )
                SELECT EXISTS (
                    SELECT 1
                    FROM bookings
                    WHERE room_type_id IN (SELECT room_type_id FROM member_scope)
                      AND status IN ('pending', 'confirmed', 'checked_in', 'in_house')
                      AND check_in < $3
                      AND check_out > $2
                      AND ($4::uuid IS NULL OR id <> $4)
                      AND NOT (
                          status = 'pending'
                          AND payment_status = 'unpaid'
                          AND created_at < NOW() - INTERVAL '30 minutes'
                      )
                    UNION ALL
                    SELECT 1
                    FROM booking_drafts
                    WHERE room_type_id IN (SELECT room_type_id FROM member_scope)
                      AND $6
                      AND check_in < $3
                      AND check_out > $2
                      AND expires_at > NOW()
                      AND materialized_booking_id IS NULL
                    UNION ALL
                    SELECT 1
                    FROM room_blocks
                    WHERE room_type_id IN (SELECT room_type_id FROM member_scope)
                      AND start_date < $3
                      AND end_date > $2
                      AND ($5::uuid IS NULL OR id <> $5)
                )
                """,
                room_type_id,
                start_date,
                end_date,
                exclude_booking_id,
                exclude_block_id,
                include_soft_holds,
            )
        )
