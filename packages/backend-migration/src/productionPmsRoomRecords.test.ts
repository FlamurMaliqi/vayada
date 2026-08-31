import { describe, expect, it } from "vitest";

import { createProductionPmsContext } from "./productionPmsContext.js";
import { buildPmsRoomRecords } from "./productionPmsRoomRecords.js";
import type { IdentitySourceRow } from "./productionIdentityDisposition.js";

const HOTEL = "10000000-0000-4000-a000-000000000001";
const PROPERTY = "20000000-0000-4000-a000-000000000001";
const ROOM_TYPE = "30000000-0000-4000-a000-000000000001";
const ROOM = "40000000-0000-4000-a000-000000000001";
const GROUP = "50000000-0000-4000-a000-000000000001";
const MAPPING = "60000000-0000-4000-a000-000000000001";
const MEDIA = "a0000000-0000-4000-a000-000000000001";
const SOURCE_IMAGE = "https://legacy-media-test.s3.amazonaws.com/rooms/suite.jpg";
const CDN_IMAGE = `https://media.example.test/media/${MEDIA}/original-safe.webp`;

describe("production PMS room records", () => {
  it("preserves room facts, linked inventory, pricing, and channel plans", () => {
    const context = createProductionPmsContext({
      sourceRunId: "run",
      completedAt: "2026-08-30T00:00:00Z",
      rows: sourceRows(),
      target: target(),
    });
    const built = buildPmsRoomRecords(context);
    expect(context.blockers).toEqual([]);
    expect(built.records.map((record) => record.targetTable).sort()).toEqual([
      "linked_inventory_groups",
      "rate_plans",
      "rate_plans",
      "rate_plans",
      "rate_rules",
      "rate_rules",
      "room_type_media",
      "room_types",
      "rooms",
    ]);
    expect(built.records.find((record) => record.targetTable === "room_types")?.row).toMatchObject({
      propertyId: PROPERTY,
      linkedInventoryGroupId: GROUP,
      occupancyLimits: { maxOccupancy: 3, maxAdults: 2, maxChildren: 1 },
      roomAttributes: { legacyPricing: { weekendSurcharge: "+12%" } },
      mediaSnapshot: [
        {
          mediaObjectId: MEDIA,
          url: CDN_IMAGE,
          source: "pms",
          sourceTable: "room_types",
          publicApproved: true,
        },
      ],
    });
    expect(
      built.records.find((record) => record.targetTable === "room_type_media")?.row,
    ).toMatchObject({
      propertyId: PROPERTY,
      roomTypeId: ROOM_TYPE,
      platformMediaObjectId: MEDIA,
      sortOrder: 0,
    });
    expect(built.channelPlanByMapping.get(MAPPING)).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-a[0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    expect(
      built.records.find(
        (record) => record.targetTable === "rate_plans" && record.row["rateType"] === "flexible",
      )?.row,
    ).toMatchObject({
      cancellationPolicySnapshot: {
        flexibleCancellationType: "partial_refund",
        partialRefundTiers: [
          { min_days_before_check_in: 30, refund_percent: 50 },
          { min_days_before_check_in: 7, refund_percent: 20 },
        ],
      },
    });
    expect(
      built.records.find(
        (record) =>
          record.targetTable === "rate_plans" && record.row["rateType"] === "non_refundable",
      )?.row,
    ).toMatchObject({ depositPolicy: { kind: "percentage", value: 30 } });
  });

  it("blocks malformed pricing instead of silently dropping it", () => {
    const rows = sourceRows();
    rows.find((row) => row.sourceTable === "room_types")!.data["seasons"] = ["bad"];
    const context = createProductionPmsContext({
      sourceRunId: "run",
      completedAt: "2026-08-30T00:00:00Z",
      rows,
      target: target(),
    });
    buildPmsRoomRecords(context);
    expect(context.blockers).toContainEqual(
      expect.objectContaining({ code: "INVALID_SOURCE_ROW", source: "pms.room_types" }),
    );
  });
});

function sourceRows(): IdentitySourceRow[] {
  return [
    row("linked_inventory_groups", {
      id: GROUP,
      hotel_id: HOTEL,
      name: "Convertible rooms",
      created_at: "2026-01-01T00:00:00Z",
      updated_at: "2026-02-01T00:00:00Z",
    }),
    row("linked_inventory_group_members", { group_id: GROUP, room_type_id: ROOM_TYPE }),
    row("cancellation_policies", {
      id: "70000000-0000-4000-a000-000000000001",
      hotel_id: HOTEL,
      free_cancellation_days: 7,
      partial_refund_pct: 50,
      created_at: "2026-01-01T00:00:00Z",
      updated_at: "2026-02-01T00:00:00Z",
    }),
    row("room_types", {
      id: ROOM_TYPE,
      hotel_id: HOTEL,
      name: "Suite",
      description: "Large suite",
      max_occupancy: 3,
      max_adults: 2,
      max_children: 1,
      base_rate: "200.00",
      currency: "EUR",
      total_rooms: 2,
      is_active: true,
      sort_order: 1,
      amenities: ["wifi"],
      images: [SOURCE_IMAGE],
      features: ["balcony"],
      benefits: [],
      monthly_rates: {},
      daily_rates: {},
      operating_periods: [],
      seasons: [],
      weekend_surcharge: "+12%",
      min_stay: 2,
      max_stay: 7,
      non_refundable_rate: null,
      non_refundable_enabled: true,
      flexible_rate_enabled: true,
      flexible_cancellation_type: "partial_refund",
      partial_refund_tiers: [
        { min_days_before_check_in: 30, refund_percent: 50 },
        { min_days_before_check_in: 7, refund_percent: 20 },
      ],
      rate_payment_methods: {},
      rate_deposit_settings: {
        nonrefundable: { kind: "percentage", value: 30 },
      },
      meal_plans: [],
      created_at: "2026-01-01T00:00:00Z",
      updated_at: "2026-02-01T00:00:00Z",
    }),
    row("rooms", {
      id: ROOM,
      hotel_id: HOTEL,
      room_type_id: ROOM_TYPE,
      room_number: "101",
      status: "available",
      created_at: "2026-01-01T00:00:00Z",
      updated_at: "2026-02-01T00:00:00Z",
    }),
    row("channex_rate_plan_mappings", {
      id: MAPPING,
      hotel_id: HOTEL,
      room_type_id: ROOM_TYPE,
      channex_rate_plan_id: "80000000-0000-4000-a000-000000000001",
      channex_room_type_id: "90000000-0000-4000-a000-000000000001",
      sell_mode: "per_room",
      plan_name: "OTA plan",
      channel: "booking.com",
      created_at: "2026-01-01T00:00:00Z",
      updated_at: "2026-02-01T00:00:00Z",
    }),
  ];
}

function target() {
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
    bookings: [],
    userIds: [],
    media: [
      {
        mediaObjectId: MEDIA,
        propertyId: PROPERTY,
        sourceTable: "room_types",
        sourceRowId: `${ROOM_TYPE}:images:1`,
        sourceUrl: SOURCE_IMAGE,
        purpose: "pms.room_type.media" as const,
        visibility: "public" as const,
        lifecycleStatus: "active",
        publicApproved: true,
        publicUrl: CDN_IMAGE,
        storageKey: `public/media/${MEDIA}/original_safe/file.webp`,
      },
    ],
    mediaIds: [],
    records: [],
    provenance: [],
  };
}

function row(sourceTable: string, data: Record<string, unknown>): IdentitySourceRow {
  return { sourceDatabase: "pms", sourceTable, rowOrdinal: 1, data };
}
