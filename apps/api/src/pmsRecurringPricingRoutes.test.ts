import type {
  LinkedResource,
  PermissionKey,
  ProductEntitlement,
  RequestContext,
} from "@vayada/backend-auth";
import { injectJson } from "@vayada/backend-test";
import {
  PMS_RECURRING_PRICING_CONTRACT_VERSION,
  parsePmsDecimalAmount,
  parsePmsNonNegativeDecimalAmount,
  parsePmsPricingCurrency,
  parsePmsRecurringDate,
  parsePmsRecurringMonthDay,
  type DisableRecurringPricingSourceCommand,
  type MaterializeRecurringPricingCommand,
  type PmsRecurringPricingSourceSnapshot,
  type UpsertAdditionalGuestPricingCommand,
  type UpsertNonRefundablePricingCommand,
  type UpsertRecurringSeasonCommand,
  type UpsertWeekendSurchargeCommand,
} from "@vayada/domain-pms";
import Fastify from "fastify";
import { request as httpRequest } from "node:http";
import { afterEach, describe, expect, it } from "vitest";

import {
  registerPmsRecurringPricingRoutes,
  type PmsRecurringPricingRoutesOptions,
} from "./routes/pmsRecurringPricing.js";

const propertyId = "72000000-0000-4000-8000-000000000001";
const otherPropertyId = "72000000-0000-4000-8000-000000000002";
const sourceId = "72000000-0000-4000-8000-000000000003";
const roomTypeId = "72000000-0000-4000-8000-000000000004";
const planId = "72000000-0000-4000-8000-000000000005";
const organizationId = "72000000-0000-4000-8000-000000000006";
const actorUserId = "72000000-0000-4000-8000-000000000007";
const receiptId = "72000000-0000-4000-8000-000000000008";
const spoofedOrganizationId = "72000000-0000-4000-8000-000000000009";
const spoofedSourceId = "72000000-0000-4000-8000-000000000010";
const spoofedActorUserId = "72000000-0000-4000-8000-000000000011";
const now = "2026-08-03T12:00:00.000Z";
const eur = parsePmsPricingCurrency("EUR")!;
const amount = parsePmsDecimalAmount("175.25")!;
const surcharge = parsePmsNonNegativeDecimalAmount("15.00")!;
const monthDayStart = parsePmsRecurringMonthDay("06-01")!;
const monthDayEnd = parsePmsRecurringMonthDay("09-30")!;

type AuthOptions = {
  permissions?: PermissionKey[];
  entitlements?: ProductEntitlement[];
  links?: LinkedResource[];
  organizationKind?: "hotel_group" | "customer";
};

type FakePorts = PmsRecurringPricingRoutesOptions & {
  calls: {
    seasons: UpsertRecurringSeasonCommand[];
    weekends: UpsertWeekendSurchargeCommand[];
    additionalGuests: UpsertAdditionalGuestPricingCommand[];
    nonRefundables: UpsertNonRefundablePricingCommand[];
    disables: DisableRecurringPricingSourceCommand[];
    materializations: MaterializeRecurringPricingCommand[];
    reads: Array<readonly unknown[]>;
  };
};

function sourceBase(
  command: {
    propertyId: string;
    sourceId: string;
    expectedSourceRevision: number;
    expectedPricingCurrencyRevision: number;
  },
  configuredState: "active" | "disabled" = "active",
  lifecycle: "active" | "disabled" | "invalid" = configuredState,
) {
  return {
    contractVersion: PMS_RECURRING_PRICING_CONTRACT_VERSION,
    propertyId: command.propertyId,
    sourceId: command.sourceId,
    sourceRevision: command.expectedSourceRevision + 1,
    pricingCurrencyRevision: command.expectedPricingCurrencyRevision,
    currency: eur,
    configuredState,
    validation:
      lifecycle === "invalid"
        ? {
            state: "invalid" as const,
            validationRevision: 1,
            validatedAt: now,
            reasons: [{ code: "dependency_unavailable" as const }],
          }
        : { state: "valid" as const, validationRevision: 1, validatedAt: now },
    lifecycle,
    materializationRevision: 0,
    createdAt: now,
    updatedAt: now,
  };
}

function seasonSnapshot(
  overrides: { propertyId?: string; sourceId?: string; sourceRevision?: number } = {},
): PmsRecurringPricingSourceSnapshot {
  return {
    ...sourceBase({
      propertyId: overrides.propertyId ?? propertyId,
      sourceId: overrides.sourceId ?? sourceId,
      expectedSourceRevision: (overrides.sourceRevision ?? 1) - 1,
      expectedPricingCurrencyRevision: 1,
    }),
    sourceKind: "season",
    name: "Summer",
    startMonthDay: monthDayStart,
    endMonthDay: monthDayEnd,
    roomPrices: [
      {
        roomTypeId,
        roomFactsRevision: 2,
        flexibleRatePlanId: planId,
        flexibleRatePlanRevision: 3,
        amountDecimal: amount,
      },
    ],
  };
}

function fakePorts(
  overrides: {
    responsePropertyId?: string;
    seasonOutcome?: "created" | "updated" | "re_enabled" | "disabled";
    seasonConfiguredState?: "active" | "disabled";
    seasonLifecycle?: "active" | "disabled" | "invalid";
  } = {},
): FakePorts {
  const responsePropertyId = overrides.responsePropertyId;
  const calls: FakePorts["calls"] = {
    seasons: [],
    weekends: [],
    additionalGuests: [],
    nonRefundables: [],
    disables: [],
    materializations: [],
    reads: [],
  };
  return {
    calls,
    commandPort: {
      async upsertRecurringSeason(command) {
        calls.seasons.push(command);
        return {
          ok: true,
          response: {
            contractVersion: PMS_RECURRING_PRICING_CONTRACT_VERSION,
            outcome:
              overrides.seasonOutcome ??
              (command.expectedSourceRevision === 0 ? "created" : "updated"),
            source: {
              ...sourceBase(
                {
                  ...command,
                  propertyId: responsePropertyId ?? command.propertyId,
                },
                overrides.seasonConfiguredState,
                overrides.seasonLifecycle,
              ),
              sourceKind: "season",
              name: command.name,
              startMonthDay: command.startMonthDay,
              endMonthDay: command.endMonthDay,
              roomPrices: command.roomPrices.map((room) => ({
                roomTypeId: room.roomTypeId,
                roomFactsRevision: room.expectedRoomFactsRevision,
                flexibleRatePlanId: room.flexibleRatePlanId,
                flexibleRatePlanRevision: room.expectedFlexibleRatePlanRevision,
                amountDecimal: room.amountDecimal,
              })),
            },
            optionalPricingAggregateRevision: 1,
            acceptedAt: now,
          },
        };
      },
      async upsertWeekendSurcharge(command) {
        calls.weekends.push(command);
        return {
          ok: true,
          response: {
            contractVersion: PMS_RECURRING_PRICING_CONTRACT_VERSION,
            outcome: command.expectedSourceRevision === 0 ? "created" : "updated",
            source: {
              ...sourceBase(command),
              sourceKind: "weekend_surcharge",
              weekdays: command.weekdays,
              roomSurcharges: command.roomSurcharges.map((room) => ({
                roomTypeId: room.roomTypeId,
                roomFactsRevision: room.expectedRoomFactsRevision,
                flexibleRatePlanId: room.flexibleRatePlanId,
                flexibleRatePlanRevision: room.expectedFlexibleRatePlanRevision,
                amountDecimal: room.amountDecimal,
              })),
            },
            optionalPricingAggregateRevision: 1,
            acceptedAt: now,
          },
        };
      },
      async upsertAdditionalGuestPricing(command) {
        calls.additionalGuests.push(command);
        return {
          ok: true,
          response: {
            contractVersion: PMS_RECURRING_PRICING_CONTRACT_VERSION,
            outcome: command.expectedSourceRevision === 0 ? "created" : "updated",
            source: {
              ...sourceBase(command),
              sourceKind: "additional_guest",
              roomTypeId: command.roomTypeId,
              roomFactsRevision: command.expectedRoomFactsRevision,
              flexibleRatePlanId: command.flexibleRatePlanId,
              flexibleRatePlanRevision: command.expectedFlexibleRatePlanRevision,
              maximumAdultGuests: 4,
              includedGuests: command.includedGuests,
              amountDecimal: command.amountDecimal,
            },
            optionalPricingAggregateRevision: 1,
            acceptedAt: now,
          },
        };
      },
      async upsertNonRefundablePricing(command) {
        calls.nonRefundables.push(command);
        return {
          ok: true,
          response: {
            contractVersion: PMS_RECURRING_PRICING_CONTRACT_VERSION,
            outcome: command.expectedSourceRevision === 0 ? "created" : "updated",
            source: {
              ...sourceBase(command),
              sourceKind: "non_refundable",
              roomPlans: command.roomPlans.map((room) => ({
                roomTypeId: room.roomTypeId,
                roomFactsRevision: room.expectedRoomFactsRevision,
                flexibleRatePlanId: room.flexibleRatePlanId,
                flexibleRatePlanRevision: room.expectedFlexibleRatePlanRevision,
              })),
              discountPercent: command.discountPercent,
              paymentTiming: "prepay_full",
              cancellationTerms: {
                type: "non_refundable",
                refundPolicy: "no_refund",
                noShowPenalty: "full_booking_amount",
              },
            },
            optionalPricingAggregateRevision: 1,
            acceptedAt: now,
          },
        };
      },
      async disableRecurringPricingSource(command) {
        calls.disables.push(command);
        return {
          ok: true,
          response: {
            contractVersion: PMS_RECURRING_PRICING_CONTRACT_VERSION,
            outcome: "disabled",
            source: {
              ...seasonSnapshot({
                propertyId: responsePropertyId ?? command.propertyId,
                sourceId: command.sourceId,
                sourceRevision: command.expectedSourceRevision + 1,
              }),
              configuredState: "disabled",
              lifecycle: "disabled",
            },
            optionalPricingAggregateRevision: 2,
            acceptedAt: now,
          },
        };
      },
      async materializeRecurringPricing(command) {
        calls.materializations.push(command);
        return {
          ok: true,
          receipt: {
            contractVersion: PMS_RECURRING_PRICING_CONTRACT_VERSION,
            receiptId,
            propertyId: responsePropertyId ?? command.propertyId,
            optionalPricingAggregateRevision: command.expectedOptionalPricingAggregateRevision,
            fromDate: command.fromDate,
            throughDate: command.throughDate,
            sources: [
              seasonSnapshot({
                sourceRevision: command.expectedOptionalPricingAggregateRevision,
              }),
            ].map((source) => ({
              sourceKind: source.sourceKind,
              sourceId: source.sourceId,
              sourceRevision: source.sourceRevision,
              configuredState: "active" as const,
              validation: {
                state: "valid" as const,
                validationRevision: 1,
                validatedAt: now,
              },
              lifecycle: "active" as const,
              materializationRevision: 1,
              currency: eur,
              pricingCurrencyRevision: 1,
              result: "materialized" as const,
              materializedRowCount: 1,
              materializedRowsSha256: "a".repeat(64),
            })),
            acceptedAt: now,
          },
        };
      },
    },
    readPort: {
      async getRecurringPricingSource(requestPropertyId, requestedSourceId) {
        calls.reads.push(["source", requestPropertyId, requestedSourceId]);
        return seasonSnapshot({
          propertyId: responsePropertyId ?? requestPropertyId,
          sourceId: requestedSourceId,
        });
      },
      async listRecurringPricingSources(requestPropertyId) {
        calls.reads.push(["sources", requestPropertyId]);
        return [seasonSnapshot({ propertyId: responsePropertyId ?? requestPropertyId })];
      },
      async getRecurringPricingBookingEvidence(requestPropertyId) {
        calls.reads.push(["evidence", requestPropertyId]);
        const source = seasonSnapshot({ propertyId: responsePropertyId ?? requestPropertyId });
        return {
          contractVersion: PMS_RECURRING_PRICING_CONTRACT_VERSION,
          propertyId: responsePropertyId ?? requestPropertyId,
          pricingCurrencyRevision: 1,
          optionalPricingAggregateRevision: 1,
          currency: eur,
          sources: [source],
          capturedAt: now,
        };
      },
    },
  };
}

function entitlement(resourceId = propertyId): ProductEntitlement {
  return {
    product: "pms",
    key: "property-management",
    status: "active",
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
      selectedOrganization: {
        organizationId,
        kind: auth.organizationKind ?? "hotel_group",
      },
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
  await app.register(registerPmsRecurringPricingRoutes, ports);
  return app;
}

function headers(idempotencyKey?: string) {
  return {
    authorization: "Bearer valid-token",
    ...(idempotencyKey ? { "idempotency-key": idempotencyKey } : {}),
  };
}

function roomEvidence() {
  return {
    roomTypeId,
    expectedRoomFactsRevision: 2,
    flexibleRatePlanId: planId,
    expectedFlexibleRatePlanRevision: 3,
  };
}

async function requestWithRepeatedIdempotencyHeader(
  app: Awaited<ReturnType<typeof testApp>>,
  payload: string,
): Promise<number> {
  await app.listen({ host: "127.0.0.1", port: 0 });
  const address = app.server.address();
  if (!address || typeof address === "string") throw new Error("Test server did not bind");
  return new Promise((resolve, reject) => {
    const request = httpRequest(
      {
        host: "127.0.0.1",
        port: address.port,
        method: "POST",
        path: `/properties/${propertyId}/pricing-source/recurring/${sourceId}/disable`,
        headers: {
          authorization: "Bearer valid-token",
          "content-type": "application/json",
          "content-length": String(Buffer.byteLength(payload)),
          "idempotency-key": ["one", "two"],
        },
      },
      (response) => {
        response.resume();
        response.on("end", () => resolve(response.statusCode ?? 0));
      },
    );
    request.on("error", reject);
    request.end(payload);
  });
}

describe("PMS recurring-pricing routes", () => {
  let app: Awaited<ReturnType<typeof testApp>> | null = null;
  afterEach(async () => {
    await app?.close();
    app = null;
  });

  it("creates each exact owner source without accepting caller currency or derived policy", async () => {
    const ports = fakePorts();
    app = await testApp(ports);
    const requests = [
      {
        key: "season-key",
        payload: {
          sourceKind: "season",
          expectedSourceRevision: 0,
          expectedPricingCurrencyRevision: 1,
          name: "Summer",
          startMonthDay: "06-01",
          endMonthDay: "09-30",
          roomPrices: [{ ...roomEvidence(), amountDecimal: "175.25" }],
        },
      },
      {
        key: "weekend-key",
        payload: {
          sourceKind: "weekend_surcharge",
          expectedSourceRevision: 0,
          expectedPricingCurrencyRevision: 1,
          weekdays: ["friday", "saturday"],
          roomSurcharges: [{ ...roomEvidence(), amountDecimal: "15.00" }],
        },
      },
      {
        key: "guest-key",
        payload: {
          sourceKind: "additional_guest",
          expectedSourceRevision: 0,
          expectedPricingCurrencyRevision: 1,
          ...roomEvidence(),
          includedGuests: 2,
          amountDecimal: "20.00",
        },
      },
      {
        key: "nonref-key",
        payload: {
          sourceKind: "non_refundable",
          expectedSourceRevision: 0,
          expectedPricingCurrencyRevision: 1,
          roomPlans: [roomEvidence()],
          discountPercent: 10,
        },
      },
    ] as const;

    for (const request of requests) {
      const response = await injectJson(app, {
        method: "PUT",
        url: `/properties/${propertyId}/pricing-source/recurring/${sourceId}`,
        headers: headers(request.key),
        payload: request.payload,
      });
      expect(response.statusCode).toBe(201);
      expect(response.body).toMatchObject({
        outcome: "created",
        source: { propertyId, sourceId, sourceKind: request.payload.sourceKind },
      });
    }
    expect(ports.calls.seasons).toHaveLength(1);
    expect(ports.calls.weekends).toHaveLength(1);
    expect(ports.calls.additionalGuests).toHaveLength(1);
    expect(ports.calls.nonRefundables).toHaveLength(1);

    const inventedCurrency = await injectJson(app, {
      method: "PUT",
      url: `/properties/${propertyId}/pricing-source/recurring/${sourceId}`,
      headers: headers("invented-key"),
      payload: { ...requests[0].payload, currency: "USD" },
    });
    expect(inventedCurrency.statusCode).toBe(400);
    expect(ports.calls.seasons).toHaveLength(1);
  });

  it("assigns every trusted command identifier after caller-controlled request fields", async () => {
    const ports = fakePorts();
    app = await testApp(ports);
    const spoofedContext = {
      organizationId: spoofedOrganizationId,
      propertyId: otherPropertyId,
      sourceId: spoofedSourceId,
      idempotencyKey: "spoofed-idempotency-key",
      audit: {
        actor: { kind: "user", userId: spoofedActorUserId },
        requestId: "spoofed-request",
        correlationId: "spoofed-correlation",
        requestedAt: "2026-01-01T00:00:00.000Z",
      },
    };

    const upserted = await injectJson(app, {
      method: "PUT",
      url: `/properties/${propertyId}/pricing-source/recurring/${sourceId}`,
      headers: headers("trusted-upsert-key"),
      payload: {
        sourceKind: "season",
        expectedSourceRevision: 0,
        expectedPricingCurrencyRevision: 1,
        name: "Summer",
        startMonthDay: "06-01",
        endMonthDay: "09-30",
        roomPrices: [{ ...roomEvidence(), amountDecimal: "175.25" }],
        ...spoofedContext,
      },
    });
    const disabled = await injectJson(app, {
      method: "POST",
      url: `/properties/${propertyId}/pricing-source/recurring/${sourceId}/disable`,
      headers: headers("trusted-disable-key"),
      payload: {
        sourceKind: "season",
        expectedSourceRevision: 1,
        ...spoofedContext,
      },
    });
    const materialized = await injectJson(app, {
      method: "POST",
      url: `/properties/${propertyId}/pricing-source/recurring/materializations`,
      headers: headers("trusted-materialize-key"),
      payload: {
        fromDate: "2026-08-01",
        throughDate: "2026-08-31",
        expectedOptionalPricingAggregateRevision: 2,
        organizationId: spoofedOrganizationId,
        propertyId: otherPropertyId,
        idempotencyKey: "spoofed-idempotency-key",
        audit: spoofedContext.audit,
      },
    });

    expect([upserted.statusCode, disabled.statusCode, materialized.statusCode]).toEqual([
      201, 200, 200,
    ]);
    expect(ports.calls.seasons[0]).toMatchObject({
      organizationId,
      propertyId,
      sourceId,
      idempotencyKey: "trusted-upsert-key",
      audit: {
        actor: { kind: "user", userId: actorUserId },
        requestId: "request-1",
        correlationId: "correlation-1",
        requestedAt: now,
      },
    });
    expect(ports.calls.disables[0]).toMatchObject({
      organizationId,
      propertyId,
      sourceId,
      idempotencyKey: "trusted-disable-key",
      audit: { actor: { kind: "user", userId: actorUserId } },
    });
    expect(ports.calls.materializations[0]).toMatchObject({
      organizationId,
      propertyId,
      idempotencyKey: "trusted-materialize-key",
      audit: { actor: { kind: "user", userId: actorUserId } },
    });
  });

  it("rejects successful upsert results with an impossible lifecycle or revision outcome", async () => {
    const scenarios = [
      {
        name: "disabled outcome",
        expectedSourceRevision: 1,
        seasonOutcome: "disabled",
        seasonConfiguredState: "disabled",
      },
      {
        name: "configured-disabled update",
        expectedSourceRevision: 1,
        seasonOutcome: "updated",
        seasonConfiguredState: "disabled",
      },
      {
        name: "created update",
        expectedSourceRevision: 1,
        seasonOutcome: "created",
        seasonConfiguredState: "active",
      },
      {
        name: "invalid lifecycle update",
        expectedSourceRevision: 1,
        seasonOutcome: "updated",
        seasonConfiguredState: "active",
        seasonLifecycle: "invalid",
      },
      {
        name: "updated create",
        expectedSourceRevision: 0,
        seasonOutcome: "updated",
        seasonConfiguredState: "active",
      },
      {
        name: "re-enabled create",
        expectedSourceRevision: 0,
        seasonOutcome: "re_enabled",
        seasonConfiguredState: "active",
      },
    ] as const;

    for (const scenario of scenarios) {
      const ports = fakePorts({
        seasonOutcome: scenario.seasonOutcome,
        seasonConfiguredState: scenario.seasonConfiguredState,
        seasonLifecycle: "seasonLifecycle" in scenario ? scenario.seasonLifecycle : undefined,
      });
      app = await testApp(ports);
      const response = await injectJson(app, {
        method: "PUT",
        url: `/properties/${propertyId}/pricing-source/recurring/${sourceId}`,
        headers: headers(`invalid-${scenario.name}`),
        payload: {
          sourceKind: "season",
          expectedSourceRevision: scenario.expectedSourceRevision,
          expectedPricingCurrencyRevision: 1,
          name: "Summer",
          startMonthDay: "06-01",
          endMonthDay: "09-30",
          roomPrices: [{ ...roomEvidence(), amountDecimal: "175.25" }],
        },
      });
      expect(response.statusCode, scenario.name).toBe(500);
      expect(response.body, scenario.name).toEqual({
        code: "pms_recurring_pricing_port_contract_violation",
      });
      expect(ports.calls.seasons, scenario.name).toHaveLength(1);
      await app.close();
      app = null;
    }
  });

  it("rejects JavaScript-number money, duplicate idempotency headers, and overlong horizons", async () => {
    const ports = fakePorts();
    app = await testApp(ports);
    const numericMoney = await injectJson(app, {
      method: "PUT",
      url: `/properties/${propertyId}/pricing-source/recurring/${sourceId}`,
      headers: headers("numeric-key"),
      payload: {
        sourceKind: "weekend_surcharge",
        expectedSourceRevision: 0,
        expectedPricingCurrencyRevision: 1,
        weekdays: ["saturday"],
        roomSurcharges: [{ ...roomEvidence(), amountDecimal: 15 }],
      },
    });
    const duplicateHeaderStatus = await requestWithRepeatedIdempotencyHeader(
      app,
      JSON.stringify({ sourceKind: "season", expectedSourceRevision: 1 }),
    );
    const overlong = await injectJson(app, {
      method: "POST",
      url: `/properties/${propertyId}/pricing-source/recurring/materializations`,
      headers: headers("materialize-key"),
      payload: {
        fromDate: "2026-01-01",
        throughDate: "2027-01-02",
        expectedOptionalPricingAggregateRevision: 1,
      },
    });
    expect(numericMoney.statusCode).toBe(400);
    expect(duplicateHeaderStatus).toBe(400);
    expect(overlong.statusCode).toBe(400);
    expect(ports.calls.weekends).toEqual([]);
    expect(ports.calls.disables).toEqual([]);
    expect(ports.calls.materializations).toEqual([]);
  });

  it("disables without erasing identity and materializes an exact bounded source set", async () => {
    const ports = fakePorts();
    app = await testApp(ports);
    const disabled = await injectJson(app, {
      method: "POST",
      url: `/properties/${propertyId}/pricing-source/recurring/${sourceId}/disable`,
      headers: headers("disable-key"),
      payload: { sourceKind: "season", expectedSourceRevision: 1 },
    });
    expect(disabled.statusCode).toBe(200);
    expect(disabled.body).toMatchObject({
      outcome: "disabled",
      source: { sourceId, sourceRevision: 2, configuredState: "disabled" },
    });

    const materialized = await injectJson(app, {
      method: "POST",
      url: `/properties/${propertyId}/pricing-source/recurring/materializations`,
      headers: headers("materialize-key"),
      payload: {
        fromDate: "2026-08-01",
        throughDate: "2027-08-01",
        expectedOptionalPricingAggregateRevision: 2,
      },
    });
    expect(materialized.statusCode).toBe(200);
    expect(materialized.body).toMatchObject({
      receiptId,
      propertyId,
      optionalPricingAggregateRevision: 2,
      sources: [{ sourceId, sourceRevision: 2, materializationRevision: 1 }],
    });
    expect(ports.calls.materializations[0]?.fromDate).toBe(parsePmsRecurringDate("2026-08-01"));
  });

  it("reads exact-property sources and Booking evidence while rejecting escaped port scope", async () => {
    const ports = fakePorts();
    app = await testApp(ports);
    const list = await injectJson(app, {
      method: "GET",
      url: `/properties/${propertyId}/pricing-source/recurring`,
      headers: headers(),
    });
    const one = await injectJson(app, {
      method: "GET",
      url: `/properties/${propertyId}/pricing-source/recurring/${sourceId}`,
      headers: headers(),
    });
    const evidence = await injectJson(app, {
      method: "GET",
      url: `/properties/${propertyId}/pricing-source/recurring-booking-evidence`,
      headers: headers(),
    });
    expect(list.statusCode).toBe(200);
    expect(one.statusCode).toBe(200);
    expect(evidence.statusCode).toBe(200);
    expect(evidence.body).toMatchObject({
      propertyId,
      pricingCurrencyRevision: 1,
      optionalPricingAggregateRevision: 1,
      sources: [{ sourceId, lifecycle: "active" }],
    });
    await app.close();

    const escaped = fakePorts({ responsePropertyId: otherPropertyId });
    app = await testApp(escaped);
    const invalid = await injectJson(app, {
      method: "GET",
      url: `/properties/${propertyId}/pricing-source/recurring-booking-evidence`,
      headers: headers(),
    });
    expect(invalid.statusCode).toBe(500);
    expect(invalid.body).toEqual({ code: "pms_recurring_pricing_port_contract_violation" });
  });

  it("authorizes before parsing and before every port call", async () => {
    const ports = fakePorts();
    app = await testApp(ports, { links: [link("front_desk")] });
    const denied = await injectJson(app, {
      method: "PUT",
      url: `/properties/${propertyId}/pricing-source/recurring/${sourceId}`,
      headers: { authorization: "Bearer valid-token", "content-type": "application/json" },
      payload: "{",
    });
    expect(denied.statusCode).toBe(403);
    expect(ports.calls.seasons).toEqual([]);
    expect(ports.calls.reads).toEqual([]);
  });

  it("requires the read/manage permission split, active entitlement, linked property, and hotel scope", async () => {
    const scenarios: AuthOptions[] = [
      { permissions: ["pms.operations.read"] },
      { entitlements: [] },
      { links: [] },
      { organizationKind: "customer" },
    ];
    for (const auth of scenarios) {
      const ports = fakePorts();
      app = await testApp(ports, auth);
      const response = await injectJson(app, {
        method: "POST",
        url: `/properties/${propertyId}/pricing-source/recurring/${sourceId}/disable`,
        headers: headers("deny-key"),
        payload: { sourceKind: "season", expectedSourceRevision: 1 },
      });
      expect(response.statusCode).toBe(403);
      expect(ports.calls.disables).toEqual([]);
      await app.close();
      app = null;
    }

    const readPorts = fakePorts();
    app = await testApp(readPorts, { permissions: ["pms.operations.manage"] });
    const read = await injectJson(app, {
      method: "GET",
      url: `/properties/${propertyId}/pricing-source/recurring`,
      headers: headers(),
    });
    expect(read.statusCode).toBe(403);
    expect(readPorts.calls.reads).toEqual([]);
  });
});
