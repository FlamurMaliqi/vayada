import { createHash } from "node:crypto";

import pg, { type QueryResult, type QueryResultRow } from "pg";

import {
  type PmsInboxEmailReplyRouteReadPort,
  type PmsInboxMessage,
  type PmsInboxReplyError,
  type PmsInboxReplyPort,
  type PmsInboxReplyRoute,
} from "./pmsInbox.js";
import { resolvePmsInboxEmailReplyRoutes } from "./pmsInboxEmailReplyRoutes.js";

export type PmsInboxReplyCommandClient = {
  query<T extends QueryResultRow = QueryResultRow>(
    text: string,
    values?: readonly unknown[],
  ): Promise<Pick<QueryResult<T>, "rows" | "rowCount">>;
  release(): void;
};

export type PmsInboxReplyCommandPool = {
  connect(): Promise<PmsInboxReplyCommandClient>;
  end?(): Promise<void>;
};

export type PgPmsInboxReplyPort = PmsInboxReplyPort & { close(): Promise<void> };

type ReplyInput = Parameters<PmsInboxReplyPort["reply"]>[0];
type ReplyResult = Awaited<ReturnType<PmsInboxReplyPort["reply"]>>;
type ReplySuccess = Extract<ReplyResult, { ok: true }>;

type IdempotencyRow = {
  id: string;
  status: string;
  requestFingerprintHash: string;
  responseStatusCode: number | null;
  responseBodyHash: string | null;
  idempotencyMetadata: unknown;
};

type ThreadRow = {
  version: string | number;
  source: string;
  sourceThreadId: string;
  deliveryChannel: "ota" | "email";
  providerChannel: string | null;
  guestEmail: string | null;
  attentionState: "needs_attention" | "follow_up" | "done";
};

type AttachmentRow = {
  mediaId: string;
  propertyId: string | null;
  resourceProduct: string;
  resourceType: string;
  resourceId: string | null;
  purpose: string;
  visibility: string;
  storageKind: string;
  storageKey: string | null;
  lifecycleStatus: string;
  contentType: string | null;
  sizeBytes: string | number | null;
  originalFilename: string | null;
  retainedUntil: Date | string | null;
  attachmentState: string | null;
  deletedAt: Date | string | null;
};

type ActorScopeRow = { displayName: string };
type InsertedIdRow = { id: string };

const OPERATION = "pms.inbox.thread.reply";
const DELIVERY_EVENT_TYPE = "pms.guest-message.deliver";
const MAX_TEXT_LENGTH = 20_000;
const MAX_ATTACHMENTS = 10;
const DEFAULT_MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;
const BOOKING_COM_MAX_ATTACHMENT_BYTES = 8 * 1024 * 1024;
const EXPEDIA_MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ALLOWED_ATTACHMENT_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/gif",
  "image/heic",
  "image/heif",
  "application/pdf",
]);

export function createPgPmsInboxReplyPort(config: {
  connectionString: string;
  emailReplyRoutes: PmsInboxEmailReplyRouteReadPort;
  pool?: PmsInboxReplyCommandPool;
  max?: number;
  now?: () => Date;
}): PgPmsInboxReplyPort {
  if (!config.pool && !config.connectionString.trim())
    throw new Error("PMS Inbox reply connectionString must not be empty");
  const ownsPool = !config.pool;
  const pool: PmsInboxReplyCommandPool =
    config.pool ?? new pg.Pool({ connectionString: config.connectionString, max: config.max });
  const now = config.now ?? (() => new Date());
  let closed = false;

  return {
    async reply(rawInput) {
      const input = normalizeInput(rawInput);
      if (!input) return failure("validation_failed", "Reply payload is invalid.");
      const acceptedAt = now();
      if (!validDate(acceptedAt)) throw new Error("PMS Inbox reply clock is invalid");
      const keyHash = sha256(input.idempotencyKey);
      const requestFingerprintHash = sha256(replyFingerprint(input));
      const client = await pool.connect();

      try {
        await client.query("BEGIN");
        const actorDisplayName = await lockActorScope(client, input, acceptedAt);
        if (!actorDisplayName) throw new Error("PMS Inbox reply actor scope is unavailable");

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
            failure("idempotency_conflict", "This reply command is already in progress.")
          );
        }

        const thread = await lockThread(client, input.propertyId, input.threadId);
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

        const route = await resolveRoute(client, config.emailReplyRoutes, input, thread);
        const attachments = await lockAttachments(client, input);
        const attachmentError = validateAttachments(attachments, input, route, acceptedAt);
        if (attachmentError)
          return commitResult(
            client,
            idempotencyId,
            { ok: false, error: attachmentError },
            acceptedAt,
          );

        const messageId = await insertMessage(
          client,
          input,
          idempotencyId,
          keyHash,
          actorDisplayName,
          route,
          acceptedAt,
        );
        const threadVersion = await advanceThread(client, input, acceptedAt);
        await claimAttachments(client, input, messageId, acceptedAt);
        const domainEventId = await insertAcceptedEvent(
          client,
          input,
          messageId,
          keyHash,
          route,
          acceptedAt,
        );
        await insertReplyAudit(
          client,
          input,
          messageId,
          idempotencyId,
          domainEventId,
          keyHash,
          route,
          acceptedAt,
        );
        if (thread.attentionState !== "needs_attention")
          await insertAttentionRestoredAudit(
            client,
            input,
            messageId,
            idempotencyId,
            domainEventId,
            keyHash,
            thread.attentionState,
            acceptedAt,
          );
        if (route.state === "ready")
          await insertDeliveryOutbox(
            client,
            input,
            messageId,
            domainEventId,
            keyHash,
            route.channel,
            acceptedAt,
          );

        const result: ReplySuccess = {
          ok: true,
          value: {
            propertyId: input.propertyId,
            threadId: input.threadId,
            messageId,
            threadVersion,
            delivery: deliveryProjection(route),
            acceptedAt: acceptedAt.toISOString(),
          },
        };
        return commitResult(client, idempotencyId, result, acceptedAt);
      } catch {
        await rollbackQuietly(client);
        throw new Error("PMS Inbox reply command failed");
      } finally {
        releaseQuietly(client);
      }
    },

    async close() {
      if (!ownsPool || closed) return;
      if (!pool.end) throw new Error("Owned PMS Inbox reply pool cannot be closed");
      await pool.end();
      closed = true;
    },
  };
}

function normalizeInput(input: ReplyInput): ReplyInput | null {
  const text = typeof input.text === "string" ? input.text.trim() : null;
  const attachmentMediaIds = Array.isArray(input.attachmentMediaIds)
    ? input.attachmentMediaIds.map((id) => id.trim())
    : [];
  if (
    !UUID.test(input.propertyId) ||
    !UUID.test(input.threadId) ||
    !UUID.test(input.organizationId) ||
    !UUID.test(input.actorUserId) ||
    !UUID.test(input.actorMembershipId) ||
    !input.idempotencyKey.trim() ||
    input.idempotencyKey.length > 200 ||
    !Number.isSafeInteger(input.expectedThreadVersion) ||
    input.expectedThreadVersion < 1 ||
    (text?.length ?? 0) > MAX_TEXT_LENGTH ||
    attachmentMediaIds.length > MAX_ATTACHMENTS ||
    attachmentMediaIds.some((id) => !UUID.test(id)) ||
    new Set(attachmentMediaIds).size !== attachmentMediaIds.length ||
    (!text && attachmentMediaIds.length === 0) ||
    !input.audit.requestId.trim() ||
    !input.audit.correlationId.trim() ||
    !validInstant(input.audit.requestedAt)
  )
    return null;
  return { ...input, idempotencyKey: input.idempotencyKey.trim(), text, attachmentMediaIds };
}

async function lockActorScope(
  client: PmsInboxReplyCommandClient,
  input: ReplyInput,
  acceptedAt: Date,
): Promise<string | null> {
  const scope = await client.query<ActorScopeRow>(
    `SELECT COALESCE(NULLIF(BTRIM(actor.name), ''), 'Property staff') AS "displayName"
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
  if (!scope.rows[0]) return null;

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
  return !applicable.some((row) => row.status === "suspended") &&
    applicable.some((row) => row.status === "active")
    ? scope.rows[0].displayName
    : null;
}

async function findReplay(
  client: PmsInboxReplyCommandClient,
  input: ReplyInput,
  keyHash: string,
  requestFingerprintHash: string,
): Promise<ReplyResult | null> {
  const result = await client.query<IdempotencyRow>(
    `SELECT id::text AS id, status,
            request_fingerprint_hash AS "requestFingerprintHash",
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
      "Idempotency key was already used for a different reply.",
    );
  if (row.status !== "completed")
    return failure("idempotency_conflict", "This reply command is already in progress.");
  const stored = record(row.idempotencyMetadata)?.["result"];
  const replay = parseStoredResult(stored);
  if (
    !replay ||
    row.responseStatusCode !== responseStatus(replay) ||
    row.responseBodyHash !== sha256(stableJson(replay))
  )
    throw new Error("PMS Inbox reply replay evidence is invalid");
  return replay;
}

async function reserveIdempotency(
  client: PmsInboxReplyCommandClient,
  input: ReplyInput,
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
  client: PmsInboxReplyCommandClient,
  propertyId: string,
  threadId: string,
): Promise<ThreadRow | null> {
  const result = await client.query<ThreadRow>(
    `SELECT thread.version::text, thread.source,
            thread.source_thread_id AS "sourceThreadId",
            thread.delivery_channel AS "deliveryChannel",
            thread.provider_channel AS "providerChannel",
            CASE WHEN thread.guest_booking_id IS NOT NULL
              THEN current_guest.email
              ELSE NULLIF(BTRIM(thread.guest_email), '')
            END AS "guestEmail",
            thread.attention_state AS "attentionState"
     FROM pms.message_threads thread
     LEFT JOIN booking.guest_bookings guest_booking
       ON guest_booking.id = thread.guest_booking_id
      AND guest_booking.property_id = thread.property_id
     LEFT JOIN LATERAL (
       SELECT NULLIF(BTRIM(booking_guest.email), '') AS email
       FROM booking.booking_guests booking_guest
       WHERE booking_guest.guest_booking_id = guest_booking.id
         AND NULLIF(BTRIM(booking_guest.email), '') IS NOT NULL
       ORDER BY CASE booking_guest.guest_role
                  WHEN 'booker' THEN 0
                  WHEN 'primary_guest' THEN 1
                  ELSE 2
                END,
                booking_guest.created_at,
                booking_guest.id
       LIMIT 1
     ) current_guest ON TRUE
     WHERE thread.property_id = $1::uuid AND thread.id = $2::uuid
     FOR UPDATE OF thread`,
    [propertyId, threadId],
  );
  return result.rows[0] ?? null;
}

async function resolveRoute(
  client: PmsInboxReplyCommandClient,
  emailReplyRoutes: PmsInboxEmailReplyRouteReadPort,
  input: ReplyInput,
  thread: ThreadRow,
): Promise<PmsInboxReplyRoute> {
  if (thread.deliveryChannel === "ota") {
    const providerChannel = trimmed(thread.providerChannel);
    if (thread.source !== "channex" || !providerChannel || !thread.sourceThreadId.trim())
      return {
        state: "held",
        channel: null,
        providerChannel,
        reasonCode: "provider_conversation_unavailable",
      };
    const connection = await client.query(
      `SELECT 1
       FROM pms.channel_connections
       WHERE property_id = $1::uuid AND provider = 'channex'
         AND connection_status IN ('connected', 'degraded') AND messaging_app_installed
       FOR SHARE`,
      [input.propertyId],
    );
    return (connection.rowCount ?? 0) > 0
      ? { state: "ready", channel: "ota", providerChannel, reasonCode: null }
      : {
          state: "held",
          channel: null,
          providerChannel,
          reasonCode: "channel_connection_inactive",
        };
  }
  const routes = await resolvePmsInboxEmailReplyRoutes(emailReplyRoutes, input.propertyId, [
    { threadId: input.threadId, guestEmail: trimmed(thread.guestEmail) },
  ]);
  return routes.get(input.threadId)!;
}

async function lockAttachments(
  client: PmsInboxReplyCommandClient,
  input: ReplyInput,
): Promise<AttachmentRow[]> {
  if (!input.attachmentMediaIds.length) return [];
  const result = await client.query<AttachmentRow>(
    `SELECT id::text AS "mediaId", property_id::text AS "propertyId",
            resource_product AS "resourceProduct", resource_type AS "resourceType",
            resource_id AS "resourceId", purpose, visibility,
            storage_kind AS "storageKind", storage_key AS "storageKey",
            lifecycle_status AS "lifecycleStatus", content_type AS "contentType",
            size_bytes::text AS "sizeBytes", original_filename AS "originalFilename",
            retained_until AS "retainedUntil",
            source_metadata ->> 'attachmentState' AS "attachmentState",
            deleted_at AS "deletedAt"
     FROM platform.media_objects
     WHERE id = ANY($1::uuid[]) AND property_id = $2::uuid
       AND resource_product = 'pms' AND resource_type = 'message_thread'
       AND resource_id = $3::uuid::text AND purpose = 'pms.messaging.attachment'
     FOR UPDATE`,
    [input.attachmentMediaIds, input.propertyId, input.threadId],
  );
  return result.rows;
}

function validateAttachments(
  rows: readonly AttachmentRow[],
  input: ReplyInput,
  route: PmsInboxReplyRoute,
  acceptedAt: Date,
): PmsInboxReplyError | null {
  if (rows.length !== input.attachmentMediaIds.length)
    return validationFailure("One or more attachments are unavailable.");
  const byId = new Map(rows.map((row) => [row.mediaId.toLowerCase(), row]));
  for (const mediaId of input.attachmentMediaIds) {
    const row = byId.get(mediaId.toLowerCase());
    if (
      !row ||
      !sameUuid(row.propertyId, input.propertyId) ||
      row.resourceProduct !== "pms" ||
      row.resourceType !== "message_thread" ||
      !sameUuid(row.resourceId, input.threadId) ||
      row.purpose !== "pms.messaging.attachment" ||
      row.visibility !== "private" ||
      row.storageKind !== "vayada_managed" ||
      !row.storageKey?.startsWith("private/") ||
      row.lifecycleStatus !== "staged" ||
      row.attachmentState !== "orphan" ||
      row.deletedAt !== null ||
      !row.retainedUntil ||
      !Number.isFinite(new Date(row.retainedUntil).getTime()) ||
      new Date(row.retainedUntil) <= acceptedAt ||
      !trimmed(row.originalFilename)
    )
      return validationFailure("One or more attachments are unavailable.");
    const contentType = trimmed(row.contentType)?.toLowerCase();
    if (!contentType || !ALLOWED_ATTACHMENT_TYPES.has(contentType))
      return {
        code: "unsupported_attachment_type",
        message: "One or more attachment types are not supported.",
      };
    const size = Number(row.sizeBytes);
    if (!Number.isSafeInteger(size) || size <= 0)
      return validationFailure("One or more attachments are unavailable.");
    if (size > maxAttachmentBytes(route))
      return { code: "attachment_too_large", message: "One or more attachments are too large." };
  }
  return null;
}

function maxAttachmentBytes(route: PmsInboxReplyRoute): number {
  const providerChannel = trimmed(route.providerChannel)?.toLowerCase();
  if (["booking.com", "booking_com", "bookingcom"].includes(providerChannel ?? ""))
    return BOOKING_COM_MAX_ATTACHMENT_BYTES;
  if (["expedia", "expedia.com", "expedia_com", "expediacom"].includes(providerChannel ?? ""))
    return EXPEDIA_MAX_ATTACHMENT_BYTES;
  return DEFAULT_MAX_ATTACHMENT_BYTES;
}

async function insertMessage(
  client: PmsInboxReplyCommandClient,
  input: ReplyInput,
  idempotencyId: string,
  keyHash: string,
  actorDisplayName: string,
  route: PmsInboxReplyRoute,
  acceptedAt: Date,
): Promise<string> {
  const result = await client.query<InsertedIdRow>(
    `INSERT INTO pms.messages
       (property_id, thread_id, source_message_id, direction, sender_type,
        sender_user_id, sender_display_name, body, sent_at, received_at,
        raw_payload, pii_retention_until, delivery_state, delivery_channel,
        delivery_reason_code, accepted_idempotency_key_id)
     VALUES
       ($1::uuid, $2::uuid, $3, 'outbound', 'property_user', $4::uuid, $5, $6,
        $7::timestamptz, $7::timestamptz, '{}'::jsonb,
        ($7::timestamptz + interval '1 year')::date, $8, $9, $10, $11::uuid)
     RETURNING id::text AS id`,
    [
      input.propertyId,
      input.threadId,
      `manual-reply:${sha256(`${input.propertyId}:${input.threadId}:${keyHash}`)}`,
      input.actorUserId,
      actorDisplayName,
      input.text ?? "",
      acceptedAt,
      route.state === "ready" ? "queued" : "held",
      route.state === "ready" ? route.channel : null,
      route.state === "held" ? route.reasonCode : null,
      idempotencyId,
    ],
  );
  const id = result.rows[0]?.id;
  if (!id) throw new Error("PMS Inbox reply message was not inserted");
  return id;
}

async function advanceThread(
  client: PmsInboxReplyCommandClient,
  input: ReplyInput,
  acceptedAt: Date,
): Promise<number> {
  const result = await client.query<{ version: string | number }>(
    `UPDATE pms.message_threads
     SET version = version + 1,
         attention_state = 'needs_attention',
         follow_up_at = NULL, follow_up_by_membership_id = NULL, follow_up_job_id = NULL,
         done_at = NULL, done_by_membership_id = NULL, done_reason = NULL,
         last_message_at = $4::timestamptz,
         last_message_preview = CASE WHEN $5::text IS NULL THEN NULL ELSE LEFT($5, 500) END,
         last_message_direction = 'outbound', updated_at = $4::timestamptz
     WHERE property_id = $1::uuid AND id = $2::uuid AND version = $3::bigint
     RETURNING version::text`,
    [input.propertyId, input.threadId, input.expectedThreadVersion, acceptedAt, input.text],
  );
  const version = result.rows[0] ? safeVersion(result.rows[0].version) : 0;
  if (version !== input.expectedThreadVersion + 1)
    throw new Error("PMS Inbox reply thread version did not advance once");
  return version;
}

async function claimAttachments(
  client: PmsInboxReplyCommandClient,
  input: ReplyInput,
  messageId: string,
  acceptedAt: Date,
): Promise<void> {
  if (!input.attachmentMediaIds.length) return;
  const claimed = await client.query(
    `UPDATE platform.media_objects
     SET lifecycle_status = 'active', retained_until = NULL,
         source_metadata = source_metadata || jsonb_build_object(
           'attachmentState', 'claimed', 'claimedByMessageId', $2::text
         ),
         updated_at = $3::timestamptz
     WHERE id = ANY($1::uuid[]) AND property_id = $4::uuid
       AND resource_product = 'pms' AND resource_type = 'message_thread'
       AND resource_id = $5::uuid::text AND purpose = 'pms.messaging.attachment'
       AND visibility = 'private' AND storage_kind = 'vayada_managed'
       AND lifecycle_status = 'staged' AND retained_until > $3::timestamptz
       AND source_metadata ->> 'attachmentState' = 'orphan'`,
    [input.attachmentMediaIds, messageId, acceptedAt, input.propertyId, input.threadId],
  );
  if ((claimed.rowCount ?? 0) !== input.attachmentMediaIds.length)
    throw new Error("PMS Inbox reply attachments were not claimed exactly once");

  const attached = await client.query(
    `INSERT INTO pms.message_attachments
       (property_id, message_id, platform_media_object_id, filename, content_type, size_bytes)
     SELECT $1::uuid, $2::uuid, media.id, media.original_filename,
            lower(BTRIM(media.content_type)), media.size_bytes::integer
     FROM unnest($3::uuid[]) WITH ORDINALITY requested(id, position)
     JOIN platform.media_objects media ON media.id = requested.id
     ORDER BY requested.position`,
    [input.propertyId, messageId, input.attachmentMediaIds],
  );
  if ((attached.rowCount ?? 0) !== input.attachmentMediaIds.length)
    throw new Error("PMS Inbox reply attachments were not linked exactly once");
}

async function insertAcceptedEvent(
  client: PmsInboxReplyCommandClient,
  input: ReplyInput,
  messageId: string,
  keyHash: string,
  route: PmsInboxReplyRoute,
  acceptedAt: Date,
): Promise<string> {
  const result = await client.query<InsertedIdRow>(
    `INSERT INTO platform.domain_events
       (source_system, event_key, event_type, occurred_at, tenant_scope, property_id,
        resource_product, resource_type, resource_id, actor_type, actor_user_id,
        correlation_id, causation_id, idempotency_key_hash, payload, event_metadata,
        privacy_scope)
     VALUES
       ('pms', $1, 'pms.inbox.reply.accepted', $2::timestamptz, 'property', $3::uuid,
        'pms', 'message', $4::text, 'user', $5::uuid, $6, $7, $8, $9::jsonb,
        $10::jsonb, 'confidential')
     RETURNING id::text AS id`,
    [
      `pms.inbox.reply.accepted:message:${messageId}:v1`,
      acceptedAt,
      input.propertyId,
      messageId,
      input.actorUserId,
      input.audit.correlationId,
      input.audit.requestId,
      keyHash,
      JSON.stringify({
        propertyId: input.propertyId,
        threadId: input.threadId,
        messageId,
        deliveryState: route.state === "ready" ? "queued" : "held",
        deliveryChannel: route.state === "ready" ? route.channel : null,
        deliveryReasonCode: route.state === "held" ? route.reasonCode : null,
      }),
      JSON.stringify({
        contractVersion: "native-guest-inbox.v2",
        attachmentCount: input.attachmentMediaIds.length,
        hasText: Boolean(input.text),
      }),
    ],
  );
  const id = result.rows[0]?.id;
  if (!id) throw new Error("PMS Inbox reply domain event was not inserted");
  return id;
}

async function insertReplyAudit(
  client: PmsInboxReplyCommandClient,
  input: ReplyInput,
  messageId: string,
  idempotencyId: string,
  domainEventId: string,
  keyHash: string,
  route: PmsInboxReplyRoute,
  acceptedAt: Date,
): Promise<void> {
  const action = route.state === "ready" ? "pms.inbox.reply.accepted" : "pms.inbox.reply.held";
  await client.query(
    `INSERT INTO platform.product_audit_events
       (audit_key, product, action, occurred_at, tenant_scope, property_id, actor_type,
        actor_user_id, target_resource_product, target_resource_type, target_resource_id,
        secondary_resource_product, secondary_resource_type, secondary_resource_id,
        domain_event_id, idempotency_key_id, correlation_id, causation_id,
        redacted_payload, audit_metadata, retention_class, privacy_scope)
     VALUES
       ($1, 'pms', $2, $3::timestamptz, 'property', $4::uuid, 'user', $5::uuid,
        'pms', 'message', $6::text, 'pms', 'message_thread', $7::text,
        $8::uuid, $9::uuid, $10, $11, $12::jsonb, $13::jsonb,
        'guest_pii', 'confidential')`,
    [
      `${action}:message:${messageId}:key:${keyHash}:v1`,
      action,
      acceptedAt,
      input.propertyId,
      input.actorUserId,
      messageId,
      input.threadId,
      domainEventId,
      idempotencyId,
      input.audit.correlationId,
      input.audit.requestId,
      JSON.stringify({
        deliveryState: route.state === "ready" ? "queued" : "held",
        deliveryChannel: route.state === "ready" ? route.channel : null,
        deliveryReasonCode: route.state === "held" ? route.reasonCode : null,
      }),
      JSON.stringify({
        contractVersion: "native-guest-inbox.v2",
        attachmentCount: input.attachmentMediaIds.length,
        hasText: Boolean(input.text),
        actorMembershipId: input.actorMembershipId,
      }),
    ],
  );
}

async function insertAttentionRestoredAudit(
  client: PmsInboxReplyCommandClient,
  input: ReplyInput,
  messageId: string,
  idempotencyId: string,
  domainEventId: string,
  keyHash: string,
  previousState: "follow_up" | "done",
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
       ($1, 'pms', 'pms.inbox.thread.attention_restored_by_reply', $2::timestamptz,
        'property', $3::uuid, 'user', $4::uuid, 'pms', 'message_thread', $5::text,
        'pms', 'message', $6::text, $7::uuid, $8::uuid, $9, $10,
        $11::jsonb, $12::jsonb, 'guest_pii', 'confidential')`,
    [
      `pms.inbox.thread.attention_restored_by_reply:thread:${input.threadId}:message:${messageId}:key:${keyHash}:v1`,
      acceptedAt,
      input.propertyId,
      input.actorUserId,
      input.threadId,
      messageId,
      domainEventId,
      idempotencyId,
      input.audit.correlationId,
      input.audit.requestId,
      JSON.stringify({ previousState, attentionState: "needs_attention" }),
      JSON.stringify({ actorMembershipId: input.actorMembershipId }),
    ],
  );
}

async function insertDeliveryOutbox(
  client: PmsInboxReplyCommandClient,
  input: ReplyInput,
  messageId: string,
  domainEventId: string,
  keyHash: string,
  channel: "ota" | "email",
  acceptedAt: Date,
): Promise<void> {
  await client.query(
    `INSERT INTO platform.outbox_events
       (domain_event_id, outbox_key, destination, event_type, tenant_scope, property_id,
        resource_product, resource_type, resource_id, status, priority, max_attempts,
        available_at, correlation_id, idempotency_key_hash, payload, outbox_metadata,
        created_at, updated_at)
     VALUES
       ($1::uuid, $2, 'pms.guest-message.deliver', $3, 'property', $4::uuid,
        'pms', 'message', $5::text, 'pending', 0, 5, $6::timestamptz, $7, $8,
        $9::jsonb, $10::jsonb, $6::timestamptz, $6::timestamptz)`,
    [
      domainEventId,
      `${DELIVERY_EVENT_TYPE}:message:${messageId}:manual-send:v1`,
      DELIVERY_EVENT_TYPE,
      input.propertyId,
      messageId,
      acceptedAt,
      input.audit.correlationId,
      keyHash,
      JSON.stringify({
        propertyId: input.propertyId,
        threadId: input.threadId,
        messageId,
        channel,
      }),
      JSON.stringify({ contractVersion: "native-guest-inbox.v2", source: "manual_reply" }),
    ],
  );
}

async function commitResult(
  client: PmsInboxReplyCommandClient,
  idempotencyId: string,
  result: ReplyResult,
  acceptedAt: Date,
): Promise<ReplyResult> {
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
      result.ok ? "message" : null,
      result.ok ? result.value.messageId : null,
      acceptedAt,
      JSON.stringify(result),
    ],
  );
  if ((completed.rowCount ?? 0) !== 1)
    throw new Error("PMS Inbox reply idempotency record was not completed once");
  await client.query("COMMIT");
  return result;
}

function parseStoredResult(value: unknown): ReplyResult | null {
  const root = record(value);
  if (!root || typeof root["ok"] !== "boolean") return null;
  if (root["ok"] === false) {
    const error = record(root["error"]);
    const code = error?.["code"];
    if (
      typeof code !== "string" ||
      ![
        "validation_failed",
        "thread_not_found",
        "thread_version_conflict",
        "idempotency_conflict",
        "attachment_too_large",
        "unsupported_attachment_type",
      ].includes(code) ||
      typeof error?.["message"] !== "string" ||
      (error["currentVersion"] !== undefined && !Number.isSafeInteger(error["currentVersion"]))
    )
      return null;
    return { ok: false, error: error as PmsInboxReplyError };
  }
  const stored = record(root["value"]);
  const delivery = record(stored?.["delivery"]);
  if (
    !stored ||
    typeof stored["propertyId"] !== "string" ||
    typeof stored["threadId"] !== "string" ||
    typeof stored["messageId"] !== "string" ||
    !Number.isSafeInteger(stored["threadVersion"]) ||
    typeof stored["acceptedAt"] !== "string" ||
    !delivery ||
    !["queued", "held"].includes(String(delivery["state"])) ||
    (delivery["channel"] !== null && !["ota", "email"].includes(String(delivery["channel"]))) ||
    (delivery["reasonCode"] !== null && typeof delivery["reasonCode"] !== "string") ||
    delivery["providerAcknowledgedAt"] !== null
  )
    return null;
  return { ok: true, value: stored as ReplySuccess["value"] };
}

function deliveryProjection(route: PmsInboxReplyRoute): NonNullable<PmsInboxMessage["delivery"]> {
  return route.state === "ready"
    ? {
        state: "queued",
        channel: route.channel,
        reasonCode: null,
        providerAcknowledgedAt: null,
      }
    : {
        state: "held",
        channel: null,
        reasonCode: route.reasonCode,
        providerAcknowledgedAt: null,
      };
}

function replyFingerprint(input: ReplyInput): string {
  return stableJson({
    operation: OPERATION,
    propertyId: input.propertyId,
    threadId: input.threadId,
    body: {
      expectedThreadVersion: input.expectedThreadVersion,
      text: input.text,
      attachmentMediaIds: input.attachmentMediaIds,
    },
  });
}

function responseStatus(result: ReplyResult): number {
  if (result.ok) return 202;
  if (result.error.code === "thread_not_found") return 404;
  if (
    result.error.code === "thread_version_conflict" ||
    result.error.code === "idempotency_conflict"
  )
    return 409;
  if (result.error.code === "attachment_too_large") return 413;
  if (result.error.code === "unsupported_attachment_type") return 415;
  return 400;
}

function failure(
  code: PmsInboxReplyError["code"],
  message: string,
  currentVersion?: number,
): ReplyResult {
  return {
    ok: false,
    error: { code, message, ...(currentVersion === undefined ? {} : { currentVersion }) },
  };
}

function validationFailure(message: string): PmsInboxReplyError {
  return { code: "validation_failed", message };
}

function safeVersion(value: string | number): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1)
    throw new Error("PMS Inbox thread version is invalid");
  return parsed;
}

function trimmed(value: string | null): string | null {
  const normalized = value?.trim();
  return normalized ? normalized : null;
}

function sameUuid(left: string | null, right: string): boolean {
  return left?.toLowerCase() === right.toLowerCase();
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

async function rollbackQuietly(client: PmsInboxReplyCommandClient): Promise<void> {
  try {
    await client.query("ROLLBACK");
  } catch {
    // Preserve the original failure.
  }
}

function releaseQuietly(client: PmsInboxReplyCommandClient): void {
  try {
    client.release();
  } catch {
    // Preserve the command result.
  }
}
