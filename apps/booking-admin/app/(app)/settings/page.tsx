"use client";

import { useEffect, useRef, useState, useCallback } from "react";
import { pmsClient } from "@/services/api/pmsClient";
import {
  BuildingOffice2Icon,
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
  LockClosedIcon,
  PlusIcon,
  TrashIcon,
  ArrowUpIcon,
  ArrowDownIcon,
} from "@heroicons/react/24/outline";
import {
  settingsService,
  customDomainService,
  type PropertySettings,
  type CustomDomainStatus,
} from "@/services/settings";
import { ToggleSwitch, FeedbackAlert, PasswordField, SaveButton } from "@/components/ui";
import { TotpSettings } from "@/components/settings/TotpSettings";
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

export default function SettingsPage() {
  const { t } = useTranslation();
  const [activeSection, setActiveSection] = useState<Section>("property");
  const [settings, setSettings] = useState<PropertySettings>(DEFAULT_SETTINGS);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [feedback, setFeedback] = useState<{ type: "success" | "error"; message: string } | null>(
    null,
  );

  // Email form state
  const [emailForm, setEmailForm] = useState({ new_email: "", password: "" });
  const [changingEmail, setChangingEmail] = useState(false);
  const [emailFeedback, setEmailFeedback] = useState<{
    type: "success" | "error";
    message: string;
  } | null>(null);

  // Password form state
  const [passwordForm, setPasswordForm] = useState({
    current_password: "",
    new_password: "",
    confirm_password: "",
  });
  const [changingPassword, setChangingPassword] = useState(false);
  const [passwordFeedback, setPasswordFeedback] = useState<{
    type: "success" | "error";
    message: string;
  } | null>(null);

  // Custom domain
  const [domainInput, setDomainInput] = useState("");
  const [domainStatus, setDomainStatus] = useState<CustomDomainStatus | null>(null);
  const [domainLoading, setDomainLoading] = useState(false);

  // Stripe Connect / Payments
  const [stripeAccountId, setStripeAccountId] = useState<string | null>(null);
  const [stripeOnboarded, setStripeOnboarded] = useState(false);
  const [connectEmail, setConnectEmail] = useState(() =>
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
  const [selectedPoiId, setSelectedPoiId] = useState<string | null>(null);
  const [propertyCoordinate, setPropertyCoordinate] = useState<{
    latitude: number;
    longitude: number;
  } | null>(null);
  const [propertyCoordinateLoaded, setPropertyCoordinateLoaded] = useState(false);
  const propertyCoordinateLoadingRef = useRef(false);

  const handleChangeEmail = async () => {
    try {
      setChangingEmail(true);
      setEmailFeedback(null);
      const res = await settingsService.changeEmail(emailForm.new_email, emailForm.password);
      setEmailFeedback({
        type: "success",
        message: res.message || t("settings.security.emailSuccess"),
      });
      setEmailForm({ new_email: "", password: "" });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : t("settings.security.emailError");
      setEmailFeedback({ type: "error", message });
    } finally {
      setChangingEmail(false);
    }
  };

  const handleChangePassword = async () => {
    if (passwordForm.new_password !== passwordForm.confirm_password) {
      setPasswordFeedback({ type: "error", message: t("settings.security.passwordMismatch") });
      return;
    }
    if (passwordForm.new_password.length < 8) {
      setPasswordFeedback({ type: "error", message: t("settings.security.passwordLength") });
      return;
    }
    try {
      setChangingPassword(true);
      setPasswordFeedback(null);
      await settingsService.changePassword(
        passwordForm.current_password,
        passwordForm.new_password,
      );
      setPasswordFeedback({ type: "success", message: t("settings.security.passwordSuccess") });
      setPasswordForm({ current_password: "", new_password: "", confirm_password: "" });
    } catch {
      setPasswordFeedback({ type: "error", message: t("settings.security.passwordError") });
    } finally {
      setChangingPassword(false);
    }
  };

  const fetchSettings = useCallback(async () => {
    try {
      setLoading(true);
      const data = await settingsService.getPropertySettings();
      setSettings(data);
    } catch {
      setFeedback({ type: "error", message: t("settings.feedback.loadError") });
    } finally {
      setLoading(false);
    }
  }, [t]);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (params.get("section") === "payments" || params.has("stripe")) {
      setActiveSection("payments");
    }

    fetchSettings();
    customDomainService
      .getStatus()
      .then(setDomainStatus)
      .catch(() => {});
    // Load payment settings from PMS (single source of truth for payment methods)
    pmsClient
      .get<{ paymentSettings: any }>("/admin/payment-settings")
      .then((res) => {
        const ps = res.paymentSettings;
        setStripeAccountId(ps.stripeConnectAccountId);
        setStripeOnboarded(ps.stripeConnectOnboarded);
        setPaymentProvider(ps.paymentProvider || "stripe");
        setXenditChannelCode(ps.xenditChannelCode || "ID_BCA");
        setXenditAccountNumber(ps.xenditAccountNumber || "");
        setXenditAccountHolderName(ps.xenditAccountHolderName || "");
        // Payment method toggles are authoritative from PMS
        setSettings((prev) => ({
          ...prev,
          pay_at_property_enabled: ps.payAtPropertyEnabled ?? false,
          online_card_payment: ps.onlineCardPayment ?? false,
          bank_transfer: ps.bankTransfer ?? false,
        }));
      })
      .catch(() => {});
  }, [fetchSettings]);

  const handleCreateStripeAccount = async () => {
    if (!connectEmail) return;
    setCreatingAccount(true);
    setPaymentError("");
    try {
      const result = await pmsClient.post<{ accountId: string }>("/admin/stripe/connect-account", {
        email: connectEmail,
        country: connectCountry,
      });
      setStripeAccountId(result.accountId);
      const link = await pmsClient.get<{ url: string }>("/admin/stripe/connect-onboarding-link");
      window.location.assign(link.url);
    } catch (err: any) {
      const msg =
        err instanceof TypeError
          ? t("settings.billing.errorPaymentServerUnreachable")
          : err.message || t("settings.billing.errorAccountCreate");
      setPaymentError(msg);
    } finally {
      setCreatingAccount(false);
    }
  };

  const handleOnboarding = async () => {
    try {
      const link = await pmsClient.get<{ url: string }>("/admin/stripe/connect-onboarding-link");
      window.location.assign(link.url);
    } catch (err: any) {
      setPaymentError(err.message || t("settings.billing.errorOnboardingLink"));
    }
  };

  const savePaymentProviderSettings = async () => {
    setSavingPayment(true);
    setPaymentError("");
    setPaymentSuccess("");
    if (paymentProvider === "xendit") {
      if (!xenditAccountNumber.trim() || !/^\d{5,20}$/.test(xenditAccountNumber.trim())) {
        setPaymentError(t("settings.billing.errorAccountNumberFormat"));
        setSavingPayment(false);
        return;
      }
      if (!xenditAccountHolderName.trim()) {
        setPaymentError(t("settings.billing.errorAccountHolderRequired"));
        setSavingPayment(false);
        return;
      }
    }
    try {
      await pmsClient.patch("/admin/payment-settings", {
        paymentProvider,
        ...(paymentProvider === "xendit"
          ? { xenditChannelCode, xenditAccountNumber, xenditAccountHolderName }
          : {}),
      });
      setPaymentSuccess(t("settings.billing.paymentSettingsSaved"));
    } catch (err: any) {
      setPaymentError(err.message || t("settings.billing.errorPaymentSaveFailed"));
    } finally {
      setSavingPayment(false);
    }
  };

  const handleSave = async () => {
    const paypalEmail = (settings.paypal_email || "").trim();
    const normalizedSettings =
      paypalEmail === (settings.paypal_email || "")
        ? settings
        : { ...settings, paypal_email: paypalEmail };
    if (settings.paypal_enabled) {
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(paypalEmail)) {
        setFeedback({ type: "error", message: "Enter a valid PayPal email to enable PayPal." });
        setActiveSection("billing");
        return;
      }
      if (
        !settings.paypal_payment_window_hours ||
        settings.paypal_payment_window_hours < 1 ||
        settings.paypal_payment_window_hours > 168
      ) {
        setFeedback({
          type: "error",
          message: "PayPal payment window must be between 1 and 168 hours.",
        });
        setActiveSection("billing");
        return;
      }
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
      const data = await settingsService.updatePropertySettings(normalizedSettings);
      setSettings(data);
      // Sync slug, name, and payment methods to PMS
      try {
        await Promise.all([
          pmsClient.patch("/admin/hotel", {
            slug: data.slug,
            name: data.property_name,
            contact_email: data.reservation_email,
          }),
          pmsClient.patch("/admin/payment-settings", {
            payAtPropertyEnabled: data.pay_at_property_enabled,
            onlineCardPayment: data.online_card_payment,
            bankTransfer: data.bank_transfer,
          }),
        ]);
      } catch {
        // Non-fatal: PMS sync may fail if not using vayada PMS
      }
      setFeedback({ type: "success", message: t("settings.feedback.saveSuccess") });
    } catch {
      setFeedback({ type: "error", message: t("settings.feedback.saveError") });
    } finally {
      setSaving(false);
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
    const defaultCoord = propertyCoordinate ?? { latitude: NaN, longitude: NaN };
    const newPoi = {
      id,
      label: "",
      travelTime: "",
      color,
      latitude: defaultCoord.latitude,
      longitude: defaultCoord.longitude,
      position: pois.length,
    };
    updatePois([...pois, newPoi]);
    setSelectedPoiId(id);
    loadPropertyCoordinate();
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
    if (!domainInput.trim()) return;
    setDomainLoading(true);
    setFeedback(null);
    try {
      const connectedDomain = domainInput.trim().toLowerCase();
      const result = await customDomainService.connect(connectedDomain);
      setDomainStatus({
        configured: true,
        domain: result.domain || connectedDomain,
        status: result.status,
        ssl_status: result.ssl_status,
      });
      setDomainInput("");
      setFeedback({ type: "success", message: t("settings.feedback.domainConnected") });
    } catch (err: unknown) {
      const message =
        err instanceof Error ? err.message : t("settings.feedback.domainConnectError");
      setFeedback({ type: "error", message });
    } finally {
      setDomainLoading(false);
    }
  };

  const handleDisconnectDomain = async () => {
    setDomainLoading(true);
    setFeedback(null);
    try {
      await customDomainService.disconnect();
      setDomainStatus({ configured: false });
      setFeedback({ type: "success", message: t("settings.feedback.domainRemoved") });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : t("settings.feedback.domainRemoveError");
      setFeedback({ type: "error", message });
    } finally {
      setDomainLoading(false);
    }
  };

  const handleRefreshDomainStatus = async () => {
    try {
      const status = await customDomainService.getStatus();
      setDomainStatus(status);
    } catch {}
  };

  const loadPropertyCoordinate = useCallback(async () => {
    if (propertyCoordinateLoaded || propertyCoordinateLoadingRef.current) return;
    propertyCoordinateLoadingRef.current = true;
    try {
      const roomTypes =
        await pmsClient.get<{ latitude: number | null; longitude: number | null }[]>(
          "/admin/room-types",
        );
      const withCoords = roomTypes.filter(
        (rt) =>
          rt.latitude != null &&
          rt.longitude != null &&
          Number.isFinite(rt.latitude) &&
          Number.isFinite(rt.longitude),
      );
      if (withCoords.length === 0) {
        setPropertyCoordinateLoaded(true);
        return;
      }
      const centroid = {
        latitude: withCoords.reduce((s, rt) => s + rt.latitude!, 0) / withCoords.length,
        longitude: withCoords.reduce((s, rt) => s + rt.longitude!, 0) / withCoords.length,
      };
      setPropertyCoordinate(centroid);
      setPropertyCoordinateLoaded(true);
    } catch {
      // transient failure — leave propertyCoordinateLoaded false so next navigation retries
    } finally {
      propertyCoordinateLoadingRef.current = false;
    }
  }, [propertyCoordinateLoaded]);

  const sections: SettingsNavSection[] = [
    { id: "property", label: t("settings.tabs.property"), icon: BuildingOffice2Icon },
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
        if (id === "location") loadPropertyCoordinate();
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
                      domainStatus.ssl_status === "active"
                        ? "bg-green-100 text-green-700"
                        : domainStatus.status === "pending"
                          ? "bg-yellow-100 text-yellow-700"
                          : "bg-gray-100 text-gray-700"
                    }`}
                  >
                    {domainStatus.ssl_status === "active"
                      ? t("settings.booking.active")
                      : domainStatus.status === "pending"
                        ? t("settings.booking.pendingDns")
                        : domainStatus.ssl_status || t("settings.booking.checking")}
                  </span>
                  <button
                    onClick={handleRefreshDomainStatus}
                    className="text-[11px] text-primary-600 hover:text-primary-700"
                  >
                    {t("settings.booking.refresh")}
                  </button>
                </div>

                {domainStatus.ssl_status !== "active" && (
                  <div className="bg-blue-50 border border-blue-200 rounded-lg p-4">
                    <p className="text-[13px] font-medium text-blue-900 mb-2">
                      {t("settings.booking.dnsSetupRequired")}
                    </p>
                    <p className="text-[13px] text-blue-700 mb-2">
                      {t("settings.booking.dnsInstructions")}
                    </p>
                    <div className="bg-white rounded p-3 font-mono text-[11px] text-gray-800 space-y-1">
                      <div>
                        <span className="text-gray-500">{t("settings.booking.dnsType")}</span> CNAME
                      </div>
                      <div>
                        <span className="text-gray-500">{t("settings.booking.dnsName")}</span>{" "}
                        {domainStatus.domain}
                      </div>
                      <div>
                        <span className="text-gray-500">{t("settings.booking.dnsTarget")}</span>{" "}
                        custom.booking.vayada.com
                      </div>
                    </div>
                  </div>
                )}

                {domainStatus.verification_errors &&
                  domainStatus.verification_errors.length > 0 && (
                    <div className="bg-red-50 border border-red-200 rounded-lg p-3">
                      <p className="text-[13px] text-red-700">
                        {domainStatus.verification_errors.join(", ")}
                      </p>
                    </div>
                  )}

                <button
                  onClick={handleDisconnectDomain}
                  disabled={domainLoading}
                  className="px-4 py-2 text-[13px] font-medium text-red-600 border border-red-300 rounded-lg hover:bg-red-50 disabled:opacity-50 transition-colors"
                >
                  {domainLoading
                    ? t("settings.booking.removing")
                    : t("settings.booking.removeDomain")}
                </button>
              </div>
            ) : (
              <div className="space-y-3 mt-1">
                <p className="text-[13px] text-gray-500">
                  {t("settings.booking.customDomainDesc")}
                </p>
                <div className="flex gap-3">
                  <input
                    type="text"
                    value={domainInput}
                    onChange={(e) => setDomainInput(e.target.value)}
                    placeholder={t("settings.booking.customDomainPlaceholder")}
                    className="flex-1 px-2.5 py-1.5 border border-gray-300 rounded-lg text-[13px] focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-transparent"
                  />
                  <button
                    onClick={handleConnectDomain}
                    disabled={domainLoading || !domainInput.trim()}
                    className="px-4 py-2 text-[13px] font-medium bg-primary-500 text-white rounded-lg hover:bg-primary-600 disabled:opacity-50 transition-colors"
                  >
                    {domainLoading
                      ? t("settings.booking.connecting")
                      : t("settings.booking.connectDomain")}
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
                {propertyCoordinateLoaded && !propertyCoordinate && (
                  <div className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-[12px] text-amber-800">
                    Set a location on your room types in <strong>Rooms &amp; Rates</strong> so the
                    map knows where to center.
                  </div>
                )}
                <LocationMapPreview
                  propertyName={settings.property_name}
                  property={propertyCoordinate}
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
        <div className="mt-5 space-y-4">
          {/* Change Email card */}
          <div className="bg-white rounded-lg border border-gray-200 p-4 md:p-5">
            <div className="flex items-center gap-1.5 mb-0.5">
              <EnvelopeIcon className="w-4 h-4 text-gray-700" />
              <h2 className="text-sm font-semibold text-gray-900">
                {t("settings.security.changeEmailTitle")}
              </h2>
            </div>
            <p className="text-[13px] text-gray-500 mb-4">
              {t("settings.security.changeEmailSubtitle")}
            </p>

            <div className="space-y-3 max-w-sm">
              <div>
                <label className="block text-[13px] font-medium text-gray-700 mb-0.5">
                  {t("settings.security.newEmailLabel")}
                </label>
                <div className="relative">
                  <EnvelopeIcon className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-gray-400" />
                  <input
                    type="email"
                    value={emailForm.new_email}
                    onChange={(e) => setEmailForm({ ...emailForm, new_email: e.target.value })}
                    className="w-full pl-8 pr-2.5 py-1.5 border border-gray-300 rounded-lg text-[13px] focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-transparent"
                    placeholder={t("settings.security.newEmailPlaceholder")}
                  />
                </div>
              </div>
              <PasswordField
                label={t("settings.security.currentPasswordLabel")}
                value={emailForm.password}
                onChange={(value) => setEmailForm({ ...emailForm, password: value })}
                placeholder={t("settings.security.confirmWithPassword")}
              />
            </div>

            {emailFeedback && (
              <FeedbackAlert
                type={emailFeedback.type}
                message={emailFeedback.message}
                className="mt-3 max-w-sm"
              />
            )}

            <div className="flex justify-end mt-4">
              <SaveButton
                onClick={handleChangeEmail}
                saving={changingEmail}
                disabled={!emailForm.new_email || !emailForm.password}
                icon={<EnvelopeIcon className="w-3.5 h-3.5" />}
              >
                {t("settings.security.updateEmail")}
              </SaveButton>
            </div>
          </div>

          {/* Change Password card */}
          <div className="bg-white rounded-lg border border-gray-200 p-4 md:p-5">
            <div className="flex items-center gap-1.5 mb-0.5">
              <LockClosedIcon className="w-4 h-4 text-gray-700" />
              <h2 className="text-sm font-semibold text-gray-900">
                {t("settings.security.changePasswordTitle")}
              </h2>
            </div>
            <p className="text-[13px] text-gray-500 mb-4">
              {t("settings.security.changePasswordSubtitle")}
            </p>

            <div className="space-y-3 max-w-sm">
              <PasswordField
                label={t("settings.security.currentPasswordLabel")}
                value={passwordForm.current_password}
                onChange={(value) => setPasswordForm({ ...passwordForm, current_password: value })}
                placeholder={t("settings.security.currentPasswordPlaceholder")}
              />
              <PasswordField
                label={t("settings.security.newPasswordLabel")}
                value={passwordForm.new_password}
                onChange={(value) => setPasswordForm({ ...passwordForm, new_password: value })}
                placeholder={t("settings.security.newPasswordPlaceholder")}
              />
              <PasswordField
                label={t("settings.security.confirmNewPasswordLabel")}
                value={passwordForm.confirm_password}
                onChange={(value) => setPasswordForm({ ...passwordForm, confirm_password: value })}
                placeholder={t("settings.security.confirmNewPasswordPlaceholder")}
              />
            </div>

            {passwordFeedback && (
              <FeedbackAlert
                type={passwordFeedback.type}
                message={passwordFeedback.message}
                className="mt-3 max-w-sm"
              />
            )}

            <div className="flex justify-end mt-4">
              <SaveButton
                onClick={handleChangePassword}
                saving={changingPassword}
                disabled={
                  !passwordForm.current_password ||
                  !passwordForm.new_password ||
                  !passwordForm.confirm_password
                }
                icon={<LockClosedIcon className="w-3.5 h-3.5" />}
              >
                {t("settings.security.updatePassword")}
              </SaveButton>
            </div>
          </div>

          {/* Two-factor authentication + login history */}
          <TotpSettings />
        </div>
      )}

      {/* Billing tab */}
      {activeSection === "billing" && (
        <div className="mt-5 space-y-4">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {/* Commission Plan */}
            <div
              className={`bg-white rounded-lg border-2 p-5 transition-all ${
                settings.billing_active_plan === "commission" && !settings.billing_pending_switch
                  ? "border-primary-500 ring-1 ring-primary-200"
                  : settings.billing_pending_switch === "commission"
                    ? "border-amber-400 ring-1 ring-amber-200"
                    : "border-gray-200"
              }`}
            >
              <div className="flex items-center justify-between mb-3">
                <h3 className="text-[14px] font-semibold text-gray-900">
                  {t("settings.billing.commission")}
                </h3>
                {settings.billing_active_plan === "commission" &&
                  !settings.billing_pending_switch && (
                    <span className="px-2 py-0.5 text-[10px] font-bold bg-green-100 text-green-700 rounded-full">
                      {t("settings.billing.current")}
                    </span>
                  )}
                {settings.billing_pending_switch === "commission" && (
                  <span className="px-2 py-0.5 text-[10px] font-bold bg-amber-100 text-amber-700 rounded-full">
                    {t("settings.billing.nextMonth")}
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
              {settings.billing_active_plan !== "commission" &&
                !settings.billing_pending_switch && (
                  <button
                    onClick={async () => {
                      try {
                        await settingsService.updatePropertySettings({
                          billing_pending_switch: "commission",
                        });
                        setSettings((s) => ({ ...s, billing_pending_switch: "commission" }));
                      } catch {
                        /* */
                      }
                    }}
                    className="w-full py-2 text-[12px] font-semibold border border-gray-300 text-gray-700 rounded-lg hover:bg-gray-50 transition-colors"
                  >
                    {t("settings.billing.switchFromNextMonth")}
                  </button>
                )}
              {settings.billing_pending_switch === "commission" && (
                <button
                  onClick={async () => {
                    try {
                      await settingsService.updatePropertySettings({ billing_pending_switch: "" });
                      setSettings((s) => ({ ...s, billing_pending_switch: null }));
                    } catch {
                      /* */
                    }
                  }}
                  className="w-full py-2 text-[12px] font-semibold border border-amber-300 text-amber-700 rounded-lg hover:bg-amber-50 transition-colors"
                >
                  {t("settings.billing.cancelSwitch")}
                </button>
              )}
            </div>

            {/* Fixed Fee Plan */}
            <div
              className={`bg-white rounded-lg border-2 p-5 transition-all ${
                settings.billing_active_plan === "fixed" && !settings.billing_pending_switch
                  ? "border-primary-500 ring-1 ring-primary-200"
                  : settings.billing_pending_switch === "fixed"
                    ? "border-amber-400 ring-1 ring-amber-200"
                    : "border-gray-200"
              }`}
            >
              <div className="flex items-center justify-between mb-3">
                <h3 className="text-[14px] font-semibold text-gray-900">
                  {t("settings.billing.fixedFee")}
                </h3>
                {settings.billing_active_plan === "fixed" && !settings.billing_pending_switch && (
                  <span className="px-2 py-0.5 text-[10px] font-bold bg-green-100 text-green-700 rounded-full">
                    {t("settings.billing.current")}
                  </span>
                )}
                {settings.billing_pending_switch === "fixed" && (
                  <span className="px-2 py-0.5 text-[10px] font-bold bg-amber-100 text-amber-700 rounded-full">
                    {t("settings.billing.nextMonth")}
                  </span>
                )}
              </div>
              <p className="text-[12px] text-gray-500 mb-3">{t("settings.billing.flatMonthly")}</p>
              <div className="bg-gray-50 rounded-xl p-4 text-center mb-4">
                <span className="text-3xl font-bold text-gray-900">
                  $
                  {(
                    settings.fixed_plan_projected_monthly_fee ??
                    settings.billing_fixed_fee ??
                    30
                  ).toLocaleString("en-US", { minimumFractionDigits: 0, maximumFractionDigits: 2 })}
                </span>
                <p className="text-[11px] text-gray-400 mt-1">{t("settings.billing.perMonth")}</p>
                <p className="text-[10px] text-gray-400 mt-0.5">
                  {typeof settings.active_room_count === "number"
                    ? t(
                        settings.active_room_count === 1
                          ? "settings.billing.atActiveRoomsOne"
                          : "settings.billing.atActiveRoomsOther",
                        { count: settings.active_room_count },
                      )
                    : t("settings.billing.baseFeePerRoom")}
                </p>
              </div>
              {settings.billing_active_plan !== "fixed" && !settings.billing_pending_switch && (
                <button
                  onClick={async () => {
                    try {
                      await settingsService.updatePropertySettings({
                        billing_pending_switch: "fixed",
                      });
                      setSettings((s) => ({ ...s, billing_pending_switch: "fixed" }));
                    } catch {
                      /* */
                    }
                  }}
                  className="w-full py-2 text-[12px] font-semibold border border-gray-300 text-gray-700 rounded-lg hover:bg-gray-50 transition-colors"
                >
                  {t("settings.billing.switchFromNextMonth")}
                </button>
              )}
              {settings.billing_pending_switch === "fixed" && (
                <button
                  onClick={async () => {
                    try {
                      await settingsService.updatePropertySettings({ billing_pending_switch: "" });
                      setSettings((s) => ({ ...s, billing_pending_switch: null }));
                    } catch {
                      /* */
                    }
                  }}
                  className="w-full py-2 text-[12px] font-semibold border border-amber-300 text-amber-700 rounded-lg hover:bg-amber-50 transition-colors"
                >
                  {t("settings.billing.cancelSwitch")}
                </button>
              )}
            </div>
          </div>

          {settings.billing_pending_switch && (
            <div className="bg-amber-50 border border-amber-200 rounded-lg p-4">
              <p className="text-[13px] text-amber-800">
                {t("settings.billing.switchBannerLeadTo")}{" "}
                <strong>
                  {settings.billing_pending_switch === "commission"
                    ? t("settings.billing.commission")
                    : t("settings.billing.fixedFee")}
                </strong>{" "}
                {settings.billing_switch_effective_date
                  ? t("settings.billing.switchBannerOnDate", {
                      date: new Date(settings.billing_switch_effective_date).toLocaleDateString(
                        undefined,
                        { day: "numeric", month: "long", year: "numeric" },
                      ),
                    })
                  : t("settings.billing.switchBannerNextMonth")}
              </p>
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
