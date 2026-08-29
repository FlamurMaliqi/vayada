import pg from "pg";

import { loadFixtureCase } from "./fixtures.js";
import {
  ADVISORY_LOCK_ID,
  acquireAdvisoryLock,
  applyMigrations,
  type RunnerConfig,
  type RunResult,
} from "./runner.js";
import { normalizePgConnectionString } from "./pgConnection.js";
import { transformFixtureCase } from "./transform.js";

export type RebuildConfig = RunnerConfig & {
  schemas: string[];
  confirmedDatabaseName: string;
  fixtureCase?: string;
  fixturesDir?: string;
};

function assertSafeIdentifier(name: string): void {
  if (!/^[a-z][a-z0-9_]*$/.test(name)) {
    throw new Error(`Unsafe schema identifier: "${name}"`);
  }
}

export async function rebuild(config: RebuildConfig): Promise<RunResult> {
  if (config.environment !== "local") {
    throw new Error(
      `rebuild is only supported in the local environment (got "${config.environment}"). ` +
        `Use target:migrate for non-local environments.`,
    );
  }

  const hasFixtureCase = config.fixtureCase !== undefined;
  const hasFixturesDir = config.fixturesDir !== undefined;
  if (hasFixtureCase !== hasFixturesDir) {
    throw new Error("fixtureCase and fixturesDir must both be provided or both omitted.");
  }
  for (const schema of config.schemas) {
    assertSafeIdentifier(schema);
  }

  const client = new pg.Client({
    connectionString: normalizePgConnectionString(config.connectionString),
  });
  await client.connect();

  try {
    const databaseResult = await client.query<{ database_name: string }>(
      "SELECT current_database() AS database_name",
    );
    const actualDatabaseName = databaseResult.rows[0]?.database_name;
    if (actualDatabaseName !== config.confirmedDatabaseName) {
      throw new Error(
        `Refusing destructive rebuild: connected database "${actualDatabaseName ?? "unknown"}" ` +
          `does not match confirmed database "${config.confirmedDatabaseName}".`,
      );
    }

    // Hold the advisory lock across drops, migrations, and fixture loading so
    // concurrent rebuild/migrate calls cannot interleave.
    await acquireAdvisoryLock(client);

    for (const schema of config.schemas) {
      await client.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    }

    const result = await applyMigrations(config, client);

    if (config.fixtureCase && config.fixturesDir && !result.failed) {
      await loadFixtureCase(
        { fixtureCase: config.fixtureCase, fixturesDir: config.fixturesDir },
        client,
      );
      await transformFixtureCase({ fixtureCase: config.fixtureCase }, client);
    }

    return result;
  } finally {
    try {
      await client.query(`SELECT pg_advisory_unlock($1)`, [ADVISORY_LOCK_ID]);
    } catch {
      // best-effort; connection close releases it anyway
    }
    await client.end();
  }
}
