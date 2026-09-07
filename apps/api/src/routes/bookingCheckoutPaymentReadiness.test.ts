import { describe, expect, it } from "vitest";
import { assertTargetCheckoutConfigMatchesQuote as assertReady } from "./bookingWebPublic.js";

type Config = NonNullable<Parameters<typeof assertReady>[0]>;
type Quote = Parameters<typeof assertReady>[1];
const config = {
  paymentsEnabled: true,
  acceptedMethods: ["pay_at_property"],
  defaultCurrency: "EUR",
  onlineCardReady: false,
  bankTransferReady: false,
} as Config;
const quote = { paymentMethod: "pay_at_property", currency: "EUR" } as Quote;

describe("canonical checkout payment readiness", () => {
  it("accepts Finance pay-at-property without legacy settlement flags", () => {
    expect(() => assertReady(config, quote)).not.toThrow();
    expect(() => assertReady(config, { ...quote, paymentMethod: "cash" })).not.toThrow();
  });
  it.each([
    null,
    { ...config, paymentsEnabled: false },
    { ...config, acceptedMethods: [] },
    { ...config, acceptedMethods: ["cash"] },
    { ...config, acceptedMethods: ["manual_card"] },
  ])("rejects disabled or unselected canonical payment methods", (value) => {
    expect(() => assertReady(value, quote)).toThrow("Selected payment method");
  });
  it.each(["card", "bank_transfer"])("retains provider readiness for %s", (method) => {
    expect(() =>
      assertReady({ ...config, acceptedMethods: [method] }, { ...quote, paymentMethod: method }),
    ).toThrow("Selected payment method");
  });
  it("retains currency and PayPal recipient validation", () => {
    expect(() => assertReady({ ...config, defaultCurrency: "USD" }, quote)).toThrow(
      "Property currency changed",
    );
    expect(() =>
      assertReady(
        { ...config, acceptedMethods: ["paypal"], depositPolicy: {} },
        { ...quote, paymentMethod: "paypal" },
      ),
    ).toThrow("Selected payment method");
  });
});
