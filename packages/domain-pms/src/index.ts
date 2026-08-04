export * from "./roomFacts.js";
export * from "./roomAmenities.js";
export * from "./roomMedia.js";
export * from "./roomPublication.js";
export * from "./physicalRoomUnits.js";
export * from "./pricing.js";
export * from "./recurringPricing.js";
export * from "./mandatoryChargeConfirmation.js";
export * from "./operatingCalendar.js";
export * from "./operatingCalendarImpact.js";
export * from "./inventoryMaterialization.js";
export * from "./inventoryMaterializationPlanner.js";
export * from "./inventoryReservationLifecycle.js";

export const PMS_RESERVATION_CONTRACT_VERSION = "pms-reservation.v1" as const;
export const PMS_INVENTORY_RESERVATION_MARKER_VERSION = "pms.inventory-reservation.v1" as const;

export const PMS_PROVIDER_KEYS = ["vayada_pms", "guesty", "lodgify", "hostaway", "custom"] as const;

export const PMS_CAPABILITIES = [
  "create_reservation",
  "update_stay_dates",
  "update_guest_details",
  "update_room_type",
  "cancel_reservation",
  "read_operational_reservation",
  "read_inventory_assignments",
] as const;

export const PMS_CONNECTION_STATUSES = [
  "connected",
  "disconnected",
  "suspended",
  "degraded",
  "setup_incomplete",
] as const;

export const PMS_RESERVATION_STATUSES = [
  "pending_handoff",
  "confirmed",
  "modified",
  "cancelled",
  "checked_in",
  "in_house",
  "checked_out",
  "no_show",
  "failed",
] as const;

export const PMS_HANDOFF_OUTCOMES = [
  "succeeded",
  "accepted",
  "duplicate_replayed",
  "noop",
  "failed",
] as const;

export const PMS_RESERVATION_ERROR_CODES = [
  "PMS_DISCONNECTED",
  "UNSUPPORTED_CAPABILITY",
  "DUPLICATE_RESERVATION",
  "MAPPING_MISSING",
  "RETRYABLE_INTEGRATION_FAILURE",
  "IDEMPOTENCY_CONFLICT",
  "VALIDATION_FAILED",
  "CONFLICT",
  "PROVIDER_REJECTED",
] as const;

export const PMS_USER_VISIBLE_ERROR_CATEGORIES = [
  "manual_review_required",
  "temporary_unavailable",
  "configuration_required",
  "already_exists",
  "invalid_request",
] as const;

export type PmsReservationContractVersion = "pms-reservation.v1";
export type PmsProviderKey = (typeof PMS_PROVIDER_KEYS)[number];
export type PmsCapability = (typeof PMS_CAPABILITIES)[number];
export type PmsConnectionStatus = (typeof PMS_CONNECTION_STATUSES)[number];
export type PmsReservationStatus = (typeof PMS_RESERVATION_STATUSES)[number];
export type PmsReservationHandoffOutcome = (typeof PMS_HANDOFF_OUTCOMES)[number];
export type PmsReservationErrorCode = (typeof PMS_RESERVATION_ERROR_CODES)[number];
export type PmsUserVisibleErrorCategory = (typeof PMS_USER_VISIBLE_ERROR_CATEGORIES)[number];

export type PmsCurrencyCode = string;
export type PmsDecimalAmount = string;
export type PmsDate = string;
export type PmsUtcDateTime = string;

export type PmsInventoryReservationMarker = {
  contractVersion: typeof PMS_INVENTORY_RESERVATION_MARKER_VERSION;
  owner: "pms";
  source: "booking_engine";
  quoteSessionId: string;
  propertyId: string;
  roomTypeId: string;
  publicOfferKey: string;
  checkIn: PmsDate;
  checkOut: PmsDate;
  roomCount: number;
};

export type PmsMoney = {
  amountDecimal: PmsDecimalAmount;
  currency: PmsCurrencyCode;
};

export type PmsAuditContext = {
  requestId: string;
  correlationId: string;
  causationId?: string;
  organizationId: string;
  propertyId: string;
  actorType: "guest" | "hotel_user" | "system" | "platform_admin";
  actorId?: string;
  source: "booking_engine" | "pms_admin" | "job_retry" | "migration" | "test";
  occurredAt: PmsUtcDateTime;
};

export type PmsExternalReference = {
  provider: PmsProviderKey;
  connectionId: string;
  externalReservationId?: string;
  externalPropertyId?: string;
  externalRoomTypeId?: string;
  externalRatePlanId?: string;
  opaqueProviderData?: Record<string, string | number | boolean | null>;
};

export type PmsGuest = {
  firstName: string;
  lastName: string;
  email?: string | null;
  phone?: string | null;
  country?: string | null;
  dateOfBirth?: PmsDate | null;
};

export type CreatePmsReservationCommand = {
  contractVersion: PmsReservationContractVersion;
  commandId: string;
  idempotencyKey: string;
  audit: PmsAuditContext;
  target: {
    propertyId: string;
    provider: PmsProviderKey;
    connectionId: string;
    requiredCapabilities: ["create_reservation"];
  };
  guestBooking: {
    guestBookingId: string;
    bookingReference: string;
    status: "confirmed";
    createdAt: PmsUtcDateTime;
    source: "direct_booking";
    locale: string;
  };
  stay: {
    checkInDate: PmsDate;
    checkOutDate: PmsDate;
    adults: number;
    children: number;
    numberOfRooms: number;
    estimatedArrivalTime?: string | null;
    specialRequests?: string | null;
  };
  guests: {
    primary: PmsGuest;
    additional?: PmsGuest[];
  };
  bookedOffer: {
    roomTypeId: string;
    ratePlanId?: string | null;
    roomName: string;
    roomTypeExternalRef?: PmsExternalReference;
    ratePlanExternalRef?: PmsExternalReference;
  };
  pricing: {
    roomTotal: PmsMoney;
    taxesAndFees?: PmsMoney;
    discounts?: PmsMoney;
    addonsTotal?: PmsMoney;
    grandTotal: PmsMoney;
  };
  payment: {
    paymentStatus: "unpaid" | "authorized" | "partially_paid" | "paid";
    paymentMethod?: "card" | "pay_at_property" | "bank_transfer" | "other";
    depositAmount?: PmsMoney;
    balanceAmount?: PmsMoney;
    providerPaymentRef?: string;
  };
  policy: {
    cancellationPolicyId?: string;
    cancellationSummary?: string;
    refundableUntil?: PmsUtcDateTime | null;
  };
};

export type UpdatePmsReservationCommand = {
  contractVersion: PmsReservationContractVersion;
  commandId: string;
  idempotencyKey: string;
  audit: PmsAuditContext;
  target: {
    propertyId: string;
    provider: PmsProviderKey;
    connectionId: string;
    pmsReservationRef: string;
    requiredCapabilities: PmsCapability[];
  };
  guestBooking: {
    guestBookingId: string;
    bookingReference: string;
  };
  changes: {
    stay?: Partial<CreatePmsReservationCommand["stay"]>;
    guests?: Partial<CreatePmsReservationCommand["guests"]>;
    bookedOffer?: Partial<CreatePmsReservationCommand["bookedOffer"]>;
    pricing?: Partial<CreatePmsReservationCommand["pricing"]>;
    payment?: Partial<CreatePmsReservationCommand["payment"]>;
    policy?: Partial<CreatePmsReservationCommand["policy"]>;
  };
  expectedPreviousVersion?: string;
};

export type CancelPmsReservationCommand = {
  contractVersion: PmsReservationContractVersion;
  commandId: string;
  idempotencyKey: string;
  audit: PmsAuditContext;
  target: {
    propertyId: string;
    provider: PmsProviderKey;
    connectionId: string;
    pmsReservationRef: string;
    requiredCapabilities: ["cancel_reservation"];
  };
  guestBooking: {
    guestBookingId: string;
    bookingReference: string;
  };
  cancellation: {
    reason:
      | "guest_requested"
      | "hotel_declined"
      | "payment_failed"
      | "no_show"
      | "platform_action"
      | "other";
    cancelledAt: PmsUtcDateTime;
    penaltyAmount?: PmsMoney;
    refundAmount?: PmsMoney;
    note?: string;
  };
};

export type PmsReservationError = {
  code: PmsReservationErrorCode;
  retryable: boolean;
  userVisibleCategory: PmsUserVisibleErrorCategory;
  sanitizedMessage: string;
  providerStatusCode?: number;
  providerErrorCode?: string;
  providerRequestId?: string;
};

type PmsReservationHandoffResultBase = {
  contractVersion: PmsReservationContractVersion;
  commandId: string;
  idempotencyKey: string;
  guestBookingId: string;
  pmsReservationRef?: string;
  operationalReservationId?: string;
  externalReference?: PmsExternalReference;
  status?: PmsReservationStatus;
  providerVersion?: string;
  providerRequestId?: string;
  auditEventId: string;
  retryAfter?: PmsUtcDateTime;
};

export type PmsReservationHandoffResult =
  | (PmsReservationHandoffResultBase & {
      outcome: Exclude<PmsReservationHandoffOutcome, "failed">;
      error?: never;
    })
  | (PmsReservationHandoffResultBase & {
      outcome: "failed";
      error: PmsReservationError;
    });

export type PmsReservationSink = {
  createReservation(command: CreatePmsReservationCommand): Promise<PmsReservationHandoffResult>;
  updateReservation(command: UpdatePmsReservationCommand): Promise<PmsReservationHandoffResult>;
  cancelReservation(command: CancelPmsReservationCommand): Promise<PmsReservationHandoffResult>;
};

export type RequireAtLeastOne<T, Keys extends keyof T = keyof T> = Pick<T, Exclude<keyof T, Keys>> &
  {
    [K in Keys]-?: Required<Pick<T, K>> & Partial<Pick<T, Exclude<Keys, K>>>;
  }[Keys];

export type GetPmsOperationalReservationQuery = { propertyId: string } & RequireAtLeastOne<{
  pmsReservationRef?: string;
  operationalReservationId?: string;
  guestBookingId?: string;
}>;

export type ListPmsOperationalReservationsQuery = {
  propertyId: string;
  dateRange: {
    from: PmsDate;
    to: PmsDate;
  };
  statuses?: PmsReservationStatus[];
  roomTypeId?: string;
  roomId?: string;
  source?: "direct_booking" | "channel" | "manual" | "imported";
  limit: number;
  offset: number;
};

export type PmsOperationalReservationReadModel = {
  operationalReservationId?: string;
  pmsReservationRef: string;
  guestBookingId?: string;
  bookingReference?: string;
  propertyId: string;
  provider: PmsProviderKey;
  source: "direct_booking" | "channel" | "manual" | "imported";
  status: PmsReservationStatus;
  stay: {
    checkInDate: PmsDate;
    checkOutDate: PmsDate;
    adults: number;
    children: number;
  };
  assignment: {
    roomTypeId?: string;
    roomTypeName?: string;
    roomId?: string;
    roomNumber?: string;
    assignmentStatus: "unassigned" | "assigned" | "changed";
  };
  guestSummary: {
    displayName: string;
    email?: string | null;
    phone?: string | null;
  };
  financialSummary?: {
    total: PmsMoney;
    paid?: PmsMoney;
    balance?: PmsMoney;
  };
  externalReference?: PmsExternalReference;
  channelReservationRef?: string;
  lastSyncedAt?: PmsUtcDateTime;
  version?: string;
};

export type PmsOperationalReservationListResult = {
  reservations: PmsOperationalReservationReadModel[];
  total: number;
  limit: number;
  offset: number;
};

export type PmsOperationalReservationReadPort = {
  getOperationalReservation(
    query: GetPmsOperationalReservationQuery,
  ): Promise<PmsOperationalReservationReadModel | null>;
  listOperationalReservations(
    query: ListPmsOperationalReservationsQuery,
  ): Promise<PmsOperationalReservationListResult>;
};

export type CanonicalJsonValue =
  | null
  | boolean
  | string
  | number
  | CanonicalJsonValue[]
  | { [key: string]: CanonicalJsonValue };

export type CanonicalizePayloadForIdempotency = (command: unknown) => string;

/**
 * Point-in-time snapshot of the active physical room inventory for a property.
 * Owner: PMS operations.
 * Consumer: Finance billing (fixed-plan fee calculation).
 */
export type RoomInventorySnapshot = {
  propertyId: string;
  /** Count of rooms belonging to active room types at the time of capture. */
  activeRoomCount: number;
  capturedAt: PmsUtcDateTime;
};

/**
 * Read port for querying physical room inventory.
 * Implemented by the PMS adapter; consumed by Finance billing to price
 * fixed-plan subscriptions without opening the PMS database directly.
 */
export type RoomInventoryReadPort = {
  getRoomInventorySnapshot(propertyId: string): Promise<RoomInventorySnapshot | null>;
};
