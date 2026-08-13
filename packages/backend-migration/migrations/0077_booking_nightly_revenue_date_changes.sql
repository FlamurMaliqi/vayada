-- Migration: 0077_booking_nightly_revenue_date_changes; owner: domain-booking; see VAY-1179
CREATE OR REPLACE FUNCTION booking.validate_nightly_revenue_correction()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE target booking.nightly_revenue_evidence%ROWTYPE; booking_from DATE; booking_to DATE;
BEGIN
  IF NOT isfinite(NEW.stay_date) OR NOT isfinite(NEW.recognized_on) THEN
    RAISE EXCEPTION 'nightly evidence requires finite dates' USING ERRCODE = '23514', CONSTRAINT = 'chk_booking_nightly_revenue_evidence_dates';
  END IF;
  SELECT check_in, check_out INTO booking_from, booking_to FROM booking.guest_bookings
  WHERE id = NEW.guest_booking_id AND property_id = NEW.property_id;
  IF NOT FOUND OR (NEW.corrects_evidence_id IS NULL
    AND (NEW.stay_date < booking_from OR NEW.stay_date >= booking_to)) THEN
    RAISE EXCEPTION 'base nightly evidence must fall inside the current booking stay' USING ERRCODE = '23514', CONSTRAINT = 'chk_booking_nightly_revenue_evidence_booking_stay';
  END IF;
  IF NEW.corrects_evidence_id IS NULL THEN RETURN NEW; END IF;
  SELECT * INTO target FROM booking.nightly_revenue_evidence
  WHERE id = NEW.corrects_evidence_id AND property_id = NEW.property_id
    AND guest_booking_id = NEW.guest_booking_id AND currency = NEW.currency;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'correction target must be prior evidence in the same booking scope' USING ERRCODE = '23503';
  END IF;
  IF target.source_revision >= NEW.source_revision OR target.stay_date <> NEW.stay_date
    OR NEW.recognized_on < target.recognized_on OR target.line_position <> NEW.line_position
    OR NEW.room_type_id IS DISTINCT FROM target.room_type_id THEN
    RAISE EXCEPTION 'correction target must be an earlier revision of the same night and room' USING ERRCODE = '23514';
  END IF;
  IF NEW.economic_event = 'room_night_reversal' AND (target.economic_event <> 'room_night'
    OR target.evidence_quality <> NEW.evidence_quality
    OR NEW.gross_room_amount IS DISTINCT FROM -target.gross_room_amount) THEN
    RAISE EXCEPTION 'room-night reversal must exactly negate its base evidence' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
