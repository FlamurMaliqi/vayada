import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

// prettier-ignore
import { createPgFinanceExpenseCategoryRepository, type ArchiveFinanceExpenseCategoryCommand,
  type CreateFinanceExpenseCategoryCommand, type UpdateFinanceExpenseCategoryCommand } from "./financeExpenseCategoryRepository.js";

const URL = process.env["TEST_DATABASE_URL"];
const ACTOR = "12120000-0000-4000-8000-000000000001";
const PROPERTY_A = "12120000-0000-4000-8000-000000000002";
const PROPERTY_B = "12120000-0000-4000-8000-000000000003";
const MISSING_PROPERTY = "12120000-0000-4000-8000-000000000004";
const ORGANIZATION = "12120000-0000-4000-8000-000000000005";
if (URL && !/(^|[_-])(test|verify)([_-]|$)/i.test(new globalThis.URL(URL).pathname))
  throw new Error("Unsafe test database");

describe.skipIf(!URL)("PostgreSQL Finance expense category repository", () => {
  const admin = new pg.Client({ connectionString: URL ?? "postgresql://disabled" });
  const repository = createPgFinanceExpenseCategoryRepository(URL ?? "postgresql://disabled");

  beforeAll(async () => admin.connect());
  beforeEach(async () => {
    await cleanup();
    await admin.query(
      `INSERT INTO identity.users (id,email,name,status)
         VALUES ('${ACTOR}','category@example.test','Category','active');
       INSERT INTO hotel_catalog.properties (id,public_id,display_name) VALUES
         ('${PROPERTY_A}','category-a','Category A'),
         ('${PROPERTY_B}','category-b','Category B');
       INSERT INTO pms.property_pricing_settings (property_id,currency) VALUES ('${PROPERTY_A}','EUR'),('${PROPERTY_B}','USD')`,
    );
  });
  afterAll(async () => {
    await repository.close();
    await cleanup();
    await admin.end();
  });

  it("creates custom categories and lists only one property in display order", async () => {
    await repository.create(command("later", PROPERTY_A, "Later", "#ABCDEF", 30));
    const first = await repository.create(command("first", PROPERTY_A, "First", "#123456", 5));
    await repository.create(command("other", PROPERTY_B, "Other property", "#654321", 1));

    await expect(repository.list(PROPERTY_A)).resolves.toMatchObject([
      { name: "First", systemKey: null, archived: false, revision: 1 },
      { name: "Later", systemKey: null, archived: false, revision: 1 },
    ]);
    const audit = await admin.query<{ count: number }>(
      `SELECT count(*)::int AS count FROM platform.product_audit_events
       WHERE action='finance.expense_category.create' AND property_id=$1
         AND actor_user_id=$2 AND correlation_id='correlation-first'
         AND redacted_payload->>'commandId'='12150000-0000-4000-8000-000000000006'
         AND target_resource_id=$3 AND private_payload->>'reason'='test'
         AND audit_metadata @> '{"requestId":"request-first","requestedAt":"2026-01-01T00:00:00Z","actorOrganizationId":"${ORGANIZATION}"}'`,
      [PROPERTY_A, ACTOR, first.status === "created" ? first.category.id : ""],
    );
    expect(audit.rows[0]?.count).toBe(1);
  });

  it("replays matching input, conflicts changed reuse, and leaves not-found clean", async () => {
    const input = command("same", PROPERTY_A, "Utilities extra", "#00AAFF", 80);
    const created = await repository.create(input);
    input.commandId = "12120000-0000-4000-8000-000000000007";
    await expect(repository.create(input)).resolves.toEqual({
      status: "replayed",
      category: created.status === "created" ? created.category : undefined,
    });
    const tampered = await admin.query(
      `UPDATE platform.idempotency_keys SET idempotency_metadata=jsonb_set(idempotency_metadata,'{result,category,unexpected}','true')
       WHERE operation_scope='finance' AND operation='finance.expense_category.create'
         AND property_id='${PROPERTY_A}' AND correlation_id='correlation-same'`,
    );
    expect(tampered.rowCount).toBe(1);
    await expect(repository.create(input)).rejects.toThrow("replay evidence");
    await expect(
      repository.create(command("same", PROPERTY_A, "Changed", "#00AAFF", 80)),
    ).resolves.toEqual({ status: "conflict", reason: "idempotency_key_reused" });
    await expect(
      repository.create(command("missing", MISSING_PROPERTY, "Missing", "#00AAFF", 1)),
    ).resolves.toEqual({ status: "not_found" });
    const leftovers = await admin.query<{ count: number }>(
      `SELECT count(*)::int AS count FROM platform.idempotency_keys
       WHERE property_id=$1`,
      [MISSING_PROPERTY],
    );
    expect(leftovers.rows[0]?.count).toBe(0);
  });

  it("rolls back the category and idempotency reservation when audit persistence fails", async () => {
    const input = command("rollback", PROPERTY_B, "Rollback", "#FEDCBA", 5);
    input.audit.actor = { kind: "user", userId: MISSING_PROPERTY, organizationId: ORGANIZATION };
    await expect(repository.create(input)).rejects.toMatchObject({ code: "23503" });
    await expect(repository.list(PROPERTY_B)).resolves.toEqual([]);
    const leftovers = await admin.query<{ count: number }>(
      `SELECT count(*)::int AS count FROM platform.idempotency_keys
       WHERE property_id=$1`,
      [PROPERTY_B],
    );
    expect(leftovers.rows[0]?.count).toBe(0);
  });

  it("rejects invalid audit identity and oversized sort order before writing", async () => {
    const invalidAudit = command("audit", PROPERTY_A, "Audit", "#FEDCBA", 5);
    invalidAudit.audit.actor = { kind: "user", userId: undefined!, organizationId: ORGANIZATION };
    await expect(repository.create(invalidAudit)).rejects.toThrow("contract validation");
    invalidAudit.audit.actor = { kind: "user", userId: ACTOR, organizationId: ORGANIZATION };
    invalidAudit.audit.requestedAt = "0000-01-01T00:00:00Z";
    await expect(repository.create(invalidAudit)).rejects.toThrow("contract validation");
    invalidAudit.audit.requestedAt = "2026-01-01T00:00:00Z";
    // prettier-ignore
    const targets = [(value: typeof invalidAudit) => value, (value: typeof invalidAudit) => value.audit,
      (value: typeof invalidAudit) => value.audit.actor];
    for (const target of targets) {
      const hostile = command("hostile", PROPERTY_A, "Hostile", "#FEDCBA", 5);
      Object.assign(target(hostile), { unexpected: "secret" });
      await expect(repository.create(hostile)).rejects.toThrow("contract validation");
    }
    await expect(
      repository.create(command("sort", PROPERTY_A, "Sort", "#FEDCBA", 2_147_483_648)),
    ).rejects.toThrow("contract validation");
    await expect(repository.list(PROPERTY_A)).resolves.toEqual([]);
    const evidence = await admin.query<{ count: number }>(
      `SELECT ((SELECT count(*) FROM platform.idempotency_keys WHERE property_id=$1) +
               (SELECT count(*) FROM platform.product_audit_events WHERE property_id=$1))::int AS count`,
      [PROPERTY_A],
    );
    expect(evidence.rows[0]?.count).toBe(0);
  });

  it("updates system presentation in scope and replays only matching input", async () => {
    const categoryId = await systemCategory(PROPERTY_A);
    const input = updateCommand("system", PROPERTY_A, categoryId, 1, {
      name: "Team",
      color: "#111111",
      sortOrder: 2,
    });
    const updated = await repository.update(input);
    expect(updated).toMatchObject({
      status: "updated",
      category: { systemKey: "staff", name: "Team", revision: 2 },
    });
    input.commandId = "12150000-0000-4000-8000-000000000007";
    await expect(repository.update(input)).resolves.toMatchObject({ status: "replayed" });
    await expect(
      repository.update(updateCommand("system", PROPERTY_A, categoryId, 1, { name: "Changed" })),
    ).resolves.toEqual({ status: "conflict", reason: "idempotency_key_reused" });
    await expect(
      repository.update(updateCommand("cross", PROPERTY_B, categoryId, 2, { name: "Leaked" })),
    ).resolves.toEqual({ status: "not_found" });
    const audit = await admin.query<{ count: number }>(
      `SELECT count(*)::int AS count FROM platform.product_audit_events
       WHERE action='finance.expense_category.update' AND property_id=$1
         AND redacted_payload->'previous'->>'systemKey'='staff'
         AND redacted_payload->'category'->>'name'='Team'
         AND NOT (redacted_payload ?| ARRAY['reason','requestedAt','actorOrganizationId']) AND private_payload->>'reason'='test'
         AND audit_metadata @> '{"requestId":"request-system","requestedAt":"2026-01-01T00:00:00Z","actorOrganizationId":"${ORGANIZATION}"}'`,
      [PROPERTY_A],
    );
    expect(audit.rows[0]?.count).toBe(1);
  });

  it("enforces one expected revision across concurrent updates", async () => {
    const categoryId = await customCategory("concurrency", PROPERTY_A);
    const results = await Promise.all([
      repository.update(updateCommand("left", PROPERTY_A, categoryId, 1, { name: "Left" })),
      repository.update(updateCommand("right", PROPERTY_A, categoryId, 1, { name: "Right" })),
    ]);
    expect(results.map(({ status }) => status).sort()).toEqual(["conflict", "updated"]);
    expect(results).toContainEqual({ status: "conflict", reason: "revision_conflict" });
    await expect(repository.list(PROPERTY_A)).resolves.toMatchObject([{ revision: 2 }]);
    // prettier-ignore
    await admin.query("UPDATE finance.expense_categories SET revision=2147483647 WHERE id=$1", [categoryId]);
    // prettier-ignore
    await expect(repository.update(updateCommand("max", PROPERTY_A, categoryId, 2_147_483_647, { name: "Overflow" }))).resolves.toEqual({ status: "conflict", reason: "revision_exhausted" });
  });

  it("archives without deleting history and replays the original result", async () => {
    const categoryId = await customCategory("history", PROPERTY_A);
    await admin.query(
      `INSERT INTO finance.expenses (property_id,category_id,origin,incurred_on,vendor,amount,currency)
       VALUES ($1,$2,'manual','2026-08-01','Vendor',10,'EUR')`,
      [PROPERTY_A, categoryId],
    );
    const input = archiveCommand("archive", PROPERTY_A, categoryId, 1);
    await expect(repository.archive(input)).resolves.toMatchObject({
      status: "updated",
      category: { archived: true, revision: 2 },
    });
    input.commandId = "12150000-0000-4000-8000-000000000007";
    await expect(repository.archive(input)).resolves.toMatchObject({ status: "replayed" });
    await expect(
      repository.archive(archiveCommand("archive", PROPERTY_A, categoryId, 2)),
    ).resolves.toEqual({ status: "conflict", reason: "idempotency_key_reused" });
    await expect(
      repository.archive(archiveCommand("already", PROPERTY_A, categoryId, 2)),
    ).resolves.toEqual({ status: "conflict", reason: "already_archived" });
    const history = await admin.query<{ categories: number; expenses: number }>(
      `SELECT (SELECT count(*)::int FROM finance.expense_categories WHERE id=$1) AS categories,
              (SELECT count(*)::int FROM finance.expenses WHERE category_id=$1) AS expenses`,
      [categoryId],
    );
    expect(history.rows[0]).toEqual({ categories: 1, expenses: 1 });
  });

  it("blocks active automation and rolls back when update audit persistence fails", async () => {
    const systemId = await systemCategory(PROPERTY_B);
    await admin.query(
      `INSERT INTO finance.recurring_expense_rules (property_id,category_id,cadence,starts_on,next_due_on,vendor,amount,currency)
       VALUES ($1,$2,'monthly','2026-08-01','2026-08-01','Vendor',10,'USD')`,
      [PROPERTY_B, systemId],
    );
    await expect(
      repository.archive(archiveCommand("blocked", PROPERTY_B, systemId, 1)),
    ).resolves.toEqual({ status: "blocked", reason: "active_recurring_rule" });
    await expect(repository.list(PROPERTY_B)).resolves.toMatchObject([
      { id: systemId, archived: false, revision: 1 },
    ]);

    const categoryId = await customCategory("rollback-update", PROPERTY_A);
    const input = updateCommand("rollback-update", PROPERTY_A, categoryId, 1, { name: "Lost" });
    input.audit.actor = { kind: "user", userId: MISSING_PROPERTY, organizationId: ORGANIZATION };
    await expect(repository.update(input)).rejects.toMatchObject({ code: "23503" });
    await expect(repository.list(PROPERTY_A)).resolves.toMatchObject([
      { id: categoryId, name: "rollback-update", revision: 1 },
    ]);
    const residue = await admin.query<{ count: number }>(
      `SELECT ((SELECT count(*) FROM platform.idempotency_keys
                 WHERE property_id IN ($1,$2) AND operation<>'finance.expense_category.create') +
               (SELECT count(*) FROM platform.product_audit_events
                 WHERE property_id IN ($1,$2) AND action<>'finance.expense_category.create'))::int AS count`,
      [PROPERTY_A, PROPERTY_B],
    );
    expect(residue.rows[0]?.count).toBe(0);
  });

  async function cleanup() {
    await admin.query(
      `BEGIN; SET LOCAL session_replication_role = replica;
       DELETE FROM platform.product_audit_events
         WHERE property_id IN ('${PROPERTY_A}','${PROPERTY_B}');
       DELETE FROM platform.idempotency_keys
         WHERE property_id IN ('${PROPERTY_A}','${PROPERTY_B}');
       DELETE FROM finance.expenses WHERE property_id IN ('${PROPERTY_A}','${PROPERTY_B}');
       DELETE FROM finance.recurring_expense_rules WHERE property_id IN ('${PROPERTY_A}','${PROPERTY_B}');
       DELETE FROM finance.expense_categories
         WHERE property_id IN ('${PROPERTY_A}','${PROPERTY_B}');
       DELETE FROM pms.property_pricing_settings WHERE property_id IN ('${PROPERTY_A}','${PROPERTY_B}');
       DELETE FROM hotel_catalog.properties
         WHERE id IN ('${PROPERTY_A}','${PROPERTY_B}');
       DELETE FROM identity.users WHERE id='${ACTOR}'; COMMIT`,
    );
  }

  async function systemCategory(propertyId: string): Promise<string> {
    const result = await admin.query<{ id: string }>(
      `INSERT INTO finance.expense_categories (property_id,system_key,name,color,sort_order) VALUES ($1,'staff','Staff','#6366F1',10) RETURNING id::text`,
      [propertyId],
    );
    return result.rows[0]!.id;
  }

  async function customCategory(key: string, propertyId: string): Promise<string> {
    const result = await repository.create(command(key, propertyId, key, "#123456", 5));
    if (result.status !== "created") throw new Error("category setup failed");
    return result.category.id;
  }
});

// prettier-ignore
function command(key: string, propertyId: string, name: string, color: string, sortOrder: number): CreateFinanceExpenseCategoryCommand {
  return {
    ...context(key, propertyId),
    name,
    color,
    sortOrder,
  };
}

function updateCommand(
  key: string,
  propertyId: string,
  categoryId: string,
  expectedRevision: number,
  fields: Partial<{ name: string; color: string; sortOrder: number }>,
): UpdateFinanceExpenseCategoryCommand {
  return { ...context(key, propertyId), categoryId, expectedRevision, ...fields };
}

function archiveCommand(
  key: string,
  propertyId: string,
  categoryId: string,
  expectedRevision: number,
): ArchiveFinanceExpenseCategoryCommand {
  return { ...context(key, propertyId), categoryId, expectedRevision };
}

function context(key: string, propertyId: string) {
  return {
    commandId: "12150000-0000-4000-8000-000000000006",
    idempotencyKey: key,
    propertyId,
    audit: {
      actor: { kind: "user" as const, userId: ACTOR, organizationId: ORGANIZATION },
      requestId: `request-${key}`,
      correlationId: `correlation-${key}`,
      reason: "test",
      requestedAt: "2026-01-01T00:00:00Z",
    },
  };
}
