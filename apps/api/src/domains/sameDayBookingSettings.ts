import type { RequestContext } from "@vayada/backend-auth";
import {
  SAME_DAY_BOOKING_POLICY_DEFAULTS,
  type SameDayBookingPolicy,
} from "@vayada/domain-booking";
import { createHash } from "node:crypto";
import pg from "pg";

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
    }
  | { ok: false; code: "property_not_found" | "idempotency_conflict" };

export type SameDayBookingSettingsPort = {
  find(propertyId: string): Promise<SameDayBookingSettings | null>;
  update(
    context: RequestContext,
    propertyId: string,
    input: SameDayBookingPolicy & { commandId: string; idempotencyKey: string },
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
    update: (context, propertyId, input) => updateSettings(pool, now(), context, propertyId, input),
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
         jsonb_build_object('commandId', $7)
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
      await insertDistributionEvent(client, context, row, keyHash, acceptedAt);
      await insertAudit(client, context, row, input.commandId, acceptedAt);
    }
    await client.query(
      `UPDATE platform.idempotency_keys SET status = 'completed', completed_at = $2::timestamptz,
         response_status_code = 200, response_resource_product = 'booking',
         response_resource_type = 'same_day_booking_policy', response_resource_id = $3,
         idempotency_metadata = idempotency_metadata || jsonb_build_object('revision', $4::integer)
       WHERE id = $1::uuid`,
      [reserved.rows[0].id, acceptedAt.toISOString(), propertyId, row.revision],
    );
    await client.query("COMMIT");
    return { ok: true, settings: settings(row), replayed: false };
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
  }>(
    `SELECT request_fingerprint_hash AS "requestFingerprintHash"
     FROM platform.idempotency_keys
     WHERE operation_scope = 'booking' AND operation = $1 AND key_hash = $2
       AND property_id = $3::uuid FOR UPDATE`,
    [OPERATION, keyHash, propertyId],
  );
  if (existing.rows[0]?.requestFingerprintHash !== fingerprint)
    return { ok: false, code: "idempotency_conflict" };
  const row = (await readSettings(client, propertyId, false)).rows[0];
  if (!row) return { ok: false, code: "property_not_found" };
  return {
    ok: true,
    settings: settings(row),
    replayed: true,
  };
}

function readSettings(client: Pick<Pool, "query">, propertyId: string, lock: boolean) {
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
     WHERE property.id = $1::uuid ${lock ? "FOR KEY SHARE OF property" : ""}`,
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
  acceptedAt: Date,
) {
  await client.query(
    `INSERT INTO platform.product_audit_events (
       audit_key, product, action, occurred_at, tenant_scope, property_id, actor_type,
       actor_user_id, target_resource_product, target_resource_type, target_resource_id,
       correlation_id, causation_id, redacted_payload, audit_metadata
     ) VALUES ($1, 'booking', 'booking.same_day_booking_policy.changed', $2::timestamptz,
       'property', $3::uuid, 'user', $4::uuid, 'booking', 'same_day_booking_policy', $3,
       $5, $6, jsonb_build_object('revision', $7::integer),
       '{"source":"pms-web"}'::jsonb) ON CONFLICT (product, audit_key) DO NOTHING`,
    [
      `booking.same-day-policy.changed:${row.propertyId}:${row.revision}`,
      acceptedAt.toISOString(),
      row.propertyId,
      context.actor.internalUserId,
      context.audit.correlationId ?? context.audit.requestId,
      commandId,
      row.revision,
    ],
  );
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
