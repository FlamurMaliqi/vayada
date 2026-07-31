import type { MarketplaceCreatorProfileMediaRepository } from "../routes/marketplaceCreatorSelfService.js";
import type {
  HotelMediaUploadSource,
  PlatformMediaRoutesOptions,
} from "../routes/platformMedia.js";
import { createPgPlatformMediaCleanupStore } from "../jobs/platformMediaCleanup.js";
import {
  createPgS3MarketplaceOfferMediaPromotion,
  type MarketplaceOfferMediaPromotionPort,
} from "./marketplaceOfferMediaPromotion.js";
import type { PlatformMediaServingConfig } from "./mediaServing.js";
import { createPgPlatformMediaRepository } from "./platformMediaRepository.js";
import {
  createS3PlatformMediaAdapter,
  type PlatformMediaPrivateDownloadSigner,
} from "./platformMediaS3.js";

export type PlatformMediaRuntimeInput = {
  auth?: unknown;
  allowedOrigins?: string[];
  targetDatabaseUrl: string;
  platformMediaServing?: PlatformMediaServingConfig;
  hotelMediaUploadSource: HotelMediaUploadSource;
};

export type PlatformMediaRuntimeFactories = {
  createRepository: typeof createPgPlatformMediaRepository;
  createAdapter: typeof createS3PlatformMediaAdapter;
  createOfferMediaPromotion: typeof createPgS3MarketplaceOfferMediaPromotion;
  createCleanupStore: typeof createPgPlatformMediaCleanupStore;
};

export type PlatformMediaRuntime = {
  profileMediaRepository: MarketplaceCreatorProfileMediaRepository;
  offerMediaPromotion: MarketplaceOfferMediaPromotionPort;
  collaborationAttachments: {
    repository: ReturnType<typeof createPgPlatformMediaRepository>;
    signer: PlatformMediaPrivateDownloadSigner;
    serving: PlatformMediaServingConfig;
  };
  cleanupStore: ReturnType<typeof createPgPlatformMediaCleanupStore>;
  routes: PlatformMediaRoutesOptions;
};

const productionFactories: PlatformMediaRuntimeFactories = {
  createRepository: createPgPlatformMediaRepository,
  createAdapter: createS3PlatformMediaAdapter,
  createOfferMediaPromotion: createPgS3MarketplaceOfferMediaPromotion,
  createCleanupStore: createPgPlatformMediaCleanupStore,
};

export function composePlatformMediaRuntime(
  input: PlatformMediaRuntimeInput,
  factories: PlatformMediaRuntimeFactories = productionFactories,
): PlatformMediaRuntime | undefined {
  if (!input.auth || !input.platformMediaServing) return undefined;

  const repository = factories.createRepository({
    connectionString: input.targetDatabaseUrl,
    publicCdnBaseUrl: input.platformMediaServing.cdnBaseUrl,
    mediaPathPrefix: input.platformMediaServing.publicPathPrefix,
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
  const cleanupStore = factories.createCleanupStore({
    connectionString: input.targetDatabaseUrl,
    objectDeleter: adapter,
  });
  const enabledPurposes: PlatformMediaRoutesOptions["enabledPurposes"] = [
    "identity.user.profile_image",
    "property.hero_image",
    "property.gallery_image",
    "marketplace.creator.profile_image",
    "marketplace.offer.media",
    "marketplace.collaboration_chat.attachment",
    ...(input.hotelMediaUploadSource === "target"
      ? (["property.logo", "pms.room_type.media"] as const)
      : []),
  ];

  return {
    profileMediaRepository: repository,
    offerMediaPromotion,
    collaborationAttachments: {
      repository,
      signer: adapter,
      serving: input.platformMediaServing,
    },
    cleanupStore,
    routes: {
      repository,
      signer: adapter,
      targetResolver: repository,
      finalizer: adapter,
      enabledPurposes,
      bucketName: input.platformMediaServing.bucketName,
      mediaPathPrefix: input.platformMediaServing.publicPathPrefix,
      hotelMediaUploadSource: input.hotelMediaUploadSource,
      allowedOrigins: input.allowedOrigins ?? [],
    },
  };
}
