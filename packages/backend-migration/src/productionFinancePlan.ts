import { requiredText, sha256, uuid } from "./productionBookingValues.js";
import type { ProductionMigrationSourceLink } from "./productionBookingTypes.js";
import {
  block,
  createProductionFinanceContext,
  organizationFor,
  propertyFor,
  sourceId,
  sourceRows,
} from "./productionFinanceContext.js";
import { buildFinanceRecords, paymentStatus, payoutStatus } from "./productionFinanceRecords.js";
import type {
  ExistingFinanceTargetRecord,
  FinanceBuildContext,
  FinanceTargetRecord,
  ProductionFinancePlan,
  ProductionFinanceTargetState,
} from "./productionFinanceTypes.js";
import { exactMoney, subtractMoney, supportedCurrency } from "./productionFinanceValues.js";
import type { IdentitySourceRow } from "./productionIdentityDisposition.js";

export function buildProductionFinancePlan(input: {
  sourceRunId: string;
  completedAt: string;
  rows: IdentitySourceRow[];
  target: ProductionFinanceTargetState;
}): ProductionFinancePlan {
  const context = createProductionFinanceContext(input);
  const candidates = buildFinanceRecords(context).sort((left, right) =>
    targetKey(left).localeCompare(targetKey(right)),
  );
  return reconcileProductionFinanceRecords(context, candidates);
}

export function reconcileProductionFinanceRecords(
  context: FinanceBuildContext,
  candidates: FinanceTargetRecord[],
): ProductionFinancePlan {
  const existing = new Map(context.target.records.map((row) => [targetKey(row), row]));
  const provenance = new Map(context.target.provenance.map((row) => [provenanceKey(row), row]));
  const duplicateKeys = duplicates(candidates.map(targetKey));
  const blockedProviderRefs = duplicateProviderRefs(candidates);
  addExternalReferenceBlockers(context, candidates);
  for (const key of duplicateKeys) {
    const candidate = candidates.find((row) => targetKey(row) === key)!;
    addRecordBlocker(
      context,
      "DUPLICATE_FINANCE_TARGET",
      candidate,
      "Multiple source rows map to the same Finance target identity",
    );
  }
  for (const key of blockedProviderRefs) {
    const candidate = candidates.find((row) => providerRef(row) === key)!;
    addRecordBlocker(
      context,
      "DUPLICATE_PROVIDER_ACCOUNT_ID",
      candidate,
      "Provider account identity is owned by multiple Finance scopes",
    );
  }
  const records: FinanceTargetRecord[] = [];
  const writes: FinanceTargetRecord[] = [];
  const links: ProductionMigrationSourceLink[] = [];
  const counts = {
    sourceRows: context.rows.length,
    plannedRecords: 0,
    inserts: 0,
    updates: 0,
    unchanged: 0,
    preservedNewerTarget: 0,
    preservedTargetDeletions: 0,
  };
  for (const candidate of candidates) {
    if (duplicateKeys.has(targetKey(candidate)) || blockedProviderRefs.has(providerRef(candidate)))
      continue;
    const prior = provenance.get(provenanceKey(candidate));
    const action = reconcile(candidate, existing.get(targetKey(candidate)), prior, context);
    if (action === "block") continue;
    records.push(candidate);
    if (["insert", "update", "unchanged"].includes(action))
      links.push(linkFor(candidate, prior, context, action));
    if (action === "insert" || action === "update") writes.push(candidate);
    if (action === "insert") counts.inserts += 1;
    else if (action === "update") counts.updates += 1;
    else if (action === "unchanged") counts.unchanged += 1;
    else if (action === "preserve_newer") counts.preservedNewerTarget += 1;
    else counts.preservedTargetDeletions += 1;
  }
  counts.plannedRecords = records.length;
  const parity = {
    sourceTableCounts: countBy(context.rows, (row) => `${row.sourceDatabase}.${row.sourceTable}`),
    targetTableCounts: countBy(records, (row) => `finance.${row.targetTable}`),
    sourcePaymentAmountsByCurrencyStatusOwner: rawEconomicSums(context, "payments", "amount"),
    targetPaymentAmountsByCurrencyStatusOwner: economicSums(records, "payments", "amount"),
    sourcePaymentCountsByCurrencyStatusOwner: rawEconomicCounts(context, "payments"),
    targetPaymentCountsByCurrencyStatusOwner: economicCounts(records, "payments"),
    sourcePaymentFeesByCurrencyStatusOwner: rawEconomicSums(context, "payments", "feeAmount"),
    targetPaymentFeesByCurrencyStatusOwner: economicSums(records, "payments", "feeAmount"),
    sourcePaymentNetByCurrencyStatusOwner: rawEconomicSums(context, "payments", "netAmount"),
    targetPaymentNetByCurrencyStatusOwner: economicSums(records, "payments", "netAmount"),
    sourcePaymentRefundsByCurrencyStatusOwner: rawEconomicSums(
      context,
      "payments",
      "refundedAmount",
    ),
    targetPaymentRefundsByCurrencyStatusOwner: economicSums(records, "payments", "refundedAmount"),
    sourcePayoutAmountsByCurrencyStatusOwner: rawEconomicSums(context, "payouts", "amount"),
    targetPayoutAmountsByCurrencyStatusOwner: economicSums(records, "payouts", "amount"),
    sourcePayoutCountsByCurrencyStatusOwner: rawEconomicCounts(context, "payouts"),
    targetPayoutCountsByCurrencyStatusOwner: economicCounts(records, "payouts"),
    sourcePayoutNetByCurrencyStatusOwner: rawEconomicSums(context, "payouts", "netAmount"),
    targetPayoutNetByCurrencyStatusOwner: economicSums(records, "payouts", "netAmount"),
    sourcePayoutAllocationsByBookingOwner: rawPayoutAllocations(context),
    targetPayoutAllocationsByBookingOwner: targetPayoutAllocations(context, records),
  };
  for (const [source, target, code, table, message] of [
    [
      parity.sourcePaymentAmountsByCurrencyStatusOwner,
      parity.targetPaymentAmountsByCurrencyStatusOwner,
      "FINANCE_PAYMENT_MONETARY_PARITY_MISMATCH",
      "payments",
      "gross amounts",
    ],
    [
      parity.sourcePaymentCountsByCurrencyStatusOwner,
      parity.targetPaymentCountsByCurrencyStatusOwner,
      "FINANCE_PAYMENT_DIMENSION_COUNT_MISMATCH",
      "payments",
      "counts",
    ],
    [
      parity.sourcePaymentFeesByCurrencyStatusOwner,
      parity.targetPaymentFeesByCurrencyStatusOwner,
      "FINANCE_PAYMENT_FEE_PARITY_MISMATCH",
      "payments",
      "fees",
    ],
    [
      parity.sourcePaymentNetByCurrencyStatusOwner,
      parity.targetPaymentNetByCurrencyStatusOwner,
      "FINANCE_PAYMENT_NET_PARITY_MISMATCH",
      "payments",
      "net amounts",
    ],
    [
      parity.sourcePaymentRefundsByCurrencyStatusOwner,
      parity.targetPaymentRefundsByCurrencyStatusOwner,
      "FINANCE_PAYMENT_REFUND_PARITY_MISMATCH",
      "payments",
      "refunds",
    ],
    [
      parity.sourcePayoutAmountsByCurrencyStatusOwner,
      parity.targetPayoutAmountsByCurrencyStatusOwner,
      "FINANCE_PAYOUT_MONETARY_PARITY_MISMATCH",
      "payouts",
      "gross amounts",
    ],
    [
      parity.sourcePayoutCountsByCurrencyStatusOwner,
      parity.targetPayoutCountsByCurrencyStatusOwner,
      "FINANCE_PAYOUT_DIMENSION_COUNT_MISMATCH",
      "payouts",
      "counts",
    ],
    [
      parity.sourcePayoutNetByCurrencyStatusOwner,
      parity.targetPayoutNetByCurrencyStatusOwner,
      "FINANCE_PAYOUT_NET_PARITY_MISMATCH",
      "payouts",
      "net amounts",
    ],
    [
      parity.sourcePayoutAllocationsByBookingOwner,
      parity.targetPayoutAllocationsByBookingOwner,
      "FINANCE_PAYOUT_ALLOCATION_PARITY_MISMATCH",
      "payouts",
      "booking-owner allocations",
    ],
  ] as const)
    if (sha256(source) !== sha256(target))
      block(
        context,
        code,
        `finance.${table}`,
        context.sourceRunId,
        `Raw source and planned target ${message} differ by required Finance dimensions`,
      );
  for (const [sourceTable, targetTable] of [
    ["payments", "payments"],
    ["payouts", "payouts"],
    ["commission_rate_changes", "commission_rate_changes"],
  ] as const) {
    const sourceCount = context.rows.filter((row) => row.sourceTable === sourceTable).length;
    const targetCount = records.filter((row) => row.targetTable === targetTable).length;
    if (sourceCount !== targetCount)
      block(
        context,
        "FINANCE_EXACT_COUNT_PARITY_MISMATCH",
        `finance.${targetTable}`,
        context.sourceRunId,
        `${sourceCount} source ${sourceTable} rows produced ${targetCount} planned target rows`,
      );
  }
  const blockers = context.blockers.sort((left, right) =>
    `${left.code}:${left.source}:${left.sourceId}`.localeCompare(
      `${right.code}:${right.source}:${right.sourceId}`,
    ),
  );
  return {
    sourceRunId: context.sourceRunId,
    checksum: sha256({
      records: records.map((record) => ({
        key: targetKey(record),
        sourceChecksum: record.sourceChecksum,
        row: record.row,
      })),
      blockers,
      parity,
    }),
    records,
    writes,
    provenance: links,
    blockers,
    parity,
    counts,
  };
}

type Action = "insert" | "update" | "unchanged" | "preserve_newer" | "preserve_deletion" | "block";

function reconcile(
  candidate: FinanceTargetRecord,
  current: ExistingFinanceTargetRecord | undefined,
  prior: ProductionMigrationSourceLink | undefined,
  context: FinanceBuildContext,
): Action {
  const economicFact =
    candidate.targetTable === "payments" ||
    candidate.targetTable === "payouts" ||
    candidate.targetTable === "commission_rate_changes";
  if (!candidate.mutable && current) {
    if (sameRecord(candidate.row, current.row)) return "unchanged";
    addRecordBlocker(
      context,
      "FINANCE_IMMUTABLE_CONFLICT",
      candidate,
      "Immutable Finance history permits only insert or exact unchanged replay",
    );
    return "block";
  }
  if (prior) {
    if (!current) {
      if (economicFact) {
        addRecordBlocker(
          context,
          "FINANCE_TARGET_DELETION_REVIEW_REQUIRED",
          candidate,
          "Previously migrated economic evidence is absent from the target",
        );
        return "block";
      }
      return "preserve_deletion";
    }
    if (prior.sourceChecksum === candidate.sourceChecksum) {
      if (sameRecord(candidate.row, current.row)) return "unchanged";
      if (Date.parse(current.updatedAt) > Date.parse(prior.lastMigratedAt)) {
        if (economicFact) {
          addRecordBlocker(
            context,
            "FINANCE_ECONOMIC_TARGET_NEWER",
            candidate,
            "Newer target economic state requires explicit review and cannot be overwritten",
          );
          return "block";
        }
        return "preserve_newer";
      }
      addRecordBlocker(
        context,
        "FINANCE_TARGET_PROVENANCE_MISMATCH",
        candidate,
        "Target differs from unchanged provenance without a newer timestamp",
      );
      return "block";
    }
    if (Date.parse(current.updatedAt) > Date.parse(prior.lastMigratedAt)) {
      addRecordBlocker(
        context,
        economicFact ? "FINANCE_ECONOMIC_TARGET_NEWER" : "FINANCE_TARGET_NEWER",
        candidate,
        "Newer target state cannot be overwritten by the legacy snapshot",
      );
      return "block";
    }
    return "update";
  }
  if (!current) return "insert";
  if (sameRecord(candidate.row, current.row)) return "unchanged";
  if (Date.parse(current.updatedAt) >= Date.parse(candidate.sourceUpdatedAt)) {
    addRecordBlocker(
      context,
      "FINANCE_TARGET_CONFLICT",
      candidate,
      "Existing target is at least as fresh and differs without migration provenance",
    );
    return "block";
  }
  return "update";
}

function linkFor(
  record: FinanceTargetRecord,
  prior: ProductionMigrationSourceLink | undefined,
  context: FinanceBuildContext,
  action: Action,
): ProductionMigrationSourceLink {
  return {
    sourceDatabase: record.sourceDatabase,
    sourceTable: record.sourceTable,
    sourceId: record.sourceId,
    targetProduct: record.targetProduct,
    targetTable: record.targetTable,
    targetId: record.targetId,
    sourceChecksum: record.sourceChecksum,
    sourceUpdatedAt: record.sourceUpdatedAt,
    lastMigratedAt:
      action === "update" ? context.completedAt : (prior?.lastMigratedAt ?? context.completedAt),
  };
}

function economicSums(
  records: FinanceTargetRecord[],
  targetTable: "payments" | "payouts",
  field: "amount" | "feeAmount" | "netAmount" | "refundedAmount",
): Record<string, string> {
  const sums = new Map<string, bigint>();
  const providerByAccount = providerIndex(records);
  for (const record of records.filter((row) => row.targetTable === targetTable)) {
    const key = targetEconomicDimension(record, targetTable, providerByAccount);
    sums.set(key, (sums.get(key) ?? 0n) + minor(String(record.row[field])));
  }
  return formattedSums(sums);
}

function rawEconomicSums(
  context: FinanceBuildContext,
  targetTable: "payments" | "payouts",
  field: "amount" | "feeAmount" | "netAmount" | "refundedAmount",
): Record<string, string> {
  const sums = new Map<string, bigint>();
  for (const row of sourceRows(context, "pms", targetTable)) {
    try {
      const key = rawEconomicDimension(context, targetTable, row);
      sums.set(key, (sums.get(key) ?? 0n) + minor(rawEconomicValue(targetTable, field, row)));
    } catch {
      // The row transformation already emits an auditable blocker and exact-count mismatch.
    }
  }
  return formattedSums(sums);
}

function rawPaymentProvider(row: IdentitySourceRow): string {
  if (row.data["stripe_account_id"] || row.data["stripe_payment_intent_id"]) return "stripe";
  if (row.data["xendit_invoice_id"]) return "xendit";
  return "unbound";
}

function rawEconomicValue(
  targetTable: "payments" | "payouts",
  field: "amount" | "feeAmount" | "netAmount" | "refundedAmount",
  row: IdentitySourceRow,
): string {
  const amount = exactMoney(row.data["amount"], "amount");
  if (field === "amount" || (targetTable === "payouts" && field === "netAmount")) return amount;
  if (targetTable === "payouts") return "0.00";
  const fee = exactMoney(
    row.data["stripe_application_fee_amount"],
    "stripe_application_fee_amount",
    "0.00",
  );
  if (field === "feeAmount") return fee;
  if (field === "netAmount") return subtractMoney(amount, fee, "stripe_application_fee_amount");
  return exactMoney(row.data["refund_amount"], "refund_amount", "0.00");
}

function rawEconomicDimension(
  context: FinanceBuildContext,
  targetTable: "payments" | "payouts",
  row: IdentitySourceRow,
): string {
  const bookingId = uuid(row.data["booking_id"], "booking_id");
  const booking = context.pmsBookingById.get(bookingId);
  if (!booking) throw new Error(`booking ${bookingId} is missing`);
  const hotelId = uuid(booking.data["hotel_id"], "hotel_id");
  const propertyId = propertyFor(context, "pms", "hotels", hotelId);
  const currency = supportedCurrency(row.data["currency"]);
  if (targetTable === "payments")
    return `${currency}:${rawPaymentProvider(row)}:${paymentStatus(row.data["status"])}:${organizationFor(context, "pms", "pms_hotel", hotelId)}`;
  const recipientType = requiredText(row.data["recipient_type"], "recipient_type").toLowerCase();
  const recipientId = uuid(row.data["recipient_id"], "recipient_id");
  const owner =
    recipientType === "hotel"
      ? propertyId
      : organizationFor(context, "affiliate", "affiliate", recipientId);
  const provider = row.data["stripe_transfer_id"]
    ? "stripe"
    : row.data["xendit_payout_id"]
      ? "xendit"
      : "unbound";
  return `${currency}:${provider}:${payoutStatus(row.data["status"])}:${owner}`;
}

function providerIndex(records: FinanceTargetRecord[]): Map<string, string> {
  return new Map(
    records
      .filter((row) => row.targetTable === "payment_provider_accounts")
      .map((row) => [row.targetId, String(row.row["provider"])] as const),
  );
}

function targetEconomicDimension(
  record: FinanceTargetRecord,
  targetTable: "payments" | "payouts",
  providerByAccount: Map<string, string>,
): string {
  const status = String(record.row[targetTable === "payments" ? "status" : "payoutStatus"]);
  const owner = String(record.row["organizationId"] ?? record.row["propertyId"] ?? "platform");
  const accountId =
    targetTable === "payments"
      ? record.row["providerAccountId"]
      : (record.row["propertyProviderAccountId"] ?? record.row["organizationProviderAccountId"]);
  const provider = accountId ? (providerByAccount.get(String(accountId)) ?? "unknown") : "unbound";
  return `${String(record.row["currency"])}:${provider}:${status}:${owner}`;
}

function economicCounts(
  records: FinanceTargetRecord[],
  targetTable: "payments" | "payouts",
): Record<string, number> {
  const providers = providerIndex(records);
  return countBy(
    records.filter((record) => record.targetTable === targetTable),
    (record) => targetEconomicDimension(record, targetTable, providers),
  );
}

function rawEconomicCounts(
  context: FinanceBuildContext,
  targetTable: "payments" | "payouts",
): Record<string, number> {
  const dimensions: string[] = [];
  for (const row of sourceRows(context, "pms", targetTable)) {
    try {
      dimensions.push(rawEconomicDimension(context, targetTable, row));
    } catch {
      // Exact-count blockers cover invalid rows that cannot be dimensioned.
    }
  }
  return countBy(dimensions, (value) => value);
}

function rawPayoutAllocations(context: FinanceBuildContext): Record<string, string> {
  const sums = new Map<string, bigint>();
  for (const booking of sourceRows(context, "pms", "bookings")) {
    try {
      const bookingId = sourceId(booking);
      const fields = [
        "platform_fee_amount",
        "affiliate_commission_amount",
        "property_payout_amount",
      ];
      if (fields.every((field) => booking.data[field] == null || booking.data[field] === ""))
        continue;
      const hotelId = uuid(booking.data["hotel_id"], "hotel_id");
      const propertyId = propertyFor(context, "pms", "hotels", hotelId);
      addAllocation(
        sums,
        `${bookingId}:property:${propertyId}`,
        exactMoney(booking.data["property_payout_amount"], "property_payout_amount"),
      );
      const affiliateAmount = exactMoney(
        booking.data["affiliate_commission_amount"],
        "affiliate_commission_amount",
      );
      if (minor(affiliateAmount) > 0n) {
        const affiliateId = uuid(booking.data["affiliate_id"], "affiliate_id");
        const organizationId = organizationFor(context, "affiliate", "affiliate", affiliateId);
        addAllocation(sums, `${bookingId}:organization:${organizationId}`, affiliateAmount);
      }
    } catch {
      // Booking allocation validation emits the blocking evidence.
    }
  }
  return formattedSums(sums);
}

function targetPayoutAllocations(
  context: FinanceBuildContext,
  records: FinanceTargetRecord[],
): Record<string, string> {
  const sourceBookingByTarget = new Map(
    context.target.guestBookings.map((booking) => [booking.id, booking.sourceBookingId]),
  );
  const sums = new Map<string, bigint>();
  for (const record of records.filter((row) => row.targetTable === "payouts")) {
    const bookingId = sourceBookingByTarget.get(String(record.row["guestBookingId"]));
    if (!bookingId) continue;
    const scope = String(record.row["ownerScope"]);
    const owner = String(record.row[scope === "property" ? "propertyId" : "organizationId"]);
    addAllocation(sums, `${bookingId}:${scope}:${owner}`, String(record.row["amount"]));
  }
  return formattedSums(sums);
}

function addAllocation(sums: Map<string, bigint>, key: string, amount: string): void {
  if (minor(amount) > 0n) sums.set(key, (sums.get(key) ?? 0n) + minor(amount));
}

function formattedSums(sums: Map<string, bigint>): Record<string, string> {
  return Object.fromEntries(
    [...sums]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, value]) => [key, formatMinor(value)]),
  );
}

function minor(value: string): bigint {
  const match = /^(\d+)\.(\d{2})$/.exec(value);
  if (!match) throw new Error(`Invalid exact monetary value ${value}`);
  return BigInt(match[1]!) * 100n + BigInt(match[2]!);
}

function formatMinor(value: bigint): string {
  return `${value / 100n}.${String(value % 100n).padStart(2, "0")}`;
}

function sameRecord(expected: Record<string, unknown>, actual: Record<string, unknown>): boolean {
  return Object.entries(expected).every(([key, value]) => sameValue(value, actual[key]));
}

function sameValue(expected: unknown, actual: unknown): boolean {
  if (expected === actual) return true;
  if ((expected === null || expected === undefined) && actual === null) return true;
  if (Array.isArray(expected))
    return (
      Array.isArray(actual) &&
      expected.length === actual.length &&
      expected.every((value, index) => sameValue(value, actual[index]))
    );
  if (expected && typeof expected === "object")
    return (
      !!actual &&
      typeof actual === "object" &&
      !Array.isArray(actual) &&
      Object.entries(expected as Record<string, unknown>).every(([key, value]) =>
        sameValue(value, (actual as Record<string, unknown>)[key]),
      )
    );
  if (typeof expected === "string" && typeof actual === "number")
    return Number(expected) === actual;
  if (
    typeof expected === "string" &&
    typeof actual === "string" &&
    /^\d{4}-\d{2}-\d{2}T/.test(expected)
  )
    return Date.parse(expected) === Date.parse(actual);
  return false;
}

function targetKey(row: { targetProduct: string; targetTable: string; targetId: string }): string {
  return `${row.targetProduct}:${row.targetTable}:${row.targetId}`;
}

function provenanceKey(row: {
  sourceDatabase: string;
  sourceTable: string;
  sourceId: string;
  targetProduct: string;
  targetTable: string;
  targetId: string;
}): string {
  return `${row.sourceDatabase}:${row.sourceTable}:${row.sourceId}:${targetKey(row)}`;
}

function providerRef(record: FinanceTargetRecord): string {
  if (record.targetTable !== "payment_provider_accounts" || !record.row["providerAccountId"])
    return `target:${targetKey(record)}`;
  return `${record.row["provider"]}:${record.row["providerAccountId"]}`;
}

function duplicateProviderRefs(records: FinanceTargetRecord[]): Set<string> {
  const values = records
    .filter(
      (row) => row.targetTable === "payment_provider_accounts" && row.row["providerAccountId"],
    )
    .map(providerRef);
  return duplicates(values);
}

function addExternalReferenceBlockers(
  context: FinanceBuildContext,
  records: FinanceTargetRecord[],
): void {
  const paymentIntents = records.filter(
    (record) => record.targetTable === "payments" && record.row["providerPaymentIntentId"],
  );
  for (const reference of duplicates(
    paymentIntents.map((record) => String(record.row["providerPaymentIntentId"])),
  )) {
    const record = paymentIntents.find(
      (candidate) => candidate.row["providerPaymentIntentId"] === reference,
    )!;
    addRecordBlocker(
      context,
      "DUPLICATE_PROVIDER_PAYMENT_INTENT_ID",
      record,
      "Multiple source payments use the same provider PaymentIntent identity",
    );
  }
  for (const field of ["billingSubscriptionRef", "checkoutSessionRef"] as const) {
    const billing = records.filter(
      (record) => record.targetTable === "billing_entitlements" && record.row[field],
    );
    const duplicateRefs = duplicates(billing.map((record) => String(record.row[field])));
    for (const reference of duplicateRefs) {
      const record = billing.find((candidate) => candidate.row[field] === reference)!;
      addRecordBlocker(
        context,
        "DUPLICATE_BILLING_PROVIDER_REFERENCE",
        record,
        `Multiple billing entitlements use ${field} ${reference}`,
      );
    }
  }
  const payouts = records.filter(
    (record) => record.targetTable === "payouts" && record.row["providerPayoutId"],
  );
  const duplicatePayouts = duplicates(
    payouts.map(
      (record) =>
        `${record.row["propertyProviderAccountId"] ?? record.row["organizationProviderAccountId"] ?? "unbound"}:${record.row["providerPayoutId"]}`,
    ),
  );
  for (const reference of duplicatePayouts) {
    const record = payouts.find(
      (candidate) =>
        `${candidate.row["propertyProviderAccountId"] ?? candidate.row["organizationProviderAccountId"] ?? "unbound"}:${candidate.row["providerPayoutId"]}` ===
        reference,
    )!;
    addRecordBlocker(
      context,
      "DUPLICATE_PROVIDER_PAYOUT_ID",
      record,
      "Multiple source payouts use the same provider identity within one account",
    );
  }
}

function duplicates(values: string[]): Set<string> {
  const seen = new Set<string>();
  const result = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) result.add(value);
    seen.add(value);
  }
  return result;
}

function addRecordBlocker(
  context: FinanceBuildContext,
  code: string,
  record: FinanceTargetRecord,
  message: string,
): void {
  block(context, code, `${record.sourceDatabase}.${record.sourceTable}`, record.sourceId, message);
}

function countBy<T>(values: T[], key: (value: T) => string): Record<string, number> {
  const result = new Map<string, number>();
  for (const value of values) {
    const label = key(value);
    result.set(label, (result.get(label) ?? 0) + 1);
  }
  return Object.fromEntries([...result].sort(([left], [right]) => left.localeCompare(right)));
}
