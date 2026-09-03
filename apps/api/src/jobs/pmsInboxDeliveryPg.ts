import pg, { type QueryResultRow } from "pg";

import type { PmsInboxEmailReplyRouteReadPort } from "../domains/pmsInbox.js";
import { resolvePmsInboxEmailReplyRoutes } from "../domains/pmsInboxEmailReplyRoutes.js";
import { lockPmsInboxReplyActorScope } from "../domains/pmsInboxProviderActionCommand.js";
import {
  PMS_INBOX_DELIVERY_JOB_TYPE,
  PMS_INBOX_DELIVERY_QUEUE,
  pmsInboxProviderIdempotencyReference,
  type PmsInboxDeliveryMediaPort,
  type PmsInboxDeliveryCompletion,
  type PmsInboxDeliveryJob,
  type PmsInboxDeliveryStore,
  type PmsInboxPreparedDelivery,
} from "../domains/pmsInboxDelivery.js";

export type PmsInboxDeliveryQueryable = {
  query<T extends QueryResultRow = QueryResultRow>(
    text: string,
    values?: readonly unknown[],
  ): Promise<{ rows: T[]; rowCount?: number | null }>;
};

type Client = PmsInboxDeliveryQueryable & { release(): void };
type Pool = PmsInboxDeliveryQueryable & {
  connect(): Promise<Client>;
  end?(): Promise<void>;
};

export type PgPmsInboxDeliveryStore = PmsInboxDeliveryStore & { close(): Promise<void> };

export function createPgPmsInboxDeliveryStore(config: {
  connectionString: string;
  media: PmsInboxDeliveryMediaPort;
  emailReplyRoutes: PmsInboxEmailReplyRouteReadPort;
  pool?: Pool;
  max?: number;
}): PgPmsInboxDeliveryStore {
  if (!config.pool && !config.connectionString.trim())
    throw new Error("PMS Inbox delivery connectionString must not be empty");
  const ownsPool = !config.pool;
  const pool =
    config.pool ?? new pg.Pool({ connectionString: config.connectionString, max: config.max });
  let closed = false;
  return {
    claim: (workerId) => claimPmsInboxDeliveryJob(pool, workerId),
    prepare: (job) =>
      transaction(pool, (client) =>
        preparePmsInboxDeliveryJob(client, job, {
          media: config.media,
          emailReplyRoutes: config.emailReplyRoutes,
        }),
      ),
    complete: (job, completion) =>
      transaction(pool, (client) => completePmsInboxDeliveryJob(client, job, completion)),
    async close() {
      if (!ownsPool || closed) return;
      if (!pool.end) throw new Error("Owned PMS Inbox delivery pool cannot be closed");
      await pool.end();
      closed = true;
    },
  };
}

async function transaction<T>(pool: Pool, work: (client: Client) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await work(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

export async function claimPmsInboxDeliveryJob(
  pool: PmsInboxDeliveryQueryable,
  workerId: string,
): Promise<PmsInboxDeliveryJob | null> {
  const result = await pool.query<PmsInboxDeliveryJob>(
    `UPDATE platform.jobs job
     SET status = 'running', attempts_count = attempts_count + 1,
         locked_at = now(), locked_by = $3, updated_at = now()
     FROM (
       SELECT id
       FROM platform.jobs
       WHERE queue_name = $1 AND job_type = $2
         AND (
           status = 'pending'
           OR (status = 'running' AND locked_at < now() - interval '5 minutes')
         )
         AND run_after <= now() AND attempts_count < max_attempts
       ORDER BY priority DESC, run_after, created_at
       FOR UPDATE SKIP LOCKED
       LIMIT 1
     ) candidate
     WHERE job.id = candidate.id
     RETURNING job.id::text AS id, job.locked_by AS "workerId",
       job.property_id::text AS "propertyId", job.resource_id AS "messageId",
       job.attempts_count AS "attemptNumber", job.max_attempts AS "maxAttempts",
       job.correlation_id AS "correlationId"`,
    [PMS_INBOX_DELIVERY_QUEUE, PMS_INBOX_DELIVERY_JOB_TYPE, workerId],
  );
  const job = result.rows[0] ?? null;
  if (!job) return null;

  await pool.query(
    `UPDATE platform.job_attempts
     SET status = 'timed_out', finished_at = now(),
         duration_ms = GREATEST(
           0, floor(extract(epoch FROM (now() - started_at)) * 1000)
         )::integer,
         error_type = 'worker_timeout', error_message = 'Worker lease expired.'
     WHERE job_id = $1::uuid AND attempt_number < $2 AND status = 'running'`,
    [job.id, job.attemptNumber],
  );
  await pool.query(
    `INSERT INTO platform.job_attempts (
       job_id, attempt_number, status, worker_id, started_at
     )
     VALUES ($1::uuid, $2, 'running', $3, now())
     ON CONFLICT (job_id, attempt_number) DO NOTHING`,
    [job.id, job.attemptNumber, workerId],
  );
  return job;
}

type DeliveryRow = {
  threadId: string;
  threadDeliveryChannel: string;
  organizationId: string | null;
  actorMembershipId: string | null;
  actorUserId: string | null;
  body: string;
  deliveryState: string;
  deliveryChannel: "ota" | "email";
  source: string;
  sourceThreadId: string;
  providerChannel: string | null;
  conversationContextState: string;
  bookingChannel: string | null;
  guestEmail: string | null;
  accessReady: boolean;
  channexReady: boolean;
  currentAttemptId: string | null;
  currentAttemptOutcome: string | null;
  currentProviderReference: string | null;
};

type AttachmentRow = {
  filename: string | null;
  contentType: string | null;
  sizeBytes: string | number | null;
  bucketName: string | null;
  storageKey: string | null;
  checksumSha256: string | null;
  mediaReady: boolean;
};

const ALLOWED_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/gif",
  "image/heic",
  "image/heif",
  "application/pdf",
]);

export async function preparePmsInboxDeliveryJob(
  client: PmsInboxDeliveryQueryable,
  job: PmsInboxDeliveryJob,
  options: { emailReplyRoutes: PmsInboxEmailReplyRouteReadPort; media: PmsInboxDeliveryMediaPort },
): Promise<PmsInboxPreparedDelivery> {
  const lease = await client.query(
    `SELECT 1 FROM platform.jobs
     WHERE id = $1::uuid AND status = 'running' AND locked_by = $2
       AND attempts_count = $3
     FOR UPDATE`,
    [job.id, job.workerId, job.attemptNumber],
  );
  if (!lease.rows[0]) throw new Error("PMS Inbox delivery job lease was lost");

  const result = await client.query<DeliveryRow>(
    `SELECT message.body, message.delivery_state AS "deliveryState",
            thread.id::text AS "threadId", thread.delivery_channel AS "threadDeliveryChannel",
            message.delivery_channel AS "deliveryChannel", thread.source,
            thread.source_thread_id AS "sourceThreadId",
            thread.provider_channel AS "providerChannel",
            thread.conversation_context_state AS "conversationContextState",
            booking.booking_channel AS "bookingChannel",
            guest.email AS "guestEmail",
            property.lifecycle_status = 'active' AS "accessReady",
            source.event_metadata ->> 'organizationId' AS "organizationId",
            source.event_metadata ->> 'actorMembershipId' AS "actorMembershipId",
            source.actor_user_id::text AS "actorUserId",
            EXISTS (
              SELECT 1 FROM pms.channel_connections connection
              WHERE connection.property_id = message.property_id
                AND connection.provider = 'channex'
                AND connection.connection_status IN ('connected', 'degraded')
                AND connection.messaging_app_installed
            ) AS "channexReady",
            attempt.id::text AS "currentAttemptId", attempt.outcome AS "currentAttemptOutcome",
            attempt.provider_reference AS "currentProviderReference"
     FROM pms.messages message
     JOIN platform.jobs job ON job.id = $3::uuid AND job.property_id = message.property_id
     LEFT JOIN platform.domain_events source ON source.id = job.source_domain_event_id
       AND source.property_id = message.property_id AND source.resource_id = message.id::text
       AND source.event_type = 'pms.inbox.reply.accepted'
       AND source.actor_user_id = message.sender_user_id
     JOIN hotel_catalog.properties property ON property.id = message.property_id
     JOIN pms.message_threads thread
       ON thread.id = message.thread_id AND thread.property_id = message.property_id
     LEFT JOIN booking.guest_bookings booking
       ON booking.id = thread.guest_booking_id AND booking.property_id = thread.property_id
     LEFT JOIN LATERAL (
       SELECT NULLIF(BTRIM(booking_guest.email), '') AS email
       FROM booking.booking_guests booking_guest
       WHERE booking_guest.guest_booking_id = booking.id
         AND NULLIF(BTRIM(booking_guest.email), '') IS NOT NULL
       ORDER BY CASE booking_guest.guest_role WHEN 'booker' THEN 0
                    WHEN 'primary_guest' THEN 1 ELSE 2 END,
                booking_guest.created_at, booking_guest.id LIMIT 1
     ) guest ON TRUE
     LEFT JOIN pms.message_delivery_attempts attempt
       ON attempt.id = message.current_delivery_attempt_id
      AND attempt.message_id = message.id AND attempt.property_id = message.property_id
     WHERE message.id = $1::uuid AND message.property_id = $2::uuid
       AND message.direction = 'outbound'
     FOR UPDATE OF message, thread`,
    [job.messageId, job.propertyId, job.id],
  );
  const row = result.rows[0];
  if (!row) return { state: "blocked", failure: "resource_deleted" };
  if (
    row.deliveryState === "sent" &&
    row.currentAttemptId &&
    row.currentAttemptOutcome === "accepted" &&
    row.currentProviderReference
  )
    return {
      state: "accepted",
      attemptId: row.currentAttemptId,
      providerReference: row.currentProviderReference,
    };
  if (row.currentAttemptId && row.currentAttemptOutcome === "running")
    return {
      state: "blocked",
      failure: "ambiguous_provider_outcome",
      attemptId: row.currentAttemptId,
    };
  if (
    !row.accessReady ||
    !row.organizationId ||
    !row.actorMembershipId ||
    !row.actorUserId ||
    !(await lockPmsInboxReplyActorScope(
      client,
      {
        propertyId: job.propertyId,
        organizationId: row.organizationId,
        actorUserId: row.actorUserId,
        actorMembershipId: row.actorMembershipId,
      },
      new Date(),
    ))
  )
    return { state: "blocked", failure: "access_unavailable" };
  const adapter = routeAdapter(row);
  if (!adapter) return { state: "blocked", failure: "provider_configuration_unavailable" };
  if (adapter === "resend") {
    const routes = await resolvePmsInboxEmailReplyRoutes(options.emailReplyRoutes, job.propertyId, [
      { threadId: row.threadId, guestEmail: row.guestEmail },
    ]);
    const route = routes.get(row.threadId);
    if (route?.state !== "ready" || route.channel !== "email")
      return { state: "blocked", failure: "provider_configuration_unavailable" };
  }
  let attachments: Awaited<ReturnType<typeof loadAttachments>>;
  try {
    attachments = await loadAttachments(client, job, row, options.media);
  } catch {
    return { state: "blocked", failure: "transient_provider_failure" };
  }
  if (!attachments) return { state: "blocked", failure: "invalid_delivery_payload" };
  const attempt = await client.query<{ id: string }>(
    `INSERT INTO pms.message_delivery_attempts
       (property_id, message_id, attempt_number, resolved_channel, adapter,
        outcome, scheduled_at, started_at)
     VALUES ($1::uuid, $2::uuid, $3, $4, $5, 'running', now(), now())
     RETURNING id::text AS id`,
    [job.propertyId, job.messageId, job.attemptNumber, row.deliveryChannel, adapter],
  );
  const attemptId = attempt.rows[0]?.id;
  if (!attemptId) throw new Error("PMS Inbox delivery attempt was not created");
  const projected = await client.query(
    `UPDATE pms.messages SET current_delivery_attempt_id = $3::uuid
     WHERE id = $1::uuid AND property_id = $2::uuid
       AND delivery_state IN ('queued', 'retrying')`,
    [job.messageId, job.propertyId, attemptId],
  );
  if (projected.rowCount !== 1)
    throw new Error("PMS Inbox delivery attempt was not projected onto its message");
  return {
    state: "ready",
    adapter,
    attemptId,
    input: {
      messageId: job.messageId,
      providerIdempotencyReference: pmsInboxProviderIdempotencyReference(job.messageId),
      channel: row.deliveryChannel,
      providerConversationId: adapter === "channex" ? row.sourceThreadId : null,
      recipientEmail: adapter === "resend" ? row.guestEmail?.trim() || null : null,
      subject: "A message from your accommodation",
      text: row.body,
      attachments,
    },
  };
}

function routeAdapter(row: DeliveryRow): "channex" | "resend" | null {
  if (!["queued", "retrying"].includes(row.deliveryState)) return null;
  if (row.deliveryChannel !== row.threadDeliveryChannel) return null;
  if (row.deliveryChannel === "ota")
    return row.source === "channex" &&
      row.sourceThreadId.trim() &&
      row.providerChannel?.trim() &&
      row.conversationContextState !== "inquiry" &&
      row.channexReady
      ? "channex"
      : null;
  return row.source === "manual" &&
    row.bookingChannel === "direct" &&
    Boolean(row.guestEmail?.trim())
    ? "resend"
    : null;
}

async function loadAttachments(
  client: PmsInboxDeliveryQueryable,
  job: PmsInboxDeliveryJob,
  delivery: DeliveryRow,
  media: PmsInboxDeliveryMediaPort,
) {
  const result = await client.query<AttachmentRow>(
    `SELECT attachment.filename, lower(attachment.content_type) AS "contentType",
            attachment.size_bytes::text AS "sizeBytes", object.bucket AS "bucketName",
            object.storage_key AS "storageKey", object.checksum_sha256 AS "checksumSha256",
            COALESCE(object.visibility = 'private' AND object.storage_kind = 'vayada_managed'
              AND object.lifecycle_status = 'active' AND object.deleted_at IS NULL
              AND object.property_id = attachment.property_id
              AND object.resource_product = 'pms' AND object.resource_type = 'message_thread'
              AND object.resource_id = $3 AND object.purpose = 'pms.messaging.attachment'
              AND object.source_metadata ->> 'attachmentState' = 'claimed'
              AND object.source_metadata ->> 'claimedByMessageId' = attachment.message_id::text
              AND object.size_bytes = attachment.size_bytes
              AND lower(object.content_type) = lower(attachment.content_type), FALSE)
              AS "mediaReady"
     FROM pms.message_attachments attachment
     LEFT JOIN platform.media_objects object ON object.id = attachment.platform_media_object_id
     WHERE attachment.message_id = $1::uuid AND attachment.property_id = $2::uuid
     ORDER BY attachment.created_at, attachment.id`,
    [job.messageId, job.propertyId, delivery.threadId],
  );
  const limit =
    delivery.deliveryChannel === "ota" ? providerLimit(delivery.providerChannel) : 25 * 1024 * 1024;
  if (result.rows.length > 10) return null;
  const contents = [];
  for (const row of result.rows) {
    const size = Number(row.sizeBytes);
    if (
      !row.mediaReady ||
      !row.filename?.trim() ||
      !row.contentType ||
      !ALLOWED_TYPES.has(row.contentType) ||
      !Number.isSafeInteger(size) ||
      size < 1 ||
      size > limit ||
      !row.bucketName ||
      !row.storageKey?.startsWith("private/") ||
      !row.checksumSha256?.match(/^[0-9a-f]{64}$/)
    )
      return null;
    const bytes = await media.read({
      bucketName: row.bucketName,
      storageKey: row.storageKey,
      expectedSizeBytes: size,
      expectedChecksumSha256: row.checksumSha256,
    });
    if (bytes.byteLength !== size) return null;
    contents.push({ filename: row.filename.trim(), contentType: row.contentType, bytes });
  }
  return contents;
}

function providerLimit(channel: string | null): number {
  const normalized = channel?.trim().toLowerCase();
  if (["booking.com", "booking_com", "bookingcom"].includes(normalized ?? ""))
    return 8 * 1024 * 1024;
  if (["expedia", "expedia.com", "expedia_com", "expediacom"].includes(normalized ?? ""))
    return 10 * 1024 * 1024;
  return 25 * 1024 * 1024;
}

export async function completePmsInboxDeliveryJob(
  client: PmsInboxDeliveryQueryable,
  job: PmsInboxDeliveryJob,
  completion: PmsInboxDeliveryCompletion,
): Promise<boolean> {
  const lease = await client.query(
    `SELECT 1 FROM platform.jobs job
     JOIN platform.job_attempts attempt
       ON attempt.job_id = job.id AND attempt.attempt_number = $3
      AND attempt.status = 'running' AND attempt.worker_id = $2
     WHERE job.id = $1::uuid AND job.status = 'running'
       AND job.locked_by = $2 AND job.attempts_count = $3
     FOR UPDATE OF job, attempt`,
    [job.id, job.workerId, job.attemptNumber],
  );
  if (!lease.rows[0]) return false;

  if (completion.outcome === "accepted") {
    await acceptProviderAttempt(client, job, completion);
    await projectMessage(client, job, "sent", null, completion.attemptId);
    await finishPlatformWork(client, job, "succeeded", null);
    await insertDeliveryAudit(client, job, "succeeded", null, completion.attemptId);
    return true;
  }

  if (completion.attemptId) await failProviderAttempt(client, job, completion);
  if (completion.projection.state)
    await projectMessage(
      client,
      job,
      completion.projection.state,
      completion.projection.reasonCode,
      completion.attemptId,
    );
  const status = completion.projection.retry
    ? "pending"
    : completion.projection.deadLetter
      ? "dead_lettered"
      : "failed";
  await finishPlatformWork(client, job, status, completion);
  if (completion.projection.deadLetter) await insertDeadLetter(client, job, completion);
  await insertDeliveryAudit(client, job, status, completion, completion.attemptId);
  return true;
}

async function acceptProviderAttempt(
  client: PmsInboxDeliveryQueryable,
  job: PmsInboxDeliveryJob,
  completion: Extract<PmsInboxDeliveryCompletion, { outcome: "accepted" }>,
) {
  const updated = await client.query(
    `UPDATE pms.message_delivery_attempts
     SET outcome = 'accepted', completed_at = now(), provider_reference = $4
     WHERE id = $1::uuid AND message_id = $2::uuid AND property_id = $3::uuid
       AND outcome = 'running'`,
    [completion.attemptId, job.messageId, job.propertyId, completion.providerReference],
  );
  if (updated.rowCount === 1) return;
  const existing = await client.query(
    `SELECT 1 FROM pms.message_delivery_attempts
     WHERE id = $1::uuid AND message_id = $2::uuid AND property_id = $3::uuid
       AND outcome = 'accepted' AND provider_reference = $4`,
    [completion.attemptId, job.messageId, job.propertyId, completion.providerReference],
  );
  if (!existing.rows[0]) throw new Error("PMS Inbox accepted delivery attempt is inconsistent");
}

async function failProviderAttempt(
  client: PmsInboxDeliveryQueryable,
  job: PmsInboxDeliveryJob,
  completion: Extract<PmsInboxDeliveryCompletion, { outcome: "failed" }>,
) {
  const updated = await client.query(
    `UPDATE pms.message_delivery_attempts
     SET outcome = $4, completed_at = now(), failure_code = $5,
         failure_metadata = jsonb_build_object('providerRequestId', $6::text)
     WHERE id = $1::uuid AND message_id = $2::uuid AND property_id = $3::uuid
       AND outcome = 'running'`,
    [
      completion.attemptId,
      job.messageId,
      job.propertyId,
      completion.projection.attemptOutcome,
      completion.failure,
      completion.providerRequestId ?? null,
    ],
  );
  if (updated.rowCount !== 1)
    throw new Error("PMS Inbox failed delivery attempt was not completed exactly once");
}

async function projectMessage(
  client: PmsInboxDeliveryQueryable,
  job: PmsInboxDeliveryJob,
  state: "retrying" | "sent" | "held" | "failed",
  reasonCode: string | null,
  attemptId: string | null,
) {
  const projected = await client.query(
    `UPDATE pms.messages
     SET delivery_state = $3, delivery_reason_code = $4,
         current_delivery_attempt_id = COALESCE($5::uuid, current_delivery_attempt_id)
     WHERE id = $1::uuid AND property_id = $2::uuid AND direction = 'outbound'`,
    [job.messageId, job.propertyId, state, reasonCode, attemptId],
  );
  if (projected.rowCount !== 1)
    throw new Error("PMS Inbox delivery projection was not updated exactly once");
}

async function finishPlatformWork(
  client: PmsInboxDeliveryQueryable,
  job: PmsInboxDeliveryJob,
  status: "pending" | "succeeded" | "failed" | "dead_lettered",
  completion: Extract<PmsInboxDeliveryCompletion, { outcome: "failed" }> | null,
) {
  const attemptStatus = status === "succeeded" ? "succeeded" : "failed";
  await client.query(
    `UPDATE platform.job_attempts
     SET status = $4, finished_at = now(),
         duration_ms = GREATEST(0, floor(extract(epoch FROM (now() - started_at)) * 1000))::integer,
         error_type = $5, error_message = $6,
         retry_after = $7::timestamptz
     WHERE job_id = $1::uuid AND attempt_number = $2
       AND status = 'running' AND worker_id = $3`,
    [
      job.id,
      job.attemptNumber,
      job.workerId,
      attemptStatus,
      completion?.failure ?? null,
      completion?.projection.reasonCode ?? null,
      completion?.retryAt?.toISOString() ?? null,
    ],
  );
  const finished = await client.query(
    `UPDATE platform.jobs
     SET status = $4, run_after = COALESCE($5::timestamptz, run_after),
         finished_at = CASE WHEN $4 = 'pending' THEN NULL ELSE now() END,
         locked_at = NULL, locked_by = NULL, updated_at = now(),
         job_metadata = job_metadata || jsonb_build_object(
           'lastOutcome', $6::text, 'lastReasonCode', $7::text
         )
     WHERE id = $1::uuid AND status = 'running' AND locked_by = $2
       AND attempts_count = $3`,
    [
      job.id,
      job.workerId,
      job.attemptNumber,
      status,
      completion?.retryAt?.toISOString() ?? null,
      completion?.outcome ?? "accepted",
      completion?.projection.reasonCode ?? null,
    ],
  );
  if (finished.rowCount !== 1)
    throw new Error("PMS Inbox delivery job was not completed exactly once");
}

async function insertDeadLetter(
  client: PmsInboxDeliveryQueryable,
  job: PmsInboxDeliveryJob,
  completion: Extract<PmsInboxDeliveryCompletion, { outcome: "failed" }>,
) {
  await client.query(
    `INSERT INTO platform.dead_letter_events (
       source_kind, job_id, job_attempt_id, tenant_scope, property_id,
       resource_product, resource_type, resource_id, correlation_id,
       idempotency_key_hash, reason_code, failure_summary, failure_payload
     )
     SELECT 'job', job.id, attempt.id, job.tenant_scope, job.property_id,
       job.resource_product, job.resource_type, job.resource_id, job.correlation_id,
       job.idempotency_key_hash, $4, $4,
       jsonb_build_object('attemptNumber', $3::integer)
     FROM platform.jobs job
     JOIN platform.job_attempts attempt
       ON attempt.job_id = job.id AND attempt.attempt_number = $3
     WHERE job.id = $1::uuid AND job.property_id = $2::uuid`,
    [job.id, job.propertyId, job.attemptNumber, completion.projection.reasonCode],
  );
}

async function insertDeliveryAudit(
  client: PmsInboxDeliveryQueryable,
  job: PmsInboxDeliveryJob,
  status: string,
  completion: Extract<PmsInboxDeliveryCompletion, { outcome: "failed" }> | null,
  attemptId: string | null,
) {
  await client.query(
    `INSERT INTO platform.product_audit_events (
       audit_key, product, action, occurred_at, tenant_scope, property_id, actor_type,
       target_resource_product, target_resource_type, target_resource_id,
       job_id, correlation_id, redacted_payload, audit_metadata, domain_event_id, causation_id,
       retention_class, privacy_scope
     ) SELECT
       $1, 'pms', $2, now(), 'property', $3::uuid, 'system',
       'pms', 'message', $4, $5::uuid, $6, $7::jsonb, $8::jsonb,
       job.source_domain_event_id, job.source_domain_event_id::text,
       'guest_pii', 'confidential'
     FROM platform.jobs job WHERE job.id = $5::uuid
     ON CONFLICT (product, audit_key) DO NOTHING`,
    [
      `pms.inbox.delivery:${job.id}:attempt:${job.attemptNumber}:${status}:v1`,
      `pms.inbox.message.delivery_${status}`,
      job.propertyId,
      job.messageId,
      job.id,
      job.correlationId,
      JSON.stringify({
        outcome: completion?.outcome ?? "accepted",
        state: completion?.projection.state ?? "sent",
        reasonCode: completion?.projection.reasonCode ?? null,
      }),
      JSON.stringify({ attemptNumber: job.attemptNumber, deliveryAttemptId: attemptId }),
    ],
  );
}
