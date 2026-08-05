import { readFile } from "node:fs/promises";
import { join } from "node:path";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { assertSafeTestDatabase } from "./testUtils.js";

const migration = await readFile(
  join(import.meta.dirname, "../migrations/0071_booking_finance_attribution.sql"),
  "utf8",
);
const TEST_DATABASE_URL = process.env["TEST_DATABASE_URL"];
const PROPERTY_ID = "20000000-0000-4000-8000-000000000001";

describe("Booking Finance attribution migration contract", () => {
  it("does not project private or mutable source payloads", () => {
    expect(migration).toContain("booking.finance_booking_attribution");
    expect(migration).not.toMatch(/source_booking_id|booking_metadata|assignment_payload/i);
  });
});

describe.skipIf(!TEST_DATABASE_URL)("Booking Finance attribution (PostgreSQL)", () => {
  let client: pg.Client;

  beforeAll(async () => {
    assertSafeTestDatabase(TEST_DATABASE_URL!);
    client = new pg.Client({ connectionString: TEST_DATABASE_URL });
    await client.connect();
    await client.query(`
      DROP SCHEMA IF EXISTS booking CASCADE; CREATE SCHEMA booking;
      CREATE TABLE booking.guest_bookings (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        property_id UUID NOT NULL,
        source_booking_id TEXT,
        lifecycle_status TEXT NOT NULL DEFAULT 'confirmed',
        check_in DATE NOT NULL DEFAULT '2026-09-01',
        check_out DATE NOT NULL DEFAULT '2026-09-02',
        total_amount NUMERIC(15, 2) NOT NULL DEFAULT 100,
        currency CHAR(3) NOT NULL DEFAULT 'EUR',
        booking_metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
      INSERT INTO booking.guest_bookings (property_id, source_booking_id)
      VALUES ('${PROPERTY_ID}', 'private-provider-reference');
    `);
    await client.query(migration);
  });

  afterAll(async () => {
    try {
      await client.query("DROP SCHEMA IF EXISTS booking CASCADE");
    } finally {
      await client.end();
    }
  });

  const insert = (channel: string, directSource: string | null) =>
    client.query(
      `INSERT INTO booking.guest_bookings
         (property_id, booking_channel, direct_booking_source)
       VALUES ($1, $2, $3)`,
      [PROPERTY_ID, channel, directSource],
    );

  it("keeps historical rows explicit and the projection private", async () => {
    const projected = await client.query("SELECT * FROM booking.finance_booking_attribution");
    expect(projected.rows[0]).toMatchObject({
      booking_channel: "unknown",
      direct_booking_source: null,
    });
    expect(projected.fields.map((field) => field.name)).toEqual([
      "guest_booking_id",
      "property_id",
      "booking_channel",
      "direct_booking_source",
      "lifecycle_status",
      "check_in",
      "check_out",
      "total_amount",
      "currency",
    ]);
    await expect(
      client.query("UPDATE booking.finance_booking_attribution SET booking_channel = 'other_ota'"),
    ).rejects.toMatchObject({ code: "55000" });
    await expect(
      client.query("UPDATE booking.guest_bookings SET booking_channel = 'other_ota'"),
    ).rejects.toMatchObject({ code: "55000" });
    await client.query("UPDATE booking.guest_bookings SET total_amount = total_amount + 1");
  });

  it("enforces canonical attribution pairs", async () => {
    await insert("direct", "booking_engine");
    await insert("booking_com", null);
    await insert("other_ota", null);
    await expect(insert("direct", null)).rejects.toMatchObject({
      constraint: "chk_guest_bookings_attribution_pair",
    });
    await expect(insert("airbnb", "other")).rejects.toMatchObject({
      constraint: "chk_guest_bookings_attribution_pair",
    });
    await expect(insert("made_up", null)).rejects.toMatchObject({
      constraint: "chk_guest_bookings_booking_channel",
    });
  });
});
