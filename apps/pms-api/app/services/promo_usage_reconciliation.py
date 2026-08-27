import asyncio
import logging
from datetime import date

import httpx

from app.config import settings
from app.database import Database

logger = logging.getLogger(__name__)


def _internal_headers() -> dict[str, str]:
    key = settings.INTERNAL_API_KEY.strip()
    return {"X-Internal-Key": key} if key else {}


async def prepare_promo_claim(
    *,
    hotel_slug: str,
    promo_code: str,
    booking_reference: str,
    check_in: date,
    room_type_id: str,
    booking_total: float,
) -> None:
    await Database.execute(
        """
        INSERT INTO booking_promo_usage_state (
            booking_reference, hotel_slug, promo_code, check_in,
            room_type_id, booking_total, desired_state
        ) VALUES ($1, $2, $3, $4, $5, $6, 'active')
        ON CONFLICT (booking_reference) DO UPDATE
           SET hotel_slug = EXCLUDED.hotel_slug,
               promo_code = EXCLUDED.promo_code,
               check_in = EXCLUDED.check_in,
               room_type_id = EXCLUDED.room_type_id,
               booking_total = EXCLUDED.booking_total,
               desired_state = 'active',
               next_attempt_at = NOW(),
               updated_at = NOW()
        """,
        booking_reference,
        hotel_slug,
        promo_code,
        check_in,
        room_type_id,
        booking_total,
    )


async def queue_promo_reversal(
    *,
    hotel_slug: str,
    promo_code: str,
    booking_reference: str,
) -> None:
    await Database.execute(
        """
        INSERT INTO booking_promo_usage_state (
            booking_reference, hotel_slug, promo_code, desired_state
        ) VALUES ($1, $2, $3, 'reversed')
        ON CONFLICT (booking_reference) DO UPDATE
           SET desired_state = 'reversed',
               next_attempt_at = NOW(),
               updated_at = NOW()
        """,
        booking_reference,
        hotel_slug,
        promo_code,
    )


async def reconcile_promo_reference(booking_reference: str) -> None:
    row = await Database.fetchrow(
        "SELECT * FROM booking_promo_usage_state WHERE booking_reference = $1",
        booking_reference,
    )
    if not row or row["desired_state"] == row["applied_state"]:
        return

    desired_state = str(row["desired_state"])
    try:
        async with httpx.AsyncClient(timeout=10) as client:
            if desired_state == "active":
                response = await client.post(
                    f"{settings.BOOKING_ENGINE_API_URL}/api/hotels/{row['hotel_slug']}/increment-promo",
                    params={
                        "code": row["promo_code"],
                        "redemption_key": booking_reference,
                        "check_in": row["check_in"].isoformat(),
                        "room_type_id": row["room_type_id"],
                        "booking_total": float(row["booking_total"]),
                    },
                    headers=_internal_headers(),
                )
            else:
                response = await client.post(
                    f"{settings.BOOKING_ENGINE_API_URL}/api/hotels/{row['hotel_slug']}/decrement-promo",
                    params={"redemption_key": booking_reference},
                    headers=_internal_headers(),
                )
            response.raise_for_status()
    except Exception as error:
        await Database.execute(
            """
            UPDATE booking_promo_usage_state
               SET attempt_count = attempt_count + 1,
                   last_error = $2,
                   next_attempt_at = NOW() + INTERVAL '30 seconds',
                   updated_at = NOW()
             WHERE booking_reference = $1
            """,
            booking_reference,
            str(error)[:1000],
        )
        raise

    await Database.execute(
        """
        UPDATE booking_promo_usage_state
           SET applied_state = $2,
               attempt_count = attempt_count + 1,
               last_error = NULL,
               next_attempt_at = NOW(),
               completed_at = NOW(),
               updated_at = NOW()
         WHERE booking_reference = $1 AND desired_state = $2
        """,
        booking_reference,
        desired_state,
    )


async def claim_promo_use(
    *,
    hotel_slug: str,
    promo_code: str,
    booking_reference: str,
    check_in: date,
    room_type_id: str,
    booking_total: float,
) -> None:
    await prepare_promo_claim(
        hotel_slug=hotel_slug,
        promo_code=promo_code,
        booking_reference=booking_reference,
        check_in=check_in,
        room_type_id=room_type_id,
        booking_total=booking_total,
    )
    try:
        await reconcile_promo_reference(booking_reference)
    except Exception:
        # A timeout can mean the remote claim committed without returning a
        # response. Persist the inverse intent before propagating the error;
        # the reconciler will retry the idempotent reversal until it lands.
        await queue_promo_reversal(
            hotel_slug=hotel_slug,
            promo_code=promo_code,
            booking_reference=booking_reference,
        )
        try:
            await reconcile_promo_reference(booking_reference)
        except Exception:
            logger.exception("Promo claim compensation remains queued for %s", booking_reference)
        raise


async def reverse_promo_use(
    *,
    hotel_slug: str,
    promo_code: str,
    booking_reference: str,
) -> None:
    await queue_promo_reversal(
        hotel_slug=hotel_slug,
        promo_code=promo_code,
        booking_reference=booking_reference,
    )
    await reconcile_promo_reference(booking_reference)


async def reconcile_pending_promo_usage() -> None:
    rows = await Database.fetch(
        """
        SELECT booking_reference
        FROM booking_promo_usage_state
        WHERE desired_state <> applied_state AND next_attempt_at <= NOW()
        ORDER BY next_attempt_at
        LIMIT 100
        """
    )
    for row in rows:
        try:
            await reconcile_promo_reference(str(row["booking_reference"]))
        except Exception:
            logger.exception("Promo usage reconciliation failed for %s", row["booking_reference"])


async def recover_orphaned_promo_claims() -> None:
    await Database.execute(
        """
        UPDATE booking_promo_usage_state usage
           SET desired_state = 'reversed', next_attempt_at = NOW(), updated_at = NOW()
         WHERE usage.desired_state = 'active'
           AND usage.updated_at < NOW() - INTERVAL '5 minutes'
           AND NOT EXISTS (
               SELECT 1 FROM bookings booking
               WHERE booking.booking_reference = usage.booking_reference
           )
        """
    )


async def run_promo_usage_reconciler() -> None:
    while True:
        try:
            await recover_orphaned_promo_claims()
            await reconcile_pending_promo_usage()
        except asyncio.CancelledError:
            raise
        except Exception:
            logger.exception("Promo usage reconciliation pass failed")
        await asyncio.sleep(15)
