-- Migration: 0112_validate_staff_invitation_delivery_state
-- Owner: domain-identity (backend-auth)
-- See: engineering/staff-access-authorization-contract.md, VAY-1085

ALTER TABLE identity.staff_invitations
  VALIDATE CONSTRAINT chk_staff_invitation_delivery_state;

ALTER TABLE identity.staff_invitations
  ALTER COLUMN delivery_state SET NOT NULL;
