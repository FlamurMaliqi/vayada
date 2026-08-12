import { defineConfig, devices } from "@playwright/test";

const startServers = process.env.CI === "true" || process.env.E2E_START_SERVERS === "1";
const firstPartyAuthOnly = process.env.E2E_FIRST_PARTY_AUTH_ONLY === "1";

const landingBaseURL =
  process.env.E2E_LANDING_BASE_URL ||
  process.env.E2E_BASE_URL ||
  (startServers ? "http://127.0.0.1:3006" : "https://landing.localhost");

const bookingBaseURL =
  process.env.E2E_BOOKING_BASE_URL ||
  (startServers
    ? "http://hotel-alpenrose.booking.localhost:3002"
    : "https://hotel-alpenrose.booking.localhost");

const affiliateDashboardBaseURL =
  process.env.E2E_AFFILIATE_BASE_URL ||
  (startServers ? "http://127.0.0.1:3005" : "https://affiliate.localhost");

const bookingAdminBaseURL =
  process.env.E2E_BOOKING_ADMIN_BASE_URL ||
  (startServers ? "http://127.0.0.1:3003" : "https://admin.booking.localhost");

const marketplaceWebBaseURL =
  process.env.E2E_MARKETPLACE_BASE_URL ||
  (startServers ? "http://127.0.0.1:3000" : "https://marketplace.localhost");

const pmsWebBaseURL =
  process.env.E2E_PMS_BASE_URL ||
  (startServers ? "http://127.0.0.1:3004" : "https://pms.localhost");

const vayadaAdminBaseURL =
  process.env.E2E_VAYADA_ADMIN_BASE_URL ||
  (startServers ? "http://127.0.0.1:3001" : "https://admin.localhost");

const firstPartyAuthServers = [
  {
    command:
      "AUTH_PUBLIC_ORIGIN=http://marketplace.localhost:3100 AUTH_GATEWAY_UPSTREAM_ORIGIN=http://127.0.0.1:8003 NEXT_PUBLIC_AUTHKIT_LOGIN_ENABLED=true PORT=3100 npm run dev:marketplace-web",
    url: "http://127.0.0.1:3100/login",
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
  {
    command:
      "AUTH_PUBLIC_ORIGIN=http://admin.booking.localhost:3103 AUTH_GATEWAY_UPSTREAM_ORIGIN=http://127.0.0.1:8003 NEXT_PUBLIC_AUTHKIT_LOGIN_ENABLED=true NEXT_PUBLIC_AUTHKIT_COMPATIBILITY_TOKEN_ENABLED=false PORT=3103 npm run dev:booking-admin",
    url: "http://127.0.0.1:3103/login",
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
  {
    command:
      "AUTH_PUBLIC_ORIGIN=http://pms.localhost:3104 AUTH_GATEWAY_UPSTREAM_ORIGIN=http://127.0.0.1:8003 NEXT_PUBLIC_AUTHKIT_LOGIN_ENABLED=true NEXT_PUBLIC_AUTHKIT_COMPATIBILITY_TOKEN_ENABLED=false PORT=3104 npm run dev:pms-web",
    url: "http://127.0.0.1:3104/login",
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
  {
    command:
      "AUTH_PUBLIC_ORIGIN=http://affiliate.localhost:3105 AUTH_GATEWAY_UPSTREAM_ORIGIN=http://127.0.0.1:8003 PORT=3105 npm run dev:affiliate-dashboard",
    url: "http://127.0.0.1:3105/login",
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
  {
    command:
      "AUTH_PUBLIC_ORIGIN=http://admin.localhost:3101 AUTH_GATEWAY_UPSTREAM_ORIGIN=http://127.0.0.1:8003 NEXT_PUBLIC_AUTHKIT_LOGIN_ENABLED=true NEXT_PUBLIC_AUTHKIT_COMPATIBILITY_TOKEN_ENABLED=false PORT=3101 npm run dev:vayada-admin",
    url: "http://127.0.0.1:3101/login",
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
] as const;

export default defineConfig({
  testDir: "./tests/e2e",
  fullyParallel: true,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  workers: process.env.CI ? 2 : undefined,
  reporter: process.env.CI ? [["github"], ["html", { open: "never" }]] : [["list"], ["html"]],
  expect: {
    timeout: 15_000,
  },
  use: {
    actionTimeout: 10_000,
    trace: process.env.CI ? "on-first-retry" : "retain-on-failure",
    screenshot: "only-on-failure",
    video: "retain-on-failure",
    ignoreHTTPSErrors: true,
  },
  webServer: startServers
    ? firstPartyAuthOnly
      ? [...firstPartyAuthServers]
      : [
          {
            command: "PORT=3006 npm run dev:landing",
            url: "http://127.0.0.1:3006",
            reuseExistingServer: !process.env.CI,
            timeout: 120_000,
          },
          {
            command: "PORT=3002 npm run dev:booking-web",
            url: "http://127.0.0.1:3002",
            reuseExistingServer: !process.env.CI,
            timeout: 120_000,
          },
          {
            command: "PORT=3005 npm run dev:affiliate-dashboard",
            url: "http://127.0.0.1:3005",
            reuseExistingServer: !process.env.CI,
            timeout: 120_000,
          },
          {
            command:
              "NEXT_PUBLIC_AUTHKIT_COMPATIBILITY_TOKEN_ENABLED=true NEXT_PUBLIC_PMS_FRONTEND_URL=http://pms.localhost:3004 NEXT_PUBLIC_MARKETPLACE_URL=http://marketplace.localhost:3000 PORT=3003 npm run dev:booking-admin",
            url: "http://127.0.0.1:3003",
            reuseExistingServer: !process.env.CI,
            timeout: 120_000,
          },
          {
            command:
              "HOTEL_SETUP_ADAPTIVE_SHELL_PREVIEW_ENABLED=true NEXT_PUBLIC_GOOGLE_MAPS_API_KEY=e2e-google-places NEXT_PUBLIC_BOOKING_ADMIN_URL=http://admin.booking.localhost:3003 NEXT_PUBLIC_PMS_URL=http://pms.localhost:3004 PORT=3000 npm run dev:marketplace-web",
            url: "http://127.0.0.1:3000/login?auth=callback",
            reuseExistingServer: !process.env.CI,
            timeout: 120_000,
          },
          {
            command:
              "NEXT_PUBLIC_BOOKING_ADMIN_URL=http://admin.booking.localhost:3003 NEXT_PUBLIC_MARKETPLACE_URL=http://marketplace.localhost:3000 PORT=3004 npm run dev:pms-web",
            url: "http://127.0.0.1:3004",
            reuseExistingServer: !process.env.CI,
            timeout: 120_000,
          },
          {
            command: "PORT=3001 npm run dev:vayada-admin",
            url: "http://127.0.0.1:3001",
            reuseExistingServer: !process.env.CI,
            timeout: 120_000,
          },
        ]
    : undefined,
  projects: [
    {
      name: "landing-chromium",
      testMatch: /landing\/.*\.spec\.ts/,
      use: {
        ...devices["Desktop Chrome"],
        baseURL: landingBaseURL,
      },
    },
    {
      name: "booking-web-chromium",
      testMatch: /booking-web\/.*\.spec\.ts/,
      workers: 1,
      use: {
        ...devices["Desktop Chrome"],
        baseURL: bookingBaseURL,
      },
    },
    {
      name: "affiliate-dashboard-chromium",
      testMatch: /affiliate-dashboard\/.*\.spec\.ts/,
      use: {
        ...devices["Desktop Chrome"],
        baseURL: affiliateDashboardBaseURL,
      },
    },
    {
      name: "booking-admin-chromium",
      testMatch: /booking-admin\/.*\.spec\.ts/,
      use: {
        ...devices["Desktop Chrome"],
        baseURL: bookingAdminBaseURL,
      },
    },
    {
      name: "marketplace-web-chromium",
      testMatch: /marketplace-web\/.*\.spec\.ts/,
      use: {
        ...devices["Desktop Chrome"],
        baseURL: marketplaceWebBaseURL,
      },
    },
    {
      name: "pms-web-chromium",
      testMatch: /pms-web\/.*\.spec\.ts/,
      use: {
        ...devices["Desktop Chrome"],
        baseURL: pmsWebBaseURL,
      },
    },
    {
      name: "vayada-admin-chromium",
      testMatch: /vayada-admin\/.*\.spec\.ts/,
      use: {
        ...devices["Desktop Chrome"],
        baseURL: vayadaAdminBaseURL,
      },
    },
    {
      name: "first-party-auth-chromium",
      testMatch: /first-party-auth\/.*\.spec\.ts/,
      testIgnore: /first-party-auth\/live-workos\.spec\.ts/,
      use: {
        ...devices["Desktop Chrome"],
        launchOptions: {
          args: ["--test-third-party-cookie-phaseout"],
        },
      },
    },
    {
      name: "first-party-auth-live-chromium",
      testMatch: /first-party-auth\/live-workos\.spec\.ts/,
      use: {
        ...devices["Desktop Chrome"],
        launchOptions: {
          args: ["--test-third-party-cookie-phaseout"],
        },
        screenshot: "off",
        trace: "off",
        video: "off",
      },
    },
  ],
});
