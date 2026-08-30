-- Migration: 0124_repair_hotel_member_roles
-- Owner: domain-identity; see engineering/staff-access-authorization-contract.md, VAY-1085
-- Serialize with identity writers so the safety inventory and repair observe
-- one stable set of rows until the migration transaction commits. Organization
-- comes first to match identity provisioning, followed by membership commands.
LOCK TABLE
  identity.organizations,
  identity.organization_memberships,
  identity.membership_property_assignments,
  identity.staff_invitations,
  identity.membership_delegations,
  identity.role_permission_grants
IN EXCLUSIVE MODE;
DO $$
DECLARE
  repair_cutoff CONSTANT TIMESTAMPTZ := TIMESTAMPTZ '2026-08-30 02:24:05+00';
  invalid_mode_count BIGINT;
  invalid_origin_count BIGINT;
  override_count BIGINT;
  assignment_count BIGINT;
  invitation_count BIGINT;
  delegation_count BIGINT;
  post_cutoff_count BIGINT;
  source_role_grant_count BIGINT;
  unexpected_custom_grant_count BIGINT;
  custom_manifest_grant_count BIGINT;
BEGIN
  SELECT
    count(*) FILTER (WHERE membership.property_access_mode <> 'assigned'),
    count(*) FILTER (WHERE membership.access_origin <> 'agency'),
    count(*) FILTER (WHERE membership.permission_overrides IS NOT NULL),
    count(*) FILTER (WHERE EXISTS (
      SELECT 1
      FROM identity.membership_property_assignments assignment
      WHERE assignment.membership_id = membership.id
    )),
    count(*) FILTER (WHERE membership.invited_at IS NOT NULL OR EXISTS (
      SELECT 1
      FROM identity.staff_invitations invitation
      WHERE invitation.organization_id = membership.organization_id
        AND (invitation.accepted_membership_id = membership.id OR invitation.status = 'pending')
    )),
    count(*) FILTER (WHERE EXISTS (
      SELECT 1
      FROM identity.membership_delegations delegation
      WHERE delegation.subject_membership_id = membership.id
         OR delegation.delegator_membership_id = membership.id
    )),
    count(*) FILTER (WHERE membership.created_at >= repair_cutoff)
  INTO
    invalid_mode_count,
    invalid_origin_count,
    override_count,
    assignment_count,
    invitation_count,
    delegation_count,
    post_cutoff_count
  FROM identity.organization_memberships membership
  JOIN identity.organizations organization
    ON organization.id = membership.organization_id
  WHERE organization.kind = 'hotel_group'
    AND membership.role_key = 'hotel_member';
  SELECT
    count(*) FILTER (WHERE role_key = 'hotel_member'),
    count(*) FILTER (WHERE role_key = 'hotel_custom'
      AND permission_key <> 'hotel_catalog.property_manifest.read'),
    count(*) FILTER (WHERE role_key = 'hotel_custom'
      AND permission_key = 'hotel_catalog.property_manifest.read')
  INTO source_role_grant_count, unexpected_custom_grant_count, custom_manifest_grant_count
  FROM identity.role_permission_grants
  WHERE organization_kind = 'hotel_group'
    AND role_key IN ('hotel_member', 'hotel_custom');
  IF invalid_mode_count > 0
    OR invalid_origin_count > 0
    OR override_count > 0
    OR assignment_count > 0
    OR invitation_count > 0
    OR delegation_count > 0
    OR post_cutoff_count > 0
    OR source_role_grant_count > 0
    OR unexpected_custom_grant_count > 0
    OR custom_manifest_grant_count <> 1
  THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      CONSTRAINT = 'chk_hotel_member_role_repair_safety',
      MESSAGE = format(
        'hotel_member role repair blocked: mode=%s origin=%s overrides=%s assignments=%s invitations=%s delegations=%s post_cutoff=%s source_role_grants=%s unexpected_custom_grants=%s custom_manifest_grants=%s',
        invalid_mode_count,
        invalid_origin_count,
        override_count,
        assignment_count,
        invitation_count,
        delegation_count,
        post_cutoff_count,
        source_role_grant_count,
        unexpected_custom_grant_count,
        custom_manifest_grant_count
      ),
      HINT = 'Review anomalous memberships through the audited identity lifecycle, then rerun the migration.';
  END IF;
  -- PR #1235 maps new coarse WorkOS hotel members to this fail-closed internal
  -- role. Later rows are outside this conservative repair cohort and need review.
  UPDATE identity.organization_memberships membership
  SET role_key = 'hotel_custom',
      updated_at = now()
  FROM identity.organizations organization
  WHERE organization.id = membership.organization_id
    AND organization.kind = 'hotel_group'
    AND membership.role_key = 'hotel_member'
    AND membership.created_at < repair_cutoff;
END;
$$;
