import { describe, expect, it } from "vitest";

import {
  canContinueProductSetup,
  canConfirmLocation,
  hasMapCoordinates,
  locationResetForManualAddressEdit,
  productSetupTasks,
  validateProfileDraft,
} from "./SharedFirstRunPropertySetupWizard";

describe("product setup roadmap", () => {
  it("groups technical Marketplace requirements into two owner tasks", () => {
    expect(
      productSetupTasks("marketplace", {
        status: "selected_incomplete",
        missingSteps: [
          "creatorPitch",
          "marketplaceOffer",
          "offerDeliverables",
          "compensationOptions",
          "creatorRequirements",
        ],
      }),
    ).toMatchObject([
      { id: "creator-profile", complete: false },
      {
        id: "collaboration-offer",
        title: "Prepare your collaboration offer",
        complete: false,
      },
    ]);
  });

  it("marks completed task groups without treating the product as ready", () => {
    expect(
      productSetupTasks("booking", {
        status: "selected_incomplete",
        missingSteps: ["paymentReadiness"],
      }),
    ).toMatchObject([
      { id: "booking-settings", complete: true },
      { id: "booking-readiness", complete: false },
    ]);
  });

  it("keeps additive backend requirements actionable as additional setup", () => {
    expect(
      productSetupTasks("marketplace", {
        status: "selected_incomplete",
        missingSteps: ["marketplaceListing"],
      }),
    ).toMatchObject([
      { id: "creator-profile", complete: true },
      { id: "collaboration-offer", complete: true },
      { id: "additional-setup", complete: false },
    ]);
    expect(
      canContinueProductSetup({
        status: "selected_incomplete",
        missingSteps: ["marketplaceListing"],
      }),
    ).toBe(true);
    expect(
      canContinueProductSetup({
        status: "selected_incomplete",
        missingSteps: ["futureBookingRequirement"],
      }),
    ).toBe(true);
  });

  it("only opens product-owned setup for actionable requirements", () => {
    expect(
      canContinueProductSetup({
        status: "selected_incomplete",
        missingSteps: ["roomTypes", "rooms", "ratePlans"],
      }),
    ).toBe(true);
    expect(
      canContinueProductSetup({
        status: "selected_incomplete",
        missingSteps: ["productEntitlement", "rooms"],
      }),
    ).toBe(false);
    expect(
      canContinueProductSetup({
        status: "selected_incomplete",
        missingSteps: ["creatorPitch"],
      }),
    ).toBe(true);
    expect(
      canContinueProductSetup({
        status: "selected_incomplete",
        missingSteps: [],
      }),
    ).toBe(true);
    expect(
      canContinueProductSetup({
        status: "suspended",
        missingSteps: ["marketplaceListing"],
      }),
    ).toBe(false);
    expect(
      canContinueProductSetup({
        status: "unavailable",
        missingSteps: ["marketplaceListing"],
      }),
    ).toBe(false);
  });
});

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

  it("rejects arbitrary text and too-short phone numbers", () => {
    const draft = {
      displayName: "Hotel Alpenrose",
      propertyType: "hotel",
      countryCode: "DE",
      city: "Munich",
      streetAddress: "Marienplatz 1",
      postalCode: "80331",
      timezone: "Europe/Berlin",
      website: "",
      contactEmail: "owner@alpenrose.example",
      phone: "not a phone",
    } as Parameters<typeof validateProfileDraft>[0];

    expect(validateProfileDraft(draft, "create").phone).toEqual(["Enter a valid phone number."]);
    expect(validateProfileDraft({ ...draft, phone: "+49 12" }, "create").phone).toEqual([
      "Enter a valid phone number.",
    ]);
    expect(validateProfileDraft({ ...draft, phone: "+49 89 123456" }, "create").phone).toBe(
      undefined,
    );
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
