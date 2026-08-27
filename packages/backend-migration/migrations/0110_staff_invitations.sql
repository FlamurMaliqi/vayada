-- Migration: 0110_staff_invitations
-- Owner: domain-identity (backend-auth)
-- See: engineering/staff-access-authorization-contract.md, VAY-1085

ALTER TABLE identity.organization_memberships
  ADD CONSTRAINT uq_organization_memberships_invitation_scope
  UNIQUE (id, organization_id, user_id);

CREATE TABLE identity.staff_invitations (
  id                        UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id           UUID        NOT NULL REFERENCES identity.organizations(id),
  email                     TEXT        NOT NULL CHECK (email <> '' AND email = lower(btrim(email))),
  display_name              TEXT        CHECK (display_name IS NULL OR display_name = btrim(display_name)),
  inviter_membership_id     UUID        NOT NULL,
  inviter_user_id           UUID        NOT NULL,
  inviter_name_snapshot     TEXT        NOT NULL,
  role_key                  TEXT        NOT NULL CHECK (role_key IN ('hotel_manager', 'front_desk', 'housekeeping', 'hotel_custom')),
  permission_overrides      JSONB       NOT NULL CHECK (jsonb_typeof(permission_overrides) = 'object'),
  property_access_mode      TEXT        NOT NULL CHECK (property_access_mode = 'assigned'),
  status                    TEXT        NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'accepted', 'expired', 'revoked')),
  configuration_revision    INTEGER     NOT NULL CHECK (configuration_revision > 0),
  command_id                TEXT        NOT NULL UNIQUE,
  idempotency_key_hash      BYTEA       NOT NULL UNIQUE CHECK (octet_length(idempotency_key_hash) = 32),
  request_fingerprint_hash  BYTEA       NOT NULL CHECK (octet_length(request_fingerprint_hash) = 32),
  provider_invitation_id    TEXT        UNIQUE,
  expires_at                TIMESTAMPTZ,
  supersedes_invitation_id  UUID        REFERENCES identity.staff_invitations(id),
  accepted_user_id          UUID,
  accepted_membership_id    UUID,
  request_id                TEXT        NOT NULL,
  correlation_id            TEXT,
  request_source            TEXT        NOT NULL CHECK (request_source IN ('web', 'admin', 'api', 'agent', 'migration')),
  reason                    TEXT        NOT NULL,
  requested_at              TIMESTAMPTZ NOT NULL,
  created_at                TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at                TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_staff_invitation_revision UNIQUE (organization_id, email, configuration_revision),
  CONSTRAINT fk_staff_invitation_inviter_scope
    FOREIGN KEY (inviter_membership_id, organization_id, inviter_user_id)
    REFERENCES identity.organization_memberships (id, organization_id, user_id),
  CONSTRAINT fk_staff_invitation_acceptance_scope
    FOREIGN KEY (accepted_membership_id, organization_id, accepted_user_id)
    REFERENCES identity.organization_memberships (id, organization_id, user_id),
  CONSTRAINT chk_staff_invitation_provider_binding CHECK (
    (provider_invitation_id IS NULL AND expires_at IS NULL)
    OR (provider_invitation_id IS NOT NULL AND expires_at IS NOT NULL)
  ),
  CONSTRAINT chk_staff_invitation_acceptance CHECK (
    (status = 'accepted' AND provider_invitation_id IS NOT NULL
      AND accepted_user_id IS NOT NULL AND accepted_membership_id IS NOT NULL)
    OR (status = 'expired' AND provider_invitation_id IS NOT NULL
      AND accepted_user_id IS NULL AND accepted_membership_id IS NULL)
    OR (status IN ('pending', 'revoked')
      AND accepted_user_id IS NULL AND accepted_membership_id IS NULL)
  )
);

CREATE UNIQUE INDEX uq_staff_invitations_pending_email
  ON identity.staff_invitations (organization_id, email)
  WHERE status = 'pending';

CREATE TABLE identity.staff_invitation_property_assignments (
  invitation_id UUID        NOT NULL REFERENCES identity.staff_invitations(id) ON DELETE CASCADE,
  property_id   UUID        NOT NULL REFERENCES hotel_catalog.properties(id),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (invitation_id, property_id)
);

CREATE FUNCTION identity.enforce_staff_invitation_property_scope()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM identity.staff_invitations invitation
    JOIN identity.organization_resource_links link
      ON link.organization_id = invitation.organization_id
    WHERE invitation.id = NEW.invitation_id
      AND link.product = 'hotel_catalog'
      AND link.resource_type = 'property'
      AND link.resource_id = NEW.property_id::text
      AND link.relationship IN ('owner', 'operator')
      AND link.status = 'active'
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23503',
      CONSTRAINT = 'fk_staff_invitation_property_assignment_canonical_scope',
      MESSAGE = 'staff invitation property assignment requires an active canonical organization property link';
  END IF;
  RETURN NEW;
END;
$$;

CREATE CONSTRAINT TRIGGER fk_staff_invitation_property_assignment_canonical_scope
AFTER INSERT OR UPDATE ON identity.staff_invitation_property_assignments
DEFERRABLE INITIALLY IMMEDIATE
FOR EACH ROW
EXECUTE FUNCTION identity.enforce_staff_invitation_property_scope();

