#!/usr/bin/env node
import { runProductionMediaMigration } from "../productionMediaMigration.js";
import { parseProductionMediaMigrationArgs } from "../productionMediaMigrationArgs.js";

try {
  const report = await runProductionMediaMigration(parseProductionMediaMigrationArgs(process.argv));
  console.log(JSON.stringify(report, null, 2));
  if (report.blockers.length > 0) process.exitCode = 2;
} catch (error) {
  console.error(`Error: ${error instanceof Error ? error.message : "media migration failed"}`);
  process.exitCode = 1;
}
