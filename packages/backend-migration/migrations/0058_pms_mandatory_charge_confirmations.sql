-- Migration: 0058_pms_mandatory_charge_confirmations
-- Owner: domain-pms
-- See: VAY-1081, engineering/hotel-onboarding-information-inventory.md (ONB-17 Step 5)

CREATE TABLE pms.mandatory_charge_confirmation_revisions (
  organization_id                    UUID        NOT NULL,
  property_id                        UUID        NOT NULL,
  confirmation_revision              INTEGER     NOT NULL,
  contract_version                   TEXT        NOT NULL,
  pricing_source_fingerprint         TEXT        NOT NULL,
  pricing_currency_revision          INTEGER     NOT NULL,
  optional_pricing_aggregate_revision INTEGER     NOT NULL,
  idempotency_key_id                 UUID        NOT NULL UNIQUE,
  domain_event_id                    UUID        NOT NULL UNIQUE,
  outbox_event_id                    UUID        NOT NULL UNIQUE,
  audit_event_id                     UUID        NOT NULL UNIQUE,
  confirmed_at                       TIMESTAMPTZ NOT NULL,
  scope_key                          TEXT        GENERATED ALWAYS AS (
                                                  platform.tenant_scope_key(
                                                    'property', NULL::UUID, property_id
                                                  )
                                                ) STORED,
  PRIMARY KEY (property_id, confirmation_revision),
  CONSTRAINT chk_pms_mandatory_charge_confirmation_revision
    CHECK (confirmation_revision BETWEEN 1 AND 2147483647),
  CONSTRAINT chk_pms_mandatory_charge_confirmation_contract
    CHECK (contract_version = 'pms-mandatory-charge-confirmation.v1'),
  CONSTRAINT chk_pms_mandatory_charge_confirmation_fingerprint
    CHECK (
      char_length(pricing_source_fingerprint) = 64
      AND pricing_source_fingerprint ~ '^[0-9a-f]{64}$'
    ),
  CONSTRAINT chk_pms_mandatory_charge_confirmation_pricing_revision
    CHECK (pricing_currency_revision BETWEEN 1 AND 2147483647),
  CONSTRAINT chk_pms_mandatory_charge_confirmation_optional_revision
    CHECK (optional_pricing_aggregate_revision BETWEEN 0 AND 2147483647),
  CONSTRAINT chk_pms_mandatory_charge_confirmation_time
    CHECK (
      confirmed_at <> 'infinity'::TIMESTAMPTZ
      AND confirmed_at <> '-infinity'::TIMESTAMPTZ
    ),
  CONSTRAINT fk_pms_mandatory_charge_confirmation_idempotency_scope
    FOREIGN KEY (idempotency_key_id, scope_key)
    REFERENCES platform.idempotency_keys(id, scope_key),
  CONSTRAINT fk_pms_mandatory_charge_confirmation_domain_event_property
    FOREIGN KEY (domain_event_id, property_id)
    REFERENCES platform.domain_events(id, property_id),
  CONSTRAINT fk_pms_mandatory_charge_confirmation_outbox_event
    FOREIGN KEY (outbox_event_id, domain_event_id)
    REFERENCES platform.outbox_events(id, domain_event_id),
  CONSTRAINT fk_pms_mandatory_charge_confirmation_outbox_scope
    FOREIGN KEY (outbox_event_id, scope_key)
    REFERENCES platform.outbox_events(id, scope_key),
  CONSTRAINT fk_pms_mandatory_charge_confirmation_audit_event
    FOREIGN KEY (audit_event_id)
    REFERENCES platform.product_audit_events(id)
);

CREATE INDEX idx_pms_mandatory_charge_confirmation_scope_current
  ON pms.mandatory_charge_confirmation_revisions (
    organization_id, property_id, confirmation_revision DESC
  );

CREATE TRIGGER trg_pms_mandatory_charge_confirmation_append_only
  BEFORE UPDATE OR DELETE ON pms.mandatory_charge_confirmation_revisions
  FOR EACH ROW EXECUTE FUNCTION platform.prevent_append_only_mutation();
CREATE TRIGGER trg_pms_mandatory_charge_confirmation_no_truncate
  BEFORE TRUNCATE ON pms.mandatory_charge_confirmation_revisions
  FOR EACH STATEMENT EXECUTE FUNCTION platform.prevent_append_only_mutation();
