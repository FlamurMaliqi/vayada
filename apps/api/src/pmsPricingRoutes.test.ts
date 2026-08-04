import type {
  LinkedResource,
  PermissionKey,
  ProductEntitlement,
  RequestContext,
} from "@vayada/backend-auth";
import { injectJson } from "@vayada/backend-test";
import {
  PMS_PRICING_CONTRACT_VERSION,
  parsePmsDecimalAmount,
  parsePmsPricingCurrency,
  type PmsPricingCurrencyCapabilitiesReadPort,
  type UpsertFlexibleRatePlanCommand,
  type UpsertPropertyPricingCurrencyCommand,
} from "@vayada/domain-pms";
import Fastify from "fastify";
import { afterEach, describe, expect, it } from "vitest";

import { registerPmsPricingRoutes, type PmsPricingRoutesOptions } from "./routes/pmsPricing.js";
import {
  PMS_PRICING_CURRENCY_CAPABILITIES_PORT,
  PMS_PRICING_CURRENCY_CAPABILITIES_V1,
} from "./domains/pmsPricingCurrencyCapabilities.js";

const propertyId = "69000000-0000-4000-8000-000000000001";
const otherPropertyId = "69000000-0000-4000-8000-000000000002";
const roomTypeId = "69000000-0000-4000-8000-000000000003";
const planId = "69000000-0000-4000-8000-000000000004";
const organizationId = "69000000-0000-4000-8000-000000000005";
const actorUserId = "69000000-0000-4000-8000-000000000006";
const now = "2026-08-03T12:00:00.000Z";
const eur = parsePmsPricingCurrency("EUR")!;
const amount = parsePmsDecimalAmount("175.25")!;

type AuthOptions = {
  permissions?: PermissionKey[];
  entitlements?: ProductEntitlement[];
  links?: LinkedResource[];
};

type FakePorts = PmsPricingRoutesOptions & {
  currencyCalls: UpsertPropertyPricingCurrencyCommand[];
  planCalls: UpsertFlexibleRatePlanCommand[];
  reads: Array<readonly unknown[]>;
  capabilityReads: string[];
};

function currencySnapshot(requestPropertyId = propertyId, revision = 1) {
  return {
    contractVersion: PMS_PRICING_CONTRACT_VERSION,
    propertyId: requestPropertyId,
    currency: eur,
    pricingCurrencyRevision: revision,
    createdAt: now,
    updatedAt: now,
  } as const;
}

function planSnapshot(requestPropertyId = propertyId, requestedRoomTypeId = roomTypeId) {
  return {
    contractVersion: PMS_PRICING_CONTRACT_VERSION,
    propertyId: requestPropertyId,
    roomTypeId: requestedRoomTypeId,
    flexibleRatePlanId: planId,
    flexibleRatePlanRevision: 1,
    sourceRoomFactsRevision: 2,
    baseAmount: { amountDecimal: amount, currency: eur },
    cancellationTerms: {
      type: "free_until_days_before_arrival",
      freeCancellationDeadlineDays: 7,
      afterDeadlinePenalty: "full_booking_amount",
      noShowPenalty: "full_booking_amount",
    },
    createdAt: now,
    updatedAt: now,
  } as const;
}

function fakePorts(
  overrides: {
    responsePropertyId?: string;
    missing?: boolean;
    capabilitiesReadPort?: PmsPricingCurrencyCapabilitiesReadPort;
  } = {},
): FakePorts {
  const currencyCalls: UpsertPropertyPricingCurrencyCommand[] = [];
  const planCalls: UpsertFlexibleRatePlanCommand[] = [];
  const reads: Array<readonly unknown[]> = [];
  const capabilityReads: string[] = [];
  const responsePropertyId = overrides.responsePropertyId ?? propertyId;
  return {
    currencyCalls,
    planCalls,
    reads,
    capabilityReads,
    commandPort: {
      async upsertPropertyPricingCurrency(command) {
        currencyCalls.push(command);
        return {
          ok: true,
          response: {
            contractVersion: PMS_PRICING_CONTRACT_VERSION,
            outcome: command.expectedPricingCurrencyRevision === 0 ? "created" : "updated",
            pricingCurrency: {
              ...currencySnapshot(responsePropertyId, command.expectedPricingCurrencyRevision + 1),
              currency: command.currency,
            },
            acceptedAt: now,
          },
        };
      },
      async upsertFlexibleRatePlan(command) {
        planCalls.push(command);
        return {
          ok: true,
          response: {
            contractVersion: PMS_PRICING_CONTRACT_VERSION,
            outcome: command.expectedFlexibleRatePlanRevision === 0 ? "created" : "updated",
            flexibleRatePlan: {
              ...planSnapshot(responsePropertyId, command.roomTypeId),
              flexibleRatePlanRevision: command.expectedFlexibleRatePlanRevision + 1,
              sourceRoomFactsRevision: command.expectedRoomFactsRevision,
              baseAmount: { amountDecimal: command.baseAmountDecimal, currency: eur },
              cancellationTerms: command.cancellationTerms,
            },
            acceptedAt: now,
          },
        };
      },
    },
    readPort: {
      async getPropertyPricingCurrency(requestPropertyId) {
        reads.push(["currency", requestPropertyId]);
        return overrides.missing ? null : currencySnapshot(responsePropertyId);
      },
      async getFlexibleRatePlan(requestPropertyId, requestedRoomTypeId) {
        reads.push(["plan", requestPropertyId, requestedRoomTypeId]);
        return overrides.missing ? null : planSnapshot(responsePropertyId, requestedRoomTypeId);
      },
      async listFlexibleRatePlans(requestPropertyId) {
        reads.push(["plans", requestPropertyId]);
        return overrides.missing ? [] : [planSnapshot(responsePropertyId)];
      },
      async getPricingSourceSnapshot(requestPropertyId) {
        reads.push(["source", requestPropertyId]);
        return overrides.missing
          ? null
          : {
              contractVersion: PMS_PRICING_CONTRACT_VERSION,
              propertyId: responsePropertyId,
              pricingCurrency: currencySnapshot(responsePropertyId),
              flexibleRatePlans: [planSnapshot(responsePropertyId)],
              capturedAt: now,
            };
      },
    },
    currencyCapabilitiesReadPort: overrides.capabilitiesReadPort ?? {
      async getPricingCurrencyCapabilities() {
        capabilityReads.push("capabilities");
        return PMS_PRICING_CURRENCY_CAPABILITIES_PORT.getPricingCurrencyCapabilities();
      },
    },
  };
}

function entitlement(
  status: ProductEntitlement["status"] = "active",
  resourceId = propertyId,
): ProductEntitlement {
  return {
    product: "pms",
    key: "property-management",
    status,
    resource: { product: "pms", resourceType: "pms_property", resourceId },
  };
}

function link(relationship: LinkedResource["relationship"] = "operator"): LinkedResource {
  return {
    product: "pms",
    resourceType: "pms_property",
    resourceId: propertyId,
    relationship,
    status: "active",
  };
}

async function testApp(ports: FakePorts, auth: AuthOptions = {}) {
  const app = Fastify({ logger: false });
  app.decorateRequest("authContext", null);
  app.addHook("onRequest", async (request) => {
    if (request.headers.authorization !== "Bearer valid-token") return;
    request.authContext = {
      actor: { internalUserId: actorUserId },
      selectedOrganization: { organizationId, kind: "hotel_group" },
      membership: {
        permissions: auth.permissions ?? ["pms.operations.read", "pms.operations.manage"],
      },
      linkedResources: auth.links ?? [link()],
      entitlements: auth.entitlements ?? [entitlement()],
      audit: {
        requestId: "request-1",
        correlationId: "correlation-1",
        source: "api",
        receivedAt: now,
      },
    } as RequestContext;
  });
  await app.register(registerPmsPricingRoutes, ports);
  return app;
}

function headers(idempotencyKey?: string) {
  return {
    authorization: "Bearer valid-token",
    ...(idempotencyKey ? { "idempotency-key": idempotencyKey } : {}),
  };
}

function cancellationTerms() {
  return {
    type: "free_until_days_before_arrival",
    freeCancellationDeadlineDays: 7,
    afterDeadlinePenalty: "full_booking_amount",
    noShowPenalty: "full_booking_amount",
  };
}

describe("PMS pricing routes", () => {
  let app: Awaited<ReturnType<typeof testApp>> | null = null;
  afterEach(async () => {
    await app?.close();
    app = null;
  });

  it("derives authoritative currency scope, audit, and exact idempotency", async () => {
    const ports = fakePorts();
    app = await testApp(ports);
    const response = await injectJson(app, {
      method: "PUT",
      url: `/properties/${propertyId.toUpperCase()}/pricing-source/currency`,
      headers: headers("  currency-key  "),
      payload: { expectedPricingCurrencyRevision: 0, currency: "EUR" },
    });

    expect(response.statusCode).toBe(201);
    expect(ports.currencyCalls).toHaveLength(1);
    expect(ports.currencyCalls[0]).toMatchObject({
      organizationId,
      propertyId,
      idempotencyKey: "currency-key",
      expectedPricingCurrencyRevision: 0,
      currency: "EUR",
      audit: {
        actor: { kind: "user", userId: actorUserId },
        requestId: "request-1",
        correlationId: "correlation-1",
        requestedAt: now,
      },
    });
  });

  it("accepts only scale-2 string money and exact structured cancellation terms", async () => {
    const ports = fakePorts();
    app = await testApp(ports);
    const valid = await injectJson(app, {
      method: "PUT",
      url: `/properties/${propertyId}/room-types/${roomTypeId}/flexible-rate-plan`,
      headers: headers("plan-key"),
      payload: {
        expectedRoomFactsRevision: 2,
        expectedPricingCurrencyRevision: 1,
        expectedFlexibleRatePlanRevision: 0,
        baseAmountDecimal: "175.25",
        cancellationTerms: cancellationTerms(),
      },
    });
    expect(valid.statusCode).toBe(201);
    expect(ports.planCalls[0]).toMatchObject({
      propertyId,
      roomTypeId,
      baseAmountDecimal: "175.25",
      cancellationTerms: cancellationTerms(),
    });

    const numericMoney = await injectJson(app, {
      method: "PUT",
      url: `/properties/${propertyId}/room-types/${roomTypeId}/flexible-rate-plan`,
      headers: headers("bad-plan-key"),
      payload: {
        expectedRoomFactsRevision: 2,
        expectedPricingCurrencyRevision: 1,
        expectedFlexibleRatePlanRevision: 0,
        baseAmountDecimal: 175.25,
        cancellationTerms: cancellationTerms(),
      },
    });
    expect(numericMoney.statusCode).toBe(400);
    expect(ports.planCalls).toHaveLength(1);
  });

  it("serves narrow source evidence and rejects escaped port scope", async () => {
    const ports = fakePorts();
    app = await testApp(ports);
    const source = await injectJson(app, {
      method: "GET",
      url: `/properties/${propertyId}/pricing-source`,
      headers: headers(),
    });
    expect(source.statusCode).toBe(200);
    expect(source.body).toMatchObject({
      propertyId,
      pricingCurrency: { currency: "EUR", pricingCurrencyRevision: 1 },
      flexibleRatePlans: [{ roomTypeId, baseAmount: { amountDecimal: "175.25" } }],
    });
    await app.close();

    const escaped = fakePorts({ responsePropertyId: otherPropertyId });
    app = await testApp(escaped);
    const invalid = await injectJson(app, {
      method: "GET",
      url: `/properties/${propertyId}/pricing-source`,
      headers: headers(),
    });
    expect(invalid.statusCode).toBe(500);
    expect(invalid.body).toEqual({ code: "pms_pricing_port_contract_violation" });
  });

  it("serves the strict immutable pricing-currency capability contract", async () => {
    const ports = fakePorts();
    app = await testApp(ports);
    const response = await injectJson(app, {
      method: "GET",
      url: `/properties/${propertyId}/pricing-source/currency-capabilities`,
      headers: headers(),
    });

    expect(response.statusCode).toBe(200);
    expect(response.body).toEqual(PMS_PRICING_CURRENCY_CAPABILITIES_V1);
    expect(ports.capabilityReads).toEqual(["capabilities"]);
  });

  it("denies the full protected capability-route matrix before the read port", async () => {
    const cases: readonly {
      name: string;
      requestHeaders: Record<string, string>;
      auth: AuthOptions;
      status: number;
    }[] = [
      { name: "missing auth", requestHeaders: {}, auth: {}, status: 401 },
      {
        name: "invalid auth",
        requestHeaders: { authorization: "Bearer invalid-token" },
        auth: {},
        status: 401,
      },
      {
        name: "missing permission",
        requestHeaders: headers(),
        auth: { permissions: [] },
        status: 403,
      },
      {
        name: "missing entitlement",
        requestHeaders: headers(),
        auth: { entitlements: [] },
        status: 403,
      },
      {
        name: "inactive entitlement",
        requestHeaders: headers(),
        auth: { entitlements: [entitlement("suspended")] },
        status: 403,
      },
      {
        name: "missing linked resource",
        requestHeaders: headers(),
        auth: { links: [] },
        status: 403,
      },
    ];

    for (const testCase of cases) {
      const ports = fakePorts();
      const candidate = await testApp(ports, testCase.auth);
      const response = await injectJson(candidate, {
        method: "GET",
        url: `/properties/${propertyId}/pricing-source/currency-capabilities`,
        headers: testCase.requestHeaders,
      });
      await candidate.close();
      expect(response.statusCode, testCase.name).toBe(testCase.status);
      expect(ports.capabilityReads, testCase.name).toEqual([]);
    }
  });

  it("distinguishes unavailable and malformed capability providers", async () => {
    const cases: readonly {
      name: string;
      port: PmsPricingCurrencyCapabilitiesReadPort;
      status: number;
      code: string;
    }[] = [
      {
        name: "missing",
        port: {
          async getPricingCurrencyCapabilities() {
            return null;
          },
        },
        status: 503,
        code: "pms_pricing_currency_capabilities_unavailable",
      },
      {
        name: "failed",
        port: {
          async getPricingCurrencyCapabilities() {
            throw new Error("unavailable");
          },
        },
        status: 503,
        code: "pms_pricing_currency_capabilities_unavailable",
      },
      {
        name: "malformed",
        port: {
          async getPricingCurrencyCapabilities() {
            return {
              contractVersion: "pms-pricing-currency-capabilities.v1",
              supportedCurrencies: [
                { code: "EUR", scale: 2 },
                { code: "CHF", scale: 2 },
              ],
            } as never;
          },
        },
        status: 500,
        code: "pms_pricing_currency_capabilities_port_contract_violation",
      },
    ];

    for (const testCase of cases) {
      const candidate = await testApp(fakePorts({ capabilitiesReadPort: testCase.port }));
      const response = await injectJson(candidate, {
        method: "GET",
        url: `/properties/${propertyId}/pricing-source/currency-capabilities`,
        headers: headers(),
      });
      await candidate.close();
      expect(response.statusCode, testCase.name).toBe(testCase.status);
      expect(response.body, testCase.name).toEqual({ code: testCase.code });
    }
  });

  it("excludes front-desk links before any pricing port call", async () => {
    const ports = fakePorts();
    app = await testApp(ports, { links: [link("front_desk")] });
    const response = await injectJson(app, {
      method: "GET",
      url: `/properties/${propertyId}/pricing-source`,
      headers: headers(),
    });
    expect(response.statusCode).toBe(403);
    expect(ports.reads).toEqual([]);
  });

  it("rejects missing idempotency and extra command fields before delegation", async () => {
    const ports = fakePorts();
    app = await testApp(ports);
    const missing = await injectJson(app, {
      method: "PUT",
      url: `/properties/${propertyId}/pricing-source/currency`,
      headers: headers(),
      payload: { expectedPricingCurrencyRevision: 0, currency: "EUR" },
    });
    const extra = await injectJson(app, {
      method: "PUT",
      url: `/properties/${propertyId}/pricing-source/currency`,
      headers: headers("extra-key"),
      payload: { expectedPricingCurrencyRevision: 0, currency: "EUR", amount: "10.00" },
    });
    expect(missing.statusCode).toBe(400);
    expect(extra.statusCode).toBe(400);
    expect(ports.currencyCalls).toEqual([]);
  });
});
