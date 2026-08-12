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
