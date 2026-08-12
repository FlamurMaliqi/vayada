import type { QueryResultRow } from "pg";
import { describe, expect, it, vi } from "vitest";

import {
  createTargetPmsInventoryPublicOfferProjection,
  PROJECT_PMS_INVENTORY_TO_PUBLIC_OFFERS,
  type TargetPmsInventoryPublicOfferProjectionOptions,
} from "./domains/pmsInventoryPublicOfferProjection.js";

const propertyId = "f6853000-0000-0000-0000-000000000001";

describe("PMS inventory public offer projection", () => {
  it("keeps PMS-first inventory events pending until a public profile exists", async () => {
    const target = projectionPool({ profileAvailable: false });
    const projector = createTargetPmsInventoryPublicOfferProjection({
      connectionString: "postgresql://unused",
      pool: target.pool,
      now: () => new Date("2026-08-14T17:00:00.000Z"),
    });

    await expect(projector.projectPending({ propertyId })).resolves.toEqual({
      profileAvailable: false,
      pendingEvents: 1,
      projectedOfferDays: 0,
    });
    expect(target.queries.some((query) => query.includes("public_room_offer_snapshots"))).toBe(
      false,
    );
    expect(target.queries.some((query) => query.includes("SET status = 'published'"))).toBe(false);
  });

  it("projects stock, seasonal rates, and currency once then publishes the durable event", async () => {
    const target = projectionPool({ profileAvailable: true, projectedOfferDays: 366 });
    const projector = createTargetPmsInventoryPublicOfferProjection({
      connectionString: "postgresql://unused",
      pool: target.pool,
      now: () => new Date("2026-08-14T17:00:00.000Z"),
    });

    await expect(projector.projectPending({ propertyId })).resolves.toEqual({
      profileAvailable: true,
      pendingEvents: 1,
      projectedOfferDays: 366,
    });
    expect(target.publishedEventIds).toEqual(["f6855f00-0000-0000-0000-000000000001"]);
    expect(PROJECT_PMS_INVENTORY_TO_PUBLIC_OFFERS).toContain("inventory.available_count");
    expect(PROJECT_PMS_INVENTORY_TO_PUBLIC_OFFERS).toContain(
      "hashtextextended(concat('pms-inventory:', $1::text), 0)",
    );
    expect(PROJECT_PMS_INVENTORY_TO_PUBLIC_OFFERS).toContain("AS effective_rate");
    expect(PROJECT_PMS_INVENTORY_TO_PUBLIC_OFFERS).toContain("rate_plan.currency");
    expect(PROJECT_PMS_INVENTORY_TO_PUBLIC_OFFERS).toContain("'rateType', input.rate_type");
    expect(PROJECT_PMS_INVENTORY_TO_PUBLIC_OFFERS).toContain(
      "input.capabilities -> 'paymentMethods'",
    );
    expect(PROJECT_PMS_INVENTORY_TO_PUBLIC_OFFERS).not.toContain(
      "input.capabilities ->> 'payAtProperty'",
    );
    expect(PROJECT_PMS_INVENTORY_TO_PUBLIC_OFFERS).toContain("profile.policies");
    expect(PROJECT_PMS_INVENTORY_TO_PUBLIC_OFFERS).toContain("input.policies,\n    CASE");
    expect(PROJECT_PMS_INVENTORY_TO_PUBLIC_OFFERS).toContain(
      "input.stay_date >= ($2::timestamptz AT TIME ZONE input.timezone)::date",
    );
    expect(PROJECT_PMS_INVENTORY_TO_PUBLIC_OFFERS).toContain(
      "input.stay_date < ($2::timestamptz AT TIME ZONE input.timezone)::date THEN 'closed'",
    );
    expect(PROJECT_PMS_INVENTORY_TO_PUBLIC_OFFERS).toContain("input.inventory_status = 'closed'");
    expect(PROJECT_PMS_INVENTORY_TO_PUBLIC_OFFERS).toContain(
      "ON CONFLICT (property_id, public_offer_key, stay_date) DO UPDATE",
    );
  });

  it("does not duplicate stock or offers after the event has already been published", async () => {
    const target = projectionPool({ profileAvailable: true, projectedOfferDays: 366 });
    const projector = createTargetPmsInventoryPublicOfferProjection({
      connectionString: "postgresql://unused",
      pool: target.pool,
      now: () => new Date("2026-08-14T17:00:00.000Z"),
    });

    const first = await projector.projectPending({ propertyId });
    const replay = await projector.projectPending({ propertyId });

    expect(first.projectedOfferDays).toBe(366);
    expect(replay).toEqual({
      profileAvailable: false,
      pendingEvents: 0,
      projectedOfferDays: 0,
    });
    expect(
      target.queries.filter((query) =>
        query.includes("INSERT INTO distribution.public_room_offer_snapshots"),
      ),
    ).toHaveLength(1);
  });

  it("backs off a failed public-bookability refresh and publishes it on a later retry", async () => {
    let currentTime = new Date("2026-08-14T17:00:00.000Z");
    const target = projectionPool({ profileAvailable: true, projectedOfferDays: 2 });
    const refreshPublicBookability = vi
      .fn<(command: { propertyId: string }) => Promise<void>>()
      .mockRejectedValueOnce(new Error("publication unavailable"))
      .mockResolvedValue(undefined);
    const projector = createTargetPmsInventoryPublicOfferProjection({
      connectionString: "postgresql://unused",
      pool: target.pool,
      now: () => currentTime,
      random: () => 0,
      refreshPublicBookability,
    });

    await expect(projector.runRetryBatch()).resolves.toMatchObject({
      processedProperties: 1,
      failedEvents: 1,
      exhaustedEvents: 0,
      publishedEvents: 0,
    });
    expect(target.state).toMatchObject({
      status: "failed",
      attemptsCount: 1,
      availableAt: "2026-08-14T17:00:15.000Z",
    });
    expect(target.publishedEventIds).toEqual([]);

    currentTime = new Date("2026-08-14T17:00:10.000Z");
    await expect(projector.runRetryBatch()).resolves.toMatchObject({
      processedProperties: 0,
      failedEvents: 0,
    });

    currentTime = new Date("2026-08-14T17:00:16.000Z");
    await expect(projector.runRetryBatch()).resolves.toMatchObject({
      processedProperties: 1,
      publishedEvents: 1,
      failedEvents: 0,
    });
    expect(target.state).toMatchObject({ status: "published", attemptsCount: 2 });
    expect(refreshPublicBookability).toHaveBeenCalledTimes(2);
  });

  it("dead-letters a final failed attempt exactly once", async () => {
    const target = projectionPool({
      profileAvailable: true,
      projectionError: new Error("database unavailable"),
      maxAttempts: 1,
    });
    const projector = createTargetPmsInventoryPublicOfferProjection({
      connectionString: "postgresql://unused",
      pool: target.pool,
      now: () => new Date("2026-08-14T17:00:00.000Z"),
    });

    await expect(projector.runRetryBatch()).resolves.toMatchObject({
      failedEvents: 1,
      exhaustedEvents: 1,
    });
    await expect(projector.runRetryBatch()).resolves.toMatchObject({
      processedProperties: 0,
      exhaustedEvents: 0,
    });
    expect(target.state).toMatchObject({ status: "failed", attemptsCount: 1 });
    expect(target.deadLetterEventIds).toEqual(["f6855f00-0000-0000-0000-000000000001"]);
  });

  it("recovers and dead-letters an expired final-attempt lease", async () => {
    const target = projectionPool({
      profileAvailable: true,
      status: "leased",
      attemptsCount: 1,
      maxAttempts: 1,
      leasedUntil: "2026-08-14T16:59:00.000Z",
    });
    const projector = createTargetPmsInventoryPublicOfferProjection({
      connectionString: "postgresql://unused",
      pool: target.pool,
      now: () => new Date("2026-08-14T17:00:00.000Z"),
    });

    await expect(projector.runRetryBatch()).resolves.toMatchObject({
      processedProperties: 0,
      failedEvents: 1,
      exhaustedEvents: 1,
    });
    expect(target.state).toMatchObject({ status: "failed", attemptsCount: 1 });
    expect(target.deadLetterEventIds).toEqual(["f6855f00-0000-0000-0000-000000000001"]);
  });
});

function projectionPool(options: {
  profileAvailable: boolean;
  projectedOfferDays?: number;
  projectionError?: Error;
  status?: "pending" | "leased" | "failed" | "published";
  attemptsCount?: number;
  maxAttempts?: number;
  leasedUntil?: string | null;
}) {
  const outboxEventId = "f6855f00-0000-0000-0000-000000000001";
  const state = {
    status: options.status ?? ("pending" as "pending" | "leased" | "failed" | "published"),
    attemptsCount: options.attemptsCount ?? 0,
    maxAttempts: options.maxAttempts ?? 5,
    availableAt: "2026-08-14T00:00:00.000Z",
    leasedUntil: options.leasedUntil ?? null,
    leaseToken: options.status === "leased" ? "expired-lease-token" : null,
  };
  const queries: string[] = [];
  const publishedEventIds: string[] = [];
  const deadLetterEventIds: string[] = [];
  const release = vi.fn();
  const query = async <T extends QueryResultRow>(text: string, values?: readonly unknown[]) => {
    queries.push(text);
    if (text.includes("outbox.leased_until <= $1::timestamptz")) {
      const recoveredAt = String(values?.[0]);
      if (
        state.status === "leased" &&
        state.leasedUntil &&
        new Date(state.leasedUntil) <= new Date(recoveredAt)
      ) {
        state.status = "failed";
        state.leasedUntil = null;
        state.leaseToken = null;
        if (state.attemptsCount < state.maxAttempts) state.availableAt = recoveredAt;
        return rows([
          { outboxEventId, attemptsCount: state.attemptsCount, maxAttempts: state.maxAttempts },
        ] as unknown as T[]);
      }
      return rows([] as T[]);
    }
    if (text.includes("WITH candidate_event AS")) {
      const claimedAt = String(values?.[0]);
      const includeNotDue = values?.[5] === true;
      const due = new Date(state.availableAt) <= new Date(claimedAt);
      const claimable =
        state.attemptsCount < state.maxAttempts &&
        ((state.status === "pending" && (includeNotDue || due)) ||
          (state.status === "failed" && due));
      if (!claimable) return rows([] as T[]);
      state.status = "leased";
      state.attemptsCount += 1;
      state.leasedUntil = String(values?.[2]);
      state.leaseToken = String(values?.[4]);
      return rows([
        {
          outboxEventId,
          propertyId,
          attemptsCount: state.attemptsCount,
          maxAttempts: state.maxAttempts,
        },
      ] as unknown as T[]);
    }
    if (
      text.includes("FROM platform.outbox_events outbox") &&
      text.includes("publicOfferProjection,leaseToken") &&
      text.includes("FOR UPDATE")
    ) {
      return rows(
        state.status === "leased" && state.leaseToken === values?.[2]
          ? ([
              {
                outboxEventId,
                propertyId,
                attemptsCount: state.attemptsCount,
                maxAttempts: state.maxAttempts,
              },
            ] as unknown as T[])
          : ([] as T[]),
      );
    }
    if (
      text.includes("FROM distribution.public_hotel_bookability_profiles") &&
      !text.includes("INSERT INTO distribution.public_room_offer_snapshots")
    ) {
      return rows(options.profileAvailable ? ([{ exists: 1 }] as unknown as T[]) : ([] as T[]));
    }
    if (text.includes("INSERT INTO distribution.public_room_offer_snapshots")) {
      if (options.projectionError) throw options.projectionError;
      return rows(
        Array.from({ length: options.projectedOfferDays ?? 0 }, (_, index) => ({
          snapshotId: `snapshot-${index}`,
        })) as unknown as T[],
      );
    }
    if (text.includes("SET status = 'pending'")) {
      if (state.status === "leased" && state.leaseToken === values?.[5]) {
        state.status = "pending";
        state.attemptsCount = Math.max(0, state.attemptsCount - 1);
        state.availableAt = String(values?.[3]);
        state.leasedUntil = null;
        state.leaseToken = null;
      }
      return rows([] as T[]);
    }
    if (text.includes("SET status = 'published'")) {
      if (state.status === "leased" && state.leaseToken === values?.[4]) {
        state.status = "published";
        state.leasedUntil = null;
        state.leaseToken = null;
        publishedEventIds.push(...((values?.[1] as string[]) ?? []));
        return rows([{ acknowledged: true }] as unknown as T[]);
      }
      return rows([] as T[]);
    }
    if (text.includes("SET status = 'failed'")) {
      if (state.status === "leased" && state.leaseToken === values?.[7]) {
        state.status = "failed";
        if (state.attemptsCount < state.maxAttempts) state.availableAt = String(values?.[3]);
        state.leasedUntil = null;
        state.leaseToken = null;
        return rows([
          { outboxEventId, attemptsCount: state.attemptsCount, maxAttempts: state.maxAttempts },
        ] as unknown as T[]);
      }
      return rows([] as T[]);
    }
    if (text.includes("INSERT INTO platform.dead_letter_events")) {
      for (const eventId of (values?.[0] as string[]) ?? []) {
        if (!deadLetterEventIds.includes(eventId)) deadLetterEventIds.push(eventId);
      }
      return rows([] as T[]);
    }
    return rows([] as T[]);
  };
  const pool = {
    async connect() {
      return { query, release };
    },
    end: vi.fn(async () => undefined),
  } as unknown as NonNullable<TargetPmsInventoryPublicOfferProjectionOptions["pool"]>;
  return { pool, deadLetterEventIds, publishedEventIds, queries, state };
}

function rows<T extends QueryResultRow>(items: T[]) {
  return { rows: items, rowCount: items.length };
}
