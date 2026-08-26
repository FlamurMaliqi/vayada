import { describe, expect, it } from "vitest";

import { appendPmsRoomAssignmentOptimizationEvidence } from "./pmsRoomAssignmentOptimizationEvidence.js";
import type { PmsRoomAssignmentOptimizationCommandStoreClient } from "./pmsRoomAssignmentOptimizationCommandStore.js";

describe("PMS room assignment optimization evidence", () => {
  it("writes one linked event, audit per move, and calendar refresh", async () => {
    const calls: { text: string; values: readonly unknown[] }[] = [];
    const client: PmsRoomAssignmentOptimizationCommandStoreClient = {
      query: (async (text: string, values: readonly unknown[] = []) => {
        calls.push({ text, values });
        if (text.includes("FROM platform.idempotency_keys")) {
          return {
            rows: values[4] === "attempt-1" ? [{ id: values[0] }] : [],
            rowCount: values[4] === "attempt-1" ? 1 : 0,
          };
        }
        if (text.includes("INSERT INTO platform.domain_events")) {
          return { rows: [{ eventId: "33333333-3333-4333-8333-333333333333" }], rowCount: 1 };
        }
        return { rows: [], rowCount: text.includes("product_audit_events") ? 2 : 1 };
      }) as PmsRoomAssignmentOptimizationCommandStoreClient["query"],
    };
    const moves = [
      { occupancyId: "stay-1", fromRoomId: "room-2", toRoomId: "room-1" },
      { occupancyId: "stay-2", fromRoomId: null, toRoomId: "room-2" },
    ];

    await appendPmsRoomAssignmentOptimizationEvidence(
      client,
      {
        propertyId: "11111111-1111-4111-8111-111111111111",
        roomTypeId: "22222222-2222-4222-8222-222222222222",
        reason: "create",
        commandId: "optimize-1",
        correlationId: "corr-1",
        actor: { kind: "system" },
      },
      {
        outcome: "optimized",
        moves,
        gapNightsBefore: 4,
        gapNightsAfter: 0,
        usedRoomsBefore: 3,
        usedRoomsAfter: 2,
      },
      {
        id: "44444444-4444-4444-8444-444444444444",
        keyHash: sha256("optimize-1"),
        propertyId: "11111111-1111-4111-8111-111111111111",
        attemptId: "attempt-1",
      },
    );

    const event = calls.find(({ text }) => text.includes("platform.domain_events"))!;
    const audit = calls.find(({ text }) => text.includes("platform.product_audit_events"))!;
    const outbox = calls.find(({ text }) => text.includes("platform.outbox_events"))!;
    expect(event.text).toContain("idempotency_key_hash");
    expect(event.values).toContain(sha256("optimize-1"));
    expect(audit.text).toContain("idempotency_key_id");
    expect(audit.values).toContain("44444444-4444-4444-8444-444444444444");
    expect(JSON.parse(String(audit.values.at(-1)))).toHaveLength(2);
    expect(outbox.text).toContain("idempotency_key_hash");
    expect(outbox.values).toContain(sha256("optimize-1"));
    expect(calls).toHaveLength(4);

    await expect(
      appendPmsRoomAssignmentOptimizationEvidence(
        client,
        {
          propertyId: "11111111-1111-4111-8111-111111111111",
          roomTypeId: "room-type",
          reason: "modify",
          commandId: "stale",
          correlationId: "corr",
          actor: { kind: "system" },
        },
        {
          outcome: "optimized",
          moves,
          gapNightsBefore: 1,
          gapNightsAfter: 0,
          usedRoomsBefore: 2,
          usedRoomsAfter: 1,
        },
        {
          id: "id",
          keyHash: sha256("stale"),
          propertyId: "11111111-1111-4111-8111-111111111111",
          attemptId: "stale",
        },
      ),
    ).rejects.toThrow("reservation is stale");
    expect(calls).toHaveLength(5);

    await expect(
      appendPmsRoomAssignmentOptimizationEvidence(
        client,
        {
          propertyId: "11111111-1111-4111-8111-111111111111",
          roomTypeId: "room-type",
          reason: "modify",
          commandId: "noop",
          correlationId: "corr",
          actor: { kind: "system" },
        },
        {
          outcome: "optimized",
          moves: [],
          gapNightsBefore: 0,
          gapNightsAfter: 0,
          usedRoomsBefore: 0,
          usedRoomsAfter: 0,
        },
        {
          id: "id",
          keyHash: "hash",
          propertyId: "11111111-1111-4111-8111-111111111111",
          attemptId: "attempt",
        },
      ),
    ).rejects.toThrow("requires moves");
    expect(calls).toHaveLength(5);
  });
});

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
import { createHash } from "node:crypto";
