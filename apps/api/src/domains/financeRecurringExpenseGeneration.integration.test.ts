import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// prettier-ignore
import { appendFinanceRecurringExpenseGeneration, createPgFinanceRecurringExpenseGenerator } from "./financeRecurringExpenseGeneration.js";

const URL = process.env["TEST_DATABASE_URL"];
const NOW = "2026-08-20T12:00:00.000Z";
// prettier-ignore
const I = { property: "12320000-0000-4000-8000-000000000001", otherProperty: "12320000-0000-4000-8000-000000000002", category: "12320000-0000-4000-8000-000000000003", otherCategory: "12320000-0000-4000-8000-000000000004", weekly: "12320000-0000-4000-8000-000000000010", monthly: "12320000-0000-4000-8000-000000000011", yearly: "12320000-0000-4000-8000-000000000012", ending: "12320000-0000-4000-8000-000000000013", disabled: "12320000-0000-4000-8000-000000000014", otherRule: "12320000-0000-4000-8000-000000000015", concurrent: "12320000-0000-4000-8000-000000000016", rollback: "12320000-0000-4000-8000-000000000017", updateRace: "12320000-0000-4000-8000-000000000018", disableRace: "12320000-0000-4000-8000-000000000019" } as const;
if (URL && !/(^|[_-])(test|verify)([_-]|$)/i.test(new globalThis.URL(URL).pathname))
  throw new Error("Unsafe test database");

describe.skipIf(!URL)("PostgreSQL due recurring expense generation", () => {
  const admin = new pg.Client({ connectionString: URL ?? "postgresql://disabled" });
  const generator = createPgFinanceRecurringExpenseGenerator(
    URL ?? "postgresql://disabled",
    () => new Date(NOW),
  );
  beforeAll(async () => {
    await admin.connect();
    await cleanup();
    await admin.query(`INSERT INTO hotel_catalog.properties(id,public_id,display_name) VALUES
      ('${I.property}','vay-1232','Recurring generation'),('${I.otherProperty}','vay-1232-other','Other');
      INSERT INTO pms.property_pricing_settings(property_id,currency) VALUES ('${I.property}','EUR'),('${I.otherProperty}','USD');
      INSERT INTO finance.expense_categories(id,property_id,name,color) VALUES ('${I.category}','${I.property}','Operations','#123456'),('${I.otherCategory}','${I.otherProperty}','Other','#654321');
      INSERT INTO finance.recurring_expense_rules(id,property_id,category_id,cadence,starts_on,next_due_on,ends_on,vendor,amount,currency,payment_status,active) VALUES
      ('${I.weekly}','${I.property}','${I.category}','weekly','2026-01-01','2026-01-01',NULL,'Weekly',1,'EUR','unpaid',true),
      ('${I.monthly}','${I.property}','${I.category}','monthly','2026-01-31','2026-01-31',NULL,'Monthly',2,'EUR','unpaid',true),
      ('${I.yearly}','${I.property}','${I.category}','yearly','2024-02-29','2024-02-29',NULL,'Yearly',3,'EUR','unpaid',true),
      ('${I.ending}','${I.property}','${I.category}','monthly','2026-03-15','2026-03-15','2026-03-15','Ending',4,'EUR','paid',true),
      ('${I.disabled}','${I.property}','${I.category}','weekly','2026-01-01','2026-01-01',NULL,'Disabled',5,'EUR','unpaid',false),
      ('${I.otherRule}','${I.otherProperty}','${I.otherCategory}','weekly','2026-01-01','2026-01-01',NULL,'Other',6,'USD','unpaid',true)`);
  });
  afterAll(async () => {
    await generator.close();
    await cleanup();
    await admin.end();
  });

  it("anchors calendars, bounds catch-up, preserves edits, and stops disabled or ended rules", async () => {
    const first = await generator.run(command("2026-03-31", 10, 3));
    expect(first).toMatchObject({ ok: true });
    expect(first.ok && first.occurrences).toHaveLength(10);
    expect(await dates(I.weekly)).toEqual(["2026-01-01", "2026-01-08", "2026-01-15"]);
    expect(await dates(I.monthly)).toEqual(["2026-01-31", "2026-02-28", "2026-03-31"]);
    expect(await dates(I.yearly)).toEqual(["2024-02-29", "2025-02-28", "2026-02-28"]);
    expect(await rule(I.weekly)).toMatchObject({
      nextDueOn: "2026-01-22",
      revision: 4,
      active: true,
    });
    expect(await rule(I.monthly)).toMatchObject({ nextDueOn: "2026-04-30", revision: 4 });
    expect(await rule(I.ending)).toMatchObject({
      nextDueOn: "2026-03-15",
      revision: 2,
      active: false,
    });
    expect(await rule(I.disabled)).toMatchObject({ revision: 1, active: false });
    expect(await dates(I.otherRule)).toEqual([]);

    // prettier-ignore
    await admin.query("UPDATE finance.recurring_expense_rules SET vendor='Edited future',amount=20,revision=revision+1 WHERE id=$1",[I.monthly]);
    await generator.run(command("2026-04-30", 10, 1));
    await generator.run(command("2028-02-29", 10, 2));
    expect(await dates(I.yearly)).toEqual([
      "2024-02-29",
      "2025-02-28",
      "2026-02-28",
      "2027-02-28",
      "2028-02-29",
    ]);
    expect(await rule(I.yearly)).toMatchObject({ nextDueOn: "2029-02-28", revision: 6 });
    // prettier-ignore
    const monthly = await admin.query("SELECT incurred_on::text AS date,vendor,amount::text FROM finance.expenses WHERE recurring_rule_id=$1 ORDER BY incurred_on",[I.monthly]);
    expect(monthly.rows.slice(0, 3)).toEqual([
      { date: "2026-01-31", vendor: "Monthly", amount: "2.0000" },
      { date: "2026-02-28", vendor: "Monthly", amount: "2.0000" },
      { date: "2026-03-31", vendor: "Monthly", amount: "2.0000" },
    ]);
    expect(monthly.rows.slice(3)).toEqual(
      expect.arrayContaining([{ date: "2026-04-30", vendor: "Edited future", amount: "20.0000" }]),
    );
    // prettier-ignore
    const evidence = await admin.query(`SELECT (SELECT count(*)::int FROM platform.idempotency_keys WHERE property_id=$1 AND operation='finance.generated_expense.execute') keys,(SELECT count(*)::int FROM platform.product_audit_events WHERE property_id=$1 AND action='finance.generated_expense.execute') audits`,[I.property]);
    expect(evidence.rows[0]).toEqual({ keys: 18, audits: 18 });
  });

  it("replays stable identities, excludes concurrent duplicates, and rolls back late audit failure", async () => {
    await admin.query(
      "UPDATE finance.recurring_expense_rules SET active=false WHERE property_id=$1",
      [I.property],
    );
    await admin.query(
      `INSERT INTO finance.recurring_expense_rules(id,property_id,category_id,cadence,starts_on,next_due_on,vendor,amount,currency,payment_status) VALUES ('${I.concurrent}','${I.property}','${I.category}','weekly','2026-05-01','2026-05-01','Concurrent',7,'EUR','unpaid')`,
    );
    const raced = await Promise.all([
      generator.run(command("2026-05-01", 10, 1)),
      generator.run(command("2026-05-01", 10, 1)),
    ]);
    // prettier-ignore
    expect(raced.flatMap((result) => result.ok ? result.occurrences.map((item) => item.outcome) : [])).toEqual(["generated"]);
    expect(await dates(I.concurrent)).toEqual(["2026-05-01"]);
    await admin.query(
      "UPDATE finance.recurring_expense_rules SET next_due_on='2026-05-01',revision=1,active=true WHERE id=$1",
      [I.concurrent],
    );
    await expect(generator.run(command("2026-05-01", 10, 1))).resolves.toMatchObject({
      ok: true,
      occurrences: [{ ruleId: I.concurrent, occurrenceOn: "2026-05-01", outcome: "replayed" }],
    });
    // prettier-ignore
    await admin.query("UPDATE finance.recurring_expense_rules SET next_due_on='2026-05-01',revision=2147483647 WHERE id=$1",[I.concurrent]);
    // prettier-ignore
    await expect(generator.run(command("2026-05-01",10,1))).resolves.toMatchObject({ok:true,occurrences:[{outcome:"failed",code:"revision_conflict"}]});
    // prettier-ignore
    await admin.query("UPDATE finance.recurring_expense_rules SET cadence='yearly',starts_on='9999-05-01',next_due_on='9999-05-01',revision=1 WHERE id=$1",[I.concurrent]);
    // prettier-ignore
    await expect(generator.run(command("9999-05-01",10,1))).resolves.toMatchObject({ok:true,occurrences:[{outcome:"failed",code:"cadence_exhausted"}]});

    // prettier-ignore
    await admin.query("UPDATE finance.recurring_expense_rules SET active=false WHERE id=$1",[I.concurrent]);
    // prettier-ignore
    for (const [ruleId, active] of [[I.updateRace, true], [I.disableRace, false]] as const) {
      await admin.query("INSERT INTO finance.recurring_expense_rules(id,property_id,category_id,cadence,starts_on,next_due_on,vendor,amount,currency,payment_status) VALUES ($1,$2,$3,'weekly','2026-05-15','2026-05-15','Race',1,'EUR','unpaid')", [ruleId,I.property,I.category]);
      const editor=new pg.Client({connectionString:URL}); await editor.connect();
      try { await editor.query("BEGIN"); await editor.query("SELECT id FROM hotel_catalog.properties WHERE id=$1 FOR KEY SHARE",[I.property]);
        const pending=generator.run(command("2026-05-15",10,1)); await waitForPropertyLock();
        await editor.query("UPDATE finance.recurring_expense_rules SET vendor='Edited',active=$2 WHERE id=$1",[ruleId,active]); await editor.query("COMMIT");
        await expect(pending).resolves.toMatchObject(active?{ok:true,occurrences:[{outcome:"generated"}]}:{ok:true,occurrences:[]});
      } finally { await editor.end(); }
      if(active) await admin.query("UPDATE finance.recurring_expense_rules SET active=false WHERE id=$1",[ruleId]);
    }
    await admin.query(`INSERT INTO finance.recurring_expense_rules(id,property_id,category_id,cadence,starts_on,next_due_on,vendor,amount,currency,payment_status) VALUES ('${I.rollback}','${I.property}','${I.category}','weekly','2026-06-01','2026-06-01','Rollback',8,'EUR','unpaid');
      CREATE FUNCTION platform.vay1232_fail_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action='finance.generated_expense.execute' THEN RAISE EXCEPTION 'forced audit failure'; END IF; RETURN NEW; END $$;
      CREATE TRIGGER vay1232_fail_audit BEFORE INSERT ON platform.product_audit_events FOR EACH ROW EXECUTE FUNCTION platform.vay1232_fail_audit()`);
    const failed = await generator.run(command("2026-06-01", 10, 1));
    expect(failed).toMatchObject({
      ok: true,
      occurrences: [
        { ruleId: I.rollback, occurrenceOn: "2026-06-01", outcome: "failed", code: "write_failed" },
      ],
    });
    await admin.query(
      "DROP TRIGGER vay1232_fail_audit ON platform.product_audit_events; DROP FUNCTION platform.vay1232_fail_audit()",
    );
    const callerCommand = command("2026-06-01", 10, 1);
    const caller = new pg.Client({ connectionString: URL });
    await caller.connect();
    let expenseId = "";
    // prettier-ignore
    try { await caller.query("BEGIN; SET LOCAL lock_timeout='50ms'; SET LOCAL statement_timeout='500ms'");
      const composed=await appendFinanceRecurringExpenseGeneration(caller as unknown as pg.PoolClient,callerCommand);
      expect(composed).toMatchObject({ok:true,occurrences:[{outcome:"generated"}]});
      expect((await caller.query("SELECT current_setting('lock_timeout') lock,current_setting('statement_timeout') statement")).rows[0]).toEqual({lock:"50ms",statement:"500ms"});
      expenseId=composed.ok&&composed.occurrences[0]?.outcome==="generated"?composed.occurrences[0].expenseId:"";
    } finally { await caller.query("ROLLBACK").catch(()=>{}); await caller.end(); }
    expect(await dates(I.rollback)).toEqual([]);
    expect(await rule(I.rollback)).toMatchObject({
      nextDueOn: "2026-06-01",
      revision: 1,
      active: true,
    });
    // prettier-ignore
    const residue = await admin.query("SELECT (SELECT count(*)::int FROM platform.idempotency_keys WHERE response_resource_id=$1::text) keys,(SELECT count(*)::int FROM platform.product_audit_events WHERE target_resource_id=$1::text) audits",[expenseId]);
    expect(residue.rows[0]).toEqual({ keys: 0, audits: 0 });
    await expect(
      generator.run({ ...command("2026-06-01", 10, 1), propertyId: crypto.randomUUID() }),
    ).resolves.toEqual({ ok: false, code: "property_not_found" });
    const malformed = command("2026-06-01", 10, 1);
    malformed.audit.requestedAt = "2026-99-99T99:99:99.999Z";
    await expect(generator.run(malformed)).resolves.toEqual({ ok: false, code: "invalid_command" });
  });

  async function dates(ruleId: string) {
    return (
      await admin.query<{ date: string }>(
        "SELECT incurred_on::text AS date FROM finance.expenses WHERE recurring_rule_id=$1 ORDER BY incurred_on",
        [ruleId],
      )
    ).rows.map((row) => row.date);
  }
  async function rule(ruleId: string) {
    return (
      await admin.query(
        'SELECT next_due_on::text AS "nextDueOn",revision::int,active FROM finance.recurring_expense_rules WHERE id=$1',
        [ruleId],
      )
    ).rows[0];
  }
  async function cleanup() {
    await admin.query(
      `DROP TRIGGER IF EXISTS vay1232_fail_audit ON platform.product_audit_events; DROP FUNCTION IF EXISTS platform.vay1232_fail_audit(); BEGIN; SET LOCAL session_replication_role=replica; DELETE FROM platform.product_audit_events WHERE property_id IN ('${I.property}','${I.otherProperty}'); DELETE FROM platform.idempotency_keys WHERE property_id IN ('${I.property}','${I.otherProperty}'); DELETE FROM finance.expenses WHERE property_id IN ('${I.property}','${I.otherProperty}'); DELETE FROM finance.recurring_expense_rules WHERE property_id IN ('${I.property}','${I.otherProperty}'); DELETE FROM finance.expense_categories WHERE property_id IN ('${I.property}','${I.otherProperty}'); DELETE FROM pms.property_pricing_settings WHERE property_id IN ('${I.property}','${I.otherProperty}'); DELETE FROM hotel_catalog.properties WHERE id IN ('${I.property}','${I.otherProperty}'); COMMIT`,
    );
  }
  // prettier-ignore
  async function waitForPropertyLock() { for (let attempt=0;attempt<100;attempt++) { if ((await admin.query("SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND pid<>pg_backend_pid() AND wait_event_type='Lock' AND query LIKE 'SELECT id FROM hotel_catalog.properties%'")).rowCount) return; await new Promise((resolve)=>setTimeout(resolve,10)); } throw new Error("generator did not wait for the property lock"); }
});

function command(propertyLocalAsOf: string, ruleLimit: number, catchUpLimit: number) {
  return {
    propertyId: I.property,
    propertyLocalAsOf,
    ruleLimit,
    catchUpLimit,
    audit: {
      actor: { kind: "system" as const, service: "finance-expense-automation" as const },
      requestId: `request-${crypto.randomUUID()}`,
      correlationId: `correlation-${crypto.randomUUID()}`,
      causationId: crypto.randomUUID(),
      jobId: crypto.randomUUID(),
      jobAttemptId: crypto.randomUUID(),
      reasonCode: "scheduled_generation" as const,
      requestedAt: NOW,
    },
  };
}
