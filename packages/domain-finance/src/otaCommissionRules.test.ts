import { describe, expect, it } from "vitest";

import {
  FINANCE_OTA_CHANNELS,
  normalizeFinanceOtaCommissionRate,
  resolveFinanceOtaCommissionRule,
  type FinanceOtaCommissionRate,
  type FinanceOtaCommissionRule,
} from "./otaCommissionRules.js";

const RULE: FinanceOtaCommissionRule = {
  ruleId: "rule_booking_2026",
  propertyId: "property_1",
  channel: "booking_com",
  percentageRate: normalizeFinanceOtaCommissionRate("15.25")!,
  effectiveFrom: "2026-01-01T00:00:00.000Z",
  effectiveTo: "2026-07-01T00:00:00.000Z",
  revision: 1,
};

describe("OTA commission rule contract", () => {
  it("uses the Booking attribution OTA vocabulary", () => {
    expect(FINANCE_OTA_CHANNELS).toEqual([
      "booking_com",
      "airbnb",
      "expedia",
      "agoda",
      "other_ota",
    ]);
  });

  it.each([
    ["0", "0.0000"],
    ["12.5", "12.5000"],
    ["99.9999", "99.9999"],
    ["100.0000", "100.0000"],
    ["-1", null],
    ["100.0001", null],
    ["12.12345", null],
    [" 12", null],
  ])("normalizes valid decimal rates without floating point (%s)", (value, expected) => {
    expect(normalizeFinanceOtaCommissionRate(value)).toBe(expected);
  });

  it("resolves half-open effective windows and explicit missing evidence", () => {
    expect(
      resolveFinanceOtaCommissionRule([RULE], {
        propertyId: "property_1",
        channel: "booking_com",
        effectiveAt: "2026-06-30T23:59:59.999Z",
      }),
    ).toEqual({ status: "applied", rule: RULE });
    expect(
      resolveFinanceOtaCommissionRule([RULE], {
        propertyId: "property_1",
        channel: "booking_com",
        effectiveAt: "2026-07-01T00:00:00.000Z",
      }),
    ).toMatchObject({ status: "missing", reason: "not_configured" });
  });

  it("rejects ambiguous loaded evidence instead of choosing a rate", () => {
    expect(() =>
      resolveFinanceOtaCommissionRule([RULE, { ...RULE, ruleId: "overlap" }], {
        propertyId: "property_1",
        channel: "booking_com",
        effectiveAt: "2026-02-01T00:00:00.000Z",
      }),
    ).toThrow("Overlapping OTA commission rule evidence");
  });

  it("orders timestamps by instant rather than their text representation", () => {
    expect(
      resolveFinanceOtaCommissionRule([RULE], {
        propertyId: "property_1",
        channel: "booking_com",
        effectiveAt: "2025-12-31T19:00:00-05:00",
      }),
    ).toEqual({ status: "applied", rule: RULE });
  });

  it.each(["2026-02-30T00:00:00Z", "2026-01-01T00:00:00"])(
    "rejects ambiguous or impossible instants (%s)",
    (effectiveAt) =>
      expect(() => resolveFinanceOtaCommissionRule([RULE], { ...RULE, effectiveAt })).toThrow(
        "Invalid OTA commission rule timestamp",
      ),
  );

  it("rejects invalid loaded rate evidence", () => {
    expect(() =>
      resolveFinanceOtaCommissionRule(
        [{ ...RULE, percentageRate: "150.0000" as FinanceOtaCommissionRate }],
        { propertyId: "property_1", channel: "booking_com", effectiveAt: "2026-02-01T00:00:00Z" },
      ),
    ).toThrow("Invalid OTA commission rule evidence");
  });
});
