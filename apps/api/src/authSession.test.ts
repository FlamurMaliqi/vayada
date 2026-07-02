import { createHmac } from "node:crypto";
import type {
  IdentityLifecycleCommand,
  IdentityLifecycleCommandBus,
  IdentityRepository,
  IdentityUser,
  TokenVerifier,
} from "@vayada/backend-auth";
import { afterEach, describe, expect, it } from "vitest";

import { buildApp } from "./app.js";
import type {
  AuthKitClient,
  AuthKitSession,
  AuthSurfacePolicy,
  ProductAuditEvent,
} from "./routes/authSession.js";

const TEST_STATE_COOKIE_SECRET = "test-state-cookie-secret";

const user: IdentityUser = {
  userId: "user_platform_admin",
  email: "f.maliqi@vayada.com",
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

describe("AuthKit session routes", () => {
  let app: ReturnType<typeof buildApp> | undefined;

  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  it("redirects to the hosted AuthKit URL and stores callback state", async () => {
    const authKitClient = createAuthKitClient();
    app = buildAuthSessionApp({ authKitClient });

    const response = await app.inject({
      method: "GET",
      url: "/auth/workos/login?login_hint=admin%40example.com",
    });

    expect(response.statusCode).toBe(302);
    expect(response.headers.location).toContain("https://auth.workos.test/authorize?");
    expect(response.headers.location).toContain("login_hint=admin%40example.com");
    expect(response.headers["set-cookie"]).toEqual(
      expect.arrayContaining([expect.stringContaining("vayada_workos_state=")]),
    );
  });

  it("redirects hosted signup to AuthKit with validated surface intent state", async () => {
    app = buildAuthSessionApp({
      authKitClient: createAuthKitClient({
        async createSignupOrganization() {
          throw new Error("Signup redirect must not create a WorkOS organization");
        },
      }),
      allowedOrigins: ["https://marketplace.localhost"],
      surfacePolicies: {
        "marketplace-web": {
          requiredOrganizationKind: ["creator_workspace", "hotel_group"],
          callbackReturnUrl: "https://marketplace.localhost/marketplace",
        },
      },
    });

    const response = await app.inject({
      method: "GET",
      url: "/auth/workos/signup?surface=marketplace-web&intent=creator&login_hint=creator%40example.com&return_to=https%3A%2F%2Fmarketplace.localhost%2Fmarketplace%3Fsignup%3Dcreator",
    });

    expect(response.statusCode).toBe(302);
    const location = new URL(response.headers.location as string);
    expect(location.origin + location.pathname).toBe("https://auth.workos.test/authorize");
    expect(location.searchParams.get("organization_id")).toBeNull();
    expect(location.searchParams.get("screen_hint")).toBe("sign-up");
    expect(location.searchParams.get("login_hint")).toBe("creator@example.com");

    const contexts = readStateCookieContexts(response);
    expect(contexts).toEqual([
      {
        state: location.searchParams.get("state"),
        surface: "marketplace-web",
        returnTo: "https://marketplace.localhost/marketplace?signup=creator",
        authFlow: "signup",
        signupIntent: "creator",
      },
    ]);
  });

  it("rejects hosted signup callback when signed state is tampered", async () => {
    const signedState = encodeTestStateCookie([
      {
        state: "signup-state",
        surface: "marketplace-web",
        returnTo: "https://marketplace.localhost/marketplace?signup=creator",
        authFlow: "signup",
        signupIntent: "creator",
      },
    ]);
    const [, payload, signature] = signedState.split(".");
    const tamperedPayload = Buffer.from(
      JSON.stringify([
        {
          state: "signup-state",
          surface: "marketplace-web",
          returnTo: "https://evil.example/callback",
          authFlow: "signup",
          signupIntent: "hotel",
        },
      ]),
    ).toString("base64url");
    app = buildAuthSessionApp({
      authKitClient: createAuthKitClient({
        async authenticateWithCode() {
          throw new Error("Tampered state must be rejected before AuthKit code exchange");
        },
      }),
      allowedOrigins: ["https://marketplace.localhost"],
      surfacePolicies: {
        "marketplace-web": {
          requiredOrganizationKind: ["creator_workspace", "hotel_group"],
        },
      },
    });

    const response = await app.inject({
      method: "GET",
      url: "/auth/workos/callback?code=auth-code&state=signup-state",
      headers: {
        cookie: `vayada_workos_state=v2.${tamperedPayload}.${signature}`,
      },
    });

    expect(payload).toBeTruthy();
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({
      error: "invalid_auth_state",
    });
  });

  it("rejects legacy callback state with a return URL outside configured origins", async () => {
    const legacyState = Buffer.from(
      JSON.stringify([
        {
          state: "legacy-state",
          surface: "platform-admin",
          returnTo: "https://evil.example/callback",
        },
      ]),
    ).toString("base64url");
    app = buildAuthSessionApp({
      authKitClient: createAuthKitClient({
        async authenticateWithCode() {
          throw new Error("Invalid legacy state must be rejected before AuthKit code exchange");
        },
      }),
      allowedOrigins: ["https://admin.localhost"],
    });

    const response = await app.inject({
      method: "GET",
      url: "/auth/workos/callback?code=auth-code&state=legacy-state",
      headers: {
        cookie: `vayada_workos_state=v1.${legacyState}`,
      },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({
      error: "invalid_auth_state",
    });
  });

  it("rejects hosted signup return URLs outside configured origins", async () => {
    app = buildAuthSessionApp({
      allowedOrigins: ["https://pms.localhost"],
      surfacePolicies: {
        "pms-web": {
          requiredOrganizationKind: "hotel_group",
          callbackReturnUrl: "https://pms.localhost/setup",
        },
      },
    });

    const response = await app.inject({
      method: "GET",
      url: "/auth/workos/signup?surface=pms-web&intent=hotel&return_to=https%3A%2F%2Fevil.example%2Fsetup",
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({
      error: "invalid_signup_request",
      message: "AuthKit return_to origin is not allowed",
    });
  });

  it("rejects hosted signup requests without explicit surface or intent", async () => {
    app = buildAuthSessionApp({
      allowedOrigins: ["https://pms.localhost"],
      surfacePolicies: {
        "pms-web": {
          requiredOrganizationKind: "hotel_group",
        },
      },
    });

    const missingSurface = await app.inject({
      method: "GET",
      url: "/auth/workos/signup?intent=hotel",
    });
    expect(missingSurface.statusCode).toBe(400);
    expect(missingSurface.json()).toMatchObject({
      error: "invalid_signup_request",
      message: "Hosted signup surface is required",
    });

    const missingIntent = await app.inject({
      method: "GET",
      url: "/auth/workos/signup?surface=pms-web",
    });
    expect(missingIntent.statusCode).toBe(400);
    expect(missingIntent.json()).toMatchObject({
      error: "invalid_signup_request",
      message: "Hosted signup intent is required for pms-web",
    });
  });

  it("rejects hosted signup intents unsupported by the selected surface", async () => {
    app = buildAuthSessionApp({
      allowedOrigins: ["https://marketplace.localhost"],
      surfacePolicies: {
        "marketplace-web": {
          requiredOrganizationKind: ["creator_workspace", "hotel_group"],
        },
      },
    });

    const response = await app.inject({
      method: "GET",
      url: "/auth/workos/signup?surface=marketplace-web&intent=admin",
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({
      error: "invalid_signup_request",
      message: "Unsupported hosted signup intent for marketplace-web",
    });
  });

  it("rejects public hosted platform-admin signup", async () => {
    app = buildAuthSessionApp();

    const response = await app.inject({
      method: "GET",
      url: "/auth/workos/signup?surface=platform-admin&intent=admin",
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({
      error: "invalid_signup_request",
      message: "Hosted signup is not supported for platform-admin",
    });
  });

  it("keeps legacy password register absent from next-api", async () => {
    app = buildAuthSessionApp();

    const response = await app.inject({
      method: "POST",
      url: "/auth/register",
    });

    expect(response.statusCode).toBe(404);
  });

  it("completes callback for an existing linked user and emits login audit", async () => {
    const auditEvents: ProductAuditEvent[] = [];
    app = buildAuthSessionApp({
      productAuditSink: {
        async record(event) {
          auditEvents.push(event);
        },
      },
    });

    const response = await app.inject({
      method: "GET",
      url: "/auth/workos/callback?code=auth-code&state=callback-state",
      headers: {
        cookie: "vayada_workos_state=callback-state",
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      accessToken: "workos-access-token",
      csrfToken: expect.any(String),
      organizationId: "org_platform",
      workosOrganizationId: "org_workos_platform",
      user: {
        id: "user_platform_admin",
        workosUserId: "user_workos_platform",
      },
    });
    expect(response.headers["set-cookie"]).toEqual(
      expect.arrayContaining([
        expect.stringContaining("vayada_workos_state=;"),
        expect.stringContaining("vayada_workos_session=sealed-session"),
      ]),
    );
    expect(auditEvents).toEqual([
      expect.objectContaining({
        action: "auth.login",
        actorUserId: "user_platform_admin",
        organizationId: "org_platform",
        workosUserId: "user_workos_platform",
      }),
    ]);
  });

  it("keeps hosted signup intent through callback audit", async () => {
    const auditEvents: ProductAuditEvent[] = [];
    const commands: IdentityLifecycleCommand[] = [];
    const workosCalls: string[] = [];
    const marketplaceSession: AuthKitSession = {
      ...session,
      organizationId: undefined,
      user: {
        ...session.user,
        id: "user_workos_creator",
        email: "creator@example.com",
      },
    };
    app = buildAuthSessionApp({
      allowedOrigins: ["https://marketplace.localhost"],
      authKitClient: createAuthKitClient({
        async authenticateWithCode() {
          return marketplaceSession;
        },
        async createSignupOrganization(input) {
          workosCalls.push("organization");
          expect(input.externalId).toBe("vayada-signup:marketplace-web:creator:signup-state");
          expect(input.metadata).toMatchObject({
            auth_flow: "signup",
            surface: "marketplace-web",
            signup_intent: "creator",
            organization_kind: "creator_workspace",
            role_key: "creator_owner",
          });
          return { organizationId: "org_workos_signup_creator" };
        },
        async ensureSignupOrganizationMembership(input) {
          workosCalls.push("membership");
          expect(input).toEqual({
            workosUserId: "user_workos_creator",
            workosOrganizationId: "org_workos_signup_creator",
            roleKey: "creator_owner",
          });
          return {
            membershipId: "om_signup_creator",
            roleSlugs: ["creator_owner"],
            status: "active",
          };
        },
        async refreshSession(input) {
          workosCalls.push("refresh");
          expect(workosCalls).toEqual(["organization", "membership", "refresh"]);
          expect(input.organizationId).toBe("org_workos_signup_creator");
          return {
            ...marketplaceSession,
            organizationId: "org_workos_signup_creator",
            sealedSession: "refreshed-signup-session",
          };
        },
      }),
      identityRepository: createIdentityRepository({
        userByProviderUserId: async () => null,
        organizationByWorkosOrgId: async () => ({
          organizationId: "org_creator_workspace",
          workosOrgId: "org_workos_signup_creator",
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
      lifecycleCommandBus: {
        async execute(command) {
          commands.push(command);
          return {
            status: "accepted",
            commandId: command.commandId,
            idempotencyKey: command.idempotencyKey,
            userId: "user_creator",
            events: [],
          };
        },
      },
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
      method: "GET",
      url: "/auth/workos/callback?code=auth-code&state=signup-state",
      headers: {
        cookie: `vayada_workos_state=${encodeTestStateCookie([
          {
            state: "signup-state",
            surface: "marketplace-web",
            returnTo: "https://marketplace.localhost/marketplace?signup=creator",
            authFlow: "signup",
            signupIntent: "creator",
          },
        ])}`,
      },
    });

    expect(response.statusCode).toBe(302);
    expect(response.headers.location).toBe(
      "https://marketplace.localhost/marketplace?signup=creator",
    );
    expect(auditEvents).toEqual([
      expect.objectContaining({
        action: "auth.login",
        authFlow: "signup",
        actorUserId: "user_creator",
        surface: "marketplace-web",
        signupIntent: "creator",
      }),
    ]);
    expect(commands).toEqual([
      expect.objectContaining({
        commandType: "identity.user.create",
        payload: expect.objectContaining({
          email: "creator@example.com",
          legacyUserType: "creator",
          organization: {
            kind: "creator_workspace",
            name: "Creator Workspace",
            workosExternalId: "vayada-signup:marketplace-web:creator:signup-state",
            workosOrgId: "org_workos_signup_creator",
          },
          membership: {
            status: "active",
            roleKey: "creator_owner",
            workosMembershipId: "om_signup_creator",
            workosRoleSlugs: ["creator_owner"],
          },
        }),
      }),
    ]);
    expect(workosCalls).toEqual(["organization", "membership", "refresh"]);
  });

  it.each(["flamur.maliqi2811@gmail.com", "other@vayada.com"])(
    "allows linked platform admin %s",
    async (email) => {
      app = buildAuthSessionApp({
        authKitClient: createAuthKitClient({
          async authenticateWithCode() {
            return { ...session, user: { ...session.user, email } };
          },
        }),
        identityRepository: createIdentityRepository({
          userByProviderUserId: async () => ({ ...user, email }),
        }),
      });

      const response = await app.inject({
        method: "GET",
        url: "/auth/workos/callback?code=auth-code&state=callback-state",
        headers: {
          cookie: "vayada_workos_state=callback-state",
        },
      });

      expect(response.statusCode).toBe(200);
      expect(response.json().user.email).toBe(email);
    },
  );

  it("accepts callback state from duplicate cookies with multiple pending login attempts", async () => {
    app = buildAuthSessionApp();

    const response = await app.inject({
      method: "GET",
      url: "/auth/workos/callback?code=auth-code&state=older-callback-state",
      headers: {
        cookie: `vayada_workos_state=stale-callback-state; vayada_workos_state=${encodeTestStateCookie(
          [
            { state: "older-callback-state", surface: "platform-admin" },
            { state: "newer-callback-state", surface: "platform-admin" },
          ],
        )}`,
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().user.id).toBe("user_platform_admin");
  });

  it("redirects to the configured frontend success URL after callback when enabled", async () => {
    app = buildAuthSessionApp({
      callbackReturnUrl: "https://admin.localhost/dashboard",
    });

    const response = await app.inject({
      method: "GET",
      url: "/auth/workos/callback?code=auth-code&state=callback-state",
      headers: {
        cookie: "vayada_workos_state=callback-state",
      },
    });

    expect(response.statusCode).toBe(302);
    expect(response.headers.location).toBe("https://admin.localhost/dashboard");
    expect(response.headers["set-cookie"]).toEqual(
      expect.arrayContaining([expect.stringContaining("vayada_workos_session=sealed-session")]),
    );
  });

  it("uses the identity lifecycle command bus for JIT-first user creation", async () => {
    const commands: IdentityLifecycleCommand[] = [];
    const externalIdUpdates: Array<{ workosUserId: string; externalId: string }> = [];
    app = buildAuthSessionApp({
      authKitClient: createAuthKitClient({
        async updateUserExternalId(input) {
          externalIdUpdates.push(input);
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
            userId: "user_jit_created",
            events: [],
          };
        },
      },
    });

    const response = await app.inject({
      method: "GET",
      url: "/auth/workos/callback?code=auth-code&state=callback-state",
      headers: {
        cookie: "vayada_workos_state=callback-state",
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().user.id).toBe("user_jit_created");
    expect(commands).toEqual([
      expect.objectContaining({
        commandType: "identity.user.create",
        idempotencyKey: "workos-jit:user_workos_platform",
        payload: expect.objectContaining({
          email: "f.maliqi@vayada.com",
          providerIdentity: expect.objectContaining({
            provider: "workos",
            providerUserId: "user_workos_platform",
          }),
        }),
      }),
    ]);
    expect(externalIdUpdates).toEqual([
      {
        workosUserId: "user_workos_platform",
        externalId: "user_jit_created",
      },
    ]);
  });

  it("rejects callback when the selected WorkOS organization is unknown", async () => {
    app = buildAuthSessionApp({
      identityRepository: createIdentityRepository({
        organizationByWorkosOrgId: async () => null,
      }),
    });

    const response = await app.inject({
      method: "GET",
      url: "/auth/workos/callback?code=auth-code&state=callback-state",
      headers: {
        cookie: "vayada_workos_state=callback-state",
      },
    });

    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({
      error: "auth_session_rejected",
      message: "No WorkOS-managed organization for org_workos_platform",
    });
  });

  it("rejects callback when the selected organization membership is inactive", async () => {
    app = buildAuthSessionApp({
      identityRepository: createIdentityRepository({
        activeMembership: async () => ({
          membershipId: "membership_platform",
          status: "inactive",
          roleKey: "platform_admin",
          workosMembershipId: "om_platform",
          workosRoleSlugs: ["platform_admin"],
        }),
      }),
    });

    const response = await app.inject({
      method: "GET",
      url: "/auth/workos/callback?code=auth-code&state=callback-state",
      headers: {
        cookie: "vayada_workos_state=callback-state",
      },
    });

    expect(response.statusCode).toBe(403);
    expect(response.json().message).toBe("No active membership for selected organization");
  });

  it("rejects callback when the selected organization is not the platform org", async () => {
    app = buildAuthSessionApp({
      identityRepository: createIdentityRepository({
        organizationByWorkosOrgId: async () => ({
          organizationId: "org_hotel_group",
          workosOrgId: "org_workos_hotel_group",
          name: "Alpenrose Hotel Group",
          kind: "hotel_group",
          status: "active",
        }),
      }),
    });

    const response = await app.inject({
      method: "GET",
      url: "/auth/workos/callback?code=auth-code&state=callback-state",
      headers: {
        cookie: "vayada_workos_state=callback-state",
      },
    });

    expect(response.statusCode).toBe(403);
    expect(response.json().message).toBe("Selected organization must be platform");
  });

  it("rejects callback when the platform membership is not platform_admin", async () => {
    app = buildAuthSessionApp({
      identityRepository: createIdentityRepository({
        activeMembership: async () => ({
          membershipId: "membership_platform",
          status: "active",
          roleKey: "platform_member",
          workosMembershipId: "om_platform",
          workosRoleSlugs: ["platform_member"],
        }),
      }),
    });

    const response = await app.inject({
      method: "GET",
      url: "/auth/workos/callback?code=auth-code&state=callback-state",
      headers: {
        cookie: "vayada_workos_state=callback-state",
      },
    });

    expect(response.statusCode).toBe(403);
    expect(response.json().message).toBe("Selected organization membership must be platform_admin");
  });

  it("rejects callback when AuthKit session has no selected organization and no surface candidates", async () => {
    app = buildAuthSessionApp({
      authKitClient: createAuthKitClient({
        async authenticateWithCode() {
          return {
            ...session,
            organizationId: undefined,
          };
        },
      }),
    });

    const response = await app.inject({
      method: "GET",
      url: "/auth/workos/callback?code=auth-code&state=callback-state",
      headers: {
        cookie: "vayada_workos_state=callback-state",
      },
    });

    expect(response.statusCode).toBe(403);
    expect(response.json().message).toBe(
      "No active platform organization is available for this surface",
    );
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
    expect(response.json().resources).toBeUndefined();
  });

  it("returns a PMS organization selector filtered to active hotel groups", async () => {
    const noOrgSession: AuthKitSession = {
      ...session,
      organizationId: undefined,
    };
    app = buildAuthSessionApp({
      allowedOrigins: ["https://pms.localhost"],
      authKitClient: createAuthKitClient({
        async authenticateSession() {
          return noOrgSession;
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
      csrfToken: "csrf-token",
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

  it("requires PMS organization selection when an ambient WorkOS org is ambiguous", async () => {
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
    expect(response.json()).toMatchObject({
      organizationSelectionRequired: true,
      csrfToken: "csrf-token",
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

  it("returns booking resource scope on normal AuthKit session reads", async () => {
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
  });

  it("allows normal PMS session reads before a PMS product resource link exists", async () => {
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
    expect(response.json().resources).toBeUndefined();
  });

  it("rejects hotel-admin compatibility tokens when resource links are missing", async () => {
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
        linkedResources: async () => [],
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

function buildAuthSessionApp(
  options: {
    authKitClient?: AuthKitClient;
    identityRepository?: IdentityRepository;
    lifecycleCommandBus?: IdentityLifecycleCommandBus;
    productAuditSink?: { record(event: ProductAuditEvent): Promise<void> };
    tokenVerifier?: TokenVerifier;
    callbackReturnUrl?: string;
    legacyMarketplaceJwtSecret?: string;
    allowedOrigins?: string[];
    surfacePolicies?: Partial<
      Record<
        "platform-admin" | "booking-admin" | "pms-web" | "affiliate-dashboard" | "marketplace-web",
        AuthSurfacePolicy
      >
    >;
  } = {},
) {
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
      callbackUrl: "https://api.localhost/auth/workos/callback",
      callbackReturnUrl: options.callbackReturnUrl,
      logoutReturnUrl: "https://admin.localhost/login",
      allowedOrigins: options.allowedOrigins ?? ["https://admin.localhost"],
      requiredOrganizationKind: "platform",
      surfacePolicies: options.surfacePolicies,
      cookieSecure: false,
      stateCookieSecret: TEST_STATE_COOKIE_SECRET,
      legacyMarketplaceJwtSecret: options.legacyMarketplaceJwtSecret,
    },
  });
}

function readJwtPayload(token: string): Record<string, unknown> {
  const [, payload] = token.split(".");
  if (!payload) throw new Error("JWT payload segment missing");
  return JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
}

function createAuthKitClient(overrides: Partial<AuthKitClient> = {}): AuthKitClient {
  return {
    getAuthorizationUrl(input) {
      const url = new URL("https://auth.workos.test/authorize");
      url.searchParams.set("redirect_uri", input.redirectUri);
      url.searchParams.set("state", input.state);
      if (input.organizationId) url.searchParams.set("organization_id", input.organizationId);
      if (input.loginHint) url.searchParams.set("login_hint", input.loginHint);
      if (input.screenHint) url.searchParams.set("screen_hint", input.screenHint);
      return url.toString();
    },
    async authenticateWithCode() {
      return session;
    },
    async authenticateSession() {
      return session;
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
    ...overrides,
  };
}

function encodeTestStateCookie(
  input: Array<{
    state: string;
    surface?: string;
    returnTo?: string;
    authFlow?: string;
    signupIntent?: string;
  }>,
): string {
  const payload = Buffer.from(JSON.stringify(input)).toString("base64url");
  return `v2.${payload}.${createHmac("sha256", TEST_STATE_COOKIE_SECRET)
    .update(payload)
    .digest("base64url")}`;
}

function readStateCookieContexts(response: { headers: { "set-cookie"?: unknown } }): unknown {
  const setCookie = response.headers["set-cookie"];
  const cookies = Array.isArray(setCookie) ? setCookie : [setCookie];
  const stateCookie = cookies
    .filter((cookie): cookie is string => typeof cookie === "string")
    .find((cookie) => cookie.startsWith("vayada_workos_state="));
  if (!stateCookie) throw new Error("state cookie missing");
  const value = stateCookie.split(";")[0]!.slice("vayada_workos_state=".length);
  const [version, payload, signature] = value.split(".");
  if (version !== "v2" || !payload || !signature) {
    throw new Error("state cookie payload missing");
  }
  const expectedSignature = createHmac("sha256", TEST_STATE_COOKIE_SECRET)
    .update(payload)
    .digest("base64url");
  expect(signature).toBe(expectedSignature);
  return JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
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
