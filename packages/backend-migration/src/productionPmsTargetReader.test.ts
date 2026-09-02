import { describe, expect, it } from "vitest";

import {
  readProductionPmsPrerequisites,
  readProductionPmsTargetState,
} from "./productionPmsTargetReader.js";
import type { PmsTargetRecord } from "./productionPmsTypes.js";

describe("production PMS target reader", () => {
  it("preserves missing booking freshness without throwing", async () => {
    const client = {
      async query(sql: string) {
        if (sql.includes("guest_bookings")) return { rows: [{ updatedAt: null }] };
        return { rows: [] };
      },
    };
    const prerequisites = await readProductionPmsPrerequisites(client as never, "vay1351-run");
    expect(prerequisites.bookings[0]?.updatedAt).toBeNull();
  });

  it("gates catalog and booking prerequisites to the same extraction run", async () => {
    const calls: Array<{ sql: string; values: unknown[] | undefined }> = [];
    const client = {
      async query(sql: string, values?: unknown[]) {
        calls.push({ sql, values });
        if (sql.includes("property_source_links")) return { rows: [] };
        if (sql.includes("guest_bookings")) return { rows: [] };
        return { rows: [] };
      },
    };
    await readProductionPmsPrerequisites(client as never, "vay1351-run");
    expect(calls[0]?.sql).toContain("metadata ->> 'migrationRunId' = $1");
    expect(calls[0]?.sql).toContain("owner.resource_type = 'pms_hotel'");
    expect(calls[0]?.sql).toContain("owner.relationship = 'operator'");
    expect(calls[0]?.sql).toContain("WHEN ownership.link_count > 1 THEN 'ambiguous'");
    expect(calls[1]?.sql).toContain("provenance.last_run_id = $1");
    expect(calls.slice(0, 2).map((call) => call.values)).toEqual([
      ["vay1351-run"],
      ["vay1351-run"],
    ]);
    expect(
      calls.find((call) => call.sql.includes("production_media_migration_quarantines"))?.values,
    ).toEqual(["vay1351-run"]);
  });

  it("loads UUID and composite target rows, provenance, and unique collisions", async () => {
    const calls: string[] = [];
    const client = {
      async query(sql: string) {
        calls.push(sql);
        if (
          sql.includes("FROM pms.room_types AS target_row") &&
          sql.includes("WHERE source_system = 'pms'")
        )
          return {
            rows: [
              {
                targetId: "10000000-0000-4000-a000-000000000099",
                updatedAt: "2026-08-30T00:00:00Z",
                rowData: JSON.stringify({
                  id: "10000000-0000-4000-a000-000000000099",
                  property_id: "20000000-0000-4000-a000-000000000001",
                  source_system: "pms",
                  active: true,
                }),
              },
            ],
          };
        if (sql.includes("FROM pms.inventory_days inventory"))
          return {
            rows: [
              {
                targetId:
                  "20000000-0000-4000-a000-000000000001:10000000-0000-4000-a000-000000000099:2026-08-30",
                updatedAt: "2026-08-30T00:00:00Z",
                rowData: JSON.stringify({
                  property_id: "20000000-0000-4000-a000-000000000001",
                  room_type_id: "10000000-0000-4000-a000-000000000099",
                  stay_date: "2026-08-30",
                }),
              },
            ],
          };
        if (sql.includes("FROM pms.room_types"))
          return {
            rows: [
              {
                targetId: "10000000-0000-4000-a000-000000000001",
                updatedAt: "2026-08-30T00:00:00Z",
                rowData: JSON.stringify({
                  id: "10000000-0000-4000-a000-000000000001",
                  property_id: "20000000-0000-4000-a000-000000000001",
                  source_system: "pms",
                  room_attributes: { legacy_key: "unchanged" },
                }),
              },
            ],
          };
        if (sql.includes("FROM pms.inventory_days")) return { rows: [] };
        if (sql.includes("FROM platform.production_migration_source_links"))
          return {
            rows: [
              {
                sourceDatabase: "pms",
                sourceTable: "room_types",
                sourceId: "10000000-0000-4000-a000-000000000001",
                targetProduct: "pms",
                targetTable: "room_types",
                targetId: "10000000-0000-4000-a000-000000000001",
                sourceChecksum: "a".repeat(64),
                sourceUpdatedAt: "2026-08-30 00:00:00+00",
                lastMigratedAt: "2026-08-30 01:00:00+00",
              },
            ],
          };
        if (sql.includes("WITH requested AS"))
          return {
            rows: [
              {
                code: "TARGET_UNIQUE_CONFLICT",
                source: "pms.rooms",
                sourceId: "collision",
                message: "collision",
              },
            ],
          };
        throw new Error(`Unexpected SQL: ${sql}`);
      },
    };
    const target = await readProductionPmsTargetState(client as never, candidates(), {
      propertyLinks: [],
      bookings: [],
      userIds: [],
      mediaIds: [],
    });
    expect(target.records[0]).toMatchObject({
      targetTable: "room_types",
      row: {
        propertyId: "20000000-0000-4000-a000-000000000001",
        sourceSystem: "pms",
        roomAttributes: { legacy_key: "unchanged" },
      },
    });
    expect(target.records).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          targetTable: "room_types",
          targetId: "10000000-0000-4000-a000-000000000099",
        }),
        expect.objectContaining({
          targetTable: "inventory_days",
          targetId:
            "20000000-0000-4000-a000-000000000001:10000000-0000-4000-a000-000000000099:2026-08-30",
        }),
      ]),
    );
    expect(target.provenance[0]).toMatchObject({
      sourceUpdatedAt: "2026-08-30T00:00:00.000Z",
      lastMigratedAt: "2026-08-30T01:00:00.000Z",
    });
    expect(target.blockers).toHaveLength(1);
    expect(calls.some((sql) => sql.includes("stay_date::text"))).toBe(true);
    expect(calls.find((sql) => sql.includes("WITH requested AS"))).toContain(
      "target.external_property_id",
    );
    expect(calls.find((sql) => sql.includes("WITH requested AS"))).toContain(
      "target.claim_state <> 'active'",
    );
    expect(calls.find((sql) => sql.includes("WITH requested AS"))).toContain(
      "lower(target.name) = lower(requested.name)",
    );
  });

  it("blocks mutable migration-owned targets whose source row disappeared", async () => {
    const client = {
      async query(sql: string) {
        if (sql.includes("FROM pms.room_types")) return { rows: [] };
        if (sql.includes("FROM pms.inventory_days")) return { rows: [] };
        if (sql.includes("FROM pms.rooms")) return { rows: [{ targetId: "stale-room" }] };
        if (sql.includes("FROM platform.production_migration_source_links"))
          return {
            rows: [
              {
                sourceDatabase: "pms",
                sourceTable: "rooms",
                sourceId: "legacy-room",
                targetProduct: "pms",
                targetTable: "rooms",
                targetId: "stale-room",
                sourceChecksum: "a".repeat(64),
                sourceUpdatedAt: "2026-08-01T00:00:00Z",
                lastMigratedAt: "2026-08-02T00:00:00Z",
              },
            ],
          };
        if (sql.includes("WITH requested AS")) return { rows: [] };
        throw new Error(`Unexpected SQL: ${sql}`);
      },
    };
    const target = await readProductionPmsTargetState(client as never, candidates(), {
      propertyLinks: [],
      bookings: [],
      userIds: [],
      mediaIds: [],
    });
    expect(target.blockers).toContainEqual(
      expect.objectContaining({
        code: "SOURCE_ABSENT_MIGRATED_TARGET",
        source: "pms.rooms",
        sourceId: "legacy-room",
      }),
    );
  });
});

function candidates(): PmsTargetRecord[] {
  return [
    {
      targetProduct: "pms",
      targetTable: "room_types",
      targetId: "10000000-0000-4000-a000-000000000001",
      sourceDatabase: "pms",
      sourceTable: "room_types",
      sourceId: "10000000-0000-4000-a000-000000000001",
      sourceChecksum: "a".repeat(64),
      sourceUpdatedAt: "2026-08-30T00:00:00Z",
      mutable: true,
      row: {},
    },
    {
      targetProduct: "pms",
      targetTable: "inventory_days",
      targetId:
        "20000000-0000-4000-a000-000000000001:10000000-0000-4000-a000-000000000001:2026-08-30",
      sourceDatabase: "pms",
      sourceTable: "room_types",
      sourceId: "10000000-0000-4000-a000-000000000001",
      sourceChecksum: "b".repeat(64),
      sourceUpdatedAt: "2026-08-30T00:00:00Z",
      mutable: true,
      row: {},
    },
  ];
}
