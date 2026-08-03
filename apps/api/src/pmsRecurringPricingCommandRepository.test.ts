import {
  parseMaterializeRecurringPricingCommand,
  parseUpsertRecurringSeasonCommand,
} from "@vayada/domain-pms";
import { describe, expect, it, vi } from "vitest";

import {
  createPgPmsRecurringPricingCommandRepository,
  type PmsRecurringPricingCommandClient,
  type PmsRecurringPricingCommandPool,
} from "./domains/pmsRecurringPricingCommandRepository.js";

const organizationId = "71000000-0000-4000-8000-000000000001";
const propertyId = "71000000-0000-4000-8000-000000000002";
const actorUserId = "71000000-0000-4000-8000-000000000003";
const sourceId = "71000000-0000-4000-8000-000000000004";
const roomTypeId = "71000000-0000-4000-8000-000000000005";
const planId = "71000000-0000-4000-8000-000000000006";
const acceptedAt = "2026-08-03T15:00:00.000Z";

function audit() {
  return {
    actor: { kind: "user", userId: actorUserId },
    requestId: "request-recurring-pricing-1",
    correlationId: "correlation-recurring-pricing-1",
    requestedAt: acceptedAt,
  };
}

function seasonCommand() {
  const command = parseUpsertRecurringSeasonCommand({
    organizationId,
    propertyId,
    idempotencyKey: "season-key",
    audit: audit(),
    sourceId,
    expectedSourceRevision: 0,
    expectedPricingCurrencyRevision: 1,
    sourceKind: "season",
    name: "Summer",
    startMonthDay: "06-01",
    endMonthDay: "08-31",
    roomPrices: [
      {
        roomTypeId,
        expectedRoomFactsRevision: 1,
        flexibleRatePlanId: planId,
        expectedFlexibleRatePlanRevision: 1,
        amountDecimal: "9999999999999.99",
      },
    ],
  });
  if (!command) throw new Error("invalid season fixture");
  return command;
}

describe("PMS recurring pricing command repository", () => {
  it("requires a connection string", () => {
    expect(() => createPgPmsRecurringPricingCommandRepository({ connectionString: "" })).toThrow(
      "connectionString must not be empty",
    );
  });

  it("locks property and source, then rejects scope before replay or domain reads", async () => {
    const queries: string[] = [];
    const client: PmsRecurringPricingCommandClient = {
      async query(sql) {
        queries.push(sql);
        if (sql.includes("FROM hotel_catalog.properties")) return { rows: [], rowCount: 0 };
        return { rows: [], rowCount: 0 };
      },
      release() {},
    };
    const pool: PmsRecurringPricingCommandPool = {
      async connect() {
        return client;
      },
      async end() {},
    };
    const repository = createPgPmsRecurringPricingCommandRepository({
      connectionString: "test",
      pool,
      now: () => new Date(acceptedAt),
    });

    await expect(repository.upsertRecurringSeason(seasonCommand())).resolves.toEqual({
      ok: false,
      error: { code: "setup_scope_unavailable" },
    });
    expect(queries.filter((sql) => sql.includes("pg_advisory_xact_lock"))).toHaveLength(2);
    expect(queries.some((sql) => sql.includes("platform.idempotency_keys"))).toBe(false);
    expect(queries.some((sql) => sql.includes("pms.property_pricing_settings"))).toBe(false);
    expect(queries.at(-1)).toBe("ROLLBACK");
  });

  it("locks the property aggregate but does not accept caller-selected materialization sources", async () => {
    const command = parseMaterializeRecurringPricingCommand({
      organizationId,
      propertyId,
      idempotencyKey: "materialize-key",
      audit: audit(),
      fromDate: "2026-01-01",
      throughDate: "2026-01-31",
      expectedOptionalPricingAggregateRevision: 2,
    });
    if (!command) throw new Error("invalid materialization fixture");
    const lockValues: unknown[] = [];
    const client: PmsRecurringPricingCommandClient = {
      async query(sql, values) {
        if (sql.includes("pms-recurring-pricing-source:")) lockValues.push(values?.[0]);
        if (sql.includes("FROM hotel_catalog.properties")) return { rows: [], rowCount: 0 };
        return { rows: [], rowCount: 0 };
      },
      release() {},
    };
    const pool: PmsRecurringPricingCommandPool = {
      connect: vi.fn(async () => client),
      end: vi.fn(async () => undefined),
    };
    const repository = createPgPmsRecurringPricingCommandRepository({
      connectionString: "test",
      pool,
      now: () => new Date(acceptedAt),
    });

    await expect(repository.materializeRecurringPricing(command)).resolves.toMatchObject({
      ok: false,
      error: { code: "setup_scope_unavailable" },
    });
    expect(lockValues).toEqual([]);
  });
});
