import { describe, expect, it } from "vitest";
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
  hasPermission,
  hasActiveEntitlement,
  requirePermission,
  requireActiveEntitlement,
  requireResourceAccess,
  createPgRolePermissionRepository,
  type EntitlementRepository,
  type EntitlementRequirement,
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

    const resolution = await createAuthorizationResolver(repository)(hotelContext);

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
    )(contextFor());

    expect(resolution.permissions).toEqual(["booking.settings.manage"]);
    expect(resolution.entitlements).toEqual([entitlement("active")]);
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
      "lets any primary-product resource suspension override account access",
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

  it("normalizes a legacy PMS entitlement key before applying a suspension", () => {
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
    ).toBe(false);
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
