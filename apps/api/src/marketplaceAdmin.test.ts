import {
  createFakeVerifier,
  type IdentityRepository,
  type VerifiedSession,
} from "@vayada/backend-auth";
import { injectJson } from "@vayada/backend-test";
import type { QueryResultRow } from "pg";
import { afterEach, describe, expect, it } from "vitest";

import { buildApp } from "./app.js";
import { createPgMarketplaceOfferIdentityAccessCommandPort } from "./platform/marketplaceOfferIdentityAccess.js";
import { createPgMarketplaceAdminRepository } from "./routes/marketplaceAdmin.js";
import type {
  MarketplaceAdminCollaborationsResponse,
  MarketplaceAdminCreateOfferRequest,
  MarketplaceAdminDeleteOfferResponse,
  MarketplaceAdminOffer,
  MarketplaceAdminInviteCode,
  MarketplaceAdminRepository,
  MarketplaceAdminUserProfileUpdateResponse,
  MarketplaceCollaborationLifecycleWriteResponse,
  MarketplaceCollaborationRead,
} from "./routes/marketplaceAdmin.js";

const platformSession: VerifiedSession = {
  workosUserId: "user_workos_platform",
  workosOrgId: "org_workos_platform",
  sessionId: "session_platform",
  expiresAt: Math.floor(Date.now() / 1000) + 3600,
};

const nonPlatformSession: VerifiedSession = {
  workosUserId: "user_workos_creator",
  workosOrgId: "org_workos_creator",
  sessionId: "session_creator",
  expiresAt: Math.floor(Date.now() / 1000) + 3600,
};

const collaboration: MarketplaceCollaborationRead = {
  contractVersion: "marketplace-collaboration-reads.v1",
  authorizationMode: "hotel_group_resource_link",
  collaborationId: "collab_801",
  offerId: "offer_801",
  creatorId: "creator_801",
  hotelProfileId: "hotel_profile_801",
  side: "hotel",
  initiatorSide: "creator",
  isInitiator: false,
  status: "pending",
  compensationType: "free_stay",
  offerTitle: "Alpine creator stay",
  hotelLocation: "Innsbruck, Austria",
  creator: {
    side: "creator",
    organizationId: "org_creator",
    profileId: "creator_profile_801",
    displayName: "Lina Creator",
    avatarUrl: null,
  },
  hotel: {
    side: "hotel",
    organizationId: "org_hotel",
    profileId: "hotel_profile_801",
    displayName: "Hotel Alpenrose",
    avatarUrl: null,
  },
  terms: {
    freeStayMinNights: 2,
    freeStayMaxNights: 4,
    paidAmount: null,
    currency: "EUR",
    discountPercentage: null,
    affiliateEnabled: false,
    affiliateCommissionPercentage: null,
    travelDateFrom: null,
    travelDateTo: null,
    preferredDateFrom: null,
    preferredDateTo: null,
    preferredMonths: ["June"],
  },
  deliverables: [],
  lastMessageAt: null,
  applicationMessage: "We would be a great fit.",
  hotelAgreedAt: null,
  creatorAgreedAt: null,
  completedAt: null,
  cancelledAt: null,
  createdAt: "2026-06-13T10:00:00.000Z",
  updatedAt: "2026-06-13T10:00:00.000Z",
};

describe("marketplace admin routes", () => {
  let app: ReturnType<typeof buildApp> | undefined;

  afterEach(async () => {
    await app?.close();
  });

  it("lists collaborations for platform organization members", async () => {
    const repository = createMemoryMarketplaceAdminRepository();
    app = buildMarketplaceAdminApp(repository);

    const response = await injectJson<MarketplaceAdminCollaborationsResponse>(app, {
      method: "GET",
      url: "/api/marketplace/admin/collaborations?page=2&pageSize=5&status=pending&search=Alpine",
      headers: { authorization: "Bearer platform-token" },
    });

    expect(response.statusCode).toBe(200);
    expect(response.body.authorizationMode).toBe("platform_organization_membership");
    expect(response.body.collaborations[0]).toMatchObject({
      collaborationId: "collab_801",
      side: "hotel",
    });
    expect(response.body.pagination).toEqual({ page: 2, pageSize: 5, total: 1 });
    expect(repository.calls.listCollaborations[0]).toMatchObject({
      page: 2,
      pageSize: 5,
      status: "pending",
      search: "Alpine",
    });
  });

  it("uses documented legacy superadmin fallback only when explicitly enabled", async () => {
    const repository = createMemoryMarketplaceAdminRepository({
      legacySuperadminUserIds: ["user_creator"],
    });
    app = buildMarketplaceAdminApp(repository, {
      marketplaceAdminLegacySuperadminFallbackEnabled: true,
    });

    const response = await injectJson<MarketplaceAdminCollaborationsResponse>(app, {
      method: "GET",
      url: "/api/marketplace/admin/collaborations",
      headers: { authorization: "Bearer creator-token" },
    });

    expect(response.statusCode).toBe(200);
    expect(response.body.authorizationMode).toBe("legacy_superadmin_fallback");
  });

  it("rejects authenticated users without platform membership or superadmin fallback", async () => {
    const repository = createMemoryMarketplaceAdminRepository({
      legacySuperadminUserIds: ["user_creator"],
    });
    app = buildMarketplaceAdminApp(repository);

    const response = await injectJson(app, {
      method: "GET",
      url: "/api/marketplace/admin/collaborations",
      headers: { authorization: "Bearer creator-token" },
    });

    expect(response.statusCode).toBe(403);
  });

  it("performs admin collaboration actions through typed lifecycle responses", async () => {
    const repository = createMemoryMarketplaceAdminRepository();
    app = buildMarketplaceAdminApp(repository);

    const respond = await injectJson<MarketplaceCollaborationLifecycleWriteResponse>(app, {
      method: "POST",
      url: "/api/marketplace/admin/collaborations/collab_801/respond",
      headers: {
        authorization: "Bearer platform-token",
        "idempotency-key": "marketplace.admin.collaboration.respond:collab_801:test:v1",
      },
      payload: { status: "accepted", responseMessage: "Approved by admin." },
    });

    expect(respond.statusCode).toBe(200);
    expect(respond.body.command).toMatchObject({
      action: "respond",
      idempotencyKey: "marketplace.admin.collaboration.respond:collab_801:test:v1",
    });
    expect(repository.calls.respond[0]).toMatchObject({
      collaborationId: "collab_801",
      status: "accepted",
      responseMessage: "Approved by admin.",
    });

    const approve = await injectJson<MarketplaceCollaborationLifecycleWriteResponse>(app, {
      method: "POST",
      url: "/api/marketplace/admin/collaborations/collab_801/approve",
      headers: { authorization: "Bearer platform-token" },
      payload: {
        idempotencyKey: "marketplace.admin.collaboration.approve_terms:collab_801:test:v1",
      },
    });

    expect(approve.statusCode).toBe(200);
    expect(approve.body.command.action).toBe("approve_terms");
  });

  it("manages invite codes through marketplace admin target routes", async () => {
    const repository = createMemoryMarketplaceAdminRepository();
    app = buildMarketplaceAdminApp(repository);

    const list = await injectJson<MarketplaceAdminInviteCode[]>(app, {
      method: "GET",
      url: "/api/marketplace/admin/invite-codes",
      headers: { authorization: "Bearer platform-token" },
    });

    expect(list.statusCode).toBe(200);
    expect(list.body[0]).toMatchObject({ code: "VAY-INVITE" });

    const created = await injectJson<MarketplaceAdminInviteCode>(app, {
      method: "POST",
      url: "/api/marketplace/admin/invite-codes",
      headers: { authorization: "Bearer platform-token" },
      payload: { data: { property: { property_name: "Hotel Alpenrose" } } },
    });

    expect(created.statusCode).toBe(201);
    expect(repository.calls.createInviteCode[0]).toMatchObject({
      createdByUserId: "user_platform",
      payload: { property: { property_name: "Hotel Alpenrose" } },
    });

    const deleted = await app.inject({
      method: "DELETE",
      url: "/api/marketplace/admin/invite-codes/invite_801",
      headers: { authorization: "Bearer platform-token" },
    });

    expect(deleted.statusCode).toBe(204);
    expect(repository.calls.revokeInviteCode).toEqual(["invite_801"]);
  });

  it("creates, updates, and archives hotel offers for a hotel user through marketplace admin routes", async () => {
    const repository = createMemoryMarketplaceAdminRepository();
    app = buildMarketplaceAdminApp(repository);
    const payload = offerPayload();

    const create = await injectJson<MarketplaceAdminOffer>(app, {
      method: "POST",
      url: "/api/marketplace/admin/users/user_hotel/offers",
      headers: { authorization: "Bearer platform-token" },
      payload,
    });

    expect(create.statusCode).toBe(201);
    expect(create.body).toMatchObject({
      contractVersion: "marketplace-admin.v1",
      authorizationMode: "platform_organization_membership",
      offerId: "offer_801",
    });
    expect(repository.calls.createOffer[0]).toMatchObject({
      hotelUserId: "user_hotel",
      request: { title: "Creator suite" },
    });

    const update = await injectJson<MarketplaceAdminOffer>(app, {
      method: "PUT",
      url: "/api/marketplace/admin/users/user_hotel/offers/offer_801",
      headers: { authorization: "Bearer platform-token" },
      payload: { title: "Updated suite" },
    });

    expect(update.statusCode).toBe(200);
    expect(repository.calls.updateOffer[0]).toMatchObject({
      hotelUserId: "user_hotel",
      offerId: "offer_801",
      request: { title: "Updated suite" },
    });

    const deleted = await injectJson<MarketplaceAdminDeleteOfferResponse>(app, {
      method: "DELETE",
      url: "/api/marketplace/admin/users/user_hotel/offers/offer_801",
      headers: { authorization: "Bearer platform-token" },
    });

    expect(deleted.statusCode).toBe(200);
    expect(deleted.body.deletedOffer).toEqual({
      offerId: "offer_801",
      title: "Creator suite",
    });
  });

  it("updates creator and hotel profiles through marketplace admin target routes", async () => {
    const repository = createMemoryMarketplaceAdminRepository();
    app = buildMarketplaceAdminApp(repository);

    const creator = await injectJson<MarketplaceAdminUserProfileUpdateResponse>(app, {
      method: "PUT",
      url: "/api/marketplace/admin/users/user_creator/profile/creator",
      headers: { authorization: "Bearer platform-token" },
      payload: {
        displayName: "Lina Travels",
        locationText: "Vienna, Austria",
        platforms: [
          {
            platform: "instagram",
            handle: "@lina",
            followerCount: 20000,
            engagementRate: 4.2,
          },
        ],
      },
    });

    expect(creator.statusCode).toBe(200);
    expect(creator.body).toMatchObject({
      contractVersion: "marketplace-admin.v1",
      authorizationMode: "platform_organization_membership",
      userId: "user_creator",
      profileType: "creator",
    });
    expect(repository.calls.updateCreatorProfile[0]).toMatchObject({
      userId: "user_creator",
      request: { displayName: "Lina Travels" },
    });

    const hotel = await injectJson<MarketplaceAdminUserProfileUpdateResponse>(app, {
      method: "PUT",
      url: "/api/marketplace/admin/users/user_hotel/profile/hotel",
      headers: { authorization: "Bearer platform-token" },
      payload: { hostSummary: "Independent alpine hotel." },
    });

    expect(hotel.statusCode).toBe(200);
    expect(hotel.body.profileType).toBe("hotel");
    expect(repository.calls.updateHotelProfile[0]).toMatchObject({
      userId: "user_hotel",
      request: { hostSummary: "Independent alpine hotel." },
    });
  });

  it("rejects unsupported hotel profile fields instead of dropping them", async () => {
    const repository = createMemoryMarketplaceAdminRepository();
    app = buildMarketplaceAdminApp(repository);

    const response = await injectJson(app, {
      method: "PUT",
      url: "/api/marketplace/admin/users/user_hotel/profile/hotel",
      headers: { authorization: "Bearer platform-token" },
      payload: { hostSummary: "Independent alpine hotel.", website: "https://hotel.example" },
    });

    expect(response.statusCode).toBe(422);
    expect(response.body).toMatchObject({ code: "unsupported_website" });
    expect(repository.calls.updateHotelProfile).toHaveLength(0);
  });

  it("rejects blank offer titles on marketplace admin updates", async () => {
    const repository = createMemoryMarketplaceAdminRepository();
    app = buildMarketplaceAdminApp(repository);

    const response = await injectJson(app, {
      method: "PUT",
      url: "/api/marketplace/admin/users/user_hotel/offers/offer_801",
      headers: { authorization: "Bearer platform-token" },
      payload: { title: "   " },
    });

    expect(response.statusCode).toBe(422);
    expect(response.body).toMatchObject({ code: "title_required" });
    expect(repository.calls.updateOffer).toHaveLength(0);
  });

  it("rejects invalid compensation option values on marketplace admin offer updates", async () => {
    const repository = createMemoryMarketplaceAdminRepository();
    app = buildMarketplaceAdminApp(repository);
    const offering = offerPayload().compensationOptions[0]!;

    const response = await injectJson(app, {
      method: "PUT",
      url: "/api/marketplace/admin/users/user_hotel/offers/offer_801",
      headers: { authorization: "Bearer platform-token" },
      payload: {
        compensationOptions: [
          {
            ...offering,
            freeStayMinNights: 4,
            freeStayMaxNights: 2,
          },
        ],
      },
    });

    expect(response.statusCode).toBe(422);
    expect(response.body).toMatchObject({ code: "invalid_free_stay" });
    expect(repository.calls.updateOffer).toHaveLength(0);
  });

  it("keeps offer access and discovery projection in the same admin write transaction", async () => {
    const sql: string[] = [];
    const projectionModes: string[] = [];
    const repository = createPgMarketplaceAdminRepository({
      connectionString: "postgresql://target-db",
      identityAccess: createPgMarketplaceOfferIdentityAccessCommandPort(),
      pool: createAdminPgPool(sql, { projectionModes }) as never,
    });

    await expect(
      repository.createOfferForUser({
        hotelUserId: "user_hotel",
        request: offerPayload(),
        authorizationMode: "platform_organization_membership",
      }),
    ).resolves.toMatchObject({ offerId: "f8015000-0000-0000-0000-000000000001" });

    await expect(
      repository.updateOfferForUser({
        hotelUserId: "user_hotel",
        offerId: "f8015000-0000-0000-0000-000000000001",
        request: { title: "Updated creator suite" },
        authorizationMode: "platform_organization_membership",
      }),
    ).resolves.toMatchObject({ offerId: "f8015000-0000-0000-0000-000000000001" });

    await expect(
      repository.deleteOfferForUser({
        hotelUserId: "user_hotel",
        offerId: "f8015000-0000-0000-0000-000000000001",
        authorizationMode: "platform_organization_membership",
      }),
    ).resolves.toMatchObject({
      deletedOffer: { offerId: "f8015000-0000-0000-0000-000000000001" },
    });

    const statements = sql.join("\n");
    expect(statements).toContain("INSERT INTO identity.organization_resource_links");
    expect(statements).toContain("'marketplace_offer', $2, 'operator', 'active'");
    expect(statements.match(/INSERT INTO marketplace\.marketplace_offer_read_model/g)).toHaveLength(
      3,
    );
    expect(statements).toContain("ON CONFLICT (offer_id) DO UPDATE");
    expect(statements).toContain(
      "WHEN $2 = 'preserve' AND current_projection.visibility_status IS NOT NULL",
    );
    expect(statements).toContain("WHEN $2 = 'disable' THEN 'disabled'");
    expect(projectionModes).toEqual(["initialize", "preserve", "disable"]);
    expect(statements).toContain("SET status = 'archived'");
  });

  it("requests affiliate provisioning when an admin approval accepts the collaboration", async () => {
    const sql: string[] = [];
    const repository = createPgMarketplaceAdminRepository({
      connectionString: "postgresql://target-db",
      identityAccess: createPgMarketplaceOfferIdentityAccessCommandPort(),
      pool: createAdminPgPool(sql, { acceptedAffiliateCollaboration: true }) as never,
    });

    const result = await repository.approveCollaborationAsHotel({
      collaborationId: "marketplace-collaboration-affiliate-801",
      idempotencyKey: "marketplace.admin.approve:affiliate-801:v1",
    });

    expect(result?.sideEffects).toEqual([
      { type: "marketplace.collaboration.accepted" },
      {
        type: "marketplace.affiliate.provision.command_requested",
        idempotencyKey:
          "marketplace.affiliate.provision:collaboration:marketplace-collaboration-affiliate-801:v1",
      },
    ]);
    expect(sql.join("\n")).toContain(
      "LEFT JOIN hotel_catalog.property_public_profile_read_model public_profile",
    );
  });
});

function createAdminPgPool(
  sql: string[],
  options: { acceptedAffiliateCollaboration?: boolean; projectionModes?: string[] } = {},
) {
  const offerId = "f8015000-0000-0000-0000-000000000001";
  const propertyId = "f8013000-0000-0000-0000-000000000001";
  const organizationId = "f8012000-0000-0000-0000-000000000001";

  const query = async <T extends QueryResultRow = QueryResultRow>(
    text: string,
    _values?: readonly unknown[],
  ): Promise<{ rows: T[] }> => {
    sql.push(text);
    if (text.includes("INSERT INTO marketplace.marketplace_offer_read_model")) {
      options.projectionModes?.push(String(_values?.[1]));
    }
    let rows: unknown[] = [];
    if (text.includes("FROM platform.idempotency_keys")) {
      rows = [];
    } else if (text.includes("INSERT INTO platform.idempotency_keys")) {
      rows = [{ id: "idempotency_801" }];
    } else if (text.includes("UPDATE marketplace.collaborations AS collaboration")) {
      rows = [{ id: "f8016000-0000-0000-0000-000000000001" }];
    } else if (
      options.acceptedAffiliateCollaboration &&
      text.includes('collaboration.id::text AS "collaborationId"')
    ) {
      rows = [acceptedAffiliateCollaborationRow()];
    } else if (
      text.includes("FROM marketplace.marketplace_hotel_profiles profile") &&
      text.includes("identity.organization_memberships membership")
    ) {
      rows = [{ propertyId, organizationId }];
    } else if (text.includes("INSERT INTO marketplace.marketplace_offers")) {
      rows = [{ id: offerId }];
    } else if (text.includes('id::text AS "offerResourceId"')) {
      rows = [{ offerResourceId: offerId, title: "Creator suite" }];
    } else if (text.includes('offer.id::text AS "offerId"')) {
      rows = [adminOfferRow(offerId, propertyId)];
    }
    return { rows: rows as T[] };
  };

  const client = { query, release() {} };
  return {
    query,
    async connect() {
      return client;
    },
    async end() {},
  };
}

function adminOfferRow(offerId: string, propertyId: string) {
  return {
    offerId,
    propertyId,
    offerStatus: "verified",
    title: "Creator suite",
    offerSummary: "A suite for creator stays.",
    media: [],
    deliverables: [],
    compensationOptions: [],
    creatorRequirements: {},
    createdAt: "2026-06-13T10:00:00.000Z",
    updatedAt: "2026-06-13T10:00:00.000Z",
  };
}

function acceptedAffiliateCollaborationRow() {
  return {
    id: "f8016000-0000-0000-0000-000000000001",
    collaborationId: "f8016000-0000-0000-0000-000000000001",
    sourceCollaborationId: "marketplace-collaboration-affiliate-801",
    offerId: "f8015000-0000-0000-0000-000000000001",
    creatorId: "f8014000-0000-0000-0000-000000000001",
    hotelProfileId: "f8013000-0000-0000-0000-000000000001",
    creatorProfileId: "f8014000-0000-0000-0000-000000000001",
    creatorOrganizationId: "f8012000-0000-0000-0000-000000000002",
    hotelOrganizationId: "f8012000-0000-0000-0000-000000000001",
    initiatorSide: "creator",
    status: "accepted",
    compensationType: "free_stay",
    offerTitle: "Alpine creator stay",
    hotelLocation: "Innsbruck, Austria",
    creatorName: "Lina Creator",
    creatorAvatarUrl: null,
    hotelName: "Hotel Alpenrose",
    freeStayMinNights: 2,
    freeStayMaxNights: 4,
    paidAmount: null,
    currency: "EUR",
    discountPercentage: null,
    affiliateEnabled: true,
    affiliateCommissionPercentage: "10.0000",
    travelDateFrom: null,
    travelDateTo: null,
    preferredDateFrom: null,
    preferredDateTo: null,
    preferredMonths: ["June"],
    deliverables: [],
    lastMessageAt: null,
    applicationMessage: "Affiliate proposal",
    hotelAgreedAt: "2026-06-13T10:00:00.000Z",
    creatorAgreedAt: "2026-06-13T09:00:00.000Z",
    completedAt: null,
    cancelledAt: null,
    createdAt: "2026-06-12T10:00:00.000Z",
    updatedAt: "2026-06-13T10:00:00.000Z",
  };
}

function buildMarketplaceAdminApp(
  repository: MarketplaceAdminRepository,
  options: { marketplaceAdminLegacySuperadminFallbackEnabled?: boolean } = {},
) {
  const identityRepository: IdentityRepository = {
    async findUserByProviderUserId(_provider, providerUserId) {
      if (providerUserId === "user_workos_platform") {
        return { userId: "user_platform", email: "admin@vayada.com", status: "active" };
      }
      return { userId: "user_creator", email: "creator@example.com", status: "active" };
    },
    async findOrganizationByWorkosOrgId(workosOrgId) {
      if (workosOrgId === "org_workos_platform") {
        return {
          organizationId: "org_platform",
          workosOrgId,
          kind: "platform",
          status: "active",
        };
      }
      return {
        organizationId: "org_creator",
        workosOrgId,
        kind: "creator_workspace",
        status: "active",
      };
    },
    async findActiveMembership(_userId, organizationId) {
      if (organizationId === "org_platform") {
        return {
          membershipId: "membership_platform",
          status: "active",
          roleKey: "platform_admin",
          workosMembershipId: null,
          workosRoleSlugs: ["platform_admin"],
        };
      }
      return {
        membershipId: "membership_creator",
        status: "active",
        roleKey: "creator_owner",
        workosMembershipId: null,
        workosRoleSlugs: ["creator_owner"],
      };
    },
    async findLinkedResources(organizationId) {
      if (organizationId === "org_platform") {
        return [
          {
            product: "platform",
            resourceType: "platform",
            resourceId: "vayada",
            relationship: "operator",
            status: "active",
          },
        ];
      }
      return [];
    },
  };

  return buildApp({
    logger: false,
    marketplaceAdminRepository: repository,
    marketplaceAdminLegacySuperadminFallbackEnabled:
      options.marketplaceAdminLegacySuperadminFallbackEnabled,
    auth: {
      verifier: createFakeVerifier(
        new Map([
          ["platform-token", platformSession],
          ["creator-token", nonPlatformSession],
        ]),
      ),
      repository: identityRepository,
      rolePermissionRepository: {
        async findPermissionsForRole(kind) {
          return kind === "platform" ? ["platform.user.suspend"] : ["marketplace.profile.manage"];
        },
      },
    },
  });
}

function createMemoryMarketplaceAdminRepository(
  options: { legacySuperadminUserIds?: string[] } = {},
) {
  const legacySuperadminUserIds = new Set(options.legacySuperadminUserIds ?? []);
  const calls = {
    listCollaborations: [] as unknown[],
    respond: [] as unknown[],
    approve: [] as unknown[],
    updateCreatorProfile: [] as unknown[],
    updateHotelProfile: [] as unknown[],
    createInviteCode: [] as unknown[],
    revokeInviteCode: [] as unknown[],
    createOffer: [] as unknown[],
    updateOffer: [] as unknown[],
    deleteOffer: [] as unknown[],
  };
  const repository: MarketplaceAdminRepository & { calls: typeof calls } = {
    calls,
    async listCollaborations(input) {
      calls.listCollaborations.push(input);
      return { collaborations: [collaboration], total: 1 };
    },
    async respondToCollaborationAsHotel(input) {
      calls.respond.push(input);
      return lifecycleResponse(input.idempotencyKey, "respond");
    },
    async approveCollaborationAsHotel(input) {
      calls.approve.push(input);
      return lifecycleResponse(input.idempotencyKey, "approve_terms");
    },
    async updateCreatorProfileForUser(input) {
      calls.updateCreatorProfile.push(input);
      return profileUpdateResponse(input.authorizationMode, input.userId, "creator");
    },
    async updateHotelProfileForUser(input) {
      calls.updateHotelProfile.push(input);
      return profileUpdateResponse(input.authorizationMode, input.userId, "hotel");
    },
    async listInviteCodes() {
      return [inviteCodeResponse()];
    },
    async createInviteCode(input) {
      calls.createInviteCode.push(input);
      return inviteCodeResponse("invite_created", "VAY-CREATED", input.payload);
    },
    async revokeInviteCode(inviteCodeId) {
      calls.revokeInviteCode.push(inviteCodeId);
      return inviteCodeId === "invite_801";
    },
    async createOfferForUser(input) {
      calls.createOffer.push(input);
      return offerResponse(input.authorizationMode);
    },
    async updateOfferForUser(input) {
      calls.updateOffer.push(input);
      return offerResponse(input.authorizationMode, input.request.title ?? "Creator suite");
    },
    async deleteOfferForUser(input) {
      calls.deleteOffer.push(input);
      return {
        contractVersion: "marketplace-admin.v1",
        authorizationMode: input.authorizationMode,
        deletedOffer: { offerId: "offer_801", title: "Creator suite" },
      };
    },
    async isLegacySuperadmin(userId) {
      return legacySuperadminUserIds.has(userId);
    },
  };
  return repository;
}

function lifecycleResponse(
  idempotencyKey: string,
  action: "respond" | "approve_terms",
): MarketplaceCollaborationLifecycleWriteResponse {
  return {
    contractVersion: "marketplace-collaboration-lifecycle-writes.v1",
    command: { action, idempotencyKey },
    collaboration,
    sideEffects: [{ type: "marketplace.collaboration.system_message_requested" }],
  };
}

function profileUpdateResponse(
  authorizationMode: MarketplaceAdminUserProfileUpdateResponse["authorizationMode"],
  userId: string,
  profileType: MarketplaceAdminUserProfileUpdateResponse["profileType"],
): MarketplaceAdminUserProfileUpdateResponse {
  return {
    contractVersion: "marketplace-admin.v1",
    authorizationMode,
    userId,
    profileType,
    updatedAt: "2026-06-13T10:00:00.000Z",
  };
}

function inviteCodeResponse(
  id = "invite_801",
  code = "VAY-INVITE",
  setupData: unknown = {},
): MarketplaceAdminInviteCode {
  return {
    id,
    code,
    status: "pending",
    created_at: "2026-06-13T10:00:00.000Z",
    expires_at: "2026-07-13T10:00:00.000Z",
    hotel_name: null,
    redeemed_at: null,
    setup_data: setupData,
  };
}

function offerPayload(): MarketplaceAdminCreateOfferRequest {
  return {
    title: "Creator suite",
    offerSummary: "A suite for creator stays.",
    deliverables: [
      {
        platform: "instagram",
        deliverableType: "reel",
        quantity: 1,
        timingGuidance: "During the stay",
      },
    ],
    compensationOptions: [
      {
        compensationType: "free_stay",
        availabilityMonths: ["June"],
        platforms: ["instagram"],
        freeStayMinNights: 2,
        freeStayMaxNights: 4,
        paidMaxAmount: null,
        discountPercentage: null,
        commissionPercentage: null,
        minFollowers: 10000,
        currency: "EUR",
        termsSummary: null,
      },
    ],
    creatorRequirements: {
      platforms: ["instagram"],
      targetCountries: ["AT"],
      targetAgeMin: 18,
      targetAgeMax: 45,
      targetAgeGroups: ["18-24"],
      creatorTypes: ["travel"],
    },
  };
}

function offerResponse(
  authorizationMode: MarketplaceAdminOffer["authorizationMode"],
  title = "Creator suite",
): MarketplaceAdminOffer {
  return {
    contractVersion: "marketplace-admin.v1",
    authorizationMode,
    offerId: "offer_801",
    propertyId: "property_801",
    offerStatus: "verified",
    title,
    offerSummary: "A suite for creator stays.",
    media: [],
    deliverables: [
      {
        deliverableId: "deliverable_801",
        platform: "instagram",
        deliverableType: "reel",
        quantity: 1,
        timingGuidance: "During the stay",
      },
    ],
    compensationOptions: [
      {
        compensationOptionId: "compensation_801",
        compensationType: "free_stay",
        availabilityMonths: ["June"],
        platforms: ["instagram"],
        freeStayMinNights: 2,
        freeStayMaxNights: 4,
        paidMaxAmount: null,
        discountPercentage: null,
        commissionPercentage: null,
        minFollowers: 10000,
        currency: "EUR",
        termsSummary: null,
      },
    ],
    creatorRequirements: {
      platforms: ["instagram"],
      targetCountries: ["AT"],
      targetAgeMin: 18,
      targetAgeMax: 45,
      targetAgeGroups: ["18-24"],
      creatorTypes: ["travel"],
    },
    createdAt: "2026-06-13T10:00:00.000Z",
    updatedAt: "2026-06-13T10:00:00.000Z",
  };
}
