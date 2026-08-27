-- Migration: 0111_pms_inventory_receipt_handoff
-- Owner: domain-pms; see VAY-1338

CREATE FUNCTION pms.adopt_direct_booking_inventory_receipt()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  target_receipt_id UUID;
  receipt_row RECORD;
  assignment_count INTEGER;
  assignments_match BOOLEAN;
  target_assignment_id UUID;
BEGIN
  IF NEW.source <> 'direct_booking'
    OR NEW.stay_evidence_kind <> 'exact'
    OR NEW.assignment_status IN ('canceled', 'released')
  THEN
    RETURN NULL;
  END IF;

  SELECT (booking.booking_metadata #>> '{inventoryReservation,receiptId}')::uuid
    INTO target_receipt_id
  FROM booking.guest_bookings booking
  WHERE booking.id = NEW.guest_booking_id
    AND booking.property_id = NEW.property_id
    AND booking.booking_metadata #>> '{inventoryReservation,contractVersion}' =
      'pms-inventory-reservation-lifecycle.v1'
    AND booking.booking_metadata #>> '{inventoryReservation,owner}' = 'pms';
  IF target_receipt_id IS NULL THEN
    RETURN NULL;
  END IF;

  SELECT receipt.property_id, receipt.room_type_id, receipt.check_in, receipt.check_out,
         receipt.room_count, status.lifecycle_state, status.lifecycle_revision
    INTO receipt_row
  FROM pms.inventory_reservation_receipts receipt
  JOIN pms.inventory_reservation_statuses status USING (receipt_id)
  WHERE receipt.receipt_id = target_receipt_id
    AND receipt.property_id = NEW.property_id
  FOR UPDATE OF status;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'direct booking inventory receipt was not found for this property'
      USING ERRCODE = '23514',
            CONSTRAINT = 'chk_pms_direct_booking_receipt_handoff_scope';
  END IF;

  SELECT count(*)::integer,
         bool_and(
           assignment.room_type_id = receipt_row.room_type_id
           AND assignment.check_in = receipt_row.check_in
           AND assignment.check_out = receipt_row.check_out
         ),
         (array_agg(assignment.id ORDER BY assignment.position, assignment.id))[1]
    INTO assignment_count, assignments_match, target_assignment_id
  FROM pms.operational_booking_assignments assignment
  WHERE assignment.guest_booking_id = NEW.guest_booking_id
    AND assignment.property_id = NEW.property_id
    AND assignment.source = 'direct_booking'
    AND assignment.stay_evidence_kind = 'exact'
    AND assignment.assignment_status NOT IN ('canceled', 'released');
  IF assignment_count <> receipt_row.room_count OR assignments_match IS NOT TRUE THEN
    RAISE EXCEPTION 'direct booking assignments do not match the inventory receipt'
      USING ERRCODE = '23514',
            CONSTRAINT = 'chk_pms_direct_booking_receipt_handoff_scope';
  END IF;

  IF receipt_row.lifecycle_state = 'handed_off'
    AND receipt_row.lifecycle_revision = 2
  THEN
    RETURN NULL;
  END IF;
  IF receipt_row.lifecycle_state <> 'reserved'
    OR receipt_row.lifecycle_revision <> 1
  THEN
    RAISE EXCEPTION 'direct booking inventory receipt is not reserved'
      USING ERRCODE = '23514',
            CONSTRAINT = 'chk_pms_direct_booking_receipt_handoff_state';
  END IF;

  UPDATE pms.inventory_reservation_statuses
  SET lifecycle_state = 'handed_off', lifecycle_revision = 2,
      handed_off_at = COALESCE(NEW.assigned_at, NEW.created_at)
  WHERE receipt_id = target_receipt_id
    AND property_id = NEW.property_id
    AND lifecycle_state = 'reserved'
    AND lifecycle_revision = 1;

  UPDATE pms.room_blocks receipt_block
  SET status = 'released', released_at = COALESCE(NEW.assigned_at, NEW.created_at),
      updated_at = COALESCE(NEW.assigned_at, NEW.created_at)
  WHERE receipt_block.property_id = NEW.property_id
    AND receipt_block.source_inventory_reservation_receipt_id = target_receipt_id
    AND receipt_block.status = 'active'
    AND EXISTS (
      SELECT 1 FROM pms.room_blocks assignment_block
      WHERE assignment_block.property_id = receipt_block.property_id
        AND assignment_block.source_assignment_id = target_assignment_id
        AND assignment_block.room_type_id = receipt_block.room_type_id
    );
  UPDATE pms.room_blocks receipt_block
  SET source_inventory_reservation_receipt_id = NULL,
      source_assignment_id = target_assignment_id,
      updated_at = COALESCE(NEW.assigned_at, NEW.created_at)
  WHERE receipt_block.property_id = NEW.property_id
    AND receipt_block.source_inventory_reservation_receipt_id = target_receipt_id
    AND receipt_block.status = 'active';
  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER trg_pms_direct_booking_inventory_receipt_handoff
  AFTER INSERT ON pms.operational_booking_assignments
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION pms.adopt_direct_booking_inventory_receipt();
