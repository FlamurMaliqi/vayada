-- Migration: 0074_booking_nightly_revenue_adjustment_index; owner: domain-booking; see VAY-1182
-- vayada:no-transaction
CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS uq_booking_nightly_revenue_evidence_occupancy_target_next
  ON booking.nightly_revenue_evidence (corrects_evidence_id)
  WHERE economic_event IN ('room_night_reversal', 'occupancy_adjustment');
-- vayada:next-statement
DROP INDEX CONCURRENTLY IF EXISTS booking.uq_booking_nightly_revenue_evidence_occupancy_target;
-- vayada:next-statement
ALTER INDEX booking.uq_booking_nightly_revenue_evidence_occupancy_target_next
  RENAME TO uq_booking_nightly_revenue_evidence_occupancy_target;
-- vayada:next-statement
DROP INDEX CONCURRENTLY IF EXISTS booking.uq_booking_nightly_revenue_evidence_room_night_reversal;
