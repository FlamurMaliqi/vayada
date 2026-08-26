-- Migration: 0110_pms_linked_assignment_causality
-- Owner: domain-pms; see VAY-1338 and VAY-1339

ALTER TABLE pms.room_blocks
  DROP CONSTRAINT fk_pms_room_blocks_source_assignment_property,
  ADD CONSTRAINT fk_pms_room_blocks_source_assignment_property
    FOREIGN KEY (source_assignment_id, property_id)
    REFERENCES pms.operational_booking_assignments(id, property_id)
    ON DELETE RESTRICT;

CREATE FUNCTION pms.validate_linked_assignment_source()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.block_kind = 'linked_booking'
    AND NEW.source_assignment_id IS NOT NULL
    AND NEW.status = 'active'
    AND NOT EXISTS (
      SELECT 1
      FROM pms.operational_booking_assignments assignment
      WHERE assignment.id = NEW.source_assignment_id
        AND assignment.property_id = NEW.property_id
        AND assignment.room_type_id = NEW.source_room_type_id
    )
  THEN
    RAISE EXCEPTION 'active linked assignment block must match its current source room type'
      USING ERRCODE = '23514',
            CONSTRAINT = 'chk_pms_room_blocks_linked_assignment_source';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_pms_room_blocks_linked_assignment_source
  BEFORE INSERT OR UPDATE OF
    block_kind, source_assignment_id, source_room_type_id, property_id, status
  ON pms.room_blocks
  FOR EACH ROW EXECUTE FUNCTION pms.validate_linked_assignment_source();

CREATE FUNCTION pms.validate_assignment_linked_blocks_current()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.room_type_id IS DISTINCT FROM OLD.room_type_id
    AND EXISTS (
      SELECT 1
      FROM pms.room_blocks derived
      JOIN pms.operational_booking_assignments current_assignment
        ON current_assignment.id = NEW.id
       AND current_assignment.property_id = NEW.property_id
      WHERE derived.source_assignment_id = NEW.id
        AND derived.property_id = NEW.property_id
        AND derived.block_kind = 'linked_booking'
        AND derived.status = 'active'
        AND derived.source_room_type_id <> current_assignment.room_type_id
    )
  THEN
    RAISE EXCEPTION 'active linked assignment blocks must match the committed room type'
      USING ERRCODE = '23514',
            CONSTRAINT = 'chk_pms_assignment_linked_blocks_current';
  END IF;
  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER trg_pms_assignment_linked_blocks_current
  AFTER UPDATE ON pms.operational_booking_assignments
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION pms.validate_assignment_linked_blocks_current();
