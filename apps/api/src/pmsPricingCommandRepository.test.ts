import {
  parsePmsPricingCurrency,
  parseUpsertPropertyPricingCurrencyCommand,
  type PmsPricingCurrencyChangeGuardPort,
} from "@vayada/domain-pms";
import { describe, expect, it, vi } from "vitest";

import {
  createPgPmsPricingCommandRepository,
  type PmsPricingCommandClient,
  type PmsPricingCommandPool,
} from "./domains/pmsPricingCommandRepository.js";

const organizationId = "10000000-0000-4000-8000-000000000001";
const propertyId = "10000000-0000-4000-8000-000000000002";
const actorUserId = "10000000-0000-4000-8000-000000000003";
const acceptedAt = "2026-08-03T12:00:00.000Z";

function currencyCommand() {
  const command = parseUpsertPropertyPricingCurrencyCommand({
    organizationId,
    propertyId,
    idempotencyKey: "pricing-key",
    audit: {
      actor: { kind: "user", userId: actorUserId },
      requestId: "request-1",
      correlationId: "correlation-1",
      requestedAt: acceptedAt,
    },
    expectedPricingCurrencyRevision: 0,
    currency: parsePmsPricingCurrency("EUR"),
  });
  if (!command) throw new Error("Invalid pricing command fixture");
  return command;
}

function currencyChangeCommand() {
  const command = parseUpsertPropertyPricingCurrencyCommand({
    organizationId,
    propertyId,
    idempotencyKey: "pricing-change-key",
    audit: {
      actor: { kind: "user", userId: actorUserId },
      requestId: "request-change",
      correlationId: "correlation-change",
      requestedAt: acceptedAt,
    },
    expectedPricingCurrencyRevision: 1,
    currency: parsePmsPricingCurrency("USD"),
  });
  if (!command) throw new Error("Invalid pricing currency change fixture");
  return command;
}

describe("PMS pricing command repository", () => {
  it("requires the guarded-change dependency", () => {
    const pool = { connect: vi.fn(), end: vi.fn() } as unknown as PmsPricingCommandPool;
    expect(() =>
      createPgPmsPricingCommandRepository({
        connectionString: "test",
        pool,
        currencyChangeGuard: undefined!,
      }),
    ).toThrow("requires a currency-change guard");
  });

  it("rechecks committed owner/operator scope before validation, guard, or replay", async () => {
    let guardCallCount = 0;
    const guard: PmsPricingCurrencyChangeGuardPort = {
      async runWithCurrencyChangeGuard(_input, guarded) {
        guardCallCount += 1;
        return guarded([]);
      },
    };
    const queries: string[] = [];
    const client: PmsPricingCommandClient = {
      async query(sql) {
        queries.push(sql);
        if (sql.includes("FROM hotel_catalog.properties")) return { rows: [], rowCount: 0 };
        return { rows: [], rowCount: 0 };
      },
      release() {},
    };
    const pool: PmsPricingCommandPool = {
      async connect() {
        return client;
      },
      async end() {},
    };
    const repository = createPgPmsPricingCommandRepository({
      connectionString: "test",
      pool,
      now: () => new Date(acceptedAt),
      currencyChangeGuard: guard,
    });

    await expect(repository.upsertPropertyPricingCurrency(currencyCommand())).resolves.toEqual({
      ok: false,
      error: { code: "setup_scope_unavailable" },
    });
    expect(guardCallCount).toBe(0);
    expect(queries.findIndex((sql) => sql.includes("pg_advisory_xact_lock"))).toBeLessThan(
      queries.findIndex((sql) => sql.includes("FROM hotel_catalog.properties")),
    );
    expect(queries.some((sql) => sql.includes("platform.idempotency_keys"))).toBe(false);
  });

  it("aggregates every recurring source into the existing rate-rule blocker without lifecycle filters", async () => {
    const queries: string[] = [];
    const currentCurrencyRow = {
      propertyId,
      currency: "EUR",
      pricingCurrencyRevision: "1",
      createdAt: acceptedAt,
      updatedAt: acceptedAt,
    };
    const client: PmsPricingCommandClient = {
      async query(sql) {
        queries.push(sql);
        if (sql.includes("FROM hotel_catalog.properties property")) {
          return { rows: [{ id: propertyId }], rowCount: 1 } as never;
        }
        if (sql.includes("FROM identity.product_entitlements")) {
          return {
            rows: [{ status: "active", startsAt: null, expiresAt: null }],
            rowCount: 1,
          } as never;
        }
        if (sql.includes("FROM platform.idempotency_keys") && sql.includes("FOR UPDATE")) {
          return { rows: [], rowCount: 0 } as never;
        }
        if (sql.includes("INSERT INTO platform.idempotency_keys")) {
          return {
            rows: [{ id: "10000000-0000-4000-8000-000000000010", attempt: 1 }],
            rowCount: 1,
          } as never;
        }
        if (sql.includes("FROM pms.property_pricing_settings")) {
          return { rows: [currentCurrencyRow], rowCount: 1 } as never;
        }
        if (sql.includes('AS "flexibleRatePlanCount"')) {
          return {
            rows: [
              {
                flexibleRatePlanCount: "0",
                legacyRoomTypePriceCount: "0",
                legacyRatePlanCount: "0",
                rateRuleCount: "7",
              },
            ],
            rowCount: 1,
          } as never;
        }
        if (sql.includes("UPDATE platform.idempotency_keys")) {
          return { rows: [], rowCount: 1 } as never;
        }
        return { rows: [], rowCount: 1 } as never;
      },
      release() {},
    };
    const pool: PmsPricingCommandPool = {
      async connect() {
        return client;
      },
      async end() {},
    };
    const repository = createPgPmsPricingCommandRepository({
      connectionString: "test",
      pool,
      now: () => new Date(acceptedAt),
      currencyChangeGuard: {
        async runWithCurrencyChangeGuard(_input, guarded) {
          return guarded([]);
        },
      },
    });

    await expect(
      repository.upsertPropertyPricingCurrency(currencyChangeCommand()),
    ).resolves.toEqual({
      ok: false,
      error: {
        code: "pricing_currency_change_blocked",
        currentRevision: 1,
        blockers: [{ code: "rate_rule", affectedCount: 7 }],
      },
    });
    const blockerQuery = queries.find((sql) => sql.includes('AS "rateRuleCount"'));
    expect(blockerQuery).toContain("FROM pms.rate_rules");
    expect(blockerQuery).toContain("FROM pms.recurring_pricing_sources");
    expect(blockerQuery).not.toMatch(/configured_state|validation_state|lifecycle/);
  });
});
