import { describe, expect, it } from "vitest";
import {
  optimizePmsRoomAssignments,
  type PmsRoomAssignmentOptimizationMove,
  type PmsRoomAssignmentOptimizationOccupancy,
  type PmsRoomAssignmentOptimizationRoom,
} from "./roomAssignmentOptimization.js";

const rooms = [
  { roomId: "studio-1", sortOrder: 1 },
  { roomId: "studio-2", sortOrder: 2 },
  { roomId: "studio-3", sortOrder: 3 },
] as const;
const stay = (
  occupancyId: string,
  roomId: string | null,
  checkIn: string,
  checkOut: string,
  movable = true,
): PmsRoomAssignmentOptimizationOccupancy => ({
  occupancyId,
  roomId,
  checkIn,
  checkOut,
  movable,
});
const expectFeasibleAssignments = (
  eligibleRooms: readonly PmsRoomAssignmentOptimizationRoom[],
  occupancies: readonly PmsRoomAssignmentOptimizationOccupancy[],
  moves: readonly PmsRoomAssignmentOptimizationMove[],
) => {
  const eligibleRoomIds = new Set(eligibleRooms.map(({ roomId }) => roomId));
  const originalById = new Map(occupancies.map((occupancy) => [occupancy.occupancyId, occupancy]));

  expect(originalById.size).toBe(occupancies.length);
  expect(new Set(moves.map(({ occupancyId }) => occupancyId)).size).toBe(moves.length);
  for (const move of moves) {
    const original = originalById.get(move.occupancyId);

    expect(original).toBeDefined();
    expect(original?.movable).toBe(true);
    expect(move.fromRoomId).toBe(original?.roomId);
    expect(eligibleRoomIds.has(move.toRoomId)).toBe(true);
    expect(move.toRoomId).not.toBe(move.fromRoomId);
  }
  const movedRooms = new Map(moves.map(({ occupancyId, toRoomId }) => [occupancyId, toRoomId]));
  const assigned = occupancies.map((occupancy) => ({
    ...occupancy,
    roomId: movedRooms.get(occupancy.occupancyId) ?? occupancy.roomId,
  }));

  expect(assigned.every(({ roomId }) => roomId !== null && eligibleRoomIds.has(roomId))).toBe(true);
  for (const roomId of eligibleRoomIds) {
    const stays = assigned
      .filter((occupancy) => occupancy.roomId === roomId)
      .sort((left, right) => left.checkIn.localeCompare(right.checkIn));
    for (let index = 1; index < stays.length; index += 1) {
      expect(stays[index - 1]!.checkOut <= stays[index]!.checkIn).toBe(true);
    }
  }
};

describe("PMS room assignment optimization", () => {
  it("packs same-day turnovers into the lowest room", () => {
    const result = optimizePmsRoomAssignments(rooms, [
      stay("jean", "studio-1", "2026-06-06", "2026-06-11"),
      stay("jennie", "studio-2", "2026-06-11", "2026-06-15"),
      stay("victoria", "studio-3", "2026-06-15", "2026-06-26"),
    ]);

    expect(result).toEqual({
      outcome: "optimized",
      moves: [
        { occupancyId: "jennie", fromRoomId: "studio-2", toRoomId: "studio-1" },
        { occupancyId: "victoria", fromRoomId: "studio-3", toRoomId: "studio-1" },
      ],
      gapNightsBefore: 0,
      gapNightsAfter: 0,
      usedRoomsBefore: 3,
      usedRoomsAfter: 1,
    });
  });

  it("uses another room for overlapping stays and keeps deterministic room order", () => {
    const result = optimizePmsRoomAssignments(rooms, [
      stay("a", "studio-3", "2026-06-06", "2026-06-12"),
      stay("b", "studio-2", "2026-06-08", "2026-06-10"),
      stay("c", "studio-3", "2026-06-12", "2026-06-15"),
    ]);

    expect(result.outcome).toBe("optimized");
    if (result.outcome === "optimized") {
      expect(result.moves).toEqual(
        [
          { occupancyId: "a", fromRoomId: "studio-3", toRoomId: "studio-1" },
          { occupancyId: "b", fromRoomId: "studio-2", toRoomId: "studio-2" },
          { occupancyId: "c", fromRoomId: "studio-3", toRoomId: "studio-1" },
        ].filter(({ fromRoomId, toRoomId }) => fromRoomId !== toRoomId),
      );
    }
  });

  it("assigns a floating booking when packing creates a valid slot", () => {
    const result = optimizePmsRoomAssignments(rooms.slice(0, 2), [
      stay("early", "studio-1", "2026-06-01", "2026-06-05"),
      stay("overlap", "studio-1", "2026-06-03", "2026-06-07"),
      stay("floating", null, "2026-06-05", "2026-06-08"),
    ]);

    expect(result.outcome).toBe("optimized");
    if (result.outcome === "optimized") {
      expect(result.moves).toContainEqual({
        occupancyId: "floating",
        fromRoomId: null,
        toRoomId: "studio-1",
      });
    }
  });

  it("uses fixed-booking lookahead to preserve a later floating stay's only room", () => {
    const result = optimizePmsRoomAssignments(rooms.slice(0, 2), [
      stay("r1-anchor", "studio-1", "2025-12-28", "2026-01-01", false),
      stay("r2-anchor", "studio-2", "2026-01-05", "2026-01-10", false),
      stay("a", "studio-2", "2026-01-01", "2026-01-05"),
      stay("b", null, "2026-01-02", "2026-01-06"),
    ]);

    expect(result.outcome).toBe("optimized");
    if (result.outcome === "optimized") {
      expect(result.moves).toContainEqual({
        occupancyId: "b",
        fromRoomId: null,
        toRoomId: "studio-1",
      });
    }
  });

  it("places the most constrained floating stay before a flexible shorter stay", () => {
    const result = optimizePmsRoomAssignments(rooms.slice(0, 2), [
      stay("f1", "studio-1", "2026-01-01", "2026-01-02", false),
      stay("f2", "studio-2", "2026-01-04", "2026-01-05", false),
      stay("short", null, "2026-01-02", "2026-01-03"),
      stay("long", null, "2026-01-02", "2026-01-05"),
    ]);

    expect(result.outcome).toBe("optimized");
    if (result.outcome === "optimized") {
      expect(result.moves).toEqual([
        { occupancyId: "long", fromRoomId: null, toRoomId: "studio-1" },
        { occupancyId: "short", fromRoomId: null, toRoomId: "studio-2" },
      ]);
    }
  });

  it("reassigns earlier floating stays when their conflicts reveal the feasible packing", () => {
    const occupancies = [
      stay("f0", "studio-1", "2026-01-03", "2026-01-04", false),
      stay("f1", "studio-2", "2026-01-01", "2026-01-02", false),
      stay("f2", "studio-3", "2026-01-08", "2026-01-10", false),
      stay("m0", null, "2026-01-05", "2026-01-10"),
      stay("m1", null, "2026-01-02", "2026-01-06"),
      stay("m2", null, "2026-01-05", "2026-01-09"),
    ];
    const result = optimizePmsRoomAssignments(rooms, occupancies);

    expect(result.outcome).toBe("optimized");
    if (result.outcome === "optimized") {
      expect(result.moves).toHaveLength(3);
      expect(new Set(result.moves.map(({ toRoomId }) => toRoomId))).toEqual(
        new Set(["studio-1", "studio-2", "studio-3"]),
      );
      expectFeasibleAssignments(rooms, occupancies, result.moves);
    }
  });

  it("keeps an existing feasible layout when a greedy move would add gap-nights", () => {
    const result = optimizePmsRoomAssignments(rooms.slice(0, 2), [
      stay("r1-anchor", "studio-1", "2026-01-01", "2026-01-05", false),
      stay("r2-before", "studio-2", "2026-01-01", "2026-01-03", false),
      stay("r2-after", "studio-2", "2026-01-20", "2026-01-25", false),
      stay("movable", "studio-2", "2026-01-05", "2026-01-10"),
    ]);

    expect(result).toMatchObject({
      outcome: "optimized",
      moves: [],
      gapNightsBefore: 12,
      gapNightsAfter: 12,
    });
  });

  it("never moves or overlaps blocks and in-house stays", () => {
    const result = optimizePmsRoomAssignments(rooms.slice(0, 2), [
      stay("in-house", "studio-1", "2026-06-01", "2026-06-20", false),
      stay("block", "studio-2", "2026-06-10", "2026-06-12", false),
      stay("future", "studio-1", "2026-06-10", "2026-06-15"),
    ]);

    expect(result).toEqual({ outcome: "infeasible", unassignedOccupancyIds: ["future"] });
  });

  it("prefers an occupied room over opening an empty room", () => {
    const result = optimizePmsRoomAssignments(rooms, [
      stay("first", "studio-3", "2026-06-01", "2026-06-05"),
      stay("second", "studio-2", "2026-06-07", "2026-06-10"),
    ]);

    expect(result.outcome).toBe("optimized");
    if (result.outcome === "optimized") {
      expect(result.moves).toEqual([
        { occupancyId: "first", fromRoomId: "studio-3", toRoomId: "studio-1" },
        { occupancyId: "second", fromRoomId: "studio-2", toRoomId: "studio-1" },
      ]);
      expect(result.gapNightsAfter).toBe(2);
    }
  });

  it("rejects malformed dates instead of normalizing them", () => {
    expect(() =>
      optimizePmsRoomAssignments(rooms, [stay("bad", "studio-1", "2026-02-30", "2026-03-02")]),
    ).toThrow("occupancy is invalid");
  });

  it("optimizes a representative 20-room workload", () => {
    const workloadRooms = Array.from({ length: 20 }, (_, index) => ({
      roomId: `room-${index + 1}`,
      sortOrder: index + 1,
    }));
    const workload = Array.from({ length: 2_000 }, (_, index) => {
      const checkIn = new Date(Date.UTC(2026, 0, index + 1));
      const checkOut = new Date(Date.UTC(2026, 0, index + 2));
      return stay(
        `stay-${index}`,
        workloadRooms[index % workloadRooms.length]!.roomId,
        checkIn.toISOString().slice(0, 10),
        checkOut.toISOString().slice(0, 10),
      );
    });
    expect(optimizePmsRoomAssignments(workloadRooms, workload).outcome).toBe("optimized");
  });

  it("rejects an overcapacity 20-room workload", () => {
    const workloadRooms = Array.from({ length: 20 }, (_, index) => ({
      roomId: `room-${index + 1}`,
      sortOrder: index + 1,
    }));
    const workload = Array.from({ length: 21 }, (_, index) =>
      stay(`stay-${index}`, null, "2026-06-01", "2026-06-02"),
    );
    expect(optimizePmsRoomAssignments(workloadRooms, workload).outcome).toBe("infeasible");
  });

  it("reassigns a feasible four-room multi-week snapshot without conflicts", () => {
    const fourRooms = [...rooms, { roomId: "studio-4", sortOrder: 4 }];
    const occupancies = [
      stay("f0", "studio-1", "2026-01-11", "2026-01-15", false),
      stay("f1", "studio-2", "2026-01-02", "2026-01-03", false),
      stay("f2", "studio-3", "2026-01-12", "2026-01-15", false),
      stay("f3", "studio-4", "2026-01-18", "2026-01-23", false),
      stay("m0", null, "2026-01-02", "2026-01-05"),
      stay("m1", null, "2026-01-17", "2026-01-22"),
      stay("m2", null, "2026-01-03", "2026-01-09"),
      stay("m3", null, "2026-01-13", "2026-01-16"),
      stay("m4", null, "2026-01-17", "2026-01-21"),
      stay("m5", null, "2026-01-04", "2026-01-10"),
      stay("m6", null, "2026-01-17", "2026-01-20"),
      stay("m7", null, "2026-01-06", "2026-01-10"),
      stay("m8", null, "2026-01-15", "2026-01-18"),
    ];
    const result = optimizePmsRoomAssignments(fourRooms, occupancies);

    expect(result.outcome).toBe("optimized");
    if (result.outcome === "optimized") {
      expectFeasibleAssignments(fourRooms, occupancies, result.moves);
    }
  });
});
