import { describe, expect, it } from "vitest";

import { createFinancePaymentReadinessSnapshot } from "@vayada/domain-finance";
import {
  parsePmsPricingSourceSnapshot,
  parsePmsRecurringPricingBookingEvidence,
  type PmsRecurringPricingSourceSnapshot,
} from "@vayada/domain-pms";

import {
  BOOKING_PRICING_EVIDENCE_CONTRACT_VERSION,
  composeBookingPricingReadiness,
  createBookingPricingSourceFingerprint,
  parseBookingMandatoryChargeConfirmationEvidenceResult,
  parseBookingPricingEvidenceRequest,
  parseBookingPricingSourceFingerprint,
  type BookingPricingOwnerEvidenceInput,
} from "./bookingPricingEvidence.js";

const organizationId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const propertyId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const roomTypeId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const secondRoomTypeId = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const flexiblePlanId = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
const secondFlexiblePlanId = "ffffffff-ffff-4fff-8fff-ffffffffffff";
const seasonId = "11111111-1111-4111-8111-111111111111";
const weekendId = "22222222-2222-4222-8222-222222222222";
const additionalGuestId = "33333333-3333-4333-8333-333333333333";
const nonRefundableId = "44444444-4444-4444-8444-444444444444";
const now = "2026-08-03T14:30:00.000Z";

const request = { organizationId, propertyId };

function roomBinding(
  id = roomTypeId,
  planId = flexiblePlanId,
  roomFactsRevision = 4,
  flexibleRatePlanRevision = 3,
) {
  return {
    roomTypeId: id,
    roomFactsRevision,
    flexibleRatePlanId: planId,
    flexibleRatePlanRevision,
  };
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

function recurringSources(): readonly PmsRecurringPricingSourceSnapshot[] {
  const parsed = [
    {
      ...sourceBase(seasonId),
      sourceKind: "season",
      name: "Summer",
      startMonthDay: "06-01",
      endMonthDay: "08-31",
      roomPrices: [
        { ...roomBinding(), amountDecimal: "180.00" },
        {
          ...roomBinding(secondRoomTypeId, secondFlexiblePlanId, 5, 4),
          amountDecimal: "260.00",
        },
      ],
    },
    {
      ...sourceBase(weekendId),
      sourceKind: "weekend_surcharge",
      weekdays: ["friday", "saturday"],
      roomSurcharges: [
        { ...roomBinding(), amountDecimal: "15.00" },
        {
          ...roomBinding(secondRoomTypeId, secondFlexiblePlanId, 5, 4),
          amountDecimal: "0.00",
        },
      ],
    },
    {
      ...sourceBase(additionalGuestId),
      sourceKind: "additional_guest",
      ...roomBinding(),
      maximumAdultGuests: 4,
      includedGuests: 2,
      amountDecimal: "25.00",
    },
    {
      ...sourceBase(nonRefundableId),
      sourceKind: "non_refundable",
      discountPercent: 10,
      roomPlans: [roomBinding(), roomBinding(secondRoomTypeId, secondFlexiblePlanId, 5, 4)],
      paymentTiming: "prepay_full",
      cancellationTerms: {
        type: "non_refundable",
        refundPolicy: "no_refund",
        noShowPenalty: "full_booking_amount",
      },
    },
  ].map((source) =>
    parsePmsRecurringPricingBookingEvidence({
      contractVersion: "pms-recurring-pricing.v1",
      propertyId,
      pricingCurrencyRevision: 2,
      optionalPricingAggregateRevision: 1,
      currency: "EUR",
      sources: [source],
      capturedAt: now,
    }),
  );
  return parsed.map((evidence) => evidence!.sources[0]!);
}

function pricingEvidence() {
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
        flexibleRatePlanId: flexiblePlanId,
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
      {
        contractVersion: "pms-pricing.v1",
        propertyId,
        roomTypeId: secondRoomTypeId,
        flexibleRatePlanId: secondFlexiblePlanId,
        flexibleRatePlanRevision: 4,
        sourceRoomFactsRevision: 5,
        baseAmount: { amountDecimal: "240.00", currency: "EUR" },
        cancellationTerms: {
          type: "free_until_days_before_arrival",
          freeCancellationDeadlineDays: 3,
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

function ownerEvidence(
  sources: readonly PmsRecurringPricingSourceSnapshot[] = recurringSources(),
): BookingPricingOwnerEvidenceInput {
  return {
    roomPublication: {
      contractVersion: "pms-room-publication.v1",
      propertyId,
      status: "ready",
      rooms: [
        publicationRoom(roomTypeId, 4, 4, 2, 2),
        publicationRoom(secondRoomTypeId, 5, 6, 4, 3),
      ],
      blockers: [],
      sourceRevision: "room-publication:9",
    },
    pricing: pricingEvidence(),
    recurringPricing: parsePmsRecurringPricingBookingEvidence({
      contractVersion: "pms-recurring-pricing.v1",
      propertyId,
      pricingCurrencyRevision: 2,
      optionalPricingAggregateRevision: sources.length === 0 ? 0 : 5,
      currency: "EUR",
      sources,
      capturedAt: now,
    })!,
  };
}

function publicationRoom(
  id: string,
  roomFactsRevision: number,
  maxGuests: number,
  maxAdults: number,
  maxChildren: number,
) {
  return {
    propertyId,
    roomTypeId: id,
    facts: {
      name: "Suite",
      description: "A completed room type",
      category: null,
      occupancy: { maxGuests, maxAdults, maxChildren },
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
      roomFactsRevision,
      roomUnitsRevision: 1,
      roomMediaRevision: 1,
      roomAmenitiesRevision: 1,
    },
    sourceRevision: `room:${roomFactsRevision}`,
  };
}

function finance(paymentMethodsRevision = 3) {
  return createFinancePaymentReadinessSnapshot({
    propertyId,
    paymentMethodsRevision,
    selectedMethods: ["pay_at_property"],
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

function confirmation(fingerprint: string) {
  return {
    outcome: "available",
    evidence: {
      organizationId,
      propertyId,
      pricingSourceFingerprint: fingerprint,
      confirmationRevision: 6,
      confirmedAt: now,
    },
  };
}

describe("Booking pricing evidence boundaries", () => {
  it("normalizes request scope and strictly parses confirmation evidence", () => {
    expect(
      parseBookingPricingEvidenceRequest({
        organizationId: organizationId.toUpperCase(),
        propertyId: propertyId.toUpperCase(),
      }),
    ).toEqual(request);
    expect(parseBookingPricingSourceFingerprint("a".repeat(64))).toBe("a".repeat(64));
    expect(parseBookingPricingSourceFingerprint("A".repeat(64))).toBeNull();

    const available = parseBookingMandatoryChargeConfirmationEvidenceResult(
      confirmation("a".repeat(64)),
    );
    expect(available.outcome).toBe("available");
    expect(Object.isFrozen(available)).toBe(true);
    for (const malformed of [
      confirmation("not-a-fingerprint"),
      {
        ...confirmation("a".repeat(64)),
        evidence: { ...confirmation("a".repeat(64)).evidence, confirmationRevision: 0 },
      },
      {
        ...confirmation("a".repeat(64)),
        evidence: { ...confirmation("a".repeat(64)).evidence, confirmedAt: "2026-08-03T14:30:00Z" },
      },
      { outcome: "available", evidence: confirmation("a".repeat(64)).evidence, draft: true },
    ]) {
      expect(parseBookingMandatoryChargeConfirmationEvidenceResult(malformed)).toEqual({
        outcome: "malformed",
      });
    }
  });

  it("uses one order-independent canonical fingerprint and invalidates every revision change", () => {
    const evidence = ownerEvidence();
    const original = JSON.stringify(evidence);
    const fingerprint = createBookingPricingSourceFingerprint(request, evidence);
    const reordered = structuredClone(evidence) as BookingPricingOwnerEvidenceInput;
    (reordered.roomPublication.rooms as unknown[]).reverse();
    (reordered.pricing.flexibleRatePlans as unknown[]).reverse();
    (reordered.recurringPricing.sources as unknown[]).reverse();
    for (const source of reordered.recurringPricing.sources) {
      if (source.sourceKind === "season") (source.roomPrices as unknown[]).reverse();
      if (source.sourceKind === "weekend_surcharge") {
        (source.weekdays as unknown[]).reverse();
        (source.roomSurcharges as unknown[]).reverse();
      }
      if (source.sourceKind === "non_refundable") (source.roomPlans as unknown[]).reverse();
    }

    expect(fingerprint).toBe("a68651bf34c4bfe405b3c29c26dcef8a60a88d265dc2ceee8cc834e8d0476860");
    expect(createBookingPricingSourceFingerprint(request, reordered)).toBe(fingerprint);
    expect(JSON.stringify(evidence)).toBe(original);

    for (const mutate of [
      (copy: BookingPricingOwnerEvidenceInput) => {
        Object.assign(copy.pricing.pricingCurrency, { pricingCurrencyRevision: 3 });
        Object.assign(copy.recurringPricing, { pricingCurrencyRevision: 3 });
        for (const source of copy.recurringPricing.sources)
          Object.assign(source, { pricingCurrencyRevision: 3 });
      },
      (copy: BookingPricingOwnerEvidenceInput) =>
        Object.assign(copy.pricing.flexibleRatePlans[0]!, { flexibleRatePlanRevision: 4 }),
      (copy: BookingPricingOwnerEvidenceInput) =>
        Object.assign(copy.pricing.flexibleRatePlans[0]!.baseAmount, { amountDecimal: "161.00" }),
      (copy: BookingPricingOwnerEvidenceInput) =>
        Object.assign(copy.pricing.flexibleRatePlans[0]!.cancellationTerms, {
          freeCancellationDeadlineDays: 8,
        }),
      (copy: BookingPricingOwnerEvidenceInput) =>
        Object.assign(copy.recurringPricing, { optionalPricingAggregateRevision: 6 }),
      (copy: BookingPricingOwnerEvidenceInput) =>
        Object.assign(copy.recurringPricing.sources[0]!, { sourceRevision: 4 }),
      (copy: BookingPricingOwnerEvidenceInput) =>
        Object.assign(copy.recurringPricing.sources[0]!.validation, { validationRevision: 3 }),
      (copy: BookingPricingOwnerEvidenceInput) =>
        Object.assign(copy.recurringPricing.sources[0]!, { materializationRevision: 2 }),
      (copy: BookingPricingOwnerEvidenceInput) =>
        Object.assign(copy.recurringPricing.sources[0]!, {
          configuredState: "disabled",
          lifecycle: "disabled",
        }),
      (copy: BookingPricingOwnerEvidenceInput) => {
        const source = copy.recurringPricing.sources[0]!;
        if (source.sourceKind === "season") Object.assign(source, { startMonthDay: "06-02" });
      },
      (copy: BookingPricingOwnerEvidenceInput) => {
        const source = copy.recurringPricing.sources[0]!;
        if (source.sourceKind === "season")
          Object.assign(source.roomPrices[0]!, { amountDecimal: "181.00" });
      },
      (copy: BookingPricingOwnerEvidenceInput) => {
        const source = copy.recurringPricing.sources[1]!;
        if (source.sourceKind === "weekend_surcharge")
          Object.assign(source, { weekdays: ["friday"] });
      },
      (copy: BookingPricingOwnerEvidenceInput) => {
        const source = copy.recurringPricing.sources[2]!;
        if (source.sourceKind === "additional_guest")
          Object.assign(source, { includedGuests: 1, amountDecimal: "26.00" });
      },
      (copy: BookingPricingOwnerEvidenceInput) => {
        const source = copy.recurringPricing.sources[3]!;
        if (source.sourceKind === "non_refundable") Object.assign(source, { discountPercent: 11 });
      },
      (copy: BookingPricingOwnerEvidenceInput) => {
        const source = copy.recurringPricing.sources[0]!;
        Object.assign(source, {
          validation: {
            state: "invalid",
            validationRevision: 3,
            validatedAt: now,
            reasons: [{ code: "dependency_unavailable" }],
          },
          lifecycle: "invalid",
        });
      },
      (copy: BookingPricingOwnerEvidenceInput) =>
        Object.assign(copy.roomPublication.rooms[0]!.facts.occupancy, { maxChildren: 3 }),
      (copy: BookingPricingOwnerEvidenceInput) =>
        Object.assign(copy.roomPublication.rooms[0]!.sourceRevisions, { roomFactsRevision: 6 }),
    ]) {
      const changed = structuredClone(evidence) as BookingPricingOwnerEvidenceInput;
      mutate(changed);
      expect(createBookingPricingSourceFingerprint(request, changed)).not.toBe(fingerprint);
    }
  });

  it("keeps flexible rates eligible while Finance truthfully suppresses non-refundable", () => {
    const evidence = ownerEvidence();
    const fingerprint = createBookingPricingSourceFingerprint(request, evidence);
    const readiness = composeBookingPricingReadiness(
      request,
      evidence,
      confirmation(fingerprint),
      finance(),
    );

    expect(readiness.contractVersion).toBe(BOOKING_PRICING_EVIDENCE_CONTRACT_VERSION);
    expect(readiness.status).toBe("ready");
    expect(readiness.flexibleRates.every(({ status }) => status === "ready")).toBe(true);
    expect(
      readiness.optionalSources.find(({ sourceKind }) => sourceKind === "non_refundable"),
    ).toMatchObject({
      status: "blocked",
      blockers: [{ code: "non_refundable_card_capability_unready", blocksReadiness: false }],
    });
    expect(readiness.financePaymentReadiness).toEqual({
      status: "current",
      source: {
        ownerDomain: "finance",
        entityType: "finance_payment_methods.v1",
        entityId: propertyId,
        revision: "3",
      },
    });
    expect(Object.isFrozen(readiness)).toBe(true);
    expect(Object.isFrozen(readiness.optionalSources)).toBe(true);
  });

  it("fingerprints parsed Finance capability and fails closed on fabricated or stale evidence", () => {
    const evidence = ownerEvidence();
    const fingerprint = createBookingPricingSourceFingerprint(request, evidence);
    const current = composeBookingPricingReadiness(
      request,
      evidence,
      confirmation(fingerprint),
      finance(),
    );
    const revised = composeBookingPricingReadiness(
      request,
      evidence,
      confirmation(fingerprint),
      finance(4),
    );
    const fabricated = composeBookingPricingReadiness(
      request,
      evidence,
      confirmation(fingerprint),
      { ...finance(), bookingPaymentReady: false },
    );
    const staleConfirmation = composeBookingPricingReadiness(
      request,
      evidence,
      confirmation("a".repeat(64)),
      finance(),
    );

    expect(revised.sourceFingerprint).toBe(current.sourceFingerprint);
    expect(revised.eligibilityFingerprint).not.toBe(current.eligibilityFingerprint);
    expect(fabricated.financePaymentReadiness).toEqual({ status: "malformed" });
    expect(
      fabricated.optionalSources.find(({ sourceKind }) => sourceKind === "non_refundable")?.status,
    ).toBe("blocked");
    expect(staleConfirmation.status).toBe("blocked");
    expect(staleConfirmation.mandatoryChargeConfirmation.status).toBe("stale");
    expect(staleConfirmation.blockers).toContainEqual({
      code: "mandatory_charge_confirmation_stale",
      blocksReadiness: true,
    });
  });

  it("keeps disabled and invalid optional sources visible and rejects scope/dependency mismatch", () => {
    const [season, weekend] = recurringSources();
    const disabled = {
      ...season!,
      configuredState: "disabled",
      lifecycle: "disabled",
    } as PmsRecurringPricingSourceSnapshot;
    const invalid = {
      ...weekend!,
      validation: {
        state: "invalid",
        validationRevision: 3,
        validatedAt: now,
        reasons: [{ code: "pricing_currency_mismatch" }, { code: "dependency_unavailable" }],
      },
      lifecycle: "invalid",
    } as PmsRecurringPricingSourceSnapshot;
    const evidence = ownerEvidence([disabled, invalid]);
    const fingerprint = createBookingPricingSourceFingerprint(request, evidence);
    const readiness = composeBookingPricingReadiness(
      request,
      evidence,
      confirmation(fingerprint),
      null,
    );

    expect(readiness.optionalSources).toMatchObject([
      { sourceId: seasonId, status: "disabled", blockers: [{ code: "optional_source_disabled" }] },
      { sourceId: weekendId, status: "blocked", blockers: [{ code: "optional_source_invalid" }] },
    ]);
    expect(readiness.status).toBe("blocked");
    expect(() =>
      createBookingPricingSourceFingerprint(
        { ...request, propertyId: "99999999-9999-4999-8999-999999999999" },
        evidence,
      ),
    ).toThrow("outside request scope");

    const mismatched = structuredClone(ownerEvidence()) as BookingPricingOwnerEvidenceInput;
    Object.assign(mismatched.recurringPricing.sources[0]!, { pricingCurrencyRevision: 1 });
    expect(() => createBookingPricingSourceFingerprint(request, mismatched)).toThrow(
      "outside request scope",
    );
  });
});
