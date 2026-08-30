import { describe, expect, it } from "vitest";

import { createProductionPmsContext } from "./productionPmsContext.js";
import { reconcileProductionPmsRecords } from "./productionPmsPlan.js";
import type { PmsBuildContext, PmsTargetRecord } from "./productionPmsTypes.js";

describe("production PMS reconciliation", () => {
  it("does not overwrite a newer target state from stale legacy source", () => {
    const candidate = record(true);
    const context = buildContext({
      records: [
        {
          targetProduct: "pms",
          targetTable: "room_types",
          targetId: "target",
          updatedAt: "2026-09-02T00:00:00Z",
          row: { id: "target", name: "Target-owned name" },
        },
      ],
      provenance: [link(candidate, "2026-09-01T00:00:00Z")],
    });
    const plan = reconcileProductionPmsRecords(context, [candidate]);
    expect(plan.blockers).toEqual([]);
    expect(plan.writes).toEqual([]);
    expect(plan.provenance).toEqual([]);
    expect(plan.counts.preservedNewerTarget).toBe(1);
  });

  it("does not resurrect a target-side deletion", () => {
    const candidate = record(true);
    const context = buildContext({
      records: [],
      provenance: [link(candidate, "2026-09-01T00:00:00Z")],
    });
    const plan = reconcileProductionPmsRecords(context, [candidate]);
    expect(plan.blockers).toEqual([]);
    expect(plan.writes).toEqual([]);
    expect(plan.provenance).toEqual([]);
    expect(plan.counts.preservedTargetDeletions).toBe(1);
  });

  it("blocks a first-run newer target until ownership has a durable disposition", () => {
    const candidate = record(true);
    const context = buildContext({
      records: [
        {
          targetProduct: "pms",
          targetTable: "room_types",
          targetId: "target",
          updatedAt: "2026-09-02T00:00:00Z",
          row: { id: "target", name: "Target-owned name" },
        },
      ],
      provenance: [],
    });
    const plan = reconcileProductionPmsRecords(context, [candidate]);
    expect(plan.blockers).toContainEqual(
      expect.objectContaining({ code: "TARGET_NEWER_WITHOUT_PROVENANCE" }),
    );
    expect(plan.writes).toEqual([]);
    expect(plan.provenance).toEqual([]);
  });

  it("blocks an immutable conflict instead of accepting ambiguous history", () => {
    const candidate = record(false);
    const context = buildContext({
      records: [
        {
          targetProduct: "platform",
          targetTable: "product_audit_events",
          targetId: "target",
          updatedAt: null,
          row: { id: "target", action: "different" },
        },
      ],
      provenance: [],
    });
    const plan = reconcileProductionPmsRecords(context, [candidate]);
    expect(plan.blockers).toContainEqual(
      expect.objectContaining({ code: "TARGET_IMMUTABLE_CONFLICT" }),
    );
    expect(plan.writes).toEqual([]);
  });

  it("rejects duplicate source mappings to one target row", () => {
    const candidate = record(true);
    const context = buildContext({ records: [], provenance: [] });
    const plan = reconcileProductionPmsRecords(context, [candidate, candidate]);
    expect(plan.blockers).toContainEqual(
      expect.objectContaining({ code: "DUPLICATE_TARGET_RECORD" }),
    );
    expect(plan.records).toEqual([]);
    expect(plan.writes).toEqual([]);
    expect(plan.provenance).toEqual([]);
  });

  it("advances migration freshness after updates so later source revisions remain writable", () => {
    const first = record(true, {
      sourceChecksum: "a".repeat(64),
      sourceUpdatedAt: "2026-08-30T00:00:00Z",
      row: { id: "target", name: "First" },
    });
    const second = record(true, {
      sourceChecksum: "b".repeat(64),
      sourceUpdatedAt: "2026-08-31T00:00:00Z",
      row: { id: "target", name: "Second" },
    });
    const secondPlan = reconcileProductionPmsRecords(
      buildContext(
        {
          records: [existing(first, "2026-08-30T00:00:00Z")],
          provenance: [link(first, "2026-08-30T00:00:00Z")],
        },
        "2026-09-01T00:00:00Z",
      ),
      [second],
    );
    expect(secondPlan.writes).toEqual([second]);
    expect(secondPlan.provenance[0]?.lastMigratedAt).toBe("2026-09-01T00:00:00Z");

    const third = record(true, {
      sourceChecksum: "c".repeat(64),
      sourceUpdatedAt: "2026-09-02T00:00:00Z",
      row: { id: "target", name: "Third" },
    });
    const thirdPlan = reconcileProductionPmsRecords(
      buildContext(
        {
          records: [existing(second, second.sourceUpdatedAt!)],
          provenance: secondPlan.provenance,
        },
        "2026-09-03T00:00:00Z",
      ),
      [third],
    );
    expect(thirdPlan.writes).toEqual([third]);
    expect(thirdPlan.counts.preservedNewerTarget).toBe(0);
  });
});

function record(mutable: boolean, overrides: Partial<PmsTargetRecord> = {}): PmsTargetRecord {
  return {
    targetProduct: mutable ? "pms" : "platform",
    targetTable: mutable ? "room_types" : "product_audit_events",
    targetId: "target",
    sourceDatabase: "pms",
    sourceTable: "room_types",
    sourceId: "source",
    sourceChecksum: "a".repeat(64),
    sourceUpdatedAt: "2026-08-30T00:00:00Z",
    mutable,
    row: { id: "target", name: "Legacy name" },
    ...overrides,
  };
}

function existing(candidate: PmsTargetRecord, updatedAt: string) {
  return {
    targetProduct: candidate.targetProduct,
    targetTable: candidate.targetTable,
    targetId: candidate.targetId,
    updatedAt,
    row: candidate.row,
  };
}

function link(candidate: PmsTargetRecord, lastMigratedAt: string) {
  return {
    sourceDatabase: candidate.sourceDatabase,
    sourceTable: candidate.sourceTable,
    sourceId: candidate.sourceId,
    targetProduct: candidate.targetProduct,
    targetTable: candidate.targetTable,
    targetId: candidate.targetId,
    sourceChecksum: candidate.sourceChecksum,
    sourceUpdatedAt: candidate.sourceUpdatedAt,
    lastMigratedAt,
  };
}

function buildContext(
  target: {
    records: PmsBuildContext["target"]["records"];
    provenance: PmsBuildContext["target"]["provenance"];
  },
  completedAt = "2026-08-30T00:00:00Z",
): PmsBuildContext {
  return createProductionPmsContext({
    sourceRunId: "vay1351-000000000000000000000000",
    completedAt,
    rows: [],
    target: {
      propertyLinks: [],
      bookings: [],
      userIds: [],
      mediaIds: [],
      ...target,
    },
  });
}
