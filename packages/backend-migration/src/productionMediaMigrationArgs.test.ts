import { describe, expect, it } from "vitest";

import { parseProductionMediaMigrationArgs } from "./productionMediaMigrationArgs.js";

const RUN = "vay1351-0123456789abcdef01234567";
const environment = {
  TARGET_DATABASE_URL: "postgresql://target.test/migration",
  PLATFORM_MEDIA_BUCKET: "platform-media-test",
  PLATFORM_MEDIA_CDN_BASE_URL: "https://media.example.test",
  LEGACY_PMS_MEDIA_BUCKET: "legacy-pms-test",
  LEGACY_MEDIA_BUCKET_ALLOWLIST: "legacy-booking-test, legacy-pms-test",
};

describe("production media migration arguments", () => {
  it("defaults to a non-mutating dry run", () => {
    expect(
      parseProductionMediaMigrationArgs(["node", "media", "--source-run-id", RUN], environment),
    ).toMatchObject({
      sourceRunId: RUN,
      mode: "dry-run",
      targetBucket: "platform-media-test",
      allowedLegacyBuckets: ["legacy-booking-test", "legacy-pms-test"],
    });
  });

  it("requires the exact immutable run confirmation before apply", () => {
    expect(() =>
      parseProductionMediaMigrationArgs(
        ["node", "media", "--source-run-id", RUN, "--apply"],
        environment,
      ),
    ).toThrow(`--apply requires --confirm production-media:${RUN}`);
    expect(
      parseProductionMediaMigrationArgs(
        [
          "node",
          "media",
          "--source-run-id",
          RUN,
          "--apply",
          "--confirm",
          `production-media:${RUN}`,
        ],
        environment,
      ).mode,
    ).toBe("apply");
  });

  it("fails closed without the reviewed legacy bucket allowlist", () => {
    expect(() =>
      parseProductionMediaMigrationArgs(["node", "media", "--source-run-id", RUN], {
        ...environment,
        LEGACY_MEDIA_BUCKET_ALLOWLIST: "",
      }),
    ).toThrow("LEGACY_MEDIA_BUCKET_ALLOWLIST is required");
  });
});
