from app.database import Database
from app.utils import upsert_by_hotel_id


class HotelPaymentSettingsRepository:
    @staticmethod
    async def get_by_hotel_id(hotel_id: str) -> dict | None:
        row = await Database.fetchrow(
            "SELECT * FROM hotel_payment_settings WHERE hotel_id = $1",
            hotel_id,
        )
        return dict(row) if row else None

    @staticmethod
    async def upsert(hotel_id: str, data: dict) -> dict:
        return await upsert_by_hotel_id("hotel_payment_settings", hotel_id, data)

    @staticmethod
    async def get_by_billing_subscription_id(subscription_id: str) -> dict | None:
        row = await Database.fetchrow(
            "SELECT * FROM hotel_payment_settings WHERE stripe_billing_subscription_id = $1",
            subscription_id,
        )
        return dict(row) if row else None

    @staticmethod
    async def list_fixed_plan_subscriptions() -> list[dict]:
        rows = await Database.fetch(
            """
            SELECT *
              FROM hotel_payment_settings
             WHERE stripe_billing_subscription_id IS NOT NULL
               AND stripe_billing_status IN ('active', 'past_due', 'trialing')
               AND stripe_billing_price_dirty = TRUE
            """
        )
        return [dict(row) for row in rows]

    @staticmethod
    async def claim_billing_webhook_event(event_id: str, event_type: str) -> str:
        row = await Database.fetchrow(
            """
            INSERT INTO stripe_billing_webhook_events (
                event_id, event_type, processing_started_at, processed_at
            )
            VALUES ($1, $2, NOW(), NULL)
            ON CONFLICT (event_id) DO UPDATE
               SET event_type = EXCLUDED.event_type,
                   processing_started_at = NOW()
             WHERE stripe_billing_webhook_events.processed_at IS NULL
               AND stripe_billing_webhook_events.processing_started_at
                   < NOW() - INTERVAL '5 minutes'
            RETURNING event_id
            """,
            event_id,
            event_type,
        )
        if row:
            return "claimed"
        completed = await Database.fetchval(
            """
            SELECT processed_at IS NOT NULL
              FROM stripe_billing_webhook_events
             WHERE event_id = $1
            """,
            event_id,
        )
        return "completed" if completed else "in_progress"

    @staticmethod
    async def complete_billing_webhook_event(event_id: str) -> None:
        await Database.execute(
            """
            UPDATE stripe_billing_webhook_events
               SET processed_at = NOW()
             WHERE event_id = $1
               AND processed_at IS NULL
            """,
            event_id,
        )

    @staticmethod
    async def release_billing_webhook_event(event_id: str) -> None:
        await Database.execute(
            """
            DELETE FROM stripe_billing_webhook_events
             WHERE event_id = $1
               AND processed_at IS NULL
            """,
            event_id,
        )

    @staticmethod
    async def complete_billing_price_sync(hotel_id: str, version: int) -> None:
        await Database.execute(
            """
            UPDATE hotel_payment_settings
               SET stripe_billing_price_dirty = FALSE
             WHERE hotel_id = $1
               AND stripe_billing_price_version = $2
            """,
            hotel_id,
            version,
        )
