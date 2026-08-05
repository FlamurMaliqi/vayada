-- Migration: 0079_booking_finance_attribution
-- Owner: domain-booking; see VAY-1186 and engineering/pms-financials-contracts.md
ALTER TABLE booking.guest_bookings
  ADD COLUMN booking_channel TEXT NOT NULL DEFAULT 'unknown',
  ADD COLUMN direct_booking_source TEXT,
  ADD CONSTRAINT chk_guest_bookings_booking_channel CHECK (
    booking_channel IN ('direct', 'booking_com', 'airbnb', 'expedia', 'agoda', 'other_ota', 'unknown')
  ),
  ADD CONSTRAINT chk_guest_bookings_direct_source CHECK (
    direct_booking_source IS NULL OR direct_booking_source IN (
      'booking_engine', 'whatsapp', 'call', 'email', 'walk_in', 'social_media', 'other'
    )
  ),
  ADD CONSTRAINT chk_guest_bookings_attribution_pair CHECK (
    (booking_channel = 'direct' AND direct_booking_source IS NOT NULL)
    OR (booking_channel <> 'direct' AND direct_booking_source IS NULL)
  );

CREATE INDEX idx_guest_bookings_finance_attribution
  ON booking.guest_bookings (property_id, booking_channel, direct_booking_source, id);

CREATE FUNCTION booking.protect_guest_booking_attribution()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF ROW(NEW.booking_channel, NEW.direct_booking_source)
    IS DISTINCT FROM ROW(OLD.booking_channel, OLD.direct_booking_source) THEN
    RAISE EXCEPTION 'Booking attribution is immutable' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_guest_bookings_protect_attribution
BEFORE UPDATE OF booking_channel, direct_booking_source ON booking.guest_bookings
FOR EACH ROW EXECUTE FUNCTION booking.protect_guest_booking_attribution();

CREATE VIEW booking.finance_booking_attribution AS
SELECT
  id AS guest_booking_id,
  property_id,
  booking_channel,
  direct_booking_source,
  lifecycle_status,
  check_in,
  check_out,
  total_amount,
  currency
FROM booking.guest_bookings;

CREATE FUNCTION booking.reject_finance_booking_attribution_write()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Finance booking attribution is a read-only projection' USING ERRCODE = '55000';
END;
$$;

CREATE TRIGGER trg_finance_booking_attribution_read_only
INSTEAD OF INSERT OR UPDATE OR DELETE ON booking.finance_booking_attribution
FOR EACH ROW EXECUTE FUNCTION booking.reject_finance_booking_attribution_write();
