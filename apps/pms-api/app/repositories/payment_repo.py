from app.database import Database


class PaymentRepository:
    @staticmethod
    async def create(
        booking_id: str,
        amount: float,
        currency: str,
        payment_method: str,
        stripe_pi_id: str | None = None,
        stripe_account_id: str | None = None,
        stripe_application_fee_amount: float = 0,
        stripe_platform_fee_amount: float = 0,
        stripe_affiliate_commission_amount: float = 0,
        xendit_invoice_id: str | None = None,
        xendit_invoice_url: str | None = None,
        payment_purpose: str = "booking",
    ) -> dict:
        row = await Database.fetchrow(
            """
            INSERT INTO payments (
                booking_id, amount, currency, payment_method,
                stripe_payment_intent_id, stripe_account_id,
                stripe_application_fee_amount, stripe_platform_fee_amount,
                stripe_affiliate_commission_amount, xendit_invoice_id,
                xendit_invoice_url, status, payment_purpose
            ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
            RETURNING *
            """,
            booking_id,
            amount,
            currency,
            payment_method,
            stripe_pi_id,
            stripe_account_id,
            stripe_application_fee_amount,
            stripe_platform_fee_amount,
            stripe_affiliate_commission_amount,
            xendit_invoice_id,
            xendit_invoice_url,
            "pending",
            payment_purpose,
        )
        return dict(row)

    @staticmethod
    async def get_by_booking_id(booking_id: str) -> dict | None:
        row = await Database.fetchrow(
            "SELECT * FROM payments WHERE booking_id = $1 ORDER BY created_at DESC LIMIT 1",
            booking_id,
        )
        return dict(row) if row else None

    @staticmethod
    async def get_deposit_by_booking_id(booking_id: str) -> dict | None:
        row = await Database.fetchrow(
            """
            SELECT * FROM payments
            WHERE booking_id = $1
              AND payment_purpose = 'deposit'
            ORDER BY created_at DESC
            LIMIT 1
            """,
            booking_id,
        )
        return dict(row) if row else None

    @staticmethod
    async def get_by_xendit_invoice(xendit_invoice_id: str) -> dict | None:
        row = await Database.fetchrow(
            "SELECT * FROM payments WHERE xendit_invoice_id = $1",
            xendit_invoice_id,
        )
        return dict(row) if row else None

    @staticmethod
    async def get_by_stripe_pi(stripe_pi_id: str) -> dict | None:
        row = await Database.fetchrow(
            "SELECT * FROM payments WHERE stripe_payment_intent_id = $1",
            stripe_pi_id,
        )
        return dict(row) if row else None

    @staticmethod
    async def get_by_id(payment_id: str) -> dict | None:
        row = await Database.fetchrow("SELECT * FROM payments WHERE id = $1", payment_id)
        return dict(row) if row else None

    @staticmethod
    async def get_by_stripe_refund(stripe_refund_id: str) -> dict | None:
        row = await Database.fetchrow(
            "SELECT * FROM payments WHERE stripe_refund_id = $1",
            stripe_refund_id,
        )
        return dict(row) if row else None

    @staticmethod
    async def prepare_stripe_refund(
        payment_id: str,
        *,
        command_id: str,
        target_status: str,
        target_booking_status: str,
        expected_booking_status: str,
        refund_amount: float,
        refund_percentage: float,
        refund_amount_minor: int,
        refund_currency: str,
    ) -> dict | None:
        pool = await Database.get_pool()
        async with pool.acquire() as conn, conn.transaction():
            current = await conn.fetchrow("SELECT * FROM payments WHERE id = $1", payment_id)
            if not current:
                return None
            booking = await conn.fetchrow(
                "SELECT status, finalization_token, stripe_refund_processing "
                "FROM bookings WHERE id = $1 FOR UPDATE",
                current["booking_id"],
            )
            if (
                not booking
                or booking["status"] != expected_booking_status
                or booking["finalization_token"] is not None
                or (
                    booking["stripe_refund_processing"]
                    and current["stripe_refund_command_id"] != command_id
                )
            ):
                return None
            if await conn.fetchval(
                "SELECT 1 FROM payouts WHERE booking_id = $1 "
                "AND status IN ('processing', 'completed') LIMIT 1",
                current["booking_id"],
            ):
                return None
            if current["stripe_refund_command_id"] not in (None, command_id) and current[
                "stripe_refund_status"
            ] not in ("failed", "canceled"):
                return None

            await conn.execute(
                "UPDATE bookings SET stripe_refund_processing = true, updated_at = now() "
                "WHERE id = $1",
                current["booking_id"],
            )
            same_command = current["stripe_refund_command_id"] == command_id
            row = await conn.fetchrow(
                """
                UPDATE payments
                SET stripe_refund_id = CASE WHEN $10 THEN stripe_refund_id ELSE NULL END,
                    stripe_refund_status = CASE WHEN $10 THEN stripe_refund_status ELSE 'creating' END,
                    stripe_refund_payouts_cancelled_at = CASE WHEN $10 THEN stripe_refund_payouts_cancelled_at ELSE NULL END,
                    stripe_refund_channex_cancelled_at = CASE WHEN $10 THEN stripe_refund_channex_cancelled_at ELSE NULL END,
                    stripe_refund_ari_handoff_completed_at = CASE WHEN $10 THEN stripe_refund_ari_handoff_completed_at ELSE NULL END,
                    stripe_refund_completed_at = CASE WHEN $10 THEN stripe_refund_completed_at ELSE NULL END,
                    stripe_refund_command_id = $2,
                    stripe_refund_target_status = $3,
                    stripe_refund_target_booking_status = $4,
                    stripe_refund_expected_booking_status = $5,
                    stripe_refund_percentage = $6,
                    refund_amount = $7,
                    stripe_refund_amount_minor = $8,
                    stripe_refund_currency = $9,
                    updated_at = now()
                WHERE id = $1
                RETURNING *
                """,
                payment_id,
                command_id,
                target_status,
                target_booking_status,
                expected_booking_status,
                refund_percentage,
                refund_amount,
                refund_amount_minor,
                refund_currency,
                same_command,
            )
            return dict(row)

    @staticmethod
    async def attach_stripe_refund(
        payment_id: str,
        command_id: str,
        stripe_refund_id: str,
        provider_status: str,
    ) -> dict | None:
        row = await Database.fetchrow(
            """
            UPDATE payments
            SET stripe_refund_id = $3,
                stripe_refund_status = CASE
                    WHEN stripe_refund_status IN ('succeeded', 'failed', 'canceled')
                        THEN stripe_refund_status
                    ELSE $4
                END,
                updated_at = now()
            WHERE id = $1
              AND stripe_refund_command_id = $2
              AND (stripe_refund_id IS NULL OR stripe_refund_id = $3)
            RETURNING *
            """,
            payment_id,
            command_id,
            stripe_refund_id,
            provider_status,
        )
        return dict(row) if row else None

    @staticmethod
    async def update_stripe_refund_status(
        stripe_refund_id: str, provider_status: str
    ) -> dict | None:
        row = await Database.fetchrow(
            """
            UPDATE payments
            SET stripe_refund_status = CASE
                    WHEN stripe_refund_status IN ('succeeded', 'failed', 'canceled')
                        THEN stripe_refund_status
                    ELSE $2
                END,
                updated_at = now()
            WHERE stripe_refund_id = $1
            RETURNING *
            """,
            stripe_refund_id,
            provider_status,
        )
        return dict(row) if row else None

    @staticmethod
    async def has_active_stripe_refund(booking_id: str) -> bool:
        return bool(
            await Database.fetchval(
                """
                SELECT 1 FROM payments
                WHERE booking_id = $1
                  AND (
                        stripe_refund_status IN ('creating', 'pending', 'requires_action')
                     OR (
                            stripe_refund_status = 'succeeded'
                        AND stripe_refund_completed_at IS NULL
                     )
                  )
                LIMIT 1
                """,
                booking_id,
            )
        )

    @staticmethod
    async def mark_stripe_refund_effect(payment_id: str, effect: str) -> dict | None:
        columns = {
            "payouts": "stripe_refund_payouts_cancelled_at",
            "channex": "stripe_refund_channex_cancelled_at",
            "ari": "stripe_refund_ari_handoff_completed_at",
        }
        column = columns.get(effect)
        if not column:
            raise ValueError(f"Unknown Stripe refund effect: {effect}")
        row = await Database.fetchrow(
            f"""
            UPDATE payments
            SET {column} = COALESCE({column}, now()), updated_at = now()
            WHERE id = $1
            RETURNING *
            """,
            payment_id,
        )
        return dict(row) if row else None

    @staticmethod
    async def complete_stripe_refund(payment_id: str) -> dict | None:
        row = await Database.fetchrow(
            """
            UPDATE payments
            SET stripe_refund_completed_at = COALESCE(stripe_refund_completed_at, now()),
                updated_at = now()
            WHERE id = $1
              AND stripe_refund_status = 'succeeded'
              AND stripe_refund_payouts_cancelled_at IS NOT NULL
              AND stripe_refund_channex_cancelled_at IS NOT NULL
              AND stripe_refund_ari_handoff_completed_at IS NOT NULL
            RETURNING *
            """,
            payment_id,
        )
        return dict(row) if row else None

    @staticmethod
    async def list_by_booking_ids(booking_ids: list[str]) -> list[dict]:
        if not booking_ids:
            return []
        rows = await Database.fetch(
            """
            SELECT * FROM payments
            WHERE booking_id = ANY($1::uuid[])
            ORDER BY created_at ASC
            """,
            booking_ids,
        )
        return [dict(r) for r in rows]

    @staticmethod
    async def list_by_hotel(
        hotel_id: str,
        *,
        limit: int = 50,
        offset: int = 0,
    ) -> list[dict]:
        rows = await Database.fetch(
            """
            SELECT p.*, b.booking_reference, b.guest_first_name,
                   b.guest_last_name, b.created_at AS booking_created_at
            FROM payments p
            JOIN bookings b ON b.id = p.booking_id
            WHERE b.hotel_id = $1
            ORDER BY p.created_at DESC
            LIMIT $2 OFFSET $3
            """,
            hotel_id,
            limit,
            offset,
        )
        return [dict(r) for r in rows]

    @staticmethod
    async def count_by_hotel(hotel_id: str) -> int:
        count = await Database.fetchval(
            """
            SELECT COUNT(*) FROM payments p
            JOIN bookings b ON b.id = p.booking_id
            WHERE b.hotel_id = $1
            """,
            hotel_id,
        )
        return count or 0

    @staticmethod
    async def create_manual(
        booking_id: str,
        amount: float,
        currency: str,
        payment_method: str,
        reference: str | None = None,
        recorded_by: str | None = None,
        payment_purpose: str = "booking",
    ) -> dict:
        """Record a payment that was made offline (cash, bank transfer, …).

        Goes straight to status='captured' since the operator is logging
        money already received.
        """
        row = await Database.fetchrow(
            """
            INSERT INTO payments (
                booking_id, amount, currency, payment_method,
                status, reference, recorded_by, captured_at, payment_purpose
            ) VALUES ($1, $2, $3, $4, 'captured', $5, $6, now(), $7)
            RETURNING *
            """,
            booking_id,
            amount,
            currency,
            payment_method,
            reference,
            recorded_by,
            payment_purpose,
        )
        return dict(row)

    @staticmethod
    async def list_for_hotel_currency_conversion(hotel_id: str) -> list[dict]:
        """Minimal projection used when re-denominating payments on a
        hotel currency change (VAY-335)."""
        rows = await Database.fetch(
            """
            SELECT p.id, p.amount, p.refund_amount, p.currency
            FROM payments p
            JOIN bookings b ON b.id = p.booking_id
            WHERE b.hotel_id = $1
            """,
            hotel_id,
        )
        return [dict(r) for r in rows]

    @staticmethod
    async def update_amounts_and_currency(
        payment_id: str,
        *,
        amount: float,
        refund_amount: float | None,
        currency: str,
    ) -> None:
        await Database.execute(
            """
            UPDATE payments
            SET amount = $2,
                refund_amount = $3,
                currency = $4,
                updated_at = now()
            WHERE id = $1
            """,
            payment_id,
            amount,
            refund_amount,
            currency,
        )

    @staticmethod
    async def update_status(payment_id: str, status: str, **kwargs) -> dict:
        sets = ["status = $2", "updated_at = now()"]
        args = [payment_id, status]
        idx = 3

        for key in ("captured_at", "refunded_at", "refund_amount", "card_last_four", "card_brand"):
            if key in kwargs:
                sets.append(f"{key} = ${idx}")
                args.append(kwargs[key])
                idx += 1

        row = await Database.fetchrow(
            f"UPDATE payments SET {', '.join(sets)} WHERE id = $1 RETURNING *",
            *args,
        )
        return dict(row)
