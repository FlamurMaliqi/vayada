-- Migration: 0103_membership_property_scope
-- Owner: domain-identity (backend-auth, backend-authorization)
-- See: engineering/staff-access-authorization-contract.md, VAY-1085

ALTER TABLE identity.organization_memberships
  ADD COLUMN property_access_mode TEXT NOT NULL DEFAULT 'all'
    CONSTRAINT chk_organization_memberships_property_access_mode
    CHECK (property_access_mode IN ('all', 'assigned'));

-- Preserve current broad access while the schema deploys ahead of its writers.
-- Before staff creation ships, every membership writer must set an explicit
-- mode and a successor migration must change this transitional default to
-- 'assigned'.
UPDATE identity.organization_memberships membership
SET property_access_mode = 'all'
FROM identity.organizations organization
WHERE organization.id = membership.organization_id
  AND organization.kind = 'hotel_group';

CREATE TABLE identity.membership_property_assignments (
  membership_id   UUID        NOT NULL REFERENCES identity.organization_memberships(id) ON DELETE CASCADE,
  property_id     UUID        NOT NULL REFERENCES hotel_catalog.properties(id) ON DELETE CASCADE,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (membership_id, property_id)
);

CREATE FUNCTION identity.enforce_membership_property_assignment_scope()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM identity.organization_memberships membership
    JOIN identity.organization_resource_links link
      ON link.organization_id = membership.organization_id
    WHERE membership.id = NEW.membership_id
      AND link.product = 'hotel_catalog'
      AND link.resource_type = 'property'
      AND link.resource_id = NEW.property_id::text
      AND link.relationship IN ('owner', 'operator')
      AND link.status = 'active'
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23503',
      CONSTRAINT = 'fk_membership_property_assignment_canonical_scope',
      MESSAGE = 'membership property assignment requires an active canonical organization property link';
  END IF;
  RETURN NEW;
END;
$$;

CREATE CONSTRAINT TRIGGER fk_membership_property_assignment_canonical_scope
AFTER INSERT OR UPDATE ON identity.membership_property_assignments
DEFERRABLE INITIALLY IMMEDIATE
FOR EACH ROW
EXECUTE FUNCTION identity.enforce_membership_property_assignment_scope();
