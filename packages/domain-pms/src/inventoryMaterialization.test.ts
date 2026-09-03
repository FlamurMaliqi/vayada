import { describe, expect, expectTypeOf, it } from "vitest";

import {
  PMS_INVENTORY_HORIZON_MAX_DAYS,
  PMS_INVENTORY_MATERIALIZATION_IDEMPOTENCY,
  PMS_INVENTORY_MATERIALIZATION_CONTRACT_VERSION,
  PMS_INVENTORY_PRECEDENCE,
  PMS_INVENTORY_PROJECTION_REFRESH_DESTINATION,
  evaluatePmsInventoryLaunchReadiness,
  type PmsInventoryDaySnapshot,
  type PmsInventoryLaunchReadinessReadPort,
  type PmsInventoryLaunchReadinessSnapshot,
  type PmsInventoryMaterializationPort,
  type PmsInventoryProjectionRefreshIntent,
} from "./inventoryMaterialization.js";
import {
  parsePmsCanonicalIanaTimeZone,
  type PmsOperatingCalendarCanonicalTimeZoneRegistry,
} from "./operatingCalendar.js";

const source = {
  ownerDomain: "pms" as const,
  entityType: "pms_operating_calendar.v1" as const,
  entityId: "property-1",
  revision: "calendar:2",
};
const timeZoneRegistry: PmsOperatingCalendarCanonicalTimeZoneRegistry = {
  ownerDomain: "hotel_catalog",
  registryVersion: "test-iana-current.v1",
  isCanonicalIanaTimeZone: (value) => value === "Europe/Berlin",
};
const propertyTimeZone = parsePmsCanonicalIanaTimeZone("Europe/Berlin", timeZoneRegistry)!;
const readinessSnapshot = {
  contractVersion: PMS_INVENTORY_MATERIALIZATION_CONTRACT_VERSION,
  propertyId: "property-1",
  configuration: {
    source,
    calendarRevision: 2,
    propertyProfileSource: {
      ownerDomain: "hotel_catalog" as const,
      entityType: "property_profile" as const,
      entityId: "property-1",
      revision: "profile:7",
    },
    propertyTimeZone,
  },
  roomSet: [
    {
      roomTypeId: "room-1",
      sourceRoomFactsRevision: 5,
      sourceRoomUnitsRevision: 3,
      physicalCapacityCount: 10,
      startingSellableLimitCount: 8,
    },
  ],
  materializedRevision: 2,
  coverage: {
    configurationSource: source,
    materializedRevision: 2,
    coverageFrom: "2026-08-03",
    coverageThrough: "2027-08-03",
    roomTypeIds: ["room-1"],
    expectedDayCount: 366,
    materializedDayCount: 366,
    gaps: [],
  },
  sellableLimits: [
    {
      roomTypeId: "room-1",
      sourceRoomFactsRevision: 5,
      sourceRoomUnitsRevision: 3,
      physicalCapacityCount: 10,
      configuredSellableLimitCount: 8,
      minimumEffectiveSellableLimitCount: 0,
      maximumEffectiveSellableLimitCount: 8,
    },
  ],
} satisfies PmsInventoryLaunchReadinessSnapshot;

describe("PMS inventory materialization contract", () => {
  it("freezes owner precedence and the bounded hotel-local horizon", () => {
    expect(PMS_INVENTORY_HORIZON_MAX_DAYS).toBe(366);
    expect(PMS_INVENTORY_PRECEDENCE).toEqual({
      availabilityGate: "operating_closure",
      sellableLimit: ["manual", "channel", "generated"],
      capacityConsumers: ["booking", "block"],
    });
    expect(PMS_INVENTORY_MATERIALIZATION_IDEMPOTENCY).toEqual({
      operationScope: "pms",
      operation: "pms.inventory.materialize",
      keyScope: "property",
      exactReplay: "original_response",
      replaySideEffects: "none",
      changedFingerprint: "idempotency_key_conflict",
      inProgress: "command_in_progress",
    });
  });

  it("keeps every source revision and effective-limit invariant explicit", () => {
    const day: PmsInventoryDaySnapshot = {
      propertyId: "property-1",
      roomTypeId: "room-1",
      stayDate: "2026-08-03",
      calendarRevision: 2,
      inventoryRevision: 9,
      sourceRevisions: { generated: 2, channel: 4, manual: 5, block: 6, booking: 7 },
      operatingStatus: "closed",
      physicalCapacityCount: 10,
      generatedSellableLimitCount: 8,
      channelSellableLimitCount: 7,
      manualSellableLimitCount: 6,
      effectiveSellableLimitCount: 6,
      assignedCount: 2,
      blockedCount: 1,
      linkedStopSell: false,
      linkedSourceRevision: 0,
      availableCount: 0,
    };
    expect(day.sourceRevisions).toEqual({
      generated: 2,
      channel: 4,
      manual: 5,
      block: 6,
      booking: 7,
    });
    expect(day.availableCount).toBe(0);
    expect(day.effectiveSellableLimitCount).toBeLessThanOrEqual(day.physicalCapacityCount);
    expect(day.assignedCount + day.blockedCount).toBeLessThanOrEqual(day.physicalCapacityCount);
  });

  it("routes only a source-resolving projection refresh intent", () => {
    const intent: PmsInventoryProjectionRefreshIntent = {
      contractVersion: PMS_INVENTORY_MATERIALIZATION_CONTRACT_VERSION,
      destination: PMS_INVENTORY_PROJECTION_REFRESH_DESTINATION,
      eventType: "pms.inventory.projection_refresh_requested",
      organizationId: "organization-1",
      propertyId: "property-1",
      configurationSource: {
        ...source,
      },
      materializedRevision: 2,
      coverageFrom: "2026-08-03",
      coverageThrough: "2027-08-03",
      roomTypeIds: ["room-1"],
      reason: "rematerialization",
    };
    expect(intent.destination).toBe("distribution.inventory-projection");
    expect(Object.keys(intent)).not.toContain("publicRows");
  });

  it("excludes temporary availability from launch-configuration evidence", () => {
    expectTypeOf<PmsInventoryLaunchReadinessSnapshot>().not.toHaveProperty("availableCount");
    expectTypeOf<PmsInventoryLaunchReadinessSnapshot>().not.toHaveProperty("soldOut");
  });

  it("evaluates ready evidence and fails closed on stale or invalid evidence", () => {
    expect(
      evaluatePmsInventoryLaunchReadiness(readinessSnapshot, {
        from: "2026-08-03",
        through: "2027-08-03",
      }),
    ).toEqual({
      ready: true,
      snapshot: readinessSnapshot,
      requiredCoverage: { from: "2026-08-03", through: "2027-08-03" },
      blockers: [],
    });
    expect(
      evaluatePmsInventoryLaunchReadiness(
        {
          ...readinessSnapshot,
          materializedRevision: 1,
          coverage: {
            ...readinessSnapshot.coverage,
            gaps: [{ roomTypeId: "room-1", stayDate: "2026-09-01" }],
          },
          sellableLimits: [
            {
              ...readinessSnapshot.sellableLimits[0]!,
              maximumEffectiveSellableLimitCount: 11,
            },
          ],
        },
        { from: "2026-08-03", through: "2027-08-03" },
      ),
    ).toMatchObject({
      ready: false,
      blockers: [
        "calendar_revision_mismatch",
        "coverage_gap",
        "sellable_limit_invariant_violation",
      ],
    });
  });

  it("derives full-horizon coverage instead of trusting self-reported counts", () => {
    const incompleteSnapshot = {
      ...readinessSnapshot,
      coverage: {
        ...readinessSnapshot.coverage,
        expectedDayCount: 1,
        materializedDayCount: 1,
      },
    } satisfies PmsInventoryLaunchReadinessSnapshot;
    expect(
      evaluatePmsInventoryLaunchReadiness(incompleteSnapshot, {
        from: "2026-08-03",
        through: "2027-08-03",
      }),
    ).toMatchObject({ ready: false, blockers: ["coverage_gap"] });
    for (const requiredCoverage of [
      { from: "2026-08-03", through: "2027-08-04" },
      { from: "2027-08-03", through: "2026-08-03" },
    ]) {
      expect(
        evaluatePmsInventoryLaunchReadiness(readinessSnapshot, requiredCoverage),
      ).toMatchObject({ ready: false, blockers: ["coverage_gap"] });
    }
    expect(
      evaluatePmsInventoryLaunchReadiness(
        {
          ...readinessSnapshot,
          coverage: {
            ...readinessSnapshot.coverage,
            coverageFrom: "0000-00-00",
            coverageThrough: "9999-99-99",
          },
        },
        { from: "2026-08-03", through: "2027-08-03" },
      ),
    ).toMatchObject({ ready: false, blockers: ["coverage_gap"] });
    expect(
      evaluatePmsInventoryLaunchReadiness(
        {
          ...incompleteSnapshot,
          roomSet: [],
          coverage: { ...incompleteSnapshot.coverage, roomTypeIds: [] },
          sellableLimits: [],
        },
        { from: "2026-08-03", through: "2027-08-03" },
      ),
    ).toMatchObject({ ready: false, blockers: ["coverage_gap", "room_set_mismatch"] });
  });

  it("accepts continuous materialized coverage that safely contains the launch window", () => {
    expect(
      evaluatePmsInventoryLaunchReadiness(
        {
          ...readinessSnapshot,
          coverage: {
            ...readinessSnapshot.coverage,
            coverageThrough: "2027-08-30",
            expectedDayCount: 393,
            materializedDayCount: 393,
          },
        },
        { from: "2026-08-03", through: "2027-08-03" },
      ),
    ).toMatchObject({ ready: true, blockers: [] });
  });

  it("rejects negative configured limits without blocking intentional lower overrides", () => {
    expect(
      evaluatePmsInventoryLaunchReadiness(
        {
          ...readinessSnapshot,
          sellableLimits: [
            {
              ...readinessSnapshot.sellableLimits[0]!,
              maximumEffectiveSellableLimitCount: 5,
            },
          ],
        },
        { from: "2026-08-03", through: "2027-08-03" },
      ),
    ).toMatchObject({ ready: true, blockers: [] });
    expect(
      evaluatePmsInventoryLaunchReadiness(
        {
          ...readinessSnapshot,
          roomSet: [{ ...readinessSnapshot.roomSet[0]!, startingSellableLimitCount: -1 }],
          sellableLimits: [
            { ...readinessSnapshot.sellableLimits[0]!, configuredSellableLimitCount: -1 },
          ],
        },
        { from: "2026-08-03", through: "2027-08-03" },
      ),
    ).toMatchObject({ ready: false, blockers: ["sellable_limit_invariant_violation"] });
  });

  it("requires a refresh intent for changed success and none for unchanged success", () => {
    expectTypeOf<
      Extract<
        Awaited<ReturnType<PmsInventoryMaterializationPort["materializeInventory"]>>,
        { ok: true; projectionRefreshIntent: PmsInventoryProjectionRefreshIntent }
      >
    >().toHaveProperty("projectionRefreshIntent");
    expectTypeOf<
      Extract<
        Awaited<ReturnType<PmsInventoryMaterializationPort["materializeInventory"]>>,
        { ok: true; outcome: "unchanged" }
      >["projectionRefreshIntent"]
    >().toEqualTypeOf<null>();
  });

  it("exposes transaction-free materialization and readiness ports", () => {
    expectTypeOf<PmsInventoryMaterializationPort["materializeInventory"]>().toBeFunction();
    expectTypeOf<
      Parameters<PmsInventoryMaterializationPort["materializeInventory"]>[0]
    >().not.toHaveProperty("transaction");
    expectTypeOf<
      PmsInventoryLaunchReadinessReadPort["getInventoryLaunchReadiness"]
    >().toBeFunction();
  });
});
