"use client";

import { ArrowPathIcon, BuildingLibraryIcon, CreditCardIcon } from "@heroicons/react/24/outline";
import { SettingsCard, SettingsLayout, SettingsSection } from "@vayada/settings-ui";
import { useCallback, useEffect, useState, type FormEvent } from "react";

import Modal from "@/components/Modal";
import {
  BillingSkeleton,
  Field,
  inputClass,
  InvoiceList,
  PaymentChoice,
  PlanCard,
  primaryButton,
  secondaryButton,
} from "@/components/settings/BillingSettingsUi";
import { formatBillingAmount, formatInvoiceDate } from "@/lib/settings/billing";
import { getPmsSettingsSections } from "@/lib/settings/navigation";
import {
  activateFixedPlanByCard,
  activateFixedPlanByInvoice,
  getFinanceBilling,
  openBillingPortal,
  saveBillingDetails,
  savePaymentMethod,
  switchToCommissionNow,
  type BillingOverview,
  type BillingPaymentMethod,
  type BillingPlan,
} from "@/services/api/financeBillingClient";

export default function BillingSettingsPage() {
  const [billing, setBilling] = useState<BillingOverview | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [selectedMethod, setSelectedMethod] = useState<BillingPaymentMethod>("card");
  const [companyName, setCompanyName] = useState("");
  const [billingEmail, setBillingEmail] = useState("");
  const [taxId, setTaxId] = useState("");
  const [savingDetails, setSavingDetails] = useState(false);
  const [savingMethod, setSavingMethod] = useState(false);
  const [portalLoading, setPortalLoading] = useState(false);
  const [pendingPlan, setPendingPlan] = useState<BillingPlan | null>(null);
  const [switchingPlan, setSwitchingPlan] = useState(false);

  const hydrate = useCallback((next: BillingOverview) => {
    setBilling(next);
    setSelectedMethod(next.paymentMethod);
    setCompanyName(next.billingDetails.companyName);
    setBillingEmail(next.billingDetails.billingEmail);
    setTaxId(next.billingDetails.taxId ?? "");
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      hydrate(await getFinanceBilling());
    } catch (loadError) {
      setError(message(loadError, "We couldn’t load billing settings."));
    } finally {
      setLoading(false);
    }
  }, [hydrate]);

  useEffect(() => {
    void load();
  }, [load]);

  const confirmPlanSwitch = async () => {
    if (!pendingPlan || !billing) return;
    setSwitchingPlan(true);
    setError("");
    setNotice("");
    try {
      if (pendingPlan === "fixed") {
        if (selectedMethod !== billing.paymentMethod) {
          hydrate(await savePaymentMethod(selectedMethod));
        }
        if (selectedMethod === "bank_transfer") {
          hydrate(await activateFixedPlanByInvoice());
          setPendingPlan(null);
          setNotice("Your Fixed Fee plan is active. Stripe emailed an invoice due within 14 days.");
          return;
        }
        hydrate(await activateFixedPlanByCard());
        setPendingPlan(null);
        setNotice("Your Fixed Fee plan is active. Future direct bookings use the 0% rate.");
        return;
      }
      await switchToCommissionNow();
      setPendingPlan(null);
      setNotice("Your Commission plan is active. Future direct bookings use the 5% rate.");
      await load();
    } catch (switchError) {
      setError(message(switchError, "We couldn’t switch plans."));
    } finally {
      setSwitchingPlan(false);
    }
  };

  const saveDetails = async (event: FormEvent) => {
    event.preventDefault();
    setSavingDetails(true);
    setError("");
    setNotice("");
    try {
      hydrate(
        await saveBillingDetails({
          companyName: companyName.trim(),
          billingEmail: billingEmail.trim(),
          taxId: taxId.trim() || null,
        }),
      );
      setNotice("Billing details saved.");
    } catch (saveError) {
      setError(message(saveError, "We couldn’t save billing details."));
    } finally {
      setSavingDetails(false);
    }
  };

  const persistPaymentMethod = async () => {
    setSavingMethod(true);
    setError("");
    setNotice("");
    try {
      hydrate(await savePaymentMethod(selectedMethod));
      setNotice(
        selectedMethod === "card"
          ? "Card billing selected. Fixed Plan charges are automatic."
          : "Bank transfer selected. Invoices are due within 14 days.",
      );
    } catch (saveError) {
      setError(message(saveError, "We couldn’t save the payment method."));
    } finally {
      setSavingMethod(false);
    }
  };

  const updateCard = async () => {
    setPortalLoading(true);
    setError("");
    try {
      window.location.assign(await openBillingPortal());
    } catch (portalError) {
      setError(message(portalError, "We couldn’t open secure card settings."));
      setPortalLoading(false);
    }
  };

  return (
    <SettingsLayout
      title="Settings"
      description="Manage your property, operations, and account preferences."
      sections={getPmsSettingsSections(false)}
      activeId="billing"
    >
      {error && (
        <div
          role="alert"
          className="mb-4 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700"
        >
          {error}
        </div>
      )}
      {notice && (
        <div
          role="status"
          className="mb-4 rounded-lg border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-800"
        >
          {notice}
        </div>
      )}

      {loading ? (
        <BillingSkeleton />
      ) : billing ? (
        <>
          <SettingsSection
            id="billing-plan"
            title="Plan"
            description="Choose how you pay for vayada. Switch any time."
          >
            <div className="grid gap-4 lg:grid-cols-2">
              <PlanCard
                title="Commission"
                label="Percentage per direct booking"
                price="5%"
                priceSuffix="per direct booking"
                description=""
                benefits={[
                  "No monthly fee. Pay only when you earn",
                  "Unlimited rooms",
                  "Booking engine + PMS included",
                  "Charged with each payout",
                ]}
                current={billing.planStatus.plan === "commission"}
                onSwitch={() => setPendingPlan("commission")}
              />
              <PlanCard
                title="Fixed Fee"
                label="Flat monthly subscription"
                price={formatBillingAmount(
                  billing.planStatus.amountMinor,
                  billing.planStatus.currency,
                )}
                priceSuffix="per month"
                description={`At ${billing.planStatus.activeRoomCount} active ${billing.planStatus.activeRoomCount === 1 ? "room" : "rooms"}. Base + per-extra-room pricing.`}
                benefits={[
                  "0% commission on direct bookings",
                  "Base fee + per extra room",
                  "Best above ~$1,200 monthly direct revenue",
                ]}
                current={billing.planStatus.plan === "fixed"}
                disabled={!billing.planStatus.fixedPlanAvailable}
                onSwitch={() => setPendingPlan("fixed")}
              />
            </div>
          </SettingsSection>

          <SettingsSection
            id="payment-method"
            title="Payment method"
            description="How your commission or monthly fee is collected."
          >
            <div
              role="radiogroup"
              aria-label="Billing payment method"
              className="grid gap-3 sm:grid-cols-2"
            >
              <PaymentChoice
                selected={selectedMethod === "card"}
                icon={CreditCardIcon}
                title="Credit / debit card"
                description="Charged automatically on the 1st of each month."
                onClick={() => setSelectedMethod("card")}
              />
              <PaymentChoice
                selected={selectedMethod === "bank_transfer"}
                icon={BuildingLibraryIcon}
                title="Bank transfer"
                description="Invoice by email, payable within 14 days."
                onClick={() => setSelectedMethod("bank_transfer")}
              />
            </div>

            {selectedMethod === "card" && (
              <SettingsCard>
                <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
                  <div>
                    {billing.savedCard ? (
                      <>
                        <p className="text-sm font-semibold capitalize text-gray-900">
                          {billing.savedCard.brand} •••• {billing.savedCard.last4}
                        </p>
                        <p className="mt-1 text-[13px] text-gray-500">
                          Expires {String(billing.savedCard.expiryMonth).padStart(2, "0")}/
                          {billing.savedCard.expiryYear}
                          {billing.planStatus.nextBillingDate
                            ? ` · Next charge ${formatInvoiceDate(billing.planStatus.nextBillingDate)}`
                            : ""}
                        </p>
                      </>
                    ) : (
                      <>
                        <p className="text-sm font-semibold text-gray-900">No card saved</p>
                        <p className="mt-1 text-[13px] text-gray-500">
                          Add a card in Stripe’s secure billing portal.
                        </p>
                      </>
                    )}
                  </div>
                  <button
                    type="button"
                    onClick={() => void updateCard()}
                    disabled={!billing.planStatus.customerPortalAvailable || portalLoading}
                    className={secondaryButton}
                  >
                    {portalLoading ? "Opening…" : "Update card"}
                  </button>
                </div>
                {!billing.planStatus.customerPortalAvailable && (
                  <p className="mt-3 text-xs text-amber-700">
                    Save your billing details first to create secure billing access.
                  </p>
                )}
              </SettingsCard>
            )}

            <div className="flex justify-end">
              <button
                type="button"
                onClick={() => void persistPaymentMethod()}
                disabled={savingMethod || selectedMethod === billing.paymentMethod}
                className={primaryButton}
              >
                {savingMethod ? "Saving…" : "Save payment method"}
              </button>
            </div>
          </SettingsSection>

          <SettingsSection
            id="billing-details"
            title="Billing details"
            description="Shown on every invoice."
          >
            <SettingsCard>
              <form onSubmit={(event) => void saveDetails(event)} className="space-y-4">
                <Field label="Company / legal name" required>
                  <input
                    className={inputClass}
                    value={companyName}
                    onChange={(event) => setCompanyName(event.target.value)}
                    maxLength={200}
                    required
                  />
                </Field>
                <Field label="Billing email" required>
                  <input
                    className={inputClass}
                    type="email"
                    value={billingEmail}
                    onChange={(event) => setBillingEmail(event.target.value)}
                    maxLength={200}
                    required
                  />
                </Field>
                <Field label="VAT / Tax ID" hint="Optional">
                  <input
                    className={inputClass}
                    value={taxId}
                    onChange={(event) => setTaxId(event.target.value)}
                    maxLength={100}
                  />
                </Field>
                <div className="flex justify-end pt-1">
                  <button type="submit" disabled={savingDetails} className={primaryButton}>
                    {savingDetails ? "Saving…" : "Save billing details"}
                  </button>
                </div>
              </form>
            </SettingsCard>
          </SettingsSection>

          <SettingsSection id="invoices" title="Invoices" description="Download past invoices.">
            <InvoiceList invoices={billing.invoices} />
          </SettingsSection>
        </>
      ) : (
        <SettingsCard>
          <div className="py-6 text-center">
            <p className="text-sm text-gray-600">Billing settings are unavailable.</p>
            <button type="button" onClick={() => void load()} className={`${secondaryButton} mt-4`}>
              <ArrowPathIcon className="h-4 w-4" /> Retry
            </button>
          </div>
        </SettingsCard>
      )}

      {pendingPlan && billing && (
        <Modal
          ariaLabel="Confirm billing plan switch"
          onClose={() => !switchingPlan && setPendingPlan(null)}
        >
          <h2 className="text-lg font-semibold text-gray-900">
            Switch to the {pendingPlan === "fixed" ? "Fixed Fee" : "Commission"} plan?
          </h2>
          <p className="mt-3 text-sm leading-6 text-gray-600">
            Your new billing cycle starts today. Stripe applies a prorated adjustment when
            applicable, and future direct-booking commission becomes{" "}
            {pendingPlan === "fixed" ? "0%" : "5%"}.
          </p>
          {pendingPlan === "fixed" && (
            <p className="mt-3 text-sm text-gray-600">
              {selectedMethod === "bank_transfer"
                ? "Stripe will email your invoice immediately. Payment is due within 14 days."
                : "Stripe will charge your saved card now. Future charges are collected on the 1st."}
            </p>
          )}
          <div className="mt-6 flex justify-end gap-3">
            <button
              type="button"
              disabled={switchingPlan}
              onClick={() => setPendingPlan(null)}
              className={secondaryButton}
            >
              Cancel
            </button>
            <button
              type="button"
              disabled={switchingPlan}
              onClick={() => void confirmPlanSwitch()}
              className={primaryButton}
            >
              {switchingPlan ? "Switching…" : "Confirm switch"}
            </button>
          </div>
        </Modal>
      )}
    </SettingsLayout>
  );
}

function message(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}
