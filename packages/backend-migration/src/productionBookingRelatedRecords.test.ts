import { describe, expect, it } from "vitest";

import { createProductionBookingContext } from "./productionBookingContext.js";
import { buildBookingRelatedRecords } from "./productionBookingRelatedRecords.js";
import type { IdentitySourceRow } from "./productionIdentityDisposition.js";

const PMS_HOTEL = "13550000-0000-4000-8000-000000000031";
const BOOKING_HOTEL = "13550000-0000-4000-8000-000000000032";
const PROPERTY = "13550000-0000-4000-8000-000000000033";
const BOOKING = "13550000-0000-4000-8000-000000000034";
const ADDON = "13550000-0000-4000-8000-000000000035";
const PROMO = "13550000-0000-4000-8000-000000000036";

describe("production Booking related records", () => {
  it("maps additional guests, changes, promotions, and add-on selections", () => {
    const context = createProductionBookingContext(input(allRows()));
    const records = buildBookingRelatedRecords(context);
    expect(context.blockers).toEqual([]);
    expect(records.map((record) => record.targetTable)).toEqual([
      "booking_addon_selections",
      "booking_guests",
      "booking_change_requests",
      "promo_applications",
    ]);
    expect(records[0]!.row).toMatchObject({
      guestBookingId: BOOKING,
      addonDefinitionId: ADDON,
      quantity: 2,
      totalAmount: "30.00",
    });
    expect(records[1]!.row).toMatchObject({
      guestBookingId: BOOKING,
      guestRole: "additional_guest",
      countryCode: "DE",
    });
    expect(records[2]!.row).toMatchObject({ requestType: "date_change", status: "accepted" });
    expect(records[3]!.row).toMatchObject({
      promoDefinitionId: PROMO,
      promoCode: "SUMMER",
      applicationStatus: "applied",
      discountAmount: "10.00",
    });
  });

  it("blocks pending promo reconciliation and orphan relationships", () => {
    const rows = allRows();
    const usage = rows.find((row) => row.sourceTable === "booking_promo_usage_state")!;
    usage.data["applied_state"] = "pending";
    const guest = rows.find((row) => row.sourceTable === "booking_additional_guests")!;
    guest.data["booking_id"] = "13550000-0000-4000-8000-000000000099";
    const context = createProductionBookingContext(input(rows));
    buildBookingRelatedRecords(context);
    expect(context.blockers.map((blocker) => blocker.code)).toContain("PROMO_RECONCILIATION_PENDING");
    expect(context.blockers).toContainEqual(
      expect.objectContaining({ code: "INVALID_SOURCE_ROW", source: "pms.booking_additional_guests" }),
    );
  });
});

function allRows(): IdentitySourceRow[] {
  return [
    row("pms", "bookings", {
      id: BOOKING,
      hotel_id: PMS_HOTEL,
      booking_reference: "VAY-RELATED",
      check_out: "2026-09-04",
      currency: "EUR",
      promo_code: "SUMMER",
      promo_discount: "10",
      addon_ids: [ADDON],
      addon_quantities: { [ADDON]: 2 },
      addon_dates: { [ADDON]: "2026-09-02" },
      created_at: "2026-08-01T00:00:00Z",
      updated_at: "2026-08-29T12:00:00Z",
    }),
    row("booking", "booking_addons", {
      id: ADDON,
      hotel_id: BOOKING_HOTEL,
      name: "Breakfast",
      category: "food",
      price: "15",
      currency: "EUR",
      per_person: false,
    }),
    row("booking", "booking_promo_codes", {
      id: PROMO,
      hotel_id: BOOKING_HOTEL,
      code: "SUMMER",
    }),
    row("pms", "booking_additional_guests", {
      id: "13550000-0000-4000-8000-000000000037",
      booking_id: BOOKING,
      first_name: "Leo",
      last_name: "Guest",
      nationality: "DE",
      created_at: "2026-08-01T00:00:00Z",
      updated_at: "2026-08-02T00:00:00Z",
    }),
    row("pms", "booking_change_requests", {
      id: "13550000-0000-4000-8000-000000000038",
      booking_id: BOOKING,
      status: "approved",
      old_check_in: "2026-09-01",
      old_check_out: "2026-09-04",
      requested_check_in: "2026-09-02",
      requested_check_out: "2026-09-05",
      currency: "EUR",
      decided_at: "2026-08-03T00:00:00Z",
      created_at: "2026-08-02T00:00:00Z",
    }),
    row("pms", "booking_promo_usage_state", {
      booking_reference: "VAY-RELATED",
      promo_code: "SUMMER",
      desired_state: "active",
      applied_state: "active",
      attempt_count: 1,
      created_at: "2026-08-01T00:00:00Z",
    }),
  ];
}

function row(
  sourceDatabase: "booking" | "pms",
  sourceTable: string,
  data: Record<string, unknown>,
): IdentitySourceRow {
  return { sourceDatabase, sourceTable, rowOrdinal: 1, data };
}

function input(rows: IdentitySourceRow[]) {
  return {
    sourceRunId: "vay1351-0123456789abcdef01234567",
    completedAt: "2026-08-30T00:00:00.000Z",
    rows,
    target: {
      propertyLinks: [
        {
          sourceSystem: "pms",
          sourceTable: "hotels",
          sourceId: PMS_HOTEL,
          propertyId: PROPERTY,
          relationship: "canonical_input",
          status: "active",
        },
        {
          sourceSystem: "booking",
          sourceTable: "booking_hotels",
          sourceId: BOOKING_HOTEL,
          propertyId: PROPERTY,
          relationship: "canonical_input",
          status: "active",
        },
      ],
      propertySlugs: [],
      records: [],
      provenance: [],
    },
  };
}
