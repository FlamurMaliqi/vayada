-- Migration: 0113_pms_linked_inventory
-- Owner: domain-pms; see VAY-1338 and engineering/linked-inventory-contract.md

CREATE TABLE pms.linked_inventory_groups (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id UUID        NOT NULL REFERENCES hotel_catalog.properties(id) ON DELETE CASCADE,
  name        TEXT        NOT NULL,
  revision    INTEGER     NOT NULL DEFAULT 1 CHECK (revision BETWEEN 1 AND 2147483647),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (id, property_id),
  CONSTRAINT chk_pms_linked_inventory_group_name
    CHECK (name = btrim(name) AND name <> '')
);

CREATE UNIQUE INDEX uq_pms_linked_inventory_group_property_name
  ON pms.linked_inventory_groups (property_id, lower(name));

ALTER TABLE pms.room_types
  ADD COLUMN linked_inventory_group_id UUID,
  ADD CONSTRAINT fk_pms_room_type_linked_inventory_group_property
    FOREIGN KEY (linked_inventory_group_id, property_id)
    REFERENCES pms.linked_inventory_groups(id, property_id)
    ON DELETE RESTRICT;

CREATE INDEX idx_pms_room_types_linked_inventory_group
  ON pms.room_types (property_id, linked_inventory_group_id)
  WHERE linked_inventory_group_id IS NOT NULL;

ALTER TABLE pms.inventory_reservation_receipts
  ADD CONSTRAINT uq_pms_inventory_reservation_receipt_property
  UNIQUE (receipt_id, property_id),
  ADD CONSTRAINT uq_pms_inventory_reservation_receipt_room_type
  UNIQUE (receipt_id, property_id, room_type_id);

ALTER TABLE pms.operational_booking_assignments
  ADD CONSTRAINT uq_pms_operational_assignment_room_type
  UNIQUE (id, property_id, room_type_id);

ALTER TABLE pms.room_blocks
  ADD CONSTRAINT uq_pms_room_blocks_id_property UNIQUE (id, property_id),
  ADD CONSTRAINT uq_pms_room_blocks_id_property_room_type
    UNIQUE (id, property_id, room_type_id),
  ADD COLUMN block_kind TEXT NOT NULL DEFAULT 'manual',
  ADD COLUMN source_room_type_id UUID,
  ADD COLUMN source_inventory_reservation_receipt_id UUID,
  ADD COLUMN source_assignment_id UUID,
  ADD COLUMN source_room_block_id UUID,
  ADD CONSTRAINT chk_pms_room_blocks_kind
    CHECK (block_kind IN ('manual', 'linked_booking', 'linked_manual_block')),
  ADD CONSTRAINT chk_pms_room_blocks_linked_cause
    CHECK (
      (
        block_kind = 'manual'
        AND source_room_type_id IS NULL
        AND source_inventory_reservation_receipt_id IS NULL
        AND source_assignment_id IS NULL
        AND source_room_block_id IS NULL
      )
      OR (
        block_kind = 'linked_booking'
        AND room_id IS NULL
        AND source_room_type_id IS NOT NULL
        AND num_nonnulls(
          source_inventory_reservation_receipt_id,
          source_assignment_id
        ) = 1
        AND source_room_block_id IS NULL
      )
      OR (
        block_kind = 'linked_manual_block'
        AND room_id IS NULL
        AND source_room_type_id IS NOT NULL
        AND source_inventory_reservation_receipt_id IS NULL
        AND source_assignment_id IS NULL
        AND source_room_block_id IS NOT NULL
      )
    ),
  ADD CONSTRAINT chk_pms_room_blocks_linked_distinct_room_types
    CHECK (
      block_kind = 'manual'
      OR source_room_type_id <> room_type_id
    ),
  ADD CONSTRAINT fk_pms_room_blocks_source_room_type_property
    FOREIGN KEY (source_room_type_id, property_id)
    REFERENCES pms.room_types(id, property_id)
    ON DELETE CASCADE,
  ADD CONSTRAINT fk_pms_room_blocks_source_receipt_property
    FOREIGN KEY (
      source_inventory_reservation_receipt_id,
      property_id,
      source_room_type_id
    )
    REFERENCES pms.inventory_reservation_receipts(
      receipt_id,
      property_id,
      room_type_id
    )
    ON DELETE RESTRICT,
  ADD CONSTRAINT fk_pms_room_blocks_source_assignment_property
    FOREIGN KEY (source_assignment_id, property_id, source_room_type_id)
    REFERENCES pms.operational_booking_assignments(id, property_id, room_type_id)
    ON DELETE RESTRICT,
  ADD CONSTRAINT fk_pms_room_blocks_source_block_property
    FOREIGN KEY (source_room_block_id, property_id, source_room_type_id)
    REFERENCES pms.room_blocks(id, property_id, room_type_id)
    ON DELETE RESTRICT;

CREATE FUNCTION pms.validate_linked_manual_block_source()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.block_kind IS DISTINCT FROM OLD.block_kind THEN
    RAISE EXCEPTION 'room block kind is immutable'
      USING ERRCODE = '23514',
            CONSTRAINT = 'chk_pms_room_blocks_kind_immutable';
  END IF;
  IF NEW.block_kind = 'linked_manual_block'
    AND NOT EXISTS (
      SELECT 1
      FROM pms.room_blocks source
      WHERE source.id = NEW.source_room_block_id
        AND source.property_id = NEW.property_id
        AND source.room_type_id = NEW.source_room_type_id
        AND source.block_kind = 'manual'
    )
  THEN
    RAISE EXCEPTION 'linked manual block source must be a manual room block'
      USING ERRCODE = '23514',
            CONSTRAINT = 'chk_pms_room_blocks_linked_manual_source';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_pms_room_blocks_linked_manual_source
  BEFORE INSERT OR UPDATE OF
    block_kind, source_room_block_id, source_room_type_id, property_id
  ON pms.room_blocks
  FOR EACH ROW EXECUTE FUNCTION pms.validate_linked_manual_block_source();

CREATE UNIQUE INDEX uq_pms_linked_block_receipt_target
  ON pms.room_blocks (property_id, source_inventory_reservation_receipt_id, room_type_id)
  WHERE block_kind = 'linked_booking'
    AND source_inventory_reservation_receipt_id IS NOT NULL;
CREATE UNIQUE INDEX uq_pms_linked_block_assignment_target
  ON pms.room_blocks (property_id, source_assignment_id, room_type_id)
  WHERE block_kind = 'linked_booking' AND source_assignment_id IS NOT NULL;
CREATE UNIQUE INDEX uq_pms_linked_block_manual_target
  ON pms.room_blocks (property_id, source_room_block_id, room_type_id)
  WHERE block_kind = 'linked_manual_block';
