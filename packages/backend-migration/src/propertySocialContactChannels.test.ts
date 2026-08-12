import { readFile } from "node:fs/promises";
import { join } from "node:path";

import pg from "pg";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { assertSafeTestDatabase } from "./testUtils.js";

const migration = await readFile(
  join(import.meta.dirname, "../migrations/0064_property_social_contact_channels.sql"),
  "utf8",
);
const TEST_DATABASE_URL = process.env["TEST_DATABASE_URL"];

describe("property social contact channel migration contract", () => {
  it("extends the canonical contact vocabulary without removing existing channels", () => {
    for (const channel of [
      "phone",
      "email",
      "whatsapp",
      "website",
      "instagram",
      "facebook",
      "tiktok",
      "youtube",
      "x",
    ]) {
      expect(migration).toContain(`'${channel}'`);
    }
    expect(migration).toContain("chk_property_contact_channels_channel_type");
  });
});

describe.skipIf(!TEST_DATABASE_URL)("property social contact channels (PostgreSQL)", () => {
  let client: pg.Client;

  beforeEach(async () => {
    assertSafeTestDatabase(TEST_DATABASE_URL!);
    client = new pg.Client({ connectionString: TEST_DATABASE_URL });
    await client.connect();
    await client.query(`
      DROP SCHEMA IF EXISTS hotel_catalog CASCADE;
      CREATE SCHEMA hotel_catalog;
      CREATE TABLE hotel_catalog.property_contact_channels (
        channel_type TEXT NOT NULL
          CHECK (channel_type IN ('phone', 'email', 'whatsapp', 'website', 'instagram', 'facebook', 'x'))
      );
    `);
  });

  afterEach(async () => {
    try {
      await client.query("DROP SCHEMA IF EXISTS hotel_catalog CASCADE");
    } finally {
      await client.end();
    }
  });

  it("persists TikTok and YouTube while continuing to reject unknown channels", async () => {
    await client.query(migration);
    await client.query(
      "INSERT INTO hotel_catalog.property_contact_channels (channel_type) VALUES ('tiktok'), ('youtube')",
    );

    await expect(
      client.query(
        "INSERT INTO hotel_catalog.property_contact_channels (channel_type) VALUES ('telegram')",
      ),
    ).rejects.toMatchObject({
      code: "23514",
      constraint: "chk_property_contact_channels_channel_type",
    });
  });
});
