import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  PRODUCTION_CUTOVER_STEPS,
  ProductionCutoverError,
  productionCutoverExitCode,
  validateProductionCutoverConfig,
  type ProductionCutoverApprovalReport,
  type ProductionCutoverConfig,
  type ProductionCutoverReport,
} from "./productionCutover.js";
import { stableJson } from "./productionIdentitySourceValidation.js";
import {
  buildSourceExtractionPlan,
  VAY_1350_INVENTORY_REVISION,
  type SourceExtractionConfig,
} from "./sourceExtraction.js";

const RUN_ID = `vay1360-${"a".repeat(24)}`;
const APPROVED_RUN_ID = `vay1360-${"b".repeat(24)}`;
const SHA = "d".repeat(64);
const RELEASE = "e".repeat(40);

describe("production cutover guards", () => {
  it("accepts only the exact environment pair for each command mode", () => {
    expect(() => validateProductionCutoverConfig(config())).not.toThrow();
    expect(() =>
      validateProductionCutoverConfig({ ...config(), environment: "preprod" }),
    ).toThrowError(expect.objectContaining({ code: "ENVIRONMENT_GUARD_FAILED" }));
  });

  it.each([
    ["targetCleanProofSha256", undefined, "MISSING_TARGET_CLEAN_PROOF"],
    ["freezeProofSha256", undefined, "MISSING_FREEZE_PROOF"],
    ["backupProofSha256", undefined, "MISSING_BACKUP_PROOF"],
    ["approvedRunId", undefined, "MISSING_APPROVED_RUN"],
    ["approvedReportChecksumSha256", undefined, "MISSING_APPROVED_REPORT"],
    ["approvedParityDecision", "review", "APPROVED_REPORT_NOT_GO"],
    ["approvalProofSha256", undefined, "MISSING_APPROVAL_PROOF"],
    ["approvedRunReport", undefined, "MISSING_APPROVED_RUN_EVIDENCE"],
    ["approvalReport", undefined, "MISSING_APPROVAL_EVIDENCE"],
  ] as const)("rejects an invalid %s production guard", (key, value, code) => {
    const input = productionConfig();
    Object.assign(input, { [key]: value });

    expectProductionError(() => validateProductionCutoverConfig(input), code);
  });

  it("requires every immutable source tag", () => {
    const input = config();
    input.sourceTags.booking = "";

    expectProductionError(() => validateProductionCutoverConfig(input), "MISSING_SOURCE_TAG");
  });

  it("binds the reviewed extraction manifest before any database work", () => {
    const input = config();
    input.sourceExtraction = {
      ...input.sourceExtraction,
      manifest: { ...input.sourceExtraction.manifest, environment: "preprod" },
    };

    expectProductionError(() => validateProductionCutoverConfig(input), "SOURCE_EVIDENCE_MISMATCH");
  });

  it("binds confirmation and runtime release metadata to the exact run", () => {
    expectProductionError(
      () => validateProductionCutoverConfig({ ...config(), confirmation: "yes" }),
      "CONFIRMATION_GUARD_FAILED",
    );
    expectProductionError(
      () =>
        validateProductionCutoverConfig({
          ...config(),
          runtimeApplicationRelease: "f".repeat(40),
        }),
      "RELEASE_ATTESTATION_MISMATCH",
    );
  });

  it("does not allow a production run to approve itself", () => {
    expectProductionError(
      () =>
        validateProductionCutoverConfig({
          ...productionConfig(),
          approvedRunId: RUN_ID,
        }),
      "INVALID_APPROVED_RUN",
    );
  });

  it("rejects a dry-run artifact that is not bound to the exact source run", () => {
    const input = productionConfig();
    input.approvedRunReport = {
      ...(input.approvedRunReport as ProductionCutoverReport),
      sourceRunId: `vay1351-${"f".repeat(24)}`,
    };

    expectProductionError(
      () => validateProductionCutoverConfig(input),
      "APPROVED_RUN_EVIDENCE_MISMATCH",
    );
  });

  it("recomputes the approved dry-run evidence checksum", () => {
    const input = productionConfig();
    input.approvedRunReport = {
      ...(input.approvedRunReport as ProductionCutoverReport),
      evidenceChecksumSha256: "f".repeat(64),
    };

    expectProductionError(
      () => validateProductionCutoverConfig(input),
      "INVALID_APPROVED_RUN_EVIDENCE",
    );
  });

  it("binds parity and smoke step outputs to the approved artifact guards", () => {
    const input = productionConfig();
    const report = input.approvedRunReport as ProductionCutoverReport;
    input.approvedRunReport = {
      ...report,
      steps: report.steps.map((step) =>
        step.name === "smoke_evidence" ? { ...step, outputSha256: "f".repeat(64) } : step,
      ),
    };

    expectProductionError(
      () => validateProductionCutoverConfig(input),
      "INVALID_APPROVED_RUN_EVIDENCE",
    );
  });

  it("recomputes and binds the structured production approval", () => {
    const input = productionConfig();
    input.approvalReport = {
      ...(input.approvalReport as ProductionCutoverApprovalReport),
      approvedRunEvidenceSha256: "f".repeat(64),
    };

    expectProductionError(
      () => validateProductionCutoverConfig(input),
      "APPROVAL_EVIDENCE_MISMATCH",
    );
  });

  it("binds approval to one exact production attempt", () => {
    const input = productionConfig();
    input.approvalReport = {
      ...(input.approvalReport as ProductionCutoverApprovalReport),
      productionRunId: `vay1360-${"f".repeat(24)}`,
    };

    expectProductionError(
      () => validateProductionCutoverConfig(input),
      "APPROVAL_EVIDENCE_MISMATCH",
    );
  });

  it("uses a distinct exit code while deployed smoke evidence is pending", () => {
    const report = approvedDryRunReport(productionConfig());
    expect(productionCutoverExitCode({ ...report, status: "awaiting_smoke" })).toBe(4);
    expect(productionCutoverExitCode(report)).toBe(0);
  });
});

function config(): ProductionCutoverConfig {
  const sourceExtraction = extraction("staging");
  const sourceRunId = buildSourceExtractionPlan(sourceExtraction).runId;
  return {
    connectionString: "postgresql://target.test/cutover_test",
    migrationsDir: "/trusted/migrations",
    mode: "staging_rehearsal",
    runId: RUN_ID,
    sourceRunId,
    sourceTags: {
      auth: "snapshot:auth",
      booking: "snapshot:booking",
      marketplace: "snapshot:marketplace",
      pms: "snapshot:pms",
    },
    sourceEnvironment: "staging",
    environment: "staging",
    applicationRelease: RELEASE,
    runtimeApplicationRelease: RELEASE,
    operator: "operator@example.test",
    targetCleanProofSha256: SHA,
    freezeProofSha256: SHA,
    confirmation: `STAGING_REHEARSAL:${RUN_ID}:${sourceRunId}`,
    sourceExtraction,
    sourceConnectionStrings: {
      auth: "postgresql://source.test/auth",
      booking: "postgresql://source.test/booking",
      marketplace: "postgresql://source.test/marketplace",
      pms: "postgresql://source.test/pms",
    },
  };
}

function productionConfig(): ProductionCutoverConfig {
  const sourceExtraction = extraction("preprod");
  const sourceRunId = buildSourceExtractionPlan(sourceExtraction).runId;
  const input: ProductionCutoverConfig = {
    ...config(),
    mode: "production_cutover",
    environment: "production",
    sourceEnvironment: "preprod",
    sourceRunId,
    sourceExtraction,
    backupProofSha256: SHA,
    approvedRunId: APPROVED_RUN_ID,
    approvedReportChecksumSha256: SHA,
    approvedParityDecision: "go",
    confirmation: `PRODUCTION_CUTOVER:${RUN_ID}:${sourceRunId}`,
  };
  const approvedRunReport = approvedDryRunReport(input);
  input.approvedRunReport = approvedRunReport;
  const approvalReport = productionApprovalReport(input, approvedRunReport.evidenceChecksumSha256);
  input.approvalReport = approvalReport;
  input.approvalProofSha256 = approvalReport.evidenceChecksumSha256;
  return input;
}

function productionApprovalReport(
  input: ProductionCutoverConfig,
  approvedRunEvidenceSha256: string,
): ProductionCutoverApprovalReport {
  const material = {
    contractVersion: "production-cutover-approval.v1" as const,
    productionRunId: input.runId,
    targetIdentitySha256: SHA,
    backupProofSha256: input.backupProofSha256!,
    applicationRelease: input.applicationRelease,
    sourceRunId: input.sourceRunId,
    sourceTags: {
      auth: { sha256: hash(input.sourceTags.auth) },
      booking: { sha256: hash(input.sourceTags.booking) },
      marketplace: { sha256: hash(input.sourceTags.marketplace) },
      pms: { sha256: hash(input.sourceTags.pms) },
    },
    freezeProofSha256: input.freezeProofSha256,
    approvedRunId: input.approvedRunId!,
    approvedRunEvidenceSha256,
    parityReportChecksumSha256: input.approvedReportChecksumSha256!,
    decision: "go" as const,
    approverSha256: SHA,
    approvedAt: "2026-08-31T00:00:00.000Z",
  };
  return { ...material, evidenceChecksumSha256: hash(stableJson(material)) };
}

function approvedDryRunReport(input: ProductionCutoverConfig): ProductionCutoverReport {
  const material = {
    runId: APPROVED_RUN_ID,
    mode: "cutover_dry_run" as const,
    sourceRunId: input.sourceRunId,
    sourceEnvironment: "preprod" as const,
    environment: "preprod" as const,
    applicationRelease: input.applicationRelease,
    targetIdentitySha256: SHA,
    configSha256: SHA,
    operatorSha256: SHA,
    abortOperatorSha256: null,
    sourceTags: {
      auth: { sha256: hash(input.sourceTags.auth) },
      booking: { sha256: hash(input.sourceTags.booking) },
      marketplace: { sha256: hash(input.sourceTags.marketplace) },
      pms: { sha256: hash(input.sourceTags.pms) },
    },
    guards: {
      targetCleanProofSha256: SHA,
      freezeProofSha256: input.freezeProofSha256,
      smokeProofSha256: SHA,
      backupProofSha256: null,
      approvedRunId: null,
      approvedReportChecksumSha256: null,
      approvedRunEvidenceSha256: null,
      approvedParityDecision: null,
      approvalProofSha256: null,
    },
    status: "completed" as const,
    legacyAuthority: "legacy" as const,
    currentStep: null,
    lastSafeCheckpoint: "smoke_evidence",
    parityDecision: "go" as const,
    parityReportChecksumSha256: input.approvedReportChecksumSha256!,
    failureCode: null,
    steps: PRODUCTION_CUTOVER_STEPS.map((name) => ({
      name,
      status: "completed" as const,
      safeCheckpoint: true,
      attemptCount: 1,
      outputSha256: SHA,
      failureCode: null,
    })),
  };
  return {
    contractVersion: "production-cutover-orchestration.v1",
    ...material,
    operator: "[REDACTED]",
    evidenceChecksumSha256: hash(stableJson(material)),
  };
}

function extraction(environment: "staging" | "preprod"): SourceExtractionConfig {
  const snapshots = {
    auth: "snapshot:auth",
    booking: "snapshot:booking",
    marketplace: "snapshot:marketplace",
    pms: "snapshot:pms",
  };
  return {
    manifest: {
      version: 1,
      environment,
      sourceSchemaRevision: VAY_1350_INVENTORY_REVISION,
      cutoverFreezeProofSha256: SHA,
      sources: {
        auth: {
          snapshotIdentifier: snapshots.auth,
          expectedDatabaseName: "auth_test",
          expectedSchemaFingerprint: "a".repeat(32),
        },
        booking: {
          snapshotIdentifier: snapshots.booking,
          expectedDatabaseName: "booking_test",
          expectedSchemaFingerprint: "b".repeat(32),
        },
        marketplace: {
          snapshotIdentifier: snapshots.marketplace,
          expectedDatabaseName: "marketplace_test",
          expectedSchemaFingerprint: "c".repeat(32),
        },
        pms: {
          snapshotIdentifier: snapshots.pms,
          expectedDatabaseName: "pms_test",
          expectedSchemaFingerprint: "d".repeat(32),
        },
      },
    },
    sourceSchemaRevision: VAY_1350_INVENTORY_REVISION,
    snapshotIdentifiers: snapshots,
    cutoverFreezeProofSha256: SHA,
    inventory: [],
  };
}

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function expectProductionError(run: () => void, code: string): void {
  try {
    run();
    throw new Error("Expected a ProductionCutoverError");
  } catch (error) {
    expect(error).toBeInstanceOf(ProductionCutoverError);
    expect((error as ProductionCutoverError).code).toBe(code);
  }
}
