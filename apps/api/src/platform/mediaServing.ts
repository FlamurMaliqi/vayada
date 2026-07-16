import { readIntegerEnv, type EnvSource } from "@vayada/backend-config";

export const DEFAULT_PUBLIC_MEDIA_PATH_PREFIX = "media";
export const DEFAULT_PUBLIC_MEDIA_CACHE_CONTROL = "public, max-age=31536000, immutable";
export const DEFAULT_PRIVATE_DOWNLOAD_TTL_SECONDS = 300;
export const DEFAULT_PRIVATE_DOWNLOAD_MAX_TTL_SECONDS = 900;
export const MAX_CONFIGURED_PRIVATE_DOWNLOAD_TTL_SECONDS = 3600;

const SAFE_PATH_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const SAFE_FILE_EXTENSION = /^[A-Za-z0-9]+$/;
const PRIVATE_KEY_PREFIX = "private/";
const RESERVED_PUBLIC_PATH_PREFIXES = new Set(["private", "public", "staging"]);

export type PlatformMediaServingConfig = {
  bucketName: string;
  cdnBaseUrl: string;
  cdnOriginHost: string;
  publicPathPrefix: string;
  publicCacheControl: string;
  privateDownloadTtlSeconds: number;
  privateDownloadMaxTtlSeconds: number;
};

export type PlatformMediaObjectStatus = "active" | "pending" | "deleted";
export type PlatformMediaVisibility = "public" | "private";

export type PublicMediaVariantDescriptor = {
  mediaId: string;
  variantName: string;
  version: string;
  fileExtension: string;
  visibility: PlatformMediaVisibility;
  status: PlatformMediaObjectStatus;
  publicApproved: boolean;
};

export type PublicMediaServingDescriptor = {
  url: string;
  cacheControl: string;
  invalidationRequired: false;
};

export type PrivateMediaObjectDescriptor = {
  bucketName: string;
  storageKey: string;
  visibility: PlatformMediaVisibility;
  status: PlatformMediaObjectStatus;
  originalFilename?: string;
  contentType?: string;
};

export type PrivateDownloadPolicy = {
  bucketName: string;
  storageKey: string;
  method: "GET";
  expiresInSeconds: number;
  cacheControl: "private, no-store";
  responseContentDisposition?: string;
  responseContentType?: string;
};

export type PublicMediaReplacementPlan = {
  publishUrl: string;
  retireUrl: string;
  invalidateRetiredUrl: false;
  reason: "immutable_versioned_urls";
};

export function loadPlatformMediaServingConfig(
  env: EnvSource,
  options: { incomplete?: "error" | "disabled" } = {},
): PlatformMediaServingConfig | undefined {
  const bucketName = readOptionalEnv(env, "PLATFORM_MEDIA_BUCKET");
  const cdnBaseUrl = readOptionalEnv(env, "PLATFORM_MEDIA_CDN_BASE_URL");
  const cdnOriginHost = readOptionalEnv(env, "PLATFORM_MEDIA_CDN_ORIGIN_HOST");
  const configuredKeys = [
    bucketName && "PLATFORM_MEDIA_BUCKET",
    cdnBaseUrl && "PLATFORM_MEDIA_CDN_BASE_URL",
    cdnOriginHost && "PLATFORM_MEDIA_CDN_ORIGIN_HOST",
  ].filter(Boolean);

  if (configuredKeys.length === 0) {
    return undefined;
  }

  if (!bucketName || !cdnBaseUrl || !cdnOriginHost) {
    if (options.incomplete === "disabled") return undefined;
    const missing = [
      !bucketName && "PLATFORM_MEDIA_BUCKET",
      !cdnBaseUrl && "PLATFORM_MEDIA_CDN_BASE_URL",
      !cdnOriginHost && "PLATFORM_MEDIA_CDN_ORIGIN_HOST",
    ]
      .filter(Boolean)
      .join(", ");
    throw new Error(`Incomplete platform media serving config; missing ${missing}`);
  }

  const privateDownloadMaxTtlSeconds = readIntegerEnv(
    env,
    "PLATFORM_MEDIA_PRIVATE_DOWNLOAD_MAX_TTL_SECONDS",
    {
      defaultValue: DEFAULT_PRIVATE_DOWNLOAD_MAX_TTL_SECONDS,
      min: 1,
      max: MAX_CONFIGURED_PRIVATE_DOWNLOAD_TTL_SECONDS,
    },
  );

  return createPlatformMediaServingConfig({
    bucketName,
    cdnBaseUrl,
    cdnOriginHost,
    publicPathPrefix:
      readOptionalEnv(env, "PLATFORM_MEDIA_PUBLIC_PATH_PREFIX") ?? DEFAULT_PUBLIC_MEDIA_PATH_PREFIX,
    publicCacheControl:
      readOptionalEnv(env, "PLATFORM_MEDIA_PUBLIC_CACHE_CONTROL") ??
      DEFAULT_PUBLIC_MEDIA_CACHE_CONTROL,
    privateDownloadTtlSeconds: readIntegerEnv(env, "PLATFORM_MEDIA_PRIVATE_DOWNLOAD_TTL_SECONDS", {
      defaultValue: DEFAULT_PRIVATE_DOWNLOAD_TTL_SECONDS,
      min: 1,
      max: privateDownloadMaxTtlSeconds,
    }),
    privateDownloadMaxTtlSeconds,
  });
}

export function createPlatformMediaServingConfig(
  config: PlatformMediaServingConfig,
): PlatformMediaServingConfig {
  assertSafeSegment(config.bucketName, "PLATFORM_MEDIA_BUCKET");
  const cdnBaseUrl = normalizeHttpsOrigin(config.cdnBaseUrl, "PLATFORM_MEDIA_CDN_BASE_URL");
  const cdnBaseHost = normalizeHost(new URL(cdnBaseUrl).hostname, "PLATFORM_MEDIA_CDN_BASE_URL");
  const cdnOriginHost = normalizeHost(config.cdnOriginHost, "PLATFORM_MEDIA_CDN_ORIGIN_HOST");
  const publicPathPrefix = normalizePathPrefix(config.publicPathPrefix);

  if (cdnBaseHost === cdnOriginHost) {
    throw new Error("PLATFORM_MEDIA_CDN_BASE_URL must not point directly at the CDN origin host");
  }

  if (config.privateDownloadTtlSeconds > config.privateDownloadMaxTtlSeconds) {
    throw new Error(
      "PLATFORM_MEDIA_PRIVATE_DOWNLOAD_TTL_SECONDS must not exceed PLATFORM_MEDIA_PRIVATE_DOWNLOAD_MAX_TTL_SECONDS",
    );
  }

  return {
    ...config,
    cdnBaseUrl,
    cdnOriginHost,
    publicPathPrefix,
    publicCacheControl: normalizePublicCacheControl(config.publicCacheControl),
  };
}

export function buildPublicMediaServingDescriptor(
  config: PlatformMediaServingConfig,
  variant: PublicMediaVariantDescriptor,
): PublicMediaServingDescriptor {
  if (variant.visibility !== "public") {
    throw new Error("Private media must not be exposed through public CDN URLs");
  }
  if (variant.status !== "active") {
    throw new Error("Only active media variants can receive public CDN URLs");
  }
  if (!variant.publicApproved) {
    throw new Error("Public CDN URLs require domain public approval");
  }

  const mediaId = safeSegment(variant.mediaId, "mediaId");
  const variantName = safeSegment(variant.variantName, "variantName");
  const version = safeSegment(variant.version, "version");
  const fileExtension = safeFileExtension(variant.fileExtension);
  const url = new URL(
    `${config.publicPathPrefix}/${mediaId}/${variantName}/${version}.${fileExtension}`,
    `${config.cdnBaseUrl}/`,
  );

  return {
    url: url.toString(),
    cacheControl: config.publicCacheControl,
    invalidationRequired: false,
  };
}

export function createPrivateDownloadPolicy(
  config: PlatformMediaServingConfig,
  mediaObject: PrivateMediaObjectDescriptor,
  options: { ttlSeconds?: number } = {},
): PrivateDownloadPolicy {
  if (mediaObject.bucketName !== config.bucketName) {
    throw new Error("Private download bucket must match the platform media bucket");
  }
  if (mediaObject.visibility !== "private") {
    throw new Error("Only private media objects use signed private download policies");
  }
  if (mediaObject.status !== "active") {
    throw new Error("Only active private media objects can be downloaded");
  }
  if (!mediaObject.storageKey.startsWith(PRIVATE_KEY_PREFIX)) {
    throw new Error("Private download storage keys must use the private/ namespace");
  }

  const ttlSeconds = options.ttlSeconds ?? config.privateDownloadTtlSeconds;
  if (!Number.isInteger(ttlSeconds) || ttlSeconds < 1) {
    throw new Error("Private download TTL must be a positive integer number of seconds");
  }
  if (ttlSeconds > config.privateDownloadMaxTtlSeconds) {
    throw new Error("Private download TTL exceeds the configured maximum");
  }

  return {
    bucketName: config.bucketName,
    storageKey: mediaObject.storageKey,
    method: "GET",
    expiresInSeconds: ttlSeconds,
    cacheControl: "private, no-store",
    responseContentDisposition: mediaObject.originalFilename
      ? `attachment; filename="${sanitizeAttachmentFilename(mediaObject.originalFilename)}"`
      : undefined,
    responseContentType: mediaObject.contentType,
  };
}

export function planPublicMediaReplacement(
  previous: PublicMediaServingDescriptor,
  next: PublicMediaServingDescriptor,
): PublicMediaReplacementPlan {
  if (previous.url === next.url) {
    throw new Error("Replacing public media must publish a new immutable versioned URL");
  }

  return {
    publishUrl: next.url,
    retireUrl: previous.url,
    invalidateRetiredUrl: false,
    reason: "immutable_versioned_urls",
  };
}

function readOptionalEnv(env: EnvSource, key: string): string | undefined {
  const value = env[key]?.trim();
  return value ? value : undefined;
}

function normalizeHttpsOrigin(value: string, key: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${key} must be a valid HTTPS origin URL`);
  }

  if (url.protocol !== "https:" || url.pathname !== "/" || url.search || url.hash) {
    throw new Error(`${key} must be an HTTPS origin without path, query, or fragment`);
  }

  return url.origin;
}

function normalizeHost(value: string, key: string): string {
  const trimmed = value.trim().replace(/\.$/, "");
  if (!trimmed || trimmed.includes("/") || trimmed.includes(":")) {
    throw new Error(`${key} must be a host name without scheme, path, or port`);
  }
  return trimmed.toLowerCase();
}

function normalizePathPrefix(value: string): string {
  const segments = value
    .trim()
    .replace(/^\/+|\/+$/g, "")
    .split("/")
    .filter(Boolean)
    .map((segment) => safeSegment(segment, "PLATFORM_MEDIA_PUBLIC_PATH_PREFIX"));
  const normalized = segments.join("/");

  if (!normalized) {
    throw new Error("PLATFORM_MEDIA_PUBLIC_PATH_PREFIX must not be empty");
  }
  if (RESERVED_PUBLIC_PATH_PREFIXES.has(segments[0].toLowerCase())) {
    throw new Error("PLATFORM_MEDIA_PUBLIC_PATH_PREFIX must not use a reserved storage namespace");
  }

  return normalized;
}

function normalizePublicCacheControl(value: string): string {
  const normalized = value.trim();
  const directives = normalized
    .split(",")
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean);
  if (!directives.includes("public") || directives.includes("private")) {
    throw new Error("PLATFORM_MEDIA_PUBLIC_CACHE_CONTROL must be public cacheable");
  }
  if (!directives.includes("immutable")) {
    throw new Error("PLATFORM_MEDIA_PUBLIC_CACHE_CONTROL must include immutable");
  }
  const maxAge = directives
    .map((directive) => directive.match(/^max-age=(\d+)$/)?.[1])
    .find(Boolean);
  if (!maxAge || Number(maxAge) < 86400) {
    throw new Error("PLATFORM_MEDIA_PUBLIC_CACHE_CONTROL must include max-age of at least 86400");
  }
  return normalized;
}

function safeSegment(value: string, name: string): string {
  const normalized = value.trim();
  if (!SAFE_PATH_SEGMENT.test(normalized)) {
    throw new Error(`${name} must be an opaque URL-safe path segment`);
  }
  return normalized;
}

function assertSafeSegment(value: string, name: string): void {
  safeSegment(value, name);
}

function safeFileExtension(value: string): string {
  const normalized = value.trim().replace(/^\./, "").toLowerCase();
  if (!SAFE_FILE_EXTENSION.test(normalized)) {
    throw new Error("fileExtension must be URL-safe");
  }
  return normalized;
}

function sanitizeAttachmentFilename(value: string): string {
  return value.replace(/["\r\n\\]/g, "_");
}
