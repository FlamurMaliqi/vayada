import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  createPgFinanceExpenseCategoryRepository,
  type CreateFinanceExpenseCategoryCommand,
} from "./financeExpenseCategoryRepository.js";

const URL = process.env["TEST_DATABASE_URL"];
const ACTOR = "12120000-0000-4000-8000-000000000001";
const PROPERTY_A = "12120000-0000-4000-8000-000000000002";
const PROPERTY_B = "12120000-0000-4000-8000-000000000003";
const MISSING_PROPERTY = "12120000-0000-4000-8000-000000000004";
const ORGANIZATION = "12120000-0000-4000-8000-000000000005";

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
         ('${PROPERTY_B}','category-b','Category B')`,
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
         AND redacted_payload->>'commandId'='command-first'
         AND target_resource_id=$3`,
      [PROPERTY_A, ACTOR, first.status === "created" ? first.category.id : ""],
    );
    expect(audit.rows[0]?.count).toBe(1);
  });

  it("replays matching input, conflicts changed reuse, and leaves not-found clean", async () => {
    const input = command("same", PROPERTY_A, "Utilities extra", "#00AAFF", 80);
    const created = await repository.create(input);
    input.commandId = "regenerated-command-id";
    await expect(repository.create(input)).resolves.toEqual({
      status: "replayed",
      category: created.status === "created" ? created.category : undefined,
    });
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

  async function cleanup() {
    await admin.query(
      `BEGIN; SET LOCAL session_replication_role = replica;
       DELETE FROM platform.product_audit_events
         WHERE property_id IN ('${PROPERTY_A}','${PROPERTY_B}');
       DELETE FROM platform.idempotency_keys
         WHERE property_id IN ('${PROPERTY_A}','${PROPERTY_B}');
       DELETE FROM finance.expense_categories
         WHERE property_id IN ('${PROPERTY_A}','${PROPERTY_B}');
       DELETE FROM hotel_catalog.properties
         WHERE id IN ('${PROPERTY_A}','${PROPERTY_B}');
       DELETE FROM identity.users WHERE id='${ACTOR}'; COMMIT`,
    );
  }
});

function command(
  key: string,
  propertyId: string,
  name: string,
  color: string,
  sortOrder: number,
): CreateFinanceExpenseCategoryCommand {
  return {
    commandId: `command-${key}`,
    idempotencyKey: key,
    propertyId,
    name,
    color,
    sortOrder,
    audit: {
      actor: { kind: "user", userId: ACTOR, organizationId: ORGANIZATION },
      requestId: `request-${key}`,
      correlationId: `correlation-${key}`,
      reason: "test",
      requestedAt: "2026-01-01T00:00:00Z",
    },
  };
}
