import type {
  IdentityMigrationBlocker,
  IdentitySourceRow,
} from "./productionIdentityDisposition.js";
import { sortedBy } from "./productionIdentityOwnershipPolicy.js";
import {
  addBlocker,
  assertKnownUser,
  bool,
  date,
  optionalText,
  optionalUuid,
  parseAuthRows,
  stableJson,
  text,
  uniqueRows,
  uuid,
} from "./productionIdentitySourceValidation.js";

export type PlannedIdentityAuditEvent = {
  id: string;
  auditKey: string;
  product: "identity";
  action: "auth.login.succeeded" | "auth.login.failed";
  actionVersion: 1;
  occurredAt: string;
  recordedAt: string;
  tenantScope: "migration";
  organizationId: string | null;
  propertyId: string | null;
  actorType: "user" | "system";
  actorUserId: string | null;
  targetResourceProduct: "identity";
  targetResourceType: "user" | "login_attempt";
  targetResourceId: string;
  secondaryResourceProduct: string | null;
  secondaryResourceType: string | null;
  secondaryResourceId: string | null;
  domainEventId: string | null;
  externalWebhookEventId: string | null;
  jobId: string | null;
  idempotencyKeyId: string | null;
  correlationId: string | null;
  causationId: string | null;
  redactedPayload: Record<string, unknown>;
  privatePayload: Record<string, unknown>;
  auditMetadata: { source: "auth.login_audit_log" };
  retentionClass: "security";
  privacyScope: "restricted";
  aiVisible: false;
};
export type IdentityAuditPlan = {
  auditEvents: PlannedIdentityAuditEvent[];
  blockers: IdentityMigrationBlocker[];
};
export type ExistingAuditReference = { id: string; product: string; auditKey: string };
const AUTH_METHODS = new Set(["password", "password+totp", "password+recovery_code"]);

export function planIdentityAudit(
  rows: IdentitySourceRow[],
  knownUserIds: Iterable<string>,
  existing: Array<PlannedIdentityAuditEvent | ExistingAuditReference> = [],
): IdentityAuditPlan {
  const users = new Set(knownUserIds);
  const blockers: IdentityMigrationBlocker[] = [];
  const sourceEvents = uniqueRows(
    parseAuthRows(rows, "login_audit_log", blockers, (row) => {
      const id = uuid(row.data["id"], "id");
      const actorUserId = optionalUuid(row.data["user_id"], "user_id");
      assertKnownUser(actorUserId, users);
      const success = bool(row.data["success"], "success");
      const occurredAt = date(row.data["created_at"], "created_at");
      const authMethod = optionalText(row.data["auth_method"], "auth_method");
      if (authMethod && !AUTH_METHODS.has(authMethod))
        throw new Error("auth_method is unsupported");
      return {
        id,
        auditKey: `legacy-auth-login:${id}`,
        product: "identity" as const,
        action: success ? ("auth.login.succeeded" as const) : ("auth.login.failed" as const),
        actionVersion: 1 as const,
        occurredAt,
        recordedAt: occurredAt,
        tenantScope: "migration" as const,
        organizationId: null,
        propertyId: null,
        actorType: actorUserId ? ("user" as const) : ("system" as const),
        actorUserId,
        targetResourceProduct: "identity" as const,
        targetResourceType: actorUserId ? ("user" as const) : ("login_attempt" as const),
        targetResourceId: actorUserId ?? id,
        secondaryResourceProduct: null,
        secondaryResourceType: null,
        secondaryResourceId: null,
        domainEventId: null,
        externalWebhookEventId: null,
        jobId: null,
        idempotencyKeyId: null,
        correlationId: null,
        causationId: null,
        redactedPayload: compact({
          success,
          authMethod,
        }),
        privatePayload: compact({
          email: text(row.data["email"], "email").trim().toLowerCase(),
          failureReason: optionalText(row.data["failure_reason"], "failure_reason"),
          ipAddress: optionalText(row.data["ip_address"], "ip_address"),
          userAgent: optionalText(row.data["user_agent"], "user_agent"),
        }),
        auditMetadata: { source: "auth.login_audit_log" as const },
        retentionClass: "security" as const,
        privacyScope: "restricted" as const,
        aiVisible: false as const,
      };
    }),
    (row) => row.id,
    "auth.login_audit_log",
    "LOGIN_AUDIT_SOURCE_CONFLICT",
    blockers,
  );

  const targetsByKey = new Map(
    existing.flatMap((row) =>
      "action" in row ? [[auditIdentity(row), canonicalEvent(row)] as const] : [],
    ),
  );
  const targetIdOwners = new Map(existing.map((row) => [row.id, auditIdentity(row)]));
  const auditEvents = sourceEvents.flatMap((source) => {
    const target = targetsByKey.get(auditIdentity(source));
    if (target) {
      if (stableJson(target) === stableJson(source)) return [target];
      addBlocker(
        blockers,
        "LOGIN_AUDIT_TARGET_CONFLICT",
        "platform.product_audit_events",
        source.auditKey,
        "Append-only source and target audit events disagree",
      );
      return [];
    }
    if (targetIdOwners.has(source.id)) {
      addBlocker(
        blockers,
        "LOGIN_AUDIT_ID_CONFLICT",
        "platform.product_audit_events",
        source.id,
        "Audit ID already belongs to another target event",
      );
      return [];
    }
    return [source];
  });
  return {
    auditEvents: sortedBy(auditEvents, auditIdentity),
    blockers: sortedBy(blockers, (row) => `${row.code}:${row.source}:${row.sourceId}`),
  };
}

const auditIdentity = (row: ExistingAuditReference) => `${row.product}:${row.auditKey}`;
const canonicalEvent = (row: PlannedIdentityAuditEvent): PlannedIdentityAuditEvent => ({
  ...row,
  occurredAt: date(row.occurredAt, "occurredAt"),
  recordedAt: date(row.recordedAt, "recordedAt"),
  redactedPayload: JSON.parse(stableJson(row.redactedPayload)),
  privatePayload: JSON.parse(stableJson(row.privatePayload)),
  auditMetadata: JSON.parse(stableJson(row.auditMetadata)),
});
function compact(values: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(values).filter(([, value]) => value !== null));
}
