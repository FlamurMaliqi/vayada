import { describe, expect, it } from "vitest";

import { createFinancePaymentReadinessSnapshot } from "@vayada/domain-finance";
import {
  parsePmsPricingSourceSnapshot,
  parsePmsRecurringPricingBookingEvidence,
} from "@vayada/domain-pms";

import type { BookingPriceCalculationInput } from "./bookingPriceCalculation.js";
import {
  createBookingPricingSourceFingerprint,
  type BookingPricingSourceFingerprint,
} from "./bookingPricingEvidence.js";
import {
  BOOKING_PRICE_SNAPSHOT_INPUT_CONTRACT_VERSION,
  BOOKING_PRICE_TAXES_AND_FEES_V1_MODEL,
  createBookingPriceSnapshotInput,
  type BookingPricePreviewInput,
  type BookingPriceQuoteInput,
  type BookingPriceSnapshotFactoryInput,
} from "./bookingPriceSnapshotInput.js";

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

function pricing() {
  return parsePmsPricingSourceSnapshot({
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
        flexibleRatePlanId,
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
          occupancy: { maxGuests: 4, maxAdults: 4, maxChildren: 2 },
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

function confirmation(fingerprint: BookingPricingSourceFingerprint) {
  return {
    organizationId,
    propertyId,
    pricingSourceFingerprint: fingerprint,
    confirmationRevision: 6,
    confirmedAt: now,
  };
}

function factoryInput(calculation = calculationInput()): BookingPriceSnapshotFactoryInput {
  return {
    calculationInput: calculation,
    mandatoryChargeConfirmation: confirmation(calculation.pricingSourceFingerprint),
    adultCount: 5,
    childCount: 1,
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

describe("Booking price snapshot input", () => {
  it("binds one immutable calculation for preview, quote, and snapshot consumers", () => {
    const input = factoryInput();
    const snapshot = createBookingPriceSnapshotInput(input)!;
    const preview: BookingPricePreviewInput = snapshot;
    const quote: BookingPriceQuoteInput = snapshot;

    expect(snapshot.contractVersion).toBe(BOOKING_PRICE_SNAPSHOT_INPUT_CONTRACT_VERSION);
    expect(snapshot.calculation.nights.map(({ stayDate }) => stayDate)).toEqual([
      "2026-08-07",
      "2026-08-08",
    ]);
    expect(snapshot.calculation.stayTotalMinorUnits).toBe("86000");
    expect(preview.totals).toEqual(quote.totals);
    expect(snapshot.totals).toEqual({
      priceTotalMinorUnits: "86000",
      taxesAndFeesTotalMinorUnits: "0",
      grandTotalMinorUnits: "86000",
    });
    expect(snapshot.taxesAndFees).toEqual({
      model: BOOKING_PRICE_TAXES_AND_FEES_V1_MODEL,
      taxTotalMinorUnits: "0",
      feeTotalMinorUnits: "0",
      totalMinorUnits: "0",
    });
    expect(snapshot.guestCounts).toEqual({
      roomCount: 2,
      adultCount: 5,
      childCount: 1,
      includedGuestsPerRoom: 2,
      chargeableGuestCount: 3,
    });
    expect(snapshot.cancellationDisclosure).toEqual({
      selectedPlan: "flexible",
      source: {
        ownerDomain: "pms",
        entityType: "pms_flexible_rate_plan.v1",
        entityId: flexibleRatePlanId,
        revision: "3",
      },
      paymentTiming: null,
      terms: {
        type: "free_until_days_before_arrival",
        freeCancellationDeadlineDays: 7,
        afterDeadlinePenalty: "full_booking_amount",
        noShowPenalty: "full_booking_amount",
      },
    });
    expect(snapshot.additionalGuestDisclosure).toMatchObject({
      kind: "per_stay_night",
      unitAmountDecimal: "25.00",
      currency: "EUR",
      includedGuestsPerRoom: 2,
      chargeableGuestCount: 3,
      totalMinorUnits: "15000",
    });
    expect(snapshot.pmsSourceBindings.recurringSources.map(({ sourceKind }) => sourceKind)).toEqual(
      ["season", "weekend_surcharge", "additional_guest"],
    );
    expect(snapshot.financePaymentEligibility).toEqual({
      requiredForSelection: false,
      source: null,
      snapshot: null,
    });
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.calculation.nights)).toBe(true);
    expect(Object.isFrozen(snapshot.pmsSourceBindings.recurringSources[0])).toBe(true);
    expect(Object.isFrozen(snapshot.pmsSourceBindings.recurringSources[0]!.source)).toBe(true);
    expect(input.calculationInput.nights[0]!.stayDate).toBe("2026-08-08");
  });

  it("is byte-for-byte deterministic regardless of room-night input ordering", () => {
    const left = factoryInput();
    const right = factoryInput({
      ...left.calculationInput,
      nights: [...left.calculationInput.nights].reverse(),
    });

    expect(JSON.stringify(createBookingPriceSnapshotInput(left))).toBe(
      JSON.stringify(createBookingPriceSnapshotInput(right)),
    );
  });

  it("keeps flexible pricing eligible independently of an unready card", () => {
    const calculation = {
      ...calculationInput(),
      financePaymentReadiness: financeWithUnreadyCard(),
    } satisfies BookingPriceCalculationInput;
    const snapshot = createBookingPriceSnapshotInput(factoryInput(calculation))!;

    expect(snapshot.financePaymentEligibility).toEqual({
      requiredForSelection: false,
      source: null,
      snapshot: null,
    });
  });

  it("fails non-refundable selection closed without owner-proven charge-ready card evidence", () => {
    const calculation = {
      ...calculationInput(),
      selectedRate: { kind: "non_refundable" as const, sourceId: nonRefundableId },
      financePaymentReadiness: financeWithUnreadyCard(),
    } satisfies BookingPriceCalculationInput;

    expect(createBookingPriceSnapshotInput(factoryInput(calculation))).toBeNull();
  });

  it("represents absence of additional-guest pricing without synthesizing policy", () => {
    const calculation = {
      ...calculationInput(),
      additionalGuestSourceId: null,
      chargeableGuestCount: 0,
    } satisfies BookingPriceCalculationInput;
    const snapshot = createBookingPriceSnapshotInput(factoryInput(calculation))!;

    expect(snapshot.additionalGuestDisclosure).toEqual({
      kind: "not_applied",
      includedGuestsPerRoom: null,
      chargeableGuestCount: 0,
      totalMinorUnits: "0",
    });
    expect(snapshot.pmsSourceBindings.recurringSources.map(({ sourceKind }) => sourceKind)).toEqual(
      ["season", "weekend_surcharge"],
    );
  });

  it("rejects stale, malformed, mixed-scope, and hostile evidence", () => {
    const base = factoryInput();
    const sparse = structuredClone(base) as unknown as {
      calculationInput: { nights: unknown[] };
    };
    sparse.calculationInput.nights = new Array(2);
    const hidden = structuredClone(base);
    Object.defineProperty(hidden.calculationInput.pricing, "hidden", { value: true });
    const accessor = structuredClone(base);
    Object.defineProperty(accessor.mandatoryChargeConfirmation, "confirmedAt", {
      enumerable: true,
      get: () => now,
    });
    const customPrototype = Object.assign(Object.create({ inherited: true }), base);

    const cases: unknown[] = [
      { ...base, extra: true },
      { ...base, adultCount: 0 },
      { ...base, adultCount: 9, childCount: 0 },
      { ...base, adultCount: 1, childCount: 5 },
      { ...base, adultCount: 7, childCount: 2 },
      { ...base, adultCount: 1, childCount: 0 },
      {
        ...base,
        mandatoryChargeConfirmation: {
          ...base.mandatoryChargeConfirmation,
          organizationId: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
        },
      },
      {
        ...base,
        mandatoryChargeConfirmation: {
          ...base.mandatoryChargeConfirmation,
          pricingSourceFingerprint: "f".repeat(64),
        },
      },
      {
        ...base,
        mandatoryChargeConfirmation: {
          ...base.mandatoryChargeConfirmation,
          confirmationRevision: 0,
        },
      },
      {
        ...base,
        calculationInput: {
          ...base.calculationInput,
          pricingSourceFingerprint: "f".repeat(64),
        },
      },
      sparse,
      hidden,
      accessor,
      customPrototype,
    ];

    for (const value of cases) expect(createBookingPriceSnapshotInput(value as never)).toBeNull();
  });
});
