import {
  createFakeVerifier,
  type IdentityRepository,
  type VerifiedSession,
} from "@vayada/backend-auth";
import { injectJson } from "@vayada/backend-test";
import type { QueryResultRow } from "pg";
import { afterEach, describe, expect, it, vi } from "vitest";

import { buildApp } from "./app.js";
import { agencyPropertyAccessRepository } from "./testAuthorization.js";
import { createPgMarketplaceOfferIdentityAccessCommandPort } from "./platform/marketplaceOfferIdentityAccess.js";
import {
  createPgMarketplaceAdminRepository,
  mapOfferRow,
  syncPropertyOfferReadModels,
} from "./routes/marketplaceAdmin.js";
import type {
  MarketplaceAdminCollaborationsResponse,
  MarketplaceAdminCreateOfferRequest,
  MarketplaceAdminCreatorReviewResponse,
  MarketplaceAdminDeleteOfferResponse,
  MarketplaceAdminHotelReviewResponse,
  MarketplaceAdminHotelAccountInviteCreateRequest,
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
    expect(list.body[0]).toMatchObject({
      contractVersion: "hotel-account-invite.v1",
      code: "VAY-INVITE",
      handoffPath: "/setup",
    });

    const routeCases: Array<{
      label: string;
      selectedTracks: MarketplaceAdminHotelAccountInviteCreateRequest["selectedTracks"];
    }> = [
      { label: "Marketplace", selectedTracks: ["creator_marketplace"] },
      { label: "Hotel Operations", selectedTracks: ["hotel_operations"] },
      {
        label: "combined",
        selectedTracks: ["hotel_operations", "creator_marketplace"],
      },
    ];

    for (const routeCase of routeCases) {
      const payload = hotelInviteRequest(routeCase.selectedTracks);
      const created = await injectJson<MarketplaceAdminInviteCode>(app, {
        method: "POST",
        url: "/api/marketplace/admin/invite-codes",
        headers: { authorization: "Bearer platform-token" },
        payload,
      });

      expect(created.statusCode, routeCase.label).toBe(201);
      expect(created.body, routeCase.label).toMatchObject({
        contractVersion: "hotel-account-invite.v1",
        identity: { email: "owner@example.test" },
        organization: { displayName: "Alpenrose Hospitality" },
        property: { displayName: "Hotel Alpenrose" },
        selectedTracks: routeCase.selectedTracks,
        handoffPath: "/setup",
      });
    }

    expect(repository.calls.createInviteCode).toHaveLength(3);
    expect(repository.calls.createInviteCode[2]).toMatchObject({
      createdByUserId: "user_platform",
      invite: {
        contractVersion: "hotel-account-invite.v1",
        selectedTracks: ["hotel_operations", "creator_marketplace"],
        handoffPath: "/setup",
      },
    });

    const deleted = await app.inject({
      method: "DELETE",
      url: "/api/marketplace/admin/invite-codes/invite_801",
      headers: { authorization: "Bearer platform-token" },
    });

    expect(deleted.statusCode).toBe(204);
    expect(repository.calls.revokeInviteCode).toEqual(["invite_801"]);
  });

  it("rejects retired setup payloads and invalid setup tracks", async () => {
    const repository = createMemoryMarketplaceAdminRepository();
    app = buildMarketplaceAdminApp(repository);

    const retiredPayload = await injectJson(app, {
      method: "POST",
      url: "/api/marketplace/admin/invite-codes",
      headers: { authorization: "Bearer platform-token" },
      payload: {
        ...hotelInviteRequest(["hotel_operations"]),
        policies: { payout_iban: "must-not-be-stored" },
      },
    });
    expect(retiredPayload.statusCode).toBe(422);
    expect(retiredPayload.body).toMatchObject({ code: "unsupported_invite_field" });

    const invalidTrack = await injectJson(app, {
      method: "POST",
      url: "/api/marketplace/admin/invite-codes",
      headers: { authorization: "Bearer platform-token" },
      payload: {
        ...hotelInviteRequest(["hotel_operations"]),
        selectedTracks: ["booking"],
      },
    });
    expect(invalidTrack.statusCode).toBe(422);
    expect(invalidTrack.body).toMatchObject({ code: "invalid_selected_tracks" });
    expect(repository.calls.createInviteCode).toHaveLength(0);
  });

  it("requires platform authorization before creating a hotel invite", async () => {
    const repository = createMemoryMarketplaceAdminRepository();
    app = buildMarketplaceAdminApp(repository);
    const payload = hotelInviteRequest(["creator_marketplace"]);

    const unauthenticated = await injectJson(app, {
      method: "POST",
      url: "/api/marketplace/admin/invite-codes",
      payload,
    });
    expect(unauthenticated.statusCode).toBe(401);

    const unauthorized = await injectJson(app, {
      method: "POST",
      url: "/api/marketplace/admin/invite-codes",
      headers: { authorization: "Bearer creator-token" },
      payload,
    });
    expect(unauthorized.statusCode).toBe(403);
    expect(repository.calls.createInviteCode).toHaveLength(0);
  });

  it("scopes invite list and revoke queries to the hotel account contract", async () => {
    const sql: string[] = [];
    const repository = createPgMarketplaceAdminRepository({
      connectionString: "postgresql://target-db",
      identityAccess: createPgMarketplaceOfferIdentityAccessCommandPort(),
      pool: createAdminPgPool(sql, { revokeInviteExists: true }) as never,
    });

    await expect(repository.listInviteCodes()).resolves.toEqual([]);
    await expect(repository.revokeInviteCode("invite_legacy_or_non_hotel")).resolves.toBe(true);

    expect(sql[0]).toContain("invite.invite_type = 'hotel'");
    expect(sql[0]).toContain("invite.payload ->> 'contractVersion' = $1");
    const lockedInvite = sql.find((statement) => statement.includes("FOR UPDATE"));
    const redemptionGuard = sql.find((statement) =>
      statement.includes("FROM platform.idempotency_keys redemption"),
    );
    expect(lockedInvite).toContain("invite_type = 'hotel'");
    expect(lockedInvite).toContain("payload ->> 'contractVersion' = $2");
    expect(redemptionGuard).toContain("redemption.operation = 'hotel_setup.tracks.update'");
    expect(redemptionGuard).toContain("JOIN identity.organizations organization");
    expect(redemptionGuard).toContain("redemption.correlation_id = $1");
    expect(redemptionGuard).toContain("organization.workos_external_id = $2");
    expect(redemptionGuard).toContain("redemption.response_status_code = 200");
    expect(sql).toContain("COMMIT");
  });

  it("refuses revocation after canonical invite intent commits but before finalization recovers", async () => {
    const sql: string[] = [];
    const repository = createPgMarketplaceAdminRepository({
      connectionString: "postgresql://target-db",
      identityAccess: createPgMarketplaceOfferIdentityAccessCommandPort(),
      pool: createAdminPgPool(sql, {
        revokeInviteExists: true,
        successfulInviteRedemption: true,
      }) as never,
    });

    await expect(repository.revokeInviteCode("invite_pending_recovery")).resolves.toBe(false);

    expect(sql.some((statement) => statement.includes("FOR UPDATE"))).toBe(true);
    expect(sql.some((statement) => statement.includes("SET status = 'revoked'"))).toBe(false);
    expect(sql).toContain("ROLLBACK");
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

    const verified = await injectJson<MarketplaceAdminOffer>(app, {
      method: "POST",
      url: "/api/marketplace/admin/users/user_hotel/offers/offer_801/verify",
      headers: { authorization: "Bearer platform-token" },
      payload: { mediaObjectIds: ["f8017000-0000-4000-8000-000000000001"] },
    });

    expect(verified.statusCode).toBe(200);
    expect(verified.body.offerStatus).toBe("verified");
    expect(repository.calls.verifyOffer[0]).toMatchObject({
      hotelUserId: "user_hotel",
      offerId: "offer_801",
      mediaObjectIds: ["f8017000-0000-4000-8000-000000000001"],
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

  it("reads the Marketplace-owned hotel review separately from identity user detail", async () => {
    const repository = createMemoryMarketplaceAdminRepository();
    app = buildMarketplaceAdminApp(repository);

    const response = await injectJson<MarketplaceAdminHotelReviewResponse>(app, {
      method: "GET",
      url: "/api/marketplace/admin/users/user_hotel/review",
      headers: { authorization: "Bearer platform-token" },
    });

    expect(response.statusCode).toBe(200);
    expect(response.body).toMatchObject({
      userId: "user_hotel",
      profile: {
        propertyId: "property_801",
        profileStatus: "pending",
      },
      offers: [{ offerId: "offer_801", offerStatus: "verified" }],
    });
    expect(repository.calls.readHotelReview).toEqual([
      {
        hotelUserId: "user_hotel",
        authorizationMode: "platform_organization_membership",
      },
    ]);
  });

  it("reads the exact Marketplace-owned creator profile separately from identity", async () => {
    const repository = createMemoryMarketplaceAdminRepository();
    app = buildMarketplaceAdminApp(repository);

    const response = await injectJson<MarketplaceAdminCreatorReviewResponse>(app, {
      method: "GET",
      url: "/api/marketplace/admin/users/user_creator/review/creator",
      headers: { authorization: "Bearer platform-token" },
    });

    expect(response.statusCode).toBe(200);
    expect(response.body).toMatchObject({
      userId: "user_creator",
      profile: {
        creatorProfileId: "creator_profile_801",
        profilePictureMediaObjectId: "media_creator_801",
      },
    });
    expect(repository.calls.readCreatorReview).toEqual([
      {
        userId: "user_creator",
        authorizationMode: "platform_organization_membership",
      },
    ]);
  });

  it.each([
    ["missing", []],
    ["ambiguous", [creatorReviewRow(), creatorReviewRow("f8014000-0000-0000-0000-000000000002")]],
  ])("fails closed for %s Admin creator profile reads", async (_case, creatorReviewRows) => {
    const sql: string[] = [];
    const repository = createPgMarketplaceAdminRepository({
      connectionString: "postgresql://target-db",
      identityAccess: createPgMarketplaceOfferIdentityAccessCommandPort(),
      pool: createAdminPgPool(sql, { creatorReviewRows }) as never,
    });

    await expect(
      repository.readCreatorReviewForUser({
        userId: "f8011000-0000-4000-8000-000000000001",
        authorizationMode: "platform_organization_membership",
      }),
    ).resolves.toMatchObject({ profile: null });
    expect(sql[0]).toContain("membership.status = 'active'");
    expect(sql[0]).toContain("organization.kind = 'creator_workspace'");
    expect(sql[0]).toContain("profile.profile_status <> 'archived'");
    expect(sql[0]).not.toContain("LIMIT 1");
  });

  it("normalizes persisted creator platform JSON before exposing it", async () => {
    const repository = createPgMarketplaceAdminRepository({
      connectionString: "postgresql://target-db",
      identityAccess: createPgMarketplaceOfferIdentityAccessCommandPort(),
      pool: createAdminPgPool([], {
        creatorReviewRows: [
          {
            ...creatorReviewRow(),
            platforms: [
              {
                platformId: "platform-801",
                platform: "instagram",
                handle: "@lina",
                profileUrl: null,
                followerCount: 20000,
                engagementRate: "4.2",
                audienceCountries: [
                  { country: "AT", percentage: 60 },
                  { country: "", percentage: "bad" },
                ],
                audienceAgeGroups: "invalid",
                audienceGenderSplit: { male: 40, female: 60 },
                createdAt: "2026-06-12T10:00:00.000Z",
                updatedAt: "2026-06-13T10:00:00.000Z",
              },
              { platform: "invalid" },
            ],
          },
        ],
      }) as never,
    });

    await expect(
      repository.readCreatorReviewForUser({
        userId: "f8011000-0000-4000-8000-000000000001",
        authorizationMode: "platform_organization_membership",
      }),
    ).resolves.toMatchObject({
      profile: {
        platforms: [
          {
            platformId: "platform-801",
            platform: "instagram",
            followerCount: 20000,
            engagementRate: 4.2,
            audienceCountries: [{ country: "AT", percentage: 60 }],
            audienceAgeGroups: [],
            audienceGenderSplit: { male: 40, female: 60 },
          },
        ],
      },
    });
  });

  it("keeps legacy Admin offer verification without a selected media set", async () => {
    const repository = createMemoryMarketplaceAdminRepository();
    app = buildMarketplaceAdminApp(repository);

    const response = await injectJson(app, {
      method: "POST",
      url: "/api/marketplace/admin/users/user_hotel/offers/offer_801/verify",
      headers: { authorization: "Bearer platform-token" },
    });

    expect(response.statusCode).toBe(200);
    expect(repository.calls.verifyOffer[0]).toMatchObject({
      hotelUserId: "user_hotel",
      offerId: "offer_801",
    });
    expect(repository.calls.verifyOffer[0]).not.toHaveProperty("mediaObjectIds");
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
        profilePictureMediaObjectId: "f8017000-0000-4000-8000-000000000001",
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
      actorUserId: "user_platform",
      request: {
        displayName: "Lina Travels",
        profilePictureMediaObjectId: "f8017000-0000-4000-8000-000000000001",
      },
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

  it("rejects malformed or duplicate media IDs before offer verification", async () => {
    const repository = createMemoryMarketplaceAdminRepository();
    app = buildMarketplaceAdminApp(repository);

    for (const mediaObjectIds of [
      ["not-a-uuid"],
      ["f8017000-0000-4000-8000-000000000001", "f8017000-0000-4000-8000-000000000001"],
    ]) {
      const response = await injectJson(app, {
        method: "POST",
        url: "/api/marketplace/admin/users/user_hotel/offers/offer_801/verify",
        headers: { authorization: "Bearer platform-token" },
        payload: { mediaObjectIds },
      });
      expect(response.statusCode).toBe(422);
      expect(response.body).toMatchObject({ code: "invalid_mediaObjectIds" });
    }
    expect(repository.calls.verifyOffer).toHaveLength(0);
  });

  it("rejects malformed creator profile media object IDs", async () => {
    const repository = createMemoryMarketplaceAdminRepository();
    app = buildMarketplaceAdminApp(repository);

    const response = await injectJson(app, {
      method: "PUT",
      url: "/api/marketplace/admin/users/user_creator/profile/creator",
      headers: { authorization: "Bearer platform-token" },
      payload: { profilePictureMediaObjectId: "f8017000--0000-4000-8000-000000000001" },
    });

    expect(response.statusCode).toBe(422);
    expect(response.body).toMatchObject({ code: "invalid_profilePictureMediaObjectId" });
    expect(repository.calls.updateCreatorProfile).toHaveLength(0);
  });

  it("persists only exact approved creator media IDs and their derived URL", async () => {
    const sql: string[] = [];
    const values: Array<readonly unknown[] | undefined> = [];
    const repository = createPgMarketplaceAdminRepository({
      connectionString: "postgresql://target-db",
      identityAccess: createPgMarketplaceOfferIdentityAccessCommandPort(),
      pool: createAdminPgPool(sql, {
        creatorProfileMediaUrl: "https://cdn.example.test/media/profile.webp",
        queryValues: values,
      }) as never,
    });

    await expect(
      repository.updateCreatorProfileForUser({
        userId: "f8011000-0000-4000-8000-000000000001",
        actorUserId: "f8011000-0000-4000-8000-000000000002",
        authorizationMode: "platform_organization_membership",
        request: { profilePictureMediaObjectId: "f8017000-0000-4000-8000-000000000001" },
      }),
    ).resolves.toMatchObject({ profileType: "creator" });

    const mediaQuery = sql.findIndex((statement) => statement.includes("platform.media_objects"));
    expect(sql[mediaQuery]).toContain("media.created_by_user_id = $2::uuid");
    expect(sql[mediaQuery]).toContain("media.public_approved = TRUE");
    expect(sql[mediaQuery]).toContain("media.source_metadata ->> 'requestedVisibility'");
    expect(sql[mediaQuery]).toContain("media.resource_type = 'creator_profile'");
    expect(values[mediaQuery]).toEqual([
      "f8017000-0000-4000-8000-000000000001",
      "f8011000-0000-4000-8000-000000000002",
      "f8012000-0000-0000-0000-000000000002",
      "f8014000-0000-0000-0000-000000000001",
    ]);
    const updateSql = sql.find((statement) =>
      statement.includes("UPDATE marketplace.creator_profiles"),
    );
    expect(updateSql).toContain("profilePictureMediaObjectId");
    expect(updateSql).toContain("WHEN $5::boolean THEN profile_metadata -");
    expect(sql.find((statement) => statement.includes("ORDER BY profile.id ASC"))).toContain(
      "FOR UPDATE OF profile",
    );

    const denied = createPgMarketplaceAdminRepository({
      connectionString: "postgresql://target-db",
      identityAccess: createPgMarketplaceOfferIdentityAccessCommandPort(),
      pool: createAdminPgPool([]) as never,
    });
    app = buildMarketplaceAdminApp(denied);
    const deniedResponse = await injectJson(app, {
      method: "PUT",
      url: "/api/marketplace/admin/users/f8011000-0000-4000-8000-000000000001/profile/creator",
      headers: { authorization: "Bearer platform-token" },
      payload: { profilePictureMediaObjectId: "f8017000-0000-4000-8000-000000000099" },
    });
    expect(deniedResponse.statusCode).toBe(422);
    expect(deniedResponse.body).toMatchObject({ code: "invalid_profile_picture_media" });
  });

  it.each([
    ["missing", []],
    [
      "ambiguous",
      [
        {
          creatorProfileId: "f8014000-0000-0000-0000-000000000001",
          organizationId: "f8012000-0000-0000-0000-000000000002",
        },
        {
          creatorProfileId: "f8014000-0000-0000-0000-000000000002",
          organizationId: "f8012000-0000-0000-0000-000000000003",
        },
      ],
    ],
  ])("rejects %s creator profile resolution for admin updates", async (_case, rows) => {
    const sql: string[] = [];
    const repository = createPgMarketplaceAdminRepository({
      connectionString: "postgresql://target-db",
      identityAccess: createPgMarketplaceOfferIdentityAccessCommandPort(),
      pool: createAdminPgPool(sql, { creatorProfileRows: rows }) as never,
    });

    await expect(
      repository.updateCreatorProfileForUser({
        userId: "f8011000-0000-4000-8000-000000000001",
        actorUserId: "f8011000-0000-4000-8000-000000000002",
        authorizationMode: "platform_organization_membership",
        request: { displayName: "Lina Travels" },
      }),
    ).resolves.toBeNull();
    expect(sql.some((statement) => statement.includes("UPDATE marketplace.creator_profiles"))).toBe(
      false,
    );
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
    const mediaPromotions: unknown[] = [];
    const repository = createPgMarketplaceAdminRepository({
      connectionString: "postgresql://target-db",
      identityAccess: createPgMarketplaceOfferIdentityAccessCommandPort(),
      offerMediaPromotion: {
        async promoteOfferMedia(input) {
          mediaPromotions.push(input);
          return 1;
        },
      },
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
      repository.verifyOfferForUser({
        hotelUserId: "user_hotel",
        offerId: "f8015000-0000-0000-0000-000000000001",
        mediaObjectIds: ["f8017000-0000-4000-8000-000000000001"],
        authorizationMode: "platform_organization_membership",
      }),
    ).resolves.toMatchObject({
      offerId: "f8015000-0000-0000-0000-000000000001",
      offerStatus: "verified",
    });
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
      4,
    );
    expect(statements).toContain("ON CONFLICT (offer_id) DO UPDATE");
    expect(statements).not.toContain("current_projection.visibility_status");
    expect(statements).toContain("WHEN $2 = 'disable' THEN 'disabled'");
    expect(projectionModes).toEqual(["initialize", "initialize", "initialize", "disable"]);
    expect(mediaPromotions).toEqual([
      {
        organizationId: "f8012000-0000-0000-0000-000000000001",
        offerId: "f8015000-0000-0000-0000-000000000001",
        mediaObjectIds: ["f8017000-0000-4000-8000-000000000001"],
      },
    ]);
    expect(statements).toContain("SET offer_status = 'verified', updated_at = now()");
    expect(statements).toContain("SET marketplace_profile_status = 'verified', updated_at = now()");
    expect(statements).toContain("AND profile_complete = TRUE");
    expect(statements).toContain("marketplace_profile.marketplace_profile_status = 'verified'");
    expect(statements).toContain("marketplace_profile.profile_complete = TRUE");
    expect(statements).toContain("COALESCE(cardinality(offer_media.urls), 0) > 0");
    const offerProjection = sql.find((statement) =>
      statement.includes("INSERT INTO marketplace.marketplace_offer_read_model"),
    );
    expect(offerProjection).toContain("'countryCode', public_profile.location ->> 'countryCode'");
    expect(offerProjection).toContain("'region', public_profile.location ->> 'region'");
    expect(offerProjection).toContain("'city', public_profile.location ->> 'city'");
    expect(offerProjection).not.toContain("rawMarketplaceLocation");
    expect(offerProjection).not.toContain("streetAddress");
    expect(offerProjection).not.toContain("postalCode");
    expect(offerProjection).not.toContain(
      "LEFT JOIN hotel_catalog.property_locations property_location",
    );
    expect(offerProjection).not.toContain("property_location.raw_marketplace_location");
    expect(offerProjection).not.toContain("property_location.city");
    expect(offerProjection).not.toContain("property_location.country_code");
    expect(statements).toContain("THEN 'public'");
    expect(statements).toContain(
      "COALESCE(public_profile.profile_status, property.profile_status) = 'complete'",
    );
    expect(statements).toContain("SET status = 'archived'");
  });

  it("refreshes every nonarchived offer projection for a canonical profile write", async () => {
    const propertyId = "f8013000-0000-0000-0000-000000000001";
    const offerIds = [
      "f8015000-0000-0000-0000-000000000001",
      "f8015000-0000-0000-0000-000000000002",
    ];
    const projectedOfferIds: string[] = [];
    const statements: string[] = [];
    const client = {
      async query<T extends QueryResultRow = QueryResultRow>(
        text: string,
        values?: readonly unknown[],
      ): Promise<{ rows: T[] }> {
        statements.push(text);
        let rows: unknown[] = [];
        if (text.includes('offer.id::text AS "offerId"')) {
          rows = offerIds.map((offerId) => ({ offerId }));
        } else if (text.includes('offer.property_id::text AS "propertyId"')) {
          rows = [{ propertyId }];
        } else if (text.includes('property.display_name AS "displayName"')) {
          rows = [
            {
              propertyId,
              publicId: "prop_alpenrose",
              displayName: "Hotel Alpenrose",
              defaultLocale: "en",
              canonicalSlug: "hotel-alpenrose",
            },
          ];
        } else if (text.includes("INSERT INTO marketplace.marketplace_offer_read_model")) {
          projectedOfferIds.push(String(values?.[0]));
        }
        return { rows: rows as T[] };
      },
    };

    await syncPropertyOfferReadModels(client, {
      propertyId,
    });

    expect(projectedOfferIds).toEqual(offerIds);
    expect(
      statements.find((statement) => statement.includes('offer.id::text AS "offerId"')),
    ).toContain("offer.offer_status <> 'archived'");
    expect(
      statements.find((statement) => statement.includes('offer.id::text AS "offerId"')),
    ).not.toContain("offer.organization_id");
  });

  it("loads pending offers for a hotel review without reading them through identity", async () => {
    const sql: string[] = [];
    const repository = createPgMarketplaceAdminRepository({
      connectionString: "postgresql://target-db",
      identityAccess: createPgMarketplaceOfferIdentityAccessCommandPort(),
      pool: createAdminPgPool(sql) as never,
    });

    await expect(
      repository.readHotelReviewForUser({
        hotelUserId: "user_hotel",
        authorizationMode: "platform_organization_membership",
      }),
    ).resolves.toMatchObject({
      userId: "user_hotel",
      profile: {
        propertyId: "f8013000-0000-0000-0000-000000000001",
        displayName: "Hotel Alpenrose",
      },
      offers: [{ offerId: "f8015000-0000-0000-0000-000000000001" }],
    });
    const statements = sql.join("\n");
    expect(statements).toContain('profile.host_summary AS "hostSummary"');
    expect(statements).toContain("offer.offer_status <> 'archived'");
    expect(statements).toContain("public_profile.location->>'city'");
    expect(statements).toContain("public_profile.location->>'region'");
    expect(statements).toContain("public_profile.location->>'countryCode'");
    expect(statements).not.toContain("rawMarketplaceLocation");
    expect(statements).not.toContain("raw_marketplace_location");
    expect(statements).not.toContain("JOIN hotel_catalog.property_locations location");
  });

  it("rejects offer verification when any requested media ID is outside the exact offer", async () => {
    const promoteOfferMedia = vi.fn(async () => 0);
    const sql: string[] = [];
    const values: Array<readonly unknown[] | undefined> = [];
    const repository = createPgMarketplaceAdminRepository({
      connectionString: "postgresql://target-db",
      identityAccess: createPgMarketplaceOfferIdentityAccessCommandPort(),
      offerMediaPromotion: { promoteOfferMedia },
      pool: createAdminPgPool(sql, { eligibleMediaCount: 0, queryValues: values }) as never,
    });

    await expect(
      repository.verifyOfferForUser({
        hotelUserId: "user_hotel",
        offerId: "f8015000-0000-0000-0000-000000000001",
        mediaObjectIds: ["f8017000-0000-4000-8000-000000000099"],
        authorizationMode: "platform_organization_membership",
      }),
    ).rejects.toMatchObject({ statusCode: 422 });
    expect(promoteOfferMedia).not.toHaveBeenCalled();
    const eligibilityQuery = sql.findIndex((statement) => statement.includes('AS "eligibleCount"'));
    expect(sql[eligibilityQuery]).toContain("media.owner_organization_id = $1::uuid");
    expect(sql[eligibilityQuery]).toContain("media.resource_id = $2");
    expect(values[eligibilityQuery]).toEqual([
      "f8012000-0000-0000-0000-000000000001",
      "f8015000-0000-0000-0000-000000000001",
      ["f8017000-0000-4000-8000-000000000099"],
    ]);
  });

  it("rejects offer verification while the Marketplace hotel profile is incomplete", async () => {
    const promoteOfferMedia = vi.fn(async () => 1);
    const sql: string[] = [];
    const repository = createPgMarketplaceAdminRepository({
      connectionString: "postgresql://target-db",
      identityAccess: createPgMarketplaceOfferIdentityAccessCommandPort(),
      offerMediaPromotion: { promoteOfferMedia },
      pool: createAdminPgPool(sql, { profileComplete: false }) as never,
    });

    await expect(
      repository.verifyOfferForUser({
        hotelUserId: "user_hotel",
        offerId: "f8015000-0000-0000-0000-000000000001",
        authorizationMode: "platform_organization_membership",
      }),
    ).rejects.toMatchObject({ statusCode: 422 });
    expect(promoteOfferMedia).not.toHaveBeenCalled();
    expect(sql.join("\n")).not.toContain("SET offer_status = 'verified'");
  });

  it("rejects verified admin offer creation while the Marketplace hotel profile is incomplete", async () => {
    const sql: string[] = [];
    const repository = createPgMarketplaceAdminRepository({
      connectionString: "postgresql://target-db",
      identityAccess: createPgMarketplaceOfferIdentityAccessCommandPort(),
      pool: createAdminPgPool(sql, { profileComplete: false }) as never,
    });

    await expect(
      repository.createOfferForUser({
        hotelUserId: "user_hotel",
        request: offerPayload(),
        authorizationMode: "platform_organization_membership",
      }),
    ).rejects.toMatchObject({ statusCode: 422 });
    expect(sql.join("\n")).not.toContain("INSERT INTO marketplace.marketplace_offers");
  });

  it("retains pending offer media metadata for the owner without publishing a URL", () => {
    const offer = mapOfferRow(
      {
        ...adminOfferRow("offer_801", "property_801"),
        offerStatus: "pending",
        media: [
          {
            mediaObjectId: "media_801",
            url: null,
            approvalStatus: "pending_domain_approval",
            lifecycleStatus: "staged",
          },
        ],
      },
      "platform_organization_membership",
    );

    expect(offer.media).toEqual([
      {
        mediaObjectId: "media_801",
        url: null,
        approvalStatus: "pending_domain_approval",
        lifecycleStatus: "staged",
      },
    ]);
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
  options: {
    acceptedAffiliateCollaboration?: boolean;
    projectionModes?: string[];
    hasEligibleMedia?: boolean;
    profileComplete?: boolean;
    revokeInviteExists?: boolean;
    successfulInviteRedemption?: boolean;
    creatorProfileMediaUrl?: string;
    creatorProfileRows?: Array<{ creatorProfileId: string; organizationId: string }>;
    creatorReviewRows?: unknown[];
    eligibleMediaCount?: number;
    queryValues?: Array<readonly unknown[] | undefined>;
  } = {},
) {
  const offerId = "f8015000-0000-0000-0000-000000000001";
  const propertyId = "f8013000-0000-0000-0000-000000000001";
  const organizationId = "f8012000-0000-0000-0000-000000000001";

  const query = async <T extends QueryResultRow = QueryResultRow>(
    text: string,
    _values?: readonly unknown[],
  ): Promise<{ rows: T[] }> => {
    sql.push(text);
    options.queryValues?.push(_values);
    if (text.includes("INSERT INTO marketplace.marketplace_offer_read_model")) {
      options.projectionModes?.push(String(_values?.[1]));
    }
    let rows: unknown[] = [];
    if (text.includes("SELECT EXISTS (") && text.includes("FROM platform.idempotency_keys")) {
      rows = [{ exists: options.successfulInviteRedemption ?? false }];
    } else if (text.includes("FROM platform.idempotency_keys")) {
      rows = [];
    } else if (text.includes("INSERT INTO platform.idempotency_keys")) {
      rows = [{ id: "idempotency_801" }];
    } else if (
      options.revokeInviteExists &&
      text.includes("FROM marketplace.invite_codes") &&
      text.includes("FOR UPDATE")
    ) {
      rows = [{ id: "invite_legacy_or_non_hotel" }];
    } else if (text.includes("SET status = 'revoked'")) {
      rows = [{ id: "invite_legacy_or_non_hotel" }];
    } else if (text.includes("UPDATE marketplace.collaborations AS collaboration")) {
      rows = [{ id: "f8016000-0000-0000-0000-000000000001" }];
    } else if (
      options.acceptedAffiliateCollaboration &&
      text.includes('collaboration.id::text AS "collaborationId"')
    ) {
      rows = [acceptedAffiliateCollaborationRow()];
    } else if (
      text.includes("FROM marketplace.creator_profiles profile") &&
      text.includes('profile.display_name AS "displayName"')
    ) {
      rows = options.creatorReviewRows ?? [creatorReviewRow()];
    } else if (
      text.includes("FROM marketplace.creator_profiles profile") &&
      text.includes("identity.organization_memberships membership")
    ) {
      rows = options.creatorProfileRows ?? [
        {
          creatorProfileId: "f8014000-0000-0000-0000-000000000001",
          organizationId: "f8012000-0000-0000-0000-000000000002",
        },
      ];
    } else if (
      text.includes("FROM platform.media_objects media") &&
      text.includes("variant.variant_name = 'original_safe'")
    ) {
      rows = options.creatorProfileMediaUrl
        ? [{ publicCdnUrl: options.creatorProfileMediaUrl }]
        : [];
    } else if (text.includes("UPDATE marketplace.creator_profiles")) {
      rows = [{ updatedAt: "2026-06-13T10:00:00.000Z" }];
    } else if (
      text.includes("FROM marketplace.marketplace_hotel_profiles profile") &&
      text.includes("identity.organization_memberships membership")
    ) {
      rows = [
        {
          propertyId,
          organizationId,
          profileStatus: "pending",
          profileComplete: options.profileComplete ?? true,
          displayName: "Hotel Alpenrose",
          location: "Innsbruck, AT",
          hostSummary: "Independent alpine hotel.",
          createdAt: "2026-06-13T10:00:00.000Z",
          updatedAt: "2026-06-13T10:00:00.000Z",
        },
      ];
    } else if (text.includes('AS "eligibleCount"')) {
      rows = [
        { eligibleCount: options.eligibleMediaCount ?? (_values?.[2] as unknown[])?.length ?? 0 },
      ];
    } else if (
      text.includes("SELECT EXISTS (") &&
      text.includes("FROM platform.media_objects media")
    ) {
      rows = [{ exists: options.hasEligibleMedia ?? true }];
    } else if (text.includes("INSERT INTO marketplace.marketplace_offers")) {
      rows = [{ id: offerId }];
    } else if (
      text.includes('offer.property_id::text AS "propertyId"') &&
      !text.includes('offer.id::text AS "offerId"')
    ) {
      rows = [{ propertyId }];
    } else if (text.includes('property.display_name AS "displayName"')) {
      rows = [
        {
          propertyId,
          publicId: "prop_alpenrose",
          displayName: "Hotel Alpenrose",
          defaultLocale: "en",
          canonicalSlug: "hotel-alpenrose",
        },
      ];
    } else if (text.includes("SET marketplace_profile_status = 'verified'")) {
      rows = [{ propertyId }];
    } else if (text.includes("SET offer_status = 'verified'")) {
      rows = [{ id: offerId }];
    } else if (text.includes('id::text AS "offerResourceId"')) {
      rows = [{ offerResourceId: offerId, title: "Creator suite", offerStatus: "pending" }];
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

function creatorReviewRow(creatorProfileId = "f8014000-0000-0000-0000-000000000001") {
  return {
    creatorProfileId,
    displayName: "Lina Travels",
    locationText: "Vienna, Austria",
    shortDescription: null,
    portfolioUrl: null,
    phone: null,
    profilePictureUrl: "https://cdn.example.test/creator.webp",
    profilePictureMediaObjectId: "f8017000-0000-4000-8000-000000000001",
    profileComplete: true,
    profileCompletedAt: "2026-06-13T10:00:00.000Z",
    profileStatus: "active",
    platforms: [],
    createdAt: "2026-06-12T10:00:00.000Z",
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
      propertyAccessRepository: agencyPropertyAccessRepository,
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
    readHotelReview: [] as unknown[],
    readCreatorReview: [] as unknown[],
    createOffer: [] as unknown[],
    updateOffer: [] as unknown[],
    verifyOffer: [] as unknown[],
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
      return inviteCodeResponse("invite_created", "VAY-CREATED", input.invite);
    },
    async revokeInviteCode(inviteCodeId) {
      calls.revokeInviteCode.push(inviteCodeId);
      return inviteCodeId === "invite_801";
    },
    async readHotelReviewForUser(input) {
      calls.readHotelReview.push(input);
      return {
        contractVersion: "marketplace-admin.v1",
        authorizationMode: input.authorizationMode,
        userId: input.hotelUserId,
        profile: {
          propertyId: "property_801",
          displayName: "Hotel Alpenrose",
          location: "Innsbruck, AT",
          hostSummary: "Independent alpine hotel.",
          profileStatus: "pending",
          createdAt: "2026-06-13T10:00:00.000Z",
          updatedAt: "2026-06-13T10:00:00.000Z",
        },
        offers: [offerResponse(input.authorizationMode)],
      };
    },
    async readCreatorReviewForUser(input) {
      calls.readCreatorReview.push(input);
      return {
        contractVersion: "marketplace-admin.v1",
        authorizationMode: input.authorizationMode,
        userId: input.userId,
        profile: {
          creatorProfileId: "creator_profile_801",
          displayName: "Lina Travels",
          locationText: "Vienna, Austria",
          shortDescription: null,
          portfolioUrl: null,
          phone: null,
          profilePictureUrl: "https://cdn.example.test/creator.webp",
          profilePictureMediaObjectId: "media_creator_801",
          profileComplete: true,
          profileCompletedAt: "2026-06-13T10:00:00.000Z",
          profileStatus: "active",
          platforms: [],
          createdAt: "2026-06-12T10:00:00.000Z",
          updatedAt: "2026-06-13T10:00:00.000Z",
        },
      };
    },
    async createOfferForUser(input) {
      calls.createOffer.push(input);
      return offerResponse(input.authorizationMode);
    },
    async updateOfferForUser(input) {
      calls.updateOffer.push(input);
      return offerResponse(input.authorizationMode, input.request.title ?? "Creator suite");
    },
    async verifyOfferForUser(input) {
      calls.verifyOffer.push(input);
      return offerResponse(input.authorizationMode);
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
  invite: MarketplaceAdminHotelAccountInviteCreateRequest = hotelInviteRequest([
    "creator_marketplace",
  ]),
): MarketplaceAdminInviteCode {
  return {
    contractVersion: "hotel-account-invite.v1",
    id,
    code,
    status: "pending",
    createdAt: "2026-06-13T10:00:00.000Z",
    expiresAt: "2026-07-13T10:00:00.000Z",
    identity: invite.identity,
    organization: invite.organization,
    property: invite.property,
    selectedTracks: invite.selectedTracks,
    handoffPath: "/setup",
    redeemedAt: null,
  };
}

function hotelInviteRequest(
  selectedTracks: MarketplaceAdminHotelAccountInviteCreateRequest["selectedTracks"],
): MarketplaceAdminHotelAccountInviteCreateRequest {
  return {
    identity: { email: "owner@example.test" },
    organization: { displayName: "Alpenrose Hospitality" },
    property: { displayName: "Hotel Alpenrose" },
    selectedTracks,
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
