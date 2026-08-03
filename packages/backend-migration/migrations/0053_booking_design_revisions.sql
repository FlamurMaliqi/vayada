-- Migration: 0053_booking_design_revisions
-- Owner: domain-booking
-- See: VAY-1062, engineering/hotel-onboarding-information-inventory.md (ONB-10)
--
-- These revisions and their current-working pointer are private authoring state.
-- They do not change legacy Booking settings or activate public content.

CREATE TABLE booking.booking_design_revisions (
  id                       UUID        PRIMARY KEY,
  organization_id          UUID        NOT NULL REFERENCES identity.organizations(id),
  property_id              UUID        NOT NULL REFERENCES hotel_catalog.properties(id),
  revision_number          INTEGER     NOT NULL,
  contract_version         TEXT        NOT NULL,
  primary_color            TEXT        NOT NULL,
  font_pairing             TEXT        NOT NULL,
  request_fingerprint_hash TEXT        NOT NULL,
  idempotency_key_id       UUID        NOT NULL UNIQUE,
  domain_event_id          UUID        NOT NULL UNIQUE,
  outbox_event_id          UUID        NOT NULL UNIQUE,
  created_by_user_id       UUID        NOT NULL REFERENCES identity.users(id),
  created_at               TIMESTAMPTZ NOT NULL,
  scope_key                TEXT        GENERATED ALWAYS AS (
                                       platform.tenant_scope_key(
                                         'property', NULL::UUID, property_id
                                       )
                                     ) STORED,
  CONSTRAINT chk_booking_design_revision_number
    CHECK (revision_number BETWEEN 1 AND 2147483647),
  CONSTRAINT chk_booking_design_contract_version
    CHECK (contract_version = 'booking-design.v1'),
  CONSTRAINT chk_booking_design_primary_color
    CHECK (primary_color IN ('#4F46E5', '#0077B6', '#2D6A4F', '#7B2D8E', '#2D3436')),
  CONSTRAINT chk_booking_design_font_pairing
    CHECK (font_pairing IN (
      'high-end-serif', 'modern-minimalist', 'grand-classic',
      'imperial-serif', 'italiana-serif'
    )),
  CONSTRAINT chk_booking_design_request_fingerprint
    CHECK (request_fingerprint_hash ~ '^sha256:[0-9a-f]{64}$'),
  CONSTRAINT uq_booking_design_revisions_property_revision
    UNIQUE (property_id, revision_number),
  CONSTRAINT uq_booking_design_revisions_exact_identity
    UNIQUE (id, organization_id, property_id, revision_number),
  CONSTRAINT fk_booking_design_revision_idempotency_scope
    FOREIGN KEY (idempotency_key_id, scope_key)
    REFERENCES platform.idempotency_keys(id, scope_key),
  CONSTRAINT fk_booking_design_revision_domain_event_property
    FOREIGN KEY (domain_event_id, property_id)
    REFERENCES platform.domain_events(id, property_id),
  CONSTRAINT fk_booking_design_revision_outbox_event
    FOREIGN KEY (outbox_event_id, domain_event_id)
    REFERENCES platform.outbox_events(id, domain_event_id),
  CONSTRAINT fk_booking_design_revision_outbox_scope
    FOREIGN KEY (outbox_event_id, scope_key)
    REFERENCES platform.outbox_events(id, scope_key)
);

CREATE TRIGGER trg_booking_design_revisions_append_only
  BEFORE UPDATE OR DELETE ON booking.booking_design_revisions
  FOR EACH ROW EXECUTE FUNCTION platform.prevent_append_only_mutation();

CREATE TRIGGER trg_booking_design_revisions_no_truncate
  BEFORE TRUNCATE ON booking.booking_design_revisions
  FOR EACH STATEMENT EXECUTE FUNCTION platform.prevent_append_only_mutation();

CREATE TABLE booking.current_working_design_revisions (
  property_id       UUID        PRIMARY KEY,
  organization_id   UUID        NOT NULL,
  revision_id       UUID        NOT NULL,
  revision_number   INTEGER     NOT NULL,
  updated_by_user_id UUID       NOT NULL REFERENCES identity.users(id),
  updated_at        TIMESTAMPTZ NOT NULL,
  CONSTRAINT chk_booking_current_working_design_revision_number
    CHECK (revision_number BETWEEN 1 AND 2147483647),
  CONSTRAINT fk_booking_current_working_design_exact_revision
    FOREIGN KEY (revision_id, organization_id, property_id, revision_number)
    REFERENCES booking.booking_design_revisions(
      id, organization_id, property_id, revision_number
    )
);
