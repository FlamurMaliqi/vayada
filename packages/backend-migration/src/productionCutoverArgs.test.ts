import { describe, expect, it } from "vitest";

import { parseProductionCutoverArgs } from "./productionCutoverArgs.js";

const RUN_ID = `vay1360-${"a".repeat(24)}`;
const APPROVED_RUN_ID = `vay1360-${"b".repeat(24)}`;
const SOURCE_RUN_ID = `vay1351-${"c".repeat(24)}`;
const SHA = "d".repeat(64);
const RELEASE = "e".repeat(40);

describe("production cutover arguments", () => {
  it("parses the complete production guard set", () => {
    const parsed = parseProductionCutoverArgs([
      "node",
      "cutover.ts",
      "cutover",
      ...baseArguments("production", "preprod"),
      "--backup-proof-sha256",
      SHA,
      "--approved-run-id",
      APPROVED_RUN_ID,
      "--approved-run-report",
      "/reviewed/vay1360-report.json",
      "--approved-report-checksum-sha256",
      SHA,
      "--approved-decision",
      "go",
      "--approval-proof-sha256",
      SHA,
      "--approval-report",
      "/reviewed/approval-report.json",
      "--resume",
      "--smoke-report",
      "/reviewed/smoke-report.json",
      "--report",
      "json",
    ]);

    expect(parsed).toMatchObject({ command: "cutover", resume: true, report: "json" });
    expect(parsed.values.get("--approved-run-id")).toBe(APPROVED_RUN_ID);
  });

  it("requires every production-only proof and a GO decision", () => {
    expect(() =>
      parseProductionCutoverArgs([
        "node",
        "cutover.ts",
        "cutover",
        ...baseArguments("production", "preprod"),
      ]),
    ).toThrow("--backup-proof-sha256 is required");
    expect(() =>
      parseProductionCutoverArgs([
        "node",
        "cutover.ts",
        "cutover",
        ...baseArguments("production", "preprod"),
        "--backup-proof-sha256",
        SHA,
        "--approved-run-id",
        APPROVED_RUN_ID,
        "--approved-run-report",
        "/reviewed/vay1360-report.json",
        "--approved-report-checksum-sha256",
        SHA,
        "--approved-decision",
        "review",
        "--approval-proof-sha256",
        SHA,
        "--approval-report",
        "/reviewed/approval-report.json",
      ]),
    ).toThrow("--approved-decision must be go");
  });

  it("parses status without migration inputs", () => {
    const parsed = parseProductionCutoverArgs([
      "node",
      "cutover.ts",
      "status",
      "--run-id",
      RUN_ID,
      "--report",
      "json",
    ]);

    expect(parsed).toMatchObject({ command: "status", report: "json" });
  });

  it("does not allow trusted command internals to be replaced", () => {
    expect(() =>
      parseProductionCutoverArgs([
        "node",
        "cutover.ts",
        "rehearse-staging",
        ...baseArguments("staging", "staging"),
        "--migrations-dir",
        "/tmp/operator-controlled",
      ]),
    ).toThrow("Unknown or duplicate argument: --migrations-dir");
  });
});

function baseArguments(environment: string, sourceEnvironment: string): string[] {
  return [
    "--run-id",
    RUN_ID,
    "--source-run-id",
    SOURCE_RUN_ID,
    "--source-env",
    sourceEnvironment,
    "--env",
    environment,
    "--manifest",
    "/reviewed/manifest.json",
    "--source-schema-revision",
    RELEASE,
    "--application-release",
    RELEASE,
    "--operator",
    "operator@example.test",
    "--target-clean-proof-sha256",
    SHA,
    "--freeze-proof-sha256",
    SHA,
    "--auth-source-tag",
    "snapshot:auth",
    "--booking-source-tag",
    "snapshot:booking",
    "--marketplace-source-tag",
    "snapshot:marketplace",
    "--pms-source-tag",
    "snapshot:pms",
    "--confirmation",
    `PRODUCTION_CUTOVER:${RUN_ID}:${SOURCE_RUN_ID}`,
  ];
}
