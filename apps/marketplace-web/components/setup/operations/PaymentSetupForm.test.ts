import { createElement } from "react";
import { act, create, type ReactTestInstance, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getPaymentSettings: vi.fn(),
  reconcileStripeProviderAccount: vi.fn(),
  startStripeOnboarding: vi.fn(),
  updatePaymentSettings: vi.fn(),
}));

vi.mock("@/services/auth/sessionStore", async () => ({
  ...(await vi.importActual<typeof import("@/services/auth/sessionStore")>(
    "@/services/auth/sessionStore",
  )),
  getAuthSessionUser: () => ({ email: "owner@example.test" }),
}));
vi.mock("@/services/api/hotelOperationsSetupClient", async () => ({
  ...(await vi.importActual<typeof import("@/services/api/hotelOperationsSetupClient")>(
    "@/services/api/hotelOperationsSetupClient",
  )),
  hotelOperationsSetupApi: mocks,
}));

import { markStripeOnboardingStarted } from "@/lib/utils/stripeOnboardingRefresh";
import { PaymentSetupForm } from "./PaymentSetupForm";

const propertyId = "property-1";

describe("PaymentSetupForm Stripe refresh", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal("navigator", {});
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it.each(["return", "refresh"])(
    "reconciles the exact property after a Stripe %s return and removes the hint",
    async (stripe) => {
      const browser = browserWindow(`?propertyId=${propertyId}&step=payments&stripe=${stripe}`);
      vi.stubGlobal("window", browser.window);
      mocks.getPaymentSettings
        .mockResolvedValueOnce(paymentSettings(false))
        .mockResolvedValueOnce(paymentSettings(true));
      mocks.reconcileStripeProviderAccount.mockResolvedValue({
        propertyId,
        providerAccount: { ready: true },
      });
      const onCompleted = vi.fn(async () => undefined);
      let renderer: ReactTestRenderer | undefined;

      await act(async () => {
        renderer = create(createElement(PaymentSetupForm, props(onCompleted)));
      });
      await vi.waitFor(() => expect(onCompleted).toHaveBeenCalledOnce());

      expect(mocks.reconcileStripeProviderAccount).toHaveBeenCalledWith(
        propertyId,
        expect.stringMatching(/^stripe-onboarding-.+:attempt:1$/),
        expect.any(AbortSignal),
      );
      expect(mocks.reconcileStripeProviderAccount).toHaveBeenCalledTimes(1);
      expect(mocks.getPaymentSettings).toHaveBeenCalledTimes(2);
      expect(mocks.startStripeOnboarding).not.toHaveBeenCalled();
      expect(browser.history.replaceState).toHaveBeenCalledWith(
        null,
        "",
        `/setup?propertyId=${propertyId}&step=payments`,
      );
      expect(textOf(renderer!.root)).toContain("Stripe is connected.");
      await act(async () => renderer?.unmount());
      expect(browser.listenerCount()).toBe(0);
    },
  );

  it("refreshes the original window once on focus after onboarding started", async () => {
    const browser = browserWindow(`?propertyId=${propertyId}&step=payments`);
    vi.stubGlobal("window", browser.window);
    markStripeOnboardingStarted(propertyId, browser.window.localStorage);
    mocks.getPaymentSettings
      .mockResolvedValueOnce(paymentSettings(false))
      .mockResolvedValueOnce(paymentSettings(true));
    mocks.reconcileStripeProviderAccount.mockResolvedValue({
      propertyId,
      providerAccount: { ready: true },
    });
    const onCompleted = vi.fn(async () => undefined);
    let renderer: ReactTestRenderer | undefined;

    await act(async () => {
      renderer = create(createElement(PaymentSetupForm, props(onCompleted)));
    });
    expect(mocks.reconcileStripeProviderAccount).not.toHaveBeenCalled();

    await act(async () => browser.focus());
    await vi.waitFor(() => expect(onCompleted).toHaveBeenCalledOnce());
    browser.focus();
    await Promise.resolve();

    expect(mocks.reconcileStripeProviderAccount).toHaveBeenCalledTimes(1);
    expect(mocks.startStripeOnboarding).not.toHaveBeenCalled();
    await act(async () => renderer?.unmount());
    expect(browser.listenerCount()).toBe(0);
  });

  it("keeps a failed return pending with a safe retry action", async () => {
    const browser = browserWindow(`?propertyId=${propertyId}&step=payments&stripe=return`);
    vi.stubGlobal("window", browser.window);
    mocks.getPaymentSettings.mockResolvedValueOnce(paymentSettings(false));
    mocks.reconcileStripeProviderAccount.mockRejectedValueOnce(new Error("Finance unavailable"));
    let renderer: ReactTestRenderer | undefined;

    await act(async () => {
      renderer = create(createElement(PaymentSetupForm, props(vi.fn(async () => undefined))));
    });
    await vi.waitFor(() => expect(textOf(renderer!.root)).toContain("Finance unavailable"));

    expect(button(renderer!.root, "Check Stripe status")).toBeDefined();
    expect(mocks.startStripeOnboarding).not.toHaveBeenCalled();
    await act(async () => renderer?.unmount());
  });

  it("blocks payment and onboarding writes while a return refresh is running", async () => {
    const browser = browserWindow(`?propertyId=${propertyId}&step=payments&stripe=return`);
    vi.stubGlobal("window", browser.window);
    const reconciliation = deferred<{
      propertyId: string;
      providerAccount: { ready: boolean };
    }>();
    mocks.getPaymentSettings
      .mockResolvedValueOnce(paymentSettings(false))
      .mockResolvedValueOnce(paymentSettings(true));
    mocks.reconcileStripeProviderAccount.mockReturnValueOnce(reconciliation.promise);
    let renderer: ReactTestRenderer | undefined;

    await act(async () => {
      renderer = create(createElement(PaymentSetupForm, props(vi.fn(async () => undefined))));
    });
    await vi.waitFor(() => expect(mocks.reconcileStripeProviderAccount).toHaveBeenCalledOnce());
    expect(button(renderer!.root, "Checking Stripe…").props.disabled).toBe(true);
    expect(
      renderer!.root.findAllByType("fieldset").every((node) => node.props.disabled === true),
    ).toBe(true);

    await act(async () => {
      await renderer!.root.findByType("form").props.onSubmit({ preventDefault: vi.fn() });
    });
    expect(mocks.updatePaymentSettings).not.toHaveBeenCalled();
    expect(mocks.startStripeOnboarding).not.toHaveBeenCalled();

    reconciliation.resolve({ propertyId, providerAccount: { ready: true } });
    await vi.waitFor(() => expect(textOf(renderer!.root)).toContain("Stripe is connected."));
    await act(async () => renderer?.unmount());
  });

  it("refreshes setup readiness after a bounded pending reconciliation", async () => {
    vi.useFakeTimers();
    const browser = browserWindow(`?propertyId=${propertyId}&step=payments&stripe=return`);
    vi.stubGlobal("window", browser.window);
    mocks.getPaymentSettings
      .mockResolvedValueOnce(paymentSettings(false))
      .mockResolvedValueOnce(paymentSettings(false));
    mocks.reconcileStripeProviderAccount.mockResolvedValue({
      propertyId,
      providerAccount: { ready: false },
    });
    const onCompleted = vi.fn(async () => undefined);
    let renderer: ReactTestRenderer | undefined;

    await act(async () => {
      renderer = create(createElement(PaymentSetupForm, props(onCompleted)));
      await vi.advanceTimersByTimeAsync(2_000);
    });
    await vi.waitFor(() => expect(onCompleted).toHaveBeenCalledOnce());

    expect(mocks.reconcileStripeProviderAccount).toHaveBeenCalledTimes(3);
    expect(textOf(renderer!.root)).toContain("Stripe setup is still pending");
    expect(button(renderer!.root, "Check Stripe status")).toBeDefined();
    await act(async () => renderer?.unmount());
  });

  it("hides an issued Stripe link while its focus refresh is running", async () => {
    const browser = browserWindow(`?propertyId=${propertyId}&step=payments`);
    vi.stubGlobal("window", browser.window);
    const reconciliation = deferred<{
      propertyId: string;
      providerAccount: { ready: boolean };
    }>();
    mocks.getPaymentSettings
      .mockResolvedValueOnce(paymentSettings(false))
      .mockResolvedValueOnce(paymentSettings(true));
    mocks.updatePaymentSettings.mockResolvedValue(paymentSettings(false));
    mocks.startStripeOnboarding.mockResolvedValue({
      providerAccountId: "stripe-account-1",
      onboardingUrl: "https://connect.stripe.test/onboarding",
      status: "setup_incomplete",
      onboardingStatus: "invited",
    });
    mocks.reconcileStripeProviderAccount.mockReturnValueOnce(reconciliation.promise);
    let renderer: ReactTestRenderer | undefined;

    await act(async () => {
      renderer = create(createElement(PaymentSetupForm, props(vi.fn(async () => undefined))));
    });
    await vi.waitFor(() => expect(renderer!.root.findAllByType("form")).toHaveLength(1));
    await act(async () => {
      await renderer!.root.findByType("form").props.onSubmit({ preventDefault: vi.fn() });
    });
    await vi.waitFor(() => expect(link(renderer!.root, "Open Stripe")).toBeDefined());

    await act(async () => browser.focus());
    await vi.waitFor(() => expect(mocks.reconcileStripeProviderAccount).toHaveBeenCalledOnce());
    expect(link(renderer!.root, "Open Stripe")).toBeUndefined();

    reconciliation.resolve({ propertyId, providerAccount: { ready: true } });
    await vi.waitFor(() => expect(textOf(renderer!.root)).toContain("Stripe is connected."));
    await act(async () => renderer?.unmount());
  });
});

function props(onCompleted: () => Promise<void>) {
  return {
    onBack: null,
    onBeforeSave: async () => undefined,
    onCompleted,
    propertyId,
  };
}

function paymentSettings(ready: boolean) {
  return {
    paymentsEnabled: true,
    paymentProvider: "stripe" as const,
    acceptedMethods: ["card"],
    defaultCurrency: "EUR",
    supportedCurrencies: ["EUR"],
    depositPolicy: {},
    requiresManualReview: false,
    providerAccount: {
      providerAccountId: "stripe-account-1",
      provider: "stripe",
      status: ready ? "active" : "setup_incomplete",
      onboardingStatus: ready ? "completed" : "invited",
      chargesEnabled: ready,
      payoutsEnabled: ready,
    },
  };
}

function browserWindow(search: string) {
  const listeners = new Set<() => void>();
  const values = new Map<string, string>();
  const history = { replaceState: vi.fn() };
  const window = {
    location: { pathname: "/setup", search, hash: "" },
    history,
    localStorage: {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
      removeItem: (key: string) => values.delete(key),
    },
    addEventListener: (_type: "focus", listener: () => void) => listeners.add(listener),
    removeEventListener: (_type: "focus", listener: () => void) => listeners.delete(listener),
  };
  return {
    window,
    history,
    focus: () => listeners.forEach((listener) => listener()),
    listenerCount: () => listeners.size,
  };
}

function textOf(node: ReactTestInstance): string {
  return node.children.map((child) => (typeof child === "string" ? child : textOf(child))).join("");
}

function button(root: ReactTestInstance, label: string): ReactTestInstance {
  return root.findAllByType("button").find((node) => textOf(node) === label)!;
}

function link(root: ReactTestInstance, label: string): ReactTestInstance | undefined {
  return root.findAllByType("a").find((node) => textOf(node) === label);
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolver) => {
    resolve = resolver;
  });
  return { promise, resolve };
}
