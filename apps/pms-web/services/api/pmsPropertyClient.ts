import {
  SELECTED_PMS_PROPERTY_ID_KEY,
  SELECTED_SHARED_PROPERTY_ID_KEY,
} from "@/lib/utils/pmsPropertySelectionKeys";
import type { AdaptiveHotelSetupStatus } from "@vayada/product-onboarding";

import { sharedHotelSetupApi } from "./sharedHotelSetupClient";
import { pmsOperationsClient, pmsOperationsRequestOptions } from "./pmsOperationsClient";
import { unsupportedPmsNextStackFeature } from "./unsupported";

export interface PmsPropertySummary {
  id: string;
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
  contractVersion: "pms-operations.v1";
  propertyId: string;
  autoRearrangeEnabled: boolean;
  updatedAt: string | null;
}

export type PmsRoomShuffleHistoryItem = {
  shuffleId: string;
  assignmentId: string;
  guestBookingId: string | null;
  bookingReference: string | null;
  roomTypeId: string;
  fromRoom: { roomId: string; label: string | null } | null;
  toRoom: { roomId: string; label: string | null };
  reason: "create" | "cancel" | "modify";
  actor: { kind: "system" } | { kind: "user"; userId: string };
  correlationId: string;
  occurredAt: string;
};

export type PmsRoomShuffleHistoryPage = {
  contractVersion: "pms-operations.v1";
  propertyId: string;
  items: PmsRoomShuffleHistoryItem[];
  nextCursor: string | null;
};

export async function listPmsProperties(): Promise<PmsPropertySummary[]> {
  const status = await sharedHotelSetupApi.getStatus({ entryProduct: "pms" });
  return status.propertySelection.availableProperties.map((property) => ({
    id: property.propertyId,
    name: property.displayName ?? "Unnamed hotel",
    slug: property.publicId,
    location: property.locationSummary ?? "",
    country: "",
  }));
}

export async function resolveSelectedPmsPropertyId(action = "loading PMS data"): Promise<string> {
  const storedPropertyId = getStoredPmsPropertyId();
  if (storedPropertyId) {
    return storedPropertyId;
  }

  const status = await sharedHotelSetupApi.getStatus({ entryProduct: "pms" });
  const selectedPropertyId =
    getStoredPmsPropertyId() ?? status.propertySelection.selectedPropertyId;
  const propertyId =
    status.propertySelection.availableProperties.find(
      (property) => property.propertyId === selectedPropertyId,
    )?.propertyId ??
    (status.propertySelection.availableProperties.length === 1
      ? status.propertySelection.availableProperties[0]!.propertyId
      : null);
  if (propertyId) {
    storeSelectedPmsPropertyId(propertyId);
    return propertyId;
  }

  throw new Error(`Select a PMS property before ${action}.`);
}

export async function getPmsPropertyProfile(): Promise<PmsPropertyProfile> {
  const propertyId = await resolveSelectedPmsPropertyId("loading property details");
  const [status, profile] = await Promise.all([
    sharedHotelSetupApi.getStatus({ entryProduct: "pms", propertyId }),
    sharedHotelSetupApi.getPropertyProfile(propertyId),
  ]);

  return toPmsPropertyProfile(status, profile);
}

export async function updatePmsPropertyProfile(
  data: Partial<PmsPropertyProfile>,
): Promise<PmsPropertyProfile> {
  const changedFields = Object.entries(data)
    .filter(([, value]) => value !== undefined)
    .map(([key]) => key);
  if (
    changedFields.length === 0 ||
    changedFields.some((field) => field !== "country" && field !== "timezone")
  ) {
    return unsupportedPmsNextStackFeature("PMS booking acceptance settings");
  }

  const propertyId = await resolveSelectedPmsPropertyId("saving property details");
  const [status, current] = await Promise.all([
    sharedHotelSetupApi.getStatus({ entryProduct: "pms", propertyId }),
    sharedHotelSetupApi.getPropertyProfile(propertyId),
  ]);
  const locationPatch: {
    countryCode?: string;
    timezone?: string;
  } = {
    ...(data.country !== undefined ? { countryCode: data.country.trim().toUpperCase() } : {}),
    ...(data.timezone !== undefined ? { timezone: data.timezone.trim() } : {}),
  };

  const updated = await sharedHotelSetupApi.updatePropertyProfile(propertyId, {
    expectedProfileRevision: current.profileRevision,
    patch: { location: locationPatch },
  });

  return toPmsPropertyProfile(status, updated);
}

export async function getPmsCalendarSettings(): Promise<PmsCalendarSettings> {
  const propertyId = await resolveSelectedPmsPropertyId("loading calendar settings");
  return pmsOperationsClient.get<PmsCalendarSettings>(
    propertyEndpoint(propertyId, "calendar-settings"),
    pmsOperationsRequestOptions,
  );
}

export async function updatePmsCalendarSettings(enabled: boolean): Promise<PmsCalendarSettings> {
  const propertyId = await resolveSelectedPmsPropertyId("saving calendar settings");
  return pmsOperationsClient.patch<PmsCalendarSettings>(
    propertyEndpoint(propertyId, "calendar-settings"),
    { autoRearrangeEnabled: enabled },
    pmsOperationsRequestOptions,
  );
}

export async function listPmsRoomShuffleHistory(
  limit = 50,
  cursor?: string,
): Promise<PmsRoomShuffleHistoryPage> {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100)
    throw new TypeError("Room shuffle history limit must be between 1 and 100.");
  const propertyId = await resolveSelectedPmsPropertyId("loading room shuffle history");
  const query = new URLSearchParams({ limit: String(limit) });
  if (cursor) query.set("cursor", cursor);
  return pmsOperationsClient.get<PmsRoomShuffleHistoryPage>(
    `${propertyEndpoint(propertyId, "calendar-shuffles")}?${query}`,
    pmsOperationsRequestOptions,
  );
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

function toPmsPropertyProfile(
  status: AdaptiveHotelSetupStatus,
  response: Awaited<ReturnType<typeof sharedHotelSetupApi.getPropertyProfile>>,
): PmsPropertyProfile {
  const profile = response.profile;
  const property = status.propertySelection.availableProperties.find(
    (item) => item.propertyId === response.propertyId,
  );
  if (!property) {
    throw new Error("The selected PMS property is no longer available.");
  }

  return {
    id: response.propertyId,
    name: profile.displayName || "Unnamed hotel",
    slug: property.publicId,
    location: [profile.location.city, profile.location.countryCode].filter(Boolean).join(", "),
    country: profile.location.countryCode,
    timezone: profile.location.timezone,
  };
}
