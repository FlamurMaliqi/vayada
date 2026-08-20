import { PMS_FINANCIALS_CONTRACT_VERSION } from "./financialExpenses.js";

export const FINANCE_FOLIO_STORED_STATES = ["draft", "ready", "archived"] as const;
export const FINANCE_FOLIO_VIEW_STATES = [...FINANCE_FOLIO_STORED_STATES, "superseded"] as const;
export const FINANCE_FOLIO_LINE_KINDS = ["room", "addon", "fee", "tax", "adjustment"] as const;
export const FINANCE_FOLIO_SORTS = ["createdAt_desc", "serviceFrom_desc", "amount_desc"] as const;

export type FinanceFolioStoredState = (typeof FINANCE_FOLIO_STORED_STATES)[number];
export type FinanceFolioViewState = (typeof FINANCE_FOLIO_VIEW_STATES)[number];
export type FinanceFolioLineKind = (typeof FINANCE_FOLIO_LINE_KINDS)[number];
export type FinanceFolioSort = (typeof FINANCE_FOLIO_SORTS)[number];
export type FinanceFolioMoney = { amount: string; currency: string };
export type FinanceFolioRecipient = { name: string; email: string | null };
export type FinanceFolioSourceReference = { type: string; id: string; revision: number };
export type FinanceFolioLine = {
  lineId: string;
  position: number;
  kind: FinanceFolioLineKind;
  description: string;
  quantity: string;
  unitAmount: FinanceFolioMoney;
  total: FinanceFolioMoney;
  serviceOn: string;
  source: FinanceFolioSourceReference;
};
export type FinanceFolioPaymentReference = {
  paymentId: string;
  amount: FinanceFolioMoney;
};
export type FinanceFolio = {
  folioId: string;
  propertyId: string;
  bookingId: string | null;
  revision: number;
  state: FinanceFolioViewState;
  recipient: FinanceFolioRecipient;
  serviceFrom: string;
  serviceTo: string;
  currency: string;
  lines: FinanceFolioLine[];
  total: FinanceFolioMoney;
  paymentRefs: FinanceFolioPaymentReference[];
  sourceDigest: string;
  sourceFreshness: Record<string, string>;
  createdAt: string;
};
export type FinanceFolioSummary = Pick<
  FinanceFolio,
  | "folioId"
  | "bookingId"
  | "revision"
  | "state"
  | "serviceFrom"
  | "serviceTo"
  | "total"
  | "createdAt"
>;
export type FinanceFolioQuery = {
  from?: string;
  to?: string;
  state?: FinanceFolioViewState;
  search?: string;
  sort: FinanceFolioSort;
  cursor?: string;
  limit: number;
};
export type FinanceFolioEnvelope = {
  contractVersion: typeof PMS_FINANCIALS_CONTRACT_VERSION;
  propertyId: string;
  currency: string;
  timeZone: string;
  generatedAt: string;
  sourceFreshness: Record<string, string>;
  incompleteEvidence: Array<{
    code: string;
    count: number;
    amount?: FinanceFolioMoney;
  }>;
};
export type FinanceFolioListResponse = FinanceFolioEnvelope & {
  page: { items: FinanceFolioSummary[]; nextCursor: string | null; limit: number };
};
export type FinanceFolioDetailResponse = FinanceFolioEnvelope & { item: FinanceFolio };

const QUERY_KEYS = ["from", "to", "state", "search", "sort", "cursor", "limit"] as const;

export function parseFinanceFolioQuery(value: unknown): FinanceFolioQuery | null {
  if (
    !record(value) ||
    Object.keys(value).some((key) => !QUERY_KEYS.includes(key as (typeof QUERY_KEYS)[number]))
  )
    return null;
  const from = optionalDate(value.from);
  const to = optionalDate(value.to);
  const state = optionalOneOf(value.state, FINANCE_FOLIO_VIEW_STATES);
  const sort = value.sort === undefined ? "createdAt_desc" : oneOf(value.sort, FINANCE_FOLIO_SORTS);
  const limit = queryLimit(value.limit);
  if (
    from === null ||
    to === null ||
    state === null ||
    sort === null ||
    limit === null ||
    (from !== undefined && to !== undefined && from > to) ||
    !optionalTrimmed(value.search, 1, 200) ||
    !optionalCursor(value.cursor)
  )
    return null;
  return compact({
    from,
    to,
    state,
    search: value.search as string | undefined,
    sort,
    cursor: value.cursor as string | undefined,
    limit,
  });
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function oneOf<const T extends readonly string[]>(value: unknown, values: T): T[number] | null {
  return typeof value === "string" && values.includes(value) ? (value as T[number]) : null;
}
function optionalOneOf<const T extends readonly string[]>(
  value: unknown,
  values: T,
): T[number] | null | undefined {
  return value === undefined ? undefined : oneOf(value, values);
}
function optionalDate(value: unknown): string | null | undefined {
  return value === undefined ? undefined : localDate(value) ? value : null;
}
function localDate(value: unknown): value is string {
  if (typeof value !== "string" || !/^[1-9]\d{3}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}
function optionalTrimmed(value: unknown, min: number, max: number): boolean {
  return (
    value === undefined ||
    (typeof value === "string" &&
      value === value.trim() &&
      value.length >= min &&
      value.length <= max)
  );
}
function optionalCursor(value: unknown): boolean {
  return (
    value === undefined ||
    (typeof value === "string" &&
      /^(?=.{2,4096}$)(?:[A-Za-z0-9_-]{4})*(?:[A-Za-z0-9_-]{2,3})?$/.test(value))
  );
}
function queryLimit(value: unknown): number | null {
  if (value === undefined) return 50;
  const parsed = typeof value === "string" && /^\d{1,3}$/.test(value) ? Number(value) : value;
  return Number.isSafeInteger(parsed) && Number(parsed) >= 1 && Number(parsed) <= 200
    ? Number(parsed)
    : null;
}
function compact<T extends Record<string, unknown>>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, part]) => part !== undefined)) as T;
}
