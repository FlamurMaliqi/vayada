-- Migration: 0111_staff_invitation_delivery_state
-- Owner: domain-identity (backend-auth)
-- See: engineering/staff-access-authorization-contract.md, VAY-1085

ALTER TABLE identity.staff_invitations
  ADD COLUMN delivery_state TEXT,
  ADD COLUMN delivery_attempted_at TIMESTAMPTZ;

UPDATE identity.staff_invitations
SET delivery_state = CASE
      WHEN provider_invitation_id IS NULL THEN 'ready'
      ELSE 'delivered'
    END,
    delivery_attempted_at = CASE
      WHEN provider_invitation_id IS NULL THEN NULL
      ELSE updated_at
    END;

ALTER TABLE identity.staff_invitations
  ALTER COLUMN delivery_state SET DEFAULT 'ready',
  ADD CONSTRAINT chk_staff_invitation_delivery_state
  CHECK (
    delivery_state IS NOT NULL
    AND (
      (delivery_state = 'ready'
        AND delivery_attempted_at IS NULL
        AND provider_invitation_id IS NULL)
      OR (delivery_state = 'sending'
        AND status = 'pending'
        AND delivery_attempted_at IS NOT NULL
        AND provider_invitation_id IS NULL)
      OR (delivery_state = 'unknown'
        AND delivery_attempted_at IS NOT NULL
        AND provider_invitation_id IS NULL)
      OR (delivery_state = 'delivered'
        AND delivery_attempted_at IS NOT NULL
        AND provider_invitation_id IS NOT NULL
        AND expires_at IS NOT NULL)
    )
  ) NOT VALID;
