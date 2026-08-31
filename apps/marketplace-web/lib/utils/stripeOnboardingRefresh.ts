const MARKER_PREFIX = "vayada:marketplace:stripe-onboarding";
const LOCK_PREFIX = "vayada:marketplace:stripe-onboarding-refresh";
const REFRESHING_PREFIX = "refreshing:";
const SETTLED_PREFIX = "settled:";

export const STRIPE_RECONCILIATION_ATTEMPTS = 3;
const STRIPE_RECONCILIATION_DELAY_MS = 1_000;

type FocusTarget = {
  addEventListener(type: "focus", listener: () => void): void;
  removeEventListener(type: "focus", listener: () => void): void;
};

type MarkerStore = Pick<Storage, "getItem" | "setItem">;

export function markStripeOnboardingStarted(propertyId: string, store: MarkerStore): void {
  try {
    const flowId = `stripe-onboarding-${crypto.randomUUID()}`;
    store.setItem(markerKey(propertyId), flowId);
  } catch {
    // The explicit return still refreshes when browser storage is unavailable.
  }
}

export function watchStripeOnboardingRefresh(input: {
  propertyId: string;
  isStripeReturn: boolean;
  target: FocusTarget;
  store: MarkerStore;
  onRefresh: (flowId: string, mode: "reconcile" | "reload") => Promise<boolean>;
}): () => void {
  let disposed = false;
  let handledFlowId: string | null = null;
  const key = markerKey(input.propertyId);
  const returnFlowId = input.isStripeReturn ? `stripe-onboarding-${crypto.randomUUID()}` : null;
  const refresh = () => {
    void Promise.resolve()
      .then(async () => {
        if (disposed) return;
        const marker = readMarker(safeRead(input.store, key));
        if (!marker && !input.isStripeReturn) return;
        const flowId = marker?.flowId ?? returnFlowId!;
        if (handledFlowId === flowId) return;
        handledFlowId = flowId;
        const claimed = marker?.state === "started";
        if (claimed) safeWrite(input.store, key, `${REFRESHING_PREFIX}${flowId}`);
        const completed = await input.onRefresh(
          flowId,
          marker && marker.state !== "started" ? "reload" : "reconcile",
        );
        if (!claimed) return;
        const current = readMarker(safeRead(input.store, key));
        if (current?.flowId !== flowId || current.state !== "refreshing") return;
        safeWrite(input.store, key, completed ? `${SETTLED_PREFIX}${flowId}` : flowId);
      })
      .catch(() => undefined);
  };

  input.target.addEventListener("focus", refresh);
  if (input.isStripeReturn) refresh();
  return () => {
    disposed = true;
    input.target.removeEventListener("focus", refresh);
  };
}

export async function coordinateStripeRefresh<T>(
  input: {
    propertyId: string;
    signal: AbortSignal;
    locks?: Pick<LockManager, "request">;
  },
  run: () => Promise<T>,
  reload: () => Promise<T>,
): Promise<T> {
  throwIfAborted(input.signal);
  if (!input.locks) return run();

  const lockName = `${LOCK_PREFIX}:${input.propertyId}`;
  const claimed = await input.locks.request(lockName, { ifAvailable: true }, async (lock) =>
    lock ? { acquired: true as const, value: await run() } : { acquired: false as const },
  );
  if (claimed.acquired) return claimed.value;
  return input.locks.request(lockName, { signal: input.signal }, reload);
}

export async function refreshStripeAfterOnboarding<T>(
  signal: AbortSignal,
  dependencies: {
    reconcile(attempt: number): Promise<{ providerAccount: { ready: boolean } }>;
    loadPaymentSettings(): Promise<T>;
    wait?: (milliseconds: number, signal: AbortSignal) => Promise<void>;
  },
): Promise<T> {
  const wait = dependencies.wait ?? abortableWait;
  for (let attempt = 0; attempt < STRIPE_RECONCILIATION_ATTEMPTS; attempt += 1) {
    throwIfAborted(signal);
    const result = await dependencies.reconcile(attempt);
    if (result.providerAccount.ready) break;
    if (attempt + 1 < STRIPE_RECONCILIATION_ATTEMPTS) {
      await wait(STRIPE_RECONCILIATION_DELAY_MS, signal);
    }
  }
  throwIfAborted(signal);
  return dependencies.loadPaymentSettings();
}

function markerKey(propertyId: string): string {
  return `${MARKER_PREFIX}:${propertyId}`;
}

function readMarker(
  value: string | null,
): { flowId: string; state: "started" | "refreshing" | "settled" } | null {
  if (!value) return null;
  if (value.startsWith(REFRESHING_PREFIX)) {
    const flowId = value.slice(REFRESHING_PREFIX.length);
    return flowId ? { flowId, state: "refreshing" } : null;
  }
  if (value.startsWith(SETTLED_PREFIX)) {
    const flowId = value.slice(SETTLED_PREFIX.length);
    return flowId ? { flowId, state: "settled" } : null;
  }
  return { flowId: value, state: "started" };
}

function safeRead(store: MarkerStore, key: string): string | null {
  try {
    return store.getItem(key);
  } catch {
    return null;
  }
}

function safeWrite(store: MarkerStore, key: string, value: string): void {
  try {
    store.setItem(key, value);
  } catch {
    // Storage is optional; the explicit return still refreshes safely.
  }
}

function abortableWait(milliseconds: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(abortError());
    const timeout = globalThis.setTimeout(done, milliseconds);
    const abort = () => {
      globalThis.clearTimeout(timeout);
      signal.removeEventListener("abort", abort);
      reject(abortError());
    };
    function done() {
      signal.removeEventListener("abort", abort);
      resolve();
    }
    signal.addEventListener("abort", abort, { once: true });
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
