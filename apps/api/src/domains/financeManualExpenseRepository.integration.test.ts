import { normalizeFinanceExpenseAmount } from "@vayada/domain-finance";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createPgFinanceManualExpenseRepository } from "./financeManualExpenseRepository.js";

const URL = process.env["TEST_DATABASE_URL"];
const ACTOR = "12100000-0000-4000-8000-000000000001";
const PROPERTY = "12100000-0000-4000-8000-000000000002";
const OTHER_PROPERTY = "12100000-0000-4000-8000-000000000003";
const CATEGORY = "12100000-0000-4000-8000-000000000004";
const OTHER_CATEGORY = "12100000-0000-4000-8000-000000000005";
const ARCHIVED_CATEGORY = "12100000-0000-4000-8000-000000000006";
const EXPENSE = "12100000-0000-4000-8000-000000000007";
const RECEIPT = "12100000-0000-4000-8000-000000000008";

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
         'finance','expense','${EXPENSE}','active','${ACTOR}')`);
  });
  afterAll(async () => {
    await repository.close();
    await cleanup();
    await admin.end();
  });

  it("creates one audited expense and rejects mismatched or partial evidence", async () => {
    const mismatch = { ok: false as const, code: "evidence_mismatch" as const };
    const crossProperty = {
      ...command(EXPENSE, "cross", OTHER_CATEGORY, "USD"),
      propertyId: OTHER_PROPERTY,
      receiptMediaId: RECEIPT,
    };
    await expect(repository.create(crossProperty)).resolves.toEqual(mismatch);
    const input = { ...command(EXPENSE, "same"), receiptMediaId: RECEIPT };
    await expect(repository.create(input)).resolves.toMatchObject({
      ok: true,
      outcome: "created",
      item: { id: EXPENSE, origin: "manual", revision: 1, amount: { amount: "10.0000" } },
    });
    await admin.query("UPDATE finance.expenses SET notes='later',revision=2 WHERE id=$1", [
      EXPENSE,
    ]);
    await expect(repository.create(input)).resolves.toMatchObject({
      ok: true,
      outcome: "replayed",
      item: { id: EXPENSE, revision: 1 },
    });
    await expect(repository.create({ ...input, commandId: crypto.randomUUID() })).resolves.toEqual({
      ok: false,
      code: "idempotency_conflict",
    });
    await expect(repository.create({ ...input, idempotencyKey: "duplicate-id" })).resolves.toEqual({
      ok: false,
      code: "idempotency_conflict",
    });
    await admin.query(
      "UPDATE platform.media_objects SET lifecycle_status='quarantined' WHERE id=$1",
      [RECEIPT],
    );
    await expect(
      repository.create(command(crypto.randomUUID(), "currency", CATEGORY, "USD")),
    ).resolves.toEqual({ ok: false, code: "currency_mismatch" });
    for (const invalidEvidence of [
      command(crypto.randomUUID(), "category", OTHER_CATEGORY),
      command(crypto.randomUUID(), "archived", ARCHIVED_CATEGORY),
      { ...input, idempotencyKey: "inactive" },
    ])
      await expect(repository.create(invalidEvidence)).resolves.toEqual(mismatch);
    const invalid = { ...command(crypto.randomUUID(), "invalid"), paymentStatus: "paid" as const };
    await expect(repository.create(invalid)).resolves.toEqual({
      ok: false,
      code: "invalid_command",
    });
    const rollback = command(crypto.randomUUID(), "rollback");
    rollback.audit.actor = {
      kind: "user",
      userId: crypto.randomUUID(),
      organizationId: crypto.randomUUID(),
    };
    await expect(repository.create(rollback)).rejects.toMatchObject({ code: "23503" });
    const evidence = await admin.query<{ expenses: number; audits: number; keys: number }>(
      `SELECT (SELECT count(*)::int FROM finance.expenses WHERE property_id=$1) AS expenses,
        (SELECT count(*)::int FROM platform.product_audit_events WHERE property_id=$1) AS audits,
        (SELECT count(*)::int FROM platform.idempotency_keys WHERE property_id=$1) AS keys`,
      [PROPERTY],
    );
    expect(evidence.rows[0]).toEqual({ expenses: 1, audits: 1, keys: 1 });
  });

  async function cleanup() {
    await admin.query(`BEGIN; SET LOCAL session_replication_role=replica;
      DELETE FROM finance.expenses WHERE property_id IN ('${PROPERTY}','${OTHER_PROPERTY}');
      DELETE FROM platform.product_audit_events WHERE property_id IN ('${PROPERTY}','${OTHER_PROPERTY}');
      DELETE FROM platform.idempotency_keys WHERE property_id IN ('${PROPERTY}','${OTHER_PROPERTY}');
      DELETE FROM platform.media_objects WHERE id='${RECEIPT}';
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
