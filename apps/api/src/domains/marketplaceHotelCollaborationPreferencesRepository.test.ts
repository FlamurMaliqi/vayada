import {
  MARKETPLACE_HOTEL_COLLABORATION_PREFERENCES_CONTRACT_VERSION,
  parseReplaceMarketplaceHotelCollaborationPreferencesRequest,
  type ReplaceMarketplaceHotelCollaborationPreferencesCommand,
} from "@vayada/domain-marketplace";
import { describe, expect, it } from "vitest";

import {
  createPgMarketplaceHotelCollaborationPreferencesRepository,
  type MarketplaceHotelCollaborationPreferencesClient,
  type MarketplaceHotelCollaborationPreferencesPool,
} from "./marketplaceHotelCollaborationPreferencesRepository.js";

const organizationId = "10770000-0000-4000-8000-000000000001";
const propertyId = "10770000-0000-4000-8000-000000000002";
const actorUserId = "10770000-0000-4000-8000-000000000003";
const acceptedAt = "2026-08-03T15:00:00.000Z";

type FakeResult = { rows: Record<string, unknown>[]; rowCount: number | null };

describe("PostgreSQL Marketplace hotel collaboration preference repository", () => {
  it("locks and proves the profile scope before aggregate or idempotency access", async () => {
    const statements: string[] = [];
    const repository = repositoryWith(async (sql) => {
      statements.push(sql);
      return sql.includes("FROM marketplace.marketplace_hotel_profiles profile")
        ? result([], 0)
        : result();
    });

    await expect(repository.replaceHotelCollaborationPreferences(command())).resolves.toEqual({
      ok: false,
      error: { code: "setup_scope_unavailable" },
    });
    expect(statements.some((sql) => sql.includes("hotel_collaboration_preferences\n"))).toBe(false);
    expect(statements.some((sql) => sql.includes("platform.idempotency_keys"))).toBe(false);
    expect(statements).toEqual([
      "BEGIN",
      expect.stringContaining("FROM marketplace.marketplace_hotel_profiles profile"),
      "ROLLBACK",
    ]);
  });

  it("returns the canonical revision-zero omission only for an entitled existing profile", async () => {
    const statements: string[] = [];
    const repository = repositoryWith(async (sql) => {
      statements.push(sql);
      if (sql.includes("FROM marketplace.marketplace_hotel_profiles profile")) {
        return result([{ property_id: propertyId }]);
      }
      if (sql.includes("FROM identity.product_entitlements")) {
        return result([{ status: "active", startsAt: null, expiresAt: null }]);
      }
      if (sql.includes("FROM marketplace.hotel_collaboration_preferences")) return result([], 0);
      return result();
    });

    const outcome = await repository.getHotelCollaborationPreferences({
      organizationId,
      propertyId,
    });
    expect(outcome).toMatchObject({
      outcome: "available",
      readModel: {
        propertyId,
        revision: 0,
        sourceRevision: "preferences:0",
        preferences: null,
        readiness: { status: "blocked" },
      },
    });
    expect(statementIndex(statements, "marketplace_hotel_profiles")).toBeLessThan(
      statementIndex(statements, "product_entitlements"),
    );
    expect(statementIndex(statements, "product_entitlements")).toBeLessThan(
      statementIndex(statements, "hotel_collaboration_preferences"),
    );
  });

  it("does not turn missing scope or database failures into owner omissions", async () => {
    const missing = repositoryWith(async (sql) =>
      sql.includes("FROM marketplace.marketplace_hotel_profiles profile")
        ? result([], 0)
        : result(),
    );
    await expect(
      missing.getHotelCollaborationPreferences({ organizationId, propertyId }),
    ).resolves.toEqual(unavailable());

    const failing = repositoryWith(async (sql) => {
      if (sql.includes("FROM marketplace.hotel_collaboration_preferences")) {
        throw new Error("database unavailable");
      }
      if (sql.includes("FROM marketplace.marketplace_hotel_profiles profile")) {
        return result([{ property_id: propertyId }]);
      }
      if (sql.includes("FROM identity.product_entitlements")) {
        return result([{ status: "active", startsAt: null, expiresAt: null }]);
      }
      return result();
    });
    await expect(
      failing.getHotelCollaborationPreferences({ organizationId, propertyId }),
    ).resolves.toEqual(unavailable());
  });

  it("reports noncanonical or otherwise malformed stored aggregates as malformed", async () => {
    for (const aggregate of [
      preferenceRow({ compensationTypes: ["paid", "free_stay"] }),
      preferenceRow({ contractVersion: "unknown" }),
      preferenceRow({ revision: 0 }),
    ]) {
      const repository = repositoryWith(async (sql) => {
        if (sql.includes("FROM marketplace.marketplace_hotel_profiles profile")) {
          return result([{ property_id: propertyId }]);
        }
        if (sql.includes("FROM identity.product_entitlements")) {
          return result([{ status: "active", startsAt: null, expiresAt: null }]);
        }
        if (sql.includes("FROM marketplace.hotel_collaboration_preferences")) {
          return result([aggregate]);
        }
        return result();
      });
      await expect(
        repository.getHotelCollaborationPreferences({ organizationId, propertyId }),
      ).resolves.toEqual({
        outcome: "malformed",
        error: {
          code: "preference_source_malformed",
          errorSource: "system",
          retryable: false,
        },
      });
    }
  });
});

function repositoryWith(query: (sql: string, values?: readonly unknown[]) => Promise<FakeResult>) {
  const client: MarketplaceHotelCollaborationPreferencesClient = {
    query: async (sql, values) => query(sql, values) as never,
    release() {},
  };
  const pool: MarketplaceHotelCollaborationPreferencesPool = {
    async connect() {
      return client;
    },
    async end() {},
  };
  return createPgMarketplaceHotelCollaborationPreferencesRepository({
    connectionString: "postgresql://unit-test",
    pool,
    now: () => new Date(acceptedAt),
  });
}

function command(): ReplaceMarketplaceHotelCollaborationPreferencesCommand {
  const request = parseReplaceMarketplaceHotelCollaborationPreferencesRequest({
    expectedRevision: 0,
    compensationTypes: ["paid", "free_stay"],
    contentPlatforms: ["youtube", "instagram"],
    contentTypes: ["photography", "post"],
    availability: { mode: "selected_months", selectedMonths: [12, 1] },
  });
  if (!request) throw new Error("Invalid command fixture");
  return {
    organizationId,
    propertyId,
    idempotencyKey: "repository-unit-key",
    audit: {
      actor: { kind: "user", userId: actorUserId },
      requestId: "request-1077",
      correlationId: "correlation-1077",
      requestedAt: acceptedAt,
    },
    request,
  };
}

function preferenceRow(overrides: Record<string, unknown> = {}) {
  return {
    propertyId,
    organizationId,
    contractVersion: MARKETPLACE_HOTEL_COLLABORATION_PREFERENCES_CONTRACT_VERSION,
    revision: 1,
    compensationTypes: ["free_stay", "paid"],
    contentPlatforms: ["instagram", "youtube"],
    contentTypes: ["post", "photography"],
    availabilityMode: "selected_months",
    selectedMonths: [1, 12],
    ...overrides,
  };
}

function result(rows: Record<string, unknown>[] = [], rowCount = rows.length): FakeResult {
  return { rows, rowCount };
}

function statementIndex(statements: string[], fragment: string): number {
  return statements.findIndex((statement) => statement.includes(fragment));
}

function unavailable() {
  return {
    outcome: "unavailable",
    error: { code: "preference_source_unavailable", errorSource: "system", retryable: true },
  };
}
