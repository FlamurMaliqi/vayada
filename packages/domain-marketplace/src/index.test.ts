import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

import {
  AFFILIATE_PROVISIONING_ERROR_CODES,
  AFFILIATE_PROVISIONING_STATUSES,
  COLLABORATION_STATUSES,
  CONNECTABLE_CREATOR_PLATFORMS,
  CREATOR_PLATFORM_AUTHORIZATION_STATUSES,
  CREATOR_PLATFORM_CONNECTION_CONTRACT_VERSION,
  CREATOR_PLATFORM_CONNECTION_STATUSES,
  CREATOR_PLATFORM_ENGAGEMENT_FORMULA_VERSION,
  CREATOR_PLATFORM_ENGAGEMENT_WINDOW_DAYS,
  CREATOR_PLATFORM_IMPORT_FIELDS,
  CREATOR_PLATFORM_PROVIDERS,
  CREATOR_PLATFORM_UNAVAILABLE_REASONS,
  CREATOR_PROFILE_COMPLETION_STEPS,
  CREATOR_PROFILE_MISSING_FIELDS,
  CREATOR_PROFILE_RESOURCE_POLICY,
  CREATOR_PROFILE_SELF_SERVICE_PRIVATE_KEYS,
  MARKETPLACE_COLLABORATION_AUTHORIZATION_SIDES,
  MARKETPLACE_COLLABORATION_CREATOR_READ_POLICY,
  MARKETPLACE_COLLABORATION_CREATOR_WRITE_POLICY,
  MARKETPLACE_COLLABORATION_HOTEL_READ_POLICY,
  MARKETPLACE_COLLABORATION_HOTEL_WRITE_POLICY,
  MARKETPLACE_COLLABORATION_LIFECYCLE_WRITES_CONTRACT_VERSION,
  MARKETPLACE_COLLABORATION_LIFECYCLE_WRITE_ACTIONS,
  MARKETPLACE_COLLABORATION_LIFECYCLE_WRITE_ENDPOINTS,
  MARKETPLACE_COLLABORATION_LIFECYCLE_WRITE_ERROR_CODES,
  MARKETPLACE_COLLABORATION_LIFECYCLE_WRITE_PRIVATE_KEYS,
  MARKETPLACE_COLLABORATION_READS_CONTRACT_VERSION,
  MARKETPLACE_COLLABORATION_READ_ENDPOINTS,
  MARKETPLACE_COLLABORATION_READ_ERROR_CODES,
  MARKETPLACE_COLLABORATION_READ_PRIVATE_KEYS,
  MARKETPLACE_AFFILIATE_CONTRACT_VERSION,
  MARKETPLACE_COMPENSATION_TYPES,
  MARKETPLACE_OFFER_COMPENSATION_TYPES,
  MARKETPLACE_CREATOR_SELF_SERVICE_CONTRACT_VERSION,
  MARKETPLACE_CREATOR_SELF_SERVICE_ENDPOINTS,
  MARKETPLACE_HOTEL_AUTHORIZATION_MODES,
  MARKETPLACE_OFFER_STATUSES,
  MARKETPLACE_HOTEL_MISSING_FIELDS,
  MARKETPLACE_HOTEL_PROFILE_STATUSES,
  MARKETPLACE_HOTEL_SELF_SERVICE_CONTRACT_VERSION,
  MARKETPLACE_HOTEL_SELF_SERVICE_ERROR_CODES,
  MARKETPLACE_PLATFORM_NAMES,
  buildAffiliateProvisioningCommandId,
  buildAffiliateProvisioningIdempotencyKey,
  calculateCreatorPlatformEngagementRate,
  type AffiliateProvisionedEvent,
  type AffiliateProvisioningResult,
  type CollaborationAcceptedEvent,
  type CollaborationAffiliatePort,
  type CreateMarketplaceOfferRequest,
  type CreatorProfileDocument,
  type CreatorProfileStatusResult,
  type CreatorProfileUpdatedEvent,
  type MarketplaceCollaborationLifecycleSideEffect,
  type MarketplaceCollaborationListResponse,
  type MarketplaceCollaborationMessagesResponse,
  type MarketplaceConversationSummary,
  type MarketplaceOfferAuthorizationTarget,
  type MarketplaceHotelProfileResponse,
  type MarketplaceHotelProfileStatusResponse,
  type ProvisionCollaborationAffiliateCommand,
  type UpdateCreatorProfileRequest,
  type UpdateMarketplaceHotelProfileRequest,
} from "./index.js";

describe("@vayada/domain-marketplace", () => {
  it("defines the provider connection contract without unsupported platforms", () => {
    expect(CREATOR_PLATFORM_CONNECTION_CONTRACT_VERSION).toBe(
      "marketplace-creator-platform-connections.v1",
    );
    expect(CREATOR_PLATFORM_PROVIDERS).toEqual(["meta", "tiktok", "google"]);
    expect(CONNECTABLE_CREATOR_PLATFORMS).toEqual(["instagram", "facebook", "tiktok", "youtube"]);
    expect(CREATOR_PLATFORM_AUTHORIZATION_STATUSES).toEqual([
      "authorizing",
      "processing",
      "pending_account_selection",
      "active",
      "failed",
      "expired",
    ]);
    expect(CREATOR_PLATFORM_CONNECTION_STATUSES).toEqual([
      "active",
      "reconnect_required",
      "revoked",
      "sync_failed",
    ]);
    expect(CREATOR_PLATFORM_IMPORT_FIELDS).toContain("audienceCountries");
    expect(CREATOR_PLATFORM_UNAVAILABLE_REASONS).toContain("privacy_threshold");
  });

  it("keeps creator profile completion fields and steps in contract order", () => {
    expect(CREATOR_PROFILE_MISSING_FIELDS).toEqual([
      "displayName",
      "locationText",
      "shortDescription",
      "phone",
      "profilePicture",
      "platforms",
    ]);
    expect(CREATOR_PROFILE_COMPLETION_STEPS).toEqual([
      "add_display_name",
      "set_location",
      "add_short_description",
      "add_phone",
      "add_profile_picture",
      "add_platform",
    ]);
  });

  it("calculates the versioned 30-day engagement rate and keeps zero interactions valid", () => {
    expect(CREATOR_PLATFORM_ENGAGEMENT_WINDOW_DAYS).toBe(30);
    expect(CREATOR_PLATFORM_ENGAGEMENT_FORMULA_VERSION).toBe("creator-platform-engagement.v1");
    expect(
      calculateCreatorPlatformEngagementRate({
        followerCount: 10_000,
        contentItemCount: 4,
        likes: 1_000,
        comments: 100,
        shares: 100,
      }),
    ).toBe(3);
    expect(
      calculateCreatorPlatformEngagementRate({
        followerCount: 10_000,
        contentItemCount: 4,
        likes: 0,
        comments: 0,
        shares: 0,
      }),
    ).toBe(0);
    expect(
      calculateCreatorPlatformEngagementRate({
        followerCount: 3,
        contentItemCount: 1,
        likes: 1,
        comments: 0,
        shares: 0,
      }),
    ).toBe(33.3333);
    expect(
      calculateCreatorPlatformEngagementRate({
        followerCount: 1,
        contentItemCount: 1,
        likes: 10,
        comments: 0,
        shares: 0,
      }),
    ).toBe(1_000);
    expect(
      calculateCreatorPlatformEngagementRate({
        followerCount: 10_000,
        contentItemCount: 4,
        likes: null,
        comments: 0,
        shares: 0,
      }),
    ).toBeNull();
    expect(
      calculateCreatorPlatformEngagementRate({
        followerCount: 0,
        contentItemCount: 4,
        likes: 0,
        comments: 0,
        shares: 0,
      }),
    ).toBeNull();
    expect(
      calculateCreatorPlatformEngagementRate({
        followerCount: 10_000,
        contentItemCount: 4,
        likes: -1,
        comments: 0,
        shares: 0,
      }),
    ).toBeNull();
  });

  it("exports the creator self-service contract version and endpoint paths", () => {
    expect(MARKETPLACE_CREATOR_SELF_SERVICE_CONTRACT_VERSION).toBe(
      "marketplace-creator-self-service.v1",
    );
    expect(MARKETPLACE_CREATOR_SELF_SERVICE_ENDPOINTS.profileStatus).toMatchObject({
      method: "GET",
      path: "/api/marketplace/creators/me/profile-status",
    });
    expect(MARKETPLACE_CREATOR_SELF_SERVICE_ENDPOINTS.profile).toMatchObject({
      method: "GET",
      path: "/api/marketplace/creators/me",
    });
    expect(MARKETPLACE_CREATOR_SELF_SERVICE_ENDPOINTS.updateProfile).toMatchObject({
      method: "PUT",
      path: "/api/marketplace/creators/me",
    });
  });

  it("documents creator self-service authorization through creator workspace resource links", () => {
    expect(CREATOR_PROFILE_RESOURCE_POLICY).toEqual({
      permission: "marketplace.profile.manage",
      selectedOrganizationKind: "creator_workspace",
      resolution: "resolve_active_selected_org_resource_link_then_enforce",
      resource: {
        product: "marketplace",
        resourceType: "creator_profile",
        relationship: "owner",
        resourceIdSource: "identity.organization_resource_links.resource_id",
      },
    });
  });

  it("keeps creator self-service profile status read-before-write and discovery eligibility explicit", () => {
    const status: CreatorProfileStatusResult = {
      creatorProfileId: "creator_profile_lina",
      organizationId: "org_creator_workspace",
      profilePhotoRequired: true,
      profileComplete: false,
      profileStatus: "pending",
      missingFields: ["displayName", "locationText", "shortDescription", "platforms"],
      missingPlatforms: true,
      completionSteps: [
        "add_display_name",
        "set_location",
        "add_short_description",
        "add_platform",
      ],
      canPublishToDiscovery: false,
      updatedAt: "2026-06-12T08:00:00.000Z",
    };

    expect(status.profileComplete).toBe(false);
    expect(status.canPublishToDiscovery).toBe(false);
    expect(status.missingFields).toContain("platforms");
  });

  it("types the creator self-service document without auth ownership fields", () => {
    const profile: CreatorProfileDocument = {
      creatorProfileId: "creator_profile_lina",
      organizationId: "org_creator_workspace",
      sourceCreatorId: "legacy_creator_lina",
      displayName: "Lina Travels",
      creatorType: "travel",
      locationText: "Vienna, Austria",
      shortDescription: "Independent hotel and slow-travel creator.",
      portfolioUrl: "https://lina.example.com",
      phone: "+431234567",
      profilePictureUrl: "https://cdn.example.com/creators/lina.jpg",
      profileComplete: true,
      profileCompletedAt: "2026-06-12T08:00:00.000Z",
      profileStatus: "active",
      platforms: [
        {
          platformId: "creator_platform_instagram",
          platform: "instagram",
          handle: "@linatravels",
          profileUrl: "https://instagram.com/linatravels",
          followerCount: 24000,
          engagementRate: 4.25,
          audienceCountries: [{ country: "AT", percentage: 35 }],
          audienceAgeGroups: [{ ageRange: "25-34", percentage: 48 }],
          audienceGenderSplit: { male: 31, female: 67, other: 2 },
          verificationStatus: "verified",
        },
      ],
      audienceSize: 24000,
      rating: { averageRating: 4.5, totalReviews: 2 },
      matchingPreferences: null,
      createdAt: "2026-05-01T08:00:00.000Z",
      updatedAt: "2026-06-12T08:00:00.000Z",
    };

    expect(profile.platforms[0].platform).toBe("instagram");
    expect(profile.audienceSize).toBe(24000);
    for (const privateKey of CREATOR_PROFILE_SELF_SERVICE_PRIVATE_KEYS) {
      expect(profile).not.toHaveProperty(privateKey);
    }
  });

  it("types creator profile writes as marketplace-only patches", () => {
    const patch: UpdateCreatorProfileRequest = {
      displayName: "Lina Travels",
      creatorType: "travel",
      locationText: "Vienna, Austria",
      shortDescription: "Independent hotel and slow-travel creator.",
      portfolioUrl: "https://lina.example.com",
      phone: "+431234567",
      profilePictureUrl: "https://cdn.example.com/creators/lina.jpg",
      profilePictureMediaObjectId: "media_creator_profile_lina",
      platforms: [
        {
          platform: "instagram",
          handle: "@linatravels",
          profileUrl: "https://instagram.com/linatravels",
          followerCount: 24000,
          engagementRate: 4.25,
          audienceCountries: [{ country: "AT", percentage: 35 }],
          audienceAgeGroups: [{ ageRange: "25-34", percentage: 48 }],
          audienceGenderSplit: { male: 31, female: 67, other: 2 },
        },
      ],
    };

    expect(patch.platforms?.[0].platform).toBe("instagram");
    expect(patch.profilePictureMediaObjectId).toBe("media_creator_profile_lina");
    expect(patch).not.toHaveProperty("email");
    expect(patch).not.toHaveProperty("ownerUserId");
    expect(patch).not.toHaveProperty("audienceSize");
  });

  it("captures creator profile discovery coherence after writes", () => {
    const updated: CreatorProfileUpdatedEvent = {
      eventType: "marketplace.creator_profile.updated",
      eventId: "evt_creator_profile_updated_001",
      creatorProfileId: "creator_profile_lina",
      organizationId: "org_creator_workspace",
      actorUserId: "user_lina",
      occurredAt: "2026-06-12T08:00:00.000Z",
      discoveryCoherence: {
        mode: "base_tables",
        eligibleForDiscovery: true,
      },
    };

    expect(updated.discoveryCoherence.mode).toBe("base_tables");
    expect(updated.discoveryCoherence.eligibleForDiscovery).toBe(true);
  });

  it("exports the hotel self-service contract version and enums", () => {
    expect(MARKETPLACE_HOTEL_SELF_SERVICE_CONTRACT_VERSION).toBe(
      "marketplace-hotel-self-service.v1",
    );
    expect(MARKETPLACE_HOTEL_AUTHORIZATION_MODES).toContain("organization_resource_link");
    expect(MARKETPLACE_HOTEL_AUTHORIZATION_MODES).toContain("legacy_user_id_fallback");
    expect(MARKETPLACE_HOTEL_PROFILE_STATUSES).toContain("verified");
    expect(MARKETPLACE_OFFER_STATUSES).toContain("archived");
    expect(MARKETPLACE_OFFER_COMPENSATION_TYPES).toContain("free_stay");
    expect(MARKETPLACE_COMPENSATION_TYPES).toContain("custom");
    expect(MARKETPLACE_PLATFORM_NAMES).toContain("instagram");
    expect(MARKETPLACE_HOTEL_MISSING_FIELDS).toContain("hostSummary");
    expect(MARKETPLACE_HOTEL_SELF_SERVICE_ERROR_CODES).toContain("canonical_property_read_only");
    expect(MARKETPLACE_HOTEL_SELF_SERVICE_ERROR_CODES).toContain("id_continuity_violation");
  });

  it("types hotel profile status without exposing legacy ownership fields", () => {
    const status: MarketplaceHotelProfileStatusResponse = {
      contractVersion: MARKETPLACE_HOTEL_SELF_SERVICE_CONTRACT_VERSION,
      authorizationMode: "organization_resource_link",
      propertyId: "property_alpenrose",
      profileComplete: false,
      missingFields: ["hostSummary", "offer"],
      hasDefaults: { location: false },
      missingOffers: true,
      completionSteps: ["Add a marketplace host summary", "Add at least one offer"],
    };

    expect(status.propertyId).toBe("property_alpenrose");
    expect(status).not.toHaveProperty("userId");
    expect(status).not.toHaveProperty("hotelProfileId");
  });

  it("types hotel profile read as catalog facts plus marketplace-owned state", () => {
    const profile: MarketplaceHotelProfileResponse = {
      contractVersion: MARKETPLACE_HOTEL_SELF_SERVICE_CONTRACT_VERSION,
      authorizationMode: "legacy_user_id_fallback",
      property: {
        propertyId: "property_alpenrose",
        publicId: "pub_alpenrose",
        displayName: "Hotel Alpenrose",
        canonicalSlug: "hotel-alpenrose",
        profileStatus: "complete",
        location: {
          displayText: "Zermatt, Switzerland",
          countryCode: "CH",
          city: "Zermatt",
        },
        websiteUrl: "https://alpenrose.example",
        publicPhone: "+41 44 000 0000",
        publicEmail: "stay@alpenrose.example",
        coverImageUrl: "https://cdn.example.com/alpenrose/hero.jpg",
        projectedAt: "2026-06-12T08:00:00.000Z",
      },
      marketplaceProfile: {
        propertyId: "property_alpenrose",
        organizationId: "org_hotel_group_alpenrose",
        marketplaceProfileStatus: "verified",
        profileComplete: true,
        profileCompletedAt: "2026-06-12T08:01:00.000Z",
        hostSummary: "We host creator stays focused on alpine wellness.",
        collaborationGuidelines: "Send preferred months and examples of hotel work.",
        createdAt: "2026-06-12T08:00:00.000Z",
        updatedAt: "2026-06-12T08:01:00.000Z",
      },
      offers: [
        {
          offerId: "legacy_offer_alpenrose",
          propertyId: "property_alpenrose",
          offerStatus: "verified",
          title: "Alpine spa creator stay",
          offerSummary: "Two-night hosted stay for wellness creators.",
          deliverables: [
            {
              deliverableId: "deliverable_alpenrose_reel",
              platform: "instagram",
              deliverableType: "reel",
              quantity: 1,
              timingGuidance: "Publish during the stay.",
            },
          ],
          compensationOptions: [
            {
              compensationOptionId: "compensation_option_alpenrose_free_stay",
              compensationType: "free_stay",
              availabilityMonths: ["2026-09"],
              platforms: ["instagram", "tiktok"],
              freeStayMinNights: 2,
              freeStayMaxNights: 3,
              paidMaxAmount: null,
              discountPercentage: null,
              commissionPercentage: null,
              minFollowers: 10000,
              currency: "EUR",
              termsSummary: "Breakfast included.",
            },
          ],
          creatorRequirements: {
            platforms: ["instagram"],
            targetCountries: ["CH", "DE"],
            targetAgeMin: 25,
            targetAgeMax: 44,
            targetAgeGroups: ["25-34", "35-44"],
            creatorTypes: ["travel", "lifestyle"],
          },
          matchingCriteria: null,
          createdAt: "2026-06-12T08:02:00.000Z",
          updatedAt: "2026-06-12T08:03:00.000Z",
        },
      ],
    };

    expect(profile.property.displayName).toBe("Hotel Alpenrose");
    expect(profile.marketplaceProfile.hostSummary).toContain("alpine wellness");
    expect(profile.offers[0].offerId).toBe("legacy_offer_alpenrose");
    expect(profile).not.toHaveProperty("userId");
    expect(profile.offers[0]).not.toHaveProperty("offerResourceId");
    expect(profile.offers[0]).not.toHaveProperty("rawLocationText");
  });

  it("profile update accepts only marketplace-owned fields", () => {
    const update: UpdateMarketplaceHotelProfileRequest = {
      hostSummary: "Updated host summary.",
      collaborationGuidelines: null,
    };

    expect(update.hostSummary).toBe("Updated host summary.");

    const _withCatalogName: UpdateMarketplaceHotelProfileRequest = {
      ...update,
      // @ts-expect-error — canonical property name belongs to hotel catalog.
      name: "Renamed Hotel",
    };
    void _withCatalogName;
  });

  it("offer create requires stable external offer fields and target-schema enums", () => {
    const createOffer: CreateMarketplaceOfferRequest = {
      title: "Alpine spa creator stay",
      offerSummary: "Two-night hosted stay for wellness creators.",
      deliverables: [
        {
          platform: "instagram",
          deliverableType: "reel",
          quantity: 1,
          timingGuidance: null,
        },
      ],
      compensationOptions: [
        {
          compensationType: "paid",
          availabilityMonths: ["2026-09"],
          platforms: ["instagram"],
          freeStayMinNights: null,
          freeStayMaxNights: null,
          paidMaxAmount: "1200.00",
          discountPercentage: null,
          commissionPercentage: null,
          minFollowers: null,
          currency: "EUR",
          termsSummary: null,
        },
      ],
      creatorRequirements: {
        platforms: ["instagram"],
        targetCountries: ["CH"],
        targetAgeMin: 25,
        targetAgeMax: 34,
        targetAgeGroups: ["25-34"],
        creatorTypes: ["travel"],
      },
    };

    expect(createOffer.deliverables[0].deliverableType).toBe("reel");
    expect(createOffer.compensationOptions[0].paidMaxAmount).toBe("1200.00");
    expect(createOffer.creatorRequirements.creatorTypes).toEqual(["travel"]);
  });

  it("separates public offer IDs from internal offer authorization resource IDs", () => {
    const target: MarketplaceOfferAuthorizationTarget = {
      offerId: "legacy_offer_alpenrose",
      offerResourceId: "f7969000-0000-0000-0000-000000000111",
      propertyId: "property_alpenrose",
      organizationId: "org_hotel_group_alpenrose",
    };

    expect(target.offerId).toBe("legacy_offer_alpenrose");
    expect(target.offerResourceId).not.toBe(target.offerId);
  });

  it("exports the affiliate contract version", () => {
    expect(MARKETPLACE_AFFILIATE_CONTRACT_VERSION).toBe("marketplace-affiliate.v1");
  });

  it("exports collaboration statuses including accepted", () => {
    expect(COLLABORATION_STATUSES).toContain("accepted");
    expect(COLLABORATION_STATUSES).toContain("pending");
    expect(COLLABORATION_STATUSES).toContain("negotiating");
    expect(COLLABORATION_STATUSES).toContain("declined");
    expect(COLLABORATION_STATUSES).toContain("completed");
  });

  it("exports the collaboration reads contract and endpoint paths", () => {
    expect(MARKETPLACE_COLLABORATION_READS_CONTRACT_VERSION).toBe(
      "marketplace-collaboration-reads.v1",
    );
    expect(MARKETPLACE_COLLABORATION_READ_ENDPOINTS.myCollaborations).toMatchObject({
      method: "GET",
      path: "/api/marketplace/collaborations/me",
    });
    expect(MARKETPLACE_COLLABORATION_READ_ENDPOINTS.conversations).toMatchObject({
      method: "GET",
      path: "/api/marketplace/collaborations/conversations",
    });
    expect(MARKETPLACE_COLLABORATION_READ_ENDPOINTS.messages.path).toContain("{collaborationId}");
    expect(MARKETPLACE_COLLABORATION_AUTHORIZATION_SIDES).toEqual(["creator", "hotel"]);
    expect(MARKETPLACE_COLLABORATION_READ_ERROR_CODES).toContain("missing_creator_resource_link");
    expect(MARKETPLACE_COLLABORATION_READ_ERROR_CODES).toContain("missing_hotel_resource_link");
  });

  it("documents both-side collaboration read authorization through resource links", () => {
    expect(MARKETPLACE_COLLABORATION_CREATOR_READ_POLICY).toEqual({
      permission: "marketplace.collaboration.read",
      side: "creator",
      selectedOrganizationKind: "creator_workspace",
      requiredResources: [
        {
          product: "marketplace",
          resourceType: "creator_profile",
          relationship: "owner",
        },
      ],
    });
    expect(MARKETPLACE_COLLABORATION_HOTEL_READ_POLICY).toEqual({
      permission: "marketplace.collaboration.read",
      side: "hotel",
      selectedOrganizationKind: "hotel_group",
      requiredResources: [
        {
          product: "marketplace",
          resourceType: "hotel_profile",
          relationship: "owner",
        },
        {
          product: "marketplace",
          resourceType: "marketplace_offer",
          relationship: "operator",
        },
      ],
    });
  });

  it("types collaboration reads and chat without leaking identity or PMS internals", () => {
    const list: MarketplaceCollaborationListResponse = {
      contractVersion: MARKETPLACE_COLLABORATION_READS_CONTRACT_VERSION,
      authorizationMode: "creator_workspace_resource_link",
      items: [
        {
          contractVersion: MARKETPLACE_COLLABORATION_READS_CONTRACT_VERSION,
          authorizationMode: "creator_workspace_resource_link",
          collaborationId: "collab_688",
          offerId: "legacy_offer_688",
          creatorId: "legacy_creator_lina",
          hotelProfileId: "hotel_profile_alpenrose",
          side: "creator",
          initiatorSide: "creator",
          isInitiator: true,
          status: "accepted",
          compensationType: null,
          offerTitle: "Alpine creator stay",
          hotelLocation: "Innsbruck, Austria",
          creator: {
            side: "creator",
            organizationId: "org_creator_lina",
            profileId: "creator_profile_lina",
            displayName: "Lina Travels",
            avatarUrl: "https://cdn.example.com/lina.jpg",
            location: "Berlin, Germany",
            portfolioUrl: "https://lina.example.com",
            creatorType: "travel",
            platforms: [],
          },
          hotel: {
            side: "hotel",
            organizationId: "org_hotel_alpenrose",
            profileId: "hotel_profile_alpenrose",
            displayName: "Hotel Alpenrose",
            avatarUrl: null,
          },
          terms: {
            freeStayMinNights: null,
            freeStayMaxNights: null,
            paidAmount: null,
            currency: "EUR",
            discountPercentage: null,
            affiliateEnabled: true,
            affiliateCommissionPercentage: null,
            travelDateFrom: "2026-09-10",
            travelDateTo: "2026-09-12",
            preferredDateFrom: null,
            preferredDateTo: null,
            preferredMonths: ["2026-09"],
          },
          deliverables: [
            {
              deliverableId: "deliverable_reel",
              platform: "instagram",
              type: "reel",
              quantity: 1,
              status: "pending",
              completedAt: null,
            },
          ],
          lastMessageAt: "2026-06-12T09:15:00.000Z",
          createdAt: "2026-06-12T09:00:00.000Z",
          updatedAt: "2026-06-12T09:10:00.000Z",
        },
      ],
    };
    const conversations: MarketplaceConversationSummary[] = [
      {
        contractVersion: MARKETPLACE_COLLABORATION_READS_CONTRACT_VERSION,
        collaborationId: "collab_688",
        side: "creator",
        partnerName: "Hotel Alpenrose",
        partnerAvatarUrl: null,
        offerTitle: "Alpine creator stay",
        collaborationStatus: "accepted",
        lastMessageContent: "We confirmed the September dates.",
        lastMessageAt: "2026-06-12T09:15:00.000Z",
        unreadCount: 0,
      },
    ];
    const messages: MarketplaceCollaborationMessagesResponse = {
      contractVersion: MARKETPLACE_COLLABORATION_READS_CONTRACT_VERSION,
      collaborationId: "collab_688",
      authorizationMode: "creator_workspace_resource_link",
      items: [
        {
          contractVersion: MARKETPLACE_COLLABORATION_READS_CONTRACT_VERSION,
          messageId: "msg_001",
          collaborationId: "collab_688",
          senderUserId: null,
          senderName: "Hotel Alpenrose",
          senderAvatarUrl: null,
          senderSide: "hotel",
          content: "We confirmed the September dates.",
          contentType: "text",
          metadata: null,
          createdAt: "2026-06-12T09:15:00.000Z",
        },
      ],
    };

    expect(list.items[0].offerId).toBe("legacy_offer_688");
    expect(conversations[0].partnerName).toBe("Hotel Alpenrose");
    expect(messages.items[0].contentType).toBe("text");
    const serialized = JSON.stringify({ list, conversations, messages });
    for (const privateKey of MARKETPLACE_COLLABORATION_READ_PRIVATE_KEYS) {
      expect(serialized).not.toContain(privateKey);
    }
  });

  it("keeps the V4 collaboration read fixtures focused on both-side authorization", () => {
    const fixture = JSON.parse(
      readFileSync(
        new URL(
          "../../../engineering/fixtures/marketplace-collaboration-reads/cases.json",
          import.meta.url,
        ),
        "utf8",
      ),
    ) as {
      contractVersion: string;
      cases: Array<{
        caseId: string;
        request: { side?: string; auth?: { organizationKind?: string } };
        expected: { status: number; errorCode?: string; authorizationMode?: string };
      }>;
    };

    expect(fixture.contractVersion).toBe(MARKETPLACE_COLLABORATION_READS_CONTRACT_VERSION);
    expect(fixture.cases.map((entry) => entry.caseId)).toEqual(
      expect.arrayContaining([
        "creator-collaborations-linked-resource",
        "hotel-conversations-linked-resources",
        "messages-deny-missing-creator-link",
        "messages-deny-missing-hotel-offer-link",
        "collaboration-deny-wrong-side-org",
      ]),
    );
    expect(
      fixture.cases.some(
        (entry) =>
          entry.request.side === "creator" &&
          entry.request.auth?.organizationKind === "creator_workspace" &&
          entry.expected.status === 200,
      ),
    ).toBe(true);
    expect(
      fixture.cases.some(
        (entry) =>
          entry.request.side === "hotel" &&
          entry.request.auth?.organizationKind === "hotel_group" &&
          entry.expected.status === 200,
      ),
    ).toBe(true);
    expect(fixture.cases.map((entry) => entry.expected.errorCode).filter(Boolean)).toEqual(
      expect.arrayContaining([
        "missing_creator_resource_link",
        "missing_hotel_resource_link",
        "forbidden",
      ]),
    );
  });

  it("exports the collaboration lifecycle write contract, policies, and endpoints", () => {
    expect(MARKETPLACE_COLLABORATION_LIFECYCLE_WRITES_CONTRACT_VERSION).toBe(
      "marketplace-collaboration-lifecycle-writes.v1",
    );
    expect(MARKETPLACE_COLLABORATION_LIFECYCLE_WRITE_ENDPOINTS.create).toMatchObject({
      method: "POST",
      path: "/api/marketplace/collaborations",
    });
    expect(MARKETPLACE_COLLABORATION_LIFECYCLE_WRITE_ENDPOINTS.respond.path).toContain(
      "{collaborationId}/respond",
    );
    expect(MARKETPLACE_COLLABORATION_LIFECYCLE_WRITE_ENDPOINTS.approveTerms.path).toContain(
      "{collaborationId}/approve",
    );
    expect(MARKETPLACE_COLLABORATION_LIFECYCLE_WRITE_ACTIONS).toEqual(
      expect.arrayContaining([
        "create",
        "respond",
        "update_terms",
        "approve_terms",
        "cancel",
        "toggle_deliverable",
        "rate_creator",
      ]),
    );
    expect(MARKETPLACE_COLLABORATION_LIFECYCLE_WRITE_ERROR_CODES).toContain("idempotency_conflict");
    expect(MARKETPLACE_COLLABORATION_LIFECYCLE_WRITE_ERROR_CODES).toContain("invalid_transition");
    expect(MARKETPLACE_COLLABORATION_CREATOR_WRITE_POLICY).toMatchObject({
      permission: "marketplace.collaboration.write",
      side: "creator",
      selectedOrganizationKind: "creator_workspace",
    });
    expect(MARKETPLACE_COLLABORATION_CREATOR_WRITE_POLICY.requiredResources).toEqual([
      expect.objectContaining({ resourceType: "creator_profile", relationship: "owner" }),
    ]);
    expect(MARKETPLACE_COLLABORATION_HOTEL_WRITE_POLICY).toMatchObject({
      permission: "marketplace.collaboration.write",
      side: "hotel",
      selectedOrganizationKind: "hotel_group",
    });
    expect(MARKETPLACE_COLLABORATION_HOTEL_WRITE_POLICY.requiredResources).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ resourceType: "hotel_profile", relationship: "owner" }),
        expect.objectContaining({ resourceType: "marketplace_offer", relationship: "operator" }),
      ]),
    );
  });

  it("types collaboration lifecycle side effects without exposing downstream internals", () => {
    const sideEffects: MarketplaceCollaborationLifecycleSideEffect[] = [
      { type: "marketplace.collaboration.accepted" },
      {
        type: "marketplace.affiliate.provision.command_requested",
        idempotencyKey: buildAffiliateProvisioningIdempotencyKey({
          collaborationId: "collab_688",
        }),
      },
    ];

    expect(sideEffects[1]).toMatchObject({
      type: "marketplace.affiliate.provision.command_requested",
      idempotencyKey: "marketplace.affiliate.provision:collaboration:collab_688:v1",
    });
    const serialized = JSON.stringify(sideEffects);
    for (const privateKey of MARKETPLACE_COLLABORATION_LIFECYCLE_WRITE_PRIVATE_KEYS) {
      expect(serialized).not.toContain(privateKey);
    }
  });

  it("keeps the V4 collaboration lifecycle write fixtures focused on writes and denials", () => {
    const fixture = JSON.parse(
      readFileSync(
        new URL(
          "../../../engineering/fixtures/marketplace-collaboration-lifecycle-writes/cases.json",
          import.meta.url,
        ),
        "utf8",
      ),
    ) as {
      contractVersion: string;
      readContractVersion: string;
      authContexts: Record<string, { organizationKind: string }>;
      cases: Array<{
        caseId: string;
        request: {
          action?: string;
          side?: string;
          idempotencyKey?: string;
          authRef?: string;
        };
        expected: {
          status: number;
          errorCode?: string;
          collaborationStatus?: string;
          ratingId?: string;
          idempotencyBehavior?: "replay" | "conflict";
          replayOf?: string;
          sideEffects?: string[];
          affiliateProvisioningIdempotencyKey?: string;
          sideEffectMetadata?: {
            affiliateProvisioning?: {
              idempotencyKey?: string;
              commandId?: string;
              emitted?: boolean;
              emittedOncePerLifecycleKey?: boolean;
              replayedFromLifecycleKey?: string;
              blockedBy?: string;
            };
          };
          mustNotWrite?: string[];
        };
      }>;
    };

    expect(fixture.contractVersion).toBe(
      MARKETPLACE_COLLABORATION_LIFECYCLE_WRITES_CONTRACT_VERSION,
    );
    expect(fixture.readContractVersion).toBe(MARKETPLACE_COLLABORATION_READS_CONTRACT_VERSION);
    const caseIds = fixture.cases.map((entry) => entry.caseId);
    const fixtureActions = [...new Set(fixture.cases.map((entry) => entry.request.action))].sort();
    expect(fixtureActions).toEqual([...MARKETPLACE_COLLABORATION_LIFECYCLE_WRITE_ACTIONS].sort());
    for (const action of MARKETPLACE_COLLABORATION_LIFECYCLE_WRITE_ACTIONS) {
      const actionCases = fixture.cases.filter((entry) => entry.request.action === action);
      expect(
        actionCases.some((entry) => entry.expected.status >= 200 && entry.expected.status < 300),
      ).toBe(true);
      expect(actionCases.some((entry) => entry.expected.status >= 400)).toBe(true);
      expect(actionCases.some((entry) => entry.expected.idempotencyBehavior === "replay")).toBe(
        true,
      );
      expect(actionCases.some((entry) => entry.expected.idempotencyBehavior === "conflict")).toBe(
        true,
      );
    }
    expect(caseIds).toContain("creator-create-collaboration-linked-resource");
    expect(caseIds).toContain("hotel-create-invitation-linked-offer-resource");
    expect(caseIds).toContain("approve-accepted-emits-affiliate-provisioning-command");
    expect(caseIds).toContain("approve-deny-invalid-transition");
    expect(fixture.cases.every((entry) => entry.request.idempotencyKey?.endsWith(":v1"))).toBe(
      true,
    );
    expect(
      fixture.cases.some(
        (entry) =>
          entry.request.side === "creator" &&
          entry.request.authRef &&
          fixture.authContexts[entry.request.authRef]?.organizationKind === "creator_workspace" &&
          entry.expected.status === 201,
      ),
    ).toBe(true);
    expect(
      fixture.cases.some(
        (entry) =>
          entry.request.side === "hotel" &&
          entry.request.authRef &&
          fixture.authContexts[entry.request.authRef]?.organizationKind === "hotel_group" &&
          entry.expected.status === 201,
      ),
    ).toBe(true);
    expect(fixture.cases.map((entry) => entry.expected.errorCode).filter(Boolean)).toEqual(
      expect.arrayContaining(["forbidden", "missing_hotel_resource_link", "invalid_transition"]),
    );
    expect(
      fixture.cases.find(
        (entry) => entry.caseId === "approve-accepted-emits-affiliate-provisioning-command",
      )?.expected.affiliateProvisioningIdempotencyKey,
    ).toBe("marketplace.affiliate.provision:collaboration:collab_688:v1");
    expect(
      fixture.cases.find(
        (entry) =>
          entry.caseId === "approve-idempotency-replay-preserves-affiliate-provisioning-command",
      )?.expected.sideEffectMetadata?.affiliateProvisioning,
    ).toMatchObject({
      idempotencyKey: "marketplace.affiliate.provision:collaboration:collab_688:v1",
      commandId: "cmd:marketplace.affiliate.provision:collaboration:collab_688:v1",
      emitted: true,
      emittedOncePerLifecycleKey: true,
      replayedFromLifecycleKey: "marketplace.collaboration.approve_terms:collab_688:nonce:v1",
    });
    expect(
      fixture.cases.find(
        (entry) => entry.caseId === "approve-idempotency-conflict-does-not-provision-affiliate",
      )?.expected.sideEffectMetadata?.affiliateProvisioning,
    ).toMatchObject({
      emitted: false,
      blockedBy: "idempotency_conflict",
    });
    expect(
      fixture.cases.find(
        (entry) => entry.caseId === "approve-idempotency-conflict-does-not-provision-affiliate",
      )?.expected.sideEffects,
    ).toEqual([]);
    expect(
      fixture.cases.find((entry) => entry.caseId === "rate-creator-success-completed-collaboration")
        ?.expected.ratingId,
    ).toBe("rating_collab_completed_001");
    expect(
      fixture.cases.find(
        (entry) => entry.caseId === "rate-creator-idempotency-replay-returns-original-rating",
      )?.expected.ratingId,
    ).toBe("rating_collab_completed_001");
    expect(
      fixture.cases
        .flatMap((entry) => entry.expected.mustNotWrite ?? [])
        .filter(
          (target) => target === "pms.*" || target === "finance.*" || target === "affiliate.*",
        ),
    ).toEqual(expect.arrayContaining(["pms.*", "finance.*", "affiliate.*"]));
  });

  it("exports affiliate provisioning statuses", () => {
    expect(AFFILIATE_PROVISIONING_STATUSES).toContain("provisioned");
    expect(AFFILIATE_PROVISIONING_STATUSES).toContain("already_exists");
    expect(AFFILIATE_PROVISIONING_STATUSES).toContain("failed");
  });

  it("exports affiliate provisioning error codes", () => {
    expect(AFFILIATE_PROVISIONING_ERROR_CODES).toContain("HOTEL_NOT_FOUND");
    expect(AFFILIATE_PROVISIONING_ERROR_CODES).toContain("DUPLICATE_AFFILIATE");
    expect(AFFILIATE_PROVISIONING_ERROR_CODES).toContain("RETRYABLE_DOWNSTREAM_FAILURE");
    expect(AFFILIATE_PROVISIONING_ERROR_CODES).toContain("IDEMPOTENCY_CONFLICT");
  });

  it("buildAffiliateProvisioningIdempotencyKey produces a stable key", () => {
    const key = buildAffiliateProvisioningIdempotencyKey({
      collaborationId: "collab_abc123",
    });
    expect(key).toBe("marketplace.affiliate.provision:collaboration:collab_abc123:v1");
    // Calling again with the same input produces the same key (idempotent)
    expect(buildAffiliateProvisioningIdempotencyKey({ collaborationId: "collab_abc123" })).toBe(
      key,
    );
  });

  it("buildAffiliateProvisioningIdempotencyKey uses the collaborationId as the scope", () => {
    const key1 = buildAffiliateProvisioningIdempotencyKey({ collaborationId: "collab_1" });
    const key2 = buildAffiliateProvisioningIdempotencyKey({ collaborationId: "collab_2" });
    expect(key1).not.toBe(key2);
  });

  it("allows an implementation of CollaborationAffiliatePort to be typed correctly", async () => {
    const command: ProvisionCollaborationAffiliateCommand = {
      contractVersion: MARKETPLACE_AFFILIATE_CONTRACT_VERSION,
      commandId: "cmd_test_001",
      idempotencyKey: buildAffiliateProvisioningIdempotencyKey({
        collaborationId: "collab_test_001",
      }),
      audit: {
        requestId: "req_001",
        correlationId: "corr_001",
        organizationId: "org_hotel_001",
        creatorOrganizationId: "org_creator_001",
        actorType: "creator",
        actorId: "creator_001",
        source: "marketplace_web",
        occurredAt: "2026-06-07T10:00:00.000Z",
      },
      collaboration: {
        collaborationId: "collab_test_001",
        status: "accepted",
        acceptedAt: "2026-06-07T10:00:00.000Z",
      },
      creator: {
        creatorId: "creator_001",
        creatorName: "Ada Lovelace",
        creatorEmail: "ada@example.com",
        socialMediaSummary: "Instagram: @ada",
      },
      hotel: {
        marketplaceHotelProfileId: "mhp_001",
        organizationId: "org_hotel_001",
      },
      commissionTerms: {
        commissionPct: "5.00",
        currency: null,
      },
    };

    // Fake implementation of the port — Finance/affiliate domain owns this
    const fakePort: CollaborationAffiliatePort = {
      async provisionAffiliate(
        cmd: ProvisionCollaborationAffiliateCommand,
      ): Promise<AffiliateProvisioningResult> {
        return {
          contractVersion: MARKETPLACE_AFFILIATE_CONTRACT_VERSION,
          commandId: cmd.commandId,
          idempotencyKey: cmd.idempotencyKey,
          collaborationId: cmd.collaboration.collaborationId,
          status: "provisioned",
          referralOutput: {
            affiliateId: "aff_001",
            referralCode: "aB3xQ1yZ",
            referralLink: "https://stay.example.com/hotel-slug?ref=aB3xQ1yZ",
            provisionedAt: "2026-06-07T10:00:01.000Z",
          },
        };
      },
    };

    const result = await fakePort.provisionAffiliate(command);

    expect(result.status).toBe("provisioned");
    expect(result.contractVersion).toBe(MARKETPLACE_AFFILIATE_CONTRACT_VERSION);
    expect(result.commandId).toBe("cmd_test_001");
    expect(result.collaborationId).toBe("collab_test_001");

    if (result.status === "provisioned" || result.status === "already_exists") {
      expect(result.referralOutput.referralCode).toBe("aB3xQ1yZ");
      expect(result.referralOutput.referralLink).toContain("aB3xQ1yZ");
    }
  });

  it("allows a failed provisioning result to carry an error without referralOutput", () => {
    const failedResult: AffiliateProvisioningResult = {
      contractVersion: MARKETPLACE_AFFILIATE_CONTRACT_VERSION,
      commandId: "cmd_fail_001",
      idempotencyKey: "marketplace.affiliate.provision:collaboration:collab_fail_001:v1",
      collaborationId: "collab_fail_001",
      status: "failed",
      error: {
        code: "HOTEL_NOT_FOUND",
        retryable: false,
        sanitizedMessage: "No property found for the given hotel profile.",
      },
    };

    expect(failedResult.status).toBe("failed");
    // Type guard: referralOutput is undefined on failed results
    expect(failedResult.referralOutput).toBeUndefined();
    expect(failedResult.error.code).toBe("HOTEL_NOT_FOUND");
    expect(failedResult.error.retryable).toBe(false);
  });

  it("command must not carry PMS raw table references or cross-DB connection fields", () => {
    // NOTE: This is a structural documentation test, not runtime enforcement.
    // Runtime enforcement of the import boundary is handled by
    // scripts/check-architecture-boundaries.mjs (Marketplace domain check).
    // This test verifies that the ProvisionCollaborationAffiliateCommand type
    // contains no fields that would indicate cross-DB access. It passes as long
    // as the contract compiles without a pmsHotelId or PMS connection field.
    const command: ProvisionCollaborationAffiliateCommand = {
      contractVersion: MARKETPLACE_AFFILIATE_CONTRACT_VERSION,
      commandId: "cmd_boundary_001",
      idempotencyKey: "marketplace.affiliate.provision:collaboration:collab_bnd_001:v1",
      audit: {
        requestId: "req_bnd",
        correlationId: "corr_bnd",
        organizationId: "org_hotel_bnd",
        creatorOrganizationId: "org_creator_bnd",
        actorType: "system",
        source: "job_retry",
        occurredAt: "2026-06-07T12:00:00.000Z",
      },
      collaboration: {
        collaborationId: "collab_bnd_001",
        status: "accepted",
        acceptedAt: "2026-06-07T12:00:00.000Z",
      },
      creator: {
        creatorId: "creator_bnd",
        creatorName: null,
        creatorEmail: null,
      },
      hotel: {
        // Only Marketplace-owned IDs — no pmsHotelId or raw DB reference
        marketplaceHotelProfileId: "mhp_bnd",
        organizationId: "org_hotel_bnd",
      },
      commissionTerms: {
        commissionPct: "5.00",
      },
    };

    expect(command.hotel).not.toHaveProperty("pmsHotelId");
    expect(command.hotel).not.toHaveProperty("pmsDatabase");
    expect(command.hotel.marketplaceHotelProfileId).toBe("mhp_bnd");
    expect(command.hotel.organizationId).toBe("org_hotel_bnd");

    // Compile-time guards: the type must not accept pmsHotelId or pmsDatabase.
    const _withPmsHotelId: ProvisionCollaborationAffiliateCommand = {
      ...command,
      // @ts-expect-error — pmsHotelId must not exist on AffiliateHotelReference
      hotel: { ...command.hotel, pmsHotelId: "pms_001" },
    };
    const _withPmsDatabase: ProvisionCollaborationAffiliateCommand = {
      ...command,
      // @ts-expect-error — pmsDatabase must not exist on AffiliateHotelReference
      hotel: { ...command.hotel, pmsDatabase: "pms_db_url" },
    };
    void _withPmsHotelId;
    void _withPmsDatabase;
  });

  it("buildAffiliateProvisioningCommandId derives a stable commandId from an idempotencyKey", () => {
    const idempotencyKey = buildAffiliateProvisioningIdempotencyKey({
      collaborationId: "collab_cmd_001",
    });
    const commandId = buildAffiliateProvisioningCommandId({ idempotencyKey });
    expect(commandId).toBe(`cmd:${idempotencyKey}`);
    // Calling again with the same idempotencyKey produces the same commandId
    expect(buildAffiliateProvisioningCommandId({ idempotencyKey })).toBe(commandId);
  });

  it("CollaborationAcceptedEvent does not carry referralOutput (immutable acceptance snapshot)", () => {
    // Domain events must be immutable snapshots. Provisioning output belongs on
    // AffiliateProvisionedEvent, not on the acceptance event.
    const accepted: CollaborationAcceptedEvent = {
      eventType: "marketplace.collaboration.accepted" as const,
      eventId: "evt_accepted_001",
      collaborationId: "collab_001",
      creatorId: "creator_001",
      marketplaceHotelProfileId: "mhp_001",
      organizationId: "org_001",
      acceptedAt: "2026-06-07T10:00:00.000Z",
      affiliateProvisioningRequested: true,
      audit: {
        requestId: "req_001",
        correlationId: "corr_001",
        organizationId: "org_001",
        creatorOrganizationId: "org_creator_001",
        actorType: "system" as const,
        source: "job_retry" as const,
        occurredAt: "2026-06-07T10:00:00.000Z",
      },
    };
    expect(accepted).not.toHaveProperty("referralOutput");
  });

  it("AffiliateProvisionedEvent carries referralOutput as an immutable provisioning snapshot", () => {
    const provisioned: AffiliateProvisionedEvent = {
      eventType: "marketplace.affiliate.provisioned",
      eventId: "evt_provisioned_001",
      causationId: "cmd:marketplace.affiliate.provision:collaboration:collab_001:v1",
      collaborationId: "collab_001",
      idempotencyKey: "marketplace.affiliate.provision:collaboration:collab_001:v1",
      referralOutput: {
        affiliateId: "aff_001",
        referralCode: "aB3xQ1yZ",
        referralLink: "https://stay.example.com/hotel?ref=aB3xQ1yZ",
        provisionedAt: "2026-06-07T10:00:01.000Z",
      },
      audit: {
        requestId: "req_001",
        correlationId: "corr_001",
        organizationId: "org_001",
        creatorOrganizationId: "org_creator_001",
        actorType: "system",
        source: "job_retry",
        occurredAt: "2026-06-07T10:00:01.000Z",
      },
    };
    expect(provisioned.referralOutput.referralCode).toBe("aB3xQ1yZ");
    expect(provisioned.eventType).toBe("marketplace.affiliate.provisioned");
  });
});
