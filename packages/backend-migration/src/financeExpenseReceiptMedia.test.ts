import { readFile } from "node:fs/promises";
import { join } from "node:path";
import pg from "pg";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { assertSafeTestDatabase } from "./testUtils.js";

const readMigration = (name: string) =>
  readFile(join(import.meta.dirname, `../migrations/${name}`), "utf8");
const [mediaRegistry, restoredPurposes, migration, validation] = await Promise.all([
  readMigration("0015_platform_media_registry.sql"),
  readMigration("0033_restore_identity_profile_media_purpose.sql"),
  readMigration("0068_finance_expense_receipt_media.sql"),
  readMigration("0069_validate_finance_expense_receipt_media.sql"),
]);
const TEST_DATABASE_URL = process.env["TEST_DATABASE_URL"];
const PROPERTY_ID = "20000000-0000-4000-8000-000000000001";

describe("Finance expense receipt media migration contract", () => {
  it("adds only the private Finance receipt purpose", () => {
    expect(migration).toContain("'finance.expense.receipt'");
    expect(migration).toContain("media_visibility = 'private'");
    expect(migration).toContain("resource_product = 'finance'");
    expect(migration).toContain("resource_type = 'expense'");
    expect(migration).toContain("property_id IS NOT NULL");
    expect(migration.match(/NOT VALID/g)).toHaveLength(4);
    expect(validation.match(/VALIDATE CONSTRAINT/g)).toHaveLength(4);
  });

  it("preserves every existing purpose and resource product", () => {
    for (const purpose of [
      "booking.header_logo",
      "identity.user.profile_image",
      "property.hero_image",
      "property.gallery_image",
      "property.logo",
      "marketplace.offer.media",
      "marketplace.creator.profile_image",
      "pms.room_type.media",
      "marketplace.collaboration_chat.attachment",
      "pms.messaging.attachment",
      "pms.import.source_image",
    ]) {
      expect(migration).toContain(`'${purpose}'`);
    }
    for (const product of [
      "hotel_catalog",
      "booking",
      "pms",
      "marketplace",
      "distribution",
      "platform",
      "migration",
    ]) {
      expect(migration).toContain(`'${product}'`);
    }
  });
});

describe.skipIf(!TEST_DATABASE_URL)("Finance expense receipt media (PostgreSQL)", () => {
  let client: pg.Client;

  beforeEach(async () => {
    assertSafeTestDatabase(TEST_DATABASE_URL!);
    client = new pg.Client({ connectionString: TEST_DATABASE_URL });
    await client.connect();
    await client.query(`
      DROP SCHEMA IF EXISTS platform CASCADE;
      DROP SCHEMA IF EXISTS hotel_catalog CASCADE;
      DROP SCHEMA IF EXISTS identity CASCADE;
      CREATE SCHEMA identity;
      CREATE SCHEMA hotel_catalog;
      CREATE TABLE identity.organizations (id UUID PRIMARY KEY);
      CREATE TABLE identity.users (id UUID PRIMARY KEY);
      CREATE TABLE hotel_catalog.properties (id UUID PRIMARY KEY);
      INSERT INTO hotel_catalog.properties VALUES ('${PROPERTY_ID}');
    `);
    await client.query(mediaRegistry);
    await client.query(restoredPurposes);
    await client.query(migration);
    await client.query(validation);
  });

  afterEach(async () => {
    try {
      await client.query("DROP SCHEMA IF EXISTS platform CASCADE");
      await client.query("DROP SCHEMA IF EXISTS hotel_catalog CASCADE");
      await client.query("DROP SCHEMA IF EXISTS identity CASCADE");
    } finally {
      await client.end();
    }
  });

  it("accepts a private Finance receipt and existing media", async () => {
    await client.query(
      `INSERT INTO platform.media_objects
         (bucket, storage_key, visibility, purpose, property_id, resource_product, resource_type,
          lifecycle_status, public_approved)
       VALUES
         ('private', 'receipt-1', 'private', 'finance.expense.receipt', $1, 'finance', 'expense',
          'staged', FALSE),
         ('private', 'source-1', 'private', 'pms.import.source_image', $1, 'pms', 'import',
          'staged', FALSE),
         ('public', 'header-1', 'public', 'booking.header_logo', $1, 'booking', 'property',
          'active', TRUE)`,
      [PROPERTY_ID],
    );
    expect(
      (await client.query("SELECT count(*)::int AS count FROM platform.media_objects")).rows[0],
    ).toEqual({ count: 3 });
  });

  it("rejects public receipts and mismatched product ownership", async () => {
    await expect(
      client.query(
        `INSERT INTO platform.media_objects
           (bucket, storage_key, visibility, purpose, property_id, resource_product,
            resource_type, lifecycle_status, public_approved)
         VALUES ('public', 'receipt-public', 'public', 'finance.expense.receipt', $1,
                 'finance', 'expense', 'active', TRUE)`,
        [PROPERTY_ID],
      ),
    ).rejects.toMatchObject({
      code: "23514",
      constraint: "chk_platform_media_objects_purpose_visibility",
    });
    await expect(
      client.query(
        `INSERT INTO platform.media_objects
           (bucket, storage_key, visibility, purpose, property_id, resource_product, resource_type)
         VALUES ('private', 'receipt-pms', 'private', 'finance.expense.receipt', $1, 'pms', 'expense')`,
        [PROPERTY_ID],
      ),
    ).rejects.toMatchObject({
      code: "23514",
      constraint: "chk_platform_media_objects_finance_expense_receipt",
    });
  });

  it("applies the same private ownership contract to upload sessions", async () => {
    await client.query(
      `INSERT INTO platform.media_upload_sessions
         (upload_session_key, requested_purpose, requested_visibility, property_id,
          resource_product, resource_type, staging_prefix, expires_at)
       VALUES ('receipt-private', 'finance.expense.receipt', 'private', $1,
               'finance', 'expense', 'staging/receipt-private', now() + interval '1 hour')`,
      [PROPERTY_ID],
    );
    await expect(
      client.query(
        `INSERT INTO platform.media_upload_sessions
           (upload_session_key, requested_purpose, requested_visibility, property_id,
            resource_product, resource_type, staging_prefix, expires_at)
         VALUES ('receipt-public', 'finance.expense.receipt', 'public', $1,
                 'finance', 'expense', 'staging/receipt-public', now() + interval '1 hour')`,
        [PROPERTY_ID],
      ),
    ).rejects.toMatchObject({
      code: "23514",
      constraint: "chk_platform_media_upload_sessions_purpose_visibility",
    });
    await expect(
      client.query(
        `INSERT INTO platform.media_upload_sessions
           (upload_session_key, requested_purpose, requested_visibility, property_id,
            resource_product, resource_type, staging_prefix, expires_at)
         VALUES ('receipt-pms', 'finance.expense.receipt', 'private', $1,
                 'pms', 'expense', 'staging/receipt-pms', now() + interval '1 hour')`,
        [PROPERTY_ID],
      ),
    ).rejects.toMatchObject({
      code: "23514",
      constraint: "chk_platform_media_upload_sessions_finance_expense_receipt",
    });
  });
});
