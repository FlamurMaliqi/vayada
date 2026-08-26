-- Migration: 0095_finance_ota_commission_rules
-- Owner: domain-finance; see VAY-1204 and engineering/pms-financials-contracts.md
CREATE EXTENSION IF NOT EXISTS btree_gist;

ALTER TABLE finance.commission_rules
  ALTER COLUMN percentage_rate TYPE NUMERIC,
  ADD COLUMN ota_channel TEXT,
  ADD COLUMN revision INTEGER NOT NULL DEFAULT 1,
  ADD CONSTRAINT chk_finance_commission_rules_revision CHECK (revision > 0),
  ADD CONSTRAINT chk_finance_commission_rules_percentage_rate_precision CHECK (
    percentage_rate IS NULL OR scale(percentage_rate) <= 4
  ),
  ADD CONSTRAINT chk_finance_ota_commission_rule_shape CHECK (
    ota_channel IS NULL OR (
      ota_channel IN ('booking_com', 'airbnb', 'expedia', 'agoda', 'other_ota')
      AND rule_scope = 'property'
      AND property_id IS NOT NULL
      AND organization_id IS NULL
      AND product = 'pms'
      AND commission_type = 'percentage'
      AND percentage_rate IS NOT NULL
      AND scale(percentage_rate) <= 4
      AND fixed_amount IS NULL
      AND currency IS NULL
      AND source_system = 'finance'
      AND (ends_at IS NULL OR starts_at < ends_at)
    )
  );

ALTER TABLE finance.commission_rules
  ADD CONSTRAINT ex_finance_ota_commission_rules_window
  EXCLUDE USING gist (
    property_id WITH =,
    ota_channel WITH =,
    tstzrange(starts_at, ends_at, '[)') WITH &&
  ) WHERE (ota_channel IS NOT NULL);

CREATE INDEX idx_finance_ota_commission_rules_resolution
  ON finance.commission_rules (property_id, ota_channel, starts_at, ends_at)
  WHERE ota_channel IS NOT NULL;
