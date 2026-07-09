import {
  type MarketplaceCollaborationRead,
  type MarketplaceCollaborationStatus,
  type MarketplaceCollaborationTermsInput,
  type RespondToMarketplaceCollaborationLifecycleWriteRequest,
} from "./collaborations";
import { apiClient } from "./client";

export const MARKETPLACE_ADMIN_CONTRACT_VERSION = "marketplace-admin.v1" as const;
const MARKETPLACE_ADMIN_API_PREFIX =
  process.env.NEXT_PUBLIC_AUTHKIT_LOGIN_ENABLED === "false" ? "/admin" : "/api/marketplace/admin";

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

export type MarketplaceAccommodationType =
  | "hotel"
  | "resort"
  | "boutique_hotel"
  | "lodge"
  | "apartment"
  | "villa"
  | "other";

export type MarketplacePlatformName =
  | "instagram"
  | "tiktok"
  | "youtube"
  | "facebook"
  | "blog"
  | "x"
  | "other";

export type MarketplaceHotelListingStatus =
  | "draft"
  | "pending"
  | "verified"
  | "rejected"
  | "suspended"
  | "archived";

export type MarketplaceHotelListingOfferingWrite = {
  collaborationType: "free_stay" | "paid" | "discount" | "affiliate";
  availabilityMonths: string[];
  platforms: MarketplacePlatformName[];
  freeStayMinNights: number | null;
  freeStayMaxNights: number | null;
  paidMaxAmount: string | null;
  discountPercentage: number | null;
  commissionPercentage: number | null;
  minFollowers: number | null;
  currency: string | null;
  termsSummary: string | null;
};

export type MarketplaceHotelListingCreatorRequirementsWrite = {
  platforms: MarketplacePlatformName[];
  targetCountries: string[];
  targetAgeMin: number | null;
  targetAgeMax: number | null;
  targetAgeGroups: string[];
  creatorTypes: ("lifestyle" | "travel" | "other")[];
};

export type MarketplaceAdminCreateHotelListingRequest = {
  title: string;
  listingSummary?: string | null;
  accommodationType?: MarketplaceAccommodationType | null;
  rawLocationText?: string | null;
  imageUrls?: string[];
  collaborationOfferings: MarketplaceHotelListingOfferingWrite[];
  creatorRequirements: MarketplaceHotelListingCreatorRequirementsWrite;
};

export type MarketplaceAdminUpdateHotelListingRequest = Partial<
  Omit<MarketplaceAdminCreateHotelListingRequest, "collaborationOfferings" | "creatorRequirements">
> & {
  collaborationOfferings?: MarketplaceHotelListingOfferingWrite[];
  creatorRequirements?: MarketplaceHotelListingCreatorRequirementsWrite | null;
};

export type MarketplaceAdminHotelListing = {
  contractVersion: MarketplaceAdminContractVersion;
  authorizationMode: MarketplaceAdminAuthorizationMode;
  listingId: string;
  propertyId: string;
  listingStatus: MarketplaceHotelListingStatus;
  title: string;
  listingSummary: string | null;
  accommodationType: MarketplaceAccommodationType | null;
  rawLocationText: string | null;
  imageUrls: string[];
  collaborationOfferings: (MarketplaceHotelListingOfferingWrite & { offeringId: string })[];
  creatorRequirements: MarketplaceHotelListingCreatorRequirementsWrite | null;
  createdAt: string;
  updatedAt: string;
};

export type MarketplaceAdminDeleteHotelListingResponse = {
  contractVersion: MarketplaceAdminContractVersion;
  authorizationMode: MarketplaceAdminAuthorizationMode;
  deletedListing: {
    listingId: string;
    title: string;
  };
};

export const marketplaceAdminEndpoints = {
  collaborations: (input: MarketplaceAdminCollaborationsInput = {}) =>
    `${MARKETPLACE_ADMIN_API_PREFIX}/collaborations${toAdminCollaborationsQuery(input)}`,
  respondAsHotel: (collaborationId: string) =>
    `${MARKETPLACE_ADMIN_API_PREFIX}/collaborations/${encodeURIComponent(collaborationId)}/respond`,
  approveAsHotel: (collaborationId: string) =>
    `${MARKETPLACE_ADMIN_API_PREFIX}/collaborations/${encodeURIComponent(collaborationId)}/approve`,
  createHotelListing: (hotelUserId: string) =>
    `${MARKETPLACE_ADMIN_API_PREFIX}/users/${encodeURIComponent(hotelUserId)}/listings`,
  updateHotelListing: (hotelUserId: string, listingId: string) =>
    `${MARKETPLACE_ADMIN_API_PREFIX}/users/${encodeURIComponent(
      hotelUserId,
    )}/listings/${encodeURIComponent(listingId)}`,
  deleteHotelListing: (hotelUserId: string, listingId: string) =>
    `${MARKETPLACE_ADMIN_API_PREFIX}/users/${encodeURIComponent(
      hotelUserId,
    )}/listings/${encodeURIComponent(listingId)}`,
} as const;

export async function getMarketplaceAdminCollaborations(
  input: MarketplaceAdminCollaborationsInput = {},
): Promise<MarketplaceAdminCollaborationsResponse> {
  return apiClient.get<MarketplaceAdminCollaborationsResponse>(
    marketplaceAdminEndpoints.collaborations(input),
  );
}

export async function respondToMarketplaceAdminCollaborationAsHotel(
  collaborationId: string,
  request: RespondToMarketplaceCollaborationLifecycleWriteRequest,
): Promise<MarketplaceAdminCollaborationLifecycleWriteResponse> {
  return apiClient.post<MarketplaceAdminCollaborationLifecycleWriteResponse>(
    marketplaceAdminEndpoints.respondAsHotel(collaborationId),
    { ...request, side: "hotel" },
    toIdempotencyOptions(request.idempotencyKey),
  );
}

export async function approveMarketplaceAdminCollaborationAsHotel(
  collaborationId: string,
  request: { idempotencyKey: string; acceptedTermsVersion?: string },
): Promise<MarketplaceAdminCollaborationLifecycleWriteResponse> {
  return apiClient.post<MarketplaceAdminCollaborationLifecycleWriteResponse>(
    marketplaceAdminEndpoints.approveAsHotel(collaborationId),
    { ...request, side: "hotel" },
    toIdempotencyOptions(request.idempotencyKey),
  );
}

export async function createMarketplaceAdminHotelListing(
  hotelUserId: string,
  request: MarketplaceAdminCreateHotelListingRequest,
): Promise<MarketplaceAdminHotelListing> {
  return apiClient.post<MarketplaceAdminHotelListing>(
    marketplaceAdminEndpoints.createHotelListing(hotelUserId),
    request,
  );
}

export async function updateMarketplaceAdminHotelListing(
  hotelUserId: string,
  listingId: string,
  request: MarketplaceAdminUpdateHotelListingRequest,
): Promise<MarketplaceAdminHotelListing> {
  return apiClient.put<MarketplaceAdminHotelListing>(
    marketplaceAdminEndpoints.updateHotelListing(hotelUserId, listingId),
    request,
  );
}

export async function deleteMarketplaceAdminHotelListing(
  hotelUserId: string,
  listingId: string,
): Promise<MarketplaceAdminDeleteHotelListingResponse> {
  return apiClient.delete<MarketplaceAdminDeleteHotelListingResponse>(
    marketplaceAdminEndpoints.deleteHotelListing(hotelUserId, listingId),
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
