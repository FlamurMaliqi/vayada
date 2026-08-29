#!/usr/bin/env node
import { runProductionIdentityMigration } from "../productionIdentityMigration.js";
import { parseProductionIdentityMigrationArgs } from "../productionIdentityMigrationArgs.js";

try {
  const report = await runProductionIdentityMigration(
    parseProductionIdentityMigrationArgs(process.argv),
  );
  console.log(JSON.stringify(report, null, 2));
  if (report.blockers.length > 0) process.exitCode = 2;
} catch (error) {
  console.error(`Error: ${error instanceof Error ? error.message : "identity migration failed"}`);
  process.exitCode = 1;
}
