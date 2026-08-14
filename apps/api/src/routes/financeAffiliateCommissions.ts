import type { MarketplaceAffiliateAdminRepository } from "@vayada/domain-marketplace";
import type { FinanceAffiliateCommissionRepository } from "@vayada/domain-finance";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

import { enforceRoutePolicy } from "./policy.js";

type PropertyParams = { propertyId: string };
type AffiliateParams = PropertyParams & { affiliateId: string };

export type FinanceAffiliateCommissionRoutesOptions = {
  repository: FinanceAffiliateCommissionRepository;
  affiliateScope: Pick<MarketplaceAffiliateAdminRepository, "getAffiliate">;
  now?: () => Date;
};

export async function registerFinanceAffiliateCommissionRoutes(
  app: FastifyInstance,
  options: FinanceAffiliateCommissionRoutesOptions,
): Promise<void> {
  const now = options.now ?? (() => new Date());
  app.addHook("onClose", async () => options.repository.close?.());

  app.get<{ Params: PropertyParams }>(
    "/properties/:propertyId/affiliate-commission",
    async (request, reply) => {
      if (!authorize(request, reply, request.params.propertyId)) return reply;
      return options.repository.getCommission(request.params.propertyId);
    },
  );

  app.patch<{ Params: PropertyParams; Body: unknown }>(
    "/properties/:propertyId/affiliate-commission",
    async (request, reply) => {
      const context = authorize(request, reply, request.params.propertyId);
      if (!context) return reply;
      const command = parseCommand(request.body, false);
      if (typeof command === "string") return sendError(reply, 422, command);
      return applyCommand(options, reply, {
        ...command,
        propertyId: request.params.propertyId,
        affiliateId: null,
        actorUserId: context.actor.internalUserId,
        occurredAt: now().toISOString(),
      });
    },
  );

  app.get<{ Params: AffiliateParams }>(
    "/properties/:propertyId/affiliates/:affiliateId/commission",
    async (request, reply) => {
      if (!authorize(request, reply, request.params.propertyId)) return reply;
      if (!(await hasAffiliate(options, request.params))) {
        return sendError(reply, 404, "affiliate_not_found");
      }
      return options.repository.getCommission(
        request.params.propertyId,
        request.params.affiliateId,
      );
    },
  );

  app.patch<{ Params: AffiliateParams; Body: unknown }>(
    "/properties/:propertyId/affiliates/:affiliateId/commission",
    async (request, reply) => {
      const context = authorize(request, reply, request.params.propertyId);
      if (!context) return reply;
      if (!(await hasAffiliate(options, request.params))) {
        return sendError(reply, 404, "affiliate_not_found");
      }
      const command = parseCommand(request.body, true);
      if (typeof command === "string") return sendError(reply, 422, command);
      return applyCommand(options, reply, {
        ...command,
        propertyId: request.params.propertyId,
        affiliateId: request.params.affiliateId,
        actorUserId: context.actor.internalUserId,
        occurredAt: now().toISOString(),
      });
    },
  );
}

async function applyCommand(
  options: FinanceAffiliateCommissionRoutesOptions,
  reply: FastifyReply,
  command: Parameters<FinanceAffiliateCommissionRepository["setCommission"]>[0],
) {
  const result = await options.repository.setCommission(command);
  return result.outcome === "idempotency_conflict"
    ? sendError(reply, 409, "idempotency_conflict")
    : result;
}

async function hasAffiliate(
  options: FinanceAffiliateCommissionRoutesOptions,
  params: AffiliateParams,
): Promise<boolean> {
  return Boolean(await options.affiliateScope.getAffiliate(params.propertyId, params.affiliateId));
}

function authorize(request: FastifyRequest, reply: FastifyReply, propertyId: string) {
  let context: ReturnType<typeof enforceRoutePolicy>;
  try {
    context = enforceRoutePolicy(request, { permission: "pms.finance.manage" });
  } catch (error) {
    if (!isStatusError(error) || error.statusCode !== 401) {
      return sendDenied(reply, error, "missing_permission");
    }
    sendError(reply, 401, "unauthenticated");
    return null;
  }
  try {
    enforceRoutePolicy(request, {
      permission: "pms.finance.manage",
      resource: {
        product: "hotel_catalog",
        resourceType: "property",
        resourceId: propertyId,
        allowedRelationships: ["owner", "finance_manager"],
      },
    });
  } catch (error) {
    return sendDenied(reply, error, "missing_resource_access");
  }

  const matching = context.entitlements.filter(
    (entitlement) =>
      ((entitlement.product === "booking" && entitlement.key === "direct-booking-finance") ||
        (entitlement.product === "pms" && entitlement.key === "property-management")) &&
      (entitlement.resource === undefined || entitlement.resource.resourceId === propertyId),
  );
  if (!matching.some((entitlement) => entitlement.status === "active")) {
    sendError(
      reply,
      403,
      matching.some((entitlement) => entitlement.status !== "active")
        ? "inactive_entitlement"
        : "missing_entitlement",
    );
    return null;
  }
  return context;
}

function sendDenied(reply: FastifyReply, error: unknown, code: string): null {
  if (!isStatusError(error) || error.statusCode !== 403) throw error;
  sendError(reply, 403, code);
  return null;
}

function parseCommand(body: unknown, nullable: boolean) {
  if (!isRecord(body)) return "invalid_commission_command";
  const commandId = typeof body.commandId === "string" ? body.commandId.trim() : "";
  const idempotencyKey = typeof body.idempotencyKey === "string" ? body.idempotencyKey.trim() : "";
  if (!commandId || commandId.length > 200 || !idempotencyKey || idempotencyKey.length > 200) {
    return "invalid_commission_command";
  }
  if (nullable && body.percentageRate === null) {
    return { commandId, idempotencyKey, percentageRate: null };
  }
  if (typeof body.percentageRate !== "string") return "invalid_percentage_rate";
  const percentageRate = body.percentageRate.trim();
  if (!/^\d+(?:\.\d{1,4})?$/.test(percentageRate) || Number(percentageRate) > 100) {
    return "invalid_percentage_rate";
  }
  return { commandId, idempotencyKey, percentageRate };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStatusError(error: unknown): error is Error & { statusCode: number } {
  return (
    error instanceof Error &&
    "statusCode" in error &&
    typeof (error as { statusCode?: unknown }).statusCode === "number"
  );
}

function sendError(reply: FastifyReply, status: number, code: string): FastifyReply {
  return reply.status(status).send({ code });
}
