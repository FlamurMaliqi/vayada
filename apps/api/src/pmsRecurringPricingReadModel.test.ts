import { describe, expect, it } from "vitest";

import {
  createPgPmsRecurringPricingReadModel,
  pmsRecurringPricingSnapshotFromRows,
  type PmsRecurringPricingReadClient,
  type PmsRecurringPricingReadPool,
} from "./domains/pmsRecurringPricingReadModel.js";

const propertyId = "72000000-0000-4000-8000-000000000001";
const sourceId = "72000000-0000-4000-8000-000000000002";
const roomTypeId = "72000000-0000-4000-8000-000000000003";
const planId = "72000000-0000-4000-8000-000000000004";
const now = "2026-08-03T15:00:00.000Z";

function root(overrides: Record<string, unknown> = {}) {
  return {
    propertyId,
    sourceId,
    sourceKind: "season",
    sourceRevision: "3",
    pricingCurrencyRevision: "2",
    currency: "EUR",
    configuredState: "active",
    validationState: "valid",
    validationRevision: "1",
    validatedAt: now,
    invalidReasons: [],
    lifecycle: "active",
    materializationRevision: "0",
    seasonName: "Summer",
    seasonStartMonth: "6",
    seasonStartDay: "1",
    seasonEndMonth: "8",
    seasonEndDay: "31",
    weekendDays: null,
    discountPercent: null,
    cancellationTermsType: null,
    refundPolicy: null,
    noShowPenalty: null,
    paymentTiming: null,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function roomValue(amount = "9999999999999.99") {
  return {
    sourceId,
    sourceKind: "season",
    roomTypeId,
    roomFactsRevision: "4",
    flexibleRatePlanId: planId,
    flexibleRatePlanRevision: "3",
    seasonalAmount: amount,
    weekendAmount: null,
    maximumAdultGuests: null,
    includedGuests: null,
    additionalGuestAmount: null,
  };
}

function fakePool(options: { amount?: string; roots?: readonly unknown[] } = {}) {
  const calls: string[] = [];
  const query = (async (sql: string) => {
    calls.push(sql);
    if (sql.startsWith("BEGIN") || sql === "COMMIT" || sql === "ROLLBACK") {
      return { rows: [], rowCount: 0 };
    }
    if (sql.includes("FROM pms.property_pricing_settings")) {
      return {
        rows: [
          {
            currency: "EUR",
            pricingCurrencyRevision: "2",
            optionalPricingAggregateRevision: "1",
          },
        ],
        rowCount: 1,
      };
    }
    if (sql.includes("FROM pms.recurring_pricing_sources source")) {
      return { rows: options.roots ?? [root()], rowCount: 1 };
    }
    if (sql.includes("FROM pms.recurring_pricing_source_room_values value")) {
      return { rows: [roomValue(options.amount)], rowCount: 1 };
    }
    if (sql.includes("FROM pms.non_refundable_rate_plan_source_rooms source")) {
      return { rows: [], rowCount: 0 };
    }
    throw new Error(`Unexpected recurring pricing read query: ${sql}`);
  }) as PmsRecurringPricingReadPool["query"];
  const client: PmsRecurringPricingReadClient = { query, release() {} };
  const pool: PmsRecurringPricingReadPool = {
    query,
    async connect() {
      return client;
    },
  };
  return { pool, calls };
}

describe("PMS recurring pricing read model", () => {
  it("returns canonical decimal strings and exact dependency revisions", async () => {
    const { pool, calls } = fakePool();
    const read = createPgPmsRecurringPricingReadModel({ connectionString: "test", pool });

    await expect(read.getRecurringPricingSource(propertyId, sourceId)).resolves.toMatchObject({
      propertyId,
      sourceId,
      sourceRevision: 3,
      currency: "EUR",
      roomPrices: [
        {
          roomTypeId,
          roomFactsRevision: 4,
          flexibleRatePlanId: planId,
          flexibleRatePlanRevision: 3,
          amountDecimal: "9999999999999.99",
        },
      ],
    });
    expect(calls[0]).toBe("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    expect(calls.find((sql) => sql.includes("non_refundable_rate_plan_source_rooms"))).toContain(
      "ORDER BY source.source_id, source.room_type_id",
    );
    expect(calls.at(-1)).toBe("COMMIT");
  });

  it("lists roots and detail rows from one repeatable-read snapshot", async () => {
    const { pool, calls } = fakePool();
    const read = createPgPmsRecurringPricingReadModel({ connectionString: "test", pool });

    await expect(read.listRecurringPricingSources(propertyId)).resolves.toMatchObject([
      { propertyId, sourceId, sourceRevision: 3 },
    ]);
    expect(calls[0]).toBe("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    expect(calls.at(-1)).toBe("COMMIT");
  });

  it("reconstructs disabled weekend and invalid additional-guest lifecycle evidence", () => {
    const weekend = pmsRecurringPricingSnapshotFromRows(
      root({
        sourceKind: "weekend_surcharge",
        configuredState: "disabled",
        lifecycle: "disabled",
        seasonName: null,
        seasonStartMonth: null,
        seasonStartDay: null,
        seasonEndMonth: null,
        seasonEndDay: null,
        weekendDays: ["friday", "saturday"],
      }),
      {
        roomValues: [
          {
            ...roomValue("15.00"),
            sourceKind: "weekend_surcharge",
            seasonalAmount: null,
            weekendAmount: "15.00",
          },
        ],
        nonRefundable: [],
      },
    );
    const additionalGuest = pmsRecurringPricingSnapshotFromRows(
      root({
        sourceKind: "additional_guest",
        validationState: "invalid",
        invalidReasons: [{ code: "dependency_unavailable" }],
        lifecycle: "invalid",
        seasonName: null,
        seasonStartMonth: null,
        seasonStartDay: null,
        seasonEndMonth: null,
        seasonEndDay: null,
      }),
      {
        roomValues: [
          {
            ...roomValue("25.00"),
            sourceKind: "additional_guest",
            seasonalAmount: null,
            maximumAdultGuests: "4",
            includedGuests: "2",
            additionalGuestAmount: "25.00",
          },
        ],
        nonRefundable: [],
      },
    );

    expect(weekend).toMatchObject({
      sourceKind: "weekend_surcharge",
      configuredState: "disabled",
      lifecycle: "disabled",
      weekdays: ["friday", "saturday"],
      roomSurcharges: [{ roomTypeId, amountDecimal: "15.00" }],
    });
    expect(additionalGuest).toMatchObject({
      sourceKind: "additional_guest",
      lifecycle: "invalid",
      validation: { state: "invalid", reasons: [{ code: "dependency_unavailable" }] },
      maximumAdultGuests: 4,
      includedGuests: 2,
      amountDecimal: "25.00",
    });
  });

  it("captures aggregate and all lifecycles in one repeatable-read transaction", async () => {
    const { pool, calls } = fakePool();
    const read = createPgPmsRecurringPricingReadModel({
      connectionString: "test",
      pool,
      now: () => new Date(now),
    });
    await expect(read.getRecurringPricingBookingEvidence(propertyId)).resolves.toMatchObject({
      propertyId,
      pricingCurrencyRevision: 2,
      optionalPricingAggregateRevision: 1,
      sources: [{ sourceId, lifecycle: "active" }],
      capturedAt: now,
    });
    expect(calls[0]).toBe("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    expect(calls.at(-1)).toBe("COMMIT");
  });

  it("fails closed and rolls back malformed persisted decimal data", async () => {
    const { pool, calls } = fakePool({ amount: "12.345" });
    const read = createPgPmsRecurringPricingReadModel({
      connectionString: "test",
      pool,
      now: () => new Date(now),
    });
    await expect(read.getRecurringPricingBookingEvidence(propertyId)).rejects.toThrow(
      "source row failed contract validation",
    );
    expect(calls.at(-1)).toBe("ROLLBACK");
  });

  it("returns aggregate revision zero with no optional sources", async () => {
    const calls: string[] = [];
    const query = (async (sql: string) => {
      calls.push(sql);
      if (sql.startsWith("BEGIN") || sql === "COMMIT" || sql === "ROLLBACK") {
        return { rows: [], rowCount: 0 };
      }
      if (sql.includes("property_pricing_settings")) {
        return {
          rows: [
            {
              currency: "EUR",
              pricingCurrencyRevision: "1",
              optionalPricingAggregateRevision: "0",
            },
          ],
          rowCount: 1,
        };
      }
      return { rows: [], rowCount: 0 };
    }) as PmsRecurringPricingReadPool["query"];
    const client: PmsRecurringPricingReadClient = { query, release() {} };
    const pool: PmsRecurringPricingReadPool = {
      query,
      async connect() {
        return client;
      },
    };
    const read = createPgPmsRecurringPricingReadModel({
      connectionString: "test",
      pool,
      now: () => new Date(now),
    });
    await expect(read.getRecurringPricingBookingEvidence(propertyId)).resolves.toMatchObject({
      optionalPricingAggregateRevision: 0,
      sources: [],
    });
  });

  it("preserves every hotel-wide non-refundable room-plan binding", () => {
    const secondRoomTypeId = "72000000-0000-4000-8000-000000000005";
    const secondPlanId = "72000000-0000-4000-8000-000000000006";
    expect(
      pmsRecurringPricingSnapshotFromRows(
        root({
          sourceKind: "non_refundable",
          seasonName: null,
          seasonStartMonth: null,
          seasonStartDay: null,
          seasonEndMonth: null,
          seasonEndDay: null,
          discountPercent: "12",
          cancellationTermsType: "non_refundable",
          refundPolicy: "no_refund",
          noShowPenalty: "full_booking_amount",
          paymentTiming: "prepay_full",
        }),
        {
          roomValues: [],
          nonRefundable: [
            {
              sourceId,
              roomTypeId,
              roomFactsRevision: "4",
              flexibleRatePlanId: planId,
              flexibleRatePlanRevision: "3",
            },
            {
              sourceId,
              roomTypeId: secondRoomTypeId,
              roomFactsRevision: "5",
              flexibleRatePlanId: secondPlanId,
              flexibleRatePlanRevision: "4",
            },
          ],
        },
      ),
    ).toMatchObject({
      sourceKind: "non_refundable",
      discountPercent: 12,
      roomPlans: [
        { roomTypeId, flexibleRatePlanId: planId },
        { roomTypeId: secondRoomTypeId, flexibleRatePlanId: secondPlanId },
      ],
      paymentTiming: "prepay_full",
      cancellationTerms: { refundPolicy: "no_refund" },
    });
  });
});
