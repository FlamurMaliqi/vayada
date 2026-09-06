import {
  collaborationToday,
  collaborationDateError,
  collaborationAvailabilityError,
} from "@vayada/domain-marketplace/collaborationDates";
import { createHash } from "node:crypto";

import {
  COLLABORATION_STATUSES,
  MARKETPLACE_COLLABORATION_AUTHORIZATION_SIDES,
  MARKETPLACE_COLLABORATION_CREATOR_READ_POLICY,
  MARKETPLACE_COLLABORATION_CREATOR_WRITE_POLICY,
  MARKETPLACE_COLLABORATION_HOTEL_READ_POLICY,
  MARKETPLACE_COLLABORATION_HOTEL_WRITE_POLICY,
  MARKETPLACE_COLLABORATION_LIFECYCLE_WRITES_CONTRACT_VERSION,
  MARKETPLACE_COLLABORATION_READS_CONTRACT_VERSION,
  type CollaborationStatus,
  type MarketplaceCollaborationAuthorizationMode,
  type MarketplaceCollaborationAuthorizationSide,
  type MarketplaceCollaborationLifecycleSideEffect,
  type MarketplaceCollaborationListResponse,
  type MarketplaceCollaborationMessage,
  type MarketplaceCollaborationMessagesResponse,
  type MarketplaceCollaborationRead,
  type MarketplaceConversationPage,
  type MarketplaceConversationSummary,
  type MarketplaceMessageCursor,
} from "@vayada/domain-marketplace";
import type { RequestContext } from "@vayada/backend-auth";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import pg, { type PoolClient, type QueryResult, type QueryResultRow } from "pg";

import {
  createPrivateDownloadPolicy,
  type PlatformMediaServingConfig,
} from "../platform/mediaServing.js";
import type { PlatformMediaPrivateDownloadSigner } from "../platform/platformMediaS3.js";
import type { PlatformMediaRepository } from "./platformMedia.js";
import { enforceRoutePolicy } from "./policy.js";

export type MarketplaceCollaborationListFilters = {
  side: MarketplaceCollaborationAuthorizationSide;
  status?: CollaborationStatus;
  initiatedBy?: MarketplaceCollaborationAuthorizationSide;
  offerId?: string;
};

export type MarketplaceCollaborationMessageFilters = {
  before?: string;
  cursor?: MarketplaceMessageCursor;
};

export type MarketplaceConversationFilters = {
  cursor?: { sortAt: string; collaborationId: string };
  limit: number;
  search?: string;
};

export type MarketplaceCollaborationReadRepository = {
  listCollaborations(input: {
    context: RequestContext;
    filters: MarketplaceCollaborationListFilters;
  }): Promise<MarketplaceCollaborationListResponse>;
  getCollaboration(input: {
    context: RequestContext;
    collaborationId: string;
    side: MarketplaceCollaborationAuthorizationSide;
  }): Promise<MarketplaceCollaborationRead | null>;
  listConversations(input: {
    context: RequestContext;
    side?: MarketplaceCollaborationAuthorizationSide;
    filters: MarketplaceConversationFilters;
  }): Promise<MarketplaceConversationPage>;
  listMessages(input: {
    context: RequestContext;
    collaborationId: string;
    side: MarketplaceCollaborationAuthorizationSide;
    filters: MarketplaceCollaborationMessageFilters;
  }): Promise<MarketplaceCollaborationMessagesResponse | null>;
  executeLifecycleWrite?(
    input: MarketplaceCollaborationLifecycleWriteInput,
  ): Promise<MarketplaceCollaborationLifecycleWriteResponse | null>;
  sendMessage?(
    input: MarketplaceCollaborationSendMessageInput,
  ): Promise<MarketplaceCollaborationMessage | null>;
  markMessagesRead?(input: MarketplaceCollaborationMarkReadInput): Promise<boolean>;
  close?(): Promise<void>;
};

export type MarketplaceCollaborationReadPool = {
  query<T extends QueryResultRow = QueryResultRow>(
    text: string,
    values?: readonly unknown[],
  ): Promise<Pick<QueryResult<T>, "rows">>;
  end(): Promise<void>;
};

type MarketplaceCollaborationQueryable = Pick<MarketplaceCollaborationReadPool, "query">;

type MarketplaceCollaborationTransactionalPool = MarketplaceCollaborationReadPool & {
  connect(): Promise<PoolClient>;
};

export type MarketplaceCollaborationRoutesOptions = {
  repository: MarketplaceCollaborationReadRepository;
};

type ChatAttachmentMedia = {
  repository: Pick<PlatformMediaRepository, "findMediaObject">;
  signer: PlatformMediaPrivateDownloadSigner;
  serving: PlatformMediaServingConfig;
  now?: () => Date;
};

type ChatAttachmentScope = {
  collaborationResourceId: string;
  creatorOrganizationId: string;
  hotelOrganizationId: string;
  message?: {
    messageId: string;
    senderSide: string | null;
    attachmentSource: string | null;
  };
};

type MarketplaceCollaborationRow = {
  collaborationId: string;
  authorizationMode: MarketplaceCollaborationAuthorizationMode;
  offerId: string;
  creatorId: string;
  hotelProfileId: string;
  side: MarketplaceCollaborationAuthorizationSide;
  initiatorSide: string;
  status: string;
  compensationType: string | null;
  offerTitle: string;
  propertyTimezone?: string | null;
  hotelLocation: string | null;
  applicationMessage: string | null;
  selectedCompensationOptionId: string | null;
  cancelledBy: string | null;
  creatorConsent: boolean | null;
  creatorAgreedAt: Date | string | null;
  hotelAgreedAt: Date | string | null;
  creatorProfileId: string;
  creatorOrganizationId: string;
  creatorDisplayName: string | null;
  creatorAvatarUrl: string | null;
  creatorLocation: string | null;
  creatorPortfolioUrl: string | null;
  creatorType: string;
  creatorPlatforms: unknown;
  hotelProfileResourceId: string;
  hotelOrganizationId: string;
  hotelDisplayName: string;
  hotelAvatarUrl: string | null;
  freeStayMinNights: number | null;
  freeStayMaxNights: number | null;
  paidAmount: string | null;
  currency: string | null;
  discountPercentage: number | null;
  affiliateEnabled: boolean;
  affiliateCommissionPercentage: string | null;
  travelDateFrom: Date | string | null;
  travelDateTo: Date | string | null;
  preferredDateFrom: Date | string | null;
  preferredDateTo: Date | string | null;
  preferredMonths: string[] | null;
  deliverables: unknown;
  lastMessageAt: Date | string | null;
  createdAt: Date | string;
  updatedAt: Date | string;
};

type MarketplaceConversationRow = {
  collaborationId: string;
  side: MarketplaceCollaborationAuthorizationSide;
  partnerName: string | null;
  partnerAvatarUrl: string | null;
  offerTitle: string | null;
  collaborationStatus: string;
  lastMessageContent: string | null;
  lastMessageAt: Date | string | null;
  unreadCount: string | number | null;
  sortAt: Date | string;
};

type MarketplaceMessageRow = {
  messageId: string;
  collaborationId: string;
  senderUserId: string | null;
  senderName: string | null;
  senderAvatarUrl: string | null;
  senderSide: string | null;
  content: string;
  contentType: string;
  metadata: unknown;
  createdAt: Date | string;
};

type CollaborationListQuery = {
  side?: string;
  status?: string;
  initiatedBy?: string;
  offerId?: string;
};

type CollaborationSideQuery = {
  side?: string;
};

type CollaborationConversationsQuery = CollaborationSideQuery & {
  cursor?: string;
  limit?: string | number;
  search?: string;
};

type CollaborationMessagesQuery = CollaborationSideQuery & {
  before?: string;
  cursor?: string;
};

type CollaborationParams = {
  collaborationId: string;
};

type CollaborationDeliverableParams = CollaborationParams & {
  deliverableId: string;
};

type MarketplaceCollaborationLifecycleWriteAction =
  | "create"
  | "respond"
  | "edit_application"
  | "update_terms"
  | "approve_terms"
  | "cancel"
  | "toggle_deliverable"
  | "rate_creator";

type MarketplaceCollaborationLifecycleWriteCommand = {
  action: MarketplaceCollaborationLifecycleWriteAction;
  idempotencyKey: string;
  replayed?: boolean;
  acceptedAt?: string;
  ratingId?: string;
};

export type MarketplaceCollaborationLifecycleWriteResponse = {
  contractVersion: typeof MARKETPLACE_COLLABORATION_LIFECYCLE_WRITES_CONTRACT_VERSION;
  command: MarketplaceCollaborationLifecycleWriteCommand;
  collaboration: MarketplaceCollaborationRead;
  sideEffects: MarketplaceCollaborationLifecycleSideEffect[];
};

export type MarketplaceCollaborationLifecycleWriteInput = {
  context: RequestContext;
  side: MarketplaceCollaborationAuthorizationSide;
  action: MarketplaceCollaborationLifecycleWriteAction;
  idempotencyKey: string;
  collaborationId?: string;
  deliverableId?: string;
  payload: Record<string, unknown>;
};

export type MarketplaceCollaborationSendMessageInput = {
  context: RequestContext;
  side: MarketplaceCollaborationAuthorizationSide;
  collaborationId: string;
  content: string;
  contentType: "text" | "image";
  mediaObjectId?: string;
  idempotencyKey: string;
};

export type MarketplaceCollaborationMarkReadInput = {
  context: RequestContext;
  side: MarketplaceCollaborationAuthorizationSide;
  collaborationId: string;
  readThrough: MarketplaceMessageCursor;
};

type LifecycleWriteBody = {
  idempotencyKey?: unknown;
  side?: unknown;
  initiatorSide?: unknown;
  [key: string]: unknown;
};

type SendMessageBody = {
  content?: unknown;
  message_type?: unknown;
  contentType?: unknown;
  mediaObjectId?: unknown;
  idempotencyKey?: unknown;
};

type MarkMessagesReadBody = {
  readThrough?: unknown;
};

export function registerMarketplaceCollaborationRoutes(
  app: FastifyInstance,
  options: MarketplaceCollaborationRoutesOptions,
): void {
  app.post<{ Body: LifecycleWriteBody }>("/collaborations", async (request, reply) => {
    const parsed = parseLifecycleWriteBody(request.body, "create");
    if (!parsed.ok) return sendMarketplaceCollaborationError(reply, parsed.error);
    const authorization = authorizeOptionalSideCollaborationWrite(request, undefined);
    if (!authorization.ok) return sendMarketplaceCollaborationError(reply, authorization.error);
    if (authorization.side === "creator") {
      const creatorProfile = resolveSingleOwnedCreatorProfileId(authorization.context);
      if (!creatorProfile.ok) {
        return sendMarketplaceCollaborationError(reply, creatorProfile.error);
      }
    }
    const createPayload = parseCreatePayload(authorization.side, request.body ?? {});
    if (!createPayload.ok) return sendMarketplaceCollaborationError(reply, createPayload.error);
    if (!options.repository.executeLifecycleWrite) {
      return sendMarketplaceCollaborationError(reply, writeUnavailable());
    }

    const result = await executeRepositoryLifecycleWrite(reply, options.repository, {
      context: authorization.context,
      side: authorization.side,
      action: "create",
      idempotencyKey: parsed.value.idempotencyKey,
      payload: request.body ?? {},
    });
    if (isReply(result)) return result;
    if (!result) return sendMarketplaceCollaborationError(reply, notFound());
    reply.code(201);
    return result;
  });

  app.get<{ Querystring: CollaborationListQuery }>("/collaborations/me", async (request, reply) => {
    const side = parseRequiredSide(request.query.side);
    if (!side.ok) {
      return sendMarketplaceCollaborationError(reply, side.error);
    }
    const status = parseOptionalStatus(request.query.status);
    if (!status.ok) {
      return sendMarketplaceCollaborationError(reply, status.error);
    }
    const initiatedBy = parseOptionalSide(request.query.initiatedBy, "initiatedBy");
    if (!initiatedBy.ok) {
      return sendMarketplaceCollaborationError(reply, initiatedBy.error);
    }

    const authorization = authorizeRequiredSideCollaborationRead(request, side.value);
    if (!authorization.ok) {
      return sendMarketplaceCollaborationError(reply, authorization.error);
    }
    return options.repository.listCollaborations({
      context: authorization.context,
      filters: {
        side: side.value,
        status: status.value,
        initiatedBy: initiatedBy.value,
        offerId: normalizeOptionalString(request.query.offerId),
      },
    });
  });

  app.get<{ Querystring: CollaborationConversationsQuery }>(
    "/collaborations/conversations",
    async (request, reply) => {
      const authorization = authorizeOptionalSideCollaborationRead(request, request.query.side);
      if (!authorization.ok) {
        return sendMarketplaceCollaborationError(reply, authorization.error);
      }

      const filters = parseConversationFilters(request.query);
      if (!filters.ok) return sendMarketplaceCollaborationError(reply, filters.error);
      const page = await options.repository.listConversations({
        context: authorization.context,
        side: authorization.side,
        filters: filters.value,
      });
      setPrivateMessageResponseHeaders(reply);
      const usesPagination =
        request.query.cursor !== undefined ||
        request.query.limit !== undefined ||
        request.query.search !== undefined;
      return usesPagination ? page : page.items;
    },
  );

  app.get<{ Params: CollaborationParams; Querystring: CollaborationSideQuery }>(
    "/collaborations/:collaborationId",
    async (request, reply) => {
      const side = parseRequiredSide(request.query.side);
      if (!side.ok) {
        return sendMarketplaceCollaborationError(reply, side.error);
      }

      const authorization = authorizeRequiredSideCollaborationRead(request, side.value);
      if (!authorization.ok) {
        return sendMarketplaceCollaborationError(reply, authorization.error);
      }
      const collaboration = await options.repository.getCollaboration({
        context: authorization.context,
        collaborationId: request.params.collaborationId,
        side: side.value,
      });
      if (!collaboration) {
        return sendMarketplaceCollaborationError(reply, {
          statusCode: 404,
          code: "collaboration_not_found",
          message: "Collaboration was not found for the selected marketplace side.",
        });
      }
      return collaboration;
    },
  );

  app.get<{ Params: CollaborationParams; Querystring: CollaborationMessagesQuery }>(
    "/collaborations/:collaborationId/messages",
    async (request, reply) => {
      const authorization = authorizeOptionalSideCollaborationRead(request, request.query.side);
      if (!authorization.ok) {
        return sendMarketplaceCollaborationError(reply, authorization.error);
      }

      const cursor = parseOptionalMessageCursor(request.query.cursor);
      if (!cursor.ok) return sendMarketplaceCollaborationError(reply, cursor.error);
      const before = parseOptionalTimestamp(request.query.before, "before");
      if (!before.ok) return sendMarketplaceCollaborationError(reply, before.error);
      if (cursor.value && before.value) {
        return sendMarketplaceCollaborationError(reply, {
          statusCode: 400,
          code: "invalid_query",
          message: "Use either cursor or before for message pagination, not both.",
        });
      }
      const messages = await options.repository.listMessages({
        context: authorization.context,
        collaborationId: request.params.collaborationId,
        side: authorization.side,
        filters: {
          before: before.value,
          cursor: cursor.value,
        },
      });
      if (!messages) {
        return sendMarketplaceCollaborationError(reply, {
          statusCode: 404,
          code: "collaboration_not_found",
          message: "Collaboration messages were not found for the selected marketplace side.",
        });
      }
      setPrivateMessageResponseHeaders(reply);
      return messages;
    },
  );

  app.post<{ Params: CollaborationParams; Body: SendMessageBody }>(
    "/collaborations/:collaborationId/messages",
    async (request, reply) => {
      const parsed = parseSendMessageBody(request.body);
      if (!parsed.ok) return sendMarketplaceCollaborationError(reply, parsed.error);
      const authorization = authorizeOptionalSideCollaborationWrite(request, undefined);
      if (!authorization.ok) return sendMarketplaceCollaborationError(reply, authorization.error);
      if (!options.repository.sendMessage) {
        return sendMarketplaceCollaborationError(reply, writeUnavailable());
      }

      const result = await sendRepositoryMessage(reply, options.repository, {
        context: authorization.context,
        side: authorization.side,
        collaborationId: request.params.collaborationId,
        content: parsed.value.content,
        contentType: parsed.value.contentType,
        mediaObjectId: parsed.value.mediaObjectId,
        idempotencyKey: parsed.value.idempotencyKey,
      });
      if (isReply(result)) return result;
      if (!result) return sendMarketplaceCollaborationError(reply, notFound());
      setPrivateMessageResponseHeaders(reply);
      reply.code(201);
      return result;
    },
  );

  app.post<{ Params: CollaborationParams; Body: MarkMessagesReadBody }>(
    "/collaborations/:collaborationId/read",
    async (request, reply) => {
      const authorization = authorizeOptionalSideCollaborationWrite(request, undefined);
      if (!authorization.ok) return sendMarketplaceCollaborationError(reply, authorization.error);
      if (!options.repository.markMessagesRead) {
        return sendMarketplaceCollaborationError(reply, writeUnavailable());
      }

      const readThrough = parseReadThroughCursor(request.body?.readThrough);
      if (!readThrough.ok) return sendMarketplaceCollaborationError(reply, readThrough.error);

      const found = await options.repository.markMessagesRead({
        context: authorization.context,
        side: authorization.side,
        collaborationId: request.params.collaborationId,
        readThrough: readThrough.value,
      });
      if (!found) return sendMarketplaceCollaborationError(reply, notFound());
      return reply.code(204).send();
    },
  );

  app.post<{ Params: CollaborationParams; Body: LifecycleWriteBody }>(
    "/collaborations/:collaborationId/respond",
    async (request, reply) =>
      executeLifecycleWriteRoute(
        request,
        reply,
        options,
        "respond",
        request.params.collaborationId,
      ),
  );

  app.put<{ Params: CollaborationParams; Body: LifecycleWriteBody }>(
    "/collaborations/:collaborationId/application",
    async (request, reply) =>
      executeLifecycleWriteRoute(
        request,
        reply,
        options,
        "edit_application",
        request.params.collaborationId,
      ),
  );

  app.put<{ Params: CollaborationParams; Body: LifecycleWriteBody }>(
    "/collaborations/:collaborationId/terms",
    async (request, reply) =>
      executeLifecycleWriteRoute(
        request,
        reply,
        options,
        "update_terms",
        request.params.collaborationId,
      ),
  );

  app.post<{ Params: CollaborationParams; Body: LifecycleWriteBody }>(
    "/collaborations/:collaborationId/approve",
    async (request, reply) =>
      executeLifecycleWriteRoute(
        request,
        reply,
        options,
        "approve_terms",
        request.params.collaborationId,
      ),
  );

  app.post<{ Params: CollaborationParams; Body: LifecycleWriteBody }>(
    "/collaborations/:collaborationId/cancel",
    async (request, reply) =>
      executeLifecycleWriteRoute(request, reply, options, "cancel", request.params.collaborationId),
  );

  app.post<{ Params: CollaborationDeliverableParams; Body: LifecycleWriteBody }>(
    "/collaborations/:collaborationId/deliverables/:deliverableId/toggle",
    async (request, reply) =>
      executeLifecycleWriteRoute(
        request,
        reply,
        options,
        "toggle_deliverable",
        request.params.collaborationId,
        request.params.deliverableId,
      ),
  );

  app.post<{ Params: CollaborationParams; Body: LifecycleWriteBody }>(
    "/collaborations/:collaborationId/rate",
    async (request, reply) =>
      executeLifecycleWriteRoute(
        request,
        reply,
        options,
        "rate_creator",
        request.params.collaborationId,
      ),
  );

  app.addHook("onClose", async () => {
    await options.repository.close?.();
  });
}

async function executeLifecycleWriteRoute(
  request: FastifyRequest<{ Body: LifecycleWriteBody }>,
  reply: FastifyReply,
  options: MarketplaceCollaborationRoutesOptions,
  action: Exclude<MarketplaceCollaborationLifecycleWriteAction, "create">,
  collaborationId: string,
  deliverableId?: string,
): Promise<FastifyReply | MarketplaceCollaborationLifecycleWriteResponse> {
  const parsed = parseLifecycleWriteBody(request.body, action);
  if (!parsed.ok) return sendMarketplaceCollaborationError(reply, parsed.error);
  const authorization = authorizeOptionalSideCollaborationWrite(request, request.body?.side);
  if (!authorization.ok) return sendMarketplaceCollaborationError(reply, authorization.error);
  if (!options.repository.executeLifecycleWrite) {
    return sendMarketplaceCollaborationError(reply, writeUnavailable());
  }

  const result = await executeRepositoryLifecycleWrite(reply, options.repository, {
    context: authorization.context,
    side: authorization.side,
    action,
    idempotencyKey: parsed.value.idempotencyKey,
    collaborationId,
    deliverableId,
    payload: request.body ?? {},
  });
  if (isReply(result)) return result;
  if (!result) return sendMarketplaceCollaborationError(reply, notFound());
  return result;
}

async function executeRepositoryLifecycleWrite(
  reply: FastifyReply,
  repository: MarketplaceCollaborationReadRepository,
  input: MarketplaceCollaborationLifecycleWriteInput,
): Promise<FastifyReply | MarketplaceCollaborationLifecycleWriteResponse | null> {
  if (!repository.executeLifecycleWrite) {
    return sendMarketplaceCollaborationError(reply, writeUnavailable());
  }
  try {
    return await repository.executeLifecycleWrite(input);
  } catch (error) {
    if (error instanceof MarketplaceCollaborationWriteError) {
      return sendMarketplaceCollaborationError(reply, error);
    }
    throw error;
  }
}

async function sendRepositoryMessage(
  reply: FastifyReply,
  repository: MarketplaceCollaborationReadRepository,
  input: MarketplaceCollaborationSendMessageInput,
): Promise<FastifyReply | MarketplaceCollaborationMessage | null> {
  if (!repository.sendMessage) {
    return sendMarketplaceCollaborationError(reply, writeUnavailable());
  }
  try {
    return await repository.sendMessage(input);
  } catch (error) {
    if (error instanceof MarketplaceCollaborationWriteError) {
      return sendMarketplaceCollaborationError(reply, error);
    }
    throw error;
  }
}

function isReply(value: unknown): value is FastifyReply {
  return value !== null && typeof value === "object" && "sent" in value;
}

export function createPgMarketplaceCollaborationReadRepository(config: {
  connectionString: string;
  max?: number;
  pool?: MarketplaceCollaborationReadPool;
  attachmentMedia?: ChatAttachmentMedia;
}): MarketplaceCollaborationReadRepository {
  if (!config.connectionString.trim()) {
    throw new Error("Marketplace collaboration repository connectionString must not be empty");
  }

  const pool =
    config.pool ??
    new pg.Pool({
      connectionString: config.connectionString,
      max: config.max,
    });

  return {
    async listCollaborations({ context, filters }) {
      const rows = await queryCollaborationRows(pool, context, filters.side, {
        status: filters.status,
        initiatedBy: filters.initiatedBy,
        offerId: filters.offerId,
      });
      return toMarketplaceCollaborationListResponse({
        authorizationMode: authorizationModeForSide(filters.side),
        items: rows.map((row) => mapCollaborationRow(row, filters.side)),
      });
    },
    async getCollaboration({ context, collaborationId, side }) {
      const rows = await queryCollaborationRows(pool, context, side, { collaborationId });
      return rows[0] ? mapCollaborationRow(rows[0], side) : null;
    },
    async listConversations({ context, side, filters }) {
      const resolvedSide = side ?? inferSideFromOrganizationKind(context);
      if (!resolvedSide) {
        return toMarketplaceConversationPage({ items: [], hasMore: false });
      }
      const access = collaborationAccessValues(context, resolvedSide);
      const values: unknown[] = [...access];
      const clauses = [
        collaborationAccessWhereSql(resolvedSide),
        "collaboration.source_collaboration_id IS NOT NULL",
      ];
      if (filters.search) {
        values.push(`%${escapeLikePattern(filters.search)}%`);
        const searchParameter = `$${values.length}`;
        clauses.push(`(
          ${conversationPartnerNameSql(resolvedSide)} ILIKE ${searchParameter} ESCAPE '\\'
          OR offer.title ILIKE ${searchParameter} ESCAPE '\\'
          OR COALESCE(last_message."lastMessageContent", '') ILIKE ${searchParameter} ESCAPE '\\'
          OR collaboration.lifecycle_status ILIKE ${searchParameter} ESCAPE '\\'
        )`);
      }
      if (filters.cursor) {
        values.push(filters.cursor.sortAt, filters.cursor.collaborationId);
        clauses.push(`(
          COALESCE(last_message."lastMessageAt", collaboration.updated_at),
          collaboration.source_collaboration_id
        ) < ($${values.length - 1}::timestamptz, $${values.length}::text)`);
      }
      values.push(filters.limit + 1);
      const result = await pool.query<MarketplaceConversationRow>(
        `${collaborationFromSql(resolvedSide, conversationSelectSql(resolvedSide))}
         LEFT JOIN LATERAL (
           SELECT message.body AS "lastMessageContent",
                  message.created_at AS "lastMessageAt"
           FROM marketplace.marketplace_chat_messages message
           WHERE message.collaboration_id = collaboration.id
             AND message.property_id = collaboration.property_id
           ORDER BY message.created_at DESC, message.id DESC
           LIMIT 1
         ) last_message ON TRUE
         LEFT JOIN LATERAL (
           SELECT COUNT(*)::text AS unread_count
           FROM marketplace.marketplace_chat_messages message
           WHERE message.collaboration_id = collaboration.id
             AND message.property_id = collaboration.property_id
             AND message.read_at IS NULL
             AND message.sender_type <> '${resolvedSide}'
         ) unread ON TRUE
         WHERE ${clauses.join("\n           AND ")}
         ORDER BY COALESCE(last_message."lastMessageAt", collaboration.updated_at) DESC,
                  collaboration.source_collaboration_id DESC
         LIMIT $${values.length}`,
        values,
      );
      const hasMore = result.rows.length > filters.limit;
      const rows = result.rows.slice(0, filters.limit);
      return toMarketplaceConversationPage({
        items: rows.map((row) => mapConversationRow(row)),
        hasMore,
        nextCursor:
          hasMore && rows.length ? encodeConversationCursor(rows[rows.length - 1]!) : null,
      });
    },
    async listMessages({ context, collaborationId, side, filters }) {
      const access = collaborationAccessValues(context, side);
      const collaboration = await pool.query<{
        id: string;
        propertyId: string;
        creatorOrganizationId: string;
        hotelOrganizationId: string;
      }>(
        `${collaborationFromSql(
          side,
          `collaboration.id,
           collaboration.property_id AS "propertyId",
           collaboration.creator_organization_id::text AS "creatorOrganizationId",
           collaboration.hotel_organization_id::text AS "hotelOrganizationId"`,
        )}
         WHERE ${collaborationAccessWhereSql(side)}
           AND collaboration.source_collaboration_id = $${access.length + 1}
         LIMIT 1`,
        [...access, collaborationId],
      );
      const target = collaboration.rows[0];
      if (!target) {
        return null;
      }
      const values: unknown[] = [
        target.id,
        target.propertyId,
        filters.before ?? null,
        collaborationId,
        filters.cursor?.createdAt ?? null,
        filters.cursor?.messageId ?? null,
      ];
      const result = await pool.query<MarketplaceMessageRow>(
        `SELECT message.id::text AS "messageId",
                $4::text AS "collaborationId",
                message.sender_user_id::text AS "senderUserId",
                message.sender_type AS "senderSide",
                CASE
                  WHEN message.sender_type IN ('system', 'migration') THEN NULL
                  ELSE message.sender_type
                END AS "senderName",
                NULL::text AS "senderAvatarUrl",
                message.body AS content,
                message.message_type AS "contentType",
                message.message_metadata AS metadata,
                message.created_at AS "createdAt"
         FROM marketplace.marketplace_chat_messages message
         WHERE message.collaboration_id = $1
           AND message.property_id = $2
           AND (
             ($5::timestamptz IS NULL AND ($3::timestamptz IS NULL OR message.created_at < $3::timestamptz))
             OR ($5::timestamptz IS NOT NULL AND (message.created_at, message.id) < ($5::timestamptz, $6::uuid))
           )
         ORDER BY message.created_at DESC, message.id DESC
         LIMIT 51`,
        values,
      );
      const hasMore = result.rows.length > 50;
      const rows = result.rows.slice(0, 50);
      return toMarketplaceCollaborationMessagesResponse({
        collaborationId,
        authorizationMode: authorizationModeForSide(side),
        items: await Promise.all(
          rows.map((row) =>
            mapMessageRowWithAttachment(
              row,
              {
                collaborationResourceId: target.id,
                creatorOrganizationId: target.creatorOrganizationId,
                hotelOrganizationId: target.hotelOrganizationId,
                message: {
                  messageId: row.messageId,
                  senderSide: row.senderSide,
                  attachmentSource: readString(
                    isRecord(row.metadata) ? row.metadata.attachmentSource : null,
                  ),
                },
              },
              config.attachmentMedia,
            ),
          ),
        ),
        hasMore,
        nextCursor:
          hasMore && rows.length
            ? encodeMessageCursor(mapMessageRow(rows[rows.length - 1]!))
            : null,
      });
    },
    async executeLifecycleWrite(input) {
      return executePgLifecycleWrite(pool as MarketplaceCollaborationTransactionalPool, input);
    },
    async sendMessage(input) {
      return sendPgCollaborationMessage(
        pool as MarketplaceCollaborationTransactionalPool,
        input,
        config.attachmentMedia,
      );
    },
    async markMessagesRead(input) {
      return markPgCollaborationMessagesRead(pool, input);
    },
    async close() {
      await pool.end();
    },
  };
}

type CollaborationMutationRow = {
  id: string;
  propertyId: string;
  offerId: string;
  updatedAt: Date | string;
  lifecycleStatus: string;
  initiatorSide: string;
  sourceCollaborationId: string;
  compensationType: string | null;
  affiliateEnabled: boolean;
  creatorProfileId: string;
  creatorOrganizationId: string;
  hotelOrganizationId: string;
  creatorAgreedAt: Date | string | null;
  hotelAgreedAt: Date | string | null;
};

type MarketplaceCollaborationReplayRow = {
  status: "in_progress" | "completed" | "failed" | "expired" | "conflict";
  requestFingerprintHash: string;
  metadata: unknown;
};

type MarketplaceCollaborationLifecycleMutationResult = {
  collaborationResourceId: string;
  command: MarketplaceCollaborationLifecycleWriteCommand;
  sideEffects: MarketplaceCollaborationLifecycleSideEffect[];
};

type MarketplaceCollaborationWriteOperation =
  | `marketplace_collaboration_${MarketplaceCollaborationLifecycleWriteAction}`
  | "marketplace_collaboration_send_message";

async function executePgLifecycleWrite(
  pool: MarketplaceCollaborationTransactionalPool,
  input: MarketplaceCollaborationLifecycleWriteInput,
): Promise<MarketplaceCollaborationLifecycleWriteResponse | null> {
  const operation: MarketplaceCollaborationWriteOperation = `marketplace_collaboration_${input.action}`;
  return executeMarketplaceCollaborationLifecycleCommand(pool, {
    operation,
    context: input.context,
    side: input.side,
    organizationId: input.context.selectedOrganization.organizationId,
    collaborationId: input.collaborationId ?? createCollaborationCorrelationId(input),
    idempotencyKey: input.idempotencyKey,
    fingerprintPayload: {
      action: input.action,
      side: input.side,
      collaborationId: input.collaborationId ?? null,
      deliverableId: input.deliverableId ?? null,
      payload:
        input.action === "create"
          ? createFingerprintPayload(input.side, input.payload)
          : input.payload,
    },
    authorize: (client) => authorizePgLifecycleWriteReplay(client, input),
    async mutate(client) {
      switch (input.action) {
        case "create":
          return createPgCollaboration(client, input);
        case "respond":
          return mutateExistingPgCollaboration(client, input, respondPgCollaboration);
        case "edit_application":
          return mutateExistingPgCollaboration(client, input, editPgCollaborationApplication);
        case "update_terms":
          return mutateExistingPgCollaboration(client, input, updatePgCollaborationTerms);
        case "approve_terms":
          return mutateExistingPgCollaboration(client, input, approvePgCollaborationTerms);
        case "cancel":
          return mutateExistingPgCollaboration(client, input, cancelPgCollaboration);
        case "toggle_deliverable":
          return mutateExistingPgCollaboration(client, input, togglePgCollaborationDeliverable);
        case "rate_creator":
          return mutateExistingPgCollaboration(client, input, ratePgCollaborationCreator);
      }
    },
  });
}

async function sendPgCollaborationMessage(
  pool: MarketplaceCollaborationTransactionalPool,
  input: MarketplaceCollaborationSendMessageInput,
  attachmentMedia?: ChatAttachmentMedia,
): Promise<MarketplaceCollaborationMessage | null> {
  const operation = "marketplace_collaboration_send_message";
  const keyHash = sha256(
    stableJson({
      organizationId: input.context.selectedOrganization.organizationId,
      side: input.side,
      collaborationId: input.collaborationId,
      key: input.idempotencyKey,
    }),
  );
  const fingerprint = sha256(
    stableJson({
      collaborationId: input.collaborationId,
      side: input.side,
      content: input.content,
      contentType: input.contentType,
      mediaObjectId: input.mediaObjectId ?? null,
    }),
  );
  const client = await pool.connect();
  let transactionOpen = false;
  try {
    await client.query("BEGIN");
    transactionOpen = true;
    const organizationId = input.context.selectedOrganization.organizationId;
    const collaboration = await findPgCollaborationForSide(client, input.context, input.side, {
      collaborationId: input.collaborationId,
    });
    if (!collaboration) {
      await client.query("ROLLBACK");
      transactionOpen = false;
      return null;
    }
    const existing = await findMarketplaceCollaborationReplay(client, {
      operation,
      keyHash,
      organizationId,
    });
    const replay = readMarketplaceMessageReplay(existing, fingerprint);
    if (replay) {
      await client.query("COMMIT");
      transactionOpen = false;
      return mapMessageWithAttachment(
        replay,
        messageAttachmentScope(collaboration, replay),
        attachmentMedia,
      );
    }

    const reserved = await reserveMarketplaceCollaborationIdempotency(client, {
      operation,
      collaborationId: input.collaborationId,
      idempotencyKey: input.idempotencyKey,
      keyHash,
      fingerprint,
      organizationId,
    });
    if (!reserved) {
      const current = await findMarketplaceCollaborationReplay(client, {
        operation,
        keyHash,
        organizationId,
      });
      const currentReplay = readMarketplaceMessageReplay(current, fingerprint);
      if (currentReplay) {
        await client.query("COMMIT");
        transactionOpen = false;
        return mapMessageWithAttachment(
          currentReplay,
          messageAttachmentScope(collaboration, currentReplay),
          attachmentMedia,
        );
      }
      throw new MarketplaceCollaborationWriteError(
        409,
        "idempotency_conflict",
        "Marketplace message idempotency key is already in progress.",
      );
    }

    const message = await insertPgCollaborationMessage(
      client,
      input,
      collaboration,
      attachmentMedia,
    );
    if (!message) throw new Error("Created marketplace message was not returned.");
    await completeMarketplaceMessageIdempotency(client, {
      operation,
      keyHash,
      fingerprint,
      message,
      organizationId,
    });
    await client.query("COMMIT");
    transactionOpen = false;
    return message;
  } catch (error) {
    if (transactionOpen) await rollbackQuietly(client);
    throw error;
  } finally {
    client.release();
  }
}

async function insertPgCollaborationMessage(
  client: MarketplaceCollaborationQueryable,
  input: MarketplaceCollaborationSendMessageInput,
  collaboration: CollaborationMutationRow,
  attachmentMedia?: ChatAttachmentMedia,
): Promise<MarketplaceCollaborationMessage | null> {
  const attachment =
    input.contentType === "image"
      ? await requireChatAttachment(
          input.mediaObjectId,
          {
            collaborationResourceId: collaboration.id,
            creatorOrganizationId: collaboration.creatorOrganizationId,
            hotelOrganizationId: collaboration.hotelOrganizationId,
          },
          attachmentMedia,
          {
            actorUserId: input.context.actor.internalUserId,
            ownerOrganizationId: input.context.selectedOrganization.organizationId,
          },
        )
      : null;
  const metadata = attachment ? { mediaObjectId: attachment.mediaObject.mediaId } : {};

  const messageColumns = `(collaboration_id, property_id, sender_user_id, sender_type,
                            message_type, body, message_metadata)`;
  const attachmentMessageColumns = `(id, collaboration_id, property_id, sender_user_id,
                                      sender_type, message_type, body, message_metadata)`;
  const returning = `RETURNING
       id::text AS "messageId",
       $${attachment ? 11 : 8}::text AS "collaborationId",
       sender_user_id::text AS "senderUserId",
       sender_type AS "senderSide",
       sender_type AS "senderName",
       NULL::text AS "senderAvatarUrl",
       body AS content,
       message_type AS "contentType",
       message_metadata AS metadata,
       created_at AS "createdAt"`;
  const result = attachment
    ? await client.query<MarketplaceMessageRow>(
        `WITH message_identity AS (
           SELECT gen_random_uuid() AS id
         ), claimed_attachment AS (
           UPDATE platform.media_objects AS media
           SET retained_until = GREATEST(
                 COALESCE(media.retained_until, now()),
                 now() + $10::interval
               ),
               source_metadata = media.source_metadata || jsonb_build_object(
                 'attachmentState', 'claimed',
                 'claimedByMessageId', (SELECT id::text FROM message_identity)
               ),
               updated_at = now()
           WHERE media.id = $8::uuid
             AND media.purpose = 'marketplace.collaboration_chat.attachment'
             AND media.visibility = 'private'
             AND media.lifecycle_status = 'active'
             AND media.storage_kind = 'vayada_managed'
             AND media.resource_product = 'marketplace'
             AND media.resource_type = 'collaboration'
             AND media.resource_id = $1::text
             AND media.created_by_user_id = $3::uuid
             AND media.owner_organization_id = $9::uuid
             AND (media.retained_until IS NULL OR media.retained_until > now())
             AND COALESCE(media.source_metadata ->> 'attachmentState', 'orphan') = 'orphan'
           RETURNING media.id
         )
         INSERT INTO marketplace.marketplace_chat_messages ${attachmentMessageColumns}
         SELECT message_identity.id, $1::uuid, $2::uuid, $3::uuid, $4, $5, $6, $7::jsonb
         FROM message_identity
         CROSS JOIN claimed_attachment
         ${returning}`,
        [
          collaboration.id,
          collaboration.propertyId,
          input.context.actor.internalUserId,
          input.side,
          input.contentType,
          input.content,
          JSON.stringify(metadata),
          attachment.mediaObject.mediaId,
          input.context.selectedOrganization.organizationId,
          "2 years",
          collaboration.sourceCollaborationId,
        ],
      )
    : await client.query<MarketplaceMessageRow>(
        `INSERT INTO marketplace.marketplace_chat_messages ${messageColumns}
         VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)
         ${returning}`,
        [
          collaboration.id,
          collaboration.propertyId,
          input.context.actor.internalUserId,
          input.side,
          input.contentType,
          input.content,
          JSON.stringify(metadata),
          collaboration.sourceCollaborationId,
        ],
      );
  if (attachment && !result.rows[0]) {
    throw new MarketplaceCollaborationWriteError(
      400,
      "invalid_query",
      "Chat attachment could not be claimed by this sender.",
    );
  }
  return result.rows[0]
    ? mapMessageRowWithAttachment(
        result.rows[0],
        {
          collaborationResourceId: collaboration.id,
          creatorOrganizationId: collaboration.creatorOrganizationId,
          hotelOrganizationId: collaboration.hotelOrganizationId,
        },
        attachmentMedia,
        attachment,
      )
    : null;
}

async function markPgCollaborationMessagesRead(
  pool: MarketplaceCollaborationQueryable,
  input: {
    context: RequestContext;
    side: MarketplaceCollaborationAuthorizationSide;
    collaborationId: string;
    readThrough: MarketplaceMessageCursor;
  },
): Promise<boolean> {
  const collaboration = await findPgCollaborationForSide(pool, input.context, input.side, {
    collaborationId: input.collaborationId,
  });
  if (!collaboration) return false;

  const result = await pool.query<{ cursorFound: boolean }>(
    `WITH read_cursor AS (
       SELECT created_at, id
       FROM marketplace.marketplace_chat_messages
       WHERE collaboration_id = $1
         AND property_id = $2
         AND created_at = $4::timestamptz
         AND id = $5::uuid
     ), updated AS (
       UPDATE marketplace.marketplace_chat_messages message
       SET read_at = NOW()
       FROM read_cursor
       WHERE message.collaboration_id = $1
         AND message.property_id = $2
         AND message.read_at IS NULL
         AND message.sender_type <> $3
         AND (message.created_at, message.id) <= (read_cursor.created_at, read_cursor.id)
       RETURNING message.id
     )
     SELECT EXISTS (SELECT 1 FROM read_cursor) AS "cursorFound"`,
    [
      collaboration.id,
      collaboration.propertyId,
      input.side,
      input.readThrough.createdAt,
      input.readThrough.messageId,
    ],
  );
  return result.rows[0]?.cursorFound ?? false;
}

async function executeMarketplaceCollaborationLifecycleCommand(
  pool: MarketplaceCollaborationTransactionalPool,
  input: {
    operation: MarketplaceCollaborationWriteOperation;
    context: RequestContext;
    side: MarketplaceCollaborationAuthorizationSide;
    organizationId: string;
    collaborationId: string;
    idempotencyKey: string;
    fingerprintPayload: unknown;
    authorize(client: PoolClient): Promise<boolean>;
    mutate(client: PoolClient): Promise<MarketplaceCollaborationLifecycleMutationResult | null>;
  },
): Promise<MarketplaceCollaborationLifecycleWriteResponse | null> {
  const keyHash = sha256(
    stableJson({
      organizationId: input.organizationId,
      side: input.side,
      collaborationId: input.collaborationId,
      key: input.idempotencyKey,
    }),
  );
  const fingerprint = sha256(stableJson(input.fingerprintPayload));
  const client = await pool.connect();
  let transactionOpen = false;
  try {
    await client.query("BEGIN");
    transactionOpen = true;

    if (!(await input.authorize(client))) {
      await client.query("ROLLBACK");
      transactionOpen = false;
      return null;
    }

    const existing = await findMarketplaceCollaborationReplay(client, {
      operation: input.operation,
      keyHash,
      organizationId: input.organizationId,
    });
    const replay = readMarketplaceCollaborationReplay(existing, fingerprint);
    if (replay) {
      const authorized = await authorizeMarketplaceCollaborationReplay(
        client,
        input.context,
        input.side,
        replay,
      );
      await client.query("COMMIT");
      transactionOpen = false;
      return authorized ? replay : null;
    }

    const reserved = await reserveMarketplaceCollaborationIdempotency(client, {
      operation: input.operation,
      collaborationId: input.collaborationId,
      idempotencyKey: input.idempotencyKey,
      keyHash,
      fingerprint,
      organizationId: input.organizationId,
    });
    if (!reserved) {
      const current = await findMarketplaceCollaborationReplay(client, {
        operation: input.operation,
        keyHash,
        organizationId: input.organizationId,
      });
      const currentReplay = readMarketplaceCollaborationReplay(current, fingerprint);
      if (currentReplay) {
        const authorized = await authorizeMarketplaceCollaborationReplay(
          client,
          input.context,
          input.side,
          currentReplay,
        );
        await client.query("COMMIT");
        transactionOpen = false;
        return authorized ? currentReplay : null;
      }
      throw new MarketplaceCollaborationWriteError(
        409,
        "idempotency_conflict",
        "Marketplace collaboration idempotency key is already in progress.",
      );
    }

    const mutation = await input.mutate(client);
    if (!mutation) {
      await client.query("ROLLBACK");
      transactionOpen = false;
      return null;
    }

    const response = await readLifecycleWrite(client, {
      collaborationResourceId: mutation.collaborationResourceId,
      side: input.side,
      command: mutation.command,
      sideEffects: mutation.sideEffects,
    });
    await completeMarketplaceCollaborationIdempotency(client, {
      operation: input.operation,
      keyHash,
      fingerprint,
      response,
      organizationId: input.organizationId,
    });
    await client.query("COMMIT");
    transactionOpen = false;
    return response;
  } catch (error) {
    if (transactionOpen) await rollbackQuietly(client);
    if (isActiveCollaborationUniqueViolation(error)) {
      throw new MarketplaceCollaborationWriteError(
        409,
        "invalid_transition",
        "An active collaboration already exists for this offer.",
      );
    }
    throw error;
  } finally {
    client.release();
  }
}

async function authorizePgLifecycleWriteReplay(
  client: PoolClient,
  input: MarketplaceCollaborationLifecycleWriteInput,
): Promise<boolean> {
  if (input.action === "create") {
    const offerId = readString(input.payload.offerId);
    if (!offerId) return false;
    const creator = await resolveCreatorProfileForCreate(client, input);
    if (!creator) return false;
    return Boolean(await resolveOfferForCreate(client, input.context, input.side, offerId));
  }
  if (!input.collaborationId) return false;
  return Boolean(
    await findPgCollaborationForSide(client, input.context, input.side, {
      collaborationId: input.collaborationId,
    }),
  );
}

async function createPgCollaboration(
  client: PoolClient,
  input: MarketplaceCollaborationLifecycleWriteInput,
): Promise<MarketplaceCollaborationLifecycleMutationResult | null> {
  const offerId = readString(input.payload.offerId);
  if (!offerId) {
    throw new MarketplaceCollaborationWriteError(400, "invalid_query", "create requires offerId.");
  }
  const application = parseCreatePayload(input.side, input.payload);
  if (!application.ok) {
    throw new MarketplaceCollaborationWriteError(
      application.error.statusCode,
      application.error.code,
      application.error.message,
    );
  }
  const initiatorSide = input.side;
  const creator = await resolveCreatorProfileForCreate(client, input);
  if (!creator) return null;

  const offer = await resolveOfferForCreate(client, input.context, input.side, offerId);
  if (!offer) return null;

  const proposedTerms = readTermsInput(input.payload);
  const selectedCompensationOptionId =
    input.side === "creator" ? readString(input.payload.compensationOptionId) : null;
  if (input.side === "creator" && !selectedCompensationOptionId) {
    throw new MarketplaceCollaborationWriteError(
      400,
      "invalid_query",
      "Creator applications require compensationOptionId.",
    );
  }
  const selectedCompensationOption = selectedCompensationOptionId
    ? await resolveCompensationOptionForCreate(client, offer.id, selectedCompensationOptionId)
    : null;
  if (selectedCompensationOptionId && !selectedCompensationOption) {
    throw new MarketplaceCollaborationWriteError(
      400,
      "invalid_query",
      "The selected compensation option does not belong to this offer.",
    );
  }
  const terms = selectedCompensationOption
    ? snapshotSelectedCompensationOption(selectedCompensationOption, proposedTerms)
    : proposedTerms;
  if (input.side === "hotel") {
    for (const [from, to, fromField, toField, sameDay] of [
      [terms.travelDateFrom, terms.travelDateTo, "travelDateFrom", "travelDateTo", false],
      [
        terms.preferredDateFrom,
        terms.preferredDateTo,
        "preferredDateFrom",
        "preferredDateTo",
        true,
      ],
    ] as const) {
      const result = validateDateRange(from, to, fromField, toField, sameDay);
      if (!result.ok)
        throw new MarketplaceCollaborationWriteError(400, "invalid_query", result.error.message);
    }
  }
  if (input.side === "creator") {
    await validatePgCollaborationDates(
      client,
      offer.propertyId,
      terms,
      selectedCompensationOption?.availabilityMonths,
    );
  }
  const newId = await client.query<{ id: string }>(`SELECT gen_random_uuid()::text AS id`);
  const collaborationId = newId.rows[0]?.id;
  if (!collaborationId) {
    throw new Error("Failed to allocate marketplace collaboration id.");
  }

  const insert = await client.query<{ id: string }>(
    `INSERT INTO marketplace.collaborations (
       id,
       creator_profile_id,
       creator_organization_id,
       property_id,
       hotel_organization_id,
       offer_id,
       source_system,
       source_collaboration_id,
       initiator_type,
       lifecycle_status,
       compensation_type,
       application_message,
       free_stay_min_nights,
       free_stay_max_nights,
       paid_amount,
       currency,
       discount_percentage,
       affiliate_enabled,
       affiliate_commission_percentage,
       travel_date_from,
       travel_date_to,
       preferred_date_from,
       preferred_date_to,
       preferred_months,
       creator_consent,
       collaboration_metadata
     )
     VALUES (
       $1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid, $6::uuid,
       'marketplace', $1, $7, 'pending', $8, $9, $10, $11, $12, $13, $14, $15,
       $16, $17, $18, $19, $20, $21::text[], $22,
       jsonb_build_object(
         'whyGreatFit', $23::text,
         'selectedCompensationOptionId', $24::text,
         'selectedCompensationOption', $25::jsonb
       )
     )
     RETURNING id::text AS id`,
    [
      collaborationId,
      creator.id,
      creator.organizationId,
      offer.propertyId,
      offer.organizationId,
      offer.id,
      initiatorSide,
      terms.compensationType,
      input.side === "creator" ? application.value.whyGreatFit : readString(input.payload.message),
      terms.freeStayMinNights,
      terms.freeStayMaxNights,
      terms.paidAmount,
      terms.currency ?? "USD",
      terms.discountPercentage,
      terms.affiliateEnabled ?? false,
      terms.affiliateCommissionPercentage,
      terms.travelDateFrom,
      terms.travelDateTo,
      terms.preferredDateFrom,
      terms.preferredDateTo,
      terms.preferredMonths ?? [],
      application.value.consent,
      application.value.whyGreatFit ?? "",
      selectedCompensationOptionId,
      selectedCompensationOption ? JSON.stringify(selectedCompensationOption) : null,
    ],
  );
  const insertedId = insert.rows[0]?.id;
  if (!insertedId) return null;

  await replacePgDeliverables(
    client,
    insertedId,
    offer.propertyId,
    readDeliverables(input.payload),
  );

  return {
    collaborationResourceId: insertedId,
    command: { action: "create", idempotencyKey: input.idempotencyKey },
    sideEffects: [{ type: "marketplace.collaboration.notification_requested" }],
  };
}

async function mutateExistingPgCollaboration(
  client: PoolClient,
  input: MarketplaceCollaborationLifecycleWriteInput,
  mutate: (
    client: PoolClient,
    input: MarketplaceCollaborationLifecycleWriteInput,
    collaboration: CollaborationMutationRow,
  ) => Promise<MarketplaceCollaborationLifecycleMutationResult | null>,
): Promise<MarketplaceCollaborationLifecycleMutationResult | null> {
  if (!input.collaborationId) return null;
  await client.query(
    `SELECT id FROM marketplace.collaborations WHERE source_collaboration_id = $1 FOR UPDATE`,
    [input.collaborationId],
  );
  const collaboration = await findPgCollaborationForSide(client, input.context, input.side, {
    collaborationId: input.collaborationId,
  });
  if (!collaboration) return null;
  if (
    input.payload.expectedUpdatedAt !== undefined &&
    input.payload.expectedUpdatedAt !== toIsoString(collaboration.updatedAt)
  ) {
    throw new MarketplaceCollaborationWriteError(
      409,
      "invalid_transition",
      "This request changed. Review the latest details before trying again.",
    );
  }
  return mutate(client, input, collaboration);
}

async function validatePgCollaborationDates(
  client: MarketplaceCollaborationQueryable,
  propertyId: string,
  terms: {
    travelDateFrom: string | null;
    travelDateTo: string | null;
    preferredDateFrom?: string | null;
    preferredDateTo?: string | null;
  },
  availabilityMonths?: readonly string[],
): Promise<void> {
  const result = await client.query<{ timezone: string | null }>(
    `SELECT timezone
     FROM hotel_catalog.property_locations WHERE property_id = $1::uuid`,
    [propertyId],
  );
  const today = collaborationToday(result.rows[0]?.timezone);
  const error =
    collaborationDateError(terms.travelDateFrom, terms.travelDateTo, today) ??
    (terms.preferredDateFrom || terms.preferredDateTo
      ? collaborationDateError(terms.preferredDateFrom, terms.preferredDateTo, today)
      : null) ??
    collaborationAvailabilityError(availabilityMonths ?? [], today);
  if (error) throw new MarketplaceCollaborationWriteError(400, "invalid_query", error);
}

async function respondPgCollaboration(
  client: PoolClient,
  input: MarketplaceCollaborationLifecycleWriteInput,
  collaboration: CollaborationMutationRow,
): Promise<MarketplaceCollaborationLifecycleMutationResult | null> {
  if (collaboration.initiatorSide === input.side) {
    throw new MarketplaceCollaborationWriteError(
      403,
      "forbidden",
      "Collaboration initiator cannot respond to their own request.",
    );
  }
  if (collaboration.lifecycleStatus !== "pending") {
    throw new MarketplaceCollaborationWriteError(
      409,
      "invalid_transition",
      "Only pending collaborations can be accepted or declined.",
    );
  }
  const status = readString(input.payload.status);
  if (status !== "accepted" && status !== "declined") {
    throw new MarketplaceCollaborationWriteError(
      400,
      "invalid_query",
      "respond status must be accepted or declined.",
    );
  }
  const nextStatus = status === "accepted" ? "negotiating" : "declined";
  await client.query(
    `UPDATE marketplace.collaborations
     SET lifecycle_status = $2,
         responded_at = now(),
         collaboration_metadata = jsonb_set(
           collaboration_metadata,
           '{responseMessage}',
           to_jsonb($3::text),
           true
         ),
         updated_at = now()
     WHERE id = $1::uuid`,
    [collaboration.id, nextStatus, readString(input.payload.responseMessage) ?? ""],
  );
  return {
    collaborationResourceId: collaboration.id,
    command: { action: "respond", idempotencyKey: input.idempotencyKey },
    sideEffects: [{ type: "marketplace.collaboration.system_message_requested" }],
  };
}

async function editPgCollaborationApplication(
  client: PoolClient,
  input: MarketplaceCollaborationLifecycleWriteInput,
  collaboration: CollaborationMutationRow,
): Promise<MarketplaceCollaborationLifecycleMutationResult> {
  if (input.side !== "creator" || collaboration.initiatorSide !== "creator") {
    throw new MarketplaceCollaborationWriteError(
      403,
      "forbidden",
      "Only the creator can edit their application.",
    );
  }
  if (collaboration.lifecycleStatus !== "pending") {
    throw new MarketplaceCollaborationWriteError(
      409,
      "invalid_transition",
      "Only pending applications can be edited.",
    );
  }
  const application = parseCreatePayload("creator", input.payload);
  if (!application.ok)
    throw new MarketplaceCollaborationWriteError(400, "invalid_query", application.error.message);
  const optionId = readString(input.payload.compensationOptionId);
  const option =
    optionId && (await resolveCompensationOptionForCreate(client, collaboration.offerId, optionId));
  if (!option)
    throw new MarketplaceCollaborationWriteError(
      400,
      "invalid_query",
      "Choose a compensation option belonging to this offer.",
    );
  const terms = snapshotSelectedCompensationOption(option, readTermsInput(input.payload));
  await validatePgCollaborationDates(
    client,
    collaboration.propertyId,
    terms,
    option.availabilityMonths,
  );
  await client.query(
    `UPDATE marketplace.collaborations SET
       application_message = $2, creator_consent = TRUE,
       compensation_type = $3, free_stay_min_nights = $4, free_stay_max_nights = $5,
       paid_amount = $6, currency = $7, discount_percentage = $8,
       affiliate_enabled = $9, affiliate_commission_percentage = $10,
       travel_date_from = $11, travel_date_to = $12,
       preferred_date_from = $13, preferred_date_to = $14, preferred_months = $15::text[],
       collaboration_metadata = collaboration_metadata || jsonb_build_object(
         'whyGreatFit', $2::text, 'selectedCompensationOptionId', $16::text,
         'selectedCompensationOption', $17::jsonb),
       creator_agreed_at = NULL, hotel_agreed_at = NULL, updated_at = GREATEST(clock_timestamp(), updated_at + interval '1 millisecond')
     WHERE id = $1::uuid`,
    [
      collaboration.id,
      application.value.whyGreatFit,
      terms.compensationType,
      terms.freeStayMinNights,
      terms.freeStayMaxNights,
      terms.paidAmount,
      terms.currency ?? "USD",
      terms.discountPercentage,
      terms.affiliateEnabled,
      terms.affiliateCommissionPercentage,
      terms.travelDateFrom,
      terms.travelDateTo,
      terms.preferredDateFrom,
      terms.preferredDateTo,
      terms.preferredMonths ?? [],
      optionId,
      JSON.stringify(option),
    ],
  );
  await replacePgDeliverables(
    client,
    collaboration.id,
    collaboration.propertyId,
    readDeliverables(input.payload),
  );
  return {
    collaborationResourceId: collaboration.id,
    command: { action: "edit_application", idempotencyKey: input.idempotencyKey },
    sideEffects: [{ type: "marketplace.collaboration.notification_requested" }],
  };
}

async function updatePgCollaborationTerms(
  client: PoolClient,
  input: MarketplaceCollaborationLifecycleWriteInput,
  collaboration: CollaborationMutationRow,
): Promise<MarketplaceCollaborationLifecycleMutationResult | null> {
  if (["declined", "completed", "cancelled"].includes(collaboration.lifecycleStatus)) {
    throw new MarketplaceCollaborationWriteError(
      409,
      "invalid_transition",
      "Terms cannot be updated for a closed collaboration.",
    );
  }
  const terms = readTermsInput(input.payload);
  const stored = await client.query<{
    travelDateFrom: string | null;
    travelDateTo: string | null;
    preferredDateFrom: string | null;
    preferredDateTo: string | null;
  }>(
    `SELECT travel_date_from::text AS "travelDateFrom", travel_date_to::text AS "travelDateTo",
            preferred_date_from::text AS "preferredDateFrom", preferred_date_to::text AS "preferredDateTo"
     FROM marketplace.collaborations WHERE id = $1::uuid FOR UPDATE`,
    [collaboration.id],
  );
  const previous = stored.rows[0];
  await validatePgCollaborationDates(client, collaboration.propertyId, {
    preferredDateFrom:
      terms.preferredDateFrom ??
      (terms.travelDateFrom && terms.travelDateTo ? null : previous?.preferredDateFrom),
    preferredDateTo:
      terms.preferredDateTo ??
      (terms.travelDateFrom && terms.travelDateTo ? null : previous?.preferredDateTo),
    travelDateFrom:
      terms.travelDateFrom ??
      previous?.travelDateFrom ??
      terms.preferredDateFrom ??
      previous?.preferredDateFrom ??
      null,
    travelDateTo:
      terms.travelDateTo ??
      previous?.travelDateTo ??
      terms.preferredDateTo ??
      previous?.preferredDateTo ??
      null,
  });
  await client.query(
    `UPDATE marketplace.collaborations
     SET lifecycle_status = 'negotiating',
         compensation_type = COALESCE($2, compensation_type),
         free_stay_min_nights = COALESCE($3, free_stay_min_nights),
         free_stay_max_nights = COALESCE($4, free_stay_max_nights),
         paid_amount = COALESCE($5, paid_amount),
         currency = COALESCE($6, currency),
         discount_percentage = COALESCE($7, discount_percentage),
         affiliate_enabled = COALESCE($8, affiliate_enabled),
         affiliate_commission_percentage = CASE
           WHEN $8 = FALSE THEN NULL
           ELSE COALESCE($9, affiliate_commission_percentage)
         END,
         travel_date_from = COALESCE($10, travel_date_from),
         travel_date_to = COALESCE($11, travel_date_to),
         preferred_date_from = CASE WHEN $10::date IS NOT NULL AND $11::date IS NOT NULL THEN NULL ELSE COALESCE($12, preferred_date_from) END,
         preferred_date_to = CASE WHEN $10::date IS NOT NULL AND $11::date IS NOT NULL THEN NULL ELSE COALESCE($13, preferred_date_to) END,
         preferred_months = CASE WHEN $14::text[] IS NULL THEN preferred_months ELSE $14::text[] END,
         term_last_updated_at = now(),
         creator_agreed_at = CASE WHEN $15 = 'creator' THEN now() ELSE NULL END,
         hotel_agreed_at = CASE WHEN $15 = 'hotel' THEN now() ELSE NULL END,
         updated_at = now()
     WHERE id = $1::uuid`,
    [
      collaboration.id,
      terms.compensationType,
      terms.freeStayMinNights,
      terms.freeStayMaxNights,
      terms.paidAmount,
      terms.currency,
      terms.discountPercentage,
      terms.affiliateEnabled,
      terms.affiliateCommissionPercentage,
      terms.travelDateFrom,
      terms.travelDateTo,
      terms.preferredDateFrom,
      terms.preferredDateTo,
      terms.preferredMonths,
      input.side,
    ],
  );
  const deliverables = readDeliverables(input.payload);
  if (deliverables) {
    await replacePgDeliverables(client, collaboration.id, collaboration.propertyId, deliverables);
  }
  return {
    collaborationResourceId: collaboration.id,
    command: { action: "update_terms", idempotencyKey: input.idempotencyKey },
    sideEffects: [{ type: "marketplace.collaboration.system_message_requested" }],
  };
}

async function approvePgCollaborationTerms(
  client: PoolClient,
  input: MarketplaceCollaborationLifecycleWriteInput,
  collaboration: CollaborationMutationRow,
): Promise<MarketplaceCollaborationLifecycleMutationResult | null> {
  if (
    collaboration.lifecycleStatus !== "negotiating" &&
    collaboration.lifecycleStatus !== "accepted"
  ) {
    throw new MarketplaceCollaborationWriteError(
      409,
      "invalid_transition",
      "Only negotiating collaborations can approve terms.",
    );
  }
  const acceptedAt = new Date().toISOString();
  const oppositeAlreadyAgreed =
    input.side === "hotel"
      ? collaboration.creatorAgreedAt !== null
      : collaboration.hotelAgreedAt !== null;
  const nextStatus =
    collaboration.lifecycleStatus === "accepted" || oppositeAlreadyAgreed
      ? "accepted"
      : "negotiating";
  await client.query(
    `UPDATE marketplace.collaborations
     SET creator_agreed_at = CASE WHEN $2 = 'creator' THEN COALESCE(creator_agreed_at, now()) ELSE creator_agreed_at END,
         hotel_agreed_at = CASE WHEN $2 = 'hotel' THEN COALESCE(hotel_agreed_at, now()) ELSE hotel_agreed_at END,
         lifecycle_status = $3,
         updated_at = now()
     WHERE id = $1::uuid`,
    [collaboration.id, input.side, nextStatus],
  );
  const sideEffects: MarketplaceCollaborationLifecycleSideEffect[] =
    nextStatus !== "accepted"
      ? [{ type: "marketplace.collaboration.system_message_requested" }]
      : [
          { type: "marketplace.collaboration.accepted" },
          ...(collaboration.affiliateEnabled
            ? [
                {
                  type: "marketplace.affiliate.provision.command_requested" as const,
                  idempotencyKey: `marketplace.affiliate.provision:collaboration:${collaboration.sourceCollaborationId}:v1`,
                },
              ]
            : []),
        ];
  return {
    collaborationResourceId: collaboration.id,
    command: { action: "approve_terms", idempotencyKey: input.idempotencyKey, acceptedAt },
    sideEffects,
  };
}

async function cancelPgCollaboration(
  client: PoolClient,
  input: MarketplaceCollaborationLifecycleWriteInput,
  collaboration: CollaborationMutationRow,
): Promise<MarketplaceCollaborationLifecycleMutationResult | null> {
  if (input.payload.pendingOnly === true && collaboration.lifecycleStatus !== "pending") {
    throw new MarketplaceCollaborationWriteError(
      409,
      "invalid_transition",
      "Only pending requests can be withdrawn.",
    );
  }
  if (["completed", "cancelled"].includes(collaboration.lifecycleStatus)) {
    throw new MarketplaceCollaborationWriteError(
      409,
      "invalid_transition",
      "Completed or cancelled collaborations cannot be cancelled.",
    );
  }
  await client.query(
    `UPDATE marketplace.collaborations
     SET lifecycle_status = 'cancelled',
         cancelled_at = now(),
         collaboration_metadata = jsonb_build_object('cancelledBy', $3::text) || jsonb_set(
           collaboration_metadata,
           '{cancellationReason}',
           to_jsonb($2::text),
           true
         ),
         updated_at = now()
     WHERE id = $1::uuid`,
    [collaboration.id, readString(input.payload.reason) ?? "", input.side],
  );
  return {
    collaborationResourceId: collaboration.id,
    command: { action: "cancel", idempotencyKey: input.idempotencyKey },
    sideEffects: [
      { type: "marketplace.collaboration.system_message_requested" },
      { type: "marketplace.collaboration.notification_requested" },
    ],
  };
}

async function togglePgCollaborationDeliverable(
  client: PoolClient,
  input: MarketplaceCollaborationLifecycleWriteInput,
  collaboration: CollaborationMutationRow,
): Promise<MarketplaceCollaborationLifecycleMutationResult | null> {
  if (!input.deliverableId) return null;
  const result = await client.query<{ id: string }>(
    `UPDATE marketplace.collaboration_deliverables
     SET deliverable_status = CASE WHEN deliverable_status = 'completed' THEN 'pending' ELSE 'completed' END,
         completed_at = CASE WHEN deliverable_status = 'completed' THEN NULL ELSE now() END,
         updated_at = now()
     WHERE id::text = $1
       AND collaboration_id = $2::uuid
       AND property_id = $3::uuid
     RETURNING id::text AS id`,
    [input.deliverableId, collaboration.id, collaboration.propertyId],
  );
  if (!result.rows[0]) return null;
  return {
    collaborationResourceId: collaboration.id,
    command: { action: "toggle_deliverable", idempotencyKey: input.idempotencyKey },
    sideEffects: [{ type: "marketplace.collaboration.system_message_requested" }],
  };
}

async function ratePgCollaborationCreator(
  client: PoolClient,
  input: MarketplaceCollaborationLifecycleWriteInput,
  collaboration: CollaborationMutationRow,
): Promise<MarketplaceCollaborationLifecycleMutationResult | null> {
  if (input.side !== "hotel") {
    throw new MarketplaceCollaborationWriteError(
      403,
      "forbidden",
      "Only hotel-side users can rate collaboration creators.",
    );
  }
  if (collaboration.lifecycleStatus !== "completed") {
    throw new MarketplaceCollaborationWriteError(
      409,
      "invalid_transition",
      "Only completed collaborations can be rated.",
    );
  }
  const rating = readInteger(input.payload.rating);
  if (rating === null || rating < 1 || rating > 5) {
    throw new MarketplaceCollaborationWriteError(
      400,
      "invalid_query",
      "rating must be an integer from 1 to 5.",
    );
  }
  const result = await client.query<{ id: string }>(
    `INSERT INTO marketplace.creator_ratings (
       creator_profile_id,
       creator_organization_id,
       property_id,
       hotel_organization_id,
       collaboration_id,
       rating,
       comment,
       created_by_user_id
     )
     VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid, $6, $7, $8::uuid)
     ON CONFLICT (collaboration_id) DO UPDATE
       SET rating = marketplace.creator_ratings.rating
     RETURNING id::text AS id`,
    [
      collaboration.creatorProfileId,
      collaboration.creatorOrganizationId,
      collaboration.propertyId,
      collaboration.hotelOrganizationId,
      collaboration.id,
      rating,
      readString(input.payload.comment),
      input.context.actor.internalUserId,
    ],
  );
  const ratingId = result.rows[0]?.id;
  if (!ratingId) return null;
  return {
    collaborationResourceId: collaboration.id,
    command: { action: "rate_creator", idempotencyKey: input.idempotencyKey, ratingId },
    sideEffects: [{ type: "marketplace.collaboration.notification_requested" }],
  };
}

async function findPgCollaborationForSide(
  pool: MarketplaceCollaborationQueryable,
  context: RequestContext,
  side: MarketplaceCollaborationAuthorizationSide,
  filters: { collaborationId: string },
): Promise<CollaborationMutationRow | null> {
  const access = collaborationAccessValues(context, side);
  const result = await pool.query<CollaborationMutationRow>(
    `${collaborationFromSql(
      side,
      `collaboration.id::text AS id,
       collaboration.property_id::text AS "propertyId",
       collaboration.offer_id::text AS "offerId",
       collaboration.updated_at AS "updatedAt",
       collaboration.lifecycle_status AS "lifecycleStatus",
       collaboration.initiator_type AS "initiatorSide",
       collaboration.source_collaboration_id AS "sourceCollaborationId",
       collaboration.compensation_type AS "compensationType",
       collaboration.affiliate_enabled AS "affiliateEnabled",
       collaboration.creator_profile_id::text AS "creatorProfileId",
       collaboration.creator_organization_id::text AS "creatorOrganizationId",
       collaboration.hotel_organization_id::text AS "hotelOrganizationId",
       collaboration.creator_agreed_at AS "creatorAgreedAt",
       collaboration.hotel_agreed_at AS "hotelAgreedAt"`,
    )}
     WHERE ${collaborationAccessWhereSql(side)}
       AND collaboration.source_collaboration_id = $${access.length + 1}
     LIMIT 1`,
    [...access, filters.collaborationId],
  );
  return result.rows[0] ?? null;
}

async function resolveCreatorProfileForCreate(
  client: MarketplaceCollaborationQueryable,
  input: MarketplaceCollaborationLifecycleWriteInput,
): Promise<{ id: string; organizationId: string } | null> {
  if (input.side === "creator") {
    const creatorProfile = resolveSingleOwnedCreatorProfileId(input.context);
    if (!creatorProfile.ok) {
      throw new MarketplaceCollaborationWriteError(
        creatorProfile.error.statusCode,
        creatorProfile.error.code,
        creatorProfile.error.message,
      );
    }
    if (!creatorProfile.value) return null;

    const result = await client.query<{ id: string; organizationId: string }>(
      `SELECT id::text AS id,
              organization_id::text AS "organizationId"
       FROM marketplace.creator_profiles
       WHERE id::text = $1
         AND organization_id::text = $2
       LIMIT 1`,
      [creatorProfile.value, input.context.selectedOrganization.organizationId],
    );
    return result.rows[0] ?? null;
  }

  const creatorId = readString(input.payload.creatorId);
  if (!creatorId) return null;

  const result = await client.query<{ id: string; organizationId: string }>(
    `SELECT id::text AS id,
            organization_id::text AS "organizationId"
     FROM marketplace.creator_profiles
     WHERE source_creator_id = $1
     LIMIT 1`,
    [creatorId],
  );
  return result.rows[0] ?? null;
}

type MarketplaceCompensationOptionForCreate = {
  compensationOptionId: string;
  compensationType: "free_stay" | "paid" | "discount" | "affiliate";
  availabilityMonths: string[];
  platforms: string[];
  freeStayMinNights: number | null;
  freeStayMaxNights: number | null;
  paidMaxAmount: string | null;
  currency: string | null;
  discountPercentage: number | null;
  commissionPercentage: string | null;
  minFollowers: number | null;
  termsSummary: string | null;
  metadata: unknown;
};

async function resolveCompensationOptionForCreate(
  client: MarketplaceCollaborationQueryable,
  offerId: string,
  compensationOptionId: string,
): Promise<MarketplaceCompensationOptionForCreate | null> {
  const result = await client.query<MarketplaceCompensationOptionForCreate>(
    `SELECT id::text AS "compensationOptionId",
            compensation_type AS "compensationType",
            availability_months AS "availabilityMonths",
            platforms,
            free_stay_min_nights AS "freeStayMinNights",
            free_stay_max_nights AS "freeStayMaxNights",
            paid_max_amount::text AS "paidMaxAmount",
            currency,
            discount_percentage AS "discountPercentage",
            commission_percentage::text AS "commissionPercentage",
            min_followers AS "minFollowers",
            terms_summary AS "termsSummary",
            compensation_metadata AS metadata
     FROM marketplace.offer_compensation_options
     WHERE id::text = $1
       AND offer_id = $2::uuid
     LIMIT 1`,
    [compensationOptionId, offerId],
  );
  return result.rows[0] ?? null;
}

function snapshotSelectedCompensationOption(
  option: MarketplaceCompensationOptionForCreate,
  proposedTerms: MarketplaceCollaborationTermsInput,
): MarketplaceCollaborationTermsInput {
  return {
    ...proposedTerms,
    compensationType: option.compensationType === "affiliate" ? null : option.compensationType,
    freeStayMinNights: option.freeStayMinNights,
    freeStayMaxNights: option.freeStayMaxNights,
    paidAmount: option.paidMaxAmount,
    currency: option.currency,
    discountPercentage: option.discountPercentage,
    affiliateEnabled: option.compensationType === "affiliate",
    affiliateCommissionPercentage: option.commissionPercentage,
  };
}

async function resolveOfferForCreate(
  client: MarketplaceCollaborationQueryable,
  context: RequestContext,
  side: MarketplaceCollaborationAuthorizationSide,
  offerId: string,
): Promise<{ id: string; propertyId: string; organizationId: string } | null> {
  const values: unknown[] = [offerId];
  const clauses = ["offer.id::text = $1"];
  if (side === "creator") {
    clauses.push("offer.offer_status = 'verified'");
    clauses.push(`EXISTS (
      SELECT 1
      FROM marketplace.marketplace_offer_read_model public_offer
      WHERE public_offer.offer_id = offer.id
        AND public_offer.property_id = offer.property_id
        AND public_offer.visibility_status = 'public'
    )`);
  } else {
    clauses.push("offer.offer_status IN ('pending', 'verified')");
    values.push(activeResourceIds(context, "marketplace_offer", "operator"));
    clauses.push(`offer.id::text = ANY($${values.length}::text[])`);
    values.push(context.selectedOrganization.organizationId);
    clauses.push(`offer.organization_id::text = $${values.length}`);
  }
  const result = await client.query<{ id: string; propertyId: string; organizationId: string }>(
    `SELECT id::text AS id,
            property_id::text AS "propertyId",
            organization_id::text AS "organizationId"
     FROM marketplace.marketplace_offers offer
     WHERE ${clauses.join(" AND ")}
     LIMIT 1
     FOR SHARE`,
    values,
  );
  return result.rows[0] ?? null;
}

async function replacePgDeliverables(
  client: MarketplaceCollaborationQueryable,
  collaborationId: string,
  propertyId: string,
  deliverables: MarketplaceCollaborationDeliverableInput[] | null,
): Promise<void> {
  if (!deliverables) return;
  await client.query(
    `DELETE FROM marketplace.collaboration_deliverables
     WHERE collaboration_id = $1::uuid
       AND property_id = $2::uuid`,
    [collaborationId, propertyId],
  );
  for (const deliverable of deliverables) {
    await client.query(
      `INSERT INTO marketplace.collaboration_deliverables (
         collaboration_id,
         property_id,
         platform,
         deliverable_type,
         quantity,
         deliverable_status
       )
       VALUES ($1::uuid, $2::uuid, $3, $4, $5, 'pending')`,
      [collaborationId, propertyId, deliverable.platform, deliverable.type, deliverable.quantity],
    );
  }
}

async function readLifecycleWrite(
  pool: MarketplaceCollaborationQueryable,
  input: {
    collaborationResourceId: string;
    side: MarketplaceCollaborationAuthorizationSide;
    command: MarketplaceCollaborationLifecycleWriteCommand;
    sideEffects: MarketplaceCollaborationLifecycleSideEffect[];
  },
): Promise<MarketplaceCollaborationLifecycleWriteResponse> {
  const result = await pool.query<MarketplaceCollaborationRow>(
    `${collaborationFromSql(input.side)}
     WHERE collaboration.id::text = $1
     LIMIT 1`,
    [input.collaborationResourceId],
  );
  const collaboration = result.rows[0];
  if (!collaboration) throw new Error("Updated marketplace collaboration was not found.");
  return {
    contractVersion: MARKETPLACE_COLLABORATION_LIFECYCLE_WRITES_CONTRACT_VERSION,
    command: input.command,
    collaboration: mapCollaborationRow(collaboration, input.side),
    sideEffects: input.sideEffects,
  };
}

async function findMarketplaceCollaborationReplay(
  client: MarketplaceCollaborationQueryable,
  input: {
    operation: MarketplaceCollaborationWriteOperation;
    keyHash: string;
    organizationId: string;
  },
): Promise<MarketplaceCollaborationReplayRow | null> {
  const result = await client.query<MarketplaceCollaborationReplayRow>(
    `SELECT
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
    [input.operation, input.keyHash, input.organizationId],
  );
  return result.rows[0] ?? null;
}

async function authorizeMarketplaceCollaborationReplay(
  client: MarketplaceCollaborationQueryable,
  context: RequestContext,
  side: MarketplaceCollaborationAuthorizationSide,
  replay: MarketplaceCollaborationLifecycleWriteResponse,
): Promise<boolean> {
  return Boolean(
    await findPgCollaborationForSide(client, context, side, {
      collaborationId: replay.collaboration.collaborationId,
    }),
  );
}

function readMarketplaceCollaborationReplay(
  row: MarketplaceCollaborationReplayRow | null,
  fingerprint: string,
): MarketplaceCollaborationLifecycleWriteResponse | null {
  if (!row) return null;
  if (row.requestFingerprintHash !== fingerprint) {
    throw new MarketplaceCollaborationWriteError(
      409,
      "idempotency_conflict",
      "Idempotency key was already used with a different marketplace collaboration payload.",
    );
  }
  if (row.status === "completed") {
    const response = readLifecycleReplayResponse(row.metadata);
    if (!response) {
      throw new Error("Completed marketplace collaboration idempotency key has no response.");
    }
    return {
      ...response,
      command: { ...response.command, replayed: true },
    };
  }
  return null;
}

function readMarketplaceMessageReplay(
  row: MarketplaceCollaborationReplayRow | null,
  fingerprint: string,
): MarketplaceCollaborationMessage | null {
  if (!row) return null;
  if (row.requestFingerprintHash !== fingerprint) {
    throw new MarketplaceCollaborationWriteError(
      409,
      "idempotency_conflict",
      "Idempotency key was already used with a different marketplace message payload.",
    );
  }
  if (row.status !== "completed") return null;
  if (!isRecord(row.metadata) || !isRecord(row.metadata.messageResponse)) {
    throw new Error("Completed marketplace message idempotency key has no response.");
  }
  const message = row.metadata.messageResponse;
  if (
    message.contractVersion !== MARKETPLACE_COLLABORATION_READS_CONTRACT_VERSION ||
    typeof message.messageId !== "string" ||
    typeof message.collaborationId !== "string" ||
    typeof message.content !== "string" ||
    typeof message.createdAt !== "string"
  ) {
    throw new Error("Completed marketplace message idempotency response is invalid.");
  }
  return message as MarketplaceCollaborationMessage;
}

async function reserveMarketplaceCollaborationIdempotency(
  client: MarketplaceCollaborationQueryable,
  input: {
    operation: MarketplaceCollaborationWriteOperation;
    collaborationId: string;
    idempotencyKey: string;
    keyHash: string;
    fingerprint: string;
    organizationId: string;
  },
): Promise<boolean> {
  const result = await client.query<{ id: string }>(
    `INSERT INTO platform.idempotency_keys (
       operation_scope,
       operation,
       key_hash,
       request_fingerprint_hash,
       status,
       tenant_scope,
       organization_id,
       correlation_id,
       expires_at,
       idempotency_metadata
     )
     VALUES (
       'marketplace',
       $1,
       $2,
       $3,
       'in_progress',
       'organization',
       $4::uuid,
       $5,
       now() + interval '24 hours',
       $6::jsonb
     )
     ON CONFLICT (operation_scope, operation, key_hash, scope_key) DO NOTHING
     RETURNING id::text AS id`,
    [
      input.operation,
      input.keyHash,
      input.fingerprint,
      input.organizationId,
      input.idempotencyKey,
      JSON.stringify({
        collaborationId: input.collaborationId,
        idempotencyKey: input.idempotencyKey,
      }),
    ],
  );
  return Boolean(result.rows[0]);
}

async function completeMarketplaceCollaborationIdempotency(
  client: MarketplaceCollaborationQueryable,
  input: {
    operation: MarketplaceCollaborationWriteOperation;
    keyHash: string;
    fingerprint: string;
    response: MarketplaceCollaborationLifecycleWriteResponse;
    organizationId: string;
  },
): Promise<void> {
  await client.query(
    `UPDATE platform.idempotency_keys
     SET status = 'completed',
         request_fingerprint_hash = $1,
         response_status_code = 200,
         response_body_hash = $2,
         response_resource_product = 'marketplace',
         response_resource_type = 'collaboration',
         response_resource_id = $3,
         completed_at = now(),
         last_seen_at = now(),
         idempotency_metadata = idempotency_metadata || $4::jsonb
     WHERE operation_scope = 'marketplace'
       AND operation = $5
       AND key_hash = $6
       AND tenant_scope = 'organization'
       AND organization_id = $7::uuid`,
    [
      input.fingerprint,
      sha256(stableJson(input.response)),
      input.response.collaboration.collaborationId,
      JSON.stringify({ response: input.response }),
      input.operation,
      input.keyHash,
      input.organizationId,
    ],
  );
}

async function completeMarketplaceMessageIdempotency(
  client: MarketplaceCollaborationQueryable,
  input: {
    operation: "marketplace_collaboration_send_message";
    keyHash: string;
    fingerprint: string;
    message: MarketplaceCollaborationMessage;
    organizationId: string;
  },
): Promise<void> {
  const replayMessage = stableMarketplaceMessageResponse(input.message);
  await client.query(
    `UPDATE platform.idempotency_keys
     SET status = 'completed',
         request_fingerprint_hash = $1,
         response_status_code = 201,
         response_body_hash = $2,
         response_resource_product = 'marketplace',
         response_resource_type = 'collaboration_message',
         response_resource_id = $3,
         completed_at = now(),
         last_seen_at = now(),
         idempotency_metadata = idempotency_metadata || $4::jsonb
     WHERE operation_scope = 'marketplace'
       AND operation = $5
       AND key_hash = $6
       AND tenant_scope = 'organization'
       AND organization_id = $7::uuid`,
    [
      input.fingerprint,
      sha256(stableJson(replayMessage)),
      replayMessage.messageId,
      JSON.stringify({ messageResponse: replayMessage }),
      input.operation,
      input.keyHash,
      input.organizationId,
    ],
  );
}

function readLifecycleReplayResponse(
  metadata: unknown,
): MarketplaceCollaborationLifecycleWriteResponse | null {
  if (!isRecord(metadata) || !isRecord(metadata.response)) return null;
  const response = metadata.response;
  if (
    response.contractVersion !== MARKETPLACE_COLLABORATION_LIFECYCLE_WRITES_CONTRACT_VERSION ||
    !isRecord(response.command) ||
    !isRecord(response.collaboration) ||
    !Array.isArray(response.sideEffects)
  ) {
    return null;
  }
  return response as MarketplaceCollaborationLifecycleWriteResponse;
}

async function rollbackQuietly(client: PoolClient): Promise<void> {
  try {
    await client.query("ROLLBACK");
  } catch {
    // Preserve the original write error.
  }
}

function readTermsInput(payload: Record<string, unknown>): MarketplaceCollaborationTermsInput {
  const terms = isRecord(payload.terms) ? payload.terms : payload;
  const affiliateCommissionPercentage = readString(terms.affiliateCommissionPercentage);
  return {
    compensationType: readCompensationType(terms.compensationType),
    freeStayMinNights: readInteger(terms.freeStayMinNights),
    freeStayMaxNights: readInteger(terms.freeStayMaxNights),
    paidAmount: readString(terms.paidAmount),
    currency: readCurrency(terms.currency),
    discountPercentage: readInteger(terms.discountPercentage),
    affiliateEnabled:
      readBoolean(terms.affiliateEnabled) ?? (affiliateCommissionPercentage !== null ? true : null),
    affiliateCommissionPercentage,
    travelDateFrom: readDateString(terms.travelDateFrom),
    travelDateTo: readDateString(terms.travelDateTo),
    preferredDateFrom: readDateString(terms.preferredDateFrom),
    preferredDateTo: readDateString(terms.preferredDateTo),
    preferredMonths: readStringArray(terms.preferredMonths),
  };
}

type MarketplaceCollaborationTermsInput = {
  compensationType: MarketplaceCollaborationRead["compensationType"];
  freeStayMinNights: number | null;
  freeStayMaxNights: number | null;
  paidAmount: string | null;
  currency: string | null;
  discountPercentage: number | null;
  affiliateEnabled: boolean | null;
  affiliateCommissionPercentage: string | null;
  travelDateFrom: string | null;
  travelDateTo: string | null;
  preferredDateFrom: string | null;
  preferredDateTo: string | null;
  preferredMonths: string[] | null;
};

type MarketplaceCollaborationDeliverableInput = {
  platform: string;
  type: string;
  quantity: number;
};

function readDeliverables(
  payload: Record<string, unknown>,
): MarketplaceCollaborationDeliverableInput[] | null {
  const value = payload.deliverables;
  if (!Array.isArray(value)) return null;
  return value
    .map((entry) => (isRecord(entry) ? entry : null))
    .filter((entry): entry is Record<string, unknown> => Boolean(entry))
    .map((entry) => ({
      platform: readString(entry.platform) ?? "",
      type: readString(entry.type) ?? "",
      quantity: readInteger(entry.quantity) ?? 0,
    }))
    .filter((entry) => entry.platform.length > 0 && entry.type.length > 0 && entry.quantity > 0);
}

function createCollaborationCorrelationId(
  input: MarketplaceCollaborationLifecycleWriteInput,
): string {
  const offerId = readString(input.payload.offerId) ?? "unknown_offer";
  const linkedCreatorProfileIds = activeResourceIds(input.context, "creator_profile", "owner");
  if (input.side === "creator" && linkedCreatorProfileIds.length > 1) {
    throw ambiguousCreatorResourceLink();
  }
  const creatorId =
    (input.side === "hotel" ? readString(input.payload.creatorId) : null) ??
    linkedCreatorProfileIds[0] ??
    "unknown_creator";
  return `${offerId}:${creatorId}`;
}

function createFingerprintPayload(
  side: MarketplaceCollaborationAuthorizationSide,
  payload: Record<string, unknown>,
): Record<string, unknown> {
  const { side: _side, initiatorSide: _initiatorSide, ...authenticatedPayload } = payload;
  if (side === "creator") {
    const { creatorId: _creatorId, message: _message, ...creatorPayload } = authenticatedPayload;
    return creatorPayload;
  }
  const {
    compensationOptionId: _compensationOptionId,
    whyGreatFit: _whyGreatFit,
    consent: _consent,
    ...hotelPayload
  } = authenticatedPayload;
  return hotelPayload;
}

async function queryCollaborationRows(
  pool: MarketplaceCollaborationReadPool,
  context: RequestContext,
  side: MarketplaceCollaborationAuthorizationSide,
  filters: {
    collaborationId?: string;
    status?: CollaborationStatus;
    initiatedBy?: MarketplaceCollaborationAuthorizationSide;
    offerId?: string;
  },
): Promise<MarketplaceCollaborationRow[]> {
  const values: unknown[] = collaborationAccessValues(context, side);
  const clauses = [
    collaborationAccessWhereSql(side),
    "collaboration.source_collaboration_id IS NOT NULL",
  ];
  if (filters.collaborationId) {
    values.push(filters.collaborationId);
    clauses.push(`collaboration.source_collaboration_id = $${values.length}`);
  }
  if (filters.status) {
    values.push(filters.status);
    clauses.push(`collaboration.lifecycle_status = $${values.length}`);
  }
  if (filters.initiatedBy) {
    values.push(filters.initiatedBy);
    clauses.push(`collaboration.initiator_type = $${values.length}`);
  }
  if (filters.offerId) {
    values.push(filters.offerId);
    clauses.push(`offer.id::text = $${values.length}`);
  }

  const result = await pool.query<MarketplaceCollaborationRow>(
    `${collaborationFromSql(side)}
     WHERE ${clauses.join("\n       AND ")}
     ORDER BY collaboration.updated_at DESC, collaboration.source_collaboration_id ASC
     LIMIT 100`,
    values,
  );
  return result.rows;
}

function collaborationFromSql(
  side: MarketplaceCollaborationAuthorizationSide,
  select = collaborationSelectSql(side),
): string {
  return `SELECT ${select}
          FROM marketplace.collaborations collaboration
          JOIN marketplace.creator_profiles creator
            ON creator.id = collaboration.creator_profile_id
           AND creator.organization_id = collaboration.creator_organization_id
          JOIN marketplace.marketplace_offers offer
            ON offer.id = collaboration.offer_id
           AND offer.property_id = collaboration.property_id
           AND offer.organization_id = collaboration.hotel_organization_id
          JOIN marketplace.marketplace_hotel_profiles hotel_profile
            ON hotel_profile.property_id = collaboration.property_id
           AND hotel_profile.organization_id = collaboration.hotel_organization_id
          JOIN hotel_catalog.properties property
            ON property.id = collaboration.property_id
          LEFT JOIN hotel_catalog.property_locations property_location
            ON property_location.property_id = collaboration.property_id
          LEFT JOIN hotel_catalog.property_public_profile_read_model public_profile
            ON public_profile.property_id = collaboration.property_id
          LEFT JOIN LATERAL (
            SELECT jsonb_agg(
                     jsonb_build_object(
                       'platform', creator_platform.platform,
                       'handle', creator_platform.handle,
                       'profileUrl', creator_platform.profile_url,
                       'followerCount', creator_platform.follower_count,
                       'engagementRate', creator_platform.engagement_rate,
                       'audienceCountries', creator_platform.audience_countries,
                       'audienceAgeGroups', creator_platform.audience_age_groups,
                       'audienceGenderSplit', creator_platform.audience_gender_split,
                       'verificationStatus', creator_platform.verification_status
                     )
                     ORDER BY creator_platform.follower_count DESC, creator_platform.id ASC
                   ) AS platforms
            FROM marketplace.creator_platforms creator_platform
            WHERE creator_platform.creator_profile_id = creator.id
              AND creator_platform.organization_id = creator.organization_id
          ) creator_platforms ON TRUE
          LEFT JOIN LATERAL (
            SELECT jsonb_agg(
                     jsonb_build_object(
                       'deliverableId', deliverable.id::text,
                       'platform', deliverable.platform,
                       'type', deliverable.deliverable_type,
                       'quantity', deliverable.quantity,
                       'status', CASE
                         WHEN deliverable.deliverable_status = 'completed' THEN 'completed'
                         ELSE 'pending'
                       END,
                       'completedAt', deliverable.completed_at
                     )
                     ORDER BY deliverable.created_at ASC, deliverable.id ASC
                   ) AS deliverables
            FROM marketplace.collaboration_deliverables deliverable
            WHERE deliverable.collaboration_id = collaboration.id
              AND deliverable.property_id = collaboration.property_id
          ) deliverables ON TRUE
          LEFT JOIN LATERAL (
            SELECT MAX(message.created_at) AS last_message_at
            FROM marketplace.marketplace_chat_messages message
            WHERE message.collaboration_id = collaboration.id
              AND message.property_id = collaboration.property_id
          ) messages ON TRUE`;
}

function collaborationSelectSql(side: MarketplaceCollaborationAuthorizationSide): string {
  return `collaboration.source_collaboration_id AS "collaborationId",
          '${authorizationModeForSide(side)}'::text AS "authorizationMode",
          offer.id::text AS "offerId",
          COALESCE(NULLIF(creator.source_creator_id, ''), creator.id::text) AS "creatorId",
          hotel_profile.source_hotel_profile_id AS "hotelProfileId",
          '${side}'::text AS side,
          collaboration.initiator_type AS "initiatorSide",
          collaboration.lifecycle_status AS status,
          collaboration.compensation_type AS "compensationType",
          collaboration.application_message AS "applicationMessage",
          collaboration.collaboration_metadata->>'selectedCompensationOptionId' AS "selectedCompensationOptionId",
          collaboration.collaboration_metadata->>'cancelledBy' AS "cancelledBy",
          collaboration.creator_consent AS "creatorConsent",
          collaboration.creator_agreed_at AS "creatorAgreedAt",
          collaboration.hotel_agreed_at AS "hotelAgreedAt",
          property_location.timezone AS "propertyTimezone",
          offer.title AS "offerTitle",
          NULLIF(concat_ws(
            ', ',
            NULLIF(public_profile.location->>'city', ''),
            NULLIF(public_profile.location->>'region', ''),
            NULLIF(public_profile.location->>'countryCode', '')
          ), '') AS "hotelLocation",
          creator.id::text AS "creatorProfileId",
          creator.organization_id::text AS "creatorOrganizationId",
          creator.display_name AS "creatorDisplayName",
          creator.profile_picture_url AS "creatorAvatarUrl",
          creator.location_text AS "creatorLocation",
          creator.portfolio_url AS "creatorPortfolioUrl",
          creator.creator_type AS "creatorType",
          COALESCE(creator_platforms.platforms, '[]'::jsonb) AS "creatorPlatforms",
          hotel_profile.property_id::text AS "hotelProfileResourceId",
          hotel_profile.organization_id::text AS "hotelOrganizationId",
          COALESCE(public_profile.display_name, property.display_name) AS "hotelDisplayName",
          NULL::text AS "hotelAvatarUrl",
          collaboration.free_stay_min_nights AS "freeStayMinNights",
          collaboration.free_stay_max_nights AS "freeStayMaxNights",
          collaboration.paid_amount::text AS "paidAmount",
          collaboration.currency AS currency,
          collaboration.discount_percentage AS "discountPercentage",
          collaboration.affiliate_enabled AS "affiliateEnabled",
          collaboration.affiliate_commission_percentage::text AS "affiliateCommissionPercentage",
          collaboration.travel_date_from AS "travelDateFrom",
          collaboration.travel_date_to AS "travelDateTo",
          collaboration.preferred_date_from AS "preferredDateFrom",
          collaboration.preferred_date_to AS "preferredDateTo",
          collaboration.preferred_months AS "preferredMonths",
          COALESCE(deliverables.deliverables, '[]'::jsonb) AS deliverables,
          messages.last_message_at AS "lastMessageAt",
          collaboration.created_at AS "createdAt",
          collaboration.updated_at AS "updatedAt"`;
}

function conversationSelectSql(side: MarketplaceCollaborationAuthorizationSide): string {
  const partnerName = conversationPartnerNameSql(side);
  const partnerAvatar = side === "creator" ? "NULL::text" : "creator.profile_picture_url";
  return `collaboration.source_collaboration_id AS "collaborationId",
          '${side}'::text AS side,
          ${partnerName} AS "partnerName",
          ${partnerAvatar} AS "partnerAvatarUrl",
          offer.title AS "offerTitle",
          collaboration.lifecycle_status AS "collaborationStatus",
          last_message."lastMessageContent",
          last_message."lastMessageAt",
          unread.unread_count AS "unreadCount",
          COALESCE(last_message."lastMessageAt", collaboration.updated_at) AS "sortAt"`;
}

function conversationPartnerNameSql(side: MarketplaceCollaborationAuthorizationSide): string {
  return side === "creator"
    ? "COALESCE(public_profile.display_name, property.display_name)"
    : "creator.display_name";
}

function collaborationAccessValues(
  context: RequestContext,
  side: MarketplaceCollaborationAuthorizationSide,
): string[][] {
  if (side === "creator") {
    return [activeResourceIds(context, "creator_profile", "owner")];
  }
  return [activeResourceIds(context, "marketplace_offer", "operator")];
}

function collaborationAccessWhereSql(side: MarketplaceCollaborationAuthorizationSide): string {
  if (side === "creator") {
    return "creator.id::text = ANY($1::text[])";
  }
  return "offer.id::text = ANY($1::text[])";
}

function activeResourceIds(
  context: RequestContext,
  resourceType: "creator_profile" | "marketplace_offer",
  relationship: "owner" | "operator",
): string[] {
  return [
    ...new Set(
      context.linkedResources
        .filter(
          (resource) =>
            resource.status === "active" &&
            resource.product === "marketplace" &&
            resource.resourceType === resourceType &&
            resource.relationship === relationship,
        )
        .map((resource) => resource.resourceId),
    ),
  ];
}

function resolveSingleOwnedCreatorProfileId(
  context: RequestContext,
): ParseResult<string | undefined> {
  const creatorProfileIds = activeResourceIds(context, "creator_profile", "owner");
  if (creatorProfileIds.length > 1) {
    return { ok: false, error: ambiguousCreatorResourceLink() };
  }
  return { ok: true, value: creatorProfileIds[0] };
}

function mapCollaborationRow(
  row: MarketplaceCollaborationRow,
  side: MarketplaceCollaborationAuthorizationSide,
): MarketplaceCollaborationRead {
  return {
    contractVersion: MARKETPLACE_COLLABORATION_READS_CONTRACT_VERSION,
    authorizationMode: authorizationModeForSide(side),
    collaborationId: row.collaborationId,
    offerId: row.offerId,
    creatorId: row.creatorId,
    propertyTimezone: row.propertyTimezone ?? null,
    hotelProfileId: row.hotelProfileId,
    side,
    initiatorSide: toCollaborationSide(row.initiatorSide),
    isInitiator: toCollaborationSide(row.initiatorSide) === side,
    status: toCollaborationStatus(row.status),
    compensationType: toCompensationType(row.compensationType),
    offerTitle: row.offerTitle,
    hotelLocation: row.hotelLocation,
    applicationMessage: row.applicationMessage,
    selectedCompensationOptionId: row.selectedCompensationOptionId,
    cancelledBy:
      row.cancelledBy === "creator" || row.cancelledBy === "hotel" ? row.cancelledBy : null,
    creatorConsent: row.creatorConsent,
    creatorAgreedAt: toIsoStringOrNull(row.creatorAgreedAt),
    hotelAgreedAt: toIsoStringOrNull(row.hotelAgreedAt),
    creator: {
      side: "creator",
      organizationId: row.creatorOrganizationId,
      profileId: row.creatorProfileId,
      displayName: row.creatorDisplayName ?? "Creator",
      avatarUrl: row.creatorAvatarUrl,
      location: row.creatorLocation,
      portfolioUrl: row.creatorPortfolioUrl,
      creatorType: row.creatorType,
      platforms: toCreatorPlatforms(row.creatorPlatforms),
    },
    hotel: {
      side: "hotel",
      organizationId: row.hotelOrganizationId,
      profileId: row.hotelProfileResourceId,
      displayName: row.hotelDisplayName,
      avatarUrl: row.hotelAvatarUrl,
    },
    terms: {
      freeStayMinNights: row.freeStayMinNights,
      freeStayMaxNights: row.freeStayMaxNights,
      paidAmount: row.paidAmount,
      currency: row.currency,
      discountPercentage: row.discountPercentage,
      affiliateEnabled: row.affiliateEnabled,
      affiliateCommissionPercentage: row.affiliateCommissionPercentage,
      travelDateFrom: toDateString(row.travelDateFrom),
      travelDateTo: toDateString(row.travelDateTo),
      preferredDateFrom: toDateString(row.preferredDateFrom),
      preferredDateTo: toDateString(row.preferredDateTo),
      preferredMonths: Array.isArray(row.preferredMonths) ? row.preferredMonths : [],
    },
    deliverables: toDeliverables(row.deliverables),
    lastMessageAt: toIsoStringOrNull(row.lastMessageAt),
    createdAt: toIsoString(row.createdAt),
    updatedAt: toIsoString(row.updatedAt),
  };
}

function mapConversationRow(row: MarketplaceConversationRow): MarketplaceConversationSummary {
  return {
    contractVersion: MARKETPLACE_COLLABORATION_READS_CONTRACT_VERSION,
    collaborationId: row.collaborationId,
    side: row.side,
    partnerName: row.partnerName ?? "Marketplace participant",
    partnerAvatarUrl: row.partnerAvatarUrl,
    offerTitle: row.offerTitle,
    collaborationStatus: toCollaborationStatus(row.collaborationStatus),
    lastMessageContent: row.lastMessageContent,
    lastMessageAt: toIsoStringOrNull(row.lastMessageAt),
    unreadCount: Number(row.unreadCount ?? 0),
  };
}

function mapMessageRow(row: MarketplaceMessageRow): MarketplaceCollaborationMessage {
  return {
    contractVersion: MARKETPLACE_COLLABORATION_READS_CONTRACT_VERSION,
    messageId: row.messageId,
    collaborationId: row.collaborationId,
    senderUserId: row.senderUserId,
    senderName: row.senderName,
    senderAvatarUrl: row.senderAvatarUrl,
    senderSide: row.senderSide === "creator" || row.senderSide === "hotel" ? row.senderSide : null,
    content: row.content,
    contentType:
      row.contentType === "image" || row.contentType === "system" ? row.contentType : "text",
    metadata:
      row.metadata && typeof row.metadata === "object" && !Array.isArray(row.metadata)
        ? (row.metadata as Record<string, unknown>)
        : null,
    createdAt: toIsoString(row.createdAt),
  };
}

type ValidatedChatAttachment = {
  mediaObject: NonNullable<Awaited<ReturnType<PlatformMediaRepository["findMediaObject"]>>>;
  attachmentUrl: string;
};

async function requireChatAttachment(
  mediaObjectId: string | undefined,
  scope: ChatAttachmentScope,
  attachmentMedia: ChatAttachmentMedia | undefined,
  uploader?: { actorUserId: string; ownerOrganizationId: string },
): Promise<ValidatedChatAttachment> {
  if (!mediaObjectId || !attachmentMedia) {
    throw new MarketplaceCollaborationWriteError(
      attachmentMedia ? 400 : 501,
      attachmentMedia ? "invalid_query" : "write_unavailable",
      attachmentMedia
        ? "Image messages require mediaObjectId."
        : "Chat attachment media is not configured.",
    );
  }
  const mediaObject = await attachmentMedia.repository.findMediaObject(mediaObjectId);
  const variant = mediaObject?.variants.find(
    ({ variantName, visibility }) =>
      variantName === "provider_original" && visibility === "private",
  );
  const participantOrganizationIds = [scope.creatorOrganizationId, scope.hotelOrganizationId];
  const canonicalCollaborationResource =
    mediaObject?.resourceType === "collaboration" &&
    mediaObject.resourceId === scope.collaborationResourceId;
  const messageOwnerOrganizationId =
    scope.message?.senderSide === "creator"
      ? scope.creatorOrganizationId
      : scope.message?.senderSide === "hotel"
        ? scope.hotelOrganizationId
        : null;
  const canonicalUploadResource =
    uploader !== undefined &&
    mediaObject !== null &&
    canonicalCollaborationResource &&
    participantOrganizationIds.includes(mediaObject.ownerOrganizationId);
  const canonicalClaimedMessageResource =
    scope.message !== undefined &&
    mediaObject !== null &&
    canonicalCollaborationResource &&
    mediaObject.sourceMetadata?.attachmentState === "claimed" &&
    mediaObject.sourceMetadata.claimedByMessageId === scope.message.messageId &&
    mediaObject.ownerOrganizationId === messageOwnerOrganizationId;
  const migratedMessageResource =
    scope.message?.attachmentSource === "platform_media_migration" &&
    mediaObject?.sourceMetadata?.migrationCase === "media-url-migration" &&
    mediaObject.resourceType === "collaboration_chat_message" &&
    mediaObject.resourceId === scope.message.messageId &&
    mediaObject.ownerOrganizationId === messageOwnerOrganizationId;
  const retainedUntil = mediaObject?.retainedUntil ? Date.parse(mediaObject.retainedUntil) : null;
  const hasActiveRetention =
    retainedUntil !== null &&
    Number.isFinite(retainedUntil) &&
    retainedUntil > (attachmentMedia.now?.() ?? new Date()).getTime();
  if (
    !mediaObject ||
    !variant ||
    mediaObject.purpose !== "marketplace.collaboration_chat.attachment" ||
    mediaObject.visibility !== "private" ||
    mediaObject.lifecycleStatus !== "active" ||
    mediaObject.storageKind !== "vayada_managed" ||
    mediaObject.resourceProduct !== "marketplace" ||
    (!canonicalUploadResource && !canonicalClaimedMessageResource && !migratedMessageResource) ||
    !hasActiveRetention ||
    (uploader !== undefined &&
      (mediaObject.actorUserId !== uploader.actorUserId ||
        mediaObject.ownerOrganizationId !== uploader.ownerOrganizationId))
  ) {
    throw new MarketplaceCollaborationWriteError(
      400,
      "invalid_query",
      "Chat attachment does not belong to this collaboration.",
    );
  }
  const policy = createPrivateDownloadPolicy(attachmentMedia.serving, {
    bucketName: mediaObject.bucket,
    storageKey: variant.storageKey,
    visibility: mediaObject.visibility,
    status: "active",
    contentType: variant.contentType,
  });
  return {
    mediaObject,
    attachmentUrl: await attachmentMedia.signer.signPrivateDownload(policy),
  };
}

function setPrivateMessageResponseHeaders(reply: FastifyReply): void {
  reply.header("Cache-Control", "private, no-store");
  reply.header("Vary", "Authorization");
}

async function mapMessageRowWithAttachment(
  row: MarketplaceMessageRow,
  scope: ChatAttachmentScope,
  attachmentMedia: ChatAttachmentMedia | undefined,
  validated?: ValidatedChatAttachment | null,
): Promise<MarketplaceCollaborationMessage> {
  return mapMessageWithAttachment(mapMessageRow(row), scope, attachmentMedia, validated);
}

async function mapMessageWithAttachment(
  mapped: MarketplaceCollaborationMessage,
  scope: ChatAttachmentScope,
  attachmentMedia: ChatAttachmentMedia | undefined,
  validated?: ValidatedChatAttachment | null,
): Promise<MarketplaceCollaborationMessage> {
  const message = {
    ...mapped,
    metadata: safeChatMessageMetadata(mapped.metadata),
  };
  const mediaObjectId = readString(message.metadata?.mediaObjectId);
  if (message.contentType !== "image" || !mediaObjectId || !attachmentMedia) return message;

  let attachment = validated;
  try {
    attachment ??= await requireChatAttachment(mediaObjectId, scope, attachmentMedia);
  } catch {
    return message;
  }
  return {
    ...message,
    metadata: {
      ...message.metadata,
      attachmentUrl: attachment.attachmentUrl,
      attachmentValidated: true,
      fileName: attachment.mediaObject.originalFilename,
      fileSize: attachment.mediaObject.sizeBytes,
      contentType: attachment.mediaObject.contentType,
    },
  };
}

function stableMarketplaceMessageResponse(
  message: MarketplaceCollaborationMessage,
): MarketplaceCollaborationMessage {
  return {
    ...message,
    metadata: safeChatMessageMetadata(message.metadata),
  };
}

function messageAttachmentScope(
  collaboration: CollaborationMutationRow,
  message: MarketplaceCollaborationMessage,
): ChatAttachmentScope {
  return {
    collaborationResourceId: collaboration.id,
    creatorOrganizationId: collaboration.creatorOrganizationId,
    hotelOrganizationId: collaboration.hotelOrganizationId,
    message: {
      messageId: message.messageId,
      senderSide: message.senderSide,
      attachmentSource: readString(message.metadata?.attachmentSource),
    },
  };
}

function safeChatMessageMetadata(
  metadata: Record<string, unknown> | null,
): Record<string, unknown> | null {
  if (!metadata) return null;
  const mediaObjectId = readString(metadata.mediaObjectId);
  const attachmentSource = readString(metadata.attachmentSource);
  const safe: Record<string, unknown> = {};
  if (mediaObjectId?.match(/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i)) {
    safe.mediaObjectId = mediaObjectId;
  }
  if (attachmentSource === "platform_media_migration") {
    safe.attachmentSource = attachmentSource;
  }
  return Object.keys(safe).length > 0 ? safe : null;
}

function toMarketplaceConversationPage(input: {
  items: MarketplaceConversationSummary[];
  hasMore: boolean;
  nextCursor?: string | null;
}): MarketplaceConversationPage {
  return {
    contractVersion: MARKETPLACE_COLLABORATION_READS_CONTRACT_VERSION,
    items: input.items,
    nextCursor: input.nextCursor ?? null,
    hasMore: input.hasMore,
  };
}

function encodeConversationCursor(row: MarketplaceConversationRow): string {
  return encodeOpaqueCursor({
    sortAt: toIsoString(row.sortAt),
    collaborationId: row.collaborationId,
  });
}

function encodeMessageCursor(message: MarketplaceCollaborationMessage): string {
  return encodeOpaqueCursor({ createdAt: message.createdAt, messageId: message.messageId });
}

function encodeOpaqueCursor(value: Record<string, string>): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

function decodeOpaqueCursor(value: string): unknown {
  try {
    return JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
  } catch {
    return null;
  }
}

function parseConversationFilters(
  query: CollaborationConversationsQuery,
): ParseResult<MarketplaceConversationFilters> {
  const rawLimit = query.limit === undefined ? 100 : Number(query.limit);
  if (!Number.isInteger(rawLimit) || rawLimit < 1 || rawLimit > 100) {
    return invalidQuery("limit must be an integer from 1 to 100.");
  }
  const search = normalizeOptionalString(query.search);
  if (search && search.length > 200) return invalidQuery("search must be 200 characters or fewer.");
  let cursor: MarketplaceConversationFilters["cursor"];
  if (query.cursor) {
    const decoded = decodeOpaqueCursor(query.cursor);
    if (
      !isRecord(decoded) ||
      !isValidIsoTimestamp(decoded.sortAt) ||
      !readString(decoded.collaborationId)
    ) {
      return invalidQuery("cursor is not a valid conversation cursor.");
    }
    cursor = {
      sortAt: decoded.sortAt,
      collaborationId: String(decoded.collaborationId).trim(),
    };
  }
  return { ok: true, value: { limit: rawLimit, search, cursor } };
}

function parseOptionalMessageCursor(
  value: string | undefined,
): ParseResult<MarketplaceMessageCursor | undefined> {
  if (!value) return { ok: true, value: undefined };
  const decoded = decodeOpaqueCursor(value);
  if (!isRecord(decoded) || !isValidIsoTimestamp(decoded.createdAt) || !isUuid(decoded.messageId)) {
    return invalidQuery("cursor is not a valid message cursor.");
  }
  return {
    ok: true,
    value: { createdAt: decoded.createdAt, messageId: decoded.messageId },
  };
}

function parseOptionalTimestamp(
  value: string | undefined,
  field: string,
): ParseResult<string | undefined> {
  if (!value) return { ok: true, value: undefined };
  if (!isValidIsoTimestamp(value)) return invalidQuery(`${field} must be an ISO timestamp.`);
  return { ok: true, value };
}

function parseReadThroughCursor(value: unknown): ParseResult<MarketplaceMessageCursor> {
  if (!isRecord(value) || !isValidIsoTimestamp(value.createdAt) || !isUuid(value.messageId)) {
    return invalidQuery("readThrough requires a valid createdAt and messageId cursor.");
  }
  return { ok: true, value: { createdAt: value.createdAt, messageId: value.messageId } };
}

function isValidIsoTimestamp(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T/.test(value)) return false;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString() === value;
}

function isUuid(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
  );
}

function escapeLikePattern(value: string): string {
  return value.replace(/[\\%_]/g, "\\$&");
}

function toDeliverables(value: unknown): MarketplaceCollaborationRead["deliverables"] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.map((entry) => {
    const row = entry && typeof entry === "object" ? (entry as Record<string, unknown>) : {};
    return {
      deliverableId: String(row.deliverableId ?? ""),
      platform: String(row.platform ?? ""),
      type: String(row.type ?? ""),
      quantity: Number(row.quantity ?? 1),
      status: row.status === "completed" ? "completed" : "pending",
      completedAt: toIsoStringOrNull(row.completedAt as Date | string | null | undefined),
    };
  });
}

function toCreatorPlatforms(value: unknown): MarketplaceCollaborationRead["creator"]["platforms"] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    if (!isRecord(entry)) return [];
    const platform = readString(entry.platform);
    const handle = readString(entry.handle);
    if (!platform || !handle) return [];
    const verificationStatus =
      entry.verificationStatus === "verified" ||
      entry.verificationStatus === "rejected" ||
      entry.verificationStatus === "stale"
        ? entry.verificationStatus
        : "unverified";
    return [
      {
        platform,
        handle,
        profileUrl: readString(entry.profileUrl),
        followerCount: Math.max(0, Number(entry.followerCount ?? 0)),
        engagementRate: Math.max(0, Number(entry.engagementRate ?? 0)),
        audienceCountries: toAudiencePercentages(entry.audienceCountries, "country"),
        audienceAgeGroups: toAudiencePercentages(entry.audienceAgeGroups, "ageRange"),
        audienceGenderSplit: toAudienceGenderSplit(entry.audienceGenderSplit),
        verificationStatus,
      },
    ];
  });
}

function toAudiencePercentages<T extends "country" | "ageRange">(
  value: unknown,
  key: T,
): Array<Record<T, string> & { percentage: number }> {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    if (!isRecord(entry)) return [];
    const label = readString(entry[key]);
    const percentage = Number(entry.percentage);
    if (!label || !Number.isFinite(percentage)) return [];
    return [{ [key]: label, percentage } as Record<T, string> & { percentage: number }];
  });
}

function toAudienceGenderSplit(
  value: unknown,
): { male: number; female: number; other?: number } | null {
  if (!isRecord(value)) return null;
  const male = Number(value.male);
  const female = Number(value.female);
  const other = Number(value.other);
  if (!Number.isFinite(male) && !Number.isFinite(female) && !Number.isFinite(other)) return null;
  return {
    male: Number.isFinite(male) ? male : 0,
    female: Number.isFinite(female) ? female : 0,
    ...(Number.isFinite(other) ? { other } : {}),
  };
}

function toCollaborationStatus(value: string): CollaborationStatus {
  return isCollaborationStatus(value) ? value : "pending";
}

function toCollaborationSide(value: string): MarketplaceCollaborationAuthorizationSide {
  return value === "hotel" ? "hotel" : "creator";
}

function toCompensationType(
  value: string | null,
): MarketplaceCollaborationRead["compensationType"] {
  return value === "free_stay" || value === "paid" || value === "discount" || value === "custom"
    ? value
    : null;
}

function authorizationModeForSide(
  side: MarketplaceCollaborationAuthorizationSide,
): MarketplaceCollaborationAuthorizationMode {
  return side === "creator" ? "creator_workspace_resource_link" : "hotel_group_resource_link";
}

function toIsoString(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function toIsoStringOrNull(value: Date | string | null | undefined): string | null {
  return value ? toIsoString(value) : null;
}

function toDateString(value: Date | string | null): string | null {
  if (!value) {
    return null;
  }
  if (value instanceof Date) {
    return value.toISOString().slice(0, 10);
  }
  return value.slice(0, 10);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function readString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function readBoolean(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}

function readInteger(value: unknown): number | null {
  if (typeof value === "number" && Number.isInteger(value)) return value;
  if (typeof value === "string" && /^\d+$/.test(value)) return Number(value);
  return null;
}

function readDateString(value: unknown): string | null {
  const text = readString(value);
  if (!text || !/^\d{4}-\d{2}-\d{2}$/.test(text)) return null;
  const [year, month, day] = text.split("-").map(Number);
  const date = new Date(Date.UTC(year!, month! - 1, day!));
  return date.getUTCFullYear() === year &&
    date.getUTCMonth() === month! - 1 &&
    date.getUTCDate() === day
    ? text
    : null;
}

function readStringArray(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  return value.map(readString).filter((entry): entry is string => Boolean(entry));
}

function readCurrency(value: unknown): string | null {
  const text = readString(value);
  return text && /^[A-Za-z]{3}$/.test(text) ? text.toUpperCase() : null;
}

function readCompensationType(value: unknown): MarketplaceCollaborationRead["compensationType"] {
  return typeof value === "string" ? toCompensationType(value) : null;
}

function isActiveCollaborationUniqueViolation(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const databaseError = error as { code?: unknown; constraint?: unknown };
  return (
    databaseError.code === "23505" &&
    databaseError.constraint === "uq_marketplace_collaborations_active_offer_creator"
  );
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

function authorizeRequiredSideCollaborationRead(
  request: FastifyRequest,
  side: MarketplaceCollaborationAuthorizationSide,
): AuthorizationResult {
  const policy =
    side === "creator"
      ? MARKETPLACE_COLLABORATION_CREATOR_READ_POLICY
      : MARKETPLACE_COLLABORATION_HOTEL_READ_POLICY;
  const context = enforceRoutePolicy(request, { permission: policy.permission });
  const expectedKind = policy.selectedOrganizationKind;
  if (context.selectedOrganization.kind !== expectedKind) {
    return {
      ok: false,
      error: {
        statusCode: 403,
        code: "forbidden",
        message: `Selected organization must be ${expectedKind}.`,
      },
    };
  }
  const resourceCheck = checkRequiredResourceLinks(context, side);
  if (!resourceCheck.ok) {
    return resourceCheck;
  }
  return { ok: true, context, side };
}

function authorizeOptionalSideCollaborationRead(
  request: FastifyRequest,
  requestedSide: string | undefined,
): AuthorizationResult {
  const context = enforceRoutePolicy(request, {
    permission: MARKETPLACE_COLLABORATION_CREATOR_READ_POLICY.permission,
  });
  const side = normalizeOptionalString(requestedSide);
  if (side) {
    if (!isCollaborationSide(side)) {
      return {
        ok: false,
        error: {
          statusCode: 400,
          code: "invalid_query",
          message: `side must be one of: ${MARKETPLACE_COLLABORATION_AUTHORIZATION_SIDES.join(", ")}.`,
        },
      };
    }
    const expectedKind =
      side === "creator"
        ? MARKETPLACE_COLLABORATION_CREATOR_READ_POLICY.selectedOrganizationKind
        : MARKETPLACE_COLLABORATION_HOTEL_READ_POLICY.selectedOrganizationKind;
    if (context.selectedOrganization.kind !== expectedKind) {
      return {
        ok: false,
        error: {
          statusCode: 403,
          code: "forbidden",
          message: `Selected organization must be ${expectedKind}.`,
        },
      };
    }
    const resourceCheck = checkRequiredResourceLinks(context, side);
    if (!resourceCheck.ok) {
      return resourceCheck;
    }
    return { ok: true, context, side };
  }

  const inferredSide = inferSideFromOrganizationKind(context);
  if (!inferredSide) {
    return {
      ok: false,
      error: {
        statusCode: 403,
        code: "forbidden",
        message: "Selected organization is not a marketplace collaboration participant.",
      },
    };
  }
  const resourceCheck = checkRequiredResourceLinks(context, inferredSide);
  if (!resourceCheck.ok) {
    return resourceCheck;
  }
  return { ok: true, context, side: inferredSide };
}

function authorizeOptionalSideCollaborationWrite(
  request: FastifyRequest,
  requestedSide: unknown,
): AuthorizationResult {
  const context = enforceRoutePolicy(request, {
    permission: MARKETPLACE_COLLABORATION_CREATOR_WRITE_POLICY.permission,
  });
  const parsedSide =
    typeof requestedSide === "string" ? normalizeOptionalString(requestedSide) : undefined;
  if (parsedSide) {
    if (!isCollaborationSide(parsedSide)) {
      return {
        ok: false,
        error: {
          statusCode: 400,
          code: "invalid_query",
          message: `side must be one of: ${MARKETPLACE_COLLABORATION_AUTHORIZATION_SIDES.join(", ")}.`,
        },
      };
    }
    return authorizeResolvedWriteContext(context, parsedSide);
  }

  const inferredSide = inferSideFromOrganizationKind(context);
  if (!inferredSide) {
    return {
      ok: false,
      error: {
        statusCode: 403,
        code: "forbidden",
        message: "Selected organization is not a marketplace collaboration participant.",
      },
    };
  }
  return authorizeResolvedWriteContext(context, inferredSide);
}

function authorizeResolvedWriteContext(
  context: RequestContext,
  side: MarketplaceCollaborationAuthorizationSide,
): AuthorizationResult {
  const policy =
    side === "creator"
      ? MARKETPLACE_COLLABORATION_CREATOR_WRITE_POLICY
      : MARKETPLACE_COLLABORATION_HOTEL_WRITE_POLICY;
  if (context.selectedOrganization.kind !== policy.selectedOrganizationKind) {
    return {
      ok: false,
      error: {
        statusCode: 403,
        code: "forbidden",
        message: `Selected organization must be ${policy.selectedOrganizationKind}.`,
      },
    };
  }
  const resourceCheck = checkRequiredWriteResourceLinks(context, side);
  if (!resourceCheck.ok) return resourceCheck;
  return { ok: true, context, side };
}

function inferSideFromOrganizationKind(
  context: RequestContext,
): MarketplaceCollaborationAuthorizationSide | null {
  if (context.selectedOrganization.kind === "creator_workspace") {
    return "creator";
  }
  if (context.selectedOrganization.kind === "hotel_group") {
    return "hotel";
  }
  return null;
}

function checkRequiredResourceLinks(
  context: RequestContext,
  side: MarketplaceCollaborationAuthorizationSide,
): { ok: true } | { ok: false; error: MarketplaceCollaborationRouteError } {
  const policy =
    side === "creator"
      ? MARKETPLACE_COLLABORATION_CREATOR_READ_POLICY
      : MARKETPLACE_COLLABORATION_HOTEL_READ_POLICY;
  const missing = policy.requiredResources.find(
    (required) =>
      !context.linkedResources.some(
        (resource) =>
          resource.status === "active" &&
          resource.product === required.product &&
          resource.resourceType === required.resourceType &&
          resource.relationship === required.relationship,
      ),
  );
  if (!missing) {
    return { ok: true };
  }

  const code = side === "creator" ? "missing_creator_resource_link" : "missing_hotel_resource_link";
  return {
    ok: false,
    error: {
      statusCode: 403,
      code,
      message: `Missing active ${missing.resourceType} ${missing.relationship} link for marketplace collaboration reads.`,
    },
  };
}

function checkRequiredWriteResourceLinks(
  context: RequestContext,
  side: MarketplaceCollaborationAuthorizationSide,
): { ok: true } | { ok: false; error: MarketplaceCollaborationRouteError } {
  const policy =
    side === "creator"
      ? MARKETPLACE_COLLABORATION_CREATOR_WRITE_POLICY
      : MARKETPLACE_COLLABORATION_HOTEL_WRITE_POLICY;
  const missing = policy.requiredResources.find(
    (required) =>
      !context.linkedResources.some(
        (resource) =>
          resource.status === "active" &&
          resource.product === required.product &&
          resource.resourceType === required.resourceType &&
          resource.relationship === required.relationship,
      ),
  );
  if (missing) {
    const code =
      side === "creator" ? "missing_creator_resource_link" : "missing_hotel_resource_link";
    return {
      ok: false,
      error: {
        statusCode: 403,
        code,
        message: `Missing active ${missing.resourceType} ${missing.relationship} link for marketplace collaboration writes.`,
      },
    };
  }

  return { ok: true };
}

function parseRequiredSide(
  value: string | undefined,
): ParseResult<MarketplaceCollaborationAuthorizationSide> {
  const side = normalizeOptionalString(value);
  if (!side) {
    return invalidQuery("side is required.");
  }
  return parseOptionalSide(side, "side") as ParseResult<MarketplaceCollaborationAuthorizationSide>;
}

function parseOptionalSide(
  value: string | undefined,
  field: string,
): ParseResult<MarketplaceCollaborationAuthorizationSide | undefined> {
  const side = normalizeOptionalString(value);
  if (!side) {
    return { ok: true, value: undefined };
  }
  if (!isCollaborationSide(side)) {
    return invalidQuery(
      `${field} must be one of: ${MARKETPLACE_COLLABORATION_AUTHORIZATION_SIDES.join(", ")}.`,
    );
  }
  return { ok: true, value: side };
}

function parseOptionalStatus(
  value: string | undefined,
): ParseResult<CollaborationStatus | undefined> {
  const status = normalizeOptionalString(value);
  if (!status) {
    return { ok: true, value: undefined };
  }
  if (!isCollaborationStatus(status)) {
    return invalidQuery(`status must be one of: ${COLLABORATION_STATUSES.join(", ")}.`);
  }
  return { ok: true, value: status };
}

function parseLifecycleWriteBody(
  body: LifecycleWriteBody | undefined,
  action: MarketplaceCollaborationLifecycleWriteAction,
): ParseResult<{ idempotencyKey: string }> {
  const idempotencyKey = typeof body?.idempotencyKey === "string" ? body.idempotencyKey.trim() : "";
  if (!idempotencyKey) {
    return invalidQuery(`${action} requires idempotencyKey.`);
  }
  if (action === "create") {
    const side = typeof body?.side === "string" ? body.side : body?.initiatorSide;
    if (side === "creator") {
      if (body?.consent !== true) {
        return invalidQuery("Creator applications require explicit consent.");
      }
      if (!readString(body?.whyGreatFit)) {
        return invalidQuery("Creator applications require a non-empty pitch.");
      }
      const deliverables = readDeliverables(body ?? {});
      if (!deliverables?.length) {
        return invalidQuery("Creator applications require at least one valid deliverable.");
      }
    }
  }
  if (action === "edit_application" && !isValidIsoTimestamp(body?.expectedUpdatedAt)) {
    return invalidQuery("Editing requires expectedUpdatedAt.");
  }
  if (action === "create" || action === "update_terms" || action === "edit_application") {
    const terms = isRecord(body?.terms) ? body.terms : body;
    const travelDates = validateDateRange(
      terms?.travelDateFrom,
      terms?.travelDateTo,
      "travelDateFrom",
      "travelDateTo",
      false,
      true,
    );
    if (!travelDates.ok) return travelDates;
    const preferredDates = validateDateRange(
      terms?.preferredDateFrom,
      terms?.preferredDateTo,
      "preferredDateFrom",
      "preferredDateTo",
      true,
      true,
    );
    if (!preferredDates.ok) return preferredDates;
    if (body?.deliverables !== undefined) {
      if (!Array.isArray(body.deliverables)) {
        return invalidQuery("deliverables must be an array.");
      }
      const parsedDeliverables = readDeliverables(body);
      if (parsedDeliverables?.length !== body.deliverables.length) {
        return invalidQuery(
          "Each deliverable requires a non-empty platform and type and a positive integer quantity.",
        );
      }
    }
  }
  return { ok: true, value: { idempotencyKey } };
}

function parseCreatePayload(
  side: MarketplaceCollaborationAuthorizationSide,
  payload: Record<string, unknown>,
): ParseResult<{ whyGreatFit: string | null; consent: true | null }> {
  if (side === "hotel") {
    return { ok: true, value: { whyGreatFit: null, consent: null } };
  }
  const whyGreatFit = readString(payload.whyGreatFit);
  if (!whyGreatFit) {
    return invalidQuery("Creator applications require whyGreatFit.");
  }
  if (payload.consent !== true) {
    return invalidQuery("Creator applications require explicit consent.");
  }
  if (!readDeliverables(payload)?.length) {
    return invalidQuery("Creator applications require at least one valid deliverable.");
  }
  return { ok: true, value: { whyGreatFit, consent: true } };
}

function parseSendMessageBody(body: SendMessageBody | undefined): ParseResult<{
  content: string;
  contentType: "text" | "image";
  mediaObjectId?: string;
  idempotencyKey: string;
}> {
  const rawContentType = body?.contentType ?? body?.message_type ?? "text";
  const contentType =
    rawContentType === "image" ? "image" : rawContentType === "text" ? "text" : null;
  if (!contentType) return invalidQuery("message content type must be text or image.");
  const content = typeof body?.content === "string" ? body.content.trim() : "";
  if (contentType === "text" && !content) return invalidQuery("message content is required.");
  const mediaObjectId = readString(body?.mediaObjectId) ?? undefined;
  if (contentType === "image" && !mediaObjectId) {
    return invalidQuery("image messages require mediaObjectId.");
  }
  const idempotencyKey = readString(body?.idempotencyKey);
  if (!idempotencyKey) return invalidQuery("message idempotencyKey is required.");
  if (idempotencyKey.length > 255) {
    return invalidQuery("message idempotencyKey must be 255 characters or fewer.");
  }
  return {
    ok: true,
    value: {
      content: contentType === "image" ? content || "Sent an image" : content,
      contentType,
      mediaObjectId,
      idempotencyKey,
    },
  };
}

function validateDateRange(
  rawFrom: unknown,
  rawTo: unknown,
  fromField: string,
  toField: string,
  allowSameDay: boolean,
  deferOrdering = false,
): ParseResult<undefined> {
  const hasFrom = rawFrom !== undefined && rawFrom !== null && rawFrom !== "";
  const hasTo = rawTo !== undefined && rawTo !== null && rawTo !== "";
  if (!hasFrom && !hasTo) return { ok: true, value: undefined };
  if (!hasFrom || !hasTo)
    return invalidQuery(`${fromField} and ${toField} must be provided together.`);
  const from = readDateString(rawFrom);
  const to = readDateString(rawTo);
  if (!from) return invalidQuery(`${fromField} must be a real ISO date in YYYY-MM-DD format.`);
  if (!to) return invalidQuery(`${toField} must be a real ISO date in YYYY-MM-DD format.`);
  // Property-local past-date errors take precedence over ordering errors.
  if (!deferOrdering && (allowSameDay ? to < from : to <= from)) {
    return invalidQuery(
      allowSameDay
        ? `${toField} must be on or after ${fromField}.`
        : `${toField} must be after ${fromField}.`,
    );
  }
  return { ok: true, value: undefined };
}

function normalizeOptionalString(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized ? normalized : undefined;
}

function isCollaborationSide(value: string): value is MarketplaceCollaborationAuthorizationSide {
  return (MARKETPLACE_COLLABORATION_AUTHORIZATION_SIDES as readonly string[]).includes(value);
}

function isCollaborationStatus(value: string): value is CollaborationStatus {
  return (COLLABORATION_STATUSES as readonly string[]).includes(value);
}

function sendMarketplaceCollaborationError(
  reply: FastifyReply,
  error: MarketplaceCollaborationRouteError,
): FastifyReply {
  return reply.status(error.statusCode).send({
    code: error.code,
    category:
      error.statusCode === 404
        ? "not_found"
        : error.statusCode === 409
          ? "conflict"
          : error.statusCode === 400
            ? "validation"
            : error.statusCode === 501
              ? "write_model"
              : "auth",
    message: error.message,
  });
}

function notFound(): MarketplaceCollaborationRouteError {
  return {
    statusCode: 404,
    code: "collaboration_not_found",
    message: "Collaboration was not found for the selected marketplace side.",
  };
}

function writeUnavailable(): MarketplaceCollaborationRouteError {
  return {
    statusCode: 501,
    code: "write_unavailable",
    message: "Marketplace collaboration write repository is not configured.",
  };
}

function invalidQuery<T = never>(message: string): ParseResult<T> {
  return {
    ok: false,
    error: {
      statusCode: 400,
      code: "invalid_query",
      message,
    },
  };
}

type ParseResult<T> =
  | {
      ok: true;
      value: T;
    }
  | {
      ok: false;
      error: MarketplaceCollaborationRouteError;
    };

type AuthorizationResult =
  | {
      ok: true;
      context: RequestContext;
      side: MarketplaceCollaborationAuthorizationSide;
    }
  | {
      ok: false;
      error: MarketplaceCollaborationRouteError;
    };

type MarketplaceCollaborationRouteError = {
  statusCode: 400 | 403 | 404 | 409 | 501;
  code:
    | "invalid_query"
    | "forbidden"
    | "ambiguous_marketplace_creator_profile"
    | "missing_creator_resource_link"
    | "missing_hotel_resource_link"
    | "collaboration_not_found"
    | "invalid_transition"
    | "idempotency_conflict"
    | "write_unavailable";
  message: string;
};

class MarketplaceCollaborationWriteError extends Error {
  constructor(
    readonly statusCode: MarketplaceCollaborationRouteError["statusCode"],
    readonly code: MarketplaceCollaborationRouteError["code"],
    message: string,
  ) {
    super(message);
  }
}

function ambiguousCreatorResourceLink(): MarketplaceCollaborationWriteError {
  return new MarketplaceCollaborationWriteError(
    409,
    "ambiguous_marketplace_creator_profile",
    "Selected organization has multiple active marketplace creator profile links",
  );
}

export function toMarketplaceCollaborationListResponse(input: {
  authorizationMode: MarketplaceCollaborationAuthorizationMode;
  items: MarketplaceCollaborationRead[];
}): MarketplaceCollaborationListResponse {
  return {
    contractVersion: MARKETPLACE_COLLABORATION_READS_CONTRACT_VERSION,
    authorizationMode: input.authorizationMode,
    items: input.items,
  };
}

export function toMarketplaceCollaborationMessagesResponse(input: {
  collaborationId: string;
  authorizationMode: MarketplaceCollaborationAuthorizationMode;
  items: MarketplaceCollaborationMessage[];
  nextCursor?: string | null;
  hasMore?: boolean;
}): MarketplaceCollaborationMessagesResponse {
  return {
    contractVersion: MARKETPLACE_COLLABORATION_READS_CONTRACT_VERSION,
    collaborationId: input.collaborationId,
    authorizationMode: input.authorizationMode,
    items: input.items,
    nextCursor: input.nextCursor,
    hasMore: input.hasMore,
  };
}
