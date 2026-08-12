-- Migration: 0071_booking_nightly_revenue_evidence
-- Owner: domain-booking; see VAY-1178 and engineering/pms-financials-contracts.md
ALTER TABLE booking.guest_bookings ADD CONSTRAINT uq_guest_bookings_id_property_currency UNIQUE (id, property_id, currency);
CREATE TABLE booking.nightly_revenue_evidence (
  id                    UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id           UUID          NOT NULL,
  guest_booking_id      UUID          NOT NULL,
  room_type_id          UUID,
  stay_date             DATE          NOT NULL,
  recognized_on         DATE          NOT NULL,
  currency              CHAR(3)       NOT NULL,
  gross_room_amount     NUMERIC(19, 4),
  occupied_room_nights  SMALLINT      NOT NULL,
  economic_event        TEXT          NOT NULL,
  lifecycle_state       TEXT          NOT NULL,
  source_kind           TEXT          NOT NULL,
  evidence_quality      TEXT          NOT NULL,
  source_revision       BIGINT        NOT NULL,
  line_position         INTEGER       NOT NULL DEFAULT 1,
  corrects_evidence_id  UUID,
  command_key           TEXT          NOT NULL,
  created_at            TIMESTAMPTZ   NOT NULL DEFAULT now(),
  CONSTRAINT uq_booking_nightly_revenue_evidence_command UNIQUE (property_id, command_key),
  CONSTRAINT uq_booking_nightly_revenue_evidence_source_line UNIQUE (guest_booking_id, source_revision, stay_date, line_position, economic_event),
  CONSTRAINT uq_booking_nightly_revenue_evidence_correction_scope UNIQUE (id, property_id, guest_booking_id, currency),
  CONSTRAINT chk_booking_nightly_revenue_evidence_currency CHECK (currency::TEXT ~ '^[A-Z]{3}$'),
  CONSTRAINT chk_booking_nightly_revenue_evidence_dimensions CHECK (
    source_revision BETWEEN 1 AND 2147483647 AND line_position BETWEEN 1 AND 1000
    AND occupied_room_nights IN (-1, 0, 1)
    AND (corrects_evidence_id IS NULL OR corrects_evidence_id <> id)
  ),
  CONSTRAINT chk_booking_nightly_revenue_evidence_enums CHECK (
    economic_event IN ('room_night', 'room_night_reversal', 'retained_charge', 'refund', 'correction')
    AND lifecycle_state IN ('confirmed', 'completed', 'canceled', 'no_show', 'refunded', 'corrected')
    AND source_kind IN ('direct', 'ota', 'manual', 'migration')
    AND evidence_quality IN ('exact', 'inferred', 'missing')
  ),
  CONSTRAINT chk_booking_nightly_revenue_evidence_command CHECK (
    command_key = btrim(command_key) AND char_length(command_key) BETWEEN 1 AND 200
  ),
  CONSTRAINT chk_booking_nightly_revenue_evidence_quality CHECK (
    (evidence_quality = 'missing' AND gross_room_amount IS NULL)
    OR (evidence_quality IN ('exact', 'inferred') AND gross_room_amount IS NOT NULL)
  ),
  CONSTRAINT chk_booking_nightly_revenue_evidence_finite_amount CHECK (gross_room_amount IS NULL OR (gross_room_amount > '-Infinity'::NUMERIC AND gross_room_amount < 'Infinity'::NUMERIC)),
  CONSTRAINT chk_booking_nightly_revenue_evidence_room_type CHECK (
    room_type_id IS NOT NULL OR evidence_quality = 'missing'),
  CONSTRAINT chk_booking_nightly_revenue_evidence_event CHECK (
    (economic_event = 'room_night' AND recognized_on = stay_date
      AND occupied_room_nights = 1 AND corrects_evidence_id IS NULL
      AND lifecycle_state IN ('confirmed', 'completed')
      AND (gross_room_amount IS NULL OR gross_room_amount >= 0))
    OR (economic_event = 'room_night_reversal' AND recognized_on = stay_date
      AND occupied_room_nights = -1 AND corrects_evidence_id IS NOT NULL
      AND lifecycle_state IN ('canceled', 'no_show')
      AND (gross_room_amount IS NULL OR gross_room_amount <= 0))
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
  ),
  CONSTRAINT fk_booking_nightly_revenue_evidence_booking FOREIGN KEY (
    guest_booking_id, property_id, currency
  ) REFERENCES booking.guest_bookings (id, property_id, currency) ON DELETE RESTRICT,
  CONSTRAINT fk_booking_nightly_revenue_evidence_correction FOREIGN KEY (
    corrects_evidence_id, property_id, guest_booking_id, currency
  ) REFERENCES booking.nightly_revenue_evidence (id, property_id, guest_booking_id, currency)
    ON DELETE RESTRICT
);
CREATE UNIQUE INDEX uq_booking_nightly_revenue_evidence_base_room_night ON booking.nightly_revenue_evidence
  (guest_booking_id, stay_date, line_position)
  WHERE economic_event = 'room_night';
CREATE UNIQUE INDEX uq_booking_nightly_revenue_evidence_room_night_reversal ON booking.nightly_revenue_evidence
  (corrects_evidence_id)
  WHERE economic_event = 'room_night_reversal';
CREATE FUNCTION booking.validate_nightly_revenue_correction()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE target booking.nightly_revenue_evidence%ROWTYPE;
BEGIN
  IF NEW.corrects_evidence_id IS NULL THEN RETURN NEW; END IF;
  SELECT * INTO target FROM booking.nightly_revenue_evidence
  WHERE id = NEW.corrects_evidence_id AND property_id = NEW.property_id
    AND guest_booking_id = NEW.guest_booking_id AND currency = NEW.currency;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'correction target must be prior evidence in the same booking scope' USING ERRCODE = '23503';
  END IF;
  IF target.source_revision >= NEW.source_revision OR target.stay_date <> NEW.stay_date
    OR target.line_position <> NEW.line_position
    OR (target.room_type_id IS NOT NULL
      AND NEW.room_type_id IS DISTINCT FROM target.room_type_id) THEN
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
CREATE TRIGGER trg_booking_nightly_revenue_evidence_validate_correction
BEFORE INSERT ON booking.nightly_revenue_evidence
FOR EACH ROW EXECUTE FUNCTION booking.validate_nightly_revenue_correction();
CREATE FUNCTION booking.protect_nightly_revenue_evidence()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'nightly booking revenue evidence is immutable' USING ERRCODE = '23514';
END;
$$;
CREATE TRIGGER trg_booking_nightly_revenue_evidence_protect_rows
BEFORE UPDATE OR DELETE ON booking.nightly_revenue_evidence
FOR EACH ROW EXECUTE FUNCTION booking.protect_nightly_revenue_evidence();
CREATE TRIGGER trg_booking_nightly_revenue_evidence_protect_truncate
BEFORE TRUNCATE ON booking.nightly_revenue_evidence
FOR EACH STATEMENT EXECUTE FUNCTION booking.protect_nightly_revenue_evidence();
CREATE INDEX idx_booking_nightly_revenue_evidence_reporting ON booking.nightly_revenue_evidence (property_id, recognized_on, currency, id);
CREATE VIEW booking.finance_nightly_revenue_evidence AS
SELECT id AS evidence_id, property_id, guest_booking_id, room_type_id, stay_date,
  recognized_on, currency, gross_room_amount, occupied_room_nights, economic_event,
  lifecycle_state, source_kind, evidence_quality, source_revision, corrects_evidence_id
FROM booking.nightly_revenue_evidence;
