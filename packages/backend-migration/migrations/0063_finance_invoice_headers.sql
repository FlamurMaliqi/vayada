-- Migration: 0063_finance_invoice_headers
-- Owner: domain-finance
-- See: VAY-1125, engineering/pms-financials-contracts.md

CREATE TABLE finance.property_invoice_sequences (
  property_id UUID        PRIMARY KEY REFERENCES hotel_catalog.properties(id) ON DELETE RESTRICT,
  next_number BIGINT      NOT NULL DEFAULT 1 CHECK (next_number BETWEEN 1 AND 2147483647),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE FUNCTION finance.protect_property_invoice_sequence()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP IN ('DELETE', 'TRUNCATE') THEN
    RAISE EXCEPTION 'invoice sequences are never deleted or reset' USING ERRCODE = '23514';
  END IF;
  IF NEW.property_id <> OLD.property_id OR NEW.next_number <> OLD.next_number + 1 THEN
    RAISE EXCEPTION 'invoice sequence must advance by one' USING ERRCODE = '23514';
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_finance_invoice_sequences_protect_rows
BEFORE UPDATE OR DELETE ON finance.property_invoice_sequences
FOR EACH ROW EXECUTE FUNCTION finance.protect_property_invoice_sequence();
CREATE TRIGGER trg_finance_invoice_sequences_protect_truncate
BEFORE TRUNCATE ON finance.property_invoice_sequences
FOR EACH STATEMENT EXECUTE FUNCTION finance.protect_property_invoice_sequence();

CREATE FUNCTION finance.reserve_invoice_number(target_property_id UUID)
RETURNS BIGINT LANGUAGE plpgsql AS $$
DECLARE reserved_number BIGINT;
BEGIN
  INSERT INTO finance.property_invoice_sequences (property_id, next_number)
  VALUES (target_property_id, 2)
  ON CONFLICT (property_id) DO UPDATE
    SET next_number = finance.property_invoice_sequences.next_number + 1,
        updated_at = now()
  RETURNING next_number - 1 INTO reserved_number;
  RETURN reserved_number;
END;
$$;

CREATE TABLE finance.invoices (
  id                   UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id          UUID        NOT NULL REFERENCES hotel_catalog.properties(id) ON DELETE RESTRICT,
  invoice_number_value BIGINT      NOT NULL,
  invoice_number       TEXT        GENERATED ALWAYS AS (
    'INV-' || lpad(invoice_number_value::TEXT,
      GREATEST(4, char_length(invoice_number_value::TEXT)), '0')
  ) STORED,
  guest_booking_id     UUID,
  recipient_name       TEXT        NOT NULL,
  recipient_email      TEXT,
  currency             CHAR(3)     NOT NULL,
  status               TEXT        NOT NULL DEFAULT 'draft'
                                 CHECK (status IN ('draft', 'issued', 'voided')),
  issued_on            DATE,
  due_on               DATE,
  archived_at          TIMESTAMPTZ,
  voided_at            TIMESTAMPTZ,
  void_reason          TEXT,
  revision             BIGINT      NOT NULL DEFAULT 1,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_finance_invoices_id_property UNIQUE (id, property_id),
  CONSTRAINT uq_finance_invoices_id_property_currency UNIQUE (id, property_id, currency),
  CONSTRAINT uq_finance_invoices_property_number_value UNIQUE (property_id, invoice_number_value),
  CONSTRAINT uq_finance_invoices_property_number UNIQUE (property_id, invoice_number),
  CONSTRAINT chk_finance_invoices_number CHECK (invoice_number_value > 0),
  CONSTRAINT chk_finance_invoices_recipient_name
    CHECK (recipient_name = btrim(recipient_name) AND char_length(recipient_name) BETWEEN 1 AND 200),
  CONSTRAINT chk_finance_invoices_recipient_email
    CHECK (recipient_email IS NULL OR (
      recipient_email = btrim(recipient_email) AND char_length(recipient_email) BETWEEN 3 AND 320
      AND recipient_email ~ '^[^[:space:]@]+@[^[:space:]@]+$'
    )),
  CONSTRAINT chk_finance_invoices_currency CHECK (currency::TEXT ~ '^[A-Z]{3}$'),
  CONSTRAINT chk_finance_invoices_revision CHECK (revision BETWEEN 1 AND 2147483647),
  CONSTRAINT chk_finance_invoices_due_date
    CHECK (issued_on IS NULL OR due_on IS NULL OR due_on >= issued_on),
  CONSTRAINT chk_finance_invoices_timestamps CHECK (
    updated_at >= created_at AND (archived_at IS NULL OR archived_at >= created_at)
    AND (voided_at IS NULL OR (
      voided_at >= created_at AND (issued_on IS NULL OR voided_at::DATE >= issued_on)
    ))
  ),
  CONSTRAINT chk_finance_invoices_lifecycle CHECK (
    (status = 'draft' AND issued_on IS NULL AND voided_at IS NULL AND void_reason IS NULL)
    OR (status = 'issued' AND issued_on IS NOT NULL AND archived_at IS NULL
      AND voided_at IS NULL AND void_reason IS NULL)
    OR (status = 'voided' AND issued_on IS NOT NULL AND archived_at IS NULL
      AND voided_at IS NOT NULL AND void_reason = btrim(void_reason)
      AND char_length(void_reason) BETWEEN 1 AND 500)
  ),
  CONSTRAINT fk_finance_invoices_booking_property
    FOREIGN KEY (guest_booking_id, property_id)
    REFERENCES booking.guest_bookings(id, property_id) ON DELETE RESTRICT,
  CONSTRAINT fk_finance_invoices_pricing_currency
    FOREIGN KEY (property_id, currency)
    REFERENCES pms.property_pricing_settings(property_id, currency) ON DELETE RESTRICT
);

CREATE FUNCTION finance.prepare_invoice_insert()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.invoice_number_value IS NOT NULL OR NEW.status <> 'draft'
    OR NEW.revision <> 1 OR NEW.archived_at IS NOT NULL THEN
    RAISE EXCEPTION 'invoices start as database-numbered drafts' USING ERRCODE = '23514';
  END IF;
  NEW.invoice_number_value := finance.reserve_invoice_number(NEW.property_id);
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_finance_invoices_prepare_insert
BEFORE INSERT ON finance.invoices
FOR EACH ROW EXECUTE FUNCTION finance.prepare_invoice_insert();

CREATE FUNCTION finance.protect_invoice_history()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP IN ('DELETE', 'TRUNCATE') THEN
    RAISE EXCEPTION 'invoices are archived or voided, not deleted' USING ERRCODE = '23514';
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
      NEW.recipient_email, NEW.currency, NEW.issued_on, NEW.due_on)
    IS DISTINCT FROM ROW(OLD.guest_booking_id, OLD.recipient_name,
      OLD.recipient_email, OLD.currency, OLD.issued_on, OLD.due_on) THEN
    RAISE EXCEPTION 'issued invoice facts are immutable' USING ERRCODE = '23514';
  END IF;
  IF NEW.revision <> OLD.revision + 1 THEN
    RAISE EXCEPTION 'invoice revision must advance by one' USING ERRCODE = '23514';
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_finance_invoices_protect_rows
BEFORE UPDATE OR DELETE ON finance.invoices
FOR EACH ROW EXECUTE FUNCTION finance.protect_invoice_history();
CREATE TRIGGER trg_finance_invoices_protect_truncate
BEFORE TRUNCATE ON finance.invoices
FOR EACH STATEMENT EXECUTE FUNCTION finance.protect_invoice_history();

CREATE INDEX idx_finance_invoices_property_status
  ON finance.invoices (property_id, status, issued_on DESC, id);
CREATE INDEX idx_finance_invoices_booking
  ON finance.invoices (guest_booking_id, property_id);
