const STRIPE_ONBOARDING_PROPERTY_KEY_PREFIX = "vayada:booking-admin:stripe-onboarding-property";
const STRIPE_ONBOARDING_LOCK_PREFIX = "vayada:booking-admin:stripe-onboarding-refresh";
const STRIPE_ONBOARDING_SETTLED_PREFIX = "settled:";
export const STRIPE_RECONCILIATION_ATTEMPTS = 3;
export const STRIPE_RECONCILIATION_DELAY_MS = 1_000;

type FocusTarget = {
  addEventListener(type: "focus", listener: () => void): void;
  removeEventListener(type: "focus", listener: () => void): void;
};

type MarkerStore = Pick<Storage, "getItem" | "setItem" | "removeItem">;

export function stripeOnboardingPropertyKey(propertyId: string): string {
  return `${STRIPE_ONBOARDING_PROPERTY_KEY_PREFIX}:${propertyId}`;
}

export function newStripeOnboardingFlowId(): string {
  return `stripe-onboarding-${crypto.randomUUID()}`;
}

export function markStripeOnboardingStarted(
  propertyId: string,
  store: MarkerStore,
  flowId = newStripeOnboardingFlowId(),
): string {
  store.setItem(stripeOnboardingPropertyKey(propertyId), flowId);
  return flowId;
}

export function tryMarkStripeOnboardingStarted(
  propertyId: string,
  store: MarkerStore,
  flowId?: string,
): string | null {
  try {
    return markStripeOnboardingStarted(propertyId, store, flowId);
  } catch {
    return null;
  }
}

export function watchStripeOnboardingRefresh(input: {
  propertyId: string;
  isStripeReturn: boolean;
  target: FocusTarget;
  store: MarkerStore;
  onRefresh: (flowId: string, mode: "reconcile" | "reload") => Promise<"settled" | "aborted">;
}): () => void {
  let disposed = false;
  let handled = false;
  const markerKey = stripeOnboardingPropertyKey(input.propertyId);
  const claimRefresh = () => {
    void Promise.resolve()
      .then(async () => {
        if (disposed || handled) return;
        const marker = readStripeOnboardingMarker(input.store.getItem(markerKey));
        if (!marker) return;
        handled = true;
        const outcome = await input.onRefresh(
          marker.flowId,
          marker.settled ? "reload" : "reconcile",
        );
        if (disposed || outcome === "aborted") return;
        const current = readStripeOnboardingMarker(input.store.getItem(markerKey));
        if (current?.flowId !== marker.flowId) return;
        if (input.isStripeReturn) {
          input.store.setItem(markerKey, `${STRIPE_ONBOARDING_SETTLED_PREFIX}${marker.flowId}`);
        } else {
          input.store.removeItem(markerKey);
        }
      })
      .catch(() => undefined);
  };

  input.target.addEventListener("focus", claimRefresh);
  if (input.isStripeReturn) claimRefresh();

  return () => {
    disposed = true;
    input.target.removeEventListener("focus", claimRefresh);
  };
}

function readStripeOnboardingMarker(
  value: string | null,
): { flowId: string; settled: boolean } | null {
  if (!value) return null;
  if (value.startsWith(STRIPE_ONBOARDING_SETTLED_PREFIX)) {
    const flowId = value.slice(STRIPE_ONBOARDING_SETTLED_PREFIX.length);
    return flowId ? { flowId, settled: true } : null;
  }
  return { flowId: value, settled: false };
}

export async function coordinateStripeRefresh<T>(
  input: {
    propertyId: string;
    flowId?: string;
    signal: AbortSignal;
    locks: Pick<LockManager, "request"> | undefined;
  },
  dependencies: {
    run(flowId: string): Promise<T>;
    reload(): Promise<T>;
  },
): Promise<T> {
  if (!input.locks) {
    throwIfAborted(input.signal);
    const value = await dependencies.run(input.flowId ?? newStripeOnboardingFlowId());
    throwIfAborted(input.signal);
    return value;
  }

  const lockName = `${STRIPE_ONBOARDING_LOCK_PREFIX}:${input.propertyId}`;
  throwIfAborted(input.signal);
  const claimed = await input.locks.request(lockName, { ifAvailable: true }, async (lock) => {
    if (!lock) return { acquired: false as const };
    return {
      acquired: true as const,
      value: await dependencies.run(input.flowId ?? newStripeOnboardingFlowId()),
    };
  });
  if (claimed.acquired) {
    throwIfAborted(input.signal);
    return claimed.value;
  }

  const value = await input.locks.request(lockName, { signal: input.signal }, dependencies.reload);
  throwIfAborted(input.signal);
  return value;
}

export async function refreshStripeAfterOnboarding<T>(
  input: { propertyId: string; signal: AbortSignal },
  dependencies: {
    reconcile(
      propertyId: string,
      attempt: number,
    ): Promise<{ providerAccount: { ready: boolean } }>;
    loadPaymentSettings(propertyId: string): Promise<T>;
    wait?(milliseconds: number, signal: AbortSignal): Promise<void>;
  },
): Promise<{ ready: boolean; paymentSettings: T }> {
  const wait = dependencies.wait ?? abortableWait;
  let ready = false;
  for (let attempt = 0; attempt < STRIPE_RECONCILIATION_ATTEMPTS; attempt += 1) {
    throwIfAborted(input.signal);
    const result = await dependencies.reconcile(input.propertyId, attempt);
    ready = result.providerAccount.ready;
    if (ready) break;
    if (attempt + 1 < STRIPE_RECONCILIATION_ATTEMPTS) {
      await wait(STRIPE_RECONCILIATION_DELAY_MS, input.signal);
    }
  }

  throwIfAborted(input.signal);
  const paymentSettings = await dependencies.loadPaymentSettings(input.propertyId);
  throwIfAborted(input.signal);
  return { ready, paymentSettings };
}

function abortableWait(milliseconds: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(abortError());
      return;
    }
    const timeout = globalThis.setTimeout(done, milliseconds);
    const onAbort = () => {
      globalThis.clearTimeout(timeout);
      signal.removeEventListener("abort", onAbort);
      reject(abortError());
    };
    function done() {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw abortError();
}

function abortError(): Error {
  return Object.assign(new Error("Stripe onboarding refresh was canceled."), {
    name: "AbortError",
  });
}
