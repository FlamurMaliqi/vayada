-- Migration: 0096_finance_ota_commission_evidence
-- Owner: domain-finance; see VAY-1208 and engineering/pms-financials-contracts.md
CREATE TABLE finance.ota_commission_evidence (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  booking_revenue_evidence_id UUID NOT NULL UNIQUE,
  property_id UUID NOT NULL,
  guest_booking_id UUID NOT NULL,
  service_night DATE NOT NULL,
  channel TEXT NOT NULL CHECK (channel IN ('booking_com', 'airbnb', 'expedia', 'agoda', 'other_ota')),
  currency CHAR(3) NOT NULL CHECK (currency::TEXT ~ '^[A-Z]{3}$'),
  gross_room_amount NUMERIC(19, 4),
  commission_rule_id UUID REFERENCES finance.commission_rules(id) ON DELETE RESTRICT,
  commission_rule_revision INTEGER,
  percentage_rate NUMERIC(7, 4),
  commission_amount NUMERIC(19, 4),
  evidence_state TEXT NOT NULL CHECK (evidence_state IN ('applied', 'missing_gross', 'missing_rule', 'missing_rule_and_gross', 'ambiguous_rule', 'ambiguous_rule_and_gross')),
  corrects_commission_evidence_id UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_finance_ota_commission_evidence_scope UNIQUE (id, property_id, guest_booking_id, currency),
  CONSTRAINT fk_finance_ota_commission_booking_evidence FOREIGN KEY (booking_revenue_evidence_id,
    property_id, guest_booking_id, currency)
    REFERENCES booking.nightly_revenue_evidence (id, property_id, guest_booking_id, currency)
    ON DELETE RESTRICT,
  CONSTRAINT fk_finance_ota_commission_correction FOREIGN KEY (corrects_commission_evidence_id,
    property_id, guest_booking_id, currency)
    REFERENCES finance.ota_commission_evidence (id, property_id, guest_booking_id, currency) ON DELETE RESTRICT,
  CONSTRAINT chk_finance_ota_commission_evidence_shape CHECK (
    (evidence_state = 'applied' AND gross_room_amount IS NOT NULL AND commission_rule_id IS NOT NULL
      AND commission_rule_revision IS NOT NULL AND percentage_rate IS NOT NULL AND commission_amount IS NOT NULL)
    OR (evidence_state = 'missing_gross' AND gross_room_amount IS NULL AND commission_rule_id IS NOT NULL
      AND commission_rule_revision IS NOT NULL AND percentage_rate IS NOT NULL AND commission_amount IS NULL)
    OR (evidence_state = 'missing_rule' AND gross_room_amount IS NOT NULL AND commission_rule_id IS NULL
      AND commission_rule_revision IS NULL AND percentage_rate IS NULL AND commission_amount IS NULL)
    OR (evidence_state IN ('missing_rule_and_gross', 'ambiguous_rule_and_gross')
      AND gross_room_amount IS NULL AND commission_rule_id IS NULL AND commission_rule_revision IS NULL
      AND percentage_rate IS NULL AND commission_amount IS NULL)
    OR (evidence_state = 'ambiguous_rule' AND gross_room_amount IS NOT NULL AND commission_rule_id IS NULL
      AND commission_rule_revision IS NULL AND percentage_rate IS NULL AND commission_amount IS NULL)
  ),
  CONSTRAINT chk_finance_ota_commission_evidence_values CHECK ((commission_rule_revision IS NULL OR commission_rule_revision > 0)
    AND (percentage_rate IS NULL OR percentage_rate BETWEEN 0 AND 100)
    AND (corrects_commission_evidence_id IS NULL OR corrects_commission_evidence_id <> id))
);
CREATE FUNCTION finance.protect_ota_commission_evidence() RETURNS TRIGGER LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'OTA commission evidence is immutable' USING ERRCODE = '55000'; END $$;
CREATE TRIGGER trg_finance_ota_commission_evidence_rows BEFORE UPDATE OR DELETE ON finance.ota_commission_evidence FOR EACH ROW EXECUTE FUNCTION finance.protect_ota_commission_evidence();
CREATE TRIGGER trg_finance_ota_commission_evidence_truncate BEFORE TRUNCATE ON finance.ota_commission_evidence FOR EACH STATEMENT EXECUTE FUNCTION finance.protect_ota_commission_evidence();
CREATE INDEX idx_finance_ota_commission_evidence_reporting ON finance.ota_commission_evidence (property_id, service_night, currency, id);
CREATE VIEW finance.ota_commission_reporting_evidence AS
SELECT id AS snapshot_id, booking_revenue_evidence_id, property_id, guest_booking_id, service_night, channel, currency, gross_room_amount, commission_rule_id, commission_rule_revision, percentage_rate, commission_amount, evidence_state, corrects_commission_evidence_id, created_at FROM finance.ota_commission_evidence;
CREATE TRIGGER trg_finance_ota_commission_reporting_read_only INSTEAD OF INSERT OR UPDATE OR DELETE ON finance.ota_commission_reporting_evidence FOR EACH ROW EXECUTE FUNCTION finance.protect_ota_commission_evidence();
