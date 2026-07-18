import { describe, expect, it } from "vitest";

import {
  canConfirmLocation,
  hasMapCoordinates,
  locationResetForManualAddressEdit,
} from "./SharedFirstRunPropertySetupWizard";

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

describe("canConfirmLocation", () => {
  const completeLocation = {
    streetAddress: "Marienplatz 1",
    postalCode: "80331",
    city: "Munich",
    countryCode: "DE",
    timezone: "Europe/Berlin",
  };

  it("keeps partial Google results editable", () => {
    expect(canConfirmLocation({ ...completeLocation, postalCode: "" })).toBe(false);
  });

  it("requires a time zone before confirming an address", () => {
    expect(canConfirmLocation({ ...completeLocation, timezone: "" })).toBe(false);
    expect(canConfirmLocation(completeLocation)).toBe(true);
  });
});

describe("hasMapCoordinates", () => {
  it("requires finite latitude and longitude values", () => {
    expect(hasMapCoordinates({ latitude: 48.1373932, longitude: 11.5754485 })).toBe(true);
    expect(hasMapCoordinates({ latitude: null, longitude: 11.5754485 })).toBe(false);
    expect(hasMapCoordinates({ latitude: Number.NaN, longitude: 11.5754485 })).toBe(false);
  });
});
