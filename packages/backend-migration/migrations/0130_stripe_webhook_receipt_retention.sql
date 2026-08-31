-- VAY-1348: bound retained Stripe webhook evidence without deleting audit rows.

ALTER TABLE platform.external_webhook_events
  ADD COLUMN payload_retention_until TIMESTAMPTZ,
  ADD COLUMN payload_purged_at TIMESTAMPTZ;

-- Receipts written before the v1 allowlist cannot be proven safe field-by-field.
-- Tombstone their payload copies while preserving immutable IDs and hashes.
DROP TRIGGER trg_platform_external_webhook_events_append_only
  ON platform.external_webhook_events;

UPDATE platform.external_webhook_events
SET raw_headers = '{}'::jsonb,
    raw_payload = '{}'::jsonb,
    payload_retention_until = LEAST(received_at + INTERVAL '30 days', CURRENT_TIMESTAMP),
    payload_purged_at = CURRENT_TIMESTAMP
WHERE provider = 'stripe';

DROP TRIGGER trg_platform_product_audit_events_append_only
  ON platform.product_audit_events;

UPDATE platform.product_audit_events audit
SET private_payload = '{}'::jsonb
FROM platform.external_webhook_events receipt
WHERE audit.external_webhook_event_id = receipt.id
  AND receipt.provider = 'stripe';

CREATE TRIGGER trg_platform_product_audit_events_append_only
  BEFORE UPDATE OR DELETE ON platform.product_audit_events
  FOR EACH ROW
  EXECUTE FUNCTION platform.prevent_append_only_mutation();

ALTER TABLE platform.external_webhook_events
  ADD CONSTRAINT chk_platform_stripe_webhook_receipt_retention
    CHECK (provider <> 'stripe' OR payload_retention_until IS NOT NULL),
  ADD CONSTRAINT chk_platform_external_webhook_events_payload_purge
    CHECK (
      payload_purged_at IS NULL
      OR (
        provider = 'stripe'
        AND payload_retention_until IS NOT NULL
        AND payload_purged_at >= payload_retention_until
        AND raw_headers = '{}'::jsonb
        AND raw_payload = '{}'::jsonb
      )
    );

CREATE INDEX idx_platform_external_webhook_events_stripe_retention
  ON platform.external_webhook_events (payload_retention_until)
  WHERE provider = 'stripe' AND payload_purged_at IS NULL;

COMMENT ON COLUMN platform.external_webhook_events.payload_retention_until IS
  'End of the operational replay window for Stripe payload evidence. Stripe writers assign 30 days; approval is required before callback cutover.';

COMMENT ON COLUMN platform.external_webhook_events.payload_purged_at IS
  'When set, the Stripe payload and headers were irreversibly erased while append-only receipt identity, hashes, lifecycle, and audit links remained.';

CREATE OR REPLACE FUNCTION platform.prevent_external_webhook_receipt_raw_mutation()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  is_expired_stripe_payload_purge BOOLEAN;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'platform append-only table % cannot be deleted', TG_TABLE_NAME
      USING ERRCODE = '55000';
  END IF;

  is_expired_stripe_payload_purge := COALESCE((
    OLD.provider = 'stripe'
    AND OLD.payload_purged_at IS NULL
    AND OLD.payload_retention_until <= CURRENT_TIMESTAMP
    AND NEW.payload_purged_at IS NOT NULL
    AND NEW.payload_purged_at >= OLD.payload_retention_until
    AND NEW.payload_purged_at <= CURRENT_TIMESTAMP
    AND NEW.raw_headers = '{}'::jsonb
    AND NEW.raw_payload = '{}'::jsonb
  ), FALSE);

  IF OLD.provider IS DISTINCT FROM NEW.provider
    OR OLD.provider_event_id IS DISTINCT FROM NEW.provider_event_id
    OR OLD.webhook_key_hash IS DISTINCT FROM NEW.webhook_key_hash
    OR OLD.event_type IS DISTINCT FROM NEW.event_type
    OR OLD.signature_verified IS DISTINCT FROM NEW.signature_verified
    OR OLD.received_at IS DISTINCT FROM NEW.received_at
    OR OLD.tenant_scope IS DISTINCT FROM NEW.tenant_scope
    OR OLD.organization_id IS DISTINCT FROM NEW.organization_id
    OR OLD.property_id IS DISTINCT FROM NEW.property_id
    OR OLD.payload_hash IS DISTINCT FROM NEW.payload_hash
    OR OLD.payload_retention_until IS DISTINCT FROM NEW.payload_retention_until
    OR OLD.privacy_scope IS DISTINCT FROM NEW.privacy_scope
    OR OLD.ai_visible IS DISTINCT FROM NEW.ai_visible
  THEN
    RAISE EXCEPTION 'platform webhook receipt raw fields are immutable'
      USING ERRCODE = '55000';
  END IF;

  IF (
    OLD.raw_headers IS DISTINCT FROM NEW.raw_headers
    OR OLD.raw_payload IS DISTINCT FROM NEW.raw_payload
    OR OLD.payload_purged_at IS DISTINCT FROM NEW.payload_purged_at
  ) AND NOT is_expired_stripe_payload_purge
  THEN
    RAISE EXCEPTION 'platform webhook receipt raw fields are immutable'
      USING ERRCODE = '55000';
  END IF;

  IF OLD.delivery_status IN ('promoted', 'normalized', 'succeeded', 'ignored', 'dead_lettered')
    AND NEW.delivery_status IS DISTINCT FROM OLD.delivery_status
  THEN
    RAISE EXCEPTION 'platform webhook receipt terminal status cannot change'
      USING ERRCODE = '55000';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_platform_external_webhook_events_append_only
  BEFORE UPDATE OR DELETE ON platform.external_webhook_events
  FOR EACH ROW
  EXECUTE FUNCTION platform.prevent_external_webhook_receipt_raw_mutation();

CREATE OR REPLACE FUNCTION platform.purge_expired_stripe_webhook_receipts(
  cutoff TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
)
RETURNS INTEGER
LANGUAGE plpgsql
AS $$
DECLARE
  purged_count INTEGER;
BEGIN
  UPDATE platform.external_webhook_events
  SET raw_headers = '{}'::jsonb,
      raw_payload = '{}'::jsonb,
      payload_purged_at = CURRENT_TIMESTAMP
  WHERE provider = 'stripe'
    AND payload_purged_at IS NULL
    AND payload_retention_until <= LEAST(cutoff, CURRENT_TIMESTAMP);

  GET DIAGNOSTICS purged_count = ROW_COUNT;
  RETURN purged_count;
END;
$$;

REVOKE ALL ON FUNCTION platform.purge_expired_stripe_webhook_receipts(TIMESTAMPTZ)
  FROM PUBLIC;

COMMENT ON FUNCTION platform.purge_expired_stripe_webhook_receipts(TIMESTAMPTZ) IS
  'Operator-only Stripe receipt payload erasure. Keeps append-only identifiers, hashes, lifecycle state, and audit relationships.';
