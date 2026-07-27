import { describe, expect, it } from "vitest";

import {
  canConfirmLocation,
  createProfileFromDraft,
  hasMapCoordinates,
  idempotencyKeyForRetry,
  locationResetForManualAddressEdit,
  mergeTrackSelectionAfterConflict,
  profileUpdateFromDraft,
  validateProfileDraft,
} from "./SharedFirstRunPropertySetupWizard";

describe("idempotencyKeyForRetry", () => {
  it("keeps one key for retries and creates a new key only after reset", () => {
    let sequence = 0;
    const create = () => `key-${++sequence}`;
    const first = idempotencyKeyForRetry(null, create);

    expect(idempotencyKeyForRetry(first, create)).toBe(first);
    expect(idempotencyKeyForRetry(null, create)).toBe("key-2");
  });
});

describe("property profile requests", () => {
  const draft = {
    displayName: "Hotel Alpenrose",
    propertyType: "hotel",
    countryCode: "DE",
    city: "Munich",
    streetAddress: "Marienplatz 1",
    postalCode: "80331",
    latitude: 48.137,
    longitude: 11.575,
    timezone: "Europe/Berlin",
    website: "https://alpenrose.example",
    contactEmail: "hello@alpenrose.example",
    phone: "+49 89 123456",
  } as Parameters<typeof createProfileFromDraft>[0];

  it("creates private general contacts and private location defaults", () => {
    const request = createProfileFromDraft(draft);

    expect(request.location).toMatchObject({
      localityPublic: false,
      geoPublic: false,
      mapDisplayMode: "hidden",
    });
    expect(request.contacts).toEqual([
      {
        channelType: "email",
        value: "hello@alpenrose.example",
        purpose: "general",
        isPublic: false,
      },
      {
        channelType: "phone",
        value: "+49 89 123456",
        purpose: "general",
        isPublic: false,
      },
      {
        channelType: "website",
        value: "https://alpenrose.example",
        purpose: "general",
        isPublic: false,
      },
    ]);
  });

  it("adds changed setup contacts privately without overwriting published contacts", () => {
    const request = profileUpdateFromDraft(draft, {
      propertyId: "property-1",
      profileRevision: 7,
      profile: {
        ...createProfileFromDraft(draft),
        location: {
          ...createProfileFromDraft(draft).location,
          localityPublic: true,
          geoPublic: true,
          mapDisplayMode: "exact",
        },
        contacts: [
          {
            channelType: "email",
            value: "old@alpenrose.example",
            purpose: "general",
            isPublic: true,
          },
          {
            channelType: "phone",
            value: "+49 89 000000",
            purpose: "general",
            isPublic: false,
          },
          {
            channelType: "instagram",
            value: "@alpenrose",
            purpose: "creator",
            isPublic: true,
          },
        ],
      },
    });

    expect(request).not.toBeNull();
    if (!request) throw new Error("Expected a profile update.");
    expect(request.expectedProfileRevision).toBe(7);
    expect(request.patch.displayName).toBeUndefined();
    expect(request.patch.propertyType).toBeUndefined();
    expect(request.patch.location).toBeUndefined();
    expect(request.patch.contacts).toContainEqual({
      channelType: "email",
      value: "old@alpenrose.example",
      purpose: "general",
      isPublic: true,
    });
    expect(request.patch.contacts).toContainEqual({
      channelType: "email",
      value: "hello@alpenrose.example",
      purpose: "general",
      isPublic: false,
    });
    expect(request.patch.contacts).toContainEqual({
      channelType: "instagram",
      value: "@alpenrose",
      purpose: "creator",
      isPublic: true,
    });
  });

  it("leaves an existing published contact unchanged when the entered value matches", () => {
    const profile = createProfileFromDraft(draft);
    profile.contacts = profile.contacts.map((contact) => ({ ...contact, isPublic: true }));

    expect(
      profileUpdateFromDraft(draft, {
        propertyId: "property-1",
        profileRevision: 8,
        profile,
      }),
    ).toBeNull();
  });

  it("skips an update when no shared identity field changed", () => {
    const profile = createProfileFromDraft(draft);

    expect(
      profileUpdateFromDraft(draft, {
        propertyId: "property-1",
        profileRevision: 3,
        profile,
      }),
    ).toBeNull();
  });

  it("includes only changed location fields in the patch", () => {
    const profile = createProfileFromDraft(draft);
    const request = profileUpdateFromDraft(
      { ...draft, city: "Berlin" },
      {
        propertyId: "property-1",
        profileRevision: 4,
        profile,
      },
    );

    expect(request).toEqual({
      expectedProfileRevision: 4,
      patch: { location: { city: "Berlin" } },
    });
  });
});

describe("mergeTrackSelectionAfterConflict", () => {
  it("preserves the owner’s intent while retaining tracks another session already added", () => {
    expect(mergeTrackSelectionAfterConflict(["hotel_operations"], ["creator_marketplace"])).toEqual(
      ["hotel_operations", "creator_marketplace"],
    );
  });

  it("keeps canonical order and removes duplicates", () => {
    expect(
      mergeTrackSelectionAfterConflict(
        ["creator_marketplace", "hotel_operations"],
        ["hotel_operations"],
      ),
    ).toEqual(["hotel_operations", "creator_marketplace"]);
  });
});

describe("locationResetForManualAddressEdit", () => {
  it("clears Google coordinates when the city changes", () => {
    expect(locationResetForManualAddressEdit("city")).toEqual({
      latitude: null,
      longitude: null,
    });
  });

  it("clears Google coordinates when the country changes", () => {
    expect(locationResetForManualAddressEdit("countryCode")).toEqual({
      latitude: null,
      longitude: null,
    });
  });

  it("clears Google coordinates when the street changes", () => {
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
  it("rejects invalid time zones", () => {
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

    expect(validateProfileDraft(draft)["location.timezone"]).toEqual([
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

    expect(validateProfileDraft(draft).phone).toEqual(["Enter a valid phone number."]);
    expect(validateProfileDraft({ ...draft, phone: "+49 12" }).phone).toEqual([
      "Enter a valid phone number.",
    ]);
    expect(validateProfileDraft({ ...draft, phone: "+49 89 123456" }).phone).toBe(undefined);
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
