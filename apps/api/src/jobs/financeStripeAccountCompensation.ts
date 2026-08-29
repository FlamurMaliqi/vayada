import type {
  FinanceProviderAccountOwner,
  FinanceStripeConnectProvider,
} from "@vayada/domain-finance";
import pg, { type QueryResult, type QueryResultRow } from "pg";

import {
  claimStripeProviderAccountCompensation,
  completeStripeProviderAccountCompensation,
  lockStripeProviderAccountReference,
  stripeProviderAccountReferenceIsDurable,
} from "../domains/financeStripeProviderAccountReferenceLock.js";

export const FINANCE_STRIPE_ACCOUNT_COMPENSATION_QUEUE = "finance-provider-compensation";
export const FINANCE_STRIPE_ACCOUNT_COMPENSATION_JOB_TYPE = "finance.compensate-stripe-account";
const STRIPE_COMPENSATION_TIMEOUT_MS = 10_000;

type Client = {
  query<T extends QueryResultRow = QueryResultRow>(
    text: string,
    values?: readonly unknown[],
  ): Promise<Pick<QueryResult<T>, "rows" | "rowCount">>;
  release(): void;
};

type Pool = {
  query<T extends QueryResultRow = QueryResultRow>(
    text: string,
    values?: readonly unknown[],
  ): Promise<Pick<QueryResult<T>, "rows" | "rowCount">>;
  connect(): Promise<Client>;
  end?(): Promise<void>;
};

type JobRow = {
  id: string;
  attemptsCount: number;
  maxAttempts: number;
  payload: unknown;
};

type CompensationPayload = {
  owner: FinanceProviderAccountOwner;
  providerAccountRef: string;
  idempotencyKey: string;
};

export async function runFinanceStripeAccountCompensationJobs(
  connectionString: string,
  provider: Pick<FinanceStripeConnectProvider, "compensateAccountCreation">,
  options: { workerId?: string; limit?: number; pool?: Pool } = {},
): Promise<{ succeeded: number; retryScheduled: number; failed: number }> {
  if (!provider.compensateAccountCreation) {
    throw new Error("Stripe account compensation is not configured");
  }
  const ownsPool = !options.pool;
  const pool = options.pool ?? new pg.Pool({ connectionString, max: 2 });
  let succeeded = 0;
  let retryScheduled = 0;
  let failed = 0;
  try {
    await failExpiredExhaustedLeases(pool);
    for (let index = 0; index < (options.limit ?? 10); index += 1) {
      const job = await claim(
        pool,
        options.workerId ?? `finance-stripe-compensation:${process.pid}`,
      );
      if (!job) break;
      try {
        const payload = parsePayload(job.payload);
        await compensateClaimedJob(pool, provider.compensateAccountCreation, job.id, payload);
        succeeded += 1;
      } catch {
        const terminal = job.attemptsCount >= job.maxAttempts;
        await fail(pool, job.id, terminal);
        if (terminal) failed += 1;
        else retryScheduled += 1;
      }
    }
    return { succeeded, retryScheduled, failed };
  } finally {
    if (ownsPool) await pool.end?.();
  }
}

async function compensateClaimedJob(
  pool: Pool,
  compensateAccountCreation: NonNullable<FinanceStripeConnectProvider["compensateAccountCreation"]>,
  jobId: string,
  payload: CompensationPayload,
): Promise<void> {
  let claimedOutcome: string | null = null;
  const claimClient = await pool.connect();
  try {
    await claimClient.query("BEGIN");
    await lockStripeProviderAccountReference(claimClient, payload.providerAccountRef);
    if (await stripeProviderAccountReferenceIsDurable(claimClient, payload.providerAccountRef)) {
      claimedOutcome = "provider_account_durably_owned";
    } else {
      const claimStatus = await claimStripeProviderAccountCompensation(
        claimClient,
        payload.providerAccountRef,
      );
      if (claimStatus === "completed") {
        claimedOutcome = "provider_account_already_compensated";
      }
    }
    await claimClient.query("COMMIT");
  } catch (error) {
    await claimClient.query("ROLLBACK");
    throw error;
  } finally {
    claimClient.release();
  }

  if (claimedOutcome) {
    await finish(pool, jobId, claimedOutcome);
    return;
  }

  await compensateAccountCreation({
    owner: payload.owner,
    providerAccountRef: payload.providerAccountRef,
    reason: "db_write_failed",
    idempotencyKey: payload.idempotencyKey,
    signal: AbortSignal.timeout(STRIPE_COMPENSATION_TIMEOUT_MS),
  });

  const completionClient = await pool.connect();
  let completionOutcome: string;
  try {
    await completionClient.query("BEGIN");
    await lockStripeProviderAccountReference(completionClient, payload.providerAccountRef);
    if (
      await stripeProviderAccountReferenceIsDurable(completionClient, payload.providerAccountRef)
    ) {
      completionOutcome = "provider_account_durably_owned_after_claim";
    } else {
      await completeStripeProviderAccountCompensation(completionClient, payload.providerAccountRef);
      completionOutcome = "provider_account_compensated";
    }
    await completionClient.query("COMMIT");
  } catch (error) {
    await completionClient.query("ROLLBACK");
    throw error;
  } finally {
    completionClient.release();
  }

  await finish(pool, jobId, completionOutcome);
}

async function claim(pool: Pool, workerId: string): Promise<JobRow | null> {
  const result = await pool.query<JobRow>(
    `UPDATE platform.jobs job
     SET status = 'running',
         attempts_count = job.attempts_count + 1,
         locked_at = now(),
         locked_by = $1,
         updated_at = now()
     FROM (
       SELECT id FROM platform.jobs
       WHERE queue_name = $2
         AND job_type = $3
         AND (
           (status = 'pending' AND run_after <= now())
           OR (status = 'running' AND locked_at < now() - interval '5 minutes')
         )
         AND attempts_count < max_attempts
       ORDER BY priority DESC, run_after, created_at, id
       FOR UPDATE SKIP LOCKED
       LIMIT 1
     ) candidate
     WHERE job.id = candidate.id
     RETURNING job.id::text AS id,
               job.attempts_count::int AS "attemptsCount",
               job.max_attempts::int AS "maxAttempts",
               job.payload`,
    [
      workerId,
      FINANCE_STRIPE_ACCOUNT_COMPENSATION_QUEUE,
      FINANCE_STRIPE_ACCOUNT_COMPENSATION_JOB_TYPE,
    ],
  );
  return result.rows[0] ?? null;
}

async function failExpiredExhaustedLeases(pool: Pool): Promise<void> {
  await pool.query(
    `UPDATE platform.jobs
     SET status = 'failed', finished_at = now(), locked_at = NULL, locked_by = NULL,
         updated_at = now(),
         job_metadata = job_metadata || '{"outcomeCode":"provider_compensation_lease_exhausted"}'::jsonb
     WHERE queue_name = $1
       AND job_type = $2
       AND status = 'running'
       AND locked_at < now() - interval '5 minutes'
       AND attempts_count >= max_attempts`,
    [FINANCE_STRIPE_ACCOUNT_COMPENSATION_QUEUE, FINANCE_STRIPE_ACCOUNT_COMPENSATION_JOB_TYPE],
  );
}

async function finish(
  client: Pick<Client, "query">,
  jobId: string,
  outcomeCode: string,
): Promise<void> {
  await client.query(
    `UPDATE platform.jobs
     SET status = 'succeeded', finished_at = now(), locked_at = NULL, locked_by = NULL,
         updated_at = now(),
         job_metadata = job_metadata || jsonb_build_object('outcomeCode', $2::text)
     WHERE id = $1::uuid AND status = 'running'`,
    [jobId, outcomeCode],
  );
}

async function fail(pool: Pool, jobId: string, terminal: boolean): Promise<void> {
  await pool.query(
    `UPDATE platform.jobs
     SET status = CASE WHEN $2 THEN 'failed' ELSE 'pending' END,
         run_after = CASE WHEN $2 THEN run_after
                          ELSE now() + (LEAST(300, power(2, attempts_count))::text || ' seconds')::interval
                     END,
         finished_at = CASE WHEN $2 THEN now() ELSE NULL END,
         locked_at = NULL,
         locked_by = NULL,
         updated_at = now(),
         job_metadata = job_metadata || jsonb_build_object(
           'outcomeCode', CASE WHEN $2 THEN 'provider_compensation_exhausted'
                               ELSE 'provider_compensation_retry_scheduled' END
         )
     WHERE id = $1::uuid AND status = 'running'`,
    [jobId, terminal],
  );
}

function parsePayload(value: unknown): CompensationPayload {
  const payload = record(value);
  const owner = record(payload?.owner);
  const providerAccountRef = text(payload?.providerAccountRef);
  const idempotencyKey = text(payload?.idempotencyKey);
  if (!owner || !providerAccountRef || !idempotencyKey) throw new Error("Invalid compensation job");
  if (owner.ownerScope === "property") {
    const propertyId = uuid(owner.propertyId);
    const organizationId = owner.organizationId === null ? null : uuid(owner.organizationId);
    if (!propertyId || (owner.organizationId !== null && !organizationId)) {
      throw new Error("Invalid property compensation owner");
    }
    return {
      owner: { ownerScope: "property", propertyId, organizationId },
      providerAccountRef,
      idempotencyKey,
    };
  }
  if (owner.ownerScope === "affiliate") {
    const affiliateId = text(owner.affiliateId);
    const organizationId = uuid(owner.organizationId);
    if (!affiliateId || !organizationId) throw new Error("Invalid affiliate compensation owner");
    return {
      owner: { ownerScope: "affiliate", affiliateId, organizationId },
      providerAccountRef,
      idempotencyKey,
    };
  }
  throw new Error("Invalid compensation owner scope");
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function uuid(value: unknown): string | null {
  const result = text(value);
  return result &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(result)
    ? result
    : null;
}
