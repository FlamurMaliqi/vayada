import {
  DeleteObjectCommand,
  GetObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  type S3Client,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { createHash } from "node:crypto";
import { Readable } from "node:stream";
import sharp from "sharp";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  PlatformMediaStagingChangedError,
  type PlatformMediaPurposePolicy,
  type PlatformMediaSessionRecord,
} from "../routes/platformMedia.js";
import { createS3PlatformMediaAdapter } from "./platformMediaS3.js";

vi.mock("@aws-sdk/s3-request-presigner", () => ({ getSignedUrl: vi.fn() }));

const bucketName = "vayada-media-test";
const mediaId = "media_01J_TEST";
const sessionId = "session_01J_TEST";
const uploadTargetId = "target_01J_TEST";
const stagingKey = `staging/${sessionId}/1/profile.jpg`;
const cacheControl = "public, max-age=31536000, immutable";
const privateCacheControl = "private, no-store";

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
  autoApprovePublicOnFinalize: true,
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

  it("signs images up to the chat attachment limit while rejecting larger uploads", async () => {
    vi.mocked(getSignedUrl).mockResolvedValue("https://signed-upload.example/offer");
    const { client } = fakeS3(async () => ({}));
    const adapter = createAdapter(client);
    const expiresAt = new Date(Date.now() + 15 * 60 * 1000).toISOString();

    await expect(
      adapter.signUploadTarget({
        sessionId,
        uploadTargetId,
        stagingKey,
        contentType: "image/jpeg",
        sizeBytes: 20 * 1024 * 1024,
        expiresAt,
      }),
    ).resolves.toMatchObject({ uploadTargetId });
    await expect(
      adapter.signUploadTarget({
        sessionId,
        uploadTargetId,
        stagingKey,
        contentType: "image/jpeg",
        sizeBytes: 20 * 1024 * 1024 + 1,
        expiresAt,
      }),
    ).rejects.toThrow("between 1 byte and 20 MB");
  });

  it("deletes cleanup objects and every page in a staging prefix", async () => {
    let listedPages = 0;
    const { client, send } = fakeS3(async (command) => {
      if (command instanceof ListObjectsV2Command) {
        listedPages += 1;
        return listedPages === 1
          ? {
              Contents: [{ Key: `${stagingKey}.one` }, { Key: `${stagingKey}.two` }],
              IsTruncated: true,
              NextContinuationToken: "page-2",
            }
          : { Contents: [{ Key: `${stagingKey}.three` }], IsTruncated: false };
      }
      return {};
    });
    const adapter = createAdapter(client);

    await adapter.deleteObject({
      bucket: "legacy-vayada-media",
      storageKey: "legacy/properties/hotel/hero.jpg",
    });
    await adapter.deletePrefix({ prefix: `staging/${sessionId}` });

    const commands = send.mock.calls.map(([command]) => command);
    expect(commands[0]).toBeInstanceOf(DeleteObjectCommand);
    expect((commands[0] as DeleteObjectCommand).input).toEqual({
      Bucket: "legacy-vayada-media",
      Key: "legacy/properties/hotel/hero.jpg",
    });
    const listings = commands.filter(
      (command): command is ListObjectsV2Command => command instanceof ListObjectsV2Command,
    );
    expect(listings.map(({ input }) => input)).toEqual([
      {
        Bucket: bucketName,
        Prefix: `staging/${sessionId}`,
        ContinuationToken: undefined,
      },
      {
        Bucket: bucketName,
        Prefix: `staging/${sessionId}`,
        ContinuationToken: "page-2",
      },
    ]);
    expect(
      commands
        .filter((command): command is DeleteObjectCommand => command instanceof DeleteObjectCommand)
        .slice(1)
        .map(({ input }) => input),
    ).toEqual(
      ["one", "two", "three"].map((suffix) => ({
        Bucket: bucketName,
        Key: `${stagingKey}.${suffix}`,
      })),
    );
  });

  it.each(["private/", "staging/"])(
    "refuses unsafe or broad prefix cleanup for %s",
    async (prefix) => {
      const { client, send } = fakeS3(async () => ({}));
      const adapter = createAdapter(client);

      await expect(adapter.deletePrefix({ prefix })).rejects.toThrow(
        "restricted to staging namespaces",
      );
      expect(send).not.toHaveBeenCalled();
    },
  );

  it("preserves private chat bytes and signs short-lived GET access", async () => {
    const source = await validJpeg();
    const { client, send } = fakeS3(async (command) =>
      command instanceof GetObjectCommand
        ? { ContentLength: source.length, Body: Readable.from([source]) }
        : {},
    );
    const adapter = createAdapter(client);
    const session = chatSession(source.length);
    const sessionFile = session.files[0]!;
    const uploadTarget = session.uploadTargets[0]!;
    const inspected = await adapter.inspectUploadedFile({
      session,
      sessionFile,
      uploadTarget,
      clientFile: { uploadTargetId },
      policy: chatPolicy,
    });
    if (!inspected.ok) throw new Error("Expected chat image inspection to succeed");

    const [variant] = await adapter.generateVariants({
      session,
      file: { sessionFile, uploadTarget, inspection: inspected.inspection },
      fileIndex: 0,
      policy: chatPolicy,
    });
    expect(variant).toMatchObject({
      variantName: "provider_original",
      visibility: "private",
      contentType: "image/jpeg",
      sizeBytes: source.length,
      publicCdnUrl: null,
    });
    expect(variant?.storageKey).toMatch(/^private\/media\/.*\.jpg$/);
    const put = send.mock.calls
      .map(([command]) => command)
      .find((command): command is PutObjectCommand => command instanceof PutObjectCommand);
    expect(put?.input).toMatchObject({
      Body: source,
      ContentType: "image/jpeg",
      CacheControl: privateCacheControl,
    });

    vi.mocked(getSignedUrl).mockResolvedValue("https://signed.example/chat-image");
    await expect(
      adapter.signPrivateDownload({
        bucketName,
        storageKey: variant!.storageKey,
        method: "GET",
        expiresInSeconds: 300,
        cacheControl: "private, no-store",
        responseContentDisposition: 'attachment; filename="chat.jpg"',
        responseContentType: "image/jpeg",
      }),
    ).resolves.toBe("https://signed.example/chat-image");
    const [, command, options] = vi.mocked(getSignedUrl).mock.calls.at(-1)!;
    expect(command).toBeInstanceOf(GetObjectCommand);
    expect((command as GetObjectCommand).input).toMatchObject({
      Bucket: bucketName,
      Key: variant!.storageKey,
      ResponseCacheControl: "private, no-store",
      ResponseContentType: "image/jpeg",
    });
    expect(options).toEqual({ expiresIn: 300 });
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

  it("publishes Booking header SVGs as safe WebP variants", async () => {
    const source = Buffer.from(
      '<svg xmlns="http://www.w3.org/2000/svg" width="300" height="80"><rect width="300" height="80" fill="#2345aa"/></svg>',
    );
    const { client } = fakeS3(async (command) =>
      command instanceof GetObjectCommand
        ? { ContentLength: source.length, Body: Readable.from([source]) }
        : {},
    );
    const adapter = createAdapter(client);
    const session = bookingHeaderLogoSession(source.length);
    const headerLogoPolicy: PlatformMediaPurposePolicy = {
      ...policy,
      purpose: "booking.header_logo",
      actorOwned: false,
      allowedRelationships: ["owner", "operator"],
      allowedResources: [{ product: "booking", resourceType: "booking_hotel" }],
      allowedContentTypes: ["image/jpeg", "image/png", "image/webp", "image/svg+xml"],
      allowedExtensions: [".jpg", ".jpeg", ".png", ".webp", ".svg"],
      maxFileSizeBytes: 500 * 1024,
      targetResourceProduct: "booking",
      targetResourceType: "booking_hotel",
    };
    const sessionFile = session.files[0]!;
    const uploadTarget = session.uploadTargets[0]!;

    const inspected = await adapter.inspectUploadedFile({
      session,
      sessionFile,
      uploadTarget,
      clientFile: { uploadTargetId, contentType: "image/svg+xml", sizeBytes: source.length },
      policy: headerLogoPolicy,
    });
    expect(inspected).toMatchObject({
      ok: true,
      inspection: { contentType: "image/svg+xml", widthPx: 300, heightPx: 80 },
    });
    if (!inspected.ok) throw new Error("Expected SVG logo inspection to succeed");

    const variants = await adapter.generateVariants({
      session,
      file: { sessionFile, uploadTarget, inspection: inspected.inspection },
      fileIndex: 0,
      policy: headerLogoPolicy,
    });
    expect(variants).toHaveLength(4);
    expect(variants.every((variant) => variant.contentType === "image/webp")).toBe(true);
    expect(variants.every((variant) => variant.visibility === "public")).toBe(true);
    expect(variants.every((variant) => variant.publicCdnUrl?.startsWith("https://"))).toBe(true);
    expect(variants.every((variant) => variant.storageKey.endsWith(".webp"))).toBe(true);
  });

  it("keeps pending marketplace offer variants private and uncached", async () => {
    const source = await validJpeg();
    const { client, send } = fakeS3(async (command) =>
      command instanceof GetObjectCommand
        ? { ContentLength: source.length, Body: Readable.from([source]) }
        : {},
    );
    const adapter = createAdapter(client);
    const session = offerSession(source.length);
    const sessionFile = session.files[0]!;
    const uploadTarget = session.uploadTargets[0]!;
    const inspected = await adapter.inspectUploadedFile({
      session,
      sessionFile,
      uploadTarget,
      clientFile: { uploadTargetId },
      policy: offerPolicy,
    });
    if (!inspected.ok) throw new Error("Expected offer image inspection to succeed");

    const variants = await adapter.generateVariants({
      session,
      file: { sessionFile, uploadTarget, inspection: inspected.inspection },
      fileIndex: 0,
      policy: offerPolicy,
    });

    expect(variants).toHaveLength(offerPolicy.requiredVariants.length);
    for (const variant of variants) {
      expect(variant).toMatchObject({ visibility: "private", publicCdnUrl: null });
      expect(variant.storageKey).toMatch(/^private\/media\//);
    }
    const puts = send.mock.calls
      .map(([command]) => command)
      .filter((command): command is PutObjectCommand => command instanceof PutObjectCommand);
    expect(puts).toHaveLength(offerPolicy.requiredVariants.length);
    for (const put of puts) {
      expect(put.input.CacheControl).toBe(privateCacheControl);
    }
  });

  it.each([
    "property.hero_image",
    "property.gallery_image",
    "property.logo",
    "pms.room_type.media",
  ] as const)("keeps finalized hotel media variants private for %s", async (purpose) => {
    const source = await validJpeg();
    const { client, send } = fakeS3(async (command) =>
      command instanceof GetObjectCommand
        ? { ContentLength: source.length, Body: Readable.from([source]) }
        : {},
    );
    const adapter = createAdapter(client);
    const hotelPolicy = propertyPolicy(purpose);
    const session = propertySession(source.length, purpose);
    const sessionFile = session.files[0]!;
    const uploadTarget = session.uploadTargets[0]!;
    const inspected = await adapter.inspectUploadedFile({
      session,
      sessionFile,
      uploadTarget,
      clientFile: { uploadTargetId },
      policy: hotelPolicy,
    });
    if (!inspected.ok) throw new Error("Expected hotel image inspection to succeed");

    const variants = await adapter.generateVariants({
      session,
      file: { sessionFile, uploadTarget, inspection: inspected.inspection },
      fileIndex: 0,
      policy: hotelPolicy,
    });

    expect(variants).toHaveLength(hotelPolicy.requiredVariants.length);
    expect(
      variants.every(
        (variant) =>
          variant.visibility === "private" &&
          variant.publicCdnUrl === null &&
          variant.storageKey.startsWith("private/media/"),
      ),
    ).toBe(true);
    const puts = send.mock.calls
      .map(([command]) => command)
      .filter((command): command is PutObjectCommand => command instanceof PutObjectCommand);
    expect(puts).toHaveLength(hotelPolicy.requiredVariants.length);
    expect(puts.every((put) => put.input.CacheControl === privateCacheControl)).toBe(true);
    expect(puts.every((put) => put.input.Key?.startsWith("private/media/"))).toBe(true);
  });

  it("rejects marketplace offer variants that bypass pending approval", async () => {
    const source = await validJpeg();
    const { client, send } = fakeS3(async (command) =>
      command instanceof GetObjectCommand
        ? { ContentLength: source.length, Body: Readable.from([source]) }
        : {},
    );
    const adapter = createAdapter(client);
    const session = offerSession(source.length);
    const sessionFile = session.files[0]!;
    const uploadTarget = session.uploadTargets[0]!;
    const inspected = await adapter.inspectUploadedFile({
      session,
      sessionFile,
      uploadTarget,
      clientFile: { uploadTargetId },
      policy: offerPolicy,
    });
    if (!inspected.ok) throw new Error("Expected offer image inspection to succeed");

    await expect(
      adapter.generateVariants({
        session: { ...session, effectiveVisibility: "public" },
        file: { sessionFile, uploadTarget, inspection: inspected.inspection },
        fileIndex: 0,
        policy: offerPolicy,
      }),
    ).rejects.toThrow("Images awaiting domain approval must stay private");
    expect(send.mock.calls.some(([command]) => command instanceof PutObjectCommand)).toBe(false);
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

  it("refetches inspected bytes when staging cleanup fails", async () => {
    const source = await validJpeg();
    const cleanupError = new Error("cleanup unavailable");
    const { client, send } = fakeS3(async (command) => {
      if (command instanceof GetObjectCommand) {
        return { ContentLength: source.length, Body: Readable.from([source]) };
      }
      if (command instanceof DeleteObjectCommand) throw cleanupError;
      return {};
    });
    const adapter = createAdapter(client);
    const { session, file } = await inspectValidUpload(adapter, source);

    await expect(adapter.cleanupUploadedFile!({ session, file })).rejects.toBe(cleanupError);
    await expect(
      adapter.generateVariants({ session, file, fileIndex: 0, policy }),
    ).resolves.toHaveLength(policy.requiredVariants.length);
    expect(send.mock.calls.filter(([command]) => command instanceof GetObjectCommand)).toHaveLength(
      2,
    );
  });

  it("does not retain or depend on inspected bytes while staging cleanup settles", async () => {
    const source = await validJpeg();
    const { client, send } = fakeS3(async (command) => {
      if (command instanceof GetObjectCommand) {
        return { ContentLength: source.length, Body: Readable.from([source]) };
      }
      if (command instanceof DeleteObjectCommand) return new Promise<never>(() => undefined);
      return {};
    });
    const adapter = createAdapter(client);
    const { session, file } = await inspectValidUpload(adapter, source);

    void adapter.cleanupUploadedFile!({ session, file });

    await expect(
      adapter.generateVariants({ session, file, fileIndex: 0, policy }),
    ).resolves.toHaveLength(policy.requiredVariants.length);
    expect(send.mock.calls.filter(([command]) => command instanceof GetObjectCommand)).toHaveLength(
      2,
    );
  });

  it("allows a fresh verified generation after a visibility validation failure", async () => {
    const source = await validJpeg();
    const { client, send } = fakeS3(async (command) =>
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
    ).rejects.toThrow("Auto-approved image variants require public visibility");
    await expect(
      adapter.generateVariants({ session, file, fileIndex: 0, policy }),
    ).resolves.toHaveLength(policy.requiredVariants.length);
    expect(send.mock.calls.filter(([command]) => command instanceof GetObjectCommand)).toHaveLength(
      2,
    );
  });

  it("rejects staged bytes changed after inspection before writing variants", async () => {
    const source = await validJpeg();
    const changed = Buffer.from(source);
    changed[changed.length - 1] = changed[changed.length - 1]! ^ 1;
    let getCount = 0;
    const { client, send } = fakeS3(async (command) => {
      if (command instanceof GetObjectCommand) {
        const bytes = getCount++ === 0 ? source : changed;
        return { ContentLength: bytes.length, Body: Readable.from([bytes]) };
      }
      return {};
    });
    const adapter = createAdapter(client);
    const { session, file } = await inspectValidUpload(adapter, source);

    await expect(adapter.generateVariants({ session, file, fileIndex: 0, policy })).rejects.toThrow(
      "staged image changed after inspection",
    );
    expect(send.mock.calls.some(([command]) => command instanceof PutObjectCommand)).toBe(false);
  });

  it("serializes image work across concurrent upload sessions", async () => {
    const source = await validJpeg();
    let activeGets = 0;
    let maxActiveGets = 0;
    const { client } = fakeS3(async (command) => {
      if (command instanceof GetObjectCommand) {
        activeGets += 1;
        maxActiveGets = Math.max(maxActiveGets, activeGets);
        await new Promise((resolve) => setTimeout(resolve, 5));
        activeGets -= 1;
        return { ContentLength: source.length, Body: Readable.from([source]) };
      }
      return {};
    });
    const adapter = createAdapter(client);
    const first = profileSession(source.length);
    const second: PlatformMediaSessionRecord = {
      ...profileSession(source.length),
      sessionId: "session_01J_SECOND",
      uploadTargets: [
        {
          ...profileSession(source.length).uploadTargets[0]!,
          stagingKey: "staging/session_01J_SECOND/1/profile.jpg",
        },
      ],
    };

    await Promise.all(
      [first, second].map((session) =>
        adapter.inspectUploadedFile({
          session,
          sessionFile: session.files[0]!,
          uploadTarget: session.uploadTargets[0]!,
          clientFile: { uploadTargetId: session.files[0]!.uploadTargetId },
          policy,
        }),
      ),
    );

    expect(maxActiveGets).toBe(1);
  });

  it("serializes mixed generation and inspection across the adapter", async () => {
    const source = await validJpeg();
    const events: string[] = [];
    const { client } = fakeS3(async (command) => {
      if (command instanceof GetObjectCommand) {
        events.push(`get:start:${command.input.Key}`);
        await new Promise((resolve) => setTimeout(resolve, 5));
        events.push(`get:end:${command.input.Key}`);
        return { ContentLength: source.length, Body: Readable.from([source]) };
      }
      if (command instanceof PutObjectCommand) {
        events.push(`put:${command.input.Key}`);
      }
      return {};
    });
    const adapter = createAdapter(client);
    const inspected = await inspectValidUpload(adapter, source);
    const second = profileSession(source.length);
    second.sessionId = "session_01J_MIXED";
    second.uploadTargets = [
      {
        ...second.uploadTargets[0]!,
        stagingKey: "staging/session_01J_MIXED/1/profile.jpg",
      },
    ];
    events.length = 0;

    await Promise.all([
      adapter.generateVariants({
        session: inspected.session,
        file: inspected.file,
        fileIndex: 0,
        policy,
      }),
      adapter.inspectUploadedFile({
        session: second,
        sessionFile: second.files[0]!,
        uploadTarget: second.uploadTargets[0]!,
        clientFile: { uploadTargetId: second.files[0]!.uploadTargetId },
        policy,
      }),
    ]);

    const secondGet = events.indexOf("get:start:staging/session_01J_MIXED/1/profile.jpg");
    expect(secondGet).toBeGreaterThan(0);
    expect(events.slice(0, secondGet)).toEqual(
      expect.arrayContaining([
        `get:start:${stagingKey}`,
        `get:end:${stagingKey}`,
        expect.stringMatching(/^put:/),
      ]),
    );
    expect(events.slice(secondGet)).not.toEqual(
      expect.arrayContaining([expect.stringMatching(/^put:/)]),
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

  it("raises the typed staging-changed error when generation loses the inspected object", async () => {
    const source = await validJpeg();
    let getCount = 0;
    const missing = Object.assign(new Error("missing"), {
      name: "NoSuchKey",
      $metadata: { httpStatusCode: 404 },
    });
    const { client } = fakeS3(async (command) => {
      if (command instanceof GetObjectCommand) {
        if (getCount++ === 0) {
          return { ContentLength: source.length, Body: Readable.from([source]) };
        }
        throw missing;
      }
      return {};
    });
    const adapter = createAdapter(client);
    const { session, file } = await inspectValidUpload(adapter, source);

    await expect(
      adapter.generateVariants({ session, file, fileIndex: 0, policy }),
    ).rejects.toBeInstanceOf(PlatformMediaStagingChangedError);
  });

  it("raises the typed staging-changed error when a streamed staged object grows", async () => {
    const source = await validJpeg();
    const grown = Buffer.concat([source, Buffer.from([0])]);
    let getCount = 0;
    const { client } = fakeS3(async (command) => {
      if (command instanceof GetObjectCommand) {
        if (getCount++ === 0) {
          return { ContentLength: source.length, Body: Readable.from([source]) };
        }
        return { Body: Readable.from([grown]) };
      }
      return {};
    });
    const adapter = createAdapter(client);
    const { session, file } = await inspectValidUpload(adapter, source);

    await expect(
      adapter.generateVariants({ session, file, fileIndex: 0, policy }),
    ).rejects.toBeInstanceOf(PlatformMediaStagingChangedError);
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

  it("processes the profile pixel cap and publishes variants sequentially", async () => {
    const source = await sharp({
      create: { width: 5_000, height: 5_000, channels: 3, background: "#334455" },
    })
      .jpeg({ quality: 40 })
      .toBuffer();
    expect(source.length).toBeLessThan(policy.maxFileSizeBytes);

    let activePuts = 0;
    let maxActivePuts = 0;
    const { client } = fakeS3(async (command) => {
      if (command instanceof GetObjectCommand) {
        return { ContentLength: source.length, Body: Readable.from([source]) };
      }
      if (command instanceof PutObjectCommand) {
        activePuts += 1;
        maxActivePuts = Math.max(maxActivePuts, activePuts);
        await new Promise<void>((resolve) => setImmediate(resolve));
        activePuts -= 1;
      }
      return {};
    });
    const adapter = createAdapter(client);
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
    if (!inspected.ok) throw new Error(`Expected inspection success: ${inspected.code}`);

    const variants = await adapter.generateVariants({
      session,
      file: { sessionFile, uploadTarget, inspection: inspected.inspection },
      fileIndex: 0,
      policy,
    });

    expect(variants).toHaveLength(policy.requiredVariants.length);
    expect(maxActivePuts).toBe(1);
  }, 30_000);

  it("rejects images above the profile pixel cap even when policy allows more", async () => {
    const permissivePolicy = { ...policy, maxImagePixels: 60_000_000 };
    const source = await sharp({
      create: { width: 5_001, height: 5_000, channels: 3, background: "#334455" },
    })
      .jpeg({ quality: 40 })
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
        policy: permissivePolicy,
      }),
    ).resolves.toMatchObject({ ok: false, code: "invalid_media_dimensions" });
  });

  it("accepts larger room images within the trusted resize ceiling", async () => {
    const source = await sharp({
      create: { width: 6_000, height: 5_000, channels: 3, background: "#334455" },
    })
      .jpeg({ quality: 40 })
      .toBuffer();
    const { client } = fakeS3(async (command) =>
      command instanceof GetObjectCommand
        ? { ContentLength: source.length, Body: Readable.from([source]) }
        : {},
    );
    const adapter = createAdapter(client);
    const session = propertySession(source.length, "pms.room_type.media");

    await expect(
      adapter.inspectUploadedFile({
        session,
        sessionFile: session.files[0]!,
        uploadTarget: session.uploadTargets[0]!,
        clientFile: { uploadTargetId },
        policy: propertyPolicy("pms.room_type.media"),
      }),
    ).resolves.toMatchObject({
      ok: true,
      inspection: { widthPx: 6_000, heightPx: 5_000 },
    });
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
      purpose: "pms.messaging.attachment" as const,
    };
    const unsupportedSession = {
      ...session,
      purpose: "pms.messaging.attachment" as const,
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
  contentType: "image/jpeg" | "image/png" | "image/webp" | "image/svg+xml" = "image/jpeg",
): PlatformMediaSessionRecord {
  const extension =
    contentType === "image/jpeg"
      ? "jpg"
      : contentType === "image/svg+xml"
        ? "svg"
        : contentType.slice("image/".length);
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

function bookingHeaderLogoSession(sizeBytes: number): PlatformMediaSessionRecord {
  return {
    ...profileSession(sizeBytes, "image/svg+xml"),
    purpose: "booking.header_logo",
    resource: {
      product: "booking",
      resourceType: "booking_hotel",
      resourceId: "booking_hotel_alpenrose",
    },
    target: {
      resourceProduct: "booking",
      resourceType: "booking_hotel",
      resourceId: "booking_hotel_alpenrose",
    },
  };
}

const offerPolicy: PlatformMediaPurposePolicy = {
  ...policy,
  purpose: "marketplace.offer.media",
  actorOwned: false,
  allowedRelationships: ["owner", "operator"],
  allowedResources: [{ product: "marketplace", resourceType: "marketplace_offer" }],
  maxFileSizeBytes: 10 * 1024 * 1024,
  maxFileCount: 12,
  autoApprovePublicOnFinalize: undefined,
  targetResourceProduct: "marketplace",
  targetResourceType: "marketplace_offer",
};

const chatPolicy: PlatformMediaPurposePolicy = {
  ...offerPolicy,
  purpose: "marketplace.collaboration_chat.attachment",
  allowedResources: [{ product: "marketplace", resourceType: "creator_profile" }],
  allowedContentTypes: ["image/jpeg", "image/png", "image/webp", "image/gif"],
  allowedExtensions: [".jpg", ".jpeg", ".png", ".webp", ".gif"],
  maxFileSizeBytes: 20 * 1024 * 1024,
  maxFileCount: 1,
  privateOnly: true,
  targetResourceProduct: "marketplace",
  targetResourceType: "collaboration",
  requiredVariants: ["provider_original"],
};

function propertyPolicy(
  purpose:
    | "property.hero_image"
    | "property.gallery_image"
    | "property.logo"
    | "pms.room_type.media",
): PlatformMediaPurposePolicy {
  return {
    ...offerPolicy,
    purpose,
    allowedResources: [{ product: "hotel_catalog", resourceType: "property" }],
    maxFileCount:
      purpose === "property.hero_image" || purpose === "property.logo"
        ? 1
        : purpose === "pms.room_type.media"
          ? 20
          : 25,
    autoApprovePublicOnFinalize: undefined,
    privateOnly: true,
    maxImagePixels: purpose === "pms.room_type.media" ? 60_000_000 : offerPolicy.maxImagePixels,
    resizeOversizedPublicImages: purpose === "pms.room_type.media" || undefined,
    targetResourceProduct: purpose === "pms.room_type.media" ? "pms" : "hotel_catalog",
    targetResourceType: purpose === "pms.room_type.media" ? "room_type" : "property",
  };
}

function offerSession(sizeBytes: number): PlatformMediaSessionRecord {
  return {
    ...profileSession(sizeBytes),
    purpose: "marketplace.offer.media",
    requestedVisibility: "public",
    effectiveVisibility: "private",
    resource: {
      product: "marketplace",
      resourceType: "marketplace_offer",
      resourceId: "offer_01J_TEST",
    },
    target: {
      resourceProduct: "marketplace",
      resourceType: "marketplace_offer",
      resourceId: "offer_01J_TEST",
    },
  };
}

function chatSession(sizeBytes: number): PlatformMediaSessionRecord {
  return {
    ...offerSession(sizeBytes),
    purpose: "marketplace.collaboration_chat.attachment",
    requestedVisibility: "private",
    resource: {
      product: "marketplace",
      resourceType: "creator_profile",
      resourceId: "creator_01J_TEST",
      targetResourceId: "collaboration_01J_TEST",
    },
    target: {
      resourceProduct: "marketplace",
      resourceType: "collaboration",
      resourceId: "collaboration_01J_TEST",
    },
  };
}

function propertySession(
  sizeBytes: number,
  purpose:
    | "property.hero_image"
    | "property.gallery_image"
    | "property.logo"
    | "pms.room_type.media",
): PlatformMediaSessionRecord {
  const roomMedia = purpose === "pms.room_type.media";
  return {
    ...profileSession(sizeBytes),
    purpose,
    requestedVisibility: "private",
    effectiveVisibility: "private",
    resource: {
      product: "hotel_catalog",
      resourceType: "property",
      resourceId: "00000000-0000-4000-8000-000000000040",
      ...(roomMedia ? { targetResourceId: "00000000-0000-4000-8000-000000000050" } : {}),
    },
    target: {
      resourceProduct: roomMedia ? "pms" : "hotel_catalog",
      resourceType: roomMedia ? "room_type" : "property",
      resourceId: roomMedia
        ? "00000000-0000-4000-8000-000000000050"
        : "00000000-0000-4000-8000-000000000040",
      propertyId: "00000000-0000-4000-8000-000000000040",
    },
  };
}
