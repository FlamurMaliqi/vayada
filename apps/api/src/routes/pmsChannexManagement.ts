import type { ChannexManagementCapabilityModes } from "@vayada/domain-pms-channex";
import type { FastifyInstance, FastifyRequest } from "fastify";

import type { PmsChannexManagementReadRepository } from "../domains/pmsChannexManagementReadModel.js";
import { enforceRoutePolicy } from "./policy.js";

export type PmsChannexManagementRoutesOptions = {
  repository: PmsChannexManagementReadRepository;
  capabilityModes: ChannexManagementCapabilityModes;
};

export async function registerPmsChannexManagementRoutes(
  app: FastifyInstance,
  options: PmsChannexManagementRoutesOptions,
): Promise<void> {
  app.addHook("onClose", () => options.repository.close?.());

  app.get<{ Params: { propertyId: string } }>(
    "/properties/:propertyId/channex",
    async (request) => {
      const { propertyId } = request.params;
      enforcePmsChannexPolicy(request, propertyId, "pms.operations.read");
      return options.repository.getSnapshot(propertyId, options.capabilityModes);
    },
  );

  app.get<{ Params: { propertyId: string; operationId: string } }>(
    "/properties/:propertyId/channex/operations/:operationId",
    async (request, reply) => {
      const { propertyId, operationId } = request.params;
      enforcePmsChannexPolicy(request, propertyId, "pms.operations.read");
      const operation = await options.repository.getOperation(propertyId, operationId);
      return operation ?? reply.code(404).send({ code: "operation_not_found" });
    },
  );
}

export function enforcePmsChannexPolicy(
  request: FastifyRequest,
  propertyId: string,
  permission: "pms.operations.read" | "pms.operations.manage",
) {
  return enforceRoutePolicy(request, {
    permission,
    entitlement: {
      product: "pms",
      key: "property-management",
      resource: { product: "pms", resourceType: "pms_property", resourceId: propertyId },
    },
    resource: {
      product: "pms",
      resourceType: "pms_property",
      resourceId: propertyId,
      allowedRelationships: ["owner", "operator", "front_desk"],
    },
  });
}
