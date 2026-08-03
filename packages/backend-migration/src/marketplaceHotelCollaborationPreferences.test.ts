import { readFile } from "node:fs/promises";
import { join } from "node:path";

import pg from "pg";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { assertSafeTestDatabase } from "./testUtils.js";

const migration = await readFile(
  join(import.meta.dirname, "../migrations/0056_marketplace_hotel_collaboration_preferences.sql"),
  "utf8",
);
const TEST_DATABASE_URL = process.env["TEST_DATABASE_URL"];

const ORGANIZATION_ID = "10000000-0000-4000-8000-000000000001";
const OTHER_ORGANIZATION_ID = "10000000-0000-4000-8000-000000000002";
const USER_ID = "20000000-0000-4000-8000-000000000001";
const PROPERTY_ID = "30000000-0000-4000-8000-000000000001";
const OTHER_PROPERTY_ID = "30000000-0000-4000-8000-000000000002";

describe("Marketplace hotel collaboration preference migration contract", () => {
  it("owns only the canonical aggregate and exact Marketplace profile scope", () => {
    expect(migration).toContain("CREATE TABLE marketplace.hotel_collaboration_preferences");
    expect(migration).toContain("FOREIGN KEY (property_id, organization_id)");
    expect(migration).toContain(
      "REFERENCES marketplace.marketplace_hotel_profiles(property_id, organization_id)",
    );
    expect(migration).not.toMatch(
      /\b(?:readiness_status|readiness_revision|profile_complete|submission_status)\b/i,
    );
    expect(migration).not.toMatch(
      /\b(?:INSERT INTO|UPDATE|DELETE FROM)\s+marketplace\.(?:listing_collaboration_offerings|marketplace_hotel_listings)\b/i,
    );
  });

  it("defines the exact canonical four-group storage vocabulary", () => {
    expect(migration).toContain(
      "marketplace.hotel_collaboration_preference_selection_is_canonical",
    );
    expect(migration).toContain("ARRAY['free_stay', 'paid', 'discount', 'affiliate']::TEXT[]");
    expect(migration).toContain(
      "ARRAY['instagram', 'tiktok', 'youtube', 'facebook', 'blog', 'x', 'other']::TEXT[]",
    );
    expect(migration).toContain(
      "'post', 'story', 'short_form_video', 'long_form_video', 'photography', 'other'",
    );
    expect(migration).toContain(
      "marketplace.hotel_collaboration_preference_months_are_canonical(selected_months)",
    );
    expect(migration).toContain(
      "availability_mode = 'year_round' AND cardinality(selected_months) = 0",
    );
    expect(migration).toContain(
      "availability_mode = 'selected_months' AND cardinality(selected_months) > 0",
    );
  });

  it("requires explicit answers and monotonic bounded revisions", () => {
    expect(migration).not.toMatch(/\bDEFAULT\b/i);
    expect(migration).toContain("revision BETWEEN 1 AND 2147483647");
    expect(migration).toContain("TG_OP = 'INSERT' AND NEW.revision <> 1");
    expect(migration).toContain("TG_OP = 'UPDATE' AND NEW.revision <> OLD.revision + 1");
  });
});

describe.skipIf(!TEST_DATABASE_URL)(
  "Marketplace hotel collaboration preference migration (PostgreSQL)",
  () => {
    let client: pg.Client;

    beforeEach(async () => {
      assertSafeTestDatabase(TEST_DATABASE_URL!);
      client = new pg.Client({ connectionString: TEST_DATABASE_URL });
      await client.connect();
      await client.query(`
        DROP SCHEMA IF EXISTS marketplace CASCADE;
        DROP SCHEMA IF EXISTS identity CASCADE;
        CREATE SCHEMA identity;
        CREATE SCHEMA marketplace;

        CREATE TABLE identity.users (id UUID PRIMARY KEY);
        CREATE TABLE marketplace.marketplace_hotel_profiles (
          property_id UUID PRIMARY KEY,
          organization_id UUID NOT NULL,
          UNIQUE (property_id, organization_id)
        );

        INSERT INTO identity.users VALUES ('${USER_ID}');
        INSERT INTO marketplace.marketplace_hotel_profiles VALUES
          ('${PROPERTY_ID}', '${ORGANIZATION_ID}'),
          ('${OTHER_PROPERTY_ID}', '${ORGANIZATION_ID}');
      `);
      await client.query(migration);
    });

    afterEach(async () => {
      try {
        await client.query("DROP SCHEMA IF EXISTS marketplace CASCADE");
        await client.query("DROP SCHEMA IF EXISTS identity CASCADE");
      } finally {
        await client.end();
      }
    });

    it("requires explicit revision one and exact property/organization profile scope", async () => {
      await insertPreferences(client, PROPERTY_ID, ORGANIZATION_ID, 1);

      await expect(
        insertPreferences(client, OTHER_PROPERTY_ID, ORGANIZATION_ID, 2),
      ).rejects.toMatchObject({
        code: "23514",
        constraint: "chk_marketplace_hotel_collaboration_preferences_revision_transition",
      });
      await expect(
        insertPreferences(client, OTHER_PROPERTY_ID, OTHER_ORGANIZATION_ID, 1),
      ).rejects.toMatchObject({
        code: "23503",
        constraint: "fk_marketplace_hotel_collaboration_preferences_profile",
      });

      await expect(
        client.query(
          `UPDATE marketplace.hotel_collaboration_preferences
           SET revision = 3, updated_at = now()
           WHERE property_id = $1::uuid`,
          [PROPERTY_ID],
        ),
      ).rejects.toMatchObject({
        code: "23514",
        constraint: "chk_marketplace_hotel_collaboration_preferences_revision_transition",
      });
      await client.query(
        `UPDATE marketplace.hotel_collaboration_preferences
         SET revision = 2, updated_at = now()
         WHERE property_id = $1::uuid AND revision = 1`,
        [PROPERTY_ID],
      );
      const stored = await client.query<{ revision: number }>(
        `SELECT revision FROM marketplace.hotel_collaboration_preferences
         WHERE property_id = $1::uuid`,
        [PROPERTY_ID],
      );
      expect(stored.rows).toEqual([{ revision: 2 }]);
    });

    it("provides no schema default for a selection, mode, or revision answer", async () => {
      const defaults = await client.query<{ columnName: string; columnDefault: string | null }>(
        `SELECT column_name AS "columnName", column_default AS "columnDefault"
         FROM information_schema.columns
         WHERE table_schema = 'marketplace'
           AND table_name = 'hotel_collaboration_preferences'
           AND column_name = ANY($1::text[])
         ORDER BY column_name`,
        [
          [
            "revision",
            "compensation_types",
            "content_platforms",
            "content_types",
            "availability_mode",
            "selected_months",
          ],
        ],
      );
      expect(defaults.rows).toHaveLength(6);
      expect(defaults.rows.every(({ columnDefault }) => columnDefault === null)).toBe(true);
    });

    it("rejects null, empty, unknown, duplicate, and non-canonical selections", async () => {
      await insertPreferences(client, PROPERTY_ID, ORGANIZATION_ID, 1);
      for (const selection of invalidSelections()) {
        await expect(
          client.query(
            `UPDATE marketplace.hotel_collaboration_preferences
             SET revision = revision + 1,
                 ${selection.column} = ${selection.expression},
                 updated_at = now()
             WHERE property_id = $1::uuid`,
            [PROPERTY_ID],
          ),
        ).rejects.toMatchObject(selection.expected);
      }
      const revision = await currentRevision(client);
      expect(revision).toBe(1);
    });

    it("requires canonical months and an explicit matching availability mode", async () => {
      await insertPreferences(client, PROPERTY_ID, ORGANIZATION_ID, 1);
      for (const statement of [
        "availability_mode = 'selected_months', selected_months = NULL",
        "availability_mode = 'selected_months', selected_months = '{}'::smallint[]",
        "availability_mode = 'year_round', selected_months = ARRAY[1]::smallint[]",
        "availability_mode = 'selected_months', selected_months = ARRAY[1, 1]::smallint[]",
        "availability_mode = 'selected_months', selected_months = ARRAY[2, 1]::smallint[]",
        "availability_mode = 'selected_months', selected_months = ARRAY[0]::smallint[]",
        "availability_mode = 'selected_months', selected_months = ARRAY[13]::smallint[]",
        "availability_mode = 'sometimes', selected_months = '{}'::smallint[]",
      ]) {
        await expect(
          client.query(
            `UPDATE marketplace.hotel_collaboration_preferences
             SET revision = revision + 1, ${statement}, updated_at = now()
             WHERE property_id = $1::uuid`,
            [PROPERTY_ID],
          ),
        ).rejects.toMatchObject({ code: expect.stringMatching(/^235(?:02|14)$/) });
      }

      await client.query(
        `UPDATE marketplace.hotel_collaboration_preferences
         SET revision = revision + 1,
             availability_mode = 'selected_months',
             selected_months = ARRAY[1, 6, 12]::smallint[],
             updated_at = now()
         WHERE property_id = $1::uuid AND revision = 1`,
        [PROPERTY_ID],
      );
      const stored = await client.query<{ mode: string; months: number[]; revision: number }>(
        `SELECT availability_mode AS mode, selected_months AS months, revision
         FROM marketplace.hotel_collaboration_preferences
         WHERE property_id = $1::uuid`,
        [PROPERTY_ID],
      );
      expect(stored.rows).toEqual([{ mode: "selected_months", months: [1, 6, 12], revision: 2 }]);
    });
  },
);

async function insertPreferences(
  client: pg.Client,
  propertyId: string,
  organizationId: string,
  revision: number,
): Promise<void> {
  await client.query(
    `INSERT INTO marketplace.hotel_collaboration_preferences (
       property_id, organization_id, contract_version, revision,
       compensation_types, content_platforms, content_types,
       availability_mode, selected_months, updated_by_user_id,
       created_at, updated_at
     ) VALUES (
       $1::uuid, $2::uuid, 'marketplace-hotel-collaboration-preferences.v1', $3,
       ARRAY['free_stay', 'paid']::text[],
       ARRAY['instagram', 'youtube']::text[],
       ARRAY['post', 'photography']::text[],
       'year_round', '{}'::smallint[], $4::uuid, now(), now()
     )`,
    [propertyId, organizationId, revision, USER_ID],
  );
}

function invalidSelections(): Array<{
  column: "compensation_types" | "content_platforms" | "content_types";
  expression: string;
  expected: { code: string; column?: string; constraint?: string };
}> {
  return [
    ...invalidSelectionCases(
      "compensation_types",
      "free_stay",
      "paid",
      "chk_marketplace_hotel_collaboration_preferences_compensation",
    ),
    ...invalidSelectionCases(
      "content_platforms",
      "instagram",
      "tiktok",
      "chk_marketplace_hotel_collaboration_preferences_platforms",
    ),
    ...invalidSelectionCases(
      "content_types",
      "post",
      "story",
      "chk_marketplace_hotel_collaboration_preferences_content",
    ),
  ];
}

function invalidSelectionCases(
  column: "compensation_types" | "content_platforms" | "content_types",
  first: string,
  second: string,
  constraint: string,
) {
  return [
    { column, expression: "NULL", expected: { code: "23502", column } },
    {
      column,
      expression: "'{}'::text[]",
      expected: { code: "23514", constraint },
    },
    {
      column,
      expression: "ARRAY['unknown']::text[]",
      expected: { code: "23514", constraint },
    },
    {
      column,
      expression: `ARRAY['${first}', '${first}']::text[]`,
      expected: { code: "23514", constraint },
    },
    {
      column,
      expression: `ARRAY['${second}', '${first}']::text[]`,
      expected: { code: "23514", constraint },
    },
  ];
}

async function currentRevision(client: pg.Client): Promise<number> {
  const result = await client.query<{ revision: number }>(
    `SELECT revision FROM marketplace.hotel_collaboration_preferences
     WHERE property_id = $1::uuid`,
    [PROPERTY_ID],
  );
  return result.rows[0]!.revision;
}
