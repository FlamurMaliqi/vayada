import type {
  LinkedResource,
  PermissionKey,
  ProductEntitlement,
  RequestContext,
} from "@vayada/backend-auth";
import { injectJson } from "@vayada/backend-test";
import type {
  FinanceAffiliateCommissionCommand,
  FinanceAffiliateCommissionRepository,
  FinanceAffiliateCommissionResult,
  FinanceAffiliateCommissionView,
} from "@vayada/domain-finance";
import type { MarketplaceAffiliateAdminRecord } from "@vayada/domain-marketplace";
import Fastify from "fastify";
import { afterEach, describe, expect, it } from "vitest";

import {
  registerFinanceAffiliateCommissionRoutes,
  type FinanceAffiliateCommissionRoutesOptions,
} from "./routes/financeAffiliateCommissions.js";

const propertyId = "12780000-0000-4000-8000-000000000101";
const otherPropertyId = "12780000-0000-4000-8000-000000000102";
const actorUserId = "12780000-0000-4000-8000-000000000103";
const affiliateId = "aff_vay_1278";
const now = "2026-08-13T21:00:00.000Z";

type AuthOptions = {
  permissions?: PermissionKey[];
  entitlements?: ProductEntitlement[];
  links?: LinkedResource[];
};

describe("Finance affiliate commission routes", () => {
  const apps: Array<Awaited<ReturnType<typeof testApp>>> = [];
  afterEach(async () => Promise.all(apps.splice(0).map((app) => app.close())));

  it("reads property defaults and property-scoped affiliate overrides", async () => {
    const ports = fakePorts();
    const app = await testApp(ports);
    apps.push(app);
    const property = await injectJson<FinanceAffiliateCommissionView>(app, {
      method: "GET",
      url: `/api/finance/properties/${propertyId}/affiliate-commission`,
      headers: authHeader,
    });
    const affiliate = await injectJson<FinanceAffiliateCommissionView>(app, {
      method: "GET",
      url: `/api/finance/properties/${propertyId}/affiliates/${affiliateId}/commission`,
      headers: authHeader,
    });

    expect(property.statusCode).toBe(200);
    expect(property.body.defaultPercentageRate).toBe("7.5");
    expect(affiliate.statusCode).toBe(200);
    expect(affiliate.body.overridePercentageRate).toBe("12");
    expect(ports.calls.scope).toEqual([[propertyId, affiliateId]]);
    expect(ports.calls.get).toEqual([[propertyId], [propertyId, affiliateId]]);
  });

  it("sends default and nullable override commands with server-owned audit fields", async () => {
    const ports = fakePorts();
    const app = await testApp(ports);
    apps.push(app);
    await injectJson(app, {
      method: "PATCH",
      url: `/api/finance/properties/${propertyId}/affiliate-commission`,
      headers: authHeader,
      payload: { commandId: "default-command", idempotencyKey: "default-key", percentageRate: "8" },
    });
    await injectJson(app, {
      method: "PATCH",
      url: `/api/finance/properties/${propertyId}/affiliates/${affiliateId}/commission`,
      headers: authHeader,
      payload: {
        commandId: "override-command",
        idempotencyKey: "override-key",
        percentageRate: null,
      },
    });

    expect(ports.calls.set).toEqual([
      {
        propertyId,
        affiliateId: null,
        commandId: "default-command",
        idempotencyKey: "default-key",
        percentageRate: "8",
        actorUserId,
        occurredAt: now,
      },
      {
        propertyId,
        affiliateId,
        commandId: "override-command",
        idempotencyKey: "override-key",
        percentageRate: null,
        actorUserId,
        occurredAt: now,
      },
    ]);
  });

  it("maps idempotency conflicts without hiding the response contract", async () => {
    const app = await testApp(fakePorts({ result: { outcome: "idempotency_conflict" } }));
    apps.push(app);
    const response = await injectJson<{ code: string }>(app, {
      method: "PATCH",
      url: `/api/finance/properties/${propertyId}/affiliate-commission`,
      headers: authHeader,
      payload: { commandId: "command", idempotencyKey: "key", percentageRate: "8" },
    });
    expect(response.statusCode).toBe(409);
    expect(response.body.code).toBe("idempotency_conflict");
  });

  it.each([
    { percentageRate: null, code: "invalid_percentage_rate" },
    { percentageRate: "100.0001", code: "invalid_percentage_rate" },
    { percentageRate: "10.12345", code: "invalid_percentage_rate" },
  ])("rejects invalid default rate $percentageRate", async ({ percentageRate, code }) => {
    const ports = fakePorts();
    const app = await testApp(ports);
    apps.push(app);
    const response = await injectJson<{ code: string }>(app, {
      method: "PATCH",
      url: `/api/finance/properties/${propertyId}/affiliate-commission`,
      headers: authHeader,
      payload: { commandId: "command", idempotencyKey: "key", percentageRate },
    });
    expect(response.statusCode).toBe(422);
    expect(response.body.code).toBe(code);
    expect(ports.calls.set).toEqual([]);
  });

  it.each([
    { name: "without authentication", headers: {}, auth: {}, status: 401, code: "unauthenticated" },
    {
      name: "without permission",
      headers: authHeader,
      auth: { permissions: ["pms.finance.read" as PermissionKey] },
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
      auth: { entitlements: [financeEntitlement("suspended")] },
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
  ])("denies commission reads $name", async ({ headers, auth, status, code }) => {
    const ports = fakePorts();
    const app = await testApp(ports, auth);
    apps.push(app);
    const response = await injectJson<{ code: string }>(app, {
      method: "GET",
      url: `/api/finance/properties/${propertyId}/affiliate-commission`,
      headers,
    });
    expect(response.statusCode).toBe(status);
    expect(response.body.code).toBe(code);
    expect(ports.calls.get).toEqual([]);
  });

  it("accepts the PMS property-management entitlement", async () => {
    const app = await testApp(fakePorts(), {
      entitlements: [{ product: "pms", key: "property-management", status: "active" }],
    });
    apps.push(app);
    const response = await app.inject({
      method: "GET",
      url: `/api/finance/properties/${propertyId}/affiliate-commission`,
      headers: authHeader,
    });
    expect(response.statusCode).toBe(200);
  });

  it("returns not found before Finance reads an affiliate from another property", async () => {
    const ports = fakePorts({ affiliate: null });
    const app = await testApp(ports);
    apps.push(app);
    const response = await injectJson<{ code: string }>(app, {
      method: "GET",
      url: `/api/finance/properties/${propertyId}/affiliates/other-affiliate/commission`,
      headers: authHeader,
    });
    expect(response.statusCode).toBe(404);
    expect(response.body.code).toBe("affiliate_not_found");
    expect(ports.calls.get).toEqual([]);
  });
});

type FakePorts = FinanceAffiliateCommissionRoutesOptions & {
  calls: { get: unknown[]; set: FinanceAffiliateCommissionCommand[]; scope: unknown[] };
};

function fakePorts(
  options: {
    result?: FinanceAffiliateCommissionResult;
    affiliate?: MarketplaceAffiliateAdminRecord | null;
  } = {},
): FakePorts {
  const calls: FakePorts["calls"] = { get: [], set: [], scope: [] };
  return {
    calls,
    repository: {
      async getCommission(...input) {
        calls.get.push(input);
        return commissionView(input[1] ?? null);
      },
      async setCommission(command) {
        calls.set.push(command);
        return (
          options.result ?? {
            outcome: "applied",
            commandId: command.commandId,
            commission: commissionView(command.affiliateId),
          }
        );
      },
    } satisfies FinanceAffiliateCommissionRepository,
    affiliateScope: {
      async getAffiliate(...input) {
        calls.scope.push(input);
        return options.affiliate === undefined ? affiliateRecord() : options.affiliate;
      },
    },
    now: () => new Date(now),
  };
}

async function testApp(ports: FakePorts, auth: AuthOptions = {}) {
  const app = Fastify({ logger: false });
  app.decorateRequest("authContext", null);
  app.addHook("onRequest", async (request) => {
    if (request.headers.authorization !== "Bearer valid-token") return;
    request.authContext = {
      actor: { internalUserId: actorUserId },
      selectedOrganization: { organizationId: "org-vay-1278", kind: "hotel_group" },
      membership: { permissions: auth.permissions ?? ["pms.finance.manage"] },
      entitlements: auth.entitlements ?? [financeEntitlement()],
      linkedResources: auth.links ?? [propertyLink(propertyId)],
    } as RequestContext;
  });
  await app.register(registerFinanceAffiliateCommissionRoutes, {
    prefix: "/api/finance",
    ...ports,
  });
  return app;
}

function commissionView(targetAffiliateId: string | null): FinanceAffiliateCommissionView {
  return {
    contractVersion: "finance-affiliate-commission.v1",
    propertyId,
    affiliateId: targetAffiliateId,
    defaultPercentageRate: "7.5",
    overridePercentageRate: targetAffiliateId ? "12" : null,
    effectivePercentageRate: targetAffiliateId ? "12" : "7.5",
    updatedAt: now,
  };
}

function affiliateRecord(): MarketplaceAffiliateAdminRecord {
  return {
    contractVersion: "marketplace-affiliate-admin.v1",
    affiliateId,
    propertyId,
    referralCode: "VAY1278",
    displayName: "Ada Affiliate",
    contactEmail: "ada@example.test",
    socialMedia: null,
    affiliateType: "creator",
    lifecycleStatus: "approved",
    applicationSource: "collaboration",
    appliedAt: now,
    updatedAt: now,
  };
}

function financeEntitlement(status: ProductEntitlement["status"] = "active"): ProductEntitlement {
  return { product: "booking", key: "direct-booking-finance", status };
}

function propertyLink(resourceId: string): LinkedResource {
  return {
    product: "hotel_catalog",
    resourceType: "property",
    resourceId,
    relationship: "finance_manager",
    status: "active",
  };
}

const authHeader = { authorization: "Bearer valid-token" };
