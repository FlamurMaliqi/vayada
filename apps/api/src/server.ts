import { createPgIdentityRepository, createWorkOSVerifier } from "@vayada/backend-auth";
import {
  createPgEntitlementRepository,
  createPgRolePermissionRepository,
} from "@vayada/backend-authorization";

import { buildApp, type ApiAuthOptions } from "./app.js";
import { type ApiConfig, loadConfig } from "./config.js";
import { createPgAskAuditRepository } from "./platform/askAuditRepository.js";
import { createOpenAIAskModel } from "./platform/askIntelligence.js";
import { createTargetAskEvidenceRepository } from "./platform/askEvidenceRepository.js";
import { createPgBookingWebEventSink } from "./platform/bookingWebEvents.js";
import { createTargetBookingDashboardMetricsReadPort } from "./platform/bookingDashboard.js";
import { createTargetBookingGuestPiiPort } from "./platform/bookingGuestPii.js";
import { createPgIdentityLifecycleCommandBus } from "./platform/identityLifecycle.js";
import { createPgProductAuditSink } from "./platform/productAudit.js";
import { createTargetBookingReservationsReadRepository } from "./platform/bookingReservations.js";
import { createPgProviderWebhookStore } from "./platform/providerWebhooks.js";
import { createWorkOSAuthKitClient } from "./platform/workosAuthKit.js";
import {
  createPgWorkosWebhookStore,
  createWorkosWebhookVerifier,
} from "./platform/workosWebhooks.js";
import { createPublicRuntimeRepositories } from "./publicRuntime.js";
import { createTargetPmsOperationsCommandRepository } from "./domains/pmsOperationsCommandRepository.js";
import { createTargetPmsOperationsReadRepository } from "./domains/pmsOperationsReadModel.js";
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
  createHttpPmsGuestFormSettingsSync,
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
import { createPgMarketplaceCollaborationReadRepository } from "./routes/marketplaceCollaborations.js";
import { createPgMarketplaceAdminRepository } from "./routes/marketplaceAdmin.js";
import { createPgMarketplaceHotelProfileStatusRepository } from "./routes/marketplaceHotelProfileStatus.js";
import { createPgSharedHotelSetupStatusRepository } from "./platform/sharedHotelSetupStatusReadModel.js";
import { createPgIdentityAdminUsersReadRepository } from "./routes/identityAdminUsers.js";
import { createPgIdentityPrivacyRepository } from "./routes/identityPrivacy.js";
import {
  createDeterministicPlatformMediaFinalizer,
  createDeterministicPlatformMediaUploadSigner,
  createInMemoryPlatformMediaRepository,
  createPassthroughPlatformMediaTargetResolver,
} from "./routes/platformMedia.js";
import { createTargetPlatformAdminDashboardRepository } from "./routes/platform/admin/dashboard/bookingCompatible.js";
import { createPgPlatformContactIntakeRepository } from "./routes/platformContactIntake.js";

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

const {
  publicHotelProfileRepository,
  publicHotelQuoteRepository,
  bookingWebCalendarRepository,
  marketplaceDiscoveryRepository,
} = createPublicRuntimeRepositories(config);

const bookingSettingsRepository =
  config.bookingSettingsSource === "target"
    ? createPgTargetBookingSettingsRepository({
        connectionString: config.targetDatabaseUrl!,
      })
    : config.bookingDatabaseUrl
      ? createPgBookingSettingsReadRepository({
          connectionString: config.bookingDatabaseUrl,
        })
      : undefined;

const bookingGuestFormSettingsSync =
  config.pmsApiUrl && config.bookingSettingsSource !== "target"
    ? createHttpPmsGuestFormSettingsSync({
        pmsApiUrl: config.pmsApiUrl,
      })
    : undefined;

const bookingCustomDomainRepository = config.targetDatabaseUrl
  ? createTargetBookingCustomDomainRepository({
      connectionString: config.targetDatabaseUrl,
    })
  : undefined;

const bookingAddonItemsRepository = config.targetDatabaseUrl
  ? createPgTargetBookingAddonItemsRepository({
      connectionString: config.targetDatabaseUrl,
    })
  : undefined;

const bookingPromoCodesRepository = config.targetDatabaseUrl
  ? createPgTargetBookingPromoCodesRepository({
      connectionString: config.targetDatabaseUrl,
    })
  : undefined;

const bookingReservationsRepository =
  config.bookingReservationsSource === "target"
    ? (() => {
        if (!config.targetDatabaseUrl) {
          throw new Error(
            "TARGET_DATABASE_URL is required when BOOKING_RESERVATIONS_SOURCE=target",
          );
        }

        return createTargetBookingReservationsReadRepository({
          connectionString: config.targetDatabaseUrl,
        });
      })()
    : config.bookingReservationsReadDatabaseUrl
      ? createCompatibilityPmsBookingReservationsReadRepository({
          connectionString: config.bookingReservationsReadDatabaseUrl,
        })
      : undefined;

const bookingDashboardMetricsReadPort =
  config.bookingReservationsSource === "target" && config.targetDatabaseUrl
    ? createTargetBookingDashboardMetricsReadPort({
        connectionString: config.targetDatabaseUrl,
      })
    : undefined;

const bookingWebCheckoutAdapter =
  config.bookingCheckoutCommandSource === "target"
    ? createTargetBookingWebCheckoutAdapter({
        connectionString: config.targetDatabaseUrl!,
      })
    : undefined;

const pmsOperationsRepository =
  config.pmsOperationsSource === "target"
    ? createTargetPmsOperationsReadRepository({
        connectionString: config.targetDatabaseUrl!,
      })
    : undefined;

const bookingGuestPiiPort =
  config.pmsOperationsSource === "target"
    ? createTargetBookingGuestPiiPort({
        connectionString: config.targetDatabaseUrl!,
      })
    : undefined;

const pmsOperationsCommandRepository =
  config.pmsOperationsSource === "target" && pmsOperationsRepository
    ? createTargetPmsOperationsCommandRepository({
        connectionString: config.targetDatabaseUrl!,
        readRepository: pmsOperationsRepository,
      })
    : undefined;

const pmsModuleActivationRepository = config.auth
  ? createPgPmsModuleActivationRepository({
      connectionString: config.auth.databaseUrl,
    })
  : undefined;

const financeRepository =
  config.financeSource === "target"
    ? createTargetFinancePropertySettingsRepository({
        connectionString: config.targetDatabaseUrl!,
      })
    : undefined;

const financePublicHotelProfileRepository =
  publicHotelProfileRepository ??
  (config.financeSource === "target"
    ? createTargetPublicHotelProfileRepository({
        connectionString: config.targetDatabaseUrl!,
      })
    : undefined);

const financePublicHotelPropertyResolver =
  config.financeSource === "target"
    ? createTargetFinancePublicHotelPropertyResolver({
        connectionString: config.targetDatabaseUrl!,
      })
    : undefined;

const sharedHotelSetupStatusRepository = config.targetDatabaseUrl
  ? createPgSharedHotelSetupStatusRepository({
      connectionString: config.targetDatabaseUrl,
    })
  : undefined;

const xenditBankValidator = config.xenditSecretKey
  ? createXenditBankValidator({
      secretKey: config.xenditSecretKey,
    })
  : undefined;

const askModelProvider =
  config.askIntelligence.provider === "openai"
    ? await createOpenAIAskModel(config.askIntelligence)
    : undefined;

const askEvidenceRepository =
  config.askIntelligenceEvidenceSource === "target"
    ? createTargetAskEvidenceRepository({
        connectionString: config.targetDatabaseUrl!,
      })
    : undefined;

const providerWebhookSecrets = {
  stripe: config.providerWebhooks.stripeSecret,
  xendit: config.providerWebhooks.xenditSecret,
  channex: config.providerWebhooks.channexSecret,
};
const hasProviderWebhookSecret = Object.values(providerWebhookSecrets).some(Boolean);

const bookingWebAffiliateRepository =
  config.affiliatePublicSource === "target" && config.targetDatabaseUrl
    ? createPgBookingWebAffiliateRepository({
        connectionString: config.targetDatabaseUrl,
      })
    : undefined;

const bookingWebAffiliateHotelResolver =
  config.affiliatePublicSource === "target" && config.targetDatabaseUrl
    ? createPgBookingWebAffiliateHotelResolver({
        connectionString: config.targetDatabaseUrl,
      })
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
          tokenVerifier: createWorkOSVerifier({
            jwksUrl: config.auth.workosJwksUrl,
            issuer: config.auth.workosIssuer,
            audience: config.auth.workosAudience,
          }),
          callbackUrl: config.authSession.authCallbackUrl,
          callbackReturnUrl: config.authSession.authSuccessUrl,
          logoutReturnUrl: config.authSession.authLogoutUrl,
          allowedOrigins: config.authSession.authAllowedOrigins,
          requiredOrganizationKind: "platform",
          surfacePolicies: {
            "booking-admin": {
              requiredOrganizationKind: "hotel_group",
              callbackReturnUrl: config.authSession.authBookingAdminSuccessUrl,
              logoutReturnUrl:
                config.authSession.authBookingAdminLogoutUrl ?? config.authSession.authLogoutUrl,
              legacyJwtSecret: config.authSession.authLegacyBookingJwtSecret,
              legacyJwtUserType: "hotel",
              requiredResourceLink: {
                product: "booking",
                resourceType: "booking_hotel",
              },
            },
            "pms-web": {
              requiredOrganizationKind: "hotel_group",
              callbackReturnUrl: config.authSession.authPmsWebSuccessUrl,
              logoutReturnUrl:
                config.authSession.authPmsWebLogoutUrl ?? config.authSession.authLogoutUrl,
              legacyJwtSecret: config.authSession.authLegacyPmsJwtSecret,
              legacyJwtUserType: "hotel",
              requireExplicitOrganizationSelection: true,
              selectedOrganizationCookieName: "vayada_pms_selected_org",
              requiredResourceLink: {
                product: "pms",
                resourceType: "pms_property",
              },
            },
            "affiliate-dashboard": {
              requiredOrganizationKind: "affiliate_partner",
              callbackReturnUrl: config.authSession.authAffiliateDashboardSuccessUrl,
              logoutReturnUrl:
                config.authSession.authAffiliateDashboardLogoutUrl ??
                config.authSession.authLogoutUrl,
              legacyJwtSecret:
                config.authSession.authLegacyAffiliatePmsJwtSecret ??
                config.authSession.authLegacyPmsJwtSecret,
              legacyJwtUserType: "affiliate",
              requiredResourceLink: {
                product: "affiliate",
                resourceType: "affiliate",
              },
            },
            "marketplace-web": {
              requiredOrganizationKind: ["creator_workspace", "hotel_group"],
              callbackReturnUrl: config.authSession.authMarketplaceWebSuccessUrl,
              logoutReturnUrl:
                config.authSession.authMarketplaceWebLogoutUrl ?? config.authSession.authLogoutUrl,
            },
          },
          cookieSecure: config.authSession.authCookieSecure,
          stateCookieSecret: config.authSession.authCookieSecret,
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
  providerWebhooks:
    config.targetDatabaseUrl && hasProviderWebhookSecret
      ? {
          secrets: providerWebhookSecrets,
          modes: {
            stripe: config.providerWebhooks.stripeMode,
            xendit: config.providerWebhooks.xenditMode,
            channex: config.providerWebhooks.channexMode,
          },
          store: createPgProviderWebhookStore({
            connectionString: config.targetDatabaseUrl,
          }),
        }
      : undefined,
  bookingReservationsRepository,
  bookingAddonItemsRepository,
  bookingPromoCodesRepository,
  bookingDashboardMetricsReadPort,
  pmsOperationsRepository,
  pmsModuleActivationRepository,
  pmsOperationsCommandRepository,
  bookingGuestPiiPort,
  financeRepository,
  financeXenditBankValidator: xenditBankValidator,
  financePublicHotelProfileRepository,
  financePublicHotelPropertyResolver,
  platformContactIntake: config.targetDatabaseUrl
    ? {
        repository: createPgPlatformContactIntakeRepository({
          connectionString: config.targetDatabaseUrl,
        }),
        allowedOrigins: config.marketplaceDiscoveryAllowedOrigins,
      }
    : undefined,
  platformAdminDashboardRepository: config.targetDatabaseUrl
    ? createTargetPlatformAdminDashboardRepository({
        connectionString: config.targetDatabaseUrl,
      })
    : undefined,
  pmsOperationsAllowedOrigins: config.pmsOperationsAllowedOrigins,
  bookingSettingsRepository,
  bookingSettingsWriteRepository: bookingSettingsRepository,
  bookingGuestFormSettingsSync,
  bookingCustomDomainRepository,
  marketplaceDiscoveryRepository,
  marketplaceCollaborationRepository:
    config.marketplaceDiscoverySource === "target"
      ? createPgMarketplaceCollaborationReadRepository({
          connectionString: config.targetDatabaseUrl!,
        })
      : undefined,
  marketplaceAdminRepository:
    config.marketplaceAdminSource === "target"
      ? createPgMarketplaceAdminRepository({
          connectionString: config.targetDatabaseUrl!,
        })
      : undefined,
  marketplaceAdminLegacySuperadminFallbackEnabled:
    config.marketplaceAdminLegacySuperadminFallbackEnabled,
  marketplaceHotelProfileStatusRepository:
    config.marketplaceDiscoverySource === "target"
      ? createPgMarketplaceHotelProfileStatusRepository({
          connectionString: config.targetDatabaseUrl!,
        })
      : undefined,
  sharedHotelSetupStatusRepository,
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
  bookingPublicApiUrl: config.bookingPublicApiUrl,
  bookingDomainResolutionSource: config.bookingDomainResolutionSource,
  pmsPublicApiUrl: config.pmsPublicApiUrl,
  bookingWebCalendarRepository,
  bookingWebCheckoutAdapter,
  askModel: askModelProvider?.model,
  askModelMetadata: askModelProvider?.metadata,
  askAuditRepository: config.targetDatabaseUrl
    ? createPgAskAuditRepository({
        connectionString: config.targetDatabaseUrl,
      })
    : undefined,
  askEvidenceRepository,
  legacyCheckoutCommandProxyEnabled: config.bookingWebLegacyCheckoutCommandProxyEnabled,
  bookingWebAttributionSink:
    config.bookingWebEventSink === "target" && config.auth
      ? createPgBookingWebEventSink({
          connectionString: config.auth.databaseUrl,
        })
      : undefined,
  bookingWebAffiliateHotelResolver,
  bookingWebAffiliateRepository,
  platformMedia: config.auth
    ? {
        repository: createInMemoryPlatformMediaRepository(),
        signer: createDeterministicPlatformMediaUploadSigner(),
        targetResolver: createPassthroughPlatformMediaTargetResolver(),
        finalizer: createDeterministicPlatformMediaFinalizer(),
        allowedOrigins: config.authSession?.authAllowedOrigins ?? [],
      }
    : undefined,
});

try {
  await app.listen({ host: config.host, port: config.port });
} catch (error) {
  app.log.error(error);
  process.exit(1);
}
