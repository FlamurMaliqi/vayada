import { describe, expect, it } from "vitest";

import {
  PMS_ROOM_FACTS_CONTRACT_VERSION,
  parseReconcilePhysicalRoomUnitsCommand,
  parseReconcilePhysicalRoomUnitsResult,
  requireVerifiedPhysicalRoomOperationalIdentity,
  serializeReconcilePhysicalRoomUnitsFingerprint,
  type PhysicalRoomUnitIdentity,
} from "./index.js";

const organizationId = "a1000000-0000-0000-8000-000000000001";
const propertyId = "a1000000-0000-0000-8000-000000000002";
const roomTypeId = "a1000000-0000-0000-8000-000000000003";
const firstUnitId = "a1000000-0000-0000-8000-000000000004";
const secondUnitId = "a1000000-0000-0000-8000-000000000005";
const acceptedAt = "2026-08-03T09:00:00.000Z";

function command(overrides: Record<string, unknown> = {}) {
  return {
    organizationId,
    propertyId,
    roomTypeId,
    expectedRevision: 3,
    targetActiveUnitCount: 4,
    idempotencyKey: "reconcile-deluxe-v4",
    audit: {
      actor: { kind: "user", userId: organizationId },
      requestId: "req-reconcile-1",
      correlationId: "corr-reconcile-1",
      requestedAt: acceptedAt,
    },
    ...overrides,
  };
}

function unit(
  roomUnitId: string,
  overrides: Partial<PhysicalRoomUnitIdentity> = {},
): PhysicalRoomUnitIdentity {
  return {
    contractVersion: PMS_ROOM_FACTS_CONTRACT_VERSION,
    propertyId,
    roomTypeId,
    roomUnitId,
    lifecycle: "active",
    operationalLabel: null,
    operationalLabelStatus: "unverified",
    ...overrides,
  } as PhysicalRoomUnitIdentity;
}

function capacity(roomUnitsRevision: number, activeUnitCount: number) {
  return {
    contractVersion: PMS_ROOM_FACTS_CONTRACT_VERSION,
    propertyId,
    roomTypeId,
    roomUnitsRevision,
    activeUnitCount,
    capturedAt: acceptedAt,
  };
}

describe("physical room unit reconcile contract", () => {
  it("parses and freezes a bounded expected-versioned command", () => {
    const parsed = parseReconcilePhysicalRoomUnitsCommand(command());

    expect(parsed).toEqual(command());
    expect(Object.isFrozen(parsed)).toBe(true);
    expect(Object.isFrozen(parsed?.audit)).toBe(true);
  });

  it.each([
    ["zero target", { targetActiveUnitCount: 0 }],
    ["oversized target", { targetActiveUnitCount: 501 }],
    ["zero revision", { expectedRevision: 0 }],
    ["wrong property", { propertyId: "not-a-uuid" }],
    ["blank idempotency key", { idempotencyKey: " " }],
    ["unknown input", { unknown: true }],
    ["invalid audit time", { audit: { ...command().audit, requestedAt: "today" } }],
  ])("rejects %s", (_label, override) => {
    expect(parseReconcilePhysicalRoomUnitsCommand(command(override))).toBeNull();
  });

  it("serializes only stable business identity in fixed order", () => {
    const parsed = parseReconcilePhysicalRoomUnitsCommand(command());
    expect(parsed).not.toBeNull();

    expect(serializeReconcilePhysicalRoomUnitsFingerprint(parsed!)).toBe(
      JSON.stringify({
        organizationId,
        propertyId,
        roomTypeId,
        expectedRevision: 3,
        targetActiveUnitCount: 4,
      }),
    );
  });

  it("accepts an increase only when every added unit is opaque and unlabeled", () => {
    const result = parseReconcilePhysicalRoomUnitsResult({
      ok: true,
      response: {
        contractVersion: PMS_ROOM_FACTS_CONTRACT_VERSION,
        outcome: "reconciled",
        propertyId,
        roomTypeId,
        previousActiveUnitCount: 2,
        capacity: capacity(4, 4),
        addedUnits: [unit(firstUnitId), unit(secondUnitId)],
        retiredUnitIds: [],
        acceptedAt,
      },
    });

    expect(result).toMatchObject({
      ok: true,
      response: {
        previousActiveUnitCount: 2,
        capacity: { activeUnitCount: 4, roomUnitsRevision: 4 },
      },
    });
    expect(Object.isFrozen(result)).toBe(true);
  });

  it("accepts deterministic retirement identities and unchanged responses", () => {
    expect(
      parseReconcilePhysicalRoomUnitsResult({
        ok: true,
        response: {
          contractVersion: PMS_ROOM_FACTS_CONTRACT_VERSION,
          outcome: "reconciled",
          propertyId,
          roomTypeId,
          previousActiveUnitCount: 4,
          capacity: capacity(4, 2),
          addedUnits: [],
          retiredUnitIds: [secondUnitId, firstUnitId],
          acceptedAt,
        },
      }),
    ).not.toBeNull();

    expect(
      parseReconcilePhysicalRoomUnitsResult({
        ok: true,
        response: {
          contractVersion: PMS_ROOM_FACTS_CONTRACT_VERSION,
          outcome: "unchanged",
          propertyId,
          roomTypeId,
          previousActiveUnitCount: 2,
          capacity: capacity(3, 2),
          addedUnits: [],
          retiredUnitIds: [],
          acceptedAt,
        },
      }),
    ).not.toBeNull();
  });

  it("rejects a command response whose capacity snapshot was captured at another time", () => {
    expect(
      parseReconcilePhysicalRoomUnitsResult({
        ok: true,
        response: {
          contractVersion: PMS_ROOM_FACTS_CONTRACT_VERSION,
          outcome: "unchanged",
          propertyId,
          roomTypeId,
          previousActiveUnitCount: 2,
          capacity: { ...capacity(3, 2), capturedAt: "2026-08-03T08:59:59.000Z" },
          addedUnits: [],
          retiredUnitIds: [],
          acceptedAt,
        },
      }),
    ).toBeNull();
  });

  it.each([
    ["zero final capacity", [], [firstUnitId], 1, 0],
    ["fake generated label", [unit(firstUnitId, { operationalLabel: "101" })], [], 2, 3],
    [
      "verified generated label",
      [
        unit(firstUnitId, {
          operationalLabel: "101",
          operationalLabelStatus: "verified",
        }),
      ],
      [],
      2,
      3,
    ],
    ["duplicate generated ids", [unit(firstUnitId), unit(firstUnitId)], [], 2, 4],
    ["mixed increase and decrease", [unit(firstUnitId)], [secondUnitId], 2, 2],
    ["wrong capacity", [unit(firstUnitId)], [], 2, 4],
    ["unchanged with mutations", [unit(firstUnitId)], [], 2, 3],
  ])("rejects a malformed success: %s", (_label, addedUnits, retiredUnitIds, previous, active) => {
    expect(
      parseReconcilePhysicalRoomUnitsResult({
        ok: true,
        response: {
          contractVersion: PMS_ROOM_FACTS_CONTRACT_VERSION,
          outcome: _label === "unchanged with mutations" ? "unchanged" : "reconciled",
          propertyId,
          roomTypeId,
          previousActiveUnitCount: previous,
          capacity: capacity(4, active),
          addedUnits,
          retiredUnitIds,
          acceptedAt,
        },
      }),
    ).toBeNull();
  });

  it("parses revision and protected-unit conflicts with safe structured blockers", () => {
    expect(
      parseReconcilePhysicalRoomUnitsResult({
        ok: false,
        error: { code: "room_units_revision_conflict", currentRevision: 7 },
      }),
    ).toEqual({
      ok: false,
      error: { code: "room_units_revision_conflict", currentRevision: 7 },
    });

    expect(
      parseReconcilePhysicalRoomUnitsResult({
        ok: false,
        error: {
          code: "physical_unit_reconcile_blocked",
          currentRevision: 7,
          currentActiveUnitCount: 5,
          targetActiveUnitCount: 2,
          safelyRemovableUnitCount: 1,
          blockers: [
            { code: "reservation_assignment", affectedCount: 1 },
            { code: "verified_operational_label", affectedCount: 2 },
          ],
        },
      }),
    ).not.toBeNull();

    expect(
      parseReconcilePhysicalRoomUnitsResult({
        ok: false,
        error: {
          code: "physical_unit_capacity_invariant_violation",
          currentActiveUnitCount: 501,
        },
      }),
    ).not.toBeNull();
  });

  it.each([
    [
      "enough safely removable capacity",
      {
        code: "physical_unit_reconcile_blocked",
        currentRevision: 7,
        currentActiveUnitCount: 5,
        targetActiveUnitCount: 2,
        safelyRemovableUnitCount: 3,
        blockers: [{ code: "reservation_assignment", affectedCount: 1 }],
      },
    ],
    [
      "reference failure mixed with counted blockers",
      {
        code: "physical_unit_reconcile_blocked",
        currentRevision: 7,
        currentActiveUnitCount: 5,
        targetActiveUnitCount: 2,
        safelyRemovableUnitCount: 1,
        blockers: [
          { code: "reference_check_unavailable" },
          { code: "reservation_assignment", affectedCount: 1 },
        ],
      },
    ],
    [
      "blocker count beyond active capacity",
      {
        code: "physical_unit_reconcile_blocked",
        currentRevision: 7,
        currentActiveUnitCount: 5,
        targetActiveUnitCount: 2,
        safelyRemovableUnitCount: 1,
        blockers: [{ code: "reservation_assignment", affectedCount: 6 }],
      },
    ],
  ])("rejects a contradictory blocker result: %s", (_label, error) => {
    expect(parseReconcilePhysicalRoomUnitsResult({ ok: false, error })).toBeNull();
  });

  it.each([
    { code: "setup_scope_unavailable" },
    { code: "room_type_not_found" },
    { code: "idempotency_key_conflict" },
    { code: "command_in_progress" },
  ])("parses coordination/scope error $code", (error) => {
    expect(parseReconcilePhysicalRoomUnitsResult({ ok: false, error })).toEqual({
      ok: false,
      error,
    });
  });

  it("rejects duplicate, empty, and malformed blocker disclosures", () => {
    const base = {
      code: "physical_unit_reconcile_blocked",
      currentRevision: 7,
      currentActiveUnitCount: 5,
      targetActiveUnitCount: 2,
      safelyRemovableUnitCount: 1,
    };
    expect(
      parseReconcilePhysicalRoomUnitsResult({ ok: false, error: { ...base, blockers: [] } }),
    ).toBeNull();
    expect(
      parseReconcilePhysicalRoomUnitsResult({
        ok: false,
        error: {
          ...base,
          blockers: [
            { code: "room_block", affectedCount: 1 },
            { code: "room_block", affectedCount: 2 },
          ],
        },
      }),
    ).toBeNull();
  });
});

describe("physical room operational identity", () => {
  it.each(["assignment", "housekeeping", "check_in"] as const)(
    "permits %s only for an active verified label",
    (use) => {
      expect(
        requireVerifiedPhysicalRoomOperationalIdentity(
          unit(firstUnitId, {
            operationalLabel: "204",
            operationalLabelStatus: "verified",
          }),
          use,
        ),
      ).toEqual({ ok: true, use, roomUnitId: firstUnitId, operationalLabel: "204" });
    },
  );

  it.each([
    ["missing_operational_label", unit(firstUnitId)],
    [
      "unverified_operational_label",
      unit(firstUnitId, { operationalLabel: "204", operationalLabelStatus: "unverified" }),
    ],
    ["room_unit_not_active", unit(firstUnitId, { lifecycle: "retired" })],
  ] as const)("rejects %s for every identity-dependent workflow", (code, physicalUnit) => {
    for (const use of ["assignment", "housekeeping", "check_in"] as const) {
      expect(requireVerifiedPhysicalRoomOperationalIdentity(physicalUnit, use)).toEqual({
        ok: false,
        use,
        roomUnitId: firstUnitId,
        code,
      });
    }
  });
});
