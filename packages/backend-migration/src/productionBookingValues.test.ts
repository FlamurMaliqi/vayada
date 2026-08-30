import { describe, expect, it } from "vitest";

import {
  bookingLifecycle,
  bookingPayment,
  deterministicUuid,
  money,
  redactPrivate,
  sha256,
  stableJson,
} from "./productionBookingValues.js";

describe("production Booking value mapping", () => {
  it("is deterministic across JSON key order", () => {
    expect(stableJson({ b: 2, a: { d: 4, c: 3 } })).toBe(
      stableJson({ a: { c: 3, d: 4 }, b: 2 }),
    );
    expect(sha256({ b: 2, a: 1 })).toBe(sha256({ a: 1, b: 2 }));
    expect(deterministicUuid("booking", "one")).toBe(
      deterministicUuid("booking", "one"),
    );
    expect(deterministicUuid("booking", "one")).not.toBe(
      deterministicUuid("booking", "two"),
    );
  });

  it("maps legacy lifecycle and payment states explicitly", () => {
    expect(bookingLifecycle("checked_out")).toBe("completed");
    expect(bookingLifecycle("cancelled")).toBe("canceled");
    expect(bookingPayment("captured")).toBe("paid");
    expect(bookingPayment("awaiting_transfer")).toBe("unpaid");
    expect(() => bookingLifecycle("mystery")).toThrow("unsupported");
    expect(() => bookingPayment("mystery")).toThrow("unsupported");
  });

  it("rejects invalid money rather than coercing it", () => {
    expect(money("12.345", "amount")).toBe("12.35");
    expect(() => money("-1", "amount")).toThrow("non-negative money");
    expect(() => money("not-money", "amount")).toThrow("non-negative money");
  });

  it("removes PII and secret-like keys from public audit payloads", () => {
    expect(
      redactPrivate({
        page: "checkout",
        guestEmail: "private@example.test",
        nested: { phone: "+1", count: 2 },
        accessToken: "secret",
      }),
    ).toEqual({ page: "checkout", nested: { count: 2 } });
  });
});
