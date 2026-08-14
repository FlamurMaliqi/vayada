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
      { method: "GET", path: "/api/v1/properties", capture: { kind: "property_list" } },
      { method: "POST", path: "/api/v1/properties", capture: { kind: "property" } },
    ]);
    expect(enabled.checkpoint).toEqual(expect.any(Function));
    await enabled.checkpoint?.({
      ok: true,
      externalPropertyId: "external-1",
      connectionStatus: "connected",
    });
    expect(db.sql()).toContain("hotel_catalog.properties");
    expect(db.sql()).toContain("pms.channel_connections");

    db = new FakePool("disconnected");
    port = createPgChannexManagementPlanPort({
      connectionString: "postgresql://target",
      pool: db,
      bookingRevisionHandoff: vi.fn(),
    });
    await expect(port.plan(job("disable"))).resolves.toMatchObject({ requests: [] });
  });

  it("orders unmapped rooms before dependent target rate plans", async () => {
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
      "/api/v1/channels",
    ]);
    expect(plan.requests[0]?.query).toMatchObject({ "filter[title]": "Deluxe" });
    expect(plan.requests[2]?.query).toMatchObject({ "filter[title]": "Flexible" });
    expect(plan.checkpoint).toEqual(expect.any(Function));
    expect(db.sql()).toContain("pms.channel_room_type_mappings");
    expect(db.sql()).toContain("pms.channel_rate_plan_mappings");
    expect(db.sql()).toContain("mapping.connection_id = connection.id");
    expect(db.sql()).toContain("connection.provider = 'channex'");
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
      revisions: [{ id: "revision-1" }],
    });
    expect(db.sql()).not.toMatch(/external_webhook_events|legacy/i);
  });
});

type Mode = "enable" | "disconnected" | "connected" | "provision" | "ari";
class FakePool {
  private calls: string[] = [];
  constructor(private readonly mode: Mode) {}
  sql() {
    return this.calls.join("\n");
  }
  async end() {}
  async query<T>(text: string, _values?: unknown[]) {
    this.calls.push(text);
    let rows: unknown[] = [];
    if (text.includes("hotel_catalog.properties")) rows = [{ title: "Hotel", currency: "EUR" }];
    else if (
      text.includes("external_property_id") &&
      this.mode !== "disconnected" &&
      this.mode !== "enable"
    )
      rows = [{ externalPropertyId: "external-1" }];
    else if (text.includes("count(unit.id)"))
      rows = [
        {
          roomTypeId: "room-1",
          name: "Deluxe",
          currency: "EUR",
          countOfRooms: 2,
          adults: 2,
          children: 0,
        },
      ];
    else if (text.includes("FROM pms.rate_plans plan") && this.mode === "provision")
      rows = [
        {
          roomTypeId: "room-1",
          ratePlanId: "rate-1",
          name: "Flexible",
          currency: "EUR",
          sellMode: "per_room",
          baseRate: 100,
          channel: "direct",
          markupPercent: 0,
          externalRoomTypeId: null,
        },
      ];
    else if (text.includes("FROM pms.inventory_days"))
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
