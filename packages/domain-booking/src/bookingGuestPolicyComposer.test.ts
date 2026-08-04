import { describe, expect, it } from "vitest";

import {
  composeBookingGuestPolicy,
  createBookingPricingSourceFingerprint,
  type BookingGuestPolicyCompositionInput,
  type BookingPricingOwnerEvidenceInput,
} from "./index.js";

const organizationId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const propertyId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const roomTypeId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const planId = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const additionalId = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
const nonRefundableId = "ffffffff-ffff-4fff-8fff-ffffffffffff";
const orphanRoomTypeId = "11111111-1111-4111-8111-111111111111";
const orphanPlanId = "22222222-2222-4222-8222-222222222222";
const now = "2026-08-04T10:00:00.000Z";
const request = { organizationId, propertyId };
const choices = {
  defaultGuestLanguage: "en" as const,
  childrenEnabled: true,
  adultAgeThreshold: 18,
  phoneRequired: true,
  arrivalTimeEnabled: false,
  specialRequestsEnabled: true,
  checkInTime: "15:00",
  checkOutTime: "11:00",
};
type TestInput = Omit<
  BookingGuestPolicyCompositionInput,
  "choices" | "pricing" | "catalogProfile"
> & {
  choices: typeof choices;
  pricing: BookingPricingOwnerEvidenceInput;
  catalogProfile: BookingGuestPolicyCompositionInput["catalogProfile"];
};

describe("Booking guest-policy composition", () => {
  it("composes immutable, structured disclosures bound to every owner revision", () => {
    const result = composeBookingGuestPolicy(compositionInput());

    expect(result.outcome).toBe("ready");
    if (result.outcome !== "ready") return;
    expect(result.bundle).toMatchObject({
      pricingCurrency: "EUR",
      propertyTimeZone: "Europe/Berlin",
      mandatoryChargeConfirmationRevision: 6,
      rates: [
        {
          roomTypeId,
          roomFactsRevision: 4,
          flexible: {
            freeCancellationDeadlineDays: 7,
            cutoff: { localTime: "15:00", timeZone: "Europe/Berlin" },
            afterDeadlinePenalty: "full_booking_amount",
            noShowPenalty: "full_booking_amount",
          },
          nonRefundable: {
            refundPolicy: "no_refund",
            paymentTiming: "prepay_full",
          },
          additionalGuest: {
            includedGuestsPerRoom: 2,
            amountDecimal: "30.00",
            currency: "EUR",
            countedGuestTypes: ["adult", "child"],
          },
        },
      ],
    });
    expect(result.bundle.sourceBindings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ ownerDomain: "hotel_catalog", revision: "profile:8" }),
        expect.objectContaining({ entityType: "pms_room_facts.v1", revision: "4" }),
        expect.objectContaining({
          entityType: "pms_mandatory_charge_confirmation.v1",
          revision: "6",
        }),
      ]),
    );
    expect(result.bundle.rates[0]!.additionalGuest!.source).toMatchObject({
      validationRevision: 2,
      materializationRevision: 3,
    });
    expect(Object.isFrozen(result.bundle.rates[0]!.flexible.cutoff)).toBe(true);
  });

  it("keeps deterministic policy hashes and excludes non-blocking form choices", () => {
    const first = composeBookingGuestPolicy(compositionInput());
    const reordered = compositionInput();
    reordered.pricing = {
      ...reordered.pricing,
      recurringPricing: {
        ...reordered.pricing.recurringPricing,
        sources: [...reordered.pricing.recurringPricing.sources].reverse(),
      },
    };
    const second = composeBookingGuestPolicy(reordered);
    const optionalChange = compositionInput();
    optionalChange.choices = { ...optionalChange.choices, phoneRequired: false };
    const third = composeBookingGuestPolicy(optionalChange);
    const policyChange = compositionInput();
    policyChange.choices = {
      ...policyChange.choices,
      childrenEnabled: false,
      adultAgeThreshold: 18,
    };
    const fourth = composeBookingGuestPolicy(policyChange);
    const sourceChange = compositionInput();
    sourceChange.catalogProfile = {
      outcome: "available",
      evidence: {
        source: { ...catalogSource(), revision: "profile:9" },
        timeZone: "Europe/Berlin",
      },
    };
    const fifth = composeBookingGuestPolicy(sourceChange);
    const reorderedKeys = compositionInput();
    reorderedKeys.catalogProfile = {
      outcome: "available",
      evidence: {
        source: {
          revision: "profile:8",
          entityId: propertyId,
          entityType: "property_profile",
          ownerDomain: "hotel_catalog",
        },
        timeZone: "Europe/Berlin",
      },
    };
    const sixth = composeBookingGuestPolicy(reorderedKeys);

    expect(first.outcome).toBe("ready");
    expect(second.outcome).toBe("ready");
    expect(third.outcome).toBe("ready");
    expect(fourth.outcome).toBe("ready");
    expect(fifth.outcome).toBe("ready");
    expect(sixth.outcome).toBe("ready");
    if (
      first.outcome !== "ready" ||
      second.outcome !== "ready" ||
      third.outcome !== "ready" ||
      fourth.outcome !== "ready" ||
      fifth.outcome !== "ready" ||
      sixth.outcome !== "ready"
    )
      return;
    expect(second.bundle.bundleHash).toBe(first.bundle.bundleHash);
    expect(second.bundle.sourceFingerprint).toBe(first.bundle.sourceFingerprint);
    expect(third.bundle.bundleHash).toBe(first.bundle.bundleHash);
    expect(third.bundle.choices.phoneRequired).toBe(false);
    expect(fourth.bundle.bundleHash).not.toBe(first.bundle.bundleHash);
    expect(fourth.bundle.rates[0]!.additionalGuest!.countedGuestTypes).toEqual(["adult"]);
    expect(fifth.bundle.sourceFingerprint).not.toBe(first.bundle.sourceFingerprint);
    expect(sixth.bundle.sourceFingerprint).toBe(first.bundle.sourceFingerprint);
  });

  it("fails closed for timezone, currency, capacity, disclosure, and confirmation gaps", () => {
    const cases: readonly [BookingGuestPolicyCompositionInput, string][] = [
      [
        {
          ...compositionInput(),
          catalogProfile: { outcome: "timezone_missing", source: catalogSource() },
        },
        "property_timezone_missing",
      ],
      [
        withPricing((pricing) => ({
          ...pricing,
          recurringPricing: { ...pricing.recurringPricing, currency: "USD" as never },
        })),
        "pricing_currency_mismatch",
      ],
      [
        withPricing((pricing) => {
          const room = pricing.roomPublication.rooms[0]!;
          return {
            ...pricing,
            roomPublication: {
              ...pricing.roomPublication,
              rooms: [
                {
                  ...room,
                  facts: {
                    ...room.facts,
                    occupancy: { ...room.facts.occupancy, maxAdults: 0 },
                  },
                },
              ],
            },
          };
        }),
        "room_capacity_invalid",
      ],
      [
        withPricing((pricing) => ({
          ...pricing,
          pricing: { ...pricing.pricing, flexibleRatePlans: [] },
        })),
        "flexible_rate_policy_missing",
      ],
      [
        withPricing((pricing) => {
          const plan = pricing.pricing.flexibleRatePlans[0]!;
          return {
            ...pricing,
            pricing: {
              ...pricing.pricing,
              flexibleRatePlans: [
                plan,
                {
                  ...plan,
                  roomTypeId: orphanRoomTypeId,
                  flexibleRatePlanId: orphanPlanId,
                },
              ],
            },
          };
        }),
        "pricing_source_invalid",
      ],
      [
        withPricing((pricing) => ({
          ...pricing,
          recurringPricing: {
            ...pricing.recurringPricing,
            sources: pricing.recurringPricing.sources.map((source) =>
              source.sourceKind === "non_refundable"
                ? {
                    ...source,
                    roomPlans: [
                      ...source.roomPlans,
                      {
                        ...source.roomPlans[0]!,
                        roomTypeId: orphanRoomTypeId,
                        flexibleRatePlanId: orphanPlanId,
                      },
                    ],
                  }
                : source,
            ),
          },
        })),
        "optional_rate_policy_invalid",
      ],
      [
        withPricing((pricing) => ({
          ...pricing,
          recurringPricing: {
            ...pricing.recurringPricing,
            sources: pricing.recurringPricing.sources.map((source) =>
              source.sourceKind === "non_refundable"
                ? { ...source, sourceId: additionalId, sourceRevision: 3 }
                : source,
            ),
          },
        })),
        "pricing_source_invalid",
      ],
      [
        { ...compositionInput(), mandatoryChargeConfirmation: { outcome: "missing" } },
        "mandatory_charge_confirmation_missing",
      ],
    ];

    for (const [input, code] of cases) {
      const result = composeBookingGuestPolicy(input);
      expect(result.outcome).toBe("blocked");
      if (result.outcome === "blocked")
        expect(result.blockers.map((candidate) => candidate.code)).toContain(code);
    }
  });

  it("invalidates the mandatory-charge confirmation when a pricing revision changes", () => {
    const input = compositionInput();
    const plan = input.pricing.pricing.flexibleRatePlans[0]!;
    input.pricing = {
      ...input.pricing,
      pricing: {
        ...input.pricing.pricing,
        flexibleRatePlans: [{ ...plan, flexibleRatePlanRevision: 4 }],
      },
      recurringPricing: {
        ...input.pricing.recurringPricing,
        sources: input.pricing.recurringPricing.sources.map((source) =>
          source.sourceKind === "additional_guest"
            ? { ...source, flexibleRatePlanRevision: 4 }
            : source.sourceKind === "non_refundable"
              ? {
                  ...source,
                  roomPlans: [{ ...source.roomPlans[0]!, flexibleRatePlanRevision: 4 }],
                }
              : source,
        ),
      },
    };

    const result = composeBookingGuestPolicy(input);
    expect(result.outcome).toBe("blocked");
    if (result.outcome === "blocked")
      expect(result.blockers.map(({ code }) => code)).toContain(
        "mandatory_charge_confirmation_stale",
      );
  });
});

function compositionInput(): TestInput {
  const pricing = ownerEvidence();
  const pricingSourceFingerprint = createBookingPricingSourceFingerprint(request, pricing);
  return {
    request,
    choices: { ...choices },
    catalogProfile: {
      outcome: "available",
      evidence: { source: catalogSource(), timeZone: "Europe/Berlin" },
    },
    pricing,
    mandatoryChargeConfirmation: {
      outcome: "available",
      evidence: {
        organizationId,
        propertyId,
        pricingSourceFingerprint,
        confirmationRevision: 6,
        confirmedAt: now,
      },
    },
  };
}

function ownerEvidence(): BookingPricingOwnerEvidenceInput {
  const binding = {
    roomTypeId,
    roomFactsRevision: 4,
    flexibleRatePlanId: planId,
    flexibleRatePlanRevision: 3,
  };
  const sourceBase = {
    contractVersion: "pms-recurring-pricing.v1" as const,
    propertyId,
    sourceRevision: 2,
    pricingCurrencyRevision: 2,
    currency: "EUR" as const,
    configuredState: "active" as const,
    validation: { state: "valid" as const, validationRevision: 2, validatedAt: now },
    lifecycle: "active" as const,
    materializationRevision: 3,
    createdAt: now,
    updatedAt: now,
  };
  return structuredClone({
    roomPublication: {
      contractVersion: "pms-room-publication.v1",
      propertyId,
      status: "ready",
      rooms: [
        {
          propertyId,
          roomTypeId,
          facts: {
            name: "Suite",
            description: "A complete room",
            category: null,
            occupancy: { maxGuests: 4, maxAdults: 4, maxChildren: 4 },
            beds: [],
            bedrooms: null,
            bathrooms: null,
            bathroomType: "private",
            size: null,
          },
          activeUnitCount: 1,
          media: [],
          amenities: [],
          sourceRevisions: {
            roomFactsRevision: 4,
            roomUnitsRevision: 1,
            roomMediaRevision: 1,
            roomAmenitiesRevision: 1,
          },
          sourceRevision: "room:4",
        },
      ],
      blockers: [],
      sourceRevision: "rooms:4",
    },
    pricing: {
      contractVersion: "pms-pricing.v1",
      propertyId,
      pricingCurrency: {
        contractVersion: "pms-pricing.v1",
        propertyId,
        currency: "EUR",
        pricingCurrencyRevision: 2,
        createdAt: now,
        updatedAt: now,
      },
      flexibleRatePlans: [
        {
          contractVersion: "pms-pricing.v1",
          propertyId,
          roomTypeId,
          flexibleRatePlanId: planId,
          flexibleRatePlanRevision: 3,
          sourceRoomFactsRevision: 4,
          baseAmount: { amountDecimal: "160.00", currency: "EUR" },
          cancellationTerms: {
            type: "free_until_days_before_arrival",
            freeCancellationDeadlineDays: 7,
            afterDeadlinePenalty: "full_booking_amount",
            noShowPenalty: "full_booking_amount",
          },
          createdAt: now,
          updatedAt: now,
        },
      ],
      capturedAt: now,
    },
    recurringPricing: {
      contractVersion: "pms-recurring-pricing.v1",
      propertyId,
      pricingCurrencyRevision: 2,
      optionalPricingAggregateRevision: 5,
      currency: "EUR",
      sources: [
        {
          ...sourceBase,
          sourceId: additionalId,
          sourceKind: "additional_guest",
          ...binding,
          maximumAdultGuests: 4,
          includedGuests: 2,
          amountDecimal: "30.00",
        },
        {
          ...sourceBase,
          sourceId: nonRefundableId,
          sourceKind: "non_refundable",
          discountPercent: 10,
          roomPlans: [binding],
          paymentTiming: "prepay_full",
          cancellationTerms: {
            type: "non_refundable",
            refundPolicy: "no_refund",
            noShowPenalty: "full_booking_amount",
          },
        },
      ],
      capturedAt: now,
    },
  }) as unknown as BookingPricingOwnerEvidenceInput;
}

function catalogSource() {
  return {
    ownerDomain: "hotel_catalog" as const,
    entityType: "property_profile" as const,
    entityId: propertyId,
    revision: "profile:8",
  };
}

function withPricing(
  change: (pricing: BookingPricingOwnerEvidenceInput) => BookingPricingOwnerEvidenceInput,
): TestInput {
  const input = compositionInput();
  input.pricing = change(input.pricing);
  return input;
}
