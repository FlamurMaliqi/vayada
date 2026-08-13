import type { RequestContext } from "@vayada/backend-auth";
import Fastify from "fastify";
import { afterEach, describe, expect, it } from "vitest";

import {
  registerPmsOperationsRoutes,
  type PmsManualPriceCorrectionCommand,
  type PmsOperationsCommandRepository,
  type PmsOperationsReadRepository,
} from "./routes/pmsOperations.js";

const propertyId = "86000000-0000-4000-8000-000000000001";
const bookingId = "86000000-0000-4000-8000-000000000002";
const organizationId = "86000000-0000-4000-8000-000000000003";
const actorId = "86000000-0000-4000-8000-000000000004";
const evidenceIds = [
  "86000000-0000-4000-8000-000000000005",
  "86000000-0000-4000-8000-000000000006",
];
const now = "2026-08-13T10:00:00.000Z";
type State = { calls: PmsManualPriceCorrectionCommand[] };
type Auth = Partial<{
  token: boolean;
  pmsPermission: boolean;
  financePermission: boolean;
  pmsEntitlementStatus: "active" | "suspended";
  financeEntitlementStatus: "active" | "suspended" | false;
  linkedPropertyId: string;
  relationship: "operator" | "owner";
}>;

describe("manual booking price-correction route", () => {
  let app: Awaited<ReturnType<typeof testApp>> | undefined;
  afterEach(async () => app?.close());

  it("accepts exact and expressly inferred replacements for an authorized owner", async () => {
    const state: State = { calls: [] };
    app = await testApp(state);
    expect((await request(app, exactBody())).statusCode).toBe(200);
    expect((await request(app, inferredBody())).statusCode).toBe(200);
    expect(state.calls).toMatchObject([
      {
        propertyId,
        guestBookingId: bookingId,
        accountingDate: "2026-08-13",
        reason: "Correct quoted price",
        pricing: {
          kind: "exact",
          nights: [
            {
              targetEvidenceId: evidenceIds[0],
              replacementAmount: { amountDecimal: "100.1234", currency: "EUR" },
            },
          ],
        },
        audit: { actor: { userId: actorId, organizationId }, requestId: "request-1" },
      },
      {
        pricing: {
          kind: "equal_inferred",
          targetEvidenceIds: evidenceIds,
          replacementTotal: { amountDecimal: "201.00", currency: "EUR" },
        },
      },
    ]);
  });

  it.each<[string, Auth, number]>([
    ["authentication", { token: false }, 401],
    ["PMS permission", { pmsPermission: false }, 403],
    ["active PMS entitlement", { pmsEntitlementStatus: "suspended" }, 403],
    ["linked property", { linkedPropertyId: bookingId }, 403],
    ["Finance permission", { financePermission: false }, 403],
    ["Finance entitlement", { financeEntitlementStatus: false }, 403],
    ["active Finance entitlement", { financeEntitlementStatus: "suspended" }, 403],
    ["Finance-capable relationship", { relationship: "operator" }, 403],
  ])("requires %s before parsing", async (_name, auth, status) => {
    const state: State = { calls: [] };
    app = await testApp(state, auth);
    expect((await request(app, { pricing: "invalid" })).statusCode).toBe(status);
    expect(state.calls).toEqual([]);
  });

  it.each<[string, unknown, string]>([
    ["query alias", exactBody(), "?channel=direct"],
    ["unknown field", { ...exactBody(), channel: "direct" }, ""],
    ["oversized metadata", { ...exactBody(), commandId: "x".repeat(201) }, ""],
    ["invalid accounting date", { ...exactBody(), accountingDate: "2026-02-30" }, ""],
    ["invalid reason", { ...exactBody(), reason: {} }, ""],
    ["unknown pricing kind", { ...exactBody(), pricing: { kind: "current" } }, ""],
    ["empty exact nights", { ...exactBody(), pricing: { kind: "exact", nights: [] } }, ""],
    [
      "duplicate exact target",
      {
        ...exactBody(),
        pricing: { kind: "exact", nights: [exactNight(), exactNight()] },
      },
      "",
    ],
    [
      "negative replacement",
      {
        ...exactBody(),
        pricing: {
          kind: "exact",
          nights: [exactNight({ amountDecimal: "-1.00", currency: "EUR" })],
        },
      },
      "",
    ],
    [
      "overprecise replacement",
      {
        ...exactBody(),
        pricing: {
          kind: "exact",
          nights: [exactNight({ amountDecimal: "1.00001", currency: "EUR" })],
        },
      },
      "",
    ],
    [
      "duplicate inferred target",
      {
        ...inferredBody(),
        pricing: {
          ...inferredBody().pricing,
          targetEvidenceIds: [evidenceIds[0], evidenceIds[0]],
        },
      },
      "",
    ],
    [
      "noncanonical inferred currency",
      {
        ...inferredBody(),
        pricing: {
          ...inferredBody().pricing,
          replacementTotal: { amountDecimal: "1.00", currency: "eur" },
        },
      },
      "",
    ],
  ])("rejects %s", async (_name, payload, query) => {
    const state: State = { calls: [] };
    app = await testApp(state);
    expect((await request(app, payload, query)).statusCode).toBe(400);
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
          ...(auth.pmsPermission === false ? [] : ["pms.operations.manage"]),
          ...(auth.financePermission === false ? [] : ["pms.finance.manage"]),
        ],
      },
      entitlements: [
        {
          product: "pms",
          key: "property-management",
          status: auth.pmsEntitlementStatus ?? "active",
          resource: { product: "pms", resourceType: "pms_property", resourceId: propertyId },
        },
        ...(auth.financeEntitlementStatus === false
          ? []
          : [
              {
                product: "booking",
                key: "direct-booking-finance",
                status: auth.financeEntitlementStatus ?? "active",
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
          resourceId: auth.linkedPropertyId ?? propertyId,
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
      async correctManualBookingPrices(command: PmsManualPriceCorrectionCommand) {
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

function exactNight(replacementAmount = { amountDecimal: "100.1234", currency: "EUR" }) {
  return { targetEvidenceId: evidenceIds[0], replacementAmount };
}
function exactBody() {
  return {
    commandId: "correct-price-command",
    idempotencyKey: "correct-price-key",
    accountingDate: "2026-08-13",
    reason: "Correct quoted price",
    pricing: { kind: "exact", nights: [exactNight()] },
  };
}
function inferredBody() {
  return {
    ...exactBody(),
    commandId: "infer-price-command",
    idempotencyKey: "infer-price-key",
    pricing: {
      kind: "equal_inferred",
      targetEvidenceIds: evidenceIds,
      replacementTotal: { amountDecimal: "201.00", currency: "EUR" },
    },
  };
}
async function request(app: Awaited<ReturnType<typeof testApp>>, payload: unknown, query = "") {
  return app.inject({
    method: "POST",
    url: `/properties/${propertyId}/reservations/${bookingId}/correct-prices${query}`,
    headers: { authorization: "Bearer valid", "content-type": "application/json" },
    payload: JSON.stringify(payload),
  });
}
