import { describe, expect, it } from "vitest";

import { parseProductionPmsMigrationArgs } from "./productionPmsMigrationArgs.js";

const RUN = "vay1351-0123456789abcdef01234567";

describe("production PMS migration CLI arguments", () => {
  it("defaults to a dry-run", () => {
    expect(
      parseProductionPmsMigrationArgs(["node", "cli", "--source-run-id", RUN], {
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
      parseProductionPmsMigrationArgs(["node", "cli", "--source-run-id", RUN, "--apply"], {
        TARGET_DATABASE_URL: "postgresql://target/db",
      }),
    ).toThrow(`--confirm production-pms:${RUN}`);
    expect(
      parseProductionPmsMigrationArgs(
        ["node", "cli", "--source-run-id", RUN, "--apply", "--confirm", `production-pms:${RUN}`],
        { TARGET_DATABASE_URL: "postgresql://target/db" },
      ).mode,
    ).toBe("apply");
  });

  it("rejects mutable or malformed run identifiers", () => {
    expect(() =>
      parseProductionPmsMigrationArgs(["node", "cli", "--source-run-id", "latest"], {
        TARGET_DATABASE_URL: "postgresql://target/db",
      }),
    ).toThrow("immutable VAY-1351 extraction run ID");
  });
});
