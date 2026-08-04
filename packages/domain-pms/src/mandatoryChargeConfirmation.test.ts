import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import { parsePmsPricingSourceSnapshot } from "./pricing.js";
import { parsePmsRecurringPricingBookingEvidence } from "./recurringPricing.js";
import {
  PMS_MANDATORY_CHARGE_PRICING_SOURCE_FINGERPRINT_ALGORITHM,
  PMS_MANDATORY_CHARGE_PRICING_SOURCE_PAYLOAD_VERSION,
  createPmsMandatoryChargePricingSourceSnapshot,
  parsePmsMandatoryChargePricingSourceFingerprint,
  serializePmsMandatoryChargePricingSourcePayload,
  type PmsMandatoryChargePricingSourceInput,
} from "./mandatoryChargeConfirmation.js";

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

function room(
  id: string,
  revision: number,
  occupancy: { maxGuests: number; maxAdults: number; maxChildren: number },
): PmsMandatoryChargePricingSourceInput["rooms"][number] {
  return {
    roomTypeId: id,
    roomFactsRevision: revision,
    occupancy,
  };
}

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

function recurringSources() {
  return [
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
  ] as const;
}

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

function sourceInput(): PmsMandatoryChargePricingSourceInput {
  const sources = recurringSources();
  return {
    rooms: [
      room(roomTypeId, 4, { maxGuests: 4, maxAdults: 2, maxChildren: 2 }),
      room(secondRoomTypeId, 5, { maxGuests: 6, maxAdults: 4, maxChildren: 3 }),
    ],
    pricing: pricing(),
    recurringPricing: parsePmsRecurringPricingBookingEvidence({
      contractVersion: "pms-recurring-pricing.v1",
      propertyId,
      pricingCurrencyRevision: 2,
      optionalPricingAggregateRevision: 5,
      currency: "EUR",
      sources,
      capturedAt: now,
    })!,
  };
}

function digest(input: PmsMandatoryChargePricingSourceInput): string {
  return createHash(PMS_MANDATORY_CHARGE_PRICING_SOURCE_FINGERPRINT_ALGORITHM)
    .update(serializePmsMandatoryChargePricingSourcePayload(input))
    .digest("hex");
}

describe("PMS mandatory-charge pricing source", () => {
  it("owns stable canonical bytes for active room facts and every retained pricing source", () => {
    const input = sourceInput();
    const original = JSON.stringify(input);
    const snapshot = createPmsMandatoryChargePricingSourceSnapshot(input);
    const reordered = structuredClone(input) as PmsMandatoryChargePricingSourceInput;
    (reordered.rooms as unknown[]).reverse();
    Object.assign(reordered.rooms[0]!, {
      roomTypeId: reordered.rooms[0]!.roomTypeId.toUpperCase(),
    });
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

    expect(snapshot.payloadVersion).toBe(PMS_MANDATORY_CHARGE_PRICING_SOURCE_PAYLOAD_VERSION);
    expect(snapshot.sourceRevisions).toEqual({
      pricingCurrencyRevision: 2,
      rooms: [
        { roomTypeId, roomFactsRevision: 4 },
        { roomTypeId: secondRoomTypeId, roomFactsRevision: 5 },
      ],
      flexibleRatePlans: [
        {
          roomTypeId,
          flexibleRatePlanId: flexiblePlanId,
          flexibleRatePlanRevision: 3,
          sourceRoomFactsRevision: 4,
        },
        {
          roomTypeId: secondRoomTypeId,
          flexibleRatePlanId: secondFlexiblePlanId,
          flexibleRatePlanRevision: 4,
          sourceRoomFactsRevision: 5,
        },
      ],
      optionalPricingAggregateRevision: 5,
      recurringSources: recurringSources().map((source) => ({
        sourceKind: source.sourceKind,
        sourceId: source.sourceId,
        sourceRevision: 3,
        validationRevision: 2,
        materializationRevision: 1,
      })),
    });
    expect(digest(input)).toBe("6169ef53c2f84dcab9a23edabdaa9f8360e45c9cae1202135320bcc0c2db5e86");
    expect(digest(reordered)).toBe(digest(input));
    expect(JSON.stringify(input)).toBe(original);
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.sourceRevisions.rooms)).toBe(true);
  });

  it("changes bytes for every meaningful owner input and rejects non-canonical room manifests", () => {
    const baseline = digest(sourceInput());
    const mutations: ((copy: PmsMandatoryChargePricingSourceInput) => void)[] = [
      (copy) => {
        Object.assign(copy.pricing.pricingCurrency, { pricingCurrencyRevision: 3 });
        Object.assign(copy.recurringPricing, { pricingCurrencyRevision: 3 });
        for (const source of copy.recurringPricing.sources)
          Object.assign(source, { pricingCurrencyRevision: 3 });
      },
      (copy) => Object.assign(copy.rooms[0]!.occupancy, { maxChildren: 3 }),
      (copy) => Object.assign(copy.rooms[0]!, { roomFactsRevision: 6 }),
      (copy) => Object.assign(copy.pricing.flexibleRatePlans[0]!, { flexibleRatePlanRevision: 4 }),
      (copy) =>
        Object.assign(copy.pricing.flexibleRatePlans[0]!.baseAmount, { amountDecimal: "161.00" }),
      (copy) =>
        Object.assign(copy.pricing.flexibleRatePlans[0]!.cancellationTerms, {
          freeCancellationDeadlineDays: 8,
        }),
      (copy) => Object.assign(copy.recurringPricing, { optionalPricingAggregateRevision: 6 }),
      (copy) => Object.assign(copy.recurringPricing.sources[0]!, { sourceRevision: 4 }),
      (copy) =>
        Object.assign(copy.recurringPricing.sources[0]!.validation, { validationRevision: 3 }),
      (copy) => Object.assign(copy.recurringPricing.sources[0]!, { materializationRevision: 2 }),
      (copy) =>
        Object.assign(copy.recurringPricing.sources[0]!, {
          configuredState: "disabled",
          lifecycle: "disabled",
        }),
      (copy) => {
        const source = copy.recurringPricing.sources[0]!;
        if (source.sourceKind === "season") Object.assign(source, { startMonthDay: "06-02" });
      },
      (copy) => {
        const source = copy.recurringPricing.sources[0]!;
        if (source.sourceKind === "season")
          Object.assign(source.roomPrices[0]!, { amountDecimal: "181.00" });
      },
      (copy) => {
        const source = copy.recurringPricing.sources[1]!;
        if (source.sourceKind === "weekend_surcharge")
          Object.assign(source, { weekdays: ["friday"] });
      },
      (copy) => {
        const source = copy.recurringPricing.sources[2]!;
        if (source.sourceKind === "additional_guest") Object.assign(source, { includedGuests: 1 });
      },
      (copy) => {
        const source = copy.recurringPricing.sources[3]!;
        if (source.sourceKind === "non_refundable") Object.assign(source, { discountPercent: 11 });
      },
      (copy) => void (copy.rooms as unknown[]).pop(),
      (copy) => void (copy.pricing.flexibleRatePlans as unknown[]).pop(),
      (copy) => void (copy.recurringPricing.sources as unknown[]).pop(),
    ];
    for (const mutate of mutations) {
      const changed = structuredClone(sourceInput()) as PmsMandatoryChargePricingSourceInput;
      mutate(changed);
      expect(digest(changed)).not.toBe(baseline);
    }

    const roomWithExtraField = structuredClone(
      sourceInput(),
    ) as PmsMandatoryChargePricingSourceInput;
    Object.assign(roomWithExtraField.rooms[0]!, { lifecycle: "active" });
    expect(() => digest(roomWithExtraField)).toThrow(TypeError);
    const impossibleOccupancy = structuredClone(
      sourceInput(),
    ) as PmsMandatoryChargePricingSourceInput;
    Object.assign(impossibleOccupancy.rooms[0]!.occupancy, {
      maxGuests: 101,
      maxAdults: 101,
      maxChildren: 0,
    });
    expect(() => digest(impossibleOccupancy)).toThrow(TypeError);
    expect(parsePmsMandatoryChargePricingSourceFingerprint(baseline)).toBe(baseline);
    expect(parsePmsMandatoryChargePricingSourceFingerprint(baseline.toUpperCase())).toBeNull();
    expect(parsePmsMandatoryChargePricingSourceFingerprint(baseline.slice(1))).toBeNull();
  });
});
