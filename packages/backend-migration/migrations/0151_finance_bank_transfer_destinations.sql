-- VAY-1465 / VAY-1041. Additive only; never import raw policy credentials.
CREATE TABLE finance.bank_transfer_destinations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id UUID NOT NULL REFERENCES hotel_catalog.properties(id),
  revision INTEGER NOT NULL CHECK (revision > 0),
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  ciphertext BYTEA,
  key_arn TEXT NOT NULL,
  account_last4 TEXT NOT NULL CHECK (account_last4 ~ '^[A-Za-z0-9]{4}$'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at TIMESTAMPTZ,
  UNIQUE (property_id, revision),
  UNIQUE (id, property_id),
  CHECK ((deleted_at IS NULL AND ciphertext IS NOT NULL
          AND octet_length(ciphertext) BETWEEN 29 AND 6144)
      OR (deleted_at IS NOT NULL AND ciphertext IS NULL AND NOT enabled))
);
CREATE UNIQUE INDEX bank_transfer_destination_active
  ON finance.bank_transfer_destinations(property_id) WHERE enabled;

CREATE FUNCTION finance.protect_bank_transfer_revision() RETURNS TRIGGER
LANGUAGE plpgsql AS $$
BEGIN
  IF (NEW.id, NEW.property_id, NEW.revision, NEW.key_arn, NEW.account_last4)
       IS DISTINCT FROM (OLD.id, OLD.property_id, OLD.revision, OLD.key_arn, OLD.account_last4)
     OR (NEW.ciphertext IS DISTINCT FROM OLD.ciphertext AND NEW.ciphertext IS NOT NULL)
     OR (OLD.deleted_at IS NOT NULL AND NEW.deleted_at IS DISTINCT FROM OLD.deleted_at)
  THEN
    RAISE EXCEPTION 'bank transfer revision is immutable' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER bank_transfer_revision_immutable
BEFORE UPDATE ON finance.bank_transfer_destinations
FOR EACH ROW EXECUTE FUNCTION finance.protect_bank_transfer_revision();

CREATE TABLE finance.bank_transfer_bookings (
  guest_booking_id UUID PRIMARY KEY,
  property_id UUID NOT NULL,
  destination_id UUID NOT NULL,
  FOREIGN KEY (guest_booking_id, property_id)
    REFERENCES booking.guest_bookings(id, property_id),
  FOREIGN KEY (destination_id, property_id)
    REFERENCES finance.bank_transfer_destinations(id, property_id)
);
