#!/usr/bin/env node
import { runProductionFinanceMigration } from "../productionFinanceMigration.js";
import { parseProductionFinanceMigrationArgs } from "../productionFinanceMigrationArgs.js";

try {
  const report = await runProductionFinanceMigration(
    parseProductionFinanceMigrationArgs(process.argv),
  );
  console.log(JSON.stringify(report, null, 2));
  if (report.blockers.length > 0) process.exitCode = 2;
} catch (error) {
  console.error(`Error: ${error instanceof Error ? error.message : "Finance migration failed"}`);
  process.exitCode = 1;
}
