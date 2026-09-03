import { describe, expect, it } from "vitest";

import {
  PMS_OPERATING_CALENDAR_CONTRACT_VERSION,
  parsePmsCanonicalIanaTimeZone,
  parsePmsOperatingCalendarMonthDay,
  type PmsOperatingCalendarCanonicalTimeZoneRegistry,
  type PmsOperatingCalendarConfigurationSnapshot,
} from "./operatingCalendar.js";
import {
  planPmsInventoryMaterialization,
  type PmsInventoryMaterializationPlannerInput,
} from "./inventoryMaterializationPlanner.js";
import type { PmsInventoryDaySnapshot } from "./inventoryMaterialization.js";

const PROPERTY_ID = "a1000000-0000-4000-8000-000000000001";
const ROOM_B = "a3000000-0000-4000-8000-000000000003";
const ROOM_A = "a2000000-0000-4000-8000-000000000002";
const source = {
  ownerDomain: "pms" as const,
  entityType: "pms_operating_calendar.v1" as const,
  entityId: PROPERTY_ID,
  revision: "calendar:2",
};
const timeZoneRegistry: PmsOperatingCalendarCanonicalTimeZoneRegistry = {
  ownerDomain: "hotel_catalog",
  registryVersion: "test-iana-current.v1",
  isCanonicalIanaTimeZone: (value) => value === "Europe/Berlin",
};
const propertyTimeZone = parsePmsCanonicalIanaTimeZone("Europe/Berlin", timeZoneRegistry)!;
const winterStart = parsePmsOperatingCalendarMonthDay("12-20")!;
const winterEnd = parsePmsOperatingCalendarMonthDay("01-10")!;
const configuration = {
  contractVersion: PMS_OPERATING_CALENDAR_CONTRACT_VERSION,
  propertyId: PROPERTY_ID,
  calendarRevision: 2,
  source,
  sourceInputs: {
    propertyProfile: {
      ownerDomain: "hotel_catalog" as const,
      entityType: "property_profile" as const,
      entityId: PROPERTY_ID,
      revision: "profile:7",
    },
    propertyTimeZone,
    roomBindings: [
      {
        roomTypeId: ROOM_A,
        sourceRoomFactsRevision: 5,
        sourceRoomUnitsRevision: 3,
        physicalCapacityCount: 10,
        startingSellableLimitCount: 8,
      },
      {
        roomTypeId: ROOM_B,
        sourceRoomFactsRevision: 6,
        sourceRoomUnitsRevision: 4,
        physicalCapacityCount: 2,
        startingSellableLimitCount: 2,
      },
    ],
  },
  schedule: {
    mode: "recurring" as const,
    periods: [{ startsOn: winterStart, endsOn: winterEnd }],
  },
  defaultMinimumStayNights: 2,
  createdAt: "2026-08-03T12:00:00.000Z",
  updatedAt: "2026-08-03T12:00:00.000Z",
} satisfies PmsOperatingCalendarConfigurationSnapshot;
const baseInput = {
  propertyId: PROPERTY_ID,
  configurationSource: source,
  configuration,
  horizon: { from: "2026-12-19", through: "2026-12-21" },
  currentDays: [],
} satisfies PmsInventoryMaterializationPlannerInput;

function currentDay(
  roomTypeId: string,
  stayDate: string,
  overrides: Partial<PmsInventoryDaySnapshot> = {},
): PmsInventoryDaySnapshot {
  const capacity = roomTypeId === ROOM_A ? 10 : 2;
  const generatedLimit = roomTypeId === ROOM_A ? 8 : 2;
  const operatingStatus = stayDate === "2026-12-19" ? "closed" : "open";
  return {
    propertyId: PROPERTY_ID,
    roomTypeId,
    stayDate,
    calendarRevision: 2,
    inventoryRevision: 1,
    sourceRevisions: { generated: 2, channel: 0, manual: 0, block: 0, booking: 0 },
    operatingStatus,
    physicalCapacityCount: capacity,
    generatedSellableLimitCount: generatedLimit,
    channelSellableLimitCount: null,
    manualSellableLimitCount: null,
    effectiveSellableLimitCount: generatedLimit,
    assignedCount: 0,
    blockedCount: 0,
    linkedStopSell: false,
    linkedSourceRevision: 0,
    availableCount: operatingStatus === "open" ? generatedLimit : 0,
    ...overrides,
  };
}

describe("PMS inventory materialization planner", () => {
  it("applies the full horizon with UTC civil dates and code-unit ordering", () => {
    const result = planPmsInventoryMaterialization(baseInput);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.outcome).toBe("applied");
    expect(result.days.map(({ roomTypeId, stayDate }) => [roomTypeId, stayDate])).toEqual([
      [ROOM_A, "2026-12-19"],
      [ROOM_A, "2026-12-20"],
      [ROOM_A, "2026-12-21"],
      [ROOM_B, "2026-12-19"],
      [ROOM_B, "2026-12-20"],
      [ROOM_B, "2026-12-21"],
    ]);
    expect(result.days.map(({ operatingStatus }) => operatingStatus)).toEqual([
      "closed",
      "open",
      "open",
      "closed",
      "open",
      "open",
    ]);
    expect(result.coverage).toMatchObject({
      configurationSource: source,
      materializedRevision: 2,
      expectedDayCount: 6,
      materializedDayCount: 6,
      gaps: [],
    });
  });

  it("iterates leap and DST boundaries as timezone-independent civil dates", () => {
    const fixtures = [
      {
        horizon: { from: "2027-03-27", through: "2027-03-29" },
        dates: ["2027-03-27", "2027-03-28", "2027-03-29"],
      },
      {
        horizon: { from: "2028-02-28", through: "2028-03-01" },
        dates: ["2028-02-28", "2028-02-29", "2028-03-01"],
      },
    ];
    for (const { horizon, dates } of fixtures) {
      const result = planPmsInventoryMaterialization({
        ...baseInput,
        configuration: {
          ...configuration,
          schedule: { mode: "year_round", periods: [] },
        },
        horizon,
      });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect([...new Set(result.days.map(({ stayDate }) => stayDate))]).toEqual(dates);
      }
    }
  });

  it("extends only a complete prefix and exact retry is unchanged", () => {
    const prefix = [currentDay(ROOM_B, "2026-12-19"), currentDay(ROOM_A, "2026-12-19")];
    const extension = planPmsInventoryMaterialization({ ...baseInput, currentDays: prefix });
    expect(extension.ok && extension.outcome).toBe("extended");
    if (!extension.ok) return;
    expect(extension.changedDays).toHaveLength(4);
    const retry = planPmsInventoryMaterialization({ ...baseInput, currentDays: extension.days });
    expect(retry.ok && retry.outcome).toBe("unchanged");
    if (retry.ok) expect(retry.changedDays).toEqual([]);
  });

  it("rematerializes generated fields while preserving every owner value and revision", () => {
    const retained = currentDay(ROOM_A, "2026-12-20", {
      calendarRevision: 1,
      inventoryRevision: 9,
      sourceRevisions: { generated: 1, channel: 4, manual: 5, block: 6, booking: 7 },
      operatingStatus: "closed",
      channelSellableLimitCount: 7,
      manualSellableLimitCount: 6,
      effectiveSellableLimitCount: 6,
      assignedCount: 2,
      blockedCount: 1,
      availableCount: 0,
    });
    const complete = [
      currentDay(ROOM_A, "2026-12-19"),
      retained,
      currentDay(ROOM_A, "2026-12-21"),
      currentDay(ROOM_B, "2026-12-19"),
      currentDay(ROOM_B, "2026-12-20"),
      currentDay(ROOM_B, "2026-12-21"),
    ];
    const result = planPmsInventoryMaterialization({ ...baseInput, currentDays: complete });
    expect(result.ok && result.outcome).toBe("rematerialized");
    if (!result.ok) return;
    const planned = result.days.find(
      ({ roomTypeId, stayDate }) => roomTypeId === ROOM_A && stayDate === "2026-12-20",
    )!;
    expect(planned).toMatchObject({
      calendarRevision: 2,
      inventoryRevision: 10,
      operatingStatus: "open",
      sourceRevisions: { generated: 2, channel: 4, manual: 5, block: 6, booking: 7 },
      channelSellableLimitCount: 7,
      manualSellableLimitCount: 6,
      effectiveSellableLimitCount: 6,
      assignedCount: 2,
      blockedCount: 1,
      availableCount: 3,
    });
  });

  it("keeps closure separate from retained overrides", () => {
    const closed = currentDay(ROOM_A, "2026-12-19", {
      channelSellableLimitCount: 7,
      manualSellableLimitCount: 6,
      effectiveSellableLimitCount: 6,
      assignedCount: 2,
      blockedCount: 1,
      availableCount: 0,
    });
    const result = planPmsInventoryMaterialization({
      ...baseInput,
      horizon: { from: "2026-12-19", through: "2026-12-19" },
      currentDays: [closed, currentDay(ROOM_B, "2026-12-19")],
    });
    expect(result.ok && result.outcome).toBe("unchanged");
    if (!result.ok) return;
    expect(result.days[0]).toMatchObject({
      operatingStatus: "closed",
      manualSellableLimitCount: 6,
      channelSellableLimitCount: 7,
      assignedCount: 2,
      blockedCount: 1,
      availableCount: 0,
    });
  });

  it("gates only the generated limit when a sellable rate is missing", () => {
    const retained = currentDay(ROOM_A, "2026-12-20", {
      channelSellableLimitCount: 7,
      manualSellableLimitCount: 6,
      effectiveSellableLimitCount: 6,
      assignedCount: 2,
      blockedCount: 1,
      availableCount: 3,
    });
    const result = planPmsInventoryMaterialization({
      ...baseInput,
      horizon: { from: "2026-12-20", through: "2026-12-20" },
      currentDays: [retained, currentDay(ROOM_B, "2026-12-20")],
      generatedSellableLimitOverrides: [
        { roomTypeId: ROOM_A, stayDate: "2026-12-20", count: 0 },
        { roomTypeId: ROOM_B, stayDate: "2026-12-20", count: 0 },
      ],
    });
    expect(result.ok && result.outcome).toBe("rematerialized");
    if (!result.ok) return;
    expect(result.days).toEqual([
      expect.objectContaining({
        roomTypeId: ROOM_A,
        generatedSellableLimitCount: 0,
        manualSellableLimitCount: 6,
        channelSellableLimitCount: 7,
        effectiveSellableLimitCount: 6,
        assignedCount: 2,
        blockedCount: 1,
        availableCount: 3,
      }),
      expect.objectContaining({
        roomTypeId: ROOM_B,
        generatedSellableLimitCount: 0,
        effectiveSellableLimitCount: 0,
        availableCount: 0,
      }),
    ]);
  });

  it("preserves linked stop-sell while rematerializing generated fields", () => {
    const linked = currentDay(ROOM_A, "2026-12-20", {
      linkedStopSell: true,
      linkedSourceRevision: 4,
      availableCount: 0,
    });
    const result = planPmsInventoryMaterialization({
      ...baseInput,
      horizon: { from: "2026-12-20", through: "2026-12-20" },
      currentDays: [linked, currentDay(ROOM_B, "2026-12-20")],
    });
    expect(result.ok && result.outcome).toBe("unchanged");
    if (result.ok) {
      expect(result.days[0]).toMatchObject({
        linkedStopSell: true,
        linkedSourceRevision: 4,
        availableCount: 0,
      });
    }
  });

  it("fails closed on scope, gaps, conflicts, and retained invariant violations", () => {
    expect(planPmsInventoryMaterialization({ ...baseInput, propertyId: ROOM_A })).toMatchObject({
      ok: false,
      error: { code: "configuration_scope_mismatch" },
    });
    expect(
      planPmsInventoryMaterialization({
        ...baseInput,
        configurationSource: { ...source, revision: "calendar:1" },
      }),
    ).toMatchObject({ ok: false, error: { code: "configuration_scope_mismatch" } });
    expect(
      planPmsInventoryMaterialization({
        ...baseInput,
        currentDays: [currentDay(ROOM_A, "2026-12-19")],
      }),
    ).toMatchObject({ ok: false, error: { code: "current_day_coverage_gap" } });
    const duplicate = currentDay(ROOM_A, "2026-12-19");
    expect(
      planPmsInventoryMaterialization({ ...baseInput, currentDays: [duplicate, duplicate] }),
    ).toMatchObject({ ok: false, error: { code: "current_day_duplicate" } });
    expect(
      planPmsInventoryMaterialization({
        ...baseInput,
        horizon: { from: "2026-12-19", through: "2026-12-19" },
        currentDays: [
          currentDay(ROOM_A, "2026-12-19", {
            calendarRevision: 3,
            sourceRevisions: { generated: 3, channel: 0, manual: 0, block: 0, booking: 0 },
          }),
          currentDay(ROOM_B, "2026-12-19"),
        ],
      }),
    ).toMatchObject({ ok: false, error: { code: "generated_revision_conflict" } });
    for (const invalid of [
      currentDay(ROOM_A, "2026-12-19", {
        manualSellableLimitCount: 11,
        effectiveSellableLimitCount: 11,
      }),
      currentDay(ROOM_A, "2026-12-19", { physicalCapacityCount: 9 }),
      currentDay(ROOM_A, "2026-12-19", { assignedCount: 9, blockedCount: 2 }),
      currentDay(ROOM_A, "2026-12-19", { effectiveSellableLimitCount: 7 }),
    ]) {
      expect(
        planPmsInventoryMaterialization({
          ...baseInput,
          horizon: { from: "2026-12-19", through: "2026-12-19" },
          currentDays: [invalid, currentDay(ROOM_B, "2026-12-19")],
        }),
      ).toMatchObject({ ok: false, error: { code: "inventory_invariant_violation" } });
    }
  });

  it("rejects malformed civil horizons and hostile current-day containers", () => {
    for (const horizon of [
      { from: "2026-02-30", through: "2026-03-01" },
      { from: "2026-12-21", through: "2026-12-19" },
      { from: "2026-01-01", through: "2027-01-02" },
    ]) {
      expect(planPmsInventoryMaterialization({ ...baseInput, horizon })).toMatchObject({
        ok: false,
        error: { code: "horizon_invalid" },
      });
    }

    const sparse = Array(1) as PmsInventoryDaySnapshot[];
    expect(planPmsInventoryMaterialization({ ...baseInput, currentDays: sparse })).toMatchObject({
      ok: false,
      error: { code: "invalid_input" },
    });
    const accessor = { ...currentDay(ROOM_A, "2026-12-19") } as Record<string, unknown>;
    Object.defineProperty(accessor, "availableCount", { get: () => 0, enumerable: true });
    expect(
      planPmsInventoryMaterialization({
        ...baseInput,
        currentDays: [accessor as PmsInventoryDaySnapshot],
      }),
    ).toMatchObject({ ok: false, error: { code: "current_day_invalid" } });
    const inherited = Object.assign(
      Object.create({ inherited: true }),
      currentDay(ROOM_A, "2026-12-19"),
    ) as PmsInventoryDaySnapshot;
    expect(
      planPmsInventoryMaterialization({ ...baseInput, currentDays: [inherited] }),
    ).toMatchObject({ ok: false, error: { code: "current_day_invalid" } });
  });
});
