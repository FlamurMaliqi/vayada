import { afterEach, describe, expect, it, vi } from "vitest";

import {
  coordinateStripeRefresh,
  markStripeOnboardingStarted,
  refreshStripeAfterOnboarding,
  STRIPE_RECONCILIATION_ATTEMPTS,
  STRIPE_RECONCILIATION_DELAY_MS,
  stripeOnboardingPropertyKey,
  tryMarkStripeOnboardingStarted,
  watchStripeOnboardingRefresh,
} from "./stripeOnboardingRefresh";

afterEach(() => {
  vi.useRealTimers();
});

describe("Stripe onboarding refresh lifecycle", () => {
  it("settles an exact-property Stripe return and removes its focus listener", async () => {
    const target = focusTarget();
    const store = markerStore();
    markStripeOnboardingStarted("property-1", store, "flow-1");
    const onRefresh = vi.fn(async () => "settled" as const);

    const cleanup = watchStripeOnboardingRefresh({
      propertyId: "property-1",
      isStripeReturn: true,
      target,
      store,
      onRefresh,
    });
    await vi.waitFor(() => expect(onRefresh).toHaveBeenCalledWith("flow-1", "reconcile"));
    expect(store.getItem(stripeOnboardingPropertyKey("property-1"))).toBe("settled:flow-1");

    target.focus();
    await Promise.resolve();
    expect(onRefresh).toHaveBeenCalledTimes(1);
    cleanup();
    target.focus();
    expect(onRefresh).toHaveBeenCalledTimes(1);
    expect(target.listenerCount()).toBe(0);
  });

  it("ignores markers for other properties on return and focus", async () => {
    const target = focusTarget();
    const store = markerStore();
    markStripeOnboardingStarted("property-2", store, "flow-2");
    const onRefresh = vi.fn(async () => "settled" as const);
    const cleanup = watchStripeOnboardingRefresh({
      propertyId: "property-1",
      isStripeReturn: true,
      target,
      store,
      onRefresh,
    });

    target.focus();
    await Promise.resolve();
    await Promise.resolve();
    expect(onRefresh).not.toHaveBeenCalled();
    expect(store.getItem(stripeOnboardingPropertyKey("property-2"))).toBe("flow-2");
    cleanup();
  });

  it("hands a settled return to the original window as a reload", async () => {
    const originalWindow = focusTarget();
    const returnWindow = focusTarget();
    const store = markerStore();
    markStripeOnboardingStarted("property-1", store, "shared-flow");
    const returnRefresh = vi.fn(async () => "settled" as const);
    const cleanupReturn = watchStripeOnboardingRefresh({
      propertyId: "property-1",
      isStripeReturn: true,
      target: returnWindow,
      store,
      onRefresh: returnRefresh,
    });
    await vi.waitFor(() => expect(returnRefresh).toHaveBeenCalledWith("shared-flow", "reconcile"));
    expect(store.getItem(stripeOnboardingPropertyKey("property-1"))).toBe("settled:shared-flow");

    const originalRefresh = vi.fn(async () => "settled" as const);
    const cleanupOriginal = watchStripeOnboardingRefresh({
      propertyId: "property-1",
      isStripeReturn: false,
      target: originalWindow,
      store,
      onRefresh: originalRefresh,
    });
    originalWindow.focus();
    await vi.waitFor(() => expect(originalRefresh).toHaveBeenCalledWith("shared-flow", "reload"));
    expect(store.getItem(stripeOnboardingPropertyKey("property-1"))).toBeNull();
    cleanupOriginal();
    cleanupReturn();
  });

  it("keeps an aborted popup claim recoverable by the original window", async () => {
    const returnWindow = focusTarget();
    const originalWindow = focusTarget();
    const store = markerStore();
    markStripeOnboardingStarted("property-1", store, "shared-flow");
    let finishReturn!: (outcome: "aborted") => void;
    const returnRefresh = vi.fn(
      () =>
        new Promise<"aborted">((resolve) => {
          finishReturn = resolve;
        }),
    );
    const cleanupReturn = watchStripeOnboardingRefresh({
      propertyId: "property-1",
      isStripeReturn: true,
      target: returnWindow,
      store,
      onRefresh: returnRefresh,
    });
    await vi.waitFor(() => expect(returnRefresh).toHaveBeenCalledTimes(1));

    cleanupReturn();
    finishReturn("aborted");
    await Promise.resolve();
    expect(store.getItem(stripeOnboardingPropertyKey("property-1"))).toBe("shared-flow");

    const originalRefresh = vi.fn(async () => "settled" as const);
    const cleanupOriginal = watchStripeOnboardingRefresh({
      propertyId: "property-1",
      isStripeReturn: false,
      target: originalWindow,
      store,
      onRefresh: originalRefresh,
    });
    originalWindow.focus();
    await vi.waitFor(() =>
      expect(originalRefresh).toHaveBeenCalledWith("shared-flow", "reconcile"),
    );
    expect(store.getItem(stripeOnboardingPropertyKey("property-1"))).toBeNull();
    cleanupOriginal();
  });

  it("does not run a queued refresh after cleanup", async () => {
    const target = focusTarget();
    const store = markerStore();
    markStripeOnboardingStarted("property-1", store, "flow-1");
    const onRefresh = vi.fn(async () => "settled" as const);
    const cleanup = watchStripeOnboardingRefresh({
      propertyId: "property-1",
      isStripeReturn: true,
      target,
      store,
      onRefresh,
    });

    cleanup();
    await Promise.resolve();
    await Promise.resolve();
    expect(onRefresh).not.toHaveBeenCalled();
    expect(store.getItem(stripeOnboardingPropertyKey("property-1"))).toBe("flow-1");
  });

  it("serializes property refreshes and makes the losing window reload without a POST", async () => {
    const locks = fakeLockManager();
    let releaseFirst!: () => void;
    const firstRun = vi.fn(
      () =>
        new Promise<string>((resolve) => {
          releaseFirst = () => resolve("winner");
        }),
    );
    const first = coordinateStripeRefresh(
      {
        propertyId: "property-1",
        signal: new AbortController().signal,
        locks,
      },
      { run: firstRun, reload: async () => "first-reload" },
    );
    await vi.waitFor(() => expect(firstRun).toHaveBeenCalledTimes(1));

    const secondRun = vi.fn(async () => "duplicate");
    const secondReload = vi.fn(async () => "reloaded");
    const second = coordinateStripeRefresh(
      {
        propertyId: "property-1",
        signal: new AbortController().signal,
        locks,
      },
      { run: secondRun, reload: secondReload },
    );
    releaseFirst();

    await expect(first).resolves.toBe("winner");
    await expect(second).resolves.toBe("reloaded");
    expect(secondRun).not.toHaveBeenCalled();
    expect(secondReload).toHaveBeenCalledTimes(1);
  });

  it("uses the shared automatic flow ID when Web Locks are unavailable", async () => {
    const run = vi.fn(async (flowId: string) => flowId);
    const reload = vi.fn(async () => "reloaded");

    await expect(
      coordinateStripeRefresh(
        {
          propertyId: "property-1",
          flowId: "shared-flow",
          signal: new AbortController().signal,
          locks: undefined,
        },
        { run, reload },
      ),
    ).resolves.toBe("shared-flow");
    expect(run).toHaveBeenCalledWith("shared-flow");
    expect(reload).not.toHaveBeenCalled();
  });

  it("runs a manual retry with a fresh flow ID when Web Locks are unavailable", async () => {
    const run = vi.fn(async (flowId: string) => flowId);
    const reload = vi.fn(async () => "reloaded");

    await expect(
      coordinateStripeRefresh(
        {
          propertyId: "property-1",
          signal: new AbortController().signal,
          locks: undefined,
        },
        { run, reload },
      ),
    ).resolves.toMatch(/^stripe-onboarding-/);
    expect(run).toHaveBeenCalledWith(expect.stringMatching(/^stripe-onboarding-/));
    expect(reload).not.toHaveBeenCalled();
  });

  it("rejects when cleanup aborts after a losing window starts its reload", async () => {
    const locks = fakeLockManager();
    let releaseWinner!: () => void;
    const winner = coordinateStripeRefresh(
      {
        propertyId: "property-1",
        signal: new AbortController().signal,
        locks,
      },
      {
        run: () =>
          new Promise<string>((resolve) => {
            releaseWinner = () => resolve("winner");
          }),
        reload: async () => "winner-reload",
      },
    );
    await vi.waitFor(() => expect(releaseWinner).toBeTypeOf("function"));

    const controller = new AbortController();
    let releaseReload!: () => void;
    const losingRun = vi.fn(async () => "duplicate");
    const losingReload = vi.fn(
      () =>
        new Promise<string>((resolve) => {
          releaseReload = () => resolve("reloaded");
        }),
    );
    const loser = coordinateStripeRefresh(
      {
        propertyId: "property-1",
        signal: controller.signal,
        locks,
      },
      { run: losingRun, reload: losingReload },
    );
    releaseWinner();
    await vi.waitFor(() => expect(losingReload).toHaveBeenCalledTimes(1));
    controller.abort();
    releaseReload();

    await expect(winner).resolves.toBe("winner");
    await expect(loser).rejects.toMatchObject({ name: "AbortError" });
    expect(losingRun).not.toHaveBeenCalled();
  });

  it("treats marker storage failures as unavailable tracking", () => {
    const store = {
      getItem: () => null,
      setItem: () => {
        throw new Error("storage disabled");
      },
      removeItem: () => undefined,
    };

    expect(tryMarkStripeOnboardingStarted("property-1", store, "flow-1")).toBeNull();
  });

  it("retries pending readiness to the bound and reloads settings once", async () => {
    const readiness = [false, false, true];
    const reconciliationCalls: Array<[string, number]> = [];
    const reconcile = vi.fn(async (propertyId: string, attempt: number) => {
      reconciliationCalls.push([propertyId, attempt]);
      return { providerAccount: { ready: readiness.shift() ?? false } };
    });
    const wait = vi.fn(async () => undefined);
    const loadPaymentSettings = vi.fn(async () => ({ status: "active" }));

    await expect(
      refreshStripeAfterOnboarding(
        { propertyId: "property-1", signal: new AbortController().signal },
        { reconcile, wait, loadPaymentSettings },
      ),
    ).resolves.toEqual({ ready: true, paymentSettings: { status: "active" } });
    expect(reconcile).toHaveBeenCalledTimes(3);
    expect(reconciliationCalls).toEqual([
      ["property-1", 0],
      ["property-1", 1],
      ["property-1", 2],
    ]);
    expect(wait).toHaveBeenCalledTimes(2);
    expect(wait).toHaveBeenCalledWith(STRIPE_RECONCILIATION_DELAY_MS, expect.any(AbortSignal));
    expect(loadPaymentSettings).toHaveBeenCalledTimes(1);
  });

  it("stops pending reconciliation at the bound", async () => {
    const reconcile = vi.fn(async () => ({ providerAccount: { ready: false } }));
    const wait = vi.fn(async () => undefined);

    await expect(
      refreshStripeAfterOnboarding(
        { propertyId: "property-1", signal: new AbortController().signal },
        {
          reconcile,
          wait,
          loadPaymentSettings: async () => ({ status: "setup_incomplete" }),
        },
      ),
    ).resolves.toMatchObject({ ready: false });
    expect(reconcile).toHaveBeenCalledTimes(STRIPE_RECONCILIATION_ATTEMPTS);
    expect(wait).toHaveBeenCalledTimes(STRIPE_RECONCILIATION_ATTEMPTS - 1);
  });

  it("cancels and clears the retry timer on cleanup", async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const refresh = refreshStripeAfterOnboarding(
      { propertyId: "property-1", signal: controller.signal },
      {
        reconcile: async () => ({ providerAccount: { ready: false } }),
        loadPaymentSettings: async () => ({ status: "unused" }),
      },
    );
    await vi.waitFor(() => expect(vi.getTimerCount()).toBe(1));
    controller.abort();

    await expect(refresh).rejects.toMatchObject({ name: "AbortError" });
    expect(vi.getTimerCount()).toBe(0);
  });
});

function focusTarget() {
  const listeners = new Set<() => void>();
  return {
    addEventListener(_type: "focus", listener: () => void) {
      listeners.add(listener);
    },
    removeEventListener(_type: "focus", listener: () => void) {
      listeners.delete(listener);
    },
    focus() {
      listeners.forEach((listener) => listener());
    },
    listenerCount() {
      return listeners.size;
    },
  };
}

function markerStore() {
  const values = new Map<string, string>();
  return {
    getItem(key: string) {
      return values.get(key) ?? null;
    },
    setItem(key: string, value: string) {
      values.set(key, value);
    },
    removeItem(key: string) {
      values.delete(key);
    },
  };
}

function fakeLockManager(): Pick<LockManager, "request"> {
  const active = new Set<string>();
  const waiters = new Map<string, Array<() => void>>();
  return {
    async request(
      name: string,
      optionsOrCallback: LockOptions | ((lock: Lock | null) => unknown),
      possibleCallback?: (lock: Lock | null) => unknown,
    ) {
      const options = typeof optionsOrCallback === "function" ? {} : optionsOrCallback;
      const callback =
        typeof optionsOrCallback === "function" ? optionsOrCallback : possibleCallback!;
      if (options.ifAvailable && options.signal) {
        throw new DOMException("signal and ifAvailable cannot be combined", "NotSupportedError");
      }
      if (options.ifAvailable && active.has(name)) return callback(null);
      while (active.has(name)) {
        await new Promise<void>((resolve) => {
          const listeners = waiters.get(name) ?? [];
          listeners.push(resolve);
          waiters.set(name, listeners);
        });
      }
      active.add(name);
      try {
        return await callback({ name, mode: "exclusive" });
      } finally {
        active.delete(name);
        waiters
          .get(name)
          ?.splice(0)
          .forEach((resolve) => resolve());
      }
    },
  } as Pick<LockManager, "request">;
}
