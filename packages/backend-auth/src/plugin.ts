import { randomUUID } from "node:crypto";
import type { FastifyInstance, FastifyPluginAsync, FastifyRequest } from "fastify";
import fp from "fastify-plugin";

import { AuthError, UnauthorizedError } from "./errors.js";
import { type IdentityRepository } from "./repository.js";
import { type AuthorizationResolver, resolveRequestContext } from "./resolve.js";
import { type RequestContext } from "./types.js";
import { type TokenVerifier, extractBearerToken } from "./verify.js";

const CONTEXT_DECORATION = "authContext";

class AuthInfrastructureError extends Error {
  readonly statusCode = 500;

  constructor(cause: unknown) {
    super("Authentication service is temporarily unavailable.", { cause });
    this.name = "AuthInfrastructureError";
  }
}

export type BackendAuthPluginOptions = {
  verifier: TokenVerifier;
  repository: IdentityRepository;
  authorizationResolver?: AuthorizationResolver;
  /** Default locale when not specified by Accept-Language. Defaults to "en". */
  defaultLocale?: string;
  /** Default currency. Defaults to "USD". */
  defaultCurrency?: string;
};

declare module "fastify" {
  interface FastifyRequest {
    /** Resolved RequestContext for authenticated requests. Null on public routes. */
    authContext: RequestContext | null;
  }
}

/**
 * Fastify plugin that resolves a WorkOS access token into a RequestContext
 * and attaches it to every request as `request.authContext`.
 *
 * Only AuthErrors are swallowed. Infrastructure failures (DB, network) become
 * sanitized 500s rather than leaking storage or provider details.
 * Routes call requireAuthContext(request) to enforce authentication.
 */
const backendAuthPluginFn: FastifyPluginAsync<BackendAuthPluginOptions> = async (
  app: FastifyInstance,
  options: BackendAuthPluginOptions,
) => {
  app.decorateRequest(CONTEXT_DECORATION, null);

  app.addHook("onRequest", async (request: FastifyRequest) => {
    const token = extractBearerToken(request.headers.authorization);
    if (!token) return;

    try {
      const session = await options.verifier(token);
      const context = await resolveRequestContext(session, options.repository, {
        requestId: randomUUID(),
        locale: options.defaultLocale,
        currency: options.defaultCurrency,
        source: "api",
        sourceIp: request.ip,
        userAgent: request.headers["user-agent"],
        authorizationResolver: options.authorizationResolver,
      });
      request.authContext = context;
    } catch (error) {
      if (!(error instanceof AuthError)) throw new AuthInfrastructureError(error);
      // AuthError means the token or identity is invalid/missing.
      // authContext stays null and requireAuthContext surfaces the 401.
    }
  });
};

export const backendAuthPlugin = fp(backendAuthPluginFn, {
  fastify: "5",
  name: "backend-auth",
});

/**
 * Returns the resolved RequestContext for an authenticated request.
 * Throws UnauthorizedError (statusCode 401) when the request has no context —
 * Fastify's default error handler maps statusCode to the HTTP response status.
 *
 * Call this at the start of any route handler that requires authentication.
 */
export function requireAuthContext(request: FastifyRequest): RequestContext {
  const ctx = request.authContext;
  if (!ctx) {
    throw new UnauthorizedError();
  }
  return ctx;
}

export { requireAuthContext as getAuthContext };
