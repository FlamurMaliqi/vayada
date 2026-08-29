import { pmsOperationsClient, pmsOperationsRequestOptions } from "../api/pmsOperationsClient";
import { propertyEndpoint, resolveSelectedPmsPropertyId } from "../api/pmsPropertyClient";
import { unsupportedPmsNextStackFeature } from "../api/unsupported";
import type { CheckinStepType } from "@/services/settings";

export const HIDDEN_GUEST_CONTACT = "Hidden until you accept";

export interface AssignedRoom {
  assignmentId: string | null;
  roomId: string | null;
  roomNumber: string | null;
  position: number;
  roomTypeId: string;
}

export type AssignmentSelector = { assignmentId: string } | { position: number };

// prettier-ignore
export type BookingExpectedPaymentMethod = "unknown" | "pay_at_property" | "bank_transfer" | "manual_card" | "cash" | "other";

export interface BookingStay {
  position: number;
  roomName: string;
  ratePlanName: string | null;
  roomNumber: string | null;
  checkIn: string | null;
  checkOut: string | null;
  adults: number | null;
  children: number | null;
  nightly: Array<{
    appliedAmount: number | null;
    currency: string | null;
    evidenceQuality: "exact" | "inferred" | "missing";
  }>;
}

export interface Booking {
  id: string;
  bookingReference: string;
  roomTypeId: string;
  roomName: string;
  roomMaxOccupancy: number;
  totalRoomCapacity: number;
  guestFirstName: string;
  guestLastName: string;
  guestEmail: string;
  guestPhone: string;
  guestCountry: string;
  guestCountryRaw: string | null;
  guestCountryReviewRequired: boolean;
  guestGender: string;
  guestDateOfBirth: string | null;
  guestPassportNumber: string;
  specialRequests: string;
  checkIn: string;
  checkOut: string;
  nights: number;
  adults: number;
  children: number;
  nightlyRate: number;
  numberOfRooms: number;
  totalAmount: number;
  depositRequired: boolean;
  depositPercentage: number | null;
  depositAmount: number;
  balanceAmount: number;
  currency: string;
  status:
    | "pending"
    | "confirmed"
    | "checked_in"
    | "in_house"
    | "checked_out"
    | "cancelled"
    | "declined"
    | "expired"
    | "no_show";
  roomId: string | null;
  roomNumber: string | null;
  // VAY-403: every physical room the booking occupies — the primary
  // (position 0) plus any extra rooms of a multi-room reservation.
  assignedRooms: AssignedRoom[];
  stays: BookingStay[];
  channel: string;
  paymentMethod: string | null;
  expectedPaymentMethod: BookingExpectedPaymentMethod;
  paymentStatus: string | null;
  paymentBreakdown?: {
    grossAmount: number;
    stripeFee: number;
    vayadaCommission: number;
    netPayout: number;
    currency: string;
  } | null;
  checkInPendingFlags: string[];
  checkedInAt: string | null;
  checkedOutAt: string | null;
  hostResponseDeadline: string | null;
  platformFeeAmount: number | null;
  affiliateCommissionAmount: number | null;
  propertyPayoutAmount: number | null;
  addonIds: string[];
  addonNames: string[];
  addonTotal: number;
  addonQuantities: Record<string, number>;
  addonDates: Record<string, string[]>;
  estimatedArrivalTime: string | null;
  numberOfGuests: number | null;
  guestWithdrawn: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface BookingAddon {
  id: string;
  name: string;
  description: string;
  price: number;
  currency: string;
  category: string;
  perPerson?: boolean | null;
  perNight?: boolean | null;
}

export interface BookingListResponse {
  bookings: Booking[];
  total: number;
  limit: number;
  offset: number;
}

export type BookingListParams = Record<string, string | number | undefined> & {
  status?: string;
  search?: string;
  limit?: number;
  offset?: number;
};

function commandMetadata(prefix: string): { commandId: string; idempotencyKey: string } {
  const random =
    typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
      ? crypto.randomUUID()
      : `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const commandId = `${prefix}:${random}`;
  return { commandId, idempotencyKey: commandId };
}

function bookingLifecycleCommand(
  action: "accept" | "mark-paid",
  guestBookingId: string,
): { commandId: string; idempotencyKey: string } {
  const commandId = `pms.booking.${action}:${encodeURIComponent(guestBookingId)}:v1`;
  return { commandId, idempotencyKey: commandId };
}

function bookingChangeDecisionCommand(
  decision: "accept" | "decline",
  guestBookingId: string,
  changeRequestId: string,
): { commandId: string; idempotencyKey: string } {
  const commandId = [
    "booking.change",
    decision,
    encodeURIComponent(guestBookingId),
    encodeURIComponent(changeRequestId),
  ].join(":");
  return { commandId, idempotencyKey: commandId };
}

async function reservationEndpoint(guestBookingId: string, suffix = ""): Promise<string> {
  const propertyId = await resolveSelectedPmsPropertyId("updating booking");
  return propertyEndpoint(
    propertyId,
    `reservations/${encodeURIComponent(guestBookingId)}${suffix}`,
  );
}

async function bookingChangeRequestEndpoint(guestBookingId: string): Promise<string> {
  const propertyId = await resolveSelectedPmsPropertyId("reviewing booking changes");
  return `/api/booking/hotels/${encodeURIComponent(propertyId)}/reservations/${encodeURIComponent(guestBookingId)}/change-request`;
}

async function bookingChangeDecisionEndpoint(
  guestBookingId: string,
  changeRequestId: string,
  decision: "accept" | "decline",
): Promise<string> {
  return `${await bookingChangeRequestEndpoint(guestBookingId)}/${encodeURIComponent(changeRequestId)}/${decision}`;
}

type BookingChangeRequestApi = Omit<BookingChangeRequest, "status"> & {
  status: BookingChangeRequest["status"] | "accepted" | "canceled";
};

function normalizeBookingChangeRequest(
  request: BookingChangeRequestApi | null,
): BookingChangeRequest | null {
  if (!request) return null;
  const status =
    request.status === "accepted"
      ? "approved"
      : request.status === "canceled"
        ? "cancelled"
        : request.status;
  return { ...request, status };
}

async function refreshBooking(guestBookingId: string): Promise<Booking> {
  return pmsOperationsBookingsReadService.get(guestBookingId);
}

function findAssignedRoom(
  assignedRooms: AssignedRoom[],
  selector?: AssignmentSelector,
): AssignedRoom | undefined {
  if (!selector) return assignedRooms[0];
  return "assignmentId" in selector
    ? assignedRooms.find((assignment) => assignment.assignmentId === selector.assignmentId)
    : assignedRooms.find((assignment) => assignment.position === selector.position);
}

function toCheckoutCharge(charge: PmsCheckoutCharge, bookingId: string): CheckoutCharge {
  return {
    id: charge.chargeId,
    bookingId,
    label: charge.label,
    amount: moneyAmount(charge.amount),
    originalAmount: moneyAmount(charge.originalAmount),
    status: charge.status === "void" ? "waived" : charge.status,
    createdAt: charge.createdAt,
    settledAt: charge.settledAt,
    waivedAt: charge.waivedAt,
  };
}

function toBookingNote(note: PmsPrivateNote, bookingId: string): BookingNote {
  return {
    id: note.noteId,
    bookingId,
    authorUserId: note.authorUserId ?? "",
    authorName: note.authorDisplayName,
    body: note.body,
    source: "booking-detail",
    createdAt: note.createdAt,
    editedByUserId: note.auditMetadata.editedByUserId,
    editedByName: note.auditMetadata.editedByDisplayName,
    editedAt: note.auditMetadata.editedAt,
  };
}

function toAdditionalGuest(guest: PmsBookingGuestPii, position: number): BookingAdditionalGuest {
  return {
    id: guest.guestId,
    bookingId: guest.guestBookingId,
    position,
    firstName: guest.firstName,
    lastName: guest.lastName,
    gender: "",
    nationality: guest.countryCode ?? "",
    dateOfBirth: null,
    email: guest.email ?? "",
    phone: guest.phone ?? "",
    guestContactHidden:
      guest.email === HIDDEN_GUEST_CONTACT && guest.phone === HIDDEN_GUEST_CONTACT,
    passportNumber: "",
    roomPosition: null,
    createdAt: "",
    updatedAt: "",
  };
}

type PmsOperationsMoney = {
  amountDecimal: string;
  currency: string;
};

type PmsOperationsRoomType = {
  roomTypeId: string;
  name: string;
  occupancyLimits: Record<string, number>;
  baseRate: PmsOperationsMoney;
  ratePlans?: Array<{ ratePlanId: string; name: string }>;
};

type PmsOperationalReservation = {
  guestBookingId: string;
  bookingReference: string;
  status: string;
  source: "direct_booking" | "channel" | "manual" | "migration";
  stay: { checkIn: string; checkOut: string; adults: number; children: number };
  primaryGuest: {
    displayName: string;
    email: string | null;
    phone: string | null;
    countryCode: string | null;
    specialRequests?: string | null;
    countryCodeRaw?: string | null;
    countryCodeReviewRequired?: boolean;
  };
  addOns?: Array<{ addonId: string; name: string; quantity: number }>;
  assignments: Array<{
    assignmentId?: string | null;
    roomTypeId: string;
    roomId: string | null;
    roomNumber: string | null;
    position: number;
    channel: string;
    ratePlanId: string | null;
    stay?: { checkIn: string; checkOut: string; adults: number; children: number };
    nightly?: Array<{
      serviceDate: string;
      applied: PmsOperationsMoney | null;
      evidenceQuality: "exact" | "inferred" | "missing";
    }>;
  }>;
  checkin: { completedAt: string | null; pendingFlags: string[] };
  checkout: { completedAt: string | null; pendingFlags: string[] };
  bookedOffer?: { roomTypeId: string; roomName: string };
  roomCount?: number;
  pricing?: { totalAmount: PmsOperationsMoney; balanceAmount: PmsOperationsMoney };
  payment?: {
    method: string | null;
    expectedMethod?: BookingExpectedPaymentMethod;
    status: string;
    breakdown?: {
      grossAmount: PmsOperationsMoney;
      stripeFee: PmsOperationsMoney;
      vayadaCommission: PmsOperationsMoney;
      netPayout: PmsOperationsMoney;
    };
  };
  hostResponseDeadlineAt?: string | null;
};

type PmsOperationsListResponse<T> = {
  contractVersion: "pms-operations.v1";
  propertyId: string;
  items: T[];
  sourceFreshness: Record<string, string | number | boolean | null>;
};

type PmsOperationsReservationListResponse = PmsOperationsListResponse<PmsOperationalReservation> & {
  pagination: {
    total: number;
    limit: number;
    offset: number;
  };
};

type PmsOperationsReservationDetailResponse = {
  contractVersion: "pms-operations.v1";
  propertyId: string;
  item: PmsOperationalReservation & { additionalGuests?: PmsBookingGuestPii[] };
  sourceFreshness: Record<string, string | number | boolean | null>;
};

type PmsOperationsCommandResponse = {
  contractVersion: "pms-operations.v1";
  propertyId: string;
  reservation: PmsOperationalReservation;
};

type PmsPrimaryGuestNationalityCommandResponse = {
  primaryGuest: PmsBookingGuestPii;
};

type PmsPrivateNote = {
  noteId: string;
  body: string;
  authorUserId: string | null;
  authorDisplayName: string;
  createdAt: string;
  auditMetadata: {
    editedByUserId: string | null;
    editedByDisplayName: string | null;
    editedAt: string | null;
  };
};

type PmsPrivateNotesResponse = {
  items: PmsPrivateNote[];
};

type PmsCheckoutCharge = {
  chargeId: string;
  label: string;
  amount: PmsOperationsMoney;
  originalAmount: PmsOperationsMoney;
  status: "pending" | "paid" | "waived" | "void";
  createdAt: string;
  settledAt: string | null;
  waivedAt: string | null;
};

type PmsCheckoutChargesResponse = {
  items: PmsCheckoutCharge[];
};

type PmsCheckoutChargeCommandResponse = {
  charge: PmsCheckoutCharge;
};

type PmsBookingGuestPii = {
  guestId: string;
  guestBookingId: string;
  displayName: string;
  firstName: string;
  lastName: string;
  email: string | null;
  phone: string | null;
  countryCode: string | null;
  countryCodeRaw: string | null;
  countryCodeReviewRequired: boolean;
};

type PmsAdditionalGuestsResponse = {
  items: PmsBookingGuestPii[];
};

export interface PaymentSettings {
  stripeConnectAccountId: string | null;
  stripeConnectOnboarded: boolean;
  platformFeeType: string;
  platformFeeValue: number;
  platformFeeWithAffiliate: number;
  payAtPropertyEnabled: boolean;
  onlineCardPayment: boolean;
  bankTransfer: boolean;
  xenditPaymentsEnabled: boolean;
  paymentProvider: "stripe" | "xendit" | "vayada";
  xenditChannelCode: string | null;
  xenditAccountNumber: string | null;
  xenditAccountHolderName: string | null;
  defaultCurrency: string;
}

export interface CancellationPolicy {
  freeCancellationDays: number;
  partialRefundPct: number;
}

export interface PaymentSettingsResponse {
  paymentSettings: PaymentSettings;
  cancellationPolicy: CancellationPolicy;
}

export interface BookingNote {
  id: string;
  bookingId: string;
  authorUserId: string;
  authorName: string;
  body: string;
  source: "check-in" | "check-out" | "booking-detail" | null;
  createdAt: string;
  editedByUserId: string | null;
  editedByName: string | null;
  editedAt: string | null;
}

export interface BookingAdditionalGuest {
  id: string;
  bookingId: string;
  position: number;
  firstName: string;
  lastName: string;
  gender: string;
  nationality: string;
  dateOfBirth: string | null;
  email: string;
  phone: string;
  guestContactHidden: boolean;
  passportNumber: string;
  /** Which of the booking's rooms this guest is assigned to.
   * 0 = primary room, 1..N-1 = extras, null = unassigned. */
  roomPosition: number | null;
  createdAt: string;
  updatedAt: string;
}

export type BookingAdditionalGuestPayload = Partial<
  Omit<
    BookingAdditionalGuest,
    "id" | "bookingId" | "position" | "createdAt" | "updatedAt" | "guestContactHidden"
  >
>;

export interface BookingChangeRequest {
  id: string;
  bookingId: string;
  status: "pending" | "approved" | "declined" | "cancelled";
  oldCheckIn: string;
  oldCheckOut: string;
  oldAddonIds: string[];
  oldAddonQuantities: Record<string, number>;
  oldAddonDates: Record<string, string[]>;
  oldTotal: number;
  requestedCheckIn: string;
  requestedCheckOut: string;
  requestedAddonIds: string[];
  requestedAddonQuantities: Record<string, number>;
  requestedAddonDates: Record<string, string[]>;
  requestedAddonNames: string[];
  newTotal: number;
  priceDifference: number;
  currency: string;
  declineReason: string | null;
  decidedAt: string | null;
  createdAt: string;
}

export interface CheckinStepResult {
  stepId: string;
  label: string;
  type: CheckinStepType;
  value: string | number | boolean | null;
  completedAt: string | null;
}

export interface CheckinPendingFlag {
  stepId: string;
  label: string;
}

export type CheckoutInspectionStatus = "ok" | "issue" | "neutral";

export interface CheckoutInspectionResult {
  stepId: string;
  label: string;
  status: CheckoutInspectionStatus;
  note: string | null;
  completedAt: string | null;
}

export interface CheckoutCharge {
  id: string;
  bookingId: string;
  label: string;
  amount: number;
  originalAmount: number;
  status: "pending" | "paid" | "waived";
  createdAt: string;
  settledAt: string | null;
  waivedAt: string | null;
}

export interface CheckoutRecord {
  id: string;
  bookingId: string;
  completedAt: string;
  completedBy: string | null;
  inspectionResults: CheckoutInspectionResult[];
  chargesSettled: CheckoutCharge[];
  pendingFlags: CheckoutInspectionResult[];
  checkoutNotes: string | null;
}

export const bookingsService = {
  list: async (params?: BookingListParams) => {
    return pmsOperationsBookingsReadService.list(params);
  },

  listAll: async (params?: Omit<BookingListParams, "limit" | "offset">) => {
    const limit = 500;
    let offset = 0;
    const bookings: Booking[] = [];

    while (true) {
      const page = await bookingsService.list({ ...params, limit, offset });
      bookings.push(...page.bookings);

      if (bookings.length >= page.total || page.bookings.length < limit) {
        return bookings;
      }

      offset += page.bookings.length;
    }
  },

  get: async (id: string) => {
    return pmsOperationsBookingsReadService.get(id);
  },

  correctPrimaryGuestNationality: async (id: string, countryCode: string) => {
    const response = await pmsOperationsClient.patch<PmsPrimaryGuestNationalityCommandResponse>(
      await reservationEndpoint(id, "/primary-guest/nationality"),
      { ...commandMetadata("pms.primary-guest.nationality.correct"), countryCode },
      pmsOperationsRequestOptions,
    );
    return {
      guestCountry: response.primaryGuest.countryCode ?? "",
      guestCountryRaw: response.primaryGuest.countryCodeRaw,
      guestCountryReviewRequired: response.primaryGuest.countryCodeReviewRequired,
    };
  },

  update: (
    _id: string,
    _data: Partial<{
      checkIn: string;
      checkOut: string;
      guestFirstName: string;
      guestLastName: string;
      guestEmail: string;
      guestPhone: string;
      guestCountry: string;
      guestGender: string;
      guestDateOfBirth: string | null;
      guestPassportNumber: string;
      adults: number;
      children: number;
      nightlyRate: number;
      addonIds: string[];
      addonQuantities: Record<string, number>;
      addonDates: Record<string, string[]>;
      specialRequests: string;
    }>,
  ) => unsupportedPmsNextStackFeature<Booking>("Booking detail updates"),

  updateStatus: (id: string, status: "confirmed" | "cancelled") =>
    status === "confirmed"
      ? bookingsService.acceptBooking(id)
      : unsupportedPmsNextStackFeature<Booking>("Booking cancellation"),

  completeCheckIn: async (
    id: string,
    pendingFlags: string[],
    stepResults: CheckinStepResult[] = [],
    pendingFlagDetails: CheckinPendingFlag[] = [],
  ) => {
    await pmsOperationsClient.post<PmsOperationsCommandResponse>(
      await reservationEndpoint(id, "/check-in"),
      {
        ...commandMetadata("pms.check-in"),
        pendingFlags,
        stepResults,
        pendingFlagDetails,
      },
      pmsOperationsRequestOptions,
    );
    return refreshBooking(id);
  },

  listCheckoutCharges: async (id: string) => {
    const response = await pmsOperationsClient.get<PmsCheckoutChargesResponse>(
      await reservationEndpoint(id, "/checkout-charges"),
      pmsOperationsRequestOptions,
    );
    return { charges: response.items.map((charge) => toCheckoutCharge(charge, id)) };
  },

  addCheckoutCharge: async (id: string, label: string, amount: number) => {
    const response = await pmsOperationsClient.post<PmsCheckoutChargeCommandResponse>(
      await reservationEndpoint(id, "/checkout-charges"),
      {
        ...commandMetadata("pms.checkout-charge.create"),
        label,
        amountDecimal: amount.toFixed(2),
        currency: "EUR",
      },
      pmsOperationsRequestOptions,
    );
    return toCheckoutCharge(response.charge, id);
  },

  markCheckoutChargePaid: async (id: string, chargeId: string) => {
    const response = await pmsOperationsClient.post<PmsCheckoutChargeCommandResponse>(
      await reservationEndpoint(id, `/checkout-charges/${encodeURIComponent(chargeId)}/paid`),
      commandMetadata("pms.checkout-charge.paid"),
      pmsOperationsRequestOptions,
    );
    return toCheckoutCharge(response.charge, id);
  },

  waiveCheckoutCharge: async (id: string, chargeId: string) => {
    const response = await pmsOperationsClient.post<PmsCheckoutChargeCommandResponse>(
      await reservationEndpoint(id, `/checkout-charges/${encodeURIComponent(chargeId)}/waive`),
      commandMetadata("pms.checkout-charge.waive"),
      pmsOperationsRequestOptions,
    );
    return toCheckoutCharge(response.charge, id);
  },

  getCheckoutRecord: (_id: string) =>
    unsupportedPmsNextStackFeature<CheckoutRecord | null>("Checkout record reads"),

  completeCheckOut: async (
    id: string,
    inspectionResults: CheckoutInspectionResult[],
    pendingFlags: CheckoutInspectionResult[],
    checkoutNotes?: string,
  ) => {
    await pmsOperationsClient.post<PmsOperationsCommandResponse>(
      await reservationEndpoint(id, "/check-out"),
      {
        ...commandMetadata("pms.check-out"),
        inspectionResults,
        pendingFlags: pendingFlags.map((flag) => flag.stepId),
        chargesSettled: [],
        checkoutNotes,
      },
      pmsOperationsRequestOptions,
    );
    return refreshBooking(id);
  },

  markPaid: async (id: string) => {
    await pmsOperationsClient.post<PmsOperationsCommandResponse>(
      await reservationEndpoint(id, "/mark-paid"),
      bookingLifecycleCommand("mark-paid", id),
      pmsOperationsRequestOptions,
    );
    return refreshBooking(id);
  },

  addArrivalCharge: (_id: string, _amount: number, _description?: string) =>
    unsupportedPmsNextStackFeature<Booking>("Arrival charges"),

  acceptBooking: async (id: string) => {
    await pmsOperationsClient.post<PmsOperationsCommandResponse>(
      await reservationEndpoint(id, "/accept"),
      bookingLifecycleCommand("accept", id),
      pmsOperationsRequestOptions,
    );
    return refreshBooking(id);
  },

  rejectBooking: (_id: string, _reason?: string) =>
    unsupportedPmsNextStackFeature<Booking>("Booking rejection"),

  assignRoom: async (id: string, roomId: string) => {
    await pmsOperationsClient.patch<PmsOperationsCommandResponse>(
      await reservationEndpoint(id, "/assignments"),
      { ...commandMetadata("pms.assignment.assign"), action: "assign", roomId },
      pmsOperationsRequestOptions,
    );
    return refreshBooking(id);
  },

  moveRoom: async (
    id: string,
    roomId: string,
    sourceAssignmentSelector?: AssignmentSelector,
    ratePolicy: "preserve" | "target_base" = "preserve",
  ) => {
    const booking = await refreshBooking(id);
    const sourceAssignment = findAssignedRoom(booking.assignedRooms, sourceAssignmentSelector);
    if (sourceAssignmentSelector && !sourceAssignment) {
      return unsupportedPmsNextStackFeature<Booking>(
        "Multi-room moves without assignment identity",
      );
    }

    await pmsOperationsClient.patch<PmsOperationsCommandResponse>(
      await reservationEndpoint(id, "/assignments"),
      {
        ...commandMetadata("pms.assignment.move"),
        action: "move",
        roomId,
        ...(sourceAssignment
          ? sourceAssignment.assignmentId
            ? { assignmentId: sourceAssignment.assignmentId }
            : { position: sourceAssignment.position + 1 }
          : {}),
        ...(ratePolicy === "target_base" ? { ratePolicy } : {}),
      },
      pmsOperationsRequestOptions,
    );
    return refreshBooking(id);
  },

  swapRoom: (_id: string, _partnerBookingId: string, _partnerDestinationRoomId?: string) =>
    unsupportedPmsNextStackFeature<Booking>("Room swaps"),

  unassignRoom: async (id: string, sourceAssignmentSelector?: AssignmentSelector) => {
    const booking = await refreshBooking(id);
    const sourceAssignment = findAssignedRoom(booking.assignedRooms, sourceAssignmentSelector);
    if (sourceAssignmentSelector && !sourceAssignment) {
      return unsupportedPmsNextStackFeature<Booking>(
        "Multi-room unassign without assignment identity",
      );
    }
    await pmsOperationsClient.patch<PmsOperationsCommandResponse>(
      await reservationEndpoint(id, "/assignments"),
      {
        ...commandMetadata("pms.assignment.unassign"),
        action: "unassign",
        roomId: null,
        ...(sourceAssignment
          ? sourceAssignment.assignmentId
            ? { assignmentId: sourceAssignment.assignmentId }
            : { position: sourceAssignment.position + 1 }
          : {}),
      },
      pmsOperationsRequestOptions,
    );
    return refreshBooking(id);
  },

  getPaymentSettings: async () => {
    const propertyId = await resolveSelectedPmsPropertyId("loading payment settings");
    return pmsOperationsClient.get<PaymentSettingsResponse>(
      propertyEndpoint(propertyId, "payment-settings"),
      pmsOperationsRequestOptions,
    );
  },

  updatePaymentSettings: (_data: Partial<PaymentSettings>) =>
    unsupportedPmsNextStackFeature("Payment settings updates"),

  updateCancellationPolicy: (_data: Partial<CancellationPolicy>) =>
    unsupportedPmsNextStackFeature("Cancellation policy updates"),

  createStripeAccount: (_email: string, _country: string) =>
    unsupportedPmsNextStackFeature<{ accountId: string }>("Stripe account creation"),

  getStripeOnboardingLink: () =>
    unsupportedPmsNextStackFeature<{ url: string }>("Stripe onboarding links"),

  // Guest-initiated booking change requests (VAY-379)
  getChangeRequest: async (id: string) =>
    normalizeBookingChangeRequest(
      await pmsOperationsClient.get<BookingChangeRequestApi | null>(
        await bookingChangeRequestEndpoint(id),
        pmsOperationsRequestOptions,
      ),
    ),

  approveChangeRequest: async (id: string, changeRequestId: string) => {
    const command = bookingChangeDecisionCommand("accept", id, changeRequestId);
    const response = await pmsOperationsClient.post<BookingChangeRequestApi>(
      await bookingChangeDecisionEndpoint(id, changeRequestId, "accept"),
      command,
      {
        ...pmsOperationsRequestOptions,
        headers: {
          ...(pmsOperationsRequestOptions.headers as Record<string, string>),
          "Idempotency-Key": command.idempotencyKey,
        },
      },
    );
    return normalizeBookingChangeRequest(response)!;
  },

  declineChangeRequest: async (id: string, changeRequestId: string, reason?: string) => {
    const command = bookingChangeDecisionCommand("decline", id, changeRequestId);
    const response = await pmsOperationsClient.post<BookingChangeRequestApi>(
      await bookingChangeDecisionEndpoint(id, changeRequestId, "decline"),
      { ...command, reason },
      {
        ...pmsOperationsRequestOptions,
        headers: {
          ...(pmsOperationsRequestOptions.headers as Record<string, string>),
          "Idempotency-Key": command.idempotencyKey,
        },
      },
    );
    return normalizeBookingChangeRequest(response)!;
  },

  // VAY-495 booking detail — internal notes, additional guests, cancel-with-reason.
  listNotes: async (id: string) => {
    const response = await pmsOperationsClient.get<PmsPrivateNotesResponse>(
      await reservationEndpoint(id, "/notes"),
      pmsOperationsRequestOptions,
    );
    return { notes: response.items.map((note) => toBookingNote(note, id)) };
  },

  createNote: async (id: string, body: string, _source?: BookingNote["source"]) => {
    const response = await pmsOperationsClient.post<{ note: PmsPrivateNote }>(
      await reservationEndpoint(id, "/notes"),
      { ...commandMetadata("pms.note.create"), body },
      pmsOperationsRequestOptions,
    );
    return toBookingNote(response.note, id);
  },

  updateNote: async (id: string, noteId: string, body: string) => {
    const response = await pmsOperationsClient.patch<{ note: PmsPrivateNote }>(
      await reservationEndpoint(id, `/notes/${encodeURIComponent(noteId)}`),
      { ...commandMetadata("pms.note.update"), body },
      pmsOperationsRequestOptions,
    );
    return toBookingNote(response.note, id);
  },

  deleteNote: async (id: string, noteId: string) => {
    await pmsOperationsClient.delete<void>(await reservationEndpoint(id, `/notes/${noteId}`), {
      ...pmsOperationsRequestOptions,
      body: JSON.stringify(commandMetadata("pms.note.delete")),
    });
  },

  listAdditionalGuests: async (id: string) => {
    const response = await pmsOperationsClient.get<PmsAdditionalGuestsResponse>(
      await reservationEndpoint(id, "/additional-guests"),
      pmsOperationsRequestOptions,
    );
    return { guests: response.items.map(toAdditionalGuest) };
  },

  listAvailableAddons: (_id: string) =>
    unsupportedPmsNextStackFeature<BookingAddon[]>("Booking add-ons"),

  createAdditionalGuest: async (id: string, data: BookingAdditionalGuestPayload) => {
    const response = await pmsOperationsClient.post<{ additionalGuest: PmsBookingGuestPii }>(
      await reservationEndpoint(id, "/additional-guests"),
      {
        ...commandMetadata("pms.additional-guest.create"),
        guest: toPmsAdditionalGuestPayload(data, { requireNames: true }),
      },
      pmsOperationsRequestOptions,
    );
    return toAdditionalGuest(response.additionalGuest, 0);
  },

  updateAdditionalGuest: async (
    id: string,
    guestId: string,
    data: BookingAdditionalGuestPayload,
  ) => {
    const response = await pmsOperationsClient.patch<{ additionalGuest: PmsBookingGuestPii }>(
      await reservationEndpoint(id, `/additional-guests/${encodeURIComponent(guestId)}`),
      {
        ...commandMetadata("pms.additional-guest.update"),
        guest: toPmsAdditionalGuestPayload(data),
      },
      pmsOperationsRequestOptions,
    );
    return toAdditionalGuest(response.additionalGuest, 0);
  },

  deleteAdditionalGuest: async (id: string, guestId: string) => {
    await pmsOperationsClient.delete<void>(
      await reservationEndpoint(id, `/additional-guests/${encodeURIComponent(guestId)}`),
      {
        ...pmsOperationsRequestOptions,
        body: JSON.stringify(commandMetadata("pms.additional-guest.delete")),
      },
    );
  },

  cancelWithReason: (_id: string, _reason: string) =>
    unsupportedPmsNextStackFeature<Booking>("Booking cancellation"),

  markNoShow: async (id: string) => {
    await pmsOperationsClient.post<PmsOperationsCommandResponse>(
      await reservationEndpoint(id, "/no-show"),
      commandMetadata("pms.no-show"),
      pmsOperationsRequestOptions,
    );
    return refreshBooking(id);
  },
};

const pmsOperationsBookingsReadService = {
  list: async (params?: BookingListParams): Promise<BookingListResponse> => {
    const propertyId = await resolveSelectedPmsPropertyId("loading bookings");
    const query = buildPmsReservationsQuery(params);
    const [reservations, roomTypes] = await Promise.all([
      pmsOperationsClient.get<PmsOperationsReservationListResponse>(
        `${propertyEndpoint(propertyId, "reservations")}${query}`,
        pmsOperationsRequestOptions,
      ),
      pmsOperationsClient.get<PmsOperationsListResponse<PmsOperationsRoomType>>(
        propertyEndpoint(propertyId, "room-types"),
        pmsOperationsRequestOptions,
      ),
    ]);
    const roomTypesById = new Map(
      roomTypes.items.map((roomType) => [roomType.roomTypeId, roomType]),
    );
    return {
      bookings: reservations.items.map((reservation) => toBooking(reservation, roomTypesById)),
      total: reservations.pagination.total,
      limit: reservations.pagination.limit,
      offset: reservations.pagination.offset,
    };
  },

  get: async (id: string): Promise<Booking> => {
    const propertyId = await resolveSelectedPmsPropertyId("loading booking details");
    const [reservation, roomTypes] = await Promise.all([
      pmsOperationsClient.get<PmsOperationsReservationDetailResponse>(
        propertyEndpoint(propertyId, `reservations/${encodeURIComponent(id)}`),
        pmsOperationsRequestOptions,
      ),
      pmsOperationsClient.get<PmsOperationsListResponse<PmsOperationsRoomType>>(
        propertyEndpoint(propertyId, "room-types"),
        pmsOperationsRequestOptions,
      ),
    ]);
    const roomTypesById = new Map(
      roomTypes.items.map((roomType) => [roomType.roomTypeId, roomType]),
    );
    return toBooking(reservation.item, roomTypesById);
  },
};

function buildPmsReservationsQuery(params?: BookingListParams): string {
  const query = new URLSearchParams();
  appendQueryParam(query, "status", params?.status);
  appendQueryParam(query, "search", params?.search);
  appendQueryParam(query, "limit", params?.limit);
  appendQueryParam(query, "offset", params?.offset);
  const serialized = query.toString();
  return serialized ? `?${serialized}` : "";
}

function appendQueryParam(
  query: URLSearchParams,
  key: string,
  value: string | number | undefined,
): void {
  if (value === undefined || value === "") return;
  query.set(key, String(value));
}

function toBooking(
  reservation: PmsOperationalReservation,
  roomTypesById: Map<string, PmsOperationsRoomType>,
): Booking {
  const primaryAssignment = reservation.assignments[0] ?? null;
  const roomTypeId = primaryAssignment?.roomTypeId ?? reservation.bookedOffer?.roomTypeId ?? "";
  const roomType = roomTypesById.get(roomTypeId);
  const numberOfRooms = Math.max(reservation.roomCount ?? reservation.assignments.length, 1);
  const nights = daysBetweenDateOnly(reservation.stay.checkIn, reservation.stay.checkOut);
  const baseRate = moneyAmount(roomType?.baseRate);
  const totalAmount = reservation.pricing
    ? moneyAmount(reservation.pricing.totalAmount)
    : baseRate * Math.max(nights, 1) * numberOfRooms;
  const nightlyRate = roomType ? baseRate : totalAmount / Math.max(nights, 1) / numberOfRooms;
  const [guestFirstName, guestLastName] = splitGuestName(reservation.primaryGuest.displayName);
  const addOns = reservation.addOns ?? [];
  // prettier-ignore
  const capacities = reservation.assignments.map((assignment) => maxOccupancy(roomTypesById.get(assignment.roomTypeId)));
  const knownCapacity = capacities.reduce((sum, capacity) => sum + capacity, 0);
  const roomTypeCapacity = maxOccupancy(roomType);
  // prettier-ignore
  const totalRoomCapacity = (numberOfRooms === 1 && roomTypeCapacity > 0) || (capacities.length === numberOfRooms && capacities.every(Boolean)) ? knownCapacity || roomTypeCapacity : Math.max(knownCapacity || roomTypeCapacity, reservation.stay.adults + reservation.stay.children);

  return {
    id: reservation.guestBookingId,
    bookingReference: reservation.bookingReference,
    roomTypeId,
    roomName: roomType?.name || reservation.bookedOffer?.roomName || "",
    roomMaxOccupancy: maxOccupancy(roomType),
    totalRoomCapacity,
    guestFirstName,
    guestLastName,
    guestEmail: reservation.primaryGuest.email ?? "",
    guestPhone: reservation.primaryGuest.phone ?? "",
    guestCountry: reservation.primaryGuest.countryCode ?? "",
    guestCountryRaw: reservation.primaryGuest.countryCodeRaw ?? null,
    guestCountryReviewRequired: reservation.primaryGuest.countryCodeReviewRequired === true,
    guestGender: "",
    guestDateOfBirth: null,
    guestPassportNumber: "",
    specialRequests: reservation.primaryGuest.specialRequests ?? "",
    checkIn: reservation.stay.checkIn,
    checkOut: reservation.stay.checkOut,
    nights,
    adults: reservation.stay.adults,
    children: reservation.stay.children,
    nightlyRate,
    numberOfRooms,
    totalAmount,
    depositRequired: false,
    depositPercentage: null,
    depositAmount: 0,
    balanceAmount: reservation.pricing
      ? moneyAmount(reservation.pricing.balanceAmount)
      : totalAmount,
    currency: reservation.pricing?.totalAmount.currency ?? roomType?.baseRate.currency ?? "EUR",
    status: toBookingStatus(reservation.status),
    roomId: primaryAssignment?.roomId ?? null,
    roomNumber: primaryAssignment?.roomNumber ?? null,
    assignedRooms: reservation.assignments.map((assignment) => ({
      assignmentId: assignment.assignmentId ?? null,
      roomId: assignment.roomId,
      roomNumber: assignment.roomNumber,
      position: Math.max(assignment.position - 1, 0),
      roomTypeId: assignment.roomTypeId,
    })),
    stays: reservation.assignments.map((assignment) => {
      const assignmentRoomType = roomTypesById.get(assignment.roomTypeId);
      const ratePlan = assignmentRoomType?.ratePlans?.find(
        (plan) => plan.ratePlanId === assignment.ratePlanId,
      );
      return {
        position: Math.max(assignment.position - 1, 0),
        roomName: assignmentRoomType?.name ?? "",
        ratePlanName: ratePlan?.name ?? null,
        roomNumber: assignment.roomNumber,
        checkIn: assignment.stay?.checkIn ?? null,
        checkOut: assignment.stay?.checkOut ?? null,
        adults: assignment.stay?.adults ?? null,
        children: assignment.stay?.children ?? null,
        nightly: (assignment.nightly ?? []).map((night) => ({
          appliedAmount: night.applied ? moneyAmount(night.applied) : null,
          currency: night.applied?.currency ?? null,
          evidenceQuality: night.evidenceQuality,
        })),
      };
    }),
    channel:
      reservation.source === "manual"
        ? "manual"
        : (primaryAssignment?.channel ?? reservationSource(reservation.source)),
    paymentMethod: reservation.payment?.method ?? null,
    expectedPaymentMethod: reservation.payment?.expectedMethod ?? "unknown",
    paymentStatus: reservation.payment?.status ?? null,
    paymentBreakdown: toPaymentBreakdown(reservation.payment?.breakdown),
    checkInPendingFlags: reservation.checkin.pendingFlags,
    checkedInAt: reservation.checkin.completedAt,
    checkedOutAt: reservation.checkout.completedAt,
    hostResponseDeadline: reservation.hostResponseDeadlineAt ?? null,
    platformFeeAmount: null,
    affiliateCommissionAmount: null,
    propertyPayoutAmount: null,
    addonIds: addOns.map(({ addonId }) => addonId),
    addonNames: addOns.map(({ name }) => name),
    addonTotal: 0,
    addonQuantities: Object.fromEntries(addOns.map(({ addonId, quantity }) => [addonId, quantity])),
    addonDates: {},
    estimatedArrivalTime: null,
    numberOfGuests: reservation.stay.adults + reservation.stay.children,
    guestWithdrawn: false,
    createdAt: `${reservation.stay.checkIn}T00:00:00.000Z`,
    updatedAt: `${reservation.stay.checkIn}T00:00:00.000Z`,
  };
}

function toPaymentBreakdown(
  breakdown: NonNullable<PmsOperationalReservation["payment"]>["breakdown"],
): Booking["paymentBreakdown"] {
  if (!breakdown) return null;
  const currency = breakdown.grossAmount.currency;
  if (
    !currency ||
    [breakdown.stripeFee, breakdown.vayadaCommission, breakdown.netPayout].some(
      (amount) => amount.currency !== currency,
    )
  ) {
    return null;
  }
  return {
    grossAmount: moneyAmount(breakdown.grossAmount),
    stripeFee: moneyAmount(breakdown.stripeFee),
    vayadaCommission: moneyAmount(breakdown.vayadaCommission),
    netPayout: moneyAmount(breakdown.netPayout),
    currency,
  };
}

function toPmsAdditionalGuestPayload(
  data: BookingAdditionalGuestPayload,
  options: { requireNames?: boolean } = {},
): Record<string, string | null> {
  if ("roomPosition" in data) {
    throw new Error("Additional guest room assignment is not available on PMS next-stack yet.");
  }

  const payload: Record<string, string | null> = {};
  if (data.firstName !== undefined) payload.firstName = data.firstName;
  if (data.lastName !== undefined) payload.lastName = data.lastName;
  if (data.email !== undefined) payload.email = data.email || null;
  if (data.phone !== undefined) payload.phone = data.phone || null;
  if (data.nationality !== undefined) payload.countryCode = data.nationality || null;
  if (options.requireNames && (!payload.firstName || !payload.lastName)) {
    throw new Error("Additional guest creation requires first and last name on PMS next-stack.");
  }
  if (!options.requireNames && Object.keys(payload).length === 0) {
    throw new Error("Additional guest updates require a supported guest field.");
  }

  return payload;
}

function splitGuestName(displayName: string): [string, string] {
  const parts = displayName.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return ["", ""];
  const [firstName, ...rest] = parts;
  return [firstName, rest.join(" ")];
}

function daysBetweenDateOnly(from: string, to: string): number {
  const start = Date.parse(`${from}T00:00:00.000Z`);
  const end = Date.parse(`${to}T00:00:00.000Z`);
  if (!Number.isFinite(start) || !Number.isFinite(end)) return 1;
  return Math.max(1, Math.round((end - start) / 86_400_000));
}

function moneyAmount(money: PmsOperationsMoney | undefined): number {
  const amount = Number.parseFloat(money?.amountDecimal ?? "0");
  return Number.isFinite(amount) ? amount : 0;
}

function maxOccupancy(roomType: PmsOperationsRoomType | undefined): number {
  if (!roomType) return 0;
  const total = roomType.occupancyLimits.total;
  if (typeof total === "number") return total;
  return Object.values(roomType.occupancyLimits).reduce((sum, value) => sum + value, 0);
}

function reservationSource(source: PmsOperationalReservation["source"]): string {
  return source === "direct_booking" ? "direct" : source;
}

function toBookingStatus(status: string): Booking["status"] {
  switch (status) {
    case "pending":
    case "pending_payment":
      return "pending";
    case "confirmed":
    case "checked_in":
    case "in_house":
    case "checked_out":
    case "declined":
    case "expired":
    case "no_show":
      return status;
    case "canceled":
    case "cancelled":
      return "cancelled";
    default:
      return "confirmed";
  }
}
