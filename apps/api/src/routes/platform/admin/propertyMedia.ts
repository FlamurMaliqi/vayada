import type { PermissionKey } from "@vayada/backend-auth";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

import {
  propertyMediaCommandResultStatus,
  type PropertyMediaCommandRepository,
} from "../../../domains/propertyMediaCommandRepository.js";
import { enforceRoutePolicy } from "../../policy.js";

const PLATFORM_RESOURCE = {
  product: "platform",
  resourceType: "platform",
  resourceId: "vayada",
  allowedRelationships: ["operator"],
} as const;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

type Repository = Pick<
  PropertyMediaCommandRepository,
  "getPlatformAdminHero" | "replacePlatformAdminHero"
>;
export async function registerPlatformPropertyMediaRoutes(
  app: FastifyInstance,
  options: { repository: Repository },
): Promise<void> {
  const readAccess = authorizeBeforeBody("platform.admin.read");
  const writeAccess = authorizeBeforeBody("platform.user.suspend");

  app.get(
    "/properties/:propertyId/media/hero",
    { onRequest: readAccess.hook },
    async (request, reply) => {
      const access = readAccess.require(request);
      const hero = await options.repository.getPlatformAdminHero(access.propertyId);
      if (!hero) {
        return reply
          .status(404)
          .send({ code: "property_not_found", detail: "Property not found." });
      }
      reply.header("Cache-Control", "private, no-store");
      return { contractVersion: "platform-admin-property-hero.v1", ...hero };
    },
  );

  app.put(
    "/properties/:propertyId/media/hero",
    { onRequest: writeAccess.hook },
    async (request, reply) => {
      const access = writeAccess.require(request);
      const body = parseHeroCommand(request.body);
      const idempotencyKey = readIdempotencyKey(request);
      if (!body || !idempotencyKey) {
        return reply.status(422).send({
          code: "invalid_platform_property_hero_request",
          detail:
            "Provide an expected profile revision, media object ID or null, and one Idempotency-Key.",
        });
      }
      const result = await options.repository.replacePlatformAdminHero({
        propertyId: access.propertyId,
        actorUserId: access.context.actor.internalUserId,
        audit: access.context.audit,
        idempotencyKey,
        ...body,
      });
      if (!result.ok) {
        return reply.status(propertyMediaCommandResultStatus(result)).send(result.error);
      }
      const hero = result.response.presentationAssignments.find(({ role }) => role === "cover");
      reply.header("Cache-Control", "private, no-store");
      return {
        contractVersion: "platform-admin-property-hero.v1",
        outcome: result.response.outcome,
        propertyId: access.propertyId,
        profileRevision: result.response.profileRevision,
        hero: hero ? { mediaObjectId: hero.mediaObjectId, url: null } : null,
      };
    },
  );
}

function authorizeBeforeBody(permission: PermissionKey) {
  const authorized = new WeakMap<
    FastifyRequest,
    { propertyId: string; context: ReturnType<typeof enforceRoutePolicy> }
  >();
  return {
    async hook(request: FastifyRequest, reply: FastifyReply) {
      const context = enforceRoutePolicy(request, { permission, resource: PLATFORM_RESOURCE });
      if (context.selectedOrganization.kind !== "platform") {
        return reply.status(403).send({ code: "invalid_platform_scope" });
      }
      const propertyId = String((request.params as { propertyId?: unknown }).propertyId ?? "");
      if (!UUID_PATTERN.test(propertyId)) {
        return reply.status(400).send({ code: "invalid_property_id" });
      }
      authorized.set(request, { propertyId: propertyId.toLowerCase(), context });
    },
    require(request: FastifyRequest) {
      const access = authorized.get(request);
      if (!access)
        throw new Error("Platform property media access was not resolved before body parsing");
      return access;
    },
  };
}

function parseHeroCommand(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const body = value as Record<string, unknown>;
  if (
    Object.keys(body).some((key) => !["expectedProfileRevision", "mediaObjectId"].includes(key)) ||
    !Number.isSafeInteger(body.expectedProfileRevision) ||
    Number(body.expectedProfileRevision) < 1 ||
    Number(body.expectedProfileRevision) > 2_147_483_647 ||
    (body.mediaObjectId !== null &&
      (typeof body.mediaObjectId !== "string" || !UUID_PATTERN.test(body.mediaObjectId)))
  ) {
    return null;
  }
  return {
    expectedProfileRevision: Number(body.expectedProfileRevision),
    mediaObjectId: body.mediaObjectId === null ? null : body.mediaObjectId.toLowerCase(),
  };
}

function readIdempotencyKey(request: FastifyRequest): string | null {
  const occurrences = request.raw.rawHeaders.filter(
    (value, index) => index % 2 === 0 && value.toLowerCase() === "idempotency-key",
  ).length;
  const value = request.headers["idempotency-key"];
  return occurrences === 1 && typeof value === "string" && value.trim().length <= 200
    ? value.trim() || null
    : null;
}
