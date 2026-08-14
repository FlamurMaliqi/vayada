-- Migration: 0083_validate_booking_nightly_revenue_stay_corrections
-- Owner: domain-booking; see VAY-1271

ALTER TABLE booking.nightly_revenue_evidence
  VALIDATE CONSTRAINT chk_booking_nightly_revenue_evidence_event;
