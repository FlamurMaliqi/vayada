import { describe, expect, it } from "vitest";

import { createProductionBookingContext } from "./productionBookingContext.js";
import { buildBookingReservationRecords } from "./productionBookingReservationRecords.js";
import type { IdentitySourceRow } from "./productionIdentityDisposition.js";

const HOTEL = "13550000-0000-4000-8000-000000000011";
const PROPERTY = "13550000-0000-4000-8000-000000000012";
const BOOKING = "13550000-0000-4000-8000-000000000013";
const DRAFT = "13550000-0000-4000-8000-000000000014";

describe("production Booking reservation records", () => {
  it("maps lifecycle, economics, private booker, and PII-free summary", () => {
    const context = createProductionBookingContext(input([booking()]));
    const records = buildBookingReservationRecords(context);
    expect(context.blockers).toEqual([]);
    expect(records.map((record) => record.targetTable)).toEqual([
      "guest_bookings",
      "booking_guests",
      "booking_status_events",
      "direct_booking_summary_read_model",
    ]);
    expect(records[0]!.row).toMatchObject({
      id: BOOKING,
      propertyId: PROPERTY,
      lifecycleStatus: "completed",
      paymentStatus: "paid",
      totalAmount: "420.00",
      balanceAmount: "0.00",
      bookingChannel: "direct",
      expectedPaymentMethod: "manual_card",
    });
    expect(records[1]!.row).toMatchObject({
      guestRole: "booker",
      countryCode: "AT",
      piiRetentionUntil: "2027-09-04",
    });
    const summary = JSON.stringify(records[3]!.row);
    expect(summary).not.toContain("Mira");
    expect(summary).not.toContain("private@example.test");
    expect(summary).not.toContain("+43123");
  });

  it("links a materialized draft through deterministic quote and checkout IDs", () => {
    const context = createProductionBookingContext(
      input([
        booking(),
        row("booking_drafts", {
          id: DRAFT,
          hotel_id: HOTEL,
          materialized_booking_id: BOOKING,
          booking_reference: "VAY-1355",
        }),
      ]),
    );
    const bookingRecord = buildBookingReservationRecords(context)[0]!;
    expect(bookingRecord.row["checkoutContextId"]).toBe(DRAFT);
    expect(bookingRecord.row["quoteSessionId"]).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("blocks unknown lifecycle states instead of guessing", () => {
    const source = booking();
    source.data["status"] = "mystery";
    const context = createProductionBookingContext(input([source]));
    expect(buildBookingReservationRecords(context)).toEqual([]);
    expect(context.blockers[0]).toMatchObject({ code: "INVALID_SOURCE_ROW", sourceId: BOOKING });
  });
});

function booking(): IdentitySourceRow {
  return row("bookings", {
    id: BOOKING,
    hotel_id: HOTEL,
    room_type_id: "13550000-0000-4000-8000-000000000015",
    booking_reference: "VAY-1355",
    guest_first_name: "Mira",
    guest_last_name: "Guest",
    guest_email: "private@example.test",
    guest_phone: "+43123",
    guest_country: "AT",
    special_requests: "Private request",
    estimated_arrival_time: "18:00",
    check_in: "2026-09-01",
    check_out: "2026-09-04",
    adults: 2,
    children: 0,
    number_of_rooms: 1,
    currency: "EUR",
    total_amount: "420",
    balance_amount: "0",
    status: "checked_out",
    payment_status: "captured",
    payment_method: "card",
    channel: "direct",
    rate_type: "flexible",
    created_at: "2026-08-01T00:00:00Z",
    updated_at: "2026-09-04T12:00:00Z",
  });
}

function row(sourceTable: string, data: Record<string, unknown>): IdentitySourceRow {
  return { sourceDatabase: "pms", sourceTable, rowOrdinal: 1, data };
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
          sourceId: HOTEL,
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
