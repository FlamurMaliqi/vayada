import { createHash } from "node:crypto";
import pg from "pg";

import type { PlatformMediaInboundAttachmentWriter } from "../platform/platformMediaS3.js";

// Contract: engineering/native-guest-inbox-contract.md
const QUEUE = "pms.channex.webhooks";
const TYPE = "channex.ingest-message";
const LEASE_MS = 5 * 60_000;
const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;

type Payload = {
  propertyId: string;
  providerPropertyId: string;
  threadId: string;
  sourceMessageId: string;
  receiptId: string;
};

type Job = Payload & {
  id: string;
  correlationId: string | null;
  attempt: number;
  maxAttempts: number;
  workerId: string;
  tenantScope: string;
  scopeOrganizationId: string | null;
  scopePropertyId: string | null;
  invalidPayload?: true;
};

type Attachment = {
  ordinal: number;
  sourceAttachmentId: string | null;
  sourceUrl: string | null;
  filename: string | null;
  contentType: string | null;
  sizeBytes: number | null;
  managed: {
    mediaId: string;
    bucketName: string;
    storageKey: string;
    checksumSha256: string;
    widthPx: number | null;
    heightPx: number | null;
  } | null;
};

type Message = {
  threadId: string;
  sourceMessageId: string;
  direction: "inbound" | "outbound";
  senderType: "guest" | "property_user" | "channel" | "system";
  senderDisplayName: string | null;
  body: string;
  sentAt: string;
  providerChannel: string | null;
  guestDisplayName: string | null;
  guestEmail: string | null;
  sourceBookingId: string | null;
  providerInquiryId: string | null;
  inquiry: boolean;
  inquiryArrivalDate: string | null;
  inquiryDepartureDate: string | null;
  inquiryAdults: number | null;
  inquiryChildren: number | null;
  attachments: Attachment[];
  rawPayload: Record<string, unknown>;
};

type ThreadMetadata = Partial<Message> & { providerPropertyId: string };

type Counters = { succeeded: number; retryScheduled: number; deadLettered: number };
type Projection = { outcome: "inserted" | "duplicate"; restoredAttention: boolean };

class Failure extends Error {
  constructor(
    readonly code: string,
    readonly retryable: boolean,
  ) {
    super(code);
  }
}

class LeaseLost extends Error {
  constructor() {
    super("lease_lost");
  }
}

class ThreadRace extends Error {}

export async function runChannexMessageJobs(
  connectionString: string,
  options: {
    apiBaseUrl: string;
    apiKey: string;
    ownsMutation: () => boolean;
    fetch?: typeof fetch;
    attachmentMedia?: PlatformMediaInboundAttachmentWriter;
    workerId?: string;
    limit?: number;
    signal?: AbortSignal;
  },
): Promise<Counters> {
  const pool = new pg.Pool({ connectionString, max: 2, connectionTimeoutMillis: 5_000 });
  const counters: Counters = { succeeded: 0, retryScheduled: 0, deadLettered: 0 };
  try {
    for (let index = 0; index < (options.limit ?? 25); index += 1) {
      if (options.signal?.aborted) break;
      const claimed = await claim(pool, options.workerId ?? `channex-messages:${process.pid}`);
      if (!claimed) break;
      if ("expired" in claimed) {
        counters.deadLettered += 1;
        continue;
      }
      counters[await processJob(pool, claimed, options)] += 1;
    }
    return counters;
  } finally {
    await pool.end();
  }
}

async function processJob(
  pool: pg.Pool,
  job: Job,
  options: Parameters<typeof runChannexMessageJobs>[1],
): Promise<keyof Counters> {
  let importedMessage: Message | null = null;
  let projection: Projection | null = null;
  try {
    if (job.invalidPayload) throw new Failure("invalid_job_payload", false);
    if (job.tenantScope !== "property" || job.scopePropertyId !== job.propertyId)
      throw new Failure("invalid_job_scope", false);
    active(options);
    const rawPayload = await loadReceiptPayload(pool, job);
    let message = parseMessage(job, rawPayload, options.apiBaseUrl);
    await assertConnectionOwnership(pool, job);
    message = mergeThreadMetadata(
      message,
      await fetchThreadMetadata(message.threadId, job.providerPropertyId, options),
    );
    message.providerChannel ??= "other";
    message = await importAttachments(pool, job, message, options);
    importedMessage = message;
    active(options);
    projection = await persist(pool, job, message);
    if (projection.outcome === "duplicate") {
      await cleanupImportedAttachments(pool, message.attachments, options);
    }
    await finish(pool, job, "succeeded", projection);
    return "succeeded";
  } catch (error) {
    if (error instanceof LeaseLost) throw error;
    let caught = error;
    if (importedMessage && projection?.outcome !== "inserted") {
      try {
        await cleanupImportedAttachments(pool, importedMessage.attachments, options);
      } catch (cleanupError) {
        caught = cleanupError;
      }
    }
    const failure =
      caught instanceof Failure
        ? caught
        : new Failure(pgCode(caught) ? "write_unavailable" : "handler_failed", true);
    return finish(pool, job, failure);
  }
}

async function assertConnectionOwnership(pool: pg.Pool, job: Job): Promise<void> {
  const result = await pool.query<{ id: string; propertyId: string }>(
    `SELECT id::text, property_id::text AS "propertyId" FROM pms.channel_connections
     WHERE provider = 'channex' AND external_property_id = $1
       AND connection_status IN ('connected', 'degraded') AND messaging_app_installed
     LIMIT 2`,
    [job.providerPropertyId],
  );
  assertConnectionRows(result.rows, job.propertyId);
}

async function claim(pool: pg.Pool, workerId: string): Promise<Job | { expired: true } | null> {
  return transaction(pool, async (client) => {
    const row = (
      await client.query<{
        id: string;
        propertyId: string | null;
        scopeOrganizationId: string | null;
        scopePropertyId: string | null;
        resourceId: string;
        correlationId: string | null;
        tenantScope: string;
        status: "pending" | "running";
        attemptsCount: number;
        maxAttempts: number;
        payload: unknown;
      }>(
        `SELECT id::text, payload->>'propertyId' AS "propertyId",
                organization_id::text AS "scopeOrganizationId",
                property_id::text AS "scopePropertyId", resource_id AS "resourceId",
                correlation_id AS "correlationId", tenant_scope AS "tenantScope", status,
                attempts_count::int AS "attemptsCount", max_attempts::int AS "maxAttempts", payload
         FROM platform.jobs
         WHERE queue_name = $1 AND job_type = $2
           AND ((status = 'pending' AND run_after <= now() AND attempts_count < max_attempts)
             OR (status = 'running' AND locked_at <= now() - ($3::bigint * interval '1 millisecond')))
         ORDER BY priority DESC, run_after, created_at
         FOR UPDATE SKIP LOCKED LIMIT 1`,
        [QUEUE, TYPE, LEASE_MS],
      )
    ).rows[0];
    if (!row) return null;
    const scope = {
      tenantScope: row.tenantScope,
      scopeOrganizationId: row.scopeOrganizationId,
      scopePropertyId: row.scopePropertyId,
    };
    const invalidScope =
      row.tenantScope !== "property" ||
      row.scopeOrganizationId !== null ||
      !uuid(row.scopePropertyId);
    if (row.status === "running") {
      await client.query(
        `UPDATE platform.job_attempts
         SET status = 'timed_out', finished_at = now(), error_type = 'worker_lease_expired',
             error_message = 'Channex message worker lease expired'
         WHERE job_id = $1::uuid AND attempt_number = $2 AND status = 'running'`,
        [row.id, row.attemptsCount],
      );
      if (row.attemptsCount >= row.maxAttempts) {
        await expire(client, { ...row, ...scope });
        return { expired: true };
      }
    }

    let payload: Payload;
    let invalidPayload = false;
    try {
      payload = parsePayload(row.payload, row.scopePropertyId ?? "", row.resourceId);
    } catch {
      invalidPayload = true;
      payload = {
        propertyId: row.propertyId ?? "",
        providerPropertyId: "",
        threadId: "",
        sourceMessageId: row.resourceId,
        receiptId: "",
      };
    }
    const attempt = row.attemptsCount + 1;
    await client.query(
      `UPDATE platform.jobs
       SET status = 'running', attempts_count = $2, locked_at = now(), locked_by = $3,
           updated_at = now()
       WHERE id = $1::uuid`,
      [row.id, attempt, workerId],
    );
    await client.query(
      `INSERT INTO platform.job_attempts(job_id, attempt_number, status, worker_id)
       VALUES($1::uuid, $2, 'running', $3)`,
      [row.id, attempt, workerId],
    );
    return {
      ...payload,
      id: row.id,
      correlationId: row.correlationId,
      attempt,
      maxAttempts: row.maxAttempts,
      workerId,
      ...scope,
      ...(invalidPayload || invalidScope ? { invalidPayload: true as const } : {}),
    };
  });
}

async function persist(pool: pg.Pool, job: Job, message: Message): Promise<Projection> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      return await transaction(pool, async (client) => {
        await fence(client, job);
        const connection = (
          await client.query<{ id: string; propertyId: string }>(
            `SELECT id::text, property_id::text AS "propertyId" FROM pms.channel_connections
             WHERE provider = 'channex' AND external_property_id = $1
               AND connection_status IN ('connected', 'degraded')
               AND messaging_app_installed
             ORDER BY id LIMIT 2`,
            [job.providerPropertyId],
          )
        ).rows;
        assertConnectionRows(connection, job.propertyId);

        const guestBookingId = await resolveBooking(
          client,
          job.propertyId,
          connection[0]!.id,
          message.inquiry ? null : message.sourceBookingId,
        );
        const sourceReference = message.inquiry
          ? (message.providerInquiryId ?? message.threadId)
          : message.sourceBookingId;
        const created = (
          await client.query<ThreadRow>(
            `INSERT INTO pms.message_threads
               (property_id, guest_booking_id, source, source_thread_id, source_booking_id,
                provider_channel, guest_display_name, guest_email, attention_state,
                conversation_context_state, inquiry_arrival_date, inquiry_departure_date,
                inquiry_adults, inquiry_children, delivery_channel, unread_count, version)
             VALUES
               ($1::uuid, $2::uuid, 'channex', $3, $4, $5, $6, $7, 'needs_attention',
                $8, $9::date, $10::date, $11, $12, 'ota', 0, 1)
             ON CONFLICT (property_id, source, source_thread_id) DO NOTHING
             RETURNING id::text, guest_booking_id::text AS "guestBookingId",
                       source_booking_id AS "sourceBookingId", provider_channel AS "providerChannel",
                       attention_state AS "attentionState",
                       conversation_context_state AS "conversationContextState",
                       follow_up_job_id::text AS "followUpJobId"`,
            [
              job.propertyId,
              guestBookingId,
              message.threadId,
              sourceReference,
              message.providerChannel,
              message.guestDisplayName,
              message.guestEmail,
              guestBookingId ? "linked" : message.inquiry ? "inquiry" : "unlinked",
              message.inquiryArrivalDate,
              message.inquiryDepartureDate,
              message.inquiryAdults,
              message.inquiryChildren,
            ],
          )
        ).rows[0];
        const thread = created ?? (await lockExistingThread(client, job, message.threadId));
        validateThreadContext(
          thread,
          guestBookingId,
          sourceReference,
          message.providerChannel,
          message.inquiry,
        );

        if (message.direction === "outbound") {
          const delivery = await vayadaDeliveryState(
            client,
            job.propertyId,
            thread.id,
            message.sourceMessageId,
          );
          if (delivery.echo) {
            await client.query(
              `UPDATE pms.channel_connections SET last_message_sync_at = now(), updated_at = now()
               WHERE id = $1::uuid`,
              [connection[0]!.id],
            );
            return { outcome: "duplicate", restoredAttention: false };
          }
          if (delivery.inFlight) throw new Failure("outbound_delivery_in_flight", true);
        }

        const inserted = (
          await client.query<{ id: string }>(
            `INSERT INTO pms.messages
               (property_id, thread_id, source_message_id, direction, sender_type,
                sender_display_name, body, sent_at, raw_payload, pii_retention_until)
             VALUES($1::uuid, $2::uuid, $3, $4, $5, $6, $7, $8::timestamptz, $9::jsonb,
                    ($8::timestamptz + interval '1 year')::date)
             ON CONFLICT (thread_id, source_message_id) DO NOTHING
             RETURNING id::text`,
            [
              job.propertyId,
              thread.id,
              message.sourceMessageId,
              message.direction,
              message.senderType,
              message.senderDisplayName,
              message.body,
              message.sentAt,
              JSON.stringify(providerEvidence(job, message)),
            ],
          )
        ).rows[0];
        if (!inserted) {
          await client.query(
            `UPDATE pms.channel_connections SET last_message_sync_at = now(), updated_at = now()
             WHERE id = $1::uuid`,
            [connection[0]!.id],
          );
          return { outcome: "duplicate", restoredAttention: false };
        }

        for (const attachment of message.attachments) {
          await insertAttachment(
            client,
            job.propertyId,
            thread.id,
            inserted.id,
            message.sourceMessageId,
            message.sentAt,
            attachment,
          );
        }

        const restoredAttention =
          message.direction === "inbound" && thread.attentionState !== "needs_attention";
        if (message.direction === "inbound" && thread.attentionState === "follow_up") {
          await cancelFollowUp(client, thread.followUpJobId, inserted.id);
        }
        await updateThread(client, {
          propertyId: job.propertyId,
          thread,
          message,
          guestBookingId,
          sourceReference,
          insertedThread: Boolean(created),
        });
        await insertMessageAudit(client, job, thread.id, inserted.id, message);
        if (
          message.direction === "inbound" &&
          (thread.attentionState === "follow_up" || thread.attentionState === "done")
        ) {
          await insertAttentionRestoredAudit(
            client,
            job,
            thread.id,
            inserted.id,
            thread.attentionState,
          );
        }
        await client.query(
          `UPDATE pms.channel_connections SET last_message_sync_at = now(), updated_at = now()
           WHERE id = $1::uuid`,
          [connection[0]!.id],
        );
        return { outcome: "inserted", restoredAttention };
      });
    } catch (error) {
      if (!(error instanceof ThreadRace)) throw error;
    }
  }
  throw new Failure("thread_state_race", true);
}

function assertConnectionRows(rows: readonly { propertyId: string }[], propertyId: string): void {
  if (rows.some((row) => row.propertyId !== propertyId))
    throw new Failure("cross_property_message", false);
  if (rows.length !== 1) throw new Failure("connection_not_owned", true);
}

type ThreadRow = {
  id: string;
  guestBookingId: string | null;
  sourceBookingId: string | null;
  providerChannel: string | null;
  attentionState: "needs_attention" | "follow_up" | "done";
  conversationContextState: "linked" | "inquiry" | "unlinked";
  followUpJobId: string | null;
};

async function lockExistingThread(
  client: pg.PoolClient,
  job: Job,
  threadId: string,
): Promise<ThreadRow> {
  const probe = (
    await client.query<{ followUpJobId: string | null }>(
      `SELECT follow_up_job_id::text AS "followUpJobId"
       FROM pms.message_threads
       WHERE property_id = $1::uuid AND source = 'channex' AND source_thread_id = $2`,
      [job.propertyId, threadId],
    )
  ).rows[0];
  if (!probe) throw new ThreadRace();
  if (probe.followUpJobId) {
    await client.query(`SELECT 1 FROM platform.jobs WHERE id = $1::uuid FOR UPDATE`, [
      probe.followUpJobId,
    ]);
  }
  const thread = (
    await client.query<ThreadRow>(
      `SELECT id::text, guest_booking_id::text AS "guestBookingId",
              source_booking_id AS "sourceBookingId", provider_channel AS "providerChannel",
              attention_state AS "attentionState",
              conversation_context_state AS "conversationContextState",
              follow_up_job_id::text AS "followUpJobId"
       FROM pms.message_threads
       WHERE property_id = $1::uuid AND source = 'channex' AND source_thread_id = $2
       FOR UPDATE`,
      [job.propertyId, threadId],
    )
  ).rows[0];
  if (!thread || thread.followUpJobId !== probe.followUpJobId) throw new ThreadRace();
  return thread;
}

async function resolveBooking(
  client: pg.PoolClient,
  propertyId: string,
  connectionId: string,
  sourceBookingId: string | null,
): Promise<string | null> {
  if (!sourceBookingId) return null;
  const rows = (
    await client.query<{ guestBookingId: string }>(
      `SELECT DISTINCT guest_booking_id::text AS "guestBookingId"
       FROM pms.channel_booking_mappings
       WHERE property_id = $1::uuid AND connection_id = $2::uuid
         AND external_booking_id = $3 AND sync_status = 'active'
       LIMIT 2`,
      [propertyId, connectionId, sourceBookingId],
    )
  ).rows;
  if (rows.length > 1) throw new Failure("ambiguous_booking_mapping", false);
  return rows[0]?.guestBookingId ?? null;
}

async function vayadaDeliveryState(
  client: pg.PoolClient,
  propertyId: string,
  threadId: string,
  sourceMessageId: string,
): Promise<{ echo: boolean; inFlight: boolean }> {
  const result = await client.query<{ echo: boolean; inFlight: boolean }>(
    `SELECT
       COALESCE(bool_or(
         attempt.outcome = 'accepted' AND (
           $3 = ANY(regexp_split_to_array(COALESCE(attempt.provider_reference, ''), '\\s*,\\s*'))
           OR jsonb_exists(
             COALESCE(attempt.failure_metadata -> 'acceptedProviderReferences', '[]'::jsonb),
             $3
           )
         )
       ), FALSE) AS echo,
       COALESCE(bool_or(attempt.outcome = 'running'), FALSE) AS "inFlight"
     FROM pms.message_delivery_attempts attempt
     JOIN pms.messages message
       ON message.id = attempt.message_id AND message.property_id = attempt.property_id
     WHERE attempt.property_id = $1::uuid AND message.thread_id = $2::uuid
       AND message.direction = 'outbound' AND attempt.adapter = 'channex'`,
    [propertyId, threadId, sourceMessageId],
  );
  return result.rows[0] ?? { echo: false, inFlight: false };
}

function validateThreadContext(
  thread: ThreadRow,
  guestBookingId: string | null,
  sourceReference: string | null,
  providerChannel: string | null,
  incomingInquiry: boolean,
): void {
  if (thread.guestBookingId && guestBookingId && thread.guestBookingId !== guestBookingId)
    throw new Failure("thread_booking_conflict", false);
  if (
    thread.sourceBookingId &&
    sourceReference &&
    thread.sourceBookingId !== sourceReference &&
    !(thread.conversationContextState === "inquiry" && guestBookingId) &&
    !(thread.conversationContextState === "linked" && incomingInquiry)
  )
    throw new Failure("thread_source_reference_conflict", false);
  if (
    thread.providerChannel &&
    providerChannel &&
    thread.providerChannel !== "other" &&
    thread.providerChannel !== providerChannel
  )
    throw new Failure("thread_channel_conflict", false);
}

async function updateThread(
  client: pg.PoolClient,
  input: {
    propertyId: string;
    thread: ThreadRow;
    message: Message;
    guestBookingId: string | null;
    sourceReference: string | null;
    insertedThread: boolean;
  },
): Promise<void> {
  await client.query(
    `WITH latest AS (
     SELECT sent_at, LEFT(body, 280) AS preview, direction,
            source_message_id = $15 AS incoming_is_latest
       FROM pms.messages
       WHERE property_id = $1::uuid AND thread_id = $2::uuid
       ORDER BY sent_at DESC, id DESC LIMIT 1
     )
     UPDATE pms.message_threads thread
     SET guest_booking_id = COALESCE(thread.guest_booking_id, $3::uuid),
         source_booking_id = CASE
           WHEN $3::uuid IS NOT NULL AND thread.conversation_context_state = 'inquiry' THEN $4
           ELSE COALESCE(thread.source_booking_id, $4)
         END,
         provider_channel = CASE
           WHEN thread.provider_channel IS NULL OR thread.provider_channel = 'other' THEN $5
           ELSE thread.provider_channel
         END,
         guest_display_name = CASE WHEN latest.incoming_is_latest
           THEN COALESCE($6, thread.guest_display_name) ELSE thread.guest_display_name END,
         guest_email = CASE WHEN latest.incoming_is_latest
           THEN COALESCE($7, thread.guest_email) ELSE thread.guest_email END,
         conversation_context_state = CASE
           WHEN COALESCE(thread.guest_booking_id, $3::uuid) IS NOT NULL THEN 'linked'
           WHEN $8::boolean THEN 'inquiry'
           ELSE thread.conversation_context_state
         END,
         inquiry_arrival_date = CASE
           WHEN COALESCE(thread.guest_booking_id, $3::uuid) IS NOT NULL THEN NULL
           WHEN latest.incoming_is_latest THEN COALESCE($9::date, thread.inquiry_arrival_date)
           ELSE thread.inquiry_arrival_date END,
         inquiry_departure_date = CASE
           WHEN COALESCE(thread.guest_booking_id, $3::uuid) IS NOT NULL THEN NULL
           WHEN latest.incoming_is_latest THEN COALESCE($10::date, thread.inquiry_departure_date)
           ELSE thread.inquiry_departure_date END,
         inquiry_adults = CASE
           WHEN COALESCE(thread.guest_booking_id, $3::uuid) IS NOT NULL THEN NULL
           WHEN latest.incoming_is_latest THEN COALESCE($11, thread.inquiry_adults)
           ELSE thread.inquiry_adults END,
         inquiry_children = CASE
           WHEN COALESCE(thread.guest_booking_id, $3::uuid) IS NOT NULL THEN NULL
           WHEN latest.incoming_is_latest THEN COALESCE($12, thread.inquiry_children)
           ELSE thread.inquiry_children END,
         attention_state = CASE WHEN $13 = 'inbound' THEN 'needs_attention'
           ELSE thread.attention_state END,
         follow_up_at = CASE WHEN $13 = 'inbound' THEN NULL ELSE thread.follow_up_at END,
         follow_up_by_membership_id = CASE WHEN $13 = 'inbound' THEN NULL
           ELSE thread.follow_up_by_membership_id END,
         follow_up_job_id = CASE WHEN $13 = 'inbound' THEN NULL ELSE thread.follow_up_job_id END,
         done_at = CASE WHEN $13 = 'inbound' THEN NULL ELSE thread.done_at END,
         done_by_membership_id = CASE WHEN $13 = 'inbound' THEN NULL
           ELSE thread.done_by_membership_id END,
         done_reason = CASE WHEN $13 = 'inbound' THEN NULL ELSE thread.done_reason END,
         unread_count = thread.unread_count + CASE WHEN $13 = 'inbound' THEN 1 ELSE 0 END,
         version = thread.version + CASE WHEN $14::boolean THEN 0 ELSE 1 END,
         last_message_at = latest.sent_at,
         last_message_preview = latest.preview,
         last_message_direction = latest.direction,
         updated_at = now()
     FROM latest
     WHERE thread.property_id = $1::uuid AND thread.id = $2::uuid`,
    [
      input.propertyId,
      input.thread.id,
      input.guestBookingId,
      input.sourceReference,
      input.message.providerChannel,
      input.message.guestDisplayName,
      input.message.guestEmail,
      input.message.inquiry,
      input.message.inquiryArrivalDate,
      input.message.inquiryDepartureDate,
      input.message.inquiryAdults,
      input.message.inquiryChildren,
      input.message.direction,
      input.insertedThread,
      input.message.sourceMessageId,
    ],
  );
}

async function insertAttachment(
  client: pg.PoolClient,
  propertyId: string,
  threadId: string,
  messageId: string,
  sourceMessageId: string,
  sentAt: string,
  attachment: Attachment,
): Promise<void> {
  if (!attachment.managed || !attachment.contentType || !attachment.sizeBytes)
    throw new Failure("attachment_media_unavailable", true);
  const attachmentId = attachmentRecordId(propertyId, sourceMessageId, attachment);
  const media = attachment.managed;
  const finalized = await client.query(
    `UPDATE platform.media_objects
     SET resource_type = 'message_thread', resource_id = $3,
         lifecycle_status = 'active', retained_until = $4::timestamptz + interval '1 year',
         source_metadata = source_metadata || jsonb_strip_nulls(jsonb_build_object(
           'attachmentState', 'claimed', 'claimedByMessageId', $5::text)),
         updated_at = now()
     WHERE id = $1::uuid AND property_id = $2::uuid AND bucket = $6 AND storage_key = $7
       AND checksum_sha256 = $8 AND lifecycle_status = 'staged'
     RETURNING id`,
    [
      media.mediaId,
      propertyId,
      threadId,
      sentAt,
      messageId,
      media.bucketName,
      media.storageKey,
      media.checksumSha256,
    ],
  );
  if (!finalized.rowCount) throw new Failure("attachment_media_unavailable", true);
  await client.query(
    `INSERT INTO platform.media_variants
       (media_object_id, variant_name, visibility, storage_key, content_type,
        width_px, height_px, size_bytes, checksum_sha256, public_cdn_url)
     VALUES($1::uuid, 'provider_original', 'private', $2, $3, $4, $5, $6, $7, NULL)`,
    [
      media.mediaId,
      media.storageKey,
      attachment.contentType,
      media.widthPx,
      media.heightPx,
      attachment.sizeBytes,
      media.checksumSha256,
    ],
  );
  await client.query(
    `INSERT INTO pms.message_attachments
       (id, property_id, message_id, platform_media_object_id, filename,
        content_type, size_bytes, source_attachment_id)
     VALUES($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5, $6, $7, $8)`,
    [
      attachmentId,
      propertyId,
      messageId,
      media.mediaId,
      attachment.filename,
      attachment.contentType,
      attachment.sizeBytes,
      attachment.sourceAttachmentId,
    ],
  );
}

async function importAttachments(
  pool: pg.Pool,
  job: Job,
  message: Message,
  options: Parameters<typeof runChannexMessageJobs>[1],
): Promise<Message> {
  if (!message.attachments.length) return message;
  if (!options.attachmentMedia) throw new Failure("attachment_media_unavailable", true);
  const attachments: Attachment[] = [];
  try {
    for (const attachment of message.attachments) {
      if (!attachment.sourceUrl) throw new Failure("invalid_message_attachment", false);
      const response = await fetchProviderResource(attachment.sourceUrl, options, {
        unavailable: "attachment_download_unavailable",
        invalidRedirect: "invalid_message_attachment_url",
      });
      if (!response.ok)
        throw new Failure(
          response.status === 429 || response.status >= 500
            ? "attachment_download_unavailable"
            : "invalid_message_attachment",
          response.status === 429 || response.status >= 500,
        );
      const declaredLength = Number(response.headers.get("content-length"));
      if (Number.isFinite(declaredLength) && declaredLength > MAX_ATTACHMENT_BYTES)
        throw new Failure("invalid_message_attachment", false);
      const bytes = await readResponseBytes(response, MAX_ATTACHMENT_BYTES);
      if (attachment.sizeBytes !== null && attachment.sizeBytes !== bytes.length)
        throw new Failure("invalid_message_attachment", false);
      const contentType =
        attachment.contentType ??
        response.headers.get("content-type")?.split(";", 1)[0]?.trim() ??
        null;
      if (!contentType) throw new Failure("invalid_message_attachment", false);
      const mediaId = stableUuid(
        `channex:media:${job.propertyId}:${message.threadId}:${message.sourceMessageId}:${attachment.sourceAttachmentId ?? attachment.ordinal}`,
      );
      let prepared: Awaited<
        ReturnType<PlatformMediaInboundAttachmentWriter["preparePrivateAttachment"]>
      >;
      try {
        prepared = await options.attachmentMedia.preparePrivateAttachment({
          mediaId,
          bytes,
          contentType,
        });
      } catch {
        throw new Failure("attachment_media_unavailable", true);
      }
      if (!prepared.ok) throw new Failure("invalid_message_attachment", false);
      const importedAttachment: Attachment = {
        ...attachment,
        contentType: prepared.contentType,
        sizeBytes: prepared.sizeBytes,
        managed: { mediaId, ...prepared },
      };
      const alreadyActive = await registerStagedAttachment(pool, job, message, importedAttachment);
      attachments.push(importedAttachment);
      if (!alreadyActive) {
        try {
          await options.attachmentMedia.uploadPrivateAttachment({ prepared, bytes });
        } catch {
          throw new Failure("attachment_media_unavailable", true);
        }
      }
    }
  } catch (error) {
    await cleanupImportedAttachments(pool, attachments, options);
    throw error;
  }
  return { ...message, attachments };
}

async function registerStagedAttachment(
  pool: pg.Pool,
  job: Job,
  message: Message,
  attachment: Attachment,
): Promise<boolean> {
  if (!attachment.managed || !attachment.contentType || !attachment.sizeBytes)
    throw new Failure("attachment_media_unavailable", true);
  const media = attachment.managed;
  const attachmentId = attachmentRecordId(job.propertyId, message.sourceMessageId, attachment);
  await pool.query(
    `INSERT INTO platform.media_objects
       (id, bucket, storage_key, storage_kind, visibility, purpose, property_id,
        resource_product, resource_type, resource_id, lifecycle_status, content_type,
        size_bytes, checksum_sha256, width_px, height_px, original_filename,
        source_system, source_table, source_row_id, source_metadata, retained_until,
        public_approved)
     VALUES
       ($1::uuid, $2, $3, 'vayada_managed', 'private', 'pms.messaging.attachment', $4::uuid,
        'pms', 'channel_message', $5, 'staged', $6, $7, $8, $9, $10, $11,
        'pms', 'message_attachments', $12,
        jsonb_strip_nulls(jsonb_build_object('sourceProvider', 'channex',
          'sourceAttachmentId', $13::text, 'sourceThreadId', $14::text,
          'sourceMessageId', $5::text, 'attachmentState', 'staged')),
        now() + interval '1 day', FALSE)
     ON CONFLICT DO NOTHING`,
    [
      media.mediaId,
      media.bucketName,
      media.storageKey,
      job.propertyId,
      message.sourceMessageId,
      attachment.contentType,
      attachment.sizeBytes,
      media.checksumSha256,
      media.widthPx,
      media.heightPx,
      attachment.filename,
      attachmentId,
      attachment.sourceAttachmentId,
      message.threadId,
    ],
  );
  await pool.query(
    `UPDATE platform.media_objects
     SET lifecycle_status = 'staged', resource_type = 'channel_message', resource_id = $5,
         deletion_requested_at = NULL, deleted_at = NULL,
         retained_until = now() + interval '1 day',
         source_metadata = (source_metadata - 'cleanupAction') ||
           jsonb_strip_nulls(jsonb_build_object(
             'sourceProvider', 'channex', 'sourceAttachmentId', $10::text,
             'sourceThreadId', $11::text, 'sourceMessageId', $5::text,
             'attachmentState', 'staged', 'replayedAfterCleanupAt', now())),
         updated_at = now()
     WHERE id = $1::uuid AND lifecycle_status IN ('staged', 'deleted')
       AND property_id = $4::uuid AND bucket = $2 AND storage_key = $3
       AND storage_kind = 'vayada_managed' AND visibility = 'private'
       AND purpose = 'pms.messaging.attachment' AND content_type = $6
       AND size_bytes = $7 AND checksum_sha256 = $8
       AND source_system = 'pms' AND source_table = 'message_attachments'
       AND source_row_id = $9`,
    [
      media.mediaId,
      media.bucketName,
      media.storageKey,
      job.propertyId,
      message.sourceMessageId,
      attachment.contentType,
      attachment.sizeBytes,
      media.checksumSha256,
      attachmentId,
      attachment.sourceAttachmentId,
      message.threadId,
    ],
  );
  const registered = (
    await pool.query<{
      propertyId: string;
      bucket: string;
      storageKey: string;
      contentType: string;
      sizeBytes: string;
      checksumSha256: string;
      lifecycleStatus: string;
    }>(
      `SELECT property_id::text AS "propertyId", bucket, storage_key AS "storageKey",
              content_type AS "contentType", size_bytes::text AS "sizeBytes",
              checksum_sha256 AS "checksumSha256", lifecycle_status AS "lifecycleStatus"
       FROM platform.media_objects WHERE id = $1::uuid`,
      [media.mediaId],
    )
  ).rows[0];
  if (
    !registered ||
    registered.propertyId !== job.propertyId ||
    registered.bucket !== media.bucketName ||
    registered.storageKey !== media.storageKey ||
    registered.contentType !== attachment.contentType ||
    registered.sizeBytes !== String(attachment.sizeBytes) ||
    registered.checksumSha256 !== media.checksumSha256 ||
    !["staged", "active"].includes(registered.lifecycleStatus)
  ) {
    throw new Failure("attachment_media_identity_conflict", false);
  }
  return registered.lifecycleStatus === "active";
}

async function cleanupImportedAttachments(
  pool: pg.Pool,
  attachments: readonly Attachment[],
  options: Parameters<typeof runChannexMessageJobs>[1],
): Promise<void> {
  const imported = attachments.flatMap((attachment) =>
    attachment.managed ? [attachment.managed] : [],
  );
  if (!imported.length || !options.attachmentMedia) return;
  let referenced: Set<string>;
  try {
    const result = await pool.query<{ storageBucket: string; storageKey: string }>(
      `SELECT bucket AS "storageBucket", storage_key AS "storageKey"
       FROM platform.media_objects
       WHERE id = ANY($1::uuid[]) AND lifecycle_status = 'active'`,
      [imported.map((media) => media.mediaId)],
    );
    referenced = new Set(result.rows.map((row) => `${row.storageBucket}\n${row.storageKey}`));
  } catch {
    throw new Failure("attachment_cleanup_unavailable", true);
  }
  try {
    for (const media of imported) {
      if (referenced.has(`${media.bucketName}\n${media.storageKey}`)) continue;
      await options.attachmentMedia.deleteObject({
        bucket: media.bucketName,
        storageKey: media.storageKey,
      });
    }
  } catch {
    throw new Failure("attachment_cleanup_unavailable", true);
  }
}

function attachmentRecordId(
  propertyId: string,
  sourceMessageId: string,
  attachment: Attachment,
): string {
  return stableUuid(
    `channex:attachment:${propertyId}:${sourceMessageId}:${attachment.sourceAttachmentId ?? attachment.ordinal}`,
  );
}

function providerEvidence(job: Job, message: Message): Record<string, unknown> {
  return {
    provider: "channex",
    providerPropertyId: job.providerPropertyId,
    threadId: message.threadId,
    sourceMessageId: message.sourceMessageId,
    sourceBookingId: message.sourceBookingId,
    providerInquiryId: message.providerInquiryId,
    providerChannel: message.providerChannel,
    attachmentIds: message.attachments
      .map((attachment) => attachment.sourceAttachmentId)
      .filter((id): id is string => id !== null),
  };
}

async function cancelFollowUp(
  client: pg.PoolClient,
  followUpJobId: string | null,
  messageId: string,
): Promise<void> {
  if (!followUpJobId) throw new Failure("follow_up_job_missing", false);
  await client.query(
    `UPDATE platform.job_attempts
     SET status = 'canceled', finished_at = now(),
         duration_ms = GREATEST(0, floor(extract(epoch FROM (now() - started_at)) * 1000))::integer,
         error_type = 'superseded_by_inbound_message',
         error_message = 'Follow-up release was canceled by a new inbound message.'
     WHERE job_id = $1::uuid AND status = 'running'`,
    [followUpJobId],
  );
  await client.query(
    `UPDATE platform.jobs
     SET status = 'canceled', finished_at = now(), locked_at = NULL, locked_by = NULL,
         updated_at = now(),
         job_metadata = job_metadata || jsonb_build_object(
           'canceledBy', 'inbound_message', 'canceledByMessageId', $2::text)
     WHERE id = $1::uuid AND status IN ('pending', 'running')`,
    [followUpJobId, messageId],
  );
}

async function insertMessageAudit(
  client: pg.PoolClient,
  job: Job,
  threadId: string,
  messageId: string,
  message: Message,
): Promise<void> {
  await client.query(
    `INSERT INTO platform.product_audit_events
       (audit_key, product, action, occurred_at, tenant_scope, property_id, actor_type,
        target_resource_product, target_resource_type, target_resource_id,
        secondary_resource_product, secondary_resource_type, secondary_resource_id,
        correlation_id, causation_id, redacted_payload, audit_metadata,
        retention_class, privacy_scope)
     VALUES
       ($1, 'pms', 'pms.inbox.message.ingested', now(), 'property', $2::uuid, 'provider',
        'pms', 'message', $3, 'pms', 'message_thread', $4, $5, $6,
        jsonb_build_object('direction', $7::text, 'attachmentCount', $8::integer,
          'providerChannel', $9::text),
        jsonb_build_object('contractVersion', 'native-guest-inbox.v2',
          'sourceProvider', 'channex', 'sourceMessageId', $10::text),
        'guest_pii', 'confidential')`,
    [
      `pms.inbox.message.ingested:message:${messageId}:v1`,
      job.propertyId,
      messageId,
      threadId,
      job.correlationId,
      job.id,
      message.direction,
      message.attachments.length,
      message.providerChannel,
      message.sourceMessageId,
    ],
  );
}

async function insertAttentionRestoredAudit(
  client: pg.PoolClient,
  job: Job,
  threadId: string,
  messageId: string,
  previousState: "follow_up" | "done",
): Promise<void> {
  await client.query(
    `INSERT INTO platform.product_audit_events
       (audit_key, product, action, occurred_at, tenant_scope, property_id, actor_type,
        target_resource_product, target_resource_type, target_resource_id,
        secondary_resource_product, secondary_resource_type, secondary_resource_id,
        correlation_id, causation_id, redacted_payload, audit_metadata,
        retention_class, privacy_scope)
     VALUES
       ($1, 'pms', 'pms.inbox.thread.attention_restored_by_inbound', now(),
        'property', $2::uuid, 'provider', 'pms', 'message_thread', $3,
        'pms', 'message', $4, $5, $6,
        jsonb_build_object('previousState', $7::text, 'attentionState', 'needs_attention'),
        jsonb_build_object('contractVersion', 'native-guest-inbox.v2'),
        'guest_pii', 'confidential')`,
    [
      `pms.inbox.thread.attention_restored_by_inbound:thread:${threadId}:message:${messageId}:v1`,
      job.propertyId,
      threadId,
      messageId,
      job.correlationId,
      job.id,
      previousState,
    ],
  );
}

async function finish(
  pool: pg.Pool,
  job: Job,
  result: "succeeded" | Failure,
  projection?: Projection,
): Promise<keyof Counters> {
  return transaction(pool, async (client) => {
    const now = new Date();
    const succeeded = result === "succeeded";
    const failure = succeeded ? null : result;
    const retry = failure !== null && failure.retryable && job.attempt < job.maxAttempts;
    const outcome: keyof Counters = succeeded
      ? "succeeded"
      : retry
        ? "retryScheduled"
        : "deadLettered";
    const status = succeeded ? "succeeded" : retry ? "pending" : "dead_lettered";
    const retryAt = retry
      ? new Date(now.getTime() + Math.min(60_000, 1_000 * 2 ** (job.attempt - 1)))
      : null;
    const code = failure?.code ?? null;
    const completed = await client.query(
      `UPDATE platform.jobs
       SET status = $3, run_after = COALESCE($4::timestamptz, run_after),
           finished_at = CASE WHEN $3::text = 'pending' THEN NULL ELSE $5::timestamptz END,
           locked_at = NULL, locked_by = NULL, updated_at = $5::timestamptz,
           job_metadata = (job_metadata - 'lastErrorCode') ||
             jsonb_strip_nulls(jsonb_build_object('lastErrorCode', $6::text,
               'projectionOutcome', $8::text, 'restoredAttention', $9::boolean))
       WHERE id = $1::uuid AND attempts_count = $2 AND status = 'running' AND locked_by = $7
       RETURNING id`,
      [
        job.id,
        job.attempt,
        status,
        retryAt,
        now,
        code,
        job.workerId,
        projection?.outcome ?? null,
        projection?.restoredAttention ?? null,
      ],
    );
    if (!completed.rowCount) throw new LeaseLost();
    if (
      failure &&
      !retry &&
      uuid(job.receiptId) &&
      [
        "cross_property_message",
        "invalid_job_payload",
        "provider_thread_identity_mismatch",
        "provider_thread_property_mismatch",
      ].includes(failure.code)
    ) {
      await client.query(
        `UPDATE platform.external_webhook_events
         SET raw_headers = '{}'::jsonb, raw_payload = '{}'::jsonb,
             payload_purged_at = clock_timestamp(), failure_reason = $3
         WHERE id = $1::uuid AND provider = 'channex' AND event_type = 'message'
           AND tenant_scope = 'property' AND property_id = $2::uuid
           AND payload_purged_at IS NULL`,
        [job.receiptId, job.propertyId, failure.code],
      );
    }
    await client.query(
      `UPDATE platform.job_attempts
       SET status = $3, finished_at = $4,
           duration_ms = GREATEST(0, floor(extract(epoch FROM ($4::timestamptz - started_at)) * 1000))::integer,
           error_type = $5,
           error_message = CASE WHEN $5::text IS NULL THEN NULL
             ELSE 'Channex message ingestion failed (' || $5 || ').' END,
           retry_after = $6,
           error_metadata = jsonb_strip_nulls(jsonb_build_object(
             'retryable', $7::boolean, 'projectionOutcome', $8::text))
       WHERE job_id = $1::uuid AND attempt_number = $2 AND status = 'running'`,
      [
        job.id,
        job.attempt,
        succeeded ? "succeeded" : "failed",
        now,
        code,
        retryAt,
        failure?.retryable ?? false,
        projection?.outcome ?? null,
      ],
    );
    if (!succeeded && !retry) {
      await client.query(
        `INSERT INTO platform.dead_letter_events
           (source_kind, job_id, job_attempt_id, tenant_scope, organization_id, property_id,
            resource_product, resource_type, resource_id, correlation_id, reason_code,
            failure_summary, failure_payload)
         SELECT 'job', source.id, attempt.id, source.tenant_scope, source.organization_id,
                source.property_id, 'pms', 'channel_message', $2, $3, $4,
                'Channex message ingestion failed (' || $4 || ').',
                jsonb_build_object('replayEligible', $5::boolean)
         FROM platform.job_attempts attempt
         JOIN platform.jobs source ON source.id = attempt.job_id
         WHERE source.id = $1::uuid AND attempt.attempt_number = $6`,
        [job.id, job.sourceMessageId, job.correlationId, code, failure!.retryable, job.attempt],
      );
    }
    await client.query(
      `INSERT INTO platform.product_audit_events
         (audit_key, product, action, occurred_at, tenant_scope, organization_id, property_id,
          actor_type,
          target_resource_product, target_resource_type, target_resource_id,
          job_id, correlation_id, redacted_payload, retention_class, privacy_scope)
       SELECT $1, 'pms', $2, $3, source.tenant_scope, source.organization_id,
         source.property_id, 'system', 'pms', 'channel_message', $4, source.id, $5,
         jsonb_strip_nulls(jsonb_build_object('propertyId', $6::text, 'outcome', $7::text,
           'failureCode', $8::text, 'projectionOutcome', $9::text)),
         'provider_receipt', 'restricted'
       FROM platform.jobs source WHERE source.id = $10::uuid`,
      [
        `channex.message:${job.id}:attempt:${job.attempt}:${outcome}`,
        `channex.message_ingestion.${outcome}`,
        now,
        job.sourceMessageId,
        job.correlationId,
        job.propertyId,
        outcome,
        code,
        projection?.outcome ?? null,
        job.id,
      ],
    );
    return outcome;
  });
}

async function expire(
  client: pg.PoolClient,
  row: {
    id: string;
    propertyId: string | null;
    scopeOrganizationId: string | null;
    scopePropertyId: string | null;
    resourceId: string;
    correlationId: string | null;
    attemptsCount: number;
    tenantScope: string;
  },
): Promise<void> {
  await client.query(
    `UPDATE platform.jobs
     SET status = 'dead_lettered', finished_at = now(), locked_at = NULL, locked_by = NULL,
         updated_at = now(),
         job_metadata = job_metadata || jsonb_build_object('lastErrorCode', 'worker_lease_expired')
     WHERE id = $1::uuid`,
    [row.id],
  );
  await client.query(
    `INSERT INTO platform.dead_letter_events
       (source_kind, job_id, job_attempt_id, tenant_scope, organization_id, property_id,
        resource_product, resource_type, resource_id, correlation_id, reason_code,
        failure_summary, failure_payload)
     SELECT 'job', source.id, attempt.id, source.tenant_scope, source.organization_id,
            source.property_id, 'pms', 'channel_message', $2, $3,
            'worker_lease_expired', 'Channex message worker lease expired.',
            jsonb_build_object('replayEligible', TRUE)
     FROM platform.job_attempts attempt
     JOIN platform.jobs source ON source.id = attempt.job_id
     WHERE source.id = $1::uuid AND attempt.attempt_number = $4`,
    [row.id, row.resourceId, row.correlationId, row.attemptsCount],
  );
  await client.query(
    `INSERT INTO platform.product_audit_events
       (audit_key, product, action, occurred_at, tenant_scope, organization_id, property_id,
        actor_type,
        target_resource_product, target_resource_type, target_resource_id,
        job_id, correlation_id, redacted_payload, retention_class, privacy_scope)
     SELECT $1, 'pms', 'channex.message_ingestion.deadLettered', now(), source.tenant_scope,
       source.organization_id, source.property_id, 'system', 'pms', 'channel_message', $2,
       source.id, $3,
       jsonb_strip_nulls(jsonb_build_object('propertyId', $4::text,
         'outcome', 'deadLettered', 'failureCode', 'worker_lease_expired')),
       'provider_receipt', 'restricted'
     FROM platform.jobs source WHERE source.id = $5::uuid`,
    [
      `channex.message:${row.id}:attempt:${row.attemptsCount}:deadLettered`,
      row.resourceId,
      row.correlationId,
      row.propertyId,
      row.id,
    ],
  );
}

function parsePayload(value: unknown, propertyId: string, resourceId: string): Payload {
  const payload = record(value);
  const parsed: Payload = {
    propertyId: text(payload["propertyId"]) ?? "",
    providerPropertyId: text(payload["providerPropertyId"]) ?? "",
    threadId: text(payload["threadId"]) ?? "",
    sourceMessageId: text(payload["sourceMessageId"]) ?? "",
    receiptId: text(payload["receiptId"]) ?? "",
  };
  if (
    text(payload["provider"]) !== "channex" ||
    !uuid(parsed.propertyId) ||
    parsed.propertyId !== propertyId ||
    !parsed.providerPropertyId ||
    !parsed.threadId ||
    !parsed.sourceMessageId ||
    parsed.sourceMessageId !== resourceId ||
    !uuid(parsed.receiptId)
  )
    throw new Failure("invalid_job_payload", false);
  return parsed;
}

async function loadReceiptPayload(pool: pg.Pool, job: Job): Promise<Record<string, unknown>> {
  const row = (
    await pool.query<{ rawPayload: unknown; payloadPurgedAt: Date | null }>(
      `SELECT raw_payload AS "rawPayload", payload_purged_at AS "payloadPurgedAt"
       FROM platform.external_webhook_events
       WHERE id = $1::uuid AND provider = 'channex' AND event_type = 'message'
         AND tenant_scope = 'property' AND property_id = $2::uuid`,
      [job.receiptId, job.propertyId],
    )
  ).rows[0];
  if (!row) throw new Failure("invalid_webhook_receipt", false);
  const rawPayload = record(row.rawPayload);
  if (row.payloadPurgedAt || !Object.keys(rawPayload).length)
    throw new Failure("provider_payload_expired", false);
  const nested = record(rawPayload["payload"]);
  const responseData = record(nested["data"]);
  const message = Object.keys(record(nested["message"])).length
    ? record(nested["message"])
    : Object.keys(responseData).length
      ? responseData
      : nested;
  const attributes = record(message["attributes"]);
  const thread = record(nested["thread"]);
  const relationships = record(message["relationships"]);
  const relationshipProperty = record(record(relationships["property"])["data"]);
  const bookingDetails = record(record(attributes["meta"])["booking_details"]);
  const providerPropertyIds = suppliedProviderPropertyIds([
    rawPayload,
    nested,
    message,
    attributes,
    thread,
    record(thread["attributes"]),
    relationshipProperty,
    bookingDetails,
  ]);
  if (
    providerPropertyIds.length === 0 ||
    providerPropertyIds.some((candidate) => candidate !== job.providerPropertyId)
  )
    throw new Failure("invalid_job_payload", false);
  return rawPayload;
}

function parseMessage(job: Job, rawPayload: Record<string, unknown>, apiBaseUrl: string): Message {
  const nested = record(rawPayload["payload"]);
  const messageObject = record(nested["message"]);
  const responseData = record(nested["data"]);
  const data = Object.keys(messageObject).length
    ? messageObject
    : Object.keys(responseData).length
      ? responseData
      : nested;
  const attributes = record(data["attributes"]);
  const sources = [attributes, data, nested, rawPayload];
  const thread = record(nested["thread"]);
  const relationships = record(data["relationships"]);
  const messageThread = record(record(relationships["message_thread"])["data"]);
  const threadId =
    firstTextFrom(sources, ["thread_id", "message_thread_id"]) ??
    text(thread["id"]) ??
    text(messageThread["id"]);
  const sourceMessageId = firstTextFrom(sources, ["source_message_id", "message_id", "id"]);
  if (threadId !== job.threadId || sourceMessageId !== job.sourceMessageId)
    throw new Failure("invalid_message_identity", false);

  const sender = firstValue(sources, "sender");
  const senderRecord = record(sender);
  const senderKind = (text(senderRecord["type"]) ?? text(sender) ?? "").toLowerCase();
  const senderDirection = senderKind === "guest" ? "inbound" : "outbound";
  const senderType =
    senderKind === "guest"
      ? "guest"
      : senderKind === "channel"
        ? "channel"
        : senderKind === "system"
          ? "system"
          : ["property", "property_user", "host", "hotel"].includes(senderKind)
            ? "property_user"
            : null;
  if (!senderType) throw new Failure("invalid_message_sender", false);

  const attachmentValue = firstValue(sources, "attachments");
  const attachments = parseAttachments(
    attachmentValue === undefined || attachmentValue === null ? [] : attachmentValue,
    apiBaseUrl,
  );
  const bodyValue = firstValueFrom(sources, ["body", "message", "text"]);
  if (bodyValue !== undefined && typeof bodyValue !== "string")
    throw new Failure("invalid_message_body", false);
  const body = bodyValue ?? "";
  if (body.length > 100_000 || (!body.trim() && !attachments.length))
    throw new Failure("invalid_message_body", false);
  const sentAt = timestamp(
    firstValueFrom(sources, ["created_at", "inserted_at", "sent_at", "timestamp"]),
  );
  if (!sentAt) throw new Failure("invalid_message_timestamp", false);

  const providerChannel = canonicalChannel(
    firstTextFrom(sources, ["channel", "provider", "ota_name", "source"]),
  );
  const sourceBookingId = firstTextFrom(sources, [
    "channel_booking_id",
    "booking_id",
    "source_booking_id",
  ]);
  const inquiry = record(firstValue(sources, "inquiry"));
  const meta = record(firstValue(sources, "meta"));
  const bookingDetails = record(meta["booking_details"]);
  const providerInquiryId =
    firstTextFrom(sources, ["provider_inquiry_id", "inquiry_id"]) ??
    text(inquiry["id"]) ??
    text(meta["live_feed_event_id"]);
  const messageType = firstTextFrom(sources, ["message_type", "conversation_type"]);
  const isInquiry =
    !sourceBookingId &&
    Boolean(
      (providerChannel === "airbnb" &&
        (providerInquiryId ||
          Object.keys(inquiry).length ||
          messageType?.toLowerCase().includes("inquiry"))) ||
      (senderType === "system" &&
        body.trim().toLowerCase() === "inquiry" &&
        providerInquiryId &&
        Object.keys(bookingDetails).length),
    );
  const direction = senderType === "system" && isInquiry ? "inbound" : senderDirection;
  const inquirySources = [bookingDetails, meta, inquiry, ...sources];
  const arrival = optionalDate(
    firstValueFrom(inquirySources, ["arrival_date", "checkin_date", "check_in", "checkin"]),
  );
  const departure = optionalDate(
    firstValueFrom(inquirySources, ["departure_date", "checkout_date", "check_out", "checkout"]),
  );
  if (
    (arrival && !departure) ||
    (!arrival && departure) ||
    (arrival && departure && arrival >= departure)
  )
    throw new Failure("invalid_inquiry_dates", false);
  const senderDisplayName =
    text(senderRecord["name"]) ?? firstTextFrom(sources, ["sender_name", "sender_display_name"]);

  return {
    threadId,
    sourceMessageId,
    direction,
    senderType,
    senderDisplayName,
    body,
    sentAt,
    providerChannel,
    guestDisplayName:
      firstTextFrom(inquirySources, ["guest_name", "guest_display_name", "title"]) ??
      (direction === "inbound" ? senderDisplayName : null),
    guestEmail: firstTextFrom(sources, ["guest_email"]),
    sourceBookingId,
    providerInquiryId,
    inquiry: isInquiry,
    inquiryArrivalDate: isInquiry ? arrival : null,
    inquiryDepartureDate: isInquiry ? departure : null,
    inquiryAdults: isInquiry
      ? optionalInteger(
          firstValueFrom(inquirySources, ["adults", "adult_count", "number_of_adults"]),
        )
      : null,
    inquiryChildren: isInquiry
      ? optionalInteger(
          firstValueFrom(inquirySources, ["children", "children_count", "number_of_children"]),
        )
      : null,
    attachments,
    rawPayload: Object.keys(nested).length ? nested : rawPayload,
  };
}

async function fetchThreadMetadata(
  threadId: string,
  providerPropertyId: string,
  options: Parameters<typeof runChannexMessageJobs>[1],
): Promise<ThreadMetadata> {
  const response = await fetchProviderResource(
    new URL(`/api/v1/message_threads/${encodeURIComponent(threadId)}`, `${options.apiBaseUrl}/`),
    options,
    { unavailable: "provider_unavailable", invalidRedirect: "provider_rejected" },
  );
  if (!response.ok)
    throw new Failure(
      response.status === 429
        ? "rate_limited"
        : response.status >= 500 || response.status === 404
          ? "provider_unavailable"
          : "provider_rejected",
      response.status === 429 || response.status >= 500 || response.status === 404,
    );
  const raw = record(await response.json());
  const data = Object.keys(record(raw["data"])).length ? record(raw["data"]) : raw;
  if (text(data["id"]) && text(data["id"]) !== threadId)
    throw new Failure("provider_thread_identity_mismatch", false);
  const attributes = Object.keys(record(data["attributes"])).length
    ? record(data["attributes"])
    : data;
  const relationships = record(data["relationships"]);
  const booking = record(record(relationships["booking"])["data"]);
  const property = record(record(relationships["property"])["data"]);
  const providerPropertyIds = suppliedProviderPropertyIds([raw, data, attributes, property]);
  const relationshipPropertyId = text(property["id"]);
  if (relationshipPropertyId) providerPropertyIds.push(relationshipPropertyId);
  if (
    providerPropertyIds.length === 0 ||
    providerPropertyIds.some((candidate) => candidate !== providerPropertyId)
  )
    throw new Failure("provider_thread_property_mismatch", false);
  const inquiry = record(attributes["inquiry"]);
  const providerChannel = canonicalChannel(
    firstText(attributes, data, "provider") ?? firstText(attributes, data, "channel"),
  );
  const sourceBookingId = text(booking["id"]) ?? firstText(attributes, data, "booking_id");
  const providerInquiryId = text(inquiry["id"]) ?? text(attributes["inquiry_id"]);
  const isInquiry = providerChannel === "airbnb" && !sourceBookingId && Boolean(providerInquiryId);
  return {
    providerPropertyId,
    providerChannel,
    guestDisplayName: firstText(attributes, data, "title"),
    guestEmail: firstText(attributes, data, "guest_email"),
    sourceBookingId,
    providerInquiryId,
    inquiry: isInquiry,
    inquiryArrivalDate: isInquiry
      ? optionalDate(inquiry["arrival_date"] ?? attributes["arrival_date"])
      : null,
    inquiryDepartureDate: isInquiry
      ? optionalDate(inquiry["departure_date"] ?? attributes["departure_date"])
      : null,
    inquiryAdults: isInquiry ? optionalInteger(inquiry["adults"] ?? attributes["adults"]) : null,
    inquiryChildren: isInquiry
      ? optionalInteger(inquiry["children"] ?? attributes["children"])
      : null,
  };
}

function mergeThreadMetadata(message: Message, metadata: Partial<Message>): Message {
  const sourceBookingId = metadata.sourceBookingId ?? message.sourceBookingId ?? null;
  const providerChannel = metadata.providerChannel ?? message.providerChannel ?? null;
  const inquiry = !sourceBookingId && (message.inquiry || metadata.inquiry === true);
  if (inquiry && providerChannel !== "airbnb") throw new Failure("invalid_inquiry_channel", false);
  return {
    ...message,
    providerChannel,
    guestDisplayName: metadata.guestDisplayName ?? message.guestDisplayName ?? null,
    guestEmail: metadata.guestEmail ?? message.guestEmail ?? null,
    sourceBookingId,
    providerInquiryId: metadata.providerInquiryId ?? message.providerInquiryId ?? null,
    inquiry,
    inquiryArrivalDate: metadata.inquiryArrivalDate ?? message.inquiryArrivalDate ?? null,
    inquiryDepartureDate: metadata.inquiryDepartureDate ?? message.inquiryDepartureDate ?? null,
    inquiryAdults: metadata.inquiryAdults ?? message.inquiryAdults ?? null,
    inquiryChildren: metadata.inquiryChildren ?? message.inquiryChildren ?? null,
  };
}

function parseAttachments(value: unknown, apiBaseUrl: string): Attachment[] {
  if (!Array.isArray(value) || value.length > 25)
    throw new Failure("invalid_message_attachments", false);
  const seen = new Set<string>();
  const attachments: Attachment[] = [];
  for (const [ordinal, item] of value.entries()) {
    const directUrl = text(item);
    const attachment = record(item);
    if (!directUrl && !Object.keys(attachment).length)
      throw new Failure("invalid_message_attachment", false);
    const links = record(attachment["links"]);
    const sourceAttachmentId = text(attachment["id"]);
    const sourceUrl = secureUrl(
      directUrl ?? text(links["url"]) ?? text(attachment["url"]),
      apiBaseUrl,
    );
    if (!sourceUrl) throw new Failure("invalid_message_attachment", false);
    const dedupeKey = sourceAttachmentId ?? sourceUrl!;
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);
    const size = attachment["size"] ?? attachment["size_bytes"];
    if (
      size !== undefined &&
      (typeof size !== "number" || !Number.isInteger(size) || size < 0 || size > 2_147_483_647)
    )
      throw new Failure("invalid_message_attachment", false);
    attachments.push({
      ordinal,
      sourceAttachmentId,
      sourceUrl,
      filename: safeFilename(text(attachment["file_name"]) ?? text(attachment["filename"])),
      contentType: text(attachment["file_type"]) ?? text(attachment["content_type"]),
      sizeBytes: typeof size === "number" ? size : null,
      managed: null,
    });
  }
  return attachments;
}

function active(options: Parameters<typeof runChannexMessageJobs>[1]): void {
  if (options.signal?.aborted) throw new Failure("worker_shutdown", true);
  if (!options.ownsMutation()) throw new Failure("ownership_frozen", true);
}

async function fence(client: pg.PoolClient, job: Job): Promise<void> {
  const locked = await client.query(
    `UPDATE platform.jobs SET locked_at = now(), updated_at = now()
     WHERE id = $1::uuid AND attempts_count = $2 AND status = 'running' AND locked_by = $3
     RETURNING id`,
    [job.id, job.attempt, job.workerId],
  );
  if (!locked.rowCount) throw new LeaseLost();
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function firstValue(sources: readonly Record<string, unknown>[], key: string): unknown {
  return sources.find((source) => source[key] !== undefined)?.[key];
}

function firstValueFrom(
  sources: readonly Record<string, unknown>[],
  keys: readonly string[],
): unknown {
  for (const source of sources)
    for (const key of keys) if (source[key] !== undefined) return source[key];
  return undefined;
}

function firstText(
  first: Record<string, unknown>,
  second: Record<string, unknown>,
  key: string,
): string | null {
  return text(first[key]) ?? text(second[key]);
}

function firstTextFrom(
  sources: readonly Record<string, unknown>[],
  keys: readonly string[],
): string | null {
  return text(firstValueFrom(sources, keys));
}

function suppliedProviderPropertyIds(sources: readonly Record<string, unknown>[]): string[] {
  return sources
    .map((source) => text(source["property_id"]))
    .filter((value): value is string => value !== null);
}

function text(value: unknown): string | null {
  const parsed =
    typeof value === "number" && Number.isFinite(value)
      ? String(value)
      : typeof value === "string"
        ? value.trim()
        : "";
  return parsed && parsed.length <= 500 ? parsed : null;
}

function uuid(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
  );
}

function timestamp(value: unknown): string | null {
  const parsed = text(value);
  const match = parsed?.match(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,9})?(Z|[+-]\d\d:\d\d)?$/);
  if (!parsed || !match) return null;
  const instant = new Date(match[1] ? parsed : `${parsed}Z`);
  return Number.isNaN(instant.getTime()) ? null : instant.toISOString();
}

function optionalDate(value: unknown): string | null {
  if (value === undefined || value === null || value === "") return null;
  const parsed = text(value);
  if (!parsed || !/^\d{4}-\d{2}-\d{2}$/.test(parsed))
    throw new Failure("invalid_inquiry_date", false);
  const instant = new Date(`${parsed}T00:00:00.000Z`);
  if (Number.isNaN(instant.getTime()) || instant.toISOString().slice(0, 10) !== parsed)
    throw new Failure("invalid_inquiry_date", false);
  return parsed;
}

function optionalInteger(value: unknown): number | null {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0 || value > 100)
    throw new Failure("invalid_inquiry_occupancy", false);
  return value;
}

function canonicalChannel(value: string | null): string | null {
  if (!value) return null;
  const key = value.replace(/[^a-z0-9]/gi, "").toLowerCase();
  if (key === "booking" || key === "bookingcom") return "booking.com";
  if (key === "airbnb" || key === "abnb") return "airbnb";
  if (key.includes("expedia")) return "expedia";
  if (key === "agoda") return "agoda";
  return "other";
}

async function fetchProviderResource(
  input: string | URL,
  options: Parameters<typeof runChannexMessageJobs>[1],
  codes: { unavailable: string; invalidRedirect: string },
): Promise<Response> {
  const request = options.fetch ?? fetch;
  let current = input instanceof URL ? input : new URL(input);
  const signal = options.signal
    ? AbortSignal.any([options.signal, AbortSignal.timeout(30_000)])
    : AbortSignal.timeout(30_000);
  for (let redirects = 0; redirects <= 5; redirects += 1) {
    if (!isProviderResourceUrl(current, options.apiBaseUrl))
      throw new Failure(codes.invalidRedirect, false);
    let response: Response;
    try {
      response = await request(current, {
        headers: { "user-api-key": options.apiKey },
        redirect: "manual",
        signal,
      });
    } catch {
      throw new Failure(codes.unavailable, true);
    }
    if (![301, 302, 303, 307, 308].includes(response.status)) return response;
    const location = response.headers.get("location");
    if (!location || redirects === 5) throw new Failure(codes.invalidRedirect, false);
    try {
      current = new URL(location, current);
    } catch {
      throw new Failure(codes.invalidRedirect, false);
    }
  }
  throw new Failure(codes.invalidRedirect, false);
}

function isProviderResourceUrl(url: URL, apiBaseUrl: string): boolean {
  try {
    const providerOrigin = new URL(apiBaseUrl);
    return (
      providerOrigin.protocol === "https:" &&
      !providerOrigin.username &&
      !providerOrigin.password &&
      url.protocol === "https:" &&
      !url.username &&
      !url.password &&
      url.origin === providerOrigin.origin &&
      (url.pathname === "/api/v1" || url.pathname.startsWith("/api/v1/"))
    );
  } catch {
    return false;
  }
}

function secureUrl(value: string | null, apiBaseUrl: string): string | null {
  if (!value) return null;
  try {
    const providerOrigin = new URL(apiBaseUrl);
    if (providerOrigin.protocol !== "https:" || providerOrigin.username || providerOrigin.password)
      throw new Failure("invalid_message_attachment_url", false);
    const absolute = /^[a-z][a-z0-9+.-]*:/i.test(value);
    const providerPath = value.startsWith("/api/v1/") ? value : value.replace(/^\/+/, "");
    const url = absolute
      ? new URL(value)
      : value.startsWith("/api/v1/")
        ? new URL(providerPath, providerOrigin)
        : new URL(providerPath, new URL("/api/v1/", providerOrigin));
    if (!isProviderResourceUrl(url, apiBaseUrl))
      throw new Failure("invalid_message_attachment_url", false);
    return url.toString();
  } catch (error) {
    if (error instanceof Failure) throw error;
    throw new Failure("invalid_message_attachment_url", false);
  }
}

async function readResponseBytes(response: Response, maxBytes: number): Promise<Uint8Array> {
  if (!response.body) throw new Failure("invalid_message_attachment", false);
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > maxBytes) throw new Failure("invalid_message_attachment", false);
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  if (!size) throw new Failure("invalid_message_attachment", false);
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  return bytes;
}

function stableUuid(value: string): string {
  const bytes = createHash("sha256").update(value).digest().subarray(0, 16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x50;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function safeFilename(value: string | null): string | null {
  if (!value) return null;
  const filename = value
    .split(/[\\/]/)
    .at(-1)
    ?.replace(/[\u0000-\u001f\u007f]/g, "")
    .trim();
  return filename ? filename.slice(0, 255) : null;
}

function pgCode(value: unknown): string | null {
  return value && typeof value === "object" && "code" in value && typeof value.code === "string"
    ? value.code
    : null;
}

async function transaction<T>(
  pool: pg.Pool,
  run: (client: pg.PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL lock_timeout='5s';SET LOCAL statement_timeout='30s'");
    const value = await run(client);
    await client.query("COMMIT");
    return value;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}
