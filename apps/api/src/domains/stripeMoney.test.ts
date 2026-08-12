import { describe, expect, it } from "vitest";

import {
  stripeAmountDecimal,
  stripeAmountMinor,
  stripeApplicationFeeMinor,
} from "./stripeMoney.js";

describe("Stripe currency minor units", () => {
  it("converts two-decimal EUR and zero-decimal JPY/CLP without reinterpreting value", () => {
    expect(stripeAmountMinor("60.50", "EUR")).toBe(6_050);
    expect(stripeAmountMinor("10000.00", "JPY")).toBe(10_000);
    expect(stripeAmountMinor("10000.00", "CLP")).toBe(10_000);
    expect(stripeAmountDecimal(10_000, "CLP")).toBe("10000.00");
  });

  it("calculates commission in canonical minor units and keeps Fixed fee-free", () => {
    expect(stripeApplicationFeeMinor(60_000, "commission", 5)).toBe(3_000);
    expect(stripeApplicationFeeMinor(10_001, "commission", 5)).toBe(500);
    expect(stripeAmountDecimal(500, "JPY")).toBe("500.00");
    expect(stripeApplicationFeeMinor(60_000, "fixed", 5)).toBe(0);
  });

  it("rejects fractional zero-decimal amounts", () => {
    expect(() => stripeAmountMinor("10000.50", "JPY")).toThrow(
      "JPY card amounts cannot include fractional units",
    );
  });

  it("fails closed for three-decimal currencies until the Finance ledger supports mills", () => {
    expect(() => stripeAmountMinor("100.00", "KWD")).toThrow("KWD card payments are not supported");
    expect(() => stripeAmountDecimal(100_000, "KWD")).toThrow(
      "KWD card payments are not supported",
    );
  });
});
