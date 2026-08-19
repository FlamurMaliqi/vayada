import { createHash } from "node:crypto";

// prettier-ignore
import { parseFinanceExpenseWrite, type FinanceCommandAudit, type FinanceExpense,
  type FinanceExpenseCommandResult, type FinanceExpenseWrite } from "@vayada/domain-finance";
import { getTimezone } from "countries-and-timezones";
import pg from "pg";

// prettier-ignore
export type CreateFinanceManualExpenseCommand = Omit<FinanceExpenseWrite,
  "expectedRevision" | "supplierInvoiceNumber" | "recurrence"> &
  { propertyId: string; receiptMediaId?: string; audit: FinanceCommandAudit };
export type CreateFinanceManualExpenseResult = FinanceExpenseCommandResult<FinanceExpense>;
type ExpenseFailure = Extract<FinanceExpenseCommandResult<FinanceExpense>, { ok: false }>;
// prettier-ignore
type MutationBase = { commandId: string; idempotencyKey: string; expectedRevision: number;
  propertyId: string; expenseId: string; audit: FinanceCommandAudit };
// prettier-ignore
export type UpdateFinanceManualExpenseCommand = MutationBase & Partial<Pick<FinanceExpenseWrite,
  "incurredOn" | "vendor" | "categoryId" | "amount" | "paymentStatus" | "paidOn" | "notes">> &
  { receiptMediaId?: string | null };
export type MutateFinanceManualExpenseResult =
  | { ok: true; outcome: "updated" | "corrected" | "replayed"; item: FinanceExpense }
  | ExpenseFailure;
export type ArchiveFinanceManualExpenseCommand = MutationBase;
export type ArchiveFinanceManualExpenseResult =
  | { ok: true; outcome: "archived" | "replayed"; item: FinanceExpense }
  | ExpenseFailure;

// prettier-ignore
type IdempotencyRow = { status: string; fingerprint: string; responseHash: string | null; metadata: unknown };
// prettier-ignore
type StoredExpense = FinanceExpense & { entryKind: "expense" | "correction" | "reversal";
  notes: string | null; receiptMediaId: string | null; reversed: boolean };
const OPERATION = "finance.manual_expense.create";
const UPDATE_OPERATION = "finance.manual_expense.update";
const ARCHIVE_OPERATION = "finance.manual_expense.archive";
const RESOURCE_LOCK = "finance.manual_expense";
// prettier-ignore
const UPDATE_FIELDS = ["incurredOn", "vendor", "categoryId", "amount", "paymentStatus",
  "paidOn", "notes", "receiptMediaId"] as const;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;
const COLUMNS = `id::text, category_id::text AS "categoryId", origin, incurred_on::text AS "incurredOn",
  paid_on::text AS "paidOn", vendor, jsonb_build_object('amount',amount::text,'currency',currency::text) AS amount,
  payment_status AS "paymentStatus", recurring_rule_id::text AS "recurringRuleId", source_key AS "sourceKey",
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
      const fingerprint = commandFingerprint(raw);
      const lockKey = `${OPERATION}|${raw.propertyId.toLowerCase()}|${keyHash}`;
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        await client.query("SET LOCAL lock_timeout='3s'; SET LOCAL statement_timeout='10s'");
        await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [lockKey]);
        const property = await client.query(
          "SELECT id FROM hotel_catalog.properties WHERE id=$1::uuid FOR KEY SHARE",
          [raw.propertyId],
        );
        if (property.rowCount !== 1) return await stop(client, { ok: false, code: "not_found" });
        const existing = await client.query<IdempotencyRow>(
          `SELECT status,request_fingerprint_hash AS fingerprint,
                  response_body_hash AS "responseHash",idempotency_metadata AS metadata
           FROM platform.idempotency_keys
           WHERE operation_scope='finance' AND operation=$1 AND key_hash=$2
             AND tenant_scope='property' AND property_id=$3::uuid FOR UPDATE`,
          [OPERATION, keyHash, raw.propertyId],
        );
        if (existing.rows[0]) return await stop(client, replay(existing.rows[0], fingerprint));
        const reserved = await client.query<{ id: string }>(
          `INSERT INTO platform.idempotency_keys
             (operation_scope,operation,key_hash,request_fingerprint_hash,status,
              tenant_scope,property_id,correlation_id,expires_at)
           VALUES ('finance',$1,$2,$3,'in_progress','property',$4::uuid,$5,'infinity')
           ON CONFLICT DO NOTHING RETURNING id::text`,
          // prettier-ignore
          [OPERATION, keyHash, fingerprint, raw.propertyId, raw.audit.correlationId ?? raw.audit.requestId],
        );
        if (!reserved.rows[0])
          return await stop(client, { ok: false, code: "idempotency_conflict" });

        const category = await client.query<{ archivedAt: unknown; receiptActive: boolean }>(
          `SELECT archived_at AS "archivedAt",$3::uuid IS NULL OR COALESCE((
             SELECT lifecycle_status='active' FROM platform.media_objects
             WHERE id=$3::uuid AND property_id=$2::uuid AND purpose='finance.expense.receipt' AND resource_product='finance' AND resource_type='expense' AND resource_id=$4::uuid::text FOR SHARE),FALSE) AS "receiptActive"
           FROM finance.expense_categories
           WHERE id=$1::uuid AND property_id=$2::uuid`,
          [raw.categoryId, raw.propertyId, raw.receiptMediaId ?? null, raw.commandId],
        );
        // prettier-ignore
        if (!category.rows[0] || category.rows[0].archivedAt !== null || !category.rows[0].receiptActive)
          return await stop(client, { ok: false, code: "evidence_mismatch" });

        let inserted: pg.QueryResult<FinanceExpense>;
        try {
          inserted = await client.query<FinanceExpense>(
            `INSERT INTO finance.expenses
               (id,property_id,category_id,origin,incurred_on,vendor,amount,currency,
                payment_status,paid_on,notes,receipt_media_id)
             VALUES ($1::uuid,$2::uuid,$3::uuid,'manual',$4::date,$5,$6::numeric,
                     $7,$8,$9::date,$10,$11::uuid)
             RETURNING ${COLUMNS}`,
            // prettier-ignore
            [raw.commandId, raw.propertyId, raw.categoryId, raw.incurredOn, raw.vendor,
              raw.amount.amount, raw.amount.currency, raw.paymentStatus, raw.paidOn ?? null,
              raw.notes ?? null, raw.receiptMediaId ?? null],
          );
        } catch (error) {
          const name = constraint(error);
          if (name === "expenses_pkey")
            return await stop(client, { ok: false, code: "idempotency_conflict" });
          if (name === "fk_finance_expenses_pricing_currency")
            return await stop(client, { ok: false, code: "currency_mismatch" });
          if (name === "fk_finance_expenses_receipt")
            return await stop(client, { ok: false, code: "evidence_mismatch" });
          throw error;
        }
        const expense = inserted.rows[0]!;
        const result = { ok: true as const, outcome: "created" as const, item: expense };
        const actor = raw.audit.actor;
        await client.query(
          `INSERT INTO platform.product_audit_events
             (audit_key,product,action,occurred_at,tenant_scope,property_id,actor_type,
              actor_user_id,target_resource_product,target_resource_type,target_resource_id,
              idempotency_key_id,correlation_id,causation_id,redacted_payload,private_payload,
              audit_metadata,retention_class,privacy_scope)
           VALUES ($1,'finance',$2,$3::timestamptz,'property',$4::uuid,'user',$5::uuid,
                   'finance','expense',$6,$7::uuid,$8,$9,$10::jsonb,
                   jsonb_build_object('reason',$11::text),
                   jsonb_build_object('requestId',$9::text,'requestedAt',$12::text,'actorOrganizationId',$13::text),
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
            // prettier-ignore
            JSON.stringify({ commandId: raw.commandId, expenseId: expense.id, revision: expense.revision }),
            raw.audit.reason,
            raw.audit.requestedAt,
            actor.kind === "user" ? actor.organizationId : null,
          ],
        );
        const completed = await client.query(
          `UPDATE platform.idempotency_keys SET status='completed',response_status_code=200,
             response_body_hash=$2,completed_at=$3::timestamptz,
             response_resource_product='finance',response_resource_type='expense',
             response_resource_id=$4,idempotency_metadata=jsonb_build_object('result',$5::jsonb)
           WHERE id=$1::uuid AND status='in_progress'`,
          // prettier-ignore
          [reserved.rows[0].id, resultHash(expense), acceptedAt, expense.id, JSON.stringify(result)],
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

// prettier-ignore
async function mutate(pool: pg.Pool, raw: UpdateFinanceManualExpenseCommand): Promise<MutateFinanceManualExpenseResult> {
  if (!validMutation(raw)) return { ok: false, code: "invalid_command" };
  const acceptedAt = new Date().toISOString();
  const keyHash = hash(raw.idempotencyKey);
  // prettier-ignore
  const fields = UPDATE_FIELDS.map((key) => !Object.hasOwn(raw, key) ? [false] :
    key === "amount" && raw.amount ? [true, raw.amount.amount, raw.amount.currency] :
    (key === "categoryId" || key === "receiptMediaId") && typeof raw[key] === "string" ? [true, raw[key].toLowerCase()] : [true, raw[key] ?? null]);
  // prettier-ignore
  const fingerprint = hash(JSON.stringify([raw.commandId.toLowerCase(), raw.expenseId.toLowerCase(), raw.expectedRevision, fields]));
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL lock_timeout='3s'; SET LOCAL statement_timeout='10s'");
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [`${UPDATE_OPERATION}|${raw.propertyId.toLowerCase()}|${keyHash}`]);
    const property = await client.query(
      "SELECT id FROM hotel_catalog.properties WHERE id=$1::uuid FOR KEY SHARE",
      [raw.propertyId],
    );
    if (property.rowCount !== 1) return await stop(client, { ok: false, code: "not_found" });
    const existing = await client.query<IdempotencyRow>(
      `SELECT status,request_fingerprint_hash AS fingerprint,
              response_body_hash AS "responseHash",idempotency_metadata AS metadata
       FROM platform.idempotency_keys
       WHERE operation_scope='finance' AND operation=$1 AND key_hash=$2
         AND tenant_scope='property' AND property_id=$3::uuid FOR UPDATE`,
      [UPDATE_OPERATION, keyHash, raw.propertyId],
    );
    if (existing.rows[0]) return await stop(client, replayMutation(existing.rows[0], fingerprint));
    const reserved = await client.query<{ id: string }>(
      `INSERT INTO platform.idempotency_keys
         (operation_scope,operation,key_hash,request_fingerprint_hash,status,
          tenant_scope,property_id,correlation_id,expires_at)
       VALUES ('finance',$1,$2,$3,'in_progress','property',$4::uuid,$5,'infinity')
       ON CONFLICT DO NOTHING RETURNING id::text`,
      // prettier-ignore
      [UPDATE_OPERATION, keyHash, fingerprint, raw.propertyId, raw.audit.correlationId ?? raw.audit.requestId],
    );
    if (!reserved.rows[0]) return await stop(client, { ok: false, code: "idempotency_conflict" });
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
      `${RESOURCE_LOCK}|${raw.propertyId.toLowerCase()}|${raw.expenseId.toLowerCase()}`,
    ]);
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
    if (!previous) return await stop(client, { ok: false, code: "not_found" });
    // prettier-ignore
    if (previous.revision !== raw.expectedRevision || previous.entryKind === "reversal" || previous.reversed)
      return await stop(client, { ok: false, code: "revision_conflict" });
    // prettier-ignore
    const receiptChanged = Object.hasOwn(raw, "receiptMediaId") && (raw.receiptMediaId?.toLowerCase() ?? null) !== previous.receiptMediaId;
    const categoryChanged = raw.categoryId !== undefined && raw.categoryId.toLowerCase() !== previous.categoryId;
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
    if (!merged) return await stop(client, { ok: false, code: "invalid_command" });
    // prettier-ignore
    const correction = (raw.incurredOn !== undefined && raw.incurredOn !== previous.incurredOn) ||
      categoryChanged ||
      (raw.vendor !== undefined && raw.vendor !== previous.vendor) ||
      (raw.amount !== undefined && (raw.amount.amount !== previous.amount.amount || raw.amount.currency !== previous.amount.currency)) || receiptChanged;
    if (!correction && previous.revision === 2_147_483_647)
      return await stop(client, { ok: false, code: "revision_conflict" });
    const evidence = await client.query<{ categoryOk: boolean; receiptOk: boolean }>(
      `SELECT $1::uuid IS NULL OR EXISTS (
          SELECT 1 FROM finance.expense_categories
          WHERE id=$1::uuid AND property_id=$2::uuid AND archived_at IS NULL
        ) AS "categoryOk",
        $3::uuid IS NULL OR COALESCE((
          SELECT lifecycle_status='active' FROM platform.media_objects
          WHERE id=$3::uuid AND property_id=$2::uuid AND purpose='finance.expense.receipt'
            AND resource_product='finance' AND resource_type='expense'
            AND resource_id=$4::uuid::text FOR SHARE
        ),FALSE) AS "receiptOk"`,
      // prettier-ignore
      [categoryChanged ? (raw.categoryId ?? null) : null,
        raw.propertyId, receiptChanged ? raw.receiptMediaId : null, raw.commandId],
    );
    if (!evidence.rows[0]?.categoryOk || !evidence.rows[0].receiptOk)
      return await stop(client, { ok: false, code: "evidence_mismatch" });
    let next: FinanceExpense;
    try {
      if (!correction) {
        const updated = await client.query<FinanceExpense>(
          `UPDATE finance.expenses SET payment_status=$3,paid_on=$4::date,notes=$5,
             revision=revision+1,updated_at=$6::timestamptz
           WHERE id=$1::uuid AND property_id=$2::uuid AND revision=$7
           RETURNING ${COLUMNS}`,
          // prettier-ignore
          [raw.expenseId, raw.propertyId, merged!.paymentStatus, merged!.paidOn ?? null,
            merged!.notes ?? null, acceptedAt, raw.expectedRevision],
        );
        if (!updated.rows[0]) return await stop(client, { ok: false, code: "revision_conflict" });
        next = updated.rows[0];
      } else {
        const inserted = await client.query<FinanceExpense>(
          `INSERT INTO finance.expenses
             (id,property_id,category_id,origin,entry_kind,incurred_on,paid_on,vendor,
              amount,currency,payment_status,source_key,reverses_expense_id,receipt_media_id,notes)
           VALUES ($1::uuid,$2::uuid,$3::uuid,'manual',$4,$5::date,$6::date,$7,
                   $8::numeric,$9,$10,$11,$12::uuid,$13::uuid,$14)
           RETURNING ${COLUMNS}`,
          // prettier-ignore
          [raw.commandId, raw.propertyId, merged.categoryId, "correction", merged.incurredOn,
            merged.paidOn, merged.vendor, merged.amount.amount, merged.amount.currency,
            merged.paymentStatus, `${UPDATE_OPERATION}:${raw.commandId.toLowerCase()}`, previous.id,
            receiptChanged ? raw.receiptMediaId : null, merged.notes ?? null],
        );
        next = inserted.rows[0]!;
      }
    } catch (error) {
      const name = constraint(error);
      if (name === "expenses_pkey")
        return await stop(client, { ok: false, code: "idempotency_conflict" });
      if (
        ["uq_finance_expenses_reverses", "uq_finance_expenses_generated_source"].includes(
          String(name),
        )
      )
        return await stop(client, { ok: false, code: "revision_conflict" });
      if (name === "fk_finance_expenses_pricing_currency")
        return await stop(client, { ok: false, code: "currency_mismatch" });
      if (
        ["fk_finance_expenses_category_property", "fk_finance_expenses_receipt"].includes(
          String(name),
        )
      )
        return await stop(client, { ok: false, code: "evidence_mismatch" });
      throw error;
    }
    const outcome: "corrected" | "updated" = correction ? "corrected" : "updated";
    const result = { ok: true as const, outcome, item: next };
    const actor = raw.audit.actor;
    // prettier-ignore
    const redacted = { commandId: raw.commandId, previousExpenseId: previous.id,
      expenseId: next.id, outcome, revision: next.revision };
    // prettier-ignore
    const privateEvidence = { reason: raw.audit.reason, previous, next: { ...next,
      notes: merged.notes ?? null, receiptMediaId: correction ? (receiptChanged ? raw.receiptMediaId?.toLowerCase() ?? null : null) : previous.receiptMediaId } };
    await client.query(
      `INSERT INTO platform.product_audit_events
         (audit_key,product,action,occurred_at,tenant_scope,property_id,actor_type,
          actor_user_id,target_resource_product,target_resource_type,target_resource_id,
          idempotency_key_id,correlation_id,causation_id,redacted_payload,private_payload,
          audit_metadata,retention_class,privacy_scope)
       VALUES ($1,'finance',$2,$3::timestamptz,'property',$4::uuid,'user',$5::uuid,
               'finance','expense',$6,$7::uuid,$8,$9,$10::jsonb,$11::jsonb,
               jsonb_build_object('requestId',$9::text,'requestedAt',$12::text,'actorOrganizationId',$13::text),
               'financial','confidential')`,
      // prettier-ignore
      [`${UPDATE_OPERATION}.property.${raw.propertyId.toLowerCase()}.expense.${next.id}.key.${keyHash}.v1`,
        UPDATE_OPERATION, acceptedAt, raw.propertyId, actor.kind === "user" ? actor.userId : null,
        next.id, reserved.rows[0].id, raw.audit.correlationId ?? raw.audit.requestId,
        raw.audit.requestId, JSON.stringify(redacted), JSON.stringify(privateEvidence),
        raw.audit.requestedAt, actor.kind === "user" ? actor.organizationId : null],
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
    // prettier-ignore
    if (["55P03", "57014"].includes(String((error as { code?: unknown }).code))) return { ok: false, code: "write_unavailable" };
    throw error;
  } finally {
    client.release();
  }
}

// prettier-ignore
async function archive(pool: pg.Pool, raw: ArchiveFinanceManualExpenseCommand,
  clock: () => Date): Promise<ArchiveFinanceManualExpenseResult> {
  if (!validArchive(raw)) return { ok: false, code: "invalid_command" };
  const acceptedAt = clock().toISOString();
  const propertyId = raw.propertyId.toLowerCase();
  const expenseId = raw.expenseId.toLowerCase();
  const commandId = raw.commandId.toLowerCase();
  const keyHash = hash(raw.idempotencyKey);
  const fingerprint = hash(JSON.stringify([commandId, expenseId, raw.expectedRevision]));
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL lock_timeout='3s'; SET LOCAL statement_timeout='10s'");
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
      `${ARCHIVE_OPERATION}|${propertyId}|${keyHash}`,
    ]);
    const property = await client.query(
      "SELECT id FROM hotel_catalog.properties WHERE id=$1::uuid FOR KEY SHARE",
      [propertyId],
    );
    if (property.rowCount !== 1) return await stop(client, { ok: false, code: "not_found" });
    const existing = await client.query<IdempotencyRow & { resourceId: string | null }>(
      `SELECT status,request_fingerprint_hash AS fingerprint,
              response_body_hash AS "responseHash",idempotency_metadata AS metadata,
              response_resource_id::text AS "resourceId"
       FROM platform.idempotency_keys
       WHERE operation_scope='finance' AND operation=$1 AND key_hash=$2
         AND tenant_scope='property' AND property_id=$3::uuid FOR UPDATE`,
      [ARCHIVE_OPERATION, keyHash, propertyId],
    );
    if (existing.rows[0])
      return await stop(client, replayArchive(existing.rows[0], fingerprint, commandId, expenseId));
    const reserved = await client.query<{ id: string }>(
      `INSERT INTO platform.idempotency_keys
         (operation_scope,operation,key_hash,request_fingerprint_hash,status,
          tenant_scope,property_id,correlation_id,expires_at)
       VALUES ('finance',$1,$2,$3,'in_progress','property',$4::uuid,$5,'infinity')
       ON CONFLICT DO NOTHING RETURNING id::text`,
      // prettier-ignore
      [ARCHIVE_OPERATION, keyHash, fingerprint, propertyId,
        raw.audit.correlationId ?? raw.audit.requestId],
    );
    if (!reserved.rows[0])
      return await stop(client, { ok: false, code: "idempotency_conflict" });
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
      `${RESOURCE_LOCK}|${propertyId}|${expenseId}`,
    ]);
    const zone = await client.query<{ timeZone: unknown }>(
      `SELECT timezone AS "timeZone" FROM hotel_catalog.property_locations
       WHERE property_id=$1::uuid FOR SHARE`,
      [propertyId],
    );
    if (!canonicalTimeZone(zone.rows[0]?.timeZone))
      return await stop(client, { ok: false, code: "evidence_mismatch" });
    const date = await client.query<{ incurredOn: string }>(
      `SELECT ($1::timestamptz AT TIME ZONE zone.name)::date::text AS "incurredOn" FROM pg_timezone_names zone WHERE zone.name=$2`,
      [acceptedAt, zone.rows[0].timeZone],
    );
    if (!date.rows[0]) return await stop(client, { ok: false, code: "evidence_mismatch" });
    const found = await client.query<StoredExpense>(
      `SELECT ${COLUMNS},entry_kind AS "entryKind",notes,
              receipt_media_id::text AS "receiptMediaId",
              EXISTS (SELECT 1 FROM finance.expenses child
                WHERE child.reverses_expense_id=e.id) AS reversed
       FROM finance.expenses e
       WHERE e.id=$1::uuid AND e.property_id=$2::uuid AND e.origin='manual' FOR UPDATE`,
      [expenseId, propertyId],
    );
    const previous = found.rows[0];
    if (!previous) return await stop(client, { ok: false, code: "not_found" });
    // prettier-ignore
    if (previous.revision !== raw.expectedRevision || previous.entryKind === "reversal" || previous.reversed)
      return await stop(client, { ok: false, code: "revision_conflict" });
    let next: FinanceExpense;
    try {
      const inserted = await client.query<FinanceExpense>(
        `INSERT INTO finance.expenses
           (id,property_id,category_id,origin,entry_kind,incurred_on,paid_on,vendor,
            amount,currency,payment_status,source_key,reverses_expense_id,notes)
         VALUES ($1::uuid,$2::uuid,$3::uuid,'manual','reversal',$4::date,$5::date,$6,
                 $7::numeric,$8,$9,$10,$11::uuid,$12)
         RETURNING ${COLUMNS}`,
        // prettier-ignore
        [commandId, propertyId, previous.categoryId, date.rows[0]!.incurredOn,
          previous.paidOn, previous.vendor, previous.amount.amount, previous.amount.currency,
          previous.paymentStatus, `${ARCHIVE_OPERATION}:${commandId}`, previous.id, previous.notes],
      );
      next = inserted.rows[0]!;
    } catch (error) {
      const name = constraint(error);
      if (name === "expenses_pkey")
        return await stop(client, { ok: false, code: "idempotency_conflict" });
      if (
        ["uq_finance_expenses_reverses", "uq_finance_expenses_generated_source"].includes(
          String(name),
        )
      )
        return await stop(client, { ok: false, code: "revision_conflict" });
      throw error;
    }
    const result = { ok: true as const, outcome: "archived" as const, item: next };
    const actor = raw.audit.actor;
    // prettier-ignore
    const redacted = { commandId: next.id, previousExpenseId: previous.id,
      expenseId: next.id, outcome: "archived", revision: next.revision };
    // prettier-ignore
    const privateEvidence = { reason: raw.audit.reason, acceptedAt,
      propertyTimeZone: zone.rows[0].timeZone, previous,
      next: { ...next, entryKind: "reversal", notes: previous.notes, receiptMediaId: null } };
    await client.query(
      `INSERT INTO platform.product_audit_events
         (audit_key,product,action,occurred_at,tenant_scope,property_id,actor_type,
          actor_user_id,target_resource_product,target_resource_type,target_resource_id,
          idempotency_key_id,correlation_id,causation_id,redacted_payload,private_payload,
          audit_metadata,retention_class,privacy_scope)
       VALUES ($1,'finance',$2,$3::timestamptz,'property',$4::uuid,'user',$5::uuid,
               'finance','expense',$6,$7::uuid,$8,$9,$10::jsonb,$11::jsonb,
               jsonb_build_object('requestId',$9::text,'requestedAt',$12::text,'actorOrganizationId',$13::text),
               'financial','confidential')`,
      // prettier-ignore
      [`${ARCHIVE_OPERATION}.property.${propertyId}.expense.${next.id}.key.${keyHash}.v1`,
        ARCHIVE_OPERATION, acceptedAt, propertyId, actor.kind === "user" ? actor.userId.toLowerCase() : null,
        next.id, reserved.rows[0].id, raw.audit.correlationId ?? raw.audit.requestId,
        raw.audit.requestId, JSON.stringify(redacted), JSON.stringify(privateEvidence),
        raw.audit.requestedAt, actor.kind === "user" ? actor.organizationId.toLowerCase() : null],
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
    // prettier-ignore
    if (["55P03", "57014"].includes(String((error as { code?: unknown }).code))) return { ok: false, code: "write_unavailable" };
    throw error;
  } finally {
    client.release();
  }
}

function valid(command: CreateFinanceManualExpenseCommand): boolean {
  // prettier-ignore
  if (!exact(command, "commandId idempotencyKey propertyId categoryId incurredOn vendor amount paymentStatus paidOn notes receiptMediaId audit")) return false;
  const { propertyId, receiptMediaId, audit, ...write } = command;
  const actor = audit?.actor;
  return !(
    !parseFinanceExpenseWrite(write) ||
    !exact(audit, "actor requestId correlationId reason requestedAt") ||
    !exact(actor, "kind userId organizationId") ||
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
  const item =
    exact(stored, "ok outcome item") && stored["ok"] === true && stored["outcome"] === "created"
      ? stored["item"]
      : null;
  const parsed = storedExpense(item, "created");
  if (!parsed || row.responseHash !== resultHash(parsed))
    throw new Error("manual expense replay evidence is invalid");
  return { ok: true, outcome: "replayed", item: parsed };
}
function replayMutation(
  row: IdempotencyRow,
  fingerprint: string,
): MutateFinanceManualExpenseResult {
  if (row.fingerprint !== fingerprint || row.status !== "completed")
    return { ok: false, code: "idempotency_conflict" };
  const stored = record(row.metadata) ? row.metadata["result"] : null;
  const outcome =
    exact(stored, "ok outcome item") &&
    stored["ok"] === true &&
    (stored["outcome"] === "updated" || stored["outcome"] === "corrected")
      ? stored["outcome"]
      : null;
  const parsed = outcome && record(stored) ? storedExpense(stored["item"], outcome) : null;
  if (!parsed || row.responseHash !== resultHash(parsed))
    throw new Error("manual expense replay evidence is invalid");
  return { ok: true, outcome: "replayed", item: parsed };
}
function replayArchive(
  row: IdempotencyRow & { resourceId: string | null },
  fingerprint: string,
  commandId: string,
  expenseId: string,
): ArchiveFinanceManualExpenseResult {
  if (row.fingerprint !== fingerprint || row.status !== "completed")
    return { ok: false, code: "idempotency_conflict" };
  const stored = record(row.metadata) ? row.metadata["result"] : null;
  const item =
    exact(stored, "ok outcome item") && stored["ok"] === true && stored["outcome"] === "archived"
      ? stored["item"]
      : null;
  const parsed = storedExpense(item, "archived");
  if (
    !parsed ||
    parsed.id !== commandId ||
    parsed.reversesExpenseId !== expenseId ||
    row.resourceId !== commandId ||
    row.responseHash !== resultHash(parsed)
  )
    throw new Error("manual expense archive replay evidence is invalid");
  return { ok: true, outcome: "replayed", item: parsed };
}
// prettier-ignore
function storedExpense(value: unknown, outcome: "created" | "updated" | "corrected" | "archived"): FinanceExpense | null {
  // prettier-ignore
  if (!exact(value, "id categoryId origin incurredOn paidOn vendor amount paymentStatus recurringRuleId sourceKey reversesExpenseId revision") ||
    value.origin !== "manual" || value.recurringRuleId !== null ||
    !Number.isSafeInteger(value.revision) || Number(value.revision) < 1 || Number(value.revision) > 2_147_483_647 ||
    (outcome === "created" && (value.sourceKey !== null || value.reversesExpenseId !== null || value.revision !== 1)) ||
    (outcome === "updated" && (Number(value.revision) < 2 || !((value.sourceKey === null && value.reversesExpenseId === null) ||
      (value.sourceKey === `${UPDATE_OPERATION}:${String(value.id)}` && uuid(value.reversesExpenseId))))) ||
    (outcome === "corrected" && (value.sourceKey !== `${UPDATE_OPERATION}:${String(value.id)}` || !uuid(value.reversesExpenseId) || value.revision !== 1)) ||
    (outcome === "archived" && (value.sourceKey !== `${ARCHIVE_OPERATION}:${String(value.id)}` || !uuid(value.reversesExpenseId) || value.revision !== 1)))
    return null;
  const write = parseFinanceExpenseWrite({
    commandId: value.id,
    idempotencyKey: "replay",
    categoryId: value.categoryId,
    incurredOn: value.incurredOn,
    vendor: value.vendor,
    amount: value.amount,
    paymentStatus: value.paymentStatus,
    paidOn: value.paidOn,
  });
  return write ? (value as FinanceExpense) : null;
}
function validMutation(command: UpdateFinanceManualExpenseCommand): boolean {
  return !(
    !validMutationBase(
      command,
      "commandId idempotencyKey expectedRevision propertyId expenseId audit incurredOn vendor categoryId amount paymentStatus paidOn notes receiptMediaId",
    ) ||
    !UPDATE_FIELDS.some((key) => Object.hasOwn(command, key)) ||
    UPDATE_FIELDS.some((key) => key !== "receiptMediaId" && command[key] === null) ||
    (command.categoryId !== undefined && !uuid(command.categoryId)) ||
    (command.receiptMediaId !== undefined &&
      command.receiptMediaId !== null &&
      !uuid(command.receiptMediaId)) ||
    (command.paymentStatus === "unpaid" && command.paidOn !== undefined)
  );
}
function validArchive(command: ArchiveFinanceManualExpenseCommand): boolean {
  return validMutationBase(
    command,
    "commandId idempotencyKey expectedRevision propertyId expenseId audit",
  );
}
function validMutationBase(command: MutationBase, allowed: string): boolean {
  const actor = command.audit?.actor;
  return !(
    !exact(command, allowed) ||
    !exact(command.audit, "actor requestId correlationId reason requestedAt") ||
    !exact(actor, "kind userId organizationId") ||
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
// prettier-ignore
function commandFingerprint(raw: CreateFinanceManualExpenseCommand): string { return hash(JSON.stringify([
  raw.commandId, raw.categoryId, raw.incurredOn, raw.vendor, raw.amount.amount, raw.amount.currency,
  raw.paymentStatus, raw.paidOn ?? null, raw.notes ?? null, raw.receiptMediaId ?? null])); }
function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function exact(value: unknown, allowed: string): value is Record<string, unknown> {
  return record(value) && Object.keys(value).every((key) => allowed.split(" ").includes(key));
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
  if (typeof value !== "string" || value.startsWith("0000-") || !UTC.test(value)) return false;
  const parsed = new Date(value);
  return (
    Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 19) === value.slice(0, 19)
  );
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
