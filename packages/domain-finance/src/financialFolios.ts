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
export type FinanceFolioLineWrite = Omit<FinanceFolioLine, "lineId" | "total">;
export type FinanceFolioWrite = {
  commandId: string;
  idempotencyKey: string;
  expectedRevision?: number;
  bookingId?: string;
  recipient: FinanceFolioRecipient;
  serviceFrom: string;
  serviceTo: string;
  lines: FinanceFolioLineWrite[];
  paymentRefs: FinanceFolioPaymentReference[];
};
export type FinanceFolioRevisionCommand = Required<
  Pick<FinanceFolioWrite, "commandId" | "idempotencyKey" | "expectedRevision">
>;
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
export type FinanceFolioExportFilters = Readonly<
  Pick<FinanceFolioQuery, "from" | "to" | "search" | "sort"> & { state: "ready" }
>;
export type FinanceFolioExportSelection = Readonly<{
  folioId: string;
  revisionId: string;
  revision: number;
  sourceDigest: string;
}>;
export type FinanceFolioExportSnapshot = Readonly<{
  formatVersion: typeof FINANCE_FOLIO_CSV_VERSION;
  propertyId: string;
  currency: string;
  filters: FinanceFolioExportFilters;
  snapshotAt: string;
  manifest: readonly FinanceFolioExportSelection[];
}>;
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

export const FINANCE_FOLIO_CSV_VERSION = "pms-financials-folios.v1" as const;
export const FINANCE_FOLIO_CSV_CONTENT_TYPE = "text/csv; charset=utf-8" as const;
export const FINANCE_FOLIO_CSV_COLUMNS = [
  "property_id",
  "folio_id",
  "folio_revision",
  "folio_state",
  "booking_id",
  "recipient_name",
  "recipient_email",
  "service_from",
  "service_to",
  "currency",
  "folio_total",
  "line_position",
  "line_kind",
  "line_description",
  "quantity",
  "unit_amount",
  "line_total",
  "service_on",
  "source_type",
  "source_id",
  "source_revision",
  "payment_reference_ids",
  "payment_reference_amounts",
] as const;

export type FinanceFolioCsvArtifact = {
  formatVersion: typeof FINANCE_FOLIO_CSV_VERSION;
  contentType: typeof FINANCE_FOLIO_CSV_CONTENT_TYPE;
  propertyId: string;
  currency: string;
  filename: string;
  rowCount: number;
  body: string;
  auditEvidence: Array<{ folioId: string; revision: number; sourceDigest: string }>;
};

export class FinanceFolioCsvError extends TypeError {
  readonly code = "invalid_folio_csv_evidence";
}

const WRITE_KEYS = [
  "commandId",
  "idempotencyKey",
  "expectedRevision",
  "bookingId",
  "recipient",
  "serviceFrom",
  "serviceTo",
  "lines",
  "paymentRefs",
] as const;

export function parseFinanceFolioWrite(
  value: unknown,
  action: "create" | "correct",
): FinanceFolioWrite | null {
  if (
    !known(value, WRITE_KEYS) ||
    !has(
      value,
      WRITE_KEYS.filter((key) => key !== "expectedRevision" && key !== "bookingId"),
    )
  )
    return null;
  const expectedRevision = value.expectedRevision;
  if (
    !canonicalUuid(value.commandId) ||
    !clean(value.idempotencyKey, 1, 200) ||
    (action === "create" ? expectedRevision !== undefined : !revision(expectedRevision)) ||
    !(value.bookingId === undefined || canonicalUuid(value.bookingId)) ||
    !recipient(value.recipient) ||
    !localDate(value.serviceFrom) ||
    !localDate(value.serviceTo) ||
    value.serviceFrom > value.serviceTo ||
    !Array.isArray(value.lines) ||
    value.lines.length > 1_000 ||
    !Array.isArray(value.paymentRefs) ||
    value.paymentRefs.length > 1_000
  )
    return null;
  const serviceFrom = value.serviceFrom as string;
  const serviceTo = value.serviceTo as string;
  const lines = value.lines.map((line) => parseLineWrite(line, serviceFrom, serviceTo));
  const paymentRefs = value.paymentRefs.map(parsePaymentWrite);
  if (lines.includes(null) || paymentRefs.includes(null)) return null;
  const validLines = lines as FinanceFolioLineWrite[];
  const validPayments = paymentRefs as FinanceFolioPaymentReference[];
  const lineTotals = validLines.map(({ quantity, unitAmount }) =>
    roundedProduct(quantity, unitAmount.amount),
  );
  const total = lineTotals.reduce((sum, amount) => sum + amount, 0n);
  if (
    new Set(validLines.map(({ position }) => position)).size !== validLines.length ||
    new Set(validPayments.map(({ paymentId }) => paymentId)).size !== validPayments.length ||
    lineTotals.some((amount) => amount < -MAX_NUMERIC_19_4 || amount > MAX_NUMERIC_19_4) ||
    total < 0n ||
    total > MAX_NUMERIC_19_4 ||
    new Set([
      ...validLines.map(({ unitAmount }) => unitAmount.currency),
      ...validPayments.map(({ amount }) => amount.currency),
    ]).size > 1
  )
    return null;
  return compact({
    commandId: value.commandId,
    idempotencyKey: value.idempotencyKey,
    expectedRevision: expectedRevision as number | undefined,
    bookingId: value.bookingId as string | undefined,
    recipient: value.recipient,
    serviceFrom,
    serviceTo,
    lines: validLines.sort((left, right) => left.position - right.position),
    paymentRefs: validPayments.sort((left, right) => left.paymentId.localeCompare(right.paymentId)),
  });
}

export function parseFinanceFolioRevisionCommand(
  value: unknown,
): FinanceFolioRevisionCommand | null {
  if (
    !exact(value, ["commandId", "idempotencyKey", "expectedRevision"]) ||
    !canonicalUuid(value.commandId) ||
    !clean(value.idempotencyKey, 1, 200) ||
    !revision(value.expectedRevision)
  )
    return null;
  return value as FinanceFolioRevisionCommand;
}

export function buildFinanceFolioCsvArtifact(input: {
  propertyId: string;
  currency: string;
  folios: readonly FinanceFolio[];
}): FinanceFolioCsvArtifact {
  if (!canonicalUuid(input.propertyId) || !/^[A-Z]{3}$/.test(input.currency)) invalidCsv();
  const rows: string[][] = [];
  const auditEvidence: FinanceFolioCsvArtifact["auditEvidence"] = [];
  const selected = new Set<string>();

  for (const folio of input.folios) {
    if (
      folio.propertyId !== input.propertyId ||
      folio.currency !== input.currency ||
      folio.state !== "ready" ||
      !canonicalUuid(folio.folioId) ||
      (folio.bookingId !== null && !canonicalUuid(folio.bookingId)) ||
      !Number.isSafeInteger(folio.revision) ||
      folio.revision < 1 ||
      !/^[0-9a-f]{64}$/.test(folio.sourceDigest) ||
      folio.total.currency !== input.currency ||
      !decimal(folio.total.amount) ||
      scaled(folio.total.amount) < 0n ||
      typeof folio.recipient.name !== "string" ||
      (typeof folio.recipient.email !== "string" && folio.recipient.email !== null) ||
      !localDate(folio.serviceFrom) ||
      !localDate(folio.serviceTo) ||
      folio.serviceTo < folio.serviceFrom ||
      folio.lines.length === 0 ||
      selected.has(folio.folioId)
    )
      invalidCsv();
    selected.add(folio.folioId);
    auditEvidence.push({
      folioId: folio.folioId,
      revision: folio.revision,
      sourceDigest: folio.sourceDigest,
    });

    const payments = [...folio.paymentRefs].sort((left, right) =>
      left.paymentId < right.paymentId ? -1 : left.paymentId > right.paymentId ? 1 : 0,
    );
    const paymentIdsSeen = new Set<string>();
    for (const payment of payments) {
      if (
        !canonicalUuid(payment.paymentId) ||
        paymentIdsSeen.has(payment.paymentId) ||
        payment.amount.currency !== input.currency ||
        !decimal(payment.amount.amount) ||
        scaled(payment.amount.amount) <= 0n
      )
        invalidCsv();
      paymentIdsSeen.add(payment.paymentId);
    }
    const paymentIds = payments.map((payment) => payment.paymentId).join(";");
    const paymentAmounts = payments.map((payment) => payment.amount.amount).join(";");
    const positions = new Set<number>();

    for (const line of [...folio.lines].sort((left, right) => left.position - right.position)) {
      if (
        !Number.isSafeInteger(line.position) ||
        line.position < 1 ||
        positions.has(line.position) ||
        !canonicalUuid(line.lineId) ||
        !FINANCE_FOLIO_LINE_KINDS.includes(line.kind) ||
        typeof line.description !== "string" ||
        line.unitAmount.currency !== input.currency ||
        line.total.currency !== input.currency ||
        !decimal(line.quantity) ||
        scaled(line.quantity) <= 0n ||
        !decimal(line.unitAmount.amount) ||
        !decimal(line.total.amount) ||
        scaled(line.total.amount) !== roundedProduct(line.quantity, line.unitAmount.amount) ||
        !localDate(line.serviceOn) ||
        line.serviceOn < folio.serviceFrom ||
        line.serviceOn > folio.serviceTo ||
        !/^[a-z][a-z0-9_.-]{0,49}$/.test(line.source.type) ||
        !/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$/.test(line.source.id) ||
        !Number.isSafeInteger(line.source.revision) ||
        line.source.revision < 1
      )
        invalidCsv();
      positions.add(line.position);
      rows.push([
        input.propertyId,
        folio.folioId,
        String(folio.revision),
        "ready",
        folio.bookingId ?? "",
        safeText(folio.recipient.name),
        safeText(folio.recipient.email ?? ""),
        folio.serviceFrom,
        folio.serviceTo,
        input.currency,
        folio.total.amount,
        String(line.position),
        line.kind,
        safeText(line.description),
        line.quantity,
        line.unitAmount.amount,
        line.total.amount,
        line.serviceOn,
        line.source.type,
        line.source.id,
        String(line.source.revision),
        paymentIds,
        paymentAmounts,
      ]);
    }
    if (
      folio.lines.reduce((sum, line) => sum + scaled(line.total.amount), 0n) !==
      scaled(folio.total.amount)
    )
      invalidCsv();
  }

  return {
    formatVersion: FINANCE_FOLIO_CSV_VERSION,
    contentType: FINANCE_FOLIO_CSV_CONTENT_TYPE,
    propertyId: input.propertyId,
    currency: input.currency,
    filename: `pms-financials-folios-${input.propertyId}.csv`,
    rowCount: rows.length,
    body: [FINANCE_FOLIO_CSV_COLUMNS, ...rows].map(csvRow).join("\r\n") + "\r\n",
    auditEvidence,
  };
}

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

export function parseFinanceFolioExportFilters(value: unknown): FinanceFolioExportFilters | null {
  if (!record(value) || Object.hasOwn(value, "cursor") || Object.hasOwn(value, "limit"))
    return null;
  const query = parseFinanceFolioQuery(value);
  if (!query || query.state !== "ready") return null;
  const { from, to, search, sort } = query;
  return compact({ from, to, search, sort, state: "ready" as const });
}

export function parseFinanceFolioExportSnapshot(value: unknown): FinanceFolioExportSnapshot | null {
  if (
    !record(value) ||
    Object.keys(value).length !== 6 ||
    value.formatVersion !== FINANCE_FOLIO_CSV_VERSION ||
    !canonicalUuid(value.propertyId) ||
    !/^[A-Z]{3}$/.test(String(value.currency)) ||
    !canonicalInstant(value.snapshotAt) ||
    !Array.isArray(value.manifest)
  )
    return null;
  const filters = parseFinanceFolioExportFilters(value.filters),
    folios = new Set<string>(),
    revisions = new Set<string>();
  if (!filters) return null;
  const manifest: FinanceFolioExportSelection[] = [];
  for (const raw of value.manifest) {
    if (
      !record(raw) ||
      Object.keys(raw).length !== 4 ||
      !canonicalUuid(raw.folioId) ||
      !canonicalUuid(raw.revisionId) ||
      !Number.isSafeInteger(raw.revision) ||
      Number(raw.revision) < 1 ||
      !/^[0-9a-f]{64}$/.test(String(raw.sourceDigest)) ||
      folios.has(raw.folioId) ||
      revisions.has(raw.revisionId)
    )
      return null;
    folios.add(raw.folioId);
    revisions.add(raw.revisionId);
    manifest.push({
      folioId: raw.folioId,
      revisionId: raw.revisionId,
      revision: Number(raw.revision),
      sourceDigest: String(raw.sourceDigest),
    });
  }
  return {
    formatVersion: FINANCE_FOLIO_CSV_VERSION,
    propertyId: value.propertyId,
    currency: String(value.currency),
    filters,
    snapshotAt: value.snapshotAt,
    manifest,
  };
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function known(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  return record(value) && Object.keys(value).every((key) => keys.includes(key));
}
function exact(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  return known(value, keys) && has(value, keys);
}
function has(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return keys.every((key) => Object.hasOwn(value, key));
}
function recipient(value: unknown): value is FinanceFolioRecipient {
  if (
    !exact(value, ["name", "email"]) ||
    !clean(value.name, 1, 4_000) ||
    !(value.email === null || (trimmed(value.email, 3, 320) && value.email.includes("@")))
  )
    return false;
  return (
    new TextEncoder().encode(JSON.stringify({ v: 1, name: value.name, email: value.email }))
      .length <= 4_096
  );
}
function parseLineWrite(value: unknown, from: string, to: string): FinanceFolioLineWrite | null {
  if (
    !exact(value, [
      "position",
      "kind",
      "description",
      "quantity",
      "unitAmount",
      "serviceOn",
      "source",
    ]) ||
    !Number.isSafeInteger(value.position) ||
    Number(value.position) < 1 ||
    Number(value.position) > 1_000 ||
    !FINANCE_FOLIO_LINE_KINDS.includes(value.kind as FinanceFolioLineKind) ||
    !clean(value.description, 1, 500) ||
    !localDate(value.serviceOn) ||
    value.serviceOn < from ||
    value.serviceOn > to ||
    !exact(value.unitAmount, ["amount", "currency"]) ||
    !exact(value.source, ["type", "id", "revision"])
  )
    return null;
  const quantity = writeDecimal(value.quantity, false, false);
  const amount = writeDecimal(value.unitAmount.amount, true, true);
  if (
    !quantity ||
    !amount ||
    typeof value.unitAmount.currency !== "string" ||
    !/^[A-Z]{3}$/.test(value.unitAmount.currency) ||
    typeof value.source.type !== "string" ||
    !/^[a-z][a-z0-9_.-]{0,49}$/.test(value.source.type) ||
    typeof value.source.id !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$/.test(value.source.id) ||
    !revision(value.source.revision)
  )
    return null;
  return {
    position: Number(value.position),
    kind: value.kind as FinanceFolioLineKind,
    description: value.description,
    quantity,
    unitAmount: { amount, currency: value.unitAmount.currency },
    serviceOn: value.serviceOn,
    source: {
      type: value.source.type,
      id: value.source.id,
      revision: value.source.revision,
    },
  };
}
function parsePaymentWrite(value: unknown): FinanceFolioPaymentReference | null {
  if (
    !exact(value, ["paymentId", "amount"]) ||
    !canonicalUuid(value.paymentId) ||
    !exact(value.amount, ["amount", "currency"])
  )
    return null;
  const amount = writeDecimal(value.amount.amount, false, false);
  return amount &&
    typeof value.amount.currency === "string" &&
    /^[A-Z]{3}$/.test(value.amount.currency)
    ? { paymentId: value.paymentId, amount: { amount, currency: value.amount.currency } }
    : null;
}
function writeDecimal(value: unknown, signed: boolean, zero: boolean): string | null {
  if (typeof value !== "string" || !/^-?(?:0|[1-9]\d{0,14})(?:\.\d{1,4})?$/.test(value))
    return null;
  const [whole, fraction = ""] = value.replace("-", "").split(".");
  const normalized = `${value.startsWith("-") ? "-" : ""}${whole}.${fraction.padEnd(4, "0")}`;
  if (!signed && normalized.startsWith("-")) return null;
  if (scaled(normalized) === 0n) return zero ? "0.0000" : null;
  return normalized;
}
function revision(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 1 && Number(value) <= 2_147_483_647;
}
function trimmed(value: unknown, min: number, max: number): value is string {
  return (
    typeof value === "string" &&
    value === value.trim() &&
    value.length >= min &&
    value.length <= max
  );
}
function clean(value: unknown, min: number, max: number): value is string {
  return trimmed(value, min, max) && !/[\p{Cc}]/u.test(value);
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

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const MAX_NUMERIC_19_4 = 9_999_999_999_999_999_999n;
const canonicalUuid = (value: unknown): value is string =>
  typeof value === "string" && UUID.test(value) && value === value.toLowerCase();
const canonicalInstant = (value: unknown): value is string =>
  typeof value === "string" &&
  Number.isFinite(new Date(value).getTime()) &&
  new Date(value).toISOString() === value;
const decimal = (value: string) => /^-?(?:0|[1-9]\d{0,14})\.\d{4}$/.test(value);
const scaled = (value: string) => BigInt(value.replace(".", ""));
function roundedProduct(left: string, right: string): bigint {
  const product = scaled(left) * scaled(right);
  const quotient = product / 10_000n;
  const remainder = product % 10_000n;
  return remainder * (remainder < 0n ? -2n : 2n) >= 10_000n
    ? quotient + (product < 0n ? -1n : 1n)
    : quotient;
}
const safeText = (value: string) => (/^[=+\-@\t\r\n]/.test(value) ? `'${value}` : value);
const csvRow = (values: readonly string[]) =>
  values.map((value) => `"${value.replaceAll('"', '""')}"`).join(",");
function invalidCsv(): never {
  throw new FinanceFolioCsvError("Folio CSV evidence violates the export contract");
}
