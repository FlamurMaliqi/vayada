import {
  DeleteObjectCommand,
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
  type GetObjectCommandOutput,
} from "@aws-sdk/client-s3";
import { createHash } from "node:crypto";
import sharp from "sharp";

import { deterministicUuid } from "./productionBookingValues.js";
import type { ProductionMediaReference } from "./productionMediaPlan.js";

const MAX_BYTES = 25 * 1024 * 1024;
const MAX_PIXELS = 60_000_000;
const PUBLIC_CACHE = "public, max-age=31536000, immutable";
const PRIVATE_CACHE = "private, no-store";
const variants = {
  original_safe: { width: 1920, height: 1920, quality: 85 },
  large: { width: 1280, height: 720, quality: 82 },
  thumbnail: { width: 320, height: 180, quality: 78 },
  blur_preview: { width: 32, height: 18, quality: 60, blur: 2 },
} as const;

export type ProductionMediaVariant = {
  id: string;
  mediaObjectId: string;
  variantName: "original_safe" | "large" | "thumbnail" | "blur_preview" | "provider_original";
  visibility: "public" | "private";
  storageKey: string;
  contentType: string;
  widthPx: number | null;
  heightPx: number | null;
  sizeBytes: number;
  checksumSha256: string;
  publicCdnUrl: string | null;
};

export type ImportedProductionMedia = {
  reference: ProductionMediaReference;
  bucket: string;
  storageKey: string;
  contentType: string;
  sizeBytes: number;
  checksumSha256: string;
  sourceSizeBytes: number;
  sourceChecksumSha256: string;
  widthPx: number | null;
  heightPx: number | null;
  variants: ProductionMediaVariant[];
};

export class ProductionMediaSourceError extends Error {
  constructor(
    readonly code: "SOURCE_MISSING" | "SOURCE_CORRUPT" | "SOURCE_FAILED",
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "ProductionMediaSourceError";
  }
}

export type ProductionMediaStorage = {
  importReference(reference: ProductionMediaReference): Promise<ImportedProductionMedia>;
  discardImported?(imported: ImportedProductionMedia): Promise<void>;
};

export function createS3ProductionMediaStorage(input: {
  targetBucket: string;
  cdnBaseUrl: string;
  allowedLegacyBuckets: readonly string[];
  region?: string;
  s3?: S3Client;
}): ProductionMediaStorage {
  const targetBucket = bucket(input.targetBucket, "targetBucket");
  const allowed = new Set(
    input.allowedLegacyBuckets.map((value) => bucket(value, "allowedLegacyBuckets")),
  );
  if (allowed.size === 0) throw new Error("At least one allowed legacy media bucket is required");
  const cdnBaseUrl = httpsOrigin(input.cdnBaseUrl);
  const s3 = input.s3 ?? new S3Client({ region: input.region, followRegionRedirects: true });

  return {
    async importReference(reference) {
      const source = parseLegacyS3Url(reference.sourceUrl, allowed);
      let object: GetObjectCommandOutput;
      try {
        object = await s3.send(new GetObjectCommand({ Bucket: source.bucket, Key: source.key }));
      } catch (error) {
        if (isMissing(error))
          throw new ProductionMediaSourceError("SOURCE_MISSING", "Legacy media object is missing", {
            cause: error,
          });
        throw new ProductionMediaSourceError(
          "SOURCE_FAILED",
          "Legacy media object could not be read",
          { cause: error },
        );
      }
      if (!object.Body)
        throw new ProductionMediaSourceError("SOURCE_MISSING", "Legacy media object has no body");
      if (object.ContentLength !== undefined && object.ContentLength > MAX_BYTES)
        throw new ProductionMediaSourceError("SOURCE_CORRUPT", "Legacy media object exceeds 25 MB");
      const bytes = await readBody(object.Body, MAX_BYTES);
      if (bytes.length === 0)
        throw new ProductionMediaSourceError("SOURCE_CORRUPT", "Legacy media object is empty");
      const sourceChecksum = digest(bytes);
      const imported =
        reference.visibility === "public"
          ? await importPublic(reference, bytes, targetBucket, cdnBaseUrl, s3)
          : await importPrivate(reference, bytes, targetBucket, object.ContentType, s3);
      return {
        ...imported,
        sourceSizeBytes: bytes.length,
        sourceChecksumSha256: sourceChecksum,
      };
    },
    async discardImported(imported) {
      await Promise.all(
        [...new Set(imported.variants.map((variant) => variant.storageKey))].map((storageKey) =>
          s3.send(new DeleteObjectCommand({ Bucket: targetBucket, Key: storageKey })),
        ),
      );
    },
  };
}

async function importPublic(
  reference: ProductionMediaReference,
  bytes: Buffer,
  targetBucket: string,
  cdnBaseUrl: string,
  s3: S3Client,
): Promise<Omit<ImportedProductionMedia, "sourceSizeBytes" | "sourceChecksumSha256">> {
  let metadata: Awaited<ReturnType<ReturnType<typeof sharp>["metadata"]>>;
  try {
    const image = sharp(bytes, { failOn: "error", limitInputPixels: MAX_PIXELS }).timeout({
      seconds: 30,
    });
    metadata = await image.metadata();
    await image.clone().resize({ width: 1, height: 1, fit: "inside" }).toBuffer();
  } catch (error) {
    throw new ProductionMediaSourceError(
      "SOURCE_CORRUPT",
      "Legacy public media is not a valid supported image",
      { cause: error },
    );
  }
  if (!metadata.autoOrient.width || !metadata.autoOrient.height)
    throw new ProductionMediaSourceError(
      "SOURCE_CORRUPT",
      "Legacy public media has no valid dimensions",
    );

  const output: ProductionMediaVariant[] = [];
  try {
    for (const [variantName, definition] of Object.entries(variants) as Array<
      [keyof typeof variants, (typeof variants)[keyof typeof variants]]
    >) {
      let pipeline = sharp(bytes, { failOn: "error", limitInputPixels: MAX_PIXELS })
        .timeout({ seconds: 30 })
        .rotate()
        .resize({
          width: definition.width,
          height: definition.height,
          fit: "inside",
          withoutEnlargement: true,
        });
      if ("blur" in definition) pipeline = pipeline.blur(definition.blur);
      const result = await pipeline
        .webp({ quality: definition.quality })
        .toBuffer({ resolveWithObject: true });
      const checksum = digest(result.data);
      const storageKey = `public/media/${reference.mediaObjectId}/${variantName}/sha256-${checksum}.webp`;
      await s3.send(
        new PutObjectCommand({
          Bucket: targetBucket,
          Key: storageKey,
          Body: result.data,
          ContentType: "image/webp",
          CacheControl: PUBLIC_CACHE,
        }),
      );
      output.push({
        id: deterministicUuid(
          "vayada",
          "production-media-variant",
          reference.mediaObjectId,
          variantName,
        ),
        mediaObjectId: reference.mediaObjectId,
        variantName,
        visibility: "public",
        storageKey,
        contentType: "image/webp",
        widthPx: result.info.width,
        heightPx: result.info.height,
        sizeBytes: result.info.size,
        checksumSha256: checksum,
        publicCdnUrl: new URL(storageKey.slice("public/".length), `${cdnBaseUrl}/`).toString(),
      });
    }
  } catch (error) {
    await Promise.allSettled(
      output.map((variant) =>
        s3.send(new DeleteObjectCommand({ Bucket: targetBucket, Key: variant.storageKey })),
      ),
    );
    if (error instanceof ProductionMediaSourceError) throw error;
    throw new ProductionMediaSourceError(
      "SOURCE_FAILED",
      "Public media variant generation failed",
      { cause: error },
    );
  }
  const original = output.find((variant) => variant.variantName === "original_safe")!;
  return {
    reference,
    bucket: targetBucket,
    storageKey: original.storageKey,
    contentType: original.contentType,
    sizeBytes: original.sizeBytes,
    checksumSha256: original.checksumSha256,
    widthPx: original.widthPx,
    heightPx: original.heightPx,
    variants: output,
  };
}

async function importPrivate(
  reference: ProductionMediaReference,
  bytes: Buffer,
  targetBucket: string,
  sourceContentType: string | undefined,
  s3: S3Client,
): Promise<Omit<ImportedProductionMedia, "sourceSizeBytes" | "sourceChecksumSha256">> {
  const checksum = digest(bytes);
  const contentType =
    normalizeContentType(sourceContentType) ?? contentTypeFor(reference.originalFilename);
  const extension = safeExtension(reference.originalFilename, contentType);
  const storageKey = `private/media/${reference.mediaObjectId}/provider_original/sha256-${checksum}.${extension}`;
  let widthPx: number | null = null;
  let heightPx: number | null = null;
  if (contentType.startsWith("image/")) {
    try {
      const metadata = await sharp(bytes, {
        failOn: "error",
        limitInputPixels: MAX_PIXELS,
      }).metadata();
      widthPx = metadata.autoOrient.width ?? null;
      heightPx = metadata.autoOrient.height ?? null;
    } catch (error) {
      throw new ProductionMediaSourceError("SOURCE_CORRUPT", "Legacy private image is corrupt", {
        cause: error,
      });
    }
  }
  await s3.send(
    new PutObjectCommand({
      Bucket: targetBucket,
      Key: storageKey,
      Body: bytes,
      ContentType: contentType,
      CacheControl: PRIVATE_CACHE,
    }),
  );
  const variant: ProductionMediaVariant = {
    id: deterministicUuid(
      "vayada",
      "production-media-variant",
      reference.mediaObjectId,
      "provider_original",
    ),
    mediaObjectId: reference.mediaObjectId,
    variantName: "provider_original",
    visibility: "private",
    storageKey,
    contentType,
    widthPx,
    heightPx,
    sizeBytes: bytes.length,
    checksumSha256: checksum,
    publicCdnUrl: null,
  };
  return {
    reference,
    bucket: targetBucket,
    storageKey,
    contentType,
    sizeBytes: bytes.length,
    checksumSha256: checksum,
    widthPx,
    heightPx,
    variants: [variant],
  };
}

export function parseLegacyS3Url(
  value: string,
  allowedBuckets: ReadonlySet<string>,
): { bucket: string; key: string } {
  const url = new URL(value);
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash)
    throw new ProductionMediaSourceError(
      "SOURCE_FAILED",
      "Legacy media URL is not an immutable HTTPS S3 object URL",
    );
  const virtual = /^(?<bucket>[a-z0-9][a-z0-9.-]+)\.s3(?:[.-][a-z0-9-]+)?\.amazonaws\.com$/i.exec(
    url.hostname,
  );
  let sourceBucket = virtual?.groups?.["bucket"];
  let key = decodeURIComponent(url.pathname.replace(/^\/+/, ""));
  if (!sourceBucket && /^s3(?:[.-][a-z0-9-]+)?\.amazonaws\.com$/i.test(url.hostname)) {
    const [pathBucket, ...segments] = key.split("/");
    sourceBucket = pathBucket;
    key = segments.join("/");
  }
  if (!sourceBucket || !allowedBuckets.has(sourceBucket) || !key || key.includes("\0"))
    throw new ProductionMediaSourceError(
      "SOURCE_FAILED",
      "Legacy media URL is outside the reviewed S3 bucket allowlist",
    );
  return { bucket: sourceBucket, key };
}

async function readBody(body: unknown, maxBytes: number): Promise<Buffer> {
  if (body instanceof Uint8Array) return checked(Buffer.from(body), maxBytes);
  const iterable = body as AsyncIterable<unknown>;
  if (body && typeof iterable[Symbol.asyncIterator] === "function") {
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of iterable) {
      if (!(typeof chunk === "string" || chunk instanceof Uint8Array))
        throw new ProductionMediaSourceError("SOURCE_FAILED", "Unsupported S3 response body");
      const buffer = Buffer.from(chunk);
      size += buffer.length;
      if (size > maxBytes)
        throw new ProductionMediaSourceError("SOURCE_CORRUPT", "Legacy media object exceeds 25 MB");
      chunks.push(buffer);
    }
    return Buffer.concat(chunks, size);
  }
  const transformable = body as { transformToByteArray?: () => Promise<Uint8Array> };
  if (typeof transformable?.transformToByteArray === "function")
    return checked(Buffer.from(await transformable.transformToByteArray()), maxBytes);
  throw new ProductionMediaSourceError("SOURCE_FAILED", "Unsupported S3 response body");
}

function checked(value: Buffer, maxBytes: number): Buffer {
  if (value.length > maxBytes)
    throw new ProductionMediaSourceError("SOURCE_CORRUPT", "Legacy media object exceeds 25 MB");
  return value;
}

function isMissing(error: unknown): boolean {
  return error instanceof Error && ["NoSuchKey", "NotFound", "NoSuchBucket"].includes(error.name);
}

function bucket(value: string, field: string): string {
  const result = value.trim();
  if (!/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(result)) throw new Error(`${field} is invalid`);
  return result;
}

function httpsOrigin(value: string): string {
  const url = new URL(value);
  if (url.protocol !== "https:" || url.pathname !== "/" || url.search || url.hash)
    throw new Error("cdnBaseUrl must be an HTTPS origin");
  if (/(^|\.)s3(?:[.-][a-z0-9-]+)?\.amazonaws\.com$/i.test(url.hostname))
    throw new Error("cdnBaseUrl must not be a raw S3 origin");
  return url.origin;
}

function normalizeContentType(value: string | undefined): string | null {
  const result = value?.split(";", 1)[0]?.trim().toLowerCase();
  return result && /^[a-z0-9.+-]+\/[a-z0-9.+-]+$/.test(result) ? result : null;
}

function contentTypeFor(filename: string): string {
  const extension = filename.toLowerCase().split(".").at(-1);
  return (
    (
      {
        jpg: "image/jpeg",
        jpeg: "image/jpeg",
        png: "image/png",
        webp: "image/webp",
        gif: "image/gif",
        svg: "image/svg+xml",
        pdf: "application/pdf",
      } as Record<string, string>
    )[extension ?? ""] ?? "application/octet-stream"
  );
}

function safeExtension(filename: string, contentType: string): string {
  const extension = filename.toLowerCase().match(/\.([a-z0-9]{1,10})$/)?.[1];
  if (extension) return extension === "jpeg" ? "jpg" : extension;
  if (contentType === "image/jpeg") return "jpg";
  return (
    contentType
      .split("/")
      .at(-1)
      ?.replace(/[^a-z0-9]/g, "") || "bin"
  );
}

function digest(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}
