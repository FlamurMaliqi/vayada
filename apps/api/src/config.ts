import { loadServerConfig } from "@vayada/backend-config";
import { createHmac } from "node:crypto";

import {
  loadPlatformMediaServingConfig,
  type PlatformMediaServingConfig,
} from "./platform/mediaServing.js";

export type ApiAuthConfig = {
  databaseUrl: string;
  workosJwksUrl: string;
  workosIssuer: string;
  workosAudience: string;
};

export type ApiAuthSurface =
  | "platform-admin"
  | "booking-admin"
  | "pms-web"
  | "affiliate-dashboard"
  | "marketplace-web";

export type ApiAuthSessionConfig = {
  workosClientId: string;
  workosApiKey: string;
  workosWebhookSecret?: string;
  authCookieSecret: string;
  oauthStateSecret: string;
  authLogoutUrl: string;
  authAllowedOrigins: string[];
  authCompatibilityCallbackOrigin: string;
  authSurfaceOrigins: Record<ApiAuthSurface, string>;
  authFirstPartySurfaces: ApiAuthSurface[];
  authCookieSecure: boolean;
  authCookieDomain?: string;
  authLegacyMarketplaceJwtSecret?: string;
  authBookingAdminLogoutUrl?: string;
  authLegacyBookingJwtSecret?: string;
  authPmsWebLogoutUrl?: string;
  authLegacyPmsJwtSecret?: string;
  authAffiliateDashboardLogoutUrl?: string;
  authLegacyAffiliatePmsJwtSecret?: string;
  authMarketplaceWebLogoutUrl?: string;
};

export type PublicHotelProfileSource = "legacy" | "target";
export type BookingDomainResolutionSource = "legacy" | "target";
export type PublicBookabilitySource = "legacy" | "target";
export type MarketplaceAdminSource = "disabled" | "target";
export type BookingCheckoutCommandSource = "legacy_proxy" | "target";
export type PmsOperationsSource = "disabled" | "target";
export type FinanceSource = "legacy" | "target";
export type BookingWebEventSink = "disabled" | "target";
export type ProviderWebhookIntakeMode = "observe_only" | "mutating" | "ack_only_with_receipt";
export type ApiRuntime = "legacy" | "next";

export type ProviderWebhookConfig = {
  stripeSecret?: string;
  xenditSecret?: string;
  channexSecret?: string;
  stripeMode: ProviderWebhookIntakeMode;
  xenditMode: ProviderWebhookIntakeMode;
  channexMode: ProviderWebhookIntakeMode;
};

export type ChannexManagementMode = "observe_only" | "mutating";
export type ChannexManagementConfig = {
  apiBaseUrl?: string;
  apiKey?: string;
  workerEnabled: boolean;
  capabilityModes: {
    connection: ChannexManagementMode;
    provisioning: ChannexManagementMode;
    ariSync: ChannexManagementMode;
    bookingSync: ChannexManagementMode;
    markups: ChannexManagementMode;
    messaging: ChannexManagementMode;
    iframe: ChannexManagementMode;
  };
};

export type StripeSubscriptionConfig = {
  secretKey?: string;
  fixedPlanPriceId?: string;
  bookingAdminBaseUrl: string;
};

export type BookingEmailDeliveryConfig = {
  provider: "resend";
  apiKey: string;
  from: string;
};

export function stripeSubscriptionRuntimeEnabled(
  config: Pick<
    ApiConfig,
    "bookingCheckoutCommandSource" | "financeSource" | "providerWebhooks" | "stripeSubscriptions"
  >,
): boolean {
  return (
    config.financeSource === "target" &&
    config.bookingCheckoutCommandSource === "target" &&
    Boolean(config.stripeSubscriptions.secretKey) &&
    Boolean(config.providerWebhooks.stripeSecret) &&
    config.providerWebhooks.stripeMode === "mutating"
  );
}

export type CreatorPlatformConnectionsConfig = {
  callbackBaseUrl: string;
  webReturnUrl: string;
  credentialVault:
    | { provider: "aws-secrets-manager"; secretPrefix: string; region?: string }
    | { provider: "memory"; secretPrefix: string };
  instagram?: {
    clientId: string;
    clientSecret: string;
    apiVersion: string;
  };
  facebook?: {
    clientId: string;
    clientSecret: string;
    apiVersion: string;
  };
  tiktok?: {
    clientKey: string;
    clientSecret: string;
  };
  youtube?: {
    clientId: string;
    clientSecret: string;
  };
};

export type ApiConfig = {
  host: string;
  port: number;
  apiRuntime: ApiRuntime;
  auth?: ApiAuthConfig;
  authSession?: ApiAuthSessionConfig;
  targetDatabaseUrl?: string;
  bookingDatabaseUrl?: string;
  bookingReservationsSource: "legacy" | "target";
  publicHotelProfileSource: PublicHotelProfileSource;
  bookingDomainResolutionSource: BookingDomainResolutionSource;
  publicBookabilitySource: PublicBookabilitySource;
  bookingSettingsSource: "legacy" | "target";
  bookingReservationsReadDatabaseUrl?: string;
  marketplaceAdminSource: MarketplaceAdminSource;
  marketplaceAdminLegacySuperadminFallbackEnabled: boolean;
  pmsOperationsSource: PmsOperationsSource;
  financeSource: FinanceSource;
  marketplaceDiscoveryAllowedOrigins: string[];
  affiliatePublicSource?: "target";
  pmsOperationsAllowedOrigins: string[];
  bookingCheckoutCommandSource: BookingCheckoutCommandSource;
  bookingWebEventSink: BookingWebEventSink;
  bookingHostBase?: string;
  platformMediaServing?: PlatformMediaServingConfig;
  platformMediaCleanupEnabled: boolean;
  platformMediaCleanupIntervalMs: number;
  propertySetupDraftRetentionEnabled: boolean;
  propertySetupDraftRetentionIntervalMs: number;
  propertySetupDraftRetentionBatchSize: number;
  pmsInventoryPublicOfferRetryEnabled: boolean;
  pmsInventoryPublicOfferRetryIntervalMs: number;
  creatorPlatformConnections?: CreatorPlatformConnectionsConfig;
  providerWebhooks: ProviderWebhookConfig;
  channexManagement: ChannexManagementConfig;
  stripeSubscriptions: StripeSubscriptionConfig;
  bookingEmailDelivery?: BookingEmailDeliveryConfig;
  xenditSecretKey?: string;
};

const NEXT_API_FORBIDDEN_LEGACY_ENV_KEYS = [
  "BOOKING_DATABASE_URL",
  "BOOKING_RESERVATIONS_READ_DATABASE_URL",
] as const;

const REMOVED_LEGACY_PYTHON_INTEGRATION_ENV_KEYS = [
  "BOOKING_PUBLIC_API_URL",
  "PMS_API_URL",
  "PMS_PUBLIC_API_URL",
] as const;

type NextRuntimeSourceRequirement = {
  key: string;
  value: string;
  allowExplicitDisabled?: boolean;
};

function readOptionalEnv(env: NodeJS.ProcessEnv, key: string): string | undefined {
  const value = env[key]?.trim();
  return value ? value : undefined;
}

function derivePurposeSecret(secret: string, purpose: string): string {
  return createHmac("sha256", secret).update(purpose).digest("base64url");
}

function normalizePgConnectionString(connectionString: string): string {
  try {
    const url = new URL(connectionString);
    if (!["postgres:", "postgresql:"].includes(url.protocol)) {
      return connectionString;
    }

    if (url.searchParams.get("sslmode") !== "require" || url.searchParams.has("uselibpqcompat")) {
      return connectionString;
    }

    url.searchParams.set("uselibpqcompat", "true");
    return url.toString();
  } catch {
    return connectionString;
  }
}

function readOptionalPgConnectionEnv(env: NodeJS.ProcessEnv, key: string): string | undefined {
  const value = readOptionalEnv(env, key);
  return value ? normalizePgConnectionString(value) : undefined;
}

function loadAuthConfig(env: NodeJS.ProcessEnv): ApiAuthConfig | undefined {
  const authKeys = [
    "AUTH_DATABASE_URL",
    "WORKOS_JWKS_URL",
    "WORKOS_ISSUER",
    "WORKOS_AUDIENCE",
  ] as const;
  const values = Object.fromEntries(authKeys.map((key) => [key, readOptionalEnv(env, key)]));
  const configuredKeys = authKeys.filter((key) => values[key]);

  if (configuredKeys.length === 0) {
    return undefined;
  }

  if (configuredKeys.length !== authKeys.length) {
    const missing = authKeys.filter((key) => !values[key]).join(", ");
    throw new Error(`Incomplete auth config; missing ${missing}`);
  }

  return {
    databaseUrl: normalizePgConnectionString(values["AUTH_DATABASE_URL"]!),
    workosJwksUrl: values["WORKOS_JWKS_URL"]!,
    workosIssuer: values["WORKOS_ISSUER"]!,
    workosAudience: values["WORKOS_AUDIENCE"]!,
  };
}

function readOptionalCsvEnv(
  env: NodeJS.ProcessEnv,
  key: string,
  defaultValue: string[] = [],
): string[] {
  const value = readOptionalEnv(env, key);
  return value
    ? value
        .split(",")
        .map((entry) => entry.trim())
        .filter(Boolean)
    : defaultValue;
}

const AUTH_SURFACE_ORIGIN_KEYS = {
  "platform-admin": "AUTH_PLATFORM_ADMIN_ORIGIN",
  "booking-admin": "AUTH_BOOKING_ADMIN_ORIGIN",
  "pms-web": "AUTH_PMS_WEB_ORIGIN",
  "affiliate-dashboard": "AUTH_AFFILIATE_DASHBOARD_ORIGIN",
  "marketplace-web": "AUTH_MARKETPLACE_WEB_ORIGIN",
} as const satisfies Record<ApiAuthSurface, string>;

const AUTH_SURFACES = Object.keys(AUTH_SURFACE_ORIGIN_KEYS) as ApiAuthSurface[];

function normalizeAuthOrigin(value: string, key: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${key} must be an absolute HTTP(S) origin`);
  }
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  ) {
    throw new Error(`${key} must be an absolute HTTP(S) origin`);
  }
  return url.origin;
}

function readAuthSurfaceList(env: NodeJS.ProcessEnv): ApiAuthSurface[] {
  const surfaces = readOptionalCsvEnv(env, "AUTH_FIRST_PARTY_SURFACES");
  const unsupported = surfaces.filter(
    (surface): surface is string => !AUTH_SURFACES.includes(surface as ApiAuthSurface),
  );
  if (unsupported.length > 0) {
    throw new Error(
      `AUTH_FIRST_PARTY_SURFACES contains unsupported surfaces: ${unsupported.join(", ")}`,
    );
  }
  return [...new Set(surfaces)] as ApiAuthSurface[];
}

function readBooleanEnv(env: NodeJS.ProcessEnv, key: string, defaultValue = false): boolean {
  const value = readOptionalEnv(env, key);
  if (value === undefined) return defaultValue;
  if (/^(1|true|yes)$/i.test(value)) return true;
  if (/^(0|false|no)$/i.test(value)) return false;
  throw new Error(`${key} must be true or false`);
}

function readPositiveIntegerEnv(env: NodeJS.ProcessEnv, key: string, defaultValue: number): number {
  const value = readOptionalEnv(env, key);
  if (value === undefined) return defaultValue;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new Error(`${key} must be a positive integer`);
  }
  return parsed;
}

function readTimerIntervalEnv(env: NodeJS.ProcessEnv, key: string, defaultValue: number): number {
  const value = readPositiveIntegerEnv(env, key, defaultValue);
  if (value > 2_147_483_647) {
    throw new Error(`${key} must not exceed 2147483647`);
  }
  return value;
}

function readSourceEnv<T extends string>(
  env: NodeJS.ProcessEnv,
  key: string,
  allowed: readonly T[],
  defaultValue: T,
): T {
  const value = readOptionalEnv(env, key) ?? defaultValue;
  if ((allowed as readonly string[]).includes(value)) return value as T;
  throw new Error(`${key} must be one of: ${allowed.join(", ")}`);
}

function loadAffiliatePublicSource(env: NodeJS.ProcessEnv): "target" | undefined {
  const value = readOptionalEnv(env, "AFFILIATE_PUBLIC_SOURCE");
  if (!value) {
    return undefined;
  }
  if (value !== "target") {
    throw new Error("Unsupported AFFILIATE_PUBLIC_SOURCE; expected target");
  }
  if (!readOptionalEnv(env, "TARGET_DATABASE_URL")) {
    throw new Error("AFFILIATE_PUBLIC_SOURCE=target requires TARGET_DATABASE_URL");
  }
  return "target";
}

function loadAuthSessionConfig(env: NodeJS.ProcessEnv): ApiAuthSessionConfig | undefined {
  const authSessionKeys = [
    "WORKOS_CLIENT_ID",
    "WORKOS_API_KEY",
    "AUTH_COOKIE_SECRET",
    "AUTH_LOGOUT_URL",
    "AUTH_ALLOWED_ORIGINS",
    "AUTH_COMPATIBILITY_CALLBACK_ORIGIN",
    ...Object.values(AUTH_SURFACE_ORIGIN_KEYS),
  ] as const;
  const values = Object.fromEntries(authSessionKeys.map((key) => [key, readOptionalEnv(env, key)]));
  const configuredKeys = authSessionKeys.filter((key) => values[key]);

  if (configuredKeys.length === 0) {
    return undefined;
  }

  if (configuredKeys.length !== authSessionKeys.length) {
    const missing = authSessionKeys.filter((key) => !values[key]).join(", ");
    throw new Error(`Incomplete auth session config; missing ${missing}`);
  }

  const authAllowedOrigins = readOptionalCsvEnv(env, "AUTH_ALLOWED_ORIGINS").map((origin) =>
    normalizeAuthOrigin(origin, "AUTH_ALLOWED_ORIGINS"),
  );
  const authCompatibilityCallbackOrigin = normalizeAuthOrigin(
    values["AUTH_COMPATIBILITY_CALLBACK_ORIGIN"]!,
    "AUTH_COMPATIBILITY_CALLBACK_ORIGIN",
  );
  const authSurfaceOrigins = Object.fromEntries(
    AUTH_SURFACES.map((surface) => {
      const key = AUTH_SURFACE_ORIGIN_KEYS[surface];
      return [surface, normalizeAuthOrigin(values[key]!, key)];
    }),
  ) as Record<ApiAuthSurface, string>;
  const callbackOrigins = [authCompatibilityCallbackOrigin, ...Object.values(authSurfaceOrigins)];
  const untrustedCallbackOrigins = callbackOrigins.filter(
    (origin) => !authAllowedOrigins.includes(origin),
  );
  if (untrustedCallbackOrigins.length > 0) {
    throw new Error(
      `Auth callback origins must be included in AUTH_ALLOWED_ORIGINS: ${[
        ...new Set(untrustedCallbackOrigins),
      ].join(", ")}`,
    );
  }
  const authFirstPartySurfaces = readAuthSurfaceList(env);
  const authCookieSecure = readOptionalEnv(env, "AUTH_COOKIE_SECURE") !== "false";
  const insecureHttpsSurfaces = authFirstPartySurfaces.filter(
    (surface) => authSurfaceOrigins[surface].startsWith("https://") && !authCookieSecure,
  );
  if (insecureHttpsSurfaces.length > 0) {
    throw new Error(
      `AUTH_COOKIE_SECURE must be true for HTTPS first-party surfaces: ${insecureHttpsSurfaces.join(", ")}`,
    );
  }

  return {
    workosClientId: values["WORKOS_CLIENT_ID"]!,
    workosApiKey: values["WORKOS_API_KEY"]!,
    workosWebhookSecret: readOptionalEnv(env, "WORKOS_WEBHOOK_SECRET"),
    authCookieSecret: values["AUTH_COOKIE_SECRET"]!,
    oauthStateSecret:
      readOptionalEnv(env, "AUTH_OAUTH_STATE_SECRET") ??
      derivePurposeSecret(values["AUTH_COOKIE_SECRET"]!, "vayada.auth.oauth-state.v1"),
    authLogoutUrl: values["AUTH_LOGOUT_URL"]!,
    authAllowedOrigins,
    authCompatibilityCallbackOrigin,
    authSurfaceOrigins,
    authFirstPartySurfaces,
    authCookieSecure,
    authCookieDomain: readOptionalEnv(env, "AUTH_COOKIE_DOMAIN"),
    authLegacyMarketplaceJwtSecret: readOptionalEnv(env, "AUTH_LEGACY_MARKETPLACE_JWT_SECRET"),
    authBookingAdminLogoutUrl: readOptionalEnv(env, "AUTH_BOOKING_ADMIN_LOGOUT_URL"),
    authLegacyBookingJwtSecret: readOptionalEnv(env, "AUTH_LEGACY_BOOKING_JWT_SECRET"),
    authPmsWebLogoutUrl: readOptionalEnv(env, "AUTH_PMS_WEB_LOGOUT_URL"),
    authLegacyPmsJwtSecret: readOptionalEnv(env, "AUTH_LEGACY_PMS_JWT_SECRET"),
    authAffiliateDashboardLogoutUrl: readOptionalEnv(env, "AUTH_AFFILIATE_DASHBOARD_LOGOUT_URL"),
    authLegacyAffiliatePmsJwtSecret: readOptionalEnv(env, "AUTH_LEGACY_AFFILIATE_PMS_JWT_SECRET"),
    authMarketplaceWebLogoutUrl: readOptionalEnv(env, "AUTH_MARKETPLACE_WEB_LOGOUT_URL"),
  };
}

function loadProviderWebhookConfig(env: NodeJS.ProcessEnv): ProviderWebhookConfig {
  return {
    stripeSecret: readOptionalEnv(env, "STRIPE_WEBHOOK_SECRET"),
    xenditSecret: readOptionalEnv(env, "XENDIT_WEBHOOK_SECRET"),
    channexSecret: readOptionalEnv(env, "CHANNEX_WEBHOOK_SECRET"),
    stripeMode: readSourceEnv(
      env,
      "STRIPE_WEBHOOK_INTAKE_MODE",
      ["observe_only", "mutating", "ack_only_with_receipt"],
      "observe_only",
    ),
    xenditMode: readSourceEnv(
      env,
      "XENDIT_WEBHOOK_INTAKE_MODE",
      ["observe_only", "mutating", "ack_only_with_receipt"],
      "observe_only",
    ),
    channexMode: readSourceEnv(
      env,
      "CHANNEX_WEBHOOK_INTAKE_MODE",
      ["observe_only", "mutating", "ack_only_with_receipt"],
      "observe_only",
    ),
  };
}

function loadChannexManagementConfig(env: NodeJS.ProcessEnv): ChannexManagementConfig {
  const mode = (key: string) =>
    readSourceEnv(env, key, ["observe_only", "mutating"] as const, "observe_only");
  const capabilityModes = {
    connection: mode("PMS_CHANNEX_CONNECTION_MODE"),
    provisioning: mode("PMS_CHANNEX_PROVISIONING_MODE"),
    ariSync: mode("PMS_CHANNEX_ARI_SYNC_MODE"),
    bookingSync: mode("PMS_CHANNEX_BOOKING_SYNC_MODE"),
    markups: mode("PMS_CHANNEX_MARKUPS_MODE"),
    messaging: mode("PMS_CHANNEX_MESSAGING_MODE"),
    iframe: mode("PMS_CHANNEX_IFRAME_MODE"),
  };
  const apiBaseUrl = readOptionalEnv(env, "CHANNEX_API_BASE_URL");
  const apiKey = readOptionalEnv(env, "CHANNEX_API_KEY");
  const mutating = Object.values(capabilityModes).includes("mutating");
  const durableCommandsMutating = Object.entries(capabilityModes).some(
    ([capability, value]) => capability !== "iframe" && value === "mutating",
  );
  if (mutating && (!apiBaseUrl || !apiKey)) {
    throw new Error(
      "Mutating PMS Channex capabilities require CHANNEX_API_BASE_URL and CHANNEX_API_KEY",
    );
  }
  const workerEnabled = readBooleanEnv(env, "PMS_CHANNEX_WORKER_ENABLED", durableCommandsMutating);
  if (durableCommandsMutating && !workerEnabled) {
    throw new Error("Mutating PMS Channex capabilities require PMS_CHANNEX_WORKER_ENABLED=true");
  }
  return {
    apiBaseUrl,
    apiKey,
    workerEnabled,
    capabilityModes,
  };
}

function loadStripeSubscriptionConfig(env: NodeJS.ProcessEnv): StripeSubscriptionConfig {
  const bookingAdminBaseUrl =
    readOptionalEnv(env, "BOOKING_ADMIN_BASE_URL") ??
    readOptionalEnv(env, "AUTH_BOOKING_ADMIN_ORIGIN") ??
    "https://admin.booking.localhost";
  let bookingAdminUrl: URL;
  try {
    bookingAdminUrl = new URL(bookingAdminBaseUrl);
  } catch {
    throw new Error("BOOKING_ADMIN_BASE_URL must be an absolute HTTP(S) origin");
  }
  if (
    !["http:", "https:"].includes(bookingAdminUrl.protocol) ||
    bookingAdminUrl.username ||
    bookingAdminUrl.password ||
    bookingAdminUrl.pathname !== "/" ||
    bookingAdminUrl.search ||
    bookingAdminUrl.hash
  ) {
    throw new Error("BOOKING_ADMIN_BASE_URL must be an absolute HTTP(S) origin");
  }
  return {
    secretKey: readOptionalEnv(env, "STRIPE_SECRET_KEY"),
    fixedPlanPriceId: readOptionalEnv(env, "STRIPE_FIXED_PLAN_PRICE_ID"),
    bookingAdminBaseUrl: bookingAdminUrl.origin,
  };
}

function loadCreatorPlatformConnectionsConfig(
  env: NodeJS.ProcessEnv,
): CreatorPlatformConnectionsConfig | undefined {
  const instagram = readCompleteConfigGroup(env, "Instagram creator platform", {
    clientId: "INSTAGRAM_CLIENT_ID",
    clientSecret: "INSTAGRAM_CLIENT_SECRET",
    apiVersion: "INSTAGRAM_API_VERSION",
  });
  const facebook = readCompleteConfigGroup(env, "Facebook creator platform", {
    clientId: "FACEBOOK_CLIENT_ID",
    clientSecret: "FACEBOOK_CLIENT_SECRET",
    apiVersion: "FACEBOOK_GRAPH_API_VERSION",
  });
  const tiktok = readCompleteConfigGroup(env, "TikTok creator platform", {
    clientKey: "TIKTOK_CLIENT_KEY",
    clientSecret: "TIKTOK_CLIENT_SECRET",
  });
  const youtube = readCompleteConfigGroup(env, "YouTube creator platform", {
    clientId: "GOOGLE_YOUTUBE_CLIENT_ID",
    clientSecret: "GOOGLE_YOUTUBE_CLIENT_SECRET",
  });

  if (!instagram && !facebook && !tiktok && !youtube) return undefined;

  const callbackBaseUrl = readOptionalEnv(env, "CREATOR_PLATFORM_CALLBACK_BASE_URL");
  const webReturnUrl = readOptionalEnv(env, "CREATOR_PLATFORM_WEB_RETURN_URL");
  const secretPrefix = readOptionalEnv(env, "CREATOR_PLATFORM_SECRET_PREFIX");
  const vaultProvider =
    readOptionalEnv(env, "CREATOR_PLATFORM_CREDENTIAL_VAULT") ?? "aws-secrets-manager";
  const missing = [
    !callbackBaseUrl && "CREATOR_PLATFORM_CALLBACK_BASE_URL",
    !webReturnUrl && "CREATOR_PLATFORM_WEB_RETURN_URL",
    !secretPrefix && "CREATOR_PLATFORM_SECRET_PREFIX",
  ].filter(Boolean);
  if (missing.length > 0) {
    throw new Error(`Incomplete creator platform connection config; missing ${missing.join(", ")}`);
  }
  assertOAuthUrl(callbackBaseUrl!, "CREATOR_PLATFORM_CALLBACK_BASE_URL", env);
  assertOAuthUrl(webReturnUrl!, "CREATOR_PLATFORM_WEB_RETURN_URL", env);
  if (vaultProvider !== "aws-secrets-manager" && vaultProvider !== "memory") {
    throw new Error("CREATOR_PLATFORM_CREDENTIAL_VAULT must be aws-secrets-manager or memory");
  }
  if (vaultProvider === "memory" && env.NODE_ENV === "production") {
    throw new Error("CREATOR_PLATFORM_CREDENTIAL_VAULT=memory is not allowed in production");
  }

  return {
    callbackBaseUrl: callbackBaseUrl!.replace(/\/$/, ""),
    webReturnUrl: webReturnUrl!,
    credentialVault:
      vaultProvider === "memory"
        ? { provider: "memory", secretPrefix: secretPrefix! }
        : {
            provider: "aws-secrets-manager",
            secretPrefix: secretPrefix!,
            region: readOptionalEnv(env, "AWS_REGION"),
          },
    ...(instagram ? { instagram } : {}),
    ...(facebook ? { facebook } : {}),
    ...(tiktok ? { tiktok } : {}),
    ...(youtube ? { youtube } : {}),
  };
}

function loadBookingEmailDeliveryConfig(
  env: NodeJS.ProcessEnv,
): BookingEmailDeliveryConfig | undefined {
  const config = readCompleteConfigGroup(env, "booking email delivery", {
    apiKey: "RESEND_API_KEY",
    from: "BOOKING_EMAIL_FROM",
  });
  return config ? { provider: "resend", ...config } : undefined;
}

function readCompleteConfigGroup<T extends Record<string, string>>(
  env: NodeJS.ProcessEnv,
  label: string,
  keys: T,
): { [K in keyof T]: string } | undefined {
  const entries = Object.entries(keys).map(
    ([property, key]) => [property, readOptionalEnv(env, key), key] as const,
  );
  const configured = entries.filter(([, value]) => Boolean(value));
  if (configured.length === 0) return undefined;
  const missing = entries.filter(([, value]) => !value).map(([, , key]) => key);
  if (missing.length > 0) {
    throw new Error(`Incomplete ${label} config; missing ${missing.join(", ")}`);
  }
  return Object.fromEntries(entries.map(([property, value]) => [property, value!])) as {
    [K in keyof T]: string;
  };
}

function assertOAuthUrl(value: string, key: string, env: NodeJS.ProcessEnv): void {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${key} must be an absolute URL`);
  }
  const localHttp =
    url.protocol === "http:" && ["localhost", "127.0.0.1", "::1"].includes(url.hostname);
  if (url.protocol !== "https:" && !(env.NODE_ENV !== "production" && localHttp)) {
    throw new Error(`${key} must use HTTPS`);
  }
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ApiConfig {
  assertRemovedLegacyPythonIntegrationEnv(env);

  const server = loadServerConfig(env, {
    host: "0.0.0.0",
    port: 8003,
  });
  const apiRuntime = readSourceEnv(env, "API_RUNTIME", ["legacy", "next"], "legacy");
  const targetDatabaseUrl = readOptionalPgConnectionEnv(env, "TARGET_DATABASE_URL");
  const publicHotelProfileSource = readSourceEnv(
    env,
    "PUBLIC_HOTEL_PROFILE_SOURCE",
    ["legacy", "target"],
    "legacy",
  );
  const bookingDomainResolutionSource = readSourceEnv(
    env,
    "BOOKING_DOMAIN_RESOLUTION_SOURCE",
    ["legacy", "target"],
    "legacy",
  );
  const publicBookabilitySource = readSourceEnv(
    env,
    "PUBLIC_BOOKABILITY_SOURCE",
    ["legacy", "target"],
    "legacy",
  );
  const bookingSettingsSource = readSourceEnv(
    env,
    "BOOKING_SETTINGS_SOURCE",
    ["legacy", "target"],
    "legacy",
  );
  const marketplaceAdminSource = readSourceEnv(
    env,
    "MARKETPLACE_ADMIN_SOURCE",
    ["disabled", "target"],
    "disabled",
  );
  const bookingCheckoutCommandSource = readSourceEnv(
    env,
    "BOOKING_CHECKOUT_COMMAND_SOURCE",
    ["legacy_proxy", "target"],
    "legacy_proxy",
  );
  const pmsOperationsSource = readSourceEnv(
    env,
    "PMS_OPERATIONS_SOURCE",
    ["disabled", "target"],
    "disabled",
  );
  const financeSource = readSourceEnv(env, "FINANCE_SOURCE", ["legacy", "target"], "legacy");
  const bookingWebEventSink = readSourceEnv(
    env,
    "BOOKING_WEB_EVENT_SINK",
    ["disabled", "target"],
    "disabled",
  );
  const bookingReservationsSource = readSourceEnv(
    env,
    "BOOKING_RESERVATIONS_SOURCE",
    ["legacy", "target"] as const,
    "legacy",
  );
  const bookingDatabaseUrl = readOptionalPgConnectionEnv(env, "BOOKING_DATABASE_URL");
  const bookingReservationsReadDatabaseUrl = readOptionalPgConnectionEnv(
    env,
    "BOOKING_RESERVATIONS_READ_DATABASE_URL",
  );
  const auth = loadAuthConfig(env);
  const authSession = loadAuthSessionConfig(env);
  const creatorPlatformConnections = loadCreatorPlatformConnectionsConfig(env);
  const bookingEmailDelivery = loadBookingEmailDeliveryConfig(env);
  const platformMediaServing = loadPlatformMediaServingConfig(env, {
    incomplete: targetDatabaseUrl && auth ? "error" : "disabled",
  });
  assertNextApiRuntimeConfig(env, {
    apiRuntime,
    publicHotelProfileSource,
    bookingDomainResolutionSource,
    publicBookabilitySource,
    bookingSettingsSource,
    bookingReservationsSource,
    pmsOperationsSource,
    financeSource,
    bookingCheckoutCommandSource,
  });
  if (bookingSettingsSource === "target" && !targetDatabaseUrl) {
    throw new Error("TARGET_DATABASE_URL is required when BOOKING_SETTINGS_SOURCE=target");
  }
  if (marketplaceAdminSource === "target" && !targetDatabaseUrl) {
    throw new Error("TARGET_DATABASE_URL is required when MARKETPLACE_ADMIN_SOURCE=target");
  }
  if (marketplaceAdminSource === "target" && !auth) {
    throw new Error("MARKETPLACE_ADMIN_SOURCE=target requires complete auth config");
  }
  if (pmsOperationsSource === "target" && !targetDatabaseUrl) {
    throw new Error("TARGET_DATABASE_URL is required when PMS_OPERATIONS_SOURCE=target");
  }
  if (financeSource === "target" && !targetDatabaseUrl) {
    throw new Error("FINANCE_SOURCE=target requires TARGET_DATABASE_URL");
  }
  if (publicHotelProfileSource === "target" && !targetDatabaseUrl) {
    throw new Error("PUBLIC_HOTEL_PROFILE_SOURCE=target requires TARGET_DATABASE_URL");
  }
  if (bookingDomainResolutionSource === "target" && publicHotelProfileSource !== "target") {
    throw new Error(
      "BOOKING_DOMAIN_RESOLUTION_SOURCE=target requires PUBLIC_HOTEL_PROFILE_SOURCE=target",
    );
  }
  if (publicBookabilitySource === "target" && !targetDatabaseUrl) {
    throw new Error("PUBLIC_BOOKABILITY_SOURCE=target requires TARGET_DATABASE_URL");
  }
  if (publicBookabilitySource === "target" && publicHotelProfileSource !== "target") {
    throw new Error("PUBLIC_BOOKABILITY_SOURCE=target requires PUBLIC_HOTEL_PROFILE_SOURCE=target");
  }
  if (bookingWebEventSink === "target" && publicHotelProfileSource !== "target") {
    throw new Error("BOOKING_WEB_EVENT_SINK=target requires PUBLIC_HOTEL_PROFILE_SOURCE=target");
  }
  if (bookingWebEventSink === "target" && !auth) {
    throw new Error("BOOKING_WEB_EVENT_SINK=target requires complete auth config");
  }
  if (bookingCheckoutCommandSource === "target" && !targetDatabaseUrl) {
    throw new Error("BOOKING_CHECKOUT_COMMAND_SOURCE=target requires TARGET_DATABASE_URL");
  }
  if (targetDatabaseUrl && auth && !platformMediaServing) {
    throw new Error(
      "Target Marketplace with complete auth requires complete PLATFORM_MEDIA_* config because creator profile photos are required",
    );
  }
  if (creatorPlatformConnections && (!targetDatabaseUrl || !auth)) {
    throw new Error(
      "Creator platform connections require TARGET_DATABASE_URL and complete auth config",
    );
  }
  if (
    env.NODE_ENV === "production" &&
    bookingCheckoutCommandSource === "target" &&
    !bookingEmailDelivery
  ) {
    throw new Error(
      "BOOKING_CHECKOUT_COMMAND_SOURCE=target requires RESEND_API_KEY and BOOKING_EMAIL_FROM in production",
    );
  }
  const prospectiveConfig = {
    financeSource,
    bookingCheckoutCommandSource,
    stripeSubscriptions: loadStripeSubscriptionConfig(env),
    providerWebhooks: loadProviderWebhookConfig(env),
  };
  const channexManagement = loadChannexManagementConfig(env);
  if (
    Object.values(channexManagement.capabilityModes).includes("mutating") &&
    pmsOperationsSource !== "target"
  ) {
    throw new Error("Mutating PMS Channex capabilities require PMS_OPERATIONS_SOURCE=target");
  }
  if (
    env.NODE_ENV === "production" &&
    bookingCheckoutCommandSource === "target" &&
    !stripeSubscriptionRuntimeEnabled(prospectiveConfig)
  ) {
    throw new Error(
      "BOOKING_CHECKOUT_COMMAND_SOURCE=target requires STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET, STRIPE_WEBHOOK_INTAKE_MODE=mutating, and FINANCE_SOURCE=target in production",
    );
  }

  return {
    ...server,
    apiRuntime,
    auth,
    authSession,
    targetDatabaseUrl,
    bookingDatabaseUrl,
    bookingReservationsSource,
    publicHotelProfileSource,
    bookingDomainResolutionSource,
    publicBookabilitySource,
    bookingSettingsSource,
    bookingReservationsReadDatabaseUrl,
    marketplaceAdminSource,
    marketplaceAdminLegacySuperadminFallbackEnabled: readBooleanEnv(
      env,
      "MARKETPLACE_ADMIN_LEGACY_SUPERADMIN_FALLBACK_ENABLED",
    ),
    pmsOperationsSource,
    financeSource,
    marketplaceDiscoveryAllowedOrigins: readOptionalCsvEnv(
      env,
      "MARKETPLACE_DISCOVERY_ALLOWED_ORIGINS",
    ),
    affiliatePublicSource: loadAffiliatePublicSource(env),
    pmsOperationsAllowedOrigins: readOptionalCsvEnv(env, "PMS_OPERATIONS_ALLOWED_ORIGINS", [
      "https://pms.localhost",
      "https://admin.booking.localhost",
      "https://marketplace.localhost",
    ]),
    bookingCheckoutCommandSource,
    bookingWebEventSink,
    bookingHostBase: readOptionalEnv(env, "BOOKING_HOST_BASE"),
    platformMediaServing,
    platformMediaCleanupEnabled: readBooleanEnv(env, "PLATFORM_MEDIA_CLEANUP_ENABLED", true),
    platformMediaCleanupIntervalMs: readPositiveIntegerEnv(
      env,
      "PLATFORM_MEDIA_CLEANUP_INTERVAL_MS",
      15 * 60 * 1000,
    ),
    propertySetupDraftRetentionEnabled: readBooleanEnv(
      env,
      "PROPERTY_SETUP_DRAFT_RETENTION_ENABLED",
      true,
    ),
    propertySetupDraftRetentionIntervalMs: readTimerIntervalEnv(
      env,
      "PROPERTY_SETUP_DRAFT_RETENTION_INTERVAL_MS",
      60 * 60 * 1000,
    ),
    propertySetupDraftRetentionBatchSize: readPositiveIntegerEnv(
      env,
      "PROPERTY_SETUP_DRAFT_RETENTION_BATCH_SIZE",
      100,
    ),
    pmsInventoryPublicOfferRetryEnabled: readBooleanEnv(
      env,
      "PMS_INVENTORY_PUBLIC_OFFER_RETRY_ENABLED",
      true,
    ),
    pmsInventoryPublicOfferRetryIntervalMs: readPositiveIntegerEnv(
      env,
      "PMS_INVENTORY_PUBLIC_OFFER_RETRY_INTERVAL_MS",
      30_000,
    ),
    creatorPlatformConnections,
    providerWebhooks: prospectiveConfig.providerWebhooks,
    channexManagement,
    stripeSubscriptions: prospectiveConfig.stripeSubscriptions,
    bookingEmailDelivery,
    xenditSecretKey: readOptionalEnv(env, "XENDIT_SECRET_KEY"),
  };
}

function assertRemovedLegacyPythonIntegrationEnv(env: NodeJS.ProcessEnv): void {
  const configured = REMOVED_LEGACY_PYTHON_INTEGRATION_ENV_KEYS.filter((key) =>
    Boolean(readOptionalEnv(env, key)),
  );
  if (configured.length > 0) {
    throw new Error(
      `apps/api no longer supports legacy Python integration envs: ${configured.join(", ")}`,
    );
  }
}

function assertNextApiRuntimeConfig(
  env: NodeJS.ProcessEnv,
  config: Pick<
    ApiConfig,
    | "apiRuntime"
    | "publicHotelProfileSource"
    | "bookingDomainResolutionSource"
    | "publicBookabilitySource"
    | "bookingSettingsSource"
    | "bookingReservationsSource"
    | "pmsOperationsSource"
    | "financeSource"
    | "bookingCheckoutCommandSource"
  >,
): void {
  if (config.apiRuntime !== "next") return;

  const forbiddenEnvKeys = NEXT_API_FORBIDDEN_LEGACY_ENV_KEYS.filter((key) =>
    Boolean(readOptionalEnv(env, key)),
  );
  if (forbiddenEnvKeys.length > 0) {
    throw new Error(`API_RUNTIME=next forbids legacy runtime envs: ${forbiddenEnvKeys.join(", ")}`);
  }

  const requiredTargetSources = [
    { key: "PUBLIC_HOTEL_PROFILE_SOURCE", value: config.publicHotelProfileSource },
    { key: "BOOKING_DOMAIN_RESOLUTION_SOURCE", value: config.bookingDomainResolutionSource },
    { key: "PUBLIC_BOOKABILITY_SOURCE", value: config.publicBookabilitySource },
    { key: "BOOKING_SETTINGS_SOURCE", value: config.bookingSettingsSource },
    { key: "BOOKING_RESERVATIONS_SOURCE", value: config.bookingReservationsSource },
    {
      key: "PMS_OPERATIONS_SOURCE",
      value: config.pmsOperationsSource,
      allowExplicitDisabled: true,
    },
    { key: "FINANCE_SOURCE", value: config.financeSource },
    { key: "BOOKING_CHECKOUT_COMMAND_SOURCE", value: config.bookingCheckoutCommandSource },
  ].flatMap((source) => nextRuntimeSourceRequirements(env, source));

  if (requiredTargetSources.length > 0) {
    throw new Error(
      `API_RUNTIME=next requires target runtime sources: ${requiredTargetSources.join(", ")}`,
    );
  }
}

function nextRuntimeSourceRequirements(
  env: NodeJS.ProcessEnv,
  source: NextRuntimeSourceRequirement,
): string[] {
  if (source.value === "target") return [];
  if (
    source.allowExplicitDisabled &&
    source.value === "disabled" &&
    readOptionalEnv(env, source.key) === "disabled"
  ) {
    return [];
  }
  const suffix = source.allowExplicitDisabled ? "target or explicit disabled" : "target";
  return [`${source.key}=${suffix}`];
}
