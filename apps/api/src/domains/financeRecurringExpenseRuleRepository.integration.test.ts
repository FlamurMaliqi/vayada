import { createHash } from "node:crypto";

import { normalizeFinanceExpenseAmount } from "@vayada/domain-finance";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// prettier-ignore
import { createPgFinanceRecurringExpenseRuleRepository, type CreateFinanceRecurringExpenseRuleCommand,
  type DisableFinanceRecurringExpenseRuleCommand, type UpdateFinanceRecurringExpenseRuleCommand } from "./financeRecurringExpenseRuleRepository.js";

const URL = process.env["TEST_DATABASE_URL"];
const ACTOR = "12160000-0000-4000-8000-000000000001";
const PROPERTY = "12160000-0000-4000-8000-000000000002";
const OTHER_PROPERTY = "12160000-0000-4000-8000-000000000003";
const CATEGORY = "12160000-0000-4000-8000-000000000004";
const OTHER_CATEGORY = "12160000-0000-4000-8000-000000000005";
const ARCHIVED_CATEGORY = "12160000-0000-4000-8000-000000000006";
const RULE = "12160000-0000-4000-8000-000000000007";
if (URL && !/(^|[_-])(test|verify)([_-]|$)/i.test(new globalThis.URL(URL).pathname))
  throw new Error("Unsafe test database");

// prettier-ignore
describe.skipIf(!URL)("PostgreSQL Finance recurring expense rule repository", () => {
  const admin = new pg.Client({ connectionString: URL ?? "postgresql://disabled" });
  const repository = createPgFinanceRecurringExpenseRuleRepository(URL ?? "postgresql://disabled");
  beforeAll(async () => {
    await admin.connect(); await cleanup();
    await admin.query(`INSERT INTO identity.users (id,email,name,status) VALUES ('${ACTOR}','recurrence@example.test','Recurrence','active');
      INSERT INTO hotel_catalog.properties (id,public_id,display_name) VALUES ('${PROPERTY}','recurrence','Recurrence'),('${OTHER_PROPERTY}','recurrence-other','Recurrence other');
      INSERT INTO pms.property_pricing_settings (property_id,currency) VALUES ('${PROPERTY}','EUR'),('${OTHER_PROPERTY}','USD');
      INSERT INTO finance.expense_categories (id,property_id,name,color,archived_at) VALUES ('${CATEGORY}','${PROPERTY}','Operations','#123456',NULL),('${OTHER_CATEGORY}','${OTHER_PROPERTY}','Other','#654321',NULL),('${ARCHIVED_CATEGORY}','${PROPERTY}','Archived','#111111',now())`);
  });
  afterAll(async () => { await repository.close(); await cleanup(); await admin.end(); });

  it("creates, revises, disables, and preserves history with exact evidence", async () => {
    const mismatch = { ok: false as const, code: "evidence_mismatch" as const };
    await expect(repository.create(create("cross", OTHER_CATEGORY))).resolves.toEqual(mismatch);
    await expect(repository.create(create("archived", ARCHIVED_CATEGORY))).resolves.toEqual(mismatch);
    await expect(repository.create(create("currency", CATEGORY, "USD"))).resolves.toEqual({ ok: false, code: "currency_mismatch" });
    for (const invalid of [{ startsOn: "2026-02-30" },{ endsOn: "2026-07-31" },{ endsOn: null },{ paymentStatus: "settled" },{ extra: true }]) await expect(repository.create({ ...create("invalid"), ...invalid } as never)).resolves.toEqual({ ok: false, code: "invalid_command" });
    const input = create("create");
    const created = await Promise.all([repository.create(input),repository.create(input)]);
    expect(created.map((value) => value.ok ? value.outcome : value.code).sort()).toEqual(["created","replayed"]);
    expect(created).toEqual(expect.arrayContaining([expect.objectContaining({ ok: true, outcome: "created", item: { id: RULE, categoryId: CATEGORY, vendor: "Supplier", amount: { amount: "12.0000", currency: "EUR" }, notes: "Monthly service", paymentStatus: "paid", cadence: "monthly", startsOn: "2026-08-15", nextDueOn: "2026-08-15", endsOn: null, active: true, revision: 1 } })]));
    await expect(repository.create({ ...input, commandId: crypto.randomUUID() })).resolves.toEqual({ ok: false, code: "idempotency_conflict" });
    await expect(repository.create({ ...input, idempotencyKey: "duplicate-id" })).resolves.toEqual({ ok: false, code: "idempotency_conflict" });
    await admin.query(`INSERT INTO finance.expenses (property_id,category_id,origin,incurred_on,vendor,amount,currency,recurring_rule_id,source_key) VALUES ($1,$2,'recurring','2026-08-15','Supplier',12,'EUR',$3,'rule:2026-08-15')`, [PROPERTY,CATEGORY,RULE]);
    await expect(admin.query("UPDATE finance.recurring_expense_rules SET next_due_on='2026-01-01' WHERE id=$1",[RULE])).rejects.toMatchObject({ constraint: "chk_finance_recurring_expense_rules_dates" });
    const update = mutation("update",1,{ categoryId: CATEGORY, cadence: "yearly", nextDueOn: "2027-08-15", endsOn: "2027-08-15", vendor: "AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA", amount: { amount: normalizeFinanceExpenseAmount("20")!, currency: "EUR" }, paymentStatus: "unpaid", notes: "Future only" });
    const updated = await Promise.all([repository.update(update),repository.update(update)]);
    expect(updated.map((value) => value.ok ? value.outcome : value.code).sort()).toEqual(["replayed","updated"]);
    await expect(repository.update({ ...update, vendor: update.vendor!.toLowerCase() })).resolves.toEqual({ ok: false, code: "idempotency_conflict" });
    await expect(repository.update(mutation("clear",2,{ endsOn: null, notes: null }))).resolves.toMatchObject({ ok: true, item: { endsOn: null, revision: 3 } });
    const raced = await Promise.all([repository.update(mutation("race-a",3,{ cadence: "weekly" })),repository.update(mutation("race-b",3,{ nextDueOn: "2027-01-15" }))]);
    expect(raced.map((value) => value.ok ? value.outcome : value.code).sort()).toEqual(["revision_conflict","updated"]);
    await expect(repository.update(mutation("bad",4,{ nextDueOn: "2026-01-01" }))).resolves.toEqual({ ok: false, code: "invalid_command" });
    await expect(repository.update({ ...mutation("cross-property",4,{ cadence: "weekly" }), propertyId: OTHER_PROPERTY })).resolves.toEqual({ ok: false, code: "not_found" });
    await admin.query("BEGIN");
    await admin.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))",[`finance.recurring_expense_rule|${PROPERTY}|${RULE}`]);
    await expect(repository.update(mutation("locked",4,{ cadence: "monthly" }))).resolves.toEqual({ ok: false, code: "write_unavailable" });
    await admin.query("ROLLBACK");
    const disable = disableCommand("disable",4);
    await expect(repository.disable(disable)).resolves.toMatchObject({ ok: true, outcome: "updated", item: { active: false, revision: 5 } });
    await expect(repository.disable(disable)).resolves.toMatchObject({ ok: true, outcome: "replayed", item: { active: false } });
    await expect(repository.disable(disableCommand("already",5))).resolves.toEqual({ ok: false, code: "revision_conflict" });
    for (const invalid of [{ ruleId: "bad" },{ expectedRevision: 0 },{ expectedRevision: undefined }]) await expect(repository.disable({ ...disableCommand("invalid",5),...invalid } as never)).resolves.toEqual({ ok: false, code: "invalid_command" });
    const evidence = await admin.query(`SELECT (SELECT count(*)::int FROM finance.expenses WHERE recurring_rule_id=$1) AS expenses,(SELECT count(*)::int FROM platform.product_audit_events WHERE property_id=$2) AS audits,(SELECT count(*)::int FROM platform.idempotency_keys WHERE property_id=$2) AS keys,(SELECT jsonb_build_object('redacted',redacted_payload,'private',private_payload,'metadata',audit_metadata) FROM platform.product_audit_events WHERE action='finance.recurring_expense_rule.update' AND redacted_payload->>'commandId'=$3) AS audit`,[RULE,PROPERTY,update.commandId]);
    expect(evidence.rows[0]).toMatchObject({ expenses: 1, audits: 5, keys: 5, audit: { redacted: { ruleId: RULE, revision: 2 }, private: { reason: "Manage recurring expense", previous: { revision: 1 }, next: { revision: 2 } }, metadata: { requestId: "request-update", actorOrganizationId: expect.any(String) } } });
    expect(evidence.rows[0].audit.redacted).not.toHaveProperty("previous");
    await admin.query("UPDATE platform.idempotency_keys SET response_resource_type='expense',idempotency_metadata=jsonb_set(idempotency_metadata,'{result,extra}','true') WHERE operation='finance.recurring_expense_rule.create' AND key_hash=$1",[hashKey(input.idempotencyKey)]);
    await expect(repository.create(input)).rejects.toThrow("replay evidence is invalid");
    const raceRule = crypto.randomUUID(); await repository.create({ ...create("resource-race"),commandId: raceRule });
    const resourceRace = await Promise.all([repository.update({ ...mutation("update-race",1,{ cadence: "weekly" }),ruleId: raceRule }),repository.disable({ ...disableCommand("disable-race",1),ruleId: raceRule })]);
    expect(resourceRace.map((value) => value.ok ? value.outcome : value.code).sort()).toEqual(["revision_conflict","updated"]);
  },15000);

  it("rolls back the rule and reservation when audit persistence fails", async () => {
    const input = { ...create("rollback"), commandId: crypto.randomUUID() };
    input.audit.actor = { kind: "user", userId: crypto.randomUUID(), organizationId: crypto.randomUUID() };
    await expect(repository.create(input)).rejects.toMatchObject({ code: "23503" });
    const residue = await admin.query(`SELECT (SELECT count(*)::int FROM finance.recurring_expense_rules WHERE id=$1) AS rules,(SELECT count(*)::int FROM platform.idempotency_keys WHERE key_hash=$2) AS keys`,[input.commandId,hashKey(input.idempotencyKey)]);
    expect(residue.rows[0]).toEqual({ rules: 0, keys: 0 });
  });
  async function cleanup() { await admin.query(`BEGIN; SET LOCAL session_replication_role=replica; DELETE FROM platform.product_audit_events WHERE property_id IN ('${PROPERTY}','${OTHER_PROPERTY}'); DELETE FROM platform.idempotency_keys WHERE property_id IN ('${PROPERTY}','${OTHER_PROPERTY}'); DELETE FROM finance.expenses WHERE property_id IN ('${PROPERTY}','${OTHER_PROPERTY}'); DELETE FROM finance.recurring_expense_rules WHERE property_id IN ('${PROPERTY}','${OTHER_PROPERTY}'); DELETE FROM finance.expense_categories WHERE property_id IN ('${PROPERTY}','${OTHER_PROPERTY}'); DELETE FROM pms.property_pricing_settings WHERE property_id IN ('${PROPERTY}','${OTHER_PROPERTY}'); DELETE FROM hotel_catalog.properties WHERE id IN ('${PROPERTY}','${OTHER_PROPERTY}'); DELETE FROM identity.users WHERE id='${ACTOR}'; COMMIT`); }
});

// prettier-ignore
function context(key: string) { return { commandId: crypto.randomUUID(), idempotencyKey: `recurrence-${key}`, propertyId: PROPERTY, audit: { actor: { kind: "user" as const, userId: ACTOR, organizationId: crypto.randomUUID() }, requestId: `request-${key}`, correlationId: `correlation-${key}`, reason: "Manage recurring expense", requestedAt: "2026-08-11T10:00:00.000Z" as const } }; }
// prettier-ignore
function create(key: string, categoryId = CATEGORY, currency = "EUR"): CreateFinanceRecurringExpenseRuleCommand { return { ...context(key), commandId: key === "create" ? RULE : crypto.randomUUID(), categoryId, cadence: "monthly", startsOn: "2026-08-15", vendor: "Supplier", amount: { amount: normalizeFinanceExpenseAmount("12")!, currency }, paymentStatus: "paid", notes: "Monthly service" }; }
// prettier-ignore
function mutation(key: string, expectedRevision: number, patch: Partial<Pick<UpdateFinanceRecurringExpenseRuleCommand,"categoryId"|"cadence"|"nextDueOn"|"endsOn"|"vendor"|"amount"|"paymentStatus"|"notes">>): UpdateFinanceRecurringExpenseRuleCommand { return { ...context(key), ruleId: RULE, expectedRevision, ...patch }; }
// prettier-ignore
function disableCommand(key: string, expectedRevision: number): DisableFinanceRecurringExpenseRuleCommand { return { ...context(key), ruleId: RULE, expectedRevision }; }
function hashKey(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
