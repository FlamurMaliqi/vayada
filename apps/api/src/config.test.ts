import { describe, expect, it } from "vitest";

import { loadConfig, stripeSubscriptionRuntimeEnabled } from "./config.js";

const completeCreatorMarketplaceEnv = {
  TARGET_DATABASE_URL: "postgresql://target-db",
  AUTH_DATABASE_URL: "postgresql://auth-db",
  WORKOS_JWKS_URL: "https://api.workos.com/sso/jwks/client",
  WORKOS_ISSUER: "https://api.workos.com",
  WORKOS_AUDIENCE: "client",
  PLATFORM_MEDIA_BUCKET: "vayada-media-staging",
  PLATFORM_MEDIA_CDN_BASE_URL: "https://cdn.staging.vayada.com",
  PLATFORM_MEDIA_CDN_ORIGIN_HOST: "vayada-media-staging.s3.us-east-1.amazonaws.com",
};

const completeCreatorPlatformConnectionEnv = {
  ...completeCreatorMarketplaceEnv,
};

const completeAuthSessionEnv = {
  WORKOS_CLIENT_ID: "client",
  WORKOS_API_KEY: "sk_test",
  AUTH_COOKIE_SECRET: "cookie-secret",
  AUTH_LOGOUT_URL: "https://admin.localhost/login",
  AUTH_ALLOWED_ORIGINS:
    "https://admin.localhost, https://api.localhost, https://admin.booking.localhost, " +
    "https://pms.localhost, https://affiliate.localhost, https://marketplace.localhost",
  AUTH_COMPATIBILITY_CALLBACK_ORIGIN: "https://api.localhost",
  AUTH_PLATFORM_ADMIN_ORIGIN: "https://admin.localhost",
  AUTH_BOOKING_ADMIN_ORIGIN: "https://admin.booking.localhost",
  AUTH_PMS_WEB_ORIGIN: "https://pms.localhost",
  AUTH_AFFILIATE_DASHBOARD_ORIGIN: "https://affiliate.localhost",
  AUTH_MARKETPLACE_WEB_ORIGIN: "https://marketplace.localhost",
};

describe("api config", () => {
  it("keeps Channex management fail-closed until each capability is cut over", () => {
    expect(loadConfig({}).channexManagement).toMatchObject({
      workerEnabled: false,
      capabilityModes: {
        connection: "observe_only",
        provisioning: "observe_only",
        ariSync: "observe_only",
        bookingSync: "observe_only",
        markups: "observe_only",
        messaging: "observe_only",
        iframe: "observe_only",
      },
    });
  });

  it("loads explicitly cut-over Channex capabilities only with target provider config", () => {
    const config = loadConfig({
      TARGET_DATABASE_URL: "postgresql://target-db",
      PMS_OPERATIONS_SOURCE: "target",
      CHANNEX_API_BASE_URL: "https://staging.channex.io",
      CHANNEX_API_KEY: "secret",
      PMS_CHANNEX_CONNECTION_MODE: "mutating",
      PMS_CHANNEX_WORKER_ENABLED: "true",
    });
    expect(config.channexManagement).toMatchObject({
      apiBaseUrl: "https://staging.channex.io",
      workerEnabled: true,
      capabilityModes: { connection: "mutating", provisioning: "observe_only" },
    });
  });

  it("rejects Channex mutation without provider config or target ownership", () => {
    expect(() => loadConfig({ PMS_CHANNEX_ARI_SYNC_MODE: "mutating" })).toThrow(
      "Mutating PMS Channex capabilities require CHANNEX_API_BASE_URL and CHANNEX_API_KEY",
    );
    expect(() =>
      loadConfig({
        PMS_CHANNEX_ARI_SYNC_MODE: "mutating",
        CHANNEX_API_BASE_URL: "https://staging.channex.io",
        CHANNEX_API_KEY: "secret",
      }),
    ).toThrow("Mutating PMS Channex capabilities require PMS_OPERATIONS_SOURCE=target");
    expect(() =>
      loadConfig({
        TARGET_DATABASE_URL: "postgresql://target-db",
        PMS_OPERATIONS_SOURCE: "target",
        PMS_CHANNEX_CONNECTION_MODE: "mutating",
        PMS_CHANNEX_WORKER_ENABLED: "false",
        CHANNEX_API_BASE_URL: "https://staging.channex.io",
        CHANNEX_API_KEY: "secret",
      }),
    ).toThrow("Mutating PMS Channex capabilities require PMS_CHANNEX_WORKER_ENABLED=true");
  });

  it("does not require the durable worker for an iframe-only cutover", () => {
    expect(
      loadConfig({
        TARGET_DATABASE_URL: "postgresql://target-db",
        PMS_OPERATIONS_SOURCE: "target",
        CHANNEX_API_BASE_URL: "https://staging.channex.io",
        CHANNEX_API_KEY: "secret",
        PMS_CHANNEX_IFRAME_MODE: "mutating",
      }).channexManagement,
    ).toMatchObject({ workerEnabled: false, capabilityModes: { iframe: "mutating" } });
  });

  it("keeps auth disabled when auth env values are absent", () => {
    expect(loadConfig({}).auth).toBeUndefined();
  });

  it("loads auth config when all auth env values are present", () => {
    expect(
      loadConfig({
        AUTH_DATABASE_URL: "postgresql://auth-db",
        WORKOS_JWKS_URL: "https://api.workos.com/sso/jwks/client",
        WORKOS_ISSUER: "https://api.workos.com",
        WORKOS_AUDIENCE: "client",
      }).auth,
    ).toEqual({
      databaseUrl: "postgresql://auth-db",
      workosJwksUrl: "https://api.workos.com/sso/jwks/client",
      workosIssuer: "https://api.workos.com",
      workosAudience: "client",
    });
  });

  it("adds libpq compatibility for Postgres SSL database URLs", () => {
    const config = loadConfig({
      AUTH_DATABASE_URL: "postgresql://user:pass@auth-db:5432/auth?sslmode=require",
      WORKOS_JWKS_URL: "https://api.workos.com/sso/jwks/client",
      WORKOS_ISSUER: "https://api.workos.com",
      WORKOS_AUDIENCE: "client",
      TARGET_DATABASE_URL: "postgresql://user:pass@target-db:5432/target?sslmode=require",
      PLATFORM_MEDIA_BUCKET: "vayada-media-staging",
      PLATFORM_MEDIA_CDN_BASE_URL: "https://cdn.staging.vayada.com",
      PLATFORM_MEDIA_CDN_ORIGIN_HOST: "vayada-media-staging.s3.us-east-1.amazonaws.com",
    });

    expect(config.auth?.databaseUrl).toBe(
      "postgresql://user:pass@auth-db:5432/auth?sslmode=require&uselibpqcompat=true",
    );
    expect(config.targetDatabaseUrl).toBe(
      "postgresql://user:pass@target-db:5432/target?sslmode=require&uselibpqcompat=true",
    );
  });

  it("rejects partial auth config", () => {
    expect(() =>
      loadConfig({
        AUTH_DATABASE_URL: "postgresql://auth-db",
      }),
    ).toThrow("Incomplete auth config");
  });

  it("loads AuthKit session route config when all session env values are present", () => {
    expect(
      loadConfig({
        ...completeAuthSessionEnv,
        AUTH_OAUTH_STATE_SECRET: "oauth-state-secret",
        AUTH_FIRST_PARTY_SURFACES: "marketplace-web,pms-web,marketplace-web",
        AUTH_COOKIE_SECURE: "true",
        AUTH_COOKIE_DOMAIN: "localhost",
        AUTH_LEGACY_MARKETPLACE_JWT_SECRET: "legacy-secret",
        AUTH_AFFILIATE_DASHBOARD_LOGOUT_URL: "https://affiliate.localhost/login",
        AUTH_LEGACY_AFFILIATE_PMS_JWT_SECRET: "affiliate-pms-secret",
        AUTH_MARKETPLACE_WEB_LOGOUT_URL: "https://marketplace.localhost/login",
      }).authSession,
    ).toEqual({
      workosClientId: "client",
      workosApiKey: "sk_test",
      authCookieSecret: "cookie-secret",
      oauthStateSecret: "oauth-state-secret",
      authLogoutUrl: "https://admin.localhost/login",
      authAllowedOrigins: [
        "https://admin.localhost",
        "https://api.localhost",
        "https://admin.booking.localhost",
        "https://pms.localhost",
        "https://affiliate.localhost",
        "https://marketplace.localhost",
      ],
      authCompatibilityCallbackOrigin: "https://api.localhost",
      authSurfaceOrigins: {
        "platform-admin": "https://admin.localhost",
        "booking-admin": "https://admin.booking.localhost",
        "pms-web": "https://pms.localhost",
        "affiliate-dashboard": "https://affiliate.localhost",
        "marketplace-web": "https://marketplace.localhost",
      },
      authFirstPartySurfaces: ["marketplace-web", "pms-web"],
      authCookieSecure: true,
      authCookieDomain: "localhost",
      authLegacyMarketplaceJwtSecret: "legacy-secret",
      authAffiliateDashboardLogoutUrl: "https://affiliate.localhost/login",
      authLegacyAffiliatePmsJwtSecret: "affiliate-pms-secret",
      authMarketplaceWebLogoutUrl: "https://marketplace.localhost/login",
    });
  });

  it("rejects partial AuthKit session route config", () => {
    expect(() =>
      loadConfig({
        WORKOS_CLIENT_ID: "client",
      }),
    ).toThrow("Incomplete auth session config");
  });

  it("rejects auth callback origins outside the exact allowlist", () => {
    expect(() =>
      loadConfig({
        ...completeAuthSessionEnv,
        AUTH_MARKETPLACE_WEB_ORIGIN: "https://evil.example",
      }),
    ).toThrow("Auth callback origins must be included in AUTH_ALLOWED_ORIGINS");
  });

  it("rejects malformed auth origins and unsupported rollout surfaces", () => {
    expect(() =>
      loadConfig({
        ...completeAuthSessionEnv,
        AUTH_PMS_WEB_ORIGIN: "https://pms.localhost/login",
      }),
    ).toThrow("AUTH_PMS_WEB_ORIGIN must be an absolute HTTP(S) origin");
    expect(() =>
      loadConfig({
        ...completeAuthSessionEnv,
        AUTH_FIRST_PARTY_SURFACES: "marketplace-web,unknown-surface",
      }),
    ).toThrow("AUTH_FIRST_PARTY_SURFACES contains unsupported surfaces: unknown-surface");
  });

  it("requires secure cookies for enabled HTTPS first-party surfaces", () => {
    expect(() =>
      loadConfig({
        ...completeAuthSessionEnv,
        AUTH_COOKIE_SECURE: "false",
        AUTH_FIRST_PARTY_SURFACES: "marketplace-web",
      }),
    ).toThrow("AUTH_COOKIE_SECURE must be true for HTTPS first-party surfaces: marketplace-web");
  });

  it("loads independently configured creator platform providers", () => {
    expect(
      loadConfig({
        ...completeCreatorPlatformConnectionEnv,
        NODE_ENV: "test",
        CREATOR_PLATFORM_CALLBACK_BASE_URL: "https://creator.api.localhost:1356",
        CREATOR_PLATFORM_WEB_RETURN_URL: "https://marketplace.localhost:1356/profile/complete",
        CREATOR_PLATFORM_CREDENTIAL_VAULT: "memory",
        CREATOR_PLATFORM_SECRET_PREFIX: "vayada/test/creator-platforms",
        TIKTOK_CLIENT_KEY: "client-key",
        TIKTOK_CLIENT_SECRET: "client-secret",
      }).creatorPlatformConnections,
    ).toEqual({
      callbackBaseUrl: "https://creator.api.localhost:1356",
      webReturnUrl: "https://marketplace.localhost:1356/profile/complete",
      credentialVault: {
        provider: "memory",
        secretPrefix: "vayada/test/creator-platforms",
      },
      tiktok: { clientKey: "client-key", clientSecret: "client-secret" },
    });
  });

  it("rejects partial creator platform provider config", () => {
    expect(() => loadConfig({ INSTAGRAM_CLIENT_ID: "instagram-client" })).toThrow(
      "Incomplete Instagram creator platform config; missing INSTAGRAM_CLIENT_SECRET, INSTAGRAM_API_VERSION",
    );
  });

  it("rejects the in-memory creator credential vault in production", () => {
    expect(() =>
      loadConfig({
        ...completeCreatorPlatformConnectionEnv,
        NODE_ENV: "production",
        CREATOR_PLATFORM_CALLBACK_BASE_URL: "https://api.example.com",
        CREATOR_PLATFORM_WEB_RETURN_URL: "https://marketplace.example.com/profile/complete",
        CREATOR_PLATFORM_CREDENTIAL_VAULT: "memory",
        CREATOR_PLATFORM_SECRET_PREFIX: "vayada/production/creator-platforms",
        TIKTOK_CLIENT_KEY: "client-key",
        TIKTOK_CLIENT_SECRET: "client-secret",
      }),
    ).toThrow("CREATOR_PLATFORM_CREDENTIAL_VAULT=memory is not allowed in production");
  });

  it("loads target public hotel profile config", () => {
    expect(
      loadConfig({
        TARGET_DATABASE_URL: "postgresql://target-db",
        PUBLIC_HOTEL_PROFILE_SOURCE: "target",
      }),
    ).toMatchObject({
      targetDatabaseUrl: "postgresql://target-db",
      publicHotelProfileSource: "target",
    });
  });

  it("defaults public hotel profiles to the target source", () => {
    expect(
      loadConfig({ TARGET_DATABASE_URL: "postgresql://target-db" }).publicHotelProfileSource,
    ).toBe("target");
  });

  it("loads active immutable publication profiles", () => {
    expect(
      loadConfig({
        TARGET_DATABASE_URL: "postgresql://target-db",
        PUBLIC_HOTEL_PROFILE_SOURCE: "active_publication",
      }).publicHotelProfileSource,
    ).toBe("active_publication");
  });

  it("rejects unsupported public profile source config", () => {
    expect(() =>
      loadConfig({
        PUBLIC_HOTEL_PROFILE_SOURCE: "booking",
      }),
    ).toThrow("PUBLIC_HOTEL_PROFILE_SOURCE must be one of: target, active_publication");
  });

  it("loads optional target database config", () => {
    expect(
      loadConfig({
        TARGET_DATABASE_URL: "postgresql://target-db",
      }).targetDatabaseUrl,
    ).toBe("postgresql://target-db");
  });

  it("loads next API runtime only with target sources", () => {
    const config = loadConfig({
      API_RUNTIME: "next",
      TARGET_DATABASE_URL: "postgresql://target-db",
      PUBLIC_HOTEL_PROFILE_SOURCE: "target",
      PMS_OPERATIONS_SOURCE: "target",
      FINANCE_SOURCE: "target",
    });

    expect(config).toMatchObject({
      apiRuntime: "next",
      publicHotelProfileSource: "target",
      pmsOperationsSource: "target",
      financeSource: "target",
    });
  });

  it("loads next API runtime with an explicitly disabled PMS surface", () => {
    const config = loadConfig({
      API_RUNTIME: "next",
      TARGET_DATABASE_URL: "postgresql://target-db",
      PUBLIC_HOTEL_PROFILE_SOURCE: "target",
      PMS_OPERATIONS_SOURCE: "disabled",
      FINANCE_SOURCE: "target",
    });

    expect(config.pmsOperationsSource).toBe("disabled");
  });

  it("rejects removed legacy Python integration URL envs in every runtime", () => {
    expect(() =>
      loadConfig({
        BOOKING_PUBLIC_API_URL: "https://api.booking.localhost",
        PMS_API_URL: "https://api.pms.localhost",
        PMS_PUBLIC_API_URL: "https://api.pms.localhost",
      }),
    ).toThrow(
      "apps/api no longer supports legacy Python integration envs: BOOKING_PUBLIC_API_URL, PMS_API_URL, PMS_PUBLIC_API_URL",
    );
  });

  it("rejects next API runtime when source selectors would default to legacy or disabled", () => {
    expect(() =>
      loadConfig({
        API_RUNTIME: "next",
        TARGET_DATABASE_URL: "postgresql://target-db",
      }),
    ).toThrow(
      "API_RUNTIME=next requires target runtime sources: PMS_OPERATIONS_SOURCE=target or explicit disabled, FINANCE_SOURCE=target",
    );
  });

  it("defaults provider webhook intake modes to observe-only shadow intake", () => {
    expect(loadConfig({}).providerWebhooks).toEqual({
      stripeSecret: undefined,
      xenditSecret: undefined,
      channexSecret: undefined,
      stripeMode: "observe_only",
      xenditMode: "observe_only",
      channexMode: "observe_only",
    });
  });

  it("loads provider webhook secrets and per-provider intake modes", () => {
    const config = loadConfig({
      STRIPE_WEBHOOK_SECRET: "stripe-secret",
      XENDIT_WEBHOOK_SECRET: "xendit-secret",
      CHANNEX_WEBHOOK_SECRET: "channex-secret",
      STRIPE_WEBHOOK_INTAKE_MODE: "mutating",
      XENDIT_WEBHOOK_INTAKE_MODE: "ack_only_with_receipt",
      CHANNEX_WEBHOOK_INTAKE_MODE: "observe_only",
      XENDIT_SECRET_KEY: "xendit-api-secret",
    });

    expect(config.providerWebhooks).toEqual({
      stripeSecret: "stripe-secret",
      xenditSecret: "xendit-secret",
      channexSecret: "channex-secret",
      stripeMode: "mutating",
      xenditMode: "ack_only_with_receipt",
      channexMode: "observe_only",
    });
    expect(config.xenditSecretKey).toBe("xendit-api-secret");
  });

  it("loads Xendit bank-validation secret independently of webhook intake", () => {
    expect(
      loadConfig({
        XENDIT_SECRET_KEY: "xendit-api-secret",
      }).xenditSecretKey,
    ).toBe("xendit-api-secret");
  });

  it("loads Stripe subscription billing separately from webhook verification", () => {
    expect(
      loadConfig({
        STRIPE_SECRET_KEY: "sk_test_subscription",
        STRIPE_FIXED_PLAN_PRICE_ID: "price_fixed",
        BOOKING_ADMIN_BASE_URL: "https://admin.booking.example",
      }).stripeSubscriptions,
    ).toEqual({
      secretKey: "sk_test_subscription",
      fixedPlanPriceId: "price_fixed",
      bookingAdminBaseUrl: "https://admin.booking.example",
    });
  });

  it("enables Stripe Checkout only when subscription mutation and webhook recovery are ready", () => {
    const stripeRuntimeEnv = {
      TARGET_DATABASE_URL: "postgresql://target-db",
      FINANCE_SOURCE: "target",
      STRIPE_SECRET_KEY: "sk_test_subscription",
      STRIPE_FIXED_PLAN_PRICE_ID: "price_fixed",
      STRIPE_WEBHOOK_SECRET: "whsec_subscription",
      STRIPE_WEBHOOK_INTAKE_MODE: "mutating",
    };
    const complete = loadConfig(stripeRuntimeEnv);
    expect(stripeSubscriptionRuntimeEnabled(complete)).toBe(true);
    expect(
      stripeSubscriptionRuntimeEnabled(
        loadConfig({ ...stripeRuntimeEnv, STRIPE_FIXED_PLAN_PRICE_ID: undefined }),
      ),
    ).toBe(true);

    for (const env of [
      { ...stripeRuntimeEnv, STRIPE_SECRET_KEY: undefined },
      { ...stripeRuntimeEnv, STRIPE_WEBHOOK_SECRET: undefined },
      { ...stripeRuntimeEnv, STRIPE_WEBHOOK_INTAKE_MODE: "observe_only" },
    ]) {
      expect(stripeSubscriptionRuntimeEnabled(loadConfig(env))).toBe(false);
    }
  });

  it("rejects a non-HTTP Booking Admin return origin", () => {
    expect(() => loadConfig({ BOOKING_ADMIN_BASE_URL: "ftp://admin.booking.example" })).toThrow(
      "BOOKING_ADMIN_BASE_URL must be an absolute HTTP(S) origin",
    );
  });

  it("rejects unsupported provider webhook intake modes", () => {
    expect(() =>
      loadConfig({
        STRIPE_WEBHOOK_INTAKE_MODE: "proxy_to_target",
      }),
    ).toThrow(
      "STRIPE_WEBHOOK_INTAKE_MODE must be one of: observe_only, mutating, ack_only_with_receipt",
    );
  });

  it("defaults Booking Web event sink to disabled until target auth config is explicit", () => {
    expect(loadConfig({}).bookingWebEventSink).toBe("disabled");
  });

  it("can disable the Booking Web event sink for local no-op intake", () => {
    expect(
      loadConfig({
        BOOKING_WEB_EVENT_SINK: "disabled",
      }).bookingWebEventSink,
    ).toBe("disabled");
  });

  it("loads target Booking Web event sink config", () => {
    expect(
      loadConfig({
        ...completeCreatorMarketplaceEnv,
        PUBLIC_HOTEL_PROFILE_SOURCE: "target",
        BOOKING_WEB_EVENT_SINK: "target",
      }).bookingWebEventSink,
    ).toBe("target");
  });

  it("loads target Booking Web events with active publication profiles", () => {
    expect(
      loadConfig({
        ...completeCreatorMarketplaceEnv,
        PUBLIC_HOTEL_PROFILE_SOURCE: "active_publication",
        BOOKING_WEB_EVENT_SINK: "target",
      }).bookingWebEventSink,
    ).toBe("target");
  });

  it("requires auth config for the target Booking Web event sink", () => {
    expect(() =>
      loadConfig({
        TARGET_DATABASE_URL: "postgresql://target-db",
        PUBLIC_HOTEL_PROFILE_SOURCE: "target",
        BOOKING_WEB_EVENT_SINK: "target",
      }),
    ).toThrow("BOOKING_WEB_EVENT_SINK=target requires complete auth config");
  });

  it("rejects unsupported Booking Web event sink config", () => {
    expect(() =>
      loadConfig({
        BOOKING_WEB_EVENT_SINK: "legacy",
      }),
    ).toThrow("BOOKING_WEB_EVENT_SINK must be one of: disabled, target");
  });

  it("keeps marketplace admin legacy superadmin fallback disabled by default", () => {
    expect(loadConfig({}).marketplaceAdminLegacySuperadminFallbackEnabled).toBe(false);
    expect(
      loadConfig({
        MARKETPLACE_ADMIN_LEGACY_SUPERADMIN_FALLBACK_ENABLED: "true",
      }).marketplaceAdminLegacySuperadminFallbackEnabled,
    ).toBe(true);
  });

  it("requires durable media whenever target Marketplace and auth make the server creator-capable", () => {
    expect(loadConfig(completeCreatorMarketplaceEnv).platformMediaServing).toBeDefined();
    expect(() =>
      loadConfig({
        ...completeCreatorMarketplaceEnv,
        PLATFORM_MEDIA_BUCKET: undefined,
        PLATFORM_MEDIA_CDN_BASE_URL: undefined,
        PLATFORM_MEDIA_CDN_ORIGIN_HOST: undefined,
      }),
    ).toThrow(
      "Target Marketplace with complete auth requires complete PLATFORM_MEDIA_* config because creator profile photos are required",
    );
  });

  it("keeps PMS operations routes disabled by default", () => {
    expect(loadConfig({}).pmsOperationsSource).toBe("disabled");
  });

  it("loads target PMS operations config", () => {
    const config = loadConfig({
      TARGET_DATABASE_URL: "postgresql://target-db",
      PMS_OPERATIONS_SOURCE: "target",
    });

    expect(config.pmsOperationsSource).toBe("target");
    expect(config.pmsOperationsAllowedOrigins).toEqual([
      "https://pms.localhost",
      "https://admin.booking.localhost",
      "https://marketplace.localhost",
    ]);
  });

  it("loads PMS operations allowed origins from comma-separated config", () => {
    expect(
      loadConfig({
        PMS_OPERATIONS_ALLOWED_ORIGINS: "https://pms.localhost, https://pms.vayada.com,",
      }).pmsOperationsAllowedOrigins,
    ).toEqual(["https://pms.localhost", "https://pms.vayada.com"]);
  });

  it("requires target database config when PMS operations use the target source", () => {
    expect(() =>
      loadConfig({
        PMS_OPERATIONS_SOURCE: "target",
      }),
    ).toThrow("TARGET_DATABASE_URL is required when PMS_OPERATIONS_SOURCE=target");
  });

  it("rejects unsupported PMS operations source config", () => {
    expect(() =>
      loadConfig({
        PMS_OPERATIONS_SOURCE: "legacy",
      }),
    ).toThrow("PMS_OPERATIONS_SOURCE must be one of: disabled, target");
  });

  it("keeps finance reads on the legacy source by default", () => {
    expect(loadConfig({}).financeSource).toBe("legacy");
  });

  it("loads target finance reads without legacy product database config", () => {
    expect(
      loadConfig({
        TARGET_DATABASE_URL: "postgresql://target-db",
        FINANCE_SOURCE: "target",
      }).financeSource,
    ).toBe("target");
  });

  it("requires target database config when finance reads use the target source", () => {
    expect(() =>
      loadConfig({
        FINANCE_SOURCE: "target",
      }),
    ).toThrow("FINANCE_SOURCE=target requires TARGET_DATABASE_URL");
  });

  it("rejects unsupported finance source config", () => {
    expect(() =>
      loadConfig({
        FINANCE_SOURCE: "preview",
      }),
    ).toThrow("FINANCE_SOURCE must be one of: legacy, target");
  });

  it("loads target-owned affiliate public route config", () => {
    expect(
      loadConfig({
        TARGET_DATABASE_URL: "postgresql://target-db",
        AFFILIATE_PUBLIC_SOURCE: "target",
      }),
    ).toMatchObject({
      targetDatabaseUrl: "postgresql://target-db",
      affiliatePublicSource: "target",
    });
  });

  it("requires a target database for target-owned affiliate public routes", () => {
    expect(() =>
      loadConfig({
        AFFILIATE_PUBLIC_SOURCE: "target",
      }),
    ).toThrow("AFFILIATE_PUBLIC_SOURCE=target requires TARGET_DATABASE_URL");
  });

  it("rejects unsupported affiliate public route sources", () => {
    expect(() =>
      loadConfig({
        TARGET_DATABASE_URL: "postgresql://target-db",
        AFFILIATE_PUBLIC_SOURCE: "pms",
      }),
    ).toThrow("Unsupported AFFILIATE_PUBLIC_SOURCE");
  });

  it("loads marketplace discovery allowed origins from comma-separated config", () => {
    expect(
      loadConfig({
        MARKETPLACE_DISCOVERY_ALLOWED_ORIGINS:
          "https://marketplace.localhost, https://admin.localhost,",
      }).marketplaceDiscoveryAllowedOrigins,
    ).toEqual(["https://marketplace.localhost", "https://admin.localhost"]);
  });

  it("requires booking email delivery for checkout in production", () => {
    expect(() =>
      loadConfig({
        NODE_ENV: "production",
        TARGET_DATABASE_URL: "postgresql://target-db",
      }),
    ).toThrow("requires RESEND_API_KEY and BOOKING_EMAIL_FROM");

    expect(
      loadConfig({
        NODE_ENV: "production",
        TARGET_DATABASE_URL: "postgresql://target-db",
        RESEND_API_KEY: "re_test",
        BOOKING_EMAIL_FROM: "Vayada <bookings@example.test>",
        FINANCE_SOURCE: "target",
        STRIPE_SECRET_KEY: "sk_test",
        STRIPE_WEBHOOK_SECRET: "whsec_test",
        STRIPE_WEBHOOK_INTAKE_MODE: "mutating",
      }).bookingEmailDelivery,
    ).toEqual({
      provider: "resend",
      apiKey: "re_test",
      from: "Vayada <bookings@example.test>",
    });
  });

  it("requires the Stripe mutation and recovery runtime for checkout in production", () => {
    const complete = {
      NODE_ENV: "production",
      API_RUNTIME: "next",
      TARGET_DATABASE_URL: "postgresql://target-db",
      PUBLIC_HOTEL_PROFILE_SOURCE: "target",
      PMS_OPERATIONS_SOURCE: "target",
      FINANCE_SOURCE: "target",
      RESEND_API_KEY: "re_test",
      BOOKING_EMAIL_FROM: "Vayada <bookings@example.test>",
      STRIPE_SECRET_KEY: "sk_test",
      STRIPE_WEBHOOK_SECRET: "whsec_test",
      STRIPE_WEBHOOK_INTAKE_MODE: "mutating",
    };
    expect(stripeSubscriptionRuntimeEnabled(loadConfig(complete))).toBe(true);
    for (const env of [
      { ...complete, STRIPE_SECRET_KEY: undefined },
      { ...complete, STRIPE_WEBHOOK_SECRET: undefined },
      { ...complete, STRIPE_WEBHOOK_INTAKE_MODE: "observe_only" },
    ]) {
      expect(() => loadConfig(env)).toThrow("requires STRIPE_SECRET_KEY");
    }
    expect(() => loadConfig({ ...complete, FINANCE_SOURCE: "legacy" })).toThrow(
      "API_RUNTIME=next requires target runtime sources: FINANCE_SOURCE=target",
    );
  });

  it("loads optional booking host base config", () => {
    expect(
      loadConfig({
        BOOKING_HOST_BASE: "booking.localhost",
      }).bookingHostBase,
    ).toBe("booking.localhost");
  });

  it("keeps platform media serving inactive by default", () => {
    expect(loadConfig({}).platformMediaServing).toBeUndefined();
  });

  it("configures and can disable the platform media cleanup interval", () => {
    expect(loadConfig({})).toMatchObject({
      platformMediaCleanupEnabled: true,
      platformMediaCleanupIntervalMs: 15 * 60 * 1000,
    });
    expect(
      loadConfig({
        PLATFORM_MEDIA_CLEANUP_ENABLED: "false",
        PLATFORM_MEDIA_CLEANUP_INTERVAL_MS: "60000",
      }),
    ).toMatchObject({
      platformMediaCleanupEnabled: false,
      platformMediaCleanupIntervalMs: 60_000,
    });
    expect(() => loadConfig({ PLATFORM_MEDIA_CLEANUP_INTERVAL_MS: "0" })).toThrow(
      "PLATFORM_MEDIA_CLEANUP_INTERVAL_MS must be a positive integer",
    );
  });

  it("configures and can disable property setup draft retention", () => {
    expect(loadConfig({})).toMatchObject({
      propertySetupDraftRetentionEnabled: true,
      propertySetupDraftRetentionIntervalMs: 60 * 60 * 1000,
      propertySetupDraftRetentionBatchSize: 100,
    });
    expect(
      loadConfig({
        PROPERTY_SETUP_DRAFT_RETENTION_ENABLED: "false",
        PROPERTY_SETUP_DRAFT_RETENTION_INTERVAL_MS: "60000",
        PROPERTY_SETUP_DRAFT_RETENTION_BATCH_SIZE: "25",
      }),
    ).toMatchObject({
      propertySetupDraftRetentionEnabled: false,
      propertySetupDraftRetentionIntervalMs: 60_000,
      propertySetupDraftRetentionBatchSize: 25,
    });
    expect(() => loadConfig({ PROPERTY_SETUP_DRAFT_RETENTION_BATCH_SIZE: "0" })).toThrow(
      "PROPERTY_SETUP_DRAFT_RETENTION_BATCH_SIZE must be a positive integer",
    );
    expect(() => loadConfig({ PROPERTY_SETUP_DRAFT_RETENTION_INTERVAL_MS: "0" })).toThrow(
      "PROPERTY_SETUP_DRAFT_RETENTION_INTERVAL_MS must be a positive integer",
    );
    expect(() => loadConfig({ PROPERTY_SETUP_DRAFT_RETENTION_INTERVAL_MS: "2147483648" })).toThrow(
      "PROPERTY_SETUP_DRAFT_RETENTION_INTERVAL_MS must not exceed 2147483647",
    );
  });

  it("configures and can disable the PMS public-offer retry interval", () => {
    expect(loadConfig({})).toMatchObject({
      pmsInventoryPublicOfferRetryEnabled: true,
      pmsInventoryPublicOfferRetryIntervalMs: 30_000,
    });
    expect(
      loadConfig({
        PMS_INVENTORY_PUBLIC_OFFER_RETRY_ENABLED: "false",
        PMS_INVENTORY_PUBLIC_OFFER_RETRY_INTERVAL_MS: "60000",
      }),
    ).toMatchObject({
      pmsInventoryPublicOfferRetryEnabled: false,
      pmsInventoryPublicOfferRetryIntervalMs: 60_000,
    });
    expect(() => loadConfig({ PMS_INVENTORY_PUBLIC_OFFER_RETRY_INTERVAL_MS: "0" })).toThrow(
      "PMS_INVENTORY_PUBLIC_OFFER_RETRY_INTERVAL_MS must be a positive integer",
    );
  });

  it("loads platform media serving cutover config", () => {
    expect(
      loadConfig({
        PLATFORM_MEDIA_BUCKET: "vayada-media-staging",
        PLATFORM_MEDIA_CDN_BASE_URL: "https://cdn.staging.vayada.com",
        PLATFORM_MEDIA_CDN_ORIGIN_HOST: "vayada-media-staging.s3.us-east-1.amazonaws.com",
      }).platformMediaServing,
    ).toMatchObject({
      bucketName: "vayada-media-staging",
      cdnBaseUrl: "https://cdn.staging.vayada.com",
      cdnOriginHost: "vayada-media-staging.s3.us-east-1.amazonaws.com",
      publicPathPrefix: "media",
      privateDownloadTtlSeconds: 300,
      privateDownloadMaxTtlSeconds: 900,
    });
  });

  it("keeps partial optional platform media config dark", () => {
    expect(
      loadConfig({
        PLATFORM_MEDIA_CDN_BASE_URL: "https://cdn.vayada.com",
      }).platformMediaServing,
    ).toBeUndefined();
  });

  it("rejects partial platform media config for a creator-capable server", () => {
    expect(() =>
      loadConfig({
        ...completeCreatorMarketplaceEnv,
        PLATFORM_MEDIA_BUCKET: undefined,
        PLATFORM_MEDIA_CDN_BASE_URL: "https://cdn.vayada.com",
        PLATFORM_MEDIA_CDN_ORIGIN_HOST: undefined,
      }),
    ).toThrow("Incomplete platform media serving config");
  });

  it("still rejects invalid complete optional platform media config", () => {
    expect(() =>
      loadConfig({
        PLATFORM_MEDIA_BUCKET: "vayada-media-production",
        PLATFORM_MEDIA_CDN_BASE_URL: "http://cdn.vayada.com",
        PLATFORM_MEDIA_CDN_ORIGIN_HOST: "vayada-media-production.s3.us-east-1.amazonaws.com",
      }),
    ).toThrow("PLATFORM_MEDIA_CDN_BASE_URL must be an HTTPS origin");
  });
});
