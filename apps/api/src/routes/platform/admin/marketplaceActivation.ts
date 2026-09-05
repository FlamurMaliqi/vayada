import { parseUpdateTracksRequest } from "@vayada/domain-hotels";
import type { FastifyInstance } from "fastify";
import type { HotelSetupTrackCommandRepository } from "../../../domains/hotelSetupTrackCommandRepository.js";
import type { PlatformMarketplaceAccountsRepository } from "../../../domains/platformMarketplaceAccountsRepository.js";
import { PlatformPropertyLifecycleError } from "../../../domains/platformPropertyLifecycleCommandRepository.js";
import { enforceRoutePolicy } from "../../policy.js";

export type PlatformMarketplaceActivationOptions = {
  accounts: PlatformMarketplaceAccountsRepository;
  tracks: Pick<HotelSetupTrackCommandRepository, "updateTracks">;
};
const resource = {
  product: "platform",
  resourceType: "platform",
  resourceId: "vayada",
  allowedRelationships: ["operator"],
} as const;
const base = "/users/:userId/marketplace-accounts";
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export async function registerPlatformMarketplaceActivationRoutes(
  app: FastifyInstance,
  options: PlatformMarketplaceActivationOptions,
) {
  app.addHook("onClose", () => options.accounts.close());
  app.get<{ Params: { userId: string } }>(base, async (request) => {
    enforceRoutePolicy(request, { permission: "platform.admin.read", resource });
    let canActivate = false;
    try {
      enforceRoutePolicy(request, { permission: "platform.property.status.manage", resource });
      canActivate = true;
    } catch {
      /* Read-only administrators may inspect setup. */
    }
    return { accounts: await options.accounts.list(request.params.userId), canActivate };
  });
  app.post<{ Params: { userId: string; organizationId: string } }>(
    `${base}/:organizationId/activate`,
    async (request, reply) => {
      const context = enforceRoutePolicy(request, {
        permission: "platform.property.status.manage",
        resource,
      });
      const update = parseUpdateTracksRequest(request.body);
      const key = request.headers["idempotency-key"];
      if (
        !uuid.test(request.params.userId) ||
        !uuid.test(request.params.organizationId) ||
        !update ||
        !update.selectedTracks.includes("creator_marketplace") ||
        typeof key !== "string" ||
        !key.trim() ||
        key.length > 200
      ) {
        return reply.status(400).send({
          code: "invalid_marketplace_activation",
          detail:
            "Select an account, include Marketplace and the current track revision, and provide an idempotency key.",
        });
      }
      try {
        const result = await options.tracks.updateTracks({
          ...update,
          organizationId: request.params.organizationId,
          actorUserId: context.actor.internalUserId,
          audit: context.audit,
          idempotencyKey: key.trim(),
          adminActivation: {
            platformOrganizationId: context.selectedOrganization.organizationId,
            accountUserId: request.params.userId,
            actorUserId: context.actor.internalUserId,
          },
        });
        if (!result.ok)
          return reply
            .status(409)
            .send({ ...result.error, detail: "Account setup changed. Refresh and retry." });
        return result.response;
      } catch (error) {
        if (error instanceof PlatformPropertyLifecycleError) {
          return reply.status(403).send({
            code: error.code,
            detail: "Account activation is not permitted for this administrator and account.",
          });
        }
        throw error;
      }
    },
  );
}
