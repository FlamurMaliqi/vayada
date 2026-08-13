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
  });
});
