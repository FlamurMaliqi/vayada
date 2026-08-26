import {
  PMS_PRICING_CURRENCY_CAPABILITIES_CONTRACT_VERSION,
  parsePmsPricingCurrency,
  parsePmsPricingCurrencyCapabilities,
  type PmsPricingCurrency,
  type PmsPricingCurrencyCapabilities,
  type PmsPricingCurrencyCapabilitiesPort,
  type PmsPricingCurrencyChangeGuardPort,
} from "@vayada/domain-pms";

const PMS_SUPPORTED_PRICING_CURRENCY_CODE_STRINGS_V1 = [
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
] as const;

/**
 * PMS-owned V1 scope: current product currency vocabulary intersected with the
 * scale-2 PMS/Booking money model and the checked-in Node/browser ICU runtime.
 */
export const PMS_SUPPORTED_PRICING_CURRENCY_CODES_V1: readonly PmsPricingCurrency[] = Object.freeze(
  PMS_SUPPORTED_PRICING_CURRENCY_CODE_STRINGS_V1.map((value) => {
    const code = parsePmsPricingCurrency(value);
    if (!code) throw new Error(`Invalid PMS supported pricing currency: ${value}`);
    return code;
  }),
);

const supportedCodeSet = new Set<string>(PMS_SUPPORTED_PRICING_CURRENCY_CODES_V1);

export const PMS_PRICING_CURRENCY_CAPABILITIES_V1: PmsPricingCurrencyCapabilities = (() => {
  const parsed = parsePmsPricingCurrencyCapabilities({
    contractVersion: PMS_PRICING_CURRENCY_CAPABILITIES_CONTRACT_VERSION,
    supportedCurrencies: PMS_SUPPORTED_PRICING_CURRENCY_CODES_V1.map((code) => ({
      code,
      scale: 2,
    })),
  });
  if (!parsed) throw new Error("Invalid PMS pricing currency capabilities");
  return parsed;
})();

/** One immutable source backs both advertised capabilities and command validation. */
export const PMS_PRICING_CURRENCY_CAPABILITIES_PORT: PmsPricingCurrencyCapabilitiesPort =
  Object.freeze({
    async getPricingCurrencyCapabilities() {
      return PMS_PRICING_CURRENCY_CAPABILITIES_V1;
    },
    async isSupportedPricingCurrency(currency) {
      return supportedCodeSet.has(currency);
    },
  });

/** Initial setup is allowed; later currency changes remain blocked until every dependency participates. */
export const PMS_PRICING_CURRENCY_CHANGE_FAIL_CLOSED_GUARD: PmsPricingCurrencyChangeGuardPort =
  Object.freeze({
    async runWithCurrencyChangeGuard(_input, guarded) {
      return guarded([{ code: "dependency_check_unavailable" }]);
    },
  });
