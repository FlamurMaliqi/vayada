import pg from "pg";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { RequestContext } from "@vayada/backend-auth";
import { enforceRoutePolicy } from "./policy.js";

export type PmsReview = {
  reviewId: string;
  channel: string | null;
  guestDisplayName: string | null;
  rating: string | null;
  body: string;
  replyBody: string | null;
  reviewedAt: string | null;
  updatedAt: string;
};

export type PmsReviewRepository = {
  list(
    context: RequestContext,
    propertyId: string,
    filters: { channel?: string; minRating?: number; limit: number; offset: number },
  ): Promise<{ items: PmsReview[]; total: number }>;
  close?(): Promise<void>;
};

export function createPgPmsReviewRepository(config: {
  connectionString: string;
}): PmsReviewRepository {
  const pool = new pg.Pool({ connectionString: config.connectionString, max: 5 });
  return {
    async list(_context, propertyId, filters) {
      const values: unknown[] = [propertyId];
      const where = ["property_id = $1"];
      if (filters.channel) {
        values.push(filters.channel);
        where.push(`channel = $${values.length}`);
      }
      if (filters.minRating !== undefined) {
        values.push(filters.minRating);
        where.push(`rating >= $${values.length}`);
      }
      const countValues = values.slice();
      const count = await pool.query<{ total: string }>(
        `SELECT count(*)::text AS total FROM pms.channel_reviews WHERE ${where.join(" AND ")}`,
        countValues,
      );
      values.push(filters.limit, filters.offset);
      const result = await pool.query<PmsReview>(
        `SELECT provider_review_id AS "reviewId", channel,
           guest_display_name AS "guestDisplayName", rating::text, body,
           reply_body AS "replyBody", reviewed_at AS "reviewedAt",
           updated_at AS "updatedAt"
         FROM pms.channel_reviews WHERE ${where.join(" AND ")}
         ORDER BY COALESCE(reviewed_at, created_at) DESC
         LIMIT $${values.length - 1} OFFSET $${values.length}`,
        values,
      );
      return {
        items: result.rows,
        total: Number(count.rows[0]?.total ?? 0),
      };
    },
    async close() {
      await pool.end();
    },
  };
}

export async function registerPmsReviewRoutes(
  app: FastifyInstance,
  options: { repository: PmsReviewRepository },
): Promise<void> {
  app.addHook("onClose", () => options.repository.close?.());
  app.get<{
    Params: { propertyId: string };
    Querystring: { channel?: string; minRating?: string; limit?: string; offset?: string };
  }>("/properties/:propertyId/reviews", async (request, reply) => {
    const { propertyId } = request.params;
    const context = enforceReviewPolicy(request, propertyId);
    const limit = boundedInteger(request.query.limit, 50, 1, 100);
    const offset = boundedInteger(request.query.offset, 0, 0, 100_000);
    const minRating = request.query.minRating
      ? Number.parseFloat(request.query.minRating)
      : undefined;
    if (minRating !== undefined && (!Number.isFinite(minRating) || minRating < 0)) {
      return reply.status(400).send({ code: "invalid_min_rating" });
    }
    const result = await options.repository.list(context, propertyId, {
      channel: request.query.channel?.trim() || undefined,
      minRating,
      limit,
      offset,
    });
    return { propertyId, items: result.items, pagination: { total: result.total, limit, offset } };
  });
}

function enforceReviewPolicy(request: FastifyRequest, propertyId: string): RequestContext {
  return enforceRoutePolicy(request, {
    permission: "pms.operations.read",
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

function boundedInteger(value: string | undefined, fallback: number, min: number, max: number) {
  if (!value) return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) ? Math.min(max, Math.max(min, parsed)) : fallback;
}
