import { describe, expect, it } from "vitest";

import { createProductionBookingContext } from "./productionBookingContext.js";
import { buildBookingDraftRecords } from "./productionBookingDraftRecords.js";
import type { IdentitySourceRow } from "./productionIdentityDisposition.js";

const HOTEL = "13550000-0000-4000-8000-000000000021";
const PROPERTY = "13550000-0000-4000-8000-000000000022";
const DRAFT = "13550000-0000-4000-8000-000000000023";
const BOOKING = "13550000-0000-4000-8000-000000000024";

describe("production Booking draft records", () => {
  it("keeps an unmaterialized soft hold as quote and checkout history", () => {
    const context = createProductionBookingContext(input([draft()]));
    const records = buildBookingDraftRecords(context);
    expect(context.blockers).toEqual([]);
    expect(records.map((record) => record.targetTable)).toEqual([
      "quote_sessions",
      "checkout_contexts",
    ]);
    expect(records[0]!.row).toMatchObject({
      propertyId: PROPERTY,
      status: "active",
      publicQuoteReference: "MIG-Q-VAY-DRAFT",
    });
    expect(records[1]!.row).toMatchObject({
      id: DRAFT,
      status: "active",
      piiRetentionUntil: "2026-08-30",
      guestInput: { email: "private@example.test" },
    });
    const quote = JSON.stringify(records[0]!.row);
    expect(quote).not.toContain("private@example.test");
  });

  it("marks expired and materialized drafts deterministically", () => {
    const expired = draft();
    expired.data["expires_at"] = "2026-08-29T23:00:00Z";
    const materialized = draft();
    materialized.data["id"] = "13550000-0000-4000-8000-000000000025";
    materialized.data["booking_reference"] = "VAY-MATERIALIZED";
    materialized.data["materialized_booking_id"] = BOOKING;
    const booking = row("bookings", { id: BOOKING, booking_reference: "VAY-MATERIALIZED" });
    const context = createProductionBookingContext(input([expired, materialized, booking]));
    const records = buildBookingDraftRecords(context);
    expect(records.filter((record) => record.row["status"] === "expired")).toHaveLength(2);
    expect(records.filter((record) => record.row["status"] === "converted")).toHaveLength(2);
  });

  it("blocks dangling materialization links", () => {
    const source = draft();
    source.data["materialized_booking_id"] = BOOKING;
    const context = createProductionBookingContext(input([source]));
    expect(buildBookingDraftRecords(context)).toEqual([]);
    expect(context.blockers[0]).toMatchObject({ code: "INVALID_SOURCE_ROW", sourceId: DRAFT });
  });
});

function draft(): IdentitySourceRow {
  return row("booking_drafts", {
    id: DRAFT,
    hotel_id: HOTEL,
    room_type_id: "13550000-0000-4000-8000-000000000026",
    booking_reference: "VAY-DRAFT",
    stripe_payment_intent_id: "pi_private",
    check_in: "2026-09-01",
    check_out: "2026-09-04",
    number_of_rooms: 1,
    payload: {
      guest_first_name: "Mira",
      guest_last_name: "Guest",
      guest_email: "private@example.test",
      guest_phone: "+43123",
      adults: 2,
      children: 0,
      currency: "EUR",
      total_amount: "420",
      addon_ids: [],
    },
    expires_at: "2026-08-30T00:15:00Z",
    created_at: "2026-08-30T00:00:00Z",
  });
}

function row(sourceTable: string, data: Record<string, unknown>): IdentitySourceRow {
  return { sourceDatabase: "pms", sourceTable, rowOrdinal: 1, data };
}

function input(rows: IdentitySourceRow[]) {
  return {
    sourceRunId: "vay1351-0123456789abcdef01234567",
    completedAt: "2026-08-30T00:05:00.000Z",
    rows,
    target: {
      propertyLinks: [
        {
          sourceSystem: "pms",
          sourceTable: "hotels",
          sourceId: HOTEL,
          propertyId: PROPERTY,
          relationship: "operational_input",
          status: "active",
        },
      ],
      propertySlugs: [],
      records: [],
      provenance: [],
    },
  };
}
