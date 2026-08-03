import {
  PMS_RESERVATION_CONTRACT_VERSION,
  type CreatePmsReservationCommand,
  type PmsAuditContext,
  type PmsExternalReference,
  type PmsGuest,
  type PmsMoney,
  type PmsProviderKey,
  type PmsReservationError,
  type PmsReservationHandoffResult,
  type PmsReservationSink,
} from "@vayada/domain-pms";

export * from "./onboardingPublication.js";
export * from "./bookingLaunchEvidence.js";
export * from "./bookingLaunchReadiness.js";
export * from "./bookingDesign.js";
export * from "./bookingDesignSnapshot.js";
export * from "./bookingDesignReadiness.js";

export type BookingUtcDateTime = string;
export type BookingDate = string;
export type BookingMoney = PmsMoney;

// ─── Dashboard metrics read model ────────────────────────────────────────────
// Owner: Booking/checkout read model.
// These types represent the target contract for Booking dashboard data so that
// TypeScript Booking code never opens PMS_DATABASE_URL directly (C04 in the
// booking-pms-coupling-audit).

export type BookingRevenueStats = {
  totalRevenue: BookingMoney;
  bookingCount: number;
  avgNightlyRate: BookingMoney;
};

export type BookingSourceMixItem = {
  /** Booking channel, e.g. "direct", "airbnb", "booking.com" */
  source: string;
  revenue: BookingMoney;
  bookingCount: number;
  /** Revenue share as 0–100, rounded to one decimal place */
  revenueSharePercent: number;
};

export type BookingSourceMixReadModel = {
  propertyId: string;
  periodStart: BookingDate;
  periodEnd: BookingDate;
  totalRevenue: BookingMoney;
  items: readonly BookingSourceMixItem[];
};

export type BookingSparklinePoint = {
  /** Start of the bucket (inclusive) */
  bucketStart: BookingDate;
  /** End of the bucket (inclusive) */
  bucketEnd: BookingDate;
  revenue: BookingMoney;
  bookingCount: number;
  avgNightlyRate: BookingMoney;
};

export type BookingSparklineReadModel = {
  propertyId: string;
  /** 7 contiguous non-overlapping date buckets */
  points: readonly BookingSparklinePoint[];
};

export type BookingDashboardMetricsReadModel = {
  propertyId: string;
  current: BookingRevenueStats;
  previous: BookingRevenueStats;
  /**
   * Next confirmed check-in date for this property, or null if none upcoming.
   * Served from the Booking confirmed-bookings read model; does NOT require
   * an operational PMS reservation query.
   */
  nextArrivalDate: BookingDate | null;
  /**
   * Date of the first confirmed booking ever recorded for this property,
   * or null if no bookings yet.
   */
  liveSinceDate: BookingDate | null;
};

export type BookingDashboardMetricsPeriodInput = {
  propertyId: string;
  periodStart: BookingDate;
  periodEnd: BookingDate;
  previousPeriodStart: BookingDate;
  previousPeriodEnd: BookingDate;
};

/**
 * Read port for Booking dashboard metrics.
 * Implemented by the Booking domain; consumed by Booking API dashboard routes.
 * Must never open PMS_DATABASE_URL — see engineering/booking-pms-coupling-audit.md C04.
 */
export type BookingDashboardMetricsReadPort = {
  getDashboardMetrics(
    input: BookingDashboardMetricsPeriodInput,
  ): Promise<BookingDashboardMetricsReadModel | null>;
  getSourceMix(
    input: Omit<BookingDashboardMetricsPeriodInput, "previousPeriodStart" | "previousPeriodEnd">,
  ): Promise<BookingSourceMixReadModel>;
  getSparklines(input: {
    propertyId: string;
    windowStart: BookingDate;
    windowEnd: BookingDate;
  }): Promise<BookingSparklineReadModel>;
};

// ─── Booking reservations read model ────────────────────────────────────────
// Owner: Booking/checkout read model. The HTTP route may keep legacy response
// keys for Booking Admin, but this port is the product-domain read boundary.

export type BookingAssignedRoom = {
  roomId: string | null;
  roomNumber: string | null;
  position: number;
};

export type BookingReservationReadModel = {
  id: string;
  bookingReference: string;
  roomTypeId: string;
  roomName: string;
  roomMaxOccupancy: number;
  guestFirstName: string;
  guestLastName: string;
  guestEmail: string;
  guestPhone: string;
  guestCountry: string;
  guestGender: string;
  guestDateOfBirth: BookingDate | null;
  guestPassportNumber: string;
  specialRequests: string;
  estimatedArrivalTime: string | null;
  numberOfGuests: number | null;
  checkIn: BookingDate;
  checkOut: BookingDate;
  nights: number;
  adults: number;
  children: number;
  nightlyRate: number;
  numberOfRooms: number;
  totalRoomCapacity: number;
  totalAmount: number;
  currency: string;
  status: string;
  roomId: string | null;
  roomNumber: string | null;
  assignedRooms: BookingAssignedRoom[];
  channel: string;
  paymentMethod: string | null;
  paymentStatus: string | null;
  depositRequired: boolean;
  depositPercentage: number | null;
  depositAmount: number;
  balanceAmount: number;
  checkInPendingFlags: string[];
  checkedInAt: BookingUtcDateTime | null;
  checkedOutAt: BookingUtcDateTime | null;
  hostResponseDeadline: BookingUtcDateTime | null;
  platformFeeAmount: number | null;
  affiliateCommissionAmount: number | null;
  propertyPayoutAmount: number | null;
  addonIds: string[];
  addonNames: string[];
  addonTotal: number;
  addonQuantities: Record<string, number>;
  addonDates: Record<string, string[]>;
  guestWithdrawn: boolean;
  promoCode: string | null;
  promoDiscount: number;
  lastMinuteDiscountPercent: number;
  lastMinuteDiscountAmount: number;
  createdAt: BookingUtcDateTime;
  updatedAt: BookingUtcDateTime;
};

export type BookingReservationListResult = {
  reservations: BookingReservationReadModel[];
  total: number;
};

export type BookingReservationListFilters = {
  status?: string;
  search?: string;
  limit: number;
  offset: number;
};

export type BookingReservationsReadRepository = {
  listReservationsByHotelId(
    hotelId: string,
    filters: BookingReservationListFilters,
  ): Promise<BookingReservationListResult>;
  close?(): Promise<void>;
};

export type BookingPrimaryGuest = PmsGuest;

export type BookingGuestPiiRole = "booker" | "primary_guest" | "additional_guest";

export type BookingGuestPii = {
  guestId: string;
  guestBookingId: string;
  role: BookingGuestPiiRole;
  displayName: string;
  firstName: string;
  lastName: string;
  email: string | null;
  phone: string | null;
  countryCode: string | null;
  arrivalTime: string | null;
  specialRequests: string | null;
};

export type BookingGuestPiiProjection = {
  propertyId: string;
  guestBookingId: string;
  primaryGuest: BookingGuestPii | null;
  additionalGuests: readonly BookingGuestPii[];
};

export type BookingGuestPiiCommandMeta = {
  contractVersion: "booking-guest-pii.v1";
  commandId: string;
  idempotencyKey: string;
  acceptedAt: BookingUtcDateTime;
  sideEffects: readonly ["audit_event"];
};

export type BookingGuestPiiAuditContext = {
  actorUserId: string;
  actorOrganizationId: string;
  requestId: string;
  correlationId?: string;
  source: "pms_operations";
  reason: string;
};

export type BookingAdditionalGuestInput = {
  firstName: string;
  lastName: string;
  email?: string | null;
  phone?: string | null;
  countryCode?: string | null;
  arrivalTime?: string | null;
  specialRequests?: string | null;
};

export type BookingAdditionalGuestCreateCommand = {
  propertyId: string;
  guestBookingId: string;
  commandId: string;
  idempotencyKey: string;
  guest: BookingAdditionalGuestInput;
  audit: BookingGuestPiiAuditContext;
};

export type BookingAdditionalGuestUpdateCommand = Omit<
  BookingAdditionalGuestCreateCommand,
  "guest"
> & {
  guestId: string;
  guest: Partial<BookingAdditionalGuestInput>;
};

export type BookingAdditionalGuestDeleteCommand = Omit<
  BookingAdditionalGuestCreateCommand,
  "guest"
> & {
  guestId: string;
};

export type BookingGuestPiiCommandResult =
  | {
      ok: true;
      additionalGuest: BookingGuestPii;
      projection: BookingGuestPiiProjection;
      commandMeta: BookingGuestPiiCommandMeta;
      replayed?: boolean;
    }
  | {
      ok: false;
      statusCode: 400 | 404 | 409;
      code:
        | "invalid_guest_pii"
        | "reservation_not_found"
        | "additional_guest_not_found"
        | "idempotency_conflict";
      message: string;
    };

export type BookingGuestPiiDeleteResult =
  | {
      ok: true;
      guestId: string;
      projection: BookingGuestPiiProjection;
      commandMeta: BookingGuestPiiCommandMeta;
      replayed?: boolean;
    }
  | Exclude<BookingGuestPiiCommandResult, { ok: true }>;

/**
 * Booking-owned guest PII port for PMS operations.
 *
 * PMS may request an operational projection, but validation, retention,
 * mutation, and guest-visible audit semantics stay in Booking.
 */
export type BookingGuestPiiPort = {
  listGuestPiiForPmsOperations(input: {
    propertyId: string;
    guestBookingId: string;
  }): Promise<BookingGuestPiiProjection | null>;
  createAdditionalGuestForPmsOperations(
    command: BookingAdditionalGuestCreateCommand,
  ): Promise<BookingGuestPiiCommandResult>;
  updateAdditionalGuestForPmsOperations(
    command: BookingAdditionalGuestUpdateCommand,
  ): Promise<BookingGuestPiiCommandResult>;
  deleteAdditionalGuestForPmsOperations(
    command: BookingAdditionalGuestDeleteCommand,
  ): Promise<BookingGuestPiiDeleteResult>;
  close?(): Promise<void>;
};

export type CommittedGuestBooking = {
  guestBookingId: string;
  bookingReference: string;
  propertyId: string;
  organizationId: string;
  createdAt: BookingUtcDateTime;
  locale: string;
  stay: {
    checkInDate: BookingDate;
    checkOutDate: BookingDate;
    adults: number;
    children: number;
    numberOfRooms: number;
    estimatedArrivalTime?: string | null;
    specialRequests?: string | null;
  };
  guests: {
    primary: BookingPrimaryGuest;
    additional?: BookingPrimaryGuest[];
  };
  bookedOffer: {
    roomTypeId: string;
    ratePlanId?: string | null;
    roomName: string;
    roomTypeExternalRef?: PmsExternalReference;
    ratePlanExternalRef?: PmsExternalReference;
  };
  pricing: {
    roomTotal: BookingMoney;
    taxesAndFees?: BookingMoney;
    discounts?: BookingMoney;
    addonsTotal?: BookingMoney;
    grandTotal: BookingMoney;
  };
  payment: CreatePmsReservationCommand["payment"];
  policy: CreatePmsReservationCommand["policy"];
};

export type PmsReservationConnection = {
  provider: PmsProviderKey;
  connectionId: string;
};

export type BookingHandoffActor = Pick<PmsAuditContext, "actorType" | "actorId" | "source">;

export type BookingPmsReservationHandoffInput = {
  booking: CommittedGuestBooking;
  connection: PmsReservationConnection;
  requestId: string;
  correlationId: string;
  causationId?: string;
  occurredAt: BookingUtcDateTime;
  actor?: BookingHandoffActor;
};

export type BookingPmsHandoffStatus =
  | "pending_handoff"
  | "synced"
  | "accepted_async"
  | "duplicate_replayed"
  | "manual_review_required"
  | "retry_pending";

export type BookingPmsHandoffState = {
  guestBookingId: string;
  bookingReference: string;
  propertyId: string;
  commandId: string;
  idempotencyKey: string;
  status: BookingPmsHandoffStatus;
  outcome: PmsReservationHandoffResult["outcome"];
  pmsReservationRef?: string;
  operationalReservationId?: string;
  providerRequestId?: string;
  auditEventId: string;
  retryAfter?: BookingUtcDateTime;
  error?: PmsReservationError;
};

export class BookingPmsHandoffContractError extends Error {
  readonly code = "PMS_HANDOFF_CONTRACT_MISMATCH";

  constructor(message: string) {
    super(message);
    this.name = "BookingPmsHandoffContractError";
  }
}

export function buildCreatePmsReservationCommand(
  input: BookingPmsReservationHandoffInput,
): CreatePmsReservationCommand {
  const { booking, connection } = input;
  const idempotencyKey = buildCreateReservationIdempotencyKey({
    propertyId: booking.propertyId,
    guestBookingId: booking.guestBookingId,
  });

  return {
    contractVersion: PMS_RESERVATION_CONTRACT_VERSION,
    commandId: buildCreateReservationCommandId(idempotencyKey),
    idempotencyKey,
    audit: {
      requestId: input.requestId,
      correlationId: input.correlationId,
      causationId: input.causationId,
      organizationId: booking.organizationId,
      propertyId: booking.propertyId,
      actorType: input.actor?.actorType ?? "guest",
      actorId: input.actor?.actorId,
      source: input.actor?.source ?? "booking_engine",
      occurredAt: input.occurredAt,
    },
    target: {
      propertyId: booking.propertyId,
      provider: connection.provider,
      connectionId: connection.connectionId,
      requiredCapabilities: ["create_reservation"],
    },
    guestBooking: {
      guestBookingId: booking.guestBookingId,
      bookingReference: booking.bookingReference,
      status: "confirmed",
      createdAt: booking.createdAt,
      source: "direct_booking",
      locale: booking.locale,
    },
    stay: booking.stay,
    guests: booking.guests,
    bookedOffer: booking.bookedOffer,
    pricing: booking.pricing,
    payment: booking.payment,
    policy: booking.policy,
  };
}

export async function handOffCommittedBookingToPms(
  sink: Pick<PmsReservationSink, "createReservation">,
  input: BookingPmsReservationHandoffInput,
): Promise<BookingPmsHandoffState> {
  const command = buildCreatePmsReservationCommand(input);
  const result = await sink.createReservation(command);
  assertPmsResultMatchesCommand(command, result);
  return mapPmsHandoffResultToBookingState({
    booking: input.booking,
    result,
  });
}

function mapPmsHandoffResultToBookingState(input: {
  booking: Pick<CommittedGuestBooking, "guestBookingId" | "bookingReference" | "propertyId">;
  result: PmsReservationHandoffResult;
}): BookingPmsHandoffState {
  const { booking, result } = input;
  return {
    guestBookingId: booking.guestBookingId,
    bookingReference: booking.bookingReference,
    propertyId: booking.propertyId,
    commandId: result.commandId,
    idempotencyKey: result.idempotencyKey,
    status: bookingStatusForResult(result),
    outcome: result.outcome,
    pmsReservationRef: result.pmsReservationRef,
    operationalReservationId: result.operationalReservationId,
    providerRequestId: result.providerRequestId,
    auditEventId: result.auditEventId,
    retryAfter: result.retryAfter,
    error: result.outcome === "failed" ? result.error : undefined,
  };
}

export function buildCreateReservationIdempotencyKey(input: {
  propertyId: string;
  guestBookingId: string;
}): string {
  return `pms.reservation.create:property:${input.propertyId}:booking:${input.guestBookingId}:v1`;
}

function buildCreateReservationCommandId(idempotencyKey: string): string {
  return `cmd_pms_create_${stableHash(idempotencyKey).slice(0, 24)}`;
}

function stableHash(value: string): string {
  const seeds = [0x811c9dc5, 0x811c9dc5 ^ 0x9e3779b9, 0x811c9dc5 ^ 0x85ebca6b];

  return seeds
    .map((seed) => {
      let hash = seed;
      for (let index = 0; index < value.length; index += 1) {
        hash = Math.imul(hash ^ value.charCodeAt(index), 0x01000193) >>> 0;
      }
      return hash.toString(16).padStart(8, "0");
    })
    .join("");
}

function bookingStatusForResult(result: PmsReservationHandoffResult): BookingPmsHandoffStatus {
  switch (result.outcome) {
    case "succeeded":
      return "synced";
    case "accepted":
      return "accepted_async";
    case "duplicate_replayed":
      return "duplicate_replayed";
    case "noop":
      return "synced";
    case "failed":
      return isRetryableFailure(result.error) ? "retry_pending" : "manual_review_required";
  }
}

function assertPmsResultMatchesCommand(
  command: CreatePmsReservationCommand,
  result: PmsReservationHandoffResult,
): void {
  const mismatches: string[] = [];
  if (result.contractVersion !== command.contractVersion) {
    mismatches.push("contractVersion");
  }
  if (result.commandId !== command.commandId) {
    mismatches.push("commandId");
  }
  if (result.idempotencyKey !== command.idempotencyKey) {
    mismatches.push("idempotencyKey");
  }
  if (result.guestBookingId !== command.guestBooking.guestBookingId) {
    mismatches.push("guestBookingId");
  }

  if (mismatches.length > 0) {
    throw new BookingPmsHandoffContractError(
      `PMS reservation handoff result did not match command fields: ${mismatches.join(", ")}`,
    );
  }
}

function isRetryableFailure(error: PmsReservationError): boolean {
  if (
    error.code === "PMS_DISCONNECTED" ||
    error.code === "UNSUPPORTED_CAPABILITY" ||
    error.code === "DUPLICATE_RESERVATION" ||
    error.code === "MAPPING_MISSING" ||
    error.code === "IDEMPOTENCY_CONFLICT" ||
    error.code === "VALIDATION_FAILED" ||
    error.code === "PROVIDER_REJECTED"
  ) {
    return false;
  }

  return error.retryable;
}
