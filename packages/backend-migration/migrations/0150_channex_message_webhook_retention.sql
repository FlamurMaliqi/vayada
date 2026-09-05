-- VAY-1372: bound raw Channex guest-message webhook evidence to the replay window.

DROP TRIGGER trg_platform_external_webhook_events_append_only
  ON platform.external_webhook_events;

ALTER TABLE platform.external_webhook_events
  DROP CONSTRAINT chk_platform_stripe_webhook_receipt_retention,
  DROP CONSTRAINT chk_platform_external_webhook_events_payload_purge;

UPDATE platform.external_webhook_events
SET payload_retention_until = LEAST(received_at + INTERVAL '30 days', CURRENT_TIMESTAMP)
WHERE provider = 'channex' AND event_type = 'message'
  AND payload_retention_until IS NULL;

UPDATE platform.jobs job
SET payload = job.payload - 'rawPayload',
    updated_at = CURRENT_TIMESTAMP,
    job_metadata = job.job_metadata || jsonb_build_object(
      'rawPayloadScrubbedAt', CURRENT_TIMESTAMP
    )
FROM platform.domain_events event
JOIN platform.external_webhook_events receipt
  ON receipt.id::text = event.causation_id
WHERE job.source_domain_event_id = event.id
  AND receipt.provider = 'channex' AND receipt.event_type = 'message'
  AND job.payload ? 'rawPayload';

DROP TRIGGER trg_platform_domain_events_append_only
  ON platform.domain_events;

UPDATE platform.domain_events event
SET payload = event.payload - 'rawPayload'
FROM platform.external_webhook_events receipt
WHERE receipt.id::text = event.causation_id
  AND receipt.provider = 'channex' AND receipt.event_type = 'message'
  AND event.payload ? 'rawPayload';

CREATE TRIGGER trg_platform_domain_events_append_only
  BEFORE UPDATE OR DELETE ON platform.domain_events
  FOR EACH ROW
  EXECUTE FUNCTION platform.prevent_append_only_mutation();

ALTER TABLE platform.external_webhook_events
  ADD CONSTRAINT chk_platform_provider_webhook_receipt_retention
    CHECK (
      (provider <> 'stripe' AND NOT (provider = 'channex' AND event_type = 'message'))
      OR payload_retention_until IS NOT NULL
    ),
  ADD CONSTRAINT chk_platform_external_webhook_events_payload_purge
    CHECK (
      payload_purged_at IS NULL
      OR (
        (provider = 'stripe' OR (provider = 'channex' AND event_type = 'message'))
        AND payload_retention_until IS NOT NULL
        AND (
          payload_purged_at >= payload_retention_until
          OR (
            provider = 'channex' AND event_type = 'message'
            AND failure_reason IN (
              'cross_property_message',
              'invalid_job_payload',
              'provider_thread_identity_mismatch',
              'provider_thread_property_mismatch'
            )
          )
        )
        AND raw_headers = '{}'::jsonb
        AND raw_payload = '{}'::jsonb
      )
    );

CREATE OR REPLACE FUNCTION platform.prevent_external_webhook_receipt_raw_mutation()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  is_expired_payload_purge BOOLEAN;
  is_security_quarantine_purge BOOLEAN;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'platform append-only table % cannot be deleted', TG_TABLE_NAME
      USING ERRCODE = '55000';
  END IF;

  is_expired_payload_purge := COALESCE((
    (OLD.provider = 'stripe' OR (OLD.provider = 'channex' AND OLD.event_type = 'message'))
    AND OLD.payload_purged_at IS NULL
    AND OLD.payload_retention_until <= CURRENT_TIMESTAMP
    AND NEW.payload_purged_at IS NOT NULL
    AND NEW.payload_purged_at >= OLD.payload_retention_until
    AND NEW.payload_purged_at <= clock_timestamp()
    AND NEW.raw_headers = '{}'::jsonb
    AND NEW.raw_payload = '{}'::jsonb
  ), FALSE);

  is_security_quarantine_purge := COALESCE((
    OLD.provider = 'channex'
    AND OLD.event_type = 'message'
    AND OLD.payload_purged_at IS NULL
    AND NEW.failure_reason IN (
      'cross_property_message',
      'invalid_job_payload',
      'provider_thread_identity_mismatch',
      'provider_thread_property_mismatch'
    )
    AND NEW.payload_purged_at IS NOT NULL
    AND NEW.payload_purged_at <= clock_timestamp()
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
  ) AND NOT is_expired_payload_purge AND NOT is_security_quarantine_purge
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

CREATE INDEX idx_platform_external_webhook_events_channex_message_retention
  ON platform.external_webhook_events (payload_retention_until)
  WHERE provider = 'channex' AND event_type = 'message' AND payload_purged_at IS NULL;

CREATE FUNCTION platform.purge_expired_channex_message_webhook_receipts(
  cutoff TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
)
RETURNS INTEGER
LANGUAGE plpgsql
AS $$
DECLARE
  purged_count INTEGER;
BEGIN
  UPDATE platform.jobs job
  SET payload = job.payload - 'rawPayload',
      updated_at = CURRENT_TIMESTAMP,
      job_metadata = job.job_metadata || jsonb_build_object(
        'rawPayloadPurgedAt', CURRENT_TIMESTAMP
      )
  FROM platform.domain_events event
  JOIN platform.external_webhook_events receipt
    ON receipt.id::text = event.causation_id
  WHERE job.source_domain_event_id = event.id
    AND receipt.provider = 'channex' AND receipt.event_type = 'message'
    AND receipt.payload_purged_at IS NULL
    AND receipt.payload_retention_until <= LEAST(cutoff, CURRENT_TIMESTAMP);

  UPDATE platform.external_webhook_events
  SET raw_headers = '{}'::jsonb,
      raw_payload = '{}'::jsonb,
      payload_purged_at = CURRENT_TIMESTAMP
  WHERE provider = 'channex' AND event_type = 'message'
    AND payload_purged_at IS NULL
    AND payload_retention_until <= LEAST(cutoff, CURRENT_TIMESTAMP);

  GET DIAGNOSTICS purged_count = ROW_COUNT;
  RETURN purged_count;
END;
$$;

REVOKE ALL ON FUNCTION platform.purge_expired_channex_message_webhook_receipts(TIMESTAMPTZ)
  FROM PUBLIC;

COMMENT ON FUNCTION platform.purge_expired_channex_message_webhook_receipts(TIMESTAMPTZ) IS
  'Operator-only Channex guest-message payload erasure. Keeps identifiers, hashes, lifecycle state, normalized domain evidence, and audit relationships.';
