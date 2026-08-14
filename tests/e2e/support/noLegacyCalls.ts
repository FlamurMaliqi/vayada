import type { Page, Request, TestInfo } from "@playwright/test";

type LegacyCallRule = {
  name: string;
  matches: (request: Request, url: URL) => boolean;
};

const legacyProductionHosts = new Set([
  "api.vayada.com",
  "booking-api.vayada.com",
  "pms-api.vayada.com",
]);

const legacyLocalHosts = new Set([
  "api.marketplace.localhost",
  "api.booking.localhost",
  "api.pms.localhost",
]);

const legacyLocalPorts = new Set(["8000", "8001", "8002"]);

const surfaceRules = {
  "marketplace-web-offer-discovery": [
    legacyProductionHostRule(),
    legacyLocalServiceRule(),
    pathRule("/api/marketplace/listings", "retired Marketplace listings route"),
  ],
  "vayada-admin-marketplace-preview": [
    legacyProductionHostRule(),
    legacyLocalServiceRule(),
    pathRule("/admin", "legacy root admin route"),
    pathPrefixRule("/admin/", "legacy root admin route"),
    pathRule("/super-admin", "legacy PMS super-admin route"),
    pathPrefixRule("/super-admin/", "legacy PMS super-admin route"),
    headerRule("x-hotel-id", "legacy X-Hotel-Id routing header"),
  ],
  "vayada-admin-hotel-invites": [
    legacyProductionHostRule(),
    legacyLocalServiceRule(),
    pathPrefixRule("/admin/invite-codes", "legacy Marketplace Admin invite route"),
    pathPrefixRule("/api/invite-codes", "legacy hotel invite lookup and redeem route"),
  ],
  "vayada-admin-affiliate-payouts": [
    legacyProductionHostRule(),
    legacyLocalServiceRule(),
    pathPrefixRule(
      "/super-admin/affiliate-payouts",
      "legacy PMS Platform Admin affiliate payout route",
    ),
  ],
  "marketplace-web-hotel-invites": [
    legacyProductionHostRule(),
    legacyLocalServiceRule(),
    pathPrefixRule("/admin/invite-codes", "legacy Marketplace Admin invite route"),
    pathPrefixRule("/api/invite-codes", "legacy hotel invite lookup and redeem route"),
  ],
  "booking-admin-benefits-settings": [
    legacyProductionHostRule(),
    pathRule("/admin/benefits", "legacy Booking Admin benefits route"),
    headerRule(
      "x-hotel-id",
      "legacy X-Hotel-Id routing header",
      /^\/api\/booking\/hotels\/[^/]+\/settings\/benefits$/,
    ),
  ],
  "booking-admin-booking-flow": [
    legacyProductionHostRule(),
    pathPrefixRule("/admin/addons", "legacy Booking Admin add-on item route"),
    pathPrefixRule("/admin/promo-codes", "legacy Booking Admin promo-code route"),
    pathRule("/admin/hotel", "legacy Booking Admin hotel settings route"),
    pathRule("/admin/settings/addons", "legacy Booking Admin add-on settings route"),
    pathRule("/admin/settings/design", "legacy Booking Admin design settings route"),
    pathPrefixRule("/api/hotels/", "legacy public hotel helper route"),
    headerOnPathPrefixRule(
      "/api/booking/hotels/",
      "x-hotel-id",
      "legacy X-Hotel-Id routing header",
    ),
    headerOnPathPrefixRule(
      "/api/pms/properties/",
      "x-hotel-id",
      "legacy X-Hotel-Id routing header",
    ),
  ],
  "booking-admin-settings": [
    legacyProductionHostRule(),
    pathPrefixRule("/admin/settings/custom-domain", "legacy Booking Admin custom-domain route"),
    pathRule("/admin/payment-settings", "legacy Booking Admin payment settings route"),
    pathRule("/admin/room-types", "legacy Booking Admin room-types route"),
    headerOnPathPrefixRule(
      "/api/pms/properties/",
      "x-hotel-id",
      "legacy X-Hotel-Id routing header",
    ),
    headerOnPathPrefixRule(
      "/api/finance/properties/",
      "x-hotel-id",
      "legacy X-Hotel-Id routing header",
    ),
  ],
  "booking-admin-setup": [
    legacyProductionHostRule(),
    pathPrefixRule("/admin/addons", "legacy Booking Admin add-on item route"),
    pathPrefixRule("/admin/promo-codes", "legacy Booking Admin promo-code route"),
    pathRule("/admin/hotel", "legacy Booking Admin hotel settings route"),
    pathRule("/admin/payment-settings", "legacy Booking Admin payment settings route"),
    headerOnPathPrefixRule(
      "/api/finance/properties/",
      "x-hotel-id",
      "legacy X-Hotel-Id routing header",
    ),
  ],
  "pms-web-operations": [
    legacyProductionHostRule(),
    pathRule("/admin/messaging/unread-count", "legacy PMS unread-count route"),
    pathPrefixRule("/admin/bookings", "legacy PMS bookings route"),
    pathRule("/admin/hotel", "legacy PMS property profile route"),
    pathRule("/admin/hotels", "legacy PMS property list route"),
    pathRule("/admin/payment-settings", "legacy PMS payment settings route"),
    pathRule("/admin/calendar", "legacy PMS calendar route"),
    pathRule("/admin/calendar-settings", "legacy PMS calendar settings route"),
    pathPrefixRule("/admin/channex/", "legacy PMS Channex route"),
    headerOnPathPrefixRule(
      "/api/pms/properties/",
      "x-hotel-id",
      "legacy X-Hotel-Id routing header",
    ),
  ],
} satisfies Record<string, LegacyCallRule[]>;

export type NoLegacyCallSurface = keyof typeof surfaceRules;

export function watchNoLegacyCalls(page: Page, testInfo: TestInfo, surface: NoLegacyCallSurface) {
  const failures: string[] = [];
  const rules = surfaceRules[surface];

  page.on("request", (request) => {
    let url: URL;
    try {
      url = new URL(request.url());
    } catch {
      return;
    }

    for (const rule of rules) {
      if (!rule.matches(request, url)) continue;
      failures.push(`${rule.name}: ${request.method()} ${request.url()}`);
    }
  });

  return async () => {
    if (failures.length === 0) return;
    const body = failures.join("\n");
    await testInfo.attach(`${surface}-legacy-calls`, {
      body,
      contentType: "text/plain",
    });
    throw new Error(`No legacy calls guard failed for ${surface}:\n${body}`);
  };
}

function legacyProductionHostRule(): LegacyCallRule {
  return {
    name: "legacy production API host",
    matches: (_request, url) => legacyProductionHosts.has(url.hostname),
  };
}

function legacyLocalServiceRule(): LegacyCallRule {
  return {
    name: "legacy local API service",
    matches: (_request, url) =>
      legacyLocalHosts.has(url.hostname) ||
      ((url.hostname === "localhost" || url.hostname === "127.0.0.1") &&
        legacyLocalPorts.has(url.port)),
  };
}

function pathRule(pathname: string, name: string): LegacyCallRule {
  return {
    name,
    matches: (_request, url) => url.pathname === pathname,
  };
}

function pathPrefixRule(pathnamePrefix: string, name: string): LegacyCallRule {
  return {
    name,
    matches: (_request, url) => url.pathname.startsWith(pathnamePrefix),
  };
}

function headerRule(headerName: string, name: string, pathPattern?: RegExp): LegacyCallRule {
  const normalizedHeaderName = headerName.toLowerCase();
  return {
    name,
    matches: (request) =>
      (!pathPattern || pathPattern.test(new URL(request.url()).pathname)) &&
      Object.entries(request.headers()).some(
        ([candidate, value]) =>
          candidate.toLowerCase() === normalizedHeaderName && value.trim().length > 0,
      ),
  };
}

function headerOnPathPrefixRule(
  pathnamePrefix: string,
  headerName: string,
  name: string,
): LegacyCallRule {
  const header = headerRule(headerName, name);
  return {
    name,
    matches: (request, url) =>
      url.pathname.startsWith(pathnamePrefix) && header.matches(request, url),
  };
}
