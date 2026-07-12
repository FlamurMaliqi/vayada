import {
  createFakeVerifier,
  type IdentityRepository,
  type PermissionKey,
  type VerifiedSession,
} from "@vayada/backend-auth";
import { injectJson } from "@vayada/backend-test";
import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";

import { buildApp } from "./app.js";
import type {
  MarketplaceExternalCollaboration,
  MarketplaceExternalCollaborationListResponse,
  MarketplaceTrip,
  MarketplaceTripError,
  MarketplaceTripListResponse,
  MarketplaceTripReadRepository,
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
  return {
    async listTripsForCreatorProfile(profileId) {
      return seed.filter((item) => item.creatorProfileId === profileId);
    },
    async findTripForCreatorProfile(profileId, tripId) {
      return (
        seed.find((item) => item.creatorProfileId === profileId && item.tripId === tripId) ?? null
      );
    },
    async listExternalCollaborationsForCreatorProfile(profileId) {
      return seed
        .flatMap((item) => item.externalCollaborations)
        .filter((item) => item.creatorProfileId === profileId);
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
