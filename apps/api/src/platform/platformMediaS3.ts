import {
  DeleteObjectCommand,
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { createHash } from "node:crypto";
import sharp from "sharp";

import type {
  PlatformMediaFinalizedFileInspection,
  PlatformMediaPurpose,
  PlatformMediaUploadFinalizer,
  PlatformMediaUploadSigner,
  PlatformMediaVariantName,
  PlatformMediaVariantRecord,
} from "../routes/platformMedia.js";

const PROFILE_IMAGE_PURPOSES = new Set<PlatformMediaPurpose>([
  "identity.user.profile_image",
  "marketplace.creator.profile_image",
]);
const PROFILE_IMAGE_CONTENT_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);
const MAX_PROFILE_IMAGE_SIZE_BYTES = 5 * 1024 * 1024;
const DEFAULT_MAX_IMAGE_PIXELS = 60_000_000;
const SAFE_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

const VARIANTS: Record<
  Exclude<PlatformMediaVariantName, "provider_original">,
  { width: number; height: number; quality: number; blur?: number }
> = {
  original_safe: { width: 1920, height: 1920, quality: 85 },
  large: { width: 1280, height: 720, quality: 82 },
  thumbnail: { width: 320, height: 180, quality: 78 },
  blur_preview: { width: 32, height: 18, quality: 60, blur: 2 },
};

export type S3PlatformMediaAdapterOptions = {
  bucketName: string;
  cdnBaseUrl: string;
  publicPathPrefix?: string;
  publicCacheControl: string;
  s3Client?: S3Client;
};

export type S3PlatformMediaAdapter = PlatformMediaUploadSigner & PlatformMediaUploadFinalizer;

type CachedUpload = {
  bytes: Buffer;
  inspection: PlatformMediaFinalizedFileInspection;
};

class UploadTooLargeError extends Error {}

export function createS3PlatformMediaAdapter(
  options: S3PlatformMediaAdapterOptions,
): S3PlatformMediaAdapter {
  const bucketName = required(options.bucketName, "bucketName");
  const cdnBaseUrl = httpsOrigin(options.cdnBaseUrl);
  const publicPathPrefix = pathPrefix(options.publicPathPrefix ?? "media");
  const publicCacheControl = required(options.publicCacheControl, "publicCacheControl");
  const s3 = options.s3Client ?? new S3Client({ requestChecksumCalculation: "WHEN_REQUIRED" });
  const uploads = new Map<string, CachedUpload>();

  return {
    async signUploadTarget(input) {
      const contentType = normalizeContentType(input.contentType);
      if (!PROFILE_IMAGE_CONTENT_TYPES.has(contentType)) {
        throw new Error("S3 platform media currently signs profile images only");
      }
      if (
        !Number.isInteger(input.sizeBytes) ||
        input.sizeBytes < 1 ||
        input.sizeBytes > MAX_PROFILE_IMAGE_SIZE_BYTES
      ) {
        throw new Error("Profile image upload size must be between 1 byte and 5 MB");
      }
      assertStagingKey(input.stagingKey, input.sessionId);

      const expiresIn = Math.ceil((new Date(input.expiresAt).getTime() - Date.now()) / 1000);
      if (!Number.isFinite(expiresIn) || expiresIn < 1) {
        throw new Error("Profile image upload expiry must be in the future");
      }
      const command = new PutObjectCommand({
        Bucket: bucketName,
        Key: input.stagingKey,
        ContentType: contentType,
      });

      return {
        uploadTargetId: input.uploadTargetId,
        method: "PUT",
        uploadUrl: await getSignedUrl(s3, command, {
          expiresIn,
          signableHeaders: new Set(["content-type"]),
        }),
        headers: { "content-type": contentType },
        expiresAt: input.expiresAt,
      };
    },

    async inspectUploadedFile(input) {
      if (
        !isSupportedPurpose(input.session.purpose) ||
        input.policy.purpose !== input.session.purpose
      ) {
        return unsupportedPurpose();
      }

      const cacheKey = uploadCacheKey(input.session.sessionId, input.sessionFile.uploadTargetId);
      uploads.delete(cacheKey);
      const maxBytes = Math.min(input.sessionFile.sizeBytes, input.policy.maxFileSizeBytes);

      try {
        assertStagingKey(input.uploadTarget.stagingKey, input.session.sessionId);
        const object = await s3.send(
          new GetObjectCommand({ Bucket: bucketName, Key: input.uploadTarget.stagingKey }),
        );
        if (object.ContentLength !== undefined && object.ContentLength > maxBytes) {
          return tooLarge();
        }
        if (
          object.ContentLength !== undefined &&
          object.ContentLength !== input.sessionFile.sizeBytes
        ) {
          return sizeMismatch();
        }
        if (!object.Body) {
          return {
            ok: false,
            code: "media_upload_missing",
            message: "The staged profile image could not be read.",
          };
        }

        const bytes = await readBody(object.Body, maxBytes);
        if (bytes.length === 0) {
          return {
            ok: false,
            code: "invalid_media_size",
            message: "Profile images cannot be empty.",
          };
        }
        if (bytes.length !== input.sessionFile.sizeBytes) return sizeMismatch();

        const maxImagePixels = input.policy.maxImagePixels ?? DEFAULT_MAX_IMAGE_PIXELS;
        const metadata = await sharp(bytes, {
          failOn: "error",
          limitInputPixels: maxImagePixels,
        }).metadata();
        const contentType = imageContentType(metadata.format);
        if (!contentType || !PROFILE_IMAGE_CONTENT_TYPES.has(contentType)) {
          return {
            ok: false,
            code: "unsupported_media_type",
            message: "Profile images must contain valid JPG, PNG, or WebP bytes.",
          };
        }
        if (contentType !== normalizeContentType(input.sessionFile.contentType)) {
          return {
            ok: false,
            code: "media_type_mismatch",
            message: "Profile image bytes must match the signed content type.",
          };
        }
        const widthPx = metadata.autoOrient.width;
        const heightPx = metadata.autoOrient.height;
        if (widthPx * heightPx > maxImagePixels) {
          return invalidDimensions();
        }

        const checksumSha256 = sha256(bytes);
        if (
          input.clientFile.contentType !== undefined &&
          normalizeContentType(input.clientFile.contentType) !== contentType
        ) {
          return {
            ok: false,
            code: "media_type_mismatch",
            message: "Finalized content type must match the inspected upload.",
          };
        }
        if (
          input.clientFile.sizeBytes !== undefined &&
          input.clientFile.sizeBytes !== bytes.length
        ) {
          return sizeMismatch();
        }
        if (
          input.clientFile.checksumSha256 !== undefined &&
          input.clientFile.checksumSha256 !== checksumSha256
        ) {
          return {
            ok: false,
            code: "media_checksum_mismatch",
            message: "Finalized checksum must match the inspected upload.",
          };
        }

        const inspection = {
          contentType,
          sizeBytes: bytes.length,
          checksumSha256,
          widthPx,
          heightPx,
        } satisfies PlatformMediaFinalizedFileInspection;
        uploads.set(cacheKey, { bytes, inspection });
        return { ok: true, inspection };
      } catch (error) {
        if (error instanceof UploadTooLargeError) return tooLarge();
        if (error instanceof Error && /pixel limit|image dimensions/i.test(error.message)) {
          return invalidDimensions();
        }
        return {
          ok: false,
          code: "invalid_media_image",
          message: "The staged object is not a valid supported profile image.",
        };
      }
    },

    async generateVariants(input) {
      if (
        !isSupportedPurpose(input.session.purpose) ||
        input.policy.purpose !== input.session.purpose
      ) {
        throw new Error("S3 platform media currently finalizes profile images only");
      }
      if (input.session.effectiveVisibility !== "public") {
        throw new Error("Profile image variants require public visibility");
      }

      const cacheKey = uploadCacheKey(
        input.session.sessionId,
        input.file.sessionFile.uploadTargetId,
      );
      const upload = uploads.get(cacheKey);
      if (!upload || upload.inspection.checksumSha256 !== input.file.inspection.checksumSha256) {
        throw new Error("Profile image must be inspected before variants are generated");
      }

      try {
        const variants = await Promise.all(
          input.policy.requiredVariants.map((variantName) =>
            createVariant(
              upload.bytes,
              input.file.sessionFile.mediaId,
              variantName,
              publicPathPrefix,
            ),
          ),
        );
        await Promise.all(
          variants.map(({ record, bytes }) =>
            s3.send(
              new PutObjectCommand({
                Bucket: bucketName,
                Key: record.storageKey,
                Body: bytes,
                ContentType: "image/webp",
                CacheControl: publicCacheControl,
              }),
            ),
          ),
        );

        return variants.map(({ record }) => ({
          ...record,
          publicCdnUrl: new URL(
            record.storageKey.slice("public/".length),
            `${cdnBaseUrl}/`,
          ).toString(),
        }));
      } finally {
        uploads.delete(cacheKey);
      }
    },

    async cleanupUploadedFile(input) {
      assertStagingKey(input.file.uploadTarget.stagingKey, input.session.sessionId);
      try {
        await s3.send(
          new DeleteObjectCommand({
            Bucket: bucketName,
            Key: input.file.uploadTarget.stagingKey,
          }),
        );
      } catch {
        // The bucket lifecycle expires staging objects if immediate cleanup fails.
      }
    },
  };
}

async function createVariant(
  source: Buffer,
  mediaId: string,
  variantName: PlatformMediaVariantName,
  publicPathPrefix: string,
): Promise<{ record: PlatformMediaVariantRecord; bytes: Buffer }> {
  if (variantName === "provider_original") {
    throw new Error("Private provider media is not supported by this S3 adapter slice");
  }
  assertSegment(mediaId, "mediaId");
  const variant = VARIANTS[variantName];
  let pipeline = sharp(source, { failOn: "error" }).rotate().resize({
    width: variant.width,
    height: variant.height,
    fit: "inside",
    withoutEnlargement: true,
  });
  if (variant.blur) pipeline = pipeline.blur(variant.blur);
  const output = await pipeline
    .webp({ quality: variant.quality })
    .toBuffer({ resolveWithObject: true });
  const checksumSha256 = sha256(output.data);
  const version = `sha256-${checksumSha256}`;
  const storageKey = `public/${publicPathPrefix}/${mediaId}/${variantName}/${version}.webp`;

  return {
    bytes: output.data,
    record: {
      variantName,
      visibility: "public",
      storageKey,
      contentType: "image/webp",
      widthPx: output.info.width,
      heightPx: output.info.height,
      sizeBytes: output.info.size,
      checksumSha256,
      publicCdnUrl: null,
    },
  };
}

async function readBody(body: unknown, maxBytes: number): Promise<Buffer> {
  if (body instanceof Uint8Array) return checkedBuffer(body, maxBytes);

  const asyncBody = body as AsyncIterable<unknown>;
  if (body && typeof asyncBody[Symbol.asyncIterator] === "function") {
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of asyncBody) {
      if (!(typeof chunk === "string" || chunk instanceof Uint8Array)) {
        throw new Error("Unsupported S3 response body chunk");
      }
      const buffer = Buffer.from(chunk);
      size += buffer.length;
      if (size > maxBytes) throw new UploadTooLargeError();
      chunks.push(buffer);
    }
    return Buffer.concat(chunks, size);
  }

  const transformable = body as { transformToByteArray?: () => Promise<Uint8Array> };
  if (typeof transformable?.transformToByteArray === "function") {
    return checkedBuffer(await transformable.transformToByteArray(), maxBytes);
  }
  throw new Error("Unsupported S3 response body");
}

function checkedBuffer(value: Uint8Array, maxBytes: number): Buffer {
  if (value.byteLength > maxBytes) throw new UploadTooLargeError();
  return Buffer.from(value);
}

function imageContentType(format?: string): string | null {
  if (format === "jpeg") return "image/jpeg";
  if (format === "png" || format === "webp") return `image/${format}`;
  return null;
}

function pathPrefix(value: string): string {
  const prefix = value.trim().replace(/^\/+|\/+$/g, "");
  for (const segment of prefix.split("/")) assertSegment(segment, "publicPathPrefix");
  return prefix;
}

function httpsOrigin(value: string): string {
  const url = new URL(value);
  if (url.protocol !== "https:" || url.pathname !== "/" || url.search || url.hash) {
    throw new Error("cdnBaseUrl must be an HTTPS origin without path, query, or fragment");
  }
  return url.origin;
}

function required(value: string, name: string): string {
  const trimmed = value.trim();
  if (!trimmed) throw new Error(`${name} must not be empty`);
  return trimmed;
}

function assertSegment(value: string, name: string): void {
  if (!SAFE_SEGMENT.test(value)) throw new Error(`${name} must be a URL-safe path segment`);
}

function assertStagingKey(stagingKey: string, sessionId: string): void {
  if (!stagingKey.startsWith(`staging/${sessionId}/`) || stagingKey.includes("..")) {
    throw new Error("Profile image uploads require the session staging namespace");
  }
}

function normalizeContentType(value: string): string {
  return value.split(";", 1)[0]!.trim().toLowerCase();
}

function uploadCacheKey(sessionId: string, uploadTargetId: string): string {
  return `${sessionId}:${uploadTargetId}`;
}

function sha256(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function isSupportedPurpose(purpose: PlatformMediaPurpose): boolean {
  return PROFILE_IMAGE_PURPOSES.has(purpose);
}

function unsupportedPurpose() {
  return {
    ok: false as const,
    code: "unsupported_media_purpose",
    message: "S3 platform media currently supports profile images only.",
  };
}

function tooLarge() {
  return {
    ok: false as const,
    code: "media_file_too_large",
    message: "The staged profile image exceeds the signed size limit.",
  };
}

function sizeMismatch() {
  return {
    ok: false as const,
    code: "media_size_mismatch",
    message: "The staged profile image size must match the signed upload.",
  };
}

function invalidDimensions() {
  return {
    ok: false as const,
    code: "invalid_media_dimensions",
    message: "Profile image dimensions exceed the platform media limit.",
  };
}
