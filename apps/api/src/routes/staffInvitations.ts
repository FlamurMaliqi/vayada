import { randomUUID } from "node:crypto";
import {
  UnauthorizedError,
  validateStaffInviteAccess,
  type CreateStaffInviteCommand,
  createPgStaffInvitationRepository,
  createStaffInvitationDeliveryCoordinator,
} from "@vayada/backend-auth";
import { AuthorizationError } from "@vayada/backend-authorization";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

import { enforceRoutePolicy } from "./policy.js";

type StaffInvitationRepository = Pick<
  ReturnType<typeof createPgStaffInvitationRepository>,
  "persist"
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

const allowedBodyKeys = new Set([
  "email",
  "name",
  "roleKey",
  "propertyIds",
  "permissionOverrides",
  "configurationRevision",
]);

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

  app.post<{ Body: unknown }>("/invitations", { onRequest: authorize }, async (request, reply) => {
    const context = authorized.get(request);
    if (!context) throw new Error("Staff invitation authorization was not resolved");
    const idempotencyKey = readIdempotencyKey(request);
    const body = parseRequest(request.body);
    if (!idempotencyKey || !body) return reply.status(400).send({ code: "invalid_request" });

    const command: CreateStaffInviteCommand = {
      commandType: "identity.invite.staff.create",
      commandId: randomUUID(),
      idempotencyKey,
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
  if (!plainRecord(value) || Object.keys(value).some((key) => !allowedBodyKeys.has(key)))
    return null;
  const email = typeof value["email"] === "string" ? value["email"].trim().toLowerCase() : "";
  const name = typeof value["name"] === "string" ? value["name"].trim() : undefined;
  const propertyIds = value["propertyIds"];
  const overrides = value["permissionOverrides"];
  if (
    email.length > 320 ||
    !/^[^\s@]+@[^\s@]+$/.test(email) ||
    (value["name"] !== undefined && (!name || name.length > 200)) ||
    !stringArray(propertyIds) ||
    !plainRecord(overrides) ||
    !stringArray(overrides["grant"]) ||
    !stringArray(overrides["deny"]) ||
    Object.keys(overrides).some((key) => key !== "grant" && key !== "deny") ||
    !Number.isSafeInteger(value["configurationRevision"]) ||
    (value["configurationRevision"] as number) < 1 ||
    (value["configurationRevision"] as number) > 2_147_483_647
  ) {
    return null;
  }
  const access = {
    roleKey: value["roleKey"] as string,
    propertyAccessMode: "assigned",
    propertyIds,
    permissionOverrides: { grant: overrides["grant"], deny: overrides["deny"] },
  };
  if (typeof value["roleKey"] !== "string" || validateStaffInviteAccess(access).length) return null;
  return {
    email,
    ...(name ? { name } : {}),
    roleKey: value["roleKey"] as StaffInvitationRequest["roleKey"],
    propertyIds,
    permissionOverrides:
      access.permissionOverrides as StaffInvitationRequest["permissionOverrides"],
    configurationRevision: value["configurationRevision"] as number,
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
