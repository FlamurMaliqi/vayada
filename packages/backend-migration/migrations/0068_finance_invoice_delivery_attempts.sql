-- Migration: 0068_finance_invoice_delivery_attempts
-- Owner: domain-finance; see VAY-1177 and engineering/pms-financials-contracts.md
ALTER TABLE finance.invoice_documents
  ADD CONSTRAINT uq_finance_invoice_documents_delivery_scope
  UNIQUE (id, property_id, invoice_id, invoice_revision);
CREATE TABLE finance.invoice_delivery_attempts (
  id                   UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id          UUID        NOT NULL,
  invoice_id           UUID        NOT NULL,
  invoice_revision     BIGINT      NOT NULL,
  document_id          UUID        NOT NULL,
  recipient_email      TEXT        NOT NULL,
  delivery_provider    TEXT        NOT NULL,
  provider_delivery_id TEXT,
  idempotency_key      TEXT        NOT NULL,
  state                TEXT        NOT NULL DEFAULT 'queued',
  failure_reason       TEXT,
  revision             BIGINT      NOT NULL DEFAULT 1,
  queued_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  sent_at              TIMESTAMPTZ,
  failed_at            TIMESTAMPTZ,
  CONSTRAINT uq_finance_invoice_delivery_attempts_idempotency
    UNIQUE (property_id, idempotency_key),
  CONSTRAINT chk_finance_invoice_delivery_attempts_recipient CHECK (
    recipient_email = btrim(recipient_email) AND char_length(recipient_email) BETWEEN 3 AND 320
    AND recipient_email ~ '^[^[:space:]@]+@[^[:space:]@]+$'
  ),
  CONSTRAINT chk_finance_invoice_delivery_attempts_provider CHECK (
    delivery_provider = btrim(delivery_provider)
    AND char_length(delivery_provider) BETWEEN 1 AND 100
    AND (provider_delivery_id IS NULL OR (provider_delivery_id = btrim(provider_delivery_id)
      AND char_length(provider_delivery_id) BETWEEN 1 AND 200))
  ),
  CONSTRAINT chk_finance_invoice_delivery_attempts_idempotency CHECK (
    idempotency_key = btrim(idempotency_key) AND char_length(idempotency_key) BETWEEN 1 AND 200
  ),
  CONSTRAINT chk_finance_invoice_delivery_attempts_failure CHECK (
    failure_reason IS NULL OR (failure_reason = btrim(failure_reason)
      AND char_length(failure_reason) BETWEEN 1 AND 1000)
  ),
  CONSTRAINT chk_finance_invoice_delivery_attempts_revision
    CHECK (revision BETWEEN 1 AND 2147483647),
  CONSTRAINT chk_finance_invoice_delivery_attempts_lifecycle CHECK (
    (state = 'queued' AND provider_delivery_id IS NULL AND failure_reason IS NULL
      AND sent_at IS NULL AND failed_at IS NULL)
    OR (state = 'sent' AND provider_delivery_id IS NOT NULL AND failure_reason IS NULL
      AND sent_at IS NOT NULL AND sent_at >= queued_at AND failed_at IS NULL)
    OR (state = 'failed' AND provider_delivery_id IS NULL AND failure_reason IS NOT NULL
      AND failed_at IS NOT NULL AND failed_at >= queued_at AND sent_at IS NULL)
  ),
  CONSTRAINT fk_finance_invoice_delivery_attempts_document FOREIGN KEY (
    document_id, property_id, invoice_id, invoice_revision
  ) REFERENCES finance.invoice_documents (id, property_id, invoice_id, invoice_revision)
    ON DELETE RESTRICT
);
CREATE FUNCTION finance.protect_invoice_delivery_attempt_history()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.state <> 'queued' OR NEW.revision <> 1 THEN
      RAISE EXCEPTION 'delivery attempts start queued at revision one'
        USING ERRCODE = '23514', CONSTRAINT = 'chk_finance_invoice_delivery_attempt_initial';
    END IF;
    PERFORM 1 FROM finance.invoices WHERE id = NEW.invoice_id
      AND property_id = NEW.property_id AND revision = NEW.invoice_revision
      AND status = 'issued' AND archived_at IS NULL FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'delivery requires the current issued invoice revision'
        USING ERRCODE = '23514', CONSTRAINT = 'chk_finance_invoice_delivery_attempt_issued';
    END IF;
    RETURN NEW;
  END IF;
  IF TG_OP IN ('DELETE', 'TRUNCATE') THEN
    RAISE EXCEPTION 'invoice delivery attempts are durable evidence' USING ERRCODE = '23514';
  END IF;
  IF OLD.state <> 'queued' THEN
    RAISE EXCEPTION 'terminal invoice delivery attempts are immutable' USING ERRCODE = '23514';
  END IF;
  IF ROW(NEW.id, NEW.property_id, NEW.invoice_id, NEW.invoice_revision, NEW.document_id,
      NEW.recipient_email, NEW.delivery_provider, NEW.idempotency_key, NEW.queued_at)
    IS DISTINCT FROM ROW(OLD.id, OLD.property_id, OLD.invoice_id, OLD.invoice_revision,
      OLD.document_id, OLD.recipient_email, OLD.delivery_provider, OLD.idempotency_key,
      OLD.queued_at) OR NEW.state NOT IN ('sent', 'failed') OR NEW.revision <> OLD.revision + 1 THEN
    RAISE EXCEPTION 'invalid invoice delivery transition' USING ERRCODE = '23514';
  END IF;
  IF NEW.state = 'sent' THEN
    PERFORM 1 FROM finance.invoices WHERE id = NEW.invoice_id
      AND property_id = NEW.property_id AND revision = NEW.invoice_revision
      AND status = 'issued' AND archived_at IS NULL FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'delivery requires the current issued invoice revision'
        USING ERRCODE = '23514', CONSTRAINT = 'chk_finance_invoice_delivery_attempt_issued';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER trg_finance_invoice_delivery_attempts_protect_rows
BEFORE UPDATE OR DELETE ON finance.invoice_delivery_attempts
FOR EACH ROW EXECUTE FUNCTION finance.protect_invoice_delivery_attempt_history();
CREATE TRIGGER trg_finance_invoice_delivery_attempts_validate_insert
AFTER INSERT ON finance.invoice_delivery_attempts
FOR EACH ROW EXECUTE FUNCTION finance.protect_invoice_delivery_attempt_history();
CREATE TRIGGER trg_finance_invoice_delivery_attempts_protect_truncate
BEFORE TRUNCATE ON finance.invoice_delivery_attempts
FOR EACH STATEMENT EXECUTE FUNCTION finance.protect_invoice_delivery_attempt_history();
CREATE INDEX idx_finance_invoice_delivery_attempts_invoice
  ON finance.invoice_delivery_attempts (invoice_id, queued_at DESC, id);
