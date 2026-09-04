import {
  createFakeVerifier,
  type IdentityRepository,
  type PermissionKey,
  type ProductEntitlement,
  type RequestContext,
  type ResourceRelationship,
  type VerifiedSession,
} from "@vayada/backend-auth";
import { injectJson } from "@vayada/backend-test";
import { afterEach, describe, expect, it } from "vitest";

import { buildApp } from "./app.js";
import type { BookingPublicationRefreshPort } from "./domains/bookingPublicationProductionRuntime.js";
import { agencyPropertyAccessRepository } from "./testAuthorization.js";
import {
  createPgPmsModuleActivationRepository,
  type PmsModuleActivationPool,
  PmsModuleActivation,
  PmsModuleActivationRepository,
  PmsModuleActivationsResponse,
} from "./routes/pmsModuleActivations.js";
import type { PmsReviewRepository } from "./routes/pmsReviews.js";

const futureExpiry = Math.floor(Date.now() / 1000) + 3600;
const propertyId = "f6853000-0000-0000-0000-000000000001";
const organizationId = "11111111-1111-1111-1111-111111111111";
const actorUserId = "22222222-2222-2222-2222-222222222222";

const session: VerifiedSession = {
  workosUserId: "workos-user-1",
  workosOrgId: "workos-org-1",
  sessionId: "session-1",
  expiresAt: futureExpiry,
};

const identityRepository: IdentityRepository = {
  async findUserByProviderUserId() {
    return {
      userId: actorUserId,
      email: "owner@example.com",
      status: "active",
    };
  },
  async findOrganizationByWorkosOrgId() {
    return {
      organizationId,
      workosOrgId: "workos-org-1",
      kind: "hotel_group",
      status: "active",
    };
  },
  async findActiveMembership() {
    return {
      membershipId: "33333333-3333-3333-3333-333333333333",
      status: "active",
      roleKey: "hotel_owner",
      workosMembershipId: "workos-membership-1",
      workosRoleSlugs: ["hotel_owner"],
    };
  },
  async findLinkedResources() {
    return [
      {
        product: "pms",
        resourceType: "pms_property",
        resourceId: propertyId,
        relationship: "operator",
        status: "active",
      },
    ];
  },
};

function pmsEntitlement(status: ProductEntitlement["status"] = "active"): ProductEntitlement {
  return {
    product: "pms",
    key: "property-management",
    status,
    resource: {
      product: "pms",
      resourceType: "pms_property",
      resourceId: propertyId,
    },
  };
}

function createActivationRepository(): PmsModuleActivationRepository & {
  updates: Array<{
    context: RequestContext;
    propertyId: string;
    moduleId: string;
    isActive: boolean;
  }>;
} {
  const now = "2026-06-29T08:00:00.000Z";
  const activations = new Map<string, PmsModuleActivation>([
    [
      "financials",
      {
        moduleId: "financials",
        isActive: true,
        activatedAt: now,
        deactivatedAt: null,
        updatedAt: now,
      },
    ],
    [
      "inbox",
      {
        moduleId: "inbox",
        isActive: false,
        activatedAt: null,
        deactivatedAt: now,
        updatedAt: now,
      },
    ],
    [
      "affiliates",
      {
        moduleId: "affiliates",
        isActive: true,
        activatedAt: now,
        deactivatedAt: null,
        updatedAt: now,
      },
    ],
  ]);
  const updates: Array<{
    context: RequestContext;
    propertyId: string;
    moduleId: string;
    isActive: boolean;
  }> = [];

  return {
    updates,
    async list() {
      return Array.from(activations.values());
    },
    async update(context, propertyId, moduleId, isActive) {
      updates.push({ context, propertyId, moduleId, isActive });
      const activation = {
        moduleId,
        isActive,
        activatedAt: isActive ? now : null,
        deactivatedAt: isActive ? null : now,
        updatedAt: now,
      };
      activations.set(moduleId, activation);
      return activation;
    },
  };
}

function buildAuthenticatedApp(
  options: {
    repository?: PmsModuleActivationRepository;
    permissions?: PermissionKey[];
    entitlements?: ProductEntitlement[];
    linkedPropertyId?: string | null;
    linkedRelationship?: ResourceRelationship;
    allowedOrigins?: string[];
    reviewRepository?: PmsReviewRepository;
    bookingPublicationRefresh?: BookingPublicationRefreshPort;
  } = {},
) {
  const linkedPropertyId =
    options.linkedPropertyId === undefined ? propertyId : options.linkedPropertyId;
  const repo = {
    ...identityRepository,
    async findLinkedResources() {
      return linkedPropertyId
        ? [
            {
              product: "pms" as const,
              resourceType: "pms_property" as const,
              resourceId: linkedPropertyId,
              relationship: options.linkedRelationship ?? ("operator" as const),
              status: "active" as const,
            },
          ]
        : [];
    },
  };

  return buildApp({
    logger: false,
    pmsModuleActivationRepository: options.repository ?? createActivationRepository(),
    pmsReviewRepository: options.reviewRepository,
    bookingPublicationRefresh: options.bookingPublicationRefresh,
    pmsOperationsAllowedOrigins: options.allowedOrigins,
    auth: {
      verifier: createFakeVerifier(new Map([["valid-token", session]])),
      repository: repo,
      propertyAccessRepository: agencyPropertyAccessRepository,
      rolePermissionRepository: {
        async findPermissionsForRole() {
          return options.permissions ?? ["pms.operations.read", "pms.operations.manage"];
        },
      },
      entitlementRepository: {
        async findEntitlementsForContext() {
          return options.entitlements ?? [pmsEntitlement()];
        },
      },
    },
  });
}

describe("PMS module activation routes", () => {
  let app: ReturnType<typeof buildApp> | null = null;

  afterEach(async () => {
    await app?.close();
    app = null;
  });

  it("lists property module activations through the next-api route", async () => {
    app = buildAuthenticatedApp();

    const response = await injectJson<PmsModuleActivationsResponse>(app, {
      method: "GET",
      url: `/api/pms/properties/${propertyId}/module-activations`,
      headers: { authorization: "Bearer valid-token" },
    });

    expect(response.statusCode).toBe(200);
    expect(response.body).toMatchObject({
      hotelId: propertyId,
      canManage: true,
      supportedModules: ["affiliates"],
      activeModules: ["affiliates"],
    });
    expect(response.body.activations).toEqual([
      expect.objectContaining({ moduleId: "affiliates", isActive: true }),
    ]);
  });

  it("reports read-only activation capability without weakening write authorization", async () => {
    app = buildAuthenticatedApp({ permissions: ["pms.operations.read"] });

    const response = await injectJson<PmsModuleActivationsResponse>(app, {
      method: "GET",
      url: `/api/pms/properties/${propertyId}/module-activations`,
      headers: { authorization: "Bearer valid-token" },
    });

    expect(response.statusCode).toBe(200);
    expect(response.body.canManage).toBe(false);
  });

  it("does not advertise manage capability outside owner or operator property scope", async () => {
    app = buildAuthenticatedApp({
      permissions: ["pms.operations.read", "pms.operations.manage"],
      linkedRelationship: "front_desk",
    });

    const response = await injectJson<PmsModuleActivationsResponse>(app, {
      method: "GET",
      url: `/api/pms/properties/${propertyId}/module-activations`,
      headers: { authorization: "Bearer valid-token" },
    });

    expect(response.statusCode).toBe(200);
    expect(response.body.canManage).toBe(false);
  });

  it("updates the supported property module activation through the next-api route", async () => {
    const repository = createActivationRepository();
    const refreshes: Parameters<BookingPublicationRefreshPort["refresh"]>[0][] = [];
    app = buildAuthenticatedApp({
      repository,
      bookingPublicationRefresh: {
        async refresh(input) {
          refreshes.push(input);
          return {
            operationId: "a1000000-0000-4000-8000-000000001299",
            propertyId: input.propertyId,
            status: "succeeded",
            expectedActiveContentRevisionId: null,
            resultContentRevisionId: "a1000000-0000-4000-8000-000000001300",
            failureCode: null,
            requestedAt: "2026-09-03T01:00:00.000Z",
            updatedAt: "2026-09-03T01:00:01.000Z",
            completedAt: "2026-09-03T01:00:01.000Z",
          };
        },
      },
    });

    const response = await injectJson<PmsModuleActivation>(app, {
      method: "PATCH",
      url: `/api/pms/properties/${propertyId}/module-activations/affiliates`,
      headers: { authorization: "Bearer valid-token" },
      payload: { moduleId: "affiliates", isActive: false },
    });

    expect(response.statusCode).toBe(200);
    expect(response.body).toMatchObject({ moduleId: "affiliates", isActive: false });
    expect(response.body).toMatchObject({ publicationRefresh: { status: "succeeded" } });
    expect(repository.updates).toMatchObject([
      { propertyId, moduleId: "affiliates", isActive: false },
    ]);
    expect(refreshes).toHaveLength(1);
    expect(refreshes[0]).toMatchObject({ propertyId, organizationId, actorUserId });
    expect(repository.updates[0].context.selectedOrganization.organizationId).toBe(organizationId);
  });

  it("rejects malformed module activation updates before writing", async () => {
    const repository = createActivationRepository();
    app = buildAuthenticatedApp({ repository });

    const response = await injectJson(app, {
      method: "PATCH",
      url: `/api/pms/properties/${propertyId}/module-activations/bad module`,
      headers: { authorization: "Bearer valid-token" },
      payload: { moduleId: "bad module", isActive: true },
    });

    expect(response.statusCode).toBe(400);
    expect(repository.updates).toHaveLength(0);
  });

  it.each(["inbox", "financials", "lodgify", "stripe", "paypal", "xendit", "future-module"])(
    "rejects unsupported %s activation updates before writing",
    async (moduleId) => {
      const repository = createActivationRepository();
      app = buildAuthenticatedApp({ repository });

      const response = await injectJson(app, {
        method: "PATCH",
        url: `/api/pms/properties/${propertyId}/module-activations/${moduleId}`,
        headers: { authorization: "Bearer valid-token" },
        payload: { moduleId, isActive: true },
      });

      expect(response.statusCode).toBe(400);
      expect(repository.updates).toHaveLength(0);
    },
  );

  it("rejects front-desk module activation writes", async () => {
    const repository = createActivationRepository();
    app = buildAuthenticatedApp({ repository, linkedRelationship: "front_desk" });

    const response = await injectJson(app, {
      method: "PATCH",
      url: `/api/pms/properties/${propertyId}/module-activations/affiliates`,
      headers: { authorization: "Bearer valid-token" },
      payload: { moduleId: "affiliates", isActive: true },
    });

    expect(response.statusCode).toBe(403);
    expect(repository.updates).toHaveLength(0);
  });

  it("allows configured browser preflight requests", async () => {
    app = buildAuthenticatedApp({ allowedOrigins: ["https://next-pms.vayada.com"] });

    const response = await app.inject({
      method: "OPTIONS",
      url: `/api/pms/properties/${propertyId}/module-activations/affiliates`,
      headers: {
        origin: "https://next-pms.vayada.com",
        "access-control-request-method": "PATCH",
      },
    });

    expect(response.statusCode).toBe(204);
    expect(response.headers["access-control-allow-origin"]).toBe("https://next-pms.vayada.com");
    expect(response.headers["access-control-allow-methods"]).toBe("GET,PATCH,OPTIONS");
  });

  it("rejects unconfigured browser origins", async () => {
    app = buildAuthenticatedApp({ allowedOrigins: ["https://next-pms.vayada.com"] });

    const response = await app.inject({
      method: "OPTIONS",
      url: `/api/pms/properties/${propertyId}/module-activations/affiliates`,
      headers: {
        origin: "https://other.example.com",
        "access-control-request-method": "PATCH",
      },
    });

    expect(response.statusCode).toBe(403);
  });

  it.each([
    {
      name: "missing auth",
      appOptions: {},
      headers: undefined,
      expectedStatus: 401,
    },
    {
      name: "missing read permission",
      appOptions: { permissions: [] },
      headers: { authorization: "Bearer valid-token" },
      expectedStatus: 403,
    },
    {
      name: "missing entitlement",
      appOptions: { entitlements: [] },
      headers: { authorization: "Bearer valid-token" },
      expectedStatus: 403,
    },
    {
      name: "inactive entitlement",
      appOptions: { entitlements: [pmsEntitlement("suspended")] },
      headers: { authorization: "Bearer valid-token" },
      expectedStatus: 403,
    },
    {
      name: "missing linked property",
      appOptions: { linkedPropertyId: "f6853000-0000-0000-0000-000000000099" },
      headers: { authorization: "Bearer valid-token" },
      expectedStatus: 403,
    },
  ])(
    "denies module activation reads for $name",
    async ({ appOptions, headers, expectedStatus }) => {
      app = buildAuthenticatedApp(appOptions);

      const response = await injectJson(app, {
        method: "GET",
        url: `/api/pms/properties/${propertyId}/module-activations`,
        headers,
      });

      expect(response.statusCode).toBe(expectedStatus);
    },
  );
});

describe("PMS review routes", () => {
  let app: ReturnType<typeof buildApp> | null = null;
  const reviewRepository: PmsReviewRepository = {
    async list(_context, requestedPropertyId, filters) {
      expect(requestedPropertyId).toBe(propertyId);
      expect(filters).toMatchObject({ channel: "booking.com", minRating: 4, limit: 20, offset: 0 });
      return {
        total: 1,
        items: [
          {
            reviewId: "review-1",
            channel: "booking.com",
            guestDisplayName: "Guest",
            rating: "5.00",
            body: "Excellent stay",
            replyBody: null,
            reviewedAt: "2026-07-30T10:00:00.000Z",
            updatedAt: "2026-07-30T10:00:00.000Z",
          },
        ],
      };
    },
  };

  afterEach(async () => {
    await app?.close();
    app = null;
  });

  it("lists filtered reviews for an authorized property", async () => {
    app = buildAuthenticatedApp({ reviewRepository });
    const response = await injectJson<{
      items: Array<{ reviewId: string }>;
      pagination: { total: number };
    }>(app, {
      method: "GET",
      url: `/api/pms/properties/${propertyId}/reviews?channel=booking.com&minRating=4&limit=20`,
      headers: { authorization: "Bearer valid-token" },
    });
    expect(response.statusCode).toBe(200);
    expect(response.body.items).toEqual([expect.objectContaining({ reviewId: "review-1" })]);
    expect(response.body.pagination.total).toBe(1);
  });

  it.each([
    ["missing auth", {}, undefined, 401],
    ["missing permission", { permissions: [] }, { authorization: "Bearer valid-token" }, 403],
    ["missing entitlement", { entitlements: [] }, { authorization: "Bearer valid-token" }, 403],
    [
      "wrong property",
      { linkedPropertyId: "f6853000-0000-0000-0000-000000000099" },
      { authorization: "Bearer valid-token" },
      403,
    ],
  ])("denies review reads for %s", async (_name, appOptions, headers, expectedStatus) => {
    app = buildAuthenticatedApp({ ...appOptions, reviewRepository });
    const response = await injectJson(app, {
      method: "GET",
      url: `/api/pms/properties/${propertyId}/reviews`,
      headers,
    });
    expect(response.statusCode).toBe(expectedStatus);
  });
});

describe("PG PMS module activation repository", () => {
  const context = {
    actor: {
      internalUserId: "22222222-2222-2222-2222-222222222222",
    },
    selectedOrganization: {
      organizationId,
    },
  } as RequestContext;

  it("lists feature-hub module entitlements from the target identity schema", async () => {
    const queries: Array<{ text: string; values?: readonly unknown[] }> = [];
    const pool: PmsModuleActivationPool = {
      async query<T>(text: string, values?: readonly unknown[]) {
        queries.push({ text, values });
        return {
          rowCount: 1,
          rows: [
            {
              entitlementKey: "module:affiliates",
              status: "active",
              startsAt: "2026-06-29T08:00:00.000Z",
              expiresAt: null,
              updatedAt: "2026-06-29T08:00:00.000Z",
            },
          ] as T[],
        };
      },
    };
    const repository = createPgPmsModuleActivationRepository({
      connectionString: "postgresql://target-db",
      pool,
    });

    const activations = await repository.list(context, propertyId);

    expect(activations).toEqual([
      {
        moduleId: "affiliates",
        isActive: true,
        activatedAt: "2026-06-29T08:00:00.000Z",
        deactivatedAt: null,
        updatedAt: "2026-06-29T08:00:00.000Z",
      },
    ]);
    expect(queries[0].text).toContain("FROM identity.product_entitlements");
    expect(queries[0].text).toContain("entitlement_key = ANY($3::text[])");
    expect(queries[0].text).toContain("starts_at IS NULL OR starts_at <= now()");
    expect(queries[0].values).toEqual([organizationId, propertyId, ["module:affiliates"]]);
  });

  it("upserts module entitlements without refreshing inactive retry timestamps", async () => {
    const queries: Array<{ text: string; values?: readonly unknown[] }> = [];
    const pool: PmsModuleActivationPool = {
      async query<T>(text: string, values?: readonly unknown[]) {
        queries.push({ text, values });
        return {
          rowCount: 1,
          rows: [
            {
              entitlementKey: "module:affiliates",
              status: "suspended",
              startsAt: "2026-06-29T08:00:00.000Z",
              expiresAt: "2026-06-29T09:00:00.000Z",
              updatedAt: "2026-06-29T09:00:00.000Z",
            },
          ] as T[],
        };
      },
    };
    const repository = createPgPmsModuleActivationRepository({
      connectionString: "postgresql://target-db",
      pool,
    });

    const activation = await repository.update(context, propertyId, "affiliates", false);

    expect(activation).toMatchObject({
      moduleId: "affiliates",
      isActive: false,
      deactivatedAt: "2026-06-29T09:00:00.000Z",
      updatedAt: "2026-06-29T09:00:00.000Z",
    });
    expect(queries[0].text).toContain("ON CONFLICT");
    expect(queries[0].text).toContain("identity.product_entitlements.expires_at");
    expect(queries[0].text).toContain("ELSE identity.product_entitlements.updated_at");
    expect(queries[0].text).not.toMatch(
      /ELSE identity\.product_entitlements\.updated_at\s+END,\s+RETURNING/,
    );
    expect(queries[0].values?.slice(0, 4)).toEqual([
      organizationId,
      "module:affiliates",
      false,
      propertyId,
    ]);
    expect(JSON.parse(queries[0].values?.[4] as string)).toMatchObject({
      source: "feature_hub",
      moduleId: "affiliates",
      updatedByUserId: context.actor.internalUserId,
    });
  });
});
