import type {
  LinkedResource,
  OrganizationKind,
  PermissionKey,
  ProductEntitlement,
  RequestContext,
} from "@vayada/backend-auth";
import { injectJson } from "@vayada/backend-test";
import {
  createFinancePaymentReadinessSnapshot,
  type FinancePaymentMethodsCommandPort,
  type FinancePaymentReadinessMethod,
  type FinancePaymentReadinessReadPort,
  type ReplaceFinancePaymentMethodsCommand,
  type ReplaceFinancePaymentMethodsResult,
} from "@vayada/domain-finance";
import { PMS_PRICING_CONTRACT_VERSION } from "@vayada/domain-pms";
import Fastify from "fastify";
import { request as httpRequest } from "node:http";
import { afterEach, describe, expect, it } from "vitest";

import {
  registerFinancePaymentReadinessRoutes,
  type FinancePaymentReadinessRoutesOptions,
} from "./routes/financePaymentReadiness.js";

const propertyId = "123e4567-e89b-42d3-a456-426614174000";
const otherPropertyId = "223e4567-e89b-42d3-a456-426614174000";
const organizationId = "323e4567-e89b-42d3-a456-426614174000";
const actorUserId = "423e4567-e89b-42d3-a456-426614174000";
const now = "2026-08-03T12:00:00.000Z";

type AuthOptions = {
  authenticated?: boolean;
  organizationKind?: OrganizationKind;
  permissions?: readonly PermissionKey[];
  entitlements?: readonly ProductEntitlement[];
  links?: readonly LinkedResource[];
};

type FakePorts = FinancePaymentReadinessRoutesOptions & {
  commands: ReplaceFinancePaymentMethodsCommand[];
  reads: Array<{ organizationId: string; propertyId: string }>;
  readValue: unknown;
  result?: ReplaceFinancePaymentMethodsResult | unknown;
  failRead?: boolean;
  failCommand?: boolean;
};

function paymentReadiness(
  selectedMethods: readonly FinancePaymentReadinessMethod[] = ["pay_at_property"],
  overrides: {
    propertyId?: string;
    paymentMethodsRevision?: number;
    committedRevision?: number;
    currentRevision?: number;
    contractVersion?: string;
  } = {},
) {
  const contractVersion = overrides.contractVersion ?? PMS_PRICING_CONTRACT_VERSION;
  return createFinancePaymentReadinessSnapshot({
    propertyId: overrides.propertyId ?? propertyId,
    paymentMethodsRevision: overrides.paymentMethodsRevision ?? 1,
    selectedMethods,
    committedPricing: {
      contractVersion,
      currency: "EUR",
      pricingCurrencyRevision: overrides.committedRevision ?? 7,
    },
    currentPricing: {
      contractVersion,
      currency: "EUR",
      pricingCurrencyRevision: overrides.currentRevision ?? 7,
    },
    updatedAt: now,
  });
}

function success(command: ReplaceFinancePaymentMethodsCommand): ReplaceFinancePaymentMethodsResult {
  return {
    ok: true,
    response: {
      contractVersion: "finance-payment-readiness.v1",
      outcome: command.expectedPaymentMethodsRevision === 0 ? "created" : "updated",
      paymentReadiness: paymentReadiness(command.selectedMethods, {
        paymentMethodsRevision: command.expectedPaymentMethodsRevision + 1,
        committedRevision: command.expectedPricingCurrencyRevision,
        currentRevision: command.expectedPricingCurrencyRevision,
      }),
      acceptedAt: now,
    },
  };
}

function fakePorts(): FakePorts {
  const ports: FakePorts = {
    commands: [],
    reads: [],
    readValue: paymentReadiness(),
    readPort: {
      async getPaymentReadiness(request) {
        ports.reads.push(request);
        if (ports.failRead) throw new Error("private read failure");
        return ports.readValue as never;
      },
    } satisfies FinancePaymentReadinessReadPort,
    commandPort: {
      async replacePaymentMethods(command) {
        ports.commands.push(command);
        if (ports.failCommand) throw new Error("private write failure");
        return (ports.result ?? success(command)) as never;
      },
    } satisfies FinancePaymentMethodsCommandPort,
  };
  return ports;
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

function link(
  relationship: LinkedResource["relationship"] = "owner",
  status: LinkedResource["status"] = "active",
  resourceId = propertyId,
): LinkedResource {
  return { product: "pms", resourceType: "pms_property", resourceId, relationship, status };
}

async function testApp(ports: FakePorts, auth: AuthOptions = {}) {
  const app = Fastify({ logger: false });
  app.decorateRequest("authContext", null);
  app.addHook("onRequest", async (request) => {
    if (auth.authenticated === false || request.headers.authorization !== "Bearer valid-token") {
      return;
    }
    request.authContext = {
      actor: { internalUserId: actorUserId },
      selectedOrganization: {
        organizationId,
        kind: auth.organizationKind ?? "hotel_group",
      },
      membership: {
        permissions: [...(auth.permissions ?? ["pms.finance.manage"])],
      },
      linkedResources: [...(auth.links ?? [link()])],
      entitlements: [...(auth.entitlements ?? [entitlement()])],
      locale: "en",
      currency: "EUR",
      audit: {
        requestId: "request-1",
        correlationId: "correlation-1",
        source: "api",
        receivedAt: now,
      },
    } as RequestContext;
  });
  await app.register(registerFinancePaymentReadinessRoutes, ports);
  return app;
}

function body(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    expectedPaymentMethodsRevision: 0,
    expectedPricingCurrencyRevision: 7,
    selectedMethods: ["card", "pay_at_property"],
    ...overrides,
  };
}

describe("Finance payment readiness routes", () => {
  let app: Awaited<ReturnType<typeof testApp>> | null = null;
  afterEach(async () => {
    await app?.close();
    app = null;
  });

  it("serves strict scoped readiness and reports unconfigured state", async () => {
    const ports = fakePorts();
    app = await testApp(ports);
    const ready = await injectJson(app, {
      method: "GET",
      url: `/finance/properties/${propertyId.toUpperCase()}/payment-readiness`,
      headers: { authorization: "Bearer valid-token" },
    });
    expect(ready.statusCode).toBe(200);
    expect(ready.body).toEqual(paymentReadiness());
    expect(ports.reads).toEqual([{ organizationId, propertyId }]);

    ports.readValue = null;
    const missing = await injectJson(app, {
      method: "GET",
      url: `/finance/properties/${propertyId}/payment-readiness`,
      headers: { authorization: "Bearer valid-token" },
    });
    expect(missing).toMatchObject({
      statusCode: 404,
      body: { code: "payment_readiness_not_configured" },
    });
  });

  it("builds canonical commands and returns created then updated", async () => {
    const ports = fakePorts();
    app = await testApp(ports);
    const created = await put(app, body(), "  command-key  ");
    const updated = await put(app, body({ expectedPaymentMethodsRevision: 1 }), "second-key");

    expect(created.statusCode).toBe(201);
    expect(updated.statusCode).toBe(200);
    expect(ports.commands[0]).toEqual({
      organizationId,
      propertyId,
      idempotencyKey: "command-key",
      expectedPaymentMethodsRevision: 0,
      expectedPricingCurrencyRevision: 7,
      selectedMethods: ["pay_at_property", "card"],
      audit: {
        actor: { kind: "user", userId: actorUserId },
        requestId: "request-1",
        correlationId: "correlation-1",
        requestedAt: now,
      },
    });
  });

  it.each([
    [{ ok: false, error: { code: "setup_scope_unavailable" } }, 404],
    [{ ok: false, error: { code: "pricing_currency_unavailable" } }, 404],
    [{ ok: false, error: { code: "payment_method_unavailable", method: "bank_transfer" } }, 422],
    [
      {
        ok: false,
        error: { code: "payment_methods_revision_conflict", currentRevision: 2 },
      },
      409,
    ],
    [
      {
        ok: false,
        error: { code: "pricing_currency_revision_conflict", currentRevision: 8 },
      },
      409,
    ],
    [{ ok: false, error: { code: "idempotency_key_conflict" } }, 409],
    [{ ok: false, error: { code: "command_in_progress" } }, 409],
  ] as const)("maps the typed command error %#", async (result, statusCode) => {
    const ports = fakePorts();
    ports.result = result;
    app = await testApp(ports);
    expect((await put(app)).statusCode).toBe(statusCode);
  });

  it.each([
    ["property", { propertyId: otherPropertyId }],
    ["revision", { paymentMethodsRevision: 2 }],
    ["selection", {}],
    ["committed pricing", { committedRevision: 8 }],
    ["current pricing", { currentRevision: 8 }],
    ["pricing contract", { contractVersion: "lookalike-pricing.v1" }],
  ] as const)("rejects a successful %s mismatch from the typed port", async (_name, overrides) => {
    const ports = fakePorts();
    ports.result = {
      ok: true,
      response: {
        contractVersion: "finance-payment-readiness.v1",
        outcome: "created",
        paymentReadiness: paymentReadiness(
          _name === "selection" ? ["card"] : ["pay_at_property", "card"],
          overrides,
        ),
        acceptedAt: now,
      },
    };
    app = await testApp(ports);
    expect(await put(app)).toMatchObject({
      statusCode: 500,
      body: { code: "finance_payment_readiness_port_contract_violation" },
    });
  });

  it.each([
    [0, "updated"],
    [1, "created"],
  ] as const)(
    "rejects a successful %s-revision command with an inconsistent %s outcome",
    async (expectedPaymentMethodsRevision, outcome) => {
      const ports = fakePorts();
      ports.result = {
        ok: true,
        response: {
          contractVersion: "finance-payment-readiness.v1",
          outcome,
          paymentReadiness: paymentReadiness(["pay_at_property", "card"], {
            paymentMethodsRevision: expectedPaymentMethodsRevision + 1,
          }),
          acceptedAt: now,
        },
      };
      app = await testApp(ports);
      expect(await put(app, body({ expectedPaymentMethodsRevision }))).toMatchObject({
        statusCode: 500,
        body: { code: "finance_payment_readiness_port_contract_violation" },
      });
    },
  );

  it("returns secret-safe 500s for malformed or failed internal ports", async () => {
    const ports = fakePorts();
    ports.readValue = { providerSecret: "must-not-leak" };
    app = await testApp(ports);
    const malformed = await injectJson(app, {
      method: "GET",
      url: `/finance/properties/${propertyId}/payment-readiness`,
      headers: { authorization: "Bearer valid-token" },
    });
    expect(malformed).toMatchObject({
      statusCode: 500,
      body: { code: "finance_payment_readiness_port_contract_violation" },
    });
    expect(JSON.stringify(malformed.body)).not.toContain("must-not-leak");

    ports.failCommand = true;
    expect(await put(app)).toMatchObject({
      statusCode: 500,
      body: { code: "finance_payment_readiness_port_contract_violation" },
    });
  });

  it.each([
    ["owner", { links: [link("owner")] }, 201],
    ["finance manager", { links: [link("finance_manager")] }, 201],
    ["operator", { links: [link("operator")] }, 403],
    ["front desk", { links: [link("front_desk")] }, 403],
    ["suspended link", { links: [link("owner", "suspended")] }, 403],
    ["wrong link scope", { links: [link("owner", "active", otherPropertyId)] }, 403],
    ["missing permission", { permissions: [] }, 403],
    ["missing entitlement", { entitlements: [] }, 403],
    ["suspended entitlement", { entitlements: [entitlement("suspended")] }, 403],
    ["wrong entitlement scope", { entitlements: [entitlement("active", otherPropertyId)] }, 403],
    ["platform organization", { organizationKind: "platform" }, 403],
    ["unauthenticated", { authenticated: false }, 401],
  ] as const)("enforces the %s authorization case before parsing", async (_name, auth, status) => {
    const ports = fakePorts();
    app = await testApp(ports, auth);
    const response = await injectJson(app, {
      method: "PUT",
      url: `/finance/properties/${propertyId}/payment-methods`,
      headers: {
        authorization: "Bearer valid-token",
        ...(status === 201 ? { "idempotency-key": "authorization-case" } : {}),
      },
      payload: status === 201 ? body() : { unsafe: "body" },
    });
    expect(response.statusCode).toBe(status);
    expect(ports.commands).toHaveLength(status === 201 ? 1 : 0);
  });

  it("rejects malformed property, body, and Idempotency-Key inputs", async () => {
    const ports = fakePorts();
    app = await testApp(ports);
    const malformedProperty = await put(app, body(), "key", "not-a-uuid");
    const malformedBody = await put(app, { ...body(), extra: true });
    const missingKey = await put(app, body(), null);
    const blankKey = await put(app, body(), "   ");
    const longKey = await put(app, body(), "x".repeat(201));
    const repeated = await repeatedIdempotencyRequest(app, body());

    expect([
      malformedProperty.statusCode,
      malformedBody.statusCode,
      missingKey.statusCode,
      blankKey.statusCode,
      longKey.statusCode,
      repeated.statusCode,
    ]).toEqual([400, 400, 400, 400, 400, 400]);
    expect(ports.commands).toHaveLength(0);
  });
});

async function put(
  app: Awaited<ReturnType<typeof testApp>>,
  payload: unknown = body(),
  idempotencyKey: string | null = "command-key",
  requestedPropertyId = propertyId,
) {
  return injectJson(app, {
    method: "PUT",
    url: `/finance/properties/${requestedPropertyId}/payment-methods`,
    headers: {
      authorization: "Bearer valid-token",
      ...(idempotencyKey === null ? {} : { "idempotency-key": idempotencyKey }),
    },
    payload: payload as Record<string, unknown>,
  });
}

async function repeatedIdempotencyRequest(
  app: Awaited<ReturnType<typeof testApp>>,
  value: unknown,
) {
  const payload = JSON.stringify(value);
  await app.listen({ host: "127.0.0.1", port: 0 });
  const address = app.server.address();
  if (!address || typeof address === "string") throw new Error("Test server did not bind");
  return new Promise<{ statusCode: number; body: Record<string, unknown> }>((resolve, reject) => {
    const request = httpRequest(
      {
        host: "127.0.0.1",
        port: address.port,
        path: `/finance/properties/${propertyId}/payment-methods`,
        method: "PUT",
        headers: {
          authorization: "Bearer valid-token",
          "content-type": "application/json",
          "content-length": String(Buffer.byteLength(payload)),
          "idempotency-key": ["first", "second"],
        },
      },
      (response) => {
        let responseBody = "";
        response.setEncoding("utf8");
        response.on("data", (chunk) => (responseBody += chunk));
        response.on("end", () =>
          resolve({
            statusCode: response.statusCode ?? 0,
            body: responseBody ? (JSON.parse(responseBody) as Record<string, unknown>) : {},
          }),
        );
      },
    );
    request.on("error", reject);
    request.end(payload);
  });
}
