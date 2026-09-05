-- VAY-1041/VAY-1466: discard transitional credentials; hotels must re-enter them.
-- No destination is created from historical policy, booking or email data.
CREATE FUNCTION pg_temp.without_bank_credentials(value JSONB) RETURNS JSONB
LANGUAGE plpgsql AS $$
DECLARE result JSONB; item RECORD;
BEGIN
  IF jsonb_typeof(value) = 'object' THEN
    result := '{}'::jsonb;
    FOR item IN SELECT key, val FROM jsonb_each(value) AS entries(key,val) LOOP
      IF item.key <> ALL(ARRAY['bankTransferInstructions','bankTransferDetails',
        'bankName','accountHolder','accountNumber','bicSwift','iban','swift']) THEN
        result := result || jsonb_build_object(item.key, pg_temp.without_bank_credentials(item.val));
      END IF;
    END LOOP;
    RETURN result;
  ELSIF jsonb_typeof(value) = 'array' THEN
    RETURN COALESCE((SELECT jsonb_agg(pg_temp.without_bank_credentials(element))
      FROM jsonb_array_elements(value) element), '[]'::jsonb);
  END IF;
  RETURN value;
END;
$$;

UPDATE finance.payment_settings
SET deposit_policy = pg_temp.without_bank_credentials(deposit_policy);
ALTER TABLE finance.payment_settings ADD CONSTRAINT payment_policy_no_bank_credentials
  CHECK (NOT jsonb_path_exists(deposit_policy,
    '$.** ? (@.type() == "object").keyvalue() ? (@.key == "bankTransferDetails" || @.key == "bankTransferInstructions" || @.key == "bankName" || @.key == "accountHolder" || @.key == "accountNumber" || @.key == "bicSwift" || @.key == "iban" || @.key == "swift")')) NOT VALID;
ALTER TABLE finance.payment_settings VALIDATE CONSTRAINT payment_policy_no_bank_credentials;
UPDATE booking.guest_bookings
SET booking_metadata = pg_temp.without_bank_credentials(booking_metadata)
WHERE COALESCE(booking_metadata->>'paymentMethod', expected_payment_method)='bank_transfer';
UPDATE platform.idempotency_keys
SET idempotency_metadata = pg_temp.without_bank_credentials(idempotency_metadata)
WHERE operation_scope IN ('finance','booking');

-- Old email bodies contain concatenated account text. Replace the entire body,
-- preserving delivery IDs and routing, rather than attempting string redaction.
UPDATE platform.jobs
SET payload = (pg_temp.without_bank_credentials(payload) - 'text') ||
  jsonb_build_object('text', 'Please contact us for updated bank transfer instructions.')
WHERE queue_name='platform.email' AND pg_temp.without_bank_credentials(jsonb_strip_nulls(payload)) IS DISTINCT FROM jsonb_strip_nulls(payload);
ALTER TABLE platform.domain_events DISABLE TRIGGER trg_platform_domain_events_append_only;
UPDATE platform.domain_events
SET payload = (pg_temp.without_bank_credentials(payload) - 'text') ||
  jsonb_build_object('text', 'Please contact us for updated bank transfer instructions.')
WHERE source_system='booking' AND pg_temp.without_bank_credentials(jsonb_strip_nulls(payload)) IS DISTINCT FROM jsonb_strip_nulls(payload);
ALTER TABLE platform.domain_events ENABLE TRIGGER trg_platform_domain_events_append_only;
