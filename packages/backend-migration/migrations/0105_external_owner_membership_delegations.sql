-- Migration: 0105_external_owner_membership_delegations
-- Owner: domain-identity (backend-auth, backend-authorization)
-- See: engineering/external-owner-delegation-contract.md, VAY-1321

-- Existing memberships predate delegation provenance and are agency-origin.
-- This compatibility default remains only until every membership writer is
-- explicit; delegation-aware runtime must follow a successor that drops it.
ALTER TABLE identity.organization_memberships
  ADD COLUMN access_origin TEXT NOT NULL DEFAULT 'agency'
    CONSTRAINT chk_organization_memberships_access_origin
    CHECK (access_origin IN ('agency', 'external_owner')),
  ADD CONSTRAINT chk_organization_memberships_origin_property_mode
    CHECK (access_origin <> 'external_owner' OR property_access_mode = 'assigned'),
  ADD CONSTRAINT chk_organization_memberships_external_owner_scope
    CHECK (
      role_key <> 'external_owner'
      OR (access_origin = 'agency' AND property_access_mode = 'assigned')
    ),
  ADD CONSTRAINT uq_organization_memberships_organization_id_id
    UNIQUE (organization_id, id);

CREATE TABLE identity.membership_delegations (
  organization_id          UUID        NOT NULL,
  subject_membership_id    UUID        PRIMARY KEY,
  delegator_membership_id  UUID        NOT NULL,
  created_by_membership_id UUID        NOT NULL,
  created_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT chk_membership_delegations_not_self
    CHECK (subject_membership_id <> delegator_membership_id),
  CONSTRAINT fk_membership_delegations_subject_scope
    FOREIGN KEY (organization_id, subject_membership_id)
    REFERENCES identity.organization_memberships (organization_id, id)
    ON DELETE CASCADE,
  CONSTRAINT fk_membership_delegations_delegator_scope
    FOREIGN KEY (organization_id, delegator_membership_id)
    REFERENCES identity.organization_memberships (organization_id, id)
    ON DELETE RESTRICT
);

CREATE INDEX idx_membership_delegations_organization_delegator
  ON identity.membership_delegations (organization_id, delegator_membership_id);

-- The creator ID is durable audit provenance, not a live authorization
-- dependency. Validate it on writes but let it survive membership removal.
-- Lock all participants in UUID order so concurrent inverse edges serialize.
CREATE FUNCTION identity.enforce_membership_delegation_write()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  replaced_subject UUID;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    replaced_subject := OLD.subject_membership_id;
    NEW.updated_at := now();
  END IF;

  PERFORM 1
  FROM identity.organization_memberships
  WHERE id IN (
    NEW.subject_membership_id,
    NEW.delegator_membership_id,
    NEW.created_by_membership_id
  )
  ORDER BY id
  FOR NO KEY UPDATE;

  IF (
    TG_OP = 'INSERT'
    OR NEW.organization_id IS DISTINCT FROM OLD.organization_id
    OR NEW.created_by_membership_id IS DISTINCT FROM OLD.created_by_membership_id
  ) AND NOT EXISTS (
      SELECT 1
      FROM identity.organization_memberships creator
      WHERE creator.id = NEW.created_by_membership_id
        AND creator.organization_id = NEW.organization_id
    )
  THEN
    RAISE EXCEPTION USING
      ERRCODE = '23503',
      CONSTRAINT = 'fk_membership_delegations_creator_scope',
      MESSAGE = 'delegation creator must belong to the same organization';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM identity.membership_delegations existing
    WHERE (replaced_subject IS NULL OR existing.subject_membership_id <> replaced_subject)
      AND (
        existing.subject_membership_id = NEW.delegator_membership_id
        OR existing.delegator_membership_id = NEW.subject_membership_id
      )
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      CONSTRAINT = 'chk_membership_delegations_single_level',
      MESSAGE = 'membership delegation chains and cycles are not allowed';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER chk_membership_delegations_write
BEFORE INSERT OR UPDATE ON identity.membership_delegations
FOR EACH ROW
EXECUTE FUNCTION identity.enforce_membership_delegation_write();

-- The edge and membership-origin change may be written in either order inside
-- one transaction. Validate their final committed shape, not an intermediate.
CREATE FUNCTION identity.assert_membership_delegation_integrity(membership_id UUID)
RETURNS void
LANGUAGE plpgsql
AS $$
DECLARE
  membership identity.organization_memberships%ROWTYPE;
  subject_edges INTEGER;
  delegates BOOLEAN;
BEGIN
  SELECT * INTO membership
  FROM identity.organization_memberships
  WHERE id = membership_id;

  IF NOT FOUND THEN
    RETURN;
  END IF;

  SELECT count(*)::integer INTO subject_edges
  FROM identity.membership_delegations
  WHERE subject_membership_id = membership.id;

  IF membership.access_origin = 'external_owner' THEN
    IF subject_edges <> 1 THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        CONSTRAINT = 'chk_membership_delegations_subject_origin',
        MESSAGE = 'external-owner-origin staff require exactly one delegation';
    END IF;
    IF membership.role_key NOT IN (
      'hotel_manager',
      'front_desk',
      'housekeeping',
      'hotel_custom'
    ) THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        CONSTRAINT = 'chk_membership_delegations_subject_origin',
        MESSAGE = 'external-owner-origin subjects require a delegated staff role';
    END IF;
  ELSIF subject_edges <> 0 THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      CONSTRAINT = 'chk_membership_delegations_subject_origin',
      MESSAGE = 'agency-origin memberships cannot have a delegation';
  END IF;

  SELECT EXISTS (
    SELECT 1
    FROM identity.membership_delegations
    WHERE delegator_membership_id = membership.id
  ) INTO delegates;

  IF delegates AND (
    membership.role_key <> 'external_owner'
    OR membership.access_origin <> 'agency'
    OR membership.property_access_mode <> 'assigned'
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      CONSTRAINT = 'chk_membership_delegations_delegator_role',
      MESSAGE = 'delegators must be assigned external-owner memberships';
  END IF;
END;
$$;

CREATE FUNCTION identity.enforce_membership_delegation_from_membership()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  PERFORM identity.assert_membership_delegation_integrity(
    CASE WHEN TG_OP = 'DELETE' THEN OLD.id ELSE NEW.id END
  );
  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER chk_organization_membership_delegation_integrity
AFTER INSERT OR UPDATE OR DELETE ON identity.organization_memberships
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
EXECUTE FUNCTION identity.enforce_membership_delegation_from_membership();

CREATE FUNCTION identity.enforce_membership_delegation_from_edge()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP <> 'INSERT' THEN
    PERFORM identity.assert_membership_delegation_integrity(OLD.subject_membership_id);
    PERFORM identity.assert_membership_delegation_integrity(OLD.delegator_membership_id);
  END IF;
  IF TG_OP <> 'DELETE' THEN
    PERFORM identity.assert_membership_delegation_integrity(NEW.subject_membership_id);
    PERFORM identity.assert_membership_delegation_integrity(NEW.delegator_membership_id);
  END IF;
  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER chk_membership_delegation_integrity
AFTER INSERT OR UPDATE OR DELETE ON identity.membership_delegations
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
EXECUTE FUNCTION identity.enforce_membership_delegation_from_edge();
