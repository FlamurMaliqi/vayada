-- VAY-1031: preserve the fact that a property has accepted a booking even if
-- the booking is later cancelled. Payment status is intentionally not used.

ALTER TABLE bookings
    ADD COLUMN IF NOT EXISTS contact_details_revealed_at TIMESTAMPTZ;

UPDATE bookings
SET contact_details_revealed_at = COALESCE(
        contact_details_revealed_at,
        finalization_started_at,
        finalization_completed_at,
        updated_at
    )
WHERE contact_details_revealed_at IS NULL
  AND (
      finalization_started_at IS NOT NULL
      OR finalization_completed_at IS NOT NULL
      OR status IN ('confirmed', 'checked_in', 'in_house', 'checked_out', 'no_show')
  );

-- Historical cancelled rows without an acceptance marker are deliberately
-- left masked: the legacy schema cannot distinguish accepted cancellations
-- from cancellations that happened before property acceptance.
