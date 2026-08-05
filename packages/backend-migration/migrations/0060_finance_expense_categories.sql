-- Migration: 0060_finance_expense_categories
-- Owner: domain-finance
-- See: VAY-1124, engineering/pms-financials-contracts.md

CREATE TABLE finance.expense_categories (
  id           UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id  UUID        NOT NULL REFERENCES hotel_catalog.properties(id) ON DELETE RESTRICT,
  system_key   TEXT,
  name         TEXT        NOT NULL,
  color        TEXT        NOT NULL,
  sort_order   INTEGER     NOT NULL DEFAULT 0,
  archived_at  TIMESTAMPTZ,
  category_active BOOLEAN  GENERATED ALWAYS AS (archived_at IS NULL) STORED,
  revision     BIGINT      NOT NULL DEFAULT 1,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_finance_expense_categories_id_property UNIQUE (id, property_id),
  CONSTRAINT uq_finance_expense_categories_id_property_active
    UNIQUE (id, property_id, category_active),
  CONSTRAINT chk_finance_expense_categories_system_key
    CHECK (system_key IS NULL OR system_key IN (
      'staff', 'ota_commission', 'utilities', 'maintenance',
      'supplies', 'marketing', 'platform_fees'
    )),
  CONSTRAINT chk_finance_expense_categories_name
    CHECK (char_length(btrim(name)) BETWEEN 1 AND 120),
  CONSTRAINT chk_finance_expense_categories_color
    CHECK (color ~ '^#[0-9A-Fa-f]{6}$'),
  CONSTRAINT chk_finance_expense_categories_sort_order CHECK (sort_order >= 0),
  CONSTRAINT chk_finance_expense_categories_revision
    CHECK (revision BETWEEN 1 AND 2147483647)
);

CREATE UNIQUE INDEX uq_finance_expense_categories_property_system_key
  ON finance.expense_categories (property_id, system_key)
  WHERE system_key IS NOT NULL;

CREATE INDEX idx_finance_expense_categories_property_active
  ON finance.expense_categories (property_id, sort_order, name)
  WHERE archived_at IS NULL;

INSERT INTO finance.expense_categories
  (property_id, system_key, name, color, sort_order)
SELECT property.id, seed.system_key, seed.name, seed.color, seed.sort_order
FROM hotel_catalog.properties property
CROSS JOIN (VALUES
  ('staff',          'Staff',                  '#6366F1', 10),
  ('ota_commission', 'OTA commission',         '#F59E0B', 20),
  ('utilities',      'Utilities',              '#06B6D4', 30),
  ('maintenance',    'Maintenance',            '#EF4444', 40),
  ('supplies',       'Supplies',               '#8B5CF6', 50),
  ('marketing',      'Marketing',              '#EC4899', 60),
  ('platform_fees',  'Platform fees',          '#64748B', 70)
) AS seed(system_key, name, color, sort_order)
ON CONFLICT (property_id, system_key) WHERE system_key IS NOT NULL DO NOTHING;

CREATE FUNCTION finance.prevent_expense_category_system_key_change()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.system_key IS DISTINCT FROM OLD.system_key THEN
    RAISE EXCEPTION 'expense category system key is immutable'
      USING ERRCODE = '23514',
            CONSTRAINT = 'chk_finance_expense_categories_system_key_immutable';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_finance_expense_categories_system_key_immutable
BEFORE UPDATE OF system_key ON finance.expense_categories
FOR EACH ROW EXECUTE FUNCTION finance.prevent_expense_category_system_key_change();

CREATE TABLE finance.recurring_expense_rules (
  id              UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id     UUID          NOT NULL REFERENCES hotel_catalog.properties(id) ON DELETE RESTRICT,
  category_id     UUID          NOT NULL,
  cadence         TEXT          NOT NULL CHECK (cadence IN ('weekly', 'monthly', 'yearly')),
  starts_on       DATE          NOT NULL,
  next_due_on     DATE          NOT NULL,
  ends_on         DATE,
  vendor          TEXT          NOT NULL,
  description     TEXT,
  amount          NUMERIC(19,4) NOT NULL,
  currency        CHAR(3)       NOT NULL,
  payment_status  TEXT          NOT NULL DEFAULT 'unpaid'
                                  CHECK (payment_status IN ('paid', 'unpaid')),
  notes           TEXT,
  active          BOOLEAN       NOT NULL DEFAULT TRUE,
  required_category_active BOOLEAN
    GENERATED ALWAYS AS (CASE WHEN active THEN TRUE ELSE NULL END) STORED,
  revision        BIGINT        NOT NULL DEFAULT 1,
  created_at      TIMESTAMPTZ   NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ   NOT NULL DEFAULT now(),
  CONSTRAINT uq_finance_recurring_expense_rules_id_property UNIQUE (id, property_id),
  CONSTRAINT chk_finance_recurring_expense_rules_dates
    CHECK (
      next_due_on >= starts_on
      AND (ends_on IS NULL OR (ends_on >= starts_on AND next_due_on <= ends_on))
    ),
  CONSTRAINT chk_finance_recurring_expense_rules_vendor
    CHECK (char_length(btrim(vendor)) BETWEEN 1 AND 200),
  CONSTRAINT chk_finance_recurring_expense_rules_amount
    CHECK (amount > 0 AND amount < 'Infinity'::NUMERIC),
  CONSTRAINT chk_finance_recurring_expense_rules_currency
    CHECK (currency::TEXT ~ '^[A-Z]{3}$'),
  CONSTRAINT chk_finance_recurring_expense_rules_revision
    CHECK (revision BETWEEN 1 AND 2147483647),
  CONSTRAINT fk_finance_recurring_expense_rules_category_property
    FOREIGN KEY (category_id, property_id)
    REFERENCES finance.expense_categories(id, property_id) ON DELETE RESTRICT,
  CONSTRAINT fk_finance_recurring_expense_rules_active_category
    FOREIGN KEY (category_id, property_id, required_category_active)
    REFERENCES finance.expense_categories(id, property_id, category_active)
    ON DELETE RESTRICT,
  CONSTRAINT fk_finance_recurring_expense_rules_pricing_currency
    FOREIGN KEY (property_id, currency)
    REFERENCES pms.property_pricing_settings(property_id, currency) ON DELETE RESTRICT
);

CREATE INDEX idx_finance_recurring_expense_rules_due
  ON finance.recurring_expense_rules (property_id, next_due_on, id)
  WHERE active = TRUE;

CREATE INDEX idx_finance_recurring_expense_rules_category
  ON finance.recurring_expense_rules (category_id, property_id);
