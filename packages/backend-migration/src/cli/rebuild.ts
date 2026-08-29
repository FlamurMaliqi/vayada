#!/usr/bin/env node
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { rebuild } from "../rebuild.js";
import { type MigrationEnvironment } from "../runner.js";
import { DEFAULT_REBUILD_SCHEMAS } from "../targetSchemas.js";
import { assertValidEnvironment } from "./utils.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DEFAULT_MIGRATIONS_DIR = join(__dirname, "../../migrations");
const DEFAULT_FIXTURES_DIR = join(__dirname, "../../fixtures");

function parseArgs(argv: string[]): {
  env: MigrationEnvironment;
  connectionString: string;
  migrationsDir: string;
  fixturesDir: string;
  fixtures: string | null;
  schemas: string[];
  confirmedDatabaseName: string;
} {
  const args = argv.slice(2);
  let env: MigrationEnvironment = "local";
  let connectionString = process.env["TARGET_DATABASE_URL"] ?? "";
  let migrationsDir = DEFAULT_MIGRATIONS_DIR;
  let fixturesDir = DEFAULT_FIXTURES_DIR;
  let fixtures: string | null = null;
  let schemas: string[] = [...DEFAULT_REBUILD_SCHEMAS];
  let confirmedDatabaseName = "";

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--env" && args[i + 1]) {
      env = assertValidEnvironment(args[++i]);
    } else if (args[i] === "--connection-string" && args[i + 1]) {
      connectionString = args[++i];
    } else if (args[i] === "--migrations-dir" && args[i + 1]) {
      migrationsDir = args[++i];
    } else if (args[i] === "--fixtures-dir" && args[i + 1]) {
      fixturesDir = args[++i];
    } else if (args[i] === "--fixtures" && args[i + 1]) {
      fixtures = args[++i];
    } else if (args[i] === "--schemas" && args[i + 1]) {
      schemas = args[++i]
        .split(",")
        .map((s) => s.trim())
        .filter((s) => s.length > 0);
    } else if (args[i] === "--confirm-database" && args[i + 1]) {
      confirmedDatabaseName = args[++i];
    }
  }

  if (schemas.length === 0) {
    console.error("Error: --schemas must specify at least one schema name.");
    process.exit(1);
  }
  if (!confirmedDatabaseName) {
    console.error(
      "Error: --confirm-database <database name> is required for destructive rebuilds.",
    );
    process.exit(1);
  }

  return {
    env,
    connectionString,
    migrationsDir,
    fixturesDir,
    fixtures,
    schemas,
    confirmedDatabaseName,
  };
}

const {
  env,
  connectionString,
  migrationsDir,
  fixturesDir,
  fixtures,
  schemas,
  confirmedDatabaseName,
} = parseArgs(process.argv);

if (!connectionString) {
  console.error("Error: TARGET_DATABASE_URL or --connection-string is required.");
  process.exit(1);
}

console.log(`Dropping schemas: ${schemas.join(", ")}`);

const result = await rebuild({
  connectionString,
  migrationsDir,
  environment: env,
  schemas,
  confirmedDatabaseName,
  fixtureCase: fixtures ?? undefined,
  fixturesDir: fixtures ? fixturesDir : undefined,
});

if (result.applied.length > 0) {
  console.log(`Applied:  ${result.applied.join(", ")}`);
}
if (result.applied.length === 0 && !result.failed) {
  console.log("No migrations to apply.");
}
if (result.failed) {
  console.error(`Failed at version ${result.failed}. See platform.schema_migrations for details.`);
  process.exit(1);
}
if (fixtures) {
  console.log(`Fixtures: loaded and transformed "${fixtures}"`);
}
