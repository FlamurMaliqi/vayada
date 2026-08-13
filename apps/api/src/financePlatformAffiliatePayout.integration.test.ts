import type { FinanceAffiliatePayoutMarkPaidCommand } from "@vayada/domain-finance";
import pg from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { createFinancePlatformAffiliatePayoutMarkPaidRepository } from "./routes/financePlatformAffiliatePayoutMarkPaid.js";
import { createFinancePlatformAffiliatePayoutReadRepository } from "./routes/financePlatformAffiliatePayoutRepository.js";

const TEST_DATABASE_URL = process.env["TEST_DATABASE_URL"];
const PLATFORM_ORG = "12810000-0000-4000-8000-000000000001";
const AFFILIATE_ORG = "12810000-0000-4000-8000-000000000002";
const USER_ID = "12810000-0000-4000-8000-000000000003";
const SETTING_ID = "12810000-0000-4000-8000-000000000004";
const PAYOUT_IDS = ["12810000-0000-4000-8000-000000000005", "12810000-0000-4000-8000-000000000006"];
const AFFILIATE_ID = "affiliate-pg-1281";

describe.skipIf(!TEST_DATABASE_URL)("Platform Finance affiliate payout PostgreSQL boundary", () => {
  const client = new pg.Client({
    connectionString: TEST_DATABASE_URL ?? "postgresql://integration-test-disabled",
  });

  beforeAll(async () => {
    assertSafeTestDatabase(TEST_DATABASE_URL!);
    await client.connect();
  });

  beforeEach(async () => {
    await client.query("BEGIN");
    await seedFinancePayouts(client);
  });

  afterEach(async () => {
    await client.query("ROLLBACK");
  });

  afterAll(async () => {
    await client.end();
  });

  it("reads migrated affiliation and commits evidence, audit, ledger, and replay atomically", async () => {
    const reads = createFinancePlatformAffiliatePayoutReadRepository(transactionPool(client));
    const writes = createFinancePlatformAffiliatePayoutMarkPaidRepository({
      connect: async () => transactionClient(client, "affiliate_write"),
    });

    const list = await reads.listPlatformAffiliatePayoutSummaries({ limit: 50, offset: 0 });
    expect(list.summaries).toEqual([
      expect.objectContaining({
        affiliateId: AFFILIATE_ID,
        affiliateLifecycleStatus: "inactive",
        payableAmount: "75.00",
        payableCount: 2,
      }),
    ]);
    const before = await reads.getPlatformAffiliatePayoutDetail(AFFILIATE_ID, "EUR");
    expect(before).toMatchObject({ summary: { payableAmount: "75.00" } });

    const command = markPaidCommand();
    const result = await writes.markAffiliatePayoutPaid(command);
    expect(result).toMatchObject({ ok: true, status: "updated", evidence: { amount: "75.00" } });
    await client.query("SET CONSTRAINTS ALL IMMEDIATE");
    await client.query("SET CONSTRAINTS ALL DEFERRED");

    const persisted = await client.query<{
      payoutStatus: string;
      evidenceCount: string;
      auditScope: string;
    }>(
      `SELECT MIN(payout.payout_status) AS "payoutStatus",
              COUNT(DISTINCT evidence.id)::text AS "evidenceCount",
              MIN(audit.tenant_scope) AS "auditScope"
       FROM finance.payouts payout
       JOIN finance.affiliate_payout_payment_evidence_items item ON item.payout_id = payout.id
       JOIN finance.affiliate_payout_payment_evidence evidence ON evidence.id = item.evidence_id
       JOIN platform.product_audit_events audit
         ON audit.secondary_resource_id = evidence.id::text
       WHERE payout.id = ANY($1::uuid[])`,
      [PAYOUT_IDS],
    );
    expect(persisted.rows[0]).toEqual({
      payoutStatus: "paid",
      evidenceCount: "1",
      auditScope: "platform",
    });

    const after = await reads.getPlatformAffiliatePayoutDetail(AFFILIATE_ID, "EUR");
    expect(after).toMatchObject({
      summary: { payableAmount: "0", paidAmount: "75.00" },
      history: [expect.objectContaining({ amount: "75.00", payoutIds: [...PAYOUT_IDS].sort() })],
    });
    await client.query(
      `UPDATE identity.organizations SET status = 'archived' WHERE id = $1::uuid`,
      [AFFILIATE_ORG],
    );
    expect(await writes.markAffiliatePayoutPaid(command)).toMatchObject({
      ok: true,
      status: "idempotent_replay",
      evidence: { amount: "75.00" },
    });
  });

  it("rejects contradictory immutable evidence aggregates at the transaction boundary", async () => {
    await client.query(
      `INSERT INTO platform.idempotency_keys (
         operation_scope, operation, key_hash, request_fingerprint_hash, status,
         tenant_scope, first_seen_at, last_seen_at, expires_at
       ) VALUES ('finance', 'aggregate-test', 'key', 'fingerprint', 'in_progress',
         'platform', now(), now(), now() + interval '1 day')`,
    );
    const idempotency = await client.query<{ id: string }>(
      `SELECT id::text FROM platform.idempotency_keys WHERE operation = 'aggregate-test'`,
    );
    const evidence = await client.query<{ id: string }>(
      `INSERT INTO finance.affiliate_payout_payment_evidence (
         organization_id, affiliate_id, recorded_by_organization_id, recorded_by_user_id,
         idempotency_key_id, command_id, request_fingerprint_hash, payment_method,
         external_reference, evidence_reference, amount, currency, payout_count, paid_at
       ) VALUES ($1::uuid, $2, $3::uuid, $4::uuid, $5::uuid, 'aggregate-test',
         'fingerprint', 'manual', 'aggregate-ref', 'vault://aggregate', 55, 'EUR', 1, now())
       RETURNING id::text`,
      [AFFILIATE_ORG, AFFILIATE_ID, PLATFORM_ORG, USER_ID, idempotency.rows[0]!.id],
    );
    await client.query(
      `INSERT INTO finance.affiliate_payout_payment_evidence_items (
         evidence_id, organization_id, payout_id, amount, currency
       ) VALUES ($1::uuid, $2::uuid, $3::uuid, 50, 'EUR')`,
      [evidence.rows[0]!.id, AFFILIATE_ORG, PAYOUT_IDS[0]],
    );

    await expect(client.query("SET CONSTRAINTS ALL IMMEDIATE")).rejects.toMatchObject({
      code: "23514",
    });
  });

  it("rejects immutable evidence without payout item snapshots", async () => {
    await client.query(
      `INSERT INTO platform.idempotency_keys (
         operation_scope, operation, key_hash, request_fingerprint_hash, status,
         tenant_scope, first_seen_at, last_seen_at, expires_at
       ) VALUES ('finance', 'empty-aggregate-test', 'key', 'fingerprint', 'in_progress',
         'platform', now(), now(), now() + interval '1 day')`,
    );
    await client.query(
      `INSERT INTO finance.affiliate_payout_payment_evidence (
         organization_id, affiliate_id, recorded_by_organization_id, recorded_by_user_id,
         idempotency_key_id, command_id, request_fingerprint_hash, payment_method,
         external_reference, evidence_reference, amount, currency, payout_count, paid_at
       ) SELECT $1::uuid, $2, $3::uuid, $4::uuid, id, 'empty-aggregate-test',
         'fingerprint', 'manual', 'empty-aggregate-ref', 'vault://empty-aggregate',
         50, 'EUR', 1, now()
       FROM platform.idempotency_keys WHERE operation = 'empty-aggregate-test'`,
      [AFFILIATE_ORG, AFFILIATE_ID, PLATFORM_ORG, USER_ID],
    );

    await expect(client.query("SET CONSTRAINTS ALL IMMEDIATE")).rejects.toMatchObject({
      code: "23514",
    });
  });
});

function markPaidCommand(): FinanceAffiliatePayoutMarkPaidCommand {
  return {
    commandType: "finance.affiliate_payout.mark_paid",
    commandId: "pg-command-1281",
    idempotencyKey: "pg-idempotency-1281",
    affiliateId: AFFILIATE_ID,
    currency: "EUR",
    audit: {
      actor: { kind: "user", userId: USER_ID, organizationId: PLATFORM_ORG },
      requestId: "pg-request-1281",
      reason: "PostgreSQL affiliate payout integration test",
      requestedAt: "2026-08-13T09:00:00.000Z",
    },
    payload: {
      payoutIds: PAYOUT_IDS,
      expectedAmount: "75.00",
      paymentMethod: "manual",
      externalReference: "pg-transfer-1281",
      evidenceReference: "vault://pg-transfer-1281",
      paidAt: "2026-08-13T08:55:00.000Z",
      note: null,
    },
  };
}

function transactionPool(client: pg.Client) {
  return {
    query: client.query.bind(client),
    connect: async () => transactionClient(client, "affiliate_read"),
  };
}

function transactionClient(client: pg.Client, savepoint: string) {
  return {
    async query(text: string, values?: readonly unknown[]) {
      if (text === "BEGIN" || text.startsWith("BEGIN TRANSACTION")) {
        return client.query(`SAVEPOINT ${savepoint}`);
      }
      if (text === "COMMIT") return client.query(`RELEASE SAVEPOINT ${savepoint}`);
      if (text === "ROLLBACK") return client.query(`ROLLBACK TO SAVEPOINT ${savepoint}`);
      return client.query(text, values as unknown[]);
    },
    release() {},
  };
}

async function seedFinancePayouts(client: pg.Client) {
  await client.query(
    `INSERT INTO identity.organizations (id, kind, name, slug, status) VALUES
       ($1::uuid, 'platform', 'Vayada Test Platform', 'vayada-test-platform-1281', 'active'),
       ($2::uuid, 'affiliate_partner', 'Affiliate Test', 'affiliate-test-1281', 'suspended')`,
    [PLATFORM_ORG, AFFILIATE_ORG],
  );
  await client.query(
    `INSERT INTO identity.users (id, email, name, status)
       VALUES ($1::uuid, 'affiliate-payout-1281@example.test', 'Affiliate Payout Tester', 'active')`,
    [USER_ID],
  );
  await client.query(
    `INSERT INTO identity.organization_resource_links (
       organization_id, product, resource_type, resource_id, relationship, status
     ) VALUES ($1::uuid, 'affiliate', 'affiliate', $2, 'owner', 'suspended')`,
    [AFFILIATE_ORG, AFFILIATE_ID],
  );
  await client.query(
    `INSERT INTO finance.payout_settings (
       id, organization_id, owner_scope, payout_method, default_currency, status,
       payout_preferences
     ) VALUES ($1::uuid, $2::uuid, 'organization', 'manual', 'EUR', 'active', '{}'::jsonb)`,
    [SETTING_ID, AFFILIATE_ORG],
  );
  await client.query(
    `INSERT INTO finance.payouts (
       id, payout_setting_id, owner_scope, organization_id, payout_status, amount,
       fee_amount, net_amount, currency, payout_metadata
     ) VALUES
       ($1::uuid, $3::uuid, 'organization', $4::uuid, 'pending', 50, 0, 50, 'EUR',
        jsonb_build_object('resourceId', $5::text)),
       ($2::uuid, $3::uuid, 'organization', $4::uuid, 'scheduled', 25, 0, 25, 'EUR',
        jsonb_build_object('resourceId', $5::text))`,
    [PAYOUT_IDS[0], PAYOUT_IDS[1], SETTING_ID, AFFILIATE_ORG, AFFILIATE_ID],
  );
}

function assertSafeTestDatabase(url: string) {
  if (!/(^|[_-])test([_-]|$)/i.test(new URL(url).pathname)) {
    throw new Error("TEST_DATABASE_URL must name a test database.");
  }
}
