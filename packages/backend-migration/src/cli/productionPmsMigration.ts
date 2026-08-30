#!/usr/bin/env node
import { runProductionPmsMigration } from "../productionPmsMigration.js";
import { parseProductionPmsMigrationArgs } from "../productionPmsMigrationArgs.js";

try {
  const report = await runProductionPmsMigration(parseProductionPmsMigrationArgs(process.argv));
  console.log(JSON.stringify(report, null, 2));
  if (report.blockers.length > 0) process.exitCode = 2;
} catch (error) {
  console.error(`Error: ${error instanceof Error ? error.message : "PMS migration failed"}`);
  process.exitCode = 1;
}
