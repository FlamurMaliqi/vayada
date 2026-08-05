import { UnauthorizedError } from "@vayada/backend-auth";
import { AuthorizationError } from "@vayada/backend-authorization";
import {
  PMS_OPERATING_CALENDAR_AUTHORIZATION,
  createPmsOperatingCalendarSourceRevision,
  parsePmsOperatingCalendarCommandResult,
  parsePmsOperatingCalendarConfigurationSnapshot,
  parsePmsOperatingCalendarCurrentReadResult,
  parsePmsOperatingCalendarImpactPreviewRequest,
  parsePmsOperatingCalendarImpactPreviewResult,
  parsePmsOperatingCalendarUpsertRequest,
  parsePreviewPmsOperatingCalendarImpactCommand,
  parseUpsertPmsOperatingCalendarCommand,
  serializePmsOperatingCalendarProposalFingerprint,
  type PmsOperatingCalendarCanonicalTimeZoneRegistry,
  type PmsOperatingCalendarCommandAudit,
  type PmsOperatingCalendarCommandError,
  type PmsOperatingCalendarCommandPort,
  type PmsOperatingCalendarCommandResponse,
  type PmsOperatingCalendarImpactPreviewError,
  type PmsOperatingCalendarImpactPreviewPort,
  type PmsOperatingCalendarReadPort,
  type UpsertPmsOperatingCalendarCommand,
} from "@vayada/domain-pms";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { createHash } from "node:crypto";

import { enforceRoutePolicy } from "./policy.js";

type PropertyParams = { propertyId: string };
type RevisionParams = PropertyParams & { calendarRevision: string };
type AuthorizedScope = {
  context: ReturnType<typeof enforceRoutePolicy>;
  propertyId: string;
};

export type PmsOperatingCalendarRoutesOptions = {
  commandPort: PmsOperatingCalendarCommandPort;
  impactPreviewPort: PmsOperatingCalendarImpactPreviewPort;
  readPort: PmsOperatingCalendarReadPort;
  timeZoneRegistry: PmsOperatingCalendarCanonicalTimeZoneRegistry;
};

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const REVISION_PATTERN = /^[1-9][0-9]*$/;
const MAX_REVISION = 2_147_483_647;
/** Unmounted ONB-21 owner adapter. PMS API composition remains separately coordinated. */
export async function registerPmsOperatingCalendarRoutes(
  app: FastifyInstance,
  options: PmsOperatingCalendarRoutesOptions,
): Promise<void> {
  const authorized = new WeakMap<FastifyRequest, AuthorizedScope>();
  const authorize = async (request: FastifyRequest, reply: FastifyReply) => {
    const scope = authorizeRequest(request, reply);
    if (scope) authorized.set(request, scope);
  };

  app.post<{ Params: PropertyParams; Body: unknown }>(
    "/properties/:propertyId/operating-calendar/impact-preview",
    { onRequest: authorize },
    async (request, reply) => {
      const scope = requireAuthorizedScope(authorized, request);
      const body = parsePmsOperatingCalendarImpactPreviewRequest(request.body);
      if (!body) {
        return invalidRequest(reply, "The operating calendar impact preview body is invalid.");
      }
      const command = parsePreviewPmsOperatingCalendarImpactCommand({
        ...body,
        organizationId: scope.context.selectedOrganization.organizationId,
        propertyId: scope.propertyId,
        audit: commandAudit(scope.context),
      });
      if (!command) {
        return invalidRequest(reply, "The operating calendar impact preview body is invalid.");
      }
      const result = parsePmsOperatingCalendarImpactPreviewResult(
        await options.impactPreviewPort.previewOperatingCalendarImpact(command),
      );
      const expectedFingerprint = createHash("sha256")
        .update(serializePmsOperatingCalendarProposalFingerprint(command), "utf8")
        .digest("hex");
      if (
        !result ||
        (result.ok &&
          (result.preview.propertyId !== scope.propertyId ||
            result.preview.proposalFingerprint !== expectedFingerprint))
      ) {
        return invalidPortResult(reply);
      }
      return result.ok
        ? reply.status(200).send(result.preview)
        : sendImpactPreviewError(reply, result.error);
    },
  );

  app.put<{ Params: PropertyParams; Body: unknown }>(
    "/properties/:propertyId/operating-calendar",
    { onRequest: authorize },
    async (request, reply) => {
      const scope = requireAuthorizedScope(authorized, request);
      const idempotencyKey = readIdempotencyKey(request);
      if (!idempotencyKey) return invalidRequest(reply, "A single Idempotency-Key is required.");
      const body = parsePmsOperatingCalendarUpsertRequest(request.body);
      if (!body) {
        return invalidRequest(reply, "The operating calendar body is invalid.");
      }
      const command = parseUpsertPmsOperatingCalendarCommand({
        ...body,
        organizationId: scope.context.selectedOrganization.organizationId,
        propertyId: scope.propertyId,
        idempotencyKey,
        audit: commandAudit(scope.context),
      });
      if (!command) return invalidRequest(reply, "The operating calendar body is invalid.");

      const result = parsePmsOperatingCalendarCommandResult(
        await options.commandPort.upsertOperatingCalendar(command),
        options.timeZoneRegistry,
      );
      if (!result || (result.ok && !matchesCommand(result.response, command))) {
        return invalidPortResult(reply);
      }
      return result.ok
        ? reply.status(result.response.outcome === "created" ? 201 : 200).send(result.response)
        : sendCommandError(reply, result.error);
    },
  );

  app.get<{ Params: PropertyParams }>(
    "/properties/:propertyId/operating-calendar",
    { onRequest: authorize },
    async (request, reply) => {
      const scope = requireAuthorizedScope(authorized, request);
      const raw = await options.readPort.getCurrentOperatingCalendarConfiguration(scope.propertyId);
      if (!raw) return reply.status(404).send({ code: "operating_calendar_not_configured" });
      const result = parsePmsOperatingCalendarCurrentReadResult(raw, options.timeZoneRegistry);
      return result && result.configuration.propertyId === scope.propertyId
        ? reply.status(200).send(result)
        : invalidPortResult(reply);
    },
  );

  app.get<{ Params: RevisionParams }>(
    "/properties/:propertyId/operating-calendar/revisions/:calendarRevision",
    { onRequest: authorize },
    async (request, reply) => {
      const scope = requireAuthorizedScope(authorized, request);
      const revision = readCalendarRevision(request.params.calendarRevision);
      if (!revision) return invalidRequest(reply, "The calendar revision is invalid.");
      const source = createPmsOperatingCalendarSourceRevision(scope.propertyId, revision);
      const raw = await options.readPort.getOperatingCalendarConfigurationBySource(source);
      if (!raw) return reply.status(404).send({ code: "operating_calendar_source_not_found" });
      const configuration = parsePmsOperatingCalendarConfigurationSnapshot(
        raw,
        options.timeZoneRegistry,
      );
      return configuration &&
        configuration.propertyId === scope.propertyId &&
        configuration.calendarRevision === revision
        ? reply.status(200).send(configuration)
        : invalidPortResult(reply);
    },
  );
}

function authorizeRequest(request: FastifyRequest, reply: FastifyReply): AuthorizedScope | null {
  const permission =
    request.method === "GET"
      ? PMS_OPERATING_CALENDAR_AUTHORIZATION.readPermission
      : PMS_OPERATING_CALENDAR_AUTHORIZATION.permission;
  try {
    const baseContext = enforceRoutePolicy(request, { permission });
    if (baseContext.selectedOrganization.kind !== "hotel_group") {
      reply.status(403).send({ code: "invalid_organization_scope" });
      return null;
    }
    const rawPropertyId = (request.params as Partial<PropertyParams>).propertyId;
    if (typeof rawPropertyId !== "string" || !UUID_PATTERN.test(rawPropertyId)) {
      invalidRequest(reply, "The property ID is invalid.");
      return null;
    }
    const propertyId = rawPropertyId.toLowerCase();
    const resource = {
      product: PMS_OPERATING_CALENDAR_AUTHORIZATION.resource.product,
      resourceType: PMS_OPERATING_CALENDAR_AUTHORIZATION.resource.resourceType,
      resourceId: propertyId,
    } as const;
    const context = enforceRoutePolicy(request, {
      permission,
      entitlement: { ...PMS_OPERATING_CALENDAR_AUTHORIZATION.entitlement, resource },
      resource: {
        ...resource,
        allowedRelationships: PMS_OPERATING_CALENDAR_AUTHORIZATION.resource.allowedRelationships,
      },
    });
    return { context, propertyId };
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

function matchesCommand(
  response: PmsOperatingCalendarCommandResponse,
  command: UpsertPmsOperatingCalendarCommand,
): boolean {
  const configuration = response.configuration;
  if (
    response.outcome !== (command.expectedCalendarRevision === 0 ? "created" : "updated") ||
    configuration.propertyId !== command.propertyId ||
    configuration.calendarRevision !== command.expectedCalendarRevision + 1 ||
    configuration.sourceInputs.propertyProfile.entityId !== command.propertyId ||
    configuration.sourceInputs.propertyProfile.revision !==
      `profile:${command.expectedPropertyProfileRevision}` ||
    configuration.defaultMinimumStayNights !== command.defaultMinimumStayNights ||
    JSON.stringify(configuration.schedule) !== JSON.stringify(command.schedule) ||
    configuration.sourceInputs.roomBindings.length !== command.roomTypeLimits.length
  ) {
    return false;
  }
  return configuration.sourceInputs.roomBindings.every((binding, index) => {
    const expected = command.roomTypeLimits[index];
    return (
      expected !== undefined &&
      binding.roomTypeId === expected.roomTypeId &&
      binding.sourceRoomFactsRevision === expected.expectedRoomFactsRevision &&
      binding.sourceRoomUnitsRevision === expected.expectedRoomUnitsRevision &&
      binding.startingSellableLimitCount === expected.startingSellableLimitCount
    );
  });
}

function commandAudit(context: AuthorizedScope["context"]): PmsOperatingCalendarCommandAudit {
  return {
    actor: { kind: "user", userId: context.actor.internalUserId },
    requestId: context.audit.requestId,
    correlationId: context.audit.correlationId ?? null,
    requestedAt: context.audit.receivedAt,
  };
}

function requireAuthorizedScope(
  authorized: WeakMap<FastifyRequest, AuthorizedScope>,
  request: FastifyRequest,
): AuthorizedScope {
  const scope = authorized.get(request);
  if (!scope)
    throw new Error("PMS operating-calendar authorization was not resolved before parsing");
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

function readCalendarRevision(value: string): number | null {
  if (!REVISION_PATTERN.test(value)) return null;
  const revision = Number(value);
  return Number.isSafeInteger(revision) && revision <= MAX_REVISION ? revision : null;
}

function sendCommandError(
  reply: FastifyReply,
  error: PmsOperatingCalendarCommandError,
): FastifyReply {
  if (error.code === "setup_scope_unavailable") return reply.status(404).send(error);
  if (
    error.code === "property_timezone_missing" ||
    error.code === "property_timezone_invalid" ||
    error.code === "active_room_type_set_empty" ||
    error.code === "room_capacity_unavailable" ||
    error.code === "starting_sellable_limit_exceeds_capacity"
  ) {
    return reply.status(422).send(error);
  }
  return reply.status(409).send(error);
}

function sendImpactPreviewError(
  reply: FastifyReply,
  error: PmsOperatingCalendarImpactPreviewError,
): FastifyReply {
  if (error.code === "setup_scope_unavailable") return reply.status(404).send(error);
  if (
    error.code === "property_timezone_missing" ||
    error.code === "property_timezone_invalid" ||
    error.code === "active_room_type_set_empty" ||
    error.code === "room_capacity_unavailable" ||
    error.code === "starting_sellable_limit_exceeds_capacity"
  ) {
    return reply.status(422).send(error);
  }
  return reply.status(409).send(error);
}

function invalidRequest(reply: FastifyReply, message: string): FastifyReply {
  return reply.status(400).send({ code: "invalid_request", message });
}

function invalidPortResult(reply: FastifyReply): FastifyReply {
  return reply.status(500).send({ code: "pms_operating_calendar_port_contract_violation" });
}
