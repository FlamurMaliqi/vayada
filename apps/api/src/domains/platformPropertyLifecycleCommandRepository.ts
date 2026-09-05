import { createHash } from "node:crypto";

import {
  PLATFORM_PROPERTY_LIFECYCLE_CONTRACT_VERSION,
  canTransitionPlatformProperty,
  type PlatformPropertyLifecycleResult,
  type PlatformPropertyLifecycleStatus,
  type PlatformPropertyRetirementImpact,
} from "@vayada/domain-hotels";
import pg, { type QueryResult, type QueryResultRow } from "pg";

import { readPlatformPropertyRetirementImpact } from "./platformPropertyLifecycleImpactRepository.js";

export type PlatformPropertyLifecycleAudit = {
  actorUserId: string;
  organizationId: string;
  requestId: string;
  correlationId: string;
  requestedAt: string;
};

export type PlatformPropertyLifecycleCommandRepository = {
  changeStatus(input: {
    propertyId: string;
    expectedLifecycleRevision: number;
    status: Exclude<PlatformPropertyLifecycleStatus, "provisioning" | "retired">;
    reason: string;
    idempotencyKey: string;
    audit: PlatformPropertyLifecycleAudit;
  }): Promise<PlatformPropertyLifecycleResult>;
  retire(input: {
    propertyId: string;
    expectedLifecycleRevision: number;
    reason: string;
    idempotencyKey: string;
    audit: PlatformPropertyLifecycleAudit;
  }): Promise<PlatformPropertyLifecycleResult>;
  close(): Promise<void>;
};

export type PlatformPropertyLifecycleErrorCode =
  | "property_not_found"
  | "invalid_platform_scope"
  | "lifecycle_revision_conflict"
  | "invalid_lifecycle_transition"
  | "profile_incomplete"
  | "retirement_blocked"
  | "idempotency_key_conflict"
  | "command_in_progress";

export class PlatformPropertyLifecycleError extends Error {
  constructor(
    readonly code: PlatformPropertyLifecycleErrorCode,
    readonly currentLifecycleRevision?: number,
    readonly impact?: PlatformPropertyRetirementImpact,
  ) {
    super(code);
  }
}

type CommandClient = {
  query<T extends QueryResultRow = QueryResultRow>(
    text: string,
    values?: readonly unknown[],
  ): Promise<Pick<QueryResult<T>, "rows" | "rowCount">>;
  release(): void;
};

type CommandPool = { connect(): Promise<CommandClient>; end(): Promise<void> };
type LockedProperty = {
  lifecycleStatus: PlatformPropertyLifecycleStatus;
  lifecycleRevision: number | string;
  profileStatus: string;
  preHoldProfileStatus: string | null;
  completenessReasons: string[];
};
type IdempotencyRow = {
  id: string;
  status: string;
  requestFingerprintHash: string;
  resultJson: unknown;
};

export function createPgPlatformPropertyLifecycleCommandRepository(config: {
  connectionString?: string;
  pool?: CommandPool;
  now?: () => Date;
}): PlatformPropertyLifecycleCommandRepository {
  if (!config.pool && !config.connectionString?.trim()) {
    throw new Error("Platform property lifecycle connectionString must not be empty");
  }
  const ownsPool = !config.pool;
  const pool = config.pool ?? new pg.Pool({ connectionString: config.connectionString });
  const now = config.now ?? (() => new Date());
  return {
    changeStatus: (input) => runStatusCommand(pool, input, now()),
    retire: (input) => runRetirementCommand(pool, input, now()),
    async close() {
      if (ownsPool) await pool.end();
    },
  };
}

async function runStatusCommand(
  pool: CommandPool,
  input: Parameters<PlatformPropertyLifecycleCommandRepository["changeStatus"]>[0],
  at: Date,
): Promise<PlatformPropertyLifecycleResult> {
  return inTransaction(pool, async (client) => {
    await requireAuthorizedPlatformActor(client, input.audit);
    if (input.status === "suspended") {
      await lockBookingPublication(client, input.propertyId);
    }
    const current = await lockProperty(client, input.propertyId);
    if (!current) throw new PlatformPropertyLifecycleError("property_not_found");
    const operation = "platform.property.lifecycle.status";
    const fingerprint = sha256(
      JSON.stringify({
        propertyId: input.propertyId,
        expectedLifecycleRevision: input.expectedLifecycleRevision,
        status: input.status,
        reason: input.reason,
      }),
    );
    const replay = await findReplay(client, operation, input, fingerprint);
    if (replay) return replay;
    validateRevision(current, input.expectedLifecycleRevision);
    if (!canTransitionPlatformProperty(current.lifecycleStatus, input.status)) {
      throw new PlatformPropertyLifecycleError("invalid_lifecycle_transition");
    }
    if (input.status === "active" && current.completenessReasons.length > 0) {
      throw new PlatformPropertyLifecycleError("profile_incomplete");
    }
    const reservationId = await reserveIdempotency(client, operation, input, fingerprint, at);
    const result = await updateLifecycle(client, input, at);
    if (input.status === "suspended") await removePublicExposure(client, input, at);
    await recordAudit(client, operation, input, result, reservationId, at);
    await completeIdempotency(client, reservationId, result, at);
    return result;
  });
}

async function runRetirementCommand(
  pool: CommandPool,
  input: Parameters<PlatformPropertyLifecycleCommandRepository["retire"]>[0],
  at: Date,
): Promise<PlatformPropertyLifecycleResult> {
  return inTransaction(pool, async (client) => {
    await requireAuthorizedPlatformActor(client, input.audit);
    await lockBookingPublication(client, input.propertyId);
    const impact = await readPlatformPropertyRetirementImpact(client, input.propertyId, true);
    if (!impact) throw new PlatformPropertyLifecycleError("property_not_found");
    const operation = "platform.property.lifecycle.retire";
    const fingerprint = sha256(
      JSON.stringify({
        propertyId: input.propertyId,
        expectedLifecycleRevision: input.expectedLifecycleRevision,
        reason: input.reason,
      }),
    );
    const replay = await findReplay(client, operation, input, fingerprint);
    if (replay) return replay;
    if (impact.lifecycleRevision !== input.expectedLifecycleRevision) {
      throw new PlatformPropertyLifecycleError(
        "lifecycle_revision_conflict",
        impact.lifecycleRevision,
      );
    }
    if (!canTransitionPlatformProperty(impact.lifecycleStatus, "retired")) {
      throw new PlatformPropertyLifecycleError("invalid_lifecycle_transition");
    }
    if (impact.blockers.length > 0) {
      throw new PlatformPropertyLifecycleError("retirement_blocked", undefined, impact);
    }
    const reservationId = await reserveIdempotency(client, operation, input, fingerprint, at);
    const result = await retireProperty(client, input, at);
    await removePublicExposure(client, input, at);
    await recordAudit(client, operation, input, result, reservationId, at);
    await completeIdempotency(client, reservationId, result, at);
    return result;
  });
}

async function lockBookingPublication(client: CommandClient, propertyId: string): Promise<void> {
  await client.query(
    `SELECT pg_advisory_xact_lock(
       hashtext('booking.publication'),
       hashtext($1::uuid::text)
     )`,
    [propertyId],
  );
}

export async function requireAuthorizedPlatformActor(
  client: CommandClient,
  audit: PlatformPropertyLifecycleAudit,
): Promise<void> {
  const result = await client.query(
    `SELECT membership.id
     FROM identity.organizations organization
     JOIN identity.organization_memberships membership
       ON membership.organization_id = organization.id AND membership.status = 'active'
     JOIN identity.users actor ON actor.id = membership.user_id AND actor.status = 'active'
     JOIN identity.role_permission_grants grant_row
       ON grant_row.organization_kind = 'platform'
      AND grant_row.role_key = membership.role_key
      AND grant_row.permission_key = 'platform.property.status.manage'
     JOIN identity.organization_resource_links resource
       ON resource.organization_id = organization.id
      AND resource.product = 'platform' AND resource.resource_type = 'platform'
      AND resource.resource_id = 'vayada' AND resource.relationship = 'operator'
      AND resource.status = 'active'
     WHERE organization.id = $1::uuid AND organization.kind = 'platform'
       AND organization.status = 'active' AND actor.id = $2::uuid
     FOR SHARE OF organization, membership, actor, resource`,
    [audit.organizationId, audit.actorUserId],
  );
  if (result.rows.length !== 1) {
    throw new PlatformPropertyLifecycleError("invalid_platform_scope");
  }
}

async function lockProperty(
  client: CommandClient,
  propertyId: string,
): Promise<LockedProperty | null> {
  const result = await client.query<LockedProperty>(
    `SELECT lifecycle_status AS "lifecycleStatus",
            lifecycle_revision AS "lifecycleRevision",
            profile_status AS "profileStatus",
            pre_hold_profile_status AS "preHoldProfileStatus",
            completeness_reasons AS "completenessReasons"
     FROM hotel_catalog.properties WHERE id = $1::uuid FOR UPDATE`,
    [propertyId],
  );
  return result.rows[0] ?? null;
}

function validateRevision(current: LockedProperty, expected: number): void {
  const revision = Number(current.lifecycleRevision);
  if (revision !== expected) {
    throw new PlatformPropertyLifecycleError("lifecycle_revision_conflict", revision);
  }
}

async function updateLifecycle(
  client: CommandClient,
  input: Parameters<PlatformPropertyLifecycleCommandRepository["changeStatus"]>[0],
  at: Date,
): Promise<PlatformPropertyLifecycleResult> {
  const result = await client.query<{ lifecycleRevision: number | string }>(
    `UPDATE hotel_catalog.properties SET
       lifecycle_status = $2,
       lifecycle_revision = lifecycle_revision + 1,
       profile_status = CASE WHEN $2 = 'active' THEN 'complete' ELSE 'disabled' END,
       pre_hold_profile_status = CASE
         WHEN $2 = 'active' THEN NULL
         ELSE COALESCE(pre_hold_profile_status, profile_status)
       END,
       retired_at = NULL, retired_by_user_id = NULL, updated_at = $3::timestamptz
     WHERE id = $1::uuid
     RETURNING lifecycle_revision AS "lifecycleRevision"`,
    [input.propertyId, input.status, at.toISOString()],
  );
  return lifecycleResult(input.propertyId, input.status, result.rows[0]?.lifecycleRevision);
}

async function retireProperty(
  client: CommandClient,
  input: Parameters<PlatformPropertyLifecycleCommandRepository["retire"]>[0],
  at: Date,
): Promise<PlatformPropertyLifecycleResult> {
  const result = await client.query<{ lifecycleRevision: number | string }>(
    `UPDATE hotel_catalog.properties SET lifecycle_status = 'retired',
       lifecycle_revision = lifecycle_revision + 1,
       pre_hold_profile_status = COALESCE(pre_hold_profile_status, profile_status),
       profile_status = 'disabled', retired_at = $2::timestamptz,
       retired_by_user_id = $3::uuid, updated_at = $2::timestamptz
     WHERE id = $1::uuid
     RETURNING lifecycle_revision AS "lifecycleRevision"`,
    [input.propertyId, at.toISOString(), input.audit.actorUserId],
  );
  return lifecycleResult(input.propertyId, "retired", result.rows[0]?.lifecycleRevision);
}

async function removePublicExposure(
  client: CommandClient,
  input: { propertyId: string; reason: string; audit: PlatformPropertyLifecycleAudit },
  at: Date,
): Promise<void> {
  await client.query(
    `UPDATE marketplace.active_hotel_submission_revisions
     SET activation_status = 'suspended', status_changed_by_user_id = $2::uuid,
         status_reason = $3, updated_at = $4::timestamptz
     WHERE property_id = $1::uuid AND activation_status = 'active'`,
    [input.propertyId, input.audit.actorUserId, input.reason, at.toISOString()],
  );
  await client.query(
    `UPDATE marketplace.marketplace_hotel_profiles
     SET marketplace_profile_status = 'suspended', updated_at = $2::timestamptz
     WHERE property_id = $1::uuid AND marketplace_profile_status <> 'archived'`,
    [input.propertyId, at.toISOString()],
  );
  await client.query(
    `UPDATE marketplace.marketplace_offer_read_model
     SET visibility_status = 'disabled', projected_at = $2::timestamptz
     WHERE property_id = $1::uuid AND visibility_status <> 'disabled'`,
    [input.propertyId, at.toISOString()],
  );
  await client.query(
    `UPDATE distribution.public_hotel_bookability_profiles
     SET profile_status = 'unavailable', freshness_status = 'unavailable',
         updated_at = $2::timestamptz
     WHERE property_id = $1::uuid`,
    [input.propertyId, at.toISOString()],
  );
  await client.query(
    "DELETE FROM distribution.active_public_booking_revision WHERE property_id = $1::uuid",
    [input.propertyId],
  );
}

async function findReplay(
  client: CommandClient,
  operation: string,
  input: { propertyId: string; idempotencyKey: string },
  fingerprint: string,
): Promise<PlatformPropertyLifecycleResult | null> {
  const result = await client.query<IdempotencyRow>(
    `SELECT id::text AS id, status,
            request_fingerprint_hash AS "requestFingerprintHash",
            idempotency_metadata->'result' AS "resultJson"
     FROM platform.idempotency_keys
     WHERE operation_scope = 'hotel_catalog' AND operation = $1
       AND key_hash = $2 AND tenant_scope = 'property'
       AND property_id = $3::uuid FOR UPDATE`,
    [operation, sha256(input.idempotencyKey), input.propertyId],
  );
  const existing = result.rows[0];
  if (!existing) return null;
  if (existing.requestFingerprintHash !== fingerprint) {
    throw new PlatformPropertyLifecycleError("idempotency_key_conflict");
  }
  if (existing.status !== "completed") {
    throw new PlatformPropertyLifecycleError("command_in_progress");
  }
  if (!isLifecycleResult(existing.resultJson, input.propertyId)) {
    throw new PlatformPropertyLifecycleError("idempotency_key_conflict");
  }
  return existing.resultJson;
}

async function reserveIdempotency(
  client: CommandClient,
  operation: string,
  input: { propertyId: string; idempotencyKey: string; audit: PlatformPropertyLifecycleAudit },
  fingerprint: string,
  at: Date,
): Promise<string> {
  const result = await client.query<{ id: string }>(
    `INSERT INTO platform.idempotency_keys (
       operation_scope, operation, key_hash, request_fingerprint_hash, status,
       tenant_scope, property_id, correlation_id, expires_at
     ) VALUES ('hotel_catalog', $1, $2, $3, 'in_progress', 'property', $4::uuid, $5,
       $6::timestamptz + interval '24 hours')
     RETURNING id::text AS id`,
    [
      operation,
      sha256(input.idempotencyKey),
      fingerprint,
      input.propertyId,
      input.audit.correlationId,
      at.toISOString(),
    ],
  );
  const id = result.rows[0]?.id;
  if (!id) throw new PlatformPropertyLifecycleError("command_in_progress");
  return id;
}

async function completeIdempotency(
  client: CommandClient,
  id: string,
  result: PlatformPropertyLifecycleResult,
  at: Date,
): Promise<void> {
  const completed = await client.query(
    `UPDATE platform.idempotency_keys SET status = 'completed', response_status_code = 200,
       response_body_hash = $2, response_resource_product = 'hotel_catalog',
       response_resource_type = 'property', response_resource_id = $3,
       completed_at = $4::timestamptz, last_seen_at = $4::timestamptz,
       idempotency_metadata = jsonb_build_object('result', $5::jsonb)
     WHERE id = $1::uuid`,
    [
      id,
      sha256(JSON.stringify(result)),
      result.propertyId,
      at.toISOString(),
      JSON.stringify(result),
    ],
  );
  if (completed.rowCount !== 1) throw new Error("Lifecycle idempotency completion failed");
}

async function recordAudit(
  client: CommandClient,
  operation: string,
  input: { propertyId: string; reason: string; audit: PlatformPropertyLifecycleAudit },
  result: PlatformPropertyLifecycleResult,
  idempotencyId: string,
  at: Date,
): Promise<void> {
  await client.query(
    `INSERT INTO platform.product_audit_events (
       audit_key, product, action, occurred_at, tenant_scope, property_id,
       actor_type, actor_user_id, target_resource_product, target_resource_type,
       target_resource_id, idempotency_key_id, correlation_id, causation_id,
       redacted_payload, private_payload, audit_metadata, privacy_scope
     ) VALUES ($1, 'hotel_catalog', $2, $3::timestamptz, 'property', $4::uuid,
       'user', $5::uuid, 'hotel_catalog', 'property', $4, $6::uuid, $7, $8,
       $9::jsonb, $10::jsonb, $11::jsonb, 'confidential')`,
    [
      `platform-property-lifecycle:${idempotencyId}`,
      operation,
      at.toISOString(),
      input.propertyId,
      input.audit.actorUserId,
      idempotencyId,
      input.audit.correlationId,
      input.audit.requestId,
      JSON.stringify({ status: result.lifecycleStatus, revision: result.lifecycleRevision }),
      JSON.stringify({ reason: input.reason }),
      JSON.stringify({
        contractVersion: PLATFORM_PROPERTY_LIFECYCLE_CONTRACT_VERSION,
        actorOrganizationId: input.audit.organizationId,
        requestedAt: input.audit.requestedAt,
      }),
    ],
  );
}

async function inTransaction<T>(pool: CommandPool, work: (client: CommandClient) => Promise<T>) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await work(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

function lifecycleResult(
  propertyId: string,
  lifecycleStatus: PlatformPropertyLifecycleStatus,
  lifecycleRevision: number | string | undefined,
): PlatformPropertyLifecycleResult {
  const revision = Number(lifecycleRevision);
  if (!Number.isSafeInteger(revision) || revision < 1)
    throw new Error("Invalid lifecycle revision");
  return {
    contractVersion: PLATFORM_PROPERTY_LIFECYCLE_CONTRACT_VERSION,
    propertyId,
    lifecycleStatus,
    lifecycleRevision: revision,
  };
}

function isLifecycleResult(
  value: unknown,
  propertyId: string,
): value is PlatformPropertyLifecycleResult {
  if (!value || typeof value !== "object") return false;
  const result = value as Partial<PlatformPropertyLifecycleResult>;
  return (
    result.contractVersion === PLATFORM_PROPERTY_LIFECYCLE_CONTRACT_VERSION &&
    result.propertyId === propertyId &&
    ["provisioning", "active", "suspended", "retired"].includes(String(result.lifecycleStatus)) &&
    Number.isSafeInteger(result.lifecycleRevision)
  );
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
