import { projectBookingRoomSelection } from "../domains/bookingRoomSelectionProjection.js";
import type { BookingAssignedRoom, BookingReservationReadModel } from "@vayada/domain-booking";

export type BookingReservationReadModelRow = {
  id: string;
  bookingReference: string;
  roomTypeId: string;
  roomName: string;
  selectedRoomOffer?: unknown;
  roomMaxOccupancy: number | string;
  guestFirstName: string;
  guestLastName: string;
  guestEmail: string;
  guestPhone: string;
  guestCountry?: string | null;
  guestGender?: string | null;
  guestDateOfBirth?: Date | string | null;
  guestPassportNumber?: string | null;
  specialRequests: string;
  estimatedArrivalTime?: string | null;
  numberOfGuests?: number | null;
  checkIn: Date | string;
  checkOut: Date | string;
  adults: number;
  children: number;
  nightlyRate: number | string;
  numberOfRooms?: number | null;
  totalAmount: number | string;
  currency: string;
  status: string;
  roomId?: string | null;
  roomNumber?: string | null;
  assignedRooms?: BookingAssignedRoom[] | string | null;
  channel?: string | null;
  paymentMethod?: string | null;
  paymentStatus?: string | null;
  depositRequired?: boolean | null;
  depositPercentage?: number | string | null;
  depositAmount?: number | string | null;
  balanceAmount?: number | string | null;
  checkInPendingFlags?: string[] | string | null;
  checkedInAt?: Date | string | null;
  checkedOutAt?: Date | string | null;
  hostResponseDeadline?: Date | string | null;
  platformFeeAmount?: number | string | null;
  affiliateCommissionAmount?: number | string | null;
  propertyPayoutAmount?: number | string | null;
  addonIds?: string[] | string | null;
  addonNames?: string[] | string | null;
  addonTotal?: number | string | null;
  addonQuantities?: Record<string, number> | string | null;
  addonDates?: Record<string, string[]> | string | null;
  guestWithdrawn?: boolean | null;
  promoCode?: string | null;
  promoDiscount?: number | string | null;
  lastMinuteDiscountPercent?: number | string | null;
  lastMinuteDiscountAmount?: number | string | null;
  createdAt: Date | string;
  updatedAt: Date | string;
};

export function toBookingReservationReadModel(
  reservation: BookingReservationReadModelRow,
): BookingReservationReadModel {
  const roomLines = projectBookingRoomSelection(reservation.selectedRoomOffer).roomLines;
  const checkIn = toDateOnly(reservation.checkIn);
  const checkOut = toDateOnly(reservation.checkOut);
  const numberOfRooms = Math.max(1, reservation.numberOfRooms ?? 1);
  const roomMaxOccupancy = Math.max(1, toNumber(reservation.roomMaxOccupancy));
  const primaryRoom = reservation.roomId
    ? [
        {
          roomId: reservation.roomId,
          roomNumber: reservation.roomNumber ?? null,
          position: 0,
        },
      ]
    : [];

  return {
    id: reservation.id,
    bookingReference: reservation.bookingReference,
    roomTypeId: reservation.roomTypeId,
    roomName: reservation.roomName,
    ...(roomLines
      ? {
          roomLines: roomLines.map(({ roomTypeId, roomName, roomCount }) => ({
            roomTypeId,
            roomName,
            roomCount,
          })),
        }
      : {}),
    roomMaxOccupancy,
    totalRoomCapacity: roomMaxOccupancy * numberOfRooms,
    guestFirstName: reservation.guestFirstName,
    guestLastName: reservation.guestLastName,
    guestEmail: reservation.guestEmail,
    guestPhone: reservation.guestPhone,
    guestCountry: reservation.guestCountry ?? "",
    guestGender: reservation.guestGender ?? "",
    guestDateOfBirth: reservation.guestDateOfBirth
      ? toDateOnly(reservation.guestDateOfBirth)
      : null,
    guestPassportNumber: reservation.guestPassportNumber ?? "",
    specialRequests: reservation.specialRequests,
    estimatedArrivalTime: reservation.estimatedArrivalTime ?? null,
    numberOfGuests: reservation.numberOfGuests ?? null,
    checkIn,
    checkOut,
    nights: daysBetween(checkIn, checkOut),
    adults: reservation.adults,
    children: reservation.children,
    nightlyRate: toNumber(reservation.nightlyRate),
    numberOfRooms,
    totalAmount: toNumber(reservation.totalAmount),
    currency: reservation.currency,
    status: reservation.status,
    roomId: reservation.roomId ?? null,
    roomNumber: reservation.roomNumber ?? null,
    assignedRooms: [
      ...primaryRoom,
      ...parseJson<BookingAssignedRoom[]>(reservation.assignedRooms, []),
    ],
    channel: reservation.channel ?? "direct",
    paymentMethod: reservation.paymentMethod ?? null,
    paymentStatus: reservation.paymentStatus ?? null,
    depositRequired: reservation.depositRequired ?? false,
    depositPercentage: toNullableNumber(reservation.depositPercentage),
    depositAmount: toNumber(reservation.depositAmount ?? 0),
    balanceAmount: toNumber(reservation.balanceAmount ?? reservation.totalAmount),
    checkInPendingFlags: parseJson<string[]>(reservation.checkInPendingFlags, []),
    checkedInAt: toIsoDateTimeOrNull(reservation.checkedInAt),
    checkedOutAt: toIsoDateTimeOrNull(reservation.checkedOutAt),
    hostResponseDeadline: toIsoDateTimeOrNull(reservation.hostResponseDeadline),
    platformFeeAmount: toNullableNumber(reservation.platformFeeAmount),
    affiliateCommissionAmount: toNullableNumber(reservation.affiliateCommissionAmount),
    propertyPayoutAmount: toNullableNumber(reservation.propertyPayoutAmount),
    addonIds: parseJson<string[]>(reservation.addonIds, []),
    addonNames: parseJson<string[]>(reservation.addonNames, []),
    addonTotal: toNumber(reservation.addonTotal ?? 0),
    addonQuantities: parseJson<Record<string, number>>(reservation.addonQuantities, {}),
    addonDates: parseJson<Record<string, string[]>>(reservation.addonDates, {}),
    guestWithdrawn: reservation.guestWithdrawn ?? false,
    promoCode: reservation.promoCode ?? null,
    promoDiscount: toNumber(reservation.promoDiscount ?? 0),
    lastMinuteDiscountPercent: toNumber(reservation.lastMinuteDiscountPercent ?? 0),
    lastMinuteDiscountAmount: toNumber(reservation.lastMinuteDiscountAmount ?? 0),
    createdAt: toIsoDateTime(reservation.createdAt),
    updatedAt: toIsoDateTime(reservation.updatedAt),
  };
}

function parseJson<T>(value: T | string | null | undefined, defaultValue: T): T {
  if (value == null) return defaultValue;
  if (typeof value !== "string") return value;

  try {
    return JSON.parse(value) as T;
  } catch {
    return defaultValue;
  }
}

function toNumber(value: number | string): number {
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : 0;
  }

  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function toNullableNumber(value: number | string | null | undefined): number | null {
  if (value == null) return null;
  return toNumber(value);
}

function toDateOnly(value: Date | string): string {
  const date = toValidDate(value);
  if (date) {
    return date.toISOString().slice(0, 10);
  }

  return typeof value === "string" ? value.slice(0, 10) : "";
}

function toIsoDateTime(value: Date | string): string {
  return toIsoDateTimeOrNull(value) ?? "";
}

function toIsoDateTimeOrNull(value: Date | string | null | undefined): string | null {
  if (!value) return null;

  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) {
    return null;
  }

  return date.toISOString();
}

function toValidDate(value: Date | string): Date | null {
  if (value instanceof Date) {
    return Number.isFinite(value.getTime()) ? value : null;
  }

  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date : null;
}

function daysBetween(start: string, end: string): number {
  const startTime = Date.parse(`${start}T00:00:00.000Z`);
  const endTime = Date.parse(`${end}T00:00:00.000Z`);
  if (!Number.isFinite(startTime) || !Number.isFinite(endTime)) {
    return 0;
  }

  return Math.max(0, Math.round((endTime - startTime) / 86_400_000));
}
