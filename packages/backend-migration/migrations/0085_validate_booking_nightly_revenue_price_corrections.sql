-- Migration: 0085_validate_booking_nightly_revenue_price_corrections
-- Owner: domain-booking; see VAY-1272

ALTER TABLE booking.nightly_revenue_evidence
  VALIDATE CONSTRAINT chk_booking_nightly_revenue_evidence_event;
