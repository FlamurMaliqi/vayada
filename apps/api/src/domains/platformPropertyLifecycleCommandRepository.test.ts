import { describe, expect, it } from "vitest";

import { createPgPlatformPropertyLifecycleCommandRepository } from "./platformPropertyLifecycleCommandRepository.js";

const propertyId = "11111111-1111-4111-8111-111111111111";
const audit = {
  actorUserId: "22222222-2222-4222-8222-222222222222",
  organizationId: "33333333-3333-4333-8333-333333333333",
  requestId: "req-1",
  correlationId: "corr-1",
  requestedAt: "2026-08-13T12:00:00.000Z",
};

describe("platform property lifecycle commands", () => {
  it("suspends public exposure and records the guarded command atomically", async () => {
    const target = harness();
    const repository = createPgPlatformPropertyLifecycleCommandRepository({
      pool: target.pool,
      now: () => new Date("2026-08-13T12:00:01.000Z"),
    });

    const result = await repository.changeStatus({
      propertyId,
      expectedLifecycleRevision: 4,
      status: "suspended",
      reason: "Owner requested a temporary hold",
      idempotencyKey: "status-1",
      audit,
    });

    expect(result).toEqual({
      contractVersion: "platform-property-lifecycle.v1",
      propertyId,
      lifecycleStatus: "suspended",
      lifecycleRevision: 5,
    });
    expect(target.sql()).toContain("UPDATE marketplace.active_hotel_submission_revisions");
    expect(target.sql()).toContain("UPDATE marketplace.marketplace_hotel_profiles");
    expect(target.sql()).toContain("UPDATE marketplace.marketplace_offer_read_model");
    expect(target.sql()).toContain("DELETE FROM distribution.active_public_booking_revision");
    expect(target.sql()).toContain("pg_advisory_xact_lock");
    expect(target.sql().indexOf("pg_advisory_xact_lock")).toBeLessThan(
      target.sql().indexOf("FROM hotel_catalog.properties"),
    );
    expect(target.sql()).toContain("INSERT INTO platform.product_audit_events");
    expect(target.sql()).toContain("UPDATE platform.idempotency_keys SET status = 'completed'");
    expect(target.statements.at(0)?.sql).toBe("BEGIN");
    expect(target.statements.at(-1)?.sql).toBe("COMMIT");
  });

  it("rejects invalid transitions before reserving idempotency or writing audit", async () => {
    const target = harness({ lifecycleStatus: "retired" });
    const repository = createPgPlatformPropertyLifecycleCommandRepository({ pool: target.pool });

    await expect(
      repository.changeStatus({
        propertyId,
        expectedLifecycleRevision: 4,
        status: "active",
        reason: "Unsafe direct restore",
        idempotencyKey: "status-2",
        audit,
      }),
    ).rejects.toMatchObject({
      code: "invalid_lifecycle_transition",
    });

    expect(target.sql()).not.toContain("INSERT INTO platform.idempotency_keys");
    expect(target.sql()).not.toContain("INSERT INTO platform.product_audit_events");
    expect(target.statements.at(-1)?.sql).toBe("ROLLBACK");
  });

  it("activates from current completeness rather than a stale pre-hold status", async () => {
    const repaired = harness({
      lifecycleStatus: "suspended",
      preHoldProfileStatus: "incomplete",
      completenessReasons: [],
    });
    const repairedRepository = createPgPlatformPropertyLifecycleCommandRepository({
      pool: repaired.pool,
    });
    await expect(
      repairedRepository.changeStatus({
        propertyId,
        expectedLifecycleRevision: 4,
        status: "active",
        reason: "Canonical profile repaired",
        idempotencyKey: "activate-repaired",
        audit,
      }),
    ).resolves.toMatchObject({ lifecycleStatus: "active" });

    const stale = harness({
      lifecycleStatus: "suspended",
      preHoldProfileStatus: "complete",
      completenessReasons: ["media"],
    });
    const staleRepository = createPgPlatformPropertyLifecycleCommandRepository({
      pool: stale.pool,
    });
    await expect(
      staleRepository.changeStatus({
        propertyId,
        expectedLifecycleRevision: 4,
        status: "active",
        reason: "Attempt unsafe activation",
        idempotencyKey: "activate-stale",
        audit,
      }),
    ).rejects.toMatchObject({ code: "profile_incomplete" });
  });

  it("returns the locked impact when retirement has active blockers", async () => {
    const target = harness({ activeBookings: 2 });
    const repository = createPgPlatformPropertyLifecycleCommandRepository({ pool: target.pool });

    await expect(
      repository.retire({
        propertyId,
        expectedLifecycleRevision: 4,
        reason: "End the property account",
        idempotencyKey: "retire-1",
        audit,
      }),
    ).rejects.toMatchObject({
      code: "retirement_blocked",
      impact: {
        canRetire: false,
        blockers: [{ code: "active_bookings", count: 2 }],
      },
    });

    expect(target.sql()).toContain("FOR UPDATE");
    expect(target.sql()).not.toContain("UPDATE hotel_catalog.properties SET lifecycle_status");
    expect(target.sql()).not.toContain("INSERT INTO platform.idempotency_keys");
  });

  it("replays the completed result without applying the transition twice", async () => {
    const replay = {
      contractVersion: "platform-property-lifecycle.v1",
      propertyId,
      lifecycleStatus: "suspended",
      lifecycleRevision: 5,
    } as const;
    const target = harness({ replay });
    const repository = createPgPlatformPropertyLifecycleCommandRepository({ pool: target.pool });

    await expect(
      repository.changeStatus({
        propertyId,
        expectedLifecycleRevision: 4,
        status: "suspended",
        reason: "Owner requested a temporary hold",
        idempotencyKey: "status-1",
        audit,
      }),
    ).resolves.toEqual(replay);

    expect(target.sql()).not.toContain("UPDATE hotel_catalog.properties SET");
    expect(target.sql()).not.toContain("INSERT INTO platform.product_audit_events");
  });

  it("denies an invalid platform actor before touching property or idempotency state", async () => {
    const target = harness({ authorized: false });
    const repository = createPgPlatformPropertyLifecycleCommandRepository({ pool: target.pool });

    await expect(
      repository.changeStatus({
        propertyId,
        expectedLifecycleRevision: 4,
        status: "suspended",
        reason: "Attempted hold",
        idempotencyKey: "status-denied",
        audit,
      }),
    ).rejects.toMatchObject({ code: "invalid_platform_scope" });

    expect(target.sql()).not.toContain("FROM hotel_catalog.properties");
    expect(target.sql()).not.toContain("platform.idempotency_keys");
  });
});

function harness(
  options: {
    authorized?: boolean;
    lifecycleStatus?: "active" | "suspended" | "retired";
    preHoldProfileStatus?: string | null;
    completenessReasons?: string[];
    activeBookings?: number;
    replay?: object;
  } = {},
) {
  const statements: Array<{ sql: string; values?: readonly unknown[] }> = [];
  const client = {
    async query<T>(sql: string, values?: readonly unknown[]) {
      statements.push({ sql: sql.trim(), values });
      if (sql.includes("FROM identity.organizations organization")) {
        return rows<T>(options.authorized === false ? [] : ([{ id: "membership" }] as T[]));
      }
      if (sql.includes("idempotency_metadata->'result'")) {
        if (!options.replay) return rows<T>([]);
        return rows<T>([
          {
            id: "44444444-4444-4444-8444-444444444444",
            status: "completed",
            requestFingerprintHash:
              "2f93b286a4e37f8e3dd45a20026832699413b0ca6d2b10af24f6bc03b0c3af43",
            resultJson: options.replay,
          } as T,
        ]);
      }
      if (
        sql.includes("FROM hotel_catalog.properties") &&
        sql.includes("pre_hold_profile_status")
      ) {
        return rows<T>([
          {
            lifecycleStatus: options.lifecycleStatus ?? "active",
            lifecycleRevision: 4,
            profileStatus: "complete",
            preHoldProfileStatus: options.preHoldProfileStatus ?? null,
            completenessReasons: options.completenessReasons ?? [],
          } as T,
        ]);
      }
      if (sql.includes("WITH property AS")) return rows<T>([impactRow(options) as T]);
      if (sql.includes("INSERT INTO platform.idempotency_keys")) {
        return rows<T>([{ id: "44444444-4444-4444-8444-444444444444" } as T]);
      }
      if (sql.includes("RETURNING lifecycle_revision")) {
        return rows<T>([{ lifecycleRevision: 5 } as T]);
      }
      if (sql.includes("UPDATE platform.idempotency_keys SET status = 'completed'")) {
        return rows<T>([{} as T]);
      }
      return rows<T>([]);
    },
    release() {},
  };
  return {
    pool: {
      async connect() {
        return client;
      },
      async end() {},
    },
    statements,
    sql: () => statements.map(({ sql }) => sql).join("\n"),
  };
}

function impactRow(options: { activeBookings?: number; lifecycleStatus?: string }) {
  return {
    propertyId,
    lifecycleStatus: options.lifecycleStatus ?? "active",
    lifecycleRevision: 4,
    linkedOrganizations: 1,
    activeEntitlements: 2,
    suspendedEntitlements: 0,
    totalBookings: options.activeBookings ?? 0,
    activeBookings: options.activeBookings ?? 0,
    roomTypes: 1,
    rooms: 4,
    totalPayments: 0,
    unresolvedPayments: 0,
    totalPayouts: 0,
    openPayouts: 0,
    billingEntitlements: 0,
    mediaObjects: 2,
    marketplaceActive: true,
    distributionStatus: "public",
    bookingRevisionActive: true,
    connectedChannels: 0,
  };
}

function rows<T>(values: T[]) {
  return { rows: values, rowCount: values.length };
}
