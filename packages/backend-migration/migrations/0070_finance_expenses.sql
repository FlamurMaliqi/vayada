-- Migration: 0070_finance_expenses
-- Owner: domain-finance
-- See: VAY-1124, engineering/pms-financials-contracts.md

ALTER TABLE platform.media_objects
  ADD CONSTRAINT uq_platform_media_objects_expense_receipt
  UNIQUE (id, property_id, purpose, resource_product, resource_type, resource_id);

CREATE TABLE finance.expenses (
  id                    UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id           UUID          NOT NULL REFERENCES hotel_catalog.properties(id) ON DELETE RESTRICT,
  category_id           UUID          NOT NULL,
  origin                TEXT          NOT NULL CHECK (origin IN (
                                          'manual', 'recurring', 'ota_commission',
                                          'platform_fee', 'supplier_bill'
                                        )),
  entry_kind            TEXT          NOT NULL DEFAULT 'expense'
                                        CHECK (entry_kind IN ('expense', 'correction', 'reversal')),
  incurred_on           DATE          NOT NULL,
  paid_on               DATE,
  vendor                TEXT          NOT NULL,
  description           TEXT,
  amount                NUMERIC(19,4) NOT NULL,
  currency              CHAR(3)       NOT NULL,
  payment_status        TEXT          NOT NULL DEFAULT 'unpaid'
                                        CHECK (payment_status IN ('paid', 'unpaid')),
  recurring_rule_id     UUID,
  source_key            TEXT,
  reverses_expense_id   UUID,
  guest_booking_id      UUID,
  payment_id            UUID,
  supplier_invoice_number TEXT,
  receipt_media_id      UUID,
  receipt_purpose       TEXT GENERATED ALWAYS AS ('finance.expense.receipt') STORED,
  receipt_product       TEXT GENERATED ALWAYS AS ('finance') STORED,
  receipt_resource_type TEXT GENERATED ALWAYS AS ('expense') STORED,
  receipt_resource_id   TEXT GENERATED ALWAYS AS (id::TEXT) STORED,
  notes                 TEXT,
  revision              BIGINT        NOT NULL DEFAULT 1,
  created_at            TIMESTAMPTZ   NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ   NOT NULL DEFAULT now(),
  CONSTRAINT uq_finance_expenses_id_property UNIQUE (id, property_id),
  CONSTRAINT uq_finance_expenses_id_property_origin UNIQUE (id, property_id, origin),
  CONSTRAINT chk_finance_expenses_vendor
    CHECK (char_length(btrim(vendor)) BETWEEN 1 AND 200),
  CONSTRAINT chk_finance_expenses_amount
    CHECK (amount > 0 AND amount < 'Infinity'::NUMERIC),
  CONSTRAINT chk_finance_expenses_currency CHECK (currency::TEXT ~ '^[A-Z]{3}$'),
  CONSTRAINT chk_finance_expenses_dates
    CHECK (isfinite(incurred_on) AND (paid_on IS NULL OR isfinite(paid_on))),
  CONSTRAINT chk_finance_expenses_paid_state
    CHECK ((payment_status = 'paid') = (paid_on IS NOT NULL)),
  CONSTRAINT chk_finance_expenses_revision CHECK (revision BETWEEN 1 AND 2147483647),
  CONSTRAINT chk_finance_expenses_source_key
    CHECK ((entry_kind = 'expense' AND origin = 'manual') = (source_key IS NULL)),
  CONSTRAINT chk_finance_expenses_source_key_format
    CHECK (source_key IS NULL OR (
      source_key = btrim(source_key) AND char_length(source_key) BETWEEN 1 AND 250
    )),
  CONSTRAINT chk_finance_expenses_reversal
    CHECK ((entry_kind = 'expense') = (reverses_expense_id IS NULL)
      AND (reverses_expense_id IS NULL OR reverses_expense_id <> id)),
  CONSTRAINT chk_finance_expenses_origin_evidence CHECK (
    (entry_kind <> 'expense' AND recurring_rule_id IS NULL AND guest_booking_id IS NULL
      AND payment_id IS NULL AND supplier_invoice_number IS NULL)
    OR (entry_kind = 'expense' AND (
      (origin = 'manual' AND recurring_rule_id IS NULL AND guest_booking_id IS NULL
        AND payment_id IS NULL AND supplier_invoice_number IS NULL)
      OR (origin = 'recurring' AND recurring_rule_id IS NOT NULL AND guest_booking_id IS NULL
        AND payment_id IS NULL AND supplier_invoice_number IS NULL)
      OR (origin = 'ota_commission' AND recurring_rule_id IS NULL AND guest_booking_id IS NOT NULL
        AND payment_id IS NULL AND supplier_invoice_number IS NULL)
      OR (origin = 'platform_fee' AND recurring_rule_id IS NULL AND guest_booking_id IS NULL
        AND payment_id IS NOT NULL AND supplier_invoice_number IS NULL)
      OR (origin = 'supplier_bill' AND recurring_rule_id IS NULL AND guest_booking_id IS NULL
        AND payment_id IS NULL)
    ))
  ),
  CONSTRAINT chk_finance_expenses_supplier_invoice_number CHECK (
    supplier_invoice_number IS NULL OR (
      supplier_invoice_number = btrim(supplier_invoice_number)
      AND char_length(supplier_invoice_number) BETWEEN 1 AND 200
    )
  ),
  CONSTRAINT fk_finance_expenses_category_property FOREIGN KEY (category_id, property_id)
    REFERENCES finance.expense_categories(id, property_id) ON DELETE RESTRICT,
  CONSTRAINT fk_finance_expenses_pricing_currency FOREIGN KEY (property_id, currency)
    REFERENCES pms.property_pricing_settings(property_id, currency) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT fk_finance_expenses_recurrence_property FOREIGN KEY (recurring_rule_id, property_id)
    REFERENCES finance.recurring_expense_rules(id, property_id) ON DELETE RESTRICT,
  CONSTRAINT fk_finance_expenses_booking_property FOREIGN KEY (guest_booking_id, property_id)
    REFERENCES booking.guest_bookings(id, property_id) ON DELETE RESTRICT,
  CONSTRAINT fk_finance_expenses_payment_property FOREIGN KEY (payment_id, property_id)
    REFERENCES finance.payments(id, property_id) ON DELETE RESTRICT,
  CONSTRAINT fk_finance_expenses_reverses_property_origin
    FOREIGN KEY (reverses_expense_id, property_id, origin)
    REFERENCES finance.expenses(id, property_id, origin) ON DELETE RESTRICT,
  CONSTRAINT fk_finance_expenses_receipt FOREIGN KEY (
    receipt_media_id, property_id, receipt_purpose, receipt_product,
    receipt_resource_type, receipt_resource_id
  ) REFERENCES platform.media_objects (
    id, property_id, purpose, resource_product, resource_type, resource_id
  ) ON DELETE RESTRICT
);

CREATE UNIQUE INDEX uq_finance_expenses_generated_source
  ON finance.expenses (property_id, origin, source_key) WHERE source_key IS NOT NULL;
CREATE UNIQUE INDEX uq_finance_expenses_reverses
  ON finance.expenses (reverses_expense_id) WHERE reverses_expense_id IS NOT NULL;
CREATE INDEX idx_finance_expenses_supplier_invoice_number
  ON finance.expenses (property_id, supplier_invoice_number)
  WHERE supplier_invoice_number IS NOT NULL;
CREATE INDEX idx_finance_expenses_property_date
  ON finance.expenses (property_id, incurred_on DESC, id);
CREATE INDEX idx_finance_expenses_category ON finance.expenses (category_id, property_id);
CREATE INDEX idx_finance_expenses_recurrence ON finance.expenses (recurring_rule_id, property_id);
CREATE INDEX idx_finance_expenses_booking ON finance.expenses (guest_booking_id, property_id);
CREATE INDEX idx_finance_expenses_payment ON finance.expenses (payment_id, property_id);
CREATE INDEX idx_finance_expenses_receipt ON finance.expenses (receipt_media_id);

CREATE FUNCTION finance.protect_expense_history()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP IN ('DELETE', 'TRUNCATE') THEN
    RAISE EXCEPTION 'expenses are reversed, not deleted' USING ERRCODE = '23514';
  END IF;
  IF ROW(NEW.id, NEW.property_id, NEW.origin, NEW.entry_kind, NEW.incurred_on, NEW.created_at,
         NEW.source_key, NEW.reverses_expense_id, NEW.recurring_rule_id,
         NEW.guest_booking_id, NEW.payment_id, NEW.supplier_invoice_number, NEW.receipt_media_id)
    IS DISTINCT FROM
     ROW(OLD.id, OLD.property_id, OLD.origin, OLD.entry_kind, OLD.incurred_on, OLD.created_at,
         OLD.source_key, OLD.reverses_expense_id, OLD.recurring_rule_id,
         OLD.guest_booking_id, OLD.payment_id, OLD.supplier_invoice_number, OLD.receipt_media_id) THEN
    RAISE EXCEPTION 'expense accounting evidence is immutable' USING ERRCODE = '23514';
  END IF;
  IF ROW(NEW.category_id, NEW.vendor, NEW.description,
      NEW.amount, NEW.currency) IS DISTINCT FROM ROW(OLD.category_id, OLD.vendor,
      OLD.description, OLD.amount, OLD.currency) THEN
    RAISE EXCEPTION 'expense financial fields require a correction' USING ERRCODE = '23514';
  END IF;
  IF NEW.revision <> OLD.revision + 1 THEN
    RAISE EXCEPTION 'expense revision must advance by one' USING ERRCODE = '23514';
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_finance_expenses_protect_history
BEFORE UPDATE OR DELETE ON finance.expenses
FOR EACH ROW EXECUTE FUNCTION finance.protect_expense_history();

CREATE TRIGGER trg_finance_expenses_protect_truncate
BEFORE TRUNCATE ON finance.expenses
FOR EACH STATEMENT EXECUTE FUNCTION finance.protect_expense_history();

COMMENT ON COLUMN finance.expenses.supplier_invoice_number IS
  'External supplier document evidence only; never a Vayada invoice aggregate identifier.';
