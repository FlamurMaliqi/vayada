import { createHash } from "node:crypto";

import type {
  StripeFinanceSubscriptionProvider,
  StripeSubscriptionSnapshot,
} from "@vayada/domain-finance";
import { describe, expect, it, vi } from "vitest";

import {
  createPgFinanceSubscriptionWebhookStore,
  processFinanceSubscriptionWebhook,
  runFinanceSubscriptionNotificationJobs,
  type FinanceSubscriptionWebhookEntitlement,
  type FinanceSubscriptionWebhookPayload,
  type FinanceSubscriptionWebhookStore,
} from "./financeSubscriptions.js";

describe("Finance subscription webhook lifecycle", () => {
  it("links a completed Checkout without activating Fixed before invoice payment", async () => {
    const fixture = setup("commission");
    await expect(
      processFinanceSubscriptionWebhook(
        payload("checkout.session.completed", 10),
        fixture.dependencies,
      ),
    ).resolves.toBe("applied");
    expect(fixture.store.entitlement.planKey).toBe("commission");
    expect(fixture.store.entitlement.subscriptionRef).toBe("sub_fixed");
  });

  it("activates Fixed only after an active subscription invoice is paid", async () => {
    const fixture = setup("commission");
    await processFinanceSubscriptionWebhook(
      payload("checkout.session.completed", 19),
      fixture.dependencies,
    );
    await processFinanceSubscriptionWebhook(payload("invoice.paid", 20), fixture.dependencies);
    expect(fixture.store.entitlement.planKey).toBe("fixed");
  });

  it("ignores delayed lifecycle events after a newer event was applied", async () => {
    const fixture = setup("commission");
    await processFinanceSubscriptionWebhook(
      payload("checkout.session.completed", 25),
      fixture.dependencies,
    );
    await processFinanceSubscriptionWebhook(payload("invoice.paid", 30), fixture.dependencies);
    fixture.provider.snapshot.status = "canceled";
    await expect(
      processFinanceSubscriptionWebhook(
        payload("customer.subscription.deleted", 29),
        fixture.dependencies,
      ),
    ).resolves.toBe("ignored_stale");
    expect(fixture.store.entitlement.planKey).toBe("fixed");
  });

  it("retains Fixed on recurring payment failure and enqueues one durable notification", async () => {
    const fixture = setup("fixed");
    fixture.provider.snapshot.status = "past_due";
    const event = payload("invoice.payment_failed", 40);
    await processFinanceSubscriptionWebhook(event, fixture.dependencies);
    await processFinanceSubscriptionWebhook(event, fixture.dependencies);
    expect(fixture.store.entitlement.planKey).toBe("fixed");
    expect(fixture.store.notificationCount).toBe(1);
  });

  it("rejects an invoice that is not linked to the entitlement subscription", async () => {
    const fixture = setup("fixed");
    fixture.store.entitlement.subscriptionRef = "sub_other";
    await expect(
      processFinanceSubscriptionWebhook(payload("invoice.paid", 41), fixture.dependencies),
    ).rejects.toThrow("not linked");
  });

  it("rejects a subscription that does not verify as the configured Fixed Plan", async () => {
    const fixture = setup("fixed");
    fixture.provider.snapshot.fixedPlanVerified = false;
    await expect(
      processFinanceSubscriptionWebhook(payload("invoice.paid", 42), fixture.dependencies),
    ).rejects.toThrow("configured Vayada Fixed Plan");
  });

  it("updates next-invoice room quantity without proration and reverts at subscription end", async () => {
    const fixture = setup("fixed");
    await processFinanceSubscriptionWebhook(payload("invoice.upcoming", 50), fixture.dependencies);
    expect(fixture.provider.updateRoomQuantity).toHaveBeenCalledWith({
      subscriptionId: "sub_fixed",
      subscriptionItemId: "si_fixed",
      activeRoomCount: 4,
      idempotencyKey: "room-quantity:evt_50",
    });
    expect(fixture.store.entitlement.activeRoomCount).toBe(4);

    fixture.provider.snapshot.status = "canceled";
    await processFinanceSubscriptionWebhook(
      payload("customer.subscription.deleted", 60),
      fixture.dependencies,
    );
    expect(fixture.store.entitlement.planKey).toBe("commission");
  });

  it("stores a real SHA-256 digest for internal notification idempotency", async () => {
    const query = vi.fn().mockResolvedValue({ rows: [{ id: "job-1" }] });
    const store = createPgFinanceSubscriptionWebhookStore({ query } as never);
    const event = payload("invoice.payment_failed", 70);

    await store.enqueuePaymentFailureNotification({
      payload: event,
      entitlement: {
        organizationId: "11111111-1111-4111-8111-111111111111",
        propertyId: "22222222-2222-4222-8222-222222222222",
        planKey: "fixed",
        subscriptionRef: "sub_fixed",
        checkoutSessionRef: "cs_fixed",
        activeRoomCount: 2,
      },
      snapshot: {
        subscriptionId: "sub_fixed",
        customerId: "cus_fixed",
        status: "past_due",
        propertyId: "property-1",
        organizationId: "11111111-1111-4111-8111-111111111111",
        fixedPlanVerified: true,
        currentPeriodStart: "2026-08-11T12:00:00.000Z",
        currentPeriodEnd: "2026-09-10T12:00:00.000Z",
        cancelAtPeriodEnd: false,
        subscriptionItemId: "si_fixed",
      },
    });

    expect(query.mock.calls[0]?.[1]?.[5]).toBe(
      `sha256:${createHash("sha256").update(event.rawEventId).digest("hex")}`,
    );
  });

  it("scopes entitlement lookup and lifecycle updates to the exact Finance entitlement", async () => {
    const query = vi.fn().mockResolvedValue({ rows: [] });
    const store = createPgFinanceSubscriptionWebhookStore({ query } as never);
    const event = payload("invoice.paid", 71);
    const snapshot = verifiedSnapshot();

    await store.findEntitlement(event);
    await store.applySubscriptionSnapshot({
      payload: event,
      snapshot,
      transition: "paid",
      activeRoomCount: 2,
    });

    const lookupSql = String(query.mock.calls[0]?.[0]);
    const updateSql = String(query.mock.calls[1]?.[0]);
    expect(lookupSql).toContain("entitlement.product = 'booking'");
    expect(lookupSql).toContain("entitlement.entitlement_key = 'direct-booking-finance'");
    expect(updateSql).toContain("entitlement.billing_subscription_ref = $1");
    expect(updateSql).not.toContain("OR ($2::text IS NOT NULL");
    expect(updateSql).toContain("entitlement.product = 'booking'");
  });

  it("delivers durable notifications and marks failed deliveries for retry or dead-letter", async () => {
    const notification = {
      eventId: "evt_notification",
      propertyId: "property-1",
      organizationId: "organization-1",
      subscriptionId: "sub_fixed",
    };
    const successQuery = vi
      .fn()
      .mockResolvedValueOnce({ rows: [{ id: "job-1", payload: notification }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] });
    const notifyInternal = vi.fn();

    await expect(
      runFinanceSubscriptionNotificationJobs("postgres://unused", notifyInternal, {
        pool: { query: successQuery } as never,
      }),
    ).resolves.toEqual({ processed: 1, failed: 0 });
    expect(notifyInternal).toHaveBeenCalledWith(notification);
    expect(String(successQuery.mock.calls[1]?.[0])).toContain("status = 'succeeded'");

    const failedQuery = vi
      .fn()
      .mockResolvedValueOnce({ rows: [{ id: "job-2", payload: notification }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] });
    await expect(
      runFinanceSubscriptionNotificationJobs(
        "postgres://unused",
        async () => {
          throw new Error("notification unavailable");
        },
        { pool: { query: failedQuery } as never },
      ),
    ).resolves.toEqual({ processed: 0, failed: 1 });
    expect(String(failedQuery.mock.calls[1]?.[0])).toContain("dead_lettered");
    expect(failedQuery.mock.calls[1]?.[1]?.[1]).toBe("notification unavailable");
  });
});

function setup(planKey: "commission" | "fixed") {
  const store = new MemoryStore(planKey);
  const snapshot: StripeSubscriptionSnapshot = {
    subscriptionId: "sub_fixed",
    customerId: "cus_fixed",
    status: "active",
    propertyId: "property-1",
    organizationId: "organization-1",
    fixedPlanVerified: true,
    currentPeriodStart: "2026-08-11T12:00:00.000Z",
    currentPeriodEnd: "2026-09-10T12:00:00.000Z",
    cancelAtPeriodEnd: false,
    subscriptionItemId: "si_fixed",
  };
  const provider = {
    snapshot,
    createFixedPlanCheckout: vi.fn(),
    createCustomerPortal: vi.fn(),
    cancelAtPeriodEnd: vi.fn(),
    retrieveSubscription: vi.fn(async () => ({ ...snapshot })),
    updateRoomQuantity: vi.fn(async () => ({ ...snapshot })),
  } satisfies StripeFinanceSubscriptionProvider & { snapshot: StripeSubscriptionSnapshot };
  return {
    store,
    provider,
    dependencies: {
      store,
      stripe: provider,
      roomInventory: {
        getRoomInventorySnapshot: vi.fn(async () => ({
          propertyId: "property-1",
          activeRoomCount: 4,
          capturedAt: "2026-08-11T12:00:00.000Z",
        })),
      },
    },
  };
}

class MemoryStore implements FinanceSubscriptionWebhookStore {
  entitlement: FinanceSubscriptionWebhookEntitlement;
  private lastEventCreated = 0;
  private notificationEvents = new Set<string>();

  get notificationCount() {
    return this.notificationEvents.size;
  }

  constructor(planKey: "commission" | "fixed") {
    this.entitlement = {
      organizationId: "organization-1",
      propertyId: "property-1",
      planKey,
      subscriptionRef: planKey === "fixed" ? "sub_fixed" : null,
      checkoutSessionRef: "cs_fixed",
      activeRoomCount: 2,
    };
  }

  async findEntitlement() {
    return { ...this.entitlement };
  }

  async recordCheckoutCompleted(
    input: Parameters<FinanceSubscriptionWebhookStore["recordCheckoutCompleted"]>[0],
  ) {
    if (!this.accept(input.payload)) return null;
    this.entitlement.subscriptionRef = input.snapshot.subscriptionId;
    return { ...this.entitlement };
  }

  async applySubscriptionSnapshot(
    input: Parameters<FinanceSubscriptionWebhookStore["applySubscriptionSnapshot"]>[0],
  ) {
    if (!this.accept(input.payload)) return null;
    if (input.transition === "paid" && input.snapshot.status === "active") {
      this.entitlement.planKey = "fixed";
    }
    if (
      input.transition === "deleted" &&
      ["canceled", "incomplete_expired"].includes(input.snapshot.status)
    ) {
      this.entitlement.planKey = "commission";
    }
    this.entitlement.subscriptionRef = input.snapshot.subscriptionId;
    this.entitlement.activeRoomCount = input.activeRoomCount;
    return { ...this.entitlement };
  }

  async enqueuePaymentFailureNotification(
    input: Parameters<FinanceSubscriptionWebhookStore["enqueuePaymentFailureNotification"]>[0],
  ) {
    if (this.notificationEvents.has(input.payload.rawEventId)) return false;
    this.notificationEvents.add(input.payload.rawEventId);
    return true;
  }

  private accept(value: FinanceSubscriptionWebhookPayload) {
    if (value.eventCreated < this.lastEventCreated) return false;
    this.lastEventCreated = value.eventCreated;
    return true;
  }
}

function payload(eventType: string, eventCreated: number): FinanceSubscriptionWebhookPayload {
  return {
    provider: "stripe",
    eventType,
    rawEventId: `evt_${eventCreated}`,
    eventCreated,
    objectId: eventType === "checkout.session.completed" ? "cs_fixed" : "in_fixed",
    subscriptionId: "sub_fixed",
    checkoutSessionId: eventType === "checkout.session.completed" ? "cs_fixed" : null,
    propertyId: "property-1",
    organizationId: "organization-1",
    customerId: "cus_fixed",
  };
}

function verifiedSnapshot(): StripeSubscriptionSnapshot {
  return {
    subscriptionId: "sub_fixed",
    customerId: "cus_fixed",
    status: "active",
    propertyId: "property-1",
    organizationId: "organization-1",
    fixedPlanVerified: true,
    currentPeriodStart: "2026-08-11T12:00:00.000Z",
    currentPeriodEnd: "2026-09-10T12:00:00.000Z",
    cancelAtPeriodEnd: false,
    subscriptionItemId: "si_fixed",
  };
}
