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

export function createAuthorizationResolver(
  rolePermissionRepository: RolePermissionRepository,
  entitlementRepository?: EntitlementRepository,
): AuthorizationResolver {
  return async (context) => {
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
        canonicalEntitlementKey(entitlement.product, entitlement.key) === requiredKey,
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
