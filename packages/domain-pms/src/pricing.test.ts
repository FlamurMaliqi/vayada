import { describe, expect, it } from "vitest";

import {
  PMS_PRICING_AUTHORIZATION,
  PMS_PRICING_CONTRACT_VERSION,
  PMS_PRICING_CURRENCY_DEPENDENCY_LOCK_NAMESPACE,
  type PmsPricingCommandPort,
  type PmsPricingCurrencyChangeGuardPort,
  type PmsPricingCurrencyDependencyGuardPort,
  type PmsPricingCurrencyValidationPort,
  type PmsPricingReadPort,
  parseFlexibleCancellationTerms,
  parseFlexibleRatePlanCommandResult,
  parseFlexibleRatePlanSnapshot,
  parsePmsDecimalAmount,
  parsePmsPricingCurrency,
  parsePmsPricingSourceSnapshot,
  parsePropertyPricingCurrencyCommandResult,
  parsePropertyPricingCurrencySnapshot,
  parseUpsertFlexibleRatePlanCommand,
  parseUpsertPropertyPricingCurrencyCommand,
  serializeFlexibleRatePlanFingerprint,
  serializePmsPricingCurrencyDependencyLockKey,
  serializePropertyPricingCurrencyFingerprint,
} from "./pricing.js";

const organizationId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const propertyId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const roomTypeId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const secondRoomTypeId = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const ratePlanId = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
const secondRatePlanId = "ffffffff-ffff-4fff-8fff-ffffffffffff";
const userId = "11111111-1111-4111-8111-111111111111";
const now = "2026-08-03T08:30:00.000Z";

function audit() {
  return {
    actor: { kind: "user", userId: userId.toUpperCase() },
    requestId: "req_pricing_1",
    correlationId: "corr_pricing_1",
    requestedAt: now,
  };
}

function cancellationTerms() {
  return {
    type: "free_until_days_before_arrival",
    freeCancellationDeadlineDays: 7,
    afterDeadlinePenalty: "full_booking_amount",
    noShowPenalty: "full_booking_amount",
  };
}

function pricingCurrency() {
  return {
    contractVersion: PMS_PRICING_CONTRACT_VERSION,
    propertyId,
    currency: "EUR",
    pricingCurrencyRevision: 2,
    createdAt: now,
    updatedAt: now,
  };
}

function flexiblePlan(overrides: Record<string, unknown> = {}) {
  return {
    contractVersion: PMS_PRICING_CONTRACT_VERSION,
    propertyId,
    roomTypeId,
    flexibleRatePlanId: ratePlanId,
    flexibleRatePlanRevision: 3,
    sourceRoomFactsRevision: 4,
    baseAmount: { amountDecimal: "160.00", currency: "EUR" },
    cancellationTerms: cancellationTerms(),
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

describe("PMS pricing command contract", () => {
  it("parses authoritative currency writes with exact revisions and transport context", () => {
    const command = parseUpsertPropertyPricingCurrencyCommand({
      organizationId: organizationId.toUpperCase(),
      propertyId: propertyId.toUpperCase(),
      idempotencyKey: "pricing-currency-1",
      audit: audit(),
      expectedPricingCurrencyRevision: 0,
      currency: "EUR",
    });

    expect(command).toEqual({
      organizationId,
      propertyId,
      idempotencyKey: "pricing-currency-1",
      audit: {
        actor: { kind: "user", userId },
        requestId: "req_pricing_1",
        correlationId: "corr_pricing_1",
        requestedAt: now,
      },
      expectedPricingCurrencyRevision: 0,
      currency: "EUR",
    });
    expect(Object.isFrozen(command)).toBe(true);
    expect(Object.isFrozen(command?.audit)).toBe(true);
    expect(Object.isFrozen(command?.audit.actor)).toBe(true);

    for (const invalid of [
      { currency: "eur" },
      { currency: "EURO" },
      { expectedPricingCurrencyRevision: -1 },
      { expectedPricingCurrencyRevision: 0.5 },
      { idempotencyKey: " key " },
      { extra: true },
    ]) {
      expect(
        parseUpsertPropertyPricingCurrencyCommand({
          organizationId,
          propertyId,
          idempotencyKey: "pricing-currency-1",
          audit: audit(),
          expectedPricingCurrencyRevision: 0,
          currency: "EUR",
          ...invalid,
        }),
      ).toBeNull();
    }
  });

  it("parses a flexible plan without accepting a second currency or coupled behavior", () => {
    const command = parseUpsertFlexibleRatePlanCommand({
      organizationId,
      propertyId,
      idempotencyKey: "flexible-plan-1",
      audit: audit(),
      roomTypeId: roomTypeId.toUpperCase(),
      expectedRoomFactsRevision: 4,
      expectedPricingCurrencyRevision: 2,
      expectedFlexibleRatePlanRevision: 0,
      baseAmountDecimal: "160.00",
      cancellationTerms: cancellationTerms(),
    });

    expect(command?.roomTypeId).toBe(roomTypeId);
    expect(command?.baseAmountDecimal).toBe("160.00");
    expect(Object.isFrozen(command?.cancellationTerms)).toBe(true);

    for (const extra of [
      { currency: "EUR" },
      { seasonalRates: [] },
      { weekendSurcharge: "15.00" },
      { additionalGuestAmount: "20.00" },
      { nonRefundableDiscount: 10 },
      { availability: [] },
      { unitCount: 2 },
      { publish: true },
    ]) {
      expect(
        parseUpsertFlexibleRatePlanCommand({
          organizationId,
          propertyId,
          idempotencyKey: "flexible-plan-1",
          audit: audit(),
          roomTypeId,
          expectedRoomFactsRevision: 4,
          expectedPricingCurrencyRevision: 2,
          expectedFlexibleRatePlanRevision: 0,
          baseAmountDecimal: "160.00",
          cancellationTerms: cancellationTerms(),
          ...extra,
        }),
      ).toBeNull();
    }
  });

  it("uses normalized positive scale-2 decimal strings and never number money", () => {
    for (const value of ["0.01", "1.00", "160.00", "9999999999999.99"]) {
      expect(parsePmsDecimalAmount(value)).toBe(value);
    }
    for (const value of [
      0.01,
      160,
      "0.00",
      "1",
      "1.0",
      "01.00",
      "1.000",
      "10000000000000.00",
    ] as unknown[]) {
      expect(parsePmsDecimalAmount(value)).toBeNull();
    }
    expect(parsePmsPricingCurrency("CHF")).toBe("CHF");
    expect(parsePmsPricingCurrency("chf")).toBeNull();
  });

  it("requires the complete structured V1 cancellation snapshot", () => {
    const parsed = parseFlexibleCancellationTerms(cancellationTerms());
    expect(parsed).toEqual(cancellationTerms());
    expect(Object.isFrozen(parsed)).toBe(true);

    for (const invalid of [
      { ...cancellationTerms(), freeCancellationDeadlineDays: -1 },
      { ...cancellationTerms(), freeCancellationDeadlineDays: 366 },
      { ...cancellationTerms(), freeCancellationDeadlineDays: 7.5 },
      { ...cancellationTerms(), afterDeadlinePenalty: "first_night" },
      { ...cancellationTerms(), noShowPenalty: "none" },
      { ...cancellationTerms(), prose: "Free for seven days" },
    ]) {
      expect(parseFlexibleCancellationTerms(invalid)).toBeNull();
    }
  });

  it("serializes exact full-request business fingerprints without audit metadata", () => {
    const currency = parseUpsertPropertyPricingCurrencyCommand({
      organizationId,
      propertyId,
      idempotencyKey: "currency-key",
      audit: audit(),
      expectedPricingCurrencyRevision: 1,
      currency: "EUR",
    })!;
    const plan = parseUpsertFlexibleRatePlanCommand({
      organizationId,
      propertyId,
      idempotencyKey: "plan-key",
      audit: audit(),
      roomTypeId,
      expectedRoomFactsRevision: 4,
      expectedPricingCurrencyRevision: 2,
      expectedFlexibleRatePlanRevision: 3,
      baseAmountDecimal: "160.00",
      cancellationTerms: cancellationTerms(),
    })!;

    expect(serializePropertyPricingCurrencyFingerprint(currency)).toBe(
      `{"organizationId":"${organizationId}","propertyId":"${propertyId}","expectedPricingCurrencyRevision":1,"currency":"EUR"}`,
    );
    expect(serializeFlexibleRatePlanFingerprint(plan)).toBe(
      `{"organizationId":"${organizationId}","propertyId":"${propertyId}","roomTypeId":"${roomTypeId}","expectedRoomFactsRevision":4,"expectedPricingCurrencyRevision":2,"expectedFlexibleRatePlanRevision":3,"baseAmountDecimal":"160.00","cancellationTerms":{"type":"free_until_days_before_arrival","freeCancellationDeadlineDays":7,"afterDeadlinePenalty":"full_booking_amount","noShowPenalty":"full_booking_amount"}}`,
    );
  });

  it("publishes the existing PMS owner/operator policy boundary", () => {
    expect(PMS_PRICING_AUTHORIZATION).toEqual({
      permission: "pms.operations.manage",
      entitlement: { product: "pms", key: "property-management" },
      resource: {
        product: "pms",
        resourceType: "pms_property",
        allowedRelationships: ["owner", "operator"],
      },
    });
  });

  it("parses exact stored success and conflict results for safe replay", () => {
    const currencySuccess = parsePropertyPricingCurrencyCommandResult({
      ok: true,
      response: {
        contractVersion: PMS_PRICING_CONTRACT_VERSION,
        outcome: "updated",
        pricingCurrency: pricingCurrency(),
        acceptedAt: now,
      },
    });
    const planSuccess = parseFlexibleRatePlanCommandResult({
      ok: true,
      response: {
        contractVersion: PMS_PRICING_CONTRACT_VERSION,
        outcome: "updated",
        flexibleRatePlan: flexiblePlan(),
        acceptedAt: now,
      },
    });
    const currencyConflict = parsePropertyPricingCurrencyCommandResult({
      ok: false,
      error: { code: "pricing_currency_revision_conflict", currentRevision: 4 },
    });
    const planConflict = parseFlexibleRatePlanCommandResult({
      ok: false,
      error: { code: "room_facts_revision_conflict", currentRevision: 5 },
    });

    expect(currencySuccess).toMatchObject({ ok: true, response: { outcome: "updated" } });
    expect(planSuccess).toMatchObject({ ok: true, response: { outcome: "updated" } });
    expect(currencyConflict).toEqual({
      ok: false,
      error: { code: "pricing_currency_revision_conflict", currentRevision: 4 },
    });
    expect(
      parsePropertyPricingCurrencyCommandResult({
        ok: false,
        error: { code: "pricing_currency_revision_conflict", currentRevision: 0 },
      }),
    ).toEqual({
      ok: false,
      error: { code: "pricing_currency_revision_conflict", currentRevision: 0 },
    });
    expect(planConflict).toEqual({
      ok: false,
      error: { code: "room_facts_revision_conflict", currentRevision: 5 },
    });
    expect(
      parseFlexibleRatePlanCommandResult({
        ok: false,
        error: { code: "flexible_rate_plan_revision_conflict", currentRevision: 0 },
      }),
    ).toEqual({
      ok: false,
      error: { code: "flexible_rate_plan_revision_conflict", currentRevision: 0 },
    });
    expect(Object.isFrozen(currencySuccess)).toBe(true);
    expect(Object.isFrozen(planSuccess)).toBe(true);
  });

  it("requires canonical non-empty currency-change blockers", () => {
    const blocked = (blockers: unknown) =>
      parsePropertyPricingCurrencyCommandResult({
        ok: false,
        error: { code: "pricing_currency_change_blocked", currentRevision: 2, blockers },
      });

    expect(
      blocked([
        { code: "flexible_rate_plan", affectedCount: 2 },
        { code: "dependency_check_unavailable" },
      ]),
    ).toEqual({
      ok: false,
      error: {
        code: "pricing_currency_change_blocked",
        currentRevision: 2,
        blockers: [
          { code: "flexible_rate_plan", affectedCount: 2 },
          { code: "dependency_check_unavailable" },
        ],
      },
    });
    expect(blocked([])).toBeNull();
    expect(
      blocked([{ code: "dependency_check_unavailable" }, { code: "flexible_rate_plan" }]),
    ).toBeNull();
    expect(blocked([{ code: "flexible_rate_plan" }, { code: "flexible_rate_plan" }])).toBeNull();
    expect(blocked([{ code: "flexible_rate_plan", affectedCount: 0 }])).toBeNull();
    expect(
      parsePropertyPricingCurrencyCommandResult({
        ok: false,
        error: {
          code: "pricing_currency_change_blocked",
          currentRevision: 0,
          blockers: [{ code: "legacy_room_type_price", affectedCount: 1 }],
        },
      }),
    ).toEqual({
      ok: false,
      error: {
        code: "pricing_currency_change_blocked",
        currentRevision: 0,
        blockers: [{ code: "legacy_room_type_price", affectedCount: 1 }],
      },
    });
  });

  it("rejects stored result envelopes with extra or malformed data", () => {
    expect(
      parsePropertyPricingCurrencyCommandResult({
        ok: false,
        error: { code: "unsupported_pricing_currency", details: "EUR" },
      }),
    ).toBeNull();
    expect(
      parseFlexibleRatePlanCommandResult({
        ok: false,
        error: { code: "room_type_not_found", currentRevision: 1 },
      }),
    ).toBeNull();
    expect(
      parseFlexibleRatePlanCommandResult({
        ok: true,
        response: {
          contractVersion: PMS_PRICING_CONTRACT_VERSION,
          outcome: "created",
          flexibleRatePlan: flexiblePlan({ baseAmount: { amountDecimal: 160, currency: "EUR" } }),
          acceptedAt: now,
        },
      }),
    ).toBeNull();
  });
});

describe("PMS pricing source reads", () => {
  it("parses deeply frozen currency and plan snapshots", () => {
    const currency = parsePropertyPricingCurrencySnapshot(pricingCurrency());
    const plan = parseFlexibleRatePlanSnapshot(flexiblePlan());

    expect(currency).toEqual(pricingCurrency());
    expect(plan).toEqual(flexiblePlan());
    expect(Object.isFrozen(currency)).toBe(true);
    expect(Object.isFrozen(plan)).toBe(true);
    expect(Object.isFrozen(plan?.baseAmount)).toBe(true);
    expect(Object.isFrozen(plan?.cancellationTerms)).toBe(true);
  });

  it("requires one currency and deterministic unique room-plan evidence", () => {
    const secondPlan = flexiblePlan({
      roomTypeId: secondRoomTypeId,
      flexibleRatePlanId: secondRatePlanId,
      flexibleRatePlanRevision: 1,
    });
    const snapshot = {
      contractVersion: PMS_PRICING_CONTRACT_VERSION,
      propertyId,
      pricingCurrency: pricingCurrency(),
      flexibleRatePlans: [flexiblePlan(), secondPlan],
      capturedAt: now,
    };

    const parsed = parsePmsPricingSourceSnapshot(snapshot);
    expect(parsed).toEqual(snapshot);
    expect(Object.isFrozen(parsed)).toBe(true);
    expect(Object.isFrozen(parsed?.flexibleRatePlans)).toBe(true);

    expect(
      parsePmsPricingSourceSnapshot({
        ...snapshot,
        flexibleRatePlans: [secondPlan, flexiblePlan()],
      }),
    ).toBeNull();
    expect(
      parsePmsPricingSourceSnapshot({
        ...snapshot,
        flexibleRatePlans: [flexiblePlan(), flexiblePlan()],
      }),
    ).toBeNull();
    expect(
      parsePmsPricingSourceSnapshot({
        ...snapshot,
        flexibleRatePlans: [
          flexiblePlan({ baseAmount: { amountDecimal: "160.00", currency: "USD" } }),
        ],
      }),
    ).toBeNull();
    expect(
      parsePmsPricingSourceSnapshot({
        ...snapshot,
        pricingCurrency: { ...pricingCurrency(), propertyId: secondRoomTypeId },
      }),
    ).toBeNull();
  });

  it("exposes ports for commands, reads, supported-currency validation, and safe change guards", () => {
    const commands = {} as PmsPricingCommandPort;
    const reads = {} as PmsPricingReadPort;
    const currencies = {} as PmsPricingCurrencyValidationPort;
    const guard = {} as PmsPricingCurrencyChangeGuardPort;
    const dependencyGuard = {} as PmsPricingCurrencyDependencyGuardPort;

    expect(commands).toBeDefined();
    expect(reads).toBeDefined();
    expect(currencies).toBeDefined();
    expect(guard).toBeDefined();
    expect(dependencyGuard).toBeDefined();
  });

  it("publishes one exact normalized lock key and dependency-writer critical section", async () => {
    expect(PMS_PRICING_CURRENCY_DEPENDENCY_LOCK_NAMESPACE).toBe("pms-pricing-currency");
    expect(serializePmsPricingCurrencyDependencyLockKey(propertyId.toUpperCase())).toBe(
      `pms-pricing-currency:${propertyId}`,
    );
    expect(serializePmsPricingCurrencyDependencyLockKey("not-a-property-id")).toBeNull();

    const calls: string[] = [];
    const guard: PmsPricingCurrencyDependencyGuardPort = {
      async runWithPricingCurrencyDependencyGuard(input, guarded) {
        const lockKey = serializePmsPricingCurrencyDependencyLockKey(input.propertyId);
        if (!lockKey) throw new Error("invalid dependency scope");
        calls.push(`lock:${lockKey}`);
        const result = await guarded();
        calls.push(`unlock:${lockKey}`);
        return result;
      },
    };
    await guard.runWithPricingCurrencyDependencyGuard({ propertyId }, async () => {
      calls.push("read-evidence-and-write");
    });
    expect(calls).toEqual([
      `lock:pms-pricing-currency:${propertyId}`,
      "read-evidence-and-write",
      `unlock:pms-pricing-currency:${propertyId}`,
    ]);
  });

  it("requires currency dependency checks to enclose the guarded compare-and-set", async () => {
    const calls: string[] = [];
    const guard: PmsPricingCurrencyChangeGuardPort = {
      async runWithCurrencyChangeGuard(input, guarded) {
        calls.push(`lock:${input.propertyId}`);
        const result = await guarded([{ code: "payment_configuration", affectedCount: 1 }]);
        calls.push(`unlock:${input.propertyId}`);
        return result;
      },
    };

    const result = await guard.runWithCurrencyChangeGuard(
      {
        propertyId,
        currentCurrency: parsePmsPricingCurrency("EUR")!,
        requestedCurrency: parsePmsPricingCurrency("USD")!,
      },
      async (blockers) => {
        calls.push(`blocked:${blockers[0]?.code}`);
        return "typed-blocked-result";
      },
    );

    expect(result).toBe("typed-blocked-result");
    expect(calls).toEqual([
      `lock:${propertyId}`,
      "blocked:payment_configuration",
      `unlock:${propertyId}`,
    ]);
  });
});
