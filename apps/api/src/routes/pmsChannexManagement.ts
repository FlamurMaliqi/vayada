import {
  CHANNEX_MANAGEMENT_OPERATION_TYPES,
  type ChannexManagementCapabilityModes,
  type ChannexManagementOperationType,
} from "@vayada/domain-pms-channex";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

import type { PmsChannexManagementCommandPort } from "../domains/pmsChannexManagementCommands.js";
import type { PmsChannexIframeSessionPort } from "../domains/pmsChannexIframeSession.js";
import type { PmsChannexManagementReadRepository } from "../domains/pmsChannexManagementReadModel.js";
import { enforceRoutePolicy } from "./policy.js";

export type PmsChannexManagementRoutesOptions = {
  repository: PmsChannexManagementReadRepository;
  capabilityModes: ChannexManagementCapabilityModes;
  commandPort?: PmsChannexManagementCommandPort;
  iframeSessionPort?: PmsChannexIframeSessionPort;
};

export async function registerPmsChannexManagementRoutes(
  app: FastifyInstance,
  options: PmsChannexManagementRoutesOptions,
): Promise<void> {
  app.addHook("onClose", async () => {
    await options.repository.close?.();
    await options.commandPort?.close?.();
    await options.iframeSessionPort?.close?.();
  });

  app.get<{ Params: { propertyId: string } }>(
    "/properties/:propertyId/channex",
    async (request) => {
      const { propertyId } = request.params;
      enforcePmsChannexPolicy(request, propertyId, "pms.operations.read");
      return options.repository.getSnapshot(propertyId, options.capabilityModes);
    },
  );

  app.get<{ Params: { propertyId: string; operationId: string } }>(
    "/properties/:propertyId/channex/operations/:operationId",
    async (request, reply) => {
      const { propertyId, operationId } = request.params;
      enforcePmsChannexPolicy(request, propertyId, "pms.operations.read");
      const operation = await options.repository.getOperation(propertyId, operationId);
      return operation ?? reply.code(404).send({ code: "operation_not_found" });
    },
  );

  app.post<{ Params: { propertyId: string }; Body: unknown }>(
    "/properties/:propertyId/channex/commands",
    async (request, reply) => {
      const context = enforcePmsChannexPolicy(
        request,
        request.params.propertyId,
        "pms.operations.manage",
      );
      const input = parseCommand(request.body);
      if (!input) return reply.code(400).send({ code: "invalid_channex_command" });
      if (!isMutating(options.capabilityModes, input.operationType)) {
        return reply.code(409).send({ code: "channex_capability_not_mutating" });
      }
      if (input.operationType === "setup_google") {
        const snapshot = await options.repository.getSnapshot(
          request.params.propertyId,
          options.capabilityModes,
        );
        if (!googlePreflightPassed(snapshot.googleFreeBookingLinks.preflight)) {
          return reply.code(409).send({ code: "google_free_booking_links_not_ready" });
        }
        if (
          !snapshot.googleFreeBookingLinks.businessProfileConfirmedAt &&
          !input.businessProfileConfirmed
        ) {
          return reply.code(409).send({ code: "google_business_profile_confirmation_required" });
        }
      }
      if (!options.commandPort) {
        return reply.code(503).send({ code: "channex_commands_unavailable" });
      }
      return sendCommandResult(
        reply,
        await options.commandPort.enqueue(context, request.params.propertyId, input),
      );
    },
  );

  app.put<{ Params: { propertyId: string }; Body: unknown }>(
    "/properties/:propertyId/channex/markups",
    async (request, reply) => {
      const context = enforcePmsChannexPolicy(
        request,
        request.params.propertyId,
        "pms.operations.manage",
      );
      const input = parseMarkups(request.body);
      if (!input) return reply.code(400).send({ code: "invalid_channex_markups" });
      if (options.capabilityModes.markups !== "mutating") {
        return reply.code(409).send({ code: "channex_capability_not_mutating" });
      }
      if (!options.commandPort) {
        return reply.code(503).send({ code: "channex_commands_unavailable" });
      }
      return sendCommandResult(
        reply,
        await options.commandPort.enqueue(context, request.params.propertyId, {
          ...input,
          operationType: "update_markups",
        }),
      );
    },
  );

  app.post<{ Params: { propertyId: string }; Body: unknown }>(
    "/properties/:propertyId/channex/iframe-session",
    async (request, reply) => {
      const context = enforcePmsChannexPolicy(
        request,
        request.params.propertyId,
        "pms.operations.manage",
      );
      if (options.capabilityModes.iframe !== "mutating") {
        return reply.code(409).send({ code: "channex_capability_not_mutating" });
      }
      if (!options.iframeSessionPort) {
        return reply.code(503).send({ code: "channex_iframe_unavailable" });
      }
      const iframeOptions = parseIframeOptions(request.body);
      if (!iframeOptions) return reply.code(400).send({ code: "invalid_channex_iframe_scope" });
      if (iframeOptions.channel === "google_hotel") {
        const snapshot = await options.repository.getSnapshot(
          request.params.propertyId,
          options.capabilityModes,
        );
        if (!googlePreflightPassed(snapshot.googleFreeBookingLinks.preflight)) {
          return reply.code(409).send({ code: "google_free_booking_links_not_ready" });
        }
        if (
          !snapshot.googleFreeBookingLinks.businessProfileConfirmedAt &&
          !iframeOptions.businessProfileConfirmed
        ) {
          return reply.code(409).send({ code: "google_business_profile_confirmation_required" });
        }
      }
      const result = await options.iframeSessionPort.createSession(
        context,
        request.params.propertyId,
        { channel: iframeOptions.channel },
      );
      if (result.ok) return result;
      return reply.code(result.code === "connection_required" ? 409 : 502).send(result);
    },
  );
}

function parseIframeOptions(
  body: unknown,
): { channel?: "google_hotel"; businessProfileConfirmed?: boolean } | null {
  if (body === undefined || body === null) return {};
  if (!body || typeof body !== "object" || Array.isArray(body)) return null;
  const channel = (body as Record<string, unknown>).channel;
  const businessProfileConfirmed = (body as Record<string, unknown>).businessProfileConfirmed;
  if (businessProfileConfirmed !== undefined && typeof businessProfileConfirmed !== "boolean") {
    return null;
  }
  return channel === undefined
    ? {}
    : channel === "google_hotel"
      ? { channel, businessProfileConfirmed }
      : null;
}

function parseCommand(body: unknown) {
  if (!body || typeof body !== "object") return null;
  const value = body as Record<string, unknown>;
  if (!isCommandIdentity(value.commandId, value.idempotencyKey)) return null;
  if (
    typeof value.operationType !== "string" ||
    value.operationType === "update_markups" ||
    !CHANNEX_MANAGEMENT_OPERATION_TYPES.includes(
      value.operationType as ChannexManagementOperationType,
    )
  ) {
    return null;
  }
  return {
    commandId: value.commandId as string,
    idempotencyKey: value.idempotencyKey as string,
    operationType: value.operationType as Exclude<ChannexManagementOperationType, "update_markups">,
    ...(value.operationType === "setup_google"
      ? { businessProfileConfirmed: value.businessProfileConfirmed === true }
      : {}),
  };
}

function googlePreflightPassed(preflight: {
  propertyName: boolean;
  address: boolean;
  phone: boolean;
  bookingEngine: boolean;
  activeRatesAndAvailability: boolean;
}) {
  return Object.values(preflight).every(Boolean);
}

function parseMarkups(body: unknown) {
  if (!body || typeof body !== "object") return null;
  const value = body as Record<string, unknown>;
  if (!isCommandIdentity(value.commandId, value.idempotencyKey) || !Array.isArray(value.markups)) {
    return null;
  }
  const markups = value.markups.map((item) => {
    if (!item || typeof item !== "object") return null;
    const markup = item as Record<string, unknown>;
    return (markup.channel === "booking_com" || markup.channel === "airbnb") &&
      typeof markup.markupPercent === "number" &&
      markup.markupPercent >= -50 &&
      markup.markupPercent <= 200
      ? { channel: markup.channel, markupPercent: markup.markupPercent }
      : null;
  });
  if (markups.some((item) => item === null)) return null;
  return {
    commandId: value.commandId as string,
    idempotencyKey: value.idempotencyKey as string,
    markups: markups as Array<{ channel: string; markupPercent: number }>,
  };
}

function isCommandIdentity(commandId: unknown, idempotencyKey: unknown) {
  return (
    typeof commandId === "string" &&
    commandId.trim().length > 0 &&
    typeof idempotencyKey === "string" &&
    idempotencyKey.trim().length > 0
  );
}

function isMutating(modes: ChannexManagementCapabilityModes, type: ChannexManagementOperationType) {
  const capability = {
    enable: "connection",
    disable: "connection",
    provision: "provisioning",
    setup_google: "provisioning",
    sync_ari: "ariSync",
    sync_bookings: "bookingSync",
    update_markups: "markups",
    install_messaging: "messaging",
  }[type] as keyof ChannexManagementCapabilityModes;
  return modes[capability] === "mutating";
}

function sendCommandResult(
  reply: FastifyReply,
  result: Awaited<ReturnType<PmsChannexManagementCommandPort["enqueue"]>>,
) {
  if (result.ok) return reply.code(202).send(result.operation);
  return reply.code(409).send({ code: result.code, message: result.message });
}

export function enforcePmsChannexPolicy(
  request: FastifyRequest,
  propertyId: string,
  permission: "pms.operations.read" | "pms.operations.manage",
) {
  return enforceRoutePolicy(request, {
    permission,
    entitlement: {
      product: "pms",
      key: "property-management",
      resource: { product: "pms", resourceType: "pms_property", resourceId: propertyId },
    },
    resource: {
      product: "pms",
      resourceType: "pms_property",
      resourceId: propertyId,
      allowedRelationships: ["owner", "operator", "front_desk"],
    },
  });
}
