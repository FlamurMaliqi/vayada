import {
  createFakeVerifier,
  type IdentityRepository,
  type LinkedResource,
  type PermissionKey,
  type ProductEntitlement,
  type VerifiedSession,
} from "@vayada/backend-auth";
import { injectJson } from "@vayada/backend-test";
import {
  PROPERTY_SETUP_STEP_DEFINITIONS,
  PROPERTY_SETUP_DRAFT_CONTRACT_VERSION,
  getActivePropertySetupStepIds,
  type PropertySetupRouteReadModel,
  type PropertySetupSession,
  type SetupTrack,
} from "@vayada/domain-hotels";
import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";

import { buildApp } from "./app.js";
import type { HotelSetupTrackCommandRepository } from "./domains/hotelSetupTrackCommandRepository.js";
import type {
  PropertySetupRouteOwnerStepFact,
  PropertySetupRouteStateReadInput,
  PropertySetupRouteStateReadPort,
  PropertySetupRouteStateReadResult,
} from "./routes/propertySetupRoute.js";

const organizationId = "11111111-1111-4111-8111-111111111111";
const propertyId = "22222222-2222-4222-8222-222222222222";
const userId = "33333333-3333-4333-8333-333333333333";
const futureExpiry = Math.floor(Date.now() / 1000) + 3600;
const retentionExpiresAt = new Date(Date.now() + 90 * 24 * 60 * 60 * 1000).toISOString();

type OrganizationOverride = {
  kind?: "hotel_group" | "creator_workspace";
  status?: "active" | "suspended";
};

const session: VerifiedSession = {
  workosUserId: "user_workos_hotel_owner",
  workosOrgId: "org_workos_hotel_group",
  sessionId: "session_hotel_owner",
  expiresAt: futureExpiry,
};

const allPermissions: PermissionKey[] = [
  "hotel_catalog.setup.read",
  "hotel_catalog.setup.manage",
  "marketplace.collaboration.read",
  "marketplace.profile.manage",
  "booking.settings.read",
  "booking.settings.manage",
  "pms.operations.read",
  "pms.operations.manage",
];

let app: FastifyInstance | undefined;

afterEach(async () => {
  await app?.close();
  app = undefined;
});

describe("property setup route", () => {
  it("returns the canonical property-scoped route with authorized active drafts", async () => {
    const calls: PropertySetupRouteStateReadInput[] = [];
    app = buildRouteApp({
      selectedTracks: ["creator_marketplace", "hotel_operations"],
      routeStateReadPort: {
        async getPropertySetupRouteState(input) {
          calls.push(input);
          return {
            outcome: "found",
            trackRevision: 4,
            session: makePropertySetupSession(),
            ownerFacts: makeOwnerFacts(
              ["hotel_operations", "creator_marketplace"],
              [
                {
                  organizationId,
                  propertyId,
                  stepId: "review",
                  product: "hotel_catalog",
                  ownerDomain: "hotel_catalog",
                  state: "blocked",
                  sourceRevision: "readiness-r5",
                  currentBaseRevisions: {},
                  blockers: [
                    {
                      code: "booking_design_incomplete",
                      product: "booking",
                      ownerDomain: "booking",
                      owningStepId: "booking_design",
                      message: "Choose a booking page design.",
                      kind: "user_fixable",
                      sourceRevision: "booking-design-r2",
                    },
                  ],
                },
              ],
            ),
          };
        },
      },
    });

    const rawResponse = await app.inject({
      method: "GET",
      url: `/api/hotel-setup/properties/${propertyId}/route`,
      headers: { authorization: "Bearer valid-token" },
    });
    const response = {
      statusCode: rawResponse.statusCode,
      body: rawResponse.json<PropertySetupRouteReadModel>(),
    };

    expect(response.statusCode).toBe(200);
    expect(rawResponse.headers["cache-control"]).toBe("private, no-store");
    expect(response.body).toMatchObject({
      scope: { organizationId, propertyId },
      selectedTracks: ["hotel_operations", "creator_marketplace"],
      trackRevision: 4,
      progress: { complete: 0, total: 9 },
    });
    expect(response.body.steps.find(({ stepId }) => stepId === "booking_design")).toMatchObject({
      position: 3,
      state: "draft",
      draft: {
        stepId: "booking_design",
        payload: { "booking.primary_color": "#243ce5" },
        dirtyFields: ["booking.primary_color"],
        baseRevisions: { "booking.design": "design-r1" },
        revision: 2,
      },
    });
    expect(response.body.steps.find(({ stepId }) => stepId === "review")).toMatchObject({
      state: "blocked",
      blockers: [{ owningStepId: "booking_design", owningStepPosition: 3 }],
    });
    expect(calls).toEqual([
      {
        organizationId,
        propertyId,
        actorUserId: userId,
        selectedTracks: ["hotel_operations", "creator_marketplace"],
        expectedTrackRevision: 4,
        authorizedDraftStepIds: [
          "present_hotel",
          "marketplace_preferences",
          "booking_design",
          "rooms",
          "pricing",
          "calendar",
          "guest_experience",
          "payments",
          "review",
        ],
      },
    ]);
  });

  it("does not expose retained drafts from a hidden track", async () => {
    const readPort = {
      getPropertySetupRouteState: vi.fn(async () => ({
        outcome: "found" as const,
        trackRevision: 4,
        session: makePropertySetupSession(),
        ownerFacts: makeOwnerFacts(["creator_marketplace"]),
      })),
    };
    app = buildRouteApp({
      selectedTracks: ["creator_marketplace"],
      routeStateReadPort: readPort,
    });

    const response = await injectJson<PropertySetupRouteReadModel>(app, {
      method: "GET",
      url: `/api/hotel-setup/properties/${propertyId}/route`,
      headers: { authorization: "Bearer valid-token" },
    });

    expect(response.statusCode).toBe(200);
    expect(response.body.steps.map(({ stepId }) => stepId)).toEqual([
      "present_hotel",
      "marketplace_preferences",
      "review",
    ]);
    expect(JSON.stringify(response.body)).not.toContain("booking.primary_color");
    expect(readPort.getPropertySetupRouteState).toHaveBeenCalledWith(
      expect.objectContaining({
        authorizedDraftStepIds: ["present_hotel", "marketplace_preferences", "review"],
      }),
    );
  });

  it.each([
    {
      name: "catalog property link",
      linkedResources: productLinks().filter((link) => link.product !== "hotel_catalog"),
      entitlements: productEntitlements(),
    },
    {
      name: "Marketplace entitlement",
      linkedResources: productLinks(),
      entitlements: productEntitlements().filter(
        (entitlement) => entitlement.product !== "marketplace",
      ),
    },
    {
      name: "Booking property link",
      linkedResources: productLinks().filter((link) => link.product !== "booking"),
      entitlements: productEntitlements(),
    },
    {
      name: "PMS permission",
      linkedResources: productLinks(),
      entitlements: productEntitlements(),
      permissions: allPermissions.filter((permission) => permission !== "pms.operations.read"),
    },
    {
      name: "suspended Marketplace entitlement",
      linkedResources: productLinks(),
      entitlements: productEntitlements().map((entitlement) =>
        entitlement.product === "marketplace"
          ? { ...entitlement, status: "suspended" as const }
          : entitlement,
      ),
    },
    {
      name: "disallowed Booking relationship",
      linkedResources: productLinks().map((link) =>
        link.product === "booking" ? { ...link, relationship: "front_desk" as const } : link,
      ),
      entitlements: productEntitlements(),
    },
    {
      name: "suspended PMS property link",
      linkedResources: productLinks().map((link) =>
        link.product === "pms" ? { ...link, status: "suspended" as const } : link,
      ),
      entitlements: productEntitlements(),
    },
  ])("rejects missing $name before reading route state", async (access) => {
    const routeStateReadPort = {
      getPropertySetupRouteState: vi.fn(async () => ({ outcome: "not_found" as const })),
    };
    app = buildRouteApp({
      selectedTracks: ["hotel_operations", "creator_marketplace"],
      routeStateReadPort,
      ...access,
    });

    const rawResponse = await app.inject({
      method: "GET",
      url: `/api/hotel-setup/properties/${propertyId}/route`,
      headers: { authorization: "Bearer valid-token" },
    });
    const body = rawResponse.json<{ code: string; detail: string }>();

    expect(rawResponse.statusCode).toBe(403);
    expect(rawResponse.headers["cache-control"]).toBe("private, no-store");
    expect(body).toEqual({
      code: "access_denied",
      detail: "You do not have access to this property setup route.",
    });
    expect(JSON.stringify(body)).not.toContain(propertyId);
    expect(routeStateReadPort.getPropertySetupRouteState).not.toHaveBeenCalled();
  });

  it("does not turn Finance access into a route-wide requirement for a PMS operator", async () => {
    const routeStateReadPort = {
      getPropertySetupRouteState: vi.fn(async () => ({ outcome: "not_found" as const })),
    };
    app = buildRouteApp({
      selectedTracks: ["hotel_operations"],
      permissions: allPermissions,
      linkedResources: productLinks().map((link) => ({
        ...link,
        relationship: "operator",
      })),
      routeStateReadPort,
    });

    const response = await app.inject({
      method: "GET",
      url: `/api/hotel-setup/properties/${propertyId}/route`,
      headers: { authorization: "Bearer valid-token" },
    });

    expect(response.statusCode).toBe(404);
    expect(routeStateReadPort.getPropertySetupRouteState).toHaveBeenCalledOnce();
  });

  it.each([
    {
      name: "creator-workspace organization",
      organization: { kind: "creator_workspace" as const },
      expectedStatus: 403,
      expectedCode: "invalid_organization_scope",
    },
    {
      name: "suspended hotel group",
      organization: { status: "suspended" as const },
      expectedStatus: 401,
      expectedCode: "unauthenticated",
    },
  ])(
    "rejects a $name before reading route state",
    async ({ organization, expectedStatus, expectedCode }) => {
      const trackRepository = makeTrackRepository(["creator_marketplace"]);
      const routeStateReadPort = {
        getPropertySetupRouteState: vi.fn(async () => ({ outcome: "not_found" as const })),
      };
      app = buildRouteApp({
        organization,
        routeStateReadPort,
        trackRepository,
      });

      const response = await app.inject({
        method: "GET",
        url: `/api/hotel-setup/properties/${propertyId}/route`,
        headers: { authorization: "Bearer valid-token" },
      });
      const body = response.json<{ code: string }>();

      expect(response.statusCode).toBe(expectedStatus);
      expect(body.code).toBe(expectedCode);
      expect(response.headers["cache-control"]).toBe("private, no-store");
      expect(trackRepository.getTrackStatus).not.toHaveBeenCalled();
      expect(routeStateReadPort.getPropertySetupRouteState).not.toHaveBeenCalled();
    },
  );

  it("authenticates before validating property input and does not read state", async () => {
    const trackRepository = makeTrackRepository(["creator_marketplace"]);
    const routeStateReadPort = {
      getPropertySetupRouteState: vi.fn(async () => ({ outcome: "not_found" as const })),
    };
    app = buildRouteApp({ trackRepository, routeStateReadPort });

    const unauthenticated = await injectJson(app, {
      method: "GET",
      url: "/api/hotel-setup/properties/not-a-uuid/route",
    });
    expect(unauthenticated.statusCode).toBe(401);

    const invalidAuthentication = await injectJson(app, {
      method: "GET",
      url: "/api/hotel-setup/properties/not-a-uuid/route",
      headers: { authorization: "Bearer invalid-token" },
    });
    expect(invalidAuthentication.statusCode).toBe(401);

    const invalidProperty = await injectJson<{ code: string }>(app, {
      method: "GET",
      url: "/api/hotel-setup/properties/not-a-uuid/route",
      headers: { authorization: "Bearer valid-token" },
    });
    expect(invalidProperty.statusCode).toBe(400);
    expect(invalidProperty.body.code).toBe("invalid_property_id");
    expect(trackRepository.getTrackStatus).not.toHaveBeenCalled();
    expect(routeStateReadPort.getPropertySetupRouteState).not.toHaveBeenCalled();
  });

  it("normalizes an uppercase property UUID before authorization and state access", async () => {
    const routeStateReadPort = {
      getPropertySetupRouteState: vi.fn(async () => ({
        outcome: "found" as const,
        trackRevision: 4,
        session: null,
        ownerFacts: makeOwnerFacts(["creator_marketplace"]),
      })),
    };
    app = buildRouteApp({
      selectedTracks: ["creator_marketplace"],
      routeStateReadPort,
    });

    const response = await injectJson<PropertySetupRouteReadModel>(app, {
      method: "GET",
      url: `/api/hotel-setup/properties/${propertyId.toUpperCase()}/route`,
      headers: { authorization: "Bearer valid-token" },
    });

    expect(response.statusCode).toBe(200);
    expect(routeStateReadPort.getPropertySetupRouteState).toHaveBeenCalledWith(
      expect.objectContaining({ propertyId }),
    );
  });

  it.each([
    {
      name: "missing canonical property",
      result: { outcome: "not_found" },
      expectedStatus: 404,
      expectedCode: "property_setup_route_not_found",
    },
    {
      name: "track revision race",
      result: { outcome: "track_revision_conflict", currentRevision: 5 },
      expectedStatus: 409,
      expectedCode: "setup_track_revision_conflict",
      expectedBody: { currentRevision: 5 },
    },
    {
      name: "owner provider failure",
      result: { outcome: "provider_failure" },
      expectedStatus: 503,
      expectedCode: "property_setup_route_unavailable",
    },
    {
      name: "conflict with an unusable current revision",
      result: { outcome: "track_revision_conflict", currentRevision: -1 },
      expectedStatus: 503,
      expectedCode: "property_setup_route_unavailable",
    },
    {
      name: "duplicated owner fact",
      result: {
        outcome: "found",
        trackRevision: 4,
        session: null,
        ownerFacts: [
          ...makeOwnerFacts(["creator_marketplace"]),
          ...makeOwnerFacts(["creator_marketplace"]).slice(0, 1),
        ],
      },
      expectedStatus: 503,
      expectedCode: "property_setup_route_unavailable",
    },
    {
      name: "incoherent found revision",
      result: {
        outcome: "found",
        trackRevision: 3,
        session: null,
        ownerFacts: makeOwnerFacts(["creator_marketplace"]),
      },
      expectedStatus: 503,
      expectedCode: "property_setup_route_unavailable",
    },
  ] satisfies ReadonlyArray<{
    name: string;
    result: PropertySetupRouteStateReadResult;
    expectedStatus: number;
    expectedCode: string;
    expectedBody?: Readonly<Record<string, unknown>>;
  }>)(
    "maps $name without caching it",
    async ({ result, expectedStatus, expectedCode, expectedBody }) => {
      app = buildRouteApp({
        selectedTracks: ["creator_marketplace"],
        routeStateReadPort: {
          async getPropertySetupRouteState() {
            return result;
          },
        },
      });

      const response = await app.inject({
        method: "GET",
        url: `/api/hotel-setup/properties/${propertyId}/route`,
        headers: { authorization: "Bearer valid-token" },
      });

      expect(response.statusCode).toBe(expectedStatus);
      const body = response.json<{ code: string }>();
      expect(body.code).toBe(expectedCode);
      if (expectedBody) expect(body).toMatchObject(expectedBody);
      expect(response.headers["cache-control"]).toBe("private, no-store");
    },
  );

  it("fails closed when the owner snapshot is incomplete or stale", async () => {
    app = buildRouteApp({
      selectedTracks: ["creator_marketplace"],
      routeStateReadPort: {
        async getPropertySetupRouteState() {
          return {
            outcome: "found",
            trackRevision: 4,
            session: null,
            ownerFacts: makeOwnerFacts(["creator_marketplace"]).slice(1),
          };
        },
      },
    });

    const response = await app.inject({
      method: "GET",
      url: `/api/hotel-setup/properties/${propertyId}/route`,
      headers: { authorization: "Bearer valid-token" },
    });

    expect(response.statusCode).toBe(503);
    expect(response.json<{ code: string }>().code).toBe("property_setup_route_unavailable");
  });

  it("isolates authorization decisions from a mutating state adapter", async () => {
    let receivedFrozenInput = false;
    app = buildRouteApp({
      selectedTracks: ["creator_marketplace"],
      routeStateReadPort: {
        async getPropertySetupRouteState(input) {
          receivedFrozenInput =
            Object.isFrozen(input) &&
            Object.isFrozen(input.selectedTracks) &&
            Object.isFrozen(input.authorizedDraftStepIds);
          try {
            (input.selectedTracks as SetupTrack[]).push("hotel_operations");
          } catch {
            // Expected: adapters cannot mutate policy-checked input arrays.
          }
          return {
            outcome: "found",
            trackRevision: 4,
            session: makePropertySetupSession(),
            ownerFacts: makeOwnerFacts(["creator_marketplace"]),
          };
        },
      },
    });

    const response = await injectJson<PropertySetupRouteReadModel>(app, {
      method: "GET",
      url: `/api/hotel-setup/properties/${propertyId}/route`,
      headers: { authorization: "Bearer valid-token" },
    });

    expect(receivedFrozenInput).toBe(true);
    expect(response.statusCode).toBe(200);
    expect(response.body.selectedTracks).toEqual(["creator_marketplace"]);
    expect(response.body.steps.map(({ stepId }) => stepId)).toEqual([
      "present_hotel",
      "marketplace_preferences",
      "review",
    ]);
    expect(JSON.stringify(response.body)).not.toContain("booking.primary_color");
  });

  it("fails closed on a blocker from a product outside the selected tracks", async () => {
    const forbiddenMessage = "Booking's internal readiness detail.";
    app = buildRouteApp({
      selectedTracks: ["creator_marketplace"],
      routeStateReadPort: {
        async getPropertySetupRouteState() {
          return {
            outcome: "found",
            trackRevision: 4,
            session: null,
            ownerFacts: makeOwnerFacts(
              ["creator_marketplace"],
              [
                {
                  organizationId,
                  propertyId,
                  stepId: "review",
                  product: "hotel_catalog",
                  ownerDomain: "hotel_catalog",
                  state: "blocked",
                  sourceRevision: "review-r2",
                  currentBaseRevisions: {},
                  blockers: [
                    {
                      code: "booking_not_ready",
                      product: "booking",
                      ownerDomain: "booking",
                      owningStepId: "present_hotel",
                      message: forbiddenMessage,
                      kind: "system_error",
                      sourceRevision: "booking-r9",
                    },
                  ],
                },
              ],
            ),
          };
        },
      },
    });

    const response = await app.inject({
      method: "GET",
      url: `/api/hotel-setup/properties/${propertyId}/route`,
      headers: { authorization: "Bearer valid-token" },
    });

    expect(response.statusCode).toBe(503);
    expect(response.body).not.toContain(forbiddenMessage);
    expect(response.headers["cache-control"]).toBe("private, no-store");
  });

  it("requires a selected setup track before reading route state", async () => {
    const routeStateReadPort = {
      getPropertySetupRouteState: vi.fn(async () => ({ outcome: "not_found" as const })),
    };
    app = buildRouteApp({ selectedTracks: [], routeStateReadPort });

    const response = await injectJson<{ code: string }>(app, {
      method: "GET",
      url: `/api/hotel-setup/properties/${propertyId}/route`,
      headers: { authorization: "Bearer valid-token" },
    });

    expect(response.statusCode).toBe(409);
    expect(response.body.code).toBe("setup_track_selection_required");
    expect(routeStateReadPort.getPropertySetupRouteState).not.toHaveBeenCalled();
  });

  it("rejects malformed track status without a supported setup track", async () => {
    const routeStateReadPort = {
      getPropertySetupRouteState: vi.fn(async () => ({ outcome: "not_found" as const })),
    };
    app = buildRouteApp({
      routeStateReadPort,
      trackRepository: {
        ...makeTrackRepository(),
        getTrackStatus: vi.fn(async () => ({
          trackRevision: 4,
          selectedTracks: ["unsupported_track"] as unknown as SetupTrack[],
          tracks: [],
        })),
      },
    });

    const response = await injectJson<{ code: string }>(app, {
      method: "GET",
      url: `/api/hotel-setup/properties/${propertyId}/route`,
      headers: { authorization: "Bearer valid-token" },
    });

    expect(response.statusCode).toBe(409);
    expect(response.body.code).toBe("setup_track_selection_required");
    expect(routeStateReadPort.getPropertySetupRouteState).not.toHaveBeenCalled();
  });

  it("fails closed when selected setup tracks cannot be loaded", async () => {
    const routeStateReadPort = {
      getPropertySetupRouteState: vi.fn(async () => ({ outcome: "not_found" as const })),
    };
    app = buildRouteApp({
      routeStateReadPort,
      trackRepository: {
        ...makeTrackRepository(),
        getTrackStatus: vi.fn(async () => {
          throw new Error("track store unavailable");
        }),
      },
    });

    const response = await injectJson<{ code: string }>(app, {
      method: "GET",
      url: `/api/hotel-setup/properties/${propertyId}/route`,
      headers: { authorization: "Bearer valid-token" },
    });

    expect(response.statusCode).toBe(503);
    expect(response.body.code).toBe("property_setup_route_unavailable");
    expect(routeStateReadPort.getPropertySetupRouteState).not.toHaveBeenCalled();
  });
});

function buildRouteApp(options: {
  routeStateReadPort: PropertySetupRouteStateReadPort;
  selectedTracks?: Array<"hotel_operations" | "creator_marketplace">;
  trackRepository?: HotelSetupTrackCommandRepository;
  permissions?: PermissionKey[];
  linkedResources?: LinkedResource[];
  entitlements?: ProductEntitlement[];
  organization?: OrganizationOverride;
}): FastifyInstance {
  return buildApp({
    logger: false,
    propertySetupRouteStateReadPort: options.routeStateReadPort,
    hotelSetupTrackCommandRepository:
      options.trackRepository ?? makeTrackRepository(options.selectedTracks),
    auth: {
      verifier: createFakeVerifier(new Map([["valid-token", session]])),
      repository: identityRepository(options.linkedResources, options.organization),
      rolePermissionRepository: {
        async findPermissionsForRole() {
          return options.permissions ?? allPermissions;
        },
      },
      entitlementRepository: {
        async findEntitlementsForContext() {
          return options.entitlements ?? productEntitlements();
        },
      },
    },
  });
}

function makeTrackRepository(
  selectedTracks: Array<"hotel_operations" | "creator_marketplace"> = [
    "hotel_operations",
    "creator_marketplace",
  ],
): HotelSetupTrackCommandRepository {
  return {
    getTrackStatus: vi.fn(async () => ({
      trackRevision: 4,
      selectedTracks,
      tracks: [],
    })),
    async updateTracks() {
      throw new Error("not used by property setup route reads");
    },
    async close() {},
  };
}

function identityRepository(
  linkedResources?: LinkedResource[],
  organization?: OrganizationOverride,
): IdentityRepository {
  return {
    async findUserByProviderUserId() {
      return {
        userId,
        email: "owner@example.com",
        status: "active",
      };
    },
    async findOrganizationByWorkosOrgId() {
      return {
        organizationId,
        workosOrgId: session.workosOrgId ?? null,
        kind: organization?.kind ?? "hotel_group",
        status: organization?.status ?? "active",
      };
    },
    async findActiveMembership() {
      return {
        membershipId: "44444444-4444-4444-8444-444444444444",
        status: "active",
        roleKey: "hotel_owner",
        workosMembershipId: "om_hotel_owner",
        workosRoleSlugs: ["hotel_owner"],
      };
    },
    async findLinkedResources() {
      return linkedResources ?? productLinks();
    },
  };
}

function productLinks(): LinkedResource[] {
  return [
    resourceLink("hotel_catalog", "property"),
    resourceLink("marketplace", "hotel_profile"),
    resourceLink("booking", "booking_hotel"),
    resourceLink("pms", "pms_property"),
  ];
}

function resourceLink(
  product: LinkedResource["product"],
  resourceType: LinkedResource["resourceType"],
): LinkedResource {
  return {
    product,
    resourceType,
    resourceId: propertyId,
    relationship: "owner",
    status: "active",
  };
}

function productEntitlements(): ProductEntitlement[] {
  return [
    { product: "marketplace", key: "marketplace-hotel-profile", status: "active" },
    { product: "booking", key: "booking-engine", status: "active" },
    { product: "pms", key: "property-management", status: "active" },
  ];
}

function makePropertySetupSession(): PropertySetupSession {
  return {
    contractVersion: PROPERTY_SETUP_DRAFT_CONTRACT_VERSION,
    sessionId: "55555555-5555-4555-8555-555555555555",
    organizationId,
    propertyId,
    selectedTracks: ["hotel_operations", "creator_marketplace"],
    trackRevision: 4,
    revision: 6,
    resumeStepId: "booking_design",
    completedStepIds: [],
    drafts: [
      {
        stepId: "booking_design",
        payload: { "booking.primary_color": "#243ce5" },
        dirtyFields: ["booking.primary_color"],
        baseRevisions: {
          "booking.design": "design-r1",
          "hotel_catalog.profile": "profile-r1",
          "hotel_catalog.media": "media-r1",
        },
        piiClassification: "potential_incidental_pii",
        retentionExpiresAt,
        revision: 2,
        updatedAt: "2026-07-30T00:00:00.000Z",
      },
    ],
    retentionExpiresAt,
  };
}

function makeOwnerFacts(
  selectedTracks: readonly SetupTrack[],
  overrides: readonly PropertySetupRouteOwnerStepFact[] = [],
): PropertySetupRouteOwnerStepFact[] {
  const overridesByStep = new Map(overrides.map((fact) => [fact.stepId, fact]));
  return getActivePropertySetupStepIds(selectedTracks).map((stepId) => {
    const override = overridesByStep.get(stepId);
    return {
      organizationId,
      propertyId,
      stepId,
      ...ownerFactProvenance(stepId),
      state: "not_started",
      sourceRevision: `${stepId}-r1`,
      currentBaseRevisions: Object.fromEntries(
        PROPERTY_SETUP_STEP_DEFINITIONS.find(
          (definition) => definition.stepId === stepId,
        )!.baseRevisionKeys.map((key) => [key, `${key}:r1`]),
      ),
      blockers: [],
      ...override,
    };
  });
}

function ownerFactProvenance(
  stepId: PropertySetupRouteOwnerStepFact["stepId"],
): Pick<PropertySetupRouteOwnerStepFact, "product" | "ownerDomain"> {
  if (stepId === "marketplace_preferences") {
    return { product: "marketplace", ownerDomain: "marketplace" };
  }
  if (stepId === "booking_design" || stepId === "guest_experience") {
    return { product: "booking", ownerDomain: "booking" };
  }
  if (stepId === "rooms" || stepId === "pricing" || stepId === "calendar") {
    return { product: "pms", ownerDomain: "pms" };
  }
  if (stepId === "payments") return { product: "finance", ownerDomain: "finance" };
  return { product: "hotel_catalog", ownerDomain: "hotel_catalog" };
}
