import { normalizeFinanceExpenseAmount } from "@vayada/domain-finance";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createPgFinanceManualExpenseRepository } from "./financeManualExpenseRepository.js";

const URL = process.env["TEST_DATABASE_URL"];
const ACTOR = "12100000-0000-4000-8000-000000000001";
const PROPERTY = "12100000-0000-4000-8000-00000000000b";
const OTHER_PROPERTY = "12100000-0000-4000-8000-000000000003";
const CATEGORY = "12100000-0000-4000-8000-000000000004";
const OTHER_CATEGORY = "12100000-0000-4000-8000-000000000005";
const ARCHIVED_CATEGORY = "12100000-0000-4000-8000-000000000006";
const EXPENSE = "12100000-0000-4000-8000-00000000000a";
const RECEIPT = "12100000-0000-4000-8000-000000000008";
if (URL && !/(^|[_-])(test|verify)([_-]|$)/i.test(new globalThis.URL(URL).pathname))
  throw new Error("Unsafe test database");

describe.skipIf(!URL)("PostgreSQL Finance manual expense repository", () => {
  const admin = new pg.Client({ connectionString: URL ?? "postgresql://disabled" });
  const repository = createPgFinanceManualExpenseRepository(URL ?? "postgresql://disabled");

  beforeAll(async () => {
    await admin.connect();
    await cleanup();
    await admin.query(`INSERT INTO identity.users (id,email,name,status) VALUES ('${ACTOR}','manual-expense@example.test','Manual expense','active');
      INSERT INTO hotel_catalog.properties (id,public_id,display_name) VALUES ('${PROPERTY}','manual-expense','Manual expense'),
        ('${OTHER_PROPERTY}','manual-expense-other','Manual expense other');
      INSERT INTO pms.property_pricing_settings (property_id,currency) VALUES ('${PROPERTY}','EUR'),('${OTHER_PROPERTY}','USD');
      INSERT INTO finance.expense_categories (id,property_id,name,color,archived_at) VALUES ('${CATEGORY}','${PROPERTY}','Operations','#123456',NULL),
        ('${OTHER_CATEGORY}','${OTHER_PROPERTY}','Other','#654321',NULL),
        ('${ARCHIVED_CATEGORY}','${PROPERTY}','Archived','#111111',now());
      INSERT INTO platform.media_objects (id,bucket,storage_key,visibility,purpose,property_id,resource_product,resource_type,resource_id,lifecycle_status,created_by_user_id)
        VALUES ('${RECEIPT}','test','manual-expense-receipt','private','finance.expense.receipt','${PROPERTY}',
         'finance','expense','${EXPENSE}','active','${ACTOR}'),('12100000-0000-4000-8000-000000000009','test','wrong-purpose','private','pms.messaging.attachment','${PROPERTY}','pms','expense','${EXPENSE}','active','${ACTOR}')`);
  });
  // prettier-ignore
  afterAll(async () => { await repository.close(); await cleanup(); await admin.end(); });

  it("creates one audited expense and rejects mismatched or partial evidence", async () => {
    const mismatch = { ok: false as const, code: "evidence_mismatch" as const };
    // prettier-ignore
    const crossProperty = { ...command(EXPENSE, "cross", OTHER_CATEGORY, "USD"),
      propertyId: OTHER_PROPERTY, receiptMediaId: RECEIPT };
    await expect(repository.create(crossProperty)).resolves.toEqual(mismatch);
    // prettier-ignore
    await expect(repository.create({ ...command(crypto.randomUUID(), "missing"), propertyId: crypto.randomUUID() })).resolves.toEqual({ ok: false, code: "not_found" });
    const input = { ...command(EXPENSE.toUpperCase(), "same"), receiptMediaId: RECEIPT };
    // prettier-ignore
    for (const badReceipt of [{ ...input, commandId: crypto.randomUUID() }, { ...input, receiptMediaId: "12100000-0000-4000-8000-000000000009" }])
      await expect(repository.create(badReceipt)).resolves.toEqual(mismatch);
    // prettier-ignore
    await admin.query(`BEGIN; SELECT id FROM hotel_catalog.properties WHERE id='${PROPERTY}' FOR KEY SHARE`);
    // prettier-ignore
    const raced = await Promise.all([repository.create(input), repository.create({ ...input, propertyId: PROPERTY.toUpperCase() })]);
    await admin.query("ROLLBACK");
    // prettier-ignore
    expect(raced.map((result) => result.ok ? result.outcome : result.code).sort()).toEqual(["created", "replayed"]);
    // prettier-ignore
    for (const result of raced) expect(result).toMatchObject({ ok: true, item: { id: EXPENSE, origin: "manual", revision: 1, amount: { amount: "10.0000" } } });
    // prettier-ignore
    await admin.query("UPDATE finance.expenses SET notes='later',revision=2 WHERE id=$1", [EXPENSE]);
    // prettier-ignore
    await expect(repository.create(input)).resolves.toMatchObject({ ok: true, outcome: "replayed", item: { id: EXPENSE, revision: 1 } });
    // prettier-ignore
    await expect(repository.create({ ...input, commandId: crypto.randomUUID() })).resolves.toEqual({ ok: false, code: "idempotency_conflict" });
    // prettier-ignore
    await expect(repository.create({ ...input, idempotencyKey: "duplicate-id" })).resolves.toEqual({ ok: false, code: "idempotency_conflict" });
    const update = { ...mutation("update", 2), notes: "Updated note" };
    // prettier-ignore
    await expect(repository.update(update)).resolves.toMatchObject({ ok: true, outcome: "updated", item: { id: EXPENSE, revision: 3 } });
    // prettier-ignore
    await expect(repository.update(update)).resolves.toMatchObject({ ok: true, outcome: "replayed" });
    // prettier-ignore
    await expect(repository.update({ ...update, notes: "Changed reuse" })).resolves.toEqual({ ok: false, code: "idempotency_conflict" });
    // prettier-ignore
    const races = [{ ...mutation("race-a", 3), notes: "Concurrent A" }, { ...mutation("race-b", 3), notes: "Concurrent B" }];
    const updateRace = await Promise.all(races.map((value) => repository.update(value)));
    // prettier-ignore
    expect(updateRace.map((value) => value.ok ? value.outcome : value.code).sort()).toEqual(["revision_conflict", "updated"]);
    for (const [index, patch] of [
      { paymentStatus: "unpaid", paidOn: "2026-08-11" },
      { vendor: null },
      { incurredOn: null },
    ].entries())
      // prettier-ignore
      await expect(repository.update({ ...mutation(`invalid-${index}`, 4), ...patch } as never)).resolves.toEqual({ ok: false, code: "invalid_command" });
    for (const target of ["command", "audit", "actor"] as const) {
      const hostile = { ...mutation(`hostile-${target}`, 4), notes: "private" };
      // prettier-ignore
      Object.assign(target === "command" ? hostile : target === "audit" ? hostile.audit : hostile.audit.actor, { unexpected: "secret" });
      // prettier-ignore
      await expect(repository.update(hostile)).resolves.toEqual({ ok: false, code: "invalid_command" });
    }
    // prettier-ignore
    await admin.query(`BEGIN; SET LOCAL session_replication_role=replica; UPDATE finance.expenses SET revision=2147483647 WHERE id='${EXPENSE}'; COMMIT`);
    // prettier-ignore
    await expect(repository.update({ ...mutation("max", 2_147_483_647), notes: "overflow" })).resolves.toEqual({ ok: false, code: "revision_conflict" });
    // prettier-ignore
    await admin.query(`BEGIN; SET LOCAL session_replication_role=replica; UPDATE finance.expenses SET revision=4 WHERE id='${EXPENSE}'; COMMIT`);
    // prettier-ignore
    await expect(repository.update({ ...mutation("bad-category", 4), categoryId: OTHER_CATEGORY })).resolves.toEqual(mismatch);
    // prettier-ignore
    await expect(repository.update({ ...mutation("bad-currency", 4), amount: { amount: normalizeFinanceExpenseAmount("11")!, currency: "USD" } })).resolves.toEqual({ ok: false, code: "currency_mismatch" });
    const rollbackUpdate = { ...mutation("update-rollback", 4), notes: "Must roll back" };
    rollbackUpdate.audit.actor.userId = crypto.randomUUID();
    await expect(repository.update(rollbackUpdate)).rejects.toMatchObject({ code: "23503" });
    // prettier-ignore
    const [correction, goodReceipt, badReceipt, badCorrection] = Array.from({ length: 4 }, () => crypto.randomUUID());
    await admin.query(
      `INSERT INTO platform.media_objects
       (id,bucket,storage_key,visibility,purpose,property_id,resource_product,resource_type,
        resource_id,lifecycle_status,created_by_user_id) VALUES
       ($1,'test','good','private','finance.expense.receipt',$3,'finance','expense',$2,'active',$4),
       ($5,'test','bad','private','finance.expense.receipt',$6,'finance','expense',$7,'active',$4)`,
      [goodReceipt, correction, PROPERTY, ACTOR, badReceipt, OTHER_PROPERTY, badCorrection],
    );
    // prettier-ignore
    await expect(repository.update({ ...mutation("bad-receipt", 4, EXPENSE, badCorrection),
      incurredOn: "2026-08-11", receiptMediaId: badReceipt })).resolves.toEqual(mismatch);
    // prettier-ignore
    const correct = { ...mutation("correct", 4, EXPENSE.toUpperCase(), correction.toUpperCase()),
      propertyId: PROPERTY.toUpperCase(), incurredOn: "2026-08-11", vendor: "Corrected supplier",
      receiptMediaId: goodReceipt.toUpperCase() };
    // prettier-ignore
    await expect(repository.update(correct)).resolves.toMatchObject({ ok: true, outcome: "corrected", item: { id: correction, reversesExpenseId: EXPENSE } });
    // prettier-ignore
    await expect(repository.update({ ...correct, commandId: correction, expenseId: EXPENSE,
      propertyId: PROPERTY, receiptMediaId: goodReceipt })).resolves.toMatchObject({ ok: true, outcome: "replayed" });
    const updateCorrection = { ...mutation("update-correction", 1, correction), notes: "Reviewed" };
    // prettier-ignore
    await expect(repository.update(updateCorrection)).resolves.toMatchObject({ ok: true, outcome: "updated", item: { id: correction, revision: 2 } });
    // prettier-ignore
    await expect(repository.update(updateCorrection)).resolves.toMatchObject({ ok: true, outcome: "replayed" });
    // prettier-ignore
    await admin.query(`UPDATE platform.idempotency_keys SET idempotency_metadata=jsonb_set(idempotency_metadata,'{result,item,unexpected}','true')
      WHERE operation='finance.manual_expense.update' AND property_id=$1 AND correlation_id='correlation-update'`, [PROPERTY]);
    await expect(repository.update(update)).rejects.toThrow("replay evidence");
    // prettier-ignore
    await admin.query(`UPDATE platform.idempotency_keys SET idempotency_metadata=jsonb_set(idempotency_metadata,'{result,item,unexpected}','true')
      WHERE operation='finance.manual_expense.create' AND property_id=$1 AND correlation_id='correlation-same'`, [PROPERTY]);
    await expect(repository.create(input)).rejects.toThrow("replay evidence");
    // prettier-ignore
    await admin.query("UPDATE platform.media_objects SET lifecycle_status='quarantined' WHERE id=$1", [RECEIPT]);
    await expect(
      repository.create(command(crypto.randomUUID(), "currency", CATEGORY, "USD")),
    ).resolves.toEqual({ ok: false, code: "currency_mismatch" });
    // prettier-ignore
    for (const invalidEvidence of [command(crypto.randomUUID(), "category", OTHER_CATEGORY), command(crypto.randomUUID(), "archived", ARCHIVED_CATEGORY), { ...input, idempotencyKey: "inactive" }])
      await expect(repository.create(invalidEvidence)).resolves.toEqual(mismatch);
    const invalid = { ...command(crypto.randomUUID(), "invalid"), paymentStatus: "paid" as const };
    // prettier-ignore
    await expect(repository.create(invalid)).resolves.toEqual({ ok: false, code: "invalid_command" });
    for (const target of ["command", "audit", "actor"] as const) {
      const hostile = command(crypto.randomUUID(), `hostile-${target}`);
      // prettier-ignore
      Object.assign(target === "command" ? hostile : target === "audit" ? hostile.audit : hostile.audit.actor, { unexpected: "secret" });
      // prettier-ignore
      await expect(repository.create(hostile)).resolves.toEqual({ ok: false, code: "invalid_command" });
    }
    const impossible = command(crypto.randomUUID(), "impossible-date");
    impossible.audit.requestedAt = "2026-02-30T12:00:00Z";
    // prettier-ignore
    await expect(repository.create(impossible)).resolves.toEqual({ ok: false, code: "invalid_command" });
    const rollback = command(crypto.randomUUID(), "rollback");
    // prettier-ignore
    rollback.audit.actor = { kind: "user", userId: crypto.randomUUID(), organizationId: crypto.randomUUID() };
    await expect(repository.create(rollback)).rejects.toMatchObject({ code: "23503" });
    // prettier-ignore
    await admin.query("UPDATE finance.expense_categories SET archived_at=now() WHERE id=$1", [CATEGORY]);
    // prettier-ignore
    await expect(repository.update({ ...mutation("archived-same", 2, correction), categoryId: CATEGORY.toUpperCase(), notes: "Reviewed again" })).resolves.toMatchObject({ ok: true, outcome: "updated", item: { id: correction, revision: 3 } });
    // prettier-ignore
    const sentinel = { ...mutation("sentinel", 3, correction), paymentStatus: "paid" as const, paidOn: "2026-08-12" };
    // prettier-ignore
    await expect(repository.update(sentinel)).resolves.toMatchObject({ ok: true, outcome: "updated" });
    // prettier-ignore
    await expect(repository.update({ ...sentinel, notes: "__absent__" })).resolves.toEqual({ ok: false, code: "idempotency_conflict" });
    const evidence = await admin.query(
      `SELECT (SELECT count(*)::int FROM finance.expenses WHERE property_id=$1) AS expenses,
        (SELECT count(*)::int FROM platform.product_audit_events WHERE property_id=$1) AS audits,
        (SELECT count(*)::int FROM platform.idempotency_keys WHERE property_id=$1) AS keys,
        (SELECT jsonb_build_object('redacted',redacted_payload,'private',private_payload,'metadata',audit_metadata)
         FROM platform.product_audit_events WHERE property_id=$1 AND causation_id=$2) AS audit`,
      [PROPERTY, update.audit.requestId],
    );
    expect(evidence.rows[0]).toMatchObject({ expenses: 2, audits: 7, keys: 7 });
    // prettier-ignore
    expect(evidence.rows[0].audit).toMatchObject({ redacted: { commandId: update.commandId, outcome: "updated" },
      private: { reason: "test", previous: { notes: "later" }, next: { notes: "Updated note" } },
      metadata: { requestId: update.audit.requestId, actorOrganizationId: update.audit.actor.organizationId } });
  });

  async function cleanup() {
    await admin.query(`BEGIN; SET LOCAL session_replication_role=replica;
      DELETE FROM finance.expenses WHERE property_id IN ('${PROPERTY}','${OTHER_PROPERTY}');
      DELETE FROM platform.product_audit_events WHERE property_id IN ('${PROPERTY}','${OTHER_PROPERTY}');
      DELETE FROM platform.idempotency_keys WHERE property_id IN ('${PROPERTY}','${OTHER_PROPERTY}');
      DELETE FROM platform.media_objects WHERE id IN ('${RECEIPT}','12100000-0000-4000-8000-000000000009');
      DELETE FROM platform.media_objects WHERE property_id IN ('${PROPERTY}','${OTHER_PROPERTY}')
        AND purpose='finance.expense.receipt';
      DELETE FROM finance.expense_categories WHERE property_id IN ('${PROPERTY}','${OTHER_PROPERTY}');
      DELETE FROM pms.property_pricing_settings WHERE property_id IN ('${PROPERTY}','${OTHER_PROPERTY}');
      DELETE FROM hotel_catalog.properties WHERE id IN ('${PROPERTY}','${OTHER_PROPERTY}');
      DELETE FROM identity.users WHERE id='${ACTOR}'; COMMIT`);
  }
});

function command(id: string, key: string, categoryId = CATEGORY, currency = "EUR") {
  return {
    commandId: id,
    idempotencyKey: key,
    propertyId: PROPERTY,
    categoryId,
    incurredOn: "2026-08-10",
    vendor: "Supplier",
    amount: { amount: normalizeFinanceExpenseAmount("10")!, currency },
    paymentStatus: "unpaid" as const,
    audit: {
      actor: { kind: "user" as const, userId: ACTOR, organizationId: crypto.randomUUID() },
      requestId: `request-${key}`,
      correlationId: `correlation-${key}`,
      reason: "test",
      requestedAt: "2026-08-10T12:00:00Z",
    },
  };
}

// prettier-ignore
function mutation(key: string, expectedRevision: number, expenseId = EXPENSE,
  commandId: string = crypto.randomUUID()) {
  const base = command(commandId, key);
  return { commandId, idempotencyKey: key, propertyId: PROPERTY, audit: base.audit,
    expectedRevision, expenseId };
}
