import json
import secrets
import string
from datetime import UTC, datetime, timedelta

from app.database import Database
from app.utils import generate_unique_code


def _make_booking_ref() -> str:
    chars = string.ascii_uppercase + string.digits
    suffix = "".join(secrets.choice(chars) for _ in range(6))
    return f"VAY-{suffix}"


# Soft-hold window — long enough for a guest to fill in card details on
# Stripe, short enough that an abandoned funnel doesn't block inventory
# for too long. Tuned per VAY-388.
DRAFT_TTL_MINUTES = 15


class BookingDraftRepository:
    @staticmethod
    async def _ref_taken(ref: str) -> bool:
        # A reference must be globally unique across both real bookings
        # and live drafts so the row we materialize keeps the same code.
        if await Database.fetchval("SELECT 1 FROM bookings WHERE booking_reference = $1", ref):
            return True
        if await Database.fetchval(
            "SELECT 1 FROM booking_drafts WHERE booking_reference = $1", ref
        ):
            return True
        return False

    @staticmethod
    async def generate_reference() -> str:
        return await generate_unique_code(
            _make_booking_ref,
            BookingDraftRepository._ref_taken,
            entity_name="booking reference",
        )

    @staticmethod
    async def create(
        *,
        hotel_id: str,
        room_type_id: str,
        check_in,
        check_out,
        number_of_rooms: int,
        booking_reference: str,
        stripe_payment_intent_id: str,
        stripe_account_id: str | None,
        stripe_application_fee_amount: float,
        stripe_platform_fee_amount: float,
        stripe_affiliate_commission_amount: float,
        payload: dict,
        ttl_minutes: int = DRAFT_TTL_MINUTES,
    ) -> dict:
        expires_at = datetime.now(UTC) + timedelta(minutes=ttl_minutes)
        row = await Database.fetchrow(
            """
            INSERT INTO booking_drafts (
                hotel_id, room_type_id, check_in, check_out, number_of_rooms,
                booking_reference, stripe_payment_intent_id, stripe_account_id,
                stripe_application_fee_amount, stripe_platform_fee_amount,
                stripe_affiliate_commission_amount, payload, expires_at
            ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12::jsonb, $13)
            RETURNING *
            """,
            hotel_id,
            room_type_id,
            check_in,
            check_out,
            number_of_rooms,
            booking_reference,
            stripe_payment_intent_id,
            stripe_account_id,
            stripe_application_fee_amount,
            stripe_platform_fee_amount,
            stripe_affiliate_commission_amount,
            json.dumps(payload),
            expires_at,
        )
        return dict(row)

    @staticmethod
    async def get_by_id(draft_id: str) -> dict | None:
        row = await Database.fetchrow("SELECT * FROM booking_drafts WHERE id = $1", draft_id)
        return dict(row) if row else None

    @staticmethod
    async def get_by_payment_intent(stripe_payment_intent_id: str) -> dict | None:
        row = await Database.fetchrow(
            "SELECT * FROM booking_drafts WHERE stripe_payment_intent_id = $1",
            stripe_payment_intent_id,
        )
        return dict(row) if row else None

    @staticmethod
    async def claim_for_materialization(draft_id: str, booking_id: str) -> dict | None:
        """Atomically stamp materialized_booking_id on an unmaterialized
        draft. Exactly one concurrent caller wins; the rest get None and
        should resolve to the booking via the now-set link."""
        row = await Database.fetchrow(
            """
            UPDATE booking_drafts
            SET materialized_booking_id = $2
            WHERE id = $1 AND materialized_booking_id IS NULL
            RETURNING *
            """,
            draft_id,
            booking_id,
        )
        return dict(row) if row else None

    @staticmethod
    async def delete(draft_id: str) -> bool:
        result = await Database.execute("DELETE FROM booking_drafts WHERE id = $1", draft_id)
        return result == "DELETE 1"

    @staticmethod
    async def delete_by_payment_intent(stripe_payment_intent_id: str) -> bool:
        # Webhook cancel/fail paths only release unmaterialized soft holds;
        # once a draft has been promoted to a real booking, the booking
        # owns the lifecycle and the link row stays for idempotency.
        result = await Database.execute(
            """
            DELETE FROM booking_drafts
            WHERE stripe_payment_intent_id = $1
              AND materialized_booking_id IS NULL
            """,
            stripe_payment_intent_id,
        )
        return result == "DELETE 1"

    @staticmethod
    async def count_active_for_stay(room_type_id: str, check_in, check_out) -> int:
        """Sum number_of_rooms across non-expired drafts that overlap the
        given stay. These rooms are soft-held and must be subtracted from
        availability so a second guest can't book the same unit while the
        first is still in Stripe."""
        count = await Database.fetchval(
            """
            SELECT COALESCE(SUM(number_of_rooms), 0)
            FROM booking_drafts
            WHERE room_type_id = $1
              AND check_in < $3
              AND check_out > $2
              AND expires_at > NOW()
              AND materialized_booking_id IS NULL
            """,
            room_type_id,
            check_in,
            check_out,
        )
        return int(count or 0)

    @staticmethod
    async def delete_expired(grace_minutes: int = 60) -> int:
        """Sweep drafts whose hold has lapsed (with a 1h grace period to
        keep recently-expired rows around for debugging). Returns the row
        count deleted."""
        result = await Database.execute(
            """
            DELETE FROM booking_drafts
            WHERE expires_at < NOW() - ($1::int * INTERVAL '1 minute')
              AND materialized_booking_id IS NULL
            """,
            grace_minutes,
        )
        # asyncpg returns "DELETE <n>"
        try:
            return int(result.split()[-1])
        except (ValueError, IndexError):
            return 0
