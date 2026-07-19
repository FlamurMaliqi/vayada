import { apiClient, omitHotelContext } from "../api/client";
import { getSelectedBookingHotelId, listScopedBookingHotelIds } from "../api/bookingHotelScope";
import { getBookingHotelPropertyLink } from "../api/bookingPropertyLinkClient";
import { sharedHotelSetupApi } from "../api/sharedHotelSetupClient";
import {
  getBookingRoomFilterSettings,
  updateBookingRoomFilterSettings,
  type BookingRoomFilterSettings,
} from "../api/bookingRoomFilterSettingsClient";
import {
  deleteBookingCustomDomain,
  getBookingCustomDomain,
  upsertBookingCustomDomain,
  type BookingCustomDomainResponse,
} from "../api/bookingCustomDomainClient";

export interface PropertySettings {
  // Route-safe Booking identifier. It is the native booking hotel id when one
  // exists and otherwise the canonical property id.
  id?: string;
  property_id?: string;
  booking_hotel_id?: string | null;
  slug: string;
  property_name: string;
  reservation_email: string;
  phone_number: string;
  whatsapp_number: string;
  address: string;
  city?: string;
  country?: string;
  instagram?: string;
  facebook?: string;
  tiktok?: string;
  youtube?: string;
  default_currency: string;
  default_language?: string;
  supported_currencies: string[];
  supported_languages: string[];
  check_in_time: string;
  check_out_time: string;
  check_in_from?: string;
  check_in_until?: string;
  check_out_from?: string;
  check_out_until?: string;
  pay_at_property_enabled: boolean;
  pay_at_hotel_methods: string[];
  online_card_payment?: boolean;
  bank_transfer?: boolean;
  paypal_enabled?: boolean;
  paypal_email?: string;
  paypal_payment_window_hours?: number;
  special_requests_enabled?: boolean;
  arrival_time_enabled?: boolean;
  guest_count_enabled?: boolean;
  refer_a_guest_enabled?: boolean;
  map_view_enabled?: boolean;
  free_cancellation_days: number;
  email_notifications: boolean;
  new_booking_alerts: boolean;
  payment_alerts: boolean;
  ota_booking_alerts: boolean;
  billing_active_plan?: string;
  billing_commission_rate?: number;
  billing_fixed_fee?: number;
  billing_pending_switch?: string | null;
  billing_switch_effective_date?: string | null;
  booking_engine_fee_pct?: number;
  channel_manager_fee_pct?: number;
  affiliate_platform_fee_pct?: number;
  active_room_count?: number;
  fixed_plan_projected_monthly_fee?: number;
  payout_account_holder?: string;
  payout_account_type?: "iban" | "account_number";
  payout_iban?: string;
  payout_account_number?: string;
  payout_bank_name?: string;
  payout_swift?: string;
  terms_text?: string;
  cancellation_policy_text?: string;
  show_room_detail_map?: boolean;
  points_of_interest?: PointOfInterest[];
}

export interface PointOfInterest {
  id: string;
  label: string;
  travelTime: string;
  color: string;
  latitude: number;
  longitude: number;
  position: number;
}

export type PropertySettingsUpdate = Partial<PropertySettings>;

export interface DesignSettings {
  hero_image: string;
  hero_heading: string;
  hero_subtext: string;
  primary_color: string;
  font_pairing: string;
  booking_filters: string[];
  custom_filters: Record<string, string>;
  filter_rooms: Record<string, string[]>;
}

export type DesignSettingsUpdate = Partial<DesignSettings>;

const DEFAULT_DESIGN_SETTINGS: DesignSettings = {
  hero_image: "",
  hero_heading: "",
  hero_subtext: "",
  primary_color: "#4F46E5",
  font_pairing: "high-end-serif",
  booking_filters: [],
  custom_filters: {},
  filter_rooms: {},
};

function toDesignSettings(settings: BookingRoomFilterSettings): DesignSettings {
  return {
    ...DEFAULT_DESIGN_SETTINGS,
    booking_filters: settings.bookingFilters,
    custom_filters: settings.customFilters,
    filter_rooms: settings.filterRooms,
  };
}

function hasRoomFilterDesignUpdate(data: DesignSettingsUpdate): boolean {
  return (
    data.booking_filters !== undefined ||
    data.custom_filters !== undefined ||
    data.filter_rooms !== undefined
  );
}

function unsupportedDesignUpdateKeys(data: DesignSettingsUpdate): string[] {
  return (Object.keys(data) as (keyof DesignSettingsUpdate)[]).filter(
    (key) =>
      !["booking_filters", "custom_filters", "filter_rooms"].includes(key) &&
      data[key] !== undefined,
  );
}

function legacyScopedBookingHotels(): HotelSummary[] {
  return listScopedBookingHotelIds().map((id, index) => ({
    id,
    name: index === 0 ? "My Property" : `Property ${index + 1}`,
    slug: "",
    location: "",
    country: "",
  }));
}

async function listScopedBookingHotels(): Promise<HotelSummary[]> {
  const bookingHotelIds = listScopedBookingHotelIds();
  try {
    const [status, propertyLinks] = await Promise.all([
      sharedHotelSetupApi.getStatus({ entryProduct: "booking" }),
      Promise.all(
        bookingHotelIds.map(async (hotelId) => {
          try {
            const link = await getBookingHotelPropertyLink({ hotelId });
            return [link.propertyId, hotelId] as const;
          } catch {
            return null;
          }
        }),
      ),
    ]);
    const bookingHotelIdByPropertyId = new Map<string, string>();
    for (const link of propertyLinks) {
      if (!link) continue;
      const [propertyId, hotelId] = link;
      if (hotelId === propertyId) continue;
      const existing = bookingHotelIdByPropertyId.get(propertyId);
      if (!existing || hotelId.localeCompare(existing) < 0) {
        bookingHotelIdByPropertyId.set(propertyId, hotelId);
      }
    }

    return status.properties.map((property) => {
      const bookingHotelId = bookingHotelIdByPropertyId.get(property.propertyId);
      return {
        id: bookingHotelId ?? property.propertyId,
        propertyId: property.propertyId,
        bookingHotelId,
        productReady: true,
        name: property.displayName ?? "Unnamed hotel",
        slug: property.publicId,
        location: property.locationSummary ?? "",
        country: "",
      };
    });
  } catch {
    return legacyScopedBookingHotels();
  }
}

function resolveBookingHotelId(explicitHotelId?: string): string {
  const scopedExplicitHotelId = explicitHotelId?.trim();
  if (scopedExplicitHotelId) {
    if (listScopedBookingHotelIds().includes(scopedExplicitHotelId)) {
      return scopedExplicitHotelId;
    }
    throw new Error("Booking hotel is outside the active organization scope.");
  }
  const hotelId = getSelectedBookingHotelId();
  if (hotelId) return hotelId;
  throw new Error("Booking hotel id is required.");
}

async function getTargetPropertySettings(explicitHotelId?: string): Promise<PropertySettings> {
  const hotelId = resolveBookingHotelId(explicitHotelId);
  return apiClient.get<PropertySettings>(
    `/api/booking/hotels/${encodeURIComponent(hotelId)}/settings/property`,
    omitHotelContext,
  );
}

async function updateTargetPropertySettings(
  data: PropertySettingsUpdate,
  explicitHotelId?: string,
): Promise<PropertySettings> {
  const hotelId = resolveBookingHotelId(explicitHotelId);
  return apiClient.patch<PropertySettings>(
    `/api/booking/hotels/${encodeURIComponent(hotelId)}/settings/property`,
    data,
    omitHotelContext,
  );
}

export interface SetupPrefillData {
  property_name?: string;
  reservation_email?: string;
  phone_number?: string;
  address?: string;
  hero_image?: string;
}

export interface SetupStatusResponse {
  setup_complete: boolean;
  missing_fields: string[];
  prefill_data?: SetupPrefillData | null;
}

export interface HotelSummary {
  id: string;
  propertyId?: string;
  bookingHotelId?: string;
  productReady?: boolean;
  name: string;
  slug: string;
  location: string;
  country: string;
}

export interface AddonItem {
  id: string;
  name: string;
  description: string;
  price: number;
  currency: string;
  category: string;
  image: string;
  duration?: string;
  perPerson?: boolean;
  perNight?: boolean;
  sortOrder?: number;
  location?: string;
  maxGuests?: string;
  highlights?: string[];
  includedItems?: string[];
}

export interface SuperAdminHotel extends HotelSummary {
  owner_name: string;
  owner_email: string;
  billing_active_plan: string;
  billing_pending_switch: string | null;
  billing_switch_effective_date: string | null;
  booking_engine_fee_pct: number;
  channel_manager_fee_pct: number;
  affiliate_platform_fee_pct: number;
  fixed_base_fee: number;
  fixed_rooms_included: number;
  fixed_per_extra_room_fee: number;
}

export interface HotelBillingUpdate {
  booking_engine_fee_pct?: number;
  channel_manager_fee_pct?: number;
  affiliate_platform_fee_pct?: number;
  fixed_base_fee?: number;
  fixed_rooms_included?: number;
  fixed_per_extra_room_fee?: number;
}

export interface AddonSettings {
  showAddonsStep: boolean;
  groupAddonsByCategory: boolean;
}

export interface PromoCodeItem {
  id: string;
  code: string;
  discountType: "percentage" | "fixed";
  discountValue: number;
  currency?: string | null;
  validFrom?: string | null;
  validUntil?: string | null;
  isActive: boolean;
  maxUses?: number | null;
  useCount: number;
  createdAt?: string;
  updatedAt?: string;
}

export type CustomDomainStatus = BookingCustomDomainResponse;

export interface HotelDeletionImpact {
  upcomingBookingsCount: number;
  connectedChannelsCount: number;
}

export const settingsService = {
  listHotels: () => listScopedBookingHotels(),

  listAllHotels: () => unavailableTargetRoute<SuperAdminHotel[]>("Platform hotel list"),

  updateHotelBilling: (hotelId: string, data: HotelBillingUpdate) => {
    void hotelId;
    void data;
    return unavailableTargetRoute("Platform hotel billing updates");
  },

  getHotelDeletionImpact: (hotelId: string) => {
    void hotelId;
    return unavailableTargetRoute<HotelDeletionImpact>("Hotel deletion impact");
  },

  deleteHotel: (hotelId: string) => {
    void hotelId;
    return unavailableTargetRoute<void>("Hotel deletion");
  },

  getPropertySettings: (hotelId?: string) => getTargetPropertySettings(hotelId),

  updatePropertySettings: (data: PropertySettingsUpdate, hotelId?: string) =>
    updateTargetPropertySettings(data, hotelId),

  createHotel: (data: PropertySettingsUpdate) => {
    void data;
    return unavailableTargetRoute<PropertySettings>("Legacy Booking setup creation");
  },

  changePassword: (current_password: string, new_password: string) =>
    apiClient.post("/auth/change-password", { current_password, new_password }),

  changeEmail: (new_email: string, password: string) =>
    apiClient.post<{ message: string; email?: string }>("/auth/change-email", {
      new_email,
      password,
    }),

  verifyEmailChange: (token: string) =>
    apiClient.post<{ message: string; email: string }>("/auth/verify-email-change", { token }),

  getDesignSettings: async (): Promise<DesignSettings> =>
    toDesignSettings(
      await getBookingRoomFilterSettings({ hotelId: await resolveBookingHotelId() }),
    ),

  updateDesignSettings: async (data: DesignSettingsUpdate): Promise<DesignSettings> => {
    const unsupportedKeys = unsupportedDesignUpdateKeys(data);
    if (unsupportedKeys.length > 0) {
      throw new Error(
        `Design media and color settings are not available on next-api yet: ${unsupportedKeys.join(", ")}.`,
      );
    }

    if (!hasRoomFilterDesignUpdate(data)) {
      throw new Error("Design media and color settings are not available on next-api yet.");
    }

    const hotelId = await resolveBookingHotelId();
    const current = await getBookingRoomFilterSettings({ hotelId });
    const saved = await updateBookingRoomFilterSettings({
      hotelId,
      body: {
        bookingFilters: data.booking_filters ?? current.bookingFilters,
        customFilters: data.custom_filters ?? current.customFilters,
        filterRooms: data.filter_rooms ?? current.filterRooms,
      },
    });
    return toDesignSettings(saved);
  },

  getCustomDomainStatus: async (): Promise<CustomDomainStatus> =>
    getBookingCustomDomain({ hotelId: await resolveBookingHotelId() }),

  connectCustomDomain: async (domain: string): Promise<CustomDomainStatus> =>
    upsertBookingCustomDomain({ hotelId: await resolveBookingHotelId(), domain }),

  disconnectCustomDomain: async (): Promise<void> =>
    deleteBookingCustomDomain({ hotelId: await resolveBookingHotelId() }),

  getSetupStatus: async () => {
    const hotels = await listScopedBookingHotels();
    return {
      setup_complete: hotels.length > 0,
      missing_fields: hotels.length > 0 ? [] : ["property"],
      prefill_data: null,
    };
  },
};

function unavailableTargetRoute<T>(surface: string): Promise<T> {
  return Promise.reject(new Error(`${surface} is not available on the target API yet.`));
}
