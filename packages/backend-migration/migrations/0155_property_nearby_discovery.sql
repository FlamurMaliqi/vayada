-- IDs and category buckets only; provider coordinates/content are never persisted.
CREATE TABLE hotel_catalog.property_nearby_discovery (
  property_id UUID PRIMARY KEY REFERENCES hotel_catalog.properties(id) ON DELETE CASCADE,
  profile_revision BIGINT NOT NULL CHECK (profile_revision > 0),
  policy_version TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('refreshing','ready','empty','quota_exhausted','timeout','provider_unavailable','invalid_response')),
  places JSONB NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(places) = 'array' AND jsonb_array_length(places) <= 40),
  fetched_at TIMESTAMPTZ,
  valid_until TIMESTAMPTZ,
  retry_after TIMESTAMPTZ NOT NULL,
  explicit_refresh_after TIMESTAMPTZ,
  lease_token UUID,
  lease_expires_at TIMESTAMPTZ,
  CHECK ((lease_token IS NULL) = (lease_expires_at IS NULL))
);
