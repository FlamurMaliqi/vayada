import { expect, it } from "vitest";
import { PUBLIC_BOOKABILITY_FIXTURES } from "@vayada/domain-distribution/fixtures";
import {
  createTargetBookingWebCalendarRepository,
  type BookingWebCalendarReadPool,
} from "./bookingWebPublic.js";

it("publishes valid calendar combinations without exposing internal offer identities", async () => {
  const pool: BookingWebCalendarReadPool = {
    async query<T>(sql: string) {
      expect(sql).toContain('AS "offers"');
      expect(sql).toContain("AND offer.available_rooms > 0 AND offer.freshness_status = 'fresh'");
      return {
        rows: [1, 2].map((day) => ({
          stayDate: `2028-03-0${day}`,
          hasAvailability: true,
          offers: [{ key: "internal-room-and-rate", min: 2, max: null }],
          sourceFreshnessValues: [],
          freshnessStatuses: ["fresh"],
          maxStayNights: null,
        })) as T[],
      };
    },
    async end() {},
  };
  const repository = createTargetBookingWebCalendarRepository({ connectionString: "unused", pool });
  const hotel = PUBLIC_BOOKABILITY_FIXTURES[0]!.profile.hotel;
  const result = await repository.findCalendarByHotel(hotel, {
    start: "2028-03-01",
    end: "2028-03-03",
  });
  expect(result.calendar.validCheckOutsByArrival).toEqual({
    "2028-03-01": ["2028-03-03"],
    "2028-03-02": [],
  });
  expect(result.calendar.minStayByArrival).toEqual({ "2028-03-01": 2, "2028-03-02": 2 });
  expect(JSON.stringify(result)).not.toContain("internal-room-and-rate");
});
