import { describe, expect, it, vi } from "vitest";

import { createPgPmsChannexManagementReadRepository } from "./pmsChannexManagementReadModel.js";

const modes = {
  connection: "observe_only",
  provisioning: "observe_only",
  ariSync: "observe_only",
  bookingSync: "observe_only",
  markups: "observe_only",
  messaging: "observe_only",
  iframe: "observe_only",
} as const;

describe("PMS Channex management read model", () => {
  it("returns a complete empty target snapshot for a disconnected property", async () => {
    const query = vi.fn().mockResolvedValue({ rows: [] });
    const repository = createPgPmsChannexManagementReadRepository({
      connectionString: "postgres://target",
      pool: { query, end: vi.fn() } as never,
    });

    const snapshot = await repository.getSnapshot("00000000-0000-4000-8000-000000000001", modes);

    expect(snapshot).toMatchObject({
      contractVersion: "pms-channex-management.v1",
      connection: { status: "disconnected", externalPropertyId: null },
      mappings: { roomTypes: [], ratePlans: [] },
      channels: [],
      markups: [],
      capabilityModes: modes,
      activeOperation: null,
    });
    expect(snapshot.sync.ari.status).toBe("idle");
    expect(query).toHaveBeenCalledTimes(5);
    for (const callIndex of [1, 2, 3]) {
      expect(query.mock.calls[callIndex]?.[0]).toContain("connection.provider = 'channex'");
    }
  });

  it.each([
    ["pending", 0, "queued", null],
    ["pending", 1, "retry_scheduled", "2026-08-14T00:00:00.000Z"],
    ["running", 1, "running", null],
    ["succeeded", 1, "succeeded", null],
    ["failed", 1, "failed", null],
    ["canceled", 1, "failed", null],
    ["dead_lettered", 1, "dead_lettered", null],
  ] as const)(
    "maps platform job status %s into the public contract",
    async (status, attemptsMade, expected, retryAfter) => {
      const query = vi.fn().mockResolvedValue({
        rows: [
          {
            operationId: "00000000-0000-4000-8000-000000000002",
            propertyId: "00000000-0000-4000-8000-000000000001",
            status,
            attemptsMade,
            maxAttempts: 5,
            runAfter: "2026-08-14T00:00:00.000Z",
            acceptedAt: "2026-08-13T00:00:00.000Z",
            payload: {
              operationType: "sync_ari",
              commandId: "command-1",
              idempotencyKey: "key-1",
            },
            metadata: {},
          },
        ],
      });
      const repository = createPgPmsChannexManagementReadRepository({
        connectionString: "postgres://target",
        pool: { query, end: vi.fn() } as never,
      });

      const operation = await repository.getOperation(
        "00000000-0000-4000-8000-000000000001",
        "00000000-0000-4000-8000-000000000002",
      );

      expect(operation).toMatchObject({ status: expected, retryAfter });
    },
  );
});
