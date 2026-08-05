import {
  MARKETPLACE_HOTEL_COLLABORATION_PREFERENCES_CONTRACT_VERSION,
  type MarketplaceHotelCollaborationPreferencesReadModel,
  type MarketplaceHotelCollaborationPreferencesReadyReadModel,
  type MarketplaceHotelCollaborationPreferencesRevision,
  type MarketplaceHotelCollaborationPreferencesSourceRevision,
  type ReplaceMarketplaceHotelCollaborationPreferencesRequest,
  parseMarketplaceHotelCollaborationPreferencesReadModel,
  parseReplaceMarketplaceHotelCollaborationPreferencesRequest,
} from "./hotelCollaborationPreferences.js";

export const MARKETPLACE_HOTEL_COLLABORATION_PREFERENCES_AUTHORIZATION = Object.freeze({
  permission: "marketplace.profile.manage",
  entitlement: Object.freeze({
    product: "marketplace",
    key: "marketplace-hotel-profile",
    resourceType: "hotel_profile",
    status: "active",
  }),
  resource: Object.freeze({
    product: "marketplace",
    resourceType: "hotel_profile",
    allowedRelationships: Object.freeze(["owner", "operator"] as const),
  }),
} as const);

export const MARKETPLACE_HOTEL_COLLABORATION_PREFERENCES_SOURCE_IDENTITY = Object.freeze({
  ownerDomain: "marketplace",
  entityType: "hotel_collaboration_preferences",
} as const);

export const MARKETPLACE_HOTEL_COLLABORATION_PREFERENCES_CHANGED_EVENT_TYPE =
  "marketplace.hotel_collaboration_preferences.changed" as const;
export const MARKETPLACE_HOTEL_COLLABORATION_PREFERENCES_OUTBOX = Object.freeze({
  destination: "marketplace.submission-source",
  metadata: Object.freeze({ sourceReadRequired: true as const }),
} as const);

export type MarketplaceHotelCollaborationPreferencesCommandAudit = {
  readonly actor: { readonly kind: "user"; readonly userId: string };
  readonly requestId: string;
  readonly correlationId: string | null;
  readonly requestedAt: string;
};

export type ReplaceMarketplaceHotelCollaborationPreferencesCommand = {
  readonly organizationId: string;
  readonly propertyId: string;
  readonly idempotencyKey: string;
  readonly audit: MarketplaceHotelCollaborationPreferencesCommandAudit;
  readonly request: ReplaceMarketplaceHotelCollaborationPreferencesRequest;
};

export type ReplaceMarketplaceHotelCollaborationPreferencesResponse =
  MarketplaceHotelCollaborationPreferencesReadyReadModel & {
    readonly outcome: "updated" | "idempotent_replay";
    readonly acceptedAt: string;
  };

export type ReplaceMarketplaceHotelCollaborationPreferencesError =
  | { readonly code: "preferences_revision_conflict"; readonly currentRevision: number }
  | {
      readonly code: "idempotency_key_conflict" | "command_in_progress" | "setup_scope_unavailable";
    };

export type ReplaceMarketplaceHotelCollaborationPreferencesResult =
  | {
      readonly ok: true;
      readonly response: ReplaceMarketplaceHotelCollaborationPreferencesResponse;
    }
  | { readonly ok: false; readonly error: ReplaceMarketplaceHotelCollaborationPreferencesError };

export type MarketplaceHotelCollaborationPreferencesCommandPort = {
  /**
   * Every attempt is authorized for the active Marketplace hotel-profile scope
   * before any idempotency lookup or replay. A matching completed key returns
   * its stored result without another revision, audit, event, or outbox row.
   * Changed input conflicts before revision checks. The accepted write,
   * idempotency result, product audit, changed event, and required outbox row
   * commit atomically under the property lock.
   */
  replaceHotelCollaborationPreferences(
    command: ReplaceMarketplaceHotelCollaborationPreferencesCommand,
  ): Promise<ReplaceMarketplaceHotelCollaborationPreferencesResult>;
};

export type MarketplaceHotelCollaborationPreferencesReadScope = {
  readonly organizationId: string;
  readonly propertyId: string;
};

export type MarketplaceHotelCollaborationPreferencesReadOutcome =
  | {
      readonly outcome: "available";
      readonly readModel: MarketplaceHotelCollaborationPreferencesReadModel;
    }
  | {
      readonly outcome: "unavailable";
      readonly error: {
        readonly code: "preference_source_unavailable";
        readonly errorSource: "system";
        readonly retryable: true;
      };
    }
  | {
      readonly outcome: "malformed";
      readonly error: {
        readonly code: "preference_source_malformed";
        readonly errorSource: "system";
        readonly retryable: false;
      };
    };

export type MarketplaceHotelCollaborationPreferencesReadPort = {
  /** Revision zero is an available owner omission; unavailable and malformed are not omissions. */
  getHotelCollaborationPreferences(
    scope: MarketplaceHotelCollaborationPreferencesReadScope,
  ): Promise<MarketplaceHotelCollaborationPreferencesReadOutcome>;
};

/** Exact stable business fingerprint; audit and idempotency transport data are excluded. */
export function serializeReplaceMarketplaceHotelCollaborationPreferencesFingerprint(
  command: ReplaceMarketplaceHotelCollaborationPreferencesCommand,
): string {
  const organizationId = normalizeUuid(command.organizationId);
  const propertyId = normalizeUuid(command.propertyId);
  const request = parseReplaceMarketplaceHotelCollaborationPreferencesRequest(command.request);
  if (!organizationId || !propertyId || !request) {
    throw new TypeError("Marketplace preference fingerprint requires canonical command input");
  }
  return JSON.stringify({
    organizationId,
    propertyId,
    request: {
      expectedRevision: request.expectedRevision,
      compensationTypes: request.compensationTypes,
      contentPlatforms: request.contentPlatforms,
      contentTypes: request.contentTypes,
      availability: request.availability,
    },
  });
}

export function serializeMarketplaceHotelCollaborationPreferencesSourceRevision(
  revision: number,
): "preferences:0" | MarketplaceHotelCollaborationPreferencesSourceRevision {
  if (!isRevision(revision, true)) {
    throw new TypeError("Marketplace preference source revision must be a non-negative integer");
  }
  return `preferences:${revision}` as
    | "preferences:0"
    | MarketplaceHotelCollaborationPreferencesSourceRevision;
}

export type MarketplaceHotelCollaborationPreferencesChangedEvent = {
  readonly contractVersion: typeof MARKETPLACE_HOTEL_COLLABORATION_PREFERENCES_CONTRACT_VERSION;
  readonly eventType: typeof MARKETPLACE_HOTEL_COLLABORATION_PREFERENCES_CHANGED_EVENT_TYPE;
  readonly eventId: string;
  readonly organizationId: string;
  readonly propertyId: string;
  readonly preferenceRevision: MarketplaceHotelCollaborationPreferencesRevision;
  readonly outcome: "updated";
};

export function parseReplaceMarketplaceHotelCollaborationPreferencesResult(
  value: unknown,
): ReplaceMarketplaceHotelCollaborationPreferencesResult | null {
  try {
    const result = snapshotDataRecord(value);
    if (!result || typeof result.ok !== "boolean") return null;
    if (result.ok) return parseSuccess(result);
    return parseFailure(result);
  } catch {
    return null;
  }
}

function parseSuccess(
  result: Record<string, unknown>,
): ReplaceMarketplaceHotelCollaborationPreferencesResult | null {
  if (!hasExactKeys(result, ["ok", "response"])) return null;
  const response = snapshotDataRecord(result.response);
  if (
    !response ||
    !hasExactKeys(response, RESPONSE_KEYS) ||
    (response.outcome !== "updated" && response.outcome !== "idempotent_replay") ||
    !isTimestamp(response.acceptedAt)
  )
    return null;
  const readModel = parseMarketplaceHotelCollaborationPreferencesReadModel(
    Object.fromEntries(READ_MODEL_KEYS.map((key) => [key, response[key]])),
  );
  if (!readModel || readModel.preferences === null) return null;
  return deepFreeze({
    ok: true,
    response: { ...readModel, outcome: response.outcome, acceptedAt: response.acceptedAt },
  });
}

function parseFailure(
  result: Record<string, unknown>,
): ReplaceMarketplaceHotelCollaborationPreferencesResult | null {
  if (!hasExactKeys(result, ["ok", "error"])) return null;
  const error = snapshotDataRecord(result.error);
  if (!error || typeof error.code !== "string") return null;
  if (error.code === "preferences_revision_conflict") {
    return hasExactKeys(error, ["code", "currentRevision"]) &&
      isRevision(error.currentRevision, true)
      ? deepFreeze({
          ok: false,
          error: { code: error.code, currentRevision: error.currentRevision },
        })
      : null;
  }
  if (
    !hasExactKeys(error, ["code"]) ||
    !SIMPLE_ERROR_CODES.includes(error.code as (typeof SIMPLE_ERROR_CODES)[number])
  )
    return null;
  const code = error.code as (typeof SIMPLE_ERROR_CODES)[number];
  return deepFreeze({ ok: false, error: { code } });
}

const READ_MODEL_KEYS = [
  "contractVersion",
  "propertyId",
  "revision",
  "sourceRevision",
  "preferences",
  "readiness",
] as const;
const RESPONSE_KEYS = [...READ_MODEL_KEYS, "outcome", "acceptedAt"] as const;
const SIMPLE_ERROR_CODES = [
  "idempotency_key_conflict",
  "command_in_progress",
  "setup_scope_unavailable",
] as const;

function snapshotDataRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const prototype = Object.getPrototypeOf(value);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const ownKeys = Reflect.ownKeys(descriptors);
  if (
    (prototype !== Object.prototype && prototype !== null) ||
    !ownKeys.every(
      (key) => typeof key === "string" && "value" in (descriptors[key as string] ?? {}),
    )
  )
    return null;
  return Object.fromEntries(
    ownKeys.map((key) => [key, descriptors[key as string]!.value] as const),
  );
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const ownKeys = Reflect.ownKeys(value);
  return ownKeys.length === keys.length && ownKeys.every((key) => keys.includes(String(key)));
}

function normalizeUuid(value: unknown): string | null {
  return typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
    ? value.toLowerCase()
    : null;
}

function isRevision(value: unknown, allowZero: boolean): value is number {
  return (
    typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= (allowZero ? 0 : 1) &&
    value <= 2_147_483_647
  );
}

function isTimestamp(value: unknown): value is string {
  return typeof value === "string" && new Date(value).toISOString() === value;
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}
