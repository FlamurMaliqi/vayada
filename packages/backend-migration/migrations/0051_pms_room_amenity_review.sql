-- Migration: 0051_pms_room_amenity_review
-- Owner: domain-pms
-- See: VAY-1061, engineering/hotel-onboarding-information-inventory.md (ONB-13)
--
-- amenities_snapshot remains the existing typed-array source column. Independent
-- revision and review state make an explicit PMS-owner confirmation observable
-- without interpreting or rewriting legacy JSONB values.

ALTER TABLE pms.room_types
  ADD COLUMN room_amenities_revision BIGINT NOT NULL DEFAULT 1,
  ADD COLUMN room_amenities_reviewed_at TIMESTAMPTZ,
  ADD CONSTRAINT chk_pms_room_types_room_amenities_revision
    CHECK (room_amenities_revision BETWEEN 1 AND 2147483647),
  ADD CONSTRAINT chk_pms_room_types_room_amenities_review_state
    CHECK (
      room_amenities_reviewed_at IS NULL
      OR room_amenities_revision >= 2
    );
