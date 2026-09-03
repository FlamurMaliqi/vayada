import { createHash } from "node:crypto";

import pg, { type QueryResult, type QueryResultRow } from "pg";

import { type PmsInboxTriageAction, type PmsInboxTriagePort } from "./pmsInbox.js";

export type PmsInboxTriageCommandClient = {
  query<T extends QueryResultRow = QueryResultRow>(
    text: string,
    values?: readonly unknown[],
  ): Promise<Pick<QueryResult<T>, "rows" | "rowCount">>;
  release(): void;
};

export type PmsInboxTriageCommandPool = {
  connect(): Promise<PmsInboxTriageCommandClient>;
  end?(): Promise<void>;
};

export type PgPmsInboxTriagePort = PmsInboxTriagePort & { close(): Promise<void> };

type TriageInput = Parameters<PmsInboxTriagePort["transition"]>[0];
type TriageResult = Awaited<ReturnType<PmsInboxTriagePort["transition"]>>;
type TriageFailure = Extract<TriageResult, { ok: false }>;
type AttentionState = Extract<TriageResult, { ok: true }>["value"]["attentionState"];

type IdempotencyRow = {
  status: string;
  requestFingerprintHash: string;
  responseStatusCode: number | null;
  responseBodyHash: string | null;
  idempotencyMetadata: unknown;
};
type ThreadRow = { version: string | number; attentionState: AttentionState };
type InsertedIdRow = { id: string };
type VersionRow = { version: string | number };

const OPERATIONS: Record<PmsInboxTriageAction, string> = {
  done: "pms.inbox.thread.mark_done",
  follow_up: "pms.inbox.thread.follow_up",
  reopen: "pms.inbox.thread.reopen",
};
const FOLLOW_UP_QUEUE = "pms.inbox.follow-up.release";
const EVENT_TYPE = "pms.inbox.thread.attention_changed";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function createPgPmsInboxTriagePort(config: {
  connectionString: string;
  pool?: PmsInboxTriageCommandPool;
  max?: number;
  now?: () => Date;
}): PgPmsInboxTriagePort {
  if (!config.pool && !config.connectionString.trim())
    throw new Error("PMS Inbox triage connectionString must not be empty");
  const ownsPool = !config.pool;
  const pool: PmsInboxTriageCommandPool =
    config.pool ?? new pg.Pool({ connectionString: config.connectionString, max: config.max });
  const now = config.now ?? (() => new Date());
  let closed = false;

  return {
    async transition(rawInput) {
      const input = normalizeInput(rawInput);
      if (!input) return failure("validation_failed", "Inbox triage payload is invalid.");
      const acceptedAt = now();
      if (!validDate(acceptedAt)) throw new Error("PMS Inbox triage clock is invalid");
      const operation = OPERATIONS[input.action];
      const keyHash = sha256(input.idempotencyKey);
      const requestFingerprintHash = sha256(triageFingerprint(input, operation));
      const client = await pool.connect();

      try {
        await client.query("BEGIN");
        if (!(await lockActorScope(client, input, acceptedAt)))
          throw new Error("PMS Inbox triage actor scope is unavailable");

        const replay = await findReplay(client, input, operation, keyHash, requestFingerprintHash);
        if (replay) {
          await client.query("ROLLBACK");
          return replay;
        }

        const idempotencyId = await reserveIdempotency(
          client,
          input,
          operation,
          keyHash,
          requestFingerprintHash,
          acceptedAt,
        );
        if (!idempotencyId) {
          const concurrentReplay = await findReplay(
            client,
            input,
            operation,
            keyHash,
            requestFingerprintHash,
          );
          await client.query("ROLLBACK");
          return (
            concurrentReplay ??
            failure("idempotency_conflict", "This Inbox triage command is already in progress.")
          );
        }

        if (
          input.action === "follow_up" &&
          new Date(input.followUpAt as string).getTime() <= acceptedAt.getTime()
        )
          return commitResult(
            client,
            idempotencyId,
            failure("validation_failed", "Follow-up time must be in the future."),
            acceptedAt,
          );

        const thread = await lockThread(client, input);
        if (!thread)
          return commitResult(
            client,
            idempotencyId,
            failure("thread_not_found", "Inbox thread was not found."),
            acceptedAt,
          );
        const currentVersion = safeVersion(thread.version);
        if (currentVersion !== input.expectedThreadVersion)
          return commitResult(
            client,
            idempotencyId,
            failure(
              "thread_version_conflict",
              "The conversation changed. Refresh and try again.",
              currentVersion,
            ),
            acceptedAt,
          );

        const nextState = attentionState(input.action);
        const nextVersion = currentVersion + 1;
        if (!Number.isSafeInteger(nextVersion))
          throw new Error("PMS Inbox triage thread version is invalid");
        const domainEventId = await insertAttentionEvent(
          client,
          input,
          keyHash,
          thread.attentionState,
          nextState,
          nextVersion,
          acceptedAt,
        );
        const followUpJobId =
          input.action === "follow_up"
            ? await insertFollowUpJob(client, input, domainEventId, keyHash, acceptedAt)
            : null;
        const threadVersion = await transitionThread(
          client,
          input,
          nextState,
          followUpJobId,
          acceptedAt,
        );
        await insertTriageAudit(
          client,
          input,
          operation,
          idempotencyId,
          domainEventId,
          followUpJobId,
          keyHash,
          thread.attentionState,
          nextState,
          threadVersion,
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
              attentionState: nextState,
              followUpAt: input.action === "follow_up" ? input.followUpAt : null,
              threadVersion,
            },
          },
          acceptedAt,
        );
      } catch {
        await rollbackQuietly(client);
        throw new Error("PMS Inbox triage command failed");
      } finally {
        releaseQuietly(client);
      }
    },

    async close() {
      if (!ownsPool || closed) return;
      if (!pool.end) throw new Error("Owned PMS Inbox triage pool cannot be closed");
      await pool.end();
      closed = true;
    },
  };
}

function normalizeInput(input: TriageInput): TriageInput | null {
  const validAction =
    input.action === "done" || input.action === "follow_up" || input.action === "reopen";
  const validFollowUpAt =
    input.action === "follow_up"
      ? typeof input.followUpAt === "string" && validInstant(input.followUpAt)
      : input.followUpAt === null;
  if (
    !UUID.test(input.propertyId) ||
    !UUID.test(input.threadId) ||
    !UUID.test(input.organizationId) ||
    !UUID.test(input.actorUserId) ||
    !UUID.test(input.actorMembershipId) ||
    !validAction ||
    !input.idempotencyKey.trim() ||
    input.idempotencyKey.length > 200 ||
    !Number.isSafeInteger(input.expectedThreadVersion) ||
    input.expectedThreadVersion < 1 ||
    !validFollowUpAt ||
    !input.audit.requestId.trim() ||
    !input.audit.correlationId.trim() ||
    !validInstant(input.audit.requestedAt)
  )
    return null;
  return { ...input, idempotencyKey: input.idempotencyKey.trim() };
}

async function lockActorScope(
  client: PmsInboxTriageCommandClient,
  input: TriageInput,
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
  client: PmsInboxTriageCommandClient,
  input: TriageInput,
  operation: string,
  keyHash: string,
  requestFingerprintHash: string,
): Promise<TriageResult | null> {
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
    [operation, keyHash, input.propertyId],
  );
  const row = result.rows[0];
  if (!row) return null;
  if (row.requestFingerprintHash !== requestFingerprintHash)
    return failure(
      "idempotency_conflict",
      "Idempotency key was already used for a different Inbox triage command.",
    );
  if (row.status !== "completed")
    return failure("idempotency_conflict", "This Inbox triage command is already in progress.");
  const replay = parseStoredResult(record(row.idempotencyMetadata)?.["result"]);
  if (
    !replay ||
    row.responseStatusCode !== responseStatus(replay) ||
    row.responseBodyHash !== sha256(stableJson(replay))
  )
    throw new Error("PMS Inbox triage replay evidence is invalid");
  return replay;
}

async function reserveIdempotency(
  client: PmsInboxTriageCommandClient,
  input: TriageInput,
  operation: string,
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
      operation,
      keyHash,
      requestFingerprintHash,
      input.propertyId,
      input.audit.correlationId,
      acceptedAt,
      JSON.stringify({ operation, requestId: input.audit.requestId }),
    ],
  );
  return result.rows[0]?.id ?? null;
}

async function lockThread(
  client: PmsInboxTriageCommandClient,
  input: TriageInput,
): Promise<ThreadRow | null> {
  const result = await client.query<ThreadRow>(
    `SELECT version, attention_state AS "attentionState"
     FROM pms.message_threads
     WHERE property_id = $1::uuid AND id = $2::uuid
     FOR UPDATE`,
    [input.propertyId, input.threadId],
  );
  return result.rows[0] ?? null;
}

async function insertAttentionEvent(
  client: PmsInboxTriageCommandClient,
  input: TriageInput,
  keyHash: string,
  previousState: AttentionState,
  nextState: AttentionState,
  threadVersion: number,
  acceptedAt: Date,
): Promise<string> {
  const result = await client.query<InsertedIdRow>(
    `INSERT INTO platform.domain_events
       (source_system, event_key, event_type, event_version, occurred_at, event_status,
        tenant_scope, property_id, resource_product, resource_type, resource_id,
        actor_type, actor_user_id, correlation_id, causation_id, idempotency_key_hash,
        payload, event_metadata, privacy_scope)
     VALUES
       ('pms', $1, $2, 1, $3::timestamptz, 'recorded',
        'property', $4::uuid, 'pms', 'message_thread', $5::text,
        'user', $6::uuid, $7, $8, $9, $10::jsonb, $11::jsonb, 'confidential')
     RETURNING id::text AS id`,
    [
      eventKey(input, keyHash),
      EVENT_TYPE,
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
        attentionState: nextState,
        followUpAt: input.action === "follow_up" ? input.followUpAt : null,
        threadVersion,
      }),
      JSON.stringify({
        contractVersion: "native-guest-inbox.v2",
        action: input.action,
        previousAttentionState: previousState,
      }),
    ],
  );
  const eventId = result.rows[0]?.id;
  if (!eventId) throw new Error("PMS Inbox triage event was not recorded");
  return eventId;
}

async function insertFollowUpJob(
  client: PmsInboxTriageCommandClient,
  input: TriageInput,
  domainEventId: string,
  keyHash: string,
  acceptedAt: Date,
): Promise<string> {
  const result = await client.query<InsertedIdRow>(
    `INSERT INTO platform.jobs
       (job_key, queue_name, job_type, source_domain_event_id, status, max_attempts,
        run_after, tenant_scope, property_id, resource_product, resource_type, resource_id,
        correlation_id, idempotency_key_hash, payload, job_metadata, created_at, updated_at)
     VALUES
       ($1, $2, $2, $3::uuid, 'pending', 5, $4::timestamptz,
        'property', $5::uuid, 'pms', 'message_thread', $6::text,
        $7, $8, $9::jsonb, $10::jsonb, $11::timestamptz, $11::timestamptz)
     RETURNING id::text AS id`,
    [
      `${FOLLOW_UP_QUEUE}:thread:${input.threadId}:key:${keyHash}:v1`,
      FOLLOW_UP_QUEUE,
      domainEventId,
      input.followUpAt,
      input.propertyId,
      input.threadId,
      input.audit.correlationId,
      keyHash,
      JSON.stringify({
        propertyId: input.propertyId,
        threadId: input.threadId,
        followUpAt: input.followUpAt,
      }),
      JSON.stringify({
        contractVersion: "native-guest-inbox.v2",
        action: "release_follow_up",
      }),
      acceptedAt,
    ],
  );
  const jobId = result.rows[0]?.id;
  if (!jobId) throw new Error("PMS Inbox follow-up job was not scheduled");
  return jobId;
}

async function transitionThread(
  client: PmsInboxTriageCommandClient,
  input: TriageInput,
  nextState: AttentionState,
  followUpJobId: string | null,
  acceptedAt: Date,
): Promise<number> {
  const result = await client.query<VersionRow>(
    `UPDATE pms.message_threads
     SET attention_state = $3,
         follow_up_at = CASE WHEN $3 = 'follow_up' THEN $4::timestamptz ELSE NULL END,
         follow_up_by_membership_id = CASE WHEN $3 = 'follow_up' THEN $5::uuid ELSE NULL END,
         follow_up_job_id = CASE WHEN $3 = 'follow_up' THEN $6::uuid ELSE NULL END,
         done_at = CASE WHEN $3 = 'done' THEN $7::timestamptz ELSE NULL END,
         done_by_membership_id = CASE WHEN $3 = 'done' THEN $5::uuid ELSE NULL END,
         done_reason = CASE WHEN $3 = 'done' THEN 'staff_marked_done' ELSE NULL END,
         version = version + 1,
         updated_at = $7::timestamptz
     WHERE property_id = $1::uuid AND id = $2::uuid AND version = $8
     RETURNING version`,
    [
      input.propertyId,
      input.threadId,
      nextState,
      input.followUpAt,
      input.actorMembershipId,
      followUpJobId,
      acceptedAt,
      input.expectedThreadVersion,
    ],
  );
  const version = safeVersion(result.rows[0]?.version);
  if (version !== input.expectedThreadVersion + 1)
    throw new Error("PMS Inbox triage thread was not updated once");
  return version;
}

async function insertTriageAudit(
  client: PmsInboxTriageCommandClient,
  input: TriageInput,
  operation: string,
  idempotencyId: string,
  domainEventId: string,
  followUpJobId: string | null,
  keyHash: string,
  previousState: AttentionState,
  nextState: AttentionState,
  threadVersion: number,
  acceptedAt: Date,
): Promise<void> {
  await client.query(
    `INSERT INTO platform.product_audit_events
       (audit_key, product, action, occurred_at, tenant_scope, property_id, actor_type,
        actor_user_id, target_resource_product, target_resource_type, target_resource_id,
        domain_event_id, job_id, idempotency_key_id, correlation_id, causation_id,
        redacted_payload, audit_metadata, retention_class, privacy_scope)
     VALUES
       ($1, 'pms', $2, $3::timestamptz, 'property', $4::uuid, 'user',
        $5::uuid, 'pms', 'message_thread', $6::text, $7::uuid, $8::uuid, $9::uuid,
        $10, $11, $12::jsonb, $13::jsonb, 'guest_pii', 'confidential')`,
    [
      eventKey(input, keyHash),
      operation,
      acceptedAt,
      input.propertyId,
      input.actorUserId,
      input.threadId,
      domainEventId,
      followUpJobId,
      idempotencyId,
      input.audit.correlationId,
      input.audit.requestId,
      JSON.stringify({
        previousAttentionState: previousState,
        attentionState: nextState,
        followUpAt: input.action === "follow_up" ? input.followUpAt : null,
        threadVersion,
      }),
      JSON.stringify({ actorMembershipId: input.actorMembershipId, action: input.action }),
    ],
  );
}

async function commitResult(
  client: PmsInboxTriageCommandClient,
  idempotencyId: string,
  result: TriageResult,
  acceptedAt: Date,
): Promise<TriageResult> {
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
    throw new Error("PMS Inbox triage idempotency record was not completed once");
  await client.query("COMMIT");
  return result;
}

function parseStoredResult(value: unknown): TriageResult | null {
  const root = record(value);
  if (!root || typeof root["ok"] !== "boolean") return null;
  if (root["ok"] === false) {
    const error = record(root["error"]);
    if (
      !error ||
      ![
        "validation_failed",
        "thread_not_found",
        "thread_version_conflict",
        "idempotency_conflict",
      ].includes(String(error["code"])) ||
      typeof error["message"] !== "string" ||
      (error["currentVersion"] !== undefined &&
        (!Number.isSafeInteger(error["currentVersion"]) || Number(error["currentVersion"]) < 1))
    )
      return null;
    return { ok: false, error: error as TriageFailure["error"] };
  }
  const stored = record(root["value"]);
  if (
    !stored ||
    typeof stored["propertyId"] !== "string" ||
    typeof stored["threadId"] !== "string" ||
    !["needs_attention", "follow_up", "done"].includes(String(stored["attentionState"])) ||
    !Number.isSafeInteger(stored["threadVersion"]) ||
    Number(stored["threadVersion"]) < 1 ||
    (stored["attentionState"] === "follow_up"
      ? typeof stored["followUpAt"] !== "string" || !validInstant(stored["followUpAt"])
      : stored["followUpAt"] !== null)
  )
    return null;
  return { ok: true, value: stored as Extract<TriageResult, { ok: true }>["value"] };
}

function triageFingerprint(input: TriageInput, operation: string): string {
  return stableJson({
    operation,
    propertyId: input.propertyId,
    threadId: input.threadId,
    body: {
      expectedThreadVersion: input.expectedThreadVersion,
      followUpAt: input.followUpAt,
    },
  });
}

function eventKey(input: TriageInput, keyHash: string): string {
  return `${OPERATIONS[input.action]}:thread:${input.threadId}:key:${keyHash}:v1`;
}

function attentionState(action: PmsInboxTriageAction): AttentionState {
  if (action === "done") return "done";
  if (action === "follow_up") return "follow_up";
  return "needs_attention";
}

function responseStatus(result: TriageResult): number {
  if (result.ok) return 200;
  if (result.error.code === "thread_not_found") return 404;
  if (
    result.error.code === "thread_version_conflict" ||
    result.error.code === "idempotency_conflict"
  )
    return 409;
  return 400;
}

function failure(
  code: TriageFailure["error"]["code"],
  message: string,
  currentVersion?: number,
): TriageResult {
  return {
    ok: false,
    error: { code, message, ...(currentVersion === undefined ? {} : { currentVersion }) },
  };
}

function safeVersion(value: unknown): number {
  const version = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(version) || version < 1)
    throw new Error("PMS Inbox triage thread version is invalid");
  return version;
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

async function rollbackQuietly(client: PmsInboxTriageCommandClient): Promise<void> {
  try {
    await client.query("ROLLBACK");
  } catch {
    // Preserve the original failure.
  }
}

function releaseQuietly(client: PmsInboxTriageCommandClient): void {
  try {
    client.release();
  } catch {
    // The command result is already determined.
  }
}
