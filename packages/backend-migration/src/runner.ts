import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import pg from "pg";

import { normalizePgConnectionString } from "./pgConnection.js";

export type MigrationEnvironment = "local" | "staging" | "preprod" | "production";

export const MIGRATION_ENVIRONMENTS: readonly MigrationEnvironment[] = [
  "local",
  "staging",
  "preprod",
  "production",
];

export type MigrationStatus = "applied" | "failed" | "rolled_forward";

export type MigrationFile = {
  version: string;
  name: string;
  filename: string;
  path: string;
};

export type LedgerRow = {
  version: string;
  name: string;
  checksum_sha256: string;
  applied_at: Date;
  applied_by: string;
  environment: MigrationEnvironment;
  git_sha: string | null;
  runner_version: string;
  duration_ms: number;
  status: MigrationStatus;
  failure_reason: string | null;
  statement_count: number | null;
  requires_rebuild: boolean;
};

export type RunnerConfig = {
  connectionString: string;
  migrationsDir: string;
  environment: MigrationEnvironment;
  appliedBy?: string;
  gitSha?: string | null;
  runnerVersion?: string;
};

export type RunResult = {
  applied: string[];
  skipped: string[];
  failed: string | null;
};

const MIGRATION_FILENAME_RE = /^(\d{4})_([a-z][a-z0-9_]*)\.sql$/;

export const ADVISORY_LOCK_ID = 8734516;

const RUNNER_VERSION = "0.1.0";

const LOCK_MAX_ATTEMPTS = 10;
const LOCK_RETRY_DELAY_MS = 500;

export function computeChecksum(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

export async function discoverMigrations(dir: string): Promise<MigrationFile[]> {
  const entries = await readdir(dir);
  const files: MigrationFile[] = [];
  const filenameByVersion = new Map<string, string>();

  for (const filename of entries) {
    const match = MIGRATION_FILENAME_RE.exec(filename);
    if (match) {
      const existingFilename = filenameByVersion.get(match[1]);
      if (existingFilename) {
        throw new Error(
          `Duplicate migration version ${match[1]}: ${existingFilename} and ${filename}`,
        );
      }
      filenameByVersion.set(match[1], filename);
      files.push({
        version: match[1],
        name: match[2],
        filename,
        path: join(dir, filename),
      });
    }
  }

  return files.sort((a, b) => a.version.localeCompare(b.version));
}

export async function acquireAdvisoryLock(client: pg.Client): Promise<void> {
  for (let attempt = 1; attempt <= LOCK_MAX_ATTEMPTS; attempt++) {
    const result = await client.query<{ acquired: boolean }>(
      `SELECT pg_try_advisory_lock($1) AS acquired`,
      [ADVISORY_LOCK_ID],
    );
    if (result.rows[0].acquired) return;
    if (attempt < LOCK_MAX_ATTEMPTS) {
      await new Promise<void>((resolve) => setTimeout(resolve, LOCK_RETRY_DELAY_MS));
    }
  }
  throw new Error(
    `Could not acquire migration advisory lock after ${LOCK_MAX_ATTEMPTS} attempts ` +
      `(${LOCK_MAX_ATTEMPTS * LOCK_RETRY_DELAY_MS}ms). Another migration may be running.`,
  );
}

export async function ensureLedgerTable(client: pg.Client): Promise<void> {
  await client.query(`CREATE SCHEMA IF NOT EXISTS platform`);
  await client.query(`
    CREATE TABLE IF NOT EXISTS platform.schema_migrations (
      id              SERIAL       PRIMARY KEY,
      version         TEXT         NOT NULL,
      name            TEXT         NOT NULL,
      checksum_sha256 TEXT         NOT NULL,
      applied_at      TIMESTAMPTZ  NOT NULL DEFAULT now(),
      applied_by      TEXT         NOT NULL,
      environment     TEXT         NOT NULL,
      git_sha         TEXT,
      runner_version  TEXT         NOT NULL,
      duration_ms     INTEGER      NOT NULL,
      status          TEXT         NOT NULL
                        CHECK (status IN ('applied', 'failed', 'rolled_forward')),
      failure_reason  TEXT,
      statement_count INTEGER,
      requires_rebuild BOOLEAN     NOT NULL DEFAULT FALSE
    )
  `);
}

async function getAppliedRow(
  client: pg.Client,
  version: string,
): Promise<{ checksum_sha256: string } | null> {
  const result = await client.query<{ checksum_sha256: string }>(
    `SELECT checksum_sha256 FROM platform.schema_migrations
     WHERE version = $1 AND status = 'applied'
     ORDER BY applied_at DESC LIMIT 1`,
    [version],
  );
  return result.rows[0] ?? null;
}

async function insertLedgerRow(
  client: pg.Client,
  row: Omit<LedgerRow, "applied_at">,
): Promise<void> {
  await client.query(
    `INSERT INTO platform.schema_migrations
       (version, name, checksum_sha256, applied_by, environment, git_sha,
        runner_version, duration_ms, status, failure_reason, statement_count, requires_rebuild)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
    [
      row.version,
      row.name,
      row.checksum_sha256,
      row.applied_by,
      row.environment,
      row.git_sha ?? null,
      row.runner_version,
      row.duration_ms,
      row.status,
      row.failure_reason ?? null,
      row.statement_count ?? null,
      row.requires_rebuild,
    ],
  );
}

// Applies migrations on an already-connected, already-locked client.
// Used by both runMigrations and rebuild so the advisory lock spans the whole operation.
export async function applyMigrations(config: RunnerConfig, client: pg.Client): Promise<RunResult> {
  await ensureLedgerTable(client);

  const migrations = await discoverMigrations(config.migrationsDir);
  const result: RunResult = { applied: [], skipped: [], failed: null };

  const appliedBy = config.appliedBy ?? process.env["USER"] ?? "unknown";
  const runnerVersion = config.runnerVersion ?? RUNNER_VERSION;

  for (const migration of migrations) {
    const content = await readFile(migration.path, "utf8");
    const checksum = computeChecksum(content);

    const existing = await getAppliedRow(client, migration.version);

    if (existing !== null) {
      if (existing.checksum_sha256 !== checksum) {
        const failureReason =
          `Checksum mismatch for ${migration.filename}: ` +
          `ledger has ${existing.checksum_sha256}, file is ${checksum}`;

        await insertLedgerRow(client, {
          ...migration,
          checksum_sha256: checksum,
          applied_by: appliedBy,
          environment: config.environment,
          git_sha: config.gitSha ?? null,
          runner_version: runnerVersion,
          duration_ms: 0,
          status: "failed",
          failure_reason: failureReason,
          statement_count: null,
          requires_rebuild: false,
        });

        result.failed = migration.version;
        return result;
      }

      result.skipped.push(migration.version);
      continue;
    }

    const startedAt = Date.now();

    try {
      await client.query("BEGIN");
      await client.query(content);
      // Ledger insert is inside the transaction so DDL and record are atomic.
      await insertLedgerRow(client, {
        ...migration,
        checksum_sha256: checksum,
        applied_by: appliedBy,
        environment: config.environment,
        git_sha: config.gitSha ?? null,
        runner_version: runnerVersion,
        duration_ms: Date.now() - startedAt,
        status: "applied",
        failure_reason: null,
        statement_count: null,
        requires_rebuild: false,
      });
      await client.query("COMMIT");

      result.applied.push(migration.version);
    } catch (error) {
      await client.query("ROLLBACK");

      const failureReason = error instanceof Error ? error.message : String(error);

      await insertLedgerRow(client, {
        ...migration,
        checksum_sha256: checksum,
        applied_by: appliedBy,
        environment: config.environment,
        git_sha: config.gitSha ?? null,
        runner_version: runnerVersion,
        duration_ms: Date.now() - startedAt,
        status: "failed",
        failure_reason: failureReason,
        statement_count: null,
        requires_rebuild: false,
      });

      result.failed = migration.version;
      return result;
    }
  }

  return result;
}

export async function runMigrations(config: RunnerConfig): Promise<RunResult> {
  const client = new pg.Client({
    connectionString: normalizePgConnectionString(config.connectionString),
  });
  await client.connect();

  try {
    await acquireAdvisoryLock(client);
    return await applyMigrations(config, client);
  } finally {
    try {
      await client.query(`SELECT pg_advisory_unlock($1)`, [ADVISORY_LOCK_ID]);
    } catch {
      // best-effort; connection close releases it anyway
    }
    await client.end();
  }
}
