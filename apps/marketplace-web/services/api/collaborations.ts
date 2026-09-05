/**
 * Collaborations API service
 */

import type { Collaboration, Creator, Hotel } from "@/lib/types";
import {
  approveMarketplaceCollaborationTerms,
  buildMarketplaceCollaborationLifecycleIdempotencyKey,
  cancelMarketplaceCollaboration,
  createMarketplaceCollaboration,
  editMarketplaceCollaborationApplication,
  getMarketplaceCollaboration,
  getMarketplaceConversationPage,
  getMarketplaceMessages,
  getMyMarketplaceCollaborations,
  markMarketplaceCollaborationMessagesRead,
  rateMarketplaceCollaborationCreator,
  respondToMarketplaceCollaboration,
  sendMarketplaceCollaborationMessage,
  toggleMarketplaceCollaborationDeliverable,
  updateMarketplaceCollaborationTerms,
  type CreateMarketplaceCollaborationLifecycleWriteRequest,
  type MarketplaceCollaborationMessage,
  type MarketplaceCollaborationLifecycleWriteAction,
  type MarketplaceCollaborationRead,
  type MarketplaceCollaborationSide,
  type MarketplaceCollaborationStatus,
  type MarketplaceCollaborationTermsInput,
  type MarketplaceCompensationType,
  type MarketplaceConversationSummary,
  toLegacyCollaborationType,
} from "@vayada/marketplace-shared/api/collaborations";
import { uploadPlatformMedia } from "@vayada/marketplace-shared/api/platformMedia";

// Platform deliverable types
export interface PlatformDeliverable {
  id: string;
  type: string;
  quantity: number;
  status?: "pending" | "completed";
  completed?: boolean;
  completed_at?: string | null;
}

export interface PlatformDeliverablesItem {
  platform: "Instagram" | "TikTok" | "YouTube" | "Facebook" | "Content Package" | "Custom" | string;
  deliverables: PlatformDeliverable[];
}

// Creator application request
export interface CreateCreatorCollaborationRequest {
  initiator_type: "creator";
  listing_id: string;
  compensation_option_id: string;
  why_great_fit: string;
  consent: true;
  collaboration_type?: "Free Stay" | "Paid" | "Discount" | "Affiliate";
  free_stay_min_nights?: number;
  free_stay_max_nights?: number;
  paid_amount?: number;
  currency?: string;
  discount_percentage?: number;
  creator_fee?: number;
  travel_date_from?: string;
  travel_date_to?: string;
  preferred_months?: string[];
  platform_deliverables: Array<{
    platform:
      | "Instagram"
      | "TikTok"
      | "YouTube"
      | "Facebook"
      | "Content Package"
      | "Custom"
      | string;
    deliverables: Array<{
      type: string;
      quantity: number;
    }>;
  }>;
}

export interface UpdateCollaborationTermsRequest {
  travel_date_from?: string;
  travel_date_to?: string;
  platform_deliverables?: Array<{
    platform:
      | "Instagram"
      | "TikTok"
      | "YouTube"
      | "Facebook"
      | "Content Package"
      | "Custom"
      | string;
    deliverables: Array<{
      id?: string;
      type: string;
      quantity: number;
    }>;
  }>;

  collaboration_type?: string;
  free_stay_max_nights?: number | null;
  paid_amount?: number | null;
  currency?: string | null;
  discount_percentage?: number | null;
  creator_fee?: number | null;
}

export interface CollaborationResponseRequest {
  expectedUpdatedAt?: string;
  status: "accepted" | "declined";
  response_message?: string;
}

// Hotel invitation request
export interface CreateHotelCollaborationRequest {
  initiator_type: "hotel";
  listing_id: string;
  creator_id: string;
  collaboration_type: "Free Stay" | "Paid" | "Discount" | "Affiliate";
  free_stay_min_nights?: number;
  free_stay_max_nights?: number;
  paid_amount?: number;
  currency?: string;
  discount_percentage?: number;
  creator_fee?: number;
  preferred_date_from?: string;
  preferred_date_to?: string;
  preferred_months?: string[];
  platform_deliverables: Array<{
    platform:
      | "Instagram"
      | "TikTok"
      | "YouTube"
      | "Facebook"
      | "Content Package"
      | "Custom"
      | string;
    deliverables: Array<{
      type: string;
      quantity: number;
    }>;
  }>;

  message?: string;
}

export type CreateCollaborationRequest =
  | CreateCreatorCollaborationRequest
  | CreateHotelCollaborationRequest;

export interface CollaborationWriteOptions {
  idempotencyKey?: string;
}

// Backend collaboration response (snake_case)
export interface CollaborationResponse {
  selectedCompensationOptionId?: string | null;
  cancelledBy?: "creator" | "hotel" | null;
  id: string;
  initiator_type: "creator" | "hotel";
  is_initiator: boolean;
  status:
    | "pending"
    | "negotiating"
    | "accepted"
    | "active"
    | "declined"
    | "rejected"
    | "completed"
    | "cancelled";
  creator_id: string;
  creator_name: string;
  creator_profile_picture: string | null;
  handle: string | null;
  creator_location: string | null;
  is_verified: boolean;

  creator_portfolio_link?: string | null;
  portfolio_link?: string | null;
  creator_type?: "Lifestyle" | "Travel" | null;
  platforms?: Array<{
    name: "Instagram" | "TikTok" | "YouTube" | "Facebook" | string;
    handle: string;
    profile_url?: string | null;
    followers: number;
    engagement_rate: number;
    top_countries?: Array<{ country: string; percentage: number }> | null;
    top_age_groups?: Array<{ ageRange: string; percentage: number }> | null;
    gender_split?: { male: number; female: number; other?: number } | null;
  }>;
  hotel_id: string;
  hotel_name: string;
  hotel_picture?: string | null;
  propertyTimezone?: string | null;
  hotel_location?: string | null;
  hotel_website?: string | null;
  hotel_about?: string | null;
  hotel_phone?: string | null;
  total_followers?: number;
  avg_engagement_rate?: number;
  active_platform?: string;
  primary_handle?: string;
  listing_id: string;
  listing_name: string;
  listing_location: string;
  collaboration_type: "Free Stay" | "Paid" | "Discount" | "Affiliate" | null;
  free_stay_min_nights: number | null;
  free_stay_max_nights: number | null;
  paid_amount: number | null;
  currency: string | null;
  discount_percentage: number | null;
  creator_fee: number | null;
  travel_date_from: string | null;
  travel_date_to: string | null;
  preferred_date_from: string | null;
  preferred_date_to: string | null;
  preferred_months: string[] | null;

  why_great_fit: string | null;
  platform_deliverables?: PlatformDeliverablesItem[];
  reputation?: {
    average_rating: number;
    total_reviews: number;
    reviews: Array<{
      id: string;
      hotel_name: string;
      rating: number;
      comment?: string;
      created_at: string;
    }>;
  };
  hotel_agreed_at: string | null;
  creator_agreed_at: string | null;
  consent: boolean | null;
  created_at: string;
  cancelled_at: string | null;
  completed_at: string | null;
  hotelProfilePicture?: string | null;
  listingImages?: string[];
  listing_images?: string[];
  creatorRequirements?: {
    platforms: string[];
    targetCountries: string[];
    targetAgeMin: number;
    targetAgeMax: number;
  };
  // Additional properties that may come from backend
  updated_at?: string;
  responded_at?: string;
  creator_requirements?: {
    platforms: string[];
    target_countries: string[];
    target_age_min: number;
    target_age_max: number;
  };
}

export type DetailedCollaboration = Collaboration & {
  selectedCompensationOptionId?: string | null;
  cancelledBy?: "creator" | "hotel" | null;
  hotel?: Hotel;
  creator?: Creator;
  listingId?: string;
  listingName?: string;
  listingLocation?: string;
  collaborationType?: "Free Stay" | "Paid" | "Discount" | "Affiliate" | null;
  hotelLocation?: string | null;
  hotelWebsite?: string | null;
  hotelAbout?: string | null;
  hotelPhone?: string | null;
  freeStayMinNights?: number | null;
  freeStayMaxNights?: number | null;
  paidAmount?: number | null;
  currency?: string | null;
  discountPercentage?: number | null;
  creatorFee?: number | null;
  travelDateFrom?: string | null;
  travelDateTo?: string | null;
  preferredDateFrom?: string | null;
  preferredDateTo?: string | null;
  preferredMonths?: string[] | null;
  whyGreatFit?: string | null;
  platformDeliverables?: PlatformDeliverablesItem[];
  hotelAgreedAt?: Date | null;
  creatorAgreedAt?: Date | null;
  consent?: boolean | null;
  respondedAt?: string | null;
  cancelledAt?: string | null;
  completedAt?: string | null;
  listingImages?: string[];
  creatorRequirements?: {
    platforms: string[];
    targetCountries: string[];
    targetAgeMin: number;
    targetAgeMax: number;
  };
  allowedCollaborationTypes?: ("Free Stay" | "Paid" | "Discount" | "Affiliate")[];
};

export interface ConversationResponse {
  collaboration_id: string;
  partner_name: string;
  partner_avatar: string | null;
  last_message_content: string | null;
  last_message_at: string | null;
  unread_count: number;
  collaboration_status: string;
  my_role: "creator" | "hotel";
  listing_name?: string | null;
}

export interface MessageMetadata {
  attachmentUrl?: string;
  attachmentValidated?: true;
  mediaObjectId?: string;
  fileName?: string;
  fileSize?: number;
  contentType?: string;
  [key: string]: unknown;
}

export interface MessageResponse {
  id: string;
  collaboration_id: string;
  sender_id: string | null;
  sender_name: string | null;
  sender_avatar: string | null;
  sender_side?: MarketplaceCollaborationSide | null;
  content: string;
  content_type: "text" | "image" | "system";
  metadata: MessageMetadata | null;
  created_at: string;
}

async function uploadChatImage(
  collaborationId: string,
  side: MarketplaceCollaborationSide,
  file: File,
): Promise<{ mediaObjectId: string }> {
  const collaboration = await getMarketplaceCollaboration(collaborationId, side);
  const source =
    side === "creator"
      ? {
          product: "marketplace" as const,
          resourceType: "creator_profile" as const,
          resourceId: collaboration.creator.profileId,
        }
      : {
          product: "marketplace" as const,
          resourceType: "marketplace_offer" as const,
          resourceId: collaboration.offerId,
        };
  const [uploaded] = await uploadPlatformMedia({
    purpose: "marketplace.collaboration_chat.attachment",
    resource: { ...source, targetResourceId: collaborationId },
    files: [file],
    visibility: "private",
  });
  if (!uploaded) throw new Error("Chat image upload did not return a media object.");
  return { mediaObjectId: uploaded.mediaId };
}

async function sendChatImage(
  collaborationId: string,
  side: MarketplaceCollaborationSide,
  file: File,
  caption?: string,
): Promise<MessageResponse> {
  const { mediaObjectId } = await uploadChatImage(collaborationId, side, file);
  return toLegacyMessageResponse(
    await sendMarketplaceCollaborationMessage(collaborationId, {
      content: caption?.trim() || "Sent an image",
      contentType: "image",
      mediaObjectId,
      idempotencyKey: buildMarketplaceMessageIdempotencyKey(collaborationId),
    }),
  );
}

export function filterConversations(
  conversations: ConversationResponse[],
  query: string,
): ConversationResponse[] {
  const normalizedQuery = query.trim().toLocaleLowerCase();
  if (!normalizedQuery) return conversations;

  return conversations.filter((conversation) =>
    [
      conversation.partner_name,
      conversation.listing_name,
      conversation.last_message_content,
      conversation.collaboration_status,
    ].some((value) => value?.toLocaleLowerCase().includes(normalizedQuery)),
  );
}

export function isMessageFromCurrentUser(
  message: MessageResponse,
  conversation: ConversationResponse,
): boolean {
  if (message.sender_id === null || message.content_type === "system") return false;
  return message.sender_side === conversation.my_role;
}

export function readChatCollaborationId(search: string): string | null {
  const collaborationId = new URLSearchParams(search).get("collaborationId")?.trim();
  return collaborationId || null;
}

export const collaborationService = {
  /**
   * Get creator collaborations
   */
  getCreatorCollaborations: async (params?: {
    status?: string;
    initiated_by?: string;
  }): Promise<CollaborationResponse[]> => {
    const response = await getMyMarketplaceCollaborations({
      side: "creator",
      status: toTargetCollaborationStatus(params?.status),
      initiatedBy: toTargetSide(params?.initiated_by),
    });
    return response.items.map((item) => toLegacyCollaborationResponse(item));
  },

  /**
   * Get hotel collaborations
   */
  getHotelCollaborations: async (params?: {
    listing_id?: string;
    status?: string;
    initiated_by?: string;
  }): Promise<CollaborationResponse[]> => {
    const response = await getMyMarketplaceCollaborations({
      side: "hotel",
      offerId: params?.listing_id,
      status: toTargetCollaborationStatus(params?.status),
      initiatedBy: toTargetSide(params?.initiated_by),
    });
    return response.items.map((item) => toLegacyCollaborationResponse(item));
  },

  getHotelCollaborationDetails: async (id: string): Promise<CollaborationResponse> => {
    return toLegacyCollaborationResponse(await getMarketplaceCollaboration(id, "hotel"));
  },

  /**
   * Get creator collaboration details by ID
   */
  getCreatorCollaborationDetails: async (id: string): Promise<CollaborationResponse> => {
    return toLegacyCollaborationResponse(await getMarketplaceCollaboration(id, "creator"));
  },

  /**
   * Create collaboration request (creator application or hotel invitation)
   */
  create: async (
    data: CreateCollaborationRequest,
    options: CollaborationWriteOptions = {},
  ): Promise<DetailedCollaboration> => {
    const idempotencyKey = resolveLifecycleWriteIdempotencyKey("create", data.listing_id, options);
    const response = await createMarketplaceCollaboration(
      toTargetCreateCollaborationRequest(data, idempotencyKey),
    );
    return transformCollaborationResponse(toLegacyCollaborationResponse(response.collaboration));
  },

  editApplication: async (
    collaborationId: string,
    data: CreateCreatorCollaborationRequest,
    expectedUpdatedAt: string,
    options: CollaborationWriteOptions,
  ): Promise<DetailedCollaboration> => {
    const response = await editMarketplaceCollaborationApplication(collaborationId, {
      ...toTargetCreateCollaborationRequest(
        data,
        resolveLifecycleWriteIdempotencyKey("edit_application", collaborationId, options),
      ),
      expectedUpdatedAt,
    });
    return transformCollaborationResponse(toLegacyCollaborationResponse(response.collaboration));
  },

  /**
   * Get all conversations for the current user
   */
  getConversations: async (): Promise<ConversationResponse[]> => {
    const conversations: MarketplaceConversationSummary[] = [];
    const seenCursors = new Set<string>();
    let cursor: string | undefined;
    do {
      const page = await getMarketplaceConversationPage({ cursor, limit: 100 });
      conversations.push(...page.items);
      const nextCursor = page.nextCursor ?? undefined;
      if (!nextCursor || seenCursors.has(nextCursor)) break;
      seenCursors.add(nextCursor);
      cursor = nextCursor;
    } while (cursor);
    return conversations.map(toLegacyConversationResponse);
  },

  /**
   * Get messages for a collaboration
   */
  getMessages: async (
    collaborationId: string,
    before?: string | Pick<MessageResponse, "id" | "created_at">,
  ): Promise<MessageResponse[]> => {
    const legacyBefore = typeof before === "string" ? before : undefined;
    const cursor = typeof before === "object" ? encodeMessageCursor(before) : undefined;
    const response = await getMarketplaceMessages(collaborationId, {
      before: legacyBefore,
      cursor,
    });
    return response.items.map(toLegacyMessageResponse);
  },

  markAsRead: async (
    collaborationId: string,
    readThrough: Pick<MessageResponse, "id" | "created_at">,
  ): Promise<void> => {
    await markMarketplaceCollaborationMessagesRead(collaborationId, {
      createdAt: readThrough.created_at,
      messageId: readThrough.id,
    });
  },

  /**
   * Send a message to a collaboration
   */
  sendMessage: async (
    collaborationId: string,
    content: string,
    idempotencyKey = buildMarketplaceMessageIdempotencyKey(collaborationId),
  ): Promise<MessageResponse> => {
    return toLegacyMessageResponse(
      await sendMarketplaceCollaborationMessage(collaborationId, {
        content,
        idempotencyKey,
      }),
    );
  },

  /**
   * Toggle the completion status of a deliverable
   */
  toggleDeliverable: async (
    collaborationId: string,
    deliverableId: string,
  ): Promise<CollaborationResponse> => {
    const idempotencyKey = buildLifecycleWriteIdempotencyKey(
      "toggle_deliverable",
      `${collaborationId}:${deliverableId}`,
    );
    const response = await toggleMarketplaceCollaborationDeliverable(
      collaborationId,
      deliverableId,
      { idempotencyKey },
    );
    return toLegacyCollaborationResponse(response.collaboration);
  },

  /**
   * Approve terms (Double Confirmation)
   */
  approveCollaboration: async (collaborationId: string): Promise<CollaborationResponse> => {
    const idempotencyKey = buildLifecycleWriteIdempotencyKey("approve_terms", collaborationId);
    const response = await approveMarketplaceCollaborationTerms(collaborationId, {
      idempotencyKey,
    });
    return toLegacyCollaborationResponse(response.collaboration);
  },

  /**
   * Suggest new terms for a collaboration
   */
  updateTerms: async (
    collaborationId: string,
    data: UpdateCollaborationTermsRequest,
  ): Promise<CollaborationResponse> => {
    const idempotencyKey = buildLifecycleWriteIdempotencyKey("update_terms", collaborationId);
    const response = await updateMarketplaceCollaborationTerms(
      collaborationId,
      toTargetUpdateTermsRequest(data, idempotencyKey),
    );
    return toLegacyCollaborationResponse(response.collaboration);
  },

  /**
   * Accept or Decline a collaboration request
   */
  /**
   * Respond to a collaboration request (Accept/Decline)
   */
  respondToCollaboration: async (
    collaborationId: string,
    data: CollaborationResponseRequest,
  ): Promise<CollaborationResponse> => {
    const idempotencyKey = buildLifecycleWriteIdempotencyKey("respond", collaborationId);
    const response = await respondToMarketplaceCollaboration(collaborationId, {
      idempotencyKey,
      status: data.status,
      responseMessage: data.response_message,
      expectedUpdatedAt: data.expectedUpdatedAt,
    });
    return toLegacyCollaborationResponse(response.collaboration);
  },

  /**
   * Cancel or withdraw from a collaboration
   */
  cancelCollaboration: async (
    collaborationId: string,
    reason?: string,
    pendingOnly = false,
  ): Promise<CollaborationResponse> => {
    const idempotencyKey = buildLifecycleWriteIdempotencyKey("cancel", collaborationId);
    const response = await cancelMarketplaceCollaboration(collaborationId, {
      idempotencyKey,
      reason,
      pendingOnly,
    });
    return toLegacyCollaborationResponse(response.collaboration);
  },

  /**
   * Rate a creator after completing a collaboration (hotels only)
   */
  rateCollaboration: async (
    collaborationId: string,
    rating: number,
    comment?: string,
  ): Promise<{ message: string; rating_id: string; created_at: string }> => {
    const idempotencyKey = buildLifecycleWriteIdempotencyKey("rate_creator", collaborationId);
    const response = await rateMarketplaceCollaborationCreator(collaborationId, {
      idempotencyKey,
      rating,
      comment,
    });
    if (response.command.action !== "rate_creator" || !response.command.ratingId) {
      throw new Error("Lifecycle rate response did not include a ratingId.");
    }
    return {
      message: "Rating submitted successfully",
      rating_id: response.command.ratingId,
      created_at: response.command.acceptedAt ?? response.collaboration.updatedAt,
    };
  },

  /**
   * Upload an image for chat messages
   */
  uploadChatImage,
  sendChatImage,
};

type LegacyCollaborationTermsSource = {
  collaboration_type?: string | null;
  free_stay_min_nights?: number | null;
  free_stay_max_nights?: number | null;
  paid_amount?: number | null;
  currency?: string | null;
  discount_percentage?: number | null;
  creator_fee?: number | null;
  travel_date_from?: string;
  travel_date_to?: string;
  preferred_date_from?: string;
  preferred_date_to?: string;
  preferred_months?: string[];
};

type LegacyDeliverablesItem = {
  platform: string;
  deliverables: Array<{
    id?: string;
    type: string;
    quantity: number;
  }>;
};

function buildLifecycleWriteIdempotencyKey(
  action: MarketplaceCollaborationLifecycleWriteAction,
  resourceId: string,
): string {
  return createCollaborationWriteIdempotencyKey(action, resourceId);
}

function resolveLifecycleWriteIdempotencyKey(
  action: MarketplaceCollaborationLifecycleWriteAction,
  resourceId: string,
  options: CollaborationWriteOptions,
): string {
  return (
    options.idempotencyKey?.trim() || createCollaborationWriteIdempotencyKey(action, resourceId)
  );
}

export function createCollaborationWriteIdempotencyKey(
  action: MarketplaceCollaborationLifecycleWriteAction,
  resourceId: string,
): string {
  return buildMarketplaceCollaborationLifecycleIdempotencyKey({
    action,
    resourceId,
    nonce: createClientNonce(),
  });
}

function createClientNonce(): string {
  if (typeof globalThis.crypto?.randomUUID === "function") {
    return globalThis.crypto.randomUUID();
  }
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

export function buildMarketplaceMessageIdempotencyKey(collaborationId: string): string {
  return `marketplace.collaboration.message:${collaborationId}:${createClientNonce()}:v1`;
}

function encodeMessageCursor(message: Pick<MessageResponse, "id" | "created_at">): string {
  const encoded = btoa(JSON.stringify({ createdAt: message.created_at, messageId: message.id }));
  return encoded.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function toTargetCreateCollaborationRequest(
  data: CreateCollaborationRequest,
  idempotencyKey: string,
): CreateMarketplaceCollaborationLifecycleWriteRequest {
  const common = {
    idempotencyKey,
    offerId: data.listing_id,
    terms: toTargetTerms(data),
    deliverables: toTargetDeliverables(data.platform_deliverables),
  };
  return data.initiator_type === "creator"
    ? {
        ...common,
        compensationOptionId: data.compensation_option_id,
        whyGreatFit: data.why_great_fit,
        consent: data.consent,
      }
    : {
        ...common,
        creatorId: data.creator_id,
        message: data.message,
      };
}

function toTargetUpdateTermsRequest(data: UpdateCollaborationTermsRequest, idempotencyKey: string) {
  return {
    idempotencyKey,
    terms: toTargetTerms(data),
    deliverables: toTargetDeliverables(data.platform_deliverables),
  };
}

function toTargetTerms(source: LegacyCollaborationTermsSource): MarketplaceCollaborationTermsInput {
  return {
    compensationType: toTargetCompensationType(source.collaboration_type),
    freeStayMinNights: source.free_stay_min_nights,
    freeStayMaxNights: source.free_stay_max_nights,
    paidAmount: toDecimalString(source.paid_amount),
    currency: source.currency,
    discountPercentage: source.discount_percentage,
    affiliateEnabled:
      source.collaboration_type === "Affiliate" ||
      source.collaboration_type === "affiliate" ||
      source.creator_fee != null,
    affiliateCommissionPercentage: toDecimalString(source.creator_fee),
    travelDateFrom: source.travel_date_from,
    travelDateTo: source.travel_date_to,
    preferredDateFrom: source.preferred_date_from,
    preferredDateTo: source.preferred_date_to,
    preferredMonths: source.preferred_months,
  };
}

function toTargetDeliverables(items?: LegacyDeliverablesItem[]) {
  const deliverables = items?.flatMap((item) =>
    item.deliverables.map((deliverable) => ({
      deliverableId: deliverable.id,
      platform: item.platform,
      type: deliverable.type,
      quantity: deliverable.quantity,
    })),
  );
  return deliverables?.length ? deliverables : undefined;
}

function toTargetCompensationType(
  value?: string | null,
): MarketplaceCompensationType | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  switch (value) {
    case "Free Stay":
    case "free_stay":
      return "free_stay";
    case "Paid":
    case "paid":
      return "paid";
    case "Discount":
    case "discount":
      return "discount";
    case "Affiliate":
    case "affiliate":
      return null;
    default:
      return null;
  }
}

function toDecimalString(value?: number | null): string | null | undefined {
  return value === undefined ? undefined : value === null ? null : String(value);
}

/**
 * Transforms a backend collaboration response into a Frontend-friendly Collaboration object with simplified structure
 */
export function transformCollaborationResponse(
  response: CollaborationResponse,
): DetailedCollaboration {
  const updatedAt = response.updated_at || response.created_at;

  const hotel: Hotel | undefined = response.hotel_name
    ? {
        id: response.hotel_id,
        hotelProfileId: "", // Not provided in simplified response
        name: response.hotel_name,
        location: response.listing_location || "",
        description: "", // Not provided
        picture: response.hotelProfilePicture || response.hotel_picture || undefined,
        images: [response.hotelProfilePicture || response.hotel_picture].filter(
          Boolean,
        ) as string[],
        status: "verified",
        createdAt: new Date(response.created_at),
        updatedAt: new Date(updatedAt),
      }
    : undefined;

  const creator: Creator | undefined = response.creator_name
    ? {
        id: response.creator_id,
        email: "", // Not provided
        name: response.creator_name,
        location: response.creator_location || "",
        platforms:
          response.platforms?.map((p) => ({
            name: p.name || "platform",
            handle: p.handle,
            profileUrl: p.profile_url,
            followers: p.followers,
            engagementRate: p.engagement_rate,
            topCountries: p.top_countries || undefined,
            topAgeGroups: p.top_age_groups || undefined,
            genderSplit: p.gender_split || undefined,
          })) || [],
        audienceSize: response.total_followers ?? 0,
        avgEngagementRate: response.avg_engagement_rate ?? undefined,
        creatorType: (response.creator_type as "Lifestyle" | "Travel") || "Lifestyle",
        rating: response.reputation
          ? {
              averageRating: response.reputation.average_rating,
              totalReviews: response.reputation.total_reviews,
              reviews: response.reputation.reviews.map((r) => ({
                id: r.id,
                hotelId: "", // Not provided in simplified response, likely not needed for display
                hotelName: r.hotel_name,
                rating: r.rating,
                comment: r.comment,
                createdAt: new Date(r.created_at),
              })),
            }
          : {
              averageRating: 0,
              totalReviews: 0,
            },
        portfolioLink: response.portfolio_link || response.creator_portfolio_link || undefined,
        shortDescription: undefined,
        phone: null,
        profilePicture: response.creator_profile_picture || undefined,
        status: "verified" as const,
        createdAt: new Date(response.created_at),
        updatedAt: new Date(updatedAt),
      }
    : undefined;

  const result = {
    id: response.id,
    hotelId: response.hotel_id,
    creatorId: response.creator_id,
    status: response.status || "pending",
    createdAt: new Date(response.created_at),
    updatedAt: new Date(updatedAt),
    hotel,
    creator,
    is_initiator: response.is_initiator,
    // Store additional backend fields for use in components
    initiator_type: response.initiator_type,
    listingId: response.listing_id,
    listingName: response.listing_name,
    listingLocation: response.listing_location,
    collaborationType: response.collaboration_type,
    freeStayMinNights: response.free_stay_min_nights,
    freeStayMaxNights: response.free_stay_max_nights,
    paidAmount: response.paid_amount,
    currency: response.currency,
    discountPercentage: response.discount_percentage,
    creatorFee: response.creator_fee,
    travelDateFrom: response.travel_date_from,
    travelDateTo: response.travel_date_to,
    preferredDateFrom: response.preferred_date_from,
    preferredDateTo: response.preferred_date_to,
    preferredMonths: response.preferred_months,
    whyGreatFit: response.why_great_fit,
    selectedCompensationOptionId: response.selectedCompensationOptionId,
    cancelledBy: response.cancelledBy,
    platformDeliverables: response.platform_deliverables,
    propertyTimezone: response.propertyTimezone,
    hotelLocation: response.hotel_location,
    hotelWebsite: response.hotel_website,
    hotelAbout: response.hotel_about,
    hotelPhone: response.hotel_phone,
    hotelAgreedAt: response.hotel_agreed_at ? new Date(response.hotel_agreed_at) : null,
    creatorAgreedAt: response.creator_agreed_at ? new Date(response.creator_agreed_at) : null,
    consent: response.consent,
    respondedAt: response.responded_at,
    cancelledAt: response.cancelled_at,
    completedAt: response.completed_at,
    listingImages: response.listingImages || response.listing_images || [],
    creatorRequirements:
      response.creatorRequirements ||
      (response.creator_requirements
        ? {
            platforms: response.creator_requirements.platforms,
            targetCountries: response.creator_requirements.target_countries,
            targetAgeMin: response.creator_requirements.target_age_min,
            targetAgeMax: response.creator_requirements.target_age_max,
          }
        : undefined),
  } as DetailedCollaboration;

  return result;
}

function toTargetSide(value?: string): MarketplaceCollaborationSide | undefined {
  return value === "creator" || value === "hotel" ? value : undefined;
}

function toTargetCollaborationStatus(value?: string): MarketplaceCollaborationStatus | undefined {
  if (
    value === "pending" ||
    value === "negotiating" ||
    value === "accepted" ||
    value === "active" ||
    value === "completed" ||
    value === "cancelled" ||
    value === "rejected" ||
    value === "declined"
  ) {
    return value;
  }
  return undefined;
}

function toLegacyCollaborationResponse(
  collaboration: MarketplaceCollaborationRead,
): CollaborationResponse {
  const creatorPlatforms = collaboration.creator.platforms ?? [];
  const paidAmount = collaboration.terms.paidAmount ? Number(collaboration.terms.paidAmount) : null;
  const creatorFee = collaboration.terms.affiliateCommissionPercentage
    ? Number(collaboration.terms.affiliateCommissionPercentage)
    : null;
  const collaborationType = toLegacyCollaborationType(
    collaboration.compensationType,
    collaboration.terms.affiliateEnabled,
    collaboration.terms.affiliateCommissionPercentage,
  );

  return {
    id: collaboration.collaborationId,
    initiator_type: collaboration.initiatorSide,
    is_initiator: collaboration.isInitiator,
    status: collaboration.status,
    creator_id: collaboration.creatorId,
    creator_name: collaboration.creator.displayName,
    creator_profile_picture: collaboration.creator.avatarUrl,
    handle: creatorPlatforms[0]?.handle ?? null,
    creator_location: collaboration.creator.location,
    creator_portfolio_link: collaboration.creator.portfolioUrl,
    portfolio_link: collaboration.creator.portfolioUrl,
    creator_type:
      collaboration.creator.creatorType === "travel"
        ? "Travel"
        : collaboration.creator.creatorType === "lifestyle"
          ? "Lifestyle"
          : null,
    platforms: creatorPlatforms.map((platform) => ({
      name: platform.platform,
      handle: platform.handle,
      profile_url: platform.profileUrl,
      followers: platform.followerCount,
      engagement_rate: platform.engagementRate,
      top_countries: platform.audienceCountries,
      top_age_groups: platform.audienceAgeGroups,
      gender_split: platform.audienceGenderSplit,
    })),
    total_followers: creatorPlatforms.reduce(
      (total, platform) => total + platform.followerCount,
      0,
    ),
    avg_engagement_rate: weightedEngagementRate(creatorPlatforms),
    active_platform: creatorPlatforms[0]?.platform,
    primary_handle: creatorPlatforms[0]?.handle,
    is_verified:
      creatorPlatforms.length === 0 ||
      creatorPlatforms.some((platform) => platform.verificationStatus === "verified"),
    hotel_id: collaboration.hotelProfileId,
    hotel_name: collaboration.hotel.displayName,
    hotel_picture: collaboration.hotel.avatarUrl,
    propertyTimezone: collaboration.propertyTimezone,
    hotel_location: collaboration.hotelLocation,
    listing_id: collaboration.offerId,
    listing_name: collaboration.offerTitle,
    listing_location: collaboration.hotelLocation ?? "",
    collaboration_type: collaborationType === "Custom" ? null : collaborationType,
    free_stay_min_nights: collaboration.terms.freeStayMinNights,
    free_stay_max_nights: collaboration.terms.freeStayMaxNights,
    paid_amount: paidAmount,
    currency: collaboration.terms.currency,
    discount_percentage: collaboration.terms.discountPercentage,
    creator_fee: creatorFee,
    travel_date_from: collaboration.terms.travelDateFrom,
    travel_date_to: collaboration.terms.travelDateTo,
    preferred_date_from: collaboration.terms.preferredDateFrom,
    preferred_date_to: collaboration.terms.preferredDateTo,
    preferred_months: collaboration.terms.preferredMonths,
    why_great_fit: collaboration.applicationMessage ?? null,
    selectedCompensationOptionId: collaboration.selectedCompensationOptionId,
    cancelledBy: collaboration.cancelledBy,
    platform_deliverables: Array.from(
      new Set(collaboration.deliverables.map((item) => item.platform)),
    ).map((platform) => ({
      platform,
      deliverables: collaboration.deliverables
        .filter((item) => item.platform === platform)
        .map((deliverable) => ({
          id: deliverable.deliverableId,
          type: deliverable.type,
          quantity: deliverable.quantity,
          status: deliverable.status,
          completed: deliverable.status === "completed",
          completed_at: deliverable.completedAt,
        })),
    })),
    hotel_agreed_at: collaboration.hotelAgreedAt ?? null,
    creator_agreed_at: collaboration.creatorAgreedAt ?? null,
    consent: collaboration.creatorConsent ?? null,
    created_at: collaboration.createdAt,
    updated_at: collaboration.updatedAt,
    cancelled_at: null,
    completed_at: null,
  };
}

function weightedEngagementRate(
  platforms: MarketplaceCollaborationRead["creator"]["platforms"],
): number | undefined {
  const followers = platforms.reduce((total, platform) => total + platform.followerCount, 0);
  if (!followers) return platforms[0]?.engagementRate;
  return (
    platforms.reduce(
      (total, platform) => total + platform.followerCount * platform.engagementRate,
      0,
    ) / followers
  );
}

function toLegacyConversationResponse(
  conversation: MarketplaceConversationSummary,
): ConversationResponse {
  return {
    collaboration_id: conversation.collaborationId,
    partner_name: conversation.partnerName,
    partner_avatar: conversation.partnerAvatarUrl,
    last_message_content: conversation.lastMessageContent,
    last_message_at: conversation.lastMessageAt,
    unread_count: conversation.unreadCount,
    collaboration_status: conversation.collaborationStatus,
    my_role: conversation.side,
    listing_name: conversation.offerTitle,
  };
}

function toLegacyMessageResponse(message: MarketplaceCollaborationMessage): MessageResponse {
  const metadata = safeChatMessageMetadata(message.metadata);
  if (
    message.contentType === "image" &&
    metadata &&
    message.metadata?.attachmentValidated === true &&
    typeof message.metadata.mediaObjectId === "string" &&
    typeof message.metadata.attachmentUrl === "string"
  ) {
    Object.assign(metadata, {
      attachmentValidated: true,
      mediaObjectId: message.metadata.mediaObjectId,
      attachmentUrl: message.metadata.attachmentUrl,
      ...(typeof message.metadata.fileName === "string"
        ? { fileName: message.metadata.fileName }
        : {}),
      ...(typeof message.metadata.fileSize === "number"
        ? { fileSize: message.metadata.fileSize }
        : {}),
      ...(typeof message.metadata.contentType === "string"
        ? { contentType: message.metadata.contentType }
        : {}),
    });
  }
  return {
    id: message.messageId,
    collaboration_id: message.collaborationId,
    sender_id: message.senderUserId,
    sender_name: message.senderName,
    sender_avatar: message.senderAvatarUrl,
    sender_side: message.senderSide,
    content: message.content,
    content_type: message.contentType,
    metadata,
    created_at: message.createdAt,
  };
}

function safeChatMessageMetadata(
  metadata: MessageMetadata | Record<string, unknown> | null,
): MessageMetadata | null {
  if (!metadata) return null;
  const safe: MessageMetadata = {};
  if (
    typeof metadata.mediaObjectId === "string" &&
    /^[A-Za-z0-9_-]{1,128}$/.test(metadata.mediaObjectId)
  ) {
    safe.mediaObjectId = metadata.mediaObjectId;
  }
  if (metadata.attachmentSource === "platform_media_migration") {
    safe.attachmentSource = metadata.attachmentSource;
  }
  return Object.keys(safe).length > 0 ? safe : null;
}
