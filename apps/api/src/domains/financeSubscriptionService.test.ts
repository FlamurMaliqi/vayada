import type {
  CreateFixedPlanCheckoutCommand,
  StripeFinanceSubscriptionProvider,
  StripeSubscriptionSnapshot,
} from "@vayada/domain-finance";
import { describe, expect, it, vi } from "vitest";

import { createFinanceSubscriptionService } from "./financeSubscriptionService.js";
import type {
  FinanceSubscriptionEntitlementRow,
  FinanceSubscriptionStore,
} from "./financeSubscriptionStore.js";

describe("Finance subscription service", () => {
  it("prices the first room at EUR 30 and additional rooms at EUR 5 without activating Fixed", async () => {
    const fixture = setup({ activeRoomCount: 4 });
    const result = await fixture.service.createFixedPlanCheckout(command());
    expect(result).toMatchObject({
      ok: true,
      status: "created",
      value: { currency: "EUR", amountMinor: 4_500, activeRoomCount: 4 },
    });
    expect(fixture.stripe.createFixedPlanCheckout).toHaveBeenCalledWith(
      expect.objectContaining({
        activeRoomCount: 4,
        successUrl: "https://admin.booking.test/settings?billing=success",
        cancelUrl: "https://admin.booking.test/settings?billing=canceled",
        idempotencyKey: "fixed-plan-checkout:property-1:initial:v1",
      }),
    );
    await expect(fixture.service.getPlanStatus("property-1")).resolves.toMatchObject({
      plan: "commission",
      status: "checkout_pending",
      checkoutPending: true,
    });
  });

  it("replays the same checkout command without opening a second Stripe Checkout", async () => {
    const fixture = setup({ activeRoomCount: 2 });
    const first = await fixture.service.createFixedPlanCheckout(command());
    const replay = await fixture.service.createFixedPlanCheckout(command());
    expect(first).toMatchObject({ ok: true, status: "created" });
    expect(replay).toMatchObject({ ok: true, status: "idempotent_replay" });
    expect(fixture.stripe.createFixedPlanCheckout).toHaveBeenCalledTimes(1);
  });

  it("resumes a pending Checkout for a different command without opening another session", async () => {
    const fixture = setup({ activeRoomCount: 2 });
    await fixture.service.createFixedPlanCheckout(command("command-1"));
    const resumed = await fixture.service.createFixedPlanCheckout(command("command-2"));

    expect(resumed).toMatchObject({
      ok: true,
      status: "idempotent_replay",
      value: {
        checkoutSessionId: "cs_fixed",
        checkoutUrl: "https://checkout.stripe.test/fixed",
      },
    });
    expect(fixture.stripe.createFixedPlanCheckout).toHaveBeenCalledTimes(1);
  });

  it("uses the previous Checkout as the stable Stripe key after the pending window expires", async () => {
    const fixture = setup({ activeRoomCount: 2 });
    await fixture.service.createFixedPlanCheckout(command("command-1"));
    fixture.store.entitlement.updatedAt = "2026-08-09T12:00:00.000Z";
    await fixture.service.createFixedPlanCheckout(command("command-2"));

    expect(fixture.stripe.createFixedPlanCheckout).toHaveBeenLastCalledWith(
      expect.objectContaining({
        idempotencyKey: "fixed-plan-checkout:property-1:cs_fixed:v1",
      }),
    );
  });

  it("replaces a terminal Checkout immediately", async () => {
    const fixture = setup({ activeRoomCount: 2 });
    await fixture.service.createFixedPlanCheckout(command("command-1"));
    fixture.store.entitlement.providerSubscriptionStatus = "incomplete_expired";
    await fixture.service.createFixedPlanCheckout(command("command-2"));

    expect(fixture.stripe.createFixedPlanCheckout).toHaveBeenCalledTimes(2);
    expect(fixture.stripe.createFixedPlanCheckout).toHaveBeenLastCalledWith(
      expect.objectContaining({
        idempotencyKey: "fixed-plan-checkout:property-1:cs_fixed:v1",
      }),
    );
  });

  it("uses one stable Stripe idempotency key for concurrent initial commands", async () => {
    const fixture = setup({ activeRoomCount: 2 });
    await Promise.all([
      fixture.service.createFixedPlanCheckout(command("command-1")),
      fixture.service.createFixedPlanCheckout(command("command-2")),
    ]);

    expect(fixture.stripe.createFixedPlanCheckout).toHaveBeenCalledTimes(2);
    expect(
      fixture.stripe.createFixedPlanCheckout.mock.calls.map(([input]) => input.idempotencyKey),
    ).toEqual([
      "fixed-plan-checkout:property-1:initial:v1",
      "fixed-plan-checkout:property-1:initial:v1",
    ]);
  });

  it("schedules period-end cancellation and keeps Fixed through the paid period", async () => {
    const fixture = setup({ planKey: "fixed", subscriptionRef: "sub_fixed" });
    const result = await fixture.service.scheduleCommissionPlan(command());
    expect(result).toMatchObject({
      ok: true,
      status: "updated",
      value: {
        planStatus: {
          plan: "fixed",
          status: "cancel_at_period_end",
          currentPeriodEnd: "2026-09-10T12:00:00.000Z",
        },
      },
    });
  });

  it("returns a typed service-unavailable error when Stripe is not configured", async () => {
    const fixture = setup({ stripeConfigured: false });
    await expect(fixture.service.createFixedPlanCheckout(command())).resolves.toMatchObject({
      ok: false,
      code: "stripe_not_configured",
      statusCode: 503,
    });
  });
});

function setup(
  options: {
    activeRoomCount?: number;
    planKey?: "commission" | "fixed";
    subscriptionRef?: string | null;
    stripeConfigured?: boolean;
  } = {},
) {
  const store = new MemoryStore(options.planKey ?? "commission", options.subscriptionRef ?? null);
  const stripe = {
    createFixedPlanCheckout: vi.fn(
      async (
        _input: Parameters<StripeFinanceSubscriptionProvider["createFixedPlanCheckout"]>[0],
      ) => ({
        checkoutSessionId: "cs_fixed",
        checkoutUrl: "https://checkout.stripe.test/fixed",
      }),
    ),
    createCustomerPortal: vi.fn(async () => ({ portalUrl: "https://billing.stripe.test/portal" })),
    cancelAtPeriodEnd: vi.fn(async () => subscriptionSnapshot(true)),
    retrieveSubscription: vi.fn(async () => subscriptionSnapshot(false)),
    updateRoomQuantity: vi.fn(async () => subscriptionSnapshot(false)),
  } satisfies StripeFinanceSubscriptionProvider;
  const service = createFinanceSubscriptionService({
    store,
    roomInventory: {
      getRoomInventorySnapshot: vi.fn(async () => ({
        propertyId: "property-1",
        activeRoomCount: options.activeRoomCount ?? 2,
        capturedAt: "2026-08-11T12:00:00.000Z",
      })),
    },
    stripe: options.stripeConfigured === false ? undefined : stripe,
    bookingAdminBaseUrl: "https://admin.booking.test",
    now: () => new Date("2026-08-11T12:00:00.000Z"),
  });
  return { service, store, stripe };
}

class MemoryStore implements FinanceSubscriptionStore {
  entitlement: FinanceSubscriptionEntitlementRow;
  private replay = new Map<string, unknown>();

  constructor(planKey: "commission" | "fixed", subscriptionRef: string | null) {
    this.entitlement = {
      organizationId: "organization-1",
      propertyId: "property-1",
      planKey,
      billingStatus: "active",
      customerRef: planKey === "fixed" ? "cus_fixed" : null,
      subscriptionRef,
      checkoutSessionRef: null,
      providerSubscriptionStatus: planKey === "fixed" ? "active" : null,
      periodStart: planKey === "fixed" ? "2026-08-11T12:00:00.000Z" : null,
      periodEnd: planKey === "fixed" ? "2026-09-10T12:00:00.000Z" : null,
      cancelAtPeriodEnd: false,
      amountMinor: null,
      currency: "EUR",
      activeRoomCount: 2,
      startsAt: planKey === "fixed" ? "2026-08-11T12:00:00.000Z" : null,
      metadata: {},
      updatedAt: "2026-08-11T12:00:00.000Z",
    };
  }

  async getEntitlement() {
    return { ...this.entitlement };
  }

  async findReplay<T>(operation: string, value: { idempotencyKey: string }) {
    const result = this.replay.get(`${operation}:${value.idempotencyKey}`);
    return result ? { result: result as T } : null;
  }

  async recordCheckout(
    value: CreateFixedPlanCheckoutCommand,
    result: Awaited<ReturnType<StripeFinanceSubscriptionProvider["createFixedPlanCheckout"]>> & {
      currency: "EUR";
      amountMinor: number;
      activeRoomCount: number;
    },
  ) {
    this.replay.set(`fixed-plan-checkout:${value.idempotencyKey}`, result);
    this.entitlement.checkoutSessionRef = result.checkoutSessionId;
    this.entitlement.providerSubscriptionStatus = "incomplete";
    this.entitlement.amountMinor = result.amountMinor;
    this.entitlement.activeRoomCount = result.activeRoomCount;
    this.entitlement.metadata = { checkoutUrl: result.checkoutUrl };
    this.entitlement.updatedAt = value.audit.requestedAt;
    return { status: "created" as const, result };
  }

  async recordPortal(value: { idempotencyKey: string }, result: { portalUrl: string }) {
    this.replay.set(`customer-portal:${value.idempotencyKey}`, result);
    return { status: "created" as const, result };
  }

  async recordCancellation(
    value: { idempotencyKey: string },
    snapshot: StripeSubscriptionSnapshot,
  ) {
    this.replay.set(`schedule-commission:${value.idempotencyKey}`, {
      currentPeriodEnd: snapshot.currentPeriodEnd,
    });
    this.entitlement.cancelAtPeriodEnd = true;
    this.entitlement.periodStart = snapshot.currentPeriodStart;
    this.entitlement.periodEnd = snapshot.currentPeriodEnd;
  }

  async close() {}
}

function command(commandId = "command-1"): CreateFixedPlanCheckoutCommand {
  return {
    commandId,
    idempotencyKey: `idempotency-${commandId}`,
    propertyId: "property-1",
    organizationId: "organization-1",
    customerEmail: "host@example.test",
    audit: {
      actor: { kind: "system", service: "test" },
      requestId: "request-1",
      reason: "test",
      requestedAt: "2026-08-11T12:00:00.000Z",
    },
  };
}

function subscriptionSnapshot(cancelAtPeriodEnd: boolean): StripeSubscriptionSnapshot {
  return {
    subscriptionId: "sub_fixed",
    customerId: "cus_fixed",
    status: "active",
    propertyId: "property-1",
    organizationId: "organization-1",
    fixedPlanVerified: true,
    currentPeriodStart: "2026-08-11T12:00:00.000Z",
    currentPeriodEnd: "2026-09-10T12:00:00.000Z",
    cancelAtPeriodEnd,
    subscriptionItemId: "si_fixed",
  };
}
