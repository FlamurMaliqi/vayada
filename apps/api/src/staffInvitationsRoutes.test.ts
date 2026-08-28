import { request as httpRequest } from "node:http";

import type {
  CreateStaffInviteCommand,
  PermissionKey,
  RemoveStaffCommand,
  RequestContext,
  UpdateStaffAccessCommand,
  UpdateStaffStatusCommand,
} from "@vayada/backend-auth";
import { injectJson } from "@vayada/backend-test";
import Fastify from "fastify";
import { afterEach, describe, expect, it } from "vitest";

import {
  registerStaffInvitationRoutes,
  type StaffInvitationRoutesOptions,
} from "./routes/staffInvitations.js";

const organizationId = "11111111-1111-4111-8111-111111111111";
const propertyId = "22222222-2222-4222-8222-222222222222";
const foreignPropertyId = "33333333-3333-4333-8333-333333333333";
const invitationId = "44444444-4444-4444-8444-444444444444";
const staffMembershipId = "55555555-5555-4555-8555-555555555555";
type PersistResult = Awaited<ReturnType<StaffInvitationRoutesOptions["repository"]["persist"]>>;
type UpdateResult = Awaited<ReturnType<StaffInvitationRoutesOptions["repository"]["updateAccess"]>>;
type StatusResult = Awaited<ReturnType<StaffInvitationRoutesOptions["repository"]["updateStatus"]>>;
type RemoveResult = Awaited<ReturnType<StaffInvitationRoutesOptions["repository"]["remove"]>>;
type RevocationResult = Awaited<ReturnType<StaffInvitationRoutesOptions["removal"]["revoke"]>>;
type Auth = {
  authenticated?: boolean;
  actorStatus?: RequestContext["actor"]["status"];
  organizationKind?: RequestContext["selectedOrganization"]["kind"];
  organizationStatus?: RequestContext["selectedOrganization"]["status"];
  membershipStatus?: RequestContext["membership"]["status"];
  permissions?: PermissionKey[];
};

function fakes() {
  const commands: CreateStaffInviteCommand[] = [];
  const accessCommands: UpdateStaffAccessCommand[] = [];
  const statusCommands: UpdateStaffStatusCommand[] = [];
  const removalCommands: RemoveStaffCommand[] = [];
  const revocationJobs: string[] = [];
  const deliveries: string[] = [];
  const rosterOrganizations: string[] = [];
  let result: PersistResult = { outcome: "created", invitationId };
  let updateResult: UpdateResult = { outcome: "updated", membershipId: staffMembershipId };
  let statusResult: StatusResult = {
    outcome: "updated",
    membershipId: staffMembershipId,
    membershipStatus: "suspended",
  };
  let removeResult: RemoveResult = {
    outcome: "removed",
    membershipId: staffMembershipId,
    providerRevocationJobId: "66666666-6666-4666-8666-666666666666",
  };
  let revocationResult: RevocationResult = {
    outcome: "revoked",
    jobId: "66666666-6666-4666-8666-666666666666",
  };
  return {
    commands,
    accessCommands,
    statusCommands,
    removalCommands,
    revocationJobs,
    deliveries,
    rosterOrganizations,
    setResult(value: PersistResult) {
      result = value;
    },
    setUpdateResult(value: UpdateResult) {
      updateResult = value;
    },
    setStatusResult(value: StatusResult) {
      statusResult = value;
    },
    setRemoveResult(value: RemoveResult) {
      removeResult = value;
    },
    setRevocationResult(value: RevocationResult) {
      revocationResult = value;
    },
    options: {
      repository: {
        async listRoster(id) {
          rosterOrganizations.push(id);
          return [
            {
              id: staffMembershipId,
              name: "Staff Example",
              email: "staff@example.test",
              roleKey: "front_desk" as const,
              propertyIds: [propertyId],
              status: "active" as const,
              lastActiveAt: "2026-08-24T00:00:00.000Z",
            },
          ];
        },
        async persist(command) {
          commands.push(command);
          return result;
        },
        async updateAccess(command) {
          accessCommands.push(command);
          return updateResult;
        },
        async updateStatus(command) {
          statusCommands.push(command);
          return statusResult;
        },
        async remove(command) {
          removalCommands.push(command);
          return removeResult;
        },
      },
      delivery: {
        async deliver(id) {
          deliveries.push(id);
          return {
            outcome: "delivered" as const,
            invitationId: id,
            providerInvitationId: "provider-invitation",
          };
        },
      },
      removal: {
        async revoke(jobId) {
          revocationJobs.push(jobId);
          return revocationResult;
        },
      },
    } satisfies StaffInvitationRoutesOptions,
  };
}

async function testApp(options: StaffInvitationRoutesOptions, auth: Auth = {}) {
  const app = Fastify({ logger: false });
  app.decorateRequest("authContext", null);
  app.addHook("onRequest", async (request) => {
    if (auth.authenticated === false || request.headers.authorization !== "Bearer valid-token") {
      return;
    }
    request.authContext = {
      actor: {
        internalUserId: "user-owner",
        providerIdentity: { provider: "workos", providerUserId: "user-workos" },
        email: "owner@example.test",
        status: auth.actorStatus ?? "active",
      },
      selectedOrganization: {
        organizationId,
        kind: auth.organizationKind ?? "hotel_group",
        status: auth.organizationStatus ?? "active",
      },
      membership: {
        membershipId: "membership-owner",
        status: auth.membershipStatus ?? "active",
        roleKey: "hotel_owner",
        workosRoleSlugs: ["hotel_owner"],
        permissions: auth.permissions ?? ["identity.staff.manage"],
      },
      linkedResources: [],
      entitlements: [],
      locale: "en",
      currency: "EUR",
      audit: {
        requestId: "request-1",
        correlationId: "correlation-1",
        source: "api",
        receivedAt: "2026-08-24T00:00:00.000Z",
      },
    };
  });
  await app.register(registerStaffInvitationRoutes, {
    prefix: "/api/identity/staff",
    ...options,
  });
  return app;
}

describe("staff invitation routes", () => {
  let app: Awaited<ReturnType<typeof testApp>> | undefined;
  afterEach(async () => app?.close());

  it("creates and delivers an assigned invitation from authenticated context", async () => {
    const fake = fakes();
    app = await testApp(fake.options);
    const response = await post(app);
    expect(response).toMatchObject({
      statusCode: 201,
      body: { outcome: "created", invitationId, delivery: "delivered" },
    });
    expect(fake.commands[0]).toMatchObject({
      commandType: "identity.invite.staff.create",
      idempotencyKey: `hotel:${organizationId}:invite-key`,
      audit: { actor: { userId: "user-owner", organizationId }, source: "api" },
      payload: { organizationId, propertyAccessMode: "assigned", propertyIds: [propertyId] },
    });
    expect(fake.deliveries).toEqual([invitationId]);
    expect(JSON.stringify(response.body)).not.toMatch(/provider|token|accept/i);
  });

  it("lists only the authenticated organization's roster", async () => {
    const fake = fakes();
    app = await testApp(fake.options);
    const response = await get(app);
    expect(response).toMatchObject({
      statusCode: 200,
      body: {
        members: [
          {
            id: staffMembershipId,
            email: "staff@example.test",
            status: "active",
            propertyIds: [propertyId],
          },
        ],
      },
    });
    expect(fake.rosterOrganizations).toEqual([organizationId]);
    expect(JSON.stringify(response.body)).not.toMatch(/workos|provider|token/i);
  });

  it("updates assigned staff access from authenticated context", async () => {
    const fake = fakes();
    app = await testApp(fake.options);
    expect(await patchAccess(app)).toMatchObject({
      statusCode: 200,
      body: { outcome: "updated", membershipId: staffMembershipId },
    });
    expect(fake.accessCommands[0]).toMatchObject({
      commandType: "identity.staff.access.update",
      idempotencyKey: `hotel:${organizationId}:access-key`,
      audit: { actor: { userId: "user-owner", organizationId }, source: "api" },
      payload: {
        organizationId,
        membershipId: staffMembershipId,
        propertyAccessMode: "assigned",
        propertyIds: [propertyId],
      },
    });
  });

  it("deactivates and reactivates staff from authenticated context", async () => {
    const fake = fakes();
    app = await testApp(fake.options);
    expect(await patchStatus(app)).toMatchObject({
      statusCode: 200,
      body: { outcome: "updated", membershipId: staffMembershipId, status: "deactivated" },
    });
    expect(fake.statusCommands[0]).toMatchObject({
      commandType: "identity.staff.status.update",
      idempotencyKey: `hotel:${organizationId}:status-key`,
      audit: { actor: { userId: "user-owner", organizationId }, source: "api" },
      payload: {
        organizationId,
        membershipId: staffMembershipId,
        membershipStatus: "suspended",
      },
    });
    fake.setStatusResult({
      outcome: "updated",
      membershipId: staffMembershipId,
      membershipStatus: "active",
    });
    expect(await patchStatus(app, { status: "active" }, "reactivate-key")).toMatchObject({
      statusCode: 200,
      body: { status: "active" },
    });
    expect(fake.statusCommands[1]?.payload.membershipStatus).toBe("active");
  });

  it("removes tenant staff and revokes only its provider membership", async () => {
    const fake = fakes();
    app = await testApp(fake.options);
    const response = await remove(app);
    expect(response).toMatchObject({
      statusCode: 200,
      body: { membershipId: staffMembershipId, status: "removed", providerStatus: "revoked" },
    });
    expect(fake.removalCommands[0]).toMatchObject({
      commandType: "identity.staff.remove",
      idempotencyKey: `hotel:${organizationId}:remove-key`,
      audit: { actor: { userId: "user-owner", organizationId }, source: "api" },
      payload: { organizationId, membershipId: staffMembershipId },
    });
    expect(fake.revocationJobs).toEqual(["66666666-6666-4666-8666-666666666666"]);
    expect(JSON.stringify(response.body)).not.toMatch(/workos|jobId|userId|organizationId/i);
  });

  it.each([
    ["unauthenticated", { authenticated: false }, 401],
    ["wrong organization", { organizationKind: "creator_workspace" }, 403],
    ["inactive actor", { actorStatus: "suspended" }, 403],
    ["inactive organization", { organizationStatus: "suspended" }, 403],
    ["inactive membership", { membershipStatus: "inactive" }, 403],
    ["missing permission", { permissions: [] }, 403],
  ] as const)("denies %s before persistence", async (_name, auth, statusCode) => {
    const fake = fakes();
    app = await testApp(fake.options, auth as Auth);
    expect((await post(app, { unsafe: true })).statusCode).toBe(statusCode);
    expect((await get(app)).statusCode).toBe(statusCode);
    expect((await patchAccess(app, { unsafe: true })).statusCode).toBe(statusCode);
    expect((await patchStatus(app, { unsafe: true })).statusCode).toBe(statusCode);
    expect((await remove(app)).statusCode).toBe(statusCode);
    expect(fake.commands).toHaveLength(0);
    expect(fake.accessCommands).toHaveLength(0);
    expect(fake.statusCommands).toHaveLength(0);
    expect(fake.removalCommands).toHaveLength(0);
    expect(fake.revocationJobs).toHaveLength(0);
    expect(fake.rosterOrganizations).toHaveLength(0);
  });

  it("fails closed for malformed access and cross-tenant properties", async () => {
    const fake = fakes();
    app = await testApp(fake.options);
    expect(
      (await post(app, { ...body(), permissionOverrides: { grant: ["unknown"] } })).statusCode,
    ).toBe(400);
    expect((await post(app, { ...body(), configurationRevision: 2_147_483_648 })).statusCode).toBe(
      400,
    );
    expect((await post(app, body(), null)).statusCode).toBe(400);
    fake.setResult({ outcome: "rejected", reason: "property_scope_invalid" });
    const foreign = await post(app, { ...body(), propertyIds: [foreignPropertyId] });
    expect(foreign).toMatchObject({
      statusCode: 404,
      body: { code: "staff_access_scope_not_found" },
    });
    expect(fake.deliveries).toHaveLength(0);
  });

  it.each([
    ["inviter_not_authorized", 403],
    ["idempotency_conflict", 409],
  ] as const)("maps %s without delivery", async (reason, statusCode) => {
    const fake = fakes();
    fake.setResult({ outcome: "rejected", reason });
    app = await testApp(fake.options);
    expect((await post(app)).statusCode).toBe(statusCode);
    expect(fake.deliveries).toHaveLength(0);
  });

  it("rejects malformed and cross-tenant staff access updates", async () => {
    const fake = fakes();
    app = await testApp(fake.options);
    expect((await patchAccess(app, { ...accessBody(), roleKey: "hotel_owner" })).statusCode).toBe(
      400,
    );
    expect((await patchAccess(app, accessBody(), null)).statusCode).toBe(400);
    fake.setUpdateResult({ outcome: "rejected", reason: "target_not_found" });
    expect((await patchAccess(app)).statusCode).toBe(404);
    fake.setUpdateResult({ outcome: "rejected", reason: "property_scope_invalid" });
    expect((await patchAccess(app)).statusCode).toBe(404);
    fake.setUpdateResult({ outcome: "rejected", reason: "idempotency_conflict" });
    expect((await patchAccess(app)).statusCode).toBe(409);
  });

  it("rejects malformed and hidden staff status updates", async () => {
    const fake = fakes();
    app = await testApp(fake.options);
    expect((await patchStatus(app, { status: "inactive" })).statusCode).toBe(400);
    expect((await patchStatus(app, { status: "deactivated", organizationId })).statusCode).toBe(
      400,
    );
    expect((await patchStatus(app, { status: "deactivated" }, null)).statusCode).toBe(400);
    fake.setStatusResult({ outcome: "rejected", reason: "target_not_found" });
    expect((await patchStatus(app)).statusCode).toBe(404);
    fake.setStatusResult({ outcome: "rejected", reason: "idempotency_conflict" });
    expect((await patchStatus(app)).statusCode).toBe(409);
  });

  it("fails closed for malformed, hidden, and cross-tenant removal targets", async () => {
    const fake = fakes();
    app = await testApp(fake.options);
    expect((await remove(app, null)).statusCode).toBe(400);
    expect(fake.removalCommands).toHaveLength(0);
    fake.setRemoveResult({ outcome: "rejected", reason: "target_not_found" });
    expect((await remove(app, "remove-key", foreignPropertyId)).statusCode).toBe(404);
    fake.setRemoveResult({ outcome: "rejected", reason: "inviter_not_authorized" });
    expect((await remove(app)).statusCode).toBe(403);
    fake.setRemoveResult({ outcome: "rejected", reason: "idempotency_conflict" });
    expect((await remove(app)).statusCode).toBe(409);
    expect(fake.revocationJobs).toHaveLength(0);
  });

  it("rejects repeated Idempotency-Key headers before removal", async () => {
    const fake = fakes();
    app = await testApp(fake.options);
    expect(await repeatedIdempotencyDelete(app)).toBe(400);
    expect(fake.removalCommands).toHaveLength(0);
    expect(fake.revocationJobs).toHaveLength(0);
  });

  it.each([
    ["pending", "pending"],
    ["reconciliation_required", "reconciliation_required"],
  ] as const)(
    "returns accepted while provider revocation is %s",
    async (outcome, providerStatus) => {
      const fake = fakes();
      fake.setRevocationResult({
        outcome,
        jobId: "66666666-6666-4666-8666-666666666666",
      });
      app = await testApp(fake.options);
      expect(await remove(app)).toMatchObject({
        statusCode: 202,
        body: { status: "removed", providerStatus },
      });
    },
  );
});

function body() {
  return {
    email: " Staff@Example.test ",
    name: " Staff Example ",
    roleKey: "front_desk",
    propertyIds: [propertyId],
    permissionOverrides: { grant: [], deny: [] },
    configurationRevision: 1,
  };
}

function accessBody() {
  return {
    roleKey: "front_desk",
    propertyIds: [propertyId],
    permissionOverrides: { grant: [], deny: [] },
  };
}

function post(
  app: Awaited<ReturnType<typeof testApp>>,
  payload: Record<string, unknown> = body(),
  key: string | null = "invite-key",
) {
  return injectJson(app, {
    method: "POST",
    url: "/api/identity/staff/invitations",
    headers: {
      authorization: "Bearer valid-token",
      ...(key === null ? {} : { "idempotency-key": key }),
    },
    payload,
  });
}

function get(app: Awaited<ReturnType<typeof testApp>>) {
  return injectJson(app, {
    method: "GET",
    url: "/api/identity/staff/members",
    headers: { authorization: "Bearer valid-token" },
  });
}

function patchAccess(
  app: Awaited<ReturnType<typeof testApp>>,
  payload: Record<string, unknown> = accessBody(),
  key: string | null = "access-key",
) {
  return injectJson(app, {
    method: "PATCH",
    url: `/api/identity/staff/members/${staffMembershipId}`,
    headers: {
      authorization: "Bearer valid-token",
      ...(key === null ? {} : { "idempotency-key": key }),
    },
    payload,
  });
}

function patchStatus(
  app: Awaited<ReturnType<typeof testApp>>,
  payload: Record<string, unknown> = { status: "deactivated" },
  key: string | null = "status-key",
) {
  return injectJson(app, {
    method: "PATCH",
    url: `/api/identity/staff/members/${staffMembershipId}/status`,
    headers: {
      authorization: "Bearer valid-token",
      ...(key === null ? {} : { "idempotency-key": key }),
    },
    payload,
  });
}

function remove(
  app: Awaited<ReturnType<typeof testApp>>,
  key: string | null = "remove-key",
  membershipId = staffMembershipId,
) {
  return injectJson(app, {
    method: "DELETE",
    url: `/api/identity/staff/members/${membershipId}`,
    headers: {
      authorization: "Bearer valid-token",
      ...(key === null ? {} : { "idempotency-key": key }),
    },
  });
}

async function repeatedIdempotencyDelete(app: Awaited<ReturnType<typeof testApp>>) {
  await app.listen({ host: "127.0.0.1", port: 0 });
  const address = app.server.address();
  if (!address || typeof address === "string") throw new Error("Test server did not bind");
  return new Promise<number>((resolve, reject) => {
    const request = httpRequest(
      {
        host: "127.0.0.1",
        port: address.port,
        path: `/api/identity/staff/members/${staffMembershipId}`,
        method: "DELETE",
        headers: {
          authorization: "Bearer valid-token",
          "idempotency-key": ["first", "second"],
        },
      },
      (response) => {
        response.resume();
        response.on("end", () => resolve(response.statusCode ?? 0));
      },
    );
    request.on("error", reject);
    request.end();
  });
}
