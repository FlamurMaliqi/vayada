import type {
  AcceptFinanceOnlineCardExecutionEvidenceCommand,
  FinancePlatformOnlineCardExecutionEvidenceRepository,
  RevokeFinanceOnlineCardExecutionEvidenceCommand,
} from "@vayada/domain-finance";
import type { RequestContext } from "@vayada/backend-auth";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

import { authorizePlatformFinance } from "./financePlatformAffiliatePayoutRoutes.js";

type PropertyParams = { propertyId: string };
type EvidenceParams = PropertyParams & { evidenceId: string };
type AcceptBody = {
  commandId?: unknown;
  idempotencyKey?: unknown;
  expectedCardCapabilityRevision?: unknown;
  expectedPropertyReadinessRevision?: unknown;
  evidenceFingerprintHash?: unknown;
  executedAt?: unknown;
};
type RevokeBody = { commandId?: unknown; idempotencyKey?: unknown };

export async function registerFinancePlatformOnlineCardExecutionEvidenceRoutes(
  app: FastifyInstance,
  options: { repository: Partial<FinancePlatformOnlineCardExecutionEvidenceRepository> },
): Promise<void> {
  app.post<{ Params: PropertyParams; Body: AcceptBody }>(
    "/finance/platform/properties/:propertyId/online-card-execution-evidence",
    async (request, reply) => {
      const context = authorizePlatformFinance(request, reply, "manage");
      if (!context) return reply;
      if (!options.repository.acceptOnlineCardExecutionEvidence) return unavailable(reply);
      const command = acceptCommand(request, context);
      if (!command) return invalid(reply);
      return sendResult(reply, await options.repository.acceptOnlineCardExecutionEvidence(command));
    },
  );

  app.post<{ Params: EvidenceParams; Body: RevokeBody }>(
    "/finance/platform/properties/:propertyId/online-card-execution-evidence/:evidenceId/revoke",
    async (request, reply) => {
      const context = authorizePlatformFinance(request, reply, "manage");
      if (!context) return reply;
      if (!options.repository.revokeOnlineCardExecutionEvidence) return unavailable(reply);
      const command = revokeCommand(request, context);
      if (!command) return invalid(reply);
      return sendResult(reply, await options.repository.revokeOnlineCardExecutionEvidence(command));
    },
  );
}

function acceptCommand(
  request: FastifyRequest<{ Params: PropertyParams; Body: AcceptBody }>,
  context: RequestContext,
): AcceptFinanceOnlineCardExecutionEvidenceCommand | null {
  const body = request.body;
  if (
    !plainRecord(body) ||
    Object.keys(body).some(
      (key) =>
        ![
          "commandId",
          "idempotencyKey",
          "expectedCardCapabilityRevision",
          "expectedPropertyReadinessRevision",
          "evidenceFingerprintHash",
          "executedAt",
        ].includes(key),
    )
  ) {
    return null;
  }
  const commandId = trimmed(body.commandId);
  const idempotencyKey = trimmed(body.idempotencyKey);
  const evidenceFingerprintHash = trimmed(body.evidenceFingerprintHash);
  const executedAt = isoDate(body.executedAt);
  if (
    !uuid(request.params.propertyId) ||
    !uuid(commandId) ||
    !uuid(idempotencyKey) ||
    !positiveInteger(body.expectedCardCapabilityRevision) ||
    !positiveInteger(body.expectedPropertyReadinessRevision) ||
    !evidenceFingerprintHash ||
    !/^[0-9a-f]{64}$/.test(evidenceFingerprintHash) ||
    !executedAt ||
    Date.parse(executedAt) > Date.parse(context.audit.receivedAt)
  ) {
    return null;
  }
  return {
    commandType: "finance.online_card_execution_evidence.accept",
    commandId,
    idempotencyKey,
    propertyId: request.params.propertyId.toLowerCase(),
    audit: audit(context, "Accept ONB-25A online-card execution evidence"),
    payload: {
      expectedCardCapabilityRevision: body.expectedCardCapabilityRevision as number,
      expectedPropertyReadinessRevision: body.expectedPropertyReadinessRevision as number,
      evidenceFingerprintHash,
      executedAt,
    },
  };
}

function revokeCommand(
  request: FastifyRequest<{ Params: EvidenceParams; Body: RevokeBody }>,
  context: RequestContext,
): RevokeFinanceOnlineCardExecutionEvidenceCommand | null {
  const body = request.body;
  if (
    !plainRecord(body) ||
    Object.keys(body).some((key) => !["commandId", "idempotencyKey"].includes(key)) ||
    !uuid(request.params.propertyId) ||
    !uuid(request.params.evidenceId)
  ) {
    return null;
  }
  const commandId = trimmed(body.commandId);
  const idempotencyKey = trimmed(body.idempotencyKey);
  if (!uuid(commandId) || !uuid(idempotencyKey)) return null;
  return {
    commandType: "finance.online_card_execution_evidence.revoke",
    commandId,
    idempotencyKey,
    propertyId: request.params.propertyId.toLowerCase(),
    audit: audit(context, "Revoke ONB-25A online-card execution evidence"),
    payload: { evidenceId: request.params.evidenceId.toLowerCase() },
  };
}

function audit(context: RequestContext, reason: string) {
  return {
    actor: {
      kind: "user" as const,
      userId: context.actor.internalUserId,
      organizationId: context.selectedOrganization.organizationId,
    },
    requestId: context.audit.requestId,
    ...(context.audit.correlationId ? { correlationId: context.audit.correlationId } : {}),
    reason,
    requestedAt: context.audit.receivedAt,
  };
}

function sendResult(
  reply: FastifyReply,
  result: Awaited<
    ReturnType<
      FinancePlatformOnlineCardExecutionEvidenceRepository["acceptOnlineCardExecutionEvidence"]
    >
  >,
) {
  if (result.ok) return result.response;
  return reply.code(result.statusCode).send({
    statusCode: result.statusCode,
    code: result.code,
    category:
      result.statusCode === 400
        ? "validation"
        : result.statusCode === 404
          ? "not_found"
          : result.statusCode === 409
            ? "conflict"
            : "write_model",
    message: result.message,
  });
}

function unavailable(reply: FastifyReply) {
  return reply.code(501).send({
    statusCode: 501,
    code: "write_unavailable",
    category: "write_model",
    message: "Online-card execution evidence writes are not configured.",
  });
}

function invalid(reply: FastifyReply) {
  return reply.code(400).send({
    statusCode: 400,
    code: "invalid_body",
    category: "validation",
    message: "Online-card execution evidence is invalid.",
  });
}

function plainRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function trimmed(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 && value === value.trim() ? value : null;
}

function positiveInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 1 && Number(value) <= 2_147_483_647;
}

function isoDate(value: unknown): string | null {
  if (
    typeof value !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(value) ||
    Number.isNaN(Date.parse(value))
  ) {
    return null;
  }
  return new Date(value).toISOString();
}

function uuid(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
  );
}
