import crypto from "node:crypto";

import type { FinanceGeneratedExpenseAudit } from "@vayada/domain-finance";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { projectFinanceProviderFeeExpense } from "./financeProviderFeeExpenseProjection.js";

const URL = process.env["TEST_DATABASE_URL"];
const id = (n: number) => `12350000-0000-4000-8000-${String(n).padStart(12, "0")}`;
// prettier-ignore
const I={property:id(1),otherProperty:id(2),category:id(3),otherCategory:id(4),account:id(5),otherAccount:id(6),payment:id(7),missingPayment:id(8),zeroPayment:id(9),racePayment:id(10),rollbackPayment:id(11),currencyPayment:id(12),otherPayment:id(13),applied:id(14),correction:id(15),reversal:id(16),missing:id(17),late:id(18),zero:id(19),race:id(20),rollback:id(21),currency:id(22),restart:id(23),skipPayment:id(24),skipRoot:id(25),skipZero:id(26),skipRestart:id(27)} as const;
const NOW = "2026-08-12T12:00:00.000Z";

if (URL && !/(^|[_-])(test|verify)([_-]|$)/i.test(new globalThis.URL(URL).pathname))
  throw new Error("Refusing non-test database");

describe.skipIf(!URL)("PostgreSQL provider-fee expense projection", () => {
  const admin = new pg.Client({ connectionString: URL ?? "postgresql://disabled" });

  beforeAll(async () => {
    await admin.connect();
    await cleanup();
    await admin.query(`
      INSERT INTO hotel_catalog.properties(id,public_id,display_name) VALUES
        ('${I.property}','fee-projection','Fee projection'),('${I.otherProperty}','fee-projection-other','Other');
      INSERT INTO pms.property_pricing_settings(property_id,currency) VALUES
        ('${I.property}','EUR'),('${I.otherProperty}','USD');
      INSERT INTO finance.expense_categories(id,property_id,system_key,name,color) VALUES
        ('${I.category}','${I.property}','platform_fees','Platform fees','#123456'),
        ('${I.otherCategory}','${I.otherProperty}','platform_fees','Platform fees','#654321');
      INSERT INTO finance.payment_provider_accounts(id,property_id,account_scope,provider,provider_account_id,status) VALUES
        ('${I.account}','${I.property}','property','stripe','acct_projection','active'),
        ('${I.otherAccount}','${I.otherProperty}','property','stripe','acct_projection_other','active');
      INSERT INTO finance.payments(id,property_id,provider_account_id,payment_kind,status,amount,fee_amount,net_amount,currency) VALUES
        ('${I.payment}','${I.property}','${I.account}','full','paid',100,3,97,'EUR'),
        ('${I.missingPayment}','${I.property}','${I.account}','full','paid',100,0,100,'EUR'),
        ('${I.zeroPayment}','${I.property}','${I.account}','full','paid',100,0,100,'EUR'),
        ('${I.racePayment}','${I.property}','${I.account}','full','paid',100,1,99,'EUR'),
        ('${I.rollbackPayment}','${I.property}','${I.account}','full','paid',100,1,99,'EUR'),
        ('${I.currencyPayment}','${I.property}','${I.account}','full','paid',100,1,99,'EUR'),
        ('${I.skipPayment}','${I.property}','${I.account}','full','paid',100,3,97,'EUR'),
        ('${I.otherPayment}','${I.otherProperty}','${I.otherAccount}','full','paid',100,1,99,'USD');
      INSERT INTO finance.provider_fee_evidence(id,property_id,payment_id,provider_account_id,provider,settlement_revision,evidence_state,evidence_on,evidence_at,fee_amount,currency,source_revision,source_fingerprint_hash,property_timezone,property_timezone_revision,corrects_provider_fee_evidence_id) VALUES
        ('${I.applied}','${I.property}','${I.payment}','${I.account}','stripe',1,'applied','2026-08-10',now(),3,'EUR','fee:1',repeat('a',64),'Europe/Berlin','profile:1',NULL),
        ('${I.correction}','${I.property}','${I.payment}','${I.account}','stripe',2,'correction','2026-08-11',now(),2.5,'EUR','fee:2',repeat('b',64),'Europe/Berlin','profile:1','${I.applied}'),
        ('${I.reversal}','${I.property}','${I.payment}','${I.account}','stripe',3,'reversal','2026-08-12',now(),0,'EUR','fee:3',repeat('c',64),'Europe/Berlin','profile:1','${I.correction}'),
        ('${I.restart}','${I.property}','${I.payment}','${I.account}','stripe',4,'correction','2026-08-13',now(),1.5,'EUR','fee:4',repeat('4',64),'Europe/Berlin','profile:1','${I.reversal}'),
        ('${I.missing}','${I.property}','${I.missingPayment}','${I.account}','stripe',1,'missing','2026-08-10',now(),NULL,'EUR','fee:missing',repeat('d',64),'Europe/Berlin','profile:1',NULL),
        ('${I.late}','${I.property}','${I.missingPayment}','${I.account}','stripe',2,'correction','2026-08-11',now(),2,'EUR','fee:late',repeat('e',64),'Europe/Berlin','profile:1','${I.missing}'),
        ('${I.zero}','${I.property}','${I.zeroPayment}','${I.account}','stripe',1,'proven_zero','2026-08-10',now(),0,'EUR','fee:zero',repeat('f',64),'Europe/Berlin','profile:1',NULL),
        ('${I.race}','${I.property}','${I.racePayment}','${I.account}','stripe',1,'applied','2026-08-10',now(),1,'EUR','fee:race',repeat('1',64),'Europe/Berlin','profile:1',NULL),
        ('${I.rollback}','${I.property}','${I.rollbackPayment}','${I.account}','stripe',1,'applied','2026-08-10',now(),1,'EUR','fee:rollback',repeat('2',64),'Europe/Berlin','profile:1',NULL),
        ('${I.currency}','${I.property}','${I.currencyPayment}','${I.account}','stripe',1,'applied','2026-08-10',now(),1,'EUR','fee:currency',repeat('3',64),'Europe/Berlin','profile:1',NULL),
        ('${I.skipRoot}','${I.property}','${I.skipPayment}','${I.account}','stripe',1,'applied','2026-08-10',now(),3,'EUR','skip:1',repeat('5',64),'Europe/Berlin','profile:1',NULL),
        ('${I.skipZero}','${I.property}','${I.skipPayment}','${I.account}','stripe',2,'correction','2026-08-11',now(),0,'EUR','skip:2',repeat('6',64),'Europe/Berlin','profile:1','${I.skipRoot}'),
        ('${I.skipRestart}','${I.property}','${I.skipPayment}','${I.account}','stripe',3,'correction','2026-08-12',now(),2,'EUR','skip:3',repeat('7',64),'Europe/Berlin','profile:1','${I.skipZero}')`);
  });

  afterAll(async () => {
    await cleanup();
    await admin.end();
  });

  it("projects positive evidence and preserves correction and reversal history", async () => {
    await expect(
      projectFinanceProviderFeeExpense(
        admin as never,
        { ...input(I.applied, I.payment), extra: "private" } as never,
      ),
    ).resolves.toMatchObject({ ok: false, code: "invalid_command" });
    await admin.query("BEGIN");
    try {
      await admin.query(
        "UPDATE pms.property_pricing_settings SET currency='USD' WHERE property_id=$1",
        [I.property],
      );
      await expect(
        projectFinanceProviderFeeExpense(admin as never, input(I.currency, I.currencyPayment)),
      ).resolves.toMatchObject({ ok: false, code: "currency_mismatch" });
    } finally {
      await admin.query("ROLLBACK");
    }
    await admin.query("UPDATE finance.expense_categories SET archived_at=now() WHERE id=$1", [
      I.category,
    ]);
    await expect(run(input(I.missing, I.missingPayment))).resolves.toMatchObject({
      ok: true,
      outcome: "missing_evidence",
      code: "provider_fee_missing",
    });
    await expect(run(input(I.zero, I.zeroPayment))).resolves.toMatchObject({
      ok: true,
      outcome: "ineligible",
      reason: "known_zero",
    });
    await admin.query("UPDATE finance.expense_categories SET archived_at=NULL WHERE id=$1", [
      I.category,
    ]);
    const applied = input(I.applied, I.payment),
      correction = input(I.correction, I.payment),
      reversal = input(I.reversal, I.payment),
      restart = input(I.restart, I.payment);
    await expect(run(correction)).resolves.toMatchObject({
      ok: false,
      code: "predecessor_not_projected",
    });
    await expect(run(reversal)).resolves.toMatchObject({
      ok: false,
      code: "predecessor_not_projected",
    });
    await expect(run(applied)).resolves.toMatchObject({ ok: true, outcome: "created" });
    await expect(run(applied)).resolves.toMatchObject({ ok: true, outcome: "replayed" });
    await admin.query("UPDATE finance.expense_categories SET archived_at=now() WHERE id=$1", [
      I.category,
    ]);
    await expect(run(correction)).resolves.toMatchObject({ ok: true, outcome: "corrected" });
    await expect(run(correction)).resolves.toMatchObject({ ok: true, outcome: "replayed" });
    await expect(run(reversal)).resolves.toMatchObject({ ok: true, outcome: "reversed" });
    await expect(run(reversal)).resolves.toMatchObject({ ok: true, outcome: "replayed" });
    await admin.query("UPDATE finance.expense_categories SET archived_at=NULL WHERE id=$1", [
      I.category,
    ]);
    await expect(run(restart)).resolves.toMatchObject({ ok: true, outcome: "created" });
    await expect(run(input(I.late, I.missingPayment))).resolves.toMatchObject({
      ok: true,
      outcome: "created",
    });
    await expect(run(input(I.applied, I.otherPayment, I.otherProperty))).resolves.toMatchObject({
      ok: false,
      code: "evidence_mismatch",
    });
    await expect(run(input(I.applied, I.otherPayment))).resolves.toMatchObject({
      ok: false,
      code: "evidence_mismatch",
    });
    const rows = await admin.query(
      `SELECT id::text,entry_kind AS kind,amount::text,category_id::text AS category,reverses_expense_id::text AS reverses FROM finance.expenses WHERE id=ANY($1::uuid[]) ORDER BY created_at,id`,
      [[applied.commandId, correction.commandId, reversal.commandId, restart.commandId]],
    );
    // prettier-ignore
    expect(rows.rows).toEqual([{id:applied.commandId,kind:"expense",amount:"3.0000",category:I.category,reverses:null},{id:correction.commandId,kind:"correction",amount:"2.5000",category:I.category,reverses:applied.commandId},{id:reversal.commandId,kind:"reversal",amount:"2.5000",category:I.category,reverses:correction.commandId},{id:restart.commandId,kind:"expense",amount:"1.5000",category:I.category,reverses:null}]);
  });

  it("serializes concurrent replay", async () => {
    const shared = input(I.race, I.racePayment);
    const results = await Promise.all([run(shared), run(shared)]);
    expect(results.map((result) => result.ok && result.outcome).sort()).toEqual([
      "created",
      "replayed",
    ]);
    const root = input(I.skipRoot, I.skipPayment),
      zero = input(I.skipZero, I.skipPayment),
      restart = input(I.skipRestart, I.skipPayment);
    await expect(run(root)).resolves.toMatchObject({ ok: true, outcome: "created" });
    await expect(run(restart)).resolves.toMatchObject({
      ok: false,
      code: "predecessor_not_projected",
    });
    await expect(run(zero)).resolves.toMatchObject({ ok: true, outcome: "reversed" });
    await expect(run(restart)).resolves.toMatchObject({ ok: true, outcome: "created" });
  });

  it("rolls the ledger, idempotency, and audit back with its caller transaction", async () => {
    const client = new pg.Client({ connectionString: URL });
    await client.connect();
    const command = input(I.rollback, I.rollbackPayment);
    await client.query("BEGIN");
    await expect(projectFinanceProviderFeeExpense(client as never, command)).resolves.toMatchObject(
      { ok: true, outcome: "created" },
    );
    await client.query("ROLLBACK");
    await client.end();
    const residue = await admin.query(
      `SELECT (SELECT count(*)::int FROM finance.expenses WHERE id=$1::uuid) expenses,(SELECT count(*)::int FROM platform.idempotency_keys WHERE response_resource_id=$1::text) keys,(SELECT count(*)::int FROM platform.product_audit_events WHERE target_resource_id=$1::text) audits`,
      [command.commandId],
    );
    expect(residue.rows[0]).toEqual({ expenses: 0, keys: 0, audits: 0 });
  });

  async function run(value: ReturnType<typeof input>) {
    const client = new pg.Pool({ connectionString: URL });
    const connection = await client.connect();
    try {
      await connection.query("BEGIN");
      const result = await projectFinanceProviderFeeExpense(connection, value);
      await connection.query(result.ok ? "COMMIT" : "ROLLBACK");
      return result;
    } finally {
      connection.release();
      await client.end();
    }
  }

  async function cleanup() {
    await admin.query(`BEGIN;SET LOCAL session_replication_role=replica;
      DELETE FROM platform.product_audit_events WHERE property_id IN ('${I.property}','${I.otherProperty}');
      DELETE FROM platform.idempotency_keys WHERE property_id IN ('${I.property}','${I.otherProperty}');
      DELETE FROM finance.expenses WHERE property_id IN ('${I.property}','${I.otherProperty}');
      DELETE FROM finance.provider_fee_evidence WHERE property_id IN ('${I.property}','${I.otherProperty}');
      DELETE FROM finance.payments WHERE property_id IN ('${I.property}','${I.otherProperty}');
      DELETE FROM finance.payment_provider_accounts WHERE property_id IN ('${I.property}','${I.otherProperty}');
      DELETE FROM finance.expense_categories WHERE property_id IN ('${I.property}','${I.otherProperty}');
      DELETE FROM pms.property_pricing_settings WHERE property_id IN ('${I.property}','${I.otherProperty}');
      DELETE FROM hotel_catalog.properties WHERE id IN ('${I.property}','${I.otherProperty}');COMMIT`);
  }
});

function input(evidenceId: string, paymentId: string, propertyId = I.property) {
  return {
    commandId: crypto.randomUUID(),
    propertyId,
    paymentId,
    providerFeeEvidenceId: evidenceId,
    audit: {
      actor: { kind: "system", service: "finance-expense-automation" },
      requestId: `request-${crypto.randomUUID()}`,
      correlationId: `correlation-${crypto.randomUUID()}`,
      causationId: crypto.randomUUID(),
      jobId: crypto.randomUUID(),
      jobAttemptId: crypto.randomUUID(),
      requestedAt: NOW,
    } satisfies Omit<FinanceGeneratedExpenseAudit, "reasonCode">,
  };
}
