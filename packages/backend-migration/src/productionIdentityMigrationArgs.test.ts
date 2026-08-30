import { describe, expect, it } from "vitest";

import { parseProductionIdentityMigrationArgs } from "./productionIdentityMigrationArgs.js";

const RUN = "vay1351-0123456789abcdef01234567";
const URL = "postgresql://localhost/vayada_target_test";

describe("production identity migration arguments", () => {
  it("defaults to dry-run and reads the target URL from the environment", () => {
    expect(
      parseProductionIdentityMigrationArgs(["node", "identity", "--source-run-id", RUN], {
        TARGET_DATABASE_URL: URL,
      }),
    ).toEqual({ connectionString: URL, sourceRunId: RUN, mode: "dry-run" });
  });

  it("requires apply confirmation bound to the immutable source run", () => {
    expect(() =>
      parseProductionIdentityMigrationArgs(
        ["node", "identity", "--source-run-id", RUN, "--apply"],
        { TARGET_DATABASE_URL: URL },
      ),
    ).toThrow(`--apply requires --confirm production-identity:${RUN}`);
    expect(
      parseProductionIdentityMigrationArgs(
        [
          "node",
          "identity",
          "--source-run-id",
          RUN,
          "--apply",
          "--confirm",
          `production-identity:${RUN}`,
        ],
        { TARGET_DATABASE_URL: URL },
      ).mode,
    ).toBe("apply");
  });

  it("rejects ambiguous, unknown, incomplete, and mutable inputs", () => {
    expect(() =>
      parseProductionIdentityMigrationArgs(
        ["node", "identity", "--source-run-id", RUN, "--apply", "--dry-run"],
        { TARGET_DATABASE_URL: URL },
      ),
    ).toThrow("exactly one");
    const credential = "postgresql://admin:secret@production.example/vayada";
    try {
      parseProductionIdentityMigrationArgs(
        ["node", "identity", "--source-run-id", RUN, credential],
        { TARGET_DATABASE_URL: URL },
      );
      throw new Error("expected parsing to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toBe("Unknown argument");
      expect((error as Error).message).not.toContain(credential);
    }
    expect(() =>
      parseProductionIdentityMigrationArgs(["node", "identity", "--source-run-id"], {
        TARGET_DATABASE_URL: URL,
      }),
    ).toThrow("requires a value");
    expect(() =>
      parseProductionIdentityMigrationArgs(["node", "identity", "--source-run-id", "latest"], {
        TARGET_DATABASE_URL: URL,
      }),
    ).toThrow("immutable VAY-1351");
  });
});
