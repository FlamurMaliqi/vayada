import { createHash } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  PRODUCTION_PMS_SOURCE_TABLES,
  readProductionPmsSnapshot,
} from "./productionPmsSnapshotReader.js";
import { assertSafeTestDatabase } from "./testUtils.js";

const URL = process.env["TEST_DATABASE_URL"];
const RUN = "vay1351-111111111111111111111111";

describe.skipIf(!URL)("production PMS snapshot reader (PostgreSQL)", () => {
  let client: pg.Client;

  beforeAll(async () => {
    assertSafeTestDatabase(URL!);
    client = new pg.Client({ connectionString: URL });
    await client.connect();
  });
  afterAll(async () => client.end());

  it("reads the immutable extraction ledger using the migrated schema", async () => {
    await client.query("BEGIN");
    try {
      const emptyChecksum = createHash("sha256").digest("hex");
      await client.query(
        `INSERT INTO platform.source_extraction_runs
           (run_id, environment, source_schema_revision, status, started_at, finished_at,
            duration_ms)
         VALUES ($1, 'local', $2, 'completed', $3, $3, 0)`,
        [RUN, "1".repeat(40), "2026-08-30T01:02:03Z"],
      );
      await client.query(
        `INSERT INTO platform.source_extraction_sources
           (run_id, source_database, snapshot_identifier, expected_database_name,
            expected_schema_fingerprint, actual_schema_fingerprint, status, row_count,
            checksum_sha256, source_snapshot_at, started_at, finished_at, duration_ms)
         VALUES ($1, 'pms', 'snapshot-pms', 'pms', $2, $2, 'completed', 0, $3,
                 $4, $4, $4, 0)`,
        [RUN, "2".repeat(32), emptyChecksum, "2026-08-30T01:02:03Z"],
      );
      await client.query(
        `INSERT INTO platform.source_extraction_tables
           (run_id, source_database, source_schema, source_table, status, row_count,
            checksum_sha256, started_at, finished_at, duration_ms)
         SELECT $1, 'pms', 'public', source_table, 'completed', 0, $3, $4, $4, 0
         FROM unnest($2::text[]) source_table`,
        [RUN, PRODUCTION_PMS_SOURCE_TABLES, emptyChecksum, "2026-08-30T01:02:03Z"],
      );

      const snapshot = await readProductionPmsSnapshot(client, RUN, {
        validateRun: async () => [],
      });
      expect(snapshot).toEqual({
        rows: [],
        snapshotAt: "2026-08-30T01:02:03.000Z",
        completedAt: "2026-08-30T01:02:03.000Z",
      });
    } finally {
      await client.query("ROLLBACK");
    }
  });
});
