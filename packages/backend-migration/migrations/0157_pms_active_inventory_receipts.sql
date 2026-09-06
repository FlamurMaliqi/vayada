-- VAY-1279: handed-off receipts are historical once Booking references a successor.
-- Preserve immutable receipt/status evidence; do not reopen terminal reservations.
CREATE VIEW pms.active_inventory_reservation_receipts AS
SELECT receipt.* FROM pms.inventory_reservation_receipts receipt
JOIN pms.inventory_reservation_statuses status USING (receipt_id)
WHERE status.lifecycle_state <> 'handed_off' OR EXISTS (
  SELECT 1 FROM booking.guest_bookings booking
  WHERE booking.property_id=receipt.property_id
    AND booking.lifecycle_status NOT IN ('canceled','declined','expired') AND (
    booking.booking_metadata#>>'{inventoryReservation,receiptId}'=receipt.receipt_id::text
    OR (booking.booking_metadata#>>'{inventoryReservation,receiptId}' IS NULL
      AND COALESCE(booking.booking_metadata#>>'{inventoryReservation,quoteSessionId}',booking.quote_session_id::text)=receipt.quote_session_id)
  )
);
