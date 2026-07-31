import pg from "pg";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runChannexReviewJobs } from "./channexReviews.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
const propertyId = "10000000-0000-4000-8000-000000000001";

describe.skipIf(!databaseUrl)("Channex review worker (PostgreSQL)", () => {
  let client: pg.Client;

  beforeEach(async () => {
    client = new pg.Client({ connectionString: databaseUrl });
    await client.connect();
    await client.query(`
      DROP SCHEMA IF EXISTS platform CASCADE;
      DROP SCHEMA IF EXISTS pms CASCADE;
      DROP SCHEMA IF EXISTS hotel_catalog CASCADE;
      CREATE SCHEMA platform;
      CREATE SCHEMA pms;
      CREATE SCHEMA hotel_catalog;
      CREATE TABLE hotel_catalog.properties (id uuid PRIMARY KEY);
      CREATE TABLE pms.channel_connections (
        property_id uuid NOT NULL, provider text NOT NULL, external_property_id text
      );
      CREATE TABLE pms.channel_reviews (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(), property_id uuid NOT NULL,
        provider text NOT NULL, provider_review_id text NOT NULL, channel text,
        guest_display_name text, rating numeric, body text NOT NULL DEFAULT '',
        reply_body text, reviewed_at timestamptz, provider_updated_at timestamptz,
        provider_snapshot jsonb NOT NULL DEFAULT '{}', created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(),
        UNIQUE (property_id, provider, provider_review_id)
      );
      CREATE TABLE platform.jobs (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(), queue_name text NOT NULL,
        job_type text NOT NULL, status text NOT NULL DEFAULT 'pending', priority int NOT NULL DEFAULT 0,
        attempts_count int NOT NULL DEFAULT 0, max_attempts int NOT NULL DEFAULT 5,
        run_after timestamptz NOT NULL DEFAULT now(), locked_at timestamptz, locked_by text,
        finished_at timestamptz, payload jsonb NOT NULL, job_metadata jsonb NOT NULL DEFAULT '{}',
        created_at timestamptz NOT NULL DEFAULT now(),
        CHECK (status <> 'running' OR (locked_at IS NOT NULL AND locked_by IS NOT NULL)),
        CHECK (status NOT IN ('succeeded', 'failed', 'canceled', 'dead_lettered') OR finished_at IS NOT NULL)
      );
      INSERT INTO hotel_catalog.properties (id) VALUES ('${propertyId}');
      INSERT INTO pms.channel_connections (property_id, provider, external_property_id)
      VALUES ('${propertyId}', 'channex', 'external-property');
    `);
  });

  afterEach(async () => {
    await client.query("DROP SCHEMA platform, pms, hotel_catalog CASCADE");
    await client.end();
  });

  it("stores a review and completes its durable job", async () => {
    await insertJob("review-1", "2026-07-30T10:00:00.000Z", "Excellent");
    expect(await runChannexReviewJobs(databaseUrl!, "test-worker")).toEqual({
      processed: 1,
      failed: 0,
    });
    const review = await client.query(`SELECT body FROM pms.channel_reviews`);
    const job = await client.query(`SELECT status, finished_at FROM platform.jobs`);
    expect(review.rows[0].body).toBe("Excellent");
    expect(job.rows[0]).toMatchObject({ status: "succeeded" });
    expect(job.rows[0].finished_at).not.toBeNull();
  });

  it("does not let an older revision overwrite a newer review", async () => {
    await insertJob("review-1", "2026-07-30T11:00:00.000Z", "Newest");
    await insertJob("review-1", "2026-07-30T10:00:00.000Z", "Older");
    await runChannexReviewJobs(databaseUrl!, "test-worker");
    const review = await client.query(`SELECT body FROM pms.channel_reviews`);
    expect(review.rows[0].body).toBe("Newest");
  });

  it("dead-letters an unmapped review without violating terminal constraints", async () => {
    await insertJob("review-2", "2026-07-30T10:00:00.000Z", "Unknown", "unmapped", 1);
    expect(await runChannexReviewJobs(databaseUrl!, "test-worker")).toEqual({
      processed: 0,
      failed: 1,
    });
    const job = await client.query(`SELECT status, finished_at FROM platform.jobs`);
    expect(job.rows[0].status).toBe("dead_lettered");
    expect(job.rows[0].finished_at).not.toBeNull();
  });

  async function insertJob(
    reviewId: string,
    updatedAt: string,
    body: string,
    externalPropertyId = "external-property",
    maxAttempts = 5,
  ) {
    await client.query(
      `INSERT INTO platform.jobs (queue_name, job_type, max_attempts, payload)
       VALUES ('pms.channex.webhooks', 'channex.review-received', $1, $2)`,
      [
        maxAttempts,
        {
          propertyId: externalPropertyId,
          reviewId,
          reviewRevision: updatedAt,
          rawPayload: {
            payload: { review: { id: reviewId, content: body, updated_at: updatedAt } },
          },
        },
      ],
    );
  }
});
