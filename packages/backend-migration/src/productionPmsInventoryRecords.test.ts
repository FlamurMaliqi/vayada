import { describe, expect, it } from "vitest";

import { createProductionPmsContext } from "./productionPmsContext.js";
import { buildPmsInventoryRecords } from "./productionPmsInventoryRecords.js";
import type { IdentitySourceRow } from "./productionIdentityDisposition.js";

const HOTEL = "10000000-0000-4000-a000-000000000001";
const PROPERTY = "20000000-0000-4000-a000-000000000001";
const TYPE_A = "30000000-0000-4000-a000-000000000001";
const TYPE_B = "30000000-0000-4000-a000-000000000002";
const GROUP = "40000000-0000-4000-a000-000000000001";

describe("production PMS inventory", () => {
  it("materializes 366 days and preserves linked stop-sell behavior", () => {
    const context = createProductionPmsContext({
      sourceRunId: "run",
      completedAt: "2026-08-30T00:00:00Z",
      rows: rows(),
      target: {
        propertyLinks: [
          {
            sourceId: HOTEL,
            propertyId: PROPERTY,
            relationship: "operational_input",
            status: "active",
            migrationRunId: "run",
          },
        ],
        bookings: [],
        userIds: [],
        mediaIds: [],
        records: [],
        provenance: [],
      },
    });
    const records = buildPmsInventoryRecords(context);
    expect(context.blockers).toEqual([]);
    expect(records).toHaveLength(732);
    expect(day(records, TYPE_A, "2026-09-01")).toMatchObject({
      assignedCount: 1,
      availableCount: 0,
      status: "open",
      linkedStopSell: true,
      linkedSourceRevision: 1,
      sourceFreshness: { legacy: { linkedStopSell: true } },
    });
    expect(day(records, TYPE_B, "2026-09-01")).toMatchObject({
      assignedCount: 0,
      availableCount: 0,
      status: "open",
      linkedStopSell: true,
      linkedSourceRevision: 1,
      sourceFreshness: { legacy: { linkedStopSell: true } },
    });
    expect(day(records, TYPE_A, "2026-09-04")).toMatchObject({
      assignedCount: 0,
      availableCount: 2,
      status: "open",
    });
  });

  it("blocks over-capacity source state", () => {
    const source = rows();
    source.find((row) => row.sourceTable === "bookings")!.data["number_of_rooms"] = 3;
    const context = createProductionPmsContext({
      sourceRunId: "run",
      completedAt: "2026-08-30T00:00:00Z",
      rows: source,
      target: {
        propertyLinks: [
          {
            sourceId: HOTEL,
            propertyId: PROPERTY,
            relationship: "operational_input",
            status: "active",
            migrationRunId: "run",
          },
        ],
        bookings: [],
        userIds: [],
        mediaIds: [],
        records: [],
        provenance: [],
      },
    });
    buildPmsInventoryRecords(context);
    expect(context.blockers).toContainEqual(
      expect.objectContaining({
        code: "INVALID_SOURCE_ROW",
        message: expect.stringContaining("exceeds total_rooms"),
      }),
    );
  });

  it("blocks active legacy holds that have no target release lifecycle", () => {
    const source = rows();
    source.push(
      row("booking_drafts", {
        id: "60000000-0000-4000-a000-000000000001",
        hotel_id: HOTEL,
        room_type_id: TYPE_A,
        materialized_booking_id: null,
        number_of_rooms: 1,
        check_in: "2026-09-01",
        check_out: "2026-09-03",
        expires_at: "2026-08-30T00:10:00Z",
      }),
    );
    const context = createProductionPmsContext({
      sourceRunId: "run",
      completedAt: "2026-08-30T00:00:00Z",
      rows: source,
      target: {
        propertyLinks: [
          {
            sourceId: HOTEL,
            propertyId: PROPERTY,
            relationship: "operational_input",
            status: "active",
            migrationRunId: "run",
          },
        ],
        bookings: [],
        userIds: [],
        mediaIds: [],
        records: [],
        provenance: [],
      },
    });
    buildPmsInventoryRecords(context);
    expect(context.blockers).toContainEqual(
      expect.objectContaining({
        code: "ACTIVE_BOOKING_DRAFT",
        sourceId: "60000000-0000-4000-a000-000000000001",
      }),
    );
  });
});

function day(records: ReturnType<typeof buildPmsInventoryRecords>, type: string, date: string) {
  return records.find(
    (record) => record.row["roomTypeId"] === type && record.row["stayDate"] === date,
  )?.row;
}

function rows(): IdentitySourceRow[] {
  return [
    row("linked_inventory_groups", {
      id: GROUP,
      hotel_id: HOTEL,
      name: "Linked",
      created_at: "2026-01-01T00:00:00Z",
      updated_at: "2026-01-01T00:00:00Z",
    }),
    row("linked_inventory_group_members", { group_id: GROUP, room_type_id: TYPE_A }),
    row("linked_inventory_group_members", { group_id: GROUP, room_type_id: TYPE_B }),
    roomType(TYPE_A),
    roomType(TYPE_B),
    row("bookings", {
      id: "50000000-0000-4000-a000-000000000001",
      hotel_id: HOTEL,
      room_type_id: TYPE_A,
      status: "confirmed",
      payment_status: "paid",
      number_of_rooms: 1,
      check_in: "2026-09-01",
      check_out: "2026-09-03",
      created_at: "2026-08-20T00:00:00Z",
    }),
  ];
}

function roomType(id: string): IdentitySourceRow {
  return row("room_types", {
    id,
    hotel_id: HOTEL,
    total_rooms: 2,
    operating_periods: [],
    minimum_advance_days: 0,
    updated_at: "2026-08-20T00:00:00Z",
  });
}

function row(sourceTable: string, data: Record<string, unknown>): IdentitySourceRow {
  return { sourceDatabase: "pms", sourceTable, rowOrdinal: 1, data };
}
