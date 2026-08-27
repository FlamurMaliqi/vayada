import { cp, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pg from "pg";
import { describe, expect, it } from "vitest";

import { runMigrations } from "./runner.js";
import { assertSafeTestDatabase } from "./testUtils.js";

const URL = process.env["TEST_DATABASE_URL"],
  MIGRATIONS = join(import.meta.dirname, "../migrations"),
  DATABASE = "vayada_channex_tombstone_upgrade_test";

describe.skipIf(!URL)("Channex tombstone 0099 to 0100 upgrade", () => {
  it("preserves populated connections, backfills generations, and stays writable", async () => {
    assertSafeTestDatabase(URL!);
    const admin = new pg.Client({ connectionString: URL }),
      targetUrl = new globalThis.URL(URL!),
      before = await mkdtemp(join(tmpdir(), "vayada-845-"));
    targetUrl.pathname = `/${DATABASE}`;
    let target: pg.Client | undefined;
    await admin.connect();
    try {
      await admin.query(`DROP DATABASE IF EXISTS ${DATABASE} WITH (FORCE)`);
      await admin.query(`CREATE DATABASE ${DATABASE}`);
      for (const file of await readdir(MIGRATIONS))
        if (/^00(?:0[1-9]|[1-9][0-9])_/.test(file))
          await cp(join(MIGRATIONS, file), join(before, file));
      expect(
        (
          await runMigrations({
            connectionString: targetUrl.href,
            migrationsDir: before,
            environment: "local",
          })
        ).failed,
      ).toBeNull();
      target = new pg.Client({ connectionString: targetUrl.href });
      await target.connect();
      await target.query(`
        INSERT INTO hotel_catalog.properties(id,public_id,display_name) VALUES
          ('84500000-0000-4000-8000-000000000011','upgrade-a','Upgrade A'),
          ('84500000-0000-4000-8000-000000000012','upgrade-b','Upgrade B');
        INSERT INTO pms.channel_connections(id,property_id,provider,external_property_id,connection_metadata) VALUES
          ('84500000-0000-4000-8000-000000000021','84500000-0000-4000-8000-000000000011','channex','external-a','{"before":"a"}'),
          ('84500000-0000-4000-8000-000000000022','84500000-0000-4000-8000-000000000012','channex','external-b','{"before":"b"}')`);
      await cp(
        join(MIGRATIONS, "0100_channex_booking_revision_tombstones.sql"),
        join(before, "0100_channex_booking_revision_tombstones.sql"),
      );
      expect(
        (
          await runMigrations({
            connectionString: targetUrl.href,
            migrationsDir: before,
            environment: "local",
          })
        ).applied,
      ).toEqual(["0100"]);
      const rows = (
        await target.query<{ external_property_id: string; generation: string; metadata: object }>(
          `SELECT external_property_id,binding_generation::text generation,connection_metadata metadata
           FROM pms.channel_connections WHERE provider='channex' ORDER BY external_property_id`,
        )
      ).rows;
      expect(
        rows.map(({ external_property_id, metadata }) => ({ external_property_id, metadata })),
      ).toEqual([
        { external_property_id: "external-a", metadata: { before: "a" } },
        { external_property_id: "external-b", metadata: { before: "b" } },
      ]);
      expect(new Set(rows.map(({ generation }) => generation)).size).toBe(2);
      await target.query(
        `WITH updated AS (
          UPDATE pms.channel_connections SET connection_metadata=connection_metadata||'{"after":true}'
            WHERE id='84500000-0000-4000-8000-000000000021' RETURNING id
        ), tombstone AS (
          INSERT INTO pms.channel_booking_revision_tombstones(connection_id,property_id,binding_generation,external_booking_id,authoritative_revision_id,inserted_at)
            SELECT id,'84500000-0000-4000-8000-000000000011',$1,'booking-upgrade','revision-upgrade',now() FROM updated RETURNING connection_id
        )
        INSERT INTO pms.channel_connections(property_id,provider,external_property_id)
          SELECT '84500000-0000-4000-8000-000000000011','custom','new-after-upgrade' FROM tombstone`,
        [rows[0]!.generation],
      );
      expect(
        (
          await target.query(
            `SELECT connection_metadata->>'after' after,
              (SELECT count(*)::int FROM pms.channel_booking_revision_tombstones) tombstones,
              (SELECT count(*)::int FROM pms.channel_connections WHERE binding_generation IS NOT NULL) generated
             FROM pms.channel_connections WHERE id='84500000-0000-4000-8000-000000000021'`,
          )
        ).rows[0],
      ).toEqual({ after: "true", tombstones: 1, generated: 3 });
    } finally {
      if (target) await target.end();
      await admin.query(`DROP DATABASE IF EXISTS ${DATABASE} WITH (FORCE)`);
      await admin.end();
      await rm(before, { recursive: true, force: true });
    }
  }, 20_000);
});
