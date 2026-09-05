import {
  hasPermission,
  resolveEffectivePropertyAccess,
  type PropertyAccessRepository,
} from "@vayada/backend-authorization";
import { NEARBY_MAX_REQUEST_BYTES, parseNearbyCurationWrite } from "@vayada/domain-hotels";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { PropertyNearbyRepository } from "../domains/propertyNearbyRepository.js";
import { enforceRoutePolicy } from "./policy.js";

export async function registerPropertyNearbyRoutes(
  app: FastifyInstance,
  options: {
    repository: PropertyNearbyRepository;
    propertyAccessRepository: PropertyAccessRepository;
  },
) {
  app.addHook("onClose", () => options.repository.close());
  app.addHook("onRequest", async (_request, reply) => {
    reply.header("Cache-Control", "no-store");
  });
  const path = "/properties/:propertyId/nearby/curation";
  async function authorize(request: FastifyRequest, write: boolean) {
    const context = enforceRoutePolicy(request, {
      permission: write ? "hotel_catalog.setup.manage" : "hotel_catalog.setup.read",
    });
    const { propertyId } = request.params as { propertyId: string };
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(propertyId)) {
      throw Object.assign(new Error("Invalid property ID"), { statusCode: 400 });
    }
    const access = await resolveEffectivePropertyAccess(context, options.propertyAccessRepository);
    if (
      !access?.propertyIds.includes(propertyId) ||
      (write &&
        !hasPermission(context, "booking.settings.manage") &&
        !hasPermission(context, "marketplace.profile.manage"))
    ) {
      throw Object.assign(new Error("Missing property publication access"), { statusCode: 403 });
    }
    return {
      propertyId,
      organizationId: context.selectedOrganization.organizationId,
      actorUserId: context.actor.internalUserId,
      requestId: request.id,
    };
  }
  app.get(path, async (request, reply) => {
    const scope = await authorize(request, false);
    const state = await options.repository.read(scope);
    return state ?? reply.code(403).send({ code: "missing_property_resource_link" });
  });
  app.put(path, { bodyLimit: NEARBY_MAX_REQUEST_BYTES }, async (request, reply) => {
    const scope = await authorize(request, true);
    const parsed = parseNearbyCurationWrite(request.body);
    if (!parsed.ok)
      return reply
        .code(parsed.code === "payload_too_large" ? 413 : 400)
        .send({ code: parsed.code });
    const result = await options.repository.save(scope, parsed.value);
    if (result.ok) return result.state;
    const status =
      result.code === "revision_conflict"
        ? 409
        : result.code === "missing_property_resource_link"
          ? 403
          : result.code === "payload_too_large"
            ? 413
            : 400;
    return reply.code(status).send({ code: result.code });
  });
}
