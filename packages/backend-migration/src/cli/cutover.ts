#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  abortProductionCutover,
  productionCutoverExitCode,
  ProductionCutoverError,
  readProductionCutoverStatus,
  runProductionCutover,
  type ProductionCutoverConfig,
  type ProductionCutoverMode,
  type ProductionCutoverReport,
  type ProductionMigrationStatusReport,
} from "../productionCutover.js";
import {
  parseProductionCutoverArgs,
  ProductionCutoverArgsError,
} from "../productionCutoverArgs.js";
import { parseSourceExtractionManifest, type SourceExtractionConfig } from "../sourceExtraction.js";
import { parseSourceInventory, SOURCE_DATABASES, type SourceDatabase } from "../sourceInventory.js";

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "../../");
const migrationsDir = join(packageRoot, "migrations");
const sourceUrlEnvironment: Record<SourceDatabase, string> = {
  auth: "AUTH_SOURCE_DATABASE_URL",
  booking: "BOOKING_SOURCE_DATABASE_URL",
  marketplace: "MARKETPLACE_SOURCE_DATABASE_URL",
  pms: "PMS_SOURCE_DATABASE_URL",
};

try {
  const parsed = parseProductionCutoverArgs(process.argv);
  const target = process.env["TARGET_DATABASE_URL"];
  if (!target)
    throw new ProductionCutoverError("MISSING_CONNECTION", "TARGET_DATABASE_URL is required");
  if (parsed.command === "status") {
    printStatus(
      await readProductionCutoverStatus({
        connectionString: target,
        runId: parsed.values.get("--run-id"),
        environment: parsed.values.get("--env") as ProductionCutoverConfig["environment"],
      }),
      parsed.report,
    );
  } else if (parsed.command === "abort") {
    print(
      await abortProductionCutover({
        connectionString: target,
        runId: parsed.values.get("--run-id")!,
        operator: parsed.values.get("--operator")!,
        confirmation: parsed.values.get("--confirmation")!,
      }),
      parsed.report,
    );
  } else {
    const manifest = parseSourceExtractionManifest(
      JSON.parse(await readFile(parsed.values.get("--manifest")!, "utf8")),
    );
    const inventory = parseSourceInventory(
      await readFile(join(packageRoot, "source-inventory.tsv"), "utf8"),
    );
    const sourceTags = Object.fromEntries(
      SOURCE_DATABASES.map((database) => [database, parsed.values.get(`--${database}-source-tag`)]),
    ) as Record<SourceDatabase, string>;
    const sourceConnectionStrings = Object.fromEntries(
      SOURCE_DATABASES.map((database) => {
        const environmentName = sourceUrlEnvironment[database];
        const value = process.env[environmentName];
        if (!value)
          throw new ProductionCutoverError("MISSING_CONNECTION", `${environmentName} is required`);
        return [database, value];
      }),
    ) as Record<SourceDatabase, string>;
    const sourceExtraction: SourceExtractionConfig = {
      manifest,
      inventory,
      sourceSchemaRevision: parsed.values.get("--source-schema-revision")!,
      snapshotIdentifiers: sourceTags,
      cutoverFreezeProofSha256: parsed.values.get("--freeze-proof-sha256"),
    };
    const mode: ProductionCutoverMode = {
      "rehearse-staging": "staging_rehearsal",
      "dry-run": "cutover_dry_run",
      cutover: "production_cutover",
    }[parsed.command] as ProductionCutoverMode;
    const applicationRelease = parsed.values.get("--application-release")!;
    const approvedRunReportPath = parsed.values.get("--approved-run-report");
    const approvedRunReport = approvedRunReportPath
      ? JSON.parse(await readFile(approvedRunReportPath, "utf8"))
      : undefined;
    const smokeReportPath = parsed.values.get("--smoke-report");
    const smokeReport = smokeReportPath
      ? JSON.parse(await readFile(smokeReportPath, "utf8"))
      : undefined;
    const approvalReportPath = parsed.values.get("--approval-report");
    const approvalReport = approvalReportPath
      ? JSON.parse(await readFile(approvalReportPath, "utf8"))
      : undefined;
    const config: ProductionCutoverConfig = {
      connectionString: target,
      migrationsDir,
      mode,
      runId: parsed.values.get("--run-id")!,
      sourceRunId: parsed.values.get("--source-run-id")!,
      sourceTags,
      sourceEnvironment: parsed.values.get(
        "--source-env",
      ) as ProductionCutoverConfig["sourceEnvironment"],
      environment: parsed.values.get("--env") as ProductionCutoverConfig["environment"],
      applicationRelease,
      runtimeApplicationRelease: process.env["APPLICATION_RELEASE"] ?? process.env["GIT_SHA"] ?? "",
      operator: parsed.values.get("--operator")!,
      targetCleanProofSha256: parsed.values.get("--target-clean-proof-sha256")!,
      freezeProofSha256: parsed.values.get("--freeze-proof-sha256")!,
      smokeReport,
      backupProofSha256: parsed.values.get("--backup-proof-sha256"),
      approvedRunId: parsed.values.get("--approved-run-id"),
      approvedReportChecksumSha256: parsed.values.get("--approved-report-checksum-sha256"),
      approvedRunReport,
      approvedParityDecision: parsed.values.get(
        "--approved-decision",
      ) as ProductionCutoverConfig["approvedParityDecision"],
      approvalProofSha256: parsed.values.get("--approval-proof-sha256"),
      approvalReport,
      confirmation: parsed.values.get("--confirmation"),
      resume: parsed.resume,
      sourceExtraction,
      sourceConnectionStrings,
      media: mediaConfig(),
    };
    const report = await runProductionCutover(config);
    print(report, parsed.report);
    process.exitCode = productionCutoverExitCode(report);
  }
} catch (error) {
  const safe =
    error instanceof ProductionCutoverError
      ? error
      : error instanceof ProductionCutoverArgsError
        ? new ProductionCutoverError("INVALID_ARGUMENTS", error.message)
        : new ProductionCutoverError("CUTOVER_COMMAND_FAILED", "Cutover command failed");
  console.error(`${safe.code}: ${safe.message}`);
  process.exitCode = 1;
}

function mediaConfig(): ProductionCutoverConfig["media"] {
  const targetBucket = process.env["PLATFORM_MEDIA_BUCKET"]?.trim();
  const cdnBaseUrl = process.env["PLATFORM_MEDIA_CDN_BASE_URL"]?.trim();
  const legacyPmsBucket = process.env["LEGACY_PMS_MEDIA_BUCKET"]?.trim();
  const allowedLegacyBuckets = process.env["LEGACY_MEDIA_BUCKET_ALLOWLIST"]
    ?.split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  if (!targetBucket || !cdnBaseUrl || !legacyPmsBucket || !allowedLegacyBuckets?.length)
    throw new ProductionCutoverError(
      "MISSING_MEDIA_CONFIGURATION",
      "PLATFORM_MEDIA_BUCKET, PLATFORM_MEDIA_CDN_BASE_URL, LEGACY_PMS_MEDIA_BUCKET, and LEGACY_MEDIA_BUCKET_ALLOWLIST are required",
    );
  return {
    targetBucket,
    cdnBaseUrl,
    legacyPmsBucket,
    allowedLegacyBuckets,
    region: process.env["AWS_REGION"]?.trim() || undefined,
  };
}

function print(
  report: ProductionCutoverReport | ProductionCutoverReport[],
  format: "json" | "text",
) {
  if (format === "json") {
    console.log(JSON.stringify(report, null, 2));
    return;
  }
  const reports = Array.isArray(report) ? report : [report];
  if (reports.length === 0) {
    console.log("No production cutover runs found.");
    return;
  }
  for (const row of reports) {
    console.log(`${row.runId}: ${row.status.toUpperCase()} (${row.mode})`);
    console.log(`  source=${row.sourceRunId} parity=${row.parityDecision ?? "pending"}`);
    console.log(`  checkpoint=${row.lastSafeCheckpoint ?? "none"} legacyAuthority=legacy`);
    console.log(`  evidence=${row.evidenceChecksumSha256}`);
  }
}

function printStatus(report: ProductionMigrationStatusReport, format: "json" | "text") {
  if (format === "json") {
    console.log(JSON.stringify(report, null, 2));
    return;
  }
  console.log(`Applied SQL migrations: ${report.migrations.length}`);
  for (const migration of report.migrations)
    console.log(
      `  ${migration.version}_${migration.name}: ${migration.checksumSha256} (${migration.environment})`,
    );
  console.log(
    report.latestRehearsal
      ? `Latest staging rehearsal: ${report.latestRehearsal.runId} ${report.latestRehearsal.status.toUpperCase()}`
      : "Latest staging rehearsal: none",
  );
  print(report.runs, "text");
}
