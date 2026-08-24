import pg from "pg";

import type {
  EntitlementStatus,
  LinkedResource,
  OrganizationKind,
  PermissionKey,
  ResourceRelationship,
  ProductEntitlement,
  RequestContext,
  ResourceType,
  Product,
} from "@vayada/backend-auth";

export type RolePermissionRepository = {
  findPermissionsForRole(
    organizationKind: OrganizationKind,
    roleKey: string,
  ): Promise<PermissionKey[]>;
  close?(): Promise<void>;
};

export type EntitlementRepository = {
  findEntitlementsForContext(context: RequestContext): Promise<ProductEntitlement[]>;
  close?(): Promise<void>;
};

export type AuthorizationResolution = {
  permissions: PermissionKey[];
  entitlements?: ProductEntitlement[];
};

export type AuthorizationResolver = (context: RequestContext) => Promise<AuthorizationResolution>;

export type AuthorizationRepositoryConfig = {
  connectionString: string;
  max?: number;
};

export type MembershipPropertyScope = {
  mode: string;
  roleKey: string;
  accessOrigin: string;
  assignedPropertyIds: readonly string[];
};

export type PropertyAccessRepository = {
  findMembershipPropertyScope(context: RequestContext): Promise<MembershipPropertyScope | null>;
  close?(): Promise<void>;
};

export type EffectivePropertyAccess = {
  mode: "all" | "assigned";
  propertyIds: readonly string[];
};

export type TargetPropertyResource =
  | { product: "booking"; resourceType: "booking_hotel" }
  | { product: "pms"; resourceType: "pms_property" };

export type PropertyAccessRequirement = {
  propertyId: string;
  targetResource: TargetPropertyResource;
};

export type ResourceRequirement = {
  product: Product;
  resourceType: ResourceType;
  resourceId: string;
  allowedRelationships: readonly ResourceRelationship[];
};

export type ResourceAccessRequirement = {
  permission: PermissionKey;
  resource: ResourceRequirement;
};

export type EntitlementRequirement = {
  product: Product;
  key: string;
  resource?: Pick<LinkedResource, "product" | "resourceType" | "resourceId">;
};

type ProductEntitlementRow = {
  product: Product;
  entitlement_key: string;
  status: EntitlementStatus;
  resource_product: Product | null;
  resource_type: ResourceType | null;
  resource_id: string | null;
};

type MembershipPropertyScopeRow = {
  property_access_mode: string;
  role_key: string;
  access_origin: string;
  assigned_property_ids: string[];
};

function resourceScopeKey(
  product: Product,
  resourceType: ResourceType,
  resourceId: string,
): string {
  return `${product}:${resourceType}:${resourceId}`;
}

function canonicalEntitlementKey(product: Product, key: string): string {
  if (product === "booking" && key === "account_access") return "booking-engine";
  if (product === "pms" && (key === "account_access" || key === "pms-core")) {
    return "property-management";
  }
  if (product === "marketplace" && key === "account_access") {
    return "marketplace-hotel-profile";
  }
  return key;
}

export class AuthorizationError extends Error {
  readonly statusCode = 403;

  constructor(message = "The authenticated user is not authorized for this resource.") {
    super(message);
    this.name = "AuthorizationError";
  }
}

export function createPgRolePermissionRepository(
  config: AuthorizationRepositoryConfig,
): RolePermissionRepository {
  if (!config.connectionString.trim()) {
    throw new Error("AuthorizationRepositoryConfig.connectionString must not be empty");
  }

  const pool = new pg.Pool({
    connectionString: config.connectionString,
    max: config.max,
  });

  return {
    async findPermissionsForRole(organizationKind, roleKey) {
      const result = await pool.query<{ permission_key: PermissionKey }>(
        `SELECT permission_key
         FROM identity.role_permission_grants
         WHERE organization_kind = $1 AND role_key = $2
         ORDER BY permission_key`,
        [organizationKind, roleKey],
      );
      return result.rows.map((row) => row.permission_key);
    },
    async close() {
      await pool.end();
    },
  };
}

export function createPgEntitlementRepository(
  config: AuthorizationRepositoryConfig,
): EntitlementRepository {
  if (!config.connectionString.trim()) {
    throw new Error("AuthorizationRepositoryConfig.connectionString must not be empty");
  }

  const pool = new pg.Pool({
    connectionString: config.connectionString,
    max: config.max,
  });

  return {
    async findEntitlementsForContext(context) {
      const result = await pool.query<ProductEntitlementRow>(
        `SELECT
           product,
           entitlement_key,
           CASE
             WHEN expires_at IS NOT NULL AND expires_at <= now()
               THEN 'expired'
             ELSE status
           END AS status,
           resource_product,
           resource_type,
           resource_id
         FROM identity.product_entitlements
         WHERE organization_id = $1
           AND (starts_at IS NULL OR starts_at <= now())
         ORDER BY product, entitlement_key, resource_product NULLS FIRST, resource_type NULLS FIRST, resource_id NULLS FIRST`,
        [context.selectedOrganization.organizationId],
      );

      const activeLinkedResourceKeys = new Set(
        context.linkedResources
          .filter((resource) => resource.status === "active")
          .map((resource) =>
            resourceScopeKey(resource.product, resource.resourceType, resource.resourceId),
          ),
      );

      return result.rows
        .filter(
          (row) =>
            row.resource_product === null ||
            row.status === "suspended" ||
            (row.resource_type !== null &&
              row.resource_id !== null &&
              activeLinkedResourceKeys.has(
                resourceScopeKey(row.resource_product, row.resource_type, row.resource_id),
              )),
        )
        .map((row): ProductEntitlement => {
          if (row.resource_product === null) {
            return {
              product: row.product,
              key: canonicalEntitlementKey(row.product, row.entitlement_key),
              status: row.status,
            };
          }

          return {
            product: row.product,
            key: canonicalEntitlementKey(row.product, row.entitlement_key),
            status: row.status,
            resource: {
              product: row.resource_product,
              resourceType: row.resource_type!,
              resourceId: row.resource_id!,
            },
          };
        });
    },
    async close() {
      await pool.end();
    },
  };
}

export function createPgPropertyAccessRepository(
  config: AuthorizationRepositoryConfig,
): PropertyAccessRepository {
  if (!config.connectionString.trim()) {
    throw new Error("AuthorizationRepositoryConfig.connectionString must not be empty");
  }

  const pool = new pg.Pool({ connectionString: config.connectionString, max: config.max });

  return {
    async findMembershipPropertyScope(context) {
      const result = await pool.query<MembershipPropertyScopeRow>(
        `SELECT
           membership.property_access_mode,
           membership.role_key,
           membership.access_origin,
           ARRAY(
             SELECT assignment.property_id::text
             FROM identity.membership_property_assignments assignment
             WHERE assignment.membership_id = membership.id
             ORDER BY assignment.property_id
           ) AS assigned_property_ids
         FROM identity.organization_memberships membership
         JOIN identity.organizations organization
           ON organization.id = membership.organization_id
         WHERE membership.id = $1
           AND membership.user_id = $2
           AND membership.organization_id = $3
           AND membership.status = 'active'
           AND organization.status = 'active'
           AND organization.kind = 'hotel_group'
         LIMIT 1`,
        [
          context.membership.membershipId,
          context.actor.internalUserId,
          context.selectedOrganization.organizationId,
        ],
      );
      const row = result.rows[0];
      return row
        ? {
            mode: row.property_access_mode,
            roleKey: row.role_key,
            accessOrigin: row.access_origin,
            assignedPropertyIds: row.assigned_property_ids,
          }
        : null;
    },
    async close() {
      await pool.end();
    },
  };
}

export function createAuthorizationResolver(
  rolePermissionRepository: RolePermissionRepository,
  entitlementRepository: EntitlementRepository | undefined,
  propertyAccessRepository: PropertyAccessRepository | undefined,
): AuthorizationResolver {
  return async (context) => {
    if (context.selectedOrganization.kind === "hotel_group") {
      const scope = await propertyAccessRepository?.findMembershipPropertyScope(context);
      if (!isAgencyMembershipScope(context, scope)) {
        return { permissions: [], entitlements: [] };
      }
    }

    const [permissions, entitlements] = await Promise.all([
      rolePermissionRepository.findPermissionsForRole(
        context.selectedOrganization.kind,
        context.membership.roleKey,
      ),
      entitlementRepository?.findEntitlementsForContext(context),
    ]);

    return {
      permissions,
      entitlements,
    };
  };
}

function isAgencyMembershipScope(
  context: RequestContext,
  scope: MembershipPropertyScope | null | undefined,
): scope is MembershipPropertyScope & { mode: "all" | "assigned" } {
  return (
    scope != null &&
    scope.roleKey === context.membership.roleKey &&
    scope.accessOrigin === "agency" &&
    (scope.mode === "all" || scope.mode === "assigned") &&
    (scope.roleKey !== "external_owner" || scope.mode === "assigned")
  );
}

export function hasPermission(context: RequestContext, permission: PermissionKey): boolean {
  return context.membership.permissions.includes(permission);
}

export function hasActiveLinkedResource(
  context: RequestContext,
  requirement: ResourceRequirement,
): boolean {
  return context.linkedResources.some(
    (resource) =>
      resource.status === "active" &&
      resource.product === requirement.product &&
      resource.resourceType === requirement.resourceType &&
      resource.resourceId === requirement.resourceId &&
      requirement.allowedRelationships.includes(resource.relationship),
  );
}

export async function resolveEffectivePropertyAccess(
  context: RequestContext,
  repository: PropertyAccessRepository,
): Promise<EffectivePropertyAccess | null> {
  if (
    context.actor.status !== "active" ||
    context.selectedOrganization.status !== "active" ||
    context.selectedOrganization.kind !== "hotel_group" ||
    context.membership.status !== "active"
  ) {
    return null;
  }

  const scope = await repository.findMembershipPropertyScope(context);
  if (!isAgencyMembershipScope(context, scope)) return null;
  if (
    !Array.isArray(scope.assignedPropertyIds) ||
    scope.assignedPropertyIds.some((propertyId) => typeof propertyId !== "string")
  ) {
    return null;
  }

  const canonicalPropertyIds = new Set(
    context.linkedResources
      .filter(
        (resource) =>
          resource.status === "active" &&
          resource.product === "hotel_catalog" &&
          resource.resourceType === "property" &&
          (resource.relationship === "owner" || resource.relationship === "operator"),
      )
      .map((resource) => resource.resourceId),
  );

  const propertyIds =
    scope.mode === "all"
      ? [...canonicalPropertyIds]
      : scope.assignedPropertyIds.filter((propertyId) => canonicalPropertyIds.has(propertyId));

  return { mode: scope.mode, propertyIds: [...new Set(propertyIds)].sort() };
}

export function canAccessResource(
  context: RequestContext,
  requirement: ResourceAccessRequirement,
): boolean {
  return (
    hasPermission(context, requirement.permission) &&
    hasActiveLinkedResource(context, requirement.resource)
  );
}

export function hasActiveEntitlement(
  context: RequestContext,
  requirement: EntitlementRequirement,
): boolean {
  const requiredKey = canonicalEntitlementKey(requirement.product, requirement.key);
  if (
    context.entitlements.some(
      (entitlement) =>
        entitlement.status === "suspended" &&
        entitlement.product === requirement.product &&
        canonicalEntitlementKey(entitlement.product, entitlement.key) === requiredKey &&
        (entitlement.resource === undefined ||
          (requirement.resource !== undefined &&
            entitlement.resource.product === requirement.resource.product &&
            entitlement.resource.resourceType === requirement.resource.resourceType &&
            entitlement.resource.resourceId === requirement.resource.resourceId)),
    )
  ) {
    return false;
  }

  return context.entitlements.some((entitlement) => {
    if (
      entitlement.status !== "active" ||
      entitlement.product !== requirement.product ||
      canonicalEntitlementKey(entitlement.product, entitlement.key) !== requiredKey
    ) {
      return false;
    }

    if (!requirement.resource) {
      return entitlement.resource === undefined;
    }

    return (
      entitlement.resource === undefined ||
      (entitlement.resource.product === requirement.resource.product &&
        entitlement.resource.resourceType === requirement.resource.resourceType &&
        entitlement.resource.resourceId === requirement.resource.resourceId)
    );
  });
}

export function requirePermission(
  context: RequestContext,
  permission: PermissionKey,
): RequestContext {
  if (!hasPermission(context, permission)) {
    throw new AuthorizationError(`Missing required permission: ${permission}`);
  }
  return context;
}

export function requireActiveEntitlement(
  context: RequestContext,
  requirement: EntitlementRequirement,
): RequestContext {
  if (!hasActiveEntitlement(context, requirement)) {
    const resource = requirement.resource
      ? ` for ${requirement.resource.product}:${requirement.resource.resourceType}:${requirement.resource.resourceId}`
      : "";
    throw new AuthorizationError(
      `Missing active entitlement: ${requirement.product}:${requirement.key}${resource}`,
    );
  }
  return context;
}

export function requireResourceAccess(
  context: RequestContext,
  requirement: ResourceAccessRequirement,
): RequestContext {
  if (!canAccessResource(context, requirement)) {
    throw new AuthorizationError(
      `Missing ${requirement.permission} access to ${requirement.resource.product}:${requirement.resource.resourceType}:${requirement.resource.resourceId}`,
    );
  }
  return context;
}

export async function requirePropertyAccess(
  context: RequestContext,
  repository: PropertyAccessRepository,
  requirement: PropertyAccessRequirement,
): Promise<RequestContext> {
  const access = await resolveEffectivePropertyAccess(context, repository);
  const hasTargetResource = hasActiveLinkedResource(context, {
    ...requirement.targetResource,
    resourceId: requirement.propertyId,
    allowedRelationships: ["owner", "operator"],
  });
  if (!access?.propertyIds.includes(requirement.propertyId) || !hasTargetResource) {
    throw new AuthorizationError();
  }
  return context;
}
