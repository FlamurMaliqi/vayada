-- VAY-910: bind amended bundles to their recorded Booking date-change decision.

CREATE OR REPLACE FUNCTION pms.adopt_direct_booking_inventory_receipt()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  booking_receipt_text TEXT;
  booking_row RECORD;
  is_bundle BOOLEAN := FALSE;
  inventory_quote TEXT;
  explicit_receipt_text TEXT;
  target_receipt_id UUID;
  assignment_row RECORD;
  receipt_row RECORD;
  assignment_count INTEGER;
  assignments_match BOOLEAN;
  target_assignment_id UUID; target_changed_at TIMESTAMPTZ; released_receipt_blocks INTEGER;
BEGIN
  SELECT current_assignment.* INTO assignment_row
  FROM pms.operational_booking_assignments current_assignment
  WHERE current_assignment.id = NEW.id;
  IF NOT FOUND THEN
    RETURN NULL;
  END IF;
  IF assignment_row.source <> 'direct_booking'
    OR assignment_row.stay_evidence_kind <> 'exact'
    OR assignment_row.assignment_status IN ('canceled', 'released')
  THEN
    RETURN NULL;
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('pms-inventory:' || assignment_row.property_id::text, 0));

  SELECT booking.booking_metadata #>> '{inventoryReservation,receiptId}'
    INTO booking_receipt_text
  FROM booking.guest_bookings booking
  WHERE booking.id = assignment_row.guest_booking_id
    AND booking.property_id = assignment_row.property_id
    AND booking.booking_metadata #>> '{inventoryReservation,contractVersion}' =
      'pms-inventory-reservation-lifecycle.v1'
    AND booking.booking_metadata #>> '{inventoryReservation,owner}' = 'pms';
  explicit_receipt_text :=
    assignment_row.assignment_payload #>> '{inventoryReservation,receiptId}';
  SELECT booking.* INTO booking_row FROM booking.guest_bookings booking
  WHERE booking.id = assignment_row.guest_booking_id AND booking.property_id = assignment_row.property_id;
  is_bundle := COALESCE(booking_row.booking_metadata #>> '{inventoryReservation,contractVersion}' =
    'pms-inventory-reservation-bundle.v1', FALSE);
  IF is_bundle THEN
    inventory_quote := COALESCE(booking_row.booking_metadata->>'inventoryQuoteSessionId', booking_row.quote_session_id::text);
    IF inventory_quote IS DISTINCT FROM booking_row.quote_session_id::text AND NOT (
      EXISTS (SELECT 1 FROM booking.booking_change_requests change_request
        WHERE change_request.guest_booking_id=booking_row.id AND change_request.status='accepted'
          AND inventory_quote='change-request:' || change_request.id::text
          AND change_request.id::text=booking_row.booking_metadata->>'lastAcceptedChangeRequestId'
          AND change_request.requested_changes->>'requestedCheckIn'=booking_row.check_in::text
          AND change_request.requested_changes->>'requestedCheckOut'=booking_row.check_out::text
          AND change_request.requested_changes#>'{pricingSnapshot,selectedOffer,roomSelection}'=
            booking_row.booking_metadata#>'{selectedOffer,roomSelection}')
      OR EXISTS (SELECT 1 FROM booking.host_action_previews preview
        JOIN booking.booking_status_events event ON event.guest_booking_id=preview.guest_booking_id
          AND event.event_type='guest_booking.host_dates_updated'
          AND event.event_payload->>'changeRequestId'=preview.id::text
          AND event.actor_user_id=preview.actor_user_id
          AND event.occurred_at >= preview.created_at AND event.occurred_at < preview.expires_at
        WHERE preview.property_id=booking_row.property_id AND preview.guest_booking_id=booking_row.id
          AND inventory_quote='host-edit:' || preview.id::text AND preview.action='edit_dates'
          AND preview.id::text=booking_row.booking_metadata->>'lastHostEditPreviewId'
          AND preview.request->>'checkIn'=booking_row.check_in::text
          AND preview.request->>'checkOut'=booking_row.check_out::text)
    ) THEN
      RAISE EXCEPTION 'inventory bundle has no matching date-change decision' USING ERRCODE='23514',
        CONSTRAINT='chk_pms_direct_booking_receipt_handoff_scope';
    END IF;
    IF booking_row.booking_metadata #>> '{inventoryReservation,owner}' IS DISTINCT FROM 'pms'
      OR jsonb_typeof(booking_row.booking_metadata #> '{inventoryReservation,receipts}') IS DISTINCT FROM 'array'
    THEN
      RAISE EXCEPTION 'invalid inventory receipt bundle' USING ERRCODE = '23514',
        CONSTRAINT = 'chk_pms_direct_booking_receipt_handoff_scope';
    END IF;
    -- Deferred check sees the final assignment set: every receipt must have all its rooms.
    IF NOT EXISTS (
      WITH tokens AS (
        SELECT token FROM jsonb_array_elements(booking_row.booking_metadata #> '{inventoryReservation,receipts}') token
      ), expected AS (
        SELECT receipt.*, status.lifecycle_state, token
        FROM tokens JOIN pms.inventory_reservation_receipts receipt ON receipt.receipt_id::text = token->>'receiptId'
        JOIN pms.inventory_reservation_statuses status USING(receipt_id)
        WHERE receipt.property_id=assignment_row.property_id
          AND receipt.quote_session_id=inventory_quote
          AND receipt.check_in=booking_row.check_in AND receipt.check_out=booking_row.check_out
      )
      SELECT 1 FROM expected
      HAVING count(*) BETWEEN 1 AND 99
        AND count(*)=(SELECT count(*) FROM tokens)
        AND count(*)=count(DISTINCT receipt_id)
        AND count(*)=count(DISTINCT room_type_id)
        AND count(*)=(SELECT count(*) FROM pms.inventory_reservation_receipts r
          WHERE r.property_id=assignment_row.property_id AND r.quote_session_id=inventory_quote)
        AND sum(room_count)=booking_row.room_count
        AND sum(room_count)=(SELECT count(*) FROM pms.operational_booking_assignments a
          WHERE a.property_id=assignment_row.property_id AND a.guest_booking_id=assignment_row.guest_booking_id
            AND a.source='direct_booking' AND a.stay_evidence_kind='exact' AND a.assignment_status NOT IN ('canceled','released'))
        AND bool_and(token->>'contractVersion'='pms-inventory-reservation-lifecycle.v1' AND token->>'owner'='pms'
          AND lifecycle_state IN ('reserved','handed_off')
          AND room_count=(SELECT count(*) FROM pms.operational_booking_assignments a
            WHERE a.property_id=assignment_row.property_id AND a.guest_booking_id=assignment_row.guest_booking_id
              AND a.source='direct_booking' AND a.stay_evidence_kind='exact' AND a.assignment_status NOT IN ('canceled','released')
              AND a.assignment_payload->'inventoryReservation'=expected.token
              AND a.check_in=expected.check_in AND a.check_out=expected.check_out
              AND (expected.lifecycle_state='handed_off' OR a.room_type_id=expected.room_type_id)))
    ) THEN
      RAISE EXCEPTION 'assignments do not match the complete inventory receipt bundle' USING ERRCODE = '23514',
        CONSTRAINT = 'chk_pms_direct_booking_receipt_handoff_scope';
    END IF;
    SELECT token->>'receiptId' INTO booking_receipt_text
    FROM jsonb_array_elements(booking_row.booking_metadata #> '{inventoryReservation,receipts}') token
    WHERE token->>'receiptId'=explicit_receipt_text;
    IF booking_receipt_text IS NULL THEN
      RAISE EXCEPTION 'assignment requires a receipt from its booking bundle' USING ERRCODE = '23514',
        CONSTRAINT = 'chk_pms_direct_booking_receipt_handoff_scope';
    END IF;
  END IF;
  IF TG_OP = 'UPDATE' AND explicit_receipt_text IS NULL THEN IF OLD.assignment_payload #>> '{inventoryReservation,receiptId}' IS NOT NULL THEN RAISE EXCEPTION 'direct booking assignment receipt cannot be removed' USING ERRCODE = '23514', CONSTRAINT = 'chk_pms_direct_booking_receipt_handoff_scope'; END IF; RETURN NULL; END IF;

  IF booking_receipt_text IS NULL AND explicit_receipt_text IS NULL THEN
    RETURN NULL;
  END IF;
  IF explicit_receipt_text IS NOT NULL AND (
    assignment_row.assignment_payload #>> '{inventoryReservation,contractVersion}'
      IS DISTINCT FROM 'pms-inventory-reservation-lifecycle.v1'
    OR assignment_row.assignment_payload #>> '{inventoryReservation,owner}' IS DISTINCT FROM 'pms'
  ) THEN
    RAISE EXCEPTION 'direct booking assignment receipt is not a PMS receipt'
      USING ERRCODE = '23514',
            CONSTRAINT = 'chk_pms_direct_booking_receipt_handoff_scope';
  END IF;
  IF COALESCE(explicit_receipt_text, booking_receipt_text) !~*
    '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
  THEN
    RAISE EXCEPTION 'direct booking inventory receipt identifier is invalid'
      USING ERRCODE = '23514',
            CONSTRAINT = 'chk_pms_direct_booking_receipt_handoff_scope';
  END IF;
  target_receipt_id := COALESCE(explicit_receipt_text, booking_receipt_text)::uuid;

  SELECT receipt.property_id, receipt.room_type_id, receipt.check_in, receipt.check_out,
         receipt.room_count, status.lifecycle_state, status.lifecycle_revision
    INTO receipt_row
  FROM pms.inventory_reservation_receipts receipt
  JOIN pms.inventory_reservation_statuses status USING (receipt_id)
  WHERE receipt.receipt_id = target_receipt_id
    AND receipt.property_id = assignment_row.property_id
  FOR UPDATE OF status;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'direct booking inventory receipt was not found for this property'
      USING ERRCODE = '23514',
            CONSTRAINT = 'chk_pms_direct_booking_receipt_handoff_scope';
  END IF;

  IF receipt_row.lifecycle_state = 'handed_off'
    AND receipt_row.lifecycle_revision = 2
  THEN
    IF explicit_receipt_text IS NOT NULL
      AND lower(booking_receipt_text) IS DISTINCT FROM lower(explicit_receipt_text)
    THEN
      RAISE EXCEPTION 'direct booking receipt tokens do not match'
        USING ERRCODE = '23514',
              CONSTRAINT = 'chk_pms_direct_booking_receipt_handoff_scope';
    END IF;
  ELSIF receipt_row.lifecycle_state <> 'reserved'
    OR receipt_row.lifecycle_revision <> 1
  THEN
    RAISE EXCEPTION 'direct booking inventory receipt is not reserved'
      USING ERRCODE = '23514',
            CONSTRAINT = 'chk_pms_direct_booking_receipt_handoff_state';
  END IF;
  IF receipt_row.lifecycle_state = 'reserved' AND (
    explicit_receipt_text IS NULL
    OR lower(booking_receipt_text) IS DISTINCT FROM lower(explicit_receipt_text)
  ) THEN
    RAISE EXCEPTION 'reserved direct booking receipt requires matching explicit tokens'
      USING ERRCODE = '23514',
            CONSTRAINT = 'chk_pms_direct_booking_receipt_handoff_scope';
  END IF;

  SELECT count(*)::integer,
         bool_and(COALESCE(
           (receipt_row.lifecycle_state = 'handed_off'
             OR assignment.room_type_id = receipt_row.room_type_id)
           AND assignment.check_in = receipt_row.check_in
           AND assignment.check_out = receipt_row.check_out
           AND assignment.assignment_payload #>> '{inventoryReservation,contractVersion}' =
             'pms-inventory-reservation-lifecycle.v1'
           AND assignment.assignment_payload #>> '{inventoryReservation,owner}' = 'pms'
           AND assignment.assignment_payload #>> '{inventoryReservation,receiptId}' =
             target_receipt_id::text
         , FALSE)),
         (array_agg(assignment.id ORDER BY assignment.position, assignment.id))[1]
    INTO assignment_count, assignments_match, target_assignment_id
  FROM pms.operational_booking_assignments assignment
  WHERE assignment.guest_booking_id = assignment_row.guest_booking_id
    AND assignment.property_id = assignment_row.property_id
    AND assignment.source = 'direct_booking'
    AND assignment.stay_evidence_kind = 'exact'
    AND assignment.assignment_status NOT IN ('canceled', 'released')
    AND (NOT is_bundle OR assignment.assignment_payload #>> '{inventoryReservation,receiptId}' = target_receipt_id::text);
  IF assignment_count <> receipt_row.room_count OR assignments_match IS NOT TRUE THEN
    RAISE EXCEPTION 'direct booking assignments do not match the inventory receipt'
      USING ERRCODE = '23514',
            CONSTRAINT = 'chk_pms_direct_booking_receipt_handoff_scope';
  END IF;
  IF receipt_row.lifecycle_state = 'handed_off' THEN
    RETURN NULL;
  END IF;

  target_changed_at := CASE WHEN TG_OP = 'UPDATE'
    THEN assignment_row.updated_at
    ELSE COALESCE(assignment_row.assigned_at, assignment_row.created_at) END;
  UPDATE pms.inventory_reservation_statuses
  SET lifecycle_state = 'handed_off', lifecycle_revision = 2,
      handed_off_at = target_changed_at
  WHERE receipt_id = target_receipt_id
    AND property_id = assignment_row.property_id
    AND lifecycle_state = 'reserved'
    AND lifecycle_revision = 1;

  UPDATE pms.room_blocks receipt_block
  SET status = 'released', released_at = target_changed_at,
      updated_at = target_changed_at
  WHERE receipt_block.property_id = assignment_row.property_id
    AND receipt_block.source_inventory_reservation_receipt_id = target_receipt_id
    AND receipt_block.status = 'active'
    AND EXISTS (
      SELECT 1 FROM pms.room_blocks assignment_block
      WHERE assignment_block.property_id = receipt_block.property_id
        AND assignment_block.source_assignment_id = target_assignment_id
        AND assignment_block.room_type_id = receipt_block.room_type_id
    );
  GET DIAGNOSTICS released_receipt_blocks = ROW_COUNT;
  UPDATE pms.room_blocks receipt_block
  SET source_inventory_reservation_receipt_id = NULL,
      source_assignment_id = target_assignment_id,
      updated_at = target_changed_at
  WHERE receipt_block.property_id = assignment_row.property_id
    AND receipt_block.source_inventory_reservation_receipt_id = target_receipt_id
    AND receipt_block.status = 'active';
  IF released_receipt_blocks > 0 THEN
    WITH desired AS (
      SELECT inventory.room_type_id, inventory.stay_date,
        LEAST(COALESCE(sum(active.blocked_count), 0),
          GREATEST(inventory.total_count - inventory.assigned_count, 0))::integer blocked_count
      FROM pms.inventory_days inventory
      JOIN pms.room_blocks receipt_block
        ON receipt_block.property_id = inventory.property_id AND receipt_block.room_type_id = inventory.room_type_id
       AND receipt_block.source_inventory_reservation_receipt_id = target_receipt_id
       AND inventory.stay_date BETWEEN receipt_block.starts_on AND receipt_block.ends_on
      LEFT JOIN pms.room_blocks active
        ON active.property_id = inventory.property_id AND active.room_type_id = inventory.room_type_id
       AND active.status = 'active'
       AND inventory.stay_date BETWEEN active.starts_on AND active.ends_on
      WHERE inventory.property_id = assignment_row.property_id
      GROUP BY inventory.room_type_id, inventory.stay_date, inventory.total_count, inventory.assigned_count
    )
    UPDATE pms.inventory_days inventory
    SET blocked_count = desired.blocked_count,
        available_count = CASE WHEN inventory.status = 'closed' OR inventory.linked_stop_sell THEN 0
          ELSE GREATEST(0, inventory.effective_sellable_limit_count - inventory.assigned_count
            - desired.blocked_count) END,
        inventory_revision = inventory.inventory_revision + 1,
        block_source_revision = inventory.block_source_revision + 1,
        updated_at = target_changed_at
    FROM desired
    WHERE inventory.property_id = assignment_row.property_id
      AND inventory.room_type_id = desired.room_type_id
      AND inventory.stay_date = desired.stay_date
      AND inventory.blocked_count IS DISTINCT FROM desired.blocked_count;
  END IF;
  RETURN NULL;
END;
$$;
