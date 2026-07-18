import { describe, expect, it } from "vitest";

import {
  canConfirmLocation,
  hasMapCoordinates,
  locationResetForManualAddressEdit,
  validateProfileDraft,
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

  it("requires a valid IANA time zone before confirming an address", () => {
    expect(canConfirmLocation({ ...completeLocation, timezone: "Europe/Not_A_Real_Place" })).toBe(
      false,
    );
    expect(canConfirmLocation({ ...completeLocation, timezone: "Etc/UTC" })).toBe(true);
  });
});

describe("validateProfileDraft", () => {
  it("rejects invalid time zones in create and update mode", () => {
    const draft = {
      displayName: "Hotel Alpenrose",
      propertyType: "hotel",
      countryCode: "DE",
      city: "Munich",
      streetAddress: "Marienplatz 1",
      postalCode: "80331",
      timezone: "Europe/Not_A_Real_Place",
      website: "",
      contactEmail: "owner@alpenrose.example",
      phone: "+49 89 123456",
    } as Parameters<typeof validateProfileDraft>[0];

    expect(validateProfileDraft(draft, "create")["location.timezone"]).toEqual([
      "Enter a valid IANA time zone.",
    ]);
    expect(validateProfileDraft(draft, "update")["location.timezone"]).toEqual([
      "Enter a valid IANA time zone.",
    ]);
  });
});

describe("hasMapCoordinates", () => {
  it("accepts finite latitude and longitude values within geographic bounds", () => {
    expect(hasMapCoordinates({ latitude: 48.1373932, longitude: 11.5754485 })).toBe(true);
    expect(hasMapCoordinates({ latitude: -90, longitude: -180 })).toBe(true);
    expect(hasMapCoordinates({ latitude: 90, longitude: 180 })).toBe(true);
    expect(hasMapCoordinates({ latitude: null, longitude: 11.5754485 })).toBe(false);
    expect(hasMapCoordinates({ latitude: Number.NaN, longitude: 11.5754485 })).toBe(false);
    expect(hasMapCoordinates({ latitude: -90.1, longitude: 0 })).toBe(false);
    expect(hasMapCoordinates({ latitude: 90.1, longitude: 0 })).toBe(false);
    expect(hasMapCoordinates({ latitude: 0, longitude: -180.1 })).toBe(false);
    expect(hasMapCoordinates({ latitude: 0, longitude: 180.1 })).toBe(false);
  });
});
