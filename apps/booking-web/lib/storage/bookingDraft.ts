import { Booking } from "@/lib/types";

/**
 * Centralizes the sessionStorage keys the checkout flow uses, so we read and
 * write the same shape from every page and any future migration (e.g. to a
 * BookingDraftContext keyed by a URL ?draft= token, which would also let
 * deep-link reloads survive a browser restart) only has to touch this module.
 */

export interface GuestDetailsDraft {
  roomTypeId: string;
  guestFirstName: string;
  guestLastName: string;
  guestEmail: string;
  guestPhone: string;
  guestCountry?: string;
  specialRequests?: string;
  estimatedArrivalTime?: string;
  numberOfGuests?: number;
  referralCode?: string;
  addonIds?: string[];
  addonQuantities?: Record<string, number>;
  /** Per-day addon date selections — ISO strings keyed by addon id. */
  addonDates?: Record<string, string[]>;
}

export type BookingConfirmationSource = Partial<Omit<Booking, "status">> & {
  guestBookingId?: string;
  roomCount?: number;
  status?: Booking["status"] | "pending_payment" | "canceled";
};

export interface BookingConfirmationContext extends Partial<Booking> {
  paymentMethod?: string | null;
}

const GUEST_KEY = "guestDetails";
const LAST_BOOKING_KEY = "lastBooking";

function safeGet(key: string): string | null {
  if (typeof window === "undefined") return null;
  try {
    return sessionStorage.getItem(key);
  } catch {
    return null;
  }
}

function safeSet(key: string, value: string): void {
  if (typeof window === "undefined") return;
  try {
    sessionStorage.setItem(key, value);
  } catch {}
}

export function saveGuestDetails(draft: GuestDetailsDraft): void {
  safeSet(GUEST_KEY, JSON.stringify(draft));
}

export function readGuestDetails(): GuestDetailsDraft | null {
  const raw = safeGet(GUEST_KEY);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as GuestDetailsDraft;
  } catch {
    return null;
  }
}

const BOOKING_STATUSES: Booking["status"][] = [
  "confirmed",
  "pending",
  "cancelled",
  "declined",
  "expired",
  "draft",
];

const PAYMENT_METHODS = [
  "card",
  "pay_at_property",
  "cash",
  "xendit",
  "bank_transfer",
  "paypal",
] as const;

const PAYMENT_STATUSES = [
  "unpaid",
  "pending",
  "authorized",
  "captured",
  "paid",
  "refunded",
  "failed",
  "cancelled",
] as const;

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function nonNegativeNumber(value: unknown, fallback = 0): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : fallback;
}

function nonNegativeInteger(value: unknown, fallback = 0): number {
  const number = nonNegativeNumber(value, fallback);
  return Number.isInteger(number) ? number : fallback;
}

function isoDate(value: unknown): string | null {
  const date = nonEmptyString(value);
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
  const parsed = new Date(`${date}T00:00:00.000Z`);
  return Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== date ? null : date;
}

function nightsBetween(checkIn: string, checkOut: string): number {
  if (!checkIn || !checkOut) return 0;
  const difference =
    new Date(`${checkOut}T00:00:00.000Z`).getTime() -
    new Date(`${checkIn}T00:00:00.000Z`).getTime();
  return difference > 0 ? Math.round(difference / 86_400_000) : 0;
}

function bookingStatus(value: unknown): Booking["status"] | null {
  if (value === "canceled") return "cancelled";
  if (value === "pending_payment") return "pending";
  return BOOKING_STATUSES.includes(value as Booking["status"])
    ? (value as Booking["status"])
    : null;
}

function paymentMethod(value: unknown): string | null {
  return PAYMENT_METHODS.includes(value as (typeof PAYMENT_METHODS)[number])
    ? (value as string)
    : null;
}

function paymentStatus(value: unknown): string | null {
  if (value === "canceled") return "cancelled";
  return PAYMENT_STATUSES.includes(value as (typeof PAYMENT_STATUSES)[number])
    ? (value as string)
    : null;
}

/**
 * Converts the compact target-checkout response into the stable confirmation
 * shape. Server-owned booking facts win; checkout-owned display fields (room,
 * guest and chosen payment method) are carried from the page instead of being
 * guessed from fields the public response intentionally does not expose.
 */
export function toConfirmationBooking(
  source: BookingConfirmationSource,
  context: BookingConfirmationContext = {},
): Booking {
  const checkIn = isoDate(source.checkIn) ?? isoDate(context.checkIn) ?? "";
  const checkOut = isoDate(source.checkOut) ?? isoDate(context.checkOut) ?? "";
  const derivedNights = nightsBetween(checkIn, checkOut);
  const sourceNights = nonNegativeInteger(source.nights);
  const contextNights = nonNegativeInteger(context.nights);
  const hasSourceBookingStatus =
    Object.prototype.hasOwnProperty.call(source, "status") && source.status !== undefined;
  const hasSourcePaymentStatus =
    Object.prototype.hasOwnProperty.call(source, "paymentStatus") &&
    source.paymentStatus !== undefined;

  return {
    id:
      nonEmptyString(source.guestBookingId) ??
      nonEmptyString(source.id) ??
      nonEmptyString(context.id) ??
      "",
    bookingReference:
      nonEmptyString(source.bookingReference) ?? nonEmptyString(context.bookingReference) ?? "",
    hotelName: nonEmptyString(context.hotelName) ?? nonEmptyString(source.hotelName) ?? "",
    roomName: nonEmptyString(context.roomName) ?? nonEmptyString(source.roomName) ?? "",
    guestFirstName:
      nonEmptyString(context.guestFirstName) ?? nonEmptyString(source.guestFirstName) ?? "",
    guestLastName:
      nonEmptyString(context.guestLastName) ?? nonEmptyString(source.guestLastName) ?? "",
    guestEmail: nonEmptyString(context.guestEmail) ?? nonEmptyString(source.guestEmail) ?? "",
    checkIn,
    checkOut,
    nights: derivedNights || sourceNights || contextNights,
    adults: nonNegativeInteger(source.adults, nonNegativeInteger(context.adults)),
    children: nonNegativeInteger(source.children, nonNegativeInteger(context.children)),
    nightlyRate: nonNegativeNumber(source.nightlyRate, nonNegativeNumber(context.nightlyRate)),
    numberOfRooms: nonNegativeInteger(
      source.roomCount ?? source.numberOfRooms,
      Math.max(nonNegativeInteger(context.numberOfRooms, 1), 1),
    ),
    totalAmount: nonNegativeNumber(source.totalAmount, nonNegativeNumber(context.totalAmount)),
    depositRequired: source.depositRequired ?? context.depositRequired,
    depositPercentage: nonNegativeNumber(
      source.depositPercentage,
      nonNegativeNumber(context.depositPercentage),
    ),
    depositAmount: nonNegativeNumber(
      source.depositAmount,
      nonNegativeNumber(context.depositAmount),
    ),
    balanceAmount: nonNegativeNumber(
      source.balanceAmount,
      nonNegativeNumber(context.balanceAmount),
    ),
    addonTotal: nonNegativeNumber(source.addonTotal, nonNegativeNumber(context.addonTotal)),
    addonIds: context.addonIds ?? source.addonIds,
    addonNames: context.addonNames ?? source.addonNames,
    addonQuantities: context.addonQuantities ?? source.addonQuantities,
    addonDates: context.addonDates ?? source.addonDates,
    currency:
      nonEmptyString(source.currency)?.toUpperCase() ??
      nonEmptyString(context.currency)?.toUpperCase() ??
      "EUR",
    status: hasSourceBookingStatus
      ? (bookingStatus(source.status) ?? "pending")
      : (bookingStatus(context.status) ?? "pending"),
    paymentMethod: paymentMethod(context.paymentMethod) ?? paymentMethod(source.paymentMethod),
    paymentStatus: hasSourcePaymentStatus
      ? paymentStatus(source.paymentStatus)
      : paymentStatus(context.paymentStatus),
    hostResponseDeadline:
      nonEmptyString(source.hostResponseDeadline) ?? nonEmptyString(context.hostResponseDeadline),
    createdAt: nonEmptyString(source.createdAt) ?? nonEmptyString(context.createdAt) ?? "",
  };
}

export function saveLastBooking(booking: Booking): void {
  safeSet(LAST_BOOKING_KEY, JSON.stringify(booking));
}

export function readLastBooking(): Booking | null {
  const raw = safeGet(LAST_BOOKING_KEY);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as Booking;
  } catch {
    return null;
  }
}
