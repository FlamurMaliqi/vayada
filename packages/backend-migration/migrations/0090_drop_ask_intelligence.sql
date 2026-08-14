-- Migration: 0090_drop_ask_intelligence
-- Owner: platform
--
-- Ask Intelligence has been retired pending a ground-up hotel employee agent
-- design. This migration intentionally deletes its persisted conversations,
-- runs, tool traces, evidence snapshots, answer audits, and catalog records.

DROP SCHEMA IF EXISTS intelligence CASCADE;

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
