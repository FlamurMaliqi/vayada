import { describe, expect, it, vi } from "vitest";

import {
  coordinateStripeRefresh,
  markStripeOnboardingStarted,
  refreshStripeAfterOnboarding,
  STRIPE_RECONCILIATION_ATTEMPTS,
  watchStripeOnboardingRefresh,
} from "./stripeOnboardingRefresh";

describe("refreshStripeAfterOnboarding", () => {
  it("stops when readiness is canonical and reloads settings once", async () => {
    const readiness = [false, false, true];
    const reconcile = vi.fn(async () => ({
      providerAccount: { ready: readiness.shift() ?? false },
    }));
    const wait = vi.fn(async () => undefined);
    const loadPaymentSettings = vi.fn(async () => ({ status: "active" }));

    await expect(
      refreshStripeAfterOnboarding(new AbortController().signal, {
        reconcile,
        wait,
        loadPaymentSettings,
      }),
    ).resolves.toEqual({ status: "active" });
    expect(reconcile).toHaveBeenCalledTimes(3);
    expect(wait).toHaveBeenCalledTimes(2);
    expect(loadPaymentSettings).toHaveBeenCalledOnce();
  });

  it("bounds pending reconciliation before reloading canonical settings", async () => {
    const reconcile = vi.fn(async () => ({ providerAccount: { ready: false } }));
    const wait = vi.fn(async () => undefined);
    const loadPaymentSettings = vi.fn(async () => ({ status: "setup_incomplete" }));

    await refreshStripeAfterOnboarding(new AbortController().signal, {
      reconcile,
      wait,
      loadPaymentSettings,
    });

    expect(reconcile).toHaveBeenCalledTimes(STRIPE_RECONCILIATION_ATTEMPTS);
    expect(wait).toHaveBeenCalledTimes(STRIPE_RECONCILIATION_ATTEMPTS - 1);
    expect(loadPaymentSettings).toHaveBeenCalledOnce();
  });

  it("makes a window that loses the property lock reload without another reconciliation", async () => {
    const reload = vi.fn(async () => "reloaded");
    const run = vi.fn(async () => "duplicate");
    const request = vi
      .fn()
      .mockImplementationOnce(
        async (_name: string, _options: LockOptions, callback: (lock: Lock | null) => unknown) =>
          callback(null),
      )
      .mockImplementationOnce(
        async (_name: string, _options: LockOptions, callback: (lock: Lock | null) => unknown) =>
          callback({ name: "stripe-refresh", mode: "exclusive" } as Lock),
      );

    await expect(
      coordinateStripeRefresh(
        {
          propertyId: "property-1",
          signal: new AbortController().signal,
          locks: { request } as unknown as Pick<LockManager, "request">,
        },
        run,
        reload,
      ),
    ).resolves.toBe("reloaded");
    expect(run).not.toHaveBeenCalled();
    expect(reload).toHaveBeenCalledOnce();
  });

  it("leaves a tombstone so concurrent and late windows reload instead of reconciling", async () => {
    const store = markerStore();
    const winner = focusTarget();
    const concurrent = focusTarget();
    const releaseWinner = deferred<boolean>();
    markStripeOnboardingStarted("property-1", store);
    const reconcile = vi.fn(async (_flowId: string, mode: "reconcile" | "reload") => {
      expect(mode).toBe("reconcile");
      return releaseWinner.promise;
    });
    const stopWinner = watchStripeOnboardingRefresh({
      propertyId: "property-1",
      isStripeReturn: true,
      target: winner,
      store,
      onRefresh: reconcile,
    });
    await vi.waitFor(() => expect(reconcile).toHaveBeenCalledOnce());

    const reload = vi.fn(async (_flowId: string, mode: "reconcile" | "reload") => {
      expect(mode).toBe("reload");
      return true;
    });
    const stopConcurrent = watchStripeOnboardingRefresh({
      propertyId: "property-1",
      isStripeReturn: false,
      target: concurrent,
      store,
      onRefresh: reload,
    });
    concurrent.focus();
    await vi.waitFor(() => expect(reload).toHaveBeenCalledOnce());
    expect(reconcile).toHaveBeenCalledOnce();

    releaseWinner.resolve(true);
    await vi.waitFor(() => expect(store.value()).toMatch(/^settled:/));
    const late = vi.fn(async (_flowId: string, mode: "reconcile" | "reload") => {
      expect(mode).toBe("reload");
      return true;
    });
    const stopLate = watchStripeOnboardingRefresh({
      propertyId: "property-1",
      isStripeReturn: true,
      target: focusTarget(),
      store,
      onRefresh: late,
    });
    await vi.waitFor(() => expect(late).toHaveBeenCalledOnce());
    expect(reconcile).toHaveBeenCalledOnce();

    stopWinner();
    stopConcurrent();
    stopLate();
  });

  it("handles a newly marked onboarding flow in the same original window", async () => {
    const store = markerStore();
    const target = focusTarget();
    const refresh = vi.fn(async (flowId: string, mode: "reconcile" | "reload") => {
      void flowId;
      void mode;
      return true;
    });
    const stop = watchStripeOnboardingRefresh({
      propertyId: "property-1",
      isStripeReturn: false,
      target,
      store,
      onRefresh: refresh,
    });

    markStripeOnboardingStarted("property-1", store);
    target.focus();
    await vi.waitFor(() => expect(refresh).toHaveBeenCalledTimes(1));
    await vi.waitFor(() => expect(store.value()).toMatch(/^settled:/));
    markStripeOnboardingStarted("property-1", store);
    target.focus();
    await vi.waitFor(() => expect(refresh).toHaveBeenCalledTimes(2));

    expect(refresh.mock.calls[0]?.[0]).not.toBe(refresh.mock.calls[1]?.[0]);
    expect(refresh.mock.calls.map((call) => call[1])).toEqual(["reconcile", "reconcile"]);
    stop();
  });

  it.each([
    { result: "returns false", firstRefresh: async () => false },
    {
      result: "rejects",
      firstRefresh: async () => {
        throw new Error("Finance unavailable");
      },
    },
  ])("restores and retries a marked flow when refresh $result", async ({ firstRefresh }) => {
    const store = markerStore();
    const target = focusTarget();
    const refresh = vi.fn().mockImplementationOnce(firstRefresh).mockResolvedValueOnce(true);
    markStripeOnboardingStarted("property-1", store);
    const stop = watchStripeOnboardingRefresh({
      propertyId: "property-1",
      isStripeReturn: false,
      target,
      store,
      onRefresh: refresh,
    });

    target.focus();
    await vi.waitFor(() => expect(refresh).toHaveBeenCalledTimes(1));
    await vi.waitFor(() => expect(store.value()).toMatch(/^stripe-onboarding-/));
    target.focus();
    await vi.waitFor(() => expect(refresh).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(store.value()).toMatch(/^settled:/));

    stop();
  });
});

function markerStore() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
    value: () => Array.from(values.values())[0] ?? null,
  };
}

function focusTarget() {
  const listeners = new Set<() => void>();
  return {
    addEventListener: (_type: "focus", listener: () => void) => listeners.add(listener),
    removeEventListener: (_type: "focus", listener: () => void) => listeners.delete(listener),
    focus: () => listeners.forEach((listener) => listener()),
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolver) => {
    resolve = resolver;
  });
  return { promise, resolve };
}
