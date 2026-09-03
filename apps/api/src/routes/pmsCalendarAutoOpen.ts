import { UnauthorizedError } from "@vayada/backend-auth";
import { AuthorizationError, type PropertyAccessRepository } from "@vayada/backend-authorization";
import {
  PMS_CALENDAR_AUTO_OPEN_CONTRACT_VERSION,
  calculatePmsCalendarAutoOpenHorizon,
  isPmsCalendarAutoOpenConfiguration,
  isPmsCalendarAutoOpenSetting,
  type PmsCalendarAutoOpenRead,
  type PmsCalendarAutoOpenSettingsPort,
  type PmsCalendarAutoOpenUpdateResult,
} from "@vayada/domain-pms";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

import { enforcePmsPropertyRoutePolicy } from "./pmsPropertyPolicy.js";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
type PropertyParams = { propertyId: string };
type AuthorizedScope = {
  context: Awaited<ReturnType<typeof enforcePmsPropertyRoutePolicy>>;
  propertyId: string;
};

export type PmsCalendarAutoOpenRoutesOptions = {
  settings: PmsCalendarAutoOpenSettingsPort;
  propertyAccessRepository: PropertyAccessRepository;
  allowedOrigins?: string[];
};

export async function registerPmsCalendarAutoOpenRoutes(
  app: FastifyInstance,
  options: PmsCalendarAutoOpenRoutesOptions,
): Promise<void> {
  const authorized = new WeakMap<FastifyRequest, AuthorizedScope>();
  const authorize = async (request: FastifyRequest, reply: FastifyReply) => {
    if (!writeCorsHeaders(request, reply, options.allowedOrigins ?? [])) {
      reply.status(403).send({ code: "origin_not_allowed" });
      return;
    }
    const scope = await authorizeRequest(request, reply, options.propertyAccessRepository);
    if (scope) authorized.set(request, scope);
  };

  app.addHook("onClose", async () => options.settings.close?.());

  app.options("/properties/:propertyId/calendar-auto-open", async (request, reply) => {
    if (!writeCorsHeaders(request, reply, options.allowedOrigins ?? []))
      return reply.status(403).send({ code: "origin_not_allowed" });
    return reply.code(204).send();
  });

  app.get<{ Params: PropertyParams }>(
    "/properties/:propertyId/calendar-auto-open",
    { onRequest: authorize },
    async (request, reply) => {
      const scope = requireAuthorizedScope(authorized, request);
      try {
        const value = await options.settings.findContext(scope.propertyId);
        if (!value) return reply.status(404).send({ code: "property_not_found" });
        if (
          !isPmsCalendarAutoOpenSetting(value.setting) ||
          value.setting.propertyId !== scope.propertyId
        )
          return invalidPortResult(reply);
        const horizon = calculatePmsCalendarAutoOpenHorizon(
          value.setting,
          value.propertyTimeZone,
          new Date(scope.context.audit.receivedAt),
        );
        return reply.status(200).send({
          contractVersion: PMS_CALENDAR_AUTO_OPEN_CONTRACT_VERSION,
          setting: value.setting,
          horizon,
          warnings: value.warnings,
        } satisfies PmsCalendarAutoOpenRead & {
          contractVersion: typeof PMS_CALENDAR_AUTO_OPEN_CONTRACT_VERSION;
        });
      } catch (error) {
        request.log.error({ err: error, propertyId: scope.propertyId }, "Auto-open read failed");
        return reply.status(503).send({ code: "calendar_auto_open_unavailable" });
      }
    },
  );

  app.patch<{ Params: PropertyParams; Body: unknown }>(
    "/properties/:propertyId/calendar-auto-open",
    { onRequest: authorize },
    async (request, reply) => {
      const scope = requireAuthorizedScope(authorized, request);
      const idempotencyKey = readIdempotencyKey(request);
      if (!idempotencyKey) return invalidRequest(reply, "A single Idempotency-Key is required.");
      if (
        !isExactObject(request.body, [
          "expectedRevision",
          "enabled",
          "mode",
          "rollingMonths",
          "fixedEndMonth",
        ])
      )
        return invalidRequest(reply, "The calendar auto-open body is invalid.");
      const configuration = {
        enabled: request.body["enabled"],
        mode: request.body["mode"],
        rollingMonths: request.body["rollingMonths"],
        fixedEndMonth: request.body["fixedEndMonth"],
      };
      const expectedRevision = request.body["expectedRevision"];
      if (
        typeof configuration.enabled !== "boolean" ||
        (configuration.mode !== "rolling" && configuration.mode !== "fixed") ||
        !isPmsCalendarAutoOpenConfiguration(configuration) ||
        !Number.isSafeInteger(expectedRevision) ||
        (expectedRevision as number) < 0 ||
        (expectedRevision as number) >= 2_147_483_647
      )
        return invalidRequest(reply, "The calendar auto-open body is invalid.");

      try {
        const result = await options.settings.update({
          propertyId: scope.propertyId,
          expectedRevision: expectedRevision as number,
          ...configuration,
          idempotencyKey,
          audit: {
            actorUserId: scope.context.actor.internalUserId,
            requestId: scope.context.audit.requestId,
            correlationId: scope.context.audit.correlationId ?? null,
            requestedAt: scope.context.audit.receivedAt,
          },
        });
        if (!result.ok) return sendCommandError(reply, result.error);
        if (
          !isPmsCalendarAutoOpenSetting(result.setting) ||
          result.setting.propertyId !== scope.propertyId ||
          !Number.isFinite(Date.parse(result.evaluatedAt))
        )
          return invalidPortResult(reply);
        const horizon = calculatePmsCalendarAutoOpenHorizon(
          result.setting,
          result.propertyTimeZone,
          new Date(result.evaluatedAt),
        );
        return reply.status(result.outcome === "created" ? 201 : 200).send({
          contractVersion: PMS_CALENDAR_AUTO_OPEN_CONTRACT_VERSION,
          outcome: result.outcome,
          setting: result.setting,
          horizon,
          warnings: [],
          enqueueIntentId: result.enqueueIntentId,
        } satisfies PmsCalendarAutoOpenRead & {
          contractVersion: typeof PMS_CALENDAR_AUTO_OPEN_CONTRACT_VERSION;
          outcome: typeof result.outcome;
          enqueueIntentId: string | null;
        });
      } catch (error) {
        request.log.error({ err: error, propertyId: scope.propertyId }, "Auto-open update failed");
        return reply.status(503).send({ code: "calendar_auto_open_unavailable" });
      }
    },
  );
}

async function authorizeRequest(
  request: FastifyRequest,
  reply: FastifyReply,
  repository: PropertyAccessRepository,
): Promise<AuthorizedScope | null> {
  try {
    const rawPropertyId = (request.params as Partial<PropertyParams>).propertyId;
    if (typeof rawPropertyId !== "string" || !UUID_PATTERN.test(rawPropertyId)) {
      invalidRequest(reply, "The property ID is invalid.");
      return null;
    }
    const propertyId = rawPropertyId.toLowerCase();
    return {
      context: await enforcePmsPropertyRoutePolicy(
        request,
        {
          propertyId,
          permission: "pms.operations.manage",
          allowedRelationships: ["owner", "operator"],
        },
        repository,
      ),
      propertyId,
    };
  } catch (error) {
    if (error instanceof UnauthorizedError) {
      reply.status(401).send({ code: "unauthenticated" });
      return null;
    }
    if (error instanceof AuthorizationError) {
      reply.status(403).send({ code: "forbidden" });
      return null;
    }
    throw error;
  }
}

function requireAuthorizedScope(
  authorized: WeakMap<FastifyRequest, AuthorizedScope>,
  request: FastifyRequest,
): AuthorizedScope {
  const scope = authorized.get(request);
  if (!scope) throw new Error("Calendar auto-open authorization was not resolved before parsing");
  return scope;
}

function readIdempotencyKey(request: FastifyRequest): string | null {
  const occurrences = request.raw.rawHeaders.filter(
    (value, index) => index % 2 === 0 && value.toLowerCase() === "idempotency-key",
  ).length;
  const header = request.headers["idempotency-key"];
  if (occurrences !== 1 || typeof header !== "string") return null;
  const key = header.trim();
  return key.length >= 1 && key.length <= 200 ? key : null;
}

function isExactObject(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const ownKeys = Reflect.ownKeys(value);
  return (
    ownKeys.length === keys.length &&
    ownKeys.every((key) => typeof key === "string") &&
    keys.every((key) => Object.hasOwn(value, key))
  );
}

function sendCommandError(
  reply: FastifyReply,
  error: Extract<PmsCalendarAutoOpenUpdateResult, { ok: false }>["error"],
): FastifyReply {
  if (error.code === "property_not_found") return reply.status(404).send(error);
  if (error.code === "invalid_setting" || error.code === "property_time_zone_invalid")
    return reply.status(422).send(error);
  return reply.status(409).send(error);
}

function invalidRequest(reply: FastifyReply, message: string): FastifyReply {
  return reply.status(400).send({ code: "invalid_request", message });
}

function invalidPortResult(reply: FastifyReply): FastifyReply {
  return reply.status(500).send({ code: "calendar_auto_open_port_contract_violation" });
}

function writeCorsHeaders(
  request: FastifyRequest,
  reply: FastifyReply,
  allowedOrigins: string[],
): boolean {
  const origin = request.headers.origin;
  if (!origin) return true;
  if (!allowedOrigins.includes(origin)) return false;
  reply
    .header("Access-Control-Allow-Origin", origin)
    .header("Access-Control-Allow-Headers", "authorization,content-type,idempotency-key,x-hotel-id")
    .header("Access-Control-Allow-Methods", "GET,PATCH,OPTIONS")
    .header("Vary", "Origin");
  return true;
}
