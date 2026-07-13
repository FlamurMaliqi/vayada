-- Migration: 0027_identity_organization_profiles
-- Owner: domain-identity
-- Adds the optional public website for a Vayada business account.

ALTER TABLE identity.organizations
  ADD COLUMN website_url TEXT;

ALTER TABLE identity.organizations
  ADD CONSTRAINT chk_identity_organizations_website_url
  CHECK (
    website_url IS NULL
    OR website_url ~ '^https?://[^[:space:]]+$'
  );
