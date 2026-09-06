import { createHash } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  computeChecksum,
  discoverMigrations,
  isNonTransactionalMigration,
  runMigrations,
  splitNonTransactionalMigration,
} from "./runner.js";
import { DEFAULT_REBUILD_SCHEMAS } from "./targetSchemas.js";
import { assertSafeTestDatabase } from "./testUtils.js";

// ---------------------------------------------------------------------------
// Pure unit tests — no database required
// ---------------------------------------------------------------------------

describe("computeChecksum", () => {
  it("returns a stable sha256 hex string", () => {
    const content = "SELECT 1;";
    const expected = createHash("sha256").update(content, "utf8").digest("hex");
    expect(computeChecksum(content)).toBe(expected);
  });

  it("returns different checksums for different content", () => {
    expect(computeChecksum("SELECT 1;")).not.toBe(computeChecksum("SELECT 2;"));
  });

  it("is sensitive to whitespace differences", () => {
    expect(computeChecksum("SELECT 1;")).not.toBe(computeChecksum("SELECT 1; "));
  });
});

describe("discoverMigrations", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = join(tmpdir(), `backend-migration-test-${Date.now()}`);
    await mkdir(tmpDir, { recursive: true });
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("returns an empty array for an empty directory", async () => {
    expect(await discoverMigrations(tmpDir)).toEqual([]);
  });

  it("discovers and sorts migration files by version", async () => {
    await writeFile(join(tmpDir, "0002_catalog.sql"), "SELECT 1;");
    await writeFile(join(tmpDir, "0001_identity.sql"), "SELECT 1;");

    const files = await discoverMigrations(tmpDir);
    expect(files.map((f) => f.version)).toEqual(["0001", "0002"]);
    expect(files[0].name).toBe("identity");
    expect(files[1].name).toBe("catalog");
  });

  it("ignores files that do not match the migration filename pattern", async () => {
    await writeFile(join(tmpDir, "seed.sql"), "SELECT 1;");
    await writeFile(join(tmpDir, "README.md"), "docs");
    await writeFile(join(tmpDir, "0001_identity.sql"), "SELECT 1;");

    const files = await discoverMigrations(tmpDir);
    expect(files).toHaveLength(1);
    expect(files[0].filename).toBe("0001_identity.sql");
  });

  it("rejects duplicate migration versions", async () => {
    await writeFile(join(tmpDir, "0001_identity.sql"), "SELECT 1;");
    await writeFile(join(tmpDir, "0001_catalog.sql"), "SELECT 2;");

    await expect(discoverMigrations(tmpDir)).rejects.toThrow("Duplicate migration version 0001");
  });

  it("exposes version, name, filename, and path on each result", async () => {
    await writeFile(join(tmpDir, "0001_identity.sql"), "SELECT 1;");

    const [file] = await discoverMigrations(tmpDir);
    expect(file.version).toBe("0001");
    expect(file.name).toBe("identity");
    expect(file.filename).toBe("0001_identity.sql");
    expect(file.path).toBe(join(tmpDir, "0001_identity.sql"));
  });
});

describe("isNonTransactionalMigration", () => {
  it("recognizes only the explicit standalone directive", () => {
    expect(isNonTransactionalMigration("-- vayada:no-transaction\nSELECT 1;")).toBe(true);
    expect(isNonTransactionalMigration("  -- vayada:no-transaction  \nSELECT 1;")).toBe(true);
    expect(isNonTransactionalMigration("-- mentions vayada:no-transaction\nSELECT 1;")).toBe(false);
  });

  it("splits explicit non-transactional statement boundaries", () => {
    expect(
      splitNonTransactionalMigration(
        "-- vayada:no-transaction\nDROP INDEX CONCURRENTLY IF EXISTS example;\n" +
          "-- vayada:next-statement\nCREATE INDEX CONCURRENTLY example ON target (id);",
      ),
    ).toEqual([
      "-- vayada:no-transaction\nDROP INDEX CONCURRENTLY IF EXISTS example;",
      "CREATE INDEX CONCURRENTLY example ON target (id);",
    ]);
  });
});

// ---------------------------------------------------------------------------
// Integration tests — require TEST_DATABASE_URL
// ---------------------------------------------------------------------------

const TEST_DATABASE_URL = process.env["TEST_DATABASE_URL"];
const __dirname = dirname(fileURLToPath(import.meta.url));
const REAL_MIGRATIONS_DIR = join(__dirname, "../migrations");

describe.skipIf(!TEST_DATABASE_URL)("runMigrations (integration)", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = join(tmpdir(), `backend-migration-int-${Date.now()}`);
    await mkdir(tmpDir, { recursive: true });
    await resetRunnerSchemas();
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
    await resetRunnerSchemas();
  });

  async function resetRunnerSchemas() {
    assertSafeTestDatabase(TEST_DATABASE_URL!);

    const client = new pg.Client({ connectionString: TEST_DATABASE_URL });
    await client.connect();
    try {
      await client.query(`DROP SCHEMA IF EXISTS platform CASCADE`);
      await client.query(`DROP SCHEMA IF EXISTS migration_runner_test CASCADE`);
    } finally {
      await client.end();
    }
  }

  it("applies a trivial migration and records a ledger row with status applied", async () => {
    await writeFile(
      join(tmpDir, "0001_test.sql"),
      `CREATE SCHEMA IF NOT EXISTS migration_runner_test;`,
    );

    const result = await runMigrations({
      connectionString: TEST_DATABASE_URL!,
      migrationsDir: tmpDir,
      environment: "local",
      appliedBy: "test",
      gitSha: "0123456789abcdef0123456789abcdef01234567",
    });

    expect(result.applied).toEqual(["0001"]);
    expect(result.skipped).toEqual([]);
    expect(result.failed).toBeNull();

    const client = new pg.Client({ connectionString: TEST_DATABASE_URL });
    await client.connect();
    try {
      const { rows } = await client.query<{
        version: string;
        name: string;
        status: string;
        checksum_sha256: string;
        applied_by: string;
        git_sha: string | null;
        failure_reason: string | null;
      }>(
        `SELECT version, name, status, checksum_sha256, applied_by, git_sha, failure_reason
         FROM platform.schema_migrations WHERE version = '0001'`,
      );
      expect(rows).toHaveLength(1);
      expect(rows[0].version).toBe("0001");
      expect(rows[0].name).toBe("test");
      expect(rows[0].status).toBe("applied");
      expect(rows[0].applied_by).toBe("test");
      expect(rows[0].git_sha).toBe("0123456789abcdef0123456789abcdef01234567");
      expect(rows[0].failure_reason).toBeNull();
      expect(rows[0].checksum_sha256).toBe(
        computeChecksum(`CREATE SCHEMA IF NOT EXISTS migration_runner_test;`),
      );
    } finally {
      await client.end();
    }
  });

  it("skips an already-applied migration with matching checksum on re-run", async () => {
    await writeFile(
      join(tmpDir, "0001_test.sql"),
      `CREATE SCHEMA IF NOT EXISTS migration_runner_test;`,
    );

    const config = {
      connectionString: TEST_DATABASE_URL!,
      migrationsDir: tmpDir,
      environment: "local" as const,
      appliedBy: "test",
    };

    await runMigrations(config);
    const second = await runMigrations(config);

    expect(second.applied).toEqual([]);
    expect(second.skipped).toEqual(["0001"]);
    expect(second.failed).toBeNull();
  });

  it("runs explicitly non-transactional migrations outside a transaction", async () => {
    await writeFile(
      join(tmpDir, "0001_table.sql"),
      `CREATE SCHEMA migration_runner_test;
       CREATE TABLE migration_runner_test.concurrent_index (id UUID PRIMARY KEY, scope_id UUID NOT NULL);`,
    );
    await writeFile(
      join(tmpDir, "0002_index.sql"),
      `-- vayada:no-transaction\nDROP INDEX CONCURRENTLY IF EXISTS migration_runner_test.uq_migration_runner_concurrent_index;\n-- vayada:next-statement\nCREATE UNIQUE INDEX CONCURRENTLY uq_migration_runner_concurrent_index\n  ON migration_runner_test.concurrent_index (id, scope_id);`,
    );

    const result = await runMigrations({
      connectionString: TEST_DATABASE_URL!,
      migrationsDir: tmpDir,
      environment: "local",
      appliedBy: "test",
    });

    expect(result).toMatchObject({ applied: ["0001", "0002"], failed: null });

    const client = new pg.Client({ connectionString: TEST_DATABASE_URL });
    await client.connect();
    try {
      const { rows } = await client.query<{ is_valid: boolean }>(
        `SELECT indisvalid AS is_valid
         FROM pg_index
         WHERE indexrelid = 'migration_runner_test.uq_migration_runner_concurrent_index'::regclass`,
      );
      expect(rows).toEqual([{ is_valid: true }]);
    } finally {
      await client.end();
    }
  });

  it("fails and records a ledger row when a previously applied migration file is modified", async () => {
    const filePath = join(tmpDir, "0001_test.sql");
    await writeFile(filePath, `CREATE SCHEMA IF NOT EXISTS migration_runner_test;`);

    const config = {
      connectionString: TEST_DATABASE_URL!,
      migrationsDir: tmpDir,
      environment: "local" as const,
      appliedBy: "test",
    };

    await runMigrations(config);

    // Modify the file after it has been applied
    await writeFile(filePath, `CREATE SCHEMA IF NOT EXISTS migration_runner_test; -- tampered`);

    const result = await runMigrations(config);

    expect(result.applied).toEqual([]);
    expect(result.skipped).toEqual([]);
    expect(result.failed).toBe("0001");

    const client = new pg.Client({ connectionString: TEST_DATABASE_URL });
    await client.connect();
    try {
      const { rows } = await client.query<{ status: string; failure_reason: string }>(
        `SELECT status, failure_reason FROM platform.schema_migrations
         WHERE version = '0001' AND status = 'failed'`,
      );
      expect(rows).toHaveLength(1);
      expect(rows[0].status).toBe("failed");
      expect(rows[0].failure_reason).toMatch(/Checksum mismatch/);
    } finally {
      await client.end();
    }
  });
});

describe.skipIf(!TEST_DATABASE_URL)("target schema migrations (integration)", () => {
  afterEach(async () => {
    assertSafeTestDatabase(TEST_DATABASE_URL!);

    const client = new pg.Client({ connectionString: TEST_DATABASE_URL });
    await client.connect();
    try {
      for (const schema of DEFAULT_REBUILD_SCHEMAS) {
        await client.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      }
    } finally {
      await client.end();
    }
  });

  it("repairs missing Marketplace offer operator links without reactivating existing links", async () => {
    assertSafeTestDatabase(TEST_DATABASE_URL!);

    const client = new pg.Client({ connectionString: TEST_DATABASE_URL });
    await client.connect();
    try {
      for (const schema of DEFAULT_REBUILD_SCHEMAS) {
        await client.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      }

      await client.query(`
        CREATE SCHEMA identity;
        CREATE SCHEMA marketplace;

        CREATE TABLE marketplace.marketplace_offers (
          id UUID PRIMARY KEY,
          organization_id UUID NOT NULL,
          offer_status TEXT NOT NULL
        );

        CREATE TABLE identity.organization_resource_links (
          organization_id UUID NOT NULL,
          product TEXT NOT NULL,
          resource_type TEXT NOT NULL,
          resource_id TEXT NOT NULL,
          relationship TEXT NOT NULL,
          status TEXT NOT NULL,
          updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
          UNIQUE (organization_id, product, resource_type, resource_id, relationship)
        );

        INSERT INTO marketplace.marketplace_offers (id, organization_id, offer_status)
        VALUES
          ('10000000-0000-4000-8000-000000000001', '20000000-0000-4000-8000-000000000001', 'verified'),
          ('10000000-0000-4000-8000-000000000002', '20000000-0000-4000-8000-000000000001', 'verified'),
          ('10000000-0000-4000-8000-000000000003', '20000000-0000-4000-8000-000000000001', 'verified');

        INSERT INTO identity.organization_resource_links (
          organization_id,
          product,
          resource_type,
          resource_id,
          relationship,
          status
        )
        VALUES
          ('20000000-0000-4000-8000-000000000001', 'marketplace', 'marketplace_offer', '10000000-0000-4000-8000-000000000001', 'owner', 'active'),
          ('20000000-0000-4000-8000-000000000001', 'marketplace', 'marketplace_offer', '10000000-0000-4000-8000-000000000002', 'owner', 'active'),
          ('20000000-0000-4000-8000-000000000001', 'marketplace', 'marketplace_offer', '10000000-0000-4000-8000-000000000003', 'owner', 'active'),
          ('20000000-0000-4000-8000-000000000001', 'marketplace', 'marketplace_offer', '10000000-0000-4000-8000-000000000001', 'operator', 'suspended'),
          ('20000000-0000-4000-8000-000000000001', 'marketplace', 'marketplace_offer', '10000000-0000-4000-8000-000000000002', 'operator', 'archived');
      `);

      const migrationSql = await readFile(
        join(REAL_MIGRATIONS_DIR, "0039_repair_marketplace_offer_operator_links.sql"),
        "utf8",
      );
      await client.query(migrationSql);

      const { rows } = await client.query<{ resource_id: string; status: string }>(`
        SELECT resource_id, status
        FROM identity.organization_resource_links
        WHERE product = 'marketplace'
          AND resource_type = 'marketplace_offer'
          AND relationship = 'operator'
        ORDER BY resource_id
      `);

      expect(rows).toEqual([
        { resource_id: "10000000-0000-4000-8000-000000000001", status: "suspended" },
        { resource_id: "10000000-0000-4000-8000-000000000002", status: "archived" },
        { resource_id: "10000000-0000-4000-8000-000000000003", status: "active" },
      ]);
    } finally {
      await client.end();
    }
  });

  it("creates constrained organization setup track intents without backfilling", async () => {
    assertSafeTestDatabase(TEST_DATABASE_URL!);

    const client = new pg.Client({ connectionString: TEST_DATABASE_URL });
    await client.connect();
    try {
      for (const schema of DEFAULT_REBUILD_SCHEMAS) {
        await client.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      }

      await client.query(`
        CREATE SCHEMA identity;
        CREATE SCHEMA hotel_catalog;
        CREATE TABLE identity.organizations (id UUID PRIMARY KEY);

        INSERT INTO identity.organizations (id)
        SELECT (
          '00000000-0000-4000-8000-' || lpad(value::text, 12, '0')
        )::UUID
        FROM generate_series(1, 8) AS value;
      `);

      const migrationSql = await readFile(
        join(REAL_MIGRATIONS_DIR, "0041_adaptive_hotel_setup.sql"),
        "utf8",
      );
      await client.query(migrationSql);

      const { rows: initialRows } = await client.query(
        `SELECT organization_id
         FROM hotel_catalog.organization_setup_track_intents`,
      );
      expect(initialRows).toHaveLength(0);

      const organizationId = (suffix: number) =>
        `00000000-0000-4000-8000-${String(suffix).padStart(12, "0")}`;
      const { rows: canonicalRows } = await client.query<{
        selected_tracks: string[];
        revision: number;
        has_timestamps: boolean;
      }>(
        `INSERT INTO hotel_catalog.organization_setup_track_intents
           (organization_id, selected_tracks)
         VALUES
           ($1, ARRAY['hotel_operations']),
           ($2, ARRAY['creator_marketplace']),
           ($3, ARRAY['hotel_operations', 'creator_marketplace'])
         RETURNING
           selected_tracks,
           revision,
           created_at IS NOT NULL AND updated_at IS NOT NULL AS has_timestamps`,
        [organizationId(1), organizationId(2), organizationId(3)],
      );
      expect(canonicalRows.map((row) => row.selected_tracks)).toEqual([
        ["hotel_operations"],
        ["creator_marketplace"],
        ["hotel_operations", "creator_marketplace"],
      ]);
      expect(canonicalRows.every((row) => row.revision === 1 && row.has_timestamps)).toBe(true);

      const invalidSelections = [
        [],
        ["booking"],
        ["creator_marketplace", "hotel_operations"],
        ["hotel_operations", "hotel_operations"],
      ];
      for (const [index, selectedTracks] of invalidSelections.entries()) {
        await expect(
          client.query(
            `INSERT INTO hotel_catalog.organization_setup_track_intents
               (organization_id, selected_tracks)
             VALUES ($1, $2::TEXT[])`,
            [organizationId(index + 4), selectedTracks],
          ),
        ).rejects.toMatchObject({ code: "23514" });
      }

      await expect(
        client.query(
          `INSERT INTO hotel_catalog.organization_setup_track_intents
             (organization_id, selected_tracks, revision)
           VALUES ($1, ARRAY['hotel_operations'], 0)`,
          [organizationId(8)],
        ),
      ).rejects.toMatchObject({ code: "23514" });

      await expect(
        client.query(
          `INSERT INTO hotel_catalog.organization_setup_track_intents
             (organization_id, selected_tracks)
           VALUES ($1, ARRAY['creator_marketplace'])`,
          [organizationId(1)],
        ),
      ).rejects.toMatchObject({ code: "23505" });

      await expect(
        client.query(
          `INSERT INTO hotel_catalog.organization_setup_track_intents
             (organization_id, selected_tracks)
           VALUES ('00000000-0000-4000-8000-000000000099', ARRAY['hotel_operations'])`,
        ),
      ).rejects.toMatchObject({ code: "23503" });
    } finally {
      await client.end();
    }
  });

  it("creates bounded property setup sessions and per-step drafts", async () => {
    assertSafeTestDatabase(TEST_DATABASE_URL!);

    const client = new pg.Client({ connectionString: TEST_DATABASE_URL });
    await client.connect();
    try {
      for (const schema of DEFAULT_REBUILD_SCHEMAS) {
        await client.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      }

      await client.query(`
        CREATE SCHEMA identity;
        CREATE SCHEMA hotel_catalog;
        CREATE TABLE identity.organizations (id UUID PRIMARY KEY);
        CREATE TABLE hotel_catalog.properties (id UUID PRIMARY KEY);

        INSERT INTO identity.organizations (id)
        VALUES ('00000000-0000-4000-8000-000000000001');
        INSERT INTO hotel_catalog.properties (id)
        SELECT (
          '10000000-0000-4000-8000-' || lpad(value::TEXT, 12, '0')
        )::UUID
        FROM generate_series(1, 4) AS value;
      `);

      const migrationSql = await readFile(
        join(REAL_MIGRATIONS_DIR, "0045_property_setup_drafts.sql"),
        "utf8",
      );
      await client.query(migrationSql);

      const {
        rows: [session],
      } = await client.query<{ id: string }>(
        `INSERT INTO hotel_catalog.property_setup_sessions (
           organization_id,
           property_id,
           selected_tracks,
           track_revision,
           resume_step_id,
           retention_expires_at
         )
         VALUES (
           '00000000-0000-4000-8000-000000000001',
           '10000000-0000-4000-8000-000000000001',
           ARRAY['hotel_operations', 'creator_marketplace'],
           1,
           'present_hotel',
           now() + INTERVAL '90 days'
         )
         RETURNING id::TEXT AS id`,
      );

      const {
        rows: [draft],
      } = await client.query<{
        payload: Record<string, unknown>;
        dirty_fields: string[];
        base_revisions: Record<string, unknown>;
        revision: number;
      }>(
        `INSERT INTO hotel_catalog.property_setup_step_drafts (
           session_id,
           step_id,
           payload,
           dirty_fields,
           base_revisions,
           retention_expires_at
         )
         VALUES (
           $1::UUID,
           'present_hotel',
           '{"profile.short_description": null}'::JSONB,
           ARRAY['profile.short_description'],
           '{
             "hotel_catalog.profile": "profile:1",
             "hotel_catalog.media": "media:1",
             "hotel_catalog.amenities": "amenities:1"
           }'::JSONB,
           now() + INTERVAL '90 days'
         )
         RETURNING payload, dirty_fields, base_revisions, revision`,
        [session!.id],
      );
      expect(draft).toEqual({
        payload: { "profile.short_description": null },
        dirty_fields: ["profile.short_description"],
        base_revisions: {
          "hotel_catalog.profile": "profile:1",
          "hotel_catalog.media": "media:1",
          "hotel_catalog.amenities": "amenities:1",
        },
        revision: 1,
      });

      await expect(
        client.query(
          `INSERT INTO hotel_catalog.property_setup_sessions (
             organization_id,
             property_id,
             selected_tracks,
             track_revision,
             retention_expires_at
           )
           VALUES (
             '00000000-0000-4000-8000-000000000001',
             '10000000-0000-4000-8000-000000000001',
             ARRAY['hotel_operations'],
             1,
             now() + INTERVAL '30 days'
           )`,
        ),
      ).rejects.toMatchObject({ code: "23505" });
      await expect(
        client.query(
          `UPDATE hotel_catalog.property_setup_sessions
           SET completed_step_ids = ARRAY['present_hotel', 'present_hotel']
           WHERE id = $1::UUID`,
          [session!.id],
        ),
      ).rejects.toMatchObject({ code: "23514" });
      await expect(
        client.query(
          `UPDATE hotel_catalog.property_setup_sessions
           SET completed_step_ids = ARRAY['present_hotel', NULL]::TEXT[]
           WHERE id = $1::UUID`,
          [session!.id],
        ),
      ).rejects.toMatchObject({ code: "23514" });
      await expect(
        client.query(
          `UPDATE hotel_catalog.property_setup_sessions
           SET
             status = 'completed',
             completed_at = now(),
             retention_expires_at = now() + INTERVAL '31 days',
             updated_at = now()
           WHERE id = $1::UUID`,
          [session!.id],
        ),
      ).rejects.toMatchObject({ code: "23514" });

      await client.query(
        `UPDATE hotel_catalog.property_setup_sessions
         SET
           status = 'completed',
           completed_at = now(),
           retention_expires_at = now() + INTERVAL '30 days',
           updated_at = now()
         WHERE id = $1::UUID`,
        [session!.id],
      );
      await client.query(
        `INSERT INTO hotel_catalog.property_setup_sessions (
           organization_id,
           property_id,
           selected_tracks,
           track_revision,
           retention_expires_at
         )
         VALUES (
           '00000000-0000-4000-8000-000000000001',
           '10000000-0000-4000-8000-000000000001',
           ARRAY['hotel_operations'],
           2,
           now() + INTERVAL '90 days'
         )`,
      );

      const invalidSessions = [
        {
          tracks: ["creator_marketplace", "hotel_operations"],
          resumeStep: "present_hotel",
          retentionDays: 30,
        },
        { tracks: ["hotel_operations"], resumeStep: "unknown", retentionDays: 30 },
        { tracks: ["hotel_operations"], resumeStep: "present_hotel", retentionDays: 91 },
      ];
      for (const [index, invalid] of invalidSessions.entries()) {
        await expect(
          client.query(
            `INSERT INTO hotel_catalog.property_setup_sessions (
               organization_id,
               property_id,
               selected_tracks,
               track_revision,
               resume_step_id,
               retention_expires_at
             )
             VALUES (
               '00000000-0000-4000-8000-000000000001',
               $4::UUID,
               $1::TEXT[],
               1,
               $2,
               now() + make_interval(days => $3)
             )`,
            [
              invalid.tracks,
              invalid.resumeStep,
              invalid.retentionDays,
              `10000000-0000-4000-8000-${String(index + 2).padStart(12, "0")}`,
            ],
          ),
        ).rejects.toMatchObject({ code: "23514" });
      }

      await expect(
        client.query(
          `INSERT INTO hotel_catalog.property_setup_step_drafts (
             session_id,
             step_id,
             payload,
             retention_expires_at
           )
           VALUES ($1::UUID, 'unknown', '{}'::JSONB, now() + INTERVAL '30 days')`,
          [session!.id],
        ),
      ).rejects.toMatchObject({ code: "23514" });
      await expect(
        client.query(
          `INSERT INTO hotel_catalog.property_setup_step_drafts (
             session_id,
             step_id,
             payload,
             retention_expires_at
           )
           VALUES ($1::UUID, 'review', '[]'::JSONB, now() + INTERVAL '30 days')`,
          [session!.id],
        ),
      ).rejects.toMatchObject({ code: "23514" });

      await client.query(
        `DELETE FROM hotel_catalog.properties
         WHERE id = '10000000-0000-4000-8000-000000000001'`,
      );
      const { rows: remaining } = await client.query(
        `SELECT id FROM hotel_catalog.property_setup_sessions`,
      );
      expect(remaining).toHaveLength(0);
    } finally {
      await client.end();
    }
  });

  it("applies the active target DDL and retires the Ask Intelligence schema", async () => {
    assertSafeTestDatabase(TEST_DATABASE_URL!);

    const client = new pg.Client({ connectionString: TEST_DATABASE_URL });
    await client.connect();
    try {
      for (const schema of DEFAULT_REBUILD_SCHEMAS) {
        await client.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      }
    } finally {
      await client.end();
    }

    const result = await runMigrations({
      connectionString: TEST_DATABASE_URL!,
      migrationsDir: REAL_MIGRATIONS_DIR,
      environment: "local",
      appliedBy: "test",
    });

    expect(result.failed).toBeNull();
    expect(result.applied).toContain("0005");
    expect(result.applied).toContain("0006");
    expect(result.applied).toContain("0007");
    expect(result.applied).toContain("0008");
    expect(result.applied).toContain("0009");
    expect(result.applied).toContain("0010");
    expect(result.applied).toContain("0011");
    expect(result.applied).toContain("0015");
    expect(result.applied).toContain("0016");
    expect(result.applied).toContain("0024");
    expect(result.applied).toContain("0036");
    expect(result.applied).toContain("0037");
    expect(result.applied).toContain("0038");
    expect(result.applied).toContain("0045");
    expect(result.applied).toContain("0046");
    expect(result.applied).toContain("0047");
    expect(result.applied).toContain("0090");
    expect(result.applied).toContain("0113");
    expect(result.applied).toContain("0114");

    const verifyClient = new pg.Client({ connectionString: TEST_DATABASE_URL });
    await verifyClient.connect();
    try {
      const { rows: tableRows } = await verifyClient.query<{ table_name: string }>(
        `SELECT table_name
         FROM information_schema.tables
         WHERE table_schema = 'booking'
         ORDER BY table_name`,
      );

      expect(tableRows.map((row) => row.table_name)).toEqual([
        "addon_definitions",
        "booking_addon_selection_items",
        "booking_addon_selections",
        "booking_change_requests",
        "booking_design_revisions",
        "booking_guests",
        "booking_notes_public",
        "booking_policy_confirmations",
        "booking_publication_attempts",
        "booking_settings",
        "booking_status_events",
        "checkout_contexts",
        "current_working_design_revisions",
        "current_working_guest_policy_revisions",
        "direct_booking_summary_read_model",
        "finance_addon_purchase_evidence",
        "finance_booking_attribution",
        "finance_nightly_revenue_evidence",
        "guest_bookings",
        "guest_policy_projection_receipts",
        "guest_policy_revisions",
        "nightly_revenue_evidence",
        "nightly_revenue_room_scopes",
        "promo_applications",
        "promo_definitions",
        "quote_sessions",
        "same_day_booking_policies",
      ]);

      const { rows: bookingColumns } = await verifyClient.query<{
        table_name: string;
        column_name: string;
      }>(
        `SELECT table_name, column_name
         FROM information_schema.columns
         WHERE table_schema = 'booking'
           AND (
             (table_name = 'booking_addon_selections' AND column_name = 'property_id')
             OR
             (table_name = 'checkout_contexts' AND column_name = 'converted_guest_booking_id')
           )
         ORDER BY table_name, column_name`,
      );

      expect(bookingColumns).toEqual([
        { table_name: "booking_addon_selections", column_name: "property_id" },
      ]);

      const { rows: integrityConstraints } = await verifyClient.query<{
        constraint_name: string;
      }>(
        `SELECT constraint_name
         FROM information_schema.table_constraints
         WHERE table_schema = 'booking'
           AND constraint_name IN (
             'uq_guest_bookings_checkout_context',
             'fk_checkout_contexts_quote_property',
             'fk_guest_bookings_quote_property',
             'fk_guest_bookings_checkout_property',
             'fk_booking_addon_selections_booking_property',
             'fk_booking_addon_selections_quote_property',
             'fk_booking_addon_selections_definition_property',
             'fk_promo_applications_quote_property',
             'fk_promo_applications_booking_property',
             'fk_direct_booking_summary_booking_property',
             'chk_promo_applications_target'
           )
         ORDER BY constraint_name`,
      );

      expect(integrityConstraints.map((row) => row.constraint_name)).toEqual([
        "chk_promo_applications_target",
        "fk_booking_addon_selections_booking_property",
        "fk_booking_addon_selections_definition_property",
        "fk_booking_addon_selections_quote_property",
        "fk_checkout_contexts_quote_property",
        "fk_direct_booking_summary_booking_property",
        "fk_guest_bookings_checkout_property",
        "fk_guest_bookings_quote_property",
        "fk_promo_applications_booking_property",
        "fk_promo_applications_quote_property",
        "uq_guest_bookings_checkout_context",
      ]);

      const { rows: piiColumns } = await verifyClient.query<{ column_name: string }>(
        `SELECT column_name
         FROM information_schema.columns
         WHERE table_schema = 'booking'
           AND table_name = 'direct_booking_summary_read_model'
           AND column_name IN (
             'first_name', 'last_name', 'email', 'phone',
             'special_requests', 'guest_input', 'body'
           )`,
      );

      expect(piiColumns).toHaveLength(0);

      const { rows: pmsTableRows } = await verifyClient.query<{ table_name: string }>(
        `SELECT table_name
         FROM information_schema.tables
         WHERE table_schema = 'pms'
         ORDER BY table_name`,
      );

      expect(pmsTableRows.map((row) => row.table_name)).toEqual([
        "booking_checkin_records",
        "booking_checkout_charges",
        "booking_checkout_records",
        "booking_notes_private",
        "calendar_auto_open_settings",
        "channel_binding_claims",
        "channel_booking_mappings",
        "channel_booking_revision_tombstones",
        "channel_connections",
        "channel_rate_plan_mappings",
        "channel_reviews",
        "channel_room_type_mappings",
        "channel_sync_status",
        "checkin_checklist_templates",
        "checkout_inspection_templates",
        "effective_calendar_auto_open_settings",
        "effective_room_assignment_optimization_settings",
        "flexible_rate_plan_cancellation_extensions",
        "inbox_email_routes",
        "inventory_coverage_validation_queue",
        "inventory_days",
        "inventory_materialization_coverage",
        "inventory_reservation_day_watermarks",
        "inventory_reservation_receipts",
        "inventory_reservation_statuses",
        "linked_inventory_groups",
        "mandatory_charge_confirmation_revisions",
        "message_assistance_results",
        "message_attachments",
        "message_delivery_attempts",
        "message_delivery_receipts",
        "message_internal_notes",
        "message_quick_replies",
        "message_threads",
        "messages",
        "non_refundable_rate_plan_source_rooms",
        "operating_calendar_recurring_periods",
        "operating_calendar_revisions",
        "operating_calendar_room_bindings",
        "operational_booking_assignments",
        "property_pricing_settings",
        "rate_plans",
        "rate_rules",
        "recurring_pricing_materialization_receipts",
        "recurring_pricing_materialization_source_receipts",
        "recurring_pricing_materialized_rows",
        "recurring_pricing_source_room_values",
        "recurring_pricing_sources",
        "room_assignment_optimization_settings",
        "room_blocks",
        "room_type_media",
        "room_types",
        "rooms",
      ]);

      const { rows: pmsIntegrityConstraints } = await verifyClient.query<{
        constraint_name: string;
      }>(
        `SELECT constraint_name
         FROM information_schema.table_constraints
         WHERE table_schema = 'pms'
           AND constraint_name IN (
             'chk_pms_operational_assignments_position',
             'fk_pms_operational_assignments_booking_property',
             'fk_pms_operational_assignments_room_type_property',
             'fk_pms_rate_rules_rate_plan_property',
             'fk_pms_room_blocks_room_property',
             'fk_pms_room_type_media_object_property',
             'fk_pms_room_type_media_room_property',
             'fk_pms_checkin_records_assignment_property',
             'fk_pms_checkout_charges_assignment_property',
             'fk_pms_checkout_records_assignment_property',
             'fk_pms_operational_assignments_rate_plan_property',
             'fk_pms_operational_assignments_room_property',
             'uq_pms_operational_assignments_booking_position',
             'uq_pms_operational_assignments_id_property_booking',
             'uq_pms_rate_plans_id_property_room_type',
             'uq_pms_room_type_media_order',
             'uq_pms_rooms_id_property_room_type',
             'fk_pms_booking_notes_booking_property',
             'fk_pms_messages_thread_property',
             'fk_pms_channel_booking_mappings_booking_property',
             'fk_pms_channel_booking_mappings_assignment_property',
             'fk_pms_channel_room_mappings_connection_property',
             'fk_pms_channel_rate_mappings_rate_plan_property',
             'fk_pms_channel_sync_status_connection_property',
             'uq_pms_channel_booking_mappings_external_slot',
             'uq_pms_channel_rate_mappings_external'
           )
         ORDER BY constraint_name`,
      );

      expect(pmsIntegrityConstraints.map((row) => row.constraint_name)).toEqual([
        "chk_pms_operational_assignments_position",
        "fk_pms_booking_notes_booking_property",
        "fk_pms_channel_booking_mappings_assignment_property",
        "fk_pms_channel_booking_mappings_booking_property",
        "fk_pms_channel_rate_mappings_rate_plan_property",
        "fk_pms_channel_room_mappings_connection_property",
        "fk_pms_channel_sync_status_connection_property",
        "fk_pms_checkin_records_assignment_property",
        "fk_pms_checkout_charges_assignment_property",
        "fk_pms_checkout_records_assignment_property",
        "fk_pms_messages_thread_property",
        "fk_pms_operational_assignments_booking_property",
        "fk_pms_operational_assignments_rate_plan_property",
        "fk_pms_operational_assignments_room_property",
        "fk_pms_operational_assignments_room_type_property",
        "fk_pms_rate_rules_rate_plan_property",
        "fk_pms_room_blocks_room_property",
        "fk_pms_room_type_media_object_property",
        "fk_pms_room_type_media_room_property",
        "uq_pms_channel_booking_mappings_external_slot",
        "uq_pms_channel_rate_mappings_external",
        "uq_pms_operational_assignments_booking_position",
        "uq_pms_operational_assignments_id_property_booking",
        "uq_pms_rate_plans_id_property_room_type",
        "uq_pms_room_type_media_order",
        "uq_pms_rooms_id_property_room_type",
      ]);

      const { rows: assignmentPositionDefaults } = await verifyClient.query<{
        default_expr: string;
      }>(
        `SELECT pg_get_expr(def.adbin, def.adrelid) AS default_expr
         FROM pg_namespace ns
         JOIN pg_class rel ON rel.relnamespace = ns.oid
         JOIN pg_attribute att ON att.attrelid = rel.oid
         JOIN pg_attrdef def
           ON def.adrelid = rel.oid
          AND def.adnum = att.attnum
         WHERE ns.nspname = 'pms'
           AND rel.relname = 'operational_booking_assignments'
           AND att.attname = 'position'`,
      );

      expect(assignmentPositionDefaults).toEqual([{ default_expr: "1" }]);

      const { rows: pmsForeignKeyShapes } = await verifyClient.query<{
        constraint_name: string;
        table_name: string;
        columns: string;
        referenced_schema: string;
        referenced_table: string;
        referenced_columns: string;
      }>(
        `SELECT
           con.conname AS constraint_name,
           src.relname AS table_name,
           array_to_string(ARRAY(
             SELECT att.attname
             FROM unnest(con.conkey) WITH ORDINALITY AS cols(attnum, ord)
             JOIN pg_attribute att
               ON att.attrelid = con.conrelid
              AND att.attnum = cols.attnum
             ORDER BY cols.ord
           ), ',') AS columns,
           ref_ns.nspname AS referenced_schema,
           ref.relname AS referenced_table,
           array_to_string(ARRAY(
             SELECT att.attname
             FROM unnest(con.confkey) WITH ORDINALITY AS cols(attnum, ord)
             JOIN pg_attribute att
               ON att.attrelid = con.confrelid
              AND att.attnum = cols.attnum
             ORDER BY cols.ord
           ), ',') AS referenced_columns
         FROM pg_constraint con
         JOIN pg_class src ON src.oid = con.conrelid
         JOIN pg_namespace src_ns ON src_ns.oid = src.relnamespace
         JOIN pg_class ref ON ref.oid = con.confrelid
         JOIN pg_namespace ref_ns ON ref_ns.oid = ref.relnamespace
         WHERE src_ns.nspname = 'pms'
           AND con.contype = 'f'
           AND con.conname IN (
             'fk_pms_checkin_records_assignment_property',
             'fk_pms_checkout_charges_assignment_property',
             'fk_pms_checkout_records_assignment_property',
             'fk_pms_channel_booking_mappings_assignment_property',
             'fk_pms_operational_assignments_rate_plan_property',
             'fk_pms_operational_assignments_room_property',
             'fk_pms_channel_rate_mappings_rate_plan_property',
             'fk_pms_rate_rules_rate_plan_property',
             'fk_pms_room_blocks_room_property',
             'fk_pms_room_type_media_object_property',
             'fk_pms_room_type_media_room_property'
           )
         ORDER BY con.conname`,
      );

      expect(pmsForeignKeyShapes).toEqual([
        {
          columns: "assignment_id,property_id,guest_booking_id",
          constraint_name: "fk_pms_channel_booking_mappings_assignment_property",
          referenced_columns: "id,property_id,guest_booking_id",
          referenced_schema: "pms",
          referenced_table: "operational_booking_assignments",
          table_name: "channel_booking_mappings",
        },
        {
          columns: "rate_plan_id,property_id,room_type_id",
          constraint_name: "fk_pms_channel_rate_mappings_rate_plan_property",
          referenced_columns: "id,property_id,room_type_id",
          referenced_schema: "pms",
          referenced_table: "rate_plans",
          table_name: "channel_rate_plan_mappings",
        },
        {
          columns: "assignment_id,property_id,guest_booking_id",
          constraint_name: "fk_pms_checkin_records_assignment_property",
          referenced_columns: "id,property_id,guest_booking_id",
          referenced_schema: "pms",
          referenced_table: "operational_booking_assignments",
          table_name: "booking_checkin_records",
        },
        {
          columns: "assignment_id,property_id,guest_booking_id",
          constraint_name: "fk_pms_checkout_charges_assignment_property",
          referenced_columns: "id,property_id,guest_booking_id",
          referenced_schema: "pms",
          referenced_table: "operational_booking_assignments",
          table_name: "booking_checkout_charges",
        },
        {
          columns: "assignment_id,property_id,guest_booking_id",
          constraint_name: "fk_pms_checkout_records_assignment_property",
          referenced_columns: "id,property_id,guest_booking_id",
          referenced_schema: "pms",
          referenced_table: "operational_booking_assignments",
          table_name: "booking_checkout_records",
        },
        {
          columns: "rate_plan_id,property_id,room_type_id",
          constraint_name: "fk_pms_operational_assignments_rate_plan_property",
          referenced_columns: "id,property_id,room_type_id",
          referenced_schema: "pms",
          referenced_table: "rate_plans",
          table_name: "operational_booking_assignments",
        },
        {
          columns: "room_id,property_id,room_type_id",
          constraint_name: "fk_pms_operational_assignments_room_property",
          referenced_columns: "id,property_id,room_type_id",
          referenced_schema: "pms",
          referenced_table: "rooms",
          table_name: "operational_booking_assignments",
        },
        {
          columns: "rate_plan_id,property_id,room_type_id",
          constraint_name: "fk_pms_rate_rules_rate_plan_property",
          referenced_columns: "id,property_id,room_type_id",
          referenced_schema: "pms",
          referenced_table: "rate_plans",
          table_name: "rate_rules",
        },
        {
          columns: "room_id,property_id,room_type_id",
          constraint_name: "fk_pms_room_blocks_room_property",
          referenced_columns: "id,property_id,room_type_id",
          referenced_schema: "pms",
          referenced_table: "rooms",
          table_name: "room_blocks",
        },
        {
          columns: "platform_media_object_id,property_id",
          constraint_name: "fk_pms_room_type_media_object_property",
          referenced_columns: "id,property_id",
          referenced_schema: "platform",
          referenced_table: "media_objects",
          table_name: "room_type_media",
        },
        {
          columns: "room_type_id,property_id",
          constraint_name: "fk_pms_room_type_media_room_property",
          referenced_columns: "id,property_id",
          referenced_schema: "pms",
          referenced_table: "room_types",
          table_name: "room_type_media",
        },
      ]);

      const { rows: mediaAssignmentConstraints } = await verifyClient.query<{
        constraint_name: string;
        definition: string;
        is_validated: boolean;
        is_deferrable: boolean;
        is_initially_deferred: boolean;
      }>(
        `SELECT
           conname AS constraint_name,
           pg_get_constraintdef(oid) AS definition,
           convalidated AS is_validated,
           condeferrable AS is_deferrable,
           condeferred AS is_initially_deferred
         FROM pg_constraint
         WHERE conname IN (
           'chk_property_media_sort_order',
           'chk_pms_room_types_room_media_revision',
           'chk_pms_room_type_media_alt_text',
           'chk_pms_room_type_media_sort_order',
           'fk_property_media_platform_object_property',
           'fk_platform_media_variants_object_visibility'
         )
         ORDER BY conname`,
      );
      const mediaConstraint = new Map(
        mediaAssignmentConstraints.map((constraint) => [constraint.constraint_name, constraint]),
      );

      expect(mediaConstraint.get("chk_pms_room_types_room_media_revision")?.definition).toContain(
        "room_media_revision",
      );
      expect(mediaConstraint.get("chk_pms_room_type_media_sort_order")?.definition).toContain(
        "sort_order <= 19",
      );
      expect(mediaConstraint.get("chk_pms_room_type_media_alt_text")?.definition).toContain(
        "char_length(alt_text) <= 500",
      );
      expect(mediaConstraint.get("fk_property_media_platform_object_property")).toMatchObject({
        is_validated: false,
      });
      expect(mediaConstraint.get("chk_property_media_sort_order")).toMatchObject({
        is_validated: false,
      });
      expect(mediaConstraint.get("fk_platform_media_variants_object_visibility")).toMatchObject({
        is_deferrable: true,
        is_initially_deferred: true,
      });
      const { rows: roomMediaRevisionColumns } = await verifyClient.query<{
        column_default: string;
        is_nullable: string;
      }>(
        `SELECT column_default, is_nullable
         FROM information_schema.columns
         WHERE table_schema = 'pms'
           AND table_name = 'room_types'
           AND column_name = 'room_media_revision'`,
      );
      expect(roomMediaRevisionColumns).toEqual([{ column_default: "1", is_nullable: "NO" }]);

      const { rows: pmsForeignKeySchemas } = await verifyClient.query<{
        constraint_name: string;
        referenced_schema: string;
      }>(
        `SELECT DISTINCT
           tc.constraint_name,
           ccu.table_schema AS referenced_schema
         FROM information_schema.table_constraints tc
         JOIN information_schema.constraint_column_usage ccu
           ON ccu.constraint_schema = tc.constraint_schema
          AND ccu.constraint_name = tc.constraint_name
         WHERE tc.table_schema = 'pms'
           AND tc.constraint_type = 'FOREIGN KEY'
           AND ccu.table_schema NOT IN ('booking', 'hotel_catalog', 'identity', 'platform', 'pms')
         ORDER BY tc.constraint_name`,
      );

      expect(pmsForeignKeySchemas).toHaveLength(0);

      const { rows: pmsReadModels } = await verifyClient.query<{ table_name: string }>(
        `SELECT table_name
         FROM information_schema.tables
         WHERE table_schema = 'pms'
           AND table_name LIKE '%read_model%'`,
      );

      expect(pmsReadModels).toHaveLength(0);

      const { rows: financeTableRows } = await verifyClient.query<{ table_name: string }>(
        `SELECT table_name
         FROM information_schema.tables
         WHERE table_schema = 'finance'
         ORDER BY table_name`,
      );

      expect(financeTableRows.map((row) => row.table_name)).toEqual([
        "affiliate_payout_payment_evidence",
        "affiliate_payout_payment_evidence_items",
        "bank_transfer_bookings",
        "bank_transfer_destinations",
        "billing_entitlements",
        "commission_rate_changes",
        "commission_rules",
        "expense_categories",
        "expense_generation_dispatches",
        "expenses",
        "finance_visibility_read_model",
        "folio_lines",
        "folio_payment_references",
        "folio_revisions",
        "folios",
        "online_card_execution_evidence",
        "online_card_readiness",
        "ota_commission_evidence",
        "ota_commission_reporting_evidence",
        "payment_provider_accounts",
        "payment_settings",
        "payments",
        "payout_settings",
        "payouts",
        "provider_fee_evidence",
        "provider_fee_reporting_evidence",
        "recurring_expense_rules",
        "stripe_provider_account_compensation_claims",
      ]);

      const { rows: financeIntegrityConstraints } = await verifyClient.query<{
        constraint_name: string;
      }>(
        `SELECT constraint_name
         FROM information_schema.table_constraints
         WHERE table_schema = 'finance'
           AND constraint_name IN (
             'chk_finance_billing_entitlements_source_id',
             'chk_finance_payment_provider_accounts_scope',
             'chk_finance_payment_settings_accepted_methods',
             'chk_finance_payment_settings_currency_upper',
             'chk_finance_payments_refund_amount',
             'chk_finance_payout_settings_provider_scope',
             'chk_finance_payout_settings_scope',
             'chk_finance_payouts_property_owner_related_property',
             'chk_finance_payouts_provider_scope',
             'chk_finance_payouts_related_property',
             'chk_finance_payouts_scope',
             'chk_finance_visibility_requires_permission',
             'chk_finance_visibility_scope_permission',
             'chk_finance_visibility_scope_shape',
             'fk_finance_billing_entitlements_identity_entitlement',
             'fk_finance_commission_changes_actor',
             'fk_finance_commission_changes_rule',
             'fk_finance_payment_settings_provider_account_property',
             'fk_finance_payments_booking_property',
             'fk_finance_payments_provider_account_property',
             'fk_finance_payout_settings_organization_provider_account',
             'fk_finance_payout_settings_property_provider_account',
             'fk_finance_payouts_booking_property',
             'fk_finance_payouts_organization_payout_setting',
             'fk_finance_payouts_organization_provider_account',
             'fk_finance_payouts_payment_booking',
             'fk_finance_payouts_payment_property',
             'fk_finance_payouts_property_payout_setting',
             'fk_finance_payouts_property_provider_account',
             'fk_finance_visibility_permission_key',
             'fk_finance_visibility_property',
             'uq_finance_billing_entitlements_source',
             'uq_finance_commission_rules_source',
             'uq_finance_payment_provider_accounts_id_organization',
             'uq_finance_payment_provider_accounts_id_property',
             'uq_finance_payments_id_property_booking',
             'uq_finance_payments_id_property',
             'uq_finance_payments_source',
             'uq_finance_payout_settings_id_organization',
             'uq_finance_payout_settings_id_property',
             'uq_finance_payouts_id_property',
             'uq_finance_payouts_source'
           )
         ORDER BY constraint_name`,
      );

      expect(financeIntegrityConstraints.map((row) => row.constraint_name)).toEqual([
        "chk_finance_billing_entitlements_source_id",
        "chk_finance_payment_provider_accounts_scope",
        "chk_finance_payment_settings_accepted_methods",
        "chk_finance_payment_settings_currency_upper",
        "chk_finance_payments_refund_amount",
        "chk_finance_payout_settings_provider_scope",
        "chk_finance_payout_settings_scope",
        "chk_finance_payouts_property_owner_related_property",
        "chk_finance_payouts_provider_scope",
        "chk_finance_payouts_related_property",
        "chk_finance_payouts_scope",
        "chk_finance_visibility_requires_permission",
        "chk_finance_visibility_scope_permission",
        "chk_finance_visibility_scope_shape",
        "fk_finance_billing_entitlements_identity_entitlement",
        "fk_finance_commission_changes_actor",
        "fk_finance_commission_changes_rule",
        "fk_finance_payment_settings_provider_account_property",
        "fk_finance_payments_booking_property",
        "fk_finance_payments_provider_account_property",
        "fk_finance_payout_settings_organization_provider_account",
        "fk_finance_payout_settings_property_provider_account",
        "fk_finance_payouts_booking_property",
        "fk_finance_payouts_organization_payout_setting",
        "fk_finance_payouts_organization_provider_account",
        "fk_finance_payouts_payment_booking",
        "fk_finance_payouts_payment_property",
        "fk_finance_payouts_property_payout_setting",
        "fk_finance_payouts_property_provider_account",
        "fk_finance_visibility_permission_key",
        "fk_finance_visibility_property",
        "uq_finance_billing_entitlements_source",
        "uq_finance_commission_rules_source",
        "uq_finance_payment_provider_accounts_id_organization",
        "uq_finance_payment_provider_accounts_id_property",
        "uq_finance_payments_id_property",
        "uq_finance_payments_id_property_booking",
        "uq_finance_payments_source",
        "uq_finance_payout_settings_id_organization",
        "uq_finance_payout_settings_id_property",
        "uq_finance_payouts_id_property",
        "uq_finance_payouts_source",
      ]);

      const { rows: financeForeignKeyShapes } = await verifyClient.query<{
        constraint_name: string;
        table_name: string;
        columns: string;
        referenced_schema: string;
        referenced_table: string;
        referenced_columns: string;
      }>(
        `SELECT
           con.conname AS constraint_name,
           src.relname AS table_name,
           array_to_string(ARRAY(
             SELECT att.attname
             FROM unnest(con.conkey) WITH ORDINALITY AS cols(attnum, ord)
             JOIN pg_attribute att
               ON att.attrelid = con.conrelid
              AND att.attnum = cols.attnum
             ORDER BY cols.ord
           ), ',') AS columns,
           ref_ns.nspname AS referenced_schema,
           ref.relname AS referenced_table,
           array_to_string(ARRAY(
             SELECT att.attname
             FROM unnest(con.confkey) WITH ORDINALITY AS cols(attnum, ord)
             JOIN pg_attribute att
               ON att.attrelid = con.confrelid
              AND att.attnum = cols.attnum
             ORDER BY cols.ord
           ), ',') AS referenced_columns
         FROM pg_constraint con
         JOIN pg_class src ON src.oid = con.conrelid
         JOIN pg_namespace src_ns ON src_ns.oid = src.relnamespace
         JOIN pg_class ref ON ref.oid = con.confrelid
         JOIN pg_namespace ref_ns ON ref_ns.oid = ref.relnamespace
         WHERE src_ns.nspname = 'finance'
           AND con.contype = 'f'
           AND con.conname IN (
             'fk_finance_billing_entitlements_identity_entitlement',
             'fk_finance_commission_changes_rule',
             'fk_finance_payment_settings_provider_account_property',
             'fk_finance_payments_booking_property',
             'fk_finance_payments_provider_account_property',
             'fk_finance_payout_settings_organization_provider_account',
             'fk_finance_payout_settings_property_provider_account',
             'fk_finance_payouts_booking_property',
             'fk_finance_payouts_organization_payout_setting',
             'fk_finance_payouts_organization_provider_account',
             'fk_finance_payouts_payment_booking',
             'fk_finance_payouts_payment_property',
             'fk_finance_payouts_property_payout_setting',
             'fk_finance_payouts_property_provider_account',
             'fk_finance_visibility_permission_key',
             'fk_finance_visibility_property'
           )
         ORDER BY con.conname`,
      );

      expect(financeForeignKeyShapes).toEqual([
        {
          columns: "identity_entitlement_id",
          constraint_name: "fk_finance_billing_entitlements_identity_entitlement",
          referenced_columns: "id",
          referenced_schema: "identity",
          referenced_table: "product_entitlements",
          table_name: "billing_entitlements",
        },
        {
          columns: "commission_rule_id",
          constraint_name: "fk_finance_commission_changes_rule",
          referenced_columns: "id",
          referenced_schema: "finance",
          referenced_table: "commission_rules",
          table_name: "commission_rate_changes",
        },
        {
          columns: "provider_account_id,property_id",
          constraint_name: "fk_finance_payment_settings_provider_account_property",
          referenced_columns: "id,property_id",
          referenced_schema: "finance",
          referenced_table: "payment_provider_accounts",
          table_name: "payment_settings",
        },
        {
          columns: "guest_booking_id,property_id",
          constraint_name: "fk_finance_payments_booking_property",
          referenced_columns: "id,property_id",
          referenced_schema: "booking",
          referenced_table: "guest_bookings",
          table_name: "payments",
        },
        {
          columns: "provider_account_id,property_id",
          constraint_name: "fk_finance_payments_provider_account_property",
          referenced_columns: "id,property_id",
          referenced_schema: "finance",
          referenced_table: "payment_provider_accounts",
          table_name: "payments",
        },
        {
          columns: "organization_provider_account_id,organization_id",
          constraint_name: "fk_finance_payout_settings_organization_provider_account",
          referenced_columns: "id,organization_id",
          referenced_schema: "finance",
          referenced_table: "payment_provider_accounts",
          table_name: "payout_settings",
        },
        {
          columns: "property_provider_account_id,property_id",
          constraint_name: "fk_finance_payout_settings_property_provider_account",
          referenced_columns: "id,property_id",
          referenced_schema: "finance",
          referenced_table: "payment_provider_accounts",
          table_name: "payout_settings",
        },
        {
          columns: "guest_booking_id,related_property_id",
          constraint_name: "fk_finance_payouts_booking_property",
          referenced_columns: "id,property_id",
          referenced_schema: "booking",
          referenced_table: "guest_bookings",
          table_name: "payouts",
        },
        {
          columns: "payout_setting_id,organization_id",
          constraint_name: "fk_finance_payouts_organization_payout_setting",
          referenced_columns: "id,organization_id",
          referenced_schema: "finance",
          referenced_table: "payout_settings",
          table_name: "payouts",
        },
        {
          columns: "organization_provider_account_id,organization_id",
          constraint_name: "fk_finance_payouts_organization_provider_account",
          referenced_columns: "id,organization_id",
          referenced_schema: "finance",
          referenced_table: "payment_provider_accounts",
          table_name: "payouts",
        },
        {
          columns: "payment_id,related_property_id,guest_booking_id",
          constraint_name: "fk_finance_payouts_payment_booking",
          referenced_columns: "id,property_id,guest_booking_id",
          referenced_schema: "finance",
          referenced_table: "payments",
          table_name: "payouts",
        },
        {
          columns: "payment_id,related_property_id",
          constraint_name: "fk_finance_payouts_payment_property",
          referenced_columns: "id,property_id",
          referenced_schema: "finance",
          referenced_table: "payments",
          table_name: "payouts",
        },
        {
          columns: "payout_setting_id,property_id",
          constraint_name: "fk_finance_payouts_property_payout_setting",
          referenced_columns: "id,property_id",
          referenced_schema: "finance",
          referenced_table: "payout_settings",
          table_name: "payouts",
        },
        {
          columns: "property_provider_account_id,property_id",
          constraint_name: "fk_finance_payouts_property_provider_account",
          referenced_columns: "id,property_id",
          referenced_schema: "finance",
          referenced_table: "payment_provider_accounts",
          table_name: "payouts",
        },
        {
          columns: "required_permission_key",
          constraint_name: "fk_finance_visibility_permission_key",
          referenced_columns: "key",
          referenced_schema: "identity",
          referenced_table: "permission_catalog",
          table_name: "finance_visibility_read_model",
        },
        {
          columns: "property_id",
          constraint_name: "fk_finance_visibility_property",
          referenced_columns: "id",
          referenced_schema: "hotel_catalog",
          referenced_table: "properties",
          table_name: "finance_visibility_read_model",
        },
      ]);

      const { rows: financeForeignKeySchemas } = await verifyClient.query<{
        constraint_name: string;
        referenced_schema: string;
      }>(
        `SELECT DISTINCT
           tc.constraint_name,
           ccu.table_schema AS referenced_schema
         FROM information_schema.table_constraints tc
         JOIN information_schema.constraint_column_usage ccu
           ON ccu.constraint_schema = tc.constraint_schema
          AND ccu.constraint_name = tc.constraint_name
         WHERE tc.table_schema = 'finance'
           AND tc.constraint_type = 'FOREIGN KEY'
           AND ccu.table_schema NOT IN (
             'booking', 'finance', 'hotel_catalog', 'identity', 'platform', 'pms'
           )
         ORDER BY tc.constraint_name`,
      );

      expect(financeForeignKeySchemas).toHaveLength(0);

      const { rows: financePermissionKeys } = await verifyClient.query<{ key: string }>(
        `SELECT key
         FROM identity.permission_catalog
         WHERE key IN (
           'affiliate.payout.manage',
           'marketplace.finance.read',
           'platform.finance.read',
           'pms.finance.read'
         )
         ORDER BY key`,
      );

      expect(financePermissionKeys.map((row) => row.key)).toEqual([
        "affiliate.payout.manage",
        "marketplace.finance.read",
        "platform.finance.read",
        "pms.finance.read",
      ]);

      const organizationId = "11111111-1111-4111-8111-111111111111";
      const propertyOneId = "22222222-2222-4222-8222-222222222222";
      const propertyTwoId = "33333333-3333-4333-8333-333333333333";
      const propertyProviderAccountId = "44444444-4444-4444-8444-444444444444";
      const bookingOneId = "55555555-5555-4555-8555-555555555555";
      const bookingTwoId = "66666666-6666-4666-8666-666666666666";
      const paymentId = "77777777-7777-4777-8777-777777777777";

      await verifyClient.query(
        `INSERT INTO identity.organizations (id, kind, name, slug)
         VALUES ($1, 'hotel_group', 'Finance Test Group', 'finance-test-group')`,
        [organizationId],
      );
      await verifyClient.query(
        `INSERT INTO hotel_catalog.properties (id, public_id, display_name)
         VALUES
           ($1, 'finance-property-one', 'Finance Property One'),
           ($2, 'finance-property-two', 'Finance Property Two')`,
        [propertyOneId, propertyTwoId],
      );
      await verifyClient.query(
        `INSERT INTO finance.payment_provider_accounts
           (id, property_id, account_scope, provider, status, onboarding_status, default_currency)
         VALUES ($1, $2, 'property', 'vayada', 'active', 'completed', 'USD')`,
        [propertyProviderAccountId, propertyOneId],
      );
      await verifyClient.query(
        `INSERT INTO finance.payment_settings
           (property_id, provider_account_id, payments_enabled, accepted_methods, default_currency)
         VALUES (
           $1,
           $2,
           TRUE,
           ARRAY['card', 'pay_at_property', 'xendit', 'manual_card', 'other']::TEXT[],
           'USD'
         )`,
        [propertyOneId, propertyProviderAccountId],
      );
      await expect(
        verifyClient.query(
          `INSERT INTO finance.payment_settings
             (property_id, provider_account_id, default_currency)
           VALUES ($1, $2, 'USD')`,
          [propertyTwoId, propertyProviderAccountId],
        ),
      ).rejects.toMatchObject({ code: "23503" });

      await verifyClient.query(
        `INSERT INTO booking.guest_bookings
           (id, property_id, public_reference, lifecycle_status, check_in, check_out, currency)
         VALUES
           ($1, $2, 'FIN-BOOKING-ONE', 'confirmed', DATE '2026-01-01', DATE '2026-01-02', 'USD'),
           ($3, $2, 'FIN-BOOKING-TWO', 'confirmed', DATE '2026-01-03', DATE '2026-01-04', 'USD')`,
        [bookingOneId, propertyOneId, bookingTwoId],
      );
      await verifyClient.query(
        `INSERT INTO finance.payments
           (id, property_id, guest_booking_id, payment_kind, status, amount, net_amount, currency)
         VALUES ($1, $2, $3, 'full', 'paid', 100, 95, 'USD')`,
        [paymentId, propertyOneId, bookingOneId],
      );
      await verifyClient.query(
        `INSERT INTO finance.payouts
           (
             owner_scope, organization_id, related_property_id, payment_id,
             guest_booking_id, payout_status, amount, net_amount, currency
           )
         VALUES ('organization', $1, $2, $3, $4, 'paid', 100, 95, 'USD')`,
        [organizationId, propertyOneId, paymentId, bookingOneId],
      );
      await expect(
        verifyClient.query(
          `INSERT INTO finance.payouts
             (owner_scope, organization_id, payment_id, payout_status, amount, currency)
           VALUES ('organization', $1, $2, 'paid', 100, 'USD')`,
          [organizationId, paymentId],
        ),
      ).rejects.toMatchObject({ code: "23514" });
      await expect(
        verifyClient.query(
          `INSERT INTO finance.payouts
             (
               owner_scope, organization_id, related_property_id, payment_id,
               guest_booking_id, payout_status, amount, currency
             )
           VALUES ('organization', $1, $2, $3, $4, 'paid', 100, 'USD')`,
          [organizationId, propertyOneId, paymentId, bookingTwoId],
        ),
      ).rejects.toMatchObject({ code: "23503" });

      await verifyClient.query(
        `INSERT INTO finance.finance_visibility_read_model
           (
             organization_id, property_id, visibility_scope, resource_type,
             resource_id, required_permission_key, currency
           )
         VALUES ($1, $2, 'property_finance', 'property', $3, 'pms.finance.read', 'USD')`,
        [organizationId, propertyOneId, propertyOneId],
      );
      await expect(
        verifyClient.query(
          `INSERT INTO finance.finance_visibility_read_model
             (
               organization_id, visibility_scope, resource_type,
               resource_id, required_permission_key, currency
             )
           VALUES ($1, 'platform_finance', 'platform', 'platform', 'pms.finance.read', 'USD')`,
          [organizationId],
        ),
      ).rejects.toMatchObject({ code: "23514" });

      const { rows: financeVisibilityPermissionColumns } = await verifyClient.query<{
        column_name: string;
      }>(
        `SELECT column_name
         FROM information_schema.columns
         WHERE table_schema = 'finance'
           AND table_name = 'finance_visibility_read_model'
           AND column_name IN ('visibility_scope', 'required_permission_key')
         ORDER BY ordinal_position`,
      );

      expect(financeVisibilityPermissionColumns).toEqual([
        { column_name: "visibility_scope" },
        { column_name: "required_permission_key" },
      ]);

      const { rows: financeVisibilitySensitiveColumns } = await verifyClient.query<{
        column_name: string;
      }>(
        `SELECT column_name
         FROM information_schema.columns
         WHERE table_schema = 'finance'
           AND table_name = 'finance_visibility_read_model'
           AND column_name IN (
             'first_name', 'last_name', 'email', 'phone',
             'guest_name', 'guest_email', 'provider_account_id',
             'provider_transaction_id', 'provider_payment_intent_id',
             'billing_customer_ref', 'billing_subscription_ref',
             'sensitive_config_ref', 'sensitive_destination_ref',
             'processor_fee_breakdown', 'risk_review', 'raw_payload'
           )`,
      );

      expect(financeVisibilitySensitiveColumns).toHaveLength(0);

      const { rows: marketplaceTableRows } = await verifyClient.query<{ table_name: string }>(
        `SELECT table_name
         FROM information_schema.tables
         WHERE table_schema = 'marketplace'
         ORDER BY table_name`,
      );

      expect(marketplaceTableRows.map((row) => row.table_name)).toEqual([
        "active_hotel_submission_revisions",
        "affiliate_lifecycle_changes",
        "collaboration_deliverables",
        "collaborations",
        "creator_matching_preferences",
        "creator_platform_authorizations",
        "creator_platform_connections",
        "creator_platform_credential_cleanup_jobs",
        "creator_platform_metric_snapshots",
        "creator_platforms",
        "creator_profiles",
        "creator_ratings",
        "current_matching_outcomes",
        "external_collaborations",
        "hotel_collaboration_preferences",
        "hotel_submission_moderation",
        "hotel_submission_revisions",
        "invite_codes",
        "marketplace_chat_messages",
        "marketplace_hotel_profiles",
        "marketplace_notifications",
        "marketplace_offer_read_model",
        "marketplace_offers",
        "matching_event_projections",
        "newsletter_preferences",
        "offer_compensation_options",
        "offer_creator_requirements",
        "offer_deliverables",
        "offer_matching_criteria",
        "property_affiliates",
        "trips",
      ]);

      await expect(
        verifyClient.query(`TRUNCATE marketplace.hotel_submission_revisions CASCADE`),
      ).rejects.toMatchObject({ code: "55000" });

      const { rows: marketplaceTripGrants } = await verifyClient.query<{
        key: string;
        organization_kind: string;
        role_key: string;
      }>(
        `SELECT catalog.key, grant_row.organization_kind, grant_row.role_key
         FROM identity.permission_catalog catalog
         JOIN identity.role_permission_grants grant_row
           ON grant_row.permission_key = catalog.key
         WHERE catalog.key IN ('marketplace.trip.read', 'marketplace.trip.manage')
         ORDER BY catalog.key`,
      );

      expect(marketplaceTripGrants).toEqual([
        {
          key: "marketplace.trip.manage",
          organization_kind: "creator_workspace",
          role_key: "creator_owner",
        },
        {
          key: "marketplace.trip.read",
          organization_kind: "creator_workspace",
          role_key: "creator_owner",
        },
      ]);

      const { rows: creatorEngagementColumns } = await verifyClient.query<{
        table_name: string;
        numeric_precision: number;
        numeric_scale: number;
      }>(
        `SELECT table_name, numeric_precision, numeric_scale
         FROM information_schema.columns
         WHERE table_schema = 'marketplace'
           AND column_name = 'engagement_rate'
           AND table_name IN ('creator_platforms', 'creator_platform_metric_snapshots')
         ORDER BY table_name`,
      );
      expect(creatorEngagementColumns).toEqual([
        {
          table_name: "creator_platform_metric_snapshots",
          numeric_precision: 24,
          numeric_scale: 6,
        },
        { table_name: "creator_platforms", numeric_precision: 24, numeric_scale: 6 },
      ]);

      const { rows: creatorCompletionFunctions } = await verifyClient.query<{
        argument_count: number;
        default_count: number;
        language: string;
        result: string;
        volatility: string;
      }>(
        `SELECT
           procedure.pronargs AS argument_count,
           procedure.pronargdefaults AS default_count,
           language.lanname AS language,
           pg_get_function_result(procedure.oid) AS result,
           procedure.provolatile AS volatility
         FROM pg_proc AS procedure
         JOIN pg_namespace AS namespace ON namespace.oid = procedure.pronamespace
         JOIN pg_language AS language ON language.oid = procedure.prolang
         WHERE namespace.nspname = 'marketplace'
           AND procedure.proname = 'creator_profile_is_complete'`,
      );
      expect(creatorCompletionFunctions).toEqual([
        {
          argument_count: 2,
          default_count: 0,
          language: "sql",
          result: "boolean",
          volatility: "s",
        },
      ]);

      const { rows: marketplaceIntegrityConstraints } = await verifyClient.query<{
        constraint_name: string;
      }>(
        `SELECT constraint_name
         FROM information_schema.table_constraints
         WHERE table_schema = 'marketplace'
           AND constraint_name IN (
             'collaborations_compensation_type_check',
             'chk_marketplace_chat_sender_shape',
             'chk_marketplace_collaborations_affiliate_link',
             'chk_marketplace_collaborations_currency_upper',
             'chk_marketplace_collaborations_preferred_dates',
             'chk_marketplace_collaborations_source_id',
             'chk_marketplace_collaborations_status',
             'chk_marketplace_collaborations_travel_dates',
             'chk_marketplace_collaborations_compensation_terms',
             'chk_marketplace_creator_platform_engagement',
             'chk_marketplace_creator_platform_followers',
             'chk_marketplace_creator_platforms_source_id',
             'chk_marketplace_creator_profiles_source_id',
             'chk_marketplace_creator_ratings_score',
             'chk_marketplace_deliverables_quantity',
             'chk_marketplace_external_collaborations_date_order',
             'chk_marketplace_external_collaborations_source_id',
             'chk_marketplace_offers_source_id',
             'chk_marketplace_offers_status',
             'chk_marketplace_hotel_profiles_source_id',
             'chk_marketplace_hotel_profiles_status',
             'chk_marketplace_invite_codes_dates',
             'chk_marketplace_invite_codes_status',
             'chk_marketplace_offer_read_model_public_json',
             'chk_marketplace_newsletter_preferences_source_id',
             'chk_marketplace_offer_deliverables_quantity',
             'chk_marketplace_compensation_options_currency_upper',
             'chk_marketplace_compensation_options_source_id',
             'chk_marketplace_compensation_options_terms',
             'chk_marketplace_requirements_age_range',
             'chk_marketplace_requirements_source_id',
             'chk_marketplace_trips_date_order',
             'chk_marketplace_trips_source_id',
             'fk_marketplace_chat_collaboration_property',
             'fk_marketplace_collaborations_commission_rule',
             'fk_marketplace_collaborations_creator_org',
             'fk_marketplace_collaborations_offer_org',
             'fk_marketplace_creator_platforms_creator_org',
             'fk_marketplace_deliverables_collaboration_property',
             'fk_marketplace_external_collaborations_creator_org',
             'fk_marketplace_external_collaborations_trip_creator',
             'fk_marketplace_offer_deliverables_offer_org',
             'fk_marketplace_offers_profile_org',
             'fk_marketplace_invite_codes_creator_org',
             'fk_marketplace_compensation_options_offer_org',
             'fk_marketplace_ratings_collaboration_creator',
             'fk_marketplace_ratings_creator_org',
             'fk_marketplace_ratings_hotel_profile_org',
             'fk_marketplace_read_model_offer_property',
             'fk_marketplace_read_model_property',
             'fk_marketplace_requirements_offer_org',
             'fk_marketplace_trips_creator_org',
             'uq_marketplace_collaborations_id_property',
             'uq_marketplace_collaborations_id_property_creator',
             'uq_marketplace_collaborations_source',
             'uq_marketplace_creator_platforms_source',
             'uq_marketplace_creator_profiles_id_org',
             'uq_marketplace_creator_profiles_source',
             'uq_marketplace_creator_ratings_collaboration',
             'uq_marketplace_external_collaborations_source',
             'uq_marketplace_offers_id_property',
             'uq_marketplace_offers_id_property_org',
             'uq_marketplace_offers_source',
             'uq_marketplace_hotel_profiles_property_org',
             'uq_marketplace_hotel_profiles_source',
             'uq_marketplace_newsletter_preferences_source',
             'uq_marketplace_compensation_options_source',
             'uq_marketplace_requirements_offer',
             'uq_marketplace_requirements_source',
             'uq_marketplace_trips_id_creator',
             'uq_marketplace_trips_source'
           )
         ORDER BY constraint_name`,
      );

      expect(marketplaceIntegrityConstraints.map((row) => row.constraint_name)).toEqual([
        "chk_marketplace_chat_sender_shape",
        "chk_marketplace_collaborations_affiliate_link",
        "chk_marketplace_collaborations_compensation_terms",
        "chk_marketplace_collaborations_currency_upper",
        "chk_marketplace_collaborations_preferred_dates",
        "chk_marketplace_collaborations_source_id",
        "chk_marketplace_collaborations_status",
        "chk_marketplace_collaborations_travel_dates",
        "chk_marketplace_compensation_options_currency_upper",
        "chk_marketplace_compensation_options_source_id",
        "chk_marketplace_compensation_options_terms",
        "chk_marketplace_creator_platform_engagement",
        "chk_marketplace_creator_platform_followers",
        "chk_marketplace_creator_platforms_source_id",
        "chk_marketplace_creator_profiles_source_id",
        "chk_marketplace_creator_ratings_score",
        "chk_marketplace_deliverables_quantity",
        "chk_marketplace_external_collaborations_date_order",
        "chk_marketplace_external_collaborations_source_id",
        "chk_marketplace_hotel_profiles_source_id",
        "chk_marketplace_hotel_profiles_status",
        "chk_marketplace_invite_codes_dates",
        "chk_marketplace_invite_codes_status",
        "chk_marketplace_newsletter_preferences_source_id",
        "chk_marketplace_offer_deliverables_quantity",
        "chk_marketplace_offer_read_model_public_json",
        "chk_marketplace_offers_source_id",
        "chk_marketplace_offers_status",
        "chk_marketplace_requirements_age_range",
        "chk_marketplace_requirements_source_id",
        "chk_marketplace_trips_date_order",
        "chk_marketplace_trips_source_id",
        "collaborations_compensation_type_check",
        "fk_marketplace_chat_collaboration_property",
        "fk_marketplace_collaborations_commission_rule",
        "fk_marketplace_collaborations_creator_org",
        "fk_marketplace_collaborations_offer_org",
        "fk_marketplace_compensation_options_offer_org",
        "fk_marketplace_creator_platforms_creator_org",
        "fk_marketplace_deliverables_collaboration_property",
        "fk_marketplace_external_collaborations_creator_org",
        "fk_marketplace_external_collaborations_trip_creator",
        "fk_marketplace_invite_codes_creator_org",
        "fk_marketplace_offer_deliverables_offer_org",
        "fk_marketplace_offers_profile_org",
        "fk_marketplace_ratings_collaboration_creator",
        "fk_marketplace_ratings_creator_org",
        "fk_marketplace_ratings_hotel_profile_org",
        "fk_marketplace_read_model_offer_property",
        "fk_marketplace_read_model_property",
        "fk_marketplace_requirements_offer_org",
        "fk_marketplace_trips_creator_org",
        "uq_marketplace_collaborations_id_property",
        "uq_marketplace_collaborations_id_property_creator",
        "uq_marketplace_collaborations_source",
        "uq_marketplace_compensation_options_source",
        "uq_marketplace_creator_platforms_source",
        "uq_marketplace_creator_profiles_id_org",
        "uq_marketplace_creator_profiles_source",
        "uq_marketplace_creator_ratings_collaboration",
        "uq_marketplace_external_collaborations_source",
        "uq_marketplace_hotel_profiles_property_org",
        "uq_marketplace_hotel_profiles_source",
        "uq_marketplace_newsletter_preferences_source",
        "uq_marketplace_offers_id_property",
        "uq_marketplace_offers_id_property_org",
        "uq_marketplace_offers_source",
        "uq_marketplace_requirements_offer",
        "uq_marketplace_requirements_source",
        "uq_marketplace_trips_id_creator",
        "uq_marketplace_trips_source",
      ]);

      const { rows: marketplaceForeignKeyShapes } = await verifyClient.query<{
        constraint_name: string;
        table_name: string;
        columns: string;
        referenced_schema: string;
        referenced_table: string;
        referenced_columns: string;
      }>(
        `SELECT
           con.conname AS constraint_name,
           src.relname AS table_name,
           array_to_string(ARRAY(
             SELECT att.attname
             FROM unnest(con.conkey) WITH ORDINALITY AS cols(attnum, ord)
             JOIN pg_attribute att
               ON att.attrelid = con.conrelid
              AND att.attnum = cols.attnum
             ORDER BY cols.ord
           ), ',') AS columns,
           ref_ns.nspname AS referenced_schema,
           ref.relname AS referenced_table,
           array_to_string(ARRAY(
             SELECT att.attname
             FROM unnest(con.confkey) WITH ORDINALITY AS cols(attnum, ord)
             JOIN pg_attribute att
               ON att.attrelid = con.confrelid
              AND att.attnum = cols.attnum
             ORDER BY cols.ord
           ), ',') AS referenced_columns
         FROM pg_constraint con
         JOIN pg_class src ON src.oid = con.conrelid
         JOIN pg_namespace src_ns ON src_ns.oid = src.relnamespace
         JOIN pg_class ref ON ref.oid = con.confrelid
         JOIN pg_namespace ref_ns ON ref_ns.oid = ref.relnamespace
         WHERE src_ns.nspname = 'marketplace'
           AND con.contype = 'f'
           AND con.conname IN (
             'fk_marketplace_chat_collaboration_property',
             'fk_marketplace_collaborations_commission_rule',
             'fk_marketplace_collaborations_creator_org',
             'fk_marketplace_collaborations_offer_org',
             'fk_marketplace_creator_platforms_creator_org',
             'fk_marketplace_deliverables_collaboration_property',
             'fk_marketplace_external_collaborations_trip_creator',
             'fk_marketplace_offer_deliverables_offer_org',
             'fk_marketplace_offers_profile_org',
             'fk_marketplace_invite_codes_creator_org',
             'fk_marketplace_compensation_options_offer_org',
             'fk_marketplace_ratings_collaboration_creator',
             'fk_marketplace_read_model_offer_property',
             'fk_marketplace_requirements_offer_org',
             'fk_marketplace_trips_creator_org'
           )
         ORDER BY con.conname`,
      );

      expect(marketplaceForeignKeyShapes).toEqual([
        {
          columns: "collaboration_id,property_id",
          constraint_name: "fk_marketplace_chat_collaboration_property",
          referenced_columns: "id,property_id",
          referenced_schema: "marketplace",
          referenced_table: "collaborations",
          table_name: "marketplace_chat_messages",
        },
        {
          columns: "commission_rule_id,hotel_organization_id",
          constraint_name: "fk_marketplace_collaborations_commission_rule",
          referenced_columns: "id,organization_id",
          referenced_schema: "finance",
          referenced_table: "commission_rules",
          table_name: "collaborations",
        },
        {
          columns: "creator_profile_id,creator_organization_id",
          constraint_name: "fk_marketplace_collaborations_creator_org",
          referenced_columns: "id,organization_id",
          referenced_schema: "marketplace",
          referenced_table: "creator_profiles",
          table_name: "collaborations",
        },
        {
          columns: "offer_id,property_id,hotel_organization_id",
          constraint_name: "fk_marketplace_collaborations_offer_org",
          referenced_columns: "id,property_id,organization_id",
          referenced_schema: "marketplace",
          referenced_table: "marketplace_offers",
          table_name: "collaborations",
        },
        {
          columns: "offer_id,property_id,organization_id",
          constraint_name: "fk_marketplace_compensation_options_offer_org",
          referenced_columns: "id,property_id,organization_id",
          referenced_schema: "marketplace",
          referenced_table: "marketplace_offers",
          table_name: "offer_compensation_options",
        },
        {
          columns: "creator_profile_id,organization_id",
          constraint_name: "fk_marketplace_creator_platforms_creator_org",
          referenced_columns: "id,organization_id",
          referenced_schema: "marketplace",
          referenced_table: "creator_profiles",
          table_name: "creator_platforms",
        },
        {
          columns: "collaboration_id,property_id",
          constraint_name: "fk_marketplace_deliverables_collaboration_property",
          referenced_columns: "id,property_id",
          referenced_schema: "marketplace",
          referenced_table: "collaborations",
          table_name: "collaboration_deliverables",
        },
        {
          columns: "trip_id,creator_profile_id",
          constraint_name: "fk_marketplace_external_collaborations_trip_creator",
          referenced_columns: "id,creator_profile_id",
          referenced_schema: "marketplace",
          referenced_table: "trips",
          table_name: "external_collaborations",
        },
        {
          columns: "creator_profile_id,creator_organization_id",
          constraint_name: "fk_marketplace_invite_codes_creator_org",
          referenced_columns: "id,organization_id",
          referenced_schema: "marketplace",
          referenced_table: "creator_profiles",
          table_name: "invite_codes",
        },
        {
          columns: "offer_id,property_id,organization_id",
          constraint_name: "fk_marketplace_offer_deliverables_offer_org",
          referenced_columns: "id,property_id,organization_id",
          referenced_schema: "marketplace",
          referenced_table: "marketplace_offers",
          table_name: "offer_deliverables",
        },
        {
          columns: "property_id,organization_id",
          constraint_name: "fk_marketplace_offers_profile_org",
          referenced_columns: "property_id,organization_id",
          referenced_schema: "marketplace",
          referenced_table: "marketplace_hotel_profiles",
          table_name: "marketplace_offers",
        },
        {
          columns: "collaboration_id,property_id,creator_profile_id",
          constraint_name: "fk_marketplace_ratings_collaboration_creator",
          referenced_columns: "id,property_id,creator_profile_id",
          referenced_schema: "marketplace",
          referenced_table: "collaborations",
          table_name: "creator_ratings",
        },
        {
          columns: "offer_id,property_id",
          constraint_name: "fk_marketplace_read_model_offer_property",
          referenced_columns: "id,property_id",
          referenced_schema: "marketplace",
          referenced_table: "marketplace_offers",
          table_name: "marketplace_offer_read_model",
        },
        {
          columns: "offer_id,property_id,organization_id",
          constraint_name: "fk_marketplace_requirements_offer_org",
          referenced_columns: "id,property_id,organization_id",
          referenced_schema: "marketplace",
          referenced_table: "marketplace_offers",
          table_name: "offer_creator_requirements",
        },
        {
          columns: "creator_profile_id,organization_id",
          constraint_name: "fk_marketplace_trips_creator_org",
          referenced_columns: "id,organization_id",
          referenced_schema: "marketplace",
          referenced_table: "creator_profiles",
          table_name: "trips",
        },
      ]);

      const { rows: marketplaceForeignKeySchemas } = await verifyClient.query<{
        constraint_name: string;
        referenced_schema: string;
      }>(
        `SELECT DISTINCT
           tc.constraint_name,
           ccu.table_schema AS referenced_schema
         FROM information_schema.table_constraints tc
         JOIN information_schema.constraint_column_usage ccu
           ON ccu.constraint_schema = tc.constraint_schema
          AND ccu.constraint_name = tc.constraint_name
         WHERE tc.table_schema = 'marketplace'
           AND tc.constraint_type = 'FOREIGN KEY'
           AND ccu.table_schema NOT IN (
             'finance', 'hotel_catalog', 'identity', 'marketplace', 'platform'
           )
         ORDER BY tc.constraint_name`,
      );

      expect(marketplaceForeignKeySchemas).toHaveLength(0);

      const { rows: marketplaceReadModelSensitiveColumns } = await verifyClient.query<{
        column_name: string;
      }>(
        `SELECT column_name
           FROM information_schema.columns
           WHERE table_schema = 'marketplace'
             AND table_name = 'marketplace_offer_read_model'
             AND column_name IN (
               'email', 'phone', 'user_id', 'created_by_user_id', 'redeemed_by_user_id',
               'body', 'content', 'message_body', 'message_metadata',
               'application_message', 'negotiated_terms', 'affiliate_link',
               'affiliate_referral_code', 'affiliate_commission_percentage', 'organization_id', 'private_notes',
               'pii_retention_until'
             )`,
      );

      expect(marketplaceReadModelSensitiveColumns).toHaveLength(0);

      const creatorUserId = "99999999-1111-4111-8111-999999999991";
      const hotelUserId = "99999999-1111-4111-8111-999999999992";
      const creatorOrganizationId = "99999999-2222-4222-8222-999999999991";
      const hotelOrganizationId = "99999999-2222-4222-8222-999999999992";
      const wrongOrganizationId = "99999999-2222-4222-8222-999999999993";
      const marketplacePropertyId = "99999999-3333-4333-8333-999999999991";
      const creatorProfileId = "99999999-4444-4444-8444-999999999991";
      const offerId = "99999999-5555-4555-8555-999999999991";
      const offerDeliverableId = "99999999-5555-4555-8555-999999999992";
      const commissionRuleId = "99999999-6666-4666-8666-999999999991";
      const wrongCommissionRuleId = "99999999-6666-4666-8666-999999999992";
      const marketplaceCollaborationId = "99999999-7777-4777-8777-999999999991";

      await verifyClient.query(
        `INSERT INTO identity.users (id, email, name, status)
         VALUES
           ($1, 'marketplace-creator@example.com', 'Marketplace Creator', 'active'),
           ($2, 'marketplace-hotel@example.com', 'Marketplace Hotel', 'active')`,
        [creatorUserId, hotelUserId],
      );
      await verifyClient.query(
        `INSERT INTO identity.organizations (id, kind, name, slug)
         VALUES
           ($1, 'creator_workspace', 'Marketplace Creator Workspace', 'marketplace-creator-workspace'),
           ($2, 'hotel_group', 'Marketplace Hotel Group', 'marketplace-hotel-group'),
           ($3, 'hotel_group', 'Marketplace Wrong Hotel Group', 'marketplace-wrong-hotel-group')`,
        [creatorOrganizationId, hotelOrganizationId, wrongOrganizationId],
      );
      await verifyClient.query(
        `INSERT INTO hotel_catalog.properties (id, public_id, display_name)
         VALUES ($1, 'marketplace-property-one', 'Marketplace Property One')`,
        [marketplacePropertyId],
      );
      await verifyClient.query(
        `INSERT INTO marketplace.creator_profiles
           (id, organization_id, owner_user_id, display_name, creator_type, profile_status)
         VALUES ($1, $2, $3, 'Marketplace Creator', 'travel', 'active')`,
        [creatorProfileId, creatorOrganizationId, creatorUserId],
      );
      await verifyClient.query(
        `INSERT INTO marketplace.creator_platforms
           (creator_profile_id, organization_id, platform, handle, follower_count, engagement_rate)
         VALUES ($1, $2, 'instagram', '@marketplace_creator', 125000, 1000.123456)`,
        [creatorProfileId, creatorOrganizationId],
      );
      const { rows: storedEngagementRates } = await verifyClient.query<{ engagement_rate: string }>(
        `SELECT engagement_rate::text
         FROM marketplace.creator_platforms
         WHERE creator_profile_id = $1 AND organization_id = $2`,
        [creatorProfileId, creatorOrganizationId],
      );
      expect(storedEngagementRates).toEqual([{ engagement_rate: "1000.123456" }]);

      const { rows: incompleteProfiles } = await verifyClient.query<{ complete: boolean }>(
        `SELECT marketplace.creator_profile_is_complete($1, $2) AS complete`,
        [creatorProfileId, creatorOrganizationId],
      );
      expect(incompleteProfiles).toEqual([{ complete: false }]);

      await verifyClient.query(
        `UPDATE marketplace.creator_profiles
         SET location_text = 'Berlin',
             short_description = 'Independent travel creator',
             phone = '+49123456789'
         WHERE id = $1 AND organization_id = $2`,
        [creatorProfileId, creatorOrganizationId],
      );
      const { rows: completedProfiles } = await verifyClient.query<{
        complete: boolean;
        wrong_organization_complete: boolean;
      }>(
        `SELECT
           marketplace.creator_profile_is_complete($1, $2) AS complete,
           marketplace.creator_profile_is_complete($1, $3) AS wrong_organization_complete`,
        [creatorProfileId, creatorOrganizationId, wrongOrganizationId],
      );
      expect(completedProfiles).toEqual([{ complete: false, wrong_organization_complete: false }]);

      await verifyClient.query(
        `UPDATE marketplace.creator_profiles
         SET profile_picture_url = 'https://images.example.test/creator.jpg',
             profile_metadata = jsonb_build_object(
               'profilePictureMediaObjectId',
               '99999999-8888-4888-8888-999999999991'
             )
         WHERE id = $1 AND organization_id = $2`,
        [creatorProfileId, creatorOrganizationId],
      );
      const { rows: unownedPhotoProfiles } = await verifyClient.query<{ complete: boolean }>(
        `SELECT marketplace.creator_profile_is_complete($1, $2) AS complete`,
        [creatorProfileId, creatorOrganizationId],
      );
      expect(unownedPhotoProfiles).toEqual([{ complete: false }]);

      await verifyClient.query(
        `INSERT INTO platform.media_objects (
           id, bucket, storage_key, visibility, purpose, owner_organization_id,
           resource_product, resource_type, resource_id, lifecycle_status,
           content_type, public_approved, created_by_user_id
         ) VALUES (
           '99999999-8888-4888-8888-999999999991', 'creator-media',
           'creator-profiles/owned.jpg', 'public', 'marketplace.creator.profile_image',
           $1, 'marketplace', 'creator_profile', $2, 'active', 'image/jpeg', TRUE, $3
         )`,
        [creatorOrganizationId, creatorProfileId, creatorUserId],
      );
      await verifyClient.query(
        `INSERT INTO platform.media_variants (
           media_object_id, variant_name, visibility, storage_key, content_type,
           public_cdn_url
         ) VALUES (
           '99999999-8888-4888-8888-999999999991', 'original_safe', 'public',
           'creator-profiles/owned.jpg', 'image/jpeg',
           'https://images.example.test/creator.jpg'
         )`,
      );
      const { rows: photoCompleteProfiles } = await verifyClient.query<{ complete: boolean }>(
        `SELECT marketplace.creator_profile_is_complete($1, $2) AS complete`,
        [creatorProfileId, creatorOrganizationId],
      );
      expect(photoCompleteProfiles).toEqual([{ complete: true }]);

      await verifyClient.query(
        `INSERT INTO platform.media_objects (
           id, bucket, storage_key, visibility, purpose, owner_organization_id,
           resource_product, resource_type, resource_id, lifecycle_status,
           content_type, public_approved, created_by_user_id
         ) VALUES (
           '99999999-8888-4888-8888-999999999992', 'creator-media',
           'user-profiles/owned.jpg', 'public', 'identity.user.profile_image',
           $1, 'platform', 'user_profile', $2::text, 'active', 'image/jpeg', TRUE, $2::uuid
         )`,
        [creatorOrganizationId, creatorUserId],
      );
      await verifyClient.query(
        `INSERT INTO platform.media_variants (
           media_object_id, variant_name, visibility, storage_key, content_type,
           public_cdn_url
         ) VALUES (
           '99999999-8888-4888-8888-999999999992', 'original_safe', 'public',
           'user-profiles/owned.jpg', 'image/jpeg',
           'https://images.example.test/identity-owner.jpg'
         )`,
      );
      await verifyClient.query(
        `UPDATE identity.users
         SET profile_picture_media_object_id = '99999999-8888-4888-8888-999999999992',
             profile_picture_url = 'https://images.example.test/identity-owner.jpg'
         WHERE id = $1`,
        [creatorUserId],
      );
      await verifyClient.query(
        `UPDATE marketplace.creator_profiles
         SET profile_picture_url = 'https://images.example.test/identity-owner.jpg',
             profile_metadata = jsonb_build_object(
               'profilePictureMediaObjectId',
               '99999999-8888-4888-8888-999999999992'
             )
         WHERE id = $1 AND organization_id = $2`,
        [creatorProfileId, creatorOrganizationId],
      );
      const { rows: identityPhotoCompleteProfiles } = await verifyClient.query<{
        complete: boolean;
      }>(`SELECT marketplace.creator_profile_is_complete($1, $2) AS complete`, [
        creatorProfileId,
        creatorOrganizationId,
      ]);
      expect(identityPhotoCompleteProfiles).toEqual([{ complete: true }]);

      await verifyClient.query(
        `UPDATE marketplace.creator_platforms
         SET platform = 'other', profile_url = NULL
         WHERE creator_profile_id = $1 AND organization_id = $2`,
        [creatorProfileId, creatorOrganizationId],
      );
      const { rows: otherPlatformWithoutUrls } = await verifyClient.query<{ complete: boolean }>(
        `SELECT marketplace.creator_profile_is_complete($1, $2) AS complete`,
        [creatorProfileId, creatorOrganizationId],
      );
      expect(otherPlatformWithoutUrls).toEqual([{ complete: false }]);
      await verifyClient.query(
        `UPDATE marketplace.creator_platforms
         SET platform = 'instagram', profile_url = NULL
         WHERE creator_profile_id = $1 AND organization_id = $2`,
        [creatorProfileId, creatorOrganizationId],
      );
      await verifyClient.query(
        `INSERT INTO marketplace.marketplace_hotel_profiles
           (property_id, organization_id, marketplace_profile_status, profile_complete)
         VALUES ($1, $2, 'verified', TRUE)`,
        [marketplacePropertyId, hotelOrganizationId],
      );
      await verifyClient.query(
        `INSERT INTO marketplace.marketplace_offers
           (id, property_id, organization_id, title, offer_summary, accommodation_type, offer_status)
         VALUES ($1, $2, $3, 'Creator Stay Offer', 'Public collaboration offer.', 'hotel', 'verified')`,
        [offerId, marketplacePropertyId, hotelOrganizationId],
      );
      await verifyClient.query(
        `INSERT INTO marketplace.offer_compensation_options
           (offer_id, property_id, organization_id, compensation_type, commission_percentage, currency)
         VALUES ($1, $2, $3, 'affiliate', 12.5, 'USD')`,
        [offerId, marketplacePropertyId, hotelOrganizationId],
      );
      await expect(
        verifyClient.query(
          `INSERT INTO marketplace.offer_compensation_options
             (offer_id, property_id, organization_id, compensation_type, commission_percentage, currency)
           VALUES ($1, $2, $3, 'affiliate', 12.5, 'USD')`,
          [offerId, marketplacePropertyId, wrongOrganizationId],
        ),
      ).rejects.toMatchObject({ code: "23503" });

      await verifyClient.query(
        `INSERT INTO marketplace.offer_deliverables
           (id, offer_id, property_id, organization_id, platform, deliverable_type, quantity)
         VALUES ($1, $2, $3, $4, 'instagram', 'reel', 2)`,
        [offerDeliverableId, offerId, marketplacePropertyId, hotelOrganizationId],
      );
      await expect(
        verifyClient.query(
          `INSERT INTO marketplace.offer_deliverables
             (offer_id, property_id, organization_id, platform, deliverable_type, quantity)
           VALUES ($1, $2, $3, 'instagram', 'story', 1)`,
          [offerId, marketplacePropertyId, wrongOrganizationId],
        ),
      ).rejects.toMatchObject({ code: "23503" });

      await verifyClient.query(
        `INSERT INTO finance.commission_rules
           (id, organization_id, rule_scope, product, commission_type, percentage_rate)
         VALUES
           ($1, $2, 'marketplace', 'marketplace', 'percentage', 12.5),
           ($3, $4, 'marketplace', 'marketplace', 'percentage', 12.5)`,
        [commissionRuleId, hotelOrganizationId, wrongCommissionRuleId, wrongOrganizationId],
      );
      await verifyClient.query(
        `INSERT INTO marketplace.collaborations
           (
             id, creator_profile_id, creator_organization_id, property_id,
             hotel_organization_id, offer_id, commission_rule_id,
             initiator_type, lifecycle_status, compensation_type, affiliate_enabled,
             affiliate_commission_percentage, currency, creator_consent
           )
         VALUES (
           $1, $2, $3, $4, $5, $6, $7,
           'creator', 'pending', NULL, TRUE, 12.5, 'USD', TRUE
         )`,
        [
          marketplaceCollaborationId,
          creatorProfileId,
          creatorOrganizationId,
          marketplacePropertyId,
          hotelOrganizationId,
          offerId,
          commissionRuleId,
        ],
      );
      await expect(
        verifyClient.query(
          `INSERT INTO marketplace.collaborations
             (
               creator_profile_id, creator_organization_id, property_id,
               hotel_organization_id, offer_id, initiator_type,
               lifecycle_status, compensation_type, affiliate_enabled,
               affiliate_commission_percentage, currency
             )
           VALUES ($1, $2, $3, $4, $5, 'creator', 'pending', NULL, TRUE, 12.5, 'USD')`,
          [
            creatorProfileId,
            creatorOrganizationId,
            marketplacePropertyId,
            hotelOrganizationId,
            offerId,
          ],
        ),
      ).rejects.toMatchObject({ code: "23514" });
      await expect(
        verifyClient.query(
          `INSERT INTO marketplace.collaborations
             (
               creator_profile_id, creator_organization_id, property_id,
               hotel_organization_id, offer_id, initiator_type,
               lifecycle_status, compensation_type, affiliate_enabled,
               affiliate_commission_percentage, currency,
               creator_consent
             )
           VALUES ($1, $2, $3, $4, $5, 'creator', 'declined', NULL, TRUE, 12.5, 'USD', TRUE)`,
          [
            creatorProfileId,
            creatorOrganizationId,
            marketplacePropertyId,
            wrongOrganizationId,
            offerId,
          ],
        ),
      ).rejects.toMatchObject({ code: "23503" });
      await expect(
        verifyClient.query(
          `INSERT INTO marketplace.collaborations
             (
               creator_profile_id, creator_organization_id, property_id,
               hotel_organization_id, offer_id, commission_rule_id,
               initiator_type, lifecycle_status, compensation_type, affiliate_enabled,
               affiliate_commission_percentage, currency, creator_consent
             )
           VALUES (
             $1, $2, $3, $4, $5, $6,
             'creator', 'declined', NULL, TRUE, 12.5, 'USD', TRUE
           )`,
          [
            creatorProfileId,
            creatorOrganizationId,
            marketplacePropertyId,
            hotelOrganizationId,
            offerId,
            wrongCommissionRuleId,
          ],
        ),
      ).rejects.toMatchObject({ code: "23503" });

      await verifyClient.query(
        `INSERT INTO marketplace.marketplace_offer_read_model
           (
             offer_id, property_id, public_id,
             canonical_slug, display_name, offer_title, offer_summary,
             accommodation_type, visibility_status
           )
         VALUES (
           $1, $2, 'marketplace-property-one', 'marketplace-property-one',
           'Marketplace Property One', 'Creator Stay Offer',
           'Public collaboration offer.', 'hotel', 'public'
         )`,
        [offerId, marketplacePropertyId],
      );
      await expect(
        verifyClient.query(
          `UPDATE marketplace.marketplace_offer_read_model
           SET public_compensation_summary = $1::jsonb
           WHERE offer_id = $2`,
          [
            JSON.stringify([
              {
                type: "affiliate",
                terms: { affiliateLink: "https://private.example/affiliate" },
              },
            ]),
            offerId,
          ],
        ),
      ).rejects.toMatchObject({ code: "23514" });

      const { rows: distributionTableRows } = await verifyClient.query<{ table_name: string }>(
        `SELECT table_name
         FROM information_schema.tables
         WHERE table_schema = 'distribution'
         ORDER BY table_name`,
      );

      expect(distributionTableRows.map((row) => row.table_name)).toEqual([
        "active_public_booking_revision",
        "booking_deep_link_contexts",
        "external_api_clients",
        "external_api_usage_events",
        "live_ari_watermarks",
        "public_booking_content_revisions",
        "public_hotel_bookability_profiles",
        "public_quote_read_models",
        "public_room_offer_snapshots",
      ]);

      await expect(
        verifyClient.query(`TRUNCATE distribution.public_booking_content_revisions CASCADE`),
      ).rejects.toMatchObject({ code: "55000" });

      const { rows: lifecycleReadinessContractColumns } = await verifyClient.query<{
        table_schema: string;
        table_name: string;
        column_name: string;
      }>(
        `SELECT table_schema, table_name, column_name
         FROM information_schema.columns
         WHERE column_name = 'readiness_contract_version'
           AND (
             (table_schema = 'marketplace' AND table_name = 'hotel_submission_revisions')
             OR
             (table_schema = 'distribution' AND table_name = 'public_booking_content_revisions')
           )
         ORDER BY table_schema, table_name`,
      );

      expect(lifecycleReadinessContractColumns).toEqual([
        {
          table_schema: "distribution",
          table_name: "public_booking_content_revisions",
          column_name: "readiness_contract_version",
        },
        {
          table_schema: "marketplace",
          table_name: "hotel_submission_revisions",
          column_name: "readiness_contract_version",
        },
      ]);

      const { rows: distributionIntegrityConstraints } = await verifyClient.query<{
        constraint_name: string;
      }>(
        `SELECT constraint_name
         FROM information_schema.table_constraints
         WHERE table_schema = 'distribution'
           AND constraint_name IN (
             'chk_distribution_bookability_profiles_contract',
             'chk_distribution_bookability_profiles_currency_upper',
             'chk_distribution_bookability_profiles_finance_property',
             'chk_distribution_bookability_profiles_locale_supported',
             'chk_distribution_bookability_profiles_public_json',
             'chk_distribution_bookability_profiles_public_visibility',
             'chk_distribution_bookability_profiles_sources',
             'chk_distribution_bookability_profiles_timezone',
             'chk_distribution_deep_link_contexts_checkout_quote_pair',
             'chk_distribution_deep_link_contexts_currency_upper',
             'chk_distribution_deep_link_contexts_date_order',
             'chk_distribution_deep_link_contexts_preserves',
             'chk_distribution_deep_link_contexts_public_json',
             'chk_distribution_external_api_clients_public_metadata',
             'chk_distribution_external_api_clients_revocation',
             'chk_distribution_external_api_clients_surfaces',
             'chk_distribution_quote_read_models_contract',
             'chk_distribution_quote_read_models_currency_upper',
             'chk_distribution_quote_read_models_public_json',
             'chk_distribution_quote_read_models_public_visibility',
             'chk_distribution_quote_read_models_sources',
             'chk_distribution_room_offer_snapshots_contract',
             'chk_distribution_room_offer_snapshots_currency_upper',
             'chk_distribution_room_offer_snapshots_payment_options',
             'chk_distribution_room_offer_snapshots_public_json',
             'chk_distribution_room_offer_snapshots_public_visibility',
             'chk_distribution_room_offer_snapshots_sources',
             'chk_distribution_usage_events_deep_link_property',
             'chk_distribution_usage_events_public_metadata',
             'chk_distribution_usage_events_quote_property',
             'fk_distribution_bookability_profiles_catalog_profile',
             'fk_distribution_bookability_profiles_finance_settings',
             'fk_distribution_deep_link_contexts_bookability_profile',
             'fk_distribution_deep_link_contexts_checkout_property',
             'fk_distribution_deep_link_contexts_quote_property',
             'fk_distribution_quote_read_models_bookability_profile',
             'fk_distribution_quote_read_models_quote_property',
             'fk_distribution_room_offer_snapshots_bookability_profile',
             'fk_distribution_room_offer_snapshots_inventory_day',
             'fk_distribution_room_offer_snapshots_rate_plan',
             'fk_distribution_usage_events_deep_link_property',
             'fk_distribution_usage_events_quote_property',
             'uq_distribution_bookability_profiles_public_id',
             'uq_distribution_deep_link_contexts_id_property',
             'uq_distribution_deep_link_contexts_token_hash',
             'uq_distribution_external_api_clients_public_id',
             'uq_distribution_quote_read_models_public_reference',
             'uq_distribution_room_offer_snapshots_id_property',
             'uq_distribution_room_offer_snapshots_offer_date'
           )
         ORDER BY constraint_name`,
      );

      expect(distributionIntegrityConstraints.map((row) => row.constraint_name)).toEqual([
        "chk_distribution_bookability_profiles_contract",
        "chk_distribution_bookability_profiles_currency_upper",
        "chk_distribution_bookability_profiles_finance_property",
        "chk_distribution_bookability_profiles_locale_supported",
        "chk_distribution_bookability_profiles_public_json",
        "chk_distribution_bookability_profiles_public_visibility",
        "chk_distribution_bookability_profiles_sources",
        "chk_distribution_bookability_profiles_timezone",
        "chk_distribution_deep_link_contexts_checkout_quote_pair",
        "chk_distribution_deep_link_contexts_currency_upper",
        "chk_distribution_deep_link_contexts_date_order",
        "chk_distribution_deep_link_contexts_preserves",
        "chk_distribution_deep_link_contexts_public_json",
        "chk_distribution_external_api_clients_public_metadata",
        "chk_distribution_external_api_clients_revocation",
        "chk_distribution_external_api_clients_surfaces",
        "chk_distribution_quote_read_models_contract",
        "chk_distribution_quote_read_models_currency_upper",
        "chk_distribution_quote_read_models_public_json",
        "chk_distribution_quote_read_models_public_visibility",
        "chk_distribution_quote_read_models_sources",
        "chk_distribution_room_offer_snapshots_contract",
        "chk_distribution_room_offer_snapshots_currency_upper",
        "chk_distribution_room_offer_snapshots_payment_options",
        "chk_distribution_room_offer_snapshots_public_json",
        "chk_distribution_room_offer_snapshots_public_visibility",
        "chk_distribution_room_offer_snapshots_sources",
        "chk_distribution_usage_events_deep_link_property",
        "chk_distribution_usage_events_public_metadata",
        "chk_distribution_usage_events_quote_property",
        "fk_distribution_bookability_profiles_catalog_profile",
        "fk_distribution_bookability_profiles_finance_settings",
        "fk_distribution_deep_link_contexts_bookability_profile",
        "fk_distribution_deep_link_contexts_checkout_property",
        "fk_distribution_deep_link_contexts_quote_property",
        "fk_distribution_quote_read_models_bookability_profile",
        "fk_distribution_quote_read_models_quote_property",
        "fk_distribution_room_offer_snapshots_bookability_profile",
        "fk_distribution_room_offer_snapshots_inventory_day",
        "fk_distribution_room_offer_snapshots_rate_plan",
        "fk_distribution_usage_events_deep_link_property",
        "fk_distribution_usage_events_quote_property",
        "uq_distribution_bookability_profiles_public_id",
        "uq_distribution_deep_link_contexts_id_property",
        "uq_distribution_deep_link_contexts_token_hash",
        "uq_distribution_external_api_clients_public_id",
        "uq_distribution_quote_read_models_public_reference",
        "uq_distribution_room_offer_snapshots_id_property",
        "uq_distribution_room_offer_snapshots_offer_date",
      ]);

      const { rows: distributionForeignKeyShapes } = await verifyClient.query<{
        constraint_name: string;
        table_name: string;
        columns: string;
        referenced_schema: string;
        referenced_table: string;
        referenced_columns: string;
      }>(
        `SELECT
           con.conname AS constraint_name,
           src.relname AS table_name,
           array_to_string(ARRAY(
             SELECT att.attname
             FROM unnest(con.conkey) WITH ORDINALITY AS cols(attnum, ord)
             JOIN pg_attribute att
               ON att.attrelid = con.conrelid
              AND att.attnum = cols.attnum
             ORDER BY cols.ord
           ), ',') AS columns,
           ref_ns.nspname AS referenced_schema,
           ref.relname AS referenced_table,
           array_to_string(ARRAY(
             SELECT att.attname
             FROM unnest(con.confkey) WITH ORDINALITY AS cols(attnum, ord)
             JOIN pg_attribute att
               ON att.attrelid = con.confrelid
              AND att.attnum = cols.attnum
             ORDER BY cols.ord
           ), ',') AS referenced_columns
         FROM pg_constraint con
         JOIN pg_class src ON src.oid = con.conrelid
         JOIN pg_namespace src_ns ON src_ns.oid = src.relnamespace
         JOIN pg_class ref ON ref.oid = con.confrelid
         JOIN pg_namespace ref_ns ON ref_ns.oid = ref.relnamespace
         WHERE src_ns.nspname = 'distribution'
           AND con.contype = 'f'
           AND con.conname IN (
             'fk_distribution_bookability_profiles_catalog_profile',
             'fk_distribution_bookability_profiles_finance_settings',
             'fk_distribution_deep_link_contexts_bookability_profile',
             'fk_distribution_deep_link_contexts_checkout_property',
             'fk_distribution_deep_link_contexts_quote_property',
             'fk_distribution_quote_read_models_bookability_profile',
             'fk_distribution_quote_read_models_quote_property',
             'fk_distribution_room_offer_snapshots_bookability_profile',
             'fk_distribution_room_offer_snapshots_inventory_day',
             'fk_distribution_room_offer_snapshots_rate_plan',
             'fk_distribution_usage_events_deep_link_property',
             'fk_distribution_usage_events_quote_property'
           )
         ORDER BY con.conname`,
      );

      expect(distributionForeignKeyShapes).toEqual([
        {
          columns: "property_id",
          constraint_name: "fk_distribution_bookability_profiles_catalog_profile",
          referenced_columns: "property_id",
          referenced_schema: "hotel_catalog",
          referenced_table: "property_public_profile_read_model",
          table_name: "public_hotel_bookability_profiles",
        },
        {
          columns: "finance_payment_settings_property_id",
          constraint_name: "fk_distribution_bookability_profiles_finance_settings",
          referenced_columns: "property_id",
          referenced_schema: "finance",
          referenced_table: "payment_settings",
          table_name: "public_hotel_bookability_profiles",
        },
        {
          columns: "property_id",
          constraint_name: "fk_distribution_deep_link_contexts_bookability_profile",
          referenced_columns: "property_id",
          referenced_schema: "distribution",
          referenced_table: "public_hotel_bookability_profiles",
          table_name: "booking_deep_link_contexts",
        },
        {
          columns: "checkout_context_id,property_id,quote_session_id",
          constraint_name: "fk_distribution_deep_link_contexts_checkout_property",
          referenced_columns: "id,property_id,quote_session_id",
          referenced_schema: "booking",
          referenced_table: "checkout_contexts",
          table_name: "booking_deep_link_contexts",
        },
        {
          columns: "quote_session_id,property_id",
          constraint_name: "fk_distribution_deep_link_contexts_quote_property",
          referenced_columns: "id,property_id",
          referenced_schema: "booking",
          referenced_table: "quote_sessions",
          table_name: "booking_deep_link_contexts",
        },
        {
          columns: "property_id",
          constraint_name: "fk_distribution_quote_read_models_bookability_profile",
          referenced_columns: "property_id",
          referenced_schema: "distribution",
          referenced_table: "public_hotel_bookability_profiles",
          table_name: "public_quote_read_models",
        },
        {
          columns: "quote_session_id,property_id",
          constraint_name: "fk_distribution_quote_read_models_quote_property",
          referenced_columns: "id,property_id",
          referenced_schema: "booking",
          referenced_table: "quote_sessions",
          table_name: "public_quote_read_models",
        },
        {
          columns: "property_id",
          constraint_name: "fk_distribution_room_offer_snapshots_bookability_profile",
          referenced_columns: "property_id",
          referenced_schema: "distribution",
          referenced_table: "public_hotel_bookability_profiles",
          table_name: "public_room_offer_snapshots",
        },
        {
          columns: "property_id,room_type_id,stay_date",
          constraint_name: "fk_distribution_room_offer_snapshots_inventory_day",
          referenced_columns: "property_id,room_type_id,stay_date",
          referenced_schema: "pms",
          referenced_table: "inventory_days",
          table_name: "public_room_offer_snapshots",
        },
        {
          columns: "rate_plan_id,property_id,room_type_id",
          constraint_name: "fk_distribution_room_offer_snapshots_rate_plan",
          referenced_columns: "id,property_id,room_type_id",
          referenced_schema: "pms",
          referenced_table: "rate_plans",
          table_name: "public_room_offer_snapshots",
        },
        {
          columns: "deep_link_context_id,property_id",
          constraint_name: "fk_distribution_usage_events_deep_link_property",
          referenced_columns: "id,property_id",
          referenced_schema: "distribution",
          referenced_table: "booking_deep_link_contexts",
          table_name: "external_api_usage_events",
        },
        {
          columns: "quote_session_id,property_id",
          constraint_name: "fk_distribution_usage_events_quote_property",
          referenced_columns: "id,property_id",
          referenced_schema: "booking",
          referenced_table: "quote_sessions",
          table_name: "external_api_usage_events",
        },
      ]);

      const { rows: distributionForeignKeySchemas } = await verifyClient.query<{
        constraint_name: string;
        referenced_schema: string;
      }>(
        `SELECT DISTINCT
           tc.constraint_name,
           ccu.table_schema AS referenced_schema
         FROM information_schema.table_constraints tc
         JOIN information_schema.constraint_column_usage ccu
           ON ccu.constraint_schema = tc.constraint_schema
          AND ccu.constraint_name = tc.constraint_name
         WHERE tc.table_schema = 'distribution'
           AND tc.constraint_type = 'FOREIGN KEY'
           AND ccu.table_schema NOT IN ('booking', 'distribution', 'finance', 'hotel_catalog', 'identity', 'pms')
         ORDER BY tc.constraint_name`,
      );

      expect(distributionForeignKeySchemas).toHaveLength(0);

      const { rows: distributionReadModelSensitiveColumns } = await verifyClient.query<{
        table_name: string;
        column_name: string;
      }>(
        `SELECT table_name, column_name
         FROM information_schema.columns
         WHERE table_schema = 'distribution'
           AND table_name IN (
             'public_hotel_bookability_profiles',
             'public_room_offer_snapshots',
             'public_quote_read_models'
           )
           AND column_name IN (
             'first_name', 'last_name', 'email', 'phone',
             'guest_name', 'guest_email', 'guest_phone',
             'special_requests', 'private_notes', 'message_body',
             'provider_account_id', 'provider_transaction_id',
             'provider_payment_intent_id', 'payout_setting_id',
             'commission_rule_id', 'room_id', 'room_number',
             'assignment_id', 'channel_connection_id', 'raw_payload',
             'raw_headers', 'raw_body'
           )`,
      );

      expect(distributionReadModelSensitiveColumns).toHaveLength(0);

      const { rows: externalApiSecretColumns } = await verifyClient.query<{
        column_name: string;
      }>(
        `SELECT column_name
         FROM information_schema.columns
         WHERE table_schema = 'distribution'
           AND table_name = 'external_api_clients'
           AND column_name IN (
             'api_key', 'secret', 'client_secret',
             'raw_secret', 'token', 'access_token'
           )`,
      );

      expect(externalApiSecretColumns).toHaveLength(0);

      const distributionUserId = "aaaaaaaa-1111-4111-8111-aaaaaaaaaaa1";
      const distributionPropertyId = "aaaaaaaa-2222-4222-8222-aaaaaaaaaaa1";
      const distributionRoomTypeId = "aaaaaaaa-3333-4333-8333-aaaaaaaaaaa1";
      const distributionRatePlanId = "aaaaaaaa-4444-4444-8444-aaaaaaaaaaa1";
      const distributionQuoteSessionId = "aaaaaaaa-5555-4555-8555-aaaaaaaaaaa1";
      const distributionCheckoutContextId = "aaaaaaaa-6666-4666-8666-aaaaaaaaaaa1";
      const distributionDeepLinkContextId = "aaaaaaaa-7777-4777-8777-aaaaaaaaaaa1";
      const distributionClientId = "aaaaaaaa-8888-4888-8888-aaaaaaaaaaa1";
      const distributionMismatchQuoteSessionId = "aaaaaaaa-5555-4555-8555-aaaaaaaaaaa2";
      const distributionMismatchCheckoutContextId = "aaaaaaaa-6666-4666-8666-aaaaaaaaaaa2";

      await verifyClient.query(
        `INSERT INTO identity.users (id, email, name, status)
         VALUES ($1, 'distribution-client-admin@example.com', 'Distribution Client Admin', 'active')`,
        [distributionUserId],
      );
      await verifyClient.query(
        `INSERT INTO hotel_catalog.properties
           (id, public_id, display_name, default_locale, supported_locales, profile_status)
         VALUES ($1, 'distribution-property-one', 'Distribution Property One', 'en', ARRAY['en', 'de']::TEXT[], 'complete')`,
        [distributionPropertyId],
      );
      await verifyClient.query(
        `INSERT INTO hotel_catalog.property_public_profile_read_model
           (
             property_id, public_id, display_name, canonical_slug,
             default_locale, supported_locales, profile_status,
             location, descriptions, media, amenities, public_policy,
             source_freshness
           )
         VALUES (
           $1, 'distribution-property-one', 'Distribution Property One',
           'distribution-property-one', 'en', ARRAY['en', 'de']::TEXT[],
           'complete',
           '{"country":"US","city":"Austin","timezone":"America/Chicago"}'::jsonb,
           '{"summary":"Public distribution test property."}'::jsonb,
           '[]'::jsonb,
           '["wifi"]'::jsonb,
           '{"checkInFrom":"15:00","checkOutUntil":"11:00"}'::jsonb,
           '{"sources":[{"owner":"hotel_catalog","status":"fresh"}]}'::jsonb
         )`,
        [distributionPropertyId],
      );
      await verifyClient.query(
        `INSERT INTO finance.payment_settings
           (property_id, payments_enabled, accepted_methods, default_currency)
         VALUES ($1, TRUE, ARRAY['card', 'pay_at_property']::TEXT[], 'USD')`,
        [distributionPropertyId],
      );
      await verifyClient.query(
        `INSERT INTO distribution.public_hotel_bookability_profiles
           (
             property_id, finance_payment_settings_property_id, public_id,
             canonical_slug, canonical_url, booking_base_url, timezone,
             default_locale, supported_locales, default_currency,
             supported_currencies, profile_status, public_identity,
             capabilities, supported_quote_parameters, source_freshness,
             freshness_status, data_sources
           )
         VALUES (
             $1, $1, 'distribution-property-one',
             'distribution-property-one',
             'https://distribution-property-one.booking.localhost/en',
             'https://distribution-property-one.booking.localhost',
             'America/Chicago', 'en', ARRAY['en', 'de']::TEXT[],
             'USD', ARRAY['USD']::TEXT[], 'public',
             '{"name":"Distribution Property One"}'::jsonb,
             '{"instantBook":true,"onlinePayment":true}'::jsonb,
             '{"minRooms":1,"maxRooms":3,"minAdults":1,"maxAdults":6}'::jsonb,
             '{"sources":[{"owner":"hotel_catalog","status":"fresh"},{"owner":"finance","status":"fresh"}]}'::jsonb,
             'fresh',
             ARRAY['hotel_catalog', 'finance', 'distribution']::TEXT[]
         )`,
        [distributionPropertyId],
      );
      await expect(
        verifyClient.query(
          `UPDATE distribution.public_hotel_bookability_profiles
           SET source_freshness = $1::jsonb
           WHERE property_id = $2`,
          [
            JSON.stringify({
              sources: [{ owner: "booking", guestEmail: "guest@example.com" }],
            }),
            distributionPropertyId,
          ],
        ),
      ).rejects.toMatchObject({ code: "23514" });

      await verifyClient.query(
        `INSERT INTO pms.room_types
           (id, property_id, name, description, base_rate_amount, currency)
         VALUES ($1, $2, 'Public Suite', 'Public suite description.', 200, 'USD')`,
        [distributionRoomTypeId, distributionPropertyId],
      );
      await verifyClient.query(
        `INSERT INTO pms.rate_plans
           (id, property_id, room_type_id, code, name, base_rate_amount, currency)
         VALUES ($1, $2, $3, 'FLEX', 'Flexible public rate', 200, 'USD')`,
        [distributionRatePlanId, distributionPropertyId, distributionRoomTypeId],
      );
      await verifyClient.query(
        `INSERT INTO pms.inventory_days
           (property_id, room_type_id, stay_date, total_count, available_count, source_freshness)
         VALUES (
           $1, $2, DATE '2026-03-01', 5, 4,
           '{"sources":[{"owner":"pms","status":"fresh"}]}'::jsonb
         )`,
        [distributionPropertyId, distributionRoomTypeId],
      );
      await verifyClient.query(
        `INSERT INTO distribution.public_room_offer_snapshots
           (
             property_id, room_type_id, rate_plan_id, stay_date,
             public_offer_key, available_rooms, base_price_amount,
             taxes_and_fees_amount, currency, occupancy,
             room_summary, rate_summary, payment_options,
             public_policy, source_freshness, freshness_status
           )
         VALUES (
           $1, $2, $3, DATE '2026-03-01',
           'suite-flex-2026-03-01', 4, 200, 20, 'USD',
           '{"maxAdults":2,"maxChildren":1}'::jsonb,
           '{"name":"Public Suite"}'::jsonb,
           '{"name":"Flexible public rate","refundable":true}'::jsonb,
           ARRAY['card', 'pay_at_property']::TEXT[],
           '{"cancellation":"Free cancellation summary."}'::jsonb,
           '{"sources":[{"owner":"pms","status":"fresh"}]}'::jsonb,
           'fresh'
         )`,
        [distributionPropertyId, distributionRoomTypeId, distributionRatePlanId],
      );
      await expect(
        verifyClient.query(
          `INSERT INTO distribution.public_room_offer_snapshots
             (
               property_id, room_type_id, rate_plan_id, stay_date,
               public_offer_key, currency
             )
           VALUES ($1, $2, $3, DATE '2026-03-01', 'bad-rate-plan', 'USD')`,
          [distributionPropertyId, distributionRoomTypeId, "aaaaaaaa-4444-4444-8444-aaaaaaaaaaa2"],
        ),
      ).rejects.toMatchObject({ code: "23503" });

      await verifyClient.query(
        `INSERT INTO booking.quote_sessions
           (
             id, property_id, request_hash, public_quote_reference,
             requested_check_in, requested_check_out, adults,
             children, requested_room_count, currency, expires_at
           )
         VALUES (
           $1, $2, 'sha256:distribution-test',
           'DIST-QUOTE-ONE', DATE '2026-03-01', DATE '2026-03-03',
           2, 0, 1, 'USD', now() + INTERVAL '15 minutes'
         )`,
        [distributionQuoteSessionId, distributionPropertyId],
      );
      await verifyClient.query(
        `INSERT INTO booking.checkout_contexts
           (id, quote_session_id, property_id, locale, currency, expires_at)
         VALUES ($1, $2, $3, 'en', 'USD', now() + INTERVAL '15 minutes')`,
        [distributionCheckoutContextId, distributionQuoteSessionId, distributionPropertyId],
      );
      await verifyClient.query(
        `INSERT INTO booking.quote_sessions
           (
             id, property_id, request_hash, public_quote_reference,
             requested_check_in, requested_check_out, adults,
             children, requested_room_count, currency, expires_at
           )
         VALUES (
           $1, $2, 'sha256:distribution-mismatch-test',
           'DIST-QUOTE-TWO', DATE '2026-03-01', DATE '2026-03-03',
           2, 0, 1, 'USD', now() + INTERVAL '15 minutes'
         )`,
        [distributionMismatchQuoteSessionId, distributionPropertyId],
      );
      await verifyClient.query(
        `INSERT INTO booking.checkout_contexts
           (id, quote_session_id, property_id, locale, currency, expires_at)
         VALUES ($1, $2, $3, 'en', 'USD', now() + INTERVAL '15 minutes')`,
        [
          distributionMismatchCheckoutContextId,
          distributionMismatchQuoteSessionId,
          distributionPropertyId,
        ],
      );
      await verifyClient.query(
        `INSERT INTO distribution.public_quote_read_models
           (
             quote_session_id, property_id, public_quote_reference,
             quote_hash, request_snapshot, quote_status,
             offers, totals, deep_link_url, currency,
             source_freshness, freshness_status, expires_at
           )
         VALUES (
           $1, $2, 'DIST-QUOTE-ONE', 'sha256:distribution-test',
           '{"checkIn":"2026-03-01","checkOut":"2026-03-03","adults":2,"rooms":1}'::jsonb,
           'bookable',
           '[{"offerId":"suite-flex","paymentOptions":["card","pay_at_property"]}]'::jsonb,
           '{"currency":"USD","grandTotal":440}'::jsonb,
           'https://distribution-property-one.booking.localhost/en/book?quote_id=DIST-QUOTE-ONE',
           'USD',
           '{"sources":[{"owner":"booking","status":"fresh"},{"owner":"pms","status":"fresh"}]}'::jsonb,
           'fresh',
           now() + INTERVAL '15 minutes'
         )`,
        [distributionQuoteSessionId, distributionPropertyId],
      );
      await expect(
        verifyClient.query(
          `UPDATE distribution.public_quote_read_models
           SET offers = $1::jsonb
           WHERE quote_session_id = $2`,
          [
            JSON.stringify([
              {
                offerId: "suite-flex",
                finance: { providerAccountId: "acct_private" },
              },
            ]),
            distributionQuoteSessionId,
          ],
        ),
      ).rejects.toMatchObject({ code: "23514" });

      await expect(
        verifyClient.query(
          `INSERT INTO distribution.booking_deep_link_contexts
             (
               property_id, quote_session_id, checkout_context_id,
               context_token_hash, deep_link_url, locale, currency,
               check_in, check_out, adults, children, rooms,
               expires_at
             )
           VALUES (
             $1, $2, $3, 'sha256:mismatched-deep-link',
             'https://distribution-property-one.booking.localhost/en/book?quote_id=DIST-QUOTE-ONE',
             'en', 'USD', DATE '2026-03-01', DATE '2026-03-03',
             2, 0, 1, now() + INTERVAL '15 minutes'
           )`,
          [
            distributionPropertyId,
            distributionQuoteSessionId,
            distributionMismatchCheckoutContextId,
          ],
        ),
      ).rejects.toMatchObject({ code: "23503" });

      await verifyClient.query(
        `INSERT INTO distribution.booking_deep_link_contexts
           (
             id, property_id, quote_session_id, checkout_context_id,
             public_quote_reference, context_token_hash, deep_link_url,
             locale, currency, check_in, check_out, adults,
             children, rooms, referral_code, request_context,
             source_freshness, expires_at
           )
         VALUES (
           $1, $2, $3, $4, 'DIST-QUOTE-ONE',
           'sha256:deep-link-context',
           'https://distribution-property-one.booking.localhost/en/book?quote_id=DIST-QUOTE-ONE',
           'en', 'USD', DATE '2026-03-01', DATE '2026-03-03',
           2, 0, 1, 'creator-public',
           '{"preserves":["dates","guests","quote_id"]}'::jsonb,
           '{"sources":[{"owner":"distribution","status":"fresh"}]}'::jsonb,
           now() + INTERVAL '15 minutes'
         )`,
        [
          distributionDeepLinkContextId,
          distributionPropertyId,
          distributionQuoteSessionId,
          distributionCheckoutContextId,
        ],
      );

      await verifyClient.query(
        `INSERT INTO distribution.external_api_clients
           (
             id, public_client_id, client_name, contact_email,
             allowed_surfaces, rate_limit_tier, terms_version,
             credential_hash_ref, created_by_user_id, client_metadata
           )
         VALUES (
           $1, 'client_public_distribution_test',
           'Distribution Public Client',
           'partner@example.com',
           ARRAY['public_profile', 'public_quote']::TEXT[],
           'partner', 'public-bookability-v1',
           'sha256:credential-hash-ref',
           $2,
           '{"owner":"partner-success"}'::jsonb
         )`,
        [distributionClientId, distributionUserId],
      );
      await expect(
        verifyClient.query(
          `INSERT INTO distribution.external_api_clients
             (public_client_id, client_name, rate_limit_tier, terms_version)
           VALUES (
             'client_public_distribution_test',
             'Duplicate Client', 'partner', 'public-bookability-v1'
           )`,
        ),
      ).rejects.toMatchObject({ code: "23505" });
      await expect(
        verifyClient.query(
          `INSERT INTO distribution.external_api_clients
             (
               public_client_id, client_name, status, rate_limit_tier,
               terms_version, revoked_at
             )
           VALUES (
             'client_public_distribution_active_revoked',
             'Active But Revoked Client', 'active', 'partner',
             'public-bookability-v1', now()
           )`,
        ),
      ).rejects.toMatchObject({ code: "23514" });
      await expect(
        verifyClient.query(
          `INSERT INTO distribution.external_api_clients
             (public_client_id, client_name, rate_limit_tier, terms_version, client_metadata)
           VALUES (
             'client_public_distribution_bad_secret',
             'Bad Secret Client', 'partner', 'public-bookability-v1',
             '{"apiKey":"raw-key-should-not-live-here"}'::jsonb
           )`,
        ),
      ).rejects.toMatchObject({ code: "23514" });

      await verifyClient.query(
        `INSERT INTO distribution.external_api_usage_events
           (
             client_id, property_id, quote_session_id, deep_link_context_id,
             surface, request_method, route_template, response_status,
             rate_limit_policy, rate_limit_tier, rate_limit_key_hash,
             request_fingerprint_hash, ip_address_hash, user_agent_hash,
             cache_status, latency_ms, usage_metadata
           )
         VALUES (
           $1, $2, $3, $4, 'public_quote', 'GET',
           '/api/ai/hotels/{slug}/quote', 200,
           'public-ai-quote-read', 'partner',
           'sha256:rate-limit-key', 'sha256:request-fingerprint',
           'sha256:ip-address', 'sha256:user-agent', 'miss', 42,
           '{"cacheKey":"public-quote"}'::jsonb
         )`,
        [
          distributionClientId,
          distributionPropertyId,
          distributionQuoteSessionId,
          distributionDeepLinkContextId,
        ],
      );
      await expect(
        verifyClient.query(`DELETE FROM distribution.external_api_clients WHERE id = $1`, [
          distributionClientId,
        ]),
      ).rejects.toMatchObject({ code: "23503" });
      await expect(
        verifyClient.query(
          `INSERT INTO distribution.external_api_usage_events
             (
               client_id, surface, request_method, route_template,
               response_status, rate_limit_policy, rate_limit_tier,
               usage_metadata
             )
           VALUES (
             $1, 'public_quote', 'GET', '/api/ai/hotels/{slug}/quote',
             200, 'public-ai-quote-read', 'partner',
             '{"requestBody":{"raw":"private request body"}}'::jsonb
           )`,
          [distributionClientId],
        ),
      ).rejects.toMatchObject({ code: "23514" });

      const { rows: platformTableRows } = await verifyClient.query<{ table_name: string }>(
        `SELECT table_name
         FROM information_schema.tables
         WHERE table_schema = 'platform'
         ORDER BY table_name`,
      );

      expect(platformTableRows.map((row) => row.table_name)).toEqual([
        "dead_letter_events",
        "domain_events",
        "external_webhook_events",
        "idempotency_keys",
        "job_attempts",
        "jobs",
        "media_objects",
        "media_upload_sessions",
        "media_variants",
        "outbox_events",
        "product_audit_events",
        "production_booking_migration_inferences",
        "production_booking_migration_quarantines",
        "production_cutover_runs",
        "production_cutover_steps",
        "production_finance_migration_dispositions",
        "production_marketplace_migration_quarantines",
        "production_media_migration_items",
        "production_media_migration_quarantines",
        "production_media_migration_runs",
        "production_migration_source_links",
        "schema_migrations",
        "source_extraction_runs",
        "source_extraction_sources",
        "source_extraction_tables",
      ]);

      const { rows: platformLedgerIndexes } = await verifyClient.query<{
        indexname: string;
      }>(
        `SELECT indexname
         FROM pg_indexes
         WHERE schemaname = 'platform'
           AND tablename = 'schema_migrations'
           AND indexname IN (
             'idx_platform_schema_migrations_environment_version',
             'uq_platform_schema_migrations_applied_version'
           )
         ORDER BY indexname`,
      );

      expect(platformLedgerIndexes.map((row) => row.indexname)).toEqual([
        "idx_platform_schema_migrations_environment_version",
        "uq_platform_schema_migrations_applied_version",
      ]);

      const { rows: platformDeduplicationIndexes } = await verifyClient.query<{
        indexname: string;
      }>(
        `SELECT indexname
         FROM pg_indexes
         WHERE schemaname = 'platform'
           AND indexname IN (
             'uq_platform_external_webhook_events_webhook_key_hash',
             'uq_platform_idempotency_keys_operation_scope_hash'
           )
         ORDER BY indexname`,
      );

      expect(platformDeduplicationIndexes.map((row) => row.indexname)).toEqual([
        "uq_platform_external_webhook_events_webhook_key_hash",
        "uq_platform_idempotency_keys_operation_scope_hash",
      ]);

      const { rows: platformAppendOnlyTriggers } = await verifyClient.query<{
        trigger_name: string;
        event_object_table: string;
      }>(
        `SELECT trigger_name, event_object_table
         FROM information_schema.triggers
         WHERE trigger_schema = 'platform'
           AND trigger_name IN (
             'trg_platform_domain_events_append_only',
             'trg_platform_external_webhook_events_append_only',
             'trg_platform_product_audit_events_append_only'
           )
         GROUP BY trigger_name, event_object_table
         ORDER BY trigger_name`,
      );

      expect(platformAppendOnlyTriggers).toEqual([
        {
          event_object_table: "domain_events",
          trigger_name: "trg_platform_domain_events_append_only",
        },
        {
          event_object_table: "external_webhook_events",
          trigger_name: "trg_platform_external_webhook_events_append_only",
        },
        {
          event_object_table: "product_audit_events",
          trigger_name: "trg_platform_product_audit_events_append_only",
        },
      ]);

      const { rows: platformIntegrityConstraints } = await verifyClient.query<{
        constraint_name: string;
      }>(
        `SELECT constraint_name
         FROM information_schema.table_constraints
         WHERE table_schema = 'platform'
           AND constraint_name IN (
             'chk_platform_dead_letter_events_acknowledged',
             'chk_platform_dead_letter_events_private',
             'chk_platform_dead_letter_events_requeue',
             'chk_platform_dead_letter_events_resolution',
             'chk_platform_dead_letter_events_scope',
             'chk_platform_dead_letter_events_source',
             'chk_platform_domain_events_private',
             'chk_platform_domain_events_scope',
             'chk_platform_domain_events_version',
             'chk_platform_external_webhook_events_dedupe_key',
             'chk_platform_external_webhook_events_private',
             'chk_platform_external_webhook_events_processing',
             'chk_platform_external_webhook_events_scope',
             'chk_platform_idempotency_keys_completion',
             'chk_platform_idempotency_keys_private',
             'chk_platform_idempotency_keys_response_resource',
             'chk_platform_idempotency_keys_scope',
             'chk_platform_job_attempts_private',
             'chk_platform_job_attempts_terminal_time',
             'chk_platform_job_attempts_time',
             'chk_platform_jobs_attempts',
             'chk_platform_jobs_private',
             'chk_platform_jobs_running_lock',
             'chk_platform_jobs_scope',
             'chk_platform_jobs_source_pair',
             'chk_platform_jobs_terminal_time',
             'chk_platform_media_objects_delete_state',
             'chk_platform_media_objects_public_active',
             'chk_platform_media_objects_purpose_visibility',
             'chk_platform_media_objects_source_pair',
             'chk_platform_media_objects_storage_reference',
             'chk_platform_media_upload_sessions_purpose_visibility',
             'chk_platform_media_upload_sessions_staging_prefix',
             'chk_platform_media_upload_sessions_terminal_time',
             'chk_platform_media_variants_public_url',
             'chk_platform_outbox_events_attempts',
             'chk_platform_outbox_events_lease_state',
             'chk_platform_outbox_events_private',
             'chk_platform_outbox_events_publish_state',
             'chk_platform_outbox_events_scope',
             'chk_platform_product_audit_events_private',
             'chk_platform_product_audit_events_scope',
             'fk_platform_dead_letter_events_domain_event',
             'fk_platform_dead_letter_events_domain_event_scope',
             'fk_platform_dead_letter_events_job',
             'fk_platform_dead_letter_events_job_attempt',
             'fk_platform_dead_letter_events_job_scope',
             'fk_platform_dead_letter_events_organization',
             'fk_platform_dead_letter_events_outbox_event',
             'fk_platform_dead_letter_events_outbox_event_scope',
             'fk_platform_dead_letter_events_property',
             'fk_platform_dead_letter_events_requeued_job',
             'fk_platform_dead_letter_events_requeued_job_scope',
             'fk_platform_dead_letter_events_webhook_event',
             'fk_platform_dead_letter_events_webhook_event_scope',
             'fk_platform_domain_events_actor',
             'fk_platform_domain_events_organization',
             'fk_platform_domain_events_property',
             'fk_platform_external_webhook_events_domain_event',
             'fk_platform_external_webhook_events_domain_event_property',
             'fk_platform_external_webhook_events_domain_event_scope',
             'fk_platform_external_webhook_events_organization',
             'fk_platform_external_webhook_events_property',
             'fk_platform_idempotency_keys_organization',
             'fk_platform_idempotency_keys_property',
             'fk_platform_job_attempts_job',
             'fk_platform_jobs_domain_event',
             'fk_platform_jobs_domain_event_scope',
             'fk_platform_jobs_organization',
             'fk_platform_jobs_outbox_domain_event',
             'fk_platform_jobs_outbox_event',
             'fk_platform_jobs_outbox_event_scope',
             'fk_platform_jobs_property',
             'fk_platform_media_objects_actor',
             'fk_platform_media_objects_owner_organization',
             'fk_platform_media_objects_property',
             'fk_platform_media_upload_sessions_actor',
             'fk_platform_media_upload_sessions_media_object',
             'fk_platform_media_upload_sessions_owner_organization',
             'fk_platform_media_upload_sessions_property',
             'fk_platform_media_variants_object_visibility',
             'fk_platform_outbox_events_domain_event',
             'fk_platform_outbox_events_domain_event_scope',
             'fk_platform_outbox_events_organization',
             'fk_platform_outbox_events_property',
             'fk_platform_product_audit_events_actor',
             'fk_platform_product_audit_events_domain_event',
             'fk_platform_product_audit_events_domain_event_scope',
             'fk_platform_product_audit_events_idempotency_key',
             'fk_platform_product_audit_events_idempotency_key_scope',
             'fk_platform_product_audit_events_job',
             'fk_platform_product_audit_events_job_scope',
             'fk_platform_product_audit_events_organization',
             'fk_platform_product_audit_events_property',
             'fk_platform_product_audit_events_webhook_event',
             'fk_platform_product_audit_events_webhook_event_scope',
             'uq_platform_domain_events_id_property',
             'uq_platform_domain_events_id_scope',
             'uq_platform_domain_events_source_event_key',
             'uq_platform_external_webhook_events_id_scope',
             'uq_platform_external_webhook_events_provider_event',
             'uq_platform_idempotency_keys_id_scope',
             'uq_platform_job_attempts_id_job',
             'uq_platform_job_attempts_job_number',
             'uq_platform_jobs_id_scope',
             'uq_platform_jobs_key',
             'uq_platform_media_objects_id_visibility',
             'uq_platform_media_objects_source',
             'uq_platform_media_variants_object_name',
             'uq_platform_outbox_events_id_domain_event',
             'uq_platform_outbox_events_id_scope',
             'uq_platform_outbox_events_key',
             'uq_platform_product_audit_events_key'
           )
         ORDER BY constraint_name`,
      );

      expect(platformIntegrityConstraints.map((row) => row.constraint_name)).toEqual([
        "chk_platform_dead_letter_events_acknowledged",
        "chk_platform_dead_letter_events_private",
        "chk_platform_dead_letter_events_requeue",
        "chk_platform_dead_letter_events_resolution",
        "chk_platform_dead_letter_events_scope",
        "chk_platform_dead_letter_events_source",
        "chk_platform_domain_events_private",
        "chk_platform_domain_events_scope",
        "chk_platform_domain_events_version",
        "chk_platform_external_webhook_events_dedupe_key",
        "chk_platform_external_webhook_events_private",
        "chk_platform_external_webhook_events_processing",
        "chk_platform_external_webhook_events_scope",
        "chk_platform_idempotency_keys_completion",
        "chk_platform_idempotency_keys_private",
        "chk_platform_idempotency_keys_response_resource",
        "chk_platform_idempotency_keys_scope",
        "chk_platform_job_attempts_private",
        "chk_platform_job_attempts_terminal_time",
        "chk_platform_job_attempts_time",
        "chk_platform_jobs_attempts",
        "chk_platform_jobs_private",
        "chk_platform_jobs_running_lock",
        "chk_platform_jobs_scope",
        "chk_platform_jobs_source_pair",
        "chk_platform_jobs_terminal_time",
        "chk_platform_media_objects_delete_state",
        "chk_platform_media_objects_public_active",
        "chk_platform_media_objects_purpose_visibility",
        "chk_platform_media_objects_source_pair",
        "chk_platform_media_objects_storage_reference",
        "chk_platform_media_upload_sessions_purpose_visibility",
        "chk_platform_media_upload_sessions_staging_prefix",
        "chk_platform_media_upload_sessions_terminal_time",
        "chk_platform_media_variants_public_url",
        "chk_platform_outbox_events_attempts",
        "chk_platform_outbox_events_lease_state",
        "chk_platform_outbox_events_private",
        "chk_platform_outbox_events_publish_state",
        "chk_platform_outbox_events_scope",
        "chk_platform_product_audit_events_private",
        "chk_platform_product_audit_events_scope",
        "fk_platform_dead_letter_events_domain_event",
        "fk_platform_dead_letter_events_domain_event_scope",
        "fk_platform_dead_letter_events_job",
        "fk_platform_dead_letter_events_job_attempt",
        "fk_platform_dead_letter_events_job_scope",
        "fk_platform_dead_letter_events_organization",
        "fk_platform_dead_letter_events_outbox_event",
        "fk_platform_dead_letter_events_outbox_event_scope",
        "fk_platform_dead_letter_events_property",
        "fk_platform_dead_letter_events_requeued_job",
        "fk_platform_dead_letter_events_requeued_job_scope",
        "fk_platform_dead_letter_events_webhook_event",
        "fk_platform_dead_letter_events_webhook_event_scope",
        "fk_platform_domain_events_actor",
        "fk_platform_domain_events_organization",
        "fk_platform_domain_events_property",
        "fk_platform_external_webhook_events_domain_event",
        "fk_platform_external_webhook_events_domain_event_property",
        "fk_platform_external_webhook_events_domain_event_scope",
        "fk_platform_external_webhook_events_organization",
        "fk_platform_external_webhook_events_property",
        "fk_platform_idempotency_keys_organization",
        "fk_platform_idempotency_keys_property",
        "fk_platform_job_attempts_job",
        "fk_platform_jobs_domain_event",
        "fk_platform_jobs_domain_event_scope",
        "fk_platform_jobs_organization",
        "fk_platform_jobs_outbox_domain_event",
        "fk_platform_jobs_outbox_event",
        "fk_platform_jobs_outbox_event_scope",
        "fk_platform_jobs_property",
        "fk_platform_media_objects_actor",
        "fk_platform_media_objects_owner_organization",
        "fk_platform_media_objects_property",
        "fk_platform_media_upload_sessions_actor",
        "fk_platform_media_upload_sessions_media_object",
        "fk_platform_media_upload_sessions_owner_organization",
        "fk_platform_media_upload_sessions_property",
        "fk_platform_media_variants_object_visibility",
        "fk_platform_outbox_events_domain_event",
        "fk_platform_outbox_events_domain_event_scope",
        "fk_platform_outbox_events_organization",
        "fk_platform_outbox_events_property",
        "fk_platform_product_audit_events_actor",
        "fk_platform_product_audit_events_domain_event",
        "fk_platform_product_audit_events_domain_event_scope",
        "fk_platform_product_audit_events_idempotency_key",
        "fk_platform_product_audit_events_idempotency_key_scope",
        "fk_platform_product_audit_events_job",
        "fk_platform_product_audit_events_job_scope",
        "fk_platform_product_audit_events_organization",
        "fk_platform_product_audit_events_property",
        "fk_platform_product_audit_events_webhook_event",
        "fk_platform_product_audit_events_webhook_event_scope",
        "uq_platform_domain_events_id_property",
        "uq_platform_domain_events_id_scope",
        "uq_platform_domain_events_source_event_key",
        "uq_platform_external_webhook_events_id_scope",
        "uq_platform_external_webhook_events_provider_event",
        "uq_platform_idempotency_keys_id_scope",
        "uq_platform_job_attempts_id_job",
        "uq_platform_job_attempts_job_number",
        "uq_platform_jobs_id_scope",
        "uq_platform_jobs_key",
        "uq_platform_media_objects_id_visibility",
        "uq_platform_media_objects_source",
        "uq_platform_media_variants_object_name",
        "uq_platform_outbox_events_id_domain_event",
        "uq_platform_outbox_events_id_scope",
        "uq_platform_outbox_events_key",
        "uq_platform_product_audit_events_key",
      ]);

      const { rows: platformForeignKeyShapes } = await verifyClient.query<{
        constraint_name: string;
        table_name: string;
        columns: string;
        referenced_schema: string;
        referenced_table: string;
        referenced_columns: string;
      }>(
        `SELECT
           con.conname AS constraint_name,
           src.relname AS table_name,
           array_to_string(ARRAY(
             SELECT att.attname
             FROM unnest(con.conkey) WITH ORDINALITY AS cols(attnum, ord)
             JOIN pg_attribute att
               ON att.attrelid = con.conrelid
              AND att.attnum = cols.attnum
             ORDER BY cols.ord
           ), ',') AS columns,
           ref_ns.nspname AS referenced_schema,
           ref.relname AS referenced_table,
           array_to_string(ARRAY(
             SELECT att.attname
             FROM unnest(con.confkey) WITH ORDINALITY AS cols(attnum, ord)
             JOIN pg_attribute att
               ON att.attrelid = con.confrelid
              AND att.attnum = cols.attnum
             ORDER BY cols.ord
           ), ',') AS referenced_columns
         FROM pg_constraint con
         JOIN pg_class src ON src.oid = con.conrelid
         JOIN pg_namespace src_ns ON src_ns.oid = src.relnamespace
         JOIN pg_class ref ON ref.oid = con.confrelid
         JOIN pg_namespace ref_ns ON ref_ns.oid = ref.relnamespace
         WHERE src_ns.nspname = 'platform'
           AND con.contype = 'f'
           AND con.conname IN (
             'fk_platform_dead_letter_events_domain_event_scope',
             'fk_platform_dead_letter_events_job_attempt',
             'fk_platform_dead_letter_events_job_scope',
             'fk_platform_dead_letter_events_outbox_event_scope',
             'fk_platform_dead_letter_events_requeued_job_scope',
             'fk_platform_dead_letter_events_webhook_event_scope',
             'fk_platform_external_webhook_events_domain_event_property',
             'fk_platform_external_webhook_events_domain_event_scope',
             'fk_platform_jobs_domain_event_scope',
             'fk_platform_jobs_outbox_domain_event',
             'fk_platform_jobs_outbox_event_scope',
             'fk_platform_media_objects_actor',
             'fk_platform_media_objects_owner_organization',
             'fk_platform_media_objects_property',
             'fk_platform_media_upload_sessions_actor',
             'fk_platform_media_upload_sessions_media_object',
             'fk_platform_media_upload_sessions_owner_organization',
             'fk_platform_media_upload_sessions_property',
             'fk_platform_media_variants_object_visibility',
             'fk_platform_outbox_events_domain_event_scope',
             'fk_platform_product_audit_events_domain_event_scope',
             'fk_platform_product_audit_events_idempotency_key',
             'fk_platform_product_audit_events_idempotency_key_scope',
             'fk_platform_product_audit_events_job_scope',
             'fk_platform_product_audit_events_webhook_event',
             'fk_platform_product_audit_events_webhook_event_scope'
           )
         ORDER BY con.conname`,
      );

      expect(platformForeignKeyShapes).toEqual([
        {
          columns: "domain_event_id,scope_key",
          constraint_name: "fk_platform_dead_letter_events_domain_event_scope",
          referenced_columns: "id,scope_key",
          referenced_schema: "platform",
          referenced_table: "domain_events",
          table_name: "dead_letter_events",
        },
        {
          columns: "job_attempt_id,job_id",
          constraint_name: "fk_platform_dead_letter_events_job_attempt",
          referenced_columns: "id,job_id",
          referenced_schema: "platform",
          referenced_table: "job_attempts",
          table_name: "dead_letter_events",
        },
        {
          columns: "job_id,scope_key",
          constraint_name: "fk_platform_dead_letter_events_job_scope",
          referenced_columns: "id,scope_key",
          referenced_schema: "platform",
          referenced_table: "jobs",
          table_name: "dead_letter_events",
        },
        {
          columns: "outbox_event_id,scope_key",
          constraint_name: "fk_platform_dead_letter_events_outbox_event_scope",
          referenced_columns: "id,scope_key",
          referenced_schema: "platform",
          referenced_table: "outbox_events",
          table_name: "dead_letter_events",
        },
        {
          columns: "requeued_job_id,scope_key",
          constraint_name: "fk_platform_dead_letter_events_requeued_job_scope",
          referenced_columns: "id,scope_key",
          referenced_schema: "platform",
          referenced_table: "jobs",
          table_name: "dead_letter_events",
        },
        {
          columns: "webhook_event_id,scope_key",
          constraint_name: "fk_platform_dead_letter_events_webhook_event_scope",
          referenced_columns: "id,scope_key",
          referenced_schema: "platform",
          referenced_table: "external_webhook_events",
          table_name: "dead_letter_events",
        },
        {
          columns: "normalized_domain_event_id,property_id",
          constraint_name: "fk_platform_external_webhook_events_domain_event_property",
          referenced_columns: "id,property_id",
          referenced_schema: "platform",
          referenced_table: "domain_events",
          table_name: "external_webhook_events",
        },
        {
          columns: "normalized_domain_event_id,scope_key",
          constraint_name: "fk_platform_external_webhook_events_domain_event_scope",
          referenced_columns: "id,scope_key",
          referenced_schema: "platform",
          referenced_table: "domain_events",
          table_name: "external_webhook_events",
        },
        {
          columns: "source_domain_event_id,scope_key",
          constraint_name: "fk_platform_jobs_domain_event_scope",
          referenced_columns: "id,scope_key",
          referenced_schema: "platform",
          referenced_table: "domain_events",
          table_name: "jobs",
        },
        {
          columns: "source_outbox_event_id,source_domain_event_id",
          constraint_name: "fk_platform_jobs_outbox_domain_event",
          referenced_columns: "id,domain_event_id",
          referenced_schema: "platform",
          referenced_table: "outbox_events",
          table_name: "jobs",
        },
        {
          columns: "source_outbox_event_id,scope_key",
          constraint_name: "fk_platform_jobs_outbox_event_scope",
          referenced_columns: "id,scope_key",
          referenced_schema: "platform",
          referenced_table: "outbox_events",
          table_name: "jobs",
        },
        {
          columns: "created_by_user_id",
          constraint_name: "fk_platform_media_objects_actor",
          referenced_columns: "id",
          referenced_schema: "identity",
          referenced_table: "users",
          table_name: "media_objects",
        },
        {
          columns: "owner_organization_id",
          constraint_name: "fk_platform_media_objects_owner_organization",
          referenced_columns: "id",
          referenced_schema: "identity",
          referenced_table: "organizations",
          table_name: "media_objects",
        },
        {
          columns: "property_id",
          constraint_name: "fk_platform_media_objects_property",
          referenced_columns: "id",
          referenced_schema: "hotel_catalog",
          referenced_table: "properties",
          table_name: "media_objects",
        },
        {
          columns: "actor_user_id",
          constraint_name: "fk_platform_media_upload_sessions_actor",
          referenced_columns: "id",
          referenced_schema: "identity",
          referenced_table: "users",
          table_name: "media_upload_sessions",
        },
        {
          columns: "completed_media_object_id",
          constraint_name: "fk_platform_media_upload_sessions_media_object",
          referenced_columns: "id",
          referenced_schema: "platform",
          referenced_table: "media_objects",
          table_name: "media_upload_sessions",
        },
        {
          columns: "owner_organization_id",
          constraint_name: "fk_platform_media_upload_sessions_owner_organization",
          referenced_columns: "id",
          referenced_schema: "identity",
          referenced_table: "organizations",
          table_name: "media_upload_sessions",
        },
        {
          columns: "property_id",
          constraint_name: "fk_platform_media_upload_sessions_property",
          referenced_columns: "id",
          referenced_schema: "hotel_catalog",
          referenced_table: "properties",
          table_name: "media_upload_sessions",
        },
        {
          columns: "media_object_id,visibility",
          constraint_name: "fk_platform_media_variants_object_visibility",
          referenced_columns: "id,visibility",
          referenced_schema: "platform",
          referenced_table: "media_objects",
          table_name: "media_variants",
        },
        {
          columns: "domain_event_id,scope_key",
          constraint_name: "fk_platform_outbox_events_domain_event_scope",
          referenced_columns: "id,scope_key",
          referenced_schema: "platform",
          referenced_table: "domain_events",
          table_name: "outbox_events",
        },
        {
          columns: "domain_event_id,scope_key",
          constraint_name: "fk_platform_product_audit_events_domain_event_scope",
          referenced_columns: "id,scope_key",
          referenced_schema: "platform",
          referenced_table: "domain_events",
          table_name: "product_audit_events",
        },
        {
          columns: "idempotency_key_id",
          constraint_name: "fk_platform_product_audit_events_idempotency_key",
          referenced_columns: "id",
          referenced_schema: "platform",
          referenced_table: "idempotency_keys",
          table_name: "product_audit_events",
        },
        {
          columns: "idempotency_key_id,scope_key",
          constraint_name: "fk_platform_product_audit_events_idempotency_key_scope",
          referenced_columns: "id,scope_key",
          referenced_schema: "platform",
          referenced_table: "idempotency_keys",
          table_name: "product_audit_events",
        },
        {
          columns: "job_id,scope_key",
          constraint_name: "fk_platform_product_audit_events_job_scope",
          referenced_columns: "id,scope_key",
          referenced_schema: "platform",
          referenced_table: "jobs",
          table_name: "product_audit_events",
        },
        {
          columns: "external_webhook_event_id",
          constraint_name: "fk_platform_product_audit_events_webhook_event",
          referenced_columns: "id",
          referenced_schema: "platform",
          referenced_table: "external_webhook_events",
          table_name: "product_audit_events",
        },
        {
          columns: "external_webhook_event_id,scope_key",
          constraint_name: "fk_platform_product_audit_events_webhook_event_scope",
          referenced_columns: "id,scope_key",
          referenced_schema: "platform",
          referenced_table: "external_webhook_events",
          table_name: "product_audit_events",
        },
      ]);

      const { rows: platformForeignKeySchemas } = await verifyClient.query<{
        constraint_name: string;
        referenced_schema: string;
      }>(
        `SELECT DISTINCT
           tc.constraint_name,
           ccu.table_schema AS referenced_schema
         FROM information_schema.table_constraints tc
         JOIN information_schema.constraint_column_usage ccu
           ON ccu.constraint_schema = tc.constraint_schema
          AND ccu.constraint_name = tc.constraint_name
         WHERE tc.table_schema = 'platform'
           AND tc.constraint_type = 'FOREIGN KEY'
           AND ccu.table_schema NOT IN ('hotel_catalog', 'identity', 'platform')
         ORDER BY tc.constraint_name`,
      );

      expect(platformForeignKeySchemas).toHaveLength(0);

      const { rows: platformAiDefaults } = await verifyClient.query<{
        table_name: string;
        default_expr: string;
      }>(
        `SELECT rel.relname AS table_name, pg_get_expr(def.adbin, def.adrelid) AS default_expr
         FROM pg_namespace ns
         JOIN pg_class rel ON rel.relnamespace = ns.oid
         JOIN pg_attribute att ON att.attrelid = rel.oid
         JOIN pg_attrdef def
           ON def.adrelid = rel.oid
          AND def.adnum = att.attnum
         WHERE ns.nspname = 'platform'
           AND rel.relname IN (
             'domain_events', 'external_webhook_events', 'outbox_events',
             'jobs', 'job_attempts', 'idempotency_keys',
             'dead_letter_events', 'product_audit_events'
           )
           AND att.attname = 'ai_visible'
         ORDER BY rel.relname`,
      );

      expect(platformAiDefaults).toEqual([
        { table_name: "dead_letter_events", default_expr: "false" },
        { table_name: "domain_events", default_expr: "false" },
        { table_name: "external_webhook_events", default_expr: "false" },
        { table_name: "idempotency_keys", default_expr: "false" },
        { table_name: "job_attempts", default_expr: "false" },
        { table_name: "jobs", default_expr: "false" },
        { table_name: "outbox_events", default_expr: "false" },
        { table_name: "product_audit_events", default_expr: "false" },
      ]);

      const { rows: platformRawSecretColumns } = await verifyClient.query<{
        table_name: string;
        column_name: string;
      }>(
        `SELECT table_name, column_name
         FROM information_schema.columns
         WHERE table_schema = 'platform'
           AND column_name IN (
             'api_key', 'secret', 'client_secret', 'raw_secret',
             'token', 'access_token', 'idempotency_key', 'webhook_secret'
           )`,
      );

      expect(platformRawSecretColumns).toHaveLength(0);

      const { rows: platformScopedColumns } = await verifyClient.query<{
        table_name: string;
        column_name: string;
      }>(
        `SELECT table_name, column_name
         FROM information_schema.columns
         WHERE table_schema = 'platform'
           AND (
             (table_name = 'domain_events' AND column_name IN (
               'event_status', 'tenant_scope', 'scope_key', 'correlation_id',
               'idempotency_key_hash'
             ))
             OR
             (table_name = 'outbox_events' AND column_name IN (
               'tenant_scope', 'scope_key', 'resource_product',
               'resource_type', 'resource_id', 'correlation_id',
               'idempotency_key_hash'
             ))
             OR
             (table_name = 'dead_letter_events' AND column_name IN (
               'tenant_scope', 'scope_key', 'resource_product',
               'resource_type', 'resource_id', 'correlation_id',
               'idempotency_key_hash', 'recovery_status'
             ))
             OR
             (table_name = 'product_audit_events' AND column_name IN (
               'tenant_scope', 'scope_key', 'correlation_id'
             ))
           )
         ORDER BY table_name, column_name`,
      );

      expect(platformScopedColumns).toEqual([
        { table_name: "dead_letter_events", column_name: "correlation_id" },
        { table_name: "dead_letter_events", column_name: "idempotency_key_hash" },
        { table_name: "dead_letter_events", column_name: "recovery_status" },
        { table_name: "dead_letter_events", column_name: "resource_id" },
        { table_name: "dead_letter_events", column_name: "resource_product" },
        { table_name: "dead_letter_events", column_name: "resource_type" },
        { table_name: "dead_letter_events", column_name: "scope_key" },
        { table_name: "dead_letter_events", column_name: "tenant_scope" },
        { table_name: "domain_events", column_name: "correlation_id" },
        { table_name: "domain_events", column_name: "event_status" },
        { table_name: "domain_events", column_name: "idempotency_key_hash" },
        { table_name: "domain_events", column_name: "scope_key" },
        { table_name: "domain_events", column_name: "tenant_scope" },
        { table_name: "outbox_events", column_name: "correlation_id" },
        { table_name: "outbox_events", column_name: "idempotency_key_hash" },
        { table_name: "outbox_events", column_name: "resource_id" },
        { table_name: "outbox_events", column_name: "resource_product" },
        { table_name: "outbox_events", column_name: "resource_type" },
        { table_name: "outbox_events", column_name: "scope_key" },
        { table_name: "outbox_events", column_name: "tenant_scope" },
        { table_name: "product_audit_events", column_name: "correlation_id" },
        { table_name: "product_audit_events", column_name: "scope_key" },
        { table_name: "product_audit_events", column_name: "tenant_scope" },
      ]);

      const platformDomainEventId = "bbbbbbbb-1111-4111-8111-bbbbbbbbbbb1";
      const platformOtherDomainEventId = "bbbbbbbb-1111-4111-8111-bbbbbbbbbbb2";
      const platformWebhookEventId = "bbbbbbbb-2222-4222-8222-bbbbbbbbbbb1";
      const platformOutboxEventId = "bbbbbbbb-3333-4333-8333-bbbbbbbbbbb1";
      const platformJobId = "bbbbbbbb-4444-4444-8444-bbbbbbbbbbb1";
      const platformOtherJobId = "bbbbbbbb-4444-4444-8444-bbbbbbbbbbb2";
      const platformJobAttemptId = "bbbbbbbb-5555-4555-8555-bbbbbbbbbbb1";
      const platformOtherJobAttemptId = "bbbbbbbb-5555-4555-8555-bbbbbbbbbbb2";
      const platformIdempotencyKeyId = "bbbbbbbb-6666-4666-8666-bbbbbbbbbbb1";
      const platformOtherIdempotencyKeyId = "bbbbbbbb-6666-4666-8666-bbbbbbbbbbb2";
      const platformOtherPropertyId = "bbbbbbbb-7777-4777-8777-bbbbbbbbbbb1";

      await verifyClient.query(
        `INSERT INTO hotel_catalog.properties (id, public_id, display_name)
         VALUES ($1, 'platform-other-property', 'Platform Other Property')`,
        [platformOtherPropertyId],
      );
      await verifyClient.query(
        `INSERT INTO platform.domain_events
           (
             id, source_system, event_key, event_type, event_version,
             occurred_at, tenant_scope, property_id,
             resource_product, resource_type, resource_id, actor_type,
             actor_user_id, correlation_id, idempotency_key_hash,
             payload, event_metadata, privacy_scope
           )
         VALUES (
           $1, 'booking', 'booking.created.platform-test',
           'booking.guest_booking.created', 1, now(), 'property',
           $2, 'booking', 'guest_booking', $3, 'user',
           $4, 'corr-platform-test', 'sha256:platform-idempotency',
           '{"bookingStatus":"confirmed"}'::jsonb,
           '{"source":"target-schema-smoke"}'::jsonb,
           'confidential'
         )`,
        [platformDomainEventId, distributionPropertyId, distributionQuoteSessionId, hotelUserId],
      );
      await verifyClient.query(
        `INSERT INTO platform.domain_events
           (
             id, source_system, event_key, event_type, occurred_at,
             tenant_scope, property_id, resource_product, resource_type,
             resource_id, actor_type, privacy_scope
           )
         VALUES (
           $1, 'booking', 'booking.updated.platform-test',
           'booking.guest_booking.updated', now(), 'property',
           $2, 'booking', 'guest_booking', $3, 'system', 'confidential'
         )`,
        [platformOtherDomainEventId, distributionPropertyId, distributionQuoteSessionId],
      );
      await expect(
        verifyClient.query(
          `INSERT INTO platform.domain_events
             (
               source_system, event_key, event_type, occurred_at,
               tenant_scope, property_id, resource_product,
               resource_type, resource_id
             )
           VALUES (
             'booking', 'booking.created.platform-test',
             'booking.guest_booking.created', now(), 'property',
             $1, 'booking', 'guest_booking', $2
           )`,
          [distributionPropertyId, distributionQuoteSessionId],
        ),
      ).rejects.toMatchObject({ code: "23505" });
      await expect(
        verifyClient.query(
          `INSERT INTO platform.domain_events
             (
               source_system, event_key, event_type, occurred_at,
               tenant_scope, property_id, resource_product,
               resource_type, resource_id, ai_visible
             )
           VALUES (
             'booking', 'booking.private-ai.platform-test',
             'booking.guest_booking.created', now(), 'property',
             $1, 'booking', 'guest_booking', $2, TRUE
           )`,
          [distributionPropertyId, distributionQuoteSessionId],
        ),
      ).rejects.toMatchObject({ code: "23514" });
      await expect(
        verifyClient.query(
          `INSERT INTO platform.domain_events
             (
               source_system, event_key, event_type, occurred_at,
               tenant_scope, organization_id, property_id, resource_product,
               resource_type, resource_id
             )
           VALUES (
             'booking', 'booking.invalid-scope.platform-test',
             'booking.guest_booking.created', now(), 'property',
             $1, $2, 'booking', 'guest_booking', $3
           )`,
          [hotelOrganizationId, distributionPropertyId, distributionQuoteSessionId],
        ),
      ).rejects.toMatchObject({ code: "23514" });

      await verifyClient.query(
        `INSERT INTO platform.external_webhook_events
           (
             id, provider, provider_event_id, webhook_key_hash,
             event_type, delivery_status, signature_verified,
             tenant_scope, property_id, normalized_domain_event_id,
             correlation_id, payload_hash, raw_headers, raw_payload,
             privacy_scope
           )
         VALUES (
           $1, 'channex', 'channex-platform-event-1',
           'sha256:webhook-key', 'booking.updated', 'normalized',
           TRUE, 'property', $2, $3, 'corr-platform-test', 'sha256:payload',
           '{"xSignature":"redacted"}'::jsonb,
           '{"bookingId":"external-booking-1","status":"modified"}'::jsonb,
           'restricted'
        )`,
        [platformWebhookEventId, distributionPropertyId, platformDomainEventId],
      );
      await expect(
        verifyClient.query(
          `UPDATE platform.external_webhook_events
           SET raw_payload = '{"bookingId":"tampered"}'::jsonb
           WHERE id = $1`,
          [platformWebhookEventId],
        ),
      ).rejects.toMatchObject({ code: "55000" });
      await expect(
        verifyClient.query(
          `INSERT INTO platform.external_webhook_events
             (
               provider, provider_event_id, webhook_key_hash, event_type,
               delivery_status, payload_hash, raw_payload
             )
           VALUES (
             'channex', 'channex-platform-event-1', 'sha256:webhook-key-duplicate',
             'booking.updated', 'received', 'sha256:payload-duplicate', '{}'::jsonb
           )`,
        ),
      ).rejects.toMatchObject({ code: "23505" });
      await verifyClient.query(
        `INSERT INTO platform.external_webhook_events
           (
             provider, webhook_key_hash, event_type, delivery_status,
             payload_hash, raw_payload
           )
         VALUES (
           'stripe', 'sha256:webhook-delivery-key',
           'payment.updated', 'received',
           'sha256:stripe-payload', '{}'::jsonb
         )`,
      );
      await expect(
        verifyClient.query(
          `INSERT INTO platform.external_webhook_events
             (
               provider, webhook_key_hash, event_type, delivery_status,
               payload_hash, raw_payload
             )
           VALUES (
             'stripe', 'sha256:webhook-delivery-key',
             'payment.updated', 'received',
             'sha256:stripe-payload-duplicate', '{}'::jsonb
           )`,
        ),
      ).rejects.toMatchObject({ code: "23505" });
      await expect(
        verifyClient.query(
          `INSERT INTO platform.external_webhook_events
             (
               provider, provider_event_id, webhook_key_hash, event_type,
               delivery_status, tenant_scope, property_id,
               normalized_domain_event_id, payload_hash, raw_payload
             )
           VALUES (
             'channex', 'channex-platform-event-mismatch',
             'sha256:webhook-key-mismatch', 'booking.updated',
             'normalized', 'property', $1, $2,
             'sha256:mismatch', '{}'::jsonb
           )`,
          [platformOtherPropertyId, platformDomainEventId],
        ),
      ).rejects.toMatchObject({ code: "23503" });
      await expect(
        verifyClient.query(
          `INSERT INTO platform.external_webhook_events
             (provider, event_type, delivery_status, payload_hash, raw_payload)
           VALUES ('stripe', 'payment.updated', 'received', 'sha256:no-key', '{}'::jsonb)`,
        ),
      ).rejects.toMatchObject({ code: "23514" });
      await expect(
        verifyClient.query(
          `INSERT INTO platform.external_webhook_events
             (
               provider, provider_event_id, event_type, delivery_status,
               tenant_scope, organization_id, payload_hash, raw_payload
             )
           VALUES (
             'stripe', 'stripe-invalid-scope-platform-test',
             'payment.updated', 'received', 'external', $1,
             'sha256:invalid-scope', '{}'::jsonb
           )`,
          [hotelOrganizationId],
        ),
      ).rejects.toMatchObject({ code: "23514" });
      await expect(
        verifyClient.query(
          `INSERT INTO platform.external_webhook_events
             (
               provider, provider_event_id, event_type, delivery_status,
               payload_hash, raw_payload
             )
           VALUES (
             'channex', 'channex-normalized-no-domain',
             'booking.updated', 'normalized', 'sha256:no-domain', '{}'::jsonb
           )`,
        ),
      ).rejects.toMatchObject({ code: "23514" });

      await verifyClient.query(
        `INSERT INTO platform.outbox_events
           (
             id, domain_event_id, outbox_key, destination, event_type,
             tenant_scope, property_id, resource_product,
             resource_type, resource_id, status, correlation_id,
             idempotency_key_hash, payload
           )
         VALUES (
           $1, $2, 'booking-confirmation-email-platform-test',
           'email', 'booking.confirmation.email', 'property',
           $3, 'booking', 'guest_booking', $4, 'pending',
           'corr-platform-test', 'sha256:platform-idempotency',
           '{"template":"booking-confirmed"}'::jsonb
         )`,
        [
          platformOutboxEventId,
          platformDomainEventId,
          distributionPropertyId,
          distributionQuoteSessionId,
        ],
      );
      await expect(
        verifyClient.query(
          `INSERT INTO platform.outbox_events
             (
               domain_event_id, outbox_key, destination, event_type,
               tenant_scope, property_id, resource_product,
               resource_type, resource_id, status
             )
           VALUES (
             $1, 'booking-confirmation-email-platform-test',
             'email', 'booking.confirmation.email', 'property',
             $2, 'booking', 'guest_booking', $3, 'pending'
           )`,
          [platformDomainEventId, distributionPropertyId, distributionQuoteSessionId],
        ),
      ).rejects.toMatchObject({ code: "23505" });
      await expect(
        verifyClient.query(
          `INSERT INTO platform.outbox_events
             (
               domain_event_id, outbox_key, destination, event_type,
               tenant_scope, property_id, resource_product,
               resource_type, resource_id, status
             )
           VALUES (
             $1, 'published-without-time', 'email', 'booking.email',
             'property', $2, 'booking', 'guest_booking', $3, 'published'
           )`,
          [platformDomainEventId, distributionPropertyId, distributionQuoteSessionId],
        ),
      ).rejects.toMatchObject({ code: "23514" });
      await expect(
        verifyClient.query(
          `INSERT INTO platform.outbox_events
             (
               domain_event_id, outbox_key, destination, event_type,
               tenant_scope, property_id, resource_product,
               resource_type, resource_id, status
             )
           VALUES (
             $1, 'leased-without-time', 'email', 'booking.email',
             'property', $2, 'booking', 'guest_booking', $3, 'leased'
           )`,
          [platformDomainEventId, distributionPropertyId, distributionQuoteSessionId],
        ),
      ).rejects.toMatchObject({ code: "23514" });

      await verifyClient.query(
        `INSERT INTO platform.jobs
           (
             id, job_key, queue_name, job_type, source_domain_event_id,
             source_outbox_event_id, status, attempts_count, locked_at,
             locked_by, tenant_scope, property_id,
             resource_product, resource_type, resource_id,
             correlation_id, idempotency_key_hash, payload
           )
         VALUES (
           $1, 'send-booking-confirmation-platform-test',
           'email', 'send_booking_confirmation', $2, $3,
           'running', 1, now(), 'worker-1', 'property',
           $4, 'booking', 'guest_booking', $5,
           'corr-platform-test', 'sha256:platform-idempotency',
           '{"template":"booking-confirmed"}'::jsonb
         )`,
        [
          platformJobId,
          platformDomainEventId,
          platformOutboxEventId,
          distributionPropertyId,
          distributionQuoteSessionId,
        ],
      );
      await verifyClient.query(
        `INSERT INTO platform.jobs
           (
             id, job_key, queue_name, job_type, status, finished_at,
             tenant_scope, resource_product, resource_type, resource_id
           )
         VALUES (
           $1, 'other-job-platform-test', 'email',
           'send_booking_confirmation', 'succeeded', now(),
           'platform', 'platform', 'platform_job', 'other-job'
         )`,
        [platformOtherJobId],
      );
      await expect(
        verifyClient.query(
          `INSERT INTO platform.jobs
             (
               job_key, queue_name, job_type, source_domain_event_id,
               source_outbox_event_id, tenant_scope, resource_product,
               property_id, resource_type, resource_id
             )
           VALUES (
             'mismatched-outbox-domain-platform-test', 'email',
             'send_booking_confirmation', $1, $2, 'property',
             'booking', $3, 'guest_booking', $4
           )`,
          [
            platformOtherDomainEventId,
            platformOutboxEventId,
            distributionPropertyId,
            distributionQuoteSessionId,
          ],
        ),
      ).rejects.toMatchObject({ code: "23503" });
      await expect(
        verifyClient.query(
          `INSERT INTO platform.jobs
             (
               job_key, queue_name, job_type, source_outbox_event_id,
               tenant_scope, property_id, resource_product,
               resource_type, resource_id
             )
           VALUES (
             'outbox-without-domain-platform-test', 'email',
             'send_booking_confirmation', $1, 'property',
             $2, 'booking', 'guest_booking', $3
           )`,
          [platformOutboxEventId, distributionPropertyId, distributionQuoteSessionId],
        ),
      ).rejects.toMatchObject({ code: "23514" });
      await expect(
        verifyClient.query(
          `INSERT INTO platform.jobs
             (job_key, queue_name, job_type, status)
           VALUES ('running-without-lock-platform-test', 'email', 'send_booking_confirmation', 'running')`,
        ),
      ).rejects.toMatchObject({ code: "23514" });
      await expect(
        verifyClient.query(
          `INSERT INTO platform.jobs
             (job_key, queue_name, job_type, status, locked_at)
           VALUES (
             'running-without-worker-platform-test', 'email',
             'send_booking_confirmation', 'running', now()
           )`,
        ),
      ).rejects.toMatchObject({ code: "23514" });

      await verifyClient.query(
        `INSERT INTO platform.job_attempts
           (
             id, job_id, attempt_number, status, worker_id,
             finished_at, duration_ms, error_type, error_message
           )
         VALUES (
           $1, $2, 1, 'failed', 'worker-1', now(), 25,
           'ProviderTimeout', 'Email provider timed out'
         )`,
        [platformJobAttemptId, platformJobId],
      );
      await verifyClient.query(
        `INSERT INTO platform.job_attempts
           (id, job_id, attempt_number, status, worker_id, finished_at, duration_ms)
         VALUES ($1, $2, 1, 'succeeded', 'worker-1', now(), 10)`,
        [platformOtherJobAttemptId, platformOtherJobId],
      );
      await expect(
        verifyClient.query(
          `INSERT INTO platform.job_attempts
             (job_id, attempt_number, status, finished_at)
           VALUES ($1, 1, 'failed', now())`,
          [platformJobId],
        ),
      ).rejects.toMatchObject({ code: "23505" });
      await expect(
        verifyClient.query(
          `INSERT INTO platform.job_attempts
             (job_id, attempt_number, status)
           VALUES ($1, 2, 'succeeded')`,
          [platformJobId],
        ),
      ).rejects.toMatchObject({ code: "23514" });

      await verifyClient.query(
        `INSERT INTO platform.idempotency_keys
           (
             id, operation_scope, operation, key_hash,
             request_fingerprint_hash, status, tenant_scope,
             property_id, response_status_code,
             response_body_hash, response_resource_product,
             response_resource_type, response_resource_id,
             correlation_id, completed_at, expires_at
           )
         VALUES (
           $1, 'booking', 'create_guest_booking',
           'sha256:platform-idempotency',
           'sha256:platform-request-fingerprint',
           'completed', 'property', $2, 201,
           'sha256:response-body', 'booking',
           'guest_booking', $3, 'corr-platform-test',
           now(), now() + INTERVAL '1 day'
         )`,
        [platformIdempotencyKeyId, distributionPropertyId, distributionQuoteSessionId],
      );
      await verifyClient.query(
        `INSERT INTO platform.idempotency_keys
           (
             id, operation_scope, operation, key_hash,
             request_fingerprint_hash, tenant_scope, property_id,
             expires_at
           )
         VALUES (
           $1, 'booking', 'create_guest_booking',
           'sha256:platform-idempotency',
           'sha256:other-property-request', 'property', $2,
           now() + INTERVAL '1 day'
         )`,
        [platformOtherIdempotencyKeyId, platformOtherPropertyId],
      );
      await expect(
        verifyClient.query(
          `INSERT INTO platform.idempotency_keys
             (
               operation_scope, operation, key_hash,
               request_fingerprint_hash, tenant_scope, property_id,
               expires_at
             )
           VALUES (
             'booking', 'create_guest_booking',
             'sha256:platform-idempotency',
             'sha256:other-request', 'property', $1,
             now() + INTERVAL '1 day'
           )`,
          [distributionPropertyId],
        ),
      ).rejects.toMatchObject({ code: "23505" });
      await expect(
        verifyClient.query(
          `INSERT INTO platform.idempotency_keys
             (
               operation_scope, operation, key_hash,
               request_fingerprint_hash, status, expires_at
             )
           VALUES (
             'booking', 'create_guest_booking',
             'sha256:completed-without-time',
             'sha256:request', 'completed', now() + INTERVAL '1 day'
           )`,
        ),
      ).rejects.toMatchObject({ code: "23514" });
      await expect(
        verifyClient.query(
          `INSERT INTO platform.idempotency_keys
             (
               operation_scope, operation, key_hash,
               request_fingerprint_hash, status, completed_at,
               expires_at
             )
           VALUES (
             'booking', 'create_guest_booking',
             'sha256:completed-without-response',
             'sha256:request', 'completed', now(),
             now() + INTERVAL '1 day'
           )`,
        ),
      ).rejects.toMatchObject({ code: "23514" });
      await expect(
        verifyClient.query(
          `INSERT INTO platform.idempotency_keys
             (
               operation_scope, operation, key_hash,
               request_fingerprint_hash, response_resource_product,
               expires_at
             )
           VALUES (
             'booking', 'create_guest_booking',
             'sha256:partial-response-resource',
             'sha256:request', 'booking', now() + INTERVAL '1 day'
           )`,
        ),
      ).rejects.toMatchObject({ code: "23514" });

      await verifyClient.query(
        `INSERT INTO platform.dead_letter_events
           (
             source_kind, job_id, job_attempt_id, reason_code,
             tenant_scope, property_id, resource_product,
             resource_type, resource_id, correlation_id,
             idempotency_key_hash, failure_summary, failure_payload
           )
         VALUES (
             'job', $1, $2, 'provider_timeout', 'property',
             $3, 'booking', 'guest_booking', $4,
             'corr-platform-test', 'sha256:platform-idempotency',
             'Email provider timed out after retry budget.',
             '{"attempt":1}'::jsonb
           )`,
        [platformJobId, platformJobAttemptId, distributionPropertyId, distributionQuoteSessionId],
      );
      await expect(
        verifyClient.query(
          `INSERT INTO platform.dead_letter_events
             (
               source_kind, job_id, job_attempt_id, reason_code,
               tenant_scope, property_id, resource_product,
               resource_type, resource_id, failure_summary
             )
           VALUES (
             'job', $1, $2, 'mismatched_attempt', 'property',
             $3, 'booking', 'guest_booking', $4,
             'Attempt belongs to another job'
           )`,
          [
            platformJobId,
            platformOtherJobAttemptId,
            distributionPropertyId,
            distributionQuoteSessionId,
          ],
        ),
      ).rejects.toMatchObject({ code: "23503" });
      await expect(
        verifyClient.query(
          `INSERT INTO platform.dead_letter_events
             (
               source_kind, job_id, reason_code, failure_summary,
               tenant_scope, property_id, resource_product,
               resource_type, resource_id, recovery_status
             )
           VALUES (
             'job', $1, 'resolved_without_time',
             'Missing resolution timestamp', 'property',
             $2, 'booking', 'guest_booking', $3, 'resolved'
           )`,
          [platformJobId, distributionPropertyId, distributionQuoteSessionId],
        ),
      ).rejects.toMatchObject({ code: "23514" });
      await expect(
        verifyClient.query(
          `INSERT INTO platform.dead_letter_events
             (
               source_kind, job_id, reason_code, failure_summary,
               tenant_scope, property_id, resource_product,
               resource_type, resource_id, recovery_status
             )
           VALUES (
             'job', $1, 'acknowledged_without_time',
             'Missing acknowledgement timestamp', 'property',
             $2, 'booking', 'guest_booking', $3, 'acknowledged'
           )`,
          [platformJobId, distributionPropertyId, distributionQuoteSessionId],
        ),
      ).rejects.toMatchObject({ code: "23514" });
      await expect(
        verifyClient.query(
          `INSERT INTO platform.dead_letter_events
             (
               source_kind, job_id, reason_code, failure_summary,
               tenant_scope, property_id, resource_product,
               resource_type, resource_id, recovery_status
             )
           VALUES (
             'job', $1, 'requeued_without_job',
             'Missing requeued job reference', 'property',
             $2, 'booking', 'guest_booking', $3, 'requeued'
           )`,
          [platformJobId, distributionPropertyId, distributionQuoteSessionId],
        ),
      ).rejects.toMatchObject({ code: "23514" });

      await verifyClient.query(
        `INSERT INTO platform.product_audit_events
           (
             audit_key, product, action, occurred_at, tenant_scope,
             property_id, actor_type, actor_user_id,
             target_resource_product, target_resource_type,
             target_resource_id, domain_event_id,
             external_webhook_event_id, job_id, idempotency_key_id,
             correlation_id, redacted_payload, private_payload,
             retention_class, privacy_scope
           )
         VALUES (
             'booking-confirmed-platform-test', 'booking',
             'booking.confirmed', now(), 'property', $1,
             'user', $2, 'booking', 'guest_booking', $3,
             $4, $5, $6, $7, 'corr-platform-test',
             '{"status":"confirmed"}'::jsonb,
             '{"guestEmail":"private@example.com"}'::jsonb,
             'guest_pii', 'restricted'
           )`,
        [
          distributionPropertyId,
          hotelUserId,
          distributionQuoteSessionId,
          platformDomainEventId,
          platformWebhookEventId,
          platformJobId,
          platformIdempotencyKeyId,
        ],
      );
      await expect(
        verifyClient.query(
          `UPDATE platform.domain_events
           SET event_status = 'projected'
           WHERE id = $1`,
          [platformDomainEventId],
        ),
      ).rejects.toMatchObject({ code: "55000" });
      await expect(
        verifyClient.query(
          `INSERT INTO platform.product_audit_events
             (
               audit_key, product, action, occurred_at, tenant_scope,
               property_id, target_resource_product, target_resource_type,
               target_resource_id, domain_event_id
             )
           VALUES (
             'scope-mismatch-platform-test', 'booking',
             'booking.confirmed', now(), 'property', $1,
             'booking', 'guest_booking', $2, $3
           )`,
          [platformOtherPropertyId, distributionQuoteSessionId, platformDomainEventId],
        ),
      ).rejects.toMatchObject({ code: "23503" });
      await expect(
        verifyClient.query(
          `INSERT INTO platform.product_audit_events
             (
               audit_key, product, action, occurred_at, tenant_scope,
               property_id, target_resource_product, target_resource_type,
               target_resource_id
             )
           VALUES (
             'booking-confirmed-platform-test', 'booking',
             'booking.confirmed', now(), 'property', $1,
             'booking', 'guest_booking', $2
           )`,
          [distributionPropertyId, distributionQuoteSessionId],
        ),
      ).rejects.toMatchObject({ code: "23505" });
      await expect(
        verifyClient.query(
          `INSERT INTO platform.product_audit_events
             (
               audit_key, product, action, occurred_at, tenant_scope,
               property_id, target_resource_product, target_resource_type,
               target_resource_id, ai_visible
             )
           VALUES (
             'ai-visible-platform-test', 'booking',
             'booking.confirmed', now(), 'property', $1,
             'booking', 'guest_booking', $2, TRUE
           )`,
          [distributionPropertyId, distributionQuoteSessionId],
        ),
      ).rejects.toMatchObject({ code: "23514" });
      await expect(
        verifyClient.query(
          `DELETE FROM platform.product_audit_events
           WHERE product = 'booking'
             AND audit_key = 'booking-confirmed-platform-test'`,
        ),
      ).rejects.toMatchObject({ code: "55000" });

      const platformMediaObjectId = "bbbbbbbb-8888-4888-8888-bbbbbbbbbbb1";
      const platformPrivateMediaObjectId = "bbbbbbbb-8888-4888-8888-bbbbbbbbbbb2";
      const platformUploadSessionId = "bbbbbbbb-9999-4999-8999-bbbbbbbbbbb1";

      await expect(
        verifyClient.query(
          `SELECT platform.valid_media_purpose_visibility(
             'identity.user.profile_image', 'public'
           ) AS allowed`,
        ),
      ).resolves.toMatchObject({ rows: [{ allowed: true }] });
      await expect(
        verifyClient.query(
          `SELECT
             platform.valid_media_purpose_visibility(
               'booking.header_logo', 'public'
             ) AS public_allowed,
             platform.valid_media_purpose_visibility(
               'booking.header_logo', 'private'
             ) AS private_allowed`,
        ),
      ).resolves.toMatchObject({
        rows: [{ public_allowed: true, private_allowed: false }],
      });

      await verifyClient.query(
        `INSERT INTO platform.media_objects
           (
             id, bucket, storage_key, visibility, purpose,
             owner_organization_id, property_id, resource_product,
             resource_type, resource_id, lifecycle_status,
             content_type, size_bytes, checksum_sha256,
             width_px, height_px, original_filename,
             source_url, source_system, source_table, source_row_id,
             public_approved, created_by_user_id
           )
         VALUES (
             $1, 'vayada-media-local',
             'public/properties/platform-media-test/original_safe.webp',
             'public', 'property.hero_image', $2, $3,
             'hotel_catalog', 'property_media', 'hero',
             'active', 'image/webp', 1024,
             'sha256:platform-media-public', 1200, 800,
             'hero.jpg',
             'https://legacy-public-bucket.s3.amazonaws.com/property/hero.jpg',
             'booking', 'booking_hotels', 'hero-image',
             TRUE, $4
           )`,
        [platformMediaObjectId, hotelOrganizationId, distributionPropertyId, hotelUserId],
      );
      await verifyClient.query(
        `INSERT INTO platform.media_variants
           (
             media_object_id, variant_name, visibility, storage_key,
             content_type, width_px, height_px, size_bytes, public_cdn_url
           )
         VALUES (
             $1, 'original_safe', 'public',
             'public/properties/platform-media-test/original_safe.webp',
             'image/webp', 1200, 800, 1024,
             'https://media.localhost/public/properties/platform-media-test/original_safe.webp'
           )`,
        [platformMediaObjectId],
      );
      await expect(
        verifyClient.query(
          `INSERT INTO platform.media_objects
             (
               bucket, storage_key, visibility, purpose,
               resource_product, resource_type, lifecycle_status,
               content_type, public_approved
             )
           VALUES (
               'vayada-media-local',
               'private/marketplace/collaborations/collab-1/image.gif',
               'public', 'marketplace.collaboration_chat.attachment',
               'marketplace', 'collaboration_chat', 'active',
               'image/gif', TRUE
           )`,
        ),
      ).rejects.toMatchObject({ code: "23514" });
      await expect(
        verifyClient.query(
          `INSERT INTO platform.media_objects
             (
               storage_kind, visibility, purpose, resource_product,
               resource_type, lifecycle_status, public_approved
             )
           VALUES (
               'external_reference', 'private', 'marketplace.creator.profile_image',
               'marketplace', 'creator_profile', 'external_reference', FALSE
           )`,
        ),
      ).rejects.toMatchObject({ code: "23514" });

      await verifyClient.query(
        `INSERT INTO platform.media_objects
           (
             id, bucket, storage_key, visibility, purpose,
             owner_organization_id, property_id, resource_product,
             resource_type, resource_id, lifecycle_status,
             content_type, size_bytes, checksum_sha256,
             original_filename, source_url, source_system,
             source_table, source_row_id, public_approved,
             created_by_user_id
           )
         VALUES (
             $1, 'vayada-media-local',
             'private/pms/properties/platform-media-test/messages/thread-1/invoice.pdf',
             'private', 'pms.messaging.attachment', $2, $3,
             'pms', 'message_attachment', 'attachment-1',
             'active', 'application/pdf', 2048,
             'sha256:platform-media-private', 'invoice.pdf',
             'https://legacy-private-bucket.s3.amazonaws.com/messages/thread-1/invoice.pdf',
             'pms', 'message_attachments', 'attachment-1',
             FALSE, $4
           )`,
        [platformPrivateMediaObjectId, hotelOrganizationId, distributionPropertyId, hotelUserId],
      );
      await expect(
        verifyClient.query(
          `INSERT INTO platform.media_variants
             (
               media_object_id, variant_name, visibility, storage_key,
               content_type, size_bytes, public_cdn_url
             )
           VALUES (
               $1, 'provider_original', 'private',
               'private/pms/properties/platform-media-test/messages/thread-1/invoice.pdf',
               'application/pdf', 2048,
               'https://media.localhost/private/should-not-be-public.pdf'
           )`,
          [platformPrivateMediaObjectId],
        ),
      ).rejects.toMatchObject({ code: "23514" });
      await expect(
        verifyClient.query(
          `INSERT INTO platform.media_upload_sessions
             (
               upload_session_key, requested_purpose, requested_visibility,
               resource_product, resource_type, staging_prefix,
               expires_at, session_status, completed_at
             )
           VALUES (
               'completed-without-object-platform-media-test',
               'property.hero_image', 'public', 'hotel_catalog',
               'property_media', 'staging/platform-media-test/0/hero.jpg',
               now() + INTERVAL '1 hour', 'completed', now()
           )`,
        ),
      ).rejects.toMatchObject({ code: "23514" });
      await verifyClient.query(
        `INSERT INTO platform.media_upload_sessions
           (
             id, upload_session_key, requested_purpose, requested_visibility,
             actor_user_id, owner_organization_id, property_id,
             resource_product, resource_type, resource_id,
             expected_content_type, expected_size_bytes, expected_file_count,
             staging_prefix, expires_at, session_status,
             completed_media_object_id, completed_at
           )
         VALUES (
             $1, 'upload-session-platform-media-test',
             'property.hero_image', 'public', $2, $3, $4,
             'hotel_catalog', 'property_media', 'hero',
             'image/jpeg', 1024, 1,
             'staging/platform-media-test/0/hero.jpg',
             now() + INTERVAL '1 hour', 'completed',
             $5, now()
           )`,
        [
          platformUploadSessionId,
          hotelUserId,
          hotelOrganizationId,
          distributionPropertyId,
          platformMediaObjectId,
        ],
      );

      const { rows: retiredIntelligenceSchemas } = await verifyClient.query<{
        schema_name: string;
      }>(
        `SELECT schema_name
         FROM information_schema.schemata
         WHERE schema_name = 'intelligence'`,
      );

      expect(retiredIntelligenceSchemas).toHaveLength(0);

      const { rows: retiredIntelligencePermissions } = await verifyClient.query<{ key: string }>(
        `SELECT key
         FROM identity.permission_catalog
         WHERE key IN ('finance.summary.read', 'intelligence.ask.read')
         ORDER BY key`,
      );

      expect(retiredIntelligencePermissions).toHaveLength(0);

      const { rows: retiredIntelligenceGrants } = await verifyClient.query<{
        permission_key: string;
      }>(
        `SELECT permission_key
         FROM identity.role_permission_grants
         WHERE permission_key IN ('finance.summary.read', 'intelligence.ask.read')
         ORDER BY permission_key`,
      );

      expect(retiredIntelligenceGrants).toHaveLength(0);

      const { rows: retiredIntelligenceResourceLinkConstraints } = await verifyClient.query<{
        constraint_name: string;
      }>(
        `SELECT con.conname AS constraint_name
           FROM pg_constraint con
           JOIN pg_class rel ON rel.oid = con.conrelid
           JOIN pg_namespace ns ON ns.oid = rel.relnamespace
           WHERE ns.nspname = 'identity'
             AND rel.relname = 'organization_resource_links'
             AND con.conname IN (
               'uq_identity_resource_links_id_organization',
               'uq_identity_resource_links_id_organization_resource'
             )`,
      );

      expect(retiredIntelligenceResourceLinkConstraints).toHaveLength(0);

      const linkedRoomTypeIds = [
        "aaaaaaaa-3333-4333-8333-aaaaaaaaaaa2",
        "aaaaaaaa-3333-4333-8333-aaaaaaaaaaa3",
      ];
      const manualBlockId = "aaaaaaaa-5555-4555-8555-aaaaaaaaaaa1";
      const linkedBlockId = "aaaaaaaa-5555-4555-8555-aaaaaaaaaaa2";
      await verifyClient.query(
        `INSERT INTO pms.room_types (id, property_id, name, base_rate_amount, currency)
         VALUES ($1, $3, 'Linked Twin', 200, 'USD'),
                ($2, $3, 'Linked Single', 200, 'USD')`,
        [...linkedRoomTypeIds, distributionPropertyId],
      );
      await verifyClient.query(
        `INSERT INTO pms.room_blocks
           (id, property_id, room_type_id, starts_on, ends_on, reason)
         VALUES ($1, $2, $3, DATE '2026-03-01', DATE '2026-03-02', 'Maintenance')`,
        [manualBlockId, distributionPropertyId, distributionRoomTypeId],
      );
      await verifyClient.query(
        `INSERT INTO pms.room_blocks
           (id, property_id, room_type_id, starts_on, ends_on, reason, block_kind,
            source_room_type_id, source_room_block_id)
         VALUES ($1, $2, $3, DATE '2026-03-01', DATE '2026-03-02', 'Linked',
                 'linked_manual_block', $4, $5)`,
        [
          linkedBlockId,
          distributionPropertyId,
          linkedRoomTypeIds[0],
          distributionRoomTypeId,
          manualBlockId,
        ],
      );
      await expect(
        verifyClient.query(
          `UPDATE pms.room_blocks SET block_kind = 'linked_booking' WHERE id = $1`,
          [manualBlockId],
        ),
      ).rejects.toMatchObject({ code: "23514", constraint: "chk_pms_room_blocks_kind_immutable" });
      await expect(
        verifyClient.query(
          `INSERT INTO pms.room_blocks
             (property_id, room_type_id, starts_on, ends_on, block_kind,
              source_room_type_id, source_room_block_id)
           VALUES ($1, $2, DATE '2026-03-01', DATE '2026-03-02',
                   'linked_manual_block', $2, $3)`,
          [distributionPropertyId, linkedRoomTypeIds[1], manualBlockId],
        ),
      ).rejects.toMatchObject({ code: "23514" });
      await expect(
        verifyClient.query(
          `INSERT INTO pms.room_blocks
             (property_id, room_type_id, starts_on, ends_on, block_kind,
              source_room_type_id, source_room_block_id)
           VALUES ($1, $2, DATE '2026-03-01', DATE '2026-03-02',
                   'linked_manual_block', $3, $4)`,
          [distributionPropertyId, linkedRoomTypeIds[1], linkedRoomTypeIds[0], linkedBlockId],
        ),
      ).rejects.toMatchObject({ code: "23514" });
      await expect(
        verifyClient.query(`DELETE FROM pms.room_blocks WHERE id = $1`, [manualBlockId]),
      ).rejects.toMatchObject({ code: "23503" });

      const linkedAssignmentId = "aaaaaaaa-6666-4666-8666-aaaaaaaaaaa1";
      await expect(
        verifyClient.query(
          `UPDATE pms.inventory_days
           SET linked_stop_sell=TRUE, linked_source_revision=99, available_count=0
           WHERE property_id=$1 AND room_type_id=$2 AND stay_date=DATE '2026-03-01'`,
          [distributionPropertyId, distributionRoomTypeId],
        ),
      ).rejects.toMatchObject({
        code: "23514",
        constraint: "chk_pms_inventory_days_linked_requires_canonical",
      });
      await verifyClient.query(
        `INSERT INTO booking.guest_bookings
           (id, property_id, public_reference, lifecycle_status, check_in, check_out, currency)
         VALUES ('aaaaaaaa-7777-4777-8777-aaaaaaaaaaa1', $1,
                 'linked-assignment-causality', 'confirmed',
                 DATE '2026-03-03', DATE '2026-03-04', 'USD')`,
        [distributionPropertyId],
      );
      await verifyClient.query("SET session_replication_role = replica");
      await verifyClient.query(
        `INSERT INTO pms.operational_booking_assignments
           (id, property_id, guest_booking_id, room_type_id)
         VALUES ($1, $2, 'aaaaaaaa-7777-4777-8777-aaaaaaaaaaa1', $3)`,
        [linkedAssignmentId, distributionPropertyId, distributionRoomTypeId],
      );
      await verifyClient.query(
        `INSERT INTO pms.inventory_days
           (property_id, room_type_id, stay_date, total_count, available_count,
            assigned_count, blocked_count, status, source_freshness, calendar_revision,
            inventory_revision, generated_sellable_limit_count,
            effective_sellable_limit_count, generated_source_revision,
            channel_source_revision, manual_source_revision, block_source_revision,
            booking_source_revision, linked_stop_sell, linked_source_revision)
         VALUES ($1, $2, DATE '2026-03-03', 5, 5, 0, 0, 'open', '{}'::jsonb,
                 1, 1, 5, 5, 1, 0, 0, 0, 0, FALSE, 0)`,
        [distributionPropertyId, distributionRoomTypeId],
      );
      await verifyClient.query("SET session_replication_role = origin");
      await expect(
        verifyClient.query(
          `INSERT INTO pms.room_blocks
             (property_id, room_type_id, starts_on, ends_on, block_kind,
              source_room_type_id, source_assignment_id)
           VALUES ($1, $2, DATE '2026-03-03', DATE '2026-03-03',
                   'linked_booking', $3, $4)`,
          [distributionPropertyId, linkedRoomTypeIds[0], linkedRoomTypeIds[1], linkedAssignmentId],
        ),
      ).rejects.toMatchObject({
        code: "23514",
        constraint: "chk_pms_room_blocks_linked_assignment_source",
      });
      const movableLinkedBlockId = "aaaaaaaa-5555-4555-8555-aaaaaaaaaaa3";
      await verifyClient.query(
        `INSERT INTO pms.room_blocks
           (id, property_id, room_type_id, starts_on, ends_on, block_kind,
            source_room_type_id, source_assignment_id)
         VALUES ($1, $2, $3, DATE '2026-03-03', DATE '2026-03-03',
                 'linked_booking', $4, $5)`,
        [
          movableLinkedBlockId,
          distributionPropertyId,
          linkedRoomTypeIds[0],
          distributionRoomTypeId,
          linkedAssignmentId,
        ],
      );
      await verifyClient.query("BEGIN");
      await verifyClient.query(
        `UPDATE pms.operational_booking_assignments SET room_type_id=$2 WHERE id=$1`,
        [linkedAssignmentId, linkedRoomTypeIds[1]],
      );
      await expect(verifyClient.query("COMMIT")).rejects.toMatchObject({
        code: "23514",
        constraint: "chk_pms_assignment_linked_blocks_current",
      });
      await verifyClient.query("ROLLBACK");
      await verifyClient.query("BEGIN");
      await verifyClient.query(
        `UPDATE pms.operational_booking_assignments SET room_type_id=$2 WHERE id=$1`,
        [linkedAssignmentId, linkedRoomTypeIds[1]],
      );
      await verifyClient.query(
        `UPDATE pms.operational_booking_assignments SET room_type_id=$2 WHERE id=$1`,
        [linkedAssignmentId, distributionRoomTypeId],
      );
      await verifyClient.query("COMMIT");
      await verifyClient.query("BEGIN");
      await verifyClient.query(
        `UPDATE pms.operational_booking_assignments SET room_type_id=$2 WHERE id=$1`,
        [linkedAssignmentId, linkedRoomTypeIds[1]],
      );
      await verifyClient.query(
        `UPDATE pms.room_blocks SET status='released', released_at=now() WHERE id=$1`,
        [movableLinkedBlockId],
      );
      await verifyClient.query("COMMIT");
      await expect(
        verifyClient.query(
          `UPDATE pms.room_blocks SET status='active', released_at=NULL WHERE id=$1`,
          [movableLinkedBlockId],
        ),
      ).rejects.toMatchObject({
        code: "23514",
        constraint: "chk_pms_room_blocks_linked_assignment_source",
      });
      const concurrentClient = new pg.Client({ connectionString: TEST_DATABASE_URL });
      await concurrentClient.connect();
      try {
        await verifyClient.query("BEGIN");
        await verifyClient.query(
          `INSERT INTO pms.room_blocks
             (id, property_id, room_type_id, starts_on, ends_on, block_kind,
              source_room_type_id, source_assignment_id)
           VALUES ('aaaaaaaa-5555-4555-8555-aaaaaaaaaaa4', $1, $2,
                   DATE '2026-03-03', DATE '2026-03-03', 'linked_booking', $3, $4)`,
          [
            distributionPropertyId,
            distributionRoomTypeId,
            linkedRoomTypeIds[1],
            linkedAssignmentId,
          ],
        );
        await concurrentClient.query("BEGIN");
        await concurrentClient.query("SET LOCAL lock_timeout = '250ms'");
        await expect(
          concurrentClient.query(
            `UPDATE pms.operational_booking_assignments SET room_type_id=$2 WHERE id=$1`,
            [linkedAssignmentId, distributionRoomTypeId],
          ),
        ).rejects.toMatchObject({ code: "55P03" });
        await concurrentClient.query("ROLLBACK");
        await verifyClient.query("COMMIT");
      } finally {
        await concurrentClient.end();
      }
      await verifyClient.query(
        `UPDATE pms.inventory_days
         SET linked_stop_sell=TRUE, linked_source_revision=1,
             inventory_revision=2, available_count=0
         WHERE property_id=$1 AND room_type_id=$2 AND stay_date=DATE '2026-03-03'`,
        [distributionPropertyId, distributionRoomTypeId],
      );
      const { rows: linkedStopped } = await verifyClient.query<{ available_count: number }>(
        `SELECT available_count FROM pms.inventory_days
         WHERE property_id=$1 AND room_type_id=$2 AND stay_date=DATE '2026-03-03'`,
        [distributionPropertyId, distributionRoomTypeId],
      );
      expect(linkedStopped).toEqual([{ available_count: 0 }]);
      await expect(
        verifyClient.query(
          `UPDATE pms.inventory_days SET linked_stop_sell=FALSE,
             inventory_revision=3, available_count=5
           WHERE property_id=$1 AND room_type_id=$2 AND stay_date=DATE '2026-03-03'`,
          [distributionPropertyId, distributionRoomTypeId],
        ),
      ).rejects.toMatchObject({
        code: "23514",
        constraint: "chk_pms_inventory_days_linked_transition",
      });
      await expect(
        verifyClient.query(
          `UPDATE pms.inventory_days SET linked_stop_sell=FALSE, linked_source_revision=2,
             assigned_count=1, booking_source_revision=1, inventory_revision=3, available_count=4
           WHERE property_id=$1 AND room_type_id=$2 AND stay_date=DATE '2026-03-03'`,
          [distributionPropertyId, distributionRoomTypeId],
        ),
      ).rejects.toMatchObject({
        code: "23514",
        constraint: "chk_pms_inventory_days_owner_revision_transition",
      });
      await verifyClient.query(
        `UPDATE pms.inventory_days SET linked_stop_sell=FALSE, linked_source_revision=2,
           blocked_count=1, block_source_revision=1, inventory_revision=3, available_count=4
         WHERE property_id=$1 AND room_type_id=$2 AND stay_date=DATE '2026-03-03'`,
        [distributionPropertyId, distributionRoomTypeId],
      );
      await expect(
        verifyClient.query(
          `UPDATE pms.inventory_days SET linked_stop_sell=TRUE, linked_source_revision=3,
             inventory_revision=4, available_count=1
           WHERE property_id=$1 AND room_type_id=$2 AND stay_date=DATE '2026-03-03'`,
          [distributionPropertyId, distributionRoomTypeId],
        ),
      ).rejects.toMatchObject({
        code: "23514",
        constraint: "chk_pms_inventory_days_canonical_availability",
      });
    } finally {
      await verifyClient.end();
    }
  }, 60_000);
});
