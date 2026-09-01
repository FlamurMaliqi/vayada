import { createHash } from "node:crypto";

import pg from "pg";

import {
  DatabaseAttestationError,
  readDatabaseAttestationTable,
  resolveDatabaseAttestation,
} from "./databaseAttestation.js";
import { normalizePgConnectionString } from "./pgConnection.js";
import {
  runProductionBookingMigration,
  type ProductionBookingMigrationReport,
} from "./productionBookingMigration.js";
import {
  runProductionCatalogPrerequisites,
  runProductionCatalogMigration,
  type ProductionCatalogMigrationReport,
} from "./productionCatalogMigration.js";
import {
  runProductionMediaMigration,
  type ProductionMediaMigrationConfig,
} from "./productionMediaMigration.js";
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
  runProductionParity,
  type ProductionParityDecision,
  type ProductionParityReport,
  type SourceExtractionEnvironment,
} from "./productionParity.js";
import {
  runProductionPmsMigration,
  type ProductionPmsMigrationReport,
} from "./productionPmsMigration.js";
import { MIGRATION_ENVIRONMENTS, runMigrations, type MigrationEnvironment } from "./runner.js";
import {
  buildSourceExtractionPlan,
  runSourceExtraction,
  type SourceExtractionConfig,
} from "./sourceExtraction.js";
import { stableJson } from "./productionIdentitySourceValidation.js";
import { SOURCE_DATABASES, type SourceDatabase } from "./sourceInventory.js";

export const PRODUCTION_CUTOVER_LOCK_ID = 1_360_001;
export const PRODUCTION_CUTOVER_STEPS = [
  "schema_migrations",
  "source_extraction",
  "identity",
  "catalog",
  "booking",
  "pms",
  "marketplace",
  "finance",
  "parity",
  "smoke_evidence",
] as const;

export type ProductionCutoverMode = "staging_rehearsal" | "cutover_dry_run" | "production_cutover";
export type ProductionCutoverStep = (typeof PRODUCTION_CUTOVER_STEPS)[number];
export type ProductionCutoverStatus =
  | "running"
  | "awaiting_smoke"
  | "failed"
  | "aborted"
  | "completed";

export type ProductionCutoverConfig = {
  connectionString: string;
  migrationsDir: string;
  mode: ProductionCutoverMode;
  runId: string;
  sourceRunId: string;
  sourceTags: Record<SourceDatabase, string>;
  sourceEnvironment: SourceExtractionEnvironment;
  environment: MigrationEnvironment;
  applicationRelease: string;
  runtimeApplicationRelease: string;
  operator: string;
  targetCleanProofSha256: string;
  freezeProofSha256: string;
  smokeReport?: unknown;
  backupProofSha256?: string;
  approvedRunId?: string;
  approvedReportChecksumSha256?: string;
  approvedRunReport?: unknown;
  approvedParityDecision?: ProductionParityDecision;
  approvalProofSha256?: string;
  approvalReport?: unknown;
  confirmation?: string;
  resume?: boolean;
  sourceExtraction: SourceExtractionConfig;
  sourceConnectionStrings: Record<SourceDatabase, string>;
  media: Omit<ProductionMediaMigrationConfig, "connectionString" | "sourceRunId" | "mode">;
};

type DomainReport =
  | ProductionIdentityMigrationReport
  | ProductionCatalogMigrationReport
  | ProductionBookingMigrationReport
  | ProductionPmsMigrationReport
  | ProductionMarketplaceMigrationReport
  | ProductionFinanceMigrationReport;

export type ProductionCutoverStepResult = {
  checksumSha256: string;
  parityDecision?: ProductionParityDecision;
  parityReportChecksumSha256?: string;
  smokeProofSha256?: string;
};

export type ProductionCutoverStepContext = {
  targetIdentitySha256: string;
  parityReportChecksumSha256: string;
};

export type ProductionCutoverServices = {
  schema: (config: ProductionCutoverConfig) => Promise<ProductionCutoverStepResult>;
  extraction: (config: ProductionCutoverConfig) => Promise<ProductionCutoverStepResult>;
  domain: (
    domain: Exclude<
      ProductionCutoverStep,
      "schema_migrations" | "source_extraction" | "parity" | "smoke_evidence"
    >,
    config: ProductionCutoverConfig,
  ) => Promise<ProductionCutoverStepResult>;
  parity: (config: ProductionCutoverConfig) => Promise<ProductionCutoverStepResult>;
  smokeEvidence: (
    config: ProductionCutoverConfig,
    context: ProductionCutoverStepContext,
  ) => Promise<ProductionCutoverStepResult>;
};

export type ProductionCutoverReport = {
  contractVersion: "production-cutover-orchestration.v1";
  runId: string;
  mode: ProductionCutoverMode;
  sourceRunId: string;
  sourceEnvironment: SourceExtractionEnvironment;
  environment: MigrationEnvironment;
  applicationRelease: string;
  targetIdentitySha256: string;
  configSha256: string;
  operator: "[REDACTED]";
  operatorSha256: string;
  abortOperatorSha256: string | null;
  sourceTags: Record<SourceDatabase, { sha256: string }>;
  guards: {
    targetCleanProofSha256: string;
    freezeProofSha256: string;
    smokeProofSha256: string | null;
    backupProofSha256: string | null;
    approvedRunId: string | null;
    approvedReportChecksumSha256: string | null;
    approvedRunEvidenceSha256: string | null;
    approvedParityDecision: ProductionParityDecision | null;
    approvalProofSha256: string | null;
  };
  status: ProductionCutoverStatus;
  legacyAuthority: "legacy";
  currentStep: string | null;
  lastSafeCheckpoint: string | null;
  parityDecision: ProductionParityDecision | null;
  parityReportChecksumSha256: string | null;
  failureCode: string | null;
  steps: Array<{
    name: string;
    status: "pending" | "running" | "completed" | "failed";
    safeCheckpoint: boolean;
    attemptCount: number;
    outputSha256: string | null;
    failureCode: string | null;
  }>;
  evidenceChecksumSha256: string;
};

export type ProductionMigrationStatusReport = {
  contractVersion: "production-migration-status.v1";
  migrations: Array<{
    version: string;
    name: string;
    checksumSha256: string;
    environment: MigrationEnvironment;
    status: "applied";
    appliedAt: string;
  }>;
  latestRehearsal: ProductionCutoverReport | null;
  runs: ProductionCutoverReport[];
};

type RunRow = {
  runId: string;
  mode: ProductionCutoverMode;
  sourceRunId: string;
  sourceEnvironment: SourceExtractionEnvironment;
  environment: MigrationEnvironment;
  applicationRelease: string;
  targetIdentitySha256: string;
  operatorSha256: string;
  abortOperatorSha256: string | null;
  sourceTagsSha256: Record<SourceDatabase, string>;
  configSha256: string;
  targetCleanProofSha256: string;
  freezeProofSha256: string;
  smokeProofSha256: string | null;
  backupProofSha256: string | null;
  approvedRunId: string | null;
  approvedReportChecksumSha256: string | null;
  approvedRunEvidenceSha256: string | null;
  approvedParityDecision: ProductionParityDecision | null;
  approvalProofSha256: string | null;
  status: ProductionCutoverStatus;
  currentStep: string | null;
  lastSafeCheckpoint: string | null;
  parityDecision: ProductionParityDecision | null;
  parityReportChecksumSha256: string | null;
  failureCode: string | null;
};

type StepRow = {
  stepOrder: number;
  stepName: string;
  status: "pending" | "running" | "completed" | "failed";
  safeCheckpoint: boolean;
  attemptCount: number;
  outputSha256: string | null;
  failureCode: string | null;
};

type TargetCutoverAttestation = {
  environment: MigrationEnvironment;
  targetIdentitySha256: string;
  cleanRunId: string;
  cleanProofSha256: string;
  applicationRelease: string;
  backupProofSha256: string | null;
};

export type ProductionCutoverSmokeReport = {
  contractVersion: "production-cutover-smoke.v1";
  runId: string;
  targetIdentitySha256: string;
  environment: MigrationEnvironment;
  applicationRelease: string;
  sourceRunId: string;
  sourceTags: Record<SourceDatabase, { sha256: string }>;
  parityReportChecksumSha256: string;
  status: "passed";
  checks: Array<{ name: string; status: "passed"; evidenceSha256: string }>;
  evidenceChecksumSha256: string;
};

export type ProductionCutoverApprovalReport = {
  contractVersion: "production-cutover-approval.v1";
  productionRunId: string;
  targetIdentitySha256: string;
  backupProofSha256: string;
  applicationRelease: string;
  sourceRunId: string;
  sourceTags: Record<SourceDatabase, { sha256: string }>;
  freezeProofSha256: string;
  approvedRunId: string;
  approvedRunEvidenceSha256: string;
  parityReportChecksumSha256: string;
  decision: "go";
  approverSha256: string;
  approvedAt: string;
  evidenceChecksumSha256: string;
};

export const TARGET_CUTOVER_ATTESTATION_SQL = `
WITH database_settings AS (
  SELECT unnest(settings.setconfig) AS setting
  FROM pg_catalog.pg_db_role_setting settings
  WHERE settings.setdatabase = (
    SELECT database.oid
    FROM pg_catalog.pg_database database
    WHERE database.datname = current_database()
  )
    AND settings.setrole = 0
)
SELECT
  max(substring(setting FROM length('vayada.target_environment=') + 1))
    FILTER (WHERE setting LIKE 'vayada.target_environment=%') AS environment,
  max(substring(setting FROM length('vayada.target_identity_sha256=') + 1))
    FILTER (WHERE setting LIKE 'vayada.target_identity_sha256=%') AS "targetIdentitySha256",
  max(substring(setting FROM length('vayada.target_clean_run_id=') + 1))
    FILTER (WHERE setting LIKE 'vayada.target_clean_run_id=%') AS "cleanRunId",
  max(substring(setting FROM length('vayada.target_clean_proof_sha256=') + 1))
    FILTER (WHERE setting LIKE 'vayada.target_clean_proof_sha256=%') AS "cleanProofSha256",
  max(substring(setting FROM length('vayada.target_application_release=') + 1))
    FILTER (WHERE setting LIKE 'vayada.target_application_release=%') AS "applicationRelease",
  max(substring(setting FROM length('vayada.target_backup_proof_sha256=') + 1))
    FILTER (WHERE setting LIKE 'vayada.target_backup_proof_sha256=%') AS "backupProofSha256"
FROM database_settings`;

const TARGET_ATTESTATION_KEYS = {
  environment: "vayada.target_environment",
  targetIdentitySha256: "vayada.target_identity_sha256",
  cleanRunId: "vayada.target_clean_run_id",
  cleanProofSha256: "vayada.target_clean_proof_sha256",
  applicationRelease: "vayada.target_application_release",
  backupProofSha256: "vayada.target_backup_proof_sha256",
} as const;

export class ProductionCutoverError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "ProductionCutoverError";
  }
}

const defaultServices: ProductionCutoverServices = {
  schema: async (config) => {
    const result = await runMigrations({
      connectionString: config.connectionString,
      migrationsDir: config.migrationsDir,
      environment: config.environment,
      appliedBy: config.operator,
      gitSha: config.applicationRelease,
    });
    if (result.failed)
      throw new ProductionCutoverError("SCHEMA_MIGRATION_FAILED", "Target migration failed");
    return checkedResult({ applied: result.applied, skipped: result.skipped });
  },
  extraction: async (config) => {
    const plan = buildSourceExtractionPlan(config.sourceExtraction);
    if (plan.runId !== config.sourceRunId)
      throw new ProductionCutoverError(
        "SOURCE_RUN_MISMATCH",
        "Source extraction manifest does not match the approved run",
      );
    const target = new pg.Client({
      connectionString: normalizePgConnectionString(config.connectionString),
    });
    const sources = {} as Record<SourceDatabase, pg.Client>;
    try {
      await target.connect();
      for (const database of SOURCE_DATABASES) {
        const source = new pg.Client({
          connectionString: normalizePgConnectionString(config.sourceConnectionStrings[database]),
        });
        sources[database] = source;
        await source.connect();
      }
      const report = await runSourceExtraction(config.sourceExtraction, target, sources);
      if (report.runId !== config.sourceRunId || report.status !== "completed")
        throw new ProductionCutoverError(
          "SOURCE_EXTRACTION_INCOMPLETE",
          "Source extraction did not complete",
        );
      return checkedResult({
        runId: report.runId,
        sourceChecksums: report.sources.map((row) => [row.sourceDatabase, row.checksumSha256]),
      });
    } finally {
      await Promise.all([
        target.end().catch(() => undefined),
        ...Object.values(sources).map((source) => source.end().catch(() => undefined)),
      ]);
    }
  },
  domain: async (domain, config) => {
    const input = {
      connectionString: config.connectionString,
      sourceRunId: config.sourceRunId,
      mode: "apply" as const,
    };
    if (domain === "catalog") {
      const prerequisite = await runProductionCatalogPrerequisites(input);
      if (!prerequisite.applied || prerequisite.blockers.length > 0)
        throw new ProductionCutoverError(
          "DOMAIN_MIGRATION_BLOCKED",
          "catalog prerequisite migration did not apply",
        );
      const media = await runProductionMediaMigration({
        ...config.media,
        ...input,
      });
      if (!media.applied || media.blockers.length > 0)
        throw new ProductionCutoverError(
          "DOMAIN_MIGRATION_BLOCKED",
          "media migration did not apply",
        );
      const catalog = await runProductionCatalogMigration(input);
      if (!catalog.applied || catalog.blockers.length > 0)
        throw new ProductionCutoverError(
          "DOMAIN_MIGRATION_BLOCKED",
          "catalog migration did not apply",
        );
      return checkedResult({
        prerequisiteChecksum: prerequisite.checksum,
        mediaChecksum: media.checksum,
        catalogChecksum: catalog.checksum,
      });
    }
    const runners: Record<Exclude<typeof domain, "catalog">, () => Promise<DomainReport>> = {
      identity: () => runProductionIdentityMigration(input),
      booking: () => runProductionBookingMigration(input),
      pms: () =>
        runProductionPmsMigration({
          ...input,
          applyConfirmation: `production-pms:${config.sourceRunId}`,
        }),
      marketplace: () =>
        runProductionMarketplaceMigration({
          ...input,
          applyConfirmation: `production-marketplace:${config.sourceRunId}`,
        }),
      finance: () =>
        runProductionFinanceMigration({
          ...input,
          applyConfirmation: `production-finance:${config.sourceRunId}`,
        }),
    };
    const report = await runners[domain]();
    if (!report.applied || report.blockers.length > 0)
      throw new ProductionCutoverError(
        "DOMAIN_MIGRATION_BLOCKED",
        `${domain} migration did not apply`,
      );
    return { checksumSha256: report.checksum };
  },
  parity: async (config) => {
    const report: ProductionParityReport = await runProductionParity({
      connectionString: config.connectionString,
      sourceRunId: config.sourceRunId,
      sourceTags: config.sourceTags,
      sourceEnvironment: config.sourceEnvironment,
      environment: config.environment,
      applicationRelease: config.applicationRelease,
      runtimeApplicationRelease: config.runtimeApplicationRelease,
      operator: config.operator,
      warningBudget: 0,
      migrationsDir: config.migrationsDir,
      targetMediaBucket: config.media.targetBucket,
      mediaCdnBaseUrl: config.media.cdnBaseUrl,
    });
    if (report.decision !== "go")
      throw new ProductionCutoverError("PARITY_NOT_GO", "Migration parity did not return GO");
    return {
      checksumSha256: report.reportChecksumSha256,
      parityDecision: report.decision,
      parityReportChecksumSha256: report.reportChecksumSha256,
    };
  },
  smokeEvidence: async (config, context) => validateSmokeReport(config, context),
};

export function validateProductionCutoverConfig(config: ProductionCutoverConfig): void {
  if (!/^vay1360-[0-9a-f]{24}$/.test(config.runId))
    throw new ProductionCutoverError("INVALID_RUN_ID", "runId is invalid");
  if (!/^vay1351-[0-9a-f]{24}$/.test(config.sourceRunId))
    throw new ProductionCutoverError("INVALID_SOURCE_RUN_ID", "sourceRunId is invalid");
  const requiredEnvironment = {
    staging_rehearsal: ["staging", "staging"],
    cutover_dry_run: ["preprod", "preprod"],
    production_cutover: ["production", "preprod"],
  }[config.mode];
  if (
    config.environment !== requiredEnvironment[0] ||
    config.sourceEnvironment !== requiredEnvironment[1]
  )
    throw new ProductionCutoverError(
      "ENVIRONMENT_GUARD_FAILED",
      `${config.mode} environment pairing is invalid`,
    );
  if (!/^[0-9a-f]{40}$/.test(config.applicationRelease))
    throw new ProductionCutoverError(
      "INVALID_APPLICATION_RELEASE",
      "Application release must be a full Git SHA",
    );
  if (config.runtimeApplicationRelease !== config.applicationRelease)
    throw new ProductionCutoverError(
      "RELEASE_ATTESTATION_MISMATCH",
      "Application release does not match runtime metadata",
    );
  if (!config.operator.trim())
    throw new ProductionCutoverError("MISSING_OPERATOR", "Operator is required");
  validateMediaConfig(config.media);
  if (!isSha256(config.targetCleanProofSha256))
    throw new ProductionCutoverError(
      "MISSING_TARGET_CLEAN_PROOF",
      "Clean target proof is required",
    );
  if (!isSha256(config.freezeProofSha256))
    throw new ProductionCutoverError("MISSING_FREEZE_PROOF", "Freeze proof is required");
  for (const database of SOURCE_DATABASES)
    if (!config.sourceTags[database]?.trim())
      throw new ProductionCutoverError("MISSING_SOURCE_TAG", `${database} source tag is required`);
  validateSourceEvidence(config);
  const expectedConfirmation = {
    staging_rehearsal: `STAGING_REHEARSAL:${config.runId}:${config.sourceRunId}`,
    cutover_dry_run: `CUTOVER_DRY_RUN:${config.runId}:${config.sourceRunId}`,
    production_cutover: `PRODUCTION_CUTOVER:${config.runId}:${config.sourceRunId}`,
  }[config.mode];
  if (config.confirmation !== expectedConfirmation)
    throw new ProductionCutoverError(
      "CONFIRMATION_GUARD_FAILED",
      "Confirmation guard does not match this run",
    );
  if (config.mode === "production_cutover") {
    if (!isSha256(config.backupProofSha256))
      throw new ProductionCutoverError("MISSING_BACKUP_PROOF", "Backup proof is required");
    if (!/^vay1360-[0-9a-f]{24}$/.test(config.approvedRunId ?? ""))
      throw new ProductionCutoverError("MISSING_APPROVED_RUN", "Approved run is required");
    if (config.approvedRunId === config.runId)
      throw new ProductionCutoverError(
        "INVALID_APPROVED_RUN",
        "Production run cannot approve itself",
      );
    if (!isSha256(config.approvedReportChecksumSha256))
      throw new ProductionCutoverError(
        "MISSING_APPROVED_REPORT",
        "Approved report checksum is required",
      );
    if (config.approvedParityDecision !== "go")
      throw new ProductionCutoverError(
        "APPROVED_REPORT_NOT_GO",
        "Approved parity report must have a GO decision",
      );
    if (!isSha256(config.approvalProofSha256))
      throw new ProductionCutoverError("MISSING_APPROVAL_PROOF", "Approval proof is required");
    const approvedRunEvidenceSha256 = validateApprovedRunReport(config);
    validateApprovalReport(config, approvedRunEvidenceSha256);
  }
}

function validateMediaConfig(config: ProductionCutoverConfig["media"]): void {
  const validBucket = (value: unknown) =>
    typeof value === "string" && /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(value);
  if (!config || typeof config !== "object")
    throw new ProductionCutoverError(
      "INVALID_MEDIA_CONFIGURATION",
      "Platform media bucket, CDN, and reviewed legacy bucket allowlist are required",
    );
  let validCdn = false;
  try {
    const cdn = new URL(config.cdnBaseUrl);
    validCdn =
      cdn.protocol === "https:" &&
      !cdn.username &&
      !cdn.password &&
      cdn.pathname === "/" &&
      !cdn.search &&
      !cdn.hash &&
      !/(^|\.)s3(?:[.-][a-z0-9-]+)?\.amazonaws\.com$/i.test(cdn.hostname);
  } catch {
    validCdn = false;
  }
  if (
    !validBucket(config.targetBucket) ||
    !validBucket(config.legacyPmsBucket) ||
    !Array.isArray(config.allowedLegacyBuckets) ||
    config.allowedLegacyBuckets.length === 0 ||
    config.allowedLegacyBuckets.some((bucket) => !validBucket(bucket)) ||
    !config.allowedLegacyBuckets.includes(config.legacyPmsBucket) ||
    !validCdn
  )
    throw new ProductionCutoverError(
      "INVALID_MEDIA_CONFIGURATION",
      "Platform media bucket, CDN, and reviewed legacy bucket allowlist are required",
    );
}

function validateSourceEvidence(config: ProductionCutoverConfig): void {
  try {
    const plan = buildSourceExtractionPlan(config.sourceExtraction);
    if (
      plan.runId !== config.sourceRunId ||
      plan.environment !== config.sourceEnvironment ||
      config.sourceExtraction.cutoverFreezeProofSha256 !== config.freezeProofSha256 ||
      plan.sources.some(
        (source) => source.snapshotIdentifier !== config.sourceTags[source.sourceDatabase],
      )
    )
      throw new Error("source binding mismatch");
  } catch {
    throw new ProductionCutoverError(
      "SOURCE_EVIDENCE_MISMATCH",
      "Reviewed source evidence does not match this cutover run",
    );
  }
}

function validateApprovedRunReport(config: ProductionCutoverConfig): string {
  if (!config.approvedRunReport || typeof config.approvedRunReport !== "object")
    throw new ProductionCutoverError(
      "MISSING_APPROVED_RUN_EVIDENCE",
      "Approved dry-run report is required",
    );
  const report = config.approvedRunReport as Record<string, unknown>;
  const sourceTags = report["sourceTags"] as Record<string, unknown> | undefined;
  const guards = report["guards"] as Record<string, unknown> | undefined;
  const steps = report["steps"];
  const bindingMatches =
    report["contractVersion"] === "production-cutover-orchestration.v1" &&
    report["runId"] === config.approvedRunId &&
    report["mode"] === "cutover_dry_run" &&
    report["status"] === "completed" &&
    report["legacyAuthority"] === "legacy" &&
    report["sourceRunId"] === config.sourceRunId &&
    report["sourceEnvironment"] === "preprod" &&
    report["environment"] === "preprod" &&
    report["applicationRelease"] === config.applicationRelease &&
    report["parityDecision"] === "go" &&
    report["parityReportChecksumSha256"] === config.approvedReportChecksumSha256 &&
    report["failureCode"] === null &&
    report["currentStep"] === null &&
    report["lastSafeCheckpoint"] === "smoke_evidence" &&
    guards?.["freezeProofSha256"] === config.freezeProofSha256 &&
    isSha256(guards?.["targetCleanProofSha256"]) &&
    isSha256(guards?.["smokeProofSha256"]) &&
    SOURCE_DATABASES.every(
      (database) =>
        (sourceTags?.[database] as Record<string, unknown> | undefined)?.["sha256"] ===
        sha256(config.sourceTags[database]),
    );
  if (!bindingMatches)
    throw new ProductionCutoverError(
      "APPROVED_RUN_EVIDENCE_MISMATCH",
      "Approved dry-run report does not match this production run",
    );
  if (
    !isSha256(report["targetIdentitySha256"]) ||
    !isSha256(report["configSha256"]) ||
    !isSha256(report["operatorSha256"]) ||
    report["abortOperatorSha256"] !== null ||
    !Array.isArray(steps) ||
    steps.length !== PRODUCTION_CUTOVER_STEPS.length ||
    !steps.every((step, index) => {
      if (!step || typeof step !== "object") return false;
      const row = step as Record<string, unknown>;
      return (
        row["name"] === PRODUCTION_CUTOVER_STEPS[index] &&
        row["status"] === "completed" &&
        row["safeCheckpoint"] === true &&
        typeof row["attemptCount"] === "number" &&
        row["attemptCount"] >= 1 &&
        isSha256(row["outputSha256"]) &&
        row["failureCode"] === null
      );
    })
  )
    throw new ProductionCutoverError(
      "INVALID_APPROVED_RUN_EVIDENCE",
      "Approved dry-run report is incomplete",
    );
  const parityStep = steps.find(
    (step) =>
      step && typeof step === "object" && (step as Record<string, unknown>)["name"] === "parity",
  ) as Record<string, unknown> | undefined;
  const smokeStep = steps.find(
    (step) =>
      step &&
      typeof step === "object" &&
      (step as Record<string, unknown>)["name"] === "smoke_evidence",
  ) as Record<string, unknown> | undefined;
  if (
    parityStep?.["outputSha256"] !== report["parityReportChecksumSha256"] ||
    smokeStep?.["outputSha256"] !== guards?.["smokeProofSha256"]
  )
    throw new ProductionCutoverError(
      "INVALID_APPROVED_RUN_EVIDENCE",
      "Approved dry-run report has inconsistent step evidence",
    );
  const evidenceChecksum = report["evidenceChecksumSha256"];
  const { contractVersion, operator, evidenceChecksumSha256, ...material } = report;
  void contractVersion;
  void operator;
  void evidenceChecksumSha256;
  if (!isSha256(evidenceChecksum) || sha256(stableJson(material)) !== evidenceChecksum)
    throw new ProductionCutoverError(
      "INVALID_APPROVED_RUN_EVIDENCE",
      "Approved dry-run report checksum is invalid",
    );
  return evidenceChecksum;
}

function validateApprovalReport(
  config: ProductionCutoverConfig,
  approvedRunEvidenceSha256: string,
  targetIdentitySha256?: string,
): string {
  if (!config.approvalReport || typeof config.approvalReport !== "object")
    throw new ProductionCutoverError(
      "MISSING_APPROVAL_EVIDENCE",
      "Structured production approval report is required",
    );
  const report = config.approvalReport as Record<string, unknown>;
  const sourceTags = report["sourceTags"] as Record<string, unknown> | undefined;
  const approvedAt = report["approvedAt"];
  const approvedAtDate = typeof approvedAt === "string" ? new Date(approvedAt) : null;
  if (
    report["contractVersion"] !== "production-cutover-approval.v1" ||
    report["productionRunId"] !== config.runId ||
    !isSha256(report["targetIdentitySha256"]) ||
    (targetIdentitySha256 !== undefined &&
      report["targetIdentitySha256"] !== targetIdentitySha256) ||
    report["backupProofSha256"] !== config.backupProofSha256 ||
    report["applicationRelease"] !== config.applicationRelease ||
    report["sourceRunId"] !== config.sourceRunId ||
    report["freezeProofSha256"] !== config.freezeProofSha256 ||
    !SOURCE_DATABASES.every(
      (database) =>
        (sourceTags?.[database] as Record<string, unknown> | undefined)?.["sha256"] ===
        sha256(config.sourceTags[database]),
    ) ||
    report["approvedRunId"] !== config.approvedRunId ||
    report["approvedRunEvidenceSha256"] !== approvedRunEvidenceSha256 ||
    report["parityReportChecksumSha256"] !== config.approvedReportChecksumSha256 ||
    report["decision"] !== "go" ||
    !isSha256(report["approverSha256"]) ||
    !approvedAtDate ||
    Number.isNaN(approvedAtDate.valueOf()) ||
    approvedAtDate.toISOString() !== approvedAt
  )
    throw new ProductionCutoverError(
      "APPROVAL_EVIDENCE_MISMATCH",
      "Production approval report does not match the approved dry-run evidence",
    );
  const evidenceChecksum = report["evidenceChecksumSha256"];
  const { evidenceChecksumSha256, ...material } = report;
  void evidenceChecksumSha256;
  if (
    !isSha256(evidenceChecksum) ||
    evidenceChecksum !== config.approvalProofSha256 ||
    sha256(stableJson(material)) !== evidenceChecksum
  )
    throw new ProductionCutoverError(
      "INVALID_APPROVAL_EVIDENCE",
      "Production approval report checksum is invalid",
    );
  return evidenceChecksum;
}

async function readTargetCutoverAttestation(
  client: pg.Client,
  config: ProductionCutoverConfig,
): Promise<TargetCutoverAttestation> {
  const result = await client.query<Partial<TargetCutoverAttestation>>(
    TARGET_CUTOVER_ATTESTATION_SQL,
  );
  const settings = result.rows[0] ?? {};
  let resolved: Record<string, string | null>;
  try {
    const table = await readDatabaseAttestationTable(client);
    resolved = resolveDatabaseAttestation(
      {
        [TARGET_ATTESTATION_KEYS.environment]: settings.environment ?? null,
        [TARGET_ATTESTATION_KEYS.targetIdentitySha256]: settings.targetIdentitySha256 ?? null,
        [TARGET_ATTESTATION_KEYS.cleanRunId]: settings.cleanRunId ?? null,
        [TARGET_ATTESTATION_KEYS.cleanProofSha256]: settings.cleanProofSha256 ?? null,
        [TARGET_ATTESTATION_KEYS.applicationRelease]: settings.applicationRelease ?? null,
        [TARGET_ATTESTATION_KEYS.backupProofSha256]: settings.backupProofSha256 ?? null,
      },
      table,
      Object.values(TARGET_ATTESTATION_KEYS),
    );
  } catch (error) {
    if (error instanceof DatabaseAttestationError) {
      throw new ProductionCutoverError(
        error.code === "DISAGREEMENT"
          ? "TARGET_ATTESTATION_DISAGREEMENT"
          : "UNTRUSTED_TARGET_ATTESTATION",
        "Target database attestation is not trustworthy",
      );
    }
    throw error;
  }
  const attestation = {
    environment: resolved[TARGET_ATTESTATION_KEYS.environment],
    targetIdentitySha256: resolved[TARGET_ATTESTATION_KEYS.targetIdentitySha256],
    cleanRunId: resolved[TARGET_ATTESTATION_KEYS.cleanRunId],
    cleanProofSha256: resolved[TARGET_ATTESTATION_KEYS.cleanProofSha256],
    applicationRelease: resolved[TARGET_ATTESTATION_KEYS.applicationRelease],
    backupProofSha256: resolved[TARGET_ATTESTATION_KEYS.backupProofSha256],
  };
  if (
    !isSha256(attestation.targetIdentitySha256) ||
    attestation.environment !== config.environment ||
    attestation.cleanRunId !== config.runId ||
    attestation.cleanProofSha256 !== config.targetCleanProofSha256 ||
    attestation.applicationRelease !== config.applicationRelease ||
    (config.mode === "production_cutover" &&
      attestation.backupProofSha256 !== config.backupProofSha256)
  )
    throw new ProductionCutoverError(
      "TARGET_ATTESTATION_MISMATCH",
      "Target database attestation does not match this cutover run",
    );
  return attestation as TargetCutoverAttestation;
}

function validateSmokeReport(
  config: ProductionCutoverConfig,
  context: ProductionCutoverStepContext,
): ProductionCutoverStepResult {
  if (!config.smokeReport || typeof config.smokeReport !== "object")
    throw new ProductionCutoverError("MISSING_SMOKE_REPORT", "Smoke report is required");
  const report = config.smokeReport as Record<string, unknown>;
  const sourceTags = report["sourceTags"] as Record<string, unknown> | undefined;
  const checks = report["checks"];
  if (
    report["contractVersion"] !== "production-cutover-smoke.v1" ||
    report["runId"] !== config.runId ||
    report["targetIdentitySha256"] !== context.targetIdentitySha256 ||
    report["environment"] !== config.environment ||
    report["applicationRelease"] !== config.applicationRelease ||
    report["sourceRunId"] !== config.sourceRunId ||
    report["parityReportChecksumSha256"] !== context.parityReportChecksumSha256 ||
    report["status"] !== "passed" ||
    !SOURCE_DATABASES.every(
      (database) =>
        (sourceTags?.[database] as Record<string, unknown> | undefined)?.["sha256"] ===
        sha256(config.sourceTags[database]),
    )
  )
    throw new ProductionCutoverError(
      "SMOKE_REPORT_MISMATCH",
      "Smoke report does not match this cutover run",
    );
  if (
    !Array.isArray(checks) ||
    checks.length === 0 ||
    !checks.every((check) => {
      if (!check || typeof check !== "object") return false;
      const row = check as Record<string, unknown>;
      return (
        typeof row["name"] === "string" &&
        row["name"].trim().length > 0 &&
        row["status"] === "passed" &&
        isSha256(row["evidenceSha256"])
      );
    })
  )
    throw new ProductionCutoverError("INVALID_SMOKE_REPORT", "Smoke report is incomplete");
  const evidenceChecksum = report["evidenceChecksumSha256"];
  const { evidenceChecksumSha256, ...material } = report;
  void evidenceChecksumSha256;
  if (!isSha256(evidenceChecksum) || sha256(stableJson(material)) !== evidenceChecksum)
    throw new ProductionCutoverError("INVALID_SMOKE_REPORT", "Smoke report checksum is invalid");
  return { checksumSha256: evidenceChecksum, smokeProofSha256: evidenceChecksum };
}

export async function runProductionCutover(
  config: ProductionCutoverConfig,
  services: ProductionCutoverServices = defaultServices,
): Promise<ProductionCutoverReport> {
  validateProductionCutoverConfig(config);
  const client = new pg.Client({
    connectionString: normalizePgConnectionString(config.connectionString),
  });
  await client.connect();
  let locked = false;
  try {
    const targetAttestation = await readTargetCutoverAttestation(client, config);
    if (config.mode === "production_cutover") {
      const approvedRunEvidenceSha256 = validateApprovedRunReport(config);
      validateApprovalReport(
        config,
        approvedRunEvidenceSha256,
        targetAttestation.targetIdentitySha256,
      );
    }
    const lock = await client.query<{ acquired: boolean }>(
      "SELECT pg_try_advisory_lock($1) AS acquired",
      [PRODUCTION_CUTOVER_LOCK_ID],
    );
    if (!lock.rows[0]?.acquired)
      throw new ProductionCutoverError("CUTOVER_LOCKED", "Another cutover run is active");
    locked = true;

    const table = await client.query<{ present: boolean }>(
      "SELECT to_regclass('platform.production_cutover_runs') IS NOT NULL AS present",
    );
    let bootstrappedSchema: ProductionCutoverStepResult | undefined;
    if (!table.rows[0]?.present) bootstrappedSchema = await services.schema(config);

    const created = await initializeRun(client, config, targetAttestation, bootstrappedSchema);
    const existing = await readRun(client, config.runId);
    if (!existing) throw new ProductionCutoverError("RUN_STATE_MISSING", "Run state is missing");
    if (existing.status === "completed")
      return await persistProductionCutoverEvidence(client, config.runId);
    if (existing.status === "aborted")
      throw new ProductionCutoverError("RUN_ABORTED", "An aborted run cannot resume");
    if (existing.status === "failed" && !config.resume)
      throw new ProductionCutoverError("RESUME_REQUIRED", "Failed run requires --resume");
    if (existing.status === "awaiting_smoke" && !config.resume)
      throw new ProductionCutoverError("RESUME_REQUIRED", "Smoke completion requires --resume");
    if (!created && existing.status === "running" && !config.resume)
      throw new ProductionCutoverError("RESUME_REQUIRED", "Interrupted run requires --resume");
    const resumingFromSmoke = existing.status === "awaiting_smoke";
    await assertSafeResumeBoundary(client, config.runId);
    if (!resumingFromSmoke)
      await client.query(
        `UPDATE platform.production_cutover_runs
            SET status = 'running', failure_code = NULL, finished_at = NULL, updated_at = now()
          WHERE run_id = $1`,
        [config.runId],
      );

    for (const step of PRODUCTION_CUTOVER_STEPS) {
      const current = await readStep(client, config.runId, step);
      if (current?.status === "completed") continue;
      if (step === "smoke_evidence" && !resumingFromSmoke) {
        await markAwaitingSmoke(client, config.runId);
        return await persistProductionCutoverEvidence(client, config.runId);
      }
      let smokeContext: ProductionCutoverStepContext | undefined;
      if (step === "smoke_evidence") {
        const run = await readRun(client, config.runId);
        if (!run?.parityReportChecksumSha256)
          throw new ProductionCutoverError(
            "INCOMPLETE_CUTOVER_STATE",
            "Smoke cannot run without completed parity evidence",
          );
        smokeContext = {
          targetIdentitySha256: targetAttestation.targetIdentitySha256,
          parityReportChecksumSha256: run.parityReportChecksumSha256,
        };
        validateSmokeReport(config, smokeContext);
      }
      await startStep(client, config.runId, step);
      try {
        const result = await runStep(step, config, services, smokeContext);
        await completeStep(client, config.runId, step, result);
      } catch (error) {
        const code = error instanceof ProductionCutoverError ? error.code : "STEP_FAILED";
        await failStep(client, config.runId, step, code);
        await persistProductionCutoverEvidence(client, config.runId);
        throw new ProductionCutoverError(code, `${step} did not complete`);
      }
    }

    await finalizeProductionCutover(client, config.runId);
    return await persistProductionCutoverEvidence(client, config.runId);
  } finally {
    if (locked)
      await client
        .query("SELECT pg_advisory_unlock($1)", [PRODUCTION_CUTOVER_LOCK_ID])
        .catch(() => undefined);
    await client.end();
  }
}

export async function abortProductionCutover(input: {
  connectionString: string;
  runId: string;
  operator: string;
  confirmation: string;
}): Promise<ProductionCutoverReport> {
  if (!input.operator.trim())
    throw new ProductionCutoverError("MISSING_OPERATOR", "Operator is required");
  if (input.confirmation !== `ABORT_CUTOVER:${input.runId}`)
    throw new ProductionCutoverError("CONFIRMATION_GUARD_FAILED", "Abort confirmation is invalid");
  const client = new pg.Client({
    connectionString: normalizePgConnectionString(input.connectionString),
  });
  await client.connect();
  let locked = false;
  try {
    const result = await client.query<{ acquired: boolean }>(
      "SELECT pg_try_advisory_lock($1) AS acquired",
      [PRODUCTION_CUTOVER_LOCK_ID],
    );
    if (!result.rows[0]?.acquired)
      throw new ProductionCutoverError("CUTOVER_LOCKED", "Another cutover run is active");
    locked = true;
    const run = await readRun(client, input.runId);
    if (!run) throw new ProductionCutoverError("RUN_NOT_FOUND", "Cutover run was not found");
    if (run.status === "completed")
      throw new ProductionCutoverError("COMPLETED_RUN_IMMUTABLE", "Completed run cannot abort");
    if (run.status === "aborted")
      return await persistProductionCutoverEvidence(client, input.runId);
    await client.query(
      `UPDATE platform.production_cutover_runs
          SET status = 'aborted', current_step = NULL, failure_code = 'ABORTED_BY_OPERATOR',
              abort_operator_sha256 = $2, finished_at = now(), updated_at = now()
        WHERE run_id = $1`,
      [input.runId, sha256(input.operator)],
    );
    return await persistProductionCutoverEvidence(client, input.runId);
  } finally {
    if (locked)
      await client
        .query("SELECT pg_advisory_unlock($1)", [PRODUCTION_CUTOVER_LOCK_ID])
        .catch(() => undefined);
    await client.end();
  }
}

export async function readProductionCutoverStatus(input: {
  connectionString: string;
  runId?: string;
  environment?: MigrationEnvironment;
}): Promise<ProductionMigrationStatusReport> {
  if (input.environment && !MIGRATION_ENVIRONMENTS.includes(input.environment))
    throw new ProductionCutoverError("INVALID_ENVIRONMENT", "Status environment is invalid");
  const client = new pg.Client({
    connectionString: normalizePgConnectionString(input.connectionString),
  });
  await client.connect();
  try {
    const tables = await client.query<{ ledgerPresent: boolean; runsPresent: boolean }>(
      `SELECT to_regclass('platform.schema_migrations') IS NOT NULL AS "ledgerPresent",
              to_regclass('platform.production_cutover_runs') IS NOT NULL AS "runsPresent"`,
    );
    const migrationRows = tables.rows[0]?.ledgerPresent
      ? await client.query<{
          version: string;
          name: string;
          checksumSha256: string;
          environment: MigrationEnvironment;
          status: "applied";
          appliedAt: Date;
        }>(
          `SELECT version, name, checksum_sha256 AS "checksumSha256", environment, status,
                  applied_at AS "appliedAt"
             FROM platform.schema_migrations
            WHERE status = 'applied'
              AND ($1::text IS NULL OR environment = $1)
            ORDER BY version`,
          [input.environment ?? null],
        )
      : { rows: [] };
    if (!tables.rows[0]?.runsPresent)
      return {
        contractVersion: "production-migration-status.v1",
        migrations: mapMigrationRows(migrationRows.rows),
        latestRehearsal: null,
        runs: [],
      };
    const runRows = await client.query<{ runId: string }>(
      `SELECT run_id AS "runId"
         FROM platform.production_cutover_runs
        WHERE ($1::text IS NULL OR run_id = $1)
          AND ($2::text IS NULL OR environment = $2)
        ORDER BY updated_at DESC
        LIMIT 20`,
      [input.runId ?? null, input.environment ?? null],
    );
    const rehearsalRow = await client.query<{ runId: string }>(
      `SELECT run_id AS "runId"
         FROM platform.production_cutover_runs
        WHERE mode = 'staging_rehearsal'
        ORDER BY updated_at DESC
        LIMIT 1`,
    );
    const runs: ProductionCutoverReport[] = [];
    for (const row of runRows.rows) runs.push(await readProductionCutoverReport(client, row.runId));
    const latestRehearsal = rehearsalRow.rows[0]
      ? await readProductionCutoverReport(client, rehearsalRow.rows[0].runId)
      : null;
    return {
      contractVersion: "production-migration-status.v1",
      migrations: mapMigrationRows(migrationRows.rows),
      latestRehearsal,
      runs,
    };
  } finally {
    await client.end();
  }
}

function mapMigrationRows(
  rows: Array<{
    version: string;
    name: string;
    checksumSha256: string;
    environment: MigrationEnvironment;
    status: "applied";
    appliedAt: Date;
  }>,
): ProductionMigrationStatusReport["migrations"] {
  return rows.map((row) => ({ ...row, appliedAt: row.appliedAt.toISOString() }));
}

async function initializeRun(
  client: pg.Client,
  config: ProductionCutoverConfig,
  targetAttestation: TargetCutoverAttestation,
  bootstrappedSchema?: ProductionCutoverStepResult,
): Promise<boolean> {
  const sourceTagsSha256 = Object.fromEntries(
    SOURCE_DATABASES.map((database) => [database, sha256(config.sourceTags[database])]),
  ) as Record<SourceDatabase, string>;
  const approvedRunEvidenceSha256 =
    config.mode === "production_cutover" ? validateApprovedRunReport(config) : null;
  const configSha256 = sha256(
    stableJson({
      mode: config.mode,
      runId: config.runId,
      sourceRunId: config.sourceRunId,
      sourceTagsSha256,
      sourceEnvironment: config.sourceEnvironment,
      environment: config.environment,
      applicationRelease: config.applicationRelease,
      targetIdentitySha256: targetAttestation.targetIdentitySha256,
      operatorSha256: sha256(config.operator),
      targetCleanProofSha256: config.targetCleanProofSha256,
      freezeProofSha256: config.freezeProofSha256,
      backupProofSha256: config.backupProofSha256 ?? null,
      approvedRunId: config.approvedRunId ?? null,
      approvedReportChecksumSha256: config.approvedReportChecksumSha256 ?? null,
      approvedRunEvidenceSha256,
      approvedParityDecision: config.approvedParityDecision ?? null,
      approvalProofSha256: config.approvalProofSha256 ?? null,
      mediaConfigSha256: sha256(stableJson(config.media)),
    }),
  );
  await client.query("BEGIN");
  try {
    const current = await client.query<{ configSha256: string }>(
      `SELECT config_sha256 AS "configSha256"
         FROM platform.production_cutover_runs WHERE run_id = $1 FOR UPDATE`,
      [config.runId],
    );
    if (current.rows[0] && current.rows[0].configSha256 !== configSha256)
      throw new ProductionCutoverError(
        "RUN_CONFIGURATION_MISMATCH",
        "Existing run uses different immutable inputs",
      );
    const created = !current.rows[0];
    if (created) {
      await client.query(
        `INSERT INTO platform.production_cutover_runs
           (run_id, mode, environment, source_environment, source_run_id, config_sha256,
            source_tags_sha256, application_release, target_identity_sha256, operator_sha256,
            approved_run_id,
            approved_report_checksum_sha256, approved_run_evidence_sha256,
            approved_parity_decision, approval_proof_sha256, backup_proof_sha256,
            target_clean_proof_sha256, freeze_proof_sha256, smoke_proof_sha256, status)
         VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,NULL,'running')`,
        [
          config.runId,
          config.mode,
          config.environment,
          config.sourceEnvironment,
          config.sourceRunId,
          configSha256,
          JSON.stringify(sourceTagsSha256),
          config.applicationRelease,
          targetAttestation.targetIdentitySha256,
          sha256(config.operator),
          config.approvedRunId ?? null,
          config.approvedReportChecksumSha256 ?? null,
          approvedRunEvidenceSha256,
          config.approvedParityDecision ?? null,
          config.approvalProofSha256 ?? null,
          config.backupProofSha256 ?? null,
          config.targetCleanProofSha256,
          config.freezeProofSha256,
        ],
      );
      for (const [index, step] of PRODUCTION_CUTOVER_STEPS.entries())
        await client.query(
          `INSERT INTO platform.production_cutover_steps
             (run_id, step_order, step_name, status, safe_checkpoint, attempt_count,
              output_sha256, started_at, finished_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,CASE WHEN $5 THEN now() END,CASE WHEN $5 THEN now() END)`,
          [
            config.runId,
            index + 1,
            step,
            bootstrappedSchema && step === "schema_migrations" ? "completed" : "pending",
            Boolean(bootstrappedSchema && step === "schema_migrations"),
            bootstrappedSchema && step === "schema_migrations" ? 1 : 0,
            bootstrappedSchema && step === "schema_migrations"
              ? bootstrappedSchema.checksumSha256
              : null,
          ],
        );
      if (bootstrappedSchema)
        await client.query(
          `UPDATE platform.production_cutover_runs
              SET last_safe_checkpoint = 'schema_migrations' WHERE run_id = $1`,
          [config.runId],
        );
    }
    await client.query("COMMIT");
    return created;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
}

async function assertSafeResumeBoundary(client: pg.Client, runId: string): Promise<void> {
  const steps = await readSteps(client, runId);
  const firstIncomplete = steps.findIndex((step) => step.status !== "completed");
  if (firstIncomplete < 0) return;
  if (steps.slice(0, firstIncomplete).some((step) => !step.safeCheckpoint))
    throw new ProductionCutoverError(
      "UNSAFE_RESUME_BOUNDARY",
      "Run cannot resume after a non-checkpoint step",
    );
}

async function runStep(
  step: ProductionCutoverStep,
  config: ProductionCutoverConfig,
  services: ProductionCutoverServices,
  smokeContext?: ProductionCutoverStepContext,
): Promise<ProductionCutoverStepResult> {
  if (step === "schema_migrations") return services.schema(config);
  if (step === "source_extraction") return services.extraction(config);
  if (step === "parity") return services.parity(config);
  if (step === "smoke_evidence") {
    if (!smokeContext)
      throw new ProductionCutoverError("INCOMPLETE_CUTOVER_STATE", "Smoke step context is missing");
    return services.smokeEvidence(config, smokeContext);
  }
  return services.domain(step, config);
}

async function markAwaitingSmoke(client: pg.Client, runId: string): Promise<void> {
  const result = await client.query(
    `UPDATE platform.production_cutover_runs
        SET status = 'awaiting_smoke', current_step = 'smoke_evidence',
            failure_code = NULL, finished_at = NULL, updated_at = now()
      WHERE run_id = $1
        AND parity_decision = 'go'
        AND parity_report_checksum_sha256 ~ '^[0-9a-f]{64}$'`,
    [runId],
  );
  if (result.rowCount !== 1)
    throw new ProductionCutoverError(
      "INCOMPLETE_CUTOVER_STATE",
      "Run cannot await smoke without completed GO parity",
    );
}

async function startStep(client: pg.Client, runId: string, step: string): Promise<void> {
  await withTransaction(client, async () => {
    const result = await client.query(
      `UPDATE platform.production_cutover_steps
          SET status = 'running', safe_checkpoint = FALSE,
              attempt_count = attempt_count + 1, failure_code = NULL,
              started_at = now(), finished_at = NULL
        WHERE run_id = $1 AND step_name = $2`,
      [runId, step],
    );
    if (result.rowCount !== 1)
      throw new ProductionCutoverError("RUN_STATE_MISSING", "Step state is missing");
    await client.query(
      `UPDATE platform.production_cutover_runs
          SET status = 'running', current_step = $2, failure_code = NULL,
              finished_at = NULL, updated_at = now()
        WHERE run_id = $1`,
      [runId, step],
    );
  });
}

async function completeStep(
  client: pg.Client,
  runId: string,
  step: string,
  result: ProductionCutoverStepResult,
): Promise<void> {
  validateStepResult(step, result);
  await withTransaction(client, async () => {
    const completed = await client.query(
      `UPDATE platform.production_cutover_steps
          SET status = 'completed', safe_checkpoint = TRUE, output_sha256 = $3,
              failure_code = NULL, finished_at = now()
        WHERE run_id = $1 AND step_name = $2`,
      [runId, step, result.checksumSha256],
    );
    if (completed.rowCount !== 1)
      throw new ProductionCutoverError("RUN_STATE_MISSING", "Step state is missing");
    await client.query(
      `UPDATE platform.production_cutover_runs
          SET last_safe_checkpoint = $2, updated_at = now(),
              parity_decision = COALESCE($3, parity_decision),
              parity_report_checksum_sha256 = COALESCE($4, parity_report_checksum_sha256),
              smoke_proof_sha256 = COALESCE($5, smoke_proof_sha256)
        WHERE run_id = $1`,
      [
        runId,
        step,
        result.parityDecision ?? null,
        result.parityReportChecksumSha256 ?? null,
        result.smokeProofSha256 ?? null,
      ],
    );
  });
}

function validateStepResult(step: string, result: ProductionCutoverStepResult): void {
  if (!isSha256(result.checksumSha256))
    throw new ProductionCutoverError("INVALID_STEP_EVIDENCE", "Step checksum is invalid");
  const isParity = step === "parity";
  const isSmoke = step === "smoke_evidence";
  if (
    (isParity &&
      (result.parityDecision !== "go" ||
        result.parityReportChecksumSha256 !== result.checksumSha256)) ||
    (!isParity &&
      (result.parityDecision !== undefined || result.parityReportChecksumSha256 !== undefined)) ||
    (isSmoke && result.smokeProofSha256 !== result.checksumSha256) ||
    (!isSmoke && result.smokeProofSha256 !== undefined)
  )
    throw new ProductionCutoverError(
      "INVALID_STEP_EVIDENCE",
      `${step} returned internally inconsistent evidence`,
    );
}

export function productionCutoverExitCode(report: ProductionCutoverReport): 0 | 4 {
  return report.status === "awaiting_smoke" ? 4 : 0;
}

async function failStep(
  client: pg.Client,
  runId: string,
  step: string,
  code: string,
): Promise<void> {
  await withTransaction(client, async () => {
    await client.query(
      `UPDATE platform.production_cutover_steps
          SET status = 'failed', safe_checkpoint = FALSE, failure_code = $3, finished_at = now()
        WHERE run_id = $1 AND step_name = $2`,
      [runId, step, code],
    );
    await client.query(
      `UPDATE platform.production_cutover_runs
          SET status = 'failed', current_step = $2, failure_code = $3,
              finished_at = now(), updated_at = now()
        WHERE run_id = $1`,
      [runId, step, code],
    );
  });
}

async function finalizeProductionCutover(client: pg.Client, runId: string): Promise<void> {
  const result = await client.query(
    `UPDATE platform.production_cutover_runs run
        SET status = 'completed', current_step = NULL, failure_code = NULL,
            finished_at = now(), updated_at = now()
      WHERE run.run_id = $1
        AND run.parity_decision = 'go'
        AND run.parity_report_checksum_sha256 ~ '^[0-9a-f]{64}$'
        AND run.smoke_proof_sha256 ~ '^[0-9a-f]{64}$'
        AND (SELECT count(*) FROM platform.production_cutover_steps step
             WHERE step.run_id = run.run_id) = $2
        AND NOT EXISTS (
          SELECT 1 FROM platform.production_cutover_steps step
          WHERE step.run_id = run.run_id
            AND (step.status <> 'completed' OR NOT step.safe_checkpoint)
        )`,
    [runId, PRODUCTION_CUTOVER_STEPS.length],
  );
  if (result.rowCount === 1) return;
  await client.query(
    `UPDATE platform.production_cutover_runs
        SET status = 'failed', failure_code = 'INCOMPLETE_CUTOVER_STATE',
            finished_at = now(), updated_at = now()
      WHERE run_id = $1`,
    [runId],
  );
  await persistProductionCutoverEvidence(client, runId);
  throw new ProductionCutoverError(
    "INCOMPLETE_CUTOVER_STATE",
    "Run cannot complete with inconsistent persisted evidence",
  );
}

async function withTransaction(client: pg.Client, action: () => Promise<void>): Promise<void> {
  await client.query("BEGIN");
  try {
    await action();
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
}

async function readRun(client: pg.Client, runId: string): Promise<RunRow | null> {
  const result = await client.query<RunRow>(
    `SELECT run_id AS "runId", mode, source_run_id AS "sourceRunId",
            source_environment AS "sourceEnvironment", environment,
            application_release AS "applicationRelease",
            target_identity_sha256 AS "targetIdentitySha256",
            operator_sha256 AS "operatorSha256",
            abort_operator_sha256 AS "abortOperatorSha256",
            source_tags_sha256 AS "sourceTagsSha256", config_sha256 AS "configSha256", status,
            target_clean_proof_sha256 AS "targetCleanProofSha256",
            freeze_proof_sha256 AS "freezeProofSha256",
            smoke_proof_sha256 AS "smokeProofSha256",
            backup_proof_sha256 AS "backupProofSha256",
            approved_run_id AS "approvedRunId",
            approved_report_checksum_sha256 AS "approvedReportChecksumSha256",
            approved_run_evidence_sha256 AS "approvedRunEvidenceSha256",
            approved_parity_decision AS "approvedParityDecision",
            approval_proof_sha256 AS "approvalProofSha256",
            current_step AS "currentStep", last_safe_checkpoint AS "lastSafeCheckpoint",
            parity_decision AS "parityDecision",
            parity_report_checksum_sha256 AS "parityReportChecksumSha256",
            failure_code AS "failureCode"
       FROM platform.production_cutover_runs WHERE run_id = $1`,
    [runId],
  );
  return result.rows[0] ?? null;
}

async function readStep(client: pg.Client, runId: string, step: string): Promise<StepRow | null> {
  const result = await client.query<StepRow>(
    `SELECT step_order AS "stepOrder", step_name AS "stepName", status,
            safe_checkpoint AS "safeCheckpoint", attempt_count AS "attemptCount",
            output_sha256 AS "outputSha256", failure_code AS "failureCode"
       FROM platform.production_cutover_steps WHERE run_id = $1 AND step_name = $2`,
    [runId, step],
  );
  return result.rows[0] ?? null;
}

async function readSteps(client: pg.Client, runId: string): Promise<StepRow[]> {
  const result = await client.query<StepRow>(
    `SELECT step_order AS "stepOrder", step_name AS "stepName", status,
            safe_checkpoint AS "safeCheckpoint", attempt_count AS "attemptCount",
            output_sha256 AS "outputSha256", failure_code AS "failureCode"
       FROM platform.production_cutover_steps WHERE run_id = $1 ORDER BY step_order`,
    [runId],
  );
  return result.rows;
}

async function readProductionCutoverReport(
  client: pg.Client,
  runId: string,
): Promise<ProductionCutoverReport> {
  const run = await readRun(client, runId);
  if (!run) throw new ProductionCutoverError("RUN_NOT_FOUND", "Cutover run was not found");
  const steps = await readSteps(client, runId);
  const sourceTags = Object.fromEntries(
    SOURCE_DATABASES.map((database) => [database, { sha256: run.sourceTagsSha256[database] }]),
  ) as Record<SourceDatabase, { sha256: string }>;
  const material = {
    runId: run.runId,
    mode: run.mode,
    sourceRunId: run.sourceRunId,
    sourceEnvironment: run.sourceEnvironment,
    environment: run.environment,
    applicationRelease: run.applicationRelease,
    targetIdentitySha256: run.targetIdentitySha256,
    configSha256: run.configSha256,
    operatorSha256: run.operatorSha256,
    abortOperatorSha256: run.abortOperatorSha256,
    sourceTags,
    guards: {
      targetCleanProofSha256: run.targetCleanProofSha256,
      freezeProofSha256: run.freezeProofSha256,
      smokeProofSha256: run.smokeProofSha256,
      backupProofSha256: run.backupProofSha256,
      approvedRunId: run.approvedRunId,
      approvedReportChecksumSha256: run.approvedReportChecksumSha256,
      approvedRunEvidenceSha256: run.approvedRunEvidenceSha256,
      approvedParityDecision: run.approvedParityDecision,
      approvalProofSha256: run.approvalProofSha256,
    },
    status: run.status,
    legacyAuthority: "legacy" as const,
    currentStep: run.currentStep,
    lastSafeCheckpoint: run.lastSafeCheckpoint,
    parityDecision: run.parityDecision,
    parityReportChecksumSha256: run.parityReportChecksumSha256,
    failureCode: run.failureCode,
    steps: steps.map((step) => ({
      name: step.stepName,
      status: step.status,
      safeCheckpoint: step.safeCheckpoint,
      attemptCount: step.attemptCount,
      outputSha256: step.outputSha256,
      failureCode: step.failureCode,
    })),
  };
  return {
    contractVersion: "production-cutover-orchestration.v1",
    ...material,
    operator: "[REDACTED]",
    evidenceChecksumSha256: sha256(stableJson(material)),
  };
}

async function persistProductionCutoverEvidence(
  client: pg.Client,
  runId: string,
): Promise<ProductionCutoverReport> {
  const report = await readProductionCutoverReport(client, runId);
  await client.query(
    `UPDATE platform.production_cutover_runs SET evidence = $2::jsonb WHERE run_id = $1`,
    [runId, JSON.stringify(report)],
  );
  return report;
}

function checkedResult(value: unknown): ProductionCutoverStepResult {
  return { checksumSha256: sha256(stableJson(value)) };
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function isSha256(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
}
