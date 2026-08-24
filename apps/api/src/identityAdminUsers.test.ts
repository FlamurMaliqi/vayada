import {
  createFakeVerifier,
  type IdentityLifecycleCommand,
  type IdentityLifecycleCommandBus,
  type IdentityRepository,
  type VerifiedSession,
} from "@vayada/backend-auth";
import { injectJson } from "@vayada/backend-test";
import { afterEach, describe, expect, it } from "vitest";

import { buildApp } from "./app.js";
import { agencyPropertyAccessRepository } from "./testAuthorization.js";
import type {
  IdentityAdminCommandResponse,
  IdentityAdminUsersListResponse,
  IdentityAdminUsersReadRepository,
  IdentityAdminUserDetailResponse,
} from "./routes/identityAdminUsers.js";

const session: VerifiedSession = {
  workosUserId: "user_workos_platform",
  workosOrgId: "org_workos_platform",
  sessionId: "session_platform",
  expiresAt: Math.floor(Date.now() / 1000) + 3600,
};

const identityRepository: IdentityRepository = {
  async findUserByProviderUserId() {
    return {
      userId: "user_platform_admin",
      email: "admin@vayada.com",
      status: "active",
    };
  },
  async findOrganizationByWorkosOrgId() {
    return {
      organizationId: "org_platform",
      workosOrgId: "org_workos_platform",
      kind: "platform",
      status: "active",
    };
  },
  async findActiveMembership() {
    return {
      membershipId: "membership_platform",
      status: "active",
      roleKey: "platform_admin",
      workosMembershipId: null,
      workosRoleSlugs: ["platform_admin"],
    };
  },
  async findLinkedResources() {
    return [
      {
        product: "platform",
        resourceType: "platform",
        resourceId: "vayada",
        relationship: "operator",
        status: "active",
      },
    ];
  },
};

describe("identity admin user routes", () => {
  let app: ReturnType<typeof buildApp> | undefined;

  afterEach(async () => {
    await app?.close();
  });

  it("creates users through identity.user.create commands", async () => {
    const commandBus = createRecordingCommandBus();
    app = buildAdminApp(commandBus);

    const response = await injectJson<IdentityAdminCommandResponse>(app, {
      method: "POST",
      url: "/api/identity/admin/users",
      headers: { authorization: "Bearer valid-token" },
      payload: {
        email: "creator@example.com",
        name: "Creator Example",
        type: "creator",
        status: "verified",
      },
    });

    expect(response.statusCode).toBe(201);
    expect(commandBus.commands[0]).toMatchObject({
      commandType: "identity.user.create",
      payload: {
        email: "creator@example.com",
        legacyUserType: "creator",
        initialStatus: "active",
      },
    });
  });

  it("lists and reads users from the identity admin surface", async () => {
    const commandBus = createRecordingCommandBus();
    const readRepository = createMemoryAdminUsersReadRepository();
    app = buildAdminApp(commandBus, readRepository);

    const list = await injectJson<IdentityAdminUsersListResponse>(app, {
      method: "GET",
      url: "/api/identity/admin/users?type=creator",
      headers: { authorization: "Bearer valid-token" },
    });

    expect(list.statusCode).toBe(200);
    expect(list.body.users).toEqual([
      expect.objectContaining({
        id: "user_creator",
        email: "creator@example.com",
        type: "creator",
      }),
    ]);

    const detail = await injectJson<IdentityAdminUserDetailResponse>(app, {
      method: "GET",
      url: "/api/identity/admin/users/user_creator",
      headers: { authorization: "Bearer valid-token" },
    });

    expect(detail.statusCode).toBe(200);
    expect(detail.body).toMatchObject({
      id: "user_creator",
      emailVerified: true,
      profile: null,
    });
  });

  it("updates identity-owned user fields through lifecycle commands", async () => {
    const commandBus = createRecordingCommandBus();
    app = buildAdminApp(commandBus);

    const response = await injectJson<IdentityAdminCommandResponse>(app, {
      method: "PATCH",
      url: "/api/identity/admin/users/user_001",
      headers: { authorization: "Bearer valid-token" },
      payload: {
        name: "New Name",
        email: "new@example.com",
        status: "suspended",
      },
    });

    expect(response.statusCode).toBe(200);
    expect(commandBus.commands.map((command) => command.commandType)).toEqual([
      "identity.user.profile.update",
      "identity.user.email.update",
      "identity.user.suspend",
    ]);
  });

  it("models superadmin toggle as platform organization access", async () => {
    const commandBus = createRecordingCommandBus();
    app = buildAdminApp(commandBus);

    const response = await injectJson<IdentityAdminCommandResponse>(app, {
      method: "PUT",
      url: "/api/identity/admin/users/user_001/platform-access",
      headers: { authorization: "Bearer valid-token" },
      payload: { enabled: true, platformOrganizationId: "org_platform" },
    });

    expect(response.statusCode).toBe(200);
    expect(commandBus.commands[0]).toMatchObject({
      commandType: "identity.access.grant",
      payload: {
        userId: "user_001",
        membership: { roleKey: "platform_admin", propertyAccessMode: "assigned" },
        resourceLinks: [
          {
            product: "platform",
            resourceType: "platform",
            resourceId: "vayada",
            relationship: "operator",
          },
        ],
      },
    });
  });
});

function buildAdminApp(
  commandBus: ReturnType<typeof createRecordingCommandBus>,
  readRepository?: IdentityAdminUsersReadRepository,
) {
  return buildApp({
    logger: false,
    identityLifecycleCommandBus: commandBus,
    identityAdminUsersReadRepository: readRepository,
    auth: {
      verifier: createFakeVerifier(new Map([["valid-token", session]])),
      repository: identityRepository,
      propertyAccessRepository: agencyPropertyAccessRepository,
      rolePermissionRepository: {
        async findPermissionsForRole() {
          return ["platform.user.suspend"];
        },
      },
    },
  });
}

function createMemoryAdminUsersReadRepository(): IdentityAdminUsersReadRepository {
  const users: IdentityAdminUsersListResponse["users"] = [
    {
      id: "user_creator",
      email: "creator@example.com",
      name: "Creator Example",
      type: "creator",
      status: "verified",
      avatar: null,
      email_verified: true,
      created_at: "2026-06-12T10:00:00.000Z",
      updated_at: "2026-06-12T10:00:00.000Z",
    },
  ];
  return {
    async listUsers(input) {
      const filtered = users.filter((user) => !input.type || user.type === input.type);
      return { users: filtered, total: filtered.length };
    },
    async findUserById(userId) {
      const user = users.find((item) => item.id === userId);
      if (!user) return null;
      return {
        id: user.id,
        email: user.email,
        name: user.name,
        type: user.type,
        status: user.status,
        avatar: null,
        emailVerified: user.email_verified ?? false,
        created_at: user.created_at,
        updated_at: user.updated_at,
        profile: null,
      };
    },
  };
}

function createRecordingCommandBus(): IdentityLifecycleCommandBus & {
  commands: IdentityLifecycleCommand[];
} {
  const commands: IdentityLifecycleCommand[] = [];
  return {
    commands,
    async execute(command) {
      commands.push(command);
      return {
        status: "accepted",
        commandId: command.commandId,
        idempotencyKey: command.idempotencyKey,
        userId:
          "payload" in command && "userId" in command.payload
            ? command.payload.userId
            : "user_created",
        events: [],
      };
    },
  };
}
