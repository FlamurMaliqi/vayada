import { createHash } from "node:crypto";

import pg, { type QueryResult, type QueryResultRow } from "pg";

import type { PmsInboxMarkReadPort } from "./pmsInbox.js";

export type PmsInboxMarkReadCommandClient = {
  query<T extends QueryResultRow = QueryResultRow>(
    text: string,
    values?: readonly unknown[],
  ): Promise<Pick<QueryResult<T>, "rows" | "rowCount">>;
  release(): void;
};

export type PmsInboxMarkReadCommandPool = {
  connect(): Promise<PmsInboxMarkReadCommandClient>;
  end?(): Promise<void>;
};

export type PgPmsInboxMarkReadPort = PmsInboxMarkReadPort & { close(): Promise<void> };

type MarkReadInput = Parameters<PmsInboxMarkReadPort["markRead"]>[0];
type MarkReadResult = Awaited<ReturnType<PmsInboxMarkReadPort["markRead"]>>;
type MarkReadFailure = Extract<MarkReadResult, { ok: false }>;

type IdempotencyRow = {
  status: string;
  requestFingerprintHash: string;
  responseStatusCode: number | null;
  responseBodyHash: string | null;
  idempotencyMetadata: unknown;
};

type BoundarySnapshotRow = { boundaryExists: boolean; candidateMessageIds: string[] };
type BoundarySnapshot =
  | { status: "thread_not_found" }
  | { status: "invalid_boundary" }
  | { status: "ready"; candidateMessageIds: string[] };
type UnreadRow = { unreadCount: string | number };
type InsertedIdRow = { id: string };

const OPERATION = "pms.inbox.thread.mark_read";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function createPgPmsInboxMarkReadPort(config: {
  connectionString: string;
  pool?: PmsInboxMarkReadCommandPool;
  max?: number;
  now?: () => Date;
}): PgPmsInboxMarkReadPort {
  if (!config.pool && !config.connectionString.trim())
    throw new Error("PMS Inbox mark-read connectionString must not be empty");
  const ownsPool = !config.pool;
  const pool: PmsInboxMarkReadCommandPool =
    config.pool ?? new pg.Pool({ connectionString: config.connectionString, max: config.max });
  const now = config.now ?? (() => new Date());
  let closed = false;

  return {
    async markRead(rawInput) {
      const input = normalizeInput(rawInput);
      if (!input) return failure("validation_failed", "Mark-read payload is invalid.");
      const acceptedAt = now();
      if (!validDate(acceptedAt)) throw new Error("PMS Inbox mark-read clock is invalid");
      const keyHash = sha256(input.idempotencyKey);
      const requestFingerprintHash = sha256(markReadFingerprint(input));
      const client = await pool.connect();

      try {
        await client.query("BEGIN");
        if (!(await lockActorScope(client, input, acceptedAt)))
          throw new Error("PMS Inbox mark-read actor scope is unavailable");

        const replay = await findReplay(client, input, keyHash, requestFingerprintHash);
        if (replay) {
          await client.query("ROLLBACK");
          return replay;
        }

        const idempotencyId = await reserveIdempotency(
          client,
          input,
          keyHash,
          requestFingerprintHash,
          acceptedAt,
        );
        if (!idempotencyId) {
          const concurrentReplay = await findReplay(client, input, keyHash, requestFingerprintHash);
          await client.query("ROLLBACK");
          return (
            concurrentReplay ??
            failure("idempotency_conflict", "This mark-read command is already in progress.")
          );
        }

        const boundary = await captureBoundarySnapshot(client, input);
        if (boundary.status === "thread_not_found")
          return commitResult(
            client,
            idempotencyId,
            failure("thread_not_found", "Inbox thread was not found."),
            acceptedAt,
          );
        if (boundary.status === "invalid_boundary")
          return commitResult(
            client,
            idempotencyId,
            failure(
              "validation_failed",
              "Read-through message must be an inbound message in this thread.",
            ),
            acceptedAt,
          );

        if (!(await lockThread(client, input)))
          return commitResult(
            client,
            idempotencyId,
            failure("thread_not_found", "Inbox thread was not found."),
            acceptedAt,
          );

        const markedReadCount = await markMessagesRead(
          client,
          input,
          boundary.candidateMessageIds,
          acceptedAt,
        );
        const unreadCount = await refreshUnreadCount(client, input, acceptedAt);
        const domainEventId = await insertMarkedReadEvent(
          client,
          input,
          keyHash,
          unreadCount,
          markedReadCount,
          acceptedAt,
        );
        await insertMarkedReadAudit(
          client,
          input,
          idempotencyId,
          domainEventId,
          keyHash,
          unreadCount,
          markedReadCount,
          acceptedAt,
        );

        return commitResult(
          client,
          idempotencyId,
          {
            ok: true,
            value: {
              propertyId: input.propertyId,
              threadId: input.threadId,
              readThroughMessageId: input.readThroughMessageId,
              unreadCount,
            },
          },
          acceptedAt,
        );
      } catch {
        await rollbackQuietly(client);
        throw new Error("PMS Inbox mark-read command failed");
      } finally {
        releaseQuietly(client);
      }
    },

    async close() {
      if (!ownsPool || closed) return;
      if (!pool.end) throw new Error("Owned PMS Inbox mark-read pool cannot be closed");
      await pool.end();
      closed = true;
    },
  };
}

function normalizeInput(input: MarkReadInput): MarkReadInput | null {
  if (
    !UUID.test(input.propertyId) ||
    !UUID.test(input.threadId) ||
    !UUID.test(input.organizationId) ||
    !UUID.test(input.actorUserId) ||
    !UUID.test(input.actorMembershipId) ||
    !UUID.test(input.readThroughMessageId) ||
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
  client: PmsInboxMarkReadCommandClient,
  input: MarkReadInput,
  acceptedAt: Date,
): Promise<boolean> {
  const scope = await client.query(
    `SELECT 1
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
     JOIN identity.users actor
       ON actor.id = $3::uuid AND actor.status = 'active'
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
  if (!scope.rows[0]) return false;

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
  client: PmsInboxMarkReadCommandClient,
  input: MarkReadInput,
  keyHash: string,
  requestFingerprintHash: string,
): Promise<MarkReadResult | null> {
  const result = await client.query<IdempotencyRow>(
    `SELECT status, request_fingerprint_hash AS "requestFingerprintHash",
            response_status_code AS "responseStatusCode",
            response_body_hash AS "responseBodyHash",
            idempotency_metadata AS "idempotencyMetadata"
     FROM platform.idempotency_keys
     WHERE operation_scope = 'pms' AND operation = $1 AND key_hash = $2
       AND tenant_scope = 'property' AND organization_id IS NULL
       AND property_id = $3::uuid
     FOR UPDATE`,
    [OPERATION, keyHash, input.propertyId],
  );
  const row = result.rows[0];
  if (!row) return null;
  if (row.requestFingerprintHash !== requestFingerprintHash)
    return failure(
      "idempotency_conflict",
      "Idempotency key was already used for a different mark-read command.",
    );
  if (row.status !== "completed")
    return failure("idempotency_conflict", "This mark-read command is already in progress.");
  const replay = parseStoredResult(record(row.idempotencyMetadata)?.["result"]);
  if (
    !replay ||
    row.responseStatusCode !== responseStatus(replay) ||
    row.responseBodyHash !== sha256(stableJson(replay))
  )
    throw new Error("PMS Inbox mark-read replay evidence is invalid");
  return replay;
}

async function reserveIdempotency(
  client: PmsInboxMarkReadCommandClient,
  input: MarkReadInput,
  keyHash: string,
  requestFingerprintHash: string,
  acceptedAt: Date,
): Promise<string | null> {
  const result = await client.query<InsertedIdRow>(
    `INSERT INTO platform.idempotency_keys
       (operation_scope, operation, key_hash, request_fingerprint_hash, status,
        tenant_scope, property_id, correlation_id, first_seen_at, last_seen_at,
        locked_until, expires_at, idempotency_metadata)
     VALUES
       ('pms', $1, $2, $3, 'in_progress', 'property', $4::uuid, $5,
        $6::timestamptz, $6::timestamptz, $6::timestamptz + interval '5 minutes',
        'infinity'::timestamptz, $7::jsonb)
     ON CONFLICT (operation_scope, operation, key_hash, scope_key) DO NOTHING
     RETURNING id::text AS id`,
    [
      OPERATION,
      keyHash,
      requestFingerprintHash,
      input.propertyId,
      input.audit.correlationId,
      acceptedAt,
      JSON.stringify({ operation: OPERATION, requestId: input.audit.requestId }),
    ],
  );
  return result.rows[0]?.id ?? null;
}

async function lockThread(
  client: PmsInboxMarkReadCommandClient,
  input: MarkReadInput,
): Promise<boolean> {
  const result = await client.query(
    `SELECT 1 FROM pms.message_threads
     WHERE property_id = $1::uuid AND id = $2::uuid
     FOR UPDATE`,
    [input.propertyId, input.threadId],
  );
  return Boolean(result.rows[0]);
}

async function captureBoundarySnapshot(
  client: PmsInboxMarkReadCommandClient,
  input: MarkReadInput,
): Promise<BoundarySnapshot> {
  const result = await client.query<BoundarySnapshotRow>(
    `SELECT boundary.id IS NOT NULL AS "boundaryExists",
            COALESCE(candidates.ids, '{}'::uuid[])::text[] AS "candidateMessageIds"
     FROM pms.message_threads thread
     LEFT JOIN LATERAL (
       SELECT message.id, message.sent_at
       FROM pms.messages message
       WHERE message.property_id = thread.property_id AND message.thread_id = thread.id
         AND message.id = $3::uuid AND message.direction = 'inbound'
     ) boundary ON TRUE
     LEFT JOIN LATERAL (
       SELECT array_agg(candidate.id ORDER BY candidate.sent_at, candidate.id) AS ids
       FROM pms.messages candidate
       WHERE candidate.property_id = thread.property_id AND candidate.thread_id = thread.id
         AND candidate.direction = 'inbound'
         AND (candidate.sent_at < boundary.sent_at
           OR (candidate.sent_at = boundary.sent_at AND candidate.id <= boundary.id))
     ) candidates ON boundary.id IS NOT NULL
     WHERE thread.property_id = $1::uuid AND thread.id = $2::uuid`,
    [input.propertyId, input.threadId, input.readThroughMessageId],
  );
  const row = result.rows[0];
  if (!row) return { status: "thread_not_found" };
  if (!row.boundaryExists) return { status: "invalid_boundary" };
  if (!Array.isArray(row.candidateMessageIds) || row.candidateMessageIds.length === 0)
    throw new Error("PMS Inbox mark-read boundary snapshot is invalid");
  return { status: "ready", candidateMessageIds: row.candidateMessageIds };
}

async function markMessagesRead(
  client: PmsInboxMarkReadCommandClient,
  input: MarkReadInput,
  candidateMessageIds: readonly string[],
  acceptedAt: Date,
): Promise<number> {
  const result = await client.query(
    `UPDATE pms.messages
     SET read_at = $4::timestamptz
     WHERE property_id = $1::uuid AND thread_id = $2::uuid
       AND direction = 'inbound' AND read_at IS NULL
       AND id = ANY($3::uuid[])`,
    [input.propertyId, input.threadId, candidateMessageIds, acceptedAt],
  );
  return result.rowCount ?? 0;
}

async function refreshUnreadCount(
  client: PmsInboxMarkReadCommandClient,
  input: MarkReadInput,
  acceptedAt: Date,
): Promise<number> {
  const result = await client.query<UnreadRow>(
    `UPDATE pms.message_threads thread
     SET unread_count = unread.count, updated_at = $3::timestamptz
     FROM (
       SELECT count(*)::int AS count
       FROM pms.messages
       WHERE property_id = $1::uuid AND thread_id = $2::uuid
         AND direction = 'inbound' AND read_at IS NULL
     ) unread
     WHERE thread.property_id = $1::uuid AND thread.id = $2::uuid
     RETURNING thread.unread_count AS "unreadCount"`,
    [input.propertyId, input.threadId, acceptedAt],
  );
  const unreadCount = Number(result.rows[0]?.unreadCount);
  if (!Number.isSafeInteger(unreadCount) || unreadCount < 0)
    throw new Error("PMS Inbox unread count is invalid");
  return unreadCount;
}

async function insertMarkedReadEvent(
  client: PmsInboxMarkReadCommandClient,
  input: MarkReadInput,
  keyHash: string,
  unreadCount: number,
  markedReadCount: number,
  acceptedAt: Date,
): Promise<string> {
  const result = await client.query<InsertedIdRow>(
    `INSERT INTO platform.domain_events
       (source_system, event_key, event_type, event_version, occurred_at, event_status,
        tenant_scope, property_id, resource_product, resource_type, resource_id,
        actor_type, actor_user_id, correlation_id, causation_id, idempotency_key_hash,
        payload, event_metadata, privacy_scope)
     VALUES
       ('pms', $1, 'pms.inbox.thread.marked_read', 1, $2::timestamptz, 'recorded',
        'property', $3::uuid, 'pms', 'message_thread', $4::text,
        'user', $5::uuid, $6, $7, $8, $9::jsonb, $10::jsonb, 'confidential')
     RETURNING id::text AS id`,
    [
      `pms.inbox.thread.marked_read:thread:${input.threadId}:key:${keyHash}:v1`,
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
        readThroughMessageId: input.readThroughMessageId,
        unreadCount,
      }),
      JSON.stringify({ contractVersion: "native-guest-inbox.v2", markedReadCount }),
    ],
  );
  const eventId = result.rows[0]?.id;
  if (!eventId) throw new Error("PMS Inbox mark-read event was not recorded");
  return eventId;
}

async function insertMarkedReadAudit(
  client: PmsInboxMarkReadCommandClient,
  input: MarkReadInput,
  idempotencyId: string,
  domainEventId: string,
  keyHash: string,
  unreadCount: number,
  markedReadCount: number,
  acceptedAt: Date,
): Promise<void> {
  await client.query(
    `INSERT INTO platform.product_audit_events
       (audit_key, product, action, occurred_at, tenant_scope, property_id, actor_type,
        actor_user_id, target_resource_product, target_resource_type, target_resource_id,
        secondary_resource_product, secondary_resource_type, secondary_resource_id,
        domain_event_id, idempotency_key_id, correlation_id, causation_id,
        redacted_payload, audit_metadata, retention_class, privacy_scope)
     VALUES
       ($1, 'pms', 'pms.inbox.thread.mark_read', $2::timestamptz, 'property', $3::uuid,
        'user', $4::uuid, 'pms', 'message_thread', $5::text,
        'pms', 'message', $6::text, $7::uuid, $8::uuid, $9, $10,
        $11::jsonb, $12::jsonb, 'guest_pii', 'confidential')`,
    [
      `pms.inbox.thread.mark_read:thread:${input.threadId}:key:${keyHash}:v1`,
      acceptedAt,
      input.propertyId,
      input.actorUserId,
      input.threadId,
      input.readThroughMessageId,
      domainEventId,
      idempotencyId,
      input.audit.correlationId,
      input.audit.requestId,
      JSON.stringify({ unreadCount, markedReadCount }),
      JSON.stringify({ actorMembershipId: input.actorMembershipId }),
    ],
  );
}

async function commitResult(
  client: PmsInboxMarkReadCommandClient,
  idempotencyId: string,
  result: MarkReadResult,
  acceptedAt: Date,
): Promise<MarkReadResult> {
  const completed = await client.query(
    `UPDATE platform.idempotency_keys
     SET status = 'completed', response_status_code = $2,
         response_body_hash = $3,
         response_resource_product = $4, response_resource_type = $5,
         response_resource_id = $6, last_seen_at = $7::timestamptz,
         locked_until = NULL, completed_at = $7::timestamptz,
         idempotency_metadata = idempotency_metadata || jsonb_build_object('result', $8::jsonb)
     WHERE id = $1::uuid AND status = 'in_progress'`,
    [
      idempotencyId,
      responseStatus(result),
      sha256(stableJson(result)),
      result.ok ? "pms" : null,
      result.ok ? "message_thread" : null,
      result.ok ? result.value.threadId : null,
      acceptedAt,
      JSON.stringify(result),
    ],
  );
  if ((completed.rowCount ?? 0) !== 1)
    throw new Error("PMS Inbox mark-read idempotency record was not completed once");
  await client.query("COMMIT");
  return result;
}

function parseStoredResult(value: unknown): MarkReadResult | null {
  const root = record(value);
  if (!root || typeof root["ok"] !== "boolean") return null;
  if (root["ok"] === false) {
    const error = record(root["error"]);
    if (
      !error ||
      !["validation_failed", "thread_not_found", "idempotency_conflict"].includes(
        String(error["code"]),
      ) ||
      typeof error["message"] !== "string"
    )
      return null;
    return { ok: false, error: error as MarkReadFailure["error"] };
  }
  const stored = record(root["value"]);
  if (
    !stored ||
    typeof stored["propertyId"] !== "string" ||
    typeof stored["threadId"] !== "string" ||
    typeof stored["readThroughMessageId"] !== "string" ||
    !Number.isSafeInteger(stored["unreadCount"]) ||
    Number(stored["unreadCount"]) < 0
  )
    return null;
  return { ok: true, value: stored as Extract<MarkReadResult, { ok: true }>["value"] };
}

function markReadFingerprint(input: MarkReadInput): string {
  return stableJson({
    operation: OPERATION,
    propertyId: input.propertyId,
    threadId: input.threadId,
    body: { readThroughMessageId: input.readThroughMessageId },
  });
}

function responseStatus(result: MarkReadResult): number {
  if (result.ok) return 200;
  if (result.error.code === "thread_not_found") return 404;
  if (result.error.code === "idempotency_conflict") return 409;
  return 400;
}

function failure(
  code: Extract<MarkReadResult, { ok: false }>["error"]["code"],
  message: string,
): MarkReadResult {
  return { ok: false, error: { code, message } };
}

function validInstant(value: string): boolean {
  const time = Date.parse(value);
  return Number.isFinite(time) && new Date(time).toISOString() === value;
}

function validDate(value: Date): boolean {
  return Number.isFinite(value.getTime());
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

async function rollbackQuietly(client: PmsInboxMarkReadCommandClient): Promise<void> {
  try {
    await client.query("ROLLBACK");
  } catch {
    // Preserve the original failure.
  }
}

function releaseQuietly(client: PmsInboxMarkReadCommandClient): void {
  try {
    client.release();
  } catch {
    // The command result is already determined.
  }
}
