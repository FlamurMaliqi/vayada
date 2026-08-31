import { createHash } from "node:crypto";

import pg from "pg";
import { beforeEach, describe, expect, it } from "vitest";

import {
  abortProductionCutover,
  PRODUCTION_CUTOVER_LOCK_ID,
  PRODUCTION_CUTOVER_STEPS,
  ProductionCutoverError,
  readProductionCutoverStatus,
  runProductionCutover,
  type ProductionCutoverApprovalReport,
  type ProductionCutoverConfig,
  type ProductionCutoverReport,
  type ProductionCutoverServices,
  type ProductionCutoverSmokeReport,
} from "./productionCutover.js";
import { stableJson } from "./productionIdentitySourceValidation.js";
import {
  buildSourceExtractionPlan,
  VAY_1350_INVENTORY_REVISION,
  type SourceExtractionConfig,
} from "./sourceExtraction.js";
import { assertSafeTestDatabase } from "./testUtils.js";

const URL = process.env["TEST_DATABASE_URL"];
const SHA = "d".repeat(64);
const TARGET_IDENTITY_SHA = "9".repeat(64);
const RELEASE = "c".repeat(40);
const APPROVED_RUN_ID = `vay1360-${"7".repeat(24)}`;

describe.skipIf(!URL)("production cutover orchestration (PostgreSQL)", () => {
  beforeEach(async () => {
    assertSafeTestDatabase(URL!);
    const client = new pg.Client({ connectionString: URL });
    await client.connect();
    try {
      await cleanup(client);
    } finally {
      await client.end();
    }
  });

  it("pauses for bound smoke, then completes the exact dry-run sequence once", async () => {
    const calls: string[] = [];
    const services = successfulServices(calls);
    const input = config(runId("1"));
    await attestTarget(input);

    const waiting = await runProductionCutover(input, services);
    expect(waiting).toMatchObject({
      status: "awaiting_smoke",
      currentStep: "smoke_evidence",
      lastSafeCheckpoint: "parity",
      parityDecision: "go",
      guards: { smokeProofSha256: null },
    });
    expect(calls).not.toContain("smoke_evidence");

    const report = await runProductionCutover(
      { ...input, resume: true, smokeReport: smokeReport(input) },
      services,
    );
    expect(calls).toEqual([
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
    ]);
    expect(report).toMatchObject({
      mode: "cutover_dry_run",
      status: "completed",
      legacyAuthority: "legacy",
      parityDecision: "go",
      lastSafeCheckpoint: "smoke_evidence",
      targetIdentitySha256: TARGET_IDENTITY_SHA,
      operator: "[REDACTED]",
    });
    expect(report.steps.every((step) => step.safeCheckpoint)).toBe(true);
    const serialized = JSON.stringify(report);
    expect(serialized).not.toContain(input.operator);
    for (const sourceTag of Object.values(input.sourceTags)) {
      expect(serialized).not.toContain(sourceTag);
    }
    expect(await readPersistedEvidence(input.runId)).toMatchObject({
      status: "completed",
      evidenceChecksumSha256: report.evidenceChecksumSha256,
    });

    calls.length = 0;
    const repeated = await runProductionCutover(input, services);
    expect(repeated.evidenceChecksumSha256).toBe(report.evidenceChecksumSha256);
    expect(calls).toEqual([]);
  });

  it("resumes a failed run only after the last completed safe checkpoint", async () => {
    const calls: string[] = [];
    let failIdentity = true;
    const services = successfulServices(calls, () => {
      if (failIdentity) {
        failIdentity = false;
        throw new ProductionCutoverError("INJECTED_FAILURE", "injected test failure");
      }
    });
    const input = config(runId("2"));
    await attestTarget(input);
    await expect(runProductionCutover(input, services)).rejects.toMatchObject({
      code: "INJECTED_FAILURE",
    });
    await expect(runProductionCutover(input, services)).rejects.toMatchObject({
      code: "RESUME_REQUIRED",
    });
    await setSafeCheckpoint(input.runId, "source_extraction", false);
    await expect(runProductionCutover({ ...input, resume: true }, services)).rejects.toMatchObject({
      code: "UNSAFE_RESUME_BOUNDARY",
    });
    await setSafeCheckpoint(input.runId, "source_extraction", true);
    const waiting = await runProductionCutover({ ...input, resume: true }, services);
    expect(waiting.status).toBe("awaiting_smoke");
    const report = await runProductionCutover(
      { ...input, resume: true, smokeReport: smokeReport(input) },
      services,
    );
    expect(report.status).toBe("completed");
    expect(report.steps.find((step) => step.name === "identity")?.attemptCount).toBe(2);
    expect(calls.filter((step) => step === "schema_migrations")).toHaveLength(1);
    expect(calls.filter((step) => step === "source_extraction")).toHaveLength(1);
  });

  it("rejects changed immutable inputs for an existing run", async () => {
    const input = config(runId("3"));
    await attestTarget(input);
    await completeRun(input, successfulServices([]));
    await expect(
      runProductionCutover({ ...input, operator: "different-operator" }, successfulServices([])),
    ).rejects.toMatchObject({ code: "RUN_CONFIGURATION_MISMATCH" });
  });

  it("prevents concurrent cutover runs with an advisory lock", async () => {
    const input = config(runId("4"));
    await attestTarget(input);
    const blocker = new pg.Client({ connectionString: URL });
    await blocker.connect();
    try {
      await blocker.query("SELECT pg_advisory_lock($1)", [PRODUCTION_CUTOVER_LOCK_ID]);
      await expect(runProductionCutover(input, successfulServices([]))).rejects.toMatchObject({
        code: "CUTOVER_LOCKED",
      });
    } finally {
      await blocker.query("SELECT pg_advisory_unlock($1)", [PRODUCTION_CUTOVER_LOCK_ID]);
      await blocker.end();
    }
  });

  it("aborts once without erasing evidence or the first abort operator", async () => {
    const services = successfulServices([], () => {
      throw new ProductionCutoverError("INJECTED_FAILURE", "injected test failure");
    });
    const input = config(runId("5"));
    await attestTarget(input);
    await expect(runProductionCutover(input, services)).rejects.toMatchObject({
      code: "INJECTED_FAILURE",
    });
    const report = await abortProductionCutover({
      connectionString: URL!,
      runId: input.runId,
      operator: "abort-operator@example.test",
      confirmation: `ABORT_CUTOVER:${input.runId}`,
    });
    await replacePersistedEvidence(input.runId, { stale: true });
    const repeated = await abortProductionCutover({
      connectionString: URL!,
      runId: input.runId,
      operator: "different-abort-operator@example.test",
      confirmation: `ABORT_CUTOVER:${input.runId}`,
    });
    expect(report).toMatchObject({
      status: "aborted",
      failureCode: "ABORTED_BY_OPERATOR",
      legacyAuthority: "legacy",
      lastSafeCheckpoint: "source_extraction",
      abortOperatorSha256: expect.stringMatching(/^[0-9a-f]{64}$/),
    });
    expect(repeated.evidenceChecksumSha256).toBe(report.evidenceChecksumSha256);
    expect(repeated.abortOperatorSha256).toBe(report.abortOperatorSha256);
    expect(JSON.stringify(report)).not.toContain("abort-operator@example.test");
    expect(report.steps.find((step) => step.name === "source_extraction")).toMatchObject({
      status: "completed",
      outputSha256: SHA,
    });
    expect(await readPersistedEvidence(input.runId)).toMatchObject({
      status: "aborted",
      legacyAuthority: "legacy",
      failureCode: "ABORTED_BY_OPERATOR",
    });
    await expect(runProductionCutover({ ...input, resume: true }, services)).rejects.toMatchObject({
      code: "RUN_ABORTED",
    });
  });

  it("reports migration checksums, runs, and the latest staging rehearsal", async () => {
    const input = stagingConfig(runId("6"));
    await attestTarget(input);
    await completeRun(input, successfulServices([]));
    const status = await readProductionCutoverStatus({
      connectionString: URL!,
      runId: input.runId,
    });
    expect(status.contractVersion).toBe("production-migration-status.v1");
    expect(status.migrations).toContainEqual(
      expect.objectContaining({
        version: "0127",
        name: "production_cutover_orchestration",
        checksumSha256: expect.stringMatching(/^[0-9a-f]{64}$/),
        status: "applied",
      }),
    );
    expect(status.runs).toHaveLength(1);
    expect(status.latestRehearsal?.runId).toBe(input.runId);
  });

  it("rejects a mismatched database attestation before services run", async () => {
    const calls: string[] = [];
    const input = config(runId("7"));
    await attestTarget(input, { environment: "production" });
    await expect(runProductionCutover(input, successfulServices(calls))).rejects.toMatchObject({
      code: "TARGET_ATTESTATION_MISMATCH",
    });
    expect(calls).toEqual([]);
  });

  it("does not let connection options spoof a database-level environment", async () => {
    const calls: string[] = [];
    const input = config(runId("8"));
    await attestTarget(input, { environment: "production" });
    const spoofed = new globalThis.URL(URL!);
    spoofed.searchParams.set("options", "-c vayada.target_environment=preprod");
    await expect(
      runProductionCutover(
        { ...input, connectionString: spoofed.toString() },
        successfulServices(calls),
      ),
    ).rejects.toMatchObject({ code: "TARGET_ATTESTATION_MISMATCH" });
    expect(calls).toEqual([]);
  });

  it("keeps an invalid smoke artifact in the awaiting-smoke state", async () => {
    const input = config(runId("9"));
    const services = successfulServices([]);
    await attestTarget(input);
    await runProductionCutover(input, services);
    const invalid = { ...smokeReport(input), runId: runId("a") };
    await expect(
      runProductionCutover({ ...input, resume: true, smokeReport: invalid }, services),
    ).rejects.toMatchObject({ code: "SMOKE_REPORT_MISMATCH" });
    const status = await readProductionCutoverStatus({
      connectionString: URL!,
      runId: input.runId,
    });
    expect(status.runs[0]?.status).toBe("awaiting_smoke");
  });

  it("refuses final completion when persisted parity state is inconsistent", async () => {
    const input = config(runId("b"));
    await attestTarget(input);
    await runProductionCutover(input, successfulServices([]));
    await corruptFinalState(input.runId);
    await expect(
      runProductionCutover({ ...input, resume: true }, successfulServices([])),
    ).rejects.toMatchObject({ code: "INCOMPLETE_CUTOVER_STATE" });
    expect(await readPersistedEvidence(input.runId)).toMatchObject({
      status: "failed",
      failureCode: "INCOMPLETE_CUTOVER_STATE",
    });
  });

  it("rejects a validly checksummed approval for a different production target", async () => {
    const calls: string[] = [];
    const cleanTargetUrl = await createCleanTargetDatabase();
    const input = {
      ...productionConfig(runId("c")),
      connectionString: cleanTargetUrl,
    };
    const approval = {
      ...(input.approvalReport as ProductionCutoverApprovalReport),
      targetIdentitySha256: "8".repeat(64),
    };
    const { evidenceChecksumSha256, ...material } = approval;
    void evidenceChecksumSha256;
    input.approvalReport = {
      ...material,
      evidenceChecksumSha256: hash(stableJson(material)),
    };
    input.approvalProofSha256 = (
      input.approvalReport as ProductionCutoverApprovalReport
    ).evidenceChecksumSha256;
    try {
      await attestTarget(input);
      await expect(runProductionCutover(input, successfulServices(calls))).rejects.toMatchObject({
        code: "APPROVAL_EVIDENCE_MISMATCH",
      });
      expect(calls).toEqual([]);
      await expect(hasOrchestrationTable(cleanTargetUrl)).resolves.toBe(false);
    } finally {
      await dropCleanTargetDatabase(cleanTargetUrl);
    }
  });
});

function config(runIdValue: string): ProductionCutoverConfig {
  const sourceExtraction = extraction("preprod");
  const sourceRunId = buildSourceExtractionPlan(sourceExtraction).runId;
  return {
    connectionString: URL!,
    migrationsDir: "/unused/by-test-services",
    mode: "cutover_dry_run",
    runId: runIdValue,
    sourceRunId,
    sourceTags: sourceExtraction.snapshotIdentifiers,
    sourceEnvironment: "preprod",
    environment: "preprod",
    applicationRelease: RELEASE,
    runtimeApplicationRelease: RELEASE,
    operator: "operator@example.test",
    targetCleanProofSha256: SHA,
    freezeProofSha256: SHA,
    confirmation: `CUTOVER_DRY_RUN:${runIdValue}:${sourceRunId}`,
    sourceExtraction,
    sourceConnectionStrings: {
      auth: "postgresql://source.test/auth",
      booking: "postgresql://source.test/booking",
      marketplace: "postgresql://source.test/marketplace",
      pms: "postgresql://source.test/pms",
    },
  };
}

function stagingConfig(runIdValue: string): ProductionCutoverConfig {
  const sourceExtraction = extraction("staging");
  const sourceRunId = buildSourceExtractionPlan(sourceExtraction).runId;
  return {
    ...config(runIdValue),
    mode: "staging_rehearsal",
    sourceRunId,
    sourceTags: sourceExtraction.snapshotIdentifiers,
    sourceEnvironment: "staging",
    environment: "staging",
    confirmation: `STAGING_REHEARSAL:${runIdValue}:${sourceRunId}`,
    sourceExtraction,
  };
}

function productionConfig(runIdValue: string): ProductionCutoverConfig {
  const input: ProductionCutoverConfig = {
    ...config(runIdValue),
    mode: "production_cutover",
    environment: "production",
    backupProofSha256: SHA,
    approvedRunId: APPROVED_RUN_ID,
    approvedReportChecksumSha256: SHA,
    approvedParityDecision: "go",
    confirmation: `PRODUCTION_CUTOVER:${runIdValue}:${config(runIdValue).sourceRunId}`,
  };
  const approvedRunReport = approvedDryRunReport(input);
  input.approvedRunReport = approvedRunReport;
  const approvalReport = approvalReportFor(input, approvedRunReport.evidenceChecksumSha256);
  input.approvalReport = approvalReport;
  input.approvalProofSha256 = approvalReport.evidenceChecksumSha256;
  return input;
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
    sourceTags: hashedSourceTags(input),
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
    parityReportChecksumSha256: SHA,
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

function approvalReportFor(
  input: ProductionCutoverConfig,
  approvedRunEvidenceSha256: string,
): ProductionCutoverApprovalReport {
  const material = {
    contractVersion: "production-cutover-approval.v1" as const,
    productionRunId: input.runId,
    targetIdentitySha256: TARGET_IDENTITY_SHA,
    backupProofSha256: input.backupProofSha256!,
    applicationRelease: input.applicationRelease,
    sourceRunId: input.sourceRunId,
    sourceTags: hashedSourceTags(input),
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

function hashedSourceTags(input: ProductionCutoverConfig) {
  return {
    auth: { sha256: hash(input.sourceTags.auth) },
    booking: { sha256: hash(input.sourceTags.booking) },
    marketplace: { sha256: hash(input.sourceTags.marketplace) },
    pms: { sha256: hash(input.sourceTags.pms) },
  };
}

function extraction(environment: "staging" | "preprod"): SourceExtractionConfig {
  const snapshots = {
    auth: "private-snapshot:auth",
    booking: "private-snapshot:booking",
    marketplace: "private-snapshot:marketplace",
    pms: "private-snapshot:pms",
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

function successfulServices(
  calls: string[],
  beforeIdentity?: () => void,
): ProductionCutoverServices {
  return {
    schema: async () => record(calls, "schema_migrations"),
    extraction: async () => record(calls, "source_extraction"),
    domain: async (domain) => {
      calls.push(domain);
      if (domain === "identity") beforeIdentity?.();
      return { checksumSha256: SHA };
    },
    parity: async () => {
      calls.push("parity");
      return {
        checksumSha256: SHA,
        parityDecision: "go",
        parityReportChecksumSha256: SHA,
      };
    },
    smokeEvidence: async (input) => {
      calls.push("smoke_evidence");
      const checksum = (input.smokeReport as ProductionCutoverSmokeReport).evidenceChecksumSha256;
      return { checksumSha256: checksum, smokeProofSha256: checksum };
    },
  };
}

async function completeRun(input: ProductionCutoverConfig, services: ProductionCutoverServices) {
  const waiting = await runProductionCutover(input, services);
  expect(waiting.status).toBe("awaiting_smoke");
  return runProductionCutover(
    { ...input, resume: true, smokeReport: smokeReport(input) },
    services,
  );
}

function smokeReport(input: ProductionCutoverConfig): ProductionCutoverSmokeReport {
  const material = {
    contractVersion: "production-cutover-smoke.v1" as const,
    runId: input.runId,
    targetIdentitySha256: TARGET_IDENTITY_SHA,
    environment: input.environment,
    applicationRelease: input.applicationRelease,
    sourceRunId: input.sourceRunId,
    sourceTags: {
      auth: { sha256: hash(input.sourceTags.auth) },
      booking: { sha256: hash(input.sourceTags.booking) },
      marketplace: { sha256: hash(input.sourceTags.marketplace) },
      pms: { sha256: hash(input.sourceTags.pms) },
    },
    parityReportChecksumSha256: SHA,
    status: "passed" as const,
    checks: [
      {
        name: "target-api-and-browser",
        status: "passed" as const,
        evidenceSha256: SHA,
      },
    ],
  };
  return { ...material, evidenceChecksumSha256: hash(stableJson(material)) };
}

function record(calls: string[], step: string) {
  calls.push(step);
  return { checksumSha256: SHA };
}

function runId(suffix: string) {
  return `vay1360-${"f".repeat(23)}${suffix}`;
}

function hash(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

async function attestTarget(
  input: ProductionCutoverConfig,
  override: {
    environment?: ProductionCutoverConfig["environment"];
    cleanProof?: string;
  } = {},
) {
  const databaseName = new globalThis.URL(input.connectionString).pathname.replace(/^\//, "");
  if (!/^[a-z_][a-z0-9_]*$/.test(databaseName)) {
    throw new Error("Unsafe test database name");
  }
  const values = {
    "vayada.target_environment": override.environment ?? input.environment,
    "vayada.target_identity_sha256": TARGET_IDENTITY_SHA,
    "vayada.target_clean_run_id": input.runId,
    "vayada.target_clean_proof_sha256": override.cleanProof ?? input.targetCleanProofSha256,
    "vayada.target_application_release": input.applicationRelease,
    ...(input.backupProofSha256
      ? { "vayada.target_backup_proof_sha256": input.backupProofSha256 }
      : {}),
  };
  const client = new pg.Client({ connectionString: input.connectionString });
  await client.connect();
  try {
    for (const [name, value] of Object.entries(values)) {
      if (!/^[a-z0-9_.:-]+$/.test(value)) {
        throw new Error("Unsafe test attestation value");
      }
      await client.query(`ALTER DATABASE "${databaseName}" SET ${name} TO '${value}'`);
    }
  } finally {
    await client.end();
  }
}

async function createCleanTargetDatabase(): Promise<string> {
  const adminUrl = new globalThis.URL(URL!);
  const baseName = adminUrl.pathname.replace(/^\//, "");
  const databaseName = `${baseName}_vay1360_clean`;
  if (!/^[a-z_][a-z0-9_]*test[a-z0-9_]*$/.test(databaseName) || databaseName.length > 63) {
    throw new Error("Unsafe clean test database name");
  }
  adminUrl.pathname = "/postgres";
  const client = new pg.Client({ connectionString: adminUrl.toString() });
  await client.connect();
  try {
    await client.query(`DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`);
    await client.query(`CREATE DATABASE "${databaseName}"`);
  } finally {
    await client.end();
  }
  const targetUrl = new globalThis.URL(URL!);
  targetUrl.pathname = `/${databaseName}`;
  return targetUrl.toString();
}

async function dropCleanTargetDatabase(connectionString: string): Promise<void> {
  const targetUrl = new globalThis.URL(connectionString);
  const databaseName = targetUrl.pathname.replace(/^\//, "");
  if (!/^[a-z_][a-z0-9_]*test[a-z0-9_]*$/.test(databaseName)) {
    throw new Error("Unsafe clean test database name");
  }
  targetUrl.pathname = "/postgres";
  const client = new pg.Client({ connectionString: targetUrl.toString() });
  await client.connect();
  try {
    await client.query(`DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`);
  } finally {
    await client.end();
  }
}

async function hasOrchestrationTable(connectionString: string): Promise<boolean> {
  const client = new pg.Client({ connectionString });
  await client.connect();
  try {
    const result = await client.query<{ present: boolean }>(
      `SELECT to_regclass('platform.production_cutover_runs') IS NOT NULL AS present`,
    );
    return result.rows[0]?.present ?? false;
  } finally {
    await client.end();
  }
}

async function cleanup(client: pg.Client) {
  await client.query(
    "DELETE FROM platform.production_cutover_steps WHERE run_id LIKE 'vay1360-fffffffffffffffffffffff%'",
  );
  await client.query(
    "DELETE FROM platform.production_cutover_runs WHERE run_id LIKE 'vay1360-fffffffffffffffffffffff%'",
  );
}

async function setSafeCheckpoint(runIdValue: string, step: string, safe: boolean) {
  const client = new pg.Client({ connectionString: URL });
  await client.connect();
  try {
    await client.query(
      `UPDATE platform.production_cutover_steps
       SET safe_checkpoint = $3
       WHERE run_id = $1 AND step_name = $2`,
      [runIdValue, step, safe],
    );
  } finally {
    await client.end();
  }
}

async function corruptFinalState(runIdValue: string) {
  const client = new pg.Client({ connectionString: URL });
  await client.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      `UPDATE platform.production_cutover_steps
       SET status = 'completed', safe_checkpoint = TRUE, attempt_count = 1,
           output_sha256 = $2, failure_code = NULL, finished_at = now()
       WHERE run_id = $1 AND step_name = 'smoke_evidence'`,
      [runIdValue, SHA],
    );
    await client.query(
      `UPDATE platform.production_cutover_runs
       SET status = 'running', current_step = 'smoke_evidence',
           last_safe_checkpoint = 'smoke_evidence', parity_decision = NULL,
           smoke_proof_sha256 = $2, failure_code = NULL, finished_at = NULL
       WHERE run_id = $1`,
      [runIdValue, SHA],
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    await client.end();
  }
}

async function readPersistedEvidence(runIdValue: string) {
  const client = new pg.Client({ connectionString: URL });
  await client.connect();
  try {
    const result = await client.query<{ evidence: Record<string, unknown> }>(
      `SELECT evidence
       FROM platform.production_cutover_runs
       WHERE run_id = $1`,
      [runIdValue],
    );
    return result.rows[0]?.evidence ?? {};
  } finally {
    await client.end();
  }
}

async function replacePersistedEvidence(runIdValue: string, evidence: Record<string, unknown>) {
  const client = new pg.Client({ connectionString: URL });
  await client.connect();
  try {
    await client.query(
      `UPDATE platform.production_cutover_runs
       SET evidence = $2::jsonb
       WHERE run_id = $1`,
      [runIdValue, JSON.stringify(evidence)],
    );
  } finally {
    await client.end();
  }
}
