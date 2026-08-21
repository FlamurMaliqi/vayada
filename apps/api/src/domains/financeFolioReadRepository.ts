import { getTimezone } from "countries-and-timezones";
import pg, { type QueryResult, type QueryResultRow } from "pg";

import {
  PMS_FINANCIALS_CONTRACT_VERSION,
  parseFinanceFolioQuery,
  type FinanceFolio,
  type FinanceFolioDetailResponse,
  type FinanceFolioListResponse,
  type FinanceFolioQuery,
  type FinanceFolioSummary,
} from "@vayada/domain-finance";
import { PMS_PRICING_CONTRACT_VERSION, type PmsPricingReadPort } from "@vayada/domain-pms";
import type { FinanceExpensePropertyContextReadPort } from "./financeExpenseReadModel.js";

// prettier-ignore
type ReadClient = { query<T extends QueryResultRow = QueryResultRow>(sql: string, values?: readonly unknown[]): Promise<Pick<QueryResult<T>, "rows">> };
// prettier-ignore
export type FinanceFolioReadPool = ReadClient & { end?(): Promise<void> };
// prettier-ignore
export type FinanceFolioRecipientDecoder = { decode(input: { ciphertext: Buffer; encryptionScheme: "envelope_aead_v1"; keyVersion: string }): Promise<unknown> };
export type FinanceFolioReadRepository = {
  list(propertyId: string, query: FinanceFolioQuery): Promise<FinanceFolioListResponse | null>;
  detail(propertyId: string, folioId: string): Promise<FinanceFolioDetailResponse | null>;
  close(): Promise<void>;
};
export class FinanceFolioCursorError extends TypeError {
  readonly code = "invalid_cursor";
}
export class FinanceFolioEvidenceError extends Error {
  readonly code = "evidence_unavailable";
}

// prettier-ignore
type Meta = { propertyId: string; currency: string; timeZone: string; generatedAt: string; sourceFreshness: Record<string, string> };
type SummaryRow = Omit<FinanceFolioSummary, "total" | "createdAt"> & {
  revisionId: string;
  totalAmount: string;
  currency: string;
  createdAt: string;
};
type DetailRow = SummaryRow & {
  recipientCiphertext: Buffer;
  recipientEncryptionScheme: string;
  recipientKeyVersion: string;
  sourceDigest: string;
  sourceFreshness: unknown;
  lines: unknown;
  paymentRefs: unknown;
};
type Cursor = { key: string; id: string };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const STATE = `CASE WHEN EXISTS (SELECT 1 FROM finance.folio_revisions later WHERE later.folio_id=r.folio_id AND later.revision>r.revision) THEN 'superseded' ELSE r.state END`;
const SUMMARY = `f.id::text AS "folioId",f.guest_booking_id::text AS "bookingId",r.id::text AS "revisionId",r.revision::int AS revision,${STATE} AS state,r.service_from::text AS "serviceFrom",r.service_to::text AS "serviceTo",r.total_amount::text AS "totalAmount",r.currency::text AS currency,to_char(r.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "createdAt"`;

// PostgreSQL owns only Finance folio rows; currency and timezone cross this boundary through typed owner ports.
// prettier-ignore
export function createPgFinanceFolioReadRepository(config: { connectionString?: string; pool?: FinanceFolioReadPool; max?: number; now?: () => Date; pricing: Pick<PmsPricingReadPort, "getPropertyPricingCurrency">; propertyContext: FinanceExpensePropertyContextReadPort; recipientDecoder: FinanceFolioRecipientDecoder }): FinanceFolioReadRepository {
  if (!config.pool && !config.connectionString?.trim()) throw new Error("Finance folio read repository requires a connection string");
  if (!config.pricing || !config.propertyContext || !config.recipientDecoder) throw new Error("Finance folio read repository requires typed evidence ports");
  const ownsPool = !config.pool;
  const pool: FinanceFolioReadPool = config.pool ?? new pg.Pool({ connectionString: config.connectionString, max: config.max });
  const meta = async (rawPropertyId: string): Promise<Meta | null> => {
    const propertyId = uuid(rawPropertyId); const [pricing, context] = await Promise.all([config.pricing.getPropertyPricingCurrency(propertyId), config.propertyContext.getPropertyContext(propertyId)]);
    if (!context) return null;
    if (!pricing || pricing.contractVersion !== PMS_PRICING_CONTRACT_VERSION || pricing.propertyId.toLowerCase() !== propertyId || !/^[A-Z]{3}$/.test(pricing.currency) || !Number.isSafeInteger(pricing.pricingCurrencyRevision) || pricing.pricingCurrencyRevision < 1 || context.source.ownerDomain !== "hotel_catalog" || context.source.entityType !== "property_profile" || context.source.entityId.toLowerCase() !== propertyId || !/^profile:[1-9]\d*$/.test(context.source.revision) || !canonicalFinanceFolioZone(context.timeZone) || !utc(pricing.updatedAt) || !utc(context.updatedAt)) throw new FinanceFolioEvidenceError("Property currency or timezone evidence is unavailable");
    return { propertyId, currency: pricing.currency, timeZone: context.timeZone, generatedAt: (config.now?.() ?? new Date()).toISOString(), sourceFreshness: { pmsPricing: pricing.updatedAt, pmsPricingRevision: String(pricing.pricingCurrencyRevision), hotelCatalog: context.updatedAt, hotelCatalogRevision: context.source.revision } };
  };
  return {
    async list(propertyId, rawQuery) {
      const query = parseFinanceFolioQuery(rawQuery); if (!query) throw new TypeError("Finance folio query is malformed");
      const evidence = await meta(propertyId); if (!evidence) return null;
      const cursor = query.cursor ? decodeCursor(query.cursor, evidence, query) : null;
      const values: unknown[] = [evidence.propertyId, evidence.currency]; const where = [`f.property_id=$1::uuid`, `r.currency=$2`];
      const add = (sql: string, value: unknown) => { values.push(value); where.push(sql.replace("?", `$${values.length}`)); };
      if (query.from) add(`r.service_from>=?::date`, query.from); if (query.to) add(`r.service_from<=?::date`, query.to);
      if (query.state) add(`${STATE}=?`, query.state); else where.push(`r.state IN ('draft','ready') AND NOT EXISTS (SELECT 1 FROM finance.folio_revisions later WHERE later.folio_id=r.folio_id AND later.revision>r.revision)`);
      if (query.search) { values.push(query.search.toLowerCase()); where.push(`(position($${values.length} in lower(f.id::text))>0 OR position($${values.length} in lower(COALESCE(f.guest_booking_id::text,'')))>0)`); }
      const column = query.sort === "amount_desc" ? "r.total_amount" : query.sort === "serviceFrom_desc" ? "r.service_from" : "r.created_at";
      if (cursor) { values.push(cursor.key, cursor.id); const key = `$${values.length - 1}`, id = `$${values.length}`; const cast = query.sort === "amount_desc" ? "numeric" : query.sort === "serviceFrom_desc" ? "date" : "timestamptz"; where.push(`(${column}<${key}::${cast} OR (${column}=${key}::${cast} AND r.id>${id}::uuid))`); }
      values.push(query.limit + 1);
      const rows = (await pool.query<SummaryRow>(`SELECT ${SUMMARY} FROM finance.folios f JOIN finance.folio_revisions r ON r.folio_id=f.id AND r.property_id=f.property_id WHERE ${where.join(" AND ")} ORDER BY ${column} DESC,r.id ASC LIMIT $${values.length}`, values)).rows;
      const items = rows.slice(0, query.limit).map((row) => summary(row, evidence.currency));
      const last = rows.slice(0, query.limit).at(-1); const nextCursor = rows.length > query.limit && last ? encodeCursor(evidence, query, last) : null;
      return { ...envelope(evidence, rows.map((row) => instant(row.createdAt)).sort().at(-1)), page: { items, nextCursor, limit: query.limit } };
    },
    async detail(propertyId, folioId) {
      const evidence = await meta(propertyId); if (!evidence) return null;
      const row = (await pool.query<DetailRow>(`SELECT ${SUMMARY},r.recipient_snapshot_ciphertext AS "recipientCiphertext",r.recipient_encryption_scheme AS "recipientEncryptionScheme",r.recipient_key_version AS "recipientKeyVersion",r.source_digest::text AS "sourceDigest",r.source_freshness AS "sourceFreshness",COALESCE((SELECT jsonb_agg(jsonb_build_object('lineId',l.id::text,'position',l.position,'kind',l.kind,'description',l.description,'quantity',l.quantity::text,'unitAmount',l.unit_amount::text,'total',l.line_total::text,'serviceOn',l.service_on::text,'sourceType',l.source_type,'sourceId',l.source_id,'sourceRevision',l.source_revision) ORDER BY l.position) FROM finance.folio_lines l WHERE l.folio_revision_id=r.id),'[]') AS lines,COALESCE((SELECT jsonb_agg(jsonb_build_object('paymentId',p.payment_id::text,'amount',p.amount::text) ORDER BY p.position) FROM finance.folio_payment_references p WHERE p.folio_revision_id=r.id),'[]') AS "paymentRefs" FROM finance.folios f JOIN LATERAL (SELECT * FROM finance.folio_revisions candidate WHERE candidate.folio_id=f.id AND candidate.property_id=f.property_id ORDER BY candidate.revision DESC LIMIT 1) r ON true WHERE f.property_id=$1::uuid AND f.id=$2::uuid AND r.currency=$3`, [evidence.propertyId, uuid(folioId), evidence.currency])).rows[0];
      if (!row) return null;
      const decoded = await config.recipientDecoder.decode({ ciphertext: row.recipientCiphertext, encryptionScheme: scheme(row.recipientEncryptionScheme), keyVersion: row.recipientKeyVersion });
      const recipient = whitelistRecipient(decoded), sourceFreshness = stringRecord(row.sourceFreshness);
      const item: FinanceFolio = { ...summary(row, evidence.currency), propertyId: evidence.propertyId, recipient, currency: evidence.currency, lines: lines(row.lines, evidence.currency), paymentRefs: paymentRefs(row.paymentRefs, evidence.currency), sourceDigest: digest(row.sourceDigest), sourceFreshness };
      return { ...envelope(evidence, instant(row.createdAt)), item };
    },
    async close() { if (ownsPool) await pool.end?.(); },
  };
}

// prettier-ignore
function summary(row: SummaryRow, expectedCurrency: string): FinanceFolioSummary {
  const serviceFrom=date(row.serviceFrom), serviceTo=date(row.serviceTo);
  if (row.currency!==expectedCurrency || !Number.isSafeInteger(row.revision) || row.revision<1 || !["draft","ready","archived","superseded"].includes(row.state) || serviceTo<serviceFrom) throw new FinanceFolioEvidenceError("Folio evidence is inconsistent");
  return { folioId:uuid(row.folioId), bookingId:row.bookingId===null?null:uuid(row.bookingId), revision:row.revision, state:row.state, serviceFrom, serviceTo, total:money(row.totalAmount,expectedCurrency), createdAt:instant(row.createdAt) };
}
function lines(value: unknown, currency: string): FinanceFolio["lines"] {
  if (!Array.isArray(value)) throw new FinanceFolioEvidenceError("Folio lines are invalid");
  return value.map((raw) => {
    const row = object(raw);
    if (
      !Number.isSafeInteger(row.position) ||
      !Number.isSafeInteger(row.sourceRevision) ||
      !["room", "addon", "fee", "tax", "adjustment"].includes(String(row.kind))
    )
      throw new FinanceFolioEvidenceError("Folio line is invalid");
    return {
      lineId: uuid(String(row.lineId)),
      position: Number(row.position),
      kind: row.kind as FinanceFolio["lines"][number]["kind"],
      description: text(row.description),
      quantity: decimal(String(row.quantity)),
      unitAmount: money(String(row.unitAmount), currency, true),
      total: money(String(row.total), currency, true),
      serviceOn: date(row.serviceOn),
      source: {
        type: text(row.sourceType),
        id: text(row.sourceId),
        revision: Number(row.sourceRevision),
      },
    };
  });
}
function paymentRefs(value: unknown, currency: string): FinanceFolio["paymentRefs"] {
  if (!Array.isArray(value))
    throw new FinanceFolioEvidenceError("Folio payment references are invalid");
  return value.map((raw) => {
    const row = object(raw);
    return { paymentId: uuid(String(row.paymentId)), amount: money(String(row.amount), currency) };
  });
}
function whitelistRecipient(value: unknown): FinanceFolio["recipient"] {
  const row = object(value);
  const name = text(row.name);
  const email = row.email === null ? null : text(row.email);
  if (
    !name.trim() ||
    name !== name.trim() ||
    (email !== null && (!email.includes("@") || email !== email.trim()))
  )
    throw new FinanceFolioEvidenceError("Folio recipient evidence is invalid");
  return { name, email };
}
function envelope(meta: Meta, folioFreshAt?: string) {
  return {
    contractVersion: PMS_FINANCIALS_CONTRACT_VERSION,
    propertyId: meta.propertyId,
    currency: meta.currency,
    timeZone: meta.timeZone,
    generatedAt: meta.generatedAt,
    sourceFreshness: {
      ...meta.sourceFreshness,
      ...(folioFreshAt ? { financeFolios: folioFreshAt } : {}),
    },
    incompleteEvidence: [],
  };
}
function encodeCursor(meta: Meta, query: FinanceFolioQuery, row: SummaryRow): string {
  const key =
    query.sort === "amount_desc"
      ? decimal(row.totalAmount)
      : query.sort === "serviceFrom_desc"
        ? row.serviceFrom
        : row.createdAt;
  return Buffer.from(
    JSON.stringify({ v: 1, q: snapshot(meta, query), p: [key, row.revisionId] }),
  ).toString("base64url");
}
function decodeCursor(token: string, meta: Meta, query: FinanceFolioQuery): Cursor {
  try {
    const bytes = Buffer.from(token, "base64url");
    if (bytes.toString("base64url") !== token) throw 0;
    const value = JSON.parse(bytes.toString("utf8"));
    if (
      !exact(value, ["v", "q", "p"]) ||
      value.v !== 1 ||
      JSON.stringify(value.q) !== JSON.stringify(snapshot(meta, query)) ||
      !Array.isArray(value.p) ||
      value.p.length !== 2 ||
      !UUID.test(String(value.p[1]))
    )
      throw 0;
    const key = String(value.p[0]);
    if (
      query.sort === "amount_desc"
        ? !/^\d+(?:\.\d{4})$/.test(key)
        : query.sort === "serviceFrom_desc"
          ? !validDate(key)
          : !utc(key)
    )
      throw 0;
    return { key, id: String(value.p[1]) };
  } catch {
    throw new FinanceFolioCursorError("Finance folio cursor is invalid for this query");
  }
}
function snapshot(meta: Meta, query: FinanceFolioQuery) {
  return [
    meta.propertyId,
    meta.currency,
    query.from ?? null,
    query.to ?? null,
    query.state ?? null,
    query.search?.toLowerCase() ?? null,
    query.sort,
  ];
}
function money(value: string, currency: string, signed = false) {
  const amount = decimal(value);
  if (!signed && amount.startsWith("-"))
    throw new FinanceFolioEvidenceError("Folio money is invalid");
  return { amount, currency };
}
function decimal(value: string): string {
  if (!/^-?\d+(?:\.\d{1,4})?$/.test(value))
    throw new FinanceFolioEvidenceError("Folio decimal evidence is invalid");
  const negative = value.startsWith("-");
  const [whole, part = ""] = value.replace("-", "").split(".");
  return `${negative ? "-" : ""}${BigInt(whole!)}.${part.padEnd(4, "0")}`;
}
function uuid(value: string): string {
  if (!UUID.test(value)) throw new TypeError("Finance property or resource id is malformed");
  return value.toLowerCase();
}
function date(value: unknown): string {
  if (!validDate(value)) throw new FinanceFolioEvidenceError("Folio date evidence is invalid");
  return value;
}
function validDate(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^[1-9]\d{3}-\d{2}-\d{2}$/.test(value) &&
    new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value
  );
}
function instant(value: Date | string): string {
  const result = value instanceof Date ? value.toISOString() : new Date(value).toISOString();
  if (!utc(result)) throw new FinanceFolioEvidenceError("Folio timestamp evidence is invalid");
  return result;
}
// prettier-ignore
function utc(value: unknown): value is string { if (typeof value !== "string") return false; const match = /^((?!0000)\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,6})?Z$/.exec(value); if (!match) return false; const year=Number(match[1]),month=Number(match[2]),day=Number(match[3]),hour=Number(match[4]),minute=Number(match[5]),second=Number(match[6]), parsed=new Date(0); parsed.setUTCFullYear(year,month-1,day); parsed.setUTCHours(hour,minute,second,0); return Number.isFinite(parsed.getTime()) && parsed.getUTCFullYear()===year && parsed.getUTCMonth()===month-1 && parsed.getUTCDate()===day && parsed.getUTCHours()===hour && parsed.getUTCMinutes()===minute && parsed.getUTCSeconds()===second; }
export function canonicalFinanceFolioZone(value: unknown): value is string {
  if (typeof value !== "string") return false;
  try {
    const zone = getTimezone(value);
    return zone?.name === value && zone.aliasOf === null;
  } catch {
    return false;
  }
}
// prettier-ignore
export function isFinanceFolioCursor(token: string, propertyId: string, currency: string, query: FinanceFolioQuery): boolean { try { decodeCursor(token, { propertyId, currency, timeZone: "", generatedAt: "", sourceFreshness: {} }, query); return true; } catch { return false; } }
function scheme(value: string): "envelope_aead_v1" {
  if (value !== "envelope_aead_v1")
    throw new FinanceFolioEvidenceError("Folio recipient encryption evidence is invalid");
  return value;
}
function digest(value: string): string {
  if (!/^[0-9a-f]{64}$/.test(value))
    throw new FinanceFolioEvidenceError("Folio digest evidence is invalid");
  return value;
}
function text(value: unknown): string {
  if (typeof value !== "string")
    throw new FinanceFolioEvidenceError("Folio text evidence is invalid");
  return value;
}
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new FinanceFolioEvidenceError("Folio object evidence is invalid");
  return value as Record<string, unknown>;
}
function stringRecord(value: unknown): Record<string, string> {
  const row = object(value);
  if (Object.values(row).some((part) => !utc(part)))
    throw new FinanceFolioEvidenceError("Folio freshness evidence is invalid");
  return row as Record<string, string>;
}
function exact(value: unknown, keys: string[]): value is Record<string, unknown> {
  return (
    !!value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.keys(value).length === keys.length &&
    keys.every((key) => Object.hasOwn(value, key))
  );
}
