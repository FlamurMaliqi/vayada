import { describe, expect, it, vi } from "vitest";

import {
  MARKETPLACE_PREFERENCE_COMPENSATION_TYPES,
  createMarketplaceHotelCollaborationPreferencesEvidence,
  parseMarketplaceHotelCollaborationPreferencesReadModel,
  parseReplaceMarketplaceHotelCollaborationPreferencesRequest,
} from "./hotelCollaborationPreferences.js";

const PROPERTY_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

function request() {
  return {
    expectedRevision: 0,
    compensationTypes: ["paid", "free_stay"],
    contentPlatforms: ["youtube", "instagram"],
    contentTypes: ["photography", "post"],
    availability: { mode: "selected_months", selectedMonths: [12, 1] },
  };
}

function readyReadModel() {
  const { expectedRevision: _expectedRevision, ...preferences } =
    parseReplaceMarketplaceHotelCollaborationPreferencesRequest(request())!;
  return {
    contractVersion: "marketplace-hotel-collaboration-preferences.v1",
    propertyId: PROPERTY_ID,
    revision: 1,
    sourceRevision: "preferences:1",
    preferences,
    readiness: createMarketplaceHotelCollaborationPreferencesEvidence(PROPERTY_ID, 1, preferences),
  };
}

function missingReadModel() {
  return {
    contractVersion: "marketplace-hotel-collaboration-preferences.v1",
    propertyId: PROPERTY_ID,
    revision: 0,
    sourceRevision: "preferences:0",
    preferences: null,
    readiness: createMarketplaceHotelCollaborationPreferencesEvidence(PROPERTY_ID, 0, null),
  };
}

describe("Marketplace hotel collaboration preferences", () => {
  it("parses all four required groups into canonical order", () => {
    expect(parseReplaceMarketplaceHotelCollaborationPreferencesRequest(request())).toEqual({
      expectedRevision: 0,
      compensationTypes: ["free_stay", "paid"],
      contentPlatforms: ["instagram", "youtube"],
      contentTypes: ["post", "photography"],
      availability: { mode: "selected_months", selectedMonths: [1, 12] },
    });
  });

  it("returns immutable canonical requests and vocabularies", () => {
    const parsed = parseReplaceMarketplaceHotelCollaborationPreferencesRequest(request())!;
    expect(Object.isFrozen(parsed)).toBe(true);
    expect(Object.isFrozen(parsed.compensationTypes)).toBe(true);
    expect(Object.isFrozen(parsed.availability.selectedMonths)).toBe(true);
    expect(Object.isFrozen(MARKETPLACE_PREFERENCE_COMPENSATION_TYPES)).toBe(true);
  });

  it.each([
    ["unknown top-level input", { ...request(), title: "Offer" }],
    ["missing compensation", { ...request(), compensationTypes: [] }],
    ["unknown platform", { ...request(), contentPlatforms: ["threads"] }],
    ["duplicate content type", { ...request(), contentTypes: ["post", "post"] }],
    [
      "selected months without a month",
      { ...request(), availability: { mode: "selected_months", selectedMonths: [] } },
    ],
    [
      "year-round with selected months",
      { ...request(), availability: { mode: "year_round", selectedMonths: [1] } },
    ],
    [
      "month outside 1 to 12",
      { ...request(), availability: { mode: "selected_months", selectedMonths: [13] } },
    ],
    ["negative revision", { ...request(), expectedRevision: -1 }],
  ])("rejects %s", (_name, input) => {
    expect(parseReplaceMarketplaceHotelCollaborationPreferencesRequest(input)).toBeNull();
  });

  it("requires an explicit availability answer", () => {
    expect(
      parseReplaceMarketplaceHotelCollaborationPreferencesRequest({
        ...request(),
        availability: null,
      }),
    ).toBeNull();
    expect(
      parseReplaceMarketplaceHotelCollaborationPreferencesRequest({
        ...request(),
        availability: { mode: "year_round", selectedMonths: [] },
      }),
    ).toMatchObject({ availability: { mode: "year_round", selectedMonths: [] } });
  });

  it("rejects accessors and sparse selections without invoking them", () => {
    const getter = vi.fn(() => ["free_stay"]);
    const accessor = { ...request() };
    Object.defineProperty(accessor, "compensationTypes", { enumerable: true, get: getter });
    expect(parseReplaceMarketplaceHotelCollaborationPreferencesRequest(accessor)).toBeNull();
    expect(getter).not.toHaveBeenCalled();

    const sparse = request();
    sparse.compensationTypes = Array(1) as typeof sparse.compensationTypes;
    expect(parseReplaceMarketplaceHotelCollaborationPreferencesRequest(sparse)).toBeNull();
  });

  it("rejects array subclasses and altered array prototypes", () => {
    class HostileMonths extends Array<number> {
      override some(): boolean {
        return false;
      }
    }
    const subclass = request();
    const hostileMonths = new HostileMonths();
    hostileMonths.push(13);
    subclass.availability.selectedMonths = hostileMonths;
    expect(parseReplaceMarketplaceHotelCollaborationPreferencesRequest(subclass)).toBeNull();

    const altered = request();
    Object.setPrototypeOf(altered.contentTypes, null);
    expect(parseReplaceMarketplaceHotelCollaborationPreferencesRequest(altered)).toBeNull();
  });

  it("validates and emits from one descriptor snapshot when proxies change reads", () => {
    const changingRequest = new Proxy(request(), {
      get(target, key, receiver) {
        if (key === "expectedRevision") return -1;
        return Reflect.get(target, key, receiver);
      },
    });
    expect(
      parseReplaceMarketplaceHotelCollaborationPreferencesRequest(changingRequest),
    ).toMatchObject({ expectedRevision: 0 });

    const hostileMonths = new Proxy([13], {
      get(target, key, receiver) {
        if (key === "some") return () => false;
        if (key === Symbol.iterator)
          return function* () {
            yield 1;
          };
        return Reflect.get(target, key, receiver);
      },
    });
    expect(
      parseReplaceMarketplaceHotelCollaborationPreferencesRequest({
        ...request(),
        availability: { mode: "selected_months", selectedMonths: hostileMonths },
      }),
    ).toBeNull();

    const parsed = parseReplaceMarketplaceHotelCollaborationPreferencesRequest(request())!;
    const { expectedRevision: _expectedRevision, ...preferences } = parsed;
    expect(() =>
      createMarketplaceHotelCollaborationPreferencesEvidence(PROPERTY_ID, 1, {
        ...preferences,
        availability: { mode: "selected_months", selectedMonths: hostileMonths },
      }),
    ).toThrow(/complete canonical document/i);
  });

  it("represents absence as four structured omissions at exact revision zero", () => {
    expect(createMarketplaceHotelCollaborationPreferencesEvidence(PROPERTY_ID, 0, null)).toEqual({
      contractVersion: "marketplace-hotel-collaboration-preferences-evidence.v1",
      product: "marketplace",
      groupId: "marketplace.collaboration_preferences",
      owningStepId: "marketplace_preferences",
      source: {
        ownerDomain: "marketplace",
        entityType: "hotel_collaboration_preferences",
        entityId: PROPERTY_ID,
        revision: "preferences:0",
      },
      status: "blocked",
      omissions: [
        {
          kind: "user_fixable",
          code: "compensation_types_unanswered",
          message: "Choose at least one compensation type.",
        },
        {
          kind: "user_fixable",
          code: "content_platforms_unanswered",
          message: "Choose at least one content platform.",
        },
        {
          kind: "user_fixable",
          code: "content_types_unanswered",
          message: "Choose at least one content type.",
        },
        {
          kind: "user_fixable",
          code: "availability_unanswered",
          message: "Choose year-round or selected-month availability.",
        },
      ],
    });
  });

  it("strictly parses correlated missing and ready read models", () => {
    const missing = parseMarketplaceHotelCollaborationPreferencesReadModel(missingReadModel());
    expect(missing).toMatchObject({
      revision: 0,
      preferences: null,
      readiness: { status: "blocked" },
    });

    const ready = parseMarketplaceHotelCollaborationPreferencesReadModel(readyReadModel());
    expect(ready).toMatchObject({
      revision: 1,
      sourceRevision: "preferences:1",
      readiness: { status: "ready", omissions: [] },
    });
    expect(Object.isFrozen(ready)).toBe(true);
    expect(Object.isFrozen(ready?.preferences?.contentTypes)).toBe(true);
  });

  it.each([
    [
      "zero revision with preferences",
      { ...missingReadModel(), preferences: readyReadModel().preferences },
    ],
    ["positive revision without preferences", { ...readyReadModel(), preferences: null }],
    ["wrong source revision", { ...readyReadModel(), sourceRevision: "preferences:2" }],
    [
      "readiness from another property",
      {
        ...readyReadModel(),
        readiness: createMarketplaceHotelCollaborationPreferencesEvidence(
          "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
          1,
          readyReadModel().preferences,
        ),
      },
    ],
    [
      "owner omission on a ready document",
      {
        ...readyReadModel(),
        readiness: createMarketplaceHotelCollaborationPreferencesEvidence(PROPERTY_ID, 0, null),
      },
    ],
  ])("rejects %s", (_name, input) => {
    expect(parseMarketplaceHotelCollaborationPreferencesReadModel(input)).toBeNull();
  });

  it("treats hostile read input as malformed without invoking accessors", () => {
    const getter = vi.fn(() => readyReadModel().preferences);
    const accessor = { ...readyReadModel() };
    Object.defineProperty(accessor, "preferences", { enumerable: true, get: getter });
    expect(parseMarketplaceHotelCollaborationPreferencesReadModel(accessor)).toBeNull();
    expect(getter).not.toHaveBeenCalled();

    const cyclic = readyReadModel();
    cyclic.readiness = cyclic as never;
    expect(parseMarketplaceHotelCollaborationPreferencesReadModel(cyclic)).toBeNull();
  });

  it("rejects inconsistent zero/nonzero evidence", () => {
    const parsed = parseReplaceMarketplaceHotelCollaborationPreferencesRequest(request())!;
    const { expectedRevision: _expectedRevision, ...preferences } = parsed;
    expect(() =>
      createMarketplaceHotelCollaborationPreferencesEvidence(PROPERTY_ID, 0, preferences),
    ).toThrow(/revision zero/i);
    expect(() =>
      createMarketplaceHotelCollaborationPreferencesEvidence(PROPERTY_ID, 1, null),
    ).toThrow(/revision zero/i);
    expect(() =>
      createMarketplaceHotelCollaborationPreferencesEvidence(PROPERTY_ID, 1, {
        ...preferences,
        contentTypes: [],
      }),
    ).toThrow(/complete canonical document/i);
  });
});
