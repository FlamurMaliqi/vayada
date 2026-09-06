import {
  MARKETPLACE_AFFILIATE_ADMIN_CONTRACT_VERSION,
  MARKETPLACE_AFFILIATE_LIFECYCLE_STATUSES,
  type MarketplaceAffiliateAdminRepository,
} from "@vayada/domain-marketplace";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

import { enforceRoutePolicy } from "./policy.js";

type PropertyParams = { propertyId: string };
type AffiliateParams = PropertyParams & { affiliateId: string };
type ListQuery = {
  status?: string;
  affiliateType?: string;
  search?: string;
  limit?: string | number;
  offset?: string | number;
};

export async function registerMarketplaceAffiliateAdminRoutes(
  app: FastifyInstance,
  options: { repository: MarketplaceAffiliateAdminRepository },
): Promise<void> {
  app.addHook("onClose", async () => options.repository.close?.());

  app.get<{ Params: PropertyParams; Querystring: ListQuery }>(
    "/properties/:propertyId/affiliates",
    async (request, reply) => {
      if (!authorize(request, reply, request.params.propertyId)) return reply;
      const query = parseListQuery(request.query);
      if (typeof query === "string") return sendError(reply, 422, query);
      const result = await options.repository.listAffiliates({
        propertyId: request.params.propertyId,
        ...query,
      });
      return {
        contractVersion: MARKETPLACE_AFFILIATE_ADMIN_CONTRACT_VERSION,
        ...result,
        limit: query.limit,
        offset: query.offset,
      };
    },
  );

  app.get<{ Params: AffiliateParams }>(
    "/properties/:propertyId/affiliates/:affiliateId",
    async (request, reply) => {
      if (!authorize(request, reply, request.params.propertyId)) return reply;
      const affiliate = await options.repository.getAffiliate(
        request.params.propertyId,
        request.params.affiliateId,
      );
      return affiliate ?? sendError(reply, 404, "affiliate_not_found");
    },
  );

  app.post<{ Params: AffiliateParams; Body: unknown }>(
    "/properties/:propertyId/affiliates/:affiliateId/lifecycle",
    async (request, reply) => {
      const context = authorize(request, reply, request.params.propertyId);
      if (!context) return reply;
      return reply.header("Cache-Control", "no-store").code(410).send({
        code: "affiliate_administration_retired",
        message: "Legacy affiliate lifecycle changes are no longer available.",
      });
    },
  );
}

function authorize(request: FastifyRequest, reply: FastifyReply, propertyId: string) {
  try {
    return enforceRoutePolicy(request, {
      permission: "marketplace.affiliate.manage",
      entitlement: { product: "booking", key: "booking-engine" },
      resource: {
        product: "hotel_catalog",
        resourceType: "property",
        resourceId: propertyId,
        allowedRelationships: ["owner", "operator"],
      },
    });
  } catch (error) {
    if (!isStatusError(error)) throw error;
    if (error.statusCode === 401) {
      sendError(reply, 401, "unauthenticated");
      return null;
    }
    if (error.statusCode !== 403) throw error;
    const message = error.message.toLowerCase();
    const code = message.includes("permission")
      ? "missing_permission"
      : message.includes("entitlement")
        ? hasInactiveEntitlement(request)
          ? "inactive_entitlement"
          : "missing_entitlement"
        : "missing_resource_access";
    sendError(reply, 403, code);
    return null;
  }
}

function hasInactiveEntitlement(request: FastifyRequest): boolean {
  return Boolean(
    request.authContext?.entitlements.some(
      (entitlement) =>
        entitlement.product === "booking" &&
        entitlement.key === "booking-engine" &&
        entitlement.status !== "active" &&
        entitlement.resource === undefined,
    ),
  );
}

function isStatusError(error: unknown): error is Error & { statusCode: number } {
  return (
    error instanceof Error &&
    "statusCode" in error &&
    typeof (error as { statusCode?: unknown }).statusCode === "number"
  );
}

function parseListQuery(query: ListQuery) {
  const status = query.status?.trim();
  if (status && !MARKETPLACE_AFFILIATE_LIFECYCLE_STATUSES.includes(status as never)) {
    return "invalid_affiliate_status";
  }
  const affiliateType = query.affiliateType?.trim();
  if (affiliateType && affiliateType !== "guest" && affiliateType !== "creator") {
    return "invalid_affiliate_type";
  }
  return {
    ...(status
      ? { status: status as (typeof MARKETPLACE_AFFILIATE_LIFECYCLE_STATUSES)[number] }
      : {}),
    ...(affiliateType ? { affiliateType: affiliateType as "guest" | "creator" } : {}),
    ...(query.search?.trim() ? { search: query.search.trim() } : {}),
    limit: boundedInteger(query.limit, 50, 1, 200),
    offset: boundedInteger(query.offset, 0, 0, Number.MAX_SAFE_INTEGER),
  };
}

function boundedInteger(value: unknown, fallback: number, min: number, max: number): number {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isInteger(parsed) ? Math.min(max, Math.max(min, parsed)) : fallback;
}

function sendError(reply: FastifyReply, status: number, code: string): FastifyReply {
  return reply.status(status).send({ code });
}
