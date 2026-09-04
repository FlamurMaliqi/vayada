-- Migration: 0145_pms_inbox_assistance_results

BEGIN;

CREATE TABLE pms.message_assistance_results (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id UUID NOT NULL REFERENCES hotel_catalog.properties(id),
  thread_id UUID NOT NULL,
  idempotency_key_id UUID NOT NULL,
  kind TEXT NOT NULL CHECK (
    kind IN ('translate_message', 'translate_draft', 'summarize', 'draft_reply')
  ),
  based_through_message_id UUID,
  assisted_text TEXT CHECK (
    assisted_text IS NULL OR (btrim(assisted_text) <> '' AND char_length(assisted_text) <= 20000)
  ),
  created_at TIMESTAMPTZ NOT NULL,
  pii_retention_until TIMESTAMPTZ NOT NULL,
  purged_at TIMESTAMPTZ,
  scope_key TEXT GENERATED ALWAYS AS (
    platform.tenant_scope_key('property', NULL::UUID, property_id)
  ) STORED,
  CONSTRAINT uq_pms_message_assistance_result_property UNIQUE (id, property_id),
  CONSTRAINT uq_pms_message_assistance_result_idempotency UNIQUE (property_id, idempotency_key_id),
  CONSTRAINT fk_pms_message_assistance_result_thread_property
    FOREIGN KEY (thread_id, property_id)
    REFERENCES pms.message_threads(id, property_id) ON DELETE CASCADE,
  CONSTRAINT fk_pms_message_assistance_result_idempotency_scope
    FOREIGN KEY (idempotency_key_id, scope_key)
    REFERENCES platform.idempotency_keys(id, scope_key),
  CONSTRAINT chk_pms_message_assistance_result_boundary CHECK (
    (kind IN ('translate_message', 'translate_draft') AND based_through_message_id IS NULL)
    OR (kind IN ('summarize', 'draft_reply') AND based_through_message_id IS NOT NULL)
  ),
  CONSTRAINT chk_pms_message_assistance_result_retention CHECK (
    (purged_at IS NULL AND assisted_text IS NOT NULL)
    OR (
      purged_at IS NOT NULL AND purged_at >= pii_retention_until AND assisted_text IS NULL
    )
  )
);

CREATE INDEX idx_pms_message_assistance_results_retention
  ON pms.message_assistance_results (pii_retention_until)
  WHERE purged_at IS NULL;

CREATE OR REPLACE FUNCTION pms.purge_expired_message_assistance_results(
  cutoff TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
)
RETURNS INTEGER
LANGUAGE plpgsql
AS $$
DECLARE
  purged_count INTEGER;
BEGIN
  UPDATE pms.message_assistance_results
  SET assisted_text = NULL,
      purged_at = CURRENT_TIMESTAMP
  WHERE purged_at IS NULL
    AND pii_retention_until <= LEAST(cutoff, CURRENT_TIMESTAMP);

  GET DIAGNOSTICS purged_count = ROW_COUNT;
  RETURN purged_count;
END;
$$;

REVOKE ALL ON FUNCTION pms.purge_expired_message_assistance_results(TIMESTAMPTZ)
  FROM PUBLIC;

COMMENT ON TABLE pms.message_assistance_results IS
  'Property-scoped, human-reviewed Inbox assistance output. This is not a guest message.';
COMMENT ON COLUMN pms.message_assistance_results.assisted_text IS
  'Private assisted text, removable at pii_retention_until while non-content audit evidence remains.';
COMMENT ON COLUMN pms.message_assistance_results.based_through_message_id IS
  'Historical message boundary identifier retained even when the source message is deleted.';
COMMENT ON FUNCTION pms.purge_expired_message_assistance_results(TIMESTAMPTZ) IS
  'Operator-only erasure of expired Inbox assistance text while retaining non-content evidence.';

COMMIT;
