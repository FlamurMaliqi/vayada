-- VAY-1248: durable legacy evidence for the cross-stack manual-booking command.
-- Existing bookings intentionally remain source/payment unknown and receive no
-- synthetic stay or price rows. The VAY-1250 writer will populate this schema
-- while continuing to maintain the old single-room booking columns.

ALTER TABLE bookings
    ADD COLUMN manual_direct_source TEXT NOT NULL DEFAULT 'unknown',
    ADD COLUMN expected_payment_method TEXT NOT NULL DEFAULT 'unknown';

ALTER TABLE bookings
    ADD CONSTRAINT bookings_manual_direct_source_check CHECK (
        manual_direct_source IN (
            'unknown', 'call', 'email', 'whatsapp',
            'walk_in', 'social_media', 'other'
        )
    ),
    ADD CONSTRAINT bookings_expected_payment_method_check CHECK (
        expected_payment_method IN (
            'unknown', 'pay_at_property', 'bank_transfer',
            'manual_card', 'cash', 'other'
        )
    );

-- Composite keys let child evidence prove property ownership without triggers.
CREATE UNIQUE INDEX uq_bookings_id_hotel
    ON bookings (id, hotel_id);
CREATE UNIQUE INDEX uq_bookings_id_hotel_currency
    ON bookings (id, hotel_id, currency);
CREATE UNIQUE INDEX uq_rooms_id_type_hotel
    ON rooms (id, room_type_id, hotel_id);

CREATE TABLE manual_booking_stays (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    booking_id UUID NOT NULL,
    hotel_id UUID NOT NULL,
    position INTEGER NOT NULL CHECK (position BETWEEN 1 AND 20),
    room_id UUID NOT NULL,
    room_type_id UUID NOT NULL,
    check_in DATE NOT NULL,
    check_out DATE NOT NULL,
    adults INTEGER NOT NULL CHECK (adults >= 1),
    children INTEGER NOT NULL DEFAULT 0 CHECK (children >= 0),
    rate_plan_id TEXT CHECK (rate_plan_id IS NULL OR btrim(rate_plan_id) <> ''),
    currency TEXT NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT manual_booking_stays_dates_check CHECK (check_out > check_in),
    CONSTRAINT manual_booking_stays_booking_property_fk
        FOREIGN KEY (booking_id, hotel_id, currency)
        REFERENCES bookings (id, hotel_id, currency) ON DELETE CASCADE,
    CONSTRAINT manual_booking_stays_room_property_fk
        FOREIGN KEY (room_id, room_type_id, hotel_id)
        REFERENCES rooms (id, room_type_id, hotel_id) ON DELETE RESTRICT,
    CONSTRAINT manual_booking_stays_booking_position_key
        UNIQUE (booking_id, position)
);

CREATE INDEX idx_manual_booking_stays_room_dates
    ON manual_booking_stays (room_id, check_in, check_out);

CREATE TABLE manual_booking_stay_nights (
    stay_id UUID NOT NULL REFERENCES manual_booking_stays(id) ON DELETE CASCADE,
    service_date DATE NOT NULL,
    standard_amount NUMERIC(15,2) CHECK (standard_amount >= 0),
    applied_amount NUMERIC(15,2) NOT NULL CHECK (applied_amount >= 0),
    PRIMARY KEY (stay_id, service_date)
);

CREATE FUNCTION enforce_manual_booking_stay_nights_complete()
RETURNS TRIGGER AS $$
DECLARE
    affected_stay_id UUID;
    stay_row manual_booking_stays%ROWTYPE;
BEGIN
    IF TG_TABLE_NAME = 'manual_booking_stays' THEN
        affected_stay_id := CASE WHEN TG_OP = 'DELETE' THEN OLD.id ELSE NEW.id END;
    ELSE
        IF TG_OP = 'UPDATE' AND OLD.stay_id <> NEW.stay_id THEN
            RAISE EXCEPTION 'manual booking stay nights cannot move between stays' USING ERRCODE = 'check_violation';
        END IF;
        affected_stay_id := CASE WHEN TG_OP = 'DELETE' THEN OLD.stay_id ELSE NEW.stay_id END;
    END IF;

    SELECT * INTO stay_row FROM manual_booking_stays WHERE id = affected_stay_id;
    IF NOT FOUND THEN
        RETURN NULL;
    END IF;

    IF EXISTS (
        (SELECT day::date
         FROM generate_series(
             stay_row.check_in::timestamp,
             (stay_row.check_out - 1)::timestamp,
             interval '1 day'
         ) AS day)
        EXCEPT
        (SELECT service_date FROM manual_booking_stay_nights
         WHERE stay_id = affected_stay_id)
    ) OR EXISTS (
        (SELECT service_date FROM manual_booking_stay_nights
         WHERE stay_id = affected_stay_id)
        EXCEPT
        (SELECT day::date
         FROM generate_series(
             stay_row.check_in::timestamp,
             (stay_row.check_out - 1)::timestamp,
             interval '1 day'
         ) AS day)
    ) THEN
        RAISE EXCEPTION 'manual booking stay % requires one price row per service night',
            affected_stay_id USING ERRCODE = 'check_violation';
    END IF;

    RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE CONSTRAINT TRIGGER trg_manual_booking_stay_dates_complete
    AFTER INSERT OR UPDATE ON manual_booking_stays
    DEFERRABLE INITIALLY DEFERRED
    FOR EACH ROW EXECUTE FUNCTION enforce_manual_booking_stay_nights_complete();

CREATE CONSTRAINT TRIGGER trg_manual_booking_stay_nights_complete
    AFTER INSERT OR UPDATE OR DELETE ON manual_booking_stay_nights
    DEFERRABLE INITIALLY DEFERRED
    FOR EACH ROW EXECUTE FUNCTION enforce_manual_booking_stay_nights_complete();

CREATE TABLE manual_booking_commands (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    hotel_id UUID NOT NULL REFERENCES hotels(id) ON DELETE CASCADE,
    command_id TEXT NOT NULL CHECK (char_length(command_id) BETWEEN 1 AND 200),
    idempotency_key TEXT NOT NULL
        CHECK (char_length(idempotency_key) BETWEEN 1 AND 255),
    request_hash TEXT NOT NULL CHECK (request_hash ~ '^[0-9a-f]{64}$'),
    booking_id UUID,
    result_snapshot JSONB,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    completed_at TIMESTAMPTZ,
    CONSTRAINT manual_booking_commands_booking_property_fk
        FOREIGN KEY (booking_id, hotel_id)
        REFERENCES bookings (id, hotel_id) ON DELETE SET NULL (booking_id),
    CONSTRAINT manual_booking_commands_hotel_command_key
        UNIQUE (hotel_id, command_id),
    CONSTRAINT manual_booking_commands_hotel_idempotency_key
        UNIQUE (hotel_id, idempotency_key),
    CONSTRAINT manual_booking_commands_booking_key UNIQUE (booking_id),
    CONSTRAINT manual_booking_commands_completion_check CHECK (
        (booking_id IS NULL AND result_snapshot IS NULL AND completed_at IS NULL)
        OR (result_snapshot IS NOT NULL AND completed_at IS NOT NULL)
    )
);
