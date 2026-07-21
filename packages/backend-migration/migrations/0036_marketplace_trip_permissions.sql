-- Migration: 0036_marketplace_trip_permissions
-- Owner: domain-marketplace
--
-- Activates the target trips/calendar routes for creator workspaces. The
-- tables shipped in 0008, but their permission catalog entries and grants did
-- not, which left the routes unusable even when the repository was enabled.

INSERT INTO identity.permission_catalog (key, product, description) VALUES
  ('marketplace.trip.read',   'marketplace', 'Read creator trips and external collaborations'),
  ('marketplace.trip.manage', 'marketplace', 'Manage creator trips and external collaborations')
ON CONFLICT (key) DO NOTHING;

INSERT INTO identity.role_permission_grants (
  organization_kind,
  role_key,
  permission_key
) VALUES
  ('creator_workspace', 'creator_owner', 'marketplace.trip.read'),
  ('creator_workspace', 'creator_owner', 'marketplace.trip.manage')
ON CONFLICT (organization_kind, role_key, permission_key) DO NOTHING;
