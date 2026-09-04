import { createHash } from "node:crypto";

import {
  MARKETPLACE_CREATOR_MODERATION_CONTRACT_VERSION,
  canModerateMarketplaceCreatorProfile,
  isMarketplaceCreatorModerationTargetStatus,
  isMarketplaceCreatorProfileStatus,
  type MarketplaceCreatorModerationCommand,
  type MarketplaceCreatorModerationErrorCode,
  type MarketplaceCreatorModerationResponse,
  type MarketplaceCreatorModerationResult,
  type MarketplaceCreatorProfileStatus,
} from "@vayada/domain-marketplace";
import type { PoolClient, QueryResult, QueryResultRow } from "pg";

export type MarketplaceCreatorModerationPool = {
  connect(): Promise<PoolClient>;
};

type LockedProfile = {
  organizationId: string;
  profileStatus: MarketplaceCreatorProfileStatus;
  profileComplete: boolean;
};

type IdempotencyRow = {
  status: string;
  requestFingerprintHash: string;
  resultJson: unknown;
};

const OPERATION = "marketplace.creator_profile.moderate";

export async function executeMarketplaceCreatorModeration(
  pool: MarketplaceCreatorModerationPool,
  input: MarketplaceCreatorModerationCommand,
): Promise<MarketplaceCreatorModerationResult> {
  return inTransaction(pool, async (client) => {
    const profile = await lockProfile(client, input.creatorProfileId);
    if (!profile) return failure("creator_profile_not_found");
    const at = new Date().toISOString();
    const keyHash = sha256(input.idempotencyKey);
    const fingerprint = sha256(
      stableJson({ creatorProfileId: input.creatorProfileId, ...input.request }),
    );
    await client.query(`SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, [
      `${profile.organizationId}:${OPERATION}:${keyHash}`,
    ]);
    const replay = await findReplay(client, input, profile, keyHash, fingerprint);
    if (replay) return replay;

    if (profile.profileStatus !== input.request.nextStatus) {
      if (profile.profileStatus !== input.request.expectedStatus) {
        return failure("profile_status_conflict", profile.profileStatus);
      }
      if (!canModerateMarketplaceCreatorProfile(profile.profileStatus, input.request.nextStatus)) {
        return failure("invalid_profile_transition", profile.profileStatus);
      }
      if (input.request.nextStatus === "active" && !profile.profileComplete) {
        return failure("profile_incomplete", profile.profileStatus);
      }
    }

    const idempotencyId = await reserveIdempotency(
      client,
      input,
      profile.organizationId,
      keyHash,
      fingerprint,
      at,
    );
    const response: MarketplaceCreatorModerationResponse = {
      contractVersion: MARKETPLACE_CREATOR_MODERATION_CONTRACT_VERSION,
      outcome: profile.profileStatus === input.request.nextStatus ? "unchanged" : "transitioned",
      creatorProfileId: input.creatorProfileId,
      previousStatus: profile.profileStatus,
      profileStatus: input.request.nextStatus,
      reason: input.request.reason,
      moderatedByUserId: input.audit.actorUserId,
      moderatedAt: at,
    };
    if (response.outcome === "transitioned") {
      const updated = await client.query(
        `UPDATE marketplace.creator_profiles SET profile_status=$2, updated_at=$3::timestamptz
         WHERE id=$1::uuid AND profile_status=$4`,
        [input.creatorProfileId, input.request.nextStatus, at, profile.profileStatus],
      );
      if (updated.rowCount !== 1) throw new Error("Creator moderation lost its profile lock");
      await recordAudit(client, input, profile.organizationId, response, idempotencyId);
    }
    await completeIdempotency(client, idempotencyId, response);
    return { ok: true, response };
  });
}

async function lockProfile(
  client: PoolClient,
  creatorProfileId: string,
): Promise<LockedProfile | null> {
  const result = await client.query<LockedProfile>(
    `SELECT profile.organization_id::text AS "organizationId",
            profile.profile_status AS "profileStatus",
            marketplace.creator_profile_is_complete(profile.id, profile.organization_id) AS "profileComplete"
     FROM marketplace.creator_profiles profile WHERE profile.id=$1::uuid FOR UPDATE`,
    [creatorProfileId],
  );
  return result.rows[0] ?? null;
}

async function findReplay(
  client: PoolClient,
  input: MarketplaceCreatorModerationCommand,
  profile: LockedProfile,
  keyHash: string,
  fingerprint: string,
): Promise<MarketplaceCreatorModerationResult | null> {
  const result = await client.query<IdempotencyRow>(
    `SELECT status, request_fingerprint_hash AS "requestFingerprintHash",
            idempotency_metadata->'result' AS "resultJson"
     FROM platform.idempotency_keys
     WHERE operation_scope='marketplace' AND operation=$1 AND key_hash=$2
       AND tenant_scope='organization' AND organization_id=$3::uuid FOR UPDATE`,
    [OPERATION, keyHash, profile.organizationId],
  );
  const existing = result.rows[0];
  if (!existing) return null;
  if (existing.requestFingerprintHash !== fingerprint) {
    return failure("idempotency_key_conflict", profile.profileStatus);
  }
  if (existing.status !== "completed") return failure("command_in_progress", profile.profileStatus);
  const replay = parseResponse(existing.resultJson, input.creatorProfileId);
  return replay ? { ok: true, response: replay } : failure("idempotency_key_conflict");
}

async function reserveIdempotency(
  client: PoolClient,
  input: MarketplaceCreatorModerationCommand,
  organizationId: string,
  keyHash: string,
  fingerprint: string,
  at: string,
): Promise<string> {
  const result = await client.query<{ id: string }>(
    `INSERT INTO platform.idempotency_keys (
       operation_scope, operation, key_hash, request_fingerprint_hash, status,
       tenant_scope, organization_id, correlation_id, expires_at
     ) VALUES ('marketplace',$1,$2,$3,'in_progress','organization',$4::uuid,$5,
       $6::timestamptz + interval '24 hours') RETURNING id::text AS id`,
    [OPERATION, keyHash, fingerprint, organizationId, input.audit.correlationId, at],
  );
  const id = result.rows[0]?.id;
  if (!id) throw new Error("Creator moderation idempotency reservation failed");
  return id;
}

async function recordAudit(
  client: PoolClient,
  input: MarketplaceCreatorModerationCommand,
  organizationId: string,
  response: MarketplaceCreatorModerationResponse,
  idempotencyId: string,
): Promise<void> {
  await client.query(
    `INSERT INTO platform.product_audit_events (
       audit_key,product,action,occurred_at,tenant_scope,organization_id,actor_type,actor_user_id,
       target_resource_product,target_resource_type,target_resource_id,idempotency_key_id,
       correlation_id,causation_id,redacted_payload,private_payload,audit_metadata,privacy_scope
     ) VALUES ($1,'marketplace',$2,$3::timestamptz,'organization',$4::uuid,'user',$5::uuid,
       'marketplace','creator_profile',$6,$7::uuid,$8,$9,$10::jsonb,$11::jsonb,$12::jsonb,'confidential')`,
    [
      `marketplace-creator-moderation:${idempotencyId}`,
      OPERATION,
      response.moderatedAt,
      organizationId,
      response.moderatedByUserId,
      response.creatorProfileId,
      idempotencyId,
      input.audit.correlationId,
      input.audit.requestId,
      JSON.stringify({
        previousStatus: response.previousStatus,
        nextStatus: response.profileStatus,
      }),
      JSON.stringify({ reason: response.reason }),
      JSON.stringify({
        contractVersion: response.contractVersion,
        actorOrganizationId: input.audit.actorOrganizationId,
        requestedAt: input.audit.requestedAt,
      }),
    ],
  );
}

async function completeIdempotency(
  client: PoolClient,
  id: string,
  response: MarketplaceCreatorModerationResponse,
): Promise<void> {
  const result = await client.query(
    `UPDATE platform.idempotency_keys SET status='completed',response_status_code=200,
       response_body_hash=$2,response_resource_product='marketplace',
       response_resource_type='creator_profile',response_resource_id=$3,
       completed_at=$4::timestamptz,last_seen_at=$4::timestamptz,
       idempotency_metadata=jsonb_build_object('result',$5::jsonb) WHERE id=$1::uuid`,
    [
      id,
      sha256(stableJson(response)),
      response.creatorProfileId,
      response.moderatedAt,
      JSON.stringify(response),
    ],
  );
  if (result.rowCount !== 1) throw new Error("Creator moderation idempotency completion failed");
}

function parseResponse(
  value: unknown,
  creatorProfileId: string,
): MarketplaceCreatorModerationResponse | null {
  if (!isRecord(value)) return null;
  if (
    value.contractVersion !== MARKETPLACE_CREATOR_MODERATION_CONTRACT_VERSION ||
    (value.outcome !== "transitioned" && value.outcome !== "unchanged") ||
    value.creatorProfileId !== creatorProfileId ||
    !isMarketplaceCreatorProfileStatus(value.previousStatus) ||
    !isMarketplaceCreatorModerationTargetStatus(value.profileStatus) ||
    typeof value.reason !== "string" ||
    typeof value.moderatedByUserId !== "string" ||
    typeof value.moderatedAt !== "string"
  )
    return null;
  return value as MarketplaceCreatorModerationResponse;
}

async function inTransaction<T>(
  pool: MarketplaceCreatorModerationPool,
  work: (client: PoolClient) => Promise<T>,
) {
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

function failure(
  code: MarketplaceCreatorModerationErrorCode,
  currentStatus?: MarketplaceCreatorProfileStatus,
): MarketplaceCreatorModerationResult {
  return { ok: false, error: { code, ...(currentStatus ? { currentStatus } : {}) } };
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function stableJson(value: unknown): string {
  if (!isRecord(value)) return JSON.stringify(value);
  return JSON.stringify(value, Object.keys(value).sort());
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
