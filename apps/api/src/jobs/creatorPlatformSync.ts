import { randomUUID } from "node:crypto";

import type { CreatorPlatformProvider } from "@vayada/domain-marketplace";

import { CreatorPlatformRequestError } from "../integrations/creatorPlatforms/http.js";
import type { CreatorPlatformAdapterRegistry } from "../integrations/creatorPlatforms/registry.js";
import type { ProviderCredentialVault } from "../platform/providerCredentialVault.js";
import {
  CreatorPlatformAuthorizationAccessRevokedError,
  CreatorPlatformConnectionChangedError,
  CreatorPlatformCredentialReadError,
  CreatorPlatformGrantUnavailableError,
  syncClaimedCreatorPlatformConnection,
  type MarketplaceCreatorPlatformConnectionRepository,
} from "../routes/marketplaceCreatorPlatformConnections.js";
import type {
  CreatorPlatformSyncJob,
  CreatorPlatformSyncStore,
} from "./creatorPlatformSyncStore.js";

const CONNECTION_LEASE_MS = 10 * 60_000;
const DEFAULT_SYNC_INTERVAL_MS = 24 * 60 * 60_000;
const DEFAULT_MAX_ATTEMPTS = 5;
const BUSY_RETRY_MS = 30_000;
const MAX_RETRY_MS = 60 * 60_000;

export const DEFAULT_CREATOR_PLATFORM_MINIMUM_SPACING_MS: Record<CreatorPlatformProvider, number> =
  {
    meta: 1_000,
    tiktok: 2_000,
    google: 1_000,
  };

const RETRY_BASE_MS: Record<CreatorPlatformProvider, number> = {
  meta: 60_000,
  tiktok: 30_000,
  google: 60_000,
};

type SyncRepository = Pick<
  MarketplaceCreatorPlatformConnectionRepository,
  | "claimScheduledConnectionSync"
  | "releaseConnectionSync"
  | "markConnectionError"
  | "queueCredentialCleanup"
  | "updateConnectionFromImport"
  | "markCredentialCleaned"
  | "recordCredentialCleanupFailure"
>;

export type CreatorPlatformSyncCycleOptions = {
  store: CreatorPlatformSyncStore;
  repository: SyncRepository;
  credentialVault: ProviderCredentialVault;
  adapters: CreatorPlatformAdapterRegistry;
  credentialSecretPrefix: string;
  workerId: string;
  now?: () => Date;
  batchSize?: number;
  syncIntervalMs?: number;
  maxAttempts?: number;
  minimumSpacingMs?: Record<CreatorPlatformProvider, number>;
};

export type CreatorPlatformSyncCycleResult = {
  scheduled: number;
  processed: number;
  succeeded: number;
  retried: number;
  reconnectRequired: number;
  canceled: number;
  deadLettered: number;
};

export async function runCreatorPlatformSyncCycle(
  options: CreatorPlatformSyncCycleOptions,
): Promise<CreatorPlatformSyncCycleResult> {
  const now = options.now ?? (() => new Date());
  const result: CreatorPlatformSyncCycleResult = {
    scheduled: await options.store.schedule({
      now: now(),
      syncIntervalMs: options.syncIntervalMs ?? DEFAULT_SYNC_INTERVAL_MS,
      maxAttempts: options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS,
    }),
    processed: 0,
    succeeded: 0,
    retried: 0,
    reconnectRequired: 0,
    canceled: 0,
    deadLettered: 0,
  };
  for (let index = 0; index < (options.batchSize ?? 10); index += 1) {
    const job = await options.store.claim({
      now: now(),
      workerId: options.workerId,
      minimumSpacingMs: options.minimumSpacingMs ?? DEFAULT_CREATOR_PLATFORM_MINIMUM_SPACING_MS,
    });
    if (!job) break;
    result.processed += 1;
    result[await processJob(options, job, now)] += 1;
  }
  return result;
}

async function processJob(
  options: CreatorPlatformSyncCycleOptions,
  job: CreatorPlatformSyncJob,
  now: () => Date,
): Promise<Exclude<keyof CreatorPlatformSyncCycleResult, "scheduled" | "processed">> {
  if (job.invalidPayload || !job.connectionId) {
    await requireFinalized(
      options.store.cancel(job, { now: now(), code: "invalid_job_payload" }),
      job,
    );
    return "canceled";
  }
  const leaseId = randomUUID();
  const leaseExpiresAt = new Date(now().getTime() + CONNECTION_LEASE_MS).toISOString();
  const claim = await options.repository.claimScheduledConnectionSync({
    connectionId: job.connectionId,
    leaseId,
    leaseExpiresAt,
  });
  if (claim.outcome !== "claimed") {
    if (claim.outcome === "ineligible") {
      await requireFinalized(
        options.store.cancel(job, { now: now(), code: "connection_ineligible" }),
        job,
      );
      return "canceled";
    }
    const retryAt = retryDate(job, now(), BUSY_RETRY_MS);
    await requireFinalized(
      options.store.fail(job, { now: now(), code: "connection_busy", retryAt }),
      job,
    );
    return retryAt ? "retried" : "deadLettered";
  }

  const { access, connection } = claim;
  if (!connection.credentialRef || !connection.syncLeaseId) {
    await releaseConnection(options.repository, connection, leaseId);
    await requireFinalized(
      options.store.cancel(job, { now: now(), code: "connection_changed" }),
      job,
    );
    return "canceled";
  }
  if (
    connection.lastSuccessfulSyncAt &&
    new Date(connection.lastSuccessfulSyncAt).getTime() >= new Date(job.scheduledAt).getTime()
  ) {
    await releaseConnection(options.repository, connection, leaseId);
    await requireFinalized(options.store.succeed(job, { now: now(), outcome: "succeeded" }), job);
    return "succeeded";
  }
  const adapter = options.adapters[connection.platform];
  if (!adapter) {
    await releaseConnection(options.repository, connection, leaseId);
    await requireFinalized(
      options.store.fail(job, { now: now(), code: "provider_not_configured", retryAt: null }),
      job,
    );
    return "deadLettered";
  }

  try {
    await syncClaimedCreatorPlatformConnection({
      repository: options.repository,
      credentialVault: options.credentialVault,
      adapter,
      access,
      connection,
      credentialSecretPrefix: options.credentialSecretPrefix,
      credentialCleanupAvailableAt: leaseExpiresAt,
      now,
      cleanCredential: (credentialRef, authorizationId) =>
        cleanCredential(options, credentialRef, authorizationId, now()),
    });
    await requireFinalized(options.store.succeed(job, { now: now(), outcome: "succeeded" }), job);
    return "succeeded";
  } catch (error) {
    if (
      error instanceof CreatorPlatformAuthorizationAccessRevokedError ||
      error instanceof CreatorPlatformConnectionChangedError
    ) {
      await releaseConnection(options.repository, connection, leaseId);
      await requireFinalized(
        options.store.cancel(job, { now: now(), code: "connection_ineligible" }),
        job,
      );
      return "canceled";
    }
    const code = failureCode(error);
    if (isAuthorizationFailure(error)) {
      await options.repository.markConnectionError({
        connectionId: connection.connectionId,
        authorizationId: connection.authorizationId,
        credentialRef: connection.credentialRef,
        syncLeaseId: leaseId,
        status: "reconnect_required",
        errorCode: code,
      });
      await requireFinalized(
        options.store.succeed(job, { now: now(), outcome: "reconnect_required" }),
        job,
      );
      return "reconnectRequired";
    }
    const retryAt = isRetryable(error)
      ? retryDate(job, now(), retryDelay(connection.provider, job, error))
      : null;
    if (retryAt) {
      await releaseConnection(options.repository, connection, leaseId);
    } else {
      await options.repository.markConnectionError({
        connectionId: connection.connectionId,
        authorizationId: connection.authorizationId,
        credentialRef: connection.credentialRef,
        syncLeaseId: leaseId,
        status: "sync_failed",
        errorCode: code,
      });
    }
    await requireFinalized(options.store.fail(job, { now: now(), code, retryAt }), job);
    return retryAt ? "retried" : "deadLettered";
  }
}

async function releaseConnection(
  repository: SyncRepository,
  connection: { connectionId: string; authorizationId: string },
  leaseId: string,
): Promise<void> {
  await repository.releaseConnectionSync({
    connectionId: connection.connectionId,
    authorizationId: connection.authorizationId,
    syncLeaseId: leaseId,
  });
}

async function cleanCredential(
  options: CreatorPlatformSyncCycleOptions,
  credentialRef: string,
  authorizationId: string,
  now: Date,
): Promise<boolean> {
  try {
    await options.credentialVault.delete(credentialRef);
    await options.repository.markCredentialCleaned({
      credentialRef,
      cleanedAt: now.toISOString(),
    });
    return true;
  } catch {
    await options.repository
      .recordCredentialCleanupFailure({
        credentialRef,
        authorizationId,
        errorCode: "credential_vault_delete_failed",
      })
      .catch(() => undefined);
    return false;
  }
}

function isAuthorizationFailure(error: unknown): boolean {
  return (
    error instanceof CreatorPlatformGrantUnavailableError ||
    (error instanceof CreatorPlatformRequestError && error.category === "authorization")
  );
}

function isRetryable(error: unknown): boolean {
  return (
    error instanceof CreatorPlatformCredentialReadError ||
    error instanceof TypeError ||
    (error instanceof CreatorPlatformRequestError &&
      ["rate_limit", "quota", "transient"].includes(error.category))
  );
}

function failureCode(error: unknown): string {
  if (error instanceof CreatorPlatformCredentialReadError) return "credential_vault_unavailable";
  if (error instanceof CreatorPlatformGrantUnavailableError) return "credential_unavailable";
  if (error instanceof CreatorPlatformRequestError) {
    return error.category === "authorization"
      ? "provider_authorization_invalid"
      : `provider_${error.category}`;
  }
  return error instanceof TypeError ? "provider_network_error" : "provider_sync_failed";
}

function retryDelay(
  provider: CreatorPlatformProvider,
  job: CreatorPlatformSyncJob,
  error: unknown,
): number {
  const throttled =
    error instanceof CreatorPlatformRequestError &&
    (error.category === "rate_limit" || error.category === "quota");
  const multiplier = throttled ? 5 : 1;
  return Math.min(
    MAX_RETRY_MS,
    RETRY_BASE_MS[provider] * multiplier * 2 ** Math.max(0, job.attemptNumber - 1),
  );
}

function retryDate(job: CreatorPlatformSyncJob, now: Date, delayMs: number): Date | null {
  return job.attemptNumber < job.maxAttempts ? new Date(now.getTime() + delayMs) : null;
}

async function requireFinalized(
  finalized: Promise<boolean>,
  job: CreatorPlatformSyncJob,
): Promise<void> {
  if (!(await finalized)) throw new Error(`Lost creator platform sync job lease ${job.jobId}`);
}
