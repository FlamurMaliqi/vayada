-- Migration: 0059_booking_guest_policy_evidence
-- Owner: domain-booking
-- See: VAY-1066, engineering/hotel-onboarding-information-inventory.md (ONB-22/23 Step 7)

CREATE TABLE booking.guest_policy_revisions (
  revision_id                           UUID        PRIMARY KEY,
  organization_id                      UUID        NOT NULL,
  property_id                          UUID        NOT NULL,
  guest_policy_revision                INTEGER     NOT NULL,
  contract_version                     TEXT        NOT NULL,
  default_guest_language               TEXT        NOT NULL,
  children_enabled                     BOOLEAN     NOT NULL,
  adult_age_threshold                  SMALLINT,
  phone_required                       BOOLEAN     NOT NULL,
  arrival_time_enabled                 BOOLEAN     NOT NULL,
  special_requests_enabled             BOOLEAN     NOT NULL,
  guest_count_enabled                  BOOLEAN     NOT NULL DEFAULT FALSE,
  check_in_time                        TIME(0) WITHOUT TIME ZONE NOT NULL,
  check_out_time                       TIME(0) WITHOUT TIME ZONE NOT NULL,
  pricing_currency                     TEXT        NOT NULL,
  property_time_zone                   TEXT        NOT NULL,
  catalog_profile_source_revision      TEXT        NOT NULL,
  pricing_source_fingerprint           TEXT        NOT NULL,
  mandatory_charge_confirmation_revision INTEGER   NOT NULL,
  source_bindings                      JSONB       NOT NULL,
  source_fingerprint                   TEXT        NOT NULL,
  policy_bundle                        JSONB       NOT NULL,
  bundle_hash                          TEXT        NOT NULL,
  idempotency_key_id                   UUID        NOT NULL UNIQUE,
  domain_event_id                      UUID        NOT NULL UNIQUE,
  outbox_event_id                      UUID        NOT NULL UNIQUE,
  audit_event_id                       UUID        NOT NULL UNIQUE,
  accepted_at                          TIMESTAMPTZ NOT NULL,
  scope_key                            TEXT        GENERATED ALWAYS AS (
                                                    platform.tenant_scope_key(
                                                      'property', NULL::UUID, property_id
                                                    )
                                                  ) STORED,
  CONSTRAINT uq_booking_guest_policy_property_revision
    UNIQUE (property_id, guest_policy_revision),
  CONSTRAINT uq_booking_guest_policy_exact_revision
    UNIQUE (revision_id, organization_id, property_id, guest_policy_revision),
  CONSTRAINT uq_booking_guest_policy_exact_confirmation_source
    UNIQUE (
      revision_id, organization_id, property_id, guest_policy_revision,
      bundle_hash, source_fingerprint
    ),
  CONSTRAINT uq_booking_guest_policy_exact_projection_source
    UNIQUE (
      revision_id, organization_id, property_id, guest_policy_revision,
      bundle_hash, source_fingerprint, catalog_profile_source_revision, outbox_event_id
    ),
  CONSTRAINT chk_booking_guest_policy_revision
    CHECK (guest_policy_revision BETWEEN 1 AND 2147483647),
  CONSTRAINT chk_booking_guest_policy_contract
    CHECK (contract_version = 'booking-guest-policy.v1'),
  CONSTRAINT chk_booking_guest_policy_language
    CHECK (default_guest_language IN ('en', 'de', 'fr', 'es', 'id', 'nl')),
  CONSTRAINT chk_booking_guest_policy_adult_age
    CHECK (
      (adult_age_threshold IS NULL OR adult_age_threshold BETWEEN 1 AND 21)
      AND (NOT children_enabled OR adult_age_threshold IS NOT NULL)
    ),
  CONSTRAINT chk_booking_guest_policy_guest_count_disabled
    CHECK (NOT guest_count_enabled),
  CONSTRAINT chk_booking_guest_policy_times
    CHECK (
      EXTRACT(SECOND FROM check_in_time) = 0
      AND EXTRACT(SECOND FROM check_out_time) = 0
    ),
  CONSTRAINT chk_booking_guest_policy_currency
    CHECK (pricing_currency ~ '^[A-Z]{3}$'),
  CONSTRAINT chk_booking_guest_policy_timezone
    CHECK (property_time_zone = btrim(property_time_zone) AND property_time_zone <> ''),
  CONSTRAINT chk_booking_guest_policy_catalog_profile_source
    CHECK (catalog_profile_source_revision ~ '^profile:[1-9][0-9]*$'),
  CONSTRAINT chk_booking_guest_policy_pricing_fingerprint
    CHECK (pricing_source_fingerprint ~ '^[0-9a-f]{64}$'),
  CONSTRAINT chk_booking_guest_policy_charge_confirmation_revision
    CHECK (mandatory_charge_confirmation_revision BETWEEN 1 AND 2147483647),
  CONSTRAINT chk_booking_guest_policy_source_bindings
    CHECK (jsonb_typeof(source_bindings) = 'array'),
  CONSTRAINT chk_booking_guest_policy_source_fingerprint
    CHECK (source_fingerprint ~ '^sha256:[0-9a-f]{64}$'),
  CONSTRAINT chk_booking_guest_policy_bundle
    CHECK (jsonb_typeof(policy_bundle) = 'object'),
  CONSTRAINT chk_booking_guest_policy_bundle_hash
    CHECK (bundle_hash ~ '^sha256:[0-9a-f]{64}$'),
  CONSTRAINT chk_booking_guest_policy_accepted_at
    CHECK (
      accepted_at <> 'infinity'::TIMESTAMPTZ
      AND accepted_at <> '-infinity'::TIMESTAMPTZ
    ),
  CONSTRAINT fk_booking_guest_policy_idempotency_scope
    FOREIGN KEY (idempotency_key_id, scope_key)
    REFERENCES platform.idempotency_keys(id, scope_key),
  CONSTRAINT fk_booking_guest_policy_domain_event_property
    FOREIGN KEY (domain_event_id, property_id)
    REFERENCES platform.domain_events(id, property_id),
  CONSTRAINT fk_booking_guest_policy_outbox_event
    FOREIGN KEY (outbox_event_id, domain_event_id)
    REFERENCES platform.outbox_events(id, domain_event_id),
  CONSTRAINT fk_booking_guest_policy_outbox_scope
    FOREIGN KEY (outbox_event_id, scope_key)
    REFERENCES platform.outbox_events(id, scope_key),
  CONSTRAINT fk_booking_guest_policy_audit_event
    FOREIGN KEY (audit_event_id)
    REFERENCES platform.product_audit_events(id)
);

CREATE TABLE booking.current_working_guest_policy_revisions (
  property_id                          UUID        PRIMARY KEY,
  organization_id                      UUID        NOT NULL,
  revision_id                          UUID        NOT NULL,
  guest_policy_revision                INTEGER     NOT NULL,
  confirmation_id                      UUID        NOT NULL,
  confirmation_revision                INTEGER     NOT NULL,
  updated_at                           TIMESTAMPTZ NOT NULL,
  CONSTRAINT fk_booking_current_guest_policy_exact_revision
    FOREIGN KEY (revision_id, organization_id, property_id, guest_policy_revision)
    REFERENCES booking.guest_policy_revisions(
      revision_id, organization_id, property_id, guest_policy_revision
    ),
  CONSTRAINT chk_booking_current_guest_policy_updated_at
    CHECK (
      updated_at <> 'infinity'::TIMESTAMPTZ
      AND updated_at <> '-infinity'::TIMESTAMPTZ
    )
);

CREATE TABLE booking.booking_policy_confirmations (
  confirmation_id                      UUID        PRIMARY KEY,
  organization_id                      UUID        NOT NULL,
  property_id                          UUID        NOT NULL,
  confirmation_revision                INTEGER     NOT NULL,
  guest_policy_revision_id             UUID        NOT NULL,
  guest_policy_revision                INTEGER     NOT NULL,
  bundle_hash                          TEXT        NOT NULL,
  source_fingerprint                   TEXT        NOT NULL,
  confirmation_basis                   TEXT        NOT NULL,
  based_on_confirmation_id             UUID,
  based_on_confirmation_revision       INTEGER,
  reviewed_at                          TIMESTAMPTZ NOT NULL,
  recorded_at                          TIMESTAMPTZ NOT NULL,
  CONSTRAINT uq_booking_policy_confirmation_property_revision
    UNIQUE (property_id, confirmation_revision),
  CONSTRAINT uq_booking_policy_confirmation_guest_revision
    UNIQUE (property_id, guest_policy_revision),
  CONSTRAINT uq_booking_policy_confirmation_exact_basis
    UNIQUE (
      confirmation_id, confirmation_revision, organization_id, property_id,
      bundle_hash, source_fingerprint
    ),
  CONSTRAINT uq_booking_policy_confirmation_exact_current
    UNIQUE (
      confirmation_id, organization_id, property_id, guest_policy_revision_id,
      guest_policy_revision, confirmation_revision
    ),
  CONSTRAINT chk_booking_policy_confirmation_revision
    CHECK (confirmation_revision BETWEEN 1 AND 2147483647),
  CONSTRAINT chk_booking_policy_confirmation_guest_revision
    CHECK (guest_policy_revision BETWEEN 1 AND 2147483647),
  CONSTRAINT chk_booking_policy_confirmation_bundle_hash
    CHECK (bundle_hash ~ '^sha256:[0-9a-f]{64}$'),
  CONSTRAINT chk_booking_policy_confirmation_source_fingerprint
    CHECK (source_fingerprint ~ '^sha256:[0-9a-f]{64}$'),
  CONSTRAINT chk_booking_policy_confirmation_basis
    CHECK (
      (
        confirmation_basis = 'explicit'
        AND based_on_confirmation_id IS NULL
        AND based_on_confirmation_revision IS NULL
      )
      OR
      (
        confirmation_basis = 'unchanged_policy_bundle'
        AND based_on_confirmation_id IS NOT NULL
        AND based_on_confirmation_revision BETWEEN 1 AND 2147483647
        AND based_on_confirmation_revision < confirmation_revision
      )
    ),
  CONSTRAINT chk_booking_policy_confirmation_times
    CHECK (
      reviewed_at <> 'infinity'::TIMESTAMPTZ
      AND reviewed_at <> '-infinity'::TIMESTAMPTZ
      AND recorded_at <> 'infinity'::TIMESTAMPTZ
      AND recorded_at <> '-infinity'::TIMESTAMPTZ
      AND reviewed_at <= recorded_at
    ),
  CONSTRAINT fk_booking_policy_confirmation_exact_guest_revision
    FOREIGN KEY (
      guest_policy_revision_id, organization_id, property_id,
      guest_policy_revision, bundle_hash, source_fingerprint
    ) REFERENCES booking.guest_policy_revisions (
      revision_id, organization_id, property_id,
      guest_policy_revision, bundle_hash, source_fingerprint
    ),
  CONSTRAINT fk_booking_policy_confirmation_basis
    FOREIGN KEY (
      based_on_confirmation_id, based_on_confirmation_revision,
      organization_id, property_id, bundle_hash, source_fingerprint
    ) REFERENCES booking.booking_policy_confirmations (
      confirmation_id, confirmation_revision,
      organization_id, property_id, bundle_hash, source_fingerprint
    )
);

ALTER TABLE booking.current_working_guest_policy_revisions
  ADD CONSTRAINT fk_booking_current_guest_policy_exact_confirmation
  FOREIGN KEY (
    confirmation_id, organization_id, property_id, revision_id,
    guest_policy_revision, confirmation_revision
  ) REFERENCES booking.booking_policy_confirmations (
    confirmation_id, organization_id, property_id, guest_policy_revision_id,
    guest_policy_revision, confirmation_revision
  ) DEFERRABLE INITIALLY IMMEDIATE;

CREATE TABLE booking.guest_policy_projection_receipts (
  receipt_id                            UUID        PRIMARY KEY,
  organization_id                      UUID        NOT NULL,
  property_id                          UUID        NOT NULL,
  guest_policy_revision_id             UUID        NOT NULL,
  guest_policy_revision                INTEGER     NOT NULL,
  source_outbox_event_id                UUID        NOT NULL UNIQUE,
  bundle_hash                          TEXT        NOT NULL,
  source_fingerprint                   TEXT        NOT NULL,
  catalog_profile_source_revision      TEXT        NOT NULL,
  outcome                               TEXT        NOT NULL,
  catalog_policy_projection_revision   INTEGER,
  observed_catalog_profile_revision    TEXT,
  recorded_at                           TIMESTAMPTZ NOT NULL,
  CONSTRAINT chk_booking_guest_policy_projection_revision
    CHECK (guest_policy_revision BETWEEN 1 AND 2147483647),
  CONSTRAINT chk_booking_guest_policy_projection_bundle_hash
    CHECK (bundle_hash ~ '^sha256:[0-9a-f]{64}$'),
  CONSTRAINT chk_booking_guest_policy_projection_source_fingerprint
    CHECK (source_fingerprint ~ '^sha256:[0-9a-f]{64}$'),
  CONSTRAINT chk_booking_guest_policy_projection_profile_source
    CHECK (catalog_profile_source_revision ~ '^profile:[1-9][0-9]*$'),
  CONSTRAINT chk_booking_guest_policy_projection_outcome
    CHECK (
      (
        outcome = 'applied'
        AND catalog_policy_projection_revision BETWEEN 1 AND 2147483647
        AND observed_catalog_profile_revision IS NULL
      )
      OR
      (
        outcome = 'source_revision_conflict'
        AND catalog_policy_projection_revision IS NULL
        AND observed_catalog_profile_revision ~ '^profile:[1-9][0-9]*$'
        AND observed_catalog_profile_revision <> catalog_profile_source_revision
      )
    ),
  CONSTRAINT chk_booking_guest_policy_projection_recorded_at
    CHECK (
      recorded_at <> 'infinity'::TIMESTAMPTZ
      AND recorded_at <> '-infinity'::TIMESTAMPTZ
    ),
  CONSTRAINT fk_booking_guest_policy_projection_exact_revision
    FOREIGN KEY (
      guest_policy_revision_id, organization_id, property_id, guest_policy_revision,
      bundle_hash, source_fingerprint, catalog_profile_source_revision,
      source_outbox_event_id
    ) REFERENCES booking.guest_policy_revisions (
      revision_id, organization_id, property_id, guest_policy_revision,
      bundle_hash, source_fingerprint, catalog_profile_source_revision, outbox_event_id
    )
);

CREATE INDEX idx_booking_guest_policy_scope_revision
  ON booking.guest_policy_revisions (organization_id, property_id, guest_policy_revision DESC);
CREATE INDEX idx_booking_policy_confirmation_current
  ON booking.booking_policy_confirmations (property_id, guest_policy_revision DESC);
CREATE INDEX idx_booking_guest_policy_projection_current
  ON booking.guest_policy_projection_receipts (property_id, guest_policy_revision DESC);

CREATE TRIGGER trg_booking_guest_policy_revisions_append_only
  BEFORE UPDATE OR DELETE ON booking.guest_policy_revisions
  FOR EACH ROW EXECUTE FUNCTION platform.prevent_append_only_mutation();
CREATE TRIGGER trg_booking_guest_policy_revisions_no_truncate
  BEFORE TRUNCATE ON booking.guest_policy_revisions
  FOR EACH STATEMENT EXECUTE FUNCTION platform.prevent_append_only_mutation();
CREATE TRIGGER trg_booking_policy_confirmations_append_only
  BEFORE UPDATE OR DELETE ON booking.booking_policy_confirmations
  FOR EACH ROW EXECUTE FUNCTION platform.prevent_append_only_mutation();
CREATE TRIGGER trg_booking_policy_confirmations_no_truncate
  BEFORE TRUNCATE ON booking.booking_policy_confirmations
  FOR EACH STATEMENT EXECUTE FUNCTION platform.prevent_append_only_mutation();
CREATE TRIGGER trg_booking_guest_policy_projection_receipts_append_only
  BEFORE UPDATE OR DELETE ON booking.guest_policy_projection_receipts
  FOR EACH ROW EXECUTE FUNCTION platform.prevent_append_only_mutation();
CREATE TRIGGER trg_booking_guest_policy_projection_receipts_no_truncate
  BEFORE TRUNCATE ON booking.guest_policy_projection_receipts
  FOR EACH STATEMENT EXECUTE FUNCTION platform.prevent_append_only_mutation();
