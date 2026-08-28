import { randomUUID } from "node:crypto";
import {
  UnauthorizedError,
  validateStaffInviteAccess,
  type CreateStaffInviteCommand,
  type UpdateStaffAccessCommand,
  type UpdateStaffStatusCommand,
  createPgStaffInvitationRepository,
  createStaffInvitationDeliveryCoordinator,
} from "@vayada/backend-auth";
import { AuthorizationError } from "@vayada/backend-authorization";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

import { enforceRoutePolicy } from "./policy.js";

type StaffInvitationRepository = Pick<
  ReturnType<typeof createPgStaffInvitationRepository>,
  "listRoster" | "persist" | "updateAccess" | "updateStatus"
>;
type StaffInvitationDelivery = Pick<
  ReturnType<typeof createStaffInvitationDeliveryCoordinator>,
  "deliver"
>;

export type StaffInvitationRoutesOptions = {
  repository: StaffInvitationRepository;
  delivery: StaffInvitationDelivery;
};

type StaffInvitationRequest = Omit<
  CreateStaffInviteCommand["payload"],
  "organizationId" | "propertyAccessMode"
>;
type StaffAccessRequest = Omit<
  UpdateStaffAccessCommand["payload"],
  "organizationId" | "membershipId" | "propertyAccessMode"
>;

const invitationBodyKeys = new Set([
  "email",
  "name",
  "roleKey",
  "propertyIds",
  "permissionOverrides",
  "configurationRevision",
]);
const accessBodyKeys = new Set(["roleKey", "propertyIds", "permissionOverrides"]);

export async function registerStaffInvitationRoutes(
  app: FastifyInstance,
  options: StaffInvitationRoutesOptions,
): Promise<void> {
  const authorized = new WeakMap<FastifyRequest, ReturnType<typeof enforceRoutePolicy>>();
  const authorize = async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const context = enforceRoutePolicy(request, { permission: "identity.staff.manage" });
      if (
        context.actor.status !== "active" ||
        context.selectedOrganization.kind !== "hotel_group" ||
        context.selectedOrganization.status !== "active" ||
        context.membership.status !== "active"
      ) {
        throw new AuthorizationError();
      }
      authorized.set(request, context);
    } catch (error) {
      if (error instanceof UnauthorizedError) {
        return reply.status(401).send({ code: "unauthenticated" });
      }
      if (error instanceof AuthorizationError) {
        return reply.status(403).send({ code: "forbidden" });
      }
      throw error;
    }
  };

  app.get("/members", { onRequest: authorize }, async (request, reply) => {
    const context = authorized.get(request);
    if (!context) throw new Error("Staff roster authorization was not resolved");
    try {
      const members = await options.repository.listRoster(
        context.selectedOrganization.organizationId,
      );
      return reply.send({ members });
    } catch {
      return reply.status(500).send({ code: "staff_roster_failed" });
    }
  });

  app.patch<{ Params: { membershipId: string }; Body: unknown }>(
    "/members/:membershipId",
    { onRequest: authorize },
    async (request, reply) => {
      const context = authorized.get(request);
      if (!context) throw new Error("Staff access authorization was not resolved");
      const idempotencyKey = readIdempotencyKey(request);
      const body = parseStaffAccessRequest(request.body);
      if (!idempotencyKey || !body) return reply.status(400).send({ code: "invalid_request" });
      const command: UpdateStaffAccessCommand = {
        commandType: "identity.staff.access.update",
        commandId: randomUUID(),
        idempotencyKey: `hotel:${context.selectedOrganization.organizationId}:${idempotencyKey}`,
        audit: {
          actor: {
            kind: "user",
            userId: context.actor.internalUserId,
            organizationId: context.selectedOrganization.organizationId,
          },
          source: context.audit.source,
          requestId: context.audit.requestId,
          ...(context.audit.correlationId ? { correlationId: context.audit.correlationId } : {}),
          reason: "Update hotel staff access",
          requestedAt: context.audit.receivedAt,
        },
        payload: {
          organizationId: context.selectedOrganization.organizationId,
          membershipId: request.params.membershipId,
          propertyAccessMode: "assigned",
          ...body,
        },
      };
      try {
        const result = await options.repository.updateAccess(command);
        if (result.outcome === "rejected") return sendAccessUpdateRejection(reply, result.reason);
        return reply.send(result);
      } catch {
        return reply.status(500).send({ code: "staff_access_update_failed" });
      }
    },
  );

  app.patch<{ Params: { membershipId: string }; Body: unknown }>(
    "/members/:membershipId/status",
    { onRequest: authorize },
    async (request, reply) => {
      const context = authorized.get(request);
      if (!context) throw new Error("Staff status authorization was not resolved");
      const idempotencyKey = readIdempotencyKey(request);
      const status = parseStaffStatusRequest(request.body);
      if (!idempotencyKey || !status) return reply.status(400).send({ code: "invalid_request" });
      const command: UpdateStaffStatusCommand = {
        commandType: "identity.staff.status.update",
        commandId: randomUUID(),
        idempotencyKey: `hotel:${context.selectedOrganization.organizationId}:${idempotencyKey}`,
        audit: {
          actor: {
            kind: "user",
            userId: context.actor.internalUserId,
            organizationId: context.selectedOrganization.organizationId,
          },
          source: context.audit.source,
          requestId: context.audit.requestId,
          ...(context.audit.correlationId ? { correlationId: context.audit.correlationId } : {}),
          reason:
            status === "deactivated"
              ? "Deactivate hotel staff member"
              : "Reactivate hotel staff member",
          requestedAt: context.audit.receivedAt,
        },
        payload: {
          organizationId: context.selectedOrganization.organizationId,
          membershipId: request.params.membershipId,
          membershipStatus: status === "deactivated" ? "suspended" : "active",
        },
      };
      try {
        const result = await options.repository.updateStatus(command);
        if (result.outcome === "rejected") return sendAccessUpdateRejection(reply, result.reason);
        return reply.send({
          outcome: result.outcome,
          membershipId: result.membershipId,
          status: result.membershipStatus === "suspended" ? "deactivated" : "active",
        });
      } catch {
        return reply.status(500).send({ code: "staff_status_update_failed" });
      }
    },
  );

  app.post<{ Body: unknown }>("/invitations", { onRequest: authorize }, async (request, reply) => {
    const context = authorized.get(request);
    if (!context) throw new Error("Staff invitation authorization was not resolved");
    const idempotencyKey = readIdempotencyKey(request);
    const body = parseRequest(request.body);
    if (!idempotencyKey || !body) return reply.status(400).send({ code: "invalid_request" });

    const command: CreateStaffInviteCommand = {
      commandType: "identity.invite.staff.create",
      commandId: randomUUID(),
      idempotencyKey: `hotel:${context.selectedOrganization.organizationId}:${idempotencyKey}`,
      audit: {
        actor: {
          kind: "user",
          userId: context.actor.internalUserId,
          organizationId: context.selectedOrganization.organizationId,
        },
        source: context.audit.source,
        requestId: context.audit.requestId,
        ...(context.audit.correlationId ? { correlationId: context.audit.correlationId } : {}),
        reason: "Invite hotel staff member",
        requestedAt: context.audit.receivedAt,
      },
      payload: {
        organizationId: context.selectedOrganization.organizationId,
        ...body,
        propertyAccessMode: "assigned",
      },
    };

    let result;
    try {
      result = await options.repository.persist(command);
    } catch {
      return reply.status(500).send({ code: "staff_invitation_failed" });
    }
    if (result.outcome === "rejected") return sendRejection(reply, result.reason);

    let delivery;
    try {
      delivery = await options.delivery.deliver(result.invitationId);
    } catch {
      return reply.status(500).send({ code: "staff_invitation_delivery_failed" });
    }
    return reply.status(result.outcome === "created" ? 201 : 200).send({
      outcome: result.outcome,
      invitationId: result.invitationId,
      delivery: delivery.outcome,
    });
  });
}

function parseRequest(value: unknown): StaffInvitationRequest | null {
  if (!plainRecord(value) || Object.keys(value).some((key) => !invitationBodyKeys.has(key)))
    return null;
  const email = typeof value["email"] === "string" ? value["email"].trim().toLowerCase() : "";
  const name = typeof value["name"] === "string" ? value["name"].trim() : undefined;
  const access = parseStaffAccess(value);
  if (
    email.length > 320 ||
    !/^[^\s@]+@[^\s@]+$/.test(email) ||
    (value["name"] !== undefined && (!name || name.length > 200)) ||
    !access ||
    !Number.isSafeInteger(value["configurationRevision"]) ||
    (value["configurationRevision"] as number) < 1 ||
    (value["configurationRevision"] as number) > 2_147_483_647
  ) {
    return null;
  }
  return {
    email,
    ...(name ? { name } : {}),
    ...access,
    configurationRevision: value["configurationRevision"] as number,
  };
}

function parseStaffAccessRequest(value: unknown): StaffAccessRequest | null {
  if (!plainRecord(value) || Object.keys(value).some((key) => !accessBodyKeys.has(key)))
    return null;
  return parseStaffAccess(value);
}

function parseStaffStatusRequest(value: unknown): "active" | "deactivated" | null {
  if (!plainRecord(value) || Object.keys(value).length !== 1) return null;
  return value["status"] === "active" || value["status"] === "deactivated" ? value["status"] : null;
}

function parseStaffAccess(value: Record<string, unknown>): StaffAccessRequest | null {
  const propertyIds = value["propertyIds"];
  const overrides = value["permissionOverrides"];
  if (
    typeof value["roleKey"] !== "string" ||
    !stringArray(propertyIds) ||
    !plainRecord(overrides) ||
    !stringArray(overrides["grant"]) ||
    !stringArray(overrides["deny"]) ||
    Object.keys(overrides).some((key) => key !== "grant" && key !== "deny")
  ) {
    return null;
  }
  const access = {
    roleKey: value["roleKey"],
    propertyAccessMode: "assigned",
    propertyIds,
    permissionOverrides: { grant: overrides["grant"], deny: overrides["deny"] },
  };
  if (validateStaffInviteAccess(access).length) return null;
  return {
    roleKey: access.roleKey as StaffAccessRequest["roleKey"],
    propertyIds,
    permissionOverrides: access.permissionOverrides as StaffAccessRequest["permissionOverrides"],
  };
}

function readIdempotencyKey(request: FastifyRequest): string | null {
  const occurrences = request.raw.rawHeaders.filter(
    (value, index) => index % 2 === 0 && value.toLowerCase() === "idempotency-key",
  ).length;
  const header = request.headers["idempotency-key"];
  if (occurrences !== 1 || typeof header !== "string") return null;
  const key = header.trim();
  return key.length >= 1 && key.length <= 200 ? key : null;
}

function stringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function plainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function sendRejection(reply: FastifyReply, reason: string) {
  if (reason === "inviter_not_authorized") {
    return reply.status(403).send({ code: "forbidden" });
  }
  if (reason === "property_scope_invalid") {
    return reply.status(404).send({ code: "staff_access_scope_not_found" });
  }
  if (reason === "idempotency_conflict" || reason === "configuration_conflict") {
    return reply.status(409).send({ code: "staff_invitation_conflict" });
  }
  return reply.status(400).send({ code: "invalid_request" });
}

function sendAccessUpdateRejection(reply: FastifyReply, reason: string) {
  if (reason === "inviter_not_authorized") return reply.status(403).send({ code: "forbidden" });
  if (reason === "target_not_found") {
    return reply.status(404).send({ code: "staff_member_not_found" });
  }
  if (reason === "property_scope_invalid") {
    return reply.status(404).send({ code: "staff_access_scope_not_found" });
  }
  if (reason === "idempotency_conflict") {
    return reply.status(409).send({ code: "staff_access_conflict" });
  }
  return reply.status(400).send({ code: "invalid_request" });
}
