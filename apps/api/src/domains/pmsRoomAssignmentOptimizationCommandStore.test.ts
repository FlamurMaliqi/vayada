import { describe, expect, it } from "vitest";

import {
  completePmsRoomAssignmentOptimizationCommand,
  releasePmsRoomAssignmentOptimizationCommand,
  startPmsRoomAssignmentOptimizationCommand,
  type PmsRoomAssignmentOptimizationCommandIdentity,
  type PmsRoomAssignmentOptimizationCommandStoreClient,
} from "./pmsRoomAssignmentOptimizationCommandStore.js";

const propertyId = "11111111-1111-4111-8111-111111111111";
const command: PmsRoomAssignmentOptimizationCommandIdentity = {
  propertyId,
  roomTypeId: "22222222-2222-4222-8222-222222222222",
  reason: "create",
  currentDate: "2026-08-18",
  commandId: "optimize-create-1",
  correlationId: "corr-1",
};
const at = new Date("2026-08-18T10:00:00.000Z");

describe("PMS room assignment optimization command store", () => {
  it("scopes, validates, completes, and safely replays commands", async () => {
    let fingerprint = "";
    let stored: Record<string, unknown> | null = null;
    let activeAttemptId = "";
    const client = fakeClient(async (text, values = []) => {
      if (/^\s*(UPDATE|DELETE)/.test(text))
        expect(text).toMatch(/key_hash[\s\S]+property_id[\s\S]+attemptId/);
      if (text.includes("FROM platform.idempotency_keys") && text.includes("FOR UPDATE")) {
        return { rows: stored ? [stored] : [], rowCount: 1 };
      }
      if (text.includes("INSERT INTO platform.idempotency_keys")) {
        fingerprint = String(values[2]);
        activeAttemptId = String(values[7]);
        return { rows: [{ id: "33333333-3333-4333-8333-333333333333" }], rowCount: 1 };
      }
      if (text.includes("UPDATE platform.idempotency_keys")) {
        stored = {
          id: "33333333-3333-4333-8333-333333333333",
          status: "completed",
          responseStatusCode: 200,
          requestFingerprintHash: fingerprint,
          responseBodyHash: values[1],
          idempotencyMetadata: { result: JSON.parse(String(values[3])) },
          expiresAt: "2026-08-19T10:00:00.000Z",
        };
        return { rows: [], rowCount: 1 };
      }
      if (text.includes("DELETE FROM platform.idempotency_keys")) {
        return { rows: [], rowCount: values[4] === activeAttemptId ? 1 : 0 };
      }
      throw new Error(`Unhandled SQL: ${text}`);
    });

    const started = await startPmsRoomAssignmentOptimizationCommand(client, command, at);
    if (started.kind !== "reserved") throw new Error("Expected reservation");
    const invalid = {
      outcome: "optimized",
      moves: [{ occupancyId: "stay", fromRoomId: "room", toRoomId: "room" }],
      gapNightsBefore: 0,
      gapNightsAfter: 0,
      usedRoomsBefore: 1,
      usedRoomsAfter: 1,
    } as never;
    await expect(
      completePmsRoomAssignmentOptimizationCommand(client, started.reservation, invalid, at),
    ).rejects.toThrow("result is invalid");
    await completePmsRoomAssignmentOptimizationCommand(
      client,
      started.reservation,
      { outcome: "disabled" },
      at,
    );
    await expect(startPmsRoomAssignmentOptimizationCommand(client, command, at)).resolves.toEqual({
      kind: "replay",
      result: { outcome: "disabled" },
    });
    stored!.responseStatusCode = 201;
    await expect(
      startPmsRoomAssignmentOptimizationCommand(client, command, at),
    ).resolves.toMatchObject({ kind: "conflict", outcome: "idempotency_conflict" });
    stored!.responseStatusCode = 200;
    stored!.responseBodyHash = "tampered";
    await expect(
      startPmsRoomAssignmentOptimizationCommand(client, command, at),
    ).resolves.toMatchObject({ kind: "conflict", outcome: "idempotency_conflict" });

    await expect(
      releasePmsRoomAssignmentOptimizationCommand(client, {
        ...started.reservation,
        attemptId: "stale",
      }),
    ).rejects.toThrow("release failed");
    await releasePmsRoomAssignmentOptimizationCommand(client, started.reservation);
  });
});

function fakeClient(
  query: (
    text: string,
    values?: readonly unknown[],
  ) => Promise<{ rows: unknown[]; rowCount: number }>,
): PmsRoomAssignmentOptimizationCommandStoreClient {
  return { query: query as PmsRoomAssignmentOptimizationCommandStoreClient["query"] };
}
