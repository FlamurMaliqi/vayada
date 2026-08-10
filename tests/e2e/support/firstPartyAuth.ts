import type { Page, Request, Route } from "@playwright/test";

export type FirstPartyAuthSurface = {
  baseURL: string;
  key: "marketplace" | "bookingAdmin" | "pms" | "affiliate" | "admin";
  label: string;
  surface:
    | "marketplace-web"
    | "booking-admin"
    | "pms-web"
    | "affiliate-dashboard"
    | "platform-admin";
};

const startsPlainServers = process.env.CI === "true" || process.env.E2E_START_SERVERS === "1";
const startsAuthOnlyServers = process.env.E2E_FIRST_PARTY_AUTH_ONLY === "1";

function authBaseURL(
  envName: string,
  plainURL: string,
  authOnlyURL: string,
  portlessURL: string,
): string {
  return (
    process.env[envName] ||
    (startsAuthOnlyServers ? authOnlyURL : startsPlainServers ? plainURL : portlessURL)
  );
}

export const firstPartyAuthSurfaces: FirstPartyAuthSurface[] = [
  {
    baseURL: authBaseURL(
      "E2E_MARKETPLACE_BASE_URL",
      "http://marketplace.localhost:3000",
      "http://marketplace.localhost:3100",
      "https://marketplace.localhost",
    ),
    key: "marketplace",
    label: "Marketplace",
    surface: "marketplace-web",
  },
  {
    baseURL: authBaseURL(
      "E2E_BOOKING_ADMIN_BASE_URL",
      "http://admin.booking.localhost:3003",
      "http://admin.booking.localhost:3103",
      "https://admin.booking.localhost",
    ),
    key: "bookingAdmin",
    label: "Booking Admin",
    surface: "booking-admin",
  },
  {
    baseURL: authBaseURL(
      "E2E_PMS_BASE_URL",
      "http://pms.localhost:3004",
      "http://pms.localhost:3104",
      "https://pms.localhost",
    ),
    key: "pms",
    label: "PMS",
    surface: "pms-web",
  },
  {
    baseURL: authBaseURL(
      "E2E_AFFILIATE_BASE_URL",
      "http://affiliate.localhost:3005",
      "http://affiliate.localhost:3105",
      "https://affiliate.localhost",
    ),
    key: "affiliate",
    label: "Affiliate",
    surface: "affiliate-dashboard",
  },
  {
    baseURL: authBaseURL(
      "E2E_VAYADA_ADMIN_BASE_URL",
      "http://admin.localhost:3001",
      "http://admin.localhost:3101",
      "https://admin.localhost",
    ),
    key: "admin",
    label: "Vayada Admin",
    surface: "platform-admin",
  },
];

export type AuthRequestRecord = {
  body: unknown;
  cookie: string | undefined;
  csrf: string | undefined;
  method: string;
  url: string;
};

export type AuthRouteOverride = (
  route: Route,
  record: AuthRequestRecord,
) => Promise<boolean> | boolean;

export async function mockFirstPartyAuth(
  page: Page,
  surface: FirstPartyAuthSurface,
  override?: AuthRouteOverride,
): Promise<AuthRequestRecord[]> {
  const records: AuthRequestRecord[] = [];
  await page.route(`${surface.baseURL}/auth/**`, async (route) => {
    const request = route.request();
    const record = authRequestRecord(request);
    records.push(record);
    if (override && (await override(route, record))) return;

    const url = new URL(request.url());
    if (url.pathname === "/auth/logout") {
      await route.fulfill({
        status: 200,
        headers: {
          "cache-control": "private, no-store",
          "content-type": "application/json",
          "set-cookie": `${sessionCookieName(surface)}=; Path=/auth; HttpOnly; SameSite=Lax; Max-Age=0`,
          vary: "Cookie",
        },
        json: { logoutUrl: `${surface.baseURL}/login` },
      });
      return;
    }

    if (
      url.pathname === "/auth/password/login" ||
      url.pathname === "/auth/password/signup" ||
      url.pathname === "/auth/session/refresh" ||
      url.pathname === "/auth/session"
    ) {
      await route.fulfill({
        status: 200,
        headers: {
          "cache-control": "private, no-store",
          "content-type": "application/json",
          ...(url.pathname.startsWith("/auth/password/")
            ? {
                "set-cookie": `${sessionCookieName(surface)}=sealed-${surface.key}; Path=/auth; HttpOnly; SameSite=Lax`,
              }
            : {}),
          vary: "Cookie",
        },
        json: authSession(surface),
      });
      return;
    }

    if (
      url.pathname === "/auth/password/reset/request" ||
      url.pathname === "/auth/password/reset/confirm" ||
      url.pathname === "/auth/email-verification/confirm" ||
      url.pathname === "/auth/email-verification/resend"
    ) {
      await route.fulfill({ status: 200, json: { message: "ok" } });
      return;
    }

    await route.fulfill({ status: 404, json: { error: "unexpected_auth_request" } });
  });
  return records;
}

export function authSession(surface: FirstPartyAuthSurface, userType?: "creator" | "hotel") {
  return {
    accessToken: `access-${surface.key}`,
    csrfToken: `csrf-${surface.key}`,
    organizationId: "11111111-1111-4111-8111-111111111111",
    organizationKind: userType === "creator" ? "creator_workspace" : "hotel_group",
    resources: {
      "booking:booking_hotel": ["hotel-e2e"],
      "platform:platform_admin": ["platform-e2e"],
      "pms:pms_property": ["property-e2e"],
    },
    user: {
      email: `${surface.key}@example.test`,
      id: `user-${surface.key}`,
      name: "Auth Regression",
      status: "active",
      ...(userType ? { type: userType } : {}),
    },
    workosOrganizationId: "org_workos_e2e",
  };
}

export function authRequests(records: AuthRequestRecord[], pathname: string): AuthRequestRecord[] {
  return records.filter((record) => new URL(record.url).pathname === pathname);
}

export function sessionCookieName(surface: FirstPartyAuthSurface): string {
  void surface;
  return "vayada_fp_workos_session";
}

function authRequestRecord(request: Request): AuthRequestRecord {
  let body: unknown = null;
  try {
    body = request.postDataJSON();
  } catch {
    body = request.postData();
  }
  return {
    body,
    cookie: request.headers().cookie,
    csrf: request.headers()["x-vayada-csrf"],
    method: request.method(),
    url: request.url(),
  };
}
