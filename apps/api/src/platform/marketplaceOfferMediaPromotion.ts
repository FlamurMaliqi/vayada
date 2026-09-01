import { CopyObjectCommand, DeleteObjectCommand, S3Client } from "@aws-sdk/client-s3";
import pg, { type QueryResult, type QueryResultRow } from "pg";

import type { PlatformMediaServingConfig } from "./mediaServing.js";

export type MarketplaceOfferMediaPromotionPort = {
  promoteOfferMedia(input: {
    organizationId: string;
    offerId: string;
    mediaObjectIds?: string[];
  }): Promise<number>;
  close?(): Promise<void>;
};

type Queryable = {
  query<T extends QueryResultRow = QueryResultRow>(
    text: string,
    values?: readonly unknown[],
  ): Promise<Pick<QueryResult<T>, "rows">>;
};

type PromotionPoolClient = Queryable & { release(): void };
type PromotionPool = Queryable & {
  connect(): Promise<PromotionPoolClient>;
  end(): Promise<void>;
};

type PendingVariantRow = {
  mediaId: string;
  variantName: string;
  storageKey: string;
  contentType: string;
  widthPx: number | null;
  heightPx: number | null;
  sizeBytes: string | number;
  checksumSha256: string | null;
};

type SelectedMediaRow = {
  mediaId: string;
  visibility: "public" | "private";
  publicApproved: boolean;
  lifecycleStatus: "staged" | "active";
  hasOriginalSafe: boolean;
};

type PromotedVariant = PendingVariantRow & {
  publicStorageKey: string;
  publicCdnUrl: string;
};

export function createPgS3MarketplaceOfferMediaPromotion(config: {
  connectionString: string;
  serving: PlatformMediaServingConfig;
  pool?: PromotionPool;
  s3Client?: S3Client;
}): MarketplaceOfferMediaPromotionPort {
  if (!config.connectionString.trim()) {
    throw new Error("Marketplace offer media promotion connectionString must not be empty");
  }
  const ownsPool = !config.pool;
  const pool: PromotionPool =
    config.pool ?? new pg.Pool({ connectionString: config.connectionString });
  const s3 = config.s3Client ?? new S3Client({ requestChecksumCalculation: "WHEN_REQUIRED" });

  return {
    async promoteOfferMedia(input) {
      const client = await pool.connect();
      const copiedPublicKeys: string[] = [];
      try {
        await client.query("BEGIN");
        if (input.mediaObjectIds) {
          const requestedIds = Array.from(
            new Set(input.mediaObjectIds.map((mediaObjectId) => mediaObjectId.toLowerCase())),
          );
          if (requestedIds.length !== input.mediaObjectIds.length || requestedIds.length === 0) {
            throw invalidMediaSelection();
          }
          const selected = await client.query<SelectedMediaRow>(
            `SELECT
               media.id::text AS "mediaId",
               media.visibility,
               media.public_approved AS "publicApproved",
               media.lifecycle_status AS "lifecycleStatus",
               EXISTS (
                 SELECT 1
                 FROM platform.media_variants original_safe
                 WHERE original_safe.media_object_id = media.id
                   AND original_safe.variant_name = 'original_safe'
                   AND original_safe.visibility = 'private'
               ) AS "hasOriginalSafe"
             FROM platform.media_objects media
             WHERE media.owner_organization_id::text = $1
               AND media.resource_product = 'marketplace'
               AND media.resource_type = 'marketplace_offer'
               AND media.resource_id = $2
               AND media.id = ANY($3::uuid[])
               AND media.purpose = 'marketplace.offer.media'
             ORDER BY media.id
             FOR UPDATE OF media`,
            [input.organizationId, input.offerId, requestedIds],
          );
          if (
            selected.rows.length !== requestedIds.length ||
            selected.rows.some(
              (media) =>
                !(
                  (media.visibility === "public" &&
                    media.publicApproved &&
                    media.lifecycleStatus === "active") ||
                  (media.visibility === "private" &&
                    !media.publicApproved &&
                    media.lifecycleStatus === "staged" &&
                    media.hasOriginalSafe)
                ),
            )
          ) {
            throw invalidMediaSelection();
          }
        }
        const pending = await client.query<PendingVariantRow>(
          `SELECT
             media.id::text AS "mediaId",
             variant.variant_name AS "variantName",
             variant.storage_key AS "storageKey",
             variant.content_type AS "contentType",
             variant.width_px AS "widthPx",
             variant.height_px AS "heightPx",
             variant.size_bytes AS "sizeBytes",
             variant.checksum_sha256 AS "checksumSha256"
           FROM platform.media_objects media
           JOIN platform.media_variants variant ON variant.media_object_id = media.id
           WHERE media.owner_organization_id::text = $1
             AND media.resource_product = 'marketplace'
             AND media.resource_type = 'marketplace_offer'
             AND media.resource_id = $2
             AND ($3::uuid[] IS NULL OR media.id = ANY($3::uuid[]))
             AND media.purpose = 'marketplace.offer.media'
             AND media.visibility = 'private'
             AND media.public_approved = FALSE
             AND media.lifecycle_status = 'staged'
             AND variant.visibility = 'private'
           ORDER BY media.created_at, media.id, variant.created_at, variant.id
           FOR UPDATE OF media`,
          [input.organizationId, input.offerId, input.mediaObjectIds ?? null],
        );
        if (pending.rows.length === 0) {
          await client.query("COMMIT");
          return 0;
        }

        const byMedia = new Map<string, PromotedVariant[]>();
        for (const variant of pending.rows) {
          const publicStorageKey = publicStorageKeyFor(variant.storageKey);
          byMedia.set(variant.mediaId, [
            ...(byMedia.get(variant.mediaId) ?? []),
            {
              ...variant,
              publicStorageKey,
              publicCdnUrl: new URL(
                publicStorageKey.slice("public/".length),
                `${config.serving.cdnBaseUrl}/`,
              ).toString(),
            },
          ]);
        }
        for (const [mediaId, variants] of byMedia) {
          if (!variants.some(({ variantName }) => variantName === "original_safe")) {
            throw new Error(`Marketplace offer media ${mediaId} has no original_safe variant`);
          }
        }
        for (const variants of byMedia.values()) {
          for (const variant of variants) {
            await s3.send(
              new CopyObjectCommand({
                Bucket: config.serving.bucketName,
                CopySource: copySource(config.serving.bucketName, variant.storageKey),
                Key: variant.publicStorageKey,
                ContentType: variant.contentType,
                CacheControl: config.serving.publicCacheControl,
                MetadataDirective: "REPLACE",
              }),
            );
            copiedPublicKeys.push(variant.publicStorageKey);
          }
        }

        for (const [mediaId, variants] of byMedia) {
          const originalSafe = variants.find(({ variantName }) => variantName === "original_safe")!;
          await client.query(
            `DELETE FROM platform.media_variants WHERE media_object_id = $1::uuid`,
            [mediaId],
          );
          const approved = await client.query<{ id: string }>(
            `UPDATE platform.media_objects
             SET visibility = 'public',
                 storage_key = $2,
                 lifecycle_status = 'active',
                 public_approved = TRUE,
                 content_type = $3,
                 size_bytes = $4,
                 checksum_sha256 = $5,
                 width_px = $6,
                 height_px = $7,
                 updated_at = now()
             WHERE id = $1::uuid
               AND owner_organization_id::text = $8
               AND resource_product = 'marketplace'
               AND resource_type = 'marketplace_offer'
               AND resource_id = $9
               AND purpose = 'marketplace.offer.media'
               AND visibility = 'private'
               AND public_approved = FALSE
               AND lifecycle_status = 'staged'
             RETURNING id::text AS id`,
            [
              mediaId,
              originalSafe.publicStorageKey,
              originalSafe.contentType,
              originalSafe.sizeBytes,
              originalSafe.checksumSha256,
              originalSafe.widthPx,
              originalSafe.heightPx,
              input.organizationId,
              input.offerId,
            ],
          );
          if (!approved.rows[0]) {
            throw new Error(`Marketplace offer media ${mediaId} is no longer pending approval`);
          }
          for (const variant of variants) {
            await client.query(
              `INSERT INTO platform.media_variants (
                 media_object_id, variant_name, visibility, storage_key, content_type,
                 width_px, height_px, size_bytes, checksum_sha256, public_cdn_url, created_at
               )
               VALUES ($1::uuid, $2, 'public', $3, $4, $5, $6, $7, $8, $9, now())`,
              [
                mediaId,
                variant.variantName,
                variant.publicStorageKey,
                variant.contentType,
                variant.widthPx,
                variant.heightPx,
                variant.sizeBytes,
                variant.checksumSha256,
                variant.publicCdnUrl,
              ],
            );
          }
        }
        await client.query("COMMIT");
        return byMedia.size;
      } catch (error) {
        await client.query("ROLLBACK");
        await Promise.allSettled(
          copiedPublicKeys.map((storageKey) =>
            s3.send(
              new DeleteObjectCommand({
                Bucket: config.serving.bucketName,
                Key: storageKey,
              }),
            ),
          ),
        );
        throw error;
      } finally {
        client.release();
      }
    },
    async close() {
      if (ownsPool) await pool.end();
    },
  };
}

function publicStorageKeyFor(privateStorageKey: string): string {
  if (!privateStorageKey.startsWith("private/") || privateStorageKey.includes("..")) {
    throw new Error("Pending Marketplace offer variants must use the private storage namespace");
  }
  return `public/${privateStorageKey.slice("private/".length)}`;
}

function invalidMediaSelection(): Error {
  return Object.assign(new Error("Selected Marketplace offer media is not eligible for approval"), {
    statusCode: 422,
  });
}

function copySource(bucketName: string, storageKey: string): string {
  return `${bucketName}/${storageKey.split("/").map(encodeURIComponent).join("/")}`;
}
