import { describe, expect, it } from "vitest";

import {
  FinanceManualBookingSettlementError,
  normalizeFinanceManualBookingSettlement,
  type FinanceManualBookingSettlementCommand,
} from "./manualBookingSettlement.js";

const PROPERTY_ID = "20000000-0000-4000-8000-000000000001";
const BOOKING_ID = "30000000-0000-4000-8000-000000000001";

function command(
  change: Partial<FinanceManualBookingSettlementCommand["payload"]> = {},
): FinanceManualBookingSettlementCommand {
  return {
    commandType: "finance.manual_booking.settle_full",
    commandId: "manual-booking-command-1",
    idempotencyKey: "manual-booking-key-1",
    propertyId: PROPERTY_ID,
    audit: {
      actor: {
        kind: "user",
        userId: "40000000-0000-4000-8000-000000000001",
        organizationId: "10000000-0000-4000-8000-000000000001",
      },
      requestId: "request-1",
      reason: "Manual booking paid at creation",
      requestedAt: "2026-08-12T09:00:00.000Z",
    },
    payload: {
      booking: {
        guestBookingId: BOOKING_ID,
      },
      amount: "125.50",
      currency: "EUR",
      paymentMethod: "cash",
      sourceReference: "manual-booking-command-1",
      operatorReference: "receipt 42",
      acceptedAt: "2026-08-12T09:00:00.000Z",
      ...change,
    },
  };
}

describe("manual booking settlement contract", () => {
  it("normalizes the exact full-settlement evidence", () => {
    expect(normalizeFinanceManualBookingSettlement(command())).toMatchObject({
      propertyId: PROPERTY_ID,
      guestBookingId: BOOKING_ID,
      amount: "125.50",
      currency: "EUR",
      paymentMethod: "cash",
      operatorReference: "receipt 42",
    });
  });

  it.each(["-1", "NaN", "Infinity", "1.001", "1e2"])("rejects invalid money %s", (amount) => {
    expect(() => normalizeFinanceManualBookingSettlement(command({ amount }))).toThrowError(
      expect.objectContaining<Partial<FinanceManualBookingSettlementError>>({
        code: "invalid_command",
      }),
    );
  });

  it.each([
    "2026-08-12",
    "2026-02-30T09:00:00.000Z",
    "2026-08-12T25:00:00Z",
    "2026-08-12T09:00:00.1234Z",
    "0000-08-12T09:00:00Z",
    "0001-01-01T00:00:00+01:00",
  ])("rejects invalid RFC 3339 timestamp %s", (acceptedAt) => {
    expect(() => normalizeFinanceManualBookingSettlement(command({ acceptedAt }))).toThrowError(
      expect.objectContaining({ code: "invalid_command" }),
    );
  });

  it.each(["pay_at_property", "bank_transfer", "manual_card", "cash", "other"] as const)(
    "accepts the canonical %s method",
    (paymentMethod) => {
      expect(
        normalizeFinanceManualBookingSettlement(command({ paymentMethod })).paymentMethod,
      ).toBe(paymentMethod);
    },
  );

  it.each([
    (value: any) => (value.idempotencyKey = " manual-booking-key-1"),
    (value: any) => (value.commandId = "x".repeat(201)),
    (value: any) => (value.payload.amount = 125),
    (value: any) => (value.audit.actor.kind = "system"),
    (value: any) => (value.propertyId = "00000000-0000-0000-0000-000000000000"),
    (value: any) => delete value.payload,
    (value: any) => (value.payload.unexpected = true),
  ])("returns invalid_command for malformed runtime input", (mutate) => {
    const value: any = command();
    mutate(value);
    expect(() => normalizeFinanceManualBookingSettlement(value)).toThrowError(
      expect.objectContaining({ code: "invalid_command" }),
    );
  });
});
