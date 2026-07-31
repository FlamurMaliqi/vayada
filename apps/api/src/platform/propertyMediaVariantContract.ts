import {
  PROPERTY_MEDIA_PUBLIC_VARIANTS,
  type PropertyMediaPublicVariantName,
} from "@vayada/domain-hotels";

import type {
  PlatformMediaObjectRecord,
  PlatformMediaVariantRecord,
} from "../routes/platformMedia.js";

const SHA256_HEX = /^[a-f0-9]{64}$/;
const SAFE_PATH_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
export const PROPERTY_MEDIA_PUBLIC_VARIANT_MAX_DIMENSIONS: Record<
  PropertyMediaPublicVariantName,
  { widthPx: number; heightPx: number }
> = {
  original_safe: { widthPx: 1920, heightPx: 1920 },
  large: { widthPx: 1280, heightPx: 720 },
  thumbnail: { widthPx: 320, heightPx: 180 },
  blur_preview: { widthPx: 32, heightPx: 18 },
};

export function normalizePlatformMediaPathPrefix(value: string): string {
  const normalized = value.trim().replace(/^\/+|\/+$/g, "");
  if (!normalized || normalized.split("/").some((segment) => !SAFE_PATH_SEGMENT.test(segment))) {
    throw new Error("Platform media path prefix must contain only safe path segments");
  }
  return normalized;
}

export function assertCanonicalPrivatePropertyVariants(input: {
  mediaId: string;
  variants: PlatformMediaVariantRecord[];
  mediaPathPrefix: string;
}): void {
  const { mediaId, variants, mediaPathPrefix } = input;
  const names = variants.map(({ variantName }) => variantName);
  if (
    variants.length !== PROPERTY_MEDIA_PUBLIC_VARIANTS.length ||
    new Set(names).size !== PROPERTY_MEDIA_PUBLIC_VARIANTS.length ||
    PROPERTY_MEDIA_PUBLIC_VARIANTS.some((variantName) => !names.includes(variantName))
  ) {
    throw new Error("Property media requires exactly the approved safe variant set");
  }

  for (const variant of variants) {
    if (!PROPERTY_MEDIA_PUBLIC_VARIANTS.includes(variant.variantName as never)) {
      throw new Error("Property media contains an unsupported variant");
    }
    const limits =
      PROPERTY_MEDIA_PUBLIC_VARIANT_MAX_DIMENSIONS[
        variant.variantName as PropertyMediaPublicVariantName
      ];
    if (
      !variant.checksumSha256 ||
      !SHA256_HEX.test(variant.checksumSha256) ||
      !Number.isInteger(variant.sizeBytes) ||
      variant.sizeBytes <= 0 ||
      !Number.isInteger(variant.widthPx) ||
      !Number.isInteger(variant.heightPx) ||
      variant.widthPx! <= 0 ||
      variant.heightPx! <= 0 ||
      variant.widthPx! > limits.widthPx ||
      variant.heightPx! > limits.heightPx
    ) {
      throw new Error("Property media variants require safe dimensions, size, and checksum");
    }
    const expectedKey = `private/${mediaPathPrefix}/${mediaId}/${variant.variantName}/sha256-${variant.checksumSha256}.webp`;
    if (
      variant.visibility !== "private" ||
      variant.publicCdnUrl !== null ||
      variant.contentType !== "image/webp" ||
      variant.storageKey !== expectedKey
    ) {
      throw new Error("Property media variants must use canonical private storage keys");
    }
  }
}

export function isCanonicalPrivatePropertyMediaObject(input: {
  mediaObject: PlatformMediaObjectRecord;
  mediaPathPrefix: string;
}): boolean {
  const { mediaObject, mediaPathPrefix } = input;
  try {
    assertCanonicalPrivatePropertyVariants({
      mediaId: mediaObject.mediaId,
      variants: mediaObject.variants,
      mediaPathPrefix,
    });
    const originalSafe = mediaObject.variants.find(
      ({ variantName }) => variantName === "original_safe",
    );
    return Boolean(
      originalSafe &&
      mediaObject.visibility === "private" &&
      mediaObject.requestedVisibility === "private" &&
      mediaObject.approvalStatus === "private" &&
      mediaObject.lifecycleStatus === "staged" &&
      mediaObject.storageKind === "vayada_managed" &&
      mediaObject.storageKey === originalSafe.storageKey &&
      mediaObject.contentType === originalSafe.contentType &&
      mediaObject.sizeBytes === originalSafe.sizeBytes &&
      mediaObject.checksumSha256 === originalSafe.checksumSha256 &&
      mediaObject.widthPx === originalSafe.widthPx &&
      mediaObject.heightPx === originalSafe.heightPx,
    );
  } catch {
    return false;
  }
}
