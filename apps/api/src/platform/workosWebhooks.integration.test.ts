import { randomUUID } from "node:crypto";

import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { buildApp } from "../app.js";
import { createPgWorkosWebhookStore } from "./workosWebhooks.js";

const TEST_DATABASE_URL = process.env["TEST_DATABASE_URL"];
const providerEventId = `evt_vay_1239_${randomUUID()}`;

describe.skipIf(!TEST_DATABASE_URL)("PostgreSQL WorkOS webhook dead letters", () => {
  const admin = new pg.Client({
    connectionString: TEST_DATABASE_URL ?? "postgresql://integration-test-disabled",
  });
  const store = createPgWorkosWebhookStore({
    connectionString: TEST_DATABASE_URL ?? "postgresql://integration-test-disabled",
    max: 2,
  });

  beforeAll(async () => {
    assertSafeTestDatabase(TEST_DATABASE_URL!);
    await admin.connect();
  });

  afterAll(async () => {
    await store.close();
    await admin.end();
  });

  it("persists a failed reconciliation once and deduplicates its retry", async () => {
    const event = {
      id: providerEventId,
      event: "organization_membership.created",
      createdAt: "2026-08-11T16:00:00.000Z",
      data: {
        id: "om_vay_1239_missing",
        user_id: "user_vay_1239_missing",
        organization_id: "org_vay_1239_missing",
        role: { slug: "hotel_member" },
        status: "active",
      },
    };
    const app = buildApp({
      workosWebhooks: {
        secret: "whsec_test",
        verifier: {
          async verify() {
            return event;
          },
        },
        store,
        processInline: true,
      },
    });

    try {
      const first = await postWebhook(app);
      expect(first.statusCode).toBe(200);
      expect(first.json()).toMatchObject({ status: "dead_lettered" });
      const receiptId = first.json<{ receiptId: string }>().receiptId;

      const persistenceRetry = {
        receiptId,
        reasonCode: "identity_reconciliation_failed",
        failureSummary: "WorkOS membership references an unknown user or organization",
        failurePayload: {
          eventId: providerEventId,
          eventType: "organization_membership.created",
        },
      };
      await Promise.all([
        store.deadLetterReceipt(persistenceRetry),
        store.deadLetterReceipt(persistenceRetry),
      ]);

      const second = await postWebhook(app);
      expect(second.statusCode).toBe(200);
      expect(second.json()).toEqual({ status: "duplicate", receiptId });

      const deadLetters = await admin.query<{
        failurePayload: unknown;
        reasonCode: string;
        resourceId: string;
        webhookEventId: string;
      }>(
        `SELECT dead.webhook_event_id::text AS "webhookEventId",
                dead.resource_id AS "resourceId",
                dead.reason_code AS "reasonCode",
                dead.failure_payload AS "failurePayload"
         FROM platform.dead_letter_events AS dead
         JOIN platform.external_webhook_events AS receipt
           ON receipt.id = dead.webhook_event_id
         WHERE receipt.provider = 'workos'
           AND receipt.provider_event_id = $1`,
        [providerEventId],
      );
      expect(deadLetters.rows).toEqual([
        {
          webhookEventId: receiptId,
          resourceId: receiptId,
          reasonCode: "identity_reconciliation_failed",
          failurePayload: {
            eventId: providerEventId,
            eventType: "organization_membership.created",
          },
        },
      ]);

      const reconciliations = await admin.query<{
        error: string;
        payload: unknown;
        providerEventId: string;
      }>(
        `SELECT provider_event_id AS "providerEventId", payload, error
         FROM identity.auth_reconciliation_events
         WHERE provider = 'workos'
           AND event_type = 'workos.webhook.dead_lettered'
           AND provider_event_id = $1`,
        [receiptId],
      );
      expect(reconciliations.rows).toEqual([
        {
          providerEventId: receiptId,
          payload: {
            eventId: providerEventId,
            eventType: "organization_membership.created",
          },
          error:
            "identity_reconciliation_failed: WorkOS membership references an unknown user or organization",
        },
      ]);
    } finally {
      await app.close();
    }
  });

  async function postWebhook(app: ReturnType<typeof buildApp>) {
    return app.inject({
      method: "POST",
      url: "/auth/workos/webhook",
      headers: {
        "content-type": "application/json",
        "workos-signature": "valid-signature",
      },
      payload: JSON.stringify({ id: providerEventId }),
    });
  }
});

function assertSafeTestDatabase(connectionString: string): void {
  const url = new URL(connectionString);
  if (
    !["localhost", "127.0.0.1", "[::1]", "::1"].includes(url.hostname) ||
    !url.pathname.toLowerCase().includes("test")
  ) {
    throw new Error("Refusing to run WorkOS webhook integration tests on a non-test DB");
  }
}
