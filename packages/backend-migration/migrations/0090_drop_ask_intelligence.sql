-- Migration: 0090_drop_ask_intelligence
-- Owner: platform
--
-- Ask Intelligence has been retired pending a ground-up hotel employee agent
-- design. This migration intentionally deletes its persisted conversations,
-- runs, tool traces, evidence snapshots, answer audits, and catalog records.

DROP TABLE IF EXISTS
  intelligence.ask_answer_audits,
  intelligence.ask_tool_calls,
  intelligence.ask_runs,
  intelligence.ask_conversations,
  intelligence.ai_evidence_catalog,
  intelligence.metric_snapshot_runs,
  intelligence.setup_completeness_snapshots,
  intelligence.metric_definitions;

DROP FUNCTION IF EXISTS
  intelligence.jsonb_has_forbidden_evidence_key(JSONB),
  intelligence.text_has_forbidden_evidence_value(TEXT),
  intelligence.valid_source_view(TEXT, TEXT),
  intelligence.valid_resource_scope(TEXT, UUID, UUID),
  intelligence.resource_scope_key(TEXT, UUID, UUID);

-- Deliberately omit CASCADE so an unexpected external dependency fails safely
-- instead of deleting an object owned by another product schema.
DROP SCHEMA IF EXISTS intelligence;

-- Both permissions were introduced by 0011 exclusively for Ask Intelligence.
DELETE FROM identity.role_permission_grants
WHERE permission_key IN (
  'finance.summary.read',
  'intelligence.ask.read'
);

DELETE FROM identity.permission_catalog
WHERE key IN (
  'finance.summary.read',
  'intelligence.ask.read'
);

ALTER TABLE identity.organization_resource_links
  DROP CONSTRAINT IF EXISTS uq_identity_resource_links_id_organization,
  DROP CONSTRAINT IF EXISTS uq_identity_resource_links_id_organization_resource;
