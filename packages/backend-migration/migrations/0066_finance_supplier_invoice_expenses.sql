-- Migration: 0066_finance_supplier_invoice_expenses
-- Owner: domain-finance; see VAY-1175 and engineering/pms-financials-contracts.md
ALTER TABLE finance.invoices
  ADD COLUMN invoice_kind TEXT NOT NULL DEFAULT 'guest',
  ADD COLUMN supplier_reference TEXT,
  ADD COLUMN supplier_expense_id UUID,
  ADD CONSTRAINT chk_finance_invoices_kind CHECK (invoice_kind IN ('guest', 'supplier')),
  ADD CONSTRAINT chk_finance_invoices_supplier_reference CHECK (
    supplier_reference IS NULL OR (supplier_reference = btrim(supplier_reference)
      AND char_length(supplier_reference) BETWEEN 1 AND 200)
  ),
  ADD CONSTRAINT chk_finance_invoices_party_evidence CHECK (
    (invoice_kind = 'guest' AND supplier_reference IS NULL AND supplier_expense_id IS NULL)
    OR (invoice_kind = 'supplier' AND guest_booking_id IS NULL
      AND supplier_reference IS NOT NULL AND supplier_expense_id IS NOT NULL)
  ),
  ADD CONSTRAINT uq_finance_invoices_id_property_supplier_expense
    UNIQUE (id, property_id, supplier_expense_id);
ALTER TABLE finance.expenses
  ADD CONSTRAINT uq_finance_expenses_id_property_supplier_invoice
    UNIQUE (id, property_id, supplier_invoice_id);
ALTER TABLE finance.invoices
  ADD CONSTRAINT fk_finance_invoices_supplier_expense_pair
  FOREIGN KEY (supplier_expense_id, property_id, id)
  REFERENCES finance.expenses(id, property_id, supplier_invoice_id)
  DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE finance.expenses
  ADD CONSTRAINT fk_finance_expenses_supplier_invoice_pair
  FOREIGN KEY (supplier_invoice_id, property_id, id)
  REFERENCES finance.invoices(id, property_id, supplier_expense_id)
  DEFERRABLE INITIALLY DEFERRED;
CREATE UNIQUE INDEX uq_finance_invoices_supplier_reference
  ON finance.invoices (property_id, lower(supplier_reference))
  WHERE supplier_reference IS NOT NULL;
CREATE FUNCTION finance.protect_invoice_supplier_identity()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF ROW(NEW.invoice_kind, NEW.supplier_reference, NEW.supplier_expense_id)
    IS DISTINCT FROM ROW(OLD.invoice_kind, OLD.supplier_reference, OLD.supplier_expense_id) THEN
    RAISE EXCEPTION 'invoice party identity is immutable' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER trg_finance_invoices_protect_supplier_identity
BEFORE UPDATE ON finance.invoices
FOR EACH ROW EXECUTE FUNCTION finance.protect_invoice_supplier_identity();
