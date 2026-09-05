import { vayadaApiClient } from "./client";

export const MARKETPLACE_COLLABORATION_READS_CONTRACT_VERSION =
  "marketplace-collaboration-reads.v1" as const;

export type MarketplaceCollaborationReadsContractVersion =
  typeof MARKETPLACE_COLLABORATION_READS_CONTRACT_VERSION;

export type MarketplaceCollaborationSide = "creator" | "hotel";

export type MarketplaceCollaborationStatus =
  | "pending"
  | "negotiating"
  | "accepted"
  | "active"
  | "completed"
  | "cancelled"
  | "rejected"
  | "declined";

export type MarketplaceCompensationType = "free_stay" | "paid" | "discount" | "custom";

export type LegacyCollaborationType = "Free Stay" | "Paid" | "Discount" | "Custom" | "Affiliate";

export function toLegacyCollaborationType(
  value: MarketplaceCompensationType | null,
  affiliateEnabled = false,
  affiliateCommissionPercentage: string | null = null,
): LegacyCollaborationType | null {
  switch (value) {
    case "free_stay":
      return "Free Stay";
    case "paid":
      return "Paid";
    case "discount":
      return "Discount";
    case "custom":
      return "Custom";
    default:
      return affiliateEnabled && affiliateCommissionPercentage !== null ? "Affiliate" : null;
  }
}

export type MarketplaceCollaborationAuthorizationMode =
  | "creator_workspace_resource_link"
  | "hotel_group_resource_link";

export type MarketplaceCollaborationParticipant = {
  side: MarketplaceCollaborationSide;
  organizationId: string;
  profileId: string;
  displayName: string;
  avatarUrl: string | null;
};

export type MarketplaceCollaborationCreatorPlatform = {
  platform: string;
  handle: string;
  profileUrl: string | null;
  followerCount: number;
  engagementRate: number;
  audienceCountries: Array<{ country: string; percentage: number }>;
  audienceAgeGroups: Array<{ ageRange: string; percentage: number }>;
  audienceGenderSplit: { male: number; female: number; other?: number } | null;
  verificationStatus: "unverified" | "verified" | "rejected" | "stale";
};

export type MarketplaceCollaborationCreatorParticipant = MarketplaceCollaborationParticipant & {
  location: string | null;
  portfolioUrl: string | null;
  creatorType: string;
  platforms: MarketplaceCollaborationCreatorPlatform[];
};

export type MarketplaceCollaborationDeliverable = {
  deliverableId: string;
  platform: string;
  type: string;
  quantity: number;
  status: "pending" | "completed";
  completedAt: string | null;
};

export type MarketplaceCollaborationRead = {
  contractVersion: MarketplaceCollaborationReadsContractVersion;
  authorizationMode: MarketplaceCollaborationAuthorizationMode;
  collaborationId: string;
  offerId: string;
  creatorId: string;
  hotelProfileId: string;
  side: MarketplaceCollaborationSide;
  initiatorSide: MarketplaceCollaborationSide;
  isInitiator: boolean;
  status: MarketplaceCollaborationStatus;
  compensationType: MarketplaceCompensationType | null;
  offerTitle: string;
  propertyTimezone?: string | null;
  hotelLocation: string | null;
  applicationMessage?: string | null;
  selectedCompensationOptionId?: string | null;
  cancelledBy?: MarketplaceCollaborationSide | null;
  creatorConsent?: boolean | null;
  creatorAgreedAt?: string | null;
  hotelAgreedAt?: string | null;
  creator: MarketplaceCollaborationCreatorParticipant;
  hotel: MarketplaceCollaborationParticipant;
  terms: {
    freeStayMinNights: number | null;
    freeStayMaxNights: number | null;
    paidAmount: string | null;
    currency: string | null;
    discountPercentage: number | null;
    affiliateEnabled: boolean;
    affiliateCommissionPercentage: string | null;
    travelDateFrom: string | null;
    travelDateTo: string | null;
    preferredDateFrom: string | null;
    preferredDateTo: string | null;
    preferredMonths: string[];
  };
  deliverables: MarketplaceCollaborationDeliverable[];
  lastMessageAt: string | null;
  createdAt: string;
  updatedAt: string;
};

export type MarketplaceCollaborationListInput = {
  side: MarketplaceCollaborationSide;
  status?: MarketplaceCollaborationStatus;
  initiatedBy?: MarketplaceCollaborationSide;
  offerId?: string;
};

export type MarketplaceCollaborationListResponse = {
  contractVersion: MarketplaceCollaborationReadsContractVersion;
  authorizationMode: MarketplaceCollaborationAuthorizationMode;
  items: MarketplaceCollaborationRead[];
};

export type MarketplaceConversationSummary = {
  contractVersion: MarketplaceCollaborationReadsContractVersion;
  collaborationId: string;
  side: MarketplaceCollaborationSide;
  partnerName: string;
  partnerAvatarUrl: string | null;
  offerTitle: string | null;
  collaborationStatus: MarketplaceCollaborationStatus;
  lastMessageContent: string | null;
  lastMessageAt: string | null;
  unreadCount: number;
};

export type MarketplaceConversationPage = {
  contractVersion: MarketplaceCollaborationReadsContractVersion;
  items: MarketplaceConversationSummary[];
  nextCursor: string | null;
  hasMore: boolean;
};

export type MarketplaceCollaborationMessage = {
  contractVersion: MarketplaceCollaborationReadsContractVersion;
  messageId: string;
  collaborationId: string;
  senderUserId: string | null;
  senderName: string | null;
  senderAvatarUrl: string | null;
  senderSide: MarketplaceCollaborationSide | null;
  content: string;
  contentType: "text" | "image" | "system";
  metadata: Record<string, unknown> | null;
  createdAt: string;
};

export type MarketplaceCollaborationMessagesResponse = {
  contractVersion: MarketplaceCollaborationReadsContractVersion;
  collaborationId: string;
  authorizationMode: MarketplaceCollaborationAuthorizationMode;
  items: MarketplaceCollaborationMessage[];
  nextCursor?: string | null;
  hasMore?: boolean;
};

export type MarketplaceMessageCursor = {
  createdAt: string;
  messageId: string;
};

export type SendMarketplaceCollaborationMessageRequest = {
  content: string;
  idempotencyKey: string;
  contentType?: "text" | "image";
  mediaObjectId?: string;
};

export const MARKETPLACE_COLLABORATION_LIFECYCLE_WRITES_CONTRACT_VERSION =
  "marketplace-collaboration-lifecycle-writes.v1" as const;

export type MarketplaceCollaborationLifecycleWritesContractVersion =
  typeof MARKETPLACE_COLLABORATION_LIFECYCLE_WRITES_CONTRACT_VERSION;

export const MARKETPLACE_COLLABORATION_LIFECYCLE_WRITE_ACTIONS = [
  "create",
  "respond",
  "edit_application",
  "update_terms",
  "approve_terms",
  "cancel",
  "toggle_deliverable",
  "rate_creator",
] as const;

export type MarketplaceCollaborationLifecycleWriteAction =
  (typeof MARKETPLACE_COLLABORATION_LIFECYCLE_WRITE_ACTIONS)[number];

export type MarketplaceCollaborationLifecycleSideEffect =
  | {
      type:
        | "marketplace.collaboration.accepted"
        | "marketplace.collaboration.system_message_requested"
        | "marketplace.collaboration.notification_requested";
      idempotencyKey?: string;
    }
  | {
      type: "marketplace.affiliate.provision.command_requested";
      idempotencyKey: string;
    };

type MarketplaceCollaborationLifecycleWriteCommandBase = {
  action: MarketplaceCollaborationLifecycleWriteAction;
  idempotencyKey: string;
  replayed?: boolean;
  acceptedAt?: string;
};

export type MarketplaceCollaborationLifecycleWriteCommand =
  | (MarketplaceCollaborationLifecycleWriteCommandBase & {
      action: Exclude<MarketplaceCollaborationLifecycleWriteAction, "rate_creator">;
    })
  | (MarketplaceCollaborationLifecycleWriteCommandBase & {
      action: "rate_creator";
      ratingId: string;
    });

export type MarketplaceCollaborationLifecycleWriteResponse = {
  contractVersion: MarketplaceCollaborationLifecycleWritesContractVersion;
  command: MarketplaceCollaborationLifecycleWriteCommand;
  collaboration: MarketplaceCollaborationRead;
  sideEffects: MarketplaceCollaborationLifecycleSideEffect[];
};

export type MarketplaceCollaborationLifecycleWriteBaseRequest = {
  idempotencyKey: string;
  side?: MarketplaceCollaborationSide;
};

export type MarketplaceCollaborationTermsInput = {
  compensationType?: MarketplaceCompensationType | null;
  freeStayMinNights?: number | null;
  freeStayMaxNights?: number | null;
  paidAmount?: string | null;
  currency?: string | null;
  discountPercentage?: number | null;
  affiliateEnabled?: boolean | null;
  affiliateCommissionPercentage?: string | null;
  travelDateFrom?: string | null;
  travelDateTo?: string | null;
  preferredDateFrom?: string | null;
  preferredDateTo?: string | null;
  preferredMonths?: string[];
};

export type MarketplaceCollaborationDeliverableInput = {
  deliverableId?: string;
  platform: string;
  type: string;
  quantity: number;
};

type MarketplaceCollaborationCreateBaseRequest = Omit<
  MarketplaceCollaborationLifecycleWriteBaseRequest,
  "side"
> & {
  side?: never;
  initiatorSide?: never;
  offerId: string;
  terms?: MarketplaceCollaborationTermsInput;
  deliverables?: MarketplaceCollaborationDeliverableInput[];
};

export type CreateMarketplaceCollaborationLifecycleWriteRequest =
  | (MarketplaceCollaborationCreateBaseRequest & {
      compensationOptionId: string;
      whyGreatFit: string;
      consent: true;
      creatorId?: never;
      message?: never;
    })
  | (MarketplaceCollaborationCreateBaseRequest & {
      creatorId: string;
      message?: string;
      compensationOptionId?: never;
      whyGreatFit?: never;
      consent?: never;
    });

export type RespondToMarketplaceCollaborationLifecycleWriteRequest =
  MarketplaceCollaborationLifecycleWriteBaseRequest & {
    status: "accepted" | "declined";
    responseMessage?: string;
    expectedUpdatedAt?: string;
  };

export type UpdateMarketplaceCollaborationTermsLifecycleWriteRequest =
  MarketplaceCollaborationLifecycleWriteBaseRequest & {
    terms: MarketplaceCollaborationTermsInput;
    deliverables?: MarketplaceCollaborationDeliverableInput[];
  };

export type ApproveMarketplaceCollaborationTermsLifecycleWriteRequest =
  MarketplaceCollaborationLifecycleWriteBaseRequest & {
    acceptedTermsVersion?: string;
  };

export type CancelMarketplaceCollaborationLifecycleWriteRequest =
  MarketplaceCollaborationLifecycleWriteBaseRequest & {
    reason?: string;
    pendingOnly?: boolean;
  };

export type ToggleMarketplaceCollaborationDeliverableLifecycleWriteRequest =
  MarketplaceCollaborationLifecycleWriteBaseRequest;

export type RateMarketplaceCollaborationCreatorLifecycleWriteRequest =
  MarketplaceCollaborationLifecycleWriteBaseRequest & {
    rating: number;
    comment?: string;
  };

export const marketplaceCollaborationEndpoints = {
  myCollaborations: (input: MarketplaceCollaborationListInput) =>
    `/api/marketplace/collaborations/me${toCollaborationQuery(input)}`,
  collaboration: (collaborationId: string, side: MarketplaceCollaborationSide) =>
    `/api/marketplace/collaborations/${encodeURIComponent(collaborationId)}?side=${side}`,
  conversations: (
    input: {
      side?: MarketplaceCollaborationSide;
      cursor?: string;
      limit?: number;
      search?: string;
    } = {},
  ) => `/api/marketplace/collaborations/conversations${toConversationQuery(input)}`,
  messages: (
    collaborationId: string,
    input: { side?: MarketplaceCollaborationSide; before?: string; cursor?: string },
  ) =>
    `/api/marketplace/collaborations/${encodeURIComponent(collaborationId)}/messages${toMessageQuery(input)}`,
  markRead: (collaborationId: string) =>
    `/api/marketplace/collaborations/${encodeURIComponent(collaborationId)}/read`,
  create: () => "/api/marketplace/collaborations",
  respond: (collaborationId: string) =>
    `/api/marketplace/collaborations/${encodeURIComponent(collaborationId)}/respond`,
  updateTerms: (collaborationId: string) =>
    `/api/marketplace/collaborations/${encodeURIComponent(collaborationId)}/terms`,
  approveTerms: (collaborationId: string) =>
    `/api/marketplace/collaborations/${encodeURIComponent(collaborationId)}/approve`,
  cancel: (collaborationId: string) =>
    `/api/marketplace/collaborations/${encodeURIComponent(collaborationId)}/cancel`,
  toggleDeliverable: (collaborationId: string, deliverableId: string) =>
    `/api/marketplace/collaborations/${encodeURIComponent(
      collaborationId,
    )}/deliverables/${encodeURIComponent(deliverableId)}/toggle`,
  rateCreator: (collaborationId: string) =>
    `/api/marketplace/collaborations/${encodeURIComponent(collaborationId)}/rate`,
} as const;

export async function getMyMarketplaceCollaborations(
  input: MarketplaceCollaborationListInput,
): Promise<MarketplaceCollaborationListResponse> {
  return vayadaApiClient.get<MarketplaceCollaborationListResponse>(
    marketplaceCollaborationEndpoints.myCollaborations(input),
  );
}

export async function getMarketplaceCollaboration(
  collaborationId: string,
  side: MarketplaceCollaborationSide,
): Promise<MarketplaceCollaborationRead> {
  return vayadaApiClient.get<MarketplaceCollaborationRead>(
    marketplaceCollaborationEndpoints.collaboration(collaborationId, side),
  );
}

export async function getMarketplaceConversations(
  side?: MarketplaceCollaborationSide,
): Promise<MarketplaceConversationSummary[]> {
  return vayadaApiClient.get<MarketplaceConversationSummary[]>(
    marketplaceCollaborationEndpoints.conversations({ side }),
  );
}

export async function getMarketplaceConversationPage(
  input: {
    side?: MarketplaceCollaborationSide;
    cursor?: string;
    limit?: number;
    search?: string;
  } = {},
): Promise<MarketplaceConversationPage> {
  return vayadaApiClient.get<MarketplaceConversationPage>(
    marketplaceCollaborationEndpoints.conversations({ ...input, limit: input.limit ?? 100 }),
  );
}

export async function getMarketplaceMessages(
  collaborationId: string,
  input: { side?: MarketplaceCollaborationSide; before?: string; cursor?: string } = {},
): Promise<MarketplaceCollaborationMessagesResponse> {
  return vayadaApiClient.get<MarketplaceCollaborationMessagesResponse>(
    marketplaceCollaborationEndpoints.messages(collaborationId, input),
  );
}

export async function sendMarketplaceCollaborationMessage(
  collaborationId: string,
  request: SendMarketplaceCollaborationMessageRequest,
): Promise<MarketplaceCollaborationMessage> {
  return vayadaApiClient.post<MarketplaceCollaborationMessage>(
    marketplaceCollaborationEndpoints.messages(collaborationId, {}),
    {
      content: request.content,
      contentType: request.contentType ?? "text",
      ...(request.mediaObjectId ? { mediaObjectId: request.mediaObjectId } : {}),
      idempotencyKey: request.idempotencyKey,
    },
    toIdempotencyOptions(request.idempotencyKey),
  );
}

export async function markMarketplaceCollaborationMessagesRead(
  collaborationId: string,
  readThrough: MarketplaceMessageCursor,
): Promise<void> {
  await vayadaApiClient.post<void>(marketplaceCollaborationEndpoints.markRead(collaborationId), {
    readThrough,
  });
}
export async function createMarketplaceCollaboration(
  request: CreateMarketplaceCollaborationLifecycleWriteRequest,
): Promise<MarketplaceCollaborationLifecycleWriteResponse> {
  return vayadaApiClient.post<MarketplaceCollaborationLifecycleWriteResponse>(
    marketplaceCollaborationEndpoints.create(),
    request,
    toIdempotencyOptions(request.idempotencyKey),
  );
}

export async function editMarketplaceCollaborationApplication(
  collaborationId: string,
  request: CreateMarketplaceCollaborationLifecycleWriteRequest & { expectedUpdatedAt: string },
): Promise<MarketplaceCollaborationLifecycleWriteResponse> {
  return vayadaApiClient.put(
    `/api/marketplace/collaborations/${encodeURIComponent(collaborationId)}/application`,
    request,
  );
}

export async function respondToMarketplaceCollaboration(
  collaborationId: string,
  request: RespondToMarketplaceCollaborationLifecycleWriteRequest,
): Promise<MarketplaceCollaborationLifecycleWriteResponse> {
  return vayadaApiClient.post<MarketplaceCollaborationLifecycleWriteResponse>(
    marketplaceCollaborationEndpoints.respond(collaborationId),
    request,
    toIdempotencyOptions(request.idempotencyKey),
  );
}

export async function updateMarketplaceCollaborationTerms(
  collaborationId: string,
  request: UpdateMarketplaceCollaborationTermsLifecycleWriteRequest,
): Promise<MarketplaceCollaborationLifecycleWriteResponse> {
  return vayadaApiClient.put<MarketplaceCollaborationLifecycleWriteResponse>(
    marketplaceCollaborationEndpoints.updateTerms(collaborationId),
    request,
    toIdempotencyOptions(request.idempotencyKey),
  );
}

export async function approveMarketplaceCollaborationTerms(
  collaborationId: string,
  request: ApproveMarketplaceCollaborationTermsLifecycleWriteRequest,
): Promise<MarketplaceCollaborationLifecycleWriteResponse> {
  return vayadaApiClient.post<MarketplaceCollaborationLifecycleWriteResponse>(
    marketplaceCollaborationEndpoints.approveTerms(collaborationId),
    request,
    toIdempotencyOptions(request.idempotencyKey),
  );
}

export async function cancelMarketplaceCollaboration(
  collaborationId: string,
  request: CancelMarketplaceCollaborationLifecycleWriteRequest,
): Promise<MarketplaceCollaborationLifecycleWriteResponse> {
  return vayadaApiClient.post<MarketplaceCollaborationLifecycleWriteResponse>(
    marketplaceCollaborationEndpoints.cancel(collaborationId),
    request,
    toIdempotencyOptions(request.idempotencyKey),
  );
}

export async function toggleMarketplaceCollaborationDeliverable(
  collaborationId: string,
  deliverableId: string,
  request: ToggleMarketplaceCollaborationDeliverableLifecycleWriteRequest,
): Promise<MarketplaceCollaborationLifecycleWriteResponse> {
  return vayadaApiClient.post<MarketplaceCollaborationLifecycleWriteResponse>(
    marketplaceCollaborationEndpoints.toggleDeliverable(collaborationId, deliverableId),
    request,
    toIdempotencyOptions(request.idempotencyKey),
  );
}

export async function rateMarketplaceCollaborationCreator(
  collaborationId: string,
  request: RateMarketplaceCollaborationCreatorLifecycleWriteRequest,
): Promise<MarketplaceCollaborationLifecycleWriteResponse> {
  return vayadaApiClient.post<MarketplaceCollaborationLifecycleWriteResponse>(
    marketplaceCollaborationEndpoints.rateCreator(collaborationId),
    request,
    toIdempotencyOptions(request.idempotencyKey),
  );
}

export function buildMarketplaceCollaborationLifecycleIdempotencyKey(input: {
  action: MarketplaceCollaborationLifecycleWriteAction;
  resourceId: string;
  nonce: string;
}): string {
  return `marketplace.collaboration.${input.action}:${sanitizeIdempotencySegment(
    input.resourceId,
  )}:${sanitizeIdempotencySegment(input.nonce)}:v1`;
}

function toCollaborationQuery(input: MarketplaceCollaborationListInput): string {
  const params = new URLSearchParams({ side: input.side });
  if (input.status) params.set("status", input.status);
  if (input.initiatedBy) params.set("initiatedBy", input.initiatedBy);
  if (input.offerId) params.set("offerId", input.offerId);
  return `?${params.toString()}`;
}

function toMessageQuery(input: {
  side?: MarketplaceCollaborationSide;
  before?: string;
  cursor?: string;
}): string {
  const params = new URLSearchParams();
  if (input.side) params.set("side", input.side);
  if (input.before) params.set("before", input.before);
  if (input.cursor) params.set("cursor", input.cursor);
  const query = params.toString();
  return query ? `?${query}` : "";
}

function toConversationQuery(input: {
  side?: MarketplaceCollaborationSide;
  cursor?: string;
  limit?: number;
  search?: string;
}): string {
  const params = new URLSearchParams();
  if (input.side) params.set("side", input.side);
  if (input.cursor) params.set("cursor", input.cursor);
  if (input.limit) params.set("limit", String(input.limit));
  if (input.search?.trim()) params.set("search", input.search.trim());
  const query = params.toString();
  return query ? `?${query}` : "";
}

function toIdempotencyOptions(idempotencyKey: string): RequestInit {
  return { headers: { "Idempotency-Key": idempotencyKey } };
}

function sanitizeIdempotencySegment(value: string): string {
  return (
    value
      .trim()
      .replace(/[^A-Za-z0-9._-]+/g, "_")
      .replace(/^_+|_+$/g, "") || "unknown"
  );
}
