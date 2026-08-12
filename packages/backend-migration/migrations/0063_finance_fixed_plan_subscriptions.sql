-- VAY-1120: target-native fixed-plan subscriptions and immutable booking terms.

ALTER TABLE finance.billing_entitlements
  ADD COLUMN checkout_session_ref TEXT,
  ADD COLUMN provider_subscription_status TEXT,
  ADD COLUMN billing_period_start_at TIMESTAMPTZ,
  ADD COLUMN billing_period_end_at TIMESTAMPTZ,
  ADD COLUMN cancel_at_period_end BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN billing_amount_minor INTEGER,
  ADD COLUMN billing_currency CHAR(3),
  ADD COLUMN active_room_count INTEGER,
  ADD COLUMN last_provider_event_created_at TIMESTAMPTZ,
  ADD COLUMN last_provider_event_id TEXT,
  ADD CONSTRAINT chk_finance_billing_provider_subscription_status
    CHECK (
      provider_subscription_status IS NULL
      OR provider_subscription_status IN (
        'incomplete', 'incomplete_expired', 'trialing', 'active', 'past_due',
        'canceled', 'unpaid', 'paused'
      )
    ),
  ADD CONSTRAINT chk_finance_billing_amount_minor
    CHECK (billing_amount_minor IS NULL OR billing_amount_minor >= 0),
  ADD CONSTRAINT chk_finance_billing_currency_upper
    CHECK (billing_currency IS NULL OR billing_currency = upper(billing_currency)),
  ADD CONSTRAINT chk_finance_billing_active_room_count
    CHECK (active_room_count IS NULL OR active_room_count >= 0),
  ADD CONSTRAINT chk_finance_billing_period_timestamp_order
    CHECK (
      billing_period_start_at IS NULL
      OR billing_period_end_at IS NULL
      OR billing_period_start_at <= billing_period_end_at
    );

CREATE UNIQUE INDEX uq_finance_billing_entitlements_checkout_session
  ON finance.billing_entitlements (checkout_session_ref)
  WHERE checkout_session_ref IS NOT NULL;

CREATE UNIQUE INDEX uq_finance_billing_entitlements_subscription
  ON finance.billing_entitlements (billing_subscription_ref)
  WHERE billing_subscription_ref IS NOT NULL;

ALTER TABLE booking.guest_bookings
  ADD COLUMN billing_plan_snapshot TEXT NOT NULL DEFAULT 'commission',
  ADD COLUMN commission_terms_snapshot JSONB NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN finance_terms_captured_at TIMESTAMPTZ,
  ADD CONSTRAINT chk_booking_guest_bookings_billing_plan_snapshot
    CHECK (billing_plan_snapshot IN ('commission', 'fixed'));

COMMENT ON COLUMN booking.guest_bookings.billing_plan_snapshot IS
  'Finance plan that applied when the booking was created; later plan changes never rewrite it.';
COMMENT ON COLUMN booking.guest_bookings.commission_terms_snapshot IS
  'Immutable Finance commission terms captured at booking creation.';
