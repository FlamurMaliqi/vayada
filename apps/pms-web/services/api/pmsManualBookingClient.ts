import { resolveSelectedPmsPropertyId, propertyEndpoint } from "./pmsPropertyClient";
import { ApiErrorResponse } from "./client";
import { pmsOperationsClient, pmsOperationsRequestOptions } from "./pmsOperationsClient";

export const PMS_MANUAL_BOOKING_CONTRACT_VERSION = "pms-manual-booking.v1" as const;

export type PmsManualBookingMoney = { amountDecimal: string; currency: string };
type PmsManualBookingStayBase = {
  position: number;
  roomId: string;
  checkIn: string;
  checkOut: string;
  adults: number;
  children: number;
};
export type PmsManualBookingStay = PmsManualBookingStayBase &
  (
    | {
        ratePlanId: string;
        pricing: { kind: "rate_plan"; manualOverride: PmsManualBookingMoney | null };
      }
    | { ratePlanId: null; pricing: { kind: "custom"; nightlyAmount: PmsManualBookingMoney } }
  );
export type PmsManualBookingAddonSelection = {
  addonId: string;
  packageCount: number;
  serviceUnits: Array<{ serviceDate: string | null; guestCount: number | null }>;
};
export type PmsManualBookingPreviewInput = {
  stays: PmsManualBookingStay[];
  addOns: PmsManualBookingAddonSelection[];
};
export type PmsManualBookingCapabilities = {
  contractVersion: typeof PMS_MANUAL_BOOKING_CONTRACT_VERSION;
  canRecordPaidPayment: boolean;
};
export type PmsManualBookingCreateInput = PmsManualBookingPreviewInput & {
  commandId: string;
  idempotencyKey: string;
  guest: {
    firstName: string;
    lastName: string;
    email: string;
    phoneE164: string | null;
    countryCode: string | null;
    specialRequests: string | null;
  };
  privateNote: string | null;
  directSource: "call" | "email" | "whatsapp" | "walk_in" | "social_media" | "other";
  payment: {
    expectedMethod: "pay_at_property" | "bank_transfer" | "manual_card" | "cash" | "other";
    settlement: { status: "unpaid" } | { status: "paid"; reference: string | null };
  };
};
export type PmsManualBookingPreviewResult = {
  contractVersion: typeof PMS_MANUAL_BOOKING_CONTRACT_VERSION;
  currency: string;
  stays: Array<{
    position: number;
    roomId: string;
    ratePlanId: string | null;
    nightly: Array<{
      serviceDate: string;
      standard: PmsManualBookingMoney | null;
      applied: PmsManualBookingMoney;
    }>;
    standardTotal: PmsManualBookingMoney | null;
    appliedTotal: PmsManualBookingMoney;
  }>;
  addOns: Array<{
    addonId: string;
    pricingModel: "per_stay" | "per_night" | "per_guest" | "per_guest_night";
    unitPrice: PmsManualBookingMoney;
    packageCount: number;
    serviceUnits: PmsManualBookingAddonSelection["serviceUnits"];
    total: PmsManualBookingMoney;
  }>;
  grandTotal: PmsManualBookingMoney;
};
export type PmsManualBookingCreateResult = {
  contractVersion: typeof PMS_MANUAL_BOOKING_CONTRACT_VERSION;
  outcome: "created" | "replayed";
  commandId: string;
  idempotencyKey: string;
  guestBookingId: string;
  bookingReference: string;
  bookingChannel: "direct";
  directSource: PmsManualBookingCreateInput["directSource"];
  stayCount: number;
  checkIn: string;
  checkOut: string;
  total: PmsManualBookingMoney;
  balance: PmsManualBookingMoney;
  paymentStatus: "unpaid" | "paid";
  paymentEvidenceId: string | null;
  rearrangedBookingCount: number;
  sideEffects: Array<"calendar_refresh" | "ari_changed" | "guest_confirmation" | "audit_event">;
};

export type PmsManualBookingErrorCategory =
  | "validation"
  | "authorization"
  | "not_found"
  | "conflict"
  | "unavailable";
export const PMS_MANUAL_BOOKING_ERROR_CODES = [
  "unauthenticated",
  "invalid_body",
  "unknown_field",
  "forbidden",
  "entitlement_required",
  "paid_forbidden",
  "property_not_found",
  "room_not_found",
  "rate_plan_not_found",
  "addon_not_found",
  "room_unavailable",
  "idempotency_conflict",
  "invalid_dates",
  "occupancy_exceeded",
  "currency_mismatch",
  "inactive_rate_plan",
  "invalid_addon_selection",
  "invalid_source",
  "invalid_payment_method",
  "manual_booking_preview_unavailable",
  "manual_booking_create_unavailable",
  "unknown_error",
] as const;
export type PmsManualBookingErrorCode = (typeof PMS_MANUAL_BOOKING_ERROR_CODES)[number];

export class PmsManualBookingServiceError extends Error {
  constructor(
    readonly category: PmsManualBookingErrorCategory,
    readonly code: PmsManualBookingErrorCode,
    readonly status: number,
    message: string,
    readonly field?: string,
    readonly stayPosition?: number,
  ) {
    super(message);
    this.name = "PmsManualBookingServiceError";
  }
}

export const pmsManualBookingClient = {
  capabilities: async (): Promise<PmsManualBookingCapabilities> => {
    const fallback = {
      contractVersion: PMS_MANUAL_BOOKING_CONTRACT_VERSION,
      canRecordPaidPayment: false,
    };
    try {
      const propertyId = await resolveSelectedPmsPropertyId("loading manual booking capabilities");
      const value = await pmsOperationsClient.get<unknown>(
        propertyEndpoint(propertyId, "manual-bookings/capabilities"),
        pmsOperationsRequestOptions,
      );
      return isCapabilities(value) ? value : fallback;
    } catch {
      return fallback;
    }
  },
  preview: (input: PmsManualBookingPreviewInput) =>
    post<PmsManualBookingPreviewResult>("previewing a manual booking", "preview", input),
  create: (input: PmsManualBookingCreateInput) =>
    post<PmsManualBookingCreateResult>("creating a manual booking", "", input),
};

function isCapabilities(value: unknown): value is PmsManualBookingCapabilities {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return (
    Object.keys(record).length === 2 &&
    record["contractVersion"] === PMS_MANUAL_BOOKING_CONTRACT_VERSION &&
    typeof record["canRecordPaidPayment"] === "boolean"
  );
}

async function post<T>(action: string, suffix: string, input: object): Promise<T> {
  const propertyId = await resolveSelectedPmsPropertyId(action);
  const endpoint = propertyEndpoint(propertyId, `manual-bookings${suffix ? `/${suffix}` : ""}`);
  try {
    return await pmsOperationsClient.post<T>(
      endpoint,
      { ...input, contractVersion: PMS_MANUAL_BOOKING_CONTRACT_VERSION },
      pmsOperationsRequestOptions,
    );
  } catch (error) {
    if (!(error instanceof ApiErrorResponse)) throw error;
    const body = error.data;
    throw new PmsManualBookingServiceError(
      categoryFor(error.status),
      isErrorCode(body.code) ? body.code : "unknown_error",
      error.status,
      typeof body.message === "string" ? body.message : error.message,
      typeof body.field === "string" ? body.field : undefined,
      typeof body.stayPosition === "number" ? body.stayPosition : undefined,
    );
  }
}

function isErrorCode(value: unknown): value is PmsManualBookingErrorCode {
  return PMS_MANUAL_BOOKING_ERROR_CODES.includes(value as PmsManualBookingErrorCode);
}

function categoryFor(status: number): PmsManualBookingErrorCategory {
  if (status === 401 || status === 403) return "authorization";
  if (status === 404) return "not_found";
  if (status === 409) return "conflict";
  if (status === 400 || status === 422) return "validation";
  return "unavailable";
}
