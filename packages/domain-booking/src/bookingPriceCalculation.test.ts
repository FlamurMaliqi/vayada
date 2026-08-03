import { describe, expect, it } from "vitest";

import { createFinancePaymentReadinessSnapshot } from "@vayada/domain-finance";
import {
  parsePmsPricingSourceSnapshot,
  parsePmsRecurringPricingBookingEvidence,
} from "@vayada/domain-pms";

import {
  applyBookingPricePercentageDiscount,
  BOOKING_PRICE_CALCULATION_CONTRACT_VERSION,
  BOOKING_PRICE_MAX_MINOR_UNITS,
  BOOKING_PRICE_V1_ALLOCATION_RULE,
  calculateBookingPrice,
  formatBookingPriceMinorUnits,
  roundBookingPriceDecimalToMinorUnits,
  type BookingPriceCalculationInput,
} from "./bookingPriceCalculation.js";
import { createBookingPricingSourceFingerprint } from "./bookingPricingEvidence.js";

const organizationId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const propertyId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const roomTypeId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const flexibleRatePlanId = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const seasonId = "11111111-1111-4111-8111-111111111111";
const weekendId = "22222222-2222-4222-8222-222222222222";
const additionalGuestId = "33333333-3333-4333-8333-333333333333";
const nonRefundableId = "44444444-4444-4444-8444-444444444444";
const now = "2026-08-03T14:30:00.000Z";

const roomBinding = {
  roomTypeId,
  roomFactsRevision: 4,
  flexibleRatePlanId,
  flexibleRatePlanRevision: 3,
} as const;

function pricing(baseAmount = "160.00", currency = "EUR") {
  return parsePmsPricingSourceSnapshot({
    contractVersion: "pms-pricing.v1",
    propertyId,
    pricingCurrency: {
      contractVersion: "pms-pricing.v1",
      propertyId,
      currency,
      pricingCurrencyRevision: 2,
      createdAt: now,
      updatedAt: now,
    },
    flexibleRatePlans: [
      {
        contractVersion: "pms-pricing.v1",
        propertyId,
        roomTypeId,
        flexibleRatePlanId,
        flexibleRatePlanRevision: 3,
        sourceRoomFactsRevision: 4,
        baseAmount: { amountDecimal: baseAmount, currency },
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
  })!;
}

function recurring() {
  return parsePmsRecurringPricingBookingEvidence({
    contractVersion: "pms-recurring-pricing.v1",
    propertyId,
    pricingCurrencyRevision: 2,
    optionalPricingAggregateRevision: 5,
    currency: "EUR",
    sources: [
      {
        ...sourceBase(seasonId),
        sourceKind: "season",
        name: "Summer",
        startMonthDay: "06-01",
        endMonthDay: "08-31",
        roomPrices: [{ ...roomBinding, amountDecimal: "180.00" }],
      },
      {
        ...sourceBase(weekendId),
        sourceKind: "weekend_surcharge",
        weekdays: ["friday", "saturday"],
        roomSurcharges: [{ ...roomBinding, amountDecimal: "15.00" }],
      },
      {
        ...sourceBase(additionalGuestId),
        sourceKind: "additional_guest",
        ...roomBinding,
        maximumAdultGuests: 4,
        includedGuests: 2,
        amountDecimal: "25.00",
      },
      {
        ...sourceBase(nonRefundableId),
        sourceKind: "non_refundable",
        discountPercent: 10,
        roomPlans: [roomBinding],
        paymentTiming: "prepay_full",
        cancellationTerms: {
          type: "non_refundable",
          refundPolicy: "no_refund",
          noShowPenalty: "full_booking_amount",
        },
      },
    ],
    capturedAt: now,
  })!;
}

function sourceBase(sourceId: string) {
  return {
    contractVersion: "pms-recurring-pricing.v1",
    propertyId,
    sourceId,
    sourceRevision: 3,
    pricingCurrencyRevision: 2,
    currency: "EUR",
    configuredState: "active",
    validation: { state: "valid", validationRevision: 2, validatedAt: now },
    lifecycle: "active",
    materializationRevision: 1,
    createdAt: now,
    updatedAt: now,
  } as const;
}

function roomPublication() {
  return {
    contractVersion: "pms-room-publication.v1" as const,
    propertyId,
    status: "ready" as const,
    rooms: [
      {
        propertyId,
        roomTypeId,
        facts: {
          name: "Suite",
          description: "A completed room type",
          category: null,
          occupancy: { maxGuests: 4, maxAdults: 4, maxChildren: 0 },
          beds: [],
          bedrooms: null,
          bathrooms: null,
          bathroomType: "private" as const,
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
    sourceRevision: "room-publication:4",
  };
}

function calculationInput(): BookingPriceCalculationInput {
  const pricingEvidence = pricing();
  const recurringPricing = recurring();
  const rooms = roomPublication();
  return {
    organizationId,
    propertyId,
    roomTypeId,
    flexibleRatePlanId,
    pricingSourceFingerprint: createBookingPricingSourceFingerprint(
      { organizationId, propertyId },
      { roomPublication: rooms, pricing: pricingEvidence, recurringPricing },
    ),
    roomCount: 2,
    chargeableGuestCount: 3,
    additionalGuestSourceId: additionalGuestId,
    selectedRate: { kind: "flexible" },
    nights: [
      {
        stayDate: "2026-08-08",
        appliedSeasonSourceId: seasonId,
        appliedWeekendSurchargeSourceId: weekendId,
      },
      {
        stayDate: "2026-08-07",
        appliedSeasonSourceId: null,
        appliedWeekendSurchargeSourceId: null,
      },
    ],
    pricing: pricingEvidence,
    recurringPricing,
    roomPublication: rooms,
    financePaymentReadiness: null,
  };
}

function withCurrentFingerprint(input: BookingPriceCalculationInput): BookingPriceCalculationInput {
  return {
    ...input,
    pricingSourceFingerprint: createBookingPricingSourceFingerprint(
      { organizationId: input.organizationId, propertyId: input.propertyId },
      {
        roomPublication: input.roomPublication,
        pricing: input.pricing,
        recurringPricing: input.recurringPricing,
      },
    ),
  };
}

function financeWithUnreadyCard() {
  return createFinancePaymentReadinessSnapshot({
    propertyId,
    paymentMethodsRevision: 3,
    selectedMethods: ["card", "pay_at_property"],
    committedPricing: {
      contractVersion: "pms-pricing.v1",
      currency: "EUR",
      pricingCurrencyRevision: 2,
    },
    currentPricing: {
      contractVersion: "pms-pricing.v1",
      currency: "EUR",
      pricingCurrencyRevision: 2,
    },
    updatedAt: now,
  });
}

describe("Booking decimal pricing", () => {
  it("uses named scale-2 decimal round-half-up fixtures", () => {
    expect(roundBookingPriceDecimalToMinorUnits("1.0049")).toBe("100");
    expect(roundBookingPriceDecimalToMinorUnits("1.0050")).toBe("101");
    expect(roundBookingPriceDecimalToMinorUnits("1.0051")).toBe("101");
    expect(roundBookingPriceDecimalToMinorUnits("9.999")).toBe("1000");
    expect(roundBookingPriceDecimalToMinorUnits("0.004999999999999999")).toBe("0");
    expect(formatBookingPriceMinorUnits("0")).toBe("0.00");
    expect(formatBookingPriceMinorUnits("1000")).toBe("10.00");

    for (const invalid of ["-1.00", "01.00", "1.", ".50", "1e2", 1.005, "x"]) {
      expect(roundBookingPriceDecimalToMinorUnits(invalid)).toBeNull();
    }
    expect(formatBookingPriceMinorUnits("01")).toBeNull();
    expect(
      formatBookingPriceMinorUnits((BigInt(BOOKING_PRICE_MAX_MINOR_UNITS) + 1n).toString()),
    ).toBeNull();
  });

  it("applies integer-rational percentage discounts with one half-up rounding", () => {
    expect(applyBookingPricePercentageDiscount("15", 10)).toEqual({
      discountMinorUnits: "1",
      finalMinorUnits: "14",
    });
    expect(applyBookingPricePercentageDiscount("14", 10)).toEqual({
      discountMinorUnits: "1",
      finalMinorUnits: "13",
    });
    expect(applyBookingPricePercentageDiscount("999", 50)).toEqual({
      discountMinorUnits: "499",
      finalMinorUnits: "500",
    });
    expect(applyBookingPricePercentageDiscount("15", 0)).toBeNull();
    expect(applyBookingPricePercentageDiscount("15", 51)).toBeNull();
  });

  it("calculates canonical per-night effects in the required order without mutating inputs", () => {
    const input = calculationInput();
    const original = JSON.stringify(input);
    const result = calculateBookingPrice(input);

    expect(result).toMatchObject({
      contractVersion: BOOKING_PRICE_CALCULATION_CONTRACT_VERSION,
      pricingSourceFingerprint: input.pricingSourceFingerprint,
      currency: "EUR",
      scale: 2,
      roundingMode: "decimal_round_half_up",
      allocationRule: BOOKING_PRICE_V1_ALLOCATION_RULE,
      roomCount: 2,
      includedGuestsPerRoom: 2,
      chargeableGuestCount: 3,
      selectedRate: {
        kind: "flexible",
        cancellationTerms: { freeCancellationDeadlineDays: 7 },
      },
      sourceRevisions: {
        pricingCurrencyRevision: 2,
        roomFactsRevision: 4,
        flexibleRatePlanRevision: 3,
        optionalPricingAggregateRevision: 5,
      },
      stayTotalMinorUnits: "86000",
    });
    expect(result.nights.map(({ stayDate }) => stayDate)).toEqual(["2026-08-07", "2026-08-08"]);
    expect(result.nights[0]).toMatchObject({
      baseAmount: { kind: "standard", amountDecimal: "160.00" },
      baseRoomTotalMinorUnits: "32000",
      weekendSurcharge: null,
      additionalGuest: {
        amountDecimal: "25.00",
        chargeableGuestCount: 3,
        totalMinorUnits: "7500",
        source: {
          sourceId: additionalGuestId,
          sourceRevision: 3,
          validationRevision: 2,
          materializationRevision: 1,
        },
      },
      flexibleNightTotalMinorUnits: "39500",
      nonRefundableDiscount: null,
      finalNightTotalMinorUnits: "39500",
    });
    expect(result.nights[1]).toMatchObject({
      baseAmount: {
        kind: "seasonal",
        amountDecimal: "180.00",
        source: {
          sourceId: seasonId,
          sourceRevision: 3,
          validationRevision: 2,
          materializationRevision: 1,
        },
      },
      baseRoomTotalMinorUnits: "36000",
      weekendSurcharge: {
        amountDecimal: "15.00",
        roomTotalMinorUnits: "3000",
        source: {
          sourceId: weekendId,
          sourceRevision: 3,
          validationRevision: 2,
          materializationRevision: 1,
        },
      },
      additionalGuest: {
        totalMinorUnits: "7500",
        source: {
          sourceId: additionalGuestId,
          sourceRevision: 3,
          validationRevision: 2,
          materializationRevision: 1,
        },
      },
      flexibleNightTotalMinorUnits: "46500",
      finalNightTotalMinorUnits: "46500",
    });
    expect(JSON.stringify(input)).toBe(original);
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.nights)).toBe(true);
    expect(Object.isFrozen(result.nights[1]!.weekendSurcharge)).toBe(true);
  });

  it("fails non-refundable selection closed while Finance reports card unready", () => {
    const input = calculationInput();
    expect(() =>
      calculateBookingPrice({
        ...input,
        selectedRate: { kind: "non_refundable", sourceId: nonRefundableId },
        financePaymentReadiness: financeWithUnreadyCard(),
      }),
    ).toThrow("Booking price calculation input is invalid");
    expect(
      calculateBookingPrice({ ...input, financePaymentReadiness: null }).selectedRate.kind,
    ).toBe("flexible");
  });

  it("rejects unresolved or inconsistent source effects instead of inferring applicability", () => {
    const input = calculationInput();
    const staleFingerprint = structuredClone(input) as BookingPriceCalculationInput;
    Object.assign(staleFingerprint.pricing.flexibleRatePlans[0]!.baseAmount, {
      amountDecimal: "161.00",
    });
    for (const changed of [
      staleFingerprint,
      {
        ...input,
        nights: [input.nights[0]!, input.nights[0]!],
      },
      {
        ...input,
        nights: [
          {
            ...input.nights[0]!,
            appliedSeasonSourceId: weekendId,
          },
        ],
      },
      {
        ...input,
        additionalGuestSourceId: null,
      },
      {
        ...input,
        chargeableGuestCount: 5,
      },
      {
        ...input,
        flexibleRatePlanId: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
      },
    ]) {
      expect(() => calculateBookingPrice(changed as BookingPriceCalculationInput)).toThrow(
        "Booking price calculation input is invalid",
      );
    }
  });

  it("strictly rejects widened, sparse, accessor, custom-prototype, and owner-malformed inputs", () => {
    const input = calculationInput();
    let getterCalls = 0;
    const accessor = { ...input } as Record<string, unknown>;
    Object.defineProperty(accessor, "roomCount", {
      enumerable: true,
      get() {
        getterCalls += 1;
        return 2;
      },
    });
    const sparseNights = [...input.nights] as unknown[];
    sparseNights.length = 3;
    const widenedNights = [...input.nights] as unknown[] & { extra?: boolean };
    widenedNights.extra = true;
    const customPrototype = Object.assign(Object.create({ inherited: true }), input);
    const hiddenField = { ...input } as Record<string, unknown>;
    Object.defineProperty(hiddenField, "hidden", { value: true });
    const nestedHiddenField = structuredClone(input) as BookingPriceCalculationInput;
    Object.defineProperty(nestedHiddenField.pricing.pricingCurrency, "hidden", { value: true });
    const malformedAmount = structuredClone(input) as BookingPriceCalculationInput;
    Object.assign(malformedAmount.pricing.flexibleRatePlans[0]!.baseAmount, {
      amountDecimal: "160.0",
    });

    for (const invalid of [
      { ...input, extra: true },
      accessor,
      { ...input, nights: sparseNights },
      { ...input, nights: widenedNights },
      customPrototype,
      hiddenField,
      nestedHiddenField,
      malformedAmount,
    ]) {
      expect(() => calculateBookingPrice(invalid as BookingPriceCalculationInput)).toThrow(
        "Booking price calculation input is invalid",
      );
    }
    expect(getterCalls).toBe(0);
  });

  it("rejects mixed currency, dependency drift, and signed-64-bit stay overflow", () => {
    const input = calculationInput();
    const mixedCurrency = structuredClone(input) as BookingPriceCalculationInput;
    Object.assign(mixedCurrency.recurringPricing, { currency: "CHF" });
    const staleRoomFacts = structuredClone(input) as BookingPriceCalculationInput;
    const season = staleRoomFacts.recurringPricing.sources.find(
      ({ sourceKind }) => sourceKind === "season",
    );
    if (season?.sourceKind === "season")
      Object.assign(season.roomPrices[0]!, { roomFactsRevision: 5 });
    const staleFlexiblePlan = structuredClone(input) as BookingPriceCalculationInput;
    Object.assign(staleFlexiblePlan.roomPublication.rooms[0]!.sourceRevisions, {
      roomFactsRevision: 5,
    });
    const jointlyStalePricing = structuredClone(input) as BookingPriceCalculationInput;
    Object.assign(jointlyStalePricing.pricing.flexibleRatePlans[0]!, {
      sourceRoomFactsRevision: 5,
    });
    for (const source of jointlyStalePricing.recurringPricing.sources) {
      if (source.sourceKind === "season")
        Object.assign(source.roomPrices[0]!, { roomFactsRevision: 5 });
      if (source.sourceKind === "weekend_surcharge")
        Object.assign(source.roomSurcharges[0]!, { roomFactsRevision: 5 });
      if (source.sourceKind === "additional_guest") Object.assign(source, { roomFactsRevision: 5 });
      if (source.sourceKind === "non_refundable")
        Object.assign(source.roomPlans[0]!, { roomFactsRevision: 5 });
    }

    const overflow = withCurrentFingerprint({
      ...input,
      pricing: pricing("9999999999999.99"),
      roomCount: 99,
      chargeableGuestCount: 0,
      additionalGuestSourceId: null,
      nights: Array.from({ length: 100 }, (_, index) => ({
        stayDate: `2027-${String(Math.floor(index / 28) + 1).padStart(2, "0")}-${String((index % 28) + 1).padStart(2, "0")}`,
        appliedSeasonSourceId: null,
        appliedWeekendSurchargeSourceId: null,
      })),
    } satisfies BookingPriceCalculationInput);

    for (const invalid of [
      mixedCurrency,
      withCurrentFingerprint(staleRoomFacts),
      withCurrentFingerprint(staleFlexiblePlan),
      withCurrentFingerprint(jointlyStalePricing),
      overflow,
    ]) {
      expect(() => calculateBookingPrice(invalid)).toThrow(
        "Booking price calculation input is invalid",
      );
    }
  });
});
