import { describe, expect, it } from "vitest";

import { createProductionPmsContext } from "./productionPmsContext.js";
import { buildPmsInventoryRecords } from "./productionPmsInventoryRecords.js";
import { buildPmsRoomRecords } from "./productionPmsRoomRecords.js";
import { sha256 } from "./productionBookingValues.js";
import type { IdentitySourceRow } from "./productionIdentityDisposition.js";
import type { ProductionPmsTargetState } from "./productionPmsTypes.js";

const HOTEL = "10000000-0000-4000-a000-000000000001";
const PROPERTY = "20000000-0000-4000-a000-000000000001";
const ROOM_TYPE = "30000000-0000-4000-a000-000000000001";
const ROOM_TYPE_DUPLICATE = "30000000-0000-4000-a000-000000000002";
const ROOM_TYPE_EMPTY_A = "30000000-0000-4000-a000-000000000003";
const ROOM_TYPE_EMPTY_B = "30000000-0000-4000-a000-000000000004";
const ROOM = "40000000-0000-4000-a000-000000000001";
const ROOM_DUPLICATE = "40000000-0000-4000-a000-000000000002";
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

  it("retains private-quarantined PMS room media without a public snapshot", () => {
    const targetState = target();
    targetState.propertyLinks[0]!.migrationDisposition = "private_quarantine";
    targetState.media![0] = {
      ...targetState.media![0]!,
      visibility: "private",
      publicApproved: false,
      publicUrl: null,
      storageKey: `private/media/${MEDIA}/provider_original/file.webp`,
    };
    const context = createProductionPmsContext({
      sourceRunId: "run",
      completedAt: "2026-08-30T00:00:00Z",
      rows: sourceRows(),
      target: targetState,
    });

    const built = buildPmsRoomRecords(context);

    expect(context.blockers).toEqual([]);
    expect(built.records.find((record) => record.targetTable === "room_types")?.row).toMatchObject({
      mediaSnapshot: [
        {
          mediaObjectId: MEDIA,
          url: null,
          publicApproved: false,
        },
      ],
    });
  });

  it("keeps legacy seasons with empty boundaries as evidence without materializing a rule", () => {
    const source = sourceRows();
    source.find((row) => row.sourceTable === "room_types")!.data["seasons"] = [
      { from: "", to: "", rate: 250, minStay: 2 },
    ];
    const context = createProductionPmsContext({
      sourceRunId: "run",
      completedAt: "2026-08-30T00:00:00Z",
      rows: source,
      target: target(),
    });

    const built = buildPmsRoomRecords(context);

    expect(context.blockers).toEqual([]);
    expect(built.records.filter((record) => record.targetTable === "rate_rules")).toHaveLength(2);
    expect(built.records.find((record) => record.targetTable === "room_types")?.row).toMatchObject({
      roomAttributes: { legacyPricing: { ignoredSeasonIndices: [0] } },
    });
  });

  it("omits an exact quarantined malformed image field and retains redacted evidence", () => {
    const source = sourceRows();
    const roomType = source.find((row) => row.sourceTable === "room_types")!;
    roomType.data["images"] = [{ stale: SOURCE_IMAGE }];
    const targetState = target();
    targetState.media = [];
    targetState.mediaQuarantines = [
      {
        sourceTable: "room_types",
        sourceRowId: `${ROOM_TYPE}:images`,
        sourceField: "images",
        sourceValueSha256: sha256({ value: roomType.data["images"] }),
        purpose: "pms.room_type.media",
        reasonCode: "INVALID_STRING_ARRAY",
      },
    ];
    const context = createProductionPmsContext({
      sourceRunId: "run",
      completedAt: "2026-08-30T00:00:00Z",
      rows: source,
      target: targetState,
    });

    const built = buildPmsRoomRecords(context);

    expect(context.blockers).toEqual([]);
    expect(built.records.filter((record) => record.targetTable === "room_type_media")).toEqual([]);
    expect(built.records.find((record) => record.targetTable === "room_types")?.row).toMatchObject({
      mediaSnapshot: [],
      roomAttributes: {
        legacyMediaDisposition: {
          reasonCode: "INVALID_STRING_ARRAY",
          sourceValueSha256: expect.stringMatching(/^[0-9a-f]{64}$/),
        },
      },
    });
  });

  it("deactivates a historical same-name duplicate while preserving both room types", () => {
    const rows = sourceRows();
    const original = rows.find((row) => row.sourceTable === "room_types")!;
    rows.push(
      row("room_types", {
        ...structuredClone(original.data),
        id: ROOM_TYPE_DUPLICATE,
        name: "suite",
        total_rooms: 1,
        images: [],
        created_at: "2026-01-02T00:00:00Z",
      }),
      row("rooms", {
        id: ROOM_DUPLICATE,
        hotel_id: HOTEL,
        room_type_id: ROOM_TYPE_DUPLICATE,
        room_number: "102",
        status: "available",
        created_at: "2026-01-02T00:00:00Z",
        updated_at: "2026-02-01T00:00:00Z",
      }),
    );
    const context = createProductionPmsContext({
      sourceRunId: "run",
      completedAt: "2026-08-30T00:00:00Z",
      rows,
      target: target(),
    });

    const built = buildPmsRoomRecords(context);
    const roomTypes = built.records.filter((record) => record.targetTable === "room_types");

    expect(context.blockers).toEqual([]);
    expect(roomTypes.find((record) => record.sourceId === ROOM_TYPE)?.row).toMatchObject({
      name: "Suite",
      active: true,
      roomAttributes: {
        legacyRoomTypeDisposition: {
          canonicalRoomTypeId: ROOM_TYPE,
          duplicateGroupSize: 2,
          effectiveActive: true,
          reasonCode: "duplicate_name_canonical",
          sourceActive: true,
        },
      },
    });
    expect(roomTypes.find((record) => record.sourceId === ROOM_TYPE_DUPLICATE)?.row).toMatchObject({
      name: "suite",
      active: false,
      roomAttributes: {
        legacyRoomTypeDisposition: {
          canonicalRoomTypeId: ROOM_TYPE,
          duplicateGroupSize: 2,
          effectiveActive: false,
          reasonCode: "duplicate_name_historical_inactive",
          sourceActive: true,
        },
      },
    });
    expect(
      built.records
        .filter(
          (record) =>
            record.targetTable === "rate_plans" && record.row["roomTypeId"] === ROOM_TYPE_DUPLICATE,
        )
        .every((record) => record.row["active"] === false),
    ).toBe(true);
    expect(
      built.records.find(
        (record) => record.targetTable === "rooms" && record.sourceId === ROOM_DUPLICATE,
      )?.row,
    ).toMatchObject({
      status: "retired",
      roomMetadata: { legacySourceStatus: "available", reasonCode: "parent_room_type_inactive" },
    });
    expect(
      buildPmsInventoryRecords(context)
        .filter((record) => record.row["roomTypeId"] === ROOM_TYPE_DUPLICATE)
        .every((record) => record.row["status"] === "closed" && record.row["availableCount"] === 0),
    ).toBe(true);
  });

  it("deactivates all empty same-name legacy copies", () => {
    const rows = sourceRows();
    const original = rows.find((row) => row.sourceTable === "room_types")!;
    for (const [id, createdAt] of [
      [ROOM_TYPE_EMPTY_A, "2026-07-08T00:18:28Z"],
      [ROOM_TYPE_EMPTY_B, "2026-07-08T00:18:29Z"],
    ])
      rows.push(
        row("room_types", {
          ...structuredClone(original.data),
          id,
          name: "Empty Copy",
          total_rooms: 0,
          images: [],
          created_at: createdAt,
        }),
      );
    const context = createProductionPmsContext({
      sourceRunId: "run",
      completedAt: "2026-08-30T00:00:00Z",
      rows,
      target: target(),
    });

    const emptyCopies = buildPmsRoomRecords(context).records.filter(
      (record) =>
        record.targetTable === "room_types" &&
        [ROOM_TYPE_EMPTY_A, ROOM_TYPE_EMPTY_B].includes(record.sourceId),
    );

    expect(context.blockers).toEqual([]);
    expect(emptyCopies).toHaveLength(2);
    expect(emptyCopies.every((record) => record.row["active"] === false)).toBe(true);
    expect(emptyCopies.map((record) => record.row["roomAttributes"])).toEqual([
      expect.objectContaining({
        legacyRoomTypeDisposition: expect.objectContaining({
          canonicalRoomTypeId: null,
          reasonCode: "duplicate_name_empty_inactive",
        }),
      }),
      expect.objectContaining({
        legacyRoomTypeDisposition: expect.objectContaining({
          canonicalRoomTypeId: null,
          reasonCode: "duplicate_name_empty_inactive",
        }),
      }),
    ]);
  });

  it("blocks same-name room types when more than one has future booking evidence", () => {
    const rows = sourceRows();
    const original = rows.find((row) => row.sourceTable === "room_types")!;
    rows.push(
      row("room_types", {
        ...structuredClone(original.data),
        id: ROOM_TYPE_DUPLICATE,
        images: [],
      }),
      row("bookings", {
        id: "b0000000-0000-4000-a000-000000000001",
        room_type_id: ROOM_TYPE,
        status: "confirmed",
        check_out: "2026-09-10",
      }),
      row("bookings", {
        id: "b0000000-0000-4000-a000-000000000002",
        room_type_id: ROOM_TYPE_DUPLICATE,
        status: "confirmed",
        check_out: "2026-09-11",
      }),
    );
    const context = createProductionPmsContext({
      sourceRunId: "run",
      completedAt: "2026-08-30T00:00:00Z",
      rows,
      target: target(),
    });

    buildPmsRoomRecords(context);

    expect(context.blockers).toEqual([
      expect.objectContaining({
        code: "DUPLICATE_ACTIVE_ROOM_TYPE_NAME",
        source: "pms.room_types",
        sourceId: ROOM_TYPE,
      }),
      expect.objectContaining({
        code: "DUPLICATE_ACTIVE_ROOM_TYPE_NAME",
        source: "pms.room_types",
        sourceId: ROOM_TYPE_DUPLICATE,
      }),
    ]);
  });

  it("keeps the only live currency and inactivates conflicting historical pricing", () => {
    const rows = sourceRows();
    const original = rows.find((row) => row.sourceTable === "room_types")!;
    rows.push(
      row("room_types", {
        ...structuredClone(original.data),
        id: ROOM_TYPE_DUPLICATE,
        name: "Historical USD room",
        currency: "USD",
        images: [],
      }),
      row("rooms", {
        id: ROOM_DUPLICATE,
        hotel_id: HOTEL,
        room_type_id: ROOM_TYPE_DUPLICATE,
        room_number: "102",
        status: "available",
        created_at: "2026-01-01T00:00:00Z",
        updated_at: "2026-02-01T00:00:00Z",
      }),
    );
    const context = createProductionPmsContext({
      sourceRunId: "run",
      completedAt: "2026-08-30T00:00:00Z",
      rows,
      target: target(),
    });

    const built = buildPmsRoomRecords(context);
    const originalRecord = built.records.find(
      (record) => record.targetTable === "room_types" && record.sourceId === ROOM_TYPE,
    );
    const historicalRecord = built.records.find(
      (record) => record.targetTable === "room_types" && record.sourceId === ROOM_TYPE_DUPLICATE,
    );

    expect(context.blockers).toEqual([]);
    expect(originalRecord?.row).toMatchObject({
      active: true,
      currency: "EUR",
      roomAttributes: {
        legacyCurrencyDisposition: {
          effectiveActive: true,
          groupCurrencies: ["EUR", "USD"],
          reasonCode: "live_currency_retained",
          retainedCurrency: "EUR",
          sourceCurrency: "EUR",
        },
      },
    });
    expect(historicalRecord?.row).toMatchObject({
      active: false,
      baseRateAmount: "200.00",
      currency: "USD",
      roomAttributes: {
        legacyCurrencyDisposition: {
          effectiveActive: false,
          reasonCode: "conflicting_currency_historical_inactive",
          retainedCurrency: "EUR",
          sourceCurrency: "USD",
        },
      },
    });
    expect(
      built.records.find(
        (record) => record.targetTable === "rooms" && record.sourceId === ROOM_DUPLICATE,
      )?.row,
    ).toMatchObject({ status: "retired" });
    expect(
      buildPmsInventoryRecords(context)
        .filter((record) => record.row["roomTypeId"] === ROOM_TYPE_DUPLICATE)
        .every((record) => record.row["status"] === "closed" && record.row["availableCount"] === 0),
    ).toBe(true);
  });

  it("inactivates every ambiguous currency when none has live evidence", () => {
    const rows = sourceRows().filter((row) => row.sourceTable !== "channex_rate_plan_mappings");
    const original = rows.find((row) => row.sourceTable === "room_types")!;
    rows.push(
      row("room_types", {
        ...structuredClone(original.data),
        id: ROOM_TYPE_DUPLICATE,
        name: "Other currency room",
        currency: "USD",
        images: [],
      }),
    );
    const context = createProductionPmsContext({
      sourceRunId: "run",
      completedAt: "2026-08-30T00:00:00Z",
      rows,
      target: target(),
    });

    const built = buildPmsRoomRecords(context);
    const roomTypes = built.records.filter((record) => record.targetTable === "room_types");

    expect(context.blockers).toEqual([]);
    expect(roomTypes).toHaveLength(2);
    expect(roomTypes.every((record) => record.row["active"] === false)).toBe(true);
    expect(
      roomTypes.every(
        (record) => record.row["currency"] === (record.sourceId === ROOM_TYPE ? "EUR" : "USD"),
      ),
    ).toBe(true);
    expect(
      roomTypes.every(
        (record) =>
          (record.row["roomAttributes"] as Record<string, Record<string, unknown>>)[
            "legacyCurrencyDisposition"
          ]?.["reasonCode"] === "ambiguous_currency_group_inactive",
      ),
    ).toBe(true);
  });

  it("blocks when multiple currencies retain live evidence", () => {
    const rows = sourceRows();
    const original = rows.find((row) => row.sourceTable === "room_types")!;
    rows.push(
      row("room_types", {
        ...structuredClone(original.data),
        id: ROOM_TYPE_DUPLICATE,
        name: "Live USD room",
        currency: "USD",
        images: [],
      }),
      row("bookings", {
        id: "b0000000-0000-4000-a000-000000000003",
        room_type_id: ROOM_TYPE_DUPLICATE,
        status: "confirmed",
        check_out: "2026-09-11",
      }),
    );
    const context = createProductionPmsContext({
      sourceRunId: "run",
      completedAt: "2026-08-30T00:00:00Z",
      rows,
      target: target(),
    });

    buildPmsRoomRecords(context);

    expect(context.blockers).toEqual([
      expect.objectContaining({
        code: "MULTIPLE_LIVE_ROOM_TYPE_CURRENCIES",
        source: "pms.room_types",
        sourceId: ROOM_TYPE,
      }),
      expect.objectContaining({
        code: "MULTIPLE_LIVE_ROOM_TYPE_CURRENCIES",
        source: "pms.room_types",
        sourceId: ROOM_TYPE_DUPLICATE,
      }),
    ]);
  });

  it("blocks an inactive room type that still has live evidence", () => {
    const rows = sourceRows();
    rows.find((row) => row.sourceTable === "room_types")!.data["is_active"] = false;
    const context = createProductionPmsContext({
      sourceRunId: "run",
      completedAt: "2026-08-30T00:00:00Z",
      rows,
      target: target(),
    });

    buildPmsRoomRecords(context);

    expect(context.blockers).toContainEqual(
      expect.objectContaining({
        code: "INACTIVE_ROOM_TYPE_HAS_LIVE_EVIDENCE",
        source: "pms.room_types",
        sourceId: ROOM_TYPE,
      }),
    );
  });
});

function sourceRows(): IdentitySourceRow[] {
  return [
    row("hotels", {
      id: HOTEL,
      timezone: "UTC",
      same_day_bookings_enabled: true,
      calendar_auto_open_enabled: false,
    }),
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
