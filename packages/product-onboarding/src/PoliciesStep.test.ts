import { describe, expect, it } from "vitest";

import { paymentMethodsAfterPayAtHotelToggle } from "./PoliciesStep";

describe("paymentMethodsAfterPayAtHotelToggle", () => {
  it("defaults to manual card when pay-at-hotel is enabled without a method", () => {
    expect(paymentMethodsAfterPayAtHotelToggle(true, [])).toEqual(["card"]);
  });

  it("preserves the hotel's explicit methods", () => {
    expect(paymentMethodsAfterPayAtHotelToggle(true, ["cash"])).toEqual(["cash"]);
    expect(paymentMethodsAfterPayAtHotelToggle(false, ["cash", "card"])).toEqual(["cash", "card"]);
  });
});
