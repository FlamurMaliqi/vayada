-- Migration: 0072_booking_nightly_revenue_adjustments
ALTER TABLE booking.nightly_revenue_evidence DROP CONSTRAINT chk_booking_nightly_revenue_evidence_enums, DROP CONSTRAINT chk_booking_nightly_revenue_evidence_event;
ALTER TABLE booking.nightly_revenue_evidence
  ADD CONSTRAINT chk_booking_nightly_revenue_evidence_enums CHECK (economic_event IN
    ('room_night', 'room_night_reversal', 'occupancy_adjustment', 'retained_charge', 'refund', 'correction')
    AND lifecycle_state IN ('confirmed', 'completed', 'canceled', 'no_show', 'refunded', 'corrected')
    AND source_kind IN ('direct', 'ota', 'manual', 'migration') AND evidence_quality IN ('exact', 'inferred', 'missing')
  ),
  ADD CONSTRAINT chk_booking_nightly_revenue_evidence_event CHECK ((economic_event = 'room_night' AND recognized_on = stay_date
      AND occupied_room_nights = 1 AND corrects_evidence_id IS NULL
      AND lifecycle_state IN ('confirmed', 'completed')
      AND (gross_room_amount IS NULL OR gross_room_amount >= 0))
    OR (economic_event = 'room_night_reversal' AND recognized_on = stay_date
      AND occupied_room_nights = -1 AND corrects_evidence_id IS NOT NULL
      AND lifecycle_state IN ('canceled', 'no_show')
      AND (gross_room_amount IS NULL OR gross_room_amount <= 0))
    OR (economic_event = 'occupancy_adjustment' AND occupied_room_nights IN (-1, 1) AND corrects_evidence_id IS NOT NULL
      AND (lifecycle_state = 'corrected' OR (lifecycle_state IN ('canceled', 'no_show')
        AND occupied_room_nights = -1 AND recognized_on = stay_date)))
    OR (economic_event = 'retained_charge' AND occupied_room_nights = 0
      AND evidence_quality IN ('exact', 'inferred')
      AND gross_room_amount > 0 AND corrects_evidence_id IS NULL
      AND lifecycle_state IN ('canceled', 'no_show'))
    OR (economic_event = 'refund' AND occupied_room_nights = 0
      AND evidence_quality IN ('exact', 'inferred')
      AND gross_room_amount < 0 AND corrects_evidence_id IS NOT NULL
      AND lifecycle_state = 'refunded')
    OR (economic_event = 'correction' AND occupied_room_nights = 0
      AND evidence_quality IN ('exact', 'inferred')
      AND gross_room_amount <> 0 AND corrects_evidence_id IS NOT NULL
      AND lifecycle_state = 'corrected')
  );
DROP INDEX booking.uq_booking_nightly_revenue_evidence_room_night_reversal;
CREATE UNIQUE INDEX uq_booking_nightly_revenue_evidence_occupancy_target ON booking.nightly_revenue_evidence (corrects_evidence_id) WHERE economic_event IN ('room_night_reversal', 'occupancy_adjustment');
CREATE FUNCTION booking.validate_nightly_revenue_occupancy_change()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE current_occupied INTEGER; current_amount NUMERIC; current_tip UUID;
BEGIN
  IF NEW.economic_event NOT IN ('room_night_reversal', 'occupancy_adjustment') THEN RETURN NEW; END IF;
  SELECT COALESCE(SUM(occupied_room_nights), 0), SUM(gross_room_amount),
    (array_agg(id ORDER BY source_revision DESC, created_at DESC, id DESC))[1]
    INTO current_occupied, current_amount, current_tip
    FROM booking.nightly_revenue_evidence WHERE guest_booking_id = NEW.guest_booking_id
      AND stay_date = NEW.stay_date AND line_position = NEW.line_position
      AND economic_event <> 'retained_charge';
  IF NEW.corrects_evidence_id IS DISTINCT FROM current_tip OR NOT
    ((current_occupied = 1 AND NEW.occupied_room_nights = -1
        AND NEW.gross_room_amount IS NOT DISTINCT FROM -current_amount)
      OR (current_occupied = 0 AND NEW.occupied_room_nights = 1
        AND (NEW.gross_room_amount IS NULL OR NEW.gross_room_amount >= 0))) THEN
    RAISE EXCEPTION 'occupancy adjustment must toggle the current room-night tip' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER trg_booking_nightly_revenue_evidence_validate_occupancy BEFORE INSERT ON booking.nightly_revenue_evidence FOR EACH ROW EXECUTE FUNCTION booking.validate_nightly_revenue_occupancy_change();
