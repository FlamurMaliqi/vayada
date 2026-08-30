-- VAY-1355: make short-lived checkout guest PII expiry explicit.

ALTER TABLE booking.checkout_contexts
  ADD COLUMN pii_retention_until DATE;

COMMENT ON COLUMN booking.checkout_contexts.pii_retention_until IS
  'Latest date short-lived checkout guest_input may be retained. Production migration uses the immutable legacy draft expiry date.';
