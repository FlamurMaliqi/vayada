import type { RequestContext } from "@vayada/backend-auth";
import { createBookingPricingSourceFingerprint } from "@vayada/domain-booking";
import Fastify from "fastify";
import { afterEach, describe, expect, it } from "vitest";

import {
  registerPmsManualBookingPreviewRoutes,
  type PmsManualBookingPreviewRoutesOptions,
} from "./routes/pmsManualBookingPreview.js";

const id = (value: number) => `71000000-0000-4000-8000-${String(value).padStart(12, "0")}`;
const propertyId = id(1),
  organizationId = id(2),
  roomTypeId = id(3),
  planId = id(4),
  seasonId = id(5),
  weekendId = id(6),
  extraId = id(7),
  otherRoomTypeId = id(8),
  legacyPlanId = id(9),
  roomIds = [id(10), id(11), id(12)],
  addonIds = [id(20), id(21), id(22), id(23)],
  now = "2026-08-12T12:00:00.000Z";
type State = {
  reads: string[];
  unavailable?: boolean;
  capacityUnavailable?: boolean;
  inactivePlan?: boolean;
  addonCurrency?: string;
  missingProperty?: boolean;
  missingPricingPlan?: boolean;
  stalePlan?: boolean;
  staleAdditionalBinding?: boolean;
  missingSeasonBinding?: boolean;
  childCountPolicy?: "adult_only" | "all";
  stalePolicy?: boolean;
};
type Auth = Partial<Record<"token" | "permission" | "entitlement" | "link", boolean>> & {
  organizationKind?: "hotel_group" | "creator_workspace";
  relationship?: string;
  entitlementResourceId?: string;
  linkResourceId?: string;
};

describe("target manual-booking preview", () => {
  let app: Awaited<ReturnType<typeof testApp>> | undefined;
  afterEach(async () => app?.close());

  it("prices coherent heterogeneous stays and every add-on model", async () => {
    const state: State = { reads: [] };
    app = await testApp(state);
    const response = await request(app, command()),
      body = response.json();
    expect(response.statusCode).toBe(200);
    expect(
      body.stays.map((stay: any) => [
        stay.standardTotal?.amountDecimal,
        stay.appliedTotal.amountDecimal,
      ]),
    ).toEqual([
      ["250.00", "250.00"],
      [undefined, "160.00"],
      ["340.00", "180.00"],
    ]);
    expect(body.addOns.map((addon: any) => addon.total.amountDecimal)).toEqual([
      "20.00",
      "25.00",
      "16.00",
      "48.00",
    ]);
    expect(body.grandTotal).toEqual({ amountDecimal: "699.00", currency: "EUR" });
    expect(state.reads).toEqual([
      "rooms",
      "types",
      "pricing",
      "recurring",
      "publication",
      "addons",
      "policy",
      "available",
    ]);
  });

  it("prices stays from PMS owner evidence without Booking policy evidence", async () => {
    app = await testApp({ reads: [] });
    const response = await request(app, command());

    expect(response.statusCode).toBe(200);
    expect(response.json().stays[0].standardTotal).toEqual({
      amountDecimal: "250.00",
      currency: "EUR",
    });
    expect(response.json().stays[2].standardTotal).toEqual({
      amountDecimal: "340.00",
      currency: "EUR",
    });
    expect(response.json().grandTotal).toEqual({ amountDecimal: "699.00", currency: "EUR" });
  });

  // prettier-ignore
  it("lists only active add-on fields for front-desk PMS users", async () => { const state: State = { reads: [] }; app = await testApp(state, { relationship: "front_desk" }); const response = await app.inject({ method: "GET", url: `/properties/${propertyId}/manual-bookings/addons`, headers: headers() }); expect(response.statusCode).toBe(200); expect(response.json().addOns.map((addon: any) => addon.addonItemId)).toEqual(addonIds); expect(Object.keys(response.json().addOns[0]).sort()).toEqual(["addonItemId", "category", "currency", "description", "name", "price", "pricingModel"]); expect((await app.inject({ method: "GET", url: `/properties/${propertyId}/manual-bookings/addons?propertyId=other`, headers: headers() })).statusCode).toBe(400); expect(state.reads).toEqual(["addons"]); });

  it.each([
    [{}, "155.00"],
    [{ childCountPolicy: "adult_only" }, "150.00"],
    [{ childCountPolicy: "all" }, "155.00"],
    [{ childCountPolicy: "adult_only", stalePolicy: true }, "155.00"],
  ] as const)(
    "uses optional child-count policy %# for additional guests",
    async (override, total) => {
      app = await testApp({ reads: [], ...override });
      const body = command();
      body.stays = [
        { ...body.stays[0], checkIn: "2027-07-05", checkOut: "2027-07-06", adults: 1, children: 1 },
      ];
      body.addOns = [];
      const response = await request(app, body);
      expect([response.statusCode, response.json().stays[0].standardTotal.amountDecimal]).toEqual([
        200,
        total,
      ]);
    },
  );

  it.each([
    [{ stalePlan: true }, "plan/source revision"],
    [{ staleAdditionalBinding: true }, "additional-guest room binding"],
    [{ missingSeasonBinding: true }, "selected seasonal binding"],
  ] as const)("fails closed for incoherent %s", async (override, _label) => {
    app = await testApp({ reads: [], ...override });
    const response = await request(app, command());
    expect([response.statusCode, response.json().code]).toEqual([
      500,
      "manual_booking_preview_unavailable",
    ]);
  });

  it("requires exact distinct-night add-on coverage", async () => {
    // prettier-ignore
    const invalidSelections = [
      (body: any) => body.addOns[2].serviceUnits.pop(),
      (body: any) => (body.addOns[2].serviceUnits[3].serviceDate = "2027-07-02"),
      (body: any) => (body.addOns[3].serviceUnits[0].serviceDate = "2027-06-29"),
      (body: any) => (body.addOns[3].serviceUnits[2].guestCount = 6),
      (body: any) => (body.addOns[0].serviceUnits = []),
      (body: any) => (body.addOns[0].serviceUnits[0].serviceDate = "2027-07-01"),
      (body: any) => (body.addOns[0].serviceUnits[0].guestCount = 1),
      (body: any) => (body.addOns[1].serviceUnits[0].serviceDate = "2027-07-01"),
      (body: any) => (body.addOns[1].serviceUnits[0].guestCount = null),
      (body: any) => (body.addOns[1].serviceUnits[0].guestCount = 0),
      (body: any) => (body.addOns[2].serviceUnits[0].guestCount = 1),
      (body: any) => (body.addOns[3].serviceUnits[0].guestCount = null),
      (body: any) => (body.addOns[3].serviceUnits[0].guestCount = 0),
    ];
    for (const mutate of invalidSelections) {
      const body = command();
      mutate(body);
      app = await testApp({ reads: [] });
      const response = await request(app, body);
      expect([response.statusCode, response.json().code]).toEqual([422, "invalid_addon_selection"]);
      await app.close();
      app = undefined;
    }
  });

  it("accepts 366 rate-plan nights and rejects longer stays before reads", async () => {
    app = await testApp({ reads: [] });
    const accepted = command();
    accepted.stays = [{ ...accepted.stays[0], checkIn: "2027-01-01", checkOut: "2028-01-02" }];
    accepted.addOns = [];
    expect((await request(app, accepted)).statusCode).toBe(200);
    await app.close();
    for (const checkOut of ["2028-01-03", "2028-01-06"]) {
      const state: State = { reads: [] };
      app = await testApp(state);
      const rejected = structuredClone(accepted);
      rejected.stays[0].checkOut = checkOut;
      const response = await request(app, rejected);
      expect([response.statusCode, response.json().code, state.reads]).toEqual([
        422,
        "invalid_dates",
        [],
      ]);
      await app.close();
    }
    app = undefined;
  });

  it.each([
    ["unauthenticated", { token: false }],
    ["forbidden", { permission: false }],
    ["entitlement_required", { entitlement: false }],
    ["forbidden", { link: false }],
    ["entitlement_required", { entitlementResourceId: id(99) }],
    ["forbidden", { linkResourceId: id(99) }],
    ["forbidden", { relationship: "viewer" }],
    ["forbidden", { organizationKind: "creator_workspace" }],
  ] as const)("denies %s before query validation or reads", async (code, auth) => {
    const state: State = { reads: [] };
    app = await testApp(state, auth);
    const response = await request(
      app,
      { broken: true },
      "token" in auth && auth.token === false ? { "content-type": "application/json" } : headers(),
      "?scope=other",
    );
    expect(response.json()).toMatchObject({ code });
    expect(state.reads).toEqual([]);
  });

  it("rejects query aliases and contradictory pricing shapes", async () => {
    app = await testApp({ reads: [] });
    expect((await request(app, { ...command(), channel: "ota" })).json().code).toBe(
      "unknown_field",
    );
    expect((await request(app, command(), headers(), "?propertyId=other")).json().code).toBe(
      "unknown_field",
    );
    for (const mutate of [
      (body: any) => (body.stays[1].ratePlanId = planId),
      (body: any) => (body.stays[0].ratePlanId = null),
    ]) {
      const body = command();
      mutate(body);
      expect((await request(app, body)).json().code).toBe("invalid_body");
    }
  });

  // prettier-ignore
  const errors: [number, string, (body: any) => void, Partial<State>][] = [
    [404, "rate_not_found", () => undefined, { missingProperty: true }],
    [404, "rate_not_found", () => undefined, { missingPricingPlan: true }],
    [409, "room_unavailable", () => undefined, { unavailable: true }],
    [404, "room_not_found", (body) => (body.stays[0].roomId = propertyId), {}],
    [422, "invalid_dates", (body) => (body.stays[0].checkOut = "2027-06-29"), {}],
    [422, "occupancy_exceeded", (body) => (body.stays[0].adults = 5), {}],
    [422, "occupancy_exceeded", (body) => (body.stays[0].adults = 0), {}],
    [404, "rate_plan_not_found", (body) => (body.stays[0].ratePlanId = propertyId), {}],
    [404, "rate_plan_not_found", (body) => (body.stays[0].ratePlanId = legacyPlanId), {}],
    [422, "inactive_rate_plan", () => undefined, { inactivePlan: true }],
    [422, "currency_mismatch", () => undefined, { addonCurrency: "USD" }],
    [404, "addon_not_found", (body) => (body.addOns[0].addonId = propertyId), {}],
    [422, "invalid_addon_selection", (body) => (body.addOns[0].packageCount = 0), {}],
  ];
  it.each(errors)("returns %s %s", async (status, code, mutate, override) => {
    const body = command();
    mutate(body);
    app = await testApp({ reads: [], ...override });
    const response = await request(app, body);
    expect([response.statusCode, response.json().code]).toEqual([status, code]);
  });
});

async function testApp(state: State, auth: Auth = {}) {
  const app = Fastify({ logger: false });
  app.decorateRequest("authContext", null);
  app.addHook("onRequest", async (request) => {
    if (request.headers.authorization !== "Bearer valid" || auth.token === false) return;
    request.authContext = {
      actor: { internalUserId: id(40) },
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
    evidence = ownerEvidence(state),
    fingerprint = createBookingPricingSourceFingerprint({ organizationId, propertyId }, evidence),
    extra = evidence.recurringPricing.sources.find(
      (source: any) => source.sourceKind === "additional_guest",
    ) as any;
  // prettier-ignore
  const ports: PmsManualBookingPreviewRoutesOptions = {
    pms: {
      async listRoomsByPropertyId() { read("rooms"); return { items: roomIds.map((roomId) => ({ roomId, roomTypeId })) } as any; },
      async listRoomTypesByPropertyId() { read("types"); return { items: [{ roomTypeId, active: true, occupancyLimits: { adults: 4, children: 4, total: 4 }, ratePlans: [{ ratePlanId: legacyPlanId, pricingContractVersion: null, active: true }, { ratePlanId: planId, pricingContractVersion: "pms-pricing.v1", active: !state.inactivePlan }] }] } as any; },
      async getPhysicalRoomAvailability(_propertyId, stays) { read("available"); return stays.map((_, index) => state.unavailable || (state.capacityUnavailable && index === 1) ? false : true); },
    },
    pricing: {
      async getPricingSourceSnapshot() { read("pricing"); return state.missingProperty ? null : evidence.pricing; },
      async getRecurringPricingBookingEvidence() { read("recurring"); return evidence.recurringPricing; },
    },
    roomPublication: { async getRoomPublicationSnapshot() { read("publication"); return evidence.roomPublication; } },
    booking: {
      async listAddonItemsByHotelId() { read("addons"); return { addonItems: addonIds.map((addonItemId, index) => ({ addonItemId, propertyId, name: `Add-on ${index + 1}`, description: "", category: "dining", price: ["10.00", "5.00", "4.00", "2.00"][index], currency: state.addonCurrency ?? "EUR", pricingModel: ["per_stay", "per_guest", "per_night", "per_guest_night"][index], status: "active" })), propertyPlan: {} } as any; },
      async getCurrentGuestPolicy() { read("policy"); if (!state.childCountPolicy) return null; return { organizationId, propertyId, bundle: { pricingSourceFingerprint: state.stalePolicy ? "stale" : fingerprint, rates: [{ roomTypeId, flexible: { source: { entityId: planId } }, additionalGuest: { source: { source: { entityId: extra.sourceId } }, countedGuestTypes: state.childCountPolicy === "adult_only" ? ["adult"] : ["adult", "child"] } }] } } as any; },
    },
  };
  return ports;
}

function ownerEvidence(state: State): any {
  const planRevision = state.stalePlan ? 4 : 3,
    binding = {
      roomTypeId,
      roomFactsRevision: 4,
      flexibleRatePlanId: planId,
      flexibleRatePlanRevision: state.stalePlan ? 3 : planRevision,
    },
    source = (sourceId: string) => ({
      contractVersion: "pms-recurring-pricing.v1",
      propertyId,
      sourceId,
      sourceRevision: 3,
      pricingCurrencyRevision: 2,
      currency: "EUR",
      configuredState: "active",
      validation: { state: "valid", validationRevision: 2, validatedAt: now },
      lifecycle: "active",
      materializationRevision: 1,
      createdAt: now,
      updatedAt: now,
    });
  // prettier-ignore
  const evidence = {
    roomPublication: { contractVersion: "pms-room-publication.v1", propertyId, status: "ready", rooms: [{ propertyId, roomTypeId, facts: { name: "Suite", description: "Complete", category: null, occupancy: { maxGuests: 4, maxAdults: 4, maxChildren: 4 }, beds: [], bedrooms: null, bathrooms: null, bathroomType: "private", size: null }, activeUnitCount: 3, media: [], amenities: [], sourceRevisions: { roomFactsRevision: 4, roomUnitsRevision: 1, roomMediaRevision: 1, roomAmenitiesRevision: 1 }, sourceRevision: "room:4" }], blockers: [], sourceRevision: "rooms:4" },
    pricing: { contractVersion: "pms-pricing.v1", propertyId, pricingCurrency: { contractVersion: "pms-pricing.v1", propertyId, currency: "EUR", pricingCurrencyRevision: 2, createdAt: now, updatedAt: now }, flexibleRatePlans: state.missingPricingPlan ? [] : [{ contractVersion: "pms-pricing.v1", propertyId, roomTypeId, flexibleRatePlanId: planId, flexibleRatePlanRevision: planRevision, sourceRoomFactsRevision: 4, baseAmount: { amountDecimal: "100.00", currency: "EUR" }, cancellationTerms: { type: "free_until_days_before_arrival", freeCancellationDeadlineDays: 7, afterDeadlinePenalty: "full_booking_amount", noShowPenalty: "full_booking_amount" }, createdAt: now, updatedAt: now }], capturedAt: now },
    recurringPricing: { contractVersion: "pms-recurring-pricing.v1", propertyId, pricingCurrencyRevision: 2, optionalPricingAggregateRevision: 5, currency: "EUR", sources: [
      { ...source(seasonId), sourceKind: "season", name: "Summer", startMonthDay: "07-01", endMonthDay: "08-31", roomPrices: [{ ...(state.missingSeasonBinding ? { ...binding, roomTypeId: otherRoomTypeId } : binding), amountDecimal: "150.00" }] },
      { ...source(weekendId), sourceKind: "weekend_surcharge", weekdays: ["friday", "saturday"], roomSurcharges: [{ ...binding, amountDecimal: "10.00" }] },
      { ...source(extraId), sourceKind: "additional_guest", ...binding, ...(state.staleAdditionalBinding ? { roomFactsRevision: 3 } : {}), maximumAdultGuests: 4, includedGuests: 1, amountDecimal: "5.00" },
    ], capturedAt: now },
  };
  return evidence;
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
  const dates = ["2027-06-30", "2027-07-01", "2027-07-02", "2027-07-03"];
  // prettier-ignore
  const body = {
    contractVersion: "pms-manual-booking.v1",
    stays: [
      stay(1, roomIds[0]!, "2027-06-30", "2027-07-02", 1, { kind: "rate_plan", manualOverride: null }),
      stay(2, roomIds[1]!, "2027-07-01", "2027-07-03", 2, { kind: "custom", nightlyAmount: { amountDecimal: "80", currency: "EUR" } }, null),
      stay(3, roomIds[2]!, "2027-07-02", "2027-07-04", 3, { kind: "rate_plan", manualOverride: { amountDecimal: "90", currency: "EUR" } }),
    ],
    addOns: [
      { addonId: addonIds[0], packageCount: 2, serviceUnits: [{ serviceDate: null, guestCount: null }] },
      { addonId: addonIds[1], packageCount: 1, serviceUnits: [{ serviceDate: null, guestCount: 5 }] },
      { addonId: addonIds[2], packageCount: 1, serviceUnits: dates.map((serviceDate) => ({ serviceDate, guestCount: null })) },
      { addonId: addonIds[3], packageCount: 2, serviceUnits: dates.map((serviceDate, index) => ({ serviceDate, guestCount: [1, 3, 5, 3][index] })) },
    ],
  };
  return body;
}

const headers = () => ({ authorization: "Bearer valid", "content-type": "application/json" });
function request(
  app: Awaited<ReturnType<typeof testApp>>,
  body: unknown,
  customHeaders: Record<string, string> = headers(),
  query = "",
) {
  return app.inject({
    method: "POST",
    url: `/properties/${propertyId}/manual-bookings/preview${query}`,
    headers: customHeaders,
    payload: JSON.stringify(body),
  });
}
