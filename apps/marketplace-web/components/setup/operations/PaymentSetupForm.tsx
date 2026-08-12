"use client";

import { useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";

import { getAuthSessionUser } from "@/services/auth/sessionStore";
import {
  hotelOperationsErrorMessage,
  hotelOperationsSetupApi,
  isPropertyCurrencyConflict,
  isStripeReady,
  type FinancePaymentSettings,
  type OnlinePaymentProvider,
  type PayAtHotelMethod,
  type PaymentMethodChoice,
  type PaymentSetupDraft,
} from "@/services/api/hotelOperationsSetupClient";

import {
  OperationField,
  OperationFormLoadError,
  OperationFormLoading,
  OperationFormShell,
  operationInputClassName,
} from "./OperationFormShell";

const EMPTY_DRAFT: PaymentSetupDraft = {
  methods: ["pay_at_property"],
  onlineProvider: "stripe",
  payAtHotelMethods: ["cash", "card"],
  bankName: "",
  accountHolder: "",
  accountNumber: "",
  bicSwift: "",
  paypalEmail: "",
};

export function PaymentSetupForm({
  onBack,
  onBeforeSave,
  onCompleted,
  propertyId,
}: {
  onBack: (() => void) | null;
  onBeforeSave: () => Promise<void>;
  onCompleted: () => void | Promise<void>;
  propertyId: string;
}) {
  const [settings, setSettings] = useState<FinancePaymentSettings | null>(null);
  const [draft, setDraft] = useState<PaymentSetupDraft>(EMPTY_DRAFT);
  const [stripeEmail, setStripeEmail] = useState(() => getAuthSessionUser()?.email ?? "");
  const [stripeCountry, setStripeCountry] = useState("DE");
  const [stripeOnboardingUrl, setStripeOnboardingUrl] = useState("");
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [reloadToken, setReloadToken] = useState(0);
  const [submitting, setSubmitting] = useState(false);
  const [checkingStripe, setCheckingStripe] = useState(false);
  const [settingsSaved, setSettingsSaved] = useState(false);
  const [completionRefreshPending, setCompletionRefreshPending] = useState(false);
  const [error, setError] = useState("");
  const stripeLinkAttemptId = useRef(newStripeLinkAttemptId());
  const paymentSettingsAttemptId = useRef(newPaymentSettingsAttemptId());

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setLoadError("");
    void hotelOperationsSetupApi
      .getPaymentSettings(propertyId, controller.signal)
      .then((loaded) => {
        setSettings(loaded);
        setDraft(paymentDraftFromSettings(loaded));
        setSettingsSaved(false);
        setCompletionRefreshPending(false);
      })
      .catch((cause) => {
        if (!controller.signal.aborted) {
          setLoadError(hotelOperationsErrorMessage(cause, "Payment settings could not be loaded."));
        }
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [propertyId, reloadToken]);

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!settings) return;
    if (draft.methods.length === 0) {
      setError("Select at least one payment method so guests can complete bookings.");
      return;
    }
    if (draft.methods.includes("pay_at_property") && draft.payAtHotelMethods.length === 0) {
      setError("Choose cash, card, or both for Pay at Hotel.");
      return;
    }
    let paymentSettingsSaved = settingsSaved;
    setSubmitting(true);
    setError("");
    try {
      if (completionRefreshPending || (settingsSaved && !needsStripeSetup(draft, settings))) {
        await refreshCompletion();
        return;
      }

      await onBeforeSave();
      const updated = settingsSaved
        ? settings
        : await hotelOperationsSetupApi.updatePaymentSettings(
            propertyId,
            draft,
            settings.defaultCurrency,
            paymentSettingsAttemptId.current,
          );
      if (!settingsSaved) {
        assertPaymentSettingsMatchDraft(updated, draft);
        setSettings(updated);
        setSettingsSaved(true);
        paymentSettingsSaved = true;
        paymentSettingsAttemptId.current = newPaymentSettingsAttemptId();
      }
      if (!needsStripeSetup(draft, updated)) {
        await refreshCompletion();
        return;
      }

      setStripeOnboardingUrl("");
      const onboarding = await hotelOperationsSetupApi.startStripeOnboarding(propertyId, {
        email: stripeEmail,
        country: stripeCountry,
        providerAccountId: updated.providerAccount.providerAccountId,
        linkAttemptId: stripeLinkAttemptId.current,
      });
      setStripeOnboardingUrl(onboarding.onboardingUrl);
      stripeLinkAttemptId.current = newStripeLinkAttemptId();
    } catch (cause) {
      if (isPropertyCurrencyConflict(cause)) {
        setSettingsSaved(false);
        setReloadToken((current) => current + 1);
        setError(
          "Your property currency changed. Payment settings were reloaded; review and save again.",
        );
        return;
      }
      setError(
        paymentSettingsSaved
          ? hotelOperationsErrorMessage(
              cause,
              "Your payment methods are saved, but Stripe setup could not start.",
            )
          : hotelOperationsErrorMessage(cause, "Payment settings could not be saved."),
      );
    } finally {
      setSubmitting(false);
    }
  };

  const refreshCompletion = async () => {
    try {
      await onCompleted();
      setCompletionRefreshPending(false);
    } catch (cause) {
      console.warn("Payment settings saved but setup status could not refresh", cause);
      setCompletionRefreshPending(true);
      setError("Your payment settings were saved, but setup could not refresh. Try again.");
    }
  };

  const checkStripeStatus = async () => {
    setCheckingStripe(true);
    setError("");
    try {
      const updated = await hotelOperationsSetupApi.getPaymentSettings(propertyId);
      setSettings(updated);
      if (isStripeReady(updated)) {
        setSettingsSaved(true);
        await refreshCompletion();
      } else {
        setError("Stripe is not ready yet. Finish the Stripe checklist, then check again.");
      }
    } catch (cause) {
      setError(hotelOperationsErrorMessage(cause, "Stripe status could not be checked."));
    } finally {
      setCheckingStripe(false);
    }
  };

  const change = <K extends keyof PaymentSetupDraft>(key: K, value: PaymentSetupDraft[K]) => {
    setDraft((current) => ({ ...current, [key]: value }));
    setSettingsSaved(false);
    setCompletionRefreshPending(false);
  };
  const toggleMethod = (method: PaymentMethodChoice) => {
    change(
      "methods",
      draft.methods.includes(method)
        ? draft.methods.filter((item) => item !== method)
        : [...draft.methods, method],
    );
  };

  if (loading) return <OperationFormLoading />;
  if (loadError || !settings) {
    return (
      <OperationFormLoadError
        message={loadError || "Payment settings could not be loaded."}
        onBack={onBack}
        onRetry={() => setReloadToken((current) => current + 1)}
      />
    );
  }

  const stripeSelected = draft.methods.includes("online_card") && draft.onlineProvider === "stripe";
  const needsStripeAccount = stripeSelected && !settings.providerAccount.providerAccountId;
  const stripePending = stripeSelected && !isStripeReady(settings);
  const readyPaymentSaved = settingsSaved && !needsStripeSetup(draft, settings);

  return (
    <OperationFormShell
      error={error}
      notice={
        completionRefreshPending || readyPaymentSaved ? (
          "Your payment settings are saved. Retry the setup refresh to continue."
        ) : stripeOnboardingUrl ? (
          <div className="space-y-3">
            <p className="font-semibold">Finish connecting Stripe</p>
            <p>Stripe must confirm onboarding and enable charges before card payments go live.</p>
            <div className="flex flex-wrap gap-3">
              <a
                className="inline-flex min-h-10 items-center rounded-full bg-primary-600 px-4 py-2 font-semibold text-white hover:bg-primary-700"
                href={stripeOnboardingUrl}
                rel="noreferrer"
                target="_blank"
              >
                Open Stripe
              </a>
              <button
                className="min-h-10 rounded-full border border-primary-300 bg-white px-4 py-2 font-semibold text-primary-800 disabled:opacity-60"
                disabled={checkingStripe}
                onClick={checkStripeStatus}
                type="button"
              >
                {checkingStripe ? "Checking…" : "Check Stripe status"}
              </button>
            </div>
          </div>
        ) : stripePending && settings.providerAccount.onboardingStatus !== "not_started" ? (
          `Stripe status: ${humanize(settings.providerAccount.onboardingStatus)}.`
        ) : (
          `Payments use your property currency: ${settings.defaultCurrency}.`
        )
      }
      onBack={onBack}
      onSubmit={handleSubmit}
      submitLabel={
        completionRefreshPending || readyPaymentSaved
          ? "Refresh setup progress"
          : stripeSelected
            ? settingsSaved
              ? "Continue Stripe setup"
              : "Save and connect Stripe"
            : "Save and continue"
      }
      submitting={submitting}
      submittingLabel="Saving…"
    >
      <fieldset className="space-y-4 sm:col-span-2">
        <legend className="text-sm font-semibold text-gray-900">
          Choose which options to offer
        </legend>
        <p className="text-sm text-gray-600">
          Choose which payment options to offer. You can enable multiple.
        </p>
        <div className="grid gap-4 md:grid-cols-2">
          <MethodCard
            checked={draft.methods.includes("online_card")}
            description="Guest pays online with credit or debit card."
            label="Online Card"
            onToggle={() => toggleMethod("online_card")}
            points={["Instant confirmation", "Automatic payout", "Processing fees apply"]}
          >
            {draft.methods.includes("online_card") ? (
              <ProviderOptions
                onChange={(provider) => change("onlineProvider", provider)}
                value={draft.onlineProvider}
              />
            ) : null}
          </MethodCard>

          <MethodCard
            checked={draft.methods.includes("pay_at_property")}
            description="Guest pays cash or card at check-in."
            label="Pay at Hotel"
            onToggle={() => toggleMethod("pay_at_property")}
            points={["No processing fees", "No online account needed", "Higher no-show risk"]}
          >
            {draft.methods.includes("pay_at_property") ? (
              <div className="flex flex-wrap gap-2">
                {(["cash", "card"] as PayAtHotelMethod[]).map((item) => (
                  <SmallToggle
                    checked={draft.payAtHotelMethods.includes(item)}
                    key={item}
                    label={item === "cash" ? "Cash" : "Card at hotel"}
                    onChange={() =>
                      change(
                        "payAtHotelMethods",
                        draft.payAtHotelMethods.includes(item)
                          ? draft.payAtHotelMethods.filter((value) => value !== item)
                          : [...draft.payAtHotelMethods, item],
                      )
                    }
                  />
                ))}
              </div>
            ) : null}
          </MethodCard>

          <MethodCard
            checked={draft.methods.includes("bank_transfer")}
            description="Guest transfers money directly to your bank account."
            label="Bank Transfer"
            onToggle={() => toggleMethod("bank_transfer")}
            points={["No processing fees", "Direct to your account", "Manual verification"]}
          >
            {draft.methods.includes("bank_transfer") ? (
              <div className="grid gap-3 sm:grid-cols-2">
                <CompactField label="Bank name">
                  <input
                    className={operationInputClassName}
                    onChange={(event) => change("bankName", event.target.value)}
                    required
                    value={draft.bankName}
                  />
                </CompactField>
                <CompactField label="Account holder">
                  <input
                    className={operationInputClassName}
                    onChange={(event) => change("accountHolder", event.target.value)}
                    required
                    value={draft.accountHolder}
                  />
                </CompactField>
                <CompactField className="sm:col-span-2" label="Account number / IBAN">
                  <input
                    className={operationInputClassName}
                    onChange={(event) => change("accountNumber", event.target.value)}
                    required
                    value={draft.accountNumber}
                  />
                </CompactField>
                <CompactField className="sm:col-span-2" label="BIC / SWIFT (optional)">
                  <input
                    className={operationInputClassName}
                    onChange={(event) => change("bicSwift", event.target.value)}
                    value={draft.bicSwift}
                  />
                </CompactField>
              </div>
            ) : null}
          </MethodCard>

          <MethodCard
            checked={draft.methods.includes("paypal")}
            description="Guests send payment manually to your PayPal email."
            label="PayPal"
            onToggle={() => toggleMethod("paypal")}
            points={["Familiar to guests", "Manual PMS confirmation"]}
          >
            {draft.methods.includes("paypal") ? (
              <OperationField label="PayPal email">
                <input
                  autoComplete="email"
                  className={operationInputClassName}
                  onChange={(event) => change("paypalEmail", event.target.value)}
                  required
                  type="email"
                  value={draft.paypalEmail}
                />
              </OperationField>
            ) : null}
          </MethodCard>
        </div>
      </fieldset>

      {stripeSelected ? (
        <div className="grid gap-4 sm:col-span-2 sm:grid-cols-2">
          <OperationField label="Stripe account email">
            <input
              autoComplete="email"
              className={operationInputClassName}
              disabled={!needsStripeAccount}
              onChange={(event) => setStripeEmail(event.target.value)}
              required={needsStripeAccount}
              type="email"
              value={stripeEmail}
            />
          </OperationField>
          <OperationField label="Stripe account country" hint="Two-letter country code.">
            <input
              autoCapitalize="characters"
              className={operationInputClassName}
              disabled={!needsStripeAccount}
              maxLength={2}
              minLength={2}
              onChange={(event) => setStripeCountry(event.target.value.toUpperCase())}
              pattern="[A-Za-z]{2}"
              required={needsStripeAccount}
              value={stripeCountry}
            />
          </OperationField>
        </div>
      ) : null}
    </OperationFormShell>
  );
}

function newStripeLinkAttemptId(): string {
  return globalThis.crypto.randomUUID();
}

function newPaymentSettingsAttemptId(): string {
  return globalThis.crypto.randomUUID();
}

function assertPaymentSettingsMatchDraft(
  settings: FinancePaymentSettings,
  draft: PaymentSetupDraft,
): void {
  const expected = new Set<string>();
  if (draft.methods.includes("online_card")) expected.add("card");
  if (draft.methods.includes("pay_at_property")) {
    expected.add("pay_at_property");
    if (draft.payAtHotelMethods.includes("cash")) expected.add("cash");
    if (draft.payAtHotelMethods.includes("card")) expected.add("manual_card");
  }
  if (draft.methods.includes("bank_transfer")) expected.add("bank_transfer");
  if (draft.methods.includes("paypal")) expected.add("paypal");
  if (
    settings.acceptedMethods.length !== expected.size ||
    settings.acceptedMethods.some((method) => !expected.has(method))
  ) {
    throw new Error("Payment settings changed before this save completed. Review and try again.");
  }
}

function MethodCard({
  checked,
  children,
  description,
  disabled = false,
  label,
  onToggle,
  points,
}: {
  checked: boolean;
  children?: ReactNode;
  description: string;
  disabled?: boolean;
  label: string;
  onToggle: () => void;
  points: string[];
}) {
  return (
    <section
      className={`rounded-2xl border-2 p-4 transition ${
        checked ? "border-primary-500 bg-primary-50/40" : "border-gray-200 bg-white"
      }`}
    >
      <button
        className="flex w-full items-start gap-3 text-left disabled:cursor-not-allowed disabled:opacity-55"
        disabled={disabled}
        onClick={onToggle}
        type="button"
      >
        <span
          aria-hidden="true"
          className={`mt-0.5 grid h-5 w-5 shrink-0 place-items-center rounded border-2 text-xs font-bold ${
            checked ? "border-primary-600 bg-primary-600 text-white" : "border-gray-300"
          }`}
        >
          {checked ? "✓" : ""}
        </span>
        <span>
          <span className="block text-sm font-semibold text-gray-950">{label}</span>
          <span className="mt-1 block text-xs leading-5 text-gray-600">{description}</span>
        </span>
      </button>
      <ul className="mt-3 space-y-1 text-xs text-gray-600">
        {points.map((point) => (
          <li className="flex gap-2" key={point}>
            <span className="text-primary-600">•</span>
            {point}
          </li>
        ))}
      </ul>
      {children ? <div className="mt-4 border-t border-gray-200 pt-4">{children}</div> : null}
    </section>
  );
}

function ProviderOptions({
  onChange,
  value,
}: {
  onChange: (provider: OnlinePaymentProvider) => void;
  value: OnlinePaymentProvider;
}) {
  return (
    <div className="space-y-2">
      <ProviderChoice
        checked={value === "stripe"}
        description="Visa, Mastercard and Amex. Stripe fees apply."
        label="Stripe Connect"
        onChange={() => onChange("stripe")}
      />
      <ProviderChoice
        checked={value === "vayada"}
        description="Managed by vayada — setup is coming soon."
        disabled
        label="vayada Payments"
        onChange={() => onChange("vayada")}
      />
      <ProviderChoice
        checked={value === "xendit"}
        description="For Indonesian properties — setup is coming soon."
        disabled
        label="Xendit"
        onChange={() => onChange("xendit")}
      />
    </div>
  );
}

function ProviderChoice({
  checked,
  description,
  disabled = false,
  label,
  onChange,
}: {
  checked: boolean;
  description: string;
  disabled?: boolean;
  label: string;
  onChange: () => void;
}) {
  return (
    <label
      className={`flex gap-2 rounded-xl border p-3 ${disabled ? "opacity-55" : "cursor-pointer"}`}
    >
      <input
        checked={checked}
        disabled={disabled}
        name="online-provider"
        onChange={onChange}
        type="radio"
      />
      <span>
        <span className="block text-xs font-semibold text-gray-900">{label}</span>
        <span className="mt-0.5 block text-[11px] leading-4 text-gray-500">{description}</span>
      </span>
    </label>
  );
}

function SmallToggle({
  checked,
  label,
  onChange,
}: {
  checked: boolean;
  label: string;
  onChange: () => void;
}) {
  return (
    <label className="flex cursor-pointer items-center gap-2 rounded-full border border-gray-300 bg-white px-3 py-2 text-xs font-medium text-gray-700">
      <input checked={checked} onChange={onChange} type="checkbox" />
      {label}
    </label>
  );
}

function CompactField({
  children,
  className = "",
  label,
}: {
  children: ReactNode;
  className?: string;
  label: string;
}) {
  return (
    <label className={className}>
      <span className="mb-1 block text-xs font-medium text-gray-700">{label}</span>
      {children}
    </label>
  );
}

function paymentDraftFromSettings(settings: FinancePaymentSettings): PaymentSetupDraft {
  const methods: PaymentMethodChoice[] = [];
  if (settings.acceptedMethods.some((method) => method === "card" || method === "xendit")) {
    methods.push("online_card");
  }
  if (settings.acceptedMethods.includes("pay_at_property")) methods.push("pay_at_property");
  if (settings.acceptedMethods.includes("bank_transfer")) methods.push("bank_transfer");
  if (settings.acceptedMethods.includes("paypal")) methods.push("paypal");
  const payAtHotelMethods: PayAtHotelMethod[] = [];
  if (settings.acceptedMethods.includes("cash")) payAtHotelMethods.push("cash");
  if (settings.acceptedMethods.includes("manual_card")) payAtHotelMethods.push("card");
  const policy = settings.depositPolicy ?? {};
  return {
    ...EMPTY_DRAFT,
    methods: methods.length > 0 ? methods : EMPTY_DRAFT.methods,
    onlineProvider:
      settings.paymentProvider === "xendit" || settings.paymentProvider === "vayada"
        ? settings.paymentProvider
        : "stripe",
    payAtHotelMethods:
      payAtHotelMethods.length > 0 ? payAtHotelMethods : EMPTY_DRAFT.payAtHotelMethods,
    bankName: policyText(policy.bankName),
    accountHolder: policyText(policy.accountHolder),
    accountNumber: policyText(policy.accountNumber),
    bicSwift: policyText(policy.bicSwift),
    paypalEmail: policyText(policy.paypalEmail),
  };
}

function needsStripeSetup(draft: PaymentSetupDraft, settings: FinancePaymentSettings): boolean {
  return (
    draft.methods.includes("online_card") &&
    draft.onlineProvider === "stripe" &&
    !isStripeReady(settings)
  );
}

function policyText(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function humanize(value: string): string {
  return value.replaceAll("_", " ");
}
