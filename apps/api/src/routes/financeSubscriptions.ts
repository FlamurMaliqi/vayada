import { requireAuthContext } from "@vayada/backend-auth";
import {
  toFinancePlanStatusResponse,
  type FinanceCommandAudit,
  type FinanceSubscriptionCommandContext,
  type FinanceSubscriptionService,
} from "@vayada/domain-finance";
import type { FastifyInstance, FastifyRequest } from "fastify";

import { enforceFinancePropertyReadPolicy, enforceFinancePropertyWritePolicy } from "./finance.js";

type PropertyParams = { propertyId: string };
type CommandBody = { commandId?: unknown; idempotencyKey?: unknown };

export async function registerFinanceSubscriptionRoutes(
  app: FastifyInstance,
  options: { service: FinanceSubscriptionService },
): Promise<void> {
  app.addHook("onClose", async () => options.service.close?.());

  app.get<{ Params: PropertyParams }>(
    "/finance/properties/:propertyId/plan-status",
    async (request, reply) => {
      const { propertyId } = request.params;
      if (!enforceFinancePropertyReadPolicy(request, reply, propertyId)) return reply;
      return toFinancePlanStatusResponse(await options.service.getPlanStatus(propertyId));
    },
  );

  app.post<{ Params: PropertyParams; Body: CommandBody }>(
    "/finance/properties/:propertyId/select-commission",
    async (request, reply) => {
      const { propertyId } = request.params;
      if (!enforceFinancePropertyWritePolicy(request, reply, propertyId)) return reply;
      const command = subscriptionCommand(request, propertyId, "Select Commission Plan");
      if (!command) {
        return reply.code(400).send({
          code: "invalid_command",
          message: "commandId and idempotencyKey are required.",
        });
      }
      const result = await options.service.selectCommissionPlan(command);
      if (!result.ok) return reply.code(result.statusCode).send(result);
      return reply.code(result.status === "created" ? 201 : 200).send({
        contractVersion: "finance-subscriptions.v1",
        propertyId,
        planStatus: toFinancePlanStatusResponse(result.value.planStatus).planStatus,
      });
    },
  );

  app.post<{ Params: PropertyParams; Body: CommandBody }>(
    "/finance/properties/:propertyId/fixed-plan/checkout",
    async (request, reply) => {
      const { propertyId } = request.params;
      if (!enforceFinancePropertyWritePolicy(request, reply, propertyId)) return reply;
      const command = subscriptionCommand(request, propertyId, "Start Fixed Plan checkout");
      const customerEmail = email(requireAuthContext(request).actor.email);
      if (!command || !customerEmail) {
        return reply.code(400).send({
          code: "invalid_command",
          message: "commandId and idempotencyKey are required.",
        });
      }
      const result = await options.service.createFixedPlanCheckout({ ...command, customerEmail });
      if (!result.ok) return reply.code(result.statusCode).send(result);
      return reply.code(result.status === "created" ? 201 : 200).send({
        contractVersion: "finance-subscriptions.v1",
        propertyId,
        checkout: result.value,
      });
    },
  );

  app.post<{ Params: PropertyParams; Body: CommandBody }>(
    "/finance/properties/:propertyId/customer-portal",
    async (request, reply) => {
      const { propertyId } = request.params;
      if (!enforceFinancePropertyWritePolicy(request, reply, propertyId)) return reply;
      const command = subscriptionCommand(request, propertyId, "Open Stripe Customer Portal");
      if (!command) {
        return reply.code(400).send({
          code: "invalid_command",
          message: "commandId and idempotencyKey are required.",
        });
      }
      const result = await options.service.openCustomerPortal(command);
      if (!result.ok) return reply.code(result.statusCode).send(result);
      return {
        contractVersion: "finance-subscriptions.v1",
        propertyId,
        customerPortal: result.value,
      };
    },
  );

  app.post<{ Params: PropertyParams; Body: CommandBody }>(
    "/finance/properties/:propertyId/switch-to-commission",
    async (request, reply) => {
      const { propertyId } = request.params;
      if (!enforceFinancePropertyWritePolicy(request, reply, propertyId)) return reply;
      const command = subscriptionCommand(request, propertyId, "Schedule Commission Plan");
      if (!command) {
        return reply.code(400).send({
          code: "invalid_command",
          message: "commandId and idempotencyKey are required.",
        });
      }
      const result = await options.service.scheduleCommissionPlan(command);
      if (!result.ok) return reply.code(result.statusCode).send(result);
      return {
        contractVersion: "finance-subscriptions.v1",
        propertyId,
        planStatus: toFinancePlanStatusResponse(result.value.planStatus).planStatus,
      };
    },
  );
}

function subscriptionCommand(
  request: FastifyRequest<{ Body: CommandBody }>,
  propertyId: string,
  reason: string,
): FinanceSubscriptionCommandContext | null {
  const commandId = boundedString(request.body?.commandId);
  const idempotencyKey = boundedString(request.body?.idempotencyKey);
  if (!commandId || !idempotencyKey) return null;
  const context = requireAuthContext(request);
  return {
    commandId,
    idempotencyKey,
    propertyId,
    organizationId: context.selectedOrganization.organizationId,
    audit: audit(request, reason),
  };
}

function audit(request: FastifyRequest, reason: string): FinanceCommandAudit {
  const context = requireAuthContext(request);
  return {
    actor: {
      kind: "user",
      userId: context.actor.internalUserId,
      organizationId: context.selectedOrganization.organizationId,
    },
    requestId: context.audit.requestId,
    correlationId: context.audit.correlationId,
    reason,
    requestedAt: context.audit.receivedAt,
  };
}

function boundedString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 && value.trim().length <= 200
    ? value.trim()
    : null;
}

function email(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim().toLowerCase();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized) ? normalized : null;
}
