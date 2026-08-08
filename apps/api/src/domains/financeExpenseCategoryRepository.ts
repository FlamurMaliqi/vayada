import { createHash } from "node:crypto";

import type { FinanceCommandAudit, FinanceExpenseCategory } from "@vayada/domain-finance";
import pg from "pg";

type CategoryRow = Omit<FinanceExpenseCategory, "archived"> & { archivedAt: Date | string | null };
type IdempotencyRow = {
  status: string;
  fingerprint: string;
  responseHash: string | null;
  metadata: unknown;
};
export type CreateFinanceExpenseCategoryCommand = {
  commandId: string;
  idempotencyKey: string;
  propertyId: string;
  name: string;
  color: string;
  sortOrder: number;
  audit: FinanceCommandAudit;
};
export type CreateFinanceExpenseCategoryResult =
  | { status: "created"; category: FinanceExpenseCategory }
  | { status: "replayed"; category: FinanceExpenseCategory }
  | { status: "not_found" }
  | { status: "conflict"; reason: "idempotency_key_reused" | "command_in_progress" };

const OPERATION = "finance.expense_category.create";
const COLUMNS = `id::text AS id, system_key AS "systemKey", name, color,
  sort_order AS "sortOrder", archived_at AS "archivedAt", revision::int`;

export function createPgFinanceExpenseCategoryRepository(connectionString: string) {
  const pool = new pg.Pool({ connectionString });
  return {
    async list(propertyId: string): Promise<FinanceExpenseCategory[]> {
      const result = await pool.query<CategoryRow>(
        `SELECT ${COLUMNS} FROM finance.expense_categories
         WHERE property_id=$1::uuid ORDER BY archived_at NULLS FIRST, sort_order, name, id`,
        [propertyId],
      );
      return result.rows.map(category);
    },
    async create(
      raw: CreateFinanceExpenseCategoryCommand,
    ): Promise<CreateFinanceExpenseCategoryResult> {
      validate(raw);
      const acceptedAt = new Date().toISOString();
      const keyHash = hash(raw.idempotencyKey);
      const fingerprint = hash(JSON.stringify([raw.name, raw.color, raw.sortOrder]));
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const property = await client.query(
          "SELECT id FROM hotel_catalog.properties WHERE id=$1::uuid FOR UPDATE",
          [raw.propertyId],
        );
        if (property.rowCount !== 1) return stop(client, { status: "not_found" });

        const existing = await client.query<IdempotencyRow>(
          `SELECT status, request_fingerprint_hash AS fingerprint,
                  response_body_hash AS "responseHash", idempotency_metadata AS metadata
           FROM platform.idempotency_keys
           WHERE operation_scope='finance' AND operation=$1 AND key_hash=$2
             AND tenant_scope='property' AND property_id=$3::uuid FOR UPDATE`,
          [OPERATION, keyHash, raw.propertyId],
        );
        if (existing.rows[0]) return stop(client, replay(existing.rows[0], fingerprint));

        const reserved = await client.query<{ id: string }>(
          `INSERT INTO platform.idempotency_keys
             (operation_scope,operation,key_hash,request_fingerprint_hash,status,
              tenant_scope,property_id,correlation_id,expires_at)
           VALUES ('finance',$1,$2,$3,'in_progress','property',$4::uuid,$5,'infinity')
           ON CONFLICT DO NOTHING RETURNING id::text AS id`,
          [
            OPERATION,
            keyHash,
            fingerprint,
            raw.propertyId,
            raw.audit.correlationId ?? raw.audit.requestId,
          ],
        );
        const reservationId = reserved.rows[0]?.id;
        if (!reservationId)
          return stop(client, { status: "conflict", reason: "command_in_progress" });

        const inserted = await client.query<CategoryRow>(
          `INSERT INTO finance.expense_categories (property_id,name,color,sort_order)
           VALUES ($1::uuid,$2,$3,$4) RETURNING ${COLUMNS}`,
          [raw.propertyId, raw.name, raw.color, raw.sortOrder],
        );
        const created = category(inserted.rows[0]!);
        const result = { status: "created" as const, category: created };
        const actor = raw.audit.actor;
        await client.query(
          `INSERT INTO platform.product_audit_events
             (audit_key,product,action,occurred_at,tenant_scope,property_id,actor_type,
              actor_user_id,target_resource_product,target_resource_type,target_resource_id,
              idempotency_key_id,correlation_id,causation_id,redacted_payload,
              retention_class,privacy_scope)
           VALUES ($1,'finance',$2,$3::timestamptz,'property',$4::uuid,'user',$5::uuid,
                   'finance','expense_category',$6,$7::uuid,$8,$9,$10::jsonb,
                   'financial','confidential')`,
          [
            `finance.expense_category.property.${raw.propertyId}.category.${created.id}.key.${keyHash}.v1`,
            OPERATION,
            acceptedAt,
            raw.propertyId,
            actor.kind === "user" ? actor.userId : null,
            created.id,
            reservationId,
            raw.audit.correlationId ?? raw.audit.requestId,
            raw.audit.requestId,
            JSON.stringify({
              commandId: raw.commandId,
              category: created,
              requestedAt: raw.audit.requestedAt,
              reason: raw.audit.reason,
              actorOrganizationId: actor.kind === "user" ? actor.organizationId : null,
            }),
          ],
        );
        const completed = await client.query(
          `UPDATE platform.idempotency_keys SET status='completed',response_status_code=200,
             response_body_hash=$2,completed_at=$3::timestamptz,
             idempotency_metadata=jsonb_build_object('result',$4::jsonb)
           WHERE id=$1::uuid AND status='in_progress'`,
          [reservationId, resultHash(created), acceptedAt, JSON.stringify(result)],
        );
        if (completed.rowCount !== 1)
          throw new Error("expense category idempotency completion failed");
        await client.query("COMMIT");
        return result;
      } catch (error) {
        await rollback(client);
        throw error;
      } finally {
        client.release();
      }
    },
    close: () => pool.end(),
  };
}

function validate(command: CreateFinanceExpenseCategoryCommand): void {
  const audit = command.audit;
  const actor = audit?.actor;
  if (
    !uuid(command.propertyId) ||
    !trimmed(command.commandId, 1, 200) ||
    !trimmed(command.idempotencyKey, 1, 200) ||
    !trimmed(command.name, 1, 120) ||
    !/^#[0-9A-Fa-f]{6}$/.test(command.color) ||
    !Number.isSafeInteger(command.sortOrder) ||
    command.sortOrder < 0 ||
    command.sortOrder > 2_147_483_647 ||
    actor?.kind !== "user" ||
    !uuid(actor.userId) ||
    !uuid(actor.organizationId) ||
    !trimmed(audit.requestId, 1, 200) ||
    (audit.correlationId !== undefined && !trimmed(audit.correlationId, 1, 200)) ||
    !trimmed(audit.reason, 1, 500) ||
    !utc(audit.requestedAt)
  )
    throw new Error("expense category command failed contract validation");
}
function replay(row: IdempotencyRow, fingerprint: string): CreateFinanceExpenseCategoryResult {
  if (row.fingerprint !== fingerprint)
    return { status: "conflict", reason: "idempotency_key_reused" };
  if (row.status !== "completed") return { status: "conflict", reason: "command_in_progress" };
  const stored = record(row.metadata) ? row.metadata["result"] : null;
  const value = record(stored) ? stored["category"] : null;
  const parsed = storedCategory(value);
  if (!parsed || row.responseHash !== resultHash(parsed))
    throw new Error("expense category replay evidence is invalid");
  return { status: "replayed", category: parsed };
}
function storedCategory(value: unknown): FinanceExpenseCategory | null {
  if (
    !record(value) ||
    !uuid(value["id"]) ||
    value["systemKey"] !== null ||
    !trimmed(value["name"], 1, 120) ||
    typeof value["color"] !== "string" ||
    !/^#[0-9A-Fa-f]{6}$/.test(value["color"]) ||
    !Number.isSafeInteger(value["sortOrder"]) ||
    Number(value["sortOrder"]) < 0 ||
    value["archived"] !== false ||
    !Number.isSafeInteger(value["revision"]) ||
    Number(value["revision"]) < 1 ||
    Number(value["revision"]) > 2_147_483_647
  )
    return null;
  return value as FinanceExpenseCategory;
}
function category(row: CategoryRow): FinanceExpenseCategory {
  const { archivedAt, ...fields } = row;
  return { ...fields, archived: archivedAt !== null };
}
function resultHash(value: FinanceExpenseCategory): string {
  return hash(
    JSON.stringify([
      value.id,
      value.systemKey,
      value.name,
      value.color,
      value.sortOrder,
      value.archived,
      value.revision,
    ]),
  );
}
function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
function uuid(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
  );
}
function trimmed(value: unknown, min: number, max: number): value is string {
  return (
    typeof value === "string" &&
    value === value.trim() &&
    value.length >= min &&
    value.length <= max
  );
}
function utc(value: unknown): value is string {
  if (
    typeof value !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(value)
  )
    return false;
  const parsed = new Date(value);
  return (
    Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 19) === value.slice(0, 19)
  );
}
function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
async function stop<T>(client: pg.PoolClient, result: T): Promise<T> {
  await client.query("ROLLBACK");
  return result;
}
async function rollback(client: pg.PoolClient): Promise<void> {
  try {
    await client.query("ROLLBACK");
  } catch {}
}
