import type { QueryResult, QueryResultRow } from "pg";
import { describe, expect, it } from "vitest";

import {
  createTargetPmsOperationsReadRepository,
  type PmsOperationsReadPool,
} from "./pmsOperationsReadModel.js";

describe("target PMS reservation stay dates", () => {
  it("reads DATE columns as text so the calendar date is preserved", async () => {
    const queries: string[] = [];
    const pool: PmsOperationsReadPool = {
      async query<T extends QueryResultRow = QueryResultRow>(
        text: string,
      ): Promise<QueryResult<T>> {
        queries.push(text);
        const rows = text.includes("SELECT COUNT(*)::text AS total")
          ? [{ total: "1" }]
          : [
              {
                guestBookingId: "booking-1",
                bookingReference: "VAY-1",
                status: "confirmed",
                source: "direct_booking",
                checkIn: "2026-07-23",
                checkOut: "2026-07-24",
                adults: 2,
                children: 0,
                primaryGuestDisplayName: "Ada Lovelace",
                primaryGuestEmail: "ada@example.com",
                primaryGuestPhone: null,
                primaryGuestCountryCode: "GB",
                primaryGuestSpecialRequests: "Quiet room",
                guestContactAccepted: false,
                addOns: [{ addonId: "addon-1", name: "Breakfast", quantity: 2 }],
                assignments: [],
                checkinCompletedAt: null,
                checkinPendingFlags: [],
                checkoutCompletedAt: null,
                checkoutPendingFlags: [],
                privateNoteCount: 0,
                additionalGuestCount: 0,
                bookedRoomTypeId: "room-type-1",
                bookedRoomName: "Munich Booking Room",
                roomCount: 1,
                totalAmount: "155.00",
                balanceAmount: "155.00",
                currency: "EUR",
                paymentMethod: null,
                expectedPaymentMethod: "unknown",
                paymentStatus: "unpaid",
                paymentBreakdown: {
                  grossAmount: { amountDecimal: "100.00", currency: "EUR" },
                  stripeFee: { amountDecimal: "3.20", currency: "EUR" },
                  vayadaCommission: { amountDecimal: "5.00", currency: "EUR" },
                  netPayout: { amountDecimal: "91.80", currency: "EUR" },
                },
              },
            ];

        return {
          command: "SELECT",
          rowCount: rows.length,
          oid: 0,
          fields: [],
          rows: rows as unknown as T[],
        };
      },
    };
    const repository = createTargetPmsOperationsReadRepository({
      connectionString: "postgresql://pms-operations-read",
      pool,
    });

    const result = await repository.listReservationsByPropertyId("property-1", {
      search: "Ada",
      limit: 25,
      offset: 0,
    });

    const listQuery = queries.find((query) => query.includes('AS "guestContactAccepted"'));
    expect(listQuery).toContain('booking.check_in::text AS "checkIn"');
    expect(listQuery).toContain('booking.check_out::text AS "checkOut"');
    expect(listQuery).toContain("quote.selected_offer_snapshot ->> 'roomName'");
    expect(listQuery).toContain("booking.booking_metadata #>> '{selectedOffer,roomName}'");
    expect(listQuery).toContain('AS "guestContactAccepted"');
    expect(listQuery).toContain('primary_guest.special_requests AS "primaryGuestSpecialRequests"');
    expect(listQuery).toContain("FROM booking.booking_addon_selections selection");
    expect(listQuery).toContain("'guest_booking.accepted'");
    expect(listQuery).not.toContain("contact_event.actor_type = 'property_user'");
    expect(listQuery).toContain("booking.booking_metadata ->> 'acceptedPaymentDeadlineAt'");
    expect(listQuery).toContain('booking.expected_payment_method AS "expectedPaymentMethod"');
    expect(listQuery).toContain("FROM booking.nightly_revenue_evidence evidence");
    expect(listQuery).toContain("payment.payment_metadata ->> 'chargeType' = 'direct'");
    expect(listQuery).toContain("payment.processor_fee_breakdown ->> 'status' = 'available'");
    expect(result.items[0]?.stay).toEqual({
      checkIn: "2026-07-23",
      checkOut: "2026-07-24",
      adults: 2,
      children: 0,
    });
    expect(result.items[0]).toMatchObject({
      primaryGuest: {
        displayName: "Ada Lovelace",
        email: "Hidden until you accept",
        phone: "Hidden until you accept",
        countryCode: "GB",
        specialRequests: "Quiet room",
      },
      addOns: [{ addonId: "addon-1", name: "Breakfast", quantity: 2 }],
      bookedOffer: {
        roomTypeId: "room-type-1",
        roomName: "Munich Booking Room",
      },
      roomCount: 1,
      pricing: {
        totalAmount: { amountDecimal: "155.00", currency: "EUR" },
        balanceAmount: { amountDecimal: "155.00", currency: "EUR" },
      },
      payment: {
        method: null,
        expectedMethod: "unknown",
        status: "unpaid",
        breakdown: {
          grossAmount: { amountDecimal: "100.00", currency: "EUR" },
          stripeFee: { amountDecimal: "3.20", currency: "EUR" },
          vayadaCommission: { amountDecimal: "5.00", currency: "EUR" },
          netPayout: { amountDecimal: "91.80", currency: "EUR" },
        },
      },
    });
  });

  it.each([
    { bookedRoomTypeId: "", bookedRoomName: "Munich Booking Room" },
    { bookedRoomTypeId: "room-type-1", bookedRoomName: "   " },
  ])(
    "omits an incomplete booked offer from every reservation read",
    async ({ bookedRoomTypeId, bookedRoomName }) => {
      const pool: PmsOperationsReadPool = {
        async query<T extends QueryResultRow = QueryResultRow>(): Promise<QueryResult<T>> {
          const rows = [
            {
              guestBookingId: "booking-1",
              bookingReference: "VAY-1",
              status: "confirmed",
              source: "direct_booking",
              checkIn: "2026-07-23",
              checkOut: "2026-07-24",
              adults: 2,
              children: 0,
              primaryGuestDisplayName: "Ada Lovelace",
              primaryGuestEmail: "ada@example.com",
              primaryGuestPhone: null,
              primaryGuestCountryCode: "GB",
              primaryGuestSpecialRequests: null,
              guestContactAccepted: true,
              addOns: [],
              assignments: [],
              checkinCompletedAt: null,
              checkinPendingFlags: [],
              checkoutCompletedAt: null,
              checkoutPendingFlags: [],
              privateNoteCount: 0,
              additionalGuestCount: 0,
              bookedRoomTypeId,
              bookedRoomName,
              roomCount: 1,
              totalAmount: "155.00",
              balanceAmount: "155.00",
              currency: "EUR",
            },
          ];

          return {
            command: "SELECT",
            rowCount: rows.length,
            oid: 0,
            fields: [],
            rows: rows as unknown as T[],
          };
        },
      };
      const repository = createTargetPmsOperationsReadRepository({
        connectionString: "postgresql://pms-operations-read",
        pool,
      });

      const [listed, overlapping, found] = await Promise.all([
        repository.listReservationsByPropertyId("property-1", { limit: 25, offset: 0 }),
        repository.listReservationsOverlappingStayRangeByPropertyId!("property-1", {
          from: "2026-07-23",
          to: "2026-07-24",
        }),
        repository.findReservationByGuestBookingId("property-1", "booking-1"),
      ]);

      expect(listed.items[0]).not.toHaveProperty("bookedOffer");
      expect(overlapping.items[0]).not.toHaveProperty("bookedOffer");
      expect(found).not.toHaveProperty("bookedOffer");
    },
  );
});

describe("target PMS room media compatibility", () => {
  it("keeps a legacy URL snapshot authoritative until every photo has a media object ID", async () => {
    let roomTypeQuery = "";
    const pool: PmsOperationsReadPool = {
      async query<T extends QueryResultRow = QueryResultRow>(
        text: string,
      ): Promise<QueryResult<T>> {
        roomTypeQuery = text;
        return { command: "SELECT", rowCount: 0, oid: 0, fields: [], rows: [] };
      },
    };
    const repository = createTargetPmsOperationsReadRepository({
      connectionString: "postgresql://pms-operations-read",
      pool,
    });

    await expect(repository.listRoomTypesByPropertyId("property-1")).resolves.toEqual({
      items: [],
      sourceFreshness: {},
    });
    expect(roomTypeQuery).toContain("jsonb_array_elements(room_type.media_snapshot)");
    expect(roomTypeQuery).toContain(
      "jsonb_typeof(legacy_media.item -> 'mediaObjectId') IS DISTINCT FROM 'string'",
    );
  });

  it("projects the pricing contract that distinguishes canonical rate plans", async () => {
    let roomTypeQuery = "";
    const pool: PmsOperationsReadPool = {
      async query<T extends QueryResultRow = QueryResultRow>(
        text: string,
      ): Promise<QueryResult<T>> {
        roomTypeQuery = text;
        const rows = [
          {
            roomTypeId: "room-type-1",
            name: "Suite",
            description: "Suite",
            category: null,
            occupancyLimits: { adults: 2, children: 0, total: 2 },
            attributes: {},
            amenities: [],
            media: [],
            roomMediaRevision: 1,
            baseRateAmount: "100.00",
            currency: "EUR",
            active: true,
            sortOrder: 1,
            ratePlans: [
              {
                ratePlanId: "legacy-plan",
                pricingContractVersion: null,
                code: "FLEX",
                name: "Legacy flexible",
                rateType: "flexible",
                mealPlan: null,
                baseRate: { amountDecimal: "100.00", currency: "EUR" },
                active: true,
              },
              {
                ratePlanId: "canonical-plan",
                pricingContractVersion: "pms-pricing.v1",
                code: "ONB15-FLEX",
                name: "Flexible",
                rateType: "flexible",
                mealPlan: null,
                baseRate: { amountDecimal: "150.00", currency: "EUR" },
                active: true,
              },
            ],
            minStayNights: null,
            maxStayNights: null,
            closedToArrival: false,
            closedToDeparture: false,
            activeRuleCount: 0,
            roomCount: 1,
          },
        ];
        return {
          command: "SELECT",
          rowCount: 1,
          oid: 0,
          fields: [],
          rows: rows as unknown as T[],
        };
      },
    };
    const repository = createTargetPmsOperationsReadRepository({
      connectionString: "postgresql://pms-operations-read",
      pool,
    });

    const result = await repository.listRoomTypesByPropertyId("property-1");

    expect(roomTypeQuery).toContain("'pricingContractVersion', rate_plan.pricing_contract_version");
    expect(
      result.items[0]?.ratePlans.map(({ ratePlanId, pricingContractVersion }) => [
        ratePlanId,
        pricingContractVersion,
      ]),
    ).toEqual([
      ["legacy-plan", null],
      ["canonical-plan", "pms-pricing.v1"],
    ]);
  });
});

describe("target PMS room block calendar projection", () => {
  it("projects the authoritative room-block revision into the calendar version", async () => {
    let calendarQuery = "";
    const pool: PmsOperationsReadPool = {
      async query<T extends QueryResultRow = QueryResultRow>(
        text: string,
      ): Promise<QueryResult<T>> {
        calendarQuery = text;
        const rows = [
          {
            stayDate: "2026-08-20",
            roomTypeId: "room-type-1",
            totalCount: 2,
            assignedCount: 0,
            blockedCount: 1,
            availableCount: 1,
            status: "open",
            blocks: [
              {
                blockId: "block-1",
                version: "room-block-v3",
                roomTypeId: "room-type-1",
                roomId: "room-1",
                startsOn: "2026-08-20",
                endsOn: "2026-08-21",
                blockedCount: 1,
                reason: "Maintenance",
                status: "active",
              },
            ],
            assignmentRefs: [],
            sourceFreshness: {},
          },
        ];
        return {
          command: "SELECT",
          rowCount: rows.length,
          oid: 0,
          fields: [],
          rows: rows as unknown as T[],
        };
      },
    };
    const repository = createTargetPmsOperationsReadRepository({
      connectionString: "postgresql://pms-operations-read",
      pool,
    });

    const result = await repository.listCalendarDaysByPropertyId("property-1", {
      from: "2026-08-20",
      to: "2026-08-20",
    });

    expect(calendarQuery).toContain("'version', concat('room-block-v', block.revision)");
    expect(result.items[0]?.blocks[0]?.version).toBe("room-block-v3");
  });
});
