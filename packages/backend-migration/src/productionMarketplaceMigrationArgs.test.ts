import { describe, expect, it } from "vitest";

import { parseProductionMarketplaceMigrationArgs } from "./productionMarketplaceMigrationArgs.js";

const RUN = "vay1351-0123456789abcdef01234567";

describe("production Marketplace migration CLI arguments", () => {
  it("defaults to a dry-run", () => {
    expect(
      parseProductionMarketplaceMigrationArgs(["node", "cli", "--source-run-id", RUN], {
        TARGET_DATABASE_URL: "postgresql://target/db",
      }),
    ).toEqual({
      connectionString: "postgresql://target/db",
      sourceRunId: RUN,
      mode: "dry-run",
    });
  });

  it("requires an exact run-bound apply confirmation", () => {
    expect(() =>
      parseProductionMarketplaceMigrationArgs(["node", "cli", "--source-run-id", RUN, "--apply"], {
        TARGET_DATABASE_URL: "postgresql://target/db",
      }),
    ).toThrow(`--confirm production-marketplace:${RUN}`);
    expect(
      parseProductionMarketplaceMigrationArgs(
        [
          "node",
          "cli",
          "--source-run-id",
          RUN,
          "--apply",
          "--confirm",
          `production-marketplace:${RUN}`,
        ],
        { TARGET_DATABASE_URL: "postgresql://target/db" },
      ).mode,
    ).toBe("apply");
  });

  it("rejects mutable or malformed run identifiers", () => {
    expect(() =>
      parseProductionMarketplaceMigrationArgs(["node", "cli", "--source-run-id", "latest"], {
        TARGET_DATABASE_URL: "postgresql://target/db",
      }),
    ).toThrow("immutable VAY-1351 extraction run ID");
  });
});
