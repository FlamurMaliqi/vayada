import { describe, expect, it } from "vitest";
import {
  BOOKING_CHANNEL_VALUES,
  DIRECT_BOOKING_SOURCE_VALUES,
  parseBookingAttribution,
  type BookingAttribution,
} from "./bookingAttribution.js";

describe("booking attribution", () => {
  it("publishes stable canonical values", () => {
    expect(BOOKING_CHANNEL_VALUES).toEqual([
      "direct",
      "booking_com",
      "airbnb",
      "expedia",
      "agoda",
      "other_ota",
      "unknown",
    ]);
    expect(DIRECT_BOOKING_SOURCE_VALUES).toEqual([
      "booking_engine",
      "whatsapp",
      "call",
      "email",
      "walk_in",
      "social_media",
      "other",
    ]);
  });

  it("requires a canonical source for direct bookings", () => {
    expect(
      parseBookingAttribution({
        bookingChannel: "direct",
        directBookingSource: "whatsapp",
      }),
    ).toEqual({ bookingChannel: "direct", directBookingSource: "whatsapp" });
    expect(parseBookingAttribution({ bookingChannel: "direct" })).toBeNull();
    expect(
      parseBookingAttribution({ bookingChannel: "direct", directBookingSource: "email" }),
    ).toEqual({ bookingChannel: "direct", directBookingSource: "email" });
  });

  it("makes invalid pairs unrepresentable to typed producers", () => {
    const valid = [
      { bookingChannel: "direct", directBookingSource: "call" },
      { bookingChannel: "airbnb", directBookingSource: null },
    ] satisfies BookingAttribution[];
    // @ts-expect-error Direct attribution requires a direct source.
    const missingSource: BookingAttribution = {
      bookingChannel: "direct",
      directBookingSource: null,
    };
    const otaWithDirectSource: BookingAttribution = {
      bookingChannel: "airbnb",
      // @ts-expect-error OTA attribution cannot carry a direct source.
      directBookingSource: "whatsapp",
    };

    expect(valid).toHaveLength(2);
    expect([missingSource, otaWithDirectSource]).toHaveLength(2);
  });

  it("keeps OTA and unknown attribution source-free", () => {
    expect(parseBookingAttribution({ bookingChannel: "booking_com" })).toEqual({
      bookingChannel: "booking_com",
      directBookingSource: null,
    });
    expect(parseBookingAttribution({ bookingChannel: "unknown" })).toEqual({
      bookingChannel: "unknown",
      directBookingSource: null,
    });
    expect(
      parseBookingAttribution({
        bookingChannel: "airbnb",
        directBookingSource: "other",
      }),
    ).toBeNull();
    expect(parseBookingAttribution({ bookingChannel: "made_up" })).toBeNull();
  });
});
