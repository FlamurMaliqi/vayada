#!/usr/bin/env node
import { runProductionCatalogMigration } from "../productionCatalogMigration.js";
import { parseProductionCatalogMigrationArgs } from "../productionCatalogMigrationArgs.js";

try {
  const report = await runProductionCatalogMigration(
    parseProductionCatalogMigrationArgs(process.argv),
  );
  console.log(JSON.stringify(report, null, 2));
  if (report.blockers.length > 0) process.exitCode = 2;
} catch (error) {
  console.error(`Error: ${error instanceof Error ? error.message : "catalog migration failed"}`);
  process.exitCode = 1;
}
