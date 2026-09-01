import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";

import type { IdentityLifecycleCommandBus } from "@vayada/backend-auth";
import {
  calculateCreatorPlatformEngagementRate,
  CREATOR_PLATFORM_ENGAGEMENT_FORMULA_VERSION,
  CREATOR_PLATFORM_ENGAGEMENT_WINDOW_DAYS,
  type ConnectableCreatorPlatform,
  type CreatorPlatformConnectionStatus,
  type CreatorPlatformImportField,
  type CreatorPlatformProvider as CredentialProvider,
  type CreatorPlatformUnavailableField,
  type CreatorPlatformUnavailableReason as DomainUnavailableReason,
} from "@vayada/domain-marketplace";
import pg, { type QueryResult, type QueryResultRow } from "pg";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

import type {
  CreatorPlatformAccount,
  CreatorPlatformAdapter,
  CreatorPlatformGrant,
  CreatorPlatformImport,
  CreatorPlatformMetric,
  CreatorPlatformUnavailableReason as AdapterUnavailableReason,
} from "../integrations/creatorPlatforms/types.js";
import type { CreatorPlatformAdapterRegistry } from "../integrations/creatorPlatforms/registry.js";
import { CreatorPlatformRequestError } from "../integrations/creatorPlatforms/http.js";
import type { ProviderCredentialVault } from "../platform/providerCredentialVault.js";
import {
  resolveCreatorProfileAccess,
  type CreatorProfileAccess,
  type MarketplaceCreatorSelfServiceRepository,
} from "./marketplaceCreatorSelfService.js";

const authorizationLifetimeMs = 10 * 60 * 1000;
const authorizationProcessingLeaseMs = 10 * 60 * 1000;
const connectionSyncLeaseMs = 10 * 60 * 1000;
const oauthStateCookieMaxAgeSeconds = authorizationLifetimeMs / 1000;
export type CreatorPlatformConnectionDocument = {
  connectionId: string;
  platformId: string;
  platform: ConnectableCreatorPlatform;
  provider: CredentialProvider;
  externalAccountId: string;
  status: CreatorPlatformConnectionStatus;
  capabilities: CreatorPlatformImportField[];
  importedFields: CreatorPlatformImportField[];
  unavailableFields: CreatorPlatformUnavailableField[];
  lastSyncAttemptAt: string | null;
  lastSuccessfulSyncAt: string | null;
  lastErrorCode: string | null;
};

type AuthorizationStatus =
  "authorizing" | "processing" | "pending_account_selection" | "active" | "failed" | "expired";

type AuthorizationRecord = {
  authorizationId: string;
  creatorProfileId: string;
  organizationId: string;
  actorUserId: string;
  platform: ConnectableCreatorPlatform;
  provider: CredentialProvider;
  targetPlatformId: string | null;
  status: AuthorizationStatus;
  credentialRef: string | null;
  candidates: CreatorPlatformAccount[];
  expiresAt: string;
};

export type CreatorPlatformConnectionRecord = CreatorPlatformConnectionDocument & {
  creatorProfileId: string;
  organizationId: string;
  authorizationId: string;
  externalAccountId: string;
  credentialRef: string | null;
  syncLeaseId: string | null;
};

export type ScheduledCreatorPlatformConnectionSyncClaim =
  | {
      outcome: "claimed";
      access: CreatorProfileAccess;
      connection: CreatorPlatformConnectionRecord;
    }
  | { outcome: "busy" | "ineligible" };

type ImportedProjection = {
  account: CreatorPlatformAccount;
  imported: CreatorPlatformImport;
  engagementRate: number | null;
  capabilities: CreatorPlatformImportField[];
  importedFields: CreatorPlatformImportField[];
  unavailableFields: CreatorPlatformUnavailableField[];
};

type CredentialCleanupCandidate = {
  credentialRef: string;
  authorizationId: string;
  claimId: string;
};

export type MarketplaceCreatorPlatformConnectionRepository = {
  createAuthorization(input: {
    authorizationId: string;
    access: CreatorProfileAccess;
    platform: ConnectableCreatorPlatform;
    targetPlatformId: string | null;
    stateDigest: string;
    credentialRef: string;
    expiresAt: string;
  }): Promise<boolean>;
  consumeAuthorization(input: {
    platform: ConnectableCreatorPlatform;
    stateDigest: string;
    now: string;
  }): Promise<AuthorizationRecord | null>;
  setAuthorizationCandidates(input: {
    authorizationId: string;
    credentialRef: string;
    candidates: CreatorPlatformAccount[];
    grantedScopes: string[];
  }): Promise<boolean>;
  failAuthorization(input: { authorizationId: string; errorCode: string }): Promise<boolean>;
  getPendingAuthorization(access: CreatorProfileAccess): Promise<AuthorizationRecord | null>;
  getAuthorization(input: {
    access: CreatorProfileAccess;
    authorizationId: string;
  }): Promise<AuthorizationRecord | null>;
  claimAuthorizationAccount(input: {
    access: CreatorProfileAccess;
    authorizationId: string;
    externalAccountId: string;
  }): Promise<AuthorizationRecord | null>;
  releaseAuthorizationAccountClaim(input: { authorizationId: string }): Promise<void>;
  isAuthorizationActorAuthorized(authorization: AuthorizationRecord): Promise<boolean>;
  completeConnection(input: {
    authorization: AuthorizationRecord;
    credentialRef: string;
    grant: CreatorPlatformGrant;
    projection: ImportedProjection;
  }): Promise<CreatorPlatformConnectionDocument>;
  listConnections(access: CreatorProfileAccess): Promise<CreatorPlatformConnectionDocument[]>;
  getConnection(input: {
    access: CreatorProfileAccess;
    connectionId: string;
  }): Promise<CreatorPlatformConnectionRecord | null>;
  claimConnectionSync(input: {
    access: CreatorProfileAccess;
    connectionId: string;
    leaseId: string;
    leaseExpiresAt: string;
  }): Promise<CreatorPlatformConnectionRecord | null>;
  claimScheduledConnectionSync(input: {
    connectionId: string;
    leaseId: string;
    leaseExpiresAt: string;
  }): Promise<ScheduledCreatorPlatformConnectionSyncClaim>;
  releaseConnectionSync(input: {
    connectionId: string;
    authorizationId: string;
    syncLeaseId: string;
  }): Promise<void>;
  updateConnectionFromImport(input: {
    access: CreatorProfileAccess;
    connection: CreatorPlatformConnectionRecord;
    grant: CreatorPlatformGrant;
    nextCredentialRef: string;
    projection: ImportedProjection;
  }): Promise<CreatorPlatformConnectionDocument>;
  markConnectionError(input: {
    connectionId: string;
    authorizationId: string;
    credentialRef: string;
    syncLeaseId: string;
    status: "reconnect_required" | "sync_failed";
    errorCode: string;
  }): Promise<void>;
  revokeConnection(input: {
    access: CreatorProfileAccess;
    connectionId: string;
    authorizationId: string;
    credentialRef: string | null;
  }): Promise<{ revoked: boolean }>;
  recordRevocationError(input: { connectionId: string; errorCode: string }): Promise<void>;
  queueCredentialCleanup(input: {
    authorizationId: string;
    credentialRef: string;
    availableAt?: string;
  }): Promise<void>;
  listCredentialCleanupCandidates(input: {
    now: string;
    limit: number;
  }): Promise<CredentialCleanupCandidate[]>;
  markCredentialCleaned(input: {
    credentialRef: string;
    cleanedAt: string;
    claimId?: string;
  }): Promise<void>;
  recordCredentialCleanupFailure(input: {
    credentialRef: string;
    authorizationId: string;
    claimId?: string;
    errorCode: string;
  }): Promise<void>;
  close?(): Promise<void>;
};

export type MarketplaceCreatorPlatformConnectionRoutesOptions = {
  repository: MarketplaceCreatorPlatformConnectionRepository;
  profileRepository: MarketplaceCreatorSelfServiceRepository;
  lifecycleCommandBus: IdentityLifecycleCommandBus;
  credentialVault: ProviderCredentialVault;
  adapters: CreatorPlatformAdapterRegistry;
  callbackBaseUrl: string;
  webReturnUrl: string;
  credentialSecretPrefix: string;
  now?: () => Date;
  credentialCleanupIntervalMs?: number;
};

export async function registerMarketplaceCreatorPlatformConnectionRoutes(
  app: FastifyInstance,
  options: MarketplaceCreatorPlatformConnectionRoutesOptions,
): Promise<void> {
  const now = options.now ?? (() => new Date());
  const secureOAuthCookies = new URL(options.callbackBaseUrl).protocol === "https:";
  const resolveAccess = (request: FastifyRequest, reply: FastifyReply) =>
    resolveCreatorProfileAccess(
      request,
      reply,
      options.profileRepository,
      options.lifecycleCommandBus,
      { provisionIfMissing: false },
    );

  let cleanupPromise: Promise<void> | null = null;
  const cleanCredential = async (
    credentialRef: string,
    authorizationId: string,
    claimId?: string,
  ): Promise<boolean> => {
    try {
      await options.credentialVault.delete(credentialRef);
      await options.repository.markCredentialCleaned({
        credentialRef,
        cleanedAt: now().toISOString(),
        ...(claimId ? { claimId } : {}),
      });
      return true;
    } catch {
      await options.repository
        .recordCredentialCleanupFailure({
          credentialRef,
          authorizationId,
          ...(claimId ? { claimId } : {}),
          errorCode: "credential_vault_delete_failed",
        })
        .catch(() => undefined);
      return false;
    }
  };
  const cleanCredentials = (): Promise<void> => {
    if (cleanupPromise) return cleanupPromise;
    cleanupPromise = (async () => {
      try {
        const candidates = await options.repository.listCredentialCleanupCandidates({
          now: now().toISOString(),
          limit: 50,
        });
        for (const candidate of candidates) {
          await cleanCredential(
            candidate.credentialRef,
            candidate.authorizationId,
            candidate.claimId,
          );
        }
      } catch (error) {
        app.log.warn({ err: safeProviderError(error) }, "Creator credential cleanup failed");
      }
    })().finally(() => {
      cleanupPromise = null;
    });
    return cleanupPromise;
  };
  void cleanCredentials();
  const cleanupTimer = setInterval(
    () => void cleanCredentials(),
    options.credentialCleanupIntervalMs ?? 60_000,
  );
  cleanupTimer.unref();

  app.addHook("onClose", async () => {
    clearInterval(cleanupTimer);
    await cleanupPromise;
    await options.repository.close?.();
  });

  app.get("/creators/me/platform-connections", async (request, reply) => {
    const access = await resolveAccess(request, reply);
    if (!access) return;
    return { connections: await options.repository.listConnections(access) };
  });

  app.post<{ Params: { platform: string }; Body: { platformId?: string } }>(
    "/creators/me/platform-connections/:platform/authorize",
    async (request, reply) => {
      const platform = parseConnectablePlatform(request.params.platform);
      if (!platform) {
        return reply.status(400).send({
          code: "unsupported_creator_platform",
          detail: "This platform cannot be connected automatically",
        });
      }
      const adapter = options.adapters[platform];
      if (!adapter) {
        return reply.status(503).send({
          code: "creator_platform_not_configured",
          detail: `${providerLabel(platform)} connections are not configured yet`,
        });
      }
      const access = await resolveAccess(request, reply);
      if (!access) return;

      const targetPlatformId = request.body?.platformId ?? null;
      if (targetPlatformId !== null && !isUuid(targetPlatformId)) {
        return reply.status(400).send({
          code: "invalid_platform_id",
          detail: "platformId must identify an existing creator platform",
        });
      }

      const authorizationId = randomUUID();
      const state = randomBytes(32).toString("base64url");
      const expiresAt = new Date(now().getTime() + authorizationLifetimeMs).toISOString();
      const credentialRef = credentialReference(options.credentialSecretPrefix, authorizationId);
      const created = await options.repository.createAuthorization({
        authorizationId,
        access,
        platform,
        targetPlatformId,
        stateDigest: digestState(state),
        credentialRef,
        expiresAt,
      });
      if (!created) {
        return reply.status(409).send({
          code: "creator_platform_changed",
          detail: "The selected platform is no longer available. Refresh and try again.",
        });
      }
      const redirectUri = callbackUrl(options.callbackBaseUrl, platform);
      reply.header("set-cookie", oauthStateCookie(state, secureOAuthCookies));
      return {
        authorizationUrl: adapter.buildAuthorizationUrl(state, redirectUri),
      };
    },
  );

  app.get<{ Params: { provider: string } }>(
    "/creator-platform-oauth/:provider/callback",
    async (request, reply) => {
      const platform = parseConnectablePlatform(request.params.provider);
      if (!platform) return reply.status(404).send({ detail: "Unknown OAuth provider" });
      const query = request.query as { code?: unknown; state?: unknown; error?: unknown };
      const state = typeof query.state === "string" ? query.state : "";
      if (!state) {
        return redirectResult(reply, options.webReturnUrl, platform, "error", {
          errorCode: "invalid_oauth_state",
        });
      }
      const stateCookieName = oauthStateCookieName(state, secureOAuthCookies);
      const stateCookieValue = readCookie(request.headers.cookie, stateCookieName);
      if (!oauthStateCookieMatches(state, stateCookieValue)) {
        reply.header("set-cookie", clearOAuthStateCookie(state, secureOAuthCookies));
        return redirectResult(reply, options.webReturnUrl, platform, "error", {
          errorCode: "oauth_browser_mismatch",
        });
      }
      reply.header("set-cookie", clearOAuthStateCookie(state, secureOAuthCookies));
      const authorization = await options.repository.consumeAuthorization({
        platform,
        stateDigest: digestState(state),
        now: now().toISOString(),
      });
      if (!authorization) {
        return redirectResult(reply, options.webReturnUrl, platform, "error", {
          errorCode: "expired_oauth_state",
        });
      }
      const failAndRedirect = async (errorCode: string) => {
        const failed = await options.repository.failAuthorization({
          authorizationId: authorization.authorizationId,
          errorCode,
        });
        if (failed && authorization.credentialRef) {
          await cleanCredential(authorization.credentialRef, authorization.authorizationId);
        }
        return redirectResult(reply, options.webReturnUrl, platform, "error", { errorCode });
      };
      if (typeof query.error === "string" || typeof query.code !== "string" || !query.code) {
        return failAndRedirect(
          typeof query.error === "string" ? "authorization_denied" : "missing_code",
        );
      }
      if (!(await options.repository.isAuthorizationActorAuthorized(authorization))) {
        return failAndRedirect("authorization_access_revoked");
      }

      const adapter = options.adapters[platform];
      if (!adapter) {
        return failAndRedirect("provider_not_configured");
      }

      const credentialRef =
        authorization.credentialRef ??
        credentialReference(options.credentialSecretPrefix, authorization.authorizationId);
      try {
        const exchanged = await adapter.exchangeCode(
          query.code,
          callbackUrl(options.callbackBaseUrl, platform),
        );
        const accountList = await adapter.listAccounts(exchanged);
        if (accountList.accounts.length === 0) {
          return failAndRedirect("no_eligible_account");
        }

        if (accountList.accounts.length > 1) {
          await options.credentialVault.put(credentialRef, accountList.grant);
          const pendingSelection = await options.repository.setAuthorizationCandidates({
            authorizationId: authorization.authorizationId,
            credentialRef,
            candidates: accountList.accounts,
            grantedScopes: accountList.grant.scopes,
          });
          if (!pendingSelection) return failAndRedirect("authorization_expired");
          return redirectResult(reply, options.webReturnUrl, platform, "select", {
            authorizationId: authorization.authorizationId,
          });
        }

        const accountGrant =
          adapter.grantForAccount?.(accountList.accounts[0], accountList.grant) ??
          accountList.grant;
        const projection = await importProjection(
          adapter,
          accountList.accounts[0],
          accountGrant,
          now(),
        );
        const finalCredentialRef = credentialReference(
          options.credentialSecretPrefix,
          `${authorization.authorizationId}/account/${randomUUID()}`,
        );
        await options.repository.queueCredentialCleanup({
          authorizationId: authorization.authorizationId,
          credentialRef: finalCredentialRef,
          availableAt: new Date(now().getTime() + authorizationProcessingLeaseMs).toISOString(),
        });
        await options.credentialVault.put(finalCredentialRef, accountGrant);
        let connection: CreatorPlatformConnectionDocument;
        try {
          connection = await options.repository.completeConnection({
            authorization,
            credentialRef: finalCredentialRef,
            grant: accountGrant,
            projection,
          });
        } catch (error) {
          if (
            error instanceof CreatorPlatformAuthorizationAccessRevokedError ||
            error instanceof CreatorPlatformAuthorizationConsumedError ||
            isCreatorPlatformConflict(error)
          ) {
            throw error;
          }
          request.log.warn(
            { err: safeProviderError(error), platform },
            "Creator platform persistence outcome is unknown",
          );
          return redirectResult(reply, options.webReturnUrl, platform, "error", {
            errorCode: "connection_pending",
          });
        }
        if (authorization.credentialRef) {
          await cleanCredential(authorization.credentialRef, authorization.authorizationId);
        }
        return redirectResult(reply, options.webReturnUrl, platform, "success", {
          connectionId: connection.connectionId,
        });
      } catch (error) {
        request.log.warn(
          { err: safeProviderError(error), platform },
          "Creator platform OAuth failed",
        );
        return failAndRedirect(
          error instanceof CreatorPlatformAuthorizationAccessRevokedError
            ? "authorization_access_revoked"
            : isCreatorPlatformConflict(error)
              ? "platform_account_already_connected"
              : "provider_exchange_failed",
        );
      }
    },
  );

  app.get("/creators/me/platform-authorizations/pending", async (request, reply) => {
    const access = await resolveAccess(request, reply);
    if (!access) return;
    const authorization = await options.repository.getPendingAuthorization(access);
    if (!authorization) return null;
    return {
      authorizationId: authorization.authorizationId,
      platform: authorization.platform,
      accounts: authorization.candidates.map(safeAccount),
    };
  });

  app.post<{ Params: { authorizationId: string } }>(
    "/creators/me/platform-authorizations/:authorizationId/accounts",
    async (request, reply) => {
      const body = request.body as { externalAccountId?: unknown };
      if (typeof body?.externalAccountId !== "string" || !body.externalAccountId) {
        return reply.status(400).send({
          code: "invalid_body",
          detail: "externalAccountId is required",
        });
      }
      const access = await resolveAccess(request, reply);
      if (!access) return;
      const authorization = await options.repository.getAuthorization({
        access,
        authorizationId: request.params.authorizationId,
      });
      if (!authorization || authorization.status !== "pending_account_selection") {
        return reply.status(404).send({
          code: "platform_authorization_not_found",
          detail: "The pending platform authorization was not found",
        });
      }
      const account = authorization.candidates.find(
        (candidate) => candidate.providerAccountId === body.externalAccountId,
      );
      if (!account || !authorization.credentialRef) {
        return reply.status(400).send({
          code: "invalid_platform_account",
          detail: "Select an account returned by the provider",
        });
      }
      const claimedAuthorization = await options.repository.claimAuthorizationAccount({
        access,
        authorizationId: authorization.authorizationId,
        externalAccountId: account.providerAccountId,
      });
      if (!claimedAuthorization) {
        return reply.status(409).send({
          code: "platform_authorization_already_selected",
          detail: "Another account was already selected. Refresh your connections.",
        });
      }
      const adapter = options.adapters[authorization.platform];
      let grant: CreatorPlatformGrant | null;
      try {
        grant = await options.credentialVault.get<CreatorPlatformGrant>(
          authorization.credentialRef,
        );
      } catch (error) {
        request.log.warn(
          { err: safeProviderError(error), platform: authorization.platform },
          "Creator platform credential read failed",
        );
        await options.repository.releaseAuthorizationAccountClaim({
          authorizationId: authorization.authorizationId,
        });
        return reply.status(502).send({
          code: "credential_vault_unavailable",
          detail: "Platform credentials are temporarily unavailable. Please try again.",
        });
      }
      if (!adapter || !grant || grant.provider !== authorization.platform) {
        await options.repository.failAuthorization({
          authorizationId: authorization.authorizationId,
          errorCode: "credential_unavailable",
        });
        if (authorization.credentialRef) {
          await cleanCredential(authorization.credentialRef, authorization.authorizationId);
        }
        return reply.status(409).send({
          code: "platform_reconnect_required",
          detail: "The authorization expired. Connect the platform again.",
        });
      }
      try {
        const accountGrant = adapter.grantForAccount?.(account, grant) ?? grant;
        const projection = await importProjection(adapter, account, accountGrant, now());
        const finalCredentialRef = credentialReference(
          options.credentialSecretPrefix,
          `${authorization.authorizationId}/account/${randomUUID()}`,
        );
        await options.repository.queueCredentialCleanup({
          authorizationId: authorization.authorizationId,
          credentialRef: finalCredentialRef,
          availableAt: new Date(now().getTime() + authorizationProcessingLeaseMs).toISOString(),
        });
        await options.credentialVault.put(finalCredentialRef, accountGrant);
        let connection: CreatorPlatformConnectionDocument;
        try {
          connection = await options.repository.completeConnection({
            authorization: claimedAuthorization,
            credentialRef: finalCredentialRef,
            grant: accountGrant,
            projection,
          });
        } catch (error) {
          if (
            error instanceof CreatorPlatformAuthorizationAccessRevokedError ||
            error instanceof CreatorPlatformAuthorizationConsumedError ||
            isCreatorPlatformConflict(error)
          ) {
            throw error;
          }
          request.log.warn(
            { err: safeProviderError(error), platform: authorization.platform },
            "Creator platform persistence outcome is unknown",
          );
          return reply.status(502).send({
            code: "platform_connection_pending",
            detail: "The connection result is still being reconciled. Refresh before retrying.",
          });
        }
        await cleanCredential(authorization.credentialRef, authorization.authorizationId);
        return reply.status(201).send(connection);
      } catch (error) {
        request.log.warn(
          { err: safeProviderError(error), platform: authorization.platform },
          "Creator platform import failed",
        );
        if (error instanceof CreatorPlatformAuthorizationAccessRevokedError) {
          await options.repository.failAuthorization({
            authorizationId: authorization.authorizationId,
            errorCode: "authorization_access_revoked",
          });
          await cleanCredential(authorization.credentialRef, authorization.authorizationId);
          return reply.status(403).send({
            code: "marketplace_creator_profile_access_required",
            detail: "An active creator profile owner link is required",
          });
        }
        if (error instanceof CreatorPlatformAuthorizationConsumedError) {
          await options.repository.failAuthorization({
            authorizationId: authorization.authorizationId,
            errorCode: "authorization_no_longer_pending",
          });
          await cleanCredential(authorization.credentialRef, authorization.authorizationId);
          return reply.status(409).send({
            code: "platform_authorization_already_completed",
            detail: "This account connection was already completed. Refresh your connections.",
          });
        }
        if (isCreatorPlatformConflict(error)) {
          await options.repository.failAuthorization({
            authorizationId: authorization.authorizationId,
            errorCode: "platform_account_already_connected",
          });
          await cleanCredential(authorization.credentialRef, authorization.authorizationId);
          return reply.status(409).send({
            code: "platform_account_already_connected",
            detail: "This provider account is already connected to a creator profile.",
          });
        }
        await options.repository.releaseAuthorizationAccountClaim({
          authorizationId: authorization.authorizationId,
        });
        return reply.status(502).send({
          code: "provider_import_failed",
          detail: "The selected account could not be imported. Please try again.",
        });
      }
    },
  );

  app.post<{ Params: { connectionId: string } }>(
    "/creators/me/platform-connections/:connectionId/sync",
    async (request, reply) => {
      const access = await resolveAccess(request, reply);
      if (!access) return;
      const connection = await options.repository.getConnection({
        access,
        connectionId: request.params.connectionId,
      });
      if (!connection) {
        return reply.status(404).send({
          code: "platform_connection_not_found",
          detail: "The platform connection was not found",
        });
      }
      if (!connection.credentialRef) {
        return reply.status(409).send({
          code: "platform_reconnect_required",
          detail: "Connect the platform again before syncing it.",
        });
      }
      const adapter = options.adapters[connection.platform];
      if (!adapter) {
        return reply.status(503).send({
          code: "creator_platform_not_configured",
          detail: `${providerLabel(connection.platform)} connections are not configured yet`,
        });
      }
      const syncLeaseId = randomUUID();
      const syncLeaseExpiresAt = new Date(now().getTime() + connectionSyncLeaseMs).toISOString();
      let claimedConnection: CreatorPlatformConnectionRecord | null;
      try {
        claimedConnection = await options.repository.claimConnectionSync({
          access,
          connectionId: connection.connectionId,
          leaseId: syncLeaseId,
          leaseExpiresAt: syncLeaseExpiresAt,
        });
      } catch (error) {
        if (error instanceof CreatorPlatformAuthorizationAccessRevokedError) {
          return reply.status(403).send({
            code: "marketplace_creator_profile_access_required",
            detail: "An active creator profile owner link is required",
          });
        }
        throw error;
      }
      if (!claimedConnection?.credentialRef || !claimedConnection.syncLeaseId) {
        return reply.status(409).send({
          code: "creator_platform_sync_in_progress",
          detail: "This connection is already syncing. Please try again shortly.",
        });
      }
      try {
        return await syncClaimedCreatorPlatformConnection({
          repository: options.repository,
          credentialVault: options.credentialVault,
          adapter,
          access,
          connection: claimedConnection,
          credentialSecretPrefix: options.credentialSecretPrefix,
          credentialCleanupAvailableAt: syncLeaseExpiresAt,
          now,
          cleanCredential,
        });
      } catch (error) {
        if (error instanceof CreatorPlatformAuthorizationAccessRevokedError) {
          await options.repository.releaseConnectionSync({
            connectionId: claimedConnection.connectionId,
            authorizationId: claimedConnection.authorizationId,
            syncLeaseId,
          });
          return reply.status(403).send({
            code: "marketplace_creator_profile_access_required",
            detail: "An active creator profile owner link is required",
          });
        }
        if (error instanceof CreatorPlatformConnectionChangedError) {
          await options.repository.releaseConnectionSync({
            connectionId: claimedConnection.connectionId,
            authorizationId: claimedConnection.authorizationId,
            syncLeaseId,
          });
          return reply.status(409).send({
            code: "creator_platform_connection_changed",
            detail: "The connection changed while it was syncing. Refresh and try again.",
          });
        }
        const credentialReadFailure = error instanceof CreatorPlatformCredentialReadError;
        const authorizationFailure =
          error instanceof CreatorPlatformGrantUnavailableError || isAuthorizationFailure(error);
        request.log.warn(
          { err: safeProviderError(error), platform: claimedConnection.platform },
          credentialReadFailure
            ? "Creator platform credential read failed"
            : "Creator platform sync failed",
        );
        await options.repository.markConnectionError({
          connectionId: claimedConnection.connectionId,
          authorizationId: claimedConnection.authorizationId,
          credentialRef: claimedConnection.credentialRef,
          syncLeaseId,
          status: authorizationFailure ? "reconnect_required" : "sync_failed",
          errorCode: credentialReadFailure
            ? "credential_vault_unavailable"
            : authorizationFailure
              ? error instanceof CreatorPlatformGrantUnavailableError
                ? "credential_unavailable"
                : "provider_authorization_invalid"
              : "provider_sync_failed",
        });
        return reply
          .status(error instanceof CreatorPlatformGrantUnavailableError ? 409 : 502)
          .send({
            code: authorizationFailure ? "platform_reconnect_required" : "provider_sync_failed",
            detail:
              error instanceof CreatorPlatformGrantUnavailableError
                ? "Connect the platform again before syncing it."
                : "The platform could not be refreshed. Please try again.",
          });
      }
    },
  );

  app.delete<{ Params: { connectionId: string } }>(
    "/creators/me/platform-connections/:connectionId",
    async (request, reply) => {
      const access = await resolveAccess(request, reply);
      if (!access) return;
      const connection = await options.repository.getConnection({
        access,
        connectionId: request.params.connectionId,
      });
      if (!connection) return reply.status(404).send({ detail: "Connection not found" });

      let revokeFailed = false;
      let revoked: { revoked: boolean };
      try {
        revoked = await options.repository.revokeConnection({
          access,
          connectionId: connection.connectionId,
          authorizationId: connection.authorizationId,
          credentialRef: connection.credentialRef,
        });
      } catch (error) {
        if (error instanceof CreatorPlatformAuthorizationAccessRevokedError) {
          return reply.status(403).send({
            code: "marketplace_creator_profile_access_required",
            detail: "An active creator profile owner link is required",
          });
        }
        throw error;
      }
      if (!revoked.revoked) return reply.status(404).send({ detail: "Connection not found" });

      if (connection.credentialRef) {
        const cleaned = await cleanCredential(connection.credentialRef, connection.authorizationId);
        if (!cleaned) revokeFailed = true;
      }
      if (revokeFailed) {
        await options.repository.recordRevocationError({
          connectionId: connection.connectionId,
          errorCode: "credential_cleanup_incomplete",
        });
      }
      return reply.status(204).send();
    },
  );
}

export async function syncClaimedCreatorPlatformConnection(input: {
  repository: Pick<
    MarketplaceCreatorPlatformConnectionRepository,
    "queueCredentialCleanup" | "updateConnectionFromImport"
  >;
  credentialVault: ProviderCredentialVault;
  adapter: CreatorPlatformAdapter;
  access: CreatorProfileAccess;
  connection: CreatorPlatformConnectionRecord;
  credentialSecretPrefix: string;
  credentialCleanupAvailableAt: string;
  now: () => Date;
  signal?: AbortSignal;
  cleanCredential(credentialRef: string, authorizationId: string): Promise<boolean>;
}): Promise<CreatorPlatformConnectionDocument> {
  const { connection } = input;
  if (!connection.credentialRef || !connection.syncLeaseId) {
    throw new CreatorPlatformConnectionChangedError();
  }
  let grant: CreatorPlatformGrant | null;
  try {
    grant = await input.credentialVault.get<CreatorPlatformGrant>(
      connection.credentialRef,
      input.signal,
    );
  } catch {
    throw new CreatorPlatformCredentialReadError();
  }
  if (!grant || grant.provider !== connection.platform) {
    throw new CreatorPlatformGrantUnavailableError();
  }
  if (input.adapter.refreshGrant && shouldRefresh(grant, input.now())) {
    grant = await input.adapter.refreshGrant(grant, input.signal);
  }
  const accountList = await input.adapter.listAccounts(grant, input.signal);
  grant = accountList.grant;
  const account = accountList.accounts.find(
    (candidate) => candidate.providerAccountId === connection.externalAccountId,
  );
  if (!account) throw new Error("Connected provider account is no longer available");
  grant = input.adapter.grantForAccount?.(account, grant) ?? grant;
  const projection = await importProjection(
    input.adapter,
    account,
    grant,
    input.now(),
    input.signal,
  );
  const nextCredentialRef = credentialReference(
    input.credentialSecretPrefix,
    `${connection.authorizationId}/sync/${connection.syncLeaseId}`,
  );
  await input.repository.queueCredentialCleanup({
    authorizationId: connection.authorizationId,
    credentialRef: nextCredentialRef,
    availableAt: input.credentialCleanupAvailableAt,
  });
  await input.credentialVault.put(nextCredentialRef, grant, input.signal);
  const updated = await input.repository.updateConnectionFromImport({
    access: input.access,
    connection,
    grant,
    nextCredentialRef,
    projection,
  });
  await input.cleanCredential(connection.credentialRef, connection.authorizationId);
  return updated;
}

function parseConnectablePlatform(value: string): ConnectableCreatorPlatform | null {
  return ["instagram", "facebook", "tiktok", "youtube"].includes(value)
    ? (value as ConnectableCreatorPlatform)
    : null;
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function providerLabel(provider: ConnectableCreatorPlatform): string {
  if (provider === "tiktok") return "TikTok";
  if (provider === "youtube") return "YouTube";
  return provider[0].toUpperCase() + provider.slice(1);
}

function credentialProviderFor(platform: ConnectableCreatorPlatform): CredentialProvider {
  if (platform === "instagram" || platform === "facebook") return "meta";
  if (platform === "youtube") return "google";
  return "tiktok";
}

function digestState(state: string): string {
  return createHash("sha256").update(state).digest("hex");
}

function oauthStateCookieName(state: string, secure: boolean): string {
  const prefix = secure ? "__Host-" : "";
  return `${prefix}vayada_creator_oauth_${digestState(state).slice(0, 16)}`;
}

function oauthStateCookieValue(state: string): string {
  return digestState(`vayada-creator-oauth-browser:${state}`);
}

function oauthStateCookie(state: string, secure: boolean): string {
  return [
    `${oauthStateCookieName(state, secure)}=${oauthStateCookieValue(state)}`,
    `Max-Age=${oauthStateCookieMaxAgeSeconds}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    ...(secure ? ["Secure"] : []),
  ].join("; ");
}

function clearOAuthStateCookie(state: string, secure: boolean): string {
  return [
    `${oauthStateCookieName(state, secure)}=`,
    "Max-Age=0",
    "Expires=Thu, 01 Jan 1970 00:00:00 GMT",
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    ...(secure ? ["Secure"] : []),
  ].join("; ");
}

function readCookie(header: string | undefined, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(";")) {
    const separator = part.indexOf("=");
    if (separator < 0 || part.slice(0, separator).trim() !== name) continue;
    try {
      return decodeURIComponent(part.slice(separator + 1).trim());
    } catch {
      return null;
    }
  }
  return null;
}

function oauthStateCookieMatches(state: string, cookieValue: string | null): boolean {
  if (cookieValue === null) return false;
  const expected = Buffer.from(oauthStateCookieValue(state));
  const received = Buffer.from(cookieValue);
  return received.length === expected.length && timingSafeEqual(received, expected);
}

function callbackUrl(baseUrl: string, provider: ConnectableCreatorPlatform): string {
  return `${baseUrl}/api/marketplace/creator-platform-oauth/${provider}/callback`;
}

function credentialReference(prefix: string, authorizationId: string): string {
  return `${prefix.replace(/\/$/, "")}/${authorizationId}`;
}

function redirectResult(
  reply: FastifyReply,
  webReturnUrl: string,
  provider: ConnectableCreatorPlatform,
  status: "success" | "select" | "error",
  details: {
    authorizationId?: string;
    connectionId?: string;
    errorCode?: string;
  } = {},
) {
  const url = new URL(webReturnUrl);
  url.searchParams.set("connection", status);
  url.searchParams.set("platform", provider);
  if (details.authorizationId) {
    url.searchParams.set("authorization_id", details.authorizationId);
  }
  if (details.connectionId) url.searchParams.set("connection_id", details.connectionId);
  if (details.errorCode) url.searchParams.set("error_code", details.errorCode);
  return reply.redirect(url.toString());
}

function safeAccount(account: CreatorPlatformAccount) {
  return {
    externalAccountId: account.providerAccountId,
    displayName: account.displayName,
    handle: account.username ?? null,
    profileUrl: account.profileUrl ?? null,
  };
}

async function importProjection(
  adapter: CreatorPlatformAdapter,
  account: CreatorPlatformAccount,
  grant: CreatorPlatformGrant,
  now: Date,
  signal?: AbortSignal,
): Promise<ImportedProjection> {
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const start = new Date(end);
  start.setUTCDate(start.getUTCDate() - CREATOR_PLATFORM_ENGAGEMENT_WINDOW_DAYS);
  const providerImport = await adapter.importAccount(
    account,
    grant,
    {
      startDate: start.toISOString().slice(0, 10),
      endDate: end.toISOString().slice(0, 10),
    },
    signal,
  );
  const imported: CreatorPlatformImport = {
    ...providerImport,
    demographics: {
      ...providerImport.demographics,
      countries: normalizeAudienceMetric(
        providerImport.demographics.countries,
        normalizeCountry,
        3,
      ),
      ageGroups: normalizeAudienceMetric(
        providerImport.demographics.ageGroups,
        normalizeAgeGroup,
        3,
      ),
    },
  };
  const engagementRate = calculateCreatorPlatformEngagementRate({
    followerCount: metricValue(imported.followers),
    contentItemCount: metricValue(imported.contentCount),
    likes: metricValue(imported.likes),
    comments: metricValue(imported.comments),
    shares: metricValue(imported.shares),
  });
  const fields: Array<[CreatorPlatformImportField, CreatorPlatformMetric<unknown>]> = [
    ["followerCount", imported.followers],
    ["contentItemCount", imported.contentCount],
    ["likes", imported.likes],
    ["comments", imported.comments],
    ["shares", imported.shares],
    ["reach", imported.reach],
    ["views", imported.views],
    ["audienceCountries", imported.demographics.countries],
    ["audienceAgeGroups", imported.demographics.ageGroups],
    ["audienceGenderSplit", imported.demographics.genders],
  ];
  const importedFields = fields
    .filter(([, metric]) => metric.value !== null)
    .map(([field]) => field);
  if (engagementRate !== null) importedFields.push("engagementRate");
  const unavailableFields: CreatorPlatformUnavailableField[] = [];
  for (const [field, metric] of fields) {
    if (metric.value === null) {
      unavailableFields.push({
        field,
        reason: mapUnavailableReason(metric.unavailableReason ?? "not_returned"),
      });
    }
  }
  if (engagementRate === null) {
    unavailableFields.push({ field: "engagementRate", reason: "insufficient_data" });
  }
  const capabilities = [
    ...new Set([
      ...importedFields,
      ...unavailableFields
        .filter(({ reason }) => reason !== "unsupported")
        .map(({ field }) => field),
    ]),
  ];
  return { account, imported, engagementRate, capabilities, importedFields, unavailableFields };
}

function metricValue<T>(metric: CreatorPlatformMetric<T>): T | null {
  return metric.value;
}

function normalizeAudienceMetric(
  metric: CreatorPlatformMetric<Record<string, number>>,
  normalizeKey: (key: string) => string | null,
  limit: number,
): CreatorPlatformMetric<Record<string, number>> {
  if (metric.value === null) return metric;
  const normalized = new Map<string, number>();
  for (const [key, percentage] of Object.entries(metric.value)) {
    const canonicalKey = normalizeKey(key);
    if (!canonicalKey || !Number.isFinite(percentage) || percentage <= 0) continue;
    normalized.set(canonicalKey, (normalized.get(canonicalKey) ?? 0) + percentage);
  }
  const entries = [...normalized.entries()]
    .sort((left, right) => right[1] - left[1])
    .slice(0, limit);
  return entries.length > 0
    ? { value: Object.fromEntries(entries) }
    : { value: null, unavailableReason: "no_data" };
}

function normalizeCountry(value: string): string | null {
  const country = value.trim();
  if (!country) return null;
  if (!/^[A-Za-z]{2}$/.test(country)) return country;
  const code = country.toUpperCase();
  const name = new Intl.DisplayNames(["en"], { type: "region" }).of(code);
  return name && name !== code ? name : null;
}

function normalizeAgeGroup(value: string): string | null {
  const ageGroup = value.trim().replace(/^age/i, "").replaceAll("_", "-");
  if (["18-24", "25-34", "35-44", "45-54"].includes(ageGroup)) return ageGroup;
  if (["55-64", "65-", "65+", "55+"].includes(ageGroup)) return "55+";
  // The creator marketplace currently targets adult audiences only.
  return null;
}

function mapUnavailableReason(reason: AdapterUnavailableReason): DomainUnavailableReason {
  switch (reason) {
    case "not_supported":
      return "unsupported";
    case "privacy_threshold":
      return "privacy_threshold";
    case "missing_permission":
      return "permission_missing";
    case "no_data":
      return "insufficient_data";
    case "not_returned":
      return "provider_omitted";
  }
}

function shouldRefresh(grant: CreatorPlatformGrant, now: Date): boolean {
  if (!grant.expiresAt) return false;
  return new Date(grant.expiresAt).getTime() <= now.getTime() + 5 * 60 * 1000;
}

function grantSubjectId(grant: CreatorPlatformGrant): string | null {
  return grant.provider === "facebook" ? (grant.subjectId ?? null) : null;
}

function isAuthorizationFailure(error: unknown): boolean {
  return error instanceof CreatorPlatformRequestError && error.category === "authorization";
}

function isCreatorPlatformConflict(error: unknown): boolean {
  if (
    error instanceof CreatorPlatformAlreadyConnectedError ||
    error instanceof CreatorPlatformTargetChangedError
  ) {
    return true;
  }
  return (
    typeof error === "object" && error !== null && "code" in error && String(error.code) === "23505"
  );
}

function safeProviderError(error: unknown): { name?: string; message: string } {
  return {
    ...(error instanceof Error ? { name: error.name } : {}),
    message: error instanceof Error ? error.message : "Provider request failed",
  };
}

type PgClient = {
  query<T extends QueryResultRow = QueryResultRow>(
    text: string,
    values?: readonly unknown[],
  ): Promise<Pick<QueryResult<T>, "rows">>;
};

type PgPoolClient = PgClient & { release(): void };
type PgPool = PgClient & { connect(): Promise<PgPoolClient>; end(): Promise<void> };

export function createPgMarketplaceCreatorPlatformConnectionRepository(config: {
  connectionString: string;
  pool?: PgPool;
}): MarketplaceCreatorPlatformConnectionRepository {
  const pool: PgPool =
    config.pool ??
    (new pg.Pool({
      connectionString: config.connectionString,
      max: 8,
      idleTimeoutMillis: 30_000,
    }) as PgPool);

  return {
    async createAuthorization(input) {
      const result = await pool.query<{ authorizationId: string }>(
        `INSERT INTO marketplace.creator_platform_authorizations (
           id, creator_profile_id, organization_id, actor_user_id, platform, provider,
           target_platform_id, status, state_digest, credential_ref, expires_at
         )
         SELECT $1, $2, $3, $4, $5, $6, $7::uuid, 'authorizing', $8, $9, $10
         WHERE $7::uuid IS NULL OR EXISTS (
           SELECT 1
           FROM marketplace.creator_platforms platform
           WHERE platform.id = $7::uuid
             AND platform.creator_profile_id = $2::uuid
             AND platform.organization_id = $3::uuid
             AND platform.platform = $5
             AND NOT EXISTS (
               SELECT 1
               FROM marketplace.creator_platform_connections connection
               WHERE connection.platform_id = platform.id
                 AND connection.status = 'active'
             )
         )
         RETURNING id::text AS "authorizationId"`,
        [
          input.authorizationId,
          input.access.creatorProfileId,
          input.access.organizationId,
          input.access.actorUserId,
          input.platform,
          credentialProviderFor(input.platform),
          input.targetPlatformId,
          input.stateDigest,
          input.credentialRef,
          input.expiresAt,
        ],
      );
      return Boolean(result.rows[0]);
    },

    async consumeAuthorization(input) {
      const result = await pool.query<AuthorizationRow>(
        `UPDATE marketplace.creator_platform_authorizations
         SET status = 'processing',
             consumed_at = GREATEST(created_at, $3::timestamptz),
             expires_at = GREATEST(
               expires_at,
               $3::timestamptz + ($4::bigint * interval '1 millisecond')
             ),
             updated_at = now()
         WHERE platform = $1
           AND state_digest = $2
           AND status = 'authorizing'
           AND consumed_at IS NULL
           AND expires_at > GREATEST(created_at, $3::timestamptz)
         RETURNING ${authorizationColumns}`,
        [input.platform, input.stateDigest, input.now, authorizationProcessingLeaseMs],
      );
      return result.rows[0] ? mapAuthorization(result.rows[0]) : null;
    },

    async setAuthorizationCandidates(input) {
      const result = await pool.query<{ authorizationId: string }>(
        `UPDATE marketplace.creator_platform_authorizations
         SET status = 'pending_account_selection', credential_ref = $2,
             candidates = $3::jsonb, granted_scopes = $4::text[], updated_at = now()
         WHERE id = $1
           AND status = 'processing'
           AND expires_at > now()
         RETURNING id::text AS "authorizationId"`,
        [
          input.authorizationId,
          input.credentialRef,
          JSON.stringify(input.candidates),
          input.grantedScopes,
        ],
      );
      return Boolean(result.rows[0]);
    },

    async failAuthorization(input) {
      const result = await pool.query<{ authorizationId: string }>(
        `UPDATE marketplace.creator_platform_authorizations
         SET status = 'failed', error_code = $2, updated_at = now()
         WHERE id = $1
           AND status = 'processing'
         RETURNING id::text AS "authorizationId"`,
        [input.authorizationId, input.errorCode],
      );
      return Boolean(result.rows[0]);
    },

    async getPendingAuthorization(access) {
      const result = await pool.query<AuthorizationRow>(
        `SELECT ${authorizationColumns}
         FROM marketplace.creator_platform_authorizations
         WHERE creator_profile_id = $1
           AND organization_id = $2
           AND actor_user_id = $3
           AND status = 'pending_account_selection'
           AND expires_at > now()
         ORDER BY created_at DESC
         LIMIT 1`,
        [access.creatorProfileId, access.organizationId, access.actorUserId],
      );
      return result.rows[0] ? mapAuthorization(result.rows[0]) : null;
    },

    async getAuthorization(input) {
      const result = await pool.query<AuthorizationRow>(
        `SELECT ${authorizationColumns}
         FROM marketplace.creator_platform_authorizations
         WHERE id = $1
           AND creator_profile_id = $2
           AND organization_id = $3
           AND actor_user_id = $4
           AND expires_at > now()`,
        [
          input.authorizationId,
          input.access.creatorProfileId,
          input.access.organizationId,
          input.access.actorUserId,
        ],
      );
      return result.rows[0] ? mapAuthorization(result.rows[0]) : null;
    },

    async claimAuthorizationAccount(input) {
      const result = await pool.query<AuthorizationRow>(
        `UPDATE marketplace.creator_platform_authorizations AS authz
         SET candidates = (
               SELECT jsonb_agg(candidate.value)
               FROM jsonb_array_elements(authz.candidates) AS candidate(value)
               WHERE candidate.value ->> 'providerAccountId' = $5
             ),
             status = 'processing',
             expires_at = GREATEST(
               authz.expires_at,
               now() + ($6::bigint * interval '1 millisecond')
             ),
             updated_at = now()
         WHERE authz.id = $1
           AND authz.creator_profile_id = $2
           AND authz.organization_id = $3
           AND authz.actor_user_id = $4
           AND authz.status = 'pending_account_selection'
           AND authz.expires_at > now()
           AND EXISTS (
             SELECT 1
             FROM jsonb_array_elements(authz.candidates) AS candidate(value)
             WHERE candidate.value ->> 'providerAccountId' = $5
           )
         RETURNING ${authorizationColumns}`,
        [
          input.authorizationId,
          input.access.creatorProfileId,
          input.access.organizationId,
          input.access.actorUserId,
          input.externalAccountId,
          authorizationProcessingLeaseMs,
        ],
      );
      return result.rows[0] ? mapAuthorization(result.rows[0]) : null;
    },

    async releaseAuthorizationAccountClaim(input) {
      await pool.query(
        `UPDATE marketplace.creator_platform_authorizations
         SET status = CASE WHEN expires_at > now() THEN 'pending_account_selection' ELSE 'expired' END,
             updated_at = now()
         WHERE id = $1 AND status = 'processing'`,
        [input.authorizationId],
      );
    },

    async isAuthorizationActorAuthorized(authorization) {
      return isCreatorProfileActorAuthorized(pool, authorization);
    },

    async completeConnection(input) {
      return inTransaction(pool, async (client) =>
        persistImportedConnection(client, {
          authorization: input.authorization,
          credentialRef: input.credentialRef,
          grant: input.grant,
          projection: input.projection,
        }),
      );
    },

    async listConnections(access) {
      const result = await pool.query<ConnectionRow>(
        `SELECT ${connectionColumns}
         FROM marketplace.creator_platform_connections connection
         JOIN marketplace.creator_platforms platform ON platform.id = connection.platform_id
         WHERE connection.creator_profile_id = $1
           AND connection.organization_id = $2
           AND connection.status <> 'revoked'
         ORDER BY connection.created_at`,
        [access.creatorProfileId, access.organizationId],
      );
      return result.rows.map(mapConnectionDocument);
    },

    async getConnection(input) {
      const result = await pool.query<ConnectionRow>(
        `SELECT ${connectionColumns}
         FROM marketplace.creator_platform_connections connection
         JOIN marketplace.creator_platforms platform ON platform.id = connection.platform_id
         WHERE connection.id = $1
           AND connection.creator_profile_id = $2
           AND connection.organization_id = $3
           AND connection.status <> 'revoked'`,
        [input.connectionId, input.access.creatorProfileId, input.access.organizationId],
      );
      return result.rows[0] ? mapConnection(result.rows[0]) : null;
    },

    async claimConnectionSync(input) {
      return inTransaction(pool, async (client) => {
        await assertCreatorProfileActorAuthorized(client, input.access);
        await lockCreatorProfile(client, input.access);
        const claimed = await client.query<{ connectionId: string }>(
          `UPDATE marketplace.creator_platform_connections
           SET sync_lease_id = $4, sync_lease_expires_at = $5::timestamptz,
               last_sync_attempt_at = now(), updated_at = now()
           WHERE id = $1
             AND creator_profile_id = $2
             AND organization_id = $3
             AND status <> 'revoked'
             AND credential_ref IS NOT NULL
             AND (sync_lease_id IS NULL OR sync_lease_expires_at <= now())
           RETURNING id::text AS "connectionId"`,
          [
            input.connectionId,
            input.access.creatorProfileId,
            input.access.organizationId,
            input.leaseId,
            input.leaseExpiresAt,
          ],
        );
        if (!claimed.rows[0]) return null;
        const result = await client.query<ConnectionRow>(
          `SELECT ${connectionColumns}
           FROM marketplace.creator_platform_connections connection
           JOIN marketplace.creator_platforms platform ON platform.id = connection.platform_id
           WHERE connection.id = $1`,
          [input.connectionId],
        );
        return result.rows[0] ? mapConnection(result.rows[0]) : null;
      });
    },

    async claimScheduledConnectionSync(input) {
      return inTransaction(pool, async (client) => {
        const candidate = await client.query<CreatorProfileAccess>(
          `SELECT membership.user_id::text AS "actorUserId",
                  connection.organization_id::text AS "organizationId",
                  connection.creator_profile_id::text AS "creatorProfileId"
           FROM marketplace.creator_platform_connections connection
           JOIN identity.organizations organization
             ON organization.id = connection.organization_id
            AND organization.kind = 'creator_workspace'
            AND organization.status = 'active'
           JOIN identity.organization_resource_links link
             ON link.organization_id = organization.id
            AND link.product = 'marketplace'
            AND link.resource_type = 'creator_profile'
            AND link.resource_id = connection.creator_profile_id::text
            AND link.relationship = 'owner'
            AND link.status = 'active'
           JOIN identity.organization_memberships membership
             ON membership.organization_id = organization.id
            AND membership.status = 'active'
           JOIN identity.users actor
             ON actor.id = membership.user_id
            AND actor.status = 'active'
           JOIN identity.role_permission_grants permission
             ON permission.organization_kind = organization.kind
            AND permission.role_key = membership.role_key
            AND permission.permission_key = 'marketplace.profile.manage'
           WHERE connection.id = $1::uuid
             AND connection.status = 'active'
             AND connection.credential_ref IS NOT NULL
           ORDER BY membership.created_at, membership.id
           LIMIT 1`,
          [input.connectionId],
        );
        const access = candidate.rows[0];
        if (!access || !(await isCreatorProfileActorAuthorized(client, access, true))) {
          return { outcome: "ineligible" };
        }
        await lockCreatorProfile(client, access);
        const claimed = await client.query<{ connectionId: string }>(
          `UPDATE marketplace.creator_platform_connections
           SET sync_lease_id = $2, sync_lease_expires_at = $3::timestamptz,
               last_sync_attempt_at = now(), updated_at = now()
           WHERE id = $1::uuid
             AND creator_profile_id = $4::uuid
             AND organization_id = $5::uuid
             AND status = 'active'
             AND credential_ref IS NOT NULL
             AND (sync_lease_id IS NULL OR sync_lease_expires_at <= now())
           RETURNING id::text AS "connectionId"`,
          [
            input.connectionId,
            input.leaseId,
            input.leaseExpiresAt,
            access.creatorProfileId,
            access.organizationId,
          ],
        );
        if (!claimed.rows[0]) {
          const eligible = await client.query<{ eligible: boolean }>(
            `SELECT status = 'active' AND credential_ref IS NOT NULL AS eligible
             FROM marketplace.creator_platform_connections
             WHERE id = $1::uuid`,
            [input.connectionId],
          );
          return { outcome: eligible.rows[0]?.eligible ? "busy" : "ineligible" };
        }
        const connection = await client.query<ConnectionRow>(
          `SELECT ${connectionColumns}
           FROM marketplace.creator_platform_connections connection
           JOIN marketplace.creator_platforms platform ON platform.id = connection.platform_id
           WHERE connection.id = $1::uuid`,
          [input.connectionId],
        );
        return connection.rows[0]
          ? { outcome: "claimed", access, connection: mapConnection(connection.rows[0]) }
          : { outcome: "ineligible" };
      });
    },

    async releaseConnectionSync(input) {
      await pool.query(
        `UPDATE marketplace.creator_platform_connections
         SET sync_lease_id = NULL, sync_lease_expires_at = NULL, updated_at = now()
         WHERE id = $1
           AND authorization_id = $2
           AND sync_lease_id = $3`,
        [input.connectionId, input.authorizationId, input.syncLeaseId],
      );
    },

    async updateConnectionFromImport(input) {
      return inTransaction(pool, async (client) =>
        updateImportedConnection(
          client,
          input.access,
          input.connection,
          input.grant,
          input.nextCredentialRef,
          input.projection,
        ),
      );
    },

    async markConnectionError(input) {
      await pool.query(
        `UPDATE marketplace.creator_platform_connections
         SET status = $2, last_sync_attempt_at = now(), last_error_code = $3,
             sync_lease_id = NULL, sync_lease_expires_at = NULL, updated_at = now()
         WHERE id = $1
           AND authorization_id = $4
           AND credential_ref = $5
           AND sync_lease_id = $6
           AND status <> 'revoked'`,
        [
          input.connectionId,
          input.status,
          input.errorCode,
          input.authorizationId,
          input.credentialRef,
          input.syncLeaseId,
        ],
      );
    },

    async revokeConnection(input) {
      return inTransaction(pool, async (client) => {
        await assertCreatorProfileActorAuthorized(client, input.access);
        await lockCreatorProfile(client, {
          creatorProfileId: input.access.creatorProfileId,
          organizationId: input.access.organizationId,
        });
        const result = await client.query<{ connectionId: string }>(
          `UPDATE marketplace.creator_platform_connections
           SET status = 'revoked', credential_ref = NULL,
               sync_lease_id = NULL, sync_lease_expires_at = NULL,
               last_error_code = NULL, updated_at = now()
           WHERE id = $1
             AND creator_profile_id = $2
             AND organization_id = $3
             AND authorization_id = $4
             AND credential_ref IS NOT DISTINCT FROM $5
             AND status <> 'revoked'
           RETURNING id::text AS "connectionId"`,
          [
            input.connectionId,
            input.access.creatorProfileId,
            input.access.organizationId,
            input.authorizationId,
            input.credentialRef,
          ],
        );
        const revokedConnection = result.rows[0];
        if (!revokedConnection) return { revoked: false };
        await client.query(
          `UPDATE marketplace.creator_platforms
           SET verification_status = 'unverified', updated_at = now()
           WHERE id = (
             SELECT platform_id FROM marketplace.creator_platform_connections WHERE id = $1
           )`,
          [input.connectionId],
        );
        return { revoked: true };
      });
    },

    async recordRevocationError(input) {
      await pool.query(
        `UPDATE marketplace.creator_platform_connections
         SET last_error_code = $2, updated_at = now()
         WHERE id = $1 AND status = 'revoked'`,
        [input.connectionId, input.errorCode],
      );
    },

    async queueCredentialCleanup(input) {
      await pool.query(
        `INSERT INTO marketplace.creator_platform_credential_cleanup_jobs (
           credential_ref, authorization_id, available_at
         ) VALUES ($1, $2, COALESCE($3::timestamptz, now()))
         ON CONFLICT (credential_ref) DO UPDATE
         SET available_at = LEAST(
               creator_platform_credential_cleanup_jobs.available_at,
               EXCLUDED.available_at
             ),
             updated_at = now()`,
        [input.credentialRef, input.authorizationId, input.availableAt ?? null],
      );
    },

    async listCredentialCleanupCandidates(input) {
      return inTransaction(pool, async (client) => {
        await client.query(
          `UPDATE marketplace.creator_platform_authorizations
           SET status = 'expired', updated_at = now()
           WHERE status IN ('authorizing', 'processing', 'pending_account_selection')
             AND expires_at <= $1::timestamptz`,
          [input.now],
        );
        await client.query(
          `INSERT INTO marketplace.creator_platform_credential_cleanup_jobs (
             credential_ref, authorization_id, available_at
           )
           SELECT authz.credential_ref, authz.id, $1::timestamptz
           FROM marketplace.creator_platform_authorizations authz
           WHERE authz.credential_cleaned_at IS NULL
             AND authz.credential_ref IS NOT NULL
             AND (
               authz.status IN ('failed', 'expired')
               OR (
                 authz.status = 'active'
                 AND NOT EXISTS (
                   SELECT 1
                   FROM marketplace.creator_platform_connections connection
                   WHERE connection.authorization_id = authz.id
                     AND connection.credential_ref = authz.credential_ref
                     AND connection.status <> 'revoked'
                 )
               )
             )
           ON CONFLICT (credential_ref) DO NOTHING`,
          [input.now],
        );
        const result = await client.query<CredentialCleanupCandidate>(
          `WITH candidates AS (
             SELECT job.credential_ref
             FROM marketplace.creator_platform_credential_cleanup_jobs job
             WHERE job.available_at <= $1::timestamptz
               AND (
                 job.cleanup_claim_id IS NULL
                 OR job.cleanup_claim_expires_at <= $1::timestamptz
               )
               AND NOT EXISTS (
                 SELECT 1
                 FROM marketplace.creator_platform_connections connection
                 WHERE connection.credential_ref = job.credential_ref
                   AND connection.status <> 'revoked'
               )
             ORDER BY job.credential_ref
             FOR UPDATE SKIP LOCKED
             LIMIT $2
           )
           UPDATE marketplace.creator_platform_credential_cleanup_jobs job
           SET cleanup_claim_id = gen_random_uuid(),
               cleanup_claim_expires_at = $1::timestamptz + interval '10 minutes',
               updated_at = now()
           FROM candidates
           WHERE job.credential_ref = candidates.credential_ref
           RETURNING job.credential_ref AS "credentialRef",
                     job.authorization_id::text AS "authorizationId",
                     job.cleanup_claim_id::text AS "claimId"`,
          [input.now, input.limit],
        );
        return result.rows;
      });
    },

    async markCredentialCleaned(input) {
      await inTransaction(pool, async (client) => {
        await client.query(
          `UPDATE marketplace.creator_platform_authorizations AS authz
           SET credential_ref = NULL, credential_cleaned_at = $2::timestamptz,
               updated_at = now()
           WHERE authz.credential_ref = $1
             AND NOT EXISTS (
               SELECT 1
               FROM marketplace.creator_platform_connections connection
               WHERE connection.authorization_id = authz.id
                 AND connection.credential_ref = authz.credential_ref
                 AND connection.status <> 'revoked'
             )`,
          [input.credentialRef, input.cleanedAt],
        );
        await client.query(
          `DELETE FROM marketplace.creator_platform_credential_cleanup_jobs
           WHERE credential_ref = $1
             AND ($2::uuid IS NULL OR cleanup_claim_id = $2::uuid)`,
          [input.credentialRef, input.claimId ?? null],
        );
      });
    },

    async recordCredentialCleanupFailure(input) {
      await pool.query(
        `INSERT INTO marketplace.creator_platform_credential_cleanup_jobs (
           credential_ref, authorization_id, attempts, last_error_code, available_at
         ) VALUES ($1, $2, 1, $3, now() + interval '1 minute')
         ON CONFLICT (credential_ref) DO UPDATE
         SET attempts = creator_platform_credential_cleanup_jobs.attempts + 1,
             last_error_code = EXCLUDED.last_error_code,
             available_at = EXCLUDED.available_at,
             cleanup_claim_id = NULL,
             cleanup_claim_expires_at = NULL,
             updated_at = now()
         WHERE $4::uuid IS NULL
            OR creator_platform_credential_cleanup_jobs.cleanup_claim_id = $4::uuid`,
        [input.credentialRef, input.authorizationId, input.errorCode, input.claimId ?? null],
      );
    },

    async close() {
      await pool.end();
    },
  };
}

type AuthorizationRow = {
  authorizationId: string;
  creatorProfileId: string;
  organizationId: string;
  actorUserId: string;
  platform: ConnectableCreatorPlatform;
  provider: CredentialProvider;
  targetPlatformId: string | null;
  status: AuthorizationStatus;
  credentialRef: string | null;
  candidates: unknown;
  expiresAt: Date | string;
};

const authorizationColumns = `
  id::text AS "authorizationId",
  creator_profile_id::text AS "creatorProfileId",
  organization_id::text AS "organizationId",
  actor_user_id::text AS "actorUserId",
  platform,
  provider,
  target_platform_id::text AS "targetPlatformId",
  status,
  credential_ref AS "credentialRef",
  candidates,
  expires_at AS "expiresAt"`;

function mapAuthorization(row: AuthorizationRow): AuthorizationRecord {
  return {
    ...row,
    candidates: Array.isArray(row.candidates) ? (row.candidates as CreatorPlatformAccount[]) : [],
    expiresAt: toIso(row.expiresAt),
  };
}

type ConnectionRow = {
  connectionId: string;
  authorizationId: string;
  platformId: string;
  creatorProfileId: string;
  organizationId: string;
  platform: ConnectableCreatorPlatform;
  provider: CredentialProvider;
  externalAccountId: string;
  status: CreatorPlatformConnectionStatus;
  capabilities: unknown;
  importedFields: unknown;
  unavailableFields: unknown;
  credentialRef: string | null;
  syncLeaseId: string | null;
  lastSyncAttemptAt: Date | string | null;
  lastSuccessfulSyncAt: Date | string | null;
  lastErrorCode: string | null;
};

const connectionColumns = `
  connection.id::text AS "connectionId",
  connection.authorization_id::text AS "authorizationId",
  connection.platform_id::text AS "platformId",
  connection.creator_profile_id::text AS "creatorProfileId",
  connection.organization_id::text AS "organizationId",
  connection.platform,
  connection.provider,
  connection.external_account_id AS "externalAccountId",
  connection.status,
  connection.capabilities,
  connection.imported_fields AS "importedFields",
  connection.unavailable_fields AS "unavailableFields",
  connection.credential_ref AS "credentialRef",
  connection.sync_lease_id::text AS "syncLeaseId",
  connection.last_sync_attempt_at AS "lastSyncAttemptAt",
  connection.last_successful_sync_at AS "lastSuccessfulSyncAt",
  connection.last_error_code AS "lastErrorCode"`;

function mapConnectionDocument(row: ConnectionRow): CreatorPlatformConnectionDocument {
  return {
    connectionId: row.connectionId,
    platformId: row.platformId,
    platform: row.platform,
    provider: row.provider,
    externalAccountId: row.externalAccountId,
    status: row.status,
    capabilities: importFieldArray(row.capabilities),
    importedFields: importFieldArray(row.importedFields),
    unavailableFields: unavailableFieldArray(row.unavailableFields),
    lastSyncAttemptAt: row.lastSyncAttemptAt ? toIso(row.lastSyncAttemptAt) : null,
    lastSuccessfulSyncAt: row.lastSuccessfulSyncAt ? toIso(row.lastSuccessfulSyncAt) : null,
    lastErrorCode: row.lastErrorCode,
  };
}

function mapConnection(row: ConnectionRow): CreatorPlatformConnectionRecord {
  return {
    ...mapConnectionDocument(row),
    creatorProfileId: row.creatorProfileId,
    organizationId: row.organizationId,
    authorizationId: row.authorizationId,
    externalAccountId: row.externalAccountId,
    credentialRef: row.credentialRef,
    syncLeaseId: row.syncLeaseId,
  };
}

async function isCreatorProfileActorAuthorized(
  client: PgClient,
  access: Pick<CreatorProfileAccess, "actorUserId" | "organizationId" | "creatorProfileId">,
  lockRows = false,
): Promise<boolean> {
  const result = await client.query<{ authorized: number }>(
    `SELECT 1 AS authorized
     FROM identity.users actor
     JOIN identity.organization_memberships membership
       ON membership.user_id = actor.id
      AND membership.organization_id = $2::uuid
      AND membership.status = 'active'
     JOIN identity.organizations organization
       ON organization.id = membership.organization_id
      AND organization.kind = 'creator_workspace'
      AND organization.status = 'active'
     JOIN identity.role_permission_grants permission
       ON permission.organization_kind = organization.kind
      AND permission.role_key = membership.role_key
      AND permission.permission_key = 'marketplace.profile.manage'
     JOIN identity.organization_resource_links link
       ON link.organization_id = organization.id
      AND link.product = 'marketplace'
      AND link.resource_type = 'creator_profile'
      AND link.resource_id = $3
      AND link.relationship = 'owner'
      AND link.status = 'active'
     WHERE actor.id = $1::uuid
       AND actor.status = 'active'
     LIMIT 1
     ${lockRows ? "FOR SHARE OF actor, membership, organization, permission, link" : ""}`,
    [access.actorUserId, access.organizationId, access.creatorProfileId],
  );
  return Boolean(result.rows[0]?.authorized);
}

async function assertCreatorProfileActorAuthorized(
  client: PgClient,
  access: Pick<CreatorProfileAccess, "actorUserId" | "organizationId" | "creatorProfileId">,
): Promise<void> {
  if (!(await isCreatorProfileActorAuthorized(client, access, true))) {
    throw new CreatorPlatformAuthorizationAccessRevokedError();
  }
}

async function lockCreatorProfile(
  client: PgClient,
  input: { creatorProfileId: string; organizationId: string },
): Promise<void> {
  const result = await client.query<{ id: string }>(
    `SELECT id::text AS id
     FROM marketplace.creator_profiles
     WHERE id = $1 AND organization_id = $2
     FOR UPDATE`,
    [input.creatorProfileId, input.organizationId],
  );
  if (!result.rows[0]) throw new CreatorPlatformTargetChangedError();
}

async function persistImportedConnection(
  client: PgClient,
  input: {
    authorization: AuthorizationRecord;
    credentialRef: string;
    grant: CreatorPlatformGrant;
    projection: ImportedProjection;
  },
): Promise<CreatorPlatformConnectionDocument> {
  const { authorization, projection } = input;
  const persistedAuthorization = await client.query<{
    status: AuthorizationStatus;
    credentialRef: string | null;
  }>(
    `SELECT status, credential_ref AS "credentialRef"
     FROM marketplace.creator_platform_authorizations
     WHERE id = $1
       AND creator_profile_id = $2
       AND organization_id = $3
       AND actor_user_id = $4
       AND platform = $5
       AND provider = $6
       AND expires_at > now()
     FOR UPDATE`,
    [
      authorization.authorizationId,
      authorization.creatorProfileId,
      authorization.organizationId,
      authorization.actorUserId,
      authorization.platform,
      authorization.provider,
    ],
  );
  const currentAuthorization = persistedAuthorization.rows[0];
  if (
    !currentAuthorization ||
    currentAuthorization.status !== authorization.status ||
    currentAuthorization.status !== "processing" ||
    currentAuthorization.credentialRef !== authorization.credentialRef
  ) {
    throw new CreatorPlatformAuthorizationConsumedError();
  }
  await assertCreatorProfileActorAuthorized(client, authorization);
  await lockCreatorProfile(client, authorization);
  if (!(await claimStagedCredential(client, authorization.authorizationId, input.credentialRef))) {
    throw new CreatorPlatformAuthorizationConsumedError();
  }

  const existing = await client.query<{
    connectionId: string;
    platformId: string;
    creatorProfileId: string;
    organizationId: string;
    status: CreatorPlatformConnectionStatus;
  }>(
    `SELECT id::text AS "connectionId", platform_id::text AS "platformId",
            creator_profile_id::text AS "creatorProfileId",
            organization_id::text AS "organizationId", status
     FROM marketplace.creator_platform_connections
     WHERE platform = $1 AND external_account_id = $2
     FOR UPDATE`,
    [authorization.platform, projection.account.providerAccountId],
  );
  const claimed = existing.rows[0];
  if (
    claimed &&
    (claimed.creatorProfileId !== authorization.creatorProfileId ||
      claimed.organizationId !== authorization.organizationId)
  ) {
    throw new CreatorPlatformAlreadyConnectedError();
  }

  let targetConnection:
    | {
        connectionId: string;
        externalAccountId: string;
        status: CreatorPlatformConnectionStatus;
      }
    | undefined;
  if (authorization.targetPlatformId) {
    const target = await client.query<{ platformId: string }>(
      `SELECT id::text AS "platformId"
       FROM marketplace.creator_platforms
       WHERE id = $1
         AND creator_profile_id = $2
         AND organization_id = $3
         AND platform = $4
       FOR UPDATE`,
      [
        authorization.targetPlatformId,
        authorization.creatorProfileId,
        authorization.organizationId,
        authorization.platform,
      ],
    );
    if (!target.rows[0]) throw new CreatorPlatformTargetChangedError();
    const targetConnectionResult = await client.query<{
      connectionId: string;
      externalAccountId: string;
      status: CreatorPlatformConnectionStatus;
    }>(
      `SELECT id::text AS "connectionId", external_account_id AS "externalAccountId", status
       FROM marketplace.creator_platform_connections
       WHERE platform_id = $1
       FOR UPDATE`,
      [authorization.targetPlatformId],
    );
    targetConnection = targetConnectionResult.rows[0];
    if (
      (claimed && claimed.platformId !== authorization.targetPlatformId) ||
      targetConnection?.status === "active" ||
      (targetConnection &&
        targetConnection.externalAccountId !== projection.account.providerAccountId)
    ) {
      throw new CreatorPlatformAlreadyConnectedError();
    }
  }

  const platformId = authorization.targetPlatformId ?? claimed?.platformId ?? randomUUID();
  const connectionId = targetConnection?.connectionId ?? claimed?.connectionId ?? randomUUID();
  const platformExists = Boolean(authorization.targetPlatformId || claimed);
  if (!platformExists) {
    await client.query(
      `INSERT INTO marketplace.creator_platforms (
         id, creator_profile_id, organization_id, source_system, platform, handle,
         profile_url, follower_count, engagement_rate, audience_countries,
         audience_age_groups, audience_gender_split, verification_status, platform_metadata
       ) VALUES ($1, $2, $3, 'marketplace', $4, $5, $6, $7, $8, $9::jsonb, $10::jsonb,
                 $11::jsonb, 'verified', $12::jsonb)`,
      platformProjectionValues(platformId, authorization, projection),
    );
  } else {
    await updateCreatorPlatformProjection(client, platformId, projection);
  }

  await client.query(
    `INSERT INTO marketplace.creator_platform_connections (
       id, authorization_id, platform_id, creator_profile_id, organization_id,
       platform, provider, external_account_id, external_account_type, status,
       capabilities, imported_fields, unavailable_fields, credential_ref,
       access_token_expires_at, refresh_token_expires_at,
       last_sync_attempt_at, last_successful_sync_at, provider_grant_subject_id
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'active', $10::text[], $11::text[],
               $12::jsonb, $13, $14, $15, now(), now(), $16)
     ON CONFLICT (id) DO UPDATE SET
       authorization_id = EXCLUDED.authorization_id,
       external_account_id = EXCLUDED.external_account_id,
       external_account_type = EXCLUDED.external_account_type,
       status = 'active', capabilities = EXCLUDED.capabilities,
       imported_fields = EXCLUDED.imported_fields,
       unavailable_fields = EXCLUDED.unavailable_fields,
       credential_ref = EXCLUDED.credential_ref,
       access_token_expires_at = EXCLUDED.access_token_expires_at,
       refresh_token_expires_at = EXCLUDED.refresh_token_expires_at,
       provider_grant_subject_id = EXCLUDED.provider_grant_subject_id,
       sync_lease_id = NULL, sync_lease_expires_at = NULL,
       last_sync_attempt_at = now(), last_successful_sync_at = now(),
       last_error_code = NULL, updated_at = now()`,
    [
      connectionId,
      authorization.authorizationId,
      platformId,
      authorization.creatorProfileId,
      authorization.organizationId,
      authorization.platform,
      authorization.provider,
      projection.account.providerAccountId,
      projection.account.accountType,
      projection.capabilities,
      projection.importedFields,
      JSON.stringify(projection.unavailableFields),
      input.credentialRef,
      input.grant.expiresAt ?? null,
      "refreshExpiresAt" in input.grant ? input.grant.refreshExpiresAt : null,
      grantSubjectId(input.grant),
    ],
  );
  await client.query(
    `UPDATE marketplace.creator_platform_authorizations
     SET status = 'active', credential_ref = $2, granted_scopes = $3::text[],
         credential_cleaned_at = NULL, updated_at = now()
     WHERE id = $1`,
    [authorization.authorizationId, input.credentialRef, input.grant.scopes],
  );
  if (authorization.credentialRef && authorization.credentialRef !== input.credentialRef) {
    await client.query(
      `INSERT INTO marketplace.creator_platform_credential_cleanup_jobs (
         credential_ref, authorization_id
       ) VALUES ($1, $2)
       ON CONFLICT (credential_ref) DO NOTHING`,
      [authorization.credentialRef, authorization.authorizationId],
    );
  }
  await insertMetricSnapshot(client, {
    connectionId,
    platformId,
    creatorProfileId: authorization.creatorProfileId,
    organizationId: authorization.organizationId,
    projection,
  });
  await recalculateCreatorProfileCompletion(client, authorization);
  return readConnectionDocument(client, connectionId);
}

function platformProjectionValues(
  platformId: string,
  authorization: AuthorizationRecord,
  projection: ImportedProjection,
): unknown[] {
  return [
    platformId,
    authorization.creatorProfileId,
    authorization.organizationId,
    authorization.platform,
    projection.account.username ?? projection.account.displayName,
    projection.account.profileUrl ?? null,
    metricValue(projection.imported.followers) ?? 0,
    projection.engagementRate ?? 0,
    JSON.stringify(audienceEntries(projection.imported.demographics.countries, "country")),
    JSON.stringify(audienceEntries(projection.imported.demographics.ageGroups, "ageRange")),
    JSON.stringify(genderSplit(projection.imported.demographics.genders)),
    JSON.stringify({
      source: "provider",
      provider: authorization.provider,
      profileUrlImported: Boolean(projection.account.profileUrl),
      engagementWindowDays: CREATOR_PLATFORM_ENGAGEMENT_WINDOW_DAYS,
      engagementFormulaVersion: CREATOR_PLATFORM_ENGAGEMENT_FORMULA_VERSION,
    }),
  ];
}

async function updateImportedConnection(
  client: PgClient,
  access: CreatorProfileAccess,
  connection: CreatorPlatformConnectionRecord,
  grant: CreatorPlatformGrant,
  nextCredentialRef: string,
  projection: ImportedProjection,
): Promise<CreatorPlatformConnectionDocument> {
  if (
    access.creatorProfileId !== connection.creatorProfileId ||
    access.organizationId !== connection.organizationId
  ) {
    throw new CreatorPlatformConnectionChangedError();
  }
  if (!connection.credentialRef || !connection.syncLeaseId) {
    throw new CreatorPlatformConnectionChangedError();
  }
  await assertCreatorProfileActorAuthorized(client, access);
  await lockCreatorProfile(client, connection);
  const persistedConnection = await client.query<{
    authorizationId: string;
    credentialRef: string | null;
    syncLeaseId: string | null;
    syncLeaseCurrent: boolean;
    status: CreatorPlatformConnectionStatus;
  }>(
    `SELECT authorization_id::text AS "authorizationId",
            credential_ref AS "credentialRef", sync_lease_id::text AS "syncLeaseId",
            sync_lease_expires_at > now() AS "syncLeaseCurrent", status
     FROM marketplace.creator_platform_connections
     WHERE id = $1
       AND creator_profile_id = $2
       AND organization_id = $3
     FOR UPDATE`,
    [connection.connectionId, connection.creatorProfileId, connection.organizationId],
  );
  const currentConnection = persistedConnection.rows[0];
  if (
    !currentConnection ||
    currentConnection.status === "revoked" ||
    currentConnection.authorizationId !== connection.authorizationId ||
    currentConnection.credentialRef !== connection.credentialRef ||
    currentConnection.syncLeaseId !== connection.syncLeaseId ||
    !currentConnection.syncLeaseCurrent
  ) {
    throw new CreatorPlatformConnectionChangedError();
  }
  if (!(await claimStagedCredential(client, connection.authorizationId, nextCredentialRef))) {
    throw new CreatorPlatformConnectionChangedError();
  }
  await updateCreatorPlatformProjection(client, connection.platformId, projection);
  const updated = await client.query<{ connectionId: string }>(
    `UPDATE marketplace.creator_platform_connections
     SET status = 'active', capabilities = $2::text[], imported_fields = $3::text[],
         unavailable_fields = $4::jsonb, access_token_expires_at = $5,
         refresh_token_expires_at = $6, provider_grant_subject_id = $7,
         credential_ref = $8, sync_lease_id = NULL, sync_lease_expires_at = NULL,
         last_sync_attempt_at = now(),
         last_successful_sync_at = now(), last_error_code = NULL, updated_at = now()
     WHERE id = $1
       AND authorization_id = $9
       AND credential_ref = $10
       AND sync_lease_id = $11
       AND status <> 'revoked'
     RETURNING id::text AS "connectionId"`,
    [
      connection.connectionId,
      projection.capabilities,
      projection.importedFields,
      JSON.stringify(projection.unavailableFields),
      grant.expiresAt ?? null,
      "refreshExpiresAt" in grant ? grant.refreshExpiresAt : null,
      grantSubjectId(grant),
      nextCredentialRef,
      connection.authorizationId,
      connection.credentialRef,
      connection.syncLeaseId,
    ],
  );
  if (!updated.rows[0]) throw new CreatorPlatformConnectionChangedError();
  const authorizationUpdated = await client.query<{ authorizationId: string }>(
    `UPDATE marketplace.creator_platform_authorizations
     SET credential_ref = $2, granted_scopes = $3::text[], credential_cleaned_at = NULL,
         updated_at = now()
     WHERE id = $1 AND credential_ref = $4
     RETURNING id::text AS "authorizationId"`,
    [connection.authorizationId, nextCredentialRef, grant.scopes, connection.credentialRef],
  );
  if (!authorizationUpdated.rows[0]) throw new CreatorPlatformConnectionChangedError();
  await client.query(
    `INSERT INTO marketplace.creator_platform_credential_cleanup_jobs (
       credential_ref, authorization_id
     ) VALUES ($1, $2)
     ON CONFLICT (credential_ref) DO NOTHING`,
    [connection.credentialRef, connection.authorizationId],
  );
  await insertMetricSnapshot(client, {
    connectionId: connection.connectionId,
    platformId: connection.platformId,
    creatorProfileId: connection.creatorProfileId,
    organizationId: connection.organizationId,
    projection,
  });
  return readConnectionDocument(client, connection.connectionId);
}

async function updateCreatorPlatformProjection(
  client: PgClient,
  platformId: string,
  projection: ImportedProjection,
): Promise<void> {
  const imported = projection.importedFields;
  await client.query(
    `UPDATE marketplace.creator_platforms
     SET handle = $2,
         profile_url = COALESCE($3, profile_url),
         follower_count = CASE WHEN 'followerCount' = ANY($4::text[]) THEN $5 ELSE follower_count END,
         engagement_rate = CASE WHEN 'engagementRate' = ANY($4::text[]) THEN $6 ELSE engagement_rate END,
         audience_countries = CASE WHEN 'audienceCountries' = ANY($4::text[]) THEN $7::jsonb ELSE audience_countries END,
         audience_age_groups = CASE WHEN 'audienceAgeGroups' = ANY($4::text[]) THEN $8::jsonb ELSE audience_age_groups END,
         audience_gender_split = CASE WHEN 'audienceGenderSplit' = ANY($4::text[]) THEN $9::jsonb ELSE audience_gender_split END,
         platform_metadata = platform_metadata || jsonb_build_object(
           'profileUrlImported', $10::boolean
         ),
         verification_status = 'verified', updated_at = now()
     WHERE id = $1`,
    [
      platformId,
      projection.account.username ?? projection.account.displayName,
      projection.account.profileUrl ?? null,
      imported,
      metricValue(projection.imported.followers) ?? 0,
      projection.engagementRate ?? 0,
      JSON.stringify(audienceEntries(projection.imported.demographics.countries, "country")),
      JSON.stringify(audienceEntries(projection.imported.demographics.ageGroups, "ageRange")),
      JSON.stringify(genderSplit(projection.imported.demographics.genders)),
      Boolean(projection.account.profileUrl),
    ],
  );
}

async function insertMetricSnapshot(
  client: PgClient,
  input: {
    connectionId: string;
    platformId: string;
    creatorProfileId: string;
    organizationId: string;
    projection: ImportedProjection;
  },
): Promise<void> {
  const { imported } = input.projection;
  await client.query(
    `INSERT INTO marketplace.creator_platform_metric_snapshots (
       connection_id, platform_id, creator_profile_id, organization_id, captured_at,
       window_days, window_start, window_end, follower_count, content_item_count,
       likes, comments, shares, reach, views, engagement_rate, audience_countries,
       audience_age_groups, audience_gender_split, imported_fields, unavailable_fields,
       formula_version, provider_metrics
     ) VALUES ($1, $2, $3, $4, $5, $23, $6, $7, $8, $9, $10, $11, $12, $13, $14,
               $15, $16::jsonb, $17::jsonb, $18::jsonb, $19::text[], $20::jsonb, $21,
               $22::jsonb)`,
    [
      input.connectionId,
      input.platformId,
      input.creatorProfileId,
      input.organizationId,
      imported.importedAt,
      imported.window.startDate,
      imported.window.endDate,
      metricValue(imported.followers),
      metricValue(imported.contentCount),
      metricValue(imported.likes),
      metricValue(imported.comments),
      metricValue(imported.shares),
      metricValue(imported.reach),
      metricValue(imported.views),
      input.projection.engagementRate,
      JSON.stringify(audienceEntries(imported.demographics.countries, "country")),
      JSON.stringify(audienceEntries(imported.demographics.ageGroups, "ageRange")),
      JSON.stringify(genderSplit(imported.demographics.genders)),
      input.projection.importedFields,
      JSON.stringify(input.projection.unavailableFields),
      CREATOR_PLATFORM_ENGAGEMENT_FORMULA_VERSION,
      JSON.stringify(imported.providerMetrics ?? {}),
      CREATOR_PLATFORM_ENGAGEMENT_WINDOW_DAYS,
    ],
  );
}

async function recalculateCreatorProfileCompletion(
  client: PgClient,
  input: Pick<AuthorizationRecord, "creatorProfileId" | "organizationId">,
): Promise<void> {
  await client.query(
    `WITH completion AS (
       SELECT marketplace.creator_profile_is_complete(
         $1::uuid,
         $2::uuid
       ) AS is_complete
     )
     UPDATE marketplace.creator_profiles profile
     SET profile_complete = completion.is_complete,
         profile_completed_at = CASE
           WHEN completion.is_complete THEN COALESCE(profile.profile_completed_at, now())
           ELSE NULL
         END,
         updated_at = now()
     FROM completion
     WHERE profile.id = $1 AND profile.organization_id = $2`,
    [input.creatorProfileId, input.organizationId],
  );
}

async function readConnectionDocument(
  client: PgClient,
  connectionId: string,
): Promise<CreatorPlatformConnectionDocument> {
  const result = await client.query<ConnectionRow>(
    `SELECT ${connectionColumns}
     FROM marketplace.creator_platform_connections connection
     JOIN marketplace.creator_platforms platform ON platform.id = connection.platform_id
     WHERE connection.id = $1`,
    [connectionId],
  );
  if (!result.rows[0]) throw new Error("Creator platform connection was not persisted");
  return mapConnectionDocument(result.rows[0]);
}

async function claimStagedCredential(
  client: PgClient,
  authorizationId: string,
  credentialRef: string,
): Promise<boolean> {
  const result = await client.query<{ credentialRef: string }>(
    `DELETE FROM marketplace.creator_platform_credential_cleanup_jobs
     WHERE credential_ref = $1
       AND authorization_id = $2
       AND cleanup_claim_id IS NULL
     RETURNING credential_ref AS "credentialRef"`,
    [credentialRef, authorizationId],
  );
  return Boolean(result.rows[0]);
}

async function inTransaction<T>(
  pool: PgPool,
  operation: (client: PgClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await operation(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

function audienceEntries(
  metric: CreatorPlatformMetric<Record<string, number>>,
  key: "country" | "ageRange",
): Array<Record<string, string | number>> {
  return metric.value
    ? Object.entries(metric.value)
        .sort((left, right) => right[1] - left[1])
        .slice(0, 3)
        .map(([label, percentage]) => ({ [key]: label, percentage }))
    : [];
}

function genderSplit(
  metric: CreatorPlatformMetric<Record<string, number>>,
): Record<string, number> {
  if (!metric.value) return {};
  return {
    male: metric.value.male ?? 0,
    female: metric.value.female ?? 0,
    ...(metric.value.other === undefined ? {} : { other: metric.value.other }),
  };
}

function importFieldArray(value: unknown): CreatorPlatformImportField[] {
  const allowed = new Set<CreatorPlatformImportField>([
    "followerCount",
    "reach",
    "views",
    "contentItemCount",
    "likes",
    "comments",
    "shares",
    "engagementRate",
    "audienceCountries",
    "audienceAgeGroups",
    "audienceGenderSplit",
  ]);
  return Array.isArray(value)
    ? value.filter(
        (entry): entry is CreatorPlatformImportField =>
          typeof entry === "string" && allowed.has(entry as CreatorPlatformImportField),
      )
    : [];
}

function unavailableFieldArray(value: unknown): CreatorPlatformUnavailableField[] {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is CreatorPlatformUnavailableField => {
    if (typeof entry !== "object" || entry === null) return false;
    const candidate = entry as { field?: unknown; reason?: unknown };
    return (
      importFieldArray([candidate.field]).length === 1 &&
      [
        "unsupported",
        "privacy_threshold",
        "permission_missing",
        "insufficient_data",
        "account_type_ineligible",
        "provider_omitted",
      ].includes(String(candidate.reason))
    );
  });
}

function toIso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

class CreatorPlatformAlreadyConnectedError extends Error {
  constructor() {
    super("This provider account is already connected to another creator profile");
  }
}

class CreatorPlatformTargetChangedError extends Error {
  constructor() {
    super("The selected creator platform is no longer available");
  }
}

class CreatorPlatformAuthorizationConsumedError extends Error {
  constructor() {
    super("The creator platform authorization is no longer pending");
  }
}

export class CreatorPlatformAuthorizationAccessRevokedError extends Error {
  constructor() {
    super("The creator no longer has access to this profile");
  }
}

export class CreatorPlatformConnectionChangedError extends Error {
  constructor() {
    super("The creator platform connection changed during the operation");
  }
}

export class CreatorPlatformCredentialReadError extends Error {
  constructor() {
    super("Creator platform credential vault read failed");
    this.name = "CreatorPlatformCredentialReadError";
  }
}

export class CreatorPlatformGrantUnavailableError extends Error {
  constructor() {
    super("Creator platform grant is unavailable");
    this.name = "CreatorPlatformGrantUnavailableError";
  }
}
