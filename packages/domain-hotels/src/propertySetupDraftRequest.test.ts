import { describe, expect, it } from "vitest";

import { PROPERTY_SETUP_STEP_DEFINITIONS } from "./propertySetupDraft.js";
import { parseSavePropertySetupDraftRequest } from "./propertySetupDraftRequest.js";

const PRESENT_BASE = {
  "hotel_catalog.profile": "profile:7",
  "hotel_catalog.media": "media:4",
  "hotel_catalog.amenities": "amenities:2",
};

function validRequest() {
  return {
    stepId: "present_hotel",
    payload: {
      "profile.short_description": "A small hotel beside a secret garden.",
      "profile.hero_image": null,
    },
    dirtyFields: ["profile.short_description", "profile.hero_image"],
    expectedBaseRevisions: PRESENT_BASE,
    expectedTrackRevision: 0,
    expectedSessionRevision: 0,
    expectedDraftRevision: 0,
  };
}

describe("property setup draft request parsing", () => {
  it.each([
    ["locale-only", { "profile.default_locale": "de-DE" }, ["profile.default_locale"]],
    [
      "locale-plus-summary",
      {
        "profile.short_description": "A calm hotel.",
        "profile.default_locale": "de-DE",
      },
      ["profile.short_description", "profile.default_locale"],
    ],
  ] as const)("accepts and normalizes a %s Step 1 draft", (_name, payload, dirtyFields) => {
    const result = parseSavePropertySetupDraftRequest({
      ...validRequest(),
      payload,
      dirtyFields,
    });

    expect(result).toMatchObject({
      ok: true,
      value: {
        payload,
        dirtyFields:
          "profile.short_description" in payload
            ? ["profile.default_locale", "profile.short_description"]
            : ["profile.default_locale"],
      },
    });
  });

  it("accepts and normalizes an incomplete draft", () => {
    const request = {
      ...validRequest(),
      payload: {
        "profile.amenities": ["wifi"],
        "profile.short_description": "A calm hotel.",
      },
      dirtyFields: ["profile.amenities", "profile.short_description"],
    };

    expect(parseSavePropertySetupDraftRequest(request)).toMatchObject({
      ok: true,
      value: {
        payload: {
          "profile.short_description": "A calm hotel.",
          "profile.amenities": ["wifi"],
        },
        dirtyFields: ["profile.short_description", "profile.amenities"],
      },
    });
  });

  it("accepts the maximum optimistic-concurrency revision", () => {
    const request = {
      ...validRequest(),
      expectedTrackRevision: 2_147_483_646,
      expectedSessionRevision: 2_147_483_646,
      expectedDraftRevision: 2_147_483_646,
    };

    expect(parseSavePropertySetupDraftRequest(request)).toEqual({ ok: true, value: request });
  });

  it.each(PROPERTY_SETUP_STEP_DEFINITIONS)(
    "accepts the exact empty $stepId base-revision manifest",
    (definition) => {
      const expectedBaseRevisions = Object.fromEntries(
        definition.baseRevisionKeys.map((key, index) => [key, `revision:${index + 1}`]),
      );
      const request = {
        ...validRequest(),
        stepId: definition.stepId,
        payload: {},
        dirtyFields: [],
        expectedBaseRevisions,
      };

      expect(parseSavePropertySetupDraftRequest(request)).toEqual({ ok: true, value: request });
    },
  );

  it.each([
    null,
    [],
    "request",
    { ...validRequest(), unexpected: true },
    { ...validRequest(), stepId: "unknown" },
    { ...validRequest(), payload: { "room.name": { room_1: "Suite" } }, dirtyFields: [] },
    {
      ...validRequest(),
      stepId: "rooms",
      payload: { "room.beds": { room_1: [{ type: "king", unknown: true }] } },
      dirtyFields: ["room.beds"],
      expectedBaseRevisions: {
        "pms.room_types": "types:1",
        "pms.room_units": "units:1",
        "pms.room_media": "media:1",
      },
    },
    { ...validRequest(), dirtyFields: ["profile.short_description", "profile.short_description"] },
    { ...validRequest(), dirtyFields: ["profile.unknown"] },
    { ...validRequest(), dirtyFields: ["profile.gallery_images"] },
    { ...validRequest(), expectedBaseRevisions: { "hotel_catalog.profile": "profile:7" } },
    { ...validRequest(), expectedBaseRevisions: { ...PRESENT_BASE, extra: "revision:1" } },
    { ...validRequest(), expectedBaseRevisions: { ...PRESENT_BASE, "hotel_catalog.profile": "" } },
    { ...validRequest(), expectedTrackRevision: -1 },
    { ...validRequest(), expectedSessionRevision: 1.5 },
    { ...validRequest(), expectedDraftRevision: 2_147_483_647 },
    { ...validRequest(), payload: { "profile.hero_image": "https://example.com/image.jpg" } },
    {
      ...validRequest(),
      payload: { "profile.default_locale": "not a language" },
      dirtyFields: ["profile.default_locale"],
    },
    {
      ...validRequest(),
      payload: { "user.interface_locale": "de-DE" },
      dirtyFields: ["user.interface_locale"],
    },
    {
      ...validRequest(),
      stepId: "review",
      payload: { arbitrary: true },
      dirtyFields: [],
      expectedBaseRevisions: {},
    },
  ])("rejects an invalid request envelope", (request) => {
    expect(parseSavePropertySetupDraftRequest(request)).toMatchObject({
      ok: false,
      error: { code: "invalid_request" },
    });
  });

  it.each([
    { ...validRequest(), selectedTracks: ["hotel_operations"] },
    {
      ...validRequest(),
      payload: { "profile.short_description": { provider_secret: "value" } },
    },
    {
      ...validRequest(),
      payload: { "profile.short_description": { bankAccount: "12345678" } },
    },
    {
      ...validRequest(),
      payload: { "profile.short_description": { access_granted: true } },
    },
    {
      ...validRequest(),
      payload: { "profile.short_description": { permission: "hotel_catalog.setup.manage" } },
    },
  ])("rejects authorization, credential, or payment-destination fields", (request) => {
    expect(parseSavePropertySetupDraftRequest(request)).toMatchObject({
      ok: false,
      error: { code: "unsafe_payload" },
    });
  });

  it("allows sensitive-looking words in opaque entity IDs", () => {
    const roomsRequest = {
      ...validRequest(),
      stepId: "rooms",
      payload: { "room.name": { "account-suite": "Account Suite" } },
      dirtyFields: ["room.name"],
      expectedBaseRevisions: {
        "pms.room_types": "types:1",
        "pms.room_units": "units:1",
        "pms.room_media": "media:1",
      },
    };
    const pricingRequest = {
      ...validRequest(),
      stepId: "pricing",
      payload: { "rate.seasonal_prices": { "bank-holiday": { "account-suite": "190.00" } } },
      dirtyFields: ["rate.seasonal_prices"],
      expectedBaseRevisions: {
        "pms.pricing_settings": "pricing:1",
        "pms.rate_plans": "plans:1",
        "pms.rate_rules": "rules:1",
      },
    };
    const calendarRequest = {
      ...validRequest(),
      stepId: "calendar",
      payload: {
        "rate.initial_availability": {
          limits: { "bank-account-suite": 3 },
          confirmed: null,
        },
      },
      dirtyFields: ["rate.initial_availability"],
      expectedBaseRevisions: {
        "pms.operating_calendar": "calendar:1",
        "pms.inventory": "inventory:1",
        "pms.room_types": "types:1",
        "hotel_catalog.location": "location:1",
      },
    };

    expect(parseSavePropertySetupDraftRequest(roomsRequest).ok).toBe(true);
    expect(parseSavePropertySetupDraftRequest(pricingRequest).ok).toBe(true);
    expect(parseSavePropertySetupDraftRequest(calendarRequest).ok).toBe(true);
  });
});
