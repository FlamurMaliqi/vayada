import { afterEach, describe, expect, it, vi } from "vitest";

import { createS3PlatformMediaAdapter } from "./platformMediaS3.js";

describe("S3 platform media presigning", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("signs the declared content type without an empty-body checksum", async () => {
    vi.stubEnv("AWS_REGION", "eu-west-1");
    vi.stubEnv("AWS_ACCESS_KEY_ID", "test-access-key");
    vi.stubEnv("AWS_SECRET_ACCESS_KEY", "test-secret-key");

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
      [...new URL(signed.uploadUrl).searchParams].map(([key, value]) => [key.toLowerCase(), value]),
    );

    expect(params["x-amz-checksum-crc32"]).toBeUndefined();
    expect(params["x-amz-sdk-checksum-algorithm"]).toBeUndefined();
    expect(params["x-amz-signedheaders"]).toBe("content-type;host");
    expect(signed.headers).toEqual({ "content-type": "image/jpeg" });
  });
});
