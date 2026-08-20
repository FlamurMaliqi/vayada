#!/usr/bin/env node
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { runMigrations, type MigrationEnvironment } from "../runner.js";
import { assertValidEnvironment } from "./utils.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DEFAULT_MIGRATIONS_DIR = join(__dirname, "../../migrations");

function parseArgs(argv: string[]): {
  env: MigrationEnvironment;
  connectionString: string;
  migrationsDir: string;
  gitSha: string | null;
} {
  const args = argv.slice(2);
  let env: MigrationEnvironment = "local";
  let connectionString = process.env["TARGET_DATABASE_URL"] ?? "";
  let migrationsDir = DEFAULT_MIGRATIONS_DIR;
  let gitSha = process.env["APPLICATION_RELEASE"] ?? process.env["GIT_SHA"] ?? null;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--env" && args[i + 1]) {
      env = assertValidEnvironment(args[++i]);
    } else if (args[i] === "--connection-string" && args[i + 1]) {
      connectionString = args[++i];
    } else if (args[i] === "--migrations-dir" && args[i + 1]) {
      migrationsDir = args[++i];
    } else if (args[i] === "--git-sha" && args[i + 1]) {
      gitSha = args[++i];
    }
  }

  return { env, connectionString, migrationsDir, gitSha };
}

const { env, connectionString, migrationsDir, gitSha } = parseArgs(process.argv);

if (!connectionString) {
  console.error("Error: TARGET_DATABASE_URL or --connection-string is required.");
  process.exit(1);
}

console.log(`Migration release: ${gitSha ?? "unversioned"}; environment: ${env}`);

const result = await runMigrations({
  connectionString,
  migrationsDir,
  environment: env,
  gitSha,
});

if (result.applied.length > 0) {
  console.log(`Applied:  ${result.applied.join(", ")}`);
}
if (result.applied.length > 0 && result.skipped.length > 0) {
  console.log(`Skipped:  ${result.skipped.join(", ")}`);
}
if (result.applied.length === 0 && !result.failed) {
  console.log(
    result.skipped.length > 0
      ? `No pending migrations. Already applied: ${result.skipped.join(", ")}`
      : "No pending migrations.",
  );
}
if (result.failed) {
  console.error(`Failed at version ${result.failed}. See platform.schema_migrations for details.`);
  process.exit(1);
}
