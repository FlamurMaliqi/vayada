import { describe, expect, expectTypeOf, it } from "vitest";

import {
  MANUAL_BOOKING_EXPECTED_PAYMENT_METHODS,
  type ManualBookingPaymentIntentOwnerPort,
} from "./manualBookingPaymentIntent.js";

describe("manual booking payment intent owner port", () => {
  it("exposes every canonical v1 method without migration-only unknown", () => {
    expect(MANUAL_BOOKING_EXPECTED_PAYMENT_METHODS).toEqual([
      "pay_at_property",
      "bank_transfer",
      "manual_card",
      "cash",
      "other",
    ]);
    expect(MANUAL_BOOKING_EXPECTED_PAYMENT_METHODS).not.toContain("unknown");
    type Command = Parameters<
      ManualBookingPaymentIntentOwnerPort["recordExpectedPaymentMethod"]
    >[0];
    expectTypeOf<Command["contractVersion"]>().toEqualTypeOf<"pms-manual-booking.v1">();
    expectTypeOf<Extract<Command["expectedMethod"], "unknown">>().toEqualTypeOf<never>();
  });
});
