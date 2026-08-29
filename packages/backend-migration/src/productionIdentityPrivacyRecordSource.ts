import type {
  IdentityMigrationBlocker,
  IdentitySourceRow,
} from "./productionIdentityDisposition.js";
import { sortedBy } from "./productionIdentityOwnershipPolicy.js";
import {
  addDuplicateValueBlockers,
  assertKnownUser,
  bool,
  date,
  optionalDate,
  optionalText,
  optionalUuid,
  parseAuthRows,
  text,
  uniqueRows,
  uuid,
} from "./productionIdentitySourceValidation.js";

export type PlannedConsentHistory = {
  id: string;
  userId: string | null;
  visitorId: null;
  consentType: string;
  consentGiven: boolean;
  version: string | null;
  metadata: Record<string, string>;
  createdAt: string;
};
export type PlannedGdprRequest = {
  id: string;
  userId: string;
  requestType: string;
  status: string;
  downloadToken: string | null;
  requestedAt: string;
  processedAt: string | null;
  expiresAt: string | null;
  ipAddress: string | null;
  metadata: Record<string, string>;
  createdAt: string;
  updatedAt: string;
};
export type IdentityPrivacyRecordSourcePlan = {
  consentHistory: PlannedConsentHistory[];
  gdprRequests: PlannedGdprRequest[];
  blockers: IdentityMigrationBlocker[];
};

const CONSENT_TYPES = new Set([
  "terms",
  "privacy",
  "marketing",
  "cookies",
  "deletion_request",
  "deletion_cancelled",
]);
const GDPR_TYPES = new Set(["export", "deletion"]);
const GDPR_STATUSES = new Set(["pending", "processing", "completed", "cancelled", "expired"]);

export function planIdentityPrivacyRecordSource(
  rows: IdentitySourceRow[],
  knownUserIds: Iterable<string>,
): IdentityPrivacyRecordSourcePlan {
  const users = new Set(knownUserIds);
  const blockers: IdentityMigrationBlocker[] = [];
  const consentHistory = uniqueRows(
    parseAuthRows(rows, "consent_history", blockers, (row) => {
      const userId = optionalUuid(row.data["user_id"], "user_id");
      assertKnownUser(userId, users);
      return {
        id: uuid(row.data["id"], "id"),
        userId,
        visitorId: null,
        consentType: allowed(row.data["consent_type"], "consent_type", CONSENT_TYPES),
        consentGiven: bool(row.data["consent_given"], "consent_given"),
        version: optionalText(row.data["version"], "version"),
        metadata: compact({
          ipAddress: optionalText(row.data["ip_address"], "ip_address"),
          userAgent: optionalText(row.data["user_agent"], "user_agent"),
        }),
        createdAt: date(row.data["created_at"], "created_at"),
      };
    }),
    (row) => row.id,
    "auth.consent_history",
    "CONSENT_HISTORY_CONFLICT",
    blockers,
  );

  const gdprRequests = uniqueRows(
    parseAuthRows(rows, "gdpr_requests", blockers, (row) => {
      const userId = uuid(row.data["user_id"], "user_id");
      assertKnownUser(userId, users);
      const requestType = allowed(row.data["request_type"], "request_type", GDPR_TYPES);
      const status = allowed(row.data["status"], "status", GDPR_STATUSES);
      const requestedAt = date(row.data["requested_at"], "requested_at");
      const processedAt = optionalDate(row.data["processed_at"], "processed_at");
      const expiresAt = optionalDate(row.data["expires_at"], "expires_at");
      if (processedAt && Date.parse(processedAt) < Date.parse(requestedAt))
        throw new Error("processed_at cannot precede requested_at");
      if (expiresAt && Date.parse(expiresAt) < Date.parse(requestedAt))
        throw new Error("expires_at cannot precede requested_at");
      if (status === "completed" && !processedAt)
        throw new Error("completed request requires processed_at");
      if (["pending", "processing", "cancelled"].includes(status) && processedAt)
        throw new Error(`${status} request cannot have processed_at`);
      if (status === "expired" && !expiresAt)
        throw new Error("expired request requires expires_at");
      if (status === "expired" && processedAt && Date.parse(processedAt) > Date.parse(expiresAt!))
        throw new Error("processed_at cannot follow expires_at for an expired request");
      return {
        id: uuid(row.data["id"], "id"),
        userId,
        requestType,
        status,
        downloadToken: optionalText(row.data["download_token"], "download_token"),
        requestedAt,
        processedAt,
        expiresAt,
        ipAddress: optionalText(row.data["ip_address"], "ip_address"),
        metadata: compact({
          cancellationReason: optionalText(row.data["cancellation_reason"], "cancellation_reason"),
        }),
        createdAt: requestedAt,
        updatedAt:
          status === "completed" ? processedAt! : status === "expired" ? expiresAt! : requestedAt,
      };
    }),
    (row) => row.id,
    "auth.gdpr_requests",
    "GDPR_REQUEST_CONFLICT",
    blockers,
  );
  addDuplicateValueBlockers(
    gdprRequests.filter((row) => row.downloadToken !== null),
    (row) => row.downloadToken!,
    (row) => row.id,
    "auth.gdpr_requests",
    "GDPR_TOKEN_CONFLICT",
    blockers,
  );
  return {
    consentHistory,
    gdprRequests,
    blockers: sortedBy(blockers, (row) => `${row.code}:${row.source}:${row.sourceId}`),
  };
}

function allowed(value: unknown, field: string, values: Set<string>): string {
  const result = text(value, field);
  if (!values.has(result)) throw new Error(`${field} ${result} is unsupported`);
  return result;
}
function compact(values: Record<string, string | null>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(values).filter((entry): entry is [string, string] => entry[1] !== null),
  );
}
