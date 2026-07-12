import {
  approveMarketplaceAdminCollaborationAsHotel,
  buildMarketplaceAdminCollaborationIdempotencyKey,
  getMarketplaceAdminCollaborations,
  respondToMarketplaceAdminCollaborationAsHotel,
  type MarketplaceAdminCollaboration,
  type MarketplaceAdminCollaborationsInput,
} from "@vayada/marketplace-shared/api/admin";
import { toLegacyCollaborationType } from "@vayada/marketplace-shared/api/collaborations";
import { AdminCollaborationsResponse, Collaboration } from "@/lib/types/collaboration";

export const collaborationsService = {
  /**
   * Fetch admin collaborations with pagination, filtering, and search.
   */
  getCollaborations: async (
    page: number = 1,
    pageSize: number = 20,
    filters?: { status?: string; search?: string },
  ): Promise<AdminCollaborationsResponse> => {
    const response = await getMarketplaceAdminCollaborations({
      page,
      pageSize,
      status: filters?.status as MarketplaceAdminCollaborationsInput["status"],
      search: filters?.search,
    });
    return {
      collaborations: response.collaborations.map(toLegacyCollaboration),
      total: response.pagination.total,
    };
  },

  /**
   * Accept or decline a pending collaboration on behalf of the hotel.
   */
  respondAsHotel: async (
    collaborationId: string,
    status: "accepted" | "declined",
    responseMessage?: string,
  ): Promise<Collaboration> => {
    const response = await respondToMarketplaceAdminCollaborationAsHotel(collaborationId, {
      idempotencyKey: buildMarketplaceAdminCollaborationIdempotencyKey({
        action: "respond",
        collaborationId,
        nonce: createClientNonce(),
      }),
      status,
      responseMessage,
    });
    return toLegacyCollaboration(response.collaboration);
  },

  /**
   * Approve current terms on behalf of the hotel. Finalizes the collaboration
   * when the creator has already approved.
   */
  approveAsHotel: async (collaborationId: string): Promise<Collaboration> => {
    const response = await approveMarketplaceAdminCollaborationAsHotel(collaborationId, {
      idempotencyKey: buildMarketplaceAdminCollaborationIdempotencyKey({
        action: "approve_terms",
        collaborationId,
        nonce: createClientNonce(),
      }),
    });
    return toLegacyCollaboration(response.collaboration);
  },
};

function toLegacyCollaboration(collaboration: MarketplaceAdminCollaboration): Collaboration {
  return {
    id: collaboration.collaborationId,
    initiator_type: collaboration.initiatorSide,
    creator_id: collaboration.creatorId,
    creator_name: collaboration.creator.displayName,
    creator_profile_picture: collaboration.creator.avatarUrl ?? undefined,
    hotel_id: collaboration.hotelProfileId,
    hotel_name: collaboration.hotel.displayName,
    listing_id: collaboration.offerId,
    listing_name: collaboration.offerTitle,
    listing_location: collaboration.hotelLocation ?? "",
    status:
      collaboration.status === "rejected"
        ? "declined"
        : collaboration.status === "active"
          ? "accepted"
          : collaboration.status,
    collaboration_type:
      toLegacyCollaborationType(
        collaboration.compensationType,
        collaboration.terms.affiliateEnabled,
        collaboration.terms.affiliateCommissionPercentage,
      ) ?? undefined,
    paid_amount:
      collaboration.terms.paidAmount === null ? undefined : Number(collaboration.terms.paidAmount),
    currency: collaboration.terms.currency ?? undefined,
    discount_percentage: collaboration.terms.discountPercentage ?? undefined,
    affiliate_enabled: collaboration.terms.affiliateEnabled,
    affiliate_commission_percentage:
      collaboration.terms.affiliateCommissionPercentage === null
        ? undefined
        : Number(collaboration.terms.affiliateCommissionPercentage),
    free_stay_min_nights: collaboration.terms.freeStayMinNights ?? undefined,
    free_stay_max_nights: collaboration.terms.freeStayMaxNights ?? undefined,
    travel_date_from: collaboration.terms.travelDateFrom ?? undefined,
    travel_date_to: collaboration.terms.travelDateTo ?? undefined,
    preferred_date_from: collaboration.terms.preferredDateFrom ?? undefined,
    preferred_date_to: collaboration.terms.preferredDateTo ?? undefined,
    preferred_months: collaboration.terms.preferredMonths,
    platform_deliverables: toLegacyDeliverableGroups(collaboration.deliverables),
    why_great_fit: collaboration.applicationMessage ?? undefined,
    created_at: collaboration.createdAt,
    updated_at: collaboration.updatedAt,
    completed_at: collaboration.completedAt ?? undefined,
    cancelled_at: collaboration.cancelledAt ?? undefined,
    hotel_agreed_at: collaboration.hotelAgreedAt ?? undefined,
    creator_agreed_at: collaboration.creatorAgreedAt ?? undefined,
  };
}

function toLegacyDeliverableGroups(
  deliverables: MarketplaceAdminCollaboration["deliverables"],
): Collaboration["platform_deliverables"] {
  const groups = new Map<string, Collaboration["platform_deliverables"][number]>();
  for (const deliverable of deliverables) {
    const platform = toLegacyPlatform(deliverable.platform);
    const group = groups.get(platform) ?? { platform, deliverables: [] };
    group.deliverables.push({
      id: deliverable.deliverableId,
      type: deliverable.type,
      quantity: deliverable.quantity,
      status: deliverable.status,
    });
    groups.set(platform, group);
  }
  return Array.from(groups.values());
}

function toLegacyPlatform(
  platform: string,
): Collaboration["platform_deliverables"][number]["platform"] {
  switch (platform) {
    case "instagram":
      return "Instagram";
    case "tiktok":
      return "TikTok";
    case "youtube":
      return "YouTube";
    case "facebook":
      return "Facebook";
    default:
      return "Custom";
  }
}

function createClientNonce(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}
