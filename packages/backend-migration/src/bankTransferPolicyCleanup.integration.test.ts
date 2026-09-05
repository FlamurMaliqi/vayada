import { readFile } from "node:fs/promises";
import pg from "pg";
import { expect, it } from "vitest";
import { assertSafeTestDatabase } from "./testUtils.js";

it.skipIf(!process.env.TEST_DATABASE_URL)(
  "discards policy, booking, retry and email credentials without migrating them",
  async () => {
    assertSafeTestDatabase(process.env.TEST_DATABASE_URL!);
    const client = new pg.Client({ connectionString: process.env.TEST_DATABASE_URL });
    await client.connect();
    try {
      await client.query(`BEGIN;
      CREATE SCHEMA finance; CREATE SCHEMA booking; CREATE SCHEMA platform;
      CREATE TABLE finance.payment_settings(deposit_policy JSONB);
      CREATE TABLE booking.guest_bookings(booking_metadata JSONB);
      CREATE TABLE platform.idempotency_keys(operation_scope TEXT, idempotency_metadata JSONB);
      CREATE TABLE platform.jobs(queue_name TEXT, payload JSONB);
      CREATE TABLE platform.domain_events(source_system TEXT, payload JSONB);
      CREATE FUNCTION platform.immutable() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'immutable'; END; $$;
      CREATE TRIGGER trg_platform_domain_events_append_only BEFORE UPDATE ON platform.domain_events
        FOR EACH ROW EXECUTE FUNCTION platform.immutable();
      INSERT INTO finance.payment_settings VALUES ('{"bankName":"SECRET","bankTransferInstructions":"SECRET","paypalEmail":"pay@example.test"}');
      INSERT INTO booking.guest_bookings VALUES ('{"paymentMethod":"bank_transfer","paymentInstructions":{"bankTransferDetails":"SECRET"}}');
      INSERT INTO platform.idempotency_keys VALUES ('booking','{"responseBody":{"booking":{"bankTransferDetails":"SECRET"}}}');
      INSERT INTO platform.jobs VALUES ('platform.email','{"text":"Bank details: SECRET","bankTransferDetails":"SECRET","to":"guest@example.test"}');
      INSERT INTO platform.domain_events VALUES ('booking','{"text":"Bank details: SECRET","bankTransferDetails":"SECRET"}');`);
      await client.query(
        await readFile(
          new URL(
            "../migrations/0153_remove_bank_transfer_policy_credentials.sql",
            import.meta.url,
          ),
          "utf8",
        ),
      );
      for (const table of [
        "finance.payment_settings",
        "booking.guest_bookings",
        "platform.idempotency_keys",
        "platform.jobs",
        "platform.domain_events",
      ])
        expect(JSON.stringify((await client.query(`SELECT * FROM ${table}`)).rows)).not.toContain(
          "SECRET",
        );
      expect(
        (await client.query("SELECT deposit_policy FROM finance.payment_settings")).rows,
      ).toEqual([{ deposit_policy: { paypalEmail: "pay@example.test" } }]);
      expect(
        (await client.query("SELECT payload->>'to' AS recipient FROM platform.jobs")).rows,
      ).toEqual([{ recipient: "guest@example.test" }]);
      await client.query("SAVEPOINT policy");
      await expect(
        client.query(
          `INSERT INTO finance.payment_settings VALUES ('{"bankTransferDetails":"SECRET"}')`,
        ),
      ).rejects.toMatchObject({ code: "23514" });
      await client.query("ROLLBACK TO policy");
      await expect(client.query("UPDATE platform.domain_events SET payload='{}'")).rejects.toThrow(
        "immutable",
      );
    } finally {
      await client.query("ROLLBACK");
      await client.end();
    }
  },
);
