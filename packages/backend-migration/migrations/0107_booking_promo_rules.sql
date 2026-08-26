ALTER TABLE booking.promo_definitions
  DROP CONSTRAINT chk_promo_definitions_fixed_currency,
  DROP CONSTRAINT chk_promo_definitions_currency_upper,
  DROP COLUMN currency;

ALTER TABLE booking.promo_definitions
  RENAME COLUMN use_count TO current_uses;

UPDATE booking.promo_definitions SET max_uses = 999 WHERE max_uses IS NULL;

ALTER TABLE booking.promo_definitions
  ALTER COLUMN max_uses SET DEFAULT 1,
  ALTER COLUMN max_uses SET NOT NULL;

ALTER TABLE booking.promo_definitions
  ADD COLUMN min_booking_value NUMERIC(15, 2),
  ADD COLUMN applicable_room_ids UUID[],
  ADD COLUMN stay_date_from DATE,
  ADD COLUMN stay_date_until DATE,
  ADD CONSTRAINT chk_promo_definitions_min_booking_value
    CHECK (min_booking_value IS NULL OR min_booking_value > 0),
  ADD CONSTRAINT chk_promo_definitions_stay_date_order
    CHECK (
      stay_date_from IS NULL OR stay_date_until IS NULL OR stay_date_until >= stay_date_from
    ),
  ADD CONSTRAINT chk_promo_definitions_applicable_rooms
    CHECK (
      applicable_room_ids IS NULL
      OR (
        cardinality(applicable_room_ids) > 0
        AND array_position(applicable_room_ids, NULL) IS NULL
      )
    );

ALTER TABLE booking.promo_applications
  ADD COLUMN promo_definition_id UUID REFERENCES booking.promo_definitions(id) ON DELETE SET NULL;

CREATE INDEX idx_promo_applications_definition
  ON booking.promo_applications (promo_definition_id, application_status);

CREATE UNIQUE INDEX uq_promo_applications_guest_booking
  ON booking.promo_applications (guest_booking_id)
  WHERE guest_booking_id IS NOT NULL;
