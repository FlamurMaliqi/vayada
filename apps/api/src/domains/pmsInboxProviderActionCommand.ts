import { createHash } from "node:crypto";

import pg, { type QueryResult, type QueryResultRow } from "pg";
import {
  parseStaffPermissionOverrides,
  validateStaffPermissionOverrides,
} from "@vayada/backend-auth";

import type { PmsInboxProviderActionError, PmsInboxProviderActionPort } from "./pmsInbox.js";

export type PmsInboxProviderActionClient = {
  query<T extends QueryResultRow = QueryResultRow>(
    text: string,
    values?: readonly unknown[],
  ): Promise<Pick<QueryResult<T>, "rows" | "rowCount">>;
  release(): void;
};

export type PmsInboxProviderActionPool = {
  connect(): Promise<PmsInboxProviderActionClient>;
  end?(): Promise<void>;
};

export type PgPmsInboxProviderActionPort = PmsInboxProviderActionPort & {
  close(): Promise<void>;
};

type Input = Parameters<PmsInboxProviderActionPort["noReplyNeeded"]>[0];
type Result = Awaited<ReturnType<PmsInboxProviderActionPort["noReplyNeeded"]>>;
type Success = Extract<Result, { ok: true }>;
type IdempotencyRow = {
  status: string;
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
type ThreadRow = {
  sourceThreadId: string;
  providerCapable: boolean;
};
type ConnectionRow = { connectionStatus: string; messagingAppInstalled: boolean };
type InsertedIdRow = { id: string };

const OPERATION = "pms.inbox.provider.no_reply_needed";
const JOB_TYPE = "pms.inbox.provider-action.deliver";
const ACTION = "booking_com_no_reply_needed";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function createPgPmsInboxProviderActionPort(config: {
  connectionString: string;
  pool?: PmsInboxProviderActionPool;
  max?: number;
  now?: () => Date;
}): PgPmsInboxProviderActionPort {
  if (!config.pool && !config.connectionString.trim())
    throw new Error("PMS Inbox provider-action connectionString must not be empty");
  const ownsPool = !config.pool;
  const pool: PmsInboxProviderActionPool =
    config.pool ?? new pg.Pool({ connectionString: config.connectionString, max: config.max });
  const now = config.now ?? (() => new Date());
  let closed = false;

  return {
    async noReplyNeeded(rawInput) {
      const input = normalizeInput(rawInput);
      if (!input) return failure("validation_failed", "Inbox provider-action request is invalid.");
      const acceptedAt = now();
      if (!Number.isFinite(acceptedAt.getTime()))
        throw new Error("PMS Inbox provider-action clock is invalid");
      const keyHash = sha256(input.idempotencyKey);
      const fingerprint = sha256(
        stableJson({
          operation: OPERATION,
          propertyId: input.propertyId,
          threadId: input.threadId,
        }),
      );
      const client = await pool.connect();

      try {
        await client.query("BEGIN");
        if (!(await lockActorScope(client, input, acceptedAt)))
          throw new Error("PMS Inbox provider-action actor scope is unavailable");
        const replay = await findReplay(client, input, keyHash, fingerprint);
        if (replay) return await rollbackResult(client, replay);
        const idempotencyId = await reserveIdempotency(
          client,
          input,
          keyHash,
          fingerprint,
          acceptedAt,
        );
        if (!idempotencyId) {
          const concurrent = await findReplay(client, input, keyHash, fingerprint);
          return await rollbackResult(
            client,
            concurrent ??
              failure("idempotency_conflict", "This Inbox provider action is already in progress."),
          );
        }

        const thread = await lockThread(client, input.propertyId, input.threadId);
        if (!thread)
          return await commitResult(
            client,
            idempotencyId,
            failure("thread_not_found", "Inbox thread was not found."),
            acceptedAt,
          );
        if (!thread.providerCapable || !(await lockProviderCapability(client, input.propertyId)))
          return await commitResult(
            client,
            idempotencyId,
            failure(
              "provider_action_unavailable",
              "Booking.com no reply needed is unavailable for this conversation.",
            ),
            acceptedAt,
          );

        const providerIdempotencyReference = `vayada-no-reply-${sha256(
          `${input.propertyId}:${input.threadId}:${keyHash}`,
        )}`;
        const eventId = await insertAcceptedEvent(
          client,
          input,
          keyHash,
          providerIdempotencyReference,
          acceptedAt,
        );
        await insertAudit(client, input, eventId, idempotencyId, keyHash, acceptedAt);
        const outboxId = await insertOutbox(
          client,
          input,
          eventId,
          keyHash,
          thread.sourceThreadId,
          providerIdempotencyReference,
          acceptedAt,
        );
        const jobId = await insertJob(
          client,
          input,
          eventId,
          outboxId,
          keyHash,
          thread.sourceThreadId,
          providerIdempotencyReference,
          acceptedAt,
        );
        return await commitResult(
          client,
          idempotencyId,
          {
            ok: true,
            value: {
              propertyId: input.propertyId,
              threadId: input.threadId,
              action: ACTION,
              jobId,
              acceptedAt: acceptedAt.toISOString(),
              attentionStateChanged: false,
            },
          },
          acceptedAt,
        );
      } catch {
        await rollbackQuietly(client);
        throw new Error("PMS Inbox provider-action command failed");
      } finally {
        releaseQuietly(client);
      }
    },

    async close() {
      if (!ownsPool || closed) return;
      if (!pool.end) throw new Error("Owned PMS Inbox provider-action pool cannot be closed");
      await pool.end();
      closed = true;
    },
  };
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
  return { ...input, idempotencyKey: input.idempotencyKey.trim() };
}

async function lockActorScope(
  client: PmsInboxProviderActionClient,
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
  if (!actor || !["all", "assigned"].includes(actor.propertyAccessMode)) return false;
  if (actor.propertyAccessMode === "assigned") {
    const assignment = await client.query(
      `SELECT 1 FROM identity.membership_property_assignments
       WHERE membership_id = $1::uuid AND property_id = $2::uuid
       FOR SHARE`,
      [input.actorMembershipId, input.propertyId],
    );
    if (!assignment.rows[0]) return false;
  }
  const permissions = await client.query<PermissionRow>(
    `SELECT permission_key AS "permissionKey"
     FROM identity.role_permission_grants
     WHERE organization_kind = 'hotel_group' AND role_key = $1
     FOR SHARE`,
    [actor.roleKey],
  );
  const rolePermissions = permissions.rows.map((row) => row.permissionKey);
  const effective = new Set(rolePermissions);
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
    for (const permission of overrides.grant) effective.add(permission);
    for (const permission of overrides.deny) effective.delete(permission);
  }
  if (!effective.has("pms.inbox.read") || !effective.has("pms.inbox.reply")) return false;
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
  client: PmsInboxProviderActionClient,
  input: Input,
  keyHash: string,
  fingerprint: string,
): Promise<Result | null> {
  const query = await client.query<IdempotencyRow>(
    `SELECT status, request_fingerprint_hash AS "requestFingerprintHash",
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
  if (!row) return null;
  if (row.requestFingerprintHash !== fingerprint)
    return failure(
      "idempotency_conflict",
      "Idempotency key was used for a different Inbox provider action.",
    );
  if (row.status !== "completed")
    return failure("idempotency_conflict", "This Inbox provider action is already in progress.");
  const result = parseStoredResult(record(row.idempotencyMetadata)?.["result"]);
  if (
    !result ||
    row.responseStatusCode !== responseStatus(result) ||
    row.responseBodyHash !== sha256(stableJson(result)) ||
    (result.ok &&
      (row.responseResourceProduct !== "platform" ||
        row.responseResourceType !== "job" ||
        row.responseResourceId !== result.value.jobId))
  )
    throw new Error("PMS Inbox provider-action replay evidence is invalid");
  return result;
}

async function reserveIdempotency(
  client: PmsInboxProviderActionClient,
  input: Input,
  keyHash: string,
  fingerprint: string,
  acceptedAt: Date,
): Promise<string | null> {
  const query = await client.query<InsertedIdRow>(
    `INSERT INTO platform.idempotency_keys
       (operation_scope, operation, key_hash, request_fingerprint_hash, status,
        tenant_scope, property_id, correlation_id, first_seen_at, last_seen_at,
        locked_until, expires_at, idempotency_metadata)
     VALUES ('pms', $1, $2, $3, 'in_progress', 'property', $4::uuid, $5,
             $6::timestamptz, $6::timestamptz, $6::timestamptz + interval '5 minutes',
             'infinity'::timestamptz, $7::jsonb)
     ON CONFLICT (operation_scope, operation, key_hash, scope_key) DO NOTHING
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
  return query.rows[0]?.id ?? null;
}

async function lockThread(
  client: PmsInboxProviderActionClient,
  propertyId: string,
  threadId: string,
): Promise<ThreadRow | null> {
  const query = await client.query<ThreadRow>(
    `SELECT thread.source_thread_id AS "sourceThreadId",
            (thread.source = 'channex'
             AND thread.delivery_channel = 'ota'
             AND lower(BTRIM(thread.provider_channel)) IN ('booking.com', 'booking_com', 'bookingcom')
             AND BTRIM(thread.source_thread_id) <> '') AS "providerCapable"
     FROM pms.message_threads thread
     WHERE thread.property_id = $1::uuid AND thread.id = $2::uuid
     FOR UPDATE OF thread`,
    [propertyId, threadId],
  );
  return query.rows[0] ?? null;
}

async function lockProviderCapability(
  client: PmsInboxProviderActionClient,
  propertyId: string,
): Promise<boolean> {
  const query = await client.query<ConnectionRow>(
    `SELECT connection_status AS "connectionStatus",
            messaging_app_installed AS "messagingAppInstalled"
     FROM pms.channel_connections
     WHERE property_id = $1::uuid AND provider = 'channex'
     FOR SHARE`,
    [propertyId],
  );
  const connection = query.rows[0];
  return Boolean(
    connection &&
    ["connected", "degraded"].includes(connection.connectionStatus) &&
    connection.messagingAppInstalled,
  );
}

async function insertAcceptedEvent(
  client: PmsInboxProviderActionClient,
  input: Input,
  keyHash: string,
  providerIdempotencyReference: string,
  acceptedAt: Date,
): Promise<string> {
  const query = await client.query<InsertedIdRow>(
    `INSERT INTO platform.domain_events
       (source_system, event_key, event_type, occurred_at, tenant_scope, property_id,
        resource_product, resource_type, resource_id, actor_type, actor_user_id,
        correlation_id, causation_id, idempotency_key_hash, payload, event_metadata, privacy_scope)
     VALUES ('pms', $1, 'pms.inbox.provider.no_reply_needed.accepted', $2::timestamptz,
             'property', $3::uuid, 'pms', 'message_thread', $4::text, 'user', $5::uuid,
             $6, $7, $8, $9::jsonb, $10::jsonb, 'internal')
     RETURNING id::text AS id`,
    [
      `pms.inbox.provider.no_reply_needed.accepted:thread:${input.threadId}:key:${keyHash}:v1`,
      acceptedAt,
      input.propertyId,
      input.threadId,
      input.actorUserId,
      input.audit.correlationId,
      input.audit.requestId,
      keyHash,
      JSON.stringify({
        propertyId: input.propertyId,
        threadId: input.threadId,
        action: ACTION,
        providerChannel: "booking.com",
      }),
      JSON.stringify({
        contractVersion: "native-guest-inbox.v2",
        provider: "channex",
        providerIdempotencyReferenceHash: sha256(providerIdempotencyReference),
      }),
    ],
  );
  const id = query.rows[0]?.id;
  if (!id) throw new Error("PMS Inbox provider-action event was not recorded");
  return id;
}

async function insertAudit(
  client: PmsInboxProviderActionClient,
  input: Input,
  eventId: string,
  idempotencyId: string,
  keyHash: string,
  acceptedAt: Date,
): Promise<void> {
  await client.query(
    `INSERT INTO platform.product_audit_events
       (audit_key, product, action, occurred_at, tenant_scope, property_id, actor_type,
        actor_user_id, target_resource_product, target_resource_type, target_resource_id,
        domain_event_id, idempotency_key_id, correlation_id, causation_id,
        redacted_payload, audit_metadata, retention_class, privacy_scope)
     VALUES ($1, 'pms', 'pms.inbox.provider.no_reply_needed.accepted', $2::timestamptz,
             'property', $3::uuid, 'user', $4::uuid, 'pms', 'message_thread', $5::text,
             $6::uuid, $7::uuid, $8, $9, $10::jsonb, $11::jsonb, 'standard', 'internal')`,
    [
      `pms.inbox.provider.no_reply_needed.accepted:thread:${input.threadId}:key:${keyHash}:v1`,
      acceptedAt,
      input.propertyId,
      input.actorUserId,
      input.threadId,
      eventId,
      idempotencyId,
      input.audit.correlationId,
      input.audit.requestId,
      JSON.stringify({ action: ACTION, providerChannel: "booking.com" }),
      JSON.stringify({
        contractVersion: "native-guest-inbox.v2",
        actorMembershipId: input.actorMembershipId,
      }),
    ],
  );
}

function deliveryPayload(
  input: Input,
  sourceThreadId: string,
  providerIdempotencyReference: string,
) {
  return {
    propertyId: input.propertyId,
    threadId: input.threadId,
    action: ACTION,
    provider: "channex",
    providerChannel: "booking.com",
    providerConversationId: sourceThreadId,
    providerIdempotencyReference,
  };
}

async function insertOutbox(
  client: PmsInboxProviderActionClient,
  input: Input,
  eventId: string,
  keyHash: string,
  sourceThreadId: string,
  providerIdempotencyReference: string,
  acceptedAt: Date,
): Promise<string> {
  const query = await client.query<InsertedIdRow>(
    `INSERT INTO platform.outbox_events
       (domain_event_id, outbox_key, destination, event_type, tenant_scope, property_id,
        resource_product, resource_type, resource_id, status, priority, max_attempts,
        available_at, correlation_id, idempotency_key_hash, payload, outbox_metadata,
        created_at, updated_at)
     VALUES ($1::uuid, $2, $3, $3, 'property', $4::uuid,
             'pms', 'message_thread', $5::text, 'pending', 0, 5, $6::timestamptz,
             $7, $8, $9::jsonb, $10::jsonb, $6::timestamptz, $6::timestamptz)
     RETURNING id::text AS id`,
    [
      eventId,
      `${JOB_TYPE}:thread:${input.threadId}:key:${keyHash}:v1`,
      JOB_TYPE,
      input.propertyId,
      input.threadId,
      acceptedAt,
      input.audit.correlationId,
      keyHash,
      JSON.stringify(deliveryPayload(input, sourceThreadId, providerIdempotencyReference)),
      JSON.stringify({
        contractVersion: "native-guest-inbox.v2",
        ambiguousOutcomePolicy: "hold_for_review",
      }),
    ],
  );
  const id = query.rows[0]?.id;
  if (!id) throw new Error("PMS Inbox provider-action outbox event was not recorded");
  return id;
}

async function insertJob(
  client: PmsInboxProviderActionClient,
  input: Input,
  eventId: string,
  outboxId: string,
  keyHash: string,
  sourceThreadId: string,
  providerIdempotencyReference: string,
  acceptedAt: Date,
): Promise<string> {
  const query = await client.query<InsertedIdRow>(
    `INSERT INTO platform.jobs
       (job_key, queue_name, job_type, source_domain_event_id, source_outbox_event_id,
        status, max_attempts, run_after, tenant_scope, property_id,
        resource_product, resource_type, resource_id, correlation_id,
        idempotency_key_hash, payload, job_metadata, created_at, updated_at)
     VALUES ($1, $2, $2, $3::uuid, $4::uuid, 'pending', 5, $5::timestamptz,
             'property', $6::uuid, 'pms', 'message_thread', $7::text, $8, $9,
             $10::jsonb, $11::jsonb, $5::timestamptz, $5::timestamptz)
     RETURNING id::text AS id`,
    [
      `${JOB_TYPE}:thread:${input.threadId}:key:${keyHash}:v1`,
      JOB_TYPE,
      eventId,
      outboxId,
      acceptedAt,
      input.propertyId,
      input.threadId,
      input.audit.correlationId,
      keyHash,
      JSON.stringify(deliveryPayload(input, sourceThreadId, providerIdempotencyReference)),
      JSON.stringify({
        contractVersion: "native-guest-inbox.v2",
        ambiguousOutcomePolicy: "hold_for_review",
        retryPolicy: "classified_failures_only",
      }),
    ],
  );
  const id = query.rows[0]?.id;
  if (!id) throw new Error("PMS Inbox provider-action job was not recorded");
  return id;
}

async function commitResult(
  client: PmsInboxProviderActionClient,
  idempotencyId: string,
  result: Result,
  acceptedAt: Date,
): Promise<Result> {
  const completed = await client.query(
    `UPDATE platform.idempotency_keys
     SET status = 'completed', response_status_code = $2, response_body_hash = $3,
         response_resource_product = $4, response_resource_type = $5,
         response_resource_id = $6, last_seen_at = $7::timestamptz,
         locked_until = NULL, completed_at = $7::timestamptz,
         idempotency_metadata = idempotency_metadata || jsonb_build_object('result', $8::jsonb)
     WHERE id = $1::uuid AND status = 'in_progress'`,
    [
      idempotencyId,
      responseStatus(result),
      sha256(stableJson(result)),
      result.ok ? "platform" : null,
      result.ok ? "job" : null,
      result.ok ? result.value.jobId : null,
      acceptedAt,
      JSON.stringify(result),
    ],
  );
  if ((completed.rowCount ?? 0) !== 1)
    throw new Error("PMS Inbox provider-action idempotency was not completed once");
  await client.query("COMMIT");
  return result;
}

function parseStoredResult(value: unknown): Result | null {
  const root = record(value);
  const error = record(root?.["error"]);
  if (root?.["ok"] === false && error) {
    const code = String(error["code"]);
    if (
      ![
        "validation_failed",
        "thread_not_found",
        "provider_action_unavailable",
        "idempotency_conflict",
      ].includes(code) ||
      typeof error["message"] !== "string"
    )
      return null;
    return { ok: false, error: error as PmsInboxProviderActionError };
  }
  const stored = record(root?.["value"]);
  if (
    root?.["ok"] !== true ||
    !stored ||
    typeof stored["propertyId"] !== "string" ||
    typeof stored["threadId"] !== "string" ||
    stored["action"] !== ACTION ||
    typeof stored["jobId"] !== "string" ||
    !UUID.test(stored["jobId"]) ||
    typeof stored["acceptedAt"] !== "string" ||
    !validInstant(stored["acceptedAt"]) ||
    stored["attentionStateChanged"] !== false
  )
    return null;
  return { ok: true, value: stored as Success["value"] };
}

function responseStatus(result: Result): number {
  if (result.ok) return 202;
  if (result.error.code === "thread_not_found") return 404;
  if (
    result.error.code === "provider_action_unavailable" ||
    result.error.code === "idempotency_conflict"
  )
    return 409;
  return 400;
}

function failure(code: PmsInboxProviderActionError["code"], message: string): Result {
  return { ok: false, error: { code, message } };
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
  client: PmsInboxProviderActionClient,
  result: T,
): Promise<T> {
  await client.query("ROLLBACK");
  return result;
}

async function rollbackQuietly(client: PmsInboxProviderActionClient): Promise<void> {
  try {
    await client.query("ROLLBACK");
  } catch {
    // Preserve the original failure.
  }
}

function releaseQuietly(client: PmsInboxProviderActionClient): void {
  try {
    client.release();
  } catch {
    // Preserve the command result.
  }
}
