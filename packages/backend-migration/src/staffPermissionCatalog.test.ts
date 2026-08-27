import { readFile } from "node:fs/promises";
import { join } from "node:path";
import pg from "pg";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { assertSafeTestDatabase } from "./testUtils.js";

const migration = await readFile(
  join(import.meta.dirname, "../migrations/0109_staff_permission_catalog.sql"),
  "utf8",
);
const TEST_DATABASE_URL = process.env["TEST_DATABASE_URL"];

const permissions = [
  "pms.dashboard.read",
  "pms.dashboard.operations.read",
  "pms.dashboard.finance.read",
  "pms.calendar.read",
  "pms.calendar.manage",
  "pms.reservation.read",
  "pms.reservation.update",
  "pms.reservation.cancel",
  "pms.inbox.read",
  "pms.inbox.reply",
  "pms.room_status.read",
  "pms.rooms_rates.read",
  "pms.rooms_rates.manage",
  "pms.channel_manager.read",
  "pms.finance.read",
  "pms.settings.read",
  "pms.settings.manage",
  "pms.guest_contact.read",
  "booking.analytics.read",
  "booking.design.read",
  "booking.design.manage",
  "booking.flow.read",
  "booking.flow.manage",
  "booking.settings.read",
  "booking.settings.manage",
  "identity.staff.manage",
  "finance.billing.manage",
] as const;

const frontDesk = [
  "pms.dashboard.read",
  "pms.dashboard.operations.read",
  "pms.calendar.read",
  "pms.calendar.manage",
  "pms.reservation.read",
  "pms.reservation.update",
  "pms.inbox.read",
  "pms.inbox.reply",
  "pms.room_status.read",
  "pms.rooms_rates.read",
  "pms.guest_contact.read",
];
const housekeeping = ["pms.dashboard.read", "pms.calendar.read", "pms.room_status.read"];

describe("staff permission catalog migration contract", () => {
  it("seeds every staff permission replay-safely without hierarchy roles", () => {
    for (const permission of permissions) expect(migration).toContain(`('${permission}'`);
    expect(migration.match(/ON CONFLICT/g)).toHaveLength(2);
    expect(migration).not.toContain("external_owner");
    expect(migration).not.toMatch(/\('operator',/);
    expect(migration).not.toContain("'hotel_custom',");
  });
});

describe.skipIf(!TEST_DATABASE_URL)("staff permission catalog migration (PostgreSQL)", () => {
  let client: pg.Client;

  beforeEach(async () => {
    assertSafeTestDatabase(TEST_DATABASE_URL!);
    client = new pg.Client({ connectionString: TEST_DATABASE_URL });
    await client.connect();
    await client.query(`
      DROP SCHEMA IF EXISTS identity CASCADE;
      CREATE SCHEMA identity;
      CREATE TABLE identity.permission_catalog (
        key TEXT PRIMARY KEY,
        product TEXT NOT NULL,
        description TEXT
      );
      CREATE TABLE identity.role_permission_grants (
        organization_kind TEXT NOT NULL,
        role_key TEXT NOT NULL,
        permission_key TEXT NOT NULL REFERENCES identity.permission_catalog(key),
        UNIQUE (organization_kind, role_key, permission_key)
      );
      INSERT INTO identity.permission_catalog VALUES
        ('pms.finance.read', 'pms', 'existing description'),
        ('pms.dashboard.finance.read', 'pms', 'stale grant fixture'),
        ('pms.guest_contact.read', 'pms', 'stale grant fixture'),
        ('booking.design.manage', 'booking', 'stale grant fixture'),
        ('identity.staff.manage', 'identity', 'stale grant fixture'),
        ('finance.billing.manage', 'finance', 'stale grant fixture'),
        ('unrelated.permission', 'platform', 'preserve me');
      INSERT INTO identity.role_permission_grants VALUES
        ('hotel_group', 'hotel_manager', 'identity.staff.manage'),
        ('hotel_group', 'hotel_manager', 'finance.billing.manage'),
        ('hotel_group', 'front_desk', 'pms.dashboard.finance.read'),
        ('hotel_group', 'housekeeping', 'pms.guest_contact.read'),
        ('hotel_group', 'hotel_custom', 'booking.design.manage'),
        ('hotel_group', 'hotel_custom', 'unrelated.permission');
    `);
    await client.query(migration);
    await client.query(migration);
  });

  afterEach(async () => {
    try {
      await client.query("DROP SCHEMA IF EXISTS identity CASCADE");
    } finally {
      await client.end();
    }
  });

  it("preserves catalog rows and installs exact role defaults", async () => {
    const catalog = await client.query<{ key: string; product: string; description: string }>(
      `SELECT key, product, description
       FROM identity.permission_catalog
       WHERE key = ANY($1::text[])
       ORDER BY key`,
      [permissions],
    );
    expect(catalog.rows.map(({ key }) => key)).toEqual([...permissions].sort());
    expect(catalog.rows.find(({ key }) => key === "pms.finance.read")?.description).toBe(
      "existing description",
    );

    const rows = await client.query<{ roleKey: string; permissionKey: string }>(
      `SELECT role_key AS "roleKey", permission_key AS "permissionKey"
       FROM identity.role_permission_grants
       WHERE organization_kind = 'hotel_group'
         AND permission_key = ANY($1::text[])
       ORDER BY role_key, permission_key`,
      [permissions],
    );
    const grants = (roleKey: string) =>
      rows.rows.filter((row) => row.roleKey === roleKey).map((row) => row.permissionKey);

    expect(grants("hotel_owner")).toEqual([...permissions].sort());
    expect(grants("owner")).toEqual([...permissions].sort());
    expect(grants("hotel_manager")).toEqual(
      permissions
        .filter((key) => key !== "identity.staff.manage" && key !== "finance.billing.manage")
        .sort(),
    );
    expect(grants("front_desk")).toEqual([...frontDesk].sort());
    expect(grants("housekeeping")).toEqual([...housekeeping].sort());
    expect(grants("hotel_custom")).toEqual([]);
    expect(grants("operator")).toEqual([]);
    expect(rows.rows).toHaveLength(93);

    const unrelated = await client.query<{ roleKey: string }>(
      `SELECT role_key AS "roleKey"
       FROM identity.role_permission_grants
       WHERE organization_kind = 'hotel_group'
         AND permission_key = 'unrelated.permission'`,
    );
    expect(unrelated.rows).toEqual([{ roleKey: "hotel_custom" }]);
  });
});
