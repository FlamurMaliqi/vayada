import type { RequestContext } from "@vayada/backend-auth";
import Fastify from "fastify";
import { afterEach, describe, expect, it } from "vitest";

import {
  registerPmsOperationsRoutes,
  type PmsManualCancellationCommand,
  type PmsOperationsCommandRepository,
  type PmsOperationsReadRepository,
} from "./routes/pmsOperations.js";

const propertyId = "83000000-0000-4000-8000-000000000001";
const bookingId = "83000000-0000-4000-8000-000000000002";
const organizationId = "83000000-0000-4000-8000-000000000003";
const actorId = "83000000-0000-4000-8000-000000000004";
const now = "2026-08-13T10:00:00.000Z";
type State = { calls: PmsManualCancellationCommand[] };
type Auth = Partial<{
  token: boolean;
  operationsPermission: boolean;
  entitlement: "missing" | "inactive";
  resource: boolean;
  financePermission: boolean;
  financeEntitlement: boolean;
  relationship: "operator" | "owner" | "finance_manager";
}>;

describe("manual booking cancellation route", () => {
  let app: Awaited<ReturnType<typeof testApp>> | undefined;
  afterEach(async () => app?.close());

  it("cancels without a retained charge for an authorized operator", async () => {
    const state: State = { calls: [] };
    app = await testApp(state, { financePermission: false, financeEntitlement: false });
    const response = await request(app, body());
    expect(response.statusCode).toBe(200);
    expect(state.calls[0]).toMatchObject({
      propertyId,
      guestBookingId: bookingId,
      accountingDate: null,
      retainedCharges: [],
      audit: { actor: { userId: actorId, organizationId }, requestId: "request-1" },
    });
  });

  it.each([undefined, "   ", "Hello\r\n\r\nContact us <help@example.test>"])(
    "keeps the optional guest message separate from the private reason: %s",
    async (guestMessage) => {
      const state: State = { calls: [] };
      app = await testApp(state);
      expect((await request(app, { ...body(), guestMessage })).statusCode).toBe(200);
      expect(state.calls[0]?.reason).toBe("property cancellation");
      expect(state.calls[0]?.guestMessage).toBe(
        guestMessage?.replace(/\r\n/g, "\n").trim() || undefined,
      );
    },
  );

  it("requires Finance authorization before accepting explicit retained revenue", async () => {
    const denied: State = { calls: [] };
    app = await testApp(denied, { financePermission: false, financeEntitlement: false });
    expect((await request(app, body(true))).statusCode).toBe(403);
    expect(denied.calls).toEqual([]);
    await app.close();

    const allowed: State = { calls: [] };
    app = await testApp(allowed, { relationship: "owner" });
    expect((await request(app, body(true))).statusCode).toBe(200);
    expect(allowed.calls[0]?.retainedCharges).toEqual([
      {
        linePosition: 1,
        stayDate: "2026-08-13",
        amount: { amountDecimal: "25.00", currency: "EUR" },
      },
    ]);
  });

  it.each([
    ["query alias", body(), "?channel=direct"],
    ["unknown body field", { ...body(), channel: "direct" }, ""],
    ["oversized command metadata", { ...body(), commandId: "x".repeat(201) }, ""],
    ["missing internal reason", { ...body(), reason: undefined }, ""],
    ["blank internal reason", { ...body(), reason: "  " }, ""],
    ["non-text internal reason", { ...body(), reason: 42 }, ""],
    ["non-text guest message", { ...body(), guestMessage: 42 }, ""],
    ["oversized guest message", { ...body(), guestMessage: "x".repeat(5001) }, ""],
    ["oversized reason", { ...body(), reason: "x".repeat(1001) }, ""],
    [
      "oversized retained-charge list",
      { ...body(true), retainedCharges: Array(20 * 366 + 1).fill(body(true).retainedCharges[0]) },
      "",
    ],
    ["charge without accounting date", { ...body(true), accountingDate: null }, ""],
    [
      "zero retained charge",
      {
        ...body(true),
        retainedCharges: [
          { ...body(true).retainedCharges[0], amount: { amountDecimal: "0.00", currency: "EUR" } },
        ],
      },
      "",
    ],
  ])("rejects %s", async (_name, payload, query) => {
    const state: State = { calls: [] };
    app = await testApp(state, { relationship: "owner" });
    expect((await request(app, payload, query)).statusCode).toBe(400);
    expect(state.calls).toEqual([]);
  });

  it.each([
    [{ token: false }, 401],
    [{ operationsPermission: false }, 403],
    [{ entitlement: "missing" }, 403],
    [{ entitlement: "inactive" }, 403],
    [{ resource: false }, 403],
  ] as const)("denies unauthorized guest-message cancellation %j", async (auth, status) => {
    const state: State = { calls: [] };
    app = await testApp(state, auth);
    expect((await request(app, { ...body(), guestMessage: "Hello" })).statusCode).toBe(status);
    expect(state.calls).toEqual([]);
  });

  it("authorizes before parsing malformed cancellation evidence", async () => {
    const state: State = { calls: [] };
    app = await testApp(state, { token: false });
    expect((await request(app, { retainedCharges: "invalid" })).statusCode).toBe(401);
    expect(state.calls).toEqual([]);
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
          ...(auth.operationsPermission === false ? [] : ["pms.operations.manage"]),
          ...(auth.financePermission === false ? [] : ["pms.finance.manage"]),
        ],
      },
      entitlements: [
        ...(auth.entitlement === "missing"
          ? []
          : [
              {
                product: "pms",
                key: "property-management",
                status: auth.entitlement === "inactive" ? "inactive" : "active",
                resource: { product: "pms", resourceType: "pms_property", resourceId: propertyId },
              },
            ]),
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
      linkedResources:
        auth.resource === false
          ? []
          : [
              {
                product: "pms",
                resourceType: "pms_property",
                resourceId: propertyId,
                relationship: auth.relationship ?? "operator",
                status: "active",
              },
            ],
      audit: { requestId: "request-1", source: "api", receivedAt: now },
    } as RequestContext;
  });
  await app.register(registerPmsOperationsRoutes, {
    repository: { async close() {} } as unknown as PmsOperationsReadRepository,
    commandRepository: commandPort(state),
  });
  return app;
}

function commandPort(state: State): PmsOperationsCommandRepository {
  return {
    async cancelManualBooking(command: PmsManualCancellationCommand) {
      state.calls.push(command);
      return {
        ok: true,
        reservation: { guestBookingId: command.guestBookingId } as never,
        commandMeta: {
          contractVersion: "pms-operations.v1",
          commandId: command.commandId,
          idempotencyKey: command.idempotencyKey,
          acceptedAt: now,
          sideEffects: ["audit_event"],
        },
      };
    },
    async close() {},
  } as unknown as PmsOperationsCommandRepository;
}

function body(retained = false) {
  return {
    commandId: "cancel-command",
    idempotencyKey: "cancel-key",
    reason: "property cancellation",
    accountingDate: retained ? "2026-08-13" : null,
    retainedCharges: retained
      ? [
          {
            linePosition: 1,
            stayDate: "2026-08-13",
            amount: { amountDecimal: "25.00", currency: "EUR" },
          },
        ]
      : [],
  };
}

async function request(app: Awaited<ReturnType<typeof testApp>>, payload: unknown, query = "") {
  return await app.inject({
    method: "POST",
    url: `/properties/${propertyId}/reservations/${bookingId}/cancel${query}`,
    headers: { authorization: "Bearer valid", "content-type": "application/json" },
    payload: JSON.stringify(payload),
  });
}
