import { randomUUID } from "node:crypto";

import {
  hashSourceManifest,
  type ProductReadinessResult,
  type ReadinessProviderFailure,
  type SourceManifest,
} from "@vayada/domain-hotels";
import pg, { type QueryResult, type QueryResultRow } from "pg";

import type { BookingPublicationAttemptStatusPort } from "./bookingPublicationAttemptStatusRepository.js";
import {
  BookingPublicationActiveRevisionConflictError,
  BookingPublicationLeaseLostError,
  BookingPublicationPropertyUnavailableError,
  type DistributionBookingPublicationInput,
  type DistributionBookingPublicationProjectionPort,
} from "./distributionBookingPublicationProjection.js";

type ProjectorClient = {
  query<T extends QueryResultRow = QueryResultRow>(
    text: string,
    values?: readonly unknown[],
  ): Promise<Pick<QueryResult<T>, "rows" | "rowCount">>;
  release(): void;
};

export type BookingPublicationProjectorPool = {
  connect(): Promise<ProjectorClient>;
  end(): Promise<void>;
};

type ClaimedRow = {
  outboxEventId: string;
  operationId: string;
  propertyId: string;
  attemptsCount: number;
  maxAttempts: number;
  payload: unknown;
};

type ProjectionClaim = ClaimedRow & {
  leaseToken: string;
  workerId: string;
};

type ParsedPublication = DistributionBookingPublicationInput & {
  organizationId: string;
};

export interface BookingPublicationProjectionReadinessPort {
  getBookingReadiness(input: {
    organizationId: string;
    propertyId: string;
  }): Promise<ProductReadinessResult | ReadinessProviderFailure>;
}

export type BookingPublicationProjectionBatchResult = {
  processed: number;
  succeeded: number;
  failed: number;
  exhausted: number;
};

export interface BookingPublicationProjector {
  projectPending(input?: { propertyId?: string }): Promise<BookingPublicationProjectionBatchResult>;
  runRetryBatch(input?: {
    limit?: number;
    workerId?: string;
  }): Promise<BookingPublicationProjectionBatchResult>;
  close?(): Promise<void>;
}

const DESTINATION = "distribution.booking-publication-projector";
const EVENT_TYPE = "booking.publication.requested";
const DEFAULT_LEASE_MS = 60_000;
const DEFAULT_RETRY_MS = 30_000;
const DEFAULT_LIMIT = 25;

export function createBookingPublicationProjector(config: {
  connectionString: string;
  projection: DistributionBookingPublicationProjectionPort;
  attempts: BookingPublicationAttemptStatusPort;
  readiness: BookingPublicationProjectionReadinessPort;
  max?: number;
  pool?: BookingPublicationProjectorPool;
  now?: () => Date;
  leaseDurationMs?: number;
  retryDelayMs?: number;
}): BookingPublicationProjector {
  if (!config.connectionString.trim()) {
    throw new Error("Booking publication projector connectionString must not be empty");
  }
  const ownsPool = !config.pool;
  const pool =
    config.pool ??
    (new pg.Pool({
      connectionString: config.connectionString,
      max: config.max,
    }) as BookingPublicationProjectorPool);
  const now = config.now ?? (() => new Date());
  const leaseDurationMs = positiveInteger(config.leaseDurationMs, DEFAULT_LEASE_MS);
  const retryDelayMs = positiveInteger(config.retryDelayMs, DEFAULT_RETRY_MS);

  const processOne = async (
    propertyId: string | null,
    includeNotDue: boolean,
    workerId: string,
  ): Promise<BookingPublicationProjectionBatchResult> => {
    await recoverExpiredLeases(pool, now());
    const claim = await claimNext(pool, {
      propertyId,
      includeNotDue,
      workerId,
      claimedAt: now(),
      leaseDurationMs,
    });
    if (!claim) return emptyResult();
    const projectedAt = now();
    const reconciled = await reconcileActivatedPublication(
      pool,
      config.projection,
      config.attempts,
      claim,
      projectedAt,
      retryDelayMs,
    );
    if (reconciled) return reconciled;
    try {
      const publication = await parsePublicationInput(
        claim.payload,
        claim.outboxEventId,
        claim.leaseToken,
        claim.propertyId,
        claim.operationId,
        projectedAt,
      );
      if (!publication) {
        return await terminalFailure(
          pool,
          config.projection,
          config.attempts,
          claim,
          "projection_failed",
          projectedAt,
        );
      }
      if (!(await hasCurrentReadiness(config.readiness, publication))) {
        return await terminalFailure(
          pool,
          config.projection,
          config.attempts,
          claim,
          "source_content_changed",
          projectedAt,
        );
      }
      try {
        const active = await config.projection.projectPublication(publication);
        try {
          await config.attempts.markSucceeded({
            operationId: publication.operationId,
            propertyId: publication.propertyId,
            resultContentRevisionId: active.revisionId,
            completedAt: projectedAt,
          });
        } catch {
          await recordNonExhaustingRetry(
            pool,
            claim,
            projectedAt,
            retryDelayMs,
            "status_write_pending",
            active.revisionId,
          );
          return { processed: 1, succeeded: 0, failed: 1, exhausted: 0 };
        }
        await acknowledge(pool, claim, projectedAt, "succeeded");
        return { processed: 1, succeeded: 1, failed: 0, exhausted: 0 };
      } catch (error) {
        if (error instanceof BookingPublicationLeaseLostError) {
          return { processed: 1, succeeded: 0, failed: 1, exhausted: 0 };
        }
        if (error instanceof BookingPublicationActiveRevisionConflictError) {
          return await terminalFailure(
            pool,
            config.projection,
            config.attempts,
            claim,
            "source_content_changed",
            projectedAt,
          );
        }
        if (error instanceof BookingPublicationPropertyUnavailableError) {
          return await terminalFailure(
            pool,
            config.projection,
            config.attempts,
            claim,
            "projection_failed",
            projectedAt,
          );
        }
        throw error;
      }
    } catch {
      const recovered = await reconcileActivatedPublication(
        pool,
        config.projection,
        config.attempts,
        claim,
        projectedAt,
        retryDelayMs,
      );
      if (recovered) return recovered;
      const failure = await recordRetryableFailure(
        pool,
        config.projection,
        config.attempts,
        claim,
        projectedAt,
        retryDelayMs,
      );
      if (failure.succeeded) {
        return { processed: 1, succeeded: 1, failed: 0, exhausted: 0 };
      }
      return { processed: 1, succeeded: 0, failed: 1, exhausted: Number(failure.exhausted) };
    }
  };

  return {
    async projectPending(input = {}) {
      return processOne(input.propertyId ?? null, true, "booking-publication-sync");
    },

    async runRetryBatch(input = {}) {
      const limit = positiveInteger(input.limit, DEFAULT_LIMIT);
      const workerId = input.workerId?.trim() || "booking-publication-retry";
      const result = emptyResult();
      for (let index = 0; index < limit; index += 1) {
        const next = await processOne(null, false, workerId);
        if (next.processed === 0) break;
        result.processed += next.processed;
        result.succeeded += next.succeeded;
        result.failed += next.failed;
        result.exhausted += next.exhausted;
      }
      return result;
    },

    async close() {
      if (ownsPool) await pool.end();
    },
  };
}

async function claimNext(
  pool: BookingPublicationProjectorPool,
  input: {
    propertyId: string | null;
    includeNotDue: boolean;
    workerId: string;
    claimedAt: Date;
    leaseDurationMs: number;
  },
): Promise<ProjectionClaim | null> {
  const client = await pool.connect();
  const leaseToken = randomUUID();
  const leasedUntil = new Date(input.claimedAt.getTime() + input.leaseDurationMs);
  try {
    await client.query("BEGIN");
    const result = await client.query<ClaimedRow>(
      `WITH candidate AS (
         SELECT outbox.id
         FROM platform.outbox_events outbox
         WHERE outbox.destination = $1
           AND outbox.event_type = $2
           AND outbox.tenant_scope = 'property'
           AND ($3::uuid IS NULL OR outbox.property_id = $3::uuid)
           AND outbox.attempts_count < outbox.max_attempts
           AND outbox.status IN ('pending', 'failed')
           AND ($4::boolean OR outbox.available_at <= $5::timestamptz)
         ORDER BY outbox.priority DESC, outbox.available_at, outbox.created_at, outbox.id
         FOR UPDATE SKIP LOCKED
         LIMIT 1
       )
       UPDATE platform.outbox_events outbox
       SET status = 'leased',
           attempts_count = outbox.attempts_count + 1,
           leased_until = $6::timestamptz,
           updated_at = $5::timestamptz,
           outbox_metadata = jsonb_set(
             outbox.outbox_metadata,
             '{bookingPublicationProjection}',
             COALESCE(outbox.outbox_metadata -> 'bookingPublicationProjection', '{}'::jsonb)
               || jsonb_build_object(
                 'workerId', $7::text,
                 'leaseToken', $8::text,
                 'claimedAt', $5::text,
                 'leaseExpiresAt', $6::text
               ),
             true
           )
       FROM candidate
       WHERE outbox.id = candidate.id
       RETURNING outbox.id::text AS "outboxEventId",
                 outbox.resource_id AS "operationId",
                 outbox.property_id::text AS "propertyId",
                 outbox.attempts_count AS "attemptsCount",
                 outbox.max_attempts AS "maxAttempts",
                 outbox.payload AS payload`,
      [
        DESTINATION,
        EVENT_TYPE,
        input.propertyId,
        input.includeNotDue,
        input.claimedAt.toISOString(),
        leasedUntil.toISOString(),
        input.workerId,
        leaseToken,
      ],
    );
    await client.query("COMMIT");
    const row = result.rows[0];
    return row ? { ...row, leaseToken, workerId: input.workerId } : null;
  } catch (error) {
    await rollback(client);
    throw error;
  } finally {
    client.release();
  }
}

async function acknowledge(
  pool: BookingPublicationProjectorPool,
  claim: ProjectionClaim,
  at: Date,
  outcome: "succeeded" | "failed",
): Promise<void> {
  const client = await pool.connect();
  try {
    await acknowledgeInTransaction(client, claim, at, outcome);
  } finally {
    client.release();
  }
}

async function acknowledgeInTransaction(
  client: ProjectorClient,
  claim: ProjectionClaim,
  at: Date,
  outcome: "succeeded" | "failed",
): Promise<void> {
  const updated = await client.query(
    `UPDATE platform.outbox_events
     SET status = 'published',
         published_at = $4::timestamptz,
         leased_until = NULL,
         updated_at = $4::timestamptz,
         outbox_metadata = jsonb_set(
           outbox_metadata,
           '{bookingPublicationProjection}',
           (COALESCE(outbox_metadata -> 'bookingPublicationProjection', '{}'::jsonb)
             - 'leaseToken' - 'leaseExpiresAt')
             || jsonb_build_object('completedAt', $4::text, 'outcome', $5::text),
           true
         )
     WHERE id = $1::uuid
       AND property_id = $2::uuid
       AND status = 'leased'
       AND outbox_metadata #>> '{bookingPublicationProjection,leaseToken}' = $3`,
    [claim.outboxEventId, claim.propertyId, claim.leaseToken, at.toISOString(), outcome],
  );
  if (updated.rowCount !== 1) throw new Error("Booking publication outbox lease was lost");
}

async function terminalFailure(
  pool: BookingPublicationProjectorPool,
  projection: DistributionBookingPublicationProjectionPort,
  attempts: BookingPublicationAttemptStatusPort,
  claim: ProjectionClaim,
  failureCode: "projection_failed" | "source_content_changed",
  at: Date,
): Promise<BookingPublicationProjectionBatchResult> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const active = await projection.lockAndGetActive(client, claim.propertyId);
    if (active?.revisionId === claim.operationId) {
      await attempts.markSucceededInTransaction(client, {
        operationId: claim.operationId,
        propertyId: claim.propertyId,
        resultContentRevisionId: active.revisionId,
        completedAt: at,
      });
      await acknowledgeInTransaction(client, claim, at, "succeeded");
      await client.query("COMMIT");
      return { processed: 1, succeeded: 1, failed: 0, exhausted: 0 };
    }
    await attempts.markFailedInTransaction(client, {
      operationId: claim.operationId,
      propertyId: claim.propertyId,
      failureCode,
      completedAt: at,
    });
    await acknowledgeInTransaction(client, claim, at, "failed");
    await client.query("COMMIT");
  } catch (error) {
    await rollback(client);
    throw error;
  } finally {
    client.release();
  }
  return { processed: 1, succeeded: 0, failed: 1, exhausted: 0 };
}

async function recordRetryableFailure(
  pool: BookingPublicationProjectorPool,
  projection: DistributionBookingPublicationProjectionPort,
  attempts: BookingPublicationAttemptStatusPort,
  claim: ProjectionClaim,
  failedAt: Date,
  retryDelayMs: number,
): Promise<{ exhausted: boolean; succeeded: boolean }> {
  const client = await pool.connect();
  const retryAt = new Date(failedAt.getTime() + retryDelayMs);
  try {
    await client.query("BEGIN");
    const exhausts = claim.attemptsCount >= claim.maxAttempts;
    if (exhausts) {
      const active = await projection.lockAndGetActive(client, claim.propertyId);
      if (active?.revisionId === claim.operationId) {
        await attempts.markSucceededInTransaction(client, {
          operationId: claim.operationId,
          propertyId: claim.propertyId,
          resultContentRevisionId: active.revisionId,
          completedAt: failedAt,
        });
        await acknowledgeInTransaction(client, claim, failedAt, "succeeded");
        await client.query("COMMIT");
        return { exhausted: false, succeeded: true };
      }
    }
    const result = await client.query<{ attemptsCount: number; maxAttempts: number }>(
      `UPDATE platform.outbox_events
       SET status = 'failed',
           available_at = CASE
             WHEN attempts_count >= max_attempts THEN available_at
             ELSE $4::timestamptz
           END,
           leased_until = NULL,
           updated_at = $5::timestamptz,
           outbox_metadata = jsonb_set(
             outbox_metadata,
             '{bookingPublicationProjection}',
             (COALESCE(outbox_metadata -> 'bookingPublicationProjection', '{}'::jsonb)
               - 'leaseToken' - 'leaseExpiresAt')
               || jsonb_build_object(
                 'lastFailedAt', $5::text,
                 'failureCode', 'projection_failed',
                 'nextRetryAt', CASE WHEN attempts_count >= max_attempts THEN NULL ELSE $4::text END,
                 'exhausted', attempts_count >= max_attempts
               ),
             true
           )
       WHERE id = $1::uuid
         AND property_id = $2::uuid
         AND status = 'leased'
         AND outbox_metadata #>> '{bookingPublicationProjection,leaseToken}' = $3
       RETURNING attempts_count AS "attemptsCount", max_attempts AS "maxAttempts"`,
      [
        claim.outboxEventId,
        claim.propertyId,
        claim.leaseToken,
        retryAt.toISOString(),
        failedAt.toISOString(),
      ],
    );
    const row = result.rows[0];
    if (!row) throw new Error("Booking publication outbox lease was lost during failure handling");
    const exhausted = row.attemptsCount >= row.maxAttempts;
    if (exhausted) {
      await attempts.markFailedInTransaction(client, {
        operationId: claim.operationId,
        propertyId: claim.propertyId,
        failureCode: "projection_failed",
        completedAt: failedAt,
      });
      await insertDeadLetter(client, claim);
    }
    await client.query("COMMIT");
    return { exhausted, succeeded: false };
  } catch (error) {
    await rollback(client);
    throw error;
  } finally {
    client.release();
  }
}

async function recordNonExhaustingRetry(
  pool: BookingPublicationProjectorPool,
  claim: ProjectionClaim,
  failedAt: Date,
  retryDelayMs: number,
  failureCode: "active_state_unconfirmed" | "status_write_pending",
  activeRevisionId: string | null,
): Promise<void> {
  const client = await pool.connect();
  const retryAt = new Date(failedAt.getTime() + retryDelayMs);
  try {
    const result = await client.query(
      `UPDATE platform.outbox_events
       SET status = 'failed',
           attempts_count = LEAST(attempts_count, GREATEST(max_attempts - 1, 0)),
           available_at = $4::timestamptz,
           leased_until = NULL,
           updated_at = $5::timestamptz,
           outbox_metadata = jsonb_set(
             outbox_metadata,
             '{bookingPublicationProjection}',
             (COALESCE(outbox_metadata -> 'bookingPublicationProjection', '{}'::jsonb)
               - 'leaseToken' - 'leaseExpiresAt')
               || jsonb_build_object(
                 'lastFailedAt', $5::text,
                 'failureCode', $7::text,
                 'nextRetryAt', $4::text,
                 'operationId', $2::text,
                 'activeRevisionId', $8::text
               ),
             true
           )
       WHERE id = $1::uuid
         AND property_id = $3::uuid
         AND status = 'leased'
         AND outbox_metadata #>> '{bookingPublicationProjection,leaseToken}' = $6`,
      [
        claim.outboxEventId,
        claim.operationId,
        claim.propertyId,
        retryAt.toISOString(),
        failedAt.toISOString(),
        claim.leaseToken,
        failureCode,
        activeRevisionId,
      ],
    );
    if (result.rowCount !== 1) {
      throw new Error("Booking publication outbox lease was lost during status reconciliation");
    }
  } finally {
    client.release();
  }
}

async function reconcileActivatedPublication(
  pool: BookingPublicationProjectorPool,
  projection: DistributionBookingPublicationProjectionPort,
  attempts: BookingPublicationAttemptStatusPort,
  claim: ProjectionClaim,
  at: Date,
  retryDelayMs: number,
): Promise<BookingPublicationProjectionBatchResult | null> {
  let activeRevisionId: string | null;
  try {
    activeRevisionId = (await projection.getActive(claim.propertyId))?.revisionId ?? null;
  } catch {
    await recordNonExhaustingRetry(pool, claim, at, retryDelayMs, "active_state_unconfirmed", null);
    return { processed: 1, succeeded: 0, failed: 1, exhausted: 0 };
  }
  if (activeRevisionId !== claim.operationId) return null;
  try {
    await attempts.markSucceeded({
      operationId: claim.operationId,
      propertyId: claim.propertyId,
      resultContentRevisionId: activeRevisionId,
      completedAt: at,
    });
    await acknowledge(pool, claim, at, "succeeded");
    return { processed: 1, succeeded: 1, failed: 0, exhausted: 0 };
  } catch {
    await recordNonExhaustingRetry(
      pool,
      claim,
      at,
      retryDelayMs,
      "status_write_pending",
      activeRevisionId,
    );
    return { processed: 1, succeeded: 0, failed: 1, exhausted: 0 };
  }
}

async function recoverExpiredLeases(
  pool: BookingPublicationProjectorPool,
  recoveredAt: Date,
): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      `UPDATE platform.outbox_events
       SET status = 'failed',
           attempts_count = LEAST(attempts_count, GREATEST(max_attempts - 1, 0)),
           available_at = $3::timestamptz,
           leased_until = NULL,
           updated_at = $3::timestamptz,
           outbox_metadata = jsonb_set(
             outbox_metadata,
             '{bookingPublicationProjection}',
             (COALESCE(outbox_metadata -> 'bookingPublicationProjection', '{}'::jsonb)
               - 'leaseToken' - 'leaseExpiresAt')
               || jsonb_build_object(
                 'lastFailedAt', $3::text,
                 'failureCode', 'lease_expired_requeued',
                 'nextRetryAt', $3::text,
                 'exhausted', false
               ),
             true
           )
       WHERE destination = $1
         AND event_type = $2
         AND status = 'leased'
         AND leased_until <= $3::timestamptz
       RETURNING id`,
      [DESTINATION, EVENT_TYPE, recoveredAt.toISOString()],
    );
    await client.query("COMMIT");
  } catch (error) {
    await rollback(client);
    throw error;
  } finally {
    client.release();
  }
}

async function insertDeadLetter(client: ProjectorClient, claim: ProjectionClaim): Promise<void> {
  await client.query(
    `INSERT INTO platform.dead_letter_events (
       source_kind, outbox_event_id, tenant_scope, property_id,
       resource_product, resource_type, resource_id,
       correlation_id, idempotency_key_hash,
       reason_code, failure_summary, failure_payload
     )
     SELECT 'outbox_event', outbox.id, outbox.tenant_scope, outbox.property_id,
            outbox.resource_product, outbox.resource_type, outbox.resource_id,
            outbox.correlation_id, outbox.idempotency_key_hash,
            'max_attempts_exhausted',
            'Booking publication projection exhausted its retry budget',
            jsonb_build_object(
              'ownerPackage', 'domain-distribution',
              'destination', outbox.destination,
              'eventType', outbox.event_type,
              'attemptCount', outbox.attempts_count,
              'maxAttempts', outbox.max_attempts,
              'workerId', $2::text,
              'replayEligible', true
            )
     FROM platform.outbox_events outbox
     WHERE outbox.id = $1::uuid
       AND NOT EXISTS (
         SELECT 1 FROM platform.dead_letter_events existing
         WHERE existing.source_kind = 'outbox_event'
           AND existing.outbox_event_id = outbox.id
           AND existing.reason_code = 'max_attempts_exhausted'
           AND existing.recovery_status IN ('open', 'acknowledged')
       )`,
    [claim.outboxEventId, claim.workerId],
  );
}

async function parsePublicationInput(
  value: unknown,
  outboxEventId: string,
  outboxLeaseToken: string,
  expectedPropertyId: string,
  expectedOperationId: string,
  projectedAt: Date,
): Promise<ParsedPublication | null> {
  if (!isRecord(value) || !isRecord(value["readiness"])) return null;
  const readiness = value["readiness"];
  const manifest = readiness["sourceManifest"];
  if (
    !isUuid(value["operationId"]) ||
    value["operationId"] !== expectedOperationId ||
    !isUuid(value["organizationId"]) ||
    value["propertyId"] !== expectedPropertyId ||
    !isUuid(value["propertyId"]) ||
    !isUuid(value["requestedByUserId"]) ||
    !(
      value["expectedActiveContentRevisionId"] === null ||
      isUuid(value["expectedActiveContentRevisionId"])
    ) ||
    !Number.isSafeInteger(value["expectedPropertyLifecycleRevision"]) ||
    Number(value["expectedPropertyLifecycleRevision"]) < 1 ||
    readiness["contractVersion"] !== "onboarding-product-readiness.v1" ||
    readiness["product"] !== "booking" ||
    readiness["status"] !== "ready" ||
    !isRecord(manifest) ||
    manifest["contractVersion"] !== "onboarding-source-manifest.v1" ||
    manifest["propertyId"] !== expectedPropertyId ||
    !Array.isArray(manifest["sources"]) ||
    !isHash(readiness["sourceManifestHash"]) ||
    !isHash(readiness["readinessHash"])
  ) {
    return null;
  }
  try {
    if (
      (await hashSourceManifest(manifest as SourceManifest)) !== readiness["sourceManifestHash"]
    ) {
      return null;
    }
  } catch {
    return null;
  }
  return {
    operationId: value["operationId"],
    outboxEventId,
    outboxLeaseToken,
    organizationId: value["organizationId"],
    propertyId: value["propertyId"],
    expectedActiveRevisionId: value["expectedActiveContentRevisionId"],
    expectedPropertyLifecycleRevision: Number(value["expectedPropertyLifecycleRevision"]),
    requestedByUserId: value["requestedByUserId"],
    readiness: {
      contractVersion: "onboarding-product-readiness.v1",
      product: "booking",
      status: "ready",
      sourceManifest: structuredClone(
        manifest,
      ) as DistributionBookingPublicationInput["readiness"]["sourceManifest"],
      sourceManifestHash: readiness["sourceManifestHash"],
      readinessHash: readiness["readinessHash"],
    },
    projectedAt,
  };
}

async function hasCurrentReadiness(
  readiness: BookingPublicationProjectionReadinessPort,
  publication: ParsedPublication,
): Promise<boolean> {
  const current = await readiness.getBookingReadiness({
    organizationId: publication.organizationId,
    propertyId: publication.propertyId,
  });
  return (
    current.outcome === "evaluated" &&
    current.product === "booking" &&
    current.status === "ready" &&
    current.propertyId === publication.propertyId &&
    current.sourceManifestHash === publication.readiness.sourceManifestHash &&
    current.readinessHash === publication.readiness.readinessHash
  );
}

function positiveInteger(value: number | undefined, fallback: number): number {
  const resolved = value ?? fallback;
  if (!Number.isInteger(resolved) || resolved <= 0) {
    throw new Error("Booking publication projector limits must be positive integers");
  }
  return resolved;
}

function emptyResult(): BookingPublicationProjectionBatchResult {
  return { processed: 0, succeeded: 0, failed: 0, exhausted: 0 };
}

function isHash(value: unknown): value is string {
  return typeof value === "string" && /^sha256:[0-9a-f]{64}$/.test(value);
}

function isUuid(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function rollback(client: ProjectorClient): Promise<void> {
  try {
    await client.query("ROLLBACK");
  } catch {
    // Preserve the original failure.
  }
}
