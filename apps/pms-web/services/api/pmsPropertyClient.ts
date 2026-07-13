import {
  SELECTED_PMS_PROPERTY_ID_KEY,
  SELECTED_SHARED_PROPERTY_ID_KEY,
} from "@/lib/utils/pmsPropertySelectionKeys";
import type { SharedHotelSetupProductStatus } from "@vayada/product-onboarding";

import { sharedHotelSetupApi } from "./sharedHotelSetupClient";
import { unsupportedPmsNextStackFeature } from "./unsupported";

export interface PmsPropertySummary {
  id: string;
  pmsStatus: SharedHotelSetupProductStatus;
  name: string;
  slug: string;
  location: string;
  country: string;
}

export interface PmsPropertyProfile extends PmsPropertySummary {
  timezone: string;
  instant_book?: boolean;
  instantBook?: boolean;
  same_day_bookings_enabled?: boolean;
  sameDayBookingsEnabled?: boolean;
  same_day_booking_cutoff_time?: string | null;
  sameDayBookingCutoffTime?: string | null;
}

export interface PmsCalendarSettings {
  autoRearrangeEnabled: boolean;
  autoOpenEnabled: boolean;
  autoOpenMode: "rolling" | "fixed";
  autoOpenMonths: 12 | 18 | 24;
  autoOpenFixedMonth: string | null;
  autoOpenThrough: string | null;
  autoOpenWarnings: string[];
}

export async function listPmsProperties(): Promise<PmsPropertySummary[]> {
  const status = await sharedHotelSetupApi.getStatus({ entryProduct: "pms" });
  return status.properties.map((property) => ({
    id: property.propertyId,
    pmsStatus: property.products.pms.status,
    name: property.displayName ?? "Unnamed hotel",
    slug: property.publicId,
    location: property.locationSummary ?? "",
    country: "",
  }));
}

export function isPmsPropertyReady(property: PmsPropertySummary): boolean {
  return property.pmsStatus === "active";
}

export async function resolveSelectedPmsPropertyId(action = "loading PMS data"): Promise<string> {
  const storedPropertyId = getStoredPmsPropertyId();
  if (storedPropertyId) {
    return storedPropertyId;
  }

  throw new Error(`Select a PMS property before ${action}.`);
}

export async function getPmsPropertyProfile(): Promise<PmsPropertyProfile> {
  return unsupportedPmsNextStackFeature("PMS property profile");
}

export async function updatePmsPropertyProfile(
  data: Partial<PmsPropertyProfile>,
): Promise<PmsPropertyProfile> {
  void data;
  return unsupportedPmsNextStackFeature("PMS property profile");
}

export async function getPmsCalendarSettings(): Promise<PmsCalendarSettings> {
  return unsupportedPmsNextStackFeature("PMS calendar settings");
}

export async function updatePmsCalendarSettings(
  data: Partial<PmsCalendarSettings>,
): Promise<PmsCalendarSettings> {
  void data;
  return unsupportedPmsNextStackFeature("PMS calendar settings");
}

export async function getPmsMessagingUnreadCount(): Promise<{ unreadCount: number }> {
  return unsupportedPmsNextStackFeature("PMS messaging unread count");
}

export function propertyEndpoint(propertyId: string, suffix: string): string {
  return `/api/pms/properties/${encodeURIComponent(propertyId)}/${suffix}`;
}

export function getStoredPmsPropertyId(): string | null {
  const storage = browserStorage();
  const selectedHotelId = storage?.getItem(SELECTED_PMS_PROPERTY_ID_KEY)?.trim();
  const selectedSharedPropertyId = storage?.getItem(SELECTED_SHARED_PROPERTY_ID_KEY)?.trim();
  const selectedPropertyId = selectedHotelId || selectedSharedPropertyId || null;
  if (selectedPropertyId) {
    storeSelectedPmsPropertyId(selectedPropertyId);
  }
  return selectedPropertyId;
}

export function storeSelectedPmsPropertyId(propertyId: string): void {
  const selectedPropertyId = propertyId.trim();
  if (!selectedPropertyId) return;
  const storage = browserStorage();
  storage?.setItem(SELECTED_PMS_PROPERTY_ID_KEY, selectedPropertyId);
  storage?.setItem(SELECTED_SHARED_PROPERTY_ID_KEY, selectedPropertyId);
}

export function clearStoredPmsPropertyId(): void {
  const storage = browserStorage();
  storage?.removeItem(SELECTED_PMS_PROPERTY_ID_KEY);
  storage?.removeItem(SELECTED_SHARED_PROPERTY_ID_KEY);
}

function browserStorage(): Storage | null {
  return typeof window === "undefined" ? null : window.localStorage;
}
