import { describe, expect, it } from "vitest";

import {
  readProductionBookingOwnership,
  readProductionBookingTargetState,
} from "./productionBookingTargetReader.js";
import type { BookingTargetRecord } from "./productionBookingTypes.js";

describe("production Booking target reader", () => {
  it("reads canonical ownership, exact target IDs, and durable provenance", async () => {
    const client = new TargetFixture();
    const ownership = await readProductionBookingOwnership(client as never);
    const target = await readProductionBookingTargetState(client as never, candidates(), ownership);
    expect(ownership.propertyLinks[0]).toMatchObject({
      sourceSystem: "pms",
      propertyId: "property-1",
    });
    expect(target.records).toEqual([
      {
        targetProduct: "booking",
        targetTable: "booking_settings",
        targetId: "13550000-0000-4000-8000-000000000051",
        updatedAt: "2026-08-30T01:00:00.000Z",
        row: {
          propertyId: "13550000-0000-4000-8000-000000000051",
          sourceFreshness: { migrationRunId: "run", legacy_key: "preserved" },
        },
      },
      {
        targetProduct: "booking",
        targetTable: "direct_booking_summary_read_model",
        targetId: "13550000-0000-4000-8000-000000000052",
        updatedAt: "2026-08-30T02:00:00.000Z",
        row: { guestBookingId: "13550000-0000-4000-8000-000000000052" },
      },
      {
        targetProduct: "booking",
        targetTable: "guest_bookings",
        targetId: "13550000-0000-4000-8000-000000000053",
        updatedAt: "2026-08-30T04:00:00.000Z",
        row: {
          id: "13550000-0000-4000-8000-000000000053",
          sourceSystem: "pms",
          sourceBookingId: "legacy-extra-booking",
          lifecycleStatus: "confirmed",
          checkIn: "2026-09-01",
          checkOut: "2026-09-02",
        },
      },
    ]);
    expect(target.provenance[0]).toMatchObject({
      sourceDatabase: "pms",
      sourceTable: "bookings",
      lastMigratedAt: "2026-08-30T03:00:00.000Z",
    });
    expect(client.sql.join("\n")).toContain("WHERE property_id = ANY");
    expect(client.sql.join("\n")).toContain("WHERE guest_booking_id = ANY");
    expect(client.sql.join("\n")).toContain("jsonb_to_recordset");
  });
});

class TargetFixture {
  sql: string[] = [];
  async query<T>(sql: string): Promise<{ rows: T[] }> {
    this.sql.push(sql);
    if (sql.includes("property_source_links"))
      return {
        rows: [
          {
            sourceSystem: "pms",
            sourceTable: "hotels",
            sourceId: "hotel-1",
            propertyId: "property-1",
            relationship: "canonical_input",
            status: "active",
          },
        ] as T[],
      };
    if (sql.includes("property_slugs")) return { rows: [] };
    if (sql.includes("booking.booking_settings"))
      return {
        rows: [
          {
            targetId: "13550000-0000-4000-8000-000000000051",
            updatedAt: "2026-08-30 01:00:00+00",
            rowData:
              '{"property_id":"13550000-0000-4000-8000-000000000051","source_freshness":{"migrationRunId":"run","legacy_key":"preserved"}}',
          },
        ] as T[],
      };
    if (sql.includes("booking.direct_booking_summary_read_model"))
      return {
        rows: [
          {
            targetId: "13550000-0000-4000-8000-000000000052",
            updatedAt: "2026-08-30 02:00:00+00",
            rowData: '{"guest_booking_id":"13550000-0000-4000-8000-000000000052"}',
          },
        ] as T[],
      };
    if (sql.includes("FROM booking.guest_bookings AS target_row"))
      return {
        rows: [
          {
            targetId: "13550000-0000-4000-8000-000000000053",
            updatedAt: "2026-08-30 04:00:00+00",
            rowData: JSON.stringify({
              id: "13550000-0000-4000-8000-000000000053",
              source_system: "pms",
              source_booking_id: "legacy-extra-booking",
              lifecycle_status: "confirmed",
              check_in: "2026-09-01",
              check_out: "2026-09-02",
            }),
          },
        ] as T[],
      };
    if (sql.includes("production_migration_source_links"))
      return {
        rows: [
          {
            sourceDatabase: "pms",
            sourceTable: "bookings",
            sourceId: "booking-1",
            targetProduct: "booking",
            targetTable: "direct_booking_summary_read_model",
            targetId: "13550000-0000-4000-8000-000000000052",
            sourceChecksum: "a".repeat(64),
            sourceUpdatedAt: "2026-08-29 01:00:00+00",
            lastMigratedAt: "2026-08-30 03:00:00+00",
          },
        ] as T[],
      };
    return { rows: [] };
  }
}

function candidates(): BookingTargetRecord[] {
  const base = {
    targetProduct: "booking" as const,
    sourceDatabase: "pms" as const,
    sourceTable: "bookings",
    sourceId: "booking-1",
    sourceChecksum: "a".repeat(64),
    sourceUpdatedAt: "2026-08-29T01:00:00.000Z",
    mutable: true,
    row: {},
  };
  return [
    { ...base, targetTable: "booking_settings", targetId: "13550000-0000-4000-8000-000000000051" },
    {
      ...base,
      targetTable: "direct_booking_summary_read_model",
      targetId: "13550000-0000-4000-8000-000000000052",
    },
  ];
}
