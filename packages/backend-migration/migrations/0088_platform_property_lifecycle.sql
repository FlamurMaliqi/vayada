-- Migration: 0088_platform_property_lifecycle
-- Owner: domain-hotels (Catalog lifecycle)
-- See: engineering/platform-admin-dashboard-intake-contract.md, VAY-1280

ALTER TABLE hotel_catalog.properties
  ADD COLUMN lifecycle_status TEXT,
  ADD COLUMN lifecycle_revision BIGINT NOT NULL DEFAULT 1,
  ADD COLUMN pre_hold_profile_status TEXT,
  ADD COLUMN retired_at TIMESTAMPTZ,
  ADD COLUMN retired_by_user_id UUID REFERENCES identity.users(id),
  ADD CONSTRAINT chk_properties_lifecycle_revision
    CHECK (lifecycle_revision BETWEEN 1 AND 2147483647),
  ADD CONSTRAINT chk_properties_pre_hold_profile_status
    CHECK (
      pre_hold_profile_status IS NULL
      OR pre_hold_profile_status IN ('complete', 'incomplete', 'disabled', 'private')
    );

UPDATE hotel_catalog.properties
SET lifecycle_status = CASE profile_status
  WHEN 'complete' THEN 'active'
  WHEN 'disabled' THEN 'suspended'
  ELSE 'provisioning'
END;

ALTER TABLE hotel_catalog.properties
  ALTER COLUMN lifecycle_status SET DEFAULT 'provisioning',
  ALTER COLUMN lifecycle_status SET NOT NULL,
  ADD CONSTRAINT chk_properties_lifecycle_status
    CHECK (lifecycle_status IN ('provisioning', 'active', 'suspended', 'retired')),
  ADD CONSTRAINT chk_properties_retirement_metadata
    CHECK (
      (lifecycle_status = 'retired' AND retired_at IS NOT NULL AND retired_by_user_id IS NOT NULL)
      OR
      (lifecycle_status <> 'retired' AND retired_at IS NULL AND retired_by_user_id IS NULL)
    );

CREATE INDEX idx_properties_lifecycle_status
  ON hotel_catalog.properties (lifecycle_status, updated_at DESC);

ALTER TABLE booking.booking_publication_attempts
  ADD COLUMN expected_property_lifecycle_revision BIGINT;

UPDATE booking.booking_publication_attempts attempt
SET expected_property_lifecycle_revision = property.lifecycle_revision
FROM hotel_catalog.properties property
WHERE property.id = attempt.property_id;

ALTER TABLE booking.booking_publication_attempts
  ALTER COLUMN expected_property_lifecycle_revision SET DEFAULT 1,
  ALTER COLUMN expected_property_lifecycle_revision SET NOT NULL,
  ADD CONSTRAINT chk_booking_publication_property_lifecycle_revision
    CHECK (expected_property_lifecycle_revision BETWEEN 1 AND 2147483647);

INSERT INTO identity.permission_catalog (key, product, description) VALUES
  ('platform.property.status.manage', 'platform', 'Manage target property lifecycle')
ON CONFLICT (key) DO NOTHING;

INSERT INTO identity.role_permission_grants (organization_kind, role_key, permission_key) VALUES
  ('platform', 'platform_admin', 'platform.property.status.manage')
ON CONFLICT (organization_kind, role_key, permission_key) DO NOTHING;
