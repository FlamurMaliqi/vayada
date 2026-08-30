import { describe, expect, it } from "vitest";

import { parseProductionCatalogMigrationArgs } from "./productionCatalogMigrationArgs.js";

const RUN = "vay1351-0123456789abcdef01234567";
const URL = "postgresql://localhost/vayada_target_test";

describe("production catalog migration arguments", () => {
  it("defaults to dry-run with the target URL from the environment", () => {
    expect(
      parseProductionCatalogMigrationArgs(["node", "catalog", "--source-run-id", RUN], {
        TARGET_DATABASE_URL: URL,
      }),
    ).toEqual({ connectionString: URL, sourceRunId: RUN, mode: "dry-run" });
  });

  it("binds apply confirmation to the immutable source run", () => {
    expect(() =>
      parseProductionCatalogMigrationArgs(["node", "catalog", "--source-run-id", RUN, "--apply"], {
        TARGET_DATABASE_URL: URL,
      }),
    ).toThrow(`--apply requires --confirm production-catalog:${RUN}`);
    expect(
      parseProductionCatalogMigrationArgs(
        [
          "node",
          "catalog",
          "--source-run-id",
          RUN,
          "--apply",
          "--confirm",
          `production-catalog:${RUN}`,
        ],
        { TARGET_DATABASE_URL: URL },
      ).mode,
    ).toBe("apply");
  });

  it("rejects mutable, ambiguous, and unknown inputs without echoing credentials", () => {
    expect(() =>
      parseProductionCatalogMigrationArgs(["node", "catalog", "--source-run-id", "latest"], {
        TARGET_DATABASE_URL: URL,
      }),
    ).toThrow("immutable VAY-1351");
    expect(() =>
      parseProductionCatalogMigrationArgs(
        ["node", "catalog", "--source-run-id", RUN, "--apply", "--dry-run"],
        { TARGET_DATABASE_URL: URL },
      ),
    ).toThrow("exactly one");
    const credential = "postgresql://admin:secret@production.example/vayada";
    try {
      parseProductionCatalogMigrationArgs(["node", "catalog", "--source-run-id", RUN, credential], {
        TARGET_DATABASE_URL: URL,
      });
      throw new Error("expected parsing to fail");
    } catch (error) {
      expect((error as Error).message).toBe("Unknown argument");
      expect((error as Error).message).not.toContain(credential);
    }
  });
});
