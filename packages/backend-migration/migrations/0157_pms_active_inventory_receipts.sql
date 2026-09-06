-- VAY-1279: retire historical holds only with explicit successor evidence.
CREATE TABLE pms.inventory_reservation_successors (
  predecessor_receipt_id UUID PRIMARY KEY,
  successor_receipt_id UUID NOT NULL UNIQUE,
  organization_id UUID NOT NULL,
  property_id UUID NOT NULL,
  guest_booking_id UUID NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (predecessor_receipt_id <> successor_receipt_id),
  FOREIGN KEY (predecessor_receipt_id,organization_id,property_id)
    REFERENCES pms.inventory_reservation_receipts(receipt_id,organization_id,property_id),
  FOREIGN KEY (successor_receipt_id,organization_id,property_id)
    REFERENCES pms.inventory_reservation_receipts(receipt_id,organization_id,property_id),
  FOREIGN KEY (guest_booking_id,property_id) REFERENCES booking.guest_bookings(id,property_id)
);
CREATE TRIGGER inventory_successors_append_only BEFORE UPDATE OR DELETE
  ON pms.inventory_reservation_successors FOR EACH ROW
  EXECUTE FUNCTION platform.prevent_append_only_mutation();
CREATE TRIGGER inventory_successors_no_truncate BEFORE TRUNCATE
  ON pms.inventory_reservation_successors FOR EACH STATEMENT
  EXECUTE FUNCTION platform.prevent_append_only_mutation();

CREATE VIEW pms.active_inventory_reservation_receipts AS
SELECT receipt.* FROM pms.inventory_reservation_receipts receipt
JOIN pms.inventory_reservation_statuses status USING (receipt_id)
WHERE status.lifecycle_state <> 'handed_off' OR (
  NOT EXISTS (SELECT 1 FROM pms.inventory_reservation_successors successor
    WHERE successor.predecessor_receipt_id=receipt.receipt_id)
  AND NOT EXISTS (SELECT 1 FROM booking.guest_bookings booking
    WHERE booking.property_id=receipt.property_id AND booking.lifecycle_status IN ('canceled','declined','expired')
      AND (booking.booking_metadata#>>'{inventoryReservation,receiptId}'=receipt.receipt_id::text
        OR (booking.booking_metadata#>>'{inventoryReservation,receiptId}' IS NULL
          AND COALESCE(booking.booking_metadata#>>'{inventoryReservation,quoteSessionId}',booking.quote_session_id::text)=receipt.quote_session_id)))
);
