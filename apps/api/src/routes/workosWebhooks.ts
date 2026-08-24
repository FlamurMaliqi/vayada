import { createHash, randomUUID } from "node:crypto";
import type {
  StaffInvitationAcceptanceEvent,
  StaffInvitationAcceptanceResult,
} from "@vayada/backend-auth";
import type { FastifyInstance, FastifyPluginAsync, FastifyRequest } from "fastify";

export type WorkosWebhookEvent = {
  id: string;
  event: string;
  createdAt?: string;
  data?: Record<string, unknown>;
};

export type WorkosWebhookVerifier = {
  verify(input: { payload: string; signature: string }): Promise<WorkosWebhookEvent>;
};

export type StaffInvitationAcceptanceReconciler = {
  reconcile(input: StaffInvitationAcceptanceEvent): Promise<StaffInvitationAcceptanceResult>;
};

export type DeferredStaffInvitationAcceptance = {
  receiptId: string;
  event: StaffInvitationAcceptanceEvent;
};

export const staffInvitationIdentityNotFoundReasonCode = "staff_invitation_identity_not_found";

export type WorkosWebhookStore = {
  insertReceipt(input: WorkosWebhookReceiptInput): Promise<WorkosWebhookReceiptResult>;
  markReceiptProcessed(input: {
    receiptId: string;
    status: "normalized" | "ignored";
    organizationId?: string;
    userId?: string;
  }): Promise<void>;
  isReceiptProcessed(receiptId: string): Promise<boolean>;
  deadLetterReceipt(input: {
    receiptId: string;
    reasonCode: string;
    failureSummary: string;
    failurePayload: Record<string, unknown>;
  }): Promise<void>;
  listDeferredStaffInvitationAcceptances(
    providerUserId: string,
  ): Promise<DeferredStaffInvitationAcceptance[]>;
  resolveDeferredStaffInvitationAcceptance(receiptId: string): Promise<void>;
  findUserIdByWorkosUserId(workosUserId: string): Promise<string | null>;
  findOrganizationIdByWorkosOrgId(workosOrgId: string): Promise<string | null>;
  upsertWorkosUser(input: WorkosUserPayload): Promise<string>;
  upsertWorkosOrganization(input: WorkosOrganizationPayload): Promise<string>;
  deactivateWorkosUser(workosUserId: string): Promise<{ userId?: string }>;
  archiveWorkosOrganization(workosOrgId: string): Promise<{ organizationId?: string }>;
  deactivateDirectoryUser(input: {
    workosOrgId: string;
    email: string;
  }): Promise<{ userId?: string; organizationId?: string }>;
  deactivateOrganizationDirectoryMemberships(
    workosOrgId: string,
  ): Promise<{ organizationId?: string }>;
  upsertWorkosMembership(input: WorkosMembershipPayload): Promise<{
    userId: string;
    organizationId: string;
  }>;
  deactivateWorkosMembership(workosMembershipId: string): Promise<{
    userId?: string;
    organizationId?: string;
  }>;
};

export type WorkosWebhookReceiptInput = {
  providerEventId: string;
  eventType: string;
  payloadHash: string;
  signatureVerified: boolean;
  rawHeaders: Record<string, string>;
  rawPayload: Record<string, unknown>;
  webhookKeyHash: string;
};

export type WorkosWebhookReceiptResult =
  | {
      status: "inserted";
      receiptId: string;
    }
  | {
      status: "duplicate";
      receiptId: string;
      deliveryStatus: string;
    };

export type WorkosUserPayload = {
  workosUserId: string;
  email: string;
  name?: string;
  emailVerified: boolean;
  status: "active" | "suspended" | "deleted";
  rawProfile: Record<string, unknown>;
};

export type WorkosOrganizationPayload = {
  workosOrgId: string;
  externalId?: string;
  name: string;
  slug: string;
  status: "active" | "suspended" | "archived";
  kind: "platform" | "hotel_group" | "creator_workspace" | "affiliate_partner";
};

export type WorkosMembershipPayload = {
  workosMembershipId: string;
  workosUserId: string;
  workosOrgId: string;
  roleKey: string;
  workosRoleSlugs: string[];
  status: "active" | "pending" | "inactive" | "suspended";
};

export type WorkosWebhookRoutesOptions = {
  secret: string;
  verifier: WorkosWebhookVerifier;
  store: WorkosWebhookStore;
  staffInvitationAcceptance?: StaffInvitationAcceptanceReconciler;
  processInline?: boolean;
  scheduleProcessing?: (task: () => Promise<void>) => void;
};

export const registerWorkosWebhookRoutes: FastifyPluginAsync<WorkosWebhookRoutesOptions> = async (
  app: FastifyInstance,
  options: WorkosWebhookRoutesOptions,
) => {
  app.removeContentTypeParser("application/json");
  app.addContentTypeParser("application/json", { parseAs: "string" }, (_request, body, done) => {
    done(null, typeof body === "string" ? body : body.toString());
  });

  app.post<{ Body: string }>("/webhook", async (request, reply) => {
    const signature = request.headers["workos-signature"];
    if (typeof signature !== "string" || !signature.trim()) {
      return reply.code(400).send({ error: "missing_workos_signature" });
    }

    let event: WorkosWebhookEvent;
    try {
      event = await options.verifier.verify({
        payload: request.body,
        signature,
      });
    } catch {
      return reply.code(400).send({ error: "invalid_workos_signature" });
    }

    let rawPayload: Record<string, unknown>;
    try {
      rawPayload = parseRawPayload(request.body);
    } catch {
      return reply.code(400).send({ error: "invalid_workos_payload" });
    }

    const reconciliationInput = {
      event,
      rawPayload,
      rawHeaders: redactedHeaders(request),
      signature,
      store: options.store,
      staffInvitationAcceptance: options.staffInvitationAcceptance,
    };

    if (options.processInline !== false) {
      const result = await reconcileWorkosWebhookEvent(reconciliationInput);
      return reply.code(200).send(result);
    }

    const receipt = await recordWorkosWebhookReceipt(reconciliationInput);
    if (
      receipt.status === "duplicate" &&
      (await options.store.isReceiptProcessed(receipt.receiptId))
    ) {
      return reply.code(200).send({ status: "duplicate", receiptId: receipt.receiptId });
    }

    scheduleWebhookProcessing(options, async () => {
      await processWorkosWebhookReceipt({
        event,
        receiptId: receipt.receiptId,
        store: options.store,
        staffInvitationAcceptance: options.staffInvitationAcceptance,
      });
    });

    return reply.code(200).send({ status: "accepted", receiptId: receipt.receiptId });
  });
};

export async function reconcileWorkosWebhookEvent(input: {
  event: WorkosWebhookEvent;
  rawPayload: Record<string, unknown>;
  rawHeaders: Record<string, string>;
  signature: string;
  store: WorkosWebhookStore;
  staffInvitationAcceptance?: StaffInvitationAcceptanceReconciler;
}): Promise<{ status: "accepted" | "duplicate" | "ignored" | "dead_lettered"; receiptId: string }> {
  const receipt = await recordWorkosWebhookReceipt(input);

  if (receipt.status === "duplicate" && (await input.store.isReceiptProcessed(receipt.receiptId))) {
    return { status: "duplicate", receiptId: receipt.receiptId };
  }

  return processWorkosWebhookReceipt({
    event: input.event,
    receiptId: receipt.receiptId,
    store: input.store,
    staffInvitationAcceptance: input.staffInvitationAcceptance,
  });
}

async function recordWorkosWebhookReceipt(input: {
  event: WorkosWebhookEvent;
  rawPayload: Record<string, unknown>;
  rawHeaders: Record<string, string>;
  signature: string;
  store: WorkosWebhookStore;
}): Promise<WorkosWebhookReceiptResult> {
  return input.store.insertReceipt({
    providerEventId: input.event.id,
    eventType: input.event.event,
    payloadHash: sha256(JSON.stringify(input.rawPayload)),
    signatureVerified: true,
    rawHeaders: input.rawHeaders,
    rawPayload: input.rawPayload,
    webhookKeyHash: sha256(`${input.event.id}:${input.signature}`),
  });
}

async function processWorkosWebhookReceipt(input: {
  event: WorkosWebhookEvent;
  receiptId: string;
  store: WorkosWebhookStore;
  staffInvitationAcceptance?: StaffInvitationAcceptanceReconciler;
}): Promise<{ status: "accepted" | "ignored" | "dead_lettered"; receiptId: string }> {
  try {
    const outcome = await applyWorkosIdentityEvent(
      input.event,
      input.store,
      input.staffInvitationAcceptance,
    );
    if (outcome.status === "deferred") {
      const deferred = { receiptId: input.receiptId, event: outcome.event };
      await input.store.deadLetterReceipt({
        receiptId: input.receiptId,
        reasonCode: staffInvitationIdentityNotFoundReasonCode,
        failureSummary: "Staff invitation acceptance deferred: identity_not_found",
        failurePayload: {
          staffInvitationAcceptance: outcome.event,
        },
      });
      if (
        input.staffInvitationAcceptance &&
        (await reconcileDeferredStaffInvitationAcceptance(
          deferred,
          input.store,
          input.staffInvitationAcceptance,
        ))
      ) {
        return { status: "accepted", receiptId: input.receiptId };
      }
      return { status: "dead_lettered", receiptId: input.receiptId };
    }
    await input.store.markReceiptProcessed({
      receiptId: input.receiptId,
      status: outcome.status,
      organizationId: outcome.organizationId,
      userId: outcome.userId,
    });
    return {
      status: outcome.status === "ignored" ? "ignored" : "accepted",
      receiptId: input.receiptId,
    };
  } catch (error) {
    await input.store.deadLetterReceipt({
      receiptId: input.receiptId,
      reasonCode: "identity_reconciliation_failed",
      failureSummary:
        error instanceof Error ? error.message : "WorkOS identity reconciliation failed.",
      failurePayload: {
        eventId: input.event.id,
        eventType: input.event.event,
      },
    });
    return { status: "dead_lettered", receiptId: input.receiptId };
  }
}

function scheduleWebhookProcessing(
  options: WorkosWebhookRoutesOptions,
  task: () => Promise<void>,
): void {
  const schedule =
    options.scheduleProcessing ??
    ((scheduledTask: () => Promise<void>) => {
      setImmediate(() => {
        void scheduledTask();
      });
    });
  schedule(async () => {
    try {
      await task();
    } catch {
      // Receipt and job rows are already durable; the persisted job is the recovery path.
    }
  });
}

async function applyWorkosIdentityEvent(
  event: WorkosWebhookEvent,
  store: WorkosWebhookStore,
  staffInvitationAcceptance?: StaffInvitationAcceptanceReconciler,
): Promise<
  | {
      status: "normalized" | "ignored";
      userId?: string;
      organizationId?: string;
    }
  | {
      status: "deferred";
      event: StaffInvitationAcceptanceEvent;
    }
> {
  switch (event.event) {
    case "invitation.accepted": {
      if (!staffInvitationAcceptance) {
        throw new Error("Staff invitation acceptance reconciliation is not configured");
      }
      const acceptanceEvent = toStaffInvitationAcceptanceEvent(event);
      const result = await staffInvitationAcceptance.reconcile(acceptanceEvent);
      if (result.outcome === "deferred") {
        return { status: "deferred", event: acceptanceEvent };
      }
      return { status: "normalized" };
    }
    case "user.created":
    case "user.updated": {
      const user = toWorkosUserPayload(event);
      const userId = await store.upsertWorkosUser(user);
      if (user.emailVerified && staffInvitationAcceptance) {
        await replayDeferredStaffInvitationAcceptances(
          user.workosUserId,
          store,
          staffInvitationAcceptance,
        ).catch(() => {
          // Deferred evidence remains open for a later retry.
        });
      }
      return { status: "normalized", userId };
    }
    case "user.deleted": {
      const result = await store.deactivateWorkosUser(requiredString(event.data, "id"));
      return { status: "normalized", ...result };
    }
    case "organization.created":
    case "organization.updated": {
      const organizationId = await store.upsertWorkosOrganization(
        toWorkosOrganizationPayload(event),
      );
      return { status: "normalized", organizationId };
    }
    case "organization.deleted": {
      const result = await store.archiveWorkosOrganization(requiredString(event.data, "id"));
      return { status: "normalized", ...result };
    }
    case "organization_membership.created":
    case "organization_membership.updated": {
      const result = await store.upsertWorkosMembership(toWorkosMembershipPayload(event));
      return { status: "normalized", ...result };
    }
    case "organization_membership.deleted": {
      const membershipId = requiredString(event.data, "id");
      const result = await store.deactivateWorkosMembership(membershipId);
      return { status: "normalized", ...result };
    }
    case "dsync.user.created":
    case "dsync.user.updated":
    case "dsync.activated":
      return { status: "ignored" };
    case "dsync.user.deleted": {
      const result = await store.deactivateDirectoryUser({
        workosOrgId: requiredString(event.data, "organization_id"),
        email: requiredString(event.data, "email"),
      });
      return { status: "normalized", ...result };
    }
    case "dsync.deleted": {
      const result = await store.deactivateOrganizationDirectoryMemberships(
        requiredString(event.data, "organization_id"),
      );
      return { status: "normalized", ...result };
    }
    default:
      return { status: "ignored" };
  }
}

async function replayDeferredStaffInvitationAcceptances(
  providerUserId: string,
  store: WorkosWebhookStore,
  reconciler: StaffInvitationAcceptanceReconciler,
): Promise<void> {
  for (const deferred of await store.listDeferredStaffInvitationAcceptances(providerUserId)) {
    await reconcileDeferredStaffInvitationAcceptance(deferred, store, reconciler);
  }
}

async function reconcileDeferredStaffInvitationAcceptance(
  deferred: DeferredStaffInvitationAcceptance,
  store: WorkosWebhookStore,
  reconciler: StaffInvitationAcceptanceReconciler,
): Promise<boolean> {
  const result = await reconciler.reconcile(deferred.event);
  if (result.outcome === "deferred") {
    return false;
  }
  await store.resolveDeferredStaffInvitationAcceptance(deferred.receiptId);
  return true;
}

function toStaffInvitationAcceptanceEvent(
  event: WorkosWebhookEvent,
): StaffInvitationAcceptanceEvent {
  if (requiredString(event.data, "state") !== "accepted") {
    throw new Error("WorkOS invitation.accepted event has a non-accepted state");
  }
  return {
    providerEventId: event.id,
    providerInvitationId: requiredString(event.data, "id"),
    providerUserId:
      optionalString(event.data, "acceptedUserId") ??
      requiredString(event.data, "accepted_user_id"),
    providerOrganizationId:
      optionalString(event.data, "organizationId") ?? requiredString(event.data, "organization_id"),
    invitationEmail: requiredString(event.data, "email"),
  };
}

function toWorkosUserPayload(event: WorkosWebhookEvent): WorkosUserPayload {
  const firstName =
    optionalString(event.data, "firstName") ?? optionalString(event.data, "first_name");
  const lastName =
    optionalString(event.data, "lastName") ?? optionalString(event.data, "last_name");
  const structuredName = [firstName, lastName].filter(Boolean).join(" ");
  return {
    workosUserId: requiredString(event.data, "id"),
    email: requiredString(event.data, "email"),
    name: structuredName || optionalString(event.data, "name"),
    emailVerified:
      optionalBoolean(event.data, "emailVerified") ??
      optionalBoolean(event.data, "email_verified") ??
      false,
    status: "active",
    rawProfile: event.data ?? {},
  };
}

function toWorkosOrganizationPayload(event: WorkosWebhookEvent): WorkosOrganizationPayload {
  const externalId = optionalString(event.data, "external_id");
  return {
    workosOrgId: requiredString(event.data, "id"),
    externalId,
    name: optionalString(event.data, "name") ?? "WorkOS organization",
    slug:
      optionalString(event.data, "slug") ??
      slugify(optionalString(event.data, "name") ?? externalId ?? randomUUID()),
    status: "active",
    kind: toOrganizationKind(optionalString(event.data, "organization_kind")),
  };
}

function toWorkosMembershipPayload(event: WorkosWebhookEvent): WorkosMembershipPayload {
  const status = optionalString(event.data, "status");
  const roleSlugs = membershipRoleSlugs(event.data);
  const role = roleSlugs[0] ?? "member";
  return {
    workosMembershipId: requiredString(event.data, "id"),
    workosUserId:
      optionalString(event.data, "userId") ??
      optionalNestedString(event.data, ["user", "id"]) ??
      requiredString(event.data, "user_id"),
    workosOrgId:
      optionalString(event.data, "organizationId") ??
      optionalNestedString(event.data, ["organization", "id"]) ??
      requiredString(event.data, "organization_id"),
    roleKey: role,
    workosRoleSlugs: roleSlugs,
    status: toMembershipStatus(status),
  };
}

function requiredString(data: Record<string, unknown> | undefined, key: string): string {
  const value = optionalString(data, key);
  if (!value) {
    throw new Error(`WorkOS event is missing ${key}`);
  }
  return value;
}

function optionalNestedString(
  data: Record<string, unknown> | undefined,
  path: readonly string[],
): string | null {
  let current: unknown = data;
  for (const segment of path) {
    if (!current || typeof current !== "object" || Array.isArray(current)) return null;
    current = (current as Record<string, unknown>)[segment];
  }
  return typeof current === "string" && current.trim() ? current : null;
}

function optionalString(
  data: Record<string, unknown> | undefined,
  key: string,
): string | undefined {
  const value = data?.[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function optionalBoolean(
  data: Record<string, unknown> | undefined,
  key: string,
): boolean | undefined {
  const value = data?.[key];
  return typeof value === "boolean" ? value : undefined;
}

function membershipRoleSlugs(data: Record<string, unknown> | undefined): string[] {
  const flatRole = optionalString(data, "role_slug") ?? optionalString(data, "role");
  const nestedRole = optionalNestedString(data, ["role", "slug"]);
  const roles = data?.["roles"];
  const roleSlugs = Array.isArray(roles)
    ? roles
        .map((role) =>
          role && typeof role === "object" && !Array.isArray(role)
            ? optionalString(role as Record<string, unknown>, "slug")
            : undefined,
        )
        .filter((role): role is string => Boolean(role))
    : [];
  return Array.from(new Set([nestedRole, flatRole, ...roleSlugs].filter(Boolean) as string[]));
}

function toOrganizationKind(value: string | undefined): WorkosOrganizationPayload["kind"] {
  return value === "platform" ||
    value === "hotel_group" ||
    value === "creator_workspace" ||
    value === "affiliate_partner"
    ? value
    : "hotel_group";
}

function toMembershipStatus(value: string | undefined): WorkosMembershipPayload["status"] {
  switch (value) {
    case "pending":
      return "pending";
    case "inactive":
    case "revoked":
      return "inactive";
    case "suspended":
      return "suspended";
    default:
      return "active";
  }
}

function parseRawPayload(payload: string): Record<string, unknown> {
  const parsed = JSON.parse(payload) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("WorkOS webhook payload must be a JSON object");
  }
  return parsed as Record<string, unknown>;
}

function redactedHeaders(request: FastifyRequest): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const [key, value] of Object.entries(request.headers)) {
    if (key.toLowerCase() === "workos-signature") {
      headers[key] = "redacted";
    } else if (typeof value === "string") {
      headers[key] = value;
    }
  }
  return headers;
}

function sha256(value: string): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}
