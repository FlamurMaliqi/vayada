-- Migration: 0042_canonical_property_profile_revision
-- Owner: domain-hotels
-- See: engineering/adaptive-hotel-onboarding.md

ALTER TABLE hotel_catalog.properties
  ADD COLUMN profile_revision BIGINT NOT NULL DEFAULT 1,
  ADD CONSTRAINT chk_properties_profile_revision
    CHECK (profile_revision BETWEEN 1 AND 2147483647);

ALTER TABLE hotel_catalog.property_contact_channels
  ADD COLUMN purpose TEXT NOT NULL DEFAULT 'general',
  ADD CONSTRAINT chk_property_contact_channels_purpose
    CHECK (purpose IN ('general', 'operations', 'guest', 'creator'));
