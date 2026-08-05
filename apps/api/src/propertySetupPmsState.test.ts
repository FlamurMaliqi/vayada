import { isPropertySetupBaseRevisionManifest } from "@vayada/domain-hotels";
import { parseBookingGuestPolicyPmsCurrentOwnerEvidence } from "@vayada/domain-booking";
import { describe, expect, it, vi } from "vitest";

import {
  createPropertySetupBookingGuestPolicyPmsCurrentOwnerEvidenceAdapter,
  createPropertySetupPmsStateProvider,
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
      expect(Object.values(fact.currentBaseRevisions)).toEqual(
        expect.arrayContaining([
          expect.stringMatching(
            /^(?:[a-z-]+:(?:0|[0-9a-f]{64})|hotel_catalog\.location:[0-9a-f-]{36}:r5)$/,
          ),
        ]),
      );
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

function options(overrides: Record<string, unknown> = {}) {
  return {
    owner: {
      getRoomOwnerSnapshot: vi.fn(async () => emptyRooms()),
      getInventoryOwnerSnapshot: vi.fn(async () => null),
    },
    pricing: { getPricingSourceSnapshot: vi.fn(async () => null) },
    recurringPricing: { getRecurringPricingBookingEvidence: vi.fn(async () => null) },
    mandatoryCharges: {
      getMandatoryChargeConfirmation: vi.fn(async () => ({
        outcome: "missing",
        organizationId,
        propertyId,
      })),
    },
    operatingCalendar: { getCurrentOperatingCalendarConfiguration: vi.fn(async () => null) },
    calendarRegistry: {} as never,
    catalogLocation: {
      ownerKey: "hotel_catalog.location",
      getCurrentLocationOwnerEvidence: vi.fn(async () => ({
        outcome: "available",
        evidence: {
          organizationId,
          propertyId,
          ownerKey: "hotel_catalog.location",
          sourceIdentity: `hotel_catalog.location:${propertyId}`,
          revision: 5,
          baseRevision: `hotel_catalog.location:${propertyId}:r5`,
        },
      })),
    },
    ...overrides,
  } as never;
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
    facts: {
      name: "Double Room",
      description: "A comfortable double room.",
      category: "double",
      occupancy: { maxGuests: 2, maxAdults: 2, maxChildren: 1 },
      attributes: { bedType: "double", bathroomType: "private", smokingPolicy: "non_smoking" },
    },
    roomFactsRevision: 2,
    roomUnitsRevision: 2,
    activeUnitCount: 1,
    roomMediaRevision: 2,
    mediaAssignmentCount: 1,
    roomAmenitiesRevision: 2,
    amenitiesReviewed: true,
  } as const;
}
