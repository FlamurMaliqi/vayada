#!/usr/bin/env node
import { runProductionBookingMigration } from "../productionBookingMigration.js";
import { parseProductionBookingMigrationArgs } from "../productionBookingMigrationArgs.js";

try {
  const report = await runProductionBookingMigration(
    parseProductionBookingMigrationArgs(process.argv),
  );
  console.log(JSON.stringify(report, null, 2));
  if (report.blockers.length > 0) process.exitCode = 2;
} catch (error) {
  console.error(`Error: ${error instanceof Error ? error.message : "Booking migration failed"}`);
  process.exitCode = 1;
}
