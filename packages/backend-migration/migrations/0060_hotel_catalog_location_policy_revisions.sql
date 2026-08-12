-- Migration: 0060_hotel_catalog_location_policy_revisions
-- Owner: domain-hotels
-- See: VAY-1150, engineering/hotel-onboarding-information-inventory.md

CREATE TABLE hotel_catalog.property_owner_revisions (
  property_id UUID   NOT NULL REFERENCES hotel_catalog.properties(id) ON DELETE CASCADE,
  owner_key   TEXT   NOT NULL,
  revision    BIGINT NOT NULL,
  CONSTRAINT pk_property_owner_revisions PRIMARY KEY (property_id, owner_key),
  CONSTRAINT chk_property_owner_revisions_owner_key
    CHECK (owner_key IN ('hotel_catalog.location', 'hotel_catalog.policy')),
  CONSTRAINT chk_property_owner_revisions_revision
    CHECK (revision BETWEEN 1 AND 2147483647)
);

INSERT INTO hotel_catalog.property_owner_revisions (property_id, owner_key, revision)
SELECT property_id, 'hotel_catalog.location', 1
FROM hotel_catalog.property_locations;

INSERT INTO hotel_catalog.property_owner_revisions (property_id, owner_key, revision)
SELECT property_id, 'hotel_catalog.policy', 1
FROM hotel_catalog.property_policy_summaries;

CREATE FUNCTION hotel_catalog.next_property_owner_revision(current_revision BIGINT)
RETURNS BIGINT LANGUAGE plpgsql AS $$
BEGIN
  IF current_revision >= 2147483647 THEN
    RAISE EXCEPTION 'property owner revision exhausted' USING ERRCODE = '22003';
  END IF;
  RETURN current_revision + 1;
END;
$$;

CREATE FUNCTION hotel_catalog.record_property_owner_revision(
  target_property_id UUID,
  target_owner_key TEXT
)
RETURNS VOID LANGUAGE plpgsql AS $$
BEGIN
  -- A cascading property deletion removes the source identity and its history.
  IF NOT EXISTS (
    SELECT 1 FROM hotel_catalog.properties WHERE id = target_property_id
  ) THEN
    RETURN;
  END IF;

  INSERT INTO hotel_catalog.property_owner_revisions (property_id, owner_key, revision)
  VALUES (target_property_id, target_owner_key, 1)
  ON CONFLICT (property_id, owner_key) DO UPDATE
    SET revision = hotel_catalog.next_property_owner_revision(
      hotel_catalog.property_owner_revisions.revision
    );
END;
$$;

CREATE FUNCTION hotel_catalog.advance_property_location_revision()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW.property_id IS DISTINCT FROM OLD.property_id THEN
      RAISE EXCEPTION 'property location owner identity is immutable' USING ERRCODE = '23514';
    END IF;
    IF ROW(
      NEW.country_code, NEW.region, NEW.city, NEW.street_address, NEW.postal_code,
      NEW.raw_marketplace_location, NEW.latitude, NEW.longitude, NEW.timezone,
      NEW.address_public, NEW.geo_public, NEW.map_display_mode,
      NEW.source_confidence, NEW.migration_notes
    ) IS NOT DISTINCT FROM ROW(
      OLD.country_code, OLD.region, OLD.city, OLD.street_address, OLD.postal_code,
      OLD.raw_marketplace_location, OLD.latitude, OLD.longitude, OLD.timezone,
      OLD.address_public, OLD.geo_public, OLD.map_display_mode,
      OLD.source_confidence, OLD.migration_notes
    ) THEN
      RETURN NEW;
    END IF;
  END IF;

  PERFORM hotel_catalog.record_property_owner_revision(
    CASE WHEN TG_OP = 'DELETE' THEN OLD.property_id ELSE NEW.property_id END,
    'hotel_catalog.location'
  );
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$;

CREATE FUNCTION hotel_catalog.advance_property_policy_revision()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW.property_id IS DISTINCT FROM OLD.property_id THEN
      RAISE EXCEPTION 'property policy owner identity is immutable' USING ERRCODE = '23514';
    END IF;
    IF ROW(
      NEW.check_in_time, NEW.check_out_time, NEW.cancellation_summary,
      NEW.cancellation_terms_url, NEW.deposit_policy_summary,
      NEW.payment_policy_summary, NEW.policy_source_owner
    ) IS NOT DISTINCT FROM ROW(
      OLD.check_in_time, OLD.check_out_time, OLD.cancellation_summary,
      OLD.cancellation_terms_url, OLD.deposit_policy_summary,
      OLD.payment_policy_summary, OLD.policy_source_owner
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

CREATE TRIGGER trg_property_locations_advance_revision
  AFTER INSERT OR UPDATE OR DELETE ON hotel_catalog.property_locations
  FOR EACH ROW EXECUTE FUNCTION hotel_catalog.advance_property_location_revision();

CREATE TRIGGER trg_property_policy_summaries_advance_revision
  AFTER INSERT OR UPDATE OR DELETE ON hotel_catalog.property_policy_summaries
  FOR EACH ROW EXECUTE FUNCTION hotel_catalog.advance_property_policy_revision();
