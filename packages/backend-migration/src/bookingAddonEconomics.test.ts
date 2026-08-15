import { readFile } from "node:fs/promises";
import { join } from "node:path";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { assertSafeTestDatabase } from "./testUtils.js";

const migration = await readFile(
  join(import.meta.dirname, "../migrations/0091_booking_addon_economics.sql"),
  "utf8",
);
const TEST_DATABASE_URL = process.env["TEST_DATABASE_URL"];
const PROPERTY_ID = "20000000-0000-4000-8000-000000000001";
const BOOKING_ID = "30000000-0000-4000-8000-000000000001";
const QUOTE_ID = "40000000-0000-4000-8000-000000000001";
const DEFINITION_ID = "50000000-0000-4000-8000-000000000001";
const PURCHASED_ID = "60000000-0000-4000-8000-000000000001";
const PROVISIONAL_ID = "60000000-0000-4000-8000-000000000002";

describe("Booking add-on economics migration contract", () => {
  it("does not project generic snapshots or definition metadata", () => {
    const projection = migration.slice(migration.indexOf("CREATE VIEW"));
    expect(projection).toContain("booking.finance_addon_purchase_evidence");
    expect(projection).not.toMatch(/addon_snapshot|metadata|source_system/i);
    expect(migration).toContain("ADD COLUMN ownership_kind TEXT NOT NULL DEFAULT 'property'");
    expect(migration).toContain(
      "ADD COLUMN ownership_kind_snapshot TEXT NOT NULL DEFAULT 'property'",
    );
  });
});

describe.skipIf(!TEST_DATABASE_URL)("Booking add-on economics (PostgreSQL)", () => {
  let client: pg.Client;

  beforeAll(async () => {
    assertSafeTestDatabase(TEST_DATABASE_URL!);
    client = new pg.Client({ connectionString: TEST_DATABASE_URL });
    await client.connect();
    await cleanup();
    await client.query(
      `INSERT INTO hotel_catalog.properties (id, public_id, display_name)
       VALUES ($1, 'vay-1190-addon-economics', 'VAY-1190 add-on economics')`,
      [PROPERTY_ID],
    );
    await client.query(
      `INSERT INTO booking.guest_bookings
         (id, property_id, public_reference, lifecycle_status, check_in, check_out,
          currency, total_amount, balance_amount, booking_channel, direct_booking_source)
       VALUES ($1, $2, 'VAY-1190-BOOKING', 'confirmed', '2026-09-01', '2026-09-02',
               'EUR', 25, 25, 'direct', 'call')`,
      [BOOKING_ID, PROPERTY_ID],
    );
    await client.query(
      `INSERT INTO booking.quote_sessions
         (id, property_id, request_hash, public_quote_reference,
          requested_check_in, requested_check_out, currency, expires_at)
       VALUES ($1, $2, 'vay-1190-quote-hash', 'VAY-1190-QUOTE',
               '2026-09-01', '2026-09-02', 'EUR', '2026-09-01T00:00:00Z')`,
      [QUOTE_ID, PROPERTY_ID],
    );
    await client.query(
      `INSERT INTO booking.addon_definitions
         (id, property_id, name, pricing_model, price_amount, currency)
       VALUES ($1, $2, 'Airport transfer', 'per_stay', 25, 'EUR')`,
      [DEFINITION_ID, PROPERTY_ID],
    );
    await client.query(
      `INSERT INTO booking.booking_addon_selections
         (id, property_id, guest_booking_id, addon_definition_id, total_amount, currency)
       VALUES ($1, $2, $3, $4, 25, 'EUR')`,
      [PURCHASED_ID, PROPERTY_ID, BOOKING_ID, DEFINITION_ID],
    );
    await client.query(
      `INSERT INTO booking.booking_addon_selections
         (id, property_id, quote_session_id, addon_definition_id, total_amount, currency)
       VALUES ($1, $2, $3, $4, 10, 'EUR')`,
      [PROVISIONAL_ID, PROPERTY_ID, QUOTE_ID, DEFINITION_ID],
    );
  });

  afterAll(async () => {
    try {
      await cleanup();
    } finally {
      await client.end();
    }
  });

  it("defaults historical definitions and selections to property-owned", async () => {
    const definition = await client.query(
      "SELECT ownership_kind, partner_commission_rate FROM booking.addon_definitions",
    );
    const selection = await client.query(
      "SELECT ownership_kind_snapshot, partner_commission_rate_snapshot FROM booking.booking_addon_selections WHERE id = $1",
      [PURCHASED_ID],
    );
    expect(definition.rows[0]).toEqual({
      ownership_kind: "property",
      partner_commission_rate: null,
    });
    expect(selection.rows[0]).toEqual({
      ownership_kind_snapshot: "property",
      partner_commission_rate_snapshot: null,
    });
  });

  it("enforces canonical definition economics without rounding excess precision", async () => {
    await client.query(
      "UPDATE booking.addon_definitions SET ownership_kind = 'partner', partner_commission_rate = 25.1250",
    );
    const purchased = await client.query(
      "SELECT ownership_kind_snapshot, partner_commission_rate_snapshot FROM booking.booking_addon_selections WHERE id = $1",
      [PURCHASED_ID],
    );
    expect(purchased.rows[0]).toEqual({
      ownership_kind_snapshot: "property",
      partner_commission_rate_snapshot: null,
    });
    for (const rate of ["-0.0001", "25.12345", "100.0001"]) {
      await expect(
        client.query("UPDATE booking.addon_definitions SET partner_commission_rate = $1", [rate]),
      ).rejects.toMatchObject({ constraint: "chk_addon_definitions_economic_pair" });
    }
    await expect(
      client.query("UPDATE booking.addon_definitions SET ownership_kind = 'property'"),
    ).rejects.toMatchObject({ constraint: "chk_addon_definitions_economic_pair" });
    await client.query(
      "UPDATE booking.addon_definitions SET ownership_kind = 'property', partner_commission_rate = NULL",
    );
    await expect(
      client.query("UPDATE booking.addon_definitions SET ownership_kind = 'partner'"),
    ).rejects.toMatchObject({ constraint: "chk_addon_definitions_economic_pair" });
  });

  it("freezes purchased evidence but leaves provisional rows editable", async () => {
    await expect(
      client.query("UPDATE booking.booking_addon_selections SET total_amount = 30 WHERE id = $1", [
        PURCHASED_ID,
      ]),
    ).rejects.toMatchObject({ code: "55000" });
    await expect(
      client.query(
        "UPDATE booking.booking_addon_selections SET guest_booking_id = NULL, quote_session_id = $2 WHERE id = $1",
        [PURCHASED_ID, QUOTE_ID],
      ),
    ).rejects.toMatchObject({ code: "55000" });
    await expect(
      client.query(
        "UPDATE booking.booking_addon_selections SET service_date = '2026-09-02' WHERE id = $1",
        [PURCHASED_ID],
      ),
    ).rejects.toMatchObject({ code: "55000" });
    await expect(
      client.query(
        "UPDATE booking.booking_addon_selections SET ownership_kind_snapshot = 'partner' WHERE id = $1",
        [PROVISIONAL_ID],
      ),
    ).rejects.toMatchObject({ constraint: "chk_booking_addon_selections_economic_pair" });
    await client.query(
      `UPDATE booking.booking_addon_selections
       SET total_amount = 12, ownership_kind_snapshot = 'partner', partner_commission_rate_snapshot = 20
       WHERE id = $1`,
      [PROVISIONAL_ID],
    );
    await expect(
      client.query("DELETE FROM booking.booking_addon_selections WHERE id = $1", [PURCHASED_ID]),
    ).rejects.toMatchObject({ code: "55000" });
    await client.query("DELETE FROM booking.booking_addon_selections WHERE id = $1", [
      PROVISIONAL_ID,
    ]);
    await expect(client.query("TRUNCATE booking.booking_addon_selections")).rejects.toMatchObject({
      code: "55000",
    });
  });

  it("exposes only purchased Finance-safe evidence and rejects writes", async () => {
    const projected = await client.query("SELECT * FROM booking.finance_addon_purchase_evidence");
    expect(projected.rows).toHaveLength(1);
    expect(projected.fields.map((field) => field.name)).toEqual([
      "selection_id",
      "property_id",
      "guest_booking_id",
      "addon_definition_id",
      "service_date",
      "quantity",
      "gross_amount",
      "currency",
      "ownership_kind",
      "partner_commission_rate",
    ]);
    await expect(
      client.query("UPDATE booking.finance_addon_purchase_evidence SET gross_amount = 99"),
    ).rejects.toMatchObject({ code: "55000" });
    await expect(
      client.query("DELETE FROM booking.finance_addon_purchase_evidence"),
    ).rejects.toMatchObject({ code: "55000" });
  });

  async function cleanup() {
    await client.query("BEGIN");
    try {
      await client.query("SET LOCAL session_replication_role = replica");
      await client.query("DELETE FROM booking.booking_addon_selections WHERE property_id = $1", [
        PROPERTY_ID,
      ]);
      await client.query("DELETE FROM booking.guest_bookings WHERE property_id = $1", [
        PROPERTY_ID,
      ]);
      await client.query("DELETE FROM booking.quote_sessions WHERE property_id = $1", [
        PROPERTY_ID,
      ]);
      await client.query("DELETE FROM booking.addon_definitions WHERE property_id = $1", [
        PROPERTY_ID,
      ]);
      await client.query("DELETE FROM hotel_catalog.properties WHERE id = $1", [PROPERTY_ID]);
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    }
  }
});
