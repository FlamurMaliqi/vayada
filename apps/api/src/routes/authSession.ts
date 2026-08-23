import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
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
import { membershipPropertyAccessModeForProvisioning } from "@vayada/backend-auth";
import type { FastifyInstance, FastifyPluginAsync, FastifyReply, FastifyRequest } from "fastify";

import { mapWorkOSAuthError } from "../platform/workosAuthState.js";
import type {
  AuthHandoffRoutingHints,
  AuthSessionHandoff,
  AuthSessionHandoffRepository,
} from "../platform/authSessionHandoffs.js";
import {
  resolveApprovedPublicProfileImage,
  type ApprovedPublicProfileImageRepository,
} from "./platformMedia.js";
import type {
  HotelAccountInviteOnboardingResolution,
  HotelAccountInviteRepository,
} from "./hotelAccountInvites.js";

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
    provider: "GoogleOAuth";
    redirectUri: string;
    state: string;
    loginHint?: string;
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
  authenticateWithEmailVerification(input: {
    pendingAuthenticationToken: string;
    code: string;
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
  resendVerificationEmail(input: { emailVerificationId: string }): Promise<{ email: string }>;
  createPasswordReset(input: { email: string }): Promise<void>;
  resetPassword(input: { token: string; newPassword: string }): Promise<AuthKitUser>;
  authenticateSession(input: { sealedSession: string }): Promise<AuthKitSession | null>;
  isSessionActive(input: { sessionId: string; workosUserId: string }): Promise<boolean>;
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
  updateUserName(input: {
    workosUserId: string;
    firstName: string;
    lastName: string;
  }): Promise<void>;
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
  publicOrigin?: string;
  firstPartySession?: boolean;
  allowMissingOrganization?: boolean;
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
  logoutReturnUrl: string;
  allowedOrigins: string[];
  compatibilityCallbackOrigin: string;
  requiredOrganizationKind: OrganizationKind;
  surfacePolicies?: Partial<Record<AuthSurface, AuthSurfacePolicy>>;
  oauthStateSecret: string;
  cookieSecure: boolean;
  cookieDomain?: string;
  legacyMarketplaceJwtSecret?: string;
  profileImageMediaRepository?: ApprovedPublicProfileImageRepository;
  hotelAccountInviteOnboarding?: Pick<HotelAccountInviteRepository, "resolveForOnboarding">;
  handoffRepository?: AuthSessionHandoffRepository;
};

const SESSION_COOKIE = "vayada_workos_session";
const CSRF_COOKIE = "vayada_auth_csrf";
const OAUTH_STATE_COOKIE = "vayada_oauth_state";
const OAUTH_STATE_MAX_AGE_SECONDS = 10 * 60;
const DEFAULT_SURFACE: AuthSurface = "platform-admin";
const EMAIL_SEND_COOLDOWN_MS = 60_000;
const EMAIL_SEND_COOLDOWN_MESSAGE = "Please wait before requesting another email.";
const AUTH_HANDOFF_TTL_MS = 60_000;

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
  allowMissingOrganization?: boolean;
  explicitOrganizationSelection?: boolean;
  selectedWorkosOrganizationId?: string | null;
};

export const registerAuthSessionRoutes: FastifyPluginAsync<AuthSessionRouteOptions> = async (
  app: FastifyInstance,
  options: AuthSessionRouteOptions,
) => {
  const emailSendCooldowns = new Map<string, number>();

  for (const path of [
    "/email-verification/confirm",
    "/email-verification/resend",
    "/handoff/create",
    "/handoff/redeem",
    "/onboarding",
    "/password/login",
    "/password/reset/confirm",
    "/password/reset/request",
    "/password/signup",
    "/session",
    "/session/refresh",
    "/logout",
    "/compat/marketplace-admin-token",
    "/compat/booking-admin-token",
    "/compat/pms-web-token",
    "/compat/affiliate-dashboard-token",
    "/profile",
  ]) {
    app.options(path, async (request, reply) => {
      if (!writeCorsHeaders(request, reply, options)) {
        return reply.code(403).send();
      }
      return reply.code(204).send();
    });
  }

  app.get("/oauth/google/start", async (request, reply) => {
    const parsed = parseGoogleOAuthStartQuery(request, options);
    if (!parsed.ok) {
      return reply.code(400).send(parsed.error);
    }
    const surfacePolicy = getSurfacePolicy(parsed.surface, options);
    const callbackUri = googleOAuthCallbackUrl(request, surfacePolicy, options);
    if (!callbackUri) {
      return reply.code(400).send({
        error: "invalid_callback_origin",
        message: "OAuth callback origin is not trusted for this auth surface.",
      });
    }

    const state = createOAuthState(options, {
      provider: "google",
      flow: parsed.flow,
      surface: parsed.surface,
      intent: parsed.intent,
      returnTo: parsed.returnTo,
      errorReturnTo: parsed.errorReturnTo,
    });
    const authorizationUrl = options.authKitClient.getAuthorizationUrl({
      provider: "GoogleOAuth",
      redirectUri: callbackUri,
      state: state.value,
      loginHint: parsed.loginHint,
    });

    reply.header(
      "set-cookie",
      authCookieHeaders(
        OAUTH_STATE_COOKIE,
        state.nonce,
        OAUTH_STATE_MAX_AGE_SECONDS,
        surfacePolicy,
        options,
      ),
    );
    return reply.redirect(authorizationUrl);
  });

  app.get("/oauth/google/callback", async (request, reply) => {
    const query = request.query as { code?: unknown; state?: unknown; error?: unknown };
    const stateValue = typeof query.state === "string" ? query.state : "";
    const state = readOAuthState(stateValue, options);
    if (!state.ok) {
      return reply.code(400).send({ error: "invalid_oauth_state" });
    }
    const surfacePolicy = getSurfacePolicy(state.value.surface, options);
    if (!googleOAuthCallbackUrl(request, surfacePolicy, options)) {
      return reply.code(400).send({ error: "invalid_callback_origin" });
    }
    if (readCookie(request, OAUTH_STATE_COOKIE, surfacePolicy) !== state.value.nonce) {
      return redirectWithOAuthError(
        reply,
        state.value,
        "Google sign-in expired. Please try again.",
      );
    }
    reply.header(
      "set-cookie",
      authCookieHeaders(OAUTH_STATE_COOKIE, "", 0, surfacePolicy, options),
    );
    if (typeof query.error === "string") {
      return redirectWithOAuthError(reply, state.value, "Google sign-in was cancelled.");
    }
    if (typeof query.code !== "string" || !query.code) {
      return redirectWithOAuthError(reply, state.value, "Google sign-in failed. Please try again.");
    }

    let session: AuthKitSession;
    try {
      session = await options.authKitClient.authenticateWithCode({
        code: query.code,
        ipAddress: request.ip,
        userAgent: request.headers["user-agent"],
      });
    } catch {
      return redirectWithOAuthError(reply, state.value, "Google sign-in failed. Please try again.");
    }

    let selectedSession = session;
    let signupContext: AuthSignupContext | undefined;
    if (state.value.flow === "signup") {
      const existingUser = await options.identityRepository.findUserByProviderUserId(
        "workos",
        session.user.id,
      );
      if (existingUser) {
        return redirectWithOAuthError(
          reply,
          state.value,
          "This email already has a Vayada account. Sign in instead.",
        );
      }
      if (state.value.intent) {
        try {
          const signupOrganization = await createSignupOrganizationContext(
            options.authKitClient,
            state.value.surface,
            state.value.intent,
            session.user.email,
            session.user.id,
          );
          const membership = await options.authKitClient.ensureSignupOrganizationMembership({
            workosUserId: session.user.id,
            workosOrganizationId: signupOrganization.workosOrganizationId,
            roleKey: signupOrganization.roleKey,
          });
          signupContext = {
            intent: state.value.intent,
            organization: signupOrganization,
            membership: {
              workosMembershipId: membership.membershipId,
              workosRoleSlugs: membership.roleSlugs,
              status: membership.status,
            },
          };
          selectedSession = await selectSignupOrganizationSession(
            session,
            signupOrganization,
            options.authKitClient,
          );
        } catch (error) {
          return redirectWithOAuthError(
            reply,
            state.value,
            error instanceof Error ? error.message : "Google sign-up failed. Please try again.",
          );
        }
      }
    } else {
      const existingUser = await options.identityRepository.findUserByProviderUserId(
        "workos",
        session.user.id,
      );
      if (!existingUser) {
        return redirectWithOAuthError(
          reply,
          state.value,
          "No Vayada account exists for this Google login. Create an account first.",
        );
      }
    }

    let resolution: IdentityResolution;
    try {
      resolution = await resolveOrCreateIdentity(
        selectedSession,
        request,
        options,
        surfacePolicy,
        organizationAccessOptionsFromRequest(request, surfacePolicy),
        signupContext,
      );
    } catch (error) {
      if (error instanceof OrganizationSelectionRequiredError) {
        const csrfToken = randomBytes(24).toString("base64url");
        reply.headers({
          "set-cookie": [
            ...authSessionCookieHeaders(error.session, csrfToken, surfacePolicy, options),
            ...clearSelectedOrganizationCookieHeaders(surfacePolicy, options),
          ],
        });
        return reply.redirect(state.value.returnTo);
      }
      return redirectWithOAuthError(
        reply,
        state.value,
        error instanceof Error ? error.message : "Google sign-in failed. Please try again.",
      );
    }

    await options.productAuditSink.record({
      action: "auth.login",
      authFlow: state.value.flow,
      actorUserId: resolution.user.userId,
      organizationId: resolution.organizationId,
      surface: state.value.surface,
      signupIntent: signupContext?.intent,
      workosUserId: selectedSession.user.id,
      workosOrgId: resolution.session.organizationId,
      workosSessionId: resolution.session.sessionId,
      requestId: request.id,
      occurredAt: new Date().toISOString(),
    });

    const csrfToken = randomBytes(24).toString("base64url");
    reply.headers({
      "set-cookie": authSessionCookieHeaders(resolution.session, csrfToken, surfacePolicy, options),
    });
    return reply.redirect(state.value.returnTo);
  });

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
        return sendOrganizationSelectionSessionResponse(
          reply,
          session,
          error,
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
      "set-cookie": authSessionCookieHeaders(resolution.session, csrfToken, surfacePolicy, options),
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
          ...(parsed.intent ? { signup_intent: parsed.intent } : {}),
        },
      });
      createdUser = true;
    } catch (error) {
      if (isConflictError(error)) {
        return reply.code(409).send({
          state: "auth_failed",
          message: "This email already has a Vayada account. Sign in instead.",
        });
      }
      return reply.code(400).send({
        state: "auth_failed",
        message: "Signup failed. Please check your details and try again.",
      });
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

    let signupOrganization: AuthSignupOrganizationContext | undefined;
    let signupMembership: AuthSignupMembershipContext | undefined;
    let selectedSession = session;
    if (parsed.intent) {
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
    }

    let resolution: IdentityResolution;
    try {
      resolution = await resolveOrCreateIdentity(
        selectedSession,
        request,
        options,
        surfacePolicy,
        organizationAccessOptionsFromRequest(request, surfacePolicy),
        parsed.intent && signupOrganization
          ? {
              intent: parsed.intent,
              organization: signupOrganization,
              membership: signupMembership,
            }
          : undefined,
      );
    } catch (error) {
      if (error instanceof OrganizationSelectionRequiredError) {
        return sendOrganizationSelectionSessionResponse(
          reply,
          selectedSession,
          error,
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
      "set-cookie": authSessionCookieHeaders(resolution.session, csrfToken, surfacePolicy, options),
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

  app.post("/email-verification/confirm", async (request, reply) => {
    if (!writeCorsHeaders(request, reply, options)) {
      return reply.code(403).send({
        state: "auth_failed",
        message: "Authentication request origin is not allowed.",
      });
    }
    const parsed = parseEmailVerificationConfirmBody(request.body);
    if (!parsed.ok) {
      return reply.code(400).send(parsed.error);
    }

    const surfacePolicy = getSurfacePolicy(parsed.surface, options);
    let verifiedSession: AuthKitSession;
    try {
      verifiedSession = await options.authKitClient.authenticateWithEmailVerification({
        pendingAuthenticationToken: parsed.pendingAuthenticationToken,
        code: parsed.code,
        ipAddress: request.ip,
        userAgent: request.headers["user-agent"],
      });
    } catch (error) {
      return reply.code(400).send(toEmailVerificationError(error));
    }

    let signupContext: AuthSignupContext | undefined;
    let selectedSession = verifiedSession;
    if (parsed.flow === "signup" && parsed.intent) {
      try {
        const signupOrganization = await createSignupOrganizationContext(
          options.authKitClient,
          parsed.surface,
          parsed.intent,
          verifiedSession.user.email,
          verifiedSession.user.id,
        );
        const membership = await options.authKitClient.ensureSignupOrganizationMembership({
          workosUserId: verifiedSession.user.id,
          workosOrganizationId: signupOrganization.workosOrganizationId,
          roleKey: signupOrganization.roleKey,
        });
        signupContext = {
          intent: parsed.intent,
          organization: signupOrganization,
          membership: {
            workosMembershipId: membership.membershipId,
            workosRoleSlugs: membership.roleSlugs,
            status: membership.status,
          },
        };
        selectedSession = await selectSignupOrganizationSession(
          verifiedSession,
          signupOrganization,
          options.authKitClient,
        );
      } catch (error) {
        return reply.code(403).send(toAuthError(error));
      }
    }

    let resolution: IdentityResolution;
    try {
      resolution = await resolveOrCreateIdentity(
        selectedSession,
        request,
        options,
        surfacePolicy,
        organizationAccessOptionsFromRequest(request, surfacePolicy),
        signupContext,
      );
    } catch (error) {
      if (error instanceof OrganizationSelectionRequiredError) {
        return sendOrganizationSelectionSessionResponse(
          reply,
          selectedSession,
          error,
          surfacePolicy,
          options,
        );
      }
      return reply.code(403).send(toAuthError(error));
    }

    await options.productAuditSink.record({
      action: "auth.login",
      authFlow: parsed.flow,
      actorUserId: resolution.user.userId,
      organizationId: resolution.organizationId,
      surface: parsed.surface,
      signupIntent: signupContext?.intent,
      workosUserId: verifiedSession.user.id,
      workosOrgId: resolution.session.organizationId,
      workosSessionId: resolution.session.sessionId,
      requestId: request.id,
      occurredAt: new Date().toISOString(),
    });

    const csrfToken = randomBytes(24).toString("base64url");
    reply.headers({
      "set-cookie": authSessionCookieHeaders(resolution.session, csrfToken, surfacePolicy, options),
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

  app.post("/email-verification/resend", async (request, reply) => {
    if (!writeCorsHeaders(request, reply, options)) {
      return reply.code(403).send({
        state: "auth_failed",
        message: "Authentication request origin is not allowed.",
      });
    }
    const parsed = parseEmailVerificationResendBody(request.body);
    if (!parsed.ok) {
      return reply.code(400).send(parsed.error);
    }
    const cooldown = consumeEmailSendCooldown(
      emailSendCooldowns,
      `email-verification:${parsed.emailVerificationId}`,
    );
    if (!cooldown.ok) {
      return sendEmailSendCooldownResponse(reply, cooldown.retryAfterSeconds);
    }

    try {
      await options.authKitClient.resendVerificationEmail({
        emailVerificationId: parsed.emailVerificationId,
      });
    } catch {
      return reply.code(400).send({
        state: "auth_failed",
        message: "We could not resend this verification code. Please sign in again.",
      });
    }

    return reply.send({
      message: "A new verification code has been sent.",
    });
  });

  app.post("/password/reset/request", async (request, reply) => {
    if (!writeCorsHeaders(request, reply, options)) {
      return reply.code(403).send({
        state: "auth_failed",
        message: "Authentication request origin is not allowed.",
      });
    }
    const parsed = parsePasswordResetRequestBody(request.body);
    if (!parsed.ok) {
      return reply.code(400).send(parsed.error);
    }
    const cooldown = consumeEmailSendCooldown(emailSendCooldowns, `password-reset:${parsed.email}`);
    if (!cooldown.ok) {
      return sendEmailSendCooldownResponse(reply, cooldown.retryAfterSeconds);
    }

    try {
      await options.authKitClient.createPasswordReset({ email: parsed.email });
    } catch (error) {
      request.log.warn({ error }, "WorkOS password reset request failed");
    }

    return reply.send({
      message: "If an account with that email exists, a password reset link has been sent.",
    });
  });

  app.post("/password/reset/confirm", async (request, reply) => {
    if (!writeCorsHeaders(request, reply, options)) {
      return reply.code(403).send({
        state: "auth_failed",
        message: "Authentication request origin is not allowed.",
      });
    }
    const parsed = parsePasswordResetConfirmBody(request.body);
    if (!parsed.ok) {
      return reply.code(400).send(parsed.error);
    }

    try {
      await options.authKitClient.resetPassword({
        token: parsed.token,
        newPassword: parsed.newPassword,
      });
    } catch {
      return reply.code(400).send({
        state: "auth_failed",
        message: "Invalid or expired reset token. Please request a new password reset link.",
      });
    }

    return reply.send({
      message: "Password reset successful. Please sign in with your new password.",
    });
  });

  app.get("/session", async (request, reply) => {
    const query = request.query as { surface?: string };
    const surfacePolicy = getSurfacePolicy(parseSurface(query.surface), options);
    if (!writeCorsHeaders(request, reply, options)) {
      return reply.code(403).send({ error: "origin_rejected" });
    }
    const sealedSession = readCookie(request, SESSION_COOKIE, surfacePolicy);
    if (!sealedSession) {
      return sendTerminalSessionError(reply, surfacePolicy, options, "missing_session");
    }
    let session = await options.authKitClient.authenticateSession({ sealedSession });
    if (!session) {
      session = await options.authKitClient.refreshSession({ sealedSession });
    }
    if (!session) {
      return sendTerminalSessionError(reply, surfacePolicy, options, "invalid_session");
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
        return sendOrganizationSelectionSessionResponse(
          reply,
          session,
          error,
          surfacePolicy,
          options,
        );
      }
      return reply.code(403).send(toAuthError(error));
    }
    const requestCsrfToken = readCsrfToken(request, surfacePolicy);
    const csrfToken =
      requestCsrfToken ??
      (surfacePolicy.firstPartySession ? randomBytes(24).toString("base64url") : undefined);
    const setCookieHeaders = surfacePolicy.firstPartySession
      ? authSessionCookieHeaders(resolution.session, csrfToken!, surfacePolicy, options)
      : [
          ...(resolution.session.sealedSession !== sealedSession
            ? authCookieHeaders(
                SESSION_COOKIE,
                resolution.session.sealedSession,
                60 * 60 * 24 * 7,
                surfacePolicy,
                options,
              )
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
        csrfToken,
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
    const body = request.body as { organizationId?: string; surface?: string } | undefined;
    const surfacePolicy = getSurfacePolicy(parseSurface(body?.surface), options);
    if (!passesCsrfCheck(request, options, surfacePolicy)) {
      return reply.code(403).send({ error: "csrf_rejected" });
    }
    const sealedSession = readCookie(request, SESSION_COOKIE, surfacePolicy);
    if (!sealedSession) {
      return sendTerminalSessionError(reply, surfacePolicy, options, "missing_session");
    }
    const session = await options.authKitClient.refreshSession({
      sealedSession,
      organizationId: body?.organizationId,
    });
    if (!session) {
      return sendTerminalSessionError(reply, surfacePolicy, options, "invalid_session");
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
        return sendOrganizationSelectionSessionResponse(
          reply,
          session,
          error,
          surfacePolicy,
          options,
        );
      }
      return reply.code(403).send(toAuthError(error));
    }
    const csrfToken = readCsrfToken(request, surfacePolicy)!;
    const setCookieHeaders = surfacePolicy.firstPartySession
      ? authSessionCookieHeaders(resolution.session, csrfToken, surfacePolicy, options)
      : [
          ...authCookieHeaders(
            SESSION_COOKIE,
            resolution.session.sealedSession,
            60 * 60 * 24 * 7,
            surfacePolicy,
            options,
          ),
          ...selectedOrganizationCookieHeaders(resolution.session, surfacePolicy, options),
        ];
    reply
      .header("set-cookie", setCookieHeaders.length === 1 ? setCookieHeaders[0] : setCookieHeaders)
      .send(
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

  app.post("/handoff/create", async (request, reply) => {
    if (!writeCorsHeaders(request, reply, options)) {
      return reply.code(403).send({ error: "origin_rejected" });
    }
    if (!options.handoffRepository) {
      return reply.code(503).send({ error: "handoff_unavailable" });
    }
    const parsed = parseHandoffCreateBody(request.body);
    if (!parsed.ok) {
      return reply.code(400).send(parsed.error);
    }

    const sourcePolicy = findSurfacePolicy(parsed.sourceSurface, options);
    const targetPolicy = findSurfacePolicy(parsed.targetSurface, options);
    if (
      !sourcePolicy ||
      !targetPolicy ||
      !sourcePolicy.firstPartySession ||
      !targetPolicy.firstPartySession ||
      !sourcePolicy.publicOrigin ||
      !targetPolicy.publicOrigin
    ) {
      return reply.code(409).send({ error: "handoff_not_enabled" });
    }
    if (!requestIsBoundToSurface(request, parsed.sourceSurface, options)) {
      return reply.code(403).send({ error: "origin_rejected" });
    }
    if (!passesCsrfCheck(request, options, sourcePolicy)) {
      return reply.code(403).send({ error: "csrf_rejected" });
    }

    const sealedSession = readCookie(request, SESSION_COOKIE, sourcePolicy);
    if (!sealedSession) {
      return sendTerminalSessionError(reply, sourcePolicy, options, "missing_session");
    }

    let session: AuthKitSession | null;
    try {
      session = await options.authKitClient.authenticateSession({ sealedSession });
      if (
        session &&
        (!session.sessionId ||
          !(await options.authKitClient.isSessionActive({
            sessionId: session.sessionId,
            workosUserId: session.user.id,
          })))
      ) {
        session = null;
      }
    } catch (error) {
      request.log.warn({ error }, "Unable to prepare WorkOS handoff session");
      return reply.code(503).send({ error: "handoff_retryable" });
    }
    if (!session) {
      return sendTerminalSessionError(reply, sourcePolicy, options, "invalid_session");
    }

    let resolution: IdentityResolution;
    try {
      resolution = await resolveExistingIdentity(
        session,
        options,
        sourcePolicy,
        organizationAccessOptionsFromRequest(request, sourcePolicy),
      );
    } catch (error) {
      if (error instanceof OrganizationSelectionRequiredError) {
        return sendOrganizationSelectionSessionResponse(
          reply,
          session,
          error,
          sourcePolicy,
          options,
        );
      }
      return reply.code(403).send(toAuthError(error));
    }

    const routingHints: AuthHandoffRoutingHints = {
      ...(parsed.routingHints.hotelId ? { hotelId: parsed.routingHints.hotelId } : {}),
      ...(parsed.routingHints.propertyId ? { propertyId: parsed.routingHints.propertyId } : {}),
      organizationId: parsed.routingHints.organizationId ?? resolution.organizationId,
      workosOrganizationId:
        parsed.routingHints.workosOrganizationId ?? resolution.session.organizationId,
    };
    const expiresAt = new Date(Date.now() + AUTH_HANDOFF_TTL_MS);
    let code: string | null = null;
    for (let attempt = 0; attempt < 3 && !code; attempt += 1) {
      const candidate = randomBytes(32).toString("base64url");
      const stored = await options.handoffRepository.create({
        codeDigest: digestHandoffCode(candidate),
        expiresAt,
        routingHints,
        sealedSession: resolution.session.sealedSession,
        sourcePublicOrigin: sourcePolicy.publicOrigin,
        sourceSurface: parsed.sourceSurface,
        targetPath: parsed.targetPath,
        targetPublicOrigin: targetPolicy.publicOrigin,
        targetSurface: parsed.targetSurface,
      });
      if (stored) code = candidate;
    }
    if (!code) {
      return reply.code(503).send({ error: "handoff_unavailable" });
    }

    persistRefreshedSessionCookie(reply, sealedSession, resolution.session, sourcePolicy, options);
    const destination = new URL("/handoff", targetPolicy.publicOrigin);
    destination.hash = new URLSearchParams({ code }).toString();
    reply.header("Cache-Control", "private, no-store");
    return reply.send({
      destination: destination.toString(),
      expiresInSeconds: AUTH_HANDOFF_TTL_MS / 1000,
    });
  });

  app.post("/handoff/redeem", async (request, reply) => {
    if (!writeCorsHeaders(request, reply, options)) {
      return reply.code(403).send({ error: "origin_rejected" });
    }
    if (!options.handoffRepository) {
      return reply.code(503).send({ error: "handoff_unavailable" });
    }
    const parsed = parseHandoffRedeemBody(request.body);
    if (!parsed.ok) {
      return reply.code(400).send(parsed.error);
    }
    const targetPolicy = findSurfacePolicy(parsed.targetSurface, options);
    if (!targetPolicy || !targetPolicy.firstPartySession || !targetPolicy.publicOrigin) {
      return reply.code(409).send({ error: "handoff_not_enabled" });
    }
    if (!requestIsBoundToSurface(request, parsed.targetSurface, options)) {
      return reply.code(403).send({ error: "origin_rejected" });
    }

    const redemptionId = randomUUID();
    let handoff: AuthSessionHandoff | null;
    try {
      handoff = await options.handoffRepository.claim({
        codeDigest: digestHandoffCode(parsed.code),
        now: new Date(),
        redemptionId,
        targetPublicOrigin: targetPolicy.publicOrigin,
        targetSurface: parsed.targetSurface,
      });
    } catch (error) {
      request.log.warn({ error }, "Unable to claim WorkOS handoff session");
      return reply.code(503).send({ error: "handoff_retryable" });
    }
    if (!handoff) {
      return sendTerminalHandoffError(reply);
    }

    let session: AuthKitSession | null;
    try {
      session = await options.authKitClient.authenticateSession({
        sealedSession: handoff.sealedSession,
      });
      if (
        session &&
        (!session.sessionId ||
          !(await options.authKitClient.isSessionActive({
            sessionId: session.sessionId,
            workosUserId: session.user.id,
          })))
      ) {
        session = null;
      }
      if (
        session &&
        handoff.routingHints.workosOrganizationId &&
        session.organizationId !== handoff.routingHints.workosOrganizationId
      ) {
        session = await options.authKitClient.refreshSession({
          sealedSession: handoff.sealedSession,
          ...(handoff.routingHints.workosOrganizationId
            ? { organizationId: handoff.routingHints.workosOrganizationId }
            : {}),
        });
      }
    } catch (error) {
      await options.handoffRepository.release({ redemptionId });
      request.log.warn({ error }, "Unable to refresh WorkOS handoff session");
      return reply.code(503).send({ error: "handoff_retryable" });
    }
    if (!session) {
      await options.handoffRepository.complete({ now: new Date(), redemptionId });
      return sendTerminalHandoffError(reply);
    }

    let resolution: IdentityResolution;
    try {
      resolution = await resolveExistingIdentity(
        session,
        options,
        targetPolicy,
        organizationAccessOptionsFromRequest(request, targetPolicy, {
          explicitOrganizationSelection: Boolean(handoff.routingHints.workosOrganizationId),
          selectedWorkosOrganizationId:
            handoff.routingHints.workosOrganizationId ?? session.organizationId ?? null,
        }),
      );
    } catch (error) {
      if (isTerminalHandoffAuthorizationError(error)) {
        await options.handoffRepository.complete({ now: new Date(), redemptionId });
        request.log.info({ error }, "WorkOS handoff is not authorized for target surface");
        return sendTerminalHandoffError(reply);
      }
      await options.handoffRepository.release({ redemptionId });
      request.log.warn({ error }, "Unable to resolve WorkOS handoff authorization");
      return reply.code(503).send({ error: "handoff_retryable" });
    }
    if (
      (handoff.routingHints.organizationId &&
        handoff.routingHints.organizationId !== resolution.organizationId) ||
      (handoff.routingHints.workosOrganizationId &&
        handoff.routingHints.workosOrganizationId !== resolution.session.organizationId)
    ) {
      await options.handoffRepository.complete({ now: new Date(), redemptionId });
      return sendTerminalHandoffError(reply);
    }

    const completed = await options.handoffRepository.complete({
      now: new Date(),
      redemptionId,
    });
    if (!completed) {
      return sendTerminalHandoffError(reply);
    }

    const csrfToken = randomBytes(24).toString("base64url");
    reply
      .headers({
        "Cache-Control": "private, no-store",
        "set-cookie": authSessionCookieHeaders(
          resolution.session,
          csrfToken,
          targetPolicy,
          options,
        ),
      })
      .send({
        routingHints: {
          ...handoff.routingHints,
          organizationId: resolution.organizationId,
          workosOrganizationId: resolution.session.organizationId,
        },
        targetPath: handoff.targetPath,
      });
  });

  app.post("/onboarding", async (request, reply) => {
    if (!writeCorsHeaders(request, reply, options)) {
      return reply.code(403).send({ error: "origin_rejected" });
    }
    const parsed = parseOnboardingBody(request.body);
    if (!parsed.ok) {
      return reply.code(400).send(parsed.error);
    }
    const surfacePolicy = getSurfacePolicy(parsed.surface, options);
    if (!passesCsrfCheck(request, options, surfacePolicy)) {
      return reply.code(403).send({ error: "csrf_rejected" });
    }
    const sealedSession = readCookie(request, SESSION_COOKIE, surfacePolicy);
    if (!sealedSession) {
      return reply.code(401).send({ error: "missing_session" });
    }
    const session = await options.authKitClient.authenticateSession({ sealedSession });
    if (!session) {
      return reply.code(401).send({ error: "invalid_session" });
    }
    persistRefreshedSessionCookie(reply, sealedSession, session, surfacePolicy, options);

    let baseResolution: IdentityResolution;
    try {
      baseResolution = await resolveExistingIdentity(
        session,
        options,
        surfacePolicy,
        organizationAccessOptionsFromRequest(request, surfacePolicy),
      );
    } catch (error) {
      return reply.code(403).send(toAuthError(error));
    }
    persistRefreshedSessionCookie(
      reply,
      sealedSession,
      baseResolution.session,
      surfacePolicy,
      options,
    );

    let inviteResolution: HotelAccountInviteOnboardingResolution | null = null;
    if (parsed.inviteCode !== undefined) {
      if (!options.hotelAccountInviteOnboarding) {
        return reply.code(503).send({
          state: "auth_failed",
          message: "Hotel account invitation onboarding is temporarily unavailable.",
        });
      }
      try {
        inviteResolution = await options.hotelAccountInviteOnboarding.resolveForOnboarding({
          code: parsed.inviteCode,
          now: new Date(),
          actorEmail: baseResolution.user.email,
        });
      } catch {
        return reply.code(503).send({
          state: "auth_failed",
          message: "Hotel account invitation onboarding is temporarily unavailable.",
        });
      }
      if (!inviteResolution) {
        return reply.code(403).send({
          state: "auth_failed",
          message: "This hotel account invitation is invalid or no longer available.",
        });
      }
    }

    if (baseResolution.organizationKind && !inviteResolution) {
      return reply.send(
        toSessionResponse(
          baseResolution.session,
          baseResolution.user,
          readCsrfToken(request, surfacePolicy),
          baseResolution.organizationId,
          baseResolution.organizationKind,
          baseResolution.resourceScope,
        ),
      );
    }

    let selectedSession: AuthKitSession;
    try {
      const signupOrganization = await createSignupOrganizationContext(
        options.authKitClient,
        parsed.surface,
        parsed.intent,
        session.user.email,
        session.user.id,
        inviteResolution?.organizationName,
        inviteResolution?.organizationExternalId,
      );
      const membership = await options.authKitClient.ensureSignupOrganizationMembership({
        workosUserId: session.user.id,
        workosOrganizationId: signupOrganization.workosOrganizationId,
        roleKey: signupOrganization.roleKey,
      });
      await options.lifecycleCommandBus.execute({
        commandType: "identity.access.grant",
        commandId: randomUUID(),
        idempotencyKey: inviteResolution
          ? `workos-onboarding:${baseResolution.user.userId}:hotel:invite:${inviteResolution.inviteId}`
          : `workos-onboarding:${baseResolution.user.userId}:${parsed.intent}`,
        audit: {
          actor: { kind: "user", userId: baseResolution.user.userId },
          source: "web",
          requestId: request.id,
          correlationId: session.sessionId,
          reason: "Marketplace self-service onboarding",
          requestedAt: new Date().toISOString(),
        },
        payload: {
          userId: baseResolution.user.userId,
          organization: {
            kind: signupOrganization.kind,
            name: signupOrganization.name,
            workosOrgId: signupOrganization.workosOrganizationId,
            workosExternalId: signupOrganization.workosExternalId,
          },
          membership: {
            status: membership.status,
            roleKey: signupOrganization.roleKey,
            propertyAccessMode: membershipPropertyAccessModeForProvisioning(
              signupOrganization.kind,
              signupOrganization.roleKey,
            ),
            permissionKeys:
              signupOrganization.kind === "hotel_group"
                ? inviteResolution
                  ? [
                      "hotel_catalog.setup.read",
                      "hotel_catalog.setup.manage",
                      "hotel_catalog.products.manage",
                    ]
                  : ["hotel_catalog.setup.read", "hotel_catalog.setup.manage"]
                : undefined,
            workosMembershipId: membership.membershipId,
            workosRoleSlugs: membership.roleSlugs,
          },
        },
      });
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
        organizationAccessOptionsFromRequest(request, surfacePolicy, { skipSelection: true }),
      );
    } catch (error) {
      return reply.code(403).send(toAuthError(error));
    }

    const csrfToken =
      readCsrfToken(request, surfacePolicy) ?? randomBytes(24).toString("base64url");
    reply.header(
      "set-cookie",
      authSessionCookieHeaders(resolution.session, csrfToken, surfacePolicy, options),
    );
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

  app.post("/profile", async (request, reply) => {
    if (!writeCorsHeaders(request, reply, options)) {
      return reply.code(403).send({ error: "origin_rejected" });
    }
    const parsed = parseProfileBody(request.body);
    if (!parsed.ok) {
      return reply.code(400).send(parsed.error);
    }
    const surfacePolicy = getSurfacePolicy(parsed.surface, options);
    if (!passesCsrfCheck(request, options, surfacePolicy)) {
      return reply.code(403).send({ error: "csrf_rejected" });
    }
    const sealedSession = readCookie(request, SESSION_COOKIE, surfacePolicy);
    if (!sealedSession) {
      return reply.code(401).send({ error: "missing_session" });
    }
    const session = await options.authKitClient.authenticateSession({ sealedSession });
    if (!session) {
      return reply.code(401).send({ error: "invalid_session" });
    }
    persistRefreshedSessionCookie(reply, sealedSession, session, surfacePolicy, options);

    let resolution: IdentityResolution;
    try {
      resolution = await resolveExistingIdentity(
        session,
        options,
        surfacePolicy,
        organizationAccessOptionsFromRequest(request, surfacePolicy),
      );
    } catch (error) {
      return reply.code(403).send(toAuthError(error));
    }
    persistRefreshedSessionCookie(reply, sealedSession, resolution.session, surfacePolicy, options);

    let profilePictureUrl = parsed.profilePictureUrl;
    if (parsed.profilePictureMediaObjectId) {
      if (!resolution.organizationId) {
        return reply.code(403).send({
          state: "auth_failed",
          message: "Choose an organization before updating your profile picture.",
        });
      }
      const media = await resolveApprovedPublicProfileImage({
        repository: options.profileImageMediaRepository,
        mediaId: parsed.profilePictureMediaObjectId,
        actorUserId: resolution.user.userId,
        ownerOrganizationId: resolution.organizationId,
        allowedTargets: [
          {
            purpose: "identity.user.profile_image",
            resourceProduct: "platform",
            resourceType: "user_profile",
            resourceId: resolution.user.userId,
          },
        ],
      });
      if (!media.ok) {
        return reply.code(media.reason === "unavailable" ? 503 : 400).send({
          state: "auth_failed",
          message:
            media.reason === "unavailable"
              ? "Profile picture validation is temporarily unavailable."
              : "Choose a valid, approved profile picture.",
        });
      }
      profilePictureUrl = media.publicCdnUrl;
    }

    if (parsed.firstName !== undefined && parsed.lastName !== undefined) {
      await options.authKitClient.updateUserName({
        workosUserId: session.user.id,
        firstName: parsed.firstName,
        lastName: parsed.lastName,
      });
    }
    await options.lifecycleCommandBus.execute({
      commandType: "identity.user.profile.update",
      commandId: randomUUID(),
      idempotencyKey: `self-profile:${resolution.user.userId}:${request.id}`,
      audit: {
        actor: { kind: "user", userId: resolution.user.userId },
        source: "web",
        requestId: request.id,
        correlationId: session.sessionId,
        reason: "Self-service contact profile update",
        requestedAt: new Date().toISOString(),
      },
      payload: {
        userId: resolution.user.userId,
        ...(parsed.name !== undefined ? { name: parsed.name } : {}),
        ...(parsed.phone !== undefined ? { phone: parsed.phone } : {}),
        ...(parsed.profilePictureUrl !== undefined ? { profilePictureUrl } : {}),
        ...(parsed.profilePictureMediaObjectId !== undefined
          ? { profilePictureMediaObjectId: parsed.profilePictureMediaObjectId }
          : {}),
      },
    });

    return reply.send({ updated: true });
  });

  app.post("/logout", async (request, reply) => {
    if (!writeCorsHeaders(request, reply, options)) {
      return reply.code(403).send({ error: "origin_rejected" });
    }
    const body = request.body as { surface?: string; return_to?: string } | undefined;
    const surfacePolicy = getSurfacePolicy(parseSurface(body?.surface), options);
    if (!passesCsrfCheck(request, options, surfacePolicy)) {
      return reply.code(403).send({ error: "csrf_rejected" });
    }
    const sealedSession = readCookie(request, SESSION_COOKIE, surfacePolicy);
    const returnTo = body?.return_to
      ? validateReturnTo(body.return_to, options.allowedOrigins)
      : (surfacePolicy.logoutReturnUrl ?? options.logoutReturnUrl);
    let logoutUrl = returnTo;
    if (sealedSession) {
      let session: AuthKitSession | null = null;
      try {
        session = await options.authKitClient.authenticateSession({ sealedSession });
      } catch (error) {
        request.log.warn({ error }, "Unable to authenticate WorkOS logout session");
      }
      const logoutSealedSession = session?.sealedSession ?? sealedSession;
      if (session) {
        const resolution = await resolveExistingIdentity(
          session,
          options,
          surfacePolicy,
          organizationAccessOptionsFromRequest(request, surfacePolicy),
        ).catch(() => null);
        try {
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
        } catch (error) {
          request.log.warn({ error }, "Unable to record logout audit event");
        }
      }
      try {
        logoutUrl = await options.authKitClient.getLogoutUrl({
          sealedSession: logoutSealedSession,
          returnTo,
        });
      } catch (error) {
        request.log.warn({ error }, "Unable to create WorkOS logout URL");
      }
    }

    reply
      .headers({
        "set-cookie": clearAllAuthCookieHeaders(surfacePolicy, options),
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
};

function consumeEmailSendCooldown(
  cooldowns: Map<string, number>,
  key: string,
  now: number = Date.now(),
): { ok: true } | { ok: false; retryAfterSeconds: number } {
  const cooldownKey = key.toLowerCase();
  const expiresAt = cooldowns.get(cooldownKey);
  if (expiresAt && expiresAt > now) {
    return { ok: false, retryAfterSeconds: Math.ceil((expiresAt - now) / 1000) };
  }
  cooldowns.set(cooldownKey, now + EMAIL_SEND_COOLDOWN_MS);
  return { ok: true };
}

function sendEmailSendCooldownResponse(reply: FastifyReply, retryAfterSeconds: number) {
  return reply.code(429).header("retry-after", String(retryAfterSeconds)).send({
    state: "auth_failed",
    message: EMAIL_SEND_COOLDOWN_MESSAGE,
  });
}

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

function parseHandoffCreateBody(body: unknown):
  | {
      ok: true;
      routingHints: AuthHandoffRoutingHints;
      sourceSurface: AuthSurface;
      targetPath: string;
      targetSurface: AuthSurface;
    }
  | { ok: false; error: { error: string } } {
  if (!body || typeof body !== "object") {
    return { ok: false, error: { error: "invalid_handoff" } };
  }
  const input = body as {
    routingHints?: unknown;
    sourceSurface?: unknown;
    targetPath?: unknown;
    targetSurface?: unknown;
  };
  let sourceSurface: AuthSurface;
  let targetSurface: AuthSurface;
  try {
    if (typeof input.sourceSurface !== "string" || typeof input.targetSurface !== "string") {
      throw new Error("Missing handoff surface");
    }
    sourceSurface = parseSurface(input.sourceSurface);
    targetSurface = parseSurface(input.targetSurface);
  } catch {
    return { ok: false, error: { error: "invalid_handoff_surface" } };
  }
  if (sourceSurface === targetSurface) {
    return { ok: false, error: { error: "invalid_handoff_surface" } };
  }
  const targetPath = typeof input.targetPath === "string" ? input.targetPath : "/";
  if (!isSafeHandoffTargetPath(targetPath)) {
    return { ok: false, error: { error: "invalid_handoff_target" } };
  }
  const routingHints = parseHandoffRoutingHints(input.routingHints);
  if (!routingHints) {
    return { ok: false, error: { error: "invalid_handoff_hints" } };
  }
  return { ok: true, routingHints, sourceSurface, targetPath, targetSurface };
}

function parseHandoffRedeemBody(
  body: unknown,
):
  | { ok: true; code: string; targetSurface: AuthSurface }
  | { ok: false; error: { error: string } } {
  if (!body || typeof body !== "object") {
    return { ok: false, error: { error: "invalid_handoff" } };
  }
  const input = body as { code?: unknown; targetSurface?: unknown };
  if (
    typeof input.code !== "string" ||
    input.code.length < 32 ||
    input.code.length > 128 ||
    !/^[A-Za-z0-9_-]+$/.test(input.code) ||
    typeof input.targetSurface !== "string"
  ) {
    return { ok: false, error: { error: "invalid_handoff" } };
  }
  try {
    return {
      ok: true,
      code: input.code,
      targetSurface: parseSurface(input.targetSurface),
    };
  } catch {
    return { ok: false, error: { error: "invalid_handoff_surface" } };
  }
}

function parseHandoffRoutingHints(value: unknown): AuthHandoffRoutingHints | null {
  if (value === undefined) return {};
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const input = value as Record<string, unknown>;
  if (
    Object.keys(input).some(
      (key) => !["hotelId", "organizationId", "propertyId", "workosOrganizationId"].includes(key),
    )
  ) {
    return null;
  }
  const result: AuthHandoffRoutingHints = {};
  for (const key of ["hotelId", "organizationId", "propertyId", "workosOrganizationId"] as const) {
    const candidate = input[key];
    if (candidate === undefined) continue;
    if (typeof candidate !== "string") return null;
    const normalized = candidate.trim();
    if (!normalized || normalized.length > 256) return null;
    result[key] = normalized;
  }
  return result;
}

function isSafeHandoffTargetPath(value: string): boolean {
  if (value.length > 2048 || !value.startsWith("/") || value.startsWith("//")) return false;
  let decoded = value;
  try {
    for (let index = 0; index < 4; index += 1) {
      const next = decodeURIComponent(decoded);
      if (next === decoded) break;
      decoded = next;
    }
    if (!decoded.startsWith("/") || decoded.startsWith("//") || decoded.includes("\\")) {
      return false;
    }
    const url = new URL(decoded, "https://handoff.vayada.local");
    return url.origin === "https://handoff.vayada.local" && !url.hash;
  } catch {
    return false;
  }
}

function digestHandoffCode(code: string): string {
  return createHash("sha256").update(code).digest("hex");
}

type GoogleOAuthFlow = "login" | "signup";

type GoogleOAuthState = {
  provider: "google";
  flow: GoogleOAuthFlow;
  surface: AuthSurface;
  intent?: AuthSignupIntent;
  returnTo: string;
  errorReturnTo: string;
  nonce: string;
  issuedAt: number;
};

function parseGoogleOAuthStartQuery(
  request: FastifyRequest,
  options: AuthSessionRouteOptions,
):
  | {
      ok: true;
      flow: GoogleOAuthFlow;
      surface: AuthSurface;
      intent?: AuthSignupIntent;
      returnTo: string;
      errorReturnTo: string;
      loginHint?: string;
    }
  | { ok: false; error: { error: string; message: string } } {
  const query = request.query as {
    flow?: unknown;
    surface?: unknown;
    type?: unknown;
    intent?: unknown;
    return_to?: unknown;
    error_return_to?: unknown;
    login_hint?: unknown;
  };
  const flow = query.flow === "signup" ? "signup" : "login";
  let surface: AuthSurface;
  let intent: AuthSignupIntent | undefined;
  try {
    surface = parseSurface(typeof query.surface === "string" ? query.surface : undefined);
  } catch {
    return { ok: false, error: { error: "invalid_surface", message: "Unsupported auth surface." } };
  }
  if (flow === "signup") {
    const rawIntent = typeof query.type === "string" ? query.type : query.intent;
    try {
      if (surface !== "marketplace-web" || typeof rawIntent === "string") {
        intent = parseSignupIntent(surface, typeof rawIntent === "string" ? rawIntent : undefined);
      }
    } catch {
      return {
        ok: false,
        error: { error: "invalid_signup", message: "Unsupported Google signup request." },
      };
    }
  }
  const surfaceOrigin = options.surfacePolicies?.[surface]?.publicOrigin;
  const returnTo = safeAllowedReturnTo(query.return_to, options, surfaceOrigin);
  const errorReturnTo = safeAllowedReturnTo(query.error_return_to, options, surfaceOrigin);
  if (!returnTo || !errorReturnTo) {
    return {
      ok: false,
      error: { error: "invalid_return_to", message: "OAuth return URL is not allowed." },
    };
  }
  return {
    ok: true,
    flow,
    surface,
    intent,
    returnTo,
    errorReturnTo,
    loginHint: typeof query.login_hint === "string" ? query.login_hint : undefined,
  };
}

function safeAllowedReturnTo(
  value: unknown,
  options: AuthSessionRouteOptions,
  requiredOrigin?: string,
): string | null {
  if (typeof value !== "string" || !value) return null;
  try {
    const url = new URL(value);
    return options.allowedOrigins.includes(url.origin) &&
      (!requiredOrigin || url.origin === requiredOrigin)
      ? url.toString()
      : null;
  } catch {
    return null;
  }
}

function googleOAuthCallbackUrl(
  request: FastifyRequest,
  surfacePolicy: AuthSurfacePolicy,
  options: AuthSessionRouteOptions,
): string | null {
  const callbackOrigin = surfacePolicy.firstPartySession
    ? surfacePolicy.publicOrigin
    : options.compatibilityCallbackOrigin;
  if (!callbackOrigin || !options.allowedOrigins.includes(callbackOrigin)) return null;

  const forwardedOrigin = readForwardedOrigin(request);
  if (
    (surfacePolicy.firstPartySession && !forwardedOrigin.present) ||
    (forwardedOrigin.present && forwardedOrigin.origin !== callbackOrigin)
  ) {
    return null;
  }
  return `${callbackOrigin}/auth/oauth/google/callback`;
}

function readForwardedOrigin(
  request: FastifyRequest,
): { present: false } | { present: true; origin: string | null } {
  const forwardedProto = firstProxyHeaderValue(request.headers["x-forwarded-proto"]);
  const forwardedHost = firstProxyHeaderValue(request.headers["x-forwarded-host"]);
  if (!forwardedProto && !forwardedHost) return { present: false };
  const proto = forwardedProto ?? request.protocol;
  const host = forwardedHost ?? firstProxyHeaderValue(request.headers.host);
  if (!host || !["http", "https"].includes(proto.toLowerCase())) {
    return { present: true, origin: null };
  }
  try {
    const url = new URL(`${proto.toLowerCase()}://${host}`);
    if (url.username || url.password || url.pathname !== "/" || url.search || url.hash) {
      return { present: true, origin: null };
    }
    return { present: true, origin: url.origin };
  } catch {
    return { present: true, origin: null };
  }
}

function requestIsBoundToSurface(
  request: FastifyRequest,
  surface: AuthSurface,
  options: AuthSessionRouteOptions,
): boolean {
  const expectedOrigin = getSurfacePolicy(surface, options).publicOrigin;
  if (!expectedOrigin || !options.allowedOrigins.includes(expectedOrigin)) return false;
  const forwardedOrigin = readForwardedOrigin(request);
  return (
    request.headers.origin === expectedOrigin &&
    forwardedOrigin.present &&
    forwardedOrigin.origin === expectedOrigin
  );
}

function firstProxyHeaderValue(value: string | string[] | undefined): string | undefined {
  const first = Array.isArray(value) ? value[0] : value;
  return first?.split(",", 1)[0]?.trim() || undefined;
}

function createOAuthState(
  options: AuthSessionRouteOptions,
  input: Omit<GoogleOAuthState, "nonce" | "issuedAt">,
): { value: string; nonce: string } {
  const nonce = randomBytes(18).toString("base64url");
  const payload: GoogleOAuthState = {
    ...input,
    nonce,
    issuedAt: Date.now(),
  };
  const encoded = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const signature = createHmac("sha256", options.oauthStateSecret)
    .update(encoded)
    .digest("base64url");
  return { value: `${encoded}.${signature}`, nonce };
}

function readOAuthState(
  value: string,
  options: AuthSessionRouteOptions,
): { ok: true; value: GoogleOAuthState } | { ok: false } {
  const [encoded, signature] = value.split(".");
  if (!encoded || !signature) return { ok: false };
  const expected = createHmac("sha256", options.oauthStateSecret)
    .update(encoded)
    .digest("base64url");
  if (!safeEqual(signature, expected)) return { ok: false };
  try {
    const parsed = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
    if (!isGoogleOAuthState(parsed)) return { ok: false };
    if (Date.now() - parsed.issuedAt > OAUTH_STATE_MAX_AGE_SECONDS * 1000) return { ok: false };
    return { ok: true, value: parsed };
  } catch {
    return { ok: false };
  }
}

function safeEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

function isGoogleOAuthState(value: unknown): value is GoogleOAuthState {
  if (!value || typeof value !== "object") return false;
  const state = value as Partial<GoogleOAuthState>;
  return (
    state.provider === "google" &&
    (state.flow === "login" || state.flow === "signup") &&
    typeof state.surface === "string" &&
    typeof state.returnTo === "string" &&
    typeof state.errorReturnTo === "string" &&
    typeof state.nonce === "string" &&
    typeof state.issuedAt === "number"
  );
}

function redirectWithOAuthError(reply: FastifyReply, state: GoogleOAuthState, message: string) {
  const url = new URL(state.errorReturnTo);
  url.searchParams.set("auth_error", message);
  return reply.redirect(url.toString());
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
      intent?: AuthSignupIntent;
    }
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
    if (surface === "marketplace-web") {
      return { ok: true, email, password, surface };
    }
    const rawIntent = typeof input.type === "string" ? input.type : input.intent;
    return {
      ok: true,
      email,
      password,
      surface,
      intent: parseSignupIntent(surface, typeof rawIntent === "string" ? rawIntent : undefined),
    };
  } catch {
    return { ok: false, error: { state: "auth_failed", message: "Unsupported signup request." } };
  }
}

function parseOnboardingBody(
  body: unknown,
):
  | { ok: true; surface: AuthSurface; intent: AuthSignupIntent; inviteCode?: string }
  | { ok: false; error: { state: "auth_failed"; message: string } } {
  if (!body || typeof body !== "object") {
    return {
      ok: false,
      error: { state: "auth_failed", message: "Onboarding account type is required." },
    };
  }
  const input = body as {
    surface?: unknown;
    type?: unknown;
    intent?: unknown;
    inviteCode?: unknown;
  };
  try {
    const surface = parseSurface(
      typeof input.surface === "string" ? input.surface : "marketplace-web",
    );
    const rawIntent = typeof input.type === "string" ? input.type : input.intent;
    if (rawIntent !== "creator" && rawIntent !== "hotel") {
      return {
        ok: false,
        error: { state: "auth_failed", message: "Choose creator or hotel to continue." },
      };
    }
    const intent = parseSignupIntent(surface, rawIntent);
    const hasInviteCode = Object.prototype.hasOwnProperty.call(input, "inviteCode");
    if (!hasInviteCode) return { ok: true, surface, intent };
    if (
      surface !== "marketplace-web" ||
      intent !== "hotel" ||
      typeof input.inviteCode !== "string" ||
      Object.keys(input).some((key) => !["surface", "type", "intent", "inviteCode"].includes(key))
    ) {
      return { ok: false, error: { state: "auth_failed", message: "Unsupported onboarding." } };
    }
    return { ok: true, surface, intent, inviteCode: input.inviteCode };
  } catch {
    return { ok: false, error: { state: "auth_failed", message: "Unsupported onboarding." } };
  }
}

function parseProfileBody(body: unknown):
  | {
      ok: true;
      surface: AuthSurface;
      name?: string;
      firstName?: string;
      lastName?: string;
      phone?: string | null;
      profilePictureUrl?: string | null;
      profilePictureMediaObjectId?: string | null;
    }
  | { ok: false; error: { state: "auth_failed"; message: string } } {
  if (!body || typeof body !== "object") {
    return {
      ok: false,
      error: { state: "auth_failed", message: "Profile details are required." },
    };
  }
  const input = body as {
    surface?: unknown;
    firstName?: unknown;
    lastName?: unknown;
    phone?: unknown;
    profilePictureUrl?: unknown;
    profilePictureMediaObjectId?: unknown;
  };
  const allowedKeys = new Set([
    "surface",
    "firstName",
    "lastName",
    "phone",
    "profilePictureUrl",
    "profilePictureMediaObjectId",
  ]);
  if (Object.keys(body).some((key) => !allowedKeys.has(key))) {
    return {
      ok: false,
      error: { state: "auth_failed", message: "Unsupported profile details." },
    };
  }
  try {
    const surface = parseSurface(
      typeof input.surface === "string" ? input.surface : "marketplace-web",
    );
    const hasFirstName = Object.prototype.hasOwnProperty.call(input, "firstName");
    const hasLastName = Object.prototype.hasOwnProperty.call(input, "lastName");
    const hasName = hasFirstName || hasLastName;
    const hasPhone = Object.prototype.hasOwnProperty.call(input, "phone");
    const hasProfilePictureUrl = Object.prototype.hasOwnProperty.call(input, "profilePictureUrl");
    const hasProfilePictureMediaObjectId = Object.prototype.hasOwnProperty.call(
      input,
      "profilePictureMediaObjectId",
    );
    if (
      hasFirstName !== hasLastName ||
      (hasFirstName && typeof input.firstName !== "string") ||
      (hasLastName && typeof input.lastName !== "string")
    ) {
      throw new Error("Invalid name");
    }
    if (hasPhone && typeof input.phone !== "string") throw new Error("Invalid phone");
    if (
      hasProfilePictureUrl !== hasProfilePictureMediaObjectId ||
      (hasProfilePictureUrl && typeof input.profilePictureUrl !== "string") ||
      (hasProfilePictureMediaObjectId && typeof input.profilePictureMediaObjectId !== "string")
    ) {
      throw new Error("Invalid profile picture");
    }
    const firstName =
      typeof input.firstName === "string" ? input.firstName.trim().replace(/\s+/g, " ") : "";
    const lastName =
      typeof input.lastName === "string" ? input.lastName.trim().replace(/\s+/g, " ") : "";
    const name = hasName ? `${firstName} ${lastName}` : "";
    const phone = typeof input.phone === "string" ? input.phone.trim() : "";
    const profilePictureUrl =
      typeof input.profilePictureUrl === "string" ? input.profilePictureUrl.trim() : "";
    const profilePictureMediaObjectId =
      typeof input.profilePictureMediaObjectId === "string"
        ? input.profilePictureMediaObjectId.trim()
        : "";
    if (
      (hasName &&
        (!firstName ||
          firstName.length > 60 ||
          !lastName ||
          lastName.length > 60 ||
          name.length > 120)) ||
      !isValidOptionalPhone(phone) ||
      profilePictureUrl.length > 2048 ||
      profilePictureMediaObjectId.length > 2048 ||
      Boolean(profilePictureUrl) !== Boolean(profilePictureMediaObjectId) ||
      (!hasName && !hasPhone && !hasProfilePictureUrl)
    ) {
      throw new Error("Invalid profile details");
    }
    if (profilePictureUrl && !profilePictureUrl.startsWith("staging/")) {
      const profilePicture = new URL(profilePictureUrl);
      const localHttpUrl =
        profilePicture.protocol === "http:" &&
        ["localhost", "127.0.0.1"].includes(profilePicture.hostname);
      if (profilePicture.protocol !== "https:" && !localHttpUrl) {
        throw new Error("Invalid profile picture URL");
      }
    }
    return {
      ok: true,
      surface,
      ...(hasName ? { name, firstName, lastName } : {}),
      ...(hasPhone ? { phone: phone || null } : {}),
      ...(hasProfilePictureUrl ? { profilePictureUrl: profilePictureUrl || null } : {}),
      ...(hasProfilePictureMediaObjectId
        ? { profilePictureMediaObjectId: profilePictureMediaObjectId || null }
        : {}),
    };
  } catch {
    return {
      ok: false,
      error: { state: "auth_failed", message: "Enter valid profile details to continue." },
    };
  }
}

function isValidOptionalPhone(phone: string): boolean {
  if (!phone) return true;
  if (phone.length > 64 || !/^\+?[0-9(][0-9\s().-]*$/.test(phone)) return false;
  const digitCount = phone.replace(/\D/g, "").length;
  return digitCount >= 7 && digitCount <= 15;
}

function parseEmailVerificationConfirmBody(body: unknown):
  | {
      ok: true;
      pendingAuthenticationToken: string;
      code: string;
      surface: AuthSurface;
      flow?: "login" | "signup";
      intent?: AuthSignupIntent;
    }
  | {
      ok: false;
      error: { state: "auth_failed"; message: string };
    } {
  if (!body || typeof body !== "object") {
    return {
      ok: false,
      error: { state: "auth_failed", message: "Verification token and code are required." },
    };
  }
  const input = body as {
    pendingAuthenticationToken?: unknown;
    code?: unknown;
    surface?: unknown;
    flow?: unknown;
    intent?: unknown;
  };
  const pendingAuthenticationToken =
    typeof input.pendingAuthenticationToken === "string"
      ? input.pendingAuthenticationToken.trim()
      : "";
  const code = typeof input.code === "string" ? input.code.trim() : "";
  if (!pendingAuthenticationToken || !code) {
    return {
      ok: false,
      error: { state: "auth_failed", message: "Verification token and code are required." },
    };
  }

  try {
    const surface = parseSurface(
      typeof input.surface === "string" ? input.surface : "marketplace-web",
    );
    const flow = input.flow === "signup" ? "signup" : "login";
    const intent =
      flow === "signup" && typeof input.intent === "string"
        ? parseSignupIntent(surface, input.intent)
        : undefined;
    return {
      ok: true,
      pendingAuthenticationToken,
      code,
      surface,
      flow,
      intent,
    };
  } catch {
    return {
      ok: false,
      error: { state: "auth_failed", message: "Unsupported verification request." },
    };
  }
}

function parseEmailVerificationResendBody(
  body: unknown,
):
  | { ok: true; emailVerificationId: string }
  | { ok: false; error: { state: "auth_failed"; message: string } } {
  if (!body || typeof body !== "object") {
    return {
      ok: false,
      error: { state: "auth_failed", message: "Verification state is required." },
    };
  }
  const input = body as { emailVerificationId?: unknown };
  const emailVerificationId =
    typeof input.emailVerificationId === "string" ? input.emailVerificationId.trim() : "";
  if (!emailVerificationId) {
    return {
      ok: false,
      error: { state: "auth_failed", message: "Verification state is required." },
    };
  }
  return { ok: true, emailVerificationId };
}

function parsePasswordResetRequestBody(
  body: unknown,
): { ok: true; email: string } | { ok: false; error: { state: "auth_failed"; message: string } } {
  if (!body || typeof body !== "object") {
    return {
      ok: false,
      error: { state: "auth_failed", message: "A valid email address is required." },
    };
  }
  const input = body as { email?: unknown };
  const email = typeof input.email === "string" ? input.email.trim() : "";
  if (!isLikelyEmail(email)) {
    return {
      ok: false,
      error: { state: "auth_failed", message: "A valid email address is required." },
    };
  }
  return { ok: true, email };
}

function parsePasswordResetConfirmBody(
  body: unknown,
):
  | { ok: true; token: string; newPassword: string }
  | { ok: false; error: { state: "auth_failed"; message: string } } {
  if (!body || typeof body !== "object") {
    return {
      ok: false,
      error: { state: "auth_failed", message: "Reset token and new password are required." },
    };
  }
  const input = body as { token?: unknown; newPassword?: unknown; new_password?: unknown };
  const token = typeof input.token === "string" ? input.token.trim() : "";
  const newPassword =
    typeof input.newPassword === "string"
      ? input.newPassword
      : typeof input.new_password === "string"
        ? input.new_password
        : "";
  if (!token || !newPassword) {
    return {
      ok: false,
      error: { state: "auth_failed", message: "Reset token and new password are required." },
    };
  }
  if (newPassword.length < 8) {
    return {
      ok: false,
      error: { state: "auth_failed", message: "Password must be at least 8 characters long." },
    };
  }
  return { ok: true, token, newPassword };
}

function isLikelyEmail(email: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
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
  organizationName?: string,
  organizationExternalId?: string,
): Promise<AuthSignupOrganizationContext> {
  const template = signupOrganizationTemplate(surface, signupIntent, loginHint, externalIdSuffix);
  const name = organizationName ?? template.name;
  const externalId = organizationExternalId ?? template.externalId;
  const organization = await authKitClient.createSignupOrganization({
    name,
    externalId,
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
    workosExternalId: externalId,
    name,
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
  const configured = findSurfacePolicy(surface, options);
  if (!configured) {
    throw new Error(`AuthKit surface is not configured: ${surface}`);
  }
  return configured;
}

function findSurfacePolicy(
  surface: AuthSurface,
  options: AuthSessionRouteOptions,
): AuthSurfacePolicy | undefined {
  const defaultPlatformPolicy: AuthSurfacePolicy = {
    requiredOrganizationKind: options.requiredOrganizationKind,
    logoutReturnUrl: options.logoutReturnUrl,
    legacyJwtSecret: options.legacyMarketplaceJwtSecret,
    legacyJwtUserType: "admin",
    requiredMembershipRoleKey: "platform_admin",
  };
  if (surface === DEFAULT_SURFACE) {
    return { ...defaultPlatformPolicy, ...options.surfacePolicies?.[surface] };
  }
  return options.surfacePolicies?.[surface];
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
    if (!passesCsrfCheck(request, options, surfacePolicy)) {
      return reply.code(403).send({ error: "csrf_rejected" });
    }
    const sealedSession = readCookie(request, SESSION_COOKIE, surfacePolicy);
    if (!sealedSession) {
      return reply.code(401).send({ error: "missing_session" });
    }
    const session = await options.authKitClient.authenticateSession({ sealedSession });
    if (!session) {
      return reply.code(401).send({ error: "invalid_session" });
    }
    persistRefreshedSessionCookie(reply, sealedSession, session, surfacePolicy, options);
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
        return sendOrganizationSelectionResponse(
          reply,
          error,
          readCsrfToken(request, surfacePolicy),
        );
      }
      return reply.code(403).send(toAuthError(error));
    }
    persistRefreshedSessionCookie(reply, sealedSession, resolution.session, surfacePolicy, options);
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
                propertyAccessMode: membershipPropertyAccessModeForProvisioning(
                  signupContext.organization.kind,
                  signupContext.organization.roleKey,
                ),
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
    throw new Error("This email already has a Vayada account. Sign in instead.");
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
    throw new AuthAuthorizationError(`No internal user for WorkOS user ${verified.workosUserId}`);
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
    throw new AuthAuthorizationError("AuthKit session is missing selected organization");
  }
  const organization = await options.identityRepository.findOrganizationByWorkosOrgId(
    session.organizationId,
  );
  if (!organization || !organization.workosOrgId) {
    throw new AuthAuthorizationError(
      `No WorkOS-managed organization for ${session.organizationId}`,
    );
  }
  if (organization.status !== "active") {
    throw new AuthAuthorizationError(`Organization ${organization.organizationId} is not active`);
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
        if (!(error instanceof AuthAuthorizationError)) throw error;
      }
    }
    throw new AuthAuthorizationError(
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
    throw new AuthAuthorizationError("No active membership for selected organization");
  }
  if (
    surfacePolicy.requiredMembershipRoleKey &&
    membership.roleKey !== surfacePolicy.requiredMembershipRoleKey
  ) {
    throw new AuthAuthorizationError(
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
      throw new AuthAuthorizationError(
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

class AuthAuthorizationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AuthAuthorizationError";
  }
}

function isTerminalHandoffAuthorizationError(error: unknown): boolean {
  return (
    error instanceof AuthAuthorizationError || error instanceof OrganizationSelectionRequiredError
  );
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
        throw new AuthAuthorizationError(
          "WorkOS organization membership is not active for selected organization",
        );
      }
      const retried = await options.authKitClient.refreshSession({
        sealedSession: session.sealedSession,
        organizationId: candidate.workosOrganizationId,
      });
      if (retried?.organizationId !== candidate.workosOrganizationId) {
        throw new AuthAuthorizationError(
          "Unable to refresh AuthKit session for selected organization",
        );
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

  if (accessOptions.allowMissingOrganization) {
    return { session };
  }

  throw new AuthAuthorizationError(
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

function sendOrganizationSelectionSessionResponse(
  reply: FastifyReply,
  session: AuthKitSession,
  error: OrganizationSelectionRequiredError,
  surfacePolicy: AuthSurfacePolicy,
  options: AuthSessionRouteOptions,
) {
  const csrfToken = randomBytes(24).toString("base64url");
  reply.headers({
    "set-cookie": [
      ...authCookieHeaders(
        SESSION_COOKIE,
        session.sealedSession,
        60 * 60 * 24 * 7,
        surfacePolicy,
        options,
      ),
      ...authCookieHeaders(CSRF_COOKIE, csrfToken, 60 * 60 * 24 * 7, surfacePolicy, options, {
        httpOnly: surfacePolicy.firstPartySession === true,
      }),
      ...clearSelectedOrganizationCookieHeaders(surfacePolicy, options),
    ],
  });
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
      name: error.user.name ?? null,
      phone: error.user.phone ?? null,
      profilePictureUrl: error.user.profilePictureUrl ?? null,
      profilePictureMediaObjectId: error.user.profilePictureMediaObjectId ?? null,
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
    allowMissingOrganization: surfacePolicy.allowMissingOrganization === true,
    selectedWorkosOrganizationId: selectedOrganizationCookieName
      ? (readCookie(request, selectedOrganizationCookieName, surfacePolicy) ?? null)
      : null,
    ...overrides,
  };
}

function selectedOrganizationCookieNames(surfacePolicy: AuthSurfacePolicy): string[] {
  return surfacePolicy.selectedOrganizationCookieName
    ? [surfacePolicy.selectedOrganizationCookieName]
    : [];
}

function authSessionCookieHeaders(
  session: AuthKitSession,
  csrfToken: string,
  surfacePolicy: AuthSurfacePolicy,
  options: AuthSessionRouteOptions,
): string[] {
  return [
    ...authCookieHeaders(
      SESSION_COOKIE,
      session.sealedSession,
      60 * 60 * 24 * 7,
      surfacePolicy,
      options,
    ),
    ...authCookieHeaders(CSRF_COOKIE, csrfToken, 60 * 60 * 24 * 7, surfacePolicy, options, {
      httpOnly: surfacePolicy.firstPartySession === true,
    }),
    ...selectedOrganizationCookieHeaders(session, surfacePolicy, options),
  ];
}

function clearAuthSessionCookieHeaders(
  surfacePolicy: AuthSurfacePolicy,
  options: AuthSessionRouteOptions,
): string[] {
  return [
    ...authCookieHeaders(SESSION_COOKIE, "", 0, surfacePolicy, options),
    ...authCookieHeaders(CSRF_COOKIE, "", 0, surfacePolicy, options, {
      httpOnly: surfacePolicy.firstPartySession === true,
    }),
    ...clearSelectedOrganizationCookieHeaders(surfacePolicy, options),
  ];
}

function clearAllAuthCookieHeaders(
  surfacePolicy: AuthSurfacePolicy,
  options: AuthSessionRouteOptions,
): string[] {
  return [
    ...clearAuthSessionCookieHeaders(surfacePolicy, options),
    ...authCookieHeaders(OAUTH_STATE_COOKIE, "", 0, surfacePolicy, options),
  ];
}

function sendTerminalSessionError(
  reply: FastifyReply,
  surfacePolicy: AuthSurfacePolicy,
  options: AuthSessionRouteOptions,
  error: "invalid_session" | "missing_session",
) {
  return reply
    .code(401)
    .header("set-cookie", clearAuthSessionCookieHeaders(surfacePolicy, options))
    .send({ error });
}

function sendTerminalHandoffError(reply: FastifyReply) {
  return reply
    .code(401)
    .headers({
      "Cache-Control": "private, no-store",
    })
    .send({ error: "invalid_handoff" });
}

function persistRefreshedSessionCookie(
  reply: FastifyReply,
  requestSealedSession: string,
  session: AuthKitSession,
  surfacePolicy: AuthSurfacePolicy,
  options: AuthSessionRouteOptions,
): void {
  if (session.sealedSession === requestSealedSession) return;
  reply.header(
    "set-cookie",
    authCookieHeaders(
      SESSION_COOKIE,
      session.sealedSession,
      60 * 60 * 24 * 7,
      surfacePolicy,
      options,
    ),
  );
}

function selectedOrganizationCookieHeaders(
  session: AuthKitSession,
  surfacePolicy: AuthSurfacePolicy,
  options: AuthSessionRouteOptions,
): string[] {
  const cookieName = surfacePolicy.selectedOrganizationCookieName;
  if (!cookieName || !session.organizationId) return [];
  return authCookieHeaders(
    cookieName,
    session.organizationId,
    60 * 60 * 24 * 7,
    surfacePolicy,
    options,
  );
}

function clearSelectedOrganizationCookieHeaders(
  surfacePolicy: AuthSurfacePolicy,
  options: AuthSessionRouteOptions,
): string[] {
  return selectedOrganizationCookieNames(surfacePolicy).flatMap((name) =>
    authCookieHeaders(name, "", 0, surfacePolicy, options),
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
      name: user.name ?? null,
      phone: user.phone ?? null,
      profilePictureUrl: user.profilePictureUrl ?? null,
      profilePictureMediaObjectId: user.profilePictureMediaObjectId ?? null,
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

function readCookie(
  request: FastifyRequest,
  name: string,
  surfacePolicy: AuthSurfacePolicy,
): string | undefined {
  const values = readCookies(request, activeCookieName(name, surfacePolicy));
  return surfacePolicy.firstPartySession
    ? values.length === 1
      ? values[0]
      : undefined
    : values[0];
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
  options: {
    maxAge: number;
    secure: boolean;
    sameSite: "Lax" | "None";
    domain?: string;
    httpOnly?: boolean;
  },
): string {
  const parts = [
    `${name}=${encodeURIComponent(value)}`,
    "Path=/auth",
    `Max-Age=${options.maxAge}`,
    `SameSite=${options.sameSite}`,
  ];
  if (options.httpOnly !== false) parts.push("HttpOnly");
  if (options.secure) parts.push("Secure");
  if (options.domain) parts.push(`Domain=${options.domain}`);
  return parts.join("; ");
}

function authCookieHeaders(
  name: string,
  value: string,
  maxAge: number,
  surfacePolicy: AuthSurfacePolicy,
  options: AuthSessionRouteOptions,
  cookieOptions: { httpOnly?: boolean } = {},
): string[] {
  const firstParty = surfacePolicy.firstPartySession === true;
  const primary = serializeCookie(activeCookieName(name, surfacePolicy), value, {
    maxAge,
    secure: options.cookieSecure,
    sameSite: firstParty ? "Lax" : options.cookieSecure ? "None" : "Lax",
    ...(!firstParty && options.cookieDomain ? { domain: options.cookieDomain } : {}),
    ...(firstParty
      ? { httpOnly: true }
      : cookieOptions.httpOnly !== undefined
        ? { httpOnly: cookieOptions.httpOnly }
        : {}),
  });
  if (!firstParty) return [primary];
  const legacyCookieOptions = {
    maxAge: 0,
    secure: options.cookieSecure,
    sameSite: options.cookieSecure ? ("None" as const) : ("Lax" as const),
    ...(cookieOptions.httpOnly !== undefined ? { httpOnly: cookieOptions.httpOnly } : {}),
  };
  return [
    primary,
    serializeCookie(name, "", legacyCookieOptions),
    ...(options.cookieDomain
      ? [
          serializeCookie(name, "", {
            ...legacyCookieOptions,
            domain: options.cookieDomain,
          }),
        ]
      : []),
  ];
}

function activeCookieName(name: string, surfacePolicy: AuthSurfacePolicy): string {
  if (!surfacePolicy.firstPartySession) return name;
  return name.startsWith("vayada_")
    ? `vayada_fp_${name.slice("vayada_".length)}`
    : `vayada_fp_${name}`;
}

function toAuthError(error: unknown) {
  return {
    error: "auth_session_rejected",
    message: error instanceof Error ? error.message : "AuthKit session was rejected.",
  };
}

function toEmailVerificationError(error: unknown) {
  const mapped = mapWorkOSAuthError(error);
  if (mapped.state === "email_verification_required") {
    return mapped;
  }
  return {
    state: "auth_failed",
    message: "Invalid or expired verification code. Please sign in again.",
  };
}

function passesCsrfCheck(
  request: FastifyRequest,
  options: AuthSessionRouteOptions,
  surfacePolicy: AuthSurfacePolicy,
): boolean {
  const origin = request.headers.origin;
  if (origin && !options.allowedOrigins.includes(origin)) {
    return false;
  }
  const csrfHeader = readCsrfHeader(request);
  if (!csrfHeader) return false;
  const csrfValues = readCookies(request, activeCookieName(CSRF_COOKIE, surfacePolicy));
  return surfacePolicy.firstPartySession
    ? csrfValues.length === 1 && csrfValues[0] === csrfHeader
    : csrfValues.includes(csrfHeader);
}

function readCsrfToken(
  request: FastifyRequest,
  surfacePolicy: AuthSurfacePolicy,
): string | undefined {
  return readCsrfHeader(request) ?? readCookie(request, CSRF_COOKIE, surfacePolicy);
}

function readCsrfHeader(request: FastifyRequest): string | undefined {
  const csrfHeader = request.headers["x-vayada-csrf"];
  return typeof csrfHeader === "string" && csrfHeader.length > 0 ? csrfHeader : undefined;
}
