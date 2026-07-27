import { randomUUID } from "node:crypto";

import {
  createFakeVerifier,
  type IdentityRepository,
  type LinkedResource,
  type PermissionKey,
  type ProductEntitlement,
  type VerifiedSession,
} from "@vayada/backend-auth";
import { injectJson } from "@vayada/backend-test";
import type {
  AdaptiveHotelSetupStatus,
  CreateHotelSetupHandoffResponse,
  ExchangeHotelSetupHandoffResponse,
  SetupTrack,
  SetupTaskId,
  TrackStatus,
} from "@vayada/domain-hotels";
import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";

import { buildApp } from "./app.js";
import type { HotelSetupTrackCommandRepository } from "./domains/hotelSetupTrackCommandRepository.js";
import type {
  HotelSetupHandoffAccessSnapshot,
  HotelSetupHandoffBinding,
  HotelSetupHandoffRepository,
  StoredHotelSetupHandoff,
} from "./domains/hotelSetupHandoffRepository.js";
import type {
  AdaptivePropertySetupFacts,
  AdaptiveSetupTaskFact,
  SharedHotelSetupStatusRepository,
} from "./routes/sharedHotelSetupStatus.js";

const organizationId = "11111111-1111-4111-8111-111111111111";
const otherOrganizationId = "22222222-2222-4222-8222-222222222222";
const propertyId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const ownerUserId = "33333333-3333-4333-8333-333333333333";
const otherUserId = "44444444-4444-4444-8444-444444444444";
const ownerMembershipId = "55555555-5555-4555-8555-555555555555";
const otherMembershipId = "66666666-6666-4666-8666-666666666666";
const ownerSession: VerifiedSession = {
  workosUserId: "workos_owner",
  workosOrgId: "workos_org",
  sessionId: "session_owner",
  expiresAt: Math.floor(Date.now() / 1_000) + 3_600,
};
const wrongUserSession: VerifiedSession = {
  ...ownerSession,
  workosUserId: "workos_other_user",
  sessionId: "session_other_user",
};
const wrongOrganizationSession: VerifiedSession = {
  ...ownerSession,
  workosOrgId: "workos_other_org",
  sessionId: "session_other_org",
};

let app: FastifyInstance | undefined;

afterEach(async () => {
  await app?.close();
  app = undefined;
});

describe("hotel setup handoff routes", () => {
  it("issues an allowlisted launch URL containing only a high-entropy code", async () => {
    const fixture = handoffFixture();
    app = fixture.app;
    const planRevision = await currentPlanRevision(app);

    const response = await createHandoff(app, planRevision);

    expect(response.statusCode).toBe(201);
    const launch = new URL(response.body.launchUrl);
    expect(launch.origin).toBe("https://pms.localhost:1355");
    expect(launch.pathname).toBe("/handoff");
    expect([...launch.searchParams.keys()]).toEqual(["code"]);
    expect(launch.searchParams.get("code")).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(response.body).toEqual({
      launchUrl: launch.toString(),
      expiresAt: "2026-07-26T18:05:00.000Z",
    });
    expect(JSON.stringify(response.body)).not.toContain(propertyId);

    const stored = fixture.handoffs.records.values().next().value as StoredHotelSetupHandoff;
    expect(stored).toMatchObject({
      internalUserId: ownerUserId,
      providerSessionId: ownerSession.sessionId,
      organizationId,
      membershipId: ownerMembershipId,
      propertyId,
      taskId: "rooms_rates_availability",
      destinationRouteKey: "pms.rooms_rates_availability",
      returnUrl: `https://marketplace.localhost:1355/setup?propertyId=${propertyId}`,
    });
  });

  it("issues and exchanges a correction handoff for a rejected Marketplace task", async () => {
    const fixture = handoffFixture();
    app = fixture.app;
    fixture.setup.selectedTracks = ["creator_marketplace"];
    fixture.setup.tracks = [
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
        provisioning: "active",
        components: [{ product: "marketplace", access: "active" }],
        allowedActions: ["manage_service"],
      },
    ];
    fixture.setup.entitlements = [
      { product: "marketplace", key: "marketplace-hotel-profile", status: "active" },
    ];
    fixture.setup.property.taskFacts.public_profile = taskFact("public_profile", true);
    fixture.setup.property.taskFacts.creator_profile = {
      ...taskFact("creator_profile"),
      ownerProgress: "in_progress",
      readiness: "rejected",
      reasonCodes: ["creator_profile_rejected"],
    };

    const status = await injectJson<AdaptiveHotelSetupStatus>(app, {
      method: "GET",
      url: `/api/hotel-setup/status?propertyId=${propertyId}`,
      headers: { authorization: "Bearer valid-token" },
    });
    expect(status.body.setupPlan?.recommendedTaskId).toBe("creator_profile");
    expect(
      status.body.setupPlan?.tasks.find(({ taskId }) => taskId === "creator_profile"),
    ).toMatchObject({
      readiness: "rejected",
      reasonCodes: ["creator_profile_rejected"],
      callerCapability: "allowed",
    });

    const created = await createHandoff(
      app,
      status.body.setupPlan!.planRevision,
      "creator_profile",
    );
    expect(created.statusCode).toBe(201);
    const launch = new URL(created.body.launchUrl);
    expect(launch.origin).toBe("https://marketplace.localhost:1355");

    const code = launch.searchParams.get("code")!;
    const exchanged = await exchangeHandoff(app, code);
    expect(exchanged).toMatchObject({
      statusCode: 200,
      body: {
        propertyId,
        taskId: "creator_profile",
        destinationRouteKey: "marketplace.creator_profile",
      },
    });
  });

  it("exchanges once atomically and rejects a concurrent race loser", async () => {
    const fixture = handoffFixture();
    app = fixture.app;
    const created = await createHandoff(app, await currentPlanRevision(app));
    const code = new URL(created.body.launchUrl).searchParams.get("code")!;

    const responses = await Promise.all([exchangeHandoff(app, code), exchangeHandoff(app, code)]);

    expect(responses.map(({ statusCode }) => statusCode).sort()).toEqual([200, 409]);
    const successful = responses.find(({ statusCode }) => statusCode === 200)!;
    expect(successful.body).toEqual({
      propertyId,
      taskId: "rooms_rates_availability",
      issuedPlanRevision: expect.any(String),
      destinationRouteKey: "pms.rooms_rates_availability",
      returnUrl: `https://marketplace.localhost:1355/setup?propertyId=${propertyId}`,
    });
    expect(responses.find(({ statusCode }) => statusCode === 409)!.body).toEqual({
      code: "invalid_handoff",
    });
  });

  it("rejects expired and reused codes without returning stored context", async () => {
    const fixture = handoffFixture();
    app = fixture.app;
    const first = await createHandoff(app, await currentPlanRevision(app));
    const firstCode = new URL(first.body.launchUrl).searchParams.get("code")!;
    expect((await exchangeHandoff(app, firstCode)).statusCode).toBe(200);
    expect(await exchangeHandoff(app, firstCode)).toMatchObject({
      statusCode: 409,
      body: { code: "invalid_handoff" },
    });

    const second = await createHandoff(app, await currentPlanRevision(app));
    const secondCode = new URL(second.body.launchUrl).searchParams.get("code")!;
    fixture.clock.now = new Date("2026-07-26T18:05:00.001Z");
    expect(await exchangeHandoff(app, secondCode)).toMatchObject({
      statusCode: 409,
      body: { code: "invalid_handoff" },
    });
  });

  it("rejects the wrong user or selected organization without consuming the code", async () => {
    const fixture = handoffFixture();
    app = fixture.app;
    const created = await createHandoff(app, await currentPlanRevision(app));
    const code = new URL(created.body.launchUrl).searchParams.get("code")!;

    for (const token of ["wrong-user-token", "wrong-org-token"]) {
      const response = await exchangeHandoff(app, code, token);
      expect(response.statusCode).toBe(409);
      expect(response.body).toEqual({ code: "invalid_handoff" });
    }
    expect((await exchangeHandoff(app, code)).statusCode).toBe(200);
  });

  it("returns refresh_plan when authoritative readiness changes before exchange", async () => {
    const fixture = handoffFixture();
    app = fixture.app;
    const originalRevision = await currentPlanRevision(app);
    const created = await createHandoff(app, originalRevision);
    const code = new URL(created.body.launchUrl).searchParams.get("code")!;

    fixture.setup.property.taskFacts.shared_identity.sourceRevision = "shared-r2";
    expect(await exchangeHandoff(app, code)).toMatchObject({
      statusCode: 409,
      body: { code: "refresh_plan" },
    });
    expect(fixture.handoffs.records.get(code)?.consumed).toBe(false);

    fixture.setup.property.taskFacts.shared_identity.sourceRevision = "shared-r1";
    expect((await exchangeHandoff(app, code)).statusCode).toBe(200);
  });

  it("returns refresh_plan when authorization changes without a fact revision", async () => {
    const fixture = handoffFixture();
    app = fixture.app;
    const originalFactRevisions = Object.fromEntries(
      Object.entries(fixture.setup.property.taskFacts).map(([taskId, fact]) => [
        taskId,
        fact.sourceRevision,
      ]),
    );
    const created = await createHandoff(app, await currentPlanRevision(app));
    const code = new URL(created.body.launchUrl).searchParams.get("code")!;

    const originalPermissions = fixture.setup.permissions;
    fixture.setup.permissions = originalPermissions.filter(
      (permission) => permission !== "pms.operations.manage",
    );
    expect(await exchangeHandoff(app, code)).toMatchObject({
      statusCode: 409,
      body: { code: "refresh_plan" },
    });
    fixture.setup.permissions = originalPermissions;

    const pmsEntitlement = fixture.setup.entitlements.find(({ product }) => product === "pms")!;
    pmsEntitlement.status = "suspended";
    expect(await exchangeHandoff(app, code)).toMatchObject({
      statusCode: 409,
      body: { code: "refresh_plan" },
    });
    pmsEntitlement.status = "active";

    const originalLinks = fixture.identity.linksByOrganization.get(organizationId)!;
    fixture.identity.linksByOrganization.set(
      organizationId,
      originalLinks.filter(({ product }) => product !== "pms"),
    );
    expect(await exchangeHandoff(app, code)).toMatchObject({
      statusCode: 409,
      body: { code: "refresh_plan" },
    });
    fixture.identity.linksByOrganization.set(organizationId, originalLinks);

    expect(
      Object.fromEntries(
        Object.entries(fixture.setup.property.taskFacts).map(([taskId, fact]) => [
          taskId,
          fact.sourceRevision,
        ]),
      ),
    ).toEqual(originalFactRevisions);
    expect((await exchangeHandoff(app, code)).statusCode).toBe(200);
  });

  it("revalidates permission changes at the atomic consume authorization boundary", async () => {
    const fixture = handoffFixture();
    app = fixture.app;
    const created = await createHandoff(app, await currentPlanRevision(app));
    const code = new URL(created.body.launchUrl).searchParams.get("code")!;

    fixture.handoffs.atConsumeAuthorizationSnapshot = () => {
      fixture.setup.permissions = fixture.setup.permissions.filter(
        (permission) => permission !== "pms.operations.manage",
      );
    };

    const changedPermission = await exchangeHandoff(app, code);
    expect(changedPermission.statusCode).toBe(409);
    expect(changedPermission.body).toEqual({ code: "refresh_plan" });
    expect(fixture.handoffs.records.get(code)?.consumed).toBe(true);
    const replay = await exchangeHandoff(app, code);
    expect(replay.statusCode).toBe(409);
    expect(replay.body).toEqual({ code: "invalid_handoff" });
  });

  it("revalidates plan changes at the atomic consume authorization boundary", async () => {
    const fixture = handoffFixture();
    app = fixture.app;
    const created = await createHandoff(app, await currentPlanRevision(app));
    const code = new URL(created.body.launchUrl).searchParams.get("code")!;

    fixture.handoffs.atConsumeAuthorizationSnapshot = () => {
      fixture.setup.property.taskFacts.rooms_rates_availability.sourceRevision = "rooms-r2";
    };

    const changedPlan = await exchangeHandoff(app, code);
    expect(changedPlan.statusCode).toBe(409);
    expect(changedPlan.body).toEqual({ code: "refresh_plan" });
    expect(fixture.handoffs.records.get(code)?.consumed).toBe(true);
    const replay = await exchangeHandoff(app, code);
    expect(replay.statusCode).toBe(409);
    expect(replay.body).toEqual({ code: "invalid_handoff" });
  });

  it("rechecks active property access and exact request fields", async () => {
    const fixture = handoffFixture();
    app = fixture.app;
    const planRevision = await currentPlanRevision(app);
    const extraRoute = await injectJson<{ code: string }>(app, {
      method: "POST",
      url: "/api/hotel-setup/handoffs",
      headers: { authorization: "Bearer valid-token" },
      payload: {
        propertyId,
        taskId: "rooms_rates_availability",
        planRevision,
        destinationRoute: "https://attacker.example/handoff",
      },
    });
    expect(extraRoute).toMatchObject({
      statusCode: 422,
      body: { code: "invalid_handoff" },
    });

    const created = await createHandoff(app, planRevision);
    const code = new URL(created.body.launchUrl).searchParams.get("code")!;
    const stored = fixture.handoffs.records.get(code)!;
    stored.returnUrl = "https://attacker.example/setup?propertyId=" + propertyId;
    expect(await exchangeHandoff(app, code)).toMatchObject({
      statusCode: 409,
      body: { code: "invalid_handoff" },
    });
    expect(stored.consumed).toBe(false);
    stored.returnUrl = `https://marketplace.localhost:1355/setup?propertyId=${propertyId}`;

    fixture.identity.linksByOrganization.set(
      organizationId,
      fixture.identity.linksByOrganization
        .get(organizationId)!
        .filter((resource) => resource.product !== "hotel_catalog"),
    );
    expect(await exchangeHandoff(app, code)).toMatchObject({
      statusCode: 409,
      body: { code: "invalid_handoff" },
    });
  });
});

function handoffFixture() {
  const clock = { now: new Date("2026-07-26T18:00:00.000Z") };
  const setup = mutableSetup();
  const identity = mutableIdentity();
  const handoffs = memoryHandoffRepository(clock, () =>
    currentAccessSnapshot(setup, identity.linksByOrganization.get(organizationId) ?? []),
  );
  const trackRepository = setupTrackRepository(setup);
  const setupRepository = setupStatusRepository(setup);
  const target = buildApp({
    logger: false,
    auth: {
      verifier: createFakeVerifier(
        new Map([
          ["valid-token", ownerSession],
          ["wrong-user-token", wrongUserSession],
          ["wrong-org-token", wrongOrganizationSession],
        ]),
      ),
      repository: identity.repository,
      rolePermissionRepository: {
        async findPermissionsForRole() {
          return setup.permissions;
        },
      },
      entitlementRepository: {
        async findEntitlementsForContext() {
          return setup.entitlements;
        },
      },
    },
    sharedHotelSetupStatusRepository: setupRepository,
    hotelSetupTrackCommandRepository: trackRepository,
    hotelSetupHandoffs: {
      repository: handoffs.repository,
      hotelSetupBaseUrl: "https://marketplace.localhost:1355/setup",
      destinationOrigins: {
        marketplace: "https://marketplace.localhost:1355",
        bookingAdmin: "https://admin.booking.localhost:1355",
        pms: "https://pms.localhost:1355",
      },
    },
  });
  return { app: target, clock, setup, handoffs, identity };
}

async function currentPlanRevision(target: FastifyInstance): Promise<string> {
  const response = await injectJson<AdaptiveHotelSetupStatus>(target, {
    method: "GET",
    url: `/api/hotel-setup/status?propertyId=${propertyId}`,
    headers: { authorization: "Bearer valid-token" },
  });
  expect(response.statusCode).toBe(200);
  return response.body.setupPlan!.planRevision;
}

function createHandoff(
  target: FastifyInstance,
  planRevision: string,
  taskId: SetupTaskId = "rooms_rates_availability",
) {
  return injectJson<CreateHotelSetupHandoffResponse>(target, {
    method: "POST",
    url: "/api/hotel-setup/handoffs",
    headers: { authorization: "Bearer valid-token" },
    payload: { propertyId, taskId, planRevision },
  });
}

function exchangeHandoff(target: FastifyInstance, code: string, token = "valid-token") {
  return injectJson<ExchangeHotelSetupHandoffResponse | { code: string }>(target, {
    method: "POST",
    url: "/api/hotel-setup/handoffs/exchange",
    headers: { authorization: `Bearer ${token}` },
    payload: { code },
  });
}

function mutableSetup(): {
  property: AdaptivePropertySetupFacts;
  trackRevision: number;
  selectedTracks: SetupTrack[];
  tracks: TrackStatus[];
  permissions: PermissionKey[];
  entitlements: ProductEntitlement[];
} {
  return {
    property: {
      propertyId,
      publicId: "property-alpenrose",
      displayName: "Alpenrose",
      locationSummary: "Munich, DE",
      taskFacts: {
        shared_identity: taskFact("shared_identity", true),
        public_profile: taskFact("public_profile"),
        creator_profile: taskFact("creator_profile"),
        creator_offer: taskFact("creator_offer"),
        rooms_rates_availability: taskFact("rooms_rates_availability"),
        guest_settings_policies: taskFact("guest_settings_policies"),
        payment: taskFact("payment"),
        direct_booking_publication: taskFact("direct_booking_publication"),
      },
    },
    trackRevision: 1,
    selectedTracks: ["hotel_operations"],
    tracks: [
      {
        track: "hotel_operations",
        provisioning: "active",
        components: [
          { product: "pms", access: "active" },
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
    permissions: [
      "hotel_catalog.setup.read",
      "hotel_catalog.setup.manage",
      "hotel_catalog.products.manage",
      "pms.operations.manage",
      "booking.settings.manage",
      "marketplace.profile.manage",
    ],
    entitlements: [
      { product: "pms", key: "property-management", status: "active" },
      { product: "booking", key: "booking-engine", status: "active" },
    ],
  };
}

function taskFact(taskId: SetupTaskId, complete = false): AdaptiveSetupTaskFact {
  return {
    taskId,
    ownerProgress: complete ? "owner_complete" : "not_started",
    readiness: complete ? "complete" : "actionable",
    reasonCodes: [],
    sourceRevision: complete ? "shared-r1" : `${taskId}-r1`,
    freshness: "fresh",
  };
}

function setupStatusRepository(
  setup: ReturnType<typeof mutableSetup>,
): SharedHotelSetupStatusRepository {
  return {
    async getHotelSetupStatus() {
      return {
        hotelGroupDisplayName: "Alpenrose Group",
        hotelGroupWebsiteUrl: null,
        properties: [setup.property],
      };
    },
    async getPropertyProfile() {
      throw new Error("not used");
    },
    async createPropertyProfile() {
      throw new Error("not used");
    },
    async updatePropertyProfile() {
      throw new Error("not used");
    },
    async getPublicPropertyProfile() {
      throw new Error("not used");
    },
    async updatePublicPropertyProfile() {
      throw new Error("not used");
    },
  };
}

function setupTrackRepository(
  setup: ReturnType<typeof mutableSetup>,
): HotelSetupTrackCommandRepository {
  return {
    async getTrackStatus() {
      return {
        trackRevision: setup.trackRevision,
        selectedTracks: setup.selectedTracks,
        tracks: setup.tracks,
      };
    },
    async updateTracks() {
      throw new Error("not used");
    },
    async close() {},
  };
}

function mutableIdentity() {
  const links = propertyLinks();
  const linksByOrganization = new Map<string, LinkedResource[]>([
    [organizationId, links],
    [otherOrganizationId, links],
  ]);
  const repository: IdentityRepository = {
    async findUserByProviderUserId(_provider, providerUserId) {
      return {
        userId: providerUserId === "workos_other_user" ? otherUserId : ownerUserId,
        email: "owner@example.test",
        status: "active",
      };
    },
    async findOrganizationByWorkosOrgId(workosOrgId) {
      const other = workosOrgId === "workos_other_org";
      return {
        organizationId: other ? otherOrganizationId : organizationId,
        workosOrgId,
        kind: "hotel_group",
        status: "active",
      };
    },
    async findActiveMembership(userId, selectedOrganizationId) {
      const other = userId === otherUserId || selectedOrganizationId === otherOrganizationId;
      return {
        membershipId: other ? otherMembershipId : ownerMembershipId,
        status: "active",
        roleKey: "hotel_owner",
        workosMembershipId: other ? "om_other" : "om_owner",
        workosRoleSlugs: ["hotel_owner"],
      };
    },
    async findLinkedResources(selectedOrganizationId) {
      return linksByOrganization.get(selectedOrganizationId) ?? [];
    },
  };
  return { repository, linksByOrganization };
}

function propertyLinks(): LinkedResource[] {
  return [
    {
      product: "hotel_catalog",
      resourceType: "property",
      resourceId: propertyId,
      relationship: "owner",
      status: "active",
    },
    {
      product: "pms",
      resourceType: "pms_property",
      resourceId: propertyId,
      relationship: "owner",
      status: "active",
    },
    {
      product: "booking",
      resourceType: "booking_hotel",
      resourceId: propertyId,
      relationship: "owner",
      status: "active",
    },
    {
      product: "marketplace",
      resourceType: "hotel_profile",
      resourceId: propertyId,
      relationship: "owner",
      status: "active",
    },
  ];
}

function currentAccessSnapshot(
  setup: ReturnType<typeof mutableSetup>,
  linkedResources: LinkedResource[],
): HotelSetupHandoffAccessSnapshot {
  return {
    permissions: [...setup.permissions],
    linkedResources: linkedResources.map((resource) => ({ ...resource })),
    entitlements: setup.entitlements.map((entitlement) => ({
      ...entitlement,
      ...(entitlement.resource ? { resource: { ...entitlement.resource } } : {}),
    })),
  };
}

function memoryHandoffRepository(
  clock: { now: Date },
  getCurrentAccess: () => HotelSetupHandoffAccessSnapshot,
) {
  const records = new Map<string, StoredHotelSetupHandoff & { consumed: boolean }>();
  let sequence = 1;
  const hooks: {
    atConsumeAuthorizationSnapshot?: () => void | Promise<void>;
  } = {};
  const repository: HotelSetupHandoffRepository = {
    async issue(input) {
      const code = Buffer.alloc(32, sequence++).toString("base64url");
      const expiresAt = new Date(clock.now.getTime() + 5 * 60 * 1_000).toISOString();
      records.set(code, {
        id: randomUUID(),
        ...input.binding,
        propertyId: input.propertyId,
        taskId: input.taskId,
        issuedPlanRevision: input.issuedPlanRevision,
        destinationRouteKey: input.destinationRouteKey,
        returnUrl: input.returnUrl,
        expiresAt,
        consumed: false,
      });
      return { code, expiresAt };
    },
    async findActive(code) {
      const record = records.get(code);
      return record && !record.consumed && Date.parse(record.expiresAt) > clock.now.getTime()
        ? record
        : null;
    },
    async consume({ id, code, binding }) {
      const record = records.get(code);
      if (
        !record ||
        record.id !== id ||
        record.consumed ||
        Date.parse(record.expiresAt) <= clock.now.getTime() ||
        !sameBinding(record, binding)
      ) {
        return null;
      }
      record.consumed = true;
      await hooks.atConsumeAuthorizationSnapshot?.();
      return {
        ...record,
        access: getCurrentAccess(),
      };
    },
    async close() {},
  };
  return {
    repository,
    records,
    get atConsumeAuthorizationSnapshot() {
      return hooks.atConsumeAuthorizationSnapshot;
    },
    set atConsumeAuthorizationSnapshot(value: (() => void | Promise<void>) | undefined) {
      hooks.atConsumeAuthorizationSnapshot = value;
    },
  };
}

function sameBinding(left: HotelSetupHandoffBinding, right: HotelSetupHandoffBinding): boolean {
  return (
    left.internalUserId === right.internalUserId &&
    left.providerSessionId === right.providerSessionId &&
    left.organizationId === right.organizationId &&
    left.membershipId === right.membershipId
  );
}
