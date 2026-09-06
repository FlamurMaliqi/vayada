import type { MarketplaceAffiliateAdminRepository } from "@vayada/domain-marketplace";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

import { enforceRoutePolicy } from "./policy.js";

type PropertyParams = { propertyId: string };
type AffiliateParams = PropertyParams & { affiliateId: string };
export async function registerMarketplaceAffiliateAdminRoutes(
  app: FastifyInstance,
  options: { repository: MarketplaceAffiliateAdminRepository },
): Promise<void> {
  app.addHook("onClose", async () => options.repository.close?.());

  for (const path of [
    "/properties/:propertyId/affiliates",
    "/properties/:propertyId/affiliates/:affiliateId",
  ]) {
    app.get<{ Params: PropertyParams }>(path, async (request, reply) => {
      if (!authorize(request, reply, request.params.propertyId)) return reply;
      return reply.header("Cache-Control", "no-store").code(410).send({
        code: "affiliate_administration_retired",
        message: "Legacy affiliate administration is no longer available.",
      });
    });
  }

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

function sendError(reply: FastifyReply, status: number, code: string): FastifyReply {
  return reply.status(status).send({ code });
}
