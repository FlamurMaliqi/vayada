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
const ACCEPTED_AT = "2026-08-11T00:30:00.000Z";

describe.skipIf(!URL)("PostgreSQL Finance manual expense repository", () => {
  const admin = new pg.Client({ connectionString: URL ?? "postgresql://disabled" });
  const repository = createPgFinanceManualExpenseRepository(
    URL ?? "postgresql://disabled",
    () => new Date(ACCEPTED_AT),
  );

  beforeAll(async () => {
    await admin.connect();
    await cleanup();
    await admin.query(`INSERT INTO identity.users (id,email,name,status) VALUES ('${ACTOR}','manual-expense@example.test','Manual expense','active');
      INSERT INTO hotel_catalog.properties (id,public_id,display_name) VALUES ('${PROPERTY}','manual-expense','Manual expense'),
        ('${OTHER_PROPERTY}','manual-expense-other','Manual expense other');
      INSERT INTO hotel_catalog.property_locations (property_id,timezone) VALUES ('${PROPERTY}','America/Los_Angeles');
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
    const update = { ...mutation("update", 2), vendor: "Updated supplier" };
    await expect(repository.update(update)).resolves.toMatchObject({
      ok: true,
      outcome: "updated",
      item: { id: EXPENSE, revision: 3 },
    });
    await expect(
      repository.update({
        ...update,
        amount: { currency: update.amount.currency, amount: update.amount.amount },
      }),
    ).resolves.toMatchObject({ ok: true, outcome: "replayed" });
    await expect(repository.update({ ...update, vendor: "Changed reuse" })).resolves.toEqual({
      ok: false,
      code: "idempotency_conflict",
    });
    const races = [
      { ...mutation("race-a", 3), vendor: "Concurrent A" },
      { ...mutation("race-b", 3), vendor: "Concurrent B" },
    ];
    const raced = await Promise.all(races.map((value) => repository.update(value)));
    expect(raced.map((value) => (value.ok ? value.outcome : value.code)).sort()).toEqual([
      "revision_conflict",
      "updated",
    ]);
    for (const [index, patch] of [
      { paymentStatus: "unpaid", paidOn: "2026-08-11" },
      { vendor: null },
      { incurredOn: null },
    ].entries())
      await expect(
        repository.update({
          ...mutation(`invalid-${index}`, 4),
          ...patch,
        } as never),
      ).resolves.toEqual({ ok: false, code: "invalid_command" });
    const rollbackUpdate = { ...mutation("update-rollback", 4), vendor: "Must roll back" };
    rollbackUpdate.audit.actor.userId = crypto.randomUUID();
    await expect(repository.update(rollbackUpdate)).rejects.toMatchObject({ code: "23503" });
    const [correction, goodReceipt, badReceipt, badCorrection] = Array.from({ length: 4 }, () =>
      crypto.randomUUID(),
    );
    await admin.query(
      `INSERT INTO platform.media_objects
       (id,bucket,storage_key,visibility,purpose,property_id,resource_product,resource_type,
        resource_id,lifecycle_status,created_by_user_id) VALUES
       ($1,'test','good','private','finance.expense.receipt',$3,'finance','expense',$2,'active',$4),
       ($5,'test','bad','private','finance.expense.receipt',$6,'finance','expense',$7,'active',$4)`,
      [goodReceipt, correction, PROPERTY, ACTOR, badReceipt, OTHER_PROPERTY, badCorrection],
    );
    await expect(
      repository.update({
        ...mutation("bad-receipt", 4, EXPENSE, badCorrection),
        incurredOn: "2026-08-11",
        receiptMediaId: badReceipt,
      }),
    ).resolves.toEqual(mismatch);
    const correct = {
      ...mutation("correct", 4, EXPENSE, correction),
      incurredOn: "2026-08-11",
      receiptMediaId: goodReceipt,
    };
    await expect(repository.update(correct)).resolves.toMatchObject({
      ok: true,
      outcome: "corrected",
      item: { id: correction, reversesExpenseId: EXPENSE },
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
    const evidence = await admin.query(
      `SELECT (SELECT count(*)::int FROM finance.expenses WHERE property_id=$1) AS expenses,
        (SELECT count(*)::int FROM platform.product_audit_events WHERE property_id=$1) AS audits,
        (SELECT count(*)::int FROM platform.idempotency_keys WHERE property_id=$1) AS keys,
        (SELECT redacted_payload FROM platform.product_audit_events
         WHERE property_id=$1 AND redacted_payload->>'commandId'=$2) AS audit`,
      [PROPERTY, update.commandId],
    );
    expect(evidence.rows[0]).toMatchObject({ expenses: 2, audits: 4, keys: 4 });
    expect(evidence.rows[0].audit).toMatchObject({
      previous: { vendor: "Supplier" },
      next: { vendor: "Updated supplier" },
    });
  });

  it("archives once on the property-local day and rolls back incomplete evidence", async () => {
    const expenseId = crypto.randomUUID();
    await expect(repository.create(command(expenseId, "archive-source"))).resolves.toMatchObject({
      ok: true,
      outcome: "created",
    });
    await expect(
      repository.archive(archiveCommand("archive-stale", 2, expenseId)),
    ).resolves.toEqual({ ok: false, code: "revision_conflict" });
    for (const [index, timeZone] of ["Foo/Bar", "US/Eastern", null].entries()) {
      await admin.query(
        "UPDATE hotel_catalog.property_locations SET timezone=$1 WHERE property_id=$2",
        [timeZone, PROPERTY],
      );
      await expect(
        repository.archive(archiveCommand(`archive-zone-${index}`, 1, expenseId)),
      ).resolves.toEqual({ ok: false, code: "evidence_mismatch" });
    }
    await admin.query(
      "UPDATE hotel_catalog.property_locations SET timezone='America/Los_Angeles' WHERE property_id=$1",
      [PROPERTY],
    );
    const attempts = [
      archiveCommand("archive-a", 1, expenseId),
      archiveCommand("archive-b", 1, expenseId),
    ];
    const raced = await Promise.all(attempts.map((value) => repository.archive(value)));
    expect(raced.map((value) => (value.ok ? value.outcome : value.code)).sort()).toEqual([
      "archived",
      "revision_conflict",
    ]);
    const winnerIndex = raced.findIndex((value) => value.ok);
    const winner = attempts[winnerIndex]!;
    const archived = raced[winnerIndex]!;
    expect(archived).toMatchObject({
      ok: true,
      outcome: "archived",
      item: { id: winner.commandId, incurredOn: "2026-08-10", reversesExpenseId: expenseId },
    });
    await admin.query("UPDATE finance.expenses SET notes='later',revision=2 WHERE id=$1", [
      winner.commandId,
    ]);
    await expect(repository.archive(winner)).resolves.toMatchObject({
      ok: true,
      outcome: "replayed",
      item: { id: winner.commandId, revision: 1 },
    });
    await expect(
      repository.archive({ ...winner, commandId: crypto.randomUUID() }),
    ).resolves.toEqual({ ok: false, code: "idempotency_conflict" });
    await expect(
      repository.archive(archiveCommand("archive-repeated", 1, expenseId)),
    ).resolves.toEqual({ ok: false, code: "revision_conflict" });

    const history = await admin.query(
      `SELECT id::text,entry_kind AS "entryKind",incurred_on::text AS "incurredOn",
              reverses_expense_id::text AS "reversesExpenseId"
       FROM finance.expenses WHERE id=$1::uuid OR reverses_expense_id=$1::uuid ORDER BY created_at,id`,
      [expenseId],
    );
    expect(history.rows).toEqual([
      expect.objectContaining({ id: expenseId, entryKind: "expense", reversesExpenseId: null }),
      expect.objectContaining({
        id: winner.commandId,
        entryKind: "reversal",
        incurredOn: "2026-08-10",
        reversesExpenseId: expenseId,
      }),
    ]);
    const audit = await admin.query(
      `SELECT redacted_payload FROM platform.product_audit_events
       WHERE property_id=$1 AND action='finance.manual_expense.archive'
         AND redacted_payload->>'commandId'=$2`,
      [PROPERTY, winner.commandId],
    );
    expect(audit.rows).toHaveLength(1);
    expect(audit.rows[0].redacted_payload).toMatchObject({
      acceptedAt: ACCEPTED_AT,
      propertyTimeZone: "America/Los_Angeles",
      previous: { id: expenseId, entryKind: "expense" },
      next: { id: winner.commandId, entryKind: "reversal" },
    });

    const correctionSource = crypto.randomUUID();
    const correctionId = crypto.randomUUID();
    await repository.create(command(correctionSource, "archive-correction-source"));
    await expect(
      repository.update({
        ...mutation("archive-correction", 1, correctionSource, correctionId),
        incurredOn: "2026-08-11",
      }),
    ).resolves.toMatchObject({ ok: true, outcome: "corrected", item: { id: correctionId } });
    await expect(
      repository.archive(archiveCommand("archive-current-correction", 1, correctionId)),
    ).resolves.toMatchObject({
      ok: true,
      outcome: "archived",
      item: { reversesExpenseId: correctionId },
    });

    const rollbackExpense = crypto.randomUUID();
    await repository.create(command(rollbackExpense, "archive-rollback-source"));
    const rollbackArchive = archiveCommand("archive-rollback", 1, rollbackExpense);
    rollbackArchive.audit.actor.userId = crypto.randomUUID();
    await expect(repository.archive(rollbackArchive)).rejects.toMatchObject({ code: "23503" });
    const rollback = await admin.query(
      `SELECT
        (SELECT count(*)::int FROM finance.expenses WHERE reverses_expense_id=$1::uuid) AS reversals,
        (SELECT count(*)::int FROM platform.idempotency_keys
          WHERE property_id=$2::uuid AND operation='finance.manual_expense.archive'
            AND correlation_id='correlation-archive-rollback') AS keys,
        (SELECT count(*)::int FROM platform.product_audit_events
          WHERE property_id=$2::uuid AND redacted_payload->>'commandId'=$3) AS audits`,
      [rollbackExpense, PROPERTY, rollbackArchive.commandId],
    );
    expect(rollback.rows[0]).toEqual({ reversals: 0, keys: 0, audits: 0 });
  });

  async function cleanup() {
    await admin.query(`BEGIN; SET LOCAL session_replication_role=replica;
      DELETE FROM finance.expenses WHERE property_id IN ('${PROPERTY}','${OTHER_PROPERTY}');
      DELETE FROM platform.product_audit_events WHERE property_id IN ('${PROPERTY}','${OTHER_PROPERTY}');
      DELETE FROM platform.idempotency_keys WHERE property_id IN ('${PROPERTY}','${OTHER_PROPERTY}');
      DELETE FROM platform.media_objects WHERE property_id IN ('${PROPERTY}','${OTHER_PROPERTY}')
        AND purpose='finance.expense.receipt';
      DELETE FROM finance.expense_categories WHERE property_id IN ('${PROPERTY}','${OTHER_PROPERTY}');
      DELETE FROM pms.property_pricing_settings WHERE property_id IN ('${PROPERTY}','${OTHER_PROPERTY}');
      DELETE FROM hotel_catalog.property_locations WHERE property_id IN ('${PROPERTY}','${OTHER_PROPERTY}');
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

function mutation(
  key: string,
  expectedRevision: number,
  expenseId = EXPENSE,
  commandId = crypto.randomUUID(),
) {
  return { ...command(commandId, key), expectedRevision, expenseId };
}

function archiveCommand(
  key: string,
  expectedRevision: number,
  expenseId: string,
  commandId = crypto.randomUUID(),
) {
  const input = command(commandId, key);
  return {
    commandId,
    idempotencyKey: input.idempotencyKey,
    propertyId: input.propertyId,
    expectedRevision,
    expenseId,
    audit: input.audit,
  };
}
