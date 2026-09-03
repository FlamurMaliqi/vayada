import { createHash } from "node:crypto";

import pg, { type QueryResult, type QueryResultRow } from "pg";
import {
  parseStaffPermissionOverrides,
  validateStaffPermissionOverrides,
} from "@vayada/backend-auth";

import type {
  PmsInboxEmailReplyRouteReadPort,
  PmsInboxStartDirectEmailError,
  PmsInboxStartDirectEmailPort,
} from "./pmsInbox.js";
import { resolvePmsInboxEmailReplyRoutes } from "./pmsInboxEmailReplyRoutes.js";

export type PmsInboxStartDirectEmailClient = {
  query<T extends QueryResultRow = QueryResultRow>(
    text: string,
    values?: readonly unknown[],
  ): Promise<Pick<QueryResult<T>, "rows" | "rowCount">>;
  release(): void;
};

export type PmsInboxStartDirectEmailPool = {
  connect(): Promise<PmsInboxStartDirectEmailClient>;
  end?(): Promise<void>;
};

export type PgPmsInboxStartDirectEmailPort = PmsInboxStartDirectEmailPort & {
  close(): Promise<void>;
};

type Input = Parameters<PmsInboxStartDirectEmailPort["start"]>[0];
type Result = Awaited<ReturnType<PmsInboxStartDirectEmailPort["start"]>>;
type Success = Extract<Result, { ok: true }>;
type ScopeRow = {
  propertyAccessMode: string;
  roleKey: string;
  permissionOverrides: unknown;
};
type PermissionRow = { permissionKey: string };
type BookingRow = { bookingChannel: string; lifecycleStatus: string };
type GuestRow = { email: string | null };
type ThreadRow = {
  id: string;
  guestBookingId: string;
  source: string;
  sourceThreadId: string;
  attentionState: string;
  deliveryChannel: string;
  version: string | number;
  activityAt: Date | string;
};
type InsertedIdRow = { id: string };
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

const OPERATION = "pms.inbox.thread.start_direct_email";
const EVENT_TYPE = "pms.inbox.thread.direct_email_started";
const ELIGIBLE_LIFECYCLE = new Set(["confirmed", "canceled", "completed", "no_show"]);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function createPgPmsInboxStartDirectEmailPort(config: {
  connectionString: string;
  emailReplyRoutes: PmsInboxEmailReplyRouteReadPort;
  pool?: PmsInboxStartDirectEmailPool;
  max?: number;
  now?: () => Date;
}): PgPmsInboxStartDirectEmailPort {
  if (!config.pool && !config.connectionString.trim())
    throw new Error("PMS Inbox direct-email connectionString must not be empty");
  const ownsPool = !config.pool;
  const pool: PmsInboxStartDirectEmailPool =
    config.pool ?? new pg.Pool({ connectionString: config.connectionString, max: config.max });
  const now = config.now ?? (() => new Date());
  let closed = false;

  return {
    async start(rawInput) {
      const input = normalizeInput(rawInput);
      if (!input) return failure("validation_failed", "Direct-email thread request is invalid.");
      const acceptedAt = now();
      if (!validDate(acceptedAt)) throw new Error("PMS Inbox direct-email clock is invalid");
      const keyHash = sha256(input.idempotencyKey);
      const fingerprint = sha256(
        stableJson({
          operation: OPERATION,
          propertyId: input.propertyId,
          bookingId: input.bookingId,
        }),
      );
      const client = await pool.connect();

      try {
        await client.query("BEGIN");
        if (!(await lockActorScope(client, input, acceptedAt)))
          throw new Error("PMS Inbox direct-email actor scope is unavailable");
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
              failure("idempotency_conflict", "This direct-email request is already in progress."),
          );
        }

        const booking = await lockBooking(client, input.propertyId, input.bookingId);
        if (
          !booking ||
          booking.bookingChannel !== "direct" ||
          !ELIGIBLE_LIFECYCLE.has(booking.lifecycleStatus)
        )
          return await commitResult(
            client,
            idempotencyId,
            failure(
              "direct_email_not_allowed",
              "A direct-email thread is unavailable for this reservation.",
            ),
            completionInstant(now, acceptedAt),
          );

        const guest = await lockGuest(client, input.bookingId);
        const sourceThreadId = `direct-email:${input.bookingId}:v1`;
        const existing = await lockThread(client, input.propertyId, sourceThreadId);
        const inserted = existing
          ? null
          : await insertThread(client, input, sourceThreadId, acceptedAt);
        const thread = inserted ?? (await lockThread(client, input.propertyId, sourceThreadId));
        if (!thread || !validThread(thread, input.bookingId, sourceThreadId))
          throw new Error("PMS Inbox direct-email thread identity is invalid");
        const resolvedRoute = (
          await resolvePmsInboxEmailReplyRoutes(config.emailReplyRoutes, input.propertyId, [
            { threadId: thread.id, guestEmail: guest?.email ?? null },
          ])
        ).get(thread.id)!;
        const route = canonicalEmailRoute(resolvedRoute);
        if (!route) throw new Error("PMS Inbox direct-email reply route is invalid");
        const created = Boolean(inserted);
        if (created) {
          const eventId = await insertEvent(client, input, thread.id, keyHash, acceptedAt);
          await insertAudit(client, input, thread.id, eventId, idempotencyId, keyHash, acceptedAt);
        }
        return await commitResult(
          client,
          idempotencyId,
          {
            ok: true,
            value: {
              propertyId: input.propertyId,
              bookingId: input.bookingId,
              created,
              thread: {
                id: thread.id,
                source: "manual",
                sourceThreadId,
                attentionState:
                  thread.attentionState as Success["value"]["thread"]["attentionState"],
                channel: "email",
                version: Number(thread.version),
                activityAt: new Date(thread.activityAt).toISOString(),
                replyRoute: route,
              },
            },
          },
          completionInstant(now, acceptedAt),
        );
      } catch {
        await rollbackQuietly(client);
        throw new Error("PMS Inbox direct-email command failed");
      } finally {
        releaseQuietly(client);
      }
    },

    async close() {
      if (!ownsPool || closed) return;
      if (!pool.end) throw new Error("Owned PMS Inbox direct-email pool cannot be closed");
      await pool.end();
      closed = true;
    },
  };
}

function normalizeInput(input: Input): Input | null {
  if (
    !UUID.test(input.propertyId) ||
    !UUID.test(input.bookingId) ||
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
  client: PmsInboxStartDirectEmailClient,
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
       WHERE membership_id = $1::uuid AND property_id = $2::uuid FOR SHARE`,
      [input.actorMembershipId, input.propertyId],
    );
    if (!assignment.rows[0]) return false;
  }
  const permissionRows = await client.query<PermissionRow>(
    `SELECT permission_key AS "permissionKey" FROM identity.role_permission_grants
     WHERE organization_kind = 'hotel_group' AND role_key = $1 FOR SHARE`,
    [actor.roleKey],
  );
  const rolePermissions = permissionRows.rows.map((row) => row.permissionKey);
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
  client: PmsInboxStartDirectEmailClient,
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
      "Idempotency key was used for a different direct-email request.",
    );
  if (row.status !== "completed")
    return failure("idempotency_conflict", "This direct-email request is already in progress.");
  const result = parseStoredResult(record(row.idempotencyMetadata)?.["result"]);
  if (
    !result ||
    row.responseStatusCode !== responseStatus(result) ||
    row.responseBodyHash !== sha256(stableJson(result)) ||
    (result.ok &&
      (row.responseResourceProduct !== "pms" ||
        row.responseResourceType !== "message_thread" ||
        row.responseResourceId !== result.value.thread.id))
  )
    throw new Error("PMS Inbox direct-email replay evidence is invalid");
  return result;
}

async function reserveIdempotency(
  client: PmsInboxStartDirectEmailClient,
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
             $6::timestamptz + interval '30 days', $7::jsonb)
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

async function lockBooking(
  client: PmsInboxStartDirectEmailClient,
  propertyId: string,
  bookingId: string,
): Promise<BookingRow | null> {
  const query = await client.query<BookingRow>(
    `SELECT booking_channel AS "bookingChannel", lifecycle_status AS "lifecycleStatus"
     FROM booking.guest_bookings
     WHERE property_id = $1::uuid AND id = $2::uuid
     FOR SHARE`,
    [propertyId, bookingId],
  );
  return query.rows[0] ?? null;
}

async function lockGuest(
  client: PmsInboxStartDirectEmailClient,
  bookingId: string,
): Promise<GuestRow | null> {
  const query = await client.query<GuestRow>(
    `SELECT NULLIF(BTRIM(email), '') AS email
     FROM booking.booking_guests
     WHERE guest_booking_id = $1::uuid
       AND NULLIF(BTRIM(email), '') IS NOT NULL
     ORDER BY CASE guest_role WHEN 'booker' THEN 0 WHEN 'primary_guest' THEN 1 ELSE 2 END,
              created_at, id
     LIMIT 1 FOR SHARE`,
    [bookingId],
  );
  return query.rows[0] ?? null;
}

async function lockThread(
  client: PmsInboxStartDirectEmailClient,
  propertyId: string,
  sourceThreadId: string,
): Promise<ThreadRow | null> {
  const query = await client.query<ThreadRow>(
    `SELECT id::text, guest_booking_id::text AS "guestBookingId", source,
            source_thread_id AS "sourceThreadId", attention_state AS "attentionState",
            delivery_channel AS "deliveryChannel", version,
            GREATEST(COALESCE(last_message_at, created_at),
                     COALESCE(last_internal_note_at, created_at)) AS "activityAt"
     FROM pms.message_threads
     WHERE property_id = $1::uuid AND source = 'manual' AND source_thread_id = $2
     FOR UPDATE`,
    [propertyId, sourceThreadId],
  );
  return query.rows[0] ?? null;
}

async function insertThread(
  client: PmsInboxStartDirectEmailClient,
  input: Input,
  sourceThreadId: string,
  acceptedAt: Date,
): Promise<ThreadRow | null> {
  const query = await client.query<ThreadRow>(
    `INSERT INTO pms.message_threads
       (property_id, guest_booking_id, source, source_thread_id, source_booking_id,
        attention_state, conversation_context_state, delivery_channel, unread_count,
        version, created_at, updated_at)
     VALUES ($1::uuid, $2::uuid, 'manual', $3, $2::text,
             'needs_attention', 'linked', 'email', 0, 1, $4::timestamptz, $4::timestamptz)
     ON CONFLICT (property_id, source, source_thread_id) DO NOTHING
     RETURNING id::text, guest_booking_id::text AS "guestBookingId", source,
               source_thread_id AS "sourceThreadId", attention_state AS "attentionState",
               delivery_channel AS "deliveryChannel", version, created_at AS "activityAt"`,
    [input.propertyId, input.bookingId, sourceThreadId, acceptedAt],
  );
  return query.rows[0] ?? null;
}

function validThread(thread: ThreadRow, bookingId: string, sourceThreadId: string): boolean {
  const version = Number(thread.version);
  return (
    UUID.test(thread.id) &&
    thread.guestBookingId === bookingId &&
    thread.source === "manual" &&
    thread.sourceThreadId === sourceThreadId &&
    ["needs_attention", "follow_up", "done"].includes(thread.attentionState) &&
    thread.deliveryChannel === "email" &&
    Number.isSafeInteger(version) &&
    version >= 1 &&
    validDate(new Date(thread.activityAt))
  );
}

async function insertEvent(
  client: PmsInboxStartDirectEmailClient,
  input: Input,
  threadId: string,
  keyHash: string,
  acceptedAt: Date,
): Promise<string> {
  const query = await client.query<InsertedIdRow>(
    `INSERT INTO platform.domain_events
       (source_system, event_key, event_type, occurred_at, tenant_scope, property_id,
        resource_product, resource_type, resource_id, actor_type, actor_user_id,
        correlation_id, causation_id, idempotency_key_hash, payload, event_metadata, privacy_scope)
     VALUES ('pms', $1, $2, $3::timestamptz, 'property', $4::uuid,
             'pms', 'message_thread', $5::text, 'user', $6::uuid,
             $7, $8, $9, $10::jsonb, $11::jsonb, 'internal')
     RETURNING id::text AS id`,
    [
      `${EVENT_TYPE}:thread:${threadId}:v1`,
      EVENT_TYPE,
      acceptedAt,
      input.propertyId,
      threadId,
      input.actorUserId,
      input.audit.correlationId,
      input.audit.requestId,
      keyHash,
      JSON.stringify({ propertyId: input.propertyId, threadId, bookingId: input.bookingId }),
      JSON.stringify({ contractVersion: "native-guest-inbox.v2", deliveryChannel: "email" }),
    ],
  );
  const id = query.rows[0]?.id;
  if (!id) throw new Error("PMS Inbox direct-email event was not recorded");
  return id;
}

async function insertAudit(
  client: PmsInboxStartDirectEmailClient,
  input: Input,
  threadId: string,
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
     VALUES ($1, 'pms', $2, $3::timestamptz, 'property', $4::uuid, 'user', $5::uuid,
             'pms', 'message_thread', $6::text, $7::uuid, $8::uuid, $9, $10,
             $11::jsonb, $12::jsonb, 'standard', 'internal')`,
    [
      `${EVENT_TYPE}:thread:${threadId}:v1`,
      EVENT_TYPE,
      acceptedAt,
      input.propertyId,
      input.actorUserId,
      threadId,
      eventId,
      idempotencyId,
      input.audit.correlationId,
      input.audit.requestId,
      JSON.stringify({ bookingId: input.bookingId, channel: "email" }),
      JSON.stringify({
        contractVersion: "native-guest-inbox.v2",
        actorMembershipId: input.actorMembershipId,
        idempotencyKeyHash: keyHash,
      }),
    ],
  );
}

async function commitResult(
  client: PmsInboxStartDirectEmailClient,
  idempotencyId: string,
  result: Result,
  completedAt: Date,
): Promise<Result> {
  const query = await client.query(
    `UPDATE platform.idempotency_keys
     SET status = 'completed', response_status_code = $2, response_body_hash = $3,
         response_resource_product = $4, response_resource_type = $5,
         response_resource_id = $6, last_seen_at = $7::timestamptz,
         locked_until = NULL, completed_at = $7::timestamptz,
         expires_at = $7::timestamptz + interval '30 days',
         idempotency_metadata = idempotency_metadata || jsonb_build_object('result', $8::jsonb)
     WHERE id = $1::uuid AND status = 'in_progress'`,
    [
      idempotencyId,
      responseStatus(result),
      sha256(stableJson(result)),
      result.ok ? "pms" : null,
      result.ok ? "message_thread" : null,
      result.ok ? result.value.thread.id : null,
      completedAt,
      JSON.stringify(result),
    ],
  );
  if ((query.rowCount ?? 0) !== 1)
    throw new Error("PMS Inbox direct-email idempotency was not completed once");
  await client.query("COMMIT");
  return result;
}

function parseStoredResult(value: unknown): Result | null {
  const root = record(value);
  const error = record(root?.["error"]);
  if (root?.["ok"] === false && error) {
    const code = String(error["code"]);
    if (
      !["validation_failed", "direct_email_not_allowed", "idempotency_conflict"].includes(code) ||
      typeof error["message"] !== "string"
    )
      return null;
    return { ok: false, error: error as PmsInboxStartDirectEmailError };
  }
  const valueRecord = record(root?.["value"]);
  const thread = record(valueRecord?.["thread"]);
  const route = record(thread?.["replyRoute"]);
  if (
    root?.["ok"] !== true ||
    !valueRecord ||
    !thread ||
    !route ||
    typeof valueRecord["propertyId"] !== "string" ||
    typeof valueRecord["bookingId"] !== "string" ||
    typeof valueRecord["created"] !== "boolean" ||
    typeof thread["id"] !== "string" ||
    !UUID.test(thread["id"]) ||
    thread["source"] !== "manual" ||
    typeof thread["sourceThreadId"] !== "string" ||
    !["needs_attention", "follow_up", "done"].includes(String(thread["attentionState"])) ||
    thread["channel"] !== "email" ||
    !Number.isSafeInteger(thread["version"]) ||
    typeof thread["activityAt"] !== "string" ||
    !validInstant(thread["activityAt"]) ||
    !validEmailRoute(route)
  )
    return null;
  return { ok: true, value: valueRecord as Success["value"] };
}

function canonicalEmailRoute(value: unknown): Success["value"]["thread"]["replyRoute"] | null {
  const route = record(value);
  if (!route) return null;
  if (
    route["state"] === "ready" &&
    route["channel"] === "email" &&
    route["providerChannel"] === null &&
    route["reasonCode"] === null
  )
    return { state: "ready", channel: "email", providerChannel: null, reasonCode: null };
  if (
    route["state"] === "held" &&
    route["channel"] === null &&
    route["providerChannel"] === null &&
    typeof route["reasonCode"] === "string" &&
    ["guest_email_unavailable", "approved_sender_unavailable", "email_policy_disallowed"].includes(
      route["reasonCode"],
    )
  )
    return {
      state: "held",
      channel: null,
      providerChannel: null,
      reasonCode: route["reasonCode"] as Extract<
        Success["value"]["thread"]["replyRoute"],
        { state: "held" }
      >["reasonCode"],
    };
  return null;
}

function validEmailRoute(value: unknown): boolean {
  return canonicalEmailRoute(value) !== null;
}

function responseStatus(result: Result): number {
  if (result.ok) return result.value.created ? 201 : 200;
  return result.error.code === "idempotency_conflict" ? 409 : 400;
}

function failure(code: PmsInboxStartDirectEmailError["code"], message: string): Result {
  return { ok: false, error: { code, message } };
}

function validDate(value: Date): boolean {
  return Number.isFinite(value.getTime());
}

function completionInstant(now: () => Date, acceptedAt: Date): Date {
  const completedAt = now();
  if (!validDate(completedAt) || completedAt < acceptedAt)
    throw new Error("PMS Inbox direct-email completion clock is invalid");
  return completedAt;
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
  client: PmsInboxStartDirectEmailClient,
  result: T,
): Promise<T> {
  await client.query("ROLLBACK");
  return result;
}

async function rollbackQuietly(client: PmsInboxStartDirectEmailClient): Promise<void> {
  try {
    await client.query("ROLLBACK");
  } catch {
    // Preserve the original failure.
  }
}

function releaseQuietly(client: PmsInboxStartDirectEmailClient): void {
  try {
    client.release();
  } catch {
    // Preserve the command result.
  }
}
