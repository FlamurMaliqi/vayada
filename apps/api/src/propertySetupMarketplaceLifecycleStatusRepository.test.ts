import type { QueryResultRow } from "pg";
import { describe, expect, it } from "vitest";

import { createPgMarketplaceSetupLifecycleStatusRepository } from "./domains/marketplaceSetupLifecycleStatusRepository.js";
import {
  SequencedLifecycleExecutor,
  authorizedLifecycleExecutor,
  lifecycleTestScope,
} from "./propertySetupLifecycleStatusRepositoryTestSupport.js";

const marketplaceBase = {
  submissionRevisionId: "10000000-0000-4000-8000-000000000004",
  revisionNumber: 1,
  moderationStatus: "pending",
  moderationUpdatedAt: new Date("2026-08-02T12:00:00.000Z"),
  activeRevisionId: null,
  activationStatus: null,
  activationUpdatedAt: null,
} as const;

describe("Marketplace Review lifecycle status repository", () => {
  it("maps only persisted moderation and activation lifecycle state", async () => {
    await expect(marketplaceStatus(marketplaceBase)).resolves.toMatchObject({
      ...lifecycleTestScope,
      product: "marketplace",
      phase: "pending_review",
      sourceRevision: expect.stringMatching(/^marketplace-review:sha256:[0-9a-f]{64}$/),
    });
    await expect(
      marketplaceStatus({ ...marketplaceBase, moderationStatus: "changes_requested" }),
    ).resolves.toMatchObject({ phase: "changes_requested" });
    await expect(
      marketplaceStatus({
        ...marketplaceBase,
        moderationStatus: "approved",
        activeRevisionId: marketplaceBase.submissionRevisionId,
        activationStatus: "active",
        activationUpdatedAt: new Date("2026-08-02T12:01:00.000Z"),
      }),
    ).resolves.toMatchObject({ phase: "published" });
    await expect(
      marketplaceStatus({
        ...marketplaceBase,
        moderationStatus: "approved",
        activeRevisionId: marketplaceBase.submissionRevisionId,
        activationStatus: "suspended",
        activationUpdatedAt: new Date("2026-08-02T12:02:00.000Z"),
      }),
    ).resolves.toMatchObject({ phase: "suspended" });
  });

  it("fails closed for unavailable authorization and malformed owner rows", async () => {
    const denied = new SequencedLifecycleExecutor([{ rows: [], rowCount: 0 }]);
    const deniedRepository = createPgMarketplaceSetupLifecycleStatusRepository({
      connectionString: "postgresql://unit.test/vayada_test",
      pool: denied,
    });
    await expect(
      deniedRepository.getMarketplaceSetupLifecycleStatus(lifecycleTestScope),
    ).rejects.toThrow("scope is unavailable");
    expect(denied.queryCount).toBe(1);

    await expect(
      marketplaceStatus({ ...marketplaceBase, moderationUpdatedAt: null }),
    ).rejects.toThrow("snapshot is malformed");
    await expect(
      marketplaceStatus({ ...marketplaceBase, moderationStatus: "unsupported" }),
    ).rejects.toThrow("status is malformed");
    await expect(
      marketplaceStatus({
        ...marketplaceBase,
        activeRevisionId: marketplaceBase.submissionRevisionId,
        activationStatus: null,
      }),
    ).rejects.toThrow("activation is malformed");
    await expect(
      marketplaceStatus({
        ...marketplaceBase,
        activeRevisionId: marketplaceBase.submissionRevisionId,
        activationStatus: "active",
        activationUpdatedAt: new Date("2026-08-02T12:03:00.000Z"),
      }),
    ).rejects.toThrow("not approved");
  });
});

async function marketplaceStatus(row: QueryResultRow) {
  const repository = createPgMarketplaceSetupLifecycleStatusRepository({
    connectionString: "postgresql://unit.test/vayada_test",
    pool: authorizedLifecycleExecutor(row),
  });
  return repository.getMarketplaceSetupLifecycleStatus(lifecycleTestScope);
}
