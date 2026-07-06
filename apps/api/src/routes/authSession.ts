import { createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import type {
  IdentityLifecycleCommandBus,
  IdentityLifecycleCommandResult,
  IdentityMembershipOrganization,
  IdentityResourceLink,
  IdentityRepository,
  IdentityUser,
  MembershipStatus,
  OrganizationKind,
  PermissionKey,
  Product,
  ResourceType,
  TokenVerifier,
} from "@vayada/backend-auth";
import type { FastifyInstance, FastifyPluginAsync, FastifyReply, FastifyRequest } from "fastify";

import { mapWorkOSAuthError } from "../platform/workosAuthState.js";

export type AuthKitUser = {
  id: string;
  email: string;
  emailVerified: boolean;
  name?: string | null;
};

export type AuthKitSession = {
  accessToken: string;
  sealedSession: string;
  user: AuthKitUser;
  organizationId?: string;
  sessionId?: string;
};

export type AuthKitClient = {
  getAuthorizationUrl(input: {
    redirectUri: string;
    state: string;
    organizationId?: string;
    loginHint?: string;
    screenHint?: "sign-in" | "sign-up";
  }): string;
  authenticateWithCode(input: {
    code: string;
    ipAddress?: string;
    userAgent?: string;
  }): Promise<AuthKitSession>;
  authenticateWithPassword(input: {
    email: string;
    password: string;
    ipAddress?: string;
    userAgent?: string;
  }): Promise<AuthKitSession>;
  createUser(input: {
    email: string;
    password: string;
    ipAddress?: string;
    userAgent?: string;
    metadata?: Record<string, string>;
  }): Promise<AuthKitUser>;
  authenticateSession(input: { sealedSession: string }): Promise<AuthKitSession | null>;
  refreshSession(input: {
    sealedSession: string;
    organizationId?: string;
  }): Promise<AuthKitSession | null>;
  createSignupOrganization(input: {
    name: string;
    externalId: string;
    metadata: Record<string, string>;
  }): Promise<{ organizationId: string }>;
  ensureSignupOrganizationMembership(input: {
    workosUserId: string;
    workosOrganizationId: string;
    roleKey: string;
  }): Promise<{ membershipId: string; roleSlugs: string[]; status?: MembershipStatus }>;
  getLogoutUrl(input: { sealedSession: string; returnTo: string }): Promise<string>;
  updateUserExternalId(input: { workosUserId: string; externalId: string }): Promise<void>;
};

export type ProductAuditEvent = {
  action: "auth.login" | "auth.login.failed" | "auth.logout" | "auth.compatibility_token.issued";
  authFlow?: "login" | "signup";
  actorUserId?: string;
  failureReason?: string;
  organizationId?: string;
  surface?: AuthSurface;
  signupIntent?: AuthSignupIntent;
  resourceScope?: Record<string, string[]>;
  workosUserId?: string;
  workosOrgId?: string;
  workosSessionId?: string;
  requestId: string;
  occurredAt: string;
};

export type ProductAuditSink = {
  record(event: ProductAuditEvent): Promise<void>;
};

export type AuthSurface =
  | "platform-admin"
  | "booking-admin"
  | "pms-web"
  | "affiliate-dashboard"
  | "marketplace-web";

export type AuthSignupIntent = "admin" | "hotel" | "creator";

export type RequiredResourceLink = {
  product: Product;
  resourceType: ResourceType;
};

export type AuthSurfacePolicy = {
  requiredOrganizationKind: OrganizationKind | OrganizationKind[];
  callbackReturnUrl?: string;
  logoutReturnUrl?: string;
  legacyJwtSecret?: string;
  legacyJwtUserType?: string;
  requiredMembershipRoleKey?: string;
  requiredResourceLink?: RequiredResourceLink;
  requireExplicitOrganizationSelection?: boolean;
  selectedOrganizationCookieName?: string;
};

export type AuthSessionRouteOptions = {
  authKitClient: AuthKitClient;
  identityRepository: IdentityRepository;
  lifecycleCommandBus: IdentityLifecycleCommandBus;
  productAuditSink: ProductAuditSink;
  tokenVerifier: TokenVerifier;
  callbackUrl: string;
  callbackReturnUrl?: string;
  logoutReturnUrl: string;
  allowedOrigins: string[];
  requiredOrganizationKind: OrganizationKind;
  surfacePolicies?: Partial<Record<AuthSurface, AuthSurfacePolicy>>;
  cookieSecure: boolean;
  stateCookieSecret: string;
  cookieDomain?: string;
  legacyMarketplaceJwtSecret?: string;
};

const SESSION_COOKIE = "vayada_workos_session";
const STATE_COOKIE = "vayada_workos_state";
const CSRF_COOKIE = "vayada_auth_csrf";
const DEFAULT_SURFACE: AuthSurface = "platform-admin";
const MAX_PENDING_AUTH_STATES = 5;
const AUTH_STATE_COOKIE_MAX_AGE_SECONDS = 60 * 60;

type AuthStateContext = {
  state: string;
  surface: AuthSurface;
  returnTo?: string;
  authFlow?: "login" | "signup";
  signupIntent?: AuthSignupIntent;
};

type AuthSignupOrganizationContext = {
  workosOrganizationId: string;
  workosExternalId: string;
  name: string;
  kind: OrganizationKind;
  roleKey: string;
};

type AuthSignupContext = {
  intent: AuthSignupIntent;
  organization: AuthSignupOrganizationContext;
  membership?: AuthSignupMembershipContext;
};

type AuthSignupMembershipContext = {
  workosMembershipId: string;
  workosRoleSlugs: string[];
  status?: MembershipStatus;
};

type AuthSignupSessionResolution = {
  session: AuthKitSession;
  organization?: AuthSignupOrganizationContext;
  membership?: AuthSignupMembershipContext;
};

type AuthOrganizationCandidate = {
  organizationId: string;
  workosOrganizationId: string;
  displayName: string;
  kind: OrganizationKind;
  roleKey: string;
};

type OrganizationAccessOptions = {
  requireResourceLink?: boolean;
  skipSelection?: boolean;
  explicitOrganizationSelection?: boolean;
  selectedWorkosOrganizationId?: string | null;
};

export const registerAuthSessionRoutes: FastifyPluginAsync<AuthSessionRouteOptions> = async (
  app: FastifyInstance,
  options: AuthSessionRouteOptions,
) => {
  app.get("/workos/login", async (request, reply) => {
    const query = request.query as {
      organization_id?: string;
      login_hint?: string;
      surface?: string;
      return_to?: string;
    };
    const surface = parseSurface(query.surface);
    const surfacePolicy = getSurfacePolicy(surface, options);
    const returnTo = query.return_to
      ? validateReturnTo(query.return_to, options.allowedOrigins)
      : undefined;
    const state = randomBytes(24).toString("base64url");
    const authorizationUrl = options.authKitClient.getAuthorizationUrl({
      redirectUri: options.callbackUrl,
      state,
      organizationId: query.organization_id,
      loginHint: query.login_hint,
    });

    reply
      .headers({
        "set-cookie": [
          ...clearHostOnlyCookies(
            [
              STATE_COOKIE,
              SESSION_COOKIE,
              CSRF_COOKIE,
              ...selectedOrganizationCookieNames(surfacePolicy),
            ],
            {
              secure: options.cookieSecure,
              domain: options.cookieDomain,
            },
          ),
          ...clearSelectedOrganizationCookieHeaders(surfacePolicy, options),
          serializeCookie(
            STATE_COOKIE,
            encodeStateCookie(
              addStateContext(
                decodeStateCookies(readCookies(request, STATE_COOKIE), options.stateCookieSecret),
                {
                  state,
                  surface,
                  returnTo,
                },
              ),
              options.stateCookieSecret,
            ),
            {
              maxAge: AUTH_STATE_COOKIE_MAX_AGE_SECONDS,
              secure: options.cookieSecure,
              domain: options.cookieDomain,
            },
          ),
        ],
      })
      .redirect(authorizationUrl);
  });

  app.get("/workos/signup", async (request, reply) => {
    try {
      const query = request.query as {
        login_hint?: string;
        surface?: string;
        return_to?: string;
        intent?: string;
      };
      const surface = parseRequiredSignupSurface(query.surface);
      const surfacePolicy = getSurfacePolicy(surface, options);
      const signupIntent = parseSignupIntent(surface, query.intent);
      const returnTo = query.return_to
        ? validateReturnTo(query.return_to, options.allowedOrigins)
        : undefined;
      const state = randomBytes(24).toString("base64url");
      const authorizationUrl = options.authKitClient.getAuthorizationUrl({
        redirectUri: options.callbackUrl,
        state,
        loginHint: query.login_hint,
        screenHint: "sign-up",
      });

      return reply
        .headers({
          "set-cookie": [
            ...clearHostOnlyCookies(
              [
                STATE_COOKIE,
                SESSION_COOKIE,
                CSRF_COOKIE,
                ...selectedOrganizationCookieNames(surfacePolicy),
              ],
              {
                secure: options.cookieSecure,
                domain: options.cookieDomain,
              },
            ),
            ...clearSelectedOrganizationCookieHeaders(surfacePolicy, options),
            serializeCookie(
              STATE_COOKIE,
              encodeStateCookie(
                addStateContext(
                  decodeStateCookies(readCookies(request, STATE_COOKIE), options.stateCookieSecret),
                  {
                    state,
                    surface,
                    returnTo,
                    authFlow: "signup",
                    signupIntent,
                  },
                ),
                options.stateCookieSecret,
              ),
              {
                maxAge: AUTH_STATE_COOKIE_MAX_AGE_SECONDS,
                secure: options.cookieSecure,
                domain: options.cookieDomain,
              },
            ),
          ],
        })
        .redirect(authorizationUrl);
    } catch (error) {
      return reply.code(400).send({
        error: "invalid_signup_request",
        message: error instanceof Error ? error.message : "Invalid hosted signup request.",
      });
    }
  });

  for (const path of [
    "/password/login",
    "/password/signup",
    "/session",
    "/session/refresh",
    "/logout",
    "/compat/marketplace-admin-token",
    "/compat/booking-admin-token",
    "/compat/pms-web-token",
    "/compat/affiliate-dashboard-token",
    "/compat/marketplace-web-token",
  ]) {
    app.options(path, async (request, reply) => {
      if (!writeCorsHeaders(request, reply, options)) {
        return reply.code(403).send();
      }
      return reply.code(204).send();
    });
  }

  app.post("/password/login", async (request, reply) => {
    if (!writeCorsHeaders(request, reply, options)) {
      return reply.code(403).send({
        state: "auth_failed",
        message: "Authentication request origin is not allowed.",
      });
    }
    const parsed = parsePasswordLoginBody(request.body);
    if (!parsed.ok) {
      return reply.code(400).send(parsed.error);
    }

    const surfacePolicy = getSurfacePolicy(parsed.surface, options);
    let session: AuthKitSession;
    try {
      session = await options.authKitClient.authenticateWithPassword({
        email: parsed.email,
        password: parsed.password,
        ipAddress: request.ip,
        userAgent: request.headers["user-agent"],
      });
    } catch (error) {
      const mapped = mapWorkOSAuthError(error);
      await recordPasswordLoginFailure(options, request, parsed.surface, mapped.state);
      if (mapped.state === "auth_failed") {
        request.log.error({ err: error }, "WorkOS password authentication failed");
      }
      return reply.code(statusForPasswordAuthFailure(mapped.state)).send(mapped);
    }

    let resolution: IdentityResolution;
    try {
      resolution = await resolveOrCreateIdentity(
        session,
        request,
        options,
        surfacePolicy,
        organizationAccessOptionsFromRequest(request, surfacePolicy),
      );
    } catch (error) {
      if (error instanceof OrganizationSelectionRequiredError) {
        return sendOrganizationSelectionRedirect(
          reply,
          session,
          error,
          undefined,
          surfacePolicy,
          options,
        );
      }
      await recordPasswordLoginFailure(options, request, parsed.surface, "identity_resolution", {
        workosUserId: session.user.id,
        workosOrgId: session.organizationId,
        workosSessionId: session.sessionId,
      });
      request.log.warn({ err: error }, "Password login identity resolution failed");
      return reply.code(403).send(toAuthError(error));
    }

    await options.productAuditSink.record({
      action: "auth.login",
      authFlow: "login",
      actorUserId: resolution.user.userId,
      organizationId: resolution.organizationId,
      surface: parsed.surface,
      workosUserId: session.user.id,
      workosOrgId: resolution.session.organizationId,
      workosSessionId: resolution.session.sessionId,
      requestId: request.id,
      occurredAt: new Date().toISOString(),
    });

    const csrfToken = randomBytes(24).toString("base64url");
    reply.headers({
      "set-cookie": [
        serializeCookie(STATE_COOKIE, "", {
          maxAge: 0,
          secure: options.cookieSecure,
          domain: options.cookieDomain,
        }),
        serializeCookie(SESSION_COOKIE, resolution.session.sealedSession, {
          maxAge: 60 * 60 * 24 * 7,
          secure: options.cookieSecure,
          domain: options.cookieDomain,
        }),
        serializeCookie(CSRF_COOKIE, csrfToken, {
          maxAge: 60 * 60 * 24 * 7,
          secure: options.cookieSecure,
          domain: options.cookieDomain,
          httpOnly: false,
        }),
        ...selectedOrganizationCookieHeaders(resolution.session, surfacePolicy, options),
      ],
    });
    return reply.send(
      toSessionResponse(
        resolution.session,
        resolution.user,
        csrfToken,
        resolution.organizationId,
        resolution.organizationKind,
        resolution.resourceScope,
      ),
    );
  });

  app.post("/password/signup", async (request, reply) => {
    if (!writeCorsHeaders(request, reply, options)) {
      return reply.code(403).send({
        state: "auth_failed",
        message: "Authentication request origin is not allowed.",
      });
    }
    const parsed = parsePasswordSignupBody(request.body);
    if (!parsed.ok) {
      return reply.code(400).send(parsed.error);
    }

    const surfacePolicy = getSurfacePolicy(parsed.surface, options);
    let createdUser = false;
    try {
      await options.authKitClient.createUser({
        email: parsed.email,
        password: parsed.password,
        ipAddress: request.ip,
        userAgent: request.headers["user-agent"],
        metadata: {
          auth_flow: "signup",
          surface: parsed.surface,
          signup_intent: parsed.intent,
        },
      });
      createdUser = true;
    } catch (error) {
      if (!isConflictError(error)) {
        return reply.code(400).send({
          state: "auth_failed",
          message: "Signup failed. Please check your details and try again.",
        });
      }
    }

    let session: AuthKitSession;
    try {
      session = await options.authKitClient.authenticateWithPassword({
        email: parsed.email,
        password: parsed.password,
        ipAddress: request.ip,
        userAgent: request.headers["user-agent"],
      });
    } catch (error) {
      const mapped = mapWorkOSAuthError(error);
      return reply
        .code(mapped.state === "invalid_credentials" && !createdUser ? 401 : 403)
        .send(mapped);
    }

    let signupOrganization: AuthSignupOrganizationContext;
    let signupMembership: AuthSignupMembershipContext;
    let selectedSession: AuthKitSession;
    try {
      signupOrganization = await createSignupOrganizationContext(
        options.authKitClient,
        parsed.surface,
        parsed.intent,
        parsed.email,
        session.user.id,
      );
      const membership = await options.authKitClient.ensureSignupOrganizationMembership({
        workosUserId: session.user.id,
        workosOrganizationId: signupOrganization.workosOrganizationId,
        roleKey: signupOrganization.roleKey,
      });
      signupMembership = {
        workosMembershipId: membership.membershipId,
        workosRoleSlugs: membership.roleSlugs,
        status: membership.status,
      };
      selectedSession = await selectSignupOrganizationSession(
        session,
        signupOrganization,
        options.authKitClient,
      );
    } catch (error) {
      return reply.code(403).send(toAuthError(error));
    }

    let resolution: IdentityResolution;
    try {
      resolution = await resolveOrCreateIdentity(
        selectedSession,
        request,
        options,
        surfacePolicy,
        organizationAccessOptionsFromRequest(request, surfacePolicy),
        {
          intent: parsed.intent,
          organization: signupOrganization,
          membership: signupMembership,
        },
      );
    } catch (error) {
      if (error instanceof OrganizationSelectionRequiredError) {
        return sendOrganizationSelectionRedirect(
          reply,
          selectedSession,
          error,
          undefined,
          surfacePolicy,
          options,
        );
      }
      return reply.code(403).send(toAuthError(error));
    }

    await options.productAuditSink.record({
      action: "auth.login",
      authFlow: "signup",
      actorUserId: resolution.user.userId,
      organizationId: resolution.organizationId,
      surface: parsed.surface,
      signupIntent: parsed.intent,
      workosUserId: selectedSession.user.id,
      workosOrgId: resolution.session.organizationId,
      workosSessionId: resolution.session.sessionId,
      requestId: request.id,
      occurredAt: new Date().toISOString(),
    });

    const csrfToken = randomBytes(24).toString("base64url");
    reply.headers({
      "set-cookie": [
        serializeCookie(STATE_COOKIE, "", {
          maxAge: 0,
          secure: options.cookieSecure,
          domain: options.cookieDomain,
        }),
        serializeCookie(SESSION_COOKIE, resolution.session.sealedSession, {
          maxAge: 60 * 60 * 24 * 7,
          secure: options.cookieSecure,
          domain: options.cookieDomain,
        }),
        serializeCookie(CSRF_COOKIE, csrfToken, {
          maxAge: 60 * 60 * 24 * 7,
          secure: options.cookieSecure,
          domain: options.cookieDomain,
          httpOnly: false,
        }),
        ...selectedOrganizationCookieHeaders(resolution.session, surfacePolicy, options),
      ],
    });
    return reply.send(
      toSessionResponse(
        resolution.session,
        resolution.user,
        csrfToken,
        resolution.organizationId,
        resolution.organizationKind,
        resolution.resourceScope,
      ),
    );
  });

  app.get("/workos/callback", async (request, reply) => {
    const query = request.query as {
      code?: string;
      state?: string;
      error?: string;
      error_description?: string;
    };
    if (query.error) {
      return reply.code(400).send({
        error: "authkit_callback_error",
        message: query.error_description ?? query.error,
      });
    }
    const stateContext = decodeStateCookies(
      readCookies(request, STATE_COOKIE),
      options.stateCookieSecret,
    )
      .flatMap((candidate) => {
        const validated = validateDecodedStateContext(candidate, options.allowedOrigins);
        return validated ? [validated] : [];
      })
      .find((candidate) => candidate.state === query.state);
    if (!query.code || !query.state || !stateContext) {
      return reply.code(400).send({
        error: "invalid_auth_state",
        message: "AuthKit callback state is missing, expired, or invalid.",
      });
    }
    const surfacePolicy = getSurfacePolicy(stateContext.surface, options);

    let session: AuthKitSession;
    let effectiveStateContext = stateContext;
    let signupOrganization: AuthSignupOrganizationContext | undefined;
    let signupMembership: AuthSignupMembershipContext | undefined;
    try {
      const authenticatedSession = await options.authKitClient.authenticateWithCode({
        code: query.code,
        ipAddress: request.ip,
        userAgent: request.headers["user-agent"],
      });
      const signupResolution = await ensureSignupOrganizationSession(
        authenticatedSession,
        effectiveStateContext,
        options.authKitClient,
      );
      let resolvedSignup = signupResolution;
      if (!resolvedSignup.organization && !authenticatedSession.organizationId) {
        const loginSignupIntent = await loginPageSignupIntent(
          authenticatedSession,
          effectiveStateContext,
          options,
        );
        if (loginSignupIntent) {
          effectiveStateContext = {
            ...effectiveStateContext,
            authFlow: "signup",
            signupIntent: loginSignupIntent,
          };
          resolvedSignup = await ensureSignupOrganizationSession(
            authenticatedSession,
            effectiveStateContext,
            options.authKitClient,
          );
        }
      }
      session = resolvedSignup.session;
      signupOrganization = resolvedSignup.organization;
      signupMembership = resolvedSignup.membership;
    } catch (error) {
      return reply.code(403).send(toAuthError(error));
    }
    let resolution: IdentityResolution;
    try {
      resolution = await resolveOrCreateIdentity(
        session,
        request,
        options,
        surfacePolicy,
        organizationAccessOptionsFromRequest(request, surfacePolicy),
        signupContextFromState(effectiveStateContext, signupOrganization, signupMembership),
      );
    } catch (error) {
      if (error instanceof OrganizationSelectionRequiredError) {
        return sendOrganizationSelectionRedirect(
          reply,
          session,
          error,
          stateContext.returnTo ?? surfacePolicy.callbackReturnUrl,
          surfacePolicy,
          options,
        );
      }
      return reply.code(403).send(toAuthError(error));
    }
    await options.productAuditSink.record({
      action: "auth.login",
      authFlow: effectiveStateContext.authFlow ?? "login",
      actorUserId: resolution.user.userId,
      organizationId: resolution.organizationId,
      surface: effectiveStateContext.surface,
      signupIntent: effectiveStateContext.signupIntent,
      workosUserId: session.user.id,
      workosOrgId: resolution.session.organizationId,
      workosSessionId: resolution.session.sessionId,
      requestId: request.id,
      occurredAt: new Date().toISOString(),
    });

    const csrfToken = randomBytes(24).toString("base64url");
    reply.headers({
      "set-cookie": [
        serializeCookie(STATE_COOKIE, "", {
          maxAge: 0,
          secure: options.cookieSecure,
          domain: options.cookieDomain,
        }),
        serializeCookie(SESSION_COOKIE, resolution.session.sealedSession, {
          maxAge: 60 * 60 * 24 * 7,
          secure: options.cookieSecure,
          domain: options.cookieDomain,
        }),
        serializeCookie(CSRF_COOKIE, csrfToken, {
          maxAge: 60 * 60 * 24 * 7,
          secure: options.cookieSecure,
          domain: options.cookieDomain,
          httpOnly: false,
        }),
        ...selectedOrganizationCookieHeaders(resolution.session, surfacePolicy, options),
      ],
    });
    const callbackReturnUrl = stateContext.returnTo ?? surfacePolicy.callbackReturnUrl;
    if (callbackReturnUrl) {
      return reply.redirect(callbackReturnUrl);
    }
    return reply.send(
      toSessionResponse(
        resolution.session,
        resolution.user,
        csrfToken,
        resolution.organizationId,
        resolution.organizationKind,
        resolution.resourceScope,
      ),
    );
  });

  app.get("/session", async (request, reply) => {
    const query = request.query as { surface?: string };
    const surfacePolicy = getSurfacePolicy(parseSurface(query.surface), options);
    if (!writeCorsHeaders(request, reply, options)) {
      return reply.code(403).send({ error: "origin_rejected" });
    }
    const sealedSession = readCookie(request, SESSION_COOKIE);
    if (!sealedSession) {
      return reply.code(401).send({ error: "missing_session" });
    }
    const session = await options.authKitClient.authenticateSession({ sealedSession });
    if (!session) {
      return reply.code(401).send({ error: "invalid_session" });
    }
    let resolution: IdentityResolution;
    try {
      resolution = await resolveExistingIdentity(
        session,
        options,
        surfacePolicy,
        organizationAccessOptionsFromRequest(request, surfacePolicy),
      );
    } catch (error) {
      if (error instanceof OrganizationSelectionRequiredError) {
        return sendOrganizationSelectionResponse(reply, error, readCookie(request, CSRF_COOKIE));
      }
      return reply.code(403).send(toAuthError(error));
    }
    const setCookieHeaders = [
      ...(resolution.session.sealedSession !== session.sealedSession
        ? [
            serializeCookie(SESSION_COOKIE, resolution.session.sealedSession, {
              maxAge: 60 * 60 * 24 * 7,
              secure: options.cookieSecure,
              domain: options.cookieDomain,
            }),
          ]
        : []),
      ...selectedOrganizationCookieHeaders(resolution.session, surfacePolicy, options),
    ];
    if (setCookieHeaders.length > 0) {
      reply.header(
        "set-cookie",
        setCookieHeaders.length === 1 ? setCookieHeaders[0] : setCookieHeaders,
      );
    }
    return reply.send(
      toSessionResponse(
        resolution.session,
        resolution.user,
        readCookie(request, CSRF_COOKIE),
        resolution.organizationId,
        resolution.organizationKind,
        resolution.resourceScope,
      ),
    );
  });

  app.post("/session/refresh", async (request, reply) => {
    if (!writeCorsHeaders(request, reply, options)) {
      return reply.code(403).send({ error: "origin_rejected" });
    }
    if (!passesCsrfCheck(request, options)) {
      return reply.code(403).send({ error: "csrf_rejected" });
    }
    const sealedSession = readCookie(request, SESSION_COOKIE);
    if (!sealedSession) {
      return reply.code(401).send({ error: "missing_session" });
    }
    const body = request.body as { organizationId?: string; surface?: string } | undefined;
    const surfacePolicy = getSurfacePolicy(parseSurface(body?.surface), options);
    const session = await options.authKitClient.refreshSession({
      sealedSession,
      organizationId: body?.organizationId,
    });
    if (!session) {
      return reply.code(401).send({ error: "invalid_session" });
    }
    let resolution: IdentityResolution;
    try {
      resolution = await resolveExistingIdentity(
        session,
        options,
        surfacePolicy,
        organizationAccessOptionsFromRequest(request, surfacePolicy, {
          explicitOrganizationSelection: Boolean(body?.organizationId),
        }),
      );
    } catch (error) {
      if (error instanceof OrganizationSelectionRequiredError) {
        return sendOrganizationSelectionResponse(reply, error, readCookie(request, CSRF_COOKIE));
      }
      return reply.code(403).send(toAuthError(error));
    }
    const setCookieHeaders = [
      serializeCookie(SESSION_COOKIE, resolution.session.sealedSession, {
        maxAge: 60 * 60 * 24 * 7,
        secure: options.cookieSecure,
        domain: options.cookieDomain,
      }),
      ...selectedOrganizationCookieHeaders(resolution.session, surfacePolicy, options),
    ];
    reply
      .header("set-cookie", setCookieHeaders.length === 1 ? setCookieHeaders[0] : setCookieHeaders)
      .send(
        toSessionResponse(
          resolution.session,
          resolution.user,
          readCookie(request, CSRF_COOKIE),
          resolution.organizationId,
          resolution.organizationKind,
          resolution.resourceScope,
        ),
      );
  });

  app.post("/logout", async (request, reply) => {
    if (!writeCorsHeaders(request, reply, options)) {
      return reply.code(403).send({ error: "origin_rejected" });
    }
    if (!passesCsrfCheck(request, options)) {
      return reply.code(403).send({ error: "csrf_rejected" });
    }
    const body = request.body as { surface?: string; return_to?: string } | undefined;
    const surfacePolicy = getSurfacePolicy(parseSurface(body?.surface), options);
    const sealedSession = readCookie(request, SESSION_COOKIE);
    const returnTo = body?.return_to
      ? validateReturnTo(body.return_to, options.allowedOrigins)
      : (surfacePolicy.logoutReturnUrl ?? options.logoutReturnUrl);
    let logoutUrl = returnTo;
    if (sealedSession) {
      const session = await options.authKitClient.authenticateSession({ sealedSession });
      if (session) {
        const resolution = await resolveExistingIdentity(
          session,
          options,
          surfacePolicy,
          organizationAccessOptionsFromRequest(request, surfacePolicy),
        ).catch(() => null);
        await options.productAuditSink.record({
          action: "auth.logout",
          actorUserId: resolution?.user.userId,
          organizationId: resolution?.organizationId,
          workosUserId: session.user.id,
          workosOrgId: session.organizationId,
          workosSessionId: session.sessionId,
          requestId: request.id,
          occurredAt: new Date().toISOString(),
        });
      }
      logoutUrl = await options.authKitClient.getLogoutUrl({
        sealedSession,
        returnTo,
      });
    }

    reply
      .headers({
        "set-cookie": [
          serializeCookie(SESSION_COOKIE, "", {
            maxAge: 0,
            secure: options.cookieSecure,
            domain: options.cookieDomain,
          }),
          serializeCookie(CSRF_COOKIE, "", {
            maxAge: 0,
            secure: options.cookieSecure,
            domain: options.cookieDomain,
            httpOnly: false,
          }),
          ...clearSelectedOrganizationCookieHeaders(surfacePolicy, options),
        ],
      })
      .send({ logoutUrl });
  });

  registerCompatibilityTokenRoute(app, options, {
    path: "/compat/marketplace-admin-token",
    surface: "platform-admin",
    userType: "admin",
  });
  registerCompatibilityTokenRoute(app, options, {
    path: "/compat/booking-admin-token",
    surface: "booking-admin",
    userType: "hotel",
  });
  registerCompatibilityTokenRoute(app, options, {
    path: "/compat/pms-web-token",
    surface: "pms-web",
    userType: "hotel",
  });
  registerCompatibilityTokenRoute(app, options, {
    path: "/compat/affiliate-dashboard-token",
    surface: "affiliate-dashboard",
    userType: "affiliate",
  });
  registerCompatibilityTokenRoute(app, options, {
    path: "/compat/marketplace-web-token",
    surface: "marketplace-web",
  });
};

function parseSurface(value: string | undefined): AuthSurface {
  if (!value) return DEFAULT_SURFACE;
  if (
    value === "platform-admin" ||
    value === "booking-admin" ||
    value === "pms-web" ||
    value === "affiliate-dashboard" ||
    value === "marketplace-web"
  ) {
    return value;
  }
  throw new Error(`Unsupported AuthKit surface: ${value}`);
}

function parseRequiredSignupSurface(value: string | undefined): AuthSurface {
  if (!value) {
    throw new Error("Hosted signup surface is required");
  }
  return parseSurface(value);
}

function parsePasswordLoginBody(body: unknown):
  | { ok: true; email: string; password: string; surface: AuthSurface }
  | {
      ok: false;
      error: { state: "auth_failed"; message: string };
    } {
  if (!body || typeof body !== "object") {
    return {
      ok: false,
      error: { state: "auth_failed", message: "Email and password are required." },
    };
  }
  const input = body as { email?: unknown; password?: unknown; surface?: unknown };
  const email = typeof input.email === "string" ? input.email.trim() : "";
  const password = typeof input.password === "string" ? input.password : "";
  if (!email || !password) {
    return {
      ok: false,
      error: { state: "auth_failed", message: "Email and password are required." },
    };
  }
  try {
    return {
      ok: true,
      email,
      password,
      surface: parseSurface(typeof input.surface === "string" ? input.surface : undefined),
    };
  } catch {
    return { ok: false, error: { state: "auth_failed", message: "Unsupported login surface." } };
  }
}

function statusForPasswordAuthFailure(state: string): 401 | 403 | 502 {
  if (state === "invalid_credentials") return 401;
  if (state === "auth_failed") return 502;
  return 403;
}

async function recordPasswordLoginFailure(
  options: AuthSessionRouteOptions,
  request: FastifyRequest,
  surface: AuthSurface,
  failureReason: string,
  workos?: {
    workosUserId?: string;
    workosOrgId?: string;
    workosSessionId?: string;
  },
): Promise<void> {
  try {
    await options.productAuditSink.record({
      action: "auth.login.failed",
      authFlow: "login",
      surface,
      failureReason,
      workosUserId: workos?.workosUserId,
      workosOrgId: workos?.workosOrgId,
      workosSessionId: workos?.workosSessionId,
      requestId: request.id,
      occurredAt: new Date().toISOString(),
    });
  } catch (error) {
    request.log.error({ err: error }, "Password login failure audit write failed");
  }
}

function parsePasswordSignupBody(body: unknown):
  | {
      ok: true;
      email: string;
      password: string;
      surface: AuthSurface;
      intent: AuthSignupIntent;
    }
  | {
      ok: false;
      error: { state: "auth_failed"; message: string };
    } {
  if (!body || typeof body !== "object") {
    return {
      ok: false,
      error: { state: "auth_failed", message: "Email, password, and signup type are required." },
    };
  }
  const input = body as {
    email?: unknown;
    password?: unknown;
    surface?: unknown;
    type?: unknown;
    intent?: unknown;
  };
  const email = typeof input.email === "string" ? input.email.trim() : "";
  const password = typeof input.password === "string" ? input.password : "";
  if (!email || !password) {
    return {
      ok: false,
      error: { state: "auth_failed", message: "Email and password are required." },
    };
  }
  try {
    const surface = parseSurface(
      typeof input.surface === "string" ? input.surface : "marketplace-web",
    );
    const rawIntent = typeof input.type === "string" ? input.type : input.intent;
    if (rawIntent !== "creator" && rawIntent !== "hotel") {
      return {
        ok: false,
        error: { state: "auth_failed", message: "Signup type must be creator or hotel." },
      };
    }
    const intent = parseSignupIntent(surface, rawIntent);
    return { ok: true, email, password, surface, intent };
  } catch {
    return { ok: false, error: { state: "auth_failed", message: "Unsupported signup request." } };
  }
}

function parseSignupIntent(surface: AuthSurface, value: string | undefined): AuthSignupIntent {
  const supported = signupIntentsForSurface(surface);
  if (supported.length === 0) {
    throw new Error(`Hosted signup is not supported for ${surface}`);
  }
  const intent = value;
  if (!intent) {
    throw new Error(`Hosted signup intent is required for ${surface}`);
  }
  if (!intent || !supported.includes(intent as AuthSignupIntent)) {
    throw new Error(`Unsupported hosted signup intent for ${surface}`);
  }
  return intent as AuthSignupIntent;
}

function signupIntentsForSurface(surface: AuthSurface): readonly AuthSignupIntent[] {
  switch (surface) {
    case "platform-admin":
      return [];
    case "booking-admin":
    case "pms-web":
      return ["hotel"];
    case "marketplace-web":
      return ["creator", "hotel"];
    case "affiliate-dashboard":
      return [];
  }
}

async function createSignupOrganizationContext(
  authKitClient: AuthKitClient,
  surface: AuthSurface,
  signupIntent: AuthSignupIntent,
  loginHint: string | undefined,
  externalIdSuffix: string,
): Promise<AuthSignupOrganizationContext> {
  const template = signupOrganizationTemplate(surface, signupIntent, loginHint, externalIdSuffix);
  const organization = await authKitClient.createSignupOrganization({
    name: template.name,
    externalId: template.externalId,
    metadata: {
      auth_flow: "signup",
      surface,
      signup_intent: signupIntent,
      organization_kind: template.kind,
      role_key: template.roleKey,
    },
  });
  return {
    workosOrganizationId: organization.organizationId,
    workosExternalId: template.externalId,
    name: template.name,
    kind: template.kind,
    roleKey: template.roleKey,
  };
}

function signupOrganizationTemplate(
  surface: AuthSurface,
  signupIntent: AuthSignupIntent,
  loginHint: string | undefined,
  externalIdSuffix: string,
): { externalId: string; kind: OrganizationKind; name: string; roleKey: string } {
  const emailLabel = loginHint?.split("@")[0]?.trim();
  const displayName = emailLabel ? humanizeLabel(emailLabel) : null;
  switch (signupIntent) {
    case "admin":
      return {
        externalId: `vayada-signup:${surface}:admin:${externalIdSuffix}`,
        kind: "platform",
        name: displayName ? `${displayName} Platform Admin` : "Vayada Platform Admin",
        roleKey: "platform_admin",
      };
    case "hotel":
      return {
        externalId: `vayada-signup:${surface}:hotel:${externalIdSuffix}`,
        kind: "hotel_group",
        name: displayName ? `${displayName} Hotel Group` : "New Hotel Group",
        roleKey: "hotel_owner",
      };
    case "creator":
      return {
        externalId: `vayada-signup:${surface}:creator:${externalIdSuffix}`,
        kind: "creator_workspace",
        name: displayName ? `${displayName} Workspace` : "New Creator Workspace",
        roleKey: "creator_owner",
      };
  }
}

function humanizeLabel(value: string): string {
  const label = value
    .replace(/[^a-zA-Z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
  return (
    label
      .split(" ")
      .filter(Boolean)
      .map((part) => `${part[0]?.toUpperCase() ?? ""}${part.slice(1)}`)
      .join(" ") || "New"
  );
}

function getSurfacePolicy(
  surface: AuthSurface,
  options: AuthSessionRouteOptions,
): AuthSurfacePolicy {
  const defaultPlatformPolicy: AuthSurfacePolicy = {
    requiredOrganizationKind: options.requiredOrganizationKind,
    callbackReturnUrl: options.callbackReturnUrl,
    logoutReturnUrl: options.logoutReturnUrl,
    legacyJwtSecret: options.legacyMarketplaceJwtSecret,
    legacyJwtUserType: "admin",
    requiredMembershipRoleKey: "platform_admin",
  };
  if (surface === DEFAULT_SURFACE) {
    return { ...defaultPlatformPolicy, ...options.surfacePolicies?.[surface] };
  }
  const configured = options.surfacePolicies?.[surface];
  if (!configured) {
    throw new Error(`AuthKit surface is not configured: ${surface}`);
  }
  return configured;
}

function validateReturnTo(rawReturnTo: string, allowedOrigins: string[]): string {
  let url: URL;
  try {
    url = new URL(rawReturnTo);
  } catch {
    throw new Error("Invalid AuthKit return_to URL");
  }
  if (!allowedOrigins.includes(url.origin)) {
    throw new Error("AuthKit return_to origin is not allowed");
  }
  return url.toString();
}

function addStateContext(existing: AuthStateContext[], next: AuthStateContext): AuthStateContext[] {
  return [...existing.filter((candidate) => candidate.state !== next.state), next].slice(
    -MAX_PENDING_AUTH_STATES,
  );
}

function encodeStateCookie(input: AuthStateContext[], secret: string): string {
  const payload = Buffer.from(JSON.stringify(input)).toString("base64url");
  return `v2.${payload}.${signStatePayload(payload, secret)}`;
}

function decodeStateCookies(values: string[], secret: string): AuthStateContext[] {
  return values.flatMap((value) => decodeStateCookie(value, secret));
}

function decodeStateCookie(value: string | undefined, secret: string): AuthStateContext[] {
  if (!value) return [];
  if (value.startsWith("v2.")) {
    const [, payload, signature] = value.split(".");
    if (!payload || !signature || !verifyStatePayload(payload, signature, secret)) return [];
    try {
      const parsed = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
      const candidates = Array.isArray(parsed) ? parsed : [parsed];
      return candidates.flatMap((candidate) => {
        const stateContext = parseStateContext(candidate);
        return stateContext ? [stateContext] : [];
      });
    } catch {
      return [];
    }
  }
  if (!value.startsWith("v1.")) {
    return [{ state: value, surface: DEFAULT_SURFACE }];
  }
  try {
    const parsed = JSON.parse(Buffer.from(value.slice(3), "base64url").toString("utf8"));
    const candidates = Array.isArray(parsed) ? parsed : [parsed];
    return candidates.flatMap((candidate) => {
      const stateContext = parseStateContext(candidate);
      if (stateContext?.authFlow === "signup") return [];
      return stateContext ? [stateContext] : [];
    });
  } catch {
    return [];
  }
}

function parseStateContext(candidate: unknown): AuthStateContext | null {
  if (!candidate || typeof candidate !== "object") return null;
  const raw = candidate as {
    state?: unknown;
    surface?: unknown;
    returnTo?: unknown;
    authFlow?: unknown;
    signupIntent?: unknown;
  };
  if (typeof raw.state !== "string") return null;
  try {
    const surface = parseSurface(typeof raw.surface === "string" ? raw.surface : undefined);
    const authFlow = raw.authFlow === "signup" ? "signup" : undefined;
    return {
      state: raw.state,
      surface,
      returnTo: typeof raw.returnTo === "string" ? raw.returnTo : undefined,
      authFlow,
      signupIntent:
        authFlow === "signup" && typeof raw.signupIntent === "string"
          ? parseSignupIntent(surface, raw.signupIntent)
          : undefined,
    };
  } catch {
    return null;
  }
}

function validateDecodedStateContext(
  candidate: AuthStateContext,
  allowedOrigins: string[],
): AuthStateContext | null {
  if (!candidate.returnTo) return candidate;
  try {
    return {
      ...candidate,
      returnTo: validateReturnTo(candidate.returnTo, allowedOrigins),
    };
  } catch {
    return null;
  }
}

function signStatePayload(payload: string, secret: string): string {
  return createHmac("sha256", secret).update(payload).digest("base64url");
}

function verifyStatePayload(payload: string, signature: string, secret: string): boolean {
  const expected = signStatePayload(payload, secret);
  try {
    return timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
  } catch {
    return false;
  }
}

async function ensureSignupOrganizationSession(
  session: AuthKitSession,
  stateContext: AuthStateContext,
  authKitClient: AuthKitClient,
): Promise<AuthSignupSessionResolution> {
  if (stateContext.authFlow !== "signup" || !stateContext.signupIntent) {
    return { session };
  }
  const signupOrganization = await createSignupOrganizationContext(
    authKitClient,
    stateContext.surface,
    stateContext.signupIntent,
    session.user.email,
    stateContext.state,
  );
  const membership = await authKitClient.ensureSignupOrganizationMembership({
    workosUserId: session.user.id,
    workosOrganizationId: signupOrganization.workosOrganizationId,
    roleKey: signupOrganization.roleKey,
  });
  const signupMembership = {
    workosMembershipId: membership.membershipId,
    workosRoleSlugs: membership.roleSlugs,
    status: membership.status,
  };
  const selectedSession = await selectSignupOrganizationSession(
    session,
    signupOrganization,
    authKitClient,
  );
  return {
    session: selectedSession,
    organization: signupOrganization,
    membership: signupMembership,
  };
}

async function selectSignupOrganizationSession(
  session: AuthKitSession,
  signupOrganization: AuthSignupOrganizationContext,
  authKitClient: AuthKitClient,
): Promise<AuthKitSession> {
  if (session.organizationId === signupOrganization.workosOrganizationId) {
    return session;
  }
  const refreshed = await authKitClient.refreshSession({
    sealedSession: session.sealedSession,
    organizationId: signupOrganization.workosOrganizationId,
  });
  if (!refreshed || refreshed.organizationId !== signupOrganization.workosOrganizationId) {
    throw new Error("AuthKit signup organization session could not be selected");
  }
  return refreshed;
}

async function loginPageSignupIntent(
  session: AuthKitSession,
  stateContext: AuthStateContext,
  options: AuthSessionRouteOptions,
): Promise<AuthSignupIntent | undefined> {
  if (stateContext.authFlow || session.organizationId) return undefined;
  const intents = signupIntentsForSurface(stateContext.surface);
  if (intents.length !== 1) return undefined;
  const user = await options.identityRepository.findUserByProviderUserId("workos", session.user.id);
  return user ? undefined : intents[0];
}

function signupContextFromState(
  stateContext: AuthStateContext,
  organization?: AuthSignupOrganizationContext,
  membership?: AuthSignupMembershipContext,
): AuthSignupContext | undefined {
  if (stateContext.authFlow !== "signup" || !stateContext.signupIntent || !organization) {
    return undefined;
  }
  return {
    intent: stateContext.signupIntent,
    organization,
    membership,
  };
}

function registerCompatibilityTokenRoute(
  app: FastifyInstance,
  options: AuthSessionRouteOptions,
  route: { path: string; surface: AuthSurface; userType?: string },
): void {
  app.post(route.path, async (request, reply) => {
    if (!writeCorsHeaders(request, reply, options)) {
      return reply.code(403).send({ error: "origin_rejected" });
    }
    const surfacePolicy = getSurfacePolicy(route.surface, options);
    if (!surfacePolicy.legacyJwtSecret) {
      return reply.code(404).send({ error: "legacy_compatibility_bridge_not_configured" });
    }
    if (!passesCsrfCheck(request, options)) {
      return reply.code(403).send({ error: "csrf_rejected" });
    }
    const sealedSession = readCookie(request, SESSION_COOKIE);
    if (!sealedSession) {
      return reply.code(401).send({ error: "missing_session" });
    }
    const session = await options.authKitClient.authenticateSession({ sealedSession });
    if (!session) {
      return reply.code(401).send({ error: "invalid_session" });
    }
    let resolution: IdentityResolution;
    try {
      resolution = await resolveExistingIdentity(
        session,
        options,
        surfacePolicy,
        organizationAccessOptionsFromRequest(request, surfacePolicy, {
          requireResourceLink: true,
        }),
      );
    } catch (error) {
      if (error instanceof OrganizationSelectionRequiredError) {
        return sendOrganizationSelectionResponse(reply, error, readCookie(request, CSRF_COOKIE));
      }
      return reply.code(403).send(toAuthError(error));
    }
    const expiresIn = 15 * 60;
    const resourceScope = resolution.resourceScope
      ? { [resourceScopeKey(resolution.resourceScope)]: resolution.resourceScope.resourceIds }
      : undefined;
    await options.productAuditSink.record({
      action: "auth.compatibility_token.issued",
      actorUserId: resolution.user.userId,
      organizationId: resolution.organizationId,
      surface: route.surface,
      resourceScope,
      workosUserId: resolution.session.user.id,
      workosOrgId: resolution.session.organizationId,
      workosSessionId: resolution.session.sessionId,
      requestId: request.id,
      occurredAt: new Date().toISOString(),
    });
    return reply.send({
      accessToken: signLegacyMarketplaceJwt(
        {
          sub: resolution.user.userId,
          email: resolution.user.email,
          type:
            surfacePolicy.legacyJwtUserType ??
            route.userType ??
            legacyUserTypeForOrganizationKind(resolution.organizationKind),
          org: resolution.organizationId,
          surface: route.surface,
          resources: resourceScope,
        },
        surfacePolicy.legacyJwtSecret,
        expiresIn,
      ),
      expiresIn,
      tokenType: "Bearer",
    });
  });
}

function legacyUserTypeForOrganizationKind(kind: OrganizationKind | undefined): string {
  if (kind === "creator_workspace") return "creator";
  if (kind === "hotel_group") return "hotel";
  if (kind === "affiliate_partner") return "affiliate";
  return "admin";
}

async function resolveOrCreateIdentity(
  session: AuthKitSession,
  request: FastifyRequest,
  options: AuthSessionRouteOptions,
  surfacePolicy: AuthSurfacePolicy,
  accessOptions: OrganizationAccessOptions = {},
  signupContext?: AuthSignupContext,
): Promise<IdentityResolution> {
  let user = await options.identityRepository.findUserByProviderUserId("workos", session.user.id);
  if (!user) {
    const result = await options.lifecycleCommandBus.execute({
      commandType: "identity.user.create",
      commandId: randomUUID(),
      idempotencyKey: `workos-jit:${session.user.id}`,
      audit: {
        actor: { kind: "system", service: "apps/api-authkit" },
        source: "web",
        requestId: request.id,
        correlationId: session.sessionId,
        reason: "AuthKit SSO/JIT first arrival",
        requestedAt: new Date().toISOString(),
      },
      payload: {
        email: session.user.email,
        name: session.user.name ?? undefined,
        initialStatus: "active",
        ...(signupContext
          ? {
              legacyUserType: signupContext.intent,
              organization: {
                kind: signupContext.organization.kind,
                name: signupContext.organization.name,
                workosOrgId: signupContext.organization.workosOrganizationId,
                workosExternalId: signupContext.organization.workosExternalId,
              },
              membership: {
                status: signupContext.membership?.status,
                roleKey: signupContext.organization.roleKey,
                permissionKeys: hostedSignupPermissionKeys(signupContext),
                workosMembershipId: signupContext.membership?.workosMembershipId,
                workosRoleSlugs: signupContext.membership?.workosRoleSlugs ?? [
                  signupContext.organization.roleKey,
                ],
              },
            }
          : {}),
        providerIdentity: {
          provider: "workos",
          providerUserId: session.user.id,
          providerEmailVerified: session.user.emailVerified,
        },
      },
    });
    user = await findUserAfterLifecycle(options.identityRepository, session, result);
    await options.authKitClient.updateUserExternalId({
      workosUserId: session.user.id,
      externalId: user.userId,
    });
  } else if (signupContext) {
    await options.lifecycleCommandBus.execute({
      commandType: "identity.access.grant",
      commandId: randomUUID(),
      idempotencyKey: `workos-signup-access:${session.user.id}:${signupContext.organization.workosOrganizationId}`,
      audit: {
        actor: { kind: "system", service: "apps/api-authkit" },
        source: "web",
        requestId: request.id,
        correlationId: session.sessionId,
        reason: "AuthKit hosted signup organization access",
        requestedAt: new Date().toISOString(),
      },
      payload: {
        userId: user.userId,
        organization: {
          kind: signupContext.organization.kind,
          name: signupContext.organization.name,
          workosOrgId: signupContext.organization.workosOrganizationId,
          workosExternalId: signupContext.organization.workosExternalId,
        },
        membership: {
          status: signupContext.membership?.status,
          roleKey: signupContext.organization.roleKey,
          permissionKeys: hostedSignupPermissionKeys(signupContext),
          workosMembershipId: signupContext.membership?.workosMembershipId,
          workosRoleSlugs: signupContext.membership?.workosRoleSlugs ?? [
            signupContext.organization.roleKey,
          ],
        },
      },
    });
  }
  const access = await resolveOrganizationAccess(
    session,
    user,
    options,
    surfacePolicy,
    accessOptions,
  );
  return { user, ...access };
}

function hostedSignupPermissionKeys(signupContext: AuthSignupContext): PermissionKey[] | undefined {
  if (signupContext.organization.kind !== "hotel_group") return undefined;
  return ["hotel_catalog.setup.read", "hotel_catalog.setup.manage"];
}

async function resolveExistingIdentity(
  session: AuthKitSession,
  options: AuthSessionRouteOptions,
  surfacePolicy: AuthSurfacePolicy,
  accessOptions: OrganizationAccessOptions = {},
): Promise<IdentityResolution> {
  const verified = await options.tokenVerifier(session.accessToken);
  const user = await options.identityRepository.findUserByProviderUserId(
    "workos",
    verified.workosUserId,
  );
  if (!user) {
    throw new Error(`No internal user for WorkOS user ${verified.workosUserId}`);
  }
  const access = await resolveOrganizationAccess(
    { ...session, organizationId: verified.workosOrgId ?? session.organizationId },
    user,
    options,
    surfacePolicy,
    accessOptions,
  );
  return { user, ...access };
}

type IdentityResolution = {
  session: AuthKitSession;
  user: IdentityUser;
  organizationId?: string;
  organizationKind?: OrganizationKind;
  resourceScope?: {
    product: Product;
    resourceType: ResourceType;
    resourceIds: string[];
  };
};

async function findUserAfterLifecycle(
  repository: IdentityRepository,
  session: AuthKitSession,
  result: IdentityLifecycleCommandResult,
): Promise<IdentityUser> {
  const user = await repository.findUserByProviderUserId("workos", session.user.id);
  if (user) return user;
  if (result.userId) {
    return {
      userId: result.userId,
      email: session.user.email,
      status: "active",
    };
  }
  throw new Error("Identity lifecycle command did not create a resolvable user");
}

async function resolveOrganizationAccess(
  session: AuthKitSession,
  user: IdentityUser,
  options: AuthSessionRouteOptions,
  surfacePolicy: AuthSurfacePolicy,
  accessOptions: OrganizationAccessOptions = {},
): Promise<Omit<IdentityResolution, "user">> {
  if (!session.organizationId) {
    if (!accessOptions.skipSelection) {
      return resolveSelectableOrganization(session, user, options, surfacePolicy, accessOptions);
    }
    throw new Error("AuthKit session is missing selected organization");
  }
  const organization = await options.identityRepository.findOrganizationByWorkosOrgId(
    session.organizationId,
  );
  if (!organization || !organization.workosOrgId) {
    throw new Error(`No WorkOS-managed organization for ${session.organizationId}`);
  }
  if (organization.status !== "active") {
    throw new Error(`Organization ${organization.organizationId} is not active`);
  }
  if (!matchesOrganizationKind(organization.kind, surfacePolicy.requiredOrganizationKind)) {
    if (!accessOptions.skipSelection) {
      try {
        return await resolveSelectableOrganization(
          session,
          user,
          options,
          surfacePolicy,
          accessOptions,
        );
      } catch (error) {
        if (error instanceof OrganizationSelectionRequiredError) throw error;
      }
    }
    throw new Error(
      `Selected organization must be ${requiredOrganizationKindLabel(
        surfacePolicy.requiredOrganizationKind,
      )}`,
    );
  }
  const membership = await options.identityRepository.findActiveMembership(
    user.userId,
    organization.organizationId,
  );
  if (!membership || membership.status !== "active") {
    throw new Error("No active membership for selected organization");
  }
  if (
    surfacePolicy.requiredMembershipRoleKey &&
    membership.roleKey !== surfacePolicy.requiredMembershipRoleKey
  ) {
    throw new Error(
      `Selected organization membership must be ${surfacePolicy.requiredMembershipRoleKey}`,
    );
  }
  if (shouldRequireOrganizationSelection(session, surfacePolicy, accessOptions)) {
    const candidates = await findSurfaceOrganizationCandidates(
      user.userId,
      options.identityRepository,
      surfacePolicy,
    );
    if (candidates.length > 1) {
      throw new OrganizationSelectionRequiredError(session, user, candidates);
    }
  }
  if (surfacePolicy.requiredResourceLink) {
    const links = await options.identityRepository.findLinkedResources(organization.organizationId);
    const matchingLinks = findRequiredResourceLinks(links, surfacePolicy.requiredResourceLink);
    if (matchingLinks.length === 0 && accessOptions.requireResourceLink) {
      throw new Error(
        `Selected organization is missing an active ${surfacePolicy.requiredResourceLink.product}/${surfacePolicy.requiredResourceLink.resourceType} resource link`,
      );
    }
    if (matchingLinks.length === 0) {
      return {
        session,
        organizationId: organization.organizationId,
        organizationKind: organization.kind,
      };
    }
    return {
      session,
      organizationId: organization.organizationId,
      organizationKind: organization.kind,
      resourceScope: {
        ...surfacePolicy.requiredResourceLink,
        resourceIds: matchingLinks.map((link) => link.resourceId),
      },
    };
  }
  return {
    session,
    organizationId: organization.organizationId,
    organizationKind: organization.kind,
  };
}

class OrganizationSelectionRequiredError extends Error {
  constructor(
    readonly session: AuthKitSession,
    readonly user: IdentityUser,
    readonly candidates: AuthOrganizationCandidate[],
  ) {
    super("Organization selection is required");
  }
}

async function resolveSelectableOrganization(
  session: AuthKitSession,
  user: IdentityUser,
  options: AuthSessionRouteOptions,
  surfacePolicy: AuthSurfacePolicy,
  accessOptions: OrganizationAccessOptions,
): Promise<Omit<IdentityResolution, "user">> {
  const candidates = await findSurfaceOrganizationCandidates(
    user.userId,
    options.identityRepository,
    surfacePolicy,
  );

  if (candidates.length === 1) {
    const candidate = candidates[0]!;
    const refreshed = await options.authKitClient.refreshSession({
      sealedSession: session.sealedSession,
      organizationId: candidate.workosOrganizationId,
    });
    if (refreshed?.organizationId !== candidate.workosOrganizationId) {
      const membership = await options.authKitClient.ensureSignupOrganizationMembership({
        workosUserId: session.user.id,
        workosOrganizationId: candidate.workosOrganizationId,
        roleKey: candidate.roleKey,
      });
      if (membership.status && membership.status !== "active") {
        throw new Error("WorkOS organization membership is not active for selected organization");
      }
      const retried = await options.authKitClient.refreshSession({
        sealedSession: session.sealedSession,
        organizationId: candidate.workosOrganizationId,
      });
      if (retried?.organizationId !== candidate.workosOrganizationId) {
        throw new Error("Unable to refresh AuthKit session for selected organization");
      }
      return resolveOrganizationAccess(retried, user, options, surfacePolicy, {
        ...accessOptions,
        skipSelection: true,
      });
    }
    return resolveOrganizationAccess(refreshed, user, options, surfacePolicy, {
      ...accessOptions,
      skipSelection: true,
    });
  }

  if (candidates.length > 1) {
    throw new OrganizationSelectionRequiredError(session, user, candidates);
  }

  throw new Error(
    `No active ${requiredOrganizationKindLabel(
      surfacePolicy.requiredOrganizationKind,
    )} organization is available for this surface`,
  );
}

function shouldRequireOrganizationSelection(
  session: AuthKitSession,
  surfacePolicy: AuthSurfacePolicy,
  accessOptions: OrganizationAccessOptions,
): boolean {
  return (
    surfacePolicy.requireExplicitOrganizationSelection === true &&
    accessOptions.skipSelection !== true &&
    accessOptions.explicitOrganizationSelection !== true &&
    Boolean(session.organizationId) &&
    accessOptions.selectedWorkosOrganizationId !== session.organizationId
  );
}

async function findSurfaceOrganizationCandidates(
  userId: string,
  repository: IdentityRepository,
  surfacePolicy: AuthSurfacePolicy,
): Promise<AuthOrganizationCandidate[]> {
  if (!repository.listMembershipOrganizations) {
    throw new Error("Identity repository does not support organization selection");
  }
  const memberships = await repository.listMembershipOrganizations(userId);
  return memberships
    .filter((membership) => isSurfaceOrganizationCandidate(membership, surfacePolicy))
    .map((membership) => ({
      organizationId: membership.organizationId,
      workosOrganizationId: membership.workosOrgId!,
      displayName: membership.name,
      kind: membership.kind,
      roleKey: membership.membership.roleKey,
    }));
}

function isSurfaceOrganizationCandidate(
  membership: IdentityMembershipOrganization,
  surfacePolicy: AuthSurfacePolicy,
): boolean {
  return (
    membership.status === "active" &&
    membership.membership.status === "active" &&
    Boolean(membership.workosOrgId) &&
    matchesOrganizationKind(membership.kind, surfacePolicy.requiredOrganizationKind) &&
    (!surfacePolicy.requiredMembershipRoleKey ||
      membership.membership.roleKey === surfacePolicy.requiredMembershipRoleKey)
  );
}

function sendOrganizationSelectionRedirect(
  reply: FastifyReply,
  session: AuthKitSession,
  error: OrganizationSelectionRequiredError,
  callbackReturnUrl: string | undefined,
  surfacePolicy: AuthSurfacePolicy,
  options: AuthSessionRouteOptions,
) {
  const csrfToken = randomBytes(24).toString("base64url");
  reply.headers({
    "set-cookie": [
      serializeCookie(STATE_COOKIE, "", {
        maxAge: 0,
        secure: options.cookieSecure,
        domain: options.cookieDomain,
      }),
      serializeCookie(SESSION_COOKIE, session.sealedSession, {
        maxAge: 60 * 60 * 24 * 7,
        secure: options.cookieSecure,
        domain: options.cookieDomain,
      }),
      serializeCookie(CSRF_COOKIE, csrfToken, {
        maxAge: 60 * 60 * 24 * 7,
        secure: options.cookieSecure,
        domain: options.cookieDomain,
        httpOnly: false,
      }),
      ...clearSelectedOrganizationCookieHeaders(surfacePolicy, options),
    ],
  });
  if (callbackReturnUrl) {
    return reply.redirect(callbackReturnUrl);
  }
  return sendOrganizationSelectionResponse(reply, error, csrfToken);
}

function sendOrganizationSelectionResponse(
  reply: FastifyReply,
  error: OrganizationSelectionRequiredError,
  csrfToken?: string,
) {
  return reply.send({
    organizationSelectionRequired: true,
    csrfToken,
    organizations: error.candidates.map((candidate) => ({
      organizationId: candidate.organizationId,
      workosOrganizationId: candidate.workosOrganizationId,
      displayName: candidate.displayName,
      kind: candidate.kind,
    })),
    user: {
      id: error.user.userId,
      email: error.user.email,
      status: error.user.status,
      workosUserId: error.session.user.id,
    },
  });
}

function isConflictError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const candidate = error as { status?: unknown; name?: unknown };
  return candidate.status === 409 || candidate.name === "ConflictException";
}

function organizationAccessOptionsFromRequest(
  request: FastifyRequest,
  surfacePolicy: AuthSurfacePolicy,
  overrides: OrganizationAccessOptions = {},
): OrganizationAccessOptions {
  const selectedOrganizationCookieName = surfacePolicy.selectedOrganizationCookieName;
  return {
    selectedWorkosOrganizationId: selectedOrganizationCookieName
      ? (readCookie(request, selectedOrganizationCookieName) ?? null)
      : null,
    ...overrides,
  };
}

function selectedOrganizationCookieNames(surfacePolicy: AuthSurfacePolicy): string[] {
  return surfacePolicy.selectedOrganizationCookieName
    ? [surfacePolicy.selectedOrganizationCookieName]
    : [];
}

function selectedOrganizationCookieHeaders(
  session: AuthKitSession,
  surfacePolicy: AuthSurfacePolicy,
  options: AuthSessionRouteOptions,
): string[] {
  const cookieName = surfacePolicy.selectedOrganizationCookieName;
  if (!cookieName || !session.organizationId) return [];
  return [
    serializeCookie(cookieName, session.organizationId, {
      maxAge: 60 * 60 * 24 * 7,
      secure: options.cookieSecure,
      domain: options.cookieDomain,
    }),
  ];
}

function clearSelectedOrganizationCookieHeaders(
  surfacePolicy: AuthSurfacePolicy,
  options: AuthSessionRouteOptions,
): string[] {
  return selectedOrganizationCookieNames(surfacePolicy).map((name) =>
    serializeCookie(name, "", {
      maxAge: 0,
      secure: options.cookieSecure,
      domain: options.cookieDomain,
    }),
  );
}

function findRequiredResourceLinks(
  links: IdentityResourceLink[],
  required: RequiredResourceLink,
): IdentityResourceLink[] {
  return links.filter(
    (link) =>
      link.status === "active" &&
      link.product === required.product &&
      link.resourceType === required.resourceType,
  );
}

function resourceScopeKey(scope: { product: Product; resourceType: ResourceType }): string {
  return `${scope.product}:${scope.resourceType}`;
}

function matchesOrganizationKind(
  actual: OrganizationKind,
  required: OrganizationKind | OrganizationKind[],
): boolean {
  return Array.isArray(required) ? required.includes(actual) : actual === required;
}

function requiredOrganizationKindLabel(required: OrganizationKind | OrganizationKind[]): string {
  return Array.isArray(required) ? required.join(" or ") : required;
}

function toSessionResponse(
  session: AuthKitSession,
  user: IdentityUser,
  csrfToken?: string,
  organizationId?: string,
  organizationKind?: OrganizationKind,
  resourceScope?: IdentityResolution["resourceScope"],
) {
  const resources = resourceScope
    ? { [resourceScopeKey(resourceScope)]: resourceScope.resourceIds }
    : undefined;
  return {
    accessToken: session.accessToken,
    csrfToken,
    organizationId,
    workosOrganizationId: session.organizationId,
    organizationKind,
    resources,
    user: {
      id: user.userId,
      email: user.email,
      status: user.status,
      workosUserId: session.user.id,
    },
  };
}

function writeCorsHeaders(
  request: FastifyRequest,
  reply: FastifyReply,
  options: AuthSessionRouteOptions,
): boolean {
  const origin = request.headers.origin;
  if (!origin) return true;
  if (!options.allowedOrigins.includes(origin)) return false;
  reply
    .header("Access-Control-Allow-Origin", origin)
    .header("Access-Control-Allow-Credentials", "true")
    .header("Access-Control-Allow-Headers", "content-type,x-vayada-csrf")
    .header("Access-Control-Allow-Methods", "GET,POST,OPTIONS")
    .header("Vary", "Origin");
  return true;
}

function signLegacyMarketplaceJwt(
  claims: {
    sub: string;
    email: string;
    type: string;
    org?: string;
    surface?: AuthSurface;
    resources?: Record<string, string[]>;
  },
  secret: string,
  expiresInSeconds: number,
): string {
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: "HS256", typ: "JWT" };
  const payload = {
    ...claims,
    iat: now,
    exp: now + expiresInSeconds,
  };
  const encodedHeader = base64Url(JSON.stringify(header));
  const encodedPayload = base64Url(JSON.stringify(payload));
  const signingInput = `${encodedHeader}.${encodedPayload}`;
  const signature = createHmac("sha256", secret).update(signingInput).digest("base64url");
  return `${signingInput}.${signature}`;
}

function base64Url(value: string): string {
  return Buffer.from(value).toString("base64url");
}

function readCookie(request: FastifyRequest, name: string): string | undefined {
  return readCookies(request, name)[0];
}

function readCookies(request: FastifyRequest, name: string): string[] {
  const header = request.headers.cookie;
  if (!header) return [];
  const cookies = header.split(";").map((part) => part.trim());
  const values: string[] = [];
  for (const cookie of cookies) {
    const [cookieName, ...rawValue] = cookie.split("=");
    if (cookieName === name) {
      values.push(decodeURIComponent(rawValue.join("=")));
    }
  }
  return values;
}

function serializeCookie(
  name: string,
  value: string,
  options: { maxAge: number; secure: boolean; domain?: string; httpOnly?: boolean },
): string {
  const parts = [
    `${name}=${encodeURIComponent(value)}`,
    "Path=/auth",
    `Max-Age=${options.maxAge}`,
    `SameSite=${options.secure ? "None" : "Lax"}`,
  ];
  if (options.httpOnly !== false) parts.push("HttpOnly");
  if (options.secure) parts.push("Secure");
  if (options.domain) parts.push(`Domain=${options.domain}`);
  return parts.join("; ");
}

function clearHostOnlyCookies(
  names: string[],
  options: { secure: boolean; domain?: string },
): string[] {
  if (!options.domain) return [];
  return names.map((name) =>
    serializeCookie(name, "", {
      maxAge: 0,
      secure: options.secure,
    }),
  );
}

function toAuthError(error: unknown) {
  return {
    error: "auth_session_rejected",
    message: error instanceof Error ? error.message : "AuthKit session was rejected.",
  };
}

function passesCsrfCheck(request: FastifyRequest, options: AuthSessionRouteOptions): boolean {
  const origin = request.headers.origin;
  if (origin && !options.allowedOrigins.includes(origin)) {
    return false;
  }
  const csrfCookie = readCookie(request, CSRF_COOKIE);
  const csrfHeader = request.headers["x-vayada-csrf"];
  return typeof csrfHeader === "string" && csrfHeader.length > 0 && csrfHeader === csrfCookie;
}
