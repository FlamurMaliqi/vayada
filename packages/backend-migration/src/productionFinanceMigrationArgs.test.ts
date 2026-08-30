import { describe, expect, it } from "vitest";

import { parseProductionFinanceMigrationArgs } from "./productionFinanceMigrationArgs.js";

const RUN = "vay1351-0123456789abcdef01234567";

describe("production Finance migration CLI arguments", () => {
  it("defaults to dry-run and requires exact apply confirmation", () => {
    expect(
      parseProductionFinanceMigrationArgs(["node", "cli", "--source-run-id", RUN], {
        TARGET_DATABASE_URL: "postgresql://target/db",
      }),
    ).toMatchObject({ sourceRunId: RUN, mode: "dry-run" });
    expect(() =>
      parseProductionFinanceMigrationArgs(["node", "cli", "--source-run-id", RUN, "--apply"], {
        TARGET_DATABASE_URL: "postgresql://target/db",
      }),
    ).toThrow(`--confirm production-finance:${RUN}`);
    expect(
      parseProductionFinanceMigrationArgs(
        [
          "node",
          "cli",
          "--source-run-id",
          RUN,
          "--apply",
          "--confirm",
          `production-finance:${RUN}`,
        ],
        { TARGET_DATABASE_URL: "postgresql://target/db" },
      ).mode,
    ).toBe("apply");
  });

  it("rejects mutable extraction aliases", () => {
    expect(() =>
      parseProductionFinanceMigrationArgs(["node", "cli", "--source-run-id", "latest"], {
        TARGET_DATABASE_URL: "postgresql://target/db",
      }),
    ).toThrow("immutable VAY-1351 extraction run ID");
  });
});
