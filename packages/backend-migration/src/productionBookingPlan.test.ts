import { describe, expect, it } from "vitest";

import { createProductionBookingContext } from "./productionBookingContext.js";
import { reconcileProductionBookingRecords } from "./productionBookingPlan.js";
import type {
  BookingTargetRecord,
  ProductionBookingTargetState,
} from "./productionBookingTypes.js";

describe("production Booking reconciliation", () => {
  it("inserts absent records and adopts identical existing records", () => {
    const candidate = record();
    const inserted = reconcileProductionBookingRecords(context(), [candidate]);
    expect(inserted.counts).toMatchObject({ inserts: 1, updates: 0 });
    expect(inserted.writes).toEqual([candidate]);
    expect(inserted.parity.targetTableCounts).toEqual({ "booking.guest_bookings": 1 });

    const adopted = reconcileProductionBookingRecords(
      context({ records: [existing(candidate.row, "2026-08-01T00:00:00Z")] }),
      [candidate],
    );
    expect(adopted.counts.unchanged).toBe(1);
    expect(adopted.writes).toEqual([]);
    expect(adopted.provenance).toHaveLength(1);
  });

  it("preserves newer target state instead of replaying stale legacy state", () => {
    const candidate = record();
    const plan = reconcileProductionBookingRecords(
      context({ records: [existing({ value: "target" }, "2026-09-01T00:00:00Z")] }),
      [candidate],
    );
    expect(plan.counts.preservedNewerTarget).toBe(1);
    expect(plan.writes).toEqual([]);
    expect(plan.provenance).toEqual([]);
    expect(plan.blockers).toEqual([]);
  });

  it("preserves a target deletion after prior migration", () => {
    const candidate = record();
    const plan = reconcileProductionBookingRecords(
      context({ provenance: [provenance(candidate)] }),
      [candidate],
    );
    expect(plan.counts.preservedTargetDeletions).toBe(1);
    expect(plan.writes).toEqual([]);
  });

  it("blocks equal-time and immutable conflicts", () => {
    const mutable = reconcileProductionBookingRecords(
      context({ records: [existing({ value: "target" }, "2026-08-02T00:00:00Z")] }),
      [record()],
    );
    expect(mutable.blockers[0]?.code).toBe("TARGET_EQUAL_TIME_CONFLICT");

    const immutableCandidate = { ...record(), mutable: false };
    const immutable = reconcileProductionBookingRecords(
      context({
        records: [existing({ value: "target" }, "2026-08-03T00:00:00Z")],
        provenance: [{ ...provenance(immutableCandidate), sourceChecksum: "b".repeat(64) }],
      }),
      [immutableCandidate],
    );
    expect(immutable.blockers[0]?.code).toBe("IMMUTABLE_SOURCE_CHANGED");
  });

  it("keeps target edits made after the previous migration when source also changed", () => {
    const candidate = record();
    const plan = reconcileProductionBookingRecords(
      context({
        records: [existing({ value: "target-edit" }, "2026-08-04T00:00:00Z")],
        provenance: [{ ...provenance(candidate), sourceChecksum: "b".repeat(64) }],
      }),
      [candidate],
    );
    expect(plan.counts.preservedNewerTarget).toBe(1);
    expect(plan.writes).toEqual([]);
    expect(plan.provenance).toEqual([]);
  });

  it("does not trust unchanged provenance when the target row differs", () => {
    const candidate = record();
    const stale = reconcileProductionBookingRecords(
      context({
        records: [existing({ value: "unexpected" }, "2026-08-03T00:00:00Z")],
        provenance: [provenance(candidate)],
      }),
      [candidate],
    );
    expect(stale.blockers[0]?.code).toBe("TARGET_PROVENANCE_MISMATCH");

    const newer = reconcileProductionBookingRecords(
      context({
        records: [existing({ value: "target-edit" }, "2026-08-04T00:00:00Z")],
        provenance: [provenance(candidate)],
      }),
      [candidate],
    );
    expect(newer.counts.preservedNewerTarget).toBe(1);
    expect(newer.provenance).toEqual([]);
  });

  it("compares mapped columns using PostgreSQL JSON normalization", () => {
    const candidate = {
      ...record(),
      row: {
        amount: "12.50",
        occurredAt: "2026-08-02T00:00:00.000Z",
        optionalValue: undefined,
        nested: { count: 2 },
      },
    };
    const plan = reconcileProductionBookingRecords(
      context({
        records: [
          existing(
            {
              amount: 12.5,
              occurredAt: "2026-08-02T00:00:00+00:00",
              optionalValue: null,
              nested: { count: 2, databaseDefault: true },
              databaseDefault: true,
            },
            "2026-08-02T00:00:00Z",
          ),
        ],
      }),
      [candidate],
    );
    expect(plan.counts.unchanged).toBe(1);
    expect(plan.blockers).toEqual([]);
  });
});

function record(): BookingTargetRecord {
  return {
    targetProduct: "booking",
    targetTable: "guest_bookings",
    targetId: "13550000-0000-4000-8000-000000000041",
    sourceDatabase: "pms",
    sourceTable: "bookings",
    sourceId: "13550000-0000-4000-8000-000000000041",
    sourceChecksum: "a".repeat(64),
    sourceUpdatedAt: "2026-08-02T00:00:00Z",
    mutable: true,
    row: { value: "source" },
  };
}

function existing(row: Record<string, unknown>, updatedAt: string) {
  return {
    targetProduct: "booking",
    targetTable: "guest_bookings",
    targetId: "13550000-0000-4000-8000-000000000041",
    updatedAt,
    row,
  };
}

function provenance(candidate: BookingTargetRecord) {
  return {
    sourceDatabase: candidate.sourceDatabase,
    sourceTable: candidate.sourceTable,
    sourceId: candidate.sourceId,
    targetProduct: candidate.targetProduct,
    targetTable: candidate.targetTable,
    targetId: candidate.targetId,
    sourceChecksum: candidate.sourceChecksum,
    sourceUpdatedAt: candidate.sourceUpdatedAt,
    lastMigratedAt: "2026-08-03T00:00:00Z",
  };
}

function context(values: Partial<ProductionBookingTargetState> = {}) {
  return createProductionBookingContext({
    sourceRunId: "vay1351-0123456789abcdef01234567",
    completedAt: "2026-08-30T00:00:00.000Z",
    rows: [],
    target: { propertyLinks: [], propertySlugs: [], records: [], provenance: [], ...values },
  });
}
