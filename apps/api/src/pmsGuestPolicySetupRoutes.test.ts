import { describe, expect, it } from "vitest";

import { buildApp } from "./app.js";
import type { PmsMandatoryChargeConfirmationRoutesOptions } from "./routes/pmsMandatoryChargeConfirmation.js";
import type { PmsPricingRoutesOptions } from "./routes/pmsPricing.js";
import type { PmsRecurringPricingRoutesOptions } from "./routes/pmsRecurringPricing.js";

const propertyId = "61000000-0000-4000-8000-000000000001";
const paths = [
  `/api/pms/properties/${propertyId}/pricing-source`,
  `/api/pms/properties/${propertyId}/pricing-source/recurring-booking-evidence`,
  `/api/pms/properties/${propertyId}/mandatory-charge-confirmation`,
];

describe("guest-policy PMS setup route composition", () => {
  it("keeps owner routes disabled without runtime ports and protects them when enabled", async () => {
    const disabled = buildApp({ logger: false });
    for (const path of paths) expect((await disabled.inject({ url: path })).statusCode).toBe(404);
    await disabled.close();

    const enabled = buildApp({
      logger: false,
      pmsPricing: {} as PmsPricingRoutesOptions,
      pmsRecurringPricing: {} as PmsRecurringPricingRoutesOptions,
      pmsMandatoryChargeConfirmation: {} as PmsMandatoryChargeConfirmationRoutesOptions,
    });
    for (const path of paths) expect((await enabled.inject({ url: path })).statusCode).toBe(401);
    await enabled.close();
  });
});
