import { readFile } from "node:fs/promises";
import { join } from "node:path";
import pg from "pg";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { assertSafeTestDatabase } from "./testUtils.js";

const MIGRATION_PATH = join(import.meta.dirname, "../migrations/0051_pms_room_amenity_review.sql");
const migration = await readFile(MIGRATION_PATH, "utf8");
const TEST_DATABASE_URL = process.env["TEST_DATABASE_URL"];

describe("PMS room amenity-review migration contract", () => {
  it("adds only independent review and revision state to the existing snapshot", () => {
    expect(migration).toContain("ALTER TABLE pms.room_types");
    expect(migration).toContain("ADD COLUMN room_amenities_revision BIGINT NOT NULL DEFAULT 1");
    expect(migration).toContain("ADD COLUMN room_amenities_reviewed_at TIMESTAMPTZ");
    expect(migration).toContain("chk_pms_room_types_room_amenities_revision");
    expect(migration).toContain("room_amenities_revision BETWEEN 1 AND 2147483647");
    expect(migration).toContain("chk_pms_room_types_room_amenities_review_state");
    expect(migration).toContain("room_amenities_reviewed_at IS NULL");
    expect(migration).toContain("OR room_amenities_revision >= 2");
  });

  it("does not transform or constrain legacy amenity JSON", () => {
    expect(migration).not.toMatch(/\b(?:UPDATE|INSERT INTO|DELETE FROM)\s+pms\.room_types\b/i);
    expect(migration).not.toMatch(/ALTER\s+COLUMN\s+amenities_snapshot/i);
    expect(migration).not.toMatch(/(?:jsonb_typeof|jsonb_array_length|jsonb_path)/i);
    expect(migration).not.toContain("IF NOT EXISTS");
    expect(migration).not.toContain("vayada:no-transaction");
  });
});

describe.skipIf(!TEST_DATABASE_URL)("PMS room amenity-review migration (PostgreSQL)", () => {
  let client: pg.Client;

  beforeEach(async () => {
    assertSafeTestDatabase(TEST_DATABASE_URL!);
    client = new pg.Client({ connectionString: TEST_DATABASE_URL });
    await client.connect();
    await client.query("DROP SCHEMA IF EXISTS pms CASCADE");
    await client.query(`
      CREATE SCHEMA pms;
      CREATE TABLE pms.room_types (
        id UUID PRIMARY KEY,
        amenities_snapshot JSONB NOT NULL DEFAULT '[]'::jsonb
      );
      INSERT INTO pms.room_types (id, amenities_snapshot) VALUES
        ('10000000-0000-4000-8000-000000000001', '["wifi", "balcony"]'::jsonb),
        ('10000000-0000-4000-8000-000000000002',
          '{"legacy": true, "nested": [1, null]}'::jsonb),
        ('10000000-0000-4000-8000-000000000003', '"not-an-array"'::jsonb),
        ('10000000-0000-4000-8000-000000000004', 'null'::jsonb);
    `);
  });

  afterEach(async () => {
    try {
      await client.query("DROP SCHEMA IF EXISTS pms CASCADE");
    } finally {
      await client.end();
    }
  });

  it("preserves every existing snapshot byte and initializes all rows unreviewed", async () => {
    const before = await snapshotFingerprints(client);

    await client.query(migration);

    const after = await snapshotFingerprints(client);
    expect(after).toEqual(before);

    const { rows } = await client.query<{
      id: string;
      revision: string;
      reviewedAt: Date | null;
    }>(`
      SELECT id::text AS id,
             room_amenities_revision::text AS revision,
             room_amenities_reviewed_at AS "reviewedAt"
      FROM pms.room_types
      ORDER BY id
    `);
    expect(rows).toEqual(before.map(({ id }) => ({ id, revision: "1", reviewedAt: null })));

    await client.query(`
      INSERT INTO pms.room_types (id, amenities_snapshot)
      VALUES ('10000000-0000-4000-8000-000000000005', '["tv"]'::jsonb)
    `);
    const { rows: inserted } = await client.query<{
      revision: string;
      reviewedAt: Date | null;
    }>(`
      SELECT room_amenities_revision::text AS revision,
             room_amenities_reviewed_at AS "reviewedAt"
      FROM pms.room_types
      WHERE id = '10000000-0000-4000-8000-000000000005'
    `);
    expect(inserted).toEqual([{ revision: "1", reviewedAt: null }]);
  });

  it("bounds revisions and never treats revision one as reviewed", async () => {
    await client.query(migration);

    await expectConstraint(
      client,
      `UPDATE pms.room_types SET room_amenities_revision = 0
       WHERE id = '10000000-0000-4000-8000-000000000001'`,
      "chk_pms_room_types_room_amenities_revision",
    );
    await expectConstraint(
      client,
      `UPDATE pms.room_types SET room_amenities_revision = 2147483648
       WHERE id = '10000000-0000-4000-8000-000000000001'`,
      "chk_pms_room_types_room_amenities_revision",
    );
    await expectConstraint(
      client,
      `UPDATE pms.room_types SET room_amenities_reviewed_at = now()
       WHERE id = '10000000-0000-4000-8000-000000000001'`,
      "chk_pms_room_types_room_amenities_review_state",
    );

    await client.query(`
      UPDATE pms.room_types
      SET room_amenities_revision = 2,
          room_amenities_reviewed_at = '2026-08-03T12:00:00.000Z'
      WHERE id = '10000000-0000-4000-8000-000000000001'
    `);
    const { rows } = await client.query<{
      revision: string;
      reviewedAt: Date;
    }>(`
      SELECT room_amenities_revision::text AS revision,
             room_amenities_reviewed_at AS "reviewedAt"
      FROM pms.room_types
      WHERE id = '10000000-0000-4000-8000-000000000001'
    `);
    expect(rows).toEqual([{ revision: "2", reviewedAt: new Date("2026-08-03T12:00:00.000Z") }]);
  });
});

interface SnapshotFingerprint {
  readonly id: string;
  readonly bytes: string;
  readonly storageSize: number;
  readonly text: string;
}

async function snapshotFingerprints(client: pg.Client): Promise<SnapshotFingerprint[]> {
  const { rows } = await client.query<SnapshotFingerprint>(`
    SELECT id::text AS id,
           encode(jsonb_send(amenities_snapshot), 'hex') AS bytes,
           pg_column_size(amenities_snapshot)::integer AS "storageSize",
           amenities_snapshot::text AS text
    FROM pms.room_types
    ORDER BY id
  `);
  return rows;
}

async function expectConstraint(client: pg.Client, sql: string, constraint: string): Promise<void> {
  await expect(client.query(sql)).rejects.toMatchObject({
    code: "23514",
    constraint,
  });
}
