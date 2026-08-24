import {
  createFakeVerifier,
  type IdentityRepository,
  type PermissionKey,
  type VerifiedSession,
} from "@vayada/backend-auth";
import { injectJson } from "@vayada/backend-test";
import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";

import { buildApp } from "./app.js";
import { agencyPropertyAccessRepository } from "./testAuthorization.js";
import {
  createPgMarketplaceTripRepository,
  type MarketplaceExternalCollaboration,
  type MarketplaceExternalCollaborationListResponse,
  type MarketplaceTrip,
  type MarketplaceTripError,
  type MarketplaceTripListResponse,
  type MarketplaceTripPool,
  type MarketplaceTripReadRepository,
} from "./routes/marketplaceTrips.js";

const futureExpiry = Math.floor(Date.now() / 1000) + 3600;

const session: VerifiedSession = {
  workosUserId: "user_workos_creator",
  workosOrgId: "org_workos_creator",
  sessionId: "session_creator",
  expiresAt: futureExpiry,
};

const creatorProfileId = "creator_profile_lina";
const creatorOrganizationId = "org_creator_workspace";

const externalCollaboration: MarketplaceExternalCollaboration = {
  contractVersion: "marketplace-trips-external.v1",
  authorizationMode: "creator_workspace_resource_link",
  externalCollaborationId: "external_collab_seehof",
  creatorProfileId,
  organizationId: creatorOrganizationId,
  tripId: "trip_bali_2026",
  sourceExternalCollaborationId: "legacy_external_seehof",
  title: "Seehof winter reel",
  hotelName: "Hotel Seehof",
  locationText: "Tyrol, Austria",
  collaborationType: "custom_external",
  startDate: "2026-09-12",
  endDate: "2026-09-16",
  deliverablesSummary: "One reel, three stories",
  notes: "Confirmed by email.",
  createdAt: "2026-06-01T10:00:00.000Z",
  updatedAt: "2026-06-02T10:00:00.000Z",
};

const trip: MarketplaceTrip = {
  contractVersion: "marketplace-trips-external.v1",
  authorizationMode: "creator_workspace_resource_link",
  tripId: "trip_bali_2026",
  creatorProfileId,
  organizationId: creatorOrganizationId,
  sourceTripId: "legacy_trip_bali",
  name: "Bali creator trip",
  locationText: "Canggu, Indonesia",
  startDate: "2026-09-10",
  endDate: "2026-09-20",
  notes: "September campaign travel.",
  externalCollaborations: [externalCollaboration],
  createdAt: "2026-05-01T10:00:00.000Z",
  updatedAt: "2026-05-02T10:00:00.000Z",
};

function createTripRepository(seed: MarketplaceTrip[] = [trip]): MarketplaceTripReadRepository {
  const trips = seed.map((item) => ({
    ...item,
    externalCollaborations: [...item.externalCollaborations],
  }));
  return {
    async listTripsForCreatorProfile(profileId) {
      return trips.filter((item) => item.creatorProfileId === profileId);
    },
    async findTripForCreatorProfile(profileId, tripId) {
      return (
        trips.find((item) => item.creatorProfileId === profileId && item.tripId === tripId) ?? null
      );
    },
    async listExternalCollaborationsForCreatorProfile(profileId) {
      return trips
        .flatMap((item) => item.externalCollaborations)
        .filter((item) => item.creatorProfileId === profileId);
    },
    async createTrip(input) {
      const now = "2026-07-21T10:00:00.000Z";
      const created: MarketplaceTrip = {
        contractVersion: "marketplace-trips-external.v1",
        authorizationMode: "creator_workspace_resource_link",
        tripId: `trip_created_${trips.length + 1}`,
        creatorProfileId: input.creatorProfileId,
        organizationId: input.organizationId,
        sourceTripId: null,
        ...input.trip,
        externalCollaborations: [],
        createdAt: now,
        updatedAt: now,
      };
      trips.push(created);
      return created;
    },
    async updateTrip(input) {
      const target = trips.find(
        (item) =>
          item.tripId === input.tripId &&
          item.creatorProfileId === input.creatorProfileId &&
          item.organizationId === input.organizationId,
      );
      if (!target) return null;
      Object.assign(target, input.patch, { updatedAt: "2026-07-21T11:00:00.000Z" });
      return target;
    },
    async deleteTrip(input) {
      const index = trips.findIndex(
        (item) =>
          item.tripId === input.tripId &&
          item.creatorProfileId === input.creatorProfileId &&
          item.organizationId === input.organizationId,
      );
      if (index < 0) return false;
      trips.splice(index, 1);
      return true;
    },
    async createExternalCollaboration(input) {
      const parent = input.collaboration.tripId
        ? trips.find(
            (item) =>
              item.tripId === input.collaboration.tripId &&
              item.creatorProfileId === input.creatorProfileId &&
              item.organizationId === input.organizationId,
          )
        : undefined;
      if (input.collaboration.tripId && !parent) return null;
      const created: MarketplaceExternalCollaboration = {
        contractVersion: "marketplace-trips-external.v1",
        authorizationMode: "creator_workspace_resource_link",
        externalCollaborationId: `external_created_${trips.length + 1}`,
        creatorProfileId: input.creatorProfileId,
        organizationId: input.organizationId,
        sourceExternalCollaborationId: null,
        ...input.collaboration,
        createdAt: "2026-07-21T10:00:00.000Z",
        updatedAt: "2026-07-21T10:00:00.000Z",
      };
      (parent ?? trips[0])?.externalCollaborations.push(created);
      return created;
    },
    async updateExternalCollaboration(input) {
      const target = trips
        .flatMap((item) => item.externalCollaborations)
        .find(
          (item) =>
            item.externalCollaborationId === input.externalCollaborationId &&
            item.creatorProfileId === input.creatorProfileId &&
            item.organizationId === input.organizationId,
        );
      if (!target) return null;
      Object.assign(target, input.patch, { updatedAt: "2026-07-21T11:00:00.000Z" });
      return target;
    },
    async deleteExternalCollaboration(input) {
      for (const tripItem of trips) {
        const index = tripItem.externalCollaborations.findIndex(
          (item) =>
            item.externalCollaborationId === input.externalCollaborationId &&
            item.creatorProfileId === input.creatorProfileId &&
            item.organizationId === input.organizationId,
        );
        if (index >= 0) {
          tripItem.externalCollaborations.splice(index, 1);
          return true;
        }
      }
      return false;
    },
  };
}

function identityRepository(
  options: {
    organizationKind?: "creator_workspace" | "hotel_group";
    linkedResources?: Awaited<ReturnType<IdentityRepository["findLinkedResources"]>>;
  } = {},
): IdentityRepository {
  const organizationKind = options.organizationKind ?? "creator_workspace";
  return {
    async findUserByProviderUserId() {
      return {
        userId: "user_creator",
        email: "creator@example.com",
        status: "active",
      };
    },
    async findOrganizationByWorkosOrgId() {
      return {
        organizationId:
          organizationKind === "creator_workspace" ? creatorOrganizationId : "org_hotel_group",
        workosOrgId: session.workosOrgId ?? null,
        kind: organizationKind,
        status: "active",
      };
    },
    async findActiveMembership() {
      return {
        membershipId: "membership_creator",
        status: "active",
        roleKey: organizationKind === "creator_workspace" ? "creator_owner" : "hotel_owner",
        workosMembershipId: "om_creator",
        workosRoleSlugs: [
          organizationKind === "creator_workspace" ? "creator_owner" : "hotel_owner",
        ],
      };
    },
    async findLinkedResources() {
      return (
        options.linkedResources ?? [
          {
            product: "marketplace",
            resourceType: "creator_profile",
            resourceId: creatorProfileId,
            relationship: "owner",
            status: "active",
          },
        ]
      );
    },
  };
}

function buildMarketplaceTripApp(
  options: {
    permissions?: PermissionKey[];
    repository?: MarketplaceTripReadRepository;
    organizationKind?: "creator_workspace" | "hotel_group";
    linkedResources?: Awaited<ReturnType<IdentityRepository["findLinkedResources"]>>;
  } = {},
): FastifyInstance {
  return buildApp({
    logger: false,
    marketplaceTripRepository: options.repository ?? createTripRepository(),
    auth: {
      verifier: createFakeVerifier(new Map([["valid-token", session]])),
      repository: identityRepository({
        organizationKind: options.organizationKind,
        linkedResources: options.linkedResources,
      }),
      propertyAccessRepository: agencyPropertyAccessRepository,
      rolePermissionRepository: {
        async findPermissionsForRole() {
          return options.permissions ?? ["marketplace.trip.read"];
        },
      },
    },
  });
}

let app: FastifyInstance | undefined;

afterEach(async () => {
  await app?.close();
  app = undefined;
});

describe("marketplace trips dark routes", () => {
  it("returns creator-scoped trips with nested external collaborations", async () => {
    app = buildMarketplaceTripApp();

    const response = await injectJson<MarketplaceTripListResponse>(app, {
      method: "GET",
      url: "/api/marketplace/trips",
      headers: { authorization: "Bearer valid-token" },
    });

    expect(response.statusCode).toBe(200);
    expect(response.body.contractVersion).toBe("marketplace-trips-external.v1");
    expect(response.body.authorizationMode).toBe("creator_workspace_resource_link");
    expect(response.body.creatorProfileId).toBe(creatorProfileId);
    expect(response.body.organizationId).toBe(creatorOrganizationId);
    expect(response.body.items).toHaveLength(1);
    expect(response.body.items[0]).toMatchObject({
      tripId: "trip_bali_2026",
      creatorProfileId,
      organizationId: creatorOrganizationId,
      name: "Bali creator trip",
      locationText: "Canggu, Indonesia",
      startDate: "2026-09-10",
      endDate: "2026-09-20",
    });
    expect(response.body.items[0].externalCollaborations[0]).toMatchObject({
      externalCollaborationId: "external_collab_seehof",
      tripId: "trip_bali_2026",
      hotelName: "Hotel Seehof",
      collaborationType: "custom_external",
    });
    expect(JSON.stringify(response.body)).not.toContain("ownerUserId");
    expect(JSON.stringify(response.body)).not.toContain("workosOrgId");
    expect(JSON.stringify(response.body)).not.toContain("membershipId");
  });

  it("returns a single creator-owned trip detail", async () => {
    app = buildMarketplaceTripApp();

    const response = await injectJson<MarketplaceTrip>(app, {
      method: "GET",
      url: "/api/marketplace/trips/trip_bali_2026",
      headers: { authorization: "Bearer valid-token" },
    });

    expect(response.statusCode).toBe(200);
    expect(response.body.tripId).toBe("trip_bali_2026");
    expect(response.body.creatorProfileId).toBe(creatorProfileId);
    expect(response.body.externalCollaborations).toHaveLength(1);
  });

  it("returns creator-scoped external collaborations", async () => {
    app = buildMarketplaceTripApp();

    const response = await injectJson<MarketplaceExternalCollaborationListResponse>(app, {
      method: "GET",
      url: "/api/marketplace/trips/external-collaborations",
      headers: { authorization: "Bearer valid-token" },
    });

    expect(response.statusCode).toBe(200);
    expect(response.body.items).toHaveLength(1);
    expect(response.body.items[0]).toMatchObject({
      externalCollaborationId: "external_collab_seehof",
      creatorProfileId,
      tripId: "trip_bali_2026",
      deliverablesSummary: "One reel, three stories",
    });
  });

  it("creates, updates, and deletes creator-scoped trips", async () => {
    app = buildMarketplaceTripApp({
      permissions: ["marketplace.trip.read", "marketplace.trip.manage"],
    });

    const created = await injectJson<MarketplaceTrip>(app, {
      method: "POST",
      url: "/api/marketplace/trips",
      headers: {
        authorization: "Bearer valid-token",
        "idempotency-key": "trip-create-berlin-1",
      },
      payload: {
        name: "Berlin campaign",
        locationText: "Berlin, Germany",
        startDate: "2026-10-10",
        endDate: "2026-10-15",
        notes: "Autumn launch",
      },
    });
    expect(created.statusCode).toBe(201);
    expect(created.body).toMatchObject({
      creatorProfileId,
      organizationId: creatorOrganizationId,
      name: "Berlin campaign",
      startDate: "2026-10-10",
    });

    const updated = await injectJson<MarketplaceTrip>(app, {
      method: "PUT",
      url: `/api/marketplace/trips/${created.body.tripId}`,
      headers: {
        authorization: "Bearer valid-token",
        "idempotency-key": "trip-update-berlin-1",
      },
      payload: { name: "Berlin winter campaign", notes: null },
    });
    expect(updated.statusCode).toBe(200);
    expect(updated.body).toMatchObject({ name: "Berlin winter campaign", notes: null });

    const deleted = await app.inject({
      method: "DELETE",
      url: `/api/marketplace/trips/${created.body.tripId}`,
      headers: {
        authorization: "Bearer valid-token",
        "idempotency-key": "trip-delete-berlin-1",
      },
    });
    expect(deleted.statusCode).toBe(204);
  });

  it("creates and maintains external collaborations inside the creator scope", async () => {
    app = buildMarketplaceTripApp({
      permissions: ["marketplace.trip.read", "marketplace.trip.manage"],
    });

    const created = await injectJson<MarketplaceExternalCollaboration>(app, {
      method: "POST",
      url: "/api/marketplace/trips/external-collaborations",
      headers: {
        authorization: "Bearer valid-token",
        "idempotency-key": "external-create-munich-1",
      },
      payload: {
        tripId: trip.tripId,
        title: "Independent Munich stay",
        hotelName: "Hotel Isar",
        collaborationType: "free_stay",
        startDate: "2026-09-17",
        endDate: "2026-09-19",
      },
    });
    expect(created.statusCode).toBe(201);
    expect(created.body).toMatchObject({
      creatorProfileId,
      tripId: trip.tripId,
      title: "Independent Munich stay",
      collaborationType: "free_stay",
    });

    const updated = await injectJson<MarketplaceExternalCollaboration>(app, {
      method: "PUT",
      url: `/api/marketplace/trips/external-collaborations/${created.body.externalCollaborationId}`,
      headers: {
        authorization: "Bearer valid-token",
        "idempotency-key": "external-update-munich-1",
      },
      payload: { notes: "Confirmed directly with the hotel." },
    });
    expect(updated.statusCode).toBe(200);
    expect(updated.body.notes).toBe("Confirmed directly with the hotel.");

    const deleted = await app.inject({
      method: "DELETE",
      url: `/api/marketplace/trips/external-collaborations/${created.body.externalCollaborationId}`,
      headers: {
        authorization: "Bearer valid-token",
        "idempotency-key": "external-delete-munich-1",
      },
    });
    expect(deleted.statusCode).toBe(204);
  });

  it("validates trip dates before calling the write model", async () => {
    app = buildMarketplaceTripApp({
      permissions: ["marketplace.trip.read", "marketplace.trip.manage"],
    });

    const response = await injectJson<MarketplaceTripError>(app, {
      method: "POST",
      url: "/api/marketplace/trips",
      headers: {
        authorization: "Bearer valid-token",
        "idempotency-key": "trip-create-invalid-range-1",
      },
      payload: {
        name: "Invalid range",
        startDate: "2026-10-20",
        endDate: "2026-10-10",
      },
    });

    expect(response.statusCode).toBe(400);
    expect(response.body).toMatchObject({ code: "invalid_request", category: "validation" });
  });

  it("requires a caller-supplied idempotency key for writes", async () => {
    app = buildMarketplaceTripApp({
      permissions: ["marketplace.trip.read", "marketplace.trip.manage"],
    });

    const response = await injectJson<MarketplaceTripError>(app, {
      method: "POST",
      url: "/api/marketplace/trips",
      headers: { authorization: "Bearer valid-token" },
      payload: {
        name: "Berlin campaign",
        startDate: "2026-10-10",
        endDate: "2026-10-15",
      },
    });

    expect(response.statusCode).toBe(400);
    expect(response.body).toMatchObject({ code: "invalid_request", category: "validation" });
    expect(response.body.message).toContain("Idempotency-Key");
  });

  it("filters repository rows to the selected creator organization", async () => {
    app = buildMarketplaceTripApp({
      repository: createTripRepository([
        trip,
        {
          ...trip,
          tripId: "trip_wrong_org",
          organizationId: "org_other_creator_workspace",
          externalCollaborations: [
            {
              ...externalCollaboration,
              externalCollaborationId: "external_wrong_org",
              organizationId: "org_other_creator_workspace",
            },
          ],
        },
      ]),
    });

    const response = await injectJson<MarketplaceTripListResponse>(app, {
      method: "GET",
      url: "/api/marketplace/trips",
      headers: { authorization: "Bearer valid-token" },
    });

    expect(response.statusCode).toBe(200);
    expect(response.body.items.map((item) => item.tripId)).toEqual(["trip_bali_2026"]);
  });

  it("rejects creator trips without auth", async () => {
    app = buildMarketplaceTripApp();

    const response = await injectJson<MarketplaceTripError>(app, {
      method: "GET",
      url: "/api/marketplace/trips",
    });

    expect(response.statusCode).toBe(401);
    expect(response.body).toEqual({
      statusCode: 401,
      code: "unauthorized",
      category: "authentication",
      message: "A valid access token is required.",
    });
  });

  it("rejects a hotel group even with the trip permission", async () => {
    app = buildMarketplaceTripApp({
      organizationKind: "hotel_group",
      linkedResources: [
        {
          product: "marketplace",
          resourceType: "marketplace_offer",
          resourceId: "offer_alpenrose",
          relationship: "owner",
          status: "active",
        },
      ],
    });

    const response = await injectJson<MarketplaceTripError>(app, {
      method: "GET",
      url: "/api/marketplace/trips",
      headers: { authorization: "Bearer valid-token" },
    });

    expect(response.statusCode).toBe(403);
    expect(response.body.code).toBe("forbidden");
    expect(response.body.message).toContain("creator workspace");
  });

  it("rejects a creator workspace without a linked creator profile", async () => {
    app = buildMarketplaceTripApp({ linkedResources: [] });

    const response = await injectJson<MarketplaceTripError>(app, {
      method: "GET",
      url: "/api/marketplace/trips",
      headers: { authorization: "Bearer valid-token" },
    });

    expect(response.statusCode).toBe(403);
    expect(response.body.code).toBe("missing_creator_resource_link");
  });

  it("rejects an ambiguous creator workspace with multiple active creator profile links", async () => {
    app = buildMarketplaceTripApp({
      linkedResources: [
        {
          product: "marketplace",
          resourceType: "creator_profile",
          resourceId: creatorProfileId,
          relationship: "owner",
          status: "active",
        },
        {
          product: "marketplace",
          resourceType: "creator_profile",
          resourceId: "creator_profile_other",
          relationship: "owner",
          status: "active",
        },
      ],
    });

    const response = await injectJson<MarketplaceTripError>(app, {
      method: "GET",
      url: "/api/marketplace/trips",
      headers: { authorization: "Bearer valid-token" },
    });

    expect(response.statusCode).toBe(403);
    expect(response.body.code).toBe("forbidden");
    expect(response.body.message).toContain("exactly one");
  });

  it("rejects a creator workspace without the trip read permission", async () => {
    app = buildMarketplaceTripApp({ permissions: ["marketplace.profile.manage"] });

    const response = await injectJson<MarketplaceTripError>(app, {
      method: "GET",
      url: "/api/marketplace/trips",
      headers: { authorization: "Bearer valid-token" },
    });

    expect(response.statusCode).toBe(403);
    expect(response.body.code).toBe("missing_permission");
  });

  it("returns not found for a trip outside the creator scope", async () => {
    app = buildMarketplaceTripApp();

    const response = await injectJson<MarketplaceTripError>(app, {
      method: "GET",
      url: "/api/marketplace/trips/trip_other",
      headers: { authorization: "Bearer valid-token" },
    });

    expect(response.statusCode).toBe(404);
    expect(response.body.code).toBe("trip_not_found");
  });
});

describe("Postgres marketplace trip repository", () => {
  it("keeps migrated source IDs public and accepts source or target IDs without UUID casts", async () => {
    const statements: Array<{ text: string; values: readonly unknown[] }> = [];
    const pool = createReadPool(async (text, values) => {
      statements.push({ text, values });
      if (text.includes("FROM marketplace.trips trip")) {
        return [tripRow()];
      }
      if (text.includes("FROM marketplace.external_collaborations collaboration")) {
        return [externalCollaborationRow()];
      }
      throw new Error(`Unexpected read query: ${text}`);
    });
    const repository = createPgMarketplaceTripRepository({
      connectionString: "postgresql://test",
      pool,
    });

    const trips = await repository.listTripsForCreatorProfile(creatorProfileId);
    const detail = await repository.findTripForCreatorProfile(creatorProfileId, "legacy-trip-bali");

    expect(trips[0]).toMatchObject({
      tripId: "legacy-trip-bali",
      sourceTripId: "legacy-trip-bali",
      externalCollaborations: [
        {
          externalCollaborationId: "legacy-external-seehof",
          sourceExternalCollaborationId: "legacy-external-seehof",
          tripId: "legacy-trip-bali",
        },
      ],
    });
    expect(detail?.tripId).toBe("legacy-trip-bali");
    const sourceLookup = statements.find(({ values }) => values[1] === "legacy-trip-bali");
    expect(sourceLookup?.text).toContain("trip.source_trip_id = $2");
    expect(sourceLookup?.text).toContain("trip.id::text = $2");
    expect(sourceLookup?.text).not.toContain("$2::uuid");
  });

  it("replays matching commands, conflicts on a changed fingerprint, and audits the mutation", async () => {
    const harness = createWritePool();
    const repository = createPgMarketplaceTripRepository({
      connectionString: "postgresql://test",
      pool: harness.pool,
    });
    app = buildMarketplaceTripApp({
      repository,
      permissions: ["marketplace.trip.read", "marketplace.trip.manage"],
    });
    const request = {
      method: "POST" as const,
      url: "/api/marketplace/trips",
      headers: {
        authorization: "Bearer valid-token",
        "idempotency-key": "trip-create-replay-1",
      },
      payload: {
        name: "Berlin campaign",
        locationText: "Berlin, Germany",
        startDate: "2026-10-10",
        endDate: "2026-10-15",
      },
    };

    const first = await injectJson<MarketplaceTrip>(app, request);
    const replay = await injectJson<MarketplaceTrip>(app, request);
    const conflict = await injectJson<MarketplaceTripError>(app, {
      ...request,
      payload: { ...request.payload, name: "Changed campaign" },
    });

    expect(first.statusCode).toBe(201);
    expect(replay.statusCode).toBe(201);
    expect(replay.body).toEqual(first.body);
    expect(conflict.statusCode).toBe(409);
    expect(conflict.body.code).toBe("idempotency_conflict");
    expect(harness.tripInsertCount).toBe(1);
    expect(harness.auditCount).toBe(1);
    expect(harness.replayAuthorizationCount).toBe(1);
    expect(harness.idempotencyOperation).toBe("marketplace.trip.create");
    expect(harness.idempotencyOrganizationId).toBe(creatorOrganizationId);
    expect(
      harness.queries.find((query) => query.text.includes("INSERT INTO marketplace.trips"))?.text,
    ).toContain('start_date::text AS "startDate"');
    expect(harness.transactionStatements).toEqual(
      expect.arrayContaining([
        "BEGIN",
        "INSERT marketplace.trips",
        "INSERT platform.product_audit_events",
        "UPDATE platform.idempotency_keys",
        "COMMIT",
      ]),
    );
    expect(
      harness.transactionStatements.indexOf("INSERT platform.product_audit_events"),
    ).toBeLessThan(harness.transactionStatements.indexOf("COMMIT"));
  });

  it("validates a one-sided date change against the stored range instead of returning 404", async () => {
    const harness = createWritePool({ currentTrip: tripRow() });
    const repository = createPgMarketplaceTripRepository({
      connectionString: "postgresql://test",
      pool: harness.pool,
    });
    app = buildMarketplaceTripApp({
      repository,
      permissions: ["marketplace.trip.read", "marketplace.trip.manage"],
    });

    const response = await injectJson<MarketplaceTripError>(app, {
      method: "PUT",
      url: "/api/marketplace/trips/legacy-trip-bali",
      headers: {
        authorization: "Bearer valid-token",
        "idempotency-key": "trip-update-invalid-end-1",
      },
      payload: { endDate: "2026-09-01" },
    });

    expect(response.statusCode).toBe(400);
    expect(response.body).toMatchObject({ code: "invalid_request", category: "validation" });
    expect(harness.tripUpdateCount).toBe(0);
    const lookup = harness.queries.find((query) => query.text.includes("FOR UPDATE OF trip"));
    expect(lookup?.values[2]).toBe("legacy-trip-bali");
    expect(lookup?.text).toContain("trip.source_trip_id = $3");
    expect(lookup?.text).not.toContain("$3::uuid");
    expect(harness.transactionStatements).toContain("ROLLBACK");
  });

  it("does not replay a cached trip response after the selected creator link changes", async () => {
    const harness = createWritePool();
    const repository = createPgMarketplaceTripRepository({
      connectionString: "postgresql://test",
      pool: harness.pool,
    });
    const request = {
      method: "POST" as const,
      url: "/api/marketplace/trips",
      headers: {
        authorization: "Bearer valid-token",
        "idempotency-key": "trip-create-profile-scope-1",
      },
      payload: {
        name: "Berlin campaign",
        startDate: "2026-10-10",
        endDate: "2026-10-15",
      },
    };

    app = buildMarketplaceTripApp({
      repository,
      permissions: ["marketplace.trip.read", "marketplace.trip.manage"],
    });
    expect((await app.inject(request)).statusCode).toBe(201);
    await app.close();

    app = buildMarketplaceTripApp({
      repository,
      permissions: ["marketplace.trip.read", "marketplace.trip.manage"],
      linkedResources: [
        {
          product: "marketplace",
          resourceType: "creator_profile",
          resourceId: "creator_profile_other",
          relationship: "owner",
          status: "active",
        },
      ],
    });
    const replay = await injectJson<MarketplaceTripError>(app, request);

    expect(replay.statusCode).toBe(409);
    expect(replay.body.code).toBe("idempotency_conflict");
    expect(harness.tripInsertCount).toBe(1);
  });

  it("reauthorizes a cached trip resource before returning its response", async () => {
    const harness = createWritePool({ authorizeTripReplay: false });
    const repository = createPgMarketplaceTripRepository({
      connectionString: "postgresql://test",
      pool: harness.pool,
    });
    app = buildMarketplaceTripApp({
      repository,
      permissions: ["marketplace.trip.read", "marketplace.trip.manage"],
    });
    const request = {
      method: "POST" as const,
      url: "/api/marketplace/trips",
      headers: {
        authorization: "Bearer valid-token",
        "idempotency-key": "trip-create-missing-resource-1",
      },
      payload: {
        name: "Berlin campaign",
        startDate: "2026-10-10",
        endDate: "2026-10-15",
      },
    };

    expect((await app.inject(request)).statusCode).toBe(201);
    const replay = await injectJson<MarketplaceTripError>(app, request);

    expect(replay.statusCode).toBe(404);
    expect(replay.body.code).toBe("trip_not_found");
    expect(harness.tripInsertCount).toBe(1);
  });

  it("keeps cached delete responses scoped to the creator link that performed the delete", async () => {
    const harness = createWritePool({ currentTrip: tripRow() });
    const repository = createPgMarketplaceTripRepository({
      connectionString: "postgresql://test",
      pool: harness.pool,
    });
    const request = {
      method: "DELETE" as const,
      url: "/api/marketplace/trips/legacy-trip-bali",
      headers: {
        authorization: "Bearer valid-token",
        "idempotency-key": "trip-delete-profile-scope-1",
      },
    };

    app = buildMarketplaceTripApp({
      repository,
      permissions: ["marketplace.trip.read", "marketplace.trip.manage"],
    });
    expect((await app.inject(request)).statusCode).toBe(204);
    await app.close();

    app = buildMarketplaceTripApp({
      repository,
      permissions: ["marketplace.trip.read", "marketplace.trip.manage"],
      linkedResources: [
        {
          product: "marketplace",
          resourceType: "creator_profile",
          resourceId: "creator_profile_other",
          relationship: "owner",
          status: "active",
        },
      ],
    });
    const replay = await injectJson<MarketplaceTripError>(app, request);

    expect(replay.statusCode).toBe(409);
    expect(replay.body.code).toBe("idempotency_conflict");
    expect(harness.tripDeleteCount).toBe(1);
  });

  it("keeps PostgreSQL date values stable across a local-midnight timezone boundary", async () => {
    const statements: string[] = [];
    const pool = createReadPool(async (text) => {
      statements.push(text);
      if (text.includes("FROM marketplace.trips trip")) {
        return [
          tripRow({
            startDate: pgDateLike("2026-03-29", "2026-03-28T23:00:00.000Z"),
            endDate: pgDateLike("2026-03-30", "2026-03-29T22:00:00.000Z"),
          }),
        ];
      }
      if (text.includes("FROM marketplace.external_collaborations collaboration")) {
        return [
          externalCollaborationRow({
            startDate: pgDateLike("2026-03-29", "2026-03-28T23:00:00.000Z"),
            endDate: pgDateLike("2026-03-30", "2026-03-29T22:00:00.000Z"),
          }),
        ];
      }
      throw new Error(`Unexpected read query: ${text}`);
    });
    const repository = createPgMarketplaceTripRepository({
      connectionString: "postgresql://test",
      pool,
    });

    const trips = await repository.listTripsForCreatorProfile(creatorProfileId);

    expect(trips[0]).toMatchObject({
      startDate: "2026-03-29",
      endDate: "2026-03-30",
      externalCollaborations: [{ startDate: "2026-03-29", endDate: "2026-03-30" }],
    });
    expect(statements.find((text) => text.includes("FROM marketplace.trips trip"))).toContain(
      'trip.start_date::text AS "startDate"',
    );
    expect(
      statements.find((text) =>
        text.includes("FROM marketplace.external_collaborations collaboration"),
      ),
    ).toContain('collaboration.start_date::text AS "startDate"');
  });
});

type TestQueryResult = { rows: Record<string, unknown>[]; rowCount: number };

function createReadPool(
  query: (text: string, values: readonly unknown[]) => Promise<Record<string, unknown>[]>,
): MarketplaceTripPool {
  return {
    async query(text, values = []) {
      const rows = await query(text, values);
      return { rows, rowCount: rows.length } as TestQueryResult;
    },
    async connect() {
      throw new Error("Read test does not open a transaction");
    },
    async end() {},
  } as MarketplaceTripPool;
}

function createWritePool(
  options: {
    currentTrip?: Record<string, unknown>;
    authorizeTripReplay?: boolean;
    authorizeExternalReplay?: boolean;
  } = {},
) {
  let idempotency:
    | {
        id: string;
        status: string;
        requestFingerprintHash: string;
        metadata: Record<string, unknown>;
      }
    | undefined;
  let idempotencyBeforeTransaction: typeof idempotency;
  let currentTrip = options.currentTrip;
  let currentTripBeforeTransaction = currentTrip;
  let tripInsertCount = 0;
  let tripUpdateCount = 0;
  let tripDeleteCount = 0;
  let auditCount = 0;
  let replayAuthorizationCount = 0;
  let idempotencyOperation: unknown;
  let idempotencyOrganizationId: unknown;
  const transactionStatements: string[] = [];
  const queries: Array<{ text: string; values: readonly unknown[] }> = [];

  const client = {
    async query(text: string, values: readonly unknown[] = []): Promise<TestQueryResult> {
      queries.push({ text, values });
      if (text === "BEGIN" || text === "COMMIT" || text === "ROLLBACK") {
        transactionStatements.push(text);
        if (text === "BEGIN") {
          idempotencyBeforeTransaction = cloneIdempotency(idempotency);
          currentTripBeforeTransaction = currentTrip;
        } else if (text === "ROLLBACK") {
          idempotency = cloneIdempotency(idempotencyBeforeTransaction);
          currentTrip = currentTripBeforeTransaction;
        } else {
          idempotencyBeforeTransaction = undefined;
        }
        return emptyQueryResult();
      }
      if (text.includes("FROM platform.idempotency_keys")) {
        idempotencyOperation = values[0];
        idempotencyOrganizationId = values[2];
        return rowsQueryResult(idempotency ? [idempotency] : []);
      }
      if (text.includes("INSERT INTO platform.idempotency_keys")) {
        if (idempotency) return emptyQueryResult();
        idempotency = {
          id: "00000000-0000-4000-8000-000000000010",
          status: "in_progress",
          requestFingerprintHash: String(values[2]),
          metadata: JSON.parse(String(values[5])) as Record<string, unknown>,
        };
        return rowsQueryResult([{ id: idempotency.id }]);
      }
      if (text.includes("INSERT INTO marketplace.trips")) {
        tripInsertCount += 1;
        transactionStatements.push("INSERT marketplace.trips");
        return rowsQueryResult([nativeTripRow(values)]);
      }
      if (text.includes("SELECT 1 AS authorized") && text.includes("FROM marketplace.trips")) {
        replayAuthorizationCount += 1;
        return rowsQueryResult(options.authorizeTripReplay === false ? [] : [{ authorized: 1 }]);
      }
      if (
        text.includes("SELECT 1 AS authorized") &&
        text.includes("FROM marketplace.external_collaborations")
      ) {
        replayAuthorizationCount += 1;
        return rowsQueryResult(
          options.authorizeExternalReplay === false ? [] : [{ authorized: 1 }],
        );
      }
      if (text.includes("FROM marketplace.trips trip") && text.includes("FOR UPDATE OF trip")) {
        return rowsQueryResult(currentTrip ? [currentTrip] : []);
      }
      if (text.includes("UPDATE marketplace.trips")) {
        tripUpdateCount += 1;
        transactionStatements.push("UPDATE marketplace.trips");
        return rowsQueryResult([currentTrip ?? tripRow()]);
      }
      if (text.includes("DELETE FROM marketplace.trips")) {
        tripDeleteCount += 1;
        transactionStatements.push("DELETE marketplace.trips");
        currentTrip = undefined;
        return emptyQueryResult();
      }
      if (text.includes("INSERT INTO platform.product_audit_events")) {
        auditCount += 1;
        transactionStatements.push("INSERT platform.product_audit_events");
        return emptyQueryResult();
      }
      if (text.includes("UPDATE platform.idempotency_keys")) {
        transactionStatements.push("UPDATE platform.idempotency_keys");
        if (!idempotency) throw new Error("Missing idempotency reservation");
        idempotency.status = "completed";
        idempotency.requestFingerprintHash = String(values[1]);
        idempotency.metadata = {
          ...idempotency.metadata,
          ...(JSON.parse(String(values[6])) as Record<string, unknown>),
        };
        return emptyQueryResult();
      }
      if (text.includes("FROM marketplace.external_collaborations collaboration")) {
        return emptyQueryResult();
      }
      throw new Error(`Unexpected transaction query: ${text}`);
    },
    release: vi.fn(),
  };
  const pool = {
    query: vi.fn(async () => emptyQueryResult()),
    connect: vi.fn(async () => client),
    end: vi.fn(async () => undefined),
  } as unknown as MarketplaceTripPool;

  return {
    pool,
    queries,
    transactionStatements,
    get tripInsertCount() {
      return tripInsertCount;
    },
    get tripUpdateCount() {
      return tripUpdateCount;
    },
    get tripDeleteCount() {
      return tripDeleteCount;
    },
    get auditCount() {
      return auditCount;
    },
    get idempotencyOperation() {
      return idempotencyOperation;
    },
    get idempotencyOrganizationId() {
      return idempotencyOrganizationId;
    },
    get replayAuthorizationCount() {
      return replayAuthorizationCount;
    },
  };
}

function cloneIdempotency<T extends { metadata: Record<string, unknown> } | undefined>(
  value: T,
): T {
  return value ? ({ ...value, metadata: structuredClone(value.metadata) } as T) : value;
}

function emptyQueryResult(): TestQueryResult {
  return { rows: [], rowCount: 0 };
}

function rowsQueryResult(rows: Record<string, unknown>[]): TestQueryResult {
  return { rows, rowCount: rows.length };
}

function tripRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    internalTripId: "00000000-0000-4000-8000-000000000001",
    tripId: "legacy-trip-bali",
    creatorProfileId,
    organizationId: creatorOrganizationId,
    sourceTripId: "legacy-trip-bali",
    name: "Bali creator trip",
    locationText: "Canggu, Indonesia",
    startDate: "2026-09-10",
    endDate: "2026-09-20",
    notes: "September campaign travel.",
    createdAt: "2026-05-01T10:00:00.000Z",
    updatedAt: "2026-05-02T10:00:00.000Z",
    ...overrides,
  };
}

function nativeTripRow(values: readonly unknown[]): Record<string, unknown> {
  return {
    internalTripId: "00000000-0000-4000-8000-000000000002",
    tripId: "00000000-0000-4000-8000-000000000002",
    creatorProfileId: values[0],
    organizationId: values[1],
    sourceTripId: null,
    name: values[2],
    locationText: values[3],
    startDate: values[4],
    endDate: values[5],
    notes: values[6],
    createdAt: "2026-07-21T10:00:00.000Z",
    updatedAt: "2026-07-21T10:00:00.000Z",
  };
}

function externalCollaborationRow(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    internalExternalCollaborationId: "00000000-0000-4000-8000-000000000003",
    externalCollaborationId: "legacy-external-seehof",
    creatorProfileId,
    organizationId: creatorOrganizationId,
    tripId: "legacy-trip-bali",
    sourceExternalCollaborationId: "legacy-external-seehof",
    title: "Seehof winter reel",
    hotelName: "Hotel Seehof",
    locationText: "Tyrol, Austria",
    collaborationType: "custom_external",
    startDate: "2026-09-12",
    endDate: "2026-09-16",
    deliverablesSummary: "One reel, three stories",
    notes: "Confirmed by email.",
    createdAt: "2026-06-01T10:00:00.000Z",
    updatedAt: "2026-06-02T10:00:00.000Z",
    ...overrides,
  };
}

function pgDateLike(localDate: string, shiftedIso: string): Date {
  const [year, month, day] = localDate.split("-").map(Number);
  const value = new Date(shiftedIso);
  Object.defineProperties(value, {
    getFullYear: { value: () => year },
    getMonth: { value: () => month - 1 },
    getDate: { value: () => day },
  });
  return value;
}
