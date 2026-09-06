-- Owner: domain-hotels. VAY-1477; engineering/location-nearby-contract-v1.md.
-- Hotel-authored content only; no provider descriptions or coordinate cache.
CREATE TABLE hotel_catalog.property_nearby_curation (
  property_id UUID PRIMARY KEY REFERENCES hotel_catalog.properties(id) ON DELETE CASCADE,
  revision BIGINT NOT NULL CHECK (revision BETWEEN 1 AND 9007199254740991),
  saved_profile_revision BIGINT NOT NULL CHECK (saved_profile_revision >= 1),
  choices JSONB NOT NULL DEFAULT '[]' CHECK (jsonb_typeof(choices) = 'array'),
  custom_places JSONB NOT NULL DEFAULT '[]' CHECK (jsonb_typeof(custom_places) = 'array'),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (jsonb_array_length(choices) <= 100),
  CHECK (jsonb_array_length(custom_places) <= 20)
);
