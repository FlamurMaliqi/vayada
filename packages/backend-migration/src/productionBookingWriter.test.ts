import { describe, expect, it } from "vitest";

import {
  writeProductionBookingInferences,
  writeProductionBookingQuarantines,
  writeProductionBookingRecords,
  writeProductionMigrationProvenance,
} from "./productionBookingWriter.js";
import type { BookingTargetRecord } from "./productionBookingTypes.js";

const RUN = "vay1351-0123456789abcdef01234567";

describe("production Booking writers", () => {
  it("bounds the shared provenance writer without changing run evidence or row order", async () => {
    const batches: unknown[][] = [];
    const client = {
      async query(sql: string, values: unknown[]) {
        expect(sql).toContain("INSERT INTO platform.production_migration_source_links");
        expect(values[1]).toBe(RUN);
        const rows = JSON.parse(String(values[0]));
        batches.push(rows);
        return { rowCount: rows.length };
      },
    };
    const links = Array.from({ length: 1_001 }, (_, index) => ({
      sourceDatabase: "pms" as const,
      sourceTable: "room_types",
      sourceId: "room",
      targetProduct: "pms",
      targetTable: "inventory_days",
      targetId: `inventory-${index}`,
      sourceChecksum: "a".repeat(64),
      sourceUpdatedAt: "2026-08-30T00:00:00.000Z",
      lastMigratedAt: "2026-08-30T01:00:00.000Z",
    }));
    expect(await writeProductionMigrationProvenance(client as never, links, RUN)).toBe(1_001);
    expect(batches.map((batch) => batch.length)).toEqual([500, 500, 1]);
    expect(batches.flat()).toEqual(links);
  });

  it("upserts mutable rows but keeps immutable rows conflict-safe", async () => {
    const client = new WriterFixture();
    const counts = await writeProductionBookingRecords(client as never, [
      record("booking_settings", { propertyId: "13550000-0000-4000-8000-000000000061" }),
      record("same_day_booking_policies", {
        propertyId: "13550000-0000-4000-8000-000000000064",
      }),
      record("booking_status_events", { id: "13550000-0000-4000-8000-000000000062" }),
    ]);
    expect(counts).toEqual({
      booking_settings: 1,
      same_day_booking_policies: 1,
      booking_status_events: 1,
    });
    expect(client.sql[0]).toContain("ON CONFLICT (property_id) DO UPDATE SET");
    expect(client.sql[0]).not.toContain("created_at = EXCLUDED.created_at");
    expect(client.sql[1]).toContain("booking.same_day_booking_policies");
    expect(client.sql[2]).toContain("ON CONFLICT (id) DO NOTHING");
  });

  it("keeps first-run provenance and advances only the latest source evidence", async () => {
    const client = new WriterFixture();
    const count = await writeProductionMigrationProvenance(
      client as never,
      [
        {
          sourceDatabase: "pms",
          sourceTable: "bookings",
          sourceId: "booking-1",
          targetProduct: "booking",
          targetTable: "guest_bookings",
          targetId: "13550000-0000-4000-8000-000000000063",
          sourceChecksum: "a".repeat(64),
          sourceUpdatedAt: "2026-08-30T00:00:00.000Z",
          lastMigratedAt: "2026-08-30T01:00:00.000Z",
        },
      ],
      RUN,
    );
    expect(count).toBe(1);
    expect(client.sql[0]).toContain("first_run_id, last_run_id");
    expect(client.sql[0]).toContain("last_migrated_at = now()");
    expect(client.values[0]?.[1]).toBe(RUN);
  });

  it("stores only hash evidence for quarantined Booking fields", async () => {
    const client = new WriterFixture();
    const count = await writeProductionBookingQuarantines(
      client as never,
      [
        {
          sourceDatabase: "pms",
          sourceTable: "booking_additional_guests",
          sourceId: "guest-1",
          sourceField: "passport_number",
          sourceValueSha256: "b".repeat(64),
          reasonCode: "UNSUPPORTED_GUEST_PRIVATE_FIELD",
          retentionUntil: "2027-09-04",
        },
      ],
      RUN,
    );

    expect(count).toBe(1);
    expect(client.sql[0]).toContain("production_booking_migration_quarantines");
    expect(client.sql[0]).toContain("ON CONFLICT DO NOTHING");
    expect(JSON.stringify(client.values[0])).not.toContain("passport-value");
  });

  it("stores immutable pre-switch billing inference evidence", async () => {
    const client = new WriterFixture();
    const count = await writeProductionBookingInferences(
      client as never,
      [
        {
          sourceDatabase: "pms",
          sourceTable: "bookings",
          sourceId: "booking-1",
          sourceField: "billing_plan_at_creation",
          sourceValueSha256: "b".repeat(64),
          sourceRowSha256: "c".repeat(64),
          inferredValue: "commission",
          reasonCode: "MISSING_BILLING_PLAN_PRE_SWITCH_COMMISSION",
        },
      ],
      RUN,
    );

    expect(count).toBe(1);
    expect(client.sql[0]).toContain("production_booking_migration_inferences");
    expect(client.sql[0]).toContain("ON CONFLICT DO NOTHING");
  });
});

class WriterFixture {
  sql: string[] = [];
  values: unknown[][] = [];
  async query(sql: string, values: unknown[] = []) {
    this.sql.push(sql);
    this.values.push(values);
    return { rows: sql.includes("AS count") ? [{ count: 1 }] : [], rowCount: 1 };
  }
}

function record(targetTable: string, row: Record<string, unknown>): BookingTargetRecord {
  return {
    targetProduct: "booking",
    targetTable,
    targetId: String(row["id"] ?? row["propertyId"]),
    sourceDatabase: "pms",
    sourceTable: "bookings",
    sourceId: "source-1",
    sourceChecksum: "a".repeat(64),
    sourceUpdatedAt: "2026-08-30T00:00:00.000Z",
    mutable: targetTable === "booking_settings" || targetTable === "same_day_booking_policies",
    row,
  };
}
