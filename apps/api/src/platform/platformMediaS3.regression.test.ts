import { DeleteObjectCommand, GetObjectCommand, type S3Client } from "@aws-sdk/client-s3";
import { Readable } from "node:stream";
import sharp from "sharp";
import { describe, expect, it, vi } from "vitest";

import type {
  PlatformMediaPurposePolicy,
  PlatformMediaSessionRecord,
} from "../routes/platformMedia.js";
import { createS3PlatformMediaAdapter } from "./platformMediaS3.js";

const sessionId = "session_01J_TEST";
const uploadTargetId = "target_01J_TEST";
const stagingKey = `staging/${sessionId}/1/profile.jpg`;
const policy: PlatformMediaPurposePolicy = {
  purpose: "identity.user.profile_image",
  actorOwned: true,
  allowedRelationships: [],
  allowedResources: [{ product: "platform", resourceType: "user_profile" }],
  allowedContentTypes: ["image/jpeg"],
  allowedExtensions: [".jpg", ".jpeg"],
  maxFileSizeBytes: 5 * 1024 * 1024,
  maxFileCount: 1,
  maxImagePixels: 25_000_000,
  privateOnly: false,
  targetResourceProduct: "platform",
  targetResourceType: "user_profile",
  requiredVariants: [],
};

describe("S3 platform media regressions", () => {
  it("clears inspected bytes when staging cleanup fails", async () => {
    const source = await validJpeg();
    const cleanupError = new Error("cleanup unavailable");
    const client = fakeS3(async (command) => {
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
    const client = fakeS3(async (command) => {
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
    const client = fakeS3(async (command) =>
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

  it("reports missing S3 objects with the upload validation code", async () => {
    const missing = Object.assign(new Error("missing"), {
      name: "NoSuchKey",
      $metadata: { httpStatusCode: 404 },
    });
    const adapter = createAdapter(
      fakeS3(async (command) => {
        if (command instanceof GetObjectCommand) throw missing;
        return {};
      }),
    );
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

  it("propagates S3 inspection failures", async () => {
    const s3Error = new Error("S3 unavailable");
    const adapter = createAdapter(
      fakeS3(async (command) => {
        if (command instanceof GetObjectCommand) throw s3Error;
        return {};
      }),
    );
    const session = profileSession(100);

    await expect(
      adapter.inspectUploadedFile({
        session,
        sessionFile: session.files[0]!,
        uploadTarget: session.uploadTargets[0]!,
        clientFile: { uploadTargetId },
        policy,
      }),
    ).rejects.toBe(s3Error);
  });

  it("propagates a missing-bucket 404 as an infrastructure failure", async () => {
    const s3Error = Object.assign(new Error("bucket missing"), {
      name: "NoSuchBucket",
      $metadata: { httpStatusCode: 404 },
    });
    const adapter = createAdapter(
      fakeS3(async (command) => {
        if (command instanceof GetObjectCommand) throw s3Error;
        return {};
      }),
    );
    const session = profileSession(100);

    await expect(
      adapter.inspectUploadedFile({
        session,
        sessionFile: session.files[0]!,
        uploadTarget: session.uploadTargets[0]!,
        clientFile: { uploadTargetId },
        policy,
      }),
    ).rejects.toBe(s3Error);
  });

  it("still reports malformed image bytes as invalid media", async () => {
    const source = Buffer.from("not an image");
    const adapter = createAdapter(
      fakeS3(async (command) =>
        command instanceof GetObjectCommand
          ? { ContentLength: source.length, Body: Readable.from([source]) }
          : {},
      ),
    );
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
  });

  it("rejects images that have a valid header but fail full decoding", async () => {
    const complete = await validJpeg();
    const source = complete.subarray(0, complete.length - 1);
    const adapter = createAdapter(
      fakeS3(async (command) =>
        command instanceof GetObjectCommand
          ? { ContentLength: source.length, Body: Readable.from([source]) }
          : {},
      ),
    );
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

function createAdapter(s3Client: S3Client) {
  return createS3PlatformMediaAdapter({
    bucketName: "vayada-media-test",
    cdnBaseUrl: "https://cdn.vayada.test",
    publicCacheControl: "public, max-age=31536000, immutable",
    s3Client,
  });
}

function fakeS3(implementation: (command: unknown) => Promise<unknown>): S3Client {
  return { send: vi.fn(implementation) } as unknown as S3Client;
}

function profileSession(sizeBytes: number): PlatformMediaSessionRecord {
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
        filename: "profile.jpg",
        contentType: "image/jpeg",
        sizeBytes,
        uploadTargetId,
        mediaId: "media_01J_TEST",
      },
    ],
    uploadTargets: [
      {
        uploadTargetId,
        clientFileId: "profile",
        method: "PUT",
        uploadUrl: "https://signed-upload.example/profile",
        headers: { "content-type": "image/jpeg" },
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
