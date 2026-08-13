import { createPgIdentityRepository, createWorkOSVerifier } from "@vayada/backend-auth";
import {
  createPgEntitlementRepository,
  createPgRolePermissionRepository,
} from "@vayada/backend-authorization";
import { createBookingDesignReadinessProvider } from "@vayada/domain-booking";
import { createHotelMediaResolutionPort } from "@vayada/domain-hotels";
import pg from "pg";

import { buildApp, type ApiAuthOptions } from "./app.js";
import { type ApiConfig, loadConfig, stripeSubscriptionRuntimeEnabled } from "./config.js";
import { createPgBookingDesignCatalogEvidenceRepository } from "./domains/bookingDesignCatalogEvidenceRepository.js";
import { createPgBookingDesignRepository } from "./domains/bookingDesignRepository.js";
import { createBookingGuestPolicyCatalogCurrentOwnerEvidenceAdapter } from "./domains/bookingGuestPolicyCatalogCurrentOwnerEvidence.js";
import { createBookingGuestPolicyCurrentOwnerEvidenceAdapter } from "./domains/bookingGuestPolicyCurrentOwnerEvidence.js";
import { createPgBookingGuestPolicyRepository } from "./domains/bookingGuestPolicyRepository.js";
import { createPgBookingGuestPolicyScopeAuthorizationPort } from "./domains/bookingGuestPolicyScopeAuthorization.js";
import { createPgHotelCatalogCurrentOwnerEvidencePorts } from "./domains/hotelCatalogCurrentOwnerEvidence.js";
import { createPgHotelCatalogStep1Repository } from "./domains/hotelCatalogStep1Repository.js";
import { createPgMarketplaceHotelCollaborationPreferencesRepository } from "./domains/marketplaceHotelCollaborationPreferencesRepository.js";
import { createPgHotelMediaResolutionPort } from "./platform/hotelMediaResolver.js";
import { createPgBookingWebEventSink } from "./platform/bookingWebEvents.js";
import { createTargetBookingDashboardMetricsReadPort } from "./platform/bookingDashboard.js";
import { createTargetBookingGuestPiiPort } from "./platform/bookingGuestPii.js";
import { createPgIdentityLifecycleCommandBus } from "./platform/identityLifecycle.js";
import { createPgMarketplaceOfferIdentityAccessCommandPort } from "./platform/marketplaceOfferIdentityAccess.js";
import { createTargetPublicBookabilityPublicationCommandPort } from "./platform/publicBookabilityPublication.js";
import { createPgProductAuditSink } from "./platform/productAudit.js";
import { createPgAuthSessionHandoffRepository } from "./platform/authSessionHandoffs.js";
import { createTargetBookingReservationsReadRepository } from "./platform/bookingReservations.js";
import { createPgProviderWebhookStore } from "./platform/providerWebhooks.js";
import { composePlatformMediaRuntime } from "./platform/platformMediaRuntime.js";
import { createWorkOSAuthKitClient } from "./platform/workosAuthKit.js";
import {
  createPgWorkosWebhookStore,
  createWorkosWebhookVerifier,
} from "./platform/workosWebhooks.js";
import { createPublicRuntimeRepositories } from "./publicRuntime.js";
import { createTargetPmsOperationsCommandRepository } from "./domains/pmsOperationsCommandRepository.js";
import { createTargetBookingAcceptanceSettingsPort } from "./domains/bookingAcceptanceSettings.js";
import { createTargetPmsInventoryPublicOfferProjection } from "./domains/pmsInventoryPublicOfferProjection.js";
import { createTargetPmsInventoryReservationPort } from "./domains/pmsInventoryReservation.js";
import { createTargetPmsRoomInventoryReadPort } from "./domains/pmsRoomInventoryReadModel.js";
import { createTargetPmsOperationsReadRepository } from "./domains/pmsOperationsReadModel.js";
import { createPgHotelSetupTrackCommandRepository } from "./domains/hotelSetupTrackCommandRepository.js";
import { createPgPropertySetupDraftCommandRepository } from "./domains/propertySetupDraftCommandRepository.js";
import { createPgPropertySetupDraftRepository } from "./domains/propertySetupDraftRepository.js";
import { createPgPropertyPlanReadRepository } from "./domains/propertyPlanReadModel.js";
import { createPgPmsRoomFactsReadModel } from "./domains/pmsRoomFactsReadModel.js";
import { createPmsRoomAmenityVocabularyValidationPort } from "./domains/pmsRoomAmenityVocabulary.js";
import { createPgPmsRoomPublicationCommandRepository } from "./domains/pmsRoomPublicationCommandRepository.js";
import { createPgPmsRoomPublicationReadModel } from "./domains/pmsRoomPublicationReadModel.js";
import { createPgPropertySetupFinanceOwnerScopePort } from "./domains/propertySetupFinanceOwnerScope.js";
import { createPgPropertySetupPmsOwnerRepository } from "./domains/propertySetupPmsOwnerRepository.js";
import { createPgPmsPricingReadModel } from "./domains/pmsPricingReadModel.js";
import { createPgPmsRecurringPricingReadModel } from "./domains/pmsRecurringPricingReadModel.js";
import { createPgPmsMandatoryChargeConfirmationReadModel } from "./domains/pmsMandatoryChargeConfirmationReadModel.js";
import { createPgHotelCatalogOperatingCalendarPropertyProfileEvidencePort } from "./domains/hotelCatalogOperatingCalendarPropertyProfileEvidence.js";
import { createPgPmsOperatingCalendarReadModel } from "./domains/pmsOperatingCalendarReadModel.js";
import { createPgFinancePaymentReadinessReadModel } from "./domains/financePaymentReadinessReadModel.js";
import { createTargetFinanceBillingConfigReadPort } from "./domains/financeBillingConfigReadModel.js";
import { createFinanceSubscriptionService } from "./domains/financeSubscriptionService.js";
import { createPgFinanceSubscriptionStore } from "./domains/financeSubscriptionStore.js";
import { createStripeFinanceSubscriptionProvider } from "./domains/stripeFinanceSubscriptions.js";
import { createStripeBookingPaymentProvider } from "./domains/stripeBookingPayments.js";
import { createStripeConnectProvider } from "./domains/stripeConnect.js";
import { createPgMarketplaceSetupLifecycleStatusRepository } from "./domains/marketplaceSetupLifecycleStatusRepository.js";
import { createPgBookingSetupLifecycleStatusRepository } from "./domains/bookingSetupLifecycleStatusRepository.js";
import {
  createPropertySetupHotelCatalogStateProvider,
  createPropertySetupMarketplaceStateProvider,
} from "./platform/propertySetupCatalogMarketplaceState.js";
import { createPropertySetupBookingStateProvider } from "./platform/propertySetupBookingState.js";
import {
  createPropertySetupBookingGuestPolicyPmsCurrentOwnerEvidenceAdapter,
  createPropertySetupPmsStateProvider,
} from "./platform/propertySetupPmsState.js";
import { createPropertySetupFinanceStateProvider } from "./platform/propertySetupFinanceState.js";
import { createPropertySetupReviewLifecycleStateProvider } from "./platform/propertySetupReviewLifecycleState.js";
import { createPropertySetupRouteStateReadPort } from "./platform/propertySetupRouteState.js";
import { runPlatformMediaCleanupJobs } from "./jobs/platformMediaCleanup.js";
import {
  createPgBookingLifecycleStore,
  runBookingLifecycleSchedulerJobs,
} from "./jobs/bookingLifecycle.js";
import {
  createResendBookingEmailDelivery,
  runBookingEmailDeliveryJobs,
} from "./jobs/bookingEmailDelivery.js";
import { runChannexReviewJobs } from "./jobs/channexReviews.js";
import {
  runFinanceSubscriptionNotificationJobs,
  runFinanceSubscriptionWebhookJobs,
} from "./jobs/financeSubscriptions.js";
import {
  createPgPropertySetupDraftRetentionStore,
  startPropertySetupDraftRetentionWorker,
} from "./jobs/propertySetupDraftRetention.js";
import { createTargetPublicHotelProfileRepository } from "./routes/aiHotels.js";
import {
  createPgBookingWebAffiliateHotelResolver,
  createPgBookingWebAffiliateRepository,
} from "./routes/bookingWebAffiliate.js";
import { createPgTargetBookingAddonItemsRepository } from "./routes/bookingAddonItems.js";
import { createPgTargetBookingPromoCodesRepository } from "./routes/bookingPromoCodes.js";
import { createCompatibilityPmsBookingReservationsReadRepository } from "./routes/bookingReservations.js";
import { createTargetBookingWebCheckoutAdapter } from "./routes/bookingWebPublic.js";
import {
  createPgBookingSettingsReadRepository,
  createPgTargetBookingSettingsRepository,
} from "./routes/bookingSettings.js";
import { createTargetBookingCustomDomainRepository } from "./routes/bookingCustomDomain.js";
import {
  createTargetFinancePropertySettingsRepository,
  createTargetFinancePublicHotelPropertyResolver,
  createXenditBankValidator,
} from "./routes/finance.js";
import { createPgPmsModuleActivationRepository } from "./routes/pmsModuleActivations.js";
import { createPgPmsReviewRepository } from "./routes/pmsReviews.js";
import { createPgMarketplaceCollaborationReadRepository } from "./routes/marketplaceCollaborations.js";
import { createPgMarketplaceTripRepository } from "./routes/marketplaceTrips.js";
import { createPgMarketplaceAdminRepository } from "./routes/marketplaceAdmin.js";
import { createPgHotelAccountInviteRepository } from "./routes/hotelAccountInvites.js";
import { createPgMarketplaceHotelProfileStatusRepository } from "./routes/marketplaceHotelProfileStatus.js";
import { createPgMarketplaceHotelSelfServiceRepository } from "./routes/marketplaceHotelSelfService.js";
import { createPgMarketplaceCreatorSelfServiceRepository } from "./routes/marketplaceCreatorSelfService.js";
import { createPgSharedHotelSetupStatusRepository } from "./platform/sharedHotelSetupStatusReadModel.js";
import { createPgIdentityAdminUsersReadRepository } from "./routes/identityAdminUsers.js";
import { createPgIdentityPrivacyRepository } from "./routes/identityPrivacy.js";
import { createPgMarketplaceCreatorPlatformConnectionRepository } from "./routes/marketplaceCreatorPlatformConnections.js";
import { createTargetPlatformAdminDashboardRepository } from "./routes/platform/admin/dashboard/bookingCompatible.js";
import { createPgPlatformContactIntakeRepository } from "./routes/platformContactIntake.js";
import {
  createCreatorPlatformAdapterRegistry,
  createFacebookCreatorPlatformAdapter,
  createInstagramCreatorPlatformAdapter,
  createTikTokCreatorPlatformAdapter,
  createYouTubeCreatorPlatformAdapter,
  type CreatorPlatformAdapter,
} from "./integrations/creatorPlatforms/index.js";
import {
  createMemoryProviderCredentialVault,
  createSecretsManagerProviderCredentialVault,
  createUnavailableProviderCredentialVault,
} from "./platform/providerCredentialVault.js";

const config = loadConfig();

function buildAuthOptions(auth: ApiConfig["auth"]): ApiAuthOptions | undefined {
  if (!auth) {
    return undefined;
  }

  return {
    verifier: createWorkOSVerifier({
      jwksUrl: auth.workosJwksUrl,
      issuer: auth.workosIssuer,
      audience: auth.workosAudience,
    }),
    repository: createPgIdentityRepository({
      connectionString: auth.databaseUrl,
    }),
    rolePermissionRepository: createPgRolePermissionRepository({
      connectionString: auth.databaseUrl,
    }),
    entitlementRepository: createPgEntitlementRepository({
      connectionString: auth.databaseUrl,
    }),
  };
}

const targetDatabaseUrl = config.targetDatabaseUrl;
if (!targetDatabaseUrl) {
  throw new Error("TARGET_DATABASE_URL is required because Marketplace is always enabled");
}

const {
  publicHotelProfileRepository,
  publicHotelQuoteRepository,
  bookingWebCalendarRepository,
  marketplaceDiscoveryRepository,
} = createPublicRuntimeRepositories(config);

const bookingSettingsRepository =
  config.bookingSettingsSource === "target"
    ? createPgTargetBookingSettingsRepository({
        connectionString: targetDatabaseUrl,
      })
    : config.bookingDatabaseUrl
      ? createPgBookingSettingsReadRepository({
          connectionString: config.bookingDatabaseUrl,
        })
      : undefined;
const findPropertyLaunchSettings = bookingSettingsRepository?.findPropertySettingsByHotelId;
const updatePropertyLaunchSettings = bookingSettingsRepository?.updatePropertySettingsByHotelId;
if (
  config.bookingSettingsSource === "target" &&
  (!findPropertyLaunchSettings || !updatePropertyLaunchSettings)
) {
  throw new Error("Target property launch settings repository is unavailable");
}
const propertyLaunchSettingsRepository =
  config.bookingSettingsSource === "target"
    ? {
        findPropertySettingsByHotelId: findPropertyLaunchSettings!,
        updatePropertySettingsByHotelId: updatePropertyLaunchSettings!,
      }
    : undefined;

const publicBookabilityPublisher =
  config.bookingSettingsSource === "target"
    ? createTargetPublicBookabilityPublicationCommandPort({
        connectionString: targetDatabaseUrl,
        bookingHostBase: config.bookingHostBase,
      })
    : undefined;

const pmsInventoryPublicOfferProjector =
  config.pmsOperationsSource === "target"
    ? createTargetPmsInventoryPublicOfferProjection({
        connectionString: targetDatabaseUrl,
        refreshPublicBookability: publicBookabilityPublisher
          ? async ({ propertyId }) => {
              const publication = await publicBookabilityPublisher.publish({ propertyId });
              if (!publication) {
                throw new Error(
                  "Public bookability profile was unavailable after PMS inventory projection",
                );
              }
            }
          : undefined,
      })
    : undefined;

// Route modules register their own close hooks for injected repositories. Give
// them non-owning views so the server remains the sole owner of these shared
// runtime resources and can drain the retry worker before closing either pool.
const routePublicBookabilityPublisher = publicBookabilityPublisher
  ? { publish: publicBookabilityPublisher.publish.bind(publicBookabilityPublisher) }
  : undefined;
const routePmsInventoryPublicOfferProjector = pmsInventoryPublicOfferProjector
  ? {
      projectPending: pmsInventoryPublicOfferProjector.projectPending.bind(
        pmsInventoryPublicOfferProjector,
      ),
    }
  : undefined;

const bookingCustomDomainRepository = createTargetBookingCustomDomainRepository({
  connectionString: targetDatabaseUrl,
});

const bookingAddonItemsRepository = createPgTargetBookingAddonItemsRepository({
  connectionString: targetDatabaseUrl,
});

const propertyPlanReadRepository = createPgPropertyPlanReadRepository({
  connectionString: targetDatabaseUrl,
});

const bookingPromoCodesRepository = createPgTargetBookingPromoCodesRepository({
  connectionString: targetDatabaseUrl,
});

const bookingReservationsRepository =
  config.bookingReservationsSource === "target"
    ? createTargetBookingReservationsReadRepository({
        connectionString: targetDatabaseUrl,
      })
    : config.bookingReservationsReadDatabaseUrl
      ? createCompatibilityPmsBookingReservationsReadRepository({
          connectionString: config.bookingReservationsReadDatabaseUrl,
        })
      : undefined;

const bookingDashboardMetricsReadPort =
  config.bookingReservationsSource === "target"
    ? createTargetBookingDashboardMetricsReadPort({
        connectionString: targetDatabaseUrl,
      })
    : undefined;

const stripeBookingPaymentProvider = config.stripeSubscriptions.secretKey
  ? createStripeBookingPaymentProvider({ secretKey: config.stripeSubscriptions.secretKey })
  : undefined;

const bookingWebCheckoutAdapter =
  config.bookingCheckoutCommandSource === "target"
    ? createTargetBookingWebCheckoutAdapter({
        connectionString: targetDatabaseUrl,
        inventoryReservationPort: createTargetPmsInventoryReservationPort(),
        billingConfigReadPortFactory: (executor) =>
          createTargetFinanceBillingConfigReadPort({
            connectionString: targetDatabaseUrl,
            pool: executor,
          }),
        stripePaymentProvider: stripeBookingPaymentProvider,
      })
    : undefined;

const pmsOperationsRepository =
  config.pmsOperationsSource === "target"
    ? createTargetPmsOperationsReadRepository({
        connectionString: targetDatabaseUrl,
      })
    : undefined;

const bookingGuestPiiPort =
  config.pmsOperationsSource === "target"
    ? createTargetBookingGuestPiiPort({
        connectionString: targetDatabaseUrl,
      })
    : undefined;

const pmsOperationsCommandRepository = pmsOperationsRepository
  ? createTargetPmsOperationsCommandRepository({
      connectionString: targetDatabaseUrl,
      readRepository: pmsOperationsRepository,
      stripePaymentProvider: stripeBookingPaymentProvider,
    })
  : undefined;

const bookingAcceptanceSettings = pmsOperationsRepository
  ? createTargetBookingAcceptanceSettingsPort({ connectionString: targetDatabaseUrl })
  : undefined;

const pmsModuleActivationRepository = config.auth
  ? createPgPmsModuleActivationRepository({
      connectionString: config.auth.databaseUrl,
    })
  : undefined;

const stripeConnectProvider = config.stripeSubscriptions.secretKey
  ? createStripeConnectProvider({
      secretKey: config.stripeSubscriptions.secretKey,
      returnBaseUrls: {
        marketplace:
          config.authSession?.authSurfaceOrigins["marketplace-web"] ??
          config.stripeSubscriptions.bookingAdminBaseUrl,
        bookingAdmin: config.stripeSubscriptions.bookingAdminBaseUrl,
      },
    })
  : undefined;

const financeRepository =
  config.financeSource === "target"
    ? createTargetFinancePropertySettingsRepository({
        connectionString: targetDatabaseUrl,
        stripeConnectProvider,
      })
    : undefined;

const stripeSubscriptionProvider = stripeSubscriptionRuntimeEnabled(config)
  ? createStripeFinanceSubscriptionProvider({
      secretKey: config.stripeSubscriptions.secretKey!,
      fixedPlanPriceId: config.stripeSubscriptions.fixedPlanPriceId,
    })
  : undefined;
const financeSubscriptionRoomInventory =
  config.financeSource === "target"
    ? createTargetPmsRoomInventoryReadPort({ connectionString: targetDatabaseUrl })
    : undefined;
const financeSubscriptionService =
  config.financeSource === "target"
    ? createFinanceSubscriptionService({
        store: createPgFinanceSubscriptionStore({ connectionString: targetDatabaseUrl }),
        roomInventory: financeSubscriptionRoomInventory!,
        stripe: stripeSubscriptionProvider,
        bookingAdminBaseUrl: config.stripeSubscriptions.bookingAdminBaseUrl,
        afterPlanChange: publicBookabilityPublisher
          ? async (propertyId) => {
              await publicBookabilityPublisher.publish({ propertyId });
            }
          : undefined,
      })
    : undefined;

const pmsFinanceCompatibilityRepository =
  config.pmsOperationsSource === "target" && config.financeSource !== "target"
    ? createTargetFinancePropertySettingsRepository({
        connectionString: targetDatabaseUrl,
      })
    : undefined;

const financePublicHotelProfileRepository =
  publicHotelProfileRepository ??
  (config.financeSource === "target"
    ? createTargetPublicHotelProfileRepository({
        connectionString: targetDatabaseUrl,
      })
    : undefined);

const financePublicHotelPropertyResolver =
  config.financeSource === "target"
    ? createTargetFinancePublicHotelPropertyResolver({
        connectionString: targetDatabaseUrl,
      })
    : undefined;

const sharedHotelSetupStatusRepository = createPgSharedHotelSetupStatusRepository({
  connectionString: targetDatabaseUrl,
});
const hotelSetupTrackCommandRepository = createPgHotelSetupTrackCommandRepository({
  connectionString: targetDatabaseUrl,
});
const hotelAccountInviteRepository = createPgHotelAccountInviteRepository({
  connectionString: targetDatabaseUrl,
});
const propertySetupDraftCommandRepository = createPgPropertySetupDraftCommandRepository({
  connectionString: targetDatabaseUrl,
});
const propertySetupDraftRepository = createPgPropertySetupDraftRepository({
  connectionString: targetDatabaseUrl,
});
const pmsPricingReadModel = createPgPmsPricingReadModel({
  connectionString: targetDatabaseUrl,
});

const xenditBankValidator = config.xenditSecretKey
  ? createXenditBankValidator({
      secretKey: config.xenditSecretKey,
    })
  : undefined;

const providerWebhookSecrets = {
  stripe: config.providerWebhooks.stripeSecret,
  xendit: config.providerWebhooks.xenditSecret,
  channex: config.providerWebhooks.channexSecret,
};
const hasProviderWebhookSecret = Object.values(providerWebhookSecrets).some(Boolean);

const bookingWebAffiliateRepository =
  config.affiliatePublicSource === "target"
    ? createPgBookingWebAffiliateRepository({
        connectionString: targetDatabaseUrl,
      })
    : undefined;

const bookingWebAffiliateHotelResolver =
  config.affiliatePublicSource === "target"
    ? createPgBookingWebAffiliateHotelResolver({
        connectionString: targetDatabaseUrl,
      })
    : undefined;

const hotelCatalogStep1Repository = createPgHotelCatalogStep1Repository({
  connectionString: targetDatabaseUrl,
});
const marketplaceHotelCollaborationPreferencesRepository =
  createPgMarketplaceHotelCollaborationPreferencesRepository({
    connectionString: targetDatabaseUrl,
  });
const bookingDesignRepository = createPgBookingDesignRepository({
  connectionString: targetDatabaseUrl,
});
const bookingDesignMediaAdapter = config.platformMediaServing
  ? createPgHotelMediaResolutionPort({
      connectionString: targetDatabaseUrl,
      serving: config.platformMediaServing,
    })
  : undefined;
const bookingDesignCatalogEvidenceRepository = bookingDesignMediaAdapter
  ? createPgBookingDesignCatalogEvidenceRepository({
      connectionString: targetDatabaseUrl,
      mediaResolver: createHotelMediaResolutionPort(bookingDesignMediaAdapter),
    })
  : undefined;
const bookingDesignReadinessProvider = bookingDesignCatalogEvidenceRepository
  ? createBookingDesignReadinessProvider({
      design: bookingDesignRepository,
      profile: bookingDesignCatalogEvidenceRepository.profile,
      coverAssignment: bookingDesignCatalogEvidenceRepository.coverAssignment,
      safeMedia: bookingDesignCatalogEvidenceRepository.safeMedia,
    })
  : undefined;

const platformMediaRuntime = composePlatformMediaRuntime({
  auth: config.auth,
  targetDatabaseUrl,
  platformMediaServing: config.platformMediaServing,
  allowedOrigins: config.authSession?.authAllowedOrigins,
});

const marketplaceSetupLifecycleStatusRepository = createPgMarketplaceSetupLifecycleStatusRepository(
  { connectionString: targetDatabaseUrl },
);
const bookingSetupLifecycleStatusRepository = createPgBookingSetupLifecycleStatusRepository({
  connectionString: targetDatabaseUrl,
});
const financePaymentReadinessReadModel = createPgFinancePaymentReadinessReadModel({
  connectionString: targetDatabaseUrl,
  pricingReadPort: pmsPricingReadModel,
});
const propertySetupOwnerPool = new pg.Pool({
  connectionString: targetDatabaseUrl,
  connectionTimeoutMillis: 5_000,
  max: 5,
});
const hotelCatalogCurrentOwnerEvidence = createPgHotelCatalogCurrentOwnerEvidencePorts({
  pool: propertySetupOwnerPool,
});
const bookingGuestPolicyRepository = createPgBookingGuestPolicyRepository({
  connectionString: targetDatabaseUrl,
  pool: propertySetupOwnerPool,
  scopeAuthorization: createPgBookingGuestPolicyScopeAuthorizationPort({
    pool: propertySetupOwnerPool,
  }),
});
const bookingGuestPolicyCatalogCurrentOwnerEvidence =
  createBookingGuestPolicyCatalogCurrentOwnerEvidenceAdapter({
    location: hotelCatalogCurrentOwnerEvidence.location,
    policy: hotelCatalogCurrentOwnerEvidence.policy,
  });

const propertySetupPmsRuntime = (() => {
  const roomFacts = createPgPmsRoomFactsReadModel({ connectionString: targetDatabaseUrl });
  const owner = createPgPropertySetupPmsOwnerRepository({ connectionString: targetDatabaseUrl });
  const recurringPricing = createPgPmsRecurringPricingReadModel({
    connectionString: targetDatabaseUrl,
  });
  const mandatoryCharges = createPgPmsMandatoryChargeConfirmationReadModel({
    connectionString: targetDatabaseUrl,
  });
  const propertyProfileEvidence = createPgHotelCatalogOperatingCalendarPropertyProfileEvidencePort({
    connectionString: targetDatabaseUrl,
  });
  const operatingCalendar = createPgPmsOperatingCalendarReadModel({
    connectionString: targetDatabaseUrl,
    propertyProfileEvidence,
    roomEvidence: { roomFacts, roomCapacity: roomFacts },
  });
  return {
    roomFacts,
    recurringPricing,
    provider: createPropertySetupPmsStateProvider({
      owner,
      pricing: pmsPricingReadModel,
      recurringPricing,
      mandatoryCharges,
      operatingCalendar,
      calendarRegistry: propertyProfileEvidence,
      catalogLocation: hotelCatalogCurrentOwnerEvidence.location,
    }),
    bookingGuestPolicyEvidence: createPropertySetupBookingGuestPolicyPmsCurrentOwnerEvidenceAdapter(
      {
        owner,
        pricing: pmsPricingReadModel,
      },
    ),
    resources: [
      roomFacts,
      owner,
      recurringPricing,
      mandatoryCharges,
      propertyProfileEvidence,
      operatingCalendar,
    ],
  };
})();

const pmsRoomPublicationRuntime = bookingDesignMediaAdapter
  ? (() => {
      const amenityVocabulary = createPmsRoomAmenityVocabularyValidationPort();
      const mediaResolver = createHotelMediaResolutionPort(bookingDesignMediaAdapter);
      const commandRepository = createPgPmsRoomPublicationCommandRepository({
        connectionString: targetDatabaseUrl,
        amenityVocabulary,
        mediaResolver,
      });
      const readModel = createPgPmsRoomPublicationReadModel({
        connectionString: targetDatabaseUrl,
        roomFacts: propertySetupPmsRuntime.roomFacts,
        roomCapacity: propertySetupPmsRuntime.roomFacts,
        amenityVocabulary,
        mediaResolver,
      });
      return { commandRepository, readModel };
    })()
  : undefined;

const bookingGuestPolicyCurrentOwnerEvidence = createBookingGuestPolicyCurrentOwnerEvidenceAdapter({
  booking: bookingGuestPolicyRepository,
  pms: propertySetupPmsRuntime.bookingGuestPolicyEvidence,
  catalog: bookingGuestPolicyCatalogCurrentOwnerEvidence,
});

const propertySetupRouteStateReadPort = createPropertySetupRouteStateReadPort({
  draftRepository: propertySetupDraftRepository,
  trackRepository: hotelSetupTrackCommandRepository,
  ownerStateProviders: {
    hotel_catalog: createPropertySetupHotelCatalogStateProvider(hotelCatalogStep1Repository),
    marketplace: createPropertySetupMarketplaceStateProvider(
      marketplaceHotelCollaborationPreferencesRepository,
    ),
    booking: createPropertySetupBookingStateProvider({
      design: bookingDesignRepository,
      catalog: hotelCatalogStep1Repository,
      guestPolicy: bookingGuestPolicyCurrentOwnerEvidence,
    }),
    pms: propertySetupPmsRuntime.provider,
    finance: createPropertySetupFinanceStateProvider({
      scope: createPgPropertySetupFinanceOwnerScopePort({ pool: propertySetupOwnerPool }),
      finance: financePaymentReadinessReadModel,
      pricing: pmsPricingReadModel,
    }),
    review_lifecycle: createPropertySetupReviewLifecycleStateProvider({
      marketplace: marketplaceSetupLifecycleStatusRepository,
      booking: bookingSetupLifecycleStatusRepository,
    }),
  },
});

const marketplaceCreatorSelfServiceRepository = createPgMarketplaceCreatorSelfServiceRepository({
  connectionString: targetDatabaseUrl,
});

const creatorPlatformConnectionRuntime = (() => {
  const connectionConfig = config.creatorPlatformConnections;
  const adapters: CreatorPlatformAdapter[] = [];
  if (connectionConfig?.instagram) {
    adapters.push(createInstagramCreatorPlatformAdapter(connectionConfig.instagram));
  }
  if (connectionConfig?.facebook) {
    adapters.push(createFacebookCreatorPlatformAdapter(connectionConfig.facebook));
  }
  if (connectionConfig?.tiktok) {
    adapters.push(createTikTokCreatorPlatformAdapter(connectionConfig.tiktok));
  }
  if (connectionConfig?.youtube) {
    adapters.push(createYouTubeCreatorPlatformAdapter(connectionConfig.youtube));
  }
  const credentialVault = !connectionConfig
    ? createUnavailableProviderCredentialVault()
    : connectionConfig.credentialVault.provider === "memory"
      ? createMemoryProviderCredentialVault()
      : createSecretsManagerProviderCredentialVault({
          region: connectionConfig.credentialVault.region,
        });
  return {
    repository: createPgMarketplaceCreatorPlatformConnectionRepository({
      connectionString: targetDatabaseUrl,
    }),
    credentialVault,
    adapters: createCreatorPlatformAdapterRegistry(adapters),
    callbackBaseUrl: connectionConfig?.callbackBaseUrl ?? "https://creator.api.localhost",
    webReturnUrl:
      connectionConfig?.webReturnUrl ?? "https://marketplace.localhost/profile/complete",
    credentialSecretPrefix:
      connectionConfig?.credentialVault.secretPrefix ?? "vayada/unconfigured/creator-platforms",
  };
})();

const authSessionHandoffRepository =
  config.auth && config.authSession
    ? createPgAuthSessionHandoffRepository({ connectionString: config.auth.databaseUrl })
    : undefined;

const app = buildApp({
  auth: buildAuthOptions(config.auth),
  browserAllowedOrigins: config.authSession?.authAllowedOrigins ?? [],
  authSession:
    config.auth && config.authSession
      ? {
          authKitClient: createWorkOSAuthKitClient({
            apiKey: config.authSession.workosApiKey,
            clientId: config.authSession.workosClientId,
            cookiePassword: config.authSession.authCookieSecret,
          }),
          identityRepository: createPgIdentityRepository({
            connectionString: config.auth.databaseUrl,
          }),
          lifecycleCommandBus: createPgIdentityLifecycleCommandBus({
            connectionString: config.auth.databaseUrl,
          }),
          productAuditSink: createPgProductAuditSink({
            connectionString: config.auth.databaseUrl,
          }),
          handoffRepository: authSessionHandoffRepository,
          tokenVerifier: createWorkOSVerifier({
            jwksUrl: config.auth.workosJwksUrl,
            issuer: config.auth.workosIssuer,
            audience: config.auth.workosAudience,
          }),
          logoutReturnUrl: config.authSession.authLogoutUrl,
          allowedOrigins: config.authSession.authAllowedOrigins,
          compatibilityCallbackOrigin: config.authSession.authCompatibilityCallbackOrigin,
          oauthStateSecret: config.authSession.oauthStateSecret,
          requiredOrganizationKind: "platform",
          surfacePolicies: {
            "platform-admin": {
              requiredOrganizationKind: "platform",
              logoutReturnUrl: config.authSession.authLogoutUrl,
              legacyJwtSecret: config.authSession.authLegacyMarketplaceJwtSecret,
              legacyJwtUserType: "admin",
              requiredMembershipRoleKey: "platform_admin",
              publicOrigin: config.authSession.authSurfaceOrigins["platform-admin"],
              firstPartySession:
                config.authSession.authFirstPartySurfaces.includes("platform-admin"),
            },
            "booking-admin": {
              requiredOrganizationKind: "hotel_group",
              logoutReturnUrl:
                config.authSession.authBookingAdminLogoutUrl ?? config.authSession.authLogoutUrl,
              legacyJwtSecret: config.authSession.authLegacyBookingJwtSecret,
              legacyJwtUserType: "hotel",
              publicOrigin: config.authSession.authSurfaceOrigins["booking-admin"],
              firstPartySession:
                config.authSession.authFirstPartySurfaces.includes("booking-admin"),
              requiredResourceLink: {
                product: "booking",
                resourceType: "booking_hotel",
              },
            },
            "pms-web": {
              requiredOrganizationKind: "hotel_group",
              logoutReturnUrl:
                config.authSession.authPmsWebLogoutUrl ?? config.authSession.authLogoutUrl,
              legacyJwtSecret: config.authSession.authLegacyPmsJwtSecret,
              legacyJwtUserType: "hotel",
              publicOrigin: config.authSession.authSurfaceOrigins["pms-web"],
              firstPartySession: config.authSession.authFirstPartySurfaces.includes("pms-web"),
              requireExplicitOrganizationSelection: true,
              selectedOrganizationCookieName: "vayada_pms_selected_org",
              requiredResourceLink: {
                product: "pms",
                resourceType: "pms_property",
              },
            },
            "affiliate-dashboard": {
              requiredOrganizationKind: "affiliate_partner",
              logoutReturnUrl:
                config.authSession.authAffiliateDashboardLogoutUrl ??
                config.authSession.authLogoutUrl,
              legacyJwtSecret:
                config.authSession.authLegacyAffiliatePmsJwtSecret ??
                config.authSession.authLegacyPmsJwtSecret,
              legacyJwtUserType: "affiliate",
              publicOrigin: config.authSession.authSurfaceOrigins["affiliate-dashboard"],
              firstPartySession:
                config.authSession.authFirstPartySurfaces.includes("affiliate-dashboard"),
              requiredResourceLink: {
                product: "affiliate",
                resourceType: "affiliate",
              },
            },
            "marketplace-web": {
              requiredOrganizationKind: ["creator_workspace", "hotel_group"],
              allowMissingOrganization: true,
              logoutReturnUrl:
                config.authSession.authMarketplaceWebLogoutUrl ?? config.authSession.authLogoutUrl,
              publicOrigin: config.authSession.authSurfaceOrigins["marketplace-web"],
              firstPartySession:
                config.authSession.authFirstPartySurfaces.includes("marketplace-web"),
            },
          },
          cookieSecure: config.authSession.authCookieSecure,
          cookieDomain: config.authSession.authCookieDomain,
          legacyMarketplaceJwtSecret: config.authSession.authLegacyMarketplaceJwtSecret,
        }
      : undefined,
  workosWebhooks:
    config.auth && config.authSession?.workosWebhookSecret
      ? {
          secret: config.authSession.workosWebhookSecret,
          verifier: createWorkosWebhookVerifier({
            apiKey: config.authSession.workosApiKey,
            secret: config.authSession.workosWebhookSecret,
          }),
          store: createPgWorkosWebhookStore({
            connectionString: config.auth.databaseUrl,
          }),
        }
      : undefined,
  providerWebhooks: hasProviderWebhookSecret
    ? {
        secrets: providerWebhookSecrets,
        modes: {
          stripe: config.providerWebhooks.stripeMode,
          xendit: config.providerWebhooks.xenditMode,
          channex: config.providerWebhooks.channexMode,
        },
        store: createPgProviderWebhookStore({
          connectionString: targetDatabaseUrl,
          stripeConnectProvider,
        }),
      }
    : undefined,
  bookingReservationsRepository,
  bookingChangeRequestRepository: bookingWebCheckoutAdapter,
  bookingAddonItemsRepository,
  bookingPromoCodesRepository,
  bookingDashboardMetricsReadPort,
  pmsOperationsRepository,
  propertyPlanReadRepository,
  pmsManualBookingPreview:
    pmsOperationsRepository && pmsRoomPublicationRuntime
      ? {
          pms: pmsOperationsRepository,
          pricing: {
            getPricingSourceSnapshot: (propertyId) =>
              pmsPricingReadModel.getPricingSourceSnapshot(propertyId),
            getRecurringPricingBookingEvidence: (propertyId) =>
              propertySetupPmsRuntime.recurringPricing.getRecurringPricingBookingEvidence(
                propertyId,
              ),
          },
          roomPublication: pmsRoomPublicationRuntime.readModel,
          booking: {
            listAddonItemsByHotelId: (propertyId) =>
              bookingAddonItemsRepository.listAddonItemsByHotelId(propertyId),
            getCurrentGuestPolicy: (scope) =>
              bookingGuestPolicyRepository.getCurrentGuestPolicy(scope),
          },
        }
      : undefined,
  pmsModuleActivationRepository,
  pmsReviewRepository: createPgPmsReviewRepository({ connectionString: targetDatabaseUrl }),
  pmsOperationsCommandRepository,
  bookingAcceptanceSettings,
  pmsRoomPublication: pmsRoomPublicationRuntime
    ? {
        mediaCommandPort: pmsRoomPublicationRuntime.commandRepository,
        amenitiesCommandPort: pmsRoomPublicationRuntime.commandRepository,
        snapshotPort: pmsRoomPublicationRuntime.readModel,
      }
    : undefined,
  pmsInventoryPublicOfferProjector: routePmsInventoryPublicOfferProjector,
  bookingGuestPiiPort,
  financeRepository,
  financeSubscriptionService,
  pmsFinanceCompatibilityRepository,
  financeXenditBankValidator: xenditBankValidator,
  financePublicHotelProfileRepository,
  financePublicHotelPropertyResolver,
  platformContactIntake: {
    repository: createPgPlatformContactIntakeRepository({
      connectionString: targetDatabaseUrl,
    }),
    allowedOrigins: config.marketplaceDiscoveryAllowedOrigins,
  },
  platformAdminDashboardRepository: createTargetPlatformAdminDashboardRepository({
    connectionString: targetDatabaseUrl,
  }),
  pmsOperationsAllowedOrigins: config.pmsOperationsAllowedOrigins,
  bookingSettingsRepository,
  bookingSettingsWriteRepository: bookingSettingsRepository,
  propertyLaunchSettingsRepository,
  publicBookabilityPublisher: routePublicBookabilityPublisher,
  bookingCustomDomainRepository,
  marketplaceDiscoveryRepository,
  marketplaceCollaborationRepository: createPgMarketplaceCollaborationReadRepository({
    connectionString: targetDatabaseUrl,
    attachmentMedia: platformMediaRuntime?.collaborationAttachments,
  }),
  marketplaceTripRepository: createPgMarketplaceTripRepository({
    connectionString: targetDatabaseUrl,
  }),
  marketplaceAdminRepository:
    config.marketplaceAdminSource === "target"
      ? createPgMarketplaceAdminRepository({
          connectionString: targetDatabaseUrl,
          identityAccess: createPgMarketplaceOfferIdentityAccessCommandPort(),
          offerMediaPromotion: platformMediaRuntime?.offerMediaPromotion,
        })
      : undefined,
  marketplaceAdminLegacySuperadminFallbackEnabled:
    config.marketplaceAdminLegacySuperadminFallbackEnabled,
  hotelAccountInvites: { repository: hotelAccountInviteRepository },
  marketplaceHotelProfileStatusRepository: createPgMarketplaceHotelProfileStatusRepository({
    connectionString: targetDatabaseUrl,
  }),
  marketplaceHotelSelfServiceRepository: createPgMarketplaceHotelSelfServiceRepository({
    connectionString: targetDatabaseUrl,
  }),
  marketplaceCreatorSelfServiceRepository,
  marketplaceCreatorPlatformConnections: creatorPlatformConnectionRuntime,
  marketplaceCreatorProfileMediaRepository: platformMediaRuntime?.profileMediaRepository,
  sharedHotelSetupStatusRepository,
  hotelSetupTrackCommandRepository,
  propertySetupDraftCommandRepository,
  propertySetupRouteStateReadPort,
  propertyMediaCommandRepository: platformMediaRuntime?.propertyMediaCommands,
  hotelCatalogStep1: platformMediaRuntime
    ? {
        repository: hotelCatalogStep1Repository,
        mediaCommands: platformMediaRuntime.propertyMediaCommands,
      }
    : undefined,
  marketplaceHotelCollaborationPreferences: {
    commandPort: marketplaceHotelCollaborationPreferencesRepository,
    readPort: marketplaceHotelCollaborationPreferencesRepository,
  },
  bookingDesign: {
    commandPort: bookingDesignRepository,
    readPort: bookingDesignRepository,
  },
  bookingDesignReadiness: bookingDesignReadinessProvider
    ? { readinessPort: bookingDesignReadinessProvider }
    : undefined,
  marketplaceDiscoveryAllowedOrigins: config.marketplaceDiscoveryAllowedOrigins,
  identityPrivacyRepository: config.auth
    ? createPgIdentityPrivacyRepository({
        connectionString: config.auth.databaseUrl,
      })
    : undefined,
  identityLifecycleCommandBus: config.auth
    ? createPgIdentityLifecycleCommandBus({
        connectionString: config.auth.databaseUrl,
      })
    : undefined,
  identityAdminUsersReadRepository: config.auth
    ? createPgIdentityAdminUsersReadRepository({
        connectionString: config.auth.databaseUrl,
      })
    : undefined,
  identityPrivacyAllowedOrigins: config.marketplaceDiscoveryAllowedOrigins,
  publicHotelProfileRepository,
  publicHotelQuoteRepository,
  bookingDomainResolutionSource: config.bookingDomainResolutionSource,
  bookingWebCalendarRepository,
  bookingWebCheckoutAdapter,
  bookingWebAttributionSink:
    config.bookingWebEventSink === "target" && config.auth
      ? createPgBookingWebEventSink({
          connectionString: config.auth.databaseUrl,
        })
      : undefined,
  bookingWebAffiliateHotelResolver,
  bookingWebAffiliateRepository,
  platformMedia: platformMediaRuntime?.routes,
});

app.addHook("onClose", async () => {
  await Promise.all([
    marketplaceHotelCollaborationPreferencesRepository.close(),
    bookingDesignRepository.close(),
    bookingDesignCatalogEvidenceRepository?.close(),
    bookingDesignMediaAdapter?.close?.(),
    pmsRoomPublicationRuntime?.commandRepository.close(),
    pmsRoomPublicationRuntime?.readModel.close(),
    ...(!platformMediaRuntime ? [hotelCatalogStep1Repository.close()] : []),
  ]);
});

let activeChannexReviewBatch: Promise<void> | undefined;
const runChannexReviews = () => {
  if (activeChannexReviewBatch) return;
  activeChannexReviewBatch = runChannexReviewJobs(targetDatabaseUrl)
    .then(({ failed }) => {
      if (failed > 0) app.log.warn({ failed }, "Channex review ingestion completed with failures");
    })
    .catch((error: unknown) => app.log.warn({ err: error }, "Channex review ingestion failed"))
    .finally(() => {
      activeChannexReviewBatch = undefined;
    });
};
const channexReviewTimer = hasProviderWebhookSecret
  ? setInterval(runChannexReviews, 5_000)
  : undefined;

app.addHook("onClose", async () => {
  await Promise.all([
    pmsPricingReadModel.close(),
    financePaymentReadinessReadModel.close(),
    marketplaceSetupLifecycleStatusRepository.close(),
    bookingSetupLifecycleStatusRepository.close(),
    bookingGuestPolicyRepository.close(),
    propertySetupOwnerPool.end(),
    propertySetupDraftRepository.close(),
    ...propertySetupPmsRuntime.resources.map((resource) => resource.close?.()),
  ]);
});
channexReviewTimer?.unref();
if (hasProviderWebhookSecret) runChannexReviews();
app.addHook("onClose", async () => {
  if (channexReviewTimer) clearInterval(channexReviewTimer);
  await activeChannexReviewBatch;
});

let activeFinanceSubscriptionBatch: Promise<void> | undefined;
const financeSubscriptionWebhooksEnabled = Boolean(
  stripeSubscriptionProvider &&
  financeSubscriptionRoomInventory &&
  stripeSubscriptionRuntimeEnabled(config),
);
const financeSubscriptionJobsEnabled = config.financeSource === "target";
const runFinanceSubscriptionJobs = () => {
  if (activeFinanceSubscriptionBatch || !financeSubscriptionJobsEnabled) return;
  const batches = [
    runFinanceSubscriptionNotificationJobs(targetDatabaseUrl, (notification) => {
      app.log.error(
        notification,
        "Fixed Plan recurring payment failed; internal follow-up required",
      );
    }),
  ];
  if (
    financeSubscriptionWebhooksEnabled &&
    stripeSubscriptionProvider &&
    financeSubscriptionRoomInventory
  ) {
    batches.push(
      runFinanceSubscriptionWebhookJobs(
        targetDatabaseUrl,
        stripeSubscriptionProvider,
        financeSubscriptionRoomInventory,
        {
          refreshPublicBookability: publicBookabilityPublisher
            ? async (propertyId) => {
                await publicBookabilityPublisher.publish({ propertyId });
              }
            : undefined,
        },
      ),
    );
  }
  activeFinanceSubscriptionBatch = Promise.all(batches)
    .then((results) => {
      const failed = results.reduce((total, result) => total + result.failed, 0);
      if (failed > 0) {
        app.log.warn({ failed }, "Finance subscription job processing completed with failures");
      }
    })
    .catch((error: unknown) =>
      app.log.warn({ err: error }, "Finance subscription job processing failed"),
    )
    .finally(() => {
      activeFinanceSubscriptionBatch = undefined;
    });
};
const financeSubscriptionTimer = financeSubscriptionJobsEnabled
  ? setInterval(runFinanceSubscriptionJobs, 5_000)
  : undefined;
financeSubscriptionTimer?.unref();
if (financeSubscriptionJobsEnabled) runFinanceSubscriptionJobs();
app.addHook("onClose", async () => {
  if (financeSubscriptionTimer) clearInterval(financeSubscriptionTimer);
  await activeFinanceSubscriptionBatch;
});

let activeRetryBatch: Promise<void> | undefined;
let pmsPublicOfferRetryTimer: NodeJS.Timeout | undefined;

if (pmsInventoryPublicOfferProjector) {
  const runRetryBatch = () => {
    if (activeRetryBatch) return;
    activeRetryBatch = pmsInventoryPublicOfferProjector
      .runRetryBatch()
      .then((result) => {
        if (result.exhaustedEvents > 0) {
          app.log.warn(
            {
              failedEvents: result.failedEvents,
              exhaustedEvents: result.exhaustedEvents,
              processedProperties: result.processedProperties,
            },
            "PMS public-offer projection retries exhausted",
          );
        } else if (result.failedEvents > 0) {
          app.log.warn(
            {
              failedEvents: result.failedEvents,
              processedProperties: result.processedProperties,
            },
            "PMS public-offer projection retry batch completed with failures",
          );
        }
      })
      .catch((error: unknown) => {
        app.log.warn({ err: error }, "PMS public-offer projection retry batch failed");
      })
      .finally(() => {
        activeRetryBatch = undefined;
      });
  };

  const retryEnabled =
    config.pmsInventoryPublicOfferRetryEnabled &&
    config.pmsOperationsSource === "target" &&
    config.bookingSettingsSource === "target" &&
    config.publicBookabilitySource === "target";
  pmsPublicOfferRetryTimer = retryEnabled
    ? setInterval(runRetryBatch, config.pmsInventoryPublicOfferRetryIntervalMs)
    : undefined;
  pmsPublicOfferRetryTimer?.unref();
  if (retryEnabled) runRetryBatch();
}

if (pmsInventoryPublicOfferProjector || publicBookabilityPublisher) {
  app.addHook("onClose", async () => {
    if (pmsPublicOfferRetryTimer) clearInterval(pmsPublicOfferRetryTimer);
    await activeRetryBatch;
    await pmsInventoryPublicOfferProjector?.close?.();
    await publicBookabilityPublisher?.close?.();
  });
}

if (platformMediaRuntime) {
  let activeCleanup: Promise<void> | undefined;
  let activePropertyMediaPublication: Promise<void> | undefined;
  const runCleanup = () => {
    if (activeCleanup) return;
    activeCleanup = runPlatformMediaCleanupJobs(platformMediaRuntime.cleanupStore)
      .then((result) => {
        if (result.failed > 0) {
          app.log.warn({ failed: result.failed }, "Platform media cleanup completed with failures");
        }
      })
      .catch((error: unknown) => {
        app.log.warn({ err: error }, "Platform media cleanup failed");
      })
      .finally(() => {
        activeCleanup = undefined;
      });
  };

  const cleanupTimer = config.platformMediaCleanupEnabled
    ? setInterval(runCleanup, config.platformMediaCleanupIntervalMs)
    : undefined;
  cleanupTimer?.unref();
  if (config.platformMediaCleanupEnabled) runCleanup();

  const runPropertyMediaPublication = () => {
    if (activePropertyMediaPublication) return;
    activePropertyMediaPublication = platformMediaRuntime.propertyMediaCommands
      .runPublicationBatch()
      .then((result) => {
        if (result.deadLettered > 0) {
          app.log.warn(
            { deadLettered: result.deadLettered },
            "Property media publications exhausted retries",
          );
        } else if (result.deferred > 0) {
          app.log.warn(
            { deferred: result.deferred },
            "Property media publication batch completed with deferred jobs",
          );
        }
      })
      .catch((error: unknown) => {
        app.log.warn({ err: error }, "Property media publication batch failed");
      })
      .finally(() => {
        activePropertyMediaPublication = undefined;
      });
  };
  const propertyMediaPublicationTimer = setInterval(runPropertyMediaPublication, 30_000);
  propertyMediaPublicationTimer.unref();
  runPropertyMediaPublication();

  app.addHook("onClose", async () => {
    if (cleanupTimer) clearInterval(cleanupTimer);
    clearInterval(propertyMediaPublicationTimer);
    await activeCleanup;
    await activePropertyMediaPublication;
    await platformMediaRuntime.propertyMediaCommands.close();
    await platformMediaRuntime.cleanupStore.close();
  });
}

const bookingLifecycleStore =
  config.bookingCheckoutCommandSource === "target"
    ? createPgBookingLifecycleStore({
        connectionString: targetDatabaseUrl,
        inventoryReservationPort: createTargetPmsInventoryReservationPort(),
        stripePaymentProvider: stripeBookingPaymentProvider,
      })
    : undefined;
let activeBookingLifecycleRun: Promise<void> | undefined;
const runBookingLifecycle = () => {
  if (!bookingLifecycleStore || activeBookingLifecycleRun) return;
  activeBookingLifecycleRun = runBookingLifecycleSchedulerJobs(bookingLifecycleStore)
    .then(() => undefined)
    .catch((error: unknown) => app.log.warn({ err: error }, "Booking lifecycle sweep failed"))
    .finally(() => {
      activeBookingLifecycleRun = undefined;
    });
};
const bookingLifecycleTimer = bookingLifecycleStore
  ? setInterval(runBookingLifecycle, 60_000)
  : undefined;
bookingLifecycleTimer?.unref();
if (bookingLifecycleStore) runBookingLifecycle();

const bookingEmailDelivery = config.bookingEmailDelivery
  ? createResendBookingEmailDelivery(config.bookingEmailDelivery)
  : undefined;
let activeBookingEmailDelivery: Promise<void> | undefined;
const runBookingEmailDelivery = () => {
  if (!bookingEmailDelivery || activeBookingEmailDelivery) return;
  activeBookingEmailDelivery = runBookingEmailDeliveryJobs(targetDatabaseUrl, bookingEmailDelivery)
    .then((result) => {
      if (result.failed > 0) {
        app.log.warn({ failed: result.failed }, "Booking email delivery completed with failures");
      }
    })
    .catch((error: unknown) => app.log.warn({ err: error }, "Booking email delivery failed"))
    .finally(() => {
      activeBookingEmailDelivery = undefined;
    });
};
const bookingEmailDeliveryTimer = bookingEmailDelivery
  ? setInterval(runBookingEmailDelivery, 5_000)
  : undefined;
bookingEmailDeliveryTimer?.unref();
if (bookingEmailDelivery) runBookingEmailDelivery();
app.addHook("onClose", async () => {
  if (bookingLifecycleTimer) clearInterval(bookingLifecycleTimer);
  if (bookingEmailDeliveryTimer) clearInterval(bookingEmailDeliveryTimer);
  await activeBookingLifecycleRun;
  await activeBookingEmailDelivery;
  await bookingLifecycleStore?.close();
});

const propertySetupDraftRetentionWorker = startPropertySetupDraftRetentionWorker({
  store: createPgPropertySetupDraftRetentionStore({
    connectionString: targetDatabaseUrl,
  }),
  enabled: config.propertySetupDraftRetentionEnabled,
  intervalMs: config.propertySetupDraftRetentionIntervalMs,
  batchSize: config.propertySetupDraftRetentionBatchSize,
  logger: app.log,
});

app.addHook("onClose", async () => {
  await propertySetupDraftRetentionWorker.close();
});

if (authSessionHandoffRepository) {
  let activeHandoffCleanup: Promise<void> | undefined;
  const runHandoffCleanup = () => {
    if (activeHandoffCleanup) return;
    const now = new Date();
    activeHandoffCleanup = authSessionHandoffRepository
      .scrubExpired({
        now,
        deleteBefore: new Date(now.getTime() - 24 * 60 * 60 * 1000),
      })
      .catch((error: unknown) => {
        app.log.warn({ err: error }, "Auth session handoff cleanup failed");
      })
      .finally(() => {
        activeHandoffCleanup = undefined;
      });
  };
  const handoffCleanupTimer = setInterval(runHandoffCleanup, 60_000);
  handoffCleanupTimer.unref();
  runHandoffCleanup();
  app.addHook("onClose", async () => {
    clearInterval(handoffCleanupTimer);
    await activeHandoffCleanup;
  });
}

try {
  await app.listen({ host: config.host, port: config.port });
} catch (error) {
  app.log.error(error);
  process.exit(1);
}
