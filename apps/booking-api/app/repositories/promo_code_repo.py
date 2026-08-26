"""
Repository for booking_promo_codes table (Database).
"""

from datetime import date

from app.database import Database


class PromoCodeRepository:
    @staticmethod
    async def list_by_hotel_id(hotel_id: str) -> list[dict]:
        rows = await Database.fetch(
            "SELECT * FROM booking_promo_codes WHERE hotel_id = $1 ORDER BY created_at DESC",
            hotel_id,
        )
        return [dict(row) for row in rows]

    @staticmethod
    async def get_by_id(promo_id: str, hotel_id: str) -> dict | None:
        row = await Database.fetchrow(
            "SELECT * FROM booking_promo_codes WHERE id = $1 AND hotel_id = $2",
            promo_id,
            hotel_id,
        )
        return dict(row) if row else None

    @staticmethod
    async def get_by_code(code: str, hotel_id: str) -> dict | None:
        row = await Database.fetchrow(
            "SELECT * FROM booking_promo_codes WHERE code = $1 AND hotel_id = $2",
            code.upper(),
            hotel_id,
        )
        return dict(row) if row else None

    @staticmethod
    async def create(
        hotel_id: str,
        code: str,
        discount_type: str = "percentage",
        discount_value: float = 0,
        min_booking_value: float | None = None,
        applicable_room_ids: list[str] | None = None,
        valid_from: date | None = None,
        valid_until: date | None = None,
        stay_date_from: date | None = None,
        stay_date_until: date | None = None,
        is_active: bool = True,
        max_uses: int = 1,
    ) -> dict:
        query = """
            INSERT INTO booking_promo_codes
                (hotel_id, code, discount_type, discount_value, min_booking_value,
                 applicable_room_ids, valid_from, valid_until, stay_date_from,
                 stay_date_until, is_active, max_uses)
            VALUES ($1, $2, $3, $4, $5, $6::uuid[], $7, $8, $9, $10, $11, $12)
            RETURNING *
        """
        row = await Database.fetchrow(
            query,
            hotel_id,
            code.upper(),
            discount_type,
            discount_value,
            min_booking_value,
            applicable_room_ids,
            valid_from,
            valid_until,
            stay_date_from,
            stay_date_until,
            is_active,
            max_uses,
        )
        return dict(row)

    @staticmethod
    async def update(promo_id: str, hotel_id: str, updates: dict) -> dict | None:
        if not updates:
            return None

        set_clauses = []
        values = []
        idx = 1
        for col, val in updates.items():
            set_clauses.append(f"{col} = ${idx}")
            values.append(val)
            idx += 1

        set_clauses.append("updated_at = now()")
        query = (
            f"UPDATE booking_promo_codes SET {', '.join(set_clauses)} "
            f"WHERE id = ${idx} AND hotel_id = ${idx + 1} "
            f"RETURNING *"
        )
        values.append(promo_id)
        values.append(hotel_id)

        row = await Database.fetchrow(query, *values)
        return dict(row) if row else None

    @staticmethod
    async def delete(promo_id: str, hotel_id: str) -> bool:
        result = await Database.execute(
            "DELETE FROM booking_promo_codes WHERE id = $1 AND hotel_id = $2",
            promo_id,
            hotel_id,
        )
        return result == "DELETE 1"

    @staticmethod
    async def redeem(
        promo_id: str,
        redemption_key: str,
        *,
        check_in: date,
        room_type_id: str,
        booking_total: float,
        property_date: date,
    ) -> bool:
        row = await Database.fetchrow(
            """
            WITH locked AS (
                SELECT id
                FROM booking_promo_codes
                WHERE id = $1
                  AND is_active = true
                  AND current_uses < max_uses
                  AND (valid_from IS NULL OR valid_from <= $6)
                  AND (valid_until IS NULL OR valid_until >= $6)
                  AND (stay_date_from IS NULL OR stay_date_from <= $3)
                  AND (stay_date_until IS NULL OR stay_date_until >= $3)
                  AND (
                    COALESCE(cardinality(applicable_room_ids), 0) = 0
                    OR $4::uuid = ANY(applicable_room_ids)
                  )
                  AND (min_booking_value IS NULL OR min_booking_value <= $5)
                FOR UPDATE
            ), inserted AS (
                INSERT INTO booking_promo_redemptions (promo_id, redemption_key)
                SELECT id, $2 FROM locked
                ON CONFLICT (redemption_key) DO NOTHING
                RETURNING promo_id
            )
            UPDATE booking_promo_codes promo
               SET current_uses = current_uses + 1, updated_at = now()
              FROM inserted
             WHERE promo.id = inserted.promo_id
            RETURNING promo.id
            """,
            promo_id,
            redemption_key,
            check_in,
            room_type_id,
            booking_total,
            property_date,
        )
        return row is not None

    @staticmethod
    async def has_active_redemption(promo_id: str, redemption_key: str) -> bool:
        return bool(
            await Database.fetchval(
                """
                SELECT 1
                FROM booking_promo_redemptions
                WHERE promo_id = $1 AND redemption_key = $2 AND status = 'active'
                """,
                promo_id,
                redemption_key,
            )
        )

    @staticmethod
    async def reverse_redemption(hotel_id: str, redemption_key: str) -> bool:
        row = await Database.fetchrow(
            """
            WITH reversed AS (
                INSERT INTO booking_promo_redemptions (
                    promo_id, redemption_key, status, reversed_at
                ) VALUES (NULL, $1, 'reversed', now())
                ON CONFLICT (redemption_key) DO UPDATE
                   SET status = 'reversed', reversed_at = now()
                RETURNING promo_id
            ), scoped AS (
                SELECT reversed.promo_id
                  FROM reversed
                  JOIN booking_promo_codes scoped_promo
                    ON scoped_promo.id = reversed.promo_id
                   AND scoped_promo.hotel_id = $2
            )
            UPDATE booking_promo_codes promo
               SET current_uses = GREATEST(current_uses - 1, 0), updated_at = now()
              FROM scoped
             WHERE promo.id = scoped.promo_id
            RETURNING promo.id
            """,
            redemption_key,
            hotel_id,
        )
        return row is not None
