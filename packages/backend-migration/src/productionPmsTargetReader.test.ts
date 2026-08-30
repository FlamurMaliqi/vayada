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
    const prerequisites = await readProductionPmsPrerequisites(client as never);
    expect(prerequisites.bookings[0]?.updatedAt).toBeNull();
  });

  it("loads UUID and composite target rows, provenance, and unique collisions", async () => {
    const calls: string[] = [];
    const client = {
      async query(sql: string) {
        calls.push(sql);
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
      row: { propertyId: "20000000-0000-4000-a000-000000000001", sourceSystem: "pms" },
    });
    expect(target.provenance[0]).toMatchObject({
      sourceUpdatedAt: "2026-08-30T00:00:00.000Z",
      lastMigratedAt: "2026-08-30T01:00:00.000Z",
    });
    expect(target.blockers).toHaveLength(1);
    expect(calls.some((sql) => sql.includes("stay_date::text"))).toBe(true);
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
