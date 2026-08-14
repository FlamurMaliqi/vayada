#!/usr/bin/env node
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { runParityChecks, type ParityReport } from "../parity.js";
import { rebuild } from "../rebuild.js";
import { type MigrationEnvironment } from "../runner.js";
import { getSmokeFixtureCases } from "../smoke.js";
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
  schemas: string[];
} {
  const args = argv.slice(2);
  let env: MigrationEnvironment = "local";
  let connectionString = process.env["TARGET_DATABASE_URL"] ?? "";
  let migrationsDir = DEFAULT_MIGRATIONS_DIR;
  let fixturesDir = DEFAULT_FIXTURES_DIR;
  let schemas: string[] = [...DEFAULT_REBUILD_SCHEMAS];

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--env" && args[i + 1]) {
      env = assertValidEnvironment(args[++i]);
    } else if (args[i] === "--connection-string" && args[i + 1]) {
      connectionString = args[++i];
    } else if (args[i] === "--migrations-dir" && args[i + 1]) {
      migrationsDir = args[++i];
    } else if (args[i] === "--fixtures-dir" && args[i + 1]) {
      fixturesDir = args[++i];
    } else if (args[i] === "--schemas" && args[i + 1]) {
      schemas = args[++i]
        .split(",")
        .map((s) => s.trim())
        .filter((s) => s.length > 0);
    } else if (args[i] === "--fixtures") {
      console.error(
        "Error: target:fixtures:smoke always runs every registered fixture case. " +
          "Use target:rebuild and target:parity for a single case.",
      );
      process.exit(1);
    } else {
      console.error(`Error: unknown argument "${args[i]}".`);
      process.exit(1);
    }
  }

  if (schemas.length === 0) {
    console.error("Error: --schemas must specify at least one schema name.");
    process.exit(1);
  }

  return { env, connectionString, migrationsDir, fixturesDir, schemas };
}

function printParityFindings(result: ParityReport): void {
  if (result.findings.length === 0) return;

  console.log("Findings:");
  for (const finding of result.findings) {
    console.log(`  [${finding.severity.toUpperCase()}] ${finding.code} - ${finding.targetObject}`);
    console.log(`    ${finding.message}`);
    console.log(`    Expected: ${finding.expected}`);
    console.log(`    Actual:   ${finding.actual}`);
    if (finding.suggestedAction) console.log(`    Fix: ${finding.suggestedAction}`);
  }
}

const { env, connectionString, migrationsDir, fixturesDir, schemas } = parseArgs(process.argv);

if (!connectionString) {
  console.error("Error: TARGET_DATABASE_URL or --connection-string is required.");
  process.exit(1);
}

const fixtureCases = getSmokeFixtureCases();
if (fixtureCases.length === 0) {
  console.error("Error: no fixture cases are registered for full-fixture smoke.");
  process.exit(1);
}

console.log(`Running full fixture smoke for ${fixtureCases.length} cases:`);
console.log(`  ${fixtureCases.join(", ")}`);

for (const [index, fixtureCase] of fixtureCases.entries()) {
  const label = `[${index + 1}/${fixtureCases.length}] ${fixtureCase}`;

  console.log(`\n${label}: rebuilding target`);
  const rebuildResult = await rebuild({
    connectionString,
    migrationsDir,
    environment: env,
    schemas,
    fixtureCase,
    fixturesDir,
  });

  if (rebuildResult.applied.length > 0) {
    console.log(`Applied: ${rebuildResult.applied.join(", ")}`);
  }
  if (rebuildResult.failed) {
    console.error(`${label}: rebuild failed at migration ${rebuildResult.failed}.`);
    process.exit(1);
  }

  console.log(`${label}: running parity`);
  const parityResult = await runParityChecks({
    connectionString,
    fixtureCase,
    fixturesDir,
    environment: env,
  });

  console.log(
    `${label}: parity ${parityResult.status} ` +
      `(failures=${parityResult.summary.failures}, warnings=${parityResult.summary.warnings})`,
  );

  if (parityResult.status === "failed") {
    printParityFindings(parityResult);
    process.exit(1);
  }
}

console.log(`\nFull fixture smoke passed for ${fixtureCases.length} cases.`);
