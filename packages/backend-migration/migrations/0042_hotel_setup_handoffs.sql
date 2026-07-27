-- Migration: 0042_hotel_setup_handoffs
-- Owner: domain-hotels
-- See: VAY-965, engineering/adaptive-hotel-onboarding.md
--
-- Persists short-lived, single-use cross-app setup handoffs. The browser
-- receives the random code; PostgreSQL stores only its SHA-256 digest.

CREATE TABLE hotel_catalog.setup_handoffs (
  id                    UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  code_sha256           BYTEA       NOT NULL UNIQUE,
  internal_user_id      UUID        NOT NULL REFERENCES identity.users(id) ON DELETE CASCADE,
  provider_session_id   TEXT        NOT NULL,
  organization_id       UUID        NOT NULL REFERENCES identity.organizations(id) ON DELETE CASCADE,
  membership_id         UUID        NOT NULL REFERENCES identity.organization_memberships(id) ON DELETE CASCADE,
  property_id           UUID        NOT NULL REFERENCES hotel_catalog.properties(id) ON DELETE CASCADE,
  task_id                TEXT        NOT NULL,
  issued_plan_revision   TEXT        NOT NULL,
  destination_route_key TEXT        NOT NULL,
  return_url             TEXT        NOT NULL,
  expires_at             TIMESTAMPTZ NOT NULL,
  consumed_at            TIMESTAMPTZ,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT chk_setup_handoffs_code_sha256
    CHECK (octet_length(code_sha256) = 32),
  CONSTRAINT chk_setup_handoffs_session
    CHECK (provider_session_id <> '' AND length(provider_session_id) <= 500),
  CONSTRAINT chk_setup_handoffs_plan_revision
    CHECK (issued_plan_revision <> '' AND length(issued_plan_revision) <= 8192),
  CONSTRAINT chk_setup_handoffs_return_url
    CHECK (return_url <> '' AND length(return_url) <= 2048),
  CONSTRAINT chk_setup_handoffs_expiry
    CHECK (expires_at > created_at),
  CONSTRAINT chk_setup_handoffs_consumed_at
    CHECK (consumed_at IS NULL OR consumed_at >= created_at),
  CONSTRAINT chk_setup_handoffs_task_destination
    CHECK (
      (task_id = 'shared_identity' AND destination_route_key = 'hotel_catalog.shared_identity')
      OR
      (task_id = 'public_profile' AND destination_route_key = 'hotel_catalog.public_profile')
      OR
      (task_id = 'creator_profile' AND destination_route_key = 'marketplace.creator_profile')
      OR
      (task_id = 'creator_offer' AND destination_route_key = 'marketplace.creator_offer')
      OR
      (task_id = 'rooms_rates_availability' AND destination_route_key = 'pms.rooms_rates_availability')
      OR
      (task_id = 'guest_settings_policies' AND destination_route_key = 'booking.guest_settings_policies')
      OR
      (task_id = 'payment' AND destination_route_key = 'finance.payment')
      OR
      (task_id = 'direct_booking_publication' AND destination_route_key = 'distribution.direct_booking_publication')
    )
);

CREATE INDEX idx_setup_handoffs_expires_at
  ON hotel_catalog.setup_handoffs (expires_at);

CREATE INDEX idx_setup_handoffs_binding
  ON hotel_catalog.setup_handoffs (
    internal_user_id,
    provider_session_id,
    organization_id,
    membership_id
  )
  WHERE consumed_at IS NULL;
