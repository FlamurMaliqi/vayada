ALTER TABLE hotel_payment_settings
    ADD COLUMN IF NOT EXISTS stripe_billing_customer_id TEXT,
    ADD COLUMN IF NOT EXISTS stripe_billing_checkout_session_id TEXT,
    ADD COLUMN IF NOT EXISTS stripe_billing_subscription_id TEXT,
    ADD COLUMN IF NOT EXISTS stripe_billing_subscription_item_id TEXT,
    ADD COLUMN IF NOT EXISTS stripe_billing_product_id TEXT,
    ADD COLUMN IF NOT EXISTS stripe_billing_status TEXT,
    ADD COLUMN IF NOT EXISTS stripe_billing_current_period_end TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS stripe_billing_cancel_at_period_end BOOLEAN NOT NULL DEFAULT FALSE,
    ADD COLUMN IF NOT EXISTS stripe_billing_room_count INTEGER,
    ADD COLUMN IF NOT EXISTS stripe_billing_amount_cents INTEGER,
    ADD COLUMN IF NOT EXISTS stripe_billing_price_dirty BOOLEAN NOT NULL DEFAULT FALSE,
    ADD COLUMN IF NOT EXISTS stripe_billing_price_version BIGINT NOT NULL DEFAULT 0;

CREATE UNIQUE INDEX IF NOT EXISTS uq_hotel_payment_settings_billing_subscription
    ON hotel_payment_settings (stripe_billing_subscription_id)
    WHERE stripe_billing_subscription_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS stripe_billing_webhook_events (
    event_id TEXT PRIMARY KEY,
    event_type TEXT NOT NULL,
    processing_started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    processed_at TIMESTAMPTZ
);

UPDATE hotel_payment_settings
   SET stripe_billing_price_dirty = TRUE
 WHERE stripe_billing_subscription_id IS NOT NULL
   AND stripe_billing_status IN ('active', 'past_due', 'trialing');

CREATE OR REPLACE FUNCTION mark_fixed_plan_price_dirty()
RETURNS TRIGGER AS $$
DECLARE
    target_hotel_id UUID;
BEGIN
    IF TG_OP = 'DELETE' THEN
        target_hotel_id := OLD.hotel_id;
    ELSE
        target_hotel_id := NEW.hotel_id;
    END IF;

    UPDATE hotel_payment_settings
       SET stripe_billing_price_dirty = TRUE,
           stripe_billing_price_version = stripe_billing_price_version + 1
     WHERE hotel_id = target_hotel_id
       AND stripe_billing_status IN ('active', 'past_due', 'trialing', 'checkout_pending');

    IF TG_OP = 'DELETE' THEN
        RETURN OLD;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_fixed_plan_dirty_on_room_count ON rooms;
CREATE TRIGGER trg_fixed_plan_dirty_on_room_count
AFTER INSERT OR DELETE ON rooms
FOR EACH ROW EXECUTE FUNCTION mark_fixed_plan_price_dirty();

DROP TRIGGER IF EXISTS trg_fixed_plan_dirty_on_room_move ON rooms;
CREATE TRIGGER trg_fixed_plan_dirty_on_room_move
AFTER UPDATE OF hotel_id, room_type_id ON rooms
FOR EACH ROW EXECUTE FUNCTION mark_fixed_plan_price_dirty();

DROP TRIGGER IF EXISTS trg_fixed_plan_dirty_on_room_type_active ON room_types;
CREATE TRIGGER trg_fixed_plan_dirty_on_room_type_active
AFTER UPDATE OF is_active ON room_types
FOR EACH ROW EXECUTE FUNCTION mark_fixed_plan_price_dirty();

ALTER TABLE bookings
    ADD COLUMN IF NOT EXISTS billing_plan_at_creation TEXT,
    ADD COLUMN IF NOT EXISTS booking_engine_fee_pct_at_creation NUMERIC(5,2),
    ADD COLUMN IF NOT EXISTS channel_manager_fee_pct_at_creation NUMERIC(5,2),
    ADD COLUMN IF NOT EXISTS affiliate_platform_fee_pct_at_creation NUMERIC(5,2);
