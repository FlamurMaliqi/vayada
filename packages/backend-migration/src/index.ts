export {
  ADVISORY_LOCK_ID,
  MIGRATION_ENVIRONMENTS,
  acquireAdvisoryLock,
  applyMigrations,
  computeChecksum,
  discoverMigrations,
  ensureLedgerTable,
  runMigrations,
  type LedgerRow,
  type MigrationEnvironment,
  type MigrationFile,
  type MigrationStatus,
  type RunnerConfig,
  type RunResult,
} from "./runner.js";

export { rebuild, type RebuildConfig } from "./rebuild.js";

export { loadFixtureCase, type FixtureLoaderConfig } from "./fixtures.js";

export {
  buildC1RehearsalReport,
  C1_REHEARSAL_CHECKS,
  C1_REHEARSAL_LEGACY_SCHEDULER_JOBS,
  C1_REHEARSAL_PROVIDERS,
  C1_REHEARSAL_REQUIRED_METRICS,
  C1_REHEARSAL_REQUIRED_PROVIDERS,
  runC1RehearsalChecks,
  validateC1RehearsalCheckCoverage,
  type C1RehearsalCheckDefinition,
  type C1RehearsalCheckOptions,
  type C1RehearsalCheckResult,
  type C1RehearsalLegacySchedulerJob,
  type C1RehearsalMetricId,
  type C1RehearsalProvider,
  type C1RehearsalReport,
} from "./c1RehearsalEvidence.js";

export { transformFixtureCase, type TransformConfig } from "./transform.js";

export { normalizePgConnectionString } from "./pgConnection.js";

export {
  buildSourceRowCountQueries,
  parseSourceInventory,
  REQUIRED_SOURCE_REVISION_ARGUMENT,
  REQUIRED_SOURCE_SNAPSHOT_ARGUMENTS,
  RETENTION_POLICIES,
  SOURCE_DATABASES,
  SOURCE_INVENTORY_HEADERS,
  SOURCE_READ_ONLY_TRANSACTION_SQL,
  SOURCE_SCHEMA_FINGERPRINT_SQL,
  type SourceDatabase,
  type SourceDisposition,
  type SourceInventoryEntry,
  type SourceLifecycle,
  type SourceObjectType,
  type RetentionPolicy,
  type TargetOwner,
} from "./sourceInventory.js";

export {
  buildSourceExtractionPlan,
  parseSourceExtractionManifest,
  runSourceExtraction,
  SOURCE_EXTRACTION_BATCH_SIZE,
  SOURCE_EXTRACTION_LOCK_ID,
  SOURCE_PROVENANCE_SQL,
  SOURCE_WRITABLE_PRIVILEGES_SQL,
  SourceExtractionError,
  validateSourceExtractionConfig,
  VAY_1350_INVENTORY_REVISION,
  type SourceExtractionConfig,
  type SourceExtractionManifest,
  type SourceExtractionReport,
} from "./sourceExtraction.js";

export {
  runProductionIdentityMigration,
  type ProductionIdentityMigrationReport,
  type ProductionIdentityMigrationMode,
} from "./productionIdentityMigration.js";
export {
  buildProductionIdentityPlan,
  type ProductionIdentityExistingState,
  type ProductionIdentityPlan,
} from "./productionIdentityPlan.js";
export {
  mapProductionLegacyUserStatus,
  type IdentityMigrationBlocker,
  type TargetIdentityUserStatus,
} from "./productionIdentityDisposition.js";

export {
  runProductionBookingMigration,
  type ProductionBookingMigrationMode,
  type ProductionBookingMigrationReport,
} from "./productionBookingMigration.js";
export { buildProductionBookingPlan } from "./productionBookingPlan.js";
export type {
  ProductionBookingPlan,
  ProductionBookingTargetState,
} from "./productionBookingTypes.js";

export {
  runProductionPmsMigration,
  type ProductionPmsMigrationMode,
  type ProductionPmsMigrationReport,
} from "./productionPmsMigration.js";
export { buildProductionPmsPlan } from "./productionPmsPlan.js";
export type { ProductionPmsPlan, ProductionPmsTargetState } from "./productionPmsTypes.js";

export {
  runParityChecks,
  type ParityCheckSeverity,
  type ParityConfig,
  type ParityFinding,
  type ParityReport,
} from "./parity.js";

export {
  formatProductionParityText,
  PRODUCTION_PARITY_DOMAINS,
  runProductionParity,
  type ProductionParityConfig,
  type ProductionParityDecision,
  type ProductionParityDomain,
  type ProductionParityDomainResult,
  type ProductionParityFinding,
  type ProductionParityReport,
  type ProductionParitySeverity,
  type ProductionParityStatus,
} from "./productionParity.js";

export {
  abortProductionCutover,
  PRODUCTION_CUTOVER_STEPS,
  ProductionCutoverError,
  productionCutoverExitCode,
  readProductionCutoverStatus,
  runProductionCutover,
  validateProductionCutoverConfig,
  type ProductionCutoverConfig,
  type ProductionCutoverApprovalReport,
  type ProductionCutoverMode,
  type ProductionCutoverReport,
  type ProductionCutoverServices,
  type ProductionCutoverSmokeReport,
  type ProductionCutoverStatus,
  type ProductionCutoverStep,
  type ProductionMigrationStatusReport,
} from "./productionCutover.js";
export {
  parseProductionCutoverArgs,
  PRODUCTION_CUTOVER_COMMANDS,
  ProductionCutoverArgsError,
  type ParsedProductionCutoverArgs,
  type ProductionCutoverCommand,
} from "./productionCutoverArgs.js";

export {
  createPgWorkosBackfillRepository,
  runWorkosBackfill,
  type BackfillCounter,
  type WorkosBackfillClient,
  type WorkosBackfillConfig,
  type WorkosBackfillCohort,
  type WorkosBackfillMode,
  type WorkosBackfillMembership,
  type WorkosBackfillOrganization,
  type WorkosBackfillRepository,
  type WorkosBackfillSource,
  type WorkosBackfillSummary,
  type WorkosBackfillUser,
} from "./workosBackfill.js";

export {
  findWorkosLinkAuditBlockers,
  runWorkosLinkAudit,
  WorkosLinkAuditError,
  type WorkosLinkAuditMetric,
  type WorkosLinkAuditResourceLinkCount,
  type WorkosLinkAuditResult,
} from "./workosLinkAudit.js";
