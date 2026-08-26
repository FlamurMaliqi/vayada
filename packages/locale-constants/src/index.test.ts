import { describe, expect, it } from "vitest";

import { paymentMethodLabel, paymentMethodLabelKey } from "./index";

describe("paymentMethodLabel", () => {
  it.each([
    ["pay_at_property", "Pay at Property"],
    ["credit_card", "Credit Card"],
    ["card", "Card"],
    ["bank_transfer", "Bank Transfer"],
    ["cash", "Cash"],
    ["manual_card", "Manual Card"],
    ["paypal", "PayPal"],
    ["xendit", "Xendit"],
    ["other", "Other"],
  ])("maps %s to %s", (method, label) => {
    expect(paymentMethodLabel(method)).toBe(label);
  });

  it("fails closed for unknown values", () => {
    expect(paymentMethodLabel("future_wallet")).toBe("Other");
    expect(paymentMethodLabelKey("future_wallet")).toBe("other");
  });
});
