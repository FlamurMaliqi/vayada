-- VAY-1283: additive Catalog projection of Booking-owned local arrival windows.
-- Existing single times, immutable Booking revisions and public snapshots are unchanged.
ALTER TABLE hotel_catalog.property_policy_summaries
  ADD COLUMN check_in_until TIME(0) WITHOUT TIME ZONE,
  ADD COLUMN check_out_from TIME(0) WITHOUT TIME ZONE,
  ADD CONSTRAINT chk_property_check_in_window CHECK (
    check_in_until IS NULL OR (check_in_time IS NOT NULL AND check_in_until > check_in_time
      AND EXTRACT(SECOND FROM check_in_until) = 0 AND check_in_until < TIME '24:00')
  ) NOT VALID,
  ADD CONSTRAINT chk_property_check_out_window CHECK (
    check_out_from IS NULL OR (check_out_time IS NOT NULL AND check_out_from < check_out_time
      AND EXTRACT(SECOND FROM check_out_from) = 0 AND check_out_from < TIME '24:00')
  ) NOT VALID;

CREATE OR REPLACE FUNCTION hotel_catalog.advance_property_policy_revision()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW.property_id IS DISTINCT FROM OLD.property_id THEN
      RAISE EXCEPTION 'property policy owner identity is immutable' USING ERRCODE = '23514';
    END IF;
    IF ROW(
      NEW.check_in_time, NEW.check_out_time, NEW.check_in_until, NEW.check_out_from, NEW.terms_and_conditions,
      NEW.cancellation_summary, NEW.cancellation_terms_url,
      NEW.deposit_policy_summary, NEW.payment_policy_summary,
      NEW.policy_source_owner
    ) IS NOT DISTINCT FROM ROW(
      OLD.check_in_time, OLD.check_out_time, OLD.check_in_until, OLD.check_out_from, OLD.terms_and_conditions,
      OLD.cancellation_summary, OLD.cancellation_terms_url,
      OLD.deposit_policy_summary, OLD.payment_policy_summary,
      OLD.policy_source_owner
    ) THEN
      RETURN NEW;
    END IF;
  END IF;

  PERFORM hotel_catalog.record_property_owner_revision(
    CASE WHEN TG_OP = 'DELETE' THEN OLD.property_id ELSE NEW.property_id END,
    'hotel_catalog.policy'
  );
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$;
