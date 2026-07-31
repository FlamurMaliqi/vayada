import pg from "pg";

const QUEUE = "pms.channex.webhooks";
const JOB_TYPE = "channex.review-received";

type ReviewJobRow = { id: string; payload: Record<string, unknown> };

export async function runChannexReviewJobs(
  connectionString: string,
  workerId = `channex-reviews:${process.pid}`,
  limit = 25,
): Promise<{ processed: number; failed: number }> {
  const pool = new pg.Pool({ connectionString, max: 2 });
  let processed = 0;
  let failed = 0;
  try {
    for (let index = 0; index < limit; index += 1) {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const claimed = await client.query<ReviewJobRow>(
          `SELECT id::text, payload
           FROM platform.jobs
           WHERE queue_name = $1 AND job_type = $2
             AND status = 'pending' AND run_after <= now()
             AND attempts_count < max_attempts
           ORDER BY priority DESC, created_at ASC
           FOR UPDATE SKIP LOCKED
           LIMIT 1`,
          [QUEUE, JOB_TYPE],
        );
        const job = claimed.rows[0];
        if (!job) {
          await client.query("ROLLBACK");
          break;
        }
        await client.query(
          `UPDATE platform.jobs SET status = 'running', attempts_count = attempts_count + 1,
             locked_at = now(), locked_by = $2 WHERE id = $1`,
          [job.id, workerId],
        );
        try {
          const review = parseReview(job.payload);
          const property = await client.query<{ id: string }>(
            `SELECT property_id::text AS id FROM pms.channel_connections
             WHERE provider = 'channex' AND external_property_id = $1`,
            [review.externalPropertyId],
          );
          if (property.rows.length > 1)
            throw new Error("Channex review property mapping is ambiguous");
          const directProperty =
            property.rows.length === 0
              ? await client.query<{ id: string }>(
                  `SELECT id::text FROM hotel_catalog.properties WHERE id::text = $1`,
                  [review.externalPropertyId],
                )
              : property;
          const propertyId = directProperty.rows[0]?.id;
          if (!propertyId) throw new Error("Channex review property is not mapped");
          await client.query(
            `INSERT INTO pms.channel_reviews
               (property_id, provider, provider_review_id, channel, guest_display_name,
                rating, body, reviewed_at, provider_updated_at, provider_snapshot)
             VALUES ($1, 'channex', $2, $3, $4, $5, $6, $7, $8, $9)
             ON CONFLICT (property_id, provider, provider_review_id) DO UPDATE SET
               channel = EXCLUDED.channel, guest_display_name = EXCLUDED.guest_display_name,
               rating = EXCLUDED.rating, body = EXCLUDED.body,
               reviewed_at = EXCLUDED.reviewed_at,
               provider_updated_at = EXCLUDED.provider_updated_at,
               provider_snapshot = EXCLUDED.provider_snapshot, updated_at = now()
             WHERE pms.channel_reviews.provider_updated_at IS NULL
                OR (EXCLUDED.provider_updated_at IS NOT NULL
                    AND EXCLUDED.provider_updated_at >= pms.channel_reviews.provider_updated_at)`,
            [
              propertyId,
              review.reviewId,
              review.channel,
              review.guestName,
              review.rating,
              review.body,
              review.reviewedAt,
              review.updatedAt,
              JSON.stringify(review.snapshot),
            ],
          );
          await client.query(
            `UPDATE platform.jobs SET status = 'succeeded', finished_at = now(),
               locked_at = NULL, locked_by = NULL WHERE id = $1`,
            [job.id],
          );
          await client.query("COMMIT");
          processed += 1;
        } catch (error) {
          await client.query(
            `UPDATE platform.jobs SET status = CASE WHEN attempts_count >= max_attempts
                 THEN 'dead_lettered' ELSE 'pending' END,
               run_after = now() + interval '30 seconds', locked_at = NULL, locked_by = NULL,
               finished_at = CASE WHEN attempts_count >= max_attempts THEN now() ELSE NULL END,
               job_metadata = job_metadata || jsonb_build_object('lastError', $2::text)
             WHERE id = $1`,
            [job.id, error instanceof Error ? error.message : "Review ingestion failed"],
          );
          await client.query("COMMIT");
          failed += 1;
        }
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
    }
    return { processed, failed };
  } finally {
    await pool.end();
  }
}

function parseReview(payload: Record<string, unknown>) {
  const raw = record(payload.rawPayload);
  const envelope = record(raw.payload);
  const review = record(envelope.review);
  const reviewId = text(payload.reviewId) ?? text(review.id);
  const externalPropertyId = text(payload.propertyId) ?? text(envelope.property_id);
  if (!reviewId || !externalPropertyId) throw new Error("Invalid Channex review payload");
  return {
    reviewId,
    externalPropertyId,
    channel: text(review.channel) ?? text(envelope.channel),
    guestName: text(review.guest_name) ?? text(review.guest_display_name),
    rating: number(review.rating),
    body: text(review.content) ?? text(review.body) ?? "",
    reviewedAt: text(review.created_at) ?? text(envelope.created_at),
    updatedAt: text(review.updated_at) ?? text(payload.reviewRevision),
    snapshot: {
      channel: text(review.channel),
      rating: number(review.rating),
      updatedAt: text(review.updated_at),
    },
  };
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}
function number(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}
