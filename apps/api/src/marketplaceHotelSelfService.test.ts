import {
  createFakeVerifier,
  type IdentityLifecycleCommand,
  type IdentityLifecycleCommandBus,
  type IdentityRepository,
  type LinkedResource,
  type PermissionKey,
  type ProductEntitlement,
  type VerifiedSession,
} from "@vayada/backend-auth";
import { injectJson } from "@vayada/backend-test";
import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";

import { buildApp } from "./app.js";
import { createPgMarketplaceHotelSelfServiceRepository } from "./routes/marketplaceHotelSelfService.js";
import type {
  MarketplaceHotelSelfServiceOffer,
  MarketplaceHotelSelfServiceProfile,
  MarketplaceHotelSelfServiceRepository,
} from "./routes/marketplaceHotelSelfService.js";

const propertyOne = "property-one";
const propertyTwo = "property-two";
const offerResourceId = "offer-resource-id";
const futureExpiry = Math.floor(Date.now() / 1000) + 3600;

const session: VerifiedSession = {
  workosUserId: "user_workos_hotel_owner",
  workosOrgId: "org_workos_hotel_group",
  sessionId: "session_hotel_owner",
  expiresAt: futureExpiry,
};

let app: FastifyInstance | undefined;

afterEach(async () => {
  await app?.close();
  app = undefined;
});

describe("marketplace hotel self-service routes", () => {
  it("resolves CRUD identifiers through the canonical offer ID", async () => {
    const query = vi.fn(async (_sql: string) => ({ rows: [] }));
    const repository = createPgMarketplaceHotelSelfServiceRepository({
      connectionString: "postgresql://target-db",
      pool: { query, end: vi.fn(async () => undefined) } as never,
    });

    await expect(
      repository.resolveOfferResourceId("org-id", "property-id", "offer-id"),
    ).resolves.toBeNull();

    const sql = query.mock.calls[0]![0];
    expect(sql).toContain("id::text = $3");
    expect(sql).not.toContain("source_offer_id = $3");
  });

  it("reads media from each offer resource with legacy URL fallback", async () => {
    const query = vi.fn(async (_sql: string) => ({
      rows: [
        offerRow("offer-one", [
          { mediaObjectId: "media-one", url: "https://images.example/one.jpg" },
        ]),
        offerRow("offer-two", [
          { mediaObjectId: "media-two", url: "https://images.example/two.jpg" },
        ]),
      ],
    }));
    const repository = createPgMarketplaceHotelSelfServiceRepository({
      connectionString: "postgresql://target-db",
      pool: { query, end: vi.fn(async () => undefined) } as never,
    });

    const offers = await repository.listOffers("org-id", "property-id");

    expect(offers.map(({ offer: value }) => value.media)).toEqual([
      [{ mediaObjectId: "media-one", url: "https://images.example/one.jpg" }],
      [{ mediaObjectId: "media-two", url: "https://images.example/two.jpg" }],
    ]);
    const sql = query.mock.calls[0]![0];
    expect(sql).toContain("media_object.resource_id = offer.id::text");
    expect(sql).toContain("unnest(offer.image_urls)");
  });

  it("reads the explicitly selected hotel when an account has multiple hotels", async () => {
    const calls: string[] = [];
    app = buildMarketplaceHotelApp({
      linkedResources: [profileLink(propertyOne), profileLink(propertyTwo)],
      repository: repository({
        async getProfile(organizationId, propertyId) {
          calls.push(`${organizationId}:${propertyId}`);
          return profile(propertyId);
        },
      }),
    });

    const response = await injectJson<MarketplaceHotelSelfServiceProfile>(app, {
      method: "GET",
      url: `/api/marketplace/properties/${propertyTwo}/profile`,
      headers: { authorization: "Bearer valid-token" },
    });

    expect(response.statusCode).toBe(200);
    expect(response.body.propertyId).toBe(propertyTwo);
    expect(calls).toEqual([`org_hotel_group:${propertyTwo}`]);
  });

  it("lists only offers with an active offer resource link", async () => {
    app = buildMarketplaceHotelApp({
      linkedResources: [profileLink(propertyTwo), offerLink(offerResourceId)],
      repository: repository({
        async listOffers() {
          return [
            { offer: offer(propertyTwo), offerResourceId },
            {
              offer: { ...offer(propertyTwo), offerId: "unlinked-offer-id" },
              offerResourceId: "unlinked-offer-id",
            },
          ];
        },
      }),
    });

    const response = await injectJson<{ offers: MarketplaceHotelSelfServiceOffer[] }>(app, {
      method: "GET",
      url: `/api/marketplace/properties/${propertyTwo}/offers`,
      headers: { authorization: "Bearer valid-token" },
    });

    expect(response.statusCode).toBe(200);
    expect(response.body.offers.map(({ offerId }) => offerId)).toEqual([offerResourceId]);
  });

  it("creates an offer under the selected hotel and its authorized relationship", async () => {
    const createOffer = vi.fn(async (input) => ({
      offer: offer(input.propertyId),
      offerResourceId,
    }));
    const lifecycleCommandBus = recordingCommandBus();
    app = buildMarketplaceHotelApp({
      linkedResources: [profileLink(propertyOne), profileLink(propertyTwo, "operator")],
      repository: repository({ createOffer }),
      lifecycleCommandBus,
    });

    const response = await injectJson<MarketplaceHotelSelfServiceOffer>(app, {
      method: "POST",
      url: `/api/marketplace/properties/${propertyTwo}/offers`,
      headers: { authorization: "Bearer valid-token" },
      payload: offerRequest(),
    });

    expect(response.statusCode).toBe(201);
    expect(response.body.propertyId).toBe(propertyTwo);
    expect(response.body.mediaResourceId).toBe(offerResourceId);
    expect(response.body).not.toHaveProperty("authorizationMode");
    expect(createOffer).toHaveBeenCalledWith(
      expect.objectContaining({
        organizationId: "org_hotel_group",
        propertyId: propertyTwo,
      }),
    );
    expect(lifecycleCommandBus.commands).toEqual([
      expect.objectContaining({
        commandType: "identity.resource_links.grant",
        payload: expect.objectContaining({
          organizationId: "org_hotel_group",
          resourceLinks: [
            expect.objectContaining({
              resourceType: "marketplace_offer",
              resourceId: offerResourceId,
              relationship: "operator",
              status: "active",
            }),
          ],
        }),
      }),
    ]);
  });

  it("archives offer access without revoking the hotel membership", async () => {
    const lifecycleCommandBus = recordingCommandBus();
    app = buildMarketplaceHotelApp({
      linkedResources: [profileLink(propertyTwo), offerLink(offerResourceId)],
      lifecycleCommandBus,
      repository: repository({
        async resolveOfferResourceId() {
          return offerResourceId;
        },
      }),
    });

    const response = await app.inject({
      method: "DELETE",
      url: `/api/marketplace/properties/${propertyTwo}/offers/${offerResourceId}`,
      headers: { authorization: "Bearer valid-token" },
    });

    expect(response.statusCode).toBe(204);
    expect(lifecycleCommandBus.commands).toEqual([
      expect.objectContaining({
        commandType: "identity.access.revoke",
        payload: {
          userId: "user_hotel_owner",
          organizationId: "org_hotel_group",
          resourceLinks: [
            {
              product: "marketplace",
              resourceType: "marketplace_offer",
              resourceId: offerResourceId,
              relationship: "owner",
              status: "archived",
            },
          ],
        },
      }),
    ]);
  });

  it("archives a new offer when its identity link cannot be granted", async () => {
    const archiveOffer = vi.fn(async () => true);
    app = buildMarketplaceHotelApp({
      linkedResources: [profileLink(propertyTwo)],
      lifecycleCommandBus: recordingCommandBus(new Error("identity unavailable")),
      repository: repository({ archiveOffer }),
    });

    const response = await app.inject({
      method: "POST",
      url: `/api/marketplace/properties/${propertyTwo}/offers`,
      headers: { authorization: "Bearer valid-token" },
      payload: offerRequest(),
    });

    expect(response.statusCode).toBe(500);
    expect(archiveOffer).toHaveBeenCalledWith({
      organizationId: "org_hotel_group",
      propertyId: propertyTwo,
      offerResourceId,
    });
  });

  it("requires the offer resource link before updating an offer", async () => {
    const updateOffer = vi.fn(async (input) => offer(input.propertyId));
    app = buildMarketplaceHotelApp({
      linkedResources: [profileLink(propertyTwo), offerLink(offerResourceId)],
      repository: repository({
        async resolveOfferResourceId(organizationId, propertyId, offerId) {
          expect([organizationId, propertyId, offerId]).toEqual([
            "org_hotel_group",
            propertyTwo,
            offerResourceId,
          ]);
          return offerResourceId;
        },
        updateOffer,
      }),
    });

    const response = await injectJson<MarketplaceHotelSelfServiceOffer>(app, {
      method: "PUT",
      url: `/api/marketplace/properties/${propertyTwo}/offers/${offerResourceId}`,
      headers: { authorization: "Bearer valid-token" },
      payload: { title: "Updated hotel stay" },
    });

    expect(response.statusCode).toBe(200);
    expect(response.body.mediaResourceId).toBe(offerResourceId);
    expect(updateOffer).toHaveBeenCalledWith(
      expect.objectContaining({
        organizationId: "org_hotel_group",
        propertyId: propertyTwo,
        offerResourceId,
      }),
    );
  });

  it("rejects offer updates when only the hotel profile is linked", async () => {
    const updateOffer = vi.fn();
    app = buildMarketplaceHotelApp({
      linkedResources: [profileLink(propertyTwo)],
      repository: repository({
        async resolveOfferResourceId() {
          return offerResourceId;
        },
        updateOffer,
      }),
    });

    const response = await injectJson<{ message: string }>(app, {
      method: "PUT",
      url: `/api/marketplace/properties/${propertyTwo}/offers/${offerResourceId}`,
      headers: { authorization: "Bearer valid-token" },
      payload: { title: "Updated hotel stay" },
    });

    expect(response.statusCode).toBe(403);
    expect(updateOffer).not.toHaveBeenCalled();
  });

  it("rejects canonical property fields on the Marketplace profile route", async () => {
    const updateProfile = vi.fn();
    app = buildMarketplaceHotelApp({
      linkedResources: [profileLink(propertyTwo)],
      repository: repository({ updateProfile }),
    });

    const response = await injectJson<{ code: string }>(app, {
      method: "PUT",
      url: `/api/marketplace/properties/${propertyTwo}/profile`,
      headers: { authorization: "Bearer valid-token" },
      payload: { displayName: "Wrong owner" },
    });

    expect(response.statusCode).toBe(422);
    expect(response.body.code).toBe("canonical_property_read_only");
    expect(updateProfile).not.toHaveBeenCalled();
  });

  it("rejects all self-service access while Marketplace is suspended", async () => {
    const getProfile = vi.fn();
    app = buildMarketplaceHotelApp({
      linkedResources: [profileLink(propertyTwo)],
      entitlements: [
        { product: "marketplace", key: "marketplace-hotel-profile", status: "suspended" },
      ],
      repository: repository({ getProfile }),
    });

    const response = await injectJson<{ message: string }>(app, {
      method: "GET",
      url: `/api/marketplace/properties/${propertyTwo}/profile`,
      headers: { authorization: "Bearer valid-token" },
    });

    expect(response.statusCode).toBe(403);
    expect(getProfile).not.toHaveBeenCalled();
  });
});

function buildMarketplaceHotelApp(options: {
  repository: MarketplaceHotelSelfServiceRepository;
  permissions?: PermissionKey[];
  linkedResources?: LinkedResource[];
  entitlements?: ProductEntitlement[];
  lifecycleCommandBus?: RecordingCommandBus;
}): FastifyInstance {
  return buildApp({
    logger: false,
    marketplaceHotelSelfServiceRepository: options.repository,
    identityLifecycleCommandBus: options.lifecycleCommandBus ?? recordingCommandBus(),
    auth: {
      verifier: createFakeVerifier(new Map([["valid-token", session]])),
      repository: identityRepository(options.linkedResources),
      rolePermissionRepository: {
        async findPermissionsForRole() {
          return options.permissions ?? ["marketplace.profile.manage"];
        },
      },
      entitlementRepository: {
        async findEntitlementsForContext() {
          return (
            options.entitlements ?? [
              {
                product: "marketplace",
                key: "marketplace-hotel-profile",
                status: "active",
              },
            ]
          );
        },
      },
    },
  });
}

function identityRepository(linkedResources?: LinkedResource[]): IdentityRepository {
  return {
    async findUserByProviderUserId() {
      return { userId: "user_hotel_owner", email: "owner@example.com", status: "active" };
    },
    async findOrganizationByWorkosOrgId() {
      return {
        organizationId: "org_hotel_group",
        workosOrgId: session.workosOrgId ?? null,
        name: "Alpenrose Hotels",
        kind: "hotel_group",
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
      return linkedResources ?? [profileLink(propertyOne)];
    },
  };
}

function repository(
  overrides: Partial<MarketplaceHotelSelfServiceRepository> = {},
): MarketplaceHotelSelfServiceRepository {
  return {
    async getProfile(_organizationId, propertyId) {
      return profile(propertyId);
    },
    async updateProfile(input) {
      return profile(input.propertyId);
    },
    async listOffers() {
      return [];
    },
    async resolveOfferResourceId() {
      return null;
    },
    async createOffer(input) {
      return { offer: offer(input.propertyId), offerResourceId };
    },
    async updateOffer(input) {
      return offer(input.propertyId);
    },
    async archiveOffer() {
      return true;
    },
    ...overrides,
  };
}

type RecordingCommandBus = IdentityLifecycleCommandBus & {
  commands: IdentityLifecycleCommand[];
};

function recordingCommandBus(error?: Error): RecordingCommandBus {
  const commands: IdentityLifecycleCommand[] = [];
  return {
    commands,
    async execute(command) {
      commands.push(command);
      if (error) throw error;
      return {
        status: "accepted",
        commandId: command.commandId,
        idempotencyKey: command.idempotencyKey,
        events: [],
      };
    },
  };
}

function profile(propertyId: string): MarketplaceHotelSelfServiceProfile {
  return {
    propertyId,
    profileStatus: "pending",
    profileComplete: false,
    hostSummary: null,
    collaborationGuidelines: null,
    createdAt: "2026-07-11T00:00:00.000Z",
    updatedAt: "2026-07-11T00:00:00.000Z",
  };
}

function offer(propertyId: string) {
  return {
    contractVersion: "marketplace-admin.v1" as const,
    authorizationMode: "platform_organization_membership" as const,
    offerId: offerResourceId,
    propertyId,
    offerStatus: "pending" as const,
    title: "Hotel stay",
    offerSummary: "Two nights",
    media: [],
    deliverables: [],
    compensationOptions: [],
    creatorRequirements: null,
    createdAt: "2026-07-11T00:00:00.000Z",
    updatedAt: "2026-07-11T00:00:00.000Z",
  };
}

function offerRow(offerId: string, media: Array<{ mediaObjectId: string; url: string }>) {
  return {
    offerId,
    propertyId: propertyTwo,
    offerStatus: "pending",
    title: "Hotel stay",
    offerSummary: "Two nights",
    media,
    deliverables: [],
    compensationOptions: [],
    creatorRequirements: {},
    createdAt: "2026-07-11T00:00:00.000Z",
    updatedAt: "2026-07-11T00:00:00.000Z",
  };
}

function offerRequest() {
  return {
    title: "Hotel stay",
    offerSummary: "Two nights",
    deliverables: [
      {
        platform: "instagram",
        deliverableType: "content",
        quantity: 1,
      },
    ],
    compensationOptions: [
      {
        compensationType: "free_stay",
        availabilityMonths: ["July"],
        platforms: ["instagram"],
        freeStayMinNights: 1,
        freeStayMaxNights: 2,
        paidMaxAmount: null,
        discountPercentage: null,
        commissionPercentage: null,
        minFollowers: null,
        currency: null,
        termsSummary: null,
      },
    ],
    creatorRequirements: {
      platforms: ["instagram"],
      targetCountries: [],
      targetAgeMin: null,
      targetAgeMax: null,
      targetAgeGroups: [],
      creatorTypes: ["travel"],
    },
  };
}

function profileLink(
  resourceId: string,
  relationship: LinkedResource["relationship"] = "owner",
): LinkedResource {
  return {
    product: "marketplace",
    resourceType: "hotel_profile",
    resourceId,
    relationship,
    status: "active",
  };
}

function offerLink(
  resourceId: string,
  relationship: LinkedResource["relationship"] = "owner",
): LinkedResource {
  return {
    product: "marketplace",
    resourceType: "marketplace_offer",
    resourceId,
    relationship,
    status: "active",
  };
}
