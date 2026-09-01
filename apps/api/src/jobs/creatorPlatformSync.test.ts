import { describe, expect, it, vi } from "vitest";

import { CreatorPlatformRequestError } from "../integrations/creatorPlatforms/http.js";
import type {
  CreatorPlatformAccount,
  CreatorPlatformAdapter,
  CreatorPlatformGrant,
} from "../integrations/creatorPlatforms/types.js";
import type { ProviderCredentialVault } from "../platform/providerCredentialVault.js";
import type {
  CreatorPlatformConnectionRecord,
  MarketplaceCreatorPlatformConnectionRepository,
  ScheduledCreatorPlatformConnectionSyncClaim,
} from "../routes/marketplaceCreatorPlatformConnections.js";
import { runCreatorPlatformSyncCycle } from "./creatorPlatformSync.js";
import type {
  CreatorPlatformSyncJob,
  CreatorPlatformSyncStore,
} from "./creatorPlatformSyncStore.js";

const now = new Date("2026-09-01T12:00:00.000Z");
const job: CreatorPlatformSyncJob = {
  jobId: "00000000-0000-4000-8000-000000000001",
  connectionId: "00000000-0000-4000-8000-000000000002",
  provider: "meta",
  scheduledAt: now.toISOString(),
  attemptNumber: 1,
  maxAttempts: 5,
  workerId: "creator-sync:test",
  invalidPayload: false,
};

describe("creator platform sync worker", () => {
  it("runs the shared import path and completes a scheduled job", async () => {
    const harness = setup();

    await expect(runCreatorPlatformSyncCycle(harness.options)).resolves.toMatchObject({
      scheduled: 1,
      processed: 1,
      succeeded: 1,
    });

    expect(harness.repository.claimScheduledConnectionSync).toHaveBeenCalledWith({
      connectionId: job.connectionId,
      leaseId: expect.any(String),
      leaseExpiresAt: "2026-09-01T12:10:00.000Z",
    });
    expect(harness.credentialGet).toHaveBeenCalledWith("vault/current");
    expect(harness.repository.updateConnectionFromImport).toHaveBeenCalledOnce();
    expect(harness.store.succeed).toHaveBeenCalledWith(job, {
      now,
      outcome: "succeeded",
    });
  });

  it("retries rate limits without replacing the last successful snapshot", async () => {
    const harness = setup({
      error: new CreatorPlatformRequestError("instagram", 429, "rate_limit"),
    });

    await expect(runCreatorPlatformSyncCycle(harness.options)).resolves.toMatchObject({
      retried: 1,
      deadLettered: 0,
    });

    expect(harness.repository.updateConnectionFromImport).not.toHaveBeenCalled();
    expect(harness.repository.markConnectionError).not.toHaveBeenCalled();
    expect(harness.repository.releaseConnectionSync).toHaveBeenCalledOnce();
    expect(harness.store.fail).toHaveBeenCalledWith(
      job,
      expect.objectContaining({
        code: "provider_rate_limit",
        retryAt: new Date("2026-09-01T12:05:00.000Z"),
      }),
    );
  });

  it("marks revoked provider authorization as reconnect required without retrying", async () => {
    const harness = setup({
      error: new CreatorPlatformRequestError("instagram", 401, "authorization"),
    });

    await expect(runCreatorPlatformSyncCycle(harness.options)).resolves.toMatchObject({
      reconnectRequired: 1,
      retried: 0,
    });

    expect(harness.repository.markConnectionError).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "reconnect_required",
        errorCode: "provider_authorization_invalid",
      }),
    );
    expect(harness.repository.releaseConnectionSync).not.toHaveBeenCalled();
    expect(harness.store.succeed).toHaveBeenCalledWith(job, {
      now,
      outcome: "reconnect_required",
    });
  });

  it("dead-letters an exhausted transient failure and marks sync failed", async () => {
    const finalJob = { ...job, attemptNumber: 5, maxAttempts: 5 };
    const harness = setup({ job: finalJob, error: new TypeError("network failed") });

    await expect(runCreatorPlatformSyncCycle(harness.options)).resolves.toMatchObject({
      retried: 0,
      deadLettered: 1,
    });

    expect(harness.repository.updateConnectionFromImport).not.toHaveBeenCalled();
    expect(harness.repository.markConnectionError).toHaveBeenCalledWith(
      expect.objectContaining({ status: "sync_failed", errorCode: "provider_network_error" }),
    );
    expect(harness.store.fail).toHaveBeenCalledWith(finalJob, {
      now,
      code: "provider_network_error",
      retryAt: null,
    });
  });

  it("cancels an ineligible connection before reading its credential", async () => {
    const harness = setup({ claim: { outcome: "ineligible" } });

    await expect(runCreatorPlatformSyncCycle(harness.options)).resolves.toMatchObject({
      canceled: 1,
      succeeded: 0,
    });

    expect(harness.credentialGet).not.toHaveBeenCalled();
    expect(harness.store.cancel).toHaveBeenCalledWith(job, {
      now,
      code: "connection_ineligible",
    });
  });

  it("completes a replay without provider access after its snapshot already committed", async () => {
    const harness = setup({ lastSuccessfulSyncAt: "2026-09-01T12:00:01.000Z" });

    await expect(runCreatorPlatformSyncCycle(harness.options)).resolves.toMatchObject({
      succeeded: 1,
    });

    expect(harness.credentialGet).not.toHaveBeenCalled();
    expect(harness.repository.releaseConnectionSync).toHaveBeenCalledOnce();
    expect(harness.store.succeed).toHaveBeenCalledWith(job, { now, outcome: "succeeded" });
  });
});

type Repository = Pick<
  MarketplaceCreatorPlatformConnectionRepository,
  | "claimScheduledConnectionSync"
  | "releaseConnectionSync"
  | "markConnectionError"
  | "queueCredentialCleanup"
  | "updateConnectionFromImport"
  | "markCredentialCleaned"
  | "recordCredentialCleanupFailure"
>;

function setup(
  overrides: {
    job?: CreatorPlatformSyncJob;
    error?: Error;
    claim?: ScheduledCreatorPlatformConnectionSyncClaim;
    lastSuccessfulSyncAt?: string;
  } = {},
) {
  const claimedJob = overrides.job ?? job;
  const store = {
    schedule: vi.fn(async () => 1),
    claim: vi.fn().mockResolvedValueOnce(claimedJob).mockResolvedValue(null),
    succeed: vi.fn(async () => true),
    fail: vi.fn(async () => true),
    cancel: vi.fn(async () => true),
    close: vi.fn(async () => undefined),
  } satisfies CreatorPlatformSyncStore;
  const connection = creatorConnection();
  if (overrides.lastSuccessfulSyncAt) {
    connection.lastSuccessfulSyncAt = overrides.lastSuccessfulSyncAt;
  }
  const repository = {
    claimScheduledConnectionSync: vi.fn(async ({ leaseId }) =>
      overrides.claim
        ? overrides.claim
        : {
            outcome: "claimed" as const,
            access: {
              creatorProfileId: connection.creatorProfileId,
              organizationId: connection.organizationId,
              actorUserId: "00000000-0000-4000-8000-000000000006",
            },
            connection: { ...connection, syncLeaseId: leaseId },
          },
    ),
    releaseConnectionSync: vi.fn(async () => undefined),
    markConnectionError: vi.fn(async () => undefined),
    queueCredentialCleanup: vi.fn(async () => undefined),
    updateConnectionFromImport: vi.fn(async ({ connection: updated }) => updated),
    markCredentialCleaned: vi.fn(async () => undefined),
    recordCredentialCleanupFailure: vi.fn(async () => undefined),
  } satisfies Repository;
  const grant: CreatorPlatformGrant = {
    provider: "instagram",
    accessToken: "not-persisted",
    scopes: ["stats.read"],
  };
  const credentialGet = vi.fn(async (reference: string) => {
    if (!reference) throw new Error("Credential reference is required");
    return grant;
  });
  const vault: ProviderCredentialVault = {
    async get<T>(reference: string) {
      return (await credentialGet(reference)) as T;
    },
    put: vi.fn(async () => undefined),
    delete: vi.fn(async () => undefined),
  };
  const adapter = creatorAdapter(overrides.error);
  return {
    store,
    repository,
    vault,
    credentialGet,
    options: {
      store,
      repository,
      credentialVault: vault,
      adapters: { instagram: adapter },
      credentialSecretPrefix: "vault/creator-platforms",
      workerId: job.workerId,
      now: () => now,
    },
  };
}

function creatorConnection(): CreatorPlatformConnectionRecord {
  return {
    connectionId: job.connectionId!,
    platformId: "00000000-0000-4000-8000-000000000003",
    creatorProfileId: "00000000-0000-4000-8000-000000000004",
    organizationId: "00000000-0000-4000-8000-000000000005",
    authorizationId: "00000000-0000-4000-8000-000000000007",
    platform: "instagram",
    provider: "meta",
    externalAccountId: "instagram-account",
    status: "active",
    capabilities: ["followerCount"],
    importedFields: ["followerCount"],
    unavailableFields: [],
    credentialRef: "vault/current",
    syncLeaseId: "00000000-0000-4000-8000-000000000008",
    lastSyncAttemptAt: now.toISOString(),
    lastSuccessfulSyncAt: "2026-08-31T12:00:00.000Z",
    lastErrorCode: null,
  };
}

function creatorAdapter(error?: Error): CreatorPlatformAdapter {
  const account: CreatorPlatformAccount = {
    provider: "instagram",
    providerAccountId: "instagram-account",
    displayName: "Creator",
    accountType: "profile",
  };
  return {
    provider: "instagram",
    buildAuthorizationUrl: () => "https://provider.example/oauth",
    exchangeCode: async () => ({ provider: "instagram", accessToken: "unused", scopes: [] }),
    async listAccounts(grant) {
      if (error) throw error;
      return { accounts: [account], grant };
    },
    async importAccount(_account, _grant, window) {
      const unavailable = { value: null, unavailableReason: "not_supported" as const };
      return {
        provider: "instagram",
        providerAccountId: account.providerAccountId,
        importedAt: now.toISOString(),
        window,
        followers: { value: 10_000 },
        contentCount: { value: 4 },
        likes: { value: 400 },
        comments: { value: 40 },
        shares: { value: 20 },
        reach: unavailable,
        views: unavailable,
        demographics: { countries: unavailable, ageGroups: unavailable, genders: unavailable },
      };
    },
  };
}
