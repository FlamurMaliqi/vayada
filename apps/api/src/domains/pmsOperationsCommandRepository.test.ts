import { createHash } from "node:crypto";
import type { QueryResult, QueryResultRow } from "pg";
import { describe, expect, it, vi } from "vitest";

import {
  createTargetPmsOperationsCommandRepository,
  type PmsOperationsCommandClient,
  type PmsOperationsCommandPool,
} from "./pmsOperationsCommandRepository.js";
import type { PmsOperationsReadRepository } from "./pmsOperationsReadModel.js";
import type { StripeBookingPaymentProvider } from "./stripeBookingPayments.js";
import type {
  PmsAssignmentCommand,
  PmsBookingLifecycleCommand,
  PmsCheckInCommand,
  PmsCheckOutCommand,
  PmsCheckOutRecord,
  PmsCommandMeta,
  PmsManualCancellationCommand,
  PmsNoShowCommand,
  PmsOperationalReservation,
  PmsOperationalStatusCommand,
} from "../routes/pmsOperations.js";

const propertyId = "f6853000-0000-0000-0000-000000000001";
const guestBookingId = "f6854000-0000-0000-0000-000000000001";
const assignmentOneId = "f6855500-0000-0000-0000-000000000001";
const assignmentTwoId = "f6855500-0000-0000-0000-000000000002";
const roomTypeId = "f6855000-0000-0000-0000-000000000001";
const userId = "f6851000-0000-0000-0000-000000000001";
const organizationId = "f6852000-0000-0000-0000-000000000001";

function requestCardIntent(status: string) {
  return {
    paymentIntentId: "pi_request_card",
    clientSecret: null,
    status,
    amountMinor: 60_000,
    currency: "EUR",
    propertyId,
    bookingReference: "BK-REQUEST-CARD",
    providerAccountRef: "acct_request_card",
  };
}

const directRevenueFields = {
  sourceSystem: "booking",
  bookingMetadata: {
    requestFingerprint: "a".repeat(64),
    selectedOffer: {
      roomTypeId: assignmentOneId,
      nightlyRoomAmounts: [20, 21, 22].map((day) => ({
        stayDate: `2026-08-${day}`,
        grossRoomAmount: "200",
      })),
    },
  },
};

type RecordedQuery = {
  text: string;
  values: readonly unknown[];
};

type QueryHandler = (
  text: string,
  values: readonly unknown[],
) => Pick<QueryResult<QueryResultRow>, "rows" | "rowCount">;

class RecordingCommandClient implements PmsOperationsCommandClient {
  readonly calls: RecordedQuery[] = [];

  constructor(private readonly handler: QueryHandler) {}

  async query<T extends QueryResultRow = QueryResultRow>(
    text: string,
    values: readonly unknown[] = [],
  ): Promise<Pick<QueryResult<T>, "rows" | "rowCount">> {
    this.calls.push({ text, values });
    const result = this.handler(text, values);
    return result as Pick<QueryResult<T>, "rows" | "rowCount">;
  }

  release(): void {}
}

function createRecordingPool(handler: QueryHandler): {
  client: RecordingCommandClient;
  pool: PmsOperationsCommandPool;
} {
  const client = new RecordingCommandClient(handler);
  return {
    client,
    pool: {
      async connect() {
        return client;
      },
      async end() {},
    },
  };
}

function ok(
  rows: QueryResultRow[] = [],
  rowCount = rows.length,
): Pick<QueryResult<QueryResultRow>, "rows" | "rowCount"> {
  return { rows, rowCount };
}

const baseReservation: PmsOperationalReservation = {
  guestBookingId,
  bookingReference: "BK-001",
  status: "assigned",
  source: "direct_booking",
  stay: { checkIn: "2026-08-15", checkOut: "2026-08-18", adults: 2, children: 0 },
  primaryGuest: {
    displayName: "Alex Guest",
    email: null,
    phone: null,
    countryCode: null,
    specialRequests: null,
  },
  addOns: [],
  assignments: [
    {
      assignmentId: assignmentOneId,
      roomTypeId: "f6855000-0000-0000-0000-000000000001",
      ratePlanId: null,
      roomId: "f6855100-0000-0000-0000-000000000001",
      roomNumber: "101",
      position: 1,
      assignmentStatus: "assigned",
      channel: "direct",
      assignedAt: "2026-08-14T16:00:00.000Z",
    },
    {
      assignmentId: assignmentTwoId,
      roomTypeId: "f6855000-0000-0000-0000-000000000001",
      ratePlanId: null,
      roomId: "f6855100-0000-0000-0000-000000000002",
      roomNumber: "102",
      position: 2,
      assignmentStatus: "assigned",
      channel: "direct",
      assignedAt: "2026-08-14T16:00:00.000Z",
    },
  ],
  checkin: { completedAt: null, pendingFlags: [] },
  checkout: { completedAt: null, pendingFlags: [] },
  privateNoteCount: 0,
  additionalGuestCount: 0,
};

const readRepository: PmsOperationsReadRepository = {
  async listRoomsByPropertyId() {
    return { items: [] };
  },
  async listRoomTypesByPropertyId() {
    return { items: [] };
  },
  async findRoomTypeById() {
    return null;
  },
  async listCalendarDaysByPropertyId() {
    return { items: [] };
  },
  async listRoomBlocksByPropertyId() {
    return { items: [] };
  },
  async listReservationsByPropertyId() {
    return { items: [], total: 0 };
  },
  async findReservationByGuestBookingId(_propertyId, _guestBookingId, canReadGuestContact) {
    expect(canReadGuestContact).toBe(true);
    return structuredClone(baseReservation);
  },
};

function assignmentRows(status = "assigned"): QueryResultRow[] {
  return [
    {
      assignmentId: assignmentOneId,
      guestBookingId,
      roomTypeId: "f6855000-0000-0000-0000-000000000001",
      roomId: "f6855100-0000-0000-0000-000000000001",
      position: 1,
      assignmentStatus: status,
      version: "reservation-v7",
      updatedAt: "2026-08-14T16:00:00.000Z",
      checkIn: "2026-08-15",
      checkOut: "2026-08-18",
    },
    {
      assignmentId: assignmentTwoId,
      guestBookingId,
      roomTypeId: "f6855000-0000-0000-0000-000000000001",
      roomId: "f6855100-0000-0000-0000-000000000002",
      position: 2,
      assignmentStatus: status,
      version: "reservation-v7",
      updatedAt: "2026-08-14T16:00:00.000Z",
      checkIn: "2026-08-15",
      checkOut: "2026-08-18",
    },
  ];
}

function baseCheckInCommand(overrides: Partial<PmsCheckInCommand> = {}): PmsCheckInCommand {
  return {
    propertyId,
    guestBookingId,
    commandId: "cmd-checkin-001",
    idempotencyKey: "pms-checkin-001",
    expectedVersion: "reservation-v7",
    stepResults: [{ stepId: "passport", status: "completed" }],
    pendingFlags: ["deposit_review"],
    audit: {
      actor: { kind: "user", userId, organizationId },
      requestId: "req-checkin-001",
      correlationId: "corr-checkin-001",
      reason: "Check in guest",
      requestedAt: "2026-08-15T15:45:00.000Z",
    },
    ...overrides,
  };
}

function baseAssignmentCommand(
  overrides: Partial<PmsAssignmentCommand> = {},
): PmsAssignmentCommand {
  return {
    propertyId,
    guestBookingId,
    commandId: "cmd-assignment-001",
    idempotencyKey: "pms-assignment-001",
    expectedVersion: "reservation-v7",
    action: "assign",
    assignmentId: assignmentOneId,
    roomId: "f6855100-0000-0000-0000-000000000003",
    ...overrides,
  };
}

function baseStatusCommand(
  overrides: Partial<PmsOperationalStatusCommand> = {},
): PmsOperationalStatusCommand {
  return {
    propertyId,
    guestBookingId,
    commandId: "cmd-status-001",
    idempotencyKey: "pms-status-001",
    expectedVersion: "reservation-v7",
    status: "in_house",
    audit: {
      actor: { kind: "user", userId, organizationId },
      requestId: "req-status-001",
      correlationId: "corr-status-001",
      reason: "Update PMS status",
      requestedAt: "2026-08-15T15:45:00.000Z",
    },
    ...overrides,
  };
}

function baseNoShowCommand(overrides: Partial<PmsNoShowCommand> = {}): PmsNoShowCommand {
  return {
    propertyId,
    guestBookingId,
    commandId: "cmd-no-show-001",
    idempotencyKey: "pms-no-show-001",
    expectedVersion: "reservation-v7",
    reason: "guest did not arrive",
    audit: {
      actor: { kind: "user", userId, organizationId },
      requestId: "req-no-show-001",
      correlationId: "corr-no-show-001",
      reason: "Mark reservation no-show",
      requestedAt: "2026-08-15T15:45:00.000Z",
    },
    ...overrides,
  };
}

function baseManualCancellationCommand(
  overrides: Partial<PmsManualCancellationCommand> = {},
): PmsManualCancellationCommand {
  return {
    propertyId,
    guestBookingId,
    commandId: "cmd-cancel-001",
    idempotencyKey: "pms-cancel-001",
    expectedVersion: "reservation-v7",
    accountingDate: "2026-08-15",
    retainedCharges: [],
    audit: baseNoShowCommand().audit,
    ...overrides,
  };
}

function baseBookingLifecycleCommand(
  overrides: Partial<PmsBookingLifecycleCommand> = {},
): PmsBookingLifecycleCommand {
  return {
    propertyId,
    guestBookingId,
    commandId: "cmd-booking-accept-001",
    idempotencyKey: "pms-booking-accept-001",
    audit: {
      actor: { kind: "user", userId, organizationId },
      requestId: "req-booking-accept-001",
      correlationId: "corr-booking-accept-001",
      reason: "Accept booking",
      requestedAt: "2026-08-15T15:45:00.000Z",
    },
    ...overrides,
  };
}

function baseCheckOutCommand(overrides: Partial<PmsCheckOutCommand> = {}): PmsCheckOutCommand {
  return {
    propertyId,
    guestBookingId,
    commandId: "cmd-checkout-001",
    idempotencyKey: "pms-checkout-001",
    expectedVersion: "reservation-v7",
    inspectionResults: [{ stepId: "minibar", status: "completed" }],
    chargesSettled: ["f6855700-0000-0000-0000-000000000001"],
    pendingFlags: [],
    checkoutNotes: "Guest departed at 10:15.",
    audit: {
      actor: { kind: "user", userId, organizationId },
      requestId: "req-checkout-001",
      correlationId: "corr-checkout-001",
      reason: "Check out guest",
      requestedAt: "2026-08-18T10:15:00.000Z",
    },
    ...overrides,
  };
}

function createRepository(
  handler: QueryHandler,
  stripePaymentProvider?: StripeBookingPaymentProvider,
): {
  client: RecordingCommandClient;
  repository: ReturnType<typeof createTargetPmsOperationsCommandRepository>;
} {
  const { client, pool } = createRecordingPool(handler);
  return {
    client,
    repository: createTargetPmsOperationsCommandRepository({
      connectionString: "postgres://target",
      pool,
      readRepository,
      stripePaymentProvider,
      now: () => new Date("2026-08-15T15:45:00.000Z"),
    }),
  };
}

function successfulOperationalHandler(status = "assigned"): QueryHandler {
  return (text, values) => {
    if (text === "BEGIN" || text === "COMMIT" || text === "ROLLBACK") return ok();
    if (text.includes("FROM platform.idempotency_keys")) return ok();
    if (text.includes("INSERT INTO platform.idempotency_keys")) return ok([{ id: "idem" }], 1);
    if (text.includes("SELECT DISTINCT scope.room_type_id")) {
      return ok([{ roomTypeId }]);
    }
    if (text.includes("pg_advisory_xact_lock")) return ok();
    if (text.includes("FROM pms.linked_inventory_groups")) return ok();
    if (text.includes("room_type_id = ANY") && text.includes("FOR UPDATE")) return ok();
    if (text.includes('AS "expectedAssignedCount"')) {
      const targetDays = JSON.parse(String(values?.[1])) as Array<{
        roomTypeId: string;
        stayDate: string;
      }>;
      return ok(
        targetDays.map((target) => ({
          ...target,
          totalCount: 2,
          blockedCount: 0,
          assignedCount: 2,
          effectiveSellableLimitCount: 2,
          inventoryRevision: 1,
          bookingSourceRevision: 1,
          status: "open",
          expectedAssignedCount: 0,
        })),
      );
    }
    if (text.includes("FROM pms.operational_booking_assignments")) {
      return ok(assignmentRows(status));
    }
    if (text.includes("FROM pms.rooms") && text.includes("operational_label_status = 'verified'")) {
      const roomIds = (values?.[1] ?? []) as string[];
      return ok(roomIds.map((id) => ({ id })));
    }
    if (text.includes("FROM pms.booking_checkin_records")) return ok();
    if (text.includes("INSERT INTO pms.booking_checkin_records")) return ok([], 2);
    if (text.includes("UPDATE pms.operational_booking_assignments")) return ok([], 2);
    if (text.includes("UPDATE pms.inventory_days")) return ok([], 1);
    if (text.includes("booking_metadata->>'contractVersion'")) return ok();
    if (text.includes("INSERT INTO platform.product_audit_events")) return ok([], 1);
    if (text.includes("UPDATE platform.idempotency_keys")) return ok([], 1);
    throw new Error(`Unhandled SQL: ${text}`);
  };
}

function manualNoShowHandler(failEvidence = false): QueryHandler {
  const fallback = successfulOperationalHandler();
  return (text, values) => {
    if (text.includes("booking_metadata->>'contractVersion'")) {
      return ok([{ sourceBookingReference: "manual-create-command", timezone: "Europe/Athens" }]);
    }
    if (
      text.includes("FROM booking.nightly_revenue_evidence") &&
      text.includes("HAVING SUM(occupied_room_nights)=1")
    ) {
      return ok(
        [1, 2].map((linePosition) => ({
          roomTypeId,
          stayDate: "2026-08-15",
          recognizedOn: "2026-08-15",
          grossRoomAmount: "-100.0000",
          linePosition,
          correctsEvidenceId: `f6855600-0000-0000-0000-00000000000${linePosition}`,
          manualExact: true,
        })),
      );
    }
    if (text.includes("SELECT txid_current()")) return ok([{ id: "42" }]);
    if (text.includes('room_count AS "roomCount"')) {
      return ok([{ roomCount: 2, roomTypeCount: 1, transactionId: "42" }]);
    }
    if (text.includes("command_key LIKE")) return ok();
    if (text.includes("COALESCE(MAX(source_revision)")) return ok([{ value: 2 }]);
    if (text.includes("INSERT INTO booking.nightly_revenue_evidence")) {
      if (failEvidence) throw new Error("forced nightly evidence failure");
      return ok([
        { id: assignmentOneId, commandKey: "one" },
        { id: assignmentTwoId, commandKey: "two" },
      ]);
    }
    return fallback(text, values);
  };
}

function successfulAssignmentHandler(
  targetRoomTypeId = assignmentRows()[0]!.roomTypeId as string,
): QueryHandler {
  return (text, values) => {
    if (text === "BEGIN" || text === "COMMIT" || text === "ROLLBACK") return ok();
    if (text.includes("FROM platform.idempotency_keys")) return ok();
    if (text.includes("INSERT INTO platform.idempotency_keys")) return ok([{ id: "idem" }], 1);
    if (text.includes('SELECT room_type_id::text AS "roomTypeId"')) {
      return ok([{ roomTypeId: assignmentRows()[0]!.roomTypeId }]);
    }
    if (text.includes('AS "expectedAssignedCount"')) {
      const targetDays = JSON.parse(String(values[1] ?? "[]")) as Array<{
        roomTypeId: string;
        stayDate: string;
      }>;
      return ok(
        targetDays.map(({ roomTypeId: targetType, stayDate }) => ({
          roomTypeId: targetType,
          stayDate,
          totalCount: 1,
          blockedCount: 0,
          assignedCount: targetType === roomTypeId ? 1 : 0,
          effectiveSellableLimitCount: 1,
          status: "open",
          expectedAssignedCount: targetType === targetRoomTypeId ? 1 : 0,
          linkedStopSell: false,
        })),
      );
    }
    if (text.includes("FROM pms.operational_booking_assignments assignment")) {
      return ok([assignmentRows()[0]!]);
    }
    if (text.includes("pg_advisory_xact_lock")) return ok([{ locked: true }]);
    if (text.includes("FROM pms.linked_inventory_groups")) return ok();
    if (text.includes("room_type_id = $2::uuid") && text.includes("FOR UPDATE")) return ok();
    if (text.includes('id::text AS "roomId"') && text.includes("status = 'available'")) {
      return ok([
        {
          roomId: "f6855100-0000-0000-0000-000000000003",
          roomTypeId: targetRoomTypeId,
          status: "available",
        },
      ]);
    }
    if (text.includes("WITH stay_dates AS")) return ok([{ eligible: 1 }]);
    if (text.includes("UPDATE pms.inventory_days")) return ok([], 1);
    if (text.includes("UPDATE pms.operational_booking_assignments")) return ok([], 1);
    if (text.includes("INSERT INTO platform.domain_events")) {
      return ok([{ eventId: "f6855900-0000-0000-0000-000000000001" }], 1);
    }
    if (text.includes("INSERT INTO platform.outbox_events")) return ok([], 1);
    if (text.includes("UPDATE platform.idempotency_keys")) return ok([], 1);
    throw new Error(`Unhandled SQL: ${text}`);
  };
}

function checkoutChargeRows(): QueryResultRow[] {
  return [
    {
      chargeId: "f6855700-0000-0000-0000-000000000001",
      propertyId,
      guestBookingId,
      assignmentId: assignmentOneId,
      label: "Minibar",
      amountDecimal: "12.00",
      originalAmountDecimal: "12.00",
      currency: "EUR",
      status: "paid",
      createdByUserId: userId,
      createdAt: "2026-08-17T18:00:00.000Z",
      settledAt: "2026-08-18T09:45:00.000Z",
      waivedAt: null,
    },
    {
      chargeId: "f6855700-0000-0000-0000-000000000002",
      propertyId,
      guestBookingId,
      assignmentId: assignmentTwoId,
      label: "Broken glass",
      amountDecimal: "8.00",
      originalAmountDecimal: "8.00",
      currency: "EUR",
      status: "pending",
      createdByUserId: userId,
      createdAt: "2026-08-18T09:55:00.000Z",
      settledAt: null,
      waivedAt: null,
    },
  ];
}

function checkoutRecordRow(checkout: Partial<PmsCheckOutRecord> = {}): QueryResultRow {
  return {
    checkoutRecordId: checkout.checkoutRecordId ?? "f6855a00-0000-0000-0000-000000000001",
    propertyId,
    guestBookingId,
    assignmentId: checkout.assignmentId ?? null,
    completedByUserId: userId,
    completedAt: checkout.completedAt ?? "2026-08-15T15:45:00.000Z",
    inspectionResults: checkout.inspectionResults ?? [{ stepId: "minibar", status: "completed" }],
    chargesSettled: checkout.chargesSettled ?? [
      {
        chargeId: "f6855700-0000-0000-0000-000000000001",
        propertyId,
        guestBookingId,
        assignmentId: assignmentOneId,
        label: "Minibar",
        amount: { amountDecimal: "12.00", currency: "EUR" },
        originalAmount: { amountDecimal: "12.00", currency: "EUR" },
        status: "paid",
        createdByUserId: userId,
        createdAt: "2026-08-17T18:00:00.000Z",
        settledAt: "2026-08-18T09:45:00.000Z",
        waivedAt: null,
        operationalOwnership: {
          owner: "pms",
          financeSettlementOwner: "finance",
          providerSettlement: false,
        },
      },
    ],
    pendingFlags: checkout.pendingFlags ?? ["finance_settlement_handoff_required"],
    checkoutNotes: checkout.checkoutNotes ?? "Guest departed at 10:15.",
  };
}

function successfulCheckoutHandler(
  options: { assignmentStatus?: string; existingCheckout?: boolean } = {},
): QueryHandler {
  return (text, values) => {
    if (text === "BEGIN" || text === "COMMIT" || text === "ROLLBACK") return ok();
    if (text.includes("FROM platform.idempotency_keys")) return ok();
    if (text.includes("INSERT INTO platform.idempotency_keys")) return ok([{ id: "idem" }], 1);
    if (text.includes("SELECT DISTINCT scope.room_type_id")) return ok([{ roomTypeId }]);
    if (text.includes("pg_advisory_xact_lock")) return ok();
    if (text.includes("room_type_id = ANY") && text.includes("FOR UPDATE")) return ok();
    if (text.includes("FROM pms.operational_booking_assignments")) {
      return ok(assignmentRows(options.assignmentStatus ?? "in_house"));
    }
    if (text.includes("FROM pms.booking_checkout_records")) {
      return options.existingCheckout ? ok([checkoutRecordRow()]) : ok();
    }
    if (text.includes("FROM pms.booking_checkout_charges charge")) return ok(checkoutChargeRows());
    if (text.includes("INSERT INTO pms.booking_checkout_records")) {
      return ok([
        checkoutRecordRow({
          assignmentId: values[2] as string | null,
          completedAt: String(values[4]),
          inspectionResults: JSON.parse(String(values[5])) as unknown[],
          chargesSettled: JSON.parse(String(values[6])) as PmsCheckOutRecord["chargesSettled"],
          pendingFlags: JSON.parse(String(values[7])) as string[],
          checkoutNotes: values[8] as string | null,
        }),
      ]);
    }
    if (text.includes("UPDATE pms.operational_booking_assignments")) return ok([], 2);
    if (text.includes("INSERT INTO platform.product_audit_events")) return ok([], 1);
    if (text.includes("UPDATE platform.idempotency_keys")) return ok([], 1);
    throw new Error(`Unhandled SQL: ${text}`);
  };
}

describe("target PMS operations command repository", () => {
  it("accepts request-mode pay-at-property bookings without marking them paid", async () => {
    const { client, repository } = createRepository((text) => {
      if (text === "BEGIN" || text === "COMMIT" || text === "ROLLBACK") return ok();
      if (text.includes("FROM platform.idempotency_keys")) return ok();
      if (text.includes("INSERT INTO platform.idempotency_keys")) {
        return ok([{ id: "idem" }], 1);
      }
      if (text.includes("FROM booking.guest_bookings booking") && text.includes("FOR UPDATE")) {
        return ok([
          {
            guestBookingId,
            propertyId,
            publicReference: "BK-REQUEST-PAY-AT",
            lifecycleStatus: "pending_payment",
            paymentStatus: "unpaid",
            paymentMethod: "pay_at_property",
            checkIn: "2026-08-20",
            checkOut: "2026-08-23",
            totalAmount: "600.00",
            balanceAmount: "600.00",
            currency: "EUR",
            ...directRevenueFields,
            bookingMetadata: {
              ...directRevenueFields.bookingMetadata,
              acceptanceMode: "request",
            },
          },
        ]);
      }
      if (text.includes("WITH booking_update AS")) return ok([{ id: guestBookingId }], 1);
      if (text.includes("WITH booking_scope AS")) return ok();
      if (text.includes("INSERT INTO platform.product_audit_events")) return ok([], 1);
      if (text.includes("UPDATE platform.idempotency_keys")) return ok([], 1);
      throw new Error(`Unhandled SQL: ${text}`);
    });

    const result = await repository.acceptBooking(baseBookingLifecycleCommand());
    expect(result).toMatchObject({ ok: true, commandMeta: { sideEffects: ["audit_event"] } });

    expect(requiredCall(client, "WITH booking_update AS").text).toContain(
      "booking_metadata ->> 'acceptanceMode' = 'request'",
    );
    expect(client.calls.some(({ text }) => text.includes("payment_status = 'paid'"))).toBe(false);
    expect(client.calls.some(({ text }) => text.includes("INSERT INTO platform.jobs"))).toBe(false);
  });

  it("captures request-mode cards only inside host acceptance", async () => {
    let captureCalls = 0;
    const provider: StripeBookingPaymentProvider = {
      async createPaymentIntent() {
        throw new Error("not used");
      },
      async retrievePaymentIntent() {
        return requestCardIntent("requires_capture");
      },
      async capturePaymentIntent(paymentIntentId, providerAccountRef, idempotencyKey) {
        captureCalls += 1;
        expect(paymentIntentId).toBe("pi_request_card");
        expect(providerAccountRef).toBe("acct_request_card");
        expect(idempotencyKey).toContain(`pms-booking-capture:${propertyId}:${guestBookingId}:`);
        return requestCardIntent("succeeded");
      },
      async cancelPaymentIntent() {
        throw new Error("not used");
      },
    };
    const { client, repository } = createRepository((text) => {
      if (text === "BEGIN" || text === "COMMIT" || text === "ROLLBACK") return ok();
      if (text.includes("FROM platform.idempotency_keys")) return ok();
      if (text.includes("INSERT INTO platform.idempotency_keys")) {
        return ok([{ id: "idem" }], 1);
      }
      if (text.includes("FROM booking.guest_bookings booking") && text.includes("FOR UPDATE")) {
        return ok([
          {
            guestBookingId,
            propertyId,
            publicReference: "BK-REQUEST-CARD",
            lifecycleStatus: "pending_payment",
            paymentStatus: "authorized",
            paymentMethod: "card",
            checkIn: "2026-08-20",
            checkOut: "2026-08-23",
            totalAmount: "600.00",
            balanceAmount: "600.00",
            currency: "EUR",
            sourceSystem: "booking",
            bookingMetadata: {
              ...directRevenueFields.bookingMetadata,
              acceptanceMode: "request",
            },
            providerPaymentIntentId: "pi_request_card",
            providerAccountRef: "acct_request_card",
            chargeType: "direct",
          },
        ]);
      }
      if (text.includes("FOR UPDATE OF payment, booking")) {
        return ok([
          {
            paymentId: "f6855900-0000-0000-0000-000000000006",
            paymentStatus: "authorized",
            propertyId,
            guestBookingId,
            amount: "600.00",
            currency: "EUR",
            lifecycleStatus: "pending_payment",
            bookingPaymentStatus: "authorized",
            publicReference: "BK-REQUEST-CARD",
            checkIn: "2026-08-20",
            checkOut: "2026-08-23",
            adults: 2,
            children: 0,
            roomCount: 1,
            totalAmount: "600.00",
            bookingMetadata: {
              ...directRevenueFields.bookingMetadata,
              acceptanceMode: "request",
            },
          },
        ]);
      }
      if (text.includes("UPDATE booking.guest_bookings") && text.includes("RETURNING id")) {
        return ok([{ id: guestBookingId }], 1);
      }
      if (text.includes('from_status AS "fromStatus"')) {
        return ok([{ fromStatus: "pending_payment", toStatus: "confirmed" }]);
      }
      if (text.includes('AS "hostEmail"')) {
        return ok([
          {
            propertyId,
            guestBookingId,
            bookingReference: "BK-REQUEST-CARD",
            guestEmail: "guest@example.test",
            guestName: "Alex Guest",
            hostEmail: "host@example.test",
            propertyName: "Hotel Alpenrose",
            checkIn: "2026-08-20",
            checkOut: "2026-08-23",
            totalAmount: "600.00",
            balanceAmount: "0.00",
            currency: "EUR",
            paymentMethod: "card",
            bookingMetadata: { acceptanceMode: "request" },
          },
        ]);
      }
      if (text.includes("INSERT INTO platform.domain_events"))
        return ok([{ eventId: "event-1" }], 1);
      if (text.includes("INSERT INTO platform.jobs"))
        return text.includes('AS "jobId"') ? ok([{ jobId: "job-1", replay: false }], 1) : ok([], 1);
      if (text.includes("INSERT INTO platform.product_audit_events")) return ok([], 1);
      if (text.includes("UPDATE platform.idempotency_keys")) return ok([], 1);
      return ok();
    }, provider);

    const result = await repository.acceptBooking(baseBookingLifecycleCommand());
    expect(result).toMatchObject({ ok: true, commandMeta: { sideEffects: ["audit_event"] } });

    expect(client.calls.some(({ text }) => text.includes("SET status = 'paid'"))).toBe(true);
    expect(captureCalls).toBe(1);
    expect(client.calls.some(({ text }) => text.includes("nightly_revenue_evidence"))).toBe(true);
    expect(
      client.calls.some(
        ({ text, values }) =>
          text.includes("'guest_booking.accepted'") && values.includes("property_user"),
      ),
    ).toBe(true);
    expect(
      client.calls.some(({ values }) => values.some((value) => String(value).includes("email."))),
    ).toBe(true);
  });

  it("enqueues bank instructions for private delivery after host acceptance", async () => {
    const { client, repository } = createRepository((text) => {
      if (text === "BEGIN" || text === "COMMIT" || text === "ROLLBACK") return ok();
      if (text.includes("FROM platform.idempotency_keys")) return ok();
      if (text.includes("INSERT INTO platform.idempotency_keys")) {
        return ok([{ id: "idem" }], 1);
      }
      if (text.includes("FROM booking.guest_bookings booking") && text.includes("FOR UPDATE")) {
        return ok([
          {
            guestBookingId,
            propertyId,
            publicReference: "BK-BANK-001",
            lifecycleStatus: "pending_payment",
            paymentStatus: "unpaid",
            paymentMethod: "bank_transfer",
            checkIn: "2026-08-20",
            checkOut: "2026-08-23",
            totalAmount: "600.00",
            balanceAmount: "600.00",
            currency: "EUR",
            guestEmail: "guest@example.test",
            guestName: "Alex Guest",
            propertyName: "Hotel Alpenrose",
            ...directRevenueFields,
            acceptedMethods: [],
            depositPolicy: {},
            paymentInstructions: {
              requiresBankTransferInstructions: true,
            },
          },
        ]);
      }
      if (text.includes("WITH booking_update AS")) return ok([{ id: guestBookingId }], 1);
      if (text.includes("WITH booking_scope AS")) return ok();
      if (text.includes('AS "hostEmail"')) {
        return ok([
          {
            propertyId,
            guestBookingId,
            bookingReference: "BK-BANK-001",
            guestEmail: "guest@example.test",
            guestName: "Alex Guest",
            hostEmail: "reservations@example.test",
            propertyName: "Hotel Alpenrose",
            checkIn: "2026-08-20",
            checkOut: "2026-08-23",
            totalAmount: "600.00",
            balanceAmount: "600.00",
            currency: "EUR",
            paymentMethod: "bank_transfer",
            bookingMetadata: {},
          },
        ]);
      }
      if (text.includes("SELECT binding.destination_id"))
        return ok([{ destination_id: "destination" }]);
      if (text.includes("INSERT INTO platform.domain_events")) {
        return ok([{ eventId: "f6855900-0000-0000-0000-000000000001" }], 1);
      }
      if (text.includes("INSERT INTO platform.jobs")) {
        return ok([{ jobId: "f6855900-0000-0000-0000-000000000002", replay: false }], 1);
      }
      if (text.includes("INSERT INTO platform.product_audit_events")) return ok([], 1);
      if (text.includes("UPDATE platform.idempotency_keys")) return ok([], 1);
      throw new Error(`Unhandled SQL: ${text}`);
    });

    const result = await repository.acceptBooking(baseBookingLifecycleCommand());

    expect(result.ok).toBe(true);
    expect(result).toMatchObject({
      commandMeta: { sideEffects: ["guest_notification", "audit_event"] },
    });
    const acceptanceIndex = client.calls.findIndex(({ text }) =>
      text.includes("WITH booking_update AS"),
    );
    const emailIndex = client.calls.findIndex(({ text }) =>
      text.includes("INSERT INTO platform.jobs"),
    );
    expect(acceptanceIndex).toBeGreaterThan(-1);
    expect(emailIndex).toBeGreaterThan(acceptanceIndex);
    expect(requiredCall(client, "WITH booking_scope AS")).toBeDefined();
    expect(requiredCall(client, "WITH booking_update AS").values[3]).toBe("property_user");
    expect(requiredCall(client, "WITH booking_update AS").text).toContain(
      "acceptedPaymentDeadlineAt",
    );
    expect(requiredCall(client, "WITH booking_update AS").values[6]).toBe(
      "2026-08-16T15:45:00.000Z",
    );
    expect(JSON.stringify(client.calls)).not.toContain("DE89370400440532013000");
    const email = requiredCall(client, "INSERT INTO platform.jobs");
    expect(JSON.parse(String(email.values[8]))).toMatchObject({
      bookingReference: "BK-BANK-001",
      requiresBankTransferInstructions: true,
      paymentDeadlineAt: "2026-08-16T15:45:00.000Z",
    });
  });

  it("returns a specific conflict when the bound bank destination was deleted", async () => {
    const { client, repository } = createRepository((text) => {
      if (["BEGIN", "COMMIT", "ROLLBACK"].includes(text)) return ok();
      if (text.includes("FROM platform.idempotency_keys")) return ok();
      if (text.includes("INSERT INTO platform.idempotency_keys")) return ok([{ id: "idem" }], 1);
      if (text.includes("FROM booking.guest_bookings booking") && text.includes("FOR UPDATE"))
        return ok([
          {
            guestBookingId,
            propertyId,
            lifecycleStatus: "pending_payment",
            paymentStatus: "unpaid",
            paymentMethod: "bank_transfer",
          },
        ]);
      if (text.includes("SELECT binding.destination_id")) return ok();
      throw new Error(`Unhandled SQL: ${text}`);
    });
    await expect(repository.acceptBooking(baseBookingLifecycleCommand())).resolves.toMatchObject({
      ok: false,
      statusCode: 409,
      code: "bank_transfer_unavailable",
    });
    expect(requiredCall(client, "SELECT binding.destination_id").text).toContain(
      "FOR SHARE OF destination",
    );
    expect(
      client.calls.some(
        ({ text }) =>
          text.includes("WITH booking_update AS") || text.includes("INSERT INTO platform.jobs"),
      ),
    ).toBe(false);
  });

  it("rejects bank acceptance after the canonical pending-payment deadline", async () => {
    const { client, repository } = createRepository((text) => {
      if (text === "BEGIN" || text === "COMMIT" || text === "ROLLBACK") return ok();
      if (text.includes("FROM platform.idempotency_keys")) return ok();
      if (text.includes("INSERT INTO platform.idempotency_keys")) return ok([{ id: "idem" }], 1);
      if (text.includes("FROM booking.guest_bookings booking") && text.includes("FOR UPDATE")) {
        return ok([
          {
            guestBookingId,
            propertyId,
            publicReference: "BK-BANK-EXPIRED",
            lifecycleStatus: "pending_payment",
            paymentStatus: "unpaid",
            paymentMethod: "bank_transfer",
            pendingExpiresAt: "2026-08-15T15:44:59.000Z",
            acceptedPaymentDeadlineAt: null,
            paymentInstructions: { bankTransferDetails: "IBAN: DE89370400440532013000" },
          },
        ]);
      }
      throw new Error(`Unhandled SQL: ${text}`);
    });

    await expect(repository.acceptBooking(baseBookingLifecycleCommand())).resolves.toMatchObject({
      ok: false,
      code: "invalid_status_transition",
    });
    expect(client.calls.some(({ text }) => text.includes("WITH booking_update AS"))).toBe(false);
    expect(client.calls.some(({ text }) => text.includes("INSERT INTO platform.jobs"))).toBe(false);
  });

  it("does not capture a request card after its host-response deadline", async () => {
    const provider: StripeBookingPaymentProvider = {
      createPaymentIntent: vi.fn(),
      retrievePaymentIntent: vi.fn(),
      capturePaymentIntent: vi.fn(),
      cancelPaymentIntent: vi.fn(),
    };
    const { client, repository } = createRepository((text) => {
      if (text === "BEGIN" || text === "ROLLBACK") return ok();
      if (text.includes("FROM platform.idempotency_keys")) return ok();
      if (text.includes("INSERT INTO platform.idempotency_keys")) return ok([{ id: "idem" }], 1);
      if (text.includes("FROM booking.guest_bookings booking") && text.includes("FOR UPDATE")) {
        return ok([
          {
            guestBookingId,
            propertyId,
            publicReference: "BK-REQUEST-CARD-EXPIRED",
            lifecycleStatus: "pending_payment",
            paymentStatus: "authorized",
            paymentMethod: "card",
            pendingExpiresAt: "2026-08-15T15:44:59.000Z",
            bookingMetadata: { acceptanceMode: "request" },
            providerPaymentIntentId: "pi_request_card",
            providerAccountRef: "acct_request_card",
          },
        ]);
      }
      throw new Error(`Unhandled SQL: ${text}`);
    }, provider);

    await expect(repository.acceptBooking(baseBookingLifecycleCommand())).resolves.toMatchObject({
      ok: false,
      code: "invalid_status_transition",
    });
    expect(provider.retrievePaymentIntent).not.toHaveBeenCalled();
    expect(provider.capturePaymentIntent).not.toHaveBeenCalled();
    expect(client.calls.some(({ text }) => text.includes("UPDATE finance.payments"))).toBe(false);
  });

  it.each([
    {
      method: "paypal",
      lifecycleStatus: "pending_payment",
      pendingExpiresAt: "2026-08-15T15:45:00.000Z",
      acceptedPaymentDeadlineAt: null,
    },
    {
      method: "bank_transfer",
      lifecycleStatus: "confirmed",
      pendingExpiresAt: null,
      acceptedPaymentDeadlineAt: "2026-08-15T15:45:00.000Z",
    },
  ])("rejects expired $method settlement before the Finance ledger write", async (row) => {
    const { client, repository } = createRepository((text) => {
      if (text === "BEGIN" || text === "ROLLBACK") return ok();
      if (text.includes("FROM platform.idempotency_keys")) return ok();
      if (text.includes("INSERT INTO platform.idempotency_keys")) return ok([{ id: "idem" }], 1);
      if (text.includes("FROM booking.guest_bookings booking") && text.includes("FOR UPDATE")) {
        return ok([
          {
            ...row,
            guestBookingId,
            propertyId,
            publicReference: "BK-MANUAL-EXPIRED",
            paymentStatus: "unpaid",
          },
        ]);
      }
      throw new Error(`Unhandled SQL: ${text}`);
    });

    await expect(repository.markBookingPaid(baseBookingLifecycleCommand())).resolves.toMatchObject({
      ok: false,
      code: "invalid_status_transition",
    });
    expect(client.calls.some(({ text }) => text.includes("INSERT INTO finance.payments"))).toBe(
      false,
    );
  });

  it.each([
    {
      method: "paypal",
      lifecycleStatus: "pending_payment",
      acceptanceMode: "instant",
      automaticallyAccepted: true,
    },
    {
      method: "paypal",
      lifecycleStatus: "pending_payment",
      acceptanceMode: "request",
      automaticallyAccepted: false,
    },
    {
      method: "pay_at_property",
      lifecycleStatus: "confirmed",
      acceptanceMode: "instant",
      automaticallyAccepted: true,
    },
    {
      method: "paypal",
      lifecycleStatus: "pending_payment",
      acceptanceMode: undefined,
      automaticallyAccepted: false,
    },
    {
      method: "paypal",
      lifecycleStatus: "pending_payment",
      acceptanceMode: "legacy",
      automaticallyAccepted: false,
    },
  ] as const)(
    "records commission-aware $method settlement in $acceptanceMode mode",
    async ({ method, lifecycleStatus, acceptanceMode, automaticallyAccepted }) => {
      const { client, repository } = createRepository((text, values) => {
        if (text === "BEGIN" || text === "COMMIT" || text === "ROLLBACK") return ok();
        if (text.includes("FROM platform.idempotency_keys")) return ok();
        if (
          text.includes("INSERT INTO platform.idempotency_keys") &&
          text.includes("manual_payment_record")
        ) {
          return ok([{ status: "in_progress", requestFingerprintHash: values[1] as string }], 1);
        }
        if (text.includes("INSERT INTO platform.idempotency_keys")) {
          return ok([{ id: "idem" }], 1);
        }
        if (
          text.includes("FROM booking.guest_bookings booking") &&
          text.includes("FOR UPDATE") &&
          !text.includes("booking.commission_terms_snapshot")
        ) {
          return ok([
            {
              guestBookingId,
              propertyId,
              publicReference: "BK-PAYPAL-001",
              invoiceId: "INV-PAYPAL-001",
              lifecycleStatus,
              paymentStatus: "unpaid",
              paymentMethod: method,
              checkIn: "2026-08-20",
              checkOut: "2026-08-23",
              totalAmount: "600.00",
              balanceAmount: "600.00",
              currency: "EUR",
              guestEmail: "guest@example.test",
              guestName: "Alex Guest",
              propertyName: "Hotel Alpenrose",
              ...directRevenueFields,
              bookingMetadata: {
                ...directRevenueFields.bookingMetadata,
                acceptanceMode,
              },
              acceptedMethods: [method],
              depositPolicy: { paypalEmail: "host@example.test" },
            },
          ]);
        }
        if (text.includes("booking.commission_terms_snapshot")) {
          return ok([
            {
              guestBookingId,
              currency: "EUR",
              balanceDue: "600.00",
              lifecycleStatus,
              paymentStatus: "unpaid",
              billingPlanSnapshot: "commission",
              commissionTermsSnapshot: { bookingEngineFeePercent: 5 },
            },
          ]);
        }
        if (text.includes("pg_advisory_xact_lock")) return { rows: [], rowCount: 1 };
        if (text.includes("FROM finance.billing_entitlements")) {
          return ok([{ plan: "commission" }]);
        }
        if (text.includes("INSERT INTO finance.payments")) {
          return ok([{ paymentId: "f6855900-0000-0000-0000-000000000005", replay: false }], 1);
        }
        if (
          text.includes('SELECT id::text AS "paymentId"') &&
          text.includes("FROM finance.payments")
        ) {
          return ok();
        }
        if (text.includes("INSERT INTO platform.outbox_events")) {
          return ok([
            {
              destination: "booking.projection-refresh",
              outboxEventId: "f6855900-0000-0000-0000-000000000006",
            },
            {
              destination: "pms.projection-refresh",
              outboxEventId: "f6855900-0000-0000-0000-000000000007",
            },
          ]);
        }
        if (text.includes("FROM finance.payments payment") && text.includes("recordedAt")) {
          return ok([
            {
              paymentId: "f6855900-0000-0000-0000-000000000005",
              method,
              amount: "600.00",
              currency: "EUR",
              reference: `PMS ${method} confirmation`,
              status: "paid",
              recordedAt: "2026-08-01T10:00:00.000Z",
            },
          ]);
        }
        if (text.includes("WITH booking_update AS")) return ok([{ id: guestBookingId }], 1);
        if (text.includes("WITH booking_scope AS")) return ok();
        if (text.includes('AS "hostEmail"')) {
          return ok([
            {
              propertyId,
              guestBookingId,
              bookingReference: "BK-PAYPAL-001",
              guestEmail: "guest@example.test",
              guestName: "Alex Guest",
              hostEmail: "reservations@example.test",
              propertyName: "Hotel Alpenrose",
              checkIn: "2026-08-20",
              checkOut: "2026-08-23",
              totalAmount: "600.00",
              balanceAmount: "600.00",
              currency: "EUR",
              paymentMethod: method,
              bookingMetadata: {},
            },
          ]);
        }
        if (text.includes("INSERT INTO platform.domain_events")) {
          return ok([{ eventId: "f6855900-0000-0000-0000-000000000003" }], 1);
        }
        if (text.includes("INSERT INTO platform.jobs")) {
          return ok([{ jobId: "f6855900-0000-0000-0000-000000000004", replay: false }], 1);
        }
        if (text.includes("INSERT INTO platform.product_audit_events")) return ok([], 1);
        if (text.includes("UPDATE platform.idempotency_keys")) return ok([], 1);
        throw new Error(`Unhandled SQL: ${text}`);
      });

      const result = await repository.markBookingPaid(
        baseBookingLifecycleCommand({
          commandId: "cmd-booking-paid-001",
          idempotencyKey: "pms-booking-paid-001",
        }),
      );

      expect(result.ok).toBe(true);
      const mutation = requiredCall(client, "WITH booking_update AS");
      expect(mutation.text).toContain("payment_status = 'paid'");
      expect(mutation.text).toContain("balance_amount = 0");
      expect(mutation.values[4]).toBe("property_user");
      expect(mutation.values[8]).toBe(automaticallyAccepted);
      expect(mutation.text).toContain("automatic_acceptance_event");
      const financePayment = requiredCall(client, "INSERT INTO finance.payments");
      expect(financePayment.values).toContain(method);
      expect(financePayment.values).toContain("600.00");
      expect(financePayment.values).toContain("30.00");
      expect(financePayment.values).toContain("570.00");
      expect(client.calls.indexOf(financePayment)).toBeLessThan(client.calls.indexOf(mutation));
      expect(client.calls.some(({ text }) => text.includes("WITH booking_scope AS"))).toBe(
        method === "paypal",
      );
      expect(
        client.calls.some(
          (call) =>
            call.text.includes("INSERT INTO platform.jobs") &&
            call.values.includes("email.booking-final-confirmation"),
        ),
      ).toBe(method === "paypal");
    },
  );

  it.each(["assign", "move"] as const)(
    "serializes %s before accepting a verified operational room",
    async (action) => {
      const { client, repository } = createRepository(successfulAssignmentHandler());

      const result = await repository.executeAssignmentCommand(
        baseAssignmentCommand({
          action,
          commandId: `cmd-${action}-verified`,
          idempotencyKey: `key-${action}-verified`,
        }),
      );

      expect(result.ok).toBe(true);
      const advisoryLockIndex = client.calls.findIndex(({ text }) =>
        text.includes("pg_advisory_xact_lock"),
      );
      const roomLockIndex = client.calls.findIndex(
        ({ text }) => text.includes("room_type_id = $2::uuid") && text.includes("FOR UPDATE"),
      );
      const assignmentLockIndex = client.calls.findIndex(
        ({ text }) =>
          text.includes("FROM pms.operational_booking_assignments assignment") &&
          text.includes("FOR UPDATE OF assignment"),
      );
      const eligibilityIndex = client.calls.findLastIndex(
        ({ text }) =>
          text.includes('id::text AS "roomId"') && text.includes("status = 'available'"),
      );
      expect(advisoryLockIndex).toBeGreaterThan(-1);
      expect(advisoryLockIndex).toBeLessThan(roomLockIndex);
      expect(roomLockIndex).toBeLessThan(assignmentLockIndex);
      expect(assignmentLockIndex).toBeLessThan(eligibilityIndex);
      expect(requiredCall(client, "UPDATE pms.operational_booking_assignments").values[0]).toBe(
        "f6855100-0000-0000-0000-000000000003",
      );
    },
  );

  it("moves exactly one assignment across room types and transfers its inventory", async () => {
    const targetRoomTypeId = "f6855000-0000-0000-0000-000000000099";
    const { client, repository } = createRepository(successfulAssignmentHandler(targetRoomTypeId));

    const result = await repository.executeAssignmentCommand(
      baseAssignmentCommand({
        action: "move",
        commandId: "cmd-move-cross-room-type",
        idempotencyKey: "key-move-cross-room-type",
      }),
    );

    expect(result.ok).toBe(true);
    const roomTypeLocks = client.calls
      .filter(({ text }) => text.includes("room_type_id = $2::uuid") && text.includes("FOR UPDATE"))
      .map(({ values }) => values[1]);
    expect(roomTypeLocks).toEqual([roomTypeId, targetRoomTypeId].sort());

    const occupiedInventory = requiredCall(client, 'AS "expectedAssignedCount"');
    const targetDays = JSON.parse(String(occupiedInventory.values[1])) as Array<{
      roomTypeId: string;
      stayDate: string;
    }>;
    expect(new Set(targetDays.map(({ roomTypeId }) => roomTypeId))).toEqual(
      new Set([roomTypeId, targetRoomTypeId]),
    );
    expect(new Set(targetDays.map(({ stayDate }) => stayDate))).toEqual(
      new Set(["2026-08-15", "2026-08-16", "2026-08-17"]),
    );
    const inventoryTransfers = client.calls.filter(({ text }) =>
      text.includes("UPDATE pms.inventory_days"),
    );
    expect(inventoryTransfers).toHaveLength(6);

    const assignmentUpdate = requiredCall(client, "UPDATE pms.operational_booking_assignments");
    expect(assignmentUpdate.values[1]).toBe(assignmentOneId);
    expect(assignmentUpdate.text).toContain(
      "rate_plan_id = CASE WHEN room_type_id = $6::uuid THEN rate_plan_id ELSE NULL END",
    );
    expect(assignmentUpdate.text).toContain("WHEN assignment_status IN ('checked_in', 'in_house')");
    const assignmentRead = requiredCall(
      client,
      "FROM pms.operational_booking_assignments assignment",
    );
    expect(assignmentRead.text).toContain("COALESCE(assignment.check_in, booking.check_in)");
    const reconcilerIndex = client.calls.findIndex(({ text }) =>
      text.includes("FROM pms.linked_inventory_groups"),
    );
    expect(reconcilerIndex).toBeLessThan(client.calls.indexOf(occupiedInventory));
    const eligibility = requiredCall(client, "canonical_inventory_unavailable");
    expect(eligibility.text).toContain(
      "COALESCE(other_assignment.check_in, other_booking.check_in)",
    );
    expect(eligibility.text).toContain("cause.id<>$3::uuid");
    expect(eligibility.text).toContain("inventory.effective_sellable_limit_count");
    expect(eligibility.text).toContain("CASE WHEN $6::uuid=$7::uuid THEN 1 ELSE 0 END");
    expect(eligibility.values[6]).toBe(roomTypeId);
    const ariTransfers = client.calls.filter(({ text }) =>
      text.includes("'pms.inventory.ari_changed'::text"),
    );
    expect(ariTransfers.map(({ values }) => values[2])).toEqual([roomTypeId, targetRoomTypeId]);
    expect(ariTransfers[0]!.values[5]).toContain('"from":"2026-08-15","to":"2026-08-17"');
  });

  it("rejects a move when the requested room changes type before its lock is acquired", async () => {
    const targetRoomTypeId = "f6855000-0000-0000-0000-000000000099";
    const changedRoomTypeId = "f6855000-0000-0000-0000-000000000100";
    const fallback = successfulAssignmentHandler(targetRoomTypeId);
    let roomLookup = 0;
    const { client, repository } = createRepository((text, values) => {
      if (text.includes('id::text AS "roomId"') && text.includes("status = 'available'")) {
        roomLookup += 1;
        return ok([
          {
            roomId: "f6855100-0000-0000-0000-000000000003",
            roomTypeId: roomLookup === 1 ? targetRoomTypeId : changedRoomTypeId,
            status: "available",
          },
        ]);
      }
      return fallback(text, values);
    });

    const result = await repository.executeAssignmentCommand(
      baseAssignmentCommand({ action: "move" }),
    );

    expect(result).toMatchObject({ ok: false, code: "assignment_conflict" });
    expect(client.calls.some(({ text }) => text.includes("UPDATE pms.inventory_days"))).toBe(false);
  });

  it.each(["assign", "move"] as const)(
    "rejects %s to an unlabeled or unverified physical unit",
    async (action) => {
      const { client, repository } = createRepository((text) => {
        if (text === "BEGIN" || text === "COMMIT" || text === "ROLLBACK") return ok();
        if (text.includes("FROM platform.idempotency_keys")) return ok();
        if (text.includes("INSERT INTO platform.idempotency_keys")) return ok([{ id: "idem" }]);
        if (text.includes('SELECT room_type_id::text AS "roomTypeId"')) {
          return ok([{ roomTypeId: assignmentRows()[0]!.roomTypeId }]);
        }
        if (text.includes("pg_advisory_xact_lock")) return ok([{ locked: true }]);
        if (text.includes("FROM pms.operational_booking_assignments assignment")) {
          return ok([assignmentRows()[0]!]);
        }
        if (text.includes("room_type_id = $2::uuid") && text.includes("FOR UPDATE")) return ok();
        if (text.includes('id::text AS "roomId"') && text.includes("status = 'available'")) {
          expect(text).toContain("operational_label_status = 'verified'");
          expect(text).toContain("room_number IS NOT NULL");
          return ok();
        }
        throw new Error(`Unhandled SQL: ${text}`);
      });

      const result = await repository.executeAssignmentCommand(
        baseAssignmentCommand({
          action,
          commandId: `cmd-${action}`,
          idempotencyKey: `key-${action}`,
        }),
      );

      expect(result).toMatchObject({ ok: false, statusCode: 409, code: "room_unavailable" });
      expect(
        client.calls.some((call) =>
          call.text.includes("UPDATE pms.operational_booking_assignments"),
        ),
      ).toBe(false);
      expect(client.calls.some((call) => call.text === "ROLLBACK")).toBe(true);
    },
  );

  it("rejects a swap when any non-null room lacks verified operational identity", async () => {
    let assignmentLookup = 0;
    const { client, repository } = createRepository((text) => {
      if (text === "BEGIN" || text === "COMMIT" || text === "ROLLBACK") return ok();
      if (text.includes("FROM platform.idempotency_keys")) return ok();
      if (text.includes("INSERT INTO platform.idempotency_keys")) return ok([{ id: "idem" }]);
      if (text.includes('SELECT room_type_id::text AS "roomTypeId"')) {
        return ok([{ roomTypeId: assignmentRows()[0]!.roomTypeId }]);
      }
      if (text.includes("pg_advisory_xact_lock")) return ok([{ locked: true }]);
      if (text.includes("FROM pms.operational_booking_assignments assignment")) {
        const row = assignmentRows()[assignmentLookup];
        assignmentLookup += 1;
        return ok(row ? [row] : []);
      }
      if (text.includes("room_type_id = $2::uuid") && text.includes("FOR UPDATE")) return ok();
      if (
        text.includes("FROM pms.rooms") &&
        text.includes("operational_label_status = 'verified'")
      ) {
        return ok([{ id: assignmentRows()[0]!.roomId }]);
      }
      throw new Error(`Unhandled SQL: ${text}`);
    });

    const result = await repository.executeAssignmentCommand(
      baseAssignmentCommand({
        action: "swap",
        roomId: undefined,
        targetAssignmentId: assignmentTwoId,
      }),
    );

    expect(result).toMatchObject({ ok: false, statusCode: 409, code: "room_unavailable" });
    expect(
      client.calls.some((call) => call.text.includes("UPDATE pms.operational_booking_assignments")),
    ).toBe(false);
    expect(client.calls.some((call) => call.text === "ROLLBACK")).toBe(true);
  });

  it("writes property-scoped audit events and reservation-wide check-in mutations", async () => {
    const { client, repository } = createRepository(successfulOperationalHandler());

    const result = await repository.executeCheckInCommand(baseCheckInCommand());

    expect(result.ok).toBe(true);
    const advisoryIndex = client.calls.findIndex(({ text }) =>
      text.includes("pg_advisory_xact_lock"),
    );
    const roomLockIndex = client.calls.findIndex(
      ({ text }) => text.includes("room_type_id = ANY") && text.includes("FOR UPDATE"),
    );
    const assignmentLockIndex = client.calls.findIndex(
      ({ text }) =>
        text.includes("FROM pms.operational_booking_assignments assignment") &&
        text.includes("assignment.position") &&
        text.includes("FOR UPDATE OF assignment"),
    );
    expect(advisoryIndex).toBeLessThan(roomLockIndex);
    expect(roomLockIndex).toBeLessThan(assignmentLockIndex);
    const checkInInsert = requiredCall(client, "INSERT INTO pms.booking_checkin_records");
    expect(checkInInsert.values[6]).toEqual([assignmentOneId, assignmentTwoId]);

    const assignmentUpdate = requiredCall(client, "UPDATE pms.operational_booking_assignments");
    expect(assignmentUpdate.values[1]).toEqual([assignmentOneId, assignmentTwoId]);

    const auditInsert = requiredCall(client, "INSERT INTO platform.product_audit_events");
    expect(auditInsert.values[0]).toBe(
      `pms.checkin_command.property.${propertyId}.key.${sha256("pms-checkin-001")}.audit.v1`,
    );
    expect(auditInsert.text).toContain("'property',\n       NULL,\n       $4::uuid");
    expect(auditInsert.values[3]).toBe(propertyId);
    expect(auditInsert.values).not.toContain(organizationId);
    expect(JSON.parse(String(auditInsert.values[11]))).toMatchObject({
      actorOrganizationId: organizationId,
      commandId: "cmd-checkin-001",
    });
  });

  it("retries check-in when an assignment moves into an unlocked room scope", async () => {
    const successful = successfulOperationalHandler();
    let scopeRead = 0;
    const changedRoomTypeId = "f6855200-0000-0000-0000-000000000002";
    const { client, repository } = createRepository((text, values) => {
      if (text.includes("SELECT DISTINCT scope.room_type_id")) {
        scopeRead += 1;
        return scopeRead === 1
          ? ok([{ roomTypeId }])
          : ok([{ roomTypeId }, { roomTypeId: changedRoomTypeId }]);
      }
      return successful(text, values);
    });

    const result = await repository.executeCheckInCommand(baseCheckInCommand());

    expect(result).toMatchObject({
      ok: false,
      statusCode: 409,
      code: "version_conflict",
      message: "Reservation room scope changed. Retry the command.",
    });
    expect(scopeRead).toBe(2);
    expect(
      client.calls.some((call) => call.text.includes("INSERT INTO pms.booking_checkin_records")),
    ).toBe(false);
    expect(client.calls.at(-1)?.text).toBe("ROLLBACK");
  });

  it("rejects invalid explicit transition jumps before assignment update or audit", async () => {
    const { client, repository } = createRepository(successfulOperationalHandler());

    const result = await repository.executeOperationalStatusCommand(
      baseStatusCommand({ status: "checked_out" }),
    );

    expect(result).toMatchObject({
      ok: false,
      statusCode: 400,
      code: "invalid_status_transition",
    });
    expect(
      client.calls.some((call) => call.text.includes("UPDATE pms.operational_booking_assignments")),
    ).toBe(false);
    expect(
      client.calls.some((call) => call.text.includes("INSERT INTO platform.product_audit_events")),
    ).toBe(false);
    expect(client.calls.some((call) => call.text === "ROLLBACK")).toBe(true);
  });

  it("rejects check-in when an assigned room lacks verified operational identity", async () => {
    const successful = successfulOperationalHandler();
    const { client, repository } = createRepository((text, values) => {
      if (
        text.includes("FROM pms.rooms") &&
        text.includes("operational_label_status = 'verified'")
      ) {
        return ok();
      }
      return successful(text, values);
    });

    const result = await repository.executeCheckInCommand(baseCheckInCommand());

    expect(result).toMatchObject({
      ok: false,
      statusCode: 400,
      code: "invalid_status_transition",
      message: "PMS check-in requires an active room with a verified operational label.",
    });
    expect(
      client.calls.some((call) => call.text.includes("INSERT INTO pms.booking_checkin_records")),
    ).toBe(false);
    expect(
      client.calls.some((call) => call.text.includes("INSERT INTO platform.product_audit_events")),
    ).toBe(false);
    expect(client.calls.some((call) => call.text === "ROLLBACK")).toBe(true);
  });

  it("rejects an in-house status transition without verified operational identity", async () => {
    const successful = successfulOperationalHandler();
    const { client, repository } = createRepository((text, values) => {
      if (
        text.includes("FROM pms.rooms") &&
        text.includes("operational_label_status = 'verified'")
      ) {
        return ok([{ id: assignmentRows()[0]?.roomId }]);
      }
      return successful(text, values);
    });

    const result = await repository.executeOperationalStatusCommand(baseStatusCommand());

    expect(result).toMatchObject({
      ok: false,
      statusCode: 400,
      code: "invalid_status_transition",
      message: "PMS status update requires an active room with a verified operational label.",
    });
    expect(
      client.calls.some((call) => call.text.includes("UPDATE pms.operational_booking_assignments")),
    ).toBe(false);
    expect(
      client.calls.some((call) => call.text.includes("INSERT INTO platform.product_audit_events")),
    ).toBe(false);
    expect(client.calls.some((call) => call.text === "ROLLBACK")).toBe(true);
  });

  it("keeps same-key check-in replay safe while rejecting new-key duplicate check-in", async () => {
    const replayCommand = baseCheckInCommand();
    const replayMeta: PmsCommandMeta = {
      contractVersion: "pms-operations.v1",
      commandId: replayCommand.commandId,
      idempotencyKey: replayCommand.idempotencyKey,
      acceptedAt: "2026-08-15T15:45:00.000Z",
      sideEffects: ["audit_event"],
    };
    const replayFingerprintHash = commandFingerprintHash(replayCommand);
    const replaySetup = createRepository((text) => {
      if (text === "BEGIN" || text === "COMMIT" || text === "ROLLBACK") return ok();
      if (text.includes("FROM platform.idempotency_keys")) {
        return ok([
          {
            status: "completed",
            requestFingerprintHash: replayFingerprintHash,
            responseStatusCode: 200,
            responseBodyHash: sha256(stableJson(replayMeta)),
            idempotencyMetadata: { commandMeta: replayMeta },
          },
        ]);
      }
      throw new Error(`Replay should not mutate SQL: ${text}`);
    });

    const replayResult = await replaySetup.repository.executeCheckInCommand(replayCommand);

    expect(replayResult).toMatchObject({ ok: true, replayed: true, commandMeta: replayMeta });
    expect(
      replaySetup.client.calls.some((call) =>
        call.text.includes("INSERT INTO pms.booking_checkin_records"),
      ),
    ).toBe(false);

    const cancelCommand = baseManualCancellationCommand();
    const cancelMeta: PmsCommandMeta = {
      ...replayMeta,
      commandId: cancelCommand.commandId,
      idempotencyKey: cancelCommand.idempotencyKey,
      rearrangedBookingCount: 2,
    };
    const cancelReplay = createRepository((text) => {
      if (text === "BEGIN" || text === "COMMIT" || text === "ROLLBACK") return ok();
      if (text.includes("FROM platform.idempotency_keys"))
        return ok([
          {
            status: "completed",
            requestFingerprintHash: commandFingerprintHash(cancelCommand),
            responseStatusCode: 200,
            responseBodyHash: sha256(stableJson(cancelMeta)),
            idempotencyMetadata: { commandMeta: cancelMeta },
          },
        ]);
      throw new Error(`Replay should not mutate SQL: ${text}`);
    });
    await expect(
      cancelReplay.repository.cancelManualBooking!(cancelCommand),
    ).resolves.toMatchObject({
      ok: true,
      replayed: true,
      commandMeta: { rearrangedBookingCount: 2 },
    });

    const poisonedMeta = { ...cancelMeta, rearrangedBookingCount: 99 };
    const poisonedReplay = createRepository((text) => {
      if (text === "BEGIN" || text === "ROLLBACK") return ok();
      if (text.includes("FROM platform.idempotency_keys"))
        return ok([
          {
            status: "completed",
            requestFingerprintHash: commandFingerprintHash(cancelCommand),
            responseStatusCode: 200,
            responseBodyHash: sha256(stableJson(cancelMeta)),
            idempotencyMetadata: { commandMeta: poisonedMeta },
          },
        ]);
      if (text.includes("INSERT INTO platform.idempotency_keys")) return ok([], 0);
      throw new Error(`Poisoned replay should not mutate SQL: ${text}`);
    });
    await expect(
      poisonedReplay.repository.cancelManualBooking!(cancelCommand),
    ).resolves.toMatchObject({ ok: false, code: "idempotency_conflict" });

    const duplicateSetup = createRepository(successfulOperationalHandler("checked_in"));
    const duplicateResult = await duplicateSetup.repository.executeCheckInCommand(
      baseCheckInCommand({
        commandId: "cmd-checkin-duplicate",
        idempotencyKey: "pms-checkin-duplicate-001",
      }),
    );

    expect(duplicateResult).toMatchObject({
      ok: false,
      statusCode: 400,
      code: "invalid_status_transition",
    });
    expect(
      duplicateSetup.client.calls.some((call) =>
        call.text.includes("INSERT INTO pms.booking_checkin_records"),
      ),
    ).toBe(false);
  });

  it("updates every assignment when no-show is reservation-wide", async () => {
    const { client, repository } = createRepository(successfulOperationalHandler());

    const result = await repository.executeNoShowCommand(baseNoShowCommand());

    expect(result.ok).toBe(true);
    const assignmentSelect = client.calls.find(
      ({ text }) =>
        text.includes("FROM pms.operational_booking_assignments assignment") &&
        text.includes("assignment.position") &&
        text.includes("FOR UPDATE OF assignment"),
    )!;
    expect(assignmentSelect.values[2]).toBeNull();
    const assignmentUpdate = requiredCall(client, "UPDATE pms.operational_booking_assignments");
    expect(assignmentUpdate.values[0]).toEqual([assignmentOneId, assignmentTwoId]);
  });

  it("appends exact manual no-show adjustments before committing", async () => {
    const { client, repository } = createRepository(manualNoShowHandler());

    await expect(repository.executeNoShowCommand(baseNoShowCommand())).resolves.toMatchObject({
      ok: true,
    });

    const evidence = requiredCall(client, "INSERT INTO booking.nightly_revenue_evidence");
    expect(JSON.parse(String(evidence.values[5]))).toEqual([
      expect.objectContaining({
        occupiedRoomNights: -1,
        economicEvent: "occupancy_adjustment",
        lifecycleState: "no_show",
        grossRoomAmount: "-100.0000",
      }),
      expect.objectContaining({ occupiedRoomNights: -1 }),
    ]);
    expect(client.calls.at(-1)?.text).toBe("COMMIT");
  });

  it("rolls assignment release back when manual no-show evidence fails", async () => {
    const { client, repository } = createRepository(manualNoShowHandler(true));

    await expect(repository.executeNoShowCommand(baseNoShowCommand())).rejects.toThrow(
      "forced nightly evidence failure",
    );

    expect(requiredCall(client, "UPDATE pms.operational_booking_assignments")).toBeDefined();
    expect(client.calls.at(-1)?.text).toBe("ROLLBACK");
  });

  it("ignores malformed no-show assignmentId input instead of narrowing the reservation", async () => {
    const { client, repository } = createRepository(successfulOperationalHandler());
    const command = {
      ...baseNoShowCommand(),
      assignmentId: assignmentOneId,
    } as PmsNoShowCommand;

    const result = await repository.executeNoShowCommand(command);

    expect(result.ok).toBe(true);
    const assignmentSelect = client.calls.find(
      ({ text }) =>
        text.includes("FROM pms.operational_booking_assignments assignment") &&
        text.includes("assignment.position") &&
        text.includes("FOR UPDATE OF assignment"),
    )!;
    expect(assignmentSelect.values[2]).toBeNull();
    const assignmentUpdate = requiredCall(client, "UPDATE pms.operational_booking_assignments");
    expect(assignmentUpdate.values[0]).toEqual([assignmentOneId, assignmentTwoId]);
  });

  it("creates checkout records, snapshots charges, and checks out assignments without finance side effects", async () => {
    const { client, repository } = createRepository(successfulCheckoutHandler());

    const result = await repository.executeCheckOutCommand(baseCheckOutCommand());

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("check-out unexpectedly failed");
    expect(result.checkout).toMatchObject({
      chargesSettled: [expect.objectContaining({ status: "paid" })],
      pendingFlags: ["checkout_charges_unsettled", "finance_settlement_handoff_required"],
      financeHandoff: {
        financeSettlementOwner: "finance",
        providerSettlement: false,
        pendingChargeIds: ["f6855700-0000-0000-0000-000000000002"],
        unsettledPaidChargeIds: ["f6855700-0000-0000-0000-000000000001"],
      },
    });
    expect(result.reservation.checkout).toEqual({
      completedAt: result.checkout.completedAt,
      pendingFlags: result.checkout.pendingFlags,
    });
    expect(result.reservation.assignments).toEqual(
      expect.arrayContaining([expect.objectContaining({ assignmentStatus: "checked_out" })]),
    );

    const checkoutInsert = requiredCall(client, "INSERT INTO pms.booking_checkout_records");
    expect(JSON.parse(String(checkoutInsert.values[5]))).toEqual([
      { stepId: "minibar", status: "completed" },
    ]);
    expect(JSON.parse(String(checkoutInsert.values[6]))).toEqual([
      expect.objectContaining({
        chargeId: "f6855700-0000-0000-0000-000000000001",
        operationalOwnership: {
          owner: "pms",
          financeSettlementOwner: "finance",
          providerSettlement: false,
        },
      }),
    ]);

    const assignmentUpdate = requiredCall(client, "UPDATE pms.operational_booking_assignments");
    expect(assignmentUpdate.values[0]).toBe("checked_out");
    expect(assignmentUpdate.values[1]).toEqual([assignmentOneId, assignmentTwoId]);

    const auditInsert = requiredCall(client, "INSERT INTO platform.product_audit_events");
    expect(auditInsert.values[1]).toBe("2026-08-15T15:45:00.000Z");
    expect(JSON.parse(String(auditInsert.values[11]))).toMatchObject({
      financeSettlementOwner: "finance",
      providerSettlement: false,
      invoicePosting: false,
      payoutTrigger: false,
      reconciliation: false,
    });
    expect(client.calls.some((call) => call.text.includes("finance."))).toBe(false);
    expect(client.calls.some((call) => call.text.includes("platform.outbox_events"))).toBe(false);
  });

  it("rejects assignment-scoped checkouts that settle another assignment charge", async () => {
    const { client, repository } = createRepository((text) => {
      if (text === "BEGIN" || text === "COMMIT" || text === "ROLLBACK") return ok();
      if (text.includes("FROM platform.idempotency_keys")) return ok();
      if (text.includes("INSERT INTO platform.idempotency_keys")) return ok([{ id: "idem" }], 1);
      if (text.includes("FROM pms.operational_booking_assignments")) {
        return ok(assignmentRows("in_house").filter((row) => row.assignmentId === assignmentOneId));
      }
      if (text.includes("pg_advisory_xact_lock")) return ok();
      if (text.includes("room_type_id = ANY") && text.includes("FOR UPDATE")) return ok();
      if (text.includes("FROM pms.booking_checkout_records")) return ok();
      if (text.includes("FROM pms.booking_checkout_charges charge")) {
        expect(text).toContain(
          "($3::uuid IS NULL OR charge.assignment_id IS NULL OR charge.assignment_id = $3::uuid)",
        );
        return ok(
          checkoutChargeRows().filter(
            (row) => row.assignmentId === null || row.assignmentId === assignmentOneId,
          ),
        );
      }
      throw new Error(`Unhandled SQL: ${text}`);
    });

    const result = await repository.executeCheckOutCommand(
      baseCheckOutCommand({
        assignmentId: assignmentOneId,
        chargesSettled: ["f6855700-0000-0000-0000-000000000002"],
      }),
    );

    expect(result).toMatchObject({
      ok: false,
      statusCode: 404,
      code: "charge_not_found",
    });
    const chargeSelect = requiredCall(client, "FROM pms.booking_checkout_charges charge");
    expect(chargeSelect.values).toEqual([propertyId, guestBookingId, assignmentOneId]);
    expect(
      client.calls.some((call) => call.text.includes("INSERT INTO pms.booking_checkout_records")),
    ).toBe(false);
  });

  it("rejects check-out stale versions, invalid transitions, and duplicate checkout records before writes", async () => {
    for (const [name, handler, command] of [
      [
        "stale version",
        successfulCheckoutHandler(),
        baseCheckOutCommand({ expectedVersion: "reservation-v6" }),
      ],
      [
        "invalid transition",
        successfulCheckoutHandler({ assignmentStatus: "assigned" }),
        baseCheckOutCommand(),
      ],
      [
        "duplicate checkout",
        successfulCheckoutHandler({ existingCheckout: true }),
        baseCheckOutCommand(),
      ],
    ] as const) {
      const { client, repository } = createRepository(handler);

      const result = await repository.executeCheckOutCommand(command);

      expect(result.ok, name).toBe(false);
      expect(
        client.calls.some((call) => call.text.includes("INSERT INTO pms.booking_checkout_records")),
        name,
      ).toBe(false);
      expect(
        client.calls.some((call) =>
          call.text.includes("INSERT INTO platform.product_audit_events"),
        ),
        name,
      ).toBe(false);
    }
  });

  it("replays same-key checkout commands from idempotency metadata without repeating writes", async () => {
    const replayCommand = baseCheckOutCommand();
    const replayMeta: PmsCommandMeta = {
      contractVersion: "pms-operations.v1",
      commandId: replayCommand.commandId,
      idempotencyKey: replayCommand.idempotencyKey,
      acceptedAt: "2026-08-18T10:15:00.000Z",
      sideEffects: ["audit_event"],
    };
    const replayCheckout: PmsCheckOutRecord = {
      checkoutRecordId: "f6855a00-0000-0000-0000-000000000001",
      propertyId,
      guestBookingId,
      assignmentId: null,
      completedByUserId: userId,
      completedAt: "2026-08-18T10:15:00.000Z",
      inspectionResults: [{ stepId: "minibar", status: "completed" }],
      chargesSettled: [
        {
          chargeId: "f6855700-0000-0000-0000-000000000001",
          propertyId,
          guestBookingId,
          assignmentId: assignmentOneId,
          label: "Minibar",
          amount: { amountDecimal: "12.00", currency: "EUR" },
          originalAmount: { amountDecimal: "12.00", currency: "EUR" },
          status: "paid",
          createdByUserId: userId,
          createdAt: "2026-08-17T18:00:00.000Z",
          settledAt: "2026-08-18T09:45:00.000Z",
          waivedAt: null,
          operationalOwnership: {
            owner: "pms",
            financeSettlementOwner: "finance",
            providerSettlement: false,
          },
        },
      ],
      pendingFlags: ["finance_settlement_handoff_required"],
      checkoutNotes: "Guest departed at 10:15.",
      financeHandoff: {
        financeSettlementOwner: "finance",
        providerSettlement: false,
        pendingChargeIds: [],
        unsettledPaidChargeIds: ["f6855700-0000-0000-0000-000000000001"],
      },
    };
    const replayFingerprintHash = commandFingerprintHash(replayCommand);
    const { client, repository } = createRepository((text) => {
      if (text === "BEGIN" || text === "COMMIT" || text === "ROLLBACK") return ok();
      if (text.includes("FROM platform.idempotency_keys")) {
        return ok([
          {
            status: "completed",
            requestFingerprintHash: replayFingerprintHash,
            idempotencyMetadata: {
              commandMeta: replayMeta,
              checkout: replayCheckout,
              charges: replayCheckout.chargesSettled,
            },
          },
        ]);
      }
      throw new Error(`Replay should not mutate SQL: ${text}`);
    });

    const result = await repository.executeCheckOutCommand(replayCommand);

    expect(result).toMatchObject({
      ok: true,
      replayed: true,
      commandMeta: replayMeta,
      checkout: replayCheckout,
    });
    expect(
      client.calls.some((call) => call.text.includes("INSERT INTO pms.booking_checkout_records")),
    ).toBe(false);
    expect(
      client.calls.some((call) => call.text.includes("UPDATE pms.operational_booking_assignments")),
    ).toBe(false);
  });
});

function requiredCall(client: RecordingCommandClient, sqlFragment: string): RecordedQuery {
  const call = client.calls.find((entry) => entry.text.includes(sqlFragment));
  if (!call) {
    throw new Error(`Expected SQL call containing ${sqlFragment}`);
  }
  return call;
}

function commandFingerprintHash(
  command: PmsCheckInCommand | PmsCheckOutCommand | PmsManualCancellationCommand,
): string {
  const { audit: _audit, ...fingerprint } = command;
  return sha256(stableJson(fingerprint));
}

function stableJson(value: unknown): string {
  return JSON.stringify(sortJsonValue(value));
}

function sortJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJsonValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => [key, sortJsonValue(entry)]),
  );
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
