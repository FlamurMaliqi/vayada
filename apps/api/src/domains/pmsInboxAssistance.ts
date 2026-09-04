import { createHash } from "node:crypto";

import pg, { type QueryResult, type QueryResultRow } from "pg";
import {
  parseStaffPermissionOverrides,
  validateStaffPermissionOverrides,
} from "@vayada/backend-auth";

import type { PmsInboxAssistanceError, PmsInboxAssistancePort } from "./pmsInbox.js";

export type PmsInboxAssistanceClient = {
  query<T extends QueryResultRow = QueryResultRow>(
    text: string,
    values?: readonly unknown[],
  ): Promise<Pick<QueryResult<T>, "rows" | "rowCount">>;
  release(): void;
};

export type PmsInboxAssistancePool = {
  connect(): Promise<PmsInboxAssistanceClient>;
  end?(): Promise<void>;
};

export type PmsInboxAssistanceServiceInput =
  | {
      kind: "translate_message" | "translate_draft";
      sourceText: string;
      targetLanguage: string;
    }
  | {
      kind: "summarize" | "draft_reply";
      messages: readonly { direction: "inbound" | "outbound"; text: string }[];
    };

export type PmsInboxAssistanceServicePort = {
  assist(
    input: PmsInboxAssistanceServiceInput,
  ): Promise<{ ok: true; assistedText: string } | { ok: false }>;
  close?(): Promise<void>;
};

export type PgPmsInboxAssistancePort = PmsInboxAssistancePort & { close(): Promise<void> };

type Input = Parameters<PmsInboxAssistancePort["assist"]>[0];
type Result = Awaited<ReturnType<PmsInboxAssistancePort["assist"]>>;
type Success = Extract<Result, { ok: true }>;
type IdempotencyRow = {
  id: string;
  status: string;
  lockedUntil: Date | string | null;
  expiresAt: Date | string | null;
  requestFingerprintHash: string;
  responseStatusCode: number | null;
  responseBodyHash: string | null;
  responseResourceProduct: string | null;
  responseResourceType: string | null;
  responseResourceId: string | null;
  idempotencyMetadata: unknown;
};
type ScopeRow = {
  propertyAccessMode: string;
  roleKey: string;
  permissionOverrides: unknown;
};
type PermissionRow = { permissionKey: string };
type MessageRow = { direction: "inbound" | "outbound"; text: string | null };
type AssistanceResultRow = {
  propertyId: string;
  threadId: string;
  kind: string;
  assistedText: string;
  basedThroughMessageId: string | null;
};

const OPERATION = "pms.inbox.assist";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const LANGUAGE = /^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8}){0,3}$/;
const MAX_TEXT_LENGTH = 20_000;

export function createPgPmsInboxAssistancePort(config: {
  connectionString: string;
  service: PmsInboxAssistanceServicePort;
  pool?: PmsInboxAssistancePool;
  max?: number;
  now?: () => Date;
}): PgPmsInboxAssistancePort {
  if (!config.pool && !config.connectionString.trim())
    throw new Error("PMS Inbox assistance connectionString must not be empty");
  const ownsPool = !config.pool;
  const pool: PmsInboxAssistancePool =
    config.pool ?? new pg.Pool({ connectionString: config.connectionString, max: config.max });
  const now = config.now ?? (() => new Date());
  let closed = false;

  return {
    async assist(rawInput) {
      const input = normalizeInput(rawInput);
      if (!input) return failure("validation_failed", "Inbox assistance request is invalid.");
      const acceptedAt = acceptedInstant(now);
      const keyHash = sha256(input.idempotencyKey);
      const fingerprint = requestFingerprint(input);
      const prepared = await prepare(pool, input, keyHash, fingerprint, acceptedAt);
      if (prepared.type === "result") return prepared.result;

      let result: Result;
      try {
        const serviceResult = await config.service.assist(prepared.serviceInput);
        result = validServiceResult(serviceResult)
          ? {
              ok: true,
              value: {
                propertyId: input.propertyId,
                threadId: input.threadId,
                kind: input.kind,
                assistedText: serviceResult.assistedText,
                attribution: "ai_assisted",
                reviewRequired: true,
                basedThroughMessageId: "throughMessageId" in input ? input.throughMessageId : null,
              },
            }
          : failure("assistance_unavailable", "Inbox assistance is temporarily unavailable.");
      } catch {
        result = failure("assistance_unavailable", "Inbox assistance is temporarily unavailable.");
      }

      return finalize(
        pool,
        input,
        prepared.idempotencyId,
        keyHash,
        fingerprint,
        result,
        acceptedInstant(now),
      );
    },

    async close() {
      if (closed) return;
      const closures: Promise<unknown>[] = [Promise.resolve().then(() => config.service.close?.())];
      if (ownsPool)
        closures.push(
          Promise.resolve().then(() => {
            if (!pool.end) throw new Error("Owned PMS Inbox assistance pool cannot be closed");
            return pool.end();
          }),
        );
      const results = await Promise.allSettled(closures);
      closed = true;
      const failure = results.find(
        (result): result is PromiseRejectedResult => result.status === "rejected",
      );
      if (failure) throw failure.reason;
    },
  };
}

async function prepare(
  pool: PmsInboxAssistancePool,
  input: Input,
  keyHash: string,
  fingerprint: string,
  acceptedAt: Date,
): Promise<
  | { type: "result"; result: Result }
  | { type: "execute"; idempotencyId: string; serviceInput: PmsInboxAssistanceServiceInput }
> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    if (!(await lockActorScope(client, input, acceptedAt)))
      throw new Error("PMS Inbox assistance actor scope is unavailable");
    const replay = await findReplay(client, input, keyHash, fingerprint, acceptedAt);
    if (replay.type === "result")
      return { type: "result", result: await finishReplay(client, replay) };
    const idempotencyId = await reserveIdempotency(client, input, keyHash, fingerprint, acceptedAt);
    if (!idempotencyId) {
      const concurrent = await findReplay(client, input, keyHash, fingerprint, acceptedAt);
      if (concurrent.type === "result")
        return { type: "result", result: await finishReplay(client, concurrent) };
      return {
        type: "result",
        result: await rollbackResult(
          client,
          failure("idempotency_conflict", "This Inbox assistance request is in progress."),
        ),
      };
    }
    const serviceInput = await loadServiceInput(client, input);
    if (!serviceInput.ok) {
      await completeIdempotency(client, idempotencyId, serviceInput, null, acceptedAt);
      await client.query("COMMIT");
      return { type: "result", result: serviceInput };
    }
    await client.query("COMMIT");
    return { type: "execute", idempotencyId, serviceInput: serviceInput.value };
  } catch {
    await rollbackQuietly(client);
    throw new Error("PMS Inbox assistance preparation failed");
  } finally {
    client.release();
  }
}

async function finalize(
  pool: PmsInboxAssistancePool,
  input: Input,
  idempotencyId: string,
  keyHash: string,
  fingerprint: string,
  result: Result,
  acceptedAt: Date,
): Promise<Result> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    if (!(await lockActorScope(client, input, acceptedAt)))
      throw new Error("PMS Inbox assistance actor scope changed before completion");
    const reserved = await client.query(
      `SELECT 1 FROM platform.idempotency_keys
       WHERE id = $1::uuid AND operation_scope = 'pms' AND operation = $2
         AND tenant_scope = 'property' AND property_id = $3::uuid
         AND status = 'in_progress' AND request_fingerprint_hash = $4
       FOR UPDATE`,
      [idempotencyId, OPERATION, input.propertyId, fingerprint],
    );
    if (!reserved.rows[0]) throw new Error("PMS Inbox assistance reservation was lost");
    const assistanceResultId = result.ok
      ? await storeAssistanceResult(client, input, result, idempotencyId, acceptedAt)
      : null;
    await insertEvidence(client, input, result, idempotencyId, keyHash, acceptedAt);
    await completeIdempotency(client, idempotencyId, result, assistanceResultId, acceptedAt);
    await client.query("COMMIT");
    return result;
  } catch {
    await rollbackQuietly(client);
    throw new Error("PMS Inbox assistance completion failed");
  } finally {
    client.release();
  }
}

function normalizeInput(input: Input): Input | null {
  if (
    !UUID.test(input.propertyId) ||
    !UUID.test(input.threadId) ||
    !UUID.test(input.organizationId) ||
    !UUID.test(input.actorUserId) ||
    !UUID.test(input.actorMembershipId) ||
    !input.idempotencyKey.trim() ||
    input.idempotencyKey.length > 200 ||
    !input.audit.requestId.trim() ||
    !input.audit.correlationId.trim() ||
    !validInstant(input.audit.requestedAt)
  )
    return null;
  const base = {
    propertyId: input.propertyId,
    threadId: input.threadId,
    organizationId: input.organizationId,
    actorUserId: input.actorUserId,
    actorMembershipId: input.actorMembershipId,
    idempotencyKey: input.idempotencyKey.trim(),
    audit: input.audit,
  };
  if (!("throughMessageId" in input)) {
    const targetLanguage = input.targetLanguage.trim();
    return input.sourceText.trim() &&
      input.sourceText.length <= MAX_TEXT_LENGTH &&
      LANGUAGE.test(targetLanguage)
      ? { ...base, kind: input.kind, sourceText: input.sourceText, targetLanguage }
      : null;
  }
  return UUID.test(input.throughMessageId)
    ? { ...base, kind: input.kind, throughMessageId: input.throughMessageId }
    : null;
}

async function loadServiceInput(
  client: PmsInboxAssistanceClient,
  input: Input,
): Promise<{ ok: true; value: PmsInboxAssistanceServiceInput } | Extract<Result, { ok: false }>> {
  const thread = await client.query(
    `SELECT 1 FROM pms.message_threads
     WHERE property_id = $1::uuid AND id = $2::uuid
     FOR SHARE`,
    [input.propertyId, input.threadId],
  );
  if (!thread.rows[0]) return failure("thread_not_found", "Inbox thread was not found.");
  if (!("throughMessageId" in input))
    return {
      ok: true,
      value: {
        kind: input.kind,
        sourceText: input.sourceText,
        targetLanguage: input.targetLanguage,
      },
    };
  const messages = await client.query<MessageRow>(
    `WITH boundary AS (
       SELECT sent_at, id
       FROM pms.messages
       WHERE property_id = $1::uuid AND thread_id = $2::uuid AND id = $3::uuid
     ), recent AS (
       SELECT message.direction, LEFT(message.body, 4000) AS text,
              message.sent_at, message.id
       FROM pms.messages message, boundary
       WHERE message.property_id = $1::uuid AND message.thread_id = $2::uuid
         AND (message.sent_at, message.id) <= (boundary.sent_at, boundary.id)
       ORDER BY message.sent_at DESC, message.id DESC
       LIMIT 50
     )
     SELECT direction, text FROM recent ORDER BY sent_at, id`,
    [input.propertyId, input.threadId, input.throughMessageId],
  );
  const context = messages.rows.flatMap((message) => {
    const text = message.text?.trim();
    return text ? [{ direction: message.direction, text }] : [];
  });
  if (!context.length)
    return failure("validation_failed", "Inbox assistance message boundary has no available text.");
  return { ok: true, value: { kind: input.kind, messages: context } };
}

async function lockActorScope(
  client: PmsInboxAssistanceClient,
  input: Input,
  acceptedAt: Date,
): Promise<boolean> {
  const scope = await client.query<ScopeRow>(
    `SELECT membership.property_access_mode AS "propertyAccessMode",
            membership.role_key AS "roleKey",
            membership.permission_overrides AS "permissionOverrides"
     FROM hotel_catalog.properties property
     JOIN identity.organizations organization
       ON organization.id = $1::uuid AND organization.kind = 'hotel_group'
      AND organization.status = 'active'
     JOIN identity.organization_resource_links resource
       ON resource.organization_id = organization.id
      AND resource.product = 'pms' AND resource.resource_type = 'pms_property'
      AND resource.resource_id = property.id::text
      AND resource.relationship IN ('owner', 'operator', 'front_desk')
      AND resource.status = 'active'
     JOIN identity.users actor ON actor.id = $3::uuid AND actor.status = 'active'
     JOIN identity.organization_memberships membership
       ON membership.id = $4::uuid AND membership.organization_id = organization.id
      AND membership.user_id = actor.id AND membership.status = 'active'
     WHERE property.id = $2::uuid
       AND (membership.property_access_mode = 'all' OR EXISTS (
         SELECT 1 FROM identity.membership_property_assignments assignment
         WHERE assignment.membership_id = membership.id AND assignment.property_id = property.id
       ))
     FOR SHARE OF property, organization, resource, actor, membership`,
    [input.organizationId, input.propertyId, input.actorUserId, input.actorMembershipId],
  );
  const actor = scope.rows[0];
  if (!actor) return false;
  if (actor.propertyAccessMode === "assigned") {
    const assignment = await client.query(
      `SELECT 1 FROM identity.membership_property_assignments
       WHERE membership_id = $1::uuid AND property_id = $2::uuid FOR SHARE`,
      [input.actorMembershipId, input.propertyId],
    );
    if (!assignment.rows[0]) return false;
  }
  const permissionRows = await client.query<PermissionRow>(
    `SELECT permission_key AS "permissionKey"
     FROM identity.role_permission_grants
     WHERE organization_kind = 'hotel_group' AND role_key = $1
     FOR SHARE`,
    [actor.roleKey],
  );
  const rolePermissions = permissionRows.rows.map((row) => row.permissionKey);
  const effectivePermissions = new Set(rolePermissions);
  if (actor.permissionOverrides !== null && actor.permissionOverrides !== undefined) {
    const overrides = parseStaffPermissionOverrides(actor.permissionOverrides);
    if (
      !overrides ||
      validateStaffPermissionOverrides({
        roleKey: actor.roleKey,
        rolePermissions,
        permissionOverrides: overrides,
      }).length > 0
    )
      return false;
    for (const permission of overrides.grant) effectivePermissions.add(permission);
    for (const permission of overrides.deny) effectivePermissions.delete(permission);
  }
  if (!effectivePermissions.has("pms.inbox.read") || !effectivePermissions.has("pms.inbox.reply"))
    return false;
  const entitlements = await client.query<{
    status: string;
    startsAt: Date | string | null;
    expiresAt: Date | string | null;
  }>(
    `SELECT status, starts_at AS "startsAt", expires_at AS "expiresAt"
     FROM identity.product_entitlements
     WHERE organization_id = $1::uuid AND product = 'pms'
       AND entitlement_key = 'property-management'
       AND (resource_product IS NULL OR (
         resource_product = 'pms' AND resource_type = 'pms_property'
         AND resource_id = $2::uuid::text
       ))
     FOR SHARE`,
    [input.organizationId, input.propertyId],
  );
  const applicable = entitlements.rows.filter(
    (row) =>
      (!row.startsAt || new Date(row.startsAt) <= acceptedAt) &&
      (!row.expiresAt || new Date(row.expiresAt) > acceptedAt),
  );
  return (
    !applicable.some((row) => row.status === "suspended") &&
    applicable.some((row) => row.status === "active")
  );
}

async function findReplay(
  client: PmsInboxAssistanceClient,
  input: Input,
  keyHash: string,
  fingerprint: string,
  acceptedAt: Date,
): Promise<
  { type: "none" } | { type: "expired" } | { type: "result"; result: Result; commit?: true }
> {
  const query = await client.query<IdempotencyRow>(
    `SELECT id::text AS id, status, locked_until AS "lockedUntil",
            expires_at AS "expiresAt",
            request_fingerprint_hash AS "requestFingerprintHash",
            response_status_code AS "responseStatusCode", response_body_hash AS "responseBodyHash",
            response_resource_product AS "responseResourceProduct",
            response_resource_type AS "responseResourceType",
            response_resource_id AS "responseResourceId",
            idempotency_metadata AS "idempotencyMetadata"
     FROM platform.idempotency_keys
     WHERE operation_scope = 'pms' AND operation = $1 AND key_hash = $2
       AND tenant_scope = 'property' AND organization_id IS NULL AND property_id = $3::uuid
     FOR UPDATE`,
    [OPERATION, keyHash, input.propertyId],
  );
  const row = query.rows[0];
  if (!row) return { type: "none" };
  if (row.requestFingerprintHash !== fingerprint)
    return {
      type: "result",
      result: failure(
        "idempotency_conflict",
        "Idempotency key was used for a different Inbox assistance request.",
      ),
    };
  if (row.status === "in_progress")
    return row.lockedUntil && new Date(row.lockedUntil) <= acceptedAt
      ? { type: "expired" }
      : {
          type: "result",
          result: failure("idempotency_conflict", "This Inbox assistance request is in progress."),
        };
  if (row.status !== "completed")
    throw new Error("PMS Inbox assistance idempotency state is invalid");
  if (!row.expiresAt) throw new Error("PMS Inbox assistance expiry is missing");
  if (new Date(row.expiresAt) <= acceptedAt) {
    const expired = failure(
      "validation_failed",
      "Inbox assistance result has expired. Retry with a new idempotency key.",
    );
    await expireReplay(client, row.id, input.propertyId, expired, acceptedAt);
    return { type: "result", result: expired, commit: true };
  }
  const result = await parseStoredResult(client, row.idempotencyMetadata, input, acceptedAt);
  if (
    !result ||
    row.responseStatusCode !== responseStatus(result) ||
    row.responseBodyHash !== sha256(stableJson(result)) ||
    (result.ok &&
      (row.responseResourceProduct !== "pms" ||
        row.responseResourceType !== "message_thread" ||
        row.responseResourceId !== input.threadId))
  )
    throw new Error("PMS Inbox assistance replay evidence is invalid");
  return { type: "result", result };
}

async function expireReplay(
  client: PmsInboxAssistanceClient,
  idempotencyId: string,
  propertyId: string,
  result: Extract<Result, { ok: false }>,
  acceptedAt: Date,
): Promise<void> {
  await client.query(
    `UPDATE pms.message_assistance_results
     SET assisted_text = NULL, purged_at = $3::timestamptz
     WHERE property_id = $1::uuid AND idempotency_key_id = $2::uuid
       AND purged_at IS NULL AND pii_retention_until <= $3::timestamptz`,
    [propertyId, idempotencyId, acceptedAt],
  );
  const expired = await client.query(
    `UPDATE platform.idempotency_keys
     SET response_status_code = $3, response_body_hash = $4,
         response_resource_product = NULL, response_resource_type = NULL,
         response_resource_id = NULL, last_seen_at = $5::timestamptz,
         idempotency_metadata =
           ((idempotency_metadata - 'assistanceResultId') - 'result')
           || jsonb_build_object('result', $6::jsonb)
     WHERE id = $1::uuid AND property_id = $2::uuid AND status = 'completed'`,
    [
      idempotencyId,
      propertyId,
      responseStatus(result),
      sha256(stableJson(result)),
      acceptedAt,
      JSON.stringify(result),
    ],
  );
  if ((expired.rowCount ?? 0) !== 1)
    throw new Error("PMS Inbox assistance expiry was not recorded once");
}

async function reserveIdempotency(
  client: PmsInboxAssistanceClient,
  input: Input,
  keyHash: string,
  fingerprint: string,
  acceptedAt: Date,
): Promise<string | null> {
  const result = await client.query<{ id: string }>(
    `INSERT INTO platform.idempotency_keys
       (operation_scope, operation, key_hash, request_fingerprint_hash, status,
        tenant_scope, property_id, correlation_id, first_seen_at, last_seen_at,
        locked_until, expires_at, idempotency_metadata)
     VALUES ('pms', $1, $2, $3, 'in_progress', 'property', $4::uuid, $5,
             $6::timestamptz, $6::timestamptz, $6::timestamptz + interval '5 minutes',
             $6::timestamptz + interval '30 days', $7::jsonb)
     ON CONFLICT (operation_scope, operation, key_hash, scope_key) DO UPDATE
       SET correlation_id = EXCLUDED.correlation_id,
           last_seen_at = EXCLUDED.last_seen_at,
           locked_until = EXCLUDED.locked_until,
           idempotency_metadata = EXCLUDED.idempotency_metadata
       WHERE platform.idempotency_keys.status = 'in_progress'
         AND platform.idempotency_keys.locked_until <= EXCLUDED.first_seen_at
         AND platform.idempotency_keys.request_fingerprint_hash = EXCLUDED.request_fingerprint_hash
     RETURNING id::text AS id`,
    [
      OPERATION,
      keyHash,
      fingerprint,
      input.propertyId,
      input.audit.correlationId,
      acceptedAt,
      JSON.stringify({ operation: OPERATION, requestId: input.audit.requestId }),
    ],
  );
  return result.rows[0]?.id ?? null;
}

async function storeAssistanceResult(
  client: PmsInboxAssistanceClient,
  input: Input,
  result: Success,
  idempotencyId: string,
  acceptedAt: Date,
): Promise<string> {
  const stored = await client.query<{ id: string }>(
    `INSERT INTO pms.message_assistance_results
       (property_id, thread_id, idempotency_key_id, kind, based_through_message_id,
        assisted_text, created_at, pii_retention_until)
     VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5::uuid, $6,
             $7::timestamptz, $7::timestamptz + interval '30 days')
     RETURNING id::text AS id`,
    [
      input.propertyId,
      input.threadId,
      idempotencyId,
      input.kind,
      "throughMessageId" in input ? input.throughMessageId : null,
      result.value.assistedText,
      acceptedAt,
    ],
  );
  const id = stored.rows[0]?.id;
  if (!id) throw new Error("PMS Inbox assistance result was not stored");
  return id;
}

async function insertEvidence(
  client: PmsInboxAssistanceClient,
  input: Input,
  result: Result,
  idempotencyId: string,
  keyHash: string,
  acceptedAt: Date,
): Promise<void> {
  const outcome = result.ok ? "assisted" : "unavailable";
  const boundary = "throughMessageId" in input ? input.throughMessageId : null;
  const payload = {
    propertyId: input.propertyId,
    threadId: input.threadId,
    kind: input.kind,
    basedThroughMessageId: boundary,
    outcome,
  };
  const eventKey = `${OPERATION}:thread:${input.threadId}:key:${keyHash}:v1`;
  const event = await client.query<{ id: string }>(
    `INSERT INTO platform.domain_events
       (source_system, event_key, event_type, event_version, occurred_at, event_status,
        tenant_scope, property_id, resource_product, resource_type, resource_id,
        actor_type, actor_user_id, correlation_id, causation_id, idempotency_key_hash,
        payload, event_metadata, privacy_scope)
     VALUES ('pms', $1, $2, 1, $3::timestamptz, 'recorded', 'property', $4::uuid,
             'pms', 'message_thread', $5::text, 'user', $6::uuid, $7, $8, $9,
             $10::jsonb, $11::jsonb, 'internal')
     RETURNING id::text AS id`,
    [
      eventKey,
      `${OPERATION}.${result.ok ? "generated" : "unavailable"}`,
      acceptedAt,
      input.propertyId,
      input.threadId,
      input.actorUserId,
      input.audit.correlationId,
      input.audit.requestId,
      keyHash,
      JSON.stringify(payload),
      JSON.stringify({ contractVersion: "native-guest-inbox.v2" }),
    ],
  );
  const eventId = event.rows[0]?.id;
  if (!eventId) throw new Error("PMS Inbox assistance event was not recorded");
  await client.query(
    `INSERT INTO platform.product_audit_events
       (audit_key, product, action, occurred_at, tenant_scope, property_id, actor_type,
        actor_user_id, target_resource_product, target_resource_type, target_resource_id,
        domain_event_id, idempotency_key_id, correlation_id, causation_id,
        redacted_payload, audit_metadata, retention_class, privacy_scope)
     VALUES ($1, 'pms', $2, $3::timestamptz, 'property', $4::uuid, 'user', $5::uuid,
             'pms', 'message_thread', $6::text, $7::uuid, $8::uuid, $9, $10,
             $11::jsonb, $12::jsonb, 'standard', 'internal')`,
    [
      eventKey,
      OPERATION,
      acceptedAt,
      input.propertyId,
      input.actorUserId,
      input.threadId,
      eventId,
      idempotencyId,
      input.audit.correlationId,
      input.audit.requestId,
      JSON.stringify(payload),
      JSON.stringify({
        contractVersion: "native-guest-inbox.v2",
        actorMembershipId: input.actorMembershipId,
      }),
    ],
  );
}

async function completeIdempotency(
  client: PmsInboxAssistanceClient,
  idempotencyId: string,
  result: Result,
  assistanceResultId: string | null,
  acceptedAt: Date,
): Promise<void> {
  const completed = await client.query(
    `UPDATE platform.idempotency_keys
     SET status = 'completed', response_status_code = $2, response_body_hash = $3,
         response_resource_product = $4, response_resource_type = $5,
         response_resource_id = $6, last_seen_at = $7::timestamptz,
         locked_until = NULL, completed_at = $7::timestamptz,
         expires_at = $7::timestamptz + interval '30 days',
         idempotency_metadata = idempotency_metadata || $8::jsonb
     WHERE id = $1::uuid AND status = 'in_progress'`,
    [
      idempotencyId,
      responseStatus(result),
      sha256(stableJson(result)),
      result.ok ? "pms" : null,
      result.ok ? "message_thread" : null,
      result.ok ? result.value.threadId : null,
      acceptedAt,
      JSON.stringify(result.ok ? { assistanceResultId } : { result }),
    ],
  );
  if ((completed.rowCount ?? 0) !== 1)
    throw new Error("PMS Inbox assistance idempotency was not completed once");
}

async function parseStoredResult(
  client: PmsInboxAssistanceClient,
  value: unknown,
  input: Input,
  acceptedAt: Date,
): Promise<Result | null> {
  const metadata = record(value);
  const root = record(metadata?.["result"]);
  const error = record(root?.["error"]);
  if (root?.["ok"] === false && error) {
    const code = String(error["code"]);
    if (
      ![
        "validation_failed",
        "thread_not_found",
        "idempotency_conflict",
        "assistance_unavailable",
      ].includes(code) ||
      typeof error["message"] !== "string"
    )
      return null;
    return { ok: false, error: error as PmsInboxAssistanceError };
  }
  const assistanceResultId = metadata?.["assistanceResultId"];
  if (typeof assistanceResultId !== "string" || !UUID.test(assistanceResultId)) return null;
  const query = await client.query<AssistanceResultRow>(
    `SELECT property_id::text AS "propertyId", thread_id::text AS "threadId", kind,
            assisted_text AS "assistedText",
            based_through_message_id::text AS "basedThroughMessageId"
     FROM pms.message_assistance_results
     WHERE id = $1::uuid AND property_id = $2::uuid AND thread_id = $3::uuid
       AND purged_at IS NULL AND pii_retention_until > $4::timestamptz`,
    [assistanceResultId, input.propertyId, input.threadId, acceptedAt],
  );
  const stored = query.rows[0];
  const expectedBoundary = "throughMessageId" in input ? input.throughMessageId : null;
  if (
    !stored ||
    stored.propertyId !== input.propertyId ||
    stored.threadId !== input.threadId ||
    stored.kind !== input.kind ||
    typeof stored.assistedText !== "string" ||
    !stored.assistedText.trim() ||
    stored.assistedText.length > MAX_TEXT_LENGTH ||
    stored.basedThroughMessageId !== expectedBoundary
  )
    return null;
  return {
    ok: true,
    value: {
      propertyId: stored.propertyId,
      threadId: stored.threadId,
      kind: input.kind,
      assistedText: stored.assistedText,
      attribution: "ai_assisted",
      reviewRequired: true,
      basedThroughMessageId: stored.basedThroughMessageId,
    },
  };
}

function requestFingerprint(input: Input): string {
  return sha256(
    stableJson(
      !("throughMessageId" in input)
        ? {
            operation: OPERATION,
            propertyId: input.propertyId,
            threadId: input.threadId,
            kind: input.kind,
            sourceTextHash: sha256(input.sourceText),
            targetLanguage: input.targetLanguage,
          }
        : {
            operation: OPERATION,
            propertyId: input.propertyId,
            threadId: input.threadId,
            kind: input.kind,
            throughMessageId: input.throughMessageId,
          },
    ),
  );
}

function validServiceResult(
  result: Awaited<ReturnType<PmsInboxAssistanceServicePort["assist"]>>,
): result is { ok: true; assistedText: string } {
  return (
    result.ok === true &&
    typeof result.assistedText === "string" &&
    Boolean(result.assistedText.trim()) &&
    result.assistedText.length <= MAX_TEXT_LENGTH
  );
}

function responseStatus(result: Result): number {
  if (result.ok) return 200;
  if (result.error.code === "thread_not_found") return 404;
  if (result.error.code === "idempotency_conflict") return 409;
  return result.error.code === "assistance_unavailable" ? 503 : 400;
}

function failure(
  code: PmsInboxAssistanceError["code"],
  message: string,
): Extract<Result, { ok: false }> {
  return { ok: false, error: { code, message } };
}

function acceptedInstant(now: () => Date): Date {
  const acceptedAt = now();
  if (!Number.isFinite(acceptedAt.getTime()))
    throw new Error("PMS Inbox assistance clock is invalid");
  return acceptedAt;
}

function validInstant(value: string): boolean {
  const time = Date.parse(value);
  return Number.isFinite(time) && new Date(time).toISOString() === value;
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson((value as Record<string, unknown>)[key])}`)
      .join(",")}}`;
  return JSON.stringify(value);
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

async function rollbackResult<T extends Result>(
  client: PmsInboxAssistanceClient,
  result: T,
): Promise<T> {
  await client.query("ROLLBACK");
  return result;
}

async function finishReplay<T extends Result>(
  client: PmsInboxAssistanceClient,
  replay: { result: T; commit?: true },
): Promise<T> {
  await client.query(replay.commit ? "COMMIT" : "ROLLBACK");
  return replay.result;
}

async function rollbackQuietly(client: PmsInboxAssistanceClient): Promise<void> {
  try {
    await client.query("ROLLBACK");
  } catch {
    // Preserve the original failure.
  }
}
