-- Migration: 0064_finance_invoice_lines
-- Owner: domain-finance
-- See: VAY-1125, engineering/pms-financials-contracts.md
ALTER TABLE finance.invoices
  ADD COLUMN total_amount NUMERIC(19,4) NOT NULL DEFAULT 0,
  ADD COLUMN revision_xid XID8 NOT NULL DEFAULT pg_current_xact_id(),
  ADD COLUMN line_change_revision BIGINT NOT NULL DEFAULT 1,
  ADD COLUMN line_change_xid XID8,
  ADD CONSTRAINT chk_finance_invoices_total
    CHECK (total_amount >= 0 AND total_amount < 'Infinity'::NUMERIC),
  ADD CONSTRAINT chk_finance_invoices_line_change_revision
    CHECK (line_change_revision BETWEEN 1 AND revision);
CREATE OR REPLACE FUNCTION finance.protect_invoice_history()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP IN ('DELETE', 'TRUNCATE') THEN
    RAISE EXCEPTION 'invoices are archived or voided, not deleted' USING ERRCODE = '23514';
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
CREATE TABLE finance.invoice_lines (
  id           UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
  invoice_id   UUID          NOT NULL,
  property_id  UUID          NOT NULL,
  currency     CHAR(3)       NOT NULL,
  position     INTEGER       NOT NULL,
  description  TEXT          NOT NULL,
  quantity     NUMERIC(19,4) NOT NULL,
  unit_amount  NUMERIC(19,4) NOT NULL,
  line_total   NUMERIC(19,4) GENERATED ALWAYS AS (round(quantity * unit_amount, 4)) STORED,
  created_at   TIMESTAMPTZ   NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ   NOT NULL DEFAULT now(),
  CONSTRAINT uq_finance_invoice_lines_invoice_position UNIQUE (invoice_id, position),
  CONSTRAINT chk_finance_invoice_lines_position CHECK (position BETWEEN 1 AND 1000),
  CONSTRAINT chk_finance_invoice_lines_description
    CHECK (description = btrim(description) AND char_length(description) BETWEEN 1 AND 500),
  CONSTRAINT chk_finance_invoice_lines_quantity
    CHECK (quantity > 0 AND quantity < 'Infinity'::NUMERIC),
  CONSTRAINT chk_finance_invoice_lines_unit_amount
    CHECK (unit_amount >= 0 AND unit_amount < 'Infinity'::NUMERIC),
  CONSTRAINT chk_finance_invoice_lines_timestamps CHECK (updated_at >= created_at),
  CONSTRAINT fk_finance_invoice_lines_invoice_scope
    FOREIGN KEY (invoice_id, property_id, currency)
    REFERENCES finance.invoices(id, property_id, currency) ON DELETE RESTRICT
);
CREATE FUNCTION finance.protect_invoice_line_history()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE target_invoice_id UUID; target_property_id UUID; invoice_is_draft BOOLEAN;
  header_revision BIGINT; header_revision_xid XID8;
  claimed_revision BIGINT; claimed_xid XID8; current_xid XID8;
BEGIN
  IF TG_OP = 'TRUNCATE' THEN
    RAISE EXCEPTION 'invoice lines are never truncated' USING ERRCODE = '23514';
  END IF;
  target_invoice_id := CASE WHEN TG_OP = 'DELETE' THEN OLD.invoice_id ELSE NEW.invoice_id END;
  target_property_id := CASE WHEN TG_OP = 'DELETE' THEN OLD.property_id ELSE NEW.property_id END;
  current_xid := pg_current_xact_id();
  SELECT status = 'draft' AND archived_at IS NULL, revision, revision_xid,
    line_change_revision, line_change_xid
    INTO invoice_is_draft, header_revision, header_revision_xid, claimed_revision, claimed_xid
  FROM finance.invoices WHERE id = target_invoice_id AND property_id = target_property_id
  FOR UPDATE;
  IF invoice_is_draft IS FALSE THEN
    RAISE EXCEPTION 'issued, voided, and archived invoice lines are immutable'
      USING ERRCODE = '23514';
  END IF;
  IF header_revision IS NOT NULL AND header_revision_xid <> current_xid THEN
    RAISE EXCEPTION 'invoice revision must advance in the line mutation transaction'
      USING ERRCODE = '23514', CONSTRAINT = 'chk_finance_invoice_line_revision';
  END IF;
  IF header_revision IS NOT NULL AND claimed_revision = header_revision
    AND claimed_xid IS DISTINCT FROM current_xid THEN
    RAISE EXCEPTION 'invoice revision was already used for a line change'
      USING ERRCODE = '23514', CONSTRAINT = 'chk_finance_invoice_line_revision';
  END IF;
  IF header_revision IS NOT NULL AND claimed_revision < header_revision THEN
    UPDATE finance.invoices SET line_change_revision = header_revision,
      line_change_xid = current_xid WHERE id = target_invoice_id;
  END IF;
  IF TG_OP = 'UPDATE' AND ROW(NEW.id, NEW.invoice_id, NEW.property_id, NEW.currency, NEW.created_at)
    IS DISTINCT FROM ROW(OLD.id, OLD.invoice_id, OLD.property_id, OLD.currency, OLD.created_at) THEN
    RAISE EXCEPTION 'invoice line identity is immutable' USING ERRCODE = '23514';
  END IF;
  IF TG_OP = 'UPDATE' THEN NEW.updated_at := now(); END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER trg_finance_invoice_lines_protect_rows
BEFORE INSERT OR UPDATE OR DELETE ON finance.invoice_lines
FOR EACH ROW EXECUTE FUNCTION finance.protect_invoice_line_history();
CREATE TRIGGER trg_finance_invoice_lines_protect_truncate
BEFORE TRUNCATE ON finance.invoice_lines
FOR EACH STATEMENT EXECUTE FUNCTION finance.protect_invoice_line_history();
CREATE FUNCTION finance.protect_issued_invoice_total()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status <> 'draft' AND NEW.total_amount IS DISTINCT FROM OLD.total_amount THEN
    RAISE EXCEPTION 'issued invoice total is immutable' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER trg_finance_invoices_protect_total
BEFORE UPDATE OF total_amount ON finance.invoices
FOR EACH ROW EXECUTE FUNCTION finance.protect_issued_invoice_total();
CREATE FUNCTION finance.validate_invoice_total()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE target_id UUID; stored_total NUMERIC; stored_status TEXT;
  actual_total NUMERIC; line_count BIGINT;
BEGIN
  IF TG_TABLE_NAME = 'invoice_lines' THEN
    target_id := CASE WHEN TG_OP = 'DELETE' THEN OLD.invoice_id ELSE NEW.invoice_id END;
  ELSE
    target_id := NEW.id;
  END IF;
  SELECT total_amount, status INTO stored_total, stored_status
  FROM finance.invoices WHERE id = target_id;
  IF NOT FOUND THEN RETURN NULL; END IF;
  SELECT count(*), COALESCE(sum(line_total), 0)
    INTO line_count, actual_total FROM finance.invoice_lines WHERE invoice_id = target_id;
  IF stored_total IS DISTINCT FROM actual_total THEN
    RAISE EXCEPTION 'invoice total does not match normalized lines'
      USING ERRCODE = '23514', CONSTRAINT = 'chk_finance_invoice_total_matches_lines';
  END IF;
  IF stored_status <> 'draft' AND line_count = 0 THEN
    RAISE EXCEPTION 'issued invoices require at least one line'
      USING ERRCODE = '23514', CONSTRAINT = 'chk_finance_issued_invoice_has_lines';
  END IF;
  RETURN NULL;
END;
$$;
CREATE CONSTRAINT TRIGGER trg_finance_invoice_lines_validate_total
AFTER INSERT OR UPDATE OR DELETE ON finance.invoice_lines
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION finance.validate_invoice_total();
CREATE CONSTRAINT TRIGGER trg_finance_invoices_validate_total
AFTER INSERT OR UPDATE ON finance.invoices
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION finance.validate_invoice_total();
CREATE INDEX idx_finance_invoice_lines_invoice_scope
  ON finance.invoice_lines (invoice_id, property_id, currency);
