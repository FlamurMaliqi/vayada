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
                guestContactAccepted: false,
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
    expect(listQuery).toContain("contact_event.actor_type = 'property_user'");
    expect(listQuery).toContain("booking.booking_metadata ->> 'acceptedPaymentDeadlineAt'");
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
      },
      bookedOffer: {
        roomTypeId: "room-type-1",
        roomName: "Munich Booking Room",
      },
      roomCount: 1,
      pricing: {
        totalAmount: { amountDecimal: "155.00", currency: "EUR" },
        balanceAmount: { amountDecimal: "155.00", currency: "EUR" },
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
              guestContactAccepted: true,
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
