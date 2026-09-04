import type { RequestContext } from "@vayada/backend-auth";
import { buildChannexManagementJobKey } from "@vayada/domain-pms-channex";
import { createHash } from "node:crypto";
import pg from "pg";

import type {
  PmsChannexManagementCommandInput,
  PmsChannexManagementCommandPort,
  PmsChannexManagementCommandResult,
} from "./pmsChannexManagementCommands.js";
import {
  mapPmsChannexManagementOperation,
  PMS_CHANNEX_MANAGEMENT_QUEUE,
  type PmsChannexManagementJobRow,
} from "./pmsChannexManagementReadModel.js";

const MANAGEMENT_OPERATION = "channex_management";
const MAX_ATTEMPTS = 5;
type Client = {
  query<T extends pg.QueryResultRow = pg.QueryResultRow>(
    text: string,
    values?: unknown[],
  ): Promise<{ rows: T[] }>;
  release(): void;
};
type Pool = { connect(): Promise<Client>; end(): Promise<void> };

export function createPgPmsChannexManagementCommandPort(config: {
  connectionString: string;
  pool?: Pool;
  now?: () => Date;
}): PmsChannexManagementCommandPort {
  const pool =
    config.pool ?? new pg.Pool({ connectionString: required(config.connectionString), max: 5 });
  const now = config.now ?? (() => new Date());
  return {
    enqueue: (context, propertyId, input) => enqueue(pool, now(), context, propertyId, input),
    async close() {
      await pool.end();
    },
  };
}

async function enqueue(
  pool: Pool,
  acceptedAt: Date,
  context: RequestContext,
  propertyId: string,
  input: PmsChannexManagementCommandInput,
): Promise<PmsChannexManagementCommandResult> {
  const client = (await pool.connect()) as Client;
  const keyHash = sha256(input.idempotencyKey);
  const fingerprint = sha256(stableJson(fingerprintPayload(input)));
  const jobKey = buildChannexManagementJobKey({
    propertyId,
    operationType: input.operationType,
    idempotencyKey: input.idempotencyKey,
  });
  try {
    await client.query("BEGIN");
    if (requiresConnection(input.operationType) && !(await hasConnection(client, propertyId))) {
      await client.query("ROLLBACK");
      return { ok: false, code: "connection_required", message: "Enable Channex first." };
    }
    const reservation = await client.query<{ id: string }>(
      `INSERT INTO platform.idempotency_keys (
         operation_scope, operation, key_hash, request_fingerprint_hash, status,
         tenant_scope, property_id, correlation_id, locked_until, expires_at,
         idempotency_metadata
       ) VALUES (
         'pms', $1, $2, $3, 'in_progress', 'property', $4::uuid, $5,
         $6::timestamptz + interval '15 minutes', $6::timestamptz + interval '24 hours',
         jsonb_build_object('commandId', $7, 'operationType', $8)
       ) ON CONFLICT (operation_scope, operation, key_hash, scope_key) DO NOTHING
       RETURNING id::text AS id`,
      [
        MANAGEMENT_OPERATION,
        keyHash,
        fingerprint,
        propertyId,
        context.audit.correlationId ?? context.audit.requestId,
        acceptedAt.toISOString(),
        input.commandId,
        input.operationType,
      ],
    );
    if (!reservation.rows[0]) {
      const replay = await replayExisting(client, propertyId, keyHash, fingerprint, jobKey);
      await client.query(replay.ok ? "COMMIT" : "ROLLBACK");
      return replay;
    }
    const job = await client.query<PmsChannexManagementJobRow>(
      `INSERT INTO platform.jobs (
         job_key, queue_name, job_type, status, max_attempts, tenant_scope, property_id,
         resource_product, resource_type, resource_id, correlation_id,
         idempotency_key_hash, payload, job_metadata
       ) VALUES (
         $1, $2, $3, 'pending', $4, 'property', $5::uuid,
         'pms', 'channex_connection', $5, $6, $7, $8::jsonb,
         jsonb_build_object('requestFingerprintHash', $9, 'acceptedBy', $10)
       ) RETURNING id::text AS "operationId", property_id::text AS "propertyId", status,
         attempts_count AS "attemptsMade", max_attempts AS "maxAttempts",
         run_after AS "runAfter", created_at AS "acceptedAt", payload, job_metadata AS metadata`,
      [
        jobKey,
        PMS_CHANNEX_MANAGEMENT_QUEUE,
        `channex.${input.operationType}`,
        MAX_ATTEMPTS,
        propertyId,
        context.audit.correlationId ?? context.audit.requestId,
        keyHash,
        JSON.stringify({ ...input, actorUserId: context.actor.internalUserId }),
        fingerprint,
        context.actor.internalUserId,
      ],
    );
    const row = job.rows[0];
    if (!row) throw new Error("Channex management job was not created");
    await client.query(
      `UPDATE platform.idempotency_keys
       SET idempotency_metadata = idempotency_metadata || jsonb_build_object('jobId', $2::text)
       WHERE id = $1::uuid`,
      [reservation.rows[0].id, row.operationId],
    );
    await insertAcceptedAudit(client, context, propertyId, input, row.operationId, acceptedAt);
    await client.query("COMMIT");
    return { ok: true, operation: mapPmsChannexManagementOperation(row), replayed: false };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function replayExisting(
  client: Client,
  propertyId: string,
  keyHash: string,
  fingerprint: string,
  jobKey: string,
): Promise<PmsChannexManagementCommandResult> {
  const record = await client.query<{ requestFingerprintHash: string }>(
    `SELECT request_fingerprint_hash AS "requestFingerprintHash"
     FROM platform.idempotency_keys
     WHERE operation_scope = 'pms' AND operation = $1 AND key_hash = $2
       AND tenant_scope = 'property' AND property_id = $3::uuid
     FOR UPDATE`,
    [MANAGEMENT_OPERATION, keyHash, propertyId],
  );
  if (record.rows[0]?.requestFingerprintHash !== fingerprint) {
    return {
      ok: false,
      code: "idempotency_conflict",
      message: "The idempotency key was already used for another command.",
    };
  }
  const job = await client.query<PmsChannexManagementJobRow>(
    `SELECT id::text AS "operationId", property_id::text AS "propertyId", status,
       attempts_count AS "attemptsMade", max_attempts AS "maxAttempts",
       run_after AS "runAfter", created_at AS "acceptedAt", payload, job_metadata AS metadata
     FROM platform.jobs WHERE queue_name = $1 AND job_key = $2 LIMIT 1`,
    [PMS_CHANNEX_MANAGEMENT_QUEUE, jobKey],
  );
  if (!job.rows[0]) throw new Error("Reserved Channex management job is missing");
  return { ok: true, operation: mapPmsChannexManagementOperation(job.rows[0]), replayed: true };
}

async function insertAcceptedAudit(
  client: Client,
  context: RequestContext,
  propertyId: string,
  input: PmsChannexManagementCommandInput,
  jobId: string,
  acceptedAt: Date,
) {
  await client.query(
    `INSERT INTO platform.product_audit_events (
       audit_key, product, action, occurred_at, tenant_scope, property_id,
       actor_type, actor_user_id, target_resource_product, target_resource_type,
       target_resource_id, job_id, correlation_id, causation_id,
       redacted_payload, audit_metadata
     ) VALUES (
       $1, 'pms', $2, $3::timestamptz, 'property', $4::uuid,
       'user', $5::uuid, 'pms', 'channex_connection', $4, $6::uuid, $7, $8,
       jsonb_build_object('operationType', $9), jsonb_build_object('source', 'pms-web')
     ) ON CONFLICT (product, audit_key) DO NOTHING`,
    [
      `channex.management.accepted:${jobId}`,
      `pms.channex.${input.operationType}.accepted`,
      acceptedAt.toISOString(),
      propertyId,
      context.actor.internalUserId,
      jobId,
      context.audit.correlationId ?? context.audit.requestId,
      input.commandId,
      input.operationType,
    ],
  );
}

async function hasConnection(client: Client, propertyId: string): Promise<boolean> {
  const result = await client.query(
    `SELECT 1 FROM pms.channel_connections
     WHERE property_id = $1::uuid AND provider = 'channex'
       AND connection_status IN ('connected', 'degraded') FOR SHARE`,
    [propertyId],
  );
  return Boolean(result.rows[0]);
}

function requiresConnection(type: PmsChannexManagementCommandInput["operationType"]): boolean {
  return type !== "enable" && type !== "disable";
}

function fingerprintPayload(input: PmsChannexManagementCommandInput) {
  return {
    operationType: input.operationType,
    businessProfileConfirmed: input.businessProfileConfirmed === true,
    markups: input.markups
      ? [...input.markups].sort((a, b) => a.channel.localeCompare(b.channel))
      : [],
  };
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function required(value: string): string {
  if (!value.trim()) throw new Error("PMS Channex connectionString must not be empty");
  return value;
}
