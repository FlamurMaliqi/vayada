import { readFile } from "node:fs/promises";
import pg from "pg";
import { expect, it } from "vitest";
import { assertSafeTestDatabase } from "./testUtils.js";

it.skipIf(!process.env.TEST_DATABASE_URL)(
  "constrains encrypted destinations and booking tenant bindings",
  async () => {
    assertSafeTestDatabase(process.env.TEST_DATABASE_URL!);
    const client = new pg.Client({ connectionString: process.env.TEST_DATABASE_URL });
    await client.connect();
    try {
      await client.query("BEGIN");
      await client.query(`CREATE SCHEMA hotel_catalog; CREATE SCHEMA booking; CREATE SCHEMA finance;
      CREATE TABLE hotel_catalog.properties(id UUID PRIMARY KEY);
      CREATE TABLE booking.guest_bookings(id UUID, property_id UUID, UNIQUE(id, property_id));
      INSERT INTO hotel_catalog.properties VALUES
        ('11111111-1111-4111-8111-111111111111'), ('22222222-2222-4222-8222-222222222222');
      INSERT INTO booking.guest_bookings VALUES
        ('33333333-3333-4333-8333-333333333333', '11111111-1111-4111-8111-111111111111');`);
      await client.query(
        await readFile(
          new URL("../migrations/0151_finance_bank_transfer_destinations.sql", import.meta.url),
          "utf8",
        ),
      );
      const insert = `INSERT INTO finance.bank_transfer_destinations
      (id, property_id, revision, ciphertext, key_arn, account_last4)
      VALUES ('44444444-4444-4444-8444-444444444444',
        '22222222-2222-4222-8222-222222222222', 1, $1, 'key', '3000')`;
      await client.query("SAVEPOINT invalid");
      await expect(client.query(insert, [Buffer.alloc(2)])).rejects.toMatchObject({
        code: "23514",
      });
      await client.query("ROLLBACK TO invalid");
      await client.query(insert, [Buffer.alloc(40)]);
      await client.query("SAVEPOINT tenant");
      await expect(
        client.query(`INSERT INTO finance.bank_transfer_bookings VALUES
      ('33333333-3333-4333-8333-333333333333', '11111111-1111-4111-8111-111111111111',
       '44444444-4444-4444-8444-444444444444')`),
      ).rejects.toMatchObject({ code: "23503" });
      await client.query("ROLLBACK TO tenant");
      await client.query("SAVEPOINT active");
      await expect(
        client.query(
          `INSERT INTO finance.bank_transfer_destinations
      (property_id, revision, ciphertext, key_arn, account_last4)
      VALUES ('22222222-2222-4222-8222-222222222222', 2, $1, 'key', '3000')`,
          [Buffer.alloc(40)],
        ),
      ).rejects.toMatchObject({ code: "23505" });
      await client.query("ROLLBACK TO active");
      await client.query("SAVEPOINT immutable");
      await expect(
        client.query(`UPDATE finance.bank_transfer_destinations SET revision = 2`),
      ).rejects.toMatchObject({ code: "55000" });
      await client.query("ROLLBACK TO immutable");
      await client.query(`INSERT INTO booking.guest_bookings VALUES
        ('55555555-5555-4555-8555-555555555555', '22222222-2222-4222-8222-222222222222');
        INSERT INTO finance.bank_transfer_bookings VALUES
        ('55555555-5555-4555-8555-555555555555', '22222222-2222-4222-8222-222222222222',
         '44444444-4444-4444-8444-444444444444')`);
      await client.query(`UPDATE finance.bank_transfer_destinations
      SET ciphertext = NULL, enabled = FALSE, deleted_at = now()`);
      expect(
        (await client.query("SELECT ciphertext FROM finance.bank_transfer_destinations")).rows,
      ).toEqual([{ ciphertext: null }]);
      await expect(
        client.query(
          `UPDATE finance.bank_transfer_destinations
        SET ciphertext = $1, deleted_at = NULL, enabled = TRUE`,
          [Buffer.alloc(40)],
        ),
      ).rejects.toMatchObject({ code: "55000" });
    } finally {
      await client.query("ROLLBACK");
      await client.end();
    }
  },
);
