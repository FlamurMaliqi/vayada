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

describe("PMS pricing command repository", () => {
  it("requires both supported-currency and guarded-change dependencies", () => {
    const pool = { connect: vi.fn(), end: vi.fn() } as unknown as PmsPricingCommandPool;
    expect(() =>
      createPgPmsPricingCommandRepository({
        connectionString: "test",
        pool,
        currencyValidator: undefined!,
        currencyChangeGuard: {
          async runWithCurrencyChangeGuard(_input, guarded) {
            return guarded([]);
          },
        },
      }),
    ).toThrow("requires a currency validator");
    expect(() =>
      createPgPmsPricingCommandRepository({
        connectionString: "test",
        pool,
        currencyValidator: {
          async isSupportedPricingCurrency() {
            return true;
          },
        },
        currencyChangeGuard: undefined!,
      }),
    ).toThrow("requires a currency-change guard");
  });

  it("rechecks committed owner/operator scope before validation, guard, or replay", async () => {
    const validator = vi.fn(async () => true);
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
      currencyValidator: { isSupportedPricingCurrency: validator },
      currencyChangeGuard: guard,
    });

    await expect(repository.upsertPropertyPricingCurrency(currencyCommand())).resolves.toEqual({
      ok: false,
      error: { code: "setup_scope_unavailable" },
    });
    expect(validator).not.toHaveBeenCalled();
    expect(guardCallCount).toBe(0);
    expect(queries.findIndex((sql) => sql.includes("pg_advisory_xact_lock"))).toBeLessThan(
      queries.findIndex((sql) => sql.includes("FROM hotel_catalog.properties")),
    );
    expect(queries.some((sql) => sql.includes("platform.idempotency_keys"))).toBe(false);
  });
});
