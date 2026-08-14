import type { RequestContext } from "@vayada/backend-auth";
import {
  PMS_MANUAL_BOOKING_DIRECT_SOURCES,
  PmsManualBookingCreateError,
  type PmsManualBookingCreateCommand,
  type PmsManualBookingCreatePort,
  type PmsManualBookingCreateResult,
} from "@vayada/domain-pms";
import Fastify from "fastify";
import { afterEach, describe, expect, it } from "vitest";

import { buildApp } from "./app.js";
import {
  registerPmsManualBookingCapabilityRoutes,
  registerPmsManualBookingCreateRoutes,
} from "./routes/pmsManualBookingCreate.js";

const propertyId = "81000000-0000-4000-8000-000000000001";
const organizationId = "81000000-0000-4000-8000-000000000002";
const actorId = "81000000-0000-4000-8000-000000000003";
const roomId = "81000000-0000-4000-8000-000000000004";
const now = "2026-08-12T20:00:00.000Z";

type State = {
  calls: PmsManualBookingCreateCommand[];
  outcome?: "created" | "replayed";
  error?: PmsManualBookingCreateError;
};
type Auth = Partial<{
  token: boolean;
  operationsPermission: boolean;
  financePermission: boolean;
  pmsEntitlement: boolean;
  financeEntitlement: boolean;
  relationship: string;
  organizationKind: "hotel_group" | "creator_workspace";
}>;

describe("target manual-booking create route", () => {
  let app: Awaited<ReturnType<typeof testApp>> | undefined;
  afterEach(async () => app?.close());

  it("mounts the capability route without activating the create command runtime", async () => {
    app = buildApp({ logger: false });
    const capability = await app.inject({
      method: "GET",
      url: `/api/pms/properties/${propertyId}/manual-bookings/capabilities`,
    });
    expect(capability.statusCode).toBe(401);
    const create = await app.inject({
      method: "POST",
      url: `/api/pms/properties/${propertyId}/manual-bookings`,
    });
    expect(create.statusCode).toBe(404);
  });

  it("mounts the protected create route when the production command runtime is enabled", async () => {
    app = buildApp({
      logger: false,
      pmsManualBookingCreate: {
        command: {
          async createManualBooking() {
            throw new Error("unauthorized request reached command port");
          },
        },
      },
    });
    const response = await app.inject({
      method: "POST",
      url: `/api/pms/properties/${propertyId}/manual-bookings`,
    });
    expect(response.statusCode).toBe(401);
  });

  it("projects only the Paid capability for an authorized owner", async () => {
    app = await testApp({ calls: [] }, { relationship: "owner" });
    const response = await capabilities(app);
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      contractVersion: "pms-manual-booking.v1",
      canRecordPaidPayment: true,
    });
  });

  it.each([
    { financePermission: false, relationship: "owner" },
    { financeEntitlement: false, relationship: "owner" },
    { relationship: "operator" },
  ] as const)("fails the Paid capability closed without the full Finance policy", async (auth) => {
    app = await testApp({ calls: [] }, auth);
    const response = await capabilities(app);
    expect(response.json()).toEqual({
      contractVersion: "pms-manual-booking.v1",
      canRecordPaidPayment: false,
    });
  });

  it("enforces base authorization and property scope before capability evaluation", async () => {
    app = await testApp({ calls: [] });
    const unauthenticated = await capabilities(app, "not-a-property", {});
    expect(unauthenticated.json()).toMatchObject({ code: "unauthenticated" });
    const wrongProperty = await capabilities(app, "81000000-0000-4000-8000-000000000099");
    expect(wrongProperty.statusCode).toBe(403);
    const queryAlias = await capabilities(app, propertyId, headers(), "?permission=true");
    expect(queryAlias.json()).toMatchObject({ code: "unknown_field" });
  });

  it("creates an unpaid booking for an operator without Finance access", async () => {
    const state: State = { calls: [] };
    app = await testApp(state, { financePermission: false, financeEntitlement: false });
    const response = await request(app, command("unpaid", "cash"));
    expect(response.statusCode).toBe(201);
    expect(state.calls).toHaveLength(1);
    expect(state.calls[0]).toMatchObject({
      propertyId,
      organizationId,
      directSource: "email",
      audit: {
        actor: { userId: actorId, organizationId },
        requestId: "request-1",
        requestedAt: now,
      },
    });
  });

  it.each(["pay_at_property", "bank_transfer", "manual_card", "cash", "other"] as const)(
    "accepts %s as paid and unpaid expected intent",
    async (method) => {
      for (const status of ["unpaid", "paid"] as const) {
        const state: State = { calls: [] };
        app = await testApp(state, { relationship: "owner" });
        const response = await request(app, command(status, method));
        expect(response.statusCode).toBe(201);
        expect(state.calls[0]?.payment).toMatchObject({
          expectedMethod: method,
          settlement: { status },
        });
        await app.close();
        app = undefined;
      }
    },
  );

  it.each(PMS_MANUAL_BOOKING_DIRECT_SOURCES)(
    "accepts canonical source %s",
    async (directSource) => {
      const state: State = { calls: [] };
      app = await testApp(state);
      const payload = command("unpaid", "cash");
      payload.directSource = directSource;
      const response = await request(app, payload);
      expect(response.statusCode).toBe(201);
      expect(state.calls[0]?.directSource).toBe(directSource);
    },
  );

  it.each([
    ["unauthenticated", { token: false }],
    ["forbidden", { operationsPermission: false }],
    ["entitlement_required", { pmsEntitlement: false }],
    ["forbidden", { relationship: "viewer" }],
    ["forbidden", { organizationKind: "creator_workspace" }],
  ] as const)("denies %s before the command port", async (code, auth) => {
    const state: State = { calls: [] };
    app = await testApp(state, auth);
    const response = await request(
      app,
      command("unpaid", "cash"),
      "token" in auth && auth.token === false ? { "content-type": "application/json" } : headers(),
    );
    expect(response.json()).toMatchObject({ code });
    expect(state.calls).toEqual([]);
  });

  it.each([
    { financePermission: false },
    { financeEntitlement: false },
    { relationship: "operator" },
  ] as const)("denies paid without the full Finance policy", async (auth) => {
    const state: State = { calls: [] };
    app = await testApp(state, auth);
    const response = await request(app, command("paid", "cash"));
    expect([response.statusCode, response.json().code]).toEqual([403, "paid_forbidden"]);
    expect(state.calls).toEqual([]);
  });

  it.each([
    ["channel", "booking_com", "invalid_source"],
    ["bookingChannel", "direct", "invalid_source"],
    ["directSource", "booking_engine", "invalid_source"],
    ["unexpected", true, "unknown_field"],
  ] as const)("rejects injected %s before the command port", async (field, value, code) => {
    const state: State = { calls: [] };
    app = await testApp(state);
    const payload = command("unpaid", "cash") as any;
    payload[field] = value;
    const response = await request(app, payload);
    expect(response.json()).toMatchObject({ code });
    expect(state.calls).toEqual([]);
  });

  it("rejects query-string aliases after authorization", async () => {
    const state: State = { calls: [] };
    app = await testApp(state);
    const response = await request(app, command("unpaid", "cash"), headers(), "?channel=direct");
    expect([response.statusCode, response.json().code, state.calls]).toEqual([
      400,
      "unknown_field",
      [],
    ]);
  });

  it("returns an exact replay as 200", async () => {
    const state: State = { calls: [], outcome: "replayed" };
    app = await testApp(state);
    const response = await request(app, command("unpaid", "cash"));
    expect([response.statusCode, response.json().outcome]).toEqual([200, "replayed"]);
  });

  it("maps command conflicts without leaking internal errors", async () => {
    const state: State = {
      calls: [],
      error: new PmsManualBookingCreateError("room_unavailable", "roomId", 1),
    };
    app = await testApp(state);
    const response = await request(app, command("unpaid", "cash"));
    expect(response.statusCode).toBe(409);
    expect(response.json()).toEqual({
      code: "room_unavailable",
      message: "room unavailable.",
      field: "roomId",
      stayPosition: 1,
    });
  });
});

async function testApp(state: State, auth: Auth = {}) {
  const app = Fastify({ logger: false });
  app.decorateRequest("authContext", null);
  app.addHook("onRequest", async (request) => {
    if (request.headers.authorization !== "Bearer valid" || auth.token === false) return;
    request.authContext = {
      actor: { internalUserId: actorId },
      selectedOrganization: {
        organizationId,
        kind: auth.organizationKind ?? "hotel_group",
      },
      membership: {
        permissions: [
          ...(auth.operationsPermission === false ? [] : ["pms.operations.manage"]),
          ...(auth.financePermission === false ? [] : ["pms.finance.manage"]),
        ],
      },
      entitlements: [
        ...(auth.pmsEntitlement === false
          ? []
          : [
              {
                product: "pms",
                key: "property-management",
                status: "active",
                resource: { product: "pms", resourceType: "pms_property", resourceId: propertyId },
              },
            ]),
        ...(auth.financeEntitlement === false
          ? []
          : [
              {
                product: "booking",
                key: "direct-booking-finance",
                status: "active",
                resource: { product: "pms", resourceType: "pms_property", resourceId: propertyId },
              },
            ]),
      ],
      linkedResources: [
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
  await app.register(registerPmsManualBookingCapabilityRoutes);
  await app.register(registerPmsManualBookingCreateRoutes, { command: port(state) });
  return app;
}

function port(state: State): PmsManualBookingCreatePort {
  return {
    async createManualBooking(input) {
      state.calls.push(input);
      if (state.error) throw state.error;
      return result(input, state.outcome ?? "created");
    },
  };
}

function result(
  input: PmsManualBookingCreateCommand,
  outcome: "created" | "replayed",
): PmsManualBookingCreateResult {
  const paid = input.payment.settlement.status === "paid";
  return {
    contractVersion: input.contractVersion,
    outcome,
    commandId: input.commandId,
    idempotencyKey: input.idempotencyKey,
    guestBookingId: "81000000-0000-4000-8000-000000000005",
    bookingReference: "PMS-TEST",
    bookingChannel: "direct",
    directSource: input.directSource,
    stayCount: 1,
    checkIn: "2027-01-01",
    checkOut: "2027-01-03",
    total: { amountDecimal: "200.00", currency: "EUR" },
    balance: { amountDecimal: paid ? "0.00" : "200.00", currency: "EUR" },
    paymentStatus: paid ? "paid" : "unpaid",
    paymentEvidenceId: paid ? "81000000-0000-4000-8000-000000000006" : null,
    sideEffects: ["calendar_refresh", "ari_changed", "guest_confirmation", "audit_event"],
  };
}

function command(status: "paid" | "unpaid", expectedMethod: string) {
  return {
    contractVersion: "pms-manual-booking.v1",
    commandId: "command-1",
    idempotencyKey: "idempotency-1",
    guest: {
      firstName: "Ada",
      lastName: "Lovelace",
      email: "ada@example.com",
      phoneE164: "+306900000000",
      countryCode: "GR",
      specialRequests: "Quiet room",
    },
    privateNote: "VIP",
    directSource: "email",
    stays: [
      {
        position: 1,
        roomId,
        checkIn: "2027-01-01",
        checkOut: "2027-01-03",
        adults: 2,
        children: 0,
        ratePlanId: null,
        pricing: {
          kind: "custom",
          nightlyAmount: { amountDecimal: "100.00", currency: "EUR" },
        },
      },
    ],
    addOns: [],
    payment: {
      expectedMethod,
      settlement: status === "paid" ? { status, reference: "desk-1" } : { status },
    },
  };
}

function headers(): Record<string, string> {
  return { authorization: "Bearer valid", "content-type": "application/json" };
}

async function request(
  app: Awaited<ReturnType<typeof testApp>>,
  payload: unknown,
  requestHeaders: Record<string, string> = headers(),
  query = "",
) {
  return app.inject({
    method: "POST",
    url: `/properties/${propertyId}/manual-bookings${query}`,
    headers: requestHeaders,
    payload: payload as object,
  });
}

async function capabilities(
  app: Awaited<ReturnType<typeof testApp>>,
  requestedPropertyId = propertyId,
  requestHeaders: Record<string, string> = headers(),
  query = "",
) {
  return app.inject({
    method: "GET",
    url: `/properties/${requestedPropertyId}/manual-bookings/capabilities${query}`,
    headers: requestHeaders,
  });
}
