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
  failure_code                        TEXT        CHECK (
                                                  failure_code IS NULL OR failure_code IN (
                                                    'external_result_unconfirmed',
                                                    'projection_failed',
                                                    'source_content_changed'
                                                  )
                                                ),
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

-- A persisted revision is not published until Distribution's active pointer
-- references it. Keep this as a transition-time invariant rather than a
-- permanent foreign key so a later publication may move the pointer safely.
CREATE FUNCTION booking.validate_booking_publication_success()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.status = 'succeeded' AND NOT EXISTS (
    SELECT 1
    FROM distribution.active_public_booking_revision active
    WHERE active.property_id = NEW.property_id
      AND active.content_revision_id = NEW.result_content_revision_id
  ) THEN
    RAISE EXCEPTION 'succeeded Booking publication must identify the active public revision'
      USING ERRCODE = '23514',
            CONSTRAINT = 'chk_booking_publication_attempts_success_is_active';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_booking_publication_attempts_validate_success
  BEFORE INSERT OR UPDATE OF status, result_content_revision_id
  ON booking.booking_publication_attempts
  FOR EACH ROW EXECUTE FUNCTION booking.validate_booking_publication_success();
