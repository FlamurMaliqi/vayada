import { createHash } from "node:crypto";

import { parseBookingGuestPolicyPmsCurrentOwnerEvidence } from "@vayada/domain-booking";
import { isPropertySetupBaseRevisionManifest } from "@vayada/domain-hotels";
import {
  createPmsMandatoryChargePricingSourceSnapshot,
  parsePmsMandatoryChargePricingSourceFingerprint,
  parsePmsPricingSourceSnapshot,
  parsePmsRecurringPricingBookingEvidence,
  parseRoomTypeFacts,
} from "@vayada/domain-pms";
import { describe, expect, it, vi } from "vitest";

import {
  createPropertySetupBookingGuestPolicyPmsCurrentOwnerEvidenceAdapter,
  createPropertySetupPmsStateProvider,
  type PropertySetupPmsStateOptions,
} from "./platform/propertySetupPmsState.js";

const organizationId = "11111111-1111-4111-8111-111111111111";
const propertyId = "22222222-2222-4222-8222-222222222222";
const actorUserId = "33333333-3333-4333-8333-333333333333";

describe("property setup PMS owner state", () => {
  it("returns complete exact-key first-visit manifests from truthful empty owner facts", async () => {
    const inventory = vi.fn();
    const provider = createPropertySetupPmsStateProvider(
      options({
        owner: {
          getRoomOwnerSnapshot: vi.fn(async () => emptyRooms()),
          getInventoryOwnerSnapshot: inventory.mockResolvedValue(null),
        },
      }),
    );

    const result = await provider.getOwnerState(request());
    expect(result).toMatchObject({
      outcome: "found",
      facts: [
        {
          stepId: "rooms",
          state: "not_started",
          sourceRevision: expect.stringMatching(/^rooms-state:[0-9a-f]{64}$/),
        },
        { stepId: "pricing", state: "not_started" },
        { stepId: "calendar", state: "not_started" },
      ],
    });
    if (result.outcome !== "found") throw new Error("Expected PMS facts");
    for (const fact of result.facts) {
      expect(isPropertySetupBaseRevisionManifest(fact.stepId, fact.currentBaseRevisions)).toBe(
        true,
      );
      for (const revision of Object.values(fact.currentBaseRevisions)) {
        expect(revision).toMatch(
          /^(?:[a-z-]+:(?:0|[0-9a-f]{64})|hotel_catalog\.location:[0-9a-f-]{36}:r5)$/,
        );
      }
    }
    expect(Object.keys(result.facts[0]!.currentBaseRevisions)).toEqual([
      "pms.room_types",
      "pms.room_units",
      "pms.room_media",
    ]);
    expect(Object.keys(result.facts[1]!.currentBaseRevisions)).toEqual([
      "pms.pricing_settings",
      "pms.rate_plans",
      "pms.rate_rules",
    ]);
    expect(Object.keys(result.facts[2]!.currentBaseRevisions)).toEqual([
      "pms.operating_calendar",
      "pms.inventory",
      "pms.room_types",
      "hotel_catalog.location",
    ]);
    expect(inventory).toHaveBeenCalledTimes(2);
  });

  it("fails closed on owner revision races and malformed mandatory-charge facts", async () => {
    const getRoomOwnerSnapshot = vi
      .fn()
      .mockResolvedValueOnce(emptyRooms())
      .mockResolvedValueOnce({ ...emptyRooms(), rooms: [completeRoom()] });
    const raced = createPropertySetupPmsStateProvider(
      options({
        owner: {
          getRoomOwnerSnapshot,
          getInventoryOwnerSnapshot: vi.fn(async () => null),
        },
      }),
    );
    await expect(raced.getOwnerState(request())).resolves.toEqual({
      outcome: "provider_failure",
    });

    const malformed = createPropertySetupPmsStateProvider(
      options({
        mandatoryCharges: {
          getMandatoryChargeConfirmation: vi.fn(async () => ({ outcome: "missing" }) as never),
        },
      }),
    );
    await expect(malformed.getOwnerState(request())).resolves.toEqual({
      outcome: "provider_failure",
    });
  });

  it("reports independent partial pricing state without requiring recurring pricing", async () => {
    const provider = createPropertySetupPmsStateProvider(
      options({
        owner: {
          getRoomOwnerSnapshot: vi.fn(async (_input) => emptyRooms()),
          getInventoryOwnerSnapshot: vi.fn(async (_input) => null),
        },
        pricing: { getPricingSourceSnapshot: vi.fn(async () => pricingSnapshot()) },
      }),
    );

    await expect(provider.getOwnerState(request())).resolves.toMatchObject({
      outcome: "found",
      facts: [
        { stepId: "rooms", state: "not_started" },
        { stepId: "pricing", state: "saved" },
        { stepId: "calendar", state: "not_started" },
      ],
    });
  });

  it("fails closed on impossible recurring evidence without base pricing", async () => {
    const provider = createPropertySetupPmsStateProvider(
      options({
        recurringPricing: {
          getRecurringPricingBookingEvidence: vi.fn(async () => recurringPricingSnapshot()),
        },
      }),
    );

    await expect(provider.getOwnerState(request())).resolves.toEqual({
      outcome: "provider_failure",
    });
  });

  it("marks rooms and pricing complete only from matching current owner evidence", async () => {
    const pricing = pricingSnapshot();
    const recurring = recurringPricingSnapshot();
    const pricingSource = createPmsMandatoryChargePricingSourceSnapshot({
      rooms: [
        {
          roomTypeId: completeRoom().roomTypeId,
          roomFactsRevision: completeRoom().roomFactsRevision,
          occupancy: completeRoom().facts.occupancy,
        },
      ],
      pricing,
      recurringPricing: recurring,
    });
    const fingerprint = parsePmsMandatoryChargePricingSourceFingerprint(
      createHash("sha256").update(pricingSource.serializedPayload).digest("hex"),
    )!;
    const provider = createPropertySetupPmsStateProvider(
      options({
        owner: {
          getRoomOwnerSnapshot: vi.fn(async (_input) => ({
            ...emptyRooms(),
            rooms: [completeRoom()],
          })),
          getInventoryOwnerSnapshot: vi.fn(async (_input) => null),
        },
        pricing: { getPricingSourceSnapshot: vi.fn(async () => pricing) },
        recurringPricing: {
          getRecurringPricingBookingEvidence: vi.fn(async () => recurring),
        },
        mandatoryCharges: {
          getMandatoryChargeConfirmation: vi.fn(async () => ({
            outcome: "available" as const,
            organizationId,
            propertyId,
            evidence: {
              organizationId,
              propertyId,
              pricingSourceFingerprint: fingerprint,
              confirmationRevision: 3,
              confirmedAt: "2026-08-05T12:00:00.000Z",
            },
          })),
        },
      }),
    );

    await expect(provider.getOwnerState(request())).resolves.toMatchObject({
      outcome: "found",
      facts: [
        { stepId: "rooms", state: "complete" },
        { stepId: "pricing", state: "complete" },
        { stepId: "calendar", state: "not_started" },
      ],
    });
  });

  it("bridges exact current PMS guest-policy keys and rejects revision races", async () => {
    const owner = {
      getRoomOwnerSnapshot: vi.fn(async () => emptyRooms()),
      getInventoryOwnerSnapshot: vi.fn(async () => null),
    };
    const bridge = createPropertySetupBookingGuestPolicyPmsCurrentOwnerEvidenceAdapter({
      owner,
      pricing: { getPricingSourceSnapshot: vi.fn(async () => null) },
    });
    const result = await bridge.getCurrentGuestPolicyBaseRevisions({
      organizationId,
      propertyId,
    });
    expect(
      parseBookingGuestPolicyPmsCurrentOwnerEvidence(result, { organizationId, propertyId }),
    ).toEqual(result);
    expect(result).toMatchObject({
      outcome: "available",
      evidence: {
        revisions: {
          "pms.pricing_settings": "pricing:0",
          "pms.rate_plans": expect.stringMatching(/^rate-plans:[0-9a-f]{64}$/),
          "pms.room_types": expect.stringMatching(/^room-types:[0-9a-f]{64}$/),
        },
      },
    });

    const racedOwner = {
      ...owner,
      getRoomOwnerSnapshot: vi
        .fn()
        .mockResolvedValueOnce(emptyRooms())
        .mockResolvedValueOnce({ ...emptyRooms(), rooms: [completeRoom()] }),
    };
    await expect(
      createPropertySetupBookingGuestPolicyPmsCurrentOwnerEvidenceAdapter({
        owner: racedOwner,
        pricing: { getPricingSourceSnapshot: vi.fn(async () => null) },
      }).getCurrentGuestPolicyBaseRevisions({ organizationId, propertyId }),
    ).resolves.toEqual({ outcome: "unavailable", errorSource: "provider" });
  });
});

function options(
  overrides: Partial<PropertySetupPmsStateOptions> = {},
): PropertySetupPmsStateOptions {
  return {
    owner: {
      getRoomOwnerSnapshot: vi.fn(async (_input) => emptyRooms()),
      getInventoryOwnerSnapshot: vi.fn(async (_input) => null),
    },
    pricing: { getPricingSourceSnapshot: vi.fn(async () => null) },
    recurringPricing: { getRecurringPricingBookingEvidence: vi.fn(async () => null) },
    mandatoryCharges: {
      getMandatoryChargeConfirmation: vi.fn(async () => ({
        outcome: "missing" as const,
        organizationId,
        propertyId,
      })),
    },
    operatingCalendar: { getCurrentOperatingCalendarConfiguration: vi.fn(async () => null) },
    calendarRegistry: {
      ownerDomain: "hotel_catalog",
      registryVersion: "test.v1",
      isCanonicalIanaTimeZone: vi.fn(() => true),
    },
    catalogLocation: {
      ownerKey: "hotel_catalog.location",
      getCurrentLocationOwnerEvidence: vi.fn(async () => ({
        outcome: "available" as const,
        evidence: {
          organizationId,
          propertyId,
          ownerKey: "hotel_catalog.location" as const,
          sourceIdentity: `hotel_catalog.location:${propertyId}` as const,
          revision: 5,
          baseRevision: `hotel_catalog.location:${propertyId}:r5` as const,
        },
      })),
    },
    ...overrides,
  };
}

function request() {
  return {
    organizationId,
    propertyId,
    actorUserId,
    selectedTracks: ["hotel_operations"] as const,
    expectedTrackRevision: 3,
    stepIds: ["rooms", "pricing", "calendar"] as const,
  };
}

function emptyRooms() {
  return {
    organizationId,
    propertyId,
    rooms: [],
  } as const;
}

function completeRoom() {
  return {
    roomTypeId: "44444444-4444-4444-8444-444444444444",
    facts: parseRoomTypeFacts({
      name: "Double Room",
      description: "A comfortable double room.",
      category: null,
      occupancy: { maxGuests: 2, maxAdults: 2, maxChildren: 1 },
      beds: [{ type: "double", quantity: 1 }],
      bedrooms: 1,
      bathrooms: 1,
      bathroomType: "private",
      size: null,
    })!,
    roomFactsRevision: 2,
    roomUnitsRevision: 2,
    activeUnitCount: 1,
    roomMediaRevision: 2,
    mediaAssignmentCount: 1,
    roomAmenitiesRevision: 2,
    amenitiesReviewed: true,
  } as const;
}

function pricingSnapshot() {
  return parsePmsPricingSourceSnapshot({
    contractVersion: "pms-pricing.v1",
    propertyId,
    pricingCurrency: {
      contractVersion: "pms-pricing.v1",
      propertyId,
      currency: "EUR",
      pricingCurrencyRevision: 2,
      createdAt: "2026-08-05T12:00:00.000Z",
      updatedAt: "2026-08-05T12:00:00.000Z",
    },
    flexibleRatePlans: [
      {
        contractVersion: "pms-pricing.v1",
        propertyId,
        roomTypeId: completeRoom().roomTypeId,
        flexibleRatePlanId: "55555555-5555-4555-8555-555555555555",
        flexibleRatePlanRevision: 3,
        sourceRoomFactsRevision: completeRoom().roomFactsRevision,
        baseAmount: { amountDecimal: "160.00", currency: "EUR" },
        cancellationTerms: {
          type: "free_until_days_before_arrival",
          freeCancellationDeadlineDays: 7,
          afterDeadlinePenalty: "full_booking_amount",
          noShowPenalty: "full_booking_amount",
        },
        createdAt: "2026-08-05T12:00:00.000Z",
        updatedAt: "2026-08-05T12:00:00.000Z",
      },
    ],
    capturedAt: "2026-08-05T12:00:00.000Z",
  })!;
}

function recurringPricingSnapshot() {
  return parsePmsRecurringPricingBookingEvidence({
    contractVersion: "pms-recurring-pricing.v1",
    propertyId,
    pricingCurrencyRevision: 2,
    optionalPricingAggregateRevision: 0,
    currency: "EUR",
    sources: [],
    capturedAt: "2026-08-05T12:00:00.000Z",
  })!;
}
