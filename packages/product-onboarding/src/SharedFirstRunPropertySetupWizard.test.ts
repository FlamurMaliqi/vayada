import { describe, expect, it } from "vitest";

import { locationResetForManualAddressEdit } from "./SharedFirstRunPropertySetupWizard";

describe("locationResetForManualAddressEdit", () => {
  it("clears a Google-selected region when the city changes", () => {
    expect(locationResetForManualAddressEdit("city")).toEqual({
      latitude: null,
      longitude: null,
      region: "",
    });
  });

  it("clears a Google-selected region when the country changes", () => {
    expect(locationResetForManualAddressEdit("countryCode")).toEqual({
      latitude: null,
      longitude: null,
      region: "",
    });
  });

  it("keeps the region when only the street changes", () => {
    expect(locationResetForManualAddressEdit("streetAddress")).toEqual({
      latitude: null,
      longitude: null,
    });
  });
});
