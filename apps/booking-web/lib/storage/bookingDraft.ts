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
  addonPackageQuantities?: Record<string, number>;
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
const CHECKOUT_ATTEMPT_KEY = "bookingCheckoutAttempt";
const PENDING_CREATE_RECOVERY_KEY = "pendingBookingCreateRecovery";

export type PendingBookingCreateRecovery<TQuote = unknown, TRequest = unknown> = {
  slug: string;
  quote: TQuote;
  quoteId: string;
  paymentMethod: string;
  requestBody: TRequest;
  createIdempotencyKey: string;
  draftId?: string;
  confirmationToken?: string;
};

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

function safeRemove(key: string): void {
  if (typeof window === "undefined") return;
  try {
    sessionStorage.removeItem(key);
  } catch {}
}

export function saveGuestDetails(draft: GuestDetailsDraft): void {
  safeSet(GUEST_KEY, JSON.stringify(draft));
  safeSet(CHECKOUT_ATTEMPT_KEY, JSON.stringify({ keys: {} }));
}

export function savePendingBookingCreate<TQuote, TRequest>(
  recovery: PendingBookingCreateRecovery<TQuote, TRequest>,
): void {
  safeSet(PENDING_CREATE_RECOVERY_KEY, JSON.stringify(recovery));
}

export function readPendingBookingCreate<TQuote, TRequest = unknown>(
  slug: string,
): PendingBookingCreateRecovery<TQuote, TRequest> | null {
  const raw = safeGet(PENDING_CREATE_RECOVERY_KEY);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<PendingBookingCreateRecovery<TQuote, TRequest>>;
    if (
      parsed.slug !== slug ||
      typeof parsed.quote !== "object" ||
      parsed.quote === null ||
      typeof parsed.quoteId !== "string" ||
      !parsed.quoteId ||
      typeof parsed.paymentMethod !== "string" ||
      !parsed.paymentMethod ||
      typeof parsed.requestBody !== "object" ||
      parsed.requestBody === null ||
      typeof parsed.createIdempotencyKey !== "string" ||
      !parsed.createIdempotencyKey ||
      (parsed.draftId !== undefined && typeof parsed.draftId !== "string") ||
      (parsed.confirmationToken !== undefined && typeof parsed.confirmationToken !== "string")
    ) {
      return null;
    }
    return parsed as PendingBookingCreateRecovery<TQuote, TRequest>;
  } catch {
    return null;
  }
}

export function clearPendingBookingCreate(): void {
  safeRemove(PENDING_CREATE_RECOVERY_KEY);
}

export function getCheckoutIdempotencyKey(operation: string, identity: string): string {
  const state = checkoutAttemptState();
  const binding = `${operation}:${identity}`;
  const existing = state.keys[binding];
  if (existing && (!existing.expiresAt || existing.expiresAt > Date.now())) return existing.key;
  const key = `booking-web:${operation}:${randomToken()}`;
  state.keys[binding] = { key };
  safeSet(CHECKOUT_ATTEMPT_KEY, JSON.stringify(state));
  return key;
}

export function expireCheckoutIdempotencyKeyAt(
  operation: string,
  identity: string,
  expiresAt: string | undefined,
): void {
  if (!expiresAt) return;
  const timestamp = new Date(expiresAt).getTime();
  if (!Number.isFinite(timestamp)) return;
  const state = checkoutAttemptState();
  const binding = `${operation}:${identity}`;
  const existing = state.keys[binding];
  if (!existing) return;
  state.keys[binding] = { ...existing, expiresAt: timestamp };
  safeSet(CHECKOUT_ATTEMPT_KEY, JSON.stringify(state));
}

type CheckoutAttemptState = {
  keys: Record<string, { key: string; expiresAt?: number }>;
};

function checkoutAttemptState(): CheckoutAttemptState {
  const raw = safeGet(CHECKOUT_ATTEMPT_KEY);
  if (!raw) return { keys: {} };
  try {
    const parsed = JSON.parse(raw) as Partial<CheckoutAttemptState>;
    return parsed.keys && typeof parsed.keys === "object" ? { keys: parsed.keys } : { keys: {} };
  } catch {
    return { keys: {} };
  }
}

function randomToken(): string {
  return typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
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
  "checked_in",
  "checked_out",
];

const PAYMENT_METHODS = [
  "card",
  "credit_card",
  "pay_at_property",
  "cash",
  "xendit",
  "bank_transfer",
  "paypal",
  "manual_card",
  "other",
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

function cardLast4(value: unknown): string | null {
  const digits = nonEmptyString(value);
  return digits && /^\d{4}$/.test(digits) ? digits : null;
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

function nonEmptyStrings(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => Boolean(nonEmptyString(item)))
    : [];
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
    addonPackageQuantities: context.addonPackageQuantities ?? source.addonPackageQuantities,
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
    paymentDeadline:
      nonEmptyString(source.paymentDeadline) ?? nonEmptyString(context.paymentDeadline),
    bankTransferDetails:
      nonEmptyString(source.bankTransferDetails) ?? nonEmptyString(context.bankTransferDetails),
    unitNames:
      nonEmptyStrings(source.unitNames).length > 0
        ? nonEmptyStrings(source.unitNames)
        : nonEmptyStrings(context.unitNames),
    cancelledAt: nonEmptyString(source.cancelledAt) ?? nonEmptyString(context.cancelledAt),
    cardBrand: nonEmptyString(source.cardBrand) ?? nonEmptyString(context.cardBrand),
    cardLast4: cardLast4(source.cardLast4) ?? cardLast4(context.cardLast4),
    hostResponseDeadline:
      nonEmptyString(source.hostResponseDeadline) ?? nonEmptyString(context.hostResponseDeadline),
    createdAt: nonEmptyString(source.createdAt) ?? nonEmptyString(context.createdAt) ?? "",
  };
}

export function saveLastBooking(booking: Booking): void {
  safeSet(LAST_BOOKING_KEY, JSON.stringify({ ...booking, bankTransferDetails: null }));
}

export function readLastBooking(): Booking | null {
  const raw = safeGet(LAST_BOOKING_KEY);
  if (!raw) return null;
  try {
    const booking = JSON.parse(raw) as Booking;
    booking.bankTransferDetails = null;
    saveLastBooking(booking);
    return booking;
  } catch {
    return null;
  }
}
