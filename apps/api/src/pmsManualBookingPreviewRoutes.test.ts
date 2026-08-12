import type { RequestContext } from "@vayada/backend-auth";
import Fastify from "fastify";
import { afterEach, describe, expect, it } from "vitest";

import {
  registerPmsManualBookingPreviewRoutes,
  type PmsManualBookingPreviewRoutesOptions,
} from "./routes/pmsManualBookingPreview.js";

const ids = (group: number, count: number) =>
  Array.from(
    { length: count },
    (_, index) => `71000000-0000-4000-8000-${String(group * 10 + index).padStart(12, "0")}`,
  );
const [propertyId, organizationId, roomTypeId, planId] = ids(1, 4) as [
  string,
  string,
  string,
  string,
];
const roomIds = ids(2, 3),
  addonIds = ids(3, 4),
  now = "2026-08-12T12:00:00.000Z";
type State = {
  reads: string[];
  unavailable?: boolean;
  capacityUnavailable?: boolean;
  childrenEnabled?: boolean;
  currency?: string;
  missingProperty?: boolean;
  inactivePlan?: boolean;
};
type Auth = Partial<Record<"token" | "permission" | "entitlement" | "link", boolean>>;
type ScopedAuth = Auth & {
  organizationKind?: "hotel_group" | "creator_workspace";
  entitlementResourceId?: string;
  linkResourceId?: string;
  relationship?: string;
};

describe("target manual-booking preview", () => {
  let app: Awaited<ReturnType<typeof testApp>> | undefined;
  afterEach(async () => app?.close());

  it("prices heterogeneous stays and every add-on model without write ports", async () => {
    const state: State = { reads: [] };
    app = await testApp(state);
    const response = await request(app, command()),
      body = response.json();
    expect(response.statusCode).toBe(200);
    expect(
      body.stays.map((stay: any) => [
        stay.standardTotal?.amountDecimal ?? null,
        stay.appliedTotal.amountDecimal,
      ]),
    ).toEqual([
      ["250.00", "250.00"],
      [null, "160.00"],
      ["340.00", "180.00"],
    ]);
    expect(
      body.addOns.map((addon: any) => [addon.pricingModel, addon.total.amountDecimal]),
    ).toEqual([
      ["per_stay", "20.00"],
      ["per_guest", "25.00"],
      ["per_night", "8.00"],
      ["per_guest_night", "48.00"],
    ]);
    expect(body.grandTotal).toEqual({ amountDecimal: "691.00", currency: "EUR" });
    expect(state.reads).toEqual(["rooms", "types", "pricing", "addons", "policy", "available"]);
  });

  it.each([
    [false, "150.00"],
    [true, "155.00"],
  ])("applies child policy %s to additional-guest pricing", async (childrenEnabled, total) => {
    app = await testApp({ reads: [], childrenEnabled });
    const payload = command();
    payload.stays = [
      {
        ...payload.stays[0],
        checkIn: "2027-07-05",
        checkOut: "2027-07-06",
        adults: 1,
        children: 1,
      },
    ];
    payload.addOns = [];
    const response = await request(app, payload);
    expect(response.statusCode).toBe(200);
    expect(response.json().stays[0].standardTotal.amountDecimal).toBe(total);
  });

  it("evaluates overlapping room selections as one capacity request", async () => {
    app = await testApp({ reads: [], capacityUnavailable: true });
    const response = await request(app, command());
    expect([response.statusCode, response.json().code]).toEqual([409, "room_unavailable"]);
  });

  it.each([
    ["unauthenticated", { token: false }],
    ["forbidden", { permission: false }],
    ["entitlement_required", { entitlement: false }],
    ["forbidden", { link: false }],
    ["entitlement_required", { entitlementResourceId: ids(5, 1)[0] }],
    ["forbidden", { linkResourceId: ids(5, 1)[0] }],
    ["forbidden", { relationship: "viewer" }],
    ["forbidden", { organizationKind: "creator_workspace" }],
  ] as const)("denies %s before reads", async (code, auth) => {
    const state: State = { reads: [] };
    app = await testApp(state, auth);
    const response = await request(
      app,
      command(),
      "token" in auth && auth.token === false ? { "content-type": "application/json" } : headers(),
    );
    expect(response.json()).toMatchObject({ code });
    expect(state.reads).toEqual([]);
  });

  const errorCases: [number, string, (body: any) => void, Partial<State>][] = [
    [400, "unknown_field", (body: any) => (body.channel = "ota"), {}],
    [404, "property_not_found", () => undefined, { missingProperty: true }],
    [404, "room_not_found", (body: any) => (body.stays[0].roomId = propertyId), {}],
    [422, "invalid_dates", (body: any) => (body.stays[0].checkOut = "2027-06-29"), {}],
    [422, "occupancy_exceeded", (body: any) => (body.stays[0].adults = 5), {}],
    [422, "occupancy_exceeded", (body: any) => (body.stays[0].adults = 0), {}],
    [404, "rate_plan_not_found", (body: any) => (body.stays[0].ratePlanId = propertyId), {}],
    [422, "inactive_rate_plan", () => undefined, { inactivePlan: true }],
    [409, "room_unavailable", () => undefined, { unavailable: true }],
    [409, "room_unavailable", (body: any) => (body.stays[1].roomId = body.stays[0].roomId), {}],
    [422, "currency_mismatch", () => undefined, { currency: "USD" }],
    [404, "addon_not_found", (body: any) => (body.addOns[0].addonId = propertyId), {}],
    [422, "invalid_addon_selection", (body: any) => (body.addOns[0].packageCount = 0), {}],
    [
      422,
      "invalid_addon_selection",
      (body: any) => (body.addOns[0].serviceUnits[0].serviceDate = "2027-07-01"),
      {},
    ],
    [
      422,
      "invalid_addon_selection",
      (body: any) => (body.addOns[1].serviceUnits[0].guestCount = null),
      {},
    ],
    [
      422,
      "invalid_addon_selection",
      (body: any) => (body.addOns[1].serviceUnits[0].guestCount = 0),
      {},
    ],
    [
      422,
      "invalid_addon_selection",
      (body: any) => (body.addOns[2].serviceUnits[0].guestCount = 1),
      {},
    ],
    [
      422,
      "invalid_addon_selection",
      (body: any) => (body.addOns[3].serviceUnits[0].guestCount = null),
      {},
    ],
  ];
  it.each(errorCases)("returns %s %s", async (status, code, mutate, override) => {
    const payload = command();
    mutate(payload);
    app = await testApp({ reads: [], ...override });
    const response = await request(app, payload);
    expect([response.statusCode, response.json().code]).toEqual([status, code]);
  });
});

async function testApp(state: State, auth: ScopedAuth = {}) {
  const app = Fastify({ logger: false });
  app.decorateRequest("authContext", null);
  app.addHook("onRequest", async (request) => {
    if (request.headers.authorization !== "Bearer valid" || auth.token === false) return;
    request.authContext = {
      actor: { internalUserId: ids(4, 1)[0] },
      selectedOrganization: { organizationId, kind: auth.organizationKind ?? "hotel_group" },
      membership: { permissions: auth.permission === false ? [] : ["pms.operations.manage"] },
      entitlements:
        auth.entitlement === false
          ? []
          : [
              {
                product: "pms",
                key: "property-management",
                status: "active",
                resource: {
                  product: "pms",
                  resourceType: "pms_property",
                  resourceId: auth.entitlementResourceId ?? propertyId,
                },
              },
            ],
      linkedResources:
        auth.link === false
          ? []
          : [
              {
                product: "pms",
                resourceType: "pms_property",
                resourceId: auth.linkResourceId ?? propertyId,
                relationship: auth.relationship ?? "operator",
                status: "active",
              },
            ],
      audit: { requestId: "request-1", source: "api", receivedAt: now },
    } as RequestContext;
  });
  await app.register(registerPmsManualBookingPreviewRoutes, ports(state));
  return app;
}

function ports(state: State): PmsManualBookingPreviewRoutesOptions {
  const read = (name: string) => state.reads.push(name),
    money = { amountDecimal: "100.00", currency: "EUR" };
  return {
    pms: {
      async listRoomsByPropertyId() {
        read("rooms");
        return { items: roomIds.map((roomId) => ({ roomId, roomTypeId })) } as any;
      },
      async listRoomTypesByPropertyId() {
        read("types");
        return {
          items: [
            {
              roomTypeId,
              active: true,
              occupancyLimits: { adults: 4, children: 4, total: 4 },
              ratePlans: [{ ratePlanId: planId, baseRate: money, active: !state.inactivePlan }],
            },
          ],
        } as any;
      },
      async getPhysicalRoomAvailability(_propertyId, stays) {
        read("available");
        if (state.capacityUnavailable) expect(stays).toHaveLength(3);
        return stays.map((_, index) =>
          state.unavailable || (state.capacityUnavailable && index === 1) ? false : true,
        );
      },
    },
    pricing: {
      async getRecurringPricingBookingEvidence() {
        read("pricing");
        if (state.missingProperty) return null;
        return {
          propertyId,
          currency: "EUR",
          sources: [
            {
              sourceKind: "season",
              lifecycle: "active",
              startMonthDay: "07-01",
              endMonthDay: "08-31",
              roomPrices: [{ roomTypeId, flexibleRatePlanId: planId, amountDecimal: "150.00" }],
            },
            {
              sourceKind: "weekend_surcharge",
              lifecycle: "active",
              weekdays: ["friday", "saturday"],
              roomSurcharges: [{ roomTypeId, flexibleRatePlanId: planId, amountDecimal: "10.00" }],
            },
            {
              sourceKind: "additional_guest",
              lifecycle: "active",
              roomTypeId,
              flexibleRatePlanId: planId,
              includedGuests: 1,
              amountDecimal: "5.00",
            },
          ],
        } as any;
      },
    },
    booking: {
      async getCurrentGuestPolicy() {
        read("policy");
        return {
          bundle: {
            rates: [
              {
                roomTypeId,
                flexible: { source: { entityId: planId } },
                additionalGuest: {
                  countedGuestTypes:
                    state.childrenEnabled === false ? ["adult"] : ["adult", "child"],
                },
              },
            ],
          },
        } as any;
      },
      async listAddonItemsByHotelId() {
        read("addons");
        return addonIds.map((addonItemId, index) => ({
          addonItemId,
          propertyId,
          price: ["10.00", "5.00", "4.00", "2.00"][index],
          currency: state.currency ?? "EUR",
          pricingModel: ["per_stay", "per_guest", "per_night", "per_guest_night"][index],
          status: "active",
        })) as any;
      },
    },
  };
}

function command(): any {
  const stay = (
    position: number,
    roomId: string,
    checkIn: string,
    checkOut: string,
    adults: number,
    pricing: any,
    ratePlanId: string | null = planId,
  ) => ({ position, roomId, checkIn, checkOut, adults, children: 0, ratePlanId, pricing });
  return {
    contractVersion: "pms-manual-booking.v1",
    stays: [
      stay(1, roomIds[0]!, "2027-06-30", "2027-07-02", 1, {
        kind: "rate_plan",
        manualOverride: null,
      }),
      stay(
        2,
        roomIds[1]!,
        "2027-07-01",
        "2027-07-03",
        2,
        { kind: "custom", nightlyAmount: { amountDecimal: "80", currency: "EUR" } },
        null,
      ),
      stay(3, roomIds[2]!, "2027-07-02", "2027-07-04", 3, {
        kind: "rate_plan",
        manualOverride: { amountDecimal: "90", currency: "EUR" },
      }),
    ],
    addOns: [
      {
        addonId: addonIds[0],
        packageCount: 2,
        serviceUnits: [{ serviceDate: null, guestCount: null }],
      },
      {
        addonId: addonIds[1],
        packageCount: 1,
        serviceUnits: [{ serviceDate: null, guestCount: 5 }],
      },
      {
        addonId: addonIds[2],
        packageCount: 1,
        serviceUnits: [
          { serviceDate: "2027-06-30", guestCount: null },
          { serviceDate: "2027-07-02", guestCount: null },
        ],
      },
      {
        addonId: addonIds[3],
        packageCount: 2,
        serviceUnits: [
          ["2027-06-30", 1],
          ["2027-07-01", 3],
          ["2027-07-02", 5],
          ["2027-07-03", 3],
        ].map(([serviceDate, guestCount]) => ({ serviceDate, guestCount })),
      },
    ],
  };
}

function headers() {
  return { authorization: "Bearer valid", "content-type": "application/json" };
}
function request(
  app: Awaited<ReturnType<typeof testApp>>,
  body: unknown,
  customHeaders: Record<string, string> = headers(),
) {
  return app.inject({
    method: "POST",
    url: `/properties/${propertyId}/manual-bookings/preview`,
    headers: customHeaders,
    payload: JSON.stringify(body),
  });
}
