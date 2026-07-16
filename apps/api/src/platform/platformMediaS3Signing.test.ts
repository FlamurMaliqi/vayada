import { describe, expect, it } from "vitest";

import { createS3PlatformMediaAdapter } from "./platformMediaS3.js";

describe("S3 platform media presigning", () => {
  it("signs the declared content type without an empty-body checksum", async () => {
    const previous = {
      AWS_REGION: process.env["AWS_REGION"],
      AWS_ACCESS_KEY_ID: process.env["AWS_ACCESS_KEY_ID"],
      AWS_SECRET_ACCESS_KEY: process.env["AWS_SECRET_ACCESS_KEY"],
    };
    process.env["AWS_REGION"] = "eu-west-1";
    process.env["AWS_ACCESS_KEY_ID"] = "test-access-key";
    process.env["AWS_SECRET_ACCESS_KEY"] = "test-secret-key";

    try {
      const adapter = createS3PlatformMediaAdapter({
        bucketName: "vayada-media-test",
        cdnBaseUrl: "https://cdn.vayada.test",
        publicCacheControl: "public, max-age=31536000, immutable",
      });
      const signed = await adapter.signUploadTarget({
        sessionId: "session-signing-test",
        uploadTargetId: "target-signing-test",
        stagingKey: "staging/session-signing-test/1/profile.jpg",
        contentType: "image/jpeg",
        sizeBytes: 1024,
        expiresAt: new Date(Date.now() + 15 * 60 * 1000).toISOString(),
      });
      const params = Object.fromEntries(
        [...new URL(signed.uploadUrl).searchParams].map(([key, value]) => [
          key.toLowerCase(),
          value,
        ]),
      );

      expect(params["x-amz-checksum-crc32"]).toBeUndefined();
      expect(params["x-amz-sdk-checksum-algorithm"]).toBeUndefined();
      expect(params["x-amz-signedheaders"]).toBe("content-type;host");
      expect(signed.headers).toEqual({ "content-type": "image/jpeg" });
    } finally {
      restoreEnv("AWS_REGION", previous.AWS_REGION);
      restoreEnv("AWS_ACCESS_KEY_ID", previous.AWS_ACCESS_KEY_ID);
      restoreEnv("AWS_SECRET_ACCESS_KEY", previous.AWS_SECRET_ACCESS_KEY);
    }
  });
});

function restoreEnv(key: string, value: string | undefined): void {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}
