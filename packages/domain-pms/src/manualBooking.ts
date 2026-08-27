export const PMS_MANUAL_BOOKING_CONTRACT_VERSION = "pms-manual-booking.v1" as const;

export const PMS_MANUAL_BOOKING_DIRECT_SOURCES = [
  "call",
  "email",
  "whatsapp",
  "walk_in",
  "social_media",
  "other",
] as const;

export const PMS_MANUAL_BOOKING_PAYMENT_METHODS = [
  "pay_at_property",
  "bank_transfer",
  "manual_card",
  "cash",
  "other",
] as const;

export type PmsManualBookingMoney = Readonly<{ amountDecimal: string; currency: string }>;
export type PmsManualBookingDirectSource = (typeof PMS_MANUAL_BOOKING_DIRECT_SOURCES)[number];
export type PmsManualBookingPaymentMethod = (typeof PMS_MANUAL_BOOKING_PAYMENT_METHODS)[number];

type PmsManualBookingStayBase = Readonly<{
  position: number;
  roomId: string;
  checkIn: string;
  checkOut: string;
  adults: number;
  children: number;
}>;

export type PmsManualBookingStay = PmsManualBookingStayBase &
  (
    | Readonly<{
        ratePlanId: string;
        pricing: Readonly<{ kind: "rate_plan"; manualOverride: PmsManualBookingMoney | null }>;
      }>
    | Readonly<{
        ratePlanId: null;
        pricing: Readonly<{ kind: "custom"; nightlyAmount: PmsManualBookingMoney }>;
      }>
  );

export type PmsManualBookingAddonSelection = Readonly<{
  addonId: string;
  packageCount: number;
  serviceUnits: readonly Readonly<{
    serviceDate: string | null;
    guestCount: number | null;
  }>[];
}>;

export type PmsManualBookingCreateCommand = Readonly<{
  contractVersion: typeof PMS_MANUAL_BOOKING_CONTRACT_VERSION;
  commandId: string;
  idempotencyKey: string;
  propertyId: string;
  organizationId: string;
  guest: Readonly<{
    firstName: string;
    lastName: string;
    email: string;
    phoneE164: string | null;
    countryCode: string | null;
    specialRequests: string | null;
  }>;
  privateNote: string | null;
  directSource: PmsManualBookingDirectSource;
  stays: readonly PmsManualBookingStay[];
  addOns: readonly PmsManualBookingAddonSelection[];
  payment: Readonly<{
    expectedMethod: PmsManualBookingPaymentMethod;
    settlement:
      Readonly<{ status: "unpaid" }> | Readonly<{ status: "paid"; reference: string | null }>;
  }>;
  audit: Readonly<{
    actor: Readonly<{ kind: "user"; userId: string; organizationId: string }>;
    requestId: string;
    correlationId: string | null;
    requestedAt: string;
  }>;
}>;

export type PmsManualBookingCreateResult = Readonly<{
  contractVersion: typeof PMS_MANUAL_BOOKING_CONTRACT_VERSION;
  outcome: "created" | "replayed";
  commandId: string;
  idempotencyKey: string;
  guestBookingId: string;
  bookingReference: string;
  bookingChannel: "direct";
  directSource: PmsManualBookingDirectSource;
  stayCount: number;
  checkIn: string;
  checkOut: string;
  total: PmsManualBookingMoney;
  balance: PmsManualBookingMoney;
  paymentStatus: "unpaid" | "paid";
  paymentEvidenceId: string | null;
  rearrangedBookingCount: number;
  sideEffects: readonly ["calendar_refresh", "ari_changed", "guest_confirmation", "audit_event"];
}>;

export type PmsManualBookingCreateErrorCode =
  | "invalid_body"
  | "unknown_field"
  | "forbidden"
  | "entitlement_required"
  | "paid_forbidden"
  | "property_not_found"
  | "room_not_found"
  | "rate_plan_not_found"
  | "addon_not_found"
  | "room_unavailable"
  | "idempotency_conflict"
  | "invalid_dates"
  | "occupancy_exceeded"
  | "currency_mismatch"
  | "inactive_rate_plan"
  | "invalid_addon_selection"
  | "invalid_source"
  | "invalid_payment_method";

export class PmsManualBookingCreateError extends Error {
  constructor(
    readonly code: PmsManualBookingCreateErrorCode,
    readonly field?: string,
    readonly stayPosition?: number,
  ) {
    super(code);
    this.name = "PmsManualBookingCreateError";
  }
}

export interface PmsManualBookingCreatePort {
  createManualBooking(
    command: PmsManualBookingCreateCommand,
  ): Promise<PmsManualBookingCreateResult>;
}
