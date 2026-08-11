-- Migration: 0063_finance_folios
-- Owner: domain-finance
-- See: VAY-1170, engineering/pms-financials-external-invoice-contract.md

CREATE TABLE finance.folios (
  id               UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id      UUID        NOT NULL REFERENCES hotel_catalog.properties(id) ON DELETE RESTRICT,
  guest_booking_id UUID,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_finance_folios_id_property UNIQUE (id, property_id),
  CONSTRAINT fk_finance_folios_booking_property
    FOREIGN KEY (guest_booking_id, property_id)
    REFERENCES booking.guest_bookings(id, property_id) ON DELETE RESTRICT
);

CREATE TABLE finance.folio_revisions (
  id                            UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
  folio_id                      UUID          NOT NULL,
  property_id                   UUID          NOT NULL,
  revision                      BIGINT        NOT NULL,
  state                         TEXT          NOT NULL
                                               CHECK (state IN ('draft', 'ready', 'superseded', 'archived')),
  recipient_snapshot_ciphertext BYTEA         NOT NULL,
  recipient_key_version         TEXT          NOT NULL,
  recipient_fingerprint         CHAR(64)      NOT NULL,
  recipient_fingerprint_key_version TEXT      NOT NULL,
  service_from                  DATE          NOT NULL,
  service_to                    DATE          NOT NULL,
  currency                      CHAR(3)       NOT NULL,
  total_amount                  NUMERIC(19,4) NOT NULL,
  source_digest                 CHAR(64)      NOT NULL,
  source_freshness              JSONB         NOT NULL,
  created_at                    TIMESTAMPTZ   NOT NULL DEFAULT now(),
  CONSTRAINT uq_finance_folio_revisions_id_scope
    UNIQUE (id, folio_id, property_id, revision),
  CONSTRAINT uq_finance_folio_revisions_number UNIQUE (folio_id, revision),
  CONSTRAINT chk_finance_folio_revisions_revision
    CHECK (revision BETWEEN 1 AND 2147483647),
  CONSTRAINT chk_finance_folio_revisions_recipient_ciphertext
    CHECK (octet_length(recipient_snapshot_ciphertext) BETWEEN 29 AND 65536),
  CONSTRAINT chk_finance_folio_revisions_recipient_key
    CHECK (recipient_key_version = btrim(recipient_key_version)
      AND char_length(recipient_key_version) BETWEEN 1 AND 100),
  CONSTRAINT chk_finance_folio_revisions_recipient_fingerprint
    CHECK (recipient_fingerprint::TEXT ~ '^[0-9a-f]{64}$'),
  CONSTRAINT chk_finance_folio_revisions_recipient_fingerprint_key
    CHECK (recipient_fingerprint_key_version = btrim(recipient_fingerprint_key_version)
      AND char_length(recipient_fingerprint_key_version) BETWEEN 1 AND 100),
  CONSTRAINT chk_finance_folio_revisions_service_dates CHECK (service_from <= service_to),
  CONSTRAINT chk_finance_folio_revisions_currency CHECK (currency::TEXT ~ '^[A-Z]{3}$'),
  CONSTRAINT chk_finance_folio_revisions_total
    CHECK (total_amount >= 0 AND total_amount < 'Infinity'::NUMERIC),
  CONSTRAINT chk_finance_folio_revisions_source_digest
    CHECK (source_digest::TEXT ~ '^[0-9a-f]{64}$'),
  CONSTRAINT chk_finance_folio_revisions_source_freshness
    CHECK (jsonb_typeof(source_freshness) = 'object'),
  CONSTRAINT fk_finance_folio_revisions_folio_property
    FOREIGN KEY (folio_id, property_id)
    REFERENCES finance.folios(id, property_id) ON DELETE RESTRICT,
  CONSTRAINT fk_finance_folio_revisions_pricing_currency
    FOREIGN KEY (property_id, currency)
    REFERENCES pms.property_pricing_settings(property_id, currency) ON DELETE RESTRICT
);

CREATE FUNCTION finance.validate_folio_revision_insert()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE expected_revision BIGINT;
BEGIN
  PERFORM 1 FROM finance.folios
    WHERE id = NEW.folio_id AND property_id = NEW.property_id
    FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'folio does not belong to property'
      USING ERRCODE = '23503', CONSTRAINT = 'fk_finance_folio_revisions_folio_property';
  END IF;

  SELECT COALESCE(MAX(revision), 0) + 1 INTO expected_revision
  FROM finance.folio_revisions WHERE folio_id = NEW.folio_id;
  IF NEW.revision <> expected_revision THEN
    RAISE EXCEPTION 'folio revision must advance by one'
      USING ERRCODE = '23514', CONSTRAINT = 'chk_finance_folio_revisions_sequence';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_finance_folio_revisions_validate_insert
BEFORE INSERT ON finance.folio_revisions
FOR EACH ROW EXECUTE FUNCTION finance.validate_folio_revision_insert();

CREATE FUNCTION finance.protect_folio_history()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'folios and revisions are append-only' USING ERRCODE = '23514';
END;
$$;

CREATE TRIGGER trg_finance_folios_protect_rows
BEFORE UPDATE OR DELETE ON finance.folios
FOR EACH ROW EXECUTE FUNCTION finance.protect_folio_history();
CREATE TRIGGER trg_finance_folios_protect_truncate
BEFORE TRUNCATE ON finance.folios
FOR EACH STATEMENT EXECUTE FUNCTION finance.protect_folio_history();
CREATE TRIGGER trg_finance_folio_revisions_protect_rows
BEFORE UPDATE OR DELETE ON finance.folio_revisions
FOR EACH ROW EXECUTE FUNCTION finance.protect_folio_history();
CREATE TRIGGER trg_finance_folio_revisions_protect_truncate
BEFORE TRUNCATE ON finance.folio_revisions
FOR EACH STATEMENT EXECUTE FUNCTION finance.protect_folio_history();

CREATE INDEX idx_finance_folios_property ON finance.folios (property_id, created_at DESC, id);
CREATE INDEX idx_finance_folios_booking ON finance.folios (guest_booking_id, property_id);
CREATE INDEX idx_finance_folio_revisions_latest
  ON finance.folio_revisions (folio_id, revision DESC);
