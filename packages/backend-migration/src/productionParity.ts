import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

import pg from "pg";

import { normalizePgConnectionString } from "./pgConnection.js";
import {
  runProductionBookingMigration,
  type ProductionBookingMigrationReport,
} from "./productionBookingMigration.js";
import {
  runProductionCatalogMigration,
  type ProductionCatalogMigrationReport,
} from "./productionCatalogMigration.js";
import {
  runProductionFinanceMigration,
  type ProductionFinanceMigrationReport,
} from "./productionFinanceMigration.js";
import {
  runProductionIdentityMigration,
  type ProductionIdentityMigrationReport,
} from "./productionIdentityMigration.js";
import {
  runProductionMarketplaceMigration,
  type ProductionMarketplaceMigrationReport,
} from "./productionMarketplaceMigration.js";
import {
  runProductionPmsMigration,
  type ProductionPmsMigrationReport,
} from "./productionPmsMigration.js";
import { computeChecksum, discoverMigrations, type MigrationEnvironment } from "./runner.js";
import { SOURCE_DATABASES, type SourceDatabase } from "./sourceInventory.js";

export const PRODUCTION_PARITY_DOMAINS = [
  "identity",
  "catalog",
  "booking",
  "pms",
  "marketplace",
  "finance",
] as const;

export type ProductionParityDomain = (typeof PRODUCTION_PARITY_DOMAINS)[number];
export type ProductionParitySeverity = "pass" | "warn" | "fail";
export type ProductionParityStatus = "pass" | "warn" | "fail";
export type ProductionParityDecision = "go" | "review" | "no-go";
export const SOURCE_EXTRACTION_ENVIRONMENTS = ["local", "staging", "preprod"] as const;
export type SourceExtractionEnvironment = (typeof SOURCE_EXTRACTION_ENVIRONMENTS)[number];

export type ProductionParityFinding = {
  severity: ProductionParitySeverity;
  code: string;
  owner: string;
  targetObject: string;
  message: string;
  expected: string;
  actual: string;
};

export type ProductionParitySourceEvidence = {
  sourceDatabase: SourceDatabase;
  snapshotIdentifier: string;
  expectedSchemaFingerprint: string;
  actualSchemaFingerprint: string | null;
  status: string;
  rowCount: number | null;
  checksumSha256: string | null;
  tableCount: number;
  tableRowCount: number;
  failedTableCount: number;
};

export type ProductionParityLedgerRow = {
  version: string;
  name: string;
  checksumSha256: string;
  expectedChecksumSha256: string | null;
  environment: string;
  gitSha: string | null;
  runnerVersion: string;
  status: string;
  appliedAt: string;
};

export type ProductionParityEvidence = {
  extraction: {
    runId: string;
    environment: string;
    sourceSchemaRevision: string;
    cutoverFreezeProofSha256: string | null;
    status: string;
  } | null;
  sources: ProductionParitySourceEvidence[];
  migrationLedger: ProductionParityLedgerRow[];
  missingMigrationVersions: string[];
  unexpectedMigrationVersions: string[];
  piiExposureCount: number;
  rawLegacyMediaReferenceCount: number;
  staleProvenanceCount: number;
};

type DomainReport =
  | ProductionIdentityMigrationReport
  | ProductionCatalogMigrationReport
  | ProductionBookingMigrationReport
  | ProductionPmsMigrationReport
  | ProductionMarketplaceMigrationReport
  | ProductionFinanceMigrationReport;

export type ProductionParityDomainResult = {
  status: "pass" | "fail";
  checksum: string;
  counts: unknown;
  parity: unknown;
  blockerCount: number;
};

export type ProductionParityReport = {
  sourceRunId: string;
  sourceEnvironment: SourceExtractionEnvironment;
  environment: MigrationEnvironment;
  applicationRelease: string;
  operator: string;
  operatorSha256: string;
  sourceTags: Record<SourceDatabase, { sha256: string }>;
  startedAt: string;
  finishedAt: string;
  status: ProductionParityStatus;
  decision: ProductionParityDecision;
  thresholds: {
    failureBudget: 0;
    warningBudget: number;
    warningsRequireHumanApproval: true;
  };
  summary: {
    passes: number;
    warnings: number;
    failures: number;
    checkedDomains: ProductionParityDomain[];
  };
  extraction: {
    environment: string;
    sourceSchemaRevision: string;
    cutoverFreezeProofSha256: string | null;
    status: string;
  } | null;
  sources: Array<{
    sourceDatabase: SourceDatabase;
    snapshotTagSha256: string;
    expectedSchemaFingerprint: string;
    actualSchemaFingerprint: string | null;
    status: string;
    rowCount: number | null;
    checksumSha256: string | null;
    tableCount: number;
    tableRowCount: number;
    failedTableCount: number;
  }>;
  migrationLedger: Array<{
    version: string;
    name: string;
    checksumSha256: string;
    environment: string;
    gitSha: string | null;
    runnerVersion: string;
    status: string;
    appliedAt: string;
  }>;
  domains: Partial<Record<ProductionParityDomain, ProductionParityDomainResult>>;
  findings: ProductionParityFinding[];
  reportChecksumSha256: string;
};

export type ProductionParityConfig = {
  connectionString: string;
  sourceRunId: string;
  sourceTags: Record<SourceDatabase, string>;
  sourceEnvironment: SourceExtractionEnvironment;
  environment: MigrationEnvironment;
  applicationRelease: string;
  runtimeApplicationRelease?: string | null;
  operator: string;
  warningBudget: number;
  migrationsDir: string;
};

export type ProductionParityServices = {
  withTargetWriteFreeze: (
    config: ProductionParityConfig,
    run: () => Promise<ProductionParityReport>,
  ) => Promise<ProductionParityReport>;
  readEvidence: (config: ProductionParityConfig) => Promise<ProductionParityEvidence>;
  runDomains: Record<
    ProductionParityDomain,
    (config: ProductionParityConfig) => Promise<DomainReport>
  >;
  now: () => string;
};

const defaultServices: ProductionParityServices = {
  withTargetWriteFreeze: withProductionParityTargetWriteFreeze,
  readEvidence: readProductionParityEvidence,
  runDomains: {
    identity: (config) => domainDryRun(config, runProductionIdentityMigration),
    catalog: (config) => domainDryRun(config, runProductionCatalogMigration),
    booking: (config) => domainDryRun(config, runProductionBookingMigration),
    pms: (config) => domainDryRun(config, runProductionPmsMigration),
    marketplace: (config) => domainDryRun(config, runProductionMarketplaceMigration),
    finance: (config) => domainDryRun(config, runProductionFinanceMigration),
  },
  now: () => new Date().toISOString(),
};

export async function runProductionParity(
  config: ProductionParityConfig,
  services: ProductionParityServices = defaultServices,
): Promise<ProductionParityReport> {
  assertProductionParityConfig(config);
  return services.withTargetWriteFreeze(config, () =>
    buildProductionParityReport(config, services),
  );
}

async function buildProductionParityReport(
  config: ProductionParityConfig,
  services: ProductionParityServices,
): Promise<ProductionParityReport> {
  const startedAt = services.now();
  const findings: ProductionParityFinding[] = [];
  let evidence: ProductionParityEvidence;
  try {
    evidence = await services.readEvidence(config);
    findings.push(...evaluateEvidence(config, evidence));
  } catch {
    evidence = emptyEvidence();
    findings.push(
      finding(
        "fail",
        "PARITY_EVIDENCE_UNAVAILABLE",
        "Migration cutover",
        "platform",
        "Run-level extraction, schema, exposure, and migration-ledger evidence is unavailable",
        "Complete read-only evidence",
        "Unavailable",
      ),
    );
  }

  const domains: Partial<Record<ProductionParityDomain, ProductionParityDomainResult>> = {};
  for (const domain of PRODUCTION_PARITY_DOMAINS) {
    try {
      const report = await services.runDomains[domain](config);
      const result = evaluateDomain(config, domain, report, findings);
      domains[domain] = result;
    } catch {
      findings.push(
        finding(
          "fail",
          "MISSING_DOMAIN_RESULT",
          domain,
          domain,
          `${domain} dry-run did not produce a reconciliation result`,
          "Deterministic domain report",
          "Unavailable",
        ),
      );
    }
  }

  const redactedDomains = domains;
  const orderedFindings = findings.map(redactFinding).sort(compareFindings);
  const failures = orderedFindings.filter((row) => row.severity === "fail").length;
  const warnings = orderedFindings.filter((row) => row.severity === "warn").length;
  const passes = orderedFindings.filter((row) => row.severity === "pass").length;
  const status: ProductionParityStatus =
    failures > 0 || warnings > config.warningBudget ? "fail" : warnings > 0 ? "warn" : "pass";
  const decision: ProductionParityDecision =
    status === "fail" ? "no-go" : status === "warn" ? "review" : "go";
  const sourceTags = Object.fromEntries(
    SOURCE_DATABASES.map((database) => [database, { sha256: sha256(config.sourceTags[database]) }]),
  ) as Record<SourceDatabase, { sha256: string }>;
  const migrationLedger = evidence.migrationLedger
    .map((row) => ({
      version: row.version,
      name: row.name,
      checksumSha256: row.checksumSha256,
      environment: row.environment,
      gitSha: row.gitSha,
      runnerVersion: row.runnerVersion,
      status: row.status,
      appliedAt: row.appliedAt,
    }))
    .sort((left, right) => left.version.localeCompare(right.version));
  const extraction = evidence.extraction
    ? {
        environment: evidence.extraction.environment,
        sourceSchemaRevision: evidence.extraction.sourceSchemaRevision,
        cutoverFreezeProofSha256: evidence.extraction.cutoverFreezeProofSha256,
        status: evidence.extraction.status,
      }
    : null;
  const sources = evidence.sources
    .map((source) => ({
      sourceDatabase: source.sourceDatabase,
      snapshotTagSha256: sha256(source.snapshotIdentifier),
      expectedSchemaFingerprint: source.expectedSchemaFingerprint,
      actualSchemaFingerprint: source.actualSchemaFingerprint,
      status: source.status,
      rowCount: source.rowCount,
      checksumSha256: source.checksumSha256,
      tableCount: source.tableCount,
      tableRowCount: source.tableRowCount,
      failedTableCount: source.failedTableCount,
    }))
    .sort((left, right) => left.sourceDatabase.localeCompare(right.sourceDatabase));
  const checksumMaterial = {
    sourceRunId: config.sourceRunId,
    sourceEnvironment: config.sourceEnvironment,
    environment: config.environment,
    applicationRelease: config.applicationRelease,
    operatorSha256: sha256(config.operator),
    sourceTags,
    thresholds: {
      failureBudget: 0,
      warningBudget: config.warningBudget,
      warningsRequireHumanApproval: true,
    },
    status,
    decision,
    extraction,
    sources,
    migrationLedger,
    domains: redactedDomains,
    findings: orderedFindings,
  };

  return {
    sourceRunId: config.sourceRunId,
    sourceEnvironment: config.sourceEnvironment,
    environment: config.environment,
    applicationRelease: config.applicationRelease,
    operator: "[REDACTED]",
    operatorSha256: sha256(config.operator),
    sourceTags,
    startedAt,
    finishedAt: services.now(),
    status,
    decision,
    thresholds: {
      failureBudget: 0,
      warningBudget: config.warningBudget,
      warningsRequireHumanApproval: true,
    },
    summary: {
      passes,
      warnings,
      failures,
      checkedDomains: PRODUCTION_PARITY_DOMAINS.filter((domain) => domains[domain]),
    },
    extraction,
    sources,
    migrationLedger,
    domains: redactedDomains,
    findings: orderedFindings,
    reportChecksumSha256: sha256(stableJson(checksumMaterial)),
  };
}

export async function withProductionParityTargetWriteFreeze<T>(
  config: ProductionParityConfig,
  run: () => Promise<T>,
): Promise<T> {
  const client = new pg.Client({
    connectionString: normalizePgConnectionString(config.connectionString),
  });
  await client.connect();
  let finished = false;
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL lock_timeout = '5s'");
    const tables = await client.query<{ tableName: string }>(
      `SELECT format('%I.%I', schemaname, tablename) AS "tableName"
         FROM pg_tables
        WHERE schemaname IN (
          'identity', 'hotel_catalog', 'booking', 'pms', 'finance', 'marketplace',
          'distribution', 'platform', 'migration_source_auth', 'migration_source_booking',
          'migration_source_marketplace', 'migration_source_pms'
        )
        ORDER BY schemaname, tablename`,
    );
    if (tables.rows.length === 0)
      throw new Error("Production parity target write freeze found no target tables");
    await client.query(
      `LOCK TABLE ${tables.rows.map((row) => row.tableName).join(", ")} IN SHARE MODE`,
    );
    const result = await run();
    await client.query("ROLLBACK");
    finished = true;
    return result;
  } catch (error) {
    if (!finished) await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    await client.end();
  }
}

export function formatProductionParityText(report: ProductionParityReport): string {
  const lines = [
    `Production migration parity: ${report.sourceRunId}`,
    `Decision: ${report.decision.toUpperCase()}`,
    `Status: ${report.status.toUpperCase()}`,
    `Report checksum: ${report.reportChecksumSha256}`,
    `Source environment: ${report.sourceEnvironment}`,
    `Target environment: ${report.environment}`,
    `Application release: ${report.applicationRelease}`,
    `Operator: ${report.operator} (${report.operatorSha256})`,
    `Failures: ${report.summary.failures}`,
    `Warnings: ${report.summary.warnings}`,
    `Passes: ${report.summary.passes}`,
    `Domains: ${report.summary.checkedDomains.join(", ") || "none"}`,
    `Source tags: ${SOURCE_DATABASES.map((database) => `${database}=${report.sourceTags[database].sha256}`).join(", ")}`,
    `Migration ledger: ${report.migrationLedger.length} versions (${report.migrationLedger[0]?.version ?? "none"}..${report.migrationLedger.at(-1)?.version ?? "none"})`,
  ];
  if (report.findings.length > 0) {
    lines.push("", "Findings:");
    for (const row of report.findings) {
      lines.push(
        `  [${row.severity.toUpperCase()}] ${row.code} — ${row.targetObject}`,
        `    ${row.message}`,
        `    Expected: ${row.expected}`,
        `    Actual: ${row.actual}`,
      );
    }
  }
  return lines.join("\n");
}

export async function readProductionParityEvidence(
  config: ProductionParityConfig,
): Promise<ProductionParityEvidence> {
  const client = new pg.Client({
    connectionString: normalizePgConnectionString(config.connectionString),
  });
  await client.connect();
  let transactionFinished = false;
  try {
    await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    const runResult = await client.query<ExtractionRow>(
      `SELECT run_id AS "runId", environment,
                  source_schema_revision AS "sourceSchemaRevision",
                  cutover_freeze_proof_sha256 AS "cutoverFreezeProofSha256", status
             FROM platform.source_extraction_runs
            WHERE run_id = $1`,
      [config.sourceRunId],
    );
    const sourceResult = await client.query<SourceRow>(
      `SELECT source_database AS "sourceDatabase",
                  snapshot_identifier AS "snapshotIdentifier",
                  expected_schema_fingerprint AS "expectedSchemaFingerprint",
                  actual_schema_fingerprint AS "actualSchemaFingerprint", status,
                  row_count::text AS "rowCount", checksum_sha256 AS "checksumSha256"
             FROM platform.source_extraction_sources
            WHERE run_id = $1
            ORDER BY source_database`,
      [config.sourceRunId],
    );
    const tableResult = await client.query<TableAggregateRow>(
      `SELECT source_database AS "sourceDatabase", count(*)::text AS "tableCount",
                  coalesce(sum(row_count), 0)::text AS "tableRowCount",
                  count(*) FILTER (WHERE status <> 'completed')::text AS "failedTableCount"
             FROM platform.source_extraction_tables
            WHERE run_id = $1
            GROUP BY source_database
            ORDER BY source_database`,
      [config.sourceRunId],
    );
    const ledgerResult = await client.query<LedgerQueryRow>(
      `SELECT DISTINCT ON (version) version, name,
                  checksum_sha256 AS "checksumSha256", environment,
                  git_sha AS "gitSha", runner_version AS "runnerVersion", status,
                  applied_at::text AS "appliedAt"
             FROM platform.schema_migrations
            ORDER BY version, applied_at DESC, id DESC`,
    );
    const piiResult = await client.query<CountRow>(PII_EXPOSURE_QUERY);
    const mediaResult = await client.query<CountRow>(RAW_LEGACY_MEDIA_QUERY);
    const staleResult = await client.query<CountRow>(
      `SELECT count(*)::text AS count
         FROM (
           SELECT target_product AS marker
             FROM platform.production_migration_source_links
            WHERE target_product IN ('booking', 'pms', 'marketplace', 'finance')
              AND last_run_id <> $1
           UNION ALL
           SELECT source_system AS marker
             FROM hotel_catalog.property_source_links
            WHERE status = 'active'
              AND (
                (source_system = 'booking' AND source_table = 'booking_hotels')
                OR (source_system = 'pms' AND source_table = 'hotels')
                OR (source_system = 'marketplace' AND source_table = 'hotel_profiles')
              )
              AND metadata ->> 'migrationRunId' IS DISTINCT FROM $1
         ) AS stale_provenance`,
      [config.sourceRunId],
    );
    await client.query("ROLLBACK");
    transactionFinished = true;

    const tableBySource = new Map(tableResult.rows.map((row) => [row.sourceDatabase, row]));
    const sources = sourceResult.rows.map((row) => {
      const tables = tableBySource.get(row.sourceDatabase);
      return {
        sourceDatabase: row.sourceDatabase,
        snapshotIdentifier: row.snapshotIdentifier,
        expectedSchemaFingerprint: row.expectedSchemaFingerprint,
        actualSchemaFingerprint: row.actualSchemaFingerprint,
        status: row.status,
        rowCount: numberOrNull(row.rowCount),
        checksumSha256: row.checksumSha256,
        tableCount: number(tables?.tableCount),
        tableRowCount: number(tables?.tableRowCount),
        failedTableCount: number(tables?.failedTableCount),
      };
    });
    const migrations = await discoverMigrations(config.migrationsDir);
    const expectedChecksums = new Map<string, string>();
    for (const migration of migrations)
      expectedChecksums.set(
        migration.version,
        computeChecksum(await readFile(migration.path, "utf8")),
      );
    const ledgerVersions = new Set(ledgerResult.rows.map((row) => row.version));
    const migrationVersions = new Set(migrations.map((row) => row.version));
    const migrationLedger = ledgerResult.rows.map((row) => ({
      ...row,
      expectedChecksumSha256: expectedChecksums.get(row.version) ?? null,
    }));

    return {
      extraction: runResult.rows[0] ?? null,
      sources,
      migrationLedger,
      missingMigrationVersions: [...migrationVersions]
        .filter((version) => !ledgerVersions.has(version))
        .sort(),
      unexpectedMigrationVersions: [...ledgerVersions]
        .filter((version) => !migrationVersions.has(version))
        .sort(),
      piiExposureCount: number(piiResult.rows[0]?.count),
      rawLegacyMediaReferenceCount: number(mediaResult.rows[0]?.count),
      staleProvenanceCount: number(staleResult.rows[0]?.count),
    };
  } catch (error) {
    if (!transactionFinished) await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    await client.end();
  }
}

function evaluateEvidence(
  config: ProductionParityConfig,
  evidence: ProductionParityEvidence,
): ProductionParityFinding[] {
  const findings: ProductionParityFinding[] = [];
  const extraction = evidence.extraction;
  if (!extraction) {
    findings.push(
      finding(
        "fail",
        "MISSING_EXTRACTION_RUN",
        "Source extraction",
        "platform.source_extraction_runs",
        "The immutable extraction run does not exist",
        config.sourceRunId,
        "Missing",
      ),
    );
  } else {
    if (extraction.runId !== config.sourceRunId)
      findings.push(
        finding(
          "fail",
          "EXTRACTION_RUN_MISMATCH",
          "Source extraction",
          "platform.source_extraction_runs",
          "Extraction evidence belongs to a different run",
          config.sourceRunId,
          extraction.runId,
        ),
      );
    if (extraction.status !== "completed")
      findings.push(
        finding(
          "fail",
          "INCOMPLETE_EXTRACTION_RUN",
          "Source extraction",
          "platform.source_extraction_runs",
          "The immutable extraction is not complete",
          "completed",
          extraction.status,
        ),
      );
    if (extraction.environment !== config.sourceEnvironment)
      findings.push(
        finding(
          "fail",
          "EXTRACTION_ENVIRONMENT_MISMATCH",
          "Source extraction",
          "platform.source_extraction_runs",
          "Source extraction environment differs from the reviewed extraction ledger",
          config.sourceEnvironment,
          extraction.environment,
        ),
      );
    if (config.environment !== "local" && !isSha256(extraction.cutoverFreezeProofSha256))
      findings.push(
        finding(
          "fail",
          "MISSING_FREEZE_PROOF",
          "Cutover commander",
          "platform.source_extraction_runs",
          "Non-local parity requires the reviewed cutover freeze proof",
          "64-character SHA-256",
          "Missing",
        ),
      );
  }

  const sources = new Map(evidence.sources.map((source) => [source.sourceDatabase, source]));
  for (const database of SOURCE_DATABASES) {
    const source = sources.get(database);
    if (!source) {
      findings.push(
        finding(
          "fail",
          "MISSING_SOURCE_DOMAIN",
          "Source extraction",
          `platform.source_extraction_sources:${database}`,
          `${database} extraction evidence is missing`,
          "Completed source evidence",
          "Missing",
        ),
      );
      continue;
    }
    const expectedTagHash = sha256(config.sourceTags[database]);
    const actualTagHash = sha256(source.snapshotIdentifier);
    if (expectedTagHash !== actualTagHash)
      findings.push(
        finding(
          "fail",
          "SOURCE_TAG_MISMATCH",
          "Source extraction",
          `platform.source_extraction_sources:${database}`,
          `${database} immutable source tag differs from the extraction ledger`,
          expectedTagHash,
          actualTagHash,
        ),
      );
    if (source.status !== "completed")
      findings.push(
        finding(
          "fail",
          "INCOMPLETE_SOURCE_DOMAIN",
          "Source extraction",
          `platform.source_extraction_sources:${database}`,
          `${database} source extraction is not complete`,
          "completed",
          source.status,
        ),
      );
    if (
      !source.actualSchemaFingerprint ||
      source.actualSchemaFingerprint !== source.expectedSchemaFingerprint
    )
      findings.push(
        finding(
          "fail",
          "SOURCE_SCHEMA_DRIFT",
          "Source extraction",
          `platform.source_extraction_sources:${database}`,
          `${database} schema fingerprint differs from the reviewed manifest`,
          source.expectedSchemaFingerprint,
          source.actualSchemaFingerprint ?? "Missing",
        ),
      );
    if (!isSha256(source.checksumSha256))
      findings.push(
        finding(
          "fail",
          "MISSING_SOURCE_CHECKSUM",
          "Source extraction",
          `platform.source_extraction_sources:${database}`,
          `${database} extraction checksum is missing or malformed`,
          "64-character SHA-256",
          "Missing or malformed",
        ),
      );
    if (source.failedTableCount > 0 || source.tableCount === 0)
      findings.push(
        finding(
          "fail",
          "INCOMPLETE_SOURCE_TABLES",
          "Source extraction",
          `platform.source_extraction_tables:${database}`,
          `${database} table extraction evidence is incomplete`,
          "At least one completed table and zero failures",
          `${source.tableCount} tables, ${source.failedTableCount} incomplete`,
        ),
      );
    if (source.rowCount === null || source.rowCount !== source.tableRowCount)
      findings.push(
        finding(
          "fail",
          "SOURCE_ROW_COUNT_MISMATCH",
          "Source extraction",
          `platform.source_extraction_tables:${database}`,
          `${database} source and table-ledger counts differ`,
          String(source.rowCount ?? "Missing"),
          String(source.tableRowCount),
        ),
      );
    const hasFailure = findings.some(
      (row) => row.severity === "fail" && row.targetObject.endsWith(`:${database}`),
    );
    if (!hasFailure)
      findings.push(
        finding(
          "pass",
          "SOURCE_DOMAIN_VERIFIED",
          "Source extraction",
          `platform.source_extraction_sources:${database}`,
          `${database} immutable source tag, schema, checksum, and counts match`,
          "Verified",
          "Verified",
        ),
      );
  }

  if (evidence.migrationLedger.length === 0)
    findings.push(
      finding(
        "fail",
        "MISSING_MIGRATION_LEDGER",
        "Target schema",
        "platform.schema_migrations",
        "Target migration ledger is empty",
        "All reviewed migrations applied",
        "Empty",
      ),
    );
  for (const version of evidence.missingMigrationVersions)
    findings.push(
      finding(
        "fail",
        "MISSING_TARGET_MIGRATION",
        "Target schema",
        `platform.schema_migrations:${version}`,
        "Reviewed target migration is not applied",
        version,
        "Missing",
      ),
    );
  for (const version of evidence.unexpectedMigrationVersions)
    findings.push(
      finding(
        "fail",
        "UNEXPECTED_TARGET_MIGRATION",
        "Target schema",
        `platform.schema_migrations:${version}`,
        "Target ledger contains a migration absent from this application release",
        "No unreviewed version",
        version,
      ),
    );
  for (const row of evidence.migrationLedger) {
    if (row.status !== "applied")
      findings.push(
        finding(
          "fail",
          "FAILED_TARGET_MIGRATION",
          "Target schema",
          `platform.schema_migrations:${row.version}`,
          "Latest target migration ledger entry is not applied",
          "applied",
          row.status,
        ),
      );
    if (!row.expectedChecksumSha256 || row.checksumSha256 !== row.expectedChecksumSha256)
      findings.push(
        finding(
          "fail",
          "TARGET_MIGRATION_CHECKSUM_MISMATCH",
          "Target schema",
          `platform.schema_migrations:${row.version}`,
          "Applied target migration differs from this application release",
          row.expectedChecksumSha256 ?? "Migration file present",
          row.checksumSha256,
        ),
      );
    if (row.environment !== config.environment)
      findings.push(
        finding(
          "fail",
          "TARGET_MIGRATION_ENVIRONMENT_MISMATCH",
          "Target schema",
          `platform.schema_migrations:${row.version}`,
          "Applied migration environment differs from the parity target",
          config.environment,
          row.environment,
        ),
      );
  }
  if (
    evidence.migrationLedger.length > 0 &&
    !findings.some(
      (row) => row.severity === "fail" && row.targetObject.startsWith("platform.schema_migrations"),
    )
  )
    findings.push(
      finding(
        "pass",
        "TARGET_MIGRATION_LEDGER_VERIFIED",
        "Target schema",
        "platform.schema_migrations",
        "Applied migration checksums and environment match this release",
        "Verified",
        "Verified",
      ),
    );

  for (const [count, code, owner, targetObject, message] of [
    [
      evidence.piiExposureCount,
      "PUBLIC_PII_EXPOSURE",
      "Data privacy",
      "target read models",
      "Target read models contain forbidden PII or private evidence",
    ],
    [
      evidence.rawLegacyMediaReferenceCount,
      "RAW_LEGACY_MEDIA_REFERENCE",
      "Platform Media",
      "target media references",
      "Target product rows still contain raw legacy media references",
    ],
    [
      evidence.staleProvenanceCount,
      "STALE_MIGRATION_PROVENANCE",
      "Migration cutover",
      "platform.production_migration_source_links",
      "Target provenance is bound to a different immutable extraction run",
    ],
  ] as const) {
    findings.push(
      finding(count > 0 ? "fail" : "pass", code, owner, targetObject, message, "0", String(count)),
    );
  }
  return findings;
}

function evaluateDomain(
  config: ProductionParityConfig,
  domain: ProductionParityDomain,
  report: DomainReport,
  findings: ProductionParityFinding[],
): ProductionParityDomainResult {
  if (report.sourceRunId !== config.sourceRunId)
    findings.push(
      finding(
        "fail",
        "DOMAIN_SOURCE_RUN_MISMATCH",
        domain,
        domain,
        `${domain} reconciliation result belongs to a different extraction run`,
        config.sourceRunId,
        report.sourceRunId,
      ),
    );
  if (report.mode !== "dry-run" || report.applied)
    findings.push(
      finding(
        "fail",
        "DOMAIN_MUTATED_TARGET",
        domain,
        domain,
        `${domain} parity must execute in rollback-only dry-run mode`,
        "dry-run, applied=false",
        `${report.mode}, applied=${String(report.applied)}`,
      ),
    );
  if (!isSha256(report.checksum))
    findings.push(
      finding(
        "fail",
        "INVALID_DOMAIN_CHECKSUM",
        domain,
        domain,
        `${domain} result is not checksum-addressed`,
        "64-character SHA-256",
        "Missing or malformed",
      ),
    );
  for (const blocker of report.blockers) {
    const code = /^[A-Z][A-Z0-9_]*$/.test(blocker.code) ? blocker.code : "DOMAIN_BLOCKER";
    const targetObject = /^[a-z_]+(?:\.[a-z_]+)?$/.test(blocker.source) ? blocker.source : domain;
    findings.push(
      finding(
        "fail",
        code,
        domain,
        targetObject,
        `${domain} dry-run reported an unresolved blocker; sensitive evidence is hash-addressed`,
        "No unresolved domain blocker",
        `sha256:${sha256(stableJson({ message: blocker.message, sourceId: blocker.sourceId }))}`,
      ),
    );
  }

  const counts = report.counts as unknown as Record<string, number>;
  const parity =
    "parity" in report
      ? report.parity
      : "retiredAuthRows" in report
        ? { retiredAuthRows: report.retiredAuthRows }
        : {};
  addPreservationWarnings(domain, counts, report, findings);
  addDomainInvariantFindings(domain, report, findings);
  const failed = findings.some((row) => row.severity === "fail" && row.owner === domain);
  if (!failed)
    findings.push(
      finding(
        "pass",
        "DOMAIN_PARITY_VERIFIED",
        domain,
        domain,
        `${domain} counts, ownership, lifecycle, relationships, and domain invariants passed`,
        "Verified",
        "Verified",
      ),
    );
  return {
    status: failed ? "fail" : "pass",
    checksum: report.checksum,
    counts: redactAggregateValue(counts),
    parity: { checksumSha256: sha256(stableJson(parity)) },
    blockerCount: report.blockers.length,
  };
}

function addPreservationWarnings(
  domain: ProductionParityDomain,
  counts: Record<string, number>,
  report: DomainReport,
  findings: ProductionParityFinding[],
): void {
  const preservedNewer =
    number(counts["preservedNewerTarget"]) + number(counts["preservedNewerUsers"]);
  const preservedDeletions = number(counts["preservedTargetDeletions"]);
  const preservedCatalog = "preservedTarget" in report ? report.preservedTarget.length : 0;
  for (const [count, code, message] of [
    [
      preservedNewer + preservedCatalog,
      "PRESERVED_NEWER_TARGET_STATE",
      "Newer target-owned state was preserved instead of being overwritten by legacy state",
    ],
    [
      preservedDeletions,
      "PRESERVED_TARGET_DELETION",
      "A prior target-side deletion was preserved instead of being resurrected from legacy state",
    ],
  ] as const)
    if (count > 0)
      findings.push(
        finding(
          "warn",
          code,
          domain,
          domain,
          message,
          "Reviewed preservation evidence",
          String(count),
        ),
      );
}

function addDomainInvariantFindings(
  domain: ProductionParityDomain,
  report: DomainReport,
  findings: ProductionParityFinding[],
): void {
  const counts = report.counts as unknown as Record<string, number>;
  const pendingWrites =
    domain === "catalog"
      ? number(counts["writes"])
      : domain === "identity"
        ? number(counts["pendingTargetWrites"])
        : number(counts["inserts"]) + number(counts["updates"]);
  if (pendingWrites > 0)
    findings.push(
      finding(
        "fail",
        "UNAPPLIED_DOMAIN_CHANGES",
        domain,
        domain,
        `${domain} target still differs from the accepted immutable migration plan`,
        "0 pending inserts or updates",
        String(pendingWrites),
      ),
    );
  if (domain === "identity") {
    const users = number((report as ProductionIdentityMigrationReport).counts.users);
    if (users === 0)
      findings.push(
        finding(
          "fail",
          "EMPTY_PRODUCTION_IDENTITY",
          domain,
          "identity.users",
          "Production identity reconciliation contains no users",
          "At least one user",
          "0",
        ),
      );
    return;
  }
  if (domain === "booking") {
    const parity = (report as ProductionBookingMigrationReport).parity;
    if (
      stableJson(parity.activeFutureSourceBookings) !==
      stableJson(parity.activeFutureTargetBookings)
    )
      findings.push(
        finding(
          "fail",
          "ACTIVE_BOOKING_LIFECYCLE_VARIANCE",
          domain,
          "booking.guest_bookings",
          "Active and future booking IDs, lifecycles, or stay dates differ",
          sha256(stableJson(parity.activeFutureSourceBookings)),
          sha256(stableJson(parity.activeFutureTargetBookings)),
        ),
      );
  } else if (domain === "pms") {
    const parity = (report as ProductionPmsMigrationReport).parity;
    const propertyIds = new Set([
      ...Object.keys(parity.expectedActiveRoomTypesByProperty),
      ...Object.keys(parity.actualActiveRoomTypesByProperty),
    ]);
    for (const propertyId of [...propertyIds].sort()) {
      const expectedRoomTypes = parity.expectedActiveRoomTypesByProperty[propertyId] ?? [];
      const actualRoomTypes = parity.actualActiveRoomTypesByProperty[propertyId] ?? [];
      if (stableJson(expectedRoomTypes) !== stableJson(actualRoomTypes))
        findings.push(
          finding(
            "fail",
            "FUTURE_INVENTORY_VARIANCE",
            domain,
            `pms.inventory_days:${propertyId}`,
            "Active room types and future inventory horizons differ",
            sha256(stableJson(expectedRoomTypes)),
            sha256(stableJson(actualRoomTypes)),
          ),
        );
    }
    for (const [roomTypeId, inventory] of Object.entries(parity.futureInventoryByRoomType))
      if (
        inventory.rows !== 366 ||
        inventory.distinctDays !== 366 ||
        daysBetween(inventory.firstStayDate, inventory.lastStayDate) !== 365
      )
        findings.push(
          finding(
            "fail",
            "FUTURE_INVENTORY_VARIANCE",
            domain,
            `pms.inventory_days:${inventory.propertyId}:${roomTypeId}`,
            "Each active room type must have exactly one row for each day in a 366-day horizon",
            "366 rows, 366 distinct days, 365-day span",
            `${inventory.rows} rows, ${inventory.distinctDays} distinct days, ${daysBetween(inventory.firstStayDate, inventory.lastStayDate)}-day span`,
          ),
        );
  } else if (domain === "finance") {
    const parity = (report as ProductionFinanceMigrationReport).parity;
    const pairs = [
      [
        parity.sourcePaymentAmountsByCurrencyStatusOwner,
        parity.targetPaymentAmountsByCurrencyStatusOwner,
      ],
      [
        parity.sourcePaymentCountsByCurrencyStatusOwner,
        parity.targetPaymentCountsByCurrencyStatusOwner,
      ],
      [
        parity.sourcePaymentFeesByCurrencyStatusOwner,
        parity.targetPaymentFeesByCurrencyStatusOwner,
      ],
      [parity.sourcePaymentNetByCurrencyStatusOwner, parity.targetPaymentNetByCurrencyStatusOwner],
      [
        parity.sourcePaymentRefundsByCurrencyStatusOwner,
        parity.targetPaymentRefundsByCurrencyStatusOwner,
      ],
      [
        parity.sourcePayoutAmountsByCurrencyStatusOwner,
        parity.targetPayoutAmountsByCurrencyStatusOwner,
      ],
      [
        parity.sourcePayoutCountsByCurrencyStatusOwner,
        parity.targetPayoutCountsByCurrencyStatusOwner,
      ],
      [parity.sourcePayoutNetByCurrencyStatusOwner, parity.targetPayoutNetByCurrencyStatusOwner],
      [parity.sourcePayoutAllocationsByBookingOwner, parity.targetPayoutAllocationsByBookingOwner],
    ];
    if (pairs.some(([source, target]) => stableJson(source) !== stableJson(target)))
      findings.push(
        finding(
          "fail",
          "FINANCIAL_VARIANCE",
          domain,
          "finance",
          "Finance monetary or count parity differs by required dimensions",
          "Exact dimensional parity",
          "Variance",
        ),
      );
  }
}

function finding(
  severity: ProductionParitySeverity,
  code: string,
  owner: string,
  targetObject: string,
  message: string,
  expected: string,
  actual: string,
): ProductionParityFinding {
  return { severity, code, owner, targetObject, message, expected, actual };
}

function redactFinding(row: ProductionParityFinding): ProductionParityFinding {
  return {
    ...row,
    owner: redactString(row.owner),
    targetObject: redactString(row.targetObject),
    message: redactString(row.message),
    expected: redactString(row.expected),
    actual: redactString(row.actual),
  };
}

function compareFindings(left: ProductionParityFinding, right: ProductionParityFinding): number {
  const rank = { fail: 0, warn: 1, pass: 2 } as const;
  return (
    rank[left.severity] - rank[right.severity] ||
    left.code.localeCompare(right.code) ||
    left.owner.localeCompare(right.owner) ||
    left.targetObject.localeCompare(right.targetObject)
  );
}

function redactAggregateValue(value: unknown): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value === "string") return `sha256:${sha256(value)}`;
  if (typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(redactAggregateValue);
  const result: Record<string, unknown> = {};
  for (const [childKey, childValue] of Object.entries(value as Record<string, unknown>)) {
    const safeKey = /^[A-Za-z][A-Za-z0-9]*$/.test(childKey)
      ? childKey
      : `sha256:${sha256(childKey)}`;
    result[safeKey] = redactAggregateValue(childValue);
  }
  return result;
}

function redactString(value: string): string {
  return value
    .replace(/(?:postgres(?:ql)?|mysql):\/\/[^\s]+/giu, "[REDACTED_CONNECTION]")
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/giu, "[REDACTED_EMAIL]")
    .replace(/\b(?:sk|rk|pk)_(?:live|test)_[A-Za-z0-9]+\b/gu, "[REDACTED_SECRET]")
    .replace(/\bBearer\s+[A-Za-z0-9._~-]+\b/giu, "Bearer [REDACTED]")
    .replace(/https?:\/\/[^\s)\]}]+/giu, "[REDACTED_URL]");
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => `${JSON.stringify(key)}:${stableJson(child)}`)
      .join(",")}}`;
  return JSON.stringify(value);
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function isSha256(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
}

function number(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && /^\d+$/.test(value)) return Number(value);
  return 0;
}

function numberOrNull(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  return number(value);
}

function daysBetween(first: string, last: string): number {
  const firstTime = Date.parse(`${first}T00:00:00Z`);
  const lastTime = Date.parse(`${last}T00:00:00Z`);
  return Number.isFinite(firstTime) && Number.isFinite(lastTime)
    ? (lastTime - firstTime) / 86_400_000
    : Number.NaN;
}

function emptyEvidence(): ProductionParityEvidence {
  return {
    extraction: null,
    sources: [],
    migrationLedger: [],
    missingMigrationVersions: [],
    unexpectedMigrationVersions: [],
    piiExposureCount: 0,
    rawLegacyMediaReferenceCount: 0,
    staleProvenanceCount: 0,
  };
}

function assertProductionParityConfig(config: ProductionParityConfig): void {
  if (!/^vay1351-[0-9a-f]{24}$/.test(config.sourceRunId))
    throw new Error("sourceRunId must be an immutable VAY-1351 extraction run ID");
  if (!Number.isInteger(config.warningBudget) || config.warningBudget < 0)
    throw new Error("warningBudget must be a non-negative integer");
  if (!SOURCE_EXTRACTION_ENVIRONMENTS.includes(config.sourceEnvironment))
    throw new Error("sourceEnvironment must be local, staging, or preprod");
  const requiredSourceEnvironment =
    config.environment === "production" ? "preprod" : config.environment;
  if (config.sourceEnvironment !== requiredSourceEnvironment)
    throw new Error(
      `${config.environment} target parity requires a ${requiredSourceEnvironment} extraction`,
    );
  if (!config.applicationRelease.trim()) throw new Error("applicationRelease is required");
  if (config.environment !== "local" && !/^[0-9a-f]{40}$/.test(config.applicationRelease))
    throw new Error("applicationRelease must be a full lowercase Git SHA outside local");
  if (
    config.environment !== "local" &&
    (!config.runtimeApplicationRelease ||
      !/^[0-9a-f]{40}$/.test(config.runtimeApplicationRelease) ||
      config.runtimeApplicationRelease !== config.applicationRelease)
  )
    throw new Error(
      "applicationRelease must match trusted APPLICATION_RELEASE or GIT_SHA deployment metadata",
    );
  if (!config.operator.trim()) throw new Error("operator is required");
  for (const database of SOURCE_DATABASES)
    if (!config.sourceTags[database]?.trim()) throw new Error(`${database} source tag is required`);
}

async function domainDryRun<T extends DomainReport>(
  config: ProductionParityConfig,
  run: (input: { connectionString: string; sourceRunId: string; mode: "dry-run" }) => Promise<T>,
): Promise<T> {
  return run({
    connectionString: config.connectionString,
    sourceRunId: config.sourceRunId,
    mode: "dry-run",
  });
}

type ExtractionRow = NonNullable<ProductionParityEvidence["extraction"]>;
type SourceRow = Omit<
  ProductionParitySourceEvidence,
  "rowCount" | "tableCount" | "tableRowCount" | "failedTableCount"
> & { rowCount: string | null };
type TableAggregateRow = {
  sourceDatabase: SourceDatabase;
  tableCount: string;
  tableRowCount: string;
  failedTableCount: string;
};
type LedgerQueryRow = Omit<ProductionParityLedgerRow, "expectedChecksumSha256">;
type CountRow = { count: string };

const PII_EXPOSURE_QUERY = `
  WITH exposure(source, id, payload) AS (
    SELECT 'booking.direct_booking_summary_read_model', guest_booking_id::text,
           to_jsonb(summary)
      FROM booking.direct_booking_summary_read_model summary
    UNION ALL
    SELECT 'finance.finance_visibility_read_model', id::text, to_jsonb(visibility)
      FROM finance.finance_visibility_read_model visibility
    UNION ALL
    SELECT 'marketplace.marketplace_offer_read_model', offer_id::text,
           jsonb_build_object(
             'offerTitle', offer_title,
             'offerSummary', offer_summary,
             'accommodationType', accommodation_type,
             'location', location,
             'imageUrls', image_urls,
             'publicCompensationSummary', public_compensation_summary,
             'publicCreatorRequirements', public_creator_requirements,
             'sourceFreshness', source_freshness
           )
      FROM marketplace.marketplace_offer_read_model offer_read_model
     WHERE visibility_status = 'public'
    UNION ALL
    SELECT 'distribution.public_quote_read_models', quote_session_id::text, to_jsonb(quote)
      FROM distribution.public_quote_read_models quote
    UNION ALL
    SELECT 'distribution.public_hotel_bookability_profiles', property_id::text,
           to_jsonb(bookability)
      FROM distribution.public_hotel_bookability_profiles bookability
    UNION ALL
    SELECT 'distribution.public_room_offer_snapshots', id::text, to_jsonb(room_offer)
      FROM distribution.public_room_offer_snapshots room_offer
    UNION ALL
    SELECT 'distribution.public_booking_content_revisions', id::text, public_content
      FROM distribution.public_booking_content_revisions
    UNION ALL
    SELECT 'hotel_catalog.property_public_profile_read_model', property_id::text,
           jsonb_build_object(
             'descriptions', descriptions,
             'media', media,
             'amenities', amenities,
             'public_policy', public_policy,
             'source_freshness', source_freshness
           )
      FROM hotel_catalog.property_public_profile_read_model
  )
  SELECT count(*)::text AS count
    FROM exposure
   WHERE CASE
           WHEN source = 'marketplace.marketplace_offer_read_model'
             THEN marketplace.jsonb_has_marketplace_private_key(payload)
           ELSE distribution.jsonb_has_distribution_private_key(payload)
         END
      OR payload::text ~* '[A-Z0-9._%+-]+@[A-Z0-9.-]+\\.[A-Z]{2,}'`;

const RAW_LEGACY_MEDIA_QUERY = `
  WITH approved_media_variant AS (
    SELECT media.id AS media_object_id, variant.public_cdn_url AS url
      FROM platform.media_variants variant
      JOIN platform.media_objects media ON media.id = variant.media_object_id
     WHERE variant.visibility = 'public'
       AND variant.public_cdn_url IS NOT NULL
       AND media.visibility = 'public'
       AND media.public_approved = TRUE
       AND media.lifecycle_status = 'active'
       AND media.deleted_at IS NULL
  ), invalid_catalog_assignment AS (
    SELECT assignment.id
      FROM hotel_catalog.property_media assignment
      LEFT JOIN platform.media_objects media
        ON media.id = assignment.platform_media_object_id
       AND media.property_id = assignment.property_id
     WHERE assignment.platform_media_object_id IS NULL
        OR assignment.url <> 'platform-media:' || assignment.platform_media_object_id::text
        OR assignment.public_approved IS NOT TRUE
        OR media.id IS NULL
        OR media.visibility <> 'public'
        OR media.public_approved IS NOT TRUE
        OR media.lifecycle_status <> 'active'
        OR media.deleted_at IS NOT NULL
        OR NOT EXISTS (
          SELECT 1
            FROM approved_media_variant approved
           WHERE approved.media_object_id = assignment.platform_media_object_id
        )
  ), referenced_url AS (
    SELECT 'identity.users' AS source, id::text AS id, profile_picture_url AS url
      FROM identity.users
     WHERE profile_picture_url IS NOT NULL
    UNION ALL
    SELECT 'pms.message_attachments', id::text, source_url
      FROM pms.message_attachments
     WHERE source_url IS NOT NULL
    UNION ALL
    SELECT 'booking.booking_settings', property_id::text, hero_image_url
      FROM booking.booking_settings
     WHERE hero_image_url IS NOT NULL
    UNION ALL
    SELECT 'marketplace.creator_profiles', id::text, profile_picture_url
      FROM marketplace.creator_profiles
     WHERE profile_picture_url IS NOT NULL
    UNION ALL
    SELECT 'marketplace.marketplace_offers', offer.id::text, image.url
      FROM marketplace.marketplace_offers offer
      CROSS JOIN LATERAL unnest(offer.image_urls) AS image(url)
    UNION ALL
    SELECT 'marketplace.marketplace_offer_read_model', offer.offer_id::text, image.url
      FROM marketplace.marketplace_offer_read_model offer
      CROSS JOIN LATERAL unnest(offer.image_urls) AS image(url)
    UNION ALL
    SELECT 'pms.room_types', room.id::text, item.value #>> '{}'
      FROM pms.room_types room
      CROSS JOIN LATERAL jsonb_path_query(room.media_snapshot, '$.** ? (@.type() == "string")') AS item(value)
     WHERE item.value #>> '{}' ~* '^https?://'
    UNION ALL
    SELECT 'hotel_catalog.property_public_profile_read_model', profile.property_id::text,
           item.value #>> '{}'
      FROM hotel_catalog.property_public_profile_read_model profile
      CROSS JOIN LATERAL jsonb_path_query(profile.media, '$.** ? (@.type() == "string")') AS item(value)
     WHERE item.value #>> '{}' ~* '^https?://'
    UNION ALL
    SELECT 'distribution.public_hotel_bookability_profiles', profile.property_id::text,
           item.value #>> '{}'
      FROM distribution.public_hotel_bookability_profiles profile
      CROSS JOIN LATERAL jsonb_path_query(profile.media, '$.** ? (@.type() == "string")') AS item(value)
     WHERE item.value #>> '{}' ~* '^https?://'
    UNION ALL
    SELECT 'distribution.public_room_offer_snapshots', offer.id::text, item.value #>> '{}'
      FROM distribution.public_room_offer_snapshots offer
      CROSS JOIN LATERAL jsonb_path_query(
        jsonb_build_array(offer.room_summary, offer.rate_summary, offer.public_policy),
        '$.** ? (@.type() == "string")'
      ) AS item(value)
     WHERE item.value #>> '{}' ~* '^https?://'
    UNION ALL
    SELECT 'distribution.public_booking_content_revisions', revision.id::text, item.value #>> '{}'
      FROM distribution.public_booking_content_revisions revision
      CROSS JOIN LATERAL jsonb_path_query(
        revision.public_content,
        '$.** ? (@.type() == "string")'
      ) AS item(value)
     WHERE item.value #>> '{}' ~* '^https?://'
  )
  SELECT (
    (SELECT count(*) FROM invalid_catalog_assignment)
    +
    (SELECT count(*)
       FROM referenced_url reference
      WHERE reference.url IS NOT NULL
        AND NOT EXISTS (
          SELECT 1 FROM approved_media_variant approved WHERE approved.url = reference.url
        ))
  )::text AS count`;
