import pg from "pg";

import type { RepositoryConfig } from "./repository.js";

export type StaffRemovalJobClaim = {
  outcome: "claimed";
  jobId: string;
  leaseToken: string;
  membershipId: string;
  payload: unknown;
};

export interface StaffRemovalJobRepository {
  claim(
    jobId: string,
  ): Promise<
    StaffRemovalJobClaim | { outcome: "succeeded" | "dead_lettered" | "not_ready"; jobId: string }
  >;
  markSucceeded(
    jobId: string,
    leaseToken: string,
    providerOutcome: "deleted" | "already_absent",
  ): Promise<boolean>;
  markRetryableFailure(
    jobId: string,
    leaseToken: string,
  ): Promise<"pending" | "dead_lettered" | "not_ready">;
  markDeadLettered(jobId: string, leaseToken: string, reason: string): Promise<boolean>;
}

type ClaimedJobRow = {
  id: string;
  locked_by: string;
  resource_id: string;
  payload: unknown;
};

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function createPgStaffRemovalJobRepository(config: RepositoryConfig) {
  if (!config.connectionString.trim()) {
    throw new Error("Staff removal job repository connectionString must not be empty");
  }
  const pool = new pg.Pool({ connectionString: config.connectionString, max: config.max });

  return {
    async claim(jobId: string) {
      if (!uuidPattern.test(jobId)) return { outcome: "not_ready" as const, jobId };
      await pool.query(
        `UPDATE platform.jobs
         SET status = 'dead_lettered', finished_at = now(), locked_at = NULL, locked_by = NULL,
             job_metadata = job_metadata || jsonb_build_object('failureCode', 'worker_lease_expired'),
             updated_at = now()
         WHERE id = $1::uuid AND status = 'running' AND attempts_count >= max_attempts
           AND locked_at < now() - interval '5 minutes'
           AND queue_name = 'identity-provider'
           AND job_type = 'workos.organization-membership.delete'`,
        [jobId],
      );
      const claimed = await pool.query<ClaimedJobRow>(
        `UPDATE platform.jobs
         SET status = 'running', attempts_count = attempts_count + 1,
             locked_at = now(), locked_by = gen_random_uuid()::text, updated_at = now()
         WHERE id = $1::uuid AND queue_name = 'identity-provider'
           AND job_type = 'workos.organization-membership.delete'
           AND attempts_count < max_attempts
           AND ((status = 'pending' AND run_after <= now())
             OR (status = 'running' AND locked_at < now() - interval '5 minutes'))
         RETURNING id::text, locked_by, resource_id, payload`,
        [jobId],
      );
      const row = claimed.rows[0];
      if (row) {
        return {
          outcome: "claimed" as const,
          jobId: row.id,
          leaseToken: row.locked_by,
          membershipId: row.resource_id,
          payload: row.payload,
        };
      }
      const existing = await pool.query<{ status: string }>(
        `SELECT status FROM platform.jobs
         WHERE id = $1::uuid AND queue_name = 'identity-provider'
           AND job_type = 'workos.organization-membership.delete'`,
        [jobId],
      );
      const status = existing.rows[0]?.status;
      return {
        outcome:
          status === "succeeded"
            ? ("succeeded" as const)
            : status === "dead_lettered"
              ? ("dead_lettered" as const)
              : ("not_ready" as const),
        jobId,
      };
    },

    async markSucceeded(
      jobId: string,
      leaseToken: string,
      providerOutcome: "deleted" | "already_absent",
    ) {
      const result = await pool.query(
        `UPDATE platform.jobs
         SET status = 'succeeded', finished_at = now(), locked_at = NULL, locked_by = NULL,
             job_metadata = job_metadata || jsonb_build_object('providerOutcome', $3::text),
             updated_at = now()
         WHERE id = $1::uuid AND status = 'running' AND locked_by = $2
           AND queue_name = 'identity-provider'
           AND job_type = 'workos.organization-membership.delete'`,
        [jobId, leaseToken, providerOutcome],
      );
      return result.rowCount === 1;
    },

    async markRetryableFailure(jobId: string, leaseToken: string) {
      const result = await pool.query<{ status: "pending" | "dead_lettered" }>(
        `UPDATE platform.jobs
         SET status = CASE WHEN attempts_count >= max_attempts THEN 'dead_lettered' ELSE 'pending' END,
             run_after = CASE WHEN attempts_count >= max_attempts THEN run_after
                              ELSE now() + interval '5 seconds' END,
             finished_at = CASE WHEN attempts_count >= max_attempts THEN now() ELSE NULL END,
             locked_at = NULL, locked_by = NULL,
             job_metadata = job_metadata || jsonb_build_object('failureCode', 'provider_unavailable'),
             updated_at = now()
         WHERE id = $1::uuid AND status = 'running' AND locked_by = $2
           AND queue_name = 'identity-provider'
           AND job_type = 'workos.organization-membership.delete'
         RETURNING status`,
        [jobId, leaseToken],
      );
      return result.rows[0]?.status ?? "not_ready";
    },

    async markDeadLettered(jobId: string, leaseToken: string, reason: string) {
      const result = await pool.query(
        `UPDATE platform.jobs
         SET status = 'dead_lettered', finished_at = now(), locked_at = NULL, locked_by = NULL,
             job_metadata = job_metadata || jsonb_build_object('failureCode', $3::text),
             updated_at = now()
         WHERE id = $1::uuid AND status = 'running' AND locked_by = $2
           AND queue_name = 'identity-provider'
           AND job_type = 'workos.organization-membership.delete'`,
        [jobId, leaseToken, reason],
      );
      return result.rowCount === 1;
    },

    close: () => pool.end(),
  } satisfies StaffRemovalJobRepository & { close(): Promise<void> };
}
