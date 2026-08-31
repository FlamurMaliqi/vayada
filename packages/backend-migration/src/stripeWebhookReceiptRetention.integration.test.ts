import { copyFile, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pg from "pg";
import { describe, expect, it } from "vitest";

import { runParityChecks } from "./parity.js";
import { rebuild } from "./rebuild.js";
import { runMigrations } from "./runner.js";
import { DEFAULT_REBUILD_SCHEMAS } from "./targetSchemas.js";
import { assertSafeTestDatabase } from "./testUtils.js";

const URL = process.env["TEST_DATABASE_URL"];
const MIGRATIONS = join(import.meta.dirname, "../migrations");
const FIXTURES = join(import.meta.dirname, "../fixtures");

async function withTestDatabase(
  database: string,
  test: (targetUrl: string) => Promise<void>,
): Promise<void> {
  assertSafeTestDatabase(URL!);
  const admin = new pg.Client({ connectionString: URL });
  const targetUrl = new globalThis.URL(URL!);
  targetUrl.pathname = `/${database}`;
  await admin.connect();
  try {
    await admin.query(`DROP DATABASE IF EXISTS ${database} WITH (FORCE)`);
    await admin.query(`CREATE DATABASE ${database}`);
    await test(targetUrl.href);
  } finally {
    await admin.query(`DROP DATABASE IF EXISTS ${database} WITH (FORCE)`);
    await admin.end();
  }
}

describe.skipIf(!URL)("Stripe webhook receipt retention", () => {
  it("scrubs legacy payload copies and bounds new Stripe receipts only", async () => {
    await withTestDatabase("vayada_stripe_receipt_retention_test", async (targetUrl) => {
      const migrationsBeforeRetention = await mkdtemp(join(tmpdir(), "vayada-migrations-"));
      try {
        for (const filename of await readdir(MIGRATIONS)) {
          if (/^\d{4}_.+\.sql$/u.test(filename) && filename < "0130_") {
            await copyFile(join(MIGRATIONS, filename), join(migrationsBeforeRetention, filename));
          }
        }
        expect(
          (
            await runMigrations({
              connectionString: targetUrl,
              migrationsDir: migrationsBeforeRetention,
              environment: "local",
            })
          ).failed,
        ).toBeNull();

        const legacyTarget = new pg.Client({ connectionString: targetUrl });
        await legacyTarget.connect();
        try {
          const legacyId = (
            await legacyTarget.query<{ id: string }>(`INSERT INTO platform.external_webhook_events
              (provider,provider_event_id,event_type,delivery_status,signature_verified,
               payload_hash,raw_headers,raw_payload)
              VALUES ('stripe','evt-legacy','payment_intent.succeeded','observed',TRUE,
               'sha256:legacy','{"stripe-signature":"legacy-secret"}',
               '{"id":"evt-legacy","data":{"object":{"email":"legacy@example.test"}}}')
              RETURNING id`)
          ).rows[0]!.id;
          await legacyTarget.query(
            `INSERT INTO platform.product_audit_events
               (audit_key,product,action,occurred_at,tenant_scope,target_resource_product,
                target_resource_type,target_resource_id,external_webhook_event_id,private_payload)
             VALUES ('legacy-stripe-audit','platform','webhook.received',now(),'external',
              'platform','external_webhook_event',$1::text,$1::uuid,'{"token":"legacy-secret"}')`,
            [legacyId],
          );
        } finally {
          await legacyTarget.end();
        }

        await copyFile(
          join(MIGRATIONS, "0130_stripe_webhook_receipt_retention.sql"),
          join(migrationsBeforeRetention, "0130_stripe_webhook_receipt_retention.sql"),
        );
        expect(
          (
            await runMigrations({
              connectionString: targetUrl,
              migrationsDir: migrationsBeforeRetention,
              environment: "local",
            })
          ).failed,
        ).toBeNull();

        const target = new pg.Client({ connectionString: targetUrl });
        await target.connect();
        try {
          expect(
            (
              await target.query(`SELECT receipt.raw_headers,receipt.raw_payload,
                     receipt.payload_hash,receipt.payload_retention_until,receipt.payload_purged_at,
                     audit.private_payload
                   FROM platform.external_webhook_events receipt
                   JOIN platform.product_audit_events audit
                     ON audit.external_webhook_event_id=receipt.id
                   WHERE receipt.provider_event_id='evt-legacy'`)
            ).rows[0],
          ).toMatchObject({
            raw_headers: {},
            raw_payload: {},
            payload_hash: "sha256:legacy",
            private_payload: {},
            payload_retention_until: expect.any(Date),
            payload_purged_at: expect.any(Date),
          });

          const nonStripe = (
            await target.query<{
              retention: Date | null;
            }>(`INSERT INTO platform.external_webhook_events
              (provider,provider_event_id,event_type,signature_verified,payload_hash,raw_payload)
              VALUES ('workos','evt-workos','user.created',TRUE,'sha256:workos','{"id":"evt-workos"}')
              RETURNING payload_retention_until retention`)
          ).rows[0];
          expect(nonStripe?.retention).toBeNull();
          await expect(
            target.query(`INSERT INTO platform.external_webhook_events
              (provider,provider_event_id,event_type,signature_verified,payload_hash,raw_payload)
              VALUES ('stripe','evt-no-retention','account.updated',TRUE,
               'sha256:no-retention','{"id":"evt-no-retention"}')`),
          ).rejects.toMatchObject({ code: "23514" });

          await target.query(`INSERT INTO platform.external_webhook_events
            (provider,provider_event_id,event_type,delivery_status,signature_verified,
             payload_hash,raw_headers,raw_payload,payload_retention_until)
            VALUES
            ('stripe','evt-future','payment_intent.succeeded','observed',TRUE,
             'sha256:future','{}','{"id":"evt-future"}',now()+INTERVAL '1 day'),
            ('stripe','evt-expired','payment_intent.succeeded','observed',TRUE,
             'sha256:expired','{"authorization":"fixture-header"}',
             '{"email":"fixture@example.test"}',now()-INTERVAL '1 minute')`);
          await expect(
            target.query(`UPDATE platform.external_webhook_events
              SET raw_payload='{}',payload_purged_at=now()
              WHERE provider_event_id='evt-future'`),
          ).rejects.toMatchObject({ code: "55000" });
          expect(
            (
              await target.query<{ count: number }>(
                `SELECT platform.purge_expired_stripe_webhook_receipts() count`,
              )
            ).rows[0]?.count,
          ).toBe(1);
          expect(
            (
              await target.query<{ count: number }>(
                `SELECT platform.purge_expired_stripe_webhook_receipts() count`,
              )
            ).rows[0]?.count,
          ).toBe(0);
          await expect(
            target.query(
              `DELETE FROM platform.external_webhook_events WHERE provider_event_id='evt-expired'`,
            ),
          ).rejects.toMatchObject({ code: "55000" });

          const rows = (
            await target.query<{
              id: string;
              hash: string;
              payload: Record<string, unknown>;
              purged: Date | null;
            }>(`SELECT provider_event_id id,payload_hash hash,raw_payload payload,
                       payload_purged_at purged
                 FROM platform.external_webhook_events
                 WHERE provider_event_id IN ('evt-expired','evt-future') ORDER BY id`)
          ).rows;
          expect(rows).toMatchObject([
            {
              id: "evt-expired",
              hash: "sha256:expired",
              payload: {},
              purged: expect.any(Date),
            },
            {
              id: "evt-future",
              hash: "sha256:future",
              payload: { id: "evt-future" },
              purged: null,
            },
          ]);
          expect(
            (
              await target.query<{ public_can_execute: boolean }>(`SELECT has_function_privilege(
                'public','platform.purge_expired_stripe_webhook_receipts(timestamptz)','EXECUTE'
              ) public_can_execute`)
            ).rows[0]?.public_can_execute,
          ).toBe(false);
        } finally {
          await target.end();
        }
      } finally {
        await rm(migrationsBeforeRetention, { recursive: true, force: true });
      }
    });
  }, 60_000);

  it("scrubs imported pre-v1 Stripe receipt and audit payloads", async () => {
    await withTestDatabase("vayada_stripe_receipt_import_test", async (targetUrl) => {
      expect(
        (
          await rebuild({
            connectionString: targetUrl,
            migrationsDir: MIGRATIONS,
            environment: "local",
            schemas: [...DEFAULT_REBUILD_SCHEMAS],
            confirmedDatabaseName: "vayada_stripe_receipt_import_test",
            fixtureCase: "platform-jobs-events-audit",
            fixturesDir: FIXTURES,
          })
        ).failed,
      ).toBeNull();

      const parity = await runParityChecks({
        connectionString: targetUrl,
        fixtureCase: "platform-jobs-events-audit",
        fixturesDir: FIXTURES,
        environment: "local",
      });
      expect(parity.status, JSON.stringify(parity.findings)).toBe("passed");
    });
  }, 60_000);
});
