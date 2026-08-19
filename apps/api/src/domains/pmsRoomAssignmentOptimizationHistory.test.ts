import type { QueryResultRow } from "pg";
import { describe, expect, it } from "vitest";

import { createPgPmsRoomAssignmentOptimizationHistoryPort } from "./pmsRoomAssignmentOptimizationHistory.js";

const id = (suffix: number) => `12000000-0000-4000-8000-${String(suffix).padStart(12, "0")}`;
const propertyId = id(1);

function harness(rows: QueryResultRow[]) {
  const calls: Array<{ text: string; values?: readonly unknown[] }> = [];
  const port = createPgPmsRoomAssignmentOptimizationHistoryPort({
    pool: {
      async query<T extends QueryResultRow = QueryResultRow>(
        text: string,
        values?: readonly unknown[],
      ) {
        calls.push({ text, values });
        return { rows: rows as T[] };
      },
      async end() {},
    },
  });
  return { calls, port };
}

describe("PMS room-assignment optimization history", () => {
  it("returns property-scoped newest-first shuffle rows", async () => {
    const occurredAt = new Date("2026-08-18T10:00:00.000Z");
    const test = harness([
      {
        shuffleId: id(2),
        assignmentId: id(3),
        guestBookingId: id(4),
        bookingReference: "PMS-BOOKING-1",
        roomTypeId: id(5),
        fromRoomId: id(6),
        fromRoomLabel: "Studio 2",
        toRoomId: id(7),
        toRoomLabel: "Studio 1",
        reason: "modify",
        actorType: "user",
        actorUserId: id(8),
        correlationId: "correlation-1",
        occurredAt,
        cursorOccurredAt: "2026-08-18T10:00:00.000789Z",
      },
    ]);

    await expect(test.port.list(propertyId, { limit: 25 })).resolves.toEqual({
      items: [
        {
          shuffleId: id(2),
          assignmentId: id(3),
          guestBookingId: id(4),
          bookingReference: "PMS-BOOKING-1",
          roomTypeId: id(5),
          fromRoom: { roomId: id(6), label: "Studio 2" },
          toRoom: { roomId: id(7), label: "Studio 1" },
          reason: "modify",
          actor: { kind: "user", userId: id(8) },
          correlationId: "correlation-1",
          occurredAt: occurredAt.toISOString(),
        },
      ],
      nextCursor: null,
    });
    expect(test.calls[0]?.text).toContain("audit.property_id = $1::uuid");
    expect(test.calls[0]?.text).toContain("ORDER BY audit.occurred_at DESC, audit.id DESC");
    expect(test.calls[0]?.values).toEqual([propertyId, 26, null, null]);
  });

  it("keeps unassigned origins and deleted booking context explicit", async () => {
    const test = harness([
      {
        shuffleId: id(2),
        assignmentId: id(3),
        guestBookingId: null,
        bookingReference: null,
        roomTypeId: id(5),
        fromRoomId: null,
        fromRoomLabel: null,
        toRoomId: id(7),
        toRoomLabel: null,
        reason: "create",
        actorType: "system",
        actorUserId: null,
        correlationId: "correlation-2",
        occurredAt: "2026-08-18T10:00:00.000Z",
        cursorOccurredAt: "2026-08-18T10:00:00.000789Z",
      },
    ]);
    await expect(test.port.list(propertyId)).resolves.toMatchObject({
      items: [
        { fromRoom: null, toRoom: { roomId: id(7), label: null }, actor: { kind: "system" } },
      ],
      nextCursor: null,
    });
  });

  it("fails closed for malformed history and invalid limits", async () => {
    const test = harness([
      {
        shuffleId: id(2),
        assignmentId: id(3),
        roomTypeId: id(5),
        toRoomId: id(7),
        reason: "unknown",
        actorType: "system",
        correlationId: "correlation-3",
        occurredAt: "2026-08-18T10:00:00.000Z",
        cursorOccurredAt: "2026-08-18T10:00:00.000789Z",
      },
    ]);
    await expect(test.port.list(propertyId)).rejects.toThrow("history row is invalid");
    await expect(test.port.list(propertyId, { limit: 101 })).rejects.toThrow(
      "history limit is invalid",
    );
  });

  it("paginates equal timestamps without gaps or duplicates", async () => {
    const batches = [
      [historyRow(4), historyRow(3), historyRow(2)],
      [historyRow(2), historyRow(1)],
    ];
    const calls: unknown[][] = [];
    const port = createPgPmsRoomAssignmentOptimizationHistoryPort({
      pool: {
        async query<T extends QueryResultRow = QueryResultRow>(
          _text: string,
          values: readonly unknown[] = [],
        ) {
          calls.push([...values]);
          return { rows: batches.shift() as T[] };
        },
        async end() {},
      },
    });
    const first = await port.list(propertyId, { limit: 2 });
    const second = await port.list(propertyId, { limit: 2, before: first.nextCursor! });

    expect(first.items.map(({ shuffleId }) => shuffleId)).toEqual([id(4), id(3)]);
    expect(first.nextCursor).toEqual({
      occurredAt: "2026-08-18T10:00:00.000789Z",
      shuffleId: id(3),
    });
    expect(second.items.map(({ shuffleId }) => shuffleId)).toEqual([id(2), id(1)]);
    expect(second.nextCursor).toBeNull();
    expect(calls[1]).toEqual([propertyId, 3, "2026-08-18T10:00:00.000789Z", id(3)]);
  });
});

function historyRow(suffix: number): QueryResultRow {
  return {
    shuffleId: id(suffix),
    assignmentId: id(20 + suffix),
    guestBookingId: id(30 + suffix),
    bookingReference: `PMS-${suffix}`,
    roomTypeId: id(40),
    fromRoomId: null,
    fromRoomLabel: null,
    toRoomId: id(41),
    toRoomLabel: "Studio 1",
    reason: "create",
    actorType: "system",
    actorUserId: null,
    correlationId: `correlation-${suffix}`,
    occurredAt: "2026-08-18T10:00:00.000Z",
    cursorOccurredAt: "2026-08-18T10:00:00.000789Z",
  };
}
