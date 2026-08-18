import { describe, expect, it } from "vitest";

import {
  optimizePmsRoomAssignmentsInTransaction,
  type PmsRoomAssignmentOptimizationClient,
  type PmsRoomAssignmentOptimizationCommand,
} from "./pmsRoomAssignmentOptimizer.js";

const propertyId = "11111111-1111-4111-8111-111111111111";
const roomTypeId = "22222222-2222-4222-8222-222222222222";
const roomIds = [
  "30000000-0000-4000-8000-000000000001",
  "30000000-0000-4000-8000-000000000002",
  "30000000-0000-4000-8000-000000000003",
];
const assignmentIds = [
  "40000000-0000-4000-8000-000000000001",
  "40000000-0000-4000-8000-000000000002",
  "40000000-0000-4000-8000-000000000003",
];
const bookingIds = [
  "50000000-0000-4000-8000-000000000001",
  "50000000-0000-4000-8000-000000000002",
  "50000000-0000-4000-8000-000000000003",
];
const command: PmsRoomAssignmentOptimizationCommand = {
  propertyId,
  roomTypeId,
  reason: "create",
  currentDate: "2026-08-18",
  commandId: "optimize-create-room-type-1",
  correlationId: "corr-1",
  actor: { kind: "system" },
};

type Call = { text: string; values: readonly unknown[] };

describe("PMS room assignment optimizer command", () => {
  it("packs exact future stays atomically and replays without duplicate evidence", async () => {
    const { client, calls } = setup();

    const first = await optimizePmsRoomAssignmentsInTransaction(client, command);
    const replay = await optimizePmsRoomAssignmentsInTransaction(client, command);

    expect(first).toMatchObject({ outcome: "optimized", usedRoomsBefore: 3, usedRoomsAfter: 1 });
    expect(replay).toEqual(first);
    const moveUpdates = calls.filter(({ text }) =>
      text.includes("UPDATE pms.operational_booking_assignments"),
    );
    expect(moveUpdates).toHaveLength(1);
    const moves = JSON.parse(String(moveUpdates[0]!.values[2]));
    expect(moves).toEqual([
      {
        assignment_id: assignmentIds[1],
        from_room_id: roomIds[1],
        to_room_id: roomIds[0],
        assignment_status: "assigned",
        check_in: "2026-08-22",
        check_out: "2026-08-24",
        version: "reservation-v2",
      },
      {
        assignment_id: assignmentIds[2],
        from_room_id: roomIds[2],
        to_room_id: roomIds[0],
        assignment_status: "assigned",
        check_in: "2026-08-24",
        check_out: "2026-08-26",
        version: "reservation-v3",
      },
    ]);
    expect(moveUpdates[0]!.text).toContain("booking.lifecycle_status = 'confirmed'");
    expect(moveUpdates[0]!.text).toContain("pinnedToRoom");
    expect(calls.filter(({ text }) => text.includes("platform.product_audit_events"))).toHaveLength(
      1,
    );
    expect(calls.filter(({ text }) => text.includes("platform.outbox_events"))).toHaveLength(1);
    const locks = [
      "pg_advisory_xact_lock",
      "FROM pms.rooms",
      "FROM pms.operational_booking_assignments assignment",
      "FROM booking.guest_bookings",
    ].map((fragment) => order(calls, fragment));
    expect(locks.every((index) => index >= 0)).toBe(true);
    expect(locks).toEqual([...locks].sort((left, right) => left - right));
    expect(calls[locks[1]!]!.text).toContain("FOR UPDATE");
    expect(calls[locks[2]!]!.text).toContain("FOR UPDATE OF assignment");
    expect(calls[locks[3]!]!.text).toContain("FOR UPDATE");
  });

  it("fails safely when a generic capacity block is active", async () => {
    const { client, calls } = setup({ genericBlock: true });

    await expect(optimizePmsRoomAssignmentsInTransaction(client, command)).resolves.toEqual({
      outcome: "invalid_snapshot",
    });
    expect(
      calls.some(({ text }) => text.includes("UPDATE pms.operational_booking_assignments")),
    ).toBe(false);
    expect(calls.some(({ text }) => text.includes("platform.domain_events"))).toBe(false);
  });

  it("rejects a stale guarded move before evidence or completion", async () => {
    const { client, calls } = setup({ moveRowCount: 0 });

    await expect(optimizePmsRoomAssignmentsInTransaction(client, command)).rejects.toThrow(
      "snapshot changed",
    );
    expect(calls.some(({ text }) => text.includes("platform.domain_events"))).toBe(false);
    expect(completionCalls(calls)).toHaveLength(0);
  });

  it("does not complete the command when evidence fails", async () => {
    const { client, calls, state } = setup({ evidenceFailure: true });

    await expect(runInTransaction(client, command)).rejects.toThrow("forced evidence failure");
    expect(
      calls.some(({ text }) => text.includes("UPDATE pms.operational_booking_assignments")),
    ).toBe(true);
    expect(completionCalls(calls)).toHaveLength(0);
    expect(calls.at(-1)?.text).toBe("ROLLBACK");
    expect(state).toEqual({
      assignmentsChanged: 0,
      idempotencyRows: 0,
      events: 0,
      audits: 0,
      outbox: 0,
    });
  });

  it("releases budget exhaustion for a higher-budget retry", async () => {
    const { client, calls } = setup({ budgetFixture: true });

    await expect(
      optimizePmsRoomAssignmentsInTransaction(client, {
        ...command,
        commandId: "budget-room-type-1",
        currentDate: "2026-09-01",
        searchBudget: 500,
      }),
    ).resolves.toMatchObject({ outcome: "budget_exhausted" });
    expect(calls.some(({ text }) => text.includes("DELETE FROM platform.idempotency_keys"))).toBe(
      true,
    );
    expect(
      calls.some(({ text }) => text.includes("UPDATE pms.operational_booking_assignments")),
    ).toBe(false);
    expect(completionCalls(calls)).toHaveLength(0);
  });
});

function setup(
  options: {
    genericBlock?: boolean;
    moveRowCount?: number;
    evidenceFailure?: boolean;
    budgetFixture?: boolean;
  } = {},
): {
  client: PmsRoomAssignmentOptimizationClient;
  calls: Call[];
  state: {
    assignmentsChanged: number;
    idempotencyRows: number;
    events: number;
    audits: number;
    outbox: number;
  };
} {
  const calls: Call[] = [];
  const state = { assignmentsChanged: 0, idempotencyRows: 0, events: 0, audits: 0, outbox: 0 };
  let snapshot = { ...state };
  let fingerprint = "";
  let attemptId = "";
  let stored: Record<string, unknown> | null = null;
  const query = async (text: string, values: readonly unknown[] = []) => {
    calls.push({ text, values });
    if (text === "BEGIN") {
      snapshot = { ...state };
      return { rows: [], rowCount: 0 };
    }
    if (text === "COMMIT") return { rows: [], rowCount: 0 };
    if (text === "ROLLBACK") {
      Object.assign(state, snapshot);
      return { rows: [], rowCount: 0 };
    }
    if (text.includes("SELECT status") && text.includes("platform.idempotency_keys")) {
      return { rows: stored ? [stored] : [], rowCount: stored ? 1 : 0 };
    }
    if (text.includes("INSERT INTO platform.idempotency_keys")) {
      state.idempotencyRows += 1;
      fingerprint = String(values[2]);
      attemptId = String(values[7]);
      return { rows: [{ id: "60000000-0000-4000-8000-000000000001" }], rowCount: 1 };
    }
    if (text.includes("pg_advisory_xact_lock")) return { rows: [], rowCount: 1 };
    if (text.includes("FROM pms.rooms")) {
      const ids = options.budgetFixture
        ? Array.from({ length: 8 }, (_, index) => `r${index}`)
        : roomIds;
      return {
        rows: ids.map((roomId, index) => ({
          roomId,
          sortOrder: index + 1,
          status: "available",
          operationalLabelStatus: "verified",
          roomNumber: String(index + 1),
        })),
        rowCount: ids.length,
      };
    }
    if (text.includes("effective_room_assignment_optimization_settings")) {
      return { rows: [{ enabled: true }], rowCount: 1 };
    }
    if (text.includes("FROM pms.operational_booking_assignments assignment")) {
      if (options.budgetFixture) {
        return {
          rows: budgetStays.map(([roomId, checkIn, checkOut, movable], index) => ({
            assignmentId: `s${index}`,
            guestBookingId: `b${index}`,
            roomId,
            assignmentStatus: movable ? "assigned" : "checked_in",
            stayEvidenceKind: "exact",
            checkIn: `2026-09-${checkIn}`,
            checkOut: `2026-09-${checkOut}`,
            pinned: false,
            version: "reservation-v1",
          })),
          rowCount: budgetStays.length,
        };
      }
      return {
        rows: assignmentIds.map((assignmentId, index) => ({
          assignmentId,
          guestBookingId: bookingIds[index],
          roomId: roomIds[index],
          assignmentStatus: "assigned",
          stayEvidenceKind: "exact",
          checkIn: `2026-08-${20 + index * 2}`,
          checkOut: `2026-08-${22 + index * 2}`,
          pinned: false,
          version: `reservation-v${index + 1}`,
        })),
        rowCount: 3,
      };
    }
    if (text.includes("FROM booking.guest_bookings")) {
      const ids = options.budgetFixture
        ? Array.from({ length: budgetStays.length }, (_, index) => `b${index}`)
        : bookingIds;
      return {
        rows: ids.map((guestBookingId) => ({
          guestBookingId,
          lifecycleStatus: "confirmed",
        })),
        rowCount: ids.length,
      };
    }
    if (text.includes("FROM pms.room_blocks")) {
      return options.genericBlock
        ? {
            rows: [
              {
                blockId: "block",
                roomId: null,
                checkIn: "2026-08-20",
                checkOut: "2026-08-27",
                blockedCount: 1,
              },
            ],
            rowCount: 1,
          }
        : { rows: [], rowCount: 0 };
    }
    if (text.includes("UPDATE pms.operational_booking_assignments")) {
      const rowCount = options.moveRowCount ?? 2;
      state.assignmentsChanged += rowCount;
      return { rows: [], rowCount };
    }
    if (text.includes("SELECT id FROM platform.idempotency_keys")) {
      return { rows: values[4] === attemptId ? [{ id: values[0] }] : [], rowCount: 1 };
    }
    if (text.includes("INSERT INTO platform.domain_events")) {
      state.events += 1;
      return { rows: [{ eventId: "70000000-0000-4000-8000-000000000001" }], rowCount: 1 };
    }
    if (text.includes("INSERT INTO platform.product_audit_events")) {
      state.audits += 2;
      return { rows: [], rowCount: 2 };
    }
    if (text.includes("INSERT INTO platform.outbox_events")) {
      if (options.evidenceFailure) throw new Error("forced evidence failure");
      state.outbox += 1;
      return { rows: [], rowCount: 1 };
    }
    if (text.includes("UPDATE platform.idempotency_keys")) {
      stored = {
        status: "completed",
        responseStatusCode: 200,
        requestFingerprintHash: fingerprint,
        responseBodyHash: values[1],
        idempotencyMetadata: { result: JSON.parse(String(values[3])) },
        expiresAt: "2099-08-19T00:00:00.000Z",
      };
      return { rows: [], rowCount: 1 };
    }
    if (text.includes("DELETE FROM platform.idempotency_keys")) return { rows: [], rowCount: 1 };
    throw new Error(`Unhandled SQL: ${text}`);
  };
  return { client: { query: query as PmsRoomAssignmentOptimizationClient["query"] }, calls, state };
}

async function runInTransaction(
  client: PmsRoomAssignmentOptimizationClient,
  input: PmsRoomAssignmentOptimizationCommand,
) {
  await client.query("BEGIN");
  try {
    const result = await optimizePmsRoomAssignmentsInTransaction(client, input);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
}

function order(calls: readonly Call[], fragment: string): number {
  return calls.findIndex(({ text }) => text.includes(fragment));
}

function completionCalls(calls: readonly Call[]): Call[] {
  return calls.filter(({ text }) => text.includes("UPDATE platform.idempotency_keys"));
}

const budgetStays = [
  ["r7", "12", "20", false],
  [null, "14", "20", true],
  ["r0", "20", "27", true],
  [null, "10", "15", true],
  ["r4", "03", "07", false],
  ["r4", "04", "10", true],
  [null, "01", "07", true],
  ["r3", "19", "23", true],
  [null, "14", "22", true],
  [null, "09", "16", true],
  [null, "05", "11", true],
  [null, "07", "13", true],
  [null, "01", "02", true],
  [null, "09", "10", true],
  ["r4", "13", "20", false],
  [null, "13", "17", true],
  [null, "12", "13", true],
  ["r5", "16", "18", false],
  [null, "07", "11", true],
  ["r5", "02", "07", true],
  ["r5", "04", "11", false],
  [null, "04", "07", true],
  ["r3", "04", "09", false],
  [null, "14", "19", true],
] as const;
