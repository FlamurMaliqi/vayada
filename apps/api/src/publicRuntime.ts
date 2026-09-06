import type { ApiConfig } from "./config.js";
import {
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

  const publicHotelQuoteRepository = createTargetPublicHotelQuoteRepository({
    mixedRoomSelectionsEnabled: true,
    connectionString: requireTargetDatabaseUrl(config),
    profileRepository: publicHotelProfileRepository,
    pool: pools.publicHotelQuotePool,
  });

  const bookingWebCalendarRepository = createTargetBookingWebCalendarRepository({
    connectionString: requireTargetDatabaseUrl(config),
    pool: pools.bookingWebCalendarPool,
  });

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
