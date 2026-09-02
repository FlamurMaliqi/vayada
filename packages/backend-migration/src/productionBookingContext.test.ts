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
            ownerStatus: "active",
          },
        ],
      }),
    });
    expect(propertyFor(context, "pms", "hotels", "hotel-1")).toBe("property-1");
    expect(context.blockers).toEqual([]);
  });

  it("fails closed for ambiguous slugs but accepts a unique redirect", () => {
    const context = createProductionBookingContext({
      sourceRunId: "vay1351-0123456789abcdef01234567",
      completedAt: "2026-08-30T00:00:00.000Z",
      rows: [row("booking", "booking_events", { id: "event-1", hotel_slug: "hotel" })],
      target: target({
        propertySlugs: [
          { slug: "hotel", propertyId: "property-1", purpose: "canonical", status: "active" },
          { slug: "hotel", propertyId: "property-2", purpose: "canonical", status: "active" },
        ],
      }),
    });
    expect(context.blockers.map((blocker) => blocker.code)).toEqual(["AMBIGUOUS_PROPERTY_SLUG"]);

    const redirected = createProductionBookingContext({
      sourceRunId: "vay1351-0123456789abcdef01234567",
      completedAt: "2026-08-30T00:00:00.000Z",
      rows: [],
      target: target({
        propertySlugs: [
          {
            slug: "old-hotel",
            propertyId: "property-1",
            purpose: "redirect",
            status: "redirected",
            redirectTargetPropertyId: "property-1",
            redirectTargetPurpose: "canonical",
            redirectTargetStatus: "active",
          },
          {
            slug: "overlay",
            propertyId: "property-1",
            purpose: "marketplace_overlay",
            status: "active",
          },
          {
            slug: "wrong-target",
            propertyId: "property-1",
            purpose: "redirect",
            status: "redirected",
            redirectTargetPropertyId: "property-2",
            redirectTargetPurpose: "canonical",
            redirectTargetStatus: "active",
          },
        ],
      }),
    });
    expect(redirected.propertyBySlug.get("old-hotel")).toBe("property-1");
    expect(redirected.propertyBySlug.has("overlay")).toBe(false);
    expect(redirected.propertyBySlug.has("wrong-target")).toBe(false);
    expect(redirected.blockers).toEqual([]);
  });

  it("hash-quarantines unsupported guest fields without copying their values", () => {
    const context = createProductionBookingContext({
      sourceRunId: "vay1351-0123456789abcdef01234567",
      completedAt: "2026-08-30T00:00:00.000Z",
      rows: [
        row("pms", "bookings", {
          id: "booking-1",
          hotel_id: "pms-hotel-1",
          booking_reference: "B-1",
          check_out: "2026-09-04",
        }),
        row("pms", "booking_additional_guests", {
          id: "guest-1",
          booking_id: "booking-1",
          passport_number: "secret",
        }),
        row("booking", "booking_addons", {
          id: "addon-1",
          hotel_id: "hotel-1",
          image: "https://legacy/image.jpg",
        }),
      ],
      target: target({
        propertyLinks: [
          {
            sourceSystem: "pms",
            sourceTable: "hotels",
            sourceId: "pms-hotel-1",
            propertyId: "property-1",
            relationship: "operational_input",
            status: "active",
            ownerStatus: "active",
          },
        ],
      }),
    });
    expect(context.blockers.map((blocker) => blocker.code)).toEqual(["UNRESOLVED_PROPERTY"]);
    expect(context.quarantines).toEqual([
      expect.objectContaining({
        sourceId: "guest-1",
        sourceField: "passport_number",
        reasonCode: "UNSUPPORTED_GUEST_PRIVATE_FIELD",
        sourceValueSha256: expect.stringMatching(/^[0-9a-f]{64}$/),
      }),
    ]);
    expect(JSON.stringify(context.quarantines)).not.toContain("secret");
    expect(context.inferences).toEqual([
      expect.objectContaining({
        sourceId: "booking-1",
        inferredValue: "commission",
        reasonCode: "MISSING_BILLING_PLAN_PRE_SWITCH_COMMISSION",
        sourceRowSha256: expect.stringMatching(/^[0-9a-f]{64}$/),
      }),
    ]);
  });

  it("fails closed when guest quarantine retention cannot be bounded", () => {
    const context = createProductionBookingContext({
      sourceRunId: "vay1351-0123456789abcdef01234567",
      completedAt: "2026-08-30T00:00:00.000Z",
      rows: [
        row("pms", "booking_additional_guests", {
          id: "guest-1",
          booking_id: "missing-booking",
          passport_number: "secret",
        }),
      ],
      target: target(),
    });

    expect(context.quarantines).toEqual([]);
    expect(context.blockers).toContainEqual(
      expect.objectContaining({ code: "INVALID_GUEST_QUARANTINE_RETENTION" }),
    );
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
