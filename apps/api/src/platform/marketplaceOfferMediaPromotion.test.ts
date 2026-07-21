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
      promotion.promoteOfferMedia({ organizationId: "org-1", offerId: "offer-1" }),
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
    mediaId: "media-1",
    variantName,
    storageKey: `private/media/media-1/${variantName}/sha256-${"a".repeat(64)}.webp`,
    contentType: "image/webp",
    widthPx: variantName === "original_safe" ? 1600 : 800,
    heightPx: variantName === "original_safe" ? 1000 : 500,
    sizeBytes: 1024,
    checksumSha256: "a".repeat(64),
  };
}

function fakeDatabase(pendingRows: ReturnType<typeof pendingVariant>[], approve = true) {
  const statements: string[] = [];
  const queries: Array<{ text: string; values?: readonly unknown[] }> = [];
  const query = vi.fn(async (text: string, values?: readonly unknown[]) => {
    statements.push(text);
    queries.push({ text, values });
    if (text.includes("FROM platform.media_objects media")) return { rows: pendingRows };
    if (text.includes("UPDATE platform.media_objects")) {
      return { rows: approve ? [{ id: "media-1" }] : [] };
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
