-- VAY-959; engineering/pending-booking-edit-contract.md.
-- Attempts remain outside finance.payments until a guest commits an edit.
ALTER TABLE booking.guest_bookings
  ADD COLUMN edit_revision INTEGER NOT NULL DEFAULT 0 CHECK (edit_revision >= 0),
  ADD COLUMN active_card_payment_id UUID,
  ADD CONSTRAINT fk_booking_active_card_payment
    FOREIGN KEY (active_card_payment_id, property_id, id)
    REFERENCES finance.payments (id, property_id, guest_booking_id);

UPDATE booking.guest_bookings booking
SET active_card_payment_id = (
  SELECT payment.id FROM finance.payments payment
  WHERE payment.guest_booking_id = booking.id
    AND payment.property_id = booking.property_id
    AND payment.payment_method = 'card'
    AND payment.provider_payment_intent_id IS NOT NULL
  ORDER BY payment.created_at DESC, payment.id DESC LIMIT 1
)
WHERE booking.booking_metadata ->> 'paymentMethod' = 'card';

ALTER TABLE booking.booking_addon_selections
  ADD COLUMN edit_revision INTEGER NOT NULL DEFAULT 0 CHECK (edit_revision >= 0);

-- Keep the Finance evidence view unchanged: historical folios reference its IDs.
CREATE VIEW booking.active_booking_addon_selections AS
SELECT selection.* FROM booking.booking_addon_selections selection
JOIN booking.guest_bookings booking
  ON booking.id = selection.guest_booking_id
 AND booking.property_id = selection.property_id
 AND booking.edit_revision = selection.edit_revision;

CREATE FUNCTION booking.protect_addon_edit_revision()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.edit_revision IS DISTINCT FROM OLD.edit_revision THEN
    RAISE EXCEPTION 'Purchased add-on revision is immutable' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER trg_booking_addon_edit_revision_immutable
BEFORE UPDATE ON booking.booking_addon_selections
FOR EACH ROW EXECUTE FUNCTION booking.protect_addon_edit_revision();

CREATE TABLE booking.pending_booking_edit_attempts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id UUID NOT NULL,
  guest_booking_id UUID NOT NULL,
  expected_revision INTEGER NOT NULL CHECK (expected_revision >= 0),
  idempotency_key TEXT NOT NULL,
  request_fingerprint TEXT NOT NULL,
  request_snapshot JSONB NOT NULL DEFAULT '{}'::jsonb,
  provider_request JSONB NOT NULL DEFAULT '{}'::jsonb,
  quote_session_id UUID NOT NULL,
  provider_account_id UUID,
  provider_payment_intent_id TEXT,
  payment_method TEXT NOT NULL CHECK (
    payment_method IN ('card', 'pay_at_property', 'cash', 'bank_transfer', 'paypal')
  ),
  status TEXT NOT NULL DEFAULT 'prepared' CHECK (
    status IN ('prepared', 'committed', 'release_pending', 'released')
  ),
  expires_at TIMESTAMPTZ NOT NULL,
  committed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_pending_booking_edit_command UNIQUE (property_id, idempotency_key),
  CONSTRAINT fk_pending_booking_edit_booking
    FOREIGN KEY (guest_booking_id, property_id)
    REFERENCES booking.guest_bookings (id, property_id),
  CONSTRAINT fk_pending_booking_edit_quote
    FOREIGN KEY (quote_session_id, property_id)
    REFERENCES booking.quote_sessions (id, property_id),
  CONSTRAINT fk_pending_booking_edit_provider
    FOREIGN KEY (provider_account_id, property_id)
    REFERENCES finance.payment_provider_accounts (id, property_id),
  CONSTRAINT chk_pending_booking_edit_card_account CHECK (
    (payment_method = 'card' AND provider_account_id IS NOT NULL)
    OR (payment_method <> 'card' AND provider_account_id IS NULL
      AND provider_payment_intent_id IS NULL)
  ),
  CONSTRAINT chk_pending_booking_edit_commit_time CHECK (
    (status = 'committed') = (committed_at IS NOT NULL)
  ),
  CONSTRAINT chk_pending_booking_edit_expiry CHECK (expires_at > created_at)
);

CREATE UNIQUE INDEX uq_pending_booking_edit_provider_intent
  ON booking.pending_booking_edit_attempts (provider_account_id, provider_payment_intent_id)
  WHERE provider_payment_intent_id IS NOT NULL;
CREATE INDEX idx_pending_booking_edit_cleanup
  ON booking.pending_booking_edit_attempts (expires_at, id)
  WHERE status IN ('prepared', 'release_pending');

-- Durable cancellation receipts cover both abandoned attempts and replaced holds.
CREATE TABLE booking.edit_authorization_releases (
  provider_payment_intent_id TEXT NOT NULL,
  provider_account_ref TEXT NOT NULL,
  property_id UUID NOT NULL REFERENCES hotel_catalog.properties(id),
  released_at TIMESTAMPTZ,
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (provider_account_ref, provider_payment_intent_id)
);
