import { describe, expect, it } from "vitest";

import { createProductionPmsContext } from "./productionPmsContext.js";
import type { IdentitySourceRow } from "./productionIdentityDisposition.js";

describe("production PMS context", () => {
  it("resolves canonical properties, bookings, channel connection, and linked membership", () => {
    const context = createProductionPmsContext({
      sourceRunId: "run",
      completedAt: "2026-08-30T00:00:00Z",
      rows: [
        row("bookings", { id: "booking", hotel_id: "hotel" }),
        row("room_types", { id: "room-type", hotel_id: "hotel" }),
        row("linked_inventory_groups", { id: "group", hotel_id: "hotel" }),
        row("linked_inventory_group_members", {
          group_id: "group",
          room_type_id: "room-type",
        }),
        row("channex_connections", { id: "connection", hotel_id: "hotel" }),
      ],
      target: {
        propertyLinks: [
          {
            sourceId: "hotel",
            propertyId: "property",
            relationship: "operational_input",
            status: "active",
          },
        ],
        bookings: [
          {
            id: "booking",
            propertyId: "property",
            checkIn: "2026-09-01",
            checkOut: "2026-09-02",
            adults: 1,
            children: 0,
            currency: "EUR",
            lifecycleStatus: "confirmed",
            updatedAt: "2026-08-30T00:00:00Z",
          },
        ],
        userIds: [],
        mediaIds: [],
        records: [],
        provenance: [],
      },
    });
    expect(context.propertyByHotel.get("hotel")).toBe("property");
    expect(context.targetBookingById.get("booking")?.propertyId).toBe("property");
    expect(context.connectionByHotel.get("hotel")?.data["id"]).toBe("connection");
    expect(context.linkedGroupByRoomType.get("room-type")).toBe("group");
    expect(context.blockers).toEqual([]);
  });

  it("blocks duplicate connections and orphan linked members", () => {
    const context = createProductionPmsContext({
      sourceRunId: "run",
      completedAt: "2026-08-30T00:00:00Z",
      rows: [
        row("channex_connections", { id: "one", hotel_id: "hotel" }),
        row("channex_connections", { id: "two", hotel_id: "hotel" }),
        row("linked_inventory_group_members", { group_id: "missing", room_type_id: "missing" }),
      ],
      target: {
        propertyLinks: [],
        bookings: [],
        userIds: [],
        mediaIds: [],
        records: [],
        provenance: [],
      },
    });
    expect(context.blockers.map((blocker) => blocker.code)).toEqual([
      "DUPLICATE_CHANNEL_CONNECTION",
      "ORPHAN_LINKED_INVENTORY_MEMBER",
    ]);
  });
});

function row(sourceTable: string, data: Record<string, unknown>): IdentitySourceRow {
  return { sourceDatabase: "pms", sourceTable, rowOrdinal: 1, data };
}
