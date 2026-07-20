import type { MarketplaceCreatorProfileMediaRepository } from "../routes/marketplaceCreatorSelfService.js";
import type { PlatformMediaRoutesOptions } from "../routes/platformMedia.js";
import {
  createPgS3MarketplaceOfferMediaPromotion,
  type MarketplaceOfferMediaPromotionPort,
} from "./marketplaceOfferMediaPromotion.js";
import type { PlatformMediaServingConfig } from "./mediaServing.js";
import { createPgPlatformMediaRepository } from "./platformMediaRepository.js";
import { createS3PlatformMediaAdapter } from "./platformMediaS3.js";

export type PlatformMediaRuntimeInput = {
  auth?: unknown;
  allowedOrigins?: string[];
  targetDatabaseUrl?: string;
  platformMediaServing?: PlatformMediaServingConfig;
};

export type PlatformMediaRuntimeFactories = {
  createRepository: typeof createPgPlatformMediaRepository;
  createAdapter: typeof createS3PlatformMediaAdapter;
  createOfferMediaPromotion: typeof createPgS3MarketplaceOfferMediaPromotion;
};

export type PlatformMediaRuntime = {
  profileMediaRepository: MarketplaceCreatorProfileMediaRepository;
  offerMediaPromotion: MarketplaceOfferMediaPromotionPort;
  routes: PlatformMediaRoutesOptions;
};

const productionFactories: PlatformMediaRuntimeFactories = {
  createRepository: createPgPlatformMediaRepository,
  createAdapter: createS3PlatformMediaAdapter,
  createOfferMediaPromotion: createPgS3MarketplaceOfferMediaPromotion,
};

export function composePlatformMediaRuntime(
  input: PlatformMediaRuntimeInput,
  factories: PlatformMediaRuntimeFactories = productionFactories,
): PlatformMediaRuntime | undefined {
  if (!input.auth || !input.targetDatabaseUrl || !input.platformMediaServing) return undefined;

  const repository = factories.createRepository({
    connectionString: input.targetDatabaseUrl,
    publicCdnBaseUrl: input.platformMediaServing.cdnBaseUrl,
  });
  const adapter = factories.createAdapter({
    bucketName: input.platformMediaServing.bucketName,
    cdnBaseUrl: input.platformMediaServing.cdnBaseUrl,
    publicPathPrefix: input.platformMediaServing.publicPathPrefix,
    publicCacheControl: input.platformMediaServing.publicCacheControl,
  });
  const offerMediaPromotion = factories.createOfferMediaPromotion({
    connectionString: input.targetDatabaseUrl,
    serving: input.platformMediaServing,
  });

  return {
    profileMediaRepository: repository,
    offerMediaPromotion,
    routes: {
      repository,
      signer: adapter,
      targetResolver: repository,
      finalizer: adapter,
      enabledPurposes: [
        "identity.user.profile_image",
        "property.hero_image",
        "property.gallery_image",
        "marketplace.creator.profile_image",
        "marketplace.offer.media",
      ],
      bucketName: input.platformMediaServing.bucketName,
      allowedOrigins: input.allowedOrigins ?? [],
    },
  };
}
