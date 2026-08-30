import { describe, expect, it } from "vitest";

import { createProductionBookingContext, propertyFor } from "./productionBookingContext.js";
import type { IdentitySourceRow } from "./productionIdentityDisposition.js";
import type { ProductionBookingTargetState } from "./productionBookingTypes.js";

describe("production Booking mapping context", () => {
  it("resolves properties only through active canonical catalog links", () => {
    const context = createProductionBookingContext({
      sourceRunId: "vay1351-0123456789abcdef01234567",
      completedAt: "2026-08-30T00:00:00.000Z",
      rows: [
        row("pms", "bookings", { id: "booking-1", hotel_id: "hotel-1", booking_reference: "B-1" }),
      ],
      target: target({
        propertyLinks: [
          {
            sourceSystem: "pms",
            sourceTable: "hotels",
            sourceId: "hotel-1",
            propertyId: "property-1",
            relationship: "operational_input",
            status: "active",
          },
        ],
      }),
    });
    expect(propertyFor(context, "pms", "hotels", "hotel-1")).toBe("property-1");
    expect(context.blockers).toEqual([]);
  });

  it("fails closed for ambiguous ownership and unresolved event slugs", () => {
    const context = createProductionBookingContext({
      sourceRunId: "vay1351-0123456789abcdef01234567",
      completedAt: "2026-08-30T00:00:00.000Z",
      rows: [row("booking", "booking_events", { id: "event-1", hotel_slug: "hotel" })],
      target: target({
        propertySlugs: [
          { slug: "hotel", propertyId: "property-1", purpose: "canonical", status: "active" },
          { slug: "hotel", propertyId: "property-2", purpose: "alias", status: "active" },
        ],
      }),
    });
    expect(context.blockers.map((blocker) => blocker.code)).toEqual([
      "AMBIGUOUS_PROPERTY_SLUG",
      "UNRESOLVED_EVENT_PROPERTY",
    ]);
  });

  it("blocks unsupported sensitive guest fields and raw legacy media", () => {
    const context = createProductionBookingContext({
      sourceRunId: "vay1351-0123456789abcdef01234567",
      completedAt: "2026-08-30T00:00:00.000Z",
      rows: [
        row("pms", "booking_additional_guests", { id: "guest-1", passport_number: "secret" }),
        row("booking", "booking_addons", {
          id: "addon-1",
          hotel_id: "hotel-1",
          image: "https://legacy/image.jpg",
        }),
      ],
      target: target(),
    });
    expect(context.blockers.map((blocker) => blocker.code)).toEqual([
      "UNRESOLVED_PROPERTY",
      "UNSUPPORTED_SENSITIVE_GUEST_FIELDS",
      "UNRESOLVED_LEGACY_MEDIA",
    ]);
  });
});

function row(
  sourceDatabase: "booking" | "pms",
  sourceTable: string,
  data: Record<string, unknown>,
): IdentitySourceRow {
  return { sourceDatabase, sourceTable, rowOrdinal: 1, data };
}

function target(values: Partial<ProductionBookingTargetState> = {}): ProductionBookingTargetState {
  return { propertyLinks: [], propertySlugs: [], records: [], provenance: [], ...values };
}
