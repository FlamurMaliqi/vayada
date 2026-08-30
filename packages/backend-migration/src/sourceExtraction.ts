import { createHash } from "node:crypto";
import type pg from "pg";

import { ADVISORY_LOCK_ID } from "./runner.js";
import {
  buildSourceRowCountQueries,
  SOURCE_DATABASES,
  SOURCE_READ_ONLY_TRANSACTION_SQL,
  SOURCE_SCHEMA_FINGERPRINT_SQL,
  type SourceDatabase,
  type SourceInventoryEntry,
} from "./sourceInventory.js";

export const VAY_1350_INVENTORY_REVISION = "2d7fe21080646cb1931aac4054a5648bac9b8227";
export const SOURCE_EXTRACTION_BATCH_SIZE = 500;
export const SOURCE_EXTRACTION_LOCK_ID = ADVISORY_LOCK_ID;

export const SOURCE_WRITABLE_PRIVILEGES_SQL = `
WITH RECURSIVE role_memberships(role_oid) AS (
  SELECT role.oid
  FROM pg_catalog.pg_roles role
  WHERE role.rolname = current_user
  UNION
  SELECT membership.roleid
  FROM pg_catalog.pg_auth_members membership
  JOIN role_memberships inherited ON inherited.role_oid = membership.member
)
SELECT (
  role.rolsuper OR role.rolcreatedb OR role.rolcreaterole
  OR role.rolreplication OR role.rolbypassrls
  OR EXISTS (
    SELECT 1
    FROM role_memberships membership
    WHERE membership.role_oid <> role.oid
  )
  OR pg_catalog.has_database_privilege(current_user, current_database(), 'CREATE')
  OR EXISTS (
    SELECT 1
    FROM pg_catalog.pg_namespace namespace
    WHERE namespace.nspname NOT IN ('information_schema', 'pg_catalog')
      AND namespace.nspname !~ '^pg_toast'
      AND pg_catalog.has_schema_privilege(current_user, namespace.oid, 'CREATE')
  )
  OR EXISTS (
    SELECT 1
    FROM pg_catalog.pg_class relation
    JOIN pg_catalog.pg_namespace namespace ON namespace.oid = relation.relnamespace
    WHERE relation.relkind IN ('r', 'p', 'v', 'm', 'f')
      AND namespace.nspname NOT IN ('information_schema', 'pg_catalog')
      AND namespace.nspname !~ '^pg_toast'
      AND (
        pg_catalog.has_table_privilege(current_user, relation.oid, 'INSERT')
        OR pg_catalog.has_table_privilege(current_user, relation.oid, 'UPDATE')
        OR pg_catalog.has_table_privilege(current_user, relation.oid, 'DELETE')
        OR pg_catalog.has_table_privilege(current_user, relation.oid, 'TRUNCATE')
        OR pg_catalog.has_any_column_privilege(current_user, relation.oid, 'INSERT')
        OR pg_catalog.has_any_column_privilege(current_user, relation.oid, 'UPDATE')
      )
  )
  OR EXISTS (
    SELECT 1
    FROM pg_catalog.pg_class relation
    JOIN pg_catalog.pg_namespace namespace ON namespace.oid = relation.relnamespace
    WHERE relation.relkind = 'S'
      AND namespace.nspname NOT IN ('information_schema', 'pg_catalog')
      AND namespace.nspname !~ '^pg_toast'
      AND (
        pg_catalog.has_sequence_privilege(current_user, relation.oid, 'USAGE')
        OR pg_catalog.has_sequence_privilege(current_user, relation.oid, 'UPDATE')
      )
  )
  OR EXISTS (
    SELECT 1
    FROM pg_catalog.pg_proc routine
    JOIN pg_catalog.pg_namespace namespace ON namespace.oid = routine.pronamespace
    WHERE routine.prosecdef
      AND namespace.nspname NOT IN ('information_schema', 'pg_catalog')
      AND namespace.nspname !~ '^pg_toast'
      AND pg_catalog.has_function_privilege(current_user, routine.oid, 'EXECUTE')
  )
) AS is_writable
FROM pg_catalog.pg_roles role
WHERE role.rolname = current_user`;

export const SOURCE_PROVENANCE_SQL = `
WITH database_settings AS (
  SELECT unnest(settings.setconfig) AS setting
  FROM pg_catalog.pg_db_role_setting settings
  WHERE settings.setdatabase = (
    SELECT database.oid
    FROM pg_catalog.pg_database database
    WHERE database.datname = current_database()
  )
    AND settings.setrole = 0
)
SELECT current_database() AS source_database,
       max(substring(setting FROM length('vayada.source_snapshot_identifier=') + 1))
         FILTER (WHERE setting LIKE 'vayada.source_snapshot_identifier=%') AS snapshot_identifier,
       max(substring(setting FROM length('vayada.cutover_freeze_proof_sha256=') + 1))
         FILTER (WHERE setting LIKE 'vayada.cutover_freeze_proof_sha256=%') AS cutover_freeze_proof_sha256
FROM database_settings`;

type ExtractionEnvironment = "local" | "staging" | "preprod";
type QueryClient = Pick<pg.ClientBase, "query">;

export type SourceExtractionManifest = {
  version: 1;
  environment: ExtractionEnvironment;
  sourceSchemaRevision: string;
  cutoverFreezeProofSha256?: string;
  sources: Record<
    SourceDatabase,
    {
      snapshotIdentifier: string;
      expectedDatabaseName: string;
      expectedSchemaFingerprint: string;
    }
  >;
};

export type SourceExtractionConfig = {
  manifest: SourceExtractionManifest;
  sourceSchemaRevision: string;
  snapshotIdentifiers: Record<SourceDatabase, string>;
  cutoverFreezeProofSha256?: string;
  inventory: readonly SourceInventoryEntry[];
  now?: () => number;
};

export type SourceExtractionReport = {
  runId: string;
  environment: ExtractionEnvironment;
  sourceSchemaRevision: string;
  status: "completed";
  durationMs: number;
  sources: Array<{
    sourceDatabase: SourceDatabase;
    snapshotIdentifier: string;
    schemaFingerprint: string;
    rowCount: number;
    checksumSha256: string;
    durationMs: number;
  }>;
};

export class SourceExtractionError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "SourceExtractionError";
  }
}

function requireRecord(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new SourceExtractionError("INVALID_MANIFEST", `${field} must be an object`);
  }
  return value as Record<string, unknown>;
}

function requireString(value: unknown, field: string, pattern?: RegExp): string {
  if (typeof value !== "string" || value.length === 0 || (pattern && !pattern.test(value))) {
    throw new SourceExtractionError("INVALID_MANIFEST", `${field} is invalid`);
  }
  return value;
}

export function parseSourceExtractionManifest(value: unknown): SourceExtractionManifest {
  const root = requireRecord(value, "manifest");
  if (root["version"] !== 1) {
    throw new SourceExtractionError("INVALID_MANIFEST", "manifest.version must be 1");
  }
  const environment = requireString(root["environment"], "manifest.environment");
  if (!["local", "staging", "preprod"].includes(environment)) {
    throw new SourceExtractionError("INVALID_MANIFEST", "manifest.environment is invalid");
  }
  const rawSources = requireRecord(root["sources"], "manifest.sources");
  if (Object.keys(rawSources).sort().join(",") !== [...SOURCE_DATABASES].sort().join(",")) {
    throw new SourceExtractionError(
      "INVALID_MANIFEST",
      "manifest.sources must contain exactly auth, booking, marketplace, and pms",
    );
  }

  const sources = {} as SourceExtractionManifest["sources"];
  for (const sourceDatabase of SOURCE_DATABASES) {
    const source = requireRecord(rawSources[sourceDatabase], `manifest.sources.${sourceDatabase}`);
    sources[sourceDatabase] = {
      snapshotIdentifier: requireString(
        source["snapshotIdentifier"],
        `manifest.sources.${sourceDatabase}.snapshotIdentifier`,
      ),
      expectedDatabaseName: requireString(
        source["expectedDatabaseName"],
        `manifest.sources.${sourceDatabase}.expectedDatabaseName`,
        /^[a-zA-Z_][a-zA-Z0-9_-]*$/,
      ),
      expectedSchemaFingerprint: requireString(
        source["expectedSchemaFingerprint"],
        `manifest.sources.${sourceDatabase}.expectedSchemaFingerprint`,
        /^[0-9a-f]{32}$/,
      ),
    };
  }

  const proof = root["cutoverFreezeProofSha256"];
  return {
    version: 1,
    environment: environment as ExtractionEnvironment,
    sourceSchemaRevision: requireString(
      root["sourceSchemaRevision"],
      "manifest.sourceSchemaRevision",
      /^[0-9a-f]{40}$/,
    ),
    ...(proof === undefined
      ? {}
      : {
          cutoverFreezeProofSha256: requireString(
            proof,
            "manifest.cutoverFreezeProofSha256",
            /^[0-9a-f]{64}$/,
          ),
        }),
    sources,
  };
}

function isImmutableSnapshot(identifier: string, environment: ExtractionEnvironment): boolean {
  if (environment === "local" && /^fixture:[a-z0-9][a-z0-9-]*$/.test(identifier)) return true;
  return /^arn:(?:aws|aws-cn|aws-us-gov):rds:[a-z0-9-]+:\d{12}:(?:cluster-)?snapshot:[A-Za-z0-9_.:-]+$/.test(
    identifier,
  );
}

export function validateSourceExtractionConfig(config: SourceExtractionConfig): void {
  if (
    config.sourceSchemaRevision !== VAY_1350_INVENTORY_REVISION ||
    config.manifest.sourceSchemaRevision !== config.sourceSchemaRevision
  ) {
    throw new SourceExtractionError(
      "SOURCE_REVISION_MISMATCH",
      "source schema revision does not match the reviewed VAY-1350 inventory",
    );
  }
  if (config.cutoverFreezeProofSha256 !== config.manifest.cutoverFreezeProofSha256) {
    throw new SourceExtractionError(
      "FREEZE_PROOF_MISMATCH",
      "cutover freeze proof does not match the reviewed manifest",
    );
  }

  for (const sourceDatabase of SOURCE_DATABASES) {
    const requested = config.snapshotIdentifiers[sourceDatabase];
    const approved = config.manifest.sources[sourceDatabase].snapshotIdentifier;
    if (!requested || requested !== approved) {
      throw new SourceExtractionError(
        "SOURCE_TAG_MISMATCH",
        `${sourceDatabase} snapshot identifier does not match the reviewed manifest`,
      );
    }
    if (!isImmutableSnapshot(approved, config.manifest.environment)) {
      if (!config.cutoverFreezeProofSha256) {
        throw new SourceExtractionError(
          "MUTABLE_SOURCE_REJECTED",
          `${sourceDatabase} source is mutable and has no approved freeze proof`,
        );
      }
    }
  }
}

export function buildSourceExtractionPlan(config: SourceExtractionConfig) {
  validateSourceExtractionConfig(config);
  return {
    runId: computeRunId(config.manifest),
    environment: config.manifest.environment,
    sourceSchemaRevision: config.sourceSchemaRevision,
    sources: SOURCE_DATABASES.map((sourceDatabase) => ({
      sourceDatabase,
      snapshotIdentifier: config.snapshotIdentifiers[sourceDatabase],
      expectedDatabaseName: config.manifest.sources[sourceDatabase].expectedDatabaseName,
      expectedSchemaFingerprint: config.manifest.sources[sourceDatabase].expectedSchemaFingerprint,
      activeTableCount: buildSourceRowCountQueries(config.inventory, sourceDatabase).length,
    })),
  };
}

function computeRunId(manifest: SourceExtractionManifest): string {
  const input = JSON.stringify({
    environment: manifest.environment,
    sourceSchemaRevision: manifest.sourceSchemaRevision,
    cutoverFreezeProofSha256: manifest.cutoverFreezeProofSha256 ?? null,
    sources: SOURCE_DATABASES.map((sourceDatabase) => [
      sourceDatabase,
      manifest.sources[sourceDatabase],
    ]),
  });
  return `vay1351-${createHash("sha256").update(input).digest("hex").slice(0, 24)}`;
}

function splitTableName(objectName: string): [string, string] {
  const match = /^([a-z_][a-z0-9_]*)\.([a-z_][a-z0-9_]*)$/.exec(objectName);
  if (!match) throw new SourceExtractionError("INVALID_INVENTORY", "unsafe source table name");
  return [match[1], match[2]];
}

function quoteIdentifier(value: string): string {
  if (!/^[a-z_][a-z0-9_]*$/.test(value)) {
    throw new SourceExtractionError("INVALID_INVENTORY", "unsafe SQL identifier");
  }
  return `"${value}"`;
}

function safeError(error: unknown): SourceExtractionError {
  return error instanceof SourceExtractionError
    ? error
    : new SourceExtractionError(
        "EXTRACTION_FAILED",
        "source extraction failed; inspect the run ledger",
      );
}

type TableSnapshot = { rowCount: number; checksumSha256: string };
type SourceRowBatch = {
  ordinals: string[];
  checksums: string[];
  rows: string[];
};

async function readSourceTable(
  source: QueryClient,
  sourceRelation: string,
  onBatch?: (batch: SourceRowBatch) => Promise<void>,
): Promise<TableSnapshot> {
  await source.query(
    `DECLARE vayada_source_rows NO SCROLL CURSOR FOR
     SELECT to_jsonb(source_row)::text AS row_json
     FROM ${sourceRelation} AS source_row
     ORDER BY to_jsonb(source_row)::text`,
  );
  const tableChecksum = createHash("sha256");
  let rowCount = 0;
  try {
    while (true) {
      const batch = await source.query<{ row_json: string }>(
        `FETCH FORWARD ${SOURCE_EXTRACTION_BATCH_SIZE} FROM vayada_source_rows`,
      );
      if (batch.rows.length === 0) break;
      const prepared: SourceRowBatch = { ordinals: [], checksums: [], rows: [] };
      for (const { row_json: rowJson } of batch.rows) {
        rowCount += 1;
        const checksum = createHash("sha256").update(rowJson).digest("hex");
        tableChecksum.update(`${checksum}\n`);
        prepared.ordinals.push(String(rowCount));
        prepared.checksums.push(checksum);
        prepared.rows.push(rowJson);
      }
      await onBatch?.(prepared);
    }
  } finally {
    await source.query("CLOSE vayada_source_rows").catch(() => undefined);
  }
  return { rowCount, checksumSha256: tableChecksum.digest("hex") };
}

async function stagedTableMatches(
  target: QueryClient,
  input: {
    runId: string;
    snapshotIdentifier: string;
    stagingSchema: string;
    sourceSchema: string;
    sourceTable: string;
    expectedCount: number;
    expectedChecksum: string;
  },
): Promise<boolean> {
  const tableChecksum = createHash("sha256");
  let rowCount = 0;
  let lastOrdinal = "0";
  while (true) {
    const batch = await target.query<{
      snapshot_identifier: string;
      row_ordinal: string;
      row_checksum_sha256: string;
      row_data: string;
    }>(
      `SELECT snapshot_identifier, row_ordinal::text, row_checksum_sha256,
              row_data::text AS row_data
       FROM ${quoteIdentifier(input.stagingSchema)}.snapshot_rows
       WHERE run_id = $1 AND source_schema = $2 AND source_table = $3
         AND row_ordinal > $4::bigint
       ORDER BY row_ordinal
       LIMIT ${SOURCE_EXTRACTION_BATCH_SIZE}`,
      [input.runId, input.sourceSchema, input.sourceTable, lastOrdinal],
    );
    if (batch.rows.length === 0) break;
    for (const row of batch.rows) {
      rowCount += 1;
      const checksum = createHash("sha256").update(row.row_data).digest("hex");
      if (
        row.snapshot_identifier !== input.snapshotIdentifier ||
        row.row_ordinal !== String(rowCount) ||
        row.row_checksum_sha256 !== checksum
      ) {
        return false;
      }
      tableChecksum.update(`${checksum}\n`);
      lastOrdinal = row.row_ordinal;
    }
  }
  return rowCount === input.expectedCount && tableChecksum.digest("hex") === input.expectedChecksum;
}

async function extractTable(
  target: QueryClient,
  source: QueryClient,
  input: {
    runId: string;
    sourceDatabase: SourceDatabase;
    snapshotIdentifier: string;
    sourceSchema: string;
    sourceTable: string;
    expectedCount: number;
    now: () => number;
  },
): Promise<{ rowCount: number; checksumSha256: string; durationMs: number }> {
  const stagingSchema = `migration_source_${input.sourceDatabase}`;
  const previous = await target.query<{
    status: string;
    row_count: string | null;
    checksum_sha256: string | null;
    last_failure_code: string | null;
  }>(
    `SELECT status, row_count::text, checksum_sha256, last_failure_code
     FROM platform.source_extraction_tables
     WHERE run_id = $1 AND source_database = $2 AND source_schema = $3 AND source_table = $4`,
    [input.runId, input.sourceDatabase, input.sourceSchema, input.sourceTable],
  );
  const sourceRelation = `${quoteIdentifier(input.sourceSchema)}.${quoteIdentifier(input.sourceTable)}`;
  const prior = previous.rows[0];
  if (prior?.last_failure_code === "SOURCE_IMMUTABILITY_VIOLATION") {
    throw new SourceExtractionError(
      "SOURCE_IMMUTABILITY_VIOLATION",
      "source content changed under an existing snapshot identifier",
    );
  }
  const baselineRowCount = prior?.row_count;
  const baselineChecksum = prior?.checksum_sha256;
  const hasCompletedBaseline = baselineRowCount != null && baselineChecksum != null;
  let verifiedSource: TableSnapshot | null = null;
  if (hasCompletedBaseline) {
    if (Number(baselineRowCount) !== input.expectedCount) {
      throw new SourceExtractionError(
        "SOURCE_IMMUTABILITY_VIOLATION",
        "source row count changed under an existing snapshot identifier",
      );
    }
    verifiedSource = await readSourceTable(source, sourceRelation);
    if (
      verifiedSource.rowCount !== input.expectedCount ||
      verifiedSource.checksumSha256 !== baselineChecksum
    ) {
      throw new SourceExtractionError(
        "SOURCE_IMMUTABILITY_VIOLATION",
        "source content changed under an existing snapshot identifier",
      );
    }
  }
  if (prior?.status === "completed") {
    if (
      !hasCompletedBaseline ||
      !(await stagedTableMatches(target, {
        runId: input.runId,
        snapshotIdentifier: input.snapshotIdentifier,
        stagingSchema,
        sourceSchema: input.sourceSchema,
        sourceTable: input.sourceTable,
        expectedCount: input.expectedCount,
        expectedChecksum: baselineChecksum!,
      }))
    ) {
      throw new SourceExtractionError(
        "STAGING_CHECKSUM_MISMATCH",
        "completed staging rows do not match the extraction ledger",
      );
    }
    return { ...verifiedSource!, durationMs: 0 };
  }

  const startedAt = input.now();
  await target.query(
    `INSERT INTO platform.source_extraction_tables
       (run_id, source_database, source_schema, source_table, status)
     VALUES ($1, $2, $3, $4, 'running')
     ON CONFLICT (run_id, source_database, source_schema, source_table) DO UPDATE
     SET status = 'running', row_count = NULL, checksum_sha256 = NULL,
         started_at = now(), finished_at = NULL, duration_ms = NULL,
         attempt_count = platform.source_extraction_tables.attempt_count + 1,
         last_failure_code = COALESCE(
           platform.source_extraction_tables.failure_code,
           platform.source_extraction_tables.last_failure_code
         ),
         failure_code = NULL`,
    [input.runId, input.sourceDatabase, input.sourceSchema, input.sourceTable],
  );
  await target.query(
    `DELETE FROM ${quoteIdentifier(stagingSchema)}.snapshot_rows
     WHERE run_id = $1 AND source_schema = $2 AND source_table = $3`,
    [input.runId, input.sourceSchema, input.sourceTable],
  );

  const snapshot = await readSourceTable(source, sourceRelation, async (batch) => {
    const inserted = await target.query(
      `INSERT INTO ${quoteIdentifier(stagingSchema)}.snapshot_rows
           (run_id, snapshot_identifier, source_schema, source_table,
            row_ordinal, row_checksum_sha256, row_data)
         SELECT $1, $2, $3, $4, batch.row_ordinal, batch.row_checksum, batch.row_json::jsonb
         FROM unnest($5::bigint[], $6::text[], $7::text[])
           AS batch(row_ordinal, row_checksum, row_json)
         ON CONFLICT DO NOTHING`,
      [
        input.runId,
        input.snapshotIdentifier,
        input.sourceSchema,
        input.sourceTable,
        batch.ordinals,
        batch.checksums,
        batch.rows,
      ],
    );
    if (inserted.rowCount !== batch.rows.length) {
      throw new SourceExtractionError("STAGING_CONFLICT", "staging rows changed during extraction");
    }
  });

  if (snapshot.rowCount !== input.expectedCount) {
    throw new SourceExtractionError(
      "SOURCE_COUNT_MISMATCH",
      "source row count changed during extraction",
    );
  }
  const durationMs = input.now() - startedAt;
  await target.query(
    `UPDATE platform.source_extraction_tables
     SET status = 'completed', row_count = $5, checksum_sha256 = $6,
         finished_at = now(), duration_ms = $7, failure_code = NULL
     WHERE run_id = $1 AND source_database = $2 AND source_schema = $3 AND source_table = $4`,
    [
      input.runId,
      input.sourceDatabase,
      input.sourceSchema,
      input.sourceTable,
      snapshot.rowCount,
      snapshot.checksumSha256,
      durationMs,
    ],
  );
  return { ...snapshot, durationMs };
}

export async function runSourceExtraction(
  config: SourceExtractionConfig,
  target: pg.Client,
  sources: Record<SourceDatabase, pg.Client>,
): Promise<SourceExtractionReport> {
  validateSourceExtractionConfig(config);
  const now = config.now ?? Date.now;
  const startedAt = now();
  const runId = computeRunId(config.manifest);
  const reports: SourceExtractionReport["sources"] = [];

  const lock = await target.query<{ acquired: boolean }>(
    "SELECT pg_try_advisory_lock($1) AS acquired",
    [SOURCE_EXTRACTION_LOCK_ID],
  );
  if (!lock.rows[0]?.acquired) {
    throw new SourceExtractionError("EXTRACTION_LOCKED", "another extraction is running");
  }

  try {
    await target.query(
      `INSERT INTO platform.source_extraction_runs
         (run_id, environment, source_schema_revision, cutover_freeze_proof_sha256, status)
       VALUES ($1, $2, $3, $4, 'running')
       ON CONFLICT (run_id) DO UPDATE
       SET status = 'running', started_at = now(), finished_at = NULL,
           duration_ms = NULL,
           attempt_count = platform.source_extraction_runs.attempt_count + 1,
           last_failure_code = COALESCE(
             platform.source_extraction_runs.failure_code,
             platform.source_extraction_runs.last_failure_code
           ),
           failure_code = NULL`,
      [
        runId,
        config.manifest.environment,
        config.sourceSchemaRevision,
        config.manifest.cutoverFreezeProofSha256 ?? null,
      ],
    );

    for (const sourceDatabase of SOURCE_DATABASES) {
      const source = sources[sourceDatabase];
      const approved = config.manifest.sources[sourceDatabase];
      const sourceStartedAt = now();
      await target.query(
        `INSERT INTO platform.source_extraction_sources
           (run_id, source_database, snapshot_identifier, expected_database_name,
            expected_schema_fingerprint, status)
         VALUES ($1, $2, $3, $4, $5, 'running')
         ON CONFLICT (run_id, source_database) DO UPDATE
         SET status = 'running', actual_schema_fingerprint = NULL, row_count = NULL,
             checksum_sha256 = NULL, started_at = now(), finished_at = NULL,
             duration_ms = NULL,
             attempt_count = platform.source_extraction_sources.attempt_count + 1,
             last_failure_code = COALESCE(
               platform.source_extraction_sources.failure_code,
               platform.source_extraction_sources.last_failure_code
             ),
             failure_code = NULL`,
        [
          runId,
          sourceDatabase,
          approved.snapshotIdentifier,
          approved.expectedDatabaseName,
          approved.expectedSchemaFingerprint,
        ],
      );

      try {
        const privileges = await source.query<{ is_writable: boolean }>(
          SOURCE_WRITABLE_PRIVILEGES_SQL,
        );
        if (privileges.rows[0]?.is_writable !== false) {
          throw new SourceExtractionError(
            "WRITABLE_SOURCE_REJECTED",
            `${sourceDatabase} connection has source-write privileges`,
          );
        }
        await source.query(SOURCE_READ_ONLY_TRANSACTION_SQL);
        await source.query("SET LOCAL TIME ZONE 'UTC'");
        await source.query("SET LOCAL DateStyle TO ISO");
        await source.query("SET LOCAL bytea_output TO hex");
        await source.query("SET LOCAL extra_float_digits TO 3");
        const mode = await source.query<{ transaction_read_only: string }>(
          "SHOW transaction_read_only",
        );
        if (mode.rows[0]?.transaction_read_only !== "on") {
          throw new SourceExtractionError(
            "READ_ONLY_ENFORCEMENT_FAILED",
            `${sourceDatabase} transaction is not read-only`,
          );
        }

        const provenance = await source.query<{
          source_database: string;
          snapshot_identifier: string | null;
          cutover_freeze_proof_sha256: string | null;
        }>(SOURCE_PROVENANCE_SQL);
        const attested = provenance.rows[0];
        if (
          !attested ||
          attested.source_database !== approved.expectedDatabaseName ||
          attested.snapshot_identifier !== approved.snapshotIdentifier
        ) {
          throw new SourceExtractionError(
            "SOURCE_PROVENANCE_MISMATCH",
            `${sourceDatabase} source does not attest the reviewed snapshot identifier`,
          );
        }
        if (attested.cutover_freeze_proof_sha256 !== (config.cutoverFreezeProofSha256 ?? null)) {
          throw new SourceExtractionError(
            "SOURCE_FREEZE_PROOF_MISMATCH",
            `${sourceDatabase} source does not attest the reviewed freeze proof`,
          );
        }

        const fingerprint = await source.query<{
          source_database: string;
          schema_fingerprint: string;
        }>(SOURCE_SCHEMA_FINGERPRINT_SQL);
        const actual = fingerprint.rows[0];
        if (actual) {
          await target.query(
            `UPDATE platform.source_extraction_sources
             SET actual_schema_fingerprint = $3
             WHERE run_id = $1 AND source_database = $2`,
            [runId, sourceDatabase, actual.schema_fingerprint],
          );
        }
        if (!actual || actual.source_database !== approved.expectedDatabaseName) {
          throw new SourceExtractionError(
            "SOURCE_DATABASE_MISMATCH",
            `${sourceDatabase} database name does not match the reviewed manifest`,
          );
        }
        if (actual.schema_fingerprint !== approved.expectedSchemaFingerprint) {
          throw new SourceExtractionError(
            "SOURCE_SCHEMA_DRIFT",
            `${sourceDatabase} schema fingerprint differs from the reviewed manifest`,
          );
        }

        const sourceChecksum = createHash("sha256");
        let sourceRowCount = 0;
        const countQueries = buildSourceRowCountQueries(config.inventory, sourceDatabase);
        for (const countQuery of countQueries) {
          const expected = await source.query<{ row_count: string }>(countQuery.sql);
          const expectedCount = Number(expected.rows[0]?.row_count);
          if (!Number.isSafeInteger(expectedCount) || expectedCount < 0) {
            throw new SourceExtractionError("INVALID_SOURCE_COUNT", "source count is invalid");
          }
          const [sourceSchema, sourceTable] = splitTableName(countQuery.objectName);
          let table;
          try {
            table = await extractTable(target, source, {
              runId,
              sourceDatabase,
              snapshotIdentifier: approved.snapshotIdentifier,
              sourceSchema,
              sourceTable,
              expectedCount,
              now,
            });
          } catch (error) {
            const safe = safeError(error);
            await target
              .query(
                `UPDATE platform.source_extraction_tables
                 SET status = 'failed', finished_at = now(), failure_code = $5,
                     last_failure_code = $5
                 WHERE run_id = $1 AND source_database = $2
                   AND source_schema = $3 AND source_table = $4`,
                [runId, sourceDatabase, sourceSchema, sourceTable, safe.code],
              )
              .catch(() => undefined);
            throw safe;
          }
          sourceRowCount += table.rowCount;
          sourceChecksum.update(
            `${sourceSchema}.${sourceTable}|${table.rowCount}|${table.checksumSha256}\n`,
          );
        }

        await source.query("COMMIT");
        const checksumSha256 = sourceChecksum.digest("hex");
        const durationMs = now() - sourceStartedAt;
        await target.query(
          `UPDATE platform.source_extraction_sources
           SET actual_schema_fingerprint = $3, status = 'completed', row_count = $4,
               checksum_sha256 = $5, finished_at = now(), duration_ms = $6, failure_code = NULL
           WHERE run_id = $1 AND source_database = $2`,
          [
            runId,
            sourceDatabase,
            actual.schema_fingerprint,
            sourceRowCount,
            checksumSha256,
            durationMs,
          ],
        );
        reports.push({
          sourceDatabase,
          snapshotIdentifier: approved.snapshotIdentifier,
          schemaFingerprint: actual.schema_fingerprint,
          rowCount: sourceRowCount,
          checksumSha256,
          durationMs,
        });
      } catch (error) {
        await source.query("ROLLBACK").catch(() => undefined);
        const safe = safeError(error);
        const durationMs = now() - sourceStartedAt;
        await target
          .query(
            `UPDATE platform.source_extraction_sources
             SET status = 'failed', finished_at = now(), duration_ms = $3,
                 failure_code = $4, last_failure_code = $4
             WHERE run_id = $1 AND source_database = $2`,
            [runId, sourceDatabase, durationMs, safe.code],
          )
          .catch(() => undefined);
        await target
          .query(
            `UPDATE platform.source_extraction_runs
             SET status = 'failed', finished_at = now(), duration_ms = $2,
                 failure_code = $3, last_failure_code = $3
             WHERE run_id = $1`,
            [runId, now() - startedAt, safe.code],
          )
          .catch(() => undefined);
        throw safe;
      }
    }

    const durationMs = now() - startedAt;
    await target.query(
      `UPDATE platform.source_extraction_runs
       SET status = 'completed', finished_at = now(), duration_ms = $2, failure_code = NULL
       WHERE run_id = $1`,
      [runId, durationMs],
    );
    return {
      runId,
      environment: config.manifest.environment,
      sourceSchemaRevision: config.sourceSchemaRevision,
      status: "completed",
      durationMs,
      sources: reports,
    };
  } finally {
    await target
      .query("SELECT pg_advisory_unlock($1)", [SOURCE_EXTRACTION_LOCK_ID])
      .catch(() => undefined);
  }
}
