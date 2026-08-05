import { describe, expect, it } from "vitest";

import {
  PMS_PRICING_SOURCE_ENTITY_TYPES,
  PMS_PRICING_SOURCE_IDENTITY_VERSION,
  PMS_PRICING_SOURCE_OWNER_DOMAIN,
  PMS_RECURRING_PRICING_AUTHORIZATION,
  PMS_RECURRING_PRICING_CONTRACT_VERSION,
  PMS_RECURRING_PRICING_MAX_HORIZON_DAYS,
  derivePmsRecurringPricingLifecycle,
  parseDisableRecurringPricingSourceCommand,
  parseMaterializeRecurringPricingCommand,
  parseNonRefundableCancellationTerms,
  parsePmsNonNegativeDecimalAmount,
  parsePmsRecurringMonthDay,
  parsePmsRecurringPricingBookingEvidence,
  parsePmsRecurringPricingCommandResult,
  parsePmsRecurringPricingMaterializedEvent,
  parsePmsPricingSourceEntityRevision,
  parsePmsRecurringPricingSourceSnapshot,
  parsePmsRecurringPricingValidation,
  parseRecurringPricingMaterializationReceipt,
  parseRecurringPricingMaterializationResult,
  parseUpsertAdditionalGuestPricingCommand,
  parseUpsertNonRefundablePricingCommand,
  parseUpsertRecurringPricingSourceCommand,
  parseUpsertRecurringSeasonCommand,
  parseUpsertWeekendSurchargeCommand,
  serializeDisableRecurringPricingSourceFingerprint,
  serializePmsPricingSourceEntityRevision,
  serializeRecurringPricingMaterializationFingerprint,
  serializeRecurringPricingUpsertFingerprint,
  type PmsRecurringPricingCommandPort,
  type PmsRecurringPricingReadPort,
} from "./recurringPricing.js";

const organizationId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const propertyId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const roomTypeId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const secondRoomTypeId = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const flexibleRatePlanId = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
const secondFlexibleRatePlanId = "ffffffff-ffff-4fff-8fff-ffffffffffff";
const seasonSourceId = "11111111-1111-4111-8111-111111111111";
const weekendSourceId = "22222222-2222-4222-8222-222222222222";
const additionalGuestSourceId = "33333333-3333-4333-8333-333333333333";
const nonRefundableSourceId = "44444444-4444-4444-8444-444444444444";
const conflictingSourceId = "55555555-5555-4555-8555-555555555555";
const userId = "66666666-6666-4666-8666-666666666666";
const receiptId = "77777777-7777-4777-8777-777777777777";
const now = "2026-08-03T14:00:00.000Z";
const later = "2026-08-03T14:05:00.000Z";

function audit() {
  return {
    actor: { kind: "user", userId: userId.toUpperCase() },
    requestId: "req_recurring_pricing_1",
    correlationId: "corr_recurring_pricing_1",
    requestedAt: now,
  };
}

function context() {
  return {
    organizationId: organizationId.toUpperCase(),
    propertyId: propertyId.toUpperCase(),
    idempotencyKey: "recurring-pricing-key-1",
    audit: audit(),
  };
}

function upsertContext(sourceId = seasonSourceId) {
  return {
    ...context(),
    sourceId: sourceId.toUpperCase(),
    expectedSourceRevision: 0,
    expectedPricingCurrencyRevision: 2,
  };
}

function roomCommand(
  id = roomTypeId,
  planId = flexibleRatePlanId,
  roomFactsRevision = 4,
  planRevision = 3,
) {
  return {
    roomTypeId: id.toUpperCase(),
    expectedRoomFactsRevision: roomFactsRevision,
    flexibleRatePlanId: planId.toUpperCase(),
    expectedFlexibleRatePlanRevision: planRevision,
  };
}

function roomSnapshot(
  id = roomTypeId,
  planId = flexibleRatePlanId,
  roomFactsRevision = 4,
  planRevision = 3,
) {
  return {
    roomTypeId: id,
    roomFactsRevision,
    flexibleRatePlanId: planId,
    flexibleRatePlanRevision: planRevision,
  };
}

function validationValid(validationRevision = 1) {
  return { state: "valid", validationRevision, validatedAt: now };
}

function sourceBase(sourceId: string, overrides: Record<string, unknown> = {}) {
  return {
    contractVersion: PMS_RECURRING_PRICING_CONTRACT_VERSION,
    propertyId,
    sourceId,
    sourceRevision: 3,
    pricingCurrencyRevision: 2,
    currency: "EUR",
    configuredState: "active",
    validation: validationValid(),
    lifecycle: "active",
    materializationRevision: 0,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function seasonSnapshot(overrides: Record<string, unknown> = {}) {
  return {
    ...sourceBase(seasonSourceId),
    sourceKind: "season",
    name: "Summer",
    startMonthDay: "06-01",
    endMonthDay: "08-31",
    roomPrices: [
      { ...roomSnapshot(), amountDecimal: "180.00" },
      {
        ...roomSnapshot(secondRoomTypeId, secondFlexibleRatePlanId, 5, 4),
        amountDecimal: "260.00",
      },
    ],
    ...overrides,
  };
}

function weekendSnapshot(overrides: Record<string, unknown> = {}) {
  return {
    ...sourceBase(weekendSourceId),
    sourceKind: "weekend_surcharge",
    weekdays: ["friday", "saturday"],
    roomSurcharges: [
      { ...roomSnapshot(), amountDecimal: "15.00" },
      {
        ...roomSnapshot(secondRoomTypeId, secondFlexibleRatePlanId, 5, 4),
        amountDecimal: "0.00",
      },
    ],
    ...overrides,
  };
}

function additionalGuestSnapshot(overrides: Record<string, unknown> = {}) {
  return {
    ...sourceBase(additionalGuestSourceId),
    sourceKind: "additional_guest",
    ...roomSnapshot(),
    maximumAdultGuests: 4,
    includedGuests: 2,
    amountDecimal: "25.00",
    ...overrides,
  };
}

function cancellationTerms() {
  return {
    type: "non_refundable",
    refundPolicy: "no_refund",
    noShowPenalty: "full_booking_amount",
  };
}

function nonRefundableSnapshot(overrides: Record<string, unknown> = {}) {
  return {
    ...sourceBase(nonRefundableSourceId),
    sourceKind: "non_refundable",
    discountPercent: 10,
    roomPlans: [roomSnapshot(), roomSnapshot(secondRoomTypeId, secondFlexibleRatePlanId, 5, 4)],
    paymentTiming: "prepay_full",
    cancellationTerms: cancellationTerms(),
    ...overrides,
  };
}

describe("recurring pricing source identity and authorization", () => {
  it("publishes versioned PMS-owned entity coordinates for downstream manifests", () => {
    expect(PMS_PRICING_SOURCE_IDENTITY_VERSION).toBe("pms-pricing-source-identity.v1");
    expect(PMS_PRICING_SOURCE_OWNER_DOMAIN).toBe("pms");
    expect(PMS_PRICING_SOURCE_ENTITY_TYPES).toEqual({
      propertyPricingCurrency: "pms_property_pricing_currency.v1",
      flexibleRatePlan: "pms_flexible_rate_plan.v1",
      recurringPricingRule: "pms_recurring_pricing_rule.v1",
      optionalPricingAggregate: "pms_optional_pricing_aggregate.v1",
    });
    expect(new Set(Object.values(PMS_PRICING_SOURCE_ENTITY_TYPES)).size).toBe(4);
    expect(Object.isFrozen(PMS_PRICING_SOURCE_ENTITY_TYPES)).toBe(true);

    const sourceRevision = serializePmsPricingSourceEntityRevision(
      PMS_PRICING_SOURCE_ENTITY_TYPES.optionalPricingAggregate,
      propertyId.toUpperCase(),
      0,
    );
    expect(sourceRevision).toEqual({
      ownerDomain: "pms",
      entityType: "pms_optional_pricing_aggregate.v1",
      entityId: propertyId,
      revision: "0",
    });
    expect(parsePmsPricingSourceEntityRevision(sourceRevision)).toEqual(sourceRevision);
    for (const revision of [-1, 1.5, Number.MAX_SAFE_INTEGER + 1, "pricing_currency:2", "02"]) {
      expect(
        serializePmsPricingSourceEntityRevision(
          PMS_PRICING_SOURCE_ENTITY_TYPES.propertyPricingCurrency,
          propertyId,
          revision,
        ),
      ).toBeNull();
    }
  });

  it("uses the PMS property-management command authorization policy", () => {
    expect(PMS_RECURRING_PRICING_AUTHORIZATION).toEqual({
      permission: "pms.operations.manage",
      entitlement: { product: "pms", key: "property-management" },
      resource: {
        product: "pms",
        resourceType: "pms_property",
        allowedRelationships: ["owner", "operator"],
      },
    });
  });
});

describe("recurring pricing upsert commands", () => {
  it("parses a caller-identified annual season with sorted locked dependency evidence", () => {
    const parsed = parseUpsertRecurringSeasonCommand({
      ...upsertContext(),
      sourceKind: "season",
      name: "Christmas and New Year",
      startMonthDay: "12-20",
      endMonthDay: "01-05",
      roomPrices: [
        { ...roomCommand(), amountDecimal: "210.00" },
        {
          ...roomCommand(secondRoomTypeId, secondFlexibleRatePlanId, 5, 4),
          amountDecimal: "290.00",
        },
      ],
    });

    expect(parsed).toEqual({
      ...context(),
      organizationId,
      propertyId,
      audit: { ...audit(), actor: { kind: "user", userId } },
      sourceId: seasonSourceId,
      expectedSourceRevision: 0,
      expectedPricingCurrencyRevision: 2,
      sourceKind: "season",
      name: "Christmas and New Year",
      startMonthDay: "12-20",
      endMonthDay: "01-05",
      roomPrices: [
        {
          ...roomCommand(),
          roomTypeId,
          flexibleRatePlanId,
          amountDecimal: "210.00",
        },
        {
          ...roomCommand(secondRoomTypeId, secondFlexibleRatePlanId, 5, 4),
          roomTypeId: secondRoomTypeId,
          flexibleRatePlanId: secondFlexibleRatePlanId,
          amountDecimal: "290.00",
        },
      ],
    });
    expect(Object.isFrozen(parsed)).toBe(true);
    expect(Object.isFrozen(parsed?.roomPrices)).toBe(true);
  });

  it("rejects invalid recurrence boundaries, unsorted/duplicate room bindings, stale evidence, and extra fields", () => {
    const valid = {
      ...upsertContext(),
      sourceKind: "season",
      name: "Summer",
      startMonthDay: "06-01",
      endMonthDay: "08-31",
      roomPrices: [{ ...roomCommand(), amountDecimal: "180.00" }],
    };
    for (const invalid of [
      { ...valid, startMonthDay: "02-30" },
      { ...valid, startMonthDay: "13-01" },
      { ...valid, name: " Summer " },
      { ...valid, expectedSourceRevision: -1 },
      { ...valid, expectedPricingCurrencyRevision: 0 },
      { ...valid, roomPrices: [] },
      {
        ...valid,
        roomPrices: [
          { ...roomCommand(secondRoomTypeId, secondFlexibleRatePlanId), amountDecimal: "200.00" },
          { ...roomCommand(), amountDecimal: "180.00" },
        ],
      },
      {
        ...valid,
        roomPrices: [
          { ...roomCommand(), amountDecimal: "180.00" },
          { ...roomCommand(), amountDecimal: "190.00" },
        ],
      },
      {
        ...valid,
        roomPrices: [
          { ...roomCommand(roomTypeId, flexibleRatePlanId, 0), amountDecimal: "180.00" },
        ],
      },
      { ...valid, currency: "EUR" },
      { ...valid, extra: true },
    ]) {
      expect(parseUpsertRecurringSeasonCommand(invalid)).toBeNull();
    }
  });

  it("parses weekend surcharges including canonical zero without accepting localized or number money", () => {
    const parsed = parseUpsertWeekendSurchargeCommand({
      ...upsertContext(weekendSourceId),
      sourceKind: "weekend_surcharge",
      weekdays: ["friday", "saturday"],
      roomSurcharges: [
        { ...roomCommand(), amountDecimal: "15.00" },
        {
          ...roomCommand(secondRoomTypeId, secondFlexibleRatePlanId, 5, 4),
          amountDecimal: "0.00",
        },
      ],
    });
    expect(parsed?.weekdays).toEqual(["friday", "saturday"]);
    expect(parsed?.roomSurcharges[1]?.amountDecimal).toBe("0.00");

    for (const invalid of [
      { weekdays: [] },
      { weekdays: ["saturday", "friday"] },
      { weekdays: ["friday", "friday"] },
      { roomSurcharges: [{ ...roomCommand(), amountDecimal: 15 }] },
      { roomSurcharges: [{ ...roomCommand(), amountDecimal: "15,00" }] },
      { roomSurcharges: [{ ...roomCommand(), amountDecimal: "01.00" }] },
    ]) {
      expect(
        parseUpsertWeekendSurchargeCommand({
          ...upsertContext(weekendSourceId),
          sourceKind: "weekend_surcharge",
          weekdays: ["friday"],
          roomSurcharges: [{ ...roomCommand(), amountDecimal: "15.00" }],
          ...invalid,
        }),
      ).toBeNull();
    }
  });

  it("accepts only owner inputs for additional-guest pricing and locks capacity through RoomFacts", () => {
    const command = {
      ...upsertContext(additionalGuestSourceId),
      sourceKind: "additional_guest",
      ...roomCommand(),
      includedGuests: 2,
      amountDecimal: "25.00",
    };
    const parsed = parseUpsertAdditionalGuestPricingCommand(command);
    expect(parsed?.includedGuests).toBe(2);
    expect(parsed?.expectedRoomFactsRevision).toBe(4);

    for (const invalid of [
      { ...command, includedGuests: 0 },
      { ...command, includedGuests: 1.5 },
      { ...command, includedGuests: 100 },
      { ...command, amountDecimal: -1 },
      { ...command, maximumAdultGuests: 4 },
      { ...command, roomTypeId: "not-a-uuid" },
    ]) {
      expect(parseUpsertAdditionalGuestPricingCommand(invalid)).toBeNull();
    }
  });

  it("accepts only the non-refundable discount and generates payment policy server-side", () => {
    const command = {
      ...upsertContext(nonRefundableSourceId),
      sourceKind: "non_refundable",
      discountPercent: 10,
      roomPlans: [roomCommand(), roomCommand(secondRoomTypeId, secondFlexibleRatePlanId, 5, 4)],
    };
    expect(parseUpsertNonRefundablePricingCommand(command)?.discountPercent).toBe(10);
    for (const invalid of [
      { ...command, discountPercent: 0 },
      { ...command, discountPercent: 51 },
      { ...command, discountPercent: 10.5 },
      { ...command, paymentTiming: "prepay_full" },
      { ...command, cancellationTerms: cancellationTerms() },
      { ...command, roomPlans: [...command.roomPlans].reverse() },
      { ...command, roomPlans: [] },
    ]) {
      expect(parseUpsertNonRefundablePricingCommand(invalid)).toBeNull();
    }
  });

  it("dispatches each exact source shape and rejects unsupported pricing behavior", () => {
    const season = {
      ...upsertContext(),
      sourceKind: "season",
      name: "Summer",
      startMonthDay: "06-01",
      endMonthDay: "08-31",
      roomPrices: [{ ...roomCommand(), amountDecimal: "180.00" }],
    };
    expect(parseUpsertRecurringPricingSourceCommand(season)?.sourceKind).toBe("season");
    expect(parseUpsertRecurringPricingSourceCommand({ ...season, minimumStay: 2 })).toBeNull();
    expect(parseUpsertRecurringPricingSourceCommand({ ...season, availability: [] })).toBeNull();
    expect(parseUpsertRecurringPricingSourceCommand({ ...season, publish: true })).toBeNull();
    expect(
      parseUpsertRecurringPricingSourceCommand({ ...season, sourceKind: "promotion" }),
    ).toBeNull();
  });

  it("uses normalized scale-2 strings without a JavaScript-number money path", () => {
    for (const amount of ["0.00", "0.01", "15.00", "9999999999999.99"]) {
      expect(parsePmsNonNegativeDecimalAmount(amount)).toBe(amount);
    }
    for (const amount of [0, 0.01, "0", "1", "1.0", "01.00", "1.000", "-1.00"]) {
      expect(parsePmsNonNegativeDecimalAmount(amount)).toBeNull();
    }
    expect(parsePmsRecurringMonthDay("12-31")).toBe("12-31");
    expect(parsePmsRecurringMonthDay("02-29")).toBe("02-29");
    expect(parsePmsRecurringMonthDay("02-30")).toBeNull();
  });
});

describe("recurring pricing fingerprints and lifecycle", () => {
  it("fingerprints the exact business request without audit or idempotency metadata", () => {
    const parsed = parseUpsertAdditionalGuestPricingCommand({
      ...upsertContext(additionalGuestSourceId),
      sourceKind: "additional_guest",
      ...roomCommand(),
      includedGuests: 2,
      amountDecimal: "25.00",
    })!;
    const fingerprint = serializeRecurringPricingUpsertFingerprint(parsed);
    expect(fingerprint).toBe(
      JSON.stringify({
        organizationId,
        propertyId,
        sourceId: additionalGuestSourceId,
        sourceKind: "additional_guest",
        expectedSourceRevision: 0,
        expectedPricingCurrencyRevision: 2,
        roomTypeId,
        expectedRoomFactsRevision: 4,
        flexibleRatePlanId,
        expectedFlexibleRatePlanRevision: 3,
        includedGuests: 2,
        amountDecimal: "25.00",
      }),
    );
    expect(fingerprint).not.toContain("requestId");
    expect(fingerprint).not.toContain("idempotencyKey");
    expect(fingerprint).not.toContain("currency");
    expect(serializeRecurringPricingUpsertFingerprint({ ...parsed, includedGuests: 3 })).not.toBe(
      fingerprint,
    );
  });

  it("parses disable as a revisioned lifecycle write and upsert as the re-enable path", () => {
    const parsed = parseDisableRecurringPricingSourceCommand({
      ...context(),
      sourceId: seasonSourceId.toUpperCase(),
      sourceKind: "season",
      expectedSourceRevision: 3,
    });
    expect(parsed?.sourceId).toBe(seasonSourceId);
    expect(serializeDisableRecurringPricingSourceFingerprint(parsed!)).toBe(
      JSON.stringify({
        organizationId,
        propertyId,
        sourceId: seasonSourceId,
        sourceKind: "season",
        expectedSourceRevision: 3,
      }),
    );
    expect(
      parseDisableRecurringPricingSourceCommand({
        ...context(),
        sourceId: seasonSourceId,
        sourceKind: "season",
        expectedSourceRevision: 0,
      }),
    ).toBeNull();
  });

  it("derives disabled before invalid before active and keeps invalid reasons deterministically ordered", () => {
    const invalid = parsePmsRecurringPricingValidation({
      state: "invalid",
      validationRevision: 2,
      validatedAt: later,
      reasons: [
        { code: "pricing_currency_revision_stale" },
        { code: "room_facts_revision_stale", roomTypeId: roomTypeId.toUpperCase() },
        { code: "season_overlap", conflictingSourceId: conflictingSourceId.toUpperCase() },
      ],
    });
    expect(invalid).not.toBeNull();
    expect(derivePmsRecurringPricingLifecycle("active", invalid!)).toBe("invalid");
    expect(derivePmsRecurringPricingLifecycle("disabled", invalid!)).toBe("disabled");
    expect(derivePmsRecurringPricingLifecycle("active", validationValid() as never)).toBe("active");

    for (const reasons of [
      [],
      [
        { code: "room_facts_revision_stale", roomTypeId },
        { code: "pricing_currency_revision_stale" },
      ],
      [
        { code: "room_type_missing", roomTypeId },
        { code: "room_type_missing", roomTypeId },
      ],
      [{ code: "room_type_missing", roomTypeId, extra: true }],
    ]) {
      expect(
        parsePmsRecurringPricingValidation({
          state: "invalid",
          validationRevision: 2,
          validatedAt: later,
          reasons,
        }),
      ).toBeNull();
    }
  });
});

describe("recurring pricing source snapshots", () => {
  it("parses active, disabled, and dependency-invalid seasons without changing source revision", () => {
    const active = parsePmsRecurringPricingSourceSnapshot(seasonSnapshot());
    const disabled = parsePmsRecurringPricingSourceSnapshot(
      seasonSnapshot({ configuredState: "disabled", lifecycle: "disabled" }),
    );
    const invalid = parsePmsRecurringPricingSourceSnapshot(
      seasonSnapshot({
        validation: {
          state: "invalid",
          validationRevision: 2,
          validatedAt: later,
          reasons: [{ code: "flexible_rate_plan_revision_stale", roomTypeId }],
        },
        lifecycle: "invalid",
        materializationRevision: 1,
      }),
    );
    expect(active?.sourceRevision).toBe(3);
    expect(disabled?.sourceRevision).toBe(3);
    expect(invalid?.sourceRevision).toBe(3);
    expect(invalid?.validation.validationRevision).toBe(2);
    expect(invalid?.materializationRevision).toBe(1);
    expect(Object.isFrozen(invalid?.validation)).toBe(true);

    expect(
      parsePmsRecurringPricingSourceSnapshot(
        seasonSnapshot({ configuredState: "disabled", lifecycle: "invalid" }),
      ),
    ).toBeNull();
    expect(
      parsePmsRecurringPricingSourceSnapshot(
        seasonSnapshot({
          validation: {
            state: "invalid",
            validationRevision: 2,
            validatedAt: later,
            reasons: [{ code: "dependency_unavailable" }],
          },
          lifecycle: "active",
        }),
      ),
    ).toBeNull();
  });

  it("parses weekend and additional-guest snapshots with authoritative currency, plan, facts, and capacity evidence", () => {
    const weekend = parsePmsRecurringPricingSourceSnapshot(weekendSnapshot());
    const additional = parsePmsRecurringPricingSourceSnapshot(additionalGuestSnapshot());
    expect(weekend?.sourceKind).toBe("weekend_surcharge");
    expect(weekend?.currency).toBe("EUR");
    expect(additional?.sourceKind).toBe("additional_guest");
    if (additional?.sourceKind === "additional_guest") {
      expect(additional.maximumAdultGuests).toBe(4);
      expect(additional.roomFactsRevision).toBe(4);
      expect(additional.flexibleRatePlanRevision).toBe(3);
    }

    expect(
      parsePmsRecurringPricingSourceSnapshot(additionalGuestSnapshot({ includedGuests: 4 })),
    ).toBeNull();
    expect(parsePmsRecurringPricingSourceSnapshot(weekendSnapshot({ currency: "eur" }))).toBeNull();
  });

  it("emits only fixed prepay-full and structured no-refund non-refundable policy", () => {
    const parsed = parsePmsRecurringPricingSourceSnapshot(nonRefundableSnapshot());
    expect(parseNonRefundableCancellationTerms(cancellationTerms())).toEqual(cancellationTerms());
    expect(parsed?.sourceKind).toBe("non_refundable");
    if (parsed?.sourceKind === "non_refundable") {
      expect(parsed.paymentTiming).toBe("prepay_full");
      expect(parsed.cancellationTerms).toEqual(cancellationTerms());
      expect(parsed.roomPlans).toHaveLength(2);
    }

    for (const overrides of [
      { paymentTiming: "pay_at_property" },
      { discountPercent: 0 },
      { discountPercent: 10.5 },
      { cancellationTerms: { ...cancellationTerms(), refundPolicy: "partial_refund" } },
    ]) {
      expect(parsePmsRecurringPricingSourceSnapshot(nonRefundableSnapshot(overrides))).toBeNull();
    }
  });

  it("exposes sorted, exact-property Booking evidence while retaining disabled and invalid sources", () => {
    const evidence = {
      contractVersion: PMS_RECURRING_PRICING_CONTRACT_VERSION,
      propertyId,
      pricingCurrencyRevision: 2,
      optionalPricingAggregateRevision: 7,
      currency: "EUR",
      sources: [
        seasonSnapshot(),
        weekendSnapshot({ configuredState: "disabled", lifecycle: "disabled" }),
        additionalGuestSnapshot({
          validation: {
            state: "invalid",
            validationRevision: 2,
            validatedAt: later,
            reasons: [{ code: "room_facts_revision_stale", roomTypeId }],
          },
          lifecycle: "invalid",
        }),
        nonRefundableSnapshot(),
      ],
      capturedAt: later,
    };
    const parsed = parsePmsRecurringPricingBookingEvidence(evidence);
    expect(parsed?.sources.map(({ lifecycle }) => lifecycle)).toEqual([
      "active",
      "disabled",
      "invalid",
      "active",
    ]);
    expect(Object.isFrozen(parsed?.sources)).toBe(true);

    expect(
      parsePmsRecurringPricingBookingEvidence({
        ...evidence,
        sources: [weekendSnapshot(), seasonSnapshot()],
      }),
    ).toBeNull();
    expect(
      parsePmsRecurringPricingBookingEvidence({
        contractVersion: PMS_RECURRING_PRICING_CONTRACT_VERSION,
        propertyId,
        pricingCurrencyRevision: 2,
        optionalPricingAggregateRevision: 0,
        currency: "EUR",
        sources: [],
        capturedAt: later,
      }),
    ).not.toBeNull();
    expect(
      parsePmsRecurringPricingBookingEvidence({
        ...evidence,
        sources: [seasonSnapshot({ propertyId: organizationId })],
      }),
    ).toBeNull();
    expect(
      parsePmsRecurringPricingBookingEvidence({
        ...evidence,
        sources: [seasonSnapshot({ pricingCurrencyRevision: 3 })],
      }),
    ).toBeNull();
  });
});

describe("bounded recurring pricing materialization", () => {
  it("parses a deterministic inclusive horizon of at most 366 days", () => {
    expect(PMS_RECURRING_PRICING_MAX_HORIZON_DAYS).toBe(366);
    const parsed = parseMaterializeRecurringPricingCommand({
      ...context(),
      fromDate: "2026-01-01",
      throughDate: "2027-01-01",
      expectedOptionalPricingAggregateRevision: 7,
    });
    expect(parsed?.throughDate).toBe("2027-01-01");
    expect(serializeRecurringPricingMaterializationFingerprint(parsed!)).not.toContain(
      "idempotencyKey",
    );

    for (const invalid of [
      { fromDate: "2026-01-01", throughDate: "2027-01-02" },
      { fromDate: "2026-01-02", throughDate: "2026-01-01" },
      { fromDate: "2026-02-30", throughDate: "2026-03-01" },
      { expectedOptionalPricingAggregateRevision: -1 },
      { expectedOptionalPricingAggregateRevision: 1.5 },
      { sources: [] },
    ]) {
      expect(
        parseMaterializeRecurringPricingCommand({
          ...context(),
          fromDate: "2026-01-01",
          throughDate: "2026-01-31",
          expectedOptionalPricingAggregateRevision: 7,
          ...invalid,
        }),
      ).toBeNull();
    }
  });

  it("preserves source identity, revision, configuration, and validation in materialization receipts", () => {
    const emptyHash = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
    const receipt = {
      contractVersion: PMS_RECURRING_PRICING_CONTRACT_VERSION,
      receiptId,
      propertyId,
      optionalPricingAggregateRevision: 7,
      fromDate: "2026-01-01",
      throughDate: "2026-01-31",
      sources: [
        {
          sourceKind: "season",
          sourceId: seasonSourceId,
          sourceRevision: 3,
          configuredState: "active",
          validation: validationValid(2),
          lifecycle: "active",
          materializationRevision: 1,
          currency: "EUR",
          pricingCurrencyRevision: 2,
          result: "materialized",
          materializedRowCount: 31,
          materializedRowsSha256: "a".repeat(64),
        },
        {
          sourceKind: "weekend_surcharge",
          sourceId: weekendSourceId,
          sourceRevision: 4,
          configuredState: "disabled",
          validation: validationValid(3),
          lifecycle: "disabled",
          materializationRevision: 2,
          currency: "EUR",
          pricingCurrencyRevision: 2,
          result: "skipped_disabled",
          materializedRowCount: 0,
          materializedRowsSha256: emptyHash,
        },
        {
          sourceKind: "additional_guest",
          sourceId: additionalGuestSourceId,
          sourceRevision: 2,
          configuredState: "active",
          validation: {
            state: "invalid",
            validationRevision: 4,
            validatedAt: later,
            reasons: [{ code: "additional_guest_capacity_inapplicable", roomTypeId }],
          },
          lifecycle: "invalid",
          materializationRevision: 3,
          currency: "EUR",
          pricingCurrencyRevision: 2,
          result: "skipped_invalid",
          materializedRowCount: 0,
          materializedRowsSha256: emptyHash,
        },
      ],
      acceptedAt: later,
    };
    const parsed = parseRecurringPricingMaterializationReceipt(receipt);
    expect(parsed?.sources.map(({ sourceRevision }) => sourceRevision)).toEqual([3, 4, 2]);
    expect(parsed?.sources.map(({ materializationRevision }) => materializationRevision)).toEqual([
      1, 2, 3,
    ]);
    expect(parsed?.sources[2]?.validation.state).toBe("invalid");

    expect(
      parseRecurringPricingMaterializationReceipt({
        ...receipt,
        sources: [{ ...receipt.sources[1], result: "materialized" }],
      }),
    ).toBeNull();
    expect(
      parseRecurringPricingMaterializationReceipt({
        ...receipt,
        sources: [{ ...receipt.sources[2], materializedRowCount: 1 }],
      }),
    ).toBeNull();
  });

  it("parses a secret-safe materialized outbox event without money or policy terms", () => {
    const event = {
      contractVersion: PMS_RECURRING_PRICING_CONTRACT_VERSION,
      eventType: "pms.recurring_pricing.materialized",
      receiptId,
      propertyId,
      optionalPricingAggregateRevision: 7,
      fromDate: "2026-01-01",
      throughDate: "2026-01-31",
      sources: [
        {
          sourceKind: "season",
          sourceId: seasonSourceId,
          sourceRevision: 3,
          materializationRevision: 1,
          lifecycle: "active",
          result: "materialized",
          materializedRowCount: 31,
          materializedRowsSha256: "a".repeat(64),
        },
      ],
    };
    const parsed = parsePmsRecurringPricingMaterializedEvent(event);
    expect(parsed).toEqual(event);
    expect(JSON.stringify(parsed)).not.toContain("amountDecimal");
    expect(JSON.stringify(parsed)).not.toContain("cancellationTerms");
    expect(
      parsePmsRecurringPricingMaterializedEvent({
        ...event,
        sources: [{ ...event.sources[0], amountDecimal: "180.00" }],
      }),
    ).toBeNull();
  });
});

describe("recurring pricing command results and ports", () => {
  it("parses revision, wrong-ID, overlap, capacity, scope, and coordination failures exactly", () => {
    for (const error of [
      { code: "source_not_found" },
      { code: "source_kind_conflict" },
      { code: "source_revision_conflict", currentRevision: 4 },
      { code: "pricing_currency_revision_conflict", currentRevision: 3 },
      { code: "optional_pricing_aggregate_revision_conflict", currentRevision: 7 },
      { code: "room_type_not_found", roomTypeId },
      { code: "room_facts_revision_conflict", roomTypeId, currentRevision: 5 },
      { code: "flexible_rate_plan_not_found", roomTypeId },
      { code: "flexible_rate_plan_revision_conflict", roomTypeId, currentRevision: 4 },
      { code: "season_name_conflict", conflictingSourceId },
      { code: "season_overlap", conflictingSourceIds: [weekendSourceId, conflictingSourceId] },
      {
        code: "recurring_pricing_room_plan_set_incomplete",
        sourceKind: "non_refundable",
        missingRoomTypeIds: [roomTypeId, secondRoomTypeId],
      },
      {
        code: "additional_guest_capacity_inapplicable",
        roomTypeId,
        maximumAdultGuests: 1,
      },
      { code: "setup_scope_unavailable" },
      { code: "idempotency_key_conflict" },
      { code: "command_in_progress" },
    ]) {
      expect(parsePmsRecurringPricingCommandResult({ ok: false, error })).not.toBeNull();
    }
    expect(
      parsePmsRecurringPricingCommandResult({
        ok: false,
        error: { code: "source_not_found", propertyId },
      }),
    ).toBeNull();
    expect(
      parsePmsRecurringPricingCommandResult({
        ok: false,
        error: { code: "season_overlap", conflictingSourceIds: [weekendSourceId, seasonSourceId] },
      }),
    ).toBeNull();
  });

  it("parses create/update/disable/re-enable snapshots and enforces lifecycle outcome consistency", () => {
    for (const [outcome, source] of [
      ["created", seasonSnapshot({ sourceRevision: 1 })],
      ["updated", seasonSnapshot({ sourceRevision: 4 })],
      ["disabled", seasonSnapshot({ configuredState: "disabled", lifecycle: "disabled" })],
      ["re_enabled", seasonSnapshot({ configuredState: "active", lifecycle: "active" })],
    ] as const) {
      expect(
        parsePmsRecurringPricingCommandResult({
          ok: true,
          response: {
            contractVersion: PMS_RECURRING_PRICING_CONTRACT_VERSION,
            outcome,
            source,
            optionalPricingAggregateRevision: 7,
            acceptedAt: later,
          },
        }),
      ).not.toBeNull();
    }
    expect(
      parsePmsRecurringPricingCommandResult({
        ok: true,
        response: {
          contractVersion: PMS_RECURRING_PRICING_CONTRACT_VERSION,
          outcome: "disabled",
          source: seasonSnapshot(),
          optionalPricingAggregateRevision: 7,
          acceptedAt: later,
        },
      }),
    ).toBeNull();
  });

  it("keeps the command and read ports narrow and free of quote/payment/calendar/publication operations", () => {
    const commandPort: PmsRecurringPricingCommandPort = {
      upsertRecurringSeason: async () => ({
        ok: false,
        error: { code: "setup_scope_unavailable" },
      }),
      upsertWeekendSurcharge: async () => ({
        ok: false,
        error: { code: "setup_scope_unavailable" },
      }),
      upsertAdditionalGuestPricing: async () => ({
        ok: false,
        error: { code: "setup_scope_unavailable" },
      }),
      upsertNonRefundablePricing: async () => ({
        ok: false,
        error: { code: "setup_scope_unavailable" },
      }),
      disableRecurringPricingSource: async () => ({
        ok: false,
        error: { code: "source_not_found" },
      }),
      materializeRecurringPricing: async () => ({
        ok: false,
        error: { code: "command_in_progress" },
      }),
    };
    const readPort: PmsRecurringPricingReadPort = {
      getRecurringPricingSource: async () => null,
      listRecurringPricingSources: async () => [],
      getRecurringPricingBookingEvidence: async () => null,
    };
    expect(Object.keys(commandPort)).toEqual([
      "upsertRecurringSeason",
      "upsertWeekendSurcharge",
      "upsertAdditionalGuestPricing",
      "upsertNonRefundablePricing",
      "disableRecurringPricingSource",
      "materializeRecurringPricing",
    ]);
    expect(Object.keys(readPort)).toEqual([
      "getRecurringPricingSource",
      "listRecurringPricingSources",
      "getRecurringPricingBookingEvidence",
    ]);
  });

  it("parses materialization results with the same exact typed error contract", () => {
    expect(
      parseRecurringPricingMaterializationResult({
        ok: false,
        error: { code: "source_revision_conflict", currentRevision: 4 },
      }),
    ).not.toBeNull();
    expect(
      parseRecurringPricingMaterializationResult({
        ok: false,
        error: { code: "source_revision_conflict", currentRevision: 4, extra: true },
      }),
    ).toBeNull();
  });
});
