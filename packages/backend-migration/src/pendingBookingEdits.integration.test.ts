import { randomUUID } from "node:crypto";
import { join } from "node:path";
import pg from "pg";
import { describe, expect, it } from "vitest";

import { runMigrations } from "./runner.js";
import { assertSafeTestDatabase } from "./testUtils.js";

const connectionString = process.env["TEST_DATABASE_URL"];

describe.skipIf(!connectionString)("pending booking edit storage", () => {
  it("isolates revisions and rejects cross-property attempts without losing historical evidence", async () => {
    assertSafeTestDatabase(connectionString!);
    const migrations = await runMigrations({
      connectionString: connectionString!,
      migrationsDir: join(import.meta.dirname, "../migrations"),
      environment: "local",
    });
    expect(migrations.failed).toBeNull();
    const client = new pg.Client({ connectionString });
    await client.connect();
    await client.query("BEGIN");
    try {
      const propertyId = randomUUID();
      const otherPropertyId = randomUUID();
      const bookingId = randomUUID();
      const quoteId = randomUUID();
      await client.query(
        `INSERT INTO hotel_catalog.properties (id,public_id,display_name)
         VALUES ($1::uuid,$1::text,'Edit test'),($2::uuid,$2::text,'Other property')`,
        [propertyId, otherPropertyId],
      );
      await client.query(
        `INSERT INTO booking.guest_bookings
           (id,property_id,public_reference,lifecycle_status,check_in,check_out,currency)
         VALUES ($1::uuid,$2::uuid,$1::text,'pending_payment','2027-01-01','2027-01-03','EUR')`,
        [bookingId, propertyId],
      );
      await client.query(
        `INSERT INTO booking.quote_sessions
           (id,property_id,request_hash,public_quote_reference,requested_check_in,
            requested_check_out,currency,expires_at)
         VALUES ($1::uuid,$2::uuid,$1::text,$1::text,'2027-01-01','2027-01-03','EUR',now()+interval '1 hour')`,
        [quoteId, propertyId],
      );
      const selections = await client.query<{ id: string }>(
        `INSERT INTO booking.booking_addon_selections
           (property_id,guest_booking_id,currency,total_amount,edit_revision)
         VALUES ($1,$2,'EUR',10,0),($1,$2,'EUR',20,1) RETURNING id`,
        [propertyId, bookingId],
      );
      const activeTotal = async () =>
        (
          await client.query(
            `SELECT total_amount FROM booking.active_booking_addon_selections
         WHERE guest_booking_id=$1`,
            [bookingId],
          )
        ).rows;
      expect(await activeTotal()).toEqual([{ total_amount: "10.00" }]);
      await client.query("SAVEPOINT replacement");
      await client.query("UPDATE booking.guest_bookings SET edit_revision=1 WHERE id=$1", [
        bookingId,
      ]);
      expect(await activeTotal()).toEqual([{ total_amount: "20.00" }]);
      expect(
        (
          await client.query(
            `SELECT selection_id FROM booking.finance_addon_purchase_evidence
        WHERE guest_booking_id=$1`,
            [bookingId],
          )
        ).rows,
      ).toHaveLength(2);
      await client.query("ROLLBACK TO SAVEPOINT replacement");
      expect(await activeTotal()).toEqual([{ total_amount: "10.00" }]);

      const rejects = async (sql: string, values: unknown[], code: string) => {
        await client.query("SAVEPOINT invalid_write");
        await expect(client.query(sql, values)).rejects.toMatchObject({ code });
        await client.query("ROLLBACK TO SAVEPOINT invalid_write");
      };
      await rejects(
        "UPDATE booking.booking_addon_selections SET edit_revision=2 WHERE id=$1",
        [selections.rows[0]!.id],
        "55000",
      );
      await rejects(
        "DELETE FROM booking.booking_addon_selections WHERE id=$1",
        [selections.rows[0]!.id],
        "55000",
      );
      const attemptSql = `INSERT INTO booking.pending_booking_edit_attempts
        (property_id,guest_booking_id,expected_revision,idempotency_key,request_fingerprint,
         quote_session_id,payment_method,expires_at)
        VALUES ($1,$2,0,'test-edit','fingerprint',$3,'pay_at_property',now()+interval '15 minutes')`;
      await rejects(attemptSql, [otherPropertyId, bookingId, quoteId], "23503");
      await client.query(attemptSql, [propertyId, bookingId, quoteId]);
      await rejects(attemptSql, [propertyId, bookingId, quoteId], "23505");
      expect(
        (
          await client.query("SELECT id FROM finance.payments WHERE guest_booking_id=$1", [
            bookingId,
          ])
        ).rows,
      ).toHaveLength(0);
      expect(
        (
          await client.query("SELECT edit_revision FROM booking.guest_bookings WHERE id=$1", [
            bookingId,
          ])
        ).rows,
      ).toEqual([{ edit_revision: 0 }]);
    } finally {
      await client.query("ROLLBACK");
      await client.end();
    }
  }, 60_000);
});
