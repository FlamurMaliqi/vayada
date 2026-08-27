CREATE TABLE IF NOT EXISTS booking_promo_usage_state (
    booking_reference TEXT PRIMARY KEY,
    hotel_slug TEXT NOT NULL,
    promo_code TEXT NOT NULL,
    check_in DATE,
    room_type_id TEXT,
    booking_total NUMERIC(12, 2),
    desired_state TEXT NOT NULL CHECK (desired_state IN ('active', 'reversed')),
    applied_state TEXT NOT NULL DEFAULT 'pending'
        CHECK (applied_state IN ('pending', 'active', 'reversed')),
    attempt_count INTEGER NOT NULL DEFAULT 0,
    last_error TEXT,
    next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    completed_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_booking_promo_usage_state_pending
    ON booking_promo_usage_state (next_attempt_at)
    WHERE desired_state <> applied_state;
