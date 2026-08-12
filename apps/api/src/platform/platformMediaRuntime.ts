import type { MarketplaceCreatorProfileMediaRepository } from "../routes/marketplaceCreatorSelfService.js";
import { syncPropertyOfferReadModels } from "../routes/marketplaceAdmin.js";
import type { PlatformMediaRoutesOptions } from "../routes/platformMedia.js";
import { createPgPlatformMediaCleanupStore } from "../jobs/platformMediaCleanup.js";
import { createPgS3PropertyMediaCommandRepository } from "../domains/propertyMediaCommandRepository.js";
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
};

export type PlatformMediaRuntimeFactories = {
  createRepository: typeof createPgPlatformMediaRepository;
  createAdapter: typeof createS3PlatformMediaAdapter;
  createOfferMediaPromotion: typeof createPgS3MarketplaceOfferMediaPromotion;
  createCleanupStore: typeof createPgPlatformMediaCleanupStore;
  createPropertyMediaCommands: typeof createPgS3PropertyMediaCommandRepository;
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
  propertyMediaCommands: ReturnType<typeof createPgS3PropertyMediaCommandRepository>;
  routes: PlatformMediaRoutesOptions;
};

const productionFactories: PlatformMediaRuntimeFactories = {
  createRepository: createPgPlatformMediaRepository,
  createAdapter: createS3PlatformMediaAdapter,
  createOfferMediaPromotion: createPgS3MarketplaceOfferMediaPromotion,
  createCleanupStore: createPgPlatformMediaCleanupStore,
  createPropertyMediaCommands: createPgS3PropertyMediaCommandRepository,
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
  const propertyMediaCommands = factories.createPropertyMediaCommands({
    connectionString: input.targetDatabaseUrl,
    serving: input.platformMediaServing,
    syncReadModels: syncPropertyOfferReadModels,
  });
  const enabledPurposes: PlatformMediaRoutesOptions["enabledPurposes"] = [
    "identity.user.profile_image",
    "booking.header_logo",
    "property.hero_image",
    "property.gallery_image",
    "marketplace.creator.profile_image",
    "marketplace.offer.media",
    "marketplace.collaboration_chat.attachment",
    "property.logo",
    "pms.room_type.media",
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
    propertyMediaCommands,
    routes: {
      repository,
      signer: adapter,
      targetResolver: repository,
      finalizer: adapter,
      enabledPurposes,
      bucketName: input.platformMediaServing.bucketName,
      mediaPathPrefix: input.platformMediaServing.publicPathPrefix,
      allowedOrigins: input.allowedOrigins ?? [],
    },
  };
}
