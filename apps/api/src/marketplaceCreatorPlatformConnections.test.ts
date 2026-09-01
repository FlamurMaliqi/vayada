import {
  createFakeVerifier,
  type IdentityLifecycleCommandBus,
  type IdentityRepository,
  type VerifiedSession,
} from "@vayada/backend-auth";
import { CREATOR_PLATFORM_ENGAGEMENT_WINDOW_DAYS } from "@vayada/domain-marketplace";
import type { FastifyInstance } from "fastify";
import { createHash, randomUUID } from "node:crypto";
import pg from "pg";
import { afterEach, describe, expect, it, vi } from "vitest";

import { buildApp } from "./app.js";
import { agencyPropertyAccessRepository } from "./testAuthorization.js";
import {
  createCreatorPlatformAdapterRegistry,
  type CreatorPlatformAccount,
  type CreatorPlatformAdapter,
  type CreatorPlatformGrant,
} from "./integrations/creatorPlatforms/index.js";
import { CreatorPlatformRequestError } from "./integrations/creatorPlatforms/http.js";
import {
  createMemoryProviderCredentialVault,
  createSecretsManagerProviderCredentialVault,
} from "./platform/providerCredentialVault.js";
import {
  createPgMarketplaceCreatorPlatformConnectionRepository,
  type MarketplaceCreatorPlatformConnectionRepository,
} from "./routes/marketplaceCreatorPlatformConnections.js";
import type { MarketplaceCreatorSelfServiceRepository } from "./routes/marketplaceCreatorSelfService.js";

const profileId = "00000000-0000-4000-8000-000000000001";
const organizationId = "00000000-0000-4000-8000-000000000002";
const actorUserId = "00000000-0000-4000-8000-000000000003";
const session: VerifiedSession = {
  workosUserId: "workos_creator",
  workosOrgId: "workos_creator_org",
  sessionId: "session_creator",
  expiresAt: Math.floor(Date.now() / 1000) + 3_600,
};

function oauthCallbackCookie(state: string, secure = true): string {
  const digest = (value: string) => createHash("sha256").update(value).digest("hex");
  const name = `${secure ? "__Host-" : ""}vayada_creator_oauth_${digest(state).slice(0, 16)}`;
  return `${name}=${digest(`vayada-creator-oauth-browser:${state}`)}`;
}

let app: FastifyInstance | undefined;

afterEach(async () => {
  await app?.close();
  app = undefined;
});

describe("marketplace creator platform connection routes", () => {
  it("starts a one-time provider authorization after creator policy checks", async () => {
    const repository = connectionRepository();
    const adapter = creatorPlatformAdapter("instagram");
    app = buildCreatorPlatformApp(repository, [adapter]);

    const response = await app.inject({
      method: "POST",
      url: "/api/marketplace/creators/me/platform-connections/instagram/authorize",
      headers: { authorization: "Bearer valid-token" },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json<{ authorizationUrl: string }>();
    const authorizationUrl = new URL(body.authorizationUrl);
    expect(authorizationUrl.origin).toBe("https://provider.example");
    expect(authorizationUrl.searchParams.get("redirect_uri")).toBe(
      "https://creator.api.example/api/marketplace/creator-platform-oauth/instagram/callback",
    );
    const state = authorizationUrl.searchParams.get("state");
    expect(state).toBeTruthy();
    expect(response.headers["set-cookie"]).toMatch(
      /^__Host-vayada_creator_oauth_[a-f0-9]{16}=[a-f0-9]{64};/,
    );
    expect(response.headers["set-cookie"]).toContain("Max-Age=600");
    expect(response.headers["set-cookie"]).toContain("Path=/");
    expect(response.headers["set-cookie"]).toContain("HttpOnly");
    expect(response.headers["set-cookie"]).toContain("SameSite=Lax");
    expect(response.headers["set-cookie"]).toContain("Secure");
    expect(repository.createAuthorization).toHaveBeenCalledWith(
      expect.objectContaining({
        access: { organizationId, creatorProfileId: profileId, actorUserId },
        platform: "instagram",
        stateDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
      }),
    );
    const createInput = (
      repository.createAuthorization.mock.calls[0] as unknown as [
        Parameters<MarketplaceCreatorPlatformConnectionRepository["createAuthorization"]>[0],
      ]
    )[0];
    expect(createInput.stateDigest).not.toBe(state);
  });

  it("supports browser-bound callbacks on local HTTP without marking the cookie Secure", async () => {
    const repository = connectionRepository({
      consumeAuthorization: authorizationRecord("instagram"),
    });
    app = buildCreatorPlatformApp(
      repository,
      [creatorPlatformAdapter("instagram")],
      undefined,
      false,
      "http://localhost:8003",
    );

    const authorize = await app.inject({
      method: "POST",
      url: "/api/marketplace/creators/me/platform-connections/instagram/authorize",
      headers: { authorization: "Bearer valid-token" },
    });
    const authorizationUrl = new URL(
      authorize.json<{ authorizationUrl: string }>().authorizationUrl,
    );
    const state = authorizationUrl.searchParams.get("state")!;
    const setCookie = String(authorize.headers["set-cookie"]);

    expect(setCookie).toMatch(/^vayada_creator_oauth_[a-f0-9]{16}=/);
    expect(setCookie).not.toContain("Secure");
    const callback = await app.inject({
      method: "GET",
      url: `/api/marketplace/creator-platform-oauth/instagram/callback?code=provider-code&state=${state}`,
      headers: { cookie: setCookie.split(";")[0] },
    });

    expect(new URL(callback.headers.location!).searchParams.get("connection")).toBe("success");
    expect(callback.headers["set-cookie"]).toContain("Max-Age=0");
    expect(callback.headers["set-cookie"]).not.toContain("Secure");
  });

  it("rejects an OAuth callback without the initiating browser cookie before consuming state", async () => {
    const repository = connectionRepository({
      consumeAuthorization: authorizationRecord("instagram"),
    });
    app = buildCreatorPlatformApp(repository, [creatorPlatformAdapter("instagram")]);

    const response = await app.inject({
      method: "GET",
      url: "/api/marketplace/creator-platform-oauth/instagram/callback?code=provider-code&state=opaque-state",
    });

    expect(response.statusCode).toBe(302);
    expect(new URL(response.headers.location!).searchParams.get("error_code")).toBe(
      "oauth_browser_mismatch",
    );
    expect(repository.consumeAuthorization).not.toHaveBeenCalled();
  });

  it("rejects OAuth state presented with a different browser authorization cookie", async () => {
    const repository = connectionRepository({
      consumeAuthorization: authorizationRecord("instagram"),
    });
    app = buildCreatorPlatformApp(repository, [creatorPlatformAdapter("instagram")]);

    const first = await app.inject({
      method: "POST",
      url: "/api/marketplace/creators/me/platform-connections/instagram/authorize",
      headers: { authorization: "Bearer valid-token" },
    });
    const second = await app.inject({
      method: "POST",
      url: "/api/marketplace/creators/me/platform-connections/instagram/authorize",
      headers: { authorization: "Bearer valid-token" },
    });
    const firstState = new URL(
      first.json<{ authorizationUrl: string }>().authorizationUrl,
    ).searchParams.get("state")!;
    const secondBrowserCookie = String(second.headers["set-cookie"]).split(";")[0];

    const response = await app.inject({
      method: "GET",
      url: `/api/marketplace/creator-platform-oauth/instagram/callback?code=provider-code&state=${firstState}`,
      headers: { cookie: secondBrowserCookie },
    });

    expect(new URL(response.headers.location!).searchParams.get("error_code")).toBe(
      "oauth_browser_mismatch",
    );
    expect(repository.consumeAuthorization).not.toHaveBeenCalled();
  });

  it("targets an owned manual platform row when starting authorization", async () => {
    const repository = connectionRepository();
    app = buildCreatorPlatformApp(repository, [creatorPlatformAdapter("instagram")]);
    const platformId = "00000000-0000-4000-8000-000000000010";

    const response = await app.inject({
      method: "POST",
      url: "/api/marketplace/creators/me/platform-connections/instagram/authorize",
      headers: { authorization: "Bearer valid-token" },
      payload: { platformId },
    });

    expect(response.statusCode).toBe(200);
    expect(repository.createAuthorization).toHaveBeenCalledWith(
      expect.objectContaining({ targetPlatformId: platformId }),
    );
  });

  it("rejects a manual platform row that changed before authorization", async () => {
    const repository = connectionRepository({ createAuthorization: false });
    app = buildCreatorPlatformApp(repository, [creatorPlatformAdapter("instagram")]);

    const response = await app.inject({
      method: "POST",
      url: "/api/marketplace/creators/me/platform-connections/instagram/authorize",
      headers: { authorization: "Bearer valid-token" },
      payload: { platformId: "00000000-0000-4000-8000-000000000010" },
    });

    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({ code: "creator_platform_changed" });
  });

  it("returns a stable unavailable response when a provider is not configured", async () => {
    const repository = connectionRepository();
    app = buildCreatorPlatformApp(repository, []);

    const response = await app.inject({
      method: "POST",
      url: "/api/marketplace/creators/me/platform-connections/youtube/authorize",
      headers: { authorization: "Bearer valid-token" },
    });

    expect(response.statusCode).toBe(503);
    expect(response.json()).toMatchObject({ code: "creator_platform_not_configured" });
    expect(repository.createAuthorization).not.toHaveBeenCalled();
  });

  it("imports a single authorized account, calculates 30-day engagement, and redirects safely", async () => {
    const repository = connectionRepository({
      consumeAuthorization: authorizationRecord("instagram"),
    });
    const vault = createMemoryProviderCredentialVault();
    const adapter = creatorPlatformAdapter("instagram");
    app = buildCreatorPlatformApp(repository, [adapter], vault);

    const response = await app.inject({
      method: "GET",
      url: "/api/marketplace/creator-platform-oauth/instagram/callback?code=provider-code&state=opaque-state",
      headers: { cookie: oauthCallbackCookie("opaque-state") },
    });

    expect(response.statusCode).toBe(302);
    expect(response.headers["set-cookie"]).toContain("Max-Age=0");
    const redirect = new URL(response.headers.location!);
    expect(redirect.origin + redirect.pathname).toBe(
      "https://marketplace.example/profile/complete",
    );
    expect(redirect.searchParams.get("connection")).toBe("success");
    expect(redirect.searchParams.get("platform")).toBe("instagram");
    expect(redirect.searchParams.get("connection_id")).toBe("connection-1");
    expect(repository.completeConnection).toHaveBeenCalledWith(
      expect.objectContaining({
        projection: expect.objectContaining({
          engagementRate: 3,
          importedFields: expect.arrayContaining([
            "followerCount",
            "contentItemCount",
            "engagementRate",
          ]),
          imported: expect.objectContaining({
            demographics: expect.objectContaining({
              countries: {
                value: { Germany: 50, "United States": 20, France: 20 },
              },
              ageGroups: { value: { "55+": 50, "25-34": 40 } },
            }),
          }),
        }),
      }),
    );
    const completed = repository.completeConnection.mock.calls[0][0];
    expect(await vault.get(completed.credentialRef)).toMatchObject({
      provider: "instagram",
      accessToken: "provider-secret",
    });
  });

  it("stops a callback when the initiating actor no longer has creator access", async () => {
    const repository = connectionRepository({
      consumeAuthorization: authorizationRecord("instagram", {
        credentialRef: "vayada/test/auth-1",
      }),
      actorAuthorized: false,
    });
    const adapter = creatorPlatformAdapter("instagram");
    adapter.exchangeCode = vi.fn(adapter.exchangeCode);
    app = buildCreatorPlatformApp(repository, [adapter]);

    const response = await app.inject({
      method: "GET",
      url: "/api/marketplace/creator-platform-oauth/instagram/callback?code=provider-code&state=opaque-state",
      headers: { cookie: oauthCallbackCookie("opaque-state") },
    });

    expect(response.statusCode).toBe(302);
    expect(new URL(response.headers.location!).searchParams.get("error_code")).toBe(
      "authorization_access_revoked",
    );
    expect(adapter.exchangeCode).not.toHaveBeenCalled();
    expect(repository.completeConnection).not.toHaveBeenCalled();
  });

  it("stores only the selected provider account grant", async () => {
    const repository = connectionRepository({
      consumeAuthorization: authorizationRecord("facebook", {
        credentialRef: "vayada/test/auth-1",
      }),
    });
    const vault = createMemoryProviderCredentialVault();
    const selected = account("facebook", "page-1");
    const adapter = creatorPlatformAdapter("facebook", [selected]);
    adapter.grantForAccount = vi.fn((_account, grant) => ({
      ...grant,
      pageAccessTokens: { "page-1": "selected-page-secret" },
    }));
    app = buildCreatorPlatformApp(repository, [adapter], vault);

    const response = await app.inject({
      method: "GET",
      url: "/api/marketplace/creator-platform-oauth/facebook/callback?code=provider-code&state=opaque-state",
      headers: { cookie: oauthCallbackCookie("opaque-state") },
    });

    expect(response.statusCode).toBe(302);
    expect(adapter.grantForAccount).toHaveBeenCalledWith(selected, expect.any(Object));
    const completed = repository.completeConnection.mock.calls[0][0];
    expect(completed.credentialRef).not.toBe("vayada/test/auth-1");
    expect(await vault.get(completed.credentialRef)).toMatchObject({
      pageAccessTokens: { "page-1": "selected-page-secret" },
    });
    expect(await vault.get("vayada/test/auth-1")).toBeNull();
  });

  it("never writes OAuth callback codes or state to request logs", async () => {
    const logLines: string[] = [];
    const repository = connectionRepository({
      consumeAuthorization: authorizationRecord("instagram"),
    });
    const adapter = creatorPlatformAdapter("instagram");
    adapter.exchangeCode = vi.fn(async () => {
      throw new Error("provider exchange failed");
    });
    app = buildCreatorPlatformApp(repository, [adapter], undefined, {
      level: "info",
      stream: { write: (line: string) => logLines.push(line) },
    });

    await app.inject({ method: "GET", url: "/health" });
    expect(logLines.length).toBeGreaterThan(0);
    logLines.length = 0;

    const response = await app.inject({
      method: "GET",
      url: "/api/marketplace/creator-platform-oauth/instagram/callback?code=secret-code&state=secret-state",
      headers: { cookie: oauthCallbackCookie("secret-state") },
    });

    expect(response.statusCode).toBe(302);
    expect(logLines.join("\n")).not.toContain("secret-code");
    expect(logLines.join("\n")).not.toContain("secret-state");
  });

  it("stores only safe candidates when provider account selection is required", async () => {
    const repository = connectionRepository({
      consumeAuthorization: authorizationRecord("facebook"),
    });
    const adapter = creatorPlatformAdapter("facebook", [
      account("facebook", "page-1"),
      account("facebook", "page-2"),
    ]);
    app = buildCreatorPlatformApp(repository, [adapter]);

    const response = await app.inject({
      method: "GET",
      url: "/api/marketplace/creator-platform-oauth/facebook/callback?code=provider-code&state=opaque-state",
      headers: { cookie: oauthCallbackCookie("opaque-state") },
    });

    expect(response.statusCode).toBe(302);
    const redirect = new URL(response.headers.location!);
    expect(redirect.searchParams.get("connection")).toBe("select");
    expect(redirect.searchParams.get("authorization_id")).toBe("auth-1");
    expect(repository.setAuthorizationCandidates).toHaveBeenCalledWith(
      expect.objectContaining({
        candidates: [account("facebook", "page-1"), account("facebook", "page-2")],
      }),
    );
    const candidateInput = (
      repository.setAuthorizationCandidates.mock.calls[0] as unknown as [
        Parameters<MarketplaceCreatorPlatformConnectionRepository["setAuthorizationCandidates"]>[0],
      ]
    )[0];
    expect(JSON.stringify(candidateInput)).not.toContain("provider-secret");
  });

  it("uses a fresh AWS secret for a selected account instead of versioning the broad grant", async () => {
    const temporaryRef = "vayada/test/auth-1";
    const accounts = [account("facebook", "page-1"), account("facebook", "page-2")];
    const pending = authorizationRecord("facebook", {
      status: "pending_account_selection",
      credentialRef: temporaryRef,
      candidates: accounts,
    });
    const repository = connectionRepository({
      consumeAuthorization: authorizationRecord("facebook", { credentialRef: temporaryRef }),
      authorization: pending,
    });
    const adapter = creatorPlatformAdapter("facebook", accounts);
    adapter.exchangeCode = vi.fn(async () => ({
      ...creatorGrant("facebook"),
      subjectId: "meta-user-1",
      pageAccessTokens: { "page-1": "page-secret-1", "page-2": "page-secret-2" },
    }));
    adapter.grantForAccount = vi.fn((selectedAccount, grant) => ({
      ...grant,
      pageAccessTokens: {
        [selectedAccount.providerAccountId]:
          grant.provider === "facebook"
            ? grant.pageAccessTokens[selectedAccount.providerAccountId]!
            : "",
      },
    }));
    const secrets = new Map<string, string>();
    const commandNames: string[] = [];
    const send = vi.fn(
      async (command: { constructor: { name: string }; input: Record<string, unknown> }) => {
        commandNames.push(command.constructor.name);
        const reference = String(command.input.Name ?? command.input.SecretId);
        if (command.constructor.name === "CreateSecretCommand") {
          secrets.set(reference, String(command.input.SecretString));
          return {};
        }
        if (command.constructor.name === "GetSecretValueCommand") {
          return { SecretString: secrets.get(reference) };
        }
        if (command.constructor.name === "DeleteSecretCommand") {
          secrets.delete(reference);
          return {};
        }
        throw new Error(`Unexpected AWS command ${command.constructor.name}`);
      },
    );
    const vault = createSecretsManagerProviderCredentialVault({ client: { send } as never });
    app = buildCreatorPlatformApp(repository, [adapter], vault);

    const callback = await app.inject({
      method: "GET",
      url: "/api/marketplace/creator-platform-oauth/facebook/callback?code=provider-code&state=opaque-state",
      headers: { cookie: oauthCallbackCookie("opaque-state") },
    });
    expect(new URL(callback.headers.location!).searchParams.get("connection")).toBe("select");

    const selection = await app.inject({
      method: "POST",
      url: "/api/marketplace/creators/me/platform-authorizations/auth-1/accounts",
      headers: { authorization: "Bearer valid-token" },
      payload: { externalAccountId: "page-1" },
    });

    expect(selection.statusCode).toBe(201);
    const finalRef = repository.completeConnection.mock.calls[0][0].credentialRef;
    expect(finalRef).not.toBe(temporaryRef);
    expect(commandNames).not.toContain("PutSecretValueCommand");
    expect(commandNames.filter((name) => name === "CreateSecretCommand")).toHaveLength(2);
    expect(secrets.has(temporaryRef)).toBe(false);
    expect(JSON.parse(secrets.get(finalRef)!)).toMatchObject({
      pageAccessTokens: { "page-1": "page-secret-1" },
    });
    expect(secrets.get(finalRef)).not.toContain("page-secret-2");
  });

  it("keeps unsupported TikTok demographics available for manual entry", async () => {
    const pending = authorizationRecord("tiktok", {
      status: "pending_account_selection",
      credentialRef: "vayada/test/auth-1",
      candidates: [account("tiktok", "tiktok-user")],
    });
    const repository = connectionRepository({ authorization: pending });
    const vault = createMemoryProviderCredentialVault();
    await vault.put(pending.credentialRef!, creatorGrant("tiktok"));
    app = buildCreatorPlatformApp(
      repository,
      [creatorPlatformAdapter("tiktok", pending.candidates, true)],
      vault,
    );

    const response = await app.inject({
      method: "POST",
      url: "/api/marketplace/creators/me/platform-authorizations/auth-1/accounts",
      headers: { authorization: "Bearer valid-token" },
      payload: { externalAccountId: "tiktok-user" },
    });

    expect(response.statusCode).toBe(201);
    expect(repository.completeConnection.mock.calls[0][0].projection).toMatchObject({
      unavailableFields: expect.arrayContaining([
        { field: "audienceCountries", reason: "unsupported" },
        { field: "audienceAgeGroups", reason: "unsupported" },
        { field: "audienceGenderSplit", reason: "unsupported" },
      ]),
    });
    const completed = repository.completeConnection.mock.calls[0][0];
    expect(completed.credentialRef).not.toBe(pending.credentialRef);
    expect(completed.credentialRef).toMatch(/\/auth-1\/account\//);
    expect(await vault.get(pending.credentialRef!)).toBeNull();
    expect(await vault.get(completed.credentialRef)).toMatchObject({ provider: "tiktok" });
    expect(repository.queueCredentialCleanup).toHaveBeenCalledWith({
      authorizationId: "auth-1",
      credentialRef: completed.credentialRef,
      availableAt: expect.any(String),
    });
  });

  it("releases account selection when the credential vault read is temporarily unavailable", async () => {
    const pending = authorizationRecord("facebook", {
      status: "pending_account_selection",
      credentialRef: "vayada/test/auth-1",
      candidates: [account("facebook", "page-1")],
    });
    const repository = connectionRepository({ authorization: pending });
    const adapter = creatorPlatformAdapter("facebook", pending.candidates);
    adapter.importAccount = vi.fn(adapter.importAccount);
    const vault = {
      put: vi.fn(async () => undefined),
      get: vi.fn(async () => {
        throw new Error("vault temporarily unavailable");
      }),
      delete: vi.fn(async () => undefined),
    };
    app = buildCreatorPlatformApp(repository, [adapter], vault);

    const response = await app.inject({
      method: "POST",
      url: "/api/marketplace/creators/me/platform-authorizations/auth-1/accounts",
      headers: { authorization: "Bearer valid-token" },
      payload: { externalAccountId: "page-1" },
    });

    expect(response.statusCode).toBe(502);
    expect(response.json()).toEqual({
      code: "credential_vault_unavailable",
      detail: "Platform credentials are temporarily unavailable. Please try again.",
    });
    expect(repository.releaseAuthorizationAccountClaim).toHaveBeenCalledWith({
      authorizationId: "auth-1",
    });
    expect(repository.failAuthorization).not.toHaveBeenCalled();
    expect(adapter.importAccount).not.toHaveBeenCalled();
  });

  it("does not import when another provider account was already selected", async () => {
    const pending = authorizationRecord("facebook", {
      status: "pending_account_selection",
      credentialRef: "vayada/test/auth-1",
      candidates: [account("facebook", "page-1"), account("facebook", "page-2")],
    });
    const repository = connectionRepository({
      authorization: pending,
      claimAuthorizationAccount: null,
    });
    const vault = createMemoryProviderCredentialVault();
    await vault.put(pending.credentialRef!, creatorGrant("facebook"));
    const adapter = creatorPlatformAdapter("facebook", pending.candidates);
    adapter.importAccount = vi.fn(adapter.importAccount);
    app = buildCreatorPlatformApp(repository, [adapter], vault);

    const response = await app.inject({
      method: "POST",
      url: "/api/marketplace/creators/me/platform-authorizations/auth-1/accounts",
      headers: { authorization: "Bearer valid-token" },
      payload: { externalAccountId: "page-2" },
    });

    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({
      code: "platform_authorization_already_selected",
    });
    expect(adapter.importAccount).not.toHaveBeenCalled();
    expect(repository.completeConnection).not.toHaveBeenCalled();
  });

  it("rotates credentials under a new reference for each successful sync", async () => {
    const credentialRef = "vayada/test/auth-1/account/current";
    const vault = createMemoryProviderCredentialVault();
    await vault.put(credentialRef, creatorGrant("youtube"));
    const repository = connectionRepository({
      connection: {
        ...connectionDocument("youtube"),
        creatorProfileId: profileId,
        organizationId,
        authorizationId: "auth-1",
        externalAccountId: "youtube-account",
        credentialRef,
        syncLeaseId: null,
      },
    });
    app = buildCreatorPlatformApp(repository, [creatorPlatformAdapter("youtube")], vault);

    const response = await app.inject({
      method: "POST",
      url: "/api/marketplace/creators/me/platform-connections/connection-1/sync",
      headers: { authorization: "Bearer valid-token" },
    });

    expect(response.statusCode).toBe(200);
    const update = repository.updateConnectionFromImport.mock.calls[0][0];
    expect(update.connection.syncLeaseId).toEqual(expect.any(String));
    expect(update.nextCredentialRef).not.toBe(credentialRef);
    expect(update.nextCredentialRef).toMatch(/\/auth-1\/sync\//);
    expect(await vault.get(credentialRef)).toBeNull();
    expect(await vault.get(update.nextCredentialRef)).toMatchObject({ provider: "youtube" });
    expect(repository.queueCredentialCleanup).toHaveBeenCalledWith({
      authorizationId: "auth-1",
      credentialRef: update.nextCredentialRef,
      availableAt: expect.any(String),
    });
  });

  it("preserves the reconnect response when the stored grant is unavailable", async () => {
    const credentialRef = "vayada/test/auth-1/account/missing";
    const repository = connectionRepository({
      connection: {
        ...connectionDocument("youtube"),
        creatorProfileId: profileId,
        organizationId,
        authorizationId: "auth-1",
        externalAccountId: "youtube-account",
        credentialRef,
        syncLeaseId: null,
      },
    });
    app = buildCreatorPlatformApp(repository, [creatorPlatformAdapter("youtube")]);

    const response = await app.inject({
      method: "POST",
      url: "/api/marketplace/creators/me/platform-connections/connection-1/sync",
      headers: { authorization: "Bearer valid-token" },
    });

    expect(response.statusCode).toBe(409);
    expect(response.json()).toEqual({
      code: "platform_reconnect_required",
      detail: "Connect the platform again before syncing it.",
    });
    expect(repository.markConnectionError).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "reconnect_required",
        errorCode: "credential_unavailable",
      }),
    );
  });

  it("does not start provider work while another sync lease is active", async () => {
    const connection = {
      ...connectionDocument("instagram"),
      creatorProfileId: profileId,
      organizationId,
      authorizationId: "auth-1",
      externalAccountId: "instagram-account",
      credentialRef: "vayada/test/auth-1/account/current",
      syncLeaseId: null,
    };
    const repository = connectionRepository({ connection, claimConnectionSync: null });
    const adapter = creatorPlatformAdapter("instagram");
    adapter.listAccounts = vi.fn(adapter.listAccounts);
    app = buildCreatorPlatformApp(repository, [adapter]);

    const response = await app.inject({
      method: "POST",
      url: "/api/marketplace/creators/me/platform-connections/connection-1/sync",
      headers: { authorization: "Bearer valid-token" },
    });

    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({ code: "creator_platform_sync_in_progress" });
    expect(adapter.listAccounts).not.toHaveBeenCalled();
  });

  it("treats provider quota errors as retryable sync failures", async () => {
    const credentialRef = "vayada/test/auth-1/account/current";
    const vault = createMemoryProviderCredentialVault();
    await vault.put(credentialRef, creatorGrant("youtube"));
    const repository = connectionRepository({
      connection: {
        ...connectionDocument("youtube"),
        creatorProfileId: profileId,
        organizationId,
        authorizationId: "auth-1",
        externalAccountId: "youtube-account",
        credentialRef,
        syncLeaseId: null,
      },
    });
    const adapter = creatorPlatformAdapter("youtube");
    adapter.listAccounts = vi.fn(async () => {
      throw new CreatorPlatformRequestError("youtube", 403, "quota", "quotaExceeded");
    });
    app = buildCreatorPlatformApp(repository, [adapter], vault);

    const response = await app.inject({
      method: "POST",
      url: "/api/marketplace/creators/me/platform-connections/connection-1/sync",
      headers: { authorization: "Bearer valid-token" },
    });

    expect(response.statusCode).toBe(502);
    expect(response.json()).toMatchObject({ code: "provider_sync_failed" });
    expect(repository.markConnectionError).toHaveBeenCalledWith(
      expect.objectContaining({ status: "sync_failed", errorCode: "provider_sync_failed" }),
    );
  });

  it("disconnects locally without revoking a provider-wide grant", async () => {
    const vault = createMemoryProviderCredentialVault();
    await vault.put("vayada/test/connection-1", creatorGrant("youtube"));
    const repository = connectionRepository({
      connection: {
        ...connectionDocument("youtube"),
        creatorProfileId: profileId,
        organizationId,
        authorizationId: "auth-1",
        externalAccountId: "youtube-account",
        credentialRef: "vayada/test/connection-1",
        syncLeaseId: null,
      },
    });
    const adapter = creatorPlatformAdapter("youtube");
    adapter.revoke = vi.fn(async () => {
      throw new Error("provider unavailable");
    });
    app = buildCreatorPlatformApp(repository, [adapter], vault);

    const response = await app.inject({
      method: "DELETE",
      url: "/api/marketplace/creators/me/platform-connections/connection-1",
      headers: { authorization: "Bearer valid-token" },
    });

    expect(response.statusCode).toBe(204);
    expect(await vault.get("vayada/test/connection-1")).toBeNull();
    expect(repository.revokeConnection).toHaveBeenCalledOnce();
    expect(adapter.revoke).not.toHaveBeenCalled();
    expect(repository.recordRevocationError).not.toHaveBeenCalled();
  });

  it("does not revoke a shared provider grant while another account remains connected", async () => {
    const vault = createMemoryProviderCredentialVault();
    await vault.put("vayada/test/connection-1", creatorGrant("facebook"));
    const repository = connectionRepository({
      connection: {
        ...connectionDocument("facebook"),
        creatorProfileId: profileId,
        organizationId,
        authorizationId: "auth-1",
        externalAccountId: "page-1",
        credentialRef: "vayada/test/connection-1",
        syncLeaseId: null,
      },
      revokeResult: { revoked: true },
    });
    const adapter = creatorPlatformAdapter("facebook");
    adapter.revoke = vi.fn(async () => undefined);
    app = buildCreatorPlatformApp(repository, [adapter], vault);

    const response = await app.inject({
      method: "DELETE",
      url: "/api/marketplace/creators/me/platform-connections/connection-1",
      headers: { authorization: "Bearer valid-token" },
    });

    expect(response.statusCode).toBe(204);
    expect(adapter.revoke).not.toHaveBeenCalled();
    expect(await vault.get("vayada/test/connection-1")).toBeNull();
  });

  it("retries durable cleanup candidates without exposing credentials", async () => {
    const vault = createMemoryProviderCredentialVault();
    await vault.put("vayada/test/expired-auth", creatorGrant("instagram"));
    const repository = connectionRepository({
      cleanupCandidates: [
        {
          credentialRef: "vayada/test/expired-auth",
          authorizationId: "auth-expired",
          claimId: "00000000-0000-4000-8000-000000000099",
        },
      ],
    });
    app = buildCreatorPlatformApp(repository, [], vault);

    await app.inject({ method: "GET", url: "/health" });

    expect(await vault.get("vayada/test/expired-auth")).toBeNull();
    expect(repository.markCredentialCleaned).toHaveBeenCalledWith({
      credentialRef: "vayada/test/expired-auth",
      cleanedAt: expect.any(String),
      claimId: "00000000-0000-4000-8000-000000000099",
    });
  });
  it("waits for in-flight credential cleanup before closing the repository", async () => {
    let markCleanupStarted!: () => void;
    const cleanupStarted = new Promise<void>((resolve) => {
      markCleanupStarted = resolve;
    });
    let releaseCleanup!: () => void;
    const cleanupReleased = new Promise<void>((resolve) => {
      releaseCleanup = resolve;
    });
    const repository = connectionRepository({
      async listCredentialCleanupCandidates() {
        markCleanupStarted();
        await cleanupReleased;
        return [];
      },
    });
    app = buildCreatorPlatformApp(repository, []);

    await app.ready();
    await cleanupStarted;
    const closing = app.close();
    await Promise.resolve();

    expect(repository.close).not.toHaveBeenCalled();
    releaseCleanup();
    await closing;
    expect(repository.close).toHaveBeenCalledOnce();
    app = undefined;
  });
});

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;

describe.skipIf(!TEST_DATABASE_URL)("creator platform connection persistence", () => {
  it("persists a normalized snapshot and preserves manual fields omitted by a later import", async () => {
    const client = new pg.Client({ connectionString: TEST_DATABASE_URL });
    const repository = createPgMarketplaceCreatorPlatformConnectionRepository({
      connectionString: TEST_DATABASE_URL!,
    });
    const integrationUserId = randomUUID();
    const integrationOtherUserId = randomUUID();
    const integrationOrganizationId = randomUUID();
    const integrationProfileId = randomUUID();
    const authorizationId = randomUUID();
    const pendingCredentialRef = `vayada/test/${authorizationId}`;
    const finalCredentialRef = `${pendingCredentialRef}/account/final`;
    await client.connect();
    try {
      await client.query(`INSERT INTO identity.users (id, email) VALUES ($1, $2)`, [
        integrationUserId,
        `${integrationUserId}@example.com`,
      ]);
      await client.query(`INSERT INTO identity.users (id, email) VALUES ($1, $2)`, [
        integrationOtherUserId,
        `${integrationOtherUserId}@example.com`,
      ]);
      await client.query(
        `INSERT INTO identity.organizations (id, kind, name, slug)
         VALUES ($1, 'creator_workspace', 'Integration Creator', $2)`,
        [integrationOrganizationId, `creator-${integrationOrganizationId}`],
      );
      await client.query(
        `INSERT INTO marketplace.creator_profiles (
           id, organization_id, owner_user_id, display_name, location_text, short_description
         ) VALUES ($1, $2, $3, 'Integration Creator', 'Berlin', 'Travel creator')`,
        [integrationProfileId, integrationOrganizationId, integrationUserId],
      );
      await client.query(
        `INSERT INTO identity.organization_memberships (
           organization_id, user_id, role_key, access_origin
         ) VALUES ($1, $2, 'creator_owner', 'agency')`,
        [integrationOrganizationId, integrationUserId],
      );
      await client.query(
        `INSERT INTO identity.organization_resource_links (
           organization_id, product, resource_type, resource_id, relationship
         ) VALUES ($1, 'marketplace', 'creator_profile', $2, 'owner')`,
        [integrationOrganizationId, integrationProfileId],
      );
      const access = {
        creatorProfileId: integrationProfileId,
        organizationId: integrationOrganizationId,
        actorUserId: integrationUserId,
      };
      await repository.createAuthorization({
        authorizationId,
        access,
        platform: "instagram",
        targetPlatformId: null,
        stateDigest: "a".repeat(64),
        credentialRef: pendingCredentialRef,
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      });
      const authorization = await repository.consumeAuthorization({
        platform: "instagram",
        stateDigest: "a".repeat(64),
        now: new Date().toISOString(),
      });
      expect(authorization).toMatchObject({ platform: "instagram", provider: "meta" });
      expect(await repository.isAuthorizationActorAuthorized(authorization!)).toBe(true);
      await client.query(`UPDATE identity.users SET status = 'suspended' WHERE id = $1`, [
        integrationUserId,
      ]);
      expect(await repository.isAuthorizationActorAuthorized(authorization!)).toBe(false);
      await client.query(`UPDATE identity.users SET status = 'active' WHERE id = $1`, [
        integrationUserId,
      ]);
      await repository.setAuthorizationCandidates({
        authorizationId,
        credentialRef: pendingCredentialRef,
        candidates: [
          account("instagram", "integration-instagram-account"),
          account("instagram", "integration-other-account"),
        ],
        grantedScopes: ["stats.read"],
      });
      const otherAccess = { ...access, actorUserId: integrationOtherUserId };
      expect(await repository.getPendingAuthorization(otherAccess)).toBeNull();
      expect(
        await repository.getAuthorization({ access: otherAccess, authorizationId }),
      ).toBeNull();
      expect(await repository.getPendingAuthorization(access)).toMatchObject({ authorizationId });
      expect(
        await repository.claimAuthorizationAccount({
          access,
          authorizationId,
          externalAccountId: "integration-instagram-account",
        }),
      ).toMatchObject({ status: "processing" });
      expect(
        await repository.claimAuthorizationAccount({
          access,
          authorizationId,
          externalAccountId: "integration-other-account",
        }),
      ).toBeNull();
      const selectedAuthorization = await repository.getAuthorization({ access, authorizationId });
      expect(selectedAuthorization?.candidates).toEqual([
        account("instagram", "integration-instagram-account"),
      ]);
      const projection = integrationProjection();
      await repository.queueCredentialCleanup({
        authorizationId,
        credentialRef: finalCredentialRef,
        availableAt: new Date(Date.now() + 60_000).toISOString(),
      });
      await client.query(`UPDATE identity.users SET status = 'suspended' WHERE id = $1`, [
        integrationUserId,
      ]);
      await expect(
        repository.completeConnection({
          authorization: selectedAuthorization!,
          credentialRef: finalCredentialRef,
          grant: creatorGrant("instagram"),
          projection,
        }),
      ).rejects.toThrow("no longer has access");
      await client.query(`UPDATE identity.users SET status = 'active' WHERE id = $1`, [
        integrationUserId,
      ]);
      const connection = await repository.completeConnection({
        authorization: selectedAuthorization!,
        credentialRef: finalCredentialRef,
        grant: creatorGrant("instagram"),
        projection,
      });

      expect(connection).toMatchObject({
        platform: "instagram",
        provider: "meta",
        status: "active",
        importedFields: expect.arrayContaining(["followerCount", "engagementRate"]),
      });
      expect(
        await repository.failAuthorization({
          authorizationId,
          errorCode: "ambiguous_callback_failure",
        }),
      ).toBe(false);
      const activeAuthorization = await client.query<{
        status: string;
        credentialRef: string | null;
      }>(
        `SELECT status, credential_ref AS "credentialRef"
         FROM marketplace.creator_platform_authorizations
         WHERE id = $1`,
        [authorizationId],
      );
      expect(activeAuthorization.rows[0]).toEqual({
        status: "active",
        credentialRef: finalCredentialRef,
      });
      const snapshot = await client.query<{
        count: string;
        providerMetrics: unknown;
        windowDays: number;
      }>(
        `SELECT count(*)::text AS count,
                (array_agg(provider_metrics ORDER BY captured_at DESC))[1] AS "providerMetrics",
                (array_agg(window_days ORDER BY captured_at DESC))[1] AS "windowDays"
         FROM marketplace.creator_platform_metric_snapshots
         WHERE connection_id = $1`,
        [connection.connectionId],
      );
      expect(snapshot.rows[0]?.count).toBe("1");
      expect(snapshot.rows[0]?.providerMetrics).toEqual({ totalLikes: 12_345 });
      expect(snapshot.rows[0]?.windowDays).toBe(CREATOR_PLATFORM_ENGAGEMENT_WINDOW_DAYS);
      await expect(
        repository.completeConnection({
          authorization: selectedAuthorization!,
          credentialRef: finalCredentialRef,
          grant: creatorGrant("instagram"),
          projection,
        }),
      ).rejects.toThrow("authorization is no longer pending");

      await client.query(
        `UPDATE marketplace.creator_platforms
         SET audience_countries = '[{"country":"DE","percentage":100}]'::jsonb
         WHERE id = $1`,
        [connection.platformId],
      );
      const persistedConnection = await repository.getConnection({
        access,
        connectionId: connection.connectionId,
      });
      const concurrentLeaseIds = [randomUUID(), randomUUID()];
      const concurrentClaims = await Promise.all(
        concurrentLeaseIds.map((leaseId) =>
          repository.claimConnectionSync({
            access,
            connectionId: connection.connectionId,
            leaseId,
            leaseExpiresAt: new Date(Date.now() + 60_000).toISOString(),
          }),
        ),
      );
      const claimedSyncs = concurrentClaims.filter(
        (candidate): candidate is NonNullable<typeof candidate> => candidate !== null,
      );
      expect(claimedSyncs).toHaveLength(1);
      await repository.releaseConnectionSync({
        connectionId: connection.connectionId,
        authorizationId: claimedSyncs[0]!.authorizationId,
        syncLeaseId: claimedSyncs[0]!.syncLeaseId!,
      });
      const nextSyncCredentialRef = `vayada/test/${authorizationId}/sync/1`;
      await repository.queueCredentialCleanup({
        authorizationId,
        credentialRef: nextSyncCredentialRef,
        availableAt: new Date(Date.now() + 60_000).toISOString(),
      });
      await repository.updateConnectionFromImport({
        access,
        connection: (await repository.claimConnectionSync({
          access,
          connectionId: connection.connectionId,
          leaseId: "00000000-0000-4000-8000-000000000020",
          leaseExpiresAt: new Date(Date.now() + 60_000).toISOString(),
        }))!,
        grant: creatorGrant("instagram"),
        nextCredentialRef: nextSyncCredentialRef,
        projection: integrationProjection(true),
      });
      const platform = await client.query<{ countries: unknown }>(
        `SELECT audience_countries AS countries
         FROM marketplace.creator_platforms WHERE id = $1`,
        [connection.platformId],
      );
      expect(platform.rows[0]?.countries).toEqual([{ country: "DE", percentage: 100 }]);

      const manualPlatformId = randomUUID();
      await client.query(
        `INSERT INTO marketplace.creator_platforms (
           id, creator_profile_id, organization_id, source_system, platform, handle,
           follower_count, engagement_rate, audience_countries
         ) VALUES ($1, $2, $3, 'marketplace', 'instagram', 'manual_creator', 250, 4.5,
                   '[{"country":"CH","percentage":100}]'::jsonb)`,
        [manualPlatformId, integrationProfileId, integrationOrganizationId],
      );
      const targetAuthorizationId = randomUUID();
      expect(
        await repository.createAuthorization({
          authorizationId: targetAuthorizationId,
          access,
          platform: "instagram",
          targetPlatformId: manualPlatformId,
          stateDigest: "b".repeat(64),
          credentialRef: `vayada/test/${targetAuthorizationId}`,
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
        }),
      ).toBe(true);
      const targetAuthorization = await repository.consumeAuthorization({
        platform: "instagram",
        stateDigest: "b".repeat(64),
        now: new Date().toISOString(),
      });
      const targetFinalCredentialRef = `vayada/test/${targetAuthorizationId}/account/final`;
      await repository.queueCredentialCleanup({
        authorizationId: targetAuthorizationId,
        credentialRef: targetFinalCredentialRef,
        availableAt: new Date(Date.now() + 60_000).toISOString(),
      });
      const attached = await repository.completeConnection({
        authorization: targetAuthorization!,
        credentialRef: targetFinalCredentialRef,
        grant: creatorGrant("instagram"),
        projection: integrationProjection(true, "integration-manual-account"),
      });
      expect(attached.platformId).toBe(manualPlatformId);
      const attachedPlatform = await client.query<{ countries: unknown; followers: number }>(
        `SELECT audience_countries AS countries, follower_count AS followers
         FROM marketplace.creator_platforms WHERE id = $1`,
        [manualPlatformId],
      );
      expect(attachedPlatform.rows[0]).toEqual({
        countries: [{ country: "CH", percentage: 100 }],
        followers: 10_000,
      });

      await repository.markConnectionError({
        connectionId: connection.connectionId,
        authorizationId: randomUUID(),
        credentialRef: "vayada/test/stale-sync",
        syncLeaseId: randomUUID(),
        status: "sync_failed",
        errorCode: "stale_sync",
      });
      const unchangedConnection = await repository.getConnection({
        access,
        connectionId: connection.connectionId,
      });
      expect(unchangedConnection?.status).toBe("active");

      const currentConnection = await repository.getConnection({
        access,
        connectionId: connection.connectionId,
      });
      expect(
        await repository.revokeConnection({
          access,
          connectionId: connection.connectionId,
          authorizationId: currentConnection!.authorizationId,
          credentialRef: currentConnection!.credentialRef,
        }),
      ).toMatchObject({ revoked: true });
      await expect(
        repository.updateConnectionFromImport({
          access,
          connection: persistedConnection!,
          grant: creatorGrant("instagram"),
          nextCredentialRef: `vayada/test/${authorizationId}/sync/stale`,
          projection,
        }),
      ).rejects.toThrow("connection changed");

      const reboundAuthorizationId = randomUUID();
      await repository.createAuthorization({
        authorizationId: reboundAuthorizationId,
        access,
        platform: "instagram",
        targetPlatformId: connection.platformId,
        stateDigest: "d".repeat(64),
        credentialRef: `vayada/test/${reboundAuthorizationId}`,
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      });
      const reboundAuthorization = await repository.consumeAuthorization({
        platform: "instagram",
        stateDigest: "d".repeat(64),
        now: new Date().toISOString(),
      });
      const reboundFinalCredentialRef = `vayada/test/${reboundAuthorizationId}/account/final`;
      await repository.queueCredentialCleanup({
        authorizationId: reboundAuthorizationId,
        credentialRef: reboundFinalCredentialRef,
        availableAt: new Date(Date.now() + 60_000).toISOString(),
      });
      await expect(
        repository.completeConnection({
          authorization: reboundAuthorization!,
          credentialRef: reboundFinalCredentialRef,
          grant: creatorGrant("instagram"),
          projection: integrationProjection(false, "different-instagram-account"),
        }),
      ).rejects.toThrow("already connected");
      const preservedIdentity = await client.query<{ externalAccountId: string }>(
        `SELECT external_account_id AS "externalAccountId"
         FROM marketplace.creator_platform_connections
         WHERE id = $1`,
        [connection.connectionId],
      );
      expect(preservedIdentity.rows[0]?.externalAccountId).toBe("integration-instagram-account");

      const cleanupFencedAuthorizationId = randomUUID();
      const cleanupFencedCredentialRef = `vayada/test/${cleanupFencedAuthorizationId}/account/final`;
      await repository.createAuthorization({
        authorizationId: cleanupFencedAuthorizationId,
        access,
        platform: "youtube",
        targetPlatformId: null,
        stateDigest: "e".repeat(64),
        credentialRef: `vayada/test/${cleanupFencedAuthorizationId}`,
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      });
      const cleanupFencedAuthorization = await repository.consumeAuthorization({
        platform: "youtube",
        stateDigest: "e".repeat(64),
        now: new Date().toISOString(),
      });
      await repository.queueCredentialCleanup({
        authorizationId: cleanupFencedAuthorizationId,
        credentialRef: cleanupFencedCredentialRef,
        availableAt: new Date().toISOString(),
      });
      const fencedCandidates = await repository.listCredentialCleanupCandidates({
        now: new Date().toISOString(),
        limit: 100,
      });
      const fencedCandidate = fencedCandidates.find(
        (candidate) => candidate.credentialRef === cleanupFencedCredentialRef,
      );
      expect(fencedCandidate?.claimId).toEqual(expect.any(String));
      const claimedCleanupJob = await client.query<{ claimId: string | null }>(
        `SELECT cleanup_claim_id::text AS "claimId"
         FROM marketplace.creator_platform_credential_cleanup_jobs
         WHERE credential_ref = $1`,
        [cleanupFencedCredentialRef],
      );
      expect(claimedCleanupJob.rows[0]?.claimId).toBe(fencedCandidate?.claimId);
      await expect(
        repository.completeConnection({
          authorization: cleanupFencedAuthorization!,
          credentialRef: cleanupFencedCredentialRef,
          grant: creatorGrant("youtube"),
          projection: {
            ...projection,
            account: account("youtube", "cleanup-fenced-youtube-account"),
            imported: {
              ...projection.imported,
              provider: "youtube",
              providerAccountId: "cleanup-fenced-youtube-account",
            },
          },
        }),
      ).rejects.toThrow("authorization is no longer pending");
      await repository.markCredentialCleaned({
        credentialRef: cleanupFencedCredentialRef,
        cleanedAt: new Date().toISOString(),
        claimId: fencedCandidate!.claimId,
      });

      const cleanupAuthorizationId = randomUUID();
      const cleanupCredentialRef = `vayada/test/${cleanupAuthorizationId}`;
      await repository.createAuthorization({
        authorizationId: cleanupAuthorizationId,
        access,
        platform: "youtube",
        targetPlatformId: null,
        stateDigest: "c".repeat(64),
        credentialRef: cleanupCredentialRef,
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      });
      await repository.consumeAuthorization({
        platform: "youtube",
        stateDigest: "c".repeat(64),
        now: new Date().toISOString(),
      });
      await repository.failAuthorization({
        authorizationId: cleanupAuthorizationId,
        errorCode: "provider_exchange_failed",
      });
      const cleanupCandidates = await repository.listCredentialCleanupCandidates({
        now: new Date().toISOString(),
        limit: 100,
      });
      const cleanupCandidate = cleanupCandidates.find(
        (candidate) => candidate.credentialRef === cleanupCredentialRef,
      );
      expect(cleanupCandidate).toMatchObject({
        credentialRef: cleanupCredentialRef,
        authorizationId: cleanupAuthorizationId,
        claimId: expect.any(String),
      });
      const durableCleanupJob = await client.query<{ claimId: string | null }>(
        `SELECT cleanup_claim_id::text AS "claimId"
         FROM marketplace.creator_platform_credential_cleanup_jobs
         WHERE credential_ref = $1`,
        [cleanupCredentialRef],
      );
      expect(durableCleanupJob.rows[0]?.claimId).toBe(cleanupCandidate?.claimId);
      await repository.markCredentialCleaned({
        credentialRef: cleanupCredentialRef,
        cleanedAt: new Date().toISOString(),
        claimId: cleanupCandidate!.claimId,
      });
      const cleanedAuthorization = await client.query<{
        credentialRef: string | null;
        credentialCleanedAt: Date | null;
      }>(
        `SELECT credential_ref AS "credentialRef",
                credential_cleaned_at AS "credentialCleanedAt"
         FROM marketplace.creator_platform_authorizations
         WHERE id = $1`,
        [cleanupAuthorizationId],
      );
      expect(cleanedAuthorization.rows[0]?.credentialRef).toBeNull();
      expect(cleanedAuthorization.rows[0]?.credentialCleanedAt).toBeInstanceOf(Date);
      const removedCleanupJob = await client.query<{ count: string }>(
        `SELECT count(*)::text AS count
         FROM marketplace.creator_platform_credential_cleanup_jobs
         WHERE credential_ref = $1`,
        [cleanupCredentialRef],
      );
      expect(removedCleanupJob.rows[0]?.count).toBe("0");
    } finally {
      await repository.close?.();
      await client.query(`DELETE FROM marketplace.creator_profiles WHERE id = $1`, [
        integrationProfileId,
      ]);
      await client.query(
        `DELETE FROM identity.organization_resource_links WHERE organization_id = $1`,
        [integrationOrganizationId],
      );
      await client.query(
        `DELETE FROM identity.organization_memberships WHERE organization_id = $1`,
        [integrationOrganizationId],
      );
      await client.query(`DELETE FROM identity.organizations WHERE id = $1`, [
        integrationOrganizationId,
      ]);
      await client.query(`DELETE FROM identity.users WHERE id = $1`, [integrationUserId]);
      await client.query(`DELETE FROM identity.users WHERE id = $1`, [integrationOtherUserId]);
      await client.end();
    }
  });
});

type IntegrationProjection = Parameters<
  MarketplaceCreatorPlatformConnectionRepository["completeConnection"]
>[0]["projection"];

function integrationProjection(
  missingDemographics = false,
  externalAccountId = "integration-instagram-account",
): IntegrationProjection {
  const unavailable = { value: null, unavailableReason: "privacy_threshold" as const };
  const demographicFields: IntegrationProjection["importedFields"] = missingDemographics
    ? []
    : ["audienceCountries", "audienceAgeGroups", "audienceGenderSplit"];
  return {
    account: account("instagram", externalAccountId),
    imported: {
      provider: "instagram" as const,
      providerAccountId: externalAccountId,
      importedAt: new Date().toISOString(),
      window: { startDate: "2026-06-19", endDate: "2026-07-19" },
      followers: { value: 10_000 },
      contentCount: { value: 4 },
      likes: { value: 1_000 },
      comments: { value: 100 },
      shares: { value: 100 },
      reach: { value: 40_000 },
      views: { value: 50_000 },
      demographics: missingDemographics
        ? { countries: unavailable, ageGroups: unavailable, genders: unavailable }
        : {
            countries: { value: { US: 100 } },
            ageGroups: { value: { "25-34": 100 } },
            genders: { value: { female: 60, male: 40 } },
          },
      providerMetrics: { totalLikes: 12_345 },
    },
    engagementRate: 3,
    capabilities: [
      "followerCount",
      "contentItemCount",
      "likes",
      "comments",
      "shares",
      "reach",
      "views",
      "engagementRate",
      "audienceCountries",
      "audienceAgeGroups",
      "audienceGenderSplit",
    ],
    importedFields: [
      "followerCount",
      "contentItemCount",
      "likes",
      "comments",
      "shares",
      "reach",
      "views",
      "engagementRate",
      ...demographicFields,
    ],
    unavailableFields: missingDemographics
      ? [
          { field: "audienceCountries", reason: "privacy_threshold" },
          { field: "audienceAgeGroups", reason: "privacy_threshold" },
          { field: "audienceGenderSplit", reason: "privacy_threshold" },
        ]
      : [],
  };
}

function buildCreatorPlatformApp(
  repository: ReturnType<typeof connectionRepository>,
  adapters: CreatorPlatformAdapter[],
  credentialVault = createMemoryProviderCredentialVault(),
  logger: false | { level: string; stream: { write(line: string): void } } = false,
  callbackBaseUrl = "https://creator.api.example",
): FastifyInstance {
  return buildApp({
    logger,
    marketplaceCreatorSelfServiceRepository: profileRepository(),
    identityLifecycleCommandBus: lifecycleCommandBus(),
    marketplaceCreatorPlatformConnections: {
      repository,
      credentialVault,
      adapters: createCreatorPlatformAdapterRegistry(adapters),
      callbackBaseUrl,
      webReturnUrl: "https://marketplace.example/profile/complete",
      credentialSecretPrefix: "vayada/test",
    },
    auth: {
      verifier: createFakeVerifier(new Map([["valid-token", session]])),
      repository: identityRepository(),
      propertyAccessRepository: agencyPropertyAccessRepository,
      rolePermissionRepository: {
        async findPermissionsForRole() {
          return ["marketplace.profile.manage"];
        },
      },
    },
  });
}

function connectionRepository(
  overrides: {
    createAuthorization?: boolean;
    consumeAuthorization?: ReturnType<typeof authorizationRecord> | null;
    authorization?: ReturnType<typeof authorizationRecord> | null;
    actorAuthorized?: boolean;
    claimAuthorizationAccount?: ReturnType<typeof authorizationRecord> | null;
    connection?: Awaited<
      ReturnType<MarketplaceCreatorPlatformConnectionRepository["getConnection"]>
    >;
    claimConnectionSync?: Awaited<
      ReturnType<MarketplaceCreatorPlatformConnectionRepository["claimConnectionSync"]>
    >;
    revokeResult?: { revoked: boolean };
    cleanupCandidates?: Array<{
      credentialRef: string;
      authorizationId: string;
      claimId: string;
    }>;
    listCredentialCleanupCandidates?: MarketplaceCreatorPlatformConnectionRepository["listCredentialCleanupCandidates"];
    close?: () => Promise<void>;
  } = {},
) {
  return {
    createAuthorization: vi.fn(async () => overrides.createAuthorization ?? true),
    consumeAuthorization: vi.fn(async () => overrides.consumeAuthorization ?? null),
    setAuthorizationCandidates: vi.fn(async () => true),
    failAuthorization: vi.fn(async () => true),
    getPendingAuthorization: vi.fn(async () => overrides.authorization ?? null),
    getAuthorization: vi.fn(async () => overrides.authorization ?? null),
    claimAuthorizationAccount: vi.fn(async () => {
      if ("claimAuthorizationAccount" in overrides) {
        return overrides.claimAuthorizationAccount ?? null;
      }
      return overrides.authorization
        ? { ...overrides.authorization, status: "processing" as const }
        : null;
    }),
    releaseAuthorizationAccountClaim: vi.fn(async () => undefined),
    isAuthorizationActorAuthorized: vi.fn(async () => overrides.actorAuthorized ?? true),
    completeConnection: vi.fn(async ({ authorization }) =>
      connectionDocument(authorization.platform),
    ),
    listConnections: vi.fn(async () => []),
    getConnection: vi.fn(async () => overrides.connection ?? null),
    claimConnectionSync: vi.fn(async ({ leaseId }) => {
      if ("claimConnectionSync" in overrides) return overrides.claimConnectionSync ?? null;
      return overrides.connection ? { ...overrides.connection, syncLeaseId: leaseId } : null;
    }),
    releaseConnectionSync: vi.fn(async () => undefined),
    updateConnectionFromImport: vi.fn(async ({ connection }) => connection),
    markConnectionError: vi.fn(async () => undefined),
    revokeConnection: vi.fn(
      async () =>
        overrides.revokeResult ?? {
          revoked: true,
        },
    ),
    recordRevocationError: vi.fn(async () => undefined),
    queueCredentialCleanup: vi.fn(async () => undefined),
    listCredentialCleanupCandidates: vi.fn(
      overrides.listCredentialCleanupCandidates ?? (async () => overrides.cleanupCandidates ?? []),
    ),
    markCredentialCleaned: vi.fn(async () => undefined),
    recordCredentialCleanupFailure: vi.fn(async () => undefined),
    close: vi.fn(overrides.close ?? (async () => undefined)),
  } satisfies MarketplaceCreatorPlatformConnectionRepository;
}

function creatorPlatformAdapter(
  provider: CreatorPlatformGrant["provider"],
  accounts: CreatorPlatformAccount[] = [account(provider, `${provider}-account`)],
  unsupportedDemographics = false,
): CreatorPlatformAdapter {
  return {
    provider,
    buildAuthorizationUrl(state, redirectUri) {
      const url = new URL("https://provider.example/oauth");
      url.searchParams.set("state", state);
      url.searchParams.set("redirect_uri", redirectUri);
      return url.toString();
    },
    async exchangeCode() {
      return creatorGrant(provider);
    },
    async listAccounts(grant) {
      return { accounts, grant };
    },
    async importAccount(selectedAccount, _grant, window) {
      const unavailable = { value: null, unavailableReason: "not_supported" as const };
      return {
        provider,
        providerAccountId: selectedAccount.providerAccountId,
        importedAt: "2026-07-19T10:00:00.000Z",
        window,
        followers: { value: 10_000 },
        contentCount: { value: 4 },
        likes: { value: 1_000 },
        comments: { value: 100 },
        shares: { value: 100 },
        reach: { value: 40_000 },
        views: { value: 50_000 },
        demographics: unsupportedDemographics
          ? { countries: unavailable, ageGroups: unavailable, genders: unavailable }
          : {
              countries: { value: { DE: 50, US: 20, FR: 20, GB: 10 } },
              ageGroups: { value: { "13-17": 10, "55-64": 30, "65+": 20, "25-34": 40 } },
              genders: { value: { female: 60, male: 40 } },
            },
      };
    },
  };
}

function creatorGrant(provider: CreatorPlatformGrant["provider"]): CreatorPlatformGrant {
  if (provider === "tiktok") {
    return {
      provider,
      accessToken: "provider-secret",
      refreshToken: "refresh-secret",
      refreshExpiresAt: "2027-07-19T10:00:00.000Z",
      openId: "tiktok-user",
      scopes: ["user.info.stats"],
    };
  }
  if (provider === "facebook") {
    return {
      provider,
      accessToken: "provider-secret",
      pageAccessTokens: {},
      scopes: ["read_insights"],
    };
  }
  return { provider, accessToken: "provider-secret", scopes: ["stats.read"] };
}

function account(
  provider: CreatorPlatformGrant["provider"],
  providerAccountId: string,
): CreatorPlatformAccount {
  return {
    provider,
    providerAccountId,
    displayName: `${provider} creator`,
    username: `${provider}_creator`,
    profileUrl: `https://${provider}.example/creator`,
    accountType: provider === "facebook" ? "page" : provider === "youtube" ? "channel" : "profile",
  };
}

function authorizationRecord(
  platform: CreatorPlatformGrant["provider"],
  overrides: Record<string, unknown> = {},
) {
  return {
    authorizationId: "auth-1",
    creatorProfileId: profileId,
    organizationId,
    actorUserId,
    platform,
    provider:
      platform === "instagram" || platform === "facebook"
        ? ("meta" as const)
        : platform === "youtube"
          ? ("google" as const)
          : ("tiktok" as const),
    targetPlatformId: null,
    status: "authorizing" as const,
    credentialRef: null,
    candidates: [],
    expiresAt: "2026-07-19T10:10:00.000Z",
    ...overrides,
  };
}

function connectionDocument(platform: CreatorPlatformGrant["provider"]) {
  return {
    connectionId: "connection-1",
    platformId: "platform-1",
    platform,
    provider:
      platform === "instagram" || platform === "facebook"
        ? ("meta" as const)
        : platform === "youtube"
          ? ("google" as const)
          : ("tiktok" as const),
    externalAccountId: `${platform}-account`,
    status: "active" as const,
    capabilities: ["followerCount" as const],
    importedFields: ["followerCount" as const],
    unavailableFields: [],
    lastSyncAttemptAt: "2026-07-19T10:00:00.000Z",
    lastSuccessfulSyncAt: "2026-07-19T10:00:00.000Z",
    lastErrorCode: null,
  };
}

function profileRepository(): MarketplaceCreatorSelfServiceRepository {
  return {
    async ensureCreatorProfile() {
      return { creatorProfileId: profileId };
    },
    async getCreatorProfile() {
      return null;
    },
    async updateCreatorProfile() {
      return null;
    },
  };
}

function lifecycleCommandBus(): IdentityLifecycleCommandBus {
  return {
    async execute(command) {
      return {
        status: "accepted",
        commandId: command.commandId,
        idempotencyKey: command.idempotencyKey,
        events: [],
      };
    },
  };
}

function identityRepository(): IdentityRepository {
  return {
    async findUserByProviderUserId() {
      return { userId: actorUserId, email: "creator@example.com", status: "active" };
    },
    async findOrganizationByWorkosOrgId() {
      return {
        organizationId,
        workosOrgId: session.workosOrgId ?? null,
        name: "Creator Workspace",
        kind: "creator_workspace",
        status: "active",
      };
    },
    async findActiveMembership() {
      return {
        membershipId: "membership-1",
        status: "active",
        roleKey: "creator_owner",
        workosMembershipId: "workos-membership",
        workosRoleSlugs: ["creator_owner"],
      };
    },
    async findLinkedResources() {
      return [
        {
          product: "marketplace",
          resourceType: "creator_profile",
          resourceId: profileId,
          relationship: "owner",
          status: "active",
        },
      ];
    },
  };
}
