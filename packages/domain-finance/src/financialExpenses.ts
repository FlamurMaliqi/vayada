export const PMS_FINANCIALS_CONTRACT_VERSION = "pms-financials.v1" as const;

// prettier-ignore
export const FINANCE_EXPENSE_ORIGINS = ["manual", "recurring", "ota_commission", "platform_fee", "supplier_bill"] as const;
export const FINANCE_EXPENSE_CADENCES = ["weekly", "monthly", "yearly"] as const;
export const FINANCE_EXPENSE_PAYMENT_STATUSES = ["paid", "unpaid"] as const;
export const FINANCE_EXPENSE_SORTS = ["incurredOn_desc", "amount_desc"] as const;

export type FinanceExpenseOrigin = (typeof FINANCE_EXPENSE_ORIGINS)[number];
export type FinanceExpenseCadence = (typeof FINANCE_EXPENSE_CADENCES)[number];
export type FinanceExpensePaymentStatus = (typeof FINANCE_EXPENSE_PAYMENT_STATUSES)[number];
export type FinanceExpenseSort = (typeof FINANCE_EXPENSE_SORTS)[number];
declare const financeExpenseAmountBrand: unique symbol;
export type FinanceExpenseAmount = string & { readonly [financeExpenseAmountBrand]: true };

export type FinanceExpenseMoney = { amount: FinanceExpenseAmount; currency: string };
export type FinanceExpensePage<T> = { items: T[]; nextCursor: string | null; limit: number };
export type FinanceExpenseIncompleteEvidence = {
  code: string;
  count: number;
  amount?: FinanceExpenseMoney;
};
export type FinanceExpenseEnvelope = {
  contractVersion: typeof PMS_FINANCIALS_CONTRACT_VERSION;
  propertyId: string;
  currency: string;
  timeZone: string;
  generatedAt: string;
  sourceFreshness: Record<string, string>;
  incompleteEvidence: readonly FinanceExpenseIncompleteEvidence[];
};
export type FinanceExpenseCommand = {
  commandId: string;
  idempotencyKey: string;
  expectedRevision?: number;
};
export type FinanceExpenseCategory = {
  id: string;
  systemKey: string | null;
  name: string;
  color: string;
  sortOrder: number;
  archived: boolean;
  revision: number;
};
export type FinanceExpense = {
  id: string;
  categoryId: string;
  origin: FinanceExpenseOrigin;
  incurredOn: string;
  paidOn: string | null;
  vendor: string;
  amount: FinanceExpenseMoney;
  paymentStatus: FinanceExpensePaymentStatus;
  recurringRuleId: string | null;
  sourceKey: string | null;
  reversesExpenseId: string | null;
  revision: number;
};
export type FinanceRecurringExpenseRule = {
  id: string;
  cadence: FinanceExpenseCadence;
  nextDueOn: string;
  endsOn: string | null;
  active: boolean;
  revision: number;
};
export type FinanceExpenseQuery = {
  from: string;
  to: string;
  cursor?: string;
  limit: number;
  categoryId?: string;
  paymentStatus?: FinanceExpensePaymentStatus;
  recurring?: boolean;
  origin?: FinanceExpenseOrigin;
  search?: string;
  sort: FinanceExpenseSort;
};
export type FinanceExpenseRecurrenceWrite = {
  cadence: FinanceExpenseCadence;
  startsOn: string;
  endsOn?: string;
};
export type FinanceExpenseWrite = FinanceExpenseCommand & {
  incurredOn: string;
  vendor: string;
  categoryId: string;
  amount: FinanceExpenseMoney;
  paymentStatus: FinanceExpensePaymentStatus;
  paidOn?: string;
  notes?: string;
  supplierInvoiceNumber?: string;
  recurrence?: FinanceExpenseRecurrenceWrite;
};
export type FinanceExpenseCommandResult<T> =
  | { ok: true; outcome: "created" | "updated" | "replayed"; item: T }
  | {
      ok: false;
      code:
        | "invalid_command"
        | "not_found"
        | "revision_conflict"
        | "idempotency_conflict"
        | "currency_mismatch"
        | "evidence_mismatch"
        | "write_unavailable";
    };

export function normalizeFinanceExpenseAmount(value: string): FinanceExpenseAmount | null {
  if (!/^(?:0|[1-9]\d{0,14})(?:\.\d{1,4})?$/.test(value)) return null;
  const [whole, fraction = ""] = value.split(".");
  const normalized = `${whole}.${fraction.padEnd(4, "0")}`;
  return normalized === "0.0000" ? null : (normalized as FinanceExpenseAmount);
}

export function parseFinanceExpenseQuery(value: unknown): FinanceExpenseQuery | null {
  if (!recordWithKnownKeys(value, QUERY_KEYS) || !localDate(value.from) || !localDate(value.to))
    return null;
  const sort =
    value.sort === undefined ? "incurredOn_desc" : oneOf(value.sort, FINANCE_EXPENSE_SORTS);
  const limit = queryLimit(value.limit);
  const recurring = queryBoolean(value.recurring);
  const query: FinanceExpenseQuery = {
    from: value.from,
    to: value.to,
    limit: limit ?? 0,
    sort: sort ?? "incurredOn_desc",
  };
  if (query.limit === 0 || !sort || query.from > query.to) return null;
  if (!optionalCursor(value.cursor)) return null;
  if (!optionalUuid(value.categoryId)) return null;
  if (!optionalOneOf(value.paymentStatus, FINANCE_EXPENSE_PAYMENT_STATUSES)) return null;
  if (recurring === null) return null;
  if (!optionalOneOf(value.origin, FINANCE_EXPENSE_ORIGINS)) return null;
  if (!optionalTrimmed(value.search, 1, 200)) return null;
  return compact({
    ...query,
    cursor: value.cursor as string | undefined,
    categoryId: value.categoryId as string | undefined,
    paymentStatus: value.paymentStatus as FinanceExpensePaymentStatus | undefined,
    recurring: recurring ?? undefined,
    origin: value.origin as FinanceExpenseOrigin | undefined,
    search: value.search as string | undefined,
  });
}

export function parseFinanceExpenseWrite(value: unknown): FinanceExpenseWrite | null {
  if (!recordWithKnownKeys(value, EXPENSE_WRITE_KEYS) || !hasKeys(value, EXPENSE_REQUIRED_KEYS))
    return null;
  const command = parseCommand(value);
  const amount = parseMoney(value.amount);
  const recurrence = parseRecurrence(value.recurrence);
  const paymentStatus = oneOf(value.paymentStatus, FINANCE_EXPENSE_PAYMENT_STATUSES);
  if (
    !command ||
    !localDate(value.incurredOn) ||
    !trimmed(value.vendor, 1, 200) ||
    !uuid(value.categoryId) ||
    !amount ||
    !paymentStatus ||
    !optionalLocalDate(value.paidOn) ||
    !optionalTrimmed(value.notes, 1, 2000) ||
    !optionalTrimmed(value.supplierInvoiceNumber, 1, 200) ||
    recurrence === null ||
    (value.paymentStatus === "paid") !== (value.paidOn !== undefined)
  )
    return null;
  return compact({
    ...command,
    incurredOn: value.incurredOn,
    vendor: value.vendor,
    categoryId: value.categoryId,
    amount,
    paymentStatus,
    paidOn: value.paidOn as string | undefined,
    notes: value.notes as string | undefined,
    supplierInvoiceNumber: value.supplierInvoiceNumber as string | undefined,
    recurrence: recurrence ?? undefined,
  });
}

const COMMAND_KEYS = ["commandId", "idempotencyKey", "expectedRevision"] as const;
// prettier-ignore
const QUERY_KEYS = ["from", "to", "cursor", "limit", "categoryId", "paymentStatus", "recurring", "origin", "search", "sort"] as const;
// prettier-ignore
const EXPENSE_REQUIRED_KEYS = [...COMMAND_KEYS.slice(0, 2), "incurredOn", "vendor", "categoryId", "amount", "paymentStatus"];
const EXPENSE_WRITE_KEYS = [
  ...COMMAND_KEYS,
  ...EXPENSE_REQUIRED_KEYS.slice(2),
  "paidOn",
  "notes",
  "supplierInvoiceNumber",
  "recurrence",
];

function parseCommand(value: Record<string, unknown>): FinanceExpenseCommand | null {
  return uuid(value.commandId) &&
    trimmed(value.idempotencyKey, 1, 200) &&
    (value.expectedRevision === undefined || revision(value.expectedRevision))
    ? compact({
        commandId: value.commandId,
        idempotencyKey: value.idempotencyKey,
        expectedRevision: value.expectedRevision,
      })
    : null;
}
function parseMoney(value: unknown): FinanceExpenseMoney | null {
  if (!recordWithExactKeys(value, ["amount", "currency"]) || typeof value.amount !== "string")
    return null;
  const amount = normalizeFinanceExpenseAmount(value.amount);
  return amount && typeof value.currency === "string" && /^[A-Z]{3}$/.test(value.currency)
    ? { amount, currency: value.currency }
    : null;
}
function parseRecurrence(value: unknown): FinanceExpenseRecurrenceWrite | null | undefined {
  if (value === undefined) return undefined;
  if (
    !recordWithKnownKeys(value, ["cadence", "startsOn", "endsOn"]) ||
    !hasKeys(value, ["cadence", "startsOn"])
  )
    return null;
  const cadence = oneOf(value.cadence, FINANCE_EXPENSE_CADENCES);
  if (
    !cadence ||
    !localDate(value.startsOn) ||
    !optionalLocalDate(value.endsOn) ||
    (value.endsOn !== undefined && (value.endsOn as string) < value.startsOn)
  )
    return null;
  return compact({ cadence, startsOn: value.startsOn, endsOn: value.endsOn as string | undefined });
}
function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function recordWithKnownKeys(
  value: unknown,
  keys: readonly string[],
): value is Record<string, unknown> {
  return record(value) && Object.keys(value).every((key) => keys.includes(key));
}
function recordWithExactKeys(
  value: unknown,
  keys: readonly string[],
): value is Record<string, unknown> {
  return recordWithKnownKeys(value, keys) && hasKeys(value, keys);
}
function hasKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return keys.every((key) => Object.hasOwn(value, key));
}
function oneOf<const T extends readonly string[]>(value: unknown, values: T): T[number] | null {
  return typeof value === "string" && values.includes(value) ? (value as T[number]) : null;
}
function optionalOneOf<const T extends readonly string[]>(value: unknown, values: T): boolean {
  return value === undefined || oneOf(value, values) !== null;
}
function trimmed(value: unknown, min: number, max: number): value is string {
  return (
    typeof value === "string" &&
    value === value.trim() &&
    value.length >= min &&
    value.length <= max
  );
}
function optionalTrimmed(value: unknown, min: number, max: number): boolean {
  return value === undefined || trimmed(value, min, max);
}
function optionalCursor(value: unknown): boolean {
  // prettier-ignore
  return value === undefined || (typeof value === "string" && /^(?=.{2,4096}$)(?:[A-Za-z0-9_-]{4})*(?:[A-Za-z0-9_-]{2,3})?$/.test(value));
}
function uuid(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
  );
}
function optionalUuid(value: unknown): boolean {
  return value === undefined || uuid(value);
}
function revision(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 1 && Number(value) <= 2_147_483_647;
}
function validLimit(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 1 && Number(value) <= 200;
}
function queryLimit(value: unknown): number | null {
  if (value === undefined) return 50;
  const parsed = typeof value === "string" && /^\d{1,3}$/.test(value) ? Number(value) : value;
  return validLimit(parsed) ? parsed : null;
}
function queryBoolean(value: unknown): boolean | null | undefined {
  if (value === undefined) return undefined;
  if (value === true || value === "true") return true;
  if (value === false || value === "false") return false;
  return null;
}
function optionalLocalDate(value: unknown): boolean {
  return value === undefined || localDate(value);
}
function localDate(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}
function compact<T extends Record<string, unknown>>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, part]) => part !== undefined)) as T;
}
