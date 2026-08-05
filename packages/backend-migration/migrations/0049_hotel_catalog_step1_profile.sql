-- Migration: 0049_hotel_catalog_step1_profile
-- Owner: domain-hotels
-- See: VAY-1067, engineering/hotel-onboarding-information-inventory.md
--
-- A row records that the owner explicitly reviewed the complete Hotel Catalog
-- amenity selection. Row presence is meaningful: zero property_amenities plus
-- one review row is the canonical "reviewed, none selected" state.

CREATE TABLE hotel_catalog.property_amenity_review_state (
  property_id          UUID        PRIMARY KEY
                                  REFERENCES hotel_catalog.properties(id) ON DELETE CASCADE,
  reviewed_by_user_id  UUID        NOT NULL REFERENCES identity.users(id),
  reviewed_at          TIMESTAMPTZ NOT NULL,
  updated_at           TIMESTAMPTZ NOT NULL,
  CONSTRAINT chk_property_amenity_review_state_timestamps
    CHECK (updated_at >= reviewed_at)
);
