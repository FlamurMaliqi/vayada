import { createHash, createHmac, randomUUID } from "node:crypto";
// prettier-ignore
import { FINANCE_FOLIO_CSV_VERSION, parseFinanceFolioExportFilters, parseFinanceFolioExportSnapshot, type FinanceFolioExportFilters, type FinanceFolioExportSnapshot } from "@vayada/domain-finance";
import pg, { type PoolClient } from "pg";
export const FINANCE_FOLIO_EXPORT_QUEUE = "finance.financials-exports";
export const FINANCE_FOLIO_EXPORT_JOB = "finance.folio-csv-export.v1";
export const FINANCE_FOLIO_EXPORT_TTL_MS = 24 * 60 * 60 * 1_000;
const OPERATION = "financials.folio_export.create.v1";
// prettier-ignore
export type FinanceFolioExportAudit = { actorUserId: string; requestId: string; correlationId: string; causationId: string; requestedAt: string };
// prettier-ignore
export type FinanceFolioExportJobPayload = { commandId: string; organizationId: string; snapshot: FinanceFolioExportSnapshot; expiresAt: string };
// prettier-ignore
export type FinanceFolioExportEnqueueResult = { status: "created" | "replayed"; exportId: string } | { status: "conflict" };
// prettier-ignore
type Command = { commandId: string; idempotencyKey: string; organizationId: string; propertyId: string; currency: string; filters: FinanceFolioExportFilters; snapshot: FinanceFolioExportSnapshot; audit: FinanceFolioExportAudit };
// prettier-ignore
type ExpectedPayload = { organizationId: string; propertyId: string; currency: string; payloadFingerprint: string; acceptedAt: string; snapshotAt: string; expiresAt: string; now: Date };

// prettier-ignore
export function createPgFinanceFolioExportJobRepository(config: { connectionString?: string; pool?: pg.Pool; searchDigestKey: string }) {
  if (!config.pool && !config.connectionString?.trim())
    throw new Error("Finance folio export jobs require a connection string");
  if (Buffer.byteLength(config.searchDigestKey) < 32)
    throw new Error("Finance folio export jobs require a search digest key");
  const pool = config.pool ?? new pg.Pool({ connectionString: config.connectionString, max: 3 });
  return {
    async enqueue(input: Command): Promise<FinanceFolioExportEnqueueResult> {
      const filters = parseFinanceFolioExportFilters(input.filters);
      const snapshot = parseFinanceFolioExportSnapshot(input.snapshot);
      if (!filters || !snapshot || !validCommand(input, filters, snapshot))
        throw new TypeError("Invalid folio export command");
      const keyHash = hash(input.idempotencyKey);
      // prettier-ignore
      const requestFingerprint = hash(JSON.stringify([input.commandId, input.organizationId, input.propertyId, input.currency, filters]));
      return transaction(pool, async (client) => {
        if (!(await authorizedScope(client, input))) throw new TypeError("Invalid folio export command");
        const exportId = randomUUID();
        const inserted = await client.query<{ acceptedAt: string; expiresAt: string }>(
          `INSERT INTO platform.idempotency_keys
            (id,operation_scope,operation,key_hash,request_fingerprint_hash,status,tenant_scope,
             property_id,response_status_code,response_resource_product,response_resource_type,
             response_resource_id,correlation_id,completed_at,expires_at,idempotency_metadata)
           VALUES($1::uuid,'finance',$2,$3,$4,'completed','property',$5::uuid,202,'finance',
             'financials_export',$1::text,$6,date_trunc('milliseconds',statement_timestamp()),
             date_trunc('milliseconds',statement_timestamp())+interval '24 hours',$7::jsonb)
           ON CONFLICT(operation_scope,operation,key_hash,scope_key) DO NOTHING RETURNING
             to_char(completed_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "acceptedAt",
             to_char(expires_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "expiresAt"`,
          // prettier-ignore
          [exportId, OPERATION, keyHash, requestFingerprint, input.propertyId, input.audit.correlationId, JSON.stringify({ commandId: input.commandId, organizationId: input.organizationId })],
        );
        if (!inserted.rowCount) {
          const prior = (
            await client.query<{ fingerprint: string; exportId: string }>(
              `SELECT i.request_fingerprint_hash AS fingerprint,i.response_resource_id AS "exportId"
               FROM platform.idempotency_keys i JOIN platform.jobs j
                 ON j.id::text=i.response_resource_id AND j.property_id=i.property_id
               WHERE i.operation_scope='finance' AND i.operation=$1 AND i.key_hash=$2
                 AND i.tenant_scope='property' AND i.property_id=$3::uuid AND i.status='completed'
                 AND i.expires_at>statement_timestamp() AND i.response_resource_product='finance'
                 AND i.response_resource_type='financials_export' AND j.queue_name=$4 AND j.job_type=$5
                 AND j.resource_product='finance' AND j.resource_type='financials_export'
               FOR UPDATE OF i`,
              // prettier-ignore
              [OPERATION, keyHash, input.propertyId, FINANCE_FOLIO_EXPORT_QUEUE, FINANCE_FOLIO_EXPORT_JOB],
            )
          ).rows[0];
          return prior?.fingerprint === requestFingerprint && uuid(prior.exportId)
            ? { status: "replayed", exportId: prior.exportId }
            : { status: "conflict" };
        }
        const { acceptedAt, expiresAt } = inserted.rows[0]!;
        if (new Date(snapshot.snapshotAt).getTime() > new Date(acceptedAt).getTime())
          throw new TypeError("Invalid folio export command");
        // prettier-ignore
        const payload: FinanceFolioExportJobPayload = { commandId: input.commandId, organizationId: input.organizationId, snapshot, expiresAt };
        const payloadFingerprint = hash(JSON.stringify(payload));
        // Private jobs carry the raw filter search; audit evidence carries only its digest below.
        // prettier-ignore
        const lineage = { actorUserId: input.audit.actorUserId, organizationId: input.organizationId, requestId: input.audit.requestId, correlationId: input.audit.correlationId, causationId: input.audit.causationId, requestedAt: input.audit.requestedAt };
        // prettier-ignore
        const jobMetadata = { acceptedAt, expiresAt, formatVersion: FINANCE_FOLIO_CSV_VERSION, manifestDigest: hash(JSON.stringify(snapshot.manifest)), payloadFingerprint, snapshotAt: snapshot.snapshotAt, ...lineage };
        await client.query(
          `INSERT INTO platform.jobs
            (id,job_key,queue_name,job_type,status,max_attempts,tenant_scope,property_id,
             resource_product,resource_type,resource_id,correlation_id,idempotency_key_hash,
             payload,job_metadata)
           VALUES($1::uuid,$2,$3,$4,'pending',3,'property',$5::uuid,'finance',
             'financials_export',$1::text,$6,$7,$8::jsonb,$9::jsonb)`,
          // prettier-ignore
          [exportId, `${FINANCE_FOLIO_EXPORT_JOB}:${input.propertyId}:${keyHash}`, FINANCE_FOLIO_EXPORT_QUEUE, FINANCE_FOLIO_EXPORT_JOB, input.propertyId, input.audit.correlationId, keyHash, JSON.stringify(payload), JSON.stringify(jobMetadata)],
        );
        await client.query(
          `INSERT INTO platform.product_audit_events
            (audit_key,product,action,occurred_at,tenant_scope,property_id,actor_type,
             actor_user_id,target_resource_product,target_resource_type,target_resource_id,
             job_id,idempotency_key_id,correlation_id,causation_id,redacted_payload,
             audit_metadata,retention_class,privacy_scope)
           VALUES($1,'finance','finance.folio_export.requested',$2::timestamptz,'property',$3::uuid,
             'user',$4::uuid,'finance','financials_export',$5::text,$5::uuid,$5::uuid,$6,$7,
             $8::jsonb,$9::jsonb,'financial','confidential')`,
          // prettier-ignore
          [`finance.financials-export:${exportId}:requested`, acceptedAt, input.propertyId, input.audit.actorUserId, exportId, input.audit.correlationId, input.audit.causationId, JSON.stringify(redacted(config.searchDigestKey, input.currency, filters, snapshot)), JSON.stringify({ organizationId: input.organizationId, requestId: input.audit.requestId, requestedAt: input.audit.requestedAt })],
        );
        return { status: "created", exportId };
      });
    },
    async close() {
      if (!config.pool) await pool.end();
    },
  };
}
// prettier-ignore
export function parseFinanceFolioExportJobPayload(value: unknown, expected: ExpectedPayload): FinanceFolioExportJobPayload {
  const row = object(value),
    snapshot = parseFinanceFolioExportSnapshot(row.snapshot);
  if (
    Object.keys(row).length !== 4 ||
    !uuid(row.commandId) ||
    !uuid(row.organizationId) ||
    !snapshot ||
    snapshot.propertyId !== expected.propertyId ||
    snapshot.currency !== expected.currency ||
    row.organizationId !== expected.organizationId ||
    !validWindow(row, snapshot, expected)
  )
    throw new TypeError("Finance folio export job payload is invalid");
  const payload = {
    commandId: row.commandId,
    organizationId: row.organizationId,
    snapshot,
    expiresAt: String(row.expiresAt),
  } satisfies FinanceFolioExportJobPayload;
  if (hash(JSON.stringify(payload)) !== expected.payloadFingerprint)
    throw new TypeError("Finance folio export job payload is invalid");
  return payload;
}

async function authorizedScope(client: PoolClient, input: Command) {
  const result = await client.query(
    `SELECT 1 FROM hotel_catalog.properties property
     JOIN identity.organizations organization ON organization.id=$1::uuid AND organization.kind='hotel_group' AND organization.status='active'
     JOIN identity.organization_memberships membership ON membership.organization_id=organization.id
       AND membership.user_id=$3::uuid AND membership.status='active'
     JOIN identity.users actor ON actor.id=membership.user_id AND actor.status='active'
     JOIN identity.organization_resource_links resource ON resource.organization_id=organization.id
       AND resource.product='pms' AND resource.resource_type='pms_property'
       AND resource.resource_id=property.id::text AND resource.relationship IN ('owner','finance_manager')
       AND resource.status='active'
     WHERE property.id=$2::uuid
     FOR KEY SHARE OF property
     FOR SHARE OF organization,membership,actor,resource`,
    [input.organizationId, input.propertyId, input.audit.actorUserId],
  );
  return (result.rowCount ?? 0) > 0;
}
// prettier-ignore
function validCommand(input: Command, filters: FinanceFolioExportFilters, snapshot: FinanceFolioExportSnapshot) {
  return (
    uuid(input.commandId) &&
    uuid(input.organizationId) &&
    uuid(input.propertyId) &&
    /^[A-Z]{3}$/.test(input.currency) &&
    trimmed(input.idempotencyKey, 8, 200) &&
    snapshot.propertyId === input.propertyId &&
    snapshot.currency === input.currency &&
    JSON.stringify(snapshot.filters) === JSON.stringify(filters) &&
    uuid(input.audit.actorUserId) &&
    trimmed(input.audit.requestId, 1, 200) &&
    trimmed(input.audit.correlationId, 1, 200) &&
    uuid(input.audit.causationId) &&
    instant(input.audit.requestedAt)
  );
}

// prettier-ignore
function validWindow(row: Record<string, unknown>, snapshot: FinanceFolioExportSnapshot, expected: ExpectedPayload) {
  const accepted = instantMillis(expected.acceptedAt),
    expires = instantMillis(expected.expiresAt),
    payloadExpires = instantMillis(row.expiresAt);
  return (
    uuid(expected.organizationId) &&
    uuid(expected.propertyId) &&
    /^[A-Z]{3}$/.test(expected.currency) &&
    /^[0-9a-f]{64}$/.test(expected.payloadFingerprint) &&
    Number.isFinite(expected.now.getTime()) &&
    snapshot.snapshotAt === expected.snapshotAt &&
    row.expiresAt === expected.expiresAt &&
    accepted !== null &&
    expires !== null &&
    payloadExpires === expires &&
    new Date(snapshot.snapshotAt).getTime() <= accepted &&
    expires - accepted === FINANCE_FOLIO_EXPORT_TTL_MS &&
    expected.now.getTime() < expires
  );
}

// prettier-ignore
function redacted(key: string, currency: string, filters: FinanceFolioExportFilters, snapshot: FinanceFolioExportSnapshot) {
  const { search, ...safe } = filters;
  return {
    currency,
    filters: {
      ...safe,
      searchPresent: Boolean(search),
      ...(search ? { searchHash: createHmac("sha256", key).update(search).digest("hex") } : {}),
    },
    formatVersion: FINANCE_FOLIO_CSV_VERSION,
    manifestCount: snapshot.manifest.length,
    manifestDigest: hash(JSON.stringify(snapshot.manifest)),
  };
}

async function transaction<T>(pool: pg.Pool, work: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const value = await work(client);
    await client.query("COMMIT");
    return value;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const uuid = (value: unknown): value is string =>
  typeof value === "string" &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value);
const instant = (value: unknown): value is string => instantMillis(value) !== null;
function instantMillis(value: unknown): number | null {
  if (typeof value !== "string") return null;
  const millis = new Date(value).getTime();
  return Number.isFinite(millis) && new Date(millis).toISOString() === value ? millis : null;
}
const trimmed = (value: unknown, min: number, max: number) =>
  typeof value === "string" && value === value.trim() && value.length >= min && value.length <= max;
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new TypeError("Finance folio export job payload is invalid");
  return value as Record<string, unknown>;
}
