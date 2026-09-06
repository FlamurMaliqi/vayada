import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { expect, test, type TestInfo } from "@playwright/test";

const apps = [
  { app: "marketplace-web", auth: "services/auth/auth.ts", workflow: "marketplace-web" },
  { app: "booking-admin", auth: "services/auth/index.ts", workflow: "booking-admin" },
  { app: "pms-web", auth: "services/auth/index.ts", workflow: "pms-web" },
  { app: "vayada-admin", auth: "services/auth/auth.ts", workflow: "vayada-admin" },
] as const;

test("production auth stays on /auth and gateway upstreams remain server-only", async ({}, testInfo) => {
  const root = repositoryRoot(testInfo);
  for (const { app, auth, workflow } of apps) {
    const [authSource, gatewaySource, nextConfig, workflowSource] = await Promise.all([
      source(root, `apps/${app}/${auth}`),
      source(root, `apps/${app}/app/auth/[...path]/route.ts`),
      source(root, `apps/${app}/next.config.js`),
      source(root, `.github/workflows/deploy-next-${workflow}.yml`),
    ]);

    expect(authSource).toContain('AUTH_BROWSER_BASE_PATH = "/auth"');
    expect(authSource).not.toContain("NEXT_PUBLIC_AUTH_API_URL");
    expect(gatewaySource).toContain("process.env.AUTH_GATEWAY_UPSTREAM_ORIGIN");
    expect(gatewaySource).toContain("process.env.AUTH_PUBLIC_ORIGIN");
    expect(gatewaySource).not.toMatch(/(?:127\.0\.0\.1|localhost):\d+/);
    expect(nextConfig).not.toMatch(/rewrites[\s\S]*source:\s*["'`]\/api/);
    expect(workflowSource).not.toMatch(/AUTH_GATEWAY_UPSTREAM_ORIGIN=.*(?:localhost|127\.0\.0\.1)/);
  }
});

test("ordinary product API clients retain configured service origins", async ({}, testInfo) => {
  const root = repositoryRoot(testInfo);
  const productClients = [
    {
      client: "packages/marketplace-shared/src/api/client.ts",
      env: "NEXT_PUBLIC_API_URL",
      fallback: "https://api.marketplace.localhost",
      workflow: ".github/workflows/deploy-next-marketplace-web.yml",
    },
    {
      client: "apps/booking-admin/services/api/client.ts",
      env: "NEXT_PUBLIC_API_URL",
      fallback: "https://api.localhost",
      workflow: ".github/workflows/deploy-next-booking-admin.yml",
    },
    {
      client: "apps/pms-web/services/api/client.ts",
      env: "NEXT_PUBLIC_AUTH_API_URL",
      fallback: "https://api.booking.localhost",
      workflow: ".github/workflows/deploy-next-pms-web.yml",
    },
    {
      client: "apps/vayada-admin/services/api/client.ts",
      env: "NEXT_PUBLIC_API_URL",
      fallback: "https://api.localhost",
      workflow: ".github/workflows/deploy-next-vayada-admin.yml",
    },
  ] as const;

  for (const { client, env, fallback, workflow } of productClients) {
    const [clientSource, workflowSource] = await Promise.all([
      source(root, client),
      source(root, workflow),
    ]);
    expect(clientSource, `${client} must read ${env}`).toContain(`process.env.${env}`);
    expect(clientSource, `${client} must retain an absolute local fallback`).toContain(fallback);
    expect(clientSource).not.toMatch(
      /(?:API_BASE_URL|apiBaseUrl|baseURL)\s*=\s*["'`]\/(?:api|auth)(?:\/|["'`])/,
    );
    expect(workflowSource).toContain("NEXT_API_URL: https://next-api.vayada.com");
    expect(workflowSource, `${workflow} must inject ${env}`).toContain(
      `${env}=\${{ env.NEXT_API_URL }}`,
    );
  }
});

test("landing production APIs are explicit and consent remains local", async ({}, testInfo) => {
  const root = repositoryRoot(testInfo);
  const [workflowSource, consentSource] = await Promise.all([
    source(root, ".github/workflows/deploy-landing.yml"),
    source(root, "apps/landing/context/CookieConsentContext.tsx"),
  ]);

  expect(workflowSource).toContain("CONTACT_API_URL: https://api.vayada.com");
  expect(workflowSource).toContain("MARKETPLACE_API_URL: https://next-api.vayada.com");
  expect(workflowSource).toContain("NEXT_PUBLIC_VAYADA_API_URL=${{ env.MARKETPLACE_API_URL }}");
  expect(workflowSource).not.toMatch(/NEXT_PUBLIC_[A-Z_]+=.*(?:localhost|127\.0\.0\.1)/);
  expect(consentSource).not.toContain("@/services/api/consent");
});

test("all gateway tests lock down cookies, redirects, cache headers, and unsafe headers", async ({}, testInfo) => {
  const root = repositoryRoot(testInfo);
  for (const { app } of apps) {
    const gatewayTest = await source(root, `apps/${app}/app/auth/[...path]/route.test.ts`);
    for (const contract of [
      "set-cookie",
      "cache-control",
      "vary",
      "location",
      "access-control-allow-origin",
      "x-internal-debug",
      "x-workos-session",
    ]) {
      expect(gatewayTest, `${app} gateway test must cover ${contract}`).toContain(contract);
    }
  }
});

function repositoryRoot(testInfo: TestInfo): string {
  return testInfo.config.configFile
    ? dirname(testInfo.config.configFile)
    : resolve(testInfo.config.rootDir, "../..");
}

async function source(root: string, path: string): Promise<string> {
  return readFile(resolve(root, path), "utf8");
}
