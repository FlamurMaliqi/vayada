import { describe, expect, it } from "vitest";

import {
  runProductionCatalogPrerequisiteTransaction,
  runProductionCatalogTransaction,
  type ProductionCatalogMigrationServices,
} from "./productionCatalogMigration.js";
import type { ProductionCatalogPlan } from "./productionCatalogPlan.js";
import { stableCatalogId } from "./productionCatalogValues.js";

const RUN = "vay1351-0123456789abcdef01234567";

describe("production catalog migration transaction", () => {
  it("always rolls a dry run back without invoking writers", async () => {
    const log: string[] = [];
    const result = await runProductionCatalogTransaction(
      new TransactionClient(log) as never,
      { sourceRunId: RUN, mode: "dry-run" },
      services(log, plan()),
    );
    expect(result).toMatchObject({ applied: false, sourceRunId: RUN });
    expect(log).toEqual(["BEGIN", "snapshot", "target", "plan", "ROLLBACK"]);
  });

  it("rolls a blocked apply back before invoking writers", async () => {
    const log: string[] = [];
    const blocked = plan();
    blocked.blockers.push({ code: "STALE", source: "catalog", sourceId: "x", message: "x" });
    const result = await runProductionCatalogTransaction(
      new TransactionClient(log) as never,
      { sourceRunId: RUN, mode: "apply" },
      services(log, blocked),
    );
    expect(result.applied).toBe(false);
    expect(log).toEqual(["BEGIN", "SET", "LOCK", "snapshot", "target", "plan", "ROLLBACK"]);
  });

  it("commits only after guarded writes, target replan, and public projection", async () => {
    const log: string[] = [];
    const expected = plan();
    const result = await runProductionCatalogTransaction(
      new TransactionClient(log) as never,
      { sourceRunId: RUN, mode: "apply" },
      services(log, expected),
    );
    expect(result.applied).toBe(true);
    expect(log).toEqual([
      "BEGIN",
      "SET",
      "LOCK",
      "snapshot",
      "target",
      "plan",
      "core:complete",
      "content",
      "presentation",
      "target",
      "plan",
      "projection",
      "COMMIT",
    ]);
  });

  it("writes only catalog prerequisites while media blockers remain", async () => {
    const log: string[] = [];
    const expected = plan();
    expected.blockers.push({
      code: "UNRESOLVED_MEDIA_REFERENCE",
      source: "booking.booking_hotels",
      sourceId: "hotel-1",
      message: "media must be imported first",
    });
    const verified = { ...expected, counts: { ...expected.counts, writes: 0 } };

    const result = await runProductionCatalogPrerequisiteTransaction(
      new TransactionClient(log) as never,
      { sourceRunId: RUN, mode: "apply" },
      services(log, expected, verified),
    );

    expect(result).toMatchObject({ applied: true, blockers: [] });
    expect(result.remainingMediaBlockers).toEqual(expected.blockers);
    expect(log).toEqual([
      "BEGIN",
      "SET",
      "LOCK",
      "snapshot",
      "target",
      "plan",
      "core:prerequisites",
      "content",
      "target",
      "plan",
      "COMMIT",
    ]);
    expect(log).not.toContain("presentation");
    expect(log).not.toContain("projection");
  });

  it("rolls back when stored state does not reproduce the plan", async () => {
    const log: string[] = [];
    const expected = plan();
    const mismatched = { ...expected, checksum: "b".repeat(64) };
    await expect(
      runProductionCatalogTransaction(
        new TransactionClient(log) as never,
        { sourceRunId: RUN, mode: "apply" },
        services(log, expected, mismatched),
      ),
    ).rejects.toThrow("Post-write catalog verification");
    expect(log.at(-1)).toBe("ROLLBACK");
    expect(log).not.toContain("projection");
  });

  it("includes deterministic private property IDs in the initial target read", async () => {
    const log: string[] = [];
    const pmsHotel = "22222222-2222-4222-8222-222222222222";
    const marketplaceHotel = "33333333-3333-4333-8333-333333333333";
    const targetReads: string[][] = [];
    const configured = services(log, plan());
    configured.readSnapshot = async () => [
      {
        sourceDatabase: "pms",
        sourceTable: "hotels",
        rowOrdinal: 1,
        data: { id: pmsHotel },
      },
      {
        sourceDatabase: "marketplace",
        sourceTable: "hotel_profiles",
        rowOrdinal: 1,
        data: { id: marketplaceHotel },
      },
    ];
    configured.readTarget = async (_client, propertyIds) => {
      targetReads.push(propertyIds);
      return emptyTarget();
    };

    await runProductionCatalogTransaction(
      new TransactionClient(log) as never,
      { sourceRunId: RUN, mode: "dry-run" },
      configured,
    );

    expect(targetReads).toEqual([
      [
        stableCatalogId("private-property", `marketplace:hotel_profiles:${marketplaceHotel}`),
        stableCatalogId("private-property", `pms:hotels:${pmsHotel}`),
      ].sort(),
    ]);
  });
});

class TransactionClient {
  constructor(private readonly log: string[]) {}
  async query(sql: string): Promise<{ rows: never[] }> {
    this.log.push(sql.split(" ")[0]!);
    return { rows: [] };
  }
}
function services(
  log: string[],
  first: ProductionCatalogPlan,
  verified = { ...first, counts: { ...first.counts, writes: 0 } },
): ProductionCatalogMigrationServices {
  let builds = 0;
  return {
    readSnapshot: async () => {
      log.push("snapshot");
      return [];
    },
    readTarget: async () => {
      log.push("target");
      return emptyTarget();
    },
    buildPlan: () => {
      log.push("plan");
      return builds++ === 0 ? first : verified;
    },
    writeCore: async (_client, _writes, _links, _runId, phase) => {
      log.push(`core:${phase ?? "complete"}`);
      return { properties: 0, sourceLinks: 0, slugs: 0, locations: 0 };
    },
    writeContent: async () => {
      log.push("content");
      return { profiles: 0, amenities: 0, contacts: 0, policies: 0 };
    },
    writePresentation: async () => {
      log.push("presentation");
      return { domains: 0, media: 0 };
    },
    rebuildPublicProjection: async () => {
      log.push("projection");
      return 0;
    },
  };
}
function plan(): ProductionCatalogPlan {
  return {
    sourceLinks: [],
    quarantinedSources: [],
    propertyIds: [],
    writes: {
      properties: [],
      slugs: [],
      domains: [],
      locations: [],
      profiles: [],
      amenities: [],
      contacts: [],
      policies: [],
      media: [],
    },
    preservedTarget: [],
    blockers: [],
    counts: {
      properties: 0,
      sourceLinks: 0,
      quarantinedSourceRows: 0,
      slugs: 0,
      domains: 0,
      locations: 0,
      profiles: 0,
      amenities: 0,
      contacts: 0,
      policies: 0,
      media: 0,
      writes: 0,
      preservedTarget: 0,
    },
    checksum: "a".repeat(64),
  };
}
function emptyTarget() {
  return {
    properties: [],
    sourceLinks: [],
    ownerLinks: [],
    slugs: [],
    domains: [],
    locations: [],
    profiles: [],
    amenities: [],
    contacts: [],
    policies: [],
    media: [],
    mediaObjects: [],
    ownerRevisions: [],
  };
}
