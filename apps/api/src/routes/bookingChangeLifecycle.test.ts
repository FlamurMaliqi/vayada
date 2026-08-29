import type { QueryResultRow } from "pg";
import { describe, expect, it } from "vitest";

import {
  bookingHotelChangeDecisionFingerprint,
  createTargetBookingWebCheckoutAdapter,
  type BookingHotelChangeDecisionContext,
  type BookingWebCheckoutCommandContext,
} from "./bookingWebPublic.js";
import type { DirectBookingInventoryReservationPort } from "../platform/inventoryReservation.js";

const propertyId = "8ca5702b-d292-4d68-84ff-34f66cc2e268";
const bookingId = "25828d66-3104-413d-ac75-4fd4926db9ad";
const changeId = "31c26768-bf64-4202-a41d-613621f6a8b7";
const inventoryReceiptId = "41c26768-bf64-4202-a41d-613621f6a8b7";

class LifecyclePool {
  calls: Array<{ text: string; values?: readonly unknown[] }> = [];
  offerAvailable = true;
  offerStayDates = ["2026-08-15", "2026-08-16"];
  booking = {
    guestBookingId: bookingId,
    propertyId,
    publicReference: "B-CHANGE-1",
    lifecycleStatus: "confirmed",
    paymentStatus: "unpaid",
    checkIn: "2026-08-10",
    checkOut: "2026-08-12",
    adults: 2,
    children: 0,
    roomCount: 1,
    currency: "EUR",
    totalAmount: "200.00",
    balanceAmount: "200.00",
    bookingMetadata: {
      paymentMethod: "pay_at_property",
      selectedOffer: {
        publicOfferKey: "room-deluxe:flex",
        roomTypeId: "6e14c338-b483-471f-95bc-47a3bc322910",
        rateType: "flexible",
        addonPurchases: [] as Record<string, unknown>[],
      },
      inventoryReservation: {
        contractVersion: "pms.inventory-reservation.v1",
        owner: "pms",
        source: "booking_engine",
        quoteSessionId: "change-lifecycle-original-quote",
        propertyId,
        roomTypeId: "6e14c338-b483-471f-95bc-47a3bc322910",
        publicOfferKey: "room-deluxe:flex",
        checkIn: "2026-08-10",
        checkOut: "2026-08-12",
        roomCount: 1,
      },
    },
    createdAt: "2026-07-20T10:00:00.000Z",
  };
  changeRequest: Record<string, unknown> | null = null;
  decisionIdempotency: {
    requestFingerprintHash: string;
    status: "in_progress" | "completed";
    idempotencyMetadata: Record<string, unknown>;
  } | null = null;

  async query<T extends QueryResultRow = QueryResultRow>(
    text: string,
    values?: readonly unknown[],
  ): Promise<{ rows: T[] }> {
    this.calls.push({ text, values });
    if (["BEGIN", "COMMIT", "ROLLBACK"].includes(text)) return { rows: [] };
    if (text.includes("FROM hotel_catalog.property_slugs")) {
      return {
        rows: [
          {
            propertyId,
            displayName: "Lifecycle Hotel",
            defaultLocale: "en",
            timezone: "Europe/Berlin",
          } as unknown as T,
        ],
      };
    }
    if (text.includes("FROM hotel_catalog.properties property")) {
      return {
        rows: [
          {
            propertyId,
            displayName: "Lifecycle Hotel",
            defaultLocale: "en",
            timezone: "Europe/Berlin",
          } as unknown as T,
        ],
      };
    }
    if (
      text.includes("UPDATE booking.booking_change_requests change_request") &&
      !text.includes("WITH accepted AS")
    ) {
      this.changeRequest = {
        ...this.changeRequest!,
        status: "declined",
        decisionNote: values?.[3] ?? null,
        decidedAt: values?.[4],
      };
      return { rows: [this.changeRequest as unknown as T] };
    }
    if (
      text.includes("FROM booking.guest_bookings b") ||
      text.includes("FROM booking.guest_bookings booking")
    ) {
      if (text.includes("booking.booking_change_requests change_request")) {
        if (values?.[2] && String(values[2]) !== String(this.changeRequest?.id)) {
          return { rows: [] };
        }
        return { rows: this.changeRequest ? [this.changeRequest as unknown as T] : [] };
      }
      return { rows: [{ ...this.booking } as unknown as T] };
    }
    if (text.includes("INSERT INTO platform.idempotency_keys")) {
      if (values?.[0] === "booking.change-request.decision") {
        if (this.decisionIdempotency) return { rows: [] };
        this.decisionIdempotency = {
          requestFingerprintHash: String(values[2]),
          status: "in_progress",
          idempotencyMetadata: JSON.parse(String(values[6])),
        };
      }
      return {
        rows: [{ id: "62c51ce4-c642-4727-b914-ec9f56297ea7" } as unknown as T],
      };
    }
    if (
      text.includes("FROM platform.idempotency_keys") &&
      values?.[0] === "booking.change-request.decision"
    ) {
      return {
        rows: this.decisionIdempotency ? [this.decisionIdempotency as unknown as T] : [],
      };
    }
    if (
      text.includes("UPDATE platform.idempotency_keys") &&
      values?.[0] === "booking.change-request.decision"
    ) {
      if (
        !this.decisionIdempotency ||
        this.decisionIdempotency.status !== "in_progress" ||
        this.decisionIdempotency.requestFingerprintHash !== values?.[3]
      ) {
        return { rows: [] };
      }
      this.decisionIdempotency = {
        requestFingerprintHash: this.decisionIdempotency.requestFingerprintHash,
        status: "completed",
        idempotencyMetadata: JSON.parse(String(values[8])),
      };
      return {
        rows: [{ id: "62c51ce4-c642-4727-b914-ec9f56297ea7" } as unknown as T],
      };
    }
    if (text.includes("SELECT id") && text.includes("FOR UPDATE")) {
      return { rows: [{ id: bookingId } as unknown as T] };
    }
    if (
      text.includes("FROM booking.booking_change_requests") &&
      text.includes("status = 'pending'")
    ) {
      return {
        rows: this.changeRequest?.status === "pending" ? [this.changeRequest as unknown as T] : [],
      };
    }
    if (text.includes("FROM booking.booking_change_requests change_request")) {
      return { rows: this.changeRequest ? [this.changeRequest as unknown as T] : [] };
    }
    if (text.includes("FROM distribution.public_room_offer_snapshots offer")) {
      if (!this.offerAvailable) return { rows: [] };
      return {
        rows: [
          {
            publicOfferKey: "room-deluxe:flex",
            roomTypeId: "6e14c338-b483-471f-95bc-47a3bc322910",
            ratePlanId: "c427384a-89c4-4bd7-a953-45fa216851f6",
            roomSummary: { name: "Deluxe Room" },
            rateSummary: { name: "Flexible", rateType: "flexible" },
            occupancy: { maxAdults: 2, maxChildren: 0 },
            publicPolicy: {},
            paymentOptions: ["pay_at_property"],
            availableRooms: 1,
            nightlyRoomAmounts: this.offerStayDates.map((stayDate) => ({
              stayDate,
              grossRoomAmount: "150.00",
            })),
            roomTotal: "300.00",
            taxesAndFees: "20.00",
            discounts: "10.00",
            currency: "EUR",
            generatedAt: "2026-07-22T10:00:00.000Z",
            sourceFreshness: { pms: { status: "fresh" } },
            profileCapabilities: { payAtProperty: true },
          } as unknown as T,
        ],
      };
    }
    if (text.includes("INSERT INTO booking.booking_change_requests")) {
      this.changeRequest = {
        id: changeId,
        guestBookingId: bookingId,
        status: "pending",
        requestedChanges: JSON.parse(String(values?.[1])),
        decisionNote: null,
        decidedAt: null,
        createdAt: "2026-07-22T10:00:00.000Z",
      };
      return { rows: [this.changeRequest as unknown as T] };
    }
    if (text.includes("WITH accepted AS")) {
      this.booking = {
        ...this.booking,
        checkIn: String(values?.[4]),
        checkOut: String(values?.[5]),
        totalAmount: String(values?.[6]),
        balanceAmount: String(values?.[6]),
        bookingMetadata: JSON.parse(String(values?.[7])),
      };
      this.changeRequest = { ...this.changeRequest!, status: "accepted", decidedAt: values?.[3] };
      return { rows: [{ ...this.booking } as unknown as T] };
    }
    if (
      text.includes("FROM booking.booking_change_requests") &&
      text.includes("WHERE id = $1::uuid")
    ) {
      return { rows: this.changeRequest ? [this.changeRequest as unknown as T] : [] };
    }
    return { rows: [] };
  }

  async connect() {
    return { query: this.query.bind(this), release() {} };
  }

  async end() {}
}

function command(operation: string, suffix: string): BookingWebCheckoutCommandContext {
  return {
    operation,
    requestId: `request-${suffix}`,
    correlationId: `correlation-${suffix}`,
    idempotencyKey: `idempotency-${suffix}`,
    fingerprint: suffix.repeat(64).slice(0, 64),
    occurredAt: new Date("2026-07-22T10:00:00.000Z"),
  };
}

function decisionCommand(input: {
  bookingId: string;
  changeRequestId: string;
  decision: "accept" | "decline";
  note: string | null;
  idempotencyKey: string;
  requestId: string;
  occurredAt?: Date;
}): Omit<BookingHotelChangeDecisionContext, "actorUserId"> {
  return {
    requestId: input.requestId,
    correlationId: `${input.requestId}-correlation`,
    idempotencyKey: input.idempotencyKey,
    fingerprint: bookingHotelChangeDecisionFingerprint({
      propertyId,
      bookingId: input.bookingId,
      changeRequestId: input.changeRequestId,
      decision: input.decision,
      note: input.note,
    }),
    occurredAt: input.occurredAt ?? new Date("2026-07-22T11:00:00.000Z"),
  };
}

function inventoryPort() {
  const state = { reserves: 0, releases: 0 };
  const port: DirectBookingInventoryReservationPort = {
    async reserve() {
      state.reserves += 1;
      return {
        contractVersion: "pms-inventory-reservation-lifecycle.v1",
        owner: "pms",
        receiptId: inventoryReceiptId,
      };
    },
    async release() {
      state.releases += 1;
    },
  };
  return { port, state };
}

describe("target booking date-change lifecycle", () => {
  it("resolves opaque reservation credit through the exact PMS receipt scope", async () => {
    const pool = new LifecyclePool();
    const inventory = inventoryPort();
    let creditInput: unknown;
    inventory.port.availabilityCredit = async (input) => {
      creditInput = input;
      return { checkIn: "2026-08-10", checkOut: "2026-08-12", roomCount: 1 };
    };
    pool.offerStayDates = ["2026-09-15", "2026-09-16"];
    // prettier-ignore
    pool.booking.bookingMetadata.inventoryReservation = { contractVersion: "pms-inventory-reservation-lifecycle.v1", owner: "pms", receiptId: inventoryReceiptId } as never;
    // prettier-ignore
    const adapter = createTargetBookingWebCheckoutAdapter({ connectionString: "postgres://unused", pool: pool as never, inventoryReservationPort: inventory.port });

    // prettier-ignore
    const preview = await adapter.previewChangeRequest("hotel", bookingId, { guestEmail: "guest@example.test", checkIn: "2026-09-15", checkOut: "2026-09-17" });
    expect(preview).toMatchObject({ blocked: false, available: true });
    // prettier-ignore
    expect(creditInput).toMatchObject({
      propertyId, reservation: { receiptId: inventoryReceiptId }, roomTypeId: "6e14c338-b483-471f-95bc-47a3bc322910", publicOfferKey: "room-deluxe:flex", checkIn: "2026-08-10", checkOut: "2026-08-12", roomCount: 1 });
    expect(pool.calls.some((call) => call.text.includes("pms.inventory_reservation"))).toBe(false);
  });

  it("blocks unsupported add-ons, invalid availability, and no-op dates in previews", async () => {
    const pool = new LifecyclePool();
    const inventory = inventoryPort();
    const adapter = createTargetBookingWebCheckoutAdapter({
      connectionString: "postgres://unused",
      pool: pool as never,
      inventoryReservationPort: inventory.port,
    });

    await expect(
      adapter.previewChangeRequest("hotel", bookingId, {
        guestEmail: "guest@example.test",
        checkIn: "2026-08-10",
        checkOut: "2026-08-12",
      }),
    ).resolves.toMatchObject({ blocked: true, available: false });
    await expect(
      adapter.previewChangeRequest("hotel", bookingId, {
        guestEmail: "guest@example.test",
        checkIn: "2026-08-15",
        checkOut: "2026-08-17",
        addonIds: ["breakfast"],
      }),
    ).resolves.toMatchObject({
      blocked: true,
      blockReason: "Only booking date changes are supported right now.",
    });
    pool.booking.bookingMetadata.selectedOffer.addonPurchases = [{}];
    pool.booking.bookingMetadata.paymentMethod = "bank_transfer";
    await expect(
      adapter.previewChangeRequest("hotel", bookingId, {
        guestEmail: "guest@example.test",
        checkIn: "2026-08-15",
        checkOut: "2026-08-17",
      }),
    ).resolves.toMatchObject({
      blocked: true,
      blockReason: "Bookings with purchased add-ons cannot be changed online yet.",
    });
    pool.booking.bookingMetadata.selectedOffer.addonPurchases = [];
    await expect(
      adapter.submitChangeRequest(
        "hotel",
        bookingId,
        {
          guestEmail: "guest@example.test",
          checkIn: "2026-08-15",
          checkOut: "2026-08-17",
        },
        command("booking-change-submit", "f"),
      ),
    ).rejects.toMatchObject({ statusCode: 409 });
    pool.booking.bookingMetadata.paymentMethod = "pay_at_property";
    pool.offerAvailable = false;
    await expect(
      adapter.previewChangeRequest("hotel", bookingId, {
        guestEmail: "guest@example.test",
        checkIn: "2026-08-15",
        checkOut: "2026-08-17",
      }),
    ).resolves.toMatchObject({ blocked: true, available: false });
  });

  it("stores one complete pending snapshot without handing an unchanged booking to PMS", async () => {
    const pool = new LifecyclePool();
    const inventory = inventoryPort();
    const adapter = createTargetBookingWebCheckoutAdapter({
      connectionString: "postgres://unused",
      pool: pool as never,
      inventoryReservationPort: inventory.port,
    });
    const request = {
      guestEmail: "guest@example.test",
      checkIn: "2026-08-15",
      checkOut: "2026-08-17",
    };

    await expect(
      adapter.submitChangeRequest(
        "hotel",
        bookingId,
        request,
        command("booking-change-submit", "a"),
      ),
    ).resolves.toMatchObject({
      id: changeId,
      status: "pending",
      oldCheckIn: "2026-08-10",
      requestedCheckIn: "2026-08-15",
      oldTotal: 200,
      newTotal: 310,
      priceDifference: 110,
      currency: "EUR",
    });
    expect(pool.calls.some((call) => call.text.includes("INSERT INTO platform.jobs"))).toBe(false);

    await expect(
      adapter.submitChangeRequest(
        "hotel",
        bookingId,
        request,
        command("booking-change-submit", "b"),
      ),
    ).rejects.toMatchObject({ statusCode: 409 });
  });

  it("atomically accepts a capacity-one overlapping change with its exact PMS receipt", async () => {
    const pool = new LifecyclePool();
    const inventory = inventoryPort();
    pool.offerStayDates = ["2026-08-11", "2026-08-12"];
    const adapter = createTargetBookingWebCheckoutAdapter({
      connectionString: "postgres://unused",
      pool: pool as never,
      inventoryReservationPort: inventory.port,
    });
    await adapter.submitChangeRequest(
      "hotel",
      bookingId,
      { guestEmail: "guest@example.test", checkIn: "2026-08-11", checkOut: "2026-08-13" },
      command("booking-change-submit", "c"),
    );

    await expect(
      adapter.acceptChangeRequest(propertyId, bookingId, changeId, {
        ...decisionCommand({
          bookingId,
          changeRequestId: changeId,
          decision: "accept",
          note: null,
          idempotencyKey: "accept-idempotency",
          requestId: "accept-request",
        }),
        actorUserId: "6fdb0d6a-aafb-44ee-83b0-2b070c33d46e",
      }),
    ).resolves.toMatchObject({ status: "approved", newTotal: 310 });
    expect(pool.booking).toMatchObject({
      checkIn: "2026-08-11",
      checkOut: "2026-08-13",
      totalAmount: "310.00",
      balanceAmount: "310.00",
    });
    expect(inventory.state).toEqual({ releases: 1, reserves: 1 });
    const handoff = pool.calls.find((call) => call.text.includes("INSERT INTO platform.jobs"));
    expect(handoff?.values?.[0]).toContain(changeId);
    expect(String(handoff?.values?.[6])).toContain(`:${changeId}`);
    // prettier-ignore
    expect(JSON.parse(String(handoff?.values?.[6]))).toMatchObject({ operation: "update", inventoryReservation: { receiptId: inventoryReceiptId } });

    const laterChangeId = "27d0df4c-87b9-4a1c-9f43-e1d2314c6e59";
    pool.changeRequest = {
      id: laterChangeId,
      guestBookingId: bookingId,
      status: "pending",
      requestedChanges: {
        oldCheckIn: "2026-08-11",
        oldCheckOut: "2026-08-13",
        requestedCheckIn: "2026-08-20",
        requestedCheckOut: "2026-08-22",
        newTotal: 320,
        currency: "EUR",
      },
      decisionNote: null,
      decidedAt: null,
      createdAt: "2026-07-22T12:00:00.000Z",
    };
    await expect(
      adapter.acceptChangeRequest(propertyId, bookingId, changeId, {
        ...decisionCommand({
          bookingId,
          changeRequestId: changeId,
          decision: "accept",
          note: null,
          idempotencyKey: "accept-idempotency",
          requestId: "accept-retry-request",
          occurredAt: new Date("2026-07-22T11:00:01.000Z"),
        }),
        actorUserId: "6fdb0d6a-aafb-44ee-83b0-2b070c33d46e",
      }),
    ).resolves.toMatchObject({ status: "approved", newTotal: 310 });
    expect(pool.changeRequest).toMatchObject({ id: laterChangeId, status: "pending" });
    expect(inventory.state).toEqual({ releases: 1, reserves: 1 });
    expect(
      pool.calls.filter((call) => call.text.includes("INSERT INTO platform.jobs")),
    ).toHaveLength(1);

    await expect(
      adapter.acceptChangeRequest(propertyId, bookingId, laterChangeId, {
        ...decisionCommand({
          bookingId,
          changeRequestId: laterChangeId,
          decision: "accept",
          note: null,
          idempotencyKey: "accept-idempotency",
          requestId: "accept-mismatched-request",
        }),
        actorUserId: "6fdb0d6a-aafb-44ee-83b0-2b070c33d46e",
      }),
    ).rejects.toMatchObject({
      statusCode: 409,
      message: "Idempotency key was already used for a different request.",
    });
    expect(pool.changeRequest).toMatchObject({ id: laterChangeId, status: "pending" });
    expect(inventory.state).toEqual({ releases: 1, reserves: 1 });
  });

  it("binds decline replay to the exact request and normalized decision note", async () => {
    const pool = new LifecyclePool();
    const inventory = inventoryPort();
    pool.changeRequest = {
      id: changeId,
      guestBookingId: bookingId,
      status: "pending",
      requestedChanges: {
        oldCheckIn: "2026-08-10",
        oldCheckOut: "2026-08-12",
        requestedCheckIn: "2026-08-15",
        requestedCheckOut: "2026-08-17",
        newTotal: 310,
        currency: "EUR",
      },
      decisionNote: null,
      decidedAt: null,
      createdAt: "2026-07-22T10:00:00.000Z",
    };
    const adapter = createTargetBookingWebCheckoutAdapter({
      connectionString: "postgres://unused",
      pool: pool as never,
      inventoryReservationPort: inventory.port,
    });
    const context = {
      ...decisionCommand({
        bookingId,
        changeRequestId: changeId,
        decision: "decline" as const,
        note: "Dates are closed",
        idempotencyKey: "decline-idempotency",
        requestId: "decline-request",
      }),
      actorUserId: "6fdb0d6a-aafb-44ee-83b0-2b070c33d46e",
    };

    await expect(
      adapter.declineChangeRequest(propertyId, bookingId, changeId, "Dates are closed", context),
    ).resolves.toMatchObject({
      id: changeId,
      status: "declined",
      declineReason: "Dates are closed",
    });

    const laterChangeId = "27d0df4c-87b9-4a1c-9f43-e1d2314c6e59";
    pool.changeRequest = {
      id: laterChangeId,
      guestBookingId: bookingId,
      status: "pending",
      requestedChanges: {
        requestedCheckIn: "2026-08-20",
        requestedCheckOut: "2026-08-22",
        newTotal: 320,
        currency: "EUR",
      },
      decisionNote: null,
      decidedAt: null,
      createdAt: "2026-07-22T12:00:00.000Z",
    };

    await expect(
      adapter.declineChangeRequest(propertyId, bookingId, changeId, "Dates are closed", {
        ...context,
        requestId: "decline-retry-request",
        correlationId: "decline-retry-correlation",
      }),
    ).resolves.toMatchObject({ id: changeId, status: "declined" });
    expect(pool.changeRequest).toMatchObject({ id: laterChangeId, status: "pending" });

    await expect(
      adapter.declineChangeRequest(propertyId, bookingId, changeId, "Different note", {
        ...decisionCommand({
          bookingId,
          changeRequestId: changeId,
          decision: "decline",
          note: "Different note",
          idempotencyKey: "decline-idempotency",
          requestId: "decline-note-mismatch",
        }),
        actorUserId: context.actorUserId,
      }),
    ).rejects.toMatchObject({
      statusCode: 409,
      message: "Idempotency key was already used for a different request.",
    });
    expect(pool.changeRequest).toMatchObject({ id: laterChangeId, status: "pending" });
    expect(inventory.state).toEqual({ releases: 0, reserves: 0 });
  });

  it("fails closed for paid bookings before touching inventory", async () => {
    const pool = new LifecyclePool();
    const inventory = inventoryPort();
    pool.booking.paymentStatus = "paid";
    pool.changeRequest = {
      id: changeId,
      guestBookingId: bookingId,
      status: "pending",
      requestedChanges: {
        oldCheckIn: "2026-08-10",
        oldCheckOut: "2026-08-12",
        requestedCheckIn: "2026-08-15",
        requestedCheckOut: "2026-08-17",
        newTotal: 310,
        currency: "EUR",
      },
      decisionNote: null,
      decidedAt: null,
      createdAt: "2026-07-22T10:00:00.000Z",
    };
    const adapter = createTargetBookingWebCheckoutAdapter({
      connectionString: "postgres://unused",
      pool: pool as never,
      inventoryReservationPort: inventory.port,
    });

    await expect(
      adapter.previewChangeRequest("hotel", bookingId, {
        guestEmail: "guest@example.test",
        checkIn: "2026-08-15",
        checkOut: "2026-08-17",
      }),
    ).resolves.toMatchObject({
      blocked: true,
      blockReason: "Paid bookings require a payment adjustment and cannot be changed online yet.",
    });

    await expect(
      adapter.acceptChangeRequest(propertyId, bookingId, changeId, {
        ...decisionCommand({
          bookingId,
          changeRequestId: changeId,
          decision: "accept",
          note: null,
          idempotencyKey: "paid-idempotency",
          requestId: "paid-request",
        }),
        actorUserId: "6fdb0d6a-aafb-44ee-83b0-2b070c33d46e",
      }),
    ).rejects.toMatchObject({ statusCode: 409 });
    expect(inventory.state).toEqual({ releases: 0, reserves: 0 });
  });
});
