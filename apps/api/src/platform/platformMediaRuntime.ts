import type { MarketplaceCreatorProfileMediaRepository } from "../routes/marketplaceCreatorSelfService.js";
import {
  createPassthroughPlatformMediaTargetResolver,
  type PlatformMediaRoutesOptions,
} from "../routes/platformMedia.js";
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
};

export type PlatformMediaRuntime = {
  profileMediaRepository: MarketplaceCreatorProfileMediaRepository;
  routes: PlatformMediaRoutesOptions;
};

const productionFactories: PlatformMediaRuntimeFactories = {
  createRepository: createPgPlatformMediaRepository,
  createAdapter: createS3PlatformMediaAdapter,
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

  return {
    profileMediaRepository: repository,
    routes: {
      repository,
      signer: adapter,
      targetResolver: createPassthroughPlatformMediaTargetResolver(),
      finalizer: adapter,
      enabledPurposes: ["identity.user.profile_image", "marketplace.creator.profile_image"],
      bucketName: input.platformMediaServing.bucketName,
      allowedOrigins: input.allowedOrigins ?? [],
    },
  };
}
