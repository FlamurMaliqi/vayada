import {
  MARKETPLACE_ADMIN_CREATOR_PROFILE_STATUSES,
  buildMarketplaceAdminCreatorModerationIdempotencyKey,
  isMarketplaceAdminCreatorModerationReason,
  moderateMarketplaceAdminCreatorProfile,
  type MarketplaceAdminCreatorModerationResponse,
  type MarketplaceAdminCreatorModerationTargetStatus,
  type MarketplaceAdminCreatorProfileStatus,
} from "@vayada/marketplace-shared/api/admin";

export type CreatorModerationAction = {
  nextStatus: MarketplaceAdminCreatorModerationTargetStatus;
  label: string;
  confirmationLabel: string;
  description: string;
  destructive: boolean;
};

export type CreatorModerationFailure = {
  message: string;
  currentStatus?: MarketplaceAdminCreatorProfileStatus;
  refreshRequired: boolean;
};

const ACTION_COPY: Record<MarketplaceAdminCreatorModerationTargetStatus, CreatorModerationAction> =
  {
    active: {
      nextStatus: "active",
      label: "Activate",
      confirmationLabel: "Activate creator",
      description: "Approve this profile for marketplace discovery.",
      destructive: false,
    },
    rejected: {
      nextStatus: "rejected",
      label: "Reject",
      confirmationLabel: "Reject creator",
      description: "Decline the profile after review.",
      destructive: true,
    },
    suspended: {
      nextStatus: "suspended",
      label: "Suspend",
      confirmationLabel: "Suspend creator",
      description: "Temporarily remove this profile from discovery.",
      destructive: true,
    },
    archived: {
      nextStatus: "archived",
      label: "Archive",
      confirmationLabel: "Archive creator",
      description: "Permanently close this profile's lifecycle.",
      destructive: true,
    },
  };

export function getCreatorModerationActions(
  status: MarketplaceAdminCreatorProfileStatus,
  allowedTransitions: readonly MarketplaceAdminCreatorModerationTargetStatus[],
): readonly CreatorModerationAction[] {
  return allowedTransitions.map((nextStatus) => {
    if (status !== "suspended" || nextStatus !== "active") return ACTION_COPY[nextStatus];
    return {
      ...ACTION_COPY.active,
      label: "Reactivate",
      confirmationLabel: "Reactivate creator",
      description: "Return this profile to marketplace discovery.",
    };
  });
}

export function creatorModerationReasonError(reason: string): string | null {
  const normalized = reason.trim();
  if (!normalized) return "Enter a reason for this decision.";
  if (normalized.length > 1000) return "Keep the reason to 1,000 characters or fewer.";
  if (!isMarketplaceAdminCreatorModerationReason(normalized)) {
    return "Use a single line without control characters.";
  }
  return null;
}

export function createCreatorModerationIdempotencyKey(
  creatorProfileId: string,
  nextStatus: MarketplaceAdminCreatorModerationTargetStatus,
): string {
  const nonce = globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random()}`;
  return buildMarketplaceAdminCreatorModerationIdempotencyKey({
    creatorProfileId,
    nextStatus,
    nonce,
  });
}

export async function moderateCreatorProfile(input: {
  creatorProfileId: string;
  currentStatus: MarketplaceAdminCreatorProfileStatus;
  nextStatus: MarketplaceAdminCreatorModerationTargetStatus;
  reason: string;
  idempotencyKey: string;
}): Promise<MarketplaceAdminCreatorModerationResponse> {
  return moderateMarketplaceAdminCreatorProfile(
    input.creatorProfileId,
    {
      expectedStatus: input.currentStatus,
      nextStatus: input.nextStatus,
      reason: input.reason.trim(),
    },
    input.idempotencyKey,
  );
}

export function creatorModerationFailure(error: unknown): CreatorModerationFailure {
  const response = toErrorResponse(error);
  const currentStatus = isCreatorProfileStatus(response.data.currentStatus)
    ? response.data.currentStatus
    : undefined;

  switch (response.data.code) {
    case "profile_status_conflict":
      return {
        message: "This profile changed elsewhere. Review its refreshed state before trying again.",
        currentStatus,
        refreshRequired: true,
      };
    case "invalid_profile_transition":
      return {
        message: "That lifecycle change is no longer available. Review the current state.",
        currentStatus,
        refreshRequired: true,
      };
    case "profile_incomplete":
      return {
        message: "This profile is incomplete and cannot be activated yet.",
        currentStatus,
        refreshRequired: true,
      };
    case "idempotency_key_conflict":
      return {
        message: "This request changed after it started. Close the dialog and try again.",
        currentStatus,
        refreshRequired: false,
      };
    case "command_in_progress":
      return {
        message: "This moderation change is still processing. Try again in a moment.",
        currentStatus,
        refreshRequired: false,
      };
    case "creator_profile_not_found":
      return {
        message: "This creator profile no longer exists.",
        refreshRequired: true,
      };
  }

  if (response.status === 401) {
    return { message: "Your session expired. Sign in again.", refreshRequired: true };
  }
  if (response.status === 403) {
    return {
      message: "You do not have permission to moderate creator profiles.",
      refreshRequired: true,
    };
  }
  if (response.status === 422) {
    return {
      message: "The moderation request was invalid. Review the reason and try again.",
      refreshRequired: false,
    };
  }
  return {
    message: "The creator status could not be updated. Try again.",
    refreshRequired: false,
  };
}

function toErrorResponse(error: unknown): {
  status?: number;
  data: { code?: string; currentStatus?: unknown };
} {
  if (typeof error !== "object" || error === null) return { data: {} };
  const candidate = error as {
    status?: unknown;
    data?: { code?: unknown; currentStatus?: unknown };
  };
  return {
    status: typeof candidate.status === "number" ? candidate.status : undefined,
    data: {
      code: typeof candidate.data?.code === "string" ? candidate.data.code : undefined,
      currentStatus: candidate.data?.currentStatus,
    },
  };
}

function isCreatorProfileStatus(value: unknown): value is MarketplaceAdminCreatorProfileStatus {
  return MARKETPLACE_ADMIN_CREATOR_PROFILE_STATUSES.includes(
    value as MarketplaceAdminCreatorProfileStatus,
  );
}
