import { readFile } from "node:fs/promises";
import { join } from "node:path";

import pg from "pg";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { assertSafeTestDatabase } from "./testUtils.js";

const migration = await readFile(
  join(import.meta.dirname, "../migrations/0061_public_bookability_gallery_media.sql"),
  "utf8",
);
const TEST_DATABASE_URL = process.env["TEST_DATABASE_URL"];

describe("public bookability gallery media migration contract", () => {
  it("rebuilds a typed, ordered, ten-photo projection from canonical Catalog media", () => {
    expect(migration).toContain("FROM hotel_catalog.property_public_profile_read_model catalog");
    expect(migration).toContain("UPDATE distribution.public_hotel_bookability_profiles profile");
    expect(migration).toContain("media.item ->> 'type' = 'gallery_image'");
    expect(migration).toContain("'type', 'gallery_image'");
    expect(migration).toContain("ORDER BY ordinality");
    expect(migration).toContain("LIMIT 10");
    expect(migration).toContain("profile.media IS DISTINCT FROM gallery.media");
  });
});

describe.skipIf(!TEST_DATABASE_URL)(
  "public bookability gallery media migration (PostgreSQL)",
  () => {
    let client: pg.Client;

    beforeEach(async () => {
      assertSafeTestDatabase(TEST_DATABASE_URL!);
      client = new pg.Client({ connectionString: TEST_DATABASE_URL });
      await client.connect();
      await client.query(`
      DROP SCHEMA IF EXISTS distribution CASCADE;
      DROP SCHEMA IF EXISTS hotel_catalog CASCADE;
      CREATE SCHEMA hotel_catalog;
      CREATE SCHEMA distribution;
      CREATE TABLE hotel_catalog.property_public_profile_read_model (
        property_id UUID PRIMARY KEY,
        media JSONB NOT NULL
      );
      CREATE TABLE distribution.public_hotel_bookability_profiles (
        property_id UUID PRIMARY KEY,
        media JSONB NOT NULL,
        projected_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
    `);
    });

    afterEach(async () => {
      try {
        await client.query("DROP SCHEMA IF EXISTS distribution CASCADE");
        await client.query("DROP SCHEMA IF EXISTS hotel_catalog CASCADE");
      } finally {
        await client.end();
      }
    });

    it("replaces legacy untyped rows, excludes hero/logo, caps at ten, and is idempotent", async () => {
      const canonicalMedia = [
        { type: "logo", url: "logo.webp" },
        { type: "hero_image", url: "hero.webp" },
        ...Array.from({ length: 11 }, (_, index) => ({
          type: "gallery_image",
          url: `gallery-${index + 1}.webp`,
          altText: index === 0 ? "Pool at sunset" : null,
        })),
      ];
      await client.query(
        `INSERT INTO hotel_catalog.property_public_profile_read_model (property_id, media)
       VALUES ('30000000-0000-4000-8000-000000000001', $1::jsonb)`,
        [JSON.stringify(canonicalMedia)],
      );
      await client.query(
        `INSERT INTO distribution.public_hotel_bookability_profiles (property_id, media)
       VALUES (
         '30000000-0000-4000-8000-000000000001',
         '[{"url":"legacy-hero.webp"},{"url":"legacy-gallery.webp"}]'::jsonb
       )`,
      );

      await client.query(migration);
      await client.query(migration);

      const result = await client.query<{ media: Array<Record<string, string>> }>(
        `SELECT media FROM distribution.public_hotel_bookability_profiles
       WHERE property_id = '30000000-0000-4000-8000-000000000001'`,
      );
      expect(result.rows[0]?.media).toHaveLength(10);
      expect(result.rows[0]?.media[0]).toEqual({
        type: "gallery_image",
        url: "gallery-1.webp",
        alt: "Pool at sunset",
      });
      expect(result.rows[0]?.media.at(-1)).toEqual({
        type: "gallery_image",
        url: "gallery-10.webp",
      });
    });
  },
);
