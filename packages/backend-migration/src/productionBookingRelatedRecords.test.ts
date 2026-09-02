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
    expect(context.quarantines).toEqual([
      expect.objectContaining({
        sourceField: "passport_number",
        reasonCode: "UNSUPPORTED_GUEST_PRIVATE_FIELD",
        retentionUntil: "2027-09-04",
      }),
    ]);
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
    expect(context.blockers.map((blocker) => blocker.code)).toContain(
      "PROMO_RECONCILIATION_PENDING",
    );
    expect(context.blockers).toContainEqual(
      expect.objectContaining({
        code: "INVALID_SOURCE_ROW",
        source: "pms.booking_additional_guests",
      }),
    );
  });

  it("uses immutable booked add-on totals and still blocks unknown change-request states", () => {
    const rows = allRows();
    const booking = rows.find((row) => row.sourceTable === "bookings")!;
    booking.data["addon_total"] = "29.99";
    const change = rows.find((row) => row.sourceTable === "booking_change_requests")!;
    change.data["status"] = "mystery";
    const context = createProductionBookingContext(input(rows));
    const records = buildBookingRelatedRecords(context);
    expect(
      records.find((record) => record.targetTable === "booking_addon_selections")?.row,
    ).toMatchObject({
      totalAmount: "29.99",
      addonSnapshot: { amountBasis: "booking_addon_total" },
    });
    expect(context.blockers).toEqual([
      expect.objectContaining({
        code: "INVALID_SOURCE_ROW",
        message: "change request status mystery is unsupported",
      }),
    ]);
  });

  it("drops empty guest placeholders with hash-only evidence", () => {
    const booking = allRows()[0]!;
    booking.data["addon_ids"] = [];
    booking.data["addon_names"] = [];
    booking.data["addon_quantities"] = {};
    booking.data["addon_dates"] = {};
    booking.data["addon_total"] = "0";
    const placeholder = row("pms", "booking_additional_guests", {
      id: "13550000-0000-4000-8000-000000000040",
      booking_id: BOOKING,
      first_name: "",
      last_name: "",
      created_at: "2026-08-01T00:00:00Z",
      updated_at: "2026-08-02T00:00:00Z",
    });
    const context = createProductionBookingContext(input([booking, placeholder]));

    expect(buildBookingRelatedRecords(context)).toEqual([]);
    expect(context.blockers).toEqual([]);
    expect(context.quarantines).toEqual([
      expect.objectContaining({
        sourceField: "*",
        reasonCode: "EMPTY_ADDITIONAL_GUEST_PLACEHOLDER",
        sourceValueSha256: expect.stringMatching(/^[0-9a-f]{64}$/),
      }),
    ]);
  });

  it("preserves multi-add-on names, quantities, and aggregate booked total", () => {
    const rows = allRows().slice(0, 2);
    const booking = rows[0]!;
    const missingAddon = "13550000-0000-4000-8000-000000000041";
    booking.data["addon_ids"] = [ADDON, missingAddon];
    booking.data["addon_names"] = ["Breakfast", "Airport transfer"];
    booking.data["addon_quantities"] = { [ADDON]: 2, [missingAddon]: 1 };
    booking.data["addon_total"] = "9500";
    const context = createProductionBookingContext(input(rows));
    const selections = buildBookingRelatedRecords(context);

    expect(context.blockers).toEqual([]);
    expect(selections).toHaveLength(1);
    expect(selections[0]!.row).toMatchObject({
      addonDefinitionId: null,
      quantity: 1,
      totalAmount: "9500.00",
      addonSnapshot: {
        name: "Breakfast, Airport transfer",
        nameBasis: "booking_snapshot_bundle",
        amountBasis: "booking_addon_total",
        items: [
          {
            sourceAddonId: ADDON,
            name: "Breakfast",
            quantity: 2,
            serviceDates: ["2026-09-02"],
          },
          {
            sourceAddonId: missingAddon,
            name: "Airport transfer",
            quantity: 1,
            serviceDates: [],
            definitionStatus: "missing_at_snapshot",
          },
        ],
      },
    });
  });

  it.each([
    [[], null],
    [["2026-09-02"], "2026-09-02"],
    [["2026-09-02", "2026-09-03"], null],
  ])(
    "preserves add-on date arrays %j without recomputing economics",
    (serviceDates, serviceDate) => {
      const rows = allRows().slice(0, 2);
      rows[0]!.data["addon_dates"] = { [ADDON]: serviceDates };
      const context = createProductionBookingContext(input(rows));
      const [selection] = buildBookingRelatedRecords(context);

      expect(context.blockers).toEqual([]);
      expect(selection?.row).toMatchObject({
        serviceDate,
        totalAmount: "30.00",
        addonSnapshot: { serviceDates },
      });
    },
  );

  it.each([
    {
      addon_names: ["Breakfast"],
      addon_quantities: {},
      expected: {
        name: "Breakfast",
        nameBasis: "booking_snapshot",
        quantity: 1,
        quantityBasis: "legacy_invoice_default",
      },
    },
    {
      addon_names: [],
      addon_quantities: {},
      expected: {
        name: "Add-ons",
        nameBasis: "legacy_invoice_fallback",
        quantity: 1,
        quantityBasis: "legacy_invoice_default",
      },
    },
  ])(
    "uses the deployed legacy invoice fallback for incomplete add-on snapshots",
    ({ addon_names, addon_quantities, expected }) => {
      const rows = allRows().slice(0, 2);
      Object.assign(rows[0]!.data, { addon_names, addon_quantities });
      const context = createProductionBookingContext(input(rows));
      const [selection] = buildBookingRelatedRecords(context);

      expect(context.blockers).toEqual([]);
      expect(selection?.row).toMatchObject({
        quantity: expected.quantity,
        totalAmount: "30.00",
        addonSnapshot: {
          name: expected.name,
          nameBasis: expected.nameBasis,
          quantityBasis: expected.quantityBasis,
          amountBasis: "booking_addon_total",
        },
      });
    },
  );

  it("keeps a multi-add-on aggregate once when legacy quantities are absent", () => {
    const rows = allRows().slice(0, 2);
    const secondAddon = "13550000-0000-4000-8000-000000000041";
    Object.assign(rows[0]!.data, {
      addon_ids: [ADDON, secondAddon],
      addon_names: ["Breakfast", "Airport transfer"],
      addon_quantities: {},
      addon_total: "9500",
    });
    const context = createProductionBookingContext(input(rows));
    const [selection] = buildBookingRelatedRecords(context);

    expect(context.blockers).toEqual([]);
    expect(selection?.row).toMatchObject({
      quantity: 1,
      totalAmount: "9500.00",
      addonSnapshot: {
        amountBasis: "booking_addon_total",
        items: [
          { name: "Breakfast", quantity: 1, quantityBasis: "legacy_invoice_default" },
          { name: "Airport transfer", quantity: 1, quantityBasis: "legacy_invoice_default" },
        ],
      },
    });
  });

  it("fails closed for ambiguous add-on snapshot shapes", () => {
    const secondAddon = "13550000-0000-4000-8000-000000000041";
    const unknownAddon = "13550000-0000-4000-8000-000000000042";
    const cases = [
      { addon_ids: [], addon_names: ["Breakfast"], addon_total: "30" },
      { addon_ids: [ADDON, secondAddon], addon_names: ["Breakfast"], addon_total: "30" },
      { addon_quantities: { [unknownAddon]: 1 }, addon_total: "30" },
      { addon_quantities: { [ADDON]: 0 }, addon_total: "30" },
      { addon_dates: { [ADDON]: "2026-09-02" }, addon_total: "30" },
    ];

    for (const patch of cases) {
      const rows = allRows().slice(0, 2);
      Object.assign(rows[0]!.data, patch);
      const context = createProductionBookingContext(input(rows));
      expect(buildBookingRelatedRecords(context)).toEqual([]);
      expect(context.blockers).toContainEqual(
        expect.objectContaining({ code: "INVALID_SOURCE_ROW", source: "pms.bookings" }),
      );
    }
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
      addon_names: ["Breakfast"],
      addon_quantities: { [ADDON]: 2 },
      addon_dates: { [ADDON]: ["2026-09-02"] },
      addon_total: "30",
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
    row("booking", "booking_promo_redemptions", {
      id: "13550000-0000-4000-8000-000000000039",
      promo_id: PROMO,
      redemption_key: `${BOOKING_HOTEL}:VAY-RELATED`,
      status: "active",
      created_at: "2026-08-01T00:00:00Z",
    }),
    row("pms", "booking_additional_guests", {
      id: "13550000-0000-4000-8000-000000000037",
      booking_id: BOOKING,
      first_name: "Leo",
      last_name: "Guest",
      nationality: "DE",
      passport_number: "private-passport",
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
          relationship: "operational_input",
          status: "active",
          ownerStatus: "active",
        },
        {
          sourceSystem: "booking",
          sourceTable: "booking_hotels",
          sourceId: BOOKING_HOTEL,
          propertyId: PROPERTY,
          relationship: "canonical_input",
          status: "active",
          ownerStatus: "active",
        },
      ],
      propertySlugs: [],
      records: [],
      provenance: [],
    },
  };
}
