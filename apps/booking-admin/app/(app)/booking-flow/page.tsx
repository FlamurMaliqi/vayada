"use client";

import { useState, useEffect, useRef } from "react";
import { useTranslation } from "@/lib/i18n";
import {
  GlobeAltIcon,
  HomeIcon,
  SparklesIcon,
  TicketIcon,
  CheckBadgeIcon,
  ClipboardDocumentListIcon,
  ClockIcon,
  PlusIcon,
  XMarkIcon,
} from "@heroicons/react/24/outline";
import {
  settingsService,
  type AddonItem,
  type AddonSettings,
  type PromoCodeItem,
} from "@/services/settings";
import {
  getBookingAddonSettings,
  updateBookingAddonSettings,
} from "@/services/api/bookingAddonSettingsClient";
import {
  BookingAddonItemsClientError,
  createBookingAddonItem,
  deleteBookingAddonItem,
  getBookingAddonItemsContext,
  updateBookingAddonItem,
  type BookingAddonItem,
  type BookingAddonPricingModel,
  type BookingPropertyPlan,
  type CreateBookingAddonItemBody,
} from "@/services/api/bookingAddonItemsClient";
import {
  createBookingPromoCode,
  deleteBookingPromoCode,
  listBookingPromoCodes,
  updateBookingPromoCode,
  type BookingPromoCode,
  type CreateBookingPromoCodeBody,
} from "@/services/api/bookingPromoCodesClient";
import {
  getBookingBenefitsSettings,
  type BookingBenefitsSettings,
} from "@/services/api/bookingBenefitsSettingsClient";
import {
  getBookingGuestFormSettings,
  type BookingGuestFormSettings,
} from "@/services/api/bookingGuestFormSettingsClient";
import {
  getBookingLocalizationSettings,
  type BookingLocalizationSettings,
} from "@/services/api/bookingLocalizationSettingsClient";
import {
  BookingLastMinuteSettingsClientError,
  getBookingLastMinuteSettings,
  updateBookingLastMinuteSettings,
  type BookingLastMinuteSettings,
  type BookingLastMinuteTier,
} from "@/services/api/bookingLastMinuteSettingsClient";
import {
  getBookingRoomFilterSettings,
  updateBookingRoomFilterSettings,
  type BookingRoomFilterSettings,
} from "@/services/api/bookingRoomFilterSettingsClient";
import {
  loadBookingFlowSetting,
  normalizeBookingBenefitsSettings,
  normalizeBookingRoomFilterSettings,
} from "@/services/api/bookingFlowSettingsLoader";
import { apiClient } from "@/services/api/client";
import { FeedbackAlert } from "@/components/ui";
import { SettingsLayout, type SettingsNavSection } from "@/components/settings/layout";
import { DEFAULT_LAST_MINUTE_TIERS } from "@vayada/product-onboarding";

import RoomsTab from "@/components/booking-flow/RoomsTab";
import AddonsTab, { type AddonItemFormValues } from "@/components/booking-flow/AddonsTab";
import BenefitsTab from "@/components/booking-flow/BenefitsTab";
import PromoCodesTab, { type PromoCodeFormValues } from "@/components/booking-flow/PromoCodesTab";
import LocalizationTab from "@/components/booking-flow/LocalizationTab";
import GuestFormTab from "@/components/booking-flow/GuestFormTab";
import {
  useBenefitsSettingsTab,
  useGuestFormSettingsTab,
  useLocalizationSettingsTab,
} from "@/components/booking-flow/useBookingFlowSettingsTabs";

type Tab =
  | "rooms"
  | "addons"
  | "benefits"
  | "promo-codes"
  | "localization"
  | "guest-form"
  | "last-minute";

type PmsRoomsResponse = {
  items?: {
    roomId: string;
    roomNumber: string;
  }[];
};

const DEFAULT_ADDON_SETTINGS: AddonSettings = {
  showAddonsStep: true,
  groupAddonsByCategory: true,
};

const DEFAULT_PROPERTY_PLAN: BookingPropertyPlan = {
  propertyId: "",
  plan: "commission",
  limits: {
    maxRoomPhotosPerType: 10,
    maxAddons: 3,
    guestContactAccess: "after_acceptance",
  },
};

const DEFAULT_GUEST_FORM_SETTINGS: BookingGuestFormSettings = {
  specialRequestsEnabled: true,
  arrivalTimeEnabled: false,
  guestCountEnabled: false,
  phoneRequired: true,
  adultAgeThreshold: 18,
  childrenEnabled: true,
};

const DEFAULT_BENEFITS_SETTINGS: BookingBenefitsSettings = {
  benefits: [],
};

const DEFAULT_LOCALIZATION_SETTINGS: BookingLocalizationSettings = {
  defaultCurrency: "EUR",
  defaultLanguage: "en",
  supportedCurrencies: [],
  supportedLanguages: [],
};

const DEFAULT_ROOM_FILTER_SETTINGS: BookingRoomFilterSettings = {
  bookingFilters: [],
  customFilters: {},
  filterRooms: {},
};

const DEFAULT_LAST_MINUTE_SETTINGS: BookingLastMinuteSettings = {
  enabled: false,
  stackWithPromo: false,
  tiers: [],
  updatedAt: "",
};

function pickRecordByKeys<T>(record: Record<string, T>, keys: string[]): Record<string, T> {
  const allowedKeys = new Set(keys);
  return Object.fromEntries(Object.entries(record).filter(([key]) => allowedKeys.has(key)));
}

function getSelectedBookingHotelId(): string | null {
  if (typeof window === "undefined") return null;
  return window.localStorage.getItem("selectedHotelId");
}

function toSettingsAddonItem(item: BookingAddonItem): AddonItem {
  return {
    id: item.addonItemId,
    name: item.name,
    description: item.description,
    price: Number(item.price) || 0,
    currency: item.currency,
    category: item.category,
    image: item.imageUrl ?? "",
    duration: item.duration ?? undefined,
    perPerson: item.pricingModel === "per_guest" || item.pricingModel === "per_guest_night",
    perNight: item.pricingModel === "per_night" || item.pricingModel === "per_guest_night",
    sortOrder: item.sortOrder,
    ownershipKind: item.ownershipKind,
    partnerCommissionRate: item.partnerCommissionRate,
  };
}

function toAddonPricingModel(addon: { perPerson?: boolean; perNight?: boolean }) {
  if (addon.perPerson && addon.perNight) return "per_guest_night";
  if (addon.perPerson) return "per_guest";
  if (addon.perNight) return "per_night";
  return "per_stay";
}

function toAddonWritableFields(values: AddonItemFormValues) {
  const fields = {
    name: values.name,
    description: values.description,
    price: values.price,
    currency: values.currency,
    category: values.category,
    imageUrl: values.image || null,
    duration: values.duration || null,
    pricingModel: toAddonPricingModel(values) as BookingAddonPricingModel,
  };
  return values.ownershipKind === "partner"
    ? {
        ...fields,
        ownershipKind: "partner" as const,
        partnerCommissionRate: values.partnerCommissionRate,
      }
    : {
        ...fields,
        ownershipKind: "property" as const,
        partnerCommissionRate: null,
      };
}

function toAddonCreateBody(
  values: AddonItemFormValues,
  sortOrder: number,
): CreateBookingAddonItemBody {
  return {
    ...toAddonWritableFields(values),
    publicVisible: true,
    status: "active",
    sortOrder,
  };
}

function orderAddons(addons: AddonItem[]): AddonItem[] {
  return addons
    .map((addon, index) => ({ addon, index }))
    .sort((left, right) => {
      const leftOrder = left.addon.sortOrder ?? left.index;
      const rightOrder = right.addon.sortOrder ?? right.index;
      return leftOrder - rightOrder || left.index - right.index;
    })
    .map(({ addon }) => addon);
}

function nextAddonSortOrder(addons: AddonItem[]): number {
  return addons.reduce((max, addon) => Math.max(max, addon.sortOrder ?? -1), -1) + 1;
}

function moveAddon(addons: AddonItem[], sourceAddonId: string, targetAddonId: string): AddonItem[] {
  const ordered = orderAddons(addons);
  const sourceIndex = ordered.findIndex((addon) => addon.id === sourceAddonId);
  const targetIndex = ordered.findIndex((addon) => addon.id === targetAddonId);
  if (sourceIndex < 0 || targetIndex < 0 || sourceIndex === targetIndex) return ordered;

  const [movedAddon] = ordered.splice(sourceIndex, 1);
  if (!movedAddon) return ordered;
  ordered.splice(targetIndex, 0, movedAddon);
  return ordered.map((addon, index) => ({ ...addon, sortOrder: index }));
}

function toSettingsPromoCode(item: BookingPromoCode): PromoCodeItem {
  return {
    id: item.promoCodeId,
    code: item.code,
    discountType: item.discountType,
    discountValue: Number(item.discountValue) || 0,
    currency: item.currency,
    validFrom: item.validFrom,
    validUntil: item.validUntil,
    isActive: item.isActive,
    maxUses: item.maxUses,
    useCount: item.useCount,
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
  };
}

function toPromoCodeBody(values: PromoCodeFormValues): CreateBookingPromoCodeBody {
  return {
    code: values.code,
    discountType: values.discountType,
    discountValue: values.discountValue,
    currency: values.discountType === "fixed" ? values.currency : null,
    validFrom: values.validFrom || null,
    validUntil: values.validUntil || null,
    isActive: values.isActive,
    maxUses: values.maxUses ? Number(values.maxUses) : null,
  };
}

export default function BookingFlowPage() {
  const [activeTab, setActiveTab] = useState<Tab>("rooms");
  const [loading, setLoading] = useState(true);
  const [feedback, setFeedback] = useState<{ type: "success" | "error"; message: string } | null>(
    null,
  );

  const [addons, setAddons] = useState<AddonItem[]>([]);
  const [propertyPlan, setPropertyPlan] = useState<BookingPropertyPlan>(DEFAULT_PROPERTY_PLAN);
  const [addonSettings, setAddonSettings] = useState<AddonSettings>(DEFAULT_ADDON_SETTINGS);
  const addonSettingsRef = useRef<AddonSettings>(DEFAULT_ADDON_SETTINGS);
  const addonSettingsWriteSeqRef = useRef(0);
  const addonSettingsSaveChainRef = useRef<Promise<unknown>>(Promise.resolve());

  const [promoCodes, setPromoCodes] = useState<PromoCodeItem[]>([]);

  // Rooms state (filters)
  const [bookingHotelId, setBookingHotelId] = useState<string | null>(null);
  const [bookingFilters, setBookingFilters] = useState<string[]>([]);
  const [customFilters, setCustomFilters] = useState<Record<string, string>>({});
  const [filterRooms, setFilterRooms] = useState<Record<string, string[]>>({});
  const [filtersEnabled, setFiltersEnabled] = useState(false);
  const [savingFilters, setSavingFilters] = useState(false);
  const [pmsRooms, setPmsRooms] = useState<{ id: string; name: string }[]>([]);
  const [pmsRoomsLoading, setPmsRoomsLoading] = useState(false);
  const [lastMinuteSettings, setLastMinuteSettings] = useState<BookingLastMinuteSettings>(
    DEFAULT_LAST_MINUTE_SETTINGS,
  );
  const [savingLastMinute, setSavingLastMinute] = useState(false);

  const { t } = useTranslation();

  const showFeedback = (type: "success" | "error", message: string) => {
    setFeedback({ type, message });
    setTimeout(() => setFeedback(null), 3000);
  };

  const getBookingHotelIdForSave = () => {
    const hotelId = bookingHotelId || getSelectedBookingHotelId();
    if (!hotelId) {
      throw new Error("Booking hotel id is required.");
    }
    return hotelId;
  };

  const {
    benefits,
    setBenefits,
    benefitInput,
    setBenefitInput,
    savingBenefits,
    handleSaveBenefits,
  } = useBenefitsSettingsTab({ getBookingHotelIdForSave, showFeedback });
  const {
    specialRequestsEnabled,
    setSpecialRequestsEnabled,
    arrivalTimeEnabled,
    setArrivalTimeEnabled,
    guestCountEnabled,
    setGuestCountEnabled,
    phoneRequired,
    setPhoneRequired,
    adultAgeThreshold,
    setAdultAgeThreshold,
    childrenEnabled,
    setChildrenEnabled,
    savingGuestForm,
    applyGuestFormSettings,
    handleSaveGuestForm,
  } = useGuestFormSettingsTab({ getBookingHotelIdForSave, showFeedback });
  const {
    defaultCurrency,
    setDefaultCurrency,
    defaultLanguage,
    setDefaultLanguage,
    supportedCurrencies,
    setSupportedCurrencies,
    supportedLanguages,
    setSupportedLanguages,
    savingCurrencyLang,
    applyLocalizationSettings,
    handleSaveCurrencyLang,
  } = useLocalizationSettingsTab({ getBookingHotelIdForSave, showFeedback });

  useEffect(() => {
    const selectedHotelId = getSelectedBookingHotelId();
    const propertyPromise = settingsService.getPropertySettings().catch(() => null);
    const loadTypedSetting = <TSettings,>(
      read: (hotelId: string) => Promise<TSettings>,
      defaultValue: TSettings,
    ) =>
      loadBookingFlowSetting({
        selectedHotelId,
        propertyPromise,
        read,
        defaultValue,
      });
    const addonSettingsPromise = loadTypedSetting(
      (hotelId) => getBookingAddonSettings({ hotelId }),
      DEFAULT_ADDON_SETTINGS,
    );
    const addonItemsPromise = loadTypedSetting(
      (hotelId) =>
        getBookingAddonItemsContext({ hotelId }).then((context) => ({
          addonItems: context.addonItems.map(toSettingsAddonItem),
          propertyPlan: context.propertyPlan,
        })),
      { addonItems: [] as AddonItem[], propertyPlan: DEFAULT_PROPERTY_PLAN },
    );
    const promoCodesPromise = loadTypedSetting(
      (hotelId) =>
        listBookingPromoCodes({ hotelId }).then((items) => items.map(toSettingsPromoCode)),
      [] as PromoCodeItem[],
    );
    const guestFormSettingsPromise = loadTypedSetting(
      (hotelId) => getBookingGuestFormSettings({ hotelId }),
      DEFAULT_GUEST_FORM_SETTINGS,
    );
    const benefitsSettingsPromise = loadTypedSetting(
      (hotelId) => getBookingBenefitsSettings({ hotelId }),
      DEFAULT_BENEFITS_SETTINGS,
    );
    const localizationSettingsPromise = loadTypedSetting(
      (hotelId) => getBookingLocalizationSettings({ hotelId }),
      DEFAULT_LOCALIZATION_SETTINGS,
    );
    const roomFilterSettingsPromise = loadTypedSetting(
      (hotelId) => getBookingRoomFilterSettings({ hotelId }),
      DEFAULT_ROOM_FILTER_SETTINGS,
    );
    const lastMinuteSettingsPromise = loadTypedSetting(
      (hotelId) => getBookingLastMinuteSettings({ hotelId }),
      DEFAULT_LAST_MINUTE_SETTINGS,
    );

    Promise.all([
      addonSettingsPromise,
      addonItemsPromise,
      promoCodesPromise,
      benefitsSettingsPromise,
      guestFormSettingsPromise,
      localizationSettingsPromise,
      roomFilterSettingsPromise,
      lastMinuteSettingsPromise,
      propertyPromise,
    ])
      .then(
        ([
          settings,
          addonContext,
          promoItems,
          benefitsRes,
          guestFormSettings,
          localizationSettings,
          roomFilterSettings,
          lastMinuteSettings,
          property,
        ]) => {
          setBookingHotelId(selectedHotelId || property?.id || null);
          addonSettingsRef.current = settings;
          setAddonSettings(settings);
          setAddons(orderAddons(addonContext.addonItems));
          setPropertyPlan(addonContext.propertyPlan);
          setPromoCodes(promoItems);
          setBenefits(
            normalizeBookingBenefitsSettings(benefitsRes, DEFAULT_BENEFITS_SETTINGS).benefits,
          );
          applyGuestFormSettings(guestFormSettings);
          applyLocalizationSettings(localizationSettings);
          const normalizedRoomFilterSettings = normalizeBookingRoomFilterSettings(
            roomFilterSettings,
            DEFAULT_ROOM_FILTER_SETTINGS,
          );
          setBookingFilters(normalizedRoomFilterSettings.bookingFilters);
          setFiltersEnabled(normalizedRoomFilterSettings.bookingFilters.length > 0);
          setCustomFilters(normalizedRoomFilterSettings.customFilters);
          setFilterRooms(normalizedRoomFilterSettings.filterRooms);
          setLastMinuteSettings(lastMinuteSettings);
          if (property?.id) {
            setPmsRoomsLoading(true);
            apiClient
              .get<PmsRoomsResponse>(`/api/pms/properties/${encodeURIComponent(property.id)}/rooms`)
              .then((response) =>
                setPmsRooms(
                  (response.items ?? []).map((room) => ({
                    id: room.roomId,
                    name: room.roomNumber,
                  })),
                ),
              )
              .catch(() => setPmsRooms([]))
              .finally(() => setPmsRoomsLoading(false));
          }
        },
      )
      .finally(() => setLoading(false));
  }, [applyGuestFormSettings, applyLocalizationSettings, setBenefits]);

  const handleToggleAddonSetting = async (key: keyof AddonSettings) => {
    const previous = addonSettingsRef.current;
    const newValue = !previous[key];
    const updated = { ...previous, [key]: newValue };
    const writeSeq = ++addonSettingsWriteSeqRef.current;
    addonSettingsRef.current = updated;
    setAddonSettings(updated);

    const savePromise = addonSettingsSaveChainRef.current.then(() =>
      updateBookingAddonSettings({
        hotelId: getBookingHotelIdForSave(),
        body: updated,
      }),
    );
    addonSettingsSaveChainRef.current = savePromise.catch(() => undefined);

    try {
      const saved = await savePromise;
      if (writeSeq === addonSettingsWriteSeqRef.current) {
        addonSettingsRef.current = saved;
        setAddonSettings(saved);
      }
    } catch {
      if (writeSeq === addonSettingsWriteSeqRef.current) {
        addonSettingsRef.current = previous;
        setAddonSettings(previous);
        showFeedback("error", t("bookingFlow.addons.feedback.settingError"));
      }
    }
  };

  const handleCreateAddon = async (values: AddonItemFormValues) => {
    try {
      const saved = await createBookingAddonItem({
        hotelId: getBookingHotelIdForSave(),
        body: toAddonCreateBody(values, nextAddonSortOrder(addons)),
      });
      setAddons((current) => orderAddons([...current, toSettingsAddonItem(saved)]));
      showFeedback("success", t("bookingFlow.addons.feedback.createSuccess"));
    } catch (error) {
      const message =
        error instanceof BookingAddonItemsClientError
          ? error.detail
          : t("bookingFlow.addons.feedback.saveError");
      showFeedback("error", message);
      if (error instanceof BookingAddonItemsClientError && error.statusCode === 409) {
        try {
          const context = await getBookingAddonItemsContext({
            hotelId: getBookingHotelIdForSave(),
          });
          setAddons(orderAddons(context.addonItems.map(toSettingsAddonItem)));
          setPropertyPlan(context.propertyPlan);
        } catch {
          // Preserve the authoritative create error when a best-effort refresh also fails.
        }
      }
      throw error;
    }
  };

  const handleUpdateAddon = async (addonId: string, values: AddonItemFormValues) => {
    try {
      const saved = await updateBookingAddonItem({
        hotelId: getBookingHotelIdForSave(),
        addonItemId: addonId,
        body: toAddonWritableFields(values),
      });
      setAddons((current) =>
        orderAddons(
          current.map((addon) => (addon.id === addonId ? toSettingsAddonItem(saved) : addon)),
        ),
      );
      showFeedback("success", t("bookingFlow.addons.feedback.updateSuccess"));
    } catch (error) {
      const message =
        error instanceof BookingAddonItemsClientError
          ? error.detail
          : t("bookingFlow.addons.feedback.saveError");
      showFeedback("error", message);
      throw error;
    }
  };

  const handleReorderAddon = async (sourceAddonId: string, targetAddonId: string) => {
    const previousAddons = addons;
    const reorderedAddons = moveAddon(previousAddons, sourceAddonId, targetAddonId);
    const previousOrderById = new Map(previousAddons.map((addon) => [addon.id, addon.sortOrder]));
    const changedAddons = reorderedAddons.filter(
      (addon) => previousOrderById.get(addon.id) !== addon.sortOrder,
    );
    if (changedAddons.length === 0) return;

    setAddons(reorderedAddons);
    try {
      const hotelId = getBookingHotelIdForSave();
      await Promise.all(
        changedAddons.map((addon) =>
          updateBookingAddonItem({
            hotelId,
            addonItemId: addon.id,
            body: { sortOrder: addon.sortOrder ?? 0 },
          }),
        ),
      );
    } catch {
      setAddons(previousAddons);
      showFeedback("error", t("bookingFlow.addons.feedback.saveError"));
      throw new Error("Failed to reorder add-ons.");
    }
  };

  const handleDeleteAddon = async (addonId: string) => {
    try {
      await deleteBookingAddonItem({
        hotelId: getBookingHotelIdForSave(),
        addonItemId: addonId,
      });
      setAddons((current) => current.filter((addon) => addon.id !== addonId));
      showFeedback("success", t("bookingFlow.addons.feedback.deleteSuccess"));
    } catch {
      showFeedback("error", t("bookingFlow.addons.feedback.deleteError"));
      throw new Error("Failed to delete add-on.");
    }
  };

  const handleCreatePromoCode = async (values: PromoCodeFormValues) => {
    try {
      const saved = await createBookingPromoCode({
        hotelId: getBookingHotelIdForSave(),
        body: toPromoCodeBody(values),
      });
      setPromoCodes((current) => [...current, toSettingsPromoCode(saved)]);
      showFeedback("success", "Promo code created.");
    } catch (error) {
      showFeedback(
        "error",
        error instanceof Error ? error.message : "Promo code could not be saved.",
      );
      throw error;
    }
  };

  const handleUpdatePromoCode = async (promoCodeId: string, values: PromoCodeFormValues) => {
    try {
      const saved = await updateBookingPromoCode({
        hotelId: getBookingHotelIdForSave(),
        promoCodeId,
        body: toPromoCodeBody(values),
      });
      setPromoCodes((current) =>
        current.map((promoCode) =>
          promoCode.id === promoCodeId ? toSettingsPromoCode(saved) : promoCode,
        ),
      );
      showFeedback("success", "Promo code updated.");
    } catch (error) {
      showFeedback(
        "error",
        error instanceof Error ? error.message : "Promo code could not be saved.",
      );
      throw error;
    }
  };

  const handleDeletePromoCode = async (promoCodeId: string) => {
    try {
      await deleteBookingPromoCode({
        hotelId: getBookingHotelIdForSave(),
        promoCodeId,
      });
      setPromoCodes((current) => current.filter((promoCode) => promoCode.id !== promoCodeId));
      showFeedback("success", "Promo code deleted.");
    } catch (error) {
      showFeedback(
        "error",
        error instanceof Error ? error.message : "Promo code could not be deleted.",
      );
      throw error;
    }
  };

  // ── Filter handlers (Rooms tab) ──

  const handleToggleFiltersEnabled = async () => {
    const newEnabled = !filtersEnabled;
    setFiltersEnabled(newEnabled);
    if (!newEnabled) {
      // Auto-save when disabling filters
      try {
        const saved = await updateBookingRoomFilterSettings({
          hotelId: getBookingHotelIdForSave(),
          body: {
            bookingFilters: [],
            customFilters: {},
            filterRooms: {},
          },
        });
        setBookingFilters(saved.bookingFilters);
        setFilterRooms(saved.filterRooms);
      } catch {
        setFiltersEnabled(true);
        setFeedback({ type: "error", message: t("bookingFlow.rooms.feedback.disableError") });
      }
    }
  };

  const handleSaveFilters = async () => {
    try {
      setSavingFilters(true);
      const filters = filtersEnabled ? bookingFilters : [];
      const rooms = filtersEnabled ? pickRecordByKeys(filterRooms, filters) : {};
      const nextCustomFilters = filtersEnabled ? pickRecordByKeys(customFilters, filters) : {};
      const saved = await updateBookingRoomFilterSettings({
        hotelId: getBookingHotelIdForSave(),
        body: {
          bookingFilters: filters,
          customFilters: nextCustomFilters,
          filterRooms: rooms,
        },
      });
      setBookingFilters(saved.bookingFilters);
      setFiltersEnabled(saved.bookingFilters.length > 0);
      if (saved.bookingFilters.length > 0) {
        setCustomFilters(saved.customFilters);
      }
      setFilterRooms(saved.filterRooms);
      showFeedback("success", t("bookingFlow.rooms.feedback.saveSuccess"));
    } catch {
      showFeedback("error", t("bookingFlow.rooms.feedback.saveError"));
    } finally {
      setSavingFilters(false);
    }
  };

  const updateLastMinuteTier = (
    index: number,
    field: keyof BookingLastMinuteTier,
    value: number | null,
  ) => {
    setLastMinuteSettings((current) => ({
      ...current,
      tiers: current.tiers.map((tier, tierIndex) =>
        tierIndex === index ? { ...tier, [field]: value } : tier,
      ),
    }));
  };

  const handleSaveLastMinute = async () => {
    try {
      setSavingLastMinute(true);
      const saved = await updateBookingLastMinuteSettings({
        hotelId: getBookingHotelIdForSave(),
        body: {
          enabled: lastMinuteSettings.enabled,
          stackWithPromo: lastMinuteSettings.stackWithPromo,
          tiers: lastMinuteSettings.tiers,
        },
      });
      setLastMinuteSettings(saved);
      showFeedback("success", "Last-minute settings saved.");
    } catch (error) {
      const detail =
        error instanceof BookingLastMinuteSettingsClientError
          ? error.detail
          : "Last-minute settings could not be saved.";
      showFeedback("error", detail);
    } finally {
      setSavingLastMinute(false);
    }
  };

  const sections: SettingsNavSection[] = [
    { id: "rooms", label: t("bookingFlow.tabs.filters"), icon: HomeIcon },
    { id: "addons", label: t("bookingFlow.tabs.addons"), icon: SparklesIcon },
    { id: "promo-codes", label: t("bookingFlow.tabs.promos"), icon: TicketIcon },
    { id: "benefits", label: t("bookingFlow.tabs.benefits"), icon: CheckBadgeIcon },
    {
      id: "localization",
      label: t("bookingFlow.tabs.localization"),
      icon: GlobeAltIcon,
    },
    {
      id: "guest-form",
      label: t("bookingFlow.tabs.guestForm"),
      icon: ClipboardDocumentListIcon,
    },
    { id: "last-minute", label: "Last-Minute", icon: ClockIcon },
  ];

  if (loading) {
    return (
      <div className="p-4 md:p-6 h-full flex items-center justify-center">
        <div className="w-6 h-6 border-2 border-primary-500 border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  return (
    <SettingsLayout
      title={t("bookingFlow.title")}
      description={t("bookingFlow.subtitle")}
      sections={sections}
      activeId={activeTab}
      onSelect={(id) => setActiveTab(id as Tab)}
    >
      {/* Feedback banner */}
      {feedback && (
        <FeedbackAlert type={feedback.type} message={feedback.message} className="mb-4" />
      )}

      <div>
        {activeTab === "rooms" && (
          <RoomsTab
            bookingFilters={bookingFilters}
            setBookingFilters={setBookingFilters}
            customFilters={customFilters}
            setCustomFilters={setCustomFilters}
            filterRooms={filterRooms}
            setFilterRooms={setFilterRooms}
            filtersEnabled={filtersEnabled}
            onToggleFiltersEnabled={handleToggleFiltersEnabled}
            handleSaveFilters={handleSaveFilters}
            savingFilters={savingFilters}
            rooms={pmsRooms}
            roomsLoading={pmsRoomsLoading}
          />
        )}

        {activeTab === "addons" && (
          <AddonsTab
            addons={addons}
            addonSettings={addonSettings}
            propertyCurrency={defaultCurrency}
            propertyPlan={propertyPlan}
            handleToggleAddonSetting={handleToggleAddonSetting}
            onCreateAddon={handleCreateAddon}
            onUpdateAddon={handleUpdateAddon}
            onDeleteAddon={handleDeleteAddon}
            onReorderAddon={handleReorderAddon}
          />
        )}

        {activeTab === "promo-codes" && (
          <PromoCodesTab
            promoCodes={promoCodes}
            propertyCurrency={defaultCurrency}
            onCreatePromoCode={handleCreatePromoCode}
            onUpdatePromoCode={handleUpdatePromoCode}
            onDeletePromoCode={handleDeletePromoCode}
          />
        )}

        {activeTab === "benefits" && (
          <BenefitsTab
            benefits={benefits}
            setBenefits={setBenefits}
            benefitInput={benefitInput}
            setBenefitInput={setBenefitInput}
            saveBenefits={handleSaveBenefits}
            savingBenefits={savingBenefits}
          />
        )}

        {activeTab === "localization" && (
          <LocalizationTab
            defaultCurrency={defaultCurrency}
            setDefaultCurrency={setDefaultCurrency}
            defaultLanguage={defaultLanguage}
            setDefaultLanguage={setDefaultLanguage}
            supportedCurrencies={supportedCurrencies}
            setSupportedCurrencies={setSupportedCurrencies}
            supportedLanguages={supportedLanguages}
            setSupportedLanguages={setSupportedLanguages}
            onSave={handleSaveCurrencyLang}
            saving={savingCurrencyLang}
          />
        )}

        {activeTab === "guest-form" && (
          <GuestFormTab
            specialRequestsEnabled={specialRequestsEnabled}
            setSpecialRequestsEnabled={setSpecialRequestsEnabled}
            arrivalTimeEnabled={arrivalTimeEnabled}
            setArrivalTimeEnabled={setArrivalTimeEnabled}
            guestCountEnabled={guestCountEnabled}
            setGuestCountEnabled={setGuestCountEnabled}
            phoneRequired={phoneRequired}
            setPhoneRequired={setPhoneRequired}
            adultAgeThreshold={adultAgeThreshold}
            setAdultAgeThreshold={setAdultAgeThreshold}
            childrenEnabled={childrenEnabled}
            setChildrenEnabled={setChildrenEnabled}
            onSave={handleSaveGuestForm}
            saving={savingGuestForm}
          />
        )}

        {activeTab === "last-minute" && (
          <div className="max-w-2xl space-y-4">
            <div className="rounded-lg border border-gray-200 bg-white px-4 py-4">
              <div className="flex items-center justify-between gap-4">
                <div>
                  <h2 className="text-sm font-semibold text-gray-900">Last-minute discounts</h2>
                  <p className="mt-0.5 text-[12px] text-gray-500">
                    Apply a discount when check-in is close.
                  </p>
                </div>
                <button
                  type="button"
                  aria-label={
                    lastMinuteSettings.enabled
                      ? "Disable last-minute discounts"
                      : "Enable last-minute discounts"
                  }
                  aria-pressed={lastMinuteSettings.enabled}
                  onClick={() =>
                    setLastMinuteSettings((current) =>
                      current.enabled
                        ? DEFAULT_LAST_MINUTE_SETTINGS
                        : { ...current, enabled: true },
                    )
                  }
                  className={`relative h-[22px] w-10 shrink-0 rounded-full transition-colors ${
                    lastMinuteSettings.enabled ? "bg-primary-500" : "bg-gray-300"
                  }`}
                >
                  <span
                    className={`absolute top-[2px] h-[18px] w-[18px] rounded-full bg-white shadow transition-transform ${
                      lastMinuteSettings.enabled ? "left-[20px]" : "left-[2px]"
                    }`}
                  />
                </button>
              </div>
            </div>

            {lastMinuteSettings.enabled && (
              <>
                <div className="rounded-lg border border-gray-200 bg-white px-4 py-4">
                  <div className="flex items-center justify-between gap-4">
                    <div>
                      <p className="text-[13px] font-medium text-gray-900">
                        Stack with promo codes
                      </p>
                      <p className="mt-0.5 text-[12px] text-gray-500">
                        When off, only the larger discount applies.
                      </p>
                    </div>
                    <button
                      type="button"
                      aria-label={
                        lastMinuteSettings.stackWithPromo
                          ? "Disable stack with promo codes"
                          : "Enable stack with promo codes"
                      }
                      aria-pressed={lastMinuteSettings.stackWithPromo}
                      onClick={() =>
                        setLastMinuteSettings((current) => ({
                          ...current,
                          stackWithPromo: !current.stackWithPromo,
                        }))
                      }
                      className={`relative h-[22px] w-10 shrink-0 rounded-full transition-colors ${
                        lastMinuteSettings.stackWithPromo ? "bg-primary-500" : "bg-gray-300"
                      }`}
                    >
                      <span
                        className={`absolute top-[2px] h-[18px] w-[18px] rounded-full bg-white shadow transition-transform ${
                          lastMinuteSettings.stackWithPromo ? "left-[20px]" : "left-[2px]"
                        }`}
                      />
                    </button>
                  </div>
                </div>

                <div className="rounded-lg border border-gray-200 bg-white px-4 py-4">
                  <div className="mb-3 flex items-center justify-between gap-3">
                    <h2 className="text-sm font-semibold text-gray-900">Discount tiers</h2>
                    <button
                      type="button"
                      onClick={() =>
                        setLastMinuteSettings((current) => ({
                          ...current,
                          tiers: [...DEFAULT_LAST_MINUTE_TIERS],
                        }))
                      }
                      className="text-[12px] font-medium text-primary-600 hover:text-primary-700"
                    >
                      Use recommended tiers
                    </button>
                  </div>

                  <div className="space-y-2.5">
                    {lastMinuteSettings.tiers.map((tier, index) => (
                      <div
                        key={index}
                        className="grid grid-cols-[1fr_1fr_1fr_auto] items-end gap-2 rounded-lg bg-gray-50 p-3"
                      >
                        <label className="text-[10px] text-gray-500">
                          From
                          <input
                            type="number"
                            min={0}
                            value={tier.daysBeforeMin}
                            onChange={(event) =>
                              updateLastMinuteTier(
                                index,
                                "daysBeforeMin",
                                parseInt(event.target.value) || 0,
                              )
                            }
                            className="mt-1 w-full rounded-lg border border-gray-200 px-2 py-1.5 text-[13px]"
                          />
                        </label>
                        <label className="text-[10px] text-gray-500">
                          To
                          <input
                            type="number"
                            min={0}
                            value={tier.daysBeforeMax ?? ""}
                            onChange={(event) =>
                              updateLastMinuteTier(
                                index,
                                "daysBeforeMax",
                                event.target.value ? parseInt(event.target.value) : null,
                              )
                            }
                            placeholder="∞"
                            className="mt-1 w-full rounded-lg border border-gray-200 px-2 py-1.5 text-[13px]"
                          />
                        </label>
                        <label className="text-[10px] text-gray-500">
                          Discount %
                          <input
                            type="number"
                            min={1}
                            max={100}
                            value={tier.discountPercent}
                            onChange={(event) =>
                              updateLastMinuteTier(
                                index,
                                "discountPercent",
                                parseInt(event.target.value) || 0,
                              )
                            }
                            className="mt-1 w-full rounded-lg border border-gray-200 px-2 py-1.5 text-[13px] font-semibold"
                          />
                        </label>
                        <button
                          type="button"
                          onClick={() =>
                            setLastMinuteSettings((current) => ({
                              ...current,
                              tiers: current.tiers.filter((_, tierIndex) => tierIndex !== index),
                            }))
                          }
                          className="mb-1 rounded-md p-1.5 text-gray-400 hover:text-red-500"
                          aria-label="Remove tier"
                        >
                          <XMarkIcon className="h-4 w-4" />
                        </button>
                      </div>
                    ))}

                    <button
                      type="button"
                      onClick={() =>
                        setLastMinuteSettings((current) => ({
                          ...current,
                          tiers: [
                            ...current.tiers,
                            { daysBeforeMin: 0, daysBeforeMax: null, discountPercent: 10 },
                          ],
                        }))
                      }
                      className="inline-flex items-center gap-1.5 text-[12px] font-medium text-gray-600 hover:text-primary-600"
                    >
                      <PlusIcon className="h-3.5 w-3.5" />
                      Add tier
                    </button>
                  </div>
                </div>
              </>
            )}

            <button
              type="button"
              onClick={handleSaveLastMinute}
              disabled={savingLastMinute}
              className="rounded-lg bg-primary-600 px-4 py-2 text-[13px] font-semibold text-white hover:bg-primary-700 disabled:opacity-60"
            >
              {savingLastMinute ? "Saving..." : "Save Last-Minute Settings"}
            </button>
          </div>
        )}
      </div>
    </SettingsLayout>
  );
}
