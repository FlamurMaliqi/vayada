import { defineConfig, devices } from "@playwright/test";

const startServers = process.env.CI === "true" || process.env.E2E_START_SERVERS === "1";

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
    ? [
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
            "NEXT_PUBLIC_AUTHKIT_COMPATIBILITY_TOKEN_ENABLED=true PORT=3003 npm run dev:booking-admin",
          url: "http://127.0.0.1:3003",
          reuseExistingServer: !process.env.CI,
          timeout: 120_000,
        },
        {
          command: "PORT=3000 npm run dev:marketplace-web",
          url: "http://127.0.0.1:3000/login?auth=callback",
          reuseExistingServer: !process.env.CI,
          timeout: 120_000,
        },
        {
          command: "PORT=3004 npm run dev:pms-web",
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
  ],
});
