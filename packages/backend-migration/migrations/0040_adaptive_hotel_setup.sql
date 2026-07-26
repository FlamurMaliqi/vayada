-- Migration: 0040_adaptive_hotel_setup
-- Owner: domain-hotels
-- See: VAY-965, engineering/adaptive-hotel-onboarding.md
--
-- Stores the outcome tracks selected for a hotel-group organization. Product
-- entitlements remain the source of truth for effective access.

CREATE TABLE hotel_catalog.organization_setup_track_intents (
  organization_id UUID        PRIMARY KEY REFERENCES identity.organizations(id) ON DELETE CASCADE,
  selected_tracks TEXT[]      NOT NULL,
  revision        INTEGER     NOT NULL DEFAULT 1,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT chk_organization_setup_track_intents_tracks
    CHECK (
      selected_tracks = ARRAY['hotel_operations']::TEXT[]
      OR selected_tracks = ARRAY['creator_marketplace']::TEXT[]
      OR selected_tracks = ARRAY['hotel_operations', 'creator_marketplace']::TEXT[]
    ),
  CONSTRAINT chk_organization_setup_track_intents_revision
    CHECK (revision >= 1)
);
