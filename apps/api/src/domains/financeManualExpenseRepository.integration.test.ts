import { normalizeFinanceExpenseAmount } from "@vayada/domain-finance";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import {
  createPgPlatformMediaCleanupStore,
  runPlatformMediaCleanupJobs,
} from "../jobs/platformMediaCleanup.js";
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
const ACCEPTED_AT = "2026-08-11T00:30:00.000Z";
if (URL && !/(^|[_-])(test|verify)([_-]|$)/i.test(new globalThis.URL(URL).pathname))
  throw new Error("Unsafe test database");

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
      INSERT INTO hotel_catalog.property_locations (property_id,timezone) VALUES ('${PROPERTY}','America/Los_Angeles'),('${OTHER_PROPERTY}','Europe/Berlin');
      INSERT INTO pms.property_pricing_settings (property_id,currency) VALUES ('${PROPERTY}','EUR'),('${OTHER_PROPERTY}','USD');
      INSERT INTO finance.expense_categories (id,property_id,name,color,archived_at) VALUES ('${CATEGORY}','${PROPERTY}','Operations','#123456',NULL),
        ('${OTHER_CATEGORY}','${OTHER_PROPERTY}','Other','#654321',NULL),
        ('${ARCHIVED_CATEGORY}','${PROPERTY}','Archived','#111111',now());
      INSERT INTO platform.media_objects (id,bucket,storage_key,visibility,purpose,property_id,resource_product,resource_type,resource_id,lifecycle_status,retained_until,created_by_user_id)
        VALUES ('${RECEIPT}','test','private/finance/manual-expense-receipt.webp','private','finance.expense.receipt','${PROPERTY}',
         'finance','expense','${EXPENSE}','staged','2026-08-11T01:30:00Z','${ACTOR}'),('12100000-0000-4000-8000-000000000009','test','wrong-purpose','private','pms.messaging.attachment','${PROPERTY}','pms','expense','${EXPENSE}','active',NULL,'${ACTOR}')`);
  });

  it("archives exactly once with canonical timezone and confidential evidence", async () => {
    const sourceId = crypto.randomUUID();
    await expect(repository.create(command(sourceId, "archive-source"))).resolves.toMatchObject({
      ok: true,
      outcome: "created",
    });
    // prettier-ignore
    await expect(repository.archive({ ...archiveCommand("archive-cross-property", 1, sourceId), propertyId: OTHER_PROPERTY })).resolves.toEqual({ ok: false, code: "not_found" });
    // prettier-ignore
    expect((await admin.query(`SELECT (SELECT count(*)::int FROM finance.expenses WHERE reverses_expense_id=$1) AS reversals,(SELECT count(*)::int FROM platform.idempotency_keys WHERE property_id=$2 AND operation='finance.manual_expense.archive') AS keys,(SELECT count(*)::int FROM platform.product_audit_events WHERE property_id=$2 AND action='finance.manual_expense.archive') AS audits`, [sourceId, OTHER_PROPERTY])).rows[0]).toEqual({ reversals: 0, keys: 0, audits: 0 });
    // prettier-ignore
    await expect(repository.archive(archiveCommand("archive-stale", 2, sourceId))).resolves.toEqual({ ok: false, code: "revision_conflict" });
    await admin.query("DELETE FROM hotel_catalog.property_locations WHERE property_id=$1", [
      PROPERTY,
    ]);
    // prettier-ignore
    await expect(repository.archive(archiveCommand("archive-zone-missing", 1, sourceId))).resolves.toEqual({ ok: false, code: "evidence_mismatch" });
    for (const [index, timeZone] of ["Foo/Bar", "US/Eastern"].entries()) {
      await admin.query(
        `INSERT INTO hotel_catalog.property_locations (property_id,timezone) VALUES ($1,$2)
         ON CONFLICT (property_id) DO UPDATE SET timezone=EXCLUDED.timezone`,
        [PROPERTY, timeZone],
      );
      // prettier-ignore
      await expect(repository.archive(archiveCommand(`archive-zone-${index}`, 1, sourceId))).resolves.toEqual({ ok: false, code: "evidence_mismatch" });
    }
    await admin.query(
      "UPDATE hotel_catalog.property_locations SET timezone='America/Los_Angeles' WHERE property_id=$1",
      [PROPERTY],
    );
    const attempts = [
      archiveCommand("archive-a", 1, sourceId),
      archiveCommand("archive-b", 1, sourceId),
    ];
    attempts[0] = {
      ...attempts[0]!,
      commandId: attempts[0]!.commandId.toUpperCase(),
      propertyId: PROPERTY.toUpperCase(),
      expenseId: sourceId.toUpperCase(),
    };
    const raced = await Promise.all(attempts.map((value) => repository.archive(value)));
    // prettier-ignore
    expect(raced.map((value) => value.ok ? value.outcome : value.code).sort()).toEqual(["archived", "revision_conflict"]);
    const winnerIndex = raced.findIndex((value) => value.ok);
    const winner = attempts[winnerIndex]!;
    const archiveId = winner.commandId.toLowerCase();
    expect(raced[winnerIndex]).toMatchObject({
      ok: true,
      outcome: "archived",
      item: {
        id: archiveId,
        incurredOn: "2026-08-10",
        sourceKey: `finance.manual_expense.archive:${archiveId}`,
        reversesExpenseId: sourceId,
        revision: 1,
      },
    });
    await admin.query("UPDATE finance.expenses SET notes='later',revision=2 WHERE id=$1", [
      archiveId,
    ]);
    // prettier-ignore
    await expect(repository.archive(winner)).resolves.toMatchObject({ ok: true, outcome: "replayed", item: { id: archiveId, revision: 1 } });
    // prettier-ignore
    await expect(repository.archive({ ...winner, commandId: crypto.randomUUID() })).resolves.toEqual({ ok: false, code: "idempotency_conflict" });
    // prettier-ignore
    await expect(repository.archive(archiveCommand("archive-repeat", 1, sourceId))).resolves.toEqual({ ok: false, code: "revision_conflict" });
    // prettier-ignore
    await expect(repository.archive({ ...archiveCommand("archive-hostile", 1, sourceId), unexpected: "private" } as never)).resolves.toEqual({ ok: false, code: "invalid_command" });

    const evidence = await admin.query(
      `SELECT (SELECT jsonb_agg(jsonb_build_object('id',id::text,'kind',entry_kind,'reverses',reverses_expense_id::text) ORDER BY created_at,id)
         FROM finance.expenses WHERE id=$1 OR reverses_expense_id=$1) AS history,
        jsonb_build_object('key',audit_key,'redacted',redacted_payload,'private',private_payload,'metadata',audit_metadata) AS audit
       FROM platform.product_audit_events WHERE action='finance.manual_expense.archive' AND target_resource_id=$2`,
      [sourceId, archiveId],
    );
    expect(evidence.rows[0].history).toEqual([
      { id: sourceId, kind: "expense", reverses: null },
      { id: archiveId, kind: "reversal", reverses: sourceId },
    ]);
    // prettier-ignore
    expect(evidence.rows[0].audit).toMatchObject({ key: expect.stringContaining(`.property.${PROPERTY}.expense.${archiveId}.`),
      redacted: { commandId: archiveId, previousExpenseId: sourceId, expenseId: archiveId, outcome: "archived", revision: 1 },
      private: { reason: "test", acceptedAt: ACCEPTED_AT, propertyTimeZone: "America/Los_Angeles", previous: { id: sourceId }, next: { id: archiveId, entryKind: "reversal" } },
      metadata: { requestId: winner.audit.requestId, actorOrganizationId: winner.audit.actor.organizationId.toLowerCase() } });
    expect(evidence.rows[0].audit.redacted).not.toHaveProperty("reason");
    const correctionSource = crypto.randomUUID();
    const correctionId = crypto.randomUUID();
    await repository.create(command(correctionSource, "archive-correction-source"));
    // prettier-ignore
    await expect(repository.update({ ...mutation("archive-correction", 1, correctionSource, correctionId), incurredOn: "2026-08-11" })).resolves.toMatchObject({ ok: true, outcome: "corrected" });
    // prettier-ignore
    await expect(repository.archive(archiveCommand("archive-current-correction", 1, correctionId))).resolves.toMatchObject({ ok: true, outcome: "archived", item: { reversesExpenseId: correctionId } });

    const rollbackSource = crypto.randomUUID();
    await repository.create(command(rollbackSource, "archive-rollback-source"));
    const rollback = archiveCommand("archive-rollback", 1, rollbackSource);
    rollback.audit.actor.userId = crypto.randomUUID();
    await expect(repository.archive(rollback)).rejects.toMatchObject({ code: "23503" });
    const rolledBack = await admin.query(
      `SELECT (SELECT count(*)::int FROM finance.expenses WHERE reverses_expense_id=$1) AS reversals,
        (SELECT count(*)::int FROM platform.idempotency_keys WHERE operation='finance.manual_expense.archive' AND correlation_id=$2) AS keys,
        (SELECT count(*)::int FROM platform.product_audit_events WHERE action='finance.manual_expense.archive' AND causation_id=$3) AS audits`,
      [rollbackSource, rollback.audit.correlationId, rollback.audit.requestId],
    );
    expect(rolledBack.rows[0]).toEqual({ reversals: 0, keys: 0, audits: 0 });
    await admin.query(
      `UPDATE platform.idempotency_keys SET idempotency_metadata=jsonb_set(idempotency_metadata,'{result,item,unexpected}','true')
       WHERE operation='finance.manual_expense.archive' AND response_resource_id=$1`,
      [archiveId],
    );
    await expect(repository.archive(winner)).rejects.toThrow("archive replay evidence");
    const commandRaceSource = crypto.randomUUID();
    await repository.create(command(commandRaceSource, "archive-update-source"));
    const archiveRace = archiveCommand("archive-update-archive", 1, commandRaceSource);
    // prettier-ignore
    const updateRace = { ...mutation("archive-update-update", 1, commandRaceSource), notes: "late update" };
    // prettier-ignore
    await admin.query(`BEGIN; SELECT pg_advisory_xact_lock(hashtextextended('finance.manual_expense|${PROPERTY}|${commandRaceSource}',0))`);
    // prettier-ignore
    const pendingRace = Promise.all([repository.archive(archiveRace), repository.update(updateRace)]);
    let waiters = 0;
    for (const deadline = Date.now() + 1_500; Date.now() < deadline && waiters < 2; ) {
      // prettier-ignore
      const staged = await admin.query<{ waiters: number }>(`SELECT count(*)::int AS waiters FROM pg_locks waiter JOIN pg_locks holder USING (locktype,database,classid,objid,objsubid) WHERE waiter.locktype='advisory' AND NOT waiter.granted AND holder.granted AND holder.pid=pg_backend_pid() AND waiter.pid<>holder.pid`);
      waiters = staged.rows[0]?.waiters ?? 0;
      if (waiters < 2) await admin.query("SELECT pg_sleep(0.01)");
    }
    await admin.query("ROLLBACK");
    const commandRace = await pendingRace;
    expect(waiters).toBe(2);
    expect(commandRace.filter((value) => value.ok)).toHaveLength(1);
    // prettier-ignore
    expect(commandRace.find((value) => !value.ok)).toEqual({ ok: false, code: "revision_conflict" });
    // prettier-ignore
    await admin.query(`BEGIN; SELECT pg_advisory_xact_lock(hashtextextended('finance.manual_expense|${PROPERTY}|${commandRaceSource}',0))`);
    // prettier-ignore
    const timeouts = await Promise.all([repository.archive(archiveCommand("archive-timeout", 1, commandRaceSource)), repository.update({ ...mutation("update-timeout", 1, commandRaceSource), notes: "late" })]);
    await admin.query("ROLLBACK");
    // prettier-ignore
    expect(timeouts).toEqual([{ ok: false, code: "write_unavailable" }, { ok: false, code: "write_unavailable" }]);
    await admin.query(`BEGIN; SET LOCAL session_replication_role=replica;
      DELETE FROM finance.expenses WHERE property_id='${PROPERTY}';
      DELETE FROM platform.product_audit_events WHERE property_id='${PROPERTY}';
      DELETE FROM platform.idempotency_keys WHERE property_id='${PROPERTY}'; COMMIT`);
  }, 15_000);
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
    await expect(
      admin.query(
        "SELECT lifecycle_status,retained_until IS NOT NULL AS retained FROM platform.media_objects WHERE id=$1",
        [RECEIPT],
      ),
    ).resolves.toMatchObject({ rows: [{ lifecycle_status: "staged", retained: true }] });
    await admin.query("BEGIN");
    await admin.query("SELECT id FROM platform.media_objects WHERE id=$1 FOR UPDATE", [RECEIPT]);
    // prettier-ignore
    await expect(repository.create({ ...input, idempotencyKey: "receipt-timeout" })).resolves.toEqual({ ok: false, code: "write_unavailable" });
    await admin.query("ROLLBACK");
    // prettier-ignore
    await admin.query(`BEGIN; SELECT id FROM hotel_catalog.properties WHERE id='${PROPERTY}' FOR KEY SHARE`);
    // prettier-ignore
    const raced = await Promise.all([repository.create(input), repository.create({ ...input, propertyId: PROPERTY.toUpperCase() })]);
    await admin.query("ROLLBACK");
    // prettier-ignore
    expect(raced.map((result) => result.ok ? result.outcome : result.code).sort()).toEqual(["created", "replayed"]);
    // prettier-ignore
    for (const result of raced) expect(result).toMatchObject({ ok: true, item: { id: EXPENSE, origin: "manual", revision: 1, amount: { amount: "10.0000" } } });
    await expect(
      admin.query(
        "SELECT lifecycle_status,retained_until FROM platform.media_objects WHERE id=$1",
        [RECEIPT],
      ),
    ).resolves.toMatchObject({ rows: [{ lifecycle_status: "active", retained_until: null }] });
    await expect(repository.receipt(PROPERTY, EXPENSE)).resolves.toMatchObject({
      mediaId: RECEIPT,
      propertyId: PROPERTY,
      resourceId: EXPENSE,
      purpose: "finance.expense.receipt",
      lifecycleStatus: "active",
      storageKey: "private/finance/manual-expense-receipt.webp",
    });
    await expect(repository.receipt(OTHER_PROPERTY, EXPENSE)).resolves.toBeNull();
    // prettier-ignore
    await admin.query("UPDATE finance.expenses SET notes='later',revision=2 WHERE id=$1", [EXPENSE]);
    // prettier-ignore
    await expect(repository.create(input)).resolves.toMatchObject({ ok: true, outcome: "replayed", item: { id: EXPENSE, revision: 1 } });
    // prettier-ignore
    await expect(repository.create({ ...input, commandId: crypto.randomUUID() })).resolves.toEqual({ ok: false, code: "idempotency_conflict" });
    // prettier-ignore
    await expect(repository.create({ ...input, idempotencyKey: "duplicate-id" })).resolves.toEqual({ ok: false, code: "idempotency_conflict" });
    // prettier-ignore
    expect((await Promise.all([repository.create({ ...input, idempotencyKey: "same-command-other-key" }), repository.create({ ...input, commandId: crypto.randomUUID(), idempotencyKey: "same-receipt-other-command" })])).map((result) => result.ok ? result.outcome : result.code).sort()).toEqual(["evidence_mismatch", "idempotency_conflict"]);
    const update = { ...mutation("update", 2), notes: "Updated note" };
    // prettier-ignore
    await expect(repository.update(update)).resolves.toMatchObject({ ok: true, outcome: "updated", item: { id: EXPENSE, revision: 3 } });
    // prettier-ignore
    await expect(repository.update(update)).resolves.toMatchObject({ ok: true, outcome: "replayed" });
    // prettier-ignore
    await expect(repository.update({ ...update, notes: "Changed reuse" })).resolves.toEqual({ ok: false, code: "idempotency_conflict" });
    // prettier-ignore
    await admin.query(`BEGIN; SELECT id FROM hotel_catalog.properties WHERE id='${PROPERTY}' FOR KEY SHARE`);
    // prettier-ignore
    const race = { ...mutation("race", 3), propertyId: PROPERTY.toUpperCase(), notes: "Concurrent" };
    // prettier-ignore
    const updateRace = await Promise.all([repository.update(race), repository.update({ ...race, propertyId: PROPERTY })]);
    await admin.query("ROLLBACK");
    // prettier-ignore
    expect(updateRace.map((value) => value.ok ? value.outcome : value.code).sort()).toEqual(["replayed", "updated"]);
    // prettier-ignore
    for (const [index, patch] of [{ paymentStatus: "unpaid", paidOn: "2026-08-11" }, { vendor: null }, { incurredOn: null }].entries())
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
    const rollbackExpense = crypto.randomUUID(),
      rollbackReceipt = crypto.randomUUID(),
      expiredExpense = crypto.randomUUID(),
      expiredReceipt = crypto.randomUUID();
    await admin.query(
      `INSERT INTO platform.media_objects (id,bucket,storage_key,visibility,purpose,property_id,resource_product,resource_type,resource_id,lifecycle_status,retained_until,created_by_user_id) VALUES ($1,'test',$2,'private','finance.expense.receipt',$3,'finance','expense',$4,'staged','2026-08-11T01:30:00Z',$5),($6,'test',$7,'private','finance.expense.receipt',$3,'finance','expense',$8,'staged','2026-08-11T00:29:00Z',$5)`,
      [
        rollbackReceipt,
        `private/finance/${rollbackReceipt}/receipt.webp`,
        PROPERTY,
        rollbackExpense,
        ACTOR,
        expiredReceipt,
        `private/finance/${expiredReceipt}/receipt.webp`,
        expiredExpense,
      ],
    );
    const receiptRollback = {
      ...command(rollbackExpense, "receipt-rollback"),
      receiptMediaId: rollbackReceipt,
    };
    receiptRollback.audit.actor.userId = crypto.randomUUID();
    await expect(repository.create(receiptRollback)).rejects.toMatchObject({ code: "23503" });
    await expect(
      admin.query(
        "SELECT lifecycle_status,retained_until IS NOT NULL AS retained FROM platform.media_objects WHERE id=$1",
        [rollbackReceipt],
      ),
    ).resolves.toMatchObject({ rows: [{ lifecycle_status: "staged", retained: true }] });
    await expect(repository.receipt(PROPERTY, rollbackExpense)).resolves.toBeNull();
    // prettier-ignore
    await expect(repository.create({ ...command(expiredExpense, "expired-receipt"), receiptMediaId: expiredReceipt })).resolves.toEqual({ ok: false, code: "evidence_mismatch" });
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
        (SELECT jsonb_build_object('key',audit_key,'private',private_payload) FROM platform.product_audit_events WHERE property_id=$1 AND causation_id=$3) AS "correctionAudit",
        (SELECT jsonb_build_object('redacted',redacted_payload,'private',private_payload,'metadata',audit_metadata) FROM platform.product_audit_events WHERE property_id=$1 AND causation_id=$2) AS audit`,
      [PROPERTY, update.audit.requestId, correct.audit.requestId],
    );
    // prettier-ignore
    expect(evidence.rows[0]).toMatchObject({ expenses: 2, audits: 7, keys: 7, correctionAudit: { key: expect.stringContaining(`.property.${PROPERTY}.`), private: { next: { receiptMediaId: goodReceipt } } } });
    // prettier-ignore
    expect(evidence.rows[0].audit).toMatchObject({ redacted: { commandId: update.commandId, outcome: "updated" },
      private: { reason: "test", previous: { notes: "later" }, next: { notes: "Updated note" } },
      metadata: { requestId: update.audit.requestId, actorOrganizationId: update.audit.actor.organizationId } });
    const cleanup = createPgPlatformMediaCleanupStore({
      connectionString: URL!,
      objectDeleter: {
        deleteObject: vi.fn(async () => undefined),
        deletePrefix: vi.fn(async () => undefined),
      },
    });
    await expect(
      runPlatformMediaCleanupJobs(cleanup, {
        now: new Date("2026-08-11T02:00:00Z"),
        run: ["privateAttachmentRetention"],
      }),
    ).resolves.toMatchObject({ scanned: 2, applied: 2, failed: 0 });
    await cleanup.close();
    await expect(
      admin.query(
        "SELECT count(*)::int AS deleted FROM platform.media_objects WHERE id=ANY($1::uuid[]) AND lifecycle_status='deleted'",
        [[rollbackReceipt, expiredReceipt]],
      ),
    ).resolves.toMatchObject({ rows: [{ deleted: 2 }] });
  }, 15_000);

  async function cleanup() {
    await admin.query(`BEGIN; SET LOCAL session_replication_role=replica;
      DELETE FROM finance.expenses WHERE property_id IN ('${PROPERTY}','${OTHER_PROPERTY}');
      DELETE FROM platform.product_audit_events WHERE property_id IN ('${PROPERTY}','${OTHER_PROPERTY}');
      DELETE FROM platform.idempotency_keys WHERE property_id IN ('${PROPERTY}','${OTHER_PROPERTY}');
      DELETE FROM platform.media_objects WHERE id IN ('${RECEIPT}','12100000-0000-4000-8000-000000000009');
      DELETE FROM platform.media_objects WHERE property_id IN ('${PROPERTY}','${OTHER_PROPERTY}') AND purpose='finance.expense.receipt';
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

// prettier-ignore
function mutation(key: string, expectedRevision: number, expenseId = EXPENSE,
  commandId: string = crypto.randomUUID()) {
  const base = command(commandId, key);
  return { commandId, idempotencyKey: key, propertyId: PROPERTY, audit: base.audit,
    expectedRevision, expenseId };
}

function archiveCommand(key: string, expectedRevision: number, expenseId: string) {
  const base = command(crypto.randomUUID(), key);
  return {
    commandId: base.commandId,
    idempotencyKey: key,
    propertyId: PROPERTY,
    expectedRevision,
    expenseId,
    audit: base.audit,
  };
}
