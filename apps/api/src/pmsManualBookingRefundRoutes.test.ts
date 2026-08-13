import type { RequestContext } from "@vayada/backend-auth";
import Fastify from "fastify";
import { afterEach, describe, expect, it } from "vitest";

import {
  registerPmsOperationsRoutes,
  type PmsManualRefundCommand,
  type PmsOperationsCommandRepository,
  type PmsOperationsReadRepository,
} from "./routes/pmsOperations.js";

const propertyId = "84000000-0000-4000-8000-000000000001";
const bookingId = "84000000-0000-4000-8000-000000000002";
const organizationId = "84000000-0000-4000-8000-000000000003";
const actorId = "84000000-0000-4000-8000-000000000004";
const paymentId = "84000000-0000-4000-8000-000000000005";
const evidenceId = "84000000-0000-4000-8000-000000000006";
const now = "2026-08-13T10:00:00.000Z";
type State = { calls: PmsManualRefundCommand[] };
type Auth = Partial<{
  token: boolean;
  financePermission: boolean;
  financeEntitlement: boolean;
  relationship: "operator" | "owner" | "finance_manager";
}>;

describe("manual booking refund route", () => {
  let app: Awaited<ReturnType<typeof testApp>> | undefined;
  afterEach(async () => app?.close());

  it("submits exact payment and nightly allocations for an authorized owner", async () => {
    const state: State = { calls: [] };
    app = await testApp(state);
    const response = await request(app, body());
    expect(response.statusCode).toBe(200);
    expect(state.calls[0]).toMatchObject({
      propertyId,
      guestBookingId: bookingId,
      paymentEvidenceId: paymentId,
      accountingDate: "2026-08-13",
      allocations: [{ evidenceId, amount: { amountDecimal: "25.00", currency: "EUR" } }],
      audit: { actor: { userId: actorId, organizationId }, requestId: "request-1" },
    });
  });

  it.each([
    ["operator relationship", { relationship: "operator" }],
    ["Finance permission", { financePermission: false }],
    ["Finance entitlement", { financeEntitlement: false }],
  ] as const)("denies missing %s before parsing", async (_name, auth) => {
    const state: State = { calls: [] };
    app = await testApp(state, auth);
    expect((await request(app, { allocations: "invalid" })).statusCode).toBe(403);
    expect(state.calls).toEqual([]);
    await app.close();
    app = undefined;
  });

  it("authenticates before parsing refund evidence", async () => {
    const state: State = { calls: [] };
    app = await testApp(state, { token: false });
    expect((await request(app, { allocations: "invalid" })).statusCode).toBe(401);
    expect(state.calls).toEqual([]);
  });

  it.each([
    ["query alias", body(), "?channel=direct"],
    ["unknown body field", { ...body(), channel: "direct" }, ""],
    ["oversized metadata", { ...body(), commandId: "x".repeat(201) }, ""],
    ["invalid expected version", { ...body(), expectedVersion: 42 }, ""],
    ["invalid reason", { ...body(), reason: {} }, ""],
    ["invalid payment", { ...body(), paymentEvidenceId: "payment" }, ""],
    ["invalid date", { ...body(), accountingDate: "2026-02-30" }, ""],
    ["empty allocations", { ...body(), allocations: [] }, ""],
    [
      "duplicate targets",
      { ...body(), allocations: [body().allocations[0], body().allocations[0]] },
      "",
    ],
    [
      "zero amount",
      {
        ...body(),
        allocations: [
          { ...body().allocations[0], amount: { amountDecimal: "0.00", currency: "EUR" } },
        ],
      },
      "",
    ],
    [
      "noncanonical currency",
      {
        ...body(),
        allocations: [
          { ...body().allocations[0], amount: { amountDecimal: "1.00", currency: "eur" } },
        ],
      },
      "",
    ],
  ])("rejects %s", async (_name, payload, query) => {
    const state: State = { calls: [] };
    app = await testApp(state);
    expect((await request(app, payload, query)).statusCode).toBe(400);
    expect(state.calls).toEqual([]);
    await app.close();
    app = undefined;
  });
});

async function testApp(state: State, auth: Auth = {}) {
  const app = Fastify({ logger: false });
  app.decorateRequest("authContext", null);
  app.addHook("onRequest", async (request) => {
    if (auth.token === false) return;
    request.authContext = {
      actor: { internalUserId: actorId },
      selectedOrganization: { organizationId, kind: "hotel_group" },
      membership: {
        permissions: [
          "pms.operations.manage",
          ...(auth.financePermission === false ? [] : ["pms.finance.manage"]),
        ],
      },
      entitlements: [
        {
          product: "pms",
          key: "property-management",
          status: "active",
          resource: { product: "pms", resourceType: "pms_property", resourceId: propertyId },
        },
        ...(auth.financeEntitlement === false
          ? []
          : [
              {
                product: "booking",
                key: "direct-booking-finance",
                status: "active" as const,
                resource: {
                  product: "pms",
                  resourceType: "pms_property",
                  resourceId: propertyId,
                },
              },
            ]),
      ],
      linkedResources: [
        {
          product: "pms",
          resourceType: "pms_property",
          resourceId: propertyId,
          relationship: auth.relationship ?? "owner",
          status: "active",
        },
      ],
      audit: { requestId: "request-1", source: "api", receivedAt: now },
    } as RequestContext;
  });
  await app.register(registerPmsOperationsRoutes, {
    repository: { async close() {} } as unknown as PmsOperationsReadRepository,
    commandRepository: {
      async refundManualBooking(command: PmsManualRefundCommand) {
        state.calls.push(command);
        return {
          ok: true as const,
          reservation: { guestBookingId: command.guestBookingId } as never,
          commandMeta: {
            contractVersion: "pms-operations.v1" as const,
            commandId: command.commandId,
            idempotencyKey: command.idempotencyKey,
            acceptedAt: now,
            sideEffects: ["audit_event" as const],
          },
        };
      },
      async close() {},
    } as unknown as PmsOperationsCommandRepository,
  });
  return app;
}

function body() {
  return {
    commandId: "refund-command",
    idempotencyKey: "refund-key",
    paymentEvidenceId: paymentId,
    accountingDate: "2026-08-13",
    reason: "guest refund",
    allocations: [{ evidenceId, amount: { amountDecimal: "25.00", currency: "EUR" } }],
  };
}

async function request(app: Awaited<ReturnType<typeof testApp>>, payload: unknown, query = "") {
  return await app.inject({
    method: "POST",
    url: `/properties/${propertyId}/reservations/${bookingId}/refund${query}`,
    headers: { authorization: "Bearer valid", "content-type": "application/json" },
    payload: JSON.stringify(payload),
  });
}
