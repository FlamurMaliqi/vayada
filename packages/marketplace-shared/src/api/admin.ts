import type {
  MarketplaceOfferMatchingCriteria,
  MarketplaceOfferMatchingCriteriaWrite,
  MarketplaceOfferRequirementLevel,
} from "@vayada/domain-marketplace";

export type {
  MarketplaceOfferMatchingCriteria,
  MarketplaceOfferMatchingCriteriaWrite,
  MarketplaceOfferRequirementLevel,
} from "@vayada/domain-marketplace";

import {
  type MarketplaceCollaborationRead,
  type MarketplaceCollaborationStatus,
  type MarketplaceCollaborationTermsInput,
  type RespondToMarketplaceCollaborationLifecycleWriteRequest,
} from "./collaborations";
import { vayadaApiClient } from "./client";

export const MARKETPLACE_ADMIN_CONTRACT_VERSION = "marketplace-admin.v1" as const;

export type MarketplaceAdminContractVersion = typeof MARKETPLACE_ADMIN_CONTRACT_VERSION;

export type MarketplaceAdminAuthorizationMode =
  | "platform_organization_membership"
  | "legacy_superadmin_fallback";

export type MarketplaceAdminPagination = {
  page: number;
  pageSize: number;
  total: number;
};

export type MarketplaceAdminCollaborationsInput = {
  page?: number;
  pageSize?: number;
  status?: MarketplaceCollaborationStatus | "all";
  search?: string;
};

export type MarketplaceAdminCollaboration = MarketplaceCollaborationRead & {
  applicationMessage: string | null;
  hotelAgreedAt: string | null;
  creatorAgreedAt: string | null;
  completedAt: string | null;
  cancelledAt: string | null;
};

export type MarketplaceAdminCollaborationsResponse = {
  contractVersion: MarketplaceAdminContractVersion;
  authorizationMode: MarketplaceAdminAuthorizationMode;
  collaborations: MarketplaceAdminCollaboration[];
  pagination: MarketplaceAdminPagination;
};

export type MarketplaceAdminCollaborationLifecycleWriteResponse = {
  contractVersion: "marketplace-collaboration-lifecycle-writes.v1";
  command: {
    action: "respond" | "approve_terms";
    idempotencyKey: string;
    acceptedAt?: string;
  };
  collaboration: MarketplaceAdminCollaboration;
  sideEffects: { type: string; idempotencyKey?: string }[];
};

export type MarketplacePlatformName =
  | "instagram"
  | "tiktok"
  | "youtube"
  | "facebook"
  | "blog"
  | "x"
  | "other";

export type MarketplaceOfferStatus =
  | "draft"
  | "pending"
  | "verified"
  | "rejected"
  | "suspended"
  | "archived";

export type MarketplaceOfferCompensationOptionWrite = {
  compensationType: "free_stay" | "paid" | "discount" | "affiliate";
  availabilityMonths: string[];
  platforms: MarketplacePlatformName[];
  freeStayMinNights: number | null;
  freeStayMaxNights: number | null;
  paidMaxAmount: string | null;
  discountPercentage: number | null;
  commissionPercentage: number | null;
  minFollowers: number | null;
  followerRequirementLevel?: MarketplaceOfferRequirementLevel | null;
  currency: string | null;
  termsSummary: string | null;
};

export type MarketplaceOfferCreatorRequirementsWrite = {
  platforms: MarketplacePlatformName[];
  platformRequirementLevel?: MarketplaceOfferRequirementLevel | null;
  targetCountries: string[];
  targetCountriesRequirementLevel?: MarketplaceOfferRequirementLevel | null;
  targetAgeMin: number | null;
  targetAgeMax: number | null;
  targetAgeGroups: string[];
  creatorTypes: ("lifestyle" | "travel" | "other")[];
  creatorTypesRequirementLevel?: MarketplaceOfferRequirementLevel | null;
};

export type MarketplaceOfferDeliverableWrite = {
  platform: MarketplacePlatformName;
  deliverableType: string;
  quantity: number;
  timingGuidance?: string | null;
  requirementLevel?: MarketplaceOfferRequirementLevel | null;
};

export type MarketplaceAdminCreateOfferRequest = {
  title: string;
  offerSummary?: string | null;
  deliverables: MarketplaceOfferDeliverableWrite[];
  compensationOptions: MarketplaceOfferCompensationOptionWrite[];
  creatorRequirements: MarketplaceOfferCreatorRequirementsWrite;
  matchingCriteria?: MarketplaceOfferMatchingCriteriaWrite | null;
};

export type MarketplaceAdminUpdateOfferRequest = Partial<
  Omit<
    MarketplaceAdminCreateOfferRequest,
    "deliverables" | "compensationOptions" | "creatorRequirements"
  >
> & {
  deliverables?: MarketplaceOfferDeliverableWrite[];
  compensationOptions?: MarketplaceOfferCompensationOptionWrite[];
  creatorRequirements?: MarketplaceOfferCreatorRequirementsWrite | null;
  matchingCriteria?: MarketplaceOfferMatchingCriteriaWrite | null;
};

export type MarketplaceAdminOffer = {
  contractVersion: MarketplaceAdminContractVersion;
  authorizationMode: MarketplaceAdminAuthorizationMode;
  offerId: string;
  propertyId: string;
  offerStatus: MarketplaceOfferStatus;
  title: string;
  offerSummary: string | null;
  media: Array<{
    mediaObjectId: string | null;
    url: string | null;
    approvalStatus: "pending_domain_approval" | "approved";
    lifecycleStatus: "staged" | "active";
  }>;
  deliverables: (MarketplaceOfferDeliverableWrite & { deliverableId: string })[];
  compensationOptions: (MarketplaceOfferCompensationOptionWrite & {
    compensationOptionId: string;
  })[];
  creatorRequirements: MarketplaceOfferCreatorRequirementsWrite | null;
  matchingCriteria: MarketplaceOfferMatchingCriteria | null;
  createdAt: string;
  updatedAt: string;
};

export type MarketplaceAdminHotelReviewProfile = {
  propertyId: string;
  displayName: string;
  location: string;
  hostSummary: string | null;
  profileStatus: "pending" | "verified" | "rejected" | "suspended" | "archived";
  createdAt: string;
  updatedAt: string;
};

export type MarketplaceAdminHotelReviewResponse = {
  contractVersion: MarketplaceAdminContractVersion;
  authorizationMode: MarketplaceAdminAuthorizationMode;
  userId: string;
  profile: MarketplaceAdminHotelReviewProfile | null;
  offers: MarketplaceAdminOffer[];
};

export const MARKETPLACE_ADMIN_CREATOR_PROFILE_STATUSES = [
  "pending",
  "active",
  "rejected",
  "suspended",
  "archived",
] as const;

export type MarketplaceAdminCreatorProfileStatus =
  (typeof MARKETPLACE_ADMIN_CREATOR_PROFILE_STATUSES)[number];

export type MarketplaceAdminCreatorReviewProfile = {
  creatorProfileId: string;
  displayName: string | null;
  locationText: string | null;
  shortDescription: string | null;
  portfolioUrl: string | null;
  phone: string | null;
  profilePictureUrl: string | null;
  profilePictureMediaObjectId: string | null;
  profileComplete: boolean;
  profileCompletedAt: string | null;
  profileStatus: MarketplaceAdminCreatorProfileStatus;
  platforms: Array<{
    platformId: string;
    platform: MarketplacePlatformName;
    handle: string;
    profileUrl?: string | null;
    followerCount: number;
    engagementRate: number;
    audienceCountries?: { country: string; percentage: number }[];
    audienceAgeGroups?: { ageRange: string; percentage: number }[];
    audienceGenderSplit?: { male: number; female: number; other?: number } | null;
    createdAt: string;
    updatedAt: string;
  }>;
  createdAt: string;
  updatedAt: string;
};

export type MarketplaceAdminCreatorReviewResponse = {
  contractVersion: MarketplaceAdminContractVersion;
  authorizationMode: MarketplaceAdminAuthorizationMode;
  userId: string;
  profile: MarketplaceAdminCreatorReviewProfile | null;
  moderation: MarketplaceAdminCreatorModerationCapabilities;
};

export type MarketplaceAdminCreatorModerationTargetStatus = Exclude<
  MarketplaceAdminCreatorProfileStatus,
  "pending"
>;

export type MarketplaceAdminCreatorModerationCapabilities = {
  allowed: boolean;
  allowedTransitions: MarketplaceAdminCreatorModerationTargetStatus[];
};

export type MarketplaceAdminCreatorModerationRequest = {
  expectedStatus: MarketplaceAdminCreatorProfileStatus;
  nextStatus: MarketplaceAdminCreatorModerationTargetStatus;
  reason: string;
};

export type MarketplaceAdminCreatorModerationResponse = {
  contractVersion: "marketplace-creator-moderation.v1";
  outcome: "transitioned" | "unchanged";
  creatorProfileId: string;
  previousStatus: MarketplaceAdminCreatorProfileStatus;
  profileStatus: MarketplaceAdminCreatorModerationTargetStatus;
  reason: string;
  moderatedByUserId: string;
  moderatedAt: string;
};

export function isMarketplaceAdminCreatorModerationReason(value: unknown): value is string {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > 1000 ||
    /[\u0000-\u001f\u007f]/.test(value)
  ) {
    return false;
  }
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      if (index + 1 >= value.length) return false;
      const next = value.charCodeAt(index + 1);
      if (next < 0xdc00 || next > 0xdfff) return false;
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return false;
    }
  }
  return true;
}

export type MarketplaceAdminDeleteOfferResponse = {
  contractVersion: MarketplaceAdminContractVersion;
  authorizationMode: MarketplaceAdminAuthorizationMode;
  deletedOffer: {
    offerId: string;
    title: string;
  };
};

export const marketplaceAdminEndpoints = {
  collaborations: (input: MarketplaceAdminCollaborationsInput = {}) =>
    `/api/marketplace/admin/collaborations${toAdminCollaborationsQuery(input)}`,
  respondAsHotel: (collaborationId: string) =>
    `/api/marketplace/admin/collaborations/${encodeURIComponent(collaborationId)}/respond`,
  approveAsHotel: (collaborationId: string) =>
    `/api/marketplace/admin/collaborations/${encodeURIComponent(collaborationId)}/approve`,
  createOffer: (hotelUserId: string) =>
    `/api/marketplace/admin/users/${encodeURIComponent(hotelUserId)}/offers`,
  hotelReview: (hotelUserId: string) =>
    `/api/marketplace/admin/users/${encodeURIComponent(hotelUserId)}/review`,
  creatorReview: (userId: string) =>
    `/api/marketplace/admin/users/${encodeURIComponent(userId)}/review/creator`,
  creatorModeration: (creatorProfileId: string) =>
    `/api/marketplace/admin/creators/${encodeURIComponent(creatorProfileId)}/moderation`,
  updateOffer: (hotelUserId: string, offerId: string) =>
    `/api/marketplace/admin/users/${encodeURIComponent(
      hotelUserId,
    )}/offers/${encodeURIComponent(offerId)}`,
  verifyOffer: (hotelUserId: string, offerId: string) =>
    `/api/marketplace/admin/users/${encodeURIComponent(
      hotelUserId,
    )}/offers/${encodeURIComponent(offerId)}/verify`,
  deleteOffer: (hotelUserId: string, offerId: string) =>
    `/api/marketplace/admin/users/${encodeURIComponent(
      hotelUserId,
    )}/offers/${encodeURIComponent(offerId)}`,
} as const;

export async function getMarketplaceAdminCollaborations(
  input: MarketplaceAdminCollaborationsInput = {},
): Promise<MarketplaceAdminCollaborationsResponse> {
  return vayadaApiClient.get<MarketplaceAdminCollaborationsResponse>(
    marketplaceAdminEndpoints.collaborations(input),
  );
}

export async function respondToMarketplaceAdminCollaborationAsHotel(
  collaborationId: string,
  request: RespondToMarketplaceCollaborationLifecycleWriteRequest,
): Promise<MarketplaceAdminCollaborationLifecycleWriteResponse> {
  return vayadaApiClient.post<MarketplaceAdminCollaborationLifecycleWriteResponse>(
    marketplaceAdminEndpoints.respondAsHotel(collaborationId),
    { ...request, side: "hotel" },
    toIdempotencyOptions(request.idempotencyKey),
  );
}

export async function approveMarketplaceAdminCollaborationAsHotel(
  collaborationId: string,
  request: { idempotencyKey: string; acceptedTermsVersion?: string },
): Promise<MarketplaceAdminCollaborationLifecycleWriteResponse> {
  return vayadaApiClient.post<MarketplaceAdminCollaborationLifecycleWriteResponse>(
    marketplaceAdminEndpoints.approveAsHotel(collaborationId),
    { ...request, side: "hotel" },
    toIdempotencyOptions(request.idempotencyKey),
  );
}

export async function createMarketplaceAdminOffer(
  hotelUserId: string,
  request: MarketplaceAdminCreateOfferRequest,
): Promise<MarketplaceAdminOffer> {
  return vayadaApiClient.post<MarketplaceAdminOffer>(
    marketplaceAdminEndpoints.createOffer(hotelUserId),
    request,
  );
}

export async function getMarketplaceAdminHotelReview(
  hotelUserId: string,
): Promise<MarketplaceAdminHotelReviewResponse> {
  return vayadaApiClient.get<MarketplaceAdminHotelReviewResponse>(
    marketplaceAdminEndpoints.hotelReview(hotelUserId),
  );
}

export async function getMarketplaceAdminCreatorReview(
  userId: string,
): Promise<MarketplaceAdminCreatorReviewResponse> {
  return vayadaApiClient.get<MarketplaceAdminCreatorReviewResponse>(
    marketplaceAdminEndpoints.creatorReview(userId),
  );
}

export async function moderateMarketplaceAdminCreatorProfile(
  creatorProfileId: string,
  request: MarketplaceAdminCreatorModerationRequest,
  idempotencyKey: string,
): Promise<MarketplaceAdminCreatorModerationResponse> {
  return vayadaApiClient.post<MarketplaceAdminCreatorModerationResponse>(
    marketplaceAdminEndpoints.creatorModeration(creatorProfileId),
    request,
    toIdempotencyOptions(idempotencyKey),
  );
}

export function buildMarketplaceAdminCreatorModerationIdempotencyKey(input: {
  creatorProfileId: string;
  nextStatus: MarketplaceAdminCreatorModerationTargetStatus;
  nonce: string;
}): string {
  return `marketplace.admin.creator.${input.nextStatus}:${sanitizeIdempotencySegment(
    input.creatorProfileId,
  )}:${sanitizeIdempotencySegment(input.nonce)}:v1`;
}

export async function updateMarketplaceAdminOffer(
  hotelUserId: string,
  offerId: string,
  request: MarketplaceAdminUpdateOfferRequest,
): Promise<MarketplaceAdminOffer> {
  return vayadaApiClient.put<MarketplaceAdminOffer>(
    marketplaceAdminEndpoints.updateOffer(hotelUserId, offerId),
    request,
  );
}

export async function deleteMarketplaceAdminOffer(
  hotelUserId: string,
  offerId: string,
): Promise<MarketplaceAdminDeleteOfferResponse> {
  return vayadaApiClient.delete<MarketplaceAdminDeleteOfferResponse>(
    marketplaceAdminEndpoints.deleteOffer(hotelUserId, offerId),
  );
}

export async function verifyMarketplaceAdminOffer(
  hotelUserId: string,
  offerId: string,
  mediaObjectIds?: string[],
): Promise<MarketplaceAdminOffer> {
  return vayadaApiClient.post<MarketplaceAdminOffer>(
    marketplaceAdminEndpoints.verifyOffer(hotelUserId, offerId),
    mediaObjectIds ? { mediaObjectIds } : undefined,
  );
}

export function buildMarketplaceAdminCollaborationIdempotencyKey(input: {
  action: "respond" | "approve_terms";
  collaborationId: string;
  nonce: string;
}): string {
  return `marketplace.admin.collaboration.${input.action}:${sanitizeIdempotencySegment(
    input.collaborationId,
  )}:${sanitizeIdempotencySegment(input.nonce)}:v1`;
}

export type { MarketplaceCollaborationTermsInput };

function toAdminCollaborationsQuery(input: MarketplaceAdminCollaborationsInput): string {
  const params = new URLSearchParams();
  if (input.page !== undefined) params.set("page", String(input.page));
  if (input.pageSize !== undefined) params.set("pageSize", String(input.pageSize));
  if (input.status && input.status !== "all") params.set("status", input.status);
  if (input.search) params.set("search", input.search);
  const query = params.toString();
  return query ? `?${query}` : "";
}

function sanitizeIdempotencySegment(value: string): string {
  return (
    value
      .trim()
      .replace(/[^A-Za-z0-9._-]+/g, "_")
      .replace(/^_+|_+$/g, "") || "unknown"
  );
}

function toIdempotencyOptions(idempotencyKey: string): RequestInit {
  return { headers: { "Idempotency-Key": idempotencyKey } };
}
