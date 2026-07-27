"use client";

import { useEffect, useState, type FormEvent } from "react";

import { getAuthSessionUser } from "@/services/auth/sessionStore";
import {
  hotelOperationsErrorMessage,
  hotelOperationsSetupApi,
  isStripeReady,
  type FinancePaymentSettings,
  type PaymentMethodChoice,
} from "@/services/api/hotelOperationsSetupClient";

import {
  OperationField,
  OperationFormLoadError,
  OperationFormLoading,
  OperationFormShell,
  operationInputClassName,
} from "./OperationFormShell";

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
  const [method, setMethod] = useState<PaymentMethodChoice>("pay_at_property");
  const [currency, setCurrency] = useState("EUR");
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

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setLoadError("");
    void hotelOperationsSetupApi
      .getPaymentSettings(propertyId, controller.signal)
      .then((loaded) => {
        setSettings(loaded);
        setCurrency(loaded.defaultCurrency || "EUR");
        setMethod(paymentMethodFromSettings(loaded));
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
    let paymentSettingsSaved = settingsSaved;
    setSubmitting(true);
    setError("");
    try {
      if (
        completionRefreshPending ||
        (settingsSaved && (method !== "stripe" || isStripeReady(settings)))
      ) {
        await refreshCompletion();
        return;
      }

      await onBeforeSave();
      const updated = settingsSaved
        ? settings
        : await hotelOperationsSetupApi.updatePaymentSettings(propertyId, method, currency);
      if (!settingsSaved) {
        setSettings(updated);
        setSettingsSaved(true);
        paymentSettingsSaved = true;
      }
      if (method !== "stripe" || isStripeReady(updated)) {
        await refreshCompletion();
        return;
      }

      setStripeOnboardingUrl("");
      const onboarding = await hotelOperationsSetupApi.startStripeOnboarding(propertyId, {
        email: stripeEmail,
        country: stripeCountry,
        providerAccountId: updated.providerAccount.providerAccountId,
      });
      setStripeOnboardingUrl(onboarding.onboardingUrl);
    } catch (cause) {
      setError(
        paymentSettingsSaved
          ? hotelOperationsErrorMessage(
              cause,
              "Your payment method is saved, but Stripe setup could not start.",
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

  const needsStripeAccount = method === "stripe" && !settings.providerAccount.providerAccountId;
  const stripePending = method === "stripe" && !isStripeReady(settings);
  const readyPaymentSaved = settingsSaved && (method !== "stripe" || isStripeReady(settings));

  return (
    <OperationFormShell
      error={error}
      notice={
        completionRefreshPending || readyPaymentSaved ? (
          "Your payment settings are saved. Retry the setup refresh to continue."
        ) : stripeOnboardingUrl ? (
          <div className="space-y-3">
            <p className="font-semibold">Finish connecting Stripe</p>
            <p>
              Stripe must confirm onboarding and enable charges before direct booking can go live.
            </p>
            <div className="flex flex-wrap gap-3">
              <a
                className="inline-flex min-h-10 items-center rounded-full bg-primary-600 px-4 py-2 font-semibold text-white hover:bg-primary-700 focus:outline-none focus:ring-2 focus:ring-primary-600 focus:ring-offset-2"
                href={stripeOnboardingUrl}
                rel="noreferrer"
                target="_blank"
              >
                Open Stripe
              </a>
              <button
                className="min-h-10 rounded-full border border-primary-300 bg-white px-4 py-2 font-semibold text-primary-800 hover:bg-primary-50 focus:outline-none focus:ring-2 focus:ring-primary-600 focus:ring-offset-2 disabled:opacity-60"
                disabled={checkingStripe}
                onClick={checkStripeStatus}
                type="button"
              >
                {checkingStripe ? "Checking..." : "Check Stripe status"}
              </button>
            </div>
          </div>
        ) : stripePending && settings.providerAccount.onboardingStatus !== "not_started" ? (
          `Stripe status: ${humanize(settings.providerAccount.onboardingStatus)}.`
        ) : null
      }
      onBack={onBack}
      onSubmit={handleSubmit}
      submitLabel={
        completionRefreshPending || readyPaymentSaved
          ? "Refresh setup progress"
          : method === "stripe"
            ? settingsSaved
              ? "Continue Stripe setup"
              : "Save and connect Stripe"
            : "Save payment method"
      }
      submitting={submitting}
      submittingLabel={
        completionRefreshPending || readyPaymentSaved ? "Refreshing..." : "Saving..."
      }
    >
      <fieldset className="space-y-3 sm:col-span-2">
        <legend className="text-sm font-semibold text-gray-900">How guests can pay</legend>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          <PaymentChoice
            checked={method === "pay_at_property"}
            description="Collect payment during the stay."
            label="Pay at property"
            onChange={() => {
              setMethod("pay_at_property");
              setSettingsSaved(false);
              setCompletionRefreshPending(false);
            }}
          />
          <PaymentChoice
            checked={method === "bank_transfer"}
            description="Confirm transfers manually."
            label="Bank transfer"
            onChange={() => {
              setMethod("bank_transfer");
              setSettingsSaved(false);
              setCompletionRefreshPending(false);
            }}
          />
          <PaymentChoice
            checked={method === "stripe"}
            description="Take card payments online."
            label="Stripe"
            onChange={() => {
              setMethod("stripe");
              setSettingsSaved(false);
              setCompletionRefreshPending(false);
            }}
          />
        </div>
      </fieldset>

      <OperationField label="Currency">
        <select
          className={operationInputClassName}
          onChange={(event) => {
            setCurrency(event.target.value);
            setSettingsSaved(false);
            setCompletionRefreshPending(false);
          }}
          value={currency}
        >
          <option value="EUR">EUR</option>
          <option value="CHF">CHF</option>
          <option value="GBP">GBP</option>
          <option value="USD">USD</option>
        </select>
      </OperationField>

      {method === "stripe" ? (
        <>
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
          <OperationField
            hint="Use the two-letter country code for the Stripe account."
            label="Stripe account country"
          >
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
        </>
      ) : null}
    </OperationFormShell>
  );
}

function PaymentChoice({
  checked,
  description,
  label,
  onChange,
}: {
  checked: boolean;
  description: string;
  label: string;
  onChange: () => void;
}) {
  return (
    <label
      className={`cursor-pointer rounded-xl border p-4 transition ${
        checked
          ? "border-primary-600 bg-primary-50"
          : "border-gray-300 bg-white hover:border-gray-400"
      }`}
    >
      <span className="flex items-start gap-3">
        <input
          checked={checked}
          className="mt-1 h-4 w-4 accent-primary-600"
          name="payment-method"
          onChange={onChange}
          type="radio"
        />
        <span>
          <span className="block text-sm font-semibold text-gray-950">{label}</span>
          <span className="mt-1 block text-xs leading-5 text-gray-600">{description}</span>
        </span>
      </span>
    </label>
  );
}

function paymentMethodFromSettings(settings: FinancePaymentSettings): PaymentMethodChoice {
  if (settings.acceptedMethods.includes("card")) return "stripe";
  if (settings.acceptedMethods.includes("bank_transfer")) return "bank_transfer";
  return "pay_at_property";
}

function humanize(value: string): string {
  return value.replaceAll("_", " ");
}
