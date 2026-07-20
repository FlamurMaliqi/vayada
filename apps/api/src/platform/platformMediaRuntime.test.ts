import { describe, expect, it, vi } from "vitest";

import type { PlatformMediaServingConfig } from "./mediaServing.js";
import { createPgS3MarketplaceOfferMediaPromotion } from "./marketplaceOfferMediaPromotion.js";
import { createPgPlatformMediaRepository } from "./platformMediaRepository.js";
import {
  composePlatformMediaRuntime,
  type PlatformMediaRuntimeFactories,
  type PlatformMediaRuntimeInput,
} from "./platformMediaRuntime.js";
import { createS3PlatformMediaAdapter } from "./platformMediaS3.js";

const platformMediaServing: PlatformMediaServingConfig = {
  bucketName: "vayada-media-production",
  cdnBaseUrl: "https://cdn.vayada.com",
  cdnOriginHost: "vayada-media-production.s3.us-east-1.amazonaws.com",
  publicPathPrefix: "profile-media",
  publicCacheControl: "public, max-age=31536000, immutable",
  privateDownloadTtlSeconds: 300,
  privateDownloadMaxTtlSeconds: 900,
};

const completeInput: PlatformMediaRuntimeInput = {
  auth: {},
  targetDatabaseUrl: "postgresql://target-db",
  platformMediaServing,
  allowedOrigins: ["https://marketplace.vayada.com"],
};

describe("platform media runtime composition", () => {
  it("keeps the runtime dark until every prerequisite is configured", () => {
    for (const missing of ["auth", "targetDatabaseUrl", "platformMediaServing"] as const) {
      const { factories } = fakeFactories();

      expect(
        composePlatformMediaRuntime({ ...completeInput, [missing]: undefined }, factories),
      ).toBeUndefined();
      expect(factories.createRepository).not.toHaveBeenCalled();
      expect(factories.createAdapter).not.toHaveBeenCalled();
      expect(factories.createOfferMediaPromotion).not.toHaveBeenCalled();
    }
  });

  it("shares production resources across profile validation and the restricted routes", () => {
    const { repository, adapter, offerMediaPromotion, factories } = fakeFactories();
    const runtime = composePlatformMediaRuntime(completeInput, factories);
    if (!runtime) throw new Error("Expected complete media configuration to compose a runtime");

    expect(factories.createRepository).toHaveBeenCalledOnce();
    expect(factories.createRepository).toHaveBeenCalledWith({
      connectionString: "postgresql://target-db",
      publicCdnBaseUrl: "https://cdn.vayada.com",
    });
    expect(factories.createAdapter).toHaveBeenCalledOnce();
    expect(factories.createAdapter).toHaveBeenCalledWith({
      bucketName: "vayada-media-production",
      cdnBaseUrl: "https://cdn.vayada.com",
      publicPathPrefix: "profile-media",
      publicCacheControl: "public, max-age=31536000, immutable",
    });
    expect(factories.createOfferMediaPromotion).toHaveBeenCalledOnce();
    expect(factories.createOfferMediaPromotion).toHaveBeenCalledWith({
      connectionString: "postgresql://target-db",
      serving: platformMediaServing,
    });

    expect(runtime.profileMediaRepository).toBe(repository);
    expect(runtime.offerMediaPromotion).toBe(offerMediaPromotion);
    expect(runtime.routes.repository).toBe(repository);
    expect(runtime.routes.signer).toBe(adapter);
    expect(runtime.routes.finalizer).toBe(adapter);
    expect(runtime.routes.targetResolver).toBe(repository);
    expect(runtime.routes).toMatchObject({
      enabledPurposes: [
        "identity.user.profile_image",
        "property.hero_image",
        "property.gallery_image",
        "marketplace.creator.profile_image",
        "marketplace.offer.media",
      ],
      bucketName: "vayada-media-production",
      allowedOrigins: ["https://marketplace.vayada.com"],
    });
  });
});

function fakeFactories() {
  const repository = {} as ReturnType<typeof createPgPlatformMediaRepository>;
  const adapter = {} as ReturnType<typeof createS3PlatformMediaAdapter>;
  const offerMediaPromotion = {} as ReturnType<typeof createPgS3MarketplaceOfferMediaPromotion>;
  const factories: PlatformMediaRuntimeFactories = {
    createRepository: vi.fn(() => repository),
    createAdapter: vi.fn(() => adapter),
    createOfferMediaPromotion: vi.fn(() => offerMediaPromotion),
  };
  return { repository, adapter, offerMediaPromotion, factories };
}
