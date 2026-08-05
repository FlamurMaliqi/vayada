-- Migration: 0065_finance_invoice_payment_allocations
-- Owner: domain-finance; see VAY-1174 and engineering/pms-financials-contracts.md
ALTER TABLE finance.payments
  ADD COLUMN invoice_allocated_amount NUMERIC(19,4) NOT NULL DEFAULT 0,
  ADD CONSTRAINT uq_finance_payments_id_property_currency UNIQUE (id, property_id, currency),
  ADD CONSTRAINT chk_finance_payments_invoice_allocated_amount CHECK (
    invoice_allocated_amount >= 0 AND invoice_allocated_amount < 'Infinity'::NUMERIC
    AND invoice_allocated_amount <= amount - refunded_amount
  ),
  ADD CONSTRAINT chk_finance_payments_invoice_allocation_status
    CHECK (invoice_allocated_amount = 0 OR status IN ('paid', 'partially_refunded'));
ALTER TABLE finance.invoices
  ADD COLUMN allocated_amount NUMERIC(19,4) NOT NULL DEFAULT 0,
  ADD CONSTRAINT chk_finance_invoices_allocated_amount CHECK (
    allocated_amount >= 0 AND allocated_amount < 'Infinity'::NUMERIC
    AND allocated_amount <= total_amount
  );
CREATE OR REPLACE FUNCTION finance.protect_invoice_history()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN NEW.allocated_amount := 0; RETURN NEW; END IF;
  IF TG_OP IN ('DELETE', 'TRUNCATE') THEN
    RAISE EXCEPTION 'invoices are archived or voided, not deleted' USING ERRCODE = '23514';
  END IF;
  IF pg_trigger_depth() > 1 AND NEW.revision = OLD.revision
    AND NEW.allocated_amount > OLD.allocated_amount
    AND (to_jsonb(NEW) - ARRAY['invoice_number', 'allocated_amount', 'updated_at'])
      = (to_jsonb(OLD) - ARRAY['invoice_number', 'allocated_amount', 'updated_at']) THEN
    NEW.updated_at := now();
    RETURN NEW;
  END IF;
  IF NEW.allocated_amount IS DISTINCT FROM OLD.allocated_amount THEN
    RAISE EXCEPTION 'invoice allocation total is database managed' USING ERRCODE = '23514';
  END IF;
  IF pg_trigger_depth() > 1 AND NEW.revision = OLD.revision
    AND NEW.line_change_revision = NEW.revision
    AND NEW.line_change_revision > OLD.line_change_revision
    AND NEW.line_change_xid = pg_current_xact_id()
    AND (to_jsonb(NEW) - ARRAY['invoice_number', 'line_change_revision', 'line_change_xid', 'updated_at'])
      = (to_jsonb(OLD) - ARRAY['invoice_number', 'line_change_revision', 'line_change_xid', 'updated_at']) THEN
    NEW.updated_at := now();
    RETURN NEW;
  END IF;
  IF ROW(NEW.id, NEW.property_id, NEW.invoice_number_value, NEW.created_at)
    IS DISTINCT FROM ROW(OLD.id, OLD.property_id, OLD.invoice_number_value, OLD.created_at) THEN
    RAISE EXCEPTION 'invoice identity is immutable' USING ERRCODE = '23514';
  END IF;
  IF OLD.archived_at IS NOT NULL OR OLD.status = 'voided' THEN
    RAISE EXCEPTION 'archived and voided invoices are immutable' USING ERRCODE = '23514';
  END IF;
  IF NOT (NEW.status = OLD.status OR (OLD.status = 'draft' AND NEW.status = 'issued')
    OR (OLD.status = 'issued' AND NEW.status = 'voided')) THEN
    RAISE EXCEPTION 'invalid invoice lifecycle transition' USING ERRCODE = '23514';
  END IF;
  IF OLD.status <> 'draft' AND ROW(NEW.guest_booking_id, NEW.recipient_name,
      NEW.recipient_email, NEW.currency, NEW.issued_on, NEW.due_on, NEW.total_amount)
    IS DISTINCT FROM ROW(OLD.guest_booking_id, OLD.recipient_name,
      OLD.recipient_email, OLD.currency, OLD.issued_on, OLD.due_on, OLD.total_amount) THEN
    RAISE EXCEPTION 'issued invoice facts are immutable' USING ERRCODE = '23514';
  END IF;
  IF NEW.revision <> OLD.revision + 1 THEN
    RAISE EXCEPTION 'invoice revision must advance by one' USING ERRCODE = '23514';
  END IF;
  NEW.revision_xid := pg_current_xact_id();
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;
DROP TRIGGER trg_finance_invoices_protect_rows ON finance.invoices;
CREATE TRIGGER trg_finance_invoices_protect_rows
BEFORE INSERT OR UPDATE OR DELETE ON finance.invoices
FOR EACH ROW EXECUTE FUNCTION finance.protect_invoice_history();
CREATE FUNCTION finance.protect_payment_allocation_total()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN NEW.invoice_allocated_amount := 0; RETURN NEW; END IF;
  IF pg_trigger_depth() <> 2 OR NEW.invoice_allocated_amount <= OLD.invoice_allocated_amount
    OR (to_jsonb(NEW) - ARRAY['invoice_allocated_amount', 'updated_at'])
      <> (to_jsonb(OLD) - ARRAY['invoice_allocated_amount', 'updated_at']) THEN
    RAISE EXCEPTION 'payment allocation total is database managed' USING ERRCODE = '23514';
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;
CREATE TRIGGER trg_finance_payments_protect_allocation_total
BEFORE INSERT OR UPDATE OF invoice_allocated_amount ON finance.payments
FOR EACH ROW EXECUTE FUNCTION finance.protect_payment_allocation_total();
CREATE TABLE finance.invoice_payment_allocations (
  id                   UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id          UUID          NOT NULL,
  invoice_id           UUID          NOT NULL,
  payment_id           UUID          NOT NULL,
  currency             CHAR(3)       NOT NULL,
  amount               NUMERIC(19,4) NOT NULL,
  allocated_on         DATE          NOT NULL DEFAULT CURRENT_DATE,
  idempotency_key      TEXT          NOT NULL,
  source_system        TEXT          NOT NULL DEFAULT 'finance'
                                    CHECK (source_system IN ('finance', 'pms', 'migration')),
  source_allocation_id TEXT,
  revision             BIGINT        NOT NULL DEFAULT 1 CHECK (revision = 1),
  created_at           TIMESTAMPTZ   NOT NULL DEFAULT now(),
  CONSTRAINT uq_finance_invoice_allocations_idempotency
    UNIQUE (property_id, idempotency_key),
  CONSTRAINT chk_finance_invoice_allocations_amount
    CHECK (amount > 0 AND amount < 'Infinity'::NUMERIC),
  CONSTRAINT chk_finance_invoice_allocations_idempotency
    CHECK (idempotency_key = btrim(idempotency_key)
      AND char_length(idempotency_key) BETWEEN 1 AND 200),
  CONSTRAINT chk_finance_invoice_allocations_source CHECK (
    (source_system = 'finance' AND source_allocation_id IS NULL)
    OR (source_system <> 'finance' AND source_allocation_id IS NOT NULL
      AND source_allocation_id = btrim(source_allocation_id)
      AND char_length(source_allocation_id) BETWEEN 1 AND 200)
  ),
  CONSTRAINT fk_finance_invoice_allocations_invoice_scope
    FOREIGN KEY (invoice_id, property_id, currency)
    REFERENCES finance.invoices(id, property_id, currency) ON DELETE RESTRICT,
  CONSTRAINT fk_finance_invoice_allocations_payment_scope
    FOREIGN KEY (payment_id, property_id, currency)
    REFERENCES finance.payments(id, property_id, currency) ON DELETE RESTRICT
);
CREATE FUNCTION finance.protect_invoice_payment_allocation()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'invoice payment allocations are append-only' USING ERRCODE = '23514';
  END IF;
  IF NOT (NEW.amount > 0 AND NEW.amount < 'Infinity'::NUMERIC) THEN
    RAISE EXCEPTION 'allocation amount must be positive and finite'
      USING ERRCODE = '23514', CONSTRAINT = 'chk_finance_invoice_allocations_amount';
  END IF;
  UPDATE finance.payments SET invoice_allocated_amount = invoice_allocated_amount + NEW.amount
  WHERE id = NEW.payment_id AND property_id = NEW.property_id AND currency = NEW.currency
    AND status IN ('paid', 'partially_refunded')
    AND amount < 'Infinity'::NUMERIC AND refunded_amount < 'Infinity'::NUMERIC
    AND invoice_allocated_amount + NEW.amount <= amount - refunded_amount;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'payment is ineligible or has insufficient unallocated amount'
      USING ERRCODE = '23514', CONSTRAINT = 'chk_finance_invoice_allocation_payment_eligible';
  END IF;
  UPDATE finance.invoices SET allocated_amount = allocated_amount + NEW.amount
  WHERE id = NEW.invoice_id AND property_id = NEW.property_id AND currency = NEW.currency
    AND status = 'issued' AND archived_at IS NULL
    AND allocated_amount + NEW.amount <= total_amount;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'invoice is ineligible or has insufficient unallocated amount'
      USING ERRCODE = '23514', CONSTRAINT = 'chk_finance_invoice_allocation_invoice_eligible';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER trg_finance_invoice_allocations_apply
AFTER INSERT ON finance.invoice_payment_allocations
FOR EACH ROW EXECUTE FUNCTION finance.protect_invoice_payment_allocation();
CREATE TRIGGER trg_finance_invoice_allocations_protect_rows
BEFORE UPDATE OR DELETE ON finance.invoice_payment_allocations
FOR EACH ROW EXECUTE FUNCTION finance.protect_invoice_payment_allocation();
CREATE TRIGGER trg_finance_invoice_allocations_protect_truncate
BEFORE TRUNCATE ON finance.invoice_payment_allocations
FOR EACH STATEMENT EXECUTE FUNCTION finance.protect_invoice_payment_allocation();
CREATE INDEX idx_finance_invoice_allocations_invoice
  ON finance.invoice_payment_allocations (invoice_id, allocated_on, id);
CREATE INDEX idx_finance_invoice_allocations_payment
  ON finance.invoice_payment_allocations (payment_id, allocated_on, id);
CREATE UNIQUE INDEX uq_finance_invoice_allocations_source
  ON finance.invoice_payment_allocations (source_system, source_allocation_id)
  WHERE source_allocation_id IS NOT NULL;
