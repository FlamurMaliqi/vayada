import pg, { type QueryResult, type QueryResultRow } from "pg";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

import { enforceRoutePolicy } from "./policy.js";

export type HotelProfileStatusResponse = {
  profile_complete: boolean;
  missing_fields: string[];
  has_defaults: {
    location: boolean;
  };
  missing_offers: boolean;
  completion_steps: string[];
};

export type MarketplaceHotelProfileStatusRepository = {
  getHotelProfileStatus(input: {
    organizationId: string;
    profileResourceId: string;
  }): Promise<HotelProfileStatusResponse | null>;
  close?(): Promise<void>;
};

type MarketplaceHotelProfileStatusRoutesOptions = {
  repository: MarketplaceHotelProfileStatusRepository;
};

type MarketplaceHotelProfileStatusPool = {
  query<T extends QueryResultRow = QueryResultRow>(
    text: string,
    values?: readonly unknown[],
  ): Promise<Pick<QueryResult<T>, "rows">>;
  end(): Promise<void>;
};

type HotelProfileStatusRow = {
  profileComplete: boolean;
  hasOffers: boolean;
};

type HotelProfileStatusAccess = {
  organizationId: string;
  profileResourceId: string;
};

export async function registerMarketplaceHotelProfileStatusRoutes(
  app: FastifyInstance,
  options: MarketplaceHotelProfileStatusRoutesOptions,
): Promise<void> {
  const { repository } = options;

  app.addHook("onClose", async () => {
    await repository.close?.();
  });

  app.get("/hotels/me/profile-status", async (request, reply) => {
    const access = resolveHotelProfileStatusAccess(request, reply);
    if (!access) return reply;

    const status = await repository.getHotelProfileStatus(access);
    return (
      status ?? {
        profile_complete: false,
        missing_fields: ["profile"],
        has_defaults: { location: false },
        missing_offers: true,
        completion_steps: ["Complete your marketplace hotel profile"],
      }
    );
  });
}

export function createPgMarketplaceHotelProfileStatusRepository(config: {
  connectionString: string;
  max?: number;
  pool?: MarketplaceHotelProfileStatusPool;
}): MarketplaceHotelProfileStatusRepository {
  if (!config.connectionString.trim()) {
    throw new Error(
      "Marketplace hotel profile status repository connectionString must not be empty",
    );
  }

  const pool =
    config.pool ??
    new pg.Pool({
      connectionString: config.connectionString,
      max: config.max,
    });

  return {
    async getHotelProfileStatus({ organizationId, profileResourceId }) {
      const result = await pool.query<HotelProfileStatusRow>(
        `SELECT
           profile.profile_complete AS "profileComplete",
           EXISTS (
             SELECT 1
             FROM marketplace.marketplace_offers offer
             WHERE offer.property_id = profile.property_id
               AND offer.organization_id = profile.organization_id
               AND offer.offer_status <> 'archived'
           ) AS "hasOffers"
         FROM marketplace.marketplace_hotel_profiles profile
         WHERE profile.organization_id::text = $1
           AND (
             profile.property_id::text = $2
             OR profile.source_hotel_profile_id = $2
           )
         ORDER BY profile.updated_at DESC, profile.property_id ASC
         LIMIT 1`,
        [organizationId, profileResourceId],
      );

      const row = result.rows[0];
      if (!row) return null;

      const missingFields = row.profileComplete ? [] : ["profile"];
      const completionSteps: string[] = [];
      if (!row.profileComplete) completionSteps.push("Complete your marketplace hotel profile");
      if (!row.hasOffers) completionSteps.push("Add at least one collaboration offer");

      return {
        profile_complete: row.profileComplete && row.hasOffers,
        missing_fields: missingFields,
        has_defaults: { location: false },
        missing_offers: !row.hasOffers,
        completion_steps: completionSteps,
      };
    },
    async close() {
      await pool.end();
    },
  };
}

function resolveHotelProfileStatusAccess(
  request: FastifyRequest,
  reply: FastifyReply,
): HotelProfileStatusAccess | null {
  try {
    const context = enforceRoutePolicy(request, { permission: "marketplace.profile.manage" });
    if (context.selectedOrganization.kind !== "hotel_group") {
      reply.status(403).send({ detail: "This endpoint is only available for hotels" });
      return null;
    }

    const profileLinks = context.linkedResources.filter(
      (resource) =>
        resource.status === "active" &&
        resource.product === "marketplace" &&
        resource.resourceType === "hotel_profile" &&
        (resource.relationship === "owner" || resource.relationship === "operator"),
    );
    if (profileLinks.length === 0) {
      reply.status(403).send({
        detail: "Missing active marketplace hotel profile resource link",
      });
      return null;
    }
    const profileResourceIds = [...new Set(profileLinks.map((resource) => resource.resourceId))];
    if (profileResourceIds.length > 1) {
      reply.status(409).send({
        code: "ambiguous_marketplace_hotel_profile",
        detail: "Selected organization has multiple active marketplace hotel profile links",
      });
      return null;
    }

    const profileResourceId = profileResourceIds[0]!;
    enforceRoutePolicy(request, {
      permission: "marketplace.profile.manage",
      resource: {
        product: "marketplace",
        resourceType: "hotel_profile",
        resourceId: profileResourceId,
        allowedRelationships: ["owner", "operator"],
      },
    });

    return {
      organizationId: context.selectedOrganization.organizationId,
      profileResourceId,
    };
  } catch (error) {
    const statusCode =
      typeof error === "object" && error !== null && "statusCode" in error
        ? Number((error as { statusCode?: unknown }).statusCode)
        : 500;
    if (statusCode === 401 || statusCode === 403) {
      reply
        .status(statusCode)
        .send({ detail: error instanceof Error ? error.message : "Forbidden" });
      return null;
    }
    throw error;
  }
}
