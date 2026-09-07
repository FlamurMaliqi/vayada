-- VAY-910: PMS owns verification of the complete editable hold and its per-type credits.
CREATE OR REPLACE VIEW pms.pending_booking_edit_receipts AS
WITH candidates AS (
  SELECT b.id guest_booking_id,b.property_id,b.room_count booking_room_count,
    receipt.receipt_id,receipt.room_type_id,receipt.public_offer_key,receipt.check_in,receipt.check_out,
    receipt.room_count,status.lifecycle_state,
    (SELECT count(*) FROM pms.inventory_reservation_receipts all_receipts WHERE all_receipts.property_id=b.property_id
      AND all_receipts.quote_session_id=b.quote_session_id::text) actual_receipts,
    CASE WHEN jsonb_typeof(b.booking_metadata#>'{selectedOffer,roomSelection,lines}')='array'
      THEN jsonb_array_length(b.booking_metadata#>'{selectedOffer,roomSelection,lines}') ELSE 1 END selection_lines,
    CASE WHEN b.booking_metadata#>>'{inventoryReservation,contractVersion}'='pms-inventory-reservation-bundle.v1'
      THEN jsonb_array_length(b.booking_metadata#>'{inventoryReservation,receipts}') ELSE 1 END expected_receipts
  FROM booking.guest_bookings b
  CROSS JOIN LATERAL jsonb_array_elements(CASE
    WHEN b.booking_metadata#>>'{inventoryReservation,contractVersion}'='pms-inventory-reservation-bundle.v1'
      AND jsonb_typeof(b.booking_metadata#>'{inventoryReservation,receipts}')='array'
      AND b.booking_metadata#>>'{inventoryReservation,owner}'='pms'
      THEN b.booking_metadata#>'{inventoryReservation,receipts}'
    WHEN b.booking_metadata#>>'{inventoryReservation,contractVersion}'='pms-inventory-reservation-lifecycle.v1'
      THEN jsonb_build_array(b.booking_metadata->'inventoryReservation')
    ELSE '[]'::jsonb END) token
  JOIN pms.inventory_reservation_receipts receipt
    ON receipt.receipt_id::text=token->>'receiptId' AND receipt.property_id=b.property_id
    AND receipt.quote_session_id=b.quote_session_id::text
    AND receipt.check_in=b.check_in AND receipt.check_out=b.check_out
  JOIN pms.inventory_reservation_statuses status USING(receipt_id)
  WHERE token->>'owner'='pms' AND token->>'contractVersion'='pms-inventory-reservation-lifecycle.v1'
    AND (b.booking_metadata#>'{selectedOffer,roomSelection}' IS NULL OR
      b.booking_metadata#>>'{selectedOffer,roomSelection,contractVersion}'='booking-room-selection.v1')
    AND (CASE WHEN b.booking_metadata#>'{selectedOffer,roomSelection}' IS NOT NULL THEN EXISTS (
      SELECT 1 FROM jsonb_array_elements(CASE WHEN jsonb_typeof(b.booking_metadata#>'{selectedOffer,roomSelection,lines}')='array'
        THEN b.booking_metadata#>'{selectedOffer,roomSelection,lines}' ELSE '[]'::jsonb END) line
      WHERE line->>'roomTypeId'=receipt.room_type_id::text AND line->>'publicOfferKey'=receipt.public_offer_key
        AND CASE WHEN jsonb_typeof(line->'guests')='array' THEN jsonb_array_length(line->'guests') ELSE 0 END=receipt.room_count
    ) ELSE receipt.room_type_id::text=b.booking_metadata#>>'{selectedOffer,roomTypeId}' END)
    AND NOT EXISTS(SELECT 1 FROM pms.operational_booking_assignments a WHERE a.guest_booking_id=b.id)
    AND NOT EXISTS(SELECT 1 FROM platform.jobs j WHERE j.property_id=b.property_id
      AND j.resource_id=b.id::text AND j.queue_name='pms-reservation-handoff'
      AND j.status<>'pending' AND j.job_metadata->>'applicationMode' IS DISTINCT FROM 'canonical_pending')
), complete AS (
  SELECT guest_booking_id FROM candidates GROUP BY guest_booking_id
  HAVING bool_and(lifecycle_state='reserved') AND count(*)=max(expected_receipts)
    AND count(*)=max(actual_receipts) AND count(*)=max(selection_lines)
    AND count(*)=count(DISTINCT receipt_id) AND count(*)=count(DISTINCT room_type_id)
    AND sum(room_count)=max(booking_room_count)
)
SELECT candidate.guest_booking_id,candidate.property_id,candidate.receipt_id,
  candidate.room_type_id,candidate.public_offer_key,candidate.check_in,candidate.check_out,candidate.room_count
FROM candidates candidate JOIN complete USING(guest_booking_id);

CREATE OR REPLACE VIEW pms.pending_booking_edit_support AS
SELECT DISTINCT guest_booking_id,property_id FROM pms.pending_booking_edit_receipts;
