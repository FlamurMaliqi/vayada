import { ApiClient, apiClient } from "./client";

const legacyBookingsEnabled = process.env.NEXT_PUBLIC_LEGACY_ADMIN_BOOKINGS_ENABLED === "true";
const bookingsClient = legacyBookingsEnabled
  ? new ApiClient(process.env.NEXT_PUBLIC_PMS_API_URL || "https://pms-api.vayada.com")
  : apiClient;
const bookingsPath = legacyBookingsEnabled
  ? "/super-admin/bookings"
  : "/api/platform/admin/bookings";

export type BookingStatus = "pending" | "accepted" | "rejected" | "withdrawn";

export interface SuperAdminBookingRow {
  id: string;
  bookingReference: string;
  hotelId: string;
  hotelName: string;
  hotelSlug: string;
  guestName: string;
  guestEmail: string;
  checkIn: string;
  checkOut: string;
  nights: number;
  totalAmount: number;
  currency: string;
  status: BookingStatus;
  rawStatus: string;
  channel: string;
  requestedAt: string;
  respondedAt: string | null;
}

export const bookingsService = {
  list: (params?: { status?: BookingStatus; limit?: number; offset?: number }) => {
    const qs = new URLSearchParams();
    if (params?.status) qs.set("status", params.status);
    if (params?.limit) qs.set("limit", String(params.limit));
    if (params?.offset) qs.set("offset", String(params.offset));
    const suffix = qs.toString() ? `?${qs.toString()}` : "";
    return bookingsClient.get<{ bookings: SuperAdminBookingRow[] }>(`${bookingsPath}${suffix}`);
  },
};
