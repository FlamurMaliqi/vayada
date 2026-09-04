export const MARKETPLACE_CREATOR_MODERATION_CONTRACT_VERSION =
  "marketplace-creator-moderation.v1" as const;

export const MARKETPLACE_CREATOR_PROFILE_STATUSES = [
  "pending",
  "active",
  "rejected",
  "suspended",
  "archived",
] as const;

export type MarketplaceCreatorProfileStatus = (typeof MARKETPLACE_CREATOR_PROFILE_STATUSES)[number];

export type MarketplaceCreatorModerationTargetStatus = Exclude<
  MarketplaceCreatorProfileStatus,
  "pending"
>;

export type MarketplaceCreatorModerationRequest = {
  expectedStatus: MarketplaceCreatorProfileStatus;
  nextStatus: MarketplaceCreatorModerationTargetStatus;
  reason: string;
};

export type MarketplaceCreatorModerationResponse = {
  contractVersion: typeof MARKETPLACE_CREATOR_MODERATION_CONTRACT_VERSION;
  outcome: "transitioned" | "unchanged";
  creatorProfileId: string;
  previousStatus: MarketplaceCreatorProfileStatus;
  profileStatus: MarketplaceCreatorModerationTargetStatus;
  reason: string;
  moderatedByUserId: string;
  moderatedAt: string;
};

export type MarketplaceCreatorModerationErrorCode =
  | "creator_profile_not_found"
  | "profile_status_conflict"
  | "invalid_profile_transition"
  | "profile_incomplete"
  | "idempotency_key_conflict"
  | "command_in_progress";

export type MarketplaceCreatorModerationResult =
  | { ok: true; response: MarketplaceCreatorModerationResponse }
  | {
      ok: false;
      error: {
        code: MarketplaceCreatorModerationErrorCode;
        currentStatus?: MarketplaceCreatorProfileStatus;
      };
    };

export type MarketplaceCreatorModerationCommand = {
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
};

export const MARKETPLACE_CREATOR_MODERATION_AUTHORIZATION = {
  permission: "platform.user.suspend",
  entitlement: { product: "platform", key: "platform-admin" },
  resource: {
    product: "platform",
    resourceType: "platform",
    resourceId: "vayada",
    allowedRelationships: ["operator"],
  },
} as const;

const ALLOWED_TRANSITIONS: Readonly<
  Record<MarketplaceCreatorProfileStatus, readonly MarketplaceCreatorModerationTargetStatus[]>
> = {
  pending: ["active", "rejected", "archived"],
  active: ["suspended", "archived"],
  rejected: ["active", "archived"],
  suspended: ["active", "archived"],
  archived: [],
};

export function isMarketplaceCreatorProfileStatus(
  value: unknown,
): value is MarketplaceCreatorProfileStatus {
  return MARKETPLACE_CREATOR_PROFILE_STATUSES.includes(value as MarketplaceCreatorProfileStatus);
}

export function isMarketplaceCreatorModerationTargetStatus(
  value: unknown,
): value is MarketplaceCreatorModerationTargetStatus {
  return value !== "pending" && isMarketplaceCreatorProfileStatus(value);
}

export function isMarketplaceCreatorModerationReason(value: unknown): value is string {
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

export function canModerateMarketplaceCreatorProfile(
  currentStatus: MarketplaceCreatorProfileStatus,
  nextStatus: MarketplaceCreatorModerationTargetStatus,
): boolean {
  return ALLOWED_TRANSITIONS[currentStatus].includes(nextStatus);
}
