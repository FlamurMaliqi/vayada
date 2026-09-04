import { createHash } from "node:crypto";

import type {
  CreateFixedPlanCheckoutCommand,
  FinanceSubscriptionService,
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
  it("records an explicit Commission choice for onboarding", async () => {
    const fixture = setup();
    const result = await fixture.service.selectCommissionPlan(command());

    expect(result).toMatchObject({
      ok: true,
      status: "created",
      value: { planStatus: { plan: "commission", status: "commission" } },
    });
    expect(await fixture.store.findReplay("select-commission", command())).toMatchObject({
      result: { planStatus: { plan: "commission" } },
    });
    expect(fixture.afterPlanChange).toHaveBeenCalledWith("property-1");
  });

  it("retries publication after a committed Commission selection", async () => {
    const fixture = setup();
    fixture.afterPlanChange.mockRejectedValueOnce(new Error("projection unavailable"));

    await expect(fixture.service.selectCommissionPlan(command())).rejects.toThrow(
      "projection unavailable",
    );
    await expect(fixture.service.selectCommissionPlan(command())).resolves.toMatchObject({
      ok: true,
      status: "idempotent_replay",
    });
    expect(fixture.afterPlanChange).toHaveBeenCalledTimes(2);
  });

  it("expires a pending Fixed checkout before selecting Commission", async () => {
    const fixture = setup();
    await fixture.service.createFixedPlanCheckout(command("checkout-command"));

    const result = await fixture.service.selectCommissionPlan(command("commission-command"));

    expect(result).toMatchObject({ ok: true, value: { planStatus: { plan: "commission" } } });
    expect(fixture.stripe.expireFixedPlanCheckout).toHaveBeenCalledWith({
      checkoutSessionId: "cs_fixed",
      idempotencyKey: "fixed-plan-expire:cs_fixed:v1",
    });
  });

  it("does not select Commission when a pending Fixed checkout cannot be expired", async () => {
    const fixture = setup();
    await fixture.service.createFixedPlanCheckout(command("checkout-command"));
    fixture.stripe.expireFixedPlanCheckout.mockRejectedValueOnce(new Error("Stripe unavailable"));

    await expect(
      fixture.service.selectCommissionPlan(command("commission-command")),
    ).resolves.toMatchObject({ ok: false, code: "stripe_unavailable" });
    expect(fixture.store.entitlement.checkoutSessionRef).toBe("cs_fixed");
  });

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
        idempotencyKey: providerKey("idempotency-command-1"),
      }),
    );
    await expect(fixture.service.getPlanStatus("property-1")).resolves.toMatchObject({
      plan: "commission",
      status: "checkout_pending",
      checkoutPending: true,
    });
    expect(fixture.afterPlanChange).toHaveBeenCalledWith("property-1");
  });

  it("replays the same checkout command without opening a second Stripe Checkout", async () => {
    const fixture = setup({ activeRoomCount: 2 });
    const first = await fixture.service.createFixedPlanCheckout(command());
    const replay = await fixture.service.createFixedPlanCheckout(command());
    expect(first).toMatchObject({ ok: true, status: "created" });
    expect(replay).toMatchObject({ ok: true, status: "idempotent_replay" });
    expect(fixture.stripe.createFixedPlanCheckout).toHaveBeenCalledTimes(1);
  });

  it("retries publication after a committed Fixed checkout", async () => {
    const fixture = setup();
    fixture.afterPlanChange.mockRejectedValueOnce(new Error("projection unavailable"));

    await expect(fixture.service.createFixedPlanCheckout(command())).resolves.toMatchObject({
      ok: false,
    });
    await expect(fixture.service.createFixedPlanCheckout(command())).resolves.toMatchObject({
      ok: true,
      status: "idempotent_replay",
    });
    expect(fixture.stripe.createFixedPlanCheckout).toHaveBeenCalledTimes(1);
    expect(fixture.afterPlanChange).toHaveBeenCalledTimes(2);
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

  it("uses a fresh durable attempt key after the pending window expires", async () => {
    const fixture = setup({ activeRoomCount: 2 });
    await fixture.service.createFixedPlanCheckout(command("command-1"));
    fixture.store.entitlement.updatedAt = "2026-08-09T12:00:00.000Z";
    await fixture.service.createFixedPlanCheckout(command("command-2"));

    expect(fixture.stripe.createFixedPlanCheckout).toHaveBeenLastCalledWith(
      expect.objectContaining({
        idempotencyKey: providerKey("idempotency-command-2"),
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
        idempotencyKey: providerKey("idempotency-command-2"),
      }),
    );
  });

  it("serializes concurrent property attempts onto one live Stripe Checkout", async () => {
    const fixture = setup({ activeRoomCount: 2 });
    await Promise.all([
      fixture.service.createFixedPlanCheckout(command("command-1")),
      fixture.service.createFixedPlanCheckout(command("command-2")),
    ]);

    expect(fixture.stripe.createFixedPlanCheckout).toHaveBeenCalledTimes(1);
    expect(
      fixture.stripe.createFixedPlanCheckout.mock.calls.map(([input]) => input.idempotencyKey),
    ).toEqual([providerKey("idempotency-command-1")]);
  });

  it("serializes Commission selection behind an in-flight Fixed Checkout", async () => {
    const fixture = setup({ activeRoomCount: 2 });
    let markCreateStarted: () => void = () => {};
    let releaseCreate: () => void = () => {};
    const createStarted = new Promise<void>((resolve) => {
      markCreateStarted = resolve;
    });
    const createGate = new Promise<void>((resolve) => {
      releaseCreate = resolve;
    });
    fixture.stripe.createFixedPlanCheckout.mockImplementationOnce(async () => {
      markCreateStarted();
      await createGate;
      return {
        checkoutSessionId: "cs_fixed",
        checkoutUrl: "https://checkout.stripe.test/fixed",
      };
    });

    const fixed = fixture.service.createFixedPlanCheckout(command("fixed-concurrent"));
    await createStarted;
    const commission = fixture.service.selectCommissionPlan(command("commission-concurrent"));
    await Promise.resolve();
    expect(fixture.stripe.expireFixedPlanCheckout).not.toHaveBeenCalled();

    releaseCreate();
    await expect(fixed).resolves.toMatchObject({ ok: true });
    await expect(commission).resolves.toMatchObject({
      ok: true,
      value: { planStatus: { plan: "commission" } },
    });
    expect(fixture.stripe.expireFixedPlanCheckout).toHaveBeenCalledWith({
      checkoutSessionId: "cs_fixed",
      idempotencyKey: "fixed-plan-expire:cs_fixed:v1",
    });
    expect(fixture.store.entitlement.checkoutSessionRef).toBeNull();
  });

  it("does not replay an expired Stripe session after Fixed to Commission to Fixed", async () => {
    const fixture = setup({ activeRoomCount: 2 });
    await fixture.service.createFixedPlanCheckout(command("fixed-attempt-1"));
    await fixture.service.selectCommissionPlan(command("commission-attempt"));
    await fixture.service.createFixedPlanCheckout(command("fixed-attempt-2"));

    expect(fixture.stripe.createFixedPlanCheckout).toHaveBeenCalledTimes(2);
    expect(
      fixture.stripe.createFixedPlanCheckout.mock.calls.map(([input]) => input.idempotencyKey),
    ).toEqual([
      providerKey("idempotency-fixed-attempt-1"),
      providerKey("idempotency-fixed-attempt-2"),
    ]);
  });

  it("hashes long client attempt keys before sending them to Stripe", async () => {
    const fixture = setup();
    const rawKey = `client-${"x".repeat(190)}`;
    const longCommand = command("long-attempt");
    longCommand.idempotencyKey = rawKey;
    await fixture.service.createFixedPlanCheckout(longCommand);

    const providerIdempotencyKey =
      fixture.stripe.createFixedPlanCheckout.mock.calls[0]?.[0].idempotencyKey;
    expect(providerIdempotencyKey).toBe(providerKey(rawKey));
    expect(providerIdempotencyKey).not.toContain(rawKey);
    expect(providerIdempotencyKey!.length).toBeLessThan(255);
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

  it("keeps quarantined legacy Fixed state inert until explicit re-entry", async () => {
    const fixture = setup({ billingStatus: "suspended" });
    fixture.store.entitlement.metadata = {
      legacyPlan: "fixed",
      legacyBillingReferenceSha256: "a".repeat(64),
      providerReentryRequired: true,
    };

    await expect(fixture.service.getPlanStatus("property-1")).resolves.toMatchObject({
      plan: "commission",
      status: "commission",
      customerPortalAvailable: false,
    });
    expect(fixture.stripe.createFixedPlanCheckout).not.toHaveBeenCalled();
    expect(fixture.stripe.expireFixedPlanCheckout).not.toHaveBeenCalled();
    expect(fixture.stripe.cancelAtPeriodEnd).not.toHaveBeenCalled();

    await expect(
      fixture.service.createFixedPlanCheckout(command("migrated-fixed-reentry")),
    ).resolves.toMatchObject({ ok: true, status: "created" });
    expect(fixture.stripe.createFixedPlanCheckout).toHaveBeenCalledTimes(1);
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
    billingStatus?: string;
  } = {},
) {
  const store = new MemoryStore(
    options.planKey ?? "commission",
    options.subscriptionRef ?? null,
    options.billingStatus ?? "active",
  );
  const stripe = {
    createFixedPlanCheckout: vi.fn(
      async (
        _input: Parameters<StripeFinanceSubscriptionProvider["createFixedPlanCheckout"]>[0],
      ) => ({
        checkoutSessionId: "cs_fixed",
        checkoutUrl: "https://checkout.stripe.test/fixed",
      }),
    ),
    expireFixedPlanCheckout: vi.fn(async () => undefined),
    createCustomerPortal: vi.fn(async () => ({ portalUrl: "https://billing.stripe.test/portal" })),
    cancelAtPeriodEnd: vi.fn(async () => subscriptionSnapshot(true)),
    retrieveSubscription: vi.fn(async () => subscriptionSnapshot(false)),
    updateRoomQuantity: vi.fn(async () => subscriptionSnapshot(false)),
  } satisfies StripeFinanceSubscriptionProvider;
  const afterPlanChange = vi.fn(async () => undefined);
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
    afterPlanChange,
  });
  return { service, store, stripe, afterPlanChange };
}

class MemoryStore implements FinanceSubscriptionStore {
  entitlement: FinanceSubscriptionEntitlementRow;
  private replay = new Map<string, unknown>();
  private checkoutLock = Promise.resolve();

  constructor(
    planKey: "commission" | "fixed",
    subscriptionRef: string | null,
    billingStatus: string,
  ) {
    this.entitlement = {
      organizationId: "organization-1",
      propertyId: "property-1",
      planKey,
      billingStatus,
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

  async withPlanMutationLock<T>(
    _propertyId: string,
    action: (store: FinanceSubscriptionStore) => Promise<T>,
  ): Promise<T> {
    const previous = this.checkoutLock;
    let release: () => void = () => {};
    this.checkoutLock = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await action(this);
    } finally {
      release();
    }
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

  async recordCommissionSelection(
    value: { idempotencyKey: string },
    result: { planStatus: Awaited<ReturnType<FinanceSubscriptionService["getPlanStatus"]>> },
  ) {
    this.replay.set(`select-commission:${value.idempotencyKey}`, result);
    this.entitlement.planKey = "commission";
    this.entitlement.checkoutSessionRef = null;
    this.entitlement.providerSubscriptionStatus = null;
    this.entitlement.updatedAt = result.planStatus.updatedAt;
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

function providerKey(attemptIdempotencyKey: string): string {
  const hash = createHash("sha256").update(attemptIdempotencyKey).digest("hex");
  return `fixed-plan-checkout:property-1:${hash}:v1`;
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
