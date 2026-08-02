-- Migration: 0047_booking_publication_attempts
-- Owner: domain-booking
-- See: engineering/onboarding-command-safety.md

CREATE TABLE booking.booking_publication_attempts (
  id                                  UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id                     UUID        NOT NULL REFERENCES identity.organizations(id),
  property_id                         UUID        NOT NULL REFERENCES hotel_catalog.properties(id),
  idempotency_key_id                  UUID        NOT NULL UNIQUE
                                                  REFERENCES platform.idempotency_keys(id),
  domain_event_id                     UUID        NOT NULL,
  outbox_event_id                     UUID        NOT NULL,
  request_fingerprint_hash            TEXT        NOT NULL
                                                  CHECK (request_fingerprint_hash ~ '^sha256:[0-9a-f]{64}$'),
  expected_active_content_revision_id UUID,
  source_manifest                     JSONB       NOT NULL,
  source_manifest_hash                TEXT        NOT NULL
                                                  CHECK (source_manifest_hash ~ '^sha256:[0-9a-f]{64}$'),
  readiness_hash                      TEXT        NOT NULL
                                                  CHECK (readiness_hash ~ '^sha256:[0-9a-f]{64}$'),
  readiness_product                   TEXT        NOT NULL CHECK (readiness_product = 'booking'),
  readiness_status                    TEXT        NOT NULL CHECK (readiness_status = 'ready'),
  status                              TEXT        NOT NULL DEFAULT 'pending'
                                                  CHECK (status IN (
                                                    'pending', 'succeeded', 'failed', 'unknown'
                                                  )),
  result_content_revision_id          UUID,
  failure_code                        TEXT,
  requested_by_user_id                UUID        NOT NULL REFERENCES identity.users(id),
  requested_at                        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at                          TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at                        TIMESTAMPTZ,
  UNIQUE (id, property_id),
  UNIQUE (domain_event_id, property_id),
  UNIQUE (outbox_event_id, domain_event_id),
  CHECK (
    jsonb_typeof(source_manifest) = 'object'
    AND source_manifest->>'contractVersion' = 'onboarding-source-manifest.v1'
    AND source_manifest->>'propertyId' = property_id::TEXT
  ),
  CHECK (
    (status = 'pending' AND result_content_revision_id IS NULL
      AND failure_code IS NULL AND completed_at IS NULL)
    OR (status = 'unknown' AND result_content_revision_id IS NULL
      AND NULLIF(btrim(failure_code), '') IS NOT NULL AND completed_at IS NULL)
    OR (status = 'failed' AND result_content_revision_id IS NULL
      AND NULLIF(btrim(failure_code), '') IS NOT NULL AND completed_at IS NOT NULL)
    OR (status = 'succeeded' AND result_content_revision_id IS NOT NULL
      AND failure_code IS NULL AND completed_at IS NOT NULL)
  ),
  FOREIGN KEY (expected_active_content_revision_id, property_id)
    REFERENCES distribution.public_booking_content_revisions(id, property_id),
  FOREIGN KEY (result_content_revision_id, property_id)
    REFERENCES distribution.public_booking_content_revisions(id, property_id),
  FOREIGN KEY (domain_event_id, property_id)
    REFERENCES platform.domain_events(id, property_id),
  FOREIGN KEY (outbox_event_id, domain_event_id)
    REFERENCES platform.outbox_events(id, domain_event_id)
);

CREATE UNIQUE INDEX uq_booking_publication_attempts_open_property
  ON booking.booking_publication_attempts (property_id)
  WHERE status IN ('pending', 'unknown');

CREATE INDEX idx_booking_publication_attempts_status
  ON booking.booking_publication_attempts (status, updated_at);
