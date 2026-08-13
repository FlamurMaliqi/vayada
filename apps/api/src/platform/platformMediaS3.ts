import {
  DeleteObjectCommand,
  GetObjectCommand,
  type GetObjectCommandOutput,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { NodeHttpHandler } from "@smithy/node-http-handler";
import { createHash } from "node:crypto";
import sharp from "sharp";

import {
  PlatformMediaStagingChangedError,
  type PlatformMediaFinalizedFileInspection,
  type PlatformMediaPurpose,
  type PlatformMediaUploadFinalizer,
  type PlatformMediaUploadSigner,
  type PlatformMediaVariantName,
  type PlatformMediaVariantRecord,
} from "../routes/platformMedia.js";
import type { PlatformMediaObjectDeleter } from "../jobs/platformMediaCleanup.js";
import type { PrivateDownloadPolicy } from "./mediaServing.js";

const SUPPORTED_IMAGE_PURPOSES = new Set<PlatformMediaPurpose>([
  "identity.user.profile_image",
  "booking.header_logo",
  "property.hero_image",
  "property.gallery_image",
  "property.logo",
  "marketplace.creator.profile_image",
  "marketplace.offer.media",
  "marketplace.collaboration_chat.attachment",
  "pms.room_type.media",
]);
const IMAGE_CONTENT_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/gif",
  "image/svg+xml",
]);
const MAX_SIGNED_IMAGE_SIZE_BYTES = 20 * 1024 * 1024;
const MAX_IMAGE_PIXELS = 25_000_000;
const MAX_RESIZABLE_IMAGE_PIXELS = 60_000_000;
const PRIVATE_CACHE_CONTROL = "private, no-store";
const SAFE_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const IMAGE_OPERATION_TIMEOUT_SECONDS = 30;
const S3_CONNECTION_TIMEOUT_MS = 5_000;
const S3_REQUEST_TIMEOUT_MS = 30_000;

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

export type PlatformMediaPrivateDownloadSigner = {
  signPrivateDownload(policy: PrivateDownloadPolicy): Promise<string>;
};

export type S3PlatformMediaAdapter = PlatformMediaUploadSigner &
  PlatformMediaUploadFinalizer &
  PlatformMediaPrivateDownloadSigner &
  PlatformMediaObjectDeleter;

class UploadTooLargeError extends Error {}

export function createS3PlatformMediaAdapter(
  options: S3PlatformMediaAdapterOptions,
): S3PlatformMediaAdapter {
  const bucketName = required(options.bucketName, "bucketName");
  const cdnBaseUrl = httpsOrigin(options.cdnBaseUrl);
  const publicPathPrefix = pathPrefix(options.publicPathPrefix ?? "media");
  const publicCacheControl = required(options.publicCacheControl, "publicCacheControl");
  const s3 =
    options.s3Client ??
    new S3Client({
      requestChecksumCalculation: "WHEN_REQUIRED",
      requestHandler: NodeHttpHandler.create({
        connectionTimeout: S3_CONNECTION_TIMEOUT_MS,
        requestTimeout: S3_REQUEST_TIMEOUT_MS,
        socketTimeout: S3_REQUEST_TIMEOUT_MS,
        throwOnRequestTimeout: true,
      }),
    });
  const withImageWork = createSerialGate();

  return {
    async deleteObject(input) {
      await s3.send(
        new DeleteObjectCommand({
          Bucket: required(input.bucket, "bucket"),
          Key: required(input.storageKey, "storageKey"),
        }),
      );
    },

    async deletePrefix(input) {
      const bucket = required(input.bucket ?? bucketName, "bucket");
      const prefix = required(input.prefix, "prefix");
      const [namespace, sessionId, ...extraSegments] = prefix.split("/");
      if (namespace !== "staging" || !sessionId || extraSegments.length > 0) {
        throw new Error("Platform media prefix cleanup is restricted to staging namespaces");
      }
      assertSegment(sessionId, "staging session ID");

      let continuationToken: string | undefined;
      do {
        const page = await s3.send(
          new ListObjectsV2Command({
            Bucket: bucket,
            Prefix: prefix,
            ContinuationToken: continuationToken,
          }),
        );
        for (const object of page.Contents ?? []) {
          if (object.Key) {
            await s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: object.Key }));
          }
        }
        if (page.IsTruncated && !page.NextContinuationToken) {
          throw new Error("S3 prefix listing was truncated without a continuation token");
        }
        continuationToken = page.IsTruncated ? page.NextContinuationToken : undefined;
      } while (continuationToken);
    },

    async signPrivateDownload(policy) {
      if (policy.bucketName !== bucketName) {
        throw new Error("Private download bucket must match the S3 platform media bucket");
      }
      const command = new GetObjectCommand({
        Bucket: bucketName,
        Key: policy.storageKey,
        ResponseCacheControl: policy.cacheControl,
        ResponseContentDisposition: policy.responseContentDisposition,
        ResponseContentType: policy.responseContentType,
      });
      return getSignedUrl(s3, command, { expiresIn: policy.expiresInSeconds });
    },

    async signUploadTarget(input) {
      const contentType = normalizeContentType(input.contentType);
      if (!IMAGE_CONTENT_TYPES.has(contentType)) {
        throw new Error("S3 platform media only signs supported image types");
      }
      if (
        !Number.isInteger(input.sizeBytes) ||
        input.sizeBytes < 1 ||
        input.sizeBytes > MAX_SIGNED_IMAGE_SIZE_BYTES
      ) {
        throw new Error("Image upload size must be between 1 byte and 20 MB");
      }
      assertStagingKey(input.stagingKey, input.sessionId);

      const expiresIn = Math.ceil((new Date(input.expiresAt).getTime() - Date.now()) / 1000);
      if (!Number.isFinite(expiresIn) || expiresIn < 1) {
        throw new Error("Image upload expiry must be in the future");
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
      return withImageWork(async () => {
        if (
          !isSupportedPurpose(input.session.purpose) ||
          input.policy.purpose !== input.session.purpose
        ) {
          return unsupportedPurpose();
        }

        const maxBytes = Math.min(input.sessionFile.sizeBytes, input.policy.maxFileSizeBytes);

        assertStagingKey(input.uploadTarget.stagingKey, input.session.sessionId);
        let object: GetObjectCommandOutput;
        try {
          object = await s3.send(
            new GetObjectCommand({ Bucket: bucketName, Key: input.uploadTarget.stagingKey }),
          );
        } catch (error) {
          if (isMissingS3ObjectError(error)) return missingUpload();
          throw error;
        }
        try {
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
            return missingUpload();
          }

          const bytes = await readBody(object.Body, maxBytes);
          if (bytes.length === 0) {
            return {
              ok: false,
              code: "invalid_media_size",
              message: "Images cannot be empty.",
            };
          }
          if (bytes.length !== input.sessionFile.sizeBytes) return sizeMismatch();

          const pixelCeiling = input.policy.resizeOversizedPublicImages
            ? MAX_RESIZABLE_IMAGE_PIXELS
            : MAX_IMAGE_PIXELS;
          const maxImagePixels = Math.min(
            input.policy.maxImagePixels ?? pixelCeiling,
            pixelCeiling,
          );
          const image = sharp(bytes, {
            failOn: "error",
            limitInputPixels: maxImagePixels,
          }).timeout({ seconds: IMAGE_OPERATION_TIMEOUT_SECONDS });
          const metadata = await image.metadata();
          await image.clone().resize({ width: 1, height: 1, fit: "inside" }).toBuffer();
          const contentType = imageContentType(metadata.format);
          if (!contentType || !IMAGE_CONTENT_TYPES.has(contentType)) {
            return {
              ok: false,
              code: "unsupported_media_type",
              message: "Images must contain valid JPG, PNG, WebP, GIF, or SVG bytes.",
            };
          }
          if (contentType !== normalizeContentType(input.sessionFile.contentType)) {
            return {
              ok: false,
              code: "media_type_mismatch",
              message: "Image bytes must match the signed content type.",
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
          return { ok: true, inspection };
        } catch (error) {
          if (error instanceof UploadTooLargeError) return tooLarge();
          if (error instanceof Error && /pixel limit|image dimensions/i.test(error.message)) {
            return invalidDimensions();
          }
          if (!isInvalidImageError(error)) throw error;
          return {
            ok: false,
            code: "invalid_media_image",
            message: "The staged object is not a valid supported image.",
          };
        }
      });
    },

    async generateVariants(input) {
      return withImageWork(async () => {
        if (
          !isSupportedPurpose(input.session.purpose) ||
          input.policy.purpose !== input.session.purpose
        ) {
          throw new Error("S3 platform media does not support this image purpose");
        }
        if (
          input.policy.autoApprovePublicOnFinalize !== true &&
          input.session.effectiveVisibility !== "private"
        ) {
          throw new Error("Images awaiting domain approval must stay private");
        }
        if (
          input.policy.autoApprovePublicOnFinalize === true &&
          input.session.effectiveVisibility !== "public"
        ) {
          throw new Error("Auto-approved image variants require public visibility");
        }

        const expectedChecksum = input.file.inspection.checksumSha256;
        if (!expectedChecksum) {
          throw new Error("Image must have an inspected checksum before variant generation");
        }
        assertStagingKey(input.file.uploadTarget.stagingKey, input.session.sessionId);
        const source = await readVerifiedStagedObject({
          s3,
          bucketName,
          storageKey: input.file.uploadTarget.stagingKey,
          expectedSizeBytes: input.file.inspection.sizeBytes,
          expectedChecksumSha256: expectedChecksum,
          maxBytes: Math.min(input.file.sessionFile.sizeBytes, input.policy.maxFileSizeBytes),
        });

        const variants: PlatformMediaVariantRecord[] = [];
        for (const variantName of input.policy.requiredVariants) {
          const { record, bytes } = await createVariant(
            source,
            input.file.sessionFile.mediaId,
            variantName,
            publicPathPrefix,
            input.session.effectiveVisibility,
          );
          await s3.send(
            new PutObjectCommand({
              Bucket: bucketName,
              Key: record.storageKey,
              Body: bytes,
              ContentType: record.contentType,
              CacheControl:
                input.session.effectiveVisibility === "public"
                  ? publicCacheControl
                  : PRIVATE_CACHE_CONTROL,
            }),
          );
          variants.push({
            ...record,
            publicCdnUrl:
              input.session.effectiveVisibility === "public"
                ? new URL(record.storageKey.slice("public/".length), `${cdnBaseUrl}/`).toString()
                : null,
          });
        }
        return variants;
      });
    },

    async cleanupUploadedFile(input) {
      assertStagingKey(input.file.uploadTarget.stagingKey, input.session.sessionId);
      await s3.send(
        new DeleteObjectCommand({
          Bucket: bucketName,
          Key: input.file.uploadTarget.stagingKey,
        }),
      );
    },
  };
}

async function createVariant(
  source: Buffer,
  mediaId: string,
  variantName: PlatformMediaVariantName,
  publicPathPrefix: string,
  visibility: "private" | "public",
): Promise<{ record: PlatformMediaVariantRecord; bytes: Buffer }> {
  if (variantName === "provider_original") {
    if (visibility !== "private") {
      throw new Error("Provider-original media must stay private");
    }
    assertSegment(mediaId, "mediaId");
    const metadata = await sharp(source, { failOn: "error" })
      .timeout({ seconds: IMAGE_OPERATION_TIMEOUT_SECONDS })
      .metadata();
    const contentType = imageContentType(metadata.format);
    if (!contentType) throw new Error("Provider-original media has an unsupported image type");
    const checksumSha256 = sha256(source);
    const extension = contentType === "image/jpeg" ? "jpg" : contentType.slice("image/".length);
    return {
      bytes: source,
      record: {
        variantName,
        visibility,
        storageKey: `private/${publicPathPrefix}/${mediaId}/${variantName}/sha256-${checksumSha256}.${extension}`,
        contentType,
        widthPx: metadata.autoOrient.width,
        heightPx: metadata.autoOrient.height,
        sizeBytes: source.length,
        checksumSha256,
        publicCdnUrl: null,
      },
    };
  }
  assertSegment(mediaId, "mediaId");
  const variant = VARIANTS[variantName];
  let pipeline = sharp(source, { failOn: "error" })
    .timeout({ seconds: IMAGE_OPERATION_TIMEOUT_SECONDS })
    .rotate()
    .resize({
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
  const storageKey = `${visibility}/${publicPathPrefix}/${mediaId}/${variantName}/${version}.webp`;

  return {
    bytes: output.data,
    record: {
      variantName,
      visibility,
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

async function readVerifiedStagedObject(input: {
  s3: S3Client;
  bucketName: string;
  storageKey: string;
  expectedSizeBytes: number;
  expectedChecksumSha256: string;
  maxBytes: number;
}): Promise<Buffer> {
  let object: GetObjectCommandOutput;
  try {
    object = await input.s3.send(
      new GetObjectCommand({ Bucket: input.bucketName, Key: input.storageKey }),
    );
  } catch (error) {
    if (isMissingS3ObjectError(error)) {
      throw new PlatformMediaStagingChangedError(
        "The inspected staged image is no longer available",
        error,
      );
    }
    throw error;
  }
  if (object.ContentLength !== undefined && object.ContentLength !== input.expectedSizeBytes) {
    throw new PlatformMediaStagingChangedError("The staged image changed after inspection");
  }
  if (!object.Body) {
    throw new PlatformMediaStagingChangedError("The inspected staged image is no longer available");
  }
  let bytes: Buffer;
  try {
    bytes = await readBody(object.Body, input.maxBytes);
  } catch (error) {
    if (error instanceof UploadTooLargeError) {
      throw new PlatformMediaStagingChangedError(
        "The staged image changed after inspection",
        error,
      );
    }
    throw error;
  }
  if (bytes.length !== input.expectedSizeBytes || sha256(bytes) !== input.expectedChecksumSha256) {
    throw new PlatformMediaStagingChangedError("The staged image changed after inspection");
  }
  return bytes;
}

function createSerialGate() {
  let tail = Promise.resolve();
  return async function withSerialGate<T>(work: () => Promise<T>): Promise<T> {
    const previous = tail;
    let release!: () => void;
    tail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await work();
    } finally {
      release();
    }
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
  if (format === "svg") return "image/svg+xml";
  if (format === "png" || format === "webp" || format === "gif") return `image/${format}`;
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
    throw new Error("Image uploads require the session staging namespace");
  }
}

function normalizeContentType(value: string): string {
  return value.split(";", 1)[0]!.trim().toLowerCase();
}

function sha256(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function isSupportedPurpose(purpose: PlatformMediaPurpose): boolean {
  return SUPPORTED_IMAGE_PURPOSES.has(purpose);
}

function unsupportedPurpose() {
  return {
    ok: false as const,
    code: "unsupported_media_purpose",
    message: "S3 platform media does not support this image purpose.",
  };
}

function tooLarge() {
  return {
    ok: false as const,
    code: "media_file_too_large",
    message: "The staged image exceeds the signed size limit.",
  };
}

function sizeMismatch() {
  return {
    ok: false as const,
    code: "media_size_mismatch",
    message: "The staged image size must match the signed upload.",
  };
}

function invalidDimensions() {
  return {
    ok: false as const,
    code: "invalid_media_dimensions",
    message: "Image dimensions exceed the platform media limit.",
  };
}

function missingUpload() {
  return {
    ok: false as const,
    code: "media_upload_missing",
    message: "The staged image could not be read.",
  };
}

function isMissingS3ObjectError(error: unknown): boolean {
  return error instanceof Error && error.name === "NoSuchKey";
}

function isInvalidImageError(error: unknown): boolean {
  return (
    error instanceof Error &&
    /^(?:Input buffer (?:contains unsupported image format|has corrupt header|is empty)|VipsJpeg: .*(?:corrupt|invalid|premature)|pngload_buffer:|webpload_buffer:|svgload_buffer:)/i.test(
      error.message,
    )
  );
}
