import type { RequestContext } from "@vayada/backend-auth";
import Fastify from "fastify";
import { afterEach, describe, expect, it } from "vitest";

import {
  registerPmsOperationsRoutes,
  type PmsManualStayCorrectionCommand,
  type PmsOperationsCommandRepository,
  type PmsOperationsReadRepository,
} from "./routes/pmsOperations.js";

const propertyId = "85000000-0000-4000-8000-000000000001";
const bookingId = "85000000-0000-4000-8000-000000000002";
const organizationId = "85000000-0000-4000-8000-000000000003";
const actorId = "85000000-0000-4000-8000-000000000004";
const assignmentIds = [
  "85000000-0000-4000-8000-000000000005",
  "85000000-0000-4000-8000-000000000006",
];
const roomIds = ["85000000-0000-4000-8000-000000000007", "85000000-0000-4000-8000-000000000008"];
const now = "2026-08-13T10:00:00.000Z";
type State = { calls: PmsManualStayCorrectionCommand[] };
type Auth = Partial<{
  token: boolean;
  permission: boolean;
  entitlementStatus: "active" | "suspended";
  linkedPropertyId: string;
}>;

describe("manual booking stay-correction route", () => {
  let app: Awaited<ReturnType<typeof testApp>> | undefined;
  afterEach(async () => app?.close());

  it("accepts exact and explicit inferred nightly evidence for an authorized operator", async () => {
    const state: State = { calls: [] };
    app = await testApp(state);
    expect((await request(app, body())).statusCode).toBe(200);
    expect(state.calls[0]).toMatchObject({
      propertyId,
      guestBookingId: bookingId,
      accountingDate: "2026-08-13",
      stays: [
        {
          assignmentId: assignmentIds[0],
          position: 1,
          roomId: roomIds[0],
          checkIn: "2026-08-20",
          checkOut: "2026-08-22",
          nightly: [
            {
              stayDate: "2026-08-20",
              amount: { amountDecimal: "100.00", currency: "EUR" },
              evidenceQuality: "exact",
            },
            {
              stayDate: "2026-08-21",
              amount: { amountDecimal: "100.00", currency: "EUR" },
              evidenceQuality: "inferred",
            },
          ],
        },
      ],
      audit: { actor: { userId: actorId, organizationId }, requestId: "request-1" },
    });
  });

  it.each<[string, Auth, number]>([
    ["authentication", { token: false }, 401],
    ["permission", { permission: false }, 403],
    ["active entitlement", { entitlementStatus: "suspended" }, 403],
    ["linked property", { linkedPropertyId: roomIds[0] }, 403],
  ] as const)("requires %s before parsing", async (_name, auth, status) => {
    const state: State = { calls: [] };
    app = await testApp(state, auth);
    expect((await request(app, { stays: "invalid" })).statusCode).toBe(status);
    expect(state.calls).toEqual([]);
  });

  it.each<[string, unknown, string]>([
    ["query alias", body(), "?channel=direct"],
    ["unknown field", { ...body(), channel: "direct" }, ""],
    ["oversized metadata", { ...body(), idempotencyKey: "x".repeat(201) }, ""],
    ["invalid accounting date", { ...body(), accountingDate: "2026-02-30" }, ""],
    ["empty stays", { ...body(), stays: [] }, ""],
    ["noncontiguous positions", { ...body(), stays: [{ ...stay(1), position: 2 }] }, ""],
    ["duplicate assignments", withStays(2, { ...stay(2), assignmentId: assignmentIds[0] }), ""],
    ["equal dates", withStays(1, { ...stay(1), checkOut: "2026-08-20", nightly: [] }), ""],
    ["incomplete nights", withStays(1, { ...stay(1), nightly: stay(1).nightly.slice(0, 1) }), ""],
    [
      "wrong service date",
      withStays(1, {
        ...stay(1),
        nightly: [{ ...stay(1).nightly[0], stayDate: "2026-08-21" }, stay(1).nightly[1]],
      }),
      "",
    ],
    [
      "missing amount without missing quality",
      withStays(1, {
        ...stay(1),
        nightly: [{ ...stay(1).nightly[0], amount: null }, stay(1).nightly[1]],
      }),
      "",
    ],
    [
      "amount attached to missing evidence",
      withStays(1, {
        ...stay(1),
        nightly: [{ ...stay(1).nightly[0], evidenceQuality: "missing" }, stay(1).nightly[1]],
      }),
      "",
    ],
    [
      "noncanonical currency",
      withStays(1, {
        ...stay(1),
        nightly: [
          { ...stay(1).nightly[0], amount: { amountDecimal: "100.00", currency: "eur" } },
          stay(1).nightly[1],
        ],
      }),
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
      membership: { permissions: auth.permission === false ? [] : ["pms.operations.manage"] },
      entitlements: [
        {
          product: "pms",
          key: "property-management",
          status: auth.entitlementStatus ?? "active",
          resource: { product: "pms", resourceType: "pms_property", resourceId: propertyId },
        },
      ],
      linkedResources: [
        {
          product: "pms",
          resourceType: "pms_property",
          resourceId: auth.linkedPropertyId ?? propertyId,
          relationship: "operator",
          status: "active",
        },
      ],
      audit: { requestId: "request-1", source: "api", receivedAt: now },
    } as RequestContext;
  });
  await app.register(registerPmsOperationsRoutes, {
    repository: { async close() {} } as unknown as PmsOperationsReadRepository,
    commandRepository: {
      async correctManualBookingStays(command: PmsManualStayCorrectionCommand) {
        state.calls.push(command);
        return {
          ok: true as const,
          reservation: { guestBookingId: command.guestBookingId } as never,
          commandMeta: {
            contractVersion: "pms-operations.v1" as const,
            commandId: command.commandId,
            idempotencyKey: command.idempotencyKey,
            acceptedAt: now,
            sideEffects: [
              "calendar_refresh" as const,
              "ari_changed" as const,
              "audit_event" as const,
            ],
          },
        };
      },
      async close() {},
    } as unknown as PmsOperationsCommandRepository,
  });
  return app;
}

function stay(position: number) {
  const from = position === 1 ? "2026-08-20" : "2026-08-22";
  return {
    assignmentId: assignmentIds[position - 1],
    position,
    roomId: roomIds[position - 1],
    checkIn: from,
    checkOut: addDays(from, 2),
    nightly: [from, addDays(from, 1)].map((stayDate, index) => ({
      stayDate,
      amount: { amountDecimal: "100.00", currency: "EUR" },
      evidenceQuality: index === 0 ? "exact" : "inferred",
    })),
  };
}
function body() {
  return {
    commandId: "correct-command",
    idempotencyKey: "correct-key",
    accountingDate: "2026-08-13",
    stays: [stay(1)],
  };
}
function withStays(count: number, replacement: { position: number } & Record<string, unknown>) {
  return {
    ...body(),
    stays: Array.from({ length: count }, (_, index) =>
      index + 1 === replacement.position ? replacement : stay(index + 1),
    ),
  };
}
function addDays(value: string, days: number): string {
  const date = new Date(`${value}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}
async function request(app: Awaited<ReturnType<typeof testApp>>, payload: unknown, query = "") {
  return app.inject({
    method: "POST",
    url: `/properties/${propertyId}/reservations/${bookingId}/correct-stays${query}`,
    headers: { authorization: "Bearer valid", "content-type": "application/json" },
    payload: JSON.stringify(payload),
  });
}
