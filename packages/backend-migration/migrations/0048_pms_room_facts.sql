-- Migration: 0048_pms_room_facts
-- Owner: domain-pms
-- See: engineering/hotel-onboarding-information-inventory.md (ONB-11)
--
-- Room facts and physical-room capacity are independent owner contracts.
-- It intentionally does not create, reconcile, relabel, or count physical room units.

-- Preserve existing pricing while allowing a room-facts-only write to omit the pair.
ALTER TABLE pms.room_types
  ALTER COLUMN base_rate_amount DROP DEFAULT,
  ALTER COLUMN base_rate_amount DROP NOT NULL,
  ALTER COLUMN currency DROP NOT NULL;

ALTER TABLE pms.room_types
  ADD CONSTRAINT chk_pms_room_types_price_currency_pair
  CHECK ((base_rate_amount IS NULL) = (currency IS NULL));

-- Preflight normalized names before changing any stored value. The migration
-- runner wraps this file in one transaction, so an invalid legacy row or a
-- normalized collision leaves the complete pre-0048 schema and data intact.
DO $$
DECLARE
  invalid_room_type_id UUID;
BEGIN
  SELECT id
  INTO invalid_room_type_id
  FROM pms.room_types
  WHERE char_length(btrim(name)) NOT BETWEEN 1 AND 200
    OR btrim(name) ~ '^[[:space:]]'
    OR btrim(name) ~ '[[:space:]]$'
  ORDER BY id
  LIMIT 1;

  IF FOUND THEN
    RAISE EXCEPTION 'room type % has an invalid normalized name', invalid_room_type_id
      USING ERRCODE = '23514',
            CONSTRAINT = 'chk_pms_room_types_name';
  END IF;
END;
$$;

DO $$
DECLARE
  duplicate_property_id UUID;
  duplicate_name TEXT;
BEGIN
  SELECT property_id, lower(btrim(name))
  INTO duplicate_property_id, duplicate_name
  FROM pms.room_types
  WHERE active
  GROUP BY property_id, lower(btrim(name))
  HAVING count(*) > 1
  ORDER BY property_id, lower(btrim(name))
  LIMIT 1;

  IF FOUND THEN
    RAISE EXCEPTION 'property % has duplicate normalized room type name %',
      duplicate_property_id, duplicate_name
      USING ERRCODE = '23505',
            CONSTRAINT = 'uq_pms_room_types_property_name_ci';
  END IF;
END;
$$;

UPDATE pms.room_types
SET name = btrim(name)
WHERE name <> btrim(name);

ALTER TABLE pms.room_types
  ADD COLUMN setup_draft_room_id TEXT,
  ADD COLUMN room_facts_revision BIGINT NOT NULL DEFAULT 1,
  ADD COLUMN room_units_revision BIGINT NOT NULL DEFAULT 1,
  ADD CONSTRAINT chk_pms_room_types_name
    CHECK (
      name = btrim(name)
      AND name !~ '^[[:space:]]'
      AND name !~ '[[:space:]]$'
      AND char_length(name) BETWEEN 1 AND 200
    ),
  ADD CONSTRAINT chk_pms_room_types_setup_draft_room_id
    CHECK (
      setup_draft_room_id IS NULL
      OR setup_draft_room_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
    ),
  ADD CONSTRAINT chk_pms_room_types_room_facts_revision
    CHECK (room_facts_revision BETWEEN 1 AND 2147483647),
  ADD CONSTRAINT chk_pms_room_types_room_units_revision
    CHECK (room_units_revision BETWEEN 1 AND 2147483647);

CREATE UNIQUE INDEX uq_pms_room_types_property_name_ci
  ON pms.room_types (property_id, lower(name))
  WHERE active;

CREATE UNIQUE INDEX uq_pms_room_types_property_setup_draft_room
  ON pms.room_types (property_id, setup_draft_room_id)
  WHERE setup_draft_room_id IS NOT NULL;

-- Existing room_number is the legacy physical-unit operational label. A blank
-- label carries no identity, so normalize only blank legacy values to NULL and
-- leave every nonblank legacy value unverified for an explicit later workflow.
ALTER TABLE pms.rooms
  ALTER COLUMN room_number DROP NOT NULL;

UPDATE pms.rooms
SET room_number = NULL
WHERE room_number IS NOT NULL
  AND room_number ~ '^[[:space:]]*$';

ALTER TABLE pms.rooms
  ADD COLUMN operational_label_status TEXT NOT NULL DEFAULT 'unverified',
  ADD CONSTRAINT chk_pms_rooms_operational_label_nonblank
    CHECK (
      room_number IS NULL
      OR (
        room_number <> ''
        AND room_number !~ '^[[:space:]]'
        AND room_number !~ '[[:space:]]$'
        AND char_length(room_number) <= 200
      )
    ),
  ADD CONSTRAINT chk_pms_rooms_operational_label_status
    CHECK (operational_label_status IN ('unverified', 'verified')),
  ADD CONSTRAINT chk_pms_rooms_verified_operational_label
    CHECK (
      operational_label_status = 'unverified'
      OR (
        room_number IS NOT NULL
        AND room_number !~ '^[[:space:]]'
        AND room_number !~ '[[:space:]]$'
        AND char_length(room_number) BETWEEN 1 AND 200
      )
    );

CREATE UNIQUE INDEX uq_pms_rooms_property_verified_label_ci
  ON pms.rooms (property_id, lower(room_number))
  WHERE operational_label_status = 'verified';
