import { readFile } from "node:fs/promises";
import { join } from "node:path";

import pg from "pg";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { assertSafeTestDatabase } from "./testUtils.js";

const migration = await readFile(
  join(import.meta.dirname, "../migrations/0091_pms_private_note_edits.sql"),
  "utf8",
);
const TEST_DATABASE_URL = process.env["TEST_DATABASE_URL"];

describe("PMS private note edit migration", () => {
  it("adds nullable latest-edit evidence without replacing creation evidence", () => {
    expect(migration).toContain("ALTER TABLE pms.booking_notes_private");
    expect(migration).toContain("edited_by_user_id UUID REFERENCES identity.users(id)");
    expect(migration).toContain("edited_by_display_name TEXT");
    expect(migration).toContain("edited_at TIMESTAMPTZ");
    expect(migration).toContain("chk_pms_private_note_edit_metadata");
    expect(migration).not.toMatch(/\bDROP\s+COLUMN\b/i);
  });
});

describe.skipIf(!TEST_DATABASE_URL)("PMS private note edits (PostgreSQL)", () => {
  let client: pg.Client;

  beforeEach(async () => {
    assertSafeTestDatabase(TEST_DATABASE_URL!);
    client = new pg.Client({ connectionString: TEST_DATABASE_URL });
    await client.connect();
    await client.query(`
      DROP SCHEMA IF EXISTS pms CASCADE;
      DROP SCHEMA IF EXISTS identity CASCADE;
      CREATE SCHEMA identity;
      CREATE SCHEMA pms;
      CREATE TABLE identity.users (id UUID PRIMARY KEY);
      CREATE TABLE pms.booking_notes_private (
        id UUID PRIMARY KEY,
        author_user_id UUID REFERENCES identity.users(id),
        author_display_name TEXT NOT NULL,
        body TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL
      );
    `);
    await client.query(migration);
  });

  afterEach(async () => {
    try {
      await client.query(
        "DROP SCHEMA IF EXISTS pms CASCADE; DROP SCHEMA IF EXISTS identity CASCADE",
      );
    } finally {
      await client.end();
    }
  });

  it("preserves creation evidence and retains the editor name after account deletion", async () => {
    const authorId = "11111111-1111-4111-8111-111111111111";
    const editorId = "22222222-2222-4222-8222-222222222222";
    const noteId = "33333333-3333-4333-8333-333333333333";
    await client.query("INSERT INTO identity.users (id) VALUES ($1), ($2)", [authorId, editorId]);
    await client.query(
      `INSERT INTO pms.booking_notes_private
         (id, author_user_id, author_display_name, body, created_at)
       VALUES ($1, $2, 'Original author', 'Original note', '2026-08-01T10:00:00Z')`,
      [noteId, authorId],
    );
    await client.query(
      `UPDATE pms.booking_notes_private
       SET body = 'Corrected note', edited_by_user_id = $2,
           edited_by_display_name = 'Editing host', edited_at = '2026-08-02T11:00:00Z'
       WHERE id = $1`,
      [noteId, editorId],
    );
    await client.query("DELETE FROM identity.users WHERE id = $1", [editorId]);

    const result = await client.query(`SELECT * FROM pms.booking_notes_private WHERE id = $1`, [
      noteId,
    ]);
    expect(result.rows[0]).toMatchObject({
      author_user_id: authorId,
      author_display_name: "Original author",
      body: "Corrected note",
      edited_by_user_id: null,
      edited_by_display_name: "Editing host",
    });
  });

  it("rejects partial or blank edit metadata", async () => {
    await expect(
      client.query(
        `INSERT INTO pms.booking_notes_private
           (id, author_display_name, body, created_at, edited_at)
         VALUES ('44444444-4444-4444-8444-444444444444', 'Author', 'Note', now(), now())`,
      ),
    ).rejects.toMatchObject({ code: "23514", constraint: "chk_pms_private_note_edit_metadata" });
  });
});
