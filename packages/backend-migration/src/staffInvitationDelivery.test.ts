import { readFile } from "node:fs/promises";
import { join } from "node:path";
import pg from "pg";
import { describe, expect, it } from "vitest";

import { assertSafeTestDatabase } from "./testUtils.js";

const TEST_DATABASE_URL = process.env["TEST_DATABASE_URL"];
const migrations = await Promise.all(
  [
    "0110_staff_invitations.sql",
    "0111_staff_invitation_delivery_state.sql",
    "0112_validate_staff_invitation_delivery_state.sql",
  ].map((name) => readFile(join(import.meta.dirname, "../migrations", name), "utf8")),
);

describe("staff invitation delivery schema contract", () => {
  it("records an at-most-once provider attempt without provider secrets", () => {
    expect(migrations[1]).toContain("chk_staff_invitation_delivery_state");
    expect(migrations[1]).toContain("delivery_state = 'sending'");
    expect(migrations[1]).toContain("status = 'pending'");
    expect(migrations[1]).toContain("AND expires_at IS NOT NULL");
    expect(migrations[1]).toContain(") NOT VALID;");
    expect(migrations[2]).toContain("VALIDATE CONSTRAINT chk_staff_invitation_delivery_state");
    expect(migrations[2]!.indexOf("VALIDATE CONSTRAINT")).toBeLessThan(
      migrations[2]!.indexOf("SET NOT NULL"),
    );
    expect(migrations[1]).not.toMatch(/token|acceptance_url/i);
  });
});

describe.skipIf(!TEST_DATABASE_URL)("staff invitation delivery schema (PostgreSQL)", () => {
  it("backfills safely and enforces atomic provider binding", async () => {
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
          organization_id UUID NOT NULL, product TEXT NOT NULL, resource_type TEXT NOT NULL,
          resource_id TEXT NOT NULL, relationship TEXT NOT NULL, status TEXT NOT NULL
        );
        CREATE TABLE hotel_catalog.properties (id UUID PRIMARY KEY);
      `);
      await client.query(migrations[0]!);
      await client.query(`
        INSERT INTO identity.users VALUES ('11111111-1111-4111-8111-111111111111');
        INSERT INTO identity.organizations VALUES ('22222222-2222-4222-8222-222222222222');
        INSERT INTO identity.organization_memberships VALUES
          ('33333333-3333-4333-8333-333333333333', '22222222-2222-4222-8222-222222222222',
           '11111111-1111-4111-8111-111111111111');
        INSERT INTO identity.staff_invitations
          (organization_id, email, inviter_membership_id, inviter_user_id, inviter_name_snapshot,
           role_key, permission_overrides, property_access_mode, configuration_revision, command_id,
           idempotency_key_hash, request_fingerprint_hash, provider_invitation_id, expires_at,
           request_id, request_source, reason, requested_at)
        VALUES
          ('22222222-2222-4222-8222-222222222222', 'ready@example.com',
           '33333333-3333-4333-8333-333333333333', '11111111-1111-4111-8111-111111111111',
           'Owner', 'front_desk', '{}', 'assigned', 1, 'ready-command',
           decode(repeat('11', 32), 'hex'), decode(repeat('22', 32), 'hex'), NULL, NULL,
           'request-1', 'admin', 'invite', now()),
          ('22222222-2222-4222-8222-222222222222', 'delivered@example.com',
           '33333333-3333-4333-8333-333333333333', '11111111-1111-4111-8111-111111111111',
           'Owner', 'front_desk', '{}', 'assigned', 1, 'delivered-command',
           decode(repeat('33', 32), 'hex'), decode(repeat('44', 32), 'hex'),
           'invitation_existing', now() + interval '7 days',
           'request-2', 'admin', 'invite', now());
      `);
      await client.query(migrations[1]!);
      await client.query(migrations[2]!);

      const states = await client.query(
        `SELECT email, delivery_state, delivery_attempted_at IS NOT NULL AS attempted
         FROM identity.staff_invitations ORDER BY email`,
      );
      expect(states.rows).toEqual([
        { email: "delivered@example.com", delivery_state: "delivered", attempted: true },
        { email: "ready@example.com", delivery_state: "ready", attempted: false },
      ]);

      await client.query("BEGIN");
      await client.query(
        `UPDATE identity.staff_invitations SET status = 'revoked'
         WHERE email = 'ready@example.com'`,
      );
      const canceledClaim = await client.query(
        `UPDATE identity.staff_invitations
         SET delivery_state = 'sending', delivery_attempted_at = now()
         WHERE email = 'ready@example.com' AND status = 'pending' AND delivery_state = 'ready'
         RETURNING id`,
      );
      expect(canceledClaim.rowCount).toBe(0);
      await client.query("ROLLBACK");

      await client.query(
        `UPDATE identity.staff_invitations
         SET delivery_state = 'sending', delivery_attempted_at = now()
         WHERE email = 'ready@example.com'`,
      );
      await expect(
        client.query(
          `UPDATE identity.staff_invitations SET status = 'revoked'
           WHERE email = 'ready@example.com'`,
        ),
      ).rejects.toMatchObject({ constraint: "chk_staff_invitation_delivery_state" });
      await expect(
        client.query(
          `UPDATE identity.staff_invitations SET provider_invitation_id = 'invitation_new',
             expires_at = now() + interval '7 days' WHERE email = 'ready@example.com'`,
        ),
      ).rejects.toMatchObject({ constraint: "chk_staff_invitation_delivery_state" });
      await expect(
        client.query(
          `UPDATE identity.staff_invitations SET delivery_state = 'delivered',
             provider_invitation_id = 'invitation_without_expiry'
           WHERE email = 'ready@example.com'`,
        ),
      ).rejects.toMatchObject({ code: "23514" });
      await client.query(
        `UPDATE identity.staff_invitations SET delivery_state = 'delivered',
           provider_invitation_id = 'invitation_new', expires_at = now() + interval '7 days'
         WHERE email = 'ready@example.com'`,
      );
    } finally {
      await client.query(
        "DROP SCHEMA IF EXISTS identity CASCADE; DROP SCHEMA IF EXISTS hotel_catalog CASCADE",
      );
      await client.end();
    }
  });
});
