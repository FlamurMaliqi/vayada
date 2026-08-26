-- Keep the connected-account context with each Stripe booking payment.
-- Direct charges require this account on every later Stripe API call.

ALTER TABLE booking_drafts
    ADD COLUMN IF NOT EXISTS stripe_account_id TEXT,
    ADD COLUMN IF NOT EXISTS stripe_application_fee_amount NUMERIC(10,2),
    ADD COLUMN IF NOT EXISTS stripe_platform_fee_amount NUMERIC(10,2),
    ADD COLUMN IF NOT EXISTS stripe_affiliate_commission_amount NUMERIC(10,2);

ALTER TABLE payments
    ADD COLUMN IF NOT EXISTS stripe_account_id TEXT,
    ADD COLUMN IF NOT EXISTS stripe_application_fee_amount NUMERIC(10,2),
    ADD COLUMN IF NOT EXISTS stripe_platform_fee_amount NUMERIC(10,2),
    ADD COLUMN IF NOT EXISTS stripe_affiliate_commission_amount NUMERIC(10,2),
    ADD COLUMN IF NOT EXISTS stripe_refund_command_id TEXT,
    ADD COLUMN IF NOT EXISTS stripe_refund_id TEXT,
    ADD COLUMN IF NOT EXISTS stripe_refund_status TEXT,
    ADD COLUMN IF NOT EXISTS stripe_refund_target_status TEXT,
    ADD COLUMN IF NOT EXISTS stripe_refund_target_booking_status TEXT,
    ADD COLUMN IF NOT EXISTS stripe_refund_expected_booking_status TEXT,
    ADD COLUMN IF NOT EXISTS stripe_refund_percentage NUMERIC(5,2),
    ADD COLUMN IF NOT EXISTS stripe_refund_amount_minor BIGINT,
    ADD COLUMN IF NOT EXISTS stripe_refund_currency TEXT,
    ADD COLUMN IF NOT EXISTS stripe_refund_payouts_cancelled_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS stripe_refund_channex_cancelled_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS stripe_refund_ari_handoff_completed_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS stripe_refund_completed_at TIMESTAMPTZ;

CREATE UNIQUE INDEX IF NOT EXISTS idx_payments_stripe_refund_id
    ON payments(stripe_refund_id)
    WHERE stripe_refund_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_payments_stripe_refund_command_id
    ON payments(stripe_refund_command_id)
    WHERE stripe_refund_command_id IS NOT NULL;

ALTER TABLE bookings
    ADD COLUMN IF NOT EXISTS stripe_refund_processing BOOLEAN NOT NULL DEFAULT false;
