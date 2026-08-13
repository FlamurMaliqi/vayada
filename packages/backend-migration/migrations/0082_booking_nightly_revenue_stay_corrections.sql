-- Migration: 0082_booking_nightly_revenue_stay_corrections
-- Owner: domain-booking; see VAY-1271

ALTER TABLE booking.nightly_revenue_evidence
  DROP CONSTRAINT chk_booking_nightly_revenue_evidence_event,
  ADD CONSTRAINT chk_booking_nightly_revenue_evidence_event CHECK (
    (economic_event = 'room_night' AND recognized_on = stay_date
      AND occupied_room_nights = 1 AND corrects_evidence_id IS NULL
      AND lifecycle_state IN ('confirmed', 'completed')
      AND (gross_room_amount IS NULL OR gross_room_amount >= 0))
    OR (economic_event = 'room_night_reversal' AND recognized_on >= stay_date
      AND occupied_room_nights = -1 AND corrects_evidence_id IS NOT NULL
      AND lifecycle_state IN ('canceled', 'no_show')
      AND (gross_room_amount IS NULL OR gross_room_amount <= 0))
    OR (economic_event = 'occupancy_adjustment' AND recognized_on >= stay_date
      AND occupied_room_nights IN (-1, 1)
      AND (corrects_evidence_id IS NOT NULL
        OR (occupied_room_nights = 1 AND source_kind = 'manual'))
      AND (lifecycle_state = 'corrected' OR (lifecycle_state IN ('canceled', 'no_show')
        AND occupied_room_nights = -1)))
    OR (economic_event = 'retained_charge' AND recognized_on >= stay_date
      AND occupied_room_nights = 0 AND evidence_quality IN ('exact', 'inferred')
      AND gross_room_amount > 0 AND corrects_evidence_id IS NULL
      AND lifecycle_state IN ('canceled', 'no_show'))
    OR (economic_event = 'refund' AND occupied_room_nights = 0
      AND evidence_quality IN ('exact', 'inferred') AND gross_room_amount < 0
      AND corrects_evidence_id IS NOT NULL AND lifecycle_state = 'refunded')
    OR (economic_event = 'correction' AND occupied_room_nights = 0
      AND evidence_quality IN ('exact', 'inferred') AND gross_room_amount <> 0
      AND corrects_evidence_id IS NOT NULL AND lifecycle_state = 'corrected')
  ) NOT VALID;

CREATE OR REPLACE FUNCTION booking.validate_nightly_revenue_correction()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE target booking.nightly_revenue_evidence%ROWTYPE;
  booking_from DATE; booking_to DATE;
BEGIN
  IF NOT isfinite(NEW.stay_date) OR NOT isfinite(NEW.recognized_on) THEN
    RAISE EXCEPTION 'nightly evidence requires finite dates' USING
      ERRCODE='23514',CONSTRAINT='chk_booking_nightly_revenue_evidence_dates';
  END IF;
  SELECT check_in,check_out INTO booking_from,booking_to
    FROM booking.guest_bookings WHERE id=NEW.guest_booking_id AND property_id=NEW.property_id;
  IF NOT FOUND OR (NEW.corrects_evidence_id IS NULL AND
      (NEW.stay_date < booking_from OR NEW.stay_date >= booking_to)) THEN
    RAISE EXCEPTION 'base nightly evidence outside booking stay' USING
      ERRCODE='23514',CONSTRAINT='chk_booking_nightly_revenue_evidence_booking_stay';
  END IF;
  IF NEW.corrects_evidence_id IS NULL THEN RETURN NEW; END IF;
  SELECT * INTO target FROM booking.nightly_revenue_evidence
    WHERE id=NEW.corrects_evidence_id AND property_id=NEW.property_id
      AND guest_booking_id=NEW.guest_booking_id AND currency=NEW.currency;
  IF NOT FOUND THEN RAISE EXCEPTION 'invalid correction target' USING ERRCODE='23503'; END IF;
  IF target.source_revision >= NEW.source_revision OR target.stay_date <> NEW.stay_date
    OR NEW.recognized_on < target.recognized_on OR target.line_position <> NEW.line_position
    OR (NEW.room_type_id IS DISTINCT FROM target.room_type_id AND NOT
      (NEW.economic_event='occupancy_adjustment' AND NEW.occupied_room_nights=1
        AND NEW.source_kind='manual')) THEN
    RAISE EXCEPTION 'invalid correction lineage' USING ERRCODE='23514';
  END IF;
  IF NEW.economic_event='room_night_reversal' AND (target.economic_event<>'room_night'
    OR target.evidence_quality<>NEW.evidence_quality
    OR NEW.gross_room_amount IS DISTINCT FROM -target.gross_room_amount) THEN
    RAISE EXCEPTION 'invalid room-night reversal' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;
