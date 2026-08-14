-- Migration: 0080_booking_acceptance_mode
-- Owner: domain-booking
-- See: engineering/booking-acceptance-mode-contract.md
--
-- Existing target-only rows behaved as instant book before this setting existed,
-- so the in-place default preserves that behavior. Legacy-to-target transforms
-- overwrite the value from the legacy instant_book flag during cutover/backfill.

ALTER TABLE booking.booking_settings
  ADD COLUMN acceptance_mode TEXT NOT NULL DEFAULT 'instant'
  CHECK (acceptance_mode IN ('instant', 'request'));

COMMENT ON COLUMN booking.booking_settings.acceptance_mode IS
  'Booking-owned host acceptance policy. Frozen into each quote before checkout.';
