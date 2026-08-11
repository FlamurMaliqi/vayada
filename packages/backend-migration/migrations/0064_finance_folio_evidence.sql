-- Migration: 0064_finance_folio_evidence
-- Owner: domain-finance
-- See: VAY-1171 and VAY-1240

ALTER TABLE finance.folio_revisions
  ADD COLUMN evidence_xid XID8 NOT NULL DEFAULT pg_current_xact_id(),
  ADD CONSTRAINT uq_finance_folio_revisions_evidence_scope
    UNIQUE (id, folio_id, property_id, revision, currency);

ALTER TABLE finance.payments
  ADD CONSTRAINT uq_finance_payments_id_property_currency
    UNIQUE (id, property_id, currency);

CREATE TABLE finance.folio_lines (
  id                     UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
  folio_revision_id      UUID          NOT NULL,
  folio_id               UUID          NOT NULL,
  property_id            UUID          NOT NULL,
  folio_revision         BIGINT        NOT NULL,
  currency               CHAR(3)       NOT NULL,
  position               INTEGER       NOT NULL,
  kind                   TEXT          NOT NULL
                                           CHECK (kind IN ('room', 'addon', 'fee', 'tax', 'adjustment')),
  description            TEXT          NOT NULL,
  quantity               NUMERIC(19,4) NOT NULL,
  unit_amount            NUMERIC(19,4) NOT NULL,
  line_total             NUMERIC(19,4)
    GENERATED ALWAYS AS (round(quantity * unit_amount, 4)) STORED,
  service_on             DATE          NOT NULL,
  source_type            TEXT          NOT NULL,
  source_id              TEXT          NOT NULL,
  source_revision        BIGINT        NOT NULL,
  accounting_mapping_ref TEXT          NOT NULL,
  tax_treatment_ref      TEXT          NOT NULL,
  created_at             TIMESTAMPTZ   NOT NULL DEFAULT now(),
  CONSTRAINT uq_finance_folio_lines_position UNIQUE (folio_revision_id, position),
  CONSTRAINT chk_finance_folio_lines_position CHECK (position BETWEEN 1 AND 1000),
  CONSTRAINT chk_finance_folio_lines_description
    CHECK (description = btrim(description) AND char_length(description) BETWEEN 1 AND 500),
  CONSTRAINT chk_finance_folio_lines_quantity
    CHECK (quantity > 0 AND quantity < 'Infinity'::NUMERIC),
  CONSTRAINT chk_finance_folio_lines_unit_amount
    CHECK (unit_amount > '-Infinity'::NUMERIC AND unit_amount < 'Infinity'::NUMERIC),
  CONSTRAINT chk_finance_folio_lines_service_on CHECK (isfinite(service_on)),
  CONSTRAINT chk_finance_folio_lines_source_type
    CHECK (source_type ~ '^[a-z][a-z0-9_.-]{0,49}$'),
  CONSTRAINT chk_finance_folio_lines_source_id
    CHECK (source_id = btrim(source_id) AND char_length(source_id) BETWEEN 1 AND 200),
  CONSTRAINT chk_finance_folio_lines_source_revision
    CHECK (source_revision BETWEEN 1 AND 2147483647),
  CONSTRAINT chk_finance_folio_lines_accounting_mapping
    CHECK (accounting_mapping_ref = btrim(accounting_mapping_ref)
      AND char_length(accounting_mapping_ref) BETWEEN 1 AND 200),
  CONSTRAINT chk_finance_folio_lines_tax_treatment
    CHECK (tax_treatment_ref = btrim(tax_treatment_ref)
      AND char_length(tax_treatment_ref) BETWEEN 1 AND 200),
  CONSTRAINT fk_finance_folio_lines_revision_scope
    FOREIGN KEY (folio_revision_id, folio_id, property_id, folio_revision, currency)
    REFERENCES finance.folio_revisions(id, folio_id, property_id, revision, currency)
    ON DELETE RESTRICT
);

CREATE TABLE finance.folio_payment_references (
  id                UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
  folio_revision_id UUID          NOT NULL,
  folio_id          UUID          NOT NULL,
  property_id       UUID          NOT NULL,
  folio_revision    BIGINT        NOT NULL,
  currency          CHAR(3)       NOT NULL,
  position          INTEGER       NOT NULL,
  payment_id        UUID          NOT NULL,
  amount            NUMERIC(19,4) NOT NULL,
  created_at        TIMESTAMPTZ   NOT NULL DEFAULT now(),
  CONSTRAINT uq_finance_folio_payment_refs_position UNIQUE (folio_revision_id, position),
  CONSTRAINT uq_finance_folio_payment_refs_payment UNIQUE (folio_revision_id, payment_id),
  CONSTRAINT chk_finance_folio_payment_refs_position CHECK (position BETWEEN 1 AND 1000),
  CONSTRAINT chk_finance_folio_payment_refs_amount
    CHECK (amount > 0 AND amount < 'Infinity'::NUMERIC),
  CONSTRAINT fk_finance_folio_payment_refs_revision_scope
    FOREIGN KEY (folio_revision_id, folio_id, property_id, folio_revision, currency)
    REFERENCES finance.folio_revisions(id, folio_id, property_id, revision, currency)
    ON DELETE RESTRICT,
  CONSTRAINT fk_finance_folio_payment_refs_payment_scope
    FOREIGN KEY (payment_id, property_id, currency)
    REFERENCES finance.payments(id, property_id, currency) ON DELETE RESTRICT
);

CREATE FUNCTION finance.validate_folio_evidence_insert()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE revision_xid XID8;
BEGIN
  SELECT evidence_xid INTO revision_xid FROM finance.folio_revisions
  WHERE id = NEW.folio_revision_id AND folio_id = NEW.folio_id
    AND property_id = NEW.property_id AND revision = NEW.folio_revision
    AND currency = NEW.currency;
  IF NOT FOUND THEN RETURN NEW; END IF;
  IF revision_xid IS DISTINCT FROM pg_current_xact_id() THEN
    RAISE EXCEPTION 'folio evidence must be created with its revision'
      USING ERRCODE = '23514', CONSTRAINT = 'chk_finance_folio_evidence_creation_transaction';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_finance_folio_lines_validate_insert
BEFORE INSERT ON finance.folio_lines
FOR EACH ROW EXECUTE FUNCTION finance.validate_folio_evidence_insert();
CREATE TRIGGER trg_finance_folio_payment_refs_validate_insert
BEFORE INSERT ON finance.folio_payment_references
FOR EACH ROW EXECUTE FUNCTION finance.validate_folio_evidence_insert();

CREATE FUNCTION finance.validate_folio_revision_total()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE target_id UUID; expected_total NUMERIC; actual_total NUMERIC;
  revision_state TEXT; revision_from DATE; revision_to DATE; line_count BIGINT;
BEGIN
  target_id := COALESCE(to_jsonb(NEW)->>'folio_revision_id', to_jsonb(NEW)->>'id')::UUID;
  SELECT total_amount, state, service_from, service_to
    INTO expected_total, revision_state, revision_from, revision_to
  FROM finance.folio_revisions WHERE id = target_id;
  IF NOT FOUND THEN RETURN NULL; END IF;
  SELECT count(*), COALESCE(sum(line_total), 0) INTO line_count, actual_total
  FROM finance.folio_lines WHERE folio_revision_id = target_id;
  IF expected_total IS DISTINCT FROM actual_total THEN
    RAISE EXCEPTION 'folio total does not match normalized lines'
      USING ERRCODE = '23514', CONSTRAINT = 'chk_finance_folio_revision_total_matches_lines';
  END IF;
  IF revision_state = 'ready' AND line_count = 0 THEN
    RAISE EXCEPTION 'ready folio revisions require a line'
      USING ERRCODE = '23514', CONSTRAINT = 'chk_finance_ready_folio_has_lines';
  END IF;
  IF EXISTS (SELECT 1 FROM finance.folio_lines
    WHERE folio_revision_id = target_id AND service_on NOT BETWEEN revision_from AND revision_to) THEN
    RAISE EXCEPTION 'folio line service date is outside the revision period'
      USING ERRCODE = '23514', CONSTRAINT = 'chk_finance_folio_line_service_period';
  END IF;
  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER trg_finance_folio_revisions_validate_total
AFTER INSERT ON finance.folio_revisions DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION finance.validate_folio_revision_total();
CREATE CONSTRAINT TRIGGER trg_finance_folio_lines_validate_total
AFTER INSERT ON finance.folio_lines DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION finance.validate_folio_revision_total();

CREATE FUNCTION finance.protect_folio_evidence()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'folio evidence is append-only'
    USING ERRCODE = '23514', CONSTRAINT = 'chk_finance_folio_evidence_append_only';
END;
$$;

CREATE TRIGGER trg_finance_folio_lines_protect_rows
BEFORE UPDATE OR DELETE ON finance.folio_lines
FOR EACH ROW EXECUTE FUNCTION finance.protect_folio_evidence();
CREATE TRIGGER trg_finance_folio_lines_protect_truncate
BEFORE TRUNCATE ON finance.folio_lines
FOR EACH STATEMENT EXECUTE FUNCTION finance.protect_folio_evidence();
CREATE TRIGGER trg_finance_folio_payment_refs_protect_rows
BEFORE UPDATE OR DELETE ON finance.folio_payment_references
FOR EACH ROW EXECUTE FUNCTION finance.protect_folio_evidence();
CREATE TRIGGER trg_finance_folio_payment_refs_protect_truncate
BEFORE TRUNCATE ON finance.folio_payment_references
FOR EACH STATEMENT EXECUTE FUNCTION finance.protect_folio_evidence();

CREATE INDEX idx_finance_folio_lines_revision
  ON finance.folio_lines (folio_revision_id, position);
CREATE INDEX idx_finance_folio_payment_refs_payment
  ON finance.folio_payment_references (payment_id, property_id);
