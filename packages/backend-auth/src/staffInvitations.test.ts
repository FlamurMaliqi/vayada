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
import type { CreateStaffInviteCommand, UpdateStaffAccessCommand } from "./lifecycle.js";

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
          property_access_mode = 'assigned', workos_membership_id = 'om_staff_acceptance'
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

  it("lists active, pending, and deactivated staff without crossing tenant scope", async () => {
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
    expect((await repository.listRoster(org))[0]).toMatchObject({
      id: staffMembership,
      status: "deactivated",
      propertyIds: [],
    });
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
              membership.workos_membership_id,
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
