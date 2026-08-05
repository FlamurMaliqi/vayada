import { describe, expect, it } from "vitest";

import {
  PMS_RESERVATION_CONTRACT_VERSION,
  PMS_RESERVATION_ERROR_CODES,
  PMS_PRICING_CURRENCY_CAPABILITIES_CONTRACT_VERSION,
  parsePmsPricingCurrencyCapabilities,
  ROOM_MEDIA_MAX_ITEMS,
  type CreatePmsReservationCommand,
  type GetPmsOperationalReservationQuery,
  type PmsReservationError,
  type PmsReservationErrorCode,
  type PmsReservationHandoffResult,
  type PmsReservationSink,
} from "./index.js";

describe("@vayada/domain-pms", () => {
  it("exports the reservation contract version and enum values", () => {
    expect(PMS_RESERVATION_CONTRACT_VERSION).toBe("pms-reservation.v1");
    expect(PMS_RESERVATION_ERROR_CODES).toContain("PMS_DISCONNECTED");
    expect(PMS_RESERVATION_ERROR_CODES).toContain("IDEMPOTENCY_CONFLICT");
  });

  it("exports the room-media command contract", () => {
    expect(ROOM_MEDIA_MAX_ITEMS).toBe(20);
  });

  it("exports the strict pricing-currency capability contract", () => {
    expect(PMS_PRICING_CURRENCY_CAPABILITIES_CONTRACT_VERSION).toBe(
      "pms-pricing-currency-capabilities.v1",
    );
    expect(
      parsePmsPricingCurrencyCapabilities({
        contractVersion: PMS_PRICING_CURRENCY_CAPABILITIES_CONTRACT_VERSION,
        supportedCurrencies: [{ code: "EUR", scale: 2 }],
      }),
    ).not.toBeNull();
  });

  it("allows downstream packages to implement the PMS reservation sink", async () => {
    const command: CreatePmsReservationCommand = {
      contractVersion: PMS_RESERVATION_CONTRACT_VERSION,
      commandId: "cmd_123",
      idempotencyKey: "pms.reservation.create:property:prop_123:booking:book_123:v1",
      audit: {
        requestId: "req_123",
        correlationId: "corr_123",
        organizationId: "org_123",
        propertyId: "prop_123",
        actorType: "guest",
        source: "booking_engine",
        occurredAt: "2026-06-05T14:16:42.000Z",
      },
      target: {
        propertyId: "prop_123",
        provider: "vayada_pms",
        connectionId: "conn_123",
        requiredCapabilities: ["create_reservation"],
      },
      guestBooking: {
        guestBookingId: "book_123",
        bookingReference: "VAY-2026-0001",
        status: "confirmed",
        createdAt: "2026-06-05T14:16:42.000Z",
        source: "direct_booking",
        locale: "en",
      },
      stay: {
        checkInDate: "2026-09-12",
        checkOutDate: "2026-09-15",
        adults: 2,
        children: 0,
        numberOfRooms: 1,
      },
      guests: {
        primary: {
          firstName: "Ada",
          lastName: "Lovelace",
          email: "ada@example.com",
        },
      },
      bookedOffer: {
        roomTypeId: "room_type_123",
        roomName: "Suite",
      },
      pricing: {
        roomTotal: { amountDecimal: "360.00", currency: "EUR" },
        grandTotal: { amountDecimal: "396.00", currency: "EUR" },
      },
      payment: {
        paymentStatus: "authorized",
        paymentMethod: "card",
      },
      policy: {},
    };

    const sink: PmsReservationSink = {
      async createReservation(received) {
        expect(received).toBe(command);
        return {
          contractVersion: PMS_RESERVATION_CONTRACT_VERSION,
          commandId: received.commandId,
          idempotencyKey: received.idempotencyKey,
          outcome: "succeeded",
          guestBookingId: received.guestBooking.guestBookingId,
          pmsReservationRef: "pms_res_123",
          auditEventId: "audit_123",
          status: "confirmed",
        };
      },
      async updateReservation() {
        throw new Error("not used in this contract export test");
      },
      async cancelReservation() {
        throw new Error("not used in this contract export test");
      },
    };

    await expect(sink.createReservation(command)).resolves.toMatchObject({
      outcome: "succeeded",
      pmsReservationRef: "pms_res_123",
    });
  });

  it("requires an operational reservation identifier in get queries", () => {
    // @ts-expect-error propertyId alone is ambiguous and must not satisfy the contract.
    const invalidQuery: GetPmsOperationalReservationQuery = { propertyId: "prop_123" };

    const validQuery: GetPmsOperationalReservationQuery = {
      propertyId: "prop_123",
      guestBookingId: "book_123",
    };

    const errorCode: PmsReservationErrorCode = "PMS_DISCONNECTED";

    expect(invalidQuery.propertyId).toBe("prop_123");
    expect(validQuery).toEqual({
      propertyId: "prop_123",
      guestBookingId: "book_123",
    });
    expect(errorCode).toBe("PMS_DISCONNECTED");
  });

  it("requires typed errors for failed reservation handoffs", () => {
    const pmsError: PmsReservationError = {
      code: "PMS_DISCONNECTED",
      retryable: true,
      userVisibleCategory: "temporary_unavailable",
      sanitizedMessage: "PMS connection is temporarily unavailable.",
    };

    // @ts-expect-error failed outcomes must include a typed PmsReservationError.
    const failedWithoutError: PmsReservationHandoffResult = {
      contractVersion: PMS_RESERVATION_CONTRACT_VERSION,
      commandId: "cmd_123",
      idempotencyKey: "pms.reservation.create:property:prop_123:booking:book_123:v1",
      outcome: "failed",
      guestBookingId: "book_123",
      auditEventId: "audit_123",
    };

    const failedWithError: PmsReservationHandoffResult = {
      contractVersion: PMS_RESERVATION_CONTRACT_VERSION,
      commandId: "cmd_123",
      idempotencyKey: "pms.reservation.create:property:prop_123:booking:book_123:v1",
      outcome: "failed",
      guestBookingId: "book_123",
      auditEventId: "audit_123",
      error: pmsError,
    };

    // @ts-expect-error non-failed outcomes must not carry failure errors.
    const succeededWithError: PmsReservationHandoffResult = {
      contractVersion: PMS_RESERVATION_CONTRACT_VERSION,
      commandId: "cmd_123",
      idempotencyKey: "pms.reservation.create:property:prop_123:booking:book_123:v1",
      outcome: "succeeded",
      guestBookingId: "book_123",
      auditEventId: "audit_123",
      error: pmsError,
    };

    expect(failedWithoutError.outcome).toBe("failed");
    expect(failedWithError.error.code).toBe("PMS_DISCONNECTED");
    expect(succeededWithError.outcome).toBe("succeeded");
  });
});

describe("@vayada/domain-pms RoomInventoryReadPort contract", () => {
  it("RoomInventoryReadPort is satisfied by an in-memory stub (no PMS DB required)", async () => {
    const stub: import("./index.js").RoomInventoryReadPort = {
      async getRoomInventorySnapshot(propertyId) {
        if (propertyId === "prop_alpenrose") {
          return { propertyId, activeRoomCount: 12, capturedAt: "2026-06-08T07:00:00.000Z" };
        }
        return null;
      },
    };

    const snapshot = await stub.getRoomInventorySnapshot("prop_alpenrose");
    expect(snapshot).not.toBeNull();
    expect(snapshot!.activeRoomCount).toBe(12);
    expect(snapshot!.propertyId).toBe("prop_alpenrose");
    expect(snapshot!.capturedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("returns null for a property with no PMS rooms configured", async () => {
    const stub: import("./index.js").RoomInventoryReadPort = {
      async getRoomInventorySnapshot() {
        return null;
      },
    };

    const snapshot = await stub.getRoomInventorySnapshot("prop_unknown");
    expect(snapshot).toBeNull();
  });

  it("activeRoomCount is a non-negative integer", async () => {
    const stub: import("./index.js").RoomInventoryReadPort = {
      async getRoomInventorySnapshot(propertyId) {
        return { propertyId, activeRoomCount: 0, capturedAt: "2026-06-08T07:00:00.000Z" };
      },
    };

    const snapshot = await stub.getRoomInventorySnapshot("prop_new");
    expect(snapshot!.activeRoomCount).toBeGreaterThanOrEqual(0);
    expect(Number.isInteger(snapshot!.activeRoomCount)).toBe(true);
  });
});
