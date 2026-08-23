import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { createPgStaffInvitationRepository } from "./staffInvitations.js";
import type { CreateStaffInviteCommand } from "./lifecycle.js";

const TEST_DATABASE_URL = process.env["TEST_DATABASE_URL"];
const org = "11111111-1111-4111-8111-111111111111";
const otherOrg = "22222222-2222-4222-8222-222222222222";
const owner = "33333333-3333-4333-8333-333333333333";
const otherUser = "44444444-4444-4444-8444-444444444444";
const membership = "55555555-5555-4555-8555-555555555555";
const property = "66666666-6666-4666-8666-666666666666";
const foreignProperty = "77777777-7777-4777-8777-777777777777";
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
    roleKey: "front_desk" | "housekeeping";
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

  beforeAll(async () => {
    const dbName = new URL(TEST_DATABASE_URL!).pathname.replace(/^\//, "");
    if (!/(^|[_-])test([_-]|$)/i.test(dbName)) throw new Error(`Refusing database ${dbName}`);
    client = new pg.Client({ connectionString: TEST_DATABASE_URL });
    await client.connect();
    repository = createPgStaffInvitationRepository({ connectionString: TEST_DATABASE_URL! });
    await client.query(`
      INSERT INTO identity.users (id, email, name, status) VALUES
        ('${owner}', 'owner@example.com', 'Owner Example', 'active'), ('${otherUser}', 'other@example.com', 'Other User', 'active')
      ON CONFLICT (id) DO NOTHING;
      INSERT INTO identity.organizations (id, kind, name, slug, status) VALUES
        ('${org}', 'hotel_group', 'Owner Org', 'owner-org', 'active'), ('${otherOrg}', 'hotel_group', 'Other Org', 'other-org', 'active')
      ON CONFLICT (id) DO NOTHING;
      INSERT INTO identity.organization_memberships (id, organization_id, user_id, status, role_key, property_access_mode, access_origin) VALUES
        ('${membership}', '${org}', '${owner}', 'active', 'hotel_owner', 'all', 'agency'),
        ('88888888-8888-4888-8888-888888888888', '${otherOrg}', '${otherUser}', 'active', 'hotel_owner', 'all', 'agency')
      ON CONFLICT (id) DO NOTHING;
      INSERT INTO hotel_catalog.properties (id, public_id, display_name) VALUES
        ('${property}', 'owner-property', 'Owner Property'), ('${foreignProperty}', 'foreign-property', 'Foreign Property')
      ON CONFLICT (id) DO NOTHING;
      INSERT INTO identity.organization_resource_links (organization_id, product, resource_type, resource_id, relationship, status) VALUES
        ('${org}', 'hotel_catalog', 'property', '${property}', 'owner', 'active'),
        ('${otherOrg}', 'hotel_catalog', 'property', '${foreignProperty}', 'owner', 'active')
      ON CONFLICT DO NOTHING;
    `);
  });

  beforeEach(async () => {
    await client.query("DELETE FROM identity.staff_invitations");
    await client.query(
      "UPDATE identity.organization_memberships SET status = 'active', permission_overrides = NULL WHERE id = $1",
      [membership],
    );
  });

  afterAll(async () => {
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
});
