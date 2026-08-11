"use client";

import { useEffect, useState, useCallback } from "react";
import { getBookingHotelPropertyLink } from "@/services/api/bookingPropertyLinkClient";
import {
  buildFinancePaymentSettingsBody,
  createFinanceStripeProviderAccount,
  getFinancePaymentSettings,
  issueFinanceStripeOnboardingLink,
  updateFinancePaymentSettings,
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
  BellIcon,
  UserCircleIcon,
  CreditCardIcon,
  BanknotesIcon,
  GlobeAltIcon,
  PhoneIcon,
  ChatBubbleLeftIcon,
  EnvelopeIcon,
  MapPinIcon,
  PlusIcon,
  TrashIcon,
  ArrowUpIcon,
  ArrowDownIcon,
} from "@heroicons/react/24/outline";
import { HotelIcon } from "@vayada/product-onboarding";
import {
  settingsService,
  type PropertySettings,
  type PropertySettingsUpdate,
  type CustomDomainStatus,
} from "@/services/settings";
import { ToggleSwitch, FeedbackAlert, SaveButton } from "@/components/ui";
import { CountrySelect } from "@/components/settings/CountrySelect";
import {
  SettingsLayout,
  SettingsSection,
  SettingsCard,
  type SettingsNavSection,
} from "@/components/settings/layout";
import { LocationMapPreview } from "@/components/settings/LocationMapPreview";
import { PoiSearchInput } from "@/components/settings/PoiSearchInput";
import { useTranslation } from "@/lib/i18n";

// Audit-driven section IDs (VAY-400):
// - "account" replaces the old "security" tab — those are personal-account
//   concerns (email/password/2FA), not hotel concerns.
// - "payments" is new — Stripe Connect + Xendit moved out of billing into
//   their own section (billing = what hotel pays Vayada; payments = how hotel
//   collects from guests).
type Section =
  | "property"
  | "booking"
  | "location"
  | "notifications"
  | "account"
  | "billing"
  | "payments";

const POI_COLORS = ["#2563eb", "#16a34a", "#d97706", "#dc2626", "#0d9488", "#db2777"];
const PROPERTY_MAP_CENTERING_UNAVAILABLE =
  "Automatic property map centering is not available on next-api yet.";
const BILLING_SETTINGS_UNAVAILABLE = "Billing settings are not available on next-api yet.";

function readBookingHotelId(settings: PropertySettings): string {
  if (settings.id?.trim()) return settings.id.trim();
  if (typeof window === "undefined") return "";
  return localStorage.getItem("selectedHotelId")?.trim() ?? "";
}

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
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

const hasValidCoordinatePair = (latitude: number, longitude: number) =>
  Number.isFinite(latitude) &&
  Number.isFinite(longitude) &&
  latitude >= -90 &&
  latitude <= 90 &&
  longitude >= -180 &&
  longitude <= 180;

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
  refer_a_guest_enabled: false,
  map_view_enabled: false,
  terms_text: "",
  cancellation_policy_text: "",
  show_room_detail_map: false,
  points_of_interest: [],
};

type TargetSettingsUpdate =
  | { ok: true; data: PropertySettingsUpdate }
  | { ok: false; message: string };

function buildTargetSettingsUpdate(
  section: Section,
  settings: PropertySettings,
): TargetSettingsUpdate {
  if (section === "property") {
    if ((settings.tiktok || "").trim() || (settings.youtube || "").trim()) {
      return {
        ok: false,
        message: "TikTok and YouTube links are not available on next-api yet.",
      };
    }
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
      },
    };
  }

  if (section === "booking") {
    if (
      (settings.terms_text || "").trim() ||
      settings.map_view_enabled ||
      settings.refer_a_guest_enabled
    ) {
      return {
        ok: false,
        message:
          "Terms text, map view, and refer-a-guest settings are not available on next-api yet.",
      };
    }
    return {
      ok: true,
      data: {
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

  if (section === "location") {
    return { ok: false, message: "Location map settings are not available on next-api yet." };
  }
  if (section === "notifications") {
    return { ok: false, message: "Notification settings are not available on next-api yet." };
  }
  return { ok: false, message: "This settings section is not saved by property settings." };
}

export default function SettingsPage() {
  const { t } = useTranslation();
  const [activeSection, setActiveSection] = useState<Section>(() =>
    typeof window !== "undefined" && new URLSearchParams(window.location.search).has("billing")
      ? "billing"
      : "property",
  );
  const [settings, setSettings] = useState<PropertySettings>(DEFAULT_SETTINGS);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [feedback, setFeedback] = useState<{ type: "success" | "error"; message: string } | null>(
    null,
  );

  // Custom domain
  const [domainInput, setDomainInput] = useState("");
  const [domainStatus, setDomainStatus] = useState<CustomDomainStatus | null>(null);

  // Stripe Connect / Payments
  const [stripeAccountId, setStripeAccountId] = useState<string | null>(null);
  const [stripeOnboarded, setStripeOnboarded] = useState(false);
  const [connectEmail] = useState(() =>
    typeof window !== "undefined" ? localStorage.getItem("userEmail") || "" : "",
  );
  const [connectCountry, setConnectCountry] = useState("AT");
  const [creatingAccount, setCreatingAccount] = useState(false);
  const [paymentProvider, setPaymentProvider] = useState<"stripe" | "xendit" | "vayada">("stripe");
  const [xenditChannelCode, setXenditChannelCode] = useState("ID_BCA");
  const [xenditAccountNumber, setXenditAccountNumber] = useState("");
  const [xenditAccountHolderName, setXenditAccountHolderName] = useState("");
  const [paymentError, setPaymentError] = useState("");
  const [paymentSuccess, setPaymentSuccess] = useState("");
  const [savingPayment, setSavingPayment] = useState(false);
  const [paymentSettingsLoaded, setPaymentSettingsLoaded] = useState(false);
  const [selectedPoiId, setSelectedPoiId] = useState<string | null>(null);
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

  useEffect(() => {
    setPaymentSettingsLoaded(false);
    setBillingPlanLoading(true);
    const propertyPromise = fetchSettings();
    propertyPromise
      .then(async (property) => {
        if (!property) {
          setBillingPlanLoading(false);
          return null;
        }
        settingsService
          .getCustomDomainStatus()
          .then(setDomainStatus)
          .catch((error) => {
            setDomainStatus(null);
            const message =
              error instanceof Error ? error.message : "Failed to load custom domain status.";
            setFeedback({ type: "error", message });
          });
        const hotelId = readBookingHotelId(property);
        if (!hotelId) {
          setBillingPlanLoading(false);
          return null;
        }
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
      .then((res) => {
        if (!res) {
          setPaymentSettingsLoaded(true);
          return;
        }
        const ps = res.paymentSettings;
        const providerAccount = ps.providerAccount;
        const stripeAccountId =
          providerAccount.provider === "stripe" ? providerAccount.providerAccountId : null;
        setStripeAccountId(stripeAccountId);
        setStripeOnboarded(
          providerAccount.provider === "stripe" &&
            (providerAccount.onboardingStatus === "completed" ||
              (providerAccount.chargesEnabled && providerAccount.payoutsEnabled)),
        );
        setPaymentProvider(toSettingsPaymentProvider(ps.paymentProvider));
        setXenditChannelCode("ID_BCA");
        setXenditAccountNumber("");
        setXenditAccountHolderName("");
        setSettings((prev) => ({
          ...prev,
          pay_at_property_enabled: ps.acceptedMethods.includes("pay_at_property"),
          online_card_payment:
            ps.acceptedMethods.includes("card") || ps.acceptedMethods.includes("xendit"),
          bank_transfer: ps.acceptedMethods.includes("bank_transfer"),
        }));
        setPaymentSettingsLoaded(true);
      })
      .catch((err: unknown) => {
        setPaymentSettingsLoaded(false);
        setBillingPlanLoading(false);
        setPaymentError(errorMessage(err, "Payment settings failed to load."));
      });
  }, [fetchSettings]);

  const handleCreateStripeAccount = async () => {
    if (!connectEmail) return;
    setCreatingAccount(true);
    setPaymentError("");
    try {
      const hotelId = readBookingHotelId(settings);
      if (!hotelId) {
        setPaymentError("Select a hotel before creating a Stripe account.");
        return;
      }
      const propertyLink = await getBookingHotelPropertyLink({ hotelId });
      const result = await createFinanceStripeProviderAccount({
        propertyId: propertyLink.propertyId,
        email: connectEmail,
        country: connectCountry,
        commandPrefix: `settings-stripe-account-${hotelId}`,
      });
      setStripeAccountId(result.providerAccountId);
      window.open(result.onboardingUrl, "_blank");
    } catch (err: unknown) {
      const msg =
        err instanceof TypeError
          ? t("settings.billing.errorPaymentServerUnreachable")
          : errorMessage(err, t("settings.billing.errorAccountCreate"));
      setPaymentError(msg);
    } finally {
      setCreatingAccount(false);
    }
  };

  const handleOnboarding = async () => {
    try {
      const hotelId = readBookingHotelId(settings);
      if (!hotelId || !stripeAccountId) {
        setPaymentError("Select a hotel and create a Stripe account before onboarding.");
        return;
      }
      const propertyLink = await getBookingHotelPropertyLink({ hotelId });
      const link = await issueFinanceStripeOnboardingLink({
        propertyId: propertyLink.propertyId,
        providerAccountId: stripeAccountId,
        commandPrefix: `settings-stripe-onboarding-${hotelId}`,
      });
      window.open(link.onboardingUrl, "_blank");
    } catch (err: unknown) {
      setPaymentError(errorMessage(err, t("settings.billing.errorOnboardingLink")));
    }
  };

  const savePaymentProviderSettings = async (showPageFeedback = false): Promise<boolean> => {
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
        return false;
      }
      if (paymentProvider === "xendit") {
        fail("Xendit account details are not saved by this payment settings flow yet.");
        return false;
      }
      const hotelId = readBookingHotelId(settings);
      if (!hotelId) {
        fail("Select a hotel before saving payment settings.");
        return false;
      }
      const propertyLink = await getBookingHotelPropertyLink({ hotelId });
      await updateFinancePaymentSettings({
        propertyId: propertyLink.propertyId,
        body: buildFinancePaymentSettingsBody({
          payAtPropertyEnabled: settings.pay_at_property_enabled,
          payAtHotelMethods: settings.pay_at_hotel_methods,
          onlineCardPayment: settings.online_card_payment ?? false,
          bankTransfer: settings.bank_transfer ?? false,
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
      return true;
    } catch (err: unknown) {
      fail(err instanceof Error ? err.message : t("settings.billing.errorPaymentSaveFailed"));
      return false;
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

    const pois = settings.points_of_interest || [];
    const invalidPoi = pois.find(
      (poi) =>
        !poi.label.trim() ||
        !poi.travelTime.trim() ||
        !hasValidCoordinatePair(poi.latitude, poi.longitude),
    );
    if (invalidPoi) {
      setFeedback({
        type: "error",
        message: "Every point of interest needs a label, travel time, latitude, and longitude.",
      });
      setActiveSection("location");
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

  const updatePois = (pois: NonNullable<PropertySettings["points_of_interest"]>) => {
    updateSetting(
      "points_of_interest",
      pois.map((poi, position) => ({ ...poi, position })),
    );
  };

  const addPoi = () => {
    const pois = settings.points_of_interest || [];
    if (pois.length >= 10) {
      setFeedback({ type: "error", message: "Maximum 10 points of interest." });
      return;
    }
    const used = new Set(pois.map((poi) => poi.color));
    const color = POI_COLORS.find((candidate) => !used.has(candidate)) || POI_COLORS[0];
    const id =
      typeof crypto !== "undefined" && "randomUUID" in crypto
        ? crypto.randomUUID()
        : `poi-${Date.now()}`;
    const newPoi = {
      id,
      label: "",
      travelTime: "",
      color,
      latitude: NaN,
      longitude: NaN,
      position: pois.length,
    };
    updatePois([...pois, newPoi]);
    setSelectedPoiId(id);
  };

  const patchPoi = (
    id: string,
    patch: Partial<NonNullable<PropertySettings["points_of_interest"]>[number]>,
  ) => {
    updatePois(
      (settings.points_of_interest || []).map((poi) =>
        poi.id === id ? { ...poi, ...patch } : poi,
      ),
    );
  };

  const deletePoi = (id: string) => {
    updatePois((settings.points_of_interest || []).filter((poi) => poi.id !== id));
    if (selectedPoiId === id) setSelectedPoiId(null);
  };

  const movePoi = (id: string, direction: -1 | 1) => {
    const pois = [...(settings.points_of_interest || [])];
    const index = pois.findIndex((poi) => poi.id === id);
    const next = index + direction;
    if (index < 0 || next < 0 || next >= pois.length) return;
    [pois[index], pois[next]] = [pois[next], pois[index]];
    updatePois(pois);
  };

  const handleConnectDomain = async () => {
    if (!domainInput.trim()) {
      setFeedback({ type: "error", message: "Enter a custom domain." });
      return;
    }

    try {
      setSaving(true);
      setFeedback(null);
      const status = await settingsService.connectCustomDomain(domainInput);
      setDomainStatus(status);
      setDomainInput("");
      setFeedback({ type: "success", message: t("settings.feedback.domainConnected") });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to connect custom domain.";
      setFeedback({ type: "error", message });
    } finally {
      setSaving(false);
    }
  };

  const handleDisconnectDomain = async () => {
    try {
      setSaving(true);
      setFeedback(null);
      await settingsService.disconnectCustomDomain();
      const status = await settingsService.getCustomDomainStatus();
      setDomainStatus(status);
      setFeedback({ type: "success", message: t("settings.feedback.domainRemoved") });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to remove custom domain.";
      setFeedback({ type: "error", message });
    } finally {
      setSaving(false);
    }
  };

  const handleRefreshDomainStatus = async () => {
    try {
      const status = await settingsService.getCustomDomainStatus();
      setDomainStatus(status);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to refresh custom domain.";
      setFeedback({ type: "error", message });
    }
  };

  const sections: SettingsNavSection[] = [
    { id: "property", label: t("settings.tabs.property"), icon: HotelIcon },
    { id: "booking", label: t("settings.tabs.booking"), icon: CalendarDaysIcon },
    { id: "location", label: "Location map", icon: MapPinIcon },
    {
      id: "notifications",
      label: t("settings.tabs.notifications"),
      icon: BellIcon,
    },
    // TODO i18n: add settings.tabs.account + settings.tabs.payments keys to
    // messages/*.json. Hardcoded English until then.
    { id: "account", label: "Account", icon: UserCircleIcon },
    { id: "billing", label: t("settings.tabs.billing"), icon: CreditCardIcon },
    { id: "payments", label: "Payments", icon: BanknotesIcon },
  ];

  return (
    <SettingsLayout
      title={t("settings.title")}
      description={t("settings.subtitle")}
      sections={sections}
      activeId={activeSection}
      onSelect={(id) => {
        setActiveSection(id as Section);
      }}
    >
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
          {/* Map View */}
          <div className="bg-white rounded-lg border border-gray-200 p-4 md:p-5">
            <ToggleSwitch
              enabled={settings.map_view_enabled ?? false}
              onChange={() => updateSetting("map_view_enabled", !settings.map_view_enabled)}
              label={t("settings.booking.mapViewLabel")}
              description={t("settings.booking.mapViewDesc")}
            />
          </div>

          {/* Refer a Guest */}
          <div className="bg-white rounded-lg border border-gray-200 p-4 md:p-5">
            <ToggleSwitch
              enabled={settings.refer_a_guest_enabled ?? false}
              onChange={() =>
                updateSetting("refer_a_guest_enabled", !settings.refer_a_guest_enabled)
              }
              label={t("settings.booking.referAGuest")}
              description={t("settings.booking.referAGuestDesc")}
            />
          </div>

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

          {/* Custom Domain */}
          <div className="bg-white rounded-lg border border-gray-200 p-4 md:p-5">
            <h2 className="text-sm font-semibold text-gray-900">
              {t("settings.booking.customDomain")}
            </h2>
            {domainStatus?.configured ? (
              <div className="space-y-4 mt-3">
                <div className="flex items-center gap-3">
                  <span className="text-[13px] font-medium text-gray-900">
                    {domainStatus.domain}
                  </span>
                  <span
                    className={`inline-flex px-2 py-0.5 rounded-full text-[11px] font-medium ${
                      domainStatus.sslStatus === "active"
                        ? "bg-green-100 text-green-700"
                        : domainStatus.status === "pending"
                          ? "bg-yellow-100 text-yellow-700"
                          : "bg-gray-100 text-gray-700"
                    }`}
                  >
                    {domainStatus.sslStatus === "active"
                      ? t("settings.booking.active")
                      : domainStatus.status === "pending"
                        ? t("settings.booking.pendingDns")
                        : domainStatus.sslStatus || t("settings.booking.checking")}
                  </span>
                  <button
                    onClick={handleRefreshDomainStatus}
                    className="text-[11px] text-primary-600 hover:text-primary-700"
                  >
                    {t("settings.booking.refresh")}
                  </button>
                </div>

                {domainStatus.sslStatus !== "active" && domainStatus.dnsRecords.length > 0 && (
                  <div className="bg-blue-50 border border-blue-200 rounded-lg p-4">
                    <p className="text-[13px] font-medium text-blue-900 mb-2">
                      {t("settings.booking.dnsSetupRequired")}
                    </p>
                    <p className="text-[13px] text-blue-700 mb-2">
                      {t("settings.booking.dnsInstructions")}
                    </p>
                    {domainStatus.dnsRecords.map((record) => (
                      <div
                        key={`${record.type}:${record.name}`}
                        className="bg-white rounded p-3 font-mono text-[11px] text-gray-800 space-y-1"
                      >
                        <div>
                          <span className="text-gray-500">{t("settings.booking.dnsType")}</span>{" "}
                          {record.type}
                        </div>
                        <div>
                          <span className="text-gray-500">{t("settings.booking.dnsName")}</span>{" "}
                          {record.name}
                        </div>
                        <div>
                          <span className="text-gray-500">{t("settings.booking.dnsTarget")}</span>{" "}
                          {record.value}
                        </div>
                      </div>
                    ))}
                  </div>
                )}

                {domainStatus.verificationErrors.length > 0 && (
                  <div className="bg-red-50 border border-red-200 rounded-lg p-3">
                    <p className="text-[13px] text-red-700">
                      {domainStatus.verificationErrors.join(", ")}
                    </p>
                  </div>
                )}

                <button
                  onClick={handleDisconnectDomain}
                  disabled={saving}
                  className="px-4 py-2 text-[13px] font-medium text-red-600 border border-red-200 rounded-lg hover:bg-red-50 disabled:opacity-60"
                >
                  {t("settings.booking.removeDomain")}
                </button>
              </div>
            ) : (
              <div className="space-y-3 mt-1">
                <p className="text-[13px] text-gray-500">
                  {t("settings.booking.customDomainDesc")}
                </p>
                <div className="flex flex-col gap-3 sm:flex-row">
                  <input
                    type="text"
                    value={domainInput}
                    onChange={(e) => setDomainInput(e.target.value)}
                    placeholder={t("settings.booking.customDomainPlaceholder")}
                    disabled={saving}
                    className="flex-1 px-2.5 py-1.5 border border-gray-300 rounded-lg text-[13px] focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-transparent disabled:bg-gray-50"
                  />
                  <button
                    onClick={handleConnectDomain}
                    disabled={saving}
                    className="px-4 py-2 text-[13px] font-medium bg-primary-600 text-white rounded-lg hover:bg-primary-700 disabled:opacity-60"
                  >
                    {t("settings.booking.connectDomain")}
                  </button>
                </div>
              </div>
            )}
          </div>

          {/* Save button */}
          <div className="flex justify-end">
            <SaveButton onClick={handleSave} saving={saving}>
              {t("common.save")}
            </SaveButton>
          </div>
        </div>
      )}

      {/* Location map tab */}
      {activeSection === "location" && (
        <div className="mt-5 space-y-4">
          <div className="bg-white rounded-lg border border-gray-200 p-4 md:p-5">
            <ToggleSwitch
              enabled={settings.show_room_detail_map ?? false}
              onChange={() => updateSetting("show_room_detail_map", !settings.show_room_detail_map)}
              label="Show location map on room detail"
              description="Guests see the property and nearby points of interest before selecting a rate."
            />
          </div>

          <div className="bg-white rounded-lg border border-gray-200 p-4 md:p-5">
            <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
              <div>
                <h2 className="text-sm font-semibold text-gray-900">Points of interest</h2>
                <p className="text-[13px] text-gray-500 mt-0.5">Up to 10 map pins per property.</p>
              </div>
              <button
                type="button"
                onClick={addPoi}
                disabled={(settings.points_of_interest || []).length >= 10}
                className="inline-flex items-center justify-center gap-1.5 rounded-lg bg-primary-600 px-3 py-2 text-[13px] font-semibold text-white hover:bg-primary-700 disabled:opacity-50"
              >
                <PlusIcon className="h-4 w-4" />
                Add point of interest
              </button>
            </div>

            <div className="mt-4 grid gap-4 lg:grid-cols-[minmax(0,1fr)_360px]">
              <div className="space-y-3">
                {(settings.points_of_interest || []).length === 0 && (
                  <div className="rounded-lg border border-dashed border-gray-300 px-4 py-8 text-center text-[13px] text-gray-500">
                    No points of interest yet.
                  </div>
                )}
                {(settings.points_of_interest || []).map((poi, index) => (
                  <div
                    key={poi.id}
                    className={`rounded-lg border p-3 ${
                      selectedPoiId === poi.id
                        ? "border-primary-300 bg-primary-50/40"
                        : "border-gray-200"
                    }`}
                    onClick={() => setSelectedPoiId(poi.id)}
                  >
                    <div className="mb-3 flex items-center justify-between gap-2">
                      <div className="flex items-center gap-2">
                        <span
                          className="h-4 w-4 rounded-full border border-white shadow-sm"
                          style={{ backgroundColor: poi.color }}
                        />
                        <span className="text-[13px] font-semibold text-gray-900">
                          Point {index + 1}
                        </span>
                      </div>
                      <div className="flex items-center gap-1">
                        <button
                          type="button"
                          onClick={(event) => {
                            event.stopPropagation();
                            movePoi(poi.id, -1);
                          }}
                          disabled={index === 0}
                          className="rounded-md p-1.5 text-gray-500 hover:bg-white disabled:opacity-40"
                          aria-label="Move point up"
                        >
                          <ArrowUpIcon className="h-4 w-4" />
                        </button>
                        <button
                          type="button"
                          onClick={(event) => {
                            event.stopPropagation();
                            movePoi(poi.id, 1);
                          }}
                          disabled={index === (settings.points_of_interest || []).length - 1}
                          className="rounded-md p-1.5 text-gray-500 hover:bg-white disabled:opacity-40"
                          aria-label="Move point down"
                        >
                          <ArrowDownIcon className="h-4 w-4" />
                        </button>
                        <button
                          type="button"
                          onClick={(event) => {
                            event.stopPropagation();
                            deletePoi(poi.id);
                          }}
                          className="rounded-md p-1.5 text-red-500 hover:bg-red-50"
                          aria-label="Delete point"
                        >
                          <TrashIcon className="h-4 w-4" />
                        </button>
                      </div>
                    </div>

                    <div className="grid gap-3 md:grid-cols-2">
                      <label className="block text-[13px] font-medium text-gray-700">
                        Label
                        <input
                          type="text"
                          value={poi.label}
                          onChange={(event) => patchPoi(poi.id, { label: event.target.value })}
                          className="mt-1 w-full rounded-lg border border-gray-300 px-2.5 py-1.5 text-[13px] focus:border-transparent focus:outline-none focus:ring-2 focus:ring-primary-500"
                          placeholder="Kuta Beach"
                        />
                      </label>
                      <label className="block text-[13px] font-medium text-gray-700">
                        Travel time
                        <input
                          type="text"
                          value={poi.travelTime}
                          onChange={(event) => patchPoi(poi.id, { travelTime: event.target.value })}
                          className="mt-1 w-full rounded-lg border border-gray-300 px-2.5 py-1.5 text-[13px] focus:border-transparent focus:outline-none focus:ring-2 focus:ring-primary-500"
                          placeholder="3 min walk"
                        />
                      </label>
                    </div>

                    <div className="mt-3">
                      <label className="block text-[13px] font-medium text-gray-700 mb-1">
                        Search location
                      </label>
                      <PoiSearchInput
                        onSelect={(latitude, longitude, name) => {
                          patchPoi(poi.id, {
                            latitude,
                            longitude,
                            ...(!poi.label.trim() ? { label: name } : {}),
                          });
                          setSelectedPoiId(poi.id);
                        }}
                      />
                      {Number.isFinite(poi.latitude) && Number.isFinite(poi.longitude) && (
                        <p className="mt-1 text-[11px] text-gray-400">
                          Placed at {poi.latitude.toFixed(5)}, {poi.longitude.toFixed(5)}
                          {" · "}
                          <button
                            type="button"
                            className="text-primary-600 hover:underline"
                            onClick={() => setSelectedPoiId(poi.id)}
                          >
                            click map to reposition
                          </button>
                        </p>
                      )}
                      {(!Number.isFinite(poi.latitude) || !Number.isFinite(poi.longitude)) && (
                        <p className="mt-1 text-[11px] text-amber-600">
                          Not placed yet — search above or{" "}
                          <button
                            type="button"
                            className="underline"
                            onClick={() => setSelectedPoiId(poi.id)}
                          >
                            click the map
                          </button>
                          .
                        </p>
                      )}
                    </div>

                    <div className="mt-3 flex flex-wrap gap-2">
                      {POI_COLORS.map((color) => (
                        <button
                          key={color}
                          type="button"
                          onClick={() => patchPoi(poi.id, { color })}
                          className={`h-7 w-7 rounded-full border-2 ${
                            poi.color === color ? "border-gray-900" : "border-white"
                          } shadow-sm`}
                          style={{ backgroundColor: color }}
                          aria-label={`Use pin color ${color}`}
                        />
                      ))}
                    </div>
                  </div>
                ))}
              </div>

              <div className="lg:sticky lg:top-5 lg:self-start space-y-2">
                {(settings.points_of_interest || []).length === 0 && (
                  <div className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-[12px] text-amber-800">
                    {PROPERTY_MAP_CENTERING_UNAVAILABLE}
                  </div>
                )}
                <LocationMapPreview
                  propertyName={settings.property_name}
                  property={null}
                  pois={(settings.points_of_interest || []).filter(
                    (poi) => Number.isFinite(poi.latitude) && Number.isFinite(poi.longitude),
                  )}
                  selectedPoiId={selectedPoiId}
                  onPlacePoi={
                    selectedPoiId
                      ? (latitude, longitude) => patchPoi(selectedPoiId, { latitude, longitude })
                      : undefined
                  }
                  onMovePoi={(id, latitude, longitude) => patchPoi(id, { latitude, longitude })}
                />
              </div>
            </div>
          </div>

          <div className="flex justify-end">
            <SaveButton onClick={handleSave} saving={saving}>
              {t("common.save")}
            </SaveButton>
          </div>
        </div>
      )}

      {/* Notifications tab */}
      {activeSection === "notifications" && (
        <div className="mt-5 space-y-4">
          <div className="bg-white rounded-lg border border-gray-200 p-4 md:p-5">
            <div className="flex items-center gap-1.5 mb-0.5">
              <EnvelopeIcon className="w-4 h-4 text-gray-700" />
              <h2 className="text-sm font-semibold text-gray-900">
                {t("settings.notifications.title")}
              </h2>
            </div>
            <p className="text-[13px] text-gray-500 mb-4">{t("settings.notifications.subtitle")}</p>

            <ToggleSwitch
              enabled={settings.email_notifications}
              onChange={() => updateSetting("email_notifications", !settings.email_notifications)}
              label={t("settings.notifications.emailNotifications")}
              description={t("settings.notifications.emailNotificationsDesc")}
            />

            <div className="border-t border-gray-200 my-2" />

            <ToggleSwitch
              enabled={settings.new_booking_alerts}
              onChange={() => updateSetting("new_booking_alerts", !settings.new_booking_alerts)}
              label={t("settings.notifications.newBookingAlerts")}
              description={t("settings.notifications.newBookingAlertsDesc")}
            />

            <ToggleSwitch
              enabled={settings.ota_booking_alerts}
              onChange={() => updateSetting("ota_booking_alerts", !settings.ota_booking_alerts)}
              label={t("settings.notifications.otaBookingAlerts")}
              description={t("settings.notifications.otaBookingAlertsDesc")}
            />

            <ToggleSwitch
              enabled={settings.payment_alerts}
              onChange={() => updateSetting("payment_alerts", !settings.payment_alerts)}
              label={t("settings.notifications.paymentAlerts")}
              description={t("settings.notifications.paymentAlertsDesc")}
            />
          </div>

          {/* Save button */}
          <div className="flex justify-end">
            <SaveButton onClick={handleSave} saving={saving}>
              {t("common.save")}
            </SaveButton>
          </div>
        </div>
      )}

      {/* Account tab — personal-account settings (was "Security"). */}
      {activeSection === "account" && (
        <div className="mt-5">
          <div className="rounded-lg border border-gray-200 bg-white p-5">
            <div className="flex items-start gap-3">
              <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-gray-100">
                <UserCircleIcon className="h-5 w-5 text-gray-500" />
              </div>
              <div>
                <h2 className="text-sm font-semibold text-gray-900">Personal account security</h2>
                <p className="mt-1 max-w-xl text-[13px] leading-5 text-gray-500">
                  Email, password, two-factor authentication, and sign-in history are managed by
                  Vayada sign-in. These controls are not available inside Booking Admin yet.
                </p>
                <span className="mt-3 inline-flex rounded-md bg-gray-100 px-2 py-1 text-[11px] font-medium text-gray-600">
                  Not available yet
                </span>
              </div>
            </div>
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
                        Bookings will be auto-cancelled if PayPal payment isn&apos;t confirmed
                        within this window.
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
          {!settings.online_card_payment ? (
            <SettingsCard>
              <p className="text-sm text-gray-700">
                Enable <strong>Online card payment</strong> in{" "}
                <button
                  type="button"
                  onClick={() => setActiveSection("billing")}
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
                    onClick={() => setPaymentProvider("vayada")}
                    className={`relative flex flex-col p-3 rounded-xl border-2 transition-all text-left ${
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
                    onClick={() => setPaymentProvider("xendit")}
                    className={`relative flex flex-col p-3 rounded-xl border-2 transition-all text-left ${
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
                    <div className="bg-green-50 border border-green-200 rounded-lg px-4 py-3">
                      <p className="text-[13px] text-green-800 font-medium">
                        {t("settings.billing.vayadaNoSetupTitle")}
                      </p>
                      <p className="text-[12px] text-green-700 mt-1">
                        {t("settings.billing.vayadaNoSetupDesc")}
                      </p>
                    </div>
                    <div className="flex justify-end pt-2">
                      <SaveButton onClick={savePaymentProviderSettings} saving={savingPayment}>
                        {t("common.save")}
                      </SaveButton>
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
                        <button
                          onClick={handleOnboarding}
                          className="px-4 py-2 text-[13px] font-medium bg-primary-600 text-white rounded-lg hover:bg-primary-700 transition-colors"
                        >
                          {t("settings.billing.completeOnboarding")}
                        </button>
                      </div>
                    )}
                    <div className="flex justify-end pt-2">
                      <SaveButton onClick={savePaymentProviderSettings} saving={savingPayment}>
                        {t("common.save")}
                      </SaveButton>
                    </div>
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
                      disabled={creatingAccount || !connectEmail}
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
