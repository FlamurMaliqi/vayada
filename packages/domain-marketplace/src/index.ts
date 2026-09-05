/**
 * @vayada/domain-marketplace
 *
 * Typed contracts for Marketplace domain operations. These interfaces define
 * the boundary between Marketplace and downstream domains (Finance/Affiliate)
 * so that Marketplace collaboration acceptance never opens PMS raw tables
 * directly.
 *
 * VAY-653: Replace Marketplace-to-PMS affiliate provisioning cross-DB write.
 */

export * from "./hotelCollaborationPreferences.js";
export * from "./hotelCollaborationPreferenceCommands.js";
export * from "./legacyHotelCollaborationPreferenceDraft.js";
export * from "./affiliateAdmin.js";
export * from "./creatorProfileModeration.js";
export * from "./creatorMatchingPreferences.js";
export * from "./offerMatchingCriteria.js";
export * from "./matchingEvents.js";

import type {
  MarketplaceOfferMatchingCriteria,
  MarketplaceOfferMatchingCriteriaWrite,
  MarketplaceOfferRequirementLevel,
} from "./offerMatchingCriteria.js";
import type {
  MarketplaceCreatorMatchingPreferences,
  MarketplaceCreatorMatchingPreferencesWrite,
} from "./creatorMatchingPreferences.js";

// ---------------------------------------------------------------------------
// Shared scalar types
// ---------------------------------------------------------------------------

export type MarketplaceUtcDateTime = string;
export type MarketplaceDecimalAmount = string;
export type MarketplaceCurrencyCode = string;

// ---------------------------------------------------------------------------
// Creator profile self-service
// ---------------------------------------------------------------------------

export const MARKETPLACE_CREATOR_SELF_SERVICE_CONTRACT_VERSION =
  "marketplace-creator-self-service.v1" as const;

export type MarketplaceCreatorSelfServiceContractVersion =
  typeof MARKETPLACE_CREATOR_SELF_SERVICE_CONTRACT_VERSION;

export const MARKETPLACE_CREATOR_SELF_SERVICE_ENDPOINTS = {
  profileStatus: {
    method: "GET",
    path: "/api/marketplace/creators/me/profile-status",
    doc: "engineering/marketplace-creator-self-service-contract.md",
  },
  profile: {
    method: "GET",
    path: "/api/marketplace/creators/me",
    doc: "engineering/marketplace-creator-self-service-contract.md",
  },
  updateProfile: {
    method: "PUT",
    path: "/api/marketplace/creators/me",
    doc: "engineering/marketplace-creator-self-service-contract.md",
  },
} as const;

// ---------------------------------------------------------------------------
// Hotel profile/offers self-service
// ---------------------------------------------------------------------------

export const MARKETPLACE_HOTEL_SELF_SERVICE_CONTRACT_VERSION =
  "marketplace-hotel-self-service.v1" as const;

export type MarketplaceHotelSelfServiceContractVersion =
  typeof MARKETPLACE_HOTEL_SELF_SERVICE_CONTRACT_VERSION;

export const MARKETPLACE_HOTEL_AUTHORIZATION_MODES = [
  "organization_resource_link",
  "legacy_user_id_fallback",
] as const;

export type MarketplaceHotelAuthorizationMode =
  (typeof MARKETPLACE_HOTEL_AUTHORIZATION_MODES)[number];

export const MARKETPLACE_PLATFORM_NAMES = [
  "instagram",
  "tiktok",
  "youtube",
  "facebook",
  "blog",
  "x",
  "other",
] as const;

export type MarketplacePlatformName = (typeof MARKETPLACE_PLATFORM_NAMES)[number];

export const MARKETPLACE_HOTEL_PROFILE_STATUSES = [
  "pending",
  "verified",
  "rejected",
  "suspended",
  "archived",
] as const;

export type MarketplaceHotelProfileStatus = (typeof MARKETPLACE_HOTEL_PROFILE_STATUSES)[number];

export const MARKETPLACE_OFFER_STATUSES = [
  "draft",
  "pending",
  "verified",
  "rejected",
  "suspended",
  "archived",
] as const;

export type MarketplaceOfferStatus = (typeof MARKETPLACE_OFFER_STATUSES)[number];

export const MARKETPLACE_OFFER_COMPENSATION_TYPES = [
  "free_stay",
  "paid",
  "discount",
  "affiliate",
] as const;

export type MarketplaceOfferCompensationType =
  (typeof MARKETPLACE_OFFER_COMPENSATION_TYPES)[number];

export const MARKETPLACE_COMPENSATION_TYPES = ["free_stay", "paid", "discount", "custom"] as const;

export type MarketplaceCompensationType = (typeof MARKETPLACE_COMPENSATION_TYPES)[number];

export const MARKETPLACE_CREATOR_TYPES = ["lifestyle", "travel", "other"] as const;

export type MarketplaceCreatorType = (typeof MARKETPLACE_CREATOR_TYPES)[number];

export const CREATOR_PROFILE_STATUSES = [
  "pending",
  "active",
  "rejected",
  "suspended",
  "archived",
] as const;

export type CreatorProfileStatus = (typeof CREATOR_PROFILE_STATUSES)[number];

export const CREATOR_PLATFORM_VERIFICATION_STATUSES = [
  "unverified",
  "verified",
  "rejected",
  "stale",
] as const;

export type CreatorPlatformVerificationStatus =
  (typeof CREATOR_PLATFORM_VERIFICATION_STATUSES)[number];

export const CREATOR_PROFILE_MISSING_FIELDS = [
  "displayName",
  "locationText",
  "shortDescription",
  "phone",
  "profilePicture",
  "platforms",
] as const;

export type CreatorProfileMissingField = (typeof CREATOR_PROFILE_MISSING_FIELDS)[number];

export const CREATOR_PROFILE_COMPLETION_STEPS = [
  "add_display_name",
  "set_location",
  "add_short_description",
  "add_phone",
  "add_profile_picture",
  "add_platform",
] as const;

export type CreatorProfileCompletionStep = (typeof CREATOR_PROFILE_COMPLETION_STEPS)[number];

export type CreatorProfileAudienceCountry = {
  country: string;
  percentage: number;
};

export type CreatorProfileAudienceAgeGroup = {
  ageRange: string;
  percentage: number;
};

export type CreatorProfileAudienceGenderSplit = {
  male: number;
  female: number;
  other?: number;
};

export type CreatorProfilePlatform = {
  platformId: string;
  platform: MarketplacePlatformName;
  handle: string;
  profileUrl: string | null;
  followerCount: number;
  engagementRate: number;
  audienceCountries: CreatorProfileAudienceCountry[];
  audienceAgeGroups: CreatorProfileAudienceAgeGroup[];
  audienceGenderSplit: CreatorProfileAudienceGenderSplit | null;
  verificationStatus: CreatorPlatformVerificationStatus;
};

export type CreatorProfilePlatformInput = {
  platformId?: string | null;
  platform: MarketplacePlatformName;
  handle: string;
  profileUrl?: string | null;
  followerCount: number;
  engagementRate: number;
  audienceCountries?: CreatorProfileAudienceCountry[];
  audienceAgeGroups?: CreatorProfileAudienceAgeGroup[];
  audienceGenderSplit?: CreatorProfileAudienceGenderSplit | null;
};

export const CREATOR_PLATFORM_CONNECTION_CONTRACT_VERSION =
  "marketplace-creator-platform-connections.v1" as const;

export const CREATOR_PLATFORM_PROVIDERS = ["meta", "tiktok", "google"] as const;
export type CreatorPlatformProvider = (typeof CREATOR_PLATFORM_PROVIDERS)[number];

export const CONNECTABLE_CREATOR_PLATFORMS = [
  "instagram",
  "facebook",
  "tiktok",
  "youtube",
] as const;
export type ConnectableCreatorPlatform = (typeof CONNECTABLE_CREATOR_PLATFORMS)[number];

export const CREATOR_PLATFORM_AUTHORIZATION_STATUSES = [
  "authorizing",
  "processing",
  "pending_account_selection",
  "active",
  "failed",
  "expired",
] as const;
export type CreatorPlatformAuthorizationStatus =
  (typeof CREATOR_PLATFORM_AUTHORIZATION_STATUSES)[number];

export const CREATOR_PLATFORM_CONNECTION_STATUSES = [
  "active",
  "reconnect_required",
  "revoked",
  "sync_failed",
] as const;
export type CreatorPlatformConnectionStatus = (typeof CREATOR_PLATFORM_CONNECTION_STATUSES)[number];

export const CREATOR_PLATFORM_IMPORT_FIELDS = [
  "followerCount",
  "reach",
  "views",
  "contentItemCount",
  "likes",
  "comments",
  "shares",
  "engagementRate",
  "audienceCountries",
  "audienceAgeGroups",
  "audienceGenderSplit",
] as const;
export type CreatorPlatformImportField = (typeof CREATOR_PLATFORM_IMPORT_FIELDS)[number];

export const CREATOR_PLATFORM_UNAVAILABLE_REASONS = [
  "unsupported",
  "privacy_threshold",
  "permission_missing",
  "insufficient_data",
  "account_type_ineligible",
  "provider_omitted",
] as const;
export type CreatorPlatformUnavailableReason =
  (typeof CREATOR_PLATFORM_UNAVAILABLE_REASONS)[number];

export type CreatorPlatformUnavailableField = {
  field: CreatorPlatformImportField;
  reason: CreatorPlatformUnavailableReason;
};

export type CreatorPlatformConnectionSummary = {
  connectionId: string;
  platformId: string;
  platform: ConnectableCreatorPlatform;
  provider: CreatorPlatformProvider;
  externalAccountId: string;
  status: CreatorPlatformConnectionStatus;
  capabilities: CreatorPlatformImportField[];
  importedFields: CreatorPlatformImportField[];
  unavailableFields: CreatorPlatformUnavailableField[];
  lastSyncAttemptAt: MarketplaceUtcDateTime | null;
  lastSuccessfulSyncAt: MarketplaceUtcDateTime | null;
  lastErrorCode: string | null;
};

export const CREATOR_PLATFORM_ENGAGEMENT_WINDOW_DAYS = 30 as const;
export const CREATOR_PLATFORM_ENGAGEMENT_FORMULA_VERSION =
  "creator-platform-engagement.v1" as const;

export function calculateCreatorPlatformEngagementRate(input: {
  followerCount: number | null;
  contentItemCount: number | null;
  likes: number | null;
  comments: number | null;
  shares: number | null;
}): number | null {
  const values = [
    input.followerCount,
    input.contentItemCount,
    input.likes,
    input.comments,
    input.shares,
  ];
  if (values.some((value) => value === null || !Number.isFinite(value) || value < 0)) return null;

  const [followers, contentItems, likes, comments, shares] = values as number[];
  if (followers === 0 || contentItems === 0) return null;

  const rate = ((likes + comments + shares) / contentItems / followers) * 100;
  return Math.round((rate + Number.EPSILON) * 10_000) / 10_000;
}

export type CreatorProfileRatingSummary = {
  averageRating: number;
  totalReviews: number;
};

export type CreatorProfileStatusResult = {
  creatorProfileId: string;
  organizationId: string;
  profilePhotoRequired: true;
  profileComplete: boolean;
  profileStatus: CreatorProfileStatus;
  missingFields: CreatorProfileMissingField[];
  missingPlatforms: boolean;
  completionSteps: CreatorProfileCompletionStep[];
  canPublishToDiscovery: boolean;
  updatedAt: MarketplaceUtcDateTime;
};

export type CreatorProfileDocument = {
  creatorProfileId: string;
  organizationId: string;
  sourceCreatorId: string | null;
  displayName: string | null;
  creatorType: MarketplaceCreatorType;
  locationText: string | null;
  shortDescription: string | null;
  portfolioUrl: string | null;
  phone: string | null;
  profilePictureUrl: string | null;
  profilePictureMediaObjectId?: string | null;
  profileComplete: boolean;
  profileCompletedAt: MarketplaceUtcDateTime | null;
  profileStatus: CreatorProfileStatus;
  platforms: CreatorProfilePlatform[];
  audienceSize: number;
  rating: CreatorProfileRatingSummary;
  matchingPreferences: MarketplaceCreatorMatchingPreferences | null;
  createdAt: MarketplaceUtcDateTime;
  updatedAt: MarketplaceUtcDateTime;
};

export type UpdateCreatorProfileRequest = {
  displayName?: string;
  creatorType?: MarketplaceCreatorType;
  locationText?: string | null;
  shortDescription?: string | null;
  portfolioUrl?: string | null;
  phone?: string | null;
  profilePictureUrl?: string | null;
  profilePictureMediaObjectId?: string | null;
  platforms?: CreatorProfilePlatformInput[];
  matchingPreferences?: MarketplaceCreatorMatchingPreferencesWrite | null;
};

export type CreatorProfileSelfServiceErrorCode =
  | "invalid_body"
  | "unauthorized"
  | "forbidden"
  | "creator_profile_not_found"
  | "missing_resource_access"
  | "profile_conflict"
  | "internal_error";

export type CreatorProfileSelfServiceError = {
  statusCode: 400 | 401 | 403 | 404 | 409 | 500;
  code: CreatorProfileSelfServiceErrorCode;
  category: "validation" | "auth" | "not_found" | "conflict" | "internal";
  message: string;
};

export type CreatorProfileResourcePolicy = {
  permission: "marketplace.profile.manage";
  selectedOrganizationKind: "creator_workspace";
  resolution: "resolve_active_selected_org_resource_link_then_enforce";
  resource: {
    product: "marketplace";
    resourceType: "creator_profile";
    relationship: "owner";
    resourceIdSource: "identity.organization_resource_links.resource_id";
  };
};

export const CREATOR_PROFILE_RESOURCE_POLICY: CreatorProfileResourcePolicy = {
  permission: "marketplace.profile.manage",
  selectedOrganizationKind: "creator_workspace",
  resolution: "resolve_active_selected_org_resource_link_then_enforce",
  resource: {
    product: "marketplace",
    resourceType: "creator_profile",
    relationship: "owner",
    resourceIdSource: "identity.organization_resource_links.resource_id",
  },
};

export const CREATOR_PROFILE_SELF_SERVICE_PRIVATE_KEYS = [
  "ownerUserId",
  "owner_user_id",
  "userId",
  "user_id",
  "email",
  "workosOrgId",
  "membershipId",
  "profileMetadata",
  "profile_metadata",
  "piiRetentionUntil",
  "pii_retention_until",
] as const;

export type CreatorProfileSelfServicePrivateKey =
  (typeof CREATOR_PROFILE_SELF_SERVICE_PRIVATE_KEYS)[number];

export type CreatorProfileUpdatedEvent = {
  readonly eventType: "marketplace.creator_profile.updated";
  readonly eventId: string;
  readonly creatorProfileId: string;
  readonly organizationId: string;
  readonly actorUserId: string;
  readonly occurredAt: MarketplaceUtcDateTime;
  readonly discoveryCoherence:
    | { readonly mode: "base_tables"; readonly eligibleForDiscovery: boolean }
    | {
        readonly mode: "projection_job";
        readonly jobId: string;
        readonly eligibleForDiscovery: boolean;
      };
};

export const MARKETPLACE_HOTEL_MISSING_FIELDS = [
  "displayName",
  "location",
  "hostSummary",
  "website",
  "coverImage",
  "offer",
] as const;

export type MarketplaceHotelMissingField = (typeof MARKETPLACE_HOTEL_MISSING_FIELDS)[number];

export type MarketplaceHotelPropertyFacts = {
  propertyId: string;
  publicId: string;
  displayName: string;
  canonicalSlug: string;
  profileStatus: "complete" | "incomplete" | "disabled" | "private";
  location: {
    displayText: string;
    countryCode?: string;
    region?: string;
    city?: string;
  };
  websiteUrl: string | null;
  publicPhone: string | null;
  publicEmail: string | null;
  coverImageUrl: string | null;
  projectedAt: MarketplaceUtcDateTime;
};

export type MarketplaceHotelProfile = {
  propertyId: string;
  organizationId: string;
  marketplaceProfileStatus: MarketplaceHotelProfileStatus;
  profileComplete: boolean;
  profileCompletedAt: MarketplaceUtcDateTime | null;
  hostSummary: string | null;
  collaborationGuidelines: string | null;
  createdAt: MarketplaceUtcDateTime;
  updatedAt: MarketplaceUtcDateTime;
};

export type MarketplaceOfferCompensationOption = {
  compensationOptionId: string;
  compensationType: MarketplaceOfferCompensationType;
  availabilityMonths: string[];
  platforms: MarketplacePlatformName[];
  freeStayMinNights: number | null;
  freeStayMaxNights: number | null;
  paidMaxAmount: MarketplaceDecimalAmount | null;
  discountPercentage: number | null;
  commissionPercentage: number | null;
  minFollowers: number | null;
  followerRequirementLevel?: MarketplaceOfferRequirementLevel | null;
  currency: MarketplaceCurrencyCode | null;
  termsSummary: string | null;
};

export type MarketplaceOfferCreatorRequirements = {
  platforms: MarketplacePlatformName[];
  platformRequirementLevel?: MarketplaceOfferRequirementLevel | null;
  targetCountries: string[];
  targetCountriesRequirementLevel?: MarketplaceOfferRequirementLevel | null;
  targetAgeMin: number | null;
  targetAgeMax: number | null;
  targetAgeGroups: string[];
  creatorTypes: MarketplaceCreatorType[];
  creatorTypesRequirementLevel?: MarketplaceOfferRequirementLevel | null;
};

export type MarketplaceOfferDeliverable = {
  deliverableId: string;
  platform: MarketplacePlatformName;
  deliverableType: string;
  quantity: number;
  timingGuidance: string | null;
  requirementLevel?: MarketplaceOfferRequirementLevel | null;
};

export type MarketplaceOffer = {
  offerId: string;
  propertyId: string;
  offerStatus: MarketplaceOfferStatus;
  title: string;
  offerSummary: string | null;
  deliverables: MarketplaceOfferDeliverable[];
  compensationOptions: MarketplaceOfferCompensationOption[];
  creatorRequirements: MarketplaceOfferCreatorRequirements | null;
  matchingCriteria: MarketplaceOfferMatchingCriteria | null;
  createdAt: MarketplaceUtcDateTime;
  updatedAt: MarketplaceUtcDateTime;
};

export type MarketplaceOfferAuthorizationTarget = {
  offerId: string;
  offerResourceId: string;
  propertyId: string;
  organizationId: string;
};

export type MarketplaceHotelProfileStatusResponse = {
  contractVersion: MarketplaceHotelSelfServiceContractVersion;
  authorizationMode: MarketplaceHotelAuthorizationMode;
  propertyId: string;
  profileComplete: boolean;
  missingFields: MarketplaceHotelMissingField[];
  hasDefaults: { location: boolean };
  missingOffers: boolean;
  completionSteps: string[];
};

export type MarketplaceHotelProfileResponse = {
  contractVersion: MarketplaceHotelSelfServiceContractVersion;
  authorizationMode: MarketplaceHotelAuthorizationMode;
  property: MarketplaceHotelPropertyFacts;
  marketplaceProfile: MarketplaceHotelProfile;
  offers: MarketplaceOffer[];
};

export type UpdateMarketplaceHotelProfileRequest = {
  hostSummary?: string | null;
  collaborationGuidelines?: string | null;
};

export type MarketplaceOfferCompensationOptionWrite = Omit<
  MarketplaceOfferCompensationOption,
  "compensationOptionId" | "followerRequirementLevel"
> & { followerRequirementLevel?: MarketplaceOfferRequirementLevel | null };

export type MarketplaceOfferCreatorRequirementsWrite = Omit<
  MarketplaceOfferCreatorRequirements,
  "platformRequirementLevel" | "targetCountriesRequirementLevel" | "creatorTypesRequirementLevel"
> & {
  platformRequirementLevel?: MarketplaceOfferRequirementLevel | null;
  targetCountriesRequirementLevel?: MarketplaceOfferRequirementLevel | null;
  creatorTypesRequirementLevel?: MarketplaceOfferRequirementLevel | null;
};

export type MarketplaceOfferDeliverableWrite = Omit<
  MarketplaceOfferDeliverable,
  "deliverableId" | "requirementLevel"
> & { requirementLevel?: MarketplaceOfferRequirementLevel | null };

export type CreateMarketplaceOfferRequest = {
  title: string;
  offerSummary?: string | null;
  deliverables: MarketplaceOfferDeliverableWrite[];
  compensationOptions: MarketplaceOfferCompensationOptionWrite[];
  creatorRequirements: MarketplaceOfferCreatorRequirementsWrite;
  matchingCriteria?: MarketplaceOfferMatchingCriteriaWrite | null;
};

export type UpdateMarketplaceOfferRequest = Partial<
  Omit<
    CreateMarketplaceOfferRequest,
    "deliverables" | "compensationOptions" | "creatorRequirements"
  >
> & {
  deliverables?: MarketplaceOfferDeliverableWrite[];
  compensationOptions?: MarketplaceOfferCompensationOptionWrite[];
  creatorRequirements?: MarketplaceOfferCreatorRequirementsWrite | null;
  matchingCriteria?: MarketplaceOfferMatchingCriteriaWrite | null;
};

export const MARKETPLACE_HOTEL_SELF_SERVICE_ERROR_CODES = [
  "invalid_request",
  "canonical_property_read_only",
  "unauthorized",
  "forbidden",
  "missing_resource_link",
  "not_found",
  "ambiguous_legacy_profile",
  "id_continuity_violation",
  "validation_failed",
  "internal_error",
] as const;

export type MarketplaceHotelSelfServiceErrorCode =
  (typeof MARKETPLACE_HOTEL_SELF_SERVICE_ERROR_CODES)[number];

export type MarketplaceHotelSelfServiceError = {
  statusCode: 400 | 401 | 403 | 404 | 409 | 422 | 500;
  code: MarketplaceHotelSelfServiceErrorCode;
  category: "validation" | "auth" | "conflict" | "internal";
  message: string;
};

// ---------------------------------------------------------------------------
// Collaboration lifecycle
// ---------------------------------------------------------------------------

export const MARKETPLACE_COLLABORATION_READS_CONTRACT_VERSION =
  "marketplace-collaboration-reads.v1" as const;

export type MarketplaceCollaborationReadsContractVersion =
  typeof MARKETPLACE_COLLABORATION_READS_CONTRACT_VERSION;

export const MARKETPLACE_COLLABORATION_READ_ENDPOINTS = {
  myCollaborations: {
    method: "GET",
    path: "/api/marketplace/collaborations/me",
    doc: "engineering/marketplace-collaboration-reads-contract.md",
  },
  collaboration: {
    method: "GET",
    path: "/api/marketplace/collaborations/{collaborationId}",
    doc: "engineering/marketplace-collaboration-reads-contract.md",
  },
  conversations: {
    method: "GET",
    path: "/api/marketplace/collaborations/conversations",
    doc: "engineering/marketplace-collaboration-reads-contract.md",
  },
  messages: {
    method: "GET",
    path: "/api/marketplace/collaborations/{collaborationId}/messages",
    doc: "engineering/marketplace-collaboration-reads-contract.md",
  },
} as const;

export const COLLABORATION_STATUSES = [
  "pending",
  "negotiating",
  "accepted",
  "active",
  "completed",
  "cancelled",
  "rejected",
  "declined",
] as const;

export type CollaborationStatus = (typeof COLLABORATION_STATUSES)[number];

export const MARKETPLACE_COLLABORATION_AUTHORIZATION_SIDES = ["creator", "hotel"] as const;

export type MarketplaceCollaborationAuthorizationSide =
  (typeof MARKETPLACE_COLLABORATION_AUTHORIZATION_SIDES)[number];

export type MarketplaceCollaborationAuthorizationMode =
  | "creator_workspace_resource_link"
  | "hotel_group_resource_link";

export type MarketplaceCollaborationReadPolicy = {
  permission: "marketplace.collaboration.read";
  side: MarketplaceCollaborationAuthorizationSide;
  selectedOrganizationKind: "creator_workspace" | "hotel_group";
  requiredResources: readonly {
    product: "marketplace";
    resourceType: "creator_profile" | "hotel_profile" | "marketplace_offer";
    relationship: "owner" | "operator";
  }[];
};

export const MARKETPLACE_COLLABORATION_CREATOR_READ_POLICY: MarketplaceCollaborationReadPolicy = {
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
};

export const MARKETPLACE_COLLABORATION_HOTEL_READ_POLICY: MarketplaceCollaborationReadPolicy = {
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
};

export type MarketplaceCollaborationParticipant = {
  side: MarketplaceCollaborationAuthorizationSide;
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
  completedAt: MarketplaceUtcDateTime | null;
};

export type MarketplaceCollaborationRead = {
  contractVersion: MarketplaceCollaborationReadsContractVersion;
  authorizationMode: MarketplaceCollaborationAuthorizationMode;
  collaborationId: string;
  offerId: string;
  creatorId: string;
  hotelProfileId: string;
  side: MarketplaceCollaborationAuthorizationSide;
  initiatorSide: MarketplaceCollaborationAuthorizationSide;
  isInitiator: boolean;
  status: CollaborationStatus;
  compensationType: MarketplaceCompensationType | null;
  offerTitle: string;
  hotelLocation: string | null;
  applicationMessage?: string | null;
  selectedCompensationOptionId?: string | null;
  cancelledBy?: MarketplaceCollaborationAuthorizationSide | null;
  creatorConsent?: boolean | null;
  creatorAgreedAt?: MarketplaceUtcDateTime | null;
  hotelAgreedAt?: MarketplaceUtcDateTime | null;
  creator: MarketplaceCollaborationCreatorParticipant;
  hotel: MarketplaceCollaborationParticipant;
  terms: {
    freeStayMinNights: number | null;
    freeStayMaxNights: number | null;
    paidAmount: MarketplaceDecimalAmount | null;
    currency: MarketplaceCurrencyCode | null;
    discountPercentage: number | null;
    affiliateEnabled: boolean;
    affiliateCommissionPercentage: MarketplaceDecimalAmount | null;
    travelDateFrom: string | null;
    travelDateTo: string | null;
    preferredDateFrom: string | null;
    preferredDateTo: string | null;
    preferredMonths: string[];
  };
  deliverables: MarketplaceCollaborationDeliverable[];
  lastMessageAt: MarketplaceUtcDateTime | null;
  createdAt: MarketplaceUtcDateTime;
  updatedAt: MarketplaceUtcDateTime;
};

export type MarketplaceCollaborationListRequest = {
  side: MarketplaceCollaborationAuthorizationSide;
  status?: CollaborationStatus;
  initiatedBy?: MarketplaceCollaborationAuthorizationSide;
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
  side: MarketplaceCollaborationAuthorizationSide;
  partnerName: string;
  partnerAvatarUrl: string | null;
  offerTitle: string | null;
  collaborationStatus: CollaborationStatus;
  lastMessageContent: string | null;
  lastMessageAt: MarketplaceUtcDateTime | null;
  unreadCount: number;
};

export type MarketplaceConversationPage = {
  contractVersion: MarketplaceCollaborationReadsContractVersion;
  items: MarketplaceConversationSummary[];
  nextCursor: string | null;
  hasMore: boolean;
};

export type MarketplaceMessageContentType = "text" | "image" | "system";

export type MarketplaceCollaborationMessage = {
  contractVersion: MarketplaceCollaborationReadsContractVersion;
  messageId: string;
  collaborationId: string;
  senderUserId: string | null;
  senderName: string | null;
  senderAvatarUrl: string | null;
  senderSide: MarketplaceCollaborationAuthorizationSide | null;
  content: string;
  contentType: MarketplaceMessageContentType;
  metadata: Record<string, unknown> | null;
  createdAt: MarketplaceUtcDateTime;
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
  createdAt: MarketplaceUtcDateTime;
  messageId: string;
};

export const MARKETPLACE_COLLABORATION_READ_PRIVATE_KEYS = [
  "user_id",
  "userId",
  "owner_user_id",
  "ownerUserId",
  "workosOrgId",
  "membershipId",
  "creator_email",
  "creatorEmail",
  "hotel_owner_email",
  "hotelOwnerEmail",
  "legacyJwtClaims",
  "pmsHotelId",
  "pms_database_url",
] as const;

export type MarketplaceCollaborationReadPrivateKey =
  (typeof MARKETPLACE_COLLABORATION_READ_PRIVATE_KEYS)[number];

export const MARKETPLACE_COLLABORATION_READ_ERROR_CODES = [
  "invalid_query",
  "unauthorized",
  "forbidden",
  "missing_creator_resource_link",
  "missing_hotel_resource_link",
  "collaboration_not_found",
  "internal_error",
] as const;

export type MarketplaceCollaborationReadErrorCode =
  (typeof MARKETPLACE_COLLABORATION_READ_ERROR_CODES)[number];

export type MarketplaceCollaborationReadError = {
  statusCode: 400 | 401 | 403 | 404 | 500;
  code: MarketplaceCollaborationReadErrorCode;
  category: "validation" | "auth" | "not_found" | "internal";
  message: string;
};

export const MARKETPLACE_COLLABORATION_LIFECYCLE_WRITES_CONTRACT_VERSION =
  "marketplace-collaboration-lifecycle-writes.v1" as const;

export type MarketplaceCollaborationLifecycleWritesContractVersion =
  typeof MARKETPLACE_COLLABORATION_LIFECYCLE_WRITES_CONTRACT_VERSION;

export const MARKETPLACE_COLLABORATION_LIFECYCLE_WRITE_ENDPOINTS = {
  create: {
    method: "POST",
    path: "/api/marketplace/collaborations",
    doc: "engineering/marketplace-collaboration-lifecycle-writes-contract.md",
  },
  respond: {
    method: "POST",
    path: "/api/marketplace/collaborations/{collaborationId}/respond",
    doc: "engineering/marketplace-collaboration-lifecycle-writes-contract.md",
  },
  updateTerms: {
    method: "PUT",
    path: "/api/marketplace/collaborations/{collaborationId}/terms",
    doc: "engineering/marketplace-collaboration-lifecycle-writes-contract.md",
  },
  approveTerms: {
    method: "POST",
    path: "/api/marketplace/collaborations/{collaborationId}/approve",
    doc: "engineering/marketplace-collaboration-lifecycle-writes-contract.md",
  },
  cancel: {
    method: "POST",
    path: "/api/marketplace/collaborations/{collaborationId}/cancel",
    doc: "engineering/marketplace-collaboration-lifecycle-writes-contract.md",
  },
  toggleDeliverable: {
    method: "POST",
    path: "/api/marketplace/collaborations/{collaborationId}/deliverables/{deliverableId}/toggle",
    doc: "engineering/marketplace-collaboration-lifecycle-writes-contract.md",
  },
  rateCreator: {
    method: "POST",
    path: "/api/marketplace/collaborations/{collaborationId}/rate",
    doc: "engineering/marketplace-collaboration-lifecycle-writes-contract.md",
  },
} as const;

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

export type MarketplaceCollaborationWritePolicy = {
  permission: "marketplace.collaboration.write";
  side: MarketplaceCollaborationAuthorizationSide;
  selectedOrganizationKind: "creator_workspace" | "hotel_group";
  requiredResources: readonly {
    product: "marketplace";
    resourceType: "creator_profile" | "hotel_profile" | "marketplace_offer";
    relationship: "owner" | "operator";
  }[];
};

export const MARKETPLACE_COLLABORATION_CREATOR_WRITE_POLICY: MarketplaceCollaborationWritePolicy = {
  permission: "marketplace.collaboration.write",
  side: "creator",
  selectedOrganizationKind: "creator_workspace",
  requiredResources: [
    {
      product: "marketplace",
      resourceType: "creator_profile",
      relationship: "owner",
    },
  ],
};

export const MARKETPLACE_COLLABORATION_HOTEL_WRITE_POLICY: MarketplaceCollaborationWritePolicy = {
  permission: "marketplace.collaboration.write",
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
};

export const MARKETPLACE_COLLABORATION_LIFECYCLE_WRITE_ERROR_CODES = [
  "invalid_request",
  "unauthorized",
  "forbidden",
  "missing_creator_resource_link",
  "missing_hotel_resource_link",
  "collaboration_not_found",
  "invalid_transition",
  "idempotency_conflict",
  "validation_failed",
  "internal_error",
] as const;

export type MarketplaceCollaborationLifecycleWriteErrorCode =
  (typeof MARKETPLACE_COLLABORATION_LIFECYCLE_WRITE_ERROR_CODES)[number];

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

export const MARKETPLACE_COLLABORATION_LIFECYCLE_WRITE_PRIVATE_KEYS = [
  ...MARKETPLACE_COLLABORATION_READ_PRIVATE_KEYS,
  "stripeAccountId",
  "stripe_connect_account_id",
  "financeAccountId",
  "pmsDatabase",
] as const;

export type MarketplaceCollaborationLifecycleWritePrivateKey =
  (typeof MARKETPLACE_COLLABORATION_LIFECYCLE_WRITE_PRIVATE_KEYS)[number];

// ---------------------------------------------------------------------------
// Affiliate / referral contract
// ---------------------------------------------------------------------------

/**
 * Ownership of affiliate provisioning contract version.
 * Increment when the command shape changes in a breaking way.
 */
export const MARKETPLACE_AFFILIATE_CONTRACT_VERSION = "marketplace-affiliate.v1" as const;

export type MarketplaceAffiliateContractVersion = typeof MARKETPLACE_AFFILIATE_CONTRACT_VERSION;

/**
 * The status an affiliate can be in after provisioning.
 * Mirrors downstream Finance/affiliate domain — kept minimal here.
 */
export const AFFILIATE_PROVISIONING_STATUSES = ["provisioned", "already_exists", "failed"] as const;

export type AffiliateProvisioningStatus = (typeof AFFILIATE_PROVISIONING_STATUSES)[number];

/**
 * Audit context attached to every command emitted by Marketplace.
 */
export type MarketplaceCommandAudit = {
  requestId: string;
  correlationId: string;
  causationId?: string;
  /** Internal Vayada organization ID for the hotel business. */
  organizationId: string;
  /** Internal Vayada organization ID for the creator workspace. */
  creatorOrganizationId: string;
  actorType: "creator" | "hotel_user" | "platform_admin" | "system";
  actorId?: string;
  source: "marketplace_web" | "marketplace_admin" | "job_retry" | "migration" | "test";
  occurredAt: MarketplaceUtcDateTime;
};

// ---------------------------------------------------------------------------
// ProvisionCollaborationAffiliateCommand
//
// Emitted by Marketplace when a collaboration is accepted and an affiliate
// referral link is needed. The Finance/affiliate domain owns provisioning;
// Marketplace never touches PMS tables.
// ---------------------------------------------------------------------------

/**
 * Creator identity fields needed so the downstream domain can create the
 * affiliate record without calling back into Marketplace.
 */
export type AffiliateCreatorIdentity = {
  creatorId: string;
  creatorName: string | null;
  creatorEmail: string | null;
  /** Comma-separated "Platform: @handle" pairs, e.g. "Instagram: @ada". */
  socialMediaSummary?: string | null;
};

/**
 * Hotel-side resource references. Marketplace owns the `marketplaceHotelProfileId`;
 * downstream Finance/affiliate domain resolves the canonical `propertyId` and
 * `pmsHotelId` via the organization resource link — it never receives them from
 * Marketplace directly, to avoid cross-domain coupling.
 */
export type AffiliateHotelReference = {
  /** Marketplace hotel profile ID (Marketplace's authoritative resource). */
  marketplaceHotelProfileId: string;
  /** Internal organization ID of the hotel group (from RequestContext). */
  organizationId: string;
};

/**
 * Commission terms agreed in the collaboration offer.
 * Expressed as a decimal percentage string, e.g. "5.00".
 * The downstream domain applies its own floor/cap rules.
 */
export type AffiliateCommissionTerms = {
  commissionPct: MarketplaceDecimalAmount;
  currency?: MarketplaceCurrencyCode | null;
};

/**
 * Derives a stable `commandId` from an idempotency key.
 *
 * `commandId` identifies this specific command envelope; `idempotencyKey`
 * scopes deduplication in the downstream domain. Both are derived from the
 * collaboration ID so that retries carry the same identifiers end-to-end.
 *
 * @example
 * const idempotencyKey = buildAffiliateProvisioningIdempotencyKey({ collaborationId });
 * const commandId = buildAffiliateProvisioningCommandId({ idempotencyKey });
 * // commandId === `cmd:${idempotencyKey}`
 */
export function buildAffiliateProvisioningCommandId(input: { idempotencyKey: string }): string {
  return `cmd:${input.idempotencyKey}`;
}

/**
 * Command: Marketplace requests affiliate provisioning when a collaboration
 * is accepted. This is the single typed boundary that replaces the cross-DB
 * write in `affiliate.py`.
 *
 * Idempotency guarantee: downstream domain must treat commands with the same
 * `idempotencyKey` as a no-op after the first successful processing.
 *
 * Derive `commandId` deterministically using `buildAffiliateProvisioningCommandId`
 * and `idempotencyKey` using `buildAffiliateProvisioningIdempotencyKey` so that
 * retries carry the same identifiers without caller-side state.
 */
export type ProvisionCollaborationAffiliateCommand = {
  contractVersion: MarketplaceAffiliateContractVersion;
  commandId: string;
  idempotencyKey: string;
  audit: MarketplaceCommandAudit;
  collaboration: {
    collaborationId: string;
    status: Extract<CollaborationStatus, "accepted">;
    acceptedAt: MarketplaceUtcDateTime;
  };
  creator: AffiliateCreatorIdentity;
  hotel: AffiliateHotelReference;
  commissionTerms: AffiliateCommissionTerms;
};

// ---------------------------------------------------------------------------
// AffiliateProvisioningResult
//
// Returned to (or consumed by) Marketplace after the command is processed.
// Marketplace stores the referral output on the collaboration row; it never
// touches the affiliate table itself.
// ---------------------------------------------------------------------------

/**
 * Public referral output that Marketplace UI and Booking attribution consume.
 * Owned by the Finance/affiliate domain; delivered back through this contract.
 */
export type CollaborationReferralOutput = {
  /** Stable affiliate ID in the Finance/affiliate domain. */
  affiliateId: string;
  /** Short referral code used in booking URLs, e.g. "aB3xQ1yZ". */
  referralCode: string;
  /** Fully-qualified referral link for the booking surface. */
  referralLink: string;
  /** ISO 8601 timestamp when this affiliate record was provisioned. */
  provisionedAt: MarketplaceUtcDateTime;
};

export type AffiliateProvisioningResult =
  | {
      contractVersion: MarketplaceAffiliateContractVersion;
      commandId: string;
      idempotencyKey: string;
      collaborationId: string;
      status: Extract<AffiliateProvisioningStatus, "provisioned" | "already_exists">;
      referralOutput: CollaborationReferralOutput;
      error?: never;
    }
  | {
      contractVersion: MarketplaceAffiliateContractVersion;
      commandId: string;
      idempotencyKey: string;
      collaborationId: string;
      status: Extract<AffiliateProvisioningStatus, "failed">;
      referralOutput?: never;
      error: AffiliateProvisioningError;
    };

// ---------------------------------------------------------------------------
// Error contract
// ---------------------------------------------------------------------------

export const AFFILIATE_PROVISIONING_ERROR_CODES = [
  "HOTEL_NOT_FOUND",
  "CREATOR_NOT_FOUND",
  "DUPLICATE_AFFILIATE",
  "COMMISSION_INVALID",
  "RETRYABLE_DOWNSTREAM_FAILURE",
  "IDEMPOTENCY_CONFLICT",
  "VALIDATION_FAILED",
] as const;

export type AffiliateProvisioningErrorCode = (typeof AFFILIATE_PROVISIONING_ERROR_CODES)[number];

export type AffiliateProvisioningError = {
  code: AffiliateProvisioningErrorCode;
  retryable: boolean;
  sanitizedMessage: string;
};

// ---------------------------------------------------------------------------
// Service port — the interface Marketplace calls; Finance/affiliate implements
// ---------------------------------------------------------------------------

/**
 * The typed port Marketplace calls when a collaboration is accepted and
 * requires affiliate/referral provisioning.
 *
 * Finance/affiliate domain provides a concrete implementation. Marketplace
 * depends only on this interface — never on PMS tables, `PMS_DATABASE_URL`,
 * or any PMS-internal adapter.
 */
export interface CollaborationAffiliatePort {
  /**
   * Provision an affiliate and return referral output for the collaboration.
   * Implementations must be idempotent on `command.idempotencyKey`.
   */
  provisionAffiliate(
    command: ProvisionCollaborationAffiliateCommand,
  ): Promise<AffiliateProvisioningResult>;
}

// ---------------------------------------------------------------------------
// Idempotency key helper
// ---------------------------------------------------------------------------

/**
 * Builds a stable idempotency key for affiliate provisioning from a
 * collaboration ID. Callers should pass this into `commandId` derivation
 * and the command's `idempotencyKey` field.
 */
export function buildAffiliateProvisioningIdempotencyKey(input: {
  collaborationId: string;
}): string {
  return `marketplace.affiliate.provision:collaboration:${input.collaborationId}:v1`;
}

// ---------------------------------------------------------------------------
// Collaboration acceptance event — emitted by Marketplace
// ---------------------------------------------------------------------------

/**
 * Domain event published when a collaboration transitions to `accepted`.
 * Downstream subscribers (Finance/affiliate, notifications, analytics) react
 * to this event rather than being directly called by the collaboration router.
 *
 * This event is an immutable snapshot of the acceptance facts. It must NOT
 * carry provisioning output — that arrives later via AffiliateProvisionedEvent
 * once the Finance/affiliate domain completes its work.
 */
export type CollaborationAcceptedEvent = {
  readonly eventType: "marketplace.collaboration.accepted";
  readonly eventId: string;
  /** The command or action that caused this event. */
  readonly causationId?: string;
  readonly collaborationId: string;
  readonly creatorId: string;
  readonly marketplaceHotelProfileId: string;
  readonly organizationId: string;
  readonly acceptedAt: MarketplaceUtcDateTime;
  /** Whether affiliate provisioning was requested as part of this acceptance. */
  readonly affiliateProvisioningRequested: boolean;
  readonly audit: Readonly<MarketplaceCommandAudit>;
};

// ---------------------------------------------------------------------------
// AffiliateProvisionedEvent — emitted after provisioning completes
// ---------------------------------------------------------------------------

/**
 * Domain event published when the Finance/affiliate domain successfully
 * provisions an affiliate for a collaboration. This is a separate, immutable
 * snapshot carrying the referral output — it must not be conflated with
 * CollaborationAcceptedEvent, which records only the acceptance facts.
 *
 * Marketplace stores the referral output on the collaboration row upon
 * receiving this event. It never writes the affiliate table itself.
 */
export type AffiliateProvisionedEvent = {
  readonly eventType: "marketplace.affiliate.provisioned";
  readonly eventId: string;
  /** The commandId from the ProvisionCollaborationAffiliateCommand that triggered provisioning. */
  readonly causationId: string;
  readonly collaborationId: string;
  readonly idempotencyKey: string;
  readonly referralOutput: Readonly<CollaborationReferralOutput>;
  readonly audit: Readonly<MarketplaceCommandAudit>;
};
