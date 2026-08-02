import type { PlatformMediaServingConfig } from "../platform/mediaServing.js";
import {
  PROPERTY_MEDIA_PUBLICATION_JOB_TYPE as PUBLICATION_JOB_TYPE,
  PROPERTY_MEDIA_PUBLICATION_QUEUE as PUBLICATION_QUEUE,
} from "../platform/propertyMediaPublicationJob.js";
import type { PropertyMediaVariantPublisher } from "../platform/propertyMediaVariantPublisher.js";
import {
  DEFAULT_PUBLICATION_BATCH_LIMIT,
  PUBLICATION_COPY_CONCURRENCY,
  PUBLICATION_JOB_LEASE_MS,
  PUBLICATION_JOB_RETRY_MS,
  PUBLICATION_TERMINAL_RECONCILIATION_MS,
  PUBLICATION_TERMINAL_RECONCILIATION_PASSES,
  boundedPositiveInteger,
  parsePublicationCleanupKeys,
  publicationCleanupKeys,
  type PropertyMediaPublicationBatchResult,
  type ReadyMedia,
} from "./propertyMediaCommandEnvelope.js";
import {
  claimPublicationJob,
  deferPublicationJob,
  finalizeInvalidPublicationJob,
  finalizePublication,
  finalizePublicationFailure,
  publicationCompleted,
  publicationFailedTerminally,
  renewPublicationLease,
  validatePublicationForCopy,
  type CommandPool,
  type PropertyMediaReadModelSync,
} from "./propertyMediaCommandStore.js";

export function createPropertyMediaPublicationWorker(config: {
  pool: CommandPool;
  publisher: PropertyMediaVariantPublisher;
  serving: PlatformMediaServingConfig;
  now: () => Date;
  randomId: () => string;
  syncReadModels: PropertyMediaReadModelSync;
}) {
  const { pool, publisher, now, randomId, syncReadModels } = config;

  async function processPublicationJob(
    jobId?: string,
    force = false,
  ): Promise<"processed" | "deferred" | "dead_lettered" | "not_claimed"> {
    const claimed = await claimPublicationJob(pool, {
      jobId,
      force,
      workerId: `property-media:${process.pid}:${randomId()}`,
      now: now(),
    });
    if (!claimed) return "not_claimed";
    if ("invalidPublication" in claimed) {
      const cleanupFailures = await cleanupPublicationKeys(
        publisher,
        claimed.invalidPublication.cleanupKeys,
      );
      const finalized = await finalizeInvalidPublicationJob(
        pool,
        claimed.invalidPublication,
        now(),
        syncReadModels,
        cleanupFailures,
      );
      return finalized ? "dead_lettered" : "not_claimed";
    }
    const claim = claimed.publicationClaim;
    if (claim.cleanupRequired || claim.exhaustedBeforeClaim) {
      let cleanupFailures: number;
      try {
        cleanupFailures = await cleanupPublicationVariants(publisher, claim.payload.media, () =>
          renewPublicationLease(pool, claim, now()),
        );
      } catch {
        if (await publicationCompleted(pool, claim)) return "processed";
        if (await publicationFailedTerminally(pool, claim)) {
          await cleanupPublicationVariants(publisher, claim.payload.media);
        }
        return "not_claimed";
      }
      if (cleanupFailures > 0) {
        await deferPublicationJob(
          pool,
          claim,
          now(),
          `${cleanupFailures} public object cleanup operation(s) failed`,
          { finishAttempt: false, cleanupRequired: true },
        );
        return "deferred";
      }
      if (claim.exhaustedBeforeClaim) {
        await finalizePublicationFailure(
          pool,
          claim,
          now(),
          "Publication attempts exhausted after public object cleanup",
          syncReadModels,
          { attemptAlreadyFinished: true },
        );
        return "dead_lettered";
      }
      await deferPublicationJob(
        pool,
        claim,
        now(),
        "Public object cleanup completed; publication retry scheduled",
        { finishAttempt: false, cleanupRequired: false },
      );
      return "deferred";
    }
    let copyStarted = false;
    try {
      await validatePublicationForCopy(pool, claim, config.serving);
      copyStarted = true;
      await copyPublicationVariants(publisher, claim.payload.media, () =>
        renewPublicationLease(pool, claim, now()),
      );
      await finalizePublication(pool, claim, {
        serving: config.serving,
        now: now(),
        syncReadModels,
      });
      return "processed";
    } catch (error) {
      if (await publicationCompleted(pool, claim)) return "processed";
      let cleanupFailures = 0;
      if (copyStarted) {
        try {
          cleanupFailures = await cleanupPublicationVariants(publisher, claim.payload.media, () =>
            renewPublicationLease(pool, claim, now()),
          );
        } catch {
          if (await publicationCompleted(pool, claim)) return "processed";
          if (await publicationFailedTerminally(pool, claim)) {
            await cleanupPublicationVariants(publisher, claim.payload.media);
          }
          return "not_claimed";
        }
      }
      const baseMessage =
        error instanceof Error ? error.message : "Property media publication failed";
      const message =
        cleanupFailures > 0
          ? `${baseMessage}; ${cleanupFailures} public object cleanup operation(s) failed`
          : baseMessage;
      if (cleanupFailures > 0) {
        await deferPublicationJob(pool, claim, now(), message, {
          finishAttempt: true,
          cleanupRequired: true,
        });
        return "deferred";
      }
      if (claim.attemptsCount >= claim.maxAttempts) {
        await finalizePublicationFailure(pool, claim, now(), message, syncReadModels);
        return "dead_lettered";
      }
      await deferPublicationJob(pool, claim, now(), message, {
        finishAttempt: true,
        cleanupRequired: false,
      });
      return "deferred";
    }
  }

  return {
    processPublicationJob,
    async runPublicationBatch(options: { limit?: number } = {}) {
      const limit = boundedPositiveInteger(options.limit, DEFAULT_PUBLICATION_BATCH_LIMIT, 100);
      const result: PropertyMediaPublicationBatchResult = {
        processed: 0,
        deferred: 0,
        deadLettered: 0,
      };
      for (let index = 0; index < limit; index += 1) {
        const outcome = await processPublicationJob(undefined, false);
        if (outcome === "not_claimed") break;
        if (outcome === "processed") result.processed += 1;
        if (outcome === "deferred") result.deferred += 1;
        if (outcome === "dead_lettered") result.deadLettered += 1;
      }
      await reconcileTerminalPublicationCleanup(pool, publisher, {
        workerId: `property-media-cleanup:${process.pid}:${randomId()}`,
        now: now(),
      });
      return result;
    },
  };
}

async function copyPublicationVariants(
  publisher: PropertyMediaVariantPublisher,
  media: readonly ReadyMedia[],
  renewLease: () => Promise<void>,
): Promise<void> {
  const variants = media.flatMap(({ promotion }) => [...promotion]);
  for (let index = 0; index < variants.length; index += PUBLICATION_COPY_CONCURRENCY) {
    const results = await Promise.allSettled(
      variants
        .slice(index, index + PUBLICATION_COPY_CONCURRENCY)
        .map((variant) => publisher.copyToPublic(variant)),
    );
    const failed = results.find((result) => result.status === "rejected");
    if (failed?.status === "rejected") throw failed.reason;
    await renewLease();
  }
}

async function cleanupPublicationVariants(
  publisher: PropertyMediaVariantPublisher,
  media: readonly ReadyMedia[],
  renewLease?: () => Promise<void>,
): Promise<number> {
  return cleanupPublicationKeys(publisher, publicationCleanupKeys(media), renewLease);
}

async function cleanupPublicationKeys(
  publisher: PropertyMediaVariantPublisher,
  keys: readonly string[],
  renewLease?: () => Promise<void>,
): Promise<number> {
  let failed = 0;
  await renewLease?.();
  for (let index = 0; index < keys.length; index += PUBLICATION_COPY_CONCURRENCY) {
    const results = await Promise.allSettled(
      keys
        .slice(index, index + PUBLICATION_COPY_CONCURRENCY)
        .map((publicStorageKey) => publisher.deletePublic({ publicStorageKey })),
    );
    failed += results.filter((result) => result.status === "rejected").length;
    await renewLease?.();
  }
  return failed;
}

async function reconcileTerminalPublicationCleanup(
  pool: CommandPool,
  publisher: PropertyMediaVariantPublisher,
  input: { workerId: string; now: Date },
): Promise<boolean> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await client.query<{
      id: string;
      cleanupKeys: unknown;
      cleanupPassesRemaining: unknown;
    }>(
      `SELECT job.id::text AS id,
              job.job_metadata -> 'cleanupKeys' AS "cleanupKeys",
              job.job_metadata -> 'cleanupPassesRemaining' AS "cleanupPassesRemaining"
       FROM platform.jobs job
       WHERE job.queue_name = $1
         AND job.job_type = $2
         AND job.status = 'dead_lettered'
         AND job.job_metadata @> '{"cleanupRequired": true}'::jsonb
         AND job.run_after <= $3::timestamptz
       ORDER BY job.run_after, job.updated_at, job.id
       FOR UPDATE SKIP LOCKED
       LIMIT 1`,
      [PUBLICATION_QUEUE, PUBLICATION_JOB_TYPE, input.now.toISOString()],
    );
    const row = result.rows[0];
    if (!row) {
      await client.query("ROLLBACK");
      return false;
    }
    const cleanupKeys = parsePublicationCleanupKeys(row.cleanupKeys);
    const cleanupPassesRemaining =
      typeof row.cleanupPassesRemaining === "number" &&
      Number.isSafeInteger(row.cleanupPassesRemaining) &&
      row.cleanupPassesRemaining >= 1 &&
      row.cleanupPassesRemaining <= PUBLICATION_TERMINAL_RECONCILIATION_PASSES
        ? row.cleanupPassesRemaining
        : null;
    if (!cleanupKeys || cleanupPassesRemaining === null) {
      await client.query(
        `UPDATE platform.jobs
         SET run_after = $2::timestamptz,
             updated_at = $1::timestamptz,
             job_metadata = job_metadata || jsonb_build_object(
               'cleanupLastError', 'Invalid property media cleanup envelope'
             )
         WHERE id = $3::uuid
           AND status = 'dead_lettered'`,
        [
          input.now.toISOString(),
          new Date(input.now.getTime() + PUBLICATION_JOB_RETRY_MS).toISOString(),
          row.id,
        ],
      );
      await client.query("COMMIT");
      return false;
    }
    const claimedUntil = new Date(input.now.getTime() + PUBLICATION_JOB_LEASE_MS);
    const claimed = await client.query(
      `UPDATE platform.jobs
       SET locked_at = $3::timestamptz,
           locked_by = $2,
           run_after = $4::timestamptz,
           updated_at = $3::timestamptz
       WHERE id = $1::uuid
         AND status = 'dead_lettered'`,
      [row.id, input.workerId, input.now.toISOString(), claimedUntil.toISOString()],
    );
    if (claimed.rowCount !== 1) {
      await client.query("ROLLBACK");
      return false;
    }
    await client.query("COMMIT");

    const cleanupFailures = await cleanupPublicationKeys(publisher, cleanupKeys);
    await client.query("BEGIN");
    const nextPassesRemaining =
      cleanupFailures > 0 ? cleanupPassesRemaining : cleanupPassesRemaining - 1;
    const cleanupRequired = cleanupFailures > 0 || nextPassesRemaining > 0;
    const retryAt = new Date(
      input.now.getTime() +
        (cleanupFailures > 0 ? PUBLICATION_JOB_RETRY_MS : PUBLICATION_TERMINAL_RECONCILIATION_MS),
    );
    const completed = await client.query(
      `UPDATE platform.jobs
       SET locked_at = NULL,
           locked_by = NULL,
           run_after = $4::timestamptz,
           updated_at = $3::timestamptz,
           job_metadata = job_metadata || jsonb_build_object(
             'cleanupRequired', $5::boolean,
             'cleanupPassesRemaining', $7::integer,
             'cleanupReconciledAt', CASE WHEN $5::boolean THEN NULL ELSE $3::text END,
             'cleanupLastError', CASE
               WHEN $5::boolean THEN $6::text
               ELSE NULL
             END
           )
       WHERE id = $1::uuid
         AND status = 'dead_lettered'
         AND locked_by = $2`,
      [
        row.id,
        input.workerId,
        input.now.toISOString(),
        retryAt.toISOString(),
        cleanupRequired,
        `${cleanupFailures} public object cleanup operation(s) failed`,
        nextPassesRemaining,
      ],
    );
    if (completed.rowCount !== 1) {
      throw new Error("Property media terminal cleanup lease was lost");
    }
    await client.query("COMMIT");
    return !cleanupRequired;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
