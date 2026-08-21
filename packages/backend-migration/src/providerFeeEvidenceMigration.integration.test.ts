import { cp, mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pg from "pg";
import { describe, expect, it } from "vitest";

import { runMigrations } from "./runner.js";
import { assertSafeTestDatabase } from "./testUtils.js";

const URL = process.env["TEST_DATABASE_URL"];
const MIGRATIONS = join(import.meta.dirname, "../migrations");
const DATABASE = "vayada_provider_fee_upgrade_test";

describe.skipIf(!URL)("provider fee evidence upgrade", () => {
  it("rolls back 0098 and never treats legacy fee defaults as evidence", async () => {
    assertSafeTestDatabase(URL!);
    const admin = new pg.Client({ connectionString: URL });
    const targetUrl = new globalThis.URL(URL!);
    targetUrl.pathname = `/${DATABASE}`;
    const before = await mkdtemp(join(tmpdir(), "vayada-1234-"));
    let target: pg.Client | undefined;
    await admin.connect();
    try {
      await admin.query(`DROP DATABASE IF EXISTS ${DATABASE} WITH (FORCE)`);
      await admin.query(`CREATE DATABASE ${DATABASE}`);
      for (const file of await readdir(MIGRATIONS))
        if (/^00(?:0[1-9]|[1-8][0-9]|9[0-7])_/.test(file))
          await cp(join(MIGRATIONS, file), join(before, file));
      await runMigrations({
        connectionString: targetUrl.href,
        migrationsDir: before,
        environment: "local",
      });
      target = new pg.Client({ connectionString: targetUrl.href });
      await target.connect();
      await target.query(`INSERT INTO hotel_catalog.properties(id,public_id,display_name) VALUES('12340000-0000-4000-8000-000000000001','legacy-fee','Legacy fee');
        INSERT INTO finance.payment_provider_accounts(id,property_id,account_scope,provider,provider_account_id,status) VALUES('12340000-0000-4000-8000-000000000002','12340000-0000-4000-8000-000000000001','property','stripe','acct_legacy','active');
        INSERT INTO finance.payments(id,property_id,provider_account_id,payment_kind,status,amount,fee_amount,net_amount,currency) VALUES
          ('12340000-0000-4000-8000-000000000003','12340000-0000-4000-8000-000000000001','12340000-0000-4000-8000-000000000002','full','paid',100,0,100,'EUR'),
          ('12340000-0000-4000-8000-000000000004','12340000-0000-4000-8000-000000000001','12340000-0000-4000-8000-000000000002','full','paid',100,3,97,'EUR')`);
      await target.query("BEGIN");
      await target.query(
        await readFile(join(MIGRATIONS, "0098_finance_provider_fee_evidence.sql"), "utf8"),
      );
      expect(
        (await target.query("SELECT to_regclass('finance.provider_fee_evidence')::text table_name"))
          .rows[0],
      ).toEqual({ table_name: "finance.provider_fee_evidence" });
      await target.query("ROLLBACK");
      expect(
        (await target.query("SELECT to_regclass('finance.provider_fee_evidence')::text table_name"))
          .rows[0],
      ).toEqual({ table_name: null });
      await target.end();
      target = undefined;
      expect(
        (
          await runMigrations({
            connectionString: targetUrl.href,
            migrationsDir: MIGRATIONS,
            environment: "local",
          })
        ).applied,
      ).toEqual(["0098", "0099", "0100"]);
      target = new pg.Client({ connectionString: targetUrl.href });
      await target.connect();
      expect(
        (await target.query("SELECT fee_amount::text FROM finance.payments ORDER BY id")).rows,
      ).toEqual([{ fee_amount: "0.00" }, { fee_amount: "3.00" }]);
      expect(
        (
          await target.query(
            "SELECT count(*)::int count,(SELECT count(*)::int FROM finance.expense_generation_dispatches WHERE family='provider_fee') dispatches FROM finance.provider_fee_evidence",
          )
        ).rows[0],
      ).toEqual({ count: 0, dispatches: 0 });
    } finally {
      if (target) await target.end();
      await admin.query(`DROP DATABASE IF EXISTS ${DATABASE} WITH (FORCE)`);
      await admin.end();
      await rm(before, { recursive: true, force: true });
    }
  }, 15_000);
});
