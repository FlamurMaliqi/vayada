import { describe, expect, it } from "vitest";

import { buildApp } from "./app.js";
import { mapWorkosMembershipRoleKey } from "./platform/workosWebhooks.js";
import type {
  WorkosMembershipPayload,
  WorkosOrganizationPayload,
  WorkosUserPayload,
  WorkosWebhookEvent,
  WorkosWebhookReceiptInput,
  WorkosWebhookStore,
} from "./routes/workosWebhooks.js";

describe("WorkOS webhook routes", () => {
  it("verifies the signature and reconciles a user event", async () => {
    const store = createMemoryStore();
    const app = buildApp({
      workosWebhooks: {
        secret: "whsec_test",
        verifier: verifierFor(event("evt_user_created", "user.created", userData())),
        store,
        processInline: true,
      },
    });

    const response = await app.inject({
      method: "POST",
      url: "/auth/workos/webhook",
      headers: {
        "content-type": "application/json",
        "workos-signature": "valid-signature",
      },
      payload: JSON.stringify({ id: "evt_user_created" }),
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ status: "accepted" });
    expect(store.users.get("user_workos_platform")).toMatchObject({
      email: "admin@example.com",
      name: "Admin User",
      status: "active",
    });
    await app.close();
  });

  it("rejects invalid signatures before recording a receipt", async () => {
    const store = createMemoryStore();
    const app = buildApp({
      workosWebhooks: {
        secret: "whsec_test",
        verifier: {
          async verify() {
            throw new Error("invalid signature");
          },
        },
        store,
        processInline: true,
      },
    });

    const response = await app.inject({
      method: "POST",
      url: "/auth/workos/webhook",
      headers: {
        "content-type": "application/json",
        "workos-signature": "bad-signature",
      },
      payload: JSON.stringify({ id: "evt_user_created" }),
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ error: "invalid_workos_signature" });
    expect(store.receipts).toEqual([]);
    await app.close();
  });

  it("rejects malformed signed payloads before recording a receipt", async () => {
    const store = createMemoryStore();
    const app = buildApp({
      workosWebhooks: {
        secret: "whsec_test",
        verifier: verifierFor(event("evt_bad_payload", "user.created", userData())),
        store,
        processInline: true,
      },
    });

    const response = await app.inject({
      method: "POST",
      url: "/auth/workos/webhook",
      headers: {
        "content-type": "application/json",
        "workos-signature": "valid-signature",
      },
      payload: "not-json",
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ error: "invalid_workos_payload" });
    expect(store.receipts).toEqual([]);
    await app.close();
  });

  it("deduplicates WorkOS retry delivery by event id", async () => {
    const store = createMemoryStore();
    const app = buildApp({
      workosWebhooks: {
        secret: "whsec_test",
        verifier: verifierFor(event("evt_retry", "user.created", userData())),
        store,
        processInline: true,
      },
    });

    const first = await postWebhook(app, "evt_retry");
    const second = await postWebhook(app, "evt_retry");

    expect(first.json()).toMatchObject({ status: "accepted" });
    expect(second.json()).toMatchObject({ status: "duplicate" });
    expect(store.receipts).toHaveLength(1);
    await app.close();
  });

  it("acks after recording the receipt and schedules reconciliation by default", async () => {
    const store = createMemoryStore();
    const scheduledTasks: Array<() => Promise<void>> = [];
    const app = buildApp({
      workosWebhooks: {
        secret: "whsec_test",
        verifier: verifierFor(event("evt_background", "user.created", userData())),
        store,
        processInline: false,
        scheduleProcessing(task) {
          scheduledTasks.push(task);
        },
      },
    });

    const response = await postWebhook(app, "evt_background");

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ status: "accepted" });
    expect(store.receipts).toHaveLength(1);
    expect(store.users.has("user_workos_platform")).toBe(false);
    expect(scheduledTasks).toHaveLength(1);

    await scheduledTasks[0]!();

    expect(store.users.get("user_workos_platform")).toMatchObject({
      email: "admin@example.com",
      status: "active",
    });
    await app.close();
  });

  it("recovers duplicate deliveries when the receipt exists but reconciliation never completed", async () => {
    const store = createMemoryStore();
    const scheduledTasks: Array<() => Promise<void>> = [];
    const app = buildApp({
      workosWebhooks: {
        secret: "whsec_test",
        verifier: verifierFor(event("evt_unprocessed_retry", "user.created", userData())),
        store,
        processInline: false,
        scheduleProcessing(task) {
          scheduledTasks.push(task);
        },
      },
    });

    const first = await postWebhook(app, "evt_unprocessed_retry");
    const second = await postWebhook(app, "evt_unprocessed_retry");

    expect(first.json()).toMatchObject({ status: "accepted" });
    expect(second.json()).toMatchObject({ status: "accepted" });
    expect(store.receipts).toHaveLength(1);
    expect(scheduledTasks).toHaveLength(2);

    await scheduledTasks[1]!();

    expect(store.users.get("user_workos_platform")).toMatchObject({
      email: "admin@example.com",
      status: "active",
    });
    await app.close();
  });

  it("accepts sparse WorkOS user deletion events", async () => {
    const store = createMemoryStore();
    store.users.set("user_workos_platform", {
      workosUserId: "user_workos_platform",
      email: "admin@example.com",
      emailVerified: true,
      status: "active",
      rawProfile: {},
    });
    const app = buildApp({
      workosWebhooks: {
        secret: "whsec_test",
        verifier: verifierFor(
          event("evt_user_deleted", "user.deleted", {
            id: "user_workos_platform",
          }),
        ),
        store,
        processInline: true,
      },
    });

    const response = await postWebhook(app, "evt_user_deleted");

    expect(response.json()).toMatchObject({ status: "accepted" });
    expect(store.users.get("user_workos_platform")?.status).toBe("deleted");
    await app.close();
  });

  it("does not reactivate a Vayada-suspended user when WorkOS reports active", async () => {
    const store = createMemoryStore();
    store.users.set("user_workos_platform", {
      workosUserId: "user_workos_platform",
      email: "admin@example.com",
      emailVerified: true,
      status: "suspended",
      rawProfile: {},
    });
    const app = buildApp({
      workosWebhooks: {
        secret: "whsec_test",
        verifier: verifierFor(event("evt_user_updated", "user.updated", userData())),
        store,
        processInline: true,
      },
    });

    const response = await postWebhook(app, "evt_user_updated");

    expect(response.json()).toMatchObject({ status: "accepted" });
    expect(store.users.get("user_workos_platform")?.status).toBe("suspended");
    await app.close();
  });

  it("does not reactivate a Vayada-suspended organization when WorkOS reports active", async () => {
    const store = createMemoryStore();
    store.organizations.set("org_workos_platform", {
      workosOrgId: "org_workos_platform",
      name: "Platform",
      slug: "platform",
      kind: "platform",
      status: "suspended",
    });
    const app = buildApp({
      workosWebhooks: {
        secret: "whsec_test",
        verifier: verifierFor(event("evt_org_updated", "organization.updated", organizationData())),
        store,
        processInline: true,
      },
    });

    const response = await postWebhook(app, "evt_org_updated");

    expect(response.json()).toMatchObject({ status: "accepted" });
    expect(store.organizations.get("org_workos_platform")?.status).toBe("suspended");
    await app.close();
  });

  it("dead-letters out-of-order membership events when linked user or organization is unknown", async () => {
    const store = createMemoryStore();
    const app = buildApp({
      workosWebhooks: {
        secret: "whsec_test",
        verifier: verifierFor(
          event("evt_membership_created", "organization_membership.created", membershipData()),
        ),
        store,
        processInline: true,
      },
    });

    const response = await postWebhook(app, "evt_membership_created");

    expect(response.json()).toMatchObject({ status: "dead_lettered" });
    expect(store.deadLetters).toEqual([
      expect.objectContaining({
        reasonCode: "identity_reconciliation_failed",
        failureSummary: "WorkOS membership references an unknown user or organization",
      }),
    ]);
    await app.close();
  });

  it("reconciles membership fields deserialized by the WorkOS SDK", async () => {
    const store = createMemoryStore();
    store.users.set("user_workos_platform", userPayload());
    store.organizations.set("org_workos_platform", organizationPayload());
    const app = buildApp({
      workosWebhooks: {
        secret: "whsec_test",
        verifier: verifierFor(
          event("evt_membership_created", "organization_membership.created", {
            id: "om_platform",
            userId: "user_workos_platform",
            organizationId: "org_workos_platform",
            role: { slug: "admin" },
            roles: [{ slug: "admin" }],
            status: "active",
          }),
        ),
        store,
        processInline: true,
      },
    });

    const response = await postWebhook(app, "evt_membership_created");

    expect(response.json()).toMatchObject({ status: "accepted" });
    expect(store.memberships.get("om_platform")).toMatchObject({
      workosUserId: "user_workos_platform",
      workosOrgId: "org_workos_platform",
      roleKey: "admin",
      status: "active",
    });
    await app.close();
  });

  it("deactivates memberships from WorkOS removal events", async () => {
    const store = createMemoryStore();
    store.users.set("user_workos_platform", {
      workosUserId: "user_workos_platform",
      email: "admin@example.com",
      emailVerified: true,
      status: "active",
      rawProfile: {},
    });
    store.organizations.set("org_workos_platform", {
      workosOrgId: "org_workos_platform",
      name: "Platform",
      slug: "platform",
      kind: "platform",
      status: "active",
    });
    store.memberships.set("om_platform", {
      ...membershipPayload(),
      status: "active",
    });
    const app = buildApp({
      workosWebhooks: {
        secret: "whsec_test",
        verifier: verifierFor(
          event("evt_membership_deleted", "organization_membership.deleted", {
            id: "om_platform",
          }),
        ),
        store,
        processInline: true,
      },
    });

    const response = await postWebhook(app, "evt_membership_deleted");

    expect(response.json()).toMatchObject({ status: "accepted" });
    expect(store.memberships.get("om_platform")?.status).toBe("inactive");
    await app.close();
  });

  it("deactivates a directory user's membership when WorkOS reports directory removal", async () => {
    const store = createMemoryStore();
    store.users.set("user_workos_platform", {
      workosUserId: "user_workos_platform",
      email: "admin@example.com",
      emailVerified: true,
      status: "active",
      rawProfile: {},
    });
    store.organizations.set("org_workos_platform", {
      workosOrgId: "org_workos_platform",
      name: "Platform",
      slug: "platform",
      kind: "platform",
      status: "active",
    });
    store.memberships.set("om_platform", membershipPayload());
    const app = buildApp({
      workosWebhooks: {
        secret: "whsec_test",
        verifier: verifierFor(
          event("evt_dsync_user_deleted", "dsync.user.deleted", {
            id: "directory_user_1",
            organization_id: "org_workos_platform",
            email: "ADMIN@example.com",
            state: "inactive",
          }),
        ),
        store,
        processInline: true,
      },
    });

    const response = await postWebhook(app, "evt_dsync_user_deleted");

    expect(response.json()).toMatchObject({ status: "accepted" });
    expect(store.memberships.get("om_platform")?.status).toBe("inactive");
    await app.close();
  });

  it("does not reactivate a Vayada-suspended membership when WorkOS reports active", async () => {
    const store = createMemoryStore();
    store.users.set("user_workos_platform", {
      workosUserId: "user_workos_platform",
      email: "admin@example.com",
      emailVerified: true,
      status: "active",
      rawProfile: {},
    });
    store.organizations.set("org_workos_platform", {
      workosOrgId: "org_workos_platform",
      name: "Platform",
      slug: "platform",
      kind: "platform",
      status: "active",
    });
    store.memberships.set("om_platform", {
      ...membershipPayload(),
      status: "suspended",
    });
    const app = buildApp({
      workosWebhooks: {
        secret: "whsec_test",
        verifier: verifierFor(
          event("evt_membership_updated", "organization_membership.updated", membershipData()),
        ),
        store,
        processInline: true,
      },
    });

    const response = await postWebhook(app, "evt_membership_updated");

    expect(response.json()).toMatchObject({ status: "accepted" });
    expect(store.memberships.get("om_platform")?.status).toBe("suspended");
    expect(store.memberships.get("om_platform")?.workosRoleSlugs).toEqual([
      "platform_admin",
      "billing_admin",
    ]);
    await app.close();
  });

  it("maps WorkOS admin memberships back to internal owner roles", () => {
    expect(
      mapWorkosMembershipRoleKey({
        organizationKind: "platform",
        roleKey: "admin",
      }),
    ).toBe("platform_admin");
    expect(
      mapWorkosMembershipRoleKey({
        organizationKind: "hotel_group",
        roleKey: "admin",
      }),
    ).toBe("hotel_owner");
    expect(
      mapWorkosMembershipRoleKey({
        organizationKind: "hotel_group",
        roleKey: "admin",
        existingRoleKey: "owner",
      }),
    ).toBe("owner");
    expect(
      mapWorkosMembershipRoleKey({
        organizationKind: "creator_workspace",
        roleKey: "admin",
      }),
    ).toBe("admin");
    expect(
      mapWorkosMembershipRoleKey({
        organizationKind: "platform",
        roleKey: "member",
      }),
    ).toBe("member");
  });
});

function verifierFor(event: WorkosWebhookEvent) {
  return {
    async verify(input: { signature: string }) {
      if (input.signature !== "valid-signature") {
        throw new Error("invalid signature");
      }
      return event;
    },
  };
}

function event(id: string, eventName: string, data: Record<string, unknown>): WorkosWebhookEvent {
  return {
    id,
    event: eventName,
    createdAt: "2026-06-11T07:00:00.000Z",
    data,
  };
}

function userData() {
  return {
    id: "user_workos_platform",
    email: "admin@example.com",
    first_name: "Admin",
    last_name: "User",
    email_verified: true,
  };
}

function userPayload(): WorkosUserPayload {
  return {
    workosUserId: "user_workos_platform",
    email: "admin@example.com",
    emailVerified: true,
    status: "active",
    rawProfile: {},
  };
}

function organizationData() {
  return {
    id: "org_workos_platform",
    name: "Platform",
    slug: "platform",
    organization_kind: "platform",
  };
}

function organizationPayload(): WorkosOrganizationPayload {
  return {
    workosOrgId: "org_workos_platform",
    name: "Platform",
    slug: "platform",
    kind: "platform",
    status: "active",
  };
}

function membershipData() {
  return {
    id: "om_platform",
    user_id: "user_workos_platform",
    organization_id: "org_workos_platform",
    role: {
      slug: "platform_admin",
    },
    roles: [
      {
        slug: "platform_admin",
      },
      {
        slug: "billing_admin",
      },
    ],
    status: "active",
  };
}

function membershipPayload(): WorkosMembershipPayload {
  return {
    workosMembershipId: "om_platform",
    workosUserId: "user_workos_platform",
    workosOrgId: "org_workos_platform",
    roleKey: "platform_admin",
    workosRoleSlugs: ["platform_admin", "billing_admin"],
    status: "active",
  };
}

async function postWebhook(app: ReturnType<typeof buildApp>, eventId: string) {
  return app.inject({
    method: "POST",
    url: "/auth/workos/webhook",
    headers: {
      "content-type": "application/json",
      "workos-signature": "valid-signature",
    },
    payload: JSON.stringify({ id: eventId }),
  });
}

function createMemoryStore() {
  const receipts: WorkosWebhookReceiptInput[] = [];
  const receiptIds = new Map<string, string>();
  const processedReceiptIds = new Set<string>();
  const users = new Map<string, WorkosUserPayload>();
  const organizations = new Map<string, WorkosOrganizationPayload>();
  const memberships = new Map<string, WorkosMembershipPayload>();
  const deadLetters: Array<{
    receiptId: string;
    reasonCode: string;
    failureSummary: string;
  }> = [];

  const store: WorkosWebhookStore & {
    receipts: WorkosWebhookReceiptInput[];
    users: Map<string, WorkosUserPayload>;
    organizations: Map<string, WorkosOrganizationPayload>;
    memberships: Map<string, WorkosMembershipPayload>;
    deadLetters: typeof deadLetters;
  } = {
    receipts,
    users,
    organizations,
    memberships,
    deadLetters,
    async insertReceipt(input) {
      const existing = receiptIds.get(input.providerEventId);
      if (existing) {
        return {
          status: "duplicate",
          receiptId: existing,
          deliveryStatus: "validated",
        };
      }
      const receiptId = `receipt_${receiptIds.size + 1}`;
      receiptIds.set(input.providerEventId, receiptId);
      receipts.push(input);
      return {
        status: "inserted",
        receiptId,
      };
    },
    async markReceiptProcessed(input) {
      processedReceiptIds.add(input.receiptId);
    },
    async isReceiptProcessed(receiptId) {
      return processedReceiptIds.has(receiptId);
    },
    async deadLetterReceipt(input) {
      processedReceiptIds.add(input.receiptId);
      deadLetters.push({
        receiptId: input.receiptId,
        reasonCode: input.reasonCode,
        failureSummary: input.failureSummary,
      });
    },
    async findUserIdByWorkosUserId(workosUserId) {
      return users.has(workosUserId) ? `internal_${workosUserId}` : null;
    },
    async findOrganizationIdByWorkosOrgId(workosOrgId) {
      return organizations.has(workosOrgId) ? `internal_${workosOrgId}` : null;
    },
    async upsertWorkosUser(input) {
      const existing = users.get(input.workosUserId);
      users.set(input.workosUserId, {
        ...input,
        status:
          existing?.status && ["suspended", "deleted"].includes(existing.status)
            ? existing.status
            : input.status,
      });
      return `internal_${input.workosUserId}`;
    },
    async upsertWorkosOrganization(input) {
      const existing = organizations.get(input.workosOrgId);
      organizations.set(input.workosOrgId, {
        ...input,
        status:
          existing?.status && ["suspended", "archived"].includes(existing.status)
            ? existing.status
            : input.status,
      });
      return `internal_${input.workosOrgId}`;
    },
    async deactivateWorkosUser(workosUserId) {
      const existing = users.get(workosUserId);
      if (existing) {
        users.set(workosUserId, {
          ...existing,
          status: "deleted",
        });
      }
      return {
        userId: existing ? `internal_${workosUserId}` : undefined,
      };
    },
    async archiveWorkosOrganization(workosOrgId) {
      const existing = organizations.get(workosOrgId);
      if (existing) {
        organizations.set(workosOrgId, {
          ...existing,
          status: "archived",
        });
      }
      return {
        organizationId: existing ? `internal_${workosOrgId}` : undefined,
      };
    },
    async deactivateDirectoryUser(input) {
      const organization = organizations.get(input.workosOrgId);
      const user = Array.from(users.values()).find(
        (candidate) => candidate.email.toLowerCase() === input.email.toLowerCase(),
      );
      for (const [membershipId, membership] of memberships) {
        if (
          membership.workosOrgId === input.workosOrgId &&
          membership.workosUserId === user?.workosUserId &&
          ["active", "pending"].includes(membership.status)
        ) {
          memberships.set(membershipId, {
            ...membership,
            status: "inactive",
          });
        }
      }
      return {
        userId: user ? `internal_${user.workosUserId}` : undefined,
        organizationId: organization ? `internal_${organization.workosOrgId}` : undefined,
      };
    },
    async deactivateOrganizationDirectoryMemberships(workosOrgId) {
      const organization = organizations.get(workosOrgId);
      for (const [membershipId, membership] of memberships) {
        if (
          membership.workosOrgId === workosOrgId &&
          ["active", "pending"].includes(membership.status)
        ) {
          memberships.set(membershipId, {
            ...membership,
            status: "inactive",
          });
        }
      }
      return {
        organizationId: organization ? `internal_${organization.workosOrgId}` : undefined,
      };
    },
    async upsertWorkosMembership(input) {
      if (!users.has(input.workosUserId) || !organizations.has(input.workosOrgId)) {
        throw new Error("WorkOS membership references an unknown user or organization");
      }
      const existing = memberships.get(input.workosMembershipId);
      memberships.set(input.workosMembershipId, {
        ...input,
        status:
          existing?.status && ["inactive", "suspended"].includes(existing.status)
            ? existing.status
            : input.status,
      });
      return {
        userId: `internal_${input.workosUserId}`,
        organizationId: `internal_${input.workosOrgId}`,
      };
    },
    async deactivateWorkosMembership(workosMembershipId) {
      const existing = memberships.get(workosMembershipId);
      if (existing) {
        memberships.set(workosMembershipId, {
          ...existing,
          status: "inactive",
        });
      }
      return {};
    },
  };

  return store;
}
