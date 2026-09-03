import pg, { type QueryResultRow } from "pg";

import {
  PMS_INBOX_DELIVERY_JOB_TYPE,
  PMS_INBOX_DELIVERY_QUEUE,
} from "../domains/pmsInboxDelivery.js";

type Pool = {
  query<T extends QueryResultRow = QueryResultRow>(
    text: string,
    values?: readonly unknown[],
  ): Promise<{ rows: T[] }>;
  end?(): Promise<void>;
};

export async function relayPmsInboxDeliveryOutbox(
  connectionString: string,
  options: { pool?: Pool; limit?: number; now?: Date } = {},
): Promise<{ published: number }> {
  const ownsPool = !options.pool;
  const pool = options.pool ?? new pg.Pool({ connectionString, max: 2 });
  try {
    const result = await pool.query<{ published: string | number }>(
      `WITH candidates AS (
         SELECT outbox.*
         FROM platform.outbox_events outbox
         WHERE outbox.destination = $1
           AND outbox.event_type = $1
           AND outbox.status IN ('pending', 'failed')
           AND outbox.available_at <= $3::timestamptz
           AND outbox.attempts_count < outbox.max_attempts
         ORDER BY outbox.priority DESC, outbox.available_at, outbox.created_at
         FOR UPDATE SKIP LOCKED
         LIMIT $2
       ), jobs AS (
         INSERT INTO platform.jobs (
           job_key, queue_name, job_type, source_domain_event_id,
           source_outbox_event_id, priority, max_attempts, run_after,
           tenant_scope, organization_id, property_id,
           resource_product, resource_type, resource_id,
           correlation_id, idempotency_key_hash, payload, job_metadata
         )
         SELECT
           candidate.outbox_key, $4, $1, candidate.domain_event_id,
           candidate.id, candidate.priority, candidate.max_attempts, $3::timestamptz,
           candidate.tenant_scope, candidate.organization_id, candidate.property_id,
           candidate.resource_product, candidate.resource_type, candidate.resource_id,
           candidate.correlation_id, candidate.idempotency_key_hash, candidate.payload,
           candidate.outbox_metadata || jsonb_build_object(
             'source', 'pms-inbox-delivery-outbox-relay'
           )
         FROM candidates candidate
         ON CONFLICT (queue_name, job_key) DO NOTHING
         RETURNING source_outbox_event_id
       ), published AS (
         UPDATE platform.outbox_events outbox
         SET status = 'published', attempts_count = attempts_count + 1,
             leased_until = NULL, published_at = $3::timestamptz,
             updated_at = $3::timestamptz
         FROM candidates candidate
         WHERE outbox.id = candidate.id
           AND EXISTS (
             SELECT 1 FROM platform.jobs job
             WHERE job.queue_name = $4 AND job.job_key = candidate.outbox_key
               AND job.source_outbox_event_id = candidate.id
               AND job.source_domain_event_id = candidate.domain_event_id
           )
         RETURNING outbox.id
       )
       SELECT count(*)::text AS published FROM published`,
      [
        PMS_INBOX_DELIVERY_JOB_TYPE,
        options.limit ?? 25,
        (options.now ?? new Date()).toISOString(),
        PMS_INBOX_DELIVERY_QUEUE,
      ],
    );
    return { published: Number(result.rows[0]?.published ?? 0) };
  } finally {
    if (ownsPool) await pool.end?.();
  }
}
