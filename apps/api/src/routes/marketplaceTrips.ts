import { createHash } from "node:crypto";

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import pg, { type PoolClient, type QueryResult, type QueryResultRow } from "pg";

import { enforceRoutePolicy } from "./policy.js";

export const MARKETPLACE_TRIPS_CONTRACT_VERSION = "marketplace-trips-external.v1" as const;

export type MarketplaceTripsContractVersion = typeof MARKETPLACE_TRIPS_CONTRACT_VERSION;
export type MarketplaceTripsAuthorizationMode = "creator_workspace_resource_link";
export type MarketplaceExternalCollaborationType =
  | "custom_external"
  | "paid"
  | "free_stay"
  | "affiliate"
  | "other";

export type MarketplaceExternalCollaboration = {
  contractVersion: MarketplaceTripsContractVersion;
  authorizationMode: MarketplaceTripsAuthorizationMode;
  externalCollaborationId: string;
  creatorProfileId: string;
  organizationId: string;
  tripId: string | null;
  sourceExternalCollaborationId: string | null;
  title: string;
  hotelName: string | null;
  locationText: string | null;
  collaborationType: MarketplaceExternalCollaborationType | null;
  startDate: string;
  endDate: string;
  deliverablesSummary: string | null;
  notes: string | null;
  createdAt: string;
  updatedAt: string;
};

export type MarketplaceTrip = {
  contractVersion: MarketplaceTripsContractVersion;
  authorizationMode: MarketplaceTripsAuthorizationMode;
  tripId: string;
  creatorProfileId: string;
  organizationId: string;
  sourceTripId: string | null;
  name: string;
  locationText: string | null;
  startDate: string;
  endDate: string;
  notes: string | null;
  externalCollaborations: MarketplaceExternalCollaboration[];
  createdAt: string;
  updatedAt: string;
};

export type MarketplaceTripListResponse = {
  contractVersion: MarketplaceTripsContractVersion;
  authorizationMode: MarketplaceTripsAuthorizationMode;
  creatorProfileId: string;
  organizationId: string;
  items: MarketplaceTrip[];
};

export type MarketplaceExternalCollaborationListResponse = {
  contractVersion: MarketplaceTripsContractVersion;
  authorizationMode: MarketplaceTripsAuthorizationMode;
  creatorProfileId: string;
  organizationId: string;
  items: MarketplaceExternalCollaboration[];
};

export type MarketplaceTripReadRepository = {
  listTripsForCreatorProfile(creatorProfileId: string): Promise<MarketplaceTrip[]>;
  findTripForCreatorProfile(
    creatorProfileId: string,
    tripId: string,
  ): Promise<MarketplaceTrip | null>;
  listExternalCollaborationsForCreatorProfile(
    creatorProfileId: string,
  ): Promise<MarketplaceExternalCollaboration[]>;
  createTrip?(input: MarketplaceTripCreateInput): Promise<MarketplaceTrip>;
  updateTrip?(input: MarketplaceTripUpdateInput): Promise<MarketplaceTrip | null>;
  deleteTrip?(input: MarketplaceTripDeleteInput): Promise<boolean>;
  createExternalCollaboration?(
    input: MarketplaceExternalCollaborationCreateInput,
  ): Promise<MarketplaceExternalCollaboration | null>;
  updateExternalCollaboration?(
    input: MarketplaceExternalCollaborationUpdateInput,
  ): Promise<MarketplaceExternalCollaboration | null>;
  deleteExternalCollaboration?(
    input: MarketplaceExternalCollaborationDeleteInput,
  ): Promise<boolean>;
  close?(): Promise<void>;
};

export type MarketplaceTripDraft = {
  name: string;
  locationText: string | null;
  startDate: string;
  endDate: string;
  notes: string | null;
};

export type MarketplaceTripPatch = Partial<MarketplaceTripDraft>;

export type MarketplaceExternalCollaborationDraft = {
  tripId: string | null;
  title: string;
  hotelName: string | null;
  locationText: string | null;
  collaborationType: MarketplaceExternalCollaborationType | null;
  startDate: string;
  endDate: string;
  deliverablesSummary: string | null;
  notes: string | null;
};

export type MarketplaceExternalCollaborationPatch = Partial<MarketplaceExternalCollaborationDraft>;

type MarketplaceTripCommand = {
  idempotencyKey: string;
  fingerprintPayload: unknown;
  actorUserId: string;
  requestId: string;
  correlationId: string;
  source: string;
  occurredAt: string;
};

type MarketplaceTripAccess = {
  creatorProfileId: string;
  organizationId: string;
  actorUserId: string;
  requestId: string;
  correlationId: string;
  source: string;
  occurredAt: string;
};

type MarketplaceTripWriteContext = Pick<
  MarketplaceTripAccess,
  "creatorProfileId" | "organizationId"
> & {
  command: MarketplaceTripCommand;
};

export type MarketplaceTripCreateInput = MarketplaceTripWriteContext & {
  trip: MarketplaceTripDraft;
};

export type MarketplaceTripUpdateInput = MarketplaceTripWriteContext & {
  tripId: string;
  patch: MarketplaceTripPatch;
};

export type MarketplaceTripDeleteInput = MarketplaceTripWriteContext & { tripId: string };

export type MarketplaceExternalCollaborationCreateInput = MarketplaceTripWriteContext & {
  collaboration: MarketplaceExternalCollaborationDraft;
};

export type MarketplaceExternalCollaborationUpdateInput = MarketplaceTripWriteContext & {
  externalCollaborationId: string;
  patch: MarketplaceExternalCollaborationPatch;
};

export type MarketplaceExternalCollaborationDeleteInput = MarketplaceTripWriteContext & {
  externalCollaborationId: string;
};

type MarketplaceTripQueryable = {
  query<T extends QueryResultRow = QueryResultRow>(
    text: string,
    values?: readonly unknown[],
  ): Promise<Pick<QueryResult<T>, "rows" | "rowCount">>;
};

export type MarketplaceTripPool = MarketplaceTripQueryable & {
  connect(): Promise<PoolClient>;
  end(): Promise<void>;
};

export type MarketplaceTripRoutesOptions = {
  repository: MarketplaceTripReadRepository;
};

type TripParams = {
  tripId: string;
};

type ExternalCollaborationParams = {
  externalCollaborationId: string;
};

type TripBody = {
  name?: unknown;
  locationText?: unknown;
  startDate?: unknown;
  endDate?: unknown;
  notes?: unknown;
};

type ExternalCollaborationBody = {
  tripId?: unknown;
  title?: unknown;
  hotelName?: unknown;
  locationText?: unknown;
  collaborationType?: unknown;
  startDate?: unknown;
  endDate?: unknown;
  deliverablesSummary?: unknown;
  notes?: unknown;
};

type MarketplaceTripErrorCategory =
  | "authentication"
  | "authorization"
  | "validation"
  | "conflict"
  | "not_found"
  | "write_model"
  | "read_model";

type MarketplaceTripErrorCode =
  | "unauthorized"
  | "missing_permission"
  | "forbidden"
  | "missing_creator_resource_link"
  | "invalid_request"
  | "idempotency_conflict"
  | "trip_not_found"
  | "external_collaboration_not_found"
  | "write_model_unavailable"
  | "read_model_unavailable";

export type MarketplaceTripError = {
  statusCode: 400 | 401 | 403 | 404 | 409 | 500;
  code: MarketplaceTripErrorCode;
  category: MarketplaceTripErrorCategory;
  message: string;
};

export async function registerMarketplaceTripRoutes(
  app: FastifyInstance,
  options: MarketplaceTripRoutesOptions,
): Promise<void> {
  const { repository } = options;

  app.addHook("onClose", async () => {
    await repository.close?.();
  });

  app.get("/trips", async (request, reply) => {
    const access = resolveMarketplaceTripAccess(request, reply, "marketplace.trip.read");
    if (!access) return reply;

    try {
      const items = await repository.listTripsForCreatorProfile(access.creatorProfileId);
      const scopedItems = items.filter((item) => item.organizationId === access.organizationId);
      return {
        contractVersion: MARKETPLACE_TRIPS_CONTRACT_VERSION,
        authorizationMode: "creator_workspace_resource_link",
        creatorProfileId: access.creatorProfileId,
        organizationId: access.organizationId,
        items: scopedItems.map(normalizeTrip),
      } satisfies MarketplaceTripListResponse;
    } catch (error) {
      request.log.error({ error }, "Failed to list marketplace trips");
      return sendMarketplaceTripError(reply, {
        statusCode: 500,
        code: "read_model_unavailable",
        category: "read_model",
        message: "Marketplace trip read model is unavailable.",
      });
    }
  });

  app.post<{ Body: TripBody }>("/trips", async (request, reply) => {
    const access = resolveMarketplaceTripAccess(request, reply, "marketplace.trip.manage");
    if (!access) return reply;
    if (!repository.createTrip) return sendMarketplaceTripError(reply, writeUnavailable());
    const trip = parseTripDraft(request.body);
    if (!trip.ok) return sendMarketplaceTripError(reply, trip.error);
    const write = parseMarketplaceTripWriteContext(request, access, {
      action: "trip.create",
      payload: trip.value,
    });
    if (!write.ok) return sendMarketplaceTripError(reply, write.error);

    const created = await executeMarketplaceTripWrite(request, reply, () =>
      repository.createTrip!({ ...write.value, trip: trip.value }),
    );
    if (isReply(created)) return created;
    reply.code(201);
    return normalizeTrip(created);
  });

  app.get("/trips/external-collaborations", async (request, reply) => {
    const access = resolveMarketplaceTripAccess(request, reply, "marketplace.trip.read");
    if (!access) return reply;

    try {
      const items = await repository.listExternalCollaborationsForCreatorProfile(
        access.creatorProfileId,
      );
      const scopedItems = items.filter((item) => item.organizationId === access.organizationId);
      return {
        contractVersion: MARKETPLACE_TRIPS_CONTRACT_VERSION,
        authorizationMode: "creator_workspace_resource_link",
        creatorProfileId: access.creatorProfileId,
        organizationId: access.organizationId,
        items: scopedItems.map(normalizeExternalCollaboration),
      } satisfies MarketplaceExternalCollaborationListResponse;
    } catch (error) {
      request.log.error({ error }, "Failed to list marketplace external collaborations");
      return sendMarketplaceTripError(reply, {
        statusCode: 500,
        code: "read_model_unavailable",
        category: "read_model",
        message: "Marketplace external collaboration read model is unavailable.",
      });
    }
  });

  app.post<{ Body: ExternalCollaborationBody }>(
    "/trips/external-collaborations",
    async (request, reply) => {
      const access = resolveMarketplaceTripAccess(request, reply, "marketplace.trip.manage");
      if (!access) return reply;
      if (!repository.createExternalCollaboration) {
        return sendMarketplaceTripError(reply, writeUnavailable());
      }
      const collaboration = parseExternalCollaborationDraft(request.body);
      if (!collaboration.ok) return sendMarketplaceTripError(reply, collaboration.error);
      const write = parseMarketplaceTripWriteContext(request, access, {
        action: "external_collaboration.create",
        payload: collaboration.value,
      });
      if (!write.ok) return sendMarketplaceTripError(reply, write.error);

      const created = await executeMarketplaceTripWrite(request, reply, () =>
        repository.createExternalCollaboration!({
          ...write.value,
          collaboration: collaboration.value,
        }),
      );
      if (isReply(created)) return created;
      if (!created) return sendMarketplaceTripError(reply, tripNotFound());
      reply.code(201);
      return normalizeExternalCollaboration(created);
    },
  );

  app.put<{ Params: ExternalCollaborationParams; Body: ExternalCollaborationBody }>(
    "/trips/external-collaborations/:externalCollaborationId",
    async (request, reply) => {
      const access = resolveMarketplaceTripAccess(request, reply, "marketplace.trip.manage");
      if (!access) return reply;
      if (!repository.updateExternalCollaboration) {
        return sendMarketplaceTripError(reply, writeUnavailable());
      }
      const patch = parseExternalCollaborationPatch(request.body);
      if (!patch.ok) return sendMarketplaceTripError(reply, patch.error);
      const write = parseMarketplaceTripWriteContext(request, access, {
        action: "external_collaboration.update",
        resourceId: request.params.externalCollaborationId,
        payload: patch.value,
      });
      if (!write.ok) return sendMarketplaceTripError(reply, write.error);

      const updated = await executeMarketplaceTripWrite(request, reply, () =>
        repository.updateExternalCollaboration!({
          ...write.value,
          externalCollaborationId: request.params.externalCollaborationId,
          patch: patch.value,
        }),
      );
      if (isReply(updated)) return updated;
      if (!updated) return sendMarketplaceTripError(reply, externalCollaborationNotFound());
      return normalizeExternalCollaboration(updated);
    },
  );

  app.delete<{ Params: ExternalCollaborationParams }>(
    "/trips/external-collaborations/:externalCollaborationId",
    async (request, reply) => {
      const access = resolveMarketplaceTripAccess(request, reply, "marketplace.trip.manage");
      if (!access) return reply;
      if (!repository.deleteExternalCollaboration) {
        return sendMarketplaceTripError(reply, writeUnavailable());
      }
      const write = parseMarketplaceTripWriteContext(request, access, {
        action: "external_collaboration.delete",
        resourceId: request.params.externalCollaborationId,
        payload: {},
      });
      if (!write.ok) return sendMarketplaceTripError(reply, write.error);
      const deleted = await executeMarketplaceTripWrite(request, reply, () =>
        repository.deleteExternalCollaboration!({
          ...write.value,
          externalCollaborationId: request.params.externalCollaborationId,
        }),
      );
      if (isReply(deleted)) return deleted;
      if (!deleted) return sendMarketplaceTripError(reply, externalCollaborationNotFound());
      return reply.code(204).send();
    },
  );

  app.get<{ Params: TripParams }>("/trips/:tripId", async (request, reply) => {
    const access = resolveMarketplaceTripAccess(request, reply, "marketplace.trip.read");
    if (!access) return reply;

    try {
      const trip = await repository.findTripForCreatorProfile(
        access.creatorProfileId,
        request.params.tripId,
      );
      if (!trip || trip.organizationId !== access.organizationId) {
        return sendMarketplaceTripError(reply, {
          statusCode: 404,
          code: "trip_not_found",
          category: "not_found",
          message: "Marketplace trip was not found.",
        });
      }
      return normalizeTrip(trip);
    } catch (error) {
      request.log.error({ error }, "Failed to read marketplace trip");
      return sendMarketplaceTripError(reply, {
        statusCode: 500,
        code: "read_model_unavailable",
        category: "read_model",
        message: "Marketplace trip read model is unavailable.",
      });
    }
  });

  app.put<{ Params: TripParams; Body: TripBody }>("/trips/:tripId", async (request, reply) => {
    const access = resolveMarketplaceTripAccess(request, reply, "marketplace.trip.manage");
    if (!access) return reply;
    if (!repository.updateTrip) return sendMarketplaceTripError(reply, writeUnavailable());
    const patch = parseTripPatch(request.body);
    if (!patch.ok) return sendMarketplaceTripError(reply, patch.error);
    const write = parseMarketplaceTripWriteContext(request, access, {
      action: "trip.update",
      resourceId: request.params.tripId,
      payload: patch.value,
    });
    if (!write.ok) return sendMarketplaceTripError(reply, write.error);

    const updated = await executeMarketplaceTripWrite(request, reply, () =>
      repository.updateTrip!({
        ...write.value,
        tripId: request.params.tripId,
        patch: patch.value,
      }),
    );
    if (isReply(updated)) return updated;
    if (!updated) return sendMarketplaceTripError(reply, tripNotFound());
    return normalizeTrip(updated);
  });

  app.delete<{ Params: TripParams }>("/trips/:tripId", async (request, reply) => {
    const access = resolveMarketplaceTripAccess(request, reply, "marketplace.trip.manage");
    if (!access) return reply;
    if (!repository.deleteTrip) return sendMarketplaceTripError(reply, writeUnavailable());
    const write = parseMarketplaceTripWriteContext(request, access, {
      action: "trip.delete",
      resourceId: request.params.tripId,
      payload: {},
    });
    if (!write.ok) return sendMarketplaceTripError(reply, write.error);
    const deleted = await executeMarketplaceTripWrite(request, reply, () =>
      repository.deleteTrip!({ ...write.value, tripId: request.params.tripId }),
    );
    if (isReply(deleted)) return deleted;
    if (!deleted) return sendMarketplaceTripError(reply, tripNotFound());
    return reply.code(204).send();
  });
}

function resolveMarketplaceTripAccess(
  request: FastifyRequest,
  reply: FastifyReply,
  permission: "marketplace.trip.read" | "marketplace.trip.manage",
): MarketplaceTripAccess | null {
  try {
    const context = enforceRoutePolicy(request, { permission });

    if (context.selectedOrganization.kind !== "creator_workspace") {
      sendMarketplaceTripError(reply, {
        statusCode: 403,
        code: "forbidden",
        category: "authorization",
        message: "Marketplace trips require a selected creator workspace.",
      });
      return null;
    }

    const creatorLinks = context.linkedResources.filter(
      (resource) =>
        resource.product === "marketplace" &&
        resource.resourceType === "creator_profile" &&
        resource.relationship === "owner" &&
        resource.status === "active",
    );

    if (creatorLinks.length === 0) {
      sendMarketplaceTripError(reply, {
        statusCode: 403,
        code: "missing_creator_resource_link",
        category: "authorization",
        message: "Missing marketplace creator profile access.",
      });
      return null;
    }

    if (creatorLinks.length > 1) {
      sendMarketplaceTripError(reply, {
        statusCode: 403,
        code: "forbidden",
        category: "authorization",
        message: "Marketplace trips require exactly one selected creator profile.",
      });
      return null;
    }

    const [creatorLink] = creatorLinks;

    enforceRoutePolicy(request, {
      permission,
      resource: {
        product: "marketplace",
        resourceType: "creator_profile",
        resourceId: creatorLink.resourceId,
        allowedRelationships: ["owner"],
      },
    });

    return {
      creatorProfileId: creatorLink.resourceId,
      organizationId: context.selectedOrganization.organizationId,
      actorUserId: context.actor.internalUserId,
      requestId: context.audit.requestId,
      correlationId: context.audit.correlationId ?? context.audit.requestId,
      source: context.audit.source,
      occurredAt: context.audit.receivedAt,
    };
  } catch (error) {
    const contractError = toMarketplaceTripAccessError(error);
    if (!contractError) throw error;
    sendMarketplaceTripError(reply, contractError);
    return null;
  }
}

type MarketplaceTripWriteAction =
  | "trip.create"
  | "trip.update"
  | "trip.delete"
  | "external_collaboration.create"
  | "external_collaboration.update"
  | "external_collaboration.delete";

function parseMarketplaceTripWriteContext(
  request: FastifyRequest,
  access: MarketplaceTripAccess,
  input: { action: MarketplaceTripWriteAction; resourceId?: string; payload: unknown },
): ParseResult<MarketplaceTripWriteContext> {
  const rawKey = request.headers["idempotency-key"];
  const idempotencyKey = typeof rawKey === "string" ? rawKey.trim() : "";
  if (!idempotencyKey || idempotencyKey.length > 200) {
    return invalidTripRequest(
      "Idempotency-Key header is required and must be at most 200 characters.",
    );
  }
  return {
    ok: true,
    value: {
      creatorProfileId: access.creatorProfileId,
      organizationId: access.organizationId,
      command: {
        idempotencyKey,
        fingerprintPayload: {
          action: input.action,
          resourceId: input.resourceId ?? null,
          payload: input.payload,
        },
        actorUserId: access.actorUserId,
        requestId: access.requestId,
        correlationId: access.correlationId,
        source: access.source,
        occurredAt: access.occurredAt,
      },
    },
  };
}

class MarketplaceTripWriteError extends Error {
  constructor(readonly contractError: MarketplaceTripError) {
    super(contractError.message);
    this.name = "MarketplaceTripWriteError";
  }
}

async function executeMarketplaceTripWrite<T>(
  request: FastifyRequest,
  reply: FastifyReply,
  write: () => Promise<T>,
): Promise<T | FastifyReply> {
  try {
    return await write();
  } catch (error) {
    if (error instanceof MarketplaceTripWriteError) {
      return sendMarketplaceTripError(reply, error.contractError);
    }
    request.log.error({ error }, "Failed to write marketplace trip data");
    return sendMarketplaceTripError(reply, writeUnavailable());
  }
}

function isReply(value: unknown): value is FastifyReply {
  return value !== null && typeof value === "object" && "sent" in value;
}

type MarketplaceTripRow = {
  internalTripId: string;
  tripId: string;
  creatorProfileId: string;
  organizationId: string;
  sourceTripId: string | null;
  name: string;
  locationText: string | null;
  startDate: Date | string;
  endDate: Date | string;
  notes: string | null;
  createdAt: Date | string;
  updatedAt: Date | string;
};

type MarketplaceExternalCollaborationRow = {
  internalExternalCollaborationId: string;
  externalCollaborationId: string;
  creatorProfileId: string;
  organizationId: string;
  tripId: string | null;
  sourceExternalCollaborationId: string | null;
  title: string;
  hotelName: string | null;
  locationText: string | null;
  collaborationType: string | null;
  startDate: Date | string;
  endDate: Date | string;
  deliverablesSummary: string | null;
  notes: string | null;
  createdAt: Date | string;
  updatedAt: Date | string;
};

export function createPgMarketplaceTripRepository(config: {
  connectionString: string;
  max?: number;
  pool?: MarketplaceTripPool;
}): MarketplaceTripReadRepository {
  if (!config.connectionString.trim()) {
    throw new Error("Marketplace trip repository connectionString must not be empty");
  }
  const pool =
    config.pool ?? new pg.Pool({ connectionString: config.connectionString, max: config.max });

  return {
    async listTripsForCreatorProfile(creatorProfileId) {
      const [trips, collaborations] = await Promise.all([
        queryTripRows(pool, creatorProfileId),
        queryExternalCollaborationRows(pool, creatorProfileId),
      ]);
      return trips.map((trip) =>
        mapTripRow(
          trip,
          collaborations
            .filter((collaboration) => collaboration.tripId === trip.tripId)
            .map(mapExternalCollaborationRow),
        ),
      );
    },
    async findTripForCreatorProfile(creatorProfileId, tripId) {
      const trips = await queryTripRows(pool, creatorProfileId, tripId);
      const trip = trips[0];
      if (!trip) return null;
      const collaborations = await queryExternalCollaborationRows(pool, creatorProfileId, {
        tripId,
      });
      return mapTripRow(trip, collaborations.map(mapExternalCollaborationRow));
    },
    async listExternalCollaborationsForCreatorProfile(creatorProfileId) {
      return (await queryExternalCollaborationRows(pool, creatorProfileId)).map(
        mapExternalCollaborationRow,
      );
    },
    async createTrip(input) {
      return (await executeMarketplaceTripCommand(pool, {
        operation: "marketplace.trip.create",
        resourceType: "trip",
        responseStatusCode: 201,
        input,
        replayAuthorization: tripReplayAuthorization(input),
        async mutate(client) {
          const result = await client.query<MarketplaceTripRow>(
            `INSERT INTO marketplace.trips
             (creator_profile_id, organization_id, name, location_text, start_date, end_date, notes)
             VALUES ($1::uuid, $2::uuid, $3, $4, $5::date, $6::date, $7)
             RETURNING ${tripReturningSql()}`,
            [
              input.creatorProfileId,
              input.organizationId,
              input.trip.name,
              input.trip.locationText,
              input.trip.startDate,
              input.trip.endDate,
              input.trip.notes,
            ],
          );
          const response = mapTripRow(result.rows[0]!, []);
          return {
            response,
            resourceId: response.tripId,
            authorizationResourceId: result.rows[0]!.internalTripId,
          };
        },
      }))!;
    },
    async updateTrip(input) {
      return executeMarketplaceTripCommand(pool, {
        operation: "marketplace.trip.update",
        resourceType: "trip",
        responseStatusCode: 200,
        input,
        replayAuthorization: tripReplayAuthorization(input),
        async mutate(client) {
          const current = await findTripRowForUpdate(client, input);
          if (!current) return null;
          assertValidDateRange(
            input.patch.startDate ?? databaseDate(current.startDate),
            input.patch.endDate ?? databaseDate(current.endDate),
          );
          const result = await client.query<MarketplaceTripRow>(
            `UPDATE marketplace.trips
             SET name = CASE WHEN $4::boolean THEN $5::text ELSE name END,
                 location_text = CASE WHEN $6::boolean THEN $7::text ELSE location_text END,
                 start_date = CASE WHEN $8::boolean THEN $9::date ELSE start_date END,
                 end_date = CASE WHEN $10::boolean THEN $11::date ELSE end_date END,
                 notes = CASE WHEN $12::boolean THEN $13::text ELSE notes END,
                 updated_at = now()
             WHERE id = $1::uuid
               AND creator_profile_id = $2::uuid
               AND organization_id = $3::uuid
             RETURNING ${tripReturningSql()}`,
            [
              current.internalTripId,
              input.creatorProfileId,
              input.organizationId,
              hasOwn(input.patch, "name"),
              input.patch.name ?? null,
              hasOwn(input.patch, "locationText"),
              input.patch.locationText ?? null,
              hasOwn(input.patch, "startDate"),
              input.patch.startDate ?? null,
              hasOwn(input.patch, "endDate"),
              input.patch.endDate ?? null,
              hasOwn(input.patch, "notes"),
              input.patch.notes ?? null,
            ],
          );
          const row = result.rows[0]!;
          const collaborations = await queryExternalCollaborationRows(
            client,
            input.creatorProfileId,
            { tripId: row.tripId },
          );
          const response = mapTripRow(row, collaborations.map(mapExternalCollaborationRow));
          return {
            response,
            resourceId: response.tripId,
            authorizationResourceId: current.internalTripId,
          };
        },
      });
    },
    async deleteTrip(input) {
      return (
        (await executeMarketplaceTripCommand(pool, {
          operation: "marketplace.trip.delete",
          resourceType: "trip",
          responseStatusCode: 204,
          input,
          async mutate(client) {
            const current = await findTripRowForUpdate(client, input);
            if (!current) return null;
            await client.query(
              `DELETE FROM marketplace.trips
               WHERE id = $1::uuid
                 AND creator_profile_id = $2::uuid
                 AND organization_id = $3::uuid`,
              [current.internalTripId, input.creatorProfileId, input.organizationId],
            );
            return {
              response: true,
              resourceId: current.tripId,
              authorizationResourceId: current.internalTripId,
            };
          },
        })) ?? false
      );
    },
    async createExternalCollaboration(input) {
      return executeMarketplaceTripCommand(pool, {
        operation: "marketplace.external-collaboration.create",
        resourceType: "external_collaboration",
        responseStatusCode: 201,
        input,
        replayAuthorization: externalCollaborationReplayAuthorization(input),
        async mutate(client) {
          const internalTripId = await resolveTripInternalId(
            client,
            input.creatorProfileId,
            input.organizationId,
            input.collaboration.tripId,
          );
          const result = await client.query<{ id: string }>(
            `INSERT INTO marketplace.external_collaborations (
               creator_profile_id, organization_id, trip_id, title, hotel_name, location_text,
               collaboration_type, start_date, end_date, deliverables_summary, notes
             ) VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5, $6, $7, $8::date, $9::date, $10, $11)
             RETURNING id::text AS id`,
            [
              input.creatorProfileId,
              input.organizationId,
              internalTripId,
              input.collaboration.title,
              input.collaboration.hotelName,
              input.collaboration.locationText,
              input.collaboration.collaborationType,
              input.collaboration.startDate,
              input.collaboration.endDate,
              input.collaboration.deliverablesSummary,
              input.collaboration.notes,
            ],
          );
          const rows = await queryExternalCollaborationRows(client, input.creatorProfileId, {
            externalCollaborationId: result.rows[0]!.id,
          });
          const response = mapExternalCollaborationRow(rows[0]!);
          return {
            response,
            resourceId: response.externalCollaborationId,
            authorizationResourceId: result.rows[0]!.id,
          };
        },
      });
    },
    async updateExternalCollaboration(input) {
      return executeMarketplaceTripCommand(pool, {
        operation: "marketplace.external-collaboration.update",
        resourceType: "external_collaboration",
        responseStatusCode: 200,
        input,
        replayAuthorization: externalCollaborationReplayAuthorization(input),
        async mutate(client) {
          const current = await findExternalCollaborationRowForUpdate(client, input);
          if (!current) return null;
          assertValidDateRange(
            input.patch.startDate ?? databaseDate(current.startDate),
            input.patch.endDate ?? databaseDate(current.endDate),
          );
          const internalTripId = hasOwn(input.patch, "tripId")
            ? await resolveTripInternalId(
                client,
                input.creatorProfileId,
                input.organizationId,
                input.patch.tripId ?? null,
              )
            : null;
          await client.query(
            `UPDATE marketplace.external_collaborations
             SET trip_id = CASE WHEN $4::boolean THEN $5::uuid ELSE trip_id END,
                 title = CASE WHEN $6::boolean THEN $7::text ELSE title END,
                 hotel_name = CASE WHEN $8::boolean THEN $9::text ELSE hotel_name END,
                 location_text = CASE WHEN $10::boolean THEN $11::text ELSE location_text END,
                 collaboration_type = CASE WHEN $12::boolean THEN $13::text ELSE collaboration_type END,
                 start_date = CASE WHEN $14::boolean THEN $15::date ELSE start_date END,
                 end_date = CASE WHEN $16::boolean THEN $17::date ELSE end_date END,
                 deliverables_summary = CASE WHEN $18::boolean THEN $19::text ELSE deliverables_summary END,
                 notes = CASE WHEN $20::boolean THEN $21::text ELSE notes END,
                 updated_at = now()
             WHERE id = $1::uuid
               AND creator_profile_id = $2::uuid
               AND organization_id = $3::uuid`,
            [
              current.internalExternalCollaborationId,
              input.creatorProfileId,
              input.organizationId,
              hasOwn(input.patch, "tripId"),
              internalTripId,
              hasOwn(input.patch, "title"),
              input.patch.title ?? null,
              hasOwn(input.patch, "hotelName"),
              input.patch.hotelName ?? null,
              hasOwn(input.patch, "locationText"),
              input.patch.locationText ?? null,
              hasOwn(input.patch, "collaborationType"),
              input.patch.collaborationType ?? null,
              hasOwn(input.patch, "startDate"),
              input.patch.startDate ?? null,
              hasOwn(input.patch, "endDate"),
              input.patch.endDate ?? null,
              hasOwn(input.patch, "deliverablesSummary"),
              input.patch.deliverablesSummary ?? null,
              hasOwn(input.patch, "notes"),
              input.patch.notes ?? null,
            ],
          );
          const rows = await queryExternalCollaborationRows(client, input.creatorProfileId, {
            externalCollaborationId: current.externalCollaborationId,
          });
          const response = mapExternalCollaborationRow(rows[0]!);
          return {
            response,
            resourceId: response.externalCollaborationId,
            authorizationResourceId: current.internalExternalCollaborationId,
          };
        },
      });
    },
    async deleteExternalCollaboration(input) {
      return (
        (await executeMarketplaceTripCommand(pool, {
          operation: "marketplace.external-collaboration.delete",
          resourceType: "external_collaboration",
          responseStatusCode: 204,
          input,
          async mutate(client) {
            const current = await findExternalCollaborationRowForUpdate(client, input);
            if (!current) return null;
            await client.query(
              `DELETE FROM marketplace.external_collaborations
               WHERE id = $1::uuid
                 AND creator_profile_id = $2::uuid
                 AND organization_id = $3::uuid`,
              [
                current.internalExternalCollaborationId,
                input.creatorProfileId,
                input.organizationId,
              ],
            );
            return {
              response: true,
              resourceId: current.externalCollaborationId,
              authorizationResourceId: current.internalExternalCollaborationId,
            };
          },
        })) ?? false
      );
    },
    async close() {
      await pool.end();
    },
  };
}

async function findTripRowForUpdate(
  client: MarketplaceTripQueryable,
  input: { creatorProfileId: string; organizationId: string; tripId: string },
): Promise<MarketplaceTripRow | null> {
  const result = await client.query<MarketplaceTripRow>(
    `SELECT ${tripSelectColumns()}
     FROM marketplace.trips trip
     WHERE trip.creator_profile_id = $1::uuid
       AND trip.organization_id = $2::uuid
       AND (trip.source_trip_id = $3 OR trip.id::text = $3)
     LIMIT 1
     FOR UPDATE OF trip`,
    [input.creatorProfileId, input.organizationId, input.tripId],
  );
  return result.rows[0] ?? null;
}

async function findExternalCollaborationRowForUpdate(
  client: MarketplaceTripQueryable,
  input: {
    creatorProfileId: string;
    organizationId: string;
    externalCollaborationId: string;
  },
): Promise<MarketplaceExternalCollaborationRow | null> {
  const result = await client.query<MarketplaceExternalCollaborationRow>(
    `SELECT ${externalCollaborationSelectColumns()}
     FROM marketplace.external_collaborations collaboration
     LEFT JOIN marketplace.trips linked_trip
       ON linked_trip.id = collaboration.trip_id
      AND linked_trip.creator_profile_id = collaboration.creator_profile_id
      AND linked_trip.organization_id = collaboration.organization_id
     WHERE collaboration.creator_profile_id = $1::uuid
       AND collaboration.organization_id = $2::uuid
       AND (
         collaboration.source_external_collaboration_id = $3
         OR collaboration.id::text = $3
       )
     LIMIT 1
     FOR UPDATE OF collaboration`,
    [input.creatorProfileId, input.organizationId, input.externalCollaborationId],
  );
  return result.rows[0] ?? null;
}

async function resolveTripInternalId(
  client: MarketplaceTripQueryable,
  creatorProfileId: string,
  organizationId: string,
  tripId: string | null,
): Promise<string | null> {
  if (tripId === null) return null;
  const result = await client.query<{ id: string }>(
    `SELECT trip.id::text AS id
     FROM marketplace.trips trip
     WHERE trip.creator_profile_id = $1::uuid
       AND trip.organization_id = $2::uuid
       AND (trip.source_trip_id = $3 OR trip.id::text = $3)
     LIMIT 1`,
    [creatorProfileId, organizationId, tripId],
  );
  if (!result.rows[0]) throw new MarketplaceTripWriteError(tripNotFound());
  return result.rows[0].id;
}

function tripReplayAuthorization(
  input: MarketplaceTripWriteContext,
): MarketplaceTripReplayAuthorization {
  return {
    notFoundError: tripNotFound(),
    async authorize(client, authorizationResourceId) {
      const result = await client.query<{ authorized: number }>(
        `SELECT 1 AS authorized
         FROM marketplace.trips
         WHERE id = $1::uuid
           AND creator_profile_id = $2::uuid
           AND organization_id = $3::uuid
         LIMIT 1`,
        [authorizationResourceId, input.creatorProfileId, input.organizationId],
      );
      return Boolean(result.rows[0]);
    },
  };
}

function externalCollaborationReplayAuthorization(
  input: MarketplaceTripWriteContext,
): MarketplaceTripReplayAuthorization {
  return {
    notFoundError: externalCollaborationNotFound(),
    async authorize(client, authorizationResourceId) {
      const result = await client.query<{ authorized: number }>(
        `SELECT 1 AS authorized
         FROM marketplace.external_collaborations
         WHERE id = $1::uuid
           AND creator_profile_id = $2::uuid
           AND organization_id = $3::uuid
         LIMIT 1`,
        [authorizationResourceId, input.creatorProfileId, input.organizationId],
      );
      return Boolean(result.rows[0]);
    },
  };
}

function assertValidDateRange(startDate: string, endDate: string): void {
  if (endDate < startDate) {
    throw new MarketplaceTripWriteError({
      statusCode: 400,
      code: "invalid_request",
      category: "validation",
      message: "endDate must be on or after startDate.",
    });
  }
}

type MarketplaceTripIdempotencyRow = {
  id: string;
  status: string;
  requestFingerprintHash: string;
  metadata: unknown;
};

type MarketplaceTripReplayAuthorization = {
  authorize(client: MarketplaceTripQueryable, authorizationResourceId: string): Promise<boolean>;
  notFoundError: MarketplaceTripError;
};

async function executeMarketplaceTripCommand<T>(
  pool: MarketplaceTripPool,
  options: {
    operation: string;
    resourceType: "trip" | "external_collaboration";
    responseStatusCode: number;
    input: MarketplaceTripWriteContext;
    replayAuthorization?: MarketplaceTripReplayAuthorization;
    mutate(client: MarketplaceTripQueryable): Promise<{
      response: T;
      resourceId: string;
      authorizationResourceId: string;
    } | null>;
  },
): Promise<T | null> {
  const keyHash = sha256(options.input.command.idempotencyKey);
  const fingerprint = sha256(stableJson(options.input.command.fingerprintPayload));
  const client = await pool.connect();
  let transactionOpen = false;
  try {
    await client.query("BEGIN");
    transactionOpen = true;

    const existing = await findMarketplaceTripIdempotency(client, options, keyHash);
    const replay = readMarketplaceTripReplay<T>(
      existing,
      fingerprint,
      options.input.creatorProfileId,
    );
    if (replay.found) {
      if (
        options.replayAuthorization &&
        !(await options.replayAuthorization.authorize(client, replay.authorizationResourceId))
      ) {
        throw new MarketplaceTripWriteError(options.replayAuthorization.notFoundError);
      }
      await client.query("COMMIT");
      transactionOpen = false;
      return replay.response;
    }
    if (existing) throw idempotencyInProgress();

    const idempotencyId = await reserveMarketplaceTripIdempotency(
      client,
      options,
      keyHash,
      fingerprint,
    );
    if (!idempotencyId) {
      const raced = await findMarketplaceTripIdempotency(client, options, keyHash);
      const racedReplay = readMarketplaceTripReplay<T>(
        raced,
        fingerprint,
        options.input.creatorProfileId,
      );
      if (racedReplay.found) {
        if (
          options.replayAuthorization &&
          !(await options.replayAuthorization.authorize(
            client,
            racedReplay.authorizationResourceId,
          ))
        ) {
          throw new MarketplaceTripWriteError(options.replayAuthorization.notFoundError);
        }
        await client.query("COMMIT");
        transactionOpen = false;
        return racedReplay.response;
      }
      throw idempotencyInProgress();
    }

    const mutation = await options.mutate(client);
    if (!mutation) {
      await client.query("ROLLBACK");
      transactionOpen = false;
      return null;
    }
    await recordMarketplaceTripAudit(client, {
      ...options,
      idempotencyId,
      resourceId: mutation.resourceId,
    });
    await completeMarketplaceTripIdempotency(client, {
      ...options,
      idempotencyId,
      fingerprint,
      response: mutation.response,
      resourceId: mutation.resourceId,
      authorizationResourceId: mutation.authorizationResourceId,
    });
    await client.query("COMMIT");
    transactionOpen = false;
    return mutation.response;
  } catch (error) {
    if (transactionOpen) await rollbackMarketplaceTripQuietly(client);
    throw error;
  } finally {
    client.release();
  }
}

async function findMarketplaceTripIdempotency(
  client: MarketplaceTripQueryable,
  options: { operation: string; input: MarketplaceTripWriteContext },
  keyHash: string,
): Promise<MarketplaceTripIdempotencyRow | null> {
  const result = await client.query<MarketplaceTripIdempotencyRow>(
    `SELECT id::text AS id,
            status,
            request_fingerprint_hash AS "requestFingerprintHash",
            idempotency_metadata AS metadata
     FROM platform.idempotency_keys
     WHERE operation_scope = 'marketplace'
       AND operation = $1
       AND key_hash = $2
       AND tenant_scope = 'organization'
       AND organization_id = $3::uuid
     LIMIT 1
     FOR UPDATE`,
    [options.operation, keyHash, options.input.organizationId],
  );
  return result.rows[0] ?? null;
}

function readMarketplaceTripReplay<T>(
  row: MarketplaceTripIdempotencyRow | null,
  fingerprint: string,
  creatorProfileId: string,
): { found: false } | { found: true; response: T; authorizationResourceId: string } {
  if (!row) return { found: false };
  if (row.requestFingerprintHash !== fingerprint) {
    throw new MarketplaceTripWriteError({
      statusCode: 409,
      code: "idempotency_conflict",
      category: "conflict",
      message: "Idempotency key was already used with a different marketplace trip payload.",
    });
  }
  if (!isRecord(row.metadata) || row.metadata.creatorProfileId !== creatorProfileId) {
    throw new MarketplaceTripWriteError({
      statusCode: 409,
      code: "idempotency_conflict",
      category: "conflict",
      message: "Idempotency key cannot be replayed for the selected creator profile.",
    });
  }
  if (
    row.status !== "completed" ||
    !hasOwn(row.metadata, "response") ||
    typeof row.metadata.authorizationResourceId !== "string"
  ) {
    return { found: false };
  }
  return {
    found: true,
    response: row.metadata.response as T,
    authorizationResourceId: row.metadata.authorizationResourceId,
  };
}

async function reserveMarketplaceTripIdempotency(
  client: MarketplaceTripQueryable,
  options: { operation: string; input: MarketplaceTripWriteContext },
  keyHash: string,
  fingerprint: string,
): Promise<string | null> {
  const result = await client.query<{ id: string }>(
    `INSERT INTO platform.idempotency_keys (
       operation_scope, operation, key_hash, request_fingerprint_hash, status,
       tenant_scope, organization_id, correlation_id, expires_at, idempotency_metadata
     ) VALUES (
       'marketplace', $1, $2, $3, 'in_progress',
       'organization', $4::uuid, $5, now() + interval '24 hours', $6::jsonb
     )
     ON CONFLICT (operation_scope, operation, key_hash, scope_key) DO NOTHING
     RETURNING id::text AS id`,
    [
      options.operation,
      keyHash,
      fingerprint,
      options.input.organizationId,
      options.input.command.correlationId,
      JSON.stringify({
        requestId: options.input.command.requestId,
        creatorProfileId: options.input.creatorProfileId,
      }),
    ],
  );
  return result.rows[0]?.id ?? null;
}

async function recordMarketplaceTripAudit(
  client: MarketplaceTripQueryable,
  options: {
    operation: string;
    resourceType: "trip" | "external_collaboration";
    input: MarketplaceTripWriteContext;
    idempotencyId: string;
    resourceId: string;
  },
): Promise<void> {
  await client.query(
    `INSERT INTO platform.product_audit_events (
       audit_key, product, action, occurred_at, tenant_scope, organization_id,
       actor_type, actor_user_id, target_resource_product, target_resource_type,
       target_resource_id, idempotency_key_id, correlation_id, audit_metadata
     ) VALUES (
       $1, 'marketplace', $2, $3::timestamptz, 'organization', $4::uuid,
       'user', $5::uuid, 'marketplace', $6, $7, $8::uuid, $9, $10::jsonb
     )`,
    [
      `marketplace.trip.audit.${options.idempotencyId}.v1`,
      options.operation,
      options.input.command.occurredAt,
      options.input.organizationId,
      options.input.command.actorUserId,
      options.resourceType,
      options.resourceId,
      options.idempotencyId,
      options.input.command.correlationId,
      JSON.stringify({
        requestId: options.input.command.requestId,
        source: options.input.command.source,
      }),
    ],
  );
}

async function completeMarketplaceTripIdempotency<T>(
  client: MarketplaceTripQueryable,
  options: {
    responseStatusCode: number;
    resourceType: "trip" | "external_collaboration";
    idempotencyId: string;
    fingerprint: string;
    response: T;
    resourceId: string;
    authorizationResourceId: string;
  },
): Promise<void> {
  await client.query(
    `UPDATE platform.idempotency_keys
     SET status = 'completed',
         request_fingerprint_hash = $2,
         response_status_code = $3,
         response_body_hash = $4,
         response_resource_product = 'marketplace',
         response_resource_type = $5,
         response_resource_id = $6,
         completed_at = now(),
         last_seen_at = now(),
         idempotency_metadata = idempotency_metadata || $7::jsonb
     WHERE id = $1::uuid`,
    [
      options.idempotencyId,
      options.fingerprint,
      options.responseStatusCode,
      sha256(stableJson(options.response)),
      options.resourceType,
      options.resourceId,
      JSON.stringify({
        response: options.response,
        resourceId: options.resourceId,
        authorizationResourceId: options.authorizationResourceId,
      }),
    ],
  );
}

function idempotencyInProgress(): MarketplaceTripWriteError {
  return new MarketplaceTripWriteError({
    statusCode: 409,
    code: "idempotency_conflict",
    category: "conflict",
    message: "Marketplace trip idempotency key is already in progress.",
  });
}

async function rollbackMarketplaceTripQuietly(client: MarketplaceTripQueryable): Promise<void> {
  try {
    await client.query("ROLLBACK");
  } catch {
    // Preserve the original write error.
  }
}

async function queryTripRows(
  pool: MarketplaceTripQueryable,
  creatorProfileId: string,
  tripId?: string,
): Promise<MarketplaceTripRow[]> {
  const values: unknown[] = [creatorProfileId];
  const tripFilter = tripId
    ? `AND (trip.source_trip_id = $${values.push(tripId)} OR trip.id::text = $${values.length})`
    : "";
  const result = await pool.query<MarketplaceTripRow>(
    `SELECT ${tripSelectColumns()}
     FROM marketplace.trips trip
     WHERE trip.creator_profile_id = $1::uuid
       ${tripFilter}
     ORDER BY trip.start_date, trip.id`,
    values,
  );
  return result.rows;
}

async function queryExternalCollaborationRows(
  pool: MarketplaceTripQueryable,
  creatorProfileId: string,
  filter: { tripId?: string; externalCollaborationId?: string } = {},
): Promise<MarketplaceExternalCollaborationRow[]> {
  const values: unknown[] = [creatorProfileId];
  const tripFilter = filter.tripId
    ? `AND (linked_trip.source_trip_id = $${values.push(filter.tripId)} OR linked_trip.id::text = $${values.length})`
    : "";
  const collaborationFilter = filter.externalCollaborationId
    ? `AND (collaboration.source_external_collaboration_id = $${values.push(filter.externalCollaborationId)} OR collaboration.id::text = $${values.length})`
    : "";
  const result = await pool.query<MarketplaceExternalCollaborationRow>(
    `SELECT ${externalCollaborationSelectColumns()}
     FROM marketplace.external_collaborations collaboration
     LEFT JOIN marketplace.trips linked_trip
       ON linked_trip.id = collaboration.trip_id
      AND linked_trip.creator_profile_id = collaboration.creator_profile_id
      AND linked_trip.organization_id = collaboration.organization_id
     WHERE collaboration.creator_profile_id = $1::uuid
       ${tripFilter}
       ${collaborationFilter}
     ORDER BY collaboration.start_date, collaboration.id`,
    values,
  );
  return result.rows;
}

function tripSelectColumns(): string {
  return `trip.id::text AS "internalTripId",
          COALESCE(trip.source_trip_id, trip.id::text) AS "tripId",
          trip.creator_profile_id::text AS "creatorProfileId",
          trip.organization_id::text AS "organizationId",
          trip.source_trip_id AS "sourceTripId",
          trip.name,
          trip.location_text AS "locationText",
          trip.start_date::text AS "startDate",
          trip.end_date::text AS "endDate",
          trip.notes,
          trip.created_at AS "createdAt",
          trip.updated_at AS "updatedAt"`;
}

function tripReturningSql(): string {
  return tripSelectColumns().replaceAll("trip.", "");
}

function externalCollaborationSelectColumns(): string {
  return `collaboration.id::text AS "internalExternalCollaborationId",
          COALESCE(
            collaboration.source_external_collaboration_id,
            collaboration.id::text
          ) AS "externalCollaborationId",
          collaboration.creator_profile_id::text AS "creatorProfileId",
          collaboration.organization_id::text AS "organizationId",
          COALESCE(linked_trip.source_trip_id, linked_trip.id::text) AS "tripId",
          collaboration.source_external_collaboration_id AS "sourceExternalCollaborationId",
          collaboration.title,
          collaboration.hotel_name AS "hotelName",
          collaboration.location_text AS "locationText",
          collaboration.collaboration_type AS "collaborationType",
          collaboration.start_date::text AS "startDate",
          collaboration.end_date::text AS "endDate",
          collaboration.deliverables_summary AS "deliverablesSummary",
          collaboration.notes,
          collaboration.created_at AS "createdAt",
          collaboration.updated_at AS "updatedAt"`;
}

function mapTripRow(
  row: MarketplaceTripRow,
  externalCollaborations: MarketplaceExternalCollaboration[],
): MarketplaceTrip {
  return normalizeTrip({
    contractVersion: MARKETPLACE_TRIPS_CONTRACT_VERSION,
    authorizationMode: "creator_workspace_resource_link",
    tripId: row.tripId,
    creatorProfileId: row.creatorProfileId,
    organizationId: row.organizationId,
    sourceTripId: row.sourceTripId,
    name: row.name,
    locationText: row.locationText,
    startDate: databaseDate(row.startDate),
    endDate: databaseDate(row.endDate),
    notes: row.notes,
    externalCollaborations,
    createdAt: databaseDateTime(row.createdAt),
    updatedAt: databaseDateTime(row.updatedAt),
  });
}

function mapExternalCollaborationRow(
  row: MarketplaceExternalCollaborationRow,
): MarketplaceExternalCollaboration {
  return normalizeExternalCollaboration({
    contractVersion: MARKETPLACE_TRIPS_CONTRACT_VERSION,
    authorizationMode: "creator_workspace_resource_link",
    externalCollaborationId: row.externalCollaborationId,
    creatorProfileId: row.creatorProfileId,
    organizationId: row.organizationId,
    tripId: row.tripId,
    sourceExternalCollaborationId: row.sourceExternalCollaborationId,
    title: row.title,
    hotelName: row.hotelName,
    locationText: row.locationText,
    collaborationType: isExternalCollaborationType(row.collaborationType)
      ? row.collaborationType
      : null,
    startDate: databaseDate(row.startDate),
    endDate: databaseDate(row.endDate),
    deliverablesSummary: row.deliverablesSummary,
    notes: row.notes,
    createdAt: databaseDateTime(row.createdAt),
    updatedAt: databaseDateTime(row.updatedAt),
  });
}

function databaseDate(value: Date | string): string {
  if (!(value instanceof Date)) return normalizeDate(value);
  const year = value.getFullYear();
  const month = String(value.getMonth() + 1).padStart(2, "0");
  const day = String(value.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function databaseDateTime(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : normalizeDateTime(value);
}

type ParseResult<T> = { ok: true; value: T } | { ok: false; error: MarketplaceTripError };

function parseTripDraft(raw: TripBody | undefined): ParseResult<MarketplaceTripDraft> {
  if (!isRecord(raw)) return invalidTripRequest("Trip details are required.");
  const name = requiredText(raw.name, "name");
  if (!name.ok) return name;
  const startDate = requiredDate(raw.startDate, "startDate");
  if (!startDate.ok) return startDate;
  const endDate = requiredDate(raw.endDate, "endDate");
  if (!endDate.ok) return endDate;
  if (endDate.value < startDate.value) {
    return invalidTripRequest("endDate must be on or after startDate.");
  }
  const locationText = nullableText(raw.locationText, "locationText");
  if (!locationText.ok) return locationText;
  const notes = nullableText(raw.notes, "notes");
  if (!notes.ok) return notes;
  return {
    ok: true,
    value: {
      name: name.value,
      locationText: locationText.value,
      startDate: startDate.value,
      endDate: endDate.value,
      notes: notes.value,
    },
  };
}

function parseTripPatch(raw: TripBody | undefined): ParseResult<MarketplaceTripPatch> {
  if (!isRecord(raw)) return invalidTripRequest("Trip changes are required.");
  const patch: MarketplaceTripPatch = {};
  if (hasOwn(raw, "name")) {
    const name = requiredText(raw.name, "name");
    if (!name.ok) return name;
    patch.name = name.value;
  }
  if (hasOwn(raw, "locationText")) {
    const location = nullableText(raw.locationText, "locationText");
    if (!location.ok) return location;
    patch.locationText = location.value;
  }
  if (hasOwn(raw, "startDate")) {
    const startDate = requiredDate(raw.startDate, "startDate");
    if (!startDate.ok) return startDate;
    patch.startDate = startDate.value;
  }
  if (hasOwn(raw, "endDate")) {
    const endDate = requiredDate(raw.endDate, "endDate");
    if (!endDate.ok) return endDate;
    patch.endDate = endDate.value;
  }
  if (patch.startDate && patch.endDate && patch.endDate < patch.startDate) {
    return invalidTripRequest("endDate must be on or after startDate.");
  }
  if (hasOwn(raw, "notes")) {
    const notes = nullableText(raw.notes, "notes");
    if (!notes.ok) return notes;
    patch.notes = notes.value;
  }
  return Object.keys(patch).length > 0
    ? { ok: true, value: patch }
    : invalidTripRequest("At least one trip field must be provided.");
}

function parseExternalCollaborationDraft(
  raw: ExternalCollaborationBody | undefined,
): ParseResult<MarketplaceExternalCollaborationDraft> {
  if (!isRecord(raw)) return invalidTripRequest("External collaboration details are required.");
  const title = requiredText(raw.title, "title");
  if (!title.ok) return title;
  const startDate = requiredDate(raw.startDate, "startDate");
  if (!startDate.ok) return startDate;
  const endDate = requiredDate(raw.endDate, "endDate");
  if (!endDate.ok) return endDate;
  if (endDate.value < startDate.value) {
    return invalidTripRequest("endDate must be on or after startDate.");
  }
  const tripId = nullableText(raw.tripId, "tripId");
  if (!tripId.ok) return tripId;
  const hotelName = nullableText(raw.hotelName, "hotelName");
  if (!hotelName.ok) return hotelName;
  const locationText = nullableText(raw.locationText, "locationText");
  if (!locationText.ok) return locationText;
  const collaborationType = nullableExternalCollaborationType(raw.collaborationType);
  if (!collaborationType.ok) return collaborationType;
  const deliverablesSummary = nullableText(raw.deliverablesSummary, "deliverablesSummary");
  if (!deliverablesSummary.ok) return deliverablesSummary;
  const notes = nullableText(raw.notes, "notes");
  if (!notes.ok) return notes;
  return {
    ok: true,
    value: {
      tripId: tripId.value,
      title: title.value,
      hotelName: hotelName.value,
      locationText: locationText.value,
      collaborationType: collaborationType.value,
      startDate: startDate.value,
      endDate: endDate.value,
      deliverablesSummary: deliverablesSummary.value,
      notes: notes.value,
    },
  };
}

function parseExternalCollaborationPatch(
  raw: ExternalCollaborationBody | undefined,
): ParseResult<MarketplaceExternalCollaborationPatch> {
  if (!isRecord(raw)) return invalidTripRequest("External collaboration changes are required.");
  const patch: MarketplaceExternalCollaborationPatch = {};
  const nullableFields = [
    "tripId",
    "hotelName",
    "locationText",
    "deliverablesSummary",
    "notes",
  ] as const;
  for (const field of nullableFields) {
    if (!hasOwn(raw, field)) continue;
    const value = nullableText(raw[field], field);
    if (!value.ok) return value;
    patch[field] = value.value;
  }
  if (hasOwn(raw, "title")) {
    const title = requiredText(raw.title, "title");
    if (!title.ok) return title;
    patch.title = title.value;
  }
  if (hasOwn(raw, "collaborationType")) {
    const type = nullableExternalCollaborationType(raw.collaborationType);
    if (!type.ok) return type;
    patch.collaborationType = type.value;
  }
  if (hasOwn(raw, "startDate")) {
    const startDate = requiredDate(raw.startDate, "startDate");
    if (!startDate.ok) return startDate;
    patch.startDate = startDate.value;
  }
  if (hasOwn(raw, "endDate")) {
    const endDate = requiredDate(raw.endDate, "endDate");
    if (!endDate.ok) return endDate;
    patch.endDate = endDate.value;
  }
  if (patch.startDate && patch.endDate && patch.endDate < patch.startDate) {
    return invalidTripRequest("endDate must be on or after startDate.");
  }
  return Object.keys(patch).length > 0
    ? { ok: true, value: patch }
    : invalidTripRequest("At least one external collaboration field must be provided.");
}

function requiredText(raw: unknown, field: string): ParseResult<string> {
  if (typeof raw !== "string" || !raw.trim()) {
    return invalidTripRequest(`${field} is required.`);
  }
  return { ok: true, value: raw.trim() };
}

function nullableText(raw: unknown, field: string): ParseResult<string | null> {
  if (raw === undefined || raw === null || raw === "") return { ok: true, value: null };
  if (typeof raw !== "string") return invalidTripRequest(`${field} must be a string or null.`);
  return { ok: true, value: raw.trim() || null };
}

function requiredDate(raw: unknown, field: string): ParseResult<string> {
  if (typeof raw !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
    return invalidTripRequest(`${field} must be a valid YYYY-MM-DD date.`);
  }
  const parsed = new Date(`${raw}T00:00:00.000Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== raw) {
    return invalidTripRequest(`${field} must be a valid YYYY-MM-DD date.`);
  }
  return { ok: true, value: raw };
}

function nullableExternalCollaborationType(
  raw: unknown,
): ParseResult<MarketplaceExternalCollaborationType | null> {
  if (raw === undefined || raw === null || raw === "") return { ok: true, value: null };
  return isExternalCollaborationType(raw)
    ? { ok: true, value: raw }
    : invalidTripRequest("collaborationType is invalid.");
}

function isExternalCollaborationType(
  value: unknown,
): value is MarketplaceExternalCollaborationType {
  return ["custom_external", "paid", "free_stay", "affiliate", "other"].includes(String(value));
}

function invalidTripRequest<T = never>(message: string): ParseResult<T> {
  return {
    ok: false,
    error: { statusCode: 400, code: "invalid_request", category: "validation", message },
  };
}

function tripNotFound(): MarketplaceTripError {
  return {
    statusCode: 404,
    code: "trip_not_found",
    category: "not_found",
    message: "Marketplace trip was not found.",
  };
}

function externalCollaborationNotFound(): MarketplaceTripError {
  return {
    statusCode: 404,
    code: "external_collaboration_not_found",
    category: "not_found",
    message: "Marketplace external collaboration was not found.",
  };
}

function writeUnavailable(): MarketplaceTripError {
  return {
    statusCode: 500,
    code: "write_model_unavailable",
    category: "write_model",
    message: "Marketplace trip write model is unavailable.",
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const hasOwn = Object.hasOwn;

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

function normalizeTrip(trip: MarketplaceTrip): MarketplaceTrip {
  return {
    ...trip,
    contractVersion: MARKETPLACE_TRIPS_CONTRACT_VERSION,
    authorizationMode: "creator_workspace_resource_link",
    startDate: normalizeDate(trip.startDate),
    endDate: normalizeDate(trip.endDate),
    createdAt: normalizeDateTime(trip.createdAt),
    updatedAt: normalizeDateTime(trip.updatedAt),
    externalCollaborations: trip.externalCollaborations.map(normalizeExternalCollaboration),
  };
}

function normalizeExternalCollaboration(
  collaboration: MarketplaceExternalCollaboration,
): MarketplaceExternalCollaboration {
  return {
    ...collaboration,
    contractVersion: MARKETPLACE_TRIPS_CONTRACT_VERSION,
    authorizationMode: "creator_workspace_resource_link",
    startDate: normalizeDate(collaboration.startDate),
    endDate: normalizeDate(collaboration.endDate),
    createdAt: normalizeDateTime(collaboration.createdAt),
    updatedAt: normalizeDateTime(collaboration.updatedAt),
  };
}

function normalizeDate(value: string): string {
  return value.includes("T") ? value.split("T")[0] : value;
}

function normalizeDateTime(value: string): string {
  return value.includes("T") ? value : new Date(value).toISOString();
}

function toMarketplaceTripAccessError(error: unknown): MarketplaceTripError | null {
  const statusCode =
    typeof error === "object" && error !== null && "statusCode" in error
      ? (error as { statusCode?: unknown }).statusCode
      : undefined;
  if (statusCode === 401) {
    return {
      statusCode: 401,
      code: "unauthorized",
      category: "authentication",
      message: "A valid access token is required.",
    };
  }
  if (statusCode !== 403) return null;

  const message = error instanceof Error ? error.message : "Missing marketplace trip access.";
  if (message.toLowerCase().includes("permission")) {
    return {
      statusCode: 403,
      code: "missing_permission",
      category: "authorization",
      message: "Missing required marketplace trip permission.",
    };
  }
  return {
    statusCode: 403,
    code: "missing_creator_resource_link",
    category: "authorization",
    message: "Missing marketplace creator profile access.",
  };
}

function sendMarketplaceTripError(reply: FastifyReply, error: MarketplaceTripError): FastifyReply {
  return reply.status(error.statusCode).send(error);
}
