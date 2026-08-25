import type {
  CreateStaffInviteCommand,
  PermissionKey,
  RequestContext,
  UpdateStaffAccessCommand,
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
  const deliveries: string[] = [];
  const rosterOrganizations: string[] = [];
  let result: PersistResult = { outcome: "created", invitationId };
  let updateResult: UpdateResult = { outcome: "updated", membershipId: staffMembershipId };
  return {
    commands,
    accessCommands,
    deliveries,
    rosterOrganizations,
    setResult(value: PersistResult) {
      result = value;
    },
    setUpdateResult(value: UpdateResult) {
      updateResult = value;
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
    expect(fake.commands).toHaveLength(0);
    expect(fake.accessCommands).toHaveLength(0);
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
