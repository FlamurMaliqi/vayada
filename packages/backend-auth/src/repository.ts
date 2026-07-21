import pg from "pg";

import type {
  InternalUserStatus,
  MembershipStatus,
  OrganizationKind,
  OrganizationStatus,
} from "./types.js";

export type IdentityUser = {
  userId: string;
  email: string;
  name?: string | null;
  phone?: string | null;
  profilePictureUrl?: string | null;
  profilePictureMediaObjectId?: string | null;
  status: InternalUserStatus;
};

export type IdentityOrganization = {
  organizationId: string;
  workosOrgId: string | null;
  name?: string;
  kind: OrganizationKind;
  status: OrganizationStatus;
};

export type IdentityMembership = {
  membershipId: string;
  status: MembershipStatus;
  roleKey: string;
  workosMembershipId: string | null;
  workosRoleSlugs: string[];
};

export type IdentityResourceLink = {
  product: string;
  resourceType: string;
  resourceId: string;
  relationship: string;
  status: string;
};

export type IdentityMembershipOrganization = IdentityOrganization & {
  name: string;
  membership: IdentityMembership;
};

/** Read-only identity queries needed to resolve a RequestContext. */
export interface IdentityRepository {
  findUserByProviderUserId(provider: string, providerUserId: string): Promise<IdentityUser | null>;

  findOrganizationByWorkosOrgId(workosOrgId: string): Promise<IdentityOrganization | null>;

  findActiveMembership(userId: string, organizationId: string): Promise<IdentityMembership | null>;

  listMembershipOrganizations?(userId: string): Promise<IdentityMembershipOrganization[]>;

  findLinkedResources(organizationId: string): Promise<IdentityResourceLink[]>;
}

export type RepositoryConfig = {
  connectionString: string;
  /** Maximum number of connections in the pool. Defaults to pg's default (10). */
  max?: number;
};

/**
 * Creates a Postgres-backed IdentityRepository that manages its own connection
 * pool internally. Accepts a connection string rather than a pre-built pool so
 * callers do not need to create and manage a separate pool alongside any other
 * database clients used by apps/api.
 */
export function createPgIdentityRepository(config: RepositoryConfig): IdentityRepository {
  if (!config.connectionString.trim()) {
    throw new Error("RepositoryConfig.connectionString must not be empty");
  }

  const pool = new pg.Pool({
    connectionString: config.connectionString,
    max: config.max,
  });

  return {
    async findUserByProviderUserId(provider, providerUserId) {
      const result = await pool.query<{
        user_id: string;
        email: string;
        name: string | null;
        phone: string | null;
        profile_picture_url: string | null;
        profile_picture_media_object_id: string | null;
        status: InternalUserStatus;
      }>(
        `SELECT u.id AS user_id, u.email, u.name, u.phone,
                u.profile_picture_url, u.profile_picture_media_object_id, u.status
         FROM identity.external_identities ei
         JOIN identity.users u ON u.id = ei.user_id
         WHERE ei.provider = $1 AND ei.provider_user_id = $2
         LIMIT 1`,
        [provider, providerUserId],
      );
      const row = result.rows[0];
      if (!row) return null;
      return {
        userId: row.user_id,
        email: row.email,
        name: row.name,
        phone: row.phone,
        profilePictureUrl: row.profile_picture_url,
        profilePictureMediaObjectId: row.profile_picture_media_object_id,
        status: row.status,
      };
    },

    async findOrganizationByWorkosOrgId(workosOrgId) {
      const result = await pool.query<{
        id: string;
        name: string;
        workos_org_id: string | null;
        kind: OrganizationKind;
        status: OrganizationStatus;
      }>(
        `SELECT id, name, workos_org_id, kind, status
         FROM identity.organizations
         WHERE workos_org_id = $1
         LIMIT 1`,
        [workosOrgId],
      );
      const row = result.rows[0];
      if (!row) return null;
      return {
        organizationId: row.id,
        workosOrgId: row.workos_org_id,
        name: row.name,
        kind: row.kind,
        status: row.status,
      };
    },

    async findActiveMembership(userId, organizationId) {
      const result = await pool.query<{
        id: string;
        status: MembershipStatus;
        role_key: string;
        workos_membership_id: string | null;
        workos_role_slugs: string[];
      }>(
        `SELECT id, status, role_key, workos_membership_id, workos_role_slugs
         FROM identity.organization_memberships
         WHERE user_id = $1 AND organization_id = $2
         LIMIT 1`,
        [userId, organizationId],
      );
      const row = result.rows[0];
      if (!row) return null;
      return {
        membershipId: row.id,
        status: row.status,
        roleKey: row.role_key,
        workosMembershipId: row.workos_membership_id,
        workosRoleSlugs: row.workos_role_slugs,
      };
    },

    async listMembershipOrganizations(userId) {
      const result = await pool.query<{
        organization_id: string;
        organization_name: string;
        workos_org_id: string | null;
        organization_kind: OrganizationKind;
        organization_status: OrganizationStatus;
        membership_id: string;
        membership_status: MembershipStatus;
        role_key: string;
        workos_membership_id: string | null;
        workos_role_slugs: string[];
      }>(
        `SELECT
           o.id AS organization_id,
           o.name AS organization_name,
           o.workos_org_id,
           o.kind AS organization_kind,
           o.status AS organization_status,
           om.id AS membership_id,
           om.status AS membership_status,
           om.role_key,
           om.workos_membership_id,
           om.workos_role_slugs
         FROM identity.organization_memberships om
         JOIN identity.organizations o ON o.id = om.organization_id
         WHERE om.user_id = $1
         ORDER BY o.name ASC`,
        [userId],
      );

      return result.rows.map((row) => ({
        organizationId: row.organization_id,
        workosOrgId: row.workos_org_id,
        name: row.organization_name,
        kind: row.organization_kind,
        status: row.organization_status,
        membership: {
          membershipId: row.membership_id,
          status: row.membership_status,
          roleKey: row.role_key,
          workosMembershipId: row.workos_membership_id,
          workosRoleSlugs: row.workos_role_slugs,
        },
      }));
    },

    async findLinkedResources(organizationId) {
      const result = await pool.query<{
        product: string;
        resource_type: string;
        resource_id: string;
        relationship: string;
        status: string;
      }>(
        `SELECT product, resource_type, resource_id, relationship, status
         FROM identity.organization_resource_links
         WHERE organization_id = $1 AND status = 'active'`,
        [organizationId],
      );
      return result.rows.map((row) => ({
        product: row.product,
        resourceType: row.resource_type,
        resourceId: row.resource_id,
        relationship: row.relationship,
        status: row.status,
      }));
    },
  };
}
