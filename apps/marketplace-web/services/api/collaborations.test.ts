import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  createMarketplaceCollaboration: vi.fn(),
  getMarketplaceCollaboration: vi.fn(),
  getMarketplaceConversationPage: vi.fn(),
  sendMarketplaceCollaborationMessage: vi.fn(),
  markMarketplaceCollaborationMessagesRead: vi.fn(),
  uploadPlatformMedia: vi.fn(),
}));

vi.mock("@vayada/marketplace-shared/api/collaborations", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@vayada/marketplace-shared/api/collaborations")>();
  return {
    ...actual,
    createMarketplaceCollaboration: mocks.createMarketplaceCollaboration,
    getMarketplaceCollaboration: mocks.getMarketplaceCollaboration,
    getMarketplaceConversationPage: mocks.getMarketplaceConversationPage,
    sendMarketplaceCollaborationMessage: mocks.sendMarketplaceCollaborationMessage,
    markMarketplaceCollaborationMessagesRead: mocks.markMarketplaceCollaborationMessagesRead,
  };
});

vi.mock("@vayada/marketplace-shared/api/platformMedia", () => ({
  uploadPlatformMedia: mocks.uploadPlatformMedia,
}));

vi.mock("@/lib/utils", () => ({
  buildQueryString: () => "",
}));

import { toLegacyCollaborationType } from "@vayada/marketplace-shared/api/collaborations";
import {
  collaborationService,
  filterConversations,
  isMessageFromCurrentUser,
  readChatCollaborationId,
  type ConversationResponse,
  type MessageResponse,
} from "./collaborations";

beforeEach(() => {
  mocks.createMarketplaceCollaboration.mockReset();
  mocks.getMarketplaceCollaboration.mockReset();
  mocks.getMarketplaceConversationPage.mockReset();
  mocks.sendMarketplaceCollaborationMessage.mockReset();
  mocks.markMarketplaceCollaborationMessagesRead.mockReset();
  mocks.uploadPlatformMedia.mockReset();
});

describe("toLegacyCollaborationType", () => {
  it("preserves primary compensation when affiliate terms are additive", () => {
    expect(toLegacyCollaborationType("free_stay", true, "12.5")).toBe("Free Stay");
  });

  it("uses Affiliate only for complete affiliate-only terms", () => {
    expect(toLegacyCollaborationType(null, true, "12.5")).toBe("Affiliate");
    expect(toLegacyCollaborationType("free_stay", true, null)).toBe("Free Stay");
    expect(toLegacyCollaborationType(null, true, null)).toBeNull();
  });
});

describe("collaborationService.create", () => {
  it("sends the selected compensation option and never treats the account user as creator ID", async () => {
    mocks.createMarketplaceCollaboration.mockResolvedValue(lifecycleWriteResponse());

    await collaborationService.create(
      {
        initiator_type: "creator",
        listing_id: "offer-001",
        compensation_option_id: "compensation-paid-001",
        collaboration_type: "Paid",
        paid_amount: 450,
        currency: "EUR",
        why_great_fit: "My audience is a strong fit for this city hotel.",
        consent: true,
        platform_deliverables: [
          {
            platform: "Instagram",
            deliverables: [{ type: "Reel", quantity: 1 }],
          },
        ],
      },
      { idempotencyKey: "marketplace.collaboration.create:offer-001:form-retry:v1" },
    );

    expect(mocks.createMarketplaceCollaboration).toHaveBeenCalledWith(
      expect.objectContaining({
        offerId: "offer-001",
        idempotencyKey: "marketplace.collaboration.create:offer-001:form-retry:v1",
        compensationOptionId: "compensation-paid-001",
        terms: expect.objectContaining({
          compensationType: "paid",
          paidAmount: "450",
          currency: "EUR",
        }),
      }),
    );
    expect(mocks.createMarketplaceCollaboration.mock.calls[0]?.[0]).not.toHaveProperty("creatorId");
    expect(mocks.createMarketplaceCollaboration.mock.calls[0]?.[0]).not.toHaveProperty("side");
    expect(mocks.createMarketplaceCollaboration.mock.calls[0]?.[0]).not.toHaveProperty(
      "initiatorSide",
    );
  });

  it("preserves creator application facts and public creator statistics in details", async () => {
    const collaboration = lifecycleWriteResponse().collaboration;
    mocks.getMarketplaceCollaboration.mockResolvedValue({
      ...collaboration,
      applicationMessage: "My audience is a strong match.",
      creatorConsent: true,
      creatorAgreedAt: "2026-07-22T08:05:00.000Z",
      creator: {
        ...collaboration.creator,
        location: "Berlin, Germany",
        portfolioUrl: "https://ari.example.com",
        creatorType: "travel",
        platforms: [
          {
            platform: "instagram",
            handle: "@ari",
            profileUrl: "https://instagram.com/ari",
            followerCount: 25_000,
            engagementRate: 4.2,
            audienceCountries: [{ country: "Germany", percentage: 60 }],
            audienceAgeGroups: [{ ageRange: "25-34", percentage: 50 }],
            audienceGenderSplit: { male: 35, female: 65 },
            verificationStatus: "verified",
          },
        ],
      },
    });

    await expect(
      collaborationService.getCreatorCollaborationDetails("collaboration-001"),
    ).resolves.toMatchObject({
      why_great_fit: "My audience is a strong match.",
      consent: true,
      creator_agreed_at: "2026-07-22T08:05:00.000Z",
      creator_location: "Berlin, Germany",
      creator_portfolio_link: "https://ari.example.com",
      total_followers: 25_000,
      avg_engagement_rate: 4.2,
      platforms: [
        expect.objectContaining({
          name: "instagram",
          handle: "@ari",
          profile_url: "https://instagram.com/ari",
        }),
      ],
    });
  });
});

describe("creator chat integration", () => {
  it("collects every cursor page so conversations beyond the first 100 stay searchable", async () => {
    mocks.getMarketplaceConversationPage
      .mockResolvedValueOnce({
        contractVersion: "marketplace-collaboration-reads.v1",
        items: [marketplaceConversation("collaboration-1")],
        nextCursor: "page-2",
        hasMore: true,
      })
      .mockResolvedValueOnce({
        contractVersion: "marketplace-collaboration-reads.v1",
        items: [marketplaceConversation("collaboration-101")],
        nextCursor: null,
        hasMore: false,
      });

    await expect(collaborationService.getConversations()).resolves.toEqual([
      expect.objectContaining({ collaboration_id: "collaboration-1" }),
      expect.objectContaining({ collaboration_id: "collaboration-101" }),
    ]);
    expect(mocks.getMarketplaceConversationPage).toHaveBeenNthCalledWith(1, {
      cursor: undefined,
      limit: 100,
    });
    expect(mocks.getMarketplaceConversationPage).toHaveBeenNthCalledWith(2, {
      cursor: "page-2",
      limit: 100,
    });
  });

  it("sends retry-safe text messages through the TypeScript contract", async () => {
    mocks.sendMarketplaceCollaborationMessage.mockResolvedValue({
      contractVersion: "marketplace-collaboration-reads.v1",
      messageId: "message-1",
      collaborationId: "collaboration-1",
      senderUserId: "creator-user-1",
      senderName: "Creator",
      senderAvatarUrl: null,
      senderSide: "creator",
      content: "Hello from the creator",
      contentType: "text",
      metadata: null,
      createdAt: "2026-07-22T08:00:00.000Z",
    });
    const idempotencyKey = "marketplace.collaboration.message:collaboration-1:retry-1:v1";

    await expect(
      collaborationService.sendMessage("collaboration-1", "Hello from the creator", idempotencyKey),
    ).resolves.toMatchObject({
      id: "message-1",
      sender_side: "creator",
      content: "Hello from the creator",
    });
    expect(mocks.sendMarketplaceCollaborationMessage).toHaveBeenCalledWith("collaboration-1", {
      content: "Hello from the creator",
      idempotencyKey,
    });
  });

  it("marks messages read through an unambiguous cursor", async () => {
    const readThrough = {
      id: "00000000-0000-4000-8000-000000000041",
      created_at: "2026-07-22T08:00:00.000Z",
    };

    await collaborationService.markAsRead("collaboration-1", readThrough);

    expect(mocks.markMarketplaceCollaborationMessagesRead).toHaveBeenCalledWith("collaboration-1", {
      messageId: readThrough.id,
      createdAt: readThrough.created_at,
    });
  });

  it("uses sender roles to place creator and hotel messages correctly", () => {
    const creatorConversation = conversation({ partner_name: "Hotel Aurora", my_role: "creator" });
    expect(
      isMessageFromCurrentUser(
        message({ sender_name: "Ari", sender_side: "creator" }),
        creatorConversation,
      ),
    ).toBe(true);
    expect(
      isMessageFromCurrentUser(
        message({ sender_name: "Ari", sender_side: "hotel" }),
        creatorConversation,
      ),
    ).toBe(false);
  });

  it("filters conversations and reads nonblank deep links", () => {
    const conversations: ConversationResponse[] = [
      conversation({
        collaboration_id: "collaboration-1",
        partner_name: "Hotel Aurora",
        listing_name: "Berlin City Stay",
        last_message_content: "Your September dates work for us.",
      }),
      conversation({
        collaboration_id: "collaboration-2",
        partner_name: "Coastal House",
        listing_name: "Lisbon Escape",
        collaboration_status: "completed",
      }),
    ];

    expect(filterConversations(conversations, "berlin")).toEqual([conversations[0]]);
    expect(filterConversations(conversations, "COMPLETED")).toEqual([conversations[1]]);
    expect(readChatCollaborationId("?collaborationId=collaboration%202")).toBe("collaboration 2");
    expect(readChatCollaborationId("?collaborationId=%20%20")).toBeNull();
  });
});

describe("collaborationService chat attachments", () => {
  it("uploads creator chat images as private media targeted to the collaboration", async () => {
    mocks.getMarketplaceCollaboration.mockResolvedValue(lifecycleWriteResponse().collaboration);
    mocks.uploadPlatformMedia.mockResolvedValue([{ mediaId: "media-chat-001" }]);
    const file = new File(["image-bytes"], "lobby.jpg", { type: "image/jpeg" });

    await expect(
      collaborationService.uploadChatImage("collaboration-001", "creator", file),
    ).resolves.toEqual({ mediaObjectId: "media-chat-001" });

    expect(mocks.uploadPlatformMedia).toHaveBeenCalledWith({
      purpose: "marketplace.collaboration_chat.attachment",
      resource: {
        product: "marketplace",
        resourceType: "creator_profile",
        resourceId: "creator-profile-001",
        targetResourceId: "collaboration-001",
      },
      files: [file],
      visibility: "private",
    });
  });

  it("uploads and sends a captioned image as one chat message", async () => {
    mocks.getMarketplaceCollaboration.mockResolvedValue(lifecycleWriteResponse().collaboration);
    mocks.uploadPlatformMedia.mockResolvedValue([{ mediaId: "media-chat-001" }]);
    mocks.sendMarketplaceCollaborationMessage.mockResolvedValue({
      contractVersion: "marketplace-collaboration-reads.v1",
      messageId: "message-001",
      collaborationId: "collaboration-001",
      senderUserId: "user-001",
      senderName: "creator",
      senderAvatarUrl: null,
      senderSide: "creator",
      content: "Poolside breakfast at sunrise",
      contentType: "image",
      metadata: { mediaObjectId: "media-chat-001" },
      createdAt: "2026-07-21T08:00:00.000Z",
    });
    const file = new File(["image-bytes"], "lobby.jpg", { type: "image/jpeg" });

    await expect(
      collaborationService.sendChatImage(
        "collaboration-001",
        "creator",
        file,
        " Poolside breakfast at sunrise ",
      ),
    ).resolves.toMatchObject({
      content: "Poolside breakfast at sunrise",
      content_type: "image",
      metadata: { mediaObjectId: "media-chat-001" },
    });

    expect(mocks.uploadPlatformMedia).toHaveBeenCalledTimes(1);
    expect(mocks.sendMarketplaceCollaborationMessage).toHaveBeenCalledTimes(1);
    expect(mocks.sendMarketplaceCollaborationMessage).toHaveBeenCalledWith(
      "collaboration-001",
      expect.objectContaining({
        content: "Poolside breakfast at sunrise",
        contentType: "image",
        mediaObjectId: "media-chat-001",
        idempotencyKey: expect.stringMatching(
          /^marketplace\.collaboration\.message:collaboration-001:/,
        ),
      }),
    );
  });

  it("trusts attachment presentation fields only after backend validation", async () => {
    mocks.getMarketplaceCollaboration.mockResolvedValue(lifecycleWriteResponse().collaboration);
    mocks.uploadPlatformMedia.mockResolvedValue([{ mediaId: "media-chat-001" }]);
    mocks.sendMarketplaceCollaborationMessage.mockResolvedValue({
      contractVersion: "marketplace-collaboration-reads.v1",
      messageId: "message-001",
      collaborationId: "collaboration-001",
      senderUserId: "user-001",
      senderName: "creator",
      senderAvatarUrl: null,
      senderSide: "creator",
      content: "Poolside breakfast at sunrise",
      contentType: "image",
      metadata: {
        mediaObjectId: "media-chat-001",
        attachmentUrl: "https://signed.example/chat-image",
        attachmentValidated: true,
      },
      createdAt: "2026-07-21T08:00:00.000Z",
    });

    const file = new File(["image-bytes"], "lobby.jpg", { type: "image/jpeg" });
    await expect(
      collaborationService.sendChatImage(
        "collaboration-001",
        "creator",
        file,
        "Poolside breakfast at sunrise",
      ),
    ).resolves.toMatchObject({
      content_type: "image",
      sender_side: "creator",
      metadata: {
        mediaObjectId: "media-chat-001",
        attachmentValidated: true,
      },
    });
    expect(mocks.sendMarketplaceCollaborationMessage).toHaveBeenCalledTimes(1);
  });

  it("does not trust attachment presentation fields without backend validation", async () => {
    mocks.getMarketplaceCollaboration.mockResolvedValue(lifecycleWriteResponse().collaboration);
    mocks.uploadPlatformMedia.mockResolvedValue([{ mediaId: "media-chat-001" }]);
    mocks.sendMarketplaceCollaborationMessage.mockResolvedValue({
      contractVersion: "marketplace-collaboration-reads.v1",
      messageId: "message-002",
      collaborationId: "collaboration-001",
      senderUserId: "user-001",
      senderName: "creator",
      senderAvatarUrl: null,
      senderSide: "creator",
      content: "Sent an image",
      contentType: "image",
      metadata: {
        mediaObjectId: "media-chat-001",
        attachmentUrl: "https://tracking.example/poisoned.jpg",
        fileName: "poisoned.jpg",
        legacySourceUrl: "https://legacy-private.example/chat.jpg",
        storageKey: "private/chat/secret.jpg",
        providerSecret: "must-not-leak",
      },
      createdAt: "2026-07-21T08:00:00.000Z",
    });

    const file = new File(["image-bytes"], "lobby.jpg", { type: "image/jpeg" });
    const response = await collaborationService.sendChatImage("collaboration-001", "creator", file);

    expect(response.metadata).toEqual({ mediaObjectId: "media-chat-001" });
  });
});

function lifecycleWriteResponse() {
  return {
    contractVersion: "marketplace-collaboration-lifecycle-writes.v1",
    command: { action: "create", idempotencyKey: "create-key" },
    collaboration: {
      contractVersion: "marketplace-collaboration-reads.v1",
      authorizationMode: "creator_workspace_resource_link",
      collaborationId: "collaboration-001",
      offerId: "offer-001",
      creatorId: "creator-001",
      hotelProfileId: "hotel-001",
      side: "creator",
      initiatorSide: "creator",
      isInitiator: true,
      status: "pending",
      compensationType: "paid",
      offerTitle: "City hotel launch",
      hotelLocation: "Munich, Germany",
      creator: {
        side: "creator",
        organizationId: "creator-org-001",
        profileId: "creator-profile-001",
        displayName: "Ari Creator",
        avatarUrl: null,
        location: "Berlin, Germany",
        portfolioUrl: null,
        creatorType: "travel",
        platforms: [],
      },
      hotel: {
        side: "hotel",
        organizationId: "hotel-org-001",
        profileId: "hotel-001",
        displayName: "City Hotel",
        avatarUrl: null,
      },
      terms: {
        freeStayMinNights: null,
        freeStayMaxNights: null,
        paidAmount: "450",
        currency: "EUR",
        discountPercentage: null,
        affiliateEnabled: false,
        affiliateCommissionPercentage: null,
        travelDateFrom: null,
        travelDateTo: null,
        preferredDateFrom: null,
        preferredDateTo: null,
        preferredMonths: [],
      },
      deliverables: [],
      lastMessageAt: null,
      createdAt: "2026-07-21T08:00:00.000Z",
      updatedAt: "2026-07-21T08:00:00.000Z",
    },
    sideEffects: [],
  };
}

function conversation(overrides: Partial<ConversationResponse>): ConversationResponse {
  return {
    collaboration_id: "collaboration",
    partner_name: "Hotel",
    partner_avatar: null,
    last_message_content: null,
    last_message_at: null,
    unread_count: 0,
    collaboration_status: "active",
    my_role: "creator",
    listing_name: null,
    ...overrides,
  };
}

function message(overrides: Partial<MessageResponse>): MessageResponse {
  return {
    id: "message",
    collaboration_id: "collaboration",
    sender_id: "sender",
    sender_name: "creator",
    sender_avatar: null,
    sender_side: "creator",
    content: "Hello",
    content_type: "text",
    metadata: null,
    created_at: "2026-07-22T08:00:00.000Z",
    ...overrides,
  };
}

function marketplaceConversation(collaborationId: string) {
  return {
    contractVersion: "marketplace-collaboration-reads.v1" as const,
    collaborationId,
    side: "creator" as const,
    partnerName: "Hotel Aurora",
    partnerAvatarUrl: null,
    offerTitle: "Aurora stay",
    collaborationStatus: "active" as const,
    lastMessageContent: "Welcome",
    lastMessageAt: "2026-07-22T08:00:00.000Z",
    unreadCount: 0,
  };
}
