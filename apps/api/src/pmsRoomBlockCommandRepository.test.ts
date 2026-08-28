import type { QueryResultRow } from "pg";
import { describe, expect, it } from "vitest";

import {
  createTargetPmsOperationsCommandRepository,
  type PmsOperationsCommandPool,
} from "./domains/pmsOperationsCommandRepository.js";
import type {
  PmsOperationsReadRepository,
  PmsRoomBlockCreateCommand,
  PmsRoomBlockUpdateCommand,
} from "./routes/pmsOperations.js";

const propertyId = "f6853000-0000-0000-0000-000000000001";
const roomTypeId = "f6855000-0000-0000-0000-000000000001";
const roomIds = ["f6855100-0000-0000-0000-000000000001", "f6855100-0000-0000-0000-000000000002"];

describe("target PMS room block command repository", () => {
  it("atomically writes inventory and reuses the ARI/distribution outbox contract", async () => {
    const target = roomBlockPool();
    const repository = createTargetPmsOperationsCommandRepository({
      connectionString: "postgresql://room-block-test",
      pool: target.pool,
      readRepository: {} as PmsOperationsReadRepository,
      now: () => new Date("2026-08-14T18:00:00.000Z"),
    });

    const created = await repository.createRoomBlocks!(createCommand());
    const replayed = await repository.createRoomBlocks!(createCommand());

    expect(created).toMatchObject({
      ok: true,
      items: [
        { roomId: roomIds[0], version: "room-block-v1" },
        { roomId: roomIds[1], version: "room-block-v1" },
      ],
      commandMeta: { sideEffects: ["calendar_refresh", "ari_changed", "audit_event"] },
    });
    expect(replayed).toEqual({ ...(created as object), replayed: true });
    expect(
      target.calls.filter((call) => call.text.includes("INSERT INTO pms.room_blocks")),
    ).toHaveLength(1);
    expect(
      target.calls.filter((call) => call.text.includes("UPDATE pms.inventory_days")),
    ).toHaveLength(1);
    expect(
      target.calls
        .filter((call) => call.text.includes("INSERT INTO platform.outbox_events"))
        .map((call) => call.values?.[1]),
    ).toEqual([
      expect.stringContaining("pms.ari_changed.room_block"),
      expect.stringContaining("distribution.inventory_changed.room_block"),
      expect.stringContaining("pms.calendar_refresh.room_block"),
    ]);
    expect(target.calls.some((call) => /channex/i.test(call.text))).toBe(false);
    expect(target.commands()).toEqual(["BEGIN", "COMMIT", "BEGIN", "ROLLBACK"]);
  });

  it("rolls back without partial writes when room availability conflicts", async () => {
    const target = roomBlockPool({ availableRoomIds: [roomIds[0]!] });
    const repository = createTargetPmsOperationsCommandRepository({
      connectionString: "postgresql://room-block-test",
      pool: target.pool,
      readRepository: {} as PmsOperationsReadRepository,
    });

    await expect(repository.createRoomBlocks!(createCommand())).resolves.toMatchObject({
      ok: false,
      statusCode: 409,
      code: "room_block_conflict",
    });
    expect(target.calls.some((call) => call.text.includes("INSERT INTO pms.room_blocks"))).toBe(
      false,
    );
    expect(target.calls.some((call) => call.text.includes("platform.outbox_events"))).toBe(false);
    expect(target.commands()).toEqual(["BEGIN", "ROLLBACK"]);
  });

  it("preserves PostgreSQL date-only values when reconciling an edited block", async () => {
    const target = roomBlockPool();
    const repository = createTargetPmsOperationsCommandRepository({
      connectionString: "postgresql://room-block-test",
      pool: target.pool,
      readRepository: {} as PmsOperationsReadRepository,
    });

    await expect(repository.updateRoomBlock!(updateCommand())).resolves.toMatchObject({
      ok: true,
      items: [{ startsOn: "2026-08-21", endsOn: "2026-08-23", version: "room-block-v2" }],
    });
    expect(
      target.calls.find((call) => call.text.includes("UPDATE pms.inventory_days"))?.values,
    ).toEqual([propertyId, roomTypeId, "2026-08-20", "2026-08-23", expect.any(String)]);
  });

  it("rejects edits to reconciler-owned linked blocks", async () => {
    const target = roomBlockPool({ blockKind: "linked_booking" });
    const repository = createTargetPmsOperationsCommandRepository({
      connectionString: "postgresql://room-block-test",
      pool: target.pool,
      readRepository: {} as PmsOperationsReadRepository,
    });

    await expect(repository.updateRoomBlock!(updateCommand())).resolves.toMatchObject({
      ok: false,
      statusCode: 404,
      code: "room_block_not_found",
    });
    expect(target.calls.some((call) => call.text.includes("UPDATE pms.room_blocks"))).toBe(false);
  });

  it("returns a structured failure and rolls back when the ARI outbox write fails", async () => {
    const target = roomBlockPool({ failAriOutbox: true });
    const repository = createTargetPmsOperationsCommandRepository({
      connectionString: "postgresql://room-block-test",
      pool: target.pool,
      readRepository: {} as PmsOperationsReadRepository,
    });

    await expect(repository.createRoomBlocks!(createCommand())).resolves.toEqual({
      ok: false,
      statusCode: 500,
      code: "side_effect_failed",
      message: "Room block side effects could not be queued; no changes were committed.",
    });
    expect(target.commands()).toEqual(["BEGIN", "ROLLBACK"]);
    expect(target.completed()).toBe(false);
  });
});

function roomBlockPool(
  options: {
    availableRoomIds?: string[];
    blockKind?: "manual" | "linked_booking" | "linked_manual_block";
    failAriOutbox?: boolean;
  } = {},
) {
  const calls: Array<{ text: string; values?: readonly unknown[] }> = [];
  let idempotencyMetadata: Record<string, unknown> | null = null;
  let requestFingerprintHash = "";
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
        requestFingerprintHash = String(values?.[2] ?? "");
        return rows<T>([{ id: "idempotency-1" } as unknown as T]);
      }
      if (text.includes("UPDATE platform.idempotency_keys")) {
        idempotencyMetadata = JSON.parse(String(values?.[3])) as Record<string, unknown>;
        return rows<T>([]);
      }
      if (text.includes("pg_advisory_xact_lock") || text.startsWith("SELECT id FROM pms.rooms")) {
        return rows<T>([]);
      }
      if (text.includes('SELECT room.id::text AS "roomId"')) {
        const requestedRoomIds = values?.[2] as string[];
        return rows<T>(
          (options.availableRoomIds ?? requestedRoomIds).map(
            (roomId) => ({ roomId }) as unknown as T,
          ),
        );
      }
      if (text.includes('stay_date AS "stayDate"')) {
        return rows<T>(
          calendarDays(String(values?.[2]), String(values?.[3])).map(
            (stayDate) =>
              ({ stayDate, totalCount: 2, assignedCount: 0, blockedCount: 0 }) as unknown as T,
          ),
        );
      }
      if (text.includes("FROM pms.room_blocks")) {
        return rows<T>([
          {
            blockId: "f6855400-0000-0000-0000-000000000001",
            blockKind: options.blockKind ?? "manual",
            propertyId,
            roomTypeId,
            roomId: roomIds[0],
            startsOn: new Date(2026, 7, 20),
            endsOn: new Date(2026, 7, 22),
            blockedCount: 1,
            reason: "Maintenance",
            status: "active",
            revision: 1,
          } as unknown as T,
        ]);
      }
      if (text.includes("INSERT INTO pms.room_blocks")) {
        return rows<T>(
          roomIds.map(
            (roomId, index) =>
              ({
                blockId: `f6855400-0000-0000-0000-${String(index + 1).padStart(12, "0")}`,
                propertyId,
                roomTypeId,
                roomId,
                startsOn: "2026-08-20",
                endsOn: "2026-08-22",
                blockedCount: 1,
                reason: "Maintenance",
                status: "active",
                revision: 1,
              }) as unknown as T,
          ),
        );
      }
      if (text.includes("UPDATE pms.room_blocks")) {
        return rows<T>([
          {
            blockId: "f6855400-0000-0000-0000-000000000001",
            propertyId,
            roomTypeId,
            roomId: roomIds[0],
            startsOn: values?.[2],
            endsOn: values?.[3],
            blockedCount: 1,
            reason: values?.[4],
            status: "active",
            revision: 2,
          } as unknown as T,
        ]);
      }
      if (text.includes("UPDATE pms.inventory_days")) return rows<T>([]);
      if (text.includes("INSERT INTO platform.domain_events")) {
        return rows<T>([{ eventId: "f6859000-0000-0000-0000-000000000001" } as unknown as T]);
      }
      if (text.includes("INSERT INTO platform.outbox_events")) {
        if (options.failAriOutbox && String(values?.[1]).includes("pms.ari_changed")) {
          throw new Error("outbox unavailable");
        }
        return rows<T>([]);
      }
      if (text.includes("INSERT INTO platform.product_audit_events")) return rows<T>([]);
      throw new Error(`Unexpected query: ${text}`);
    },
    release() {},
  };
  return {
    pool: { connect: async () => client, end: async () => {} } satisfies PmsOperationsCommandPool,
    calls,
    commands: () =>
      calls
        .map((call) => call.text)
        .filter((text) => ["BEGIN", "COMMIT", "ROLLBACK"].includes(text)),
    completed: () => idempotencyMetadata !== null,
  };
}

function createCommand(): PmsRoomBlockCreateCommand {
  return {
    propertyId,
    commandId: "cmd-room-block-create",
    idempotencyKey: "room-block-create",
    roomTypeId,
    roomIds,
    startsOn: "2026-08-20",
    endsOn: "2026-08-22",
    reason: "Maintenance",
    audit: {
      actor: {
        kind: "user",
        userId: "f6851000-0000-0000-0000-000000000001",
        organizationId: "f6852000-0000-0000-0000-000000000001",
      },
      requestId: "request-room-block-create",
      reason: "Create room block",
      requestedAt: "2026-08-14T18:00:00.000Z",
    },
  };
}

function updateCommand(): PmsRoomBlockUpdateCommand {
  const { audit } = createCommand();
  return {
    propertyId,
    commandId: "cmd-room-block-update",
    idempotencyKey: "room-block-update",
    blockId: "f6855400-0000-0000-0000-000000000001",
    expectedVersion: "room-block-v1",
    startsOn: "2026-08-21",
    endsOn: "2026-08-23",
    reason: "Maintenance",
    audit,
  };
}

function calendarDays(from: string, to: string): string[] {
  const days: string[] = [];
  for (let day = new Date(`${from}T00:00:00Z`); day <= new Date(`${to}T00:00:00Z`); ) {
    days.push(day.toISOString().slice(0, 10));
    day = new Date(day.getTime() + 86_400_000);
  }
  return days;
}

function rows<T extends QueryResultRow>(items: T[]): { rows: T[]; rowCount: number } {
  return { rows: items, rowCount: items.length };
}
