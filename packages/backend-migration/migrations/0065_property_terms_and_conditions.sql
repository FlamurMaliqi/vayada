-- Migration: 0065_property_terms_and_conditions
-- Owner: domain-hotels
-- See: VAY-1243

ALTER TABLE hotel_catalog.property_policy_summaries
  ADD COLUMN terms_and_conditions TEXT;

CREATE OR REPLACE FUNCTION hotel_catalog.advance_property_policy_revision()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW.property_id IS DISTINCT FROM OLD.property_id THEN
      RAISE EXCEPTION 'property policy owner identity is immutable' USING ERRCODE = '23514';
    END IF;
    IF ROW(
      NEW.check_in_time, NEW.check_out_time, NEW.terms_and_conditions,
      NEW.cancellation_summary, NEW.cancellation_terms_url,
      NEW.deposit_policy_summary, NEW.payment_policy_summary,
      NEW.policy_source_owner
    ) IS NOT DISTINCT FROM ROW(
      OLD.check_in_time, OLD.check_out_time, OLD.terms_and_conditions,
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
