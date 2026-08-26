-- Migration: 0084_booking_nightly_revenue_price_corrections
-- Owner: domain-booking; see VAY-1272

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
      AND evidence_quality IN ('exact', 'inferred') AND gross_room_amount IS NOT NULL
      AND corrects_evidence_id IS NOT NULL AND lifecycle_state = 'corrected')
  ) NOT VALID;

CREATE FUNCTION booking.validate_nightly_revenue_price_correction()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE current_occupied INTEGER; current_amount NUMERIC; current_tip UUID;
BEGIN
  IF NEW.economic_event <> 'correction' THEN RETURN NEW; END IF;
  SELECT COALESCE(SUM(occupied_room_nights),0),SUM(gross_room_amount),
    (array_agg(id ORDER BY source_revision DESC,created_at DESC,id DESC))[1]
    INTO current_occupied,current_amount,current_tip
    FROM booking.nightly_revenue_evidence
    WHERE guest_booking_id=NEW.guest_booking_id AND stay_date=NEW.stay_date
      AND line_position=NEW.line_position AND economic_event<>'retained_charge';
  IF current_occupied=1 AND (NEW.corrects_evidence_id IS DISTINCT FROM current_tip
      OR (current_amount IS NULL AND NEW.gross_room_amount<0)
      OR (current_amount IS NOT NULL AND
        (NEW.gross_room_amount=0 OR current_amount+NEW.gross_room_amount<0))) THEN
    RAISE EXCEPTION 'price correction must replace the current occupied-night economics'
      USING ERRCODE='23514',CONSTRAINT='chk_booking_nightly_revenue_evidence_price_correction';
  ELSIF current_occupied<>1 AND NEW.gross_room_amount=0 THEN
    RAISE EXCEPTION 'non-nightly correction must change economics'
      USING ERRCODE='23514',CONSTRAINT='chk_booking_nightly_revenue_evidence_price_correction';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_booking_nightly_revenue_evidence_validate_price_correction
BEFORE INSERT ON booking.nightly_revenue_evidence FOR EACH ROW
EXECUTE FUNCTION booking.validate_nightly_revenue_price_correction();
