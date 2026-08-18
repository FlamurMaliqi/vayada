import type { PmsManualBookingCreateCommand } from "@vayada/domain-pms";
import { describe, expect, it, vi } from "vitest";

import type { PmsManualBookingTransaction } from "./pmsManualBookingTransactionPorts.js";
import type { PmsRoomAssignmentOptimizationCommand } from "./pmsRoomAssignmentOptimizer.js";
import { createPmsRoomAssignmentOptimizationTriggerPort } from "./pmsRoomAssignmentOptimizationTriggers.js";

const propertyId = "81000000-0000-4000-8000-000000000001";
const roomTypeA = "81000000-0000-4000-8000-000000000010";
const roomTypeB = "81000000-0000-4000-8000-000000000020";

describe("PMS room assignment optimization triggers", () => {
  it("optimizes each created room type in stable order with the property-local date", async () => {
    const query = vi.fn(async () => ({ rows: [{ timeZone: "Pacific/Kiritimati" }], rowCount: 1 }));
    const optimize = vi.fn(
      async (
        _transaction: PmsManualBookingTransaction,
        _command: PmsRoomAssignmentOptimizationCommand,
      ) => ({
        outcome: "optimized" as const,
        moves: [],
        gapNightsBefore: 0,
        gapNightsAfter: 0,
        usedRoomsBefore: 1,
        usedRoomsAfter: 1,
      }),
    );
    const port = createPmsRoomAssignmentOptimizationTriggerPort({ optimize });
    const command = {
      propertyId,
      commandId: "manual-create-1",
      audit: {
        actor: { kind: "user", userId: "81000000-0000-4000-8000-000000000099" },
        requestId: "request-1",
        correlationId: "correlation-1",
      },
    } as PmsManualBookingCreateCommand;

    await expect(
      port.afterCreate({
        transaction: { query } as unknown as PmsManualBookingTransaction,
        command,
        rooms: [
          { roomId: "room-b", roomTypeId: roomTypeB },
          { roomId: "room-a-2", roomTypeId: roomTypeA },
          { roomId: "room-a-1", roomTypeId: roomTypeA },
        ],
        acceptedAt: new Date("2026-08-17T12:30:00.000Z"),
      }),
    ).resolves.toHaveLength(2);

    expect(optimize.mock.calls.map(([, value]) => value)).toEqual([
      {
        propertyId,
        roomTypeId: roomTypeA,
        reason: "create",
        currentDate: "2026-08-18",
        commandId: `manual-create-1:optimize:create:${roomTypeA}`,
        correlationId: "correlation-1",
        causationId: "manual-create-1",
        actor: { kind: "user", userId: "81000000-0000-4000-8000-000000000099" },
      },
      expect.objectContaining({
        roomTypeId: roomTypeB,
        currentDate: "2026-08-18",
        correlationId: "correlation-1",
      }),
    ]);
    expect(query).toHaveBeenCalledWith(expect.stringContaining("FOR SHARE"), [propertyId]);
  });

  it("fails closed before optimization when the property timezone is unavailable", async () => {
    const optimize = vi.fn();
    const port = createPmsRoomAssignmentOptimizationTriggerPort({ optimize });
    await expect(
      port.afterCreate({
        transaction: {
          query: vi.fn(async () => ({ rows: [{ timeZone: null }], rowCount: 1 })),
        } as unknown as PmsManualBookingTransaction,
        command: { propertyId } as PmsManualBookingCreateCommand,
        rooms: [{ roomId: "room-a", roomTypeId: roomTypeA }],
        acceptedAt: new Date("2026-08-18T00:00:00.000Z"),
      }),
    ).rejects.toThrow("property timezone is unavailable");
    expect(optimize).not.toHaveBeenCalled();
  });

  it("retries budget exhaustion once with the maximum bounded budget", async () => {
    const optimize = vi
      .fn()
      .mockResolvedValueOnce({
        outcome: "budget_exhausted" as const,
        unassignedOccupancyIds: ["assignment-1"],
      })
      .mockResolvedValueOnce({ outcome: "infeasible" as const, unassignedOccupancyIds: [] });
    const port = createPmsRoomAssignmentOptimizationTriggerPort({
      optimize,
    });
    await expect(
      port.afterCreate({
        transaction: {
          query: vi.fn(async () => ({ rows: [{ timeZone: "Etc/UTC" }], rowCount: 1 })),
        } as unknown as PmsManualBookingTransaction,
        command: {
          propertyId,
          commandId: "manual-create-1",
          audit: { actor: { userId: propertyId }, requestId: "request-1", correlationId: null },
        } as PmsManualBookingCreateCommand,
        rooms: [{ roomId: "room-a", roomTypeId: roomTypeA }],
        acceptedAt: new Date("2026-08-18T00:00:00.000Z"),
      }),
    ).resolves.toEqual([
      { roomTypeId: roomTypeA, result: { outcome: "infeasible", unassignedOccupancyIds: [] } },
    ]);
    expect(optimize).toHaveBeenCalledTimes(2);
    expect(optimize.mock.calls[0]![1]).not.toHaveProperty("searchBudget");
    expect(optimize.mock.calls[1]![1]).toMatchObject({
      commandId: `manual-create-1:optimize:create:${roomTypeA}`,
      searchBudget: 100_000,
    });
  });
});
