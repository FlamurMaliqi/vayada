-- PMS-owned capability projection for pre-handoff direct booking edits.
CREATE VIEW pms.pending_booking_edit_support AS
SELECT b.id AS guest_booking_id,b.property_id
FROM booking.guest_bookings b
JOIN pms.inventory_reservation_receipts receipt
  ON receipt.receipt_id::text=b.booking_metadata#>>'{inventoryReservation,receiptId}'
 AND receipt.property_id=b.property_id
 AND receipt.quote_session_id=b.quote_session_id::text
 AND receipt.check_in=b.check_in AND receipt.check_out=b.check_out
 AND receipt.room_count=b.room_count
 AND receipt.room_type_id::text=b.booking_metadata#>>'{selectedOffer,roomTypeId}'
JOIN pms.inventory_reservation_statuses status USING(receipt_id)
WHERE status.lifecycle_state='reserved'
  AND NOT EXISTS(SELECT 1 FROM pms.operational_booking_assignments a WHERE a.guest_booking_id=b.id)
  AND NOT EXISTS(SELECT 1 FROM platform.jobs j WHERE j.property_id=b.property_id
    AND j.resource_id=b.id::text AND j.queue_name='pms-reservation-handoff'
    AND j.status<>'pending' AND j.job_metadata->>'applicationMode' IS DISTINCT FROM 'canonical_pending');
