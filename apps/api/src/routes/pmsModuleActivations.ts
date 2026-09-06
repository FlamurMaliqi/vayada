import pg, { type QueryResult, type QueryResultRow } from "pg";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { RequestContext } from "@vayada/backend-auth";

import { enforceRoutePolicy } from "./policy.js";

const MODULE_ENTITLEMENT_PREFIX = "module:";
const MODULE_ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const PMS_MODULE_IDS = ["affiliates"] as const;
const PMS_MODULE_ID_SET = new Set<string>(PMS_MODULE_IDS);

export type PmsModuleActivation = {
  moduleId: string;
  isActive: boolean;
  activatedAt: string | null;
  deactivatedAt: string | null;
  updatedAt: string;
};

export type PmsModuleActivationsResponse = {
  hotelId: string;
  canManage: boolean;
  supportedModules: string[];
  activeModules: string[];
  activations: PmsModuleActivation[];
};

export type PmsModuleActivationRepository = {
  list(context: RequestContext, propertyId: string): Promise<PmsModuleActivation[]>;
  close?(): Promise<void>;
};

export type PmsModuleActivationRoutesOptions = {
  repository: PmsModuleActivationRepository;
  allowedOrigins?: string[];
};

type PmsPropertyParams = {
  propertyId: string;
};

type PmsModuleParams = PmsPropertyParams & {
  moduleId: string;
};

type PmsModuleActivationBody = {
  moduleId?: unknown;
  isActive?: unknown;
};

export async function registerPmsModuleActivationRoutes(
  app: FastifyInstance,
  options: PmsModuleActivationRoutesOptions,
): Promise<void> {
  const { repository } = options;

  app.addHook("onClose", async () => {
    await repository.close?.();
  });

  for (const path of [
    "/properties/:propertyId/module-activations",
    "/properties/:propertyId/module-activations/:moduleId",
  ]) {
    app.options(path, async (request, reply) => {
      if (!writePmsModuleActivationCorsHeaders(request, reply, options.allowedOrigins ?? [])) {
        return reply.status(403).send({
          code: "origin_not_allowed",
          message: "PMS module activation origin is not allowed.",
        });
      }
      return reply.code(204).send();
    });
  }

  app.get<{ Params: PmsPropertyParams }>(
    "/properties/:propertyId/module-activations",
    async (request, reply) => {
      if (!writePmsModuleActivationCorsHeaders(request, reply, options.allowedOrigins ?? [])) {
        return reply.status(403).send({
          code: "origin_not_allowed",
          message: "PMS module activation origin is not allowed.",
        });
      }

      const { propertyId } = request.params;
      const context = enforceModuleActivationReadPolicy(request, propertyId);
      const activations = await repository.list(context, propertyId);
      return moduleActivationsResponse(
        propertyId,
        canManageModuleActivations(context, propertyId),
        activations,
      );
    },
  );

  app.patch<{ Params: PmsModuleParams; Body: PmsModuleActivationBody }>(
    "/properties/:propertyId/module-activations/:moduleId",
    async (request, reply) => {
      if (!writePmsModuleActivationCorsHeaders(request, reply, options.allowedOrigins ?? [])) {
        return reply.status(403).send({
          code: "origin_not_allowed",
          message: "PMS module activation origin is not allowed.",
        });
      }

      const { propertyId, moduleId } = request.params;
      const body = request.body;
      const parsed = parseModuleActivationUpdateBody(moduleId, body);
      if (!parsed.ok) return reply.status(400).send(parsed.error);

      enforceModuleActivationManagePolicy(request, propertyId);
      return reply.header("Cache-Control", "no-store").code(410).send({
        code: "affiliate_module_activation_retired",
        message: "Legacy affiliate module changes are no longer available.",
      });
    },
  );
}

function enforceModuleActivationReadPolicy(
  request: FastifyRequest,
  propertyId: string,
): RequestContext {
  return enforceRoutePolicy(request, {
    permission: "pms.operations.read",
    entitlement: {
      product: "pms",
      key: "property-management",
      resource: {
        product: "pms",
        resourceType: "pms_property",
        resourceId: propertyId,
      },
    },
    resource: {
      product: "pms",
      resourceType: "pms_property",
      resourceId: propertyId,
      allowedRelationships: ["owner", "operator", "front_desk"],
    },
  });
}

function enforceModuleActivationManagePolicy(
  request: FastifyRequest,
  propertyId: string,
): RequestContext {
  return enforceRoutePolicy(request, {
    permission: "pms.operations.manage",
    entitlement: {
      product: "pms",
      key: "property-management",
      resource: {
        product: "pms",
        resourceType: "pms_property",
        resourceId: propertyId,
      },
    },
    resource: {
      product: "pms",
      resourceType: "pms_property",
      resourceId: propertyId,
      allowedRelationships: ["owner", "operator"],
    },
  });
}

function parseModuleActivationUpdateBody(
  moduleId: string,
  body: PmsModuleActivationBody,
):
  | { ok: true; isActive: boolean }
  | { ok: false; error: { code: "invalid_body"; message: string } } {
  if (!MODULE_ID_PATTERN.test(moduleId)) {
    return { ok: false, error: invalidBody("moduleId must be kebab-case.") };
  }
  if (!PMS_MODULE_ID_SET.has(moduleId)) {
    return { ok: false, error: invalidBody("moduleId is not supported for PMS.") };
  }
  if (body?.moduleId !== undefined && body.moduleId !== moduleId) {
    return { ok: false, error: invalidBody("Body moduleId must match the route moduleId.") };
  }
  if (typeof body?.isActive !== "boolean") {
    return { ok: false, error: invalidBody("isActive must be a boolean.") };
  }
  return { ok: true, isActive: body.isActive };
}

function invalidBody(message: string) {
  return { code: "invalid_body" as const, message };
}

function canManageModuleActivations(context: RequestContext, propertyId: string): boolean {
  if (!context.membership.permissions.includes("pms.operations.manage")) return false;
  return context.linkedResources.some(
    (resource) =>
      resource.product === "pms" &&
      resource.resourceType === "pms_property" &&
      resource.resourceId === propertyId &&
      resource.status === "active" &&
      (resource.relationship === "owner" || resource.relationship === "operator"),
  );
}

function moduleActivationsResponse(
  propertyId: string,
  canManage: boolean,
  activations: PmsModuleActivation[],
): PmsModuleActivationsResponse {
  const supportedActivations = activations.filter((activation) =>
    PMS_MODULE_ID_SET.has(activation.moduleId),
  );
  return {
    hotelId: propertyId,
    canManage,
    supportedModules: [],
    activeModules: supportedActivations
      .filter((activation) => activation.isActive)
      .map((activation) => activation.moduleId),
    activations: supportedActivations,
  };
}

function writePmsModuleActivationCorsHeaders(
  request: FastifyRequest,
  reply: FastifyReply,
  allowedOrigins: string[],
): boolean {
  const origin = request.headers.origin;
  if (!origin) return true;
  if (!allowedOrigins.includes(origin)) return false;
  reply
    .header("Access-Control-Allow-Origin", origin)
    .header("Access-Control-Allow-Headers", "authorization,content-type,x-hotel-id")
    .header("Access-Control-Allow-Methods", "GET,PATCH,OPTIONS")
    .header("Vary", "Origin");
  return true;
}

export type PmsModuleActivationPool = {
  query<T extends QueryResultRow = QueryResultRow>(
    text: string,
    values?: readonly unknown[],
  ): Promise<Pick<QueryResult<T>, "rows" | "rowCount">>;
  end?(): Promise<void>;
};

export function createPgPmsModuleActivationRepository(config: {
  connectionString: string;
  max?: number;
  pool?: PmsModuleActivationPool;
}): PmsModuleActivationRepository {
  if (!config.connectionString.trim()) {
    throw new Error("PMS module activation repository connectionString must not be empty");
  }

  const ownsPool = !config.pool;
  const pool: PmsModuleActivationPool =
    config.pool ??
    new pg.Pool({
      connectionString: config.connectionString,
      max: config.max,
    });

  return {
    async list(context, propertyId) {
      const result = await pool.query<PmsModuleActivationRow>(
        `SELECT
           entitlement_key AS "entitlementKey",
           status,
           starts_at AS "startsAt",
           expires_at AS "expiresAt",
           updated_at AS "updatedAt"
         FROM identity.product_entitlements
         WHERE organization_id = $1::uuid
           AND product = 'pms'
           AND entitlement_key = ANY($3::text[])
           AND resource_product = 'pms'
           AND resource_type = 'pms_property'
           AND resource_id = $2
           AND (starts_at IS NULL OR starts_at <= now())
         ORDER BY entitlement_key ASC`,
        [
          context.selectedOrganization.organizationId,
          propertyId,
          PMS_MODULE_IDS.map(moduleEntitlementKey),
        ],
      );
      return result.rows.map(toModuleActivation);
    },

    async close() {
      if (ownsPool) await pool.end?.();
    },
  };
}

type PmsModuleActivationRow = {
  entitlementKey: string;
  status: string;
  startsAt: Date | string | null;
  expiresAt: Date | string | null;
  updatedAt: Date | string;
};

function toModuleActivation(row: PmsModuleActivationRow): PmsModuleActivation {
  const isActive = row.status === "active" && !isPast(row.expiresAt);
  return {
    moduleId: row.entitlementKey.slice(MODULE_ENTITLEMENT_PREFIX.length),
    isActive,
    activatedAt: toIsoOrNull(row.startsAt),
    deactivatedAt: isActive ? null : (toIsoOrNull(row.expiresAt) ?? toIso(row.updatedAt)),
    updatedAt: toIso(row.updatedAt),
  };
}

function moduleEntitlementKey(moduleId: string): string {
  return `${MODULE_ENTITLEMENT_PREFIX}${moduleId}`;
}

function isPast(value: Date | string | null): boolean {
  return value ? new Date(value).getTime() <= Date.now() : false;
}

function toIsoOrNull(value: Date | string | null): string | null {
  return value ? toIso(value) : null;
}

function toIso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}
