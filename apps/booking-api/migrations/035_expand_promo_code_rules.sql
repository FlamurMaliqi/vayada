ALTER TABLE booking_promo_codes
  RENAME COLUMN use_count TO current_uses;

UPDATE booking_promo_codes SET max_uses = 999 WHERE max_uses IS NULL;

ALTER TABLE booking_promo_codes
  ALTER COLUMN max_uses SET DEFAULT 1,
  ALTER COLUMN max_uses SET NOT NULL;

ALTER TABLE booking_promo_codes
  ADD COLUMN min_booking_value NUMERIC(10, 2),
  ADD COLUMN applicable_room_ids UUID[],
  ADD COLUMN stay_date_from DATE,
  ADD COLUMN stay_date_until DATE,
  ADD CONSTRAINT chk_booking_promo_minimum
    CHECK (min_booking_value IS NULL OR min_booking_value > 0),
  ADD CONSTRAINT chk_booking_promo_stay_dates
    CHECK (
      stay_date_from IS NULL OR stay_date_until IS NULL OR stay_date_until >= stay_date_from
    ),
  ADD CONSTRAINT chk_booking_promo_rooms
    CHECK (
      applicable_room_ids IS NULL
      OR (
        cardinality(applicable_room_ids) > 0
        AND array_position(applicable_room_ids, NULL) IS NULL
      )
    );

CREATE TABLE booking_promo_redemptions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  promo_id UUID REFERENCES booking_promo_codes(id) ON DELETE CASCADE,
  redemption_key TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'reversed')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  reversed_at TIMESTAMPTZ,
  CONSTRAINT chk_booking_promo_redemption_target
    CHECK (status = 'reversed' OR promo_id IS NOT NULL),
  UNIQUE (redemption_key)
);
