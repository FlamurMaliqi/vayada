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
  const actions = new Map<string, Action>();
  const counts = {
    sourceRows: context.rows.length,
    plannedRecords: 0,
    inserts: 0,
    updates: 0,
    unchanged: 0,
    preservedNewerTarget: 0,
    preservedTargetDeletions: 0,
    dispositions: 0,
    omittedSourceRows: 0,
  };
  for (const candidate of candidates) {
    if (duplicateKeys.has(targetKey(candidate)) || blockedProviderRefs.has(providerRef(candidate)))
      continue;
    const prior = provenance.get(provenanceKey(candidate));
    const action = reconcile(candidate, existing.get(targetKey(candidate)), prior, context);
    if (action === "block") continue;
    actions.set(targetKey(candidate), action);
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
  validateReconciledReferentialClosure(context, writes, actions);
  counts.plannedRecords = records.length;
  const dispositions = [...context.dispositions].sort((left, right) =>
    dispositionKey(left).localeCompare(dispositionKey(right)),
  );
  counts.dispositions = dispositions.length;
  counts.omittedSourceRows = omittedSourceKeys(context).size;
  const parity = {
    sourceTableCounts: countBy(context.rows, (row) => `${row.sourceDatabase}.${row.sourceTable}`),
    targetTableCounts: countBy(records, (row) => `finance.${row.targetTable}`),
    dispositionCountsByReason: countBy(dispositions, (row) => row.reasonCode),
    omittedSourceRowCounts: countBy(
      dispositions.filter((row) => row.disposition === "omitted_row"),
      (row) => `${row.sourceDatabase}.${row.sourceTable}`,
    ),
    sourcePaymentAmountsByCurrencyStatusOwner: rawEconomicSums(
      context,
      "payments",
      "amount",
      "all",
    ),
    omittedPaymentAmountsByCurrencyStatusOwner: rawEconomicSums(
      context,
      "payments",
      "amount",
      "omitted",
    ),
    targetPaymentAmountsByCurrencyStatusOwner: economicSums(records, "payments", "amount"),
    sourcePaymentCountsByCurrencyStatusOwner: rawEconomicCounts(context, "payments", "all"),
    omittedPaymentCountsByCurrencyStatusOwner: rawEconomicCounts(context, "payments", "omitted"),
    targetPaymentCountsByCurrencyStatusOwner: economicCounts(records, "payments"),
    sourcePaymentFeesByCurrencyStatusOwner: rawEconomicSums(
      context,
      "payments",
      "feeAmount",
      "all",
    ),
    omittedPaymentFeesByCurrencyStatusOwner: rawEconomicSums(
      context,
      "payments",
      "feeAmount",
      "omitted",
    ),
    targetPaymentFeesByCurrencyStatusOwner: economicSums(records, "payments", "feeAmount"),
    sourcePaymentNetByCurrencyStatusOwner: rawEconomicSums(context, "payments", "netAmount", "all"),
    omittedPaymentNetByCurrencyStatusOwner: rawEconomicSums(
      context,
      "payments",
      "netAmount",
      "omitted",
    ),
    targetPaymentNetByCurrencyStatusOwner: economicSums(records, "payments", "netAmount"),
    sourcePaymentRefundsByCurrencyStatusOwner: rawEconomicSums(
      context,
      "payments",
      "refundedAmount",
      "all",
    ),
    omittedPaymentRefundsByCurrencyStatusOwner: rawEconomicSums(
      context,
      "payments",
      "refundedAmount",
      "omitted",
    ),
    targetPaymentRefundsByCurrencyStatusOwner: economicSums(records, "payments", "refundedAmount"),
    sourcePayoutAmountsByCurrencyStatusOwner: rawEconomicSums(context, "payouts", "amount", "all"),
    omittedPayoutAmountsByCurrencyStatusOwner: rawEconomicSums(
      context,
      "payouts",
      "amount",
      "omitted",
    ),
    targetPayoutAmountsByCurrencyStatusOwner: economicSums(records, "payouts", "amount"),
    sourcePayoutCountsByCurrencyStatusOwner: rawEconomicCounts(context, "payouts", "all"),
    omittedPayoutCountsByCurrencyStatusOwner: rawEconomicCounts(context, "payouts", "omitted"),
    targetPayoutCountsByCurrencyStatusOwner: economicCounts(records, "payouts"),
    sourcePayoutNetByCurrencyStatusOwner: rawEconomicSums(context, "payouts", "netAmount", "all"),
    omittedPayoutNetByCurrencyStatusOwner: rawEconomicSums(
      context,
      "payouts",
      "netAmount",
      "omitted",
    ),
    targetPayoutNetByCurrencyStatusOwner: economicSums(records, "payouts", "netAmount"),
    sourcePayoutAllocationsByBookingOwner: rawPayoutAllocations(context),
    targetPayoutAllocationsByBookingOwner: targetPayoutAllocations(context, records),
  };
  for (const [source, target, omitted, code, table, message] of [
    [
      parity.sourcePaymentAmountsByCurrencyStatusOwner,
      parity.targetPaymentAmountsByCurrencyStatusOwner,
      parity.omittedPaymentAmountsByCurrencyStatusOwner,
      "FINANCE_PAYMENT_MONETARY_PARITY_MISMATCH",
      "payments",
      "gross amounts",
    ],
    [
      parity.sourcePaymentCountsByCurrencyStatusOwner,
      parity.targetPaymentCountsByCurrencyStatusOwner,
      parity.omittedPaymentCountsByCurrencyStatusOwner,
      "FINANCE_PAYMENT_DIMENSION_COUNT_MISMATCH",
      "payments",
      "counts",
    ],
    [
      parity.sourcePaymentFeesByCurrencyStatusOwner,
      parity.targetPaymentFeesByCurrencyStatusOwner,
      parity.omittedPaymentFeesByCurrencyStatusOwner,
      "FINANCE_PAYMENT_FEE_PARITY_MISMATCH",
      "payments",
      "fees",
    ],
    [
      parity.sourcePaymentNetByCurrencyStatusOwner,
      parity.targetPaymentNetByCurrencyStatusOwner,
      parity.omittedPaymentNetByCurrencyStatusOwner,
      "FINANCE_PAYMENT_NET_PARITY_MISMATCH",
      "payments",
      "net amounts",
    ],
    [
      parity.sourcePaymentRefundsByCurrencyStatusOwner,
      parity.targetPaymentRefundsByCurrencyStatusOwner,
      parity.omittedPaymentRefundsByCurrencyStatusOwner,
      "FINANCE_PAYMENT_REFUND_PARITY_MISMATCH",
      "payments",
      "refunds",
    ],
    [
      parity.sourcePayoutAmountsByCurrencyStatusOwner,
      parity.targetPayoutAmountsByCurrencyStatusOwner,
      parity.omittedPayoutAmountsByCurrencyStatusOwner,
      "FINANCE_PAYOUT_MONETARY_PARITY_MISMATCH",
      "payouts",
      "gross amounts",
    ],
    [
      parity.sourcePayoutCountsByCurrencyStatusOwner,
      parity.targetPayoutCountsByCurrencyStatusOwner,
      parity.omittedPayoutCountsByCurrencyStatusOwner,
      "FINANCE_PAYOUT_DIMENSION_COUNT_MISMATCH",
      "payouts",
      "counts",
    ],
    [
      parity.sourcePayoutNetByCurrencyStatusOwner,
      parity.targetPayoutNetByCurrencyStatusOwner,
      parity.omittedPayoutNetByCurrencyStatusOwner,
      "FINANCE_PAYOUT_NET_PARITY_MISMATCH",
      "payouts",
      "net amounts",
    ],
    [
      parity.sourcePayoutAllocationsByBookingOwner,
      parity.targetPayoutAllocationsByBookingOwner,
      {},
      "FINANCE_PAYOUT_ALLOCATION_PARITY_MISMATCH",
      "payouts",
      "booking-owner allocations",
    ],
  ] as const)
    if (sha256(source) !== sha256(combineDimensions(target, omitted)))
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
    const omittedCount = context.dispositions.filter(
      (row) =>
        row.sourceTable === sourceTable &&
        row.disposition === "omitted_row" &&
        row.sourceField === "*",
    ).length;
    const targetCount = records.filter((row) => row.targetTable === targetTable).length;
    if (sourceCount !== targetCount + omittedCount)
      block(
        context,
        "FINANCE_EXACT_COUNT_PARITY_MISMATCH",
        `finance.${targetTable}`,
        context.sourceRunId,
        `${sourceCount} source ${sourceTable} rows produced ${targetCount} planned target rows and ${omittedCount} explicit row omissions`,
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
      dispositions,
    }),
    records,
    writes,
    provenance: links,
    dispositions,
    blockers,
    parity,
    counts,
  };
}

type Action = "insert" | "update" | "unchanged" | "preserve_newer" | "preserve_deletion" | "block";

function validateReconciledReferentialClosure(
  context: FinanceBuildContext,
  writes: FinanceTargetRecord[],
  actions: Map<string, Action>,
): void {
  const dependencyFields: Record<string, Array<[field: string, parentTable: string]>> = {
    payment_settings: [["providerAccountId", "payment_provider_accounts"]],
    payments: [["providerAccountId", "payment_provider_accounts"]],
    payout_settings: [
      ["propertyProviderAccountId", "payment_provider_accounts"],
      ["organizationProviderAccountId", "payment_provider_accounts"],
    ],
    payouts: [
      ["payoutSettingId", "payout_settings"],
      ["propertyProviderAccountId", "payment_provider_accounts"],
      ["organizationProviderAccountId", "payment_provider_accounts"],
      ["paymentId", "payments"],
    ],
    commission_rate_changes: [["commissionRuleId", "commission_rules"]],
  };
  for (const record of writes)
    for (const [field, parentTable] of dependencyFields[record.targetTable] ?? []) {
      const parentId = record.row[field];
      if (!parentId) continue;
      const parentAction = actions.get(`finance:${parentTable}:${String(parentId)}`);
      if (parentAction && parentAction !== "preserve_deletion" && parentAction !== "block")
        continue;
      block(
        context,
        "FINANCE_REFERENTIAL_CLOSURE_FAILED",
        `finance.${record.targetTable}`,
        `source_${sha256({
          sourceDatabase: record.sourceDatabase,
          sourceTable: record.sourceTable,
          sourceId: record.sourceId,
        }).slice(0, 16)}`,
        `Finance write has an unavailable ${field} dependency after target reconciliation`,
      );
    }
}

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
  selection: "all" | "omitted",
): Record<string, string> {
  const sums = new Map<string, bigint>();
  const omitted = omittedSourceKeys(context);
  for (const row of sourceRows(context, "pms", targetTable)) {
    if (selection === "omitted" && !omitted.has(sourceRowKey(row))) continue;
    let value: string;
    try {
      value = rawEconomicValue(targetTable, field, row);
    } catch {
      blockUnreadableEconomicValue(context, targetTable, row);
      continue;
    }
    let key: string;
    try {
      key = rawEconomicDimension(context, targetTable, row);
    } catch {
      key = invalidEconomicDimension(targetTable, row);
    }
    sums.set(key, (sums.get(key) ?? 0n) + minor(value));
  }
  return formattedSums(sums);
}

function rawPaymentProvider(context: FinanceBuildContext, row: IdentitySourceRow): string {
  const id = sourceId(row);
  if (
    context.dispositions.some(
      (entry) =>
        entry.sourceDatabase === row.sourceDatabase &&
        entry.sourceTable === row.sourceTable &&
        entry.sourceId === id &&
        entry.disposition === "unbound_history" &&
        entry.targetTable === "payments",
    )
  )
    return "unbound";
  if (row.data["stripe_account_id"]) return "stripe";
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
    return `${currency}:${rawPaymentProvider(context, row)}:${paymentStatus(row.data["status"])}:${dimension(
      "owner",
      organizationFor(context, "pms", "pms_hotel", hotelId),
    )}`;
  const recipientType = requiredText(row.data["recipient_type"], "recipient_type").toLowerCase();
  const recipientId = uuid(row.data["recipient_id"], "recipient_id");
  const owner =
    recipientType === "hotel"
      ? propertyId
      : organizationFor(context, "affiliate", "affiliate", recipientId);
  // Legacy payouts do not retain row-level provider-account ownership. Keep
  // their immutable provider transaction reference, but reconcile the binding
  // dimension as intentionally unbound.
  const provider = "unbound";
  return `${currency}:${provider}:${payoutStatus(row.data["status"])}:${dimension("owner", owner)}`;
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
  return `${String(record.row["currency"])}:${provider}:${status}:${dimension("owner", owner)}`;
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
  selection: "all" | "omitted",
): Record<string, number> {
  const dimensions: string[] = [];
  const omitted = omittedSourceKeys(context);
  for (const row of sourceRows(context, "pms", targetTable)) {
    if (selection === "omitted" && !omitted.has(sourceRowKey(row))) continue;
    try {
      dimensions.push(rawEconomicDimension(context, targetTable, row));
    } catch {
      dimensions.push(invalidEconomicDimension(targetTable, row));
    }
  }
  return countBy(dimensions, (value) => value);
}

function invalidEconomicDimension(
  targetTable: "payments" | "payouts",
  row: IdentitySourceRow,
): string {
  return `invalid_${sha256({ targetTable, sourceRow: sourceRowKey(row) }).slice(0, 16)}`;
}

function blockUnreadableEconomicValue(
  context: FinanceBuildContext,
  targetTable: "payments" | "payouts",
  row: IdentitySourceRow,
): void {
  const sourceIdHash = `source_${sha256(sourceRowKey(row)).slice(0, 16)}`;
  if (
    context.blockers.some(
      (entry) =>
        entry.code === "FINANCE_SOURCE_MONETARY_VALUE_UNREADABLE" &&
        entry.source === `pms.${targetTable}` &&
        entry.sourceId === sourceIdHash,
    )
  )
    return;
  block(
    context,
    "FINANCE_SOURCE_MONETARY_VALUE_UNREADABLE",
    `pms.${targetTable}`,
    sourceIdHash,
    "A source economic row cannot be represented in the raw monetary ledger",
  );
}

function rawPayoutAllocations(context: FinanceBuildContext): Record<string, string> {
  const sums = new Map<string, bigint>();
  const invalidAllocations = new Set(
    context.dispositions
      .filter((row) =>
        [
          "INVALID_BOOKING_FINANCE_ALLOCATION",
          "BOOKING_FINANCE_ALLOCATION_EVIDENCE_REQUIRED",
        ].includes(row.reasonCode),
      )
      .map((row) => row.sourceId),
  );
  for (const booking of sourceRows(context, "pms", "bookings")) {
    try {
      const bookingId = sourceId(booking);
      if (invalidAllocations.has(bookingId)) continue;
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
        `${dimension("booking", bookingId)}:property:${dimension("owner", propertyId)}`,
        exactMoney(booking.data["property_payout_amount"], "property_payout_amount"),
      );
      const affiliateAmount = exactMoney(
        booking.data["affiliate_commission_amount"],
        "affiliate_commission_amount",
      );
      if (minor(affiliateAmount) > 0n) {
        const affiliateId = uuid(booking.data["affiliate_id"], "affiliate_id");
        const organizationId = organizationFor(context, "affiliate", "affiliate", affiliateId);
        addAllocation(
          sums,
          `${dimension("booking", bookingId)}:organization:${dimension("owner", organizationId)}`,
          affiliateAmount,
        );
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
  const invalidAllocations = new Set(
    context.dispositions
      .filter((row) =>
        [
          "INVALID_BOOKING_FINANCE_ALLOCATION",
          "BOOKING_FINANCE_ALLOCATION_EVIDENCE_REQUIRED",
        ].includes(row.reasonCode),
      )
      .map((row) => row.sourceId),
  );
  for (const record of records.filter((row) => row.targetTable === "payouts")) {
    const bookingId = sourceBookingByTarget.get(String(record.row["guestBookingId"]));
    if (!bookingId) continue;
    if (invalidAllocations.has(bookingId)) continue;
    const scope = String(record.row["ownerScope"]);
    const owner = String(record.row[scope === "property" ? "propertyId" : "organizationId"]);
    addAllocation(
      sums,
      `${dimension("booking", bookingId)}:${scope}:${dimension("owner", owner)}`,
      String(record.row["amount"]),
    );
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
  const paymentIntents = sourceRows(context, "pms", "payments").filter(
    (row) => providerSourceReference(row, "stripe_payment_intent_id") !== null,
  );
  for (const reference of duplicates(
    paymentIntents.map((row) => providerSourceReference(row, "stripe_payment_intent_id")!),
  )) {
    const row = paymentIntents.find(
      (candidate) => providerSourceReference(candidate, "stripe_payment_intent_id") === reference,
    )!;
    block(
      context,
      "DUPLICATE_PROVIDER_PAYMENT_INTENT_ID",
      "pms.payments",
      sourceId(row),
      "Multiple source payments use the same provider PaymentIntent identity",
    );
  }
  for (const field of [
    "stripe_billing_subscription_id",
    "stripe_billing_checkout_session_id",
  ] as const) {
    const billing = sourceRows(context, "pms", "hotel_payment_settings").filter(
      (row) => providerSourceReference(row, field) !== null,
    );
    const duplicateRefs = duplicates(billing.map((row) => providerSourceReference(row, field)!));
    for (const reference of duplicateRefs) {
      const row = billing.find(
        (candidate) => providerSourceReference(candidate, field) === reference,
      )!;
      block(
        context,
        "DUPLICATE_BILLING_PROVIDER_REFERENCE",
        "pms.hotel_payment_settings",
        sourceId(row),
        `Multiple billing entitlements use the same ${field} reference`,
      );
    }
  }
  const payouts = sourceRows(context, "pms", "payouts").filter(
    (row) =>
      providerSourceReference(row, "stripe_transfer_id") !== null ||
      providerSourceReference(row, "xendit_payout_id") !== null,
  );
  const duplicatePayouts = duplicates(
    payouts.map((row) =>
      String(
        providerSourceReference(row, "stripe_transfer_id") ??
          providerSourceReference(row, "xendit_payout_id"),
      ),
    ),
  );
  for (const reference of duplicatePayouts) {
    const row = payouts.find(
      (candidate) =>
        (providerSourceReference(candidate, "stripe_transfer_id") ??
          providerSourceReference(candidate, "xendit_payout_id")) === reference,
    )!;
    block(
      context,
      "DUPLICATE_PROVIDER_PAYOUT_ID",
      "pms.payouts",
      sourceId(row),
      "Multiple source payouts use the same provider identity within one account",
    );
  }
}

function providerSourceReference(row: IdentitySourceRow, field: string): string | null {
  const value = row.data[field];
  return typeof value === "string" && value.trim() ? value.trim() : null;
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

function dispositionKey(value: {
  sourceDatabase: string;
  sourceTable: string;
  sourceId: string;
  sourceField: string;
  reasonCode: string;
}): string {
  return `${value.sourceDatabase}:${value.sourceTable}:${value.sourceId}:${value.sourceField}:${value.reasonCode}`;
}

function sourceRowKey(row: IdentitySourceRow): string {
  try {
    return `${row.sourceDatabase}:${row.sourceTable}:${sourceId(
      row,
      row.sourceTable === "affiliate_payout_settings"
        ? "user_id"
        : row.sourceTable === "stripe_billing_webhook_events"
          ? "event_id"
          : "id",
    )}`;
  } catch {
    return `${row.sourceDatabase}:${row.sourceTable}:${row.rowOrdinal}`;
  }
}

function omittedSourceKeys(context: FinanceBuildContext): Set<string> {
  return new Set(
    context.dispositions
      .filter((row) => row.disposition === "omitted_row")
      .map((row) => `${row.sourceDatabase}:${row.sourceTable}:${row.sourceId}`),
  );
}

function dimension(label: "booking" | "owner", value: string): string {
  return `${label}_${sha256(value).slice(0, 16)}`;
}

function combineDimensions(
  target: Record<string, string> | Record<string, number>,
  omitted: Record<string, string> | Record<string, number>,
): Record<string, string> | Record<string, number> {
  if (
    Object.values(target).some((value) => typeof value === "string") ||
    Object.values(omitted).some((value) => typeof value === "string")
  ) {
    const sums = new Map<string, bigint>();
    for (const [key, value] of [...Object.entries(target), ...Object.entries(omitted)])
      sums.set(key, (sums.get(key) ?? 0n) + minor(String(value)));
    return formattedSums(sums);
  }
  const counts = new Map<string, number>();
  for (const [key, value] of [...Object.entries(target), ...Object.entries(omitted)])
    counts.set(key, (counts.get(key) ?? 0) + Number(value));
  return Object.fromEntries([...counts].sort(([left], [right]) => left.localeCompare(right)));
}
