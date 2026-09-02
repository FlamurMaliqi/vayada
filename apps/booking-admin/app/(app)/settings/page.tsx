"use client";

import { useEffect, useState, useCallback, useRef } from "react";
import { getBookingHotelPropertyLink } from "@/services/api/bookingPropertyLinkClient";
import {
  buildFinancePaymentSettingsBody,
  createFinanceStripeDashboardLink,
  createFinanceStripeProviderAccount,
  FinancePaymentSettingsClientError,
  getFinancePaymentSettings,
  issueFinanceStripeOnboardingLink,
  reconcileFinanceStripeProviderAccount,
  updateFinancePaymentSettings,
  payAtHotelMethodsFromFinance,
  type FinancePaymentSettingsResponse,
} from "@/services/api/financePaymentSettingsClient";
import {
  createFixedPlanCheckout,
  getFinancePlanStatus,
  openFinanceCustomerPortal,
  switchToCommissionPlan,
  type FinancePlanStatus,
} from "@/services/api/financeSubscriptionsClient";
import {
  CalendarDaysIcon,
  CreditCardIcon,
  BanknotesIcon,
  GlobeAltIcon,
  PhoneIcon,
  ChatBubbleLeftIcon,
  EnvelopeIcon,
  MapPinIcon,
  ArrowTopRightOnSquareIcon,
} from "@heroicons/react/24/outline";
import { HotelIcon } from "@vayada/product-onboarding";
import {
  settingsService,
  type BookingAcceptanceMode,
  type PropertySettings,
  type PropertySettingsUpdate,
  type SameDayBookingSettings,
} from "@/services/settings";
import { ToggleSwitch, FeedbackAlert, SaveButton } from "@/components/ui";
import { CountrySelect } from "@/components/settings/CountrySelect";
import {
  SettingsLayout,
  SettingsSection,
  SettingsCard,
  type SettingsNavSection,
} from "@vayada/settings-ui";
import { SameDayBookingCard } from "@/components/settings/SameDayBookingCard";
import { useTranslation } from "@/lib/i18n";
import {
  buildSettingsSectionUrl,
  readSettingsSection,
  type SettingsSectionId,
} from "@/lib/utils/settingsSectionUrl";
import { continueStripeAfterSavingSettings } from "@/lib/utils/stripeOnboarding";
import {
  coordinateStripeRefresh,
  refreshStripeAfterOnboarding,
  tryMarkStripeOnboardingStarted,
  watchStripeOnboardingRefresh,
} from "@/lib/utils/stripeOnboardingRefresh";

// Audit-driven section IDs (VAY-400):
// - "payments" separates Stripe Connect + Xendit from billing (billing = what
//   the hotel pays Vayada; payments = how the hotel collects from guests).
type Section = SettingsSectionId;

const BILLING_SETTINGS_UNAVAILABLE = "Billing settings are not available on next-api yet.";
const STRIPE_DASHBOARD_ERROR =
  "Couldn't open your Stripe Dashboard right now. Please try again in a moment.";
const STRIPE_NOT_CONNECTED =
  "Your Stripe account isn't connected. Connect Stripe in your payment settings to access the dashboard.";

function readBookingHotelId(settings: PropertySettings): string {
  if (settings.id?.trim()) return settings.id.trim();
  if (typeof window === "undefined") return "";
  return localStorage.getItem("selectedHotelId")?.trim() ?? "";
}

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

function isFinanceStripeReady(response: FinancePaymentSettingsResponse): boolean {
  const account = response.paymentSettings.providerAccount;
  return (
    account.provider === "stripe" &&
    account.status === "active" &&
    account.onboardingStatus === "completed" &&
    account.chargesEnabled &&
    account.payoutsEnabled &&
    account.capabilities.includes("card_payments")
  );
}

function formatBillingAmount(amountMinor: number): string {
  return new Intl.NumberFormat(undefined, { style: "currency", currency: "EUR" }).format(
    amountMinor / 100,
  );
}

function formatBillingDate(value: string | null): string {
  return value
    ? new Date(value).toLocaleDateString(undefined, {
        day: "numeric",
        month: "long",
        year: "numeric",
      })
    : "—";
}

function toSettingsPaymentProvider(
  provider: string | null | undefined,
): "stripe" | "xendit" | "vayada" {
  if (provider === "xendit" || provider === "vayada") return provider;
  return "stripe";
}

function paymentPolicyText(policy: unknown, key: string): string {
  const value =
    policy && typeof policy === "object" && !Array.isArray(policy)
      ? (policy as Record<string, unknown>)[key]
      : undefined;
  return typeof value === "string" ? value : "";
}

function paymentPolicyNumber(policy: unknown, key: string, fallback: number): number {
  const value =
    policy && typeof policy === "object" && !Array.isArray(policy)
      ? (policy as Record<string, unknown>)[key]
      : undefined;
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

const DEFAULT_SETTINGS: PropertySettings = {
  slug: "",
  property_name: "",
  reservation_email: "",
  phone_number: "",
  whatsapp_number: "",
  address: "",
  default_currency: "EUR",
  default_language: "en",
  supported_currencies: [],
  supported_languages: [],
  check_in_time: "15:00",
  check_out_time: "11:00",
  pay_at_property_enabled: false,
  pay_at_hotel_methods: ["cash", "card"],
  online_card_payment: false,
  bank_transfer: false,
  paypal_enabled: false,
  paypal_email: "",
  paypal_payment_window_hours: 24,
  free_cancellation_days: 7,
  email_notifications: true,
  new_booking_alerts: true,
  payment_alerts: true,
  ota_booking_alerts: false,
  billing_active_plan: "commission",
  billing_commission_rate: 5,
  billing_fixed_fee: 49,
  billing_pending_switch: null,
  billing_switch_effective_date: null,
  payout_account_holder: "",
  payout_account_type: "iban",
  payout_iban: "",
  payout_account_number: "",
  payout_bank_name: "",
  payout_swift: "",
  terms_text: "",
  cancellation_policy_text: "",
};

type TargetSettingsUpdate =
  | { ok: true; data: PropertySettingsUpdate }
  | { ok: false; message: string };

function buildTargetSettingsUpdate(
  section: Section,
  settings: PropertySettings,
): TargetSettingsUpdate {
  if (section === "property") {
    return {
      ok: true,
      data: {
        property_name: settings.property_name,
        reservation_email: settings.reservation_email,
        phone_number: settings.phone_number,
        whatsapp_number: settings.whatsapp_number,
        address: settings.address,
        city: settings.city,
        country: settings.country,
        instagram: settings.instagram,
        facebook: settings.facebook,
        tiktok: settings.tiktok,
        youtube: settings.youtube,
      },
    };
  }

  if (section === "booking") {
    return {
      ok: true,
      data: {
        terms_text: settings.terms_text,
        cancellation_policy_text: settings.cancellation_policy_text,
      },
    };
  }

  if (section === "billing") {
    return {
      ok: false,
      message: BILLING_SETTINGS_UNAVAILABLE,
    };
  }

  return { ok: false, message: "This settings section is not saved by property settings." };
}

export default function SettingsPage() {
  const { t } = useTranslation();
  const [activeSection, setActiveSection] = useState<Section>("property");
  const selectSection = useCallback((section: Section) => {
    setActiveSection(section);
    const nextUrl = buildSettingsSectionUrl(window.location.href, section);
    const currentUrl = `${window.location.pathname}${window.location.search}${window.location.hash}`;
    if (nextUrl !== currentUrl) window.history.pushState(null, "", nextUrl);
  }, []);

  useEffect(() => {
    const syncSectionFromUrl = () => setActiveSection(readSettingsSection(window.location.search));
    syncSectionFromUrl();
    window.addEventListener("popstate", syncSectionFromUrl);
    return () => window.removeEventListener("popstate", syncSectionFromUrl);
  }, []);
  const [settings, setSettings] = useState<PropertySettings>(DEFAULT_SETTINGS);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [acceptanceMode, setAcceptanceMode] = useState<BookingAcceptanceMode | null>(null);
  const [acceptanceLoading, setAcceptanceLoading] = useState(true);
  const [acceptanceSaving, setAcceptanceSaving] = useState(false);
  const [acceptanceError, setAcceptanceError] = useState("");
  const [sameDaySettings, setSameDaySettings] = useState<SameDayBookingSettings | null>(null);
  const [sameDayLoading, setSameDayLoading] = useState(true);
  const [sameDaySaving, setSameDaySaving] = useState(false);
  const [sameDayError, setSameDayError] = useState("");
  const [feedback, setFeedback] = useState<{ type: "success" | "error"; message: string } | null>(
    null,
  );

  // Stripe Connect / Payments
  const [stripeAccountId, setStripeAccountId] = useState<string | null>(null);
  const [stripeOnboarded, setStripeOnboarded] = useState(false);
  const [openingStripeDashboard, setOpeningStripeDashboard] = useState(false);
  const [stripeDashboardToast, setStripeDashboardToast] = useState("");
  const [connectEmail] = useState(() =>
    typeof window !== "undefined" ? localStorage.getItem("userEmail") || "" : "",
  );
  const [connectCountry, setConnectCountry] = useState("AT");
  const [creatingAccount, setCreatingAccount] = useState(false);
  const [issuingStripeOnboardingLink, setIssuingStripeOnboardingLink] = useState(false);
  const stripeOnboardingLinkPending = useRef(false);
  const [refreshingStripe, setRefreshingStripe] = useState(false);
  const stripeRefreshAbort = useRef<AbortController | null>(null);
  const paymentSettingsLoadVersion = useRef(0);
  const [stripeAccountCreationBlocked, setStripeAccountCreationBlocked] = useState(false);
  const [paymentProvider, setPaymentProvider] = useState<"stripe" | "xendit" | "vayada">("stripe");
  const [xenditChannelCode, setXenditChannelCode] = useState("ID_BCA");
  const [xenditAccountNumber, setXenditAccountNumber] = useState("");
  const [xenditAccountHolderName, setXenditAccountHolderName] = useState("");
  const [paymentError, setPaymentError] = useState("");
  const [paymentSuccess, setPaymentSuccess] = useState("");
  const [savingPayment, setSavingPayment] = useState(false);
  const [paymentSettingsLoaded, setPaymentSettingsLoaded] = useState(false);
  const [billingPropertyId, setBillingPropertyId] = useState<string | null>(null);
  const [financePlanStatus, setFinancePlanStatus] = useState<FinancePlanStatus | null>(null);
  const [billingPlanLoading, setBillingPlanLoading] = useState(true);
  const [billingPlanAction, setBillingPlanAction] = useState<
    "checkout" | "portal" | "commission" | null
  >(null);
  const [billingPlanModal, setBillingPlanModal] = useState<"fixed" | "commission" | null>(null);
  const [billingPlanError, setBillingPlanError] = useState("");
  const [billingPlanConfirmation, setBillingPlanConfirmation] = useState("");

  const fetchSettings = useCallback(async (): Promise<PropertySettings | null> => {
    try {
      setLoading(true);
      const data = await settingsService.getPropertySettings();
      setSettings(data);
      return data;
    } catch {
      setFeedback({ type: "error", message: t("settings.feedback.loadError") });
      return null;
    } finally {
      setLoading(false);
    }
  }, [t]);

  const loadBookingAcceptance = useCallback(async (hotelId: string) => {
    setAcceptanceLoading(true);
    setAcceptanceMode(null);
    setAcceptanceError("");
    try {
      const result = await settingsService.getBookingAcceptance(hotelId);
      setAcceptanceMode(result.acceptanceMode);
    } catch (error) {
      setAcceptanceError(errorMessage(error, "Booking acceptance settings failed to load."));
    } finally {
      setAcceptanceLoading(false);
    }
  }, []);

  const loadSameDayBooking = useCallback(async (hotelId: string) => {
    setSameDayLoading(true);
    setSameDaySettings(null);
    setSameDayError("");
    try {
      setSameDaySettings(await settingsService.getSameDayBooking(hotelId));
    } catch (error) {
      setSameDayError(errorMessage(error, "Same-day booking settings failed to load."));
    } finally {
      setSameDayLoading(false);
    }
  }, []);

  const applyFinancePaymentSettings = useCallback((res: FinancePaymentSettingsResponse) => {
    const ps = res.paymentSettings;
    const providerAccount = ps.providerAccount;
    const stripeAccountId =
      providerAccount.provider === "stripe" &&
      !providerAccount.providerAccountId?.startsWith("settings-choice:")
        ? providerAccount.providerAccountId
        : null;
    setStripeAccountId(stripeAccountId);
    setStripeOnboarded(isFinanceStripeReady(res));
    setPaymentProvider(toSettingsPaymentProvider(ps.paymentProvider));
    setXenditChannelCode("ID_BCA");
    setXenditAccountNumber("");
    setXenditAccountHolderName("");
    setSettings((prev) => ({
      ...prev,
      pay_at_property_enabled: ps.acceptedMethods.includes("pay_at_property"),
      pay_at_hotel_methods: payAtHotelMethodsFromFinance(ps.acceptedMethods),
      online_card_payment:
        ps.acceptedMethods.includes("card") || ps.acceptedMethods.includes("xendit"),
      bank_transfer: ps.acceptedMethods.includes("bank_transfer"),
      paypal_enabled: ps.acceptedMethods.includes("paypal"),
      paypal_email: paymentPolicyText(ps.depositPolicy, "paypalEmail"),
      paypal_payment_window_hours: paymentPolicyNumber(
        ps.depositPolicy,
        "paypalPaymentWindowHours",
        24,
      ),
      payout_bank_name: paymentPolicyText(ps.depositPolicy, "bankName"),
      payout_account_holder: paymentPolicyText(ps.depositPolicy, "accountHolder"),
      payout_account_type: "account_number",
      payout_account_number: paymentPolicyText(ps.depositPolicy, "accountNumber"),
      payout_swift: paymentPolicyText(ps.depositPolicy, "bicSwift"),
    }));
    setPaymentSettingsLoaded(true);
  }, []);

  useEffect(() => {
    const paymentSettingsVersion = ++paymentSettingsLoadVersion.current;
    const stripeReturn = new URLSearchParams(window.location.search).get("stripe");
    if (stripeReturn === "return" || stripeReturn === "refresh") {
      setStripeAccountCreationBlocked(true);
    }
    setPaymentSettingsLoaded(false);
    setBillingPlanLoading(true);
    setAcceptanceLoading(true);
    setAcceptanceMode(null);
    setAcceptanceError("");
    setSameDayLoading(true);
    setSameDaySettings(null);
    setSameDayError("");
    const propertyPromise = fetchSettings();
    propertyPromise
      .then(async (property) => {
        if (!property) {
          setBillingPlanLoading(false);
          setAcceptanceLoading(false);
          setAcceptanceError("Select a hotel before loading booking acceptance settings.");
          setSameDayLoading(false);
          setSameDayError("Select a hotel before loading same-day booking settings.");
          return null;
        }
        const hotelId = readBookingHotelId(property);
        if (!hotelId) {
          setBillingPlanLoading(false);
          setAcceptanceLoading(false);
          setAcceptanceError("Select a hotel before loading booking acceptance settings.");
          setSameDayLoading(false);
          setSameDayError("Select a hotel before loading same-day booking settings.");
          return null;
        }
        void loadBookingAcceptance(hotelId);
        void loadSameDayBooking(hotelId);
        const propertyLink = await getBookingHotelPropertyLink({ hotelId });
        setBillingPropertyId(propertyLink.propertyId);
        const billingReturn =
          typeof window === "undefined"
            ? null
            : new URLSearchParams(window.location.search).get("billing");
        const paymentSettingsPromise = getFinancePaymentSettings({
          propertyId: propertyLink.propertyId,
        });
        const planStatusPromise = (async () => {
          try {
            let plan = await getFinancePlanStatus(propertyLink.propertyId);
            if (billingReturn === "success") {
              for (
                let attempt = 0;
                attempt < 10 && plan.planStatus.plan !== "fixed";
                attempt += 1
              ) {
                await new Promise((resolve) => window.setTimeout(resolve, 1_000));
                plan = await getFinancePlanStatus(propertyLink.propertyId);
              }
              setBillingPlanConfirmation(
                plan.planStatus.plan === "fixed"
                  ? "Fixed Plan is active."
                  : "Payment received. Your Fixed Plan is still being confirmed.",
              );
            } else if (billingReturn === "canceled") {
              setBillingPlanError("Payment failed. Please try again or use a different card.");
            }
            setFinancePlanStatus(plan.planStatus);
          } catch (error) {
            setBillingPlanError(errorMessage(error, "Billing plan failed to load."));
          } finally {
            setBillingPlanLoading(false);
          }
        })();
        const [, paymentSettings] = await Promise.all([planStatusPromise, paymentSettingsPromise]);
        return paymentSettings;
      })
      .then((paymentSettings) => {
        if (paymentSettingsVersion !== paymentSettingsLoadVersion.current) return;
        if (!paymentSettings) {
          setPaymentSettingsLoaded(true);
          return;
        }
        applyFinancePaymentSettings(paymentSettings);
      })
      .catch((err: unknown) => {
        if (paymentSettingsVersion !== paymentSettingsLoadVersion.current) return;
        setPaymentSettingsLoaded(false);
        setBillingPlanLoading(false);
        setPaymentError(errorMessage(err, "Payment settings failed to load."));
      });
  }, [applyFinancePaymentSettings, fetchSettings, loadBookingAcceptance, loadSameDayBooking]);

  const refreshStripeOnboarding = useCallback(
    async (
      flowId?: string,
      mode: "reconcile" | "reload" = "reconcile",
    ): Promise<"settled" | "aborted"> => {
      if (!billingPropertyId || stripeRefreshAbort.current) return "aborted";
      const controller = new AbortController();
      stripeRefreshAbort.current = controller;
      const paymentSettingsVersion = ++paymentSettingsLoadVersion.current;
      setStripeAccountCreationBlocked(true);
      setRefreshingStripe(true);
      setPaymentError("");
      setPaymentSuccess("");
      try {
        const paymentSettings =
          mode === "reload"
            ? await getFinancePaymentSettings({ propertyId: billingPropertyId })
            : await coordinateStripeRefresh(
                {
                  propertyId: billingPropertyId,
                  flowId,
                  signal: controller.signal,
                  locks: navigator.locks,
                },
                {
                  run: async (claimedFlowId) => {
                    const result = await refreshStripeAfterOnboarding(
                      { propertyId: billingPropertyId, signal: controller.signal },
                      {
                        reconcile: (propertyId, attempt) =>
                          reconcileFinanceStripeProviderAccount({
                            propertyId,
                            commandId: `${claimedFlowId}:attempt:${attempt + 1}`,
                          }),
                        loadPaymentSettings: (propertyId) =>
                          getFinancePaymentSettings({ propertyId }),
                      },
                    );
                    return result.paymentSettings;
                  },
                  reload: () => getFinancePaymentSettings({ propertyId: billingPropertyId }),
                },
              );
        if (controller.signal.aborted) return "aborted";
        if (paymentSettingsVersion === paymentSettingsLoadVersion.current) {
          applyFinancePaymentSettings(paymentSettings);
        }
        if (isFinanceStripeReady(paymentSettings)) {
          setStripeAccountCreationBlocked(false);
          setPaymentSuccess("Stripe is connected.");
        } else {
          setPaymentError("Stripe setup is still pending. Complete onboarding or check again.");
        }
        return "settled";
      } catch (error) {
        if (controller.signal.aborted || (error instanceof Error && error.name === "AbortError")) {
          return "aborted";
        }
        setPaymentError("Couldn't refresh Stripe status. Check again in a moment.");
        return "settled";
      } finally {
        if (stripeRefreshAbort.current === controller) {
          stripeRefreshAbort.current = null;
          setRefreshingStripe(false);
        }
      }
    },
    [applyFinancePaymentSettings, billingPropertyId],
  );

  useEffect(() => {
    if (!billingPropertyId) return;
    const search = new URLSearchParams(window.location.search);
    const stripeReturn = search.get("stripe");
    const isStripeReturn = stripeReturn === "return" || stripeReturn === "refresh";
    if (isStripeReturn) {
      setActiveSection("payments");
      search.delete("stripe");
      search.set("section", "payments");
      window.history.replaceState(
        null,
        "",
        `${window.location.pathname}?${search.toString()}${window.location.hash}`,
      );
    }
    const stopWatching = watchStripeOnboardingRefresh({
      propertyId: billingPropertyId,
      isStripeReturn,
      target: window,
      store: window.localStorage,
      onRefresh: (flowId, mode) => refreshStripeOnboarding(flowId, mode),
    });
    return () => {
      stopWatching();
      stripeRefreshAbort.current?.abort();
      stripeRefreshAbort.current = null;
    };
  }, [billingPropertyId, refreshStripeOnboarding]);

  const handleAcceptanceToggle = async () => {
    const hotelId = readBookingHotelId(settings);
    if (!hotelId || !acceptanceMode) {
      setAcceptanceError("Load the current booking acceptance setting before changing it.");
      return;
    }

    setAcceptanceSaving(true);
    setAcceptanceError("");
    try {
      const saved = await settingsService.updateBookingAcceptance(
        acceptanceMode === "instant" ? "request" : "instant",
        hotelId,
      );
      setAcceptanceMode(saved.acceptanceMode);
      setFeedback({ type: "success", message: "Booking acceptance settings saved." });
    } catch (error) {
      setAcceptanceError(errorMessage(error, "Booking acceptance settings could not be saved."));
    } finally {
      setAcceptanceSaving(false);
    }
  };

  const retryBookingAcceptance = () => {
    const hotelId = readBookingHotelId(settings);
    if (hotelId) void loadBookingAcceptance(hotelId);
  };

  const saveSameDayBooking = async (enabled: boolean, cutoffLocalTime: string | null) => {
    const hotelId = readBookingHotelId(settings);
    if (!hotelId || !sameDaySettings) {
      setSameDayError("Load the current same-day booking setting before changing it.");
      return;
    }
    setSameDaySaving(true);
    setSameDayError("");
    setFeedback(null);
    try {
      setSameDaySettings(
        await settingsService.updateSameDayBooking(enabled, cutoffLocalTime, hotelId),
      );
      setFeedback({ type: "success", message: "Same-day booking settings saved." });
    } catch (error) {
      setSameDayError(errorMessage(error, "Same-day booking settings could not be saved."));
    } finally {
      setSameDaySaving(false);
    }
  };

  const retrySameDayBooking = () => {
    const hotelId = readBookingHotelId(settings);
    if (hotelId) void loadSameDayBooking(hotelId);
  };

  const handleCreateStripeAccount = async () => {
    if (!connectEmail) return;
    const stripeTab = window.open("about:blank", "vayada-stripe-connect");
    if (!stripeTab) {
      setPaymentError("Allow pop-ups to continue to Stripe setup.");
      return;
    }
    stripeTab.opener = null;
    setCreatingAccount(true);
    setPaymentError("");
    try {
      const hotelId = readBookingHotelId(settings);
      if (!hotelId) {
        stripeTab.close();
        setPaymentError("Select a hotel before creating a Stripe account.");
        return;
      }
      let onboardingPropertyId = "";
      const result = await continueStripeAfterSavingSettings({
        saveSettings: () => savePaymentProviderSettings(),
        continueStripe: (propertyId) => {
          onboardingPropertyId = propertyId;
          return createFinanceStripeProviderAccount({
            propertyId,
            email: connectEmail,
            country: connectCountry,
            commandPrefix: `settings-stripe-account-${hotelId}`,
          });
        },
      });
      if (!result) {
        stripeTab.close();
        return;
      }
      setStripeAccountId(result.providerAccountId);
      const trackingFlowId = tryMarkStripeOnboardingStarted(
        onboardingPropertyId,
        window.localStorage,
      );
      stripeTab.location.assign(result.onboardingUrl);
      if (!trackingFlowId) {
        setStripeAccountCreationBlocked(true);
        setPaymentError(
          "Stripe setup opened, but automatic status tracking is unavailable. Check Stripe status when you return.",
        );
      }
    } catch (err: unknown) {
      stripeTab.close();
      const msg =
        err instanceof TypeError
          ? t("settings.billing.errorPaymentServerUnreachable")
          : t("settings.billing.errorAccountCreate");
      setPaymentError(msg);
    } finally {
      setCreatingAccount(false);
    }
  };

  const handleOnboarding = async () => {
    if (stripeOnboardingLinkPending.current) return;
    stripeOnboardingLinkPending.current = true;
    setIssuingStripeOnboardingLink(true);
    const stripeTab = window.open("about:blank", "vayada-stripe-connect");
    if (!stripeTab) {
      stripeOnboardingLinkPending.current = false;
      setIssuingStripeOnboardingLink(false);
      setPaymentError("Allow pop-ups to continue to Stripe setup.");
      return;
    }
    stripeTab.opener = null;
    try {
      const hotelId = readBookingHotelId(settings);
      if (!hotelId || !stripeAccountId) {
        stripeTab.close();
        setPaymentError("Select a hotel and create a Stripe account before onboarding.");
        return;
      }
      const propertyLink = await getBookingHotelPropertyLink({ hotelId });
      const link = await issueFinanceStripeOnboardingLink({
        propertyId: propertyLink.propertyId,
        providerAccountId: stripeAccountId,
        commandPrefix: `settings-stripe-onboarding-${hotelId}`,
      });
      const trackingFlowId = tryMarkStripeOnboardingStarted(
        propertyLink.propertyId,
        window.localStorage,
      );
      stripeTab.location.assign(link.onboardingUrl);
      if (!trackingFlowId) {
        setStripeAccountCreationBlocked(true);
        setPaymentError(
          "Stripe setup opened, but automatic status tracking is unavailable. Check Stripe status when you return.",
        );
      }
    } catch {
      stripeTab.close();
      setPaymentError(t("settings.billing.errorOnboardingLink"));
    } finally {
      stripeOnboardingLinkPending.current = false;
      setIssuingStripeOnboardingLink(false);
    }
  };

  const handleStripeDashboard = async () => {
    setStripeDashboardToast("");
    if (!billingPropertyId || !stripeAccountId) {
      setStripeDashboardToast(STRIPE_NOT_CONNECTED);
      return;
    }

    const stripeTab = window.open("about:blank", "_blank");
    if (!stripeTab) {
      setStripeDashboardToast(STRIPE_DASHBOARD_ERROR);
      return;
    }
    stripeTab.opener = null;
    setOpeningStripeDashboard(true);
    try {
      const { url } = await createFinanceStripeDashboardLink({
        propertyId: billingPropertyId,
      });
      stripeTab.location.assign(url);
    } catch (error) {
      stripeTab.close();
      setStripeDashboardToast(
        error instanceof FinancePaymentSettingsClientError &&
          error.code === "provider_account_not_found"
          ? STRIPE_NOT_CONNECTED
          : STRIPE_DASHBOARD_ERROR,
      );
    } finally {
      setOpeningStripeDashboard(false);
    }
  };

  const savePaymentProviderSettings = async (showPageFeedback = false): Promise<string | null> => {
    setSavingPayment(true);
    setPaymentError("");
    setPaymentSuccess("");
    const fail = (message: string) => {
      setPaymentError(message);
      if (showPageFeedback) setFeedback({ type: "error", message });
    };
    try {
      if (!paymentSettingsLoaded) {
        fail("Payment settings did not load. Refresh before saving payments.");
        return null;
      }
      if (paymentProvider === "xendit" || paymentProvider === "vayada") {
        fail(`${paymentProvider === "xendit" ? "Xendit" : "vayada Payments"} is coming soon.`);
        return null;
      }
      const hotelId = readBookingHotelId(settings);
      if (!hotelId) {
        fail("Select a hotel before saving payment settings.");
        return null;
      }
      const propertyLink = await getBookingHotelPropertyLink({ hotelId });
      await updateFinancePaymentSettings({
        propertyId: propertyLink.propertyId,
        body: buildFinancePaymentSettingsBody({
          payAtPropertyEnabled: settings.pay_at_property_enabled,
          payAtHotelMethods: settings.pay_at_hotel_methods,
          onlineCardPayment: settings.online_card_payment ?? false,
          bankTransfer: settings.bank_transfer ?? false,
          paypalEnabled: settings.paypal_enabled ?? false,
          paypalEmail: settings.paypal_email,
          paypalPaymentWindowHours: settings.paypal_payment_window_hours,
          payoutAccountHolder: settings.payout_account_holder,
          payoutAccountType: settings.payout_account_type,
          payoutIban: settings.payout_iban,
          payoutAccountNumber: settings.payout_account_number,
          payoutBankName: settings.payout_bank_name,
          payoutSwift: settings.payout_swift,
          paymentProvider,
          defaultCurrency: settings.default_currency,
          commandPrefix: `settings-payment-settings-${hotelId}`,
        }),
      });
      const message = t("settings.billing.paymentSettingsSaved");
      setPaymentSuccess(message);
      if (showPageFeedback) setFeedback({ type: "success", message });
      return propertyLink.propertyId;
    } catch {
      fail(t("settings.billing.errorPaymentSaveFailed"));
      return null;
    } finally {
      setSavingPayment(false);
    }
  };

  const handleSave = async () => {
    if (activeSection === "billing") {
      setFeedback(null);
      setSaving(true);
      try {
        await savePaymentProviderSettings(true);
      } finally {
        setSaving(false);
      }
      return;
    }

    const paypalEmail = (settings.paypal_email || "").trim();
    const normalizedSettings =
      paypalEmail === (settings.paypal_email || "")
        ? settings
        : { ...settings, paypal_email: paypalEmail };
    const targetSettingsUpdate = buildTargetSettingsUpdate(activeSection, normalizedSettings);
    if (!targetSettingsUpdate.ok) {
      setFeedback({ type: "error", message: targetSettingsUpdate.message });
      return;
    }

    try {
      setSaving(true);
      setFeedback(null);
      const data = await settingsService.updatePropertySettings(targetSettingsUpdate.data);
      setSettings(data);
      setFeedback({ type: "success", message: t("settings.feedback.saveSuccess") });
    } catch (err: unknown) {
      setFeedback({ type: "error", message: errorMessage(err, t("settings.feedback.saveError")) });
    } finally {
      setSaving(false);
    }
  };

  const startFixedPlanCheckout = async () => {
    if (!billingPropertyId) return;
    try {
      setBillingPlanAction("checkout");
      setBillingPlanError("");
      const result = await createFixedPlanCheckout({
        propertyId: billingPropertyId,
      });
      window.location.assign(result.checkout.checkoutUrl);
    } catch (error) {
      setBillingPlanModal(null);
      setBillingPlanError(
        errorMessage(error, "Payment failed. Please try again or use a different card."),
      );
    } finally {
      setBillingPlanAction(null);
    }
  };

  const manageFixedPlanBilling = async () => {
    if (!billingPropertyId) return;
    try {
      setBillingPlanAction("portal");
      setBillingPlanError("");
      const result = await openFinanceCustomerPortal({ propertyId: billingPropertyId });
      window.location.assign(result.customerPortal.portalUrl);
    } catch (error) {
      setBillingPlanError(errorMessage(error, "Stripe billing could not be opened."));
    } finally {
      setBillingPlanAction(null);
    }
  };

  const scheduleCommissionPlan = async () => {
    if (!billingPropertyId) return;
    try {
      setBillingPlanAction("commission");
      setBillingPlanError("");
      const result = await switchToCommissionPlan({ propertyId: billingPropertyId });
      setFinancePlanStatus(result.planStatus);
      setBillingPlanModal(null);
      setBillingPlanConfirmation(
        `Your Fixed Plan remains active through ${formatBillingDate(result.planStatus.currentPeriodEnd)}.`,
      );
    } catch (error) {
      setBillingPlanModal(null);
      setBillingPlanError(errorMessage(error, "The plan change could not be scheduled."));
    } finally {
      setBillingPlanAction(null);
    }
  };

  const updateSetting = <K extends keyof PropertySettings>(key: K, value: PropertySettings[K]) => {
    setSettings({ ...settings, [key]: value });
  };

  const sections: SettingsNavSection[] = [
    { id: "property", label: t("settings.tabs.property"), icon: HotelIcon },
    { id: "booking", label: t("settings.tabs.booking"), icon: CalendarDaysIcon },
    // TODO i18n: add settings.tabs.payments to messages/*.json.
    // Hardcoded English until then.
    { id: "billing", label: t("settings.tabs.billing"), icon: CreditCardIcon },
    { id: "payments", label: "Payments", icon: BanknotesIcon },
  ];

  return (
    <SettingsLayout
      title={t("settings.title")}
      description={t("settings.subtitle")}
      sections={sections}
      activeId={activeSection}
      onSelect={(id) => selectSection(id as Section)}
    >
      {stripeDashboardToast && (
        <div className="fixed right-4 top-4 z-50 w-[min(24rem,calc(100vw-2rem))]" role="alert">
          <FeedbackAlert type="error" message={stripeDashboardToast} />
        </div>
      )}

      {/* Feedback banner */}
      {feedback && (
        <FeedbackAlert type={feedback.type} message={feedback.message} className="mb-4" />
      )}

      {/* Property tab */}
      {activeSection === "property" && (
        <div className="mt-5 space-y-4">
          {loading ? (
            <div className="flex items-center justify-center py-10">
              <div className="w-5 h-5 border-2 border-primary-500 border-t-transparent rounded-full animate-spin" />
            </div>
          ) : (
            <>
              {/* Property Information card */}
              <div className="bg-white rounded-lg border border-gray-200 p-4 md:p-5">
                <h2 className="text-sm font-semibold text-gray-900">
                  {t("settings.property.propertyInfo")}
                </h2>
                <p className="text-[13px] text-gray-500 mt-0.5 mb-3">
                  {t("settings.property.propertyInfoDesc")}
                </p>
                <div className="space-y-3">
                  <div>
                    <label className="block text-[13px] font-medium text-gray-700 mb-0.5">
                      {t("settings.property.nameLabel")}
                    </label>
                    <input
                      type="text"
                      value={settings.property_name}
                      onChange={(e) => updateSetting("property_name", e.target.value)}
                      className="w-full px-2.5 py-1.5 border border-gray-300 rounded-lg text-[13px] focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-transparent"
                      placeholder={t("settings.property.namePlaceholder")}
                    />
                  </div>
                  <div>
                    <label className="block text-[13px] font-medium text-gray-700 mb-0.5">
                      {t("settings.property.addressLabel")}
                    </label>
                    <div className="relative">
                      <MapPinIcon className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-gray-400" />
                      <input
                        type="text"
                        value={settings.address}
                        onChange={(e) => updateSetting("address", e.target.value)}
                        className="w-full pl-8 pr-2.5 py-1.5 border border-gray-300 rounded-lg text-[13px] focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-transparent"
                        placeholder={t("settings.property.addressPlaceholder")}
                      />
                    </div>
                  </div>
                </div>
              </div>

              {/* Contact Information card */}
              <div className="bg-white rounded-lg border border-gray-200 p-4 md:p-5">
                <div className="flex items-center gap-1.5 mb-0.5">
                  <PhoneIcon className="w-4 h-4 text-gray-700" />
                  <h2 className="text-sm font-semibold text-gray-900">
                    {t("settings.property.contactTitle")}
                  </h2>
                </div>
                <p className="text-[13px] text-gray-500 mb-3">
                  {t("settings.property.contactSubtitle")}
                </p>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                  <div>
                    <label className="block text-[13px] font-medium text-gray-700 mb-0.5">
                      {t("settings.property.phoneLabel")}
                    </label>
                    <div className="relative">
                      <PhoneIcon className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-gray-400" />
                      <input
                        type="tel"
                        value={settings.phone_number}
                        onChange={(e) => updateSetting("phone_number", e.target.value)}
                        className="w-full pl-8 pr-2.5 py-1.5 border border-gray-300 rounded-lg text-[13px] focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-transparent"
                        placeholder={t("settings.property.phonePlaceholder")}
                      />
                    </div>
                  </div>
                  <div>
                    <label className="block text-[13px] font-medium text-gray-700 mb-0.5">
                      {t("settings.property.whatsappLabel")}
                    </label>
                    <div className="relative">
                      <ChatBubbleLeftIcon className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-gray-400" />
                      <input
                        type="tel"
                        value={settings.whatsapp_number}
                        onChange={(e) => updateSetting("whatsapp_number", e.target.value)}
                        className="w-full pl-8 pr-2.5 py-1.5 border border-gray-300 rounded-lg text-[13px] focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-transparent"
                        placeholder={t("settings.property.whatsappPlaceholder")}
                      />
                    </div>
                  </div>
                  <div className="md:col-span-2">
                    <label className="block text-[13px] font-medium text-gray-700 mb-0.5">
                      {t("settings.property.emailLabel")}
                    </label>
                    <div className="relative">
                      <EnvelopeIcon className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-gray-400" />
                      <input
                        type="email"
                        value={settings.reservation_email}
                        onChange={(e) => updateSetting("reservation_email", e.target.value)}
                        className="w-full pl-8 pr-2.5 py-1.5 border border-gray-300 rounded-lg text-[13px] focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-transparent"
                        placeholder={t("settings.property.emailPlaceholder")}
                      />
                    </div>
                  </div>
                </div>
              </div>

              {/* Social Media card */}
              <div className="bg-white rounded-lg border border-gray-200 p-4 md:p-5">
                <div className="flex items-center gap-1.5 mb-0.5">
                  <GlobeAltIcon className="w-4 h-4 text-gray-700" />
                  <h2 className="text-sm font-semibold text-gray-900">
                    {t("settings.property.socialTitle")}
                  </h2>
                </div>
                <p className="text-[13px] text-gray-500 mb-3">
                  {t("settings.property.socialSubtitle")}
                </p>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                  <div>
                    <label className="block text-[13px] font-medium text-gray-700 mb-0.5">
                      {t("settings.property.instagramLabel")}
                    </label>
                    <input
                      type="url"
                      value={settings.instagram || ""}
                      onChange={(e) => updateSetting("instagram", e.target.value)}
                      className="w-full px-2.5 py-1.5 border border-gray-300 rounded-lg text-[13px] focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-transparent"
                      placeholder={t("settings.property.instagramPlaceholder")}
                    />
                  </div>
                  <div>
                    <label className="block text-[13px] font-medium text-gray-700 mb-0.5">
                      {t("settings.property.facebookLabel")}
                    </label>
                    <input
                      type="url"
                      value={settings.facebook || ""}
                      onChange={(e) => updateSetting("facebook", e.target.value)}
                      className="w-full px-2.5 py-1.5 border border-gray-300 rounded-lg text-[13px] focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-transparent"
                      placeholder={t("settings.property.facebookPlaceholder")}
                    />
                  </div>
                  <div>
                    <label className="block text-[13px] font-medium text-gray-700 mb-0.5">
                      {t("settings.property.tiktokLabel")}
                    </label>
                    <input
                      type="url"
                      value={settings.tiktok || ""}
                      onChange={(e) => updateSetting("tiktok", e.target.value)}
                      className="w-full px-2.5 py-1.5 border border-gray-300 rounded-lg text-[13px] focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-transparent"
                      placeholder={t("settings.property.tiktokPlaceholder")}
                    />
                  </div>
                  <div>
                    <label className="block text-[13px] font-medium text-gray-700 mb-0.5">
                      {t("settings.property.youtubeLabel")}
                    </label>
                    <input
                      type="url"
                      value={settings.youtube || ""}
                      onChange={(e) => updateSetting("youtube", e.target.value)}
                      className="w-full px-2.5 py-1.5 border border-gray-300 rounded-lg text-[13px] focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-transparent"
                      placeholder={t("settings.property.youtubePlaceholder")}
                    />
                  </div>
                </div>
              </div>

              {/* Save button */}
              <div className="flex justify-end">
                <SaveButton onClick={handleSave} saving={saving}>
                  {t("common.save")}
                </SaveButton>
              </div>
            </>
          )}
        </div>
      )}

      {/* Booking tab */}
      {activeSection === "booking" && (
        <div className="mt-5 space-y-4">
          <div
            className="rounded-lg border border-gray-200 bg-white p-4 md:p-5"
            aria-busy={acceptanceLoading || acceptanceSaving}
          >
            {acceptanceMode ? (
              <ToggleSwitch
                enabled={acceptanceMode === "instant"}
                disabled={acceptanceSaving || Boolean(acceptanceError)}
                onChange={() => void handleAcceptanceToggle()}
                label="Accept bookings instantly"
                description="Confirm card and pay-at-property bookings immediately. Bank transfers always require manual review."
              />
            ) : acceptanceLoading ? (
              <div className="py-3" role="status">
                <p className="text-[13px] font-semibold text-gray-900">Accept bookings instantly</p>
                <p className="text-[13px] text-gray-500">Loading current setting…</p>
              </div>
            ) : null}
            <p className="border-t border-gray-100 pt-3 text-[12px] text-gray-500">
              This setting is shared between PMS and Booking Engine.
            </p>
            {acceptanceSaving && (
              <p className="mt-2 text-[12px] text-gray-500" role="status">
                Saving…
              </p>
            )}
            {acceptanceError && (
              <div className="mt-3 flex flex-wrap items-center justify-between gap-3" role="alert">
                <p className="text-[12px] text-red-700">{acceptanceError}</p>
                <button
                  type="button"
                  onClick={retryBookingAcceptance}
                  className="rounded-md border border-gray-200 bg-white px-3 py-1.5 text-[12px] font-medium text-gray-700 hover:border-gray-400"
                >
                  Retry
                </button>
              </div>
            )}
          </div>

          <SameDayBookingCard
            settings={sameDaySettings}
            loading={sameDayLoading}
            saving={sameDaySaving}
            loadError={sameDayError}
            onSave={(enabled, cutoffLocalTime) => void saveSameDayBooking(enabled, cutoffLocalTime)}
            onRetry={retrySameDayBooking}
          />

          {/* Booking Policies */}
          <div className="bg-white rounded-lg border border-gray-200 p-4 md:p-5">
            <h2 className="text-sm font-semibold text-gray-900">
              {t("settings.booking.policiesTitle")}
            </h2>
            <p className="text-[13px] text-gray-500 mt-0.5 mb-4">
              {t("settings.booking.policiesSubtitle")}
            </p>

            <div className="mb-4">
              <label className="block text-[13px] font-medium text-gray-700 mb-1">
                {t("settings.booking.termsLabel")}
              </label>
              <textarea
                value={settings.terms_text ?? ""}
                onChange={(e) => updateSetting("terms_text", e.target.value)}
                rows={8}
                placeholder={t("settings.booking.termsPlaceholder")}
                className="w-full px-2.5 py-2 border border-gray-300 rounded-lg text-[13px] focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-transparent resize-y"
              />
            </div>

            <div>
              <label className="block text-[13px] font-medium text-gray-700 mb-1">
                {t("settings.booking.cancellationLabel")}
              </label>
              <textarea
                value={settings.cancellation_policy_text ?? ""}
                onChange={(e) => updateSetting("cancellation_policy_text", e.target.value)}
                rows={6}
                placeholder={t("settings.booking.cancellationPlaceholder")}
                className="w-full px-2.5 py-2 border border-gray-300 rounded-lg text-[13px] focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-transparent resize-y"
              />
            </div>
          </div>

          {/* Save button */}
          <div className="flex justify-end">
            <SaveButton onClick={handleSave} saving={saving}>
              {t("common.save")}
            </SaveButton>
          </div>
        </div>
      )}

      {/* Billing tab */}
      {activeSection === "billing" && (
        <div className="mt-5 space-y-4">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {/* Commission Plan */}
            <div
              className={`bg-white rounded-lg border-2 p-5 transition-all ${
                financePlanStatus?.plan === "commission"
                  ? "border-primary-500 ring-1 ring-primary-200"
                  : "border-gray-200"
              }`}
            >
              <div className="flex items-center justify-between mb-3">
                <h3 className="text-[14px] font-semibold text-gray-900">
                  {t("settings.billing.commission")}
                </h3>
                {financePlanStatus?.plan === "commission" && (
                  <span className="px-2 py-0.5 text-[10px] font-bold bg-green-100 text-green-700 rounded-full">
                    {t("settings.billing.current")}
                  </span>
                )}
              </div>
              <p className="text-[12px] text-gray-500 mb-3">
                {t("settings.billing.percentagePerDirect")}
              </p>
              <div className="bg-gray-50 rounded-xl p-4 mb-4 space-y-2">
                <div className="flex items-center justify-between text-[13px]">
                  <span className="text-gray-600">{t("settings.billing.directBookings")}</span>
                  <span className="flex items-center gap-2">
                    {(settings.booking_engine_fee_pct ?? 5) !== 5 && (
                      <span className="px-1.5 py-0.5 text-[9px] font-bold uppercase bg-amber-100 text-amber-700 rounded-full tracking-wide">
                        {t("settings.billing.customRate")}
                      </span>
                    )}
                    <span className="font-semibold text-gray-900">
                      {settings.booking_engine_fee_pct ?? 5}%
                    </span>
                  </span>
                </div>
                <p className="text-[10px] text-gray-400 text-center pt-1">
                  {t("settings.billing.noMonthlyFee")}
                </p>
              </div>
              {financePlanStatus?.plan === "fixed" && !financePlanStatus.cancelAtPeriodEnd && (
                <button
                  onClick={() => setBillingPlanModal("commission")}
                  disabled={billingPlanLoading || billingPlanAction !== null}
                  className="w-full py-2 text-[12px] font-semibold border border-gray-300 text-gray-700 rounded-lg hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-60 transition-colors"
                >
                  Switch to Commission Plan
                </button>
              )}
            </div>

            {/* Fixed Fee Plan */}
            <div
              className={`bg-white rounded-lg border-2 p-5 transition-all ${
                financePlanStatus?.plan === "fixed"
                  ? "border-primary-500 ring-1 ring-primary-200"
                  : "border-gray-200"
              }`}
            >
              <div className="flex items-center justify-between mb-3">
                <h3 className="text-[14px] font-semibold text-gray-900">
                  {t("settings.billing.fixedFee")}
                </h3>
                {financePlanStatus?.plan === "fixed" && (
                  <span className="px-2 py-0.5 text-[10px] font-bold bg-green-100 text-green-700 rounded-full">
                    {t("settings.billing.current")}
                  </span>
                )}
              </div>
              <p className="text-[12px] text-gray-500 mb-3">Fixed fee based on active rooms</p>
              <div className="bg-gray-50 rounded-xl p-4 text-center mb-4">
                <span className="text-3xl font-bold text-gray-900">
                  {formatBillingAmount(financePlanStatus?.amountMinor ?? 3_000)}
                </span>
                <p className="text-[11px] text-gray-400 mt-1">every 30 days</p>
                <p className="text-[10px] text-gray-400 mt-0.5">
                  €30 for the first active room + €5 per additional room ·{" "}
                  {financePlanStatus?.activeRoomCount ?? 0} active rooms
                </p>
              </div>
              {financePlanStatus?.plan !== "fixed" && (
                <button
                  onClick={() => setBillingPlanModal("fixed")}
                  disabled={
                    billingPlanLoading ||
                    billingPlanAction !== null ||
                    !billingPropertyId ||
                    !financePlanStatus
                  }
                  className="w-full py-2 text-[12px] font-semibold border border-gray-300 text-gray-700 rounded-lg hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-60 transition-colors"
                >
                  {financePlanStatus?.checkoutPending ? "Resume payment" : "Switch to Fixed Plan"}
                </button>
              )}
              {financePlanStatus?.plan === "fixed" && (
                <div className="space-y-2">
                  <p className="text-center text-[11px] text-gray-500">
                    Next billing date: {formatBillingDate(financePlanStatus.nextBillingDate)}
                  </p>
                  <button
                    onClick={manageFixedPlanBilling}
                    disabled={
                      billingPlanAction !== null || !financePlanStatus.customerPortalAvailable
                    }
                    className="w-full py-2 text-[12px] font-semibold border border-gray-300 text-gray-700 rounded-lg hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-60 transition-colors"
                  >
                    {billingPlanAction === "portal" ? "Opening billing…" : "Manage billing"}
                  </button>
                </div>
              )}
            </div>
          </div>

          {billingPlanLoading && (
            <div className="rounded-lg border border-gray-200 bg-white p-4 text-[13px] text-gray-500">
              Loading your current billing plan…
            </div>
          )}
          {billingPlanError && (
            <div
              role="alert"
              className="rounded-lg border border-red-200 bg-red-50 p-4 text-[13px] text-red-800"
            >
              {billingPlanError}
            </div>
          )}
          {billingPlanConfirmation && (
            <div className="rounded-lg border border-green-200 bg-green-50 p-4 text-[13px] text-green-800">
              {billingPlanConfirmation}
            </div>
          )}
          {financePlanStatus?.status === "past_due" && (
            <div
              role="alert"
              className="rounded-lg border border-red-200 bg-red-50 p-4 text-[13px] text-red-800"
            >
              Your renewal payment is past due. Stripe will retry it automatically; use Manage
              billing to update your card.
            </div>
          )}
          {financePlanStatus?.cancelAtPeriodEnd && (
            <div className="bg-amber-50 border border-amber-200 rounded-lg p-4">
              <p className="text-[13px] text-amber-800">
                Your Fixed Plan is paid through{" "}
                <strong>{formatBillingDate(financePlanStatus.currentPeriodEnd)}</strong>. Commission
                will apply to bookings created after that date.
              </p>
            </div>
          )}

          {billingPlanModal && financePlanStatus && (
            <div
              role="dialog"
              aria-modal="true"
              aria-labelledby="billing-plan-dialog-title"
              className="fixed inset-0 z-50 flex items-center justify-center bg-gray-950/40 p-4"
            >
              <div className="w-full max-w-md rounded-xl bg-white p-6 shadow-xl">
                <h2
                  id="billing-plan-dialog-title"
                  className="text-base font-semibold text-gray-900"
                >
                  {billingPlanModal === "fixed"
                    ? "Switch to Fixed Plan"
                    : "Switch to Commission Plan"}
                </h2>
                <p className="mt-3 text-[13px] leading-5 text-gray-600">
                  {billingPlanModal === "fixed"
                    ? `You're switching to the Fixed Plan at ${formatBillingAmount(financePlanStatus.amountMinor)}/month. Your first payment will be charged today. Future payments will be charged every 30 days. Any bookings created before today will still settle under your current commission terms.`
                    : `You're switching back to the Commission Plan. Your current Fixed Plan is paid through ${formatBillingDate(financePlanStatus.currentPeriodEnd)}. Commission will apply to all bookings created after that date.`}
                </p>
                <div className="mt-6 flex justify-end gap-2">
                  <button
                    onClick={() => setBillingPlanModal(null)}
                    disabled={billingPlanAction !== null}
                    className="rounded-lg border border-gray-300 px-4 py-2 text-[12px] font-semibold text-gray-700 hover:bg-gray-50 disabled:opacity-60"
                  >
                    Cancel
                  </button>
                  <button
                    onClick={
                      billingPlanModal === "fixed" ? startFixedPlanCheckout : scheduleCommissionPlan
                    }
                    disabled={billingPlanAction !== null}
                    className="rounded-lg bg-primary-600 px-4 py-2 text-[12px] font-semibold text-white hover:bg-primary-700 disabled:opacity-60"
                  >
                    {billingPlanModal === "fixed"
                      ? billingPlanAction === "checkout"
                        ? "Opening payment…"
                        : "Continue to payment"
                      : billingPlanAction === "commission"
                        ? "Scheduling…"
                        : "Switch to Commission Plan"}
                  </button>
                </div>
              </div>
            </div>
          )}

          {/* Payment Methods */}
          <div className="bg-white rounded-lg border border-gray-200 p-4 md:p-5">
            <h2 className="text-sm font-semibold text-gray-900">
              {t("settings.billing.paymentMethods")}
            </h2>
            <p className="text-[12px] text-gray-500 mt-0.5 mb-4">
              {t("settings.billing.paymentMethodsDesc")}
            </p>
            <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-3">
              {/* Online Card Payment */}
              <button
                onClick={() => updateSetting("online_card_payment", !settings.online_card_payment)}
                className={`relative flex flex-col p-4 rounded-xl border-2 transition-all text-left ${
                  settings.online_card_payment
                    ? "border-primary-500 bg-primary-50/30"
                    : "border-gray-200 hover:border-gray-300"
                }`}
              >
                <div
                  className={`absolute top-3 right-3 w-5 h-5 rounded-full border-2 flex items-center justify-center ${settings.online_card_payment ? "border-primary-500 bg-primary-500" : "border-gray-300"}`}
                >
                  {settings.online_card_payment && (
                    <svg
                      className="w-3 h-3 text-white"
                      fill="none"
                      stroke="currentColor"
                      viewBox="0 0 24 24"
                    >
                      <path
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        strokeWidth={3}
                        d="M5 13l4 4L19 7"
                      />
                    </svg>
                  )}
                </div>
                <svg
                  className="w-6 h-6 text-gray-700 mb-2"
                  fill="none"
                  stroke="currentColor"
                  viewBox="0 0 24 24"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={1.5}
                    d="M3 10h18M7 15h1m4 0h1m-7 4h12a3 3 0 003-3V8a3 3 0 00-3-3H6a3 3 0 00-3 3v8a3 3 0 003 3z"
                  />
                </svg>
                <span className="text-[13px] font-semibold text-gray-900">
                  {t("settings.billing.onlineCard")}
                </span>
                <p className="text-[11px] text-gray-500 mt-1 mb-3">
                  {t("settings.billing.onlineCardDesc")}
                </p>
                <div className="mt-auto space-y-1.5">
                  <div className="flex items-center gap-1.5">
                    <svg
                      className="w-3 h-3 text-green-500 shrink-0"
                      fill="currentColor"
                      viewBox="0 0 20 20"
                    >
                      <path
                        fillRule="evenodd"
                        d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z"
                        clipRule="evenodd"
                      />
                    </svg>
                    <span className="text-[10px] text-gray-500">
                      {t("settings.billing.featureInstantConfirmation")}
                    </span>
                  </div>
                  <div className="flex items-center gap-1.5">
                    <svg
                      className="w-3 h-3 text-green-500 shrink-0"
                      fill="currentColor"
                      viewBox="0 0 20 20"
                    >
                      <path
                        fillRule="evenodd"
                        d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z"
                        clipRule="evenodd"
                      />
                    </svg>
                    <span className="text-[10px] text-gray-500">
                      {t("settings.billing.featureCardBrands")}
                    </span>
                  </div>
                  <div className="flex items-center gap-1.5">
                    <svg
                      className="w-3 h-3 text-green-500 shrink-0"
                      fill="currentColor"
                      viewBox="0 0 20 20"
                    >
                      <path
                        fillRule="evenodd"
                        d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z"
                        clipRule="evenodd"
                      />
                    </svg>
                    <span className="text-[10px] text-gray-500">
                      {t("settings.billing.featureAutoPayout")}
                    </span>
                  </div>
                  <div className="flex items-center gap-1.5">
                    <svg
                      className="w-3 h-3 text-amber-500 shrink-0"
                      fill="currentColor"
                      viewBox="0 0 20 20"
                    >
                      <path
                        fillRule="evenodd"
                        d="M18 10a8 8 0 11-16 0 8 8 0 0116 0zm-7-4a1 1 0 11-2 0 1 1 0 012 0zM9 9a1 1 0 000 2v3a1 1 0 001 1h1a1 1 0 100-2v-3a1 1 0 00-1-1H9z"
                        clipRule="evenodd"
                      />
                    </svg>
                    <span className="text-[10px] text-gray-500">
                      {t("settings.billing.featureStripeFees")}
                    </span>
                  </div>
                </div>
              </button>

              {/* PayPal */}
              <div
                className={`relative flex flex-col p-4 rounded-xl border-2 transition-all text-left ${
                  settings.paypal_enabled
                    ? "border-primary-500 bg-primary-50/30"
                    : "border-gray-200 hover:border-gray-300"
                }`}
              >
                <button
                  type="button"
                  onClick={() => updateSetting("paypal_enabled", !settings.paypal_enabled)}
                  className="text-left"
                >
                  <div
                    className={`absolute top-3 right-3 w-5 h-5 rounded-full border-2 flex items-center justify-center ${settings.paypal_enabled ? "border-primary-500 bg-primary-500" : "border-gray-300"}`}
                  >
                    {settings.paypal_enabled && (
                      <svg
                        className="w-3 h-3 text-white"
                        fill="none"
                        stroke="currentColor"
                        viewBox="0 0 24 24"
                      >
                        <path
                          strokeLinecap="round"
                          strokeLinejoin="round"
                          strokeWidth={3}
                          d="M5 13l4 4L19 7"
                        />
                      </svg>
                    )}
                  </div>
                  <svg
                    className="w-6 h-6 text-gray-700 mb-2"
                    fill="none"
                    stroke="currentColor"
                    viewBox="0 0 24 24"
                  >
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth={1.5}
                      d="M12 6v12m-4-8h5a3 3 0 010 6H8V6h6a2 2 0 010 4H8"
                    />
                  </svg>
                  <span className="text-[13px] font-semibold text-gray-900">PayPal</span>
                  <p className="text-[11px] text-gray-500 mt-1 mb-3">
                    Guests send payment manually to your PayPal email. Confirm it in PMS once
                    received.
                  </p>
                </button>
                {settings.paypal_enabled && (
                  <div className="mt-3 pt-3 border-t border-gray-200 space-y-3">
                    <div>
                      <label className="block text-[11px] font-medium text-gray-600 mb-1">
                        PayPal email
                      </label>
                      <input
                        type="email"
                        value={settings.paypal_email || ""}
                        onChange={(e) => updateSetting("paypal_email", e.target.value)}
                        placeholder="payments@yourproperty.com"
                        className="w-full rounded-lg border border-gray-200 px-3 py-2 text-[12px] text-gray-900 focus:outline-none focus:ring-2 focus:ring-primary-500/20 focus:border-primary-500"
                      />
                    </div>
                    <div>
                      <label className="block text-[11px] font-medium text-gray-600 mb-1">
                        Payment window (hours)
                      </label>
                      <input
                        type="number"
                        min={1}
                        max={168}
                        value={settings.paypal_payment_window_hours || 24}
                        onChange={(e) =>
                          updateSetting(
                            "paypal_payment_window_hours",
                            Math.max(1, Number(e.target.value) || 24),
                          )
                        }
                        className="w-full rounded-lg border border-gray-200 px-3 py-2 text-[12px] text-gray-900 focus:outline-none focus:ring-2 focus:ring-primary-500/20 focus:border-primary-500"
                      />
                      <p className="mt-1 text-[10px] text-gray-500">
                        Guests are asked to pay within this window. Confirm receipt manually in PMS.
                      </p>
                    </div>
                  </div>
                )}
              </div>

              {/* Pay at Hotel */}
              <div
                className={`relative flex flex-col p-4 rounded-xl border-2 transition-all text-left cursor-pointer ${
                  settings.pay_at_property_enabled
                    ? "border-primary-500 bg-primary-50/30"
                    : "border-gray-200 hover:border-gray-300"
                }`}
              >
                <div
                  onClick={() =>
                    updateSetting("pay_at_property_enabled", !settings.pay_at_property_enabled)
                  }
                >
                  <div
                    className={`absolute top-3 right-3 w-5 h-5 rounded-full border-2 flex items-center justify-center ${settings.pay_at_property_enabled ? "border-primary-500 bg-primary-500" : "border-gray-300"}`}
                  >
                    {settings.pay_at_property_enabled && (
                      <svg
                        className="w-3 h-3 text-white"
                        fill="none"
                        stroke="currentColor"
                        viewBox="0 0 24 24"
                      >
                        <path
                          strokeLinecap="round"
                          strokeLinejoin="round"
                          strokeWidth={3}
                          d="M5 13l4 4L19 7"
                        />
                      </svg>
                    )}
                  </div>
                  <svg
                    className="w-6 h-6 text-gray-700 mb-2"
                    fill="none"
                    stroke="currentColor"
                    viewBox="0 0 24 24"
                  >
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth={1.5}
                      d="M19 21V5a2 2 0 00-2-2H7a2 2 0 00-2 2v16m14 0h2m-2 0h-5m-9 0H3m2 0h5M9 7h1m-1 4h1m4-4h1m-1 4h1m-5 10v-5a1 1 0 011-1h2a1 1 0 011 1v5m-4 0h4"
                    />
                  </svg>
                  <span className="text-[13px] font-semibold text-gray-900">
                    {t("settings.billing.payAtHotel")}
                  </span>
                  <p className="text-[11px] text-gray-500 mt-1 mb-3">
                    {t("settings.billing.payAtHotelDesc")}
                  </p>
                  <div className="space-y-1.5">
                    <div className="flex items-center gap-1.5">
                      <svg
                        className="w-3 h-3 text-green-500 shrink-0"
                        fill="currentColor"
                        viewBox="0 0 20 20"
                      >
                        <path
                          fillRule="evenodd"
                          d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z"
                          clipRule="evenodd"
                        />
                      </svg>
                      <span className="text-[10px] text-gray-500">
                        {t("settings.billing.featureNoProcessingFees")}
                      </span>
                    </div>
                    <div className="flex items-center gap-1.5">
                      <svg
                        className="w-3 h-3 text-green-500 shrink-0"
                        fill="currentColor"
                        viewBox="0 0 20 20"
                      >
                        <path
                          fillRule="evenodd"
                          d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z"
                          clipRule="evenodd"
                        />
                      </svg>
                      <span className="text-[10px] text-gray-500">
                        {t("settings.billing.featureNoStripeAccount")}
                      </span>
                    </div>
                    <div className="flex items-center gap-1.5">
                      <svg
                        className="w-3 h-3 text-amber-500 shrink-0"
                        fill="currentColor"
                        viewBox="0 0 20 20"
                      >
                        <path
                          fillRule="evenodd"
                          d="M18 10a8 8 0 11-16 0 8 8 0 0116 0zm-7-4a1 1 0 11-2 0 1 1 0 012 0zM9 9a1 1 0 000 2v3a1 1 0 001 1h1a1 1 0 100-2v-3a1 1 0 00-1-1H9z"
                          clipRule="evenodd"
                        />
                      </svg>
                      <span className="text-[10px] text-gray-500">
                        {t("settings.billing.featureNoShowRisk")}
                      </span>
                    </div>
                  </div>
                </div>
                {settings.pay_at_property_enabled && (
                  <div className="flex items-center gap-2 mt-3 pt-3 border-t border-gray-200">
                    {[
                      { key: "cash", label: t("settings.billing.cash") },
                      { key: "card", label: t("settings.billing.card") },
                    ].map((m) => {
                      const selected = settings.pay_at_hotel_methods.includes(m.key);
                      return (
                        <button
                          key={m.key}
                          type="button"
                          onClick={() => {
                            if (selected && settings.pay_at_hotel_methods.length > 1) {
                              updateSetting(
                                "pay_at_hotel_methods",
                                settings.pay_at_hotel_methods.filter((v) => v !== m.key),
                              );
                            } else if (!selected) {
                              updateSetting("pay_at_hotel_methods", [
                                ...settings.pay_at_hotel_methods,
                                m.key,
                              ]);
                            }
                          }}
                          className={`px-3 py-1.5 text-[12px] font-medium rounded-lg border transition-colors ${
                            selected
                              ? "border-primary-500 bg-primary-50 text-primary-700"
                              : "border-gray-200 text-gray-500 hover:border-gray-300"
                          }`}
                        >
                          {m.label}
                        </button>
                      );
                    })}
                    <span className="text-[11px] text-gray-400 ml-1">
                      {settings.pay_at_hotel_methods.length === 2
                        ? t("settings.billing.cashCardAccepted")
                        : settings.pay_at_hotel_methods.includes("cash")
                          ? t("settings.billing.cashOnly")
                          : t("settings.billing.cardOnly")}
                    </span>
                  </div>
                )}
              </div>

              {/* Bank Transfer */}
              <button
                onClick={() => updateSetting("bank_transfer", !settings.bank_transfer)}
                className={`relative flex flex-col p-4 rounded-xl border-2 transition-all text-left ${
                  settings.bank_transfer
                    ? "border-primary-500 bg-primary-50/30"
                    : "border-gray-200 hover:border-gray-300"
                }`}
              >
                <div
                  className={`absolute top-3 right-3 w-5 h-5 rounded-full border-2 flex items-center justify-center ${settings.bank_transfer ? "border-primary-500 bg-primary-500" : "border-gray-300"}`}
                >
                  {settings.bank_transfer && (
                    <svg
                      className="w-3 h-3 text-white"
                      fill="none"
                      stroke="currentColor"
                      viewBox="0 0 24 24"
                    >
                      <path
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        strokeWidth={3}
                        d="M5 13l4 4L19 7"
                      />
                    </svg>
                  )}
                </div>
                <svg
                  className="w-6 h-6 text-gray-700 mb-2"
                  fill="none"
                  stroke="currentColor"
                  viewBox="0 0 24 24"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={1.5}
                    d="M8 14v3m4-3v3m4-3v3M3 21h18M3 10h18M3 7l9-4 9 4M4 10h16v11H4V10z"
                  />
                </svg>
                <span className="text-[13px] font-semibold text-gray-900">
                  {t("settings.billing.bankTransfer")}
                </span>
                <p className="text-[11px] text-gray-500 mt-1 mb-3">
                  {t("settings.billing.bankTransferDesc")}
                </p>
                <div className="mt-auto space-y-1.5">
                  <div className="flex items-center gap-1.5">
                    <svg
                      className="w-3 h-3 text-green-500 shrink-0"
                      fill="currentColor"
                      viewBox="0 0 20 20"
                    >
                      <path
                        fillRule="evenodd"
                        d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z"
                        clipRule="evenodd"
                      />
                    </svg>
                    <span className="text-[10px] text-gray-500">
                      {t("settings.billing.featureNoProcessingFees")}
                    </span>
                  </div>
                  <div className="flex items-center gap-1.5">
                    <svg
                      className="w-3 h-3 text-green-500 shrink-0"
                      fill="currentColor"
                      viewBox="0 0 20 20"
                    >
                      <path
                        fillRule="evenodd"
                        d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z"
                        clipRule="evenodd"
                      />
                    </svg>
                    <span className="text-[10px] text-gray-500">
                      {t("settings.billing.featureDirectToAccount")}
                    </span>
                  </div>
                  <div className="flex items-center gap-1.5">
                    <svg
                      className="w-3 h-3 text-green-500 shrink-0"
                      fill="currentColor"
                      viewBox="0 0 20 20"
                    >
                      <path
                        fillRule="evenodd"
                        d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z"
                        clipRule="evenodd"
                      />
                    </svg>
                    <span className="text-[10px] text-gray-500">
                      {t("settings.billing.featureGoodForLargeBookings")}
                    </span>
                  </div>
                  <div className="flex items-center gap-1.5">
                    <svg
                      className="w-3 h-3 text-amber-500 shrink-0"
                      fill="currentColor"
                      viewBox="0 0 20 20"
                    >
                      <path
                        fillRule="evenodd"
                        d="M18 10a8 8 0 11-16 0 8 8 0 0116 0zm-7-4a1 1 0 11-2 0 1 1 0 012 0zM9 9a1 1 0 000 2v3a1 1 0 001 1h1a1 1 0 100-2v-3a1 1 0 00-1-1H9z"
                        clipRule="evenodd"
                      />
                    </svg>
                    <span className="text-[10px] text-gray-500">
                      {t("settings.billing.featureManualVerification")}
                    </span>
                  </div>
                </div>
              </button>
            </div>
            <div className="flex justify-end pt-4">
              <SaveButton onClick={handleSave} saving={saving}>
                {t("common.save")}
              </SaveButton>
            </div>
          </div>

          {/* Payout Details */}
          {(settings.pay_at_property_enabled || settings.bank_transfer) && (
            <div className="bg-white rounded-lg border border-gray-200 p-4 md:p-5 space-y-3">
              <div>
                <h2 className="text-sm font-semibold text-gray-900">
                  {t("settings.billing.payoutDetails")}
                </h2>
                <p className="text-[12px] text-gray-500 mt-0.5">
                  {t("settings.billing.payoutDetailsDesc")}
                </p>
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div className="sm:col-span-2">
                  <label className="block text-[12px] font-medium text-gray-700 mb-0.5">
                    {t("settings.billing.payoutAccountHolder")}
                  </label>
                  <input
                    type="text"
                    value={settings.payout_account_holder || ""}
                    onChange={(e) => updateSetting("payout_account_holder", e.target.value)}
                    className="w-full px-2.5 py-1.5 border border-gray-300 rounded-lg text-[13px] focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-transparent"
                    placeholder={t("settings.billing.payoutAccountHolderPlaceholder")}
                  />
                </div>
                <div className="sm:col-span-2">
                  <label className="block text-[12px] font-medium text-gray-700 mb-1">
                    {t("settings.billing.accountFormatLabel")}
                  </label>
                  <div className="inline-flex rounded-lg border border-gray-300 p-0.5 bg-gray-50">
                    <button
                      type="button"
                      onClick={() => updateSetting("payout_account_type", "iban")}
                      className={`px-3 py-1 text-[12px] font-medium rounded-md transition-colors ${
                        (settings.payout_account_type || "iban") === "iban"
                          ? "bg-white text-gray-900 shadow-sm"
                          : "text-gray-500 hover:text-gray-700"
                      }`}
                    >
                      {t("settings.billing.payoutIban")}
                    </button>
                    <button
                      type="button"
                      onClick={() => updateSetting("payout_account_type", "account_number")}
                      className={`px-3 py-1 text-[12px] font-medium rounded-md transition-colors ${
                        settings.payout_account_type === "account_number"
                          ? "bg-white text-gray-900 shadow-sm"
                          : "text-gray-500 hover:text-gray-700"
                      }`}
                    >
                      {t("settings.billing.accountNumberLabel")}
                    </button>
                  </div>
                  <p className="text-[11px] text-gray-500 mt-1">
                    {(settings.payout_account_type || "iban") === "iban"
                      ? t("settings.billing.useIbanHelp")
                      : t("settings.billing.usePlainNumberHelp")}
                  </p>
                </div>
                <div className="sm:col-span-2">
                  {(settings.payout_account_type || "iban") === "iban" ? (
                    <>
                      <label className="block text-[12px] font-medium text-gray-700 mb-0.5">
                        {t("settings.billing.payoutIban")}
                      </label>
                      <input
                        type="text"
                        value={settings.payout_iban || ""}
                        onChange={(e) => updateSetting("payout_iban", e.target.value)}
                        className="w-full px-2.5 py-1.5 border border-gray-300 rounded-lg text-[13px] font-mono focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-transparent"
                        placeholder={t("settings.billing.payoutIbanPlaceholder")}
                      />
                    </>
                  ) : (
                    <>
                      <label className="block text-[12px] font-medium text-gray-700 mb-0.5">
                        {t("settings.billing.accountNumberLabel")}
                      </label>
                      <input
                        type="text"
                        value={settings.payout_account_number || ""}
                        onChange={(e) => updateSetting("payout_account_number", e.target.value)}
                        className="w-full px-2.5 py-1.5 border border-gray-300 rounded-lg text-[13px] font-mono focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-transparent"
                        placeholder={t("settings.billing.payoutAccountNumberPlaceholder")}
                      />
                    </>
                  )}
                </div>
                <div>
                  <label className="block text-[12px] font-medium text-gray-700 mb-0.5">
                    {t("settings.billing.payoutBankName")}
                  </label>
                  <input
                    type="text"
                    value={settings.payout_bank_name || ""}
                    onChange={(e) => updateSetting("payout_bank_name", e.target.value)}
                    className="w-full px-2.5 py-1.5 border border-gray-300 rounded-lg text-[13px] focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-transparent"
                    placeholder={t("settings.billing.payoutBankNamePlaceholder")}
                  />
                </div>
                <div>
                  <label className="block text-[12px] font-medium text-gray-700 mb-0.5">
                    {t("settings.billing.payoutSwift")}
                  </label>
                  <input
                    type="text"
                    value={settings.payout_swift || ""}
                    onChange={(e) => updateSetting("payout_swift", e.target.value)}
                    className="w-full px-2.5 py-1.5 border border-gray-300 rounded-lg text-[13px] font-mono focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-transparent"
                    placeholder={t("settings.billing.payoutSwiftPlaceholder")}
                  />
                </div>
              </div>

              <div className="flex justify-end pt-2">
                <SaveButton onClick={handleSave} saving={saving}>
                  {t("common.save")}
                </SaveButton>
              </div>
            </div>
          )}
        </div>
      )}

      {/* Payments tab — how the hotel collects from guests (VAY-400 audit:
          extracted from Billing where it was nested under online_card_payment). */}
      {activeSection === "payments" && (
        <SettingsSection
          id="payments"
          title="Payments"
          description="How your hotel collects payments from guests."
        >
          {!stripeAccountId &&
          (stripeAccountCreationBlocked || !paymentSettingsLoaded) &&
          paymentError ? (
            <SettingsCard>
              <FeedbackAlert type="error" message={paymentError} className="mb-3" />
              <span className="mb-3 inline-flex rounded-full bg-yellow-100 px-2 py-0.5 text-[11px] font-medium text-yellow-700">
                {t("settings.billing.pendingOnboarding")}
              </span>
              <p className="mb-3 text-sm text-gray-700">
                Stripe account status couldn&apos;t be confirmed. Check the existing account before
                starting setup again.
              </p>
              <button
                type="button"
                onClick={() => void refreshStripeOnboarding()}
                disabled={refreshingStripe || !billingPropertyId}
                className="px-4 py-2 text-[13px] font-medium border border-gray-300 bg-white text-gray-800 rounded-lg hover:bg-gray-50 disabled:opacity-50 transition-colors"
              >
                {refreshingStripe ? "Checking Stripe..." : "Check Stripe status"}
              </button>
            </SettingsCard>
          ) : !settings.online_card_payment ? (
            <SettingsCard>
              <p className="text-sm text-gray-700">
                Enable <strong>Online card payment</strong> in{" "}
                <button
                  type="button"
                  onClick={() => selectSection("billing")}
                  className="text-primary-600 hover:underline"
                >
                  Billing &rarr; Payment methods
                </button>{" "}
                first to set up your payment provider.
              </p>
            </SettingsCard>
          ) : (
            <>
              <div className="bg-white rounded-lg border border-gray-200 p-4 md:p-5">
                <h2 className="text-sm font-semibold text-gray-900">
                  {t("settings.billing.paymentProvider")}
                </h2>
                <p className="text-[12px] text-gray-500 mt-0.5 mb-4">
                  {t("settings.billing.paymentProviderDesc")}
                </p>

                {paymentError && (
                  <FeedbackAlert type="error" message={paymentError} className="mb-3" />
                )}
                {paymentSuccess && (
                  <FeedbackAlert type="success" message={paymentSuccess} className="mb-3" />
                )}

                {/* Provider selector */}
                <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 mb-4">
                  <button
                    type="button"
                    disabled
                    className={`relative flex flex-col p-3 rounded-xl border-2 transition-all text-left opacity-55 cursor-not-allowed ${
                      paymentProvider === "vayada"
                        ? "border-primary-500 bg-primary-50/30"
                        : "border-gray-200 hover:border-gray-300"
                    }`}
                  >
                    <div
                      className={`absolute top-2.5 right-2.5 w-4 h-4 rounded-full border-2 flex items-center justify-center ${paymentProvider === "vayada" ? "border-primary-500 bg-primary-500" : "border-gray-300"}`}
                    >
                      {paymentProvider === "vayada" && (
                        <svg
                          className="w-2.5 h-2.5 text-white"
                          fill="none"
                          stroke="currentColor"
                          viewBox="0 0 24 24"
                        >
                          <path
                            strokeLinecap="round"
                            strokeLinejoin="round"
                            strokeWidth={3}
                            d="M5 13l4 4L19 7"
                          />
                        </svg>
                      )}
                    </div>
                    <span className="text-[13px] font-semibold text-gray-900">
                      {t("settings.billing.providerVayada")}
                    </span>
                    <p className="text-[11px] text-gray-500 mt-1">
                      {t("settings.billing.providerVayadaDesc")}
                    </p>
                  </button>
                  <button
                    type="button"
                    onClick={() => setPaymentProvider("stripe")}
                    className={`relative flex flex-col p-3 rounded-xl border-2 transition-all text-left ${
                      paymentProvider === "stripe"
                        ? "border-primary-500 bg-primary-50/30"
                        : "border-gray-200 hover:border-gray-300"
                    }`}
                  >
                    <div
                      className={`absolute top-2.5 right-2.5 w-4 h-4 rounded-full border-2 flex items-center justify-center ${paymentProvider === "stripe" ? "border-primary-500 bg-primary-500" : "border-gray-300"}`}
                    >
                      {paymentProvider === "stripe" && (
                        <svg
                          className="w-2.5 h-2.5 text-white"
                          fill="none"
                          stroke="currentColor"
                          viewBox="0 0 24 24"
                        >
                          <path
                            strokeLinecap="round"
                            strokeLinejoin="round"
                            strokeWidth={3}
                            d="M5 13l4 4L19 7"
                          />
                        </svg>
                      )}
                    </div>
                    <span className="text-[13px] font-semibold text-gray-900">
                      {t("settings.billing.providerStripe")}
                    </span>
                    <p className="text-[11px] text-gray-500 mt-1">
                      {t("settings.billing.providerStripeDesc")}
                    </p>
                  </button>
                  <button
                    type="button"
                    disabled
                    className={`relative flex flex-col p-3 rounded-xl border-2 transition-all text-left opacity-55 cursor-not-allowed ${
                      paymentProvider === "xendit"
                        ? "border-primary-500 bg-primary-50/30"
                        : "border-gray-200 hover:border-gray-300"
                    }`}
                  >
                    <div
                      className={`absolute top-2.5 right-2.5 w-4 h-4 rounded-full border-2 flex items-center justify-center ${paymentProvider === "xendit" ? "border-primary-500 bg-primary-500" : "border-gray-300"}`}
                    >
                      {paymentProvider === "xendit" && (
                        <svg
                          className="w-2.5 h-2.5 text-white"
                          fill="none"
                          stroke="currentColor"
                          viewBox="0 0 24 24"
                        >
                          <path
                            strokeLinecap="round"
                            strokeLinejoin="round"
                            strokeWidth={3}
                            d="M5 13l4 4L19 7"
                          />
                        </svg>
                      )}
                    </div>
                    <span className="text-[13px] font-semibold text-gray-900">
                      {t("settings.billing.providerXendit")}
                    </span>
                    <p className="text-[11px] text-gray-500 mt-1">
                      {t("settings.billing.providerXenditDesc")}
                    </p>
                  </button>
                </div>

                {/* Provider-specific content */}
                {paymentProvider === "vayada" ? (
                  <div className="space-y-3">
                    <div className="bg-amber-50 border border-amber-200 rounded-lg px-4 py-3">
                      <p className="text-[13px] text-amber-900 font-medium">Coming soon</p>
                      <p className="text-[12px] text-amber-800 mt-1">
                        vayada Payments is not available in target checkout yet.
                      </p>
                    </div>
                  </div>
                ) : paymentProvider === "xendit" ? (
                  <div className="space-y-3">
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                      <div>
                        <label className="block text-[12px] font-medium text-gray-700 mb-0.5">
                          {t("settings.billing.bankLabel")}
                        </label>
                        <select
                          value={xenditChannelCode}
                          onChange={(e) => setXenditChannelCode(e.target.value)}
                          className="w-full px-2.5 py-1.5 border border-gray-300 rounded-lg text-[13px] focus:outline-none focus:ring-2 focus:ring-primary-500"
                        >
                          <option value="ID_BCA">BCA</option>
                          <option value="ID_MANDIRI">Mandiri</option>
                          <option value="ID_BNI">BNI</option>
                          <option value="ID_BRI">BRI</option>
                          <option value="ID_PERMATA">Permata</option>
                          <option value="ID_CIMB">CIMB Niaga</option>
                        </select>
                      </div>
                      <div>
                        <label className="block text-[12px] font-medium text-gray-700 mb-0.5">
                          {t("settings.billing.accountNumberLabel")}
                        </label>
                        <input
                          type="text"
                          inputMode="numeric"
                          maxLength={20}
                          value={xenditAccountNumber}
                          onChange={(e) =>
                            setXenditAccountNumber(e.target.value.replace(/\D/g, ""))
                          }
                          placeholder="1234567890"
                          className="w-full px-2.5 py-1.5 border border-gray-300 rounded-lg text-[13px] focus:outline-none focus:ring-2 focus:ring-primary-500"
                        />
                      </div>
                    </div>
                    <div>
                      <label className="block text-[12px] font-medium text-gray-700 mb-0.5">
                        {t("settings.billing.accountHolderNameLabel")}
                      </label>
                      <input
                        type="text"
                        value={xenditAccountHolderName}
                        onChange={(e) => setXenditAccountHolderName(e.target.value)}
                        placeholder={t("settings.billing.accountHolderPlaceholderXendit")}
                        className="w-full px-2.5 py-1.5 border border-gray-300 rounded-lg text-[13px] focus:outline-none focus:ring-2 focus:ring-primary-500"
                      />
                    </div>
                    <div className="flex justify-end pt-2">
                      <SaveButton onClick={savePaymentProviderSettings} saving={savingPayment}>
                        {t("common.save")}
                      </SaveButton>
                    </div>
                  </div>
                ) : stripeAccountId ? (
                  <div className="space-y-3">
                    <div className="flex items-center gap-2">
                      <span className="text-[12px] font-semibold text-gray-700">
                        {t("settings.billing.stripe")}
                      </span>
                      <span
                        className={`inline-flex px-2 py-0.5 rounded-full text-[11px] font-medium ${stripeOnboarded ? "bg-green-100 text-green-700" : "bg-yellow-100 text-yellow-700"}`}
                      >
                        {stripeOnboarded
                          ? t("settings.billing.connected")
                          : t("settings.billing.pendingOnboarding")}
                      </span>
                    </div>
                    {!stripeOnboarded && (
                      <div>
                        <p className="text-[13px] text-gray-600 mb-2">
                          {t("settings.billing.completeOnboardingDesc")}
                        </p>
                        <div className="flex flex-wrap gap-2">
                          <button
                            onClick={handleOnboarding}
                            disabled={refreshingStripe || issuingStripeOnboardingLink}
                            className="px-4 py-2 text-[13px] font-medium bg-primary-600 text-white rounded-lg hover:bg-primary-700 disabled:opacity-50 transition-colors"
                          >
                            {issuingStripeOnboardingLink
                              ? "Opening Stripe..."
                              : t("settings.billing.completeOnboarding")}
                          </button>
                          <button
                            type="button"
                            onClick={() => void refreshStripeOnboarding()}
                            disabled={refreshingStripe}
                            className="px-4 py-2 text-[13px] font-medium border border-gray-300 bg-white text-gray-800 rounded-lg hover:bg-gray-50 disabled:opacity-50 transition-colors"
                          >
                            {refreshingStripe ? "Checking Stripe..." : "Check Stripe status"}
                          </button>
                        </div>
                      </div>
                    )}
                    <div className="rounded-lg border border-gray-200 bg-gray-50 px-3 py-3">
                      <button
                        type="button"
                        onClick={handleStripeDashboard}
                        disabled={openingStripeDashboard}
                        className="inline-flex items-center gap-2 rounded-lg border border-gray-300 bg-white px-3 py-2 text-[13px] font-medium text-gray-800 transition-colors hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-60"
                      >
                        <ArrowTopRightOnSquareIcon className="h-4 w-4" aria-hidden="true" />
                        {openingStripeDashboard ? "Opening Stripe..." : "View Stripe Dashboard"}
                      </button>
                      <p className="mt-2 text-[12px] text-gray-500">
                        Check your payouts, balance, and payment history, or update your bank
                        account.
                      </p>
                    </div>
                    <div className="flex justify-end pt-2">
                      <SaveButton onClick={savePaymentProviderSettings} saving={savingPayment}>
                        {t("common.save")}
                      </SaveButton>
                    </div>
                  </div>
                ) : stripeAccountCreationBlocked || !paymentSettingsLoaded ? (
                  <div className="space-y-3">
                    <p className="text-[13px] text-gray-600">
                      Stripe account status couldn&apos;t be confirmed. Check the existing account
                      before starting setup again.
                    </p>
                    <button
                      type="button"
                      onClick={() => void refreshStripeOnboarding()}
                      disabled={refreshingStripe || !billingPropertyId}
                      className="px-4 py-2 text-[13px] font-medium border border-gray-300 bg-white text-gray-800 rounded-lg hover:bg-gray-50 disabled:opacity-50 transition-colors"
                    >
                      {refreshingStripe ? "Checking Stripe..." : "Check Stripe status"}
                    </button>
                  </div>
                ) : (
                  <div className="space-y-3">
                    <div className="bg-gray-50 border border-gray-200 rounded-lg px-3 py-2 mb-1">
                      <div className="flex items-center gap-2">
                        <svg className="h-5" viewBox="0 0 60 25" fill="none">
                          <path
                            fillRule="evenodd"
                            clipRule="evenodd"
                            d="M60 12.8C60 8.5 57.9 5 54.4 5c-3.5 0-5.9 3.5-5.9 7.8s2.2 7.8 5.8 7.8c1.7 0 3-.4 4-1.1v-2.7c-1 .5-2.1.9-3.5.9-1.4 0-2.6-.5-2.8-2.2h6.9c0-.2.1-1 .1-1.7zm-7-1.4c0-1.6 1-2.3 1.9-2.3.9 0 1.8.7 1.8 2.3h-3.7zm-7.5-6.4c-1.4 0-2.3.7-2.8 1.1l-.2-.9h-3.1v19.7l3.5-.7.1-4.8c.5.4 1.3.9 2.5.9 2.5 0 4.8-2 4.8-6.5 0-4.1-2.4-6.8-4.8-6.8zm-.8 10.5c-.8 0-1.3-.3-1.7-.7l-.1-5.4c.4-.4.9-.7 1.7-.7 1.3 0 2.2 1.5 2.2 3.4.1 2-.9 3.4-2.1 3.4zM35.2 5l3.5-.8V1.5l-3.5.7V5zm0 .5h3.5v14.2h-3.5V5.5zM31.3 6.3l-.2-1H28v14.2h3.5V9.1c.8-1.1 2.2-.9 2.6-.7V5.5c-.5-.2-2.2-.5-2.8 1zm-7.4-3.8l-3.4.7-.1 13c0 2.4 1.8 4.2 4.2 4.2 1.3 0 2.3-.2 2.8-.5v-2.8c-.5.2-3.1.9-3.1-1.4V8.3h3.1V5.5h-3.1l-.4-3zm-8.8 8c0-.6.5-.8 1.3-.8 1.1 0 2.5.3 3.7 1V7.4c-1.2-.5-2.5-.7-3.7-.7-3 0-5 1.6-5 4.2 0 4.1 5.7 3.5 5.7 5.2 0 .7-.6.9-1.5.9-1.3 0-2.9-.5-4.2-1.2v3.2c1.4.6 2.9.9 4.2.9 3.1 0 5.2-1.5 5.2-4.2-.1-4.5-5.7-3.7-5.7-5.3z"
                            fill="#635BFF"
                          />
                        </svg>
                        <p className="text-[11px] text-gray-500">
                          {t("settings.billing.stripeBlurb")}
                        </p>
                      </div>
                    </div>
                    <div className="max-w-xs">
                      <label className="block text-[12px] font-medium text-gray-700 mb-0.5">
                        {t("settings.billing.countryLabel")}
                      </label>
                      <CountrySelect value={connectCountry} onChange={setConnectCountry} t={t} />
                    </div>
                    <button
                      onClick={handleCreateStripeAccount}
                      disabled={creatingAccount || refreshingStripe || !connectEmail}
                      className="px-4 py-2 text-[13px] font-medium bg-primary-600 text-white rounded-lg hover:bg-primary-700 disabled:opacity-50 transition-colors"
                    >
                      {creatingAccount
                        ? t("settings.billing.connectingAccount")
                        : t("settings.billing.connectPaymentAccount")}
                    </button>
                  </div>
                )}
              </div>
            </>
          )}
        </SettingsSection>
      )}
    </SettingsLayout>
  );
}
