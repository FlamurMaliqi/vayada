-- Migration: 0091_booking_addon_economics
-- Owner: domain-booking; see VAY-1190 and engineering/pms-financials-contracts.md
ALTER TABLE booking.addon_definitions
  ADD COLUMN ownership_kind TEXT NOT NULL DEFAULT 'property',
  ADD COLUMN partner_commission_rate NUMERIC,
  ADD CONSTRAINT chk_addon_definitions_ownership CHECK (
    ownership_kind IN ('property', 'partner')
  ),
  ADD CONSTRAINT chk_addon_definitions_economic_pair CHECK (
    (ownership_kind = 'property' AND partner_commission_rate IS NULL)
    OR (
      ownership_kind = 'partner'
      AND partner_commission_rate IS NOT NULL
      AND partner_commission_rate BETWEEN 0 AND 100
      AND scale(partner_commission_rate) <= 4
    )
  );

ALTER TABLE booking.booking_addon_selections
  ADD COLUMN ownership_kind_snapshot TEXT NOT NULL DEFAULT 'property',
  ADD COLUMN partner_commission_rate_snapshot NUMERIC,
  ADD CONSTRAINT chk_booking_addon_selections_ownership CHECK (
    ownership_kind_snapshot IN ('property', 'partner')
  ),
  ADD CONSTRAINT chk_booking_addon_selections_economic_pair CHECK (
    (ownership_kind_snapshot = 'property' AND partner_commission_rate_snapshot IS NULL)
    OR (
      ownership_kind_snapshot = 'partner'
      AND partner_commission_rate_snapshot IS NOT NULL
      AND partner_commission_rate_snapshot BETWEEN 0 AND 100
      AND scale(partner_commission_rate_snapshot) <= 4
    )
  );

CREATE FUNCTION booking.protect_purchased_addon_evidence()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'TRUNCATE' THEN
    RAISE EXCEPTION 'Purchased add-on evidence cannot be truncated' USING ERRCODE = '55000';
  END IF;
  IF TG_OP = 'DELETE' THEN
    IF OLD.guest_booking_id IS NOT NULL THEN
      RAISE EXCEPTION 'Purchased add-on evidence cannot be deleted' USING ERRCODE = '55000';
    END IF;
    RETURN OLD;
  END IF;
  IF OLD.guest_booking_id IS NOT NULL AND ROW(
    NEW.id,
    NEW.property_id,
    NEW.guest_booking_id,
    NEW.quote_session_id,
    NEW.addon_definition_id,
    NEW.addon_snapshot,
    NEW.quantity,
    NEW.service_date,
    NEW.total_amount,
    NEW.currency,
    NEW.ownership_kind_snapshot,
    NEW.partner_commission_rate_snapshot
  ) IS DISTINCT FROM ROW(
    OLD.id,
    OLD.property_id,
    OLD.guest_booking_id,
    OLD.quote_session_id,
    OLD.addon_definition_id,
    OLD.addon_snapshot,
    OLD.quantity,
    OLD.service_date,
    OLD.total_amount,
    OLD.currency,
    OLD.ownership_kind_snapshot,
    OLD.partner_commission_rate_snapshot
  ) THEN
    RAISE EXCEPTION 'Purchased add-on evidence is immutable' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_booking_addon_selections_protect_purchased_evidence
BEFORE UPDATE OR DELETE ON booking.booking_addon_selections
FOR EACH ROW EXECUTE FUNCTION booking.protect_purchased_addon_evidence();

CREATE TRIGGER trg_booking_addon_selections_protect_truncate
BEFORE TRUNCATE ON booking.booking_addon_selections
FOR EACH STATEMENT EXECUTE FUNCTION booking.protect_purchased_addon_evidence();

CREATE INDEX idx_booking_addon_selections_finance_evidence
  ON booking.booking_addon_selections (property_id, service_date, guest_booking_id, id)
  WHERE guest_booking_id IS NOT NULL;

CREATE VIEW booking.finance_addon_purchase_evidence AS
SELECT
  id AS selection_id,
  property_id,
  guest_booking_id,
  addon_definition_id,
  service_date,
  quantity,
  total_amount AS gross_amount,
  currency,
  ownership_kind_snapshot AS ownership_kind,
  partner_commission_rate_snapshot AS partner_commission_rate
FROM booking.booking_addon_selections
WHERE guest_booking_id IS NOT NULL;

CREATE FUNCTION booking.reject_finance_addon_purchase_evidence_write()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Finance add-on purchase evidence is a read-only projection'
    USING ERRCODE = '55000';
END;
$$;

CREATE TRIGGER trg_finance_addon_purchase_evidence_read_only
INSTEAD OF INSERT OR UPDATE OR DELETE ON booking.finance_addon_purchase_evidence
FOR EACH ROW EXECUTE FUNCTION booking.reject_finance_addon_purchase_evidence_write();
