import { apiClient } from "../api/client";
import type { PlatformPropertyLifecycleStatus } from "@vayada/domain-hotels";

export interface PropertySettings {
  slug: string;
  property_name: string;
  reservation_email: string;
  phone_number: string;
  whatsapp_number: string;
  address: string;
  default_currency: string;
  supported_currencies: string[];
  supported_languages: string[];
  email_notifications: boolean;
  new_booking_alerts: boolean;
  payment_alerts: boolean;
  weekly_reports: boolean;
}

export type PropertySettingsUpdate = Partial<PropertySettings>;

export interface DesignSettings {
  hero_image: string;
  hero_heading: string;
  hero_subtext: string;
  primary_color: string;
  accent_color: string;
  font_pairing: string;
  booking_filters: string[];
}

export type DesignSettingsUpdate = Partial<DesignSettings>;

export interface HotelSummary {
  id: string;
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
}

export interface SuperAdminHotel extends HotelSummary {
  lifecycle_status: PlatformPropertyLifecycleStatus;
  lifecycle_revision: number;
  owner_account_user_ids: string[];
  owner_name: string;
  owner_email: string;
  billing_active_plan: string;
  billing_pending_switch: string | null;
  billing_switch_effective_date: string | null;
  booking_engine_fee_pct: number;
  channel_manager_fee_pct: number;
  affiliate_platform_fee_pct: number;
  billing_commission_note: string | null;
  fixed_base_fee: number;
  fixed_rooms_included: number;
  fixed_per_extra_room_fee: number;
  active_room_count: number;
  fixed_plan_projected_monthly_fee: number;
  currency?: string;
}

export interface HotelBillingUpdate {
  booking_engine_fee_pct?: number;
  channel_manager_fee_pct?: number;
  affiliate_platform_fee_pct?: number;
  fixed_base_fee?: number;
  fixed_rooms_included?: number;
  fixed_per_extra_room_fee?: number;
  // Free-text reason persisted on the hotel and attached to the audit-log row
  // when booking_engine_fee_pct changes.
  commission_note?: string | null;
}

export interface CommissionRateChange {
  id: string;
  admin_user_id: string;
  admin_name: string;
  admin_email: string;
  old_value: number;
  new_value: number;
  note: string | null;
  changed_at: string;
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
  validFrom?: string | null;
  validUntil?: string | null;
  isActive: boolean;
  maxUses?: number | null;
  useCount: number;
  createdAt?: string;
}

export const bookingSettingsService = {
  listAllHotels: async () => {
    const dashboard = await apiClient.get<{
      properties: Array<{
        id: string;
        name: string;
        slug: string;
        status: string;
        lifecycleStatus: PlatformPropertyLifecycleStatus;
        lifecycleRevision: number;
        ownerAccountUserIds: string[];
        createdAt: string;
      }>;
    }>("/api/platform/admin/growth?granularity=weekly&exclude_test_data=false");
    return dashboard.properties.map(toSuperAdminHotel);
  },

  updateHotelBilling: (hotelId: string, data: HotelBillingUpdate) => {
    void data;
    return unavailableTargetRoute(
      `Booking billing settings target route is not available for ${hotelId}.`,
    );
  },

  listCommissionHistory: (hotelId: string) =>
    unavailableTargetRoute<CommissionRateChange[]>(
      `Booking commission history target route is not available for ${hotelId}.`,
    ),

  getPropertySettings: (hotelId: string) =>
    platformBookingUnavailable<PropertySettings>(hotelId, "property settings"),

  updatePropertySettings: (hotelId: string, data: PropertySettingsUpdate) => {
    void data;
    return platformBookingUnavailable<PropertySettings>(hotelId, "property settings");
  },

  getDesignSettings: (hotelId: string) =>
    platformBookingUnavailable<DesignSettings>(hotelId, "design settings"),

  updateDesignSettings: (hotelId: string, data: DesignSettingsUpdate) => {
    void data;
    return platformBookingUnavailable<DesignSettings>(hotelId, "design settings");
  },

  listAddons: (hotelId: string) =>
    platformBookingUnavailable<AddonItem[]>(hotelId, "add-on settings"),

  createAddon: (hotelId: string, data: Omit<AddonItem, "id">) => {
    void data;
    return platformBookingUnavailable<AddonItem>(hotelId, "add-on settings");
  },

  updateAddon: (hotelId: string, id: string, data: Partial<AddonItem>) => {
    void id;
    void data;
    return platformBookingUnavailable<AddonItem>(hotelId, "add-on settings");
  },

  deleteAddon: (hotelId: string, id: string) => {
    void id;
    return platformBookingUnavailable(hotelId, "add-on settings");
  },

  getAddonSettings: (hotelId: string) =>
    platformBookingUnavailable<AddonSettings>(hotelId, "add-on settings"),

  updateAddonSettings: (hotelId: string, data: Partial<AddonSettings>) => {
    void data;
    return platformBookingUnavailable<AddonSettings>(hotelId, "add-on settings");
  },

  // Benefits
  getBenefits: (hotelId: string) =>
    platformBookingUnavailable<{ benefits: string[] }>(hotelId, "benefit settings"),

  updateBenefits: (hotelId: string, benefits: string[]) => {
    void benefits;
    return platformBookingUnavailable<{ benefits: string[] }>(hotelId, "benefit settings");
  },

  // Promo Codes
  listPromoCodes: (hotelId: string) =>
    platformBookingUnavailable<PromoCodeItem[]>(hotelId, "promo-code settings"),

  createPromoCode: (
    hotelId: string,
    data: Omit<PromoCodeItem, "id" | "useCount" | "createdAt">,
  ) => {
    void data;
    return platformBookingUnavailable<PromoCodeItem>(hotelId, "promo-code settings");
  },

  updatePromoCode: (hotelId: string, id: string, data: Partial<PromoCodeItem>) => {
    void id;
    void data;
    return platformBookingUnavailable<PromoCodeItem>(hotelId, "promo-code settings");
  },

  deletePromoCode: (hotelId: string, id: string) => {
    void id;
    return platformBookingUnavailable(hotelId, "promo-code settings");
  },
};

function toSuperAdminHotel(property: {
  id: string;
  name: string;
  slug: string;
  lifecycleStatus: PlatformPropertyLifecycleStatus;
  lifecycleRevision: number;
  ownerAccountUserIds: string[];
}): SuperAdminHotel {
  return {
    id: property.id,
    name: property.name,
    slug: property.slug,
    lifecycle_status: property.lifecycleStatus,
    lifecycle_revision: property.lifecycleRevision,
    owner_account_user_ids: property.ownerAccountUserIds,
    location: "",
    country: "",
    owner_name: "",
    owner_email: "",
    billing_active_plan: "commission",
    billing_pending_switch: null,
    billing_switch_effective_date: null,
    booking_engine_fee_pct: 5,
    channel_manager_fee_pct: 0,
    affiliate_platform_fee_pct: 0,
    billing_commission_note: null,
    fixed_base_fee: 0,
    fixed_rooms_included: 0,
    fixed_per_extra_room_fee: 0,
    active_room_count: 0,
    fixed_plan_projected_monthly_fee: 0,
  };
}

function platformBookingUnavailable<T>(hotelId: string, feature: string): Promise<T> {
  return unavailableTargetRoute<T>(
    `Platform admin ${feature} target route is not available for ${hotelId}.`,
  );
}

function unavailableTargetRoute<T = void>(message: string): Promise<T> {
  return Promise.reject(new Error(message));
}
