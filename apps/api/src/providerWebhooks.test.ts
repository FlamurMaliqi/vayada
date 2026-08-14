import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";

import { buildApp } from "./app.js";
import type {
  ProviderWebhookMode,
  ProviderWebhookPromotionInput,
  ProviderWebhookReceiptInput,
  ProviderWebhookReceiptLifecycleStatus,
  ProviderWebhookStore,
} from "./routes/providerWebhooks.js";

const fixedNow = new Date("2026-06-11T12:00:00.000Z");

describe("target provider webhook routes", () => {
  for (const provider of ["stripe", "xendit", "channex"] as const) {
    for (const mode of ["observe_only", "ack_only_with_receipt", "mutating"] as const) {
      it(`${provider} verifies signatures and dedupes replayed receipts in ${mode}`, async () => {
        const store = createMemoryProviderWebhookStore();
        const app = buildApp({
          providerWebhooks: {
            secrets: {
              stripe: "whsec_stripe_test",
              xendit: "xendit-secret",
              channex: "channex-secret",
            },
            modes: {
              [provider]: mode,
            },
            store,
            now: () => fixedNow,
          },
        });

        const first = await postProviderFixture(app, provider);
        const second = await postProviderFixture(app, provider);

        expect(first.statusCode).toBe(200);
        expect(second.statusCode).toBe(200);
        expect(store.receipts).toHaveLength(1);
        expect(store.idempotencyKeys).toContain(store.receipts[0]!.receiptKey);
        expect(store.receipts[0]!.lifecycleStatus).toBe(
          mode === "mutating" ? "promoted" : "observed",
        );

        if (mode === "observe_only") {
          expect(first.json()).toMatchObject({ status: "observed", mode });
          expect(second.json()).toMatchObject({ status: "duplicate_observed", mode });
          expect(store.domainEvents).toHaveLength(0);
          expect(store.jobs).toHaveLength(0);
        } else if (mode === "ack_only_with_receipt") {
          expect(first.json()).toMatchObject({
            status: "acknowledged",
            mode,
            replayRequired: true,
          });
          expect(second.json()).toMatchObject({
            status: "duplicate_acknowledged",
            mode,
            replayRequired: true,
          });
          expect(store.domainEvents).toHaveLength(0);
          expect(store.jobs).toHaveLength(0);
        } else {
          expect(first.json()).toMatchObject({ status: "promoted", mode });
          expect(second.json()).toMatchObject({
            status: "duplicate",
            mode,
            lifecycleStatus: "promoted",
          });
          expect(store.domainEvents).toHaveLength(1);
          expect(store.jobs).toHaveLength(1);
          expect(store.idempotencyKeys).toContain(store.domainEvents[0]!.domainEventKey);
          expect(store.idempotencyKeys).toContain(store.jobs[0]!.jobKey);
        }

        await app.close();
      });
    }

    it(`${provider} rejects invalid authentication before recording a receipt`, async () => {
      const store = createMemoryProviderWebhookStore();
      const app = buildApp({
        providerWebhooks: {
          secrets: {
            stripe: "whsec_stripe_test",
            xendit: "xendit-secret",
            channex: "channex-secret",
          },
          store,
          now: () => fixedNow,
        },
      });

      const response = await postProviderFixture(app, provider, { invalidAuth: true });

      expect(response.statusCode).toBe(provider === "channex" ? 401 : 400);
      expect(store.receipts).toHaveLength(0);
      expect(store.domainEvents).toHaveLength(0);
      expect(store.jobs).toHaveLength(0);
      await app.close();
    });
  }

  it("uses the cutover receipt-key scheme for each provider fixture", async () => {
    const store = createMemoryProviderWebhookStore();
    const app = buildApp({
      providerWebhooks: {
        secrets: {
          stripe: "whsec_stripe_test",
          xendit: "xendit-secret",
          channex: "channex-secret",
        },
        modes: {
          stripe: "observe_only",
          xendit: "observe_only",
          channex: "observe_only",
        },
        store,
        now: () => fixedNow,
      },
    });

    await postProviderFixture(app, "stripe");
    await postProviderFixture(app, "xendit");
    await postProviderFixture(app, "channex");

    expect(store.receipts.map((receipt) => receipt.receiptKey)).toEqual([
      "webhook:stripe:evt_stripe_pi_succeeded",
      "webhook:xendit:invoice:inv_xendit_paid:PAID",
      "webhook:channex:message:prop_channex_123:msg_channex_456",
    ]);
    await app.close();
  });

  it("removes Stripe client secrets before receipt, event, and job persistence", async () => {
    const store = createMemoryProviderWebhookStore();
    const app = buildApp({
      providerWebhooks: {
        secrets: { stripe: "whsec_stripe_test" },
        modes: { stripe: "mutating" },
        store,
        now: () => fixedNow,
      },
    });
    const payload = providerFixture("stripe").payload;
    const object = (payload.data as { object: Record<string, unknown> }).object;
    object.client_secret = "pi_secret_must_not_persist";

    const response = await postProviderPayload(app, "stripe", payload);

    expect(response.statusCode).toBe(200);
    expect(JSON.stringify(store.receipts)).not.toContain("pi_secret_must_not_persist");
    expect(JSON.stringify(store.domainEvents)).not.toContain("pi_secret_must_not_persist");
    expect(JSON.stringify(store.jobs)).not.toContain("pi_secret_must_not_persist");
    expect(JSON.stringify(store.receipts)).not.toContain("client_secret");
    await app.close();
  });

  it("uses actual Channex message payload ids for receipt and domain event keys", async () => {
    const store = createMemoryProviderWebhookStore();
    const app = buildApp({
      providerWebhooks: {
        secrets: { channex: "channex-secret" },
        modes: { channex: "mutating" },
        store,
        now: () => fixedNow,
      },
    });
    const payload = {
      event: "message",
      payload: {
        property_id: "prop_channex_123",
        id: "msg_actual_456",
        message_thread_id: "thread_actual_789",
        body: "Hello",
      },
    };

    const unconfiguredStripe = await postProviderFixture(app, "stripe");
    const unconfiguredXendit = await postProviderFixture(app, "xendit");
    expect(unconfiguredStripe.statusCode).toBe(503);
    expect(unconfiguredXendit.statusCode).toBe(503);
    expect(store.receipts).toHaveLength(0);
    expect(store.domainEvents).toHaveLength(0);
    expect(store.jobs).toHaveLength(0);

    const response = await app.inject({
      method: "POST",
      url: "/webhooks/channex",
      headers: fixtureHeaders("channex", payload),
      payload: JSON.stringify(payload),
    });

    expect(response.statusCode).toBe(200);
    expect(store.receipts[0]?.receiptKey).toBe(
      "webhook:channex:message:prop_channex_123:msg_actual_456",
    );
    expect(store.domainEvents[0]?.domainEventKey).toBe(
      "channex.message.ingest:prop_channex_123:thread_actual_789:msg_actual_456:v1",
    );
    expect(store.jobs[0]).toMatchObject({
      jobKey: "channex.ingest-message:channel_message:prop_channex_123:msg_actual_456:v1",
    });
    await app.close();
  });

  it("replays Stripe and Xendit payment and payout events without duplicate finance status jobs", async () => {
    const store = createMemoryProviderWebhookStore();
    const app = buildApp({
      providerWebhooks: {
        secrets: {
          stripe: "whsec_stripe_test",
          xendit: "xendit-secret",
        },
        modes: {
          stripe: "mutating",
          xendit: "mutating",
        },
        store,
        now: () => fixedNow,
      },
    });
    const samples: Array<{
      provider: "stripe" | "xendit";
      payload: Record<string, unknown>;
      expectedReceiptKey: string;
    }> = [
      {
        provider: "stripe",
        payload: providerFixture("stripe").payload,
        expectedReceiptKey: "webhook:stripe:evt_stripe_pi_succeeded",
      },
      {
        provider: "stripe",
        payload: stripePayoutPayload(),
        expectedReceiptKey: "webhook:stripe:evt_stripe_payout_paid",
      },
      {
        provider: "xendit",
        payload: providerFixture("xendit").payload,
        expectedReceiptKey: "webhook:xendit:invoice:inv_xendit_paid:PAID",
      },
      {
        provider: "xendit",
        payload: xenditPayoutPayload(),
        expectedReceiptKey: "webhook:xendit:payout:po_xendit_123:SUCCEEDED",
      },
    ];

    for (const sample of samples) {
      const first = await postProviderPayload(app, sample.provider, sample.payload);
      const replay = await postProviderPayload(app, sample.provider, sample.payload);

      expect(first.statusCode).toBe(200);
      expect(replay.statusCode).toBe(200);
      expect(first.json()).toMatchObject({
        status: "promoted",
        receiptKey: sample.expectedReceiptKey,
      });
      expect(replay.json()).toMatchObject({
        status: "duplicate",
        receiptKey: sample.expectedReceiptKey,
        lifecycleStatus: "promoted",
      });
    }

    expect(store.receipts.map((receipt) => receipt.receiptKey)).toEqual([
      "webhook:stripe:evt_stripe_pi_succeeded",
      "webhook:stripe:evt_stripe_payout_paid",
      "webhook:xendit:invoice:inv_xendit_paid:PAID",
      "webhook:xendit:payout:po_xendit_123:SUCCEEDED",
    ]);
    expect(store.domainEvents.map((event) => event.domainEventKey)).toEqual([
      "payment.captured:stripe:platform:pi_stripe_123:42000:v2",
      "payout.status:stripe:po_stripe_123:paid:v1",
      "payment.captured:xendit:inv_xendit_paid:42000:v1",
      "payout.status:xendit:po_xendit_123:SUCCEEDED:v1",
    ]);
    expect(store.jobs.map((job) => job.jobKey)).toEqual([
      "payment.reconcile-status:payment:pi_stripe_123:stripe-event-evt_stripe_pi_succeeded:v1",
      "finance.reconcile-payout:payout:po_stripe_123:stripe-status-paid:v1",
      "payment.reconcile-status:payment:inv_xendit_paid:xendit-status-PAID:v1",
      "finance.reconcile-payout:payout:po_xendit_123:xendit-status-SUCCEEDED:v1",
    ]);
    expect(store.auditEvents.map((event) => event.auditKey)).toEqual(
      store.domainEvents.map((event) => event.domainEventKey),
    );
    expect(store.auditEvents.map((event) => event.action)).toEqual([
      "payment.captured",
      "payout.status",
      "payment.captured",
      "payout.status",
    ]);
    expect(
      store.receipts.map((receipt) => receipt.normalizedPreview.payload.financeStatus),
    ).toEqual(["paid", "paid", "paid", "paid"]);
    await app.close();
  });

  it("normalizes connected-account charge updates for exact Stripe fee reconciliation", async () => {
    const store = createMemoryProviderWebhookStore();
    const app = buildApp({
      providerWebhooks: {
        secrets: { stripe: "whsec_stripe_test" },
        modes: { stripe: "mutating" },
        store,
        now: () => fixedNow,
      },
    });
    const payload = {
      id: "evt_stripe_charge_updated",
      type: "charge.updated",
      account: "acct_property_123",
      data: {
        object: {
          id: "ch_stripe_123",
          payment_intent: "pi_stripe_123",
          balance_transaction: "txn_stripe_123",
          amount: 42_000,
          currency: "eur",
        },
      },
    };

    const response = await postProviderPayload(app, "stripe", payload);

    expect(response.statusCode).toBe(200);
    expect(store.domainEvents[0]).toMatchObject({
      domainEventKey:
        "payment.fee-updated:stripe:acct_property_123:pi_stripe_123:txn_stripe_123:v1",
      domainEventType: "payment.fee_updated",
      resourceId: "pi_stripe_123",
    });
    expect(store.domainEvents[0]?.payload).toMatchObject({
      providerAccountRef: "acct_property_123",
      financeStatus: "paid",
    });
    await app.close();
  });

  it("normalizes selected Xendit invoice and v2 payout states with status-aware jobs", async () => {
    const store = createMemoryProviderWebhookStore();
    const app = buildApp({
      providerWebhooks: {
        secrets: { xendit: "xendit-secret" },
        modes: { xendit: "mutating" },
        store,
        now: () => fixedNow,
      },
    });
    const samples = [
      xenditInvoicePayload({ status: "PAID", amount: 42000 }),
      xenditInvoicePayload({ status: "EXPIRED", amount: 42000 }),
      xenditPayoutPayload({
        event: "payout.succeeded",
        payoutId: "po_xendit_succeeded",
        status: "SUCCEEDED",
      }),
      xenditPayoutPayload({
        event: "payout.failed",
        payoutId: "po_xendit_failed",
        status: "FAILED",
      }),
      xenditPayoutPayload({
        event: "payout.reversed",
        payoutId: "po_xendit_reversed",
      }),
    ];

    for (const payload of samples) {
      const response = await postProviderPayload(app, "xendit", payload);

      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({ status: "promoted" });
    }

    expect(store.receipts.map((receipt) => receipt.receiptKey)).toEqual([
      "webhook:xendit:invoice:inv_xendit_stateful:PAID",
      "webhook:xendit:invoice:inv_xendit_stateful:EXPIRED",
      "webhook:xendit:payout:po_xendit_succeeded:SUCCEEDED",
      "webhook:xendit:payout:po_xendit_failed:FAILED",
      "webhook:xendit:payout:po_xendit_reversed:REVERSED",
    ]);
    expect(store.domainEvents.map((event) => event.domainEventKey)).toEqual([
      "payment.captured:xendit:inv_xendit_stateful:42000:v1",
      "payment.terminal:xendit:inv_xendit_stateful:EXPIRED:v1",
      "payout.status:xendit:po_xendit_succeeded:SUCCEEDED:v1",
      "payout.status:xendit:po_xendit_failed:FAILED:v1",
      "payout.status:xendit:po_xendit_reversed:REVERSED:v1",
    ]);
    expect(store.jobs.map((job) => job.jobKey)).toEqual([
      "payment.reconcile-status:payment:inv_xendit_stateful:xendit-status-PAID:v1",
      "payment.reconcile-status:payment:inv_xendit_stateful:xendit-status-EXPIRED:v1",
      "finance.reconcile-payout:payout:po_xendit_succeeded:xendit-status-SUCCEEDED:v1",
      "finance.reconcile-payout:payout:po_xendit_failed:xendit-status-FAILED:v1",
      "finance.reconcile-payout:payout:po_xendit_reversed:xendit-status-REVERSED:v1",
    ]);
    expect(
      store.receipts.map((receipt) => receipt.normalizedPreview.payload.financeStatus),
    ).toEqual(["paid", "canceled", "paid", "failed", "reversed"]);
    await app.close();
  });

  it("leaves Xendit v3 payout payloads disabled for platform review", async () => {
    const store = createMemoryProviderWebhookStore();
    const app = buildApp({
      providerWebhooks: {
        secrets: { xendit: "xendit-secret" },
        modes: { xendit: "mutating" },
        store,
        now: () => fixedNow,
      },
    });
    const response = await postProviderPayload(app, "xendit", {
      event: "v3_payout.succeeded",
      data: {
        payout_id: "po_xendit_v3_123",
        status: "SUCCEEDED",
      },
    });

    expect(response.statusCode).toBe(200);
    expect(store.receipts[0]?.receiptKey).toMatch(/^webhook:xendit:payout:v3-disabled:sha256:/);
    expect(store.receipts[0]?.normalizedPreview).toMatchObject({
      domainEventType: "xendit.webhook.received",
      resourceProduct: "platform",
      resourceType: "external_webhook",
      queueName: "platform.webhooks",
      jobType: "provider.webhook-review",
      payload: {
        provider: "xendit",
        eventType: "v3_payout.succeeded",
      },
    });
    expect(store.jobs[0]?.jobKey).toContain("provider.webhook-review:external_webhook");
    expect(store.jobs[0]?.jobKey).not.toContain("finance.reconcile-payout");
    await app.close();
  });

  it("normalizes Channex message receipts into PMS channel events and dedupes by property/message", async () => {
    const store = createMemoryProviderWebhookStore();
    const app = buildApp({
      providerWebhooks: {
        secrets: { channex: "channex-secret" },
        modes: { channex: "mutating" },
        store,
        now: () => fixedNow,
      },
    });
    const propertyOnePayload = channexMessagePayload({
      propertyId: "prop_alpenrose",
      sourceMessageId: "msg_shared_456",
      threadId: "thread_alpenrose_1",
    });
    const propertyTwoPayload = channexMessagePayload({
      propertyId: "prop_riviera",
      sourceMessageId: "msg_shared_456",
      threadId: "thread_riviera_1",
    });

    const first = await postChannexPayload(app, propertyOnePayload);
    const replay = await postChannexPayload(app, propertyOnePayload);
    const sameMessageOtherProperty = await postChannexPayload(app, propertyTwoPayload);

    expect(first.json()).toMatchObject({ status: "promoted" });
    expect(replay.json()).toMatchObject({
      status: "duplicate",
      receiptKey: "webhook:channex:message:prop_alpenrose:msg_shared_456",
    });
    expect(sameMessageOtherProperty.json()).toMatchObject({ status: "promoted" });
    expect(store.receipts.map((receipt) => receipt.receiptKey)).toEqual([
      "webhook:channex:message:prop_alpenrose:msg_shared_456",
      "webhook:channex:message:prop_riviera:msg_shared_456",
    ]);
    expect(store.domainEvents.map((event) => event.domainEventKey)).toEqual([
      "channex.message.ingest:prop_alpenrose:thread_alpenrose_1:msg_shared_456:v1",
      "channex.message.ingest:prop_riviera:thread_riviera_1:msg_shared_456:v1",
    ]);
    expect(store.jobs.map((job) => job.jobKey)).toEqual([
      "channex.ingest-message:channel_message:prop_alpenrose:msg_shared_456:v1",
      "channex.ingest-message:channel_message:prop_riviera:msg_shared_456:v1",
    ]);
    expect(store.receipts[0]?.normalizedPreview).toMatchObject({
      domainEventType: "channex.message.ingest",
      resourceProduct: "pms",
      resourceType: "channel_message",
      queueName: "pms.channex.webhooks",
      jobType: "channex.ingest-message",
      payload: {
        provider: "channex",
        propertyId: "prop_alpenrose",
        sourceMessageId: "msg_shared_456",
      },
    });
    await app.close();
  });

  it("normalizes Channex booking receipts into PMS channel events and dedupes by property/booking revision", async () => {
    const store = createMemoryProviderWebhookStore();
    const app = buildApp({
      providerWebhooks: {
        secrets: { channex: "channex-secret" },
        modes: { channex: "mutating" },
        store,
        now: () => fixedNow,
      },
    });
    const propertyOnePayload = channexBookingRevisionPayload({
      propertyId: "prop_alpenrose",
      bookingRevisionId: "rev_shared_7",
      channelBookingId: "chx_booking_123",
      revision: "7",
    });
    const propertyTwoPayload = channexBookingRevisionPayload({
      propertyId: "prop_riviera",
      bookingRevisionId: "rev_shared_7",
      channelBookingId: "chx_booking_123",
      revision: "7",
    });

    const first = await postChannexPayload(app, propertyOnePayload);
    const replay = await postChannexPayload(app, propertyOnePayload);
    const sameRevisionOtherProperty = await postChannexPayload(app, propertyTwoPayload);

    expect(first.json()).toMatchObject({ status: "promoted" });
    expect(replay.json()).toMatchObject({
      status: "duplicate",
      receiptKey: "webhook:channex:booking:prop_alpenrose:rev_shared_7:7",
    });
    expect(sameRevisionOtherProperty.json()).toMatchObject({ status: "promoted" });
    expect(store.receipts.map((receipt) => receipt.receiptKey)).toEqual([
      "webhook:channex:booking:prop_alpenrose:rev_shared_7:7",
      "webhook:channex:booking:prop_riviera:rev_shared_7:7",
    ]);
    expect(store.domainEvents.map((event) => event.domainEventKey)).toEqual([
      "channex.booking.ingest:prop_alpenrose:chx_booking_123:7:v1",
      "channex.booking.ingest:prop_riviera:chx_booking_123:7:v1",
    ]);
    expect(store.jobs.map((job) => job.jobKey)).toEqual([
      "channex.ingest-booking:channel_booking:prop_alpenrose:chx_booking_123:revision-7:v1",
      "channex.ingest-booking:channel_booking:prop_riviera:chx_booking_123:revision-7:v1",
    ]);
    expect(store.receipts[0]?.normalizedPreview).toMatchObject({
      domainEventType: "channex.booking.ingest",
      resourceProduct: "pms",
      resourceType: "channel_booking",
      queueName: "pms.channex.webhooks",
      jobType: "channex.ingest-booking",
      payload: {
        provider: "channex",
        propertyId: "prop_alpenrose",
        channelBookingId: "chx_booking_123",
        revision: "7",
      },
    });
    await app.close();
  });

  it.each(["inquiry", "reservation_request"] as const)(
    "does not classify Channex %s payloads with booking identifiers as booking ingestion",
    async (event) => {
      const store = createMemoryProviderWebhookStore();
      const app = buildApp({
        providerWebhooks: {
          secrets: { channex: "channex-secret" },
          modes: { channex: "mutating" },
          store,
          now: () => fixedNow,
        },
      });
      const payload = channexNonBookingPayload(event);

      const first = await postChannexPayload(app, payload);
      const replay = await postChannexPayload(app, payload);

      expect(first.json()).toMatchObject({ status: "promoted" });
      expect(replay.json()).toMatchObject({ status: "duplicate" });
      expect(store.receipts[0]?.eventType).toBe(event);
      expect(store.receipts[0]?.normalizedPreview).toMatchObject({
        domainEventType: "channex.webhook.received",
        resourceProduct: "platform",
        jobType: "provider.webhook-review",
        payload: { provider: "channex", eventType: event },
      });
      expect(store.jobs[0]?.jobKey).not.toContain("channex.ingest-booking");
      await app.close();
    },
  );

  it.each(["review", "updated_review"] as const)(
    "normalizes Channex %s with a stable provider review identity",
    async (event) => {
      const store = createMemoryProviderWebhookStore();
      const app = buildApp({
        providerWebhooks: {
          secrets: { channex: "channex-secret" },
          modes: { channex: "mutating" },
          store,
          now: () => fixedNow,
        },
      });
      const payload = channexReviewPayload(event);

      await postChannexPayload(app, payload);
      await postChannexPayload(app, payload);

      expect(store.receipts).toHaveLength(1);
      expect(store.receipts[0]?.receiptKey).toBe(
        `webhook:channex:${event}:prop_alpenrose:review_123${
          event === "updated_review" ? ":2026-07-30T20:00:00.000Z" : ""
        }`,
      );
      expect(store.receipts[0]?.normalizedPreview).toMatchObject({
        domainEventKey: `channex.${event}.received:prop_alpenrose:review_123${
          event === "updated_review" ? ":2026-07-30T20:00:00.000Z" : ""
        }:v1`,
        domainEventType: `channex.${event}.received`,
        resourceProduct: "pms",
        resourceType: "channel_review",
        resourceId: "review_123",
        jobType: "channex.review-received",
        payload: {
          provider: "channex",
          eventFamily: event,
          propertyId: "prop_alpenrose",
          reviewId: "review_123",
          reviewRevision: "2026-07-30T20:00:00.000Z",
        },
      });
      expect(store.domainEvents).toHaveLength(1);
      expect(store.jobs).toHaveLength(1);
      await app.close();
    },
  );

  it("promotes distinct updated_review revisions and dedupes an exact replay", async () => {
    const store = createMemoryProviderWebhookStore();
    const app = buildApp({
      providerWebhooks: {
        secrets: { channex: "channex-secret" },
        modes: { channex: "mutating" },
        store,
        now: () => fixedNow,
      },
    });
    const firstVersion = channexReviewPayload("updated_review", "2026-07-30T20:00:00.000Z");
    const secondVersion = channexReviewPayload("updated_review", "2026-07-30T21:00:00.000Z");

    const first = await postChannexPayload(app, firstVersion);
    const second = await postChannexPayload(app, secondVersion);
    const replay = await postChannexPayload(app, secondVersion);

    expect(first.json()).toMatchObject({ status: "promoted" });
    expect(second.json()).toMatchObject({ status: "promoted" });
    expect(replay.json()).toMatchObject({
      status: "duplicate",
      receiptKey:
        "webhook:channex:updated_review:prop_alpenrose:review_123:2026-07-30T21:00:00.000Z",
    });
    expect(store.receipts).toHaveLength(2);
    expect(store.domainEvents).toHaveLength(2);
    expect(store.jobs).toHaveLength(2);
    await app.close();
  });

  it("keeps unknown Channex events in the generic provider-review fallback", async () => {
    const store = createMemoryProviderWebhookStore();
    const app = buildApp({
      providerWebhooks: {
        secrets: { channex: "channex-secret" },
        modes: { channex: "mutating" },
        store,
        now: () => fixedNow,
      },
    });

    await postChannexPayload(app, {
      event: "future_event",
      payload: { property_id: "prop_alpenrose", id: "future_123" },
    });

    expect(store.receipts[0]?.normalizedPreview).toMatchObject({
      domainEventType: "channex.webhook.received",
      resourceProduct: "platform",
      jobType: "provider.webhook-review",
      payload: { eventType: "future_event" },
    });
    await app.close();
  });

  it("rejects duplicate receipt keys when the semantic payload changes", async () => {
    const store = createMemoryProviderWebhookStore();
    const app = buildApp({
      providerWebhooks: {
        secrets: { stripe: "whsec_stripe_test" },
        modes: { stripe: "observe_only" },
        store,
        now: () => fixedNow,
      },
    });
    const first = providerFixture("stripe").payload;
    const changed = {
      ...first,
      data: {
        object: {
          id: "pi_stripe_123",
          amount_received: 99000,
          status: "succeeded",
        },
      },
    };

    const firstResponse = await app.inject({
      method: "POST",
      url: "/webhooks/stripe",
      headers: fixtureHeaders("stripe", first),
      payload: JSON.stringify(first),
    });
    const changedResponse = await app.inject({
      method: "POST",
      url: "/webhooks/stripe",
      headers: fixtureHeaders("stripe", changed),
      payload: JSON.stringify(changed),
    });

    expect(firstResponse.statusCode).toBe(200);
    expect(changedResponse.statusCode).toBe(409);
    expect(changedResponse.json()).toMatchObject({
      error: "provider_webhook_receipt_conflict",
      receiptKey: "webhook:stripe:evt_stripe_pi_succeeded",
    });
    expect(store.receipts).toHaveLength(1);
    expect(store.domainEvents).toHaveLength(0);
    expect(store.jobs).toHaveLength(0);
    await app.close();
  });

  it("promotes an observed receipt exactly once when mutating replay arrives", async () => {
    const store = createMemoryProviderWebhookStore();
    const observedApp = buildApp({
      providerWebhooks: {
        secrets: { stripe: "whsec_stripe_test" },
        modes: { stripe: "observe_only" },
        store,
        now: () => fixedNow,
      },
    });

    await postProviderFixture(observedApp, "stripe");
    await observedApp.close();

    const mutatingApp = buildApp({
      providerWebhooks: {
        secrets: { stripe: "whsec_stripe_test" },
        modes: { stripe: "mutating" },
        store,
        now: () => fixedNow,
      },
    });

    const firstReplay = await postProviderFixture(mutatingApp, "stripe");
    const secondReplay = await postProviderFixture(mutatingApp, "stripe");

    expect(firstReplay.json()).toMatchObject({ status: "promoted" });
    expect(secondReplay.json()).toMatchObject({ status: "duplicate" });
    expect(store.receipts).toHaveLength(1);
    expect(store.receipts[0]!.lifecycleStatus).toBe("promoted");
    expect(store.domainEvents).toHaveLength(1);
    expect(store.jobs).toHaveLength(1);
    await mutatingApp.close();
  });

  it("runs promotion for normalized duplicate receipts in mutating mode", async () => {
    const store = createMemoryProviderWebhookStore();
    const observedApp = buildApp({
      providerWebhooks: {
        secrets: { stripe: "whsec_stripe_test" },
        modes: { stripe: "observe_only" },
        store,
        now: () => fixedNow,
      },
    });

    await postProviderFixture(observedApp, "stripe");
    await observedApp.close();
    store.receipts[0]!.lifecycleStatus = "normalized";

    const mutatingApp = buildApp({
      providerWebhooks: {
        secrets: { stripe: "whsec_stripe_test" },
        modes: { stripe: "mutating" },
        store,
        now: () => fixedNow,
      },
    });

    const response = await postProviderFixture(mutatingApp, "stripe");

    expect(response.json()).toMatchObject({ status: "already_normalized" });
    expect(store.receipts).toHaveLength(1);
    expect(store.receipts[0]!.lifecycleStatus).toBe("normalized");
    expect(store.domainEvents).toHaveLength(1);
    expect(store.jobs).toHaveLength(1);
    await mutatingApp.close();
  });

  it("normalizes Stripe subscription lifecycle events into the durable Finance queue", async () => {
    const store = createMemoryProviderWebhookStore();
    const app = buildApp({
      providerWebhooks: {
        secrets: { stripe: "whsec_stripe_test" },
        modes: { stripe: "mutating" },
        store,
        now: () => fixedNow,
      },
    });
    const checkout = {
      id: "evt_checkout_fixed",
      type: "checkout.session.completed",
      created: 1_786_363_200,
      data: {
        object: {
          id: "cs_fixed",
          subscription: "sub_fixed",
          customer: "cus_fixed",
          client_reference_id: "property-1",
          metadata: {
            vayada_property_id: "property-1",
            vayada_organization_id: "organization-1",
          },
        },
      },
    };
    const invoicePaid = {
      id: "evt_invoice_paid_fixed",
      type: "invoice.paid",
      data: {
        object: {
          id: "in_fixed",
          customer: "cus_fixed",
          parent: {
            subscription_details: {
              subscription: "sub_fixed",
              metadata: {
                vayada_property_id: "property-1",
                vayada_organization_id: "organization-1",
              },
            },
          },
        },
      },
    };

    await postProviderPayload(app, "stripe", checkout);
    await postProviderPayload(app, "stripe", invoicePaid);

    expect(store.receipts.map((receipt) => receipt.normalizedPreview)).toMatchObject([
      {
        resourceProduct: "finance",
        queueName: "finance.subscriptions",
        jobType: "finance.subscription-webhook",
        payload: {
          eventType: "checkout.session.completed",
          subscriptionId: "sub_fixed",
          checkoutSessionId: "cs_fixed",
          propertyId: "property-1",
          organizationId: "organization-1",
        },
      },
      {
        resourceProduct: "finance",
        queueName: "finance.subscriptions",
        jobType: "finance.subscription-webhook",
        payload: {
          eventType: "invoice.paid",
          eventCreated: Math.floor(fixedNow.getTime() / 1_000),
          subscriptionId: "sub_fixed",
          propertyId: "property-1",
          organizationId: "organization-1",
        },
      },
    ]);
    expect(store.jobs.map((job) => job.jobKey)).toEqual([
      "finance.subscription-webhook:stripe:evt_checkout_fixed:v1",
      "finance.subscription-webhook:stripe:evt_invoice_paid_fixed:v1",
    ]);
    await app.close();
  });
});

type MemoryProviderWebhookStore = ProviderWebhookStore & {
  receipts: Array<
    ProviderWebhookReceiptInput & {
      receiptId: string;
      lifecycleStatus: ProviderWebhookReceiptLifecycleStatus;
    }
  >;
  domainEvents: Array<{
    domainEventId: string;
    domainEventKey: string;
    domainEventType: string;
    resourceId: string;
    payload: Record<string, unknown>;
  }>;
  jobs: Array<{ jobId: string; jobKey: string }>;
  auditEvents: Array<{
    auditEventId: string;
    auditKey: string;
    action: string;
    receiptId: string;
    jobId: string;
  }>;
  idempotencyKeys: string[];
};

function createMemoryProviderWebhookStore(): MemoryProviderWebhookStore {
  const receipts: MemoryProviderWebhookStore["receipts"] = [];
  const domainEvents: MemoryProviderWebhookStore["domainEvents"] = [];
  const jobs: MemoryProviderWebhookStore["jobs"] = [];
  const auditEvents: MemoryProviderWebhookStore["auditEvents"] = [];
  const idempotencyKeys: string[] = [];

  return {
    receipts,
    domainEvents,
    jobs,
    auditEvents,
    idempotencyKeys,
    async recordReceipt(input) {
      const existing = receipts.find((receipt) => receipt.receiptKey === input.receiptKey);
      if (existing) {
        if (existing.payloadHash !== input.payloadHash) {
          return {
            status: "conflict",
            receiptId: existing.receiptId,
            lifecycleStatus: existing.lifecycleStatus,
          };
        }
        idempotencyKeys.push(input.receiptKey);
        return {
          status: "duplicate",
          receiptId: existing.receiptId,
          lifecycleStatus: existing.lifecycleStatus,
        };
      }
      const receiptId = `receipt_${receipts.length + 1}`;
      receipts.push({ ...input, receiptId, lifecycleStatus: "observed" });
      idempotencyKeys.push(input.receiptKey);
      return { status: "inserted", receiptId, lifecycleStatus: "observed" };
    },
    async promoteReceipt(input: ProviderWebhookPromotionInput) {
      const receipt = receipts.find((candidate) => candidate.receiptId === input.receiptId);
      if (!receipt) throw new Error(`Unknown receipt ${input.receiptId}`);
      const existingEvent = domainEvents.find(
        (event) => event.domainEventKey === input.normalizedPreview.domainEventKey,
      );
      const existingJob = jobs.find((job) => job.jobKey === input.normalizedPreview.jobKey);
      const domainEventId = existingEvent?.domainEventId ?? `event_${domainEvents.length + 1}`;
      if (!existingEvent) {
        domainEvents.push({
          domainEventId,
          domainEventKey: input.normalizedPreview.domainEventKey,
          domainEventType: input.normalizedPreview.domainEventType,
          resourceId: input.normalizedPreview.resourceId,
          payload: input.normalizedPreview.payload,
        });
      }
      const jobId = existingJob?.jobId ?? `job_${jobs.length + 1}`;
      if (!existingJob) {
        jobs.push({ jobId, jobKey: input.normalizedPreview.jobKey });
      }
      const existingAudit = auditEvents.find(
        (event) => event.auditKey === input.normalizedPreview.domainEventKey,
      );
      const auditEventId = existingAudit?.auditEventId ?? `audit_${auditEvents.length + 1}`;
      if (!existingAudit && input.normalizedPreview.resourceProduct === "finance") {
        auditEvents.push({
          auditEventId,
          auditKey: input.normalizedPreview.domainEventKey,
          action: input.normalizedPreview.domainEventType,
          receiptId: input.receiptId,
          jobId,
        });
      }

      if (receipt.lifecycleStatus !== "observed") {
        return {
          status: promotionStatusForReceipt(receipt.lifecycleStatus),
          receiptId: input.receiptId,
          domainEventId,
          jobIds: [jobId],
          auditEventIds:
            input.normalizedPreview.resourceProduct === "finance" ? [auditEventId] : [],
        };
      }

      idempotencyKeys.push(input.normalizedPreview.domainEventKey);
      idempotencyKeys.push(input.normalizedPreview.jobKey);
      receipt.lifecycleStatus = "promoted";
      return {
        status: "promoted",
        receiptId: input.receiptId,
        domainEventId,
        jobIds: [jobId],
        auditEventIds: input.normalizedPreview.resourceProduct === "finance" ? [auditEventId] : [],
      };
    },
  };
}

function promotionStatusForReceipt(
  status: ProviderWebhookReceiptLifecycleStatus,
): Awaited<ReturnType<ProviderWebhookStore["promoteReceipt"]>>["status"] {
  switch (status) {
    case "promoted":
      return "already_promoted";
    case "normalized":
      return "already_normalized";
    case "failed":
      return "failed";
    case "dead_lettered":
      return "dead_lettered";
    default:
      return "incompatible_terminal_state";
  }
}

async function postProviderFixture(
  app: ReturnType<typeof buildApp>,
  provider: "stripe" | "xendit" | "channex",
  options: { invalidAuth?: boolean } = {},
) {
  const fixture = providerFixture(provider);
  return app.inject({
    method: "POST",
    url: `/webhooks/${provider}`,
    headers: fixtureHeaders(provider, fixture.payload, options.invalidAuth),
    payload: JSON.stringify(fixture.payload),
  });
}

async function postChannexPayload(
  app: ReturnType<typeof buildApp>,
  payload: Record<string, unknown>,
) {
  return app.inject({
    method: "POST",
    url: "/webhooks/channex",
    headers: fixtureHeaders("channex", payload),
    payload: JSON.stringify(payload),
  });
}

async function postProviderPayload(
  app: ReturnType<typeof buildApp>,
  provider: "stripe" | "xendit",
  payload: Record<string, unknown>,
) {
  return app.inject({
    method: "POST",
    url: `/webhooks/${provider}`,
    headers: fixtureHeaders(provider, payload),
    payload: JSON.stringify(payload),
  });
}

function channexMessagePayload(input: {
  propertyId: string;
  sourceMessageId: string;
  threadId: string;
}): Record<string, unknown> {
  return {
    event: "message",
    payload: {
      property_id: input.propertyId,
      id: input.sourceMessageId,
      message_thread_id: input.threadId,
      body: "Inbound guest message",
    },
  };
}

function channexBookingRevisionPayload(input: {
  propertyId: string;
  bookingRevisionId: string;
  channelBookingId: string;
  revision: string;
}): Record<string, unknown> {
  return {
    event: "booking.modified",
    payload: {
      property_id: input.propertyId,
      booking_revision_id: input.bookingRevisionId,
      channel_booking_id: input.channelBookingId,
      revision: input.revision,
      booking: {
        id: input.channelBookingId,
        revision_id: input.bookingRevisionId,
      },
    },
  };
}

function channexNonBookingPayload(
  event: "inquiry" | "reservation_request",
): Record<string, unknown> {
  return {
    event,
    payload: {
      property_id: "prop_alpenrose",
      id: `${event}_123`,
      booking_id: "must_not_be_ingested",
      booking_revision_id: "must_not_be_a_revision",
      revision: "7",
    },
  };
}

function channexReviewPayload(
  event: "review" | "updated_review",
  updatedAt = "2026-07-30T20:00:00.000Z",
): Record<string, unknown> {
  return {
    event,
    property_id: "prop_alpenrose",
    timestamp: updatedAt,
    payload: {
      id: "review_123",
      overall_score: 5,
      content: "Sanitized review fixture",
      reply: "Thank you for staying with us.",
      ota: "BookingCom",
      reviewer_name: "Ada Guest",
      received_at: "2026-07-29T20:00:00.000Z",
    },
  };
}

function providerFixture(provider: "stripe" | "xendit" | "channex"): {
  payload: Record<string, unknown>;
} {
  switch (provider) {
    case "stripe":
      return {
        payload: {
          id: "evt_stripe_pi_succeeded",
          type: "payment_intent.succeeded",
          data: {
            object: {
              id: "pi_stripe_123",
              amount_received: 42000,
              status: "succeeded",
            },
          },
        },
      };
    case "xendit":
      return {
        payload: {
          id: "inv_xendit_paid",
          external_id: "booking_123",
          status: "PAID",
          paid_amount: 42000,
        },
      };
    case "channex":
      return {
        payload: {
          event: "message",
          property_id: "prop_channex_123",
          payload: {
            property_id: "prop_channex_123",
            message_id: "msg_channex_456",
            thread_id: "thread_channex_789",
          },
        },
      };
  }
}

function stripePayoutPayload(): Record<string, unknown> {
  return {
    id: "evt_stripe_payout_paid",
    type: "payout.paid",
    data: {
      object: {
        id: "po_stripe_123",
        object: "payout",
        status: "paid",
        amount: 42000,
      },
    },
  };
}

function xenditInvoicePayload(input: { status: "PAID" | "EXPIRED"; amount: number }) {
  return {
    id: "inv_xendit_stateful",
    external_id: "booking_123",
    status: input.status,
    amount: input.amount,
    paid_amount: input.status === "PAID" ? input.amount : undefined,
  };
}

function xenditPayoutPayload(
  input: {
    event: "payout.succeeded" | "payout.failed" | "payout.reversed";
    payoutId: string;
    status?: "SUCCEEDED" | "FAILED" | "REVERSED";
  } = {
    event: "payout.succeeded",
    payoutId: "po_xendit_123",
    status: "SUCCEEDED",
  },
): Record<string, unknown> {
  return {
    event: input.event,
    data: {
      id: input.payoutId,
      ...(input.status ? { status: input.status } : {}),
      amount: 42000,
    },
  };
}

function fixtureHeaders(
  provider: "stripe" | "xendit" | "channex",
  payload: Record<string, unknown>,
  invalidAuth = false,
): Record<string, string> {
  switch (provider) {
    case "stripe": {
      const timestamp = Math.floor(fixedNow.getTime() / 1000);
      const secret = invalidAuth ? "wrong-secret" : "whsec_stripe_test";
      const signature = createHmac("sha256", secret)
        .update(`${timestamp}.${JSON.stringify(payload)}`)
        .digest("hex");
      return {
        "content-type": "application/json",
        "stripe-signature": `t=${timestamp},v1=${signature}`,
      };
    }
    case "xendit":
      return {
        "content-type": "application/json",
        "x-callback-token": invalidAuth ? "wrong-secret" : "xendit-secret",
      };
    case "channex":
      return {
        "content-type": "application/json",
        "x-vayada-webhook-token": invalidAuth ? "wrong-secret" : "channex-secret",
      };
  }
}
