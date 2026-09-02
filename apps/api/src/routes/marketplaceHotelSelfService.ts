import { createHash, randomUUID } from "node:crypto";

import type {
  IdentityLifecycleCommandBus,
  RequestContext,
  ResourceRelationship,
} from "@vayada/backend-auth";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import pg, { type PoolClient } from "pg";

import {
  MarketplaceOfferConsistencyError,
  OFFER_SELECT_SQL,
  mapOfferRow,
  offerWriteAudit,
  readOffer,
  recordOfferMatchingAudit,
  replaceOfferChildren,
  syncOfferReadModel,
  syncPropertyOfferReadModels,
  validateCreateOfferRequest,
  validateMergedOfferUpdate,
  validateUpdateOfferRequest,
  type MarketplaceAdminCreateOfferRequest,
  type MarketplaceAdminOffer,
  type MarketplaceAdminUpdateOfferRequest,
  type MarketplaceOfferWriteAudit,
  type OfferRow,
} from "./marketplaceAdmin.js";
import { enforceRoutePolicy } from "./policy.js";

type PropertyParams = { propertyId: string };
type OfferParams = PropertyParams & { offerId: string };

export type MarketplaceHotelSelfServiceProfile = {
  propertyId: string;
  profileStatus: "pending" | "verified" | "rejected" | "suspended" | "archived";
  profileComplete: boolean;
  hostSummary: string | null;
  collaborationGuidelines: string | null;
  createdAt: string;
  updatedAt: string;
};

export type MarketplaceHotelSelfServiceOffer = Omit<
  MarketplaceAdminOffer,
  "contractVersion" | "authorizationMode"
> & { mediaResourceId: string };

type MarketplaceHotelSelfServiceOfferRecord = {
  offer: MarketplaceAdminOffer;
  offerResourceId: string;
};

type MarketplaceHotelSelfServiceOfferCreation = MarketplaceHotelSelfServiceOfferRecord & {
  replayed: boolean;
};

type MarketplaceHotelSelfServiceOfferCreationContinuation = {
  organizationId: string;
  propertyId: string;
  audit: MarketplaceOfferWriteAudit;
  idempotencyKey: string;
  request: MarketplaceAdminCreateOfferRequest;
  offerResourceId: string;
};

export type MarketplaceHotelSelfServiceRepository = {
  getProfile(
    organizationId: string,
    propertyId: string,
  ): Promise<MarketplaceHotelSelfServiceProfile | null>;
  updateProfile(input: {
    organizationId: string;
    propertyId: string;
    hostSummary?: string | null;
    collaborationGuidelines?: string | null;
  }): Promise<MarketplaceHotelSelfServiceProfile | null>;
  listOffers(
    organizationId: string,
    propertyId: string,
  ): Promise<MarketplaceHotelSelfServiceOfferRecord[]>;
  resolveOfferResourceId(
    organizationId: string,
    propertyId: string,
    offerId: string,
  ): Promise<string | null>;
  createOffer(input: {
    organizationId: string;
    propertyId: string;
    audit: MarketplaceOfferWriteAudit;
    idempotencyKey: string;
    request: MarketplaceAdminCreateOfferRequest;
  }): Promise<MarketplaceHotelSelfServiceOfferCreation | null>;
  completeOfferCreation(
    input: MarketplaceHotelSelfServiceOfferCreationContinuation,
  ): Promise<MarketplaceAdminOffer>;
  failOfferCreation(input: MarketplaceHotelSelfServiceOfferCreationContinuation): Promise<void>;
  updateOffer(input: {
    organizationId: string;
    propertyId: string;
    audit: MarketplaceOfferWriteAudit;
    offerResourceId: string;
    request: MarketplaceAdminUpdateOfferRequest;
  }): Promise<MarketplaceAdminOffer | null>;
  archiveOffer(input: {
    organizationId: string;
    propertyId: string;
    offerResourceId: string;
  }): Promise<boolean>;
  close?(): Promise<void>;
};

type MarketplaceHotelSelfServiceRoutesOptions = {
  repository: MarketplaceHotelSelfServiceRepository;
  lifecycleCommandBus: IdentityLifecycleCommandBus;
};

export async function registerMarketplaceHotelSelfServiceRoutes(
  app: FastifyInstance,
  options: MarketplaceHotelSelfServiceRoutesOptions,
): Promise<void> {
  const { lifecycleCommandBus, repository } = options;
  app.addHook("onClose", async () => repository.close?.());

  app.get<{ Params: PropertyParams }>("/properties/:propertyId/profile", async (request, reply) => {
    const access = requireProfileAccess(request, request.params.propertyId);
    const profile = await repository.getProfile(access.organizationId, request.params.propertyId);
    if (!profile) return sendError(reply, 404, "marketplace_profile_not_found");
    return profile;
  });

  app.put<{ Params: PropertyParams; Body: unknown }>(
    "/properties/:propertyId/profile",
    async (request, reply) => {
      const access = requireProfileAccess(request, request.params.propertyId);
      const parsed = parseProfileUpdate(request.body);
      if (typeof parsed === "string") return sendError(reply, 422, parsed);
      const profile = await repository.updateProfile({
        organizationId: access.organizationId,
        propertyId: request.params.propertyId,
        ...parsed,
      });
      if (!profile) return sendError(reply, 404, "marketplace_profile_not_found");
      return profile;
    },
  );

  app.get<{ Params: PropertyParams }>("/properties/:propertyId/offers", async (request) => {
    const access = requireProfileAccess(request, request.params.propertyId);
    const offers = await repository.listOffers(access.organizationId, request.params.propertyId);
    const authorizedOfferIds = new Set(
      activeOfferAccessLinks(
        access.context,
        offers.map(({ offerResourceId }) => offerResourceId),
      ).map(({ resourceId }) => resourceId),
    );
    return {
      offers: offers
        .filter(({ offerResourceId }) => authorizedOfferIds.has(offerResourceId))
        .map(({ offer, offerResourceId }) => toSelfServiceOffer(offer, offerResourceId)),
    };
  });

  app.post<{ Params: PropertyParams; Body: MarketplaceAdminCreateOfferRequest }>(
    "/properties/:propertyId/offers",
    async (request, reply) => {
      const access = requireProfileAccess(request, request.params.propertyId);
      const idempotencyKey = readIdempotencyKey(request);
      if (!idempotencyKey) return sendError(reply, 400, "idempotency_key_required");
      const validationError = validateCreateOfferRequest(request.body);
      if (validationError) return sendError(reply, 422, validationError);
      let created: MarketplaceHotelSelfServiceOfferCreation | null;
      try {
        created = await repository.createOffer({
          organizationId: access.organizationId,
          propertyId: request.params.propertyId,
          audit: offerWriteAudit(access.context),
          idempotencyKey,
          request: request.body,
        });
      } catch (error) {
        if (error instanceof MarketplaceOfferIdempotencyConflictError) {
          return sendError(reply, 409, "idempotency_conflict");
        }
        throw error;
      }
      if (!created) return sendError(reply, 404, "marketplace_profile_not_found");
      if (!created.replayed) {
        const continuation = {
          organizationId: access.organizationId,
          propertyId: request.params.propertyId,
          audit: offerWriteAudit(access.context),
          idempotencyKey,
          request: request.body,
          offerResourceId: created.offerResourceId,
        };
        try {
          await grantOfferAccess(lifecycleCommandBus, access.context, created.offerResourceId);
        } catch (error) {
          await repository.failOfferCreation(continuation);
          throw error;
        }
        created = {
          ...created,
          offer: await repository.completeOfferCreation(continuation),
        };
      }
      return reply.status(201).send(toSelfServiceOffer(created.offer, created.offerResourceId));
    },
  );

  app.put<{ Params: OfferParams; Body: MarketplaceAdminUpdateOfferRequest }>(
    "/properties/:propertyId/offers/:offerId",
    async (request, reply) => {
      const access = requireProfileAccess(request, request.params.propertyId);
      const validationError = validateUpdateOfferRequest(request.body);
      if (validationError) return sendError(reply, 422, validationError);
      const offerResourceId = await repository.resolveOfferResourceId(
        access.organizationId,
        request.params.propertyId,
        request.params.offerId,
      );
      if (!offerResourceId) return sendError(reply, 404, "marketplace_offer_not_found");
      requireOfferAccess(request, offerResourceId);
      let offer: MarketplaceAdminOffer | null;
      try {
        offer = await repository.updateOffer({
          organizationId: access.organizationId,
          propertyId: request.params.propertyId,
          audit: offerWriteAudit(access.context),
          offerResourceId,
          request: request.body,
        });
      } catch (error) {
        if (error instanceof MarketplaceOfferConsistencyError) {
          return sendError(reply, 422, error.code);
        }
        throw error;
      }
      if (!offer) return sendError(reply, 404, "marketplace_offer_not_found");
      return toSelfServiceOffer(offer, offerResourceId);
    },
  );

  app.delete<{ Params: OfferParams }>(
    "/properties/:propertyId/offers/:offerId",
    async (request, reply) => {
      const access = requireProfileAccess(request, request.params.propertyId);
      const offerResourceId = await repository.resolveOfferResourceId(
        access.organizationId,
        request.params.propertyId,
        request.params.offerId,
      );
      if (!offerResourceId) return sendError(reply, 404, "marketplace_offer_not_found");
      requireOfferAccess(request, offerResourceId);
      const resourceLinks = activeOfferAccessLinks(access.context, [offerResourceId]);
      const archived = await repository.archiveOffer({
        organizationId: access.organizationId,
        propertyId: request.params.propertyId,
        offerResourceId,
      });
      if (!archived) return sendError(reply, 404, "marketplace_offer_not_found");
      await revokeOfferAccess(lifecycleCommandBus, access.context, offerResourceId, resourceLinks);
      return reply.status(204).send();
    },
  );
}

export function createPgMarketplaceHotelSelfServiceRepository(config: {
  connectionString: string;
  max?: number;
  pool?: pg.Pool;
}): MarketplaceHotelSelfServiceRepository {
  if (!config.connectionString.trim()) {
    throw new Error("Marketplace hotel self-service repository connectionString must not be empty");
  }
  const pool =
    config.pool ?? new pg.Pool({ connectionString: config.connectionString, max: config.max });

  return {
    async getProfile(organizationId, propertyId) {
      return readProfile(pool, organizationId, propertyId);
    },
    async updateProfile(input) {
      return withTransaction(pool, async (client) => {
        const result = await client.query<{ propertyId: string }>(
          `UPDATE marketplace.marketplace_hotel_profiles
           SET host_summary = CASE WHEN $3::boolean THEN $4 ELSE host_summary END,
               collaboration_guidelines = CASE WHEN $5::boolean THEN $6 ELSE collaboration_guidelines END,
               profile_complete = NULLIF(btrim(CASE WHEN $3::boolean THEN COALESCE($4, '') ELSE COALESCE(host_summary, '') END), '') IS NOT NULL,
               profile_completed_at = CASE
                 WHEN NULLIF(btrim(CASE WHEN $3::boolean THEN COALESCE($4, '') ELSE COALESCE(host_summary, '') END), '') IS NOT NULL
                   THEN COALESCE(profile_completed_at, now())
                 ELSE NULL
               END,
               updated_at = now()
           WHERE organization_id = $1::uuid AND property_id = $2::uuid
           RETURNING property_id::text AS "propertyId"`,
          [
            input.organizationId,
            input.propertyId,
            input.hostSummary !== undefined,
            input.hostSummary ?? null,
            input.collaborationGuidelines !== undefined,
            input.collaborationGuidelines ?? null,
          ],
        );
        if (!result.rows[0]) return null;
        await syncPropertyOfferReadModels(client, {
          propertyId: input.propertyId,
        });
        return readProfile(client, input.organizationId, input.propertyId);
      });
    },
    async listOffers(organizationId, propertyId) {
      const result = await pool.query<OfferRow>(
        `${OFFER_SELECT_SQL}
         WHERE offer.organization_id = $1::uuid
           AND offer.property_id = $2::uuid
           AND offer.offer_status <> 'archived'
         ORDER BY offer.created_at ASC, offer.id ASC`,
        [organizationId, propertyId],
      );
      return result.rows.map((row) => ({
        offer: mapOfferRow(row, "platform_organization_membership"),
        offerResourceId: row.offerId,
      }));
    },
    async resolveOfferResourceId(organizationId, propertyId, offerId) {
      const result = await pool.query<{ id: string }>(
        `SELECT id::text AS id
         FROM marketplace.marketplace_offers
         WHERE organization_id = $1::uuid
           AND property_id = $2::uuid
           AND id::text = $3
         LIMIT 1`,
        [organizationId, propertyId, offerId],
      );
      return result.rows[0]?.id ?? null;
    },
    async createOffer(input) {
      return withTransaction(pool, async (client) => {
        const keyHash = sha256(input.idempotencyKey);
        const fingerprint = sha256(stableJson(input.request));
        const existing = await findOfferCreationIdempotency(client, input, keyHash);
        if (existing) {
          return replayOfferCreation(client, input, existing, fingerprint);
        }

        const idempotencyId = await reserveOfferCreationIdempotency(
          client,
          input,
          keyHash,
          fingerprint,
        );
        if (!idempotencyId) {
          const raced = await findOfferCreationIdempotency(client, input, keyHash);
          if (!raced) throw new MarketplaceOfferIdempotencyConflictError();
          return replayOfferCreation(client, input, raced, fingerprint);
        }

        const offer = await client.query<{ id: string }>(
          `INSERT INTO marketplace.marketplace_offers (
             property_id, organization_id, source_system,
             title, offer_summary, offer_status
           )
           SELECT $1::uuid, $2::uuid, 'marketplace', $3, $4, 'pending'
           FROM marketplace.marketplace_hotel_profiles profile
           WHERE profile.property_id = $1::uuid AND profile.organization_id = $2::uuid
           RETURNING id::text AS id`,
          [
            input.propertyId,
            input.organizationId,
            input.request.title.trim(),
            input.request.offerSummary ?? null,
          ],
        );
        const offerId = offer.rows[0]?.id;
        if (!offerId) {
          await client.query(`DELETE FROM platform.idempotency_keys WHERE id = $1::uuid`, [
            idempotencyId,
          ]);
          return null;
        }
        await replaceOfferChildren(client, {
          offerId,
          propertyId: input.propertyId,
          organizationId: input.organizationId,
          deliverables: input.request.deliverables,
          compensationOptions: input.request.compensationOptions,
          creatorRequirements: input.request.creatorRequirements,
          matchingCriteria: input.request.matchingCriteria,
          actorUserId: input.audit.actorUserId,
        });
        await recordOfferMatchingAudit(client, {
          action: "created",
          offerId,
          propertyId: input.propertyId,
          request: input.request,
          audit: input.audit,
        });
        await syncOfferReadModel(client, offerId, "initialize");
        const offerDocument = await readOffer(client, offerId, "platform_organization_membership");
        if (!offerDocument) throw new Error("Created Marketplace offer could not be reconciled");
        await attachOfferCreationResource(client, {
          idempotencyId,
          fingerprint,
          offerResourceId: offerId,
        });
        return { offer: offerDocument, offerResourceId: offerId, replayed: false };
      });
    },
    async completeOfferCreation(input) {
      return withTransaction(pool, async (client) => {
        const keyHash = sha256(input.idempotencyKey);
        const fingerprint = sha256(stableJson(input.request));
        const row = await findOfferCreationIdempotency(client, input, keyHash);
        validateOfferCreationContinuation(row, input, fingerprint);

        if (row.status === "completed") {
          const replay = await readOfferForOrganization(client, input, input.offerResourceId);
          if (!replay) {
            throw new MarketplaceOfferIdempotencyConflictError();
          }
          return replay;
        }

        const restoreArchivedOffer = row.idempotencyMetadata.accessGrantFailed === true;
        const restored = await client.query<{ id: string }>(
          `UPDATE marketplace.marketplace_offers
           SET offer_status = CASE
                 WHEN offer_status = 'archived' AND $4::boolean THEN 'pending'
                 ELSE offer_status
               END,
               updated_at = CASE
                 WHEN offer_status = 'archived' AND $4::boolean THEN now()
                 ELSE updated_at
               END
           WHERE id = $1::uuid
             AND organization_id = $2::uuid
             AND property_id = $3::uuid
             AND (offer_status <> 'archived' OR $4::boolean)
           RETURNING id::text AS id`,
          [input.offerResourceId, input.organizationId, input.propertyId, restoreArchivedOffer],
        );
        if (!restored.rows[0]) throw new MarketplaceOfferIdempotencyConflictError();

        await syncOfferReadModel(client, input.offerResourceId, "initialize");
        const offer = await readOfferForOrganization(client, input, input.offerResourceId);
        if (!offer) {
          throw new MarketplaceOfferIdempotencyConflictError();
        }
        await completeOfferCreationIdempotency(client, {
          idempotencyId: row.id,
          fingerprint,
          offerResourceId: input.offerResourceId,
        });
        return offer;
      });
    },
    async failOfferCreation(input) {
      await withTransaction(pool, async (client) => {
        const keyHash = sha256(input.idempotencyKey);
        const fingerprint = sha256(stableJson(input.request));
        const row = await findOfferCreationIdempotency(client, input, keyHash);
        validateOfferCreationContinuation(row, input, fingerprint);
        if (row.status === "completed") return;

        const archived = await client.query<{ id: string }>(
          `UPDATE marketplace.marketplace_offers
           SET offer_status = 'archived', updated_at = now()
           WHERE id = $1::uuid
             AND organization_id = $2::uuid
             AND property_id = $3::uuid
             AND offer_status <> 'archived'
           RETURNING id::text AS id`,
          [input.offerResourceId, input.organizationId, input.propertyId],
        );
        if (archived.rows[0]) {
          await syncOfferReadModel(client, input.offerResourceId, "disable");
        }
        await client.query(
          `UPDATE platform.idempotency_keys
           SET last_seen_at = now(),
               idempotency_metadata = idempotency_metadata || $2::jsonb
           WHERE id = $1::uuid AND status = 'in_progress'`,
          [row.id, JSON.stringify({ accessGrantFailed: true })],
        );
      });
    },
    async updateOffer(input) {
      return withTransaction(pool, async (client) => {
        const result = await client.query<{ id: string }>(
          `UPDATE marketplace.marketplace_offers
           SET title = CASE WHEN $4::boolean THEN $5 ELSE title END,
               offer_summary = CASE WHEN $6::boolean THEN $7 ELSE offer_summary END,
               updated_at = now()
           WHERE id = $1::uuid AND organization_id = $2::uuid AND property_id = $3::uuid
             AND offer_status <> 'archived'
           RETURNING id::text AS id`,
          [
            input.offerResourceId,
            input.organizationId,
            input.propertyId,
            input.request.title !== undefined,
            input.request.title?.trim() ?? null,
            input.request.offerSummary !== undefined,
            input.request.offerSummary ?? null,
          ],
        );
        if (!result.rows[0]) return null;
        if (
          input.request.deliverables !== undefined ||
          input.request.compensationOptions !== undefined ||
          input.request.creatorRequirements !== undefined ||
          input.request.matchingCriteria !== undefined
        ) {
          const current = await readOffer(
            client,
            input.offerResourceId,
            "platform_organization_membership",
          );
          if (!current) return null;
          const consistencyError = validateMergedOfferUpdate(current, input.request);
          if (consistencyError) throw new MarketplaceOfferConsistencyError(consistencyError);
          await replaceOfferChildren(client, {
            offerId: input.offerResourceId,
            propertyId: input.propertyId,
            organizationId: input.organizationId,
            deliverables: input.request.deliverables,
            compensationOptions: input.request.compensationOptions,
            creatorRequirements: input.request.creatorRequirements,
            matchingCriteria: input.request.matchingCriteria,
            actorUserId: input.audit.actorUserId,
          });
          await recordOfferMatchingAudit(client, {
            action: "updated",
            offerId: input.offerResourceId,
            propertyId: input.propertyId,
            request: input.request,
            audit: input.audit,
          });
        }
        await syncOfferReadModel(client, input.offerResourceId, "initialize");
        return readOffer(client, input.offerResourceId, "platform_organization_membership");
      });
    },
    async archiveOffer(input) {
      return withTransaction(pool, async (client) => {
        const result = await client.query<{ id: string }>(
          `UPDATE marketplace.marketplace_offers
           SET offer_status = 'archived', updated_at = now()
           WHERE id = $1::uuid AND organization_id = $2::uuid AND property_id = $3::uuid
             AND offer_status <> 'archived'
           RETURNING id::text AS id`,
          [input.offerResourceId, input.organizationId, input.propertyId],
        );
        if (result.rows[0]) {
          await syncOfferReadModel(client, input.offerResourceId, "disable");
          return true;
        }
        const existing = await client.query<{ exists: boolean }>(
          `SELECT EXISTS (
             SELECT 1
             FROM marketplace.marketplace_offers
             WHERE id = $1::uuid
               AND organization_id = $2::uuid
               AND property_id = $3::uuid
               AND offer_status = 'archived'
           ) AS exists`,
          [input.offerResourceId, input.organizationId, input.propertyId],
        );
        return existing.rows[0]?.exists ?? false;
      });
    },
    async close() {
      await pool.end();
    },
  };
}

function requireProfileAccess(
  request: FastifyRequest,
  propertyId: string,
): {
  context: RequestContext;
  organizationId: string;
} {
  const context = enforceRoutePolicy(request, {
    permission: "marketplace.profile.manage",
    entitlement: {
      product: "marketplace",
      key: "marketplace-hotel-profile",
      resource: { product: "marketplace", resourceType: "hotel_profile", resourceId: propertyId },
    },
    resource: {
      product: "marketplace",
      resourceType: "hotel_profile",
      resourceId: propertyId,
      allowedRelationships: ["owner", "operator"],
    },
  });
  if (context.selectedOrganization.kind !== "hotel_group") {
    throw Object.assign(new Error("Marketplace hotel tools require a hotel account"), {
      statusCode: 403,
    });
  }
  return {
    context,
    organizationId: context.selectedOrganization.organizationId,
  };
}

function requireOfferAccess(request: FastifyRequest, offerResourceId: string): void {
  enforceRoutePolicy(request, {
    permission: "marketplace.profile.manage",
    entitlement: { product: "marketplace", key: "marketplace-hotel-profile" },
    resource: {
      product: "marketplace",
      resourceType: "marketplace_offer",
      resourceId: offerResourceId,
      allowedRelationships: ["owner", "operator"],
    },
  });
}

function activeOfferAccessLinks(
  context: RequestContext,
  resourceIds: string[],
): Array<{ resourceId: string; relationship: ResourceRelationship }> {
  const expectedResourceIds = new Set(resourceIds);
  const links = context.linkedResources
    .filter(
      (resource) =>
        resource.status === "active" &&
        resource.product === "marketplace" &&
        resource.resourceType === "marketplace_offer" &&
        expectedResourceIds.has(resource.resourceId) &&
        (resource.relationship === "owner" || resource.relationship === "operator"),
    )
    .map((resource) => ({
      resourceId: resource.resourceId,
      relationship: resource.relationship,
    }));

  return links.filter(
    (link, index) =>
      links.findIndex(
        (candidate) =>
          candidate.resourceId === link.resourceId && candidate.relationship === link.relationship,
      ) === index,
  );
}

async function grantOfferAccess(
  lifecycleCommandBus: IdentityLifecycleCommandBus,
  context: RequestContext,
  offerResourceId: string,
): Promise<void> {
  await lifecycleCommandBus.execute({
    commandType: "identity.resource_links.grant",
    commandId: randomUUID(),
    idempotencyKey: `marketplace-offer:${context.selectedOrganization.organizationId}:${offerResourceId}:operator`,
    audit: offerAccessAudit(context, "Grant Marketplace offer access"),
    payload: {
      organizationId: context.selectedOrganization.organizationId,
      resourceLinks: [
        {
          product: "marketplace",
          resourceType: "marketplace_offer",
          resourceId: offerResourceId,
          relationship: "operator",
          status: "active",
        },
      ],
    },
  });
}

async function revokeOfferAccess(
  lifecycleCommandBus: IdentityLifecycleCommandBus,
  context: RequestContext,
  offerResourceId: string,
  resourceLinks: Array<{ resourceId: string; relationship: ResourceRelationship }>,
): Promise<void> {
  await lifecycleCommandBus.execute({
    commandType: "identity.access.revoke",
    commandId: randomUUID(),
    idempotencyKey: `marketplace-offer:${context.selectedOrganization.organizationId}:${offerResourceId}:archive`,
    audit: offerAccessAudit(context, "Archive Marketplace offer access"),
    payload: {
      userId: context.actor.internalUserId,
      organizationId: context.selectedOrganization.organizationId,
      resourceLinks: resourceLinks.map(({ resourceId, relationship }) => ({
        product: "marketplace" as const,
        resourceType: "marketplace_offer" as const,
        resourceId,
        relationship,
        status: "archived" as const,
      })),
    },
  });
}

function offerAccessAudit(context: RequestContext, reason: string) {
  return {
    actor: {
      kind: "user" as const,
      userId: context.actor.internalUserId,
      organizationId: context.selectedOrganization.organizationId,
    },
    source: context.audit.source,
    requestId: context.audit.requestId,
    correlationId: context.audit.correlationId,
    reason,
    requestedAt: context.audit.receivedAt,
  };
}

function parseProfileUpdate(
  body: unknown,
): { hostSummary?: string | null; collaborationGuidelines?: string | null } | string {
  if (!isRecord(body)) return "body_required";
  const allowed = new Set(["hostSummary", "collaborationGuidelines"]);
  if (Object.keys(body).some((key) => !allowed.has(key))) return "canonical_property_read_only";
  const parsed: { hostSummary?: string | null; collaborationGuidelines?: string | null } = {};
  for (const key of allowed) {
    if (!(key in body)) continue;
    const value = body[key];
    if (value !== null && typeof value !== "string") return `invalid_${key}`;
    parsed[key as "hostSummary" | "collaborationGuidelines"] = value?.trim() || null;
  }
  return Object.keys(parsed).length > 0 ? parsed : "body_required";
}

async function readProfile(
  pool: Pick<pg.Pool, "query">,
  organizationId: string,
  propertyId: string,
): Promise<MarketplaceHotelSelfServiceProfile | null> {
  const result = await pool.query<{
    propertyId: string;
    profileStatus: MarketplaceHotelSelfServiceProfile["profileStatus"];
    profileComplete: boolean;
    hostSummary: string | null;
    collaborationGuidelines: string | null;
    createdAt: Date | string;
    updatedAt: Date | string;
  }>(
    `SELECT property_id::text AS "propertyId",
            marketplace_profile_status AS "profileStatus",
            profile_complete AS "profileComplete",
            host_summary AS "hostSummary",
            collaboration_guidelines AS "collaborationGuidelines",
            created_at AS "createdAt",
            updated_at AS "updatedAt"
     FROM marketplace.marketplace_hotel_profiles
     WHERE organization_id = $1::uuid AND property_id = $2::uuid`,
    [organizationId, propertyId],
  );
  const row = result.rows[0];
  return row
    ? {
        ...row,
        createdAt: toIsoString(row.createdAt),
        updatedAt: toIsoString(row.updatedAt),
      }
    : null;
}

async function withTransaction<T>(
  pool: pg.Pool,
  operation: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await operation(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

type OfferCreationInput = {
  organizationId: string;
  propertyId: string;
  audit: MarketplaceOfferWriteAudit;
  idempotencyKey: string;
  request: MarketplaceAdminCreateOfferRequest;
};

type OfferCreationIdempotencyRow = {
  id: string;
  status: string;
  requestFingerprintHash: string;
  responseResourceId: string | null;
  idempotencyMetadata: Record<string, unknown>;
};

export class MarketplaceOfferIdempotencyConflictError extends Error {
  constructor() {
    super("Marketplace offer idempotency key is already in use");
    this.name = "MarketplaceOfferIdempotencyConflictError";
  }
}

async function findOfferCreationIdempotency(
  client: PoolClient,
  input: OfferCreationInput,
  keyHash: string,
): Promise<OfferCreationIdempotencyRow | null> {
  const result = await client.query<OfferCreationIdempotencyRow>(
    `SELECT id::text AS id,
            status,
            request_fingerprint_hash AS "requestFingerprintHash",
            response_resource_id AS "responseResourceId",
            idempotency_metadata AS "idempotencyMetadata"
     FROM platform.idempotency_keys
     WHERE operation_scope = 'marketplace'
       AND operation = 'marketplace.hotel_offer.create'
       AND key_hash = $1
       AND tenant_scope = 'organization'
       AND organization_id = $2::uuid
       AND property_id IS NULL
     LIMIT 1
     FOR UPDATE`,
    [keyHash, input.organizationId],
  );
  return result.rows[0] ?? null;
}

async function reserveOfferCreationIdempotency(
  client: PoolClient,
  input: OfferCreationInput,
  keyHash: string,
  fingerprint: string,
): Promise<string | null> {
  const result = await client.query<{ id: string }>(
    `INSERT INTO platform.idempotency_keys (
       operation_scope, operation, key_hash, request_fingerprint_hash, status,
       tenant_scope, organization_id, expires_at, idempotency_metadata
     ) VALUES (
       'marketplace', 'marketplace.hotel_offer.create', $1, $2, 'in_progress',
       'organization', $3::uuid, now() + interval '7 days', '{}'::jsonb
     )
     ON CONFLICT (operation_scope, operation, key_hash, scope_key) DO NOTHING
     RETURNING id::text AS id`,
    [keyHash, fingerprint, input.organizationId],
  );
  return result.rows[0]?.id ?? null;
}

async function replayOfferCreation(
  client: PoolClient,
  input: OfferCreationInput,
  row: OfferCreationIdempotencyRow,
  fingerprint: string,
): Promise<MarketplaceHotelSelfServiceOfferCreation> {
  if (row.requestFingerprintHash !== fingerprint || !row.responseResourceId) {
    throw new MarketplaceOfferIdempotencyConflictError();
  }
  if (row.status !== "completed" && row.status !== "in_progress") {
    throw new MarketplaceOfferIdempotencyConflictError();
  }
  const offer = await readOfferForOrganization(client, input, row.responseResourceId);
  if (!offer) {
    throw new MarketplaceOfferIdempotencyConflictError();
  }
  return {
    offer,
    offerResourceId: row.responseResourceId,
    replayed: row.status === "completed",
  };
}

async function readOfferForOrganization(
  client: PoolClient,
  input: Pick<OfferCreationInput, "organizationId" | "propertyId">,
  offerResourceId: string,
): Promise<MarketplaceAdminOffer | null> {
  const result = await client.query<OfferRow>(
    `${OFFER_SELECT_SQL}
     WHERE offer.id = $1::uuid
       AND offer.organization_id = $2::uuid
       AND offer.property_id = $3::uuid
       AND EXISTS (
         SELECT 1
         FROM marketplace.marketplace_hotel_profiles profile
         WHERE profile.property_id = offer.property_id
           AND profile.organization_id = offer.organization_id
       )
     LIMIT 1`,
    [offerResourceId, input.organizationId, input.propertyId],
  );
  const row = result.rows[0];
  return row ? mapOfferRow(row, "platform_organization_membership") : null;
}

function validateOfferCreationContinuation(
  row: OfferCreationIdempotencyRow | null,
  input: MarketplaceHotelSelfServiceOfferCreationContinuation,
  fingerprint: string,
): asserts row is OfferCreationIdempotencyRow {
  if (
    !row ||
    row.requestFingerprintHash !== fingerprint ||
    row.responseResourceId !== input.offerResourceId ||
    (row.status !== "in_progress" && row.status !== "completed")
  ) {
    throw new MarketplaceOfferIdempotencyConflictError();
  }
}

async function attachOfferCreationResource(
  client: PoolClient,
  input: { idempotencyId: string; fingerprint: string; offerResourceId: string },
): Promise<void> {
  const result = await client.query(
    `UPDATE platform.idempotency_keys
     SET request_fingerprint_hash = $2,
         response_resource_product = 'marketplace',
         response_resource_type = 'marketplace_offer',
         response_resource_id = $3,
         last_seen_at = now(),
         idempotency_metadata = idempotency_metadata || $4::jsonb
     WHERE id = $1::uuid AND status = 'in_progress'`,
    [
      input.idempotencyId,
      input.fingerprint,
      input.offerResourceId,
      JSON.stringify({ accessGrantFailed: false }),
    ],
  );
  if (result.rowCount !== 1) throw new MarketplaceOfferIdempotencyConflictError();
}

async function completeOfferCreationIdempotency(
  client: PoolClient,
  input: { idempotencyId: string; fingerprint: string; offerResourceId: string },
): Promise<void> {
  const result = await client.query(
    `UPDATE platform.idempotency_keys
     SET status = 'completed',
         request_fingerprint_hash = $2,
         response_status_code = 201,
         response_body_hash = $3,
         response_resource_product = 'marketplace',
         response_resource_type = 'marketplace_offer',
         response_resource_id = $4,
         completed_at = now(),
         last_seen_at = now(),
         idempotency_metadata = idempotency_metadata || $5::jsonb
     WHERE id = $1::uuid
       AND status = 'in_progress'
       AND response_resource_id = $4`,
    [
      input.idempotencyId,
      input.fingerprint,
      sha256(stableJson({ offerResourceId: input.offerResourceId })),
      input.offerResourceId,
      JSON.stringify({ accessGrantFailed: false }),
    ],
  );
  if (result.rowCount !== 1) throw new MarketplaceOfferIdempotencyConflictError();
}

function toSelfServiceOffer(
  offer: MarketplaceAdminOffer,
  mediaResourceId: string,
): MarketplaceHotelSelfServiceOffer {
  const {
    contractVersion: _contractVersion,
    authorizationMode: _authorizationMode,
    ...value
  } = offer;
  return { ...value, mediaResourceId };
}

function sendError(reply: FastifyReply, statusCode: number, code: string) {
  return reply.status(statusCode).send({ code, detail: code.replaceAll("_", " ") });
}

function readIdempotencyKey(request: FastifyRequest): string | null {
  const raw = request.headers["idempotency-key"];
  const value = typeof raw === "string" ? raw.trim() : "";
  return value && value.length <= 200 ? value : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function toIsoString(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function stableJson(value: unknown): string {
  return JSON.stringify(sortJson(value));
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJson);
  if (!isRecord(value)) return value;
  return Object.fromEntries(
    Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => [key, sortJson(entry)]),
  );
}
