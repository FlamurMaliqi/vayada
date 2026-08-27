import { describe, expect, it, vi } from "vitest";
import pg from "pg";

import type {
  ProductEntitlement,
  LinkedResource,
  OrganizationKind,
  PermissionKey,
  Product,
  ResourceRelationship,
  RequestContext,
  ResourceType,
} from "@vayada/backend-auth";

import {
  AuthorizationError,
  canAccessResource,
  createAuthorizationResolver,
  createPgEntitlementRepository,
  createPgPropertyAccessRepository,
  hasPermission,
  hasActiveEntitlement,
  requirePropertyAccess,
  requirePermission,
  requireActiveEntitlement,
  requireResourceAccess,
  resolveEffectivePropertyAccess,
  createPgRolePermissionRepository,
  type EntitlementRepository,
  type EntitlementRequirement,
  type MembershipPropertyScope,
  type PropertyAccessRepository,
  type ResourceAccessRequirement,
  type RolePermissionRepository,
} from "./index.js";

const TEST_DATABASE_URL = process.env["TEST_DATABASE_URL"];

function assertSafeTestDatabase(url: string): void {
  const dbName = new URL(url).pathname.replace(/^\//, "");
  if (!/(^|[_-])test([_-]|$)/i.test(dbName)) {
    throw new Error(`Refusing to use non-test database "${dbName}"`);
  }
}

async function resetRolePermissionGrantsTable(client: pg.Client): Promise<void> {
  await client.query(`CREATE SCHEMA IF NOT EXISTS identity`);
  await client.query(`
    CREATE TABLE IF NOT EXISTS identity.role_permission_grants (
      organization_kind TEXT NOT NULL,
      role_key TEXT NOT NULL,
      permission_key TEXT NOT NULL
    )
  `);
  await client.query(`TRUNCATE TABLE identity.role_permission_grants RESTART IDENTITY CASCADE`);
}

async function resetProductEntitlementsTable(client: pg.Client): Promise<void> {
  await client.query(`CREATE SCHEMA IF NOT EXISTS identity`);
  await client.query(`
    CREATE TABLE IF NOT EXISTS identity.product_entitlements (
      organization_id UUID NOT NULL,
      product TEXT NOT NULL,
      entitlement_key TEXT NOT NULL,
      status TEXT NOT NULL,
      resource_product TEXT,
      resource_type TEXT,
      resource_id TEXT,
      starts_at TIMESTAMPTZ,
      expires_at TIMESTAMPTZ
    )
  `);
  await client.query(`TRUNCATE TABLE identity.product_entitlements RESTART IDENTITY CASCADE`);
}

function linkedResource(
  product: Product,
  resourceType: ResourceType,
  resourceId: string,
): LinkedResource {
  return {
    product,
    resourceType,
    resourceId,
    relationship: product === "platform" ? "operator" : "owner",
    status: "active",
  };
}

function contextFor(
  options: {
    kind?: OrganizationKind;
    roleKey?: string;
    permissions?: PermissionKey[];
    linkedResources?: LinkedResource[];
    entitlements?: ProductEntitlement[];
  } = {},
): RequestContext {
  const kind = options.kind ?? "hotel_group";
  const roleKey = options.roleKey ?? "hotel_owner";

  return {
    actor: {
      internalUserId: "user_test",
      providerIdentity: { provider: "workos", providerUserId: "user_workos_test" },
      email: "user@example.com",
      status: "active",
    },
    selectedOrganization: {
      organizationId: "org_test",
      workosOrgId: "org_workos_test",
      kind,
      status: "active",
    },
    membership: {
      membershipId: "membership_test",
      status: "active",
      roleKey,
      workosMembershipId: "om_test",
      workosRoleSlugs: [roleKey],
      permissions: options.permissions ?? [],
    },
    linkedResources: options.linkedResources ?? [],
    entitlements: options.entitlements ?? [],
    locale: "en-US",
    currency: "EUR",
    audit: {
      requestId: "req_test",
      source: "api",
      receivedAt: "2026-06-04T12:00:00.000Z",
    },
  };
}

function entitlement(
  status: ProductEntitlement["status"],
  resource?: ProductEntitlement["resource"],
): ProductEntitlement {
  return {
    product: "booking",
    key: "booking-engine",
    status,
    resource,
  };
}

const hotelContext = contextFor({
  kind: "hotel_group",
  roleKey: "hotel_owner",
  permissions: ["booking.settings.manage"],
  linkedResources: [linkedResource("booking", "booking_hotel", "booking_hotel_alpenrose")],
});

const creatorContext = contextFor({
  kind: "creator_workspace",
  roleKey: "creator_owner",
  permissions: ["marketplace.profile.manage"],
  linkedResources: [linkedResource("marketplace", "creator_profile", "creator_profile_lina")],
});

const affiliateContext = contextFor({
  kind: "affiliate_partner",
  roleKey: "affiliate_owner",
  permissions: ["affiliate.payout.manage"],
  linkedResources: [linkedResource("affiliate", "affiliate", "affiliate_partner_bali")],
});

const platformContext = contextFor({
  kind: "platform",
  roleKey: "platform_admin",
  permissions: ["platform.user.suspend"],
  linkedResources: [linkedResource("platform", "platform", "vayada")],
});

const PROPERTY_A = "10000000-0000-4000-8000-000000000001";
const PROPERTY_B = "10000000-0000-4000-8000-000000000002";
const PROPERTY_OTHER_TENANT = "20000000-0000-4000-8000-000000000001";
const DB_USER = "81000000-0000-4000-8000-000000000001";
const DB_ORGANIZATION = "82000000-0000-4000-8000-000000000001";
const DB_MEMBERSHIP = "83000000-0000-4000-8000-000000000001";
const DB_PROPERTY = "84000000-0000-4000-8000-000000000001";

function propertyContext(): RequestContext {
  return contextFor({
    permissions: ["pms.operations.read"],
    linkedResources: [
      linkedResource("hotel_catalog", "property", PROPERTY_A),
      linkedResource("hotel_catalog", "property", PROPERTY_B),
      linkedResource("booking", "booking_hotel", PROPERTY_A),
      linkedResource("pms", "pms_property", PROPERTY_A),
    ],
  });
}

function propertyScopeRepository(scope: MembershipPropertyScope | null): PropertyAccessRepository {
  return { findMembershipPropertyScope: async () => scope };
}

function propertyScope(overrides: Partial<MembershipPropertyScope> = {}): MembershipPropertyScope {
  return {
    mode: "assigned",
    roleKey: "hotel_owner",
    accessOrigin: "agency",
    assignedPropertyIds: [],
    ...overrides,
  };
}

function requirement(
  permission: PermissionKey,
  product: Product,
  resourceType: ResourceType,
  resourceId: string,
  allowedRelationships: readonly ResourceRelationship[] = ["owner"],
): ResourceAccessRequirement {
  return {
    permission,
    resource: { product, resourceType, resourceId, allowedRelationships },
  };
}

describe("createAuthorizationResolver", () => {
  it("loads permissions for the selected organization kind and role", async () => {
    const calls: Array<{ kind: OrganizationKind; roleKey: string }> = [];
    const repository: RolePermissionRepository = {
      async findPermissionsForRole(kind, roleKey) {
        calls.push({ kind, roleKey });
        return ["booking.settings.manage", "pms.booking.update"];
      },
    };

    const resolution = await createAuthorizationResolver(
      repository,
      undefined,
      propertyScopeRepository(propertyScope({ mode: "all" })),
    )(hotelContext);

    expect(calls).toEqual([{ kind: "hotel_group", roleKey: "hotel_owner" }]);
    expect(resolution.permissions).toEqual(["booking.settings.manage", "pms.booking.update"]);
  });

  it("loads entitlements separately from permissions when a repository is provided", async () => {
    const roleRepository: RolePermissionRepository = {
      async findPermissionsForRole() {
        return ["booking.settings.manage"];
      },
    };
    const entitlementRepository: EntitlementRepository = {
      async findEntitlementsForContext(context) {
        expect(context.membership.permissions).toEqual([]);
        return [entitlement("active")];
      },
    };

    const resolution = await createAuthorizationResolver(
      roleRepository,
      entitlementRepository,
      propertyScopeRepository(propertyScope({ mode: "all" })),
    )(contextFor());

    expect(resolution.permissions).toEqual(["booking.settings.manage"]);
    expect(resolution.entitlements).toEqual([entitlement("active")]);
  });

  it("returns no authorization for delegated or malformed hotel memberships", async () => {
    const findPermissionsForRole = vi.fn(async () => ["pms.operations.read" as const]);
    const findEntitlementsForContext = vi.fn(async () => [entitlement("active")]);
    const resolve = (scope: MembershipPropertyScope | null, candidate = hotelContext) =>
      createAuthorizationResolver(
        { findPermissionsForRole },
        { findEntitlementsForContext },
        propertyScopeRepository(scope),
      )(candidate);

    await expect(resolve(propertyScope({ accessOrigin: "external_owner" }))).resolves.toEqual({
      permissions: [],
      entitlements: [],
    });
    await expect(resolve(null)).resolves.toEqual({ permissions: [], entitlements: [] });
    await expect(
      createAuthorizationResolver({ findPermissionsForRole }, undefined, undefined)(hotelContext),
    ).resolves.toEqual({ permissions: [], entitlements: [] });
    await expect(resolve(propertyScope({ accessOrigin: "unknown" }))).resolves.toEqual({
      permissions: [],
      entitlements: [],
    });
    expect(findPermissionsForRole).not.toHaveBeenCalled();
    expect(findEntitlementsForContext).not.toHaveBeenCalled();

    await expect(
      resolve(propertyScope({ roleKey: "external_owner", assignedPropertyIds: [PROPERTY_A] }), {
        ...hotelContext,
        membership: { ...hotelContext.membership, roleKey: "external_owner" },
      }),
    ).resolves.toMatchObject({ permissions: ["pms.operations.read"] });
  });
});

describe.skipIf(!TEST_DATABASE_URL)("createPgRolePermissionRepository", () => {
  it("reads role grants from identity.role_permission_grants", async () => {
    assertSafeTestDatabase(TEST_DATABASE_URL!);

    const client = new pg.Client({ connectionString: TEST_DATABASE_URL });
    await client.connect();

    try {
      await resetRolePermissionGrantsTable(client);
      await client.query(
        `INSERT INTO identity.role_permission_grants
           (organization_kind, role_key, permission_key)
         VALUES
           ('hotel_group', 'hotel_owner', 'booking.settings.manage'),
           ('hotel_group', 'hotel_owner', 'pms.booking.update'),
           ('creator_workspace', 'creator_owner', 'marketplace.profile.manage')`,
      );
    } finally {
      await client.end();
    }

    const repository = createPgRolePermissionRepository({
      connectionString: TEST_DATABASE_URL!,
      max: 1,
    });

    try {
      await expect(
        repository.findPermissionsForRole("hotel_group", "hotel_owner"),
      ).resolves.toEqual(["booking.settings.manage", "pms.booking.update"]);
      await expect(
        repository.findPermissionsForRole("platform", "platform_admin"),
      ).resolves.toEqual([]);
    } finally {
      await repository.close?.();
    }

    const cleanup = new pg.Client({ connectionString: TEST_DATABASE_URL });
    await cleanup.connect();
    try {
      await resetRolePermissionGrantsTable(cleanup);
    } finally {
      await cleanup.end();
    }
  });
});

describe.skipIf(!TEST_DATABASE_URL)("createPgEntitlementRepository", () => {
  it("reads linked entitlements and normalizes expired rows", async () => {
    assertSafeTestDatabase(TEST_DATABASE_URL!);

    const client = new pg.Client({ connectionString: TEST_DATABASE_URL });
    await client.connect();

    try {
      await resetProductEntitlementsTable(client);
      await client.query(
        `INSERT INTO identity.product_entitlements
           (organization_id, product, entitlement_key, status, resource_product, resource_type, resource_id, expires_at)
         VALUES
           ('00000000-0000-0000-0000-000000000001', 'booking', 'booking-engine', 'active', NULL, NULL, NULL, NULL),
           ('00000000-0000-0000-0000-000000000001', 'booking', 'booking-engine', 'suspended', 'booking', 'booking_hotel', 'booking_hotel_alpenrose', now() - interval '1 day'),
           ('00000000-0000-0000-0000-000000000001', 'pms', 'pms-core', 'active', 'pms', 'pms_hotel', 'pms_hotel_alpenrose', NULL),
           ('00000000-0000-0000-0000-000000000001', 'pms', 'pms-core', 'active', 'pms', 'pms_hotel', 'pms_hotel_other', NULL),
           ('00000000-0000-0000-0000-000000000001', 'pms', 'account_access', 'suspended', 'pms', 'pms_hotel', 'pms_hotel_archived', NULL),
           ('00000000-0000-0000-0000-000000000002', 'booking', 'booking-engine', 'active', NULL, NULL, NULL, NULL)`,
      );
    } finally {
      await client.end();
    }

    const repository = createPgEntitlementRepository({
      connectionString: TEST_DATABASE_URL!,
      max: 1,
    });

    try {
      await expect(
        repository.findEntitlementsForContext({
          ...hotelContext,
          selectedOrganization: {
            ...hotelContext.selectedOrganization,
            organizationId: "00000000-0000-0000-0000-000000000001",
          },
          linkedResources: [
            linkedResource("booking", "booking_hotel", "booking_hotel_alpenrose"),
            linkedResource("pms", "pms_hotel", "pms_hotel_alpenrose"),
          ],
        }),
      ).resolves.toEqual([
        {
          product: "booking",
          key: "booking-engine",
          status: "active",
        },
        {
          product: "booking",
          key: "booking-engine",
          status: "expired",
          resource: {
            product: "booking",
            resourceType: "booking_hotel",
            resourceId: "booking_hotel_alpenrose",
          },
        },
        {
          product: "pms",
          key: "property-management",
          status: "suspended",
          resource: {
            product: "pms",
            resourceType: "pms_hotel",
            resourceId: "pms_hotel_archived",
          },
        },
        {
          product: "pms",
          key: "property-management",
          status: "active",
          resource: {
            product: "pms",
            resourceType: "pms_hotel",
            resourceId: "pms_hotel_alpenrose",
          },
        },
      ]);
    } finally {
      await repository.close?.();

      const cleanup = new pg.Client({ connectionString: TEST_DATABASE_URL });
      await cleanup.connect();
      try {
        await resetProductEntitlementsTable(cleanup);
      } finally {
        await cleanup.end();
      }
    }
  });
});

describe.skipIf(!TEST_DATABASE_URL)("createPgPropertyAccessRepository", () => {
  it("loads only an active scope bound to the selected actor and organization", async () => {
    assertSafeTestDatabase(TEST_DATABASE_URL!);
    const client = new pg.Client({ connectionString: TEST_DATABASE_URL });
    await client.connect();
    const repository = createPgPropertyAccessRepository({ connectionString: TEST_DATABASE_URL! });
    const cleanup = `
      DELETE FROM identity.membership_property_assignments WHERE membership_id = '${DB_MEMBERSHIP}';
      DELETE FROM identity.organization_memberships WHERE id = '${DB_MEMBERSHIP}';
      DELETE FROM identity.organization_resource_links WHERE organization_id = '${DB_ORGANIZATION}';
      DELETE FROM identity.organizations WHERE id = '${DB_ORGANIZATION}';
      DELETE FROM hotel_catalog.properties WHERE id = '${DB_PROPERTY}';
      DELETE FROM identity.users WHERE id = '${DB_USER}';`;
    const dbContext = {
      ...propertyContext(),
      actor: { ...propertyContext().actor, internalUserId: DB_USER },
      selectedOrganization: {
        ...propertyContext().selectedOrganization,
        organizationId: DB_ORGANIZATION,
      },
      membership: {
        ...propertyContext().membership,
        membershipId: DB_MEMBERSHIP,
        roleKey: "front_desk",
      },
    };

    try {
      await client.query(cleanup);
      await client.query(`
        INSERT INTO identity.users (id, email) VALUES ('${DB_USER}', 'property-access@example.com');
        INSERT INTO identity.organizations (id, kind, name, slug) VALUES ('${DB_ORGANIZATION}', 'hotel_group', 'Property Access Test', 'property-access-test');
        INSERT INTO hotel_catalog.properties (id, public_id, display_name) VALUES ('${DB_PROPERTY}', 'property-access-test', 'Property Access Test');
        INSERT INTO identity.organization_resource_links (organization_id, product, resource_type, resource_id, relationship) VALUES ('${DB_ORGANIZATION}', 'hotel_catalog', 'property', '${DB_PROPERTY}', 'operator');
        INSERT INTO identity.organization_memberships (id, organization_id, user_id, status, role_key, property_access_mode, access_origin) VALUES ('${DB_MEMBERSHIP}', '${DB_ORGANIZATION}', '${DB_USER}', 'active', 'front_desk', 'assigned', 'agency');
        INSERT INTO identity.membership_property_assignments VALUES ('${DB_MEMBERSHIP}', '${DB_PROPERTY}');`);

      await expect(repository.findMembershipPropertyScope(dbContext)).resolves.toEqual({
        mode: "assigned",
        roleKey: "front_desk",
        accessOrigin: "agency",
        assignedPropertyIds: [DB_PROPERTY],
      });
      await expect(
        createAuthorizationResolver(
          { findPermissionsForRole: async () => ["pms.operations.read"] },
          undefined,
          repository,
        )(dbContext),
      ).resolves.toMatchObject({ permissions: ["pms.operations.read"] });
      await expect(
        repository.findMembershipPropertyScope({
          ...dbContext,
          selectedOrganization: { ...dbContext.selectedOrganization, organizationId: PROPERTY_B },
        }),
      ).resolves.toBeNull();
      await client.query(
        `UPDATE identity.organization_memberships SET status = 'suspended' WHERE id = '${DB_MEMBERSHIP}'`,
      );
      await expect(repository.findMembershipPropertyScope(dbContext)).resolves.toBeNull();
    } finally {
      await repository.close?.();
      await client.query(cleanup);
      await client.end();
    }
  });
});

describe("authorization helpers", () => {
  it.each([
    [
      "allows hotel owner with booking permission and booking hotel link",
      hotelContext,
      requirement("booking.settings.manage", "booking", "booking_hotel", "booking_hotel_alpenrose"),
      true,
    ],
    [
      "denies hotel owner when the resource relationship is not allowed",
      contextFor({
        kind: "hotel_group",
        roleKey: "hotel_owner",
        permissions: ["booking.settings.manage"],
        linkedResources: [
          {
            ...linkedResource("booking", "booking_hotel", "booking_hotel_alpenrose"),
            relationship: "promotes",
          },
        ],
      }),
      requirement("booking.settings.manage", "booking", "booking_hotel", "booking_hotel_alpenrose"),
      false,
    ],
    [
      "denies hotel owner when the booking hotel is not linked",
      hotelContext,
      requirement("booking.settings.manage", "booking", "booking_hotel", "booking_hotel_other"),
      false,
    ],
    [
      "allows hotel setup reader with a direct canonical property link",
      contextFor({
        kind: "hotel_group",
        roleKey: "operator",
        permissions: ["hotel_catalog.setup.read"],
        linkedResources: [
          {
            product: "hotel_catalog",
            resourceType: "property",
            resourceId: "c2c3d4e5-0000-0000-0000-000000000001",
            relationship: "operator",
            status: "active",
          },
        ],
      }),
      requirement(
        "hotel_catalog.setup.read",
        "hotel_catalog",
        "property",
        "c2c3d4e5-0000-0000-0000-000000000001",
        ["owner", "operator"],
      ),
      true,
    ],
    [
      "denies shared setup when only a product-native hotel link exists",
      contextFor({
        kind: "hotel_group",
        roleKey: "operator",
        permissions: ["hotel_catalog.setup.read"],
        linkedResources: [linkedResource("booking", "booking_hotel", "booking_hotel_alpenrose")],
      }),
      requirement(
        "hotel_catalog.setup.read",
        "hotel_catalog",
        "property",
        "c2c3d4e5-0000-0000-0000-000000000001",
        ["owner", "operator"],
      ),
      false,
    ],
    [
      "allows creator owner with profile permission and creator profile link",
      creatorContext,
      requirement(
        "marketplace.profile.manage",
        "marketplace",
        "creator_profile",
        "creator_profile_lina",
      ),
      true,
    ],
    [
      "denies creator owner without hotel collaboration permission",
      creatorContext,
      requirement(
        "marketplace.collaboration.review",
        "marketplace",
        "creator_profile",
        "creator_profile_lina",
      ),
      false,
    ],
    [
      "allows affiliate owner with payout permission and affiliate link",
      affiliateContext,
      requirement("affiliate.payout.manage", "affiliate", "affiliate", "affiliate_partner_bali"),
      true,
    ],
    [
      "denies affiliate owner without implicit hotel finance permission",
      affiliateContext,
      requirement("pms.finance.read", "pms", "pms_hotel", "pms_hotel_alpenrose"),
      false,
    ],
    [
      "allows platform admin with platform permission and platform link",
      platformContext,
      requirement("platform.user.suspend", "platform", "platform", "vayada", ["operator"]),
      true,
    ],
    [
      "denies platform admin as implicit hotel owner",
      platformContext,
      requirement("booking.settings.manage", "booking", "booking_hotel", "booking_hotel_alpenrose"),
      false,
    ],
  ] as const)("%s", (_name, context, accessRequirement, expected) => {
    expect(canAccessResource(context, accessRequirement)).toBe(expected);
  });

  it("checks a single permission", () => {
    expect(hasPermission(hotelContext, "booking.settings.manage")).toBe(true);
    expect(hasPermission(hotelContext, "pms.finance.read")).toBe(false);
  });

  it("throws authorization errors for missing permissions or resource access", () => {
    expect(() => requirePermission(hotelContext, "pms.finance.read")).toThrow(AuthorizationError);
    expect(() =>
      requireResourceAccess(
        hotelContext,
        requirement("booking.settings.manage", "booking", "booking_hotel", "booking_hotel_other"),
      ),
    ).toThrow(AuthorizationError);
  });
});

describe("effective property access", () => {
  it("allows all-scope and assigned-scope access only through canonical target links", async () => {
    const context = propertyContext();

    await expect(
      resolveEffectivePropertyAccess(
        context,
        propertyScopeRepository(propertyScope({ mode: "all" })),
      ),
    ).resolves.toEqual({ mode: "all", propertyIds: [PROPERTY_A, PROPERTY_B] });
    await expect(
      requirePropertyAccess(
        context,
        propertyScopeRepository(propertyScope({ assignedPropertyIds: [PROPERTY_A] })),
        {
          propertyId: PROPERTY_A,
          targetResource: { product: "pms", resourceType: "pms_property" },
        },
      ),
    ).resolves.toBe(context);
  });

  it("denies inactive principals, invalid scopes, and properties outside the assignment", async () => {
    const context = propertyContext();
    const all = propertyScope({ mode: "all" });
    const deny = (
      candidate: RequestContext,
      scope: MembershipPropertyScope,
      propertyId = PROPERTY_A,
    ) =>
      expect(
        requirePropertyAccess(candidate, propertyScopeRepository(scope), {
          propertyId,
          targetResource: { product: "pms", resourceType: "pms_property" },
        }),
      ).rejects.toBeInstanceOf(AuthorizationError);

    await deny({ ...context, actor: { ...context.actor, status: "suspended" } }, all);
    await deny({ ...context, membership: { ...context.membership, status: "inactive" } }, all);
    await deny({ ...context, membership: { ...context.membership, status: "suspended" } }, all);
    await deny(context, propertyScope());
    await deny(
      context,
      propertyScope({ assignedPropertyIds: [PROPERTY_OTHER_TENANT] }),
      PROPERTY_OTHER_TENANT,
    );
    await deny(context, propertyScope({ assignedPropertyIds: [PROPERTY_A] }), PROPERTY_B);
    await deny(context, propertyScope({ mode: "unknown", assignedPropertyIds: [PROPERTY_A] }));
    await deny(context, propertyScope({ assignedPropertyIds: [PROPERTY_A, null as never] }));
  });

  it("fails closed for malformed or not-yet-enabled owner delegation scopes", async () => {
    const context = propertyContext();
    const deny = (scope: MembershipPropertyScope, candidate = context) =>
      expect(
        resolveEffectivePropertyAccess(candidate, propertyScopeRepository(scope)),
      ).resolves.toBe(null);

    await expect(
      resolveEffectivePropertyAccess(
        { ...context, membership: { ...context.membership, roleKey: "external_owner" } },
        propertyScopeRepository(
          propertyScope({
            roleKey: "external_owner",
            assignedPropertyIds: [PROPERTY_A],
          }),
        ),
      ),
    ).resolves.toEqual({ mode: "assigned", propertyIds: [PROPERTY_A] });
    await deny(propertyScope({ roleKey: "external_owner", mode: "all" }), {
      ...context,
      membership: { ...context.membership, roleKey: "external_owner" },
    });
    await deny(propertyScope({ roleKey: "front_desk", accessOrigin: "external_owner" }));
    await deny(propertyScope({ accessOrigin: "unknown" }));
    await deny(propertyScope({ roleKey: "front_desk" }));
  });

  it("denies a missing target-native link even when canonical scope allows the property", async () => {
    const context = propertyContext();
    context.linkedResources = context.linkedResources.filter(
      (resource) => resource.resourceType !== "booking_hotel",
    );

    await expect(
      requirePropertyAccess(context, propertyScopeRepository(propertyScope({ mode: "all" })), {
        propertyId: PROPERTY_A,
        targetResource: { product: "booking", resourceType: "booking_hotel" },
      }),
    ).rejects.toBeInstanceOf(AuthorizationError);
    await expect(
      requirePropertyAccess(context, propertyScopeRepository(propertyScope({ mode: "all" })), {
        propertyId: PROPERTY_A,
      } as never),
    ).rejects.toBeInstanceOf(AuthorizationError);
  });

  it("returns a generic 403 without leaking the requested property", async () => {
    const error = await requirePropertyAccess(
      propertyContext(),
      propertyScopeRepository(propertyScope()),
      {
        propertyId: PROPERTY_OTHER_TENANT,
        targetResource: { product: "pms", resourceType: "pms_property" },
      },
    ).catch((cause: unknown) => cause);

    expect(error).toBeInstanceOf(AuthorizationError);
    expect(error).toMatchObject({ statusCode: 403 });
    expect((error as Error).message).not.toContain(PROPERTY_OTHER_TENANT);
  });
});

describe("entitlement helpers", () => {
  const bookingRequirement: EntitlementRequirement = {
    product: "booking",
    key: "booking-engine",
  };

  it.each([
    [
      "allows an active entitlement",
      contextFor({ entitlements: [entitlement("active")] }),
      bookingRequirement,
      true,
    ],
    [
      "denies a suspended entitlement",
      contextFor({ entitlements: [entitlement("suspended")] }),
      bookingRequirement,
      false,
    ],
    [
      "denies an expired entitlement",
      contextFor({ entitlements: [entitlement("expired")] }),
      bookingRequirement,
      false,
    ],
    ["denies a missing entitlement", contextFor(), bookingRequirement, false],
    [
      "denies resource-scoped entitlement for org-wide requirement",
      contextFor({
        entitlements: [
          entitlement("active", {
            product: "booking",
            resourceType: "booking_hotel",
            resourceId: "booking_hotel_alpenrose",
          }),
        ],
      }),
      bookingRequirement,
      false,
    ],
    [
      "allows org-level entitlement for a resource requirement",
      contextFor({ entitlements: [entitlement("active")] }),
      {
        product: "booking",
        key: "booking-engine",
        resource: {
          product: "booking",
          resourceType: "booking_hotel",
          resourceId: "booking_hotel_alpenrose",
        },
      },
      true,
    ],
    [
      "ignores a suspension for a different resource",
      contextFor({
        entitlements: [
          entitlement("active"),
          entitlement("suspended", {
            product: "booking",
            resourceType: "booking_hotel",
            resourceId: "booking_hotel_legacy_alias",
          }),
        ],
      }),
      {
        product: "booking",
        key: "booking-engine",
        resource: {
          product: "booking",
          resourceType: "booking_hotel",
          resourceId: "booking_hotel_alpenrose",
        },
      },
      true,
    ],
    [
      "denies a suspension for the requested resource",
      contextFor({
        entitlements: [
          entitlement("active"),
          entitlement("suspended", {
            product: "booking",
            resourceType: "booking_hotel",
            resourceId: "booking_hotel_alpenrose",
          }),
        ],
      }),
      {
        product: "booking",
        key: "booking-engine",
        resource: {
          product: "booking",
          resourceType: "booking_hotel",
          resourceId: "booking_hotel_alpenrose",
        },
      },
      false,
    ],
    [
      "allows matching resource-scoped entitlement",
      contextFor({
        entitlements: [
          entitlement("active", {
            product: "booking",
            resourceType: "booking_hotel",
            resourceId: "booking_hotel_alpenrose",
          }),
        ],
      }),
      {
        product: "booking",
        key: "booking-engine",
        resource: {
          product: "booking",
          resourceType: "booking_hotel",
          resourceId: "booking_hotel_alpenrose",
        },
      },
      true,
    ],
    [
      "denies non-matching resource-scoped entitlement",
      contextFor({
        entitlements: [
          entitlement("active", {
            product: "booking",
            resourceType: "booking_hotel",
            resourceId: "booking_hotel_other",
          }),
        ],
      }),
      {
        product: "booking",
        key: "booking-engine",
        resource: {
          product: "booking",
          resourceType: "booking_hotel",
          resourceId: "booking_hotel_alpenrose",
        },
      },
      false,
    ],
  ] as const)("%s", (_name, context, entitlementRequirement, expected) => {
    expect(hasActiveEntitlement(context, entitlementRequirement)).toBe(expected);
  });

  it("normalizes a legacy PMS entitlement key without widening its resource scope", () => {
    const context = contextFor({
      entitlements: [
        { product: "pms", key: "property-management", status: "active" },
        {
          product: "pms",
          key: "pms-core",
          status: "suspended",
          resource: {
            product: "pms",
            resourceType: "pms_hotel",
            resourceId: "legacy-pms-hotel",
          },
        },
      ],
    });

    expect(
      hasActiveEntitlement(context, {
        product: "pms",
        key: "property-management",
        resource: {
          product: "pms",
          resourceType: "pms_property",
          resourceId: "canonical-property",
        },
      }),
    ).toBe(true);
  });

  it("throws authorization errors for missing active entitlement", () => {
    expect(() => requireActiveEntitlement(hotelContext, bookingRequirement)).toThrow(
      AuthorizationError,
    );
  });

  it("keeps permissions and entitlements independent", () => {
    const permittedButNotEntitled = contextFor({
      permissions: ["booking.settings.manage"],
      linkedResources: [linkedResource("booking", "booking_hotel", "booking_hotel_alpenrose")],
      entitlements: [entitlement("suspended")],
    });

    expect(hasPermission(permittedButNotEntitled, "booking.settings.manage")).toBe(true);
    expect(hasActiveEntitlement(permittedButNotEntitled, bookingRequirement)).toBe(false);
    expect(() =>
      requirePermission(permittedButNotEntitled, "booking.settings.manage"),
    ).not.toThrow();
    expect(() => requireActiveEntitlement(permittedButNotEntitled, bookingRequirement)).toThrow(
      AuthorizationError,
    );
  });
});
