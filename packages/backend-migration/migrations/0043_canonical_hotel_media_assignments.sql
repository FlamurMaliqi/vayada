-- Migration: 0043_canonical_hotel_media_assignments
-- Owner: domain-hotels / domain-pms
-- See: engineering/hotel-onboarding-information-inventory.md
--
-- Adds normalized, revisioned references from Hotel Catalog and PMS to
-- Platform Media. Platform Media keeps object/variant ownership; removing an
-- assignment must never delete the reusable media object.

ALTER TABLE platform.media_objects
  ADD CONSTRAINT uq_platform_media_objects_id_property
  UNIQUE (id, property_id);

ALTER TABLE platform.media_variants
  ALTER CONSTRAINT fk_platform_media_variants_object_visibility
  DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE hotel_catalog.property_media
  ADD CONSTRAINT chk_property_media_sort_order
  CHECK (sort_order >= 0) NOT VALID,
  ADD CONSTRAINT fk_property_media_platform_object_property
  FOREIGN KEY (platform_media_object_id, property_id)
  REFERENCES platform.media_objects(id, property_id)
  NOT VALID;

-- The legacy public-profile writer can still produce multiple hero rows and
-- overlapping presentation orders. Add one-cover/one-logo/order uniqueness
-- in the cutover migration that retires that writer, alongside the CAS
-- repository that will own those invariants.

ALTER TABLE pms.room_types
  ADD COLUMN room_media_revision BIGINT NOT NULL DEFAULT 1,
  ADD CONSTRAINT chk_pms_room_types_room_media_revision
  CHECK (room_media_revision BETWEEN 1 AND 2147483647);

CREATE TABLE pms.room_type_media (
  property_id              UUID        NOT NULL,
  room_type_id             UUID        NOT NULL,
  platform_media_object_id UUID        NOT NULL,
  alt_text                 TEXT,
  sort_order               INTEGER     NOT NULL,
  created_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT pk_pms_room_type_media
    PRIMARY KEY (room_type_id, platform_media_object_id),
  CONSTRAINT uq_pms_room_type_media_order
    UNIQUE (room_type_id, sort_order),
  CONSTRAINT chk_pms_room_type_media_sort_order
    CHECK (sort_order BETWEEN 0 AND 19),
  CONSTRAINT chk_pms_room_type_media_alt_text
    CHECK (alt_text IS NULL OR char_length(alt_text) <= 500),
  CONSTRAINT fk_pms_room_type_media_room_property
    FOREIGN KEY (room_type_id, property_id)
    REFERENCES pms.room_types(id, property_id)
    ON DELETE CASCADE,
  CONSTRAINT fk_pms_room_type_media_object_property
    FOREIGN KEY (platform_media_object_id, property_id)
    REFERENCES platform.media_objects(id, property_id)
);

CREATE INDEX idx_pms_room_type_media_property_object
  ON pms.room_type_media (property_id, platform_media_object_id);
