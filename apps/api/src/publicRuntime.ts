import type { ApiConfig } from "./config.js";
import {
  createCompatibilityPublicHotelQuoteRepository,
  createTargetPublicHotelQuoteRepository,
  type PublicHotelQuoteReadPool,
} from "./routes/aiHotelQuotes.js";
import {
  createTargetPublicHotelProfileRepository,
  type PublicHotelProfileReadPool,
} from "./routes/aiHotels.js";
import { createActiveBookingPublicationProfileRepository } from "./routes/activeBookingPublicationProfile.js";
import {
  createTargetBookingWebCalendarRepository,
  type BookingWebCalendarReadPool,
} from "./routes/bookingWebPublic.js";
import {
  createPgMarketplaceDiscoveryReadRepository,
  type MarketplaceDiscoveryReadPool,
} from "./routes/marketplaceDiscovery.js";

export type PublicRuntimePools = {
  publicHotelProfilePool?: PublicHotelProfileReadPool;
  publicHotelQuotePool?: PublicHotelQuoteReadPool;
  bookingWebCalendarPool?: BookingWebCalendarReadPool;
  marketplaceDiscoveryPool?: MarketplaceDiscoveryReadPool;
};

export function createPublicRuntimeRepositories(config: ApiConfig, pools: PublicRuntimePools = {}) {
  const publicHotelProfileRepository =
    config.publicHotelProfileSource === "active_publication"
      ? createActiveBookingPublicationProfileRepository({
          connectionString: requireTargetDatabaseUrl(config),
          pool: pools.publicHotelProfilePool,
        })
      : createTargetPublicHotelProfileRepository({
          connectionString: requireTargetDatabaseUrl(config),
          pool: pools.publicHotelProfilePool,
        });

  const publicHotelQuoteRepository =
    config.publicBookabilitySource === "target"
      ? createTargetPublicHotelQuoteRepository({
          connectionString: requireTargetDatabaseUrl(config),
          profileRepository: publicHotelProfileRepository,
          pool: pools.publicHotelQuotePool,
        })
      : createCompatibilityPublicHotelQuoteRepository({
          profileRepository: publicHotelProfileRepository,
        });

  const bookingWebCalendarRepository =
    config.publicBookabilitySource === "target"
      ? createTargetBookingWebCalendarRepository({
          connectionString: requireTargetDatabaseUrl(config),
          pool: pools.bookingWebCalendarPool,
        })
      : undefined;

  const marketplaceDiscoveryRepository = createPgMarketplaceDiscoveryReadRepository({
    connectionString: requireTargetDatabaseUrl(config),
    pool: pools.marketplaceDiscoveryPool,
  });

  return {
    publicHotelProfileRepository,
    publicHotelQuoteRepository,
    bookingWebCalendarRepository,
    marketplaceDiscoveryRepository,
  };
}

function requireTargetDatabaseUrl(config: ApiConfig): string {
  if (!config.targetDatabaseUrl) {
    throw new Error("TARGET_DATABASE_URL is required for target public runtime repositories");
  }
  return config.targetDatabaseUrl;
}
