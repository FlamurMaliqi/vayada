ALTER TABLE booking.guest_bookings
  ADD COLUMN expected_payment_method TEXT NOT NULL DEFAULT 'unknown',
  ADD CONSTRAINT chk_booking_guest_bookings_expected_payment_method
    CHECK (expected_payment_method IN (
      'unknown', 'pay_at_property', 'bank_transfer', 'manual_card', 'cash', 'other'
    ));
COMMENT ON COLUMN booking.guest_bookings.expected_payment_method IS
  'Booking-owned payment intent; unknown is migration/compatibility-only and excluded from manual v1.';

ALTER TABLE pms.operational_booking_assignments
  DROP CONSTRAINT chk_pms_operational_assignments_position,
  ADD COLUMN stay_evidence_kind TEXT NOT NULL DEFAULT 'summary_only',
  ADD COLUMN check_in DATE,
  ADD COLUMN check_out DATE,
  ADD COLUMN adults INTEGER,
  ADD COLUMN children INTEGER,
  ADD CONSTRAINT chk_pms_operational_assignments_position
    CHECK (position BETWEEN 1 AND 20),
  ADD CONSTRAINT chk_pms_operational_assignments_stay_evidence_kind
    CHECK (stay_evidence_kind IN ('summary_only', 'exact')),
  ADD CONSTRAINT chk_pms_operational_assignments_stay_evidence
    CHECK (
      (stay_evidence_kind = 'summary_only'
        AND check_in IS NULL AND check_out IS NULL
        AND adults IS NULL AND children IS NULL)
      OR
      (stay_evidence_kind = 'exact'
        AND room_id IS NOT NULL AND check_in IS NOT NULL AND check_out IS NOT NULL
        AND adults IS NOT NULL AND children IS NOT NULL
        AND check_in < check_out AND adults >= 1 AND children >= 0)
    );
CREATE INDEX idx_pms_operational_assignments_property_dates
  ON pms.operational_booking_assignments (property_id, check_in, check_out)
  WHERE stay_evidence_kind = 'exact';
CREATE INDEX idx_pms_operational_assignments_room_dates
  ON pms.operational_booking_assignments (room_id, check_in, check_out)
  WHERE stay_evidence_kind = 'exact';

CREATE FUNCTION pms.assert_assignment_positions_contiguous(
  target_booking_id UUID, target_property_id UUID
) RETURNS VOID LANGUAGE plpgsql AS $$
DECLARE position_count INTEGER; maximum_position INTEGER;
BEGIN
  SELECT count(*), max(position) INTO position_count, maximum_position
  FROM pms.operational_booking_assignments
  WHERE guest_booking_id = target_booking_id AND property_id = target_property_id;
  IF position_count > 0 AND maximum_position <> position_count THEN
    RAISE EXCEPTION 'assignment positions must be contiguous from 1'
      USING ERRCODE = 'check_violation',
            CONSTRAINT = 'chk_pms_operational_assignments_positions_contiguous';
  END IF;
END;
$$;

CREATE FUNCTION pms.enforce_assignment_positions_contiguous()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP <> 'DELETE' AND NEW.source = 'manual' AND NEW.stay_evidence_kind <> 'exact'
    AND (TG_OP = 'INSERT' OR (NEW.source, NEW.stay_evidence_kind)
      IS DISTINCT FROM (OLD.source, OLD.stay_evidence_kind)) THEN
    RAISE EXCEPTION 'new manual assignments require exact stay evidence' USING
      ERRCODE = 'check_violation', CONSTRAINT = 'chk_pms_manual_assignments_exact';
  END IF;
  IF TG_OP <> 'INSERT' THEN
    PERFORM pms.assert_assignment_positions_contiguous(OLD.guest_booking_id, OLD.property_id);
  END IF;
  IF TG_OP <> 'DELETE' AND (
    TG_OP = 'INSERT'
    OR (NEW.guest_booking_id, NEW.property_id) IS DISTINCT FROM
       (OLD.guest_booking_id, OLD.property_id)
  ) THEN
    PERFORM pms.assert_assignment_positions_contiguous(NEW.guest_booking_id, NEW.property_id);
  END IF;
  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER trg_pms_operational_assignments_positions_contiguous
  AFTER INSERT OR UPDATE OR DELETE ON pms.operational_booking_assignments
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION pms.enforce_assignment_positions_contiguous();

COMMENT ON COLUMN pms.operational_booking_assignments.stay_evidence_kind IS
  'summary_only preserves migration/compatibility facts; manual source requires authoritative exact facts.';
