import { createHash } from "node:crypto";

import {
  parseFinanceExpenseWrite,
  type FinanceCommandAudit,
  type FinanceExpense,
  type FinanceExpenseCommandResult,
  type FinanceExpenseWrite,
} from "@vayada/domain-finance";
import { getTimezone } from "countries-and-timezones";
import pg from "pg";

export type CreateFinanceManualExpenseCommand = Omit<
  FinanceExpenseWrite,
  "expectedRevision" | "supplierInvoiceNumber" | "recurrence"
> & {
  propertyId: string;
  receiptMediaId?: string;
  audit: FinanceCommandAudit;
};
export type CreateFinanceManualExpenseResult = FinanceExpenseCommandResult<FinanceExpense>;
type ExpenseFailure = Extract<FinanceExpenseCommandResult<FinanceExpense>, { ok: false }>;
type MutationBase = {
  commandId: string;
  idempotencyKey: string;
  expectedRevision: number;
  propertyId: string;
  expenseId: string;
  audit: FinanceCommandAudit;
};
export type UpdateFinanceManualExpenseCommand = MutationBase &
  Partial<
    Pick<
      FinanceExpenseWrite,
      "incurredOn" | "vendor" | "categoryId" | "amount" | "paymentStatus" | "paidOn" | "notes"
    >
  > & { receiptMediaId?: string | null };
export type MutateFinanceManualExpenseResult =
  | { ok: true; outcome: "updated" | "corrected" | "replayed"; item: FinanceExpense }
  | ExpenseFailure;
export type ArchiveFinanceManualExpenseCommand = MutationBase;
export type ArchiveFinanceManualExpenseResult =
  { ok: true; outcome: "archived" | "replayed"; item: FinanceExpense } | ExpenseFailure;

type IdempotencyRow = {
  status: string;
  fingerprint: string;
  responseHash: string | null;
  metadata: unknown;
};
type StoredExpense = FinanceExpense & {
  entryKind: "expense" | "correction" | "reversal";
  notes: string | null;
  receiptMediaId: string | null;
  reversed: boolean;
};
const OPERATION = "finance.manual_expense.create";
const UPDATE_OPERATION = "finance.manual_expense.update";
const ARCHIVE_OPERATION = "finance.manual_expense.archive";
const UPDATE_FIELDS = [
  "incurredOn",
  "vendor",
  "categoryId",
  "amount",
  "paymentStatus",
  "paidOn",
  "notes",
  "receiptMediaId",
] as const;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;
const COLUMNS = `id::text, category_id::text AS "categoryId", origin,
  incurred_on::text AS "incurredOn", paid_on::text AS "paidOn", vendor,
  jsonb_build_object('amount',amount::text,'currency',currency::text) AS amount,
  payment_status AS "paymentStatus", recurring_rule_id::text AS "recurringRuleId",
  source_key AS "sourceKey",
  reverses_expense_id::text AS "reversesExpenseId", revision::int`;

export function createPgFinanceManualExpenseRepository(
  connectionString: string,
  clock: () => Date = () => new Date(),
) {
  const pool = new pg.Pool({ connectionString });
  return {
    async create(
      raw: CreateFinanceManualExpenseCommand,
    ): Promise<CreateFinanceManualExpenseResult> {
      if (!valid(raw)) return { ok: false, code: "invalid_command" };
      const acceptedAt = new Date().toISOString();
      const keyHash = hash(raw.idempotencyKey);
      const fingerprint = hash(
        JSON.stringify([
          raw.commandId,
          raw.categoryId,
          raw.incurredOn,
          raw.vendor,
          raw.amount.amount,
          raw.amount.currency,
          raw.paymentStatus,
          raw.paidOn ?? null,
          raw.notes ?? null,
          raw.receiptMediaId ?? null,
        ]),
      );
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const property = await client.query(
          "SELECT id FROM hotel_catalog.properties WHERE id=$1::uuid FOR UPDATE",
          [raw.propertyId],
        );
        if (property.rowCount !== 1) return stop(client, { ok: false, code: "not_found" });

        const existing = await client.query<IdempotencyRow>(
          `SELECT status,request_fingerprint_hash AS fingerprint,
                  response_body_hash AS "responseHash",idempotency_metadata AS metadata
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
           ON CONFLICT DO NOTHING RETURNING id::text`,
          [
            OPERATION,
            keyHash,
            fingerprint,
            raw.propertyId,
            raw.audit.correlationId ?? raw.audit.requestId,
          ],
        );
        if (!reserved.rows[0]) return stop(client, { ok: false, code: "idempotency_conflict" });

        const category = await client.query<{ archivedAt: unknown; receiptActive: boolean }>(
          `SELECT archived_at AS "archivedAt",$3::uuid IS NULL OR COALESCE((
             SELECT lifecycle_status='active' FROM platform.media_objects
             WHERE id=$3::uuid FOR SHARE),FALSE) AS "receiptActive"
           FROM finance.expense_categories
           WHERE id=$1::uuid AND property_id=$2::uuid`,
          [raw.categoryId, raw.propertyId, raw.receiptMediaId ?? null],
        );
        if (
          !category.rows[0] ||
          category.rows[0].archivedAt !== null ||
          !category.rows[0].receiptActive
        )
          return stop(client, { ok: false, code: "evidence_mismatch" });

        let inserted: pg.QueryResult<FinanceExpense>;
        try {
          inserted = await client.query<FinanceExpense>(
            `INSERT INTO finance.expenses
               (id,property_id,category_id,origin,incurred_on,vendor,amount,currency,
                payment_status,paid_on,notes,receipt_media_id)
             VALUES ($1::uuid,$2::uuid,$3::uuid,'manual',$4::date,$5,$6::numeric,
                     $7,$8,$9::date,$10,$11::uuid)
             RETURNING ${COLUMNS}`,
            [
              raw.commandId,
              raw.propertyId,
              raw.categoryId,
              raw.incurredOn,
              raw.vendor,
              raw.amount.amount,
              raw.amount.currency,
              raw.paymentStatus,
              raw.paidOn ?? null,
              raw.notes ?? null,
              raw.receiptMediaId ?? null,
            ],
          );
        } catch (error) {
          const name = constraint(error);
          if (name === "expenses_pkey")
            return stop(client, { ok: false, code: "idempotency_conflict" });
          if (name === "fk_finance_expenses_pricing_currency")
            return stop(client, { ok: false, code: "currency_mismatch" });
          if (name === "fk_finance_expenses_receipt")
            return stop(client, { ok: false, code: "evidence_mismatch" });
          throw error;
        }
        const expense = inserted.rows[0]!;
        const result = { ok: true as const, outcome: "created" as const, item: expense };
        const actor = raw.audit.actor;
        await client.query(
          `INSERT INTO platform.product_audit_events
             (audit_key,product,action,occurred_at,tenant_scope,property_id,actor_type,
              actor_user_id,target_resource_product,target_resource_type,target_resource_id,
              idempotency_key_id,correlation_id,causation_id,redacted_payload,
              retention_class,privacy_scope)
           VALUES ($1,'finance',$2,$3::timestamptz,'property',$4::uuid,'user',$5::uuid,
                   'finance','expense',$6,$7::uuid,$8,$9,$10::jsonb,
                   'financial','confidential')`,
          [
            `${OPERATION}.property.${raw.propertyId}.expense.${expense.id}.key.${keyHash}.v1`,
            OPERATION,
            acceptedAt,
            raw.propertyId,
            actor.kind === "user" ? actor.userId : null,
            expense.id,
            reserved.rows[0].id,
            raw.audit.correlationId ?? raw.audit.requestId,
            raw.audit.requestId,
            JSON.stringify({
              commandId: raw.commandId,
              expenseId: expense.id,
              revision: expense.revision,
              actorOrganizationId: actor.kind === "user" ? actor.organizationId : null,
              requestedAt: raw.audit.requestedAt,
              reason: raw.audit.reason,
            }),
          ],
        );
        const completed = await client.query(
          `UPDATE platform.idempotency_keys SET status='completed',response_status_code=200,
             response_body_hash=$2,completed_at=$3::timestamptz,
             response_resource_product='finance',response_resource_type='expense',
             response_resource_id=$4,idempotency_metadata=jsonb_build_object('result',$5::jsonb)
           WHERE id=$1::uuid AND status='in_progress'`,
          [
            reserved.rows[0].id,
            resultHash(expense),
            acceptedAt,
            expense.id,
            JSON.stringify(result),
          ],
        );
        if (completed.rowCount !== 1)
          throw new Error("manual expense idempotency completion failed");
        await client.query("COMMIT");
        return result;
      } catch (error) {
        await rollback(client);
        throw error;
      } finally {
        client.release();
      }
    },
    update: (raw: UpdateFinanceManualExpenseCommand) => mutate(pool, raw),
    archive: (raw: ArchiveFinanceManualExpenseCommand) => archive(pool, raw, clock),
    close: () => pool.end(),
  };
}

async function mutate(
  pool: pg.Pool,
  raw: UpdateFinanceManualExpenseCommand,
): Promise<MutateFinanceManualExpenseResult> {
  if (!validMutation(raw)) return { ok: false, code: "invalid_command" };
  const acceptedAt = new Date().toISOString();
  const keyHash = hash(raw.idempotencyKey);
  const fields = UPDATE_FIELDS.map((key) => {
    if (key === "amount" && raw.amount) return [raw.amount.amount, raw.amount.currency];
    return Object.hasOwn(raw, key) ? (raw[key] ?? null) : "__absent__";
  });
  const fingerprint = hash(
    JSON.stringify([raw.commandId, raw.expenseId, raw.expectedRevision, fields]),
  );
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const property = await client.query(
      "SELECT id FROM hotel_catalog.properties WHERE id=$1::uuid FOR UPDATE",
      [raw.propertyId],
    );
    if (property.rowCount !== 1) return stop(client, { ok: false, code: "not_found" });
    const existing = await client.query<IdempotencyRow>(
      `SELECT status,request_fingerprint_hash AS fingerprint,
              response_body_hash AS "responseHash",idempotency_metadata AS metadata
       FROM platform.idempotency_keys
       WHERE operation_scope='finance' AND operation=$1 AND key_hash=$2
         AND tenant_scope='property' AND property_id=$3::uuid FOR UPDATE`,
      [UPDATE_OPERATION, keyHash, raw.propertyId],
    );
    if (existing.rows[0]) return stop(client, replay(existing.rows[0], fingerprint));
    const reserved = await client.query<{ id: string }>(
      `INSERT INTO platform.idempotency_keys
         (operation_scope,operation,key_hash,request_fingerprint_hash,status,
          tenant_scope,property_id,correlation_id,expires_at)
       VALUES ('finance',$1,$2,$3,'in_progress','property',$4::uuid,$5,'infinity')
       ON CONFLICT DO NOTHING RETURNING id::text`,
      [
        UPDATE_OPERATION,
        keyHash,
        fingerprint,
        raw.propertyId,
        raw.audit.correlationId ?? raw.audit.requestId,
      ],
    );
    if (!reserved.rows[0]) return stop(client, { ok: false, code: "idempotency_conflict" });
    const found = await client.query<StoredExpense>(
      `SELECT ${COLUMNS},entry_kind AS "entryKind",notes,
              receipt_media_id::text AS "receiptMediaId",
              EXISTS (SELECT 1 FROM finance.expenses child
                WHERE child.reverses_expense_id=e.id) AS reversed
       FROM finance.expenses e
       WHERE e.id=$1::uuid AND e.property_id=$2::uuid AND e.origin='manual' FOR UPDATE`,
      [raw.expenseId, raw.propertyId],
    );
    const previous = found.rows[0];
    if (!previous) return stop(client, { ok: false, code: "not_found" });
    if (
      previous.revision !== raw.expectedRevision ||
      previous.entryKind === "reversal" ||
      previous.reversed
    )
      return stop(client, { ok: false, code: "revision_conflict" });
    const receiptChanged =
      Object.hasOwn(raw, "receiptMediaId") &&
      (raw.receiptMediaId ?? null) !== previous.receiptMediaId;
    const merged = parseFinanceExpenseWrite({
      commandId: raw.commandId,
      idempotencyKey: raw.idempotencyKey,
      expectedRevision: raw.expectedRevision,
      incurredOn: raw.incurredOn ?? previous.incurredOn,
      vendor: raw.vendor ?? previous.vendor,
      categoryId: raw.categoryId ?? previous.categoryId,
      amount: raw.amount ?? previous.amount,
      paymentStatus: raw.paymentStatus ?? previous.paymentStatus,
      paidOn:
        raw.paymentStatus === "unpaid" ? undefined : (raw.paidOn ?? previous.paidOn ?? undefined),
      notes: raw.notes ?? previous.notes ?? undefined,
    });
    if (!merged) return stop(client, { ok: false, code: "invalid_command" });
    const evidence = await client.query<{ categoryOk: boolean; receiptOk: boolean }>(
      `SELECT $1::uuid IS NULL OR EXISTS (
          SELECT 1 FROM finance.expense_categories
          WHERE id=$1::uuid AND property_id=$2::uuid AND archived_at IS NULL
        ) AS "categoryOk",
        $3::uuid IS NULL OR COALESCE((
          SELECT lifecycle_status='active' FROM platform.media_objects
          WHERE id=$3::uuid FOR SHARE
        ),FALSE) AS "receiptOk"`,
      [
        raw.categoryId !== previous.categoryId ? (raw.categoryId ?? null) : null,
        raw.propertyId,
        receiptChanged ? raw.receiptMediaId : null,
      ],
    );
    if (!evidence.rows[0]?.categoryOk || !evidence.rows[0].receiptOk)
      return stop(client, { ok: false, code: "evidence_mismatch" });
    const correction =
      previous.entryKind !== "expense" ||
      (raw.incurredOn !== undefined && raw.incurredOn !== previous.incurredOn) ||
      receiptChanged;
    let next: FinanceExpense;
    try {
      if (!correction) {
        const updated = await client.query<FinanceExpense>(
          `UPDATE finance.expenses SET category_id=$3::uuid,vendor=$4,amount=$5::numeric,
             currency=$6,payment_status=$7,paid_on=$8::date,notes=$9,
             revision=revision+1,updated_at=$10::timestamptz
           WHERE id=$1::uuid AND property_id=$2::uuid AND revision=$11
           RETURNING ${COLUMNS}`,
          [
            raw.expenseId,
            raw.propertyId,
            merged!.categoryId,
            merged!.vendor,
            merged!.amount.amount,
            merged!.amount.currency,
            merged!.paymentStatus,
            merged!.paidOn ?? null,
            merged!.notes ?? null,
            acceptedAt,
            raw.expectedRevision,
          ],
        );
        if (!updated.rows[0]) return stop(client, { ok: false, code: "revision_conflict" });
        next = updated.rows[0];
      } else {
        const inserted = await client.query<FinanceExpense>(
          `INSERT INTO finance.expenses
             (id,property_id,category_id,origin,entry_kind,incurred_on,paid_on,vendor,
              amount,currency,payment_status,source_key,reverses_expense_id,receipt_media_id,notes)
           VALUES ($1::uuid,$2::uuid,$3::uuid,'manual',$4,$5::date,$6::date,$7,
                   $8::numeric,$9,$10,$11,$12::uuid,$13::uuid,$14)
           RETURNING ${COLUMNS}`,
          [
            raw.commandId,
            raw.propertyId,
            merged.categoryId,
            "correction",
            merged.incurredOn,
            merged.paidOn,
            merged.vendor,
            merged.amount.amount,
            merged.amount.currency,
            merged.paymentStatus,
            `${UPDATE_OPERATION}:${raw.commandId}`,
            previous.id,
            receiptChanged ? raw.receiptMediaId : null,
            merged.notes ?? null,
          ],
        );
        next = inserted.rows[0]!;
      }
    } catch (error) {
      const name = constraint(error);
      if (name === "expenses_pkey")
        return stop(client, { ok: false, code: "idempotency_conflict" });
      if (
        ["uq_finance_expenses_reverses", "uq_finance_expenses_generated_source"].includes(
          String(name),
        )
      )
        return stop(client, { ok: false, code: "revision_conflict" });
      if (name === "fk_finance_expenses_pricing_currency")
        return stop(client, { ok: false, code: "currency_mismatch" });
      if (
        ["fk_finance_expenses_category_property", "fk_finance_expenses_receipt"].includes(
          String(name),
        )
      )
        return stop(client, { ok: false, code: "evidence_mismatch" });
      throw error;
    }
    const outcome: "corrected" | "updated" = correction ? "corrected" : "updated";
    const result = { ok: true as const, outcome, item: next };
    const actor = raw.audit.actor;
    await client.query(
      `INSERT INTO platform.product_audit_events
         (audit_key,product,action,occurred_at,tenant_scope,property_id,actor_type,
          actor_user_id,target_resource_product,target_resource_type,target_resource_id,
          idempotency_key_id,correlation_id,causation_id,redacted_payload,
          retention_class,privacy_scope)
       VALUES ($1,'finance',$2,$3::timestamptz,'property',$4::uuid,'user',$5::uuid,
               'finance','expense',$6,$7::uuid,$8,$9,$10::jsonb,'financial','confidential')`,
      [
        `${UPDATE_OPERATION}.property.${raw.propertyId}.expense.${next.id}.key.${keyHash}.v1`,
        UPDATE_OPERATION,
        acceptedAt,
        raw.propertyId,
        actor.kind === "user" ? actor.userId : null,
        next.id,
        reserved.rows[0].id,
        raw.audit.correlationId ?? raw.audit.requestId,
        raw.audit.requestId,
        JSON.stringify({
          commandId: raw.commandId,
          previousExpenseId: previous.id,
          expenseId: next.id,
          outcome,
          revision: next.revision,
          previous,
          next: {
            ...next,
            notes: merged.notes ?? null,
            receiptMediaId: correction
              ? receiptChanged
                ? (raw.receiptMediaId ?? null)
                : null
              : previous.receiptMediaId,
          },
          actorOrganizationId: actor.kind === "user" ? actor.organizationId : null,
          requestedAt: raw.audit.requestedAt,
          reason: raw.audit.reason,
        }),
      ],
    );
    const completed = await client.query(
      `UPDATE platform.idempotency_keys SET status='completed',response_status_code=200,
         response_body_hash=$2,completed_at=$3::timestamptz,
         response_resource_product='finance',response_resource_type='expense',
         response_resource_id=$4,idempotency_metadata=jsonb_build_object('result',$5::jsonb)
       WHERE id=$1::uuid AND status='in_progress'`,
      [reserved.rows[0].id, resultHash(next), acceptedAt, next.id, JSON.stringify(result)],
    );
    if (completed.rowCount !== 1) throw new Error("manual expense idempotency completion failed");
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await rollback(client);
    throw error;
  } finally {
    client.release();
  }
}

async function archive(
  pool: pg.Pool,
  raw: ArchiveFinanceManualExpenseCommand,
  clock: () => Date,
): Promise<ArchiveFinanceManualExpenseResult> {
  if (!validMutationBase(raw)) return { ok: false, code: "invalid_command" };
  const acceptedAt = clock().toISOString();
  const keyHash = hash(raw.idempotencyKey);
  const fingerprint = hash(JSON.stringify([raw.commandId, raw.expenseId, raw.expectedRevision]));
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const property = await client.query(
      "SELECT id FROM hotel_catalog.properties WHERE id=$1::uuid FOR UPDATE",
      [raw.propertyId],
    );
    if (property.rowCount !== 1) return stop(client, { ok: false, code: "not_found" });
    const existing = await client.query<IdempotencyRow>(
      `SELECT status,request_fingerprint_hash AS fingerprint,
              response_body_hash AS "responseHash",idempotency_metadata AS metadata
       FROM platform.idempotency_keys
       WHERE operation_scope='finance' AND operation=$1 AND key_hash=$2
         AND tenant_scope='property' AND property_id=$3::uuid FOR UPDATE`,
      [ARCHIVE_OPERATION, keyHash, raw.propertyId],
    );
    if (existing.rows[0]) return stop(client, replay(existing.rows[0], fingerprint));
    const reserved = await client.query<{ id: string }>(
      `INSERT INTO platform.idempotency_keys
         (operation_scope,operation,key_hash,request_fingerprint_hash,status,
          tenant_scope,property_id,correlation_id,expires_at)
       VALUES ('finance',$1,$2,$3,'in_progress','property',$4::uuid,$5,'infinity')
       ON CONFLICT DO NOTHING RETURNING id::text`,
      [
        ARCHIVE_OPERATION,
        keyHash,
        fingerprint,
        raw.propertyId,
        raw.audit.correlationId ?? raw.audit.requestId,
      ],
    );
    if (!reserved.rows[0]) return stop(client, { ok: false, code: "idempotency_conflict" });
    const zone = await client.query<{ timeZone: string; incurredOn: string }>(
      `SELECT location.timezone AS "timeZone",
              ($2::timestamptz AT TIME ZONE location.timezone)::date::text AS "incurredOn"
       FROM hotel_catalog.property_locations location
       JOIN pg_timezone_names zone ON zone.name=location.timezone
       WHERE location.property_id=$1::uuid FOR SHARE OF location`,
      [raw.propertyId, acceptedAt],
    );
    if (!zone.rows[0] || !canonicalTimeZone(zone.rows[0].timeZone))
      return stop(client, { ok: false, code: "evidence_mismatch" });
    const found = await client.query<StoredExpense>(
      `SELECT ${COLUMNS},entry_kind AS "entryKind",notes,
              receipt_media_id::text AS "receiptMediaId",
              EXISTS (SELECT 1 FROM finance.expenses child
                WHERE child.reverses_expense_id=e.id) AS reversed
       FROM finance.expenses e
       WHERE e.id=$1::uuid AND e.property_id=$2::uuid AND e.origin='manual' FOR UPDATE`,
      [raw.expenseId, raw.propertyId],
    );
    const previous = found.rows[0];
    if (!previous) return stop(client, { ok: false, code: "not_found" });
    if (
      previous.revision !== raw.expectedRevision ||
      previous.entryKind === "reversal" ||
      previous.reversed
    )
      return stop(client, { ok: false, code: "revision_conflict" });
    let next: FinanceExpense;
    try {
      const inserted = await client.query<FinanceExpense>(
        `INSERT INTO finance.expenses
           (id,property_id,category_id,origin,entry_kind,incurred_on,paid_on,vendor,
            amount,currency,payment_status,source_key,reverses_expense_id,notes)
         VALUES ($1::uuid,$2::uuid,$3::uuid,'manual','reversal',$4::date,$5::date,$6,
                 $7::numeric,$8,$9,$10,$11::uuid,$12)
         RETURNING ${COLUMNS}`,
        [
          raw.commandId,
          raw.propertyId,
          previous.categoryId,
          zone.rows[0].incurredOn,
          previous.paidOn,
          previous.vendor,
          previous.amount.amount,
          previous.amount.currency,
          previous.paymentStatus,
          `${ARCHIVE_OPERATION}:${raw.commandId}`,
          previous.id,
          previous.notes,
        ],
      );
      next = inserted.rows[0]!;
    } catch (error) {
      const name = constraint(error);
      if (name === "expenses_pkey")
        return stop(client, { ok: false, code: "idempotency_conflict" });
      if (
        ["uq_finance_expenses_reverses", "uq_finance_expenses_generated_source"].includes(
          String(name),
        )
      )
        return stop(client, { ok: false, code: "revision_conflict" });
      throw error;
    }
    const result = { ok: true as const, outcome: "archived" as const, item: next };
    const actor = raw.audit.actor;
    await client.query(
      `INSERT INTO platform.product_audit_events
         (audit_key,product,action,occurred_at,tenant_scope,property_id,actor_type,
          actor_user_id,target_resource_product,target_resource_type,target_resource_id,
          idempotency_key_id,correlation_id,causation_id,redacted_payload,
          retention_class,privacy_scope)
       VALUES ($1,'finance',$2,$3::timestamptz,'property',$4::uuid,'user',$5::uuid,
               'finance','expense',$6,$7::uuid,$8,$9,$10::jsonb,'financial','confidential')`,
      [
        `${ARCHIVE_OPERATION}.property.${raw.propertyId}.expense.${next.id}.key.${keyHash}.v1`,
        ARCHIVE_OPERATION,
        acceptedAt,
        raw.propertyId,
        actor.kind === "user" ? actor.userId : null,
        next.id,
        reserved.rows[0].id,
        raw.audit.correlationId ?? raw.audit.requestId,
        raw.audit.requestId,
        JSON.stringify({
          commandId: raw.commandId,
          previousExpenseId: previous.id,
          expenseId: next.id,
          outcome: "archived",
          acceptedAt,
          propertyTimeZone: zone.rows[0].timeZone,
          previous,
          next: {
            ...next,
            entryKind: "reversal",
            notes: previous.notes,
            receiptMediaId: null,
          },
          actorOrganizationId: actor.kind === "user" ? actor.organizationId : null,
          requestedAt: raw.audit.requestedAt,
          reason: raw.audit.reason,
        }),
      ],
    );
    const completed = await client.query(
      `UPDATE platform.idempotency_keys SET status='completed',response_status_code=200,
         response_body_hash=$2,completed_at=$3::timestamptz,
         response_resource_product='finance',response_resource_type='expense',
         response_resource_id=$4,idempotency_metadata=jsonb_build_object('result',$5::jsonb)
       WHERE id=$1::uuid AND status='in_progress'`,
      [reserved.rows[0].id, resultHash(next), acceptedAt, next.id, JSON.stringify(result)],
    );
    if (completed.rowCount !== 1) throw new Error("manual expense idempotency completion failed");
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await rollback(client);
    throw error;
  } finally {
    client.release();
  }
}

function valid(command: CreateFinanceManualExpenseCommand): boolean {
  const { propertyId, receiptMediaId, audit, ...write } = command;
  const actor = audit?.actor;
  return !(
    !parseFinanceExpenseWrite(write) ||
    !uuid(propertyId) ||
    (receiptMediaId !== undefined && !uuid(receiptMediaId)) ||
    actor?.kind !== "user" ||
    !uuid(actor.userId) ||
    !uuid(actor.organizationId) ||
    !trimmed(audit.requestId, 1, 200) ||
    (audit.correlationId !== undefined && !trimmed(audit.correlationId, 1, 200)) ||
    !trimmed(audit.reason, 1, 500) ||
    !utc(audit.requestedAt)
  );
}
function replay(
  row: IdempotencyRow,
  fingerprint: string,
): { ok: true; outcome: "replayed"; item: FinanceExpense } | ExpenseFailure {
  if (row.fingerprint !== fingerprint) return { ok: false, code: "idempotency_conflict" };
  if (row.status !== "completed") return { ok: false, code: "idempotency_conflict" };
  const stored = record(row.metadata) ? row.metadata["result"] : null;
  const item = record(stored) && record(stored["item"]) ? stored["item"] : null;
  if (!item || row.responseHash !== resultHash(item as FinanceExpense))
    throw new Error("manual expense replay evidence is invalid");
  return { ok: true, outcome: "replayed", item: item as FinanceExpense };
}
function validMutation(command: UpdateFinanceManualExpenseCommand): boolean {
  return (
    validMutationBase(command) &&
    !(
      !UPDATE_FIELDS.some((key) => Object.hasOwn(command, key)) ||
      UPDATE_FIELDS.some((key) => key !== "receiptMediaId" && command[key] === null) ||
      (command.categoryId !== undefined && !uuid(command.categoryId)) ||
      (command.receiptMediaId !== undefined &&
        command.receiptMediaId !== null &&
        !uuid(command.receiptMediaId)) ||
      (command.paymentStatus === "unpaid" && command.paidOn !== undefined)
    )
  );
}
function validMutationBase(command: MutationBase): boolean {
  const actor = command.audit?.actor;
  return !(
    !uuid(command.commandId) ||
    !trimmed(command.idempotencyKey, 1, 200) ||
    !uuid(command.propertyId) ||
    !uuid(command.expenseId) ||
    !Number.isSafeInteger(command.expectedRevision) ||
    command.expectedRevision < 1 ||
    command.expectedRevision > 2_147_483_647 ||
    actor?.kind !== "user" ||
    !uuid(actor.userId) ||
    !uuid(actor.organizationId) ||
    !trimmed(command.audit.requestId, 1, 200) ||
    (command.audit.correlationId !== undefined && !trimmed(command.audit.correlationId, 1, 200)) ||
    !trimmed(command.audit.reason, 1, 500) ||
    !utc(command.audit.requestedAt)
  );
}
function resultHash(value: FinanceExpense): string {
  return hash(JSON.stringify(value, [...Object.keys(value), "amount", "currency"].sort()));
}
function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function constraint(value: unknown): unknown {
  return (value as { constraint?: unknown } | null)?.constraint;
}
function uuid(value: unknown): value is string {
  return typeof value === "string" && UUID.test(value);
}
function trimmed(value: unknown, min: number, max: number): value is string {
  if (typeof value !== "string") return false;
  return value === value.trim() && value.length >= min && value.length <= max;
}
function utc(value: unknown): value is string {
  return typeof value === "string" && UTC.test(value) && Number.isFinite(Date.parse(value));
}
function canonicalTimeZone(value: unknown): value is string {
  if (typeof value !== "string") return false;
  try {
    const zone = getTimezone(value);
    return zone !== null && zone.name === value && zone.aliasOf === null;
  } catch {
    return false;
  }
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
