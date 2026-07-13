-- Migration: 0032_validate_identity_profile_constraints
-- Owner: platform-identity
-- See: packages/backend-migration/migrations/0027_identity_organization_profiles.sql
-- See: packages/backend-migration/migrations/0028_identity_user_contact_profiles.sql
--
-- Validates identity profile constraints after their NOT VALID additions have
-- committed, avoiding table scans while holding the stronger add-column and
-- add-constraint locks.

ALTER TABLE identity.organizations
  VALIDATE CONSTRAINT chk_identity_organizations_website_url;

ALTER TABLE identity.users
  VALIDATE CONSTRAINT chk_identity_users_phone;

ALTER TABLE identity.users
  VALIDATE CONSTRAINT chk_identity_users_profile_picture_url;

ALTER TABLE identity.users
  VALIDATE CONSTRAINT chk_identity_users_profile_picture_media_object_id;
