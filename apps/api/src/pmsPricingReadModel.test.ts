import { describe, expect, it } from "vitest";

import {
  createPgPmsPricingReadModel,
  type PmsPricingReadClient,
  type PmsPricingReadPool,
} from "./domains/pmsPricingReadModel.js";

const propertyId = "30000000-0000-4000-8000-000000000001";
const roomTypeId = "40000000-0000-4000-8000-000000000001";
const planId = "50000000-0000-4000-8000-000000000001";
const now = "2026-08-03T12:00:00.000Z";

function currencyRow() {
  return {
    propertyId,
    currency: "EUR",
    pricingCurrencyRevision: "2",
    createdAt: now,
    updatedAt: now,
  };
}

function planRow(overrides: Partial<{ amountDecimal: string; roomTypeId: string }> = {}) {
  return {
    propertyId,
    roomTypeId: overrides.roomTypeId ?? roomTypeId,
    flexibleRatePlanId: planId,
    flexibleRatePlanRevision: "3",
    sourceRoomFactsRevision: "4",
    amountDecimal: overrides.amountDecimal ?? "1234567890123.45",
    currency: "EUR",
    cancellationTerms: {
      type: "free_until_days_before_arrival",
      freeCancellationDeadlineDays: 7,
      afterDeadlinePenalty: "full_booking_amount",
      noShowPenalty: "full_booking_amount",
    },
    createdAt: now,
    updatedAt: now,
  };
}

function fakePool(overrides: { amountDecimal?: string } = {}) {
  const calls: Array<{ sql: string; values?: readonly unknown[] }> = [];
  const rawQuery = async (sql: string, values?: readonly unknown[]) => {
    calls.push({ sql, values });
    if (sql.startsWith("BEGIN") || sql === "COMMIT" || sql === "ROLLBACK") {
      return { rows: [], rowCount: 0 };
    }
    if (sql.startsWith("WITH pricing_currency")) {
      return {
        rows: [
          {
            pricingCurrency: currencyRow(),
            flexibleRatePlans: [planRow({ amountDecimal: overrides.amountDecimal })],
          },
        ],
        rowCount: 1,
      };
    }
    if (sql.includes("FROM pms.property_pricing_settings")) {
      return { rows: [currencyRow()], rowCount: 1 };
    }
    if (sql.includes("FROM pms.rate_plans")) {
      return {
        rows: [planRow({ amountDecimal: overrides.amountDecimal })],
        rowCount: 1,
      };
    }
    throw new Error(`Unexpected pricing read query: ${sql}`);
  };
  const query = rawQuery as PmsPricingReadPool["query"];
  const client: PmsPricingReadClient = { query, release() {} };
  const pool: PmsPricingReadPool = {
    query,
    async connect() {
      return client;
    },
  };
  return { pool, calls };
}

describe("PMS pricing read model", () => {
  it("returns canonical decimal strings without JavaScript money coercion", async () => {
    const { pool } = fakePool();
    const read = createPgPmsPricingReadModel({ connectionString: "test", pool });

    await expect(read.getPropertyPricingCurrency(propertyId.toUpperCase())).resolves.toMatchObject({
      propertyId,
      currency: "EUR",
      pricingCurrencyRevision: 2,
    });
    await expect(read.getFlexibleRatePlan(propertyId, roomTypeId)).resolves.toMatchObject({
      propertyId,
      roomTypeId,
      flexibleRatePlanId: planId,
      baseAmount: { amountDecimal: "1234567890123.45", currency: "EUR" },
    });
  });

  it("captures currency and plans in one repeatable-read transaction", async () => {
    const { pool, calls } = fakePool();
    const read = createPgPmsPricingReadModel({
      connectionString: "test",
      pool,
      now: () => new Date(now),
    });

    await expect(read.getPricingSourceSnapshot(propertyId)).resolves.toMatchObject({
      propertyId,
      pricingCurrency: { pricingCurrencyRevision: 2 },
      flexibleRatePlans: [{ flexibleRatePlanRevision: 3 }],
      capturedAt: now,
    });
    expect(calls[0]?.sql).toBe("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    expect(calls.filter(({ sql }) => sql.includes("WITH pricing_currency"))).toHaveLength(1);
    expect(calls.at(-1)?.sql).toBe("COMMIT");
  });

  it("fails closed and rolls back malformed database money", async () => {
    const { pool, calls } = fakePool({ amountDecimal: "12.345" });
    const read = createPgPmsPricingReadModel({
      connectionString: "test",
      pool,
      now: () => new Date(now),
    });

    await expect(read.getPricingSourceSnapshot(propertyId)).rejects.toThrow(
      "PMS flexible pricing plan row failed contract validation",
    );
    expect(calls.at(-1)?.sql).toBe("ROLLBACK");
  });
});
