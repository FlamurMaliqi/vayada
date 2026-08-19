import { getTimezone } from "countries-and-timezones";
import pg, { type QueryResult, type QueryResultRow } from "pg";

import {
  PMS_FINANCIALS_CONTRACT_VERSION,
  parseFinanceExpenseQuery,
  type FinanceExpense,
  type FinanceExpenseCategory,
  type FinanceExpenseEnvelope,
  type FinanceExpenseIncompleteEvidence,
  type FinanceExpenseQuery,
  type FinanceRecurringExpenseRule,
} from "@vayada/domain-finance";
import { PMS_PRICING_CONTRACT_VERSION, type PmsPricingReadPort } from "@vayada/domain-pms";

// prettier-ignore
type FinanceReadClient = { query<T extends QueryResultRow = QueryResultRow>(sql: string, values?: readonly unknown[]): Promise<Pick<QueryResult<T>, "rows">>; release(): void };
// prettier-ignore
export type FinanceReadPool = Pick<FinanceReadClient, "query"> & { connect(): Promise<FinanceReadClient>; end?(): Promise<void> };
// prettier-ignore
export type FinanceExpensePropertyContextReadPort = { getPropertyContext(propertyId: string): Promise<{ source: { ownerDomain: "hotel_catalog"; entityType: "property_profile"; entityId: string; revision: string }; timeZone: string | null; updatedAt: string } | null> };
type Money = { amount: string; currency: string };
type MoneyMetric = { value: Money; absoluteChange: Money; percentChange: string | null };
type CountMetric = { value: number; absoluteChange: number; percentChange: string | null };
export type FinanceExpensesReadResponse = FinanceExpenseEnvelope & {
  summary: {
    totalMtd: MoneyMetric;
    perOccupiedNight: MoneyMetric;
    unpaidAmount: MoneyMetric;
    unpaidCount: CountMetric;
  };
  categories: Array<{ category: FinanceExpenseCategory; amount: Money }>;
  page: { items: FinanceExpense[]; nextCursor: string | null; limit: number };
};
// prettier-ignore
export type FinanceExpenseReadModel = {
  categories(propertyId: string): Promise<(FinanceExpenseEnvelope & { item: FinanceExpenseCategory[] }) | null>;
  expense(propertyId: string, expenseId: string): Promise<(FinanceExpenseEnvelope & { item: FinanceExpense }) | null>;
  recurringRule(propertyId: string, ruleId: string): Promise<(FinanceExpenseEnvelope & { item: FinanceRecurringExpenseRule }) | null>;
  expenses(propertyId: string, query: FinanceExpenseQuery): Promise<FinanceExpensesReadResponse | null>; close(): Promise<void>;
};
export class FinanceExpenseCursorError extends TypeError {
  readonly code = "invalid_cursor";
}
export class FinanceExpenseEvidenceError extends Error {
  readonly code = "evidence_unavailable";
}

// Production adapter for the Finance-owned property-context port.
// prettier-ignore
export function createPgFinanceExpensePropertyContextReadPort(connectionString: string): FinanceExpensePropertyContextReadPort & { close(): Promise<void> } {
  const pool = new pg.Pool({ connectionString });
  return { async getPropertyContext(propertyId) { const row = (await pool.query<{ propertyId: string; profileRevision: string; timeZone: string | null; updatedAt: Date | string }>(`SELECT property.id::text AS "propertyId",property.profile_revision::text AS "profileRevision",location.timezone AS "timeZone",GREATEST(property.updated_at,COALESCE(location.updated_at,property.updated_at)) AS "updatedAt" FROM hotel_catalog.properties property LEFT JOIN hotel_catalog.property_locations location ON location.property_id=property.id WHERE property.id=$1::uuid`, [propertyId])).rows[0]; return row ? { source: { ownerDomain: "hotel_catalog", entityType: "property_profile", entityId: row.propertyId, revision: `profile:${row.profileRevision}` }, timeZone: row.timeZone, updatedAt: new Date(row.updatedAt).toISOString() } : null; }, close: () => pool.end() };
}

type Meta = {
  propertyId: string;
  currency: string;
  timeZone: string;
  generatedAt: string;
  sourceFreshness: Record<string, string>;
};
type ExpenseRow = Omit<FinanceExpense, "amount" | "paymentStatus" | "paidOn"> & {
  amount: string;
  currency: string;
  paymentStatus: FinanceExpense["paymentStatus"];
  paidOn: string | null;
  updatedAt: string;
};
type CategoryRow = FinanceExpenseCategory & { updatedAt: string; amount?: string };
type RuleRow = Omit<FinanceRecurringExpenseRule, "notes"> & {
  notes: string | null;
  updatedAt: string;
};
// prettier-ignore
type SummaryRow = { currentTotal: string; priorTotal: string; currentUnpaid: string; priorUnpaid: string; currentUnpaidCount: number; priorUnpaidCount: number; currentNights: number; priorNights: number; occupancyMismatch: number; financeFreshAt: string | null; bookingFreshThrough: string | null };
type MismatchRow = { currency: string; count: number; amount: string };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const EXPENSE_COLUMNS = `e.id::text AS id,e.category_id::text AS "categoryId",e.origin,e.incurred_on::text AS "incurredOn",e.paid_on::text AS "paidOn",e.vendor,e.amount::text AS amount,e.currency::text AS currency,e.payment_status AS "paymentStatus",e.recurring_rule_id::text AS "recurringRuleId",e.source_key AS "sourceKey",e.reverses_expense_id::text AS "reversesExpenseId",e.revision::int AS revision,e.updated_at::text AS "updatedAt"`;
const CATEGORY_COLUMNS = `c.id::text AS id,c.system_key AS "systemKey",c.name,c.color,c.sort_order AS "sortOrder",(c.archived_at IS NOT NULL) AS archived,c.revision::int AS revision,c.updated_at::text AS "updatedAt"`;
const RULE_COLUMNS = `r.id::text AS id,r.category_id::text AS "categoryId",r.vendor,jsonb_build_object('amount',r.amount::text,'currency',r.currency::text) AS amount,r.notes,r.payment_status AS "paymentStatus",r.cadence,r.starts_on::text AS "startsOn",r.next_due_on::text AS "nextDueOn",r.ends_on::text AS "endsOn",r.active,r.revision::int AS revision,r.updated_at::text AS "updatedAt"`;
const ACTIVE = `e.entry_kind<>'reversal' AND NOT EXISTS (SELECT 1 FROM finance.expenses child WHERE child.reverses_expense_id=e.id)`;
const EVENTS = `SELECT e.id,e.category_id,e.incurred_on,e.currency,CASE WHEN e.entry_kind='reversal' THEN -e.amount ELSE e.amount END AS amount FROM finance.expenses e WHERE e.property_id=$1::uuid UNION ALL SELECT correction.id,prior.category_id,correction.incurred_on,prior.currency,-prior.amount FROM finance.expenses correction JOIN finance.expenses prior ON prior.id=correction.reverses_expense_id WHERE correction.property_id=$1::uuid AND correction.entry_kind='correction'`;

// prettier-ignore
export function createPgFinanceExpenseReadModel(config: { connectionString?: string; pool?: FinanceReadPool; max?: number; now?: () => Date; pricing: Pick<PmsPricingReadPort, "getPropertyPricingCurrency">; propertyContext: FinanceExpensePropertyContextReadPort }): FinanceExpenseReadModel {
  if (!config.pool && !config.connectionString?.trim()) throw new Error("Finance expense read model requires a connection string");
  if (!config.pricing || !config.propertyContext) throw new Error("Finance expense read model requires typed property evidence");
  const ownsPool = !config.pool;
  const pool: FinanceReadPool = config.pool ?? new pg.Pool({ connectionString: config.connectionString, max: config.max });
  const envelope = async (propertyId: string): Promise<Meta | null> => {
    propertyId = uuid(propertyId);
    const [pricing, context] = await Promise.all([config.pricing.getPropertyPricingCurrency(propertyId), config.propertyContext.getPropertyContext(propertyId)]);
    if (!context) return null;
    if (!pricing || pricing.contractVersion !== PMS_PRICING_CONTRACT_VERSION || typeof pricing.propertyId !== "string" || pricing.propertyId.toLowerCase() !== propertyId || !/^[A-Z]{3}$/.test(pricing.currency) || !Number.isSafeInteger(pricing.pricingCurrencyRevision) || pricing.pricingCurrencyRevision < 1 || !context.source || context.source.ownerDomain !== "hotel_catalog" || context.source.entityType !== "property_profile" || typeof context.source.entityId !== "string" || context.source.entityId.toLowerCase() !== propertyId || !/^profile:[1-9]\d*$/.test(context.source.revision) || !canonicalZone(context.timeZone) || !utc(pricing.createdAt) || !utc(pricing.updatedAt) || !utc(context.updatedAt)) throw new FinanceExpenseEvidenceError("Property currency or timezone evidence is unavailable");
    return { propertyId, currency: pricing.currency, timeZone: context.timeZone, generatedAt: (config.now?.() ?? new Date()).toISOString(), sourceFreshness: { pmsPricing: pricing.updatedAt, pmsPricingRevision: String(pricing.pricingCurrencyRevision), hotelCatalog: context.updatedAt, hotelCatalogRevision: context.source.revision } };
  };
  const wrap = <T>(meta: Meta, item: T, freshAt?: string, incomplete: FinanceExpenseIncompleteEvidence[] = []) => ({ ...base(meta, freshAt ? { financeExpenses: freshAt } : {}, incomplete), item });
  return {
    async categories(propertyId) {
      const meta = await envelope(propertyId); if (!meta) return null;
      const rows = (await pool.query<CategoryRow>(`SELECT ${CATEGORY_COLUMNS} FROM finance.expense_categories c WHERE c.property_id=$1::uuid ORDER BY c.sort_order,c.name,c.id`, [meta.propertyId])).rows;
      return wrap(meta, rows.map(category), rows.map((row) => row.updatedAt).sort().at(-1));
    },
    async expense(propertyId, expenseId) {
      const meta = await envelope(propertyId); if (!meta) return null;
      const row = (await pool.query<ExpenseRow>(`SELECT ${EXPENSE_COLUMNS} FROM finance.expenses e WHERE e.property_id=$1::uuid AND e.id=$2::uuid`, [meta.propertyId, uuid(expenseId)])).rows[0];
      if (!row) return null; const item = expense(row);
      return wrap(meta, item, row.updatedAt, row.currency === meta.currency ? [] : [{ code: "expense_currency_mismatch", count: 1, amount: item.amount }]);
    },
    async recurringRule(propertyId, ruleId) {
      const meta = await envelope(propertyId); if (!meta) return null;
      const row = (await pool.query<RuleRow>(`SELECT ${RULE_COLUMNS} FROM finance.recurring_expense_rules r WHERE r.property_id=$1::uuid AND r.id=$2::uuid AND r.currency=$3`, [meta.propertyId, uuid(ruleId), meta.currency])).rows[0];
      return row ? wrap(meta, rule(row), row.updatedAt) : null;
    },
    async expenses(propertyId, rawQuery) {
      const query = parseFinanceExpenseQuery(rawQuery); if (!query || !date(query.from) || !date(query.to)) throw new TypeError("Finance expense query is malformed");
      const meta = await envelope(propertyId); if (!meta) return null;
      const cursor = query.cursor ? decodeCursor(query.cursor, meta.propertyId, query) : null;
      const period = comparisonPeriod(meta.generatedAt, meta.timeZone);
      const { summary, categories, page, mismatches } = await consistentRead(pool, async (client) => {
        const summary = await readSummary(client, meta, period); const categories = await readCategoryTotals(client, meta, period.currentFrom, period.currentTo);
        const page = await readPage(client, meta, query, cursor);
        return { summary, categories, page, mismatches: await readMismatches(client, meta, query.from, query.to, period.currentFrom, period.currentTo, period.priorFrom, period.priorTo) };
      });
      const current = fixed(summary.currentTotal), prior = fixed(summary.priorTotal);
      const currentNights = number(summary.currentNights), priorNights = number(summary.priorNights);
      const incompleteEvidence: FinanceExpenseIncompleteEvidence[] = mismatches.map((row) => ({ code: "expense_currency_mismatch", count: number(row.count), amount: { amount: decimal(fixed(row.amount)), currency: row.currency } }));
      if (summary.occupancyMismatch) incompleteEvidence.push({ code: "occupancy_currency_mismatch", count: number(summary.occupancyMismatch) });
      const missing = Number(current !== 0n && currentNights <= 0) + Number(prior !== 0n && priorNights <= 0);
      if (missing) incompleteEvidence.push({ code: "occupancy_unavailable", count: missing });
      return { ...base(meta, compact({ financeExpenses: summary.financeFreshAt, bookingOccupancyThrough: summary.bookingFreshThrough }), incompleteEvidence),
        summary: { totalMtd: moneyMetric(current, prior, meta.currency), perOccupiedNight: moneyMetric(divide(current, currentNights), divide(prior, priorNights), meta.currency), unpaidAmount: moneyMetric(fixed(summary.currentUnpaid), fixed(summary.priorUnpaid), meta.currency), unpaidCount: countMetric(number(summary.currentUnpaidCount), number(summary.priorUnpaidCount)) }, categories, page };
    },
    async close() { if (ownsPool) await pool.end?.(); },
  };
}

// prettier-ignore
async function readSummary(pool: Pick<FinanceReadClient, "query">, meta: Meta, p: Period): Promise<SummaryRow> {
  // Migration 0073 owns this Booking projection and explicitly curates it as Finance-safe; raw Booking tables stay outside this boundary and the shared snapshot prevents cross-pool drift.
  const row = (await pool.query<SummaryRow>(`WITH events AS (${EVENTS}), active AS (SELECT e.* FROM finance.expenses e WHERE e.property_id=$1::uuid AND e.currency=$2 AND ${ACTIVE}), expense AS (SELECT COALESCE(sum(amount) FILTER (WHERE currency=$2 AND incurred_on BETWEEN $3::date AND $4::date),0)::text AS "currentTotal",COALESCE(sum(amount) FILTER (WHERE currency=$2 AND incurred_on BETWEEN $5::date AND $6::date),0)::text AS "priorTotal" FROM events), unpaid AS (SELECT COALESCE(sum(amount) FILTER (WHERE payment_status='unpaid' AND incurred_on BETWEEN $3::date AND $4::date),0)::text AS "currentUnpaid",COALESCE(sum(amount) FILTER (WHERE payment_status='unpaid' AND incurred_on BETWEEN $5::date AND $6::date),0)::text AS "priorUnpaid",count(*) FILTER (WHERE payment_status='unpaid' AND incurred_on BETWEEN $3::date AND $4::date)::int AS "currentUnpaidCount",count(*) FILTER (WHERE payment_status='unpaid' AND incurred_on BETWEEN $5::date AND $6::date)::int AS "priorUnpaidCount" FROM active), occupancy AS (SELECT COALESCE(sum(occupied_room_nights) FILTER (WHERE currency=$2 AND recognized_on BETWEEN $3::date AND $4::date),0)::int AS "currentNights",COALESCE(sum(occupied_room_nights) FILTER (WHERE currency=$2 AND recognized_on BETWEEN $5::date AND $6::date),0)::int AS "priorNights",count(*) FILTER (WHERE currency<>$2 AND (recognized_on BETWEEN $3::date AND $4::date OR recognized_on BETWEEN $5::date AND $6::date))::int AS "occupancyMismatch",max(recognized_on)::text AS "bookingFreshThrough" FROM booking.finance_nightly_revenue_evidence WHERE property_id=$1::uuid), evidence AS (SELECT max(updated_at)::text AS "financeFreshAt" FROM finance.expenses WHERE property_id=$1::uuid) SELECT * FROM expense CROSS JOIN unpaid CROSS JOIN occupancy CROSS JOIN evidence`, [meta.propertyId, meta.currency, p.currentFrom, p.currentTo, p.priorFrom, p.priorTo])).rows[0];
  if (!row) throw new Error("Finance expense summary query returned no row"); return row;
}

// prettier-ignore
async function readCategoryTotals(pool: Pick<FinanceReadClient, "query">, meta: Meta, from: string, to: string) {
  const rows = (await pool.query<CategoryRow>(`WITH events AS (${EVENTS}) SELECT ${CATEGORY_COLUMNS},sum(event.amount)::text AS amount FROM finance.expense_categories c JOIN events event ON event.category_id=c.id WHERE c.property_id=$1::uuid AND event.currency=$2 AND event.incurred_on BETWEEN $3::date AND $4::date GROUP BY c.id HAVING sum(event.amount)<>0 ORDER BY sum(event.amount) DESC,c.sort_order,c.id`, [meta.propertyId, meta.currency, from, to])).rows;
  return rows.map((row) => ({ category: category(row), amount: { amount: decimal(fixed(row.amount!)), currency: meta.currency } }));
}

// prettier-ignore
async function readPage(pool: Pick<FinanceReadClient, "query">, meta: Meta, query: FinanceExpenseQuery, cursor: Cursor | null) {
  const values: unknown[] = [meta.propertyId, meta.currency, query.from, query.to];
  const where = [`e.property_id=$1::uuid`, `e.currency=$2`, `e.incurred_on BETWEEN $3::date AND $4::date`, ACTIVE];
  const add = (sql: string, value: unknown) => { values.push(value); where.push(sql.replace("?", `$${values.length}`)); };
  if (query.categoryId) add(`e.category_id=?::uuid`, query.categoryId);
  if (query.paymentStatus) add(`e.payment_status=?`, query.paymentStatus);
  if (query.recurring !== undefined) where.push(`e.recurring_rule_id IS ${query.recurring ? "NOT " : ""}NULL`);
  if (query.origin) add(`e.origin=?`, query.origin);
  if (query.search) { values.push(query.search.toLowerCase()); where.push(`(position($${values.length} in lower(e.vendor))>0 OR position($${values.length} in lower(c.name))>0)`); }
  if (cursor) {
    values.push(cursor.incurredOn, cursor.id); const date = `$${values.length - 1}`, id = `$${values.length}`;
    if (query.sort === "amount_desc") { values.push(cursor.amount); const amount = `$${values.length}`; where.push(`(e.amount<${amount}::numeric OR (e.amount=${amount}::numeric AND (e.incurred_on<${date}::date OR (e.incurred_on=${date}::date AND e.id>${id}::uuid))))`); }
    else where.push(`(e.incurred_on<${date}::date OR (e.incurred_on=${date}::date AND e.id>${id}::uuid))`);
  }
  values.push(query.limit + 1); const order = query.sort === "amount_desc" ? `e.amount DESC,e.incurred_on DESC,e.id` : `e.incurred_on DESC,e.id`;
  const rows = (await pool.query<ExpenseRow>(`SELECT ${EXPENSE_COLUMNS} FROM finance.expenses e JOIN finance.expense_categories c ON c.id=e.category_id AND c.property_id=e.property_id WHERE ${where.join(" AND ")} ORDER BY ${order} LIMIT $${values.length}`, values)).rows;
  const items = rows.slice(0, query.limit).map(expense);
  return { items, nextCursor: rows.length > query.limit ? encodeCursor(meta.propertyId, query, items.at(-1)!) : null, limit: query.limit };
}

// prettier-ignore
async function readMismatches(pool: Pick<FinanceReadClient, "query">, meta: Meta, listFrom: string, listTo: string, currentFrom: string, currentTo: string, priorFrom: string, priorTo: string): Promise<MismatchRow[]> { return (await pool.query<MismatchRow>(`WITH events AS (${EVENTS}) SELECT currency::text AS currency,count(DISTINCT id)::int AS count,COALESCE(sum(amount),0)::text AS amount FROM events WHERE currency<>$2 AND (incurred_on BETWEEN $3::date AND $4::date OR incurred_on BETWEEN $5::date AND $6::date OR incurred_on BETWEEN $7::date AND $8::date) GROUP BY currency ORDER BY currency`, [meta.propertyId, meta.currency, listFrom, listTo, currentFrom, currentTo, priorFrom, priorTo])).rows; }

type Period = { currentFrom: string; currentTo: string; priorFrom: string; priorTo: string };
type Cursor = { incurredOn: string; id: string; amount?: string };
// prettier-ignore
async function consistentRead<T>(pool: FinanceReadPool, read: (client: FinanceReadClient) => Promise<T>): Promise<T> { const client = await pool.connect(); try { await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY"); const value = await read(client); await client.query("COMMIT"); return value; } catch (error) { try { await client.query("ROLLBACK"); } catch {} throw error; } finally { client.release(); } }
// prettier-ignore
function comparisonPeriod(instant: string, timeZone: string): Period {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date(instant)).map((part) => [part.type, part.value]));
  const year = Number(parts.year), month = Number(parts.month), day = Number(parts.day);
  const prior = new Date(Date.UTC(year, month - 2, 1)); const priorDay = Math.min(day, new Date(Date.UTC(year, month - 1, 0)).getUTCDate());
  return { currentFrom: `${year}-${pad(month)}-01`, currentTo: `${year}-${pad(month)}-${pad(day)}`, priorFrom: `${prior.getUTCFullYear()}-${pad(prior.getUTCMonth() + 1)}-01`, priorTo: `${prior.getUTCFullYear()}-${pad(prior.getUTCMonth() + 1)}-${pad(priorDay)}` };
}
// prettier-ignore
function encodeCursor(propertyId: string, query: FinanceExpenseQuery, item: FinanceExpense): string { return Buffer.from(JSON.stringify({ v: 1, q: snapshot(propertyId, query), p: query.sort === "amount_desc" ? [item.incurredOn, item.id, item.amount.amount] : [item.incurredOn, item.id] })).toString("base64url"); }
// prettier-ignore
function decodeCursor(token: string, propertyId: string, query: FinanceExpenseQuery): Cursor {
  try {
    if (!/^(?=.{2,4096}$)(?:[A-Za-z0-9_-]{4})*(?:[A-Za-z0-9_-]{2,3})?$/.test(token)) throw 0;
    const decoded = Buffer.from(token, "base64url"); if (decoded.toString("base64url") !== token) throw 0;
    const value = JSON.parse(decoded.toString("utf8")) as { v?: unknown; q?: unknown; p?: unknown };
    if (!exact(value, ["v", "q", "p"]) || value.v !== 1 || JSON.stringify(value.q) !== JSON.stringify(snapshot(propertyId, query)) || !Array.isArray(value.p) || value.p.length !== (query.sort === "amount_desc" ? 3 : 2) || !date(value.p[0]) || !UUID.test(String(value.p[1])) || (value.p[2] !== undefined && !/^\d{1,15}(?:\.\d{1,4})?$/.test(String(value.p[2])))) throw 0;
    return { incurredOn: value.p[0], id: String(value.p[1]), amount: value.p[2] === undefined ? undefined : String(value.p[2]) };
  } catch { throw new FinanceExpenseCursorError("Finance expense cursor is invalid for this query"); }
}
// prettier-ignore
function snapshot(propertyId: string, q: FinanceExpenseQuery) { return [propertyId, q.from, q.to, q.categoryId?.toLowerCase() ?? null, q.paymentStatus ?? null, q.recurring ?? null, q.origin ?? null, q.search?.toLowerCase() ?? null, q.sort]; }
// prettier-ignore
function base(meta: Meta, sourceFreshness: Record<string, string> = {}, incompleteEvidence: FinanceExpenseEnvelope["incompleteEvidence"] = []): FinanceExpenseEnvelope { const { sourceFreshness: owners, ...envelope } = meta; return { contractVersion: PMS_FINANCIALS_CONTRACT_VERSION, ...envelope, sourceFreshness: { ...owners, ...sourceFreshness }, incompleteEvidence }; }
function expense(row: ExpenseRow): FinanceExpense {
  const { amount, currency, updatedAt: _, paymentStatus, paidOn, ...rest } = row;
  const item = {
    ...rest,
    amount: { amount: amount as FinanceExpense["amount"]["amount"], currency },
  };
  if (paymentStatus === "paid" && paidOn !== null) return { ...item, paymentStatus, paidOn };
  if (paymentStatus === "unpaid" && paidOn === null) return { ...item, paymentStatus, paidOn };
  throw new FinanceExpenseEvidenceError("Expense payment evidence is inconsistent");
}
// prettier-ignore
function category(row: CategoryRow): FinanceExpenseCategory { const { updatedAt: _, amount: __, ...item } = row; return item; }
function rule(row: RuleRow): FinanceRecurringExpenseRule {
  const { updatedAt: _, notes, ...item } = row;
  return notes === null ? item : { ...item, notes };
}
// prettier-ignore
function moneyMetric(value: bigint, prior: bigint, currency: string): MoneyMetric { return { value: money(value, currency), absoluteChange: money(value - prior, currency), percentChange: prior === 0n ? null : decimal(roundDivide((value - prior) * 10_000n, prior)) }; }
// prettier-ignore
function countMetric(value: number, prior: number): CountMetric { return { value, absoluteChange: value - prior, percentChange: prior === 0 ? null : decimal(roundDivide(BigInt(value - prior) * 10_000n, BigInt(prior))) }; }
function money(amount: bigint, currency: string): Money {
  return { amount: decimal(amount), currency };
}
// prettier-ignore
function fixed(value: string): bigint { if (!/^-?\d+(?:\.\d{1,4})?$/.test(value)) throw new Error("Finance decimal evidence is invalid"); const negative = value.startsWith("-"); const [whole, part = ""] = value.replace("-", "").split("."); const parsed = BigInt(whole!) * 10_000n + BigInt(part.padEnd(4, "0")); return negative ? -parsed : parsed; }
// prettier-ignore
function decimal(value: bigint): string { const sign = value < 0n ? "-" : ""; const absolute = value < 0n ? -value : value; return `${sign}${absolute / 10_000n}.${String(absolute % 10_000n).padStart(4, "0")}`; }
function divide(value: bigint, divisor: number): bigint {
  return divisor > 0 ? roundDivide(value, BigInt(divisor)) : 0n;
}
// prettier-ignore
function roundDivide(value: bigint, divisor: bigint): bigint { const sign = value < 0n !== divisor < 0n ? -1n : 1n; const a = value < 0n ? -value : value, b = divisor < 0n ? -divisor : divisor; return sign * ((a + b / 2n) / b); }
function number(value: number): number {
  if (!Number.isSafeInteger(value)) throw new Error("Finance integer evidence is invalid");
  return value;
}
function uuid(value: string): string {
  if (!UUID.test(value)) throw new TypeError("Finance property or resource id is malformed");
  return value.toLowerCase();
}
// prettier-ignore
function date(value: unknown): value is string { return typeof value === "string" && /^[1-9]\d{3}-\d{2}-\d{2}$/.test(value) && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value; }
// prettier-ignore
function canonicalZone(value: unknown): value is string { if (typeof value !== "string") return false; try { const zone = getTimezone(value); return zone?.name === value && zone.aliasOf === null; } catch { return false; } }
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
// prettier-ignore
function exact(value: unknown, keys: string[]): value is Record<string, unknown> { return !!value && typeof value === "object" && !Array.isArray(value) && Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key)); }
// prettier-ignore
function compact(value: Record<string, string | null>): Record<string, string> { return Object.fromEntries(Object.entries(value).filter((entry): entry is [string, string] => entry[1] !== null)); }
function pad(value: number): string {
  return String(value).padStart(2, "0");
}
