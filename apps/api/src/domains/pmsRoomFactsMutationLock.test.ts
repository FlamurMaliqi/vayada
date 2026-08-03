import { describe, expect, it, vi } from "vitest";

import {
  PMS_ROOM_FACTS_MUTATION_LOCK_NAMESPACE,
  lockPmsRoomFactsMutationScope,
  type PmsRoomFactsMutationLockClient,
} from "./pmsRoomFactsMutationLock.js";

const PROPERTY_ID = "A2000000-0000-4000-8000-000000000002";

describe("PMS room-facts mutation lock", () => {
  it("preserves the shared namespace and database-canonical UUID lock identity", async () => {
    const query = vi.fn(async () => ({ rows: [], rowCount: 1 }));

    await lockPmsRoomFactsMutationScope({ query } as PmsRoomFactsMutationLockClient, PROPERTY_ID);

    expect(PMS_ROOM_FACTS_MUTATION_LOCK_NAMESPACE).toBe("pms.room_facts");
    expect(query).toHaveBeenCalledWith(
      `SELECT pg_advisory_xact_lock(
       hashtext('pms.room_facts'),
       hashtext($1::uuid::text)
     )`,
      [PROPERTY_ID],
    );
  });

  it("propagates query failures without replacing their identity", async () => {
    const failure = new Error("database lock failed");
    const client = {
      query: vi.fn(async () => Promise.reject(failure)),
    } as unknown as PmsRoomFactsMutationLockClient;

    await expect(lockPmsRoomFactsMutationScope(client, PROPERTY_ID)).rejects.toBe(failure);
  });
});
