import { createHash, randomBytes, randomUUID } from "node:crypto";

import { requireAuthContext, type PermissionKey, type RequestContext } from "@vayada/backend-auth";
import { isSetupTrack, type SetupTrack } from "@vayada/domain-hotels";
import {
  MARKETPLACE_CREATOR_MODERATION_AUTHORIZATION,
  MARKETPLACE_CREATOR_PROFILE_STATUSES,
  canModerateMarketplaceCreatorProfile,
  isMarketplaceCreatorModerationReason,
  isMarketplaceCreatorModerationTargetStatus,
  isMarketplaceCreatorProfileStatus,
  parseMarketplaceOfferMatchingCriteria,
  parseMarketplaceOfferMatchingCriteriaWrite,
  type MarketplaceCreatorModerationRequest,
  type MarketplaceCreatorModerationResponse,
  type MarketplaceCreatorModerationResult,
  type MarketplaceCreatorProfileStatus,
  type MarketplaceOfferMatchingCriteria,
  type MarketplaceOfferMatchingCriteriaWrite,
  type MarketplaceOfferRequirementLevel,
} from "@vayada/domain-marketplace";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import pg, { type PoolClient, type QueryResult, type QueryResultRow } from "pg";

import type { MarketplaceOfferIdentityAccessCommandPort } from "../platform/marketplaceOfferIdentityAccess.js";
import type { MarketplaceOfferMediaPromotionPort } from "../platform/marketplaceOfferMediaPromotion.js";
import { executeMarketplaceCreatorModeration } from "../domains/marketplaceCreatorModerationRepository.js";
import {
  ensureCanonicalPropertySlug,
  PROJECT_CANONICAL_PUBLIC_PROPERTY_PROFILE,
} from "../platform/publicBookabilityPublication.js";
import { enforceRoutePolicy } from "./policy.js";

export type {
  MarketplaceCreatorModerationRequest,
  MarketplaceCreatorModerationResponse,
  MarketplaceCreatorModerationResult,
} from "@vayada/domain-marketplace";

export const MARKETPLACE_ADMIN_CONTRACT_VERSION = "marketplace-admin.v1" as const;
export const HOTEL_ACCOUNT_INVITE_CONTRACT_VERSION = "hotel-account-invite.v1" as const;
export const HOTEL_ACCOUNT_INVITE_HANDOFF_PATH = "/setup" as const;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function hotelAccountInviteOrganizationExternalId(inviteId: string): string {
  return `vayada-signup:marketplace-web:hotel:invite:${inviteId}`;
}

export function hotelAccountInviteTrackCorrelationId(inviteId: string): string {
  return `hotel-account-invite:${inviteId}:tracks`;
}

export const MARKETPLACE_ADMIN_COLLABORATIONS_CONTRACT = {
  method: "GET",
  path: "/api/marketplace/admin/collaborations",
  owner: "marketplace",
  permission: "platform.user.suspend" satisfies PermissionKey,
  fallback: "opt-in legacy users.is_superadmin during platform organization migration",
  doc: "engineering/marketplace-admin-contract.md",
} as const;

export const MARKETPLACE_ADMIN_OFFERS_CONTRACT = {
  methods: ["POST", "PUT", "DELETE"],
  path: "/api/marketplace/admin/users/:hotelUserId/offers[/:offerId][/verify]",
  owner: "marketplace",
  permission: MARKETPLACE_ADMIN_COLLABORATIONS_CONTRACT.permission,
  fallback: MARKETPLACE_ADMIN_COLLABORATIONS_CONTRACT.fallback,
  doc: MARKETPLACE_ADMIN_COLLABORATIONS_CONTRACT.doc,
} as const;

export const MARKETPLACE_ADMIN_HOTEL_REVIEW_CONTRACT = {
  method: "GET",
  path: "/api/marketplace/admin/users/:hotelUserId/review",
  owner: "marketplace",
  permission: MARKETPLACE_ADMIN_COLLABORATIONS_CONTRACT.permission,
  fallback: MARKETPLACE_ADMIN_COLLABORATIONS_CONTRACT.fallback,
  doc: MARKETPLACE_ADMIN_COLLABORATIONS_CONTRACT.doc,
} as const;

export const MARKETPLACE_ADMIN_CREATOR_REVIEW_CONTRACT = {
  method: "GET",
  path: "/api/marketplace/admin/users/:userId/review/creator",
  owner: "marketplace",
  permission: MARKETPLACE_ADMIN_COLLABORATIONS_CONTRACT.permission,
  fallback: MARKETPLACE_ADMIN_COLLABORATIONS_CONTRACT.fallback,
  doc: MARKETPLACE_ADMIN_COLLABORATIONS_CONTRACT.doc,
} as const;

export const MARKETPLACE_ADMIN_CREATOR_MODERATION_CONTRACT = {
  method: "POST",
  path: "/api/marketplace/admin/creators/:creatorProfileId/moderation",
  owner: "marketplace",
  ...MARKETPLACE_CREATOR_MODERATION_AUTHORIZATION,
  fallback: "none",
  doc: MARKETPLACE_ADMIN_COLLABORATIONS_CONTRACT.doc,
} as const;

export const MARKETPLACE_ADMIN_USER_PROFILES_CONTRACT = {
  method: "PUT",
  path: "/api/marketplace/admin/users/:userId/profile/:profileType",
  owner: "marketplace",
  permission: MARKETPLACE_ADMIN_COLLABORATIONS_CONTRACT.permission,
  doc: MARKETPLACE_ADMIN_COLLABORATIONS_CONTRACT.doc,
} as const;

export type MarketplaceAdminAuthorizationMode =
  | "platform_organization_membership"
  | "legacy_superadmin_fallback";

export type MarketplaceAdminRouteAccess = {
  context: RequestContext;
  authorizationMode: MarketplaceAdminAuthorizationMode;
};

export type MarketplaceCollaborationStatus =
  | "pending"
  | "negotiating"
  | "accepted"
  | "active"
  | "completed"
  | "cancelled"
  | "rejected"
  | "declined";

export type MarketplaceCollaborationSide = "creator" | "hotel";

export type MarketplaceCollaborationRead = {
  contractVersion: "marketplace-collaboration-reads.v1";
  authorizationMode: "hotel_group_resource_link" | "creator_workspace_resource_link";
  collaborationId: string;
  offerId: string;
  creatorId: string;
  hotelProfileId: string;
  side: MarketplaceCollaborationSide;
  initiatorSide: MarketplaceCollaborationSide;
  isInitiator: boolean;
  status: MarketplaceCollaborationStatus;
  compensationType: "free_stay" | "paid" | "discount" | "custom" | null;
  offerTitle: string;
  hotelLocation: string | null;
  creator: MarketplaceCollaborationParticipant;
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
  applicationMessage: string | null;
  hotelAgreedAt: string | null;
  creatorAgreedAt: string | null;
  completedAt: string | null;
  cancelledAt: string | null;
  createdAt: string;
  updatedAt: string;
};

export type MarketplaceCollaborationParticipant = {
  side: MarketplaceCollaborationSide;
  organizationId: string;
  profileId: string;
  displayName: string;
  avatarUrl: string | null;
};

export type MarketplaceCollaborationDeliverable = {
  deliverableId: string;
  platform: string;
  type: string;
  quantity: number;
  status: "pending" | "completed";
  completedAt: string | null;
};

export type MarketplaceAdminCollaborationsResponse = {
  contractVersion: typeof MARKETPLACE_ADMIN_CONTRACT_VERSION;
  authorizationMode: MarketplaceAdminAuthorizationMode;
  collaborations: MarketplaceCollaborationRead[];
  pagination: {
    page: number;
    pageSize: number;
    total: number;
  };
};

export type MarketplaceCollaborationLifecycleWriteResponse = {
  contractVersion: "marketplace-collaboration-lifecycle-writes.v1";
  command: {
    action: "respond" | "approve_terms";
    idempotencyKey: string;
    acceptedAt?: string;
  };
  collaboration: MarketplaceCollaborationRead;
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

export type MarketplaceAdminVerifyOfferRequest = {
  mediaObjectIds?: string[];
};

export type MarketplaceAdminCreatorPlatformWrite = {
  platform: MarketplacePlatformName;
  handle: string;
  profileUrl?: string | null;
  followerCount: number;
  engagementRate: number;
  audienceCountries?: { country: string; percentage: number }[];
  audienceAgeGroups?: { ageRange: string; percentage: number }[];
  audienceGenderSplit?: { male: number; female: number; other?: number } | null;
};

export type MarketplaceAdminCreatorProfileUpdateRequest = {
  displayName?: string;
  profilePictureUrl?: string | null;
  profilePictureMediaObjectId?: string | null;
  locationText?: string | null;
  shortDescription?: string | null;
  portfolioUrl?: string | null;
  phone?: string | null;
  platforms?: MarketplaceAdminCreatorPlatformWrite[];
};

export type MarketplaceAdminHotelProfileUpdateRequest = {
  hostSummary?: string | null;
  collaborationGuidelines?: string | null;
};

export type MarketplaceAdminUserProfileUpdateResponse = {
  contractVersion: typeof MARKETPLACE_ADMIN_CONTRACT_VERSION;
  authorizationMode: MarketplaceAdminAuthorizationMode;
  userId: string;
  profileType: "creator" | "hotel";
  updatedAt: string;
};

export type MarketplaceAdminInviteCode = {
  contractVersion: typeof HOTEL_ACCOUNT_INVITE_CONTRACT_VERSION;
  id: string;
  code: string;
  status: "pending" | "redeemed" | "expired";
  createdAt: string;
  expiresAt: string;
  identity: MarketplaceAdminHotelAccountInviteCreateRequest["identity"] | null;
  organization: MarketplaceAdminHotelAccountInviteCreateRequest["organization"] | null;
  property: MarketplaceAdminHotelAccountInviteCreateRequest["property"] | null;
  selectedTracks: SetupTrack[];
  handoffPath: typeof HOTEL_ACCOUNT_INVITE_HANDOFF_PATH;
  redeemedAt: string | null;
};

export type MarketplaceAdminHotelAccountInviteCreateRequest = {
  identity: {
    email: string;
  };
  organization: {
    displayName: string;
  };
  property: {
    displayName: string;
  };
  selectedTracks: SetupTrack[];
};

type MarketplaceAdminHotelAccountInvitePayload = MarketplaceAdminHotelAccountInviteCreateRequest & {
  contractVersion: typeof HOTEL_ACCOUNT_INVITE_CONTRACT_VERSION;
  handoffPath: typeof HOTEL_ACCOUNT_INVITE_HANDOFF_PATH;
};

export type MarketplaceAdminOffer = {
  contractVersion: typeof MARKETPLACE_ADMIN_CONTRACT_VERSION;
  authorizationMode: MarketplaceAdminAuthorizationMode;
  offerId: string;
  propertyId: string;
  offerStatus: "draft" | "pending" | "verified" | "rejected" | "suspended" | "archived";
  title: string;
  offerSummary: string | null;
  media: MarketplaceAdminOfferMedia[];
  deliverables: (MarketplaceOfferDeliverableWrite & { deliverableId: string })[];
  compensationOptions: (MarketplaceOfferCompensationOptionWrite & {
    compensationOptionId: string;
  })[];
  creatorRequirements: MarketplaceOfferCreatorRequirementsWrite | null;
  matchingCriteria: MarketplaceOfferMatchingCriteria | null;
  createdAt: string;
  updatedAt: string;
};

export type MarketplaceAdminOfferMedia = {
  mediaObjectId: string | null;
  url: string | null;
  approvalStatus: "pending_domain_approval" | "approved";
  lifecycleStatus: "staged" | "active";
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
  contractVersion: typeof MARKETPLACE_ADMIN_CONTRACT_VERSION;
  authorizationMode: MarketplaceAdminAuthorizationMode;
  userId: string;
  profile: MarketplaceAdminHotelReviewProfile | null;
  offers: MarketplaceAdminOffer[];
};

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
  profileStatus: "pending" | "active" | "rejected" | "suspended" | "archived";
  platforms: Array<
    MarketplaceAdminCreatorPlatformWrite & {
      platformId: string;
      createdAt: string;
      updatedAt: string;
    }
  >;
  createdAt: string;
  updatedAt: string;
};

export type MarketplaceAdminCreatorReviewResponse = {
  contractVersion: typeof MARKETPLACE_ADMIN_CONTRACT_VERSION;
  authorizationMode: MarketplaceAdminAuthorizationMode;
  userId: string;
  profile: MarketplaceAdminCreatorReviewProfile | null;
  moderation: MarketplaceAdminCreatorModerationCapabilities;
};

export type MarketplaceAdminCreatorModerationCapabilities = {
  allowed: boolean;
  allowedTransitions: Exclude<MarketplaceCreatorProfileStatus, "pending">[];
};

type MarketplaceAdminCreatorReviewData = Omit<MarketplaceAdminCreatorReviewResponse, "moderation">;

export type MarketplaceAdminDeleteOfferResponse = {
  contractVersion: typeof MARKETPLACE_ADMIN_CONTRACT_VERSION;
  authorizationMode: MarketplaceAdminAuthorizationMode;
  deletedOffer: {
    offerId: string;
    title: string;
  };
};

export type MarketplaceOfferWriteAudit = {
  actorUserId: string;
  actorOrganizationId: string;
  requestId: string;
  correlationId: string | null;
  source: RequestContext["audit"]["source"];
  occurredAt: string;
};

export type MarketplaceAdminRepository = {
  listCollaborations(input: {
    page: number;
    pageSize: number;
    status?: MarketplaceCollaborationStatus;
    search?: string;
  }): Promise<{ collaborations: MarketplaceCollaborationRead[]; total: number }>;
  respondToCollaborationAsHotel(input: {
    collaborationId: string;
    status: "accepted" | "declined";
    responseMessage?: string;
    idempotencyKey: string;
  }): Promise<MarketplaceCollaborationLifecycleWriteResponse | null>;
  approveCollaborationAsHotel(input: {
    collaborationId: string;
    idempotencyKey: string;
  }): Promise<MarketplaceCollaborationLifecycleWriteResponse | null>;
  updateCreatorProfileForUser(input: {
    userId: string;
    actorUserId: string;
    request: MarketplaceAdminCreatorProfileUpdateRequest;
    authorizationMode: MarketplaceAdminAuthorizationMode;
  }): Promise<MarketplaceAdminUserProfileUpdateResponse | null>;
  updateHotelProfileForUser(input: {
    userId: string;
    request: MarketplaceAdminHotelProfileUpdateRequest;
    authorizationMode: MarketplaceAdminAuthorizationMode;
  }): Promise<MarketplaceAdminUserProfileUpdateResponse | null>;
  listInviteCodes(): Promise<MarketplaceAdminInviteCode[]>;
  createInviteCode(input: {
    invite: MarketplaceAdminHotelAccountInvitePayload;
    createdByUserId: string;
  }): Promise<MarketplaceAdminInviteCode>;
  revokeInviteCode(inviteCodeId: string): Promise<boolean>;
  readHotelReviewForUser(input: {
    hotelUserId: string;
    authorizationMode: MarketplaceAdminAuthorizationMode;
  }): Promise<MarketplaceAdminHotelReviewResponse>;
  readCreatorReviewForUser(input: {
    userId: string;
    authorizationMode: MarketplaceAdminAuthorizationMode;
  }): Promise<MarketplaceAdminCreatorReviewData>;
  moderateCreatorProfile(input: {
    creatorProfileId: string;
    idempotencyKey: string;
    request: MarketplaceCreatorModerationRequest;
    audit: {
      actorUserId: string;
      actorOrganizationId: string;
      requestId: string;
      correlationId: string | null;
      requestedAt: string;
    };
  }): Promise<MarketplaceCreatorModerationResult>;
  createOfferForUser(input: {
    hotelUserId: string;
    audit: MarketplaceOfferWriteAudit;
    request: MarketplaceAdminCreateOfferRequest;
    authorizationMode: MarketplaceAdminAuthorizationMode;
  }): Promise<MarketplaceAdminOffer | null>;
  updateOfferForUser(input: {
    hotelUserId: string;
    audit: MarketplaceOfferWriteAudit;
    offerId: string;
    request: MarketplaceAdminUpdateOfferRequest;
    authorizationMode: MarketplaceAdminAuthorizationMode;
  }): Promise<MarketplaceAdminOffer | null>;
  verifyOfferForUser(input: {
    hotelUserId: string;
    offerId: string;
    mediaObjectIds?: string[];
    authorizationMode: MarketplaceAdminAuthorizationMode;
  }): Promise<MarketplaceAdminOffer | null>;
  deleteOfferForUser(input: {
    hotelUserId: string;
    offerId: string;
    authorizationMode: MarketplaceAdminAuthorizationMode;
  }): Promise<MarketplaceAdminDeleteOfferResponse | null>;
  isLegacySuperadmin?(userId: string): Promise<boolean>;
  close?(): Promise<void>;
};

export type MarketplaceAdminRoutesOptions = {
  repository: MarketplaceAdminRepository;
  legacySuperadminFallbackEnabled?: boolean;
};

class MarketplaceAdminInvalidProfileMediaError extends Error {
  constructor() {
    super("invalid_profile_picture_media");
    this.name = "MarketplaceAdminInvalidProfileMediaError";
  }
}

type MarketplaceAdminPool = {
  query<T extends QueryResultRow = QueryResultRow>(
    text: string,
    values?: readonly unknown[],
  ): Promise<Pick<QueryResult<T>, "rows">>;
  connect(): Promise<PoolClient>;
  end(): Promise<void>;
};

export function createPgMarketplaceAdminRepository(config: {
  connectionString: string;
  identityAccess: MarketplaceOfferIdentityAccessCommandPort;
  offerMediaPromotion?: MarketplaceOfferMediaPromotionPort;
  max?: number;
  pool?: MarketplaceAdminPool;
}): MarketplaceAdminRepository {
  if (!config.connectionString.trim()) {
    throw new Error("Marketplace admin repository connectionString must not be empty");
  }

  const pool =
    config.pool ??
    new pg.Pool({
      connectionString: config.connectionString,
      max: config.max,
    });

  return {
    async listCollaborations(input) {
      const params: unknown[] = [];
      const filters = buildCollaborationFilters(input, params);
      const limitParam = params.length + 1;
      const offsetParam = params.length + 2;
      const queryParams = [...params, input.pageSize, (input.page - 1) * input.pageSize];
      const [rows, count] = await Promise.all([
        pool.query<CollaborationRow>(
          `${COLLABORATION_SELECT_SQL}
           ${filters}
           ORDER BY collaboration.created_at DESC, collaboration.id ASC
           LIMIT $${limitParam} OFFSET $${offsetParam}`,
          queryParams,
        ),
        pool.query<{ total: string }>(
          `SELECT count(*)::text AS total
           FROM (${COLLABORATION_SELECT_SQL} ${filters}) AS admin_collaborations`,
          params,
        ),
      ]);
      return {
        collaborations: rows.rows.map(mapCollaborationRow),
        total: Number(count.rows[0]?.total ?? 0),
      };
    },
    async respondToCollaborationAsHotel(input) {
      const nextStatus = input.status === "accepted" ? "negotiating" : "declined";
      return executeMarketplaceAdminLifecycleCommand(pool, {
        operation: "marketplace_admin_collaboration_respond",
        collaborationId: input.collaborationId,
        idempotencyKey: input.idempotencyKey,
        fingerprintPayload: {
          action: "respond",
          collaborationId: input.collaborationId,
          status: input.status,
          responseMessage: input.responseMessage ?? "",
        },
        command: {
          action: "respond",
          idempotencyKey: input.idempotencyKey,
        },
        async mutate(client) {
          const result = await client.query<CollaborationRow>(
            `${COLLABORATION_MUTATION_CTE}
             UPDATE marketplace.collaborations AS collaboration
             SET lifecycle_status = $2,
                 responded_at = now(),
                 collaboration_metadata = jsonb_set(
                   collaboration.collaboration_metadata,
                   '{adminResponseMessage}',
                   to_jsonb($3::text),
                   true
                 ),
                 updated_at = now()
             FROM matched
             WHERE collaboration.id = matched.id
             RETURNING collaboration.id`,
            [input.collaborationId, nextStatus, input.responseMessage ?? ""],
          );
          return result.rows[0]?.id ?? null;
        },
      });
    },
    async approveCollaborationAsHotel(input) {
      const acceptedAt = new Date().toISOString();
      return executeMarketplaceAdminLifecycleCommand(pool, {
        operation: "marketplace_admin_collaboration_approve_terms",
        collaborationId: input.collaborationId,
        idempotencyKey: input.idempotencyKey,
        fingerprintPayload: {
          action: "approve_terms",
          collaborationId: input.collaborationId,
        },
        command: {
          action: "approve_terms",
          idempotencyKey: input.idempotencyKey,
          acceptedAt,
        },
        async mutate(client) {
          const result = await client.query<CollaborationRow>(
            `${COLLABORATION_MUTATION_CTE}
             UPDATE marketplace.collaborations AS collaboration
             SET hotel_agreed_at = COALESCE(collaboration.hotel_agreed_at, now()),
                 lifecycle_status = CASE
                   WHEN collaboration.creator_agreed_at IS NOT NULL THEN 'accepted'
                   ELSE 'negotiating'
                 END,
                 updated_at = now()
             FROM matched
             WHERE collaboration.id = matched.id
             RETURNING collaboration.id`,
            [input.collaborationId],
          );
          return result.rows[0]?.id ?? null;
        },
      });
    },
    async updateCreatorProfileForUser(input) {
      return writeOffer(pool, async (client) => {
        const profile = await resolveAdminCreatorProfile(client, input.userId);
        if (!profile) return null;
        const profileMedia =
          input.request.profilePictureMediaObjectId === undefined
            ? undefined
            : await resolveAdminCreatorProfileMedia(client, {
                mediaObjectId: input.request.profilePictureMediaObjectId,
                actorUserId: input.actorUserId,
                profile,
              });
        const result = await client.query<{ updatedAt: Date | string }>(
          `UPDATE marketplace.creator_profiles
           SET display_name = CASE WHEN $3::boolean THEN $4 ELSE display_name END,
               profile_picture_url = CASE
                 WHEN $15::boolean THEN $17
                 WHEN $5::boolean THEN $6
                 ELSE profile_picture_url
               END,
               location_text = CASE WHEN $7::boolean THEN $8 ELSE location_text END,
               short_description = CASE WHEN $9::boolean THEN $10 ELSE short_description END,
               portfolio_url = CASE WHEN $11::boolean THEN $12 ELSE portfolio_url END,
               phone = CASE WHEN $13::boolean THEN $14 ELSE phone END,
               profile_metadata = CASE
                 WHEN $15::boolean THEN CASE WHEN $16::text IS NULL
                   THEN profile_metadata - 'profilePictureMediaObjectId'
                   ELSE jsonb_set(profile_metadata, '{profilePictureMediaObjectId}', to_jsonb($16::text), true)
                 END
                 WHEN $5::boolean THEN profile_metadata - 'profilePictureMediaObjectId'
                 ELSE profile_metadata
               END,
               updated_at = now()
           WHERE id::text = $1
             AND organization_id::text = $2
           RETURNING updated_at AS "updatedAt"`,
          [
            profile.creatorProfileId,
            profile.organizationId,
            input.request.displayName !== undefined,
            input.request.displayName ?? null,
            input.request.profilePictureUrl !== undefined,
            input.request.profilePictureUrl ?? null,
            input.request.locationText !== undefined,
            input.request.locationText ?? null,
            input.request.shortDescription !== undefined,
            input.request.shortDescription ?? null,
            input.request.portfolioUrl !== undefined,
            input.request.portfolioUrl ?? null,
            input.request.phone !== undefined,
            input.request.phone ?? null,
            input.request.profilePictureMediaObjectId !== undefined,
            input.request.profilePictureMediaObjectId ?? null,
            profileMedia?.publicCdnUrl ?? null,
          ],
        );
        const updatedAt = result.rows[0]?.updatedAt;
        if (!updatedAt) return null;
        if (input.request.platforms) {
          await replaceCreatorPlatforms(client, {
            creatorProfileId: profile.creatorProfileId,
            organizationId: profile.organizationId,
            platforms: input.request.platforms,
          });
        }
        return {
          contractVersion: MARKETPLACE_ADMIN_CONTRACT_VERSION,
          authorizationMode: input.authorizationMode,
          userId: input.userId,
          profileType: "creator",
          updatedAt: toIsoString(updatedAt),
        };
      });
    },
    async updateHotelProfileForUser(input) {
      return writeOffer(pool, async (client) => {
        const profile = await resolveAdminHotelProfile(client, input.userId);
        if (!profile) return null;
        const result = await client.query<{ updatedAt: Date | string }>(
          `UPDATE marketplace.marketplace_hotel_profiles
           SET host_summary = CASE WHEN $3::boolean THEN $4 ELSE host_summary END,
               collaboration_guidelines = CASE
                 WHEN $5::boolean THEN $6
                 ELSE collaboration_guidelines
               END,
               updated_at = now()
           WHERE property_id::text = $1
             AND organization_id::text = $2
           RETURNING updated_at AS "updatedAt"`,
          [
            profile.propertyId,
            profile.organizationId,
            input.request.hostSummary !== undefined,
            input.request.hostSummary ?? null,
            input.request.collaborationGuidelines !== undefined,
            input.request.collaborationGuidelines ?? null,
          ],
        );
        const updatedAt = result.rows[0]?.updatedAt;
        if (!updatedAt) return null;
        return {
          contractVersion: MARKETPLACE_ADMIN_CONTRACT_VERSION,
          authorizationMode: input.authorizationMode,
          userId: input.userId,
          profileType: "hotel",
          updatedAt: toIsoString(updatedAt),
        };
      });
    },
    async listInviteCodes() {
      const result = await pool.query<InviteCodeRow>(
        `${INVITE_CODE_SELECT_SQL}
         WHERE invite.invite_type = 'hotel'
           AND invite.payload ->> 'contractVersion' = $1
           AND invite.status <> 'revoked'
         ORDER BY invite.created_at DESC, invite.id`,
        [HOTEL_ACCOUNT_INVITE_CONTRACT_VERSION],
      );
      return result.rows.map(toInviteCode);
    },
    async createInviteCode(input) {
      const result = await pool.query<InviteCodeRow>(
        `WITH invite AS (
           INSERT INTO marketplace.invite_codes (
             code,
             invite_type,
             status,
             payload,
             created_by_user_id,
             expires_at
           )
           VALUES ($1, 'hotel', 'pending', $2::jsonb, $3::uuid, now() + interval '30 days')
           RETURNING *
         )
         ${INVITE_CODE_SELECT_BODY}`,
        [
          `VAY-${randomBytes(24).toString("base64url")}`,
          JSON.stringify(input.invite),
          input.createdByUserId,
        ],
      );
      return toInviteCode(result.rows[0]!);
    },
    async revokeInviteCode(inviteCodeId) {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const invite = await client.query<{ id: string }>(
          `SELECT id::text AS id
           FROM marketplace.invite_codes
           WHERE id::text = $1
             AND invite_type = 'hotel'
             AND payload ->> 'contractVersion' = $2
             AND status <> 'redeemed'
           FOR UPDATE`,
          [inviteCodeId, HOTEL_ACCOUNT_INVITE_CONTRACT_VERSION],
        );
        if (!invite.rows[0]) {
          await client.query("ROLLBACK");
          return false;
        }

        const redemption = await client.query<{ exists: boolean }>(
          `SELECT EXISTS (
             SELECT 1
             FROM platform.idempotency_keys redemption
             JOIN identity.organizations organization
               ON organization.id = redemption.organization_id
             WHERE redemption.operation_scope = 'hotel_catalog'
               AND redemption.operation = 'hotel_setup.tracks.update'
               AND redemption.correlation_id = $1
               AND redemption.tenant_scope = 'organization'
               AND redemption.status = 'completed'
               AND redemption.response_status_code = 200
               AND organization.workos_external_id = $2
           ) AS exists`,
          [
            hotelAccountInviteTrackCorrelationId(inviteCodeId),
            hotelAccountInviteOrganizationExternalId(inviteCodeId),
          ],
        );
        if (redemption.rows[0]?.exists) {
          await client.query("ROLLBACK");
          return false;
        }

        const result = await client.query<{ id: string }>(
          `UPDATE marketplace.invite_codes
           SET status = 'revoked'
           WHERE id::text = $1
             AND status <> 'redeemed'
           RETURNING id::text AS id`,
          [inviteCodeId],
        );
        await client.query("COMMIT");
        return Boolean(result.rows[0]);
      } catch (error) {
        await rollbackQuietly(client);
        throw error;
      } finally {
        client.release();
      }
    },
    async readHotelReviewForUser(input) {
      const profileResult = await pool.query<AdminHotelReviewRow>(ADMIN_HOTEL_REVIEW_SELECT_SQL, [
        input.hotelUserId,
      ]);
      const profile = profileResult.rows[0];
      if (!profile) {
        return {
          contractVersion: MARKETPLACE_ADMIN_CONTRACT_VERSION,
          authorizationMode: input.authorizationMode,
          userId: input.hotelUserId,
          profile: null,
          offers: [],
        };
      }
      const offerResult = await pool.query<OfferRow>(
        `${OFFER_SELECT_SQL}
         WHERE offer.property_id::text = $1
           AND offer.organization_id::text = $2
           AND offer.offer_status <> 'archived'
         ORDER BY offer.created_at DESC, offer.id ASC`,
        [profile.propertyId, profile.organizationId],
      );
      return {
        contractVersion: MARKETPLACE_ADMIN_CONTRACT_VERSION,
        authorizationMode: input.authorizationMode,
        userId: input.hotelUserId,
        profile: {
          propertyId: profile.propertyId,
          displayName: profile.displayName,
          location: profile.location ?? "",
          hostSummary: profile.hostSummary,
          profileStatus: profile.profileStatus,
          createdAt: toIsoString(profile.createdAt),
          updatedAt: toIsoString(profile.updatedAt),
        },
        offers: offerResult.rows.map((row) => mapOfferRow(row, input.authorizationMode)),
      };
    },
    async readCreatorReviewForUser(input) {
      const result = await pool.query<AdminCreatorReviewRow>(ADMIN_CREATOR_REVIEW_SELECT_SQL, [
        input.userId,
      ]);
      const row = result.rows.length === 1 ? result.rows[0] : undefined;
      return {
        contractVersion: MARKETPLACE_ADMIN_CONTRACT_VERSION,
        authorizationMode: input.authorizationMode,
        userId: input.userId,
        profile: row ? mapCreatorReviewRow(row) : null,
      };
    },
    async moderateCreatorProfile(input) {
      return executeMarketplaceCreatorModeration(pool, input);
    },
    async createOfferForUser(input) {
      return writeOffer(pool, async (client) => {
        const profile = await resolveAdminHotelProfile(client, input.hotelUserId);
        if (!profile) return null;
        assertMarketplaceProfileComplete(profile);
        const offer = await client.query<{ id: string }>(
          `INSERT INTO marketplace.marketplace_offers (
             property_id,
             organization_id,
             source_system,
             title,
             offer_summary,
             offer_status
           )
           VALUES ($1, $2, 'marketplace', $3, $4, 'verified')
           RETURNING id`,
          [
            profile.propertyId,
            profile.organizationId,
            input.request.title,
            input.request.offerSummary ?? null,
          ],
        );
        const offerId = offer.rows[0]?.id;
        if (!offerId) return null;
        await config.identityAccess.grantOperator({
          transaction: client,
          offerId,
          organizationId: profile.organizationId,
        });
        await replaceOfferChildren(client, {
          offerId,
          propertyId: profile.propertyId,
          organizationId: profile.organizationId,
          deliverables: input.request.deliverables,
          compensationOptions: input.request.compensationOptions,
          creatorRequirements: input.request.creatorRequirements,
          matchingCriteria: input.request.matchingCriteria,
          actorUserId: input.audit.actorUserId,
        });
        await recordOfferMatchingAudit(client, {
          action: "created",
          offerId,
          propertyId: profile.propertyId,
          request: input.request,
          audit: input.audit,
        });
        await syncOfferReadModel(client, offerId, "initialize");
        return readOffer(client, offerId, input.authorizationMode);
      });
    },
    async updateOfferForUser(input) {
      return writeOffer(pool, async (client) => {
        const profile = await resolveAdminHotelProfile(client, input.hotelUserId);
        if (!profile) return null;
        const target = await resolveOfferForProfile(client, profile, input.offerId);
        if (!target) return null;
        await client.query(
          `UPDATE marketplace.marketplace_offers
           SET title = COALESCE($2, title),
               offer_summary = CASE WHEN $3::boolean THEN $4 ELSE offer_summary END,
               updated_at = now()
           WHERE id = $1`,
          [
            target.offerResourceId,
            input.request.title,
            input.request.offerSummary !== undefined,
            input.request.offerSummary ?? null,
          ],
        );
        if (
          input.request.deliverables !== undefined ||
          input.request.compensationOptions !== undefined ||
          input.request.creatorRequirements !== undefined ||
          input.request.matchingCriteria !== undefined
        ) {
          const current = await readOffer(client, target.offerResourceId, input.authorizationMode);
          if (!current) return null;
          assertMergedOfferUpdateValid(current, input.request);
          await replaceOfferChildren(client, {
            offerId: target.offerResourceId,
            propertyId: profile.propertyId,
            organizationId: profile.organizationId,
            deliverables: input.request.deliverables,
            compensationOptions: input.request.compensationOptions,
            creatorRequirements: input.request.creatorRequirements,
            matchingCriteria: input.request.matchingCriteria,
            actorUserId: input.audit.actorUserId,
          });
          await recordOfferMatchingAudit(client, {
            action: "updated",
            offerId: target.offerResourceId,
            propertyId: profile.propertyId,
            request: input.request,
            audit: input.audit,
          });
        }
        await syncOfferReadModel(client, target.offerResourceId, "initialize");
        return readOffer(client, target.offerResourceId, input.authorizationMode);
      });
    },
    async verifyOfferForUser(input) {
      const profile = await resolveAdminHotelProfile(pool, input.hotelUserId);
      if (!profile || !["pending", "verified"].includes(profile.profileStatus)) return null;
      assertMarketplaceProfileComplete(profile);
      const target = await resolveOfferForProfile(pool, profile, input.offerId);
      if (!target || !["pending", "verified"].includes(target.offerStatus)) return null;
      if (
        !(await hasEligibleOfferMedia(
          pool,
          profile.organizationId,
          target.offerResourceId,
          input.mediaObjectIds,
        ))
      ) {
        throw Object.assign(
          new Error(
            "Marketplace offer verification requires at least one pending or approved photo",
          ),
          { statusCode: 422 },
        );
      }
      if (!config.offerMediaPromotion) {
        throw Object.assign(new Error("Marketplace offer media approval is not configured"), {
          statusCode: 503,
        });
      }
      await config.offerMediaPromotion.promoteOfferMedia({
        organizationId: profile.organizationId,
        offerId: target.offerResourceId,
        mediaObjectIds: input.mediaObjectIds,
      });
      return writeOffer(pool, async (client) => {
        const verifiedProfile = await client.query<{ propertyId: string }>(
          `UPDATE marketplace.marketplace_hotel_profiles
           SET marketplace_profile_status = 'verified', updated_at = now()
           WHERE property_id = $1::uuid
             AND organization_id = $2::uuid
             AND profile_complete = TRUE
             AND marketplace_profile_status IN ('pending', 'verified')
           RETURNING property_id::text AS "propertyId"`,
          [profile.propertyId, profile.organizationId],
        );
        if (!verifiedProfile.rows[0]) return null;
        const current = await resolveOfferForProfile(client, profile, target.offerResourceId);
        if (!current || !["pending", "verified"].includes(current.offerStatus)) return null;
        const verified = await client.query<{ id: string }>(
          `UPDATE marketplace.marketplace_offers
           SET offer_status = 'verified', updated_at = now()
           WHERE id = $1::uuid
             AND offer_status IN ('pending', 'verified')
           RETURNING id::text AS id`,
          [current.offerResourceId],
        );
        if (!verified.rows[0]) return null;
        await syncOfferReadModel(client, current.offerResourceId, "initialize");
        return readOffer(client, current.offerResourceId, input.authorizationMode);
      });
    },
    async deleteOfferForUser(input) {
      return writeOffer(pool, async (client) => {
        const profile = await resolveAdminHotelProfile(client, input.hotelUserId);
        if (!profile) return null;
        const target = await resolveOfferForProfile(client, profile, input.offerId);
        if (!target) return null;
        await client.query(
          `UPDATE marketplace.marketplace_offers
           SET offer_status = 'archived', updated_at = now()
           WHERE id = $1`,
          [target.offerResourceId],
        );
        await syncOfferReadModel(client, target.offerResourceId, "disable");
        await config.identityAccess.archiveOperator({
          transaction: client,
          offerId: target.offerResourceId,
          organizationId: profile.organizationId,
        });
        return {
          contractVersion: MARKETPLACE_ADMIN_CONTRACT_VERSION,
          authorizationMode: input.authorizationMode,
          deletedOffer: {
            offerId: target.offerResourceId,
            title: target.title,
          },
        };
      });
    },
    async isLegacySuperadmin(userId) {
      const hasColumn = await pool.query<{ exists: boolean }>(
        `SELECT EXISTS (
           SELECT 1
           FROM information_schema.columns
           WHERE table_schema = 'public'
             AND table_name = 'users'
             AND column_name = 'is_superadmin'
         )`,
      );
      if (!hasColumn.rows[0]?.exists) return false;
      const result = await pool.query<{ is_superadmin: boolean }>(
        `SELECT is_superadmin
         FROM public.users
         WHERE id::text = $1
         LIMIT 1`,
        [userId],
      );
      return result.rows[0]?.is_superadmin === true;
    },
    async close() {
      await Promise.all([pool.end(), config.offerMediaPromotion?.close?.()]);
    },
  };
}

export async function registerMarketplaceAdminRoutes(
  app: FastifyInstance,
  options: MarketplaceAdminRoutesOptions,
): Promise<void> {
  const { repository } = options;

  app.addHook("onClose", async () => {
    await repository.close?.();
  });

  app.get<{ Querystring: AdminCollaborationsQuery }>("/admin/collaborations", async (request) => {
    const access = await requireMarketplaceAdminAccess(request, options);
    const page = parsePositiveInteger(firstQueryValue(request.query.page), 1);
    const pageSize = Math.min(
      parsePositiveInteger(
        firstQueryValue(request.query.pageSize) ?? firstQueryValue(request.query.page_size),
        20,
      ),
      100,
    );
    const status = toCollaborationStatus(firstQueryValue(request.query.status));
    const search = firstQueryValue(request.query.search);
    const result = await repository.listCollaborations({
      page,
      pageSize,
      ...(status ? { status } : {}),
      ...(search ? { search } : {}),
    });
    return {
      contractVersion: MARKETPLACE_ADMIN_CONTRACT_VERSION,
      authorizationMode: access.authorizationMode,
      collaborations: result.collaborations,
      pagination: {
        page,
        pageSize,
        total: result.total,
      },
    } satisfies MarketplaceAdminCollaborationsResponse;
  });

  app.get("/admin/invite-codes", async (request) => {
    await requireMarketplaceAdminAccess(request, options);
    return repository.listInviteCodes();
  });

  app.post<{ Body: unknown }>("/admin/invite-codes", async (request, reply) => {
    const access = await requireMarketplaceAdminAccess(request, options);
    const parsed = parseHotelAccountInviteCreateRequest(request.body);
    if (typeof parsed === "string") return sendAdminError(reply, 422, parsed);
    const inviteCode = await repository.createInviteCode({
      invite: {
        contractVersion: HOTEL_ACCOUNT_INVITE_CONTRACT_VERSION,
        ...parsed,
        handoffPath: HOTEL_ACCOUNT_INVITE_HANDOFF_PATH,
      },
      createdByUserId: access.context.actor.internalUserId,
    });
    return reply.status(201).send(inviteCode);
  });

  app.delete<{ Params: InviteCodeParams }>(
    "/admin/invite-codes/:inviteCodeId",
    async (request, reply) => {
      await requireMarketplaceAdminAccess(request, options);
      const revoked = await repository.revokeInviteCode(request.params.inviteCodeId);
      if (!revoked) return sendAdminError(reply, 404, "invite_code_not_found");
      return reply.status(204).send();
    },
  );

  app.get<{ Params: HotelUserParams }>("/admin/users/:hotelUserId/review", async (request) => {
    const access = await requireMarketplaceAdminAccess(request, options);
    return repository.readHotelReviewForUser({
      hotelUserId: request.params.hotelUserId,
      authorizationMode: access.authorizationMode,
    });
  });

  app.get<{ Params: { userId: string } }>(
    "/admin/users/:userId/review/creator",
    async (request) => {
      const access = await requireMarketplaceAdminAccess(request, options);
      const review = await repository.readCreatorReviewForUser({
        userId: request.params.userId,
        authorizationMode: access.authorizationMode,
      });
      return {
        ...review,
        moderation: creatorModerationCapabilities(request, review.profile),
      } satisfies MarketplaceAdminCreatorReviewResponse;
    },
  );

  app.post<{ Params: { creatorProfileId: string }; Body: unknown }>(
    "/admin/creators/:creatorProfileId/moderation",
    async (request, reply) => {
      const context = requireMarketplaceCreatorModerationAccess(request);
      if (!UUID_PATTERN.test(request.params.creatorProfileId)) {
        return sendAdminError(reply, 422, "invalid_creator_profile_id");
      }
      const idempotencyKey = readSingleIdempotencyKey(request);
      if (!idempotencyKey) return sendAdminError(reply, 422, "idempotency_required");
      const parsed = parseMarketplaceCreatorModerationRequest(request.body);
      if (typeof parsed === "string") return sendAdminError(reply, 422, parsed);
      const result = await repository.moderateCreatorProfile({
        creatorProfileId: request.params.creatorProfileId.toLowerCase(),
        idempotencyKey,
        request: parsed,
        audit: {
          actorUserId: context.actor.internalUserId,
          actorOrganizationId: context.selectedOrganization.organizationId,
          requestId: context.audit.requestId,
          correlationId: context.audit.correlationId ?? null,
          requestedAt: context.audit.receivedAt,
        },
      });
      if (result.ok) return result.response;
      const statusCode = result.error.code === "creator_profile_not_found" ? 404 : 409;
      return sendAdminError(reply, statusCode, result.error.code, result.error.currentStatus);
    },
  );

  app.post<{ Params: CollaborationParams; Body: RespondBody }>(
    "/admin/collaborations/:collaborationId/respond",
    async (request, reply) => {
      await requireMarketplaceAdminAccess(request, options);
      const idempotencyKey = readIdempotencyKey(request);
      if (!idempotencyKey) return sendAdminError(reply, 422, "idempotency_required");
      if (request.body?.status !== "accepted" && request.body?.status !== "declined") {
        return sendAdminError(reply, 422, "invalid_status");
      }
      const result = await repository.respondToCollaborationAsHotel({
        collaborationId: request.params.collaborationId,
        status: request.body.status,
        responseMessage: request.body.responseMessage ?? request.body.response_message,
        idempotencyKey,
      });
      if (!result) return sendAdminError(reply, 404, "collaboration_not_found");
      return result;
    },
  );

  app.post<{ Params: CollaborationParams; Body: ApproveBody }>(
    "/admin/collaborations/:collaborationId/approve",
    async (request, reply) => {
      await requireMarketplaceAdminAccess(request, options);
      const idempotencyKey = readIdempotencyKey(request);
      if (!idempotencyKey) return sendAdminError(reply, 422, "idempotency_required");
      const result = await repository.approveCollaborationAsHotel({
        collaborationId: request.params.collaborationId,
        idempotencyKey,
      });
      if (!result) return sendAdminError(reply, 404, "collaboration_not_found");
      return result;
    },
  );

  app.put<{ Params: UserProfileParams; Body: unknown }>(
    "/admin/users/:userId/profile/:profileType",
    async (request, reply) => {
      const access = await requireMarketplaceAdminAccess(request, options);

      if (request.params.profileType === "creator") {
        const validation = validateCreatorProfileRequest(request.body);
        if (typeof validation === "string") return sendAdminError(reply, 422, validation);
        let result: MarketplaceAdminUserProfileUpdateResponse | null;
        try {
          result = await repository.updateCreatorProfileForUser({
            userId: request.params.userId,
            actorUserId: access.context.actor.internalUserId,
            request: validation,
            authorizationMode: access.authorizationMode,
          });
        } catch (error) {
          if (error instanceof MarketplaceAdminInvalidProfileMediaError) {
            return sendAdminError(reply, 422, error.message);
          }
          throw error;
        }
        if (!result) return sendAdminError(reply, 404, "creator_profile_not_found");
        return result;
      }

      if (request.params.profileType === "hotel") {
        const validation = validateHotelProfileRequest(request.body);
        if (typeof validation === "string") return sendAdminError(reply, 422, validation);
        const result = await repository.updateHotelProfileForUser({
          userId: request.params.userId,
          request: validation,
          authorizationMode: access.authorizationMode,
        });
        if (!result) return sendAdminError(reply, 404, "hotel_profile_not_found");
        return result;
      }

      return sendAdminError(reply, 422, "invalid_profile_type");
    },
  );

  app.post<{ Params: HotelUserParams; Body: MarketplaceAdminCreateOfferRequest }>(
    "/admin/users/:hotelUserId/offers",
    async (request, reply) => {
      const access = await requireMarketplaceAdminAccess(request, options);
      const validation = validateCreateOfferRequest(request.body);
      if (validation) return sendAdminError(reply, 422, validation);
      const result = await repository.createOfferForUser({
        hotelUserId: request.params.hotelUserId,
        audit: offerWriteAudit(access.context),
        request: request.body,
        authorizationMode: access.authorizationMode,
      });
      if (!result) return sendAdminError(reply, 404, "hotel_profile_not_found");
      return reply.status(201).send(result);
    },
  );

  app.put<{ Params: OfferParams; Body: MarketplaceAdminUpdateOfferRequest }>(
    "/admin/users/:hotelUserId/offers/:offerId",
    async (request, reply) => {
      const access = await requireMarketplaceAdminAccess(request, options);
      const validation = validateUpdateOfferRequest(request.body);
      if (validation) return sendAdminError(reply, 422, validation);
      let result: MarketplaceAdminOffer | null;
      try {
        result = await repository.updateOfferForUser({
          hotelUserId: request.params.hotelUserId,
          audit: offerWriteAudit(access.context),
          offerId: request.params.offerId,
          request: request.body,
          authorizationMode: access.authorizationMode,
        });
      } catch (error) {
        if (error instanceof MarketplaceOfferConsistencyError) {
          return sendAdminError(reply, 422, error.code);
        }
        throw error;
      }
      if (!result) return sendAdminError(reply, 404, "offer_not_found");
      return result;
    },
  );

  app.post<{ Params: OfferParams; Body: MarketplaceAdminVerifyOfferRequest }>(
    "/admin/users/:hotelUserId/offers/:offerId/verify",
    async (request, reply) => {
      const access = await requireMarketplaceAdminAccess(request, options);
      const mediaObjectIds = validateOfferMediaObjectIds(request.body);
      if (typeof mediaObjectIds === "string") return sendAdminError(reply, 422, mediaObjectIds);
      const result = await repository.verifyOfferForUser({
        hotelUserId: request.params.hotelUserId,
        offerId: request.params.offerId,
        ...(mediaObjectIds ? { mediaObjectIds } : {}),
        authorizationMode: access.authorizationMode,
      });
      if (!result) return sendAdminError(reply, 404, "offer_not_found");
      return result;
    },
  );

  app.delete<{ Params: OfferParams }>(
    "/admin/users/:hotelUserId/offers/:offerId",
    async (request, reply) => {
      const access = await requireMarketplaceAdminAccess(request, options);
      const result = await repository.deleteOfferForUser({
        hotelUserId: request.params.hotelUserId,
        offerId: request.params.offerId,
        authorizationMode: access.authorizationMode,
      });
      if (!result) return sendAdminError(reply, 404, "offer_not_found");
      return result;
    },
  );
}

async function requireMarketplaceAdminAccess(
  request: FastifyRequest,
  options: MarketplaceAdminRoutesOptions,
): Promise<MarketplaceAdminRouteAccess> {
  try {
    const context = enforceRoutePolicy(request, {
      permission: MARKETPLACE_ADMIN_COLLABORATIONS_CONTRACT.permission,
      resource: {
        product: "platform",
        resourceType: "platform",
        resourceId: "vayada",
        allowedRelationships: ["operator"],
      },
    });
    return { context, authorizationMode: "platform_organization_membership" };
  } catch (error) {
    if (!options.legacySuperadminFallbackEnabled) throw error;
    const context = requireAuthContext(request);
    if (await options.repository.isLegacySuperadmin?.(context.actor.internalUserId)) {
      return { context, authorizationMode: "legacy_superadmin_fallback" };
    }
    throw error;
  }
}

export function offerWriteAudit(context: RequestContext): MarketplaceOfferWriteAudit {
  return {
    actorUserId: context.actor.internalUserId,
    actorOrganizationId: context.selectedOrganization.organizationId,
    requestId: context.audit.requestId,
    correlationId: context.audit.correlationId ?? null,
    source: context.audit.source,
    occurredAt: context.audit.receivedAt,
  };
}

function requireMarketplaceCreatorModerationAccess(request: FastifyRequest): RequestContext {
  const policy = MARKETPLACE_ADMIN_CREATOR_MODERATION_CONTRACT;
  const resource = {
    product: policy.resource.product,
    resourceType: policy.resource.resourceType,
    resourceId: policy.resource.resourceId,
  } as const;
  return enforceRoutePolicy(request, {
    permission: policy.permission,
    entitlement: { ...policy.entitlement, resource },
    resource: { ...resource, allowedRelationships: [...policy.resource.allowedRelationships] },
  });
}

function creatorModerationCapabilities(
  request: FastifyRequest,
  profile: MarketplaceAdminCreatorReviewProfile | null,
): MarketplaceAdminCreatorModerationCapabilities {
  try {
    requireMarketplaceCreatorModerationAccess(request);
  } catch {
    return { allowed: false, allowedTransitions: [] };
  }
  if (!profile) return { allowed: true, allowedTransitions: [] };
  return {
    allowed: true,
    allowedTransitions: MARKETPLACE_CREATOR_PROFILE_STATUSES.filter(
      isMarketplaceCreatorModerationTargetStatus,
    ).filter(
      (nextStatus) =>
        canModerateMarketplaceCreatorProfile(profile.profileStatus, nextStatus) &&
        (nextStatus !== "active" || profile.profileComplete),
    ),
  };
}

function readIdempotencyKey(request: FastifyRequest): string | null {
  const header = request.headers["idempotency-key"];
  const headerValue = Array.isArray(header) ? header[0] : header;
  const body = request.body && typeof request.body === "object" ? request.body : {};
  const bodyValue = "idempotencyKey" in body ? body.idempotencyKey : undefined;
  return readNonEmptyString(headerValue) ?? readNonEmptyString(bodyValue);
}

function readSingleIdempotencyKey(request: FastifyRequest): string | null {
  const occurrences = request.raw.rawHeaders.filter(
    (value, index) => index % 2 === 0 && value.toLowerCase() === "idempotency-key",
  ).length;
  const header = request.headers["idempotency-key"];
  if (occurrences !== 1 || typeof header !== "string") return null;
  const key = header.trim();
  return key.length >= 1 && key.length <= 200 ? key : null;
}

function parseMarketplaceCreatorModerationRequest(
  body: unknown,
): MarketplaceCreatorModerationRequest | string {
  if (!isRecord(body) || !hasOnlyKeys(body, ["expectedStatus", "nextStatus", "reason"])) {
    return "invalid_moderation_body";
  }
  if (!isMarketplaceCreatorProfileStatus(body.expectedStatus)) return "invalid_expected_status";
  if (!isMarketplaceCreatorModerationTargetStatus(body.nextStatus)) return "invalid_next_status";
  const reason = typeof body.reason === "string" ? body.reason.trim() : "";
  if (!isMarketplaceCreatorModerationReason(reason)) return "invalid_moderation_reason";
  return { expectedStatus: body.expectedStatus, nextStatus: body.nextStatus, reason };
}

const HOTEL_ACCOUNT_INVITE_REQUEST_KEYS = [
  "identity",
  "organization",
  "property",
  "selectedTracks",
] as const;
const HOTEL_ACCOUNT_INVITE_PAYLOAD_KEYS = [
  "contractVersion",
  ...HOTEL_ACCOUNT_INVITE_REQUEST_KEYS,
  "handoffPath",
] as const;
const HOTEL_ACCOUNT_INVITE_REDEMPTION_KEY = "redemption";
const INVITE_EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const INVITE_CONTROL_CHARACTER_PATTERN = /[\u0000-\u001f\u007f]/;

export function parseHotelAccountInviteCreateRequest(
  body: unknown,
): MarketplaceAdminHotelAccountInviteCreateRequest | string {
  if (!isRecord(body)) return "invite_body_required";
  if (!hasOnlyKeys(body, HOTEL_ACCOUNT_INVITE_REQUEST_KEYS)) {
    return "unsupported_invite_field";
  }
  if (!isRecord(body.identity) || !hasOnlyKeys(body.identity, ["email"])) {
    return "invalid_invite_identity";
  }
  if (!isRecord(body.organization) || !hasOnlyKeys(body.organization, ["displayName"])) {
    return "invalid_invite_organization";
  }
  if (!isRecord(body.property) || !hasOnlyKeys(body.property, ["displayName"])) {
    return "invalid_invite_property";
  }

  const email = readInviteText(body.identity.email, 254)?.toLowerCase();
  const organizationName = readInviteText(body.organization.displayName, 160);
  const propertyName = readInviteText(body.property.displayName, 160);
  if (!email || !INVITE_EMAIL_PATTERN.test(email)) return "invalid_invite_email";
  if (!organizationName) return "invalid_invite_organization";
  if (!propertyName) return "invalid_invite_property";
  if (
    !Array.isArray(body.selectedTracks) ||
    body.selectedTracks.length === 0 ||
    body.selectedTracks.length > 2 ||
    body.selectedTracks.some((track) => !isSetupTrack(track))
  ) {
    return "invalid_selected_tracks";
  }

  const uniqueTracks = new Set<SetupTrack>(body.selectedTracks as SetupTrack[]);
  if (uniqueTracks.size !== body.selectedTracks.length) return "invalid_selected_tracks";
  const selectedTracks: SetupTrack[] = [];
  if (uniqueTracks.has("hotel_operations")) selectedTracks.push("hotel_operations");
  if (uniqueTracks.has("creator_marketplace")) selectedTracks.push("creator_marketplace");

  return {
    identity: { email },
    organization: { displayName: organizationName },
    property: { displayName: propertyName },
    selectedTracks,
  };
}

function parseStoredHotelAccountInvite(
  value: unknown,
): MarketplaceAdminHotelAccountInvitePayload | null {
  if (!isRecord(value)) return null;
  const hasRedemption = Object.prototype.hasOwnProperty.call(
    value,
    HOTEL_ACCOUNT_INVITE_REDEMPTION_KEY,
  );
  const allowedKeys = hasRedemption
    ? [...HOTEL_ACCOUNT_INVITE_PAYLOAD_KEYS, HOTEL_ACCOUNT_INVITE_REDEMPTION_KEY]
    : HOTEL_ACCOUNT_INVITE_PAYLOAD_KEYS;
  if (Object.keys(value).length !== allowedKeys.length || !hasOnlyKeys(value, allowedKeys)) {
    return null;
  }
  if (hasRedemption) {
    const redemption = value.redemption;
    if (
      !isRecord(redemption) ||
      Object.keys(redemption).length !== 1 ||
      !hasOnlyKeys(redemption, ["organizationId"]) ||
      typeof redemption.organizationId !== "string"
    ) {
      return null;
    }
  }
  if (
    value.contractVersion !== HOTEL_ACCOUNT_INVITE_CONTRACT_VERSION ||
    value.handoffPath !== HOTEL_ACCOUNT_INVITE_HANDOFF_PATH
  ) {
    return null;
  }
  const parsed = parseHotelAccountInviteCreateRequest({
    identity: value.identity,
    organization: value.organization,
    property: value.property,
    selectedTracks: value.selectedTracks,
  });
  if (typeof parsed === "string") return null;
  return {
    contractVersion: HOTEL_ACCOUNT_INVITE_CONTRACT_VERSION,
    ...parsed,
    handoffPath: HOTEL_ACCOUNT_INVITE_HANDOFF_PATH,
  };
}

function hasOnlyKeys(value: Record<string, unknown>, allowedKeys: readonly string[]): boolean {
  return Object.keys(value).every((key) => allowedKeys.includes(key));
}

function readInviteText(value: unknown, maximumLength: number): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  if (
    normalized.length === 0 ||
    normalized.length > maximumLength ||
    INVITE_CONTROL_CHARACTER_PATTERN.test(normalized)
  ) {
    return null;
  }
  return normalized;
}

export function validateCreateOfferRequest(
  body: MarketplaceAdminCreateOfferRequest | undefined,
): string | null {
  if (!body || !readNonEmptyString(body.title)) return "title_required";
  if (!Array.isArray(body.deliverables) || body.deliverables.length === 0) {
    return "deliverables_required";
  }
  if (!Array.isArray(body.compensationOptions) || body.compensationOptions.length === 0) {
    return "compensation_options_required";
  }
  if (!body.creatorRequirements) return "creator_requirements_required";
  return validateOfferChildren(
    body.deliverables,
    body.compensationOptions,
    body.creatorRequirements,
    body.matchingCriteria,
  );
}

export function validateUpdateOfferRequest(
  body: MarketplaceAdminUpdateOfferRequest | undefined,
): string | null {
  if (!body) return "body_required";
  if (body.title !== undefined && !readNonEmptyString(body.title)) return "title_required";
  if (body.deliverables?.length === 0) return "deliverables_required";
  if (body.compensationOptions?.length === 0) return "compensation_options_required";
  return validateOfferChildren(
    body.deliverables,
    body.compensationOptions,
    body.creatorRequirements,
    body.matchingCriteria,
  );
}

function validateOfferChildren(
  deliverables?: MarketplaceOfferDeliverableWrite[],
  compensationOptions?: MarketplaceOfferCompensationOptionWrite[],
  requirements?: MarketplaceOfferCreatorRequirementsWrite | null,
  matchingCriteria?: MarketplaceOfferMatchingCriteriaWrite | null,
): string | null {
  if (deliverables) {
    for (const deliverable of deliverables) {
      if (!readNonEmptyString(deliverable.deliverableType)) return "invalid_deliverable";
      if (!isPositiveInteger(deliverable.quantity)) return "invalid_deliverable";
      if (!isOptionalRequirementLevel(deliverable.requirementLevel)) {
        return "invalid_deliverable_requirement_level";
      }
    }
  }
  if (compensationOptions) {
    for (const option of compensationOptions) {
      if (!["free_stay", "paid", "discount", "affiliate"].includes(option.compensationType)) {
        return "invalid_compensation_type";
      }
      if (option.compensationType === "free_stay") {
        if (
          !isPositiveInteger(option.freeStayMinNights) ||
          !isPositiveInteger(option.freeStayMaxNights) ||
          option.freeStayMinNights > option.freeStayMaxNights
        ) {
          return "invalid_free_stay";
        }
      }
      if (option.compensationType === "paid" && !isPositiveDecimalString(option.paidMaxAmount)) {
        return "invalid_paid_amount";
      }
      if (option.compensationType === "discount" && !isPercentage(option.discountPercentage)) {
        return "invalid_discount";
      }
      if (option.compensationType === "affiliate" && !isPercentage(option.commissionPercentage)) {
        return "invalid_commission";
      }
      if (!isOptionalRequirementLevel(option.followerRequirementLevel)) {
        return "invalid_follower_requirement_level";
      }
      if (
        option.followerRequirementLevel &&
        (!isPositiveInteger(option.minFollowers) ||
          !Array.isArray(option.platforms) ||
          option.platforms.length === 0 ||
          option.platforms.some((platform) => !toPlatformName(platform)))
      ) {
        return "invalid_follower_requirement";
      }
    }
  }
  if (requirements) {
    if (
      !Array.isArray(requirements.platforms) ||
      !Array.isArray(requirements.targetCountries) ||
      !Array.isArray(requirements.creatorTypes)
    ) {
      return "invalid_requirements";
    }
    const selections = [
      [requirements.platformRequirementLevel, requirements.platforms],
      [requirements.targetCountriesRequirementLevel, requirements.targetCountries],
      [requirements.creatorTypesRequirementLevel, requirements.creatorTypes],
    ] as const;
    if (
      selections.some(
        ([level, values]) =>
          !isOptionalRequirementLevel(level) || (level === "required" && values.length === 0),
      )
    ) {
      return "invalid_requirement_level";
    }
    if (
      requirements.platformRequirementLevel === "required" &&
      deliverables &&
      requirements.platforms.some(
        (platform) => !deliverables.some((deliverable) => deliverable.platform === platform),
      )
    ) {
      return "inconsistent_requirement_platforms";
    }
  }
  const parsedCriteria =
    matchingCriteria === undefined || matchingCriteria === null
      ? matchingCriteria
      : parseMarketplaceOfferMatchingCriteriaWrite(matchingCriteria);
  if (matchingCriteria !== undefined && matchingCriteria !== null && !parsedCriteria) {
    return "invalid_matching_criteria";
  }
  if (parsedCriteria?.expectedCompensationValue && compensationOptions) {
    const currencies = new Set(compensationOptions.map((option) => option.currency ?? "USD"));
    if (!currencies.has(parsedCriteria.expectedCompensationValue.currency)) {
      return "inconsistent_compensation_currency";
    }
  }
  return null;
}

export class MarketplaceOfferConsistencyError extends Error {
  readonly statusCode = 422;

  constructor(readonly code: string) {
    super(code);
    this.name = "MarketplaceOfferConsistencyError";
  }
}

export function validateMergedOfferUpdate(
  current: MarketplaceAdminOffer,
  request: MarketplaceAdminUpdateOfferRequest,
): string | null {
  return validateOfferChildren(
    request.deliverables ?? current.deliverables,
    request.compensationOptions ?? current.compensationOptions,
    request.creatorRequirements === undefined
      ? current.creatorRequirements
      : request.creatorRequirements,
    request.matchingCriteria === undefined
      ? matchingCriteriaWrite(current.matchingCriteria ?? null)
      : request.matchingCriteria,
  );
}

function assertMergedOfferUpdateValid(
  current: MarketplaceAdminOffer,
  request: MarketplaceAdminUpdateOfferRequest,
): void {
  const validation = validateMergedOfferUpdate(current, request);
  if (validation) throw new MarketplaceOfferConsistencyError(validation);
}

function matchingCriteriaWrite(
  criteria: MarketplaceOfferMatchingCriteria | null,
): MarketplaceOfferMatchingCriteriaWrite | null {
  if (!criteria) return null;
  return {
    primaryCampaignGoal: criteria.primaryCampaignGoal,
    availability: criteria.availability,
    contentCategories: criteria.contentCategories,
    contentStyles: criteria.contentStyles,
    usageRights: criteria.usageRights,
    includedRevisionRounds: criteria.includedRevisionRounds,
    expectedEffortHours: criteria.expectedEffortHours,
    expectedCompensationValue: criteria.expectedCompensationValue,
    applicationCapacity: criteria.applicationCapacity,
  };
}

function isOptionalRequirementLevel(value: unknown): boolean {
  return value === undefined || value === null || value === "required" || value === "preferred";
}

function validateCreatorProfileRequest(
  body: unknown,
): MarketplaceAdminCreatorProfileUpdateRequest | string {
  if (!isRecord(body)) return "body_required";
  const request: MarketplaceAdminCreatorProfileUpdateRequest = {};
  const stringFields = [
    ["displayName", false],
    ["profilePictureUrl", true],
    ["locationText", true],
    ["shortDescription", true],
    ["portfolioUrl", true],
    ["phone", true],
  ] as const;

  for (const [key, nullable] of stringFields) {
    if (!(key in body)) continue;
    const value = body[key];
    if (value === null && nullable) {
      request[key] = null;
    } else if (typeof value === "string") {
      request[key] = value.trim();
    } else {
      return `invalid_${key}`;
    }
  }

  if ("profilePictureMediaObjectId" in body) {
    const value = body.profilePictureMediaObjectId;
    if (value === null) {
      request.profilePictureMediaObjectId = null;
    } else if (
      typeof value === "string" &&
      /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(value)
    ) {
      request.profilePictureMediaObjectId = value;
    } else {
      return "invalid_profilePictureMediaObjectId";
    }
  }

  if ("platforms" in body) {
    if (!Array.isArray(body.platforms)) return "invalid_platforms";
    const platforms: MarketplaceAdminCreatorPlatformWrite[] = [];
    for (const platform of body.platforms) {
      const parsed = parseCreatorPlatform(platform);
      if (typeof parsed === "string") return parsed;
      platforms.push(parsed);
    }
    request.platforms = platforms;
  }

  return Object.keys(request).length > 0 ? request : "body_required";
}

function validateHotelProfileRequest(
  body: unknown,
): MarketplaceAdminHotelProfileUpdateRequest | string {
  if (!isRecord(body)) return "body_required";
  const request: MarketplaceAdminHotelProfileUpdateRequest = {};
  const allowedKeys = ["hostSummary", "collaborationGuidelines"] as const;
  for (const key of Object.keys(body)) {
    if (!(allowedKeys as readonly string[]).includes(key)) return `unsupported_${key}`;
  }
  for (const key of allowedKeys) {
    if (!(key in body)) continue;
    const value = body[key];
    if (value === null) {
      request[key] = null;
    } else if (typeof value === "string") {
      request[key] = value.trim();
    } else {
      return `invalid_${key}`;
    }
  }
  return Object.keys(request).length > 0 ? request : "body_required";
}

function parseCreatorPlatform(value: unknown): MarketplaceAdminCreatorPlatformWrite | string {
  if (!isRecord(value)) return "invalid_platform";
  const platform = toPlatformName(value.platform);
  const handle = readNonEmptyString(value.handle);
  const followerCount = toNonNegativeNumber(value.followerCount);
  const engagementRate = toNonNegativeNumber(value.engagementRate);
  if (!platform || !handle || followerCount === null || engagementRate === null) {
    return "invalid_platform";
  }
  return {
    platform,
    handle,
    profileUrl: optionalNullableString(value.profileUrl),
    followerCount,
    engagementRate,
    audienceCountries: parseAudienceCountries(value.audienceCountries),
    audienceAgeGroups: parseAudienceAgeGroups(value.audienceAgeGroups),
    audienceGenderSplit: parseGenderSplit(value.audienceGenderSplit),
  };
}

function sendAdminError(
  reply: FastifyReply,
  statusCode: 404 | 409 | 422,
  code: string,
  currentStatus?: MarketplaceCreatorProfileStatus,
) {
  return reply.status(statusCode).send({
    statusCode,
    code,
    category: statusCode === 404 ? "not_found" : statusCode === 409 ? "conflict" : "validation",
    message: code,
    ...(currentStatus ? { currentStatus } : {}),
  });
}

async function writeOffer<T>(
  pool: MarketplaceAdminPool,
  fn: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

type MarketplaceAdminLifecycleOperation =
  | "marketplace_admin_collaboration_respond"
  | "marketplace_admin_collaboration_approve_terms";

type MarketplaceAdminLifecycleReplayRow = {
  status: "in_progress" | "completed" | "failed" | "expired" | "conflict";
  requestFingerprintHash: string;
  metadata: unknown;
};

async function executeMarketplaceAdminLifecycleCommand(
  pool: MarketplaceAdminPool,
  input: {
    operation: MarketplaceAdminLifecycleOperation;
    collaborationId: string;
    idempotencyKey: string;
    fingerprintPayload: unknown;
    command: MarketplaceCollaborationLifecycleWriteResponse["command"];
    mutate(client: PoolClient): Promise<string | null>;
  },
): Promise<MarketplaceCollaborationLifecycleWriteResponse | null> {
  const keyHash = sha256(
    stableJson({ collaborationId: input.collaborationId, key: input.idempotencyKey }),
  );
  const fingerprint = sha256(stableJson(input.fingerprintPayload));
  const client = await pool.connect();
  let transactionOpen = false;
  try {
    await client.query("BEGIN");
    transactionOpen = true;

    const existing = await findMarketplaceAdminLifecycleReplay(client, {
      operation: input.operation,
      keyHash,
    });
    const replay = readMarketplaceAdminLifecycleReplay(existing, fingerprint);
    if (replay) {
      await client.query("COMMIT");
      transactionOpen = false;
      return replay;
    }

    const reserved = await reserveMarketplaceAdminLifecycleIdempotency(client, {
      operation: input.operation,
      collaborationId: input.collaborationId,
      idempotencyKey: input.idempotencyKey,
      keyHash,
      fingerprint,
    });
    if (!reserved) {
      const current = await findMarketplaceAdminLifecycleReplay(client, {
        operation: input.operation,
        keyHash,
      });
      const currentReplay = readMarketplaceAdminLifecycleReplay(current, fingerprint);
      if (currentReplay) {
        await client.query("COMMIT");
        transactionOpen = false;
        return currentReplay;
      }
      throw new Error("Marketplace admin lifecycle idempotency key is already in progress.");
    }

    const collaborationResourceId = await input.mutate(client);
    if (!collaborationResourceId) {
      await client.query("ROLLBACK");
      transactionOpen = false;
      return null;
    }

    const response = await readLifecycleWrite(client, collaborationResourceId, input.command);
    await completeMarketplaceAdminLifecycleIdempotency(client, {
      operation: input.operation,
      keyHash,
      fingerprint,
      response,
    });
    await client.query("COMMIT");
    transactionOpen = false;
    return response;
  } catch (error) {
    if (transactionOpen) await rollbackQuietly(client);
    throw error;
  } finally {
    client.release();
  }
}

async function findMarketplaceAdminLifecycleReplay(
  client: Pick<MarketplaceAdminPool, "query">,
  input: { operation: MarketplaceAdminLifecycleOperation; keyHash: string },
): Promise<MarketplaceAdminLifecycleReplayRow | null> {
  const result = await client.query<MarketplaceAdminLifecycleReplayRow>(
    `SELECT
       status,
       request_fingerprint_hash AS "requestFingerprintHash",
       idempotency_metadata AS metadata
     FROM platform.idempotency_keys
     WHERE operation_scope = 'marketplace'
       AND operation = $1
       AND key_hash = $2
       AND tenant_scope = 'platform'
     LIMIT 1
     FOR UPDATE`,
    [input.operation, input.keyHash],
  );
  return result.rows[0] ?? null;
}

function readMarketplaceAdminLifecycleReplay(
  row: MarketplaceAdminLifecycleReplayRow | null,
  fingerprint: string,
): MarketplaceCollaborationLifecycleWriteResponse | null {
  if (!row) return null;
  if (row.requestFingerprintHash !== fingerprint) {
    throw new Error("Idempotency key was already used with a different marketplace admin payload.");
  }
  if (row.status === "completed") {
    const response = readLifecycleReplayResponse(row.metadata);
    if (!response) throw new Error("Completed marketplace admin idempotency key has no response.");
    return response;
  }
  return null;
}

async function reserveMarketplaceAdminLifecycleIdempotency(
  client: Pick<MarketplaceAdminPool, "query">,
  input: {
    operation: MarketplaceAdminLifecycleOperation;
    collaborationId: string;
    idempotencyKey: string;
    keyHash: string;
    fingerprint: string;
  },
): Promise<boolean> {
  const result = await client.query<{ id: string }>(
    `INSERT INTO platform.idempotency_keys (
       operation_scope,
       operation,
       key_hash,
       request_fingerprint_hash,
       status,
       tenant_scope,
       correlation_id,
       expires_at,
       idempotency_metadata
     )
     VALUES (
       'marketplace',
       $1,
       $2,
       $3,
       'in_progress',
       'platform',
       $4,
       now() + interval '24 hours',
       $5::jsonb
     )
     ON CONFLICT (operation_scope, operation, key_hash, scope_key) DO NOTHING
     RETURNING id::text AS id`,
    [
      input.operation,
      input.keyHash,
      input.fingerprint,
      input.idempotencyKey,
      JSON.stringify({
        collaborationId: input.collaborationId,
        idempotencyKey: input.idempotencyKey,
      }),
    ],
  );
  return Boolean(result.rows[0]);
}

async function completeMarketplaceAdminLifecycleIdempotency(
  client: Pick<MarketplaceAdminPool, "query">,
  input: {
    operation: MarketplaceAdminLifecycleOperation;
    keyHash: string;
    fingerprint: string;
    response: MarketplaceCollaborationLifecycleWriteResponse;
  },
): Promise<void> {
  await client.query(
    `UPDATE platform.idempotency_keys
     SET status = 'completed',
         request_fingerprint_hash = $1,
         response_status_code = 200,
         response_body_hash = $2,
         response_resource_product = 'marketplace',
         response_resource_type = 'collaboration',
         response_resource_id = $3,
         completed_at = now(),
         last_seen_at = now(),
         idempotency_metadata = idempotency_metadata || $4::jsonb
     WHERE operation_scope = 'marketplace'
       AND operation = $5
       AND key_hash = $6
       AND tenant_scope = 'platform'`,
    [
      input.fingerprint,
      sha256(stableJson(input.response)),
      input.response.collaboration.collaborationId,
      JSON.stringify({ response: input.response }),
      input.operation,
      input.keyHash,
    ],
  );
}

function readLifecycleReplayResponse(
  metadata: unknown,
): MarketplaceCollaborationLifecycleWriteResponse | null {
  if (!isRecord(metadata) || !isRecord(metadata.response)) return null;
  const response = metadata.response;
  if (
    response.contractVersion !== "marketplace-collaboration-lifecycle-writes.v1" ||
    !isRecord(response.command) ||
    !isRecord(response.collaboration) ||
    !Array.isArray(response.sideEffects)
  ) {
    return null;
  }
  return response as MarketplaceCollaborationLifecycleWriteResponse;
}

async function rollbackQuietly(client: PoolClient): Promise<void> {
  try {
    await client.query("ROLLBACK");
  } catch {
    // Preserve the original write error.
  }
}

async function readLifecycleWrite(
  pool: Pick<MarketplaceAdminPool, "query">,
  collaborationResourceId: string,
  command: MarketplaceCollaborationLifecycleWriteResponse["command"],
): Promise<MarketplaceCollaborationLifecycleWriteResponse> {
  const row = await pool.query<CollaborationRow>(
    `${COLLABORATION_SELECT_SQL}
     WHERE collaboration.id::text = $1
     LIMIT 1`,
    [collaborationResourceId],
  );
  const collaboration = row.rows[0];
  if (!collaboration) throw new Error("Updated collaboration was not found.");
  const mapped = mapCollaborationRow(collaboration);
  const sideEffects: MarketplaceCollaborationLifecycleWriteResponse["sideEffects"] =
    mapped.status === "accepted"
      ? [
          { type: "marketplace.collaboration.accepted" },
          ...(mapped.terms.affiliateEnabled
            ? [
                {
                  type: "marketplace.affiliate.provision.command_requested",
                  idempotencyKey: `marketplace.affiliate.provision:collaboration:${collaboration.sourceCollaborationId}:v1`,
                },
              ]
            : []),
        ]
      : [
          {
            type: "marketplace.collaboration.system_message_requested",
            idempotencyKey: command.idempotencyKey,
          },
        ];
  return {
    contractVersion: "marketplace-collaboration-lifecycle-writes.v1",
    command,
    collaboration: mapped,
    sideEffects,
  };
}

type AdminHotelProfile = {
  propertyId: string;
  organizationId: string;
  profileStatus: "pending" | "verified" | "rejected" | "suspended" | "archived";
  profileComplete: boolean;
};

function assertMarketplaceProfileComplete(profile: AdminHotelProfile): void {
  if (profile.profileComplete) return;
  throw Object.assign(new Error("Marketplace profile must be complete before offer verification"), {
    statusCode: 422,
  });
}

type AdminHotelReviewRow = AdminHotelProfile & {
  displayName: string;
  location: string | null;
  hostSummary: string | null;
  createdAt: Date | string;
  updatedAt: Date | string;
};

type AdminCreatorProfile = {
  creatorProfileId: string;
  organizationId: string;
};

type AdminCreatorReviewRow = Omit<
  MarketplaceAdminCreatorReviewProfile,
  "createdAt" | "updatedAt" | "profileCompletedAt" | "platforms"
> & {
  createdAt: Date | string;
  updatedAt: Date | string;
  profileCompletedAt: Date | string | null;
  platforms: unknown;
};

const ADMIN_CREATOR_REVIEW_SELECT_SQL = `
  SELECT
    profile.id::text AS "creatorProfileId",
    profile.display_name AS "displayName",
    profile.location_text AS "locationText",
    profile.short_description AS "shortDescription",
    profile.portfolio_url AS "portfolioUrl",
    profile.phone,
    profile.profile_picture_url AS "profilePictureUrl",
    profile.profile_metadata ->> 'profilePictureMediaObjectId' AS "profilePictureMediaObjectId",
    marketplace.creator_profile_is_complete(
      profile.id,
      profile.organization_id
    ) AS "profileComplete",
    profile.profile_completed_at AS "profileCompletedAt",
    profile.profile_status AS "profileStatus",
    COALESCE(platforms.items, '[]'::jsonb) AS platforms,
    profile.created_at AS "createdAt",
    profile.updated_at AS "updatedAt"
  FROM marketplace.creator_profiles profile
  JOIN identity.organization_memberships membership
    ON membership.organization_id = profile.organization_id
   AND membership.user_id::text = $1
   AND membership.status = 'active'
  JOIN identity.organizations organization
    ON organization.id = membership.organization_id
   AND organization.kind = 'creator_workspace'
   AND organization.status = 'active'
  LEFT JOIN LATERAL (
    SELECT jsonb_agg(
      jsonb_build_object(
        'platformId', platform.id::text,
        'platform', platform.platform,
        'handle', platform.handle,
        'profileUrl', platform.profile_url,
        'followerCount', platform.follower_count,
        'engagementRate', platform.engagement_rate,
        'audienceCountries', platform.audience_countries,
        'audienceAgeGroups', platform.audience_age_groups,
        'audienceGenderSplit', NULLIF(platform.audience_gender_split, '{}'::jsonb),
        'createdAt', platform.created_at,
        'updatedAt', platform.updated_at
      ) ORDER BY platform.created_at, platform.id
    ) AS items
    FROM marketplace.creator_platforms platform
    WHERE platform.creator_profile_id = profile.id
      AND platform.organization_id = profile.organization_id
  ) platforms ON TRUE
  ORDER BY profile.id
`;

function mapCreatorReviewRow(row: AdminCreatorReviewRow): MarketplaceAdminCreatorReviewProfile {
  return {
    ...row,
    platforms: parseCreatorReviewPlatforms(row.platforms),
    profileCompletedAt: row.profileCompletedAt ? toIsoString(row.profileCompletedAt) : null,
    createdAt: toIsoString(row.createdAt),
    updatedAt: toIsoString(row.updatedAt),
  };
}

function parseCreatorReviewPlatforms(
  raw: unknown,
): MarketplaceAdminCreatorReviewProfile["platforms"] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((value) => {
    if (!isRecord(value)) return [];
    const platformId = readNonEmptyString(value.platformId);
    const platform = toPlatformName(value.platform);
    const handle = readNonEmptyString(value.handle);
    const followerCount = toNonNegativeNumber(value.followerCount);
    const engagementRate = toNonNegativeNumber(value.engagementRate);
    const createdAt = toIsoStringOrNull(value.createdAt);
    const updatedAt = toIsoStringOrNull(value.updatedAt);
    if (
      !platformId ||
      !platform ||
      !handle ||
      followerCount === null ||
      engagementRate === null ||
      !createdAt ||
      !updatedAt
    ) {
      return [];
    }
    return [
      {
        platformId,
        platform,
        handle,
        profileUrl: optionalNullableString(value.profileUrl) ?? null,
        followerCount,
        engagementRate,
        audienceCountries: parseAudienceCountries(value.audienceCountries),
        audienceAgeGroups: parseAudienceAgeGroups(value.audienceAgeGroups),
        audienceGenderSplit: parseGenderSplit(value.audienceGenderSplit),
        createdAt,
        updatedAt,
      },
    ];
  });
}

async function resolveAdminCreatorProfile(
  client: Pick<MarketplaceAdminPool, "query">,
  userId: string,
): Promise<AdminCreatorProfile | null> {
  const result = await client.query<AdminCreatorProfile>(
    `SELECT
       profile.id::text AS "creatorProfileId",
       profile.organization_id::text AS "organizationId"
     FROM marketplace.creator_profiles profile
     JOIN identity.organization_memberships membership
       ON membership.organization_id = profile.organization_id
      AND membership.user_id::text = $1
      AND membership.status = 'active'
     JOIN identity.organizations organization
       ON organization.id = membership.organization_id
      AND organization.kind = 'creator_workspace'
      AND organization.status = 'active'
     ORDER BY profile.id ASC
     FOR UPDATE OF profile
     FOR SHARE OF membership, organization`,
    [userId],
  );
  return result.rows.length === 1 ? result.rows[0]! : null;
}

async function resolveAdminCreatorProfileMedia(
  client: Pick<MarketplaceAdminPool, "query">,
  input: {
    mediaObjectId: string | null;
    actorUserId: string;
    profile: AdminCreatorProfile;
  },
): Promise<{ publicCdnUrl: string | null }> {
  if (input.mediaObjectId === null) return { publicCdnUrl: null };
  const result = await client.query<{ publicCdnUrl: string }>(
    `SELECT variant.public_cdn_url AS "publicCdnUrl"
       FROM platform.media_objects media
       JOIN platform.media_variants variant
         ON variant.media_object_id = media.id
        AND variant.variant_name = 'original_safe'
        AND variant.visibility = 'public'
        AND variant.public_cdn_url IS NOT NULL
      WHERE media.id = $1::uuid
        AND media.created_by_user_id = $2::uuid
        AND media.owner_organization_id::text = $3
        AND media.purpose = 'marketplace.creator.profile_image'
        AND media.resource_product = 'marketplace'
        AND media.resource_type = 'creator_profile'
        AND media.resource_id = $4
        AND media.storage_kind = 'vayada_managed'
        AND COALESCE(media.source_metadata ->> 'requestedVisibility', media.visibility) = 'public'
        AND media.visibility = 'public'
        AND media.public_approved = TRUE
        AND media.lifecycle_status = 'active'`,
    [
      input.mediaObjectId,
      input.actorUserId,
      input.profile.organizationId,
      input.profile.creatorProfileId,
    ],
  );
  const media = result.rows.length === 1 ? result.rows[0] : undefined;
  if (!media) throw new MarketplaceAdminInvalidProfileMediaError();
  return media;
}

async function resolveAdminHotelProfile(
  client: Pick<MarketplaceAdminPool, "query">,
  hotelUserId: string,
): Promise<AdminHotelProfile | null> {
  const result = await client.query<AdminHotelProfile>(
    `SELECT
       profile.property_id::text AS "propertyId",
       profile.organization_id::text AS "organizationId",
       profile.marketplace_profile_status AS "profileStatus",
       profile.profile_complete AS "profileComplete"
     FROM marketplace.marketplace_hotel_profiles profile
     JOIN identity.organization_memberships membership
       ON membership.organization_id = profile.organization_id
      AND membership.user_id::text = $1
      AND membership.status = 'active'
     JOIN identity.organizations organization
       ON organization.id = membership.organization_id
      AND organization.kind = 'hotel_group'
      AND organization.status = 'active'
     ORDER BY profile.updated_at DESC, profile.property_id ASC
     LIMIT 1`,
    [hotelUserId],
  );
  return result.rows[0] ?? null;
}

const ADMIN_HOTEL_REVIEW_SELECT_SQL = `
  SELECT
    profile.property_id::text AS "propertyId",
    profile.organization_id::text AS "organizationId",
    profile.marketplace_profile_status AS "profileStatus",
    profile.profile_complete AS "profileComplete",
    COALESCE(NULLIF(public_profile.display_name, ''), property.display_name) AS "displayName",
    NULLIF(concat_ws(
      ', ',
      NULLIF(public_profile.location->>'city', ''),
      NULLIF(public_profile.location->>'region', ''),
      NULLIF(public_profile.location->>'countryCode', '')
    ), '') AS location,
    profile.host_summary AS "hostSummary",
    profile.created_at AS "createdAt",
    profile.updated_at AS "updatedAt"
  FROM marketplace.marketplace_hotel_profiles profile
  JOIN identity.organization_memberships membership
    ON membership.organization_id = profile.organization_id
   AND membership.user_id::text = $1
   AND membership.status = 'active'
  JOIN identity.organizations organization
    ON organization.id = membership.organization_id
   AND organization.kind = 'hotel_group'
   AND organization.status = 'active'
  JOIN hotel_catalog.properties property ON property.id = profile.property_id
  LEFT JOIN hotel_catalog.property_public_profile_read_model public_profile
    ON public_profile.property_id = profile.property_id
  ORDER BY profile.updated_at DESC, profile.property_id ASC
  LIMIT 1
`;

async function hasEligibleOfferMedia(
  client: Pick<MarketplaceAdminPool, "query">,
  organizationId: string,
  offerId: string,
  mediaObjectIds?: string[],
): Promise<boolean> {
  if (mediaObjectIds) {
    const result = await client.query<{ eligibleCount: string | number }>(
      `SELECT count(DISTINCT media.id) AS "eligibleCount"
       FROM platform.media_objects media
       WHERE media.owner_organization_id = $1::uuid
         AND media.resource_product = 'marketplace'
         AND media.resource_type = 'marketplace_offer'
         AND media.resource_id = $2
         AND media.id = ANY($3::uuid[])
         AND media.purpose = 'marketplace.offer.media'
         AND (
           (media.visibility = 'private'
             AND media.public_approved = FALSE
             AND media.lifecycle_status = 'staged')
           OR
           (media.visibility = 'public'
             AND media.public_approved = TRUE
             AND media.lifecycle_status = 'active')
         )`,
      [organizationId, offerId, mediaObjectIds],
    );
    return Number(result.rows[0]?.eligibleCount ?? 0) === mediaObjectIds.length;
  }
  const result = await client.query<{ exists: boolean }>(
    `SELECT EXISTS (
       SELECT 1
       FROM platform.media_objects media
       WHERE media.owner_organization_id = $1::uuid
         AND media.resource_product = 'marketplace'
         AND media.resource_type = 'marketplace_offer'
         AND media.resource_id = $2
         AND media.purpose = 'marketplace.offer.media'
         AND (
           (media.visibility = 'private'
             AND media.public_approved = FALSE
             AND media.lifecycle_status = 'staged')
           OR
           (media.visibility = 'public'
             AND media.public_approved = TRUE
             AND media.lifecycle_status = 'active')
         )
     ) AS exists`,
    [organizationId, offerId],
  );
  return result.rows[0]?.exists === true;
}

function validateOfferMediaObjectIds(body: unknown): string[] | undefined | string {
  if (body === undefined || body === null) return undefined;
  if (typeof body !== "object" || Array.isArray(body)) return "invalid_verify_request";
  const record = body as Record<string, unknown>;
  if (Object.keys(record).some((key) => key !== "mediaObjectIds")) {
    return "invalid_verify_request";
  }
  const value = record.mediaObjectIds;
  if (value === undefined) return undefined;
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    value.length > 12 ||
    !value.every(
      (id): id is string =>
        typeof id === "string" && /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(id),
    ) ||
    new Set(value.map((id) => id.toLowerCase())).size !== value.length
  ) {
    return "invalid_mediaObjectIds";
  }
  return value.map((id) => id.toLowerCase());
}

async function replaceCreatorPlatforms(
  client: Pick<MarketplaceAdminPool, "query">,
  input: {
    creatorProfileId: string;
    organizationId: string;
    platforms: MarketplaceAdminCreatorPlatformWrite[];
  },
): Promise<void> {
  await client.query(`DELETE FROM marketplace.creator_platforms WHERE creator_profile_id = $1`, [
    input.creatorProfileId,
  ]);

  for (const platform of input.platforms) {
    await client.query(
      `INSERT INTO marketplace.creator_platforms (
         creator_profile_id,
         organization_id,
         source_system,
         source_platform_id,
         platform,
         handle,
         profile_url,
         follower_count,
         engagement_rate,
         audience_countries,
         audience_age_groups,
         audience_gender_split
       )
       VALUES ($1, $2, 'marketplace', gen_random_uuid()::text, $3, $4, $5, $6, $7, $8::jsonb, $9::jsonb, $10::jsonb)`,
      [
        input.creatorProfileId,
        input.organizationId,
        platform.platform,
        platform.handle,
        platform.profileUrl ?? null,
        platform.followerCount,
        platform.engagementRate,
        JSON.stringify(platform.audienceCountries ?? []),
        JSON.stringify(platform.audienceAgeGroups ?? []),
        JSON.stringify(platform.audienceGenderSplit ?? {}),
      ],
    );
  }
}

async function resolveOfferForProfile(
  client: Pick<MarketplaceAdminPool, "query">,
  profile: AdminHotelProfile,
  offerId: string,
): Promise<{
  offerResourceId: string;
  title: string;
  offerStatus: MarketplaceAdminOffer["offerStatus"];
} | null> {
  const result = await client.query<{
    offerResourceId: string;
    title: string;
    offerStatus: MarketplaceAdminOffer["offerStatus"];
  }>(
    `SELECT
       id::text AS "offerResourceId",
       title,
       offer_status AS "offerStatus"
     FROM marketplace.marketplace_offers
     WHERE property_id::text = $1
       AND organization_id::text = $2
       AND id::text = $3
       AND offer_status <> 'archived'
     LIMIT 1`,
    [profile.propertyId, profile.organizationId, offerId],
  );
  return result.rows[0] ?? null;
}

export async function replaceOfferChildren(
  client: Pick<MarketplaceAdminPool, "query">,
  input: {
    offerId: string;
    propertyId: string;
    organizationId: string;
    deliverables?: MarketplaceOfferDeliverableWrite[];
    compensationOptions?: MarketplaceOfferCompensationOptionWrite[];
    creatorRequirements?: MarketplaceOfferCreatorRequirementsWrite | null;
    matchingCriteria?: MarketplaceOfferMatchingCriteriaWrite | null;
    actorUserId?: string;
  },
): Promise<void> {
  if (input.deliverables !== undefined) {
    await client.query(`DELETE FROM marketplace.offer_deliverables WHERE offer_id = $1`, [
      input.offerId,
    ]);
    for (const deliverable of input.deliverables) {
      await client.query(
        `INSERT INTO marketplace.offer_deliverables (
           offer_id,
           property_id,
           organization_id,
           platform,
           deliverable_type,
           quantity,
           timing_guidance,
           requirement_level
         )
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [
          input.offerId,
          input.propertyId,
          input.organizationId,
          deliverable.platform,
          deliverable.deliverableType,
          deliverable.quantity,
          deliverable.timingGuidance ?? null,
          deliverable.requirementLevel ?? null,
        ],
      );
    }
  }

  if (input.compensationOptions !== undefined) {
    await client.query(`DELETE FROM marketplace.offer_compensation_options WHERE offer_id = $1`, [
      input.offerId,
    ]);
    for (const option of input.compensationOptions) {
      await client.query(
        `INSERT INTO marketplace.offer_compensation_options (
           offer_id,
           property_id,
           organization_id,
           compensation_type,
           availability_months,
           platforms,
           free_stay_min_nights,
           free_stay_max_nights,
           paid_max_amount,
           discount_percentage,
           commission_percentage,
           min_followers,
           currency,
           terms_summary,
           follower_requirement_level
         )
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::numeric, $10, $11::numeric, $12, $13, $14, $15)`,
        [
          input.offerId,
          input.propertyId,
          input.organizationId,
          option.compensationType,
          option.availabilityMonths,
          option.platforms,
          option.freeStayMinNights,
          option.freeStayMaxNights,
          option.paidMaxAmount,
          option.discountPercentage,
          option.commissionPercentage,
          option.minFollowers,
          option.currency ?? "USD",
          option.termsSummary,
          option.followerRequirementLevel ?? null,
        ],
      );
    }
  }

  if (input.creatorRequirements !== undefined) {
    await client.query(`DELETE FROM marketplace.offer_creator_requirements WHERE offer_id = $1`, [
      input.offerId,
    ]);
    if (input.creatorRequirements) {
      await client.query(
        `INSERT INTO marketplace.offer_creator_requirements (
           offer_id,
           property_id,
           organization_id,
           platforms,
           target_countries,
           target_age_min,
           target_age_max,
           target_age_groups,
           creator_types,
           platform_requirement_level,
           target_countries_requirement_level,
           creator_types_requirement_level
         )
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
        [
          input.offerId,
          input.propertyId,
          input.organizationId,
          input.creatorRequirements.platforms,
          input.creatorRequirements.targetCountries,
          input.creatorRequirements.targetAgeMin,
          input.creatorRequirements.targetAgeMax,
          input.creatorRequirements.targetAgeGroups,
          input.creatorRequirements.creatorTypes,
          input.creatorRequirements.platformRequirementLevel ?? null,
          input.creatorRequirements.targetCountriesRequirementLevel ?? null,
          input.creatorRequirements.creatorTypesRequirementLevel ?? null,
        ],
      );
    }
  }

  if (input.matchingCriteria !== undefined) {
    if (input.matchingCriteria === null) {
      await client.query(`DELETE FROM marketplace.offer_matching_criteria WHERE offer_id = $1`, [
        input.offerId,
      ]);
    } else {
      if (!input.actorUserId) {
        throw new Error("Marketplace offer matching criteria require an audit actor");
      }
      await client.query(
        `INSERT INTO marketplace.offer_matching_criteria (
           offer_id, property_id, organization_id, contract_version, criteria,
           updated_by_user_id
         ) VALUES (
           $1, $2, $3, 'marketplace-offer-matching-criteria.v1', $4::jsonb, $5::uuid
         )
         ON CONFLICT (offer_id) DO UPDATE
         SET criteria = EXCLUDED.criteria,
             revision = marketplace.offer_matching_criteria.revision + 1,
             updated_by_user_id = EXCLUDED.updated_by_user_id,
             updated_at = now()`,
        [
          input.offerId,
          input.propertyId,
          input.organizationId,
          JSON.stringify(input.matchingCriteria),
          input.actorUserId,
        ],
      );
    }
  }
}

export async function recordOfferMatchingAudit(
  client: Pick<MarketplaceAdminPool, "query">,
  input: {
    action: "created" | "updated";
    offerId: string;
    propertyId: string;
    request: MarketplaceAdminCreateOfferRequest | MarketplaceAdminUpdateOfferRequest;
    audit: MarketplaceOfferWriteAudit;
  },
): Promise<void> {
  const changedFields = [
    "deliverables",
    "compensationOptions",
    "creatorRequirements",
    "matchingCriteria",
  ].filter((field) => input.request[field as keyof typeof input.request] !== undefined);
  await client.query(
    `INSERT INTO platform.product_audit_events (
       audit_key, product, action, occurred_at, tenant_scope, property_id,
       actor_type, actor_user_id, target_resource_product, target_resource_type,
       target_resource_id, correlation_id, causation_id, redacted_payload,
       audit_metadata, privacy_scope
     ) VALUES (
       $1, 'marketplace', $2, $3::timestamptz, 'property', $4::uuid,
       'user', $5::uuid, 'marketplace', 'marketplace_offer', $6, $7, $8,
       $9::jsonb, $10::jsonb, 'internal'
     )`,
    [
      `marketplace.offer-matching-input.${input.action}.${input.offerId}.${sha256(input.audit.requestId)}.v1`,
      `marketplace.offer_matching_input.${input.action}`,
      input.audit.occurredAt,
      input.propertyId,
      input.audit.actorUserId,
      input.offerId,
      input.audit.correlationId ?? input.audit.requestId,
      input.audit.requestId,
      JSON.stringify({
        changedFields,
        matchingCriteriaOperation:
          input.request.matchingCriteria === undefined
            ? "unchanged"
            : input.request.matchingCriteria === null
              ? "deleted"
              : "upserted",
      }),
      JSON.stringify({
        actorOrganizationId: input.audit.actorOrganizationId,
        requestId: input.audit.requestId,
        source: input.audit.source,
      }),
    ],
  );
}

function offerMediaLateralSql(publicOnly: boolean): string {
  const visibilityFilter = publicOnly
    ? `AND media_object.visibility = 'public'
        AND media_object.public_approved = TRUE
        AND media_object.lifecycle_status = 'active'`
    : `AND media_object.lifecycle_status NOT IN (
          'quarantined', 'rejected', 'delete_requested', 'deleted'
        )`;
  return `
  LEFT JOIN LATERAL (
    SELECT
      jsonb_agg(
        jsonb_build_object(
          'mediaObjectId', item.id::text,
          'url', item.url,
          'approvalStatus', CASE
            WHEN item.public_approved THEN 'approved'
            ELSE 'pending_domain_approval'
          END,
          'lifecycleStatus', item.lifecycle_status
        ) ORDER BY item.created_at, item.id
      ) AS items,
      array_agg(item.url ORDER BY item.created_at, item.id)
        FILTER (WHERE item.url IS NOT NULL) AS urls
    FROM (
      SELECT
        media_object.id,
        media_object.created_at,
        media_object.public_approved,
        media_object.lifecycle_status,
        COALESCE(
          (
            SELECT variant.public_cdn_url
            FROM platform.media_variants variant
            WHERE variant.media_object_id = media_object.id
              AND variant.public_cdn_url IS NOT NULL
            ORDER BY CASE variant.variant_name
              WHEN 'original_safe' THEN 0
              WHEN 'large' THEN 1
              WHEN 'thumbnail' THEN 2
              ELSE 3
            END,
            variant.created_at,
            variant.id
            LIMIT 1
          ),
          media_object.source_url,
          CASE
            WHEN media_object.storage_key LIKE 'https://%' THEN media_object.storage_key
            ELSE NULL
          END
        ) AS url
      FROM platform.media_objects media_object
      WHERE media_object.owner_organization_id = offer.organization_id
        AND media_object.resource_product = 'marketplace'
        AND media_object.resource_type = 'marketplace_offer'
        AND media_object.resource_id = offer.id::text
        AND media_object.purpose = 'marketplace.offer.media'
        ${visibilityFilter}
    ) item
  ) offer_media ON TRUE
`;
}

const OFFER_MEDIA_LATERAL_SQL = offerMediaLateralSql(false);
const PUBLIC_OFFER_MEDIA_LATERAL_SQL = offerMediaLateralSql(true);

export async function syncOfferReadModel(
  client: Pick<MarketplaceAdminPool, "query">,
  offerId: string,
  visibilityMode: "initialize" | "disable",
  options: { catalogAlreadyProjected?: boolean } = {},
): Promise<void> {
  const source = await client.query<{ propertyId: string }>(
    `SELECT offer.property_id::text AS "propertyId"
     FROM marketplace.marketplace_offers offer
     WHERE offer.id = $1::uuid
     LIMIT 1`,
    [offerId],
  );
  const propertyId = source.rows[0]?.propertyId;
  if (!propertyId) return;

  if (!options.catalogAlreadyProjected) {
    if (!(await ensureCanonicalPropertySlug(client, propertyId))) return;
    await client.query(PROJECT_CANONICAL_PUBLIC_PROPERTY_PROFILE, [propertyId]);
  }
  await client.query(
    `INSERT INTO marketplace.marketplace_offer_read_model (
       offer_id,
       property_id,
       public_id,
       canonical_slug,
       display_name,
       offer_title,
       offer_summary,
       accommodation_type,
       visibility_status,
       location,
       image_urls,
       public_compensation_summary,
       public_creator_requirements,
       source_freshness,
       projected_at
     )
     SELECT
       offer.id,
       offer.property_id,
       COALESCE(offer.source_offer_id, offer.id::text),
       COALESCE(public_profile.canonical_slug, active_slug.slug, property.public_id),
       COALESCE(public_profile.display_name, property.display_name),
       offer.title,
       offer.offer_summary,
       offer.accommodation_type,
       CASE
         WHEN $2 = 'disable' THEN 'disabled'
         WHEN offer.offer_status = 'verified'
          AND marketplace_profile.marketplace_profile_status = 'verified'
          AND marketplace_profile.profile_complete = TRUE
          AND COALESCE(public_profile.profile_status, property.profile_status) = 'complete'
          AND COALESCE(cardinality(offer_media.urls), 0) > 0
          AND NULLIF(btrim(COALESCE(public_profile.display_name, property.display_name)), '')
            IS NOT NULL
          AND (
            NULLIF(public_profile.location->>'city', '') IS NOT NULL
            OR NULLIF(public_profile.location->>'countryCode', '') IS NOT NULL
            OR NULLIF(public_profile.location->>'region', '') IS NOT NULL
          )
           THEN 'public'
         ELSE 'private'
       END,
       jsonb_strip_nulls(jsonb_build_object(
         'countryCode', public_profile.location ->> 'countryCode',
         'region', public_profile.location ->> 'region',
         'city', public_profile.location ->> 'city',
         'geo', public_profile.location -> 'geo',
         'mapDisplayMode', public_profile.location ->> 'mapDisplayMode'
       )),
       COALESCE(offer_media.urls, offer.image_urls, '{}'::text[]),
       COALESCE(compensation.items, '[]'::jsonb),
       COALESCE(requirements.item, '{}'::jsonb),
       jsonb_strip_nulls(jsonb_build_object(
         'source', 'marketplace_admin',
         'catalogProjectedAt', public_profile.projected_at
       )),
       now()
     FROM marketplace.marketplace_offers offer
     JOIN hotel_catalog.properties property ON property.id = offer.property_id
     JOIN marketplace.marketplace_hotel_profiles marketplace_profile
       ON marketplace_profile.property_id = offer.property_id
      AND marketplace_profile.organization_id = offer.organization_id
     LEFT JOIN hotel_catalog.property_public_profile_read_model public_profile
       ON public_profile.property_id = offer.property_id
     ${PUBLIC_OFFER_MEDIA_LATERAL_SQL}
     LEFT JOIN LATERAL (
       SELECT slug.slug
       FROM hotel_catalog.property_slugs slug
       WHERE slug.property_id = offer.property_id
         AND slug.status = 'active'
       ORDER BY CASE slug.purpose WHEN 'canonical' THEN 0 WHEN 'marketplace_overlay' THEN 1 ELSE 2 END,
                slug.created_at,
                slug.id
       LIMIT 1
     ) active_slug ON TRUE
     LEFT JOIN LATERAL (
       SELECT jsonb_agg(
         jsonb_strip_nulls(jsonb_build_object(
           'type', option.compensation_type,
           'months', option.availability_months,
           'platforms', option.platforms,
           'freeStayMinNights', option.free_stay_min_nights,
           'freeStayMaxNights', option.free_stay_max_nights,
           'paidMaxAmount', option.paid_max_amount,
           'discountPercentage', option.discount_percentage,
           'commissionPercentage', option.commission_percentage,
           'minFollowers', option.min_followers,
           'currency', option.currency,
           'termsSummary', option.terms_summary
         )) ORDER BY option.created_at, option.id
       ) AS items
       FROM marketplace.offer_compensation_options option
       WHERE option.offer_id = offer.id
         AND option.property_id = offer.property_id
         AND option.organization_id = offer.organization_id
     ) compensation ON TRUE
     LEFT JOIN LATERAL (
       SELECT jsonb_build_object(
         'platforms', requirement.platforms,
         'countries', requirement.target_countries,
         'ageGroups', requirement.target_age_groups,
         'creatorTypes', requirement.creator_types
       ) AS item
       FROM marketplace.offer_creator_requirements requirement
       WHERE requirement.offer_id = offer.id
         AND requirement.property_id = offer.property_id
         AND requirement.organization_id = offer.organization_id
     ) requirements ON TRUE
     WHERE offer.id = $1::uuid
     ON CONFLICT (offer_id) DO UPDATE
     SET property_id = EXCLUDED.property_id,
         public_id = EXCLUDED.public_id,
         canonical_slug = EXCLUDED.canonical_slug,
         display_name = EXCLUDED.display_name,
         offer_title = EXCLUDED.offer_title,
         offer_summary = EXCLUDED.offer_summary,
         accommodation_type = EXCLUDED.accommodation_type,
         visibility_status = EXCLUDED.visibility_status,
         location = EXCLUDED.location,
         image_urls = EXCLUDED.image_urls,
         public_compensation_summary = EXCLUDED.public_compensation_summary,
         public_creator_requirements = EXCLUDED.public_creator_requirements,
         source_freshness = EXCLUDED.source_freshness,
         projected_at = EXCLUDED.projected_at`,
    [offerId, visibilityMode],
  );
}

export async function syncPropertyOfferReadModels(
  client: Pick<MarketplaceAdminPool, "query">,
  input: { propertyId: string },
): Promise<void> {
  if (!(await ensureCanonicalPropertySlug(client, input.propertyId))) return;
  await client.query(PROJECT_CANONICAL_PUBLIC_PROPERTY_PROFILE, [input.propertyId]);

  const offers = await client.query<{ offerId: string }>(
    `SELECT offer.id::text AS "offerId"
     FROM marketplace.marketplace_offers offer
     WHERE offer.property_id = $1::uuid
       AND offer.offer_status <> 'archived'
     ORDER BY offer.id`,
    [input.propertyId],
  );
  for (const { offerId } of offers.rows) {
    await syncOfferReadModel(client, offerId, "initialize", {
      catalogAlreadyProjected: true,
    });
  }
}

export async function readOffer(
  client: Pick<MarketplaceAdminPool, "query">,
  offerResourceId: string,
  authorizationMode: MarketplaceAdminAuthorizationMode,
): Promise<MarketplaceAdminOffer | null> {
  const result = await client.query<OfferRow>(
    `${OFFER_SELECT_SQL}
     WHERE offer.id::text = $1
     LIMIT 1`,
    [offerResourceId],
  );
  const row = result.rows[0];
  return row ? mapOfferRow(row, authorizationMode) : null;
}

function buildCollaborationFilters(
  input: {
    status?: MarketplaceCollaborationStatus;
    search?: string;
  },
  params: unknown[],
): string {
  const filters = [];
  if (input.status) {
    params.push(input.status);
    filters.push(`collaboration.lifecycle_status = $${params.length}`);
  }
  if (input.search?.trim()) {
    params.push(`%${input.search.trim()}%`);
    filters.push(`(
      creator.display_name ILIKE $${params.length}
      OR offer.title ILIKE $${params.length}
      OR public_profile.display_name ILIKE $${params.length}
    )`);
  }
  return filters.length ? `WHERE ${filters.join(" AND ")}` : "";
}

function mapCollaborationRow(row: CollaborationRow): MarketplaceCollaborationRead {
  const status = toCollaborationStatus(row.status) ?? "pending";
  return {
    contractVersion: "marketplace-collaboration-reads.v1",
    authorizationMode: "hotel_group_resource_link",
    collaborationId: row.collaborationId,
    offerId: row.offerId,
    creatorId: row.creatorId,
    hotelProfileId: row.hotelProfileId,
    side: "hotel",
    initiatorSide: row.initiatorSide === "hotel" ? "hotel" : "creator",
    isInitiator: row.initiatorSide === "hotel",
    status,
    compensationType: toCollaborationCompensationType(row.compensationType),
    offerTitle: row.offerTitle,
    hotelLocation: row.hotelLocation,
    creator: {
      side: "creator",
      organizationId: row.creatorOrganizationId,
      profileId: row.creatorProfileId,
      displayName: row.creatorName ?? "Creator",
      avatarUrl: row.creatorAvatarUrl,
    },
    hotel: {
      side: "hotel",
      organizationId: row.hotelOrganizationId,
      profileId: row.hotelProfileId,
      displayName: row.hotelName ?? "Hotel",
      avatarUrl: null,
    },
    terms: {
      freeStayMinNights: toNullableNumber(row.freeStayMinNights),
      freeStayMaxNights: toNullableNumber(row.freeStayMaxNights),
      paidAmount: toNullableDecimal(row.paidAmount),
      currency: row.currency ?? null,
      discountPercentage: toNullableNumber(row.discountPercentage),
      affiliateEnabled: row.affiliateEnabled,
      affiliateCommissionPercentage: toNullableDecimal(row.affiliateCommissionPercentage),
      travelDateFrom: toDateString(row.travelDateFrom),
      travelDateTo: toDateString(row.travelDateTo),
      preferredDateFrom: toDateString(row.preferredDateFrom),
      preferredDateTo: toDateString(row.preferredDateTo),
      preferredMonths: row.preferredMonths ?? [],
    },
    deliverables: toDeliverables(row.deliverables),
    lastMessageAt: toIsoStringOrNull(row.lastMessageAt),
    applicationMessage: row.applicationMessage,
    hotelAgreedAt: toIsoStringOrNull(row.hotelAgreedAt),
    creatorAgreedAt: toIsoStringOrNull(row.creatorAgreedAt),
    completedAt: toIsoStringOrNull(row.completedAt),
    cancelledAt: toIsoStringOrNull(row.cancelledAt),
    createdAt: toIsoString(row.createdAt),
    updatedAt: toIsoString(row.updatedAt),
  };
}

export function mapOfferRow(
  row: OfferRow,
  authorizationMode: MarketplaceAdminAuthorizationMode,
): MarketplaceAdminOffer {
  return {
    contractVersion: MARKETPLACE_ADMIN_CONTRACT_VERSION,
    authorizationMode,
    offerId: row.offerId,
    propertyId: row.propertyId,
    offerStatus: row.offerStatus,
    title: row.title,
    offerSummary: row.offerSummary,
    media: toOfferMedia(row.media),
    deliverables: toOfferDeliverables(row.deliverables),
    compensationOptions: toCompensationOptions(row.compensationOptions),
    creatorRequirements: toCreatorRequirements(row.creatorRequirements),
    matchingCriteria: toMatchingCriteria(row.matchingCriteria),
    createdAt: toIsoString(row.createdAt),
    updatedAt: toIsoString(row.updatedAt),
  };
}

function toOfferMedia(value: unknown): MarketplaceAdminOfferMedia[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (!isRecord(item)) return [];
    const url = readString(item.url);
    const mediaObjectId = readString(item.mediaObjectId);
    if (!mediaObjectId && !url) return [];
    return [
      {
        mediaObjectId,
        url,
        approvalStatus:
          item.approvalStatus === "pending_domain_approval"
            ? "pending_domain_approval"
            : "approved",
        lifecycleStatus: item.lifecycleStatus === "staged" ? "staged" : "active",
      },
    ];
  });
}

function toInviteCode(row: InviteCodeRow): MarketplaceAdminInviteCode {
  const status =
    row.status === "redeemed" ? "redeemed" : row.status === "expired" ? "expired" : "pending";
  const invite = parseStoredHotelAccountInvite(row.payload);
  return {
    contractVersion: HOTEL_ACCOUNT_INVITE_CONTRACT_VERSION,
    id: row.id,
    code: row.code,
    status,
    createdAt: toIsoString(row.createdAt),
    expiresAt: toIsoString(row.expiresAt),
    identity: invite?.identity ?? null,
    organization: invite?.organization ?? null,
    property: invite?.property ?? null,
    selectedTracks: invite?.selectedTracks ?? [],
    handoffPath: HOTEL_ACCOUNT_INVITE_HANDOFF_PATH,
    redeemedAt: toIsoStringOrNull(row.redeemedAt),
  };
}

function toCompensationOptions(value: unknown): MarketplaceAdminOffer["compensationOptions"] {
  if (!Array.isArray(value)) return [];
  return value.filter(isRecord).map((row) => ({
    compensationOptionId: readString(row.compensationOptionId) ?? "",
    compensationType: toOfferCompensationType(row.compensationType) ?? "free_stay",
    availabilityMonths: toStringArray(row.availabilityMonths),
    platforms: toPlatformArray(row.platforms),
    freeStayMinNights: toNullableNumber(row.freeStayMinNights),
    freeStayMaxNights: toNullableNumber(row.freeStayMaxNights),
    paidMaxAmount: toNullableDecimal(row.paidMaxAmount),
    discountPercentage: toNullableNumber(row.discountPercentage),
    commissionPercentage: toNullableNumber(row.commissionPercentage),
    minFollowers: toNullableNumber(row.minFollowers),
    followerRequirementLevel: toRequirementLevel(row.followerRequirementLevel),
    currency: readString(row.currency),
    termsSummary: readString(row.termsSummary),
  }));
}

function toOfferDeliverables(value: unknown): MarketplaceAdminOffer["deliverables"] {
  if (!Array.isArray(value)) return [];
  return value.filter(isRecord).map((row) => ({
    deliverableId: readString(row.deliverableId) ?? "",
    platform: toPlatformName(row.platform) ?? "other",
    deliverableType: readString(row.deliverableType) ?? "post",
    quantity: toNullableNumber(row.quantity) ?? 1,
    timingGuidance: readString(row.timingGuidance),
    requirementLevel: toRequirementLevel(row.requirementLevel),
  }));
}

function toCreatorRequirements(value: unknown): MarketplaceOfferCreatorRequirementsWrite | null {
  if (!isRecord(value) || Object.keys(value).length === 0) return null;
  return {
    platforms: toPlatformArray(value.platforms),
    platformRequirementLevel: toRequirementLevel(value.platformRequirementLevel),
    targetCountries: toStringArray(value.targetCountries),
    targetCountriesRequirementLevel: toRequirementLevel(value.targetCountriesRequirementLevel),
    targetAgeMin: toNullableNumber(value.targetAgeMin),
    targetAgeMax: toNullableNumber(value.targetAgeMax),
    targetAgeGroups: toStringArray(value.targetAgeGroups),
    creatorTypes: toStringArray(value.creatorTypes)
      .map((type) => (type === "lifestyle" || type === "travel" ? type : "other"))
      .filter((type, index, items) => items.indexOf(type) === index),
    creatorTypesRequirementLevel: toRequirementLevel(value.creatorTypesRequirementLevel),
  };
}

function toMatchingCriteria(value: unknown): MarketplaceOfferMatchingCriteria | null {
  if (value === null || value === undefined) return null;
  const criteria = parseMarketplaceOfferMatchingCriteria(value);
  if (!criteria) throw new Error("Stored Marketplace offer matching criteria is invalid");
  return criteria;
}

function toRequirementLevel(value: unknown): MarketplaceOfferRequirementLevel | null {
  return value === "required" || value === "preferred" ? value : null;
}

function toDeliverables(value: unknown): MarketplaceCollaborationDeliverable[] {
  if (!Array.isArray(value)) return [];
  return value.filter(isRecord).map((row, index) => ({
    deliverableId: readString(row.deliverableId) ?? readString(row.id) ?? `deliverable_${index}`,
    platform: readString(row.platform) ?? "custom",
    type: readString(row.type) ?? "Custom",
    quantity: toNullableNumber(row.quantity) ?? 1,
    status: row.status === "completed" ? "completed" : "pending",
    completedAt: toIsoStringOrNull(row.completedAt ?? row.completed_at),
  }));
}

function toCollaborationStatus(value: unknown): MarketplaceCollaborationStatus | undefined {
  switch (value) {
    case "pending":
    case "negotiating":
    case "accepted":
    case "active":
    case "completed":
    case "cancelled":
    case "rejected":
    case "declined":
      return value;
    default:
      return undefined;
  }
}

function toOfferCompensationType(
  value: unknown,
): MarketplaceOfferCompensationOptionWrite["compensationType"] | null {
  switch (value) {
    case "free_stay":
    case "paid":
    case "discount":
    case "affiliate":
      return value;
    default:
      return null;
  }
}

function toCollaborationCompensationType(
  value: unknown,
): MarketplaceCollaborationRead["compensationType"] {
  switch (value) {
    case "free_stay":
    case "paid":
    case "discount":
    case "custom":
      return value;
    default:
      return null;
  }
}

function toPlatformArray(value: unknown): MarketplacePlatformName[] {
  return toStringArray(value).map((platform) => {
    switch (platform) {
      case "instagram":
      case "tiktok":
      case "youtube":
      case "facebook":
      case "blog":
      case "x":
        return platform;
      default:
        return "other";
    }
  });
}

function toPlatformName(value: unknown): MarketplacePlatformName | null {
  return typeof value === "string" && toPlatformArray([value])[0] === value ? value : null;
}

function firstQueryValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function parsePositiveInteger(raw: string | undefined, fallback: number): number {
  if (!raw || !/^\d+$/.test(raw)) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return parsed > 0 ? parsed : fallback;
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}

function isPositiveDecimalString(value: unknown): value is string {
  if (typeof value !== "string" || !value.trim()) return false;
  const number = Number(value);
  return Number.isFinite(number) && number > 0;
}

function isPercentage(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 && value <= 100;
}

function toNullableNumber(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const number = typeof value === "number" ? value : Number(value);
  return Number.isFinite(number) ? number : null;
}

function toNonNegativeNumber(value: unknown): number | null {
  const number = toNullableNumber(value);
  return number !== null && number >= 0 ? number : null;
}

function toNullableDecimal(value: unknown): string | null {
  if (value === null || value === undefined || value === "") return null;
  return String(value);
}

function toStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.map((entry) => String(entry)).filter((entry) => entry.length > 0)
    : [];
}

function readString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function readNonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function optionalNullableString(value: unknown): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  return typeof value === "string" ? value.trim() : undefined;
}

function parseAudienceCountries(value: unknown): { country: string; percentage: number }[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    if (!isRecord(entry)) return [];
    const country = readNonEmptyString(entry.country);
    const percentage = toNonNegativeNumber(entry.percentage);
    return country && percentage !== null ? [{ country, percentage }] : [];
  });
}

function parseAudienceAgeGroups(value: unknown): { ageRange: string; percentage: number }[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    if (!isRecord(entry)) return [];
    const ageRange = readNonEmptyString(entry.ageRange);
    const percentage = toNonNegativeNumber(entry.percentage);
    return ageRange && percentage !== null ? [{ ageRange, percentage }] : [];
  });
}

function parseGenderSplit(value: unknown): { male: number; female: number; other?: number } | null {
  if (!isRecord(value)) return null;
  const male = toNonNegativeNumber(value.male);
  const female = toNonNegativeNumber(value.female);
  const other = toNonNegativeNumber(value.other);
  if (male === null || female === null) return null;
  return other === null ? { male, female } : { male, female, other };
}

function toIsoString(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : value;
}

function toIsoStringOrNull(value: unknown): string | null {
  if (!value) return null;
  return value instanceof Date || typeof value === "string" ? toIsoString(value) : null;
}

function toDateString(value: Date | string | null): string | null {
  if (!value) return null;
  return value instanceof Date ? value.toISOString().slice(0, 10) : value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function stableJson(value: unknown): string {
  return JSON.stringify(sortJson(value));
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJson);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => [key, sortJson(entry)]),
  );
}

type AdminCollaborationsQuery = {
  page?: string | string[];
  pageSize?: string | string[];
  page_size?: string | string[];
  status?: string | string[];
  search?: string | string[];
};

type CollaborationParams = {
  collaborationId: string;
};

type InviteCodeParams = {
  inviteCodeId: string;
};

type HotelUserParams = {
  hotelUserId: string;
};

type UserProfileParams = {
  userId: string;
  profileType: string;
};

type OfferParams = HotelUserParams & {
  offerId: string;
};

type RespondBody = {
  status?: "accepted" | "declined";
  responseMessage?: string;
  response_message?: string;
  idempotencyKey?: string;
};

type ApproveBody = {
  idempotencyKey?: string;
};

type InviteCodeRow = {
  id: string;
  code: string;
  status: string;
  createdAt: Date | string;
  expiresAt: Date | string;
  redeemedAt: Date | string | null;
  payload: unknown;
};

type CollaborationRow = {
  id: string;
  collaborationId: string;
  sourceCollaborationId: string;
  offerId: string;
  creatorId: string;
  hotelProfileId: string;
  creatorProfileId: string;
  creatorOrganizationId: string;
  hotelOrganizationId: string;
  initiatorSide: string;
  status: string;
  compensationType: string | null;
  offerTitle: string;
  hotelLocation: string | null;
  creatorName: string | null;
  creatorAvatarUrl: string | null;
  hotelName: string | null;
  freeStayMinNights: number | string | null;
  freeStayMaxNights: number | string | null;
  paidAmount: number | string | null;
  currency: string | null;
  discountPercentage: number | string | null;
  affiliateEnabled: boolean;
  affiliateCommissionPercentage: number | string | null;
  travelDateFrom: Date | string | null;
  travelDateTo: Date | string | null;
  preferredDateFrom: Date | string | null;
  preferredDateTo: Date | string | null;
  preferredMonths: string[] | null;
  deliverables: unknown;
  lastMessageAt: Date | string | null;
  applicationMessage: string | null;
  hotelAgreedAt: Date | string | null;
  creatorAgreedAt: Date | string | null;
  completedAt: Date | string | null;
  cancelledAt: Date | string | null;
  createdAt: Date | string;
  updatedAt: Date | string;
};

export type OfferRow = {
  offerId: string;
  propertyId: string;
  offerStatus: MarketplaceAdminOffer["offerStatus"];
  title: string;
  offerSummary: string | null;
  media: unknown;
  deliverables: unknown;
  compensationOptions: unknown;
  creatorRequirements: unknown;
  matchingCriteria?: unknown;
  createdAt: Date | string;
  updatedAt: Date | string;
};

const INVITE_CODE_SELECT_BODY = `
  SELECT
    invite.id::text AS id,
    invite.code,
    invite.status,
    invite.created_at AS "createdAt",
    invite.expires_at AS "expiresAt",
    invite.redeemed_at AS "redeemedAt",
    invite.payload
  FROM invite
`;

const INVITE_CODE_SELECT_SQL = `
  WITH invite AS (
    SELECT *
    FROM marketplace.invite_codes invite
  )
  ${INVITE_CODE_SELECT_BODY}
`;

const COLLABORATION_SELECT_SQL = `
  SELECT
    collaboration.id::text AS id,
    collaboration.id::text AS "collaborationId",
    COALESCE(collaboration.source_collaboration_id, collaboration.id::text) AS "sourceCollaborationId",
    offer.id::text AS "offerId",
    creator.id::text AS "creatorId",
    profile.property_id::text AS "hotelProfileId",
    creator.id::text AS "creatorProfileId",
    creator.organization_id::text AS "creatorOrganizationId",
    offer.organization_id::text AS "hotelOrganizationId",
    collaboration.initiator_type AS "initiatorSide",
    collaboration.lifecycle_status AS status,
    collaboration.compensation_type AS "compensationType",
    offer.title AS "offerTitle",
    NULLIF(concat_ws(
      ', ',
      NULLIF(public_profile.location->>'city', ''),
      NULLIF(public_profile.location->>'region', ''),
      NULLIF(public_profile.location->>'countryCode', '')
    ), '') AS "hotelLocation",
    creator.display_name AS "creatorName",
    creator.profile_picture_url AS "creatorAvatarUrl",
    COALESCE(public_profile.display_name, property.display_name) AS "hotelName",
    collaboration.free_stay_min_nights AS "freeStayMinNights",
    collaboration.free_stay_max_nights AS "freeStayMaxNights",
    collaboration.paid_amount AS "paidAmount",
    collaboration.currency AS currency,
    collaboration.discount_percentage AS "discountPercentage",
    collaboration.affiliate_enabled AS "affiliateEnabled",
    collaboration.affiliate_commission_percentage AS "affiliateCommissionPercentage",
    collaboration.travel_date_from AS "travelDateFrom",
    collaboration.travel_date_to AS "travelDateTo",
    collaboration.preferred_date_from AS "preferredDateFrom",
    collaboration.preferred_date_to AS "preferredDateTo",
    collaboration.preferred_months AS "preferredMonths",
    COALESCE(deliverables.items, '[]'::jsonb) AS deliverables,
    messages.last_message_at AS "lastMessageAt",
    collaboration.application_message AS "applicationMessage",
    collaboration.hotel_agreed_at AS "hotelAgreedAt",
    collaboration.creator_agreed_at AS "creatorAgreedAt",
    collaboration.completed_at AS "completedAt",
    collaboration.cancelled_at AS "cancelledAt",
    collaboration.created_at AS "createdAt",
    collaboration.updated_at AS "updatedAt"
  FROM marketplace.collaborations collaboration
  JOIN marketplace.creator_profiles creator
    ON creator.id = collaboration.creator_profile_id
   AND creator.organization_id = collaboration.creator_organization_id
  JOIN marketplace.marketplace_offers offer
    ON offer.id = collaboration.offer_id
   AND offer.property_id = collaboration.property_id
   AND offer.organization_id = collaboration.hotel_organization_id
  JOIN marketplace.marketplace_hotel_profiles profile
    ON profile.property_id = offer.property_id
   AND profile.organization_id = offer.organization_id
  JOIN hotel_catalog.properties property ON property.id = offer.property_id
  LEFT JOIN hotel_catalog.property_public_profile_read_model public_profile
    ON public_profile.property_id = offer.property_id
  LEFT JOIN LATERAL (
    SELECT jsonb_agg(
      jsonb_build_object(
        'deliverableId', deliverable.id::text,
        'platform', deliverable.platform,
        'type', deliverable.deliverable_type,
        'quantity', deliverable.quantity,
        'status', deliverable.deliverable_status,
        'completedAt', deliverable.completed_at
      ) ORDER BY deliverable.created_at, deliverable.id
    ) AS items
    FROM marketplace.collaboration_deliverables deliverable
    WHERE deliverable.collaboration_id = collaboration.id
      AND deliverable.property_id = collaboration.property_id
  ) deliverables ON TRUE
  LEFT JOIN LATERAL (
    SELECT max(created_at) AS last_message_at
    FROM marketplace.marketplace_chat_messages message
    WHERE message.collaboration_id = collaboration.id
      AND message.property_id = collaboration.property_id
  ) messages ON TRUE
`;

const COLLABORATION_MUTATION_CTE = `
  WITH matched AS (
    SELECT id
    FROM marketplace.collaborations
    WHERE source_collaboration_id = $1 OR id::text = $1
    LIMIT 1
  )
`;

export const OFFER_SELECT_SQL = `
  SELECT
    offer.id::text AS "offerId",
    offer.property_id::text AS "propertyId",
    offer.offer_status AS "offerStatus",
    offer.title,
    offer.offer_summary AS "offerSummary",
    COALESCE(offer_media.items, legacy_media.items, '[]'::jsonb) AS media,
    COALESCE(deliverables.items, '[]'::jsonb) AS deliverables,
    COALESCE(compensation.items, '[]'::jsonb) AS "compensationOptions",
    COALESCE(requirements.item, '{}'::jsonb) AS "creatorRequirements",
    matching_criteria.item AS "matchingCriteria",
    offer.created_at AS "createdAt",
    offer.updated_at AS "updatedAt"
  FROM marketplace.marketplace_offers offer
  ${OFFER_MEDIA_LATERAL_SQL}
  LEFT JOIN LATERAL (
    SELECT jsonb_agg(
      jsonb_build_object('mediaObjectId', NULL, 'url', legacy.url)
      ORDER BY legacy.ordinality
    ) AS items
    FROM unnest(offer.image_urls) WITH ORDINALITY AS legacy(url, ordinality)
    WHERE NULLIF(btrim(legacy.url), '') IS NOT NULL
  ) legacy_media ON TRUE
  LEFT JOIN LATERAL (
    SELECT jsonb_agg(
      jsonb_build_object(
        'deliverableId', deliverable.id::text,
        'platform', deliverable.platform,
        'deliverableType', deliverable.deliverable_type,
        'quantity', deliverable.quantity,
        'timingGuidance', deliverable.timing_guidance,
        'requirementLevel', deliverable.requirement_level
      ) ORDER BY deliverable.created_at, deliverable.id
    ) AS items
    FROM marketplace.offer_deliverables deliverable
    WHERE deliverable.offer_id = offer.id
      AND deliverable.property_id = offer.property_id
      AND deliverable.organization_id = offer.organization_id
  ) deliverables ON TRUE
  LEFT JOIN LATERAL (
    SELECT jsonb_agg(
      jsonb_build_object(
        'compensationOptionId', option.id::text,
        'compensationType', option.compensation_type,
        'availabilityMonths', option.availability_months,
        'platforms', option.platforms,
        'freeStayMinNights', option.free_stay_min_nights,
        'freeStayMaxNights', option.free_stay_max_nights,
        'paidMaxAmount', option.paid_max_amount,
        'discountPercentage', option.discount_percentage,
        'commissionPercentage', option.commission_percentage,
        'minFollowers', option.min_followers,
        'currency', option.currency,
        'termsSummary', option.terms_summary,
        'followerRequirementLevel', option.follower_requirement_level
      )
      ORDER BY option.created_at ASC, option.id ASC
    ) AS items
    FROM marketplace.offer_compensation_options option
    WHERE option.offer_id = offer.id
      AND option.property_id = offer.property_id
      AND option.organization_id = offer.organization_id
  ) compensation ON TRUE
  LEFT JOIN LATERAL (
    SELECT jsonb_build_object(
      'platforms', requirement.platforms,
      'platformRequirementLevel', requirement.platform_requirement_level,
      'targetCountries', COALESCE(requirement.target_countries, '{}'),
      'targetCountriesRequirementLevel', requirement.target_countries_requirement_level,
      'targetAgeMin', requirement.target_age_min,
      'targetAgeMax', requirement.target_age_max,
      'targetAgeGroups', requirement.target_age_groups,
      'creatorTypes', requirement.creator_types,
      'creatorTypesRequirementLevel', requirement.creator_types_requirement_level
    ) AS item
    FROM marketplace.offer_creator_requirements requirement
    WHERE requirement.offer_id = offer.id
      AND requirement.property_id = offer.property_id
      AND requirement.organization_id = offer.organization_id
    LIMIT 1
  ) requirements ON TRUE
  LEFT JOIN LATERAL (
    SELECT jsonb_build_object(
      'contractVersion', criteria.contract_version,
      'revision', criteria.revision,
      'updatedAt', criteria.updated_at
    ) || criteria.criteria AS item
    FROM marketplace.offer_matching_criteria criteria
    WHERE criteria.offer_id = offer.id
      AND criteria.property_id = offer.property_id
      AND criteria.organization_id = offer.organization_id
    LIMIT 1
  ) matching_criteria ON TRUE
`;
