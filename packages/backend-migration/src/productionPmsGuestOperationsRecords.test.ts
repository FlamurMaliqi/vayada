import { describe, expect, it } from "vitest";

import { createProductionPmsContext } from "./productionPmsContext.js";
import { buildPmsGuestOperationsRecords } from "./productionPmsGuestOperationsRecords.js";
import type { IdentitySourceRow } from "./productionIdentityDisposition.js";

const HOTEL = "10000000-0000-4000-a000-000000000001";
const PROPERTY = "20000000-0000-4000-a000-000000000001";
const BOOKING = "30000000-0000-4000-a000-000000000001";
const ASSIGNMENT = "40000000-0000-4000-a000-000000000001";
const USER = "50000000-0000-4000-a000-000000000001";

describe("production PMS guest operations", () => {
  it("preserves templates, check-in/out evidence, charges, and private notes", () => {
    const context = createProductionPmsContext({
      sourceRunId: "run",
      completedAt: "2026-08-30T00:00:00Z",
      rows: rows(),
      target: target(),
    });
    const records = buildPmsGuestOperationsRecords(context, {
      records: [],
      assignmentByBookingPosition: new Map([[`${BOOKING}:1`, ASSIGNMENT]]),
    });
    expect(context.blockers).toEqual([]);
    expect(records.map((record) => record.targetTable).sort()).toEqual([
      "booking_checkin_records",
      "booking_checkout_charges",
      "booking_checkout_records",
      "booking_notes_private",
      "checkin_checklist_templates",
      "checkout_inspection_templates",
    ]);
    expect(
      records.find((record) => record.targetTable === "booking_checkout_charges")?.row,
    ).toMatchObject({ assignmentId: ASSIGNMENT, currency: "EUR", status: "paid" });
    expect(
      records.find((record) => record.targetTable === "booking_notes_private")?.row,
    ).toMatchObject({ body: "Internal note", source: "pms", authorUserId: USER });
  });

  it("blocks missing target users", () => {
    const targetState = target();
    targetState.userIds = [];
    const context = createProductionPmsContext({
      sourceRunId: "run",
      completedAt: "2026-08-30T00:00:00Z",
      rows: rows(),
      target: targetState,
    });
    buildPmsGuestOperationsRecords(context, {
      records: [],
      assignmentByBookingPosition: new Map([[`${BOOKING}:1`, ASSIGNMENT]]),
    });
    expect(
      context.blockers.some((blocker) => blocker.message.includes("missing target user")),
    ).toBe(true);
  });
});

function rows(): IdentitySourceRow[] {
  return [
    row("bookings", { id: BOOKING, hotel_id: HOTEL }),
    row("checkin_checklist_templates", {
      hotel_id: HOTEL,
      steps: [{ key: "id" }],
      updated_by: USER,
      updated_at: "2026-08-20T00:00:00Z",
    }),
    row("checkout_inspection_templates", {
      hotel_id: HOTEL,
      steps: [{ key: "keys" }],
      updated_by: USER,
      updated_at: "2026-08-20T00:00:00Z",
    }),
    row("booking_checkin_records", {
      id: "60000000-0000-4000-a000-000000000001",
      booking_id: BOOKING,
      completed_by: USER,
      completed_at: "2026-09-01T14:00:00Z",
      step_results: [],
      pending_flags: [],
    }),
    row("booking_checkout_charges", {
      id: "70000000-0000-4000-a000-000000000001",
      booking_id: BOOKING,
      hotel_id: HOTEL,
      label: "Minibar",
      amount: "10.00",
      original_amount: "10.00",
      status: "paid",
      created_by: USER,
      created_at: "2026-09-03T10:00:00Z",
      settled_at: "2026-09-03T11:00:00Z",
    }),
    row("booking_checkout_records", {
      id: "80000000-0000-4000-a000-000000000001",
      booking_id: BOOKING,
      completed_by: USER,
      completed_at: "2026-09-03T11:00:00Z",
      inspection_results: [],
      charges_settled: [],
      pending_flags: [],
      checkout_notes: "Done",
    }),
    row("booking_notes", {
      id: "90000000-0000-4000-a000-000000000001",
      booking_id: BOOKING,
      hotel_id: HOTEL,
      author_user_id: USER,
      author_name: "Operator",
      body: "Internal note",
      source: "booking-detail",
      created_at: "2026-08-20T00:00:00Z",
    }),
  ];
}

function target() {
  return {
    propertyLinks: [
      {
        sourceId: HOTEL,
        propertyId: PROPERTY,
        relationship: "operational_input",
        status: "active",
      },
    ],
    bookings: [
      {
        id: BOOKING,
        propertyId: PROPERTY,
        checkIn: "2026-09-01",
        checkOut: "2026-09-03",
        adults: 2,
        children: 0,
        currency: "EUR",
        lifecycleStatus: "completed",
        updatedAt: "2026-09-03T11:00:00Z",
      },
    ],
    userIds: [USER],
    mediaIds: [],
    records: [],
    provenance: [],
  };
}

function row(sourceTable: string, data: Record<string, unknown>): IdentitySourceRow {
  return { sourceDatabase: "pms", sourceTable, rowOrdinal: 1, data };
}
