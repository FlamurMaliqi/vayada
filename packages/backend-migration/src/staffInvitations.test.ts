import { readFile } from "node:fs/promises";
import { join } from "node:path";
import pg from "pg";
import { describe, expect, it } from "vitest";

import { assertSafeTestDatabase } from "./testUtils.js";

const TEST_DATABASE_URL = process.env["TEST_DATABASE_URL"];
const migration = await readFile(
  join(import.meta.dirname, "../migrations/0110_staff_invitations.sql"),
  "utf8",
);

describe("staff invitation schema contract", () => {
  it("keeps pending intent, revision, acceptance, and property scope fail-closed", () => {
    expect(migration).toContain("uq_staff_invitations_pending_email");
    expect(migration).toContain("uq_staff_invitation_revision");
    expect(migration).toContain("chk_staff_invitation_acceptance");
    expect(migration).toContain("chk_staff_invitation_provider_binding");
    expect(migration).toContain("fk_staff_invitation_inviter_scope");
    expect(migration).toContain("fk_staff_invitation_acceptance_scope");
    expect(migration).toContain("fk_staff_invitation_property_assignment_canonical_scope");
    expect(migration).not.toMatch(/token|acceptance_url/i);
  });
});

describe.skipIf(!TEST_DATABASE_URL)("staff invitation schema (PostgreSQL)", () => {
  it("enforces one pending revision and same-tenant property assignments", async () => {
    assertSafeTestDatabase(TEST_DATABASE_URL!);
    const client = new pg.Client({ connectionString: TEST_DATABASE_URL });
    await client.connect();
    try {
      await client.query(`
        DROP SCHEMA IF EXISTS identity CASCADE;
        DROP SCHEMA IF EXISTS hotel_catalog CASCADE;
        CREATE SCHEMA identity;
        CREATE SCHEMA hotel_catalog;
        CREATE TABLE identity.users (id UUID PRIMARY KEY);
        CREATE TABLE identity.organizations (id UUID PRIMARY KEY);
        CREATE TABLE identity.organization_memberships (
          id UUID PRIMARY KEY,
          organization_id UUID NOT NULL REFERENCES identity.organizations(id),
          user_id UUID NOT NULL REFERENCES identity.users(id)
        );
        CREATE TABLE identity.organization_resource_links (
          organization_id UUID NOT NULL,
          product TEXT NOT NULL,
          resource_type TEXT NOT NULL,
          resource_id TEXT NOT NULL,
          relationship TEXT NOT NULL,
          status TEXT NOT NULL
        );
        CREATE TABLE hotel_catalog.properties (id UUID PRIMARY KEY);
      `);
      await client.query(migration);
      await client.query(`
        INSERT INTO identity.users VALUES
          ('11111111-1111-4111-8111-111111111111'),
          ('77777777-7777-4777-8777-777777777777');
        INSERT INTO identity.organizations VALUES
          ('22222222-2222-4222-8222-222222222222'),
          ('33333333-3333-4333-8333-333333333333');
        INSERT INTO identity.organization_memberships VALUES
          ('44444444-4444-4444-8444-444444444444', '22222222-2222-4222-8222-222222222222',
           '11111111-1111-4111-8111-111111111111'),
          ('88888888-8888-4888-8888-888888888888', '33333333-3333-4333-8333-333333333333',
           '77777777-7777-4777-8777-777777777777');
        INSERT INTO hotel_catalog.properties VALUES
          ('55555555-5555-4555-8555-555555555555'),
          ('66666666-6666-4666-8666-666666666666');
        INSERT INTO identity.organization_resource_links VALUES
          ('22222222-2222-4222-8222-222222222222', 'hotel_catalog', 'property',
           '55555555-5555-4555-8555-555555555555', 'owner', 'active'),
          ('33333333-3333-4333-8333-333333333333', 'hotel_catalog', 'property',
           '66666666-6666-4666-8666-666666666666', 'owner', 'active');
      `);
      const insert = `INSERT INTO identity.staff_invitations
        (organization_id, email, inviter_membership_id, inviter_user_id, inviter_name_snapshot, role_key,
         permission_overrides, property_access_mode, configuration_revision, command_id,
         idempotency_key_hash, request_fingerprint_hash, expires_at, request_id,
        request_source, reason, requested_at)
        VALUES ('22222222-2222-4222-8222-222222222222', 'staff@example.com',
          $5, $6,
          'Owner', 'front_desk',
          '{"grant":[],"deny":[]}', 'assigned', $1, $2,
          decode(repeat($3, 32), 'hex'), decode(repeat($4, 32), 'hex'),
          NULL, 'request', 'admin', 'invite', now())
        RETURNING id`;
      const inviter = [
        "44444444-4444-4444-8444-444444444444",
        "11111111-1111-4111-8111-111111111111",
      ];
      await expect(
        client.query(insert, [
          1,
          "cross-tenant-command",
          "11",
          "22",
          "88888888-8888-4888-8888-888888888888",
          "77777777-7777-4777-8777-777777777777",
        ]),
      ).rejects.toMatchObject({ constraint: "fk_staff_invitation_inviter_scope" });
      const first = await client.query<{ id: string }>(insert, [
        1,
        "command-1",
        "aa",
        "bb",
        ...inviter,
      ]);
      await client.query(
        `UPDATE identity.staff_invitations
         SET provider_invitation_id = 'invitation-1', expires_at = now() + interval '7 days'
         WHERE id = $1`,
        [first.rows[0]!.id],
      );
      await expect(
        client.query(`UPDATE identity.staff_invitations SET expires_at = NULL WHERE id = $1`, [
          first.rows[0]!.id,
        ]),
      ).rejects.toMatchObject({ constraint: "chk_staff_invitation_provider_binding" });
      await expect(
        client.query(
          `UPDATE identity.staff_invitations
           SET status = 'accepted', accepted_membership_id = $2, accepted_user_id = $3
           WHERE id = $1`,
          [
            first.rows[0]!.id,
            "88888888-8888-4888-8888-888888888888",
            "77777777-7777-4777-8777-777777777777",
          ],
        ),
      ).rejects.toMatchObject({ constraint: "fk_staff_invitation_acceptance_scope" });
      await expect(
        client.query(insert, [2, "command-2", "cc", "dd", ...inviter]),
      ).rejects.toMatchObject({ constraint: "uq_staff_invitations_pending_email" });
      await client.query(
        `INSERT INTO identity.staff_invitation_property_assignments VALUES ($1, $2)`,
        [first.rows[0]!.id, "55555555-5555-4555-8555-555555555555"],
      );
      await expect(
        client.query(`INSERT INTO identity.staff_invitation_property_assignments VALUES ($1, $2)`, [
          first.rows[0]!.id,
          "66666666-6666-4666-8666-666666666666",
        ]),
      ).rejects.toMatchObject({
        constraint: "fk_staff_invitation_property_assignment_canonical_scope",
      });
      await client.query("UPDATE identity.staff_invitations SET status = 'revoked'");
      await client.query(insert, [2, "command-2", "cc", "dd", ...inviter]);
      await expect(
        client.query(
          `UPDATE identity.staff_invitations
           SET status = 'accepted', accepted_membership_id = $2, accepted_user_id = $3
           WHERE command_id = $1`,
          ["command-2", ...inviter],
        ),
      ).rejects.toMatchObject({ constraint: "chk_staff_invitation_acceptance" });
      await client.query("UPDATE identity.staff_invitations SET status = 'revoked'");
      await expect(
        client.query(insert, [2, "command-3", "ee", "ff", ...inviter]),
      ).rejects.toMatchObject({ constraint: "uq_staff_invitation_revision" });
    } finally {
      await client.query(
        "DROP SCHEMA IF EXISTS identity CASCADE; DROP SCHEMA IF EXISTS hotel_catalog CASCADE",
      );
      await client.end();
    }
  });
});
