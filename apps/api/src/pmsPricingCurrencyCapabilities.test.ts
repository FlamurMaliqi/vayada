import { parsePmsPricingCurrency, parsePmsPricingCurrencyCapabilities } from "@vayada/domain-pms";
import { describe, expect, it } from "vitest";

import {
  PMS_PRICING_CURRENCY_CAPABILITIES_PORT,
  PMS_PRICING_CURRENCY_CAPABILITIES_V1,
  PMS_SUPPORTED_PRICING_CURRENCY_CODES_V1,
} from "./domains/pmsPricingCurrencyCapabilities.js";

describe("PMS pricing currency capabilities", () => {
  it("advertises the exact immutable code-unit-sorted scale-2 V1 scope", async () => {
    expect(PMS_SUPPORTED_PRICING_CURRENCY_CODES_V1).toEqual([
      "AED",
      "AUD",
      "BGN",
      "BRL",
      "CAD",
      "CHF",
      "CNY",
      "CZK",
      "DKK",
      "EUR",
      "GBP",
      "HKD",
      "HRK",
      "INR",
      "LKR",
      "MXN",
      "MYR",
      "NOK",
      "NZD",
      "PHP",
      "PLN",
      "RON",
      "RUB",
      "SEK",
      "SGD",
      "THB",
      "TRY",
      "USD",
    ]);
    expect(Object.isFrozen(PMS_SUPPORTED_PRICING_CURRENCY_CODES_V1)).toBe(true);
    expect(Object.isFrozen(PMS_PRICING_CURRENCY_CAPABILITIES_V1)).toBe(true);
    expect(
      parsePmsPricingCurrencyCapabilities(
        await PMS_PRICING_CURRENCY_CAPABILITIES_PORT.getPricingCurrencyCapabilities(),
      ),
    ).toEqual(PMS_PRICING_CURRENCY_CAPABILITIES_V1);
  });

  it("uses the advertised set for command validation and current runtime formatting", async () => {
    for (const code of PMS_SUPPORTED_PRICING_CURRENCY_CODES_V1) {
      await expect(
        PMS_PRICING_CURRENCY_CAPABILITIES_PORT.isSupportedPricingCurrency(code),
      ).resolves.toBe(true);
      const formatting = new Intl.NumberFormat("en-GB", {
        style: "currency",
        currency: code,
      }).resolvedOptions();
      expect([formatting.minimumFractionDigits, formatting.maximumFractionDigits]).toEqual([2, 2]);
    }
    for (const value of ["HUF", "IDR", "JPY", "KRW", "VND", "ZZZ"]) {
      const code = parsePmsPricingCurrency(value)!;
      await expect(
        PMS_PRICING_CURRENCY_CAPABILITIES_PORT.isSupportedPricingCurrency(code),
      ).resolves.toBe(false);
    }
  });
});
