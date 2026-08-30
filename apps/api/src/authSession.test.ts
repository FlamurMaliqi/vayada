import type {
  IdentityLifecycleCommand,
  IdentityLifecycleCommandBus,
  IdentityRepository,
  IdentityUser,
  TokenVerifier,
} from "@vayada/backend-auth";
import type {
  MembershipPropertyScope,
  PropertyAccessRepository,
} from "@vayada/backend-authorization";
import { afterEach, describe, expect, it, vi } from "vitest";

import { buildApp } from "./app.js";
import type {
  AuthKitClient,
  AuthKitSession,
  AuthSurface,
  AuthSurfacePolicy,
  ProductAuditEvent,
} from "./routes/authSession.js";
import type {
  AuthSessionHandoff,
  AuthSessionHandoffRepository,
} from "./platform/authSessionHandoffs.js";
import type { ApprovedPublicProfileImageRepository } from "./routes/platformMedia.js";
import type { HotelAccountInviteRepository } from "./routes/hotelAccountInvites.js";

const user: IdentityUser = {
  userId: "user_platform_admin",
  email: "f.maliqi@vayada.com",
  name: "Admin Example",
  phone: "+49 89 123456",
  status: "active",
};

const session: AuthKitSession = {
  accessToken: "workos-access-token",
  sealedSession: "sealed-session",
  sessionId: "session_workos",
  organizationId: "org_workos_platform",
  user: {
    id: "user_workos_platform",
    email: "f.maliqi@vayada.com",
    emailVerified: true,
    name: "Admin Example",
  },
};

const handoffHotelSession: AuthKitSession = {
  ...session,
  accessToken: "hotel-workos-access-token",
  sealedSession: "hotel-sealed-session",
  organizationId: "org_workos_hotel_group",
  user: {
    ...session.user,
    id: "user_workos_hotel",
    email: "owner@alpenrose.example",
  },
};

describe("AuthKit session routes", () => {
  let app: ReturnType<typeof buildApp> | undefined;

  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  it.each(["/auth/workos/login", "/auth/workos/signup", "/auth/workos/callback"])(
    "does not expose hosted AuthKit route %s",
    async (url) => {
      app = buildAuthSessionApp();

      const response = await app.inject({
        method: "GET",
        url,
      });

      expect(response.statusCode).toBe(404);
    },
  );

  it("keeps legacy password register absent from next-api", async () => {
    app = buildAuthSessionApp();

    const response = await app.inject({
      method: "POST",
      url: "/auth/register",
    });

    expect(response.statusCode).toBe(404);
  });

  it("logs in with email and password through WorkOS and creates the AuthKit browser session", async () => {
    const auditEvents: ProductAuditEvent[] = [];
    let passwordAuthInput: Parameters<AuthKitClient["authenticateWithPassword"]>[0] | undefined;
    const marketplaceSession: AuthKitSession = {
      ...session,
      accessToken: "creator-workos-access-token",
      sealedSession: "creator-sealed-session",
      organizationId: "org_workos_creator",
      user: {
        ...session.user,
        id: "user_workos_creator",
        email: "creator@example.test",
      },
    };
    app = buildAuthSessionApp({
      allowedOrigins: ["https://marketplace.localhost"],
      cookieSecure: true,
      authKitClient: createAuthKitClient({
        async authenticateWithPassword(input) {
          passwordAuthInput = input;
          return marketplaceSession;
        },
      }),
      identityRepository: createIdentityRepository({
        userByProviderUserId: async () => ({
          userId: "user_creator",
          email: "creator@example.test",
          name: "Creator Example",
          phone: "+49 30 123456",
          profilePictureUrl: "https://media.example/creator.webp",
          profilePictureMediaObjectId: "media_creator_profile",
          status: "active",
        }),
        organizationByWorkosOrgId: async () => ({
          organizationId: "org_creator",
          workosOrgId: "org_workos_creator",
          name: "Creator Workspace",
          kind: "creator_workspace",
          status: "active",
        }),
        activeMembership: async () => ({
          membershipId: "membership_creator",
          status: "active",
          roleKey: "creator_owner",
          workosMembershipId: "om_creator",
          workosRoleSlugs: ["creator_owner"],
        }),
      }),
      surfacePolicies: {
        "marketplace-web": {
          requiredOrganizationKind: ["creator_workspace", "hotel_group"],
          publicOrigin: "https://marketplace.localhost",
          firstPartySession: true,
        },
      },
      productAuditSink: {
        async record(event) {
          auditEvents.push(event);
        },
      },
    });

    const response = await app.inject({
      method: "POST",
      url: "/auth/password/login",
      headers: {
        origin: "https://marketplace.localhost",
        "user-agent": "vitest",
      },
      payload: {
        email: " creator@example.test ",
        password: "correct-password",
        surface: "marketplace-web",
      },
    });

    expect(response.statusCode).toBe(200);
    expect(passwordAuthInput).toMatchObject({
      email: "creator@example.test",
      password: "correct-password",
      userAgent: "vitest",
      ipAddress: expect.any(String),
    });
    expect(response.json()).toMatchObject({
      accessToken: "creator-workos-access-token",
      csrfToken: expect.any(String),
      organizationId: "org_creator",
      workosOrganizationId: "org_workos_creator",
      organizationKind: "creator_workspace",
      user: {
        id: "user_creator",
        email: "creator@example.test",
        name: "Creator Example",
        phone: "+49 30 123456",
        profilePictureUrl: "https://media.example/creator.webp",
        profilePictureMediaObjectId: "media_creator_profile",
        workosUserId: "user_workos_creator",
      },
    });
    expect(response.json()).not.toHaveProperty("sealedSession");
    expect(response.json()).not.toHaveProperty("clientSecret");
    expect(response.headers["set-cookie"]).toEqual(
      expect.arrayContaining([
        expect.stringContaining("vayada_fp_workos_session=creator-sealed-session"),
        expect.stringContaining("vayada_fp_auth_csrf="),
      ]),
    );
    expect(auditEvents).toEqual([
      expect.objectContaining({
        action: "auth.login",
        authFlow: "login",
        actorUserId: "user_creator",
        organizationId: "org_creator",
        surface: "marketplace-web",
        workosUserId: "user_workos_creator",
      }),
    ]);
  });

  it("selects the configured platform organization when WorkOS requires a workspace", async () => {
    let selectionInput:
      | Parameters<AuthKitClient["authenticateWithOrganizationSelection"]>[0]
      | undefined;
    app = buildAuthSessionApp({
      authKitClient: createAuthKitClient({
        async authenticateWithPassword() {
          throw {
            code: "organization_selection_required",
            pending_authentication_token: "pending_platform_selection",
            organizations: [
              { id: "org_workos_hotel_group", name: "Hotel Group" },
              { id: "org_workos_platform", name: "Vayada Platform" },
            ],
          };
        },
        async authenticateWithOrganizationSelection(input) {
          selectionInput = input;
          return session;
        },
      }),
    });

    const response = await app.inject({
      method: "POST",
      url: "/auth/password/login",
      headers: {
        origin: "https://admin.localhost",
        "user-agent": "vitest",
      },
      payload: {
        email: "f.maliqi@vayada.com",
        password: "correct-password",
        surface: "platform-admin",
        organizationId: "org_workos_platform",
      },
    });

    expect(response.statusCode).toBe(200);
    expect(selectionInput).toEqual({
      organizationId: "org_workos_platform",
      pendingAuthenticationToken: "pending_platform_selection",
      ipAddress: expect.any(String),
      userAgent: "vitest",
    });
    expect(response.json()).toMatchObject({
      organizationId: "org_platform",
      workosOrganizationId: "org_workos_platform",
      organizationKind: "platform",
    });
  });

  it("does not select a platform organization that WorkOS did not offer", async () => {
    const authenticateWithOrganizationSelection = vi.fn();
    app = buildAuthSessionApp({
      authKitClient: createAuthKitClient({
        async authenticateWithPassword() {
          throw {
            code: "organization_selection_required",
            pending_authentication_token: "pending_platform_selection",
            organizations: [{ id: "org_workos_hotel_group", name: "Hotel Group" }],
          };
        },
        authenticateWithOrganizationSelection,
      }),
    });

    const response = await app.inject({
      method: "POST",
      url: "/auth/password/login",
      headers: { origin: "https://admin.localhost" },
      payload: {
        email: "f.maliqi@vayada.com",
        password: "correct-password",
        surface: "platform-admin",
        organizationId: "org_workos_platform",
      },
    });

    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({ state: "organization_selection_required" });
    expect(authenticateWithOrganizationSelection).not.toHaveBeenCalled();
  });

  it("starts Google OAuth with a signed callback state", async () => {
    let authorizationInput: Parameters<AuthKitClient["getAuthorizationUrl"]>[0] | undefined;
    app = buildAuthSessionApp({
      allowedOrigins: ["https://marketplace.localhost"],
      surfacePolicies: {
        "marketplace-web": {
          requiredOrganizationKind: ["creator_workspace", "hotel_group"],
        },
      },
      authKitClient: createAuthKitClient({
        getAuthorizationUrl(input) {
          authorizationInput = input;
          return `https://auth.workos.test/google?state=${encodeURIComponent(input.state)}`;
        },
      }),
    });

    const response = await app.inject({
      method: "GET",
      url:
        "/auth/oauth/google/start?surface=marketplace-web&flow=login" +
        "&return_to=https%3A%2F%2Fmarketplace.localhost%2Flogin%3Fauth%3Dcallback" +
        "&error_return_to=https%3A%2F%2Fmarketplace.localhost%2Flogin",
      headers: { host: "api.localhost", "x-forwarded-proto": "https" },
    });

    expect(response.statusCode).toBe(302);
    expect(response.headers.location).toContain("https://auth.workos.test/google");
    expect(String(response.headers["set-cookie"])).toContain("vayada_oauth_state=");
    expect(authorizationInput).toMatchObject({
      provider: "GoogleOAuth",
      redirectUri: "https://api.localhost/auth/oauth/google/callback",
    });
  });

  it.each([
    ["platform-admin", "https://admin.localhost"],
    ["marketplace-web", "https://marketplace.localhost"],
    ["booking-admin", "https://admin.booking.localhost"],
    ["pms-web", "https://pms.localhost"],
    ["affiliate-dashboard", "https://affiliate.localhost"],
  ] as const)("uses the configured first-party callback for %s", async (surface, publicOrigin) => {
    let authorizationInput: Parameters<AuthKitClient["getAuthorizationUrl"]>[0] | undefined;
    app = buildAuthSessionApp({
      allowedOrigins: [publicOrigin],
      cookieSecure: true,
      authKitClient: createAuthKitClient({
        getAuthorizationUrl(input) {
          authorizationInput = input;
          return "https://auth.workos.test/google";
        },
      }),
      surfacePolicies: {
        [surface]: {
          requiredOrganizationKind: "platform",
          publicOrigin,
          firstPartySession: true,
        },
      },
    });

    const url = new URL(publicOrigin);
    const response = await app.inject({
      method: "GET",
      url:
        `/auth/oauth/google/start?surface=${surface}&flow=login` +
        `&return_to=${encodeURIComponent(`${publicOrigin}/login?auth=callback`)}` +
        `&error_return_to=${encodeURIComponent(`${publicOrigin}/login`)}`,
      headers: {
        "x-forwarded-host": `${url.host}, attacker.example`,
        "x-forwarded-proto": `${url.protocol.slice(0, -1)}, http`,
      },
    });

    expect(response.statusCode).toBe(302);
    expect(authorizationInput?.redirectUri).toBe(`${publicOrigin}/auth/oauth/google/callback`);
    const stateCookie = (response.headers["set-cookie"] as string[]).find((value) =>
      value.startsWith("vayada_fp_oauth_state="),
    );
    expect(stateCookie).toContain("Path=/auth");
    expect(stateCookie).toContain("SameSite=Lax");
    expect(stateCookie).toContain("HttpOnly");
    expect(stateCookie).toContain("Secure");
    expect(stateCookie).not.toContain("Domain=");
  });

  it.each([
    { host: "attacker.example", proto: "https" },
    { host: "api.localhost", proto: "javascript" },
    { host: "attacker.example, api.localhost", proto: "https, http" },
  ])("rejects untrusted forwarded callback origin $host/$proto", async ({ host, proto }) => {
    const getAuthorizationUrl = vi.fn(() => "https://auth.workos.test/google");
    app = buildAuthSessionApp({
      allowedOrigins: ["https://marketplace.localhost"],
      authKitClient: createAuthKitClient({ getAuthorizationUrl }),
      surfacePolicies: {
        "marketplace-web": {
          requiredOrganizationKind: ["creator_workspace", "hotel_group"],
          publicOrigin: "https://marketplace.localhost",
          firstPartySession: true,
        },
      },
    });

    const response = await app.inject({
      method: "GET",
      url:
        "/auth/oauth/google/start?surface=marketplace-web&flow=login" +
        "&return_to=https%3A%2F%2Fmarketplace.localhost%2Flogin" +
        "&error_return_to=https%3A%2F%2Fmarketplace.localhost%2Flogin",
      headers: { "x-forwarded-host": host, "x-forwarded-proto": proto },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ error: "invalid_callback_origin" });
    expect(getAuthorizationUrl).not.toHaveBeenCalled();
  });

  it("rejects a callback delivered through the wrong public origin", async () => {
    let state = "";
    const authenticateWithCode = vi.fn(async () => session);
    app = buildAuthSessionApp({
      allowedOrigins: ["https://marketplace.localhost"],
      authKitClient: createAuthKitClient({
        getAuthorizationUrl(input) {
          state = input.state;
          return "https://auth.workos.test/google";
        },
        authenticateWithCode,
      }),
      surfacePolicies: {
        "marketplace-web": {
          requiredOrganizationKind: ["creator_workspace", "hotel_group"],
          publicOrigin: "https://marketplace.localhost",
          firstPartySession: true,
        },
      },
    });
    const start = await app.inject({
      method: "GET",
      url:
        "/auth/oauth/google/start?surface=marketplace-web&flow=login" +
        "&return_to=https%3A%2F%2Fmarketplace.localhost%2Flogin" +
        "&error_return_to=https%3A%2F%2Fmarketplace.localhost%2Flogin",
      headers: {
        "x-forwarded-host": "marketplace.localhost",
        "x-forwarded-proto": "https",
      },
    });
    const callback = await app.inject({
      method: "GET",
      url: `/auth/oauth/google/callback?code=google-code&state=${encodeURIComponent(state)}`,
      headers: {
        cookie: cookieHeader(start, "vayada_fp_oauth_state"),
        "x-forwarded-host": "attacker.example",
        "x-forwarded-proto": "https",
      },
    });

    expect(callback.statusCode).toBe(400);
    expect(callback.json()).toEqual({ error: "invalid_callback_origin" });
    expect(authenticateWithCode).not.toHaveBeenCalled();
  });

  it("uses host-only HttpOnly cookies and response CSRF tokens in first-party mode", async () => {
    app = buildAuthSessionApp({
      cookieSecure: true,
      cookieDomain: ".localhost",
      surfacePolicies: {
        "platform-admin": {
          requiredOrganizationKind: "platform",
          publicOrigin: "https://admin.localhost",
          firstPartySession: true,
        },
      },
    });

    const login = await app.inject({
      method: "POST",
      url: "/auth/password/login",
      headers: { origin: "https://admin.localhost" },
      payload: {
        email: "f.maliqi@vayada.com",
        password: "correct-password",
        surface: "platform-admin",
      },
    });

    expect(login.statusCode).toBe(200);
    const csrfToken = login.json().csrfToken as string;
    expect(csrfToken).toEqual(expect.any(String));
    const loginCookies = login.headers["set-cookie"] as string[];
    for (const [activeCookieName, legacyCookieName] of [
      ["vayada_fp_workos_session", "vayada_workos_session"],
      ["vayada_fp_auth_csrf", "vayada_auth_csrf"],
    ]) {
      const cookie = loginCookies.find(
        (value) => value.startsWith(`${activeCookieName}=`) && !value.includes("Domain="),
      );
      const legacyCleanup = loginCookies.find(
        (value) => value.startsWith(`${legacyCookieName}=`) && value.includes("Domain=.localhost"),
      );
      expect(cookie).toContain("Path=/auth");
      expect(cookie).toContain("SameSite=Lax");
      expect(cookie).toContain("HttpOnly");
      expect(cookie).toContain("Secure");
      expect(cookie).not.toContain("Domain=");
      expect(legacyCleanup).toContain("Max-Age=0");
    }

    const refresh = await app.inject({
      method: "POST",
      url: "/auth/session/refresh",
      headers: {
        cookie: [
          cookieHeader(login, "vayada_fp_workos_session"),
          cookieHeader(login, "vayada_fp_auth_csrf"),
        ].join("; "),
        origin: "https://admin.localhost",
        "x-vayada-csrf": csrfToken,
      },
      payload: { surface: "platform-admin" },
    });

    expect(refresh.statusCode).toBe(200);
    expect(refresh.json().csrfToken).toBe(csrfToken);
  });

  it("preserves cross-origin cookie attributes in compatibility mode", async () => {
    app = buildAuthSessionApp({ cookieSecure: true, cookieDomain: ".localhost" });

    const response = await app.inject({
      method: "POST",
      url: "/auth/password/login",
      headers: { origin: "https://admin.localhost" },
      payload: {
        email: "f.maliqi@vayada.com",
        password: "correct-password",
        surface: "platform-admin",
      },
    });

    expect(response.statusCode).toBe(200);
    const sessionCookie = (response.headers["set-cookie"] as string[]).find((value) =>
      value.startsWith("vayada_workos_session="),
    );
    const csrfCookie = (response.headers["set-cookie"] as string[]).find((value) =>
      value.startsWith("vayada_auth_csrf="),
    );
    expect(sessionCookie).toContain("SameSite=None");
    expect(sessionCookie).toContain("HttpOnly");
    expect(sessionCookie).toContain("Secure");
    expect(sessionCookie).toContain("Domain=.localhost");
    expect(csrfCookie).toContain("SameSite=None");
    expect(csrfCookie).toContain("Secure");
    expect(csrfCookie).toContain("Domain=.localhost");
    expect(csrfCookie).not.toContain("HttpOnly");
  });

  it.each([
    [
      "legacy cookies first",
      "vayada_workos_session=legacy-domain-session; " +
        "vayada_auth_csrf=legacy-domain-csrf; " +
        "vayada_fp_workos_session=first-party-session; " +
        "vayada_fp_auth_csrf=first-party-csrf",
    ],
    [
      "legacy cookies last",
      "vayada_fp_workos_session=first-party-session; " +
        "vayada_fp_auth_csrf=first-party-csrf; " +
        "vayada_workos_session=newer-compatibility-session; " +
        "vayada_auth_csrf=newer-compatibility-csrf",
    ],
  ])("isolates first-party cookies with %s", async (_order, cookie) => {
    let authenticatedSealedSession = "";
    app = buildAuthSessionApp({
      cookieSecure: true,
      cookieDomain: ".localhost",
      authKitClient: createAuthKitClient({
        async authenticateSession(input) {
          authenticatedSealedSession = input.sealedSession;
          return { ...session, sealedSession: input.sealedSession };
        },
      }),
      surfacePolicies: {
        "platform-admin": {
          requiredOrganizationKind: "platform",
          publicOrigin: "https://admin.localhost",
          firstPartySession: true,
        },
      },
    });

    const response = await app.inject({
      method: "GET",
      url: "/auth/session?surface=platform-admin",
      headers: {
        cookie,
        origin: "https://admin.localhost",
      },
    });

    expect(response.statusCode).toBe(200);
    expect(authenticatedSealedSession).toBe("first-party-session");
    expect(response.json().csrfToken).toBe("first-party-csrf");
    expect(response.headers["set-cookie"]).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/^vayada_workos_session=;.*Max-Age=0.*Domain=\.localhost/),
        expect.stringMatching(/^vayada_auth_csrf=;.*Max-Age=0.*Domain=\.localhost/),
      ]),
    );
  });

  it("fails closed when active first-party session or CSRF cookies are duplicated", async () => {
    app = buildAuthSessionApp({
      cookieSecure: true,
      surfacePolicies: {
        "platform-admin": {
          requiredOrganizationKind: "platform",
          publicOrigin: "https://admin.localhost",
          firstPartySession: true,
        },
      },
    });

    const duplicateSession = await app.inject({
      method: "GET",
      url: "/auth/session?surface=platform-admin",
      headers: {
        cookie:
          "vayada_fp_workos_session=first-session; " + "vayada_fp_workos_session=second-session",
        origin: "https://admin.localhost",
      },
    });
    expect(duplicateSession.statusCode).toBe(401);
    expect(duplicateSession.json()).toEqual({ error: "missing_session" });

    const duplicateCsrf = await app.inject({
      method: "POST",
      url: "/auth/session/refresh",
      headers: {
        cookie:
          "vayada_fp_workos_session=sealed-session; " +
          "vayada_fp_auth_csrf=csrf-token; vayada_fp_auth_csrf=csrf-token",
        origin: "https://admin.localhost",
        "x-vayada-csrf": "csrf-token",
      },
      payload: { surface: "platform-admin" },
    });
    expect(duplicateCsrf.statusCode).toBe(403);
    expect(duplicateCsrf.json()).toEqual({ error: "csrf_rejected" });
  });

  it("fails closed when the active first-party OAuth-state cookie is duplicated", async () => {
    let state = "";
    const authenticateWithCode = vi.fn(async () => session);
    app = buildAuthSessionApp({
      allowedOrigins: ["https://marketplace.localhost"],
      cookieSecure: true,
      authKitClient: createAuthKitClient({
        getAuthorizationUrl(input) {
          state = input.state;
          return "https://auth.workos.test/google";
        },
        authenticateWithCode,
      }),
      surfacePolicies: {
        "marketplace-web": {
          requiredOrganizationKind: ["creator_workspace", "hotel_group"],
          publicOrigin: "https://marketplace.localhost",
          firstPartySession: true,
        },
      },
    });
    const forwardedHeaders = {
      "x-forwarded-host": "marketplace.localhost",
      "x-forwarded-proto": "https",
    };
    const start = await app.inject({
      method: "GET",
      url:
        "/auth/oauth/google/start?surface=marketplace-web&flow=login" +
        "&return_to=https%3A%2F%2Fmarketplace.localhost%2Flogin" +
        "&error_return_to=https%3A%2F%2Fmarketplace.localhost%2Flogin",
      headers: forwardedHeaders,
    });
    const stateCookie = cookieHeader(start, "vayada_fp_oauth_state");
    const callback = await app.inject({
      method: "GET",
      url: `/auth/oauth/google/callback?code=google-code&state=${encodeURIComponent(state)}`,
      headers: {
        ...forwardedHeaders,
        cookie: `${stateCookie}; ${stateCookie}`,
      },
    });

    expect(callback.statusCode).toBe(302);
    expect(callback.headers.location).toContain("auth_error=");
    expect(authenticateWithCode).not.toHaveBeenCalled();
  });

  it("logs in an existing marketplace account through Google OAuth callback", async () => {
    let state = "";
    const marketplaceSession: AuthKitSession = {
      ...session,
      accessToken: "google-workos-access-token",
      sealedSession: "google-sealed-session",
      organizationId: "org_workos_creator",
      user: {
        ...session.user,
        id: "user_workos_google_creator",
        email: "creator@example.test",
      },
    };
    app = buildAuthSessionApp({
      allowedOrigins: ["https://marketplace.localhost"],
      cookieSecure: true,
      cookieDomain: ".localhost",
      authKitClient: createAuthKitClient({
        getAuthorizationUrl(input) {
          state = input.state;
          return `https://auth.workos.test/google?state=${encodeURIComponent(input.state)}`;
        },
        async authenticateWithCode(input) {
          expect(input.code).toBe("google-code");
          return marketplaceSession;
        },
      }),
      identityRepository: createIdentityRepository({
        userByProviderUserId: async () => ({
          userId: "user_creator",
          email: "creator@example.test",
          status: "active",
        }),
        organizationByWorkosOrgId: async () => ({
          organizationId: "org_creator",
          workosOrgId: "org_workos_creator",
          name: "Creator Workspace",
          kind: "creator_workspace",
          status: "active",
        }),
        activeMembership: async () => ({
          membershipId: "membership_creator",
          status: "active",
          roleKey: "creator_owner",
          workosMembershipId: "om_creator",
          workosRoleSlugs: ["creator_owner"],
        }),
      }),
      surfacePolicies: {
        "marketplace-web": {
          requiredOrganizationKind: ["creator_workspace", "hotel_group"],
          publicOrigin: "https://marketplace.localhost",
          firstPartySession: true,
        },
      },
    });

    const start = await app.inject({
      method: "GET",
      url:
        "/auth/oauth/google/start?surface=marketplace-web&flow=login" +
        "&return_to=https%3A%2F%2Fmarketplace.localhost%2Flogin%3Fauth%3Dcallback" +
        "&error_return_to=https%3A%2F%2Fmarketplace.localhost%2Flogin",
      headers: {
        "x-forwarded-host": "marketplace.localhost",
        "x-forwarded-proto": "https",
      },
    });
    expect(start.headers["set-cookie"]).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/^vayada_oauth_state=;.*Max-Age=0.*Domain=\.localhost/),
      ]),
    );
    const callback = await app.inject({
      method: "GET",
      url: `/auth/oauth/google/callback?code=google-code&state=${encodeURIComponent(state)}`,
      headers: {
        cookie: cookieHeader(start, "vayada_fp_oauth_state"),
        "x-forwarded-host": "marketplace.localhost",
        "x-forwarded-proto": "https",
      },
    });

    expect(callback.statusCode).toBe(302);
    expect(callback.headers.location).toBe("https://marketplace.localhost/login?auth=callback");
    expect(callback.headers["set-cookie"]).toEqual(
      expect.arrayContaining([
        expect.stringContaining("vayada_fp_workos_session=google-sealed-session"),
        expect.stringContaining("vayada_fp_auth_csrf="),
      ]),
    );
    const restored = await app.inject({
      method: "GET",
      url: "/auth/session?surface=marketplace-web",
      headers: {
        cookie: [
          cookieHeader(callback, "vayada_fp_workos_session"),
          cookieHeader(callback, "vayada_fp_auth_csrf"),
        ].join("; "),
        origin: "https://marketplace.localhost",
      },
    });
    expect(restored.statusCode).toBe(200);
    expect(restored.json().csrfToken).toEqual(expect.any(String));
  });

  it("signs up a Google account and redirects to onboarding without product provisioning", async () => {
    const commands: IdentityLifecycleCommand[] = [];
    const workosCalls: string[] = [];
    let state = "";
    const googleSession: AuthKitSession = {
      ...session,
      accessToken: "google-signup-access-token",
      sealedSession: "google-signup-sealed-session",
      organizationId: undefined,
      user: {
        ...session.user,
        id: "user_workos_google_signup",
        email: "creator-google@example.test",
      },
    };
    app = buildAuthSessionApp({
      allowedOrigins: ["https://marketplace.localhost"],
      authKitClient: createAuthKitClient({
        getAuthorizationUrl(input) {
          state = input.state;
          return `https://auth.workos.test/google?state=${encodeURIComponent(input.state)}`;
        },
        async authenticateWithCode() {
          workosCalls.push("code");
          return googleSession;
        },
        async createSignupOrganization() {
          throw new Error("Product organization should be created by onboarding");
        },
        async ensureSignupOrganizationMembership() {
          throw new Error("Product membership should be created by onboarding");
        },
        async refreshSession() {
          throw new Error("Signup callback should not select a product organization");
        },
      }),
      identityRepository: createIdentityRepository({
        userByProviderUserId: async () => null,
      }),
      lifecycleCommandBus: {
        async execute(command) {
          commands.push(command);
          return {
            status: "accepted",
            commandId: command.commandId,
            idempotencyKey: command.idempotencyKey,
            userId: "user_creator_google",
            events: [],
          };
        },
      },
      surfacePolicies: {
        "marketplace-web": {
          requiredOrganizationKind: ["creator_workspace", "hotel_group"],
          allowMissingOrganization: true,
        },
      },
    });

    const start = await app.inject({
      method: "GET",
      url:
        "/auth/oauth/google/start?surface=marketplace-web&flow=signup" +
        "&return_to=https%3A%2F%2Fmarketplace.localhost%2Flogin%3Fauth%3Dcallback%26returnTo%3D%252Fonboarding" +
        "&error_return_to=https%3A%2F%2Fmarketplace.localhost%2Fsignup",
      headers: { host: "api.localhost", "x-forwarded-proto": "https" },
    });
    const callback = await app.inject({
      method: "GET",
      url: `/auth/oauth/google/callback?code=google-code&state=${encodeURIComponent(state)}`,
      headers: { cookie: cookieHeader(start, "vayada_oauth_state") },
    });

    expect(callback.statusCode).toBe(302);
    expect(callback.headers.location).toBe(
      "https://marketplace.localhost/login?auth=callback&returnTo=%2Fonboarding",
    );
    expect(callback.headers["set-cookie"]).toEqual(
      expect.arrayContaining([
        expect.stringContaining("vayada_workos_session=google-signup-sealed-session"),
      ]),
    );
    expect(workosCalls).toEqual(["code"]);
    expect(commands).toEqual([
      expect.objectContaining({
        commandType: "identity.user.create",
        payload: expect.objectContaining({
          providerIdentity: expect.objectContaining({
            providerUserId: "user_workos_google_signup",
          }),
        }),
      }),
    ]);
    expect(commands[0]?.payload).not.toHaveProperty("legacyUserType");
    expect(commands[0]?.payload).not.toHaveProperty("organization");
    expect(commands[0]?.payload).not.toHaveProperty("membership");
  });

  it("signs up a hotel account through Google OAuth and provisions the hotel organization", async () => {
    const commands: IdentityLifecycleCommand[] = [];
    const auditEvents: ProductAuditEvent[] = [];
    let identityCreated = false;
    let state = "";
    let signupOrganizationId = "";
    const googleSession: AuthKitSession = {
      ...session,
      accessToken: "booking-google-signup-token",
      sealedSession: "booking-google-signup-sealed-session",
      organizationId: undefined,
      user: {
        ...session.user,
        id: "user_workos_google_hotel",
        email: "hotel-owner@example.test",
      },
    };
    const canonicalUser: IdentityUser = {
      userId: "user_google_hotel",
      email: googleSession.user.email,
      name: googleSession.user.name,
      status: "active",
    };
    app = buildAuthSessionApp({
      allowedOrigins: ["https://admin.booking.localhost"],
      authKitClient: createAuthKitClient({
        getAuthorizationUrl(input) {
          state = input.state;
          return `https://auth.workos.test/google?state=${encodeURIComponent(input.state)}`;
        },
        async authenticateWithCode() {
          return googleSession;
        },
        async createSignupOrganization(input) {
          expect(input.metadata).toMatchObject({
            surface: "booking-admin",
            signup_intent: "hotel",
            organization_kind: "hotel_group",
            role_key: "hotel_owner",
          });
          signupOrganizationId = "org_workos_google_hotel";
          return { organizationId: signupOrganizationId };
        },
        async ensureSignupOrganizationMembership(input) {
          expect(input).toMatchObject({
            workosUserId: "user_workos_google_hotel",
            workosOrganizationId: signupOrganizationId,
            roleKey: "hotel_owner",
          });
          return {
            membershipId: "om_google_hotel_owner",
            roleSlugs: ["hotel_owner"],
            status: "active",
          };
        },
        async refreshSession(input) {
          expect(input.organizationId).toBe(signupOrganizationId);
          return {
            ...googleSession,
            sealedSession: "booking-google-signup-selected-session",
            organizationId: signupOrganizationId,
          };
        },
      }),
      identityRepository: createIdentityRepository({
        userByProviderUserId: async () => (identityCreated ? canonicalUser : null),
        organizationByWorkosOrgId: async () => ({
          organizationId: "org_google_hotel",
          workosOrgId: signupOrganizationId,
          name: "Google Hotel Group",
          kind: "hotel_group",
          status: "active",
        }),
        activeMembership: async () => ({
          membershipId: "membership_google_hotel",
          status: "active",
          roleKey: "hotel_owner",
          workosMembershipId: "om_google_hotel_owner",
          workosRoleSlugs: ["hotel_owner"],
        }),
      }),
      lifecycleCommandBus: {
        async execute(command) {
          commands.push(command);
          identityCreated ||= command.commandType === "identity.user.create";
          return {
            status: "accepted",
            commandId: command.commandId,
            idempotencyKey: command.idempotencyKey,
            userId: canonicalUser.userId,
            events: [],
          };
        },
      },
      productAuditSink: {
        async record(event) {
          auditEvents.push(event);
        },
      },
      surfacePolicies: {
        "booking-admin": {
          requiredOrganizationKind: "hotel_group",
          requiredResourceLink: { product: "booking", resourceType: "booking_hotel" },
        },
      },
    });

    const start = await app.inject({
      method: "GET",
      url:
        "/auth/oauth/google/start?surface=booking-admin&flow=signup&type=hotel" +
        "&return_to=https%3A%2F%2Fadmin.booking.localhost%2Flogin%3Fauth%3Dcallback%26returnTo%3D%252Fdashboard" +
        "&error_return_to=https%3A%2F%2Fadmin.booking.localhost%2Fsignup",
      headers: { host: "api.localhost", "x-forwarded-proto": "https" },
    });
    const callback = await app.inject({
      method: "GET",
      url: `/auth/oauth/google/callback?code=google-code&state=${encodeURIComponent(state)}`,
      headers: { cookie: cookieHeader(start, "vayada_oauth_state") },
    });

    expect(callback.statusCode).toBe(302);
    expect(callback.headers.location).toBe(
      "https://admin.booking.localhost/login?auth=callback&returnTo=%2Fdashboard",
    );
    expect(callback.headers["set-cookie"]).toEqual(
      expect.arrayContaining([
        expect.stringContaining("vayada_workos_session=booking-google-signup-selected-session"),
      ]),
    );
    expect(commands).toEqual([
      expect.objectContaining({
        commandType: "identity.user.create",
        payload: expect.objectContaining({
          legacyUserType: "hotel",
        }),
      }),
      expect.objectContaining({
        commandType: "identity.access.grant",
        payload: expect.objectContaining({
          userId: canonicalUser.userId,
          organization: expect.objectContaining({
            kind: "hotel_group",
            workosOrgId: signupOrganizationId,
          }),
          membership: expect.objectContaining({
            roleKey: "hotel_owner",
            propertyAccessMode: "all",
            permissionKeys: ["hotel_catalog.setup.read", "hotel_catalog.setup.manage"],
          }),
        }),
      }),
    ]);
    expect(auditEvents).toEqual([
      expect.objectContaining({
        action: "auth.login",
        authFlow: "signup",
        organizationId: "org_google_hotel",
        surface: "booking-admin",
        signupIntent: "hotel",
        workosOrgId: signupOrganizationId,
      }),
    ]);
  });

  it.each([
    {
      name: "invalid credentials",
      error: { code: "invalid_grant" },
      statusCode: 401,
      body: {
        state: "invalid_credentials",
        message: "Email or password is incorrect.",
      },
    },
    {
      name: "email verification required",
      error: {
        code: "email_verification_required",
        pending_authentication_token: "pending_email",
        email: "creator@example.test",
      },
      statusCode: 403,
      body: {
        state: "email_verification_required",
        pendingAuthenticationToken: "pending_email",
      },
    },
    {
      name: "organization selection required",
      error: {
        code: "organization_selection_required",
        pending_authentication_token: "pending_org",
        organizations: [{ id: "org_workos_creator", name: "Creator Workspace" }],
      },
      statusCode: 403,
      body: {
        state: "organization_selection_required",
        pendingAuthenticationToken: "pending_org",
        organizations: [{ id: "org_workos_creator", name: "Creator Workspace" }],
      },
    },
    {
      name: "MFA required",
      error: { code: "mfa_challenge", pendingAuthenticationToken: "pending_mfa" },
      statusCode: 403,
      body: {
        state: "mfa_required",
        pendingAuthenticationToken: "pending_mfa",
      },
    },
    {
      name: "SSO required",
      error: { error: "sso_required", connection_ids: ["conn_123"] },
      statusCode: 403,
      body: {
        state: "sso_required",
        connectionIds: ["conn_123"],
      },
    },
    {
      name: "unmapped provider failure",
      error: new Error("WorkOS unavailable"),
      statusCode: 502,
      body: {
        state: "auth_failed",
        message: "Authentication failed. Please try again.",
      },
    },
  ])("returns shared auth state for password login: $name", async ({ error, statusCode, body }) => {
    const auditEvents: ProductAuditEvent[] = [];
    app = buildAuthSessionApp({
      allowedOrigins: ["https://marketplace.localhost"],
      authKitClient: createAuthKitClient({
        async authenticateWithPassword() {
          throw error;
        },
      }),
      surfacePolicies: {
        "marketplace-web": {
          requiredOrganizationKind: ["creator_workspace", "hotel_group"],
        },
      },
      productAuditSink: {
        async record(event) {
          auditEvents.push(event);
        },
      },
    });

    const response = await app.inject({
      method: "POST",
      url: "/auth/password/login",
      headers: { origin: "https://marketplace.localhost" },
      payload: {
        email: "creator@example.test",
        password: "wrong-password",
        surface: "marketplace-web",
      },
    });

    expect(response.statusCode).toBe(statusCode);
    expect(response.json()).toMatchObject(body);
    expect(auditEvents).toContainEqual(
      expect.objectContaining({
        action: "auth.login.failed",
        authFlow: "login",
        failureReason: body.state,
        surface: "marketplace-web",
      }),
    );
  });

  it("returns WorkOS' existing password-login verification challenge without replacing it", async () => {
    let resendCalled = false;
    app = buildAuthSessionApp({
      allowedOrigins: ["https://marketplace.localhost"],
      authKitClient: createAuthKitClient({
        async authenticateWithPassword() {
          throw {
            code: "email_verification_required",
            pending_authentication_token: "pending_email",
            email: "creator@example.test",
            email_verification_id: "email_verification_123",
          };
        },
        async resendVerificationEmail() {
          resendCalled = true;
          return { email: "creator@example.test" };
        },
      }),
      surfacePolicies: {
        "marketplace-web": {
          requiredOrganizationKind: ["creator_workspace", "hotel_group"],
        },
      },
    });

    const response = await app.inject({
      method: "POST",
      url: "/auth/password/login",
      headers: { origin: "https://marketplace.localhost" },
      payload: {
        email: "creator@example.test",
        password: "correct-password",
        surface: "marketplace-web",
      },
    });

    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({
      state: "email_verification_required",
      pendingAuthenticationToken: "pending_email",
      emailVerificationId: "email_verification_123",
    });
    expect(resendCalled).toBe(false);
  });

  it("records a failed password login audit when identity resolution rejects the session", async () => {
    const auditEvents: ProductAuditEvent[] = [];
    const marketplaceSession: AuthKitSession = {
      ...session,
      organizationId: "org_workos_missing",
      user: {
        ...session.user,
        id: "user_workos_creator",
        email: "creator@example.test",
      },
    };
    app = buildAuthSessionApp({
      allowedOrigins: ["https://marketplace.localhost"],
      authKitClient: createAuthKitClient({
        async authenticateWithPassword() {
          return marketplaceSession;
        },
      }),
      identityRepository: createIdentityRepository({
        userByProviderUserId: async () => ({
          userId: "user_creator",
          email: "creator@example.test",
          status: "active",
        }),
        organizationByWorkosOrgId: async () => null,
      }),
      surfacePolicies: {
        "marketplace-web": {
          requiredOrganizationKind: ["creator_workspace", "hotel_group"],
        },
      },
      productAuditSink: {
        async record(event) {
          auditEvents.push(event);
        },
      },
    });

    const response = await app.inject({
      method: "POST",
      url: "/auth/password/login",
      headers: { origin: "https://marketplace.localhost" },
      payload: {
        email: "creator@example.test",
        password: "correct-password",
        surface: "marketplace-web",
      },
    });

    expect(response.statusCode).toBe(403);
    expect(auditEvents).toContainEqual(
      expect.objectContaining({
        action: "auth.login.failed",
        authFlow: "login",
        failureReason: "identity_resolution",
        surface: "marketplace-web",
        workosUserId: "user_workos_creator",
        workosOrgId: "org_workos_missing",
        workosSessionId: "session_workos",
      }),
    );
  });

  it("requests a WorkOS password reset and returns a generic response", async () => {
    let resetEmail: string | undefined;
    app = buildAuthSessionApp({
      allowedOrigins: ["https://marketplace.localhost"],
      authKitClient: createAuthKitClient({
        async createPasswordReset(input) {
          resetEmail = input.email;
        },
      }),
    });

    const response = await app.inject({
      method: "POST",
      url: "/auth/password/reset/request",
      headers: { origin: "https://marketplace.localhost" },
      payload: {
        email: " creator@example.test ",
      },
    });

    expect(response.statusCode).toBe(200);
    expect(resetEmail).toBe("creator@example.test");
    expect(response.json()).toEqual({
      message: "If an account with that email exists, a password reset link has been sent.",
    });
  });

  it("throttles repeated WorkOS password reset requests by email", async () => {
    let resetCount = 0;
    app = buildAuthSessionApp({
      allowedOrigins: ["https://marketplace.localhost"],
      authKitClient: createAuthKitClient({
        async createPasswordReset() {
          resetCount += 1;
        },
      }),
    });

    const firstResponse = await app.inject({
      method: "POST",
      url: "/auth/password/reset/request",
      headers: { origin: "https://marketplace.localhost" },
      payload: { email: "creator@example.test" },
    });
    const secondResponse = await app.inject({
      method: "POST",
      url: "/auth/password/reset/request",
      headers: { origin: "https://marketplace.localhost" },
      payload: { email: "creator@example.test" },
    });

    expect(firstResponse.statusCode).toBe(200);
    expect(secondResponse.statusCode).toBe(429);
    expect(secondResponse.json()).toEqual({
      state: "auth_failed",
      message: "Please wait before requesting another email.",
    });
    expect(resetCount).toBe(1);
  });

  it("resets a WorkOS password with a valid reset token", async () => {
    let resetInput: Parameters<AuthKitClient["resetPassword"]>[0] | undefined;
    app = buildAuthSessionApp({
      allowedOrigins: ["https://marketplace.localhost"],
      authKitClient: createAuthKitClient({
        async resetPassword(input) {
          resetInput = input;
          return session.user;
        },
      }),
    });

    const response = await app.inject({
      method: "POST",
      url: "/auth/password/reset/confirm",
      headers: { origin: "https://marketplace.localhost" },
      payload: {
        token: "password-reset-token",
        newPassword: "new-secure-password",
      },
    });

    expect(response.statusCode).toBe(200);
    expect(resetInput).toEqual({
      token: "password-reset-token",
      newPassword: "new-secure-password",
    });
    expect(response.json()).toEqual({
      message: "Password reset successful. Please sign in with your new password.",
    });
  });

  it("returns a controlled error for invalid WorkOS reset tokens", async () => {
    app = buildAuthSessionApp({
      allowedOrigins: ["https://marketplace.localhost"],
      authKitClient: createAuthKitClient({
        async resetPassword() {
          throw { status: 404 };
        },
      }),
    });

    const response = await app.inject({
      method: "POST",
      url: "/auth/password/reset/confirm",
      headers: { origin: "https://marketplace.localhost" },
      payload: {
        token: "expired-reset-token",
        newPassword: "new-secure-password",
      },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({
      state: "auth_failed",
      message: "Invalid or expired reset token. Please request a new password reset link.",
    });
  });

  it("completes account signup after WorkOS email verification without product provisioning", async () => {
    const commands: IdentityLifecycleCommand[] = [];
    const workosCalls: string[] = [];
    const verifiedSession: AuthKitSession = {
      ...session,
      organizationId: undefined,
      sealedSession: "verified-unselected-session",
      user: {
        id: "user_workos_verified_creator",
        email: "verified-creator@example.test",
        emailVerified: true,
        name: "Verified Creator",
      },
    };
    app = buildAuthSessionApp({
      allowedOrigins: ["https://marketplace.localhost"],
      authKitClient: createAuthKitClient({
        async createUser() {
          return { ...verifiedSession.user, emailVerified: false };
        },
        async authenticateWithPassword() {
          throw {
            code: "email_verification_required",
            pending_authentication_token: "pending-creator-signup",
          };
        },
        async authenticateWithEmailVerification(input) {
          workosCalls.push("verify");
          expect(input).toMatchObject({
            pendingAuthenticationToken: "pending-creator-signup",
            code: "123456",
            userAgent: "vitest",
            ipAddress: expect.any(String),
          });
          return verifiedSession;
        },
        async createSignupOrganization() {
          throw new Error("Product organization should be created by onboarding");
        },
        async ensureSignupOrganizationMembership() {
          throw new Error("Product membership should be created by onboarding");
        },
        async refreshSession() {
          throw new Error("Email verification should not select a product organization");
        },
      }),
      identityRepository: createIdentityRepository({
        userByProviderUserId: async () => null,
      }),
      lifecycleCommandBus: {
        async execute(command) {
          commands.push(command);
          return {
            status: "accepted",
            commandId: command.commandId,
            idempotencyKey: command.idempotencyKey,
            userId: "user_verified_creator",
            events: [],
          };
        },
      },
      surfacePolicies: {
        "marketplace-web": {
          requiredOrganizationKind: ["creator_workspace", "hotel_group"],
          allowMissingOrganization: true,
        },
      },
    });

    const pendingAuthenticationToken = await beginPasswordSignup(app, {
      email: verifiedSession.user.email,
      surface: "marketplace-web",
    });

    const response = await app.inject({
      method: "POST",
      url: "/auth/email-verification/confirm",
      headers: {
        origin: "https://marketplace.localhost",
        "user-agent": "vitest",
      },
      payload: {
        pendingAuthenticationToken,
        code: "123456",
        flow: "signup",
        surface: "marketplace-web",
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      accessToken: verifiedSession.accessToken,
      csrfToken: expect.any(String),
      user: {
        id: "user_verified_creator",
        email: "verified-creator@example.test",
        workosUserId: "user_workos_verified_creator",
      },
    });
    expect(commands).toEqual([
      expect.objectContaining({
        commandType: "identity.user.create",
        payload: expect.objectContaining({
          providerIdentity: expect.objectContaining({
            providerUserId: "user_workos_verified_creator",
            providerEmailVerified: true,
          }),
        }),
      }),
    ]);
    expect(commands[0]?.payload).not.toHaveProperty("legacyUserType");
    expect(commands[0]?.payload).not.toHaveProperty("organization");
    expect(commands[0]?.payload).not.toHaveProperty("membership");
    expect(workosCalls).toEqual(["verify"]);
  });

  it("completes PMS signup when the WorkOS user webhook arrives before verification", async () => {
    const commands: IdentityLifecycleCommand[] = [];
    const workosCalls: string[] = [];
    let accessGranted = false;
    let webhookArrived = false;
    let signupPending = true;
    const webhookUser: IdentityUser = {
      userId: "user_webhook_first_hotel",
      email: "webhook-first-hotel@example.test",
      name: "Webhook First Hotel",
      status: "active",
    };
    const verifiedSession: AuthKitSession = {
      ...session,
      organizationId: undefined,
      sealedSession: "webhook-first-unselected-session",
      user: {
        id: "user_workos_webhook_first_hotel",
        email: webhookUser.email,
        emailVerified: true,
        name: webhookUser.name,
      },
    };
    const selectedSession: AuthKitSession = {
      ...verifiedSession,
      organizationId: "org_workos_webhook_first_hotel",
      sealedSession: "webhook-first-selected-session",
    };
    app = buildAuthSessionApp({
      allowedOrigins: ["https://pms.localhost"],
      authKitClient: createAuthKitClient({
        async createUser() {
          return { ...verifiedSession.user, emailVerified: false };
        },
        async authenticateWithPassword() {
          if (signupPending) {
            signupPending = false;
            throw {
              code: "email_verification_required",
              pending_authentication_token: "pending-webhook-first-token",
            };
          }
          workosCalls.push("login");
          return selectedSession;
        },
        async authenticateWithEmailVerification() {
          workosCalls.push("verify");
          return verifiedSession;
        },
        async createSignupOrganization() {
          workosCalls.push("create-org");
          return { organizationId: "org_workos_webhook_first_hotel" };
        },
        async ensureSignupOrganizationMembership() {
          workosCalls.push("member");
          return {
            membershipId: "om_webhook_first_hotel_owner",
            roleSlugs: ["hotel_owner"],
            status: "active",
          };
        },
        async refreshSession() {
          workosCalls.push("select-org");
          return selectedSession;
        },
        async updateUserExternalId(input) {
          workosCalls.push("external-id");
          expect(input).toEqual({
            workosUserId: "user_workos_webhook_first_hotel",
            externalId: webhookUser.userId,
          });
        },
      }),
      identityRepository: createIdentityRepository({
        userByProviderUserId: async () => (webhookArrived ? webhookUser : null),
        organizationByWorkosOrgId: async () => ({
          organizationId: "org_webhook_first_hotel",
          workosOrgId: "org_workos_webhook_first_hotel",
          name: "Webhook First Hotel Hotel Group",
          kind: "hotel_group",
          status: "active",
        }),
        activeMembership: async () =>
          accessGranted
            ? {
                membershipId: "membership_webhook_first_hotel_owner",
                status: "active",
                roleKey: "hotel_owner",
                workosMembershipId: "om_webhook_first_hotel_owner",
                workosRoleSlugs: ["hotel_owner"],
              }
            : null,
      }),
      lifecycleCommandBus: {
        async execute(command) {
          commands.push(command);
          webhookArrived ||= command.commandType === "identity.user.create";
          accessGranted ||= command.commandType === "identity.access.grant";
          return {
            status: "accepted",
            commandId: command.commandId,
            idempotencyKey: command.idempotencyKey,
            userId: webhookUser.userId,
            organizationId: "org_webhook_first_hotel",
            events: [],
          };
        },
      },
      surfacePolicies: {
        "pms-web": { requiredOrganizationKind: "hotel_group" },
      },
    });

    const pendingAuthenticationToken = await beginPasswordSignup(app, {
      email: webhookUser.email,
      surface: "pms-web",
      type: "hotel",
    });

    const verification = await app.inject({
      method: "POST",
      url: "/auth/email-verification/confirm",
      headers: { origin: "https://pms.localhost" },
      payload: {
        pendingAuthenticationToken,
        code: "123456",
        flow: "signup",
        intent: "hotel",
        surface: "pms-web",
      },
    });

    expect(verification.statusCode).toBe(200);
    expect(verification.json()).toMatchObject({
      organizationId: "org_webhook_first_hotel",
      user: { id: webhookUser.userId },
    });
    expect(commands).toEqual([
      expect.objectContaining({
        commandType: "identity.user.create",
        payload: expect.objectContaining({ legacyUserType: "hotel" }),
      }),
      expect.objectContaining({
        commandType: "identity.access.grant",
        idempotencyKey:
          "workos-signup-access:user_workos_webhook_first_hotel:org_workos_webhook_first_hotel",
        payload: expect.objectContaining({
          userId: webhookUser.userId,
          organization: expect.objectContaining({
            workosOrgId: "org_workos_webhook_first_hotel",
          }),
          membership: expect.objectContaining({
            roleKey: "hotel_owner",
            workosMembershipId: "om_webhook_first_hotel_owner",
          }),
        }),
      }),
    ]);
    const login = await app.inject({
      method: "POST",
      url: "/auth/password/login",
      headers: { origin: "https://pms.localhost" },
      payload: {
        email: webhookUser.email,
        password: "correct-password",
        surface: "pms-web",
      },
    });

    expect(login.statusCode).toBe(200);
    expect(login.json()).toMatchObject({
      organizationId: "org_webhook_first_hotel",
      user: { id: webhookUser.userId },
    });
    expect(workosCalls).toEqual([
      "verify",
      "create-org",
      "member",
      "select-org",
      "external-id",
      "login",
    ]);

    const relabeledLogin = await app.inject({
      method: "POST",
      url: "/auth/email-verification/confirm",
      headers: { origin: "https://pms.localhost" },
      payload: {
        pendingAuthenticationToken: "pending-login-token",
        code: "123456",
        flow: "signup",
        intent: "hotel",
        surface: "pms-web",
      },
    });
    expect(relabeledLogin.statusCode).toBe(400);

    webhookUser.email = "conflicting-canonical-email@example.test";
    const conflictingIdentity = await app.inject({
      method: "POST",
      url: "/auth/email-verification/confirm",
      headers: { origin: "https://pms.localhost" },
      payload: {
        pendingAuthenticationToken,
        code: "123456",
        flow: "signup",
        intent: "hotel",
        surface: "pms-web",
      },
    });
    expect(conflictingIdentity.statusCode).toBe(403);
    expect(commands).toHaveLength(2);
    expect(workosCalls).toEqual([
      "verify",
      "create-org",
      "member",
      "select-org",
      "external-id",
      "login",
      "verify",
    ]);
  });

  it("returns a controlled error for invalid WorkOS verification state", async () => {
    app = buildAuthSessionApp({
      allowedOrigins: ["https://marketplace.localhost"],
      authKitClient: createAuthKitClient({
        async authenticateWithEmailVerification() {
          throw { code: "invalid_grant" };
        },
      }),
      surfacePolicies: {
        "marketplace-web": {
          requiredOrganizationKind: ["creator_workspace", "hotel_group"],
        },
      },
    });

    const response = await app.inject({
      method: "POST",
      url: "/auth/email-verification/confirm",
      headers: { origin: "https://marketplace.localhost" },
      payload: {
        pendingAuthenticationToken: "expired-email-token",
        code: "123456",
        surface: "marketplace-web",
      },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({
      state: "auth_failed",
      message: "Invalid or expired verification code. Please sign in again.",
    });
  });

  it("resends a WorkOS verification code from the verification state id", async () => {
    let emailVerificationId: string | undefined;
    app = buildAuthSessionApp({
      allowedOrigins: ["https://marketplace.localhost"],
      authKitClient: createAuthKitClient({
        async resendVerificationEmail(input) {
          emailVerificationId = input.emailVerificationId;
          return { email: "creator@example.test" };
        },
      }),
    });

    const response = await app.inject({
      method: "POST",
      url: "/auth/email-verification/resend",
      headers: { origin: "https://marketplace.localhost" },
      payload: {
        emailVerificationId: "email_verification_123",
      },
    });

    expect(response.statusCode).toBe(200);
    expect(emailVerificationId).toBe("email_verification_123");
    expect(response.json()).toEqual({
      message: "A new verification code has been sent.",
    });
  });

  it("throttles repeated WorkOS verification resends by verification state", async () => {
    let resendCount = 0;
    app = buildAuthSessionApp({
      allowedOrigins: ["https://marketplace.localhost"],
      authKitClient: createAuthKitClient({
        async resendVerificationEmail() {
          resendCount += 1;
          return { email: "creator@example.test" };
        },
      }),
    });

    const firstResponse = await app.inject({
      method: "POST",
      url: "/auth/email-verification/resend",
      headers: { origin: "https://marketplace.localhost" },
      payload: { emailVerificationId: "email_verification_123" },
    });
    const secondResponse = await app.inject({
      method: "POST",
      url: "/auth/email-verification/resend",
      headers: { origin: "https://marketplace.localhost" },
      payload: { emailVerificationId: "email_verification_123" },
    });

    expect(firstResponse.statusCode).toBe(200);
    expect(secondResponse.statusCode).toBe(429);
    expect(secondResponse.json()).toEqual({
      state: "auth_failed",
      message: "Please wait before requesting another email.",
    });
    expect(resendCount).toBe(1);
  });

  it("signs up an account through custom password signup before product onboarding", async () => {
    const commands: IdentityLifecycleCommand[] = [];
    const auditEvents: ProductAuditEvent[] = [];
    const workosCalls: string[] = [];
    const email = "account-signup@example.test";
    const unsignedSession: AuthKitSession = {
      ...session,
      organizationId: undefined,
      sealedSession: "sealed_account_signup",
      user: {
        id: "user_workos_account_signup",
        email,
        emailVerified: true,
        name: "Signup Example",
      },
    };
    app = buildAuthSessionApp({
      allowedOrigins: ["https://marketplace.localhost"],
      authKitClient: createAuthKitClient({
        async createUser(input) {
          workosCalls.push("user");
          expect(input).toMatchObject({
            email,
            password: "correct-password",
            metadata: {
              auth_flow: "signup",
              surface: "marketplace-web",
            },
          });
          expect(input.metadata).not.toHaveProperty("signup_intent");
          return unsignedSession.user;
        },
        async authenticateWithPassword(input) {
          workosCalls.push("password");
          expect(input).toMatchObject({
            email,
            password: "correct-password",
          });
          return unsignedSession;
        },
        async createSignupOrganization() {
          throw new Error("Product organization should be created by onboarding");
        },
        async ensureSignupOrganizationMembership() {
          throw new Error("Product membership should be created by onboarding");
        },
        async refreshSession() {
          throw new Error("Signup should not select a product organization");
        },
      }),
      identityRepository: createIdentityRepository({
        userByProviderUserId: async () => null,
      }),
      lifecycleCommandBus: {
        async execute(command) {
          commands.push(command);
          return {
            status: "accepted",
            commandId: command.commandId,
            idempotencyKey: command.idempotencyKey,
            userId: "user_signup",
            events: [],
          };
        },
      },
      surfacePolicies: {
        "marketplace-web": {
          requiredOrganizationKind: ["creator_workspace", "hotel_group"],
          allowMissingOrganization: true,
        },
      },
      productAuditSink: {
        async record(event) {
          auditEvents.push(event);
        },
      },
    });

    const response = await app.inject({
      method: "POST",
      url: "/auth/password/signup",
      headers: {
        origin: "https://marketplace.localhost",
      },
      payload: {
        email: ` ${email} `,
        password: "correct-password",
        surface: "marketplace-web",
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      accessToken: unsignedSession.accessToken,
      csrfToken: expect.any(String),
      user: {
        id: "user_signup",
        email,
        workosUserId: "user_workos_account_signup",
      },
    });
    expect(response.json().organizationId).toBeUndefined();
    expect(response.json().organizationKind).toBeUndefined();
    expect(commands).toEqual([
      expect.objectContaining({
        commandType: "identity.user.create",
        payload: expect.objectContaining({
          email,
          providerIdentity: expect.objectContaining({
            providerUserId: "user_workos_account_signup",
          }),
        }),
      }),
    ]);
    expect(commands[0]?.payload).not.toHaveProperty("legacyUserType");
    expect(commands[0]?.payload).not.toHaveProperty("organization");
    expect(commands[0]?.payload).not.toHaveProperty("membership");
    expect(auditEvents).toEqual([
      expect.objectContaining({
        action: "auth.login",
        authFlow: "signup",
        surface: "marketplace-web",
      }),
    ]);
    expect(workosCalls).toEqual(["user", "password"]);
  });

  it.each([
    {
      surface: "booking-admin" as const,
      email: "booking-signup@example.test",
      workosUserId: "user_workos_booking_signup",
      workosOrgId: "org_workos_booking_hotel",
      organizationId: "org_booking_hotel",
      selectedSession: "selected_booking_hotel_session",
    },
    {
      surface: "pms-web" as const,
      email: "pms-signup@example.test",
      workosUserId: "user_workos_pms_signup",
      workosOrgId: "org_workos_pms_hotel",
      organizationId: "org_pms_hotel",
      selectedSession: "selected_pms_hotel_session",
    },
  ])("keeps hotel organization provisioning for $surface password signup", async (scenario) => {
    const commands: IdentityLifecycleCommand[] = [];
    const workosCalls: string[] = [];
    let identityCreated = false;
    const unsignedSession: AuthKitSession = {
      ...session,
      organizationId: undefined,
      sealedSession: `${scenario.surface}-unselected-session`,
      user: {
        id: scenario.workosUserId,
        email: scenario.email,
        emailVerified: true,
        name: "Hotel Signup",
      },
    };
    const canonicalUser: IdentityUser = {
      userId: `user_${scenario.surface}`,
      email: scenario.email,
      name: unsignedSession.user.name,
      status: "active",
    };
    app = buildAuthSessionApp({
      allowedOrigins: [
        `https://${scenario.surface === "booking-admin" ? "admin.booking" : "pms"}.localhost`,
      ],
      authKitClient: createAuthKitClient({
        async createUser(input) {
          workosCalls.push("user");
          expect(input).toMatchObject({
            email: scenario.email,
            password: "correct-password",
            metadata: {
              auth_flow: "signup",
              surface: scenario.surface,
              signup_intent: "hotel",
            },
          });
          return unsignedSession.user;
        },
        async authenticateWithPassword(input) {
          workosCalls.push("password");
          expect(input).toMatchObject({
            email: scenario.email,
            password: "correct-password",
          });
          return unsignedSession;
        },
        async createSignupOrganization(input) {
          workosCalls.push("organization");
          expect(input).toMatchObject({
            externalId: `vayada-signup:${scenario.surface}:hotel:${scenario.workosUserId}`,
            metadata: {
              auth_flow: "signup",
              surface: scenario.surface,
              signup_intent: "hotel",
              organization_kind: "hotel_group",
              role_key: "hotel_owner",
            },
          });
          return { organizationId: scenario.workosOrgId };
        },
        async ensureSignupOrganizationMembership(input) {
          workosCalls.push("membership");
          expect(input).toEqual({
            workosUserId: scenario.workosUserId,
            workosOrganizationId: scenario.workosOrgId,
            roleKey: "hotel_owner",
          });
          return {
            membershipId: `om_${scenario.surface}`,
            roleSlugs: ["hotel_owner"],
            status: "active",
          };
        },
        async refreshSession(input) {
          workosCalls.push("refresh");
          expect(input).toEqual({
            sealedSession: `${scenario.surface}-unselected-session`,
            organizationId: scenario.workosOrgId,
          });
          return {
            ...unsignedSession,
            organizationId: scenario.workosOrgId,
            sealedSession: scenario.selectedSession,
          };
        },
      }),
      identityRepository: createIdentityRepository({
        userByProviderUserId: async () => (identityCreated ? canonicalUser : null),
        organizationByWorkosOrgId: async () => ({
          organizationId: scenario.organizationId,
          workosOrgId: scenario.workosOrgId,
          name: "Hotel Group",
          kind: "hotel_group",
          status: "active",
        }),
        activeMembership: async () => ({
          membershipId: `membership_${scenario.surface}`,
          status: "active",
          roleKey: "hotel_owner",
          workosMembershipId: `om_${scenario.surface}`,
          workosRoleSlugs: ["hotel_owner"],
        }),
      }),
      lifecycleCommandBus: {
        async execute(command) {
          commands.push(command);
          identityCreated ||= command.commandType === "identity.user.create";
          return {
            status: "accepted",
            commandId: command.commandId,
            idempotencyKey: command.idempotencyKey,
            userId: canonicalUser.userId,
            events: [],
          };
        },
      },
      surfacePolicies: {
        [scenario.surface]: {
          requiredOrganizationKind: "hotel_group",
          logoutReturnUrl: `https://${scenario.surface === "booking-admin" ? "admin.booking" : "pms"}.localhost/login`,
        },
      },
    });

    const response = await app.inject({
      method: "POST",
      url: "/auth/password/signup",
      headers: {
        origin: `https://${scenario.surface === "booking-admin" ? "admin.booking" : "pms"}.localhost`,
      },
      payload: {
        email: scenario.email,
        password: "correct-password",
        surface: scenario.surface,
        type: "hotel",
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers["set-cookie"]).toEqual(
      expect.arrayContaining([
        expect.stringContaining(`vayada_workos_session=${scenario.selectedSession}`),
      ]),
    );
    expect(response.json()).toMatchObject({
      organizationId: scenario.organizationId,
      workosOrganizationId: scenario.workosOrgId,
      organizationKind: "hotel_group",
      user: {
        id: `user_${scenario.surface}`,
        email: scenario.email,
        workosUserId: scenario.workosUserId,
      },
    });
    expect(commands).toEqual([
      expect.objectContaining({
        commandType: "identity.user.create",
        payload: expect.objectContaining({
          legacyUserType: "hotel",
        }),
      }),
      expect.objectContaining({
        commandType: "identity.access.grant",
        payload: expect.objectContaining({
          userId: canonicalUser.userId,
          organization: expect.objectContaining({
            kind: "hotel_group",
            workosOrgId: scenario.workosOrgId,
          }),
          membership: expect.objectContaining({
            roleKey: "hotel_owner",
            workosMembershipId: `om_${scenario.surface}`,
          }),
        }),
      }),
    ]);
    expect(commands[0]?.payload).not.toHaveProperty("organization");
    expect(commands[0]?.payload).not.toHaveProperty("membership");
    expect(workosCalls).toEqual(["user", "password", "organization", "membership", "refresh"]);
  });

  it("rejects custom signup when the WorkOS email already exists", async () => {
    let authenticateCalled = false;
    let organizationCalled = false;
    app = buildAuthSessionApp({
      allowedOrigins: ["https://marketplace.localhost"],
      authKitClient: createAuthKitClient({
        async createUser() {
          throw { status: 409, name: "ConflictException" };
        },
        async authenticateWithPassword() {
          authenticateCalled = true;
          return session;
        },
        async createSignupOrganization() {
          organizationCalled = true;
          return { organizationId: "org_workos_existing_creator" };
        },
      }),
      surfacePolicies: {
        "marketplace-web": {
          requiredOrganizationKind: ["creator_workspace", "hotel_group"],
        },
      },
    });

    const response = await app.inject({
      method: "POST",
      url: "/auth/password/signup",
      headers: { origin: "https://marketplace.localhost" },
      payload: {
        email: "existing@example.test",
        password: "correct-password",
        surface: "marketplace-web",
      },
    });

    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({
      state: "auth_failed",
      message: "This email already has a Vayada account. Sign in instead.",
    });
    expect(authenticateCalled).toBe(false);
    expect(organizationCalled).toBe(false);
  });

  it("returns verification-required state from custom signup without resending the WorkOS email", async () => {
    const commands: IdentityLifecycleCommand[] = [];
    let resendCalled = false;
    app = buildAuthSessionApp({
      allowedOrigins: ["https://marketplace.localhost"],
      authKitClient: createAuthKitClient({
        async createUser() {
          return {
            id: "user_workos_unverified",
            email: "unverified@example.test",
            emailVerified: false,
          };
        },
        async authenticateWithPassword() {
          throw {
            code: "email_verification_required",
            pending_authentication_token: "pending_email",
            email: "unverified@example.test",
            email_verification_id: "email_verification_signup",
          };
        },
        async resendVerificationEmail() {
          resendCalled = true;
          return { email: "unverified@example.test" };
        },
        async createSignupOrganization() {
          throw new Error("Vayada organization should not be created before verification");
        },
      }),
      lifecycleCommandBus: {
        async execute(command) {
          commands.push(command);
          return {
            status: "accepted",
            commandId: command.commandId,
            idempotencyKey: command.idempotencyKey,
            events: [],
          };
        },
      },
      surfacePolicies: {
        "marketplace-web": {
          requiredOrganizationKind: ["creator_workspace", "hotel_group"],
        },
      },
    });

    const response = await app.inject({
      method: "POST",
      url: "/auth/password/signup",
      headers: { origin: "https://marketplace.localhost" },
      payload: {
        email: "unverified@example.test",
        password: "correct-password",
        surface: "marketplace-web",
      },
    });

    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({
      state: "email_verification_required",
      pendingAuthenticationToken: expect.any(String),
      emailVerificationId: "email_verification_signup",
    });
    expect(response.json().pendingAuthenticationToken).not.toBe("pending_email");
    expect(resendCalled).toBe(false);
    expect(commands).toEqual([]);
  });

  it("creates a hotel account from account type alone", async () => {
    const commands: IdentityLifecycleCommand[] = [];
    const workosCalls: string[] = [];
    const noOrgSession: AuthKitSession = {
      ...session,
      organizationId: undefined,
      sealedSession: "sealed-account-session",
      user: {
        ...session.user,
        id: "user_workos_account_signup",
        email: "account-signup@example.test",
      },
    };
    const hotelSession: AuthKitSession = {
      ...noOrgSession,
      accessToken: "hotel-workos-access-token",
      organizationId: "org_workos_onboarding_hotel",
      sealedSession: "hotel-selected-session",
    };
    app = buildAuthSessionApp({
      allowedOrigins: ["https://marketplace.localhost"],
      authKitClient: createAuthKitClient({
        async authenticateSession() {
          return noOrgSession;
        },
        async createSignupOrganization(input) {
          workosCalls.push("organization");
          expect(input).toMatchObject({
            name: "Account Signup Hotel Group",
            externalId: "vayada-signup:marketplace-web:hotel:user_workos_account_signup",
            metadata: {
              auth_flow: "signup",
              surface: "marketplace-web",
              signup_intent: "hotel",
              organization_kind: "hotel_group",
              role_key: "hotel_owner",
            },
          });
          return { organizationId: "org_workos_onboarding_hotel" };
        },
        async ensureSignupOrganizationMembership(input) {
          workosCalls.push("membership");
          expect(input).toEqual({
            workosUserId: "user_workos_account_signup",
            workosOrganizationId: "org_workos_onboarding_hotel",
            roleKey: "hotel_owner",
          });
          return {
            membershipId: "om_onboarding_hotel",
            roleSlugs: ["hotel_owner"],
            status: "active",
          };
        },
        async refreshSession(input) {
          workosCalls.push("refresh");
          expect(input).toEqual({
            sealedSession: "sealed-account-session",
            organizationId: "org_workos_onboarding_hotel",
          });
          return hotelSession;
        },
      }),
      tokenVerifier: createTokenVerifier(noOrgSession),
      identityRepository: createIdentityRepository({
        userByProviderUserId: async () => ({
          userId: "user_signup",
          email: "account-signup@example.test",
          status: "active",
        }),
        organizationByWorkosOrgId: async () => ({
          organizationId: "org_onboarding_hotel",
          workosOrgId: "org_workos_onboarding_hotel",
          name: "Account Signup Hotel Group",
          kind: "hotel_group",
          status: "active",
        }),
        activeMembership: async () => ({
          membershipId: "membership_onboarding_hotel",
          status: "active",
          roleKey: "hotel_owner",
          workosMembershipId: "om_onboarding_hotel",
          workosRoleSlugs: ["hotel_owner"],
        }),
      }),
      lifecycleCommandBus: {
        async execute(command) {
          commands.push(command);
          return {
            status: "accepted",
            commandId: command.commandId,
            idempotencyKey: command.idempotencyKey,
            events: [],
          };
        },
      },
      surfacePolicies: {
        "marketplace-web": {
          requiredOrganizationKind: ["creator_workspace", "hotel_group"],
          allowMissingOrganization: true,
        },
      },
    });

    const response = await app.inject({
      method: "POST",
      url: "/auth/onboarding",
      headers: {
        cookie:
          "vayada_workos_session=sealed-session; vayada_auth_csrf=stale-token; vayada_auth_csrf=csrf-token",
        origin: "https://marketplace.localhost",
        "x-vayada-csrf": "csrf-token",
      },
      payload: {
        type: "hotel",
        surface: "marketplace-web",
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers["set-cookie"]).toEqual(
      expect.arrayContaining([
        expect.stringContaining("vayada_workos_session=hotel-selected-session"),
      ]),
    );
    expect(response.json()).toMatchObject({
      accessToken: "hotel-workos-access-token",
      csrfToken: "csrf-token",
      organizationId: "org_onboarding_hotel",
      workosOrganizationId: "org_workos_onboarding_hotel",
      organizationKind: "hotel_group",
      user: {
        id: "user_signup",
        email: "account-signup@example.test",
      },
    });
    expect(commands).toEqual([
      expect.objectContaining({
        commandType: "identity.access.grant",
        idempotencyKey: "workos-onboarding:user_signup:hotel",
        payload: expect.objectContaining({
          userId: "user_signup",
          organization: expect.objectContaining({
            kind: "hotel_group",
            name: "Account Signup Hotel Group",
            workosOrgId: "org_workos_onboarding_hotel",
          }),
          membership: expect.objectContaining({
            roleKey: "hotel_owner",
            propertyAccessMode: "all",
            workosMembershipId: "om_onboarding_hotel",
          }),
        }),
      }),
    ]);
    expect(workosCalls).toEqual(["organization", "membership", "refresh"]);
  });

  it("selects the server-validated invite-bound hotel organization for an existing multi-org user", async () => {
    const inviteCode = "VAY-secret-invite-code";
    const inviteId = "77777777-7777-4777-8777-777777777777";
    const inviteExternalId = `vayada-signup:marketplace-web:hotel:invite:${inviteId}`;
    const commands: IdentityLifecycleCommand[] = [];
    const onboardingInputs: unknown[] = [];
    const existingCreatorSession: AuthKitSession = {
      ...session,
      organizationId: "org_workos_existing_creator",
      sealedSession: "existing-creator-session",
      user: {
        ...session.user,
        id: "user_workos_invited_owner",
        email: "owner@example.test",
      },
    };
    const invitedHotelSession: AuthKitSession = {
      ...existingCreatorSession,
      organizationId: "org_workos_invite_hotel",
      sealedSession: "invite-hotel-session",
      accessToken: "invite-hotel-access-token",
    };

    app = buildAuthSessionApp({
      allowedOrigins: ["https://marketplace.localhost"],
      authKitClient: createAuthKitClient({
        async authenticateSession() {
          return existingCreatorSession;
        },
        async createSignupOrganization(input) {
          expect(input).toMatchObject({
            name: "Alpenrose Hospitality",
            externalId: inviteExternalId,
          });
          expect(JSON.stringify(input)).not.toContain(inviteCode);
          return { organizationId: "org_workos_invite_hotel" };
        },
        async ensureSignupOrganizationMembership(input) {
          expect(input).toEqual({
            workosUserId: "user_workos_invited_owner",
            workosOrganizationId: "org_workos_invite_hotel",
            roleKey: "hotel_owner",
          });
          return {
            membershipId: "om_invite_hotel",
            roleSlugs: ["hotel_owner"],
            status: "active",
          };
        },
        async refreshSession(input) {
          expect(input).toEqual({
            sealedSession: "existing-creator-session",
            organizationId: "org_workos_invite_hotel",
          });
          return invitedHotelSession;
        },
      }),
      identityRepository: createIdentityRepository({
        userByProviderUserId: async () => ({
          userId: "user_invited_owner",
          email: "owner@example.test",
          status: "active",
        }),
        organizationByWorkosOrgId: async (workosOrgId) =>
          workosOrgId === "org_workos_invite_hotel"
            ? {
                organizationId: "org_invite_hotel",
                workosOrgId,
                name: "Alpenrose Hospitality",
                kind: "hotel_group",
                status: "active",
              }
            : {
                organizationId: "org_existing_creator",
                workosOrgId,
                name: "Existing Creator Workspace",
                kind: "creator_workspace",
                status: "active",
              },
        activeMembership: async (_userId, organizationId) => ({
          membershipId: `membership_${organizationId}`,
          status: "active",
          roleKey: organizationId === "org_invite_hotel" ? "hotel_owner" : "creator_owner",
          workosMembershipId:
            organizationId === "org_invite_hotel" ? "om_invite_hotel" : "om_existing_creator",
          workosRoleSlugs: [
            organizationId === "org_invite_hotel" ? "hotel_owner" : "creator_owner",
          ],
        }),
      }),
      lifecycleCommandBus: {
        async execute(command) {
          commands.push(command);
          return {
            status: "accepted",
            commandId: command.commandId,
            idempotencyKey: command.idempotencyKey,
            events: [],
          };
        },
      },
      hotelAccountInviteOnboarding: {
        async resolveForOnboarding(input) {
          onboardingInputs.push(input);
          return {
            inviteId,
            organizationName: "Alpenrose Hospitality",
            organizationExternalId: inviteExternalId,
          };
        },
      },
      surfacePolicies: {
        "marketplace-web": {
          requiredOrganizationKind: ["creator_workspace", "hotel_group"],
        },
      },
    });

    const response = await app.inject({
      method: "POST",
      url: "/auth/onboarding",
      headers: {
        cookie: "vayada_workos_session=sealed-session; vayada_auth_csrf=csrf-token",
        origin: "https://marketplace.localhost",
        "x-vayada-csrf": "csrf-token",
      },
      payload: { type: "hotel", surface: "marketplace-web", inviteCode },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      organizationId: "org_invite_hotel",
      organizationKind: "hotel_group",
      workosOrganizationId: "org_workos_invite_hotel",
    });
    expect(onboardingInputs).toEqual([
      expect.objectContaining({
        code: inviteCode,
        actorEmail: "owner@example.test",
      }),
    ]);
    expect(commands).toEqual([
      expect.objectContaining({
        commandType: "identity.access.grant",
        idempotencyKey: `workos-onboarding:user_invited_owner:hotel:invite:${inviteId}`,
        payload: expect.objectContaining({
          organization: expect.objectContaining({
            name: "Alpenrose Hospitality",
            workosExternalId: inviteExternalId,
          }),
          membership: expect.objectContaining({
            permissionKeys: [
              "hotel_catalog.setup.read",
              "hotel_catalog.setup.manage",
              "hotel_catalog.products.manage",
            ],
          }),
        }),
      }),
    ]);
    expect(JSON.stringify(commands)).not.toContain(inviteCode);
  });

  it.each(["VAY-invalid-or-unavailable", "", "   ", "not-an-invite-code"])(
    "does not provision an organization when invite onboarding validation fails for %j",
    async (inviteCode) => {
      const createOrganization = vi.fn(async () => ({ organizationId: "unexpected" }));
      const resolveForOnboarding = vi.fn(async () => null);
      const noOrgSession = { ...session, organizationId: undefined };
      app = buildAuthSessionApp({
        allowedOrigins: ["https://marketplace.localhost"],
        authKitClient: createAuthKitClient({
          async authenticateSession() {
            return noOrgSession;
          },
          createSignupOrganization: createOrganization,
        }),
        identityRepository: createIdentityRepository({
          userByProviderUserId: async () => user,
        }),
        hotelAccountInviteOnboarding: {
          resolveForOnboarding,
        },
        surfacePolicies: {
          "marketplace-web": {
            requiredOrganizationKind: ["creator_workspace", "hotel_group"],
            allowMissingOrganization: true,
          },
        },
      });

      const response = await app.inject({
        method: "POST",
        url: "/auth/onboarding",
        headers: {
          cookie: "vayada_workos_session=sealed-session; vayada_auth_csrf=csrf-token",
          origin: "https://marketplace.localhost",
          "x-vayada-csrf": "csrf-token",
        },
        payload: {
          type: "hotel",
          surface: "marketplace-web",
          inviteCode,
        },
      });

      expect(response.statusCode).toBe(403);
      expect(response.json()).toEqual({
        state: "auth_failed",
        message: "This hotel account invitation is invalid or no longer available.",
      });
      expect(resolveForOnboarding).toHaveBeenCalledWith(
        expect.objectContaining({ code: inviteCode }),
      );
      expect(createOrganization).not.toHaveBeenCalled();
    },
  );

  it("persists a refreshed WorkOS session when onboarding is already complete", async () => {
    const existingCreatorSession: AuthKitSession = {
      ...session,
      sealedSession: "creator-onboarding-refreshed-session",
      organizationId: "org_workos_creator_workspace",
      user: {
        ...session.user,
        id: "user_workos_creator",
        email: "creator@example.com",
      },
    };
    app = buildAuthSessionApp({
      allowedOrigins: ["https://marketplace.localhost"],
      authKitClient: createAuthKitClient({
        async authenticateSession() {
          return existingCreatorSession;
        },
      }),
      identityRepository: createIdentityRepository({
        userByProviderUserId: async () => ({
          userId: "user_creator",
          email: "creator@example.com",
          status: "active",
        }),
        organizationByWorkosOrgId: async () => ({
          organizationId: "org_creator_workspace",
          workosOrgId: "org_workos_creator_workspace",
          name: "Creator Workspace",
          kind: "creator_workspace",
          status: "active",
        }),
        activeMembership: async () => ({
          membershipId: "membership_creator",
          status: "active",
          roleKey: "creator_owner",
          workosMembershipId: "om_creator",
          workosRoleSlugs: ["creator_owner"],
        }),
      }),
      surfacePolicies: {
        "marketplace-web": {
          requiredOrganizationKind: ["creator_workspace", "hotel_group"],
        },
      },
    });

    const response = await app.inject({
      method: "POST",
      url: "/auth/onboarding",
      headers: {
        cookie: "vayada_workos_session=sealed-session; vayada_auth_csrf=csrf-token",
        origin: "https://marketplace.localhost",
        "x-vayada-csrf": "csrf-token",
      },
      payload: { type: "creator", surface: "marketplace-web" },
    });

    expect(response.statusCode).toBe(200);
    expect(String(response.headers["set-cookie"])).toContain(
      "vayada_workos_session=creator-onboarding-refreshed-session",
    );
  });

  it("updates account details and profile media only for the signed-in user", async () => {
    const commands: IdentityLifecycleCommand[] = [];
    const workosNameUpdates: Array<{
      workosUserId: string;
      firstName: string;
      lastName: string;
    }> = [];
    let failWorkosNameUpdate = false;
    const hotelSession: AuthKitSession = {
      ...session,
      sealedSession: "profile-refreshed-session",
      organizationId: "org_workos_hotel_group",
      user: {
        ...session.user,
        id: "user_workos_hotel",
        email: "owner@alpenrose.example",
      },
    };
    app = buildAuthSessionApp({
      allowedOrigins: ["https://marketplace.localhost"],
      authKitClient: createAuthKitClient({
        async authenticateSession() {
          return hotelSession;
        },
        async updateUserName(input) {
          if (failWorkosNameUpdate) throw new Error("WorkOS unavailable");
          workosNameUpdates.push(input);
        },
      }),
      identityRepository: createIdentityRepository({
        userByProviderUserId: async () => ({
          userId: "user_hotel_owner",
          email: "owner@alpenrose.example",
          status: "active",
        }),
        organizationByWorkosOrgId: async () => ({
          organizationId: "org_hotel_group",
          workosOrgId: "org_workos_hotel_group",
          name: "Alpenrose Hotel Group",
          kind: "hotel_group",
          status: "active",
        }),
        activeMembership: async () => ({
          membershipId: "membership_hotel_owner",
          status: "active",
          roleKey: "hotel_owner",
          workosMembershipId: "om_hotel_owner",
          workosRoleSlugs: ["hotel_owner"],
        }),
      }),
      lifecycleCommandBus: {
        async execute(command) {
          commands.push(command);
          return {
            status: "accepted",
            commandId: command.commandId,
            idempotencyKey: command.idempotencyKey,
            events: [],
          };
        },
      },
      surfacePolicies: {
        "marketplace-web": {
          requiredOrganizationKind: ["creator_workspace", "hotel_group"],
        },
      },
      profileImageMediaRepository: approvedProfileImageRepository({
        actorUserId: "user_hotel_owner",
        ownerOrganizationId: "org_hotel_group",
      }),
    });

    const response = await app.inject({
      method: "POST",
      url: "/auth/profile",
      headers: {
        cookie: "vayada_workos_session=sealed-session; vayada_auth_csrf=csrf-token",
        origin: "https://marketplace.localhost",
        "x-vayada-csrf": "csrf-token",
      },
      payload: {
        surface: "marketplace-web",
        firstName: "Mary Jane",
        lastName: "Watson",
        phone: "+49 89 987654",
        profilePictureUrl: "https://media.example/users/profile.webp",
        profilePictureMediaObjectId: "media_profile_1",
      },
    });

    expect(response.statusCode).toBe(200);
    expect(String(response.headers["set-cookie"])).toContain(
      "vayada_workos_session=profile-refreshed-session",
    );
    expect(workosNameUpdates).toEqual([
      {
        workosUserId: "user_workos_hotel",
        firstName: "Mary Jane",
        lastName: "Watson",
      },
    ]);
    expect(commands).toEqual([
      expect.objectContaining({
        commandType: "identity.user.profile.update",
        payload: expect.objectContaining({
          userId: "user_hotel_owner",
          name: "Mary Jane Watson",
          phone: "+49 89 987654",
          profilePictureUrl: "https://media.example/users/profile.webp",
          profilePictureMediaObjectId: "media_profile_1",
        }),
      }),
    ]);

    const invalidPhone = await app.inject({
      method: "POST",
      url: "/auth/profile",
      headers: {
        cookie: "vayada_workos_session=sealed-session; vayada_auth_csrf=csrf-token",
        origin: "https://marketplace.localhost",
        "x-vayada-csrf": "csrf-token",
      },
      payload: {
        surface: "marketplace-web",
        phone: "sdfdsfsfsdfdsf",
      },
    });

    expect(invalidPhone.statusCode).toBe(400);
    expect(commands).toHaveLength(1);

    const clearedPhone = await app.inject({
      method: "POST",
      url: "/auth/profile",
      headers: {
        cookie: "vayada_workos_session=sealed-session; vayada_auth_csrf=csrf-token",
        origin: "https://marketplace.localhost",
        "x-vayada-csrf": "csrf-token",
      },
      payload: {
        surface: "marketplace-web",
        phone: "",
      },
    });

    expect(clearedPhone.statusCode).toBe(200);
    expect(commands[1]).toEqual(
      expect.objectContaining({
        commandType: "identity.user.profile.update",
        payload: expect.objectContaining({ userId: "user_hotel_owner", phone: null }),
      }),
    );
    expect(workosNameUpdates).toHaveLength(1);

    const clearedPhoto = await app.inject({
      method: "POST",
      url: "/auth/profile",
      headers: {
        cookie: "vayada_workos_session=sealed-session; vayada_auth_csrf=csrf-token",
        origin: "https://marketplace.localhost",
        "x-vayada-csrf": "csrf-token",
      },
      payload: {
        surface: "marketplace-web",
        profilePictureUrl: "",
        profilePictureMediaObjectId: "",
      },
    });

    expect(clearedPhoto.statusCode).toBe(200);
    expect(commands[2]).toEqual(
      expect.objectContaining({
        commandType: "identity.user.profile.update",
        payload: expect.objectContaining({
          userId: "user_hotel_owner",
          profilePictureUrl: null,
          profilePictureMediaObjectId: null,
        }),
      }),
    );

    const forged = await app.inject({
      method: "POST",
      url: "/auth/profile",
      headers: {
        cookie: "vayada_workos_session=sealed-session; vayada_auth_csrf=csrf-token",
        origin: "https://marketplace.localhost",
        "x-vayada-csrf": "csrf-token",
      },
      payload: {
        surface: "marketplace-web",
        userId: "user_someone_else",
        profilePictureUrl: "https://media.example/other.webp",
      },
    });

    expect(forged.statusCode).toBe(400);
    expect(commands).toHaveLength(3);

    failWorkosNameUpdate = true;
    const unavailable = await app.inject({
      method: "POST",
      url: "/auth/profile",
      headers: {
        cookie: "vayada_workos_session=sealed-session; vayada_auth_csrf=csrf-token",
        origin: "https://marketplace.localhost",
        "x-vayada-csrf": "csrf-token",
      },
      payload: {
        surface: "marketplace-web",
        firstName: "Mary",
        lastName: "Watson",
      },
    });

    expect(unavailable.statusCode).toBe(500);
    expect(commands).toHaveLength(3);
  });

  it("auto-selects a single PMS hotel-group organization without showing a selector", async () => {
    const noOrgSession: AuthKitSession = {
      ...session,
      organizationId: undefined,
      user: {
        ...session.user,
        id: "user_workos_hotel",
        email: "hotel@example.com",
      },
    };
    const pmsSession: AuthKitSession = {
      ...noOrgSession,
      accessToken: "pms-workos-access-token",
      sealedSession: "pms-sealed-session",
      organizationId: "org_workos_hotel_group",
    };
    let refreshedOrganizationId: string | undefined;

    app = buildAuthSessionApp({
      allowedOrigins: ["https://pms.localhost"],
      authKitClient: createAuthKitClient({
        async authenticateSession() {
          return noOrgSession;
        },
        async refreshSession(input) {
          refreshedOrganizationId = input.organizationId;
          return pmsSession;
        },
      }),
      tokenVerifier: createTokenVerifier(noOrgSession),
      identityRepository: createIdentityRepository({
        userByProviderUserId: async () => ({
          userId: "user_hotel_admin",
          email: "hotel@example.com",
          status: "active",
        }),
        membershipOrganizations: async () => [
          {
            organizationId: "org_platform",
            workosOrgId: "org_workos_platform",
            name: "Vayada Platform",
            kind: "platform",
            status: "active",
            membership: {
              membershipId: "membership_platform",
              status: "active",
              roleKey: "platform_admin",
              workosMembershipId: "om_platform",
              workosRoleSlugs: ["platform_admin"],
            },
          },
          {
            organizationId: "org_creator",
            workosOrgId: "org_workos_creator",
            name: "Creator Workspace",
            kind: "creator_workspace",
            status: "active",
            membership: {
              membershipId: "membership_creator",
              status: "active",
              roleKey: "creator_owner",
              workosMembershipId: "om_creator",
              workosRoleSlugs: ["creator_owner"],
            },
          },
          {
            organizationId: "org_affiliate",
            workosOrgId: "org_workos_affiliate",
            name: "Affiliate Partner",
            kind: "affiliate_partner",
            status: "active",
            membership: {
              membershipId: "membership_affiliate",
              status: "active",
              roleKey: "affiliate_owner",
              workosMembershipId: "om_affiliate",
              workosRoleSlugs: ["affiliate_owner"],
            },
          },
          {
            organizationId: "org_hotel_group",
            workosOrgId: "org_workos_hotel_group",
            name: "Alpenrose Hotel Group",
            kind: "hotel_group",
            status: "active",
            membership: {
              membershipId: "membership_hotel",
              status: "active",
              roleKey: "hotel_owner",
              workosMembershipId: "om_hotel",
              workosRoleSlugs: ["hotel_owner"],
            },
          },
        ],
        organizationByWorkosOrgId: async () => ({
          organizationId: "org_hotel_group",
          workosOrgId: "org_workos_hotel_group",
          name: "Alpenrose Hotel Group",
          kind: "hotel_group",
          status: "active",
        }),
        activeMembership: async () => ({
          membershipId: "membership_hotel",
          status: "active",
          roleKey: "hotel_owner",
          workosMembershipId: "om_hotel",
          workosRoleSlugs: ["hotel_owner"],
        }),
        linkedResources: async () => [],
      }),
      surfacePolicies: {
        "pms-web": {
          requiredOrganizationKind: "hotel_group",
          logoutReturnUrl: "https://pms.localhost/login",
          requireExplicitOrganizationSelection: true,
          selectedOrganizationCookieName: "vayada_pms_selected_org",
          requiredResourceLink: { product: "pms", resourceType: "pms_property" },
        },
      },
    });

    const response = await app.inject({
      method: "GET",
      url: "/auth/session?surface=pms-web",
      headers: {
        cookie: "vayada_workos_session=sealed-session; vayada_auth_csrf=csrf-token",
        origin: "https://pms.localhost",
      },
    });

    expect(response.statusCode).toBe(200);
    expect(refreshedOrganizationId).toBe("org_workos_hotel_group");
    expect(response.headers["set-cookie"]).toEqual(
      expect.arrayContaining([
        expect.stringContaining("vayada_workos_session=pms-sealed-session"),
        expect.stringContaining("vayada_pms_selected_org=org_workos_hotel_group"),
      ]),
    );
    expect(response.json()).toMatchObject({
      accessToken: "pms-workos-access-token",
      organizationId: "org_hotel_group",
      workosOrganizationId: "org_workos_hotel_group",
      organizationKind: "hotel_group",
      user: {
        id: "user_hotel_admin",
        email: "hotel@example.com",
      },
    });
    expect(response.json().organizationSelectionRequired).toBeUndefined();
    expect(response.json().resources).toEqual({ "pms:pms_property": [] });
  });

  it("returns a PMS organization selector filtered to active hotel groups", async () => {
    const noOrgSession: AuthKitSession = {
      ...session,
      sealedSession: "refreshed-no-org-session",
      organizationId: undefined,
    };
    const refreshedNoOrgSession: AuthKitSession = {
      ...noOrgSession,
      sealedSession: "refreshed-no-org-session-after-refresh",
    };
    app = buildAuthSessionApp({
      allowedOrigins: ["https://pms.localhost"],
      authKitClient: createAuthKitClient({
        async authenticateSession() {
          return noOrgSession;
        },
        async refreshSession() {
          return refreshedNoOrgSession;
        },
      }),
      tokenVerifier: createTokenVerifier(noOrgSession),
      identityRepository: createIdentityRepository({
        membershipOrganizations: async () => [
          {
            organizationId: "org_platform",
            workosOrgId: "org_workos_platform",
            name: "Vayada Platform",
            kind: "platform",
            status: "active",
            membership: {
              membershipId: "membership_platform",
              status: "active",
              roleKey: "platform_admin",
              workosMembershipId: "om_platform",
              workosRoleSlugs: ["platform_admin"],
            },
          },
          {
            organizationId: "org_creator",
            workosOrgId: "org_workos_creator",
            name: "Creator Workspace",
            kind: "creator_workspace",
            status: "active",
            membership: {
              membershipId: "membership_creator",
              status: "active",
              roleKey: "creator_owner",
              workosMembershipId: "om_creator",
              workosRoleSlugs: ["creator_owner"],
            },
          },
          {
            organizationId: "org_affiliate",
            workosOrgId: "org_workos_affiliate",
            name: "Affiliate Partner",
            kind: "affiliate_partner",
            status: "active",
            membership: {
              membershipId: "membership_affiliate",
              status: "active",
              roleKey: "affiliate_owner",
              workosMembershipId: "om_affiliate",
              workosRoleSlugs: ["affiliate_owner"],
            },
          },
          {
            organizationId: "org_hotel_alpenrose",
            workosOrgId: "org_workos_hotel_alpenrose",
            name: "Alpenrose Hotel Group",
            kind: "hotel_group",
            status: "active",
            membership: {
              membershipId: "membership_alpenrose",
              status: "active",
              roleKey: "hotel_owner",
              workosMembershipId: "om_alpenrose",
              workosRoleSlugs: ["hotel_owner"],
            },
          },
          {
            organizationId: "org_hotel_salzburg",
            workosOrgId: "org_workos_hotel_salzburg",
            name: "Alpenrose Salzburg",
            kind: "hotel_group",
            status: "active",
            membership: {
              membershipId: "membership_salzburg",
              status: "active",
              roleKey: "hotel_admin",
              workosMembershipId: "om_salzburg",
              workosRoleSlugs: ["hotel_admin"],
            },
          },
          {
            organizationId: "org_hotel_archived",
            workosOrgId: "org_workos_hotel_archived",
            name: "Archived Hotel",
            kind: "hotel_group",
            status: "archived",
            membership: {
              membershipId: "membership_archived",
              status: "active",
              roleKey: "hotel_admin",
              workosMembershipId: "om_archived",
              workosRoleSlugs: ["hotel_admin"],
            },
          },
        ],
      }),
      surfacePolicies: {
        "pms-web": {
          requiredOrganizationKind: "hotel_group",
          logoutReturnUrl: "https://pms.localhost/login",
        },
      },
    });

    const response = await app.inject({
      method: "GET",
      url: "/auth/session?surface=pms-web",
      headers: {
        cookie: "vayada_workos_session=sealed-session; vayada_auth_csrf=csrf-token",
        origin: "https://pms.localhost",
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      organizationSelectionRequired: true,
      csrfToken: expect.any(String),
      organizations: [
        {
          organizationId: "org_hotel_alpenrose",
          workosOrganizationId: "org_workos_hotel_alpenrose",
          displayName: "Alpenrose Hotel Group",
          kind: "hotel_group",
        },
        {
          organizationId: "org_hotel_salzburg",
          workosOrganizationId: "org_workos_hotel_salzburg",
          displayName: "Alpenrose Salzburg",
          kind: "hotel_group",
        },
      ],
    });
    expect(response.headers["set-cookie"]).toEqual(
      expect.arrayContaining([
        expect.stringContaining("vayada_workos_session=refreshed-no-org-session"),
        expect.stringContaining("vayada_auth_csrf="),
      ]),
    );

    const refreshResponse = await app.inject({
      method: "POST",
      url: "/auth/session/refresh",
      headers: {
        cookie: "vayada_workos_session=sealed-session; vayada_auth_csrf=csrf-token",
        origin: "https://pms.localhost",
        "x-vayada-csrf": "csrf-token",
      },
      payload: { surface: "pms-web" },
    });

    expect(refreshResponse.statusCode).toBe(200);
    expect(refreshResponse.json()).toMatchObject({
      organizationSelectionRequired: true,
      csrfToken: expect.any(String),
    });
    expect(refreshResponse.headers["set-cookie"]).toEqual(
      expect.arrayContaining([
        expect.stringContaining("vayada_workos_session=refreshed-no-org-session-after-refresh"),
        expect.stringContaining("vayada_auth_csrf="),
      ]),
    );
  });

  it("requires PMS organization selection when an ambient WorkOS org is ambiguous", async () => {
    const pmsSession: AuthKitSession = {
      ...session,
      sealedSession: "refreshed-ambiguous-pms-session",
      organizationId: "org_workos_hotel_alpenrose",
      user: {
        ...session.user,
        id: "user_workos_hotel",
        email: "hotel@example.com",
      },
    };
    app = buildAuthSessionApp({
      allowedOrigins: ["https://pms.localhost"],
      authKitClient: createAuthKitClient({
        async authenticateSession() {
          return null;
        },
        async refreshSession() {
          return { ...pmsSession, sealedSession: "refreshed-pms-unselected-session" };
        },
      }),
      tokenVerifier: createTokenVerifier(pmsSession),
      identityRepository: createIdentityRepository({
        userByProviderUserId: async () => ({
          userId: "user_hotel_admin",
          email: "hotel@example.com",
          status: "active",
        }),
        organizationByWorkosOrgId: async () => ({
          organizationId: "org_hotel_alpenrose",
          workosOrgId: "org_workos_hotel_alpenrose",
          name: "Alpenrose Hotel Group",
          kind: "hotel_group",
          status: "active",
        }),
        activeMembership: async () => ({
          membershipId: "membership_alpenrose",
          status: "active",
          roleKey: "hotel_owner",
          workosMembershipId: "om_alpenrose",
          workosRoleSlugs: ["hotel_owner"],
        }),
        membershipOrganizations: async () => [
          {
            organizationId: "org_hotel_alpenrose",
            workosOrgId: "org_workos_hotel_alpenrose",
            name: "Alpenrose Hotel Group",
            kind: "hotel_group",
            status: "active",
            membership: {
              membershipId: "membership_alpenrose",
              status: "active",
              roleKey: "hotel_owner",
              workosMembershipId: "om_alpenrose",
              workosRoleSlugs: ["hotel_owner"],
            },
          },
          {
            organizationId: "org_hotel_salzburg",
            workosOrgId: "org_workos_hotel_salzburg",
            name: "Alpenrose Salzburg",
            kind: "hotel_group",
            status: "active",
            membership: {
              membershipId: "membership_salzburg",
              status: "active",
              roleKey: "hotel_admin",
              workosMembershipId: "om_salzburg",
              workosRoleSlugs: ["hotel_admin"],
            },
          },
        ],
      }),
      surfacePolicies: {
        "pms-web": {
          requiredOrganizationKind: "hotel_group",
          logoutReturnUrl: "https://pms.localhost/login",
          requireExplicitOrganizationSelection: true,
          selectedOrganizationCookieName: "vayada_pms_selected_org",
        },
      },
    });

    const response = await app.inject({
      method: "GET",
      url: "/auth/session?surface=pms-web",
      headers: {
        cookie: "vayada_workos_session=sealed-session; vayada_auth_csrf=csrf-token",
        origin: "https://pms.localhost",
      },
    });

    expect(response.statusCode).toBe(200);
    expect(String(response.headers["set-cookie"])).toContain(
      "vayada_workos_session=refreshed-pms-unselected-session",
    );
    expect(response.json()).toMatchObject({
      organizationSelectionRequired: true,
      csrfToken: expect.any(String),
      organizations: [
        {
          organizationId: "org_hotel_alpenrose",
          workosOrganizationId: "org_workos_hotel_alpenrose",
          displayName: "Alpenrose Hotel Group",
          kind: "hotel_group",
        },
        {
          organizationId: "org_hotel_salzburg",
          workosOrganizationId: "org_workos_hotel_salzburg",
          displayName: "Alpenrose Salzburg",
          kind: "hotel_group",
        },
      ],
    });
    expect(response.headers["set-cookie"]).toEqual(
      expect.arrayContaining([
        expect.stringContaining("vayada_workos_session=refreshed-pms-unselected-session"),
        expect.stringContaining("vayada_auth_csrf="),
      ]),
    );

    const refreshResponse = await app.inject({
      method: "POST",
      url: "/auth/session/refresh",
      headers: {
        cookie: "vayada_workos_session=expired-session; vayada_auth_csrf=csrf-token",
        origin: "https://pms.localhost",
        "x-vayada-csrf": "csrf-token",
      },
      payload: { surface: "pms-web" },
    });
    expect(refreshResponse.statusCode).toBe(200);
    expect(refreshResponse.json()).toMatchObject({ organizationSelectionRequired: true });
    expect(String(refreshResponse.headers["set-cookie"])).toContain(
      "vayada_workos_session=refreshed-pms-unselected-session",
    );
  });

  it("returns a PMS organization selector from the compatibility token route when selection is required", async () => {
    const pmsSession: AuthKitSession = {
      ...session,
      organizationId: "org_workos_hotel_alpenrose",
      user: {
        ...session.user,
        id: "user_workos_hotel",
        email: "hotel@example.com",
      },
    };
    app = buildAuthSessionApp({
      allowedOrigins: ["https://pms.localhost"],
      authKitClient: createAuthKitClient({
        async authenticateSession() {
          return pmsSession;
        },
      }),
      tokenVerifier: createTokenVerifier(pmsSession),
      identityRepository: createIdentityRepository({
        userByProviderUserId: async () => ({
          userId: "user_hotel_admin",
          email: "hotel@example.com",
          status: "active",
        }),
        organizationByWorkosOrgId: async () => ({
          organizationId: "org_hotel_alpenrose",
          workosOrgId: "org_workos_hotel_alpenrose",
          name: "Alpenrose Hotel Group",
          kind: "hotel_group",
          status: "active",
        }),
        activeMembership: async () => ({
          membershipId: "membership_alpenrose",
          status: "active",
          roleKey: "hotel_owner",
          workosMembershipId: "om_alpenrose",
          workosRoleSlugs: ["hotel_owner"],
        }),
        membershipOrganizations: async () => [
          {
            organizationId: "org_hotel_alpenrose",
            workosOrgId: "org_workos_hotel_alpenrose",
            name: "Alpenrose Hotel Group",
            kind: "hotel_group",
            status: "active",
            membership: {
              membershipId: "membership_alpenrose",
              status: "active",
              roleKey: "hotel_owner",
              workosMembershipId: "om_alpenrose",
              workosRoleSlugs: ["hotel_owner"],
            },
          },
          {
            organizationId: "org_hotel_salzburg",
            workosOrgId: "org_workos_hotel_salzburg",
            name: "Alpenrose Salzburg",
            kind: "hotel_group",
            status: "active",
            membership: {
              membershipId: "membership_salzburg",
              status: "active",
              roleKey: "hotel_admin",
              workosMembershipId: "om_salzburg",
              workosRoleSlugs: ["hotel_admin"],
            },
          },
        ],
      }),
      surfacePolicies: {
        "pms-web": {
          requiredOrganizationKind: "hotel_group",
          logoutReturnUrl: "https://pms.localhost/login",
          legacyJwtSecret: "legacy-pms-secret",
          legacyJwtUserType: "hotel",
          requireExplicitOrganizationSelection: true,
          selectedOrganizationCookieName: "vayada_pms_selected_org",
          requiredResourceLink: { product: "pms", resourceType: "pms_property" },
        },
      },
    });

    const response = await app.inject({
      method: "POST",
      url: "/auth/compat/pms-web-token",
      headers: {
        cookie: "vayada_workos_session=sealed-session; vayada_auth_csrf=csrf-token",
        origin: "https://pms.localhost",
        "x-vayada-csrf": "csrf-token",
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      organizationSelectionRequired: true,
      csrfToken: "csrf-token",
      user: {
        id: "user_hotel_admin",
        email: "hotel@example.com",
      },
      organizations: [
        {
          organizationId: "org_hotel_alpenrose",
          workosOrganizationId: "org_workos_hotel_alpenrose",
          displayName: "Alpenrose Hotel Group",
          kind: "hotel_group",
        },
        {
          organizationId: "org_hotel_salzburg",
          workosOrganizationId: "org_workos_hotel_salzburg",
          displayName: "Alpenrose Salzburg",
          kind: "hotel_group",
        },
      ],
    });
  });

  it("stores the explicitly selected PMS organization after refresh", async () => {
    const pmsSession: AuthKitSession = {
      ...session,
      accessToken: "pms-workos-access-token",
      sealedSession: "pms-sealed-session",
      organizationId: "org_workos_hotel_salzburg",
      user: {
        ...session.user,
        id: "user_workos_hotel",
        email: "hotel@example.com",
      },
    };
    let refreshedOrganizationId: string | undefined;
    app = buildAuthSessionApp({
      allowedOrigins: ["https://pms.localhost"],
      authKitClient: createAuthKitClient({
        async refreshSession(input) {
          refreshedOrganizationId = input.organizationId;
          return pmsSession;
        },
      }),
      tokenVerifier: createTokenVerifier(pmsSession),
      identityRepository: createIdentityRepository({
        userByProviderUserId: async () => ({
          userId: "user_hotel_admin",
          email: "hotel@example.com",
          status: "active",
        }),
        organizationByWorkosOrgId: async () => ({
          organizationId: "org_hotel_salzburg",
          workosOrgId: "org_workos_hotel_salzburg",
          name: "Alpenrose Salzburg",
          kind: "hotel_group",
          status: "active",
        }),
        activeMembership: async () => ({
          membershipId: "membership_salzburg",
          status: "active",
          roleKey: "hotel_admin",
          workosMembershipId: "om_salzburg",
          workosRoleSlugs: ["hotel_admin"],
        }),
        membershipOrganizations: async () => [
          {
            organizationId: "org_hotel_alpenrose",
            workosOrgId: "org_workos_hotel_alpenrose",
            name: "Alpenrose Hotel Group",
            kind: "hotel_group",
            status: "active",
            membership: {
              membershipId: "membership_alpenrose",
              status: "active",
              roleKey: "hotel_owner",
              workosMembershipId: "om_alpenrose",
              workosRoleSlugs: ["hotel_owner"],
            },
          },
          {
            organizationId: "org_hotel_salzburg",
            workosOrgId: "org_workos_hotel_salzburg",
            name: "Alpenrose Salzburg",
            kind: "hotel_group",
            status: "active",
            membership: {
              membershipId: "membership_salzburg",
              status: "active",
              roleKey: "hotel_admin",
              workosMembershipId: "om_salzburg",
              workosRoleSlugs: ["hotel_admin"],
            },
          },
        ],
      }),
      surfacePolicies: {
        "pms-web": {
          requiredOrganizationKind: "hotel_group",
          logoutReturnUrl: "https://pms.localhost/login",
          requireExplicitOrganizationSelection: true,
          selectedOrganizationCookieName: "vayada_pms_selected_org",
        },
      },
    });

    const response = await app.inject({
      method: "POST",
      url: "/auth/session/refresh",
      headers: {
        cookie: "vayada_workos_session=sealed-session; vayada_auth_csrf=csrf-token",
        origin: "https://pms.localhost",
        "x-vayada-csrf": "csrf-token",
      },
      payload: {
        organizationId: "org_workos_hotel_salzburg",
        surface: "pms-web",
      },
    });

    expect(response.statusCode).toBe(200);
    expect(refreshedOrganizationId).toBe("org_workos_hotel_salzburg");
    expect(response.headers["set-cookie"]).toEqual(
      expect.arrayContaining([
        expect.stringContaining("vayada_workos_session=pms-sealed-session"),
        expect.stringContaining("vayada_pms_selected_org=org_workos_hotel_salzburg"),
      ]),
    );
    expect(response.json()).toMatchObject({
      organizationId: "org_hotel_salzburg",
      workosOrganizationId: "org_workos_hotel_salzburg",
      organizationKind: "hotel_group",
    });
  });

  it("refreshes a sealed session and returns an in-memory bearer token", async () => {
    app = buildAuthSessionApp();

    const response = await app.inject({
      method: "POST",
      url: "/auth/session/refresh",
      headers: {
        cookie: "vayada_workos_session=sealed-session; vayada_auth_csrf=csrf-token",
        origin: "https://admin.localhost",
        "x-vayada-csrf": "csrf-token",
      },
      payload: {
        organizationId: "org_workos_platform",
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().accessToken).toBe("refreshed-workos-access-token");
    expect(response.json().csrfToken).toBe("csrf-token");
    expect(response.headers["set-cookie"]).toContain(
      "vayada_workos_session=refreshed-sealed-session",
    );
  });

  it("refreshes an expired sealed session during cookie bootstrap", async () => {
    const authenticateSession = vi.fn(async () => null);
    const refreshSession = vi.fn(async () => ({
      ...session,
      accessToken: "refreshed-workos-access-token",
      sealedSession: "refreshed-sealed-session",
    }));
    app = buildAuthSessionApp({
      authKitClient: createAuthKitClient({ authenticateSession, refreshSession }),
    });

    const response = await app.inject({
      method: "GET",
      url: "/auth/session?surface=platform-admin",
      headers: {
        cookie: "vayada_workos_session=expired-sealed-session; vayada_auth_csrf=csrf-token",
        origin: "https://admin.localhost",
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().accessToken).toBe("refreshed-workos-access-token");
    expect(authenticateSession).toHaveBeenCalledWith({
      sealedSession: "expired-sealed-session",
    });
    expect(refreshSession).toHaveBeenCalledWith({
      sealedSession: "expired-sealed-session",
    });
    expect(String(response.headers["set-cookie"])).toContain(
      "vayada_workos_session=refreshed-sealed-session",
    );
  });

  it("sets CORS headers for credentialed browser session refreshes", async () => {
    app = buildAuthSessionApp();

    const preflight = await app.inject({
      method: "OPTIONS",
      url: "/auth/session/refresh",
      headers: {
        origin: "https://admin.localhost",
        "access-control-request-method": "POST",
      },
    });

    expect(preflight.statusCode).toBe(204);
    expect(preflight.headers["access-control-allow-origin"]).toBe("https://admin.localhost");
    expect(preflight.headers["access-control-allow-credentials"]).toBe("true");
  });

  it("mints a short-lived marketplace admin compatibility token after platform session resolution", async () => {
    app = buildAuthSessionApp({
      legacyMarketplaceJwtSecret: "legacy-secret",
    });

    const response = await app.inject({
      method: "POST",
      url: "/auth/compat/marketplace-admin-token",
      headers: {
        cookie: "vayada_workos_session=sealed-session; vayada_auth_csrf=csrf-token",
        origin: "https://admin.localhost",
        "x-vayada-csrf": "csrf-token",
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      accessToken: expect.any(String),
      expiresIn: 900,
      tokenType: "Bearer",
    });
    expect(readJwtPayload(response.json().accessToken)).toMatchObject({
      sub: "user_platform_admin",
      email: "f.maliqi@vayada.com",
      type: "admin",
    });
  });

  it("mints a hotel-scoped booking compatibility token for a hotel-group session", async () => {
    const auditEvents: ProductAuditEvent[] = [];
    const hotelSession: AuthKitSession = {
      ...session,
      organizationId: "org_workos_hotel_group",
      user: {
        ...session.user,
        id: "user_workos_hotel",
        email: "hotel@example.com",
      },
    };
    app = buildAuthSessionApp({
      allowedOrigins: ["https://admin.booking.localhost"],
      authKitClient: createAuthKitClient({
        async authenticateSession() {
          return hotelSession;
        },
      }),
      tokenVerifier: createTokenVerifier(hotelSession),
      identityRepository: createIdentityRepository({
        userByProviderUserId: async () => ({
          userId: "user_hotel_admin",
          email: "hotel@example.com",
          status: "active",
        }),
        organizationByWorkosOrgId: async () => ({
          organizationId: "org_hotel_group",
          workosOrgId: "org_workos_hotel_group",
          name: "Alpenrose Hotel Group",
          kind: "hotel_group",
          status: "active",
        }),
        activeMembership: async () => ({
          membershipId: "membership_hotel",
          status: "active",
          roleKey: "hotel_owner",
          workosMembershipId: "om_hotel",
          workosRoleSlugs: ["hotel_owner"],
        }),
        linkedResources: async () => [
          {
            product: "hotel_catalog",
            resourceType: "property",
            resourceId: "booking_hotel_alpenrose",
            relationship: "owner",
            status: "active",
          },
          {
            product: "booking",
            resourceType: "booking_hotel",
            resourceId: "booking_hotel_alpenrose",
            relationship: "owner",
            status: "active",
          },
        ],
      }),
      surfacePolicies: {
        "booking-admin": {
          requiredOrganizationKind: "hotel_group",
          logoutReturnUrl: "https://admin.booking.localhost/login",
          legacyJwtSecret: "legacy-booking-secret",
          legacyJwtUserType: "hotel",
          requiredResourceLink: { product: "booking", resourceType: "booking_hotel" },
        },
      },
      productAuditSink: {
        async record(event) {
          auditEvents.push(event);
        },
      },
    });

    const response = await app.inject({
      method: "POST",
      url: "/auth/compat/booking-admin-token",
      headers: {
        cookie: "vayada_workos_session=sealed-session; vayada_auth_csrf=csrf-token",
        origin: "https://admin.booking.localhost",
        "x-vayada-csrf": "csrf-token",
      },
    });

    expect(response.statusCode).toBe(200);
    expect(readJwtPayload(response.json().accessToken)).toMatchObject({
      sub: "user_hotel_admin",
      email: "hotel@example.com",
      type: "hotel",
      org: "org_hotel_group",
      surface: "booking-admin",
      resources: {
        "booking:booking_hotel": ["booking_hotel_alpenrose"],
      },
    });
    expect(auditEvents).toContainEqual(
      expect.objectContaining({
        action: "auth.compatibility_token.issued",
        actorUserId: "user_hotel_admin",
        organizationId: "org_hotel_group",
        surface: "booking-admin",
        resourceScope: {
          "booking:booking_hotel": ["booking_hotel_alpenrose"],
        },
      }),
    );
  });

  it("recomputes assigned booking properties and fails closed on invalid access state", async () => {
    const hotelSession: AuthKitSession = {
      ...session,
      organizationId: "org_workos_hotel_group",
      user: {
        ...session.user,
        id: "user_workos_hotel",
        email: "hotel@example.com",
      },
    };
    let userStatus: IdentityUser["status"] = "active";
    let propertyScope: MembershipPropertyScope | null = {
      mode: "assigned",
      roleKey: "hotel_owner",
      accessOrigin: "agency",
      assignedPropertyIds: [
        "booking_hotel_bergwald",
        "booking_hotel_alpenrose",
        "foreign_property",
      ],
    };
    let propertyScopeError: Error | undefined;
    const findMembershipPropertyScope = vi.fn(async () => {
      if (propertyScopeError) throw propertyScopeError;
      return propertyScope;
    });
    app = buildAuthSessionApp({
      allowedOrigins: ["https://admin.booking.localhost"],
      authKitClient: createAuthKitClient({
        async authenticateSession() {
          return hotelSession;
        },
      }),
      tokenVerifier: createTokenVerifier(hotelSession),
      identityRepository: createIdentityRepository({
        userByProviderUserId: async () => ({
          userId: "user_hotel_admin",
          email: "hotel@example.com",
          status: userStatus,
        }),
        organizationByWorkosOrgId: async () => ({
          organizationId: "org_hotel_group",
          workosOrgId: "org_workos_hotel_group",
          name: "Alpenrose Hotel Group",
          kind: "hotel_group",
          status: "active",
        }),
        activeMembership: async () => ({
          membershipId: "membership_hotel",
          status: "active",
          roleKey: "hotel_owner",
          workosMembershipId: "om_hotel",
          workosRoleSlugs: ["hotel_owner"],
        }),
        linkedResources: async () => [
          {
            product: "hotel_catalog",
            resourceType: "property",
            resourceId: "booking_hotel_alpenrose",
            relationship: "owner",
            status: "active",
          },
          {
            product: "hotel_catalog",
            resourceType: "property",
            resourceId: "booking_hotel_bergwald",
            relationship: "operator",
            status: "active",
          },
          {
            product: "booking",
            resourceType: "booking_hotel",
            resourceId: "booking_hotel_alpenrose",
            relationship: "owner",
            status: "active",
          },
          {
            product: "booking",
            resourceType: "booking_hotel",
            resourceId: "booking_hotel_bergwald",
            relationship: "front_desk",
            status: "active",
          },
        ],
      }),
      propertyAccessRepository: { findMembershipPropertyScope },
      surfacePolicies: {
        "booking-admin": {
          requiredOrganizationKind: "hotel_group",
          logoutReturnUrl: "https://admin.booking.localhost/login",
          requiredResourceLink: { product: "booking", resourceType: "booking_hotel" },
        },
      },
    });

    const response = await app.inject({
      method: "GET",
      url: "/auth/session?surface=booking-admin",
      headers: {
        cookie: "vayada_workos_session=sealed-session; vayada_auth_csrf=csrf-token",
        origin: "https://admin.booking.localhost",
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      accessToken: "workos-access-token",
      organizationId: "org_hotel_group",
      workosOrganizationId: "org_workos_hotel_group",
      organizationKind: "hotel_group",
      resources: {
        "booking:booking_hotel": ["booking_hotel_alpenrose"],
      },
      user: {
        id: "user_hotel_admin",
        email: "hotel@example.com",
      },
    });

    propertyScope = { ...propertyScope, assignedPropertyIds: [] };
    const emptyResponse = await app.inject({
      method: "GET",
      url: "/auth/session?surface=booking-admin",
      headers: {
        cookie: "vayada_workos_session=sealed-session; vayada_auth_csrf=csrf-token",
        origin: "https://admin.booking.localhost",
      },
    });
    expect(emptyResponse.statusCode).toBe(200);
    expect(emptyResponse.json().resources).toEqual({ "booking:booking_hotel": [] });

    propertyScope = { ...propertyScope, mode: "unknown" };
    const invalidResponse = await app.inject({
      method: "GET",
      url: "/auth/session?surface=booking-admin",
      headers: {
        cookie: "vayada_workos_session=sealed-session",
        origin: "https://admin.booking.localhost",
      },
    });
    expect(invalidResponse.statusCode).toBe(403);

    propertyScopeError = new Error("database password leaked");
    const failureResponse = await app.inject({
      method: "GET",
      url: "/auth/session?surface=booking-admin",
      headers: {
        cookie: "vayada_workos_session=sealed-session",
        origin: "https://admin.booking.localhost",
      },
    });
    expect(failureResponse.statusCode).toBe(403);
    expect(failureResponse.json()).toEqual({
      error: "auth_session_rejected",
      message: "AuthKit session was rejected.",
    });

    propertyScopeError = undefined;
    userStatus = "suspended";
    const scopeCalls = findMembershipPropertyScope.mock.calls.length;
    const suspendedResponse = await app.inject({
      method: "GET",
      url: "/auth/session?surface=booking-admin",
      headers: {
        cookie: "vayada_workos_session=sealed-session",
        origin: "https://admin.booking.localhost",
      },
    });
    expect(suspendedResponse.statusCode).toBe(403);
    expect(findMembershipPropertyScope).toHaveBeenCalledTimes(scopeCalls);
  });

  it("returns an explicit empty PMS scope before a PMS product resource link exists", async () => {
    const pmsSession: AuthKitSession = {
      ...session,
      organizationId: "org_workos_hotel_group",
      user: {
        ...session.user,
        id: "user_workos_hotel",
        email: "hotel@example.com",
      },
    };
    app = buildAuthSessionApp({
      allowedOrigins: ["https://pms.localhost"],
      authKitClient: createAuthKitClient({
        async authenticateSession() {
          return pmsSession;
        },
      }),
      tokenVerifier: createTokenVerifier(pmsSession),
      identityRepository: createIdentityRepository({
        userByProviderUserId: async () => ({
          userId: "user_hotel_admin",
          email: "hotel@example.com",
          status: "active",
        }),
        organizationByWorkosOrgId: async () => ({
          organizationId: "org_hotel_group",
          workosOrgId: "org_workos_hotel_group",
          name: "Alpenrose Hotel Group",
          kind: "hotel_group",
          status: "active",
        }),
        activeMembership: async () => ({
          membershipId: "membership_hotel",
          status: "active",
          roleKey: "hotel_owner",
          workosMembershipId: "om_hotel",
          workosRoleSlugs: ["hotel_owner"],
        }),
        linkedResources: async () => [],
      }),
      surfacePolicies: {
        "pms-web": {
          requiredOrganizationKind: "hotel_group",
          logoutReturnUrl: "https://pms.localhost/login",
          requiredResourceLink: { product: "pms", resourceType: "pms_property" },
        },
      },
    });

    const response = await app.inject({
      method: "GET",
      url: "/auth/session?surface=pms-web",
      headers: {
        cookie: "vayada_workos_session=sealed-session; vayada_auth_csrf=csrf-token",
        origin: "https://pms.localhost",
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      organizationId: "org_hotel_group",
      workosOrganizationId: "org_workos_hotel_group",
      organizationKind: "hotel_group",
      user: {
        id: "user_hotel_admin",
        email: "hotel@example.com",
      },
    });
    expect(response.json().resources).toEqual({ "pms:pms_property": [] });
  });

  it("rejects hotel-admin compatibility tokens when no properties are assigned", async () => {
    const hotelSession: AuthKitSession = {
      ...session,
      organizationId: "org_workos_hotel_group",
    };
    app = buildAuthSessionApp({
      allowedOrigins: ["https://admin.booking.localhost"],
      authKitClient: createAuthKitClient({
        async authenticateSession() {
          return hotelSession;
        },
      }),
      tokenVerifier: createTokenVerifier(hotelSession),
      identityRepository: createIdentityRepository({
        organizationByWorkosOrgId: async () => ({
          organizationId: "org_hotel_group",
          workosOrgId: "org_workos_hotel_group",
          name: "Alpenrose Hotel Group",
          kind: "hotel_group",
          status: "active",
        }),
        activeMembership: async () => ({
          membershipId: "membership_hotel",
          status: "active",
          roleKey: "hotel_owner",
          workosMembershipId: "om_hotel",
          workosRoleSlugs: ["hotel_owner"],
        }),
        linkedResources: async () => [
          {
            product: "hotel_catalog",
            resourceType: "property",
            resourceId: "booking_hotel_alpenrose",
            relationship: "owner",
            status: "active",
          },
          {
            product: "booking",
            resourceType: "booking_hotel",
            resourceId: "booking_hotel_alpenrose",
            relationship: "owner",
            status: "active",
          },
        ],
      }),
      propertyAccessRepository: {
        async findMembershipPropertyScope() {
          return {
            mode: "assigned",
            roleKey: "hotel_owner",
            accessOrigin: "agency",
            assignedPropertyIds: [],
          };
        },
      },
      surfacePolicies: {
        "booking-admin": {
          requiredOrganizationKind: "hotel_group",
          logoutReturnUrl: "https://admin.booking.localhost/login",
          legacyJwtSecret: "legacy-booking-secret",
          legacyJwtUserType: "hotel",
          requiredResourceLink: { product: "booking", resourceType: "booking_hotel" },
        },
      },
    });

    const response = await app.inject({
      method: "POST",
      url: "/auth/compat/booking-admin-token",
      headers: {
        cookie: "vayada_workos_session=sealed-session; vayada_auth_csrf=csrf-token",
        origin: "https://admin.booking.localhost",
        "x-vayada-csrf": "csrf-token",
      },
    });

    expect(response.statusCode).toBe(403);
    expect(response.json().message).toContain("booking/booking_hotel resource link");
  });

  it("mints a PMS compatibility token scoped to the selected PMS property", async () => {
    const pmsSession: AuthKitSession = {
      ...session,
      organizationId: "org_workos_hotel_group",
    };
    app = buildAuthSessionApp({
      allowedOrigins: ["https://pms.localhost"],
      authKitClient: createAuthKitClient({
        async authenticateSession() {
          return pmsSession;
        },
      }),
      tokenVerifier: createTokenVerifier(pmsSession),
      identityRepository: createIdentityRepository({
        organizationByWorkosOrgId: async () => ({
          organizationId: "org_hotel_group",
          workosOrgId: "org_workos_hotel_group",
          name: "Alpenrose Hotel Group",
          kind: "hotel_group",
          status: "active",
        }),
        activeMembership: async () => ({
          membershipId: "membership_hotel",
          status: "active",
          roleKey: "hotel_owner",
          workosMembershipId: "om_hotel",
          workosRoleSlugs: ["hotel_owner"],
        }),
        linkedResources: async () => [
          {
            product: "hotel_catalog",
            resourceType: "property",
            resourceId: "property_alpenrose",
            relationship: "operator",
            status: "active",
          },
          {
            product: "pms",
            resourceType: "pms_property",
            resourceId: "property_alpenrose",
            relationship: "operator",
            status: "active",
          },
        ],
      }),
      surfacePolicies: {
        "pms-web": {
          requiredOrganizationKind: "hotel_group",
          logoutReturnUrl: "https://pms.localhost/login",
          legacyJwtSecret: "legacy-pms-secret",
          legacyJwtUserType: "hotel",
          requiredResourceLink: { product: "pms", resourceType: "pms_property" },
        },
      },
    });

    const response = await app.inject({
      method: "POST",
      url: "/auth/compat/pms-web-token",
      headers: {
        cookie: "vayada_workos_session=sealed-session; vayada_auth_csrf=csrf-token",
        origin: "https://pms.localhost",
        "x-vayada-csrf": "csrf-token",
      },
    });

    expect(response.statusCode).toBe(200);
    expect(readJwtPayload(response.json().accessToken)).toMatchObject({
      sub: "user_platform_admin",
      email: "f.maliqi@vayada.com",
      type: "hotel",
      org: "org_hotel_group",
      surface: "pms-web",
      resources: {
        "pms:pms_property": ["property_alpenrose"],
      },
    });
  });

  it("mints an affiliate-scoped compatibility token for an affiliate-partner session", async () => {
    const auditEvents: ProductAuditEvent[] = [];
    const affiliateSession: AuthKitSession = {
      ...session,
      organizationId: "org_workos_affiliate_partner",
      user: {
        ...session.user,
        id: "user_workos_affiliate",
        email: "affiliate@example.com",
      },
    };
    app = buildAuthSessionApp({
      allowedOrigins: ["https://affiliate.localhost"],
      authKitClient: createAuthKitClient({
        async authenticateSession() {
          return affiliateSession;
        },
      }),
      tokenVerifier: createTokenVerifier(affiliateSession),
      identityRepository: createIdentityRepository({
        userByProviderUserId: async () => ({
          userId: "user_affiliate",
          email: "affiliate@example.com",
          status: "active",
        }),
        organizationByWorkosOrgId: async () => ({
          organizationId: "org_affiliate_partner",
          workosOrgId: "org_workos_affiliate_partner",
          name: "Vayada Affiliate Partner",
          kind: "affiliate_partner",
          status: "active",
        }),
        activeMembership: async () => ({
          membershipId: "membership_affiliate",
          status: "active",
          roleKey: "affiliate_owner",
          workosMembershipId: "om_affiliate",
          workosRoleSlugs: ["affiliate_owner"],
        }),
        linkedResources: async () => [
          {
            product: "affiliate",
            resourceType: "affiliate",
            resourceId: "affiliate_partner_bali",
            relationship: "owner",
            status: "active",
          },
        ],
      }),
      surfacePolicies: {
        "affiliate-dashboard": {
          requiredOrganizationKind: "affiliate_partner",
          logoutReturnUrl: "https://affiliate.localhost/login",
          legacyJwtSecret: "legacy-affiliate-pms-secret",
          legacyJwtUserType: "affiliate",
          requiredResourceLink: { product: "affiliate", resourceType: "affiliate" },
        },
      },
      productAuditSink: {
        async record(event) {
          auditEvents.push(event);
        },
      },
    });

    const response = await app.inject({
      method: "POST",
      url: "/auth/compat/affiliate-dashboard-token",
      headers: {
        cookie: "vayada_workos_session=sealed-session; vayada_auth_csrf=csrf-token",
        origin: "https://affiliate.localhost",
        "x-vayada-csrf": "csrf-token",
      },
    });

    expect(response.statusCode).toBe(200);
    expect(readJwtPayload(response.json().accessToken)).toMatchObject({
      sub: "user_affiliate",
      email: "affiliate@example.com",
      type: "affiliate",
      org: "org_affiliate_partner",
      surface: "affiliate-dashboard",
      resources: {
        "affiliate:affiliate": ["affiliate_partner_bali"],
      },
    });
    expect(auditEvents).toContainEqual(
      expect.objectContaining({
        action: "auth.compatibility_token.issued",
        actorUserId: "user_affiliate",
        organizationId: "org_affiliate_partner",
        surface: "affiliate-dashboard",
        resourceScope: {
          "affiliate:affiliate": ["affiliate_partner_bali"],
        },
      }),
    );
  });

  it("returns a marketplace session for creator workspace organizations", async () => {
    const marketplaceSession: AuthKitSession = {
      ...session,
      sealedSession: "refreshed-marketplace-session",
      organizationId: "org_workos_creator_workspace",
      user: {
        ...session.user,
        id: "user_workos_creator",
        email: "creator@example.com",
      },
    };
    app = buildAuthSessionApp({
      allowedOrigins: ["https://marketplace.localhost"],
      authKitClient: createAuthKitClient({
        async authenticateSession() {
          return marketplaceSession;
        },
      }),
      tokenVerifier: createTokenVerifier(marketplaceSession),
      identityRepository: createIdentityRepository({
        userByProviderUserId: async () => ({
          userId: "user_creator",
          email: "creator@example.com",
          status: "active",
        }),
        organizationByWorkosOrgId: async () => ({
          organizationId: "org_creator_workspace",
          workosOrgId: "org_workos_creator_workspace",
          name: "Creator Workspace",
          kind: "creator_workspace",
          status: "active",
        }),
        activeMembership: async () => ({
          membershipId: "membership_creator",
          status: "active",
          roleKey: "creator_owner",
          workosMembershipId: "om_creator",
          workosRoleSlugs: ["creator_owner"],
        }),
      }),
      surfacePolicies: {
        "marketplace-web": {
          requiredOrganizationKind: ["creator_workspace", "hotel_group"],
          logoutReturnUrl: "https://marketplace.localhost/login",
        },
      },
    });

    const response = await app.inject({
      method: "GET",
      url: "/auth/session?surface=marketplace-web",
      headers: {
        cookie: "vayada_workos_session=sealed-session; vayada_auth_csrf=csrf-token",
        origin: "https://marketplace.localhost",
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      accessToken: "workos-access-token",
      organizationId: "org_creator_workspace",
      workosOrganizationId: "org_workos_creator_workspace",
      organizationKind: "creator_workspace",
      user: {
        id: "user_creator",
        email: "creator@example.com",
      },
    });
    expect(String(response.headers["set-cookie"])).toContain(
      "vayada_workos_session=refreshed-marketplace-session",
    );
  });

  it("clears the sealed session and returns the WorkOS logout URL", async () => {
    const auditEvents: ProductAuditEvent[] = [];
    app = buildAuthSessionApp({
      productAuditSink: {
        async record(event) {
          auditEvents.push(event);
        },
      },
    });

    const response = await app.inject({
      method: "POST",
      url: "/auth/logout",
      headers: {
        cookie: "vayada_workos_session=sealed-session; vayada_auth_csrf=csrf-token",
        origin: "https://admin.localhost",
        "x-vayada-csrf": "csrf-token",
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      logoutUrl: "https://auth.workos.test/logout?return_to=https%3A%2F%2Fadmin.localhost%2Flogin",
    });
    expect(response.headers["set-cookie"]).toEqual(
      expect.arrayContaining([expect.stringContaining("vayada_workos_session=;")]),
    );
    expect(auditEvents).toEqual([
      expect.objectContaining({
        action: "auth.logout",
        actorUserId: "user_platform_admin",
      }),
    ]);
  });

  it("uses a validated logout return_to for product surfaces", async () => {
    app = buildAuthSessionApp({
      allowedOrigins: ["https://marketplace.localhost"],
      surfacePolicies: {
        "marketplace-web": {
          requiredOrganizationKind: ["creator_workspace", "hotel_group"],
        },
      },
    });

    const response = await app.inject({
      method: "POST",
      url: "/auth/logout",
      headers: {
        cookie: "vayada_workos_session=sealed-session; vayada_auth_csrf=csrf-token",
        origin: "https://marketplace.localhost",
        "x-vayada-csrf": "csrf-token",
      },
      payload: {
        surface: "marketplace-web",
        return_to: "https://marketplace.localhost/login",
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      logoutUrl:
        "https://auth.workos.test/logout?return_to=https%3A%2F%2Fmarketplace.localhost%2Flogin",
    });
  });

  it("uses the refreshed sealed session when generating the WorkOS logout URL", async () => {
    const refreshedSession: AuthKitSession = {
      ...session,
      sealedSession: "refreshed-logout-sealed-session",
    };
    let logoutSealedSession: string | undefined;
    app = buildAuthSessionApp({
      authKitClient: createAuthKitClient({
        async authenticateSession() {
          return refreshedSession;
        },
        async getLogoutUrl(input) {
          logoutSealedSession = input.sealedSession;
          return `https://auth.workos.test/logout?return_to=${encodeURIComponent(input.returnTo)}`;
        },
      }),
    });

    const response = await app.inject({
      method: "POST",
      url: "/auth/logout",
      headers: {
        cookie: "vayada_workos_session=expired-sealed-session; vayada_auth_csrf=csrf-token",
        origin: "https://admin.localhost",
        "x-vayada-csrf": "csrf-token",
      },
    });

    expect(response.statusCode).toBe(200);
    expect(logoutSealedSession).toBe("refreshed-logout-sealed-session");
  });

  it.each([
    { failedOperation: "session authentication", expectedAuditCalls: 0, usesFallbackUrl: false },
    { failedOperation: "audit recording", expectedAuditCalls: 1, usesFallbackUrl: false },
    { failedOperation: "logout URL generation", expectedAuditCalls: 1, usesFallbackUrl: true },
  ] as const)(
    "expires every auth cookie when $failedOperation rejects",
    async ({ failedOperation, expectedAuditCalls, usesFallbackUrl }) => {
      const authenticateSession = vi.fn(async () => {
        if (failedOperation === "session authentication") {
          throw new Error("WorkOS session authentication unavailable");
        }
        return session;
      });
      const getLogoutUrl = vi.fn(async (input: { returnTo: string }) => {
        if (failedOperation === "logout URL generation") {
          throw new Error("WorkOS logout endpoint unavailable");
        }
        return `https://auth.workos.test/logout?return_to=${encodeURIComponent(input.returnTo)}`;
      });
      const recordAudit = vi.fn(async () => {
        if (failedOperation === "audit recording") {
          throw new Error("Audit sink unavailable");
        }
      });
      app = buildAuthSessionApp({
        cookieSecure: true,
        cookieDomain: ".localhost",
        authKitClient: createAuthKitClient({ authenticateSession, getLogoutUrl }),
        productAuditSink: { record: recordAudit },
        surfacePolicies: {
          "platform-admin": {
            requiredOrganizationKind: "platform",
            publicOrigin: "https://admin.localhost",
            firstPartySession: true,
            logoutReturnUrl: "https://admin.localhost/login",
            selectedOrganizationCookieName: "vayada_platform_selected_org",
          },
        },
      });

      const response = await app.inject({
        method: "POST",
        url: "/auth/logout",
        headers: {
          cookie:
            "vayada_fp_workos_session=sealed-session; vayada_fp_auth_csrf=csrf-token; " +
            "vayada_fp_platform_selected_org=org_workos_platform",
          origin: "https://admin.localhost",
          "x-vayada-csrf": "csrf-token",
        },
        payload: { surface: "platform-admin" },
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({
        logoutUrl: usesFallbackUrl
          ? "https://admin.localhost/login"
          : "https://auth.workos.test/logout?return_to=https%3A%2F%2Fadmin.localhost%2Flogin",
      });
      const setCookieHeaders = response.headers["set-cookie"];
      expect(Array.isArray(setCookieHeaders)).toBe(true);
      for (const [activeCookieName, legacyCookieName] of [
        ["vayada_fp_workos_session", "vayada_workos_session"],
        ["vayada_fp_auth_csrf", "vayada_auth_csrf"],
        ["vayada_fp_oauth_state", "vayada_oauth_state"],
        ["vayada_fp_platform_selected_org", "vayada_platform_selected_org"],
      ]) {
        const expiredCookie = (setCookieHeaders as string[]).find(
          (cookie) => cookie.startsWith(`${activeCookieName}=`) && !cookie.includes("Domain="),
        );
        expect(expiredCookie).toContain("Max-Age=0");
        const expiredDomainCookie = (setCookieHeaders as string[]).find(
          (cookie) =>
            cookie.startsWith(`${legacyCookieName}=`) && cookie.includes("Domain=.localhost"),
        );
        expect(expiredDomainCookie).toContain("Max-Age=0");
      }
      expect(authenticateSession).toHaveBeenCalledTimes(1);
      expect(recordAudit).toHaveBeenCalledTimes(expectedAuditCalls);
      expect(getLogoutUrl).toHaveBeenCalledTimes(1);
    },
  );

  it("creates and atomically redeems an audience-bound first-party handoff", async () => {
    const handoffs = createMemoryHandoffRepository();
    app = buildAuthSessionApp(handoffAuthOptions(handoffs.repository));

    const created = await createBookingHandoff(app);
    expect(created.statusCode).toBe(200);
    expect(created.headers["set-cookie"]).toEqual(
      expect.arrayContaining([
        expect.stringContaining("vayada_fp_workos_session=hotel-sealed-session"),
      ]),
    );
    const destination = new URL(created.json().destination);
    expect(`${destination.origin}${destination.pathname}`).toBe(
      "https://admin.booking.localhost/handoff",
    );
    expect(destination.search).toBe("");
    const code = new URLSearchParams(destination.hash.slice(1)).get("code");
    expect(code).toMatch(/^[A-Za-z0-9_-]{43}$/);

    const redeemed = await redeemHandoff(app, code!, "booking-admin");
    expect(redeemed.statusCode).toBe(200);
    expect(redeemed.json()).toEqual({
      routingHints: {
        organizationId: "org_hotel_group",
        propertyId: "property_alpenrose",
        workosOrganizationId: "org_workos_hotel_group",
      },
      targetPath: "/dashboard?from=marketplace",
    });
    expect(redeemed.headers["set-cookie"]).toEqual(
      expect.arrayContaining([
        expect.stringContaining("vayada_fp_workos_session=hotel-sealed-session"),
        expect.stringContaining("vayada_fp_auth_csrf="),
      ]),
    );

    const replayed = await redeemHandoff(app, code!, "booking-admin");
    expect(replayed.statusCode).toBe(401);
    expect(replayed.json()).toEqual({ error: "invalid_handoff" });
    expect(replayed.headers["set-cookie"]).toBeUndefined();
  });

  it("refuses to mint a target cookie after the provider session was logged out", async () => {
    const handoffs = createMemoryHandoffRepository();
    const isSessionActive = vi.fn().mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    app = buildAuthSessionApp(
      handoffAuthOptions(
        handoffs.repository,
        createAuthKitClient({
          async authenticateSession() {
            return handoffHotelSession;
          },
          isSessionActive,
        }),
      ),
    );

    const destination = new URL((await createBookingHandoff(app)).json().destination);
    const code = new URLSearchParams(destination.hash.slice(1)).get("code")!;
    const response = await redeemHandoff(app, code, "booking-admin");

    expect(response.statusCode).toBe(401);
    expect(response.json()).toEqual({ error: "invalid_handoff" });
    expect(response.headers["set-cookie"]).toBeUndefined();
    expect(isSessionActive).toHaveBeenNthCalledWith(2, {
      sessionId: "session_workos",
      workosUserId: "user_workos_hotel",
    });
  });

  it("does not consume a handoff for the wrong audience and rejects expired codes", async () => {
    const handoffs = createMemoryHandoffRepository();
    app = buildAuthSessionApp(handoffAuthOptions(handoffs.repository));

    const firstDestination = new URL((await createBookingHandoff(app)).json().destination);
    const firstCode = new URLSearchParams(firstDestination.hash.slice(1)).get("code")!;
    const wrongAudience = await redeemHandoff(app, firstCode, "pms-web");
    expect(wrongAudience.statusCode).toBe(401);
    expect((await redeemHandoff(app, firstCode, "booking-admin")).statusCode).toBe(200);

    const expiredDestination = new URL((await createBookingHandoff(app)).json().destination);
    const expiredCode = new URLSearchParams(expiredDestination.hash.slice(1)).get("code")!;
    handoffs.expireAll();
    const expired = await redeemHandoff(app, expiredCode, "booking-admin");
    expect(expired.statusCode).toBe(401);
    expect(expired.json()).toEqual({ error: "invalid_handoff" });
  });

  it("requires the exact source gateway origin and a safe relative target path", async () => {
    const handoffs = createMemoryHandoffRepository();
    app = buildAuthSessionApp(handoffAuthOptions(handoffs.repository));
    const baseRequest = {
      method: "POST" as const,
      url: "/auth/handoff/create",
      headers: {
        cookie: "vayada_fp_workos_session=source-sealed-session; vayada_fp_auth_csrf=source-csrf",
        origin: "https://marketplace.localhost",
        "x-vayada-csrf": "source-csrf",
      },
      payload: {
        sourceSurface: "marketplace-web",
        targetPath: "/dashboard",
        targetSurface: "booking-admin",
      },
    };

    const bypassingGateway = await app.inject(baseRequest);
    expect(bypassingGateway.statusCode).toBe(403);
    expect(bypassingGateway.json()).toEqual({ error: "origin_rejected" });

    const unsafeTarget = await app.inject({
      ...baseRequest,
      headers: {
        ...baseRequest.headers,
        "x-forwarded-host": "marketplace.localhost",
        "x-forwarded-proto": "https",
      },
      payload: { ...baseRequest.payload, targetPath: "//evil.example/steal" },
    });
    expect(unsafeTarget.statusCode).toBe(400);
    expect(unsafeTarget.json()).toEqual({ error: "invalid_handoff_target" });
  });

  it("releases a claimed handoff when WorkOS refresh fails transiently", async () => {
    const handoffs = createMemoryHandoffRepository();
    let authenticationCalls = 0;
    const authKitClient = createAuthKitClient({
      async authenticateSession() {
        authenticationCalls += 1;
        if (authenticationCalls === 2) {
          throw new Error("temporary WorkOS outage");
        }
        return handoffHotelSession;
      },
      async refreshSession() {
        return handoffHotelSession;
      },
    });
    app = buildAuthSessionApp(handoffAuthOptions(handoffs.repository, authKitClient));
    const destination = new URL((await createBookingHandoff(app)).json().destination);
    const code = new URLSearchParams(destination.hash.slice(1)).get("code")!;

    const transient = await redeemHandoff(app, code, "booking-admin");
    expect(transient.statusCode).toBe(503);
    expect(transient.json()).toEqual({ error: "handoff_retryable" });
    expect(transient.headers["set-cookie"]).toBeUndefined();
    expect((await redeemHandoff(app, code, "booking-admin")).statusCode).toBe(200);
  });

  it("returns the retryable handoff contract when claiming storage fails", async () => {
    const handoffs = createMemoryHandoffRepository();
    const claim = handoffs.repository.claim.bind(handoffs.repository);
    let failClaim = false;
    const repository: AuthSessionHandoffRepository = {
      ...handoffs.repository,
      async claim(input) {
        if (failClaim) throw new Error("temporary database outage");
        return claim(input);
      },
    };
    app = buildAuthSessionApp(handoffAuthOptions(repository));
    const destination = new URL((await createBookingHandoff(app)).json().destination);
    const code = new URLSearchParams(destination.hash.slice(1)).get("code")!;
    failClaim = true;

    const transient = await redeemHandoff(app, code, "booking-admin");

    expect(transient.statusCode).toBe(503);
    expect(transient.json()).toEqual({ error: "handoff_retryable" });
    expect(transient.headers["set-cookie"]).toBeUndefined();
  });

  it("rejects handoffs for recognized but unconfigured surfaces", async () => {
    const handoffs = createMemoryHandoffRepository();
    app = buildAuthSessionApp(handoffAuthOptions(handoffs.repository));

    const response = await app.inject({
      method: "POST",
      url: "/auth/handoff/create",
      headers: { origin: "https://marketplace.localhost" },
      payload: {
        sourceSurface: "affiliate-dashboard",
        targetPath: "/dashboard",
        targetSurface: "booking-admin",
      },
    });

    expect(response.statusCode).toBe(409);
    expect(response.json()).toEqual({ error: "handoff_not_enabled" });
  });

  it("releases a claimed handoff when target authorization storage fails transiently", async () => {
    const handoffs = createMemoryHandoffRepository();
    let lookupCalls = 0;
    const options = handoffAuthOptions(handoffs.repository);
    app = buildAuthSessionApp({
      ...options,
      identityRepository: createIdentityRepository({
        userByProviderUserId: async () => {
          lookupCalls += 1;
          if (lookupCalls === 2) throw new Error("temporary database outage");
          return {
            userId: "user_hotel_admin",
            email: "owner@alpenrose.example",
            status: "active",
          };
        },
        organizationByWorkosOrgId: options.identityRepository.findOrganizationByWorkosOrgId,
        activeMembership: options.identityRepository.findActiveMembership,
        linkedResources: options.identityRepository.findLinkedResources,
      }),
    });
    const destination = new URL((await createBookingHandoff(app)).json().destination);
    const code = new URLSearchParams(destination.hash.slice(1)).get("code")!;

    const transient = await redeemHandoff(app, code, "booking-admin");
    expect(transient.statusCode).toBe(503);
    expect(transient.json()).toEqual({ error: "handoff_retryable" });
    expect(transient.headers["set-cookie"]).toBeUndefined();
    expect((await redeemHandoff(app, code, "booking-admin")).statusCode).toBe(200);
  });

  it("clears a stale first-party cookie after the provider session is terminal", async () => {
    app = buildAuthSessionApp({
      ...handoffAuthOptions(createMemoryHandoffRepository().repository),
      authKitClient: createAuthKitClient({
        async authenticateSession() {
          return null;
        },
        async refreshSession() {
          return null;
        },
      }),
    });

    const response = await app.inject({
      method: "GET",
      url: "/auth/session?surface=booking-admin",
      headers: {
        cookie: "vayada_fp_workos_session=stale-sealed-session",
        origin: "https://admin.booking.localhost",
      },
    });

    expect(response.statusCode).toBe(401);
    expect(response.json()).toEqual({ error: "invalid_session" });
    expect(response.headers["set-cookie"]).toEqual(
      expect.arrayContaining([
        expect.stringContaining("vayada_fp_workos_session=; Path=/auth; Max-Age=0"),
        expect.stringContaining("vayada_fp_auth_csrf=; Path=/auth; Max-Age=0"),
      ]),
    );
    expect(response.headers["set-cookie"]).not.toEqual(
      expect.arrayContaining([expect.stringContaining("vayada_fp_oauth_state=")]),
    );
  });

  it("rejects refresh when CSRF header is missing", async () => {
    app = buildAuthSessionApp();

    const response = await app.inject({
      method: "POST",
      url: "/auth/session/refresh",
      headers: {
        cookie: "vayada_workos_session=sealed-session; vayada_auth_csrf=csrf-token",
        origin: "https://admin.localhost",
      },
    });

    expect(response.statusCode).toBe(403);
    expect(response.json()).toEqual({ error: "csrf_rejected" });
  });
});

function handoffAuthOptions(
  handoffRepository: AuthSessionHandoffRepository,
  authKitClient: AuthKitClient = createAuthKitClient({
    async authenticateSession() {
      return handoffHotelSession;
    },
    async refreshSession() {
      return handoffHotelSession;
    },
  }),
) {
  return {
    allowedOrigins: [
      "https://marketplace.localhost",
      "https://admin.booking.localhost",
      "https://pms.localhost",
    ],
    authKitClient,
    cookieSecure: true,
    handoffRepository,
    identityRepository: createIdentityRepository({
      userByProviderUserId: async () => ({
        userId: "user_hotel_admin",
        email: "owner@alpenrose.example",
        status: "active",
      }),
      organizationByWorkosOrgId: async () => ({
        organizationId: "org_hotel_group",
        workosOrgId: "org_workos_hotel_group",
        name: "Alpenrose Hotel Group",
        kind: "hotel_group",
        status: "active",
      }),
      activeMembership: async () => ({
        membershipId: "membership_hotel",
        status: "active",
        roleKey: "hotel_owner",
        workosMembershipId: "om_hotel",
        workosRoleSlugs: ["hotel_owner"],
      }),
      linkedResources: async () => [
        {
          product: "booking",
          resourceType: "booking_hotel",
          resourceId: "booking_hotel_alpenrose",
          relationship: "owner",
          status: "active",
        },
        {
          product: "pms",
          resourceType: "pms_property",
          resourceId: "pms_property_alpenrose",
          relationship: "owner",
          status: "active",
        },
      ],
    }),
    surfacePolicies: {
      "marketplace-web": {
        requiredOrganizationKind: ["creator_workspace", "hotel_group"],
        publicOrigin: "https://marketplace.localhost",
        firstPartySession: true,
      },
      "booking-admin": {
        requiredOrganizationKind: "hotel_group",
        publicOrigin: "https://admin.booking.localhost",
        firstPartySession: true,
        requiredResourceLink: { product: "booking", resourceType: "booking_hotel" },
      },
      "pms-web": {
        requiredOrganizationKind: "hotel_group",
        publicOrigin: "https://pms.localhost",
        firstPartySession: true,
        requiredResourceLink: { product: "pms", resourceType: "pms_property" },
      },
    } satisfies Partial<Record<string, AuthSurfacePolicy>>,
    tokenVerifier: createTokenVerifier(handoffHotelSession),
  };
}

function createBookingHandoff(app: ReturnType<typeof buildApp>) {
  return app.inject({
    method: "POST",
    url: "/auth/handoff/create",
    headers: {
      cookie: "vayada_fp_workos_session=source-sealed-session; vayada_fp_auth_csrf=source-csrf",
      origin: "https://marketplace.localhost",
      "x-forwarded-host": "marketplace.localhost",
      "x-forwarded-proto": "https",
      "x-vayada-csrf": "source-csrf",
    },
    payload: {
      routingHints: { propertyId: "property_alpenrose" },
      sourceSurface: "marketplace-web",
      targetPath: "/dashboard?from=marketplace",
      targetSurface: "booking-admin",
    },
  });
}

function redeemHandoff(
  app: ReturnType<typeof buildApp>,
  code: string,
  targetSurface: "booking-admin" | "pms-web",
) {
  const origin =
    targetSurface === "booking-admin" ? "https://admin.booking.localhost" : "https://pms.localhost";
  return app.inject({
    method: "POST",
    url: "/auth/handoff/redeem",
    headers: {
      origin,
      "x-forwarded-host": new URL(origin).host,
      "x-forwarded-proto": "https",
    },
    payload: { code, targetSurface },
  });
}

function createMemoryHandoffRepository(): {
  expireAll(): void;
  repository: AuthSessionHandoffRepository;
} {
  type Record = AuthSessionHandoff & {
    claimedBy?: string;
    consumed: boolean;
    expiresAt: Date;
  };
  const records = new Map<string, Record>();

  return {
    expireAll() {
      for (const record of records.values()) record.expiresAt = new Date(0);
    },
    repository: {
      async create(input) {
        if (records.has(input.codeDigest)) return false;
        records.set(input.codeDigest, {
          consumed: false,
          expiresAt: input.expiresAt,
          routingHints: input.routingHints,
          sealedSession: input.sealedSession,
          sourceSurface: input.sourceSurface,
          targetPath: input.targetPath,
          targetPublicOrigin: input.targetPublicOrigin,
          targetSurface: input.targetSurface,
        });
        return true;
      },
      async claim(input) {
        const record = records.get(input.codeDigest);
        if (
          !record ||
          record.consumed ||
          record.claimedBy ||
          record.expiresAt <= input.now ||
          record.targetSurface !== input.targetSurface ||
          record.targetPublicOrigin !== input.targetPublicOrigin
        ) {
          return null;
        }
        record.claimedBy = input.redemptionId;
        return record;
      },
      async complete(input) {
        const record = [...records.values()].find(
          (candidate) => candidate.claimedBy === input.redemptionId && !candidate.consumed,
        );
        if (!record) return false;
        record.consumed = true;
        delete record.claimedBy;
        return true;
      },
      async release(input) {
        const record = [...records.values()].find(
          (candidate) => candidate.claimedBy === input.redemptionId && !candidate.consumed,
        );
        if (record) delete record.claimedBy;
      },
      async scrubExpired(input) {
        for (const [digest, record] of records) {
          if (record.expiresAt < input.deleteBefore) records.delete(digest);
        }
      },
    },
  };
}

async function beginPasswordSignup(
  app: ReturnType<typeof buildAuthSessionApp>,
  input: { email: string; surface: AuthSurface; type?: "hotel" },
): Promise<string> {
  const response = await app.inject({
    method: "POST",
    url: "/auth/password/signup",
    headers: { origin: `https://${input.surface === "pms-web" ? "pms" : "marketplace"}.localhost` },
    payload: { ...input, password: "correct-password" },
  });
  const body = response.json() as { state?: string; pendingAuthenticationToken?: string };
  expect(response.statusCode).toBe(403);
  expect(body.state).toBe("email_verification_required");
  expect(body.pendingAuthenticationToken).toEqual(expect.any(String));
  return body.pendingAuthenticationToken!;
}

function buildAuthSessionApp(
  options: {
    authKitClient?: AuthKitClient;
    identityRepository?: IdentityRepository;
    lifecycleCommandBus?: IdentityLifecycleCommandBus;
    productAuditSink?: { record(event: ProductAuditEvent): Promise<void> };
    tokenVerifier?: TokenVerifier;
    legacyMarketplaceJwtSecret?: string;
    allowedOrigins?: string[];
    compatibilityCallbackOrigin?: string;
    cookieSecure?: boolean;
    cookieDomain?: string;
    surfacePolicies?: Partial<
      Record<
        "platform-admin" | "booking-admin" | "pms-web" | "affiliate-dashboard" | "marketplace-web",
        AuthSurfacePolicy
      >
    >;
    profileImageMediaRepository?: ApprovedPublicProfileImageRepository;
    hotelAccountInviteOnboarding?: Pick<HotelAccountInviteRepository, "resolveForOnboarding">;
    handoffRepository?: AuthSessionHandoffRepository;
    propertyAccessRepository?: PropertyAccessRepository;
  } = {},
) {
  const compatibilityCallbackOrigin =
    options.compatibilityCallbackOrigin ?? "https://api.localhost";
  return buildApp({
    logger: false,
    authSession: {
      authKitClient: options.authKitClient ?? createAuthKitClient(),
      identityRepository: options.identityRepository ?? createIdentityRepository(),
      lifecycleCommandBus: options.lifecycleCommandBus ?? createLifecycleCommandBus(),
      productAuditSink: options.productAuditSink ?? {
        async record() {},
      },
      tokenVerifier: options.tokenVerifier ?? createTokenVerifier(),
      logoutReturnUrl: "https://admin.localhost/login",
      allowedOrigins: [
        ...new Set([
          ...(options.allowedOrigins ?? ["https://admin.localhost"]),
          compatibilityCallbackOrigin,
        ]),
      ],
      compatibilityCallbackOrigin,
      requiredOrganizationKind: "platform",
      surfacePolicies: options.surfacePolicies,
      oauthStateSecret: "test-oauth-state-secret",
      cookieSecure: options.cookieSecure ?? false,
      ...(options.cookieDomain ? { cookieDomain: options.cookieDomain } : {}),
      legacyMarketplaceJwtSecret: options.legacyMarketplaceJwtSecret,
      profileImageMediaRepository: options.profileImageMediaRepository,
      hotelAccountInviteOnboarding: options.hotelAccountInviteOnboarding,
      handoffRepository: options.handoffRepository,
      propertyAccessRepository: options.propertyAccessRepository ?? {
        async findMembershipPropertyScope(context) {
          return {
            mode: "all",
            roleKey: context.membership.roleKey,
            accessOrigin: "agency",
            assignedPropertyIds: [],
          };
        },
      },
    },
  });
}

function approvedProfileImageRepository(input: {
  actorUserId: string;
  ownerOrganizationId: string;
}): ApprovedPublicProfileImageRepository {
  return {
    persistent: true,
    publicCdnBaseUrl: "https://media.example/",
    async findMediaObject(mediaId) {
      if (mediaId !== "media_profile_1") return null;
      return {
        mediaId,
        purpose: "identity.user.profile_image",
        visibility: "public",
        requestedVisibility: "public",
        approvalStatus: "approved",
        lifecycleStatus: "active",
        storageKind: "vayada_managed",
        bucket: "vayada-media",
        storageKey: "public/users/profile.webp",
        ownerOrganizationId: input.ownerOrganizationId,
        actorUserId: input.actorUserId,
        resourceProduct: "platform",
        resourceType: "user_profile",
        resourceId: input.actorUserId,
        contentType: "image/webp",
        sizeBytes: 1024,
        originalFilename: "profile.webp",
        variants: [
          {
            variantName: "original_safe",
            visibility: "public",
            storageKey: "public/users/profile-original.webp",
            contentType: "image/webp",
            sizeBytes: 1024,
            publicCdnUrl: "https://media.example/users/profile.webp",
          },
        ],
        createdAt: "2026-07-15T10:00:00.000Z",
      };
    },
  };
}

function readJwtPayload(token: string): Record<string, unknown> {
  const [, payload] = token.split(".");
  if (!payload) throw new Error("JWT payload segment missing");
  return JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
}

function cookieHeader(response: { headers: Record<string, unknown> }, name: string): string {
  const setCookie = response.headers["set-cookie"];
  const values = Array.isArray(setCookie) ? setCookie : [setCookie];
  const cookie = values.find(
    (value): value is string => typeof value === "string" && value.startsWith(`${name}=`),
  );
  if (!cookie) throw new Error(`Missing cookie ${name}`);
  return cookie.split(";")[0]!;
}

function createAuthKitClient(overrides: Partial<AuthKitClient> = {}): AuthKitClient {
  return {
    getAuthorizationUrl(input) {
      return `https://auth.workos.test/oauth?state=${encodeURIComponent(input.state)}`;
    },
    async authenticateWithCode() {
      return session;
    },
    async authenticateWithPassword() {
      return session;
    },
    async authenticateWithOrganizationSelection() {
      return session;
    },
    async authenticateWithEmailVerification() {
      return session;
    },
    async createUser() {
      return session.user;
    },
    async resendVerificationEmail() {
      return { email: session.user.email };
    },
    async createPasswordReset() {},
    async resetPassword() {
      return session.user;
    },
    async authenticateSession() {
      return session;
    },
    async isSessionActive() {
      return true;
    },
    async refreshSession() {
      return {
        ...session,
        accessToken: "refreshed-workos-access-token",
        sealedSession: "refreshed-sealed-session",
      };
    },
    async createSignupOrganization(input) {
      return {
        organizationId: `org_workos_signup_${input.metadata.signup_intent}`,
      };
    },
    async ensureSignupOrganizationMembership(input) {
      return {
        membershipId: `om_signup_${input.roleKey}`,
        roleSlugs: [input.roleKey],
        status: "active",
      };
    },
    async getLogoutUrl(input) {
      return `https://auth.workos.test/logout?return_to=${encodeURIComponent(input.returnTo)}`;
    },
    async updateUserExternalId() {},
    async updateUserName() {},
    ...overrides,
  };
}

function createIdentityRepository(
  overrides: {
    userByProviderUserId?: IdentityRepository["findUserByProviderUserId"];
    organizationByWorkosOrgId?: IdentityRepository["findOrganizationByWorkosOrgId"];
    activeMembership?: IdentityRepository["findActiveMembership"];
    membershipOrganizations?: IdentityRepository["listMembershipOrganizations"];
    linkedResources?: IdentityRepository["findLinkedResources"];
  } = {},
): IdentityRepository {
  return {
    findUserByProviderUserId: overrides.userByProviderUserId ?? (async () => user),
    findOrganizationByWorkosOrgId:
      overrides.organizationByWorkosOrgId ??
      (async () => ({
        organizationId: "org_platform",
        workosOrgId: "org_workos_platform",
        name: "Vayada Platform",
        kind: "platform",
        status: "active",
      })),
    findActiveMembership:
      overrides.activeMembership ??
      (async () => ({
        membershipId: "membership_platform",
        status: "active",
        roleKey: "platform_admin",
        workosMembershipId: "om_platform",
        workosRoleSlugs: ["platform_admin"],
      })),
    listMembershipOrganizations: overrides.membershipOrganizations ?? (async () => []),
    findLinkedResources: overrides.linkedResources ?? (async () => []),
  };
}

function createLifecycleCommandBus(): IdentityLifecycleCommandBus {
  return {
    async execute(command) {
      return {
        status: "accepted",
        commandId: command.commandId,
        idempotencyKey: command.idempotencyKey,
        userId: "user_jit_created",
        events: [],
      };
    },
  };
}

function createTokenVerifier(tokenSession: AuthKitSession = session): TokenVerifier {
  return async (token) => ({
    workosUserId: tokenSession.user.id,
    workosOrgId: tokenSession.organizationId ?? null,
    sessionId:
      token === "refreshed-workos-access-token" ? "session_refreshed" : tokenSession.sessionId!,
    expiresAt: Math.floor(Date.now() / 1000) + 3600,
  });
}
