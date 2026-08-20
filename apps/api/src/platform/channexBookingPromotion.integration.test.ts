import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type {
  ProviderWebhookNormalizedPreview,
  ProviderWebhookReceiptInput,
} from "../routes/providerWebhooks.js";
import { createPgProviderWebhookStore } from "./providerWebhooks.js";

const TEST_DATABASE_URL = process.env["TEST_DATABASE_URL"];
const RUN = randomUUID();
if (
  TEST_DATABASE_URL &&
  !/(^|[_-])(test|verify)([_-]|$)/i.test(new URL(TEST_DATABASE_URL).pathname)
) {
  throw new Error("Unsafe test database");
}

describe.skipIf(!TEST_DATABASE_URL)("PostgreSQL Channex booking promotion", () => {
  const admin = new pg.Client({
    connectionString: TEST_DATABASE_URL ?? "postgresql://disabled",
  });
  const store = createPgProviderWebhookStore({
    connectionString: TEST_DATABASE_URL ?? "postgresql://disabled",
  });

  beforeAll(async () => {
    await admin.connect();
  });
  afterAll(async () => {
    await store.close?.();
    await admin.end();
  });

  it("persists one durable job for a semantic revision replay", async () => {
    const input = receipt("replay", preview("replay"));
    const first = await store.recordReceipt(input);
    const duplicate = await store.recordReceipt({ ...input, eventType: "booking_cancellation" });
    expect(first.status).toBe("inserted");
    expect(duplicate.status).toBe("duplicate");

    const promotion = {
      provider: "channex" as const,
      receiptId: first.receiptId,
      receiptKey: input.receiptKey,
      receiptKeyHash: input.receiptKeyHash,
      payloadHash: input.payloadHash,
      rawPayload: input.rawPayload,
      normalizedPreview: input.normalizedPreview,
    };
    await expect(store.promoteReceipt(promotion)).resolves.toMatchObject({
      status: "promoted",
    });
    await expect(store.promoteReceipt(promotion)).resolves.toMatchObject({
      status: "already_promoted",
    });

    const counts = await admin.query<{ receipts: number; events: number; jobs: number }>(
      `SELECT
         (SELECT count(*)::int FROM platform.external_webhook_events
          WHERE provider_event_id = $1) AS receipts,
         (SELECT count(*)::int FROM platform.domain_events WHERE event_key = $2) AS events,
         (SELECT count(*)::int FROM platform.jobs WHERE job_key = $3) AS jobs`,
      [input.receiptKey, input.normalizedPreview.domainEventKey, input.normalizedPreview.jobKey],
    );
    expect(counts.rows[0]).toEqual({ receipts: 1, events: 1, jobs: 1 });
  });

  it("rolls back domain event and job persistence together", async () => {
    const input = receipt("rollback", {
      ...preview("rollback"),
      payload: { invalidJsonValue: 1n },
    });
    const recorded = await store.recordReceipt(input);

    await expect(
      store.promoteReceipt({
        provider: "channex",
        receiptId: recorded.receiptId,
        receiptKey: input.receiptKey,
        receiptKeyHash: input.receiptKeyHash,
        payloadHash: input.payloadHash,
        rawPayload: input.rawPayload,
        normalizedPreview: input.normalizedPreview,
      }),
    ).rejects.toThrow();

    const state = await admin.query<{ status: string; events: number; jobs: number }>(
      `SELECT delivery_status AS status,
         (SELECT count(*)::int FROM platform.domain_events WHERE event_key = $2) AS events,
         (SELECT count(*)::int FROM platform.jobs WHERE job_key = $3) AS jobs
       FROM platform.external_webhook_events WHERE provider_event_id = $1`,
      [input.receiptKey, input.normalizedPreview.domainEventKey, input.normalizedPreview.jobKey],
    );
    expect(state.rows[0]).toEqual({ status: "observed", events: 0, jobs: 0 });
  });

  function preview(suffix: string): ProviderWebhookNormalizedPreview {
    return {
      domainEventKey: `channex.booking.ingest:vay845:${RUN}:${suffix}:7:v1`,
      domainEventType: "channex.booking.ingest",
      resourceProduct: "pms",
      resourceType: "channel_booking",
      resourceId: `vay845-${RUN}-${suffix}`,
      jobKey: `channex.ingest-booking:channel_booking:vay845:${RUN}:${suffix}:revision-7:v1`,
      queueName: "pms.channex.webhooks",
      jobType: "channex.ingest-booking",
      payload: { revisionSource: "webhook_hint", pullRequired: true },
    };
  }

  function receipt(
    suffix: string,
    normalizedPreview: ProviderWebhookNormalizedPreview,
  ): ProviderWebhookReceiptInput {
    const receiptKey = `webhook:channex:vay845:${RUN}:${suffix}`;
    return {
      provider: "channex",
      receiptKey,
      receiptKeyHash: `hash-${RUN}-${suffix}`,
      providerEventId: receiptKey,
      eventType: "booking",
      payloadHash: `payload-${RUN}-${suffix}`,
      rawHeaders: {},
      rawPayload: {
        event: "booking",
        payload: { id: `vay845-${RUN}-${suffix}`, revision: "7" },
      },
      mode: "mutating",
      normalizedPreview,
    };
  }
});
