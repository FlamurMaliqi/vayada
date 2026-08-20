import { pmsClient } from "../api/pmsClient";
import { BookingAddon } from "../bookings";

export interface CalendarRoomType {
  id: string;
  name: string;
  category: string;
  totalRooms: number;
  baseRate: number;
  maxOccupancy: number;
  currency: string;
  seasons: {
    name?: string;
    tier?: string;
    from: string;
    to: string;
    rate?: string | number;
    minStay?: number;
    maxStay?: number | string | null;
  }[];
}

export interface CalendarRoom {
  id: string;
  roomTypeId: string;
  roomTypeName: string;
  roomNumber: string;
  floor: string;
  status: string;
}

export interface CalendarBooking {
  id: string;
  roomTypeId: string;
  roomName: string;
  guestFirstName: string;
  guestLastName: string;
  checkIn: string;
  checkOut: string;
  status: "pending" | "confirmed" | "checked_in" | "in_house";
  roomId: string | null;
  roomNumber: string | null;
  channel: string;
  bookingReference: string;
  // VAY-403: a multi-room booking returns one entry per assigned room,
  // all sharing id + bookingReference. numberOfRooms is the booked
  // quantity; roomPosition is 0 for the primary room, 1..N-1 for extras.
  numberOfRooms: number;
  roomPosition: number;
}

export interface CalendarBlock {
  id: string;
  roomTypeId: string;
  roomId: string | null;
  roomNumber: string | null;
  startDate: string;
  endDate: string;
  blockedCount: number;
  reason: string;
  createdAt: string;
}

export interface CalendarOccupancyDay {
  date: string;
  occupiedUnits: number;
  remainingSellableUnits: number;
  denominatorUnits: number;
  percentage: number | null;
}

export interface CalendarData {
  roomTypes: CalendarRoomType[];
  rooms: CalendarRoom[];
  bookings: CalendarBooking[];
  blocks: CalendarBlock[];
  occupancyDays?: CalendarOccupancyDay[];
}

export interface CreateRoomBlockPayload {
  roomTypeId: string;
  roomIds: string[];
  startDate: string;
  endDate: string;
  reason: string;
}

export interface UpdateRoomBlockPayload {
  startDate?: string;
  endDate?: string;
  reason?: string;
}

export interface CreateAdminBookingPayload {
  roomId: string;
  guestFirstName: string;
  guestLastName: string;
  guestEmail: string;
  guestPhone: string;
  specialRequests: string;
  checkIn: string;
  checkOut: string;
  adults: number;
  children: number;
  nightlyRate: number | null;
  channel: string;
  addonIds?: string[];
  addonQuantities?: Record<string, number>;
}

export const calendarService = {
  getCalendarData: (start: string, end: string) =>
    pmsClient.get<CalendarData>(`/admin/calendar?start=${start}&end=${end}`),

  createRoomBlock: (data: CreateRoomBlockPayload) =>
    pmsClient.post<CalendarBlock[]>("/admin/room-blocks", data),

  updateRoomBlock: (blockId: string, data: UpdateRoomBlockPayload) =>
    pmsClient.patch<CalendarBlock>(`/admin/room-blocks/${blockId}`, data),

  deleteRoomBlock: (blockId: string) => pmsClient.delete(`/admin/room-blocks/${blockId}`),

  createAdminBooking: (data: CreateAdminBookingPayload) => pmsClient.post("/admin/bookings", data),

  listAvailableAddons: (roomId: string) =>
    pmsClient.get<BookingAddon[]>(`/admin/bookings/addons/available?room_id=${roomId}`),

  // Booking-engine-equivalent nightly rate for the given room type and check-in
  // date — used by the New Booking modal so the pre-filled rate matches what
  // the guest would have been quoted (seasons / daily overrides / weekend
  // surcharge), instead of just the raw base_rate which can be 0 when the
  // property prices entirely via seasons.
  getResolvedRate: (roomTypeId: string, checkIn: string) =>
    pmsClient.get<{ nightlyRate: number; currency: string }>(
      `/admin/room-types/${roomTypeId}/resolved-rate?check_in=${checkIn}`,
    ),

  reorderRooms: (orderedRoomIds: string[]) =>
    pmsClient.patch("/admin/rooms/reorder", { orderedRoomIds }),
};
