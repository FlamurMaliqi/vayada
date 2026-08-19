-- Migration: 0098_finance_provider_fee_evidence
-- Owner: domain-finance; see VAY-1234 and engineering/pms-financials-contracts.md

ALTER TABLE finance.payments ADD CONSTRAINT uq_finance_payments_fee_evidence_scope
  UNIQUE (id, property_id, currency, provider_account_id);
ALTER TABLE finance.payment_provider_accounts
  ADD CONSTRAINT uq_finance_provider_accounts_fee_evidence_scope
  UNIQUE (id, property_id, provider);

CREATE TABLE finance.provider_fee_evidence (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id UUID NOT NULL,
  payment_id UUID NOT NULL,
  provider_account_id UUID NOT NULL,
  provider TEXT NOT NULL CHECK (provider IN
    ('stripe','paypal','xendit','vayada','manual','bank_transfer','migration')),
  settlement_revision INTEGER NOT NULL CHECK (settlement_revision > 0),
  evidence_state TEXT NOT NULL CHECK (evidence_state IN
    ('applied','proven_zero','missing','correction','reversal')),
  evidence_on DATE NOT NULL CHECK (isfinite(evidence_on)),
  evidence_at TIMESTAMPTZ NOT NULL,
  fee_amount NUMERIC(19,4),
  currency CHAR(3) NOT NULL CHECK (currency::TEXT ~ '^[A-Z]{3}$'),
  source_revision TEXT NOT NULL CHECK
    (source_revision ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$'),
  source_fingerprint_hash CHAR(64) NOT NULL CHECK (source_fingerprint_hash ~ '^[0-9a-f]{64}$'),
  property_timezone TEXT NOT NULL,
  property_timezone_revision TEXT NOT NULL CHECK
    (property_timezone_revision ~ '^profile:[1-9][0-9]*$'),
  corrects_provider_fee_evidence_id UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_finance_provider_fee_source UNIQUE
    (property_id, payment_id, provider, source_revision),
  CONSTRAINT uq_finance_provider_fee_settlement_revision UNIQUE
    (property_id, payment_id, settlement_revision),
  CONSTRAINT uq_finance_provider_fee_scope UNIQUE
    (id, property_id, payment_id, currency, provider),
  CONSTRAINT uq_finance_provider_fee_correction UNIQUE (corrects_provider_fee_evidence_id),
  CONSTRAINT fk_finance_provider_fee_payment FOREIGN KEY
    (payment_id, property_id, currency, provider_account_id)
    REFERENCES finance.payments (id, property_id, currency, provider_account_id) ON DELETE RESTRICT,
  CONSTRAINT fk_finance_provider_fee_account FOREIGN KEY
    (provider_account_id, property_id, provider)
    REFERENCES finance.payment_provider_accounts (id, property_id, provider) ON DELETE RESTRICT,
  CONSTRAINT fk_finance_provider_fee_correction FOREIGN KEY
    (corrects_provider_fee_evidence_id, property_id, payment_id, currency, provider)
    REFERENCES finance.provider_fee_evidence (id, property_id, payment_id, currency, provider)
    ON DELETE RESTRICT,
  CONSTRAINT chk_finance_provider_fee_shape CHECK (
    (evidence_state = 'applied' AND fee_amount > 0 AND corrects_provider_fee_evidence_id IS NULL)
    OR (evidence_state = 'proven_zero' AND fee_amount = 0 AND corrects_provider_fee_evidence_id IS NULL)
    OR (evidence_state = 'missing' AND fee_amount IS NULL AND corrects_provider_fee_evidence_id IS NULL)
    OR (evidence_state = 'correction' AND fee_amount >= 0 AND corrects_provider_fee_evidence_id IS NOT NULL)
    OR (evidence_state = 'reversal' AND fee_amount = 0 AND corrects_provider_fee_evidence_id IS NOT NULL)
  )
);

CREATE INDEX idx_finance_provider_fee_payment
  ON finance.provider_fee_evidence (property_id, payment_id, settlement_revision DESC, id);
CREATE UNIQUE INDEX uq_finance_provider_fee_root
  ON finance.provider_fee_evidence (property_id, payment_id)
  WHERE corrects_provider_fee_evidence_id IS NULL;
CREATE FUNCTION finance.protect_provider_fee_evidence() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'Provider fee evidence is immutable' USING ERRCODE = '55000'; END $$;
CREATE TRIGGER trg_finance_provider_fee_evidence_rows BEFORE UPDATE OR DELETE
  ON finance.provider_fee_evidence FOR EACH ROW EXECUTE FUNCTION finance.protect_provider_fee_evidence();
CREATE TRIGGER trg_finance_provider_fee_evidence_truncate BEFORE TRUNCATE
  ON finance.provider_fee_evidence FOR EACH STATEMENT EXECUTE FUNCTION finance.protect_provider_fee_evidence();

CREATE VIEW finance.provider_fee_reporting_evidence AS
SELECT id AS provider_fee_evidence_id, property_id, payment_id, provider,
  settlement_revision, evidence_state, evidence_on, evidence_at, fee_amount, currency,
  source_revision, property_timezone, property_timezone_revision,
  corrects_provider_fee_evidence_id, created_at
FROM finance.provider_fee_evidence;
CREATE TRIGGER trg_finance_provider_fee_reporting_read_only INSTEAD OF INSERT OR UPDATE OR DELETE
  ON finance.provider_fee_reporting_evidence FOR EACH ROW EXECUTE FUNCTION finance.protect_provider_fee_evidence();
