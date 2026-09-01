import { CopyObjectCommand, DeleteObjectCommand, type S3Client } from "@aws-sdk/client-s3";
import { describe, expect, it, vi } from "vitest";

import type { PlatformMediaServingConfig } from "./mediaServing.js";
import { createPgS3MarketplaceOfferMediaPromotion } from "./marketplaceOfferMediaPromotion.js";

const serving: PlatformMediaServingConfig = {
  bucketName: "vayada-media-test",
  cdnBaseUrl: "https://cdn.vayada.test",
  cdnOriginHost: "vayada-media-test.s3.us-east-1.amazonaws.com",
  publicPathPrefix: "media",
  publicCacheControl: "public, max-age=31536000, immutable",
  privateDownloadTtlSeconds: 300,
  privateDownloadMaxTtlSeconds: 900,
};
const MEDIA_ID = "f8017000-0000-4000-8000-000000000001";
const APPROVED_MEDIA_ID = "f8017000-0000-4000-8000-000000000002";

describe("Marketplace offer media promotion", () => {
  it("copies pending private variants before atomically approving their media object", async () => {
    const database = fakeDatabase([
      pendingVariant("original_safe"),
      pendingVariant("large"),
      pendingVariant("thumbnail"),
      pendingVariant("blur_preview"),
    ]);
    const send = vi.fn(async (_command: unknown) => ({}));
    const promotion = createPgS3MarketplaceOfferMediaPromotion({
      connectionString: "postgresql://target.test/vayada",
      serving,
      pool: database.pool as never,
      s3Client: { send } as unknown as S3Client,
    });

    await expect(
      promotion.promoteOfferMedia({
        organizationId: "org-1",
        offerId: "offer-1",
        mediaObjectIds: [MEDIA_ID],
      }),
    ).resolves.toBe(1);

    const copies = send.mock.calls.map(([command]) => command as CopyObjectCommand);
    expect(copies).toHaveLength(4);
    for (const copy of copies) {
      expect(copy).toBeInstanceOf(CopyObjectCommand);
      expect(copy.input).toMatchObject({
        Bucket: serving.bucketName,
        CacheControl: serving.publicCacheControl,
        MetadataDirective: "REPLACE",
      });
      expect(copy.input.CopySource).toMatch(/^vayada-media-test\/private\/media\/media-1\//);
      expect(copy.input.Key).toMatch(/^public\/media\/media-1\//);
    }

    expect(database.statements).toContain("BEGIN");
    expect(database.statements).toContain("COMMIT");
    expect(database.statements).not.toContain("ROLLBACK");
    const pending = database.queries.find(({ text }) =>
      text.includes("FROM platform.media_objects media"),
    );
    expect(pending?.text).toContain("media.id = ANY($3::uuid[])");
    expect(pending?.values).toEqual(["org-1", "offer-1", [MEDIA_ID]]);
    const update = database.queries.find(({ text }) =>
      text.includes("UPDATE platform.media_objects"),
    );
    expect(update?.text).toContain("public_approved = TRUE");
    expect(update?.text).toContain("lifecycle_status = 'active'");
    expect(update?.values?.[1]).toMatch(/^public\/media\/media-1\/original_safe\//);
    const inserts = database.queries.filter(({ text }) =>
      text.includes("INSERT INTO platform.media_variants"),
    );
    expect(inserts).toHaveLength(4);
    expect(inserts[0]?.values?.[8]).toMatch(/^https:\/\/cdn\.vayada\.test\/media\/media-1\//);
  });

  it("is a locked no-op when the offer has no pending private media", async () => {
    const database = fakeDatabase([]);
    const send = vi.fn(async (_command: unknown) => ({}));
    const promotion = createPgS3MarketplaceOfferMediaPromotion({
      connectionString: "postgresql://target.test/vayada",
      serving,
      pool: database.pool as never,
      s3Client: { send } as unknown as S3Client,
    });

    await expect(
      promotion.promoteOfferMedia({ organizationId: "org-1", offerId: "offer-1" }),
    ).resolves.toBe(0);
    expect(send).not.toHaveBeenCalled();
    expect(database.statements).toContain("BEGIN");
    expect(database.statements).toContain("COMMIT");
  });

  it("promotes only the pending subset of an exact mixed staged/public replay", async () => {
    const database = fakeDatabase([pendingVariant("original_safe")], true, [
      selectedMedia(MEDIA_ID, "private"),
      selectedMedia(APPROVED_MEDIA_ID, "public"),
    ]);
    const send = vi.fn(async (_command: unknown) => ({}));
    const promotion = createPgS3MarketplaceOfferMediaPromotion({
      connectionString: "postgresql://target.test/vayada",
      serving,
      pool: database.pool as never,
      s3Client: { send } as unknown as S3Client,
    });

    await expect(
      promotion.promoteOfferMedia({
        organizationId: "org-1",
        offerId: "offer-1",
        mediaObjectIds: [MEDIA_ID, APPROVED_MEDIA_ID],
      }),
    ).resolves.toBe(1);
    expect(send).toHaveBeenCalledTimes(1);
    expect(database.statements).toContain("COMMIT");
  });

  it("rejects an exact selected set before copying when a staged object lacks original_safe", async () => {
    const database = fakeDatabase([pendingVariant("large")]);
    const send = vi.fn(async (_command: unknown) => ({}));
    const promotion = createPgS3MarketplaceOfferMediaPromotion({
      connectionString: "postgresql://target.test/vayada",
      serving,
      pool: database.pool as never,
      s3Client: { send } as unknown as S3Client,
    });

    await expect(
      promotion.promoteOfferMedia({
        organizationId: "org-1",
        offerId: "offer-1",
        mediaObjectIds: [MEDIA_ID],
      }),
    ).rejects.toMatchObject({ statusCode: 422 });
    expect(send).not.toHaveBeenCalled();
    expect(database.statements).toContain("ROLLBACK");
  });

  it("removes copied public objects when database approval fails", async () => {
    const database = fakeDatabase([pendingVariant("original_safe")], false);
    const send = vi.fn(async (_command: unknown) => ({}));
    const promotion = createPgS3MarketplaceOfferMediaPromotion({
      connectionString: "postgresql://target.test/vayada",
      serving,
      pool: database.pool as never,
      s3Client: { send } as unknown as S3Client,
    });

    await expect(
      promotion.promoteOfferMedia({ organizationId: "org-1", offerId: "offer-1" }),
    ).rejects.toThrow("no longer pending approval");

    expect(send.mock.calls[0]?.[0]).toBeInstanceOf(CopyObjectCommand);
    expect(send.mock.calls[1]?.[0]).toBeInstanceOf(DeleteObjectCommand);
    expect(database.statements).toContain("ROLLBACK");
    expect(database.statements).not.toContain("COMMIT");
  });
});

function pendingVariant(variantName: string) {
  return {
    mediaId: MEDIA_ID,
    variantName,
    storageKey: `private/media/media-1/${variantName}/sha256-${"a".repeat(64)}.webp`,
    contentType: "image/webp",
    widthPx: variantName === "original_safe" ? 1600 : 800,
    heightPx: variantName === "original_safe" ? 1000 : 500,
    sizeBytes: 1024,
    checksumSha256: "a".repeat(64),
  };
}

function selectedMedia(mediaId: string, visibility: "private" | "public") {
  return {
    mediaId,
    visibility,
    publicApproved: visibility === "public",
    lifecycleStatus: visibility === "public" ? "active" : "staged",
    hasOriginalSafe: visibility === "private",
  };
}

function fakeDatabase(
  pendingRows: ReturnType<typeof pendingVariant>[],
  approve = true,
  selectedRows?: ReturnType<typeof selectedMedia>[],
) {
  const statements: string[] = [];
  const queries: Array<{ text: string; values?: readonly unknown[] }> = [];
  const query = vi.fn(async (text: string, values?: readonly unknown[]) => {
    statements.push(text);
    queries.push({ text, values });
    if (text.includes('AS "hasOriginalSafe"')) {
      return {
        rows:
          selectedRows ??
          Array.from(new Set(pendingRows.map(({ mediaId }) => mediaId))).map((mediaId) => ({
            ...selectedMedia(mediaId, "private"),
            hasOriginalSafe: pendingRows.some(
              (row) => row.mediaId === mediaId && row.variantName === "original_safe",
            ),
          })),
      };
    }
    if (text.includes("FROM platform.media_objects media")) return { rows: pendingRows };
    if (text.includes("UPDATE platform.media_objects")) {
      return { rows: approve ? [{ id: MEDIA_ID }] : [] };
    }
    return { rows: [] };
  });
  return {
    statements,
    queries,
    pool: {
      query,
      async connect() {
        return { query, release() {} };
      },
      async end() {},
    },
  };
}
