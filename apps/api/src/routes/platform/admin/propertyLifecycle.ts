import {
  parseCreatePropertyProfileRequest,
  type PlatformPropertyRetireCommand,
  type PlatformPropertyStatusCommand,
} from "@vayada/domain-hotels";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

import type {
  PlatformPropertyLifecycleAudit,
  PlatformPropertyLifecycleCommandRepository,
} from "../../../domains/platformPropertyLifecycleCommandRepository.js";
import { PlatformPropertyLifecycleError } from "../../../domains/platformPropertyLifecycleCommandRepository.js";
import type { PlatformPropertyLifecycleImpactRepository } from "../../../domains/platformPropertyLifecycleImpactRepository.js";
import {
  PlatformPropertyProvisioningError,
  type PlatformPropertyProvisioningRepository,
} from "../../../domains/platformPropertyProvisioningRepository.js";
import { enforceRoutePolicy } from "../../policy.js";

export type PlatformPropertyLifecycleRoutesOptions = {
  impactRepository: PlatformPropertyLifecycleImpactRepository;
  commandRepository: PlatformPropertyLifecycleCommandRepository;
  provisioningRepository: PlatformPropertyProvisioningRepository;
};

const PLATFORM_RESOURCE = {
  product: "platform",
  resourceType: "platform",
  resourceId: "vayada",
  allowedRelationships: ["operator"],
} as const;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export async function registerPlatformPropertyLifecycleRoutes(
  app: FastifyInstance,
  options: PlatformPropertyLifecycleRoutesOptions,
): Promise<void> {
  app.addHook("onClose", async () => {
    await Promise.all([
      options.impactRepository.close(),
      options.commandRepository.close(),
      options.provisioningRepository.close(),
    ]);
  });

  app.post("/properties/provision", async (request, reply) => {
    const context = requireManage(request);
    const body = record(request.body);
    const accountUserId = string(body?.["accountUserId"]);
    const provisioningReference = string(body?.["provisioningReference"]);
    const reason = string(body?.["reason"]);
    const profile = parseCreatePropertyProfileRequest(body?.["profile"]);
    const idempotencyKey = readIdempotencyKey(request, reply);
    if (!idempotencyKey) return reply;
    if (
      !accountUserId ||
      !UUID_PATTERN.test(accountUserId) ||
      !provisioningReference ||
      provisioningReference.length > 200 ||
      !reason ||
      reason.length > 500 ||
      !profile
    ) {
      return reply.status(400).send({
        code: "invalid_property_provision_request",
        detail:
          "Provide one active account, a stable provisioning reference, a reason, and a complete profile.",
      });
    }
    try {
      const result = await options.provisioningRepository.provision({
        accountUserId,
        provisioningReference,
        reason,
        profile,
        idempotencyKey,
        audit: commandAudit(context),
      });
      return reply.status(201).send(result);
    } catch (error) {
      if (error instanceof PlatformPropertyProvisioningError) {
        return reply.status(409).send({ code: error.code, detail: provisioningDetail(error.code) });
      }
      return sendCreateConflict(error, reply);
    }
  });

  app.get("/properties/:propertyId/retirement-impact", async (request, reply) => {
    requireRead(request);
    const propertyId = readPropertyId(request, reply);
    if (!propertyId) return reply;
    const impact = await options.impactRepository.getRetirementImpact(propertyId);
    if (!impact) {
      return reply.status(404).send({ code: "property_not_found", detail: "Property not found." });
    }
    return impact;
  });

  app.patch("/properties/:propertyId/status", async (request, reply) => {
    const context = requireManage(request);
    const propertyId = readPropertyId(request, reply);
    if (!propertyId) return reply;
    const body = parseStatusCommand(request.body);
    const idempotencyKey = readIdempotencyKey(request, reply);
    if (!body || !idempotencyKey) {
      if (!reply.sent) {
        return reply.status(400).send({
          code: "invalid_property_status_command",
          detail: "Provide an expected revision, a valid non-retirement status, and a reason.",
        });
      }
      return reply;
    }
    try {
      return await options.commandRepository.changeStatus({
        propertyId,
        ...body,
        idempotencyKey,
        audit: commandAudit(context),
      });
    } catch (error) {
      return sendLifecycleError(error, reply);
    }
  });

  app.post("/properties/:propertyId/retire", async (request, reply) => {
    const context = requireManage(request);
    const propertyId = readPropertyId(request, reply);
    if (!propertyId) return reply;
    const body = parseRetireCommand(request.body);
    const idempotencyKey = readIdempotencyKey(request, reply);
    if (!body || !idempotencyKey) {
      if (!reply.sent) {
        return reply.status(400).send({
          code: "invalid_property_retirement_command",
          detail: "Provide an expected revision, RETIRE confirmation, and a reason.",
        });
      }
      return reply;
    }
    try {
      return await options.commandRepository.retire({
        propertyId,
        expectedLifecycleRevision: body.expectedLifecycleRevision,
        reason: body.reason,
        idempotencyKey,
        audit: commandAudit(context),
      });
    } catch (error) {
      return sendLifecycleError(error, reply);
    }
  });

  app.delete("/properties/:propertyId", async (request, reply) => {
    requireManage(request);
    const propertyId = readPropertyId(request, reply);
    if (!propertyId) return reply;
    const impact = await options.impactRepository.getRetirementImpact(propertyId);
    if (!impact) {
      return reply.status(404).send({ code: "property_not_found", detail: "Property not found." });
    }
    return reply.status(409).send({
      code: "hard_delete_not_supported",
      detail: "Use the reviewed retirement action; target property history cannot be deleted.",
      impact,
    });
  });
}

function requireRead(request: FastifyRequest) {
  return enforceRoutePolicy(request, {
    permission: "platform.admin.read",
    resource: PLATFORM_RESOURCE,
  });
}

function requireManage(request: FastifyRequest) {
  return enforceRoutePolicy(request, {
    permission: "platform.property.status.manage",
    resource: PLATFORM_RESOURCE,
  });
}

function commandAudit(context: ReturnType<typeof requireManage>): PlatformPropertyLifecycleAudit {
  return {
    actorUserId: context.actor.internalUserId,
    organizationId: context.selectedOrganization.organizationId,
    requestId: context.audit.requestId,
    correlationId: context.audit.correlationId ?? context.audit.requestId,
    requestedAt: context.audit.receivedAt,
  };
}

function readPropertyId(request: FastifyRequest, reply: FastifyReply): string | null {
  const propertyId = string(record(request.params)?.["propertyId"]);
  if (propertyId && UUID_PATTERN.test(propertyId)) return propertyId;
  reply.status(400).send({ code: "invalid_property_id", detail: "Property ID must be a UUID." });
  return null;
}

function readIdempotencyKey(request: FastifyRequest, reply: FastifyReply): string | null {
  const value = request.headers["idempotency-key"];
  const key = typeof value === "string" ? value.trim() : "";
  if (key && key.length <= 200) return key;
  reply.status(400).send({
    code: "invalid_idempotency_key",
    detail: "Idempotency-Key is required and must be at most 200 characters.",
  });
  return null;
}

function parseStatusCommand(value: unknown): PlatformPropertyStatusCommand | null {
  const body = record(value);
  const revision = body?.["expectedLifecycleRevision"];
  const status = body?.["status"];
  const reason = string(body?.["reason"]);
  if (
    !Number.isSafeInteger(revision) ||
    Number(revision) < 1 ||
    !["active", "suspended"].includes(String(status)) ||
    !reason ||
    reason.length > 500
  ) {
    return null;
  }
  return {
    expectedLifecycleRevision: Number(revision),
    status: status as PlatformPropertyStatusCommand["status"],
    reason,
  };
}

function parseRetireCommand(value: unknown): PlatformPropertyRetireCommand | null {
  const body = record(value);
  const revision = body?.["expectedLifecycleRevision"];
  const reason = string(body?.["reason"]);
  if (
    !Number.isSafeInteger(revision) ||
    Number(revision) < 1 ||
    body?.["confirmation"] !== "RETIRE" ||
    !reason ||
    reason.length > 500
  ) {
    return null;
  }
  return { expectedLifecycleRevision: Number(revision), confirmation: "RETIRE", reason };
}

function sendLifecycleError(error: unknown, reply: FastifyReply) {
  if (!(error instanceof PlatformPropertyLifecycleError)) throw error;
  const statusCode =
    error.code === "property_not_found" ? 404 : error.code === "invalid_platform_scope" ? 403 : 409;
  return reply.status(statusCode).send({
    code: error.code,
    detail: lifecycleDetail(error.code),
    ...(error.currentLifecycleRevision
      ? { currentLifecycleRevision: error.currentLifecycleRevision }
      : {}),
    ...(error.impact ? { impact: error.impact } : {}),
  });
}

function sendCreateConflict(error: unknown, reply: FastifyReply) {
  const code = record(error)?.["code"];
  if (
    code === "idempotency_key_conflict" ||
    code === "command_in_progress" ||
    code === "provisioning_reference_conflict"
  ) {
    return reply.status(409).send({ code, detail: lifecycleDetail(String(code)) });
  }
  throw error;
}

function lifecycleDetail(code: string): string {
  return (
    {
      property_not_found: "Property not found.",
      invalid_platform_scope: "The platform operator scope is no longer active.",
      lifecycle_revision_conflict: "The property changed; refresh its impact before retrying.",
      invalid_lifecycle_transition: "That lifecycle transition is not allowed.",
      profile_incomplete: "Complete the canonical property profile before activation.",
      retirement_blocked: "Resolve every retirement blocker before retrying.",
      idempotency_key_conflict: "This idempotency key was already used for another request.",
      command_in_progress: "This lifecycle command is already in progress.",
      provisioning_reference_conflict: "This provisioning reference belongs to another property.",
    }[code] ?? "The property lifecycle command could not be completed."
  );
}

function provisioningDetail(code: PlatformPropertyProvisioningError["code"]): string {
  return code === "account_not_found"
    ? "The intended account has no active hotel-group organization."
    : "The intended account belongs to multiple hotel groups; choose an unambiguous account.";
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function string(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}
