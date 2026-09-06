import { describe, expect, it } from "vitest";

import {
  appendProductionPmsTargetRows,
  readProductionPmsPrerequisites,
  readProductionPmsTargetState,
} from "./productionPmsTargetReader.js";
import type { PmsTargetRecord } from "./productionPmsTypes.js";
import { PRODUCTION_PMS_TABLES } from "./productionPmsTables.js";

describe("production PMS target reader", () => {
  it("checks only distinct candidate Inbox threads in bounded batches and preserves blockers", async () => {
    const template = candidates()[0]!;
    const threads = Array.from({ length: 1_001 }, (_, index) => ({
      ...template,
      targetTable: "message_threads",
      targetId: `10000000-0000-4000-a000-${String(index).padStart(12, "0")}`,
    }));
    const calls: unknown[][] = [];
    const client = {
      async query(sql: string, values?: unknown[]) {
        if (!sql.includes("INBOX_TARGET_THREAD_SUMMARY_MISMATCH")) return { rows: [] };
        calls.push(values!);
        expect(sql).toContain("property_id = thread.property_id AND thread_id = thread.id");
        expect(sql).toContain("ORDER BY sent_at DESC, id DESC LIMIT 1");
        return { rows: [{ code: "INBOX_TARGET_THREAD_SUMMARY_MISMATCH", sourceId: "thread" }] };
      },
    };
    const prerequisites = { propertyLinks: [], bookings: [], userIds: [], mediaIds: [] };
    expect(
      (await readProductionPmsTargetState(client as never, [], prerequisites)).blockers,
    ).toEqual([]);
    expect(calls).toEqual([]);
    const target = await readProductionPmsTargetState(
      client as never,
      [...threads, threads[0]!, template],
      prerequisites,
    );
    expect(calls.map((call) => (call[0] as string[]).length)).toEqual([500, 500, 1]);
    expect(calls.flatMap((call) => call[0])).toEqual(threads.map((thread) => thread.targetId));
    expect(target.blockers).toHaveLength(3);
  });

  it("excludes inventory from bounded collision batches while covering every SQL predicate", async () => {
    const [roomType, inventory] = candidates();
    const cohort = [
      ...Array.from({ length: 160_000 }, (_, index) => ({
        ...inventory!,
        targetId: `inventory-${index}`,
      })),
      ...Array.from({ length: 1_001 }, (_, index) => ({
        ...roomType!,
        targetId: `room-${index}`,
      })),
      ...Object.entries(PRODUCTION_PMS_TABLES).map(([table, definition]) => ({
        ...roomType!,
        targetProduct: definition.product,
        targetTable: table,
        targetId: table,
      })),
    ];
    const batches: { targetTable: string; targetId: string }[][] = [];
    let collisionSql = "";
    const client = {
      async query(sql: string, values?: unknown[]) {
        if (!sql.includes("WITH requested AS")) return { rows: [] };
        collisionSql = sql;
        const rows = JSON.parse(String(values?.[0]));
        batches.push(rows);
        return {
          rows: [
            {
              code: "TARGET_UNIQUE_CONFLICT",
              source: "pms.rooms",
              sourceId: `collision-${batches.length}`,
              message: "collision",
            },
          ],
        };
      },
    };
    const target = await readProductionPmsTargetState(client as never, cohort, {
      propertyLinks: [],
      bookings: [],
      userIds: [],
      mediaIds: [],
    });
    expect(batches).toHaveLength(3);
    expect(batches.every((batch) => batch.length <= 500)).toBe(true);
    const sent = batches.flat();
    const checkedTables = new Set(
      [...collisionSql.matchAll(/requested\."targetTable" = '([^']+)'/g)].map((match) => match[1]),
    );
    expect(new Set(sent.map((row) => row.targetTable))).toEqual(checkedTables);
    expect(sent.map((row) => row.targetId)).toEqual(
      cohort.filter((row) => checkedTables.has(row.targetTable)).map((row) => row.targetId),
    );
    expect(target.blockers).toHaveLength(3);
  }, 10_000);

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

  it("loads attachment conflict identities across runs without broadening reusable media", async () => {
    const calls: Array<{ sql: string; values: unknown[] | undefined }> = [];
    const client = {
      async query(sql: string, values?: unknown[]) {
        calls.push({ sql, values });
        return {
          rows: sql.includes("SELECT DISTINCT source_row_id")
            ? [{ sourceRowId: "attachment:source_url" }]
            : [],
        };
      },
    };
    const prerequisites = await readProductionPmsPrerequisites(client as never, "current-run");
    expect(prerequisites.attachmentMediaSourceIds).toEqual(["attachment:source_url"]);
    expect(prerequisites.media).toEqual([]);
    const conflicts = calls.find((call) => call.sql.includes("SELECT DISTINCT source_row_id"))!;
    expect(conflicts.values).toBeUndefined();
    expect(conflicts.sql).toContain(
      "source_system = 'pms' AND source_table = 'message_attachments'",
    );
    expect(conflicts.sql).not.toMatch(/migrationRunId|lifecycle_status/);
    const reusable = calls.find((call) => call.sql.includes('AS "mediaObjectId"'))!;
    expect(reusable.values).toEqual(["current-run"]);
    expect(reusable.sql).toContain("media.source_metadata ->> 'migrationRunId' = $1");
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

  it("loads a production-sized inventory cohort without a variadic stack overflow", () => {
    const rowCount = 160_000;
    const rows = Array.from({ length: rowCount }, (_, index) => ({
      targetId: `inventory-${index}`,
      updatedAt: "2026-08-30T00:00:00Z",
      rowData: "{}",
    }));
    const records: Parameters<typeof appendProductionPmsTargetRows>[0] = [];

    appendProductionPmsTargetRows(
      records,
      "pms",
      "inventory_days",
      "pms.inventory_days.updated_at",
      rows,
    );

    expect(records).toHaveLength(rowCount);
    expect(records.at(-1)?.targetId).toBe(`inventory-${rowCount - 1}`);
  }, 10_000);
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
