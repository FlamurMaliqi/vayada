import { describe, expect, it, vi } from "vitest";

import type { ChannexManagementJob } from "../jobs/pmsChannexManagementWorker.js";
import { createPgChannexManagementPlanPort } from "./channexManagementPlans.js";

describe("target Channex management plans", () => {
  it("builds enable and idempotent disable actions from target state", async () => {
    let db = new FakePool("enable");
    let port = createPgChannexManagementPlanPort({
      connectionString: "postgresql://target",
      pool: db,
      bookingRevisionHandoff: vi.fn(),
    });
    const enabled = await port.plan(job("enable"));
    expect(enabled.requests).toMatchObject([
      {
        method: "GET",
        path: "/api/v1/properties",
        capture: { kind: "property_list", title: "Hotel [Vayada:property-1]" },
      },
      {
        method: "POST",
        path: "/api/v1/properties",
        body: { property: { title: "Hotel [Vayada:property-1]" } },
        capture: { kind: "property" },
      },
    ]);
    expect(enabled.checkpoint).toEqual(expect.any(Function));
    await enabled.checkpoint?.({
      ok: true,
      externalPropertyId: "external-1",
      connectionStatus: "connected",
    });
    expect(db.sql()).toContain("hotel_catalog.properties");
    expect(db.sql()).toContain("pms.channel_connections");
    // prettier-ignore
    expect(db.sql()).toMatch(/BEGIN[\s\S]*channel_binding_claims[\s\S]*channel_connections[\s\S]*COMMIT/);

    db = new FakePool("disconnected");
    port = createPgChannexManagementPlanPort({
      connectionString: "postgresql://target",
      pool: db,
      bookingRevisionHandoff: vi.fn(),
    });
    await expect(port.plan(job("disable"))).resolves.toMatchObject({ requests: [] });
  });

  it("keeps provider room and rate titles unique across identical local names", async () => {
    const db = new FakePool("multi_room");
    const port = createPgChannexManagementPlanPort({
      connectionString: "postgresql://target",
      pool: db,
      bookingRevisionHandoff: vi.fn(),
    });
    const plan = await port.plan(job("provision"));
    const roomTitles = plan.requests.flatMap((request) =>
      request.capture?.kind === "room_type_list"
        ? request.capture.rooms.map(({ roomTypeName }) => roomTypeName)
        : [],
    );
    const rateTitles = plan.requests.flatMap((request) =>
      request.capture?.kind === "rate_plan_list"
        ? request.capture.rates.map(({ providerTitle }) => providerTitle)
        : [],
    );
    expect(new Set(roomTitles).size).toBe(roomTitles.length);
    expect(roomTitles).toEqual(
      expect.arrayContaining([
        expect.stringContaining("[Vayada:room-1]"),
        expect.stringContaining("[Vayada:room-2]"),
      ]),
    );
    expect(new Set(rateTitles).size).toBe(rateTitles.length);
    expect(rateTitles).toEqual(
      expect.arrayContaining([
        expect.stringContaining("[Vayada:room-1:booking_com:rate-1]"),
        expect.stringContaining("[Vayada:room-2:booking_com:rate-2]"),
      ]),
    );
  });

  it("preserves provider identity when truncating long Unicode titles", async () => {
    const db = new FakePool("unicode");
    const port = createPgChannexManagementPlanPort({
      connectionString: "postgresql://target",
      pool: db,
      bookingRevisionHandoff: vi.fn(),
    });
    const plan = await port.plan(job("enable"));
    const capture = plan.requests[0]?.capture;
    expect(capture?.kind).toBe("property_list");
    if (capture?.kind !== "property_list") throw new Error("Expected property lookup");
    const { title } = capture;
    expect(Array.from(title)).toHaveLength(255);
    expect(title).toMatch(/\[Vayada:property-1\]$/);
    expect(title).not.toMatch(/[\uD800-\uDFFF]/u);
  });

  it("orders missing or disabled rooms before dependent target rate plans", async () => {
    const db = new FakePool("provision");
    const port = createPgChannexManagementPlanPort({
      connectionString: "postgresql://target",
      pool: db,
      bookingRevisionHandoff: vi.fn(),
    });
    const plan = await port.plan(job("provision"));
    expect(plan.requests.map(({ path }) => path)).toEqual([
      "/api/v1/room_types",
      "/api/v1/room_types",
      "/api/v1/rate_plans",
      "/api/v1/rate_plans",
      "/api/v1/rate_plans",
      "/api/v1/rate_plans",
      "/api/v1/rate_plans",
      "/api/v1/rate_plans",
      "/api/v1/channels",
    ]);
    expect(plan.requests[1]?.body).toMatchObject({
      room_type: { occ_infants: 0, default_occupancy: 1 },
    });
    expect(plan.requests[0]?.query).toMatchObject({
      "filter[title]": "Deluxe [Vayada:room-1]",
    });
    expect(plan.requests[2]?.query).toMatchObject({
      "filter[title]": "Deluxe - Flexible - Standard [Vayada:room-1:direct:rate-1]",
    });
    expect(plan.requests[4]?.query).toMatchObject({
      "filter[title]": "Deluxe - Flexible - BDC Standard [Vayada:room-1:booking_com:rate-1]",
    });
    expect(plan.requests[6]?.query).toMatchObject({
      "filter[title]": "Deluxe - Flexible - Airbnb Standard [Vayada:room-1:airbnb:rate-1]",
    });
    expect(plan.checkpoint).toEqual(expect.any(Function));
    expect(db.sql()).toContain("pms.channel_room_type_mappings");
    expect(db.sql()).toContain("pms.channel_rate_plan_mappings");
    expect(db.sql()).toContain("mapping.connection_id = connection.id");
    expect(db.sql()).toContain("connection.provider = 'channex'");
    expect(db.sql()).toContain("mapping.status <> 'active'");
  });

  it("builds ARI from target inventory/mappings and delegates booking intake", async () => {
    let db = new FakePool("ari");
    let handoff = vi.fn();
    let port = createPgChannexManagementPlanPort({
      connectionString: "postgresql://target",
      pool: db,
      bookingRevisionHandoff: handoff,
    });
    const ari = await port.plan({
      ...job("update_markups"),
      input: {
        ...job("update_markups").input,
        markups: [{ channel: "airbnb", markupPercent: 20 }],
      },
    });
    expect(ari.requests.map(({ path }) => path)).toEqual([
      "/api/v1/availability",
      "/api/v1/restrictions",
    ]);
    expect(ari.requests[1]?.body).toMatchObject({ values: [{ rate: 120 }] });
    expect(db.sql()).toContain("rate_mapping.connection_id = connection.id");
    expect(db.sql()).toContain("connection.provider = 'channex'");

    db = new FakePool("connected");
    handoff = vi.fn();
    port = createPgChannexManagementPlanPort({
      connectionString: "postgresql://target",
      pool: db,
      bookingRevisionHandoff: handoff,
    });
    const bookings = await port.plan(job("sync_bookings"));
    await bookings.bookingRevisionHandoff?.([{ id: "revision-1" }]);
    expect(handoff).toHaveBeenCalledWith({
      propertyId: "property-1",
      providerPropertyId: "external-1",
      revisions: [{ id: "revision-1" }],
    });
    expect(db.sql()).not.toMatch(/external_webhook_events|legacy/i);
  });

  it.each([
    ["historical", "sync_bookings", "Channex binding claim is not active"],
    ["retained", "enable", "A retained Channex binding claim requires audited repair"],
  ] as const)("fails closed for %s binding evidence", async (mode, operation, message) => {
    const port = createPgChannexManagementPlanPort({
      connectionString: "postgresql://target",
      pool: new FakePool(mode),
      bookingRevisionHandoff: vi.fn(),
    });

    await expect(port.plan(job(operation))).rejects.toThrow(message);
  });
});

type Mode =
  | "enable"
  | "unicode"
  | "disconnected"
  | "connected"
  | "historical"
  | "retained"
  | "provision"
  | "multi_room"
  | "ari";
class FakePool {
  private calls: string[] = [];
  constructor(private readonly mode: Mode) {}
  sql() {
    return this.calls.join("\n");
  }
  async end() {}
  async connect() {
    return { query: this.query.bind(this), release() {} };
  }
  async query<T>(text: string) {
    this.calls.push(text);
    let rows: unknown[] = [];
    if (text.includes("pms.channel_binding_claims")) {
      if (this.mode === "historical")
        rows = [
          {
            externalPropertyId: "external-1",
            claimExternalPropertyId: "external-1",
            claimState: "historical",
          },
        ];
      else if (this.mode === "retained")
        rows = [
          {
            externalPropertyId: null,
            claimExternalPropertyId: "external-1",
            claimState: "historical",
          },
        ];
      else if (!["disconnected", "enable", "unicode"].includes(this.mode))
        rows = [
          {
            externalPropertyId: "external-1",
            claimExternalPropertyId: "external-1",
            claimState: "active",
          },
        ];
      else rows = [{ externalPropertyId: null, claimExternalPropertyId: null, claimState: null }];
    } else if (text.includes("hotel_catalog.properties"))
      rows = [{ title: this.mode === "unicode" ? "😀".repeat(300) : "Hotel", currency: "EUR" }];
    else if (text.includes("count(unit.id)")) {
      rows = [
        {
          roomTypeId: "room-1",
          name: "Deluxe",
          currency: "EUR",
          countOfRooms: 2,
          adults: 1,
          children: 0,
        },
      ];
      if (this.mode === "multi_room") {
        rows.push({ ...rows[0]!, roomTypeId: "room-2" });
      }
    } else if (
      text.includes("FROM pms.rate_plans plan") &&
      (this.mode === "provision" || this.mode === "multi_room")
    ) {
      const rooms =
        this.mode === "multi_room"
          ? [
              { roomTypeId: "room-1", roomTypeName: "Deluxe", ratePlanId: "rate-1" },
              { roomTypeId: "room-2", roomTypeName: "Deluxe", ratePlanId: "rate-2" },
            ]
          : [{ roomTypeId: "room-1", roomTypeName: "Deluxe", ratePlanId: "rate-1" }];
      rows = rooms.flatMap((room) =>
        [
          ["direct", "Standard"],
          ["booking_com", "BDC Standard"],
          ["airbnb", "Airbnb Standard"],
        ].map(([channel, channelLabel]) => ({
          ...room,
          name: "Flexible",
          currency: "EUR",
          sellMode: "per_room",
          baseRate: 100,
          channel,
          channelLabel,
          markupPercent: 0,
          defaultOccupancy: 1,
          externalRoomTypeId: null,
        })),
      );
    } else if (text.includes("FROM pms.inventory_days"))
      rows = [
        {
          stayDate: "2026-08-14",
          available: 2,
          externalRoomTypeId: "external-room",
          externalRatePlanId: "external-rate",
          rate: 100,
          channel: "airbnb",
          markupPercent: 10,
        },
      ];
    return { rows: rows as T[] };
  }
}

function job(operationType: ChannexManagementJob["input"]["operationType"]): ChannexManagementJob {
  return {
    jobId: "job-1",
    propertyId: "property-1",
    correlationId: null,
    attemptNumber: 1,
    maxAttempts: 5,
    input: { commandId: "command-1", idempotencyKey: "key-1", operationType },
  };
}
