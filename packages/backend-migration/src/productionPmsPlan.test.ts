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
  });
});

function record(mutable: boolean): PmsTargetRecord {
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

function buildContext(target: {
  records: PmsBuildContext["target"]["records"];
  provenance: PmsBuildContext["target"]["provenance"];
}): PmsBuildContext {
  return createProductionPmsContext({
    sourceRunId: "vay1351-000000000000000000000000",
    completedAt: "2026-08-30T00:00:00Z",
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
