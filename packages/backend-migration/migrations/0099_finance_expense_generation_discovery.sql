-- Migration: 0099_finance_expense_generation_discovery
-- Owner: domain-finance; see VAY-1130 and engineering/jobs-events-contract.md

CREATE TABLE finance.expense_generation_dispatches (
  family TEXT NOT NULL CHECK (family IN ('ota_commission', 'provider_fee')),
  evidence_id UUID NOT NULL,
  property_id UUID NOT NULL REFERENCES hotel_catalog.properties(id) ON DELETE RESTRICT,
  payment_id UUID,
  created_at TIMESTAMPTZ NOT NULL,
  discovery_attempts INTEGER NOT NULL DEFAULT 0 CHECK (discovery_attempts >= 0),
  run_after TIMESTAMPTZ NOT NULL DEFAULT '-infinity',
  last_error_code TEXT,
  dispatched_at TIMESTAMPTZ,
  PRIMARY KEY (family, evidence_id),
  CONSTRAINT chk_finance_expense_generation_dispatch_shape CHECK (
    (family = 'ota_commission' AND payment_id IS NULL)
    OR (family = 'provider_fee' AND payment_id IS NOT NULL)
  )
);
CREATE INDEX idx_finance_expense_generation_dispatch_pending
  ON finance.expense_generation_dispatches (run_after, created_at, family, evidence_id)
  WHERE dispatched_at IS NULL;
CREATE INDEX idx_finance_recurring_expense_rules_discovery
  ON finance.recurring_expense_rules (next_due_on, property_id, id)
  WHERE active = TRUE;

CREATE FUNCTION finance.dispatch_ota_commission_expense_generation() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN INSERT INTO finance.expense_generation_dispatches(family,evidence_id,property_id,created_at,run_after)
  VALUES('ota_commission',NEW.id,NEW.property_id,NEW.created_at,'-infinity') ON CONFLICT DO NOTHING; RETURN NEW; END $$;
CREATE TRIGGER trg_finance_ota_commission_expense_generation_dispatch AFTER INSERT
  ON finance.ota_commission_evidence FOR EACH ROW EXECUTE FUNCTION finance.dispatch_ota_commission_expense_generation();

CREATE FUNCTION finance.dispatch_provider_fee_expense_generation() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN INSERT INTO finance.expense_generation_dispatches(family,evidence_id,property_id,payment_id,created_at,run_after)
  VALUES('provider_fee',NEW.id,NEW.property_id,NEW.payment_id,NEW.created_at,'-infinity') ON CONFLICT DO NOTHING; RETURN NEW; END $$;
CREATE TRIGGER trg_finance_provider_fee_expense_generation_dispatch AFTER INSERT
  ON finance.provider_fee_evidence FOR EACH ROW EXECUTE FUNCTION finance.dispatch_provider_fee_expense_generation();

INSERT INTO finance.expense_generation_dispatches(family,evidence_id,property_id,created_at,run_after)
  SELECT 'ota_commission',id,property_id,created_at,'-infinity' FROM finance.ota_commission_evidence;
INSERT INTO finance.expense_generation_dispatches(family,evidence_id,property_id,payment_id,created_at,run_after)
  SELECT 'provider_fee',id,property_id,payment_id,created_at,'-infinity' FROM finance.provider_fee_evidence;
