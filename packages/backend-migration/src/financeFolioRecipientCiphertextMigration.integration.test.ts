import { cp, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pg from "pg";
import { describe, expect, it } from "vitest";

import { runMigrations } from "./runner.js";
import { assertSafeTestDatabase } from "./testUtils.js";

const URL = process.env["TEST_DATABASE_URL"],
  MIGRATIONS = join(import.meta.dirname, "../migrations"),
  DATABASE = "vayada_folio_kms_upgrade_test",
  PROPERTY = "11321010-0000-4000-8000-000000000001",
  FOLIOS = [
    "11321010-0000-4000-8000-000000000002",
    "11321010-0000-4000-8000-000000000003",
    "11321010-0000-4000-8000-000000000004",
    "11321010-0000-4000-8000-000000000005",
  ];
const HASH = "a".repeat(64);

describe.skipIf(!URL)("Finance folio KMS ciphertext 0100 to 0102 upgrade", () => {
  it("rolls back incompatible evidence, preserves valid rows, and enforces the KMS limit", async () => {
    assertSafeTestDatabase(URL!);
    const admin = new pg.Client({ connectionString: URL });
    const targetUrl = new globalThis.URL(URL!);
    const before = await mkdtemp(join(tmpdir(), "vayada-1132-kms-"));
    targetUrl.pathname = `/${DATABASE}`;
    const run = () =>
      runMigrations({
        connectionString: targetUrl.href,
        migrationsDir: before,
        environment: "local",
      });
    let target: pg.Client | undefined;
    await admin.connect();
    try {
      await admin.query(`DROP DATABASE IF EXISTS ${DATABASE} WITH (FORCE)`);
      await admin.query(`CREATE DATABASE ${DATABASE}`);
      for (const file of await readdir(MIGRATIONS))
        if (/^(?:00\d{2}|0100)_/.test(file)) await cp(join(MIGRATIONS, file), join(before, file));
      expect((await run()).failed).toBeNull();
      target = new pg.Client({ connectionString: targetUrl.href });
      await target.connect();
      await target.query(`
        INSERT INTO hotel_catalog.properties(id,public_id,display_name)
          VALUES ('${PROPERTY}','folio-kms-upgrade','Folio KMS upgrade');
        INSERT INTO pms.property_pricing_settings(property_id,currency) VALUES ('${PROPERTY}','EUR');
        INSERT INTO finance.folios(id,property_id) VALUES
          ('${FOLIOS[0]}','${PROPERTY}'),('${FOLIOS[1]}','${PROPERTY}'),('${FOLIOS[2]}','${PROPERTY}'),('${FOLIOS[3]}','${PROPERTY}')`);
      const addRevision = (folioId: string, bytes: number) =>
        target!.query(
          `INSERT INTO finance.folio_revisions
            (folio_id,property_id,revision,state,recipient_snapshot_ciphertext,
             recipient_encryption_scheme,recipient_key_version,recipient_fingerprint,
             recipient_fingerprint_key_version,service_from,service_to,currency,total_amount,
             source_digest,source_freshness)
           VALUES ($1,$2,1,'draft',$3,'envelope_aead_v1','kms-v1',$4,'hmac-v1',
             '2026-08-01','2026-08-01','EUR',0,$4,'{}')`,
          [folioId, PROPERTY, Buffer.alloc(bytes, 1), HASH],
        );
      await addRevision(FOLIOS[0]!, 32);
      await addRevision(FOLIOS[1]!, 7_000);
      await cp(
        join(MIGRATIONS, "0101_finance_folio_recipient_kms_ciphertext.sql"),
        join(before, "0101_finance_folio_recipient_kms_ciphertext.sql"),
      );
      expect((await run()).applied).toEqual(["0101"]);
      await expect(addRevision(FOLIOS[2]!, 6_145)).rejects.toMatchObject({
        constraint: "chk_finance_folio_revisions_recipient_kms_ciphertext",
      });
      await expect(addRevision(FOLIOS[2]!, 28)).rejects.toMatchObject({
        constraint: "chk_finance_folio_revisions_recipient_ciphertext",
      });
      await expect(addRevision(FOLIOS[2]!, 6_144)).resolves.toBeDefined();
      await expect(addRevision(FOLIOS[3]!, 29)).resolves.toBeDefined();
      await cp(
        join(MIGRATIONS, "0102_validate_finance_folio_recipient_kms_ciphertext.sql"),
        join(before, "0102_validate_finance_folio_recipient_kms_ciphertext.sql"),
      );
      expect((await run()).failed).toBe("0102");
      expect(
        (
          await target.query(`SELECT array_agg(octet_length(recipient_snapshot_ciphertext) ORDER BY octet_length(recipient_snapshot_ciphertext)) sizes,
            (SELECT convalidated FROM pg_constraint WHERE conname='chk_finance_folio_revisions_recipient_kms_ciphertext') validated
            FROM finance.folio_revisions`)
        ).rows[0],
      ).toEqual({ sizes: [29, 32, 6144, 7000], validated: false });
      await target.query(
        `BEGIN; SET LOCAL session_replication_role=replica; DELETE FROM finance.folio_revisions WHERE folio_id='${FOLIOS[1]}'; COMMIT`,
      );
      expect((await run()).applied).toEqual(["0102"]);
      expect(
        (
          await target.query(
            "SELECT convalidated FROM pg_constraint WHERE conname='chk_finance_folio_revisions_recipient_kms_ciphertext'",
          )
        ).rows,
      ).toEqual([{ convalidated: true }]);
    } finally {
      if (target) await target.end();
      await admin.query(`DROP DATABASE IF EXISTS ${DATABASE} WITH (FORCE)`);
      await admin.end();
      await rm(before, { recursive: true, force: true });
    }
  }, 20_000);
});
