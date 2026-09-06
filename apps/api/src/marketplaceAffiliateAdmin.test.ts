import type {
  LinkedResource,
  PermissionKey,
  ProductEntitlement,
  RequestContext,
} from "@vayada/backend-auth";
import { injectJson } from "@vayada/backend-test";
import type { MarketplaceAffiliateAdminRepository } from "@vayada/domain-marketplace";
import Fastify from "fastify";
import { afterEach, describe, expect, it } from "vitest";

import { registerMarketplaceAffiliateAdminRoutes } from "./routes/marketplaceAffiliateAdmin.js";

const propertyId = "12780000-0000-4000-8000-000000000001";
const otherPropertyId = "12780000-0000-4000-8000-000000000002";
const actorUserId = "12780000-0000-4000-8000-000000000003";
const affiliateId = "aff_vay_1278";

type AuthOptions = {
  permissions?: PermissionKey[];
  entitlements?: ProductEntitlement[];
  links?: LinkedResource[];
};

describe("Marketplace affiliate admin routes", () => {
  const apps: Array<Awaited<ReturnType<typeof testApp>>> = [];
  afterEach(async () => Promise.all(apps.splice(0).map((app) => app.close())));

  it.each(["", `/${affiliateId}`, "/affiliate-from-other-property"])(
    "retires administration read %s without accessing affiliate data",
    async (suffix) => {
      const repository = fakeRepository();
      const app = await testApp(repository);
      apps.push(app);
      const response = await app.inject({
        method: "GET",
        url: `/api/marketplace/properties/${propertyId}/affiliates${suffix}`,
        headers: authHeader,
      });
      expect(response.statusCode).toBe(410);
      expect(response.json()).toMatchObject({ code: "affiliate_administration_retired" });
      expect(response.headers["cache-control"]).toBe("no-store");
      expect(repository.calls).toEqual({ get: [] });
    },
  );

  it.each(["approve", "reject", "suspend", "restore"])(
    "retires %s without changing lifecycle state",
    async (action) => {
      const repository = fakeRepository();
      const app = await testApp(repository);
      apps.push(app);
      const response = await app.inject({
        method: "POST",
        url: `/api/marketplace/properties/${propertyId}/affiliates/${affiliateId}/lifecycle`,
        headers: authHeader,
        payload: { commandId: "command", idempotencyKey: "key", action },
      });
      expect(response.statusCode).toBe(410);
      expect(response.json()).toMatchObject({ code: "affiliate_administration_retired" });
      expect(response.headers["cache-control"]).toBe("no-store");
      expect(repository.calls).toEqual({ get: [] });
    },
  );

  it.each([
    { name: "without authentication", headers: {}, auth: {}, status: 401, code: "unauthenticated" },
    {
      name: "with invalid authentication",
      headers: { authorization: "Bearer invalid-token" },
      auth: {},
      status: 401,
      code: "unauthenticated",
    },
    {
      name: "without permission",
      headers: authHeader,
      auth: { permissions: ["marketplace.profile.manage" as PermissionKey] },
      status: 403,
      code: "missing_permission",
    },
    {
      name: "without entitlement",
      headers: authHeader,
      auth: { entitlements: [] },
      status: 403,
      code: "missing_entitlement",
    },
    {
      name: "with inactive entitlement",
      headers: authHeader,
      auth: { entitlements: [entitlement("suspended")] },
      status: 403,
      code: "inactive_entitlement",
    },
    {
      name: "for another property",
      headers: authHeader,
      auth: { links: [propertyLink(otherPropertyId)] },
      status: 403,
      code: "missing_resource_access",
    },
  ])("denies affiliate reads $name", async ({ headers, auth, status, code }) => {
    const repository = fakeRepository();
    const app = await testApp(repository, auth);
    apps.push(app);
    for (const suffix of ["", `/${affiliateId}`]) {
      const response = await injectJson<{ code: string }>(app, {
        method: "GET",
        url: `/api/marketplace/properties/${propertyId}/affiliates${suffix}`,
        headers,
      });
      expect(response.statusCode).toBe(status);
      expect(response.body.code).toBe(code);
    }
    const write = await injectJson(app, {
      method: "POST",
      url: `/api/marketplace/properties/${propertyId}/affiliates/${affiliateId}/lifecycle`,
      headers,
      payload: { action: "approve" },
    });
    expect(write.statusCode).toBe(status);
    expect(repository.calls).toEqual({ get: [] });
  });
});

async function testApp(repository: FakeRepository, auth: AuthOptions = {}) {
  const app = Fastify({ logger: false });
  app.decorateRequest("authContext", null);
  app.addHook("onRequest", async (request) => {
    if (request.headers.authorization !== "Bearer valid-token") return;
    request.authContext = {
      actor: { internalUserId: actorUserId },
      selectedOrganization: { organizationId: "org-vay-1278", kind: "hotel_group" },
      membership: {
        permissions: auth.permissions ?? ["marketplace.affiliate.manage"],
      },
      entitlements: auth.entitlements ?? [entitlement()],
      linkedResources: auth.links ?? [propertyLink(propertyId)],
    } as RequestContext;
  });
  await app.register(registerMarketplaceAffiliateAdminRoutes, {
    prefix: "/api/marketplace",
    repository,
  });
  return app;
}

type FakeRepository = MarketplaceAffiliateAdminRepository & {
  calls: {
    get: unknown[];
  };
};

function fakeRepository(): FakeRepository {
  const calls: FakeRepository["calls"] = { get: [] };
  return {
    calls,
    async getAffiliate(...input) {
      calls.get.push(input);
      return null;
    },
  };
}

function entitlement(status: ProductEntitlement["status"] = "active"): ProductEntitlement {
  return { product: "booking", key: "booking-engine", status };
}

function propertyLink(resourceId: string): LinkedResource {
  return {
    product: "hotel_catalog",
    resourceType: "property",
    resourceId,
    relationship: "owner",
    status: "active",
  };
}

const authHeader = { authorization: "Bearer valid-token" };
