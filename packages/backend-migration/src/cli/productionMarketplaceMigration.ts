#!/usr/bin/env node
import { runProductionMarketplaceMigration } from "../productionMarketplaceMigration.js";
import { parseProductionMarketplaceMigrationArgs } from "../productionMarketplaceMigrationArgs.js";

try {
  const report = await runProductionMarketplaceMigration(
    parseProductionMarketplaceMigrationArgs(process.argv),
  );
  console.log(JSON.stringify(report, null, 2));
  if (report.blockers.length > 0) process.exitCode = 2;
} catch (error) {
  console.error(
    `Error: ${error instanceof Error ? error.message : "Marketplace migration failed"}`,
  );
  process.exitCode = 1;
}
