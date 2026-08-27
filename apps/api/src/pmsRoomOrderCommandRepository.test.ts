import type { QueryResultRow } from "pg";
import { describe, expect, it } from "vitest";

import {
  createTargetPmsOperationsCommandRepository,
  type PmsOperationsCommandPool,
} from "./domains/pmsOperationsCommandRepository.js";
import { pmsRoomOrderVersion } from "./domains/pmsRoomOrder.js";
import type { PmsOperationsReadRepository, PmsRoomOrderCommand } from "./routes/pmsOperations.js";

const propertyId = "f6853000-0000-0000-0000-000000000001";
const roomTypeId = "f6855000-0000-0000-0000-000000000001";
const roomIds = ["f6855100-0000-0000-0000-000000000001", "f6855100-0000-0000-0000-000000000002"];

describe("target PMS room order command repository", () => {
  it("persists a complete order once and replays the completed command", async () => {
    const target = roomOrderPool();
    const repository = createTargetPmsOperationsCommandRepository({
      connectionString: "postgresql://room-order-test",
      pool: target.pool,
      readRepository: {} as PmsOperationsReadRepository,
      now: () => new Date("2026-08-19T10:00:00.000Z"),
    });

    const command = reorderCommand([...roomIds].reverse());
    const saved = await repository.reorderRooms!(command);
    const replayed = await repository.reorderRooms!(command);

    expect(saved).toMatchObject({
      ok: true,
      orderedRoomIds: [...roomIds].reverse(),
      commandMeta: { sideEffects: ["audit_event"] },
    });
    expect(replayed).toEqual({ ...(saved as object), replayed: true });
    expect(target.order()).toEqual([...roomIds].reverse());
    expect(target.updateCount()).toBe(1);
    expect(target.auditCount()).toBe(1);
    expect(target.auditPayload()).toMatchObject({ previousRoomIds: roomIds });
    expect(target.locks()[0]).toContain("pms.room-order:");
    expect(target.commands()).toEqual(["BEGIN", "COMMIT", "BEGIN", "ROLLBACK"]);
  });

  it("rejects a stale order version under the property lock", async () => {
    const target = roomOrderPool();
    const repository = createTargetPmsOperationsCommandRepository({
      connectionString: "postgresql://room-order-test",
      pool: target.pool,
      readRepository: {} as PmsOperationsReadRepository,
    });

    await expect(
      repository.reorderRooms!(reorderCommand([...roomIds].reverse(), "stale")),
    ).resolves.toMatchObject({ ok: false, statusCode: 409, code: "version_conflict" });
    expect(target.updateCount()).toBe(0);
    expect(target.commands()).toEqual(["BEGIN", "ROLLBACK"]);
  });

  it("rejects a partial or foreign order before updating rooms", async () => {
    const target = roomOrderPool();
    const repository = createTargetPmsOperationsCommandRepository({
      connectionString: "postgresql://room-order-test",
      pool: target.pool,
      readRepository: {} as PmsOperationsReadRepository,
    });

    await expect(
      repository.reorderRooms!(
        reorderCommand([roomIds[0]!, "f6855100-0000-0000-0000-000000000099"]),
      ),
    ).resolves.toMatchObject({ ok: false, statusCode: 409, code: "room_order_conflict" });
    expect(target.updateCount()).toBe(0);
    expect(target.auditCount()).toBe(0);
    expect(target.commands()).toEqual(["BEGIN", "ROLLBACK"]);
  });
});

function roomOrderPool() {
  const calls: Array<{ text: string; values?: readonly unknown[] }> = [];
  let orderedRoomIds = [...roomIds];
  let requestFingerprintHash = "";
  let idempotencyMetadata: Record<string, unknown> | null = null;
  let reserved = false;
  const client = {
    async query<T extends QueryResultRow = QueryResultRow>(
      text: string,
      values?: readonly unknown[],
    ) {
      calls.push({ text, values });
      if (["BEGIN", "COMMIT", "ROLLBACK"].includes(text)) return rows<T>([]);
      if (text.includes("FROM platform.idempotency_keys")) {
        return rows<T>(
          idempotencyMetadata
            ? ([
                {
                  status: "completed",
                  requestFingerprintHash,
                  idempotencyMetadata,
                },
              ] as unknown as T[])
            : [],
        );
      }
      if (text.includes("INSERT INTO platform.idempotency_keys")) {
        if (reserved) return rows<T>([]);
        reserved = true;
        requestFingerprintHash = String(values?.[1] ?? "");
        return rows<T>([{ id: "idempotency-1" } as unknown as T]);
      }
      if (text.includes("UPDATE platform.idempotency_keys")) {
        idempotencyMetadata = JSON.parse(String(values?.[3])) as Record<string, unknown>;
        return rows<T>([]);
      }
      if (text.includes("SELECT DISTINCT room_type_id")) {
        return rows<T>([{ roomTypeId } as unknown as T]);
      }
      if (text.includes("pg_advisory_xact_lock")) return rows<T>([]);
      if (text.includes("ORDER BY sort_order ASC, room_number ASC, id ASC FOR UPDATE")) {
        return rows<T>(orderedRoomIds.map((roomId) => ({ roomId }) as unknown as T));
      }
      if (text.includes("WITH desired AS")) {
        orderedRoomIds = [...(values?.[1] as string[])];
        return { rows: [] as T[], rowCount: orderedRoomIds.length };
      }
      if (text.includes("INSERT INTO platform.product_audit_events")) return rows<T>([]);
      throw new Error(`Unexpected query: ${text}`);
    },
    release() {},
  };
  return {
    pool: { connect: async () => client, end: async () => {} } satisfies PmsOperationsCommandPool,
    order: () => orderedRoomIds,
    updateCount: () => calls.filter(({ text }) => text.includes("WITH desired AS")).length,
    auditCount: () =>
      calls.filter(({ text }) => text.includes("INSERT INTO platform.product_audit_events")).length,
    auditPayload: () => {
      const call = calls.find(({ text }) =>
        text.includes("INSERT INTO platform.product_audit_events"),
      );
      return call ? JSON.parse(String(call.values?.[7])) : null;
    },
    locks: () =>
      calls.filter(({ text }) => text.includes("pg_advisory_xact_lock")).map(({ text }) => text),
    commands: () =>
      calls
        .map(({ text }) => text)
        .filter((text) => ["BEGIN", "COMMIT", "ROLLBACK"].includes(text)),
  };
}

function reorderCommand(
  orderedRoomIds: string[],
  expectedVersion = pmsRoomOrderVersion(roomIds),
): PmsRoomOrderCommand {
  return {
    propertyId,
    commandId: "cmd-room-order",
    idempotencyKey: "room-order",
    expectedVersion,
    orderedRoomIds,
    audit: {
      actor: {
        kind: "user",
        userId: "f6851000-0000-0000-0000-000000000001",
        organizationId: "f6852000-0000-0000-0000-000000000001",
      },
      requestId: "request-room-order",
      reason: "Reorder rooms",
      requestedAt: "2026-08-19T10:00:00.000Z",
    },
  };
}

function rows<T extends QueryResultRow>(items: T[]): { rows: T[]; rowCount: number } {
  return { rows: items, rowCount: items.length };
}
