import {
  DeleteObjectCommand,
  GetObjectCommand,
  PutObjectCommand,
  type S3Client,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { createHash } from "node:crypto";
import { Readable } from "node:stream";
import sharp from "sharp";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type {
  PlatformMediaPurposePolicy,
  PlatformMediaSessionRecord,
} from "../routes/platformMedia.js";
import { createS3PlatformMediaAdapter } from "./platformMediaS3.js";

vi.mock("@aws-sdk/s3-request-presigner", () => ({ getSignedUrl: vi.fn() }));

const bucketName = "vayada-media-test";
const mediaId = "media_01J_TEST";
const sessionId = "session_01J_TEST";
const uploadTargetId = "target_01J_TEST";
const stagingKey = `staging/${sessionId}/1/profile.jpg`;
const cacheControl = "public, max-age=31536000, immutable";

const policy: PlatformMediaPurposePolicy = {
  purpose: "identity.user.profile_image",
  actorOwned: true,
  allowedRelationships: [],
  allowedResources: [{ product: "platform", resourceType: "user_profile" }],
  allowedContentTypes: ["image/jpeg", "image/png", "image/webp"],
  allowedExtensions: [".jpg", ".jpeg", ".png", ".webp"],
  maxFileSizeBytes: 5 * 1024 * 1024,
  maxFileCount: 1,
  maxImagePixels: 60_000_000,
  privateOnly: false,
  targetResourceProduct: "platform",
  targetResourceType: "user_profile",
  requiredVariants: ["original_safe", "large", "thumbnail", "blur_preview"],
};

describe("S3 platform profile media adapter", () => {
  beforeEach(() => vi.clearAllMocks());

  it("signs a staging PUT with the configured bucket and declared content type", async () => {
    vi.mocked(getSignedUrl).mockResolvedValue("https://signed-upload.example/profile");
    const { client } = fakeS3(async () => ({}));
    const adapter = createAdapter(client);
    const expiresAt = new Date(Date.now() + 15 * 60 * 1000).toISOString();

    await expect(
      adapter.signUploadTarget({
        sessionId,
        uploadTargetId,
        stagingKey,
        contentType: "image/jpeg",
        sizeBytes: 1024,
        expiresAt,
      }),
    ).resolves.toEqual({
      uploadTargetId,
      method: "PUT",
      uploadUrl: "https://signed-upload.example/profile",
      headers: { "content-type": "image/jpeg" },
      expiresAt,
    });

    const [, command, signingOptions] = vi.mocked(getSignedUrl).mock.calls[0]!;
    expect(command).toBeInstanceOf(PutObjectCommand);
    expect((command as PutObjectCommand).input).toEqual({
      Bucket: bucketName,
      Key: stagingKey,
      ContentType: "image/jpeg",
    });
    expect(signingOptions?.expiresIn).toBeGreaterThan(0);
    expect(signingOptions?.expiresIn).toBeLessThanOrEqual(15 * 60);
    expect(signingOptions?.signableHeaders).toEqual(new Set(["content-type"]));
  });

  it("decodes actual bytes and writes stripped immutable WebP variants", async () => {
    const source = await sharp({
      create: { width: 120, height: 80, channels: 3, background: "#2345aa" },
    })
      .jpeg()
      .withMetadata({ orientation: 6 })
      .toBuffer();
    const { client, send } = fakeS3(async (command) => {
      if (command instanceof GetObjectCommand) {
        return { ContentLength: source.length, Body: Readable.from([source]) };
      }
      return {};
    });
    const publicPathPrefix = "profile-media";
    const adapter = createAdapter(client, publicPathPrefix);
    const session = profileSession(source.length);
    const sessionFile = session.files[0]!;
    const uploadTarget = session.uploadTargets[0]!;

    const inspected = await adapter.inspectUploadedFile({
      session,
      sessionFile,
      uploadTarget,
      clientFile: { uploadTargetId },
      policy,
    });
    expect(inspected).toMatchObject({
      ok: true,
      inspection: {
        contentType: "image/jpeg",
        sizeBytes: source.length,
        widthPx: 80,
        heightPx: 120,
      },
    });
    if (!inspected.ok) throw new Error("Expected profile image inspection to succeed");

    const variants = await adapter.generateVariants({
      session,
      file: { sessionFile, uploadTarget, inspection: inspected.inspection },
      fileIndex: 0,
      policy,
    });

    expect(variants.map(({ variantName }) => variantName)).toEqual(policy.requiredVariants);
    for (const variant of variants) {
      expect(variant.storageKey).toMatch(
        new RegExp(
          `^public/${publicPathPrefix}/${mediaId}/${variant.variantName}/sha256-[a-f0-9]{64}\\.webp$`,
        ),
      );
      expect(variant.publicCdnUrl).toBe(
        `https://cdn.vayada.test/${variant.storageKey.slice("public/".length)}`,
      );
      expect(variant.storageKey).toContain(`sha256-${variant.checksumSha256}`);
      expect(variant).toMatchObject({ contentType: "image/webp", visibility: "public" });
    }

    expect(send.mock.calls.some(([command]) => command instanceof DeleteObjectCommand)).toBe(false);
    await adapter.cleanupUploadedFile!({
      session,
      file: { sessionFile, uploadTarget, inspection: inspected.inspection },
    });

    const commands = send.mock.calls.map(([command]) => command);
    const get = commands.find(
      (command): command is GetObjectCommand => command instanceof GetObjectCommand,
    );
    expect(get?.input).toEqual({ Bucket: bucketName, Key: stagingKey });
    const puts = commands.filter(
      (command): command is PutObjectCommand => command instanceof PutObjectCommand,
    );
    expect(puts).toHaveLength(4);
    for (const [index, put] of puts.entries()) {
      const variant = variants[index]!;
      expect(put.input).toMatchObject({
        Bucket: bucketName,
        Key: variant.storageKey,
        ContentType: "image/webp",
        CacheControl: cacheControl,
      });
      const body = put.input.Body as Buffer;
      expect(createHash("sha256").update(body).digest("hex")).toBe(variant.checksumSha256);
      const metadata = await sharp(body).metadata();
      expect(metadata.format).toBe("webp");
      expect(metadata.exif).toBeUndefined();
      expect(metadata.orientation).toBeUndefined();
      if (variant.variantName === "original_safe") {
        expect(metadata).toMatchObject({ width: 80, height: 120 });
      }
    }
    const cleanup = commands.at(-1);
    expect(cleanup).toBeInstanceOf(DeleteObjectCommand);
    expect((cleanup as DeleteObjectCommand).input).toEqual({
      Bucket: bucketName,
      Key: stagingKey,
    });
  });

  it("decodes PNG and WebP bytes using their signed content types", async () => {
    const image = sharp({
      create: { width: 20, height: 20, channels: 3, background: "#334455" },
    });
    const cases = [
      { contentType: "image/png", source: await image.clone().png().toBuffer() },
      { contentType: "image/webp", source: await image.clone().webp().toBuffer() },
    ] as const;

    for (const { contentType, source } of cases) {
      const { client } = fakeS3(async (command) =>
        command instanceof GetObjectCommand
          ? { ContentLength: source.length, Body: Readable.from([source]) }
          : {},
      );
      const adapter = createAdapter(client);
      const session = profileSession(source.length, contentType);

      await expect(
        adapter.inspectUploadedFile({
          session,
          sessionFile: session.files[0]!,
          uploadTarget: session.uploadTargets[0]!,
          clientFile: { uploadTargetId },
          policy,
        }),
      ).resolves.toMatchObject({ ok: true, inspection: { contentType } });
    }
  });

  it("rejects image bytes that do not match the signed content type", async () => {
    const source = await sharp({
      create: { width: 20, height: 20, channels: 3, background: "#334455" },
    })
      .png()
      .toBuffer();
    const { client } = fakeS3(async (command) =>
      command instanceof GetObjectCommand
        ? { ContentLength: source.length, Body: Readable.from([source]) }
        : {},
    );
    const adapter = createAdapter(client);
    const session = profileSession(source.length);

    await expect(
      adapter.inspectUploadedFile({
        session,
        sessionFile: session.files[0]!,
        uploadTarget: session.uploadTargets[0]!,
        clientFile: { uploadTargetId },
        policy,
      }),
    ).resolves.toMatchObject({ ok: false, code: "media_type_mismatch" });
  });

  it("clears inspected bytes when staging cleanup fails", async () => {
    const source = await validJpeg();
    const cleanupError = new Error("cleanup unavailable");
    const { client } = fakeS3(async (command) => {
      if (command instanceof GetObjectCommand) {
        return { ContentLength: source.length, Body: Readable.from([source]) };
      }
      if (command instanceof DeleteObjectCommand) throw cleanupError;
      return {};
    });
    const adapter = createAdapter(client);
    const { session, file } = await inspectValidUpload(adapter, source);

    await expect(adapter.cleanupUploadedFile!({ session, file })).rejects.toBe(cleanupError);
    await expect(adapter.generateVariants({ session, file, fileIndex: 0, policy })).rejects.toThrow(
      "Profile image must be inspected before variants are generated",
    );
  });

  it("clears inspected bytes before staging cleanup settles", async () => {
    const source = await validJpeg();
    const { client } = fakeS3(async (command) => {
      if (command instanceof GetObjectCommand) {
        return { ContentLength: source.length, Body: Readable.from([source]) };
      }
      if (command instanceof DeleteObjectCommand) return new Promise<never>(() => undefined);
      return {};
    });
    const adapter = createAdapter(client);
    const { session, file } = await inspectValidUpload(adapter, source);

    void adapter.cleanupUploadedFile!({ session, file });

    await expect(adapter.generateVariants({ session, file, fileIndex: 0, policy })).rejects.toThrow(
      "Profile image must be inspected before variants are generated",
    );
  });

  it("clears inspected bytes when variant generation rejects private visibility", async () => {
    const source = await validJpeg();
    const { client } = fakeS3(async (command) =>
      command instanceof GetObjectCommand
        ? { ContentLength: source.length, Body: Readable.from([source]) }
        : {},
    );
    const adapter = createAdapter(client);
    const { session, file } = await inspectValidUpload(adapter, source);

    await expect(
      adapter.generateVariants({
        session: { ...session, effectiveVisibility: "private" },
        file,
        fileIndex: 0,
        policy,
      }),
    ).rejects.toThrow("Profile image variants require public visibility");
    await expect(adapter.generateVariants({ session, file, fileIndex: 0, policy })).rejects.toThrow(
      "Profile image must be inspected before variants are generated",
    );
  });

  it("reports a missing staged object with the upload validation code", async () => {
    const missing = Object.assign(new Error("missing"), {
      name: "NoSuchKey",
      $metadata: { httpStatusCode: 404 },
    });
    const { client } = fakeS3(async (command) => {
      if (command instanceof GetObjectCommand) throw missing;
      return {};
    });
    const adapter = createAdapter(client);
    const session = profileSession(100);

    await expect(
      adapter.inspectUploadedFile({
        session,
        sessionFile: session.files[0]!,
        uploadTarget: session.uploadTargets[0]!,
        clientFile: { uploadTargetId },
        policy,
      }),
    ).resolves.toMatchObject({ ok: false, code: "media_upload_missing" });
  });

  it("propagates S3 infrastructure failures", async () => {
    const failures = [
      new Error("S3 unavailable"),
      Object.assign(new Error("bucket missing"), {
        name: "NoSuchBucket",
        $metadata: { httpStatusCode: 404 },
      }),
    ];

    for (const failure of failures) {
      const { client } = fakeS3(async (command) => {
        if (command instanceof GetObjectCommand) throw failure;
        return {};
      });
      const adapter = createAdapter(client);
      const session = profileSession(100);

      await expect(
        adapter.inspectUploadedFile({
          session,
          sessionFile: session.files[0]!,
          uploadTarget: session.uploadTargets[0]!,
          clientFile: { uploadTargetId },
          policy,
        }),
      ).rejects.toBe(failure);
    }
  });

  it("rejects malformed and truncated image bytes", async () => {
    const complete = await validJpeg();
    const sources = [Buffer.from("not an image"), complete.subarray(0, complete.length - 1)];

    for (const source of sources) {
      const { client } = fakeS3(async (command) =>
        command instanceof GetObjectCommand
          ? { ContentLength: source.length, Body: Readable.from([source]) }
          : {},
      );
      const adapter = createAdapter(client);
      const session = profileSession(source.length);

      await expect(
        adapter.inspectUploadedFile({
          session,
          sessionFile: session.files[0]!,
          uploadTarget: session.uploadTargets[0]!,
          clientFile: { uploadTargetId },
          policy,
        }),
      ).resolves.toMatchObject({ ok: false, code: "invalid_media_image" });
    }
  });

  it("rejects an oversized S3 object before reading its body", async () => {
    const transformToByteArray = vi.fn(async () => new Uint8Array());
    const { client } = fakeS3(async (command) =>
      command instanceof GetObjectCommand
        ? { ContentLength: policy.maxFileSizeBytes + 1, Body: { transformToByteArray } }
        : {},
    );
    const adapter = createAdapter(client);
    const session = profileSession(policy.maxFileSizeBytes);

    await expect(
      adapter.inspectUploadedFile({
        session,
        sessionFile: session.files[0]!,
        uploadTarget: session.uploadTargets[0]!,
        clientFile: { uploadTargetId },
        policy,
      }),
    ).resolves.toMatchObject({ ok: false, code: "media_file_too_large" });
    expect(transformToByteArray).not.toHaveBeenCalled();
  });

  it("stops reading a streamed object when its bytes cross the signed limit", async () => {
    const smallPolicy = { ...policy, maxFileSizeBytes: 4 };
    const next = vi
      .fn()
      .mockResolvedValueOnce({ value: Buffer.alloc(3), done: false })
      .mockResolvedValueOnce({ value: Buffer.alloc(2), done: false })
      .mockResolvedValueOnce({ value: Buffer.alloc(1), done: false });
    const body = { [Symbol.asyncIterator]: () => ({ next }) };
    const { client } = fakeS3(async (command) =>
      command instanceof GetObjectCommand ? { Body: body } : {},
    );
    const adapter = createAdapter(client);
    const session = profileSession(4);

    await expect(
      adapter.inspectUploadedFile({
        session,
        sessionFile: session.files[0]!,
        uploadTarget: session.uploadTargets[0]!,
        clientFile: { uploadTargetId },
        policy: smallPolicy,
      }),
    ).resolves.toMatchObject({ ok: false, code: "media_file_too_large" });
    expect(next).toHaveBeenCalledTimes(2);
  });

  it("rejects a streamed object that finishes smaller than the signed upload", async () => {
    const source = await validJpeg();
    const { client } = fakeS3(async (command) =>
      command instanceof GetObjectCommand ? { Body: Readable.from([source]) } : {},
    );
    const adapter = createAdapter(client);
    const session = profileSession(source.length + 1);

    await expect(
      adapter.inspectUploadedFile({
        session,
        sessionFile: session.files[0]!,
        uploadTarget: session.uploadTargets[0]!,
        clientFile: { uploadTargetId },
        policy,
      }),
    ).resolves.toMatchObject({ ok: false, code: "media_size_mismatch" });
  });

  it("returns the finalize contract's specific mismatch codes", async () => {
    const source = await validJpeg();
    const cases = [
      [{ contentType: "image/png" }, "media_type_mismatch"],
      [{ sizeBytes: source.length + 1 }, "media_size_mismatch"],
      [{ checksumSha256: "0".repeat(64) }, "media_checksum_mismatch"],
    ] as const;

    for (const [finalizeMetadata, code] of cases) {
      const { client } = fakeS3(async (command) =>
        command instanceof GetObjectCommand
          ? { ContentLength: source.length, Body: Readable.from([source]) }
          : {},
      );
      const adapter = createAdapter(client);
      const session = profileSession(source.length);
      await expect(
        adapter.inspectUploadedFile({
          session,
          sessionFile: session.files[0]!,
          uploadTarget: session.uploadTargets[0]!,
          clientFile: { uploadTargetId, ...finalizeMetadata },
          policy,
        }),
      ).resolves.toMatchObject({ ok: false, code });
    }
  });

  it("rejects unsupported production purposes before reading from S3", async () => {
    const { client, send } = fakeS3(async () => ({}));
    const adapter = createAdapter(client);
    const session = profileSession(100);
    const unsupportedPolicy = {
      ...policy,
      purpose: "property.hero_image" as const,
    };
    const unsupportedSession = {
      ...session,
      purpose: "property.hero_image" as const,
    };
    await expect(
      adapter.inspectUploadedFile({
        session: unsupportedSession,
        sessionFile: unsupportedSession.files[0]!,
        uploadTarget: unsupportedSession.uploadTargets[0]!,
        clientFile: { uploadTargetId },
        policy: unsupportedPolicy,
      }),
    ).resolves.toMatchObject({ ok: false, code: "unsupported_media_purpose" });
    expect(send).not.toHaveBeenCalled();
  });
});

async function inspectValidUpload(
  adapter: ReturnType<typeof createS3PlatformMediaAdapter>,
  source: Buffer,
) {
  const session = profileSession(source.length);
  const sessionFile = session.files[0]!;
  const uploadTarget = session.uploadTargets[0]!;
  const inspected = await adapter.inspectUploadedFile({
    session,
    sessionFile,
    uploadTarget,
    clientFile: { uploadTargetId },
    policy,
  });
  if (!inspected.ok) throw new Error("Expected profile image inspection to succeed");
  return {
    session,
    file: { sessionFile, uploadTarget, inspection: inspected.inspection },
  };
}

function validJpeg(): Promise<Buffer> {
  return sharp({
    create: { width: 20, height: 20, channels: 3, background: "#334455" },
  })
    .jpeg()
    .toBuffer();
}

function createAdapter(s3Client: S3Client, publicPathPrefix = "media") {
  return createS3PlatformMediaAdapter({
    bucketName,
    cdnBaseUrl: "https://cdn.vayada.test",
    publicPathPrefix,
    publicCacheControl: cacheControl,
    s3Client,
  });
}

function fakeS3(implementation: (command: unknown) => Promise<unknown>) {
  const send = vi.fn(implementation);
  return { client: { send } as unknown as S3Client, send };
}

function profileSession(
  sizeBytes: number,
  contentType: "image/jpeg" | "image/png" | "image/webp" = "image/jpeg",
): PlatformMediaSessionRecord {
  const extension = contentType === "image/jpeg" ? "jpg" : contentType.slice("image/".length);
  return {
    sessionId,
    uploadSessionKey: `media.upload_session:${sessionId}`,
    purpose: "identity.user.profile_image",
    requestedVisibility: "public",
    effectiveVisibility: "public",
    actorUserId: "user_01J_TEST",
    ownerOrganizationId: "org_01J_TEST",
    resource: {
      product: "platform",
      resourceType: "user_profile",
      resourceId: "user_01J_TEST",
    },
    target: {
      resourceProduct: "platform",
      resourceType: "user_profile",
      resourceId: "user_01J_TEST",
    },
    files: [
      {
        clientFileId: "profile",
        filename: `profile.${extension}`,
        contentType,
        sizeBytes,
        uploadTargetId,
        mediaId,
      },
    ],
    uploadTargets: [
      {
        uploadTargetId,
        clientFileId: "profile",
        method: "PUT",
        uploadUrl: "https://signed-upload.example/profile",
        headers: { "content-type": contentType },
        stagingKey,
        expiresAt: new Date(Date.now() + 15 * 60 * 1000).toISOString(),
      },
    ],
    stagingPrefix: `staging/${sessionId}`,
    status: "signed",
    expiresAt: new Date(Date.now() + 15 * 60 * 1000).toISOString(),
    createdAt: new Date().toISOString(),
  };
}
