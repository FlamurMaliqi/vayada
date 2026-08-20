import json
import secrets
import string

from asyncpg import Connection

from app.database import Database
from app.services import hotel_identity_service
from app.utils import generate_unique_code


async def _overlay_canonical_hotel_name(booking: dict) -> dict:
    """Replace the JOIN'd ``hotel_name`` with the authoritative one from
    booking_db so renames in the booking engine flow through to emails
    and other guest-facing copy. Falls back to the local value (the
    JOIN against pms.hotels) when booking_db is unreachable or the row
    is missing — better stale than blank."""
    canonical = await hotel_identity_service.get_name(booking["hotel_id"])
    if canonical:
        booking["hotel_name"] = canonical
    return booking


def _make_booking_ref() -> str:
    chars = string.ascii_uppercase + string.digits
    suffix = "".join(secrets.choice(chars) for _ in range(6))
    return f"VAY-{suffix}"


class BookingRepository:
    @staticmethod
    async def create(data: dict) -> dict:
        # If the caller passed a pre-generated reference (VAY-388 draft
        # materialization keeps the same code across draft + booking),
        # use it; otherwise generate a fresh unique one.
        ref = data.get("booking_reference")
        if not ref:

            async def ref_exists(ref: str) -> bool:
                return bool(
                    await Database.fetchval(
                        "SELECT 1 FROM bookings WHERE booking_reference = $1", ref
                    )
                )

            ref = await generate_unique_code(
                _make_booking_ref, ref_exists, entity_name="booking reference"
            )

        # Allow callers (VAY-388 draft materialization) to pre-allocate
        # the booking id so they can stamp it on the draft *before* the
        # INSERT, keeping the atomic-claim → insert sequence consistent.
        row = await Database.fetchrow(
            """
            INSERT INTO bookings (
                id,
                hotel_id, room_type_id, booking_reference,
                guest_first_name, guest_last_name, guest_email, guest_phone,
                special_requests, estimated_arrival_time, number_of_guests,
                check_in, check_out,
                adults, children, nightly_rate, total_amount, currency,
                affiliate_id, referral_code,
                room_id, channel, status,
                payment_method, payment_status, host_response_deadline,
                rate_type, addon_ids, addon_names, addon_total, addon_quantities,
                addon_dates,
                promo_code, promo_discount,
                last_minute_discount_percent, last_minute_discount_amount,
                guest_country, number_of_rooms,
                deposit_required, deposit_percentage, deposit_amount, balance_amount,
                contact_details_revealed_at
            ) VALUES (
                COALESCE($37::uuid, uuid_generate_v4()),
                $1, $2, $3, $4, $5, $6, $7, $8, $9, $10,
                $11, $12, $13, $14, $15, $16, $17, $18, $19,
                $20, $21, $22, $23, $24, $25, $26, $27, $28, $29, $30,
                $31, $32, $33, $34, $35, $36, $38,
                $39, $40, $41, $42,
                CASE
                    WHEN $22 IN ('confirmed', 'checked_in', 'in_house', 'checked_out', 'no_show')
                    THEN now()
                    ELSE NULL
                END
            ) RETURNING *
            """,
            data["hotel_id"],
            data["room_type_id"],
            ref,
            data["guest_first_name"],
            data["guest_last_name"],
            data["guest_email"],
            data["guest_phone"],
            data.get("special_requests", ""),
            data.get("estimated_arrival_time"),
            data.get("number_of_guests"),
            data["check_in"],
            data["check_out"],
            data.get("adults", 1),
            data.get("children", 0),
            data["nightly_rate"],
            data["total_amount"],
            data["currency"],
            data.get("affiliate_id"),
            data.get("referral_code"),
            data.get("room_id"),
            data.get("channel", "direct"),
            data.get("status", "pending"),
            data.get("payment_method", "card"),
            data.get("payment_status", "unpaid"),
            data.get("host_response_deadline"),
            data.get("rate_type", "flexible"),
            json.dumps(data.get("addon_ids", [])),
            json.dumps(data.get("addon_names", [])),
            data.get("addon_total", 0),
            json.dumps(data.get("addon_quantities", {})),
            json.dumps(data.get("addon_dates", {})),
            data.get("promo_code"),
            data.get("promo_discount", 0),
            data.get("last_minute_discount_percent", 0),
            data.get("last_minute_discount_amount", 0),
            data.get("guest_country", ""),
            data.get("id"),
            data.get("number_of_rooms", 1),
            data.get("deposit_required", False),
            data.get("deposit_percentage"),
            data.get("deposit_amount", 0),
            data.get("balance_amount", data["total_amount"]),
        )
        booking = dict(row)

        # VAY-403: the FIRST room stays in bookings.room_id (position 0).
        # Any additional rooms the guest paid for are recorded as extra
        # slots so every one of them is blocked on the calendar and the
        # second room can't be sold to someone else.
        extra_room_ids = data.get("extra_room_ids") or []
        if extra_room_ids:
            from app.repositories.booking_room_repo import BookingRoomRepository

            await BookingRoomRepository.set_extra_rooms(str(booking["id"]), extra_room_ids)
        return booking

    @staticmethod
    async def get_by_id(booking_id: str) -> dict | None:
        row = await Database.fetchrow(
            """
            SELECT b.*, rt.name AS room_name, rt.max_occupancy AS room_max_occupancy,
                   h.name AS hotel_name,
                   h.slug AS hotel_slug, rm.room_number
            FROM bookings b
            JOIN room_types rt ON rt.id = b.room_type_id
            JOIN hotels h ON h.id = b.hotel_id
            LEFT JOIN rooms rm ON rm.id = b.room_id
            WHERE b.id = $1
            """,
            booking_id,
        )
        if not row:
            return None
        return await _overlay_canonical_hotel_name(dict(row))

    @staticmethod
    async def lookup(booking_reference: str, guest_email: str) -> dict | None:
        row = await Database.fetchrow(
            """
            SELECT b.*, rt.name AS room_name, rt.max_occupancy AS room_max_occupancy,
                   h.name AS hotel_name,
                   h.slug AS hotel_slug, rm.room_number
            FROM bookings b
            JOIN room_types rt ON rt.id = b.room_type_id
            JOIN hotels h ON h.id = b.hotel_id
            LEFT JOIN rooms rm ON rm.id = b.room_id
            WHERE b.booking_reference = $1
              AND LOWER(b.guest_email) = LOWER($2)
            """,
            booking_reference,
            guest_email,
        )
        if not row:
            return None
        return await _overlay_canonical_hotel_name(dict(row))

    @staticmethod
    async def list_by_hotel_id(
        hotel_id: str,
        *,
        status: str | None = None,
        search: str | None = None,
        hide_unaccepted_guest_contact: bool = False,
        limit: int = 50,
        offset: int = 0,
    ) -> list[dict]:
        conditions = ["b.hotel_id = $1"]
        args: list = [hotel_id]
        idx = 2

        if status:
            conditions.append(f"b.status = ${idx}")
            args.append(status)
            idx += 1

        if search:
            email_search = f"b.guest_email ILIKE ${idx}"
            if hide_unaccepted_guest_contact:
                email_search = (
                    f"({email_search} AND ("
                    "b.contact_details_revealed_at IS NOT NULL"
                    " OR b.finalization_started_at IS NOT NULL"
                    " OR b.finalization_completed_at IS NOT NULL"
                    " OR b.status IN "
                    "('confirmed', 'checked_in', 'in_house', 'checked_out', 'no_show')"
                    "))"
                )
            conditions.append(
                f"(b.guest_first_name ILIKE ${idx}"
                f" OR b.guest_last_name ILIKE ${idx}"
                f" OR CONCAT(b.guest_first_name, ' ', b.guest_last_name) ILIKE ${idx}"
                f" OR b.booking_reference ILIKE ${idx}"
                f" OR {email_search}"
                f" OR rt.name ILIKE ${idx})"
            )
            args.append(f"%{search}%")
            idx += 1

        where = " AND ".join(conditions)
        args.extend([limit, offset])
        rows = await Database.fetch(
            f"""
            SELECT b.*, rt.name AS room_name, rt.max_occupancy AS room_max_occupancy,
                   rm.room_number
            FROM bookings b
            JOIN room_types rt ON rt.id = b.room_type_id
            LEFT JOIN rooms rm ON rm.id = b.room_id
            WHERE {where}
            ORDER BY b.created_at DESC
            LIMIT ${idx} OFFSET ${idx + 1}
            """,
            *args,
        )
        return [dict(r) for r in rows]

    @staticmethod
    async def count_by_hotel_id(hotel_id: str, *, status: str | None = None) -> int:
        if status:
            count = await Database.fetchval(
                "SELECT COUNT(*) FROM bookings WHERE hotel_id = $1 AND status = $2",
                hotel_id,
                status,
            )
        else:
            count = await Database.fetchval(
                "SELECT COUNT(*) FROM bookings WHERE hotel_id = $1", hotel_id
            )
        return count or 0

    @staticmethod
    async def list_by_hotel_in_range(hotel_id: str, start_date, end_date) -> list[dict]:
        rows = await Database.fetch(
            """
            SELECT b.*, rt.name AS room_name, rt.max_occupancy AS room_max_occupancy,
                   rm.room_number
            FROM bookings b
            JOIN room_types rt ON rt.id = b.room_type_id
            LEFT JOIN rooms rm ON rm.id = b.room_id
            WHERE b.hotel_id = $1
              AND b.status IN ('pending', 'confirmed', 'checked_in', 'in_house')
              AND b.check_in < $3
              AND b.check_out > $2
              AND NOT (
                b.status = 'pending'
                AND b.payment_status = 'unpaid'
                AND b.created_at < NOW() - INTERVAL '30 minutes'
              )
            ORDER BY b.check_in
            """,
            hotel_id,
            start_date,
            end_date,
        )
        return [dict(r) for r in rows]

    @staticmethod
    async def is_room_available(
        room_id: str,
        check_in,
        check_out,
        exclude_booking_id: str | None = None,
    ) -> bool:
        if exclude_booking_id:
            count = await Database.fetchval(
                """
                SELECT COUNT(*) FROM bookings
                WHERE room_id = $1
                  AND status IN ('pending', 'confirmed', 'checked_in', 'in_house')
                  AND check_in < $3
                  AND check_out > $2
                  AND id <> $4
                """,
                room_id,
                check_in,
                check_out,
                exclude_booking_id,
            )
        else:
            count = await Database.fetchval(
                """
                SELECT COUNT(*) FROM bookings
                WHERE room_id = $1
                  AND status IN ('pending', 'confirmed', 'checked_in', 'in_house')
                  AND check_in < $3
                  AND check_out > $2
                """,
                room_id,
                check_in,
                check_out,
            )
        return (count or 0) == 0

    @staticmethod
    async def is_room_available_excluding(
        room_id: str,
        check_in,
        check_out,
        exclude_booking_ids: list[str],
    ) -> bool:
        """Like is_room_available, but excludes any number of bookings.

        Used by the swap-room flow where two bookings are vacating the same
        room set at once and must not be counted against each other.
        """
        count = await Database.fetchval(
            """
            SELECT COUNT(*) FROM bookings
            WHERE room_id = $1
              AND status IN ('pending', 'confirmed', 'checked_in', 'in_house')
              AND check_in < $3
              AND check_out > $2
              AND id <> ALL($4::uuid[])
            """,
            room_id,
            check_in,
            check_out,
            exclude_booking_ids,
        )
        return (count or 0) == 0

    @staticmethod
    async def swap_room_assignments(
        booking_a_id: str,
        new_room_a_id: str | None,
        booking_b_id: str,
        new_room_b_id: str | None,
    ) -> None:
        """Atomically reassign two bookings' room_ids in a single statement."""
        await Database.execute(
            """
            UPDATE bookings
            SET room_id = CASE id
                    WHEN $1::uuid THEN $2::uuid
                    WHEN $3::uuid THEN $4::uuid
                END,
                updated_at = now()
            WHERE id IN ($1::uuid, $3::uuid)
            """,
            booking_a_id,
            new_room_a_id,
            booking_b_id,
            new_room_b_id,
        )

    @staticmethod
    async def apply_room_moves(moves: list[tuple]) -> None:
        """Atomically reassign N bookings' room_ids in a single statement.

        `moves` is a list of (booking_id, new_room_id) pairs. Used by the
        auto-rearrange solver (VAY-397) to apply the full set of moves it
        plans as one indivisible update — no partial application can leave
        the calendar in a double-booked state.
        """
        if not moves:
            return
        booking_ids = [m[0] for m in moves]
        new_room_ids = [m[1] for m in moves]
        await Database.execute(
            """
            UPDATE bookings AS b
            SET room_id = m.new_room_id::uuid,
                updated_at = now()
            FROM unnest($1::uuid[], $2::uuid[]) AS m(booking_id, new_room_id)
            WHERE b.id = m.booking_id
            """,
            booking_ids,
            new_room_ids,
        )

    @staticmethod
    async def list_movable_for_room_type(
        room_type_id: str,
        window_start,
        window_end,
    ) -> list[dict]:
        """Bookings of one room type whose stay window overlaps [start, end).

        Returns id, room_id, check_in, check_out, status. Used by the
        auto-rearrange solver to build its input set. Caller decides which
        rows are movable (typically: status='confirmed'/'pending' and stay
        hasn't started yet).
        """
        rows = await Database.fetch(
            """
            SELECT id, room_id, check_in, check_out, status
            FROM bookings
            WHERE room_type_id = $1
              AND status IN ('pending', 'confirmed', 'checked_in', 'in_house')
              AND check_in < $3
              AND check_out > $2
            """,
            room_type_id,
            window_start,
            window_end,
        )
        return [dict(r) for r in rows]

    @staticmethod
    async def list_unassigned_for_room_type(
        room_type_id: str,
        window_start,
        window_end,
    ) -> list[dict]:
        """Unassigned (room_id IS NULL) bookings of one room type whose stay
        window overlaps [start, end). Used by the cancellation-triggered
        auto-place sweep (VAY-397) to find candidates to re-place into a
        freshly-freed slot.
        """
        rows = await Database.fetch(
            """
            SELECT id, check_in, check_out
            FROM bookings
            WHERE room_type_id = $1
              AND room_id IS NULL
              AND status IN ('pending', 'confirmed', 'checked_in', 'in_house')
              AND check_in < $3
              AND check_out > $2
            ORDER BY check_in
            """,
            room_type_id,
            window_start,
            window_end,
        )
        return [dict(r) for r in rows]

    @staticmethod
    async def update_status(booking_id: str, new_status: str) -> dict | None:
        row = await Database.fetchrow(
            """
            UPDATE bookings
            SET status = $2,
                contact_details_revealed_at = CASE
                    WHEN $2 IN ('confirmed', 'checked_in', 'in_house', 'checked_out', 'no_show')
                    THEN COALESCE(contact_details_revealed_at, now())
                    ELSE contact_details_revealed_at
                END,
                updated_at = now()
            WHERE id = $1 AND NOT stripe_refund_processing
            RETURNING *
            """,
            booking_id,
            new_status,
        )
        return dict(row) if row else None

    @staticmethod
    async def transition_status(
        booking_id: str, expected_status: str, new_status: str
    ) -> dict | None:
        row = await Database.fetchrow(
            """
            UPDATE bookings SET status = $3, updated_at = now()
            WHERE id = $1 AND status = $2 AND stripe_refund_processing
            RETURNING *
            """,
            booking_id,
            expected_status,
            new_status,
        )
        return dict(row) if row else None

    @staticmethod
    async def complete_check_in(
        booking_id: str, pending_flags: list[str], conn: Connection | None = None
    ) -> dict | None:
        executor = conn or Database
        row = await executor.fetchrow(
            """
            UPDATE bookings
            SET status = 'checked_in',
                contact_details_revealed_at = COALESCE(contact_details_revealed_at, now()),
                check_in_pending_flags = $2::jsonb,
                checked_in_at = COALESCE(checked_in_at, now()),
                updated_at = now()
            WHERE id = $1 AND NOT stripe_refund_processing
            RETURNING *
            """,
            booking_id,
            json.dumps(pending_flags),
        )
        return dict(row) if row else None

    @staticmethod
    async def complete_check_out(booking_id: str, conn: Connection | None = None) -> dict | None:
        executor = conn or Database
        row = await executor.fetchrow(
            """
            UPDATE bookings
            SET status = 'checked_out',
                contact_details_revealed_at = COALESCE(contact_details_revealed_at, now()),
                checked_out_at = COALESCE(checked_out_at, now()),
                updated_at = now()
            WHERE id = $1
              AND status IN ('checked_in', 'in_house')
            RETURNING *
            """,
            booking_id,
        )
        return dict(row) if row else None

    @staticmethod
    async def add_arrival_charge(
        booking_id: str, amount: float, conn: Connection | None = None
    ) -> dict | None:
        executor = conn or Database
        row = await executor.fetchrow(
            """
            UPDATE bookings
            SET total_amount = total_amount + $2,
                balance_amount = balance_amount + $2,
                payment_status = CASE
                    WHEN payment_status = 'captured' THEN 'unpaid'
                    ELSE payment_status
                END,
                updated_at = now()
            WHERE id = $1
            RETURNING *
            """,
            booking_id,
            amount,
        )
        return dict(row) if row else None

    @staticmethod
    async def update_details(booking_id: str, updates: dict) -> dict | None:
        """Update booking fields dynamically."""
        from datetime import date

        ALLOWED = {
            "check_in",
            "check_out",
            "guest_first_name",
            "guest_last_name",
            "guest_email",
            "guest_phone",
            "guest_country",
            "guest_gender",
            "guest_date_of_birth",
            "guest_passport_number",
            "adults",
            "children",
            "nightly_rate",
            "addon_ids",
            "addon_names",
            "addon_total",
            "addon_quantities",
            "addon_dates",
            "special_requests",
        }
        filtered = {k: v for k, v in updates.items() if k in ALLOWED and v is not None}
        if not filtered:
            return await BookingRepository.get_by_id(booking_id)

        # Convert date strings to date objects for asyncpg
        for date_field in ("check_in", "check_out", "guest_date_of_birth"):
            if date_field in filtered and isinstance(filtered[date_field], str):
                filtered[date_field] = date.fromisoformat(filtered[date_field])
        for json_field in ("addon_ids", "addon_names", "addon_quantities", "addon_dates"):
            if json_field in filtered:
                filtered[json_field] = json.dumps(filtered[json_field])

        # Recalculate total if rate or dates changed
        set_clauses = []
        params = [booking_id]
        for i, (col, val) in enumerate(filtered.items(), start=2):
            set_clauses.append(f"{col} = ${i}")
            params.append(val)

        set_clauses.append("updated_at = now()")
        sql = f"UPDATE bookings SET {', '.join(set_clauses)} WHERE id = $1 RETURNING id"
        row = await Database.fetchrow(sql, *params)
        if not row:
            return None

        # Recalculate total_amount if dates or rate changed. Mirror the
        # booking-creation formula so addons and promo discount survive
        # an admin edit (the last-minute discount is already baked into
        # the stored nightly_rate).
        if (
            "check_in" in filtered
            or "check_out" in filtered
            or "nightly_rate" in filtered
            or "addon_total" in filtered
        ):
            current = await BookingRepository.get_by_id(booking_id)
            ci = date.fromisoformat(str(current["check_in"]))
            co = date.fromisoformat(str(current["check_out"]))
            nights = max(1, (co - ci).days)
            rate = float(current["nightly_rate"])
            rooms = int(current.get("number_of_rooms") or 1)
            addon_total = float(current.get("addon_total") or 0)
            promo_discount = float(current.get("promo_discount") or 0)
            total = round(rate * nights * rooms + addon_total - promo_discount, 2)
            await Database.execute(
                """UPDATE bookings
SET total_amount = $2,
    balance_amount = GREATEST($2 - COALESCE(deposit_amount, 0), 0),
    updated_at = now()
WHERE id = $1""",
                booking_id,
                total,
            )

        return await BookingRepository.get_by_id(booking_id)

    @staticmethod
    async def apply_change_request(
        booking_id: str,
        *,
        check_in,
        check_out,
        nightly_rate: float,
        addon_ids: list,
        addon_quantities: dict,
        addon_dates: dict,
        addon_names: list,
        addon_total: float,
        total_amount: float,
    ) -> dict | None:
        """Apply an approved guest change request to the booking row.

        Mutates dates, add-ons, nightly_rate, addon_total, and total_amount
        in one statement so the row never reflects a half-applied change.
        Promo discount and last-minute discount are intentionally left
        alone — they were locked in at booking time.
        """
        row = await Database.fetchrow(
            """
            UPDATE bookings
            SET check_in = $2,
                check_out = $3,
                nightly_rate = $4,
                addon_ids = $5::jsonb,
                addon_quantities = $6::jsonb,
                addon_dates = $7::jsonb,
                addon_names = $8::jsonb,
                addon_total = $9,
                total_amount = $10,
                balance_amount = GREATEST($10 - COALESCE(deposit_amount, 0), 0),
                updated_at = now()
            WHERE id = $1
            RETURNING *
            """,
            booking_id,
            check_in,
            check_out,
            nightly_rate,
            json.dumps(addon_ids),
            json.dumps(addon_quantities),
            json.dumps(addon_dates),
            json.dumps(addon_names),
            addon_total,
            total_amount,
        )
        return dict(row) if row else None

    @staticmethod
    async def update_payment_status(booking_id: str, payment_status: str) -> dict | None:
        row = await Database.fetchrow(
            """
            UPDATE bookings SET payment_status = $2, updated_at = now()
            WHERE id = $1
            RETURNING *
            """,
            booking_id,
            payment_status,
        )
        return dict(row) if row else None

    @staticmethod
    async def mark_balance_paid(booking_id: str) -> dict | None:
        row = await Database.fetchrow(
            """
            UPDATE bookings
            SET payment_status = 'captured',
                balance_amount = 0,
                updated_at = now()
            WHERE id = $1
            RETURNING *
            """,
            booking_id,
        )
        return dict(row) if row else None

    @staticmethod
    async def update_booking_accepted(
        booking_id: str,
        finalization_token: str,
        platform_fee: float,
        affiliate_commission: float,
        property_payout: float,
        payment_status: str,
    ) -> dict | None:
        row = await Database.fetchrow(
            """
            UPDATE bookings SET
                status = 'confirmed',
                contact_details_revealed_at = COALESCE(contact_details_revealed_at, now()),
                payment_status = $2,
                platform_fee_amount = $3,
                affiliate_commission_amount = $4,
                property_payout_amount = $5,
                updated_at = now()
            WHERE id = $1
              AND status = 'pending'
              AND finalization_token = $6
            RETURNING *
            """,
            booking_id,
            payment_status,
            platform_fee,
            affiliate_commission,
            property_payout,
            finalization_token,
        )
        return dict(row) if row else None

    @staticmethod
    async def claim_finalization(booking_id: str, finalization_token: str) -> bool:
        row = await Database.fetchrow(
            """
            UPDATE bookings
            SET finalization_started_at = now(),
                finalization_token = $2,
                updated_at = now()
            WHERE id = $1
              AND (
                  status = 'pending'
                  OR (status = 'confirmed' AND finalization_started_at IS NOT NULL)
              )
              AND finalization_completed_at IS NULL
              AND NOT stripe_refund_processing
              AND (
                  finalization_token IS NULL
                  OR finalization_started_at < now() - interval '15 minutes'
              )
            RETURNING id
            """,
            booking_id,
            finalization_token,
        )
        return row is not None

    @staticmethod
    async def release_stripe_refund_reservation(booking_id: str) -> None:
        await Database.execute(
            """
            UPDATE bookings
            SET stripe_refund_processing = false, updated_at = now()
            WHERE id = $1
            """,
            booking_id,
        )

    @staticmethod
    async def release_finalization_claim(booking_id: str, finalization_token: str) -> None:
        await Database.execute(
            """
            UPDATE bookings
            SET finalization_started_at = CASE
                    WHEN status = 'pending' THEN NULL
                    ELSE finalization_started_at
                END,
                finalization_token = NULL,
                updated_at = now()
            WHERE id = $1
              AND status IN ('pending', 'confirmed')
              AND finalization_completed_at IS NULL
              AND finalization_token = $2
            """,
            booking_id,
            finalization_token,
        )

    @staticmethod
    async def mark_finalization_effect(
        booking_id: str, finalization_token: str, effect: str
    ) -> dict | None:
        columns = {
            "guest": "guest_confirmation_sent_at",
            "host": "host_confirmation_sent_at",
            "ari": "ari_handoff_completed_at",
        }
        column = columns.get(effect)
        if not column:
            raise ValueError(f"Unknown booking finalization effect: {effect}")
        row = await Database.fetchrow(
            f"""
            UPDATE bookings
            SET {column} = COALESCE({column}, now()), updated_at = now()
            WHERE id = $1 AND finalization_token = $2
            RETURNING *
            """,
            booking_id,
            finalization_token,
        )
        return dict(row) if row else None

    @staticmethod
    async def complete_finalization(booking_id: str, finalization_token: str) -> dict | None:
        row = await Database.fetchrow(
            """
            UPDATE bookings
            SET finalization_completed_at = now(),
                finalization_token = NULL,
                updated_at = now()
            WHERE id = $1
              AND status = 'confirmed'
              AND finalization_token = $2
              AND guest_confirmation_sent_at IS NOT NULL
              AND host_confirmation_sent_at IS NOT NULL
              AND ari_handoff_completed_at IS NOT NULL
            RETURNING *
            """,
            booking_id,
            finalization_token,
        )
        return dict(row) if row else None

    @staticmethod
    async def notification_was_delivered(
        booking_id: str, notification_type: str, recipient_email: str
    ) -> bool:
        return bool(
            await Database.fetchval(
                """
                SELECT 1 FROM booking_notification_deliveries
                WHERE booking_id = $1
                  AND notification_type = $2
                  AND recipient_email = $3
                """,
                booking_id,
                notification_type,
                recipient_email.lower(),
            )
        )

    @staticmethod
    async def mark_notification_delivered(
        booking_id: str, notification_type: str, recipient_email: str
    ) -> None:
        await Database.execute(
            """
            INSERT INTO booking_notification_deliveries (
                booking_id, notification_type, recipient_email
            ) VALUES ($1, $2, $3)
            ON CONFLICT (booking_id, notification_type, recipient_email)
            DO NOTHING
            """,
            booking_id,
            notification_type,
            recipient_email.lower(),
        )

    @staticmethod
    async def assign_room(booking_id: str, room_id: str) -> dict | None:
        row = await Database.fetchrow(
            """
            UPDATE bookings SET room_id = $2, updated_at = now()
            WHERE id = $1
            RETURNING *
            """,
            booking_id,
            room_id,
        )
        return dict(row) if row else None

    @staticmethod
    async def unassign_room(booking_id: str) -> dict | None:
        row = await Database.fetchrow(
            """
            UPDATE bookings SET room_id = NULL, updated_at = now()
            WHERE id = $1
            RETURNING *
            """,
            booking_id,
        )
        return dict(row) if row else None

    @staticmethod
    async def list_for_currency_conversion(hotel_id: str) -> list[dict]:
        """Minimal projection used when re-denominating bookings on a
        hotel currency change (VAY-335). Cancelled rows are still
        included so the per-row currency stays consistent with the
        hotel's display currency."""
        rows = await Database.fetch(
            """
            SELECT id, total_amount, nightly_rate, addon_total,
                   promo_discount, last_minute_discount_amount, currency
            FROM bookings
            WHERE hotel_id = $1
            """,
            hotel_id,
        )
        return [dict(r) for r in rows]

    @staticmethod
    async def update_amounts_and_currency(
        booking_id: str,
        *,
        total_amount: float,
        nightly_rate: float,
        addon_total: float,
        promo_discount: float,
        last_minute_discount_amount: float,
        currency: str,
    ) -> None:
        await Database.execute(
            """
            UPDATE bookings
            SET total_amount = $2,
                nightly_rate = $3,
                addon_total = $4,
                promo_discount = $5,
                last_minute_discount_amount = $6,
                currency = $7,
                updated_at = now()
            WHERE id = $1
            """,
            booking_id,
            total_amount,
            nightly_rate,
            addon_total,
            promo_discount,
            last_minute_discount_amount,
            currency,
        )

    @staticmethod
    async def list_expired_pending(before_date) -> list[dict]:
        """Find bookings where host response deadline has passed."""
        rows = await Database.fetch(
            """
            SELECT id FROM bookings
            WHERE status = 'pending'
              AND host_response_deadline IS NOT NULL
              AND host_response_deadline < $1
            """,
            before_date,
        )
        return [dict(r) for r in rows]
