import { describe, expect, it } from "vitest";

import {
  propertyLaunchSettingsDefaults,
  validatePropertyLaunchSettings,
} from "./propertyLaunchSettings";

describe("propertyLaunchSettingsDefaults", () => {
  it.each([
    ["ID", "IDR", "en", ["id"]],
    ["LK", "LKR", "en", []],
    ["MX", "MXN", "es", ["en"]],
    ["DE", "EUR", "de", ["en"]],
    ["PH", "PHP", "en", []],
    ["NZ", "USD", "en", []],
  ])(
    "uses the expected defaults for %s",
    (countryCode, defaultCurrency, defaultLanguage, supportedLanguages) => {
      expect(propertyLaunchSettingsDefaults(countryCode)).toMatchObject({
        defaultCurrency,
        defaultLanguage,
        supportedLanguages,
        supportedCurrencies: [],
      });
    },
  );
});

describe("validatePropertyLaunchSettings", () => {
  it("accepts blank social links and complete http URLs", () => {
    expect(
      validatePropertyLaunchSettings({
        ...propertyLaunchSettingsDefaults("DE"),
        instagram: "https://instagram.com/alpenrose",
        facebook: "http://facebook.com/alpenrose",
      }),
    ).toEqual({});
  });

  it("rejects unknown defaults and malformed social links", () => {
    expect(
      validatePropertyLaunchSettings({
        ...propertyLaunchSettingsDefaults("DE"),
        defaultCurrency: "XYZ",
        defaultLanguage: "xx",
        tiktok: "@alpenrose",
      }),
    ).toEqual({
      defaultCurrency: ["Select a default currency."],
      defaultLanguage: ["Select a default language."],
      tiktok: ["Enter a complete URL, including https://."],
    });
  });
});
