import { describe, expect, it } from "vitest";

import {
  PMS_RESERVATION_CONTRACT_VERSION,
  type CreatePmsReservationCommand,
  type PmsReservationError,
  type PmsReservationHandoffResult,
  type PmsReservationSink,
} from "@vayada/domain-pms";

import {
  buildCreatePmsReservationCommand,
  buildCreateReservationIdempotencyKey,
  BookingPmsHandoffContractError,
  handOffCommittedBookingToPms,
  type BookingDashboardMetricsReadModel,
  type BookingDashboardMetricsReadPort,
  type BookingSourceMixReadModel,
  type BookingSparklineReadModel,
  type BookingPmsReservationHandoffInput,
} from "./index.js";

describe("@vayada/domain-booking PMS reservation handoff", () => {
  it("builds deterministic create commands from committed guest bookings", () => {
    const input = handoffInput();
    const command = buildCreatePmsReservationCommand(input);

    expect(command).toMatchObject({
      contractVersion: PMS_RESERVATION_CONTRACT_VERSION,
      idempotencyKey: "pms.reservation.create:property:prop_alpenrose:booking:book_123:v1",
      audit: {
        requestId: "req_123",
        correlationId: "corr_123",
        organizationId: "org_hotel_alpenrose",
        propertyId: "prop_alpenrose",
        actorType: "guest",
        source: "booking_engine",
      },
      target: {
        propertyId: "prop_alpenrose",
        provider: "vayada_pms",
        connectionId: "conn_vayada_pms_alpenrose",
        requiredCapabilities: ["create_reservation"],
      },
      guestBooking: {
        guestBookingId: "book_123",
        bookingReference: "VAY-2026-0001",
        status: "confirmed",
        source: "direct_booking",
      },
      inventoryReservation: {
        receiptId: "c9fccec2-eb4c-4c35-bfd3-02a748c2e117",
      },
      stay: {
        checkInDate: "2026-09-12",
        checkOutDate: "2026-09-15",
      },
    });
    expect(command.commandId).toMatch(/^cmd_pms_create_[a-f0-9]{24}$/);
    expect(buildCreatePmsReservationCommand(input).commandId).toBe(command.commandId);
  });

  it("submits the command through the PMS sink interface and records succeeded handoff state", async () => {
    const input = handoffInput();
    const sink = fakeSink((command) => ({
      contractVersion: PMS_RESERVATION_CONTRACT_VERSION,
      commandId: command.commandId,
      idempotencyKey: command.idempotencyKey,
      outcome: "succeeded",
      guestBookingId: command.guestBooking.guestBookingId,
      pmsReservationRef: "pms_res_123",
      operationalReservationId: "ops_res_123",
      auditEventId: "audit_123",
      status: "confirmed",
    }));

    const state = await handOffCommittedBookingToPms(sink, input);

    expect(state).toMatchObject({
      guestBookingId: "book_123",
      bookingReference: "VAY-2026-0001",
      propertyId: "prop_alpenrose",
      status: "synced",
      outcome: "succeeded",
      pmsReservationRef: "pms_res_123",
      operationalReservationId: "ops_res_123",
      auditEventId: "audit_123",
    });
  });

  it("keeps accepted async handoffs in Booking-owned pending state", async () => {
    const state = await handOffCommittedBookingToPms(
      fakeSink((command) => ({
        contractVersion: PMS_RESERVATION_CONTRACT_VERSION,
        commandId: command.commandId,
        idempotencyKey: command.idempotencyKey,
        outcome: "accepted",
        guestBookingId: command.guestBooking.guestBookingId,
        auditEventId: "audit_accepted",
        status: "pending_handoff",
        providerRequestId: "provider_req_123",
        retryAfter: "2026-09-01T10:05:00.000Z",
      })),
      handoffInput(),
    );

    expect(state).toMatchObject({
      status: "accepted_async",
      outcome: "accepted",
      providerRequestId: "provider_req_123",
      retryAfter: "2026-09-01T10:05:00.000Z",
    });
  });

  it("maps duplicate replay outcomes without treating them as new PMS writes", async () => {
    const state = await handOffCommittedBookingToPms(
      fakeSink((command) => ({
        contractVersion: PMS_RESERVATION_CONTRACT_VERSION,
        commandId: command.commandId,
        idempotencyKey: command.idempotencyKey,
        outcome: "duplicate_replayed",
        guestBookingId: command.guestBooking.guestBookingId,
        pmsReservationRef: "pms_existing_123",
        auditEventId: "audit_duplicate",
        status: "confirmed",
      })),
      handoffInput(),
    );

    expect(state).toMatchObject({
      status: "duplicate_replayed",
      outcome: "duplicate_replayed",
      pmsReservationRef: "pms_existing_123",
    });
  });

  it.each([
    {
      code: "PMS_DISCONNECTED" as const,
      retryable: false,
      expectedStatus: "manual_review_required",
      userVisibleCategory: "configuration_required" as const,
    },
    {
      code: "MAPPING_MISSING" as const,
      retryable: false,
      expectedStatus: "manual_review_required",
      userVisibleCategory: "configuration_required" as const,
    },
    {
      code: "UNSUPPORTED_CAPABILITY" as const,
      retryable: false,
      expectedStatus: "manual_review_required",
      userVisibleCategory: "configuration_required" as const,
    },
    {
      code: "RETRYABLE_INTEGRATION_FAILURE" as const,
      retryable: true,
      expectedStatus: "retry_pending",
      userVisibleCategory: "temporary_unavailable" as const,
    },
  ])(
    "maps $code failures into Booking handoff state",
    async ({ code, retryable, expectedStatus, userVisibleCategory }) => {
      const state = await handOffCommittedBookingToPms(
        fakeSink((command) => ({
          contractVersion: PMS_RESERVATION_CONTRACT_VERSION,
          commandId: command.commandId,
          idempotencyKey: command.idempotencyKey,
          outcome: "failed",
          guestBookingId: command.guestBooking.guestBookingId,
          auditEventId: `audit_${code.toLowerCase()}`,
          error: pmsError({
            code,
            retryable,
            userVisibleCategory,
          }),
        })),
        handoffInput(),
      );

      expect(state).toMatchObject({
        status: expectedStatus,
        outcome: "failed",
        error: {
          code,
          retryable,
          userVisibleCategory,
        },
      });
    },
  );

  it("uses the documented idempotency key format", () => {
    expect(
      buildCreateReservationIdempotencyKey({
        propertyId: "prop_123",
        guestBookingId: "book_123",
      }),
    ).toBe("pms.reservation.create:property:prop_123:booking:book_123:v1");
  });

  it("rejects PMS results that do not correlate to the submitted command", async () => {
    await expect(
      handOffCommittedBookingToPms(
        fakeSink((command) => ({
          contractVersion: PMS_RESERVATION_CONTRACT_VERSION,
          commandId: command.commandId,
          idempotencyKey: "pms.reservation.create:property:other:booking:other:v1",
          outcome: "succeeded",
          guestBookingId: "other_booking",
          pmsReservationRef: "pms_other",
          auditEventId: "audit_mismatch",
          status: "confirmed",
        })),
        handoffInput(),
      ),
    ).rejects.toThrow(BookingPmsHandoffContractError);
  });
});

function fakeSink(
  createReservation: (command: CreatePmsReservationCommand) => PmsReservationHandoffResult,
): Pick<PmsReservationSink, "createReservation"> {
  return {
    async createReservation(command) {
      return createReservation(command);
    },
  };
}

function pmsError(input: {
  code: PmsReservationError["code"];
  retryable: boolean;
  userVisibleCategory: PmsReservationError["userVisibleCategory"];
}): PmsReservationError {
  return {
    code: input.code,
    retryable: input.retryable,
    userVisibleCategory: input.userVisibleCategory,
    sanitizedMessage: `${input.code} fixture`,
  };
}

function handoffInput(): BookingPmsReservationHandoffInput {
  return {
    requestId: "req_123",
    correlationId: "corr_123",
    occurredAt: "2026-09-01T10:00:00.000Z",
    connection: {
      provider: "vayada_pms",
      connectionId: "conn_vayada_pms_alpenrose",
    },
    booking: {
      guestBookingId: "book_123",
      bookingReference: "VAY-2026-0001",
      propertyId: "prop_alpenrose",
      organizationId: "org_hotel_alpenrose",
      createdAt: "2026-09-01T09:59:30.000Z",
      locale: "en",
      inventoryReservation: {
        contractVersion: "pms-inventory-reservation-lifecycle.v1",
        owner: "pms",
        receiptId: "c9fccec2-eb4c-4c35-bfd3-02a748c2e117",
      },
      stay: {
        checkInDate: "2026-09-12",
        checkOutDate: "2026-09-15",
        adults: 2,
        children: 0,
        numberOfRooms: 1,
        estimatedArrivalTime: "16:00",
        specialRequests: "Late arrival",
      },
      guests: {
        primary: {
          firstName: "Ada",
          lastName: "Lovelace",
          email: "ada@example.test",
          phone: "+49123456789",
          country: "GB",
        },
        additional: [
          {
            firstName: "Grace",
            lastName: "Hopper",
          },
        ],
      },
      bookedOffer: {
        roomTypeId: "room_deluxe",
        ratePlanId: "rate_flexible_breakfast",
        roomName: "Deluxe Room",
      },
      pricing: {
        roomTotal: { amountDecimal: "360.00", currency: "EUR" },
        taxesAndFees: { amountDecimal: "36.00", currency: "EUR" },
        discounts: { amountDecimal: "0.00", currency: "EUR" },
        grandTotal: { amountDecimal: "396.00", currency: "EUR" },
      },
      payment: {
        paymentStatus: "authorized",
        paymentMethod: "card",
        depositAmount: { amountDecimal: "99.00", currency: "EUR" },
        balanceAmount: { amountDecimal: "297.00", currency: "EUR" },
        providerPaymentRef: "pay_123",
      },
      policy: {
        cancellationPolicyId: "policy_flexible",
        cancellationSummary: "Free cancellation until 7 days before arrival.",
        refundableUntil: "2026-09-05T22:00:00.000Z",
      },
    },
  };
}

describe("@vayada/domain-booking dashboard metrics read model contract", () => {
  it("BookingDashboardMetricsReadPort is satisfied by an in-memory stub (no PMS DB required)", async () => {
    const stub: BookingDashboardMetricsReadPort = {
      async getDashboardMetrics() {
        return fakeMetrics();
      },
      async getSourceMix(input) {
        return fakeSourceMix(input.propertyId, input.periodStart, input.periodEnd);
      },
      async getSparklines(input) {
        return fakeSparklines(input.propertyId);
      },
      async getPageViewTimeline(input) {
        return fakePageViews(input.propertyId);
      },
    };

    const metrics = await stub.getDashboardMetrics({
      propertyId: "prop_alpenrose",
      periodStart: "2026-06-01",
      periodEnd: "2026-06-30",
      previousPeriodStart: "2026-05-01",
      previousPeriodEnd: "2026-05-31",
    });

    expect(metrics).not.toBeNull();
    expect(metrics!.propertyId).toBe("prop_alpenrose");
    expect(metrics!.current.bookingCount).toBeGreaterThanOrEqual(0);
    expect(metrics!.previous.bookingCount).toBeGreaterThanOrEqual(0);
  });

  it("getSourceMix returns a model with a non-negative totalRevenue and items array", async () => {
    const stub: BookingDashboardMetricsReadPort = {
      getDashboardMetrics: async () => fakeMetrics(),
      getSourceMix: async (input) =>
        fakeSourceMix(input.propertyId, input.periodStart, input.periodEnd),
      getSparklines: async (input) => fakeSparklines(input.propertyId),
      getPageViewTimeline: async (input) => fakePageViews(input.propertyId),
    };

    const mix = await stub.getSourceMix({
      propertyId: "prop_alpenrose",
      periodStart: "2026-06-01",
      periodEnd: "2026-06-30",
    });

    expect(mix.propertyId).toBe("prop_alpenrose");
    expect(mix.items.length).toBeGreaterThanOrEqual(0);
    const totalShare = mix.items.reduce((acc, item) => acc + item.revenueSharePercent, 0);
    expect(totalShare).toBeLessThanOrEqual(100.1);
  });

  it("getSparklines returns exactly 7 bucket points", async () => {
    const stub: BookingDashboardMetricsReadPort = {
      getDashboardMetrics: async () => fakeMetrics(),
      getSourceMix: async (input) =>
        fakeSourceMix(input.propertyId, input.periodStart, input.periodEnd),
      getSparklines: async (input) => fakeSparklines(input.propertyId),
      getPageViewTimeline: async (input) => fakePageViews(input.propertyId),
    };

    const sparklines = await stub.getSparklines({
      propertyId: "prop_alpenrose",
      windowStart: "2026-06-01",
      windowEnd: "2026-06-30",
    });

    expect(sparklines.propertyId).toBe("prop_alpenrose");
    expect(sparklines.points).toHaveLength(7);
    for (const point of sparklines.points) {
      expect(point.bucketStart).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(point.bucketEnd).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(point.bookingCount).toBeGreaterThanOrEqual(0);
      expect(point.pageViewCount).toBeGreaterThanOrEqual(0);
    }
  });

  it("models property-local page-view buckets and their preceding comparison window", async () => {
    const timeline = fakePageViews("prop_alpenrose");
    expect(timeline.timeZone).toBe("Europe/Vienna");
    expect(timeline.buckets).toHaveLength(7);
    expect(timeline.total).toBe(timeline.buckets.reduce((sum, bucket) => sum + bucket.count, 0));
  });
});

describe("@vayada/domain-booking guest PII port contract", () => {
  it("BookingGuestPiiPort is satisfied by a Booking-owned in-memory adapter", async () => {
    const projection = {
      propertyId: "prop_alpenrose",
      guestBookingId: "guest_booking_123",
      primaryGuest: {
        guestId: "guest_primary",
        guestBookingId: "guest_booking_123",
        role: "booker" as const,
        displayName: "Nora Example",
        firstName: "Nora",
        lastName: "Example",
        email: "nora@example.test",
        phone: null,
        countryCode: "CH",
        countryCodeRaw: null,
        countryCodeReviewRequired: false,
        arrivalTime: null,
        specialRequests: null,
      },
      additionalGuests: [],
    };
    const stub: import("./index.js").BookingGuestPiiPort = {
      async listGuestPiiForPmsOperations() {
        return projection;
      },
      async correctPrimaryGuestNationalityForPmsOperations() {
        return {
          ok: false,
          statusCode: 404,
          code: "primary_guest_not_found",
          message: "Primary guest not found.",
        };
      },
      async createAdditionalGuestForPmsOperations(command) {
        const additionalGuest = {
          guestId: "guest_additional",
          guestBookingId: command.guestBookingId,
          role: "additional_guest" as const,
          displayName: `${command.guest.firstName} ${command.guest.lastName}`,
          firstName: command.guest.firstName,
          lastName: command.guest.lastName,
          email: command.guest.email ?? null,
          phone: command.guest.phone ?? null,
          countryCode: command.guest.countryCode ?? null,
          countryCodeRaw: null,
          countryCodeReviewRequired: false,
          arrivalTime: command.guest.arrivalTime ?? null,
          specialRequests: command.guest.specialRequests ?? null,
        };
        return {
          ok: true,
          additionalGuest,
          projection: { ...projection, additionalGuests: [additionalGuest] },
          commandMeta: {
            contractVersion: "booking-guest-pii.v1",
            commandId: command.commandId,
            idempotencyKey: command.idempotencyKey,
            acceptedAt: "2026-08-14T17:10:00.000Z",
            sideEffects: ["audit_event"],
          },
        };
      },
      async updateAdditionalGuestForPmsOperations(command) {
        return {
          ok: false,
          statusCode: 404,
          code: "additional_guest_not_found",
          message: `Additional guest ${command.guestId} was not found.`,
        };
      },
      async deleteAdditionalGuestForPmsOperations(command) {
        return {
          ok: true,
          guestId: command.guestId,
          projection,
          commandMeta: {
            contractVersion: "booking-guest-pii.v1",
            commandId: command.commandId,
            idempotencyKey: command.idempotencyKey,
            acceptedAt: "2026-08-14T17:15:00.000Z",
            sideEffects: ["audit_event"],
          },
        };
      },
    };

    const result = await stub.createAdditionalGuestForPmsOperations({
      propertyId: "prop_alpenrose",
      guestBookingId: "guest_booking_123",
      commandId: "cmd_additional_guest",
      idempotencyKey: "pms-additional-guest-001",
      guest: { firstName: "Mira", lastName: "Example", email: "mira@example.test" },
      audit: {
        actorUserId: "user_hotel_owner",
        actorOrganizationId: "org_hotel_group",
        requestId: "req_123",
        source: "pms_operations",
        reason: "PMS additional guest update",
      },
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.additionalGuest.role).toBe("additional_guest");
    expect(result.projection.additionalGuests).toHaveLength(1);
    expect(result.commandMeta.contractVersion).toBe("booking-guest-pii.v1");
  });
});

function fakeMetrics(): BookingDashboardMetricsReadModel {
  return {
    propertyId: "prop_alpenrose",
    current: {
      totalRevenue: { amountDecimal: "3600.00", currency: "EUR" },
      bookingCount: 10,
      avgNightlyRate: { amountDecimal: "120.00", currency: "EUR" },
      pageViewCount: 120,
    },
    previous: {
      totalRevenue: { amountDecimal: "2880.00", currency: "EUR" },
      bookingCount: 8,
      avgNightlyRate: { amountDecimal: "120.00", currency: "EUR" },
      pageViewCount: 90,
    },
    nextArrivalDate: "2026-07-04",
    liveSinceDate: "2025-01-15",
  };
}

function fakeSourceMix(
  propertyId: string,
  periodStart: string,
  periodEnd: string,
): BookingSourceMixReadModel {
  return {
    propertyId,
    periodStart,
    periodEnd,
    totalRevenue: { amountDecimal: "3600.00", currency: "EUR" },
    items: [
      {
        source: "direct",
        revenue: { amountDecimal: "3000.00", currency: "EUR" },
        bookingCount: 8,
        revenueSharePercent: 83.3,
      },
      {
        source: "airbnb",
        revenue: { amountDecimal: "600.00", currency: "EUR" },
        bookingCount: 2,
        revenueSharePercent: 16.7,
      },
    ],
  };
}

function fakeSparklines(propertyId: string): BookingSparklineReadModel {
  const points = Array.from({ length: 7 }, (_, i) => ({
    bucketStart: `2026-06-0${i + 1}`,
    bucketEnd: `2026-06-0${i + 1}`,
    revenue: { amountDecimal: `${(i + 1) * 100}.00`, currency: "EUR" },
    bookingCount: i + 1,
    avgNightlyRate: { amountDecimal: "120.00", currency: "EUR" },
    pageViewCount: i + 10,
  }));
  return { propertyId, points };
}

function fakePageViews(propertyId: string) {
  const buckets = Array.from({ length: 7 }, (_, index) => ({
    date: `2026-06-${String(index + 8).padStart(2, "0")}`,
    count: index + 1,
  }));
  const previousBuckets = Array.from({ length: 7 }, (_, index) => ({
    date: `2026-06-${String(index + 1).padStart(2, "0")}`,
    count: index,
  }));
  return {
    propertyId,
    timeZone: "Europe/Vienna",
    windowStart: "2026-06-08",
    windowEnd: "2026-06-14",
    previousWindowStart: "2026-06-01",
    previousWindowEnd: "2026-06-07",
    buckets,
    previousBuckets,
    total: buckets.reduce((sum, bucket) => sum + bucket.count, 0),
    previousTotal: previousBuckets.reduce((sum, bucket) => sum + bucket.count, 0),
  };
}
