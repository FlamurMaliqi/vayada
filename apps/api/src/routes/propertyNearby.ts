import {
  hasPermission,
  resolveEffectivePropertyAccess,
  type PropertyAccessRepository,
} from "@vayada/backend-authorization";
import { NEARBY_MAX_REQUEST_BYTES, parseNearbyCurationWrite } from "@vayada/domain-hotels";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { PropertyNearbyRepository } from "../domains/propertyNearbyRepository.js";
import type { PropertyNearbyDiscoveryRepository } from "../domains/propertyNearbyDiscoveryRepository.js";
import { discoverGoogleNearby } from "../integrations/googleNearbyPlaces.js";
import { enforceRoutePolicy } from "./policy.js";

export async function registerPropertyNearbyRoutes(
  app: FastifyInstance,
  options: {
    repository: PropertyNearbyRepository;
    propertyAccessRepository: PropertyAccessRepository;
    discovery?: {
      repository: PropertyNearbyDiscoveryRepository;
      apiKey?: string;
      discover?: typeof discoverGoogleNearby;
    };
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
  const discovery = options.discovery;
  if (!discovery) return;
  app.addHook("onClose", () => discovery.repository.close());
  const discoveryPath = "/properties/:propertyId/nearby";
  app.get(discoveryPath, async (request, reply) => {
    const scope = await authorize(request, false);
    if (!discovery.apiKey?.trim()) return reply.code(503).send({ code: "not_configured" });
    return (
      (await discovery.repository.read(scope)) ??
      reply.code(403).send({ code: "missing_property_resource_link" })
    );
  });
  app.post(`${discoveryPath}/refresh`, { bodyLimit: 1024 }, async (request, reply) => {
    const scope = await authorize(request, true);
    const body = request.body as { expectedProfileRevision?: number; force?: boolean } | null;
    if (
      !body ||
      typeof body !== "object" ||
      Array.isArray(body) ||
      Object.keys(body).some((key) => key !== "expectedProfileRevision" && key !== "force") ||
      !Number.isSafeInteger(body.expectedProfileRevision) ||
      body.expectedProfileRevision! < 1 ||
      (body.force !== undefined && typeof body.force !== "boolean")
    )
      return reply.code(400).send({ code: "invalid_request" });
    if (!discovery.apiKey?.trim()) return reply.code(503).send({ code: "not_configured" });
    const claim = await discovery.repository.claim(
      scope,
      body.expectedProfileRevision!,
      body.force,
    );
    if (claim.status === "missing_property_resource_link")
      return reply.code(403).send({ code: claim.status });
    if (claim.status === "revision_conflict") return reply.code(409).send({ code: claim.status });
    if (claim.status === "cooldown") {
      reply.header(
        "Retry-After",
        Math.max(1, Math.ceil((Date.parse(claim.retryAfter!) - Date.now()) / 1000)),
      );
      return reply.code(429).send({ code: "cooldown", retryAfter: claim.retryAfter });
    }
    if (claim.status === "state")
      return reply.code(claim.state.status === "refreshing" ? 202 : 200).send(claim.state);
    request.log.info(
      { propertyId: scope.propertyId, profileRevision: claim.profileRevision },
      "Nearby discovery started",
    );
    const result = await (discovery.discover ?? discoverGoogleNearby)({
      origin: claim.origin,
      apiKey: discovery.apiKey,
    });
    request.log.info(
      { propertyId: scope.propertyId, status: result.status },
      "Nearby discovery completed",
    );
    const state = await discovery.repository.complete(
      scope,
      claim.token,
      claim.profileRevision,
      result,
    );
    if (!state) return reply.code(403).send({ code: "missing_property_resource_link" });
    if (state.profileRevision !== claim.profileRevision || state.status === "stale")
      return reply.code(409).send({ code: "revision_conflict" });
    const status =
      state.status === "ready" || state.status === "empty" || state.status === "location_required"
        ? 200
        : state.status === "refreshing"
          ? 202
          : state.status === "quota_exhausted"
            ? 429
            : 503;
    if (status === 429 && state.retryAfter)
      reply.header(
        "Retry-After",
        Math.max(1, Math.ceil((Date.parse(state.retryAfter) - Date.now()) / 1000)),
      );
    return reply.code(status).send(state);
  });
}
