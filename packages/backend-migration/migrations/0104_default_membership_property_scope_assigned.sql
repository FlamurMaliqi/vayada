-- Migration: 0104_default_membership_property_scope_assigned
-- Owner: domain-identity (backend-auth, backend-authorization)
-- See: engineering/staff-access-authorization-contract.md, VAY-1085

-- Serialize against mounted membership writers before taking any row locks.
-- This prevents a writer waiting on a repaired row from deadlocking the final
-- ALTER TABLE lock upgrade. The migration runner holds this lock until commit.
LOCK TABLE identity.organization_memberships IN SHARE ROW EXCLUSIVE MODE;

-- Migration 0103 used `all` as a deployment-safe compatibility default. Before
-- converting those non-owner hotel memberships to `assigned`, preserve their
-- current access as explicit assignments to every active canonical property.
INSERT INTO identity.membership_property_assignments (membership_id, property_id)
SELECT membership.id, property.id
FROM identity.organization_memberships membership
JOIN identity.organizations organization
  ON organization.id = membership.organization_id
JOIN identity.organization_resource_links link
  ON link.organization_id = organization.id
JOIN hotel_catalog.properties property
  ON property.id::text = link.resource_id
WHERE membership.property_access_mode = 'all'
  AND organization.kind = 'hotel_group'
  AND membership.role_key NOT IN ('hotel_owner', 'owner', 'operator')
  AND link.product = 'hotel_catalog'
  AND link.resource_type = 'property'
  AND link.relationship IN ('owner', 'operator')
  AND link.status = 'active'
ON CONFLICT (membership_id, property_id) DO NOTHING;

-- Owner aliases keep broad access. Every other transitional row becomes
-- explicit and fail-closed; non-hotel memberships do not use property scope.
UPDATE identity.organization_memberships membership
SET property_access_mode = 'assigned',
    updated_at = now()
FROM identity.organizations organization
WHERE organization.id = membership.organization_id
  AND membership.property_access_mode = 'all'
  AND NOT (
    organization.kind = 'hotel_group'
    AND membership.role_key IN ('hotel_owner', 'owner', 'operator')
  );

ALTER TABLE identity.organization_memberships
  ALTER COLUMN property_access_mode SET DEFAULT 'assigned';
