import type { RequestContext } from "@vayada/backend-auth";
import {
  SAME_DAY_BOOKING_POLICY_DEFAULTS,
  type SameDayBookingPolicy,
} from "@vayada/domain-booking";
import { buildChannexManagementJobKey } from "@vayada/domain-pms-channex";
import { createHash } from "node:crypto";
import pg from "pg";

import { PMS_CHANNEX_MANAGEMENT_QUEUE } from "./pmsChannexManagementReadModel.js";

export type SameDayBookingSettings = SameDayBookingPolicy & {
  propertyId: string;
  propertyTimeZone: string;
  revision: number;
  updatedAt: string | null;
};

export type SameDayBookingSettingsResult =
  | {
      ok: true;
      settings: SameDayBookingSettings;
      replayed: boolean;
      channexOperationId: string | null;
    }
  | { ok: false; code: "property_not_found" | "idempotency_conflict" };

export type SameDayBookingSettingsPort = {
  find(propertyId: string): Promise<SameDayBookingSettings | null>;
  update(
    context: RequestContext,
    propertyId: string,
    input: SameDayBookingPolicy & { commandId: string; idempotencyKey: string },
    source: "booking-admin" | "pms-web",
  ): Promise<SameDayBookingSettingsResult>;
  close?(): Promise<void>;
};

type SettingsRow = {
  propertyId: string;
  propertyTimeZone: string | null;
  configured: boolean;
  enabled: boolean;
  cutoffLocalTime: string | null;
  revision: number;
  updatedAt: string | null;
};
type Client = {
  query<T extends pg.QueryResultRow = pg.QueryResultRow>(
    text: string,
    values?: unknown[],
  ): Promise<{ rows: T[] }>;
  release(): void;
};
type Pool = { query: Client["query"]; connect(): Promise<Client>; end(): Promise<void> };

const OPERATION = "same_day_booking_policy_update";

export function createTargetSameDayBookingSettingsPort(config: {
  connectionString: string;
  pool?: Pool;
  now?: () => Date;
}): SameDayBookingSettingsPort {
  if (!config.connectionString.trim()) throw new Error("Target database URL must not be empty");
  const pool = config.pool ?? new pg.Pool({ connectionString: config.connectionString, max: 5 });
  const now = config.now ?? (() => new Date());
  return {
    async find(propertyId) {
      const row = (await readSettings(pool, propertyId, false)).rows[0];
      return row ? settings(row) : null;
    },
    update: (context, propertyId, input, source) =>
      updateSettings(pool, now(), context, propertyId, input, source),
    async close() {
      await pool.end();
    },
  };
}

async function updateSettings(
  pool: Pool,
  acceptedAt: Date,
  context: RequestContext,
  propertyId: string,
  input: SameDayBookingPolicy & { commandId: string; idempotencyKey: string },
  source: "booking-admin" | "pms-web",
): Promise<SameDayBookingSettingsResult> {
  const client = await pool.connect();
  const keyHash = sha256(input.idempotencyKey);
  const fingerprint = sha256(JSON.stringify([input.enabled, input.cutoffLocalTime]));
  try {
    await client.query("BEGIN");
    const reserved = await client.query<{ id: string }>(
      `INSERT INTO platform.idempotency_keys (
         operation_scope, operation, key_hash, request_fingerprint_hash, status,
         tenant_scope, property_id, correlation_id, locked_until, expires_at,
         idempotency_metadata
       ) VALUES (
         'booking', $1, $2, $3, 'in_progress', 'property', $4::uuid, $5,
         $6::timestamptz + interval '15 minutes', $6::timestamptz + interval '24 hours',
         jsonb_build_object('commandId', $7::text)
       ) ON CONFLICT (operation_scope, operation, key_hash, scope_key) DO NOTHING
       RETURNING id::text AS id`,
      [
        OPERATION,
        keyHash,
        fingerprint,
        propertyId,
        context.audit.correlationId ?? context.audit.requestId,
        acceptedAt.toISOString(),
        input.commandId,
      ],
    );
    if (!reserved.rows[0]) {
      const replayResult = await replay(client, propertyId, keyHash, fingerprint);
      await client.query(replayResult.ok ? "COMMIT" : "ROLLBACK");
      return replayResult;
    }

    const current = (await readSettings(client, propertyId, true)).rows[0];
    if (!current) {
      await client.query("ROLLBACK");
      return { ok: false, code: "property_not_found" };
    }
    validateTimeZone(current.propertyTimeZone);
    const changed =
      !current.configured ||
      current.enabled !== input.enabled ||
      current.cutoffLocalTime !== input.cutoffLocalTime;
    let row = current;
    let channexOperationId: string | null = null;
    if (changed) {
      row = (
        await client.query<SettingsRow>(
          `INSERT INTO booking.same_day_booking_policies (
             property_id, enabled, cutoff_local_time, revision, source_freshness, updated_at
           ) VALUES ($1::uuid, $2, $3, 1, '{}'::jsonb, $4::timestamptz)
           ON CONFLICT (property_id) DO UPDATE SET
             enabled = EXCLUDED.enabled, cutoff_local_time = EXCLUDED.cutoff_local_time,
             revision = same_day_booking_policies.revision + 1,
             updated_at = EXCLUDED.updated_at
           RETURNING property_id::text AS "propertyId", $5::text AS "propertyTimeZone",
             TRUE AS configured, enabled, cutoff_local_time AS "cutoffLocalTime", revision,
             updated_at::text AS "updatedAt"`,
          [
            propertyId,
            input.enabled,
            input.cutoffLocalTime,
            acceptedAt.toISOString(),
            current.propertyTimeZone,
          ],
        )
      ).rows[0]!;
      const event = await insertDistributionEvent(client, context, row, keyHash, acceptedAt);
      channexOperationId = await enqueueChannexSync(
        client,
        context,
        propertyId,
        input,
        event,
        acceptedAt,
      );
      await insertAudit(
        client,
        context,
        row,
        input.commandId,
        channexOperationId,
        acceptedAt,
        source,
      );
    }
    const responseSettings = settings(row);
    await client.query(
      `UPDATE platform.idempotency_keys SET status = 'completed', completed_at = $2::timestamptz,
         response_status_code = 200, response_resource_product = 'booking',
         response_resource_type = 'same_day_booking_policy', response_resource_id = $3,
         idempotency_metadata = idempotency_metadata || jsonb_build_object(
           'revision', $4::integer, 'channexOperationId', $5::text, 'response', $6::jsonb)
       WHERE id = $1::uuid`,
      [
        reserved.rows[0].id,
        acceptedAt.toISOString(),
        propertyId,
        row.revision,
        channexOperationId,
        JSON.stringify(responseSettings),
      ],
    );
    await client.query("COMMIT");
    return { ok: true, settings: responseSettings, replayed: false, channexOperationId };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function replay(
  client: Client,
  propertyId: string,
  keyHash: string,
  fingerprint: string,
): Promise<SameDayBookingSettingsResult> {
  const existing = await client.query<{
    requestFingerprintHash: string;
    channexOperationId: string | null;
    response: SameDayBookingSettings | null;
  }>(
    `SELECT request_fingerprint_hash AS "requestFingerprintHash",
       idempotency_metadata ->> 'channexOperationId' AS "channexOperationId",
       idempotency_metadata -> 'response' AS response
     FROM platform.idempotency_keys
     WHERE operation_scope = 'booking' AND operation = $1 AND key_hash = $2
       AND property_id = $3::uuid FOR UPDATE`,
    [OPERATION, keyHash, propertyId],
  );
  if (existing.rows[0]?.requestFingerprintHash !== fingerprint)
    return { ok: false, code: "idempotency_conflict" };
  const response = existing.rows[0].response;
  if (!response) throw new Error("Completed same-day booking command response is missing");
  return {
    ok: true,
    settings: response,
    replayed: true,
    channexOperationId: existing.rows[0].channexOperationId,
  };
}

async function readSettings(client: Pick<Pool, "query">, propertyId: string, lock: boolean) {
  if (lock) {
    await client.query(
      `SELECT property.id FROM hotel_catalog.properties property
       WHERE property.id = $1::uuid FOR UPDATE OF property`,
      [propertyId],
    );
  }
  return client.query<SettingsRow>(
    `SELECT property.id::text AS "propertyId", location.timezone AS "propertyTimeZone",
       policy.property_id IS NOT NULL AS configured,
       COALESCE(policy.enabled, $2::boolean) AS enabled,
       CASE WHEN policy.property_id IS NULL THEN $3::text ELSE policy.cutoff_local_time END
         AS "cutoffLocalTime",
       COALESCE(policy.revision, 0) AS revision, policy.updated_at::text AS "updatedAt"
     FROM hotel_catalog.properties property
     LEFT JOIN hotel_catalog.property_locations location ON location.property_id = property.id
     LEFT JOIN booking.same_day_booking_policies policy ON policy.property_id = property.id
     WHERE property.id = $1::uuid`,
    [
      propertyId,
      SAME_DAY_BOOKING_POLICY_DEFAULTS.enabled,
      SAME_DAY_BOOKING_POLICY_DEFAULTS.cutoffLocalTime,
    ],
  );
}

async function insertDistributionEvent(
  client: Client,
  context: RequestContext,
  row: SettingsRow,
  keyHash: string,
  acceptedAt: Date,
): Promise<{ domainEventId: string; outboxEventId: string }> {
  const eventKey = `booking.same-day-policy.${row.propertyId}.revision.${row.revision}.changed.v1`;
  const payload = JSON.stringify(settings(row));
  const event = await client.query<{ id: string }>(
    `INSERT INTO platform.domain_events (
       source_system, event_key, event_type, occurred_at, tenant_scope, property_id,
       resource_product, resource_type, resource_id, actor_type, actor_user_id,
       correlation_id, idempotency_key_hash, payload, event_metadata
     ) VALUES ('booking', $1, 'booking.same_day_booking_policy.changed', $2::timestamptz,
       'property', $3::uuid, 'booking', 'same_day_booking_policy', $3, 'user', $4::uuid,
       $5, $6, $7::jsonb, '{"contractVersion":"same-day-booking-policy.v1"}'::jsonb)
     RETURNING id::text AS id`,
    [
      eventKey,
      acceptedAt.toISOString(),
      row.propertyId,
      context.actor.internalUserId,
      context.audit.correlationId ?? context.audit.requestId,
      keyHash,
      payload,
    ],
  );
  const outbox = await client.query<{ id: string }>(
    `INSERT INTO platform.outbox_events (
       domain_event_id, outbox_key, destination, event_type, tenant_scope, property_id,
       resource_product, resource_type, resource_id, correlation_id,
       idempotency_key_hash, payload, outbox_metadata
     ) VALUES ($1::uuid, $2, 'distribution.public-bookability',
       'booking.same_day_booking_policy.changed', 'property', $3::uuid,
       'booking', 'same_day_booking_policy', $3, $4, $5, $6::jsonb,
       '{"contractVersion":"same-day-booking-policy.v1"}'::jsonb)
     RETURNING id::text AS id`,
    [
      event.rows[0]!.id,
      `${eventKey}.distribution`,
      row.propertyId,
      context.audit.correlationId ?? context.audit.requestId,
      keyHash,
      payload,
    ],
  );
  return { domainEventId: event.rows[0]!.id, outboxEventId: outbox.rows[0]!.id };
}

async function insertAudit(
  client: Client,
  context: RequestContext,
  row: SettingsRow,
  commandId: string,
  jobId: string | null,
  acceptedAt: Date,
  source: "booking-admin" | "pms-web",
) {
  await client.query(
    `INSERT INTO platform.product_audit_events (
       audit_key, product, action, occurred_at, tenant_scope, property_id, actor_type,
       actor_user_id, target_resource_product, target_resource_type, target_resource_id,
       job_id, correlation_id, causation_id, redacted_payload, audit_metadata
     ) VALUES ($1, 'booking', 'booking.same_day_booking_policy.changed', $2::timestamptz,
       'property', $3::uuid, 'user', $4::uuid, 'booking', 'same_day_booking_policy', $3,
       $5::uuid, $6, $7, jsonb_build_object('revision', $8::integer),
       jsonb_build_object('source', $9::text)) ON CONFLICT (product, audit_key) DO NOTHING`,
    [
      `booking.same-day-policy.changed:${row.propertyId}:${row.revision}`,
      acceptedAt.toISOString(),
      row.propertyId,
      context.actor.internalUserId,
      jobId,
      context.audit.correlationId ?? context.audit.requestId,
      commandId,
      row.revision,
      source,
    ],
  );
}

async function enqueueChannexSync(
  client: Client,
  context: RequestContext,
  propertyId: string,
  input: { commandId: string; idempotencyKey: string },
  event: { domainEventId: string; outboxEventId: string },
  acceptedAt: Date,
): Promise<string | null> {
  const active = await client.query(
    `SELECT 1 FROM pms.channel_connections WHERE property_id = $1::uuid
       AND provider = 'channex' AND connection_status IN ('connected', 'degraded') FOR SHARE`,
    [propertyId],
  );
  if (!active.rows[0]) return null;
  const idempotencyKey = `${input.idempotencyKey}:channex`;
  const keyHash = sha256(idempotencyKey);
  const commandId = `${input.commandId}:channex`;
  const fingerprint = sha256(JSON.stringify({ markups: [], operationType: "sync_ari" }));
  const jobKey = buildChannexManagementJobKey({
    propertyId,
    operationType: "sync_ari",
    idempotencyKey,
  });
  await client.query(
    `INSERT INTO platform.idempotency_keys (
       operation_scope, operation, key_hash, request_fingerprint_hash, status,
       tenant_scope, property_id, correlation_id, locked_until, expires_at,
       idempotency_metadata
     ) VALUES ('pms', 'channex_management', $1, $2, 'in_progress', 'property', $3::uuid,
       $4, $5::timestamptz + interval '15 minutes', $5::timestamptz + interval '24 hours',
       jsonb_build_object('commandId', $6::text, 'operationType', 'sync_ari'))
     ON CONFLICT (operation_scope, operation, key_hash, scope_key) DO NOTHING`,
    [
      keyHash,
      fingerprint,
      propertyId,
      context.audit.correlationId ?? context.audit.requestId,
      acceptedAt.toISOString(),
      commandId,
    ],
  );
  const job = await client.query<{ id: string }>(
    `INSERT INTO platform.jobs (
       job_key, queue_name, job_type, source_domain_event_id, source_outbox_event_id,
       status, max_attempts, tenant_scope, property_id, resource_product, resource_type,
       resource_id, correlation_id, idempotency_key_hash, payload, job_metadata
     ) VALUES ($1, $2, 'channex.sync_ari', $3::uuid, $4::uuid, 'pending', 5, 'property',
       $5::uuid, 'pms', 'channex_connection', $5, $6, $7, $8::jsonb,
       '{"source":"same_day_booking_policy"}'::jsonb)
     ON CONFLICT (queue_name, job_key) DO UPDATE SET updated_at = platform.jobs.updated_at
     RETURNING id::text AS id`,
    [
      jobKey,
      PMS_CHANNEX_MANAGEMENT_QUEUE,
      event.domainEventId,
      event.outboxEventId,
      propertyId,
      context.audit.correlationId ?? context.audit.requestId,
      keyHash,
      JSON.stringify({ commandId, idempotencyKey, operationType: "sync_ari" }),
    ],
  );
  await client.query(
    `UPDATE platform.idempotency_keys
       SET idempotency_metadata = idempotency_metadata || jsonb_build_object('jobId', $4::text)
     WHERE operation_scope = 'pms' AND operation = 'channex_management'
       AND key_hash = $1 AND property_id = $2::uuid AND request_fingerprint_hash = $3`,
    [keyHash, propertyId, fingerprint, job.rows[0]!.id],
  );
  return job.rows[0]!.id;
}

function settings(row: SettingsRow): SameDayBookingSettings {
  validateTimeZone(row.propertyTimeZone);
  return {
    propertyId: row.propertyId,
    propertyTimeZone: row.propertyTimeZone!,
    enabled: row.enabled,
    cutoffLocalTime: row.cutoffLocalTime,
    revision: row.revision,
    updatedAt: row.updatedAt ? new Date(row.updatedAt).toISOString() : null,
  };
}

function validateTimeZone(value: string | null): asserts value is string {
  try {
    if (!value) throw new Error();
    new Intl.DateTimeFormat("en", { timeZone: value }).format(0);
  } catch {
    throw new Error("Property canonical timezone is missing or invalid");
  }
}

function sha256(value: string) {
  return createHash("sha256").update(value).digest("hex");
}
