import { describe, expect, it } from "vitest";

import { isProductionParityCommand, parseProductionParityArgs } from "./productionParityArgs.js";

const RUN_ID = `vay1351-${"a".repeat(24)}`;

describe("production parity arguments", () => {
  it("selects production parity only when an immutable source run is supplied", () => {
    expect(isProductionParityCommand(["node", "parity", "--fixtures", "finance"])).toBe(false);
    expect(isProductionParityCommand(["node", "parity", "--source-run-id", RUN_ID])).toBe(true);
  });

  it("requires all four immutable tags and exact non-local release evidence", () => {
    expect(() =>
      parseProductionParityArgs(
        [
          "node",
          "parity",
          "--source-run-id",
          RUN_ID,
          "--source-env",
          "preprod",
          "--env",
          "preprod",
          "--auth-source-tag",
          "auth",
          "--booking-source-tag",
          "booking",
          "--marketplace-source-tag",
          "marketplace",
          "--pms-source-tag",
          "pms",
          "--application-release",
          "short",
        ],
        "/migrations",
        {
          TARGET_DATABASE_URL: "postgresql://target",
          APPLICATION_RELEASE: "c".repeat(40),
          USER: "operator",
        },
      ),
    ).toThrow("exact 40-character Git SHA");
  });

  it("parses a complete read-only run-level command", () => {
    const result = parseProductionParityArgs(
      [
        "node",
        "parity",
        "--source-run-id",
        RUN_ID,
        "--source-env",
        "preprod",
        "--env",
        "preprod",
        "--auth-source-tag",
        "arn:auth",
        "--booking-source-tag",
        "arn:booking",
        "--marketplace-source-tag",
        "arn:marketplace",
        "--pms-source-tag",
        "arn:pms",
        "--application-release",
        "b".repeat(40),
        "--operator",
        "cutover-operator",
        "--warning-budget",
        "2",
        "--report",
        "json",
      ],
      "/migrations",
      {
        TARGET_DATABASE_URL: "postgresql://target",
        APPLICATION_RELEASE: "b".repeat(40),
        PLATFORM_MEDIA_BUCKET: "platform-media-test",
        PLATFORM_MEDIA_CDN_BASE_URL: "https://media.example.test",
      },
    );

    expect(result).toMatchObject({
      sourceRunId: RUN_ID,
      sourceEnvironment: "preprod",
      environment: "preprod",
      warningBudget: 2,
      report: "json",
      migrationsDir: "/migrations",
      runtimeApplicationRelease: "b".repeat(40),
      targetMediaBucket: "platform-media-test",
      mediaCdnBaseUrl: "https://media.example.test",
      sourceTags: {
        auth: "arn:auth",
        booking: "arn:booking",
        marketplace: "arn:marketplace",
        pms: "arn:pms",
      },
    });
  });

  it("rejects a non-local release that differs from trusted deployment metadata", () => {
    expect(() =>
      parseProductionParityArgs(
        [
          "node",
          "parity",
          "--source-run-id",
          RUN_ID,
          "--source-env",
          "preprod",
          "--env",
          "production",
          "--auth-source-tag",
          "auth",
          "--booking-source-tag",
          "booking",
          "--marketplace-source-tag",
          "marketplace",
          "--pms-source-tag",
          "pms",
          "--application-release",
          "b".repeat(40),
        ],
        "/migrations",
        {
          TARGET_DATABASE_URL: "postgresql://target",
          APPLICATION_RELEASE: "c".repeat(40),
          USER: "operator",
        },
      ),
    ).toThrow("deployment metadata");
  });

  it("rejects production as a source extraction environment", () => {
    expect(() =>
      parseProductionParityArgs(
        ["node", "parity", "--source-run-id", RUN_ID, "--source-env", "production"],
        "/migrations",
        {},
      ),
    ).toThrow("Invalid source extraction environment");
  });

  it("does not allow the trusted migration directory to be replaced", () => {
    expect(() =>
      parseProductionParityArgs(
        [
          "node",
          "parity",
          "--source-run-id",
          RUN_ID,
          "--source-env",
          "preprod",
          "--env",
          "production",
          "--migrations-dir",
          "/tmp/operator-controlled-migrations",
        ],
        "/trusted/application/migrations",
        {},
      ),
    ).toThrow("Unknown argument: --migrations-dir");
  });

  it("rejects unknown or malformed threshold arguments", () => {
    expect(() =>
      parseProductionParityArgs(
        ["node", "parity", "--source-run-id", RUN_ID, "--unknown"],
        "/migrations",
        {},
      ),
    ).toThrow("Unknown argument");
    expect(() =>
      parseProductionParityArgs(
        ["node", "parity", "--source-run-id", RUN_ID, "--warning-budget", "-1"],
        "/migrations",
        {},
      ),
    ).toThrow("non-negative integer");
  });
});
