import { readFileSync } from "node:fs";
import { request as httpRequest } from "node:http";

import {
  createFakeVerifier,
  type IdentityRepository,
  type LinkedResource,
  type PermissionKey,
  type ProductEntitlement,
  type RequestContext,
  type VerifiedSession,
} from "@vayada/backend-auth";
import { injectJson } from "@vayada/backend-test";
import type {
  AdaptiveHotelSetupStatus,
  PublicPropertyProfileResponse,
  SetupCommandError,
  SetupTask,
  SetupTaskId,
  TrackStatus,
  UpdateTracksResponse,
} from "@vayada/domain-hotels";
import type { FastifyInstance } from "fastify";
import type { QueryResultRow } from "pg";
import { afterEach, describe, expect, it, vi } from "vitest";

import { buildApp } from "./app.js";
import { agencyPropertyAccessRepository } from "./testAuthorization.js";
import type {
  HotelSetupTrackCommand,
  HotelSetupTrackCommandRepository,
} from "./domains/hotelSetupTrackCommandRepository.js";
import { createPgSharedHotelSetupStatusRepository } from "./platform/sharedHotelSetupStatusReadModel.js";
import {
  type AdaptivePropertySetupFacts,
  type SharedPropertyTypeCatalog,
  type SharedHotelSetupStatusRepository,
  type SharedPropertyLaunchSettingsRepository,
  type SharedPropertyProfile,
  type SharedPropertyProfileInput,
  buildPropertySetupPlan,
} from "./routes/sharedHotelSetupStatus.js";

const futureExpiry = Math.floor(Date.now() / 1000) + 3600;
const organizationId = "11111111-1111-4111-8111-111111111111";
const propertyId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const secondPropertyId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const unrelatedPropertyId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

const session: VerifiedSession = {
  workosUserId: "user_workos_hotel_owner",
  workosOrgId: "org_workos_hotel_group",
  sessionId: "session_hotel_owner",
  expiresAt: futureExpiry,
};

type TrackAuthorizationCase = {
  id: string;
  given: {
    authentication: "missing" | "invalid" | "valid";
    permissions: PermissionKey[];
    organizationKind: "hotel_group" | "creator_workspace";
    revokePermissionBeforeExactRetry?: boolean;
  };
  expected: {
    status: 200 | 401 | 403;
    errorCode?: "unauthenticated" | "missing_permission" | "invalid_organization_scope";
    category?: "authentication" | "authorization";
    message?: string;
    attemptRepositoryCalls: number;
  };
};

const commandSafetyFixture = JSON.parse(
  readFileSync(
    new URL("../../../engineering/fixtures/onboarding-command-safety/cases.json", import.meta.url),
    "utf8",
  ),
) as {
  baseRequest: {
    selectedTracks: UpdateTracksResponse["selectedTracks"];
    expectedRevision: number;
  };
  authorizationCases: TrackAuthorizationCase[];
};

let app: FastifyInstance | undefined;

afterEach(async () => {
  await app?.close();
  app = undefined;
});

describe("shared hotel setup status route", () => {
  it("returns the adaptive no-property selection without the retired V1 shape", async () => {
    const calls: Array<{ organizationId: string; propertyIds: string[] }> = [];
    app = buildSharedSetupApp({
      linkedResources: [],
      repository: {
        ...unusedPropertyProfileMethods(),
        async getHotelSetupStatus(input) {
          calls.push(input);
          return {
            hotelGroupDisplayName: "Alpenrose Hotel Group",
            hotelGroupWebsiteUrl: "https://alpenrose.example/",
            properties: [],
          };
        },
      },
    });

    const response = await injectJson<AdaptiveHotelSetupStatus>(app, {
      method: "GET",
      url: "/api/hotel-setup/status?entryProduct=booking&returnTo=/dashboard",
      headers: { authorization: "Bearer valid-token" },
    });

    expect(response.statusCode).toBe(200);
    expect(response.body).toMatchObject({
      contractVersion: "adaptive-hotel-setup.v1",
      organization: { organizationId, selectedTracks: [], trackRevision: 0 },
    });
    expect(response.body.propertySelection).toEqual({
      state: "no_property",
      selectedPropertyId: null,
      availableProperties: [],
    });
    expect(response.body.entryDecision).toEqual({
      requestedProduct: "booking",
      propertyId: null,
      decision: "setup_required",
      destinationRouteKey: "hotel_setup",
      reasonCode: "property_selection_required",
    });
    expect(response.body.setupPlan).toBeNull();
    expect(calls).toEqual([{ organizationId, propertyIds: [] }]);
  });

  it("returns the ordered property-type catalog without requiring an existing property", async () => {
    app = buildSharedSetupApp({
      linkedResources: [],
      repository: repositoryWith([]),
    });

    const response = await injectJson<SharedPropertyTypeCatalog>(app, {
      method: "GET",
      url: "/api/hotel-setup/property-types",
      headers: { authorization: "Bearer valid-token" },
    });

    expect(response.statusCode).toBe(200);
    expect(response.body).toEqual({
      contractVersion: "adaptive-hotel-property-types.v1",
      propertyTypes: [
        { value: "hotel", label: "Hotel" },
        { value: "resort", label: "Resort" },
        { value: "hostel", label: "Hostel" },
        { value: "apartment", label: "Apartment" },
        { value: "aparthotel", label: "Aparthotel" },
        { value: "guesthouse", label: "Guesthouse" },
        { value: "bed_and_breakfast", label: "Bed and breakfast" },
        { value: "villa", label: "Villa" },
        { value: "vacation_rental", label: "Vacation rental" },
        { value: "motel", label: "Motel" },
        { value: "other", label: "Other" },
      ],
    });
  });

  it("requires hotel setup read permission for the property-type catalog", async () => {
    app = buildSharedSetupApp({
      permissions: [],
      linkedResources: [],
      repository: repositoryWith([]),
    });

    const response = await injectJson<AdaptiveHotelSetupStatus>(app, {
      method: "GET",
      url: "/api/hotel-setup/property-types",
      headers: { authorization: "Bearer valid-token" },
    });

    expect(response.statusCode).toBe(403);
  });

  it("requires authentication for the property-type catalog", async () => {
    app = buildSharedSetupApp({
      linkedResources: [],
      repository: repositoryWith([]),
    });

    const response = await injectJson<AdaptiveHotelSetupStatus>(app, {
      method: "GET",
      url: "/api/hotel-setup/property-types",
    });

    expect(response.statusCode).toBe(401);
  });

  it("rejects non-hotel organizations for the property-type catalog", async () => {
    app = buildSharedSetupApp({
      organizationKind: "creator_workspace",
      linkedResources: [],
      repository: repositoryWith([]),
    });

    const response = await injectJson(app, {
      method: "GET",
      url: "/api/hotel-setup/property-types",
      headers: { authorization: "Bearer valid-token" },
    });

    expect(response.statusCode).toBe(403);
  });

  it("selects one property, requires selection for multiple, and filters unlinked rows", async () => {
    app = buildSharedSetupApp({
      linkedResources: [propertyLink(propertyId), propertyLink(secondPropertyId)],
      repository: repositoryWith([
        adaptiveProperty(propertyId),
        adaptiveProperty(unrelatedPropertyId),
        adaptiveProperty(secondPropertyId),
      ]),
    });

    const response = await injectJson<AdaptiveHotelSetupStatus>(app, {
      method: "GET",
      url: "/api/hotel-setup/status",
      headers: { authorization: "Bearer valid-token" },
    });

    expect(response.statusCode).toBe(200);
    expect(response.body.propertySelection).toMatchObject({
      state: "multiple_properties",
      selectedPropertyId: null,
    });
    expect(
      response.body.propertySelection.availableProperties.map((property) => property.propertyId),
    ).toEqual([propertyId, secondPropertyId]);
    expect(response.body.setupPlan).toBeNull();

    await app.close();
    app = buildSharedSetupApp({ repository: repositoryWith([adaptiveProperty(propertyId)]) });
    const single = await injectJson<AdaptiveHotelSetupStatus>(app, {
      method: "GET",
      url: "/api/hotel-setup/status",
      headers: { authorization: "Bearer valid-token" },
    });
    expect(single.body.propertySelection).toMatchObject({
      state: "single_property",
      selectedPropertyId: propertyId,
    });
  });

  it.each([
    [
      "operations",
      ["hotel_operations"],
      [
        "shared_identity",
        "rooms_rates_availability",
        "guest_settings_policies",
        "billing_plan",
        "payment",
        "direct_booking_publication",
      ],
    ],
    [
      "marketplace",
      ["creator_marketplace"],
      ["shared_identity", "public_profile", "creator_offer"],
    ],
    [
      "both",
      ["hotel_operations", "creator_marketplace"],
      [
        "shared_identity",
        "public_profile",
        "creator_offer",
        "rooms_rates_availability",
        "guest_settings_policies",
        "billing_plan",
        "payment",
        "direct_booking_publication",
      ],
    ],
  ] as const)(
    "filters setup tasks for %s selected tracks",
    async (_name, selectedTracks, expectedTaskIds) => {
      app = buildSharedSetupApp({
        permissions: ["hotel_catalog.setup.read", "hotel_catalog.setup.manage"],
        repository: repositoryWith([adaptiveProperty(propertyId)]),
        trackCommandRepository: trackRepository([...selectedTracks]),
      });

      const response = await injectJson<AdaptiveHotelSetupStatus>(app, {
        method: "GET",
        url: "/api/hotel-setup/status",
        headers: { authorization: "Bearer valid-token" },
      });

      expect(response.statusCode).toBe(200);
      expect(response.body.setupPlan?.tasks.map((task) => task.taskId)).toEqual(expectedTaskIds);
    },
  );

  it("limits an operator to permitted tasks and recommends only an actionable allowed task", async () => {
    app = buildSharedSetupApp({
      permissions: ["hotel_catalog.setup.read", "hotel_catalog.setup.manage"],
      repository: repositoryWith([
        adaptiveProperty(propertyId, {
          taskFacts: taskFacts({
            shared_identity: taskFact("shared_identity", {
              ownerProgress: "owner_complete",
              readiness: "complete",
            }),
            creator_offer: taskFact("creator_offer", {
              readiness: "pending_review",
              ownerProgress: "owner_complete",
            }),
          }),
        }),
      ]),
      trackCommandRepository: trackRepository(["creator_marketplace"]),
    });

    const response = await injectJson<AdaptiveHotelSetupStatus>(app, {
      method: "GET",
      url: "/api/hotel-setup/status",
      headers: { authorization: "Bearer valid-token" },
    });

    expect(response.body.setupPlan?.tasks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          taskId: "public_profile",
          callerCapability: "ask_owner",
          actionableBy: "owner",
        }),
        expect.objectContaining({
          taskId: "creator_offer",
          callerCapability: "waiting",
          actionableBy: "support",
        }),
      ]),
    );
    expect(response.body.setupPlan?.recommendedTaskId).toBeNull();
  });

  it("recommends a rejected Marketplace task for an allowed owner to correct", async () => {
    app = buildSharedSetupApp({
      permissions: [
        "hotel_catalog.setup.read",
        "hotel_catalog.setup.manage",
        "marketplace.profile.manage",
      ],
      repository: repositoryWith([
        adaptiveProperty(propertyId, {
          taskFacts: taskFacts({
            shared_identity: completedTaskFact("shared_identity"),
            public_profile: taskFact("public_profile", {
              ownerProgress: "in_progress",
              readiness: "rejected",
              reasonCodes: ["marketplace_profile_rejected"],
            }),
          }),
        }),
      ]),
      trackCommandRepository: trackRepository(["creator_marketplace"]),
    });

    const response = await injectJson<AdaptiveHotelSetupStatus>(app, {
      method: "GET",
      url: "/api/hotel-setup/status",
      headers: { authorization: "Bearer valid-token" },
    });

    expect(response.body.setupPlan?.recommendedTaskId).toBe("public_profile");
    expect(
      response.body.setupPlan?.tasks.find(({ taskId }) => taskId === "public_profile"),
    ).toMatchObject({
      callerCapability: "allowed",
      ownerProgress: "in_progress",
      readiness: "rejected",
      actionableBy: "owner",
      reasonCodes: ["marketplace_profile_rejected"],
    });
  });

  it("keeps publication repair actionable only after its true dependencies are complete", async () => {
    const completedFacts = taskFacts({
      shared_identity: completedTaskFact("shared_identity"),
      rooms_rates_availability: completedTaskFact("rooms_rates_availability"),
      guest_settings_policies: completedTaskFact("guest_settings_policies"),
      billing_plan: completedTaskFact("billing_plan"),
      payment: completedTaskFact("payment"),
      direct_booking_publication: taskFact("direct_booking_publication", {
        ownerProgress: "in_progress",
        readiness: "actionable",
        reasonCodes: ["bookability_setup_missing"],
      }),
    });
    const appOptions: {
      permissions: PermissionKey[];
      trackCommandRepository: HotelSetupTrackCommandRepository;
    } = {
      permissions: [
        "hotel_catalog.setup.read",
        "hotel_catalog.setup.manage",
        "pms.operations.manage",
        "booking.settings.manage",
      ],
      trackCommandRepository: trackRepository(["hotel_operations"]),
    };
    app = buildSharedSetupApp({
      ...appOptions,
      repository: repositoryWith([adaptiveProperty(propertyId, { taskFacts: completedFacts })]),
    });

    const repairable = await injectJson<AdaptiveHotelSetupStatus>(app, {
      method: "GET",
      url: "/api/hotel-setup/status",
      headers: { authorization: "Bearer valid-token" },
    });
    expect(repairable.body.setupPlan?.recommendedTaskId).toBe("direct_booking_publication");
    expect(
      repairable.body.setupPlan?.tasks.find(
        ({ taskId }) => taskId === "direct_booking_publication",
      ),
    ).toMatchObject({ readiness: "actionable", callerCapability: "allowed" });

    await app.close();
    app = buildSharedSetupApp({
      ...appOptions,
      repository: repositoryWith([
        adaptiveProperty(propertyId, {
          taskFacts: {
            ...completedFacts,
            payment: taskFact("payment"),
          },
        }),
      ]),
    });

    const dependencyBlocked = await injectJson<AdaptiveHotelSetupStatus>(app, {
      method: "GET",
      url: "/api/hotel-setup/status",
      headers: { authorization: "Bearer valid-token" },
    });
    expect(
      dependencyBlocked.body.setupPlan?.tasks.find(
        ({ taskId }) => taskId === "direct_booking_publication",
      ),
    ).toMatchObject({
      readiness: "blocked",
      callerCapability: "allowed",
      reasonCodes: expect.arrayContaining(["task_dependencies_incomplete", "payment_incomplete"]),
    });
  });

  it("derives a stable plan revision from the complete authoritative plan state", () => {
    const property = adaptiveProperty(propertyId, {
      taskFacts: taskFacts({
        shared_identity: completedTaskFact("shared_identity"),
        rooms_rates_availability: completedTaskFact("rooms_rates_availability"),
        guest_settings_policies: completedTaskFact("guest_settings_policies"),
        billing_plan: completedTaskFact("billing_plan"),
        payment: completedTaskFact("payment"),
        direct_booking_publication: completedTaskFact("direct_booking_publication"),
      }),
    });
    const tracks: TrackStatus[] = [
      {
        track: "hotel_operations",
        provisioning: "active",
        components: [
          { product: "pms", access: "active" },
          { product: "booking", access: "active" },
        ],
        allowedActions: ["manage_service"],
      },
    ];
    const permissions: PermissionKey[] = [
      "hotel_catalog.setup.read",
      "hotel_catalog.setup.manage",
      "pms.operations.manage",
      "booking.settings.manage",
    ];
    const entitlements: ProductEntitlement[] = [
      { product: "pms", key: "property-management", status: "active" },
      { product: "booking", key: "booking-engine", status: "active" },
    ];
    const context = setupPlanContext({ permissions, entitlements });
    const buildPlan = (overrides: Partial<Parameters<typeof buildPropertySetupPlan>[0]> = {}) =>
      buildPropertySetupPlan({
        context,
        property,
        selectedTracks: ["hotel_operations"],
        trackRevision: 4,
        tracks,
        evaluatedAt: "2026-07-26T10:00:00.000Z",
        ...overrides,
      });
    const original = buildPlan();

    expect(original.launchReadiness.directBookingPublish).toBe("ready");
    expect(buildPlan({ evaluatedAt: "2026-07-27T10:00:00.000Z" }).planRevision).toBe(
      original.planRevision,
    );
    expect(
      buildPlan({
        context: setupPlanContext({
          permissions,
          entitlements: [...entitlements].reverse(),
          linkedResources: [...setupPlanLinks()].reverse(),
        }),
        tracks: tracks.map((track) => ({
          ...track,
          components: [...track.components].reverse(),
        })),
      }).planRevision,
    ).toBe(original.planRevision);
    expect(original.planRevision).toMatch(/^plan\.v2:[A-Za-z0-9_-]{43}$/);

    const changedPermission = buildPlan({
      context: setupPlanContext({
        permissions: permissions.filter((permission) => permission !== "pms.operations.manage"),
        entitlements,
      }),
    });
    expect(changedPermission.planRevision).not.toBe(original.planRevision);
    expect(
      changedPermission.tasks.find(({ taskId }) => taskId === "rooms_rates_availability"),
    ).toMatchObject({ callerCapability: "ask_owner", sourceRevision: "1" });

    const changedEntitlement = buildPlan({
      context: setupPlanContext({
        permissions,
        entitlements: entitlements.map((entitlement) =>
          entitlement.product === "pms"
            ? { ...entitlement, status: "suspended" as const }
            : entitlement,
        ),
      }),
    });
    expect(changedEntitlement.planRevision).not.toBe(original.planRevision);

    const changedResourceLink = buildPlan({
      context: setupPlanContext({
        permissions,
        entitlements,
        linkedResources: setupPlanLinks().filter(({ product }) => product !== "pms"),
      }),
    });
    expect(changedResourceLink.planRevision).not.toBe(original.planRevision);
    expect(
      changedResourceLink.tasks.find(({ taskId }) => taskId === "rooms_rates_availability"),
    ).toMatchObject({
      readiness: "blocked",
      reasonCodes: expect.arrayContaining(["task_product_access_blocked"]),
      sourceRevision: "1",
    });

    const changedComponentAccess = buildPlan({
      tracks: tracks.map((track) => ({
        ...track,
        components: track.components.map((component) =>
          component.product === "pms" ? { ...component, access: "suspended" as const } : component,
        ),
      })),
    });
    expect(changedComponentAccess.planRevision).not.toBe(original.planRevision);

    const changedReadiness = buildPlan({
      property: {
        ...property,
        taskFacts: {
          ...property.taskFacts,
          payment: {
            ...property.taskFacts.payment,
            ownerProgress: "in_progress",
            readiness: "actionable",
          },
        },
      },
    });
    expect(changedReadiness.planRevision).not.toBe(original.planRevision);
    expect(changedReadiness.launchReadiness.directBookingPublish).toBe("pending");
    expect(changedReadiness.tasks.find(({ taskId }) => taskId === "payment")?.sourceRevision).toBe(
      property.taskFacts.payment.sourceRevision,
    );

    const changedReason = buildPlan({
      property: {
        ...property,
        taskFacts: {
          ...property.taskFacts,
          payment: {
            ...property.taskFacts.payment,
            reasonCodes: ["payment_review_recommended"],
          },
        },
      },
    });
    expect(changedReason.planRevision).not.toBe(original.planRevision);

    expect(
      buildPlan({ property: { ...property, displayName: "Alpenrose Berlin" } }).planRevision,
    ).not.toBe(original.planRevision);
  });

  it("keeps entry decisions independent from property setup readiness", async () => {
    app = buildSharedSetupApp({
      permissions: ["hotel_catalog.setup.read", "booking.analytics.read"],
      linkedResources: [
        propertyLink(propertyId),
        productLink("booking", "booking_hotel", propertyId),
      ],
      repository: repositoryWith([
        adaptiveProperty(propertyId, {
          taskFacts: taskFacts({
            shared_identity: taskFact("shared_identity", { readiness: "rejected" }),
          }),
        }),
      ]),
      trackCommandRepository: trackRepository(["hotel_operations"]),
    });

    const response = await injectJson<AdaptiveHotelSetupStatus>(app, {
      method: "GET",
      url: "/api/hotel-setup/status?entryProduct=booking",
      headers: { authorization: "Bearer valid-token" },
    });

    expect(response.body.entryDecision).toMatchObject({ decision: "enter", reasonCode: null });
    expect(response.body.setupPlan?.tasks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ taskId: "shared_identity", readiness: "rejected" }),
      ]),
    );
  });

  it("keeps an active product usable when another Operations component is blocked", async () => {
    const trackCommandRepository: HotelSetupTrackCommandRepository = {
      async updateTracks() {
        throw new Error("setup track writes are not used by this test");
      },
      async getTrackStatus() {
        return {
          trackRevision: 1,
          selectedTracks: ["hotel_operations"],
          tracks: [
            {
              track: "hotel_operations",
              provisioning: "blocked",
              components: [
                { product: "pms", access: "absent" },
                { product: "booking", access: "active" },
              ],
              allowedActions: ["manage_service"],
            },
            {
              track: "creator_marketplace",
              provisioning: "not_selected",
              components: [{ product: "marketplace", access: "absent" }],
              allowedActions: ["add"],
            },
          ],
        };
      },
      async close() {},
    };
    app = buildSharedSetupApp({
      permissions: ["hotel_catalog.setup.read", "booking.analytics.read"],
      linkedResources: [
        propertyLink(propertyId),
        productLink("booking", "booking_hotel", propertyId),
      ],
      repository: repositoryWith([
        adaptiveProperty(propertyId, {
          taskFacts: taskFacts({
            shared_identity: taskFact("shared_identity", {
              readiness: "complete",
              ownerProgress: "owner_complete",
            }),
          }),
        }),
      ]),
      trackCommandRepository,
    });

    const response = await injectJson<AdaptiveHotelSetupStatus>(app, {
      method: "GET",
      url: "/api/hotel-setup/status?entryProduct=booking",
      headers: { authorization: "Bearer valid-token" },
    });

    expect(response.body.entryDecision).toMatchObject({ decision: "enter", reasonCode: null });
    expect(response.body.setupPlan?.tasks.find(({ taskId }) => taskId === "payment")).toMatchObject(
      {
        readiness: "actionable",
        reasonCodes: expect.not.arrayContaining(["task_product_access_blocked"]),
      },
    );
    expect(
      response.body.setupPlan?.tasks.find(({ taskId }) => taskId === "rooms_rates_availability"),
    ).toMatchObject({
      readiness: "blocked",
      reasonCodes: expect.arrayContaining(["task_product_access_blocked"]),
    });
  });

  it.each([
    ["booking", "hotel_operations", "booking", "booking_hotel"],
    ["pms", "hotel_operations", "pms", "pms_property"],
    ["marketplace", "creator_marketplace", "marketplace", "hotel_profile"],
  ] as const)(
    "does not enter %s with only an active entitlement and resource link",
    async (entryProduct, selectedTrack, product, resourceType) => {
      app = buildSharedSetupApp({
        permissions: ["hotel_catalog.setup.read"],
        linkedResources: [propertyLink(propertyId), productLink(product, resourceType, propertyId)],
        repository: repositoryWith([adaptiveProperty(propertyId)]),
        trackCommandRepository: trackRepository([selectedTrack]),
      });

      const response = await injectJson<AdaptiveHotelSetupStatus>(app, {
        method: "GET",
        url: `/api/hotel-setup/status?entryProduct=${entryProduct}`,
        headers: { authorization: "Bearer valid-token" },
      });

      expect(response.body.entryDecision).toEqual({
        requestedProduct: entryProduct,
        propertyId,
        decision: "unavailable",
        destinationRouteKey: null,
        reasonCode: "workspace_permission_missing",
      });
    },
  );

  it("sends a blocked track to service management instead of an unresolvable setup loop", async () => {
    app = buildSharedSetupApp({
      linkedResources: [propertyLink(propertyId)],
      repository: repositoryWith([adaptiveProperty(propertyId)]),
      trackCommandRepository: {
        async updateTracks() {
          throw new Error("setup track writes are not used by this test");
        },
        async getTrackStatus() {
          return {
            trackRevision: 1,
            selectedTracks: ["creator_marketplace"],
            tracks: [
              {
                track: "hotel_operations",
                provisioning: "not_selected",
                components: [
                  { product: "pms", access: "absent" },
                  { product: "booking", access: "absent" },
                ],
                allowedActions: ["add"],
              },
              {
                track: "creator_marketplace",
                provisioning: "blocked",
                components: [{ product: "marketplace", access: "absent" }],
                allowedActions: ["manage_service"],
              },
            ],
          };
        },
        async close() {},
      },
    });

    const response = await injectJson<AdaptiveHotelSetupStatus>(app, {
      method: "GET",
      url: "/api/hotel-setup/status?entryProduct=marketplace",
      headers: { authorization: "Bearer valid-token" },
    });

    expect(response.body.entryDecision).toEqual({
      requestedProduct: "marketplace",
      propertyId,
      decision: "unavailable",
      destinationRouteKey: null,
      reasonCode: "service_management_required",
    });
  });

  it("reports a required domain failure as blocked launch readiness", async () => {
    app = buildSharedSetupApp({
      permissions: [
        "hotel_catalog.setup.read",
        "hotel_catalog.setup.manage",
        "pms.operations.manage",
        "booking.settings.manage",
      ],
      repository: repositoryWith([
        adaptiveProperty(propertyId, {
          taskFacts: taskFacts({
            shared_identity: taskFact("shared_identity", {
              readiness: "complete",
              ownerProgress: "owner_complete",
            }),
            rooms_rates_availability: taskFact("rooms_rates_availability", {
              readiness: "complete",
              ownerProgress: "owner_complete",
            }),
            guest_settings_policies: taskFact("guest_settings_policies", {
              readiness: "complete",
              ownerProgress: "owner_complete",
            }),
            payment: taskFact("payment", {
              readiness: "blocked",
              ownerProgress: "in_progress",
              reasonCodes: ["payment_provider_blocked"],
            }),
            direct_booking_publication: taskFact("direct_booking_publication", {
              readiness: "complete",
              ownerProgress: "owner_complete",
            }),
          }),
        }),
      ]),
      trackCommandRepository: trackRepository(["hotel_operations"]),
    });

    const response = await injectJson<AdaptiveHotelSetupStatus>(app, {
      method: "GET",
      url: "/api/hotel-setup/status",
      headers: { authorization: "Bearer valid-token" },
    });

    expect(response.body.setupPlan?.launchReadiness).toEqual({
      operationsUse: "ready",
      directBookingPublish: "blocked",
      marketplacePublish: "not_applicable",
    });
  });

  it("canonicalizes and delegates setup tracks with authenticated audit context", async () => {
    const calls: HotelSetupTrackCommand[] = [];
    const responseBody: UpdateTracksResponse = {
      trackRevision: 3,
      selectedTracks: ["hotel_operations", "creator_marketplace"],
      tracks: [
        {
          track: "hotel_operations",
          provisioning: "active",
          components: [
            { product: "pms", access: "active" },
            { product: "booking", access: "active" },
          ],
          allowedActions: [],
        },
        {
          track: "creator_marketplace",
          provisioning: "active",
          components: [{ product: "marketplace", access: "active" }],
          allowedActions: [],
        },
      ],
    };
    app = buildSharedSetupApp({
      permissions: ["hotel_catalog.setup.read", "hotel_catalog.products.manage"],
      repository: repositoryWith([]),
      trackCommandRepository: {
        async updateTracks(command) {
          calls.push(command);
          return { ok: true, response: responseBody };
        },
        getTrackStatus: unusedTrackCommandRepository().getTrackStatus,
        async close() {},
      },
    });

    const response = await injectJson(app, {
      method: "PUT",
      url: "/api/hotel-setup/tracks",
      headers: {
        authorization: "Bearer valid-token",
        "idempotency-key": "  setup-tracks-001  ",
      },
      payload: {
        selectedTracks: ["creator_marketplace", "hotel_operations"],
        expectedRevision: 2,
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.body).toEqual(responseBody);
    expect(calls).toEqual([
      {
        selectedTracks: ["hotel_operations", "creator_marketplace"],
        expectedRevision: 2,
        idempotencyKey: "setup-tracks-001",
        actorUserId: "user_hotel_owner",
        audit: expect.objectContaining({
          requestId: expect.any(String),
          source: "api",
          receivedAt: expect.any(String),
        }),
        organizationId,
      },
    ]);
  });

  it("rejects invalid track requests and Idempotency-Key headers before delegation", async () => {
    const updateTracks = vi.fn<HotelSetupTrackCommandRepository["updateTracks"]>();
    app = buildSharedSetupApp({
      permissions: ["hotel_catalog.products.manage"],
      repository: repositoryWith([]),
      trackCommandRepository: {
        updateTracks,
        getTrackStatus: unusedTrackCommandRepository().getTrackStatus,
        async close() {},
      },
    });

    const validPayload = {
      selectedTracks: ["hotel_operations"],
      expectedRevision: 0,
    };
    const cases = [
      {
        name: "invalid payload",
        headers: {
          authorization: "Bearer valid-token",
          "idempotency-key": "invalid-payload",
        },
        payload: { selectedTracks: ["booking"], expectedRevision: 0 },
      },
      {
        name: "missing key",
        headers: { authorization: "Bearer valid-token" },
        payload: validPayload,
      },
      {
        name: "blank key",
        headers: { authorization: "Bearer valid-token", "idempotency-key": "   " },
        payload: validPayload,
      },
      {
        name: "oversized key",
        headers: { authorization: "Bearer valid-token", "idempotency-key": "x".repeat(201) },
        payload: validPayload,
      },
    ];

    for (const request of cases) {
      const response = await injectJson<{ code: string; detail: string }>(app, {
        method: "PUT",
        url: "/api/hotel-setup/tracks",
        headers: request.headers,
        payload: request.payload,
      });

      expect(response.statusCode, `${request.name}: ${JSON.stringify(response.body)}`).toBe(422);
      expect(response.body).toMatchObject({
        code: "invalid_setup_request",
        detail: expect.any(String),
      });
    }
    expect(updateTracks).not.toHaveBeenCalled();
  });

  it("rejects repeated Idempotency-Key headers", async () => {
    const updateTracks = vi.fn<HotelSetupTrackCommandRepository["updateTracks"]>();
    app = buildSharedSetupApp({
      permissions: ["hotel_catalog.products.manage"],
      repository: repositoryWith([]),
      trackCommandRepository: {
        updateTracks,
        getTrackStatus: unusedTrackCommandRepository().getTrackStatus,
        async close() {},
      },
    });
    const payload = JSON.stringify({
      selectedTracks: ["hotel_operations"],
      expectedRevision: 0,
    });

    const response = await requestWithRawHeaders(app, payload, {
      authorization: "Bearer valid-token",
      "content-type": "application/json",
      "content-length": String(Buffer.byteLength(payload)),
      "idempotency-key": ["first", "second"],
    });

    expect(response.statusCode).toBe(422);
    expect(response.body).toMatchObject({ code: "invalid_setup_request" });
    expect(updateTracks).not.toHaveBeenCalled();
  });

  it("returns setup track command conflicts unchanged with status 409", async () => {
    const conflict: SetupCommandError = {
      code: "track_revision_conflict",
      currentRevision: 2,
    };
    app = buildSharedSetupApp({
      permissions: ["hotel_catalog.products.manage"],
      repository: repositoryWith([]),
      trackCommandRepository: {
        async updateTracks() {
          return { ok: false, error: conflict };
        },
        getTrackStatus: unusedTrackCommandRepository().getTrackStatus,
        async close() {},
      },
    });

    const response = await injectJson<SetupCommandError>(app, {
      method: "PUT",
      url: "/api/hotel-setup/tracks",
      headers: {
        authorization: "Bearer valid-token",
        "idempotency-key": "revision-conflict",
      },
      payload: {
        selectedTracks: ["hotel_operations"],
        expectedRevision: 0,
      },
    });

    expect(response.statusCode).toBe(409);
    expect(response.body).toEqual(conflict);
  });

  it("passes the fixture-driven setup track authorization matrix before repository replay", async () => {
    expect(commandSafetyFixture.authorizationCases.map(({ id }) => id)).toEqual([
      "missing_auth",
      "invalid_bearer",
      "missing_permission",
      "wrong_organization_scope",
      "permission_revoked_before_exact_retry",
      "allowed",
    ]);

    for (const authorizationCase of commandSafetyFixture.authorizationCases) {
      const permissions = [...authorizationCase.given.permissions];
      let repositoryCalls = 0;
      const responseBody: UpdateTracksResponse = {
        trackRevision: 1,
        selectedTracks: [],
        tracks: [],
      };
      app = buildSharedSetupApp({
        organizationKind: authorizationCase.given.organizationKind,
        permissions,
        linkedResources: [],
        repository: repositoryWith([]),
        trackCommandRepository: {
          async updateTracks() {
            repositoryCalls += 1;
            return { ok: true, response: responseBody };
          },
          getTrackStatus: unusedTrackCommandRepository().getTrackStatus,
          async close() {},
        },
      });

      const request = {
        method: "PUT" as const,
        url: "/api/hotel-setup/tracks",
        headers: {
          ...(authorizationCase.given.authentication === "missing"
            ? {}
            : {
                authorization:
                  authorizationCase.given.authentication === "valid"
                    ? "Bearer valid-token"
                    : "Bearer invalid-token",
              }),
          "idempotency-key": `authorization-${authorizationCase.id}`,
        },
        payload: {
          selectedTracks: commandSafetyFixture.baseRequest.selectedTracks,
          expectedRevision: commandSafetyFixture.baseRequest.expectedRevision,
        },
      };

      if (authorizationCase.given.revokePermissionBeforeExactRetry) {
        const firstAttempt = await injectJson(app, request);
        expect(firstAttempt.statusCode, authorizationCase.id).toBe(200);
        expect(repositoryCalls, authorizationCase.id).toBe(1);
        permissions.splice(0, permissions.length);
      }

      const repositoryCallsBeforeAttempt = repositoryCalls;
      const response = await injectJson<Record<string, unknown>>(app, request);
      expect(response.statusCode, authorizationCase.id).toBe(authorizationCase.expected.status);
      expect(repositoryCalls - repositoryCallsBeforeAttempt, authorizationCase.id).toBe(
        authorizationCase.expected.attemptRepositoryCalls,
      );

      if (authorizationCase.expected.errorCode) {
        expect(response.body, authorizationCase.id).toEqual({
          statusCode: authorizationCase.expected.status,
          code: authorizationCase.expected.errorCode,
          category: authorizationCase.expected.category,
          message: authorizationCase.expected.message,
        });
      }

      await app.close();
      app = undefined;
    }
  });

  it("denies unauthorized setup track requests before parsing malformed JSON", async () => {
    const malformedPayload = '{"selectedTracks":';
    const deniedCases = commandSafetyFixture.authorizationCases.filter(
      ({ id }) => id !== "allowed" && id !== "permission_revoked_before_exact_retry",
    );

    for (const authorizationCase of deniedCases) {
      const updateTracks = vi.fn<HotelSetupTrackCommandRepository["updateTracks"]>();
      app = buildSharedSetupApp({
        organizationKind: authorizationCase.given.organizationKind,
        permissions: authorizationCase.given.permissions,
        linkedResources: [],
        repository: repositoryWith([]),
        trackCommandRepository: {
          updateTracks,
          getTrackStatus: unusedTrackCommandRepository().getTrackStatus,
          async close() {},
        },
      });
      const response = await requestWithRawHeaders(app, malformedPayload, {
        ...(authorizationCase.given.authentication === "missing"
          ? {}
          : {
              authorization:
                authorizationCase.given.authentication === "valid"
                  ? "Bearer valid-token"
                  : "Bearer invalid-token",
            }),
        "content-type": "application/json",
        "content-length": String(Buffer.byteLength(malformedPayload)),
        "idempotency-key": `malformed-${authorizationCase.id}`,
      });

      expect(response.statusCode, authorizationCase.id).toBe(authorizationCase.expected.status);
      expect(response.body, authorizationCase.id).toEqual({
        statusCode: authorizationCase.expected.status,
        code: authorizationCase.expected.errorCode,
        category: authorizationCase.expected.category,
        message: authorizationCase.expected.message,
      });
      expect(updateTracks, authorizationCase.id).not.toHaveBeenCalled();

      await app.close();
      app = undefined;
    }
  });

  it("checks revoked permission before parsing a malformed exact retry", async () => {
    const permissions: PermissionKey[] = ["hotel_catalog.products.manage"];
    const updateTracks = vi.fn<HotelSetupTrackCommandRepository["updateTracks"]>(async () => ({
      ok: true,
      response: { trackRevision: 1, selectedTracks: [], tracks: [] },
    }));
    app = buildSharedSetupApp({
      permissions,
      linkedResources: [],
      repository: repositoryWith([]),
      trackCommandRepository: {
        updateTracks,
        getTrackStatus: unusedTrackCommandRepository().getTrackStatus,
        async close() {},
      },
    });
    const authorizationCase = commandSafetyFixture.authorizationCases.find(
      ({ id }) => id === "permission_revoked_before_exact_retry",
    );
    if (!authorizationCase) throw new Error("Missing revoked-permission authorization fixture");
    const headers = {
      authorization: "Bearer valid-token",
      "content-type": "application/json",
      "idempotency-key": `authorization-${authorizationCase.id}`,
    };

    const firstAttempt = await injectJson(app, {
      method: "PUT",
      url: "/api/hotel-setup/tracks",
      headers,
      payload: {
        selectedTracks: commandSafetyFixture.baseRequest.selectedTracks,
        expectedRevision: commandSafetyFixture.baseRequest.expectedRevision,
      },
    });
    expect(firstAttempt.statusCode).toBe(200);
    expect(updateTracks).toHaveBeenCalledTimes(1);

    permissions.splice(0, permissions.length);
    const malformedPayload = '{"selectedTracks":';
    const retry = await requestWithRawHeaders(app, malformedPayload, {
      ...headers,
      "content-length": String(Buffer.byteLength(malformedPayload)),
    });

    expect(retry.statusCode).toBe(authorizationCase.expected.status);
    expect(retry.body).toEqual({
      statusCode: authorizationCase.expected.status,
      code: authorizationCase.expected.errorCode,
      category: authorizationCase.expected.category,
      message: authorizationCase.expected.message,
    });
    expect(updateTracks).toHaveBeenCalledTimes(1);
  });

  it("parses the body only after setup track authorization succeeds", async () => {
    const updateTracks = vi.fn<HotelSetupTrackCommandRepository["updateTracks"]>();
    app = buildSharedSetupApp({
      permissions: ["hotel_catalog.products.manage"],
      linkedResources: [],
      repository: repositoryWith([]),
      trackCommandRepository: {
        updateTracks,
        getTrackStatus: unusedTrackCommandRepository().getTrackStatus,
        async close() {},
      },
    });
    const malformedPayload = '{"selectedTracks":';

    const response = await requestWithRawHeaders(app, malformedPayload, {
      authorization: "Bearer valid-token",
      "content-type": "application/json",
      "content-length": String(Buffer.byteLength(malformedPayload)),
      "idempotency-key": "malformed-allowed",
    });

    expect(response.statusCode).toBe(400);
    expect(updateTracks).not.toHaveBeenCalled();
  });

  it("creates the first canonical property profile with explicit contact metadata", async () => {
    const input = minimalHotelInput();
    const createPropertyProfile = vi.fn(
      async ({ profile }: { profile: SharedPropertyProfileInput }) =>
        profileResponse(propertyId, profile),
    );
    app = buildSharedSetupApp({
      linkedResources: [],
      permissions: ["hotel_catalog.setup.read", "hotel_catalog.setup.manage"],
      repository: {
        ...unusedStatusMethods(),
        ...unusedPropertyProfileMethods(),
        createPropertyProfile,
      },
    });

    const response = await injectJson<SharedPropertyProfile>(app, {
      method: "POST",
      url: "/api/hotel-setup/properties",
      headers: {
        authorization: "Bearer valid-token",
        "idempotency-key": "create-alpenrose-munich",
      },
      payload: input,
    });

    expect(response.statusCode).toBe(201);
    expect(response.body).toEqual(profileResponse(propertyId, input));
    expect(createPropertyProfile).toHaveBeenCalledWith(
      expect.objectContaining({
        organizationId,
        idempotencyKey: "create-alpenrose-munich",
        correlationId: expect.any(String),
        profile: input,
      }),
    );
  });

  it("rejects unauthenticated property creation before validating its body", async () => {
    const createPropertyProfile = vi.fn();
    app = buildSharedSetupApp({
      linkedResources: [],
      repository: {
        ...unusedStatusMethods(),
        ...unusedPropertyProfileMethods(),
        createPropertyProfile,
      },
    });

    const response = await injectJson<Record<string, unknown>>(app, {
      method: "POST",
      url: "/api/hotel-setup/properties",
      payload: {},
    });

    expect(response.statusCode).toBe(401);
    expect(response.body.code).not.toBe("invalid_setup_request");
    expect(createPropertyProfile).not.toHaveBeenCalled();
  });

  it("requires one stable Idempotency-Key for property creation", async () => {
    const createPropertyProfile = vi.fn();
    app = buildSharedSetupApp({
      linkedResources: [],
      permissions: ["hotel_catalog.setup.read", "hotel_catalog.setup.manage"],
      repository: {
        ...unusedStatusMethods(),
        ...unusedPropertyProfileMethods(),
        createPropertyProfile,
      },
    });

    const response = await injectJson<{ code: string }>(app, {
      method: "POST",
      url: "/api/hotel-setup/properties",
      headers: { authorization: "Bearer valid-token" },
      payload: minimalHotelInput(),
    });

    expect(response.statusCode).toBe(422);
    expect(response.body.code).toBe("invalid_setup_request");
    expect(createPropertyProfile).not.toHaveBeenCalled();
  });

  it.each([
    {
      code: "idempotency_key_conflict",
      detail: "These hotel details changed during the save. Review them and try again.",
      propertyId,
    },
    {
      code: "command_in_progress",
      detail: "Your hotel setup is still being saved. Please try again in a moment.",
      propertyId: null,
    },
  ] as const)("returns a useful message for property create conflict $code", async (conflict) => {
    const createPropertyProfile = vi.fn(async () => {
      throw Object.assign(new Error(conflict.code), {
        code: conflict.code,
        ...(conflict.propertyId ? { propertyId: conflict.propertyId } : {}),
      });
    });
    app = buildSharedSetupApp({
      linkedResources: [],
      permissions: ["hotel_catalog.setup.read", "hotel_catalog.setup.manage"],
      repository: {
        ...unusedStatusMethods(),
        ...unusedPropertyProfileMethods(),
        createPropertyProfile,
      },
    });

    const response = await injectJson<{ code: string; detail: string; propertyId?: string }>(app, {
      method: "POST",
      url: "/api/hotel-setup/properties",
      headers: {
        authorization: "Bearer valid-token",
        "idempotency-key": "create-alpenrose-munich",
      },
      payload: minimalHotelInput(),
    });

    expect(response.statusCode).toBe(409);
    expect(response.body).toEqual({
      code: conflict.code,
      detail: conflict.detail,
      ...(conflict.propertyId ? { propertyId: conflict.propertyId } : {}),
    });
  });

  it("requires owner permission when property creation exposes map or contact data", async () => {
    const createPropertyProfile = vi.fn();
    const input = minimalHotelInput();
    app = buildSharedSetupApp({
      linkedResources: [],
      permissions: ["hotel_catalog.setup.read", "hotel_catalog.setup.manage"],
      repository: {
        ...unusedStatusMethods(),
        ...unusedPropertyProfileMethods(),
        createPropertyProfile,
      },
    });

    const response = await injectJson<{ code: string }>(app, {
      method: "POST",
      url: "/api/hotel-setup/properties",
      headers: {
        authorization: "Bearer valid-token",
        "idempotency-key": "operator-public-property",
      },
      payload: {
        ...input,
        location: {
          ...input.location,
          latitude: 48.137,
          longitude: 11.575,
          geoPublic: true,
          mapDisplayMode: "exact",
        },
        contacts: input.contacts.map((contact) => ({
          ...contact,
          isPublic: contact.channelType === "email",
        })),
      },
    });

    expect(response.statusCode).toBe(403);
    expect(response.body.code).toBe("missing_permission");
    expect(createPropertyProfile).not.toHaveBeenCalled();
  });

  it("defaults omitted address and coordinate visibility to private", async () => {
    const input = minimalHotelInput();
    const {
      localityPublic: _localityPublic,
      geoPublic: _geoPublic,
      mapDisplayMode: _mapDisplayMode,
      ...location
    } = input.location;
    const createPropertyProfile = vi.fn(
      async ({ profile }: { profile: SharedPropertyProfileInput }) =>
        profileResponse(propertyId, profile),
    );
    app = buildSharedSetupApp({
      linkedResources: [],
      permissions: ["hotel_catalog.setup.read", "hotel_catalog.setup.manage"],
      repository: {
        ...unusedStatusMethods(),
        ...unusedPropertyProfileMethods(),
        createPropertyProfile,
      },
    });

    const response = await injectJson<SharedPropertyProfile>(app, {
      method: "POST",
      url: "/api/hotel-setup/properties",
      headers: {
        authorization: "Bearer valid-token",
        "idempotency-key": "create-private-address-hotel",
      },
      payload: { ...input, location },
    });

    expect(response.statusCode).toBe(201);
    expect(createPropertyProfile.mock.calls[0]![0].profile.location).toMatchObject({
      localityPublic: false,
      geoPublic: false,
      mapDisplayMode: "hidden",
    });
  });

  it("reads and sparsely updates a canonical property profile without clearing omitted fields", async () => {
    const profiles = new Map<string, SharedPropertyProfile>([
      [propertyId, profileResponse(propertyId, minimalHotelInput(), 7)],
    ]);
    app = buildSharedSetupApp({
      permissions: [
        "hotel_catalog.setup.read",
        "hotel_catalog.setup.manage",
        "marketplace.profile.manage",
      ],
      repository: profileRepository(profiles),
    });

    const readResponse = await injectJson<SharedPropertyProfile>(app, {
      method: "GET",
      url: "/api/hotel-setup/properties/" + propertyId + "/profile",
      headers: { authorization: "Bearer valid-token" },
    });
    expect(readResponse.statusCode).toBe(200);
    expect(readResponse.body.profileRevision).toBe(7);

    const updateResponse = await injectJson<SharedPropertyProfile>(app, {
      method: "PUT",
      url: "/api/hotel-setup/properties/" + propertyId + "/profile",
      headers: { authorization: "Bearer valid-token" },
      payload: {
        expectedProfileRevision: 7,
        patch: {
          displayName: "Alpenrose Munich Updated",
          location: { localityPublic: true },
        },
      },
    });

    expect(updateResponse.statusCode).toBe(200);
    expect(updateResponse.body).toMatchObject({
      propertyId,
      profileRevision: 8,
      profile: {
        displayName: "Alpenrose Munich Updated",
        propertyType: "hotel",
        location: {
          streetAddress: "Marienplatz 1",
          localityPublic: true,
          geoPublic: false,
          mapDisplayMode: "hidden",
        },
        contacts: minimalHotelInput().contacts,
      },
    });
  });

  it("returns the current revision for a stale profile patch", async () => {
    const profiles = new Map<string, SharedPropertyProfile>([
      [propertyId, profileResponse(propertyId, minimalHotelInput(), 4)],
    ]);
    app = buildSharedSetupApp({
      permissions: ["hotel_catalog.setup.read", "hotel_catalog.setup.manage"],
      repository: profileRepository(profiles),
    });

    const response = await injectJson<{ code: string; currentRevision: number }>(app, {
      method: "PUT",
      url: "/api/hotel-setup/properties/" + propertyId + "/profile",
      headers: { authorization: "Bearer valid-token" },
      payload: {
        expectedProfileRevision: 3,
        patch: { displayName: "Stale update" },
      },
    });

    expect(response.statusCode).toBe(409);
    expect(response.body).toMatchObject({
      code: "profile_revision_conflict",
      currentRevision: 4,
    });
  });

  it("keeps private identity operator-editable but denies publication to a catalog-only operator", async () => {
    const profiles = new Map<string, SharedPropertyProfile>([
      [propertyId, profileResponse(propertyId, minimalHotelInput(), 2)],
    ]);
    const repository = profileRepository(profiles);
    const updatePublicPropertyProfile = vi.fn();
    app = buildSharedSetupApp({
      permissions: ["hotel_catalog.setup.read", "hotel_catalog.setup.manage"],
      repository: {
        ...repository,
        updatePublicPropertyProfile,
      },
    });

    const identityUpdate = await injectJson<SharedPropertyProfile>(app, {
      method: "PUT",
      url: `/api/hotel-setup/properties/${propertyId}/profile`,
      headers: { authorization: "Bearer valid-token" },
      payload: {
        expectedProfileRevision: 2,
        patch: { displayName: "Operator-updated Alpenrose" },
      },
    });
    expect(identityUpdate.statusCode).toBe(200);

    const localityUpdate = await injectJson<{ code: string }>(app, {
      method: "PUT",
      url: `/api/hotel-setup/properties/${propertyId}/profile`,
      headers: { authorization: "Bearer valid-token" },
      payload: {
        expectedProfileRevision: 3,
        patch: { location: { localityPublic: true } },
      },
    });
    expect(localityUpdate.statusCode).toBe(403);
    expect(localityUpdate.body).toEqual({
      code: "missing_permission",
      detail: "Public profile and location publication require hotel-owner access.",
    });

    const exactMapUpdate = await injectJson<{ code: string }>(app, {
      method: "PUT",
      url: `/api/hotel-setup/properties/${propertyId}/profile`,
      headers: { authorization: "Bearer valid-token" },
      payload: {
        expectedProfileRevision: 3,
        patch: {
          location: {
            latitude: 48.137,
            longitude: 11.575,
            geoPublic: true,
            mapDisplayMode: "exact",
          },
        },
      },
    });
    expect(exactMapUpdate.statusCode).toBe(403);
    expect(exactMapUpdate.body.code).toBe("missing_permission");

    const publicContactUpdate = await injectJson<{ code: string }>(app, {
      method: "PUT",
      url: `/api/hotel-setup/properties/${propertyId}/profile`,
      headers: { authorization: "Bearer valid-token" },
      payload: {
        expectedProfileRevision: 3,
        patch: {
          contacts: minimalHotelInput().contacts.map((contact) => ({
            ...contact,
            isPublic: contact.channelType === "email",
          })),
        },
      },
    });
    expect(publicContactUpdate.statusCode).toBe(403);
    expect(publicContactUpdate.body.code).toBe("missing_permission");

    const publicProfileUpdate = await injectJson<{ code: string }>(app, {
      method: "PUT",
      url: `/api/hotel-setup/properties/${propertyId}/public-profile`,
      headers: { authorization: "Bearer valid-token" },
      payload: {
        expectedProfileRevision: 3,
        patch: { shortDescription: "Owner-only public copy." },
      },
    });
    expect(publicProfileUpdate.statusCode).toBe(403);
    expect(publicProfileUpdate.body.code).toBe("missing_permission");
    expect(updatePublicPropertyProfile).not.toHaveBeenCalled();
  });

  it("allows Booking owners to publish shared location and public profile data", async () => {
    const profiles = new Map<string, SharedPropertyProfile>([
      [propertyId, profileResponse(propertyId, minimalHotelInput(), 2)],
    ]);
    const publicProfile = {
      ...publicProfileResponse(3),
      publicProfile: {
        ...publicProfileResponse(3).publicProfile,
        shortDescription: "Book direct at Hotel Alpenrose.",
      },
    } satisfies PublicPropertyProfileResponse;
    const updatePublicPropertyProfile = vi.fn(async () => ({
      status: "updated" as const,
      profile: publicProfile,
    }));
    app = buildSharedSetupApp({
      permissions: [
        "hotel_catalog.setup.read",
        "hotel_catalog.setup.manage",
        "booking.settings.manage",
      ],
      repository: {
        ...profileRepository(profiles),
        updatePublicPropertyProfile,
      },
    });

    const locationUpdate = await injectJson<SharedPropertyProfile>(app, {
      method: "PUT",
      url: `/api/hotel-setup/properties/${propertyId}/profile`,
      headers: { authorization: "Bearer valid-token" },
      payload: {
        expectedProfileRevision: 2,
        patch: { location: { localityPublic: true } },
      },
    });
    expect(locationUpdate.statusCode).toBe(200);
    expect(locationUpdate.body.profile.location.localityPublic).toBe(true);

    const profileUpdate = await injectJson<PublicPropertyProfileResponse>(app, {
      method: "PUT",
      url: `/api/hotel-setup/properties/${propertyId}/public-profile`,
      headers: { authorization: "Bearer valid-token" },
      payload: {
        expectedProfileRevision: 3,
        patch: { shortDescription: "Book direct at Hotel Alpenrose." },
      },
    });
    expect(profileUpdate.statusCode).toBe(200);
    expect(profileUpdate.body).toEqual(publicProfile);
    expect(updatePublicPropertyProfile).toHaveBeenCalledWith({
      organizationId,
      propertyId,
      expectedProfileRevision: 3,
      patch: { shortDescription: "Book direct at Hotel Alpenrose." },
    });
  });

  it("allows Marketplace owners to read and sparsely update the public property profile", async () => {
    const current = publicProfileResponse(4);
    const updated = {
      ...current,
      profileRevision: 5,
      publicProfile: {
        ...current.publicProfile,
        shortDescription: "A quieter stay in the heart of Munich.",
      },
    } satisfies PublicPropertyProfileResponse;
    const getPublicPropertyProfile = vi.fn(async () => current);
    const updatePublicPropertyProfile = vi.fn(async () => ({
      status: "updated" as const,
      profile: updated,
    }));
    app = buildSharedSetupApp({
      permissions: [
        "hotel_catalog.setup.read",
        "hotel_catalog.setup.manage",
        "marketplace.profile.manage",
      ],
      repository: {
        ...unusedStatusMethods(),
        ...unusedPropertyProfileMethods(),
        getPublicPropertyProfile,
        updatePublicPropertyProfile,
      },
    });

    const readResponse = await injectJson<PublicPropertyProfileResponse>(app, {
      method: "GET",
      url: `/api/hotel-setup/properties/${propertyId}/public-profile`,
      headers: { authorization: "Bearer valid-token" },
    });
    expect(readResponse.statusCode).toBe(200);
    expect(readResponse.body).toEqual(current);

    const updateResponse = await injectJson<PublicPropertyProfileResponse>(app, {
      method: "PUT",
      url: `/api/hotel-setup/properties/${propertyId}/public-profile`,
      headers: { authorization: "Bearer valid-token" },
      payload: {
        expectedProfileRevision: 4,
        patch: { shortDescription: "  A quieter stay in the heart of Munich.  " },
      },
    });
    expect(updateResponse.statusCode).toBe(200);
    expect(updateResponse.body).toEqual(updated);
    expect(updatePublicPropertyProfile).toHaveBeenCalledWith({
      organizationId,
      propertyId,
      expectedProfileRevision: 4,
      patch: { shortDescription: "A quieter stay in the heart of Munich." },
    });
  });

  it("maps stale and unapproved public profile media writes to contract errors", async () => {
    const updatePublicPropertyProfile = vi
      .fn()
      .mockResolvedValueOnce({ status: "conflict", currentRevision: 8 })
      .mockResolvedValueOnce({
        status: "invalid_media",
        mediaObjectIds: ["dddddddd-dddd-4ddd-8ddd-dddddddddddd"],
      });
    app = buildSharedSetupApp({
      permissions: [
        "hotel_catalog.setup.read",
        "hotel_catalog.setup.manage",
        "marketplace.profile.manage",
      ],
      repository: {
        ...unusedStatusMethods(),
        ...unusedPropertyProfileMethods(),
        updatePublicPropertyProfile,
      },
    });

    const conflict = await injectJson<{ code: string; currentRevision: number }>(app, {
      method: "PUT",
      url: `/api/hotel-setup/properties/${propertyId}/public-profile`,
      headers: { authorization: "Bearer valid-token" },
      payload: {
        expectedProfileRevision: 7,
        patch: { longDescription: "Stale description" },
      },
    });
    expect(conflict.statusCode).toBe(409);
    expect(conflict.body).toMatchObject({
      code: "profile_revision_conflict",
      currentRevision: 8,
    });

    const invalidMedia = await injectJson<{
      code: string;
      fields: Record<string, string[]>;
    }>(app, {
      method: "PUT",
      url: `/api/hotel-setup/properties/${propertyId}/public-profile`,
      headers: { authorization: "Bearer valid-token" },
      payload: {
        expectedProfileRevision: 8,
        patch: {
          media: [
            {
              mediaObjectId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
              altText: null,
              sortOrder: 0,
            },
          ],
        },
      },
    });
    expect(invalidMedia.statusCode).toBe(422);
    expect(invalidMedia.body.code).toBe("invalid_setup_request");
    expect(invalidMedia.body.fields["patch.media"]).toEqual([
      "Invalid mediaObjectId values: dddddddd-dddd-4ddd-8ddd-dddddddddddd",
    ]);
  });

  it("maps an in-progress canonical media publication to an HTTP conflict", async () => {
    const updatePublicPropertyProfile = vi.fn(async () => ({
      status: "command_in_progress" as const,
    }));
    app = buildSharedSetupApp({
      permissions: [
        "hotel_catalog.setup.read",
        "hotel_catalog.setup.manage",
        "marketplace.profile.manage",
      ],
      repository: {
        ...unusedStatusMethods(),
        ...unusedPropertyProfileMethods(),
        updatePublicPropertyProfile,
      },
    });

    const response = await injectJson<{ code: string; detail: string }>(app, {
      method: "PUT",
      url: `/api/hotel-setup/properties/${propertyId}/public-profile`,
      headers: { authorization: "Bearer valid-token" },
      payload: {
        expectedProfileRevision: 8,
        patch: {
          media: [
            {
              mediaObjectId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
              altText: null,
              sortOrder: 0,
            },
          ],
        },
      },
    });

    expect(response.statusCode).toBe(409);
    expect(response.body).toEqual({
      code: "command_in_progress",
      detail: "A property media update is still being published. Retry shortly.",
    });
    expect(updatePublicPropertyProfile).toHaveBeenCalledWith({
      organizationId,
      propertyId,
      expectedProfileRevision: 8,
      patch: {
        media: [
          {
            mediaObjectId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
            altText: null,
            sortOrder: 0,
          },
        ],
      },
    });
  });

  it("rejects legacy and unknown public profile patch fields", async () => {
    const updatePublicPropertyProfile = vi.fn();
    app = buildSharedSetupApp({
      permissions: [
        "hotel_catalog.setup.read",
        "hotel_catalog.setup.manage",
        "marketplace.profile.manage",
      ],
      repository: {
        ...unusedStatusMethods(),
        ...unusedPropertyProfileMethods(),
        updatePublicPropertyProfile,
      },
    });

    const response = await injectJson<{ code: string; fields: Record<string, string[]> }>(app, {
      method: "PUT",
      url: `/api/hotel-setup/properties/${propertyId}/public-profile`,
      headers: { authorization: "Bearer valid-token" },
      payload: {
        expectedProfileRevision: 4,
        patch: { heroImageUrl: "https://legacy.example/hero.jpg" },
      },
    });
    expect(response.statusCode).toBe(422);
    expect(response.body.code).toBe("invalid_setup_request");
    expect(response.body.fields["patch.heroImageUrl"]).toEqual([
      "patch.heroImageUrl is not supported.",
    ]);
    expect(updatePublicPropertyProfile).not.toHaveBeenCalled();
  });

  it("requires setup-manage permission for public profile writes", async () => {
    const updatePublicPropertyProfile = vi.fn();
    app = buildSharedSetupApp({
      permissions: ["hotel_catalog.setup.read"],
      repository: {
        ...unusedStatusMethods(),
        ...unusedPropertyProfileMethods(),
        updatePublicPropertyProfile,
      },
    });

    const response = await injectJson(app, {
      method: "PUT",
      url: `/api/hotel-setup/properties/${propertyId}/public-profile`,
      headers: { authorization: "Bearer valid-token" },
      payload: {
        expectedProfileRevision: 4,
        patch: { shortDescription: "Unauthorized update" },
      },
    });
    expect(response.statusCode).toBe(403);
    expect(updatePublicPropertyProfile).not.toHaveBeenCalled();
  });

  it("rejects unknown top-level and nested patch fields", async () => {
    const profiles = new Map<string, SharedPropertyProfile>([
      [propertyId, profileResponse(propertyId, minimalHotelInput())],
    ]);
    app = buildSharedSetupApp({
      permissions: ["hotel_catalog.setup.read", "hotel_catalog.setup.manage"],
      repository: profileRepository(profiles),
    });

    const topLevelUnknown = await injectJson<{ code: string }>(app, {
      method: "PUT",
      url: "/api/hotel-setup/properties/" + propertyId + "/profile",
      headers: { authorization: "Bearer valid-token" },
      payload: {
        expectedProfileRevision: 1,
        patch: { displayName: "Alpenrose Updated" },
        unexpected: true,
      },
    });
    expect(topLevelUnknown.statusCode).toBe(422);
    expect(topLevelUnknown.body.code).toBe("invalid_setup_request");

    const unknown = await injectJson<{ fields: Record<string, string[]> }>(app, {
      method: "PUT",
      url: "/api/hotel-setup/properties/" + propertyId + "/profile",
      headers: { authorization: "Bearer valid-token" },
      payload: {
        expectedProfileRevision: 1,
        patch: { location: { region: "Bavaria" } },
      },
    });
    expect(unknown.statusCode).toBe(422);
    expect(unknown.body.fields["patch.location.region"]).toEqual([
      "patch.location.region is not supported.",
    ]);
  });

  it("rejects shared property profile reads and writes outside the selected hotel group", async () => {
    app = buildSharedSetupApp({
      permissions: ["hotel_catalog.setup.read", "hotel_catalog.setup.manage"],
      repository: {
        ...unusedStatusMethods(),
        ...unusedPropertyProfileMethods(),
        async getPropertyProfile() {
          throw new Error("unauthorized profile read must not hit the repository");
        },
        async createPropertyProfile() {
          throw new Error("create is not used by this test");
        },
        async updatePropertyProfile() {
          throw new Error("unauthorized profile update must not hit the repository");
        },
      },
    });

    const readResponse = await injectJson<{ code: string }>(app, {
      method: "GET",
      url: `/api/hotel-setup/properties/${secondPropertyId}/profile`,
      headers: { authorization: "Bearer valid-token" },
    });
    expect(readResponse.statusCode).toBe(403);
    expect(readResponse.body.code).toBe("missing_property_resource_link");

    const updateResponse = await injectJson<{ code: string }>(app, {
      method: "PUT",
      url: `/api/hotel-setup/properties/${secondPropertyId}/profile`,
      headers: { authorization: "Bearer valid-token" },
      payload: {
        expectedProfileRevision: 1,
        patch: { displayName: "Unauthorized update" },
      },
    });
    expect(updateResponse.statusCode).toBe(403);
    expect(updateResponse.body.code).toBe("missing_property_resource_link");

    const publicReadResponse = await injectJson<{ code: string }>(app, {
      method: "GET",
      url: `/api/hotel-setup/properties/${secondPropertyId}/public-profile`,
      headers: { authorization: "Bearer valid-token" },
    });
    expect(publicReadResponse.statusCode).toBe(403);
    expect(publicReadResponse.body.code).toBe("missing_property_resource_link");

    const publicUpdateResponse = await injectJson<{ code: string }>(app, {
      method: "PUT",
      url: `/api/hotel-setup/properties/${secondPropertyId}/public-profile`,
      headers: { authorization: "Bearer valid-token" },
      payload: {
        expectedProfileRevision: 1,
        patch: { shortDescription: "Unauthorized update" },
      },
    });
    expect(publicUpdateResponse.statusCode).toBe(403);
    expect(publicUpdateResponse.body.code).toBe("missing_property_resource_link");
  });

  it("reads and writes launch settings for a creator-only property without Booking access", async () => {
    const stored = {
      id: propertyId,
      propertyId,
      defaultCurrency: "EUR",
      supportedCurrencies: ["CHF"],
      defaultLanguage: "de",
      supportedLanguages: ["en"],
      instagram: "https://instagram.com/alpenrose",
      facebook: null,
      tiktok: "https://tiktok.com/@alpenrose",
      youtube: null,
    };
    const findPropertySettingsByHotelId = vi.fn(async () => stored);
    const updatePropertySettingsByHotelId = vi.fn(async () => stored);
    app = buildSharedSetupApp({
      permissions: ["hotel_catalog.setup.read", "hotel_catalog.setup.manage"],
      linkedResources: [
        propertyLink(propertyId),
        productLink("marketplace", "hotel_profile", propertyId),
      ],
      repository: repositoryWith([]),
      launchSettingsRepository: {
        findPropertySettingsByHotelId,
        updatePropertySettingsByHotelId,
      },
    });

    const readResponse = await injectJson(app, {
      method: "GET",
      url: `/api/hotel-setup/properties/${propertyId}/launch-settings`,
      headers: { authorization: "Bearer valid-token" },
    });
    expect(readResponse.statusCode).toBe(200);
    expect(readResponse.body).toEqual({
      defaultCurrency: "EUR",
      supportedCurrencies: ["CHF"],
      defaultLanguage: "de",
      supportedLanguages: ["en"],
      instagram: "https://instagram.com/alpenrose",
      facebook: "",
      tiktok: "https://tiktok.com/@alpenrose",
      youtube: "",
    });

    const payload = {
      defaultCurrency: "EUR",
      supportedCurrencies: ["CHF"],
      defaultLanguage: "de",
      supportedLanguages: ["en"],
      instagram: "https://instagram.com/alpenrose",
      facebook: "",
      tiktok: "https://tiktok.com/@alpenrose",
      youtube: "",
    };
    const writeResponse = await injectJson(app, {
      method: "PUT",
      url: `/api/hotel-setup/properties/${propertyId}/launch-settings`,
      headers: { authorization: "Bearer valid-token" },
      payload,
    });
    expect(writeResponse.statusCode).toBe(200);
    expect(updatePropertySettingsByHotelId).toHaveBeenCalledWith(
      propertyId,
      payload,
      organizationId,
    );

    const invalidResponse = await injectJson(app, {
      method: "PUT",
      url: `/api/hotel-setup/properties/${propertyId}/launch-settings`,
      headers: { authorization: "Bearer valid-token" },
      payload: { ...payload, instagram: "https://user:secret@instagram.com/alpenrose" },
    });
    expect(invalidResponse.statusCode).toBe(422);
    expect(updatePropertySettingsByHotelId).toHaveBeenCalledTimes(1);
  });

  it("rejects launch settings access outside the selected hotel group", async () => {
    const launchSettingsRepository: SharedPropertyLaunchSettingsRepository = {
      async findPropertySettingsByHotelId() {
        throw new Error("unauthorized launch settings read must not hit the repository");
      },
      async updatePropertySettingsByHotelId() {
        throw new Error("unauthorized launch settings write must not hit the repository");
      },
    };
    app = buildSharedSetupApp({
      permissions: ["hotel_catalog.setup.read", "hotel_catalog.setup.manage"],
      repository: repositoryWith([]),
      launchSettingsRepository,
    });

    const readResponse = await injectJson<{ code: string }>(app, {
      method: "GET",
      url: `/api/hotel-setup/properties/${secondPropertyId}/launch-settings`,
      headers: { authorization: "Bearer valid-token" },
    });
    expect(readResponse.statusCode).toBe(403);
    expect(readResponse.body.code).toBe("missing_property_resource_link");

    const writeResponse = await injectJson<{ code: string }>(app, {
      method: "PUT",
      url: `/api/hotel-setup/properties/${secondPropertyId}/launch-settings`,
      headers: { authorization: "Bearer valid-token" },
      payload: {
        defaultCurrency: "EUR",
        supportedCurrencies: [],
        defaultLanguage: "en",
        supportedLanguages: [],
        instagram: "",
        facebook: "",
        tiktok: "",
        youtube: "",
      },
    });
    expect(writeResponse.statusCode).toBe(403);
    expect(writeResponse.body.code).toBe("missing_property_resource_link");
  });

  it("returns field-level validation errors for canonical property profile writes", async () => {
    app = buildSharedSetupApp({
      permissions: ["hotel_catalog.setup.read", "hotel_catalog.setup.manage"],
      repository: {
        ...unusedStatusMethods(),
        ...unusedPropertyProfileMethods(),
      },
    });

    const response = await injectJson<{ code: string; fields: Record<string, string[]> }>(app, {
      method: "POST",
      url: "/api/hotel-setup/properties",
      headers: { authorization: "Bearer valid-token" },
      payload: {
        displayName: "",
        propertyType: "castle",
        location: {
          countryCode: "DEU",
          timezone: "Europe/Not_A_Real_Place",
          latitude: 48.1,
          localityPublic: "false",
          addressPublic: true,
          region: "legacy",
        },
        contacts: [
          {
            channelType: "phone",
            value: "sdfdsfsfsdfdsf",
            purpose: "sales",
            isPublic: "yes",
          },
        ],
        website: "https://legacy.example",
      },
    });

    expect(response.statusCode).toBe(422);
    expect(response.body.code).toBe("invalid_setup_request");
    expect(response.body.fields).toMatchObject({
      displayName: expect.any(Array),
      propertyType: expect.any(Array),
      "location.countryCode": expect.any(Array),
      "location.timezone": expect.any(Array),
      "location.latitude": expect.any(Array),
      "contacts.0.value": expect.any(Array),
      "contacts.0.purpose": expect.any(Array),
      "contacts.0.isPublic": expect.any(Array),
      "request.website": expect.any(Array),
      "location.addressPublic": expect.any(Array),
      "location.region": expect.any(Array),
    });
  });

  it("requires explicit contact purpose and visibility", async () => {
    const input = minimalHotelInput();
    app = buildSharedSetupApp({
      permissions: ["hotel_catalog.setup.read", "hotel_catalog.setup.manage"],
      repository: {
        ...unusedStatusMethods(),
        ...unusedPropertyProfileMethods(),
      },
    });

    const response = await injectJson<{ fields: Record<string, string[]> }>(app, {
      method: "POST",
      url: "/api/hotel-setup/properties",
      headers: { authorization: "Bearer valid-token" },
      payload: {
        ...input,
        contacts: input.contacts.map(
          ({ purpose: _purpose, isPublic: _isPublic, ...contact }) => contact,
        ),
      },
    });

    expect(response.statusCode).toBe(422);
    expect(response.body.fields["contacts.0.purpose"]).toEqual(["contacts.0.purpose is required."]);
    expect(response.body.fields["contacts.0.isPublic"]).toEqual([
      "contacts.0.isPublic must be a boolean.",
    ]);
  });

  it("merges canonical profile completeness and Marketplace lifecycle into one public-profile fact", async () => {
    for (const [marketplaceProfileStatus, readiness, ownerProgress, reasonCodes] of [
      [null, "actionable", "in_progress", ["marketplace_profile_not_started"]],
      ["pending", "pending_review", "owner_complete", ["marketplace_profile_pending"]],
      ["rejected", "rejected", "in_progress", ["marketplace_profile_rejected"]],
      ["suspended", "blocked", "in_progress", ["marketplace_profile_suspended"]],
      ["verified", "complete", "owner_complete", []],
    ] as const) {
      const query = vi.fn(async (text: string) => {
        if (text.includes("FROM identity.organizations")) {
          return { rows: [{ displayName: "Alpenrose Hotel Group", websiteUrl: null }] };
        }
        return {
          rows: [
            adaptiveStatusRow({
              marketplaceProfileStatus,
              marketplaceProfileComplete: marketplaceProfileStatus !== null,
              marketplaceProfileDescriptionInSync: marketplaceProfileStatus !== null,
            }),
          ],
        };
      });
      const repository = createPgSharedHotelSetupStatusRepository({
        connectionString: "postgresql://target-db",
        pool: {
          query: async <T extends QueryResultRow = QueryResultRow>(text: string) => {
            const result = await query(text);
            return { rows: result.rows as unknown as T[] };
          },
          end: vi.fn(async () => undefined),
        },
      });

      const status = await repository.getHotelSetupStatus({
        organizationId,
        propertyIds: [propertyId],
      });
      expect(status.properties[0]!.taskFacts.public_profile).toMatchObject({
        readiness,
        ownerProgress,
        reasonCodes,
      });
      expect(query.mock.calls[1]![0]).not.toMatch(/legacy_/i);
    }
  });

  it("reopens a complete public profile when the Catalog description changes before Marketplace syncs", async () => {
    let catalogDescriptionUpdatedAt = "2026-07-26T12:00:00.000Z";
    let marketplaceProfileDescriptionInSync = true;
    const query = vi.fn(async (text: string) => {
      if (text.includes("FROM identity.organizations")) {
        return { rows: [{ displayName: "Alpenrose Hotel Group", websiteUrl: null }] };
      }
      return {
        rows: [
          adaptiveStatusRow({
            profileUpdatedAt: catalogDescriptionUpdatedAt,
            marketplaceProfileStatus: "verified",
            marketplaceProfileComplete: true,
            marketplaceProfileDescriptionInSync,
            marketplaceProfileUpdatedAt: "2026-07-26T12:00:00.000Z",
          }),
        ],
      };
    });
    const repository = createPgSharedHotelSetupStatusRepository({
      connectionString: "postgresql://target-db",
      pool: {
        query: async <T extends QueryResultRow = QueryResultRow>(text: string) => {
          const result = await query(text);
          return { rows: result.rows as unknown as T[] };
        },
        end: vi.fn(async () => undefined),
      },
    });

    const complete = (
      await repository.getHotelSetupStatus({ organizationId, propertyIds: [propertyId] })
    ).properties[0]!.taskFacts.public_profile;
    expect(complete).toMatchObject({
      readiness: "complete",
      ownerProgress: "owner_complete",
      reasonCodes: [],
    });

    catalogDescriptionUpdatedAt = "2026-07-27T12:00:00.000Z";
    marketplaceProfileDescriptionInSync = false;
    const outOfSync = (
      await repository.getHotelSetupStatus({ organizationId, propertyIds: [propertyId] })
    ).properties[0]!.taskFacts.public_profile;

    expect(outOfSync).toMatchObject({
      readiness: "actionable",
      ownerProgress: "in_progress",
      reasonCodes: ["marketplace_profile_description_out_of_sync"],
      sourceRevision: JSON.stringify(["2026-07-27T12:00:00.000Z", "verified", true, [], false]),
    });
    expect(outOfSync.sourceRevision).not.toBe(complete.sourceRevision);

    const factsSql = query.mock.calls[3]![0];
    expect(factsSql).toContain("public_profile.normalized_description");
    expect(factsSql).toContain("BTRIM(profile.short_description)");
    expect(factsSql).toContain("BTRIM(profile.long_description)");
    expect(factsSql).toContain("BTRIM(marketplace_profile.host_summary)");
  });

  it("requires a fresh creator projection, supported checkout method, and ready booking setup", async () => {
    const query = vi.fn(async (text: string, _values?: readonly unknown[]) => {
      if (text.includes("FROM identity.organizations")) {
        return { rows: [{ displayName: "Alpenrose Hotel Group", websiteUrl: null }] };
      }
      return {
        rows: [
          adaptiveStatusRow({
            marketplaceOfferStatus: "verified",
            marketplaceOfferHasTitle: true,
            marketplaceOfferHasDeliverable: true,
            marketplaceOfferHasCompensation: true,
            marketplaceOfferHasRequirement: true,
            marketplaceOfferPublic: true,
            marketplaceOfferProjectionFresh: false,
            hasAcceptedPaymentMethod: true,
            hasEffectivePaymentMethod: false,
            bookabilitySetupReady: false,
            bookabilityMissingEmpty: false,
          }),
        ],
      };
    });
    const repository = createPgSharedHotelSetupStatusRepository({
      connectionString: "postgresql://target-db",
      pool: {
        query: async <T extends QueryResultRow = QueryResultRow>(
          text: string,
          values?: readonly unknown[],
        ) => {
          const result = await query(text, values);
          return { rows: result.rows as unknown as T[] };
        },
        end: vi.fn(async () => undefined),
      },
    });

    const facts = (
      await repository.getHotelSetupStatus({ organizationId, propertyIds: [propertyId] })
    ).properties[0]!.taskFacts;
    expect(facts.creator_offer).toMatchObject({ readiness: "pending_sync", freshness: "stale" });
    expect(facts.payment).toMatchObject({
      readiness: "actionable",
      reasonCodes: ["no_supported_checkout_payment_method"],
    });
    const factsSql = query.mock.calls.find(([text]) =>
      text.includes("hasEffectivePaymentMethod"),
    )?.[0];
    expect(factsSql).toContain("payment.deposit_policy ->> 'bankTransferInstructions'");
    expect(factsSql).toContain("payment.deposit_policy ->> 'paypalEmail'");
    expect(facts.direct_booking_publication).toMatchObject({
      readiness: "actionable",
      ownerProgress: "in_progress",
    });
  });

  it("blocks a verified creator offer whose projection is private", async () => {
    const repository = createPgSharedHotelSetupStatusRepository({
      connectionString: "postgresql://target-db",
      pool: {
        async query<T extends QueryResultRow = QueryResultRow>(text: string) {
          const rows = text.includes("FROM identity.organizations")
            ? [{ displayName: "Alpenrose Hotel Group", websiteUrl: null }]
            : [
                adaptiveStatusRow({
                  marketplaceOfferStatus: "verified",
                  marketplaceOfferHasTitle: true,
                  marketplaceOfferHasDeliverable: true,
                  marketplaceOfferHasCompensation: true,
                  marketplaceOfferHasRequirement: true,
                  marketplaceOfferPublic: false,
                  marketplaceOfferProjectionFresh: false,
                }),
              ];
          return { rows: rows as unknown as T[] };
        },
        end: vi.fn(async () => undefined),
      },
    });

    const fact = (
      await repository.getHotelSetupStatus({ organizationId, propertyIds: [propertyId] })
    ).properties[0]!.taskFacts.creator_offer;

    expect(fact).toMatchObject({
      readiness: "blocked",
      reasonCodes: ["creator_offer_not_public"],
      freshness: "stale",
    });
  });

  it("makes publication actionable before its first distribution projection exists", async () => {
    const query = vi.fn(async (text: string, _values?: readonly unknown[]) => {
      if (text.includes("FROM identity.organizations")) {
        return { rows: [{ displayName: "Alpenrose Hotel Group", websiteUrl: null }] };
      }
      return {
        rows: [
          adaptiveStatusRow({
            bookabilityStatus: null,
            bookabilityFreshness: null,
            bookabilitySetupReady: false,
            bookabilityMissingEmpty: false,
            bookabilityExpired: false,
            bookabilityUpdatedAt: null,
          }),
        ],
      };
    });
    const repository = createPgSharedHotelSetupStatusRepository({
      connectionString: "postgresql://target-db",
      pool: {
        query: async <T extends QueryResultRow = QueryResultRow>(
          text: string,
          values?: readonly unknown[],
        ) => {
          const result = await query(text, values);
          return { rows: result.rows as unknown as T[] };
        },
        end: vi.fn(async () => undefined),
      },
    });

    const publication = (
      await repository.getHotelSetupStatus({ organizationId, propertyIds: [propertyId] })
    ).properties[0]!.taskFacts.direct_booking_publication;

    expect(publication).toMatchObject({
      readiness: "actionable",
      ownerProgress: "not_started",
      freshness: "fresh",
    });
  });

  it("keeps an incomplete attempted publication actionable for repair", async () => {
    const repository = createPgSharedHotelSetupStatusRepository({
      connectionString: "postgresql://target-db",
      pool: {
        async query<T extends QueryResultRow = QueryResultRow>(text: string) {
          const rows = text.includes("FROM identity.organizations")
            ? [{ displayName: "Alpenrose Hotel Group", websiteUrl: null }]
            : [
                adaptiveStatusRow({
                  bookabilityStatus: "incomplete",
                  bookabilityFreshness: "fresh",
                  bookabilitySetupReady: false,
                  bookabilityMissingEmpty: false,
                  bookabilityExpired: false,
                  bookabilityUpdatedAt: "2026-07-26T12:30:00.000Z",
                }),
              ];
          return { rows: rows as unknown as T[] };
        },
        end: vi.fn(async () => undefined),
      },
    });

    const publication = (
      await repository.getHotelSetupStatus({ organizationId, propertyIds: [propertyId] })
    ).properties[0]!.taskFacts.direct_booking_publication;

    expect(publication).toMatchObject({
      readiness: "actionable",
      ownerProgress: "in_progress",
      reasonCodes: expect.arrayContaining([
        "direct_booking_not_public",
        "bookability_setup_not_ready",
        "bookability_setup_missing",
      ]),
    });
  });

  it("reads adaptive readiness only from canonical target tables", async () => {
    const query = vi.fn(async (text: string, _values?: readonly unknown[]) => {
      if (text.includes("FROM identity.organizations")) {
        return { rows: [{ displayName: "Alpenrose Hotel Group", websiteUrl: null }] };
      }
      return { rows: [adaptiveStatusRow()] };
    });
    const repository = createPgSharedHotelSetupStatusRepository({
      connectionString: "postgresql://target-db",
      pool: {
        query: async <T extends QueryResultRow = QueryResultRow>(
          text: string,
          values?: readonly unknown[],
        ) => {
          const result = await query(text, values);
          return { rows: result.rows as unknown as T[] };
        },
        end: vi.fn(async () => undefined),
      },
    });

    await repository.getHotelSetupStatus({ organizationId, propertyIds: [propertyId] });

    const sql = query.mock.calls[1]![0];
    expect(sql).toContain("FROM unnest($2::uuid[])");
    expect(sql).toContain("hotel_catalog.properties");
    expect(sql).toContain("marketplace.marketplace_hotel_profiles");
    expect(sql).toContain("pms.room_types");
    expect(sql).toContain("finance.payment_settings");
    expect(sql).toContain("finance.payment_provider_accounts");
    expect(sql).toContain("payment_provider.onboarding_status = 'completed'");
    expect(sql).toContain("payment_provider.charges_enabled = TRUE");
    expect(sql).toContain("'card' = ANY(payment.accepted_methods)");
    expect(sql).toContain("'bank_transfer'");
    expect(sql).toContain("JOIN platform.media_objects media_object");
    expect(sql).toContain("JOIN platform.media_variants media_variant");
    expect(sql).toContain("media.source_system = 'platform'");
    expect(sql).toContain("media_object.public_approved = TRUE");
    expect(sql).toContain("media_object.lifecycle_status = 'active'");
    expect(sql).toContain("media_variant.variant_name = 'original_safe'");
    expect(sql).toContain("distribution.public_hotel_bookability_profiles");
    expect(sql).not.toContain("identity.product_entitlements");
    expect(sql).toContain("property_public_profile_read_model");
    expect(sql).toContain("catalog_public_profile.projected_at");
    expect(sql).toContain("offer.offer_status <> 'archived'");
    expect(sql).toContain("AND candidate.is_public");
    expect(sql).toContain("AND candidate.projection_fresh");
    expect(sql).toContain("WHEN candidate.offer_status = 'pending'");
    expect(sql).toContain("WHEN candidate.offer_status = 'rejected'");
    expect(sql).toContain("candidate.updated_at DESC");
    expect(sql.indexOf("THEN 0")).toBeLessThan(sql.indexOf("THEN 1"));
    expect(sql.indexOf("THEN 1")).toBeLessThan(sql.indexOf("THEN 2"));
    expect(sql.indexOf("THEN 2")).toBeLessThan(sql.indexOf("THEN 3"));
    expect(sql.indexOf("THEN 3")).toBeLessThan(sql.indexOf("THEN 4"));
    expect(sql.indexOf("THEN 4")).toBeLessThan(sql.indexOf("THEN 5"));
    expect(sql.indexOf("THEN 5")).toBeLessThan(sql.indexOf("ELSE 6"));
    expect(query.mock.calls[1]![1]).toEqual([organizationId, [propertyId]]);
  });

  it("requires fragmented room artifacts to converge on the same active room type", async () => {
    const query = vi.fn(async (text: string, _values?: readonly unknown[]) => {
      if (text.includes("FROM identity.organizations")) {
        return { rows: [{ displayName: "Alpenrose Hotel Group", websiteUrl: null }] };
      }
      return { rows: [adaptiveStatusRow()] };
    });
    const repository = createPgSharedHotelSetupStatusRepository({
      connectionString: "postgresql://target-db",
      pool: {
        query: async <T extends QueryResultRow = QueryResultRow>(
          text: string,
          values?: readonly unknown[],
        ) => {
          const result = await query(text, values);
          return { rows: result.rows as unknown as T[] };
        },
        end: vi.fn(async () => undefined),
      },
    });

    await repository.getHotelSetupStatus({ organizationId, propertyIds: [propertyId] });

    const sql = query.mock.calls[1]![0];
    expect(sql).toContain(") room_readiness ON TRUE");
    expect(sql).toMatch(
      /bool_or\(\s*candidate\.has_non_retired_room\s+AND candidate\.has_active_rate_plan\s*\)/,
    );
    expect(sql).toMatch(
      /bool_or\(\s*candidate\.has_non_retired_room\s+AND candidate\.has_active_rate_plan\s+AND candidate\.has_future_inventory\s*\)/,
    );
    expect(sql).toContain("room.room_type_id = room_type.id");
    expect(sql).toContain("rate_plan.room_type_id = room_type.id");
    expect(sql).toContain("day.room_type_id = room_type.id");
    expect(sql).toContain("room_type.active = TRUE");
    expect(sql).not.toContain(") rooms ON TRUE");
    expect(sql).not.toContain(") rate_plans ON TRUE");
    expect(sql).not.toContain(") inventory ON TRUE");
  });

  it("requires explicit locality consent before public-profile readiness completes", async () => {
    let localityPublic = false;
    const repository = createPgSharedHotelSetupStatusRepository({
      connectionString: "postgresql://target-db",
      pool: {
        async query<T extends QueryResultRow = QueryResultRow>(text: string) {
          const rows = text.includes("FROM identity.organizations")
            ? [{ displayName: "Alpenrose Hotel Group", websiteUrl: null }]
            : [
                adaptiveStatusRow({
                  localityPublic,
                  marketplaceProfileStatus: "verified",
                  marketplaceProfileComplete: true,
                  marketplaceProfileDescriptionInSync: true,
                }),
              ];
          return { rows: rows as unknown as T[] };
        },
        end: vi.fn(async () => undefined),
      },
    });

    const privateFacts = (
      await repository.getHotelSetupStatus({ organizationId, propertyIds: [propertyId] })
    ).properties[0]!.taskFacts.public_profile;
    expect(privateFacts).toMatchObject({
      readiness: "actionable",
      reasonCodes: ["missing_public_locality_consent"],
    });

    localityPublic = true;
    const publicFacts = (
      await repository.getHotelSetupStatus({ organizationId, propertyIds: [propertyId] })
    ).properties[0]!.taskFacts.public_profile;
    expect(publicFacts).toMatchObject({ readiness: "complete", reasonCodes: [] });
  });

  it("reads the nested canonical profile revision and explicit contact metadata", async () => {
    const query = vi.fn(async (_text: string, _values?: readonly unknown[]) => ({
      rows: [profileRow()],
    }));
    const repository = createPgSharedHotelSetupStatusRepository({
      connectionString: "postgresql://target-db",
      pool: {
        query: async <T extends QueryResultRow = QueryResultRow>(
          text: string,
          values?: readonly unknown[],
        ) => {
          const result = await query(text, values);
          return { rows: result.rows as unknown as T[] };
        },
        end: vi.fn(async () => undefined),
      },
    });

    const profile = await repository.getPropertyProfile({ organizationId, propertyId });

    expect(profile).toEqual(profileResponse(propertyId, minimalHotelInput(), 3));
    const sql = query.mock.calls[0]![0];
    expect(sql).toContain('property.profile_revision AS "profileRevision"');
    expect(sql).toContain("'purpose', contact.purpose");
    expect(sql).toContain("'isPublic', contact.is_public");
    expect(sql).toContain("contact.source_system = 'platform'");
    expect(sql).toContain("contact.is_public = TRUE");
    expect(sql).toContain("contact.channel_type IN ('phone', 'whatsapp', 'email')");
    expect(sql).not.toContain("property_public_profile_read_model");
    expect(sql).not.toContain("property_profiles profile");
    expect(sql).not.toContain("property_media media");
    expect(query.mock.calls[0]![1]).toEqual([organizationId, propertyId]);
  });

  it("reads approved public media by canonical property link across product upload scopes", async () => {
    const query = vi.fn(async (_text: string, _values?: readonly unknown[]) => ({
      rows: [
        {
          propertyId,
          profileRevision: "4",
          locale: "en",
          shortDescription: "A quiet stay in Munich.",
          longDescription: null,
          media: publicProfileResponse(4).publicProfile.media,
        },
      ],
    }));
    const repository = createPgSharedHotelSetupStatusRepository({
      connectionString: "postgresql://target-db",
      pool: {
        query: async <T extends QueryResultRow = QueryResultRow>(
          text: string,
          values?: readonly unknown[],
        ) => {
          const result = await query(text, values);
          return { rows: result.rows as unknown as T[] };
        },
        end: vi.fn(async () => undefined),
      },
    });

    const profile = await repository.getPublicPropertyProfile({ organizationId, propertyId });

    expect(profile).toEqual({
      ...publicProfileResponse(4),
      publicProfile: {
        ...publicProfileResponse(4).publicProfile,
        shortDescription: "A quiet stay in Munich.",
      },
    });
    const sql = query.mock.calls[0]![0];
    expect(sql).toContain("media_object.property_id = property.id");
    expect(sql).toContain("JOIN platform.media_variants variant");
    expect(sql).toContain("variant.variant_name = 'original_safe'");
    expect(sql).toContain("'property.gallery_image'");
    expect(sql).not.toContain("media_object.resource_product = 'hotel_catalog'");
    expect(query.mock.calls[0]![1]).toEqual([organizationId, propertyId]);
  });

  it("rejects a public media patch while a canonical property-media job is active", async () => {
    const release = vi.fn();
    const query = vi.fn(async (text: string, _values?: readonly unknown[]) => {
      if (text === "BEGIN" || text === "ROLLBACK") return { rows: [] };
      if (text.includes("FOR UPDATE OF property")) {
        return { rows: [{ profileRevision: "4", locale: "en" }] };
      }
      if (text.includes("FROM platform.jobs job")) {
        return { rows: [{ id: "99999999-9999-4999-8999-999999999999" }] };
      }
      throw new Error(`Unexpected query: ${text}`);
    });
    const repository = createPgSharedHotelSetupStatusRepository({
      connectionString: "postgresql://target-db",
      pool: {
        async query<T extends QueryResultRow = QueryResultRow>(
          text: string,
          values?: readonly unknown[],
        ) {
          const result = await query(text, values);
          return { rows: result.rows as unknown as T[] };
        },
        connect: async () => ({
          query: async <T extends QueryResultRow = QueryResultRow>(
            text: string,
            values?: readonly unknown[],
          ) => {
            const result = await query(text, values);
            return { rows: result.rows as unknown as T[] };
          },
          release,
        }),
        end: vi.fn(async () => undefined),
      },
    });

    await expect(
      repository.updatePublicPropertyProfile({
        organizationId,
        propertyId,
        expectedProfileRevision: 4,
        patch: {
          media: [
            {
              mediaObjectId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
              altText: null,
              sortOrder: 0,
            },
          ],
        },
      }),
    ).resolves.toEqual({ status: "command_in_progress" });

    const publicationFenceCall = query.mock.calls.find(([text]) =>
      text.includes("FROM platform.jobs job"),
    );
    expect(publicationFenceCall?.[0]).toContain("job.queue_name = 'hotel-catalog.property-media'");
    expect(publicationFenceCall?.[0]).toContain(
      "job.job_type = 'hotel-catalog.property-media.publish'",
    );
    expect(publicationFenceCall?.[0]).toContain("job.tenant_scope = 'property'");
    expect(publicationFenceCall?.[0]).toContain("job.resource_type = 'property_media_assignment'");
    expect(publicationFenceCall?.[0]).toContain("job.status IN ('pending', 'running')");
    expect(publicationFenceCall?.[1]).toEqual([propertyId]);
    expect(query.mock.calls.at(-1)?.[0]).toBe("ROLLBACK");
    expect(release).toHaveBeenCalledOnce();
  });

  it("uses the numeric profile revision as the optimistic concurrency token", async () => {
    const query = vi.fn(async (text: string, values?: readonly unknown[]) => {
      if (text.includes("UPDATE hotel_catalog.properties")) {
        return { rows: values?.[3] === 3 ? [{ propertyId }] : [] };
      }
      return { rows: [profileRow({ profileRevision: 4, displayName: "Alpenrose Updated" })] };
    });
    const repository = createPgSharedHotelSetupStatusRepository({
      connectionString: "postgresql://target-db",
      pool: {
        query: async <T extends QueryResultRow = QueryResultRow>(
          text: string,
          values?: readonly unknown[],
        ) => {
          const result = await query(text, values);
          return { rows: result.rows as unknown as T[] };
        },
        end: vi.fn(async () => undefined),
      },
    });

    const updated = await repository.updatePropertyProfile({
      organizationId,
      propertyId,
      expectedProfileRevision: 3,
      profile: { ...minimalHotelInput(), displayName: "Alpenrose Updated" },
    });

    expect(updated).toMatchObject({
      propertyId,
      profileRevision: 4,
      profile: { displayName: "Alpenrose Updated" },
    });
    const sql = query.mock.calls[0]![0];
    expect(sql).toContain("profile_revision = property.profile_revision + 1");
    expect(sql).toContain("property.profile_revision = $4::bigint");
    expect(query.mock.calls[0]![1]).toEqual([
      organizationId,
      propertyId,
      expect.objectContaining({
        display_name: "Alpenrose Updated",
        contacts: expect.arrayContaining([
          expect.objectContaining({
            channel_type: "email",
            purpose: "guest",
            is_public: false,
          }),
        ]),
      }),
      3,
    ]);
  });

  it("creates canonical product links while preserving explicit contact privacy and purpose", async () => {
    const query = vi.fn(async (text: string, _values?: readonly unknown[]) => {
      if (text.includes("FROM platform.idempotency_keys")) {
        return { rows: [] };
      }
      if (text.includes("INSERT INTO platform.idempotency_keys")) {
        return { rows: [{ id: "99999999-9999-4999-8999-999999999901" }] };
      }
      if (text.includes("UPDATE platform.idempotency_keys")) {
        return { rows: [{ id: "99999999-9999-4999-8999-999999999901" }] };
      }
      if (text.includes("INSERT INTO hotel_catalog.properties")) {
        return { rows: [{ propertyId }] };
      }
      return { rows: [profileRow()] };
    });
    const repository = createPgSharedHotelSetupStatusRepository({
      connectionString: "postgresql://target-db",
      pool: {
        query: async <T extends QueryResultRow = QueryResultRow>(
          text: string,
          values?: readonly unknown[],
        ) => {
          const result = await query(text, values);
          return { rows: result.rows as unknown as T[] };
        },
        connect: async () => ({
          query: async <T extends QueryResultRow = QueryResultRow>(
            text: string,
            values?: readonly unknown[],
          ) => {
            const result = await query(text, values);
            return { rows: result.rows as unknown as T[] };
          },
          release: vi.fn(),
        }),
        end: vi.fn(async () => undefined),
      },
    });

    await expect(
      repository.createPropertyProfile({
        organizationId,
        idempotencyKey: "create-profile-001",
        correlationId: "create-profile-001",
        profile: minimalHotelInput(),
      }),
    ).resolves.toEqual(profileResponse(propertyId, minimalHotelInput(), 3));

    const createCall = query.mock.calls.find(([text]) =>
      text.includes("INSERT INTO hotel_catalog.properties"),
    );
    if (!createCall) throw new Error("Expected the transactional property create query");
    const [createSql, createValues] = createCall;
    expect(createSql).toContain("INSERT INTO hotel_catalog.properties");
    expect(createSql).toContain("INSERT INTO identity.organization_resource_links");
    expect(createSql).toContain("WHEN 'booking' THEN 'booking_hotel'");
    expect(createSql).toContain("WHEN 'pms' THEN 'pms_property'");
    expect(createSql).toContain("WHEN 'marketplace' THEN 'hotel_profile'");
    expect(createSql).toContain("INSERT INTO marketplace.marketplace_hotel_profiles");
    expect(createSql).toContain("INSERT INTO booking.booking_settings (property_id)");
    expect(createSql).toContain("contact_input.purpose");
    expect(createSql).toContain("contact_input.is_public");
    expect(createSql).toContain("SET purpose = EXCLUDED.purpose");
    expect(createSql).toContain("is_public = EXCLUDED.is_public");
    expect(createSql).toContain("deleted_external_guest_contacts");
    expect(createSql).toContain("contact.source_system <> 'platform'");
    expect(createSql).not.toContain("INSERT INTO hotel_catalog.property_profiles");
    expect(createSql).not.toContain("INSERT INTO hotel_catalog.property_media");
    expect(createSql).not.toContain("INSERT INTO identity.organizations");
    expect(createSql).not.toContain("property_source_links");
    expect(createValues).toMatchObject([
      organizationId,
      expect.objectContaining({
        display_name: "Hotel Alpenrose",
        property_type: "hotel",
        geo_public: false,
        contacts: expect.arrayContaining([
          {
            channel_type: "email",
            value: "hello@alpenrose.example",
            purpose: "guest",
            is_public: false,
          },
        ]),
      }),
    ]);
  });

  it("does not close caller-owned database pools", async () => {
    const end = vi.fn(async () => undefined);
    const repository = createPgSharedHotelSetupStatusRepository({
      connectionString: "postgresql://target-db",
      pool: {
        async query<T extends QueryResultRow = QueryResultRow>() {
          return { rows: [] as T[] };
        },
        end,
      },
    });

    await repository.close?.();

    expect(end).not.toHaveBeenCalled();
  });
});

function buildSharedSetupApp(options: {
  repository: SharedHotelSetupStatusRepository;
  launchSettingsRepository?: SharedPropertyLaunchSettingsRepository;
  trackCommandRepository?: HotelSetupTrackCommandRepository;
  permissions?: PermissionKey[];
  linkedResources?: LinkedResource[];
  organizationKind?: "hotel_group" | "creator_workspace" | "affiliate_partner" | "platform";
}): FastifyInstance {
  return buildApp({
    logger: false,
    sharedHotelSetupStatusRepository: options.repository,
    propertyLaunchSettingsRepository: options.launchSettingsRepository,
    hotelSetupTrackCommandRepository:
      options.trackCommandRepository ?? unusedTrackCommandRepository(),
    auth: {
      verifier: createFakeVerifier(new Map([["valid-token", session]])),
      repository: identityRepository(options),
      propertyAccessRepository: agencyPropertyAccessRepository,
      rolePermissionRepository: {
        async findPermissionsForRole() {
          return options.permissions ?? ["hotel_catalog.setup.read"];
        },
      },
    },
  });
}

async function requestWithRawHeaders(
  target: FastifyInstance,
  payload: string,
  headers: Record<string, string | string[]>,
): Promise<{ statusCode: number; body: Record<string, unknown> }> {
  await target.listen({ host: "127.0.0.1", port: 0 });
  const address = target.server.address();
  if (!address || typeof address === "string") throw new Error("Test server did not bind to TCP");

  return new Promise((resolve, reject) => {
    const request = httpRequest(
      {
        host: "127.0.0.1",
        port: address.port,
        path: "/api/hotel-setup/tracks",
        method: "PUT",
        headers,
      },
      (response) => {
        let body = "";
        response.setEncoding("utf8");
        response.on("data", (chunk) => {
          body += chunk;
        });
        response.on("end", () => {
          resolve({
            statusCode: response.statusCode ?? 0,
            body: body ? (JSON.parse(body) as Record<string, unknown>) : {},
          });
        });
      },
    );
    request.on("error", reject);
    request.end(payload);
  });
}

function unusedTrackCommandRepository(): HotelSetupTrackCommandRepository {
  return {
    async updateTracks() {
      throw new Error("setup track writes are not used by this test");
    },
    async getTrackStatus() {
      return { trackRevision: 0, selectedTracks: [], tracks: [] };
    },
    async close() {},
  };
}

function identityRepository(options: {
  linkedResources?: LinkedResource[];
  organizationKind?: "hotel_group" | "creator_workspace" | "affiliate_partner" | "platform";
}): IdentityRepository {
  return {
    async findUserByProviderUserId() {
      return {
        userId: "user_hotel_owner",
        email: "owner@example.com",
        status: "active",
      };
    },
    async findOrganizationByWorkosOrgId() {
      return {
        organizationId,
        workosOrgId: session.workosOrgId ?? null,
        kind: options.organizationKind ?? "hotel_group",
        status: "active",
      };
    },
    async findActiveMembership() {
      return {
        membershipId: "membership_hotel_owner",
        status: "active",
        roleKey: "hotel_owner",
        workosMembershipId: "om_hotel_owner",
        workosRoleSlugs: ["hotel_owner"],
      };
    },
    async findLinkedResources() {
      return (
        options.linkedResources ?? [
          propertyLink(propertyId),
          productLink("booking", "booking_hotel", propertyId),
          productLink("pms", "pms_property", propertyId),
          productLink("marketplace", "hotel_profile", propertyId),
        ]
      );
    },
  };
}

function unusedStatusMethods(): Pick<SharedHotelSetupStatusRepository, "getHotelSetupStatus"> {
  return {
    async getHotelSetupStatus() {
      throw new Error("setup status reads are not used by this repository");
    },
  };
}

function repositoryWith(
  properties: AdaptivePropertySetupFacts[],
): SharedHotelSetupStatusRepository {
  return {
    ...unusedPropertyProfileMethods(),
    async getHotelSetupStatus() {
      return {
        hotelGroupDisplayName: "Alpenrose Hotel Group",
        hotelGroupWebsiteUrl: null,
        properties,
      };
    },
  };
}

function profileRepository(
  profiles: Map<string, SharedPropertyProfile>,
): SharedHotelSetupStatusRepository {
  return {
    ...unusedStatusMethods(),
    ...unusedPropertyProfileMethods(),
    async getPropertyProfile({ propertyId: id }) {
      return profiles.get(id) ?? null;
    },
    async createPropertyProfile({ profile }) {
      const created = profileResponse(secondPropertyId, profile);
      profiles.set(secondPropertyId, created);
      return created;
    },
    async updatePropertyProfile({ propertyId: id, expectedProfileRevision, profile }) {
      const existing = profiles.get(id);
      if (!existing || existing.profileRevision !== expectedProfileRevision) {
        return null;
      }
      const updated = profileResponse(id, profile, existing.profileRevision + 1);
      profiles.set(id, updated);
      return updated;
    },
  };
}

function unusedPropertyProfileMethods(): Pick<
  SharedHotelSetupStatusRepository,
  | "getPropertyProfile"
  | "createPropertyProfile"
  | "updatePropertyProfile"
  | "getPublicPropertyProfile"
  | "updatePublicPropertyProfile"
> {
  return {
    async getPropertyProfile() {
      throw new Error("property profile reads are not used by this repository");
    },
    async createPropertyProfile() {
      throw new Error("property profile creates are not used by this repository");
    },
    async updatePropertyProfile() {
      throw new Error("property profile updates are not used by this repository");
    },
    async getPublicPropertyProfile() {
      throw new Error("public property profile reads are not used by this repository");
    },
    async updatePublicPropertyProfile() {
      throw new Error("public property profile updates are not used by this repository");
    },
  };
}

function minimalHotelInput(): SharedPropertyProfileInput {
  return {
    displayName: "Hotel Alpenrose",
    propertyType: "hotel",
    location: {
      countryCode: "DE",
      city: "Munich",
      streetAddress: "Marienplatz 1",
      postalCode: "80331",
      timezone: "Europe/Berlin",
      latitude: null,
      longitude: null,
      localityPublic: false,
      geoPublic: false,
      mapDisplayMode: "hidden",
    },
    contacts: [
      {
        channelType: "email",
        value: "hello@alpenrose.example",
        purpose: "guest",
        isPublic: false,
      },
      {
        channelType: "phone",
        value: "+49 89 123456",
        purpose: "operations",
        isPublic: false,
      },
    ],
  };
}

function profileResponse(
  id: string,
  profile: SharedPropertyProfileInput,
  profileRevision = 1,
): SharedPropertyProfile {
  return {
    propertyId: id,
    profileRevision,
    profile,
  };
}

function publicProfileResponse(profileRevision = 1): PublicPropertyProfileResponse {
  return {
    propertyId,
    profileRevision,
    publicProfile: {
      locale: "en",
      shortDescription: "A quiet stay in the heart of Munich.",
      longDescription: null,
      media: [
        {
          mediaObjectId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
          mediaType: "hero_image",
          url: "https://cdn.vayada.example/alpenrose/hero.webp",
          altText: "Hotel Alpenrose entrance",
          sortOrder: 0,
        },
      ],
    },
  };
}

function profileRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    propertyId,
    profileRevision: "3",
    displayName: "Hotel Alpenrose",
    propertyType: "hotel",
    countryCode: "DE",
    city: "Munich",
    streetAddress: "Marienplatz 1",
    postalCode: "80331",
    timezone: "Europe/Berlin",
    latitude: null,
    longitude: null,
    localityPublic: false,
    geoPublic: false,
    mapDisplayMode: "hidden",
    contacts: [
      {
        channelType: "email",
        value: "hello@alpenrose.example",
        purpose: "guest",
        isPublic: false,
      },
      {
        channelType: "phone",
        value: "+49 89 123456",
        purpose: "operations",
        isPublic: false,
      },
    ],
    ...overrides,
  };
}

function adaptiveStatusRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    propertyId,
    publicId: "property-aaaaaaaa",
    displayName: "Alpenrose Munich",
    propertyType: "hotel",
    city: "Munich",
    countryCode: "DE",
    hasStreetAddress: true,
    hasPostalCode: true,
    hasCity: true,
    hasCountryCode: true,
    hasTimezone: true,
    hasEmail: true,
    hasPhone: true,
    propertyUpdatedAt: "2026-07-26T12:00:00.000Z",
    locationUpdatedAt: "2026-07-26T12:00:00.000Z",
    contactUpdatedAt: "2026-07-26T12:00:00.000Z",
    hasDescription: true,
    hasApprovedMedia: true,
    localityPublic: true,
    profileUpdatedAt: "2026-07-26T12:00:00.000Z",
    mediaUpdatedAt: "2026-07-26T12:00:00.000Z",
    marketplaceProfileStatus: null,
    marketplaceProfileComplete: false,
    marketplaceProfileDescriptionInSync: false,
    marketplaceProfileUpdatedAt: null,
    marketplaceOfferStatus: null,
    marketplaceOfferHasTitle: false,
    marketplaceOfferHasDeliverable: false,
    marketplaceOfferHasCompensation: false,
    marketplaceOfferHasRequirement: false,
    marketplaceOfferPublic: false,
    marketplaceOfferProjectionFresh: true,
    marketplaceOfferUpdatedAt: null,
    marketplaceOfferChildrenUpdatedAt: null,
    marketplaceOfferProjectedAt: null,
    hasActiveRoomType: true,
    hasNonRetiredRoom: true,
    hasActiveRatePlan: true,
    hasFutureInventory: true,
    roomTypeUpdatedAt: "2026-07-26T12:00:00.000Z",
    roomUpdatedAt: "2026-07-26T12:00:00.000Z",
    ratePlanUpdatedAt: "2026-07-26T12:00:00.000Z",
    inventoryUpdatedAt: "2026-07-26T12:00:00.000Z",
    hasCheckInPolicy: true,
    hasCheckOutPolicy: true,
    hasCancellationPolicy: true,
    policyUpdatedAt: "2026-07-26T12:00:00.000Z",
    billingPlanSelected: true,
    billingPlanUpdatedAt: "2026-07-26T12:00:00.000Z",
    paymentsEnabled: true,
    paymentSettingsUpdatedAt: "2026-07-26T12:00:00.000Z",
    hasAcceptedPaymentMethod: true,
    hasEffectivePaymentMethod: true,
    paymentRequiresManualReview: false,
    bookabilityStatus: "public",
    bookabilityFreshness: "fresh",
    bookabilityExpired: false,
    bookabilitySetupReady: true,
    bookabilityMissingEmpty: true,
    bookabilityUpdatedAt: "2026-07-26T12:00:00.000Z",
    ...overrides,
  };
}

function nonEmpty(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function setupPlanContext(input: {
  permissions: PermissionKey[];
  entitlements: ProductEntitlement[];
  linkedResources?: LinkedResource[];
}): RequestContext {
  return {
    actor: {
      internalUserId: "user_hotel_owner",
      providerIdentity: {
        provider: "workos",
        providerUserId: session.workosUserId,
        sessionId: session.sessionId ?? undefined,
        providerOrganizationId: session.workosOrgId ?? undefined,
      },
      email: "owner@example.com",
      status: "active",
    },
    selectedOrganization: {
      organizationId,
      workosOrgId: session.workosOrgId ?? undefined,
      kind: "hotel_group",
      status: "active",
    },
    membership: {
      membershipId: "membership_hotel_owner",
      status: "active",
      roleKey: "hotel_owner",
      workosMembershipId: "om_hotel_owner",
      workosRoleSlugs: ["hotel_owner"],
      permissions: input.permissions,
    },
    linkedResources: input.linkedResources ?? setupPlanLinks(),
    entitlements: input.entitlements,
    locale: "en",
    currency: "EUR",
    audit: {
      requestId: "request-plan-revision",
      source: "api",
      receivedAt: "2026-07-26T10:00:00.000Z",
    },
  };
}

function setupPlanLinks(): LinkedResource[] {
  return [
    propertyLink(propertyId),
    productLink("pms", "pms_property", propertyId),
    productLink("booking", "booking_hotel", propertyId),
  ];
}

function adaptiveProperty(
  id: string,
  overrides: Partial<AdaptivePropertySetupFacts> = {},
): AdaptivePropertySetupFacts {
  return {
    propertyId: id,
    publicId: `property-${id.slice(0, 8)}`,
    displayName: "Alpenrose Munich",
    locationSummary: "Munich, DE",
    taskFacts: taskFacts(),
    ...overrides,
  };
}

function taskFacts(
  overrides: Partial<AdaptivePropertySetupFacts["taskFacts"]> = {},
): AdaptivePropertySetupFacts["taskFacts"] {
  const defaults = Object.fromEntries(
    [
      "shared_identity",
      "public_profile",
      "creator_offer",
      "rooms_rates_availability",
      "guest_settings_policies",
      "billing_plan",
      "payment",
      "direct_booking_publication",
    ].map((taskId) => [
      taskId,
      taskId === "billing_plan"
        ? completedTaskFact("billing_plan")
        : taskFact(taskId as SetupTaskId),
    ]),
  ) as AdaptivePropertySetupFacts["taskFacts"];
  return { ...defaults, ...overrides };
}

function taskFact(
  taskId: SetupTaskId,
  overrides: Partial<AdaptivePropertySetupFacts["taskFacts"][SetupTaskId]> = {},
): AdaptivePropertySetupFacts["taskFacts"][SetupTaskId] {
  return {
    taskId,
    ownerProgress: "not_started",
    readiness: "actionable",
    reasonCodes: [`${taskId}_incomplete`],
    sourceRevision: "1",
    freshness: "fresh",
    ...overrides,
  };
}

function completedTaskFact(
  taskId: SetupTaskId,
): AdaptivePropertySetupFacts["taskFacts"][SetupTaskId] {
  return taskFact(taskId, {
    ownerProgress: "owner_complete",
    readiness: "complete",
    reasonCodes: [],
  });
}

function trackRepository(
  selectedTracks: UpdateTracksResponse["selectedTracks"],
): HotelSetupTrackCommandRepository {
  const tracks: TrackStatus[] = selectedTracks.map((track) => ({
    track,
    provisioning: "active",
    components:
      track === "hotel_operations"
        ? [
            { product: "pms", access: "active" },
            { product: "booking", access: "active" },
          ]
        : [{ product: "marketplace", access: "active" }],
    allowedActions: ["manage_service"],
  }));
  return {
    async updateTracks() {
      throw new Error("setup track writes are not used by this test");
    },
    async getTrackStatus() {
      return { trackRevision: 1, selectedTracks, tracks };
    },
    async close() {},
  };
}

function propertyLink(resourceId: string): LinkedResource {
  return {
    product: "hotel_catalog",
    resourceType: "property",
    resourceId,
    relationship: "owner",
    status: "active",
  };
}

function productLink(
  product: "booking" | "pms" | "marketplace",
  resourceType: "booking_hotel" | "pms_property" | "hotel_profile",
  resourceId: string,
): LinkedResource {
  return { product, resourceType, resourceId, relationship: "owner", status: "active" };
}
