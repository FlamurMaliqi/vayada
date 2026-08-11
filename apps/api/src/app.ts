import { backendAuthPlugin, type BackendAuthPluginOptions } from "@vayada/backend-auth";
import type { IdentityLifecycleCommandBus } from "@vayada/backend-auth";
import type { BookingGuestPiiPort } from "@vayada/domain-booking";
import type { BookingPublicationCommandPort } from "@vayada/domain-booking";
import type { FinanceSubscriptionService } from "@vayada/domain-finance";
import type {
  PmsInventoryPublicOfferProjectionPort,
  PublicBookabilityPublicationCommandPort,
} from "@vayada/domain-distribution";
import {
  createAuthorizationResolver,
  type EntitlementRepository,
  type RolePermissionRepository,
} from "@vayada/backend-authorization";
import Fastify, { type FastifyInstance, type FastifyServerOptions } from "fastify";

import type { HotelSetupTrackCommandRepository } from "./domains/hotelSetupTrackCommandRepository.js";
import type { HotelCatalogStep1Repository } from "./domains/hotelCatalogStep1Repository.js";
import type { PropertyMediaCommandRepository } from "./domains/propertyMediaCommandRepository.js";
import type { PropertySetupDraftCommandRepository } from "./domains/propertySetupDraftCommandRepository.js";
import type { PropertyPlanReadRepository } from "./domains/propertyPlanReadModel.js";
import type { PublicHotelProfileRepository } from "./routes/aiHotels.js";
import type { PublicHotelQuoteRepository } from "./routes/aiHotelQuotes.js";
import type { AskAuditRepository, AskRoutesOptions } from "./routes/ask.js";
import type { BookingReservationsReadRepository } from "./routes/bookingReservations.js";
import type {
  PmsOperationsCommandRepository,
  PmsOperationsReadRepository,
} from "./routes/pmsOperations.js";
import type { AuthSessionRouteOptions } from "./routes/authSession.js";
import type {
  BookingSettingsReadRepository,
  BookingSettingsWriteRepository,
} from "./routes/bookingSettings.js";
import { registerAiHotelQuoteRoutes } from "./routes/aiHotelQuotes.js";
import { registerAiHotelRoutes } from "./routes/aiHotels.js";
import { registerAskRoutes } from "./routes/ask.js";
import { registerAuthSessionRoutes } from "./routes/authSession.js";
import type { BookingCustomDomainRepository } from "./routes/bookingCustomDomain.js";
import { registerBookingRoutes, type BookingRoutesOptions } from "./routes/booking.js";
import type { BookingAddonItemsRepository } from "./routes/bookingAddonItems.js";
import type { BookingPromoCodesRepository } from "./routes/bookingPromoCodes.js";
import {
  registerWorkosWebhookRoutes,
  type WorkosWebhookRoutesOptions,
} from "./routes/workosWebhooks.js";
import {
  registerProviderWebhookRoutes,
  type ProviderWebhookRoutesOptions,
} from "./routes/providerWebhooks.js";
import { registerRouteGroups } from "./routes/groups.js";
import { registerHealthRoutes } from "./routes/health.js";
import {
  registerMarketplaceDiscoveryRoutes,
  type MarketplaceDiscoveryReadRepository,
} from "./routes/marketplaceDiscovery.js";
import {
  registerMarketplaceCollaborationRoutes,
  type MarketplaceCollaborationReadRepository,
} from "./routes/marketplaceCollaborations.js";
import {
  registerMarketplaceTripRoutes,
  type MarketplaceTripReadRepository,
} from "./routes/marketplaceTrips.js";
import {
  registerMarketplaceAdminRoutes,
  type MarketplaceAdminRepository,
  type MarketplaceAdminRoutesOptions,
} from "./routes/marketplaceAdmin.js";
import {
  registerHotelAccountInviteRoutes,
  type HotelAccountInviteRoutesOptions,
} from "./routes/hotelAccountInvites.js";
import {
  registerMarketplaceHotelProfileStatusRoutes,
  type MarketplaceHotelProfileStatusRepository,
} from "./routes/marketplaceHotelProfileStatus.js";
import {
  registerMarketplaceHotelSelfServiceRoutes,
  type MarketplaceHotelSelfServiceRepository,
} from "./routes/marketplaceHotelSelfService.js";
import {
  registerMarketplaceCreatorSelfServiceRoutes,
  type MarketplaceCreatorProfileMediaRepository,
  type MarketplaceCreatorSelfServiceRepository,
} from "./routes/marketplaceCreatorSelfService.js";
import {
  registerMarketplaceCreatorPlatformConnectionRoutes,
  type MarketplaceCreatorPlatformConnectionRoutesOptions,
} from "./routes/marketplaceCreatorPlatformConnections.js";
import {
  registerSharedHotelSetupStatusRoutes,
  type SharedHotelSetupStatusRepository,
  type SharedPropertyLaunchSettingsRepository,
} from "./routes/sharedHotelSetupStatus.js";
import { registerPropertyMediaRoutes } from "./routes/propertyMedia.js";
import { registerHotelCatalogStep1Routes } from "./routes/hotelCatalogStep1.js";
import {
  registerMarketplaceHotelCollaborationPreferencesRoutes,
  type MarketplaceHotelCollaborationPreferencesRoutesOptions,
} from "./routes/marketplaceHotelCollaborationPreferences.js";
import {
  registerBookingDesignRoutes,
  type BookingDesignRoutesOptions,
} from "./routes/bookingDesign.js";
import {
  registerBookingDesignReadinessRoutes,
  type BookingDesignReadinessRoutesOptions,
} from "./routes/bookingDesignReadiness.js";
import {
  registerPropertySetupRouteRoutes,
  type PropertySetupRouteStateReadPort,
} from "./routes/propertySetupRoute.js";
import {
  registerIdentityAdminUserRoutes,
  type IdentityAdminUsersReadRepository,
  type IdentityAdminUserRoutesOptions,
} from "./routes/identityAdminUsers.js";
import {
  registerIdentityPrivacyRoutes,
  type IdentityPrivacyRepository,
} from "./routes/identityPrivacy.js";
import {
  registerBookingWebPublicRoutes,
  type BookingWebAttributionSink,
  type BookingWebCalendarRepository,
  type BookingWebCheckoutAdapter,
  type BookingWebPublicRoutesOptions,
  type BookingDomainResolutionSource,
} from "./routes/bookingWebPublic.js";
import type { BookingHotelChangeRequestRepository } from "./routes/bookingChangeRequests.js";
import {
  registerBookingWebAffiliateRoutes,
  type BookingWebAffiliateHotelResolver,
  type BookingWebAffiliateRepository,
} from "./routes/bookingWebAffiliate.js";
import {
  registerFinanceRoutes,
  registerPmsFinanceCompatibilityRoutes,
  type FinancePublicHotelPropertyResolver,
  type FinanceRoutesOptions,
  type FinanceXenditBankValidator,
  type PmsFinanceCompatibilityRoutesOptions,
} from "./routes/finance.js";
import { registerFinanceSubscriptionRoutes } from "./routes/financeSubscriptions.js";
import {
  registerAffiliateDashboardRoutes,
  type AffiliateDashboardReadRepository,
} from "./routes/affiliateDashboard.js";
import {
  registerPlatformMediaRoutes,
  type PlatformMediaRoutesOptions,
} from "./routes/platformMedia.js";
import {
  registerPlatformContactIntakeRoutes,
  type PlatformContactIntakeRoutesOptions,
} from "./routes/platformContactIntake.js";
import {
  registerPlatformAdminDashboardRoutes,
  type PlatformAdminDashboardRepository,
} from "./routes/platform/admin/dashboard/bookingCompatible.js";
import { registerPmsOperationsRoutes } from "./routes/pmsOperations.js";
import {
  registerPmsModuleActivationRoutes,
  type PmsModuleActivationRepository,
} from "./routes/pmsModuleActivations.js";
import { registerPmsReviewRoutes, type PmsReviewRepository } from "./routes/pmsReviews.js";
import { registerPropertySetupDraftRoutes } from "./routes/propertySetupDrafts.js";
import { registerBookingPublicationRoutes } from "./routes/bookingPublication.js";
import type { BookingPublicationRoutesOptions } from "./routes/bookingPublication.js";

export type ApiAuthOptions = Omit<BackendAuthPluginOptions, "authorizationResolver"> & {
  rolePermissionRepository: RolePermissionRepository;
  entitlementRepository?: EntitlementRepository;
};

type BuildAppOptions = Pick<FastifyServerOptions, "logger"> & {
  auth?: ApiAuthOptions;
  authSession?: AuthSessionRouteOptions;
  browserAllowedOrigins?: string[];
  workosWebhooks?: WorkosWebhookRoutesOptions;
  providerWebhooks?: ProviderWebhookRoutesOptions;
  bookingReservationsRepository?: BookingReservationsReadRepository;
  bookingChangeRequestRepository?: BookingHotelChangeRequestRepository;
  pmsOperationsRepository?: PmsOperationsReadRepository;
  pmsModuleActivationRepository?: PmsModuleActivationRepository;
  pmsReviewRepository?: PmsReviewRepository;
  pmsCheckoutChargeMarkPaidFreezeEnabled?: boolean;
  pmsOperationsCommandRepository?: PmsOperationsCommandRepository;
  pmsInventoryPublicOfferProjector?: PmsInventoryPublicOfferProjectionPort;
  bookingGuestPiiPort?: BookingGuestPiiPort;
  pmsOperationsAllowedOrigins?: string[];
  propertyPlanReadRepository?: PropertyPlanReadRepository;
  bookingDashboardMetricsReadPort?: BookingRoutesOptions["dashboardMetricsReadPort"];
  bookingAddonItemsRepository?: BookingAddonItemsRepository;
  bookingPromoCodesRepository?: BookingPromoCodesRepository;
  bookingSettingsRepository?: BookingSettingsReadRepository;
  bookingSettingsWriteRepository?: BookingSettingsWriteRepository;
  publicBookabilityPublisher?: PublicBookabilityPublicationCommandPort;
  bookingCustomDomainRepository?: BookingCustomDomainRepository;
  publicHotelProfileRepository?: PublicHotelProfileRepository;
  publicHotelQuoteRepository?: PublicHotelQuoteRepository;
  marketplaceDiscoveryRepository?: MarketplaceDiscoveryReadRepository;
  marketplaceCollaborationRepository?: MarketplaceCollaborationReadRepository;
  marketplaceTripRepository?: MarketplaceTripReadRepository;
  marketplaceAdminRepository?: MarketplaceAdminRepository;
  marketplaceAdminLegacySuperadminFallbackEnabled?: MarketplaceAdminRoutesOptions["legacySuperadminFallbackEnabled"];
  hotelAccountInvites?: Omit<HotelAccountInviteRoutesOptions, "trackCommandRepository">;
  marketplaceHotelProfileStatusRepository?: MarketplaceHotelProfileStatusRepository;
  marketplaceHotelSelfServiceRepository?: MarketplaceHotelSelfServiceRepository;
  marketplaceCreatorSelfServiceRepository?: MarketplaceCreatorSelfServiceRepository;
  marketplaceCreatorPlatformConnections?: Omit<
    MarketplaceCreatorPlatformConnectionRoutesOptions,
    "profileRepository" | "lifecycleCommandBus"
  >;
  marketplaceCreatorProfileMediaRepository?: MarketplaceCreatorProfileMediaRepository;
  sharedHotelSetupStatusRepository?: SharedHotelSetupStatusRepository;
  propertyLaunchSettingsRepository?: SharedPropertyLaunchSettingsRepository;
  hotelSetupTrackCommandRepository?: HotelSetupTrackCommandRepository;
  propertyMediaCommandRepository?: PropertyMediaCommandRepository;
  hotelCatalogStep1?: {
    repository: HotelCatalogStep1Repository;
    mediaCommands: Pick<PropertyMediaCommandRepository, "replacePresentation">;
  };
  marketplaceHotelCollaborationPreferences?: MarketplaceHotelCollaborationPreferencesRoutesOptions;
  bookingDesign?: BookingDesignRoutesOptions;
  bookingDesignReadiness?: BookingDesignReadinessRoutesOptions;
  propertySetupDraftCommandRepository?: PropertySetupDraftCommandRepository;
  propertySetupRouteStateReadPort?: PropertySetupRouteStateReadPort;
  bookingPublication?: {
    repository: BookingPublicationCommandPort;
    readinessProvider: BookingPublicationRoutesOptions["readinessProvider"];
  };
  identityPrivacyRepository?: IdentityPrivacyRepository;
  identityLifecycleCommandBus?: IdentityLifecycleCommandBus;
  identityAdminUsersReadRepository?: IdentityAdminUsersReadRepository;
  identityAdminUsers?: Omit<
    IdentityAdminUserRoutesOptions,
    "lifecycleCommandBus" | "readRepository"
  >;
  askAuditRepository?: AskAuditRepository;
  askRuntime?: AskRoutesOptions["runtime"];
  askEvidenceRepository?: AskRoutesOptions["evidenceRepository"];
  askModel?: AskRoutesOptions["model"];
  askModelMetadata?: AskRoutesOptions["modelMetadata"];
  askBudgets?: AskRoutesOptions["budgets"];
  askNow?: AskRoutesOptions["now"];
  platformContactIntake?: PlatformContactIntakeRoutesOptions;
  platformAdminDashboardRepository?: PlatformAdminDashboardRepository;
  marketplaceDiscoveryAllowedOrigins?: string[];
  identityPrivacyAllowedOrigins?: string[];
  bookingDomainResolutionSource?: BookingDomainResolutionSource;
  bookingWebCalendarRepository?: BookingWebCalendarRepository;
  bookingWebCheckoutAdapter?: BookingWebCheckoutAdapter;
  bookingWebAffiliateHotelResolver?: BookingWebAffiliateHotelResolver;
  bookingWebAffiliateRepository?: BookingWebAffiliateRepository;
  bookingWebAttributionSink?: BookingWebAttributionSink;
  bookingWebPublicNow?: BookingWebPublicRoutesOptions["now"];
  affiliateDashboardRepository?: Partial<AffiliateDashboardReadRepository>;
  financeRepository?: FinanceRoutesOptions["repository"];
  financeSubscriptionService?: FinanceSubscriptionService;
  pmsFinanceCompatibilityRepository?: PmsFinanceCompatibilityRoutesOptions["repository"];
  financeXenditBankValidator?: FinanceXenditBankValidator;
  financePublicHotelProfileRepository?: PublicHotelProfileRepository;
  financePublicHotelPropertyResolver?: FinancePublicHotelPropertyResolver;
  platformMedia?: PlatformMediaRoutesOptions;
};

export function buildApp(options: BuildAppOptions = {}): FastifyInstance {
  const app = Fastify({
    logger: options.logger ?? {
      level: process.env.LOG_LEVEL ?? "info",
    },
    disableRequestLogging: (request) =>
      request.url.startsWith("/api/marketplace/creator-platform-oauth/"),
  });

  registerBrowserCors(app, options.browserAllowedOrigins ?? []);

  if (options.auth) {
    const { rolePermissionRepository, entitlementRepository, ...authOptions } = options.auth;
    app.register(backendAuthPlugin, {
      ...authOptions,
      authorizationResolver: createAuthorizationResolver(
        rolePermissionRepository,
        entitlementRepository,
      ),
    });
  }

  app.register(registerHealthRoutes);
  if (options.authSession) {
    app.register(registerAuthSessionRoutes, {
      prefix: "/auth",
      ...options.authSession,
      profileImageMediaRepository:
        options.authSession.profileImageMediaRepository ??
        options.marketplaceCreatorProfileMediaRepository,
      hotelAccountInviteOnboarding:
        options.hotelAccountInvites?.repository ?? options.authSession.hotelAccountInviteOnboarding,
    });
  }
  if (options.workosWebhooks) {
    app.register(registerWorkosWebhookRoutes, {
      prefix: "/auth/workos",
      ...options.workosWebhooks,
    });
  }
  if (options.providerWebhooks) {
    app.register(registerProviderWebhookRoutes, options.providerWebhooks);
  }
  app.register(registerRouteGroups, { prefix: "/api" });
  app.register(registerAskRoutes, {
    prefix: "/api/ai",
    auditRepository: options.askAuditRepository,
    runtime: options.askRuntime,
    evidenceRepository: options.askEvidenceRepository,
    model: options.askModel,
    modelMetadata: options.askModelMetadata,
    budgets: options.askBudgets,
    now: options.askNow,
  });
  if (options.publicHotelProfileRepository) {
    app.register(registerAiHotelRoutes, {
      prefix: "/api/ai",
      repository: options.publicHotelProfileRepository,
    });
  }
  if (options.publicHotelQuoteRepository) {
    app.register(registerAiHotelQuoteRoutes, {
      prefix: "/api/ai",
      repository: options.publicHotelQuoteRepository,
    });
  }
  if (options.publicHotelProfileRepository) {
    app.register(registerBookingWebPublicRoutes, {
      prefix: "/api/booking-web",
      profileRepository: options.publicHotelProfileRepository,
      quoteRepository: options.publicHotelQuoteRepository,
      bookingDomainResolutionSource: options.bookingDomainResolutionSource,
      calendarRepository: options.bookingWebCalendarRepository,
      checkoutAdapter: options.bookingWebCheckoutAdapter,
      affiliateHotelResolver:
        options.bookingWebAffiliateHotelResolver ?? options.publicHotelProfileRepository,
      affiliateRepository: options.bookingWebAffiliateRepository,
      attributionSink: options.bookingWebAttributionSink,
      now: options.bookingWebPublicNow,
    });
  } else if (options.bookingWebAffiliateRepository && options.bookingWebAffiliateHotelResolver) {
    app.register(registerBookingWebAffiliateRoutes, {
      prefix: "/api/booking-web",
      hotelResolver: options.bookingWebAffiliateHotelResolver,
      repository: options.bookingWebAffiliateRepository,
    });
  }
  if (options.marketplaceDiscoveryRepository) {
    app.register(registerMarketplaceDiscoveryRoutes, {
      prefix: "/api/marketplace",
      repository: options.marketplaceDiscoveryRepository,
      allowedOrigins: options.marketplaceDiscoveryAllowedOrigins,
    });
  }
  if (options.marketplaceCollaborationRepository) {
    app.register(registerMarketplaceCollaborationRoutes, {
      prefix: "/api/marketplace",
      repository: options.marketplaceCollaborationRepository,
    });
  }
  if (options.marketplaceTripRepository) {
    app.register(registerMarketplaceTripRoutes, {
      prefix: "/api/marketplace",
      repository: options.marketplaceTripRepository,
    });
  }
  if (options.marketplaceAdminRepository) {
    app.register(registerMarketplaceAdminRoutes, {
      prefix: "/api/marketplace",
      repository: options.marketplaceAdminRepository,
      legacySuperadminFallbackEnabled: options.marketplaceAdminLegacySuperadminFallbackEnabled,
    });
  }
  if (options.hotelAccountInvites) {
    if (!options.hotelSetupTrackCommandRepository) {
      throw new Error("hotelSetupTrackCommandRepository is required with hotelAccountInvites");
    }
    app.register(registerHotelAccountInviteRoutes, {
      prefix: "/api/marketplace",
      ...options.hotelAccountInvites,
      trackCommandRepository: options.hotelSetupTrackCommandRepository,
    });
  }
  if (options.marketplaceHotelProfileStatusRepository) {
    app.register(registerMarketplaceHotelProfileStatusRoutes, {
      prefix: "/api/marketplace",
      repository: options.marketplaceHotelProfileStatusRepository,
    });
  }
  if (options.marketplaceHotelSelfServiceRepository && options.identityLifecycleCommandBus) {
    app.register(registerMarketplaceHotelSelfServiceRoutes, {
      prefix: "/api/marketplace",
      repository: options.marketplaceHotelSelfServiceRepository,
      lifecycleCommandBus: options.identityLifecycleCommandBus,
    });
  }
  if (options.marketplaceCreatorSelfServiceRepository && options.identityLifecycleCommandBus) {
    app.register(registerMarketplaceCreatorSelfServiceRoutes, {
      prefix: "/api/marketplace",
      repository: options.marketplaceCreatorSelfServiceRepository,
      lifecycleCommandBus: options.identityLifecycleCommandBus,
      mediaRepository: options.marketplaceCreatorProfileMediaRepository,
    });
  }
  if (
    options.marketplaceCreatorPlatformConnections &&
    options.marketplaceCreatorSelfServiceRepository &&
    options.identityLifecycleCommandBus
  ) {
    app.register(registerMarketplaceCreatorPlatformConnectionRoutes, {
      prefix: "/api/marketplace",
      ...options.marketplaceCreatorPlatformConnections,
      profileRepository: options.marketplaceCreatorSelfServiceRepository,
      lifecycleCommandBus: options.identityLifecycleCommandBus,
    });
  }
  if (options.sharedHotelSetupStatusRepository) {
    if (!options.hotelSetupTrackCommandRepository) {
      throw new Error(
        "hotelSetupTrackCommandRepository is required with sharedHotelSetupStatusRepository",
      );
    }
    app.register(registerSharedHotelSetupStatusRoutes, {
      prefix: "/api/hotel-setup",
      repository: options.sharedHotelSetupStatusRepository,
      trackCommandRepository: options.hotelSetupTrackCommandRepository,
      launchSettingsRepository: options.propertyLaunchSettingsRepository,
    });
  }
  if (options.propertySetupRouteStateReadPort) {
    if (!options.hotelSetupTrackCommandRepository) {
      throw new Error(
        "hotelSetupTrackCommandRepository is required with propertySetupRouteStateReadPort",
      );
    }
    app.register(registerPropertySetupRouteRoutes, {
      prefix: "/api/hotel-setup",
      routeStateReadPort: options.propertySetupRouteStateReadPort,
      trackCommandRepository: options.hotelSetupTrackCommandRepository,
    });
  }
  if (options.propertyMediaCommandRepository) {
    app.register(registerPropertyMediaRoutes, {
      prefix: "/api/hotel-setup",
      repository: options.propertyMediaCommandRepository,
    });
  }
  if (options.hotelCatalogStep1) {
    app.register(registerHotelCatalogStep1Routes, {
      prefix: "/api/hotel-setup",
      ...options.hotelCatalogStep1,
    });
  }
  if (options.marketplaceHotelCollaborationPreferences) {
    app.register(registerMarketplaceHotelCollaborationPreferencesRoutes, {
      prefix: "/api/marketplace",
      ...options.marketplaceHotelCollaborationPreferences,
    });
  }
  if (options.bookingDesign) {
    app.register(registerBookingDesignRoutes, {
      prefix: "/api/booking",
      ...options.bookingDesign,
    });
  }
  if (options.bookingDesignReadiness) {
    app.register(registerBookingDesignReadinessRoutes, {
      prefix: "/api/booking",
      ...options.bookingDesignReadiness,
    });
  }
  if (options.propertySetupDraftCommandRepository) {
    app.register(registerPropertySetupDraftRoutes, {
      prefix: "/api/hotel-setup",
      repository: options.propertySetupDraftCommandRepository,
    });
  }
  if (options.bookingPublication) {
    app.register(registerBookingPublicationRoutes, {
      prefix: "/api/hotel-setup",
      ...options.bookingPublication,
    });
  }
  if (options.identityPrivacyRepository) {
    app.register(registerIdentityPrivacyRoutes, {
      prefix: "/api/identity",
      repository: options.identityPrivacyRepository,
      allowedOrigins: options.identityPrivacyAllowedOrigins,
    });
  }
  if (options.identityLifecycleCommandBus) {
    app.register(registerIdentityAdminUserRoutes, {
      prefix: "/api/identity/admin",
      lifecycleCommandBus: options.identityLifecycleCommandBus,
      readRepository: options.identityAdminUsersReadRepository,
      ...options.identityAdminUsers,
    });
  }
  app.register(registerBookingRoutes, {
    prefix: "/api/booking",
    addonItemsRepository: options.bookingAddonItemsRepository,
    promoCodesRepository: options.bookingPromoCodesRepository,
    dashboardMetricsReadPort: options.bookingDashboardMetricsReadPort,
    reservationsRepository: options.bookingReservationsRepository,
    settingsRepository: options.bookingSettingsRepository,
    settingsWriteRepository: options.bookingSettingsWriteRepository,
    publicBookabilityPublisher: options.publicBookabilityPublisher,
    inventoryPublicOfferProjector: options.pmsInventoryPublicOfferProjector,
    customDomainRepository: options.bookingCustomDomainRepository,
    changeRequestRepository: options.bookingChangeRequestRepository,
  });
  app.register(registerAffiliateDashboardRoutes, {
    prefix: "/api",
    repository: options.affiliateDashboardRepository,
    financeRepository: options.financeRepository,
  });
  if (options.pmsOperationsRepository) {
    app.register(registerPmsOperationsRoutes, {
      prefix: "/api/pms",
      repository: options.pmsOperationsRepository,
      checkoutChargeMarkPaidFreezeEnabled: options.pmsCheckoutChargeMarkPaidFreezeEnabled,
      commandRepository: options.pmsOperationsCommandRepository,
      inventoryPublicOfferProjector: options.pmsInventoryPublicOfferProjector,
      bookingGuestPiiPort: options.bookingGuestPiiPort,
      allowedOrigins: options.pmsOperationsAllowedOrigins,
      propertyPlanReadRepository: options.propertyPlanReadRepository,
    });
  }
  if (options.pmsModuleActivationRepository) {
    app.register(registerPmsModuleActivationRoutes, {
      prefix: "/api/pms",
      repository: options.pmsModuleActivationRepository,
      allowedOrigins: options.pmsOperationsAllowedOrigins,
    });
  }
  if (options.pmsReviewRepository) {
    app.register(registerPmsReviewRoutes, {
      prefix: "/api/pms",
      repository: options.pmsReviewRepository,
    });
  }
  if (options.financeRepository) {
    const financePublicHotelProfileRepository =
      options.financePublicHotelProfileRepository ?? options.publicHotelProfileRepository;
    app.register(registerFinanceRoutes, {
      prefix: "/api",
      repository: options.financeRepository,
      xenditBankValidator: options.financeXenditBankValidator,
      publicHotelPropertyResolver: options.financePublicHotelPropertyResolver,
      publicHotelProfileRepository: financePublicHotelProfileRepository,
      closePublicHotelProfileRepository:
        Boolean(options.financePublicHotelProfileRepository) &&
        options.financePublicHotelProfileRepository !== options.publicHotelProfileRepository,
    });
  } else if (options.pmsFinanceCompatibilityRepository) {
    app.register(registerPmsFinanceCompatibilityRoutes, {
      prefix: "/api",
      repository: options.pmsFinanceCompatibilityRepository,
    });
  }
  if (options.financeSubscriptionService) {
    app.register(registerFinanceSubscriptionRoutes, {
      prefix: "/api",
      service: options.financeSubscriptionService,
    });
  }
  if (options.platformContactIntake) {
    app.register(registerPlatformContactIntakeRoutes, {
      prefix: "/api",
      ...options.platformContactIntake,
    });
  }
  app.register(registerPlatformAdminDashboardRoutes, {
    prefix: "/api/platform/admin",
    repository: options.platformAdminDashboardRepository,
  });
  if (options.platformMedia) {
    app.register(registerPlatformMediaRoutes, {
      prefix: "/api/media",
      ...options.platformMedia,
    });
  }

  return app;
}

function registerBrowserCors(app: FastifyInstance, allowedOrigins: string[]): void {
  const allowedOriginSet = new Set(allowedOrigins);
  if (allowedOriginSet.size === 0) return;

  app.addHook("onRequest", async (request, reply) => {
    const origin = request.headers.origin;
    if (!origin || !allowedOriginSet.has(origin)) return;

    reply
      .header("Vary", "Origin")
      .header("Access-Control-Allow-Origin", origin)
      .header("Access-Control-Allow-Credentials", "true")
      .header(
        "Access-Control-Allow-Headers",
        request.headers["access-control-request-headers"] ??
          "authorization,content-type,x-hotel-id,x-vayada-csrf",
      )
      .header("Access-Control-Allow-Methods", "GET,POST,PUT,PATCH,DELETE,OPTIONS")
      .header("Access-Control-Max-Age", "600");

    if (request.method === "OPTIONS") {
      return reply.code(204).send();
    }
  });
}
