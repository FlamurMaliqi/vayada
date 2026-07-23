import { describe, expect, it } from "vitest";

import { toConfirmationBooking, type BookingConfirmationSource } from "./bookingDraft";

describe("toConfirmationBooking", () => {
  it("adapts the compact target booking response with checkout display details", () => {
    const booking = toConfirmationBooking(
      {
        guestBookingId: "booking-123",
        bookingReference: "B-ABC123",
        status: "confirmed",
        paymentStatus: "unpaid",
        checkIn: "2026-07-24",
        checkOut: "2026-07-27",
        adults: 2,
        children: 1,
        roomCount: 2,
        currency: "eur",
        totalAmount: 870,
        balanceAmount: 870,
      },
      {
        hotelName: "Codex QA Hotel",
        roomName: "Munich Booking Room",
        guestFirstName: "Ada",
        guestLastName: "Lovelace",
        guestEmail: "ada+booking@example.com",
        paymentMethod: "pay_at_property",
      },
    );

    expect(booking).toMatchObject({
      id: "booking-123",
      bookingReference: "B-ABC123",
      hotelName: "Codex QA Hotel",
      roomName: "Munich Booking Room",
      guestFirstName: "Ada",
      guestLastName: "Lovelace",
      guestEmail: "ada+booking@example.com",
      checkIn: "2026-07-24",
      checkOut: "2026-07-27",
      nights: 3,
      adults: 2,
      children: 1,
      numberOfRooms: 2,
      currency: "EUR",
      totalAmount: 870,
      balanceAmount: 870,
      status: "confirmed",
      paymentMethod: "pay_at_property",
      paymentStatus: "unpaid",
    });
  });

  it("rejects invalid public-response fields and never creates NaN confirmation values", () => {
    const unsafeSource = {
      bookingReference: "B-SAFE",
      status: "run_script",
      paymentMethod: "javascript:alert(1)",
      paymentStatus: "invented",
      checkIn: "not-a-date",
      checkOut: "2026-02-31",
      nights: Number.NaN,
      adults: Number.NaN,
      totalAmount: Number.POSITIVE_INFINITY,
      currency: "eur",
    } as unknown as BookingConfirmationSource;

    const booking = toConfirmationBooking(unsafeSource, {
      checkIn: "2026-08-10",
      checkOut: "2026-08-12",
      adults: 1,
      totalAmount: 300,
      paymentMethod: "pay_at_property",
    });

    expect(booking).toMatchObject({
      checkIn: "2026-08-10",
      checkOut: "2026-08-12",
      nights: 2,
      adults: 1,
      totalAmount: 300,
      status: "pending",
      paymentMethod: "pay_at_property",
      paymentStatus: null,
    });
    expect(Number.isNaN(booking.nights)).toBe(false);
    expect(Number.isNaN(booking.totalAmount)).toBe(false);
  });
});
