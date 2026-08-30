import { describe, expect, it } from "vitest";

import { buildBookingCatalogRecords } from "./productionBookingCatalogRecords.js";
import { createProductionBookingContext } from "./productionBookingContext.js";
import type { IdentitySourceRow } from "./productionIdentityDisposition.js";

const HOTEL = "13550000-0000-4000-8000-000000000001";
const PROPERTY = "13550000-0000-4000-8000-000000000002";
const ADDON = "13550000-0000-4000-8000-000000000003";
const PROMO = "13550000-0000-4000-8000-000000000004";
const EVENT = "13550000-0000-4000-8000-000000000005";

describe("production Booking catalog records", () => {
  it("maps settings, add-ons, and promo definitions without raw media", () => {
    const rows = [
      row("booking_hotels", {
        id: HOTEL,
        updated_at: "2026-08-29T12:00:00Z",
        currency: "eur",
        instant_book: false,
        supported_languages: ["en", "de"],
        supported_currencies: ["EUR"],
        branding_primary_color: "#abcdef",
      }),
      row("booking_addons", {
        id: ADDON,
        hotel_id: HOTEL,
        name: "Breakfast",
        price: "12.50",
        currency: "EUR",
        per_person: true,
        created_at: "2026-08-01T00:00:00Z",
        updated_at: "2026-08-29T12:00:00Z",
      }),
      row("booking_promo_codes", {
        id: PROMO,
        hotel_id: HOTEL,
        code: "summer",
        discount_type: "percentage",
        discount_value: "10",
        is_active: true,
        max_uses: 20,
        current_uses: 2,
        created_at: "2026-08-01T00:00:00Z",
        updated_at: "2026-08-29T12:00:00Z",
      }),
    ];
    const context = createProductionBookingContext(input(rows));
    const records = buildBookingCatalogRecords(context);
    expect(context.blockers).toEqual([]);
    expect(records.map((record) => record.targetTable)).toEqual([
      "booking_settings",
      "addon_definitions",
      "promo_definitions",
    ]);
    expect(records[0]!.row).toMatchObject({
      propertyId: PROPERTY,
      defaultCurrency: "EUR",
      primaryColor: "#ABCDEF",
      acceptanceMode: "request",
    });
    expect(records[1]!.row).toMatchObject({ pricingModel: "per_guest", priceAmount: "12.50" });
    expect(JSON.stringify(records[1]!.row)).not.toContain("http");
    expect(records[2]!.row).toMatchObject({ code: "SUMMER", discountValue: "10.00" });
  });

  it("stores funnel metadata privately and redacts the audit projection", () => {
    const rows = [
      row("booking_events", {
        id: EVENT,
        hotel_slug: "hotel-one",
        event_type: "checkout_started",
        session_id: "session-1",
        metadata: {
          page: "checkout",
          guestEmail: "private@example.test",
          context: { value: "private@example.test" },
        },
        created_at: "2026-08-29T12:00:00Z",
      }),
    ];
    const context = createProductionBookingContext({
      ...input(rows),
      target: {
        propertyLinks: propertyLinks(),
        propertySlugs: [
          { slug: "hotel-one", propertyId: PROPERTY, purpose: "canonical", status: "active" },
        ],
        records: [],
        provenance: [],
      },
    });
    const audit = buildBookingCatalogRecords(context)[0]!.row;
    expect(audit["redactedPayload"]).toEqual({ page: "checkout" });
    expect(audit["privatePayload"]).toEqual({
      page: "checkout",
      guestEmail: "private@example.test",
      context: { value: "private@example.test" },
    });
    expect(audit["aiVisible"]).toBe(false);
  });

  it("blocks invalid branding instead of replacing source settings", () => {
    for (const data of [
      { branding_primary_color: "not-a-color" },
      { branding_font_pairing: "unknown-fonts" },
    ]) {
      const context = createProductionBookingContext(
        input([
          row("booking_hotels", {
            id: HOTEL,
            updated_at: "2026-08-29T12:00:00Z",
            ...data,
          }),
        ]),
      );
      expect(buildBookingCatalogRecords(context)).toEqual([]);
      expect(context.blockers[0]).toMatchObject({ code: "INVALID_SOURCE_ROW" });
    }
  });
});

function row(sourceTable: string, data: Record<string, unknown>): IdentitySourceRow {
  return { sourceDatabase: "booking", sourceTable, rowOrdinal: 1, data };
}
function propertyLinks() {
  return [
    {
      sourceSystem: "booking",
      sourceTable: "booking_hotels",
      sourceId: HOTEL,
      propertyId: PROPERTY,
      relationship: "canonical_input",
      status: "active",
    },
  ];
}
function input(rows: IdentitySourceRow[]) {
  return {
    sourceRunId: "vay1351-0123456789abcdef01234567",
    completedAt: "2026-08-30T00:00:00.000Z",
    rows,
    target: { propertyLinks: propertyLinks(), propertySlugs: [], records: [], provenance: [] },
  };
}
