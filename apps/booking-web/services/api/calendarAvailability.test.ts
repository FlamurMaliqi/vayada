import { describe, expect, it } from "vitest";

import { toLegacyCalendar, type BookingWebPublicCalendarResponse } from "./bookingWebPublic";

const calendar = {
  unavailableDates: ["2028-03-01"],
  minStayByArrival: {},
  maxStayByArrival: {},
};

describe("Booking Web public calendar adapter", () => {
  it("surfaces unavailable freshness to the date picker", () => {
    const response: BookingWebPublicCalendarResponse = {
      calendar,
      freshness: { status: "unavailable" },
    };

    expect(toLegacyCalendar(response)).toEqual({
      dates: ["2028-03-01"],
      minStayByArrival: {},
      maxStayByArrival: {},
      availabilityUnavailable: true,
    });
  });

  it("keeps fresh calendar responses selectable", () => {
    expect(
      toLegacyCalendar({ calendar, freshness: { status: "fresh" } }).availabilityUnavailable,
    ).toBe(false);
  });

  it("keeps covered dates selectable when unavailable freshness reflects partial coverage", () => {
    const response: BookingWebPublicCalendarResponse = {
      calendar: {
        unavailableDates: ["2028-03-01"],
        minStayByArrival: { "2028-03-02": 1 },
        maxStayByArrival: {},
      },
      freshness: { status: "unavailable" },
    };

    expect(toLegacyCalendar(response)).toEqual({
      dates: ["2028-03-01"],
      minStayByArrival: { "2028-03-02": 1 },
      maxStayByArrival: {},
      availabilityUnavailable: false,
    });
  });
});
