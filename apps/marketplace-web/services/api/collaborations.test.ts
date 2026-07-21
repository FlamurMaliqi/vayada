import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  createMarketplaceCollaboration: vi.fn(),
  getMarketplaceCollaboration: vi.fn(),
  sendMarketplaceMessage: vi.fn(),
  uploadPlatformMedia: vi.fn(),
}));

vi.mock("@vayada/marketplace-shared/api/collaborations", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@vayada/marketplace-shared/api/collaborations")>();
  return {
    ...actual,
    createMarketplaceCollaboration: mocks.createMarketplaceCollaboration,
    getMarketplaceCollaboration: mocks.getMarketplaceCollaboration,
    sendMarketplaceMessage: mocks.sendMarketplaceMessage,
  };
});

vi.mock("@vayada/marketplace-shared/api/platformMedia", () => ({
  uploadPlatformMedia: mocks.uploadPlatformMedia,
}));

vi.mock("@/lib/utils", () => ({
  buildQueryString: () => "",
}));

import { toLegacyCollaborationType } from "@vayada/marketplace-shared/api/collaborations";
import { collaborationService } from "./collaborations";

beforeEach(() => {
  mocks.createMarketplaceCollaboration.mockReset();
  mocks.getMarketplaceCollaboration.mockReset();
  mocks.sendMarketplaceMessage.mockReset();
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
    mocks.sendMarketplaceMessage.mockResolvedValue({
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
    expect(mocks.sendMarketplaceMessage).toHaveBeenCalledTimes(1);
    expect(mocks.sendMarketplaceMessage).toHaveBeenCalledWith(
      "collaboration-001",
      "Poolside breakfast at sunrise",
      "image",
      "media-chat-001",
    );
  });

  it("sends the caption atomically with only the private media object ID", async () => {
    mocks.sendMarketplaceMessage.mockResolvedValue({
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

    await expect(
      collaborationService.sendMessage(
        "collaboration-001",
        "Poolside breakfast at sunrise",
        "image",
        "media-chat-001",
      ),
    ).resolves.toMatchObject({
      content_type: "image",
      sender_side: "creator",
      metadata: {
        mediaObjectId: "media-chat-001",
        attachmentValidated: true,
      },
    });
    expect(mocks.sendMarketplaceMessage).toHaveBeenCalledWith(
      "collaboration-001",
      "Poolside breakfast at sunrise",
      "image",
      "media-chat-001",
    );
    expect(mocks.sendMarketplaceMessage).toHaveBeenCalledTimes(1);
  });

  it("does not trust attachment presentation fields without backend validation", async () => {
    mocks.sendMarketplaceMessage.mockResolvedValue({
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

    const response = await collaborationService.sendMessage(
      "collaboration-001",
      "Sent an image",
      "image",
      "media-chat-001",
    );

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
