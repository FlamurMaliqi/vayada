-- Migration: 0121_hotel_property_manifest_permission
-- Owner: domain-identity (backend-auth, backend-authorization)
-- See: engineering/staff-access-authorization-contract.md, VAY-1085

INSERT INTO identity.permission_catalog (key, product, description) VALUES
  ('hotel_catalog.property_manifest.read', 'hotel_catalog', 'Read the effective hotel property manifest')
ON CONFLICT (key) DO NOTHING;

INSERT INTO identity.role_permission_grants (organization_kind, role_key, permission_key)
SELECT 'hotel_group', role_key, 'hotel_catalog.property_manifest.read'
FROM (VALUES
  ('hotel_owner'), ('owner'), ('operator'), ('hotel_manager'),
  ('front_desk'), ('housekeeping'), ('hotel_custom')
) AS roles(role_key)
ON CONFLICT (organization_kind, role_key, permission_key) DO NOTHING;
