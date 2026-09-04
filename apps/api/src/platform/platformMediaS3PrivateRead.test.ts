import { GetObjectCommand, type S3Client } from "@aws-sdk/client-s3";
import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";

import {
  createS3PlatformMediaAdapter,
  PlatformMediaObjectIntegrityError,
} from "./platformMediaS3.js";

describe("S3 platform media private-object reads", () => {
  it("returns only bytes matching the finalized media evidence", async () => {
    const bytes = new Uint8Array([1, 2, 3]);
    const send = vi.fn(async (command: unknown) => {
      expect(command).toBeInstanceOf(GetObjectCommand);
      expect((command as GetObjectCommand).input).toEqual({
        Bucket: "media-test",
        Key: "private/pms/messages/file.pdf",
      });
      return { Body: bytes, ContentLength: bytes.length };
    });

    const loaded = await adapter(send).readPrivateObject(input(bytes));
    expect([...loaded]).toEqual([...bytes]);
  });

  it("rejects cross-bucket, public, and integrity-mismatched reads", async () => {
    const bytes = new Uint8Array([1, 2, 3]);
    const send = vi.fn(async () => ({ Body: bytes, ContentLength: bytes.length }));
    const reader = adapter(send);

    await expect(
      reader.readPrivateObject({ ...input(bytes), bucketName: "foreign" }),
    ).rejects.toThrow("bucket");
    await expect(
      reader.readPrivateObject({ ...input(bytes), storageKey: "public/file.pdf" }),
    ).rejects.toThrow("private prefix");
    await expect(
      reader.readPrivateObject({ ...input(bytes), expectedChecksumSha256: "0".repeat(64) }),
    ).rejects.toBeInstanceOf(PlatformMediaObjectIntegrityError);
    expect(send).toHaveBeenCalledOnce();
  });

  it("classifies a missing private object as permanent integrity failure", async () => {
    const missing = new Error("missing");
    missing.name = "NoSuchKey";
    const reader = createS3PlatformMediaAdapter({
      bucketName: "media-test",
      cdnBaseUrl: "https://media.example.test",
      publicCacheControl: "public, max-age=60",
      s3Client: { send: vi.fn(async () => Promise.reject(missing)) } as never,
    });

    await expect(reader.readPrivateObject(input(new Uint8Array([1])))).rejects.toBeInstanceOf(
      PlatformMediaObjectIntegrityError,
    );
  });
});

function adapter(send: ReturnType<typeof vi.fn>) {
  return createS3PlatformMediaAdapter({
    bucketName: "media-test",
    cdnBaseUrl: "https://cdn.example.test",
    publicCacheControl: "public, max-age=31536000, immutable",
    s3Client: { send } as unknown as S3Client,
  });
}

function input(bytes: Uint8Array) {
  return {
    bucketName: "media-test",
    storageKey: "private/pms/messages/file.pdf",
    expectedSizeBytes: bytes.length,
    expectedChecksumSha256: createHash("sha256").update(bytes).digest("hex"),
  };
}
