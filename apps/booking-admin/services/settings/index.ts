import { ApiErrorResponse, apiClient, isNextApiTarget, omitHotelContext } from "../api/client";
import { getSelectedBookingHotelId, listScopedBookingHotelIds } from "../api/bookingHotelScope";
import {
  BookingPropertyLinkClientError,
  getBookingHotelPropertyLink,
} from "../api/bookingPropertyLinkClient";
import { sharedHotelSetupApi } from "../api/sharedHotelSetupClient";
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
  time_zone?: string;
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
  header_logo: string;
  header_logo_media_object_id: string | null;
  hero_image: string;
  hero_heading: string;
  hero_subtext: string;
  primary_color: string;
  font_pairing: string;
}

export type DesignSettingsUpdate = Partial<DesignSettings>;

type BookingDesignSettings = {
  headerLogo: string;
  headerLogoMediaObjectId: string | null;
  heroImage: string;
  heroHeading: string;
  heroSubtext: string;
  primaryColor: string;
  fontPairing: string;
};

type BookingDesignSettingsUpdate = Partial<BookingDesignSettings>;

function toDesignSettings(branding: BookingDesignSettings): DesignSettings {
  return {
    header_logo: branding.headerLogo,
    header_logo_media_object_id: branding.headerLogoMediaObjectId,
    hero_image: branding.heroImage,
    hero_heading: branding.heroHeading,
    hero_subtext: branding.heroSubtext,
    primary_color: branding.primaryColor,
    font_pairing: branding.fontPairing,
  };
}

function toBrandingDesignUpdate(data: DesignSettingsUpdate): BookingDesignSettingsUpdate {
  return {
    headerLogoMediaObjectId: data.header_logo_media_object_id,
    heroImage: data.hero_image,
    heroHeading: data.hero_heading,
    heroSubtext: data.hero_subtext,
    primaryColor: data.primary_color,
    fontPairing: data.font_pairing,
  };
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
  if (!isNextApiTarget()) return legacyScopedBookingHotels();

  const bookingHotelIds = listScopedBookingHotelIds();
  const [status, propertyLinks] = await Promise.all([
    sharedHotelSetupApi.getStatus({ entryProduct: "booking" }),
    Promise.all(bookingHotelIds.map(loadLinkedBookingHotel)),
  ]);
  const canonicalByPropertyId = new Map<string, LinkedBookingHotel>();
  const selfFallbackByPropertyId = new Map<string, LinkedBookingHotel>();
  for (const link of propertyLinks) {
    if (!link) continue;
    const [propertyId, bookingHotel] = link;
    const candidates =
      bookingHotel.hotelId === propertyId ? selfFallbackByPropertyId : canonicalByPropertyId;
    const existing = candidates.get(propertyId);
    if (!existing || bookingHotel.hotelId.localeCompare(existing.hotelId) < 0) {
      candidates.set(propertyId, bookingHotel);
    }
  }

  return status.propertySelection.availableProperties.map((property) => {
    const canonical = canonicalByPropertyId.get(property.propertyId);
    const selected = canonical ?? selfFallbackByPropertyId.get(property.propertyId);
    return {
      id: selected?.hotelId ?? property.propertyId,
      propertyId: property.propertyId,
      bookingHotelId: canonical?.hotelId,
      name: property.displayName ?? "Unnamed hotel",
      slug: selected?.slug ?? "",
      location: property.locationSummary ?? "",
      country: "",
    };
  });
}

type LinkedBookingHotel = { hotelId: string; slug: string };

async function loadLinkedBookingHotel(
  hotelId: string,
): Promise<readonly [string, LinkedBookingHotel] | null> {
  let propertyId: string;
  try {
    propertyId = (await getBookingHotelPropertyLink({ hotelId })).propertyId;
  } catch (error) {
    if (error instanceof BookingPropertyLinkClientError && error.statusCode === 404) return null;
    throw error;
  }

  let settings: PropertySettings | null;
  try {
    settings = await apiClient.get<PropertySettings>(
      `/api/booking/hotels/${encodeURIComponent(hotelId)}/settings/property`,
      omitHotelContext,
    );
  } catch (error) {
    if (error instanceof ApiErrorResponse && error.status === 404) {
      settings = null;
    } else {
      throw error;
    }
  }

  return [propertyId, { hotelId, slug: settings?.slug ?? "" }] as const;
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

async function getTargetDesignSettings(explicitHotelId?: string): Promise<BookingDesignSettings> {
  const hotelId = resolveBookingHotelId(explicitHotelId);
  return apiClient.get<BookingDesignSettings>(
    `/api/booking/hotels/${encodeURIComponent(hotelId)}/settings/design`,
    omitHotelContext,
  );
}

async function updateTargetDesignSettings(
  data: BookingDesignSettingsUpdate,
  explicitHotelId?: string,
): Promise<BookingDesignSettings> {
  const hotelId = resolveBookingHotelId(explicitHotelId);
  return apiClient.patch<BookingDesignSettings>(
    `/api/booking/hotels/${encodeURIComponent(hotelId)}/settings/design`,
    data,
    omitHotelContext,
  );
}

export interface HotelSummary {
  id: string;
  propertyId?: string;
  bookingHotelId?: string;
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
  ownershipKind: "property" | "partner";
  partnerCommissionRate: string | null;
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

  changePassword: (current_password: string, new_password: string) =>
    apiClient.post("/auth/change-password", { current_password, new_password }),

  changeEmail: (new_email: string, password: string) =>
    apiClient.post<{ message: string; email?: string }>("/auth/change-email", {
      new_email,
      password,
    }),

  verifyEmailChange: (token: string) =>
    apiClient.post<{ message: string; email: string }>("/auth/verify-email-change", { token }),

  getDesignSettings: async (explicitHotelId?: string): Promise<DesignSettings> => {
    const hotelId = resolveBookingHotelId(explicitHotelId);
    return toDesignSettings(await getTargetDesignSettings(hotelId));
  },

  updateDesignSettings: async (
    data: DesignSettingsUpdate,
    explicitHotelId?: string,
  ): Promise<DesignSettings> => {
    const hotelId = resolveBookingHotelId(explicitHotelId);
    return toDesignSettings(
      await updateTargetDesignSettings(toBrandingDesignUpdate(data), hotelId),
    );
  },

  getCustomDomainStatus: async (): Promise<CustomDomainStatus> =>
    getBookingCustomDomain({ hotelId: await resolveBookingHotelId() }),

  connectCustomDomain: async (domain: string): Promise<CustomDomainStatus> =>
    upsertBookingCustomDomain({ hotelId: await resolveBookingHotelId(), domain }),

  disconnectCustomDomain: async (): Promise<void> =>
    deleteBookingCustomDomain({ hotelId: await resolveBookingHotelId() }),
};

function unavailableTargetRoute<T>(surface: string): Promise<T> {
  return Promise.reject(new Error(`${surface} is not available on the target API yet.`));
}
