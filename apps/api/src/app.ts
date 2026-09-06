import { registerBookingHostActionRoutes } from "./routes/bookingHostActions.js";
import type { BookingHostActions } from "./domains/bookingHostActions.js";
import { registerPmsConfirmationEmailRoutes } from "./routes/pmsConfirmationEmails.js";
import type { PmsConfirmationEmails } from "./domains/pmsConfirmationEmails.js";
import {
  registerPlatformMarketplaceActivationRoutes,
  type PlatformMarketplaceActivationOptions,
} from "./routes/platform/admin/marketplaceActivation.js";
import { backendAuthPlugin, type BackendAuthPluginOptions } from "@vayada/backend-auth";
import type { IdentityLifecycleCommandBus } from "@vayada/backend-auth";
import type { BookingGuestPiiPort } from "@vayada/domain-booking";
import type { FinanceSubscriptionService } from "@vayada/domain-finance";
import type { PmsCalendarAutoOpenSettingsPort } from "@vayada/domain-pms";
import type {
  PmsInventoryPublicOfferProjectionPort,
  PublicBookabilityPublicationCommandPort,
} from "@vayada/domain-distribution";
import {
  createAuthorizationResolver,
  type EntitlementRepository,
  type PropertyAccessRepository,
  type RolePermissionRepository,
} from "@vayada/backend-authorization";
import Fastify, { type FastifyInstance, type FastifyServerOptions } from "fastify";

import { isPostgresUnavailableError } from "./platform/postgresRuntime.js";
import type { HotelSetupTrackCommandRepository } from "./domains/hotelSetupTrackCommandRepository.js";
import type { HotelCatalogStep1Repository } from "./domains/hotelCatalogStep1Repository.js";
import type { PropertyMediaCommandRepository } from "./domains/propertyMediaCommandRepository.js";
import type { PropertySetupDraftCommandRepository } from "./domains/propertySetupDraftCommandRepository.js";
import type { PropertyPlanReadRepository } from "./domains/propertyPlanReadModel.js";
import type { BookingAcceptanceSettingsPort } from "./domains/bookingAcceptanceSettings.js";
import type { SameDayBookingSettingsPort } from "./domains/sameDayBookingSettings.js";
import type { PmsRoomAssignmentSettingsPort } from "./domains/pmsRoomAssignmentSettings.js";
import type { PmsRoomAssignmentOptimizationHistoryPort } from "./domains/pmsRoomAssignmentOptimizationHistory.js";
import type { PublicHotelProfileRepository } from "./routes/aiHotels.js";
import type { PublicHotelQuoteRepository } from "./routes/aiHotelQuotes.js";
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
import type { BookingPublicationRefreshPort } from "./domains/bookingPublicationProductionRuntime.js";
import { registerAiHotelQuoteRoutes } from "./routes/aiHotelQuotes.js";
import { registerAiHotelRoutes } from "./routes/aiHotels.js";
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
import { registerMarketplaceAffiliateAdminRoutes } from "./routes/marketplaceAffiliateAdmin.js";
import type { MarketplaceAffiliateAdminRepository } from "@vayada/domain-marketplace";
import {
  registerFinanceAffiliateCommissionRoutes,
  type FinanceAffiliateCommissionRoutesOptions,
} from "./routes/financeAffiliateCommissions.js";
import {
  registerMarketplaceCreatorSelfServiceRoutes,
  type MarketplaceCreatorProfileMediaRepository,
  type MarketplaceCreatorSelfServiceRepository,
} from "./routes/marketplaceCreatorSelfService.js";
import {
  registerMarketplaceCreatorPlatformConnectionRoutes,
  type MarketplaceCreatorPlatformConnectionRoutesOptions,
} from "./routes/marketplaceCreatorPlatformConnections.js";
import { registerPropertyNearbyRoutes } from "./routes/propertyNearby.js";
import type { PropertyNearbyRepository } from "./domains/propertyNearbyRepository.js";
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
  registerStaffInvitationRoutes,
  type StaffInvitationRoutesOptions,
} from "./routes/staffInvitations.js";
import {
  registerBookingWebPublicRoutes,
  type BookingWebAttributionSink,
  type BookingWebCalendarRepository,
  type BookingWebCheckoutAdapter,
  type BookingWebPublicRoutesOptions,
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
import { registerFinanceExpenseRoutes } from "./routes/financeExpenses.js";
import { registerFinanceFolioRoutes } from "./routes/financeFolios.js";
import { registerFinanceBankTransferRoutes } from "./routes/financeBankTransfer.js";
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
  type PlatformAdminDashboardRoutesOptions,
} from "./routes/platform/admin/dashboard/bookingCompatible.js";
import {
  registerPlatformPropertyLifecycleRoutes,
  type PlatformPropertyLifecycleRoutesOptions,
} from "./routes/platform/admin/propertyLifecycle.js";
import { registerPlatformPropertyMediaRoutes } from "./routes/platform/admin/propertyMedia.js";
import { registerPmsOperationsRoutes } from "./routes/pmsOperations.js";
import type {
  PmsInboxAssistancePort,
  PmsInboxMarkReadPort,
  PmsInboxProviderActionPort,
  PmsInboxQuickReplyPort,
  PmsInboxReadPort,
  PmsInboxReplyPort,
  PmsInboxStartDirectEmailPort,
  PmsInboxStaffCommandPort,
  PmsInboxTriagePort,
} from "./domains/pmsInbox.js";
import {
  registerPmsInboxAttachmentMediaRoutes,
  type PmsInboxAttachmentMediaRoutesOptions,
} from "./routes/pmsInboxAttachmentMedia.js";
import { registerPmsCalendarAutoOpenRoutes } from "./routes/pmsCalendarAutoOpen.js";
import type { PmsLinkedInventoryGroupCommandRepository } from "./domains/pmsLinkedInventoryGroupRepository.js";
import {
  registerPmsManualBookingPreviewRoutes,
  type PmsManualBookingPreviewRoutesOptions,
} from "./routes/pmsManualBookingPreview.js";
import {
  registerPmsManualBookingCapabilityRoutes,
  registerPmsManualBookingCreateRoutes,
  type PmsManualBookingCreateRoutesOptions,
} from "./routes/pmsManualBookingCreate.js";
import {
  registerPmsPhysicalRoomUnitRoutes,
  registerPmsPhysicalRoomManagementRoutes,
  registerPmsPhysicalRoomOperationalLabelRoutes,
  type PmsPhysicalRoomUnitRoutesOptions,
  type PmsPhysicalRoomOperationalLabelRoutesOptions,
} from "./routes/pmsPhysicalRoomUnits.js";
import {
  registerPmsRoomFactsRoutes,
  type PmsRoomFactsRoutesOptions,
} from "./routes/pmsRoomFacts.js";
import {
  registerPmsRoomPublicationRoutes,
  type PmsRoomPublicationRoutesOptions,
} from "./routes/pmsRoomPublication.js";
import { registerPmsPricingRoutes, type PmsPricingRoutesOptions } from "./routes/pmsPricing.js";
import {
  registerPmsRecurringPricingRoutes,
  type PmsRecurringPricingRoutesOptions,
} from "./routes/pmsRecurringPricing.js";
import {
  registerPmsMandatoryChargeConfirmationRoutes,
  type PmsMandatoryChargeConfirmationRoutesOptions,
} from "./routes/pmsMandatoryChargeConfirmation.js";
import {
  registerPmsOperatingCalendarRoutes,
  type PmsOperatingCalendarRoutesOptions,
} from "./routes/pmsOperatingCalendar.js";
import {
  registerPmsModuleActivationRoutes,
  type PmsModuleActivationRepository,
} from "./routes/pmsModuleActivations.js";
import { registerPmsReviewRoutes, type PmsReviewRepository } from "./routes/pmsReviews.js";
import {
  registerPmsChannexManagementRoutes,
  type PmsChannexManagementRoutesOptions,
} from "./routes/pmsChannexManagement.js";
import { registerPropertySetupDraftRoutes } from "./routes/propertySetupDrafts.js";
import { registerBookingPublicationRoutes } from "./routes/bookingPublication.js";
import type { BookingPublicationRoutesOptions } from "./routes/bookingPublication.js";
import {
  registerBookingGuestPolicyRoutes,
  type BookingGuestPolicyRoutesOptions,
} from "./routes/bookingGuestPolicy.js";
import { registerFinanceOtaCommissionSettingsRoutes as registerOtaSettings } from "./routes/financeOtaCommissionSettings.js";

export type ApiAuthOptions = Omit<BackendAuthPluginOptions, "authorizationResolver"> & {
  rolePermissionRepository: RolePermissionRepository;
  entitlementRepository?: EntitlementRepository;
  propertyAccessRepository: PropertyAccessRepository;
};

type BuildAppOptions = Pick<FastifyServerOptions, "logger" | "trustProxy"> & {
  auth?: ApiAuthOptions;
  authSession?: AuthSessionRouteOptions;
  browserAllowedOrigins?: string[];
  workosWebhooks?: WorkosWebhookRoutesOptions;
  providerWebhooks?: ProviderWebhookRoutesOptions;
  bookingReservationsRepository?: BookingReservationsReadRepository;
  bookingGuestPolicy?: BookingGuestPolicyRoutesOptions;
  bookingChangeRequestRepository?: BookingHotelChangeRequestRepository;
  pmsConfirmationEmails?: PmsConfirmationEmails;
  bookingHostActions?: BookingHostActions;
  pmsOperationsRepository?: PmsOperationsReadRepository;
  pmsInboxAssistancePort?: PmsInboxAssistancePort;
  pmsInboxReadPort?: PmsInboxReadPort;
  pmsInboxMarkReadPort?: PmsInboxMarkReadPort;
  pmsInboxProviderActionPort?: PmsInboxProviderActionPort;
  pmsInboxQuickReplyPort?: PmsInboxQuickReplyPort;
  pmsInboxReplyPort?: PmsInboxReplyPort;
  pmsInboxSendingEnabled?: boolean;
  pmsInboxStartDirectEmailPort?: PmsInboxStartDirectEmailPort;
  pmsInboxTriagePort?: PmsInboxTriagePort;
  pmsInboxStaffCommandPort?: PmsInboxStaffCommandPort;
  pmsInboxAttachmentMedia?: Omit<PmsInboxAttachmentMediaRoutesOptions, "propertyAccessRepository">;
  pmsManualBookingPreview?: PmsManualBookingPreviewRoutesOptions;
  pmsManualBookingCreate?: PmsManualBookingCreateRoutesOptions;
  pmsModuleActivationRepository?: PmsModuleActivationRepository;
  pmsReviewRepository?: PmsReviewRepository;
  pmsChannexManagement?: PmsChannexManagementRoutesOptions;
  pmsCheckoutChargeMarkPaidFreezeEnabled?: boolean;
  pmsOperationsCommandRepository?: PmsOperationsCommandRepository;
  pmsLinkedInventoryGroupCommandRepository?: PmsLinkedInventoryGroupCommandRepository;
  pmsInventoryPublicOfferProjector?: PmsInventoryPublicOfferProjectionPort;
  bookingGuestPiiPort?: BookingGuestPiiPort;
  pmsOperationsAllowedOrigins?: string[];
  propertyPlanReadRepository?: PropertyPlanReadRepository;
  bookingAcceptanceSettings?: BookingAcceptanceSettingsPort;
  sameDayBookingSettings?: SameDayBookingSettingsPort;
  pmsRoomAssignmentSettings?: PmsRoomAssignmentSettingsPort;
  pmsRoomAssignmentHistory?: PmsRoomAssignmentOptimizationHistoryPort;
  pmsCalendarAutoOpenSettings?: PmsCalendarAutoOpenSettingsPort;
  pmsRoomPublication?: PmsRoomPublicationRoutesOptions;
  pmsPricing?: PmsPricingRoutesOptions;
  pmsRecurringPricing?: PmsRecurringPricingRoutesOptions;
  pmsMandatoryChargeConfirmation?: PmsMandatoryChargeConfirmationRoutesOptions;
  pmsOperatingCalendar?: PmsOperatingCalendarRoutesOptions;
  pmsRoomSetup?: {
    facts: PmsRoomFactsRoutesOptions;
    physicalUnits: PmsPhysicalRoomUnitRoutesOptions;
  };
  pmsPhysicalRoomManagement?: {
    commandPort: import("@vayada/domain-pms").PhysicalRoomManagementPort;
  };
  pmsPhysicalRoomOperationalLabels?: PmsPhysicalRoomOperationalLabelRoutesOptions;
  bookingDashboardMetricsReadPort?: BookingRoutesOptions["dashboardMetricsReadPort"];
  bookingPropertyAccessRepository?: BookingRoutesOptions["propertyAccessRepository"];
  bookingAddonItemsRepository?: BookingAddonItemsRepository;
  bookingPromoCodesRepository?: BookingPromoCodesRepository;
  bookingSettingsRepository?: BookingSettingsReadRepository;
  bookingSettingsWriteRepository?: BookingSettingsWriteRepository;
  publicBookabilityPublisher?: PublicBookabilityPublicationCommandPort;
  bookingPublicationRefresh?: BookingPublicationRefreshPort;
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
  marketplaceAffiliateAdminRepository?: MarketplaceAffiliateAdminRepository;
  financeAffiliateCommissions?: FinanceAffiliateCommissionRoutesOptions;
  marketplaceCreatorSelfServiceRepository?: MarketplaceCreatorSelfServiceRepository;
  marketplaceCreatorPlatformConnections?: Omit<
    MarketplaceCreatorPlatformConnectionRoutesOptions,
    "profileRepository" | "lifecycleCommandBus"
  >;
  marketplaceCreatorProfileMediaRepository?: MarketplaceCreatorProfileMediaRepository;
  sharedHotelSetupStatusRepository?: SharedHotelSetupStatusRepository;
  propertyNearbyRepository?: PropertyNearbyRepository;
  propertyNearbyDiscovery?: Parameters<typeof registerPropertyNearbyRoutes>[1]["discovery"];
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
  bookingPublication?: BookingPublicationRoutesOptions;
  identityPrivacyRepository?: IdentityPrivacyRepository;
  identityLifecycleCommandBus?: IdentityLifecycleCommandBus;
  identityAdminUsersReadRepository?: IdentityAdminUsersReadRepository;
  identityAdminUsers?: Omit<
    IdentityAdminUserRoutesOptions,
    "lifecycleCommandBus" | "readRepository"
  >;
  staffInvitations?: StaffInvitationRoutesOptions;
  platformContactIntake?: PlatformContactIntakeRoutesOptions;
  platformAdminDashboardRepository?: PlatformAdminDashboardRepository;
  platformAdminSmokeRecovery?: PlatformAdminDashboardRoutesOptions["smokeRecovery"];
  platformMarketplaceActivation?: PlatformMarketplaceActivationOptions;
  platformPropertyLifecycle?: PlatformPropertyLifecycleRoutesOptions;
  marketplaceDiscoveryAllowedOrigins?: string[];
  identityPrivacyAllowedOrigins?: string[];
  bookingWebCalendarRepository?: BookingWebCalendarRepository;
  bookingWebCheckoutAdapter?: BookingWebCheckoutAdapter;
  bookingWebAffiliateHotelResolver?: BookingWebAffiliateHotelResolver;
  bookingWebAffiliateRepository?: BookingWebAffiliateRepository;
  bookingWebAttributionSink?: BookingWebAttributionSink;
  bookingWebPublicNow?: BookingWebPublicRoutesOptions["now"];
  affiliateDashboardRepository?: Partial<AffiliateDashboardReadRepository>;
  financeRepository?: FinanceRoutesOptions["repository"];
  financeSubscriptionService?: FinanceSubscriptionService;
  financeOtaCommissionSettingsRepository?: Parameters<typeof registerOtaSettings>[1]["repository"];
  financeExpenses?: Parameters<typeof registerFinanceExpenseRoutes>[1];
  financeFolios?: Parameters<typeof registerFinanceFolioRoutes>[1];
  financeBankTransfer?: Parameters<typeof registerFinanceBankTransferRoutes>[1];
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
    trustProxy: options.trustProxy ?? false,
    disableRequestLogging: (request) =>
      request.url.startsWith("/api/marketplace/creator-platform-oauth/") ||
      (request.url.startsWith("/api/pms/properties/") &&
        request.url.split("?", 1)[0]?.endsWith("/messaging/threads") === true),
  });

  app.setErrorHandler((error, request, reply) => {
    if (!isPostgresUnavailableError(error)) return reply.send(error);
    request.log.warn({ err: error }, "PostgreSQL connection unavailable");
    return reply.status(503).send({
      statusCode: 503,
      error: "Service Unavailable",
      message: "Database is temporarily unavailable",
      code: "database_unavailable",
    });
  });

  registerBrowserCors(app, options.browserAllowedOrigins ?? []);

  if (options.auth) {
    const {
      rolePermissionRepository,
      entitlementRepository,
      propertyAccessRepository,
      ...authOptions
    } = options.auth;
    app.register(backendAuthPlugin, {
      ...authOptions,
      authorizationResolver: createAuthorizationResolver(
        rolePermissionRepository,
        entitlementRepository,
        propertyAccessRepository,
      ),
    });
  }

  app.register(registerHealthRoutes);
  if (options.authSession) {
    app.register(registerAuthSessionRoutes, {
      prefix: "/auth",
      ...options.authSession,
      propertyAccessRepository:
        options.authSession.propertyAccessRepository ?? options.auth?.propertyAccessRepository,
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
    const bookingWebCheckoutAdapter = options.bookingWebCheckoutAdapter;
    if (!bookingWebCheckoutAdapter) {
      throw new Error("Booking Web checkout adapter is required when public routes are mounted");
    }
    app.register(registerBookingWebPublicRoutes, {
      prefix: "/api/booking-web",
      profileRepository: options.publicHotelProfileRepository,
      quoteRepository: options.publicHotelQuoteRepository,
      calendarRepository: options.bookingWebCalendarRepository,
      checkoutAdapter: bookingWebCheckoutAdapter,
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
  if (options.marketplaceAffiliateAdminRepository) {
    app.register(registerMarketplaceAffiliateAdminRoutes, {
      prefix: "/api/marketplace",
      repository: options.marketplaceAffiliateAdminRepository,
    });
  }
  if (options.financeAffiliateCommissions) {
    app.register(registerFinanceAffiliateCommissionRoutes, {
      prefix: "/api/finance",
      ...options.financeAffiliateCommissions,
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
  if (options.propertyNearbyRepository) {
    if (!options.auth?.propertyAccessRepository) {
      throw new Error("Nearby routes require property access resolution");
    }
    app.register(registerPropertyNearbyRoutes, {
      prefix: "/api/hotel-setup",
      repository: options.propertyNearbyRepository,
      discovery: options.propertyNearbyDiscovery,
      propertyAccessRepository: options.auth.propertyAccessRepository,
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
      propertyAccessRepository: options.auth?.propertyAccessRepository,
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
    app.register(registerPlatformPropertyMediaRoutes, {
      prefix: "/api/platform/admin",
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
  if (options.staffInvitations) {
    app.register(registerStaffInvitationRoutes, {
      prefix: "/api/identity/staff",
      ...options.staffInvitations,
    });
  }
  app.register(registerBookingRoutes, {
    prefix: "/api/booking",
    addonItemsRepository: options.bookingAddonItemsRepository,
    promoCodesRepository: options.bookingPromoCodesRepository,
    dashboardMetricsReadPort: options.bookingDashboardMetricsReadPort,
    propertyAccessRepository: options.bookingPropertyAccessRepository,
    reservationsRepository: options.bookingReservationsRepository,
    settingsRepository: options.bookingSettingsRepository,
    settingsWriteRepository: options.bookingSettingsWriteRepository,
    bookingAcceptanceSettings: options.bookingAcceptanceSettings,
    sameDayBookingSettings: options.sameDayBookingSettings,
    ownsSameDayBookingSettings: !options.pmsOperationsRepository,
    publicBookabilityPublisher: options.publicBookabilityPublisher,
    bookingPublicationRefresh: options.bookingPublicationRefresh,
    inventoryPublicOfferProjector: options.pmsInventoryPublicOfferProjector,
    customDomainRepository: options.bookingCustomDomainRepository,
    changeRequestRepository: options.bookingChangeRequestRepository,
  });
  if (options.bookingGuestPolicy) {
    app.register(registerBookingGuestPolicyRoutes, {
      prefix: "/api/booking",
      ...options.bookingGuestPolicy,
    });
  }
  app.register(registerAffiliateDashboardRoutes, {
    prefix: "/api",
    repository: options.affiliateDashboardRepository,
    financeRepository: options.financeRepository,
  });
  if (options.bookingHostActions && options.auth) {
    app.register(registerBookingHostActionRoutes, {
      prefix: "/api/pms",
      actions: options.bookingHostActions,
      propertyAccessRepository: options.auth.propertyAccessRepository,
      allowedOrigins: options.pmsOperationsAllowedOrigins,
    });
  }
  if (options.pmsConfirmationEmails && options.auth) {
    app.register(registerPmsConfirmationEmailRoutes, {
      prefix: "/api/pms",
      emails: options.pmsConfirmationEmails,
      propertyAccessRepository: options.auth.propertyAccessRepository,
      allowedOrigins: options.pmsOperationsAllowedOrigins,
    });
  }
  if (options.pmsOperationsRepository) {
    app.register(registerPmsOperationsRoutes, {
      prefix: "/api/pms",
      repository: options.pmsOperationsRepository,
      propertyAccessRepository: options.auth?.propertyAccessRepository,
      checkoutChargeMarkPaidFreezeEnabled: options.pmsCheckoutChargeMarkPaidFreezeEnabled,
      commandRepository: options.pmsOperationsCommandRepository,
      linkedInventoryGroupCommandRepository: options.pmsLinkedInventoryGroupCommandRepository,
      resolveOnboardingRoomCurrency: async (propertyId) =>
        (await options.bookingSettingsRepository?.findPropertySettingsByHotelId?.(propertyId))
          ?.defaultCurrency ?? null,
      inventoryPublicOfferProjector: options.pmsInventoryPublicOfferProjector,
      bookingGuestPiiPort: options.bookingGuestPiiPort,
      allowedOrigins: options.pmsOperationsAllowedOrigins,
      propertyPlanReadRepository: options.propertyPlanReadRepository,
      bookingAcceptanceSettings: options.bookingAcceptanceSettings,
      sameDayBookingSettings: options.sameDayBookingSettings,
      roomAssignmentSettings: options.pmsRoomAssignmentSettings,
      roomAssignmentHistory: options.pmsRoomAssignmentHistory,
      inboxAssistancePort: options.pmsInboxAssistancePort,
      inboxReadPort: options.pmsInboxReadPort,
      inboxMarkReadPort: options.pmsInboxMarkReadPort,
      inboxProviderActionPort: options.pmsInboxProviderActionPort,
      inboxQuickReplyPort: options.pmsInboxQuickReplyPort,
      inboxReplyPort: options.pmsInboxReplyPort,
      inboxSendingEnabled: options.pmsInboxSendingEnabled,
      inboxStartDirectEmailPort: options.pmsInboxStartDirectEmailPort,
      inboxTriagePort: options.pmsInboxTriagePort,
      inboxStaffCommandPort: options.pmsInboxStaffCommandPort,
      publicBookabilityPublisher: options.publicBookabilityPublisher,
    });
  }
  if (options.pmsCalendarAutoOpenSettings && options.auth) {
    app.register(registerPmsCalendarAutoOpenRoutes, {
      prefix: "/api/pms",
      settings: options.pmsCalendarAutoOpenSettings,
      propertyAccessRepository: options.auth.propertyAccessRepository,
      allowedOrigins: options.pmsOperationsAllowedOrigins,
    });
  }
  if (options.pmsRoomPublication) {
    app.register(registerPmsRoomPublicationRoutes, {
      prefix: "/api/pms",
      ...options.pmsRoomPublication,
    });
  }
  if (options.pmsPricing) {
    app.register(registerPmsPricingRoutes, {
      prefix: "/api/pms",
      ...options.pmsPricing,
      inventoryPublicOfferProjector: options.pmsInventoryPublicOfferProjector,
    });
  }
  if (options.pmsRecurringPricing) {
    app.register(registerPmsRecurringPricingRoutes, {
      prefix: "/api/pms",
      ...options.pmsRecurringPricing,
    });
  }
  if (options.pmsMandatoryChargeConfirmation) {
    app.register(registerPmsMandatoryChargeConfirmationRoutes, {
      prefix: "/api/pms",
      ...options.pmsMandatoryChargeConfirmation,
    });
  }
  if (options.pmsOperatingCalendar) {
    app.register(registerPmsOperatingCalendarRoutes, {
      prefix: "/api/pms",
      ...options.pmsOperatingCalendar,
    });
  }
  if (options.pmsRoomSetup) {
    app.register(registerPmsRoomFactsRoutes, {
      prefix: "/api/pms/setup",
      ...options.pmsRoomSetup.facts,
    });
    app.register(registerPmsPhysicalRoomUnitRoutes, {
      prefix: "/api/pms/setup",
      ...options.pmsRoomSetup.physicalUnits,
    });
  }
  if (options.pmsPhysicalRoomManagement) {
    app.register(registerPmsPhysicalRoomManagementRoutes, {
      prefix: "/api/pms",
      ...options.pmsPhysicalRoomManagement,
    });
  }
  if (options.pmsPhysicalRoomOperationalLabels) {
    app.register(registerPmsPhysicalRoomOperationalLabelRoutes, {
      prefix: "/api/pms",
      ...options.pmsPhysicalRoomOperationalLabels,
    });
  }
  app.register(registerPmsManualBookingCapabilityRoutes, { prefix: "/api/pms" });
  if (options.pmsManualBookingPreview) {
    app.register(registerPmsManualBookingPreviewRoutes, {
      prefix: "/api/pms",
      ...options.pmsManualBookingPreview,
    });
  }
  if (options.pmsManualBookingCreate) {
    app.register(registerPmsManualBookingCreateRoutes, {
      prefix: "/api/pms",
      ...options.pmsManualBookingCreate,
    });
  }
  if (options.pmsModuleActivationRepository) {
    app.register(registerPmsModuleActivationRoutes, {
      prefix: "/api/pms",
      repository: options.pmsModuleActivationRepository,
      bookingPublicationRefresh: options.bookingPublicationRefresh,
      allowedOrigins: options.pmsOperationsAllowedOrigins,
    });
  }
  if (options.pmsReviewRepository) {
    app.register(registerPmsReviewRoutes, {
      prefix: "/api/pms",
      repository: options.pmsReviewRepository,
    });
  }
  if (options.pmsChannexManagement) {
    app.register(registerPmsChannexManagementRoutes, {
      prefix: "/api/pms",
      ...options.pmsChannexManagement,
    });
  }
  if (options.financeRepository) {
    const financePublicHotelProfileRepository =
      options.financePublicHotelProfileRepository ?? options.publicHotelProfileRepository;
    app.register(registerFinanceRoutes, {
      prefix: "/api",
      repository: options.financeRepository,
      propertyAccessRepository: options.auth?.propertyAccessRepository,
      publicBookabilityPublisher: options.publicBookabilityPublisher,
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
      propertyAccessRepository: options.auth?.propertyAccessRepository,
    });
  }
  if (options.financeSubscriptionService) {
    app.register(registerFinanceSubscriptionRoutes, {
      prefix: "/api",
      service: options.financeSubscriptionService,
      propertyAccessRepository: options.auth?.propertyAccessRepository,
    });
  }
  if (options.financeOtaCommissionSettingsRepository) {
    app.register(registerOtaSettings, {
      prefix: "/api",
      repository: options.financeOtaCommissionSettingsRepository,
      propertyAccessRepository: options.auth?.propertyAccessRepository,
    });
  }
  if (options.financeExpenses) {
    app.register(registerFinanceExpenseRoutes, {
      prefix: "/api",
      ...options.financeExpenses,
      propertyAccessRepository:
        options.auth?.propertyAccessRepository ?? options.financeExpenses.propertyAccessRepository,
    });
  }
  if (options.financeFolios) {
    app.register(registerFinanceFolioRoutes, {
      prefix: "/api",
      ...options.financeFolios,
      propertyAccessRepository:
        options.auth?.propertyAccessRepository ?? options.financeFolios.propertyAccessRepository,
    });
  }
  if (options.financeBankTransfer) {
    app.register(registerFinanceBankTransferRoutes, {
      prefix: "/api",
      publicBookabilityPublisher: options.publicBookabilityPublisher,
      ...options.financeBankTransfer,
      propertyAccessRepository: options.auth?.propertyAccessRepository,
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
    smokeRecovery: options.platformAdminSmokeRecovery,
  });
  if (options.platformMarketplaceActivation) {
    app.register(registerPlatformMarketplaceActivationRoutes, {
      prefix: "/api/platform/admin",
      ...options.platformMarketplaceActivation,
    });
  }
  if (options.platformPropertyLifecycle) {
    app.register(registerPlatformPropertyLifecycleRoutes, {
      prefix: "/api/platform/admin",
      ...options.platformPropertyLifecycle,
    });
  }
  if (options.platformMedia) {
    app.register(registerPlatformMediaRoutes, {
      prefix: "/api/media",
      ...options.platformMedia,
    });
  }
  if (options.pmsInboxAttachmentMedia && options.auth?.propertyAccessRepository) {
    app.register(registerPmsInboxAttachmentMediaRoutes, {
      prefix: "/api/media",
      ...options.pmsInboxAttachmentMedia,
      propertyAccessRepository: options.auth.propertyAccessRepository,
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
