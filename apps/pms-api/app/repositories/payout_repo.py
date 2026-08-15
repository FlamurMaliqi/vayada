from app.database import Database


class PayoutRepository:
    @staticmethod
    async def create(
        booking_id: str,
        recipient_type: str,
        recipient_id: str,
        amount: float,
        currency: str,
        scheduled_for,
    ) -> dict:
        row = await Database.fetchrow(
            """
            INSERT INTO payouts (
                booking_id, recipient_type, recipient_id,
                amount, currency, scheduled_for
            ) VALUES ($1, $2, $3, $4, $5, $6)
            RETURNING *
            """,
            booking_id,
            recipient_type,
            recipient_id,
            amount,
            currency,
            scheduled_for,
        )
        return dict(row)

    @staticmethod
    async def list_due_payouts(before_date) -> list[dict]:
        rows = await Database.fetch(
            """
            SELECT p.*, b.booking_reference
            FROM payouts p
            JOIN bookings b ON b.id = p.booking_id
            WHERE p.status = 'scheduled'
              AND p.scheduled_for <= $1
              AND NOT EXISTS (
                  SELECT 1 FROM payments pay
                  WHERE pay.booking_id = p.booking_id
                    AND pay.stripe_refund_status IN (
                        'creating', 'pending', 'requires_action', 'succeeded'
                    )
                    AND pay.stripe_refund_completed_at IS NULL
              )
            ORDER BY p.scheduled_for
            """,
            before_date,
        )
        return [dict(r) for r in rows]

    @staticmethod
    async def list_monthly_affiliate_payouts(month: int, year: int) -> list[dict]:
        rows = await Database.fetch(
            """
            SELECT p.*, b.booking_reference, b.check_out, b.status AS booking_status
            FROM payouts p
            JOIN bookings b ON b.id = p.booking_id
            WHERE p.recipient_type = 'affiliate'
              AND p.status = 'scheduled'
              AND EXTRACT(MONTH FROM p.scheduled_for) = $1
              AND EXTRACT(YEAR FROM p.scheduled_for) = $2
              AND b.status = 'confirmed'
              AND b.check_out < now()
              AND NOT EXISTS (
                  SELECT 1 FROM payments pay
                  WHERE pay.booking_id = p.booking_id
                    AND pay.stripe_refund_status IN (
                        'creating', 'pending', 'requires_action', 'succeeded'
                    )
                    AND pay.stripe_refund_completed_at IS NULL
              )
            ORDER BY p.scheduled_for
            """,
            month,
            year,
        )
        return [dict(r) for r in rows]

    @staticmethod
    async def update_status(
        payout_id: str,
        status: str,
        stripe_transfer_id: str | None = None,
        xendit_payout_id: str | None = None,
    ) -> dict:
        if stripe_transfer_id:
            row = await Database.fetchrow(
                """
                UPDATE payouts
                SET status = $2, stripe_transfer_id = $3,
                    completed_at = CASE WHEN $2 = 'completed' THEN now() ELSE completed_at END,
                    updated_at = now()
                WHERE id = $1
                RETURNING *
                """,
                payout_id,
                status,
                stripe_transfer_id,
            )
        elif xendit_payout_id:
            row = await Database.fetchrow(
                """
                UPDATE payouts
                SET status = $2, xendit_payout_id = $3,
                    completed_at = CASE WHEN $2 = 'completed' THEN now() ELSE completed_at END,
                    updated_at = now()
                WHERE id = $1
                RETURNING *
                """,
                payout_id,
                status,
                xendit_payout_id,
            )
        else:
            row = await Database.fetchrow(
                """
                UPDATE payouts
                SET status = $2,
                    completed_at = CASE WHEN $2 = 'completed' THEN now() ELSE completed_at END,
                    updated_at = now()
                WHERE id = $1
                RETURNING *
                """,
                payout_id,
                status,
            )
        return dict(row)

    @staticmethod
    async def claim_for_processing(payout_id: str) -> dict | None:
        pool = await Database.get_pool()
        async with pool.acquire() as conn, conn.transaction():
            payout = await conn.fetchrow("SELECT booking_id FROM payouts WHERE id = $1", payout_id)
            if not payout:
                return None
            await conn.fetchrow(
                "SELECT id FROM bookings WHERE id = $1 FOR UPDATE", payout["booking_id"]
            )
            if await conn.fetchval(
                """
                SELECT 1 FROM payments
                WHERE booking_id = $1
                  AND stripe_refund_status IN (
                      'creating', 'pending', 'requires_action', 'succeeded'
                  )
                  AND stripe_refund_completed_at IS NULL
                LIMIT 1
                """,
                payout["booking_id"],
            ):
                return None
            row = await conn.fetchrow(
                """
                UPDATE payouts
                SET status = 'processing', updated_at = now()
                WHERE id = $1 AND status = 'scheduled'
                RETURNING *
                """,
                payout_id,
            )
            return dict(row) if row else None

    @staticmethod
    async def increment_retry(payout_id: str, error: str) -> dict:
        """Increment retry count and store the last error. Revert status to 'scheduled' for retry."""
        row = await Database.fetchrow(
            """
            UPDATE payouts
            SET retry_count = COALESCE(retry_count, 0) + 1,
                last_error = $2,
                status = 'scheduled',
                updated_at = now()
            WHERE id = $1
            RETURNING *
            """,
            payout_id,
            error,
        )
        return dict(row)

    @staticmethod
    async def list_processing_xendit(older_than_minutes: int = 30) -> list[dict]:
        """List Xendit payouts stuck in 'processing' for longer than the threshold."""
        rows = await Database.fetch(
            """
            SELECT * FROM payouts
            WHERE status = 'processing'
              AND xendit_payout_id IS NOT NULL
              AND updated_at < now() - make_interval(mins => $1)
            ORDER BY updated_at
            """,
            older_than_minutes,
        )
        return [dict(r) for r in rows]

    @staticmethod
    async def cancel_by_booking(booking_id: str) -> None:
        await Database.execute(
            """
            UPDATE payouts SET status = 'failed', updated_at = now()
            WHERE booking_id = $1 AND status = 'scheduled'
            """,
            booking_id,
        )

    @staticmethod
    async def delete_scheduled_by_booking(booking_id: str) -> None:
        """Remove an incomplete finalization attempt before it is retried."""
        await Database.execute(
            "DELETE FROM payouts WHERE booking_id = $1 AND status = 'scheduled'",
            booking_id,
        )

    @staticmethod
    async def list_by_hotel(
        hotel_id: str,
        *,
        status: str | None = None,
        limit: int = 50,
        offset: int = 0,
    ) -> list[dict]:
        conditions = ["b.hotel_id = $1"]
        args: list = [hotel_id]
        idx = 2

        if status:
            conditions.append(f"p.status = ${idx}")
            args.append(status)
            idx += 1

        where = " AND ".join(conditions)
        args.extend([limit, offset])
        rows = await Database.fetch(
            f"""
            SELECT p.*, b.booking_reference, b.guest_first_name, b.guest_last_name
            FROM payouts p
            JOIN bookings b ON b.id = p.booking_id
            WHERE {where}
            ORDER BY p.created_at DESC
            LIMIT ${idx} OFFSET ${idx + 1}
            """,
            *args,
        )
        return [dict(r) for r in rows]

    @staticmethod
    async def count_by_hotel(hotel_id: str, *, status: str | None = None) -> int:
        if status:
            count = await Database.fetchval(
                """
                SELECT COUNT(*) FROM payouts p
                JOIN bookings b ON b.id = p.booking_id
                WHERE b.hotel_id = $1 AND p.status = $2
                """,
                hotel_id,
                status,
            )
        else:
            count = await Database.fetchval(
                """
                SELECT COUNT(*) FROM payouts p
                JOIN bookings b ON b.id = p.booking_id
                WHERE b.hotel_id = $1
                """,
                hotel_id,
            )
        return count or 0
