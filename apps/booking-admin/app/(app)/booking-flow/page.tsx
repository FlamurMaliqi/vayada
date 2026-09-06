"use client";

import { useState, useEffect, useRef } from "react";
import { useTranslation } from "@/lib/i18n";
import {
  HomeIcon,
  SparklesIcon,
  CheckBadgeIcon,
  ClipboardDocumentListIcon,
} from "@heroicons/react/24/outline";
import { settingsService, type AddonItem, type AddonSettings } from "@/services/settings";
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
  getBookingBenefitsSettings,
  type BookingBenefitsSettings,
} from "@/services/api/bookingBenefitsSettingsClient";
import {
  getBookingGuestFormSettings,
  type BookingGuestFormSettings,
} from "@/services/api/bookingGuestFormSettingsClient";
import { getBookingLocalizationSettings } from "@/services/api/bookingLocalizationSettingsClient";
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
import { uploadSingleImageWithMediaReference } from "@/lib/utils/uploadImage";
import { SettingsLayout, type SettingsNavSection } from "@vayada/settings-ui";

import RoomsTab from "@/components/booking-flow/RoomsTab";
import AddonsTab, { type AddonItemFormValues } from "@/components/booking-flow/AddonsTab";
import BenefitsTab from "@/components/booking-flow/BenefitsTab";
import GuestFormTab from "@/components/booking-flow/GuestFormTab";
import {
  useBenefitsSettingsTab,
  useGuestFormSettingsTab,
} from "@/components/booking-flow/useBookingFlowSettingsTabs";

type Tab = "rooms" | "addons" | "benefits" | "guest-form" | "last-minute";

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

const DEFAULT_ROOM_FILTER_SETTINGS: BookingRoomFilterSettings = {
  bookingFilters: [],
  customFilters: {},
  filterRooms: {},
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
    imageMediaObjectId: item.imageMediaObjectId,
    photos: item.photos,
    location: item.location ?? undefined,
    maxGuests: item.maxGuests == null ? undefined : String(item.maxGuests),
    maxQuantity: item.maxQuantity,
    leadTime: item.leadTime ?? undefined,
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
    duration: values.duration || null,
    location: values.location || null,
    maxGuests: values.maxGuests ? Number(values.maxGuests) : null,
    maxQuantity: Number(values.maxQuantity),
    leadTime: values.leadTime || null,
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

async function addonPhotos(values: AddonItemFormValues, bookingHotelId: string) {
  const photos = [];
  for (const photo of values.photos) {
    const uploaded = photo.file
      ? await uploadSingleImageWithMediaReference(photo.file, "booking.addon.image", bookingHotelId)
      : photo;
    photos.push({
      mediaObjectId: uploaded.mediaObjectId,
      imageUrl: photo.file ? "" : photo.imageUrl,
      isCover: photo.isCover,
    });
  }
  return photos;
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

export default function BookingFlowPage() {
  const [activeTab, setActiveTab] = useState<Tab>("rooms");
  useEffect(() => {
    const tab = new URLSearchParams(window.location.search).get("tab");
    if (["rooms", "addons", "benefits", "guest-form"].includes(tab ?? "")) setActiveTab(tab as Tab);
  }, []);
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

  // Rooms state (filters)
  const [bookingHotelId, setBookingHotelId] = useState<string | null>(null);
  const [bookingFilters, setBookingFilters] = useState<string[]>([]);
  const [customFilters, setCustomFilters] = useState<Record<string, string>>({});
  const [filterRooms, setFilterRooms] = useState<Record<string, string[]>>({});
  const [filtersEnabled, setFiltersEnabled] = useState(false);
  const [savingFilters, setSavingFilters] = useState(false);
  const [pmsRooms, setPmsRooms] = useState<{ id: string; name: string }[]>([]);
  const [pmsRoomsLoading, setPmsRoomsLoading] = useState(false);
  const [addonCurrency, setAddonCurrency] = useState("");
  const [defaultCurrency, setDefaultCurrency] = useState("EUR");

  const { t } = useTranslation();

  const showFeedback = (type: "success" | "error", message: string) => {
    setFeedback({ type, message });
    setTimeout(() => setFeedback(null), 3000);
  };

  const getBookingHotelIdForSave = () => {
    const hotelId = bookingHotelId || getSelectedBookingHotelId();
    if (!hotelId) {
      throw new Error(t("admin.bookingHotelIdIsRequired"));
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
          propertyCurrency: context.propertyCurrency,
        })),
      {
        addonItems: [] as AddonItem[],
        propertyPlan: DEFAULT_PROPERTY_PLAN,
        propertyCurrency: undefined as string | undefined,
      },
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
      (hotelId) =>
        getBookingLocalizationSettings({ hotelId }).then((settings) => settings.defaultCurrency),
      "EUR",
    );
    const roomFilterSettingsPromise = loadTypedSetting(
      (hotelId) => getBookingRoomFilterSettings({ hotelId }),
      DEFAULT_ROOM_FILTER_SETTINGS,
    );

    Promise.all([
      addonSettingsPromise,
      addonItemsPromise,
      benefitsSettingsPromise,
      guestFormSettingsPromise,
      localizationSettingsPromise,
      roomFilterSettingsPromise,
      propertyPromise,
    ])
      .then(
        ([
          settings,
          addonContext,
          benefitsRes,
          guestFormSettings,
          localizationCurrency,
          roomFilterSettings,
          property,
        ]) => {
          setBookingHotelId(selectedHotelId || property?.id || null);
          addonSettingsRef.current = settings;
          setAddonSettings(settings);
          setAddons(orderAddons(addonContext.addonItems));
          setPropertyPlan(addonContext.propertyPlan);
          setAddonCurrency(addonContext.propertyCurrency ?? "");
          setBenefits(
            normalizeBookingBenefitsSettings(benefitsRes, DEFAULT_BENEFITS_SETTINGS).benefits,
          );
          applyGuestFormSettings(guestFormSettings);
          setDefaultCurrency(localizationCurrency);
          const normalizedRoomFilterSettings = normalizeBookingRoomFilterSettings(
            roomFilterSettings,
            DEFAULT_ROOM_FILTER_SETTINGS,
          );
          setBookingFilters(normalizedRoomFilterSettings.bookingFilters);
          setFiltersEnabled(normalizedRoomFilterSettings.bookingFilters.length > 0);
          setCustomFilters(normalizedRoomFilterSettings.customFilters);
          setFilterRooms(normalizedRoomFilterSettings.filterRooms);
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
  }, [applyGuestFormSettings, setBenefits]);

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
      const hotelId = getBookingHotelIdForSave();
      const saved = await createBookingAddonItem({
        hotelId,
        body: {
          ...toAddonCreateBody(values, nextAddonSortOrder(addons)),
          photos: await addonPhotos(values, hotelId),
        },
      });
      setAddons((current) => orderAddons([...current, toSettingsAddonItem(saved)]));
      showFeedback("success", t("bookingFlow.addons.feedback.createSuccess"));
    } catch (error) {
      const message = t("bookingFlow.addons.feedback.saveError");
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
      const hotelId = getBookingHotelIdForSave();
      const saved = await updateBookingAddonItem({
        hotelId,
        addonItemId: addonId,
        body: {
          ...toAddonWritableFields(values),
          photos: await addonPhotos(values, hotelId),
        },
      });
      setAddons((current) =>
        orderAddons(
          current.map((addon) => (addon.id === addonId ? toSettingsAddonItem(saved) : addon)),
        ),
      );
      showFeedback("success", t("bookingFlow.addons.feedback.updateSuccess"));
    } catch (error) {
      const message = t("bookingFlow.addons.feedback.saveError");
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
      throw new Error(t("admin.failedToReorderAddOns"));
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
      throw new Error(t("admin.failedToDeleteAddOn"));
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

  const sections: SettingsNavSection[] = [
    { id: "rooms", label: t("bookingFlow.tabs.filters"), icon: HomeIcon },
    { id: "addons", label: t("bookingFlow.tabs.addons"), icon: SparklesIcon },
    { id: "benefits", label: t("bookingFlow.tabs.benefits"), icon: CheckBadgeIcon },
    {
      id: "guest-form",
      label: t("bookingFlow.tabs.guestForm"),
      icon: ClipboardDocumentListIcon,
    },
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
            propertyCurrency={addonCurrency}
            propertyPlan={propertyPlan}
            handleToggleAddonSetting={handleToggleAddonSetting}
            onCreateAddon={handleCreateAddon}
            onUpdateAddon={handleUpdateAddon}
            onDeleteAddon={handleDeleteAddon}
            onReorderAddon={handleReorderAddon}
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
      </div>
    </SettingsLayout>
  );
}
