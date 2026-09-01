-- Migration: 0132_same_day_booking_policies
-- Owner: domain-booking
-- See: engineering/same-day-booking-cutoff-contract.md

CREATE TABLE booking.same_day_booking_policies (
  property_id        UUID        PRIMARY KEY
                                  REFERENCES hotel_catalog.properties(id)
                                  ON DELETE CASCADE,
  enabled            BOOLEAN     NOT NULL DEFAULT TRUE,
  cutoff_local_time  TEXT        DEFAULT '18:00',
  revision           INTEGER     NOT NULL DEFAULT 1 CHECK (revision > 0),
  source_freshness   JSONB       NOT NULL DEFAULT '{}'::jsonb,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT chk_same_day_cutoff_half_hour
    CHECK (
      cutoff_local_time IS NULL
      OR cutoff_local_time ~ '^(?:[01][0-9]|2[0-3]):(?:00|30)$'
    ),
  CONSTRAINT chk_same_day_source_freshness_object
    CHECK (jsonb_typeof(source_freshness) = 'object')
);

COMMENT ON TABLE booking.same_day_booking_policies IS
  'Booking-owned property policy for direct same-day booking eligibility.';

CREATE INDEX idx_same_day_booking_policies_updated_at
  ON booking.same_day_booking_policies (updated_at DESC);
