-- Migration: 0045_property_setup_drafts
-- Owner: domain-hotels
-- See: VAY-1045, engineering/hotel-onboarding-information-inventory.md
--
-- Stores resumable, incomplete setup input without duplicating canonical
-- hotel, Marketplace, Booking, PMS, or Finance records.
-- Writers persist selected tracks in canonical order: hotel_operations before
-- creator_marketplace. Writers that extend retention also set updated_at in
-- the same statement; setup-draft timestamps are application-maintained.

CREATE FUNCTION hotel_catalog.property_setup_step_ids_are_unique(step_ids TEXT[])
RETURNS BOOLEAN
LANGUAGE SQL
IMMUTABLE
PARALLEL SAFE
AS $$
  SELECT cardinality(step_ids) = count(DISTINCT step_id)
  FROM unnest(step_ids) AS unnested(step_id);
$$;

CREATE TABLE hotel_catalog.property_setup_sessions (
  id                    UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id       UUID        NOT NULL
                                      REFERENCES identity.organizations(id) ON DELETE CASCADE,
  property_id           UUID        NOT NULL
                                      REFERENCES hotel_catalog.properties(id) ON DELETE CASCADE,
  contract_version      TEXT        NOT NULL DEFAULT 'property-setup-draft.v1',
  status                TEXT        NOT NULL DEFAULT 'active',
  selected_tracks       TEXT[]      NOT NULL,
  track_revision        INTEGER     NOT NULL,
  revision              INTEGER     NOT NULL DEFAULT 1,
  resume_step_id        TEXT,
  completed_step_ids    TEXT[]      NOT NULL DEFAULT '{}'::TEXT[],
  retention_expires_at  TIMESTAMPTZ NOT NULL,
  completed_at          TIMESTAMPTZ,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT chk_property_setup_sessions_contract
    CHECK (contract_version = 'property-setup-draft.v1'),
  CONSTRAINT chk_property_setup_sessions_status
    CHECK (
      (status = 'active' AND completed_at IS NULL)
      OR
      (status = 'completed' AND completed_at IS NOT NULL)
    ),
  CONSTRAINT chk_property_setup_sessions_tracks
    CHECK (
      selected_tracks = ARRAY['hotel_operations']::TEXT[]
      OR selected_tracks = ARRAY['creator_marketplace']::TEXT[]
      OR selected_tracks = ARRAY['hotel_operations', 'creator_marketplace']::TEXT[]
    ),
  CONSTRAINT chk_property_setup_sessions_revisions
    CHECK (track_revision >= 1 AND revision >= 1),
  -- Keep the supported step IDs explicit in each constraint so every dumped
  -- constraint remains self-contained; update all three lists together.
  CONSTRAINT chk_property_setup_sessions_resume_step
    CHECK (
      resume_step_id IS NULL
      OR resume_step_id IN (
        'present_hotel',
        'marketplace_preferences',
        'booking_design',
        'rooms',
        'pricing',
        'calendar',
        'guest_experience',
        'payments',
        'review'
      )
    ),
  CONSTRAINT chk_property_setup_sessions_completed_steps
    CHECK (
      cardinality(completed_step_ids) <= 9
      AND array_position(completed_step_ids, NULL) IS NULL
      AND hotel_catalog.property_setup_step_ids_are_unique(completed_step_ids)
      AND completed_step_ids <@ ARRAY[
        'present_hotel',
        'marketplace_preferences',
        'booking_design',
        'rooms',
        'pricing',
        'calendar',
        'guest_experience',
        'payments',
        'review'
      ]::TEXT[]
    ),
  CONSTRAINT chk_property_setup_sessions_retention
    CHECK (
      retention_expires_at > created_at
      AND (
        (
          status = 'active'
          AND retention_expires_at <= updated_at + INTERVAL '90 days'
        )
        OR
        (
          status = 'completed'
          AND retention_expires_at > completed_at
          AND retention_expires_at <= completed_at + INTERVAL '30 days'
        )
      )
    )
);

CREATE UNIQUE INDEX uq_property_setup_sessions_active_scope
  ON hotel_catalog.property_setup_sessions (organization_id, property_id)
  WHERE status = 'active';

CREATE INDEX idx_property_setup_sessions_retention
  ON hotel_catalog.property_setup_sessions (retention_expires_at, id);

CREATE TABLE hotel_catalog.property_setup_step_drafts (
  session_id           UUID        NOT NULL
                                    REFERENCES hotel_catalog.property_setup_sessions(id) ON DELETE CASCADE,
  step_id              TEXT        NOT NULL,
  revision             INTEGER     NOT NULL DEFAULT 1,
  payload              JSONB       NOT NULL DEFAULT '{}'::JSONB,
  dirty_fields         TEXT[]      NOT NULL DEFAULT '{}'::TEXT[],
  base_revisions       JSONB       NOT NULL DEFAULT '{}'::JSONB,
  pii_classification   TEXT        NOT NULL DEFAULT 'potential_incidental_pii',
  retention_expires_at TIMESTAMPTZ NOT NULL,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (session_id, step_id),
  CONSTRAINT chk_property_setup_step_drafts_step
    CHECK (
      step_id IN (
        'present_hotel',
        'marketplace_preferences',
        'booking_design',
        'rooms',
        'pricing',
        'calendar',
        'guest_experience',
        'payments',
        'review'
      )
    ),
  CONSTRAINT chk_property_setup_step_drafts_revision
    CHECK (revision >= 1),
  CONSTRAINT chk_property_setup_step_drafts_payload
    CHECK (
      jsonb_typeof(payload) = 'object'
      AND octet_length(payload::TEXT) <= 65536
    ),
  CONSTRAINT chk_property_setup_step_drafts_dirty_fields
    CHECK (
      cardinality(dirty_fields) <= 64
      AND array_position(dirty_fields, NULL) IS NULL
    ),
  CONSTRAINT chk_property_setup_step_drafts_base_revisions
    CHECK (
      jsonb_typeof(base_revisions) = 'object'
      AND octet_length(base_revisions::TEXT) <= 8192
    ),
  CONSTRAINT chk_property_setup_step_drafts_pii
    CHECK (pii_classification = 'potential_incidental_pii'),
  CONSTRAINT chk_property_setup_step_drafts_retention
    CHECK (
      retention_expires_at > updated_at
      AND retention_expires_at <= updated_at + INTERVAL '90 days'
    )
);

CREATE INDEX idx_property_setup_step_drafts_retention
  ON hotel_catalog.property_setup_step_drafts (retention_expires_at, session_id, step_id);
