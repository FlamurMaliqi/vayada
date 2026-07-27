import type { RequestContext } from "@vayada/backend-auth";
import { requireAuthContext } from "@vayada/backend-auth";
import { hasPermission } from "@vayada/backend-authorization";
import {
  isSetupTaskLaunchable,
  parseCreateHotelSetupHandoffRequest,
  parseExchangeHotelSetupHandoffRequest,
  SETUP_TASK_DESTINATION_ROUTE_KEYS,
  type CreateHotelSetupHandoffResponse,
  type ExchangeHotelSetupHandoffResponse,
  type SetupTask,
  type SetupTaskId,
} from "@vayada/domain-hotels";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

import type { HotelSetupTrackCommandRepository } from "../domains/hotelSetupTrackCommandRepository.js";
import type {
  HotelSetupHandoffAccessSnapshot,
  HotelSetupHandoffBinding,
  HotelSetupHandoffRepository,
} from "../domains/hotelSetupHandoffRepository.js";
import {
  buildPropertySetupPlan,
  type SharedHotelSetupStatusRepository,
} from "./sharedHotelSetupStatus.js";

export type HotelSetupHandoffDestinationOrigins = {
  marketplace: string;
  bookingAdmin: string;
  pms: string;
};

export type HotelSetupHandoffRoutesOptions = {
  repository: HotelSetupHandoffRepository;
  setupStatusRepository: Pick<SharedHotelSetupStatusRepository, "getHotelSetupStatus">;
  trackCommandRepository: Pick<HotelSetupTrackCommandRepository, "getTrackStatus">;
  destinationOrigins: HotelSetupHandoffDestinationOrigins;
  hotelSetupBaseUrl: string;
};

type DestinationRouteKey =
  (typeof SETUP_TASK_DESTINATION_ROUTE_KEYS)[keyof typeof SETUP_TASK_DESTINATION_ROUTE_KEYS];

const HANDOFF_DESTINATION_BY_ROUTE_KEY = {
  "hotel_catalog.shared_identity": "marketplace",
  "hotel_catalog.public_profile": "marketplace",
  "marketplace.creator_offer": "marketplace",
  "pms.rooms_rates_availability": "pms",
  "booking.guest_settings_policies": "bookingAdmin",
  "finance.payment": "bookingAdmin",
  "distribution.direct_booking_publication": "bookingAdmin",
} as const satisfies Record<DestinationRouteKey, keyof HotelSetupHandoffDestinationOrigins>;

export async function registerHotelSetupHandoffRoutes(
  app: FastifyInstance,
  options: HotelSetupHandoffRoutesOptions,
): Promise<void> {
  const destinationOrigins = {
    marketplace: canonicalOrigin(options.destinationOrigins.marketplace, "marketplace"),
    bookingAdmin: canonicalOrigin(options.destinationOrigins.bookingAdmin, "bookingAdmin"),
    pms: canonicalOrigin(options.destinationOrigins.pms, "pms"),
  };
  const hotelSetupBaseUrl = canonicalHotelSetupBaseUrl(options.hotelSetupBaseUrl);

  app.addHook("onClose", async () => {
    await options.repository.close();
  });

  app.post("/handoffs", async (request, reply) => {
    const input = parseCreateHotelSetupHandoffRequest(request.body);
    if (!input) return invalidHandoff(reply, 422);

    const access = requestAccess(request, reply, false);
    if (!access || !hasCatalogPropertyLink(access.context, input.propertyId)) {
      return access ? invalidHandoff(reply, 422) : reply;
    }

    const current = await resolveCurrentTask({
      context: access.context,
      propertyId: input.propertyId,
      taskId: input.taskId,
      setupStatusRepository: options.setupStatusRepository,
      trackCommandRepository: options.trackCommandRepository,
    });
    if (current?.planRevision !== input.planRevision) {
      return current ? refreshPlan(reply) : invalidHandoff(reply, 422);
    }
    if (!current.launchable || !current.task) return invalidHandoff(reply, 422);
    const destination = destinationForRouteKey(current.task.destinationRouteKey);
    if (!destination) return invalidHandoff(reply, 422);

    const issued = await options.repository.issue({
      binding: access.binding,
      propertyId: input.propertyId,
      taskId: input.taskId,
      issuedPlanRevision: input.planRevision,
      destinationRouteKey: current.task.destinationRouteKey,
      returnUrl: setupReturnUrl(hotelSetupBaseUrl, input.propertyId),
    });
    const launchUrl = handoffLaunchUrl(destinationOrigins[destination], issued.code);
    return reply.status(201).send({
      launchUrl,
      expiresAt: issued.expiresAt,
    } satisfies CreateHotelSetupHandoffResponse);
  });

  app.post("/handoffs/exchange", async (request, reply) => {
    const input = parseExchangeHotelSetupHandoffRequest(request.body);
    if (!input) return invalidHandoff(reply, 422);

    const access = requestAccess(request, reply, true);
    if (!access) return reply;

    const handoff = await options.repository.findActive(input.code);
    const canonicalReturnUrl = handoff
      ? setupReturnUrl(hotelSetupBaseUrl, handoff.propertyId)
      : null;
    if (
      !handoff ||
      !sameBinding(handoff, access.binding) ||
      !hasCatalogPropertyLink(access.context, handoff.propertyId) ||
      handoff.returnUrl !== canonicalReturnUrl
    ) {
      return invalidHandoff(reply, 409);
    }

    const current = await resolveCurrentTask({
      context: access.context,
      propertyId: handoff.propertyId,
      taskId: handoff.taskId,
      setupStatusRepository: options.setupStatusRepository,
      trackCommandRepository: options.trackCommandRepository,
    });
    if (current?.planRevision !== handoff.issuedPlanRevision) {
      return current ? refreshPlan(reply) : invalidHandoff(reply, 409);
    }
    if (!current.launchable || current.task?.destinationRouteKey !== handoff.destinationRouteKey) {
      return invalidHandoff(reply, 409);
    }

    const consumed = await options.repository.consume({
      id: handoff.id,
      code: input.code,
      binding: access.binding,
    });
    if (!consumed) return invalidHandoff(reply, 409);

    const currentContext = withCurrentAccess(access.context, consumed.access);
    const currentReturnUrl = setupReturnUrl(hotelSetupBaseUrl, consumed.propertyId);
    if (
      !sameBinding(consumed, access.binding) ||
      !hasCurrentHandoffAccess(currentContext, consumed.propertyId) ||
      consumed.returnUrl !== currentReturnUrl
    ) {
      return invalidHandoff(reply, 409);
    }

    const revalidated = await resolveCurrentTask({
      context: currentContext,
      propertyId: consumed.propertyId,
      taskId: consumed.taskId,
      setupStatusRepository: options.setupStatusRepository,
      trackCommandRepository: options.trackCommandRepository,
    });
    if (revalidated?.planRevision !== consumed.issuedPlanRevision) {
      return revalidated ? refreshPlan(reply) : invalidHandoff(reply, 409);
    }
    if (
      !revalidated.launchable ||
      revalidated.task?.destinationRouteKey !== consumed.destinationRouteKey
    ) {
      return invalidHandoff(reply, 409);
    }

    return {
      propertyId: consumed.propertyId,
      taskId: consumed.taskId,
      issuedPlanRevision: consumed.issuedPlanRevision,
      destinationRouteKey: consumed.destinationRouteKey,
      returnUrl: consumed.returnUrl,
    } satisfies ExchangeHotelSetupHandoffResponse;
  });
}

function requestAccess(
  request: FastifyRequest,
  reply: FastifyReply,
  hideUnauthorized: boolean,
): { context: RequestContext; binding: HotelSetupHandoffBinding } | null {
  try {
    const context = requireAuthContext(request);
    const providerSessionId = context.actor.providerIdentity.sessionId;
    if (!providerSessionId || !hasBaseHandoffAccess(context)) {
      invalidHandoff(reply, hideUnauthorized ? 409 : 422);
      return null;
    }
    return {
      context,
      binding: {
        internalUserId: context.actor.internalUserId,
        providerSessionId,
        organizationId: context.selectedOrganization.organizationId,
        membershipId: context.membership.membershipId,
      },
    };
  } catch (error) {
    if (hideUnauthorized) {
      invalidHandoff(reply, 409);
      return null;
    }
    throw error;
  }
}

function withCurrentAccess(
  context: RequestContext,
  access: HotelSetupHandoffAccessSnapshot,
): RequestContext {
  return {
    ...context,
    membership: {
      ...context.membership,
      permissions: access.permissions,
    },
    linkedResources: access.linkedResources,
    entitlements: access.entitlements,
  };
}

function hasBaseHandoffAccess(context: RequestContext): boolean {
  return (
    context.actor.status === "active" &&
    context.selectedOrganization.kind === "hotel_group" &&
    context.selectedOrganization.status === "active" &&
    context.membership.status === "active" &&
    hasPermission(context, "hotel_catalog.setup.read")
  );
}

function hasCurrentHandoffAccess(context: RequestContext, propertyId: string): boolean {
  return hasBaseHandoffAccess(context) && hasCatalogPropertyLink(context, propertyId);
}

async function resolveCurrentTask(input: {
  context: RequestContext;
  propertyId: string;
  taskId: SetupTaskId;
  setupStatusRepository: Pick<SharedHotelSetupStatusRepository, "getHotelSetupStatus">;
  trackCommandRepository: Pick<HotelSetupTrackCommandRepository, "getTrackStatus">;
}): Promise<{
  task: SetupTask | null;
  planRevision: string;
  launchable: boolean;
} | null> {
  const [status, trackStatus] = await Promise.all([
    input.setupStatusRepository.getHotelSetupStatus({
      organizationId: input.context.selectedOrganization.organizationId,
      propertyIds: [input.propertyId],
    }),
    input.trackCommandRepository.getTrackStatus({
      organizationId: input.context.selectedOrganization.organizationId,
    }),
  ]);
  const property = status.properties.find(({ propertyId }) => propertyId === input.propertyId);
  if (!property) return null;

  const plan = buildPropertySetupPlan({
    context: input.context,
    property,
    selectedTracks: trackStatus.selectedTracks,
    trackRevision: trackStatus.trackRevision,
    tracks: trackStatus.tracks,
    evaluatedAt: new Date().toISOString(),
  });
  const task = plan.tasks.find(({ taskId }) => taskId === input.taskId) ?? null;

  return {
    task,
    planRevision: plan.planRevision,
    launchable: isSetupTaskLaunchable(task),
  };
}

function hasCatalogPropertyLink(context: RequestContext, propertyId: string): boolean {
  return context.linkedResources.some(
    (resource) =>
      resource.status === "active" &&
      resource.product === "hotel_catalog" &&
      resource.resourceType === "property" &&
      resource.resourceId === propertyId &&
      (resource.relationship === "owner" || resource.relationship === "operator"),
  );
}

function sameBinding(stored: HotelSetupHandoffBinding, current: HotelSetupHandoffBinding): boolean {
  return (
    stored.internalUserId === current.internalUserId &&
    stored.providerSessionId === current.providerSessionId &&
    stored.organizationId === current.organizationId &&
    stored.membershipId === current.membershipId
  );
}

function destinationForRouteKey(
  routeKey: string,
): keyof HotelSetupHandoffDestinationOrigins | null {
  return Object.hasOwn(HANDOFF_DESTINATION_BY_ROUTE_KEY, routeKey)
    ? HANDOFF_DESTINATION_BY_ROUTE_KEY[routeKey as DestinationRouteKey]
    : null;
}

function handoffLaunchUrl(origin: string, code: string): string {
  const url = new URL("/handoff", origin);
  url.searchParams.set("code", code);
  return url.toString();
}

function setupReturnUrl(baseUrl: string, propertyId: string): string {
  const url = new URL(baseUrl);
  url.search = "";
  url.searchParams.set("propertyId", propertyId);
  return url.toString();
}

function canonicalOrigin(value: string, field: string): string {
  const url = safeWebUrl(value);
  if (!url || url.pathname !== "/" || url.search || url.hash || url.username || url.password) {
    throw new Error(`Hotel setup handoff ${field} destination must be an HTTPS origin`);
  }
  return url.origin;
}

function canonicalHotelSetupBaseUrl(value: string): string {
  const url = safeWebUrl(value);
  if (!url || url.pathname !== "/setup" || url.search || url.hash || url.username || url.password) {
    throw new Error("HOTEL_SETUP_BASE_URL must be an HTTPS URL ending in /setup");
  }
  return url.toString();
}

function safeWebUrl(value: string): URL | null {
  try {
    const url = new URL(value);
    if (
      url.protocol === "https:" ||
      (url.protocol === "http:" &&
        (url.hostname === "localhost" || url.hostname.endsWith(".localhost")))
    ) {
      return url;
    }
    return null;
  } catch {
    return null;
  }
}

function invalidHandoff(reply: FastifyReply, status: 409 | 422): FastifyReply {
  return reply.status(status).send({ code: "invalid_handoff" });
}

function refreshPlan(reply: FastifyReply): FastifyReply {
  return reply.status(409).send({ code: "refresh_plan" });
}
