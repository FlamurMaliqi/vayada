import { describe, expect, it } from "vitest";

import { buildPmsAssignmentRecords } from "./productionPmsAssignmentRecords.js";
import { createProductionPmsContext } from "./productionPmsContext.js";
import type { IdentitySourceRow } from "./productionIdentityDisposition.js";
import type { ProductionPmsTargetState } from "./productionPmsTypes.js";

const HOTEL = "10000000-0000-4000-a000-000000000001";
const PROPERTY = "20000000-0000-4000-a000-000000000001";
const BOOKING = "30000000-0000-4000-a000-000000000001";
const TYPE = "40000000-0000-4000-a000-000000000001";
const ROOM_ONE = "50000000-0000-4000-a000-000000000001";
const ROOM_TWO = "50000000-0000-4000-a000-000000000002";
const EXTRA = "60000000-0000-4000-a000-000000000001";
const BLOCK = "70000000-0000-4000-a000-000000000001";
const PLAN = "80000000-0000-4000-a000-000000000001";

describe("production PMS assignments", () => {
  it("creates exact multi-room positions and converts exclusive legacy block dates", () => {
    const context = createProductionPmsContext({
      sourceRunId: "run",
      completedAt: "2026-08-30T00:00:00Z",
      rows: rows(),
      target: target(),
    });
    const built = buildPmsAssignmentRecords(context, {
      records: [],
      flexiblePlanByRoomType: new Map([[TYPE, PLAN]]),
      channelPlanByMapping: new Map(),
    });
    expect(context.blockers).toEqual([]);
    const assignments = built.records.filter(
      (record) => record.targetTable === "operational_booking_assignments",
    );
    expect(assignments.map((record) => record.row)).toEqual([
      expect.objectContaining({ position: 1, roomId: ROOM_ONE, ratePlanId: PLAN }),
      expect.objectContaining({ position: 2, roomId: ROOM_TWO, id: EXTRA }),
    ]);
    expect(built.records.find((record) => record.targetTable === "room_blocks")?.row).toMatchObject(
      { startsOn: "2026-09-01", endsOn: "2026-09-02", status: "active" },
    );
  });

  it("blocks assignments until the VAY-1355 target booking exists", () => {
    const targetState = target();
    targetState.bookings = [];
    const context = createProductionPmsContext({
      sourceRunId: "run",
      completedAt: "2026-08-30T00:00:00Z",
      rows: rows(),
      target: targetState,
    });
    buildPmsAssignmentRecords(context, {
      records: [],
      flexiblePlanByRoomType: new Map([[TYPE, PLAN]]),
      channelPlanByMapping: new Map(),
    });
    expect(context.blockers).toContainEqual(
      expect.objectContaining({
        code: "INVALID_SOURCE_ROW",
        message: expect.stringContaining("VAY-1355 migration gate"),
      }),
    );
  });

  it("blocks assignments when target booking freshness is missing", () => {
    const targetState = target();
    targetState.bookings[0]!.updatedAt = null;
    const context = createProductionPmsContext({
      sourceRunId: "run",
      completedAt: "2026-08-30T00:00:00Z",
      rows: rows(),
      target: targetState,
    });
    buildPmsAssignmentRecords(context, {
      records: [],
      flexiblePlanByRoomType: new Map([[TYPE, PLAN]]),
      channelPlanByMapping: new Map(),
    });
    expect(context.blockers).toContainEqual(
      expect.objectContaining({
        code: "INVALID_SOURCE_ROW",
        message: expect.stringContaining("target updatedAt differs"),
      }),
    );
  });
});

function rows(): IdentitySourceRow[] {
  return [
    row("room_types", { id: TYPE, hotel_id: HOTEL }),
    row("rooms", { id: ROOM_ONE, hotel_id: HOTEL, room_type_id: TYPE }),
    row("rooms", { id: ROOM_TWO, hotel_id: HOTEL, room_type_id: TYPE }),
    row("bookings", {
      id: BOOKING,
      hotel_id: HOTEL,
      room_type_id: TYPE,
      room_id: ROOM_ONE,
      booking_reference: "VAY-BOOKING",
      status: "confirmed",
      channel: "direct",
      number_of_rooms: 2,
      check_in: "2026-09-01",
      check_out: "2026-09-03",
      adults: 2,
      children: 1,
      created_at: "2026-08-01T00:00:00Z",
      updated_at: "2026-08-20T00:00:00Z",
    }),
    row("booking_rooms", {
      id: EXTRA,
      booking_id: BOOKING,
      room_id: ROOM_TWO,
      position: 1,
      created_at: "2026-08-20T00:00:00Z",
    }),
    row("room_blocks", {
      id: BLOCK,
      hotel_id: HOTEL,
      room_type_id: TYPE,
      room_id: null,
      start_date: "2026-09-01",
      end_date: "2026-09-03",
      blocked_count: 1,
      reason: "Repair",
      created_at: "2026-08-20T00:00:00Z",
    }),
  ];
}

function target(): ProductionPmsTargetState {
  return {
    propertyLinks: [
      {
        sourceId: HOTEL,
        propertyId: PROPERTY,
        relationship: "operational_input",
        status: "active",
        migrationRunId: "run",
      },
    ],
    bookings: [
      {
        id: BOOKING,
        propertyId: PROPERTY,
        checkIn: "2026-09-01",
        checkOut: "2026-09-03",
        adults: 2,
        children: 1,
        roomCount: 2,
        currency: "EUR",
        lifecycleStatus: "confirmed",
        updatedAt: "2026-08-20T00:00:00Z",
        migrationRunId: "run",
      },
    ],
    userIds: [],
    mediaIds: [],
    records: [],
    provenance: [],
  };
}

function row(sourceTable: string, data: Record<string, unknown>): IdentitySourceRow {
  return { sourceDatabase: "pms", sourceTable, rowOrdinal: 1, data };
}
