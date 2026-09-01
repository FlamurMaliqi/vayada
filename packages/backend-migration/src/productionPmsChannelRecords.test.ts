import { describe, expect, it } from "vitest";

import { buildPmsAssignmentRecords } from "./productionPmsAssignmentRecords.js";
import { buildPmsChannelRecords } from "./productionPmsChannelRecords.js";
import { createProductionPmsContext } from "./productionPmsContext.js";
import { buildPmsRoomRecords } from "./productionPmsRoomRecords.js";
import type { IdentitySourceRow } from "./productionIdentityDisposition.js";
import type { ProductionPmsTargetState } from "./productionPmsTypes.js";

const HOTEL = "10000000-0000-4000-a000-000000000001";
const PROPERTY = "20000000-0000-4000-a000-000000000001";
const ROOM_TYPE = "30000000-0000-4000-a000-000000000001";
const BOOKING = "40000000-0000-4000-a000-000000000001";
const CONNECTION = "50000000-0000-4000-a000-000000000001";
const ROOM_MAPPING = "60000000-0000-4000-a000-000000000001";
const RATE_MAPPING = "70000000-0000-4000-a000-000000000001";
const BOOKING_MAPPING = "80000000-0000-4000-a000-000000000001";
const EXTERNAL_PROPERTY = "90000000-0000-4000-a000-000000000001";
const EXTERNAL_ROOM = "a0000000-0000-4000-a000-000000000001";
const EXTERNAL_RATE = "b0000000-0000-4000-a000-000000000001";
const EXTERNAL_BOOKING = "c0000000-0000-4000-a000-000000000001";

describe("production PMS channels", () => {
  it("preserves provider IDs, markups, mapping slots, and historical sync receipts", () => {
    const context = createProductionPmsContext({
      sourceRunId: "run",
      completedAt: "2026-08-30T00:00:00Z",
      rows: rows(),
      target: target(),
    });
    const rooms = buildPmsRoomRecords(context);
    const assignments = buildPmsAssignmentRecords(context, rooms);
    const records = buildPmsChannelRecords(context, rooms, assignments);

    expect(context.blockers).toEqual([]);
    expect(
      records.find((record) => record.targetTable === "channel_connections")?.row,
    ).toMatchObject({
      id: CONNECTION,
      externalPropertyId: EXTERNAL_PROPERTY,
      connectionStatus: "connected",
      capabilities: ["booking", "ari", "message"],
      connectionMetadata: {
        channelMarkups: [
          { id: expect.any(String), channel: "booking.com", markupPercent: "12.5000" },
        ],
      },
    });
    expect(
      records.find((record) => record.targetTable === "channel_rate_plan_mappings")?.row,
    ).toMatchObject({
      externalRoomTypeId: EXTERNAL_ROOM,
      externalRatePlanId: EXTERNAL_RATE,
      markupPercent: "12.5000",
    });
    expect(
      records.find((record) => record.targetTable === "channel_booking_mappings")?.row,
    ).toMatchObject({
      guestBookingId: BOOKING,
      assignmentId: assignments.assignmentByBookingPosition.get(`${BOOKING}:1`),
      externalBookingId: EXTERNAL_BOOKING,
      channelRoomIndex: 0,
    });
    expect(records.filter((record) => record.targetTable === "channel_sync_status")).toHaveLength(
      3,
    );
    expect(
      records
        .filter((record) => record.targetTable === "channel_sync_status")
        .map((record) => record.row["status"]),
    ).not.toContain("pending");
  });

  it("blocks a provider room mapping that crosses property ownership", () => {
    const sourceRows = rows();
    sourceRows.find((entry) => entry.sourceTable === "channex_room_type_mappings")!.data[
      "room_type_id"
    ] = "d0000000-0000-4000-a000-000000000001";
    const context = createProductionPmsContext({
      sourceRunId: "run",
      completedAt: "2026-08-30T00:00:00Z",
      rows: sourceRows,
      target: target(),
    });
    const rooms = buildPmsRoomRecords(context);
    const assignments = buildPmsAssignmentRecords(context, rooms);
    buildPmsChannelRecords(context, rooms, assignments);
    expect(context.blockers).toContainEqual(
      expect.objectContaining({
        source: "pms.channex_room_type_mappings",
        message: expect.stringContaining("missing or cross-property"),
      }),
    );
  });

  it("retains an archived owner's provider identity without reviving the connection", () => {
    const targetState = target();
    targetState.propertyLinks[0]!.ownerStatus = "archived";
    targetState.propertyLinks[0]!.migrationRunId = "vay1351-0123456789abcdef01234567";
    targetState.bookings[0]!.migrationRunId = "vay1351-0123456789abcdef01234567";
    const context = createProductionPmsContext({
      sourceRunId: "vay1351-0123456789abcdef01234567",
      completedAt: "2026-08-30T00:00:00Z",
      rows: rows(),
      target: targetState,
    });
    const rooms = buildPmsRoomRecords(context);
    const assignments = buildPmsAssignmentRecords(context, rooms);
    const records = buildPmsChannelRecords(context, rooms, assignments);

    expect(context.blockers).toEqual([]);
    expect(records.find((record) => record.targetTable === "channel_binding_claims")?.row).toEqual({
      propertyId: PROPERTY,
      provider: "channex",
      externalPropertyId: EXTERNAL_PROPERTY,
      claimState: "historical",
      claimSource: "migration",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    });
    expect(
      records.find((record) => record.targetTable === "channel_connections")?.row,
    ).toMatchObject({
      externalPropertyId: null,
      connectionStatus: "disconnected",
      capabilities: [],
      messagingAppInstalled: false,
      connectionMetadata: {
        migrationRunId: "vay1351-0123456789abcdef01234567",
        legacyExternalPropertyId: EXTERNAL_PROPERTY,
        ownerStatus: "archived",
        retainedClaimState: "historical",
        legacyCapabilities: ["booking", "ari", "message"],
      },
    });
    expect(
      records.find((record) => record.targetTable === "channel_room_type_mappings")?.row,
    ).toMatchObject({ status: "disabled" });
    expect(
      records.find((record) => record.targetTable === "channel_rate_plan_mappings")?.row,
    ).toMatchObject({ status: "disabled" });
    expect(
      records.find((record) => record.targetTable === "channel_booking_mappings")?.row,
    ).toMatchObject({ syncStatus: "ignored" });

    const refreshedRows = rows();
    refreshedRows.find((row) => row.sourceTable === "channex_connections")!.data[
      "last_booking_sync_at"
    ] = "2026-08-30T00:00:00Z";
    refreshedRows.find((row) => row.sourceTable === "channex_connections")!.data["updated_at"] =
      "2026-08-30T00:00:00Z";
    refreshedRows.find((row) => row.sourceTable === "channex_channel_markups")!.data["updated_at"] =
      "2026-08-30T00:00:00Z";
    const refreshedContext = createProductionPmsContext({
      sourceRunId: "vay1351-0123456789abcdef01234567",
      completedAt: "2026-08-30T00:00:00Z",
      rows: refreshedRows,
      target: targetState,
    });
    const refreshedRooms = buildPmsRoomRecords(refreshedContext);
    const refreshedAssignments = buildPmsAssignmentRecords(refreshedContext, refreshedRooms);
    const refreshedClaim = buildPmsChannelRecords(
      refreshedContext,
      refreshedRooms,
      refreshedAssignments,
    ).find((record) => record.targetTable === "channel_binding_claims");
    const originalClaim = records.find((record) => record.targetTable === "channel_binding_claims");
    expect(refreshedClaim?.row).toEqual(originalClaim?.row);
    expect(refreshedClaim?.sourceChecksum).toBe(originalClaim?.sourceChecksum);
  });

  it("forces a private-quarantined property's provider state offline", () => {
    const targetState = target();
    targetState.propertyLinks[0]!.migrationDisposition = "private_quarantine";
    targetState.propertyLinks[0]!.ownerStatus = "active";
    const context = createProductionPmsContext({
      sourceRunId: "run",
      completedAt: "2026-08-30T00:00:00Z",
      rows: rows(),
      target: targetState,
    });
    const rooms = buildPmsRoomRecords(context);
    const assignments = buildPmsAssignmentRecords(context, rooms);
    const records = buildPmsChannelRecords(context, rooms, assignments);

    expect(context.blockers).toEqual([]);
    expect(records.find((record) => record.targetTable === "channel_binding_claims")?.row).toEqual(
      expect.objectContaining({ claimState: "historical" }),
    );
    expect(
      records.find((record) => record.targetTable === "channel_connections")?.row,
    ).toMatchObject({
      connectionStatus: "disconnected",
      externalPropertyId: null,
      capabilities: [],
    });
    expect(
      records.find((record) => record.targetTable === "channel_room_type_mappings")?.row,
    ).toMatchObject({ status: "disabled" });
  });
});

function rows(): IdentitySourceRow[] {
  return [
    row("room_types", {
      id: ROOM_TYPE,
      hotel_id: HOTEL,
      name: "Double",
      base_rate: "100.00",
      currency: "EUR",
      is_active: true,
      created_at: "2026-01-01T00:00:00Z",
      updated_at: "2026-08-01T00:00:00Z",
    }),
    row("bookings", {
      id: BOOKING,
      hotel_id: HOTEL,
      room_type_id: ROOM_TYPE,
      number_of_rooms: 1,
      status: "confirmed",
      channel: "booking.com",
      booking_reference: "REF-1",
      check_in: "2026-09-01",
      check_out: "2026-09-03",
      adults: 2,
      children: 0,
      created_at: "2026-08-01T00:00:00Z",
      updated_at: "2026-08-02T00:00:00Z",
    }),
    row("channex_connections", {
      id: CONNECTION,
      hotel_id: HOTEL,
      channex_property_id: EXTERNAL_PROPERTY,
      is_active: true,
      last_booking_sync_at: "2026-08-25T00:00:00Z",
      last_ari_sync_at: "2026-08-26T00:00:00Z",
      messaging_app_installed: true,
      last_message_sync_at: "2026-08-27T00:00:00Z",
      created_at: "2026-01-01T00:00:00Z",
      updated_at: "2026-08-27T00:00:00Z",
    }),
    row("channex_room_type_mappings", {
      id: ROOM_MAPPING,
      hotel_id: HOTEL,
      room_type_id: ROOM_TYPE,
      channex_room_type_id: EXTERNAL_ROOM,
      created_at: "2026-01-01T00:00:00Z",
      updated_at: "2026-08-01T00:00:00Z",
    }),
    row("channex_rate_plan_mappings", {
      id: RATE_MAPPING,
      hotel_id: HOTEL,
      room_type_id: ROOM_TYPE,
      channex_rate_plan_id: EXTERNAL_RATE,
      channex_room_type_id: EXTERNAL_ROOM,
      sell_mode: "per_room",
      plan_name: "Flexible",
      channel: "booking.com",
      meal_plan_code: 0,
      created_at: "2026-01-01T00:00:00Z",
      updated_at: "2026-08-01T00:00:00Z",
    }),
    row("channex_booking_mappings", {
      id: BOOKING_MAPPING,
      hotel_id: HOTEL,
      booking_id: BOOKING,
      channex_booking_id: EXTERNAL_BOOKING,
      channel_source: "booking.com",
      channex_room_index: 0,
      last_synced_at: "2026-08-28T00:00:00Z",
      created_at: "2026-08-01T00:00:00Z",
      updated_at: "2026-08-28T00:00:00Z",
    }),
    row("channex_channel_markups", {
      id: "d0000000-0000-4000-a000-000000000001",
      hotel_id: HOTEL,
      channel: "booking.com",
      markup_pct: "12.5",
      created_at: "2026-01-01T00:00:00Z",
      updated_at: "2026-08-29T00:00:00Z",
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
        ownerStatus: "active",
      },
    ],
    bookings: [
      {
        id: BOOKING,
        propertyId: PROPERTY,
        checkIn: "2026-09-01",
        checkOut: "2026-09-03",
        adults: 2,
        children: 0,
        roomCount: 1,
        currency: "EUR",
        lifecycleStatus: "confirmed",
        updatedAt: "2026-08-02T00:00:00Z",
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
