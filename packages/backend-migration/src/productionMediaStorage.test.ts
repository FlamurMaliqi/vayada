import { GetObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3";
import sharp from "sharp";
import { describe, expect, it, vi } from "vitest";

import type { ProductionMediaReference } from "./productionMediaPlan.js";
import {
  createS3ProductionMediaStorage,
  parseLegacyS3Url,
  ProductionMediaSourceError,
} from "./productionMediaStorage.js";

const MEDIA = "10550000-0000-4000-a000-000000000010";

describe("production media storage", () => {
  it("validates and re-encodes public images into deterministic CDN variants", async () => {
    const bytes = await sharp({
      create: { width: 40, height: 30, channels: 3, background: "#336699" },
    })
      .png()
      .toBuffer();
    const puts: PutObjectCommand[] = [];
    const s3 = {
      send: vi.fn(async (command: unknown) => {
        if (command instanceof GetObjectCommand)
          return { Body: bytes, ContentLength: bytes.length, ContentType: "image/png" };
        if (command instanceof PutObjectCommand) {
          puts.push(command);
          return {};
        }
        throw new Error("unexpected S3 command");
      }),
    };
    const storage = createS3ProductionMediaStorage({
      targetBucket: "platform-media-test",
      cdnBaseUrl: "https://media.example.test",
      allowedLegacyBuckets: ["legacy-media-test"],
      s3: s3 as never,
    });

    const imported = await storage.importReference(reference());
    expect(puts).toHaveLength(4);
    expect(imported.variants.map((variant) => variant.variantName).sort()).toEqual([
      "blur_preview",
      "large",
      "original_safe",
      "thumbnail",
    ]);
    expect(imported.storageKey).toMatch(
      new RegExp(`^public/media/${MEDIA}/original_safe/sha256-[0-9a-f]{64}\\.webp$`),
    );
    expect(imported.checksumSha256).toBe(
      imported.variants.find((variant) => variant.variantName === "original_safe")!.checksumSha256,
    );
    expect(imported.sourceChecksumSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(
      imported.variants.every((variant) =>
        variant.publicCdnUrl?.startsWith("https://media.example.test/media/"),
      ),
    ).toBe(true);
  });

  it("rejects corrupt private images before writing target storage", async () => {
    let putCount = 0;
    const s3 = {
      send: vi.fn(async (command: unknown) => {
        if (command instanceof GetObjectCommand)
          return { Body: Buffer.from("not-an-image"), ContentType: "image/jpeg" };
        if (command instanceof PutObjectCommand) putCount += 1;
        return {};
      }),
    };
    const storage = createS3ProductionMediaStorage({
      targetBucket: "platform-media-test",
      cdnBaseUrl: "https://media.example.test",
      allowedLegacyBuckets: ["legacy-media-test"],
      s3: s3 as never,
    });

    await expect(
      storage.importReference({ ...reference(), visibility: "private", publicApproved: false }),
    ).rejects.toMatchObject({ code: "SOURCE_CORRUPT" });
    expect(putCount).toBe(0);
  });

  it("accepts only reviewed immutable S3 object URLs and a non-S3 CDN", () => {
    expect(
      parseLegacyS3Url(
        "https://legacy-media-test.s3.eu-central-1.amazonaws.com/rooms/a.jpg",
        new Set(["legacy-media-test"]),
      ),
    ).toEqual({ bucket: "legacy-media-test", key: "rooms/a.jpg" });
    expect(() =>
      parseLegacyS3Url(
        "https://legacy-media-test.s3.amazonaws.com/rooms/a.jpg?signature=secret",
        new Set(["legacy-media-test"]),
      ),
    ).toThrow(ProductionMediaSourceError);
    expect(() =>
      createS3ProductionMediaStorage({
        targetBucket: "platform-media-test",
        cdnBaseUrl: "https://platform-media-test.s3.amazonaws.com",
        allowedLegacyBuckets: ["legacy-media-test"],
        s3: {} as never,
      }),
    ).toThrow("raw S3 origin");
  });
});

function reference(): ProductionMediaReference {
  return {
    mediaObjectId: MEDIA,
    sourceSystem: "booking",
    sourceTable: "booking_hotels",
    sourceRowId: "hotel:hero_image",
    sourceField: "hero_image",
    sourceUrl: "https://legacy-media-test.s3.amazonaws.com/hotels/hero.png",
    sourceUpdatedAt: "2026-08-30T00:00:00.000Z",
    sourceReferenceSha256: "a".repeat(64),
    purpose: "property.hero_image",
    visibility: "public",
    publicApproved: true,
    propertyId: "10550000-0000-4000-a000-000000000011",
    ownerOrganizationId: "10550000-0000-4000-a000-000000000012",
    resourceProduct: "hotel_catalog",
    resourceType: "property",
    resourceId: "10550000-0000-4000-a000-000000000011",
    sortOrder: 0,
    originalFilename: "hero.png",
    retainedUntil: null,
  };
}
