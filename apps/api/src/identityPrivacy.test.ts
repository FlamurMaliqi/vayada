import {
  createFakeVerifier,
  type IdentityRepository,
  type VerifiedSession,
} from "@vayada/backend-auth";
import { injectJson } from "@vayada/backend-test";
import { afterEach, describe, expect, it } from "vitest";

import { buildApp } from "./app.js";
import { agencyPropertyAccessRepository } from "./testAuthorization.js";
import type {
  CookieConsentResponse,
  GdprDeletionRequestResponse,
  GdprExportRequestResponse,
  IdentityPrivacyRepository,
  UpdateMarketingConsentResponse,
} from "./routes/identityPrivacy.js";

const session: VerifiedSession = {
  workosUserId: "user_workos_privacy",
  workosOrgId: "org_workos_creator",
  sessionId: "session_privacy",
  expiresAt: Math.floor(Date.now() / 1000) + 3600,
};

const identityRepository: IdentityRepository = {
  async findUserByProviderUserId() {
    return {
      userId: "user_privacy",
      email: "privacy@example.com",
      status: "active",
    };
  },
  async findOrganizationByWorkosOrgId() {
    return {
      organizationId: "org_creator",
      workosOrgId: "org_workos_creator",
      kind: "creator_workspace",
      status: "active",
    };
  },
  async findActiveMembership() {
    return {
      membershipId: "membership_creator",
      status: "active",
      roleKey: "creator_owner",
      workosMembershipId: null,
      workosRoleSlugs: ["creator_owner"],
    };
  },
  async findLinkedResources() {
    return [];
  },
};

describe("identity privacy routes", () => {
  let app: ReturnType<typeof buildApp> | undefined;

  afterEach(async () => {
    await app?.close();
  });

  it("rejects malformed public identifiers and coerced cookie choices", async () => {
    app = buildApp({
      logger: false,
      identityPrivacyRepository: createMemoryIdentityPrivacyRepository(),
    });
    const valid = {
      visitor_id: "visitor_001",
      functional: false,
      analytics: false,
      marketing: false,
    };
    for (const fields of [
      { visitor_id: 1 },
      { visitor_id: " " },
      { visitor_id: "a".repeat(129) },
      { visitor_id: "../tenant" },
      { analytics: "false" },
      { functional: 0 },
      { marketing: null },
      { necessary: false },
    ]) {
      expect(
        (
          await app.inject({
            method: "POST",
            url: "/api/identity/consent/cookies",
            payload: { ...valid, ...fields },
          })
        ).statusCode,
      ).toBe(422);
    }
    for (const visitorId of ["a".repeat(129), "../tenant", " "]) {
      expect(
        (
          await app.inject({
            method: "GET",
            url: `/api/identity/consent/cookies?visitor_id=${encodeURIComponent(visitorId)}`,
          })
        ).statusCode,
      ).toBe(422);
    }
    const saved = await app.inject({
      method: "POST",
      url: "/api/identity/consent/cookies",
      payload: { ...valid, user_id: "other-account" },
    });
    expect(saved.statusCode).toBe(200);
    expect(saved.json().user_id).toBeNull();
  });

  it("stores and reads public cookie consent through identity-owned routes", async () => {
    const repository = createMemoryIdentityPrivacyRepository();
    app = buildApp({
      logger: false,
      identityPrivacyRepository: repository,
      identityPrivacyAllowedOrigins: ["https://landing.localhost"],
    });

    const saved = await injectJson<CookieConsentResponse>(app, {
      method: "POST",
      url: "/api/identity/consent/cookies",
      headers: { origin: "https://landing.localhost" },
      payload: {
        visitor_id: "visitor_001",
        necessary: true,
        functional: true,
        analytics: false,
        marketing: true,
      },
    });

    expect(saved.statusCode).toBe(200);
    expect(saved.body).toMatchObject({
      visitor_id: "visitor_001",
      necessary: true,
      functional: true,
      analytics: false,
      marketing: true,
    });

    const loaded = await injectJson<CookieConsentResponse>(app, {
      method: "GET",
      url: "/api/identity/consent/cookies?visitor_id=visitor_001",
    });

    expect(loaded.body.id).toBe(saved.body.id);
  });

  it("updates authenticated marketing consent and records history", async () => {
    const repository = createMemoryIdentityPrivacyRepository();
    app = buildAuthedPrivacyApp(repository);

    const response = await injectJson<UpdateMarketingConsentResponse>(app, {
      method: "PUT",
      url: "/api/identity/consent/me",
      headers: { authorization: "Bearer valid-token" },
      payload: { marketing_consent: true },
    });

    expect(response.statusCode).toBe(200);
    expect(response.body.marketing_consent).toBe(true);

    const history = await injectJson<{ total: number }>(app, {
      method: "GET",
      url: "/api/identity/consent/history",
      headers: { authorization: "Bearer valid-token" },
    });

    expect(history.body.total).toBe(1);
  });

  it("creates an authenticated GDPR deletion request", async () => {
    const repository = createMemoryIdentityPrivacyRepository();
    app = buildAuthedPrivacyApp(repository);

    const response = await injectJson<GdprDeletionRequestResponse>(app, {
      method: "POST",
      url: "/api/identity/gdpr/delete-request",
      headers: { authorization: "Bearer valid-token" },
    });

    expect(response.statusCode).toBe(201);
    expect(response.body.status).toBe("pending");
    expect(response.body.scheduled_deletion_at).toBeTruthy();
  });

  it("returns a completed GDPR export with a download token", async () => {
    const repository = createMemoryIdentityPrivacyRepository();
    app = buildAuthedPrivacyApp(repository);

    const response = await injectJson<GdprExportRequestResponse>(app, {
      method: "POST",
      url: "/api/identity/gdpr/export-request",
      headers: { authorization: "Bearer valid-token" },
    });

    expect(response.statusCode).toBe(201);
    expect(response.body.status).toBe("completed");
    expect(response.body.download_token).toBeTruthy();

    const status = await injectJson<{ download_token?: string | null }>(app, {
      method: "GET",
      url: "/api/identity/gdpr/export-status",
      headers: { authorization: "Bearer valid-token" },
    });

    expect(status.body.download_token).toBe(response.body.download_token);
  });
});

function buildAuthedPrivacyApp(repository: IdentityPrivacyRepository): ReturnType<typeof buildApp> {
  return buildApp({
    logger: false,
    identityPrivacyRepository: repository,
    auth: {
      verifier: createFakeVerifier(new Map([["valid-token", session]])),
      repository: identityRepository,
      propertyAccessRepository: agencyPropertyAccessRepository,
      rolePermissionRepository: {
        async findPermissionsForRole() {
          return ["marketplace.profile.manage"];
        },
      },
    },
  });
}

function createMemoryIdentityPrivacyRepository(): IdentityPrivacyRepository {
  const cookies = new Map<string, CookieConsentResponse>();
  const history: Array<{ userId: string; id: string }> = [];
  const exportRequests = new Map<
    string,
    {
      id: string;
      token: string;
      expiresAt: string;
    }
  >();
  return {
    async upsertCookieConsent(input) {
      const existing = cookies.get(input.visitorId);
      const now = new Date().toISOString();
      const response: CookieConsentResponse = {
        id: existing?.id ?? `cookie_${cookies.size + 1}`,
        visitor_id: input.visitorId,
        user_id: null,
        necessary: true,
        functional: input.functional,
        analytics: input.analytics,
        marketing: input.marketing,
        created_at: existing?.created_at ?? now,
        updated_at: now,
      };
      cookies.set(input.visitorId, response);
      return response;
    },
    async findCookieConsent(visitorId) {
      return cookies.get(visitorId) ?? null;
    },
    async getConsentStatus(userId) {
      return {
        terms_accepted: false,
        terms_accepted_at: null,
        terms_version: null,
        privacy_accepted: false,
        privacy_accepted_at: null,
        privacy_version: null,
        marketing_consent: history.some((item) => item.userId === userId),
        marketing_consent_at: history.some((item) => item.userId === userId)
          ? "2026-06-12T10:00:00.000Z"
          : null,
      };
    },
    async updateMarketingConsent(input) {
      history.push({ userId: input.userId, id: randomId() });
      return {
        marketing_consent: input.marketingConsent,
        marketing_consent_at: "2026-06-12T10:00:00.000Z",
        message: "Marketing consent given successfully",
      };
    },
    async listConsentHistory(input) {
      return {
        history: history
          .filter((item) => item.userId === input.userId)
          .map((item) => ({
            id: item.id,
            consent_type: "marketing",
            consent_given: true,
            version: null,
            created_at: "2026-06-12T10:00:00.000Z",
          })),
        total: history.filter((item) => item.userId === input.userId).length,
      };
    },
    async createGdprExportRequest(input) {
      const id = randomId();
      exportRequests.set(input.userId, {
        id,
        token: input.downloadToken,
        expiresAt: input.expiresAt,
      });
      return {
        id,
        status: "completed",
        requested_at: "2026-06-12T10:00:00.000Z",
        expires_at: input.expiresAt,
        download_token: input.downloadToken,
        message: "Your data export is ready for download.",
      };
    },
    async findLatestGdprRequest(userId, requestType) {
      const exportRequest = exportRequests.get(userId);
      return {
        id: exportRequest?.id ?? `${requestType}_${userId}`,
        request_type: requestType,
        status: requestType === "export" && exportRequest ? "completed" : "pending",
        requested_at: "2026-06-12T10:00:00.000Z",
        processed_at: requestType === "export" && exportRequest ? "2026-06-12T10:00:00.000Z" : null,
        expires_at: exportRequest?.expiresAt ?? "2026-07-12T10:00:00.000Z",
        download_token: requestType === "export" ? (exportRequest?.token ?? null) : null,
      };
    },
    async findGdprExportByToken(input) {
      return {
        id: `export_${input.userId}`,
        request_type: "export",
        status: "completed",
        requested_at: "2026-06-12T10:00:00.000Z",
        processed_at: "2026-06-12T10:01:00.000Z",
        expires_at: "2026-06-19T10:00:00.000Z",
      };
    },
    async collectExportData(userId) {
      return { user: { id: userId } };
    },
    async createGdprDeletionRequest(input) {
      return {
        id: randomId(),
        status: "pending",
        requested_at: "2026-06-12T10:00:00.000Z",
        scheduled_deletion_at: input.scheduledDeletionAt,
        message: "Your account deletion request has been received.",
      };
    },
    async cancelGdprDeletionRequest() {
      return true;
    },
  };
}

function randomId(): string {
  return `id_${Math.random().toString(36).slice(2)}`;
}
