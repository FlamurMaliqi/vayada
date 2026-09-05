import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import {
  createPgStaffInvitationDeliveryRepository,
  createStaffInvitationDeliveryCoordinator,
  type StaffInvitationDeliveryClaim,
  type StaffInvitationProvider,
  type StaffInvitationProviderResponse,
} from "./staffInvitationDelivery.js";
import {
  createPgStaffInvitationAcceptanceRepository,
  type StaffInvitationAcceptanceEvent,
} from "./staffInvitationAcceptance.js";
import { createPgStaffInvitationRepository } from "./staffInvitations.js";
import { createStaffRemovalCoordinator, type StaffRemovalProvider } from "./staffRemoval.js";
import { createPgStaffRemovalJobRepository } from "./staffRemovalJobs.js";
import type {
  CreateStaffInviteCommand,
  RemoveStaffCommand,
  UpdateStaffAccessCommand,
  UpdateStaffStatusCommand,
} from "./lifecycle.js";

const TEST_DATABASE_URL = process.env["TEST_DATABASE_URL"];
const org = "11111111-1111-4111-8111-111111111111";
const otherOrg = "22222222-2222-4222-8222-222222222222";
const owner = "33333333-3333-4333-8333-333333333333";
const otherUser = "44444444-4444-4444-8444-444444444444";
const membership = "55555555-5555-4555-8555-555555555555";
const otherMembership = "88888888-8888-4888-8888-888888888888";
const property = "66666666-6666-4666-8666-666666666666";
const foreignProperty = "77777777-7777-4777-8777-777777777777";
const workosIdentity = "99999999-9999-4999-8999-999999999999";
const ambiguousIdentity = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const staffUser = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const staffMembership = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const staffIdentity = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const secondProperty = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
type RejectionReason =
  | "inviter_not_authorized"
  | "idempotency_conflict"
  | "configuration_conflict"
  | "property_scope_invalid";

function command(
  input: Partial<{
    commandId: string;
    idempotencyKey: string;
    revision: number;
    email: string;
    organizationId: string;
    actorUserId: string;
    propertyIds: string[];
    roleKey: "hotel_manager" | "front_desk" | "housekeeping";
  }> = {},
): CreateStaffInviteCommand {
  return {
    commandType: "identity.invite.staff.create",
    commandId: input.commandId ?? "command-1",
    idempotencyKey: input.idempotencyKey ?? "invite-1",
    audit: {
      actor: {
        kind: "user",
        userId: input.actorUserId ?? owner,
        organizationId: input.organizationId ?? org,
      },
      source: "admin",
      requestId: "request-1",
      reason: "Invite staff",
      requestedAt: "2026-08-24T00:00:00.000Z",
    },
    payload: {
      organizationId: input.organizationId ?? org,
      email: input.email ?? " Staff@Example.com ",
      name: " Staff Example ",
      roleKey: input.roleKey ?? "front_desk",
      propertyAccessMode: "assigned",
      propertyIds: input.propertyIds ?? [property],
      permissionOverrides: { grant: [], deny: ["booking.analytics.read"] },
      configurationRevision: input.revision ?? 1,
    },
  };
}

function updateCommand(
  input: Partial<{
    idempotencyKey: string;
    organizationId: string;
    membershipId: string;
    actorUserId: string;
    propertyIds: string[];
    roleKey: "hotel_manager" | "front_desk" | "housekeeping";
  }> = {},
): UpdateStaffAccessCommand {
  const organizationId = input.organizationId ?? org;
  return {
    commandType: "identity.staff.access.update",
    commandId: randomUUID(),
    idempotencyKey: input.idempotencyKey ?? `update-${randomUUID()}`,
    audit: {
      actor: { kind: "user", userId: input.actorUserId ?? owner, organizationId },
      source: "admin",
      requestId: `request-${randomUUID()}`,
      reason: "Update staff access",
      requestedAt: "2026-08-24T00:00:00.000Z",
    },
    payload: {
      organizationId,
      membershipId: input.membershipId ?? staffMembership,
      roleKey: input.roleKey ?? "front_desk",
      propertyAccessMode: "assigned",
      propertyIds: input.propertyIds ?? [property],
      permissionOverrides: { grant: [], deny: ["booking.analytics.read"] },
    },
  };
}

function statusCommand(
  input: Partial<{
    idempotencyKey: string;
    organizationId: string;
    membershipId: string;
    actorUserId: string;
    membershipStatus: "active" | "suspended";
  }> = {},
): UpdateStaffStatusCommand {
  const organizationId = input.organizationId ?? org;
  return {
    commandType: "identity.staff.status.update",
    commandId: randomUUID(),
    idempotencyKey: input.idempotencyKey ?? `status-${randomUUID()}`,
    audit: {
      actor: { kind: "user", userId: input.actorUserId ?? owner, organizationId },
      source: "admin",
      requestId: `request-${randomUUID()}`,
      reason: "Update staff status",
      requestedAt: "2026-08-24T00:00:00.000Z",
    },
    payload: {
      organizationId,
      membershipId: input.membershipId ?? staffMembership,
      membershipStatus: input.membershipStatus ?? "suspended",
    },
  };
}

function removalCommand(
  input: Partial<{
    idempotencyKey: string;
    organizationId: string;
    membershipId: string;
    actorUserId: string;
  }> = {},
): RemoveStaffCommand {
  const organizationId = input.organizationId ?? org;
  return {
    commandType: "identity.staff.remove",
    commandId: randomUUID(),
    idempotencyKey: input.idempotencyKey ?? `remove-${randomUUID()}`,
    audit: {
      actor: { kind: "user", userId: input.actorUserId ?? owner, organizationId },
      source: "admin",
      requestId: `request-${randomUUID()}`,
      reason: "Remove staff membership",
      requestedAt: "2026-08-24T00:00:00.000Z",
    },
    payload: {
      organizationId,
      membershipId: input.membershipId ?? staffMembership,
    },
  };
}

function providerResponse(
  claim: StaffInvitationDeliveryClaim,
  patch: Partial<StaffInvitationProviderResponse> = {},
): StaffInvitationProviderResponse {
  return {
    invitationId: `invitation_${claim.invitationId}`,
    email: claim.email,
    organizationId: claim.organizationId,
    inviterUserId: claim.inviterUserId,
    roleSlug: claim.roleSlug,
    state: "pending",
    expiresAt: "2099-01-01T00:00:00.000Z",
    ...patch,
  };
}

function acceptanceEvent(
  providerInvitationId: string,
  patch: Partial<StaffInvitationAcceptanceEvent> = {},
): StaffInvitationAcceptanceEvent {
  return {
    providerEventId: `event_${providerInvitationId}`,
    providerInvitationId,
    providerUserId: "user_staff_acceptance",
    providerOrganizationId: "org_staff_delivery",
    invitationEmail: "staff@example.com",
    ...patch,
  };
}

async function expectRejection(
  repository: ReturnType<typeof createPgStaffInvitationRepository>,
  invitation: CreateStaffInviteCommand,
  reason: RejectionReason,
) {
  expect(await repository.persist(invitation)).toEqual({ outcome: "rejected", reason });
}

describe.skipIf(!TEST_DATABASE_URL)("PostgreSQL staff invitation repository", () => {
  let client: pg.Client;
  let repository: ReturnType<typeof createPgStaffInvitationRepository>;
  let deliveryRepository: ReturnType<typeof createPgStaffInvitationDeliveryRepository>;
  let acceptanceRepository: ReturnType<typeof createPgStaffInvitationAcceptanceRepository>;
  let removalJobRepository: ReturnType<typeof createPgStaffRemovalJobRepository>;

  beforeAll(async () => {
    const dbName = new URL(TEST_DATABASE_URL!).pathname.replace(/^\//, "");
    if (!/(^|[_-])test([_-]|$)/i.test(dbName)) throw new Error(`Refusing database ${dbName}`);
    client = new pg.Client({ connectionString: TEST_DATABASE_URL });
    await client.connect();
    repository = createPgStaffInvitationRepository({ connectionString: TEST_DATABASE_URL! });
    deliveryRepository = createPgStaffInvitationDeliveryRepository({
      connectionString: TEST_DATABASE_URL!,
    });
    acceptanceRepository = createPgStaffInvitationAcceptanceRepository({
      connectionString: TEST_DATABASE_URL!,
    });
    removalJobRepository = createPgStaffRemovalJobRepository({
      connectionString: TEST_DATABASE_URL!,
    });
    await client.query(`
      INSERT INTO identity.users (id, email, name, status) VALUES
        ('${owner}', 'owner@example.com', 'Owner Example', 'active'), ('${otherUser}', 'other@example.com', 'Other User', 'active'),
        ('${staffUser}', 'staff@example.com', 'Staff Example', 'active')
      ON CONFLICT (id) DO NOTHING;
      INSERT INTO identity.organizations (id, kind, name, slug, status) VALUES
        ('${org}', 'hotel_group', 'Owner Org', 'owner-org', 'active'), ('${otherOrg}', 'hotel_group', 'Other Org', 'other-org', 'active')
      ON CONFLICT (id) DO NOTHING;
      INSERT INTO identity.organization_memberships (id, organization_id, user_id, status, role_key, property_access_mode, access_origin) VALUES
        ('${membership}', '${org}', '${owner}', 'active', 'hotel_owner', 'all', 'agency'),
        ('${otherMembership}', '${otherOrg}', '${otherUser}', 'active', 'hotel_owner', 'all', 'agency'),
        ('${staffMembership}', '${org}', '${staffUser}', 'active', 'housekeeping', 'assigned', 'agency')
      ON CONFLICT (id) DO NOTHING;
      INSERT INTO hotel_catalog.properties (id, public_id, display_name) VALUES
        ('${property}', 'owner-property', 'Owner Property'), ('${foreignProperty}', 'foreign-property', 'Foreign Property'),
        ('${secondProperty}', 'second-property', 'Second Property')
      ON CONFLICT (id) DO NOTHING;
      INSERT INTO identity.organization_resource_links (organization_id, product, resource_type, resource_id, relationship, status) VALUES
        ('${org}', 'hotel_catalog', 'property', '${property}', 'owner', 'active'),
        ('${org}', 'hotel_catalog', 'property', '${secondProperty}', 'owner', 'active'),
        ('${otherOrg}', 'hotel_catalog', 'property', '${foreignProperty}', 'owner', 'active')
      ON CONFLICT DO NOTHING;
      UPDATE identity.organizations SET workos_org_id = 'org_staff_delivery' WHERE id = '${org}';
      UPDATE identity.organization_memberships SET workos_membership_id = 'om_staff_delivery'
      WHERE id = '${membership}';
      INSERT INTO identity.external_identities
        (id, user_id, provider, provider_user_id, provider_email, provider_email_verified)
      VALUES ('${workosIdentity}', '${owner}', 'workos', 'user_staff_delivery',
              'owner@example.com', true)
      ON CONFLICT (id) DO UPDATE SET provider_user_id = EXCLUDED.provider_user_id;
      INSERT INTO identity.external_identities
        (id, user_id, provider, provider_user_id, provider_email, provider_email_verified)
      VALUES ('${staffIdentity}', '${staffUser}', 'workos', 'user_staff_acceptance',
              'staff@example.com', true)
      ON CONFLICT (id) DO UPDATE SET provider_user_id = EXCLUDED.provider_user_id;
    `);
  });

  beforeEach(async () => {
    await client.query("DELETE FROM identity.staff_invitations");
    await client.query(
      "DELETE FROM identity.organization_memberships WHERE organization_id = $1 AND user_id = $2",
      [otherOrg, staffUser],
    );
    await client.query(
      "DELETE FROM identity.membership_property_assignments WHERE membership_id = $1",
      [staffMembership],
    );
    await client.query(
      `UPDATE identity.organization_memberships
       SET status = 'active', permission_overrides = NULL, workos_membership_id = 'om_staff_delivery'
       WHERE id = $1`,
      [membership],
    );
    await client.query(`
      UPDATE identity.users SET status = 'active' WHERE id = '${owner}';
      UPDATE identity.organizations SET status = 'active', workos_org_id = 'org_staff_delivery'
      WHERE id = '${org}';
      DELETE FROM identity.external_identities WHERE id = '${ambiguousIdentity}';
      UPDATE identity.users SET status = 'active' WHERE id = '${staffUser}';
      UPDATE identity.organization_memberships
      SET status = 'active', role_key = 'housekeeping', permission_overrides = NULL,
          property_access_mode = 'assigned', workos_membership_id = 'om_staff_acceptance',
          invited_at = NULL
      WHERE id = '${staffMembership}';
      UPDATE identity.organization_memberships
      SET status = 'active', role_key = 'hotel_owner', property_access_mode = 'all'
      WHERE organization_id = '${otherOrg}' AND user_id = '${otherUser}';
      UPDATE identity.external_identities
      SET provider_user_id = 'user_staff_acceptance', provider_email = 'staff@example.com',
          last_login_at = NULL
      WHERE id = '${staffIdentity}';
      UPDATE identity.organization_resource_links SET status = 'active'
      WHERE organization_id = '${org}' AND resource_id IN ('${property}', '${secondProperty}');
    `);
  });

  afterAll(async () => {
    await removalJobRepository.close();
    await deliveryRepository.close();
    await acceptanceRepository.close();
    await repository.close();
    await client.end();
  });

  it("fails closed for invalid inviter and property scope without writes", async () => {
    await expectRejection(
      repository,
      command({ actorUserId: otherUser }),
      "inviter_not_authorized",
    );
    await client.query(
      `UPDATE identity.organization_memberships SET status = 'suspended' WHERE id = $1`,
      [membership],
    );
    await expectRejection(repository, command(), "inviter_not_authorized");
    await client.query(
      `UPDATE identity.organization_memberships SET status = 'active', permission_overrides = '{"grant":[],"deny":["pms.calendar.read"]}' WHERE id = $1`,
      [membership],
    );
    await expectRejection(repository, command(), "inviter_not_authorized");
    await client.query(
      `UPDATE identity.organization_memberships SET status = 'active', permission_overrides = '{"grant":[],"deny":["identity.staff.manage"]}' WHERE id = $1`,
      [membership],
    );
    await expectRejection(repository, command(), "inviter_not_authorized");
    await client.query(
      `UPDATE identity.organization_memberships SET permission_overrides = NULL WHERE id = $1`,
      [membership],
    );
    await expectRejection(
      repository,
      command({ propertyIds: [foreignProperty] }),
      "property_scope_invalid",
    );
    const count = await client.query(
      "SELECT count(*)::int AS count FROM identity.staff_invitations",
    );
    expect(count.rows[0]?.count).toBe(0);
  });

  it("lists active, pending, and deactivated staff but hides removed memberships", async () => {
    await client.query(
      `INSERT INTO identity.membership_property_assignments (membership_id, property_id)
       VALUES ($1, $2)`,
      [staffMembership, property],
    );
    await client.query("UPDATE identity.external_identities SET last_login_at = $2 WHERE id = $1", [
      staffIdentity,
      "2026-08-24T12:00:00.000Z",
    ]);
    await client.query(
      `UPDATE identity.organization_memberships
       SET role_key = 'front_desk', property_access_mode = 'all'
       WHERE organization_id = $1 AND user_id = $2`,
      [otherOrg, otherUser],
    );
    const pending = await repository.persist(
      command({ email: "pending@example.com", idempotencyKey: "pending-roster" }),
    );
    if (pending.outcome !== "created") throw new Error("expected invitation creation");

    expect(await repository.listRoster(org)).toEqual([
      {
        id: staffMembership,
        name: "Staff Example",
        email: "staff@example.com",
        roleKey: "housekeeping",
        propertyIds: [property],
        status: "active",
        lastActiveAt: "2026-08-24T12:00:00.000Z",
      },
      {
        id: pending.invitationId,
        name: "Staff Example",
        email: "pending@example.com",
        roleKey: "front_desk",
        propertyIds: [property],
        status: "pending",
        lastActiveAt: null,
      },
    ]);

    await client.query(
      `UPDATE identity.organization_memberships SET property_access_mode = 'all' WHERE id = $1`,
      [staffMembership],
    );
    expect((await repository.listRoster(org))[0]?.propertyIds).toEqual([property, secondProperty]);
    await client.query(
      `UPDATE identity.staff_invitations
       SET delivery_state = 'delivered', delivery_attempted_at = now(),
           provider_invitation_id = 'invitation_expired_roster', expires_at = now() - interval '1 minute'
       WHERE id = $1`,
      [pending.invitationId],
    );
    await client.query("UPDATE identity.users SET status = 'suspended' WHERE id = $1", [staffUser]);
    expect(await repository.listRoster(org)).toEqual([
      expect.objectContaining({ id: staffMembership, status: "deactivated" }),
    ]);

    await client.query(
      `UPDATE identity.organization_memberships
       SET status = 'inactive', property_access_mode = 'assigned' WHERE id = $1`,
      [staffMembership],
    );
    await client.query(
      `UPDATE identity.organization_resource_links SET status = 'suspended'
       WHERE organization_id = $1 AND resource_id = $2`,
      [org, property],
    );
    expect(await repository.listRoster(org)).toEqual([]);
  });

  it("atomically updates, audits, and replays staff access", async () => {
    const edit = updateCommand();
    await expect(repository.updateAccess(edit)).resolves.toEqual({
      outcome: "updated",
      membershipId: staffMembership,
    });
    await client.query(
      "UPDATE identity.organization_resource_links SET status = 'suspended' WHERE organization_id = $1 AND resource_id = $2",
      [org, property],
    );
    await expect(repository.updateAccess({ ...edit, commandId: randomUUID() })).resolves.toEqual({
      outcome: "idempotent_replay",
      membershipId: staffMembership,
    });
    await client.query(
      "UPDATE identity.organization_resource_links SET status = 'active' WHERE organization_id = $1 AND resource_id = $2",
      [org, property],
    );
    await expect(
      repository.updateAccess({
        ...edit,
        commandId: randomUUID(),
        payload: { ...edit.payload, roleKey: "housekeeping" },
      }),
    ).resolves.toEqual({ outcome: "rejected", reason: "idempotency_conflict" });
    const stored = await client.query(
      `SELECT membership.role_key, membership.permission_overrides, membership.property_access_mode,
              ARRAY(SELECT property_id::text FROM identity.membership_property_assignments
                    WHERE membership_id = membership.id ORDER BY property_id) AS properties
       FROM identity.organization_memberships membership WHERE membership.id = $1`,
      [staffMembership],
    );
    expect(stored.rows[0]).toMatchObject({
      role_key: "front_desk",
      permission_overrides: { grant: [], deny: ["booking.analytics.read"] },
      property_access_mode: "assigned",
      properties: [property],
    });
    const audit = await client.query(
      `SELECT action, actor_user_id::text, target_resource_id, occurred_at, redacted_payload, audit_metadata
       FROM platform.product_audit_events WHERE product = 'identity' AND causation_id = $1`,
      [edit.commandId],
    );
    expect(audit.rows[0]).toMatchObject({
      action: "identity.staff.access.updated",
      actor_user_id: owner,
      target_resource_id: staffMembership,
      redacted_payload: { outcome: "updated", roleKey: "front_desk", propertyCount: 1 },
      audit_metadata: {
        requestedAt: edit.audit.requestedAt,
        actorNameSnapshot: "Owner Example",
      },
    });
    expect(audit.rows[0].occurred_at.toISOString()).not.toBe(edit.audit.requestedAt);
  });

  it("schedules one Inbox assignment reconciliation when property access is removed", async () => {
    await client.query(
      `INSERT INTO identity.membership_property_assignments (membership_id, property_id)
       VALUES ($1, $2), ($1, $3)`,
      [staffMembership, property, secondProperty],
    );
    const edit = updateCommand({ propertyIds: [property] });
    await expect(repository.updateAccess(edit)).resolves.toEqual({
      outcome: "updated",
      membershipId: staffMembership,
    });
    await expect(repository.updateAccess({ ...edit, commandId: randomUUID() })).resolves.toEqual({
      outcome: "idempotent_replay",
      membershipId: staffMembership,
    });

    const jobs = await client.query(
      `SELECT queue_name, job_type, tenant_scope, organization_id::text, resource_product,
              resource_type, resource_id, payload, job_metadata
       FROM platform.jobs
       WHERE job_type = 'pms.inbox.assignment.reconcile'
         AND job_metadata ->> 'commandId' = $1`,
      [edit.commandId],
    );
    expect(jobs.rows).toEqual([
      expect.objectContaining({
        queue_name: "pms-inbox",
        job_type: "pms.inbox.assignment.reconcile",
        tenant_scope: "organization",
        organization_id: org,
        resource_product: "pms",
        resource_type: "inbox_assignment",
        resource_id: staffMembership,
        payload: { membershipId: staffMembership },
        job_metadata: expect.objectContaining({
          commandId: edit.commandId,
          reason: "property_access_removed",
        }),
      }),
    ]);
  });

  it("fails closed for unauthorized, owner, cross-tenant, and foreign-property updates", async () => {
    await expect(
      repository.updateAccess(updateCommand({ actorUserId: otherUser })),
    ).resolves.toEqual({ outcome: "rejected", reason: "inviter_not_authorized" });
    await expect(
      repository.updateAccess(updateCommand({ membershipId: membership })),
    ).resolves.toEqual({ outcome: "rejected", reason: "target_not_found" });
    await client.query(
      "UPDATE identity.organization_memberships SET role_key = 'front_desk' WHERE id = $1",
      [otherMembership],
    );
    await expect(
      repository.updateAccess(
        updateCommand({
          membershipId: otherMembership,
        }),
      ),
    ).resolves.toEqual({ outcome: "rejected", reason: "target_not_found" });
    await expect(
      repository.updateAccess(updateCommand({ propertyIds: [foreignProperty] })),
    ).resolves.toEqual({ outcome: "rejected", reason: "property_scope_invalid" });
    expect(
      (
        await client.query("SELECT role_key FROM identity.organization_memberships WHERE id = $1", [
          staffMembership,
        ])
      ).rows[0]?.role_key,
    ).toBe("housekeeping");
  });

  it("deactivates, audits, replays, and reactivates staff without losing access settings", async () => {
    await client.query(
      "INSERT INTO identity.membership_property_assignments (membership_id, property_id) VALUES ($1, $2)",
      [staffMembership, property],
    );
    const deactivate = statusCommand();
    await expect(repository.updateStatus(deactivate)).resolves.toEqual({
      outcome: "updated",
      membershipId: staffMembership,
      membershipStatus: "suspended",
    });
    await expect(
      repository.updateStatus({ ...deactivate, commandId: randomUUID() }),
    ).resolves.toEqual({
      outcome: "idempotent_replay",
      membershipId: staffMembership,
      membershipStatus: "suspended",
    });
    await expect(
      repository.updateStatus({
        ...deactivate,
        commandId: randomUUID(),
        payload: { ...deactivate.payload, membershipStatus: "active" },
      }),
    ).resolves.toEqual({ outcome: "rejected", reason: "idempotency_conflict" });
    const stored = await client.query(
      `SELECT membership.status, membership.role_key, membership.permission_overrides,
              ARRAY(SELECT property_id::text FROM identity.membership_property_assignments
                    WHERE membership_id = membership.id ORDER BY property_id) AS properties
       FROM identity.organization_memberships membership WHERE membership.id = $1`,
      [staffMembership],
    );
    expect(stored.rows[0]).toMatchObject({
      status: "suspended",
      role_key: "housekeeping",
      permission_overrides: null,
      properties: [property],
    });
    expect((await repository.listRoster(org))[0]?.status).toBe("deactivated");
    const audit = await client.query(
      `SELECT action, actor_user_id::text, target_resource_id, redacted_payload, private_payload
       FROM platform.product_audit_events WHERE product = 'identity' AND causation_id = $1`,
      [deactivate.commandId],
    );
    expect(audit.rows[0]).toMatchObject({
      action: "identity.staff.status.updated",
      actor_user_id: owner,
      target_resource_id: staffMembership,
      redacted_payload: { outcome: "updated", membershipStatus: "suspended" },
      private_payload: {
        targetUserId: staffUser,
        previous: { membershipStatus: "active" },
        next: { membershipStatus: "suspended" },
      },
    });
    await expect(
      repository.updateStatus(statusCommand({ membershipStatus: "active" })),
    ).resolves.toMatchObject({ outcome: "updated", membershipStatus: "active" });
    expect((await repository.listRoster(org))[0]?.status).toBe("active");
  });

  it("hides unauthorized, owner, removed, cross-tenant, and globally suspended targets", async () => {
    await expect(
      repository.updateStatus(statusCommand({ actorUserId: otherUser })),
    ).resolves.toEqual({ outcome: "rejected", reason: "inviter_not_authorized" });
    await expect(
      repository.updateStatus(statusCommand({ membershipId: membership })),
    ).resolves.toEqual({ outcome: "rejected", reason: "target_not_found" });
    await client.query(
      "UPDATE identity.organization_memberships SET role_key = 'front_desk' WHERE id = $1",
      [otherMembership],
    );
    await expect(
      repository.updateStatus(statusCommand({ membershipId: otherMembership })),
    ).resolves.toEqual({ outcome: "rejected", reason: "target_not_found" });
    await client.query(
      "UPDATE identity.organization_memberships SET status = 'inactive' WHERE id = $1",
      [staffMembership],
    );
    await expect(repository.updateStatus(statusCommand())).resolves.toEqual({
      outcome: "rejected",
      reason: "target_not_found",
    });
    await client.query(
      "UPDATE identity.organization_memberships SET status = 'active' WHERE id = $1",
      [staffMembership],
    );
    await client.query("UPDATE identity.users SET status = 'suspended' WHERE id = $1", [staffUser]);
    await expect(repository.updateStatus(statusCommand())).resolves.toEqual({
      outcome: "rejected",
      reason: "target_not_found",
    });
  });

  it("removes only the selected tenant membership and durably schedules provider revocation", async () => {
    const otherStaffMembership = randomUUID();
    await client.query(
      `INSERT INTO identity.organization_memberships
         (id, organization_id, user_id, status, role_key, property_access_mode, access_origin)
       VALUES ($1, $2, $3, 'active', 'front_desk', 'assigned', 'agency')`,
      [otherStaffMembership, otherOrg, staffUser],
    );
    await client.query(
      "INSERT INTO identity.membership_property_assignments (membership_id, property_id) VALUES ($1, $2)",
      [staffMembership, property],
    );
    await client.query(
      "UPDATE identity.organization_memberships SET status = 'suspended' WHERE id = $1",
      [staffMembership],
    );
    const command = removalCommand();
    const removed = await repository.remove(command);
    expect(removed).toMatchObject({ outcome: "removed", membershipId: staffMembership });
    if (removed.outcome !== "removed") throw new Error("expected staff removal");
    await expect(repository.remove({ ...command, commandId: randomUUID() })).resolves.toEqual({
      outcome: "idempotent_replay",
      membershipId: staffMembership,
      providerRevocationJobId: removed.providerRevocationJobId,
    });

    const stored = await client.query(
      `SELECT membership.status, membership.role_key, membership.permission_overrides,
              staff.status AS user_status,
              ARRAY(SELECT property_id::text FROM identity.membership_property_assignments
                    WHERE membership_id = membership.id ORDER BY property_id) AS properties,
              (SELECT status FROM identity.organization_memberships WHERE id = $2) AS other_status
       FROM identity.organization_memberships membership
       JOIN identity.users staff ON staff.id = membership.user_id
       WHERE membership.id = $1`,
      [staffMembership, otherStaffMembership],
    );
    expect(stored.rows[0]).toMatchObject({
      status: "inactive",
      role_key: "housekeeping",
      permission_overrides: null,
      user_status: "active",
      properties: [property],
      other_status: "active",
    });
    expect(await repository.listRoster(org)).toEqual([]);
    await expect(repository.updateAccess(updateCommand())).resolves.toEqual({
      outcome: "rejected",
      reason: "target_not_found",
    });

    const job = await client.query(
      `SELECT status, queue_name, job_type, organization_id::text, resource_id, payload
       FROM platform.jobs WHERE id = $1`,
      [removed.providerRevocationJobId],
    );
    expect(job.rows[0]).toMatchObject({
      status: "pending",
      queue_name: "identity-provider",
      job_type: "workos.organization-membership.delete",
      organization_id: org,
      resource_id: staffMembership,
      payload: {
        workosMembershipId: "om_staff_acceptance",
        expectedWorkosOrganizationId: "org_staff_delivery",
        expectedWorkosUserId: "user_staff_acceptance",
      },
    });
    const audit = await client.query(
      `SELECT action, actor_user_id::text, target_resource_id, job_id::text,
              redacted_payload, private_payload
       FROM platform.product_audit_events WHERE causation_id = $1`,
      [command.commandId],
    );
    expect(audit.rows[0]).toMatchObject({
      action: "identity.staff.removed",
      actor_user_id: owner,
      target_resource_id: staffMembership,
      job_id: removed.providerRevocationJobId,
      redacted_payload: { outcome: "access_revoked", providerRevocation: "pending" },
      private_payload: {
        targetUserId: staffUser,
        previous: { membershipStatus: "suspended" },
        next: { membershipStatus: "inactive" },
      },
    });
  });

  it("fails closed for unauthorized, owner, cross-tenant, removed, and invalid removal targets", async () => {
    await expect(repository.remove(removalCommand({ actorUserId: otherUser }))).resolves.toEqual({
      outcome: "rejected",
      reason: "inviter_not_authorized",
    });
    await expect(repository.remove(removalCommand({ membershipId: membership }))).resolves.toEqual({
      outcome: "rejected",
      reason: "target_not_found",
    });
    await client.query(
      "UPDATE identity.organization_memberships SET role_key = 'front_desk' WHERE id = $1",
      [otherMembership],
    );
    await expect(
      repository.remove(removalCommand({ membershipId: otherMembership })),
    ).resolves.toEqual({ outcome: "rejected", reason: "target_not_found" });
    await client.query(
      "UPDATE identity.organization_memberships SET status = 'inactive' WHERE id = $1",
      [staffMembership],
    );
    await expect(repository.remove(removalCommand())).resolves.toEqual({
      outcome: "rejected",
      reason: "target_not_found",
    });
    await expect(
      repository.remove(removalCommand({ membershipId: "not-a-membership" })),
    ).resolves.toEqual({ outcome: "rejected", reason: "invalid_command" });
  });

  it("fences stale removal workers with a unique claim token", async () => {
    const removed = await repository.remove(removalCommand());
    if (removed.outcome !== "removed") throw new Error("expected staff removal");
    const first = await removalJobRepository.claim(removed.providerRevocationJobId);
    if (first.outcome !== "claimed") throw new Error("expected first claim");
    await client.query(
      "UPDATE platform.jobs SET locked_at = now() - interval '6 minutes' WHERE id = $1",
      [removed.providerRevocationJobId],
    );
    const second = await removalJobRepository.claim(removed.providerRevocationJobId);
    if (second.outcome !== "claimed") throw new Error("expected reclaimed job");
    expect(second.leaseToken).not.toBe(first.leaseToken);
    await expect(
      removalJobRepository.markSucceeded(
        removed.providerRevocationJobId,
        first.leaseToken,
        "deleted",
      ),
    ).resolves.toBe(false);
    await expect(
      removalJobRepository.markSucceeded(
        removed.providerRevocationJobId,
        second.leaseToken,
        "deleted",
      ),
    ).resolves.toBe(true);
  });

  it("dead-letters a stale final-attempt removal claim", async () => {
    const removed = await repository.remove(removalCommand());
    if (removed.outcome !== "removed") throw new Error("expected staff removal");
    await client.query(
      `UPDATE platform.jobs SET status = 'running', attempts_count = max_attempts,
         locked_at = now() - interval '6 minutes', locked_by = 'stale-worker' WHERE id = $1`,
      [removed.providerRevocationJobId],
    );
    await expect(removalJobRepository.claim(removed.providerRevocationJobId)).resolves.toEqual({
      outcome: "dead_lettered",
      jobId: removed.providerRevocationJobId,
    });
    expect(
      (
        await client.query("SELECT status, job_metadata FROM platform.jobs WHERE id = $1", [
          removed.providerRevocationJobId,
        ])
      ).rows[0],
    ).toMatchObject({
      status: "dead_lettered",
      job_metadata: { failureCode: "worker_lease_expired" },
    });
  });

  it("returns transient removal failures to the retry queue", async () => {
    const removed = await repository.remove(removalCommand());
    if (removed.outcome !== "removed") throw new Error("expected staff removal");
    const claim = await removalJobRepository.claim(removed.providerRevocationJobId);
    if (claim.outcome !== "claimed") throw new Error("expected removal claim");
    await expect(
      removalJobRepository.markRetryableFailure(removed.providerRevocationJobId, claim.leaseToken),
    ).resolves.toBe("pending");
  });

  it("lists only due or stale staff removal jobs", async () => {
    await client.query(
      `UPDATE platform.jobs
       SET status = 'succeeded', finished_at = now(), locked_at = NULL, locked_by = NULL
       WHERE queue_name = 'identity-provider'
         AND job_type = 'workos.organization-membership.delete'
         AND status IN ('pending', 'running')`,
    );
    const removed = await repository.remove(removalCommand());
    if (removed.outcome !== "removed") throw new Error("expected staff removal");
    await client.query(
      "UPDATE platform.jobs SET run_after = now() + interval '1 hour' WHERE id = $1",
      [removed.providerRevocationJobId],
    );
    await expect(removalJobRepository.listDueJobIds()).resolves.toEqual([]);

    await client.query(
      "UPDATE platform.jobs SET run_after = now() - interval '1 second' WHERE id = $1",
      [removed.providerRevocationJobId],
    );
    await expect(removalJobRepository.listDueJobIds()).resolves.toEqual([
      removed.providerRevocationJobId,
    ]);
    const claim = await removalJobRepository.claim(removed.providerRevocationJobId);
    if (claim.outcome !== "claimed") throw new Error("expected removal claim");
    await client.query(
      "UPDATE platform.jobs SET locked_at = now() - interval '6 minutes' WHERE id = $1",
      [removed.providerRevocationJobId],
    );
    await expect(removalJobRepository.listDueJobIds()).resolves.toEqual([
      removed.providerRevocationJobId,
    ]);
    await removalJobRepository.markSucceeded(
      removed.providerRevocationJobId,
      claim.leaseToken,
      "deleted",
    );
    await expect(removalJobRepository.listDueJobIds()).resolves.toEqual([]);
  });

  it("deletes only the expected provider membership and replays safely", async () => {
    const removed = await repository.remove(removalCommand());
    if (removed.outcome !== "removed") throw new Error("expected staff removal");
    const provider: StaffRemovalProvider = {
      getMembership: vi.fn(async (id) => ({
        id,
        organizationId: "org_staff_delivery",
        userId: "user_staff_acceptance",
      })),
      deleteMembership: vi.fn(async () => "deleted" as const),
    };
    const coordinator = createStaffRemovalCoordinator({
      repository: removalJobRepository,
      provider,
    });

    await expect(coordinator.revoke(removed.providerRevocationJobId)).resolves.toEqual({
      outcome: "revoked",
      jobId: removed.providerRevocationJobId,
    });
    await expect(coordinator.revoke(removed.providerRevocationJobId)).resolves.toEqual({
      outcome: "revoked",
      jobId: removed.providerRevocationJobId,
    });
    expect(provider.deleteMembership).toHaveBeenCalledTimes(1);
  });

  it("converges when the provider membership is already absent", async () => {
    const removed = await repository.remove(removalCommand());
    if (removed.outcome !== "removed") throw new Error("expected staff removal");
    const provider: StaffRemovalProvider = {
      getMembership: vi.fn(async () => null),
      deleteMembership: vi.fn(async () => "deleted" as const),
    };

    await expect(
      createStaffRemovalCoordinator({ repository: removalJobRepository, provider }).revoke(
        removed.providerRevocationJobId,
      ),
    ).resolves.toMatchObject({ outcome: "revoked" });
    expect(provider.deleteMembership).not.toHaveBeenCalled();
  });

  it("dead-letters missing or mismatched provider bindings without deleting", async () => {
    await client.query(
      "UPDATE identity.external_identities SET provider_user_id = NULL WHERE id = $1",
      [staffIdentity],
    );
    const missing = await repository.remove(removalCommand());
    if (missing.outcome !== "removed") throw new Error("expected staff removal");
    const provider: StaffRemovalProvider = {
      getMembership: vi.fn(async (id) => ({
        id,
        organizationId: "org_other",
        userId: "user_other",
      })),
      deleteMembership: vi.fn(async () => "deleted" as const),
    };
    const coordinator = createStaffRemovalCoordinator({
      repository: removalJobRepository,
      provider,
    });
    await expect(coordinator.revoke(missing.providerRevocationJobId)).resolves.toMatchObject({
      outcome: "reconciliation_required",
    });
    expect(provider.getMembership).not.toHaveBeenCalled();

    await client.query(
      "UPDATE identity.organization_memberships SET status = 'active' WHERE id = $1",
      [staffMembership],
    );
    await client.query(
      "UPDATE identity.external_identities SET provider_user_id = 'user_staff_acceptance' WHERE id = $1",
      [staffIdentity],
    );
    const mismatched = await repository.remove(removalCommand());
    if (mismatched.outcome !== "removed") throw new Error("expected staff removal");
    await expect(coordinator.revoke(mismatched.providerRevocationJobId)).resolves.toMatchObject({
      outcome: "reconciliation_required",
    });
    expect(provider.getMembership).toHaveBeenCalledTimes(1);
    expect(provider.deleteMembership).not.toHaveBeenCalled();
  });

  it("keeps provider failures retryable", async () => {
    const removed = await repository.remove(removalCommand());
    if (removed.outcome !== "removed") throw new Error("expected staff removal");
    const provider: StaffRemovalProvider = {
      getMembership: vi.fn().mockRejectedValueOnce(new Error("provider unavailable")),
      deleteMembership: vi.fn(async () => "deleted" as const),
    };

    await expect(
      createStaffRemovalCoordinator({ repository: removalJobRepository, provider }).revoke(
        removed.providerRevocationJobId,
      ),
    ).resolves.toMatchObject({ outcome: "pending" });
  });

  it("converges when provider deletion races with another worker", async () => {
    const removed = await repository.remove(removalCommand());
    if (removed.outcome !== "removed") throw new Error("expected staff removal");
    const provider: StaffRemovalProvider = {
      getMembership: vi.fn(async (id) => ({
        id,
        organizationId: "org_staff_delivery",
        userId: "user_staff_acceptance",
      })),
      deleteMembership: vi.fn(async () => "already_absent" as const),
    };

    await expect(
      createStaffRemovalCoordinator({ repository: removalJobRepository, provider }).revoke(
        removed.providerRevocationJobId,
      ),
    ).resolves.toMatchObject({ outcome: "revoked" });
    expect(
      (
        await client.query("SELECT job_metadata FROM platform.jobs WHERE id = $1", [
          removed.providerRevocationJobId,
        ])
      ).rows[0],
    ).toMatchObject({ job_metadata: { providerOutcome: "already_absent" } });
  });

  it("persists, normalizes, and replays one intent", async () => {
    const created = await repository.persist(command());
    if (created.outcome !== "created") throw new Error("expected invitation creation");
    await expect(repository.persist(command({ commandId: "retry" }))).resolves.toEqual({
      outcome: "idempotent_replay",
      invitationId: created.invitationId,
    });
    await expectRejection(repository, command({ roleKey: "housekeeping" }), "idempotency_conflict");
    await expectRejection(
      repository,
      command({ commandId: "other", idempotencyKey: "other" }),
      "configuration_conflict",
    );
    const row = await client.query(
      `SELECT invitation.email, invitation.provider_invitation_id,
              count(assignment.property_id)::int AS properties
       FROM identity.staff_invitations invitation
       LEFT JOIN identity.staff_invitation_property_assignments assignment ON assignment.invitation_id = invitation.id
       GROUP BY invitation.id`,
    );
    expect(row.rows[0]).toMatchObject({
      email: "staff@example.com",
      provider_invitation_id: null,
      properties: 1,
    });
  });

  it("rolls back invalid replacement and serializes concurrent replacements", async () => {
    expect((await repository.persist(command())).outcome).toBe("created");
    await expectRejection(
      repository,
      command({
        commandId: "bad",
        idempotencyKey: "bad",
        revision: 2,
        propertyIds: [foreignProperty],
      }),
      "property_scope_invalid",
    );
    expect((await client.query("SELECT status FROM identity.staff_invitations")).rows).toEqual([
      { status: "pending" },
    ]);

    const race = await Promise.all(
      [1, 2].map((revision) =>
        repository.persist(
          command({
            commandId: `race-${revision}`,
            idempotencyKey: `race-${revision}`,
            email: "race@example.com",
            revision,
          }),
        ),
      ),
    );
    expect(race.map(({ outcome }) => outcome)).toEqual(["created", "created"]);
    const states = await client.query<{ pending: number; total: number }>(
      `SELECT count(*) FILTER (WHERE status = 'pending')::int AS pending, count(*)::int AS total
       FROM identity.staff_invitations WHERE email = 'race@example.com'`,
    );
    expect(states.rows).toEqual([{ pending: 1, total: 2 }]);
  });

  it("serializes a globally repeated idempotency key across organizations", async () => {
    const results = await Promise.all([
      repository.persist(command({ email: "global@example.com" })),
      repository.persist(
        command({
          commandId: "other-command",
          organizationId: otherOrg,
          actorUserId: otherUser,
          propertyIds: [foreignProperty],
          email: "global@example.com",
        }),
      ),
    ]);
    expect(results.map((result) => result.outcome).sort()).toEqual(["created", "rejected"]);
    expect(results.find((result) => result.outcome === "rejected")).toMatchObject({
      reason: "idempotency_conflict",
    });
  });

  it("claims once and atomically records a matching provider invitation", async () => {
    const created = await repository.persist(command({ roleKey: "hotel_manager" }));
    if (created.outcome !== "created") throw new Error("expected invitation creation");
    const sendInvitation = vi.fn(async (claim: StaffInvitationDeliveryClaim) =>
      providerResponse(claim, { invitationId: ` invitation_${claim.invitationId} ` }),
    );
    const coordinator = createStaffInvitationDeliveryCoordinator({
      repository: deliveryRepository,
      provider: { sendInvitation },
    });

    const outcomes = await Promise.all([
      coordinator.deliver(created.invitationId),
      coordinator.deliver(created.invitationId),
    ]);
    expect(outcomes.map(({ outcome }) => outcome).sort()).toEqual(["delivered", "not_ready"]);
    expect(outcomes).toContainEqual({
      outcome: "delivered",
      invitationId: created.invitationId,
      providerInvitationId: `invitation_${created.invitationId}`,
    });
    expect(sendInvitation).toHaveBeenCalledOnce();
    expect(sendInvitation).toHaveBeenCalledWith(
      expect.objectContaining({
        organizationId: "org_staff_delivery",
        inviterUserId: "user_staff_delivery",
        roleSlug: "hotel_admin",
        expiresInDays: 7,
      }),
    );
    expect(
      (
        await client.query(
          `SELECT delivery_state, provider_invitation_id FROM identity.staff_invitations WHERE id = $1`,
          [created.invitationId],
        )
      ).rows,
    ).toEqual([
      {
        delivery_state: "delivered",
        provider_invitation_id: `invitation_${created.invitationId}`,
      },
    ]);
  });

  it("quarantines provider failures and mismatched responses without retrying", async () => {
    const failed = await repository.persist(command());
    if (failed.outcome !== "created") throw new Error("expected invitation creation");
    const sendInvitation = vi
      .fn<StaffInvitationProvider["sendInvitation"]>()
      .mockRejectedValue(new Error("ambiguous provider failure"));
    const coordinator = createStaffInvitationDeliveryCoordinator({
      repository: deliveryRepository,
      provider: { sendInvitation },
    });

    await expect(coordinator.deliver(failed.invitationId)).resolves.toMatchObject({
      outcome: "unknown",
    });
    await expect(coordinator.deliver(failed.invitationId)).resolves.toMatchObject({
      outcome: "not_ready",
    });
    expect(sendInvitation).toHaveBeenCalledOnce();

    const mismatch = await repository.persist(
      command({ commandId: "mismatch", idempotencyKey: "mismatch", email: "mismatch@example.com" }),
    );
    if (mismatch.outcome !== "created") throw new Error("expected invitation creation");
    sendInvitation.mockReset();
    sendInvitation.mockImplementation(async (claim) =>
      providerResponse(claim, { organizationId: "org_foreign" }),
    );
    await expect(coordinator.deliver(mismatch.invitationId)).resolves.toMatchObject({
      outcome: "unknown",
    });
  });

  it("does not claim revoked, inactive, or ambiguous identity context", async () => {
    const created = await repository.persist(command());
    if (created.outcome !== "created") throw new Error("expected invitation creation");
    const provider = { sendInvitation: vi.fn<StaffInvitationProvider["sendInvitation"]>() };
    const coordinator = createStaffInvitationDeliveryCoordinator({
      repository: deliveryRepository,
      provider,
    });
    await client.query("UPDATE identity.staff_invitations SET status = 'revoked' WHERE id = $1", [
      created.invitationId,
    ]);
    await expect(coordinator.deliver(created.invitationId)).resolves.toMatchObject({
      outcome: "not_ready",
    });

    const inactive = await repository.persist(
      command({ commandId: "inactive", idempotencyKey: "inactive", email: "inactive@example.com" }),
    );
    if (inactive.outcome !== "created") throw new Error("expected invitation creation");
    await client.query(
      "UPDATE identity.organization_memberships SET status = 'suspended' WHERE id = $1",
      [membership],
    );
    await expect(coordinator.deliver(inactive.invitationId)).resolves.toMatchObject({
      outcome: "not_ready",
    });

    await client.query(
      "UPDATE identity.organization_memberships SET status = 'active' WHERE id = $1",
      [membership],
    );
    await client.query(
      `INSERT INTO identity.external_identities
         (id, user_id, provider, provider_user_id, provider_email_verified)
       VALUES ($1, $2, 'workos', 'user_staff_ambiguous', true)`,
      [ambiguousIdentity, owner],
    );
    await expect(coordinator.deliver(inactive.invitationId)).resolves.toMatchObject({
      outcome: "not_ready",
    });
    await client.query("DELETE FROM identity.external_identities WHERE id = $1", [
      ambiguousIdentity,
    ]);
    await client.query(
      "UPDATE identity.organization_memberships SET workos_membership_id = NULL WHERE id = $1",
      [membership],
    );
    await expect(coordinator.deliver(inactive.invitationId)).resolves.toMatchObject({
      outcome: "not_ready",
    });
    expect(provider.sendInvitation).not.toHaveBeenCalled();
  });

  async function deliveredInvitation(revision = 1) {
    const created = await repository.persist(
      command({
        commandId: `accept-command-${revision}`,
        idempotencyKey: `accept-key-${revision}`,
        revision,
      }),
    );
    if (created.outcome !== "created") throw new Error("expected invitation creation");
    const providerInvitationId = `invitation_${created.invitationId}`;
    await client.query(
      `UPDATE identity.staff_invitations
       SET delivery_state = 'delivered', delivery_attempted_at = now(),
           provider_invitation_id = $2, expires_at = now() + interval '7 days'
       WHERE id = $1`,
      [created.invitationId, providerInvitationId],
    );
    return { ...created, providerInvitationId };
  }

  async function expectAcceptance(
    invitation: Awaited<ReturnType<typeof deliveredInvitation>>,
    expected: object,
    patch: Partial<StaffInvitationAcceptanceEvent> = {},
  ) {
    expect(
      await acceptanceRepository.reconcile(acceptanceEvent(invitation.providerInvitationId, patch)),
    ).toMatchObject(expected);
  }

  it("atomically replaces staff access and leaves later edits intact on replay", async () => {
    await client.query(
      `INSERT INTO identity.membership_property_assignments (membership_id, property_id) VALUES ($1, $2)`,
      [staffMembership, secondProperty],
    );
    const invitation = await deliveredInvitation();
    expect(
      (
        await Promise.all([
          acceptanceRepository.reconcile(acceptanceEvent(invitation.providerInvitationId)),
          acceptanceRepository.reconcile(acceptanceEvent(invitation.providerInvitationId)),
        ])
      )
        .map(({ outcome }) => outcome)
        .sort(),
    ).toEqual(["accepted", "idempotent_replay"]);
    expect(
      (
        await client.query(
          `SELECT membership.status, membership.role_key, membership.permission_overrides,
              membership.property_access_mode, membership.access_origin,
              membership.workos_membership_id, membership.invited_at,
              ARRAY(SELECT property_id::text FROM identity.membership_property_assignments
                    WHERE membership_id = membership.id ORDER BY property_id) AS properties
       FROM identity.organization_memberships membership WHERE membership.id = $1`,
          [staffMembership],
        )
      ).rows[0],
    ).toMatchObject({
      status: "active",
      role_key: "front_desk",
      permission_overrides: { grant: [], deny: ["booking.analytics.read"] },
      property_access_mode: "assigned",
      access_origin: "agency",
      workos_membership_id: "om_staff_acceptance",
      invited_at: expect.any(Date),
      properties: [property],
    });
    await client.query(
      "UPDATE identity.organization_memberships SET role_key = 'housekeeping' WHERE id = $1",
      [staffMembership],
    );
    await expectAcceptance(invitation, {
      outcome: "idempotent_replay",
      membershipId: staffMembership,
    });
    expect(
      (
        await client.query("SELECT role_key FROM identity.organization_memberships WHERE id = $1", [
          staffMembership,
        ])
      ).rows[0]?.role_key,
    ).toBe("housekeeping");
  });

  it("fails closed across provider, identity, membership, expiry, and access denials", async () => {
    const invitation = await deliveredInvitation();
    await expectAcceptance(
      invitation,
      { outcome: "rejected", reason: "provider_context_mismatch" },
      { providerEventId: "event_wrong_org", providerOrganizationId: "org_other" },
    );
    await client.query("DELETE FROM identity.external_identities WHERE id = $1", [staffIdentity]);
    await expectAcceptance(
      invitation,
      { outcome: "deferred", reason: "identity_not_found" },
      { providerEventId: "event_missing_user" },
    );
    await client.query(
      `INSERT INTO identity.external_identities
         (id, user_id, provider, provider_user_id, provider_email, provider_email_verified)
       VALUES ($1, $2, 'workos', 'user_staff_acceptance', 'staff@example.com', true)`,
      [staffIdentity, staffUser],
    );
    await client.query(
      "UPDATE identity.external_identities SET provider_email_verified = false WHERE id = $1",
      [staffIdentity],
    );
    await expectAcceptance(
      invitation,
      { outcome: "rejected", reason: "provider_identity_mismatch" },
      { providerEventId: "event_unverified_email" },
    );
    await client.query(
      "UPDATE identity.external_identities SET provider_email_verified = true WHERE id = $1",
      [staffIdentity],
    );
    await client.query("UPDATE identity.users SET status = 'suspended' WHERE id = $1", [staffUser]);
    await expectAcceptance(
      invitation,
      { outcome: "rejected", reason: "user_inactive" },
      { providerEventId: "event_inactive_user" },
    );
    await client.query("UPDATE identity.users SET status = 'active' WHERE id = $1", [staffUser]);
    await client.query(
      "UPDATE identity.organization_memberships SET status = 'suspended' WHERE id = $1",
      [staffMembership],
    );
    await expectAcceptance(
      invitation,
      { outcome: "rejected", reason: "membership_protected" },
      { providerEventId: "event_suspended" },
    );
    await client.query("BEGIN");
    await client.query(
      "UPDATE identity.organization_memberships SET role_key = 'external_owner', property_access_mode = 'assigned' WHERE id = $1",
      [membership],
    );
    await client.query(
      "UPDATE identity.organization_memberships SET status = 'active', access_origin = 'external_owner' WHERE id = $1",
      [staffMembership],
    );
    await client.query(
      `INSERT INTO identity.membership_delegations
         (organization_id, subject_membership_id, delegator_membership_id, created_by_membership_id)
       VALUES ($1, $2, $3, $3)`,
      [org, staffMembership, membership],
    );
    await client.query("COMMIT");
    await expectAcceptance(
      invitation,
      { outcome: "rejected", reason: "membership_protected" },
      { providerEventId: "event_external_owner_origin" },
    );
    await client.query("BEGIN");
    await client.query(
      "DELETE FROM identity.membership_delegations WHERE subject_membership_id = $1",
      [staffMembership],
    );
    await client.query(
      "UPDATE identity.organization_memberships SET access_origin = 'agency' WHERE id = $1",
      [staffMembership],
    );
    await client.query(
      "UPDATE identity.organization_memberships SET role_key = 'hotel_owner', property_access_mode = 'all' WHERE id = $1",
      [membership],
    );
    await client.query("COMMIT");
    await client.query(
      "UPDATE identity.organization_memberships SET status = 'active', role_key = 'hotel_owner' WHERE id = $1",
      [staffMembership],
    );
    await expectAcceptance(
      invitation,
      { outcome: "rejected", reason: "membership_protected" },
      { providerEventId: "event_owner" },
    );
    await client.query(
      "UPDATE identity.organization_memberships SET role_key = 'housekeeping' WHERE id = $1",
      [staffMembership],
    );
    await client.query("UPDATE identity.organizations SET status = 'suspended' WHERE id = $1", [
      org,
    ]);
    await expectAcceptance(
      invitation,
      { outcome: "rejected", reason: "organization_inactive" },
      { providerEventId: "event_inactive_org" },
    );
    await client.query("UPDATE identity.organizations SET status = 'active' WHERE id = $1", [org]);
    await client.query(
      "UPDATE identity.staff_invitations SET expires_at = now() - interval '1 minute' WHERE id = $1",
      [invitation.invitationId],
    );
    await expectAcceptance(
      invitation,
      { outcome: "rejected", reason: "invitation_expired" },
      { providerEventId: "event_expired" },
    );
    expect(
      (
        await client.query("SELECT status FROM identity.staff_invitations WHERE id = $1", [
          invitation.invitationId,
        ])
      ).rows[0]?.status,
    ).toBe("expired");

    const revoked = await deliveredInvitation(2);
    await client.query("UPDATE identity.staff_invitations SET status = 'revoked' WHERE id = $1", [
      revoked.invitationId,
    ]);
    await expectAcceptance(revoked, {
      outcome: "rejected",
      reason: "invitation_not_current",
    });

    const invalid = await deliveredInvitation(3);
    await client.query(
      `UPDATE identity.staff_invitations SET permission_overrides = '{"grant":["unknown"],"deny":[]}' WHERE id = $1`,
      [invalid.invitationId],
    );
    await expectAcceptance(invalid, { outcome: "rejected", reason: "invitation_access_invalid" });
    await client.query(
      `UPDATE identity.staff_invitations
       SET permission_overrides = '{"grant":[],"deny":["booking.analytics.read"]}' WHERE id = $1`,
      [invalid.invitationId],
    );
    await client.query(
      `UPDATE identity.organization_resource_links SET status = 'suspended'
      WHERE organization_id = $1 AND resource_id = $2`,
      [org, property],
    );
    await expectAcceptance(
      invalid,
      { outcome: "rejected", reason: "invitation_access_invalid" },
      { providerEventId: "event_unlinked_property" },
    );
  });

  it("rejects malformed provider fields without throwing", async () => {
    await expect(
      acceptanceRepository.reconcile({
        ...acceptanceEvent("malformed"),
        providerUserId: undefined,
      } as unknown as StaffInvitationAcceptanceEvent),
    ).resolves.toEqual({ outcome: "rejected", reason: "invalid_event" });
  });
});
