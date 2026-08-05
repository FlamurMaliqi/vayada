import { describe, expect, it, vi } from "vitest";

import {
  PMS_INVENTORY_MUTATION_LOCK_PREFIX,
  lockPmsInventoryMutationScope,
  type PmsInventoryMutationLockClient,
} from "./pmsInventoryMutationLock.js";

const PROPERTY_ID = "A1063000-0000-4000-8000-000000000001";

describe("PMS inventory mutation lock", () => {
  it("preserves the shared legacy namespace with a canonical UUID identity", async () => {
    const query = vi.fn(async () => ({ rows: [], rowCount: 1 }));

    await lockPmsInventoryMutationScope({ query } as PmsInventoryMutationLockClient, PROPERTY_ID);

    expect(PMS_INVENTORY_MUTATION_LOCK_PREFIX).toBe("pms-inventory:");
    expect(query).toHaveBeenCalledWith(
      `SELECT pg_advisory_xact_lock(
       hashtextextended(concat('pms-inventory:', $1::uuid::text), 0)
     )`,
      [PROPERTY_ID],
    );
  });

  it("propagates query failures without replacing their identity", async () => {
    const failure = new Error("database lock failed");
    const client = {
      query: vi.fn(async () => Promise.reject(failure)),
    } as unknown as PmsInventoryMutationLockClient;

    await expect(lockPmsInventoryMutationScope(client, PROPERTY_ID)).rejects.toBe(failure);
  });
});
