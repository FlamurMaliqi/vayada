import { createHash } from "node:crypto";

import type { FinanceCommandAudit, FinanceExpenseCategory } from "@vayada/domain-finance";
import pg from "pg";

type CategoryRow = Omit<FinanceExpenseCategory, "archived"> & { archivedAt: Date | string | null };
// prettier-ignore
type IdempotencyRow = { status: string; fingerprint: string; responseHash: string | null; metadata: unknown };
type CategoryFields = { name: string; color: string; sortOrder: number };
// prettier-ignore
type CategoryCommandBase = { commandId: string; idempotencyKey: string; propertyId: string; audit: FinanceCommandAudit };
export type CreateFinanceExpenseCategoryCommand = CategoryCommandBase & CategoryFields;
// prettier-ignore
export type UpdateFinanceExpenseCategoryCommand = CategoryCommandBase &
  Partial<CategoryFields> & { categoryId: string; expectedRevision: number };
// prettier-ignore
export type ArchiveFinanceExpenseCategoryCommand = CategoryCommandBase & { categoryId: string; expectedRevision: number };
export type CreateFinanceExpenseCategoryResult =
  | { status: "created"; category: FinanceExpenseCategory }
  | { status: "replayed"; category: FinanceExpenseCategory }
  | { status: "not_found" }
  | { status: "conflict"; reason: "idempotency_key_reused" | "command_in_progress" };
export type MutateFinanceExpenseCategoryResult =
  | { status: "updated" | "replayed"; category: FinanceExpenseCategory }
  | { status: "not_found" }
  | { status: "blocked"; reason: "active_recurring_rule" }
  | {
      status: "conflict";
      reason:
        | "revision_conflict"
        | "revision_exhausted"
        | "already_archived"
        | "idempotency_key_reused"
        | "command_in_progress";
    };
type MutationCommand =
  | (UpdateFinanceExpenseCategoryCommand & { action: "update" })
  | (ArchiveFinanceExpenseCategoryCommand & { action: "archive" });
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
        await client.query("SET LOCAL lock_timeout='3s'; SET LOCAL statement_timeout='10s'");
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
              idempotency_key_id,correlation_id,causation_id,redacted_payload,private_payload,
              audit_metadata,retention_class,privacy_scope)
           VALUES ($1,'finance',$2,$3::timestamptz,'property',$4::uuid,'user',$5::uuid,
                   'finance','expense_category',$6,$7::uuid,$8,$9,$10::jsonb,
                   jsonb_build_object('reason',$11::text),
                   jsonb_build_object('requestId',$9::text,'requestedAt',$12::text,'actorOrganizationId',$13::text),
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
            JSON.stringify({ commandId: raw.commandId, category: created }),
            raw.audit.reason,
            raw.audit.requestedAt,
            actor.kind === "user" ? actor.organizationId : null,
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
    update: (raw: UpdateFinanceExpenseCategoryCommand) =>
      mutate(pool, { ...raw, action: "update" }),
    archive: (raw: ArchiveFinanceExpenseCategoryCommand) =>
      mutate(pool, { ...raw, action: "archive" }),
    close: () => pool.end(),
  };
}

async function mutate(
  pool: pg.Pool,
  raw: MutationCommand,
): Promise<MutateFinanceExpenseCategoryResult> {
  validateMutation(raw);
  const operation = `finance.expense_category.${raw.action}`;
  const acceptedAt = new Date().toISOString();
  const keyHash = hash(raw.idempotencyKey);
  const fingerprint = hash(
    JSON.stringify([
      raw.categoryId,
      raw.expectedRevision,
      raw.action === "update" ? raw.name : null,
      raw.action === "update" ? raw.color : null,
      raw.action === "update" ? raw.sortOrder : null,
    ]),
  );
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL lock_timeout='3s'; SET LOCAL statement_timeout='10s'");
    const property = await client.query(
      "SELECT id FROM hotel_catalog.properties WHERE id=$1::uuid FOR UPDATE",
      [raw.propertyId],
    );
    if (property.rowCount !== 1) return await stop(client, { status: "not_found" });
    const existing = await client.query<IdempotencyRow>(
      `SELECT status, request_fingerprint_hash AS fingerprint,
              response_body_hash AS "responseHash", idempotency_metadata AS metadata
       FROM platform.idempotency_keys
       WHERE operation_scope='finance' AND operation=$1 AND key_hash=$2
         AND tenant_scope='property' AND property_id=$3::uuid FOR UPDATE`,
      [operation, keyHash, raw.propertyId],
    );
    if (existing.rows[0]) return await stop(client, replayMutation(existing.rows[0], fingerprint));
    const reserved = await client.query<{ id: string }>(
      `INSERT INTO platform.idempotency_keys
         (operation_scope,operation,key_hash,request_fingerprint_hash,status,
          tenant_scope,property_id,correlation_id,expires_at)
       VALUES ('finance',$1,$2,$3,'in_progress','property',$4::uuid,$5,'infinity')
       ON CONFLICT DO NOTHING RETURNING id::text AS id`,
      [
        operation,
        keyHash,
        fingerprint,
        raw.propertyId,
        raw.audit.correlationId ?? raw.audit.requestId,
      ],
    );
    const reservationId = reserved.rows[0]?.id;
    if (!reservationId)
      return await stop(client, { status: "conflict", reason: "command_in_progress" });
    const found = await client.query<CategoryRow>(
      `SELECT ${COLUMNS} FROM finance.expense_categories
       WHERE id=$1::uuid AND property_id=$2::uuid FOR UPDATE`,
      [raw.categoryId, raw.propertyId],
    );
    if (!found.rows[0]) return await stop(client, { status: "not_found" });
    const previous = category(found.rows[0]);
    if (previous.revision !== raw.expectedRevision)
      return await stop(client, { status: "conflict", reason: "revision_conflict" });
    if (raw.action === "archive" && previous.archived)
      return await stop(client, { status: "conflict", reason: "already_archived" });
    if (previous.revision === 2_147_483_647)
      return await stop(client, { status: "conflict", reason: "revision_exhausted" });
    let next: FinanceExpenseCategory;
    try {
      const updated = await client.query<CategoryRow>(
        raw.action === "archive"
          ? `UPDATE finance.expense_categories SET archived_at=$3::timestamptz,
               updated_at=$3::timestamptz, revision=revision+1
             WHERE id=$1::uuid AND property_id=$2::uuid RETURNING ${COLUMNS}`
          : `UPDATE finance.expense_categories SET name=COALESCE($3,name),
               color=COALESCE($4,color), sort_order=COALESCE($5,sort_order),
               updated_at=$6::timestamptz, revision=revision+1
             WHERE id=$1::uuid AND property_id=$2::uuid RETURNING ${COLUMNS}`,
        raw.action === "archive"
          ? [raw.categoryId, raw.propertyId, acceptedAt]
          : [
              raw.categoryId,
              raw.propertyId,
              raw.name ?? null,
              raw.color ?? null,
              raw.sortOrder ?? null,
              acceptedAt,
            ],
      );
      next = category(updated.rows[0]!);
    } catch (error) {
      if (constraint(error) === "fk_finance_recurring_expense_rules_active_category")
        return await stop(client, { status: "blocked", reason: "active_recurring_rule" });
      throw error;
    }
    const result = { status: "updated" as const, category: next };
    const actor = raw.audit.actor;
    await client.query(
      `INSERT INTO platform.product_audit_events
         (audit_key,product,action,occurred_at,tenant_scope,property_id,actor_type,
          actor_user_id,target_resource_product,target_resource_type,target_resource_id,
          idempotency_key_id,correlation_id,causation_id,redacted_payload,private_payload,
          audit_metadata,retention_class,privacy_scope)
       VALUES ($1,'finance',$2,$3::timestamptz,'property',$4::uuid,'user',$5::uuid,
               'finance','expense_category',$6,$7::uuid,$8,$9,$10::jsonb,
               jsonb_build_object('reason',$11::text),
               jsonb_build_object('requestId',$9::text,'requestedAt',$12::text,'actorOrganizationId',$13::text),
               'financial','confidential')`,
      [
        `${operation}.property.${raw.propertyId}.category.${next.id}.key.${keyHash}.v1`,
        operation,
        acceptedAt,
        raw.propertyId,
        actor.kind === "user" ? actor.userId : null,
        next.id,
        reservationId,
        raw.audit.correlationId ?? raw.audit.requestId,
        raw.audit.requestId,
        JSON.stringify({ commandId: raw.commandId, previous, category: next }),
        raw.audit.reason,
        raw.audit.requestedAt,
        actor.kind === "user" ? actor.organizationId : null,
      ],
    );
    const completed = await client.query(
      `UPDATE platform.idempotency_keys SET status='completed',response_status_code=200,
         response_body_hash=$2,completed_at=$3::timestamptz,
         idempotency_metadata=jsonb_build_object('result',$4::jsonb)
       WHERE id=$1::uuid AND status='in_progress'`,
      [reservationId, resultHash(next), acceptedAt, JSON.stringify(result)],
    );
    if (completed.rowCount !== 1) throw new Error("expense category idempotency completion failed");
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await rollback(client);
    throw error;
  } finally {
    client.release();
  }
}

function validate(command: CreateFinanceExpenseCategoryCommand): void {
  if (
    !validContext(command, "commandId idempotencyKey propertyId name color sortOrder audit") ||
    !validFields(command, true)
  )
    throw new Error("expense category command failed contract validation");
}
function validateMutation(command: MutationCommand): void {
  if (
    !validContext(
      command,
      command.action === "update"
        ? "commandId idempotencyKey propertyId audit categoryId expectedRevision action name color sortOrder"
        : "commandId idempotencyKey propertyId audit categoryId expectedRevision action",
    ) ||
    !uuid(command.categoryId) ||
    !revision(command.expectedRevision) ||
    (command.action === "update" && !validFields(command, false))
  )
    throw new Error("expense category command failed contract validation");
}
function validContext(command: CategoryCommandBase, allowed: string): boolean {
  const audit = command.audit;
  const actor = audit?.actor;
  return !(
    !exact(command, allowed) ||
    !exact(audit, "actor requestId correlationId reason requestedAt") ||
    !exact(actor, "kind userId organizationId") ||
    !uuid(command.propertyId) ||
    !uuid(command.commandId) ||
    !trimmed(command.idempotencyKey, 1, 200) ||
    actor?.kind !== "user" ||
    !uuid(actor.userId) ||
    !uuid(actor.organizationId) ||
    !trimmed(audit.requestId, 1, 200) ||
    (audit.correlationId !== undefined && !trimmed(audit.correlationId, 1, 200)) ||
    !trimmed(audit.reason, 1, 500) ||
    !utc(audit.requestedAt)
  );
}
function validFields(fields: Partial<CategoryFields>, required: boolean): boolean {
  const supplied = [fields.name, fields.color, fields.sortOrder].filter(
    (value) => value !== undefined,
  );
  return (
    (!required || supplied.length === 3) &&
    supplied.length > 0 &&
    (fields.name === undefined || trimmed(fields.name, 1, 120)) &&
    (fields.color === undefined || /^#[0-9A-Fa-f]{6}$/.test(fields.color)) &&
    (fields.sortOrder === undefined ||
      (Number.isSafeInteger(fields.sortOrder) &&
        fields.sortOrder >= 0 &&
        fields.sortOrder <= 2_147_483_647))
  );
}
function replay(row: IdempotencyRow, fingerprint: string): CreateFinanceExpenseCategoryResult {
  if (row.fingerprint !== fingerprint)
    return { status: "conflict", reason: "idempotency_key_reused" };
  if (row.status !== "completed") return { status: "conflict", reason: "command_in_progress" };
  const stored = record(row.metadata) ? row.metadata["result"] : null;
  const value = record(stored) ? stored["category"] : null;
  const parsed = storedCategory(value, true);
  if (!parsed || row.responseHash !== resultHash(parsed))
    throw new Error("expense category replay evidence is invalid");
  return { status: "replayed", category: parsed };
}
function replayMutation(
  row: IdempotencyRow,
  fingerprint: string,
): MutateFinanceExpenseCategoryResult {
  if (row.fingerprint !== fingerprint)
    return { status: "conflict", reason: "idempotency_key_reused" };
  if (row.status !== "completed") return { status: "conflict", reason: "command_in_progress" };
  const stored = record(row.metadata) ? row.metadata["result"] : null;
  const value = record(stored) && stored["status"] === "updated" ? stored["category"] : null;
  const parsed = storedCategory(value, false);
  if (!parsed || row.responseHash !== resultHash(parsed))
    throw new Error("expense category replay evidence is invalid");
  return { status: "replayed", category: parsed };
}
function storedCategory(value: unknown, created: boolean): FinanceExpenseCategory | null {
  if (
    !exact(value, "id systemKey name color sortOrder archived revision") ||
    !uuid(value["id"]) ||
    !(value["systemKey"] === null || systemKey(value["systemKey"])) ||
    !trimmed(value["name"], 1, 120) ||
    typeof value["color"] !== "string" ||
    !/^#[0-9A-Fa-f]{6}$/.test(value["color"]) ||
    !Number.isSafeInteger(value["sortOrder"]) ||
    Number(value["sortOrder"]) < 0 ||
    Number(value["sortOrder"]) > 2_147_483_647 ||
    typeof value["archived"] !== "boolean" ||
    (created && (value["systemKey"] !== null || value["archived"] !== false)) ||
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
// prettier-ignore
function systemKey(value: unknown): value is string { return typeof value === "string" && /^(staff|ota_commission|utilities|maintenance|supplies|marketing|platform_fees)$/.test(value); }
// prettier-ignore
function trimmed(value: unknown, min: number, max: number): value is string {
  return typeof value === "string" && value === value.trim() && value.length >= min && value.length <= max;
}
// prettier-ignore
function exact(value: unknown, allowed: string): value is Record<string, unknown> {
  return record(value) && Object.keys(value).every((key) => allowed.split(" ").includes(key)); }
function revision(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 1 && Number(value) <= 2_147_483_647;
}
function utc(value: unknown): value is string {
  if (
    typeof value !== "string" ||
    value.startsWith("0000-") ||
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
function constraint(error: unknown): unknown {
  return record(error) ? error["constraint"] : null;
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
