-- Migration: 0106_drop_membership_access_origin_default
-- Owner: domain-identity (backend-auth, backend-authorization)
-- See: engineering/external-owner-delegation-contract.md, VAY-1321

-- Deploy only after the explicit-origin writer release reaches ECS stability.
ALTER TABLE identity.organization_memberships
  ALTER COLUMN access_origin DROP DEFAULT;
