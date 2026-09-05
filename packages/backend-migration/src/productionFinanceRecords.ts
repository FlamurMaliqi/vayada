import type { IdentitySourceRow } from "./productionIdentityDisposition.js";
import {
  bool,
  deterministicUuid,
  integer,
  iso,
  optionalIso,
  optionalText,
  requiredText,
  sha256,
  uuid,
} from "./productionBookingValues.js";
import {
  block,
  blockRow,
  disposition,
  organizationFor,
  propertyFor,
  resourceStatusFor,
  sourceId,
  sourceRows,
} from "./productionFinanceContext.js";
import type { FinanceBuildContext, FinanceTargetRecord } from "./productionFinanceTypes.js";
import {
  compareMoney,
  exactMoney,
  exactRate,
  minorUnits,
  normalizeProvider,
  subtractMoney,
  sumMoney,
  supportedCurrency as currency,
} from "./productionFinanceValues.js";

export function buildFinanceRecords(context: FinanceBuildContext): FinanceTargetRecord[] {
  const records: FinanceTargetRecord[] = [];
  quarantineInvalidRelatedRows(context);
  for (const row of sourceRows(context, "pms", "bookings")) validateBookingAllocation(context, row);
  for (const row of sourceRows(context, "pms", "hotel_payment_settings"))
    validatePmsPaymentSettingsCoverage(context, row);
  collect(context, records, "booking", "booking_hotels", propertyPaymentRecords);
  collect(context, records, "pms", "affiliates", affiliateProviderRecords);
  collect(context, records, "pms", "affiliate_payout_settings", affiliatePayoutSettingRecords);
  collect(context, records, "booking", "booking_hotels", bookingHotelFinanceRecords);
  finalizeBookingHotelProjectionQuarantines(context, records);
  collect(context, records, "pms", "payments", paymentRecords);
  collect(context, records, "pms", "payouts", payoutRecords);
  collect(context, records, "booking", "commission_rate_changes", commissionChangeRecords);
  for (const row of sourceRows(context, "pms", "booking_checkout_records"))
    block(
      context,
      "FOLIO_RECIPIENT_EVIDENCE_REQUIRED",
      "pms.booking_checkout_records",
      safeId(row),
      "Checkout completion cannot become a folio without an encrypted recipient snapshot and invoice identity",
    );
  for (const row of sourceRows(context, "pms", "booking_checkout_charges"))
    block(
      context,
      "FOLIO_RECIPIENT_EVIDENCE_REQUIRED",
      "pms.booking_checkout_charges",
      safeId(row),
      "Checkout charge cannot become immutable folio evidence without its encrypted recipient revision",
    );
  for (const row of sourceRows(context, "pms", "stripe_billing_webhook_events"))
    block(
      context,
      "UNOWNED_PROVIDER_EVENT",
      "pms.stripe_billing_webhook_events",
      safeId(row, "event_id"),
      "Legacy billing webhook has no property or subscription owner and cannot be attributed safely",
    );
  validateFinanceReferentialClosure(context, records);
  return records;
}

function collect(
  context: FinanceBuildContext,
  records: FinanceTargetRecord[],
  database: "booking" | "pms",
  table: string,
  transform: (context: FinanceBuildContext, row: IdentitySourceRow) => FinanceTargetRecord[],
): void {
  for (const row of sourceRows(context, database, table)) {
    if (context.quarantinedSourceRows.has(row)) continue;
    const blockerStart = context.blockers.length;
    try {
      const transformed = transform(context, row);
      records.push(...transformed);
      for (const record of transformed) registerPlannedTarget(context, record);
    } catch (error) {
      // Quarantine only this projection when another target projection from the
      // same source row already survived; keep unrelated blockers from earlier rows.
      context.blockers.splice(blockerStart);
      const id = safeId(row, row.sourceTable === "affiliate_payout_settings" ? "user_id" : "id");
      const otherProjectionSurvives = records.some(
        (record) =>
          record.sourceDatabase === row.sourceDatabase &&
          record.sourceTable === row.sourceTable &&
          record.sourceId === id,
      );
      const projectionScoped = database === "booking" && table === "booking_hotels";
      if (projectionScoped || otherProjectionSurvives)
        disposition(context, row, {
          sourceId: id,
          sourceField: `${transform.name || table}_projection`,
          sourceValue: row.data,
          reasonCode: "INVALID_FINANCE_SOURCE_ROW",
          disposition: "omitted_field",
        });
      else blockRow(context, row, error);
    }
  }
}

function finalizeBookingHotelProjectionQuarantines(
  context: FinanceBuildContext,
  records: FinanceTargetRecord[],
): void {
  for (const row of sourceRows(context, "booking", "booking_hotels")) {
    if (context.quarantinedSourceRows.has(row)) continue;
    const id = safeId(row);
    const hasSurvivingProjection = records.some(
      (record) =>
        record.sourceDatabase === "booking" &&
        record.sourceTable === "booking_hotels" &&
        record.sourceId === id,
    );
    if (hasSurvivingProjection) continue;
    const projectionDispositions = context.dispositions.filter(
      (entry) =>
        entry.sourceDatabase === "booking" &&
        entry.sourceTable === "booking_hotels" &&
        entry.sourceId === id &&
        entry.reasonCode === "INVALID_FINANCE_SOURCE_ROW" &&
        entry.disposition === "omitted_field" &&
        entry.sourceField.endsWith("_projection"),
    );
    if (!projectionDispositions.length) continue;
    context.dispositions = context.dispositions.filter(
      (entry) => !projectionDispositions.includes(entry),
    );
    blockRow(context, row, new Error("All Booking hotel Finance projections were invalid"));
  }
}

function quarantineInvalidRelatedRows(context: FinanceBuildContext): void {
  for (const row of sourceRows(context, "booking", "booking_hotels")) {
    try {
      validateBookingHotelFinanceRow(row);
    } catch (error) {
      context.quarantinedSourceRows.add(row);
      blockRow(context, row, error);
    }
  }
  for (const row of sourceRows(context, "pms", "hotel_payment_settings")) {
    try {
      validatePmsPaymentSettingsRow(row);
    } catch (error) {
      context.quarantinedSourceRows.add(row);
      blockRow(context, row, error);
      for (const [propertyId, indexed] of context.pmsSettingsByProperty)
        if (indexed === row) context.pmsSettingsByProperty.delete(propertyId);
    }
  }
  for (const row of sourceRows(context, "pms", "affiliates")) {
    try {
      validateAffiliateProviderRow(row);
    } catch (error) {
      context.quarantinedSourceRows.add(row);
      blockRow(context, row, error);
    }
  }
}

function validateBookingHotelFinanceRow(row: IdentitySourceRow): void {
  sourceId(row);
  currency(row.data["currency"]);
  const plan = requiredText(row.data["billing_active_plan"], "billing_active_plan").toLowerCase();
  if (plan !== "commission" && plan !== "fixed")
    throw new Error(`billing_active_plan ${plan} is unsupported`);
  for (const field of [
    "booking_engine_fee_pct",
    "channel_manager_fee_pct",
    "affiliate_platform_fee_pct",
    "billing_commission_rate",
  ])
    exactRate(row.data[field], field);
  exactMoney(row.data["fixed_base_fee"], "fixed_base_fee");
  integer(row.data["fixed_rooms_included"], "fixed_rooms_included");
  exactMoney(row.data["fixed_per_extra_room_fee"], "fixed_per_extra_room_fee");
  for (const field of [
    "online_card_payment",
    "pay_at_property_enabled",
    "bank_transfer",
    "paypal_enabled",
  ])
    bool(row.data[field], field, false);
  payAtHotelMethods(row.data["pay_at_hotel_methods"]);
  iso(row.data["created_at"], "created_at");
  iso(row.data["updated_at"], "updated_at");
}

function validatePmsPaymentSettingsRow(row: IdentitySourceRow): void {
  sourceId(row);
  uuid(row.data["hotel_id"], "hotel_id");
  normalizeProvider(row.data["payment_provider"]);
  optionalText(row.data["stripe_connect_account_id"], "stripe_connect_account_id");
  optionalText(row.data["stripe_billing_customer_id"], "stripe_billing_customer_id");
  optionalText(row.data["stripe_billing_subscription_id"], "stripe_billing_subscription_id");
  optionalText(
    row.data["stripe_billing_checkout_session_id"],
    "stripe_billing_checkout_session_id",
  );
  optionalText(row.data["stripe_billing_status"], "stripe_billing_status");
  for (const field of [
    "stripe_connect_onboarded",
    "online_card_payment",
    "pay_at_property_enabled",
    "bank_transfer",
    "xendit_payments_enabled",
    "stripe_billing_price_dirty",
  ])
    bool(row.data[field], field, false);
  for (const field of ["stripe_billing_amount_cents", "stripe_billing_room_count"])
    if (row.data[field] != null) integer(row.data[field], field);
  iso(row.data["created_at"], "created_at");
  iso(row.data["updated_at"], "updated_at");
}

function validateAffiliateProviderRow(row: IdentitySourceRow): void {
  sourceId(row);
  if (row.data["user_id"]) uuid(row.data["user_id"], "user_id");
  if (row.data["hotel_id"]) uuid(row.data["hotel_id"], "hotel_id");
  const reference = optionalText(
    row.data["stripe_connect_account_id"],
    "stripe_connect_account_id",
  );
  if (!reference) return;
  bool(row.data["stripe_connect_onboarded"], "stripe_connect_onboarded", false);
  iso(row.data["created_at"], "created_at");
  iso(row.data["updated_at"], "updated_at");
}

function registerPlannedTarget(context: FinanceBuildContext, record: FinanceTargetRecord): void {
  const ids = context.plannedTargetIdsByTable.get(record.targetTable);
  if (ids) ids.add(record.targetId);
  else context.plannedTargetIdsByTable.set(record.targetTable, new Set([record.targetId]));
}

function isPlannedTarget(context: FinanceBuildContext, table: string, id: string): boolean {
  return context.plannedTargetIdsByTable.get(table)?.has(id) ?? false;
}

function validateFinanceReferentialClosure(
  context: FinanceBuildContext,
  records: FinanceTargetRecord[],
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
  for (const record of records)
    for (const [field, parentTable] of dependencyFields[record.targetTable] ?? []) {
      const parentId = record.row[field];
      if (!parentId || isPlannedTarget(context, parentTable, String(parentId))) continue;
      block(
        context,
        "FINANCE_REFERENTIAL_CLOSURE_FAILED",
        `finance.${record.targetTable}`,
        `source_${sha256({
          sourceDatabase: record.sourceDatabase,
          sourceTable: record.sourceTable,
          sourceId: record.sourceId,
        }).slice(0, 16)}`,
        `Planned ${record.targetTable} row has an unresolved ${field} dependency`,
      );
    }
}

function validatePmsPaymentSettingsCoverage(
  context: FinanceBuildContext,
  row: IdentitySourceRow,
): void {
  try {
    const propertyId = propertyFor(context, "pms", "hotels", row.data["hotel_id"]);
    bookingHotelForProperty(context, propertyId);
  } catch (error) {
    blockRow(context, row, error);
  }
}

function propertyPaymentRecords(
  context: FinanceBuildContext,
  bookingHotel: IdentitySourceRow,
): FinanceTargetRecord[] {
  const hotelId = sourceId(bookingHotel);
  const propertyId = propertyFor(context, "booking", "booking_hotels", hotelId);
  const bookingOrganizationId = organizationFor(context, "booking", "booking_hotel", hotelId);
  const pms = context.pmsSettingsByProperty.get(propertyId);
  const pmsHotelId = pms ? uuid(pms.data["hotel_id"], "hotel_id") : null;
  const pmsOrganizationId = pmsHotelId
    ? organizationFor(context, "pms", "pms_hotel", pmsHotelId)
    : null;
  const ownershipAgrees = !pmsOrganizationId || pmsOrganizationId === bookingOrganizationId;
  if (!ownershipAgrees)
    block(
      context,
      "PAYMENT_SETTINGS_OWNER_DISAGREEMENT",
      "pms.hotel_payment_settings",
      sourceId(pms!),
      "Booking owner and PMS operator organizations disagree for the same property payment settings",
    );
  const ownerActive =
    ownershipAgrees &&
    resourceStatusFor(context, "booking", "booking_hotel", hotelId) === "active" &&
    (!pmsHotelId || resourceStatusFor(context, "pms", "pms_hotel", pmsHotelId) === "active");
  const provider = pms ? normalizeProvider(pms.data["payment_provider"]) : null;
  const stripeReference = pms
    ? optionalText(pms.data["stripe_connect_account_id"], "stripe_connect_account_id")
    : null;
  const bookingOnlineCard = bool(
    bookingHotel.data["online_card_payment"],
    "online_card_payment",
    false,
  );
  const onlineCard = pms
    ? agreedPaymentFlag(context, pms, bookingHotel, "online_card_payment")
    : false;
  const payAtProperty = pms
    ? agreedPaymentFlag(context, pms, bookingHotel, "pay_at_property_enabled")
    : bool(bookingHotel.data["pay_at_property_enabled"], "pay_at_property_enabled", false);
  const bankTransfer = pms
    ? agreedPaymentFlag(context, pms, bookingHotel, "bank_transfer")
    : bool(bookingHotel.data["bank_transfer"], "bank_transfer", false);
  const paypal = bool(bookingHotel.data["paypal_enabled"], "paypal_enabled", false);
  const payAtMethods = payAtHotelMethods(bookingHotel.data["pay_at_hotel_methods"]);
  const stripeProviderId = stripeReference
    ? propertyProviderAccountId(propertyId, "stripe", stripeReference)
    : null;
  const vayadaProviderId =
    provider === "vayada" ? propertyProviderAccountId(propertyId, "vayada", "vayada") : null;
  const configuredProviderId =
    provider === "stripe" ? stripeProviderId : provider === "vayada" ? vayadaProviderId : null;
  if (bookingOnlineCard && !pms)
    block(
      context,
      "ONLINE_CARD_PROVIDER_EVIDENCE_REQUIRED",
      "booking.booking_hotels",
      hotelId,
      "Booking enables online card payments but no PMS provider settings row exists",
    );
  if (onlineCard && !configuredProviderId)
    disposition(context, pms!, {
      sourceField: "payment_provider",
      sourceValue: {
        paymentProvider: pms!.data["payment_provider"] ?? null,
        onlineCardPayment: pms!.data["online_card_payment"] ?? null,
      },
      reasonCode: "MISSING_PROVIDER_ACCOUNT_ID",
      disposition: "disabled_configuration",
      targetTable: "payment_settings",
      targetId: propertyId,
    });
  if (
    pms &&
    provider === "xendit" &&
    bool(pms.data["xendit_payments_enabled"], "xendit_payments_enabled", false)
  )
    disposition(context, pms, {
      sourceField: "xendit_payments_enabled",
      sourceValue: pms.data["xendit_payments_enabled"],
      reasonCode: "MISSING_PROVIDER_ACCOUNT_ID",
      disposition: "disabled_configuration",
      targetTable: "payment_settings",
      targetId: propertyId,
    });
  const createdAt = iso(bookingHotel.data["created_at"], "created_at");
  const updatedAt = iso(bookingHotel.data["updated_at"], "updated_at");
  const providerCreatedAt = pms ? iso(pms.data["created_at"], "created_at") : createdAt;
  const providerUpdatedAt = pms ? iso(pms.data["updated_at"], "updated_at") : updatedAt;
  if (payAtProperty && payAtMethods.length === 0)
    block(
      context,
      "PAY_AT_PROPERTY_METHODS_REQUIRED",
      "booking.booking_hotels",
      hotelId,
      "Pay at property is enabled without a usable cash or manual-card method",
    );
  if (bankTransfer)
    disposition(context, bookingHotel, {
      sourceField: "bank_transfer",
      sourceValue: bookingHotel.data["bank_transfer"],
      reasonCode: "BANK_TRANSFER_DESTINATION_REENTRY_REQUIRED",
      disposition: "target_reentry_required",
      targetTable: "payment_settings",
      targetId: propertyId,
    });
  if (paypal)
    disposition(context, bookingHotel, {
      sourceField: "paypal_email",
      sourceValue: bookingHotel.data["paypal_email"] ?? null,
      reasonCode: "PAYPAL_DESTINATION_REENTRY_REQUIRED",
      disposition: "target_reentry_required",
      targetTable: "payment_settings",
      targetId: propertyId,
    });
  const safeOnlineCard = onlineCard && configuredProviderId !== null;
  const acceptedMethods = [
    ...(safeOnlineCard ? ["card"] : []),
    ...(payAtProperty ? ["pay_at_property", ...payAtMethods] : []),
  ];
  const result: FinanceTargetRecord[] = [];
  if (stripeProviderId) {
    const onboarded = bool(
      pms!.data["stripe_connect_onboarded"],
      "stripe_connect_onboarded",
      false,
    );
    result.push(
      record(pms!, "payment_provider_accounts", stripeProviderId, {
        id: stripeProviderId,
        propertyId,
        organizationId: null,
        accountScope: "property",
        provider: "stripe",
        providerAccountId: stripeReference,
        status: !ownerActive ? "disabled" : onboarded ? "active" : "setup_incomplete",
        onboardingStatus: onboarded ? "completed" : "not_started",
        chargesEnabled: ownerActive && onboarded && safeOnlineCard && provider === "stripe",
        payoutsEnabled: ownerActive && onboarded,
        defaultCurrency: currency(bookingHotel.data["currency"]),
        capabilities: onboarded ? ["card_payments", "transfers"] : [],
        accountMetadata: {
          legacySource: "pms.hotel_payment_settings",
          configuredProvider: provider,
        },
        sensitiveConfigRef: null,
        createdAt: providerCreatedAt,
        updatedAt: providerUpdatedAt,
      }),
    );
  }
  if (vayadaProviderId)
    result.push(
      record(pms!, "payment_provider_accounts", vayadaProviderId, {
        id: vayadaProviderId,
        propertyId,
        organizationId: null,
        accountScope: "property",
        provider: "vayada",
        providerAccountId: null,
        status: ownerActive ? "active" : "disabled",
        onboardingStatus: "completed",
        chargesEnabled: ownerActive && safeOnlineCard,
        payoutsEnabled: ownerActive,
        defaultCurrency: currency(bookingHotel.data["currency"]),
        capabilities: onlineCard ? ["card_payments"] : [],
        accountMetadata: {
          legacySource: "pms.hotel_payment_settings",
          configuredProvider: provider,
        },
        sensitiveConfigRef: null,
        createdAt: providerCreatedAt,
        updatedAt: providerUpdatedAt,
      }),
    );
  result.push(
    record(
      bookingHotel,
      "payment_settings",
      propertyId,
      {
        propertyId,
        providerAccountId: configuredProviderId,
        paymentsEnabled: ownerActive && acceptedMethods.length > 0,
        acceptedMethods,
        defaultCurrency: currency(bookingHotel.data["currency"]),
        depositPolicy: {},
        refundPolicy: {},
        taxPolicy: {},
        statementDescriptor: null,
        requiresManualReview: bookingOnlineCard || bankTransfer || paypal,
        sourceSystem: "booking",
        sourceSettingsId: hotelId,
        createdAt,
        updatedAt,
      },
      {
        sourceChecksum: sha256({ booking: bookingHotel.data, pms: pms?.data ?? null }),
        sourceUpdatedAt: latest(updatedAt, providerUpdatedAt),
      },
    ),
  );
  return result;
}

function affiliateProviderRecords(
  context: FinanceBuildContext,
  row: IdentitySourceRow,
): FinanceTargetRecord[] {
  const affiliateId = sourceId(row);
  const reference = optionalText(
    row.data["stripe_connect_account_id"],
    "stripe_connect_account_id",
  );
  if (!reference) return [];
  const organizationId = organizationFor(context, "affiliate", "affiliate", affiliateId);
  const ownerActive =
    resourceStatusFor(context, "affiliate", "affiliate", affiliateId) === "active";
  const providerId = affiliateProviderId(organizationId, reference);
  const onboarded = bool(row.data["stripe_connect_onboarded"], "stripe_connect_onboarded", false);
  return [
    record(row, "payment_provider_accounts", providerId, {
      id: providerId,
      propertyId: null,
      organizationId,
      accountScope: "organization",
      provider: "stripe",
      providerAccountId: reference,
      status: !ownerActive ? "disabled" : onboarded ? "active" : "setup_incomplete",
      onboardingStatus: onboarded ? "completed" : "not_started",
      chargesEnabled: false,
      payoutsEnabled: ownerActive && onboarded,
      defaultCurrency: null,
      capabilities: onboarded ? ["transfers"] : [],
      accountMetadata: { legacySource: "pms.affiliates", affiliateId },
      sensitiveConfigRef: null,
      createdAt: iso(row.data["created_at"], "created_at"),
      updatedAt: iso(row.data["updated_at"], "updated_at"),
    }),
  ];
}

function affiliatePayoutSettingRecords(
  context: FinanceBuildContext,
  row: IdentitySourceRow,
): FinanceTargetRecord[] {
  const userId = uuid(row.data["user_id"], "user_id");
  const affiliates = context.pmsAffiliatesByUserId.get(userId) ?? [];
  if (affiliates.length !== 1)
    throw new Error(`user_id resolves to ${affiliates.length} affiliates; exactly one is required`);
  const affiliate = affiliates[0]!;
  const affiliateId = sourceId(affiliate);
  const organizationId = organizationFor(context, "affiliate", "affiliate", affiliateId);
  const ownerActive =
    resourceStatusFor(context, "affiliate", "affiliate", affiliateId) === "active";
  const method = payoutMethod(row.data["payment_method"]);
  const providerReference = optionalText(
    affiliate.data["stripe_connect_account_id"],
    "stripe_connect_account_id",
  );
  const candidateProviderAccountId =
    method === "stripe" && providerReference
      ? affiliateProviderId(organizationId, providerReference)
      : null;
  const providerAccountId =
    candidateProviderAccountId &&
    isPlannedTarget(context, "payment_provider_accounts", candidateProviderAccountId)
      ? candidateProviderAccountId
      : null;
  const affiliateHotelId = uuid(affiliate.data["hotel_id"], "hotel_id");
  const affiliatePropertyId = propertyFor(context, "pms", "hotels", affiliateHotelId);
  const affiliateCurrency = bookingHotelForProperty(context, affiliatePropertyId).currency;
  const sensitive = sensitivePayoutFields(row);
  if (sensitive.length)
    disposition(context, row, {
      sourceId: userId,
      sourceField: "payout_destination",
      sourceValue: sensitive,
      reasonCode: "SENSITIVE_PAYOUT_DESTINATION_REENTRY_REQUIRED",
      disposition: "target_reentry_required",
      targetTable: "payout_settings",
      targetId: deterministicUuid("production-finance", "affiliate-payout-setting", userId),
    });
  const id = deterministicUuid("production-finance", "affiliate-payout-setting", userId);
  if (candidateProviderAccountId && !providerAccountId)
    disposition(context, row, {
      sourceId: userId,
      sourceField: "organization_provider_account_dependency",
      sourceValue: providerReference,
      reasonCode: "FINANCE_PARENT_RECORD_QUARANTINED",
      disposition: "disabled_configuration",
      targetTable: "payout_settings",
      targetId: id,
    });
  return [
    record(row, "payout_settings", id, {
      id,
      propertyId: null,
      organizationId,
      propertyProviderAccountId: null,
      organizationProviderAccountId: providerAccountId,
      ownerScope: "organization",
      payoutMethod: method,
      destinationCountryCode: country(row.data["bank_country"]),
      defaultCurrency: affiliateCurrency,
      status: !ownerActive
        ? "disabled"
        : sensitive.length
          ? "setup_incomplete"
          : providerAccountId
            ? "active"
            : "setup_incomplete",
      schedule: {},
      payoutPreferences: {
        legacyDestinationFingerprint: sensitive.length ? sha256(sensitive) : null,
        destinationRequiresReentry: sensitive.length > 0,
      },
      sensitiveDestinationRef: null,
      sourceSystem: "pms",
      sourceSettingsId: userId,
      createdAt: iso(row.data["created_at"], "created_at"),
      updatedAt: iso(row.data["updated_at"], "updated_at"),
    }),
  ];
}

function paymentRecords(
  context: FinanceBuildContext,
  row: IdentitySourceRow,
): FinanceTargetRecord[] {
  const id = sourceId(row);
  const bookingId = uuid(row.data["booking_id"], "booking_id");
  const legacyBooking = context.pmsBookingById.get(bookingId);
  if (!legacyBooking) throw new Error(`booking ${bookingId} is missing from the immutable source`);
  const guestBooking = context.guestBookingByPmsId.get(bookingId);
  if (!guestBooking) throw new Error(`booking ${bookingId} has no migrated guest booking`);
  const hotelId = uuid(legacyBooking.data["hotel_id"], "hotel_id");
  const propertyId = propertyFor(context, "pms", "hotels", hotelId);
  if (guestBooking.propertyId !== propertyId)
    throw new Error(`booking ${bookingId} property ownership disagrees`);
  const organizationId = organizationFor(context, "pms", "pms_hotel", hotelId);
  const amount = exactMoney(row.data["amount"], "amount");
  const feeAmount = exactMoney(
    row.data["stripe_application_fee_amount"],
    "stripe_application_fee_amount",
    "0.00",
  );
  const platformFeeAmount = exactMoney(
    row.data["stripe_platform_fee_amount"],
    "stripe_platform_fee_amount",
    "0.00",
  );
  const affiliateCommissionAmount = exactMoney(
    row.data["stripe_affiliate_commission_amount"],
    "stripe_affiliate_commission_amount",
    "0.00",
  );
  if (sumMoney([platformFeeAmount, affiliateCommissionAmount]) !== feeAmount)
    block(
      context,
      "INVALID_PAYMENT_FEE_ALLOCATION",
      "pms.payments",
      id,
      "Stripe platform and affiliate fee components do not equal the application fee",
    );
  const refundedAmount = exactMoney(row.data["refund_amount"], "refund_amount", "0.00");
  if (compareMoney(refundedAmount, amount) > 0)
    throw new Error("refund_amount exceeds payment amount");
  const method = paymentMethod(row.data["payment_method"]);
  const settings = context.pmsSettingsByProperty.get(propertyId);
  const paymentCurrency = currency(row.data["currency"]);
  if (guestBooking.currency !== paymentCurrency)
    throw new Error(
      `payment currency ${paymentCurrency} disagrees with booking currency ${guestBooking.currency}`,
    );
  const status = paymentStatus(row.data["status"]);
  const createdAt = iso(row.data["created_at"], "created_at");
  const updatedAt = iso(row.data["updated_at"], "updated_at");
  const capturedAt = optionalIso(row.data["captured_at"], "captured_at");
  const refundedAt = optionalIso(row.data["refunded_at"], "refunded_at");
  const refundCompletedAt = optionalIso(
    row.data["stripe_refund_completed_at"],
    "stripe_refund_completed_at",
  );
  const refundStatus = optionalText(
    row.data["stripe_refund_status"],
    "stripe_refund_status",
  )?.toLowerCase();
  const refundTargetStatus = optionalText(
    row.data["stripe_refund_target_status"],
    "stripe_refund_target_status",
  )?.toLowerCase();
  if (["paid", "partially_refunded", "refunded"].includes(status) && !capturedAt) {
    disposition(context, row, {
      sourceField: "*",
      sourceValue: row.data,
      reasonCode: "PAYMENT_CAPTURE_EVIDENCE_REQUIRED",
      disposition: "omitted_row",
    });
    return [];
  }
  if (
    (status === "refunded" && compareMoney(refundedAmount, amount) !== 0) ||
    (status === "partially_refunded" &&
      (compareMoney(refundedAmount, "0.00") <= 0 || compareMoney(refundedAmount, amount) >= 0)) ||
    (!["refunded", "partially_refunded"].includes(status) &&
      compareMoney(refundedAmount, "0.00") > 0)
  )
    block(
      context,
      "PAYMENT_REFUND_STATE_INCONSISTENT",
      "pms.payments",
      id,
      "Payment status and refunded amount do not form a valid full, partial, or zero refund",
    );
  if (["refunded", "partially_refunded"].includes(status) && !refundedAt && !refundCompletedAt)
    block(
      context,
      "PAYMENT_REFUND_COMPLETION_EVIDENCE_REQUIRED",
      "pms.payments",
      id,
      "Refunded payment has no refunded_at or completed Stripe workflow timestamp",
    );
  if (
    refundStatus &&
    !["creating", "pending", "requires_action", "succeeded", "failed", "canceled"].includes(
      refundStatus,
    )
  )
    block(
      context,
      "INVALID_STRIPE_REFUND_WORKFLOW_STATUS",
      "pms.payments",
      id,
      `Stripe refund workflow status ${refundStatus} is unsupported`,
    );
  if (["creating", "pending", "requires_action"].includes(refundStatus ?? ""))
    block(
      context,
      "ACTIVE_STRIPE_REFUND_WORKFLOW",
      "pms.payments",
      id,
      "Stripe refund workflow is still active and cannot be migrated as final economic state",
    );
  if (
    refundStatus === "succeeded" &&
    (!refundTargetStatus ||
      !["refunded", "partially_refunded"].includes(refundTargetStatus) ||
      refundTargetStatus !== status)
  )
    block(
      context,
      "STRIPE_REFUND_TARGET_STATUS_MISMATCH",
      "pms.payments",
      id,
      "Succeeded Stripe refund target status does not equal the canonical payment status",
    );
  if (
    ["failed", "canceled"].includes(refundStatus ?? "") &&
    ["refunded", "partially_refunded"].includes(status)
  )
    block(
      context,
      "FINAL_REFUND_WITH_FAILED_WORKFLOW",
      "pms.payments",
      id,
      "Final refunded payment is backed only by a failed or canceled Stripe workflow",
    );
  const refundAmountMinor = optionalBigint(row.data["stripe_refund_amount_minor"]);
  if (refundAmountMinor !== null && BigInt(refundAmountMinor) !== minorUnits(refundedAmount))
    block(
      context,
      "PAYMENT_REFUND_AMOUNT_EVIDENCE_MISMATCH",
      "pms.payments",
      id,
      "Stripe refund minor units disagree with refund_amount",
    );
  const refundCurrency = row.data["stripe_refund_currency"]
    ? currency(row.data["stripe_refund_currency"], "stripe_refund_currency")
    : null;
  if (refundCurrency && refundCurrency !== paymentCurrency)
    block(
      context,
      "PAYMENT_REFUND_CURRENCY_MISMATCH",
      "pms.payments",
      id,
      "Stripe refund currency disagrees with the payment currency",
    );
  if (
    refundStatus === "succeeded" &&
    (!refundCompletedAt ||
      !row.data["stripe_refund_payouts_cancelled_at"] ||
      !row.data["stripe_refund_channex_cancelled_at"] ||
      !row.data["stripe_refund_ari_handoff_completed_at"])
  )
    block(
      context,
      "INCOMPLETE_STRIPE_REFUND_WORKFLOW_EVIDENCE",
      "pms.payments",
      id,
      "Succeeded Stripe refund lacks completion or downstream handoff timestamps",
    );
  const stripeReference = optionalText(row.data["stripe_account_id"], "stripe_account_id");
  const stripeIntent = optionalText(
    row.data["stripe_payment_intent_id"],
    "stripe_payment_intent_id",
  );
  const xenditInvoice = optionalText(row.data["xendit_invoice_id"], "xendit_invoice_id");
  if (xenditInvoice && (stripeReference || stripeIntent))
    throw new Error("payment has both Stripe and Xendit provider identities");
  if (stripeIntent || xenditInvoice)
    disposition(context, row, {
      sourceField: "provider_transaction_reference",
      sourceValue: { stripePaymentIntentId: stripeIntent, xenditInvoiceId: xenditInvoice },
      reasonCode: "LEGACY_PAYMENT_PROVIDER_REFERENCE_QUARANTINED",
      disposition: "omitted_field",
      targetTable: "payments",
      targetId: id,
    });
  if (
    (stripeIntent && !stripeReference) ||
    xenditInvoice ||
    (method === "card" && !stripeReference)
  )
    disposition(context, row, {
      sourceField: "provider_account_id",
      sourceValue: {
        stripeAccountId: row.data["stripe_account_id"] ?? null,
        stripePaymentIntentId: row.data["stripe_payment_intent_id"] ?? null,
        xenditInvoiceId: row.data["xendit_invoice_id"] ?? null,
      },
      reasonCode: "MISSING_PAYMENT_PROVIDER_ACCOUNT_ID",
      disposition: "unbound_history",
      targetTable: "payments",
      targetId: id,
    });
  const sharedStripeReference = stripeReference
    ? stripeReferenceIsSharedAcrossProperties(context, stripeReference)
    : false;
  if (sharedStripeReference)
    block(
      context,
      "SHARED_PAYMENT_PROVIDER_ACCOUNT_REFERENCE",
      "pms.payments",
      id,
      "Stripe account reference appears on payments owned by multiple properties and cannot be mapped to a property-scoped provider account",
    );
  const candidateProviderAccountId =
    stripeReference && !sharedStripeReference
      ? propertyProviderAccountId(propertyId, "stripe", stripeReference)
      : null;
  const configuredStripeReference = settings
    ? optionalText(settings.data["stripe_connect_account_id"], "stripe_connect_account_id")
    : null;
  const historicalAccount =
    stripeReference &&
    candidateProviderAccountId &&
    stripeReference !== configuredStripeReference &&
    firstPaymentForStripeAccount(context, stripeReference) === id
      ? record(row, "payment_provider_accounts", candidateProviderAccountId, {
          id: candidateProviderAccountId,
          propertyId,
          organizationId: null,
          accountScope: "property",
          provider: "stripe",
          providerAccountId: stripeReference,
          status: "disabled",
          onboardingStatus: "completed",
          chargesEnabled: false,
          payoutsEnabled: false,
          defaultCurrency: paymentCurrency,
          capabilities: [],
          accountMetadata: {
            legacySource: "pms.payments",
            historicalBinding: true,
          },
          sensitiveConfigRef: null,
          createdAt,
          updatedAt,
        })
      : null;
  const providerAccountId =
    candidateProviderAccountId &&
    (historicalAccount ||
      isPlannedTarget(context, "payment_provider_accounts", candidateProviderAccountId))
      ? candidateProviderAccountId
      : null;
  if (candidateProviderAccountId && !providerAccountId)
    disposition(context, row, {
      sourceField: "provider_account_dependency",
      sourceValue: stripeReference,
      reasonCode: "FINANCE_PARENT_RECORD_QUARANTINED",
      disposition: "unbound_history",
      targetTable: "payments",
      targetId: id,
    });
  return [
    ...(historicalAccount ? [historicalAccount] : []),
    record(row, "payments", id, {
      id,
      propertyId,
      organizationId,
      guestBookingId: guestBooking.id,
      providerAccountId,
      sourceSystem: "pms",
      sourcePaymentId: id,
      idempotencyKey: null,
      paymentKind: paymentKind(row.data["payment_purpose"]),
      paymentMethod: method,
      status,
      amount,
      feeAmount,
      netAmount: subtractMoney(amount, feeAmount, "stripe_application_fee_amount"),
      refundedAmount,
      currency: paymentCurrency,
      providerTransactionId: null,
      providerPaymentIntentId: null,
      processorFeeBreakdown:
        feeAmount === "0.00" && platformFeeAmount === "0.00" && affiliateCommissionAmount === "0.00"
          ? {}
          : {
              stripeApplicationFeeAmount: feeAmount,
              stripePlatformFeeAmount: platformFeeAmount,
              stripeAffiliateCommissionAmount: affiliateCommissionAmount,
            },
      riskReview: {},
      paymentMetadata: {
        ...paymentMetadata(row, {
          refundedAt,
          refundCompletedAt,
          refundAmountMinor,
          refundCurrency,
        }),
        migrationDisposition: providerAccountId ? "historical_bound" : "historical_unbound",
        legacyProviderReferenceSha256:
          stripeIntent || xenditInvoice
            ? sha256({ stripePaymentIntentId: stripeIntent, xenditInvoiceId: xenditInvoice })
            : null,
      },
      visibilityClass: "pms_finance",
      authorizedAt: status === "authorized" ? updatedAt : null,
      paidAt: ["paid", "partially_refunded", "refunded"].includes(status) ? capturedAt : null,
      failedAt: status === "failed" ? updatedAt : null,
      disputedAt: null,
      piiRetentionUntil: null,
      createdAt,
      updatedAt,
    }),
  ];
}

function payoutRecords(
  context: FinanceBuildContext,
  row: IdentitySourceRow,
): FinanceTargetRecord[] {
  const id = sourceId(row);
  const bookingId = uuid(row.data["booking_id"], "booking_id");
  const legacyBooking = context.pmsBookingById.get(bookingId);
  const guestBooking = context.guestBookingByPmsId.get(bookingId);
  if (!legacyBooking || !guestBooking)
    throw new Error(`booking ${bookingId} is not fully migrated`);
  const hotelId = uuid(legacyBooking.data["hotel_id"], "hotel_id");
  const relatedPropertyId = propertyFor(context, "pms", "hotels", hotelId);
  if (guestBooking.propertyId !== relatedPropertyId)
    throw new Error(`booking ${bookingId} property ownership disagrees`);
  const recipientType = requiredText(row.data["recipient_type"], "recipient_type").toLowerCase();
  const recipientId = uuid(row.data["recipient_id"], "recipient_id");
  let ownerScope: "property" | "organization";
  let propertyId: string | null = null;
  let organizationId: string | null = null;
  let payoutSettingId: string | null = null;
  let payoutSettingExpected = false;
  let propertyProviderAccountId: string | null = null;
  let organizationProviderAccountId: string | null = null;
  if (recipientType === "hotel") {
    if (recipientId !== hotelId)
      throw new Error("hotel payout recipient disagrees with booking hotel");
    ownerScope = "property";
    propertyId = relatedPropertyId;
    organizationId = null;
    const candidatePayoutSettingId = bookingPayoutSettingId(propertyId);
    payoutSettingExpected = hasPropertyPayoutSetting(context, propertyId);
    payoutSettingId = isPlannedTarget(context, "payout_settings", candidatePayoutSettingId)
      ? candidatePayoutSettingId
      : null;
  } else if (recipientType === "affiliate") {
    ownerScope = "organization";
    organizationId = organizationFor(context, "affiliate", "affiliate", recipientId);
    const affiliate = context.pmsAffiliateById.get(recipientId);
    if (!affiliate) throw new Error(`affiliate ${recipientId} is missing`);
    const userId = affiliate.data["user_id"] ? uuid(affiliate.data["user_id"], "user_id") : null;
    const candidatePayoutSettingId = userId
      ? deterministicUuid("production-finance", "affiliate-payout-setting", userId)
      : null;
    payoutSettingExpected = Boolean(
      userId &&
      sourceRows(context, "pms", "affiliate_payout_settings").some(
        (settings) => settings.data["user_id"] === userId,
      ),
    );
    payoutSettingId =
      candidatePayoutSettingId &&
      isPlannedTarget(context, "payout_settings", candidatePayoutSettingId)
        ? candidatePayoutSettingId
        : null;
  } else throw new Error(`recipient_type ${recipientType} is unsupported`);
  const providerIds = [
    optionalText(row.data["stripe_transfer_id"], "stripe_transfer_id"),
    optionalText(row.data["xendit_payout_id"], "xendit_payout_id"),
  ].filter(Boolean);
  if (providerIds.length > 1) throw new Error("payout has multiple provider payout identities");
  if (providerIds.length === 1)
    disposition(context, row, {
      sourceField: "provider_account_id",
      sourceValue: providerIds[0],
      reasonCode: "MISSING_PAYOUT_PROVIDER_ACCOUNT_ID",
      disposition: "unbound_history",
      targetTable: "payouts",
      targetId: id,
    });
  if (payoutSettingExpected && !payoutSettingId)
    disposition(context, row, {
      sourceField: "payout_setting_dependency",
      sourceValue: { recipientType, recipientId },
      reasonCode: "FINANCE_PARENT_RECORD_QUARANTINED",
      disposition: "unbound_history",
      targetTable: "payouts",
      targetId: id,
    });
  const relatedPayments = sourceRows(context, "pms", "payments").filter(
    (payment) => payment.data["booking_id"] === bookingId,
  );
  if (relatedPayments.length > 0)
    disposition(context, row, {
      sourceField: "payment_id",
      sourceValue: null,
      reasonCode: "PAYOUT_PAYMENT_ALLOCATION_EVIDENCE_REQUIRED",
      disposition: "omitted_field",
      targetTable: "payouts",
      targetId: id,
    });
  const amount = exactMoney(row.data["amount"], "amount");
  const payoutCurrency = currency(row.data["currency"]);
  if (guestBooking.currency !== payoutCurrency)
    throw new Error(
      `payout currency ${payoutCurrency} disagrees with booking currency ${guestBooking.currency}`,
    );
  const status = payoutStatus(row.data["status"]);
  if (recipientType === "affiliate" && status === "paid")
    block(
      context,
      "AFFILIATE_PAYOUT_EVIDENCE_REQUIRED",
      "pms.payouts",
      id,
      "Completed affiliate payout has no immutable command, idempotency, actor, and item evidence",
    );
  const completedAt = optionalIso(row.data["completed_at"], "completed_at");
  if (status === "paid" && !completedAt)
    block(
      context,
      "PAYOUT_COMPLETION_EVIDENCE_REQUIRED",
      "pms.payouts",
      id,
      "Completed payout has no completed_at timestamp and cannot use a mutable update timestamp",
    );
  const updatedAt = iso(row.data["updated_at"], "updated_at");
  const retryCount = integer(row.data["retry_count"], "retry_count", 0);
  if (retryCount < 0) throw new Error("retry_count must be non-negative");
  return [
    record(row, "payouts", id, {
      id,
      payoutSettingId,
      paymentId: null,
      guestBookingId: guestBooking.id,
      propertyProviderAccountId,
      organizationProviderAccountId,
      ownerScope,
      propertyId,
      organizationId,
      relatedPropertyId,
      sourceSystem: "pms",
      sourcePayoutId: id,
      payoutStatus: status,
      amount,
      feeAmount: "0.00",
      netAmount: amount,
      currency: payoutCurrency,
      periodStart: null,
      periodEnd: null,
      providerPayoutId: null,
      scheduledAt: iso(row.data["scheduled_for"], "scheduled_for"),
      paidAt: status === "paid" ? completedAt : null,
      failedAt: status === "failed" ? updatedAt : null,
      failureCode: status === "failed" ? optionalText(row.data["last_error"], "last_error") : null,
      retryCount,
      payoutMetadata: {
        paymentMethod: optionalText(row.data["payment_method"], "payment_method"),
        externalReference: optionalText(row.data["external_reference"], "external_reference"),
        notes: optionalText(row.data["notes"], "notes"),
        paidByUserId: row.data["paid_by_user_id"] ?? null,
        migrationDisposition: "historical_unbound",
        providerBindingRequiresReview: providerIds.length > 0,
        paymentAllocationRequiresReview: relatedPayments.length > 0,
        legacyProviderPayoutReferenceSha256: providerIds[0] ? sha256(providerIds[0]) : null,
      },
      createdAt: iso(row.data["created_at"], "created_at"),
      updatedAt,
    }),
  ];
}

function validateBookingAllocation(context: FinanceBuildContext, row: IdentitySourceRow): void {
  const fields = ["platform_fee_amount", "affiliate_commission_amount", "property_payout_amount"];
  const present = fields.filter(
    (field) => row.data[field] !== null && row.data[field] !== undefined && row.data[field] !== "",
  );
  const id = safeId(row);
  if (present.length === 0) {
    disposition(context, row, {
      sourceId: id,
      sourceField: "finance_allocation",
      sourceValue: null,
      reasonCode: "BOOKING_FINANCE_ALLOCATION_EVIDENCE_REQUIRED",
      disposition: "omitted_field",
    });
    return;
  }
  try {
    if (present.length !== fields.length)
      throw new Error("allocation is partial; all three components are required");
    const total = exactMoney(row.data["total_amount"], "total_amount");
    const amounts = fields.map((field) => exactMoney(row.data[field], field));
    const allocation = sumMoney(amounts);
    if (allocation !== total)
      throw new Error(`allocation ${allocation} does not equal booking total ${total}`);
    if (compareMoney(amounts[1]!, "0.00") > 0 && !row.data["affiliate_id"])
      throw new Error("affiliate commission allocation has no affiliate_id");
  } catch (error) {
    disposition(context, row, {
      sourceId: id,
      sourceField: "finance_allocation",
      sourceValue: Object.fromEntries(fields.map((field) => [field, row.data[field] ?? null])),
      reasonCode: "INVALID_BOOKING_FINANCE_ALLOCATION",
      disposition: "omitted_field",
    });
  }
}

function bookingHotelFinanceRecords(
  context: FinanceBuildContext,
  row: IdentitySourceRow,
): FinanceTargetRecord[] {
  const hotelId = sourceId(row);
  const propertyId = propertyFor(context, "booking", "booking_hotels", hotelId);
  const organizationId = organizationFor(context, "booking", "booking_hotel", hotelId);
  const ownerActive = resourceStatusFor(context, "booking", "booking_hotel", hotelId) === "active";
  const createdAt = iso(row.data["created_at"], "created_at");
  const updatedAt = iso(row.data["updated_at"], "updated_at");
  const ruleId = commissionRuleId(hotelId);
  const plan = requiredText(row.data["billing_active_plan"], "billing_active_plan").toLowerCase();
  if (plan !== "commission" && plan !== "fixed")
    throw new Error(`billing_active_plan ${plan} is unsupported`);
  const bookingEngineFee = exactRate(row.data["booking_engine_fee_pct"], "booking_engine_fee_pct");
  const fixedBaseFee = exactMoney(row.data["fixed_base_fee"], "fixed_base_fee");
  const fixedRoomsIncluded = integer(row.data["fixed_rooms_included"], "fixed_rooms_included");
  const fixedPerExtraRoomFee = exactMoney(
    row.data["fixed_per_extra_room_fee"],
    "fixed_per_extra_room_fee",
  );
  if (bookingEngineFee !== "5")
    disposition(context, row, {
      sourceField: "booking_engine_fee_pct",
      sourceValue: row.data["booking_engine_fee_pct"],
      reasonCode: "NONCANONICAL_BOOKING_ENGINE_FEE",
      disposition: "disabled_configuration",
      targetTable: "commission_rules",
      targetId: ruleId,
    });
  if (
    plan === "fixed" &&
    (fixedBaseFee !== "30.00" || fixedRoomsIncluded !== 1 || fixedPerExtraRoomFee !== "5.00")
  )
    disposition(context, row, {
      sourceField: "fixed_plan_pricing",
      sourceValue: { fixedBaseFee, fixedRoomsIncluded, fixedPerExtraRoomFee },
      reasonCode: "NONCANONICAL_FIXED_PLAN_PRICING",
      disposition: "disabled_configuration",
    });
  const records: FinanceTargetRecord[] = [
    record(row, "commission_rules", ruleId, {
      id: ruleId,
      propertyId,
      organizationId,
      ruleScope: "property",
      product: "booking",
      commissionType: "percentage",
      percentageRate: "5",
      fixedAmount: null,
      currency: null,
      status: ownerActive && bookingEngineFee === "5" ? "active" : "inactive",
      startsAt: createdAt,
      endsAt: null,
      sourceSystem: "finance",
      sourceRuleId: `onboarding-booking:${propertyId}`,
      ruleMetadata: {
        source: "legacy-migration",
        legacyPlan: plan,
        bookingEngineFeePercent: bookingEngineFee,
        channelManagerFeePercent: exactRate(
          row.data["channel_manager_fee_pct"],
          "channel_manager_fee_pct",
        ),
        affiliatePlatformFeePercent: exactRate(
          row.data["affiliate_platform_fee_pct"],
          "affiliate_platform_fee_pct",
        ),
        legacyBillingCommissionRate: exactRate(
          row.data["billing_commission_rate"],
          "billing_commission_rate",
        ),
      },
      createdAt,
      updatedAt,
      affiliateId: null,
      otaChannel: null,
      revision: 1,
    }),
  ];
  const hps = context.pmsSettingsByProperty.get(propertyId);
  const entitlementId = deterministicUuid(
    "production-finance",
    "billing-entitlement",
    propertyId,
    "booking",
  );
  const providerStatus = hps
    ? optionalText(hps.data["stripe_billing_status"], "stripe_billing_status")
    : null;
  const billingCustomerRef = hps
    ? optionalText(hps.data["stripe_billing_customer_id"], "stripe_billing_customer_id")
    : null;
  const billingSubscriptionRef = hps
    ? optionalText(hps.data["stripe_billing_subscription_id"], "stripe_billing_subscription_id")
    : null;
  const billingCheckoutRef = hps
    ? optionalText(
        hps.data["stripe_billing_checkout_session_id"],
        "stripe_billing_checkout_session_id",
      )
    : null;
  const billingPriceDirty = hps
    ? bool(hps.data["stripe_billing_price_dirty"], "stripe_billing_price_dirty", false)
    : false;
  const billingAmountMinor =
    hps?.data["stripe_billing_amount_cents"] == null
      ? null
      : integer(hps.data["stripe_billing_amount_cents"], "stripe_billing_amount_cents");
  const activeRoomCount =
    hps?.data["stripe_billing_room_count"] == null
      ? null
      : integer(hps.data["stripe_billing_room_count"], "stripe_billing_room_count");
  const activeSubscriptionEvidence = Boolean(
    billingCustomerRef &&
    billingSubscriptionRef &&
    providerStatus &&
    ["trialing", "active"].includes(providerStatus),
  );
  const legacyBillingReferenceSha256 =
    billingCustomerRef || billingSubscriptionRef || billingCheckoutRef || providerStatus
      ? sha256({ billingCustomerRef, billingSubscriptionRef, billingCheckoutRef, providerStatus })
      : null;
  if (legacyBillingReferenceSha256)
    disposition(context, hps!, {
      sourceField: "stripe_billing_provider_reference",
      sourceValue: {
        billingCustomerRef,
        billingSubscriptionRef,
        billingCheckoutRef,
        providerStatus,
      },
      reasonCode: "LEGACY_BILLING_PROVIDER_REFERENCE_QUARANTINED",
      disposition: "omitted_field",
      targetTable: "billing_entitlements",
      targetId: entitlementId,
    });
  if (legacyBillingReferenceSha256)
    disposition(context, hps!, {
      sourceField: "stripe_billing_subscription_id",
      sourceValue: {
        billingCustomerRef,
        billingSubscriptionRef,
        billingCheckoutRef,
        providerStatus,
      },
      reasonCode: "FIXED_PLAN_PROVIDER_REBIND_REQUIRED",
      disposition: "disabled_configuration",
      targetTable: "billing_entitlements",
      targetId: entitlementId,
    });
  if (plan === "commission" && activeSubscriptionEvidence)
    disposition(context, hps!, {
      sourceField: "stripe_billing_status",
      sourceValue: hps!.data["stripe_billing_status"],
      reasonCode: "BILLING_PLAN_PROVIDER_STATE_DISAGREEMENT",
      disposition: "disabled_configuration",
      targetTable: "billing_entitlements",
      targetId: entitlementId,
    });
  const entitlementActivationReady =
    plan === "commission" && !legacyBillingReferenceSha256 && bookingEngineFee === "5";
  if (plan === "fixed") {
    if (!activeSubscriptionEvidence)
      disposition(context, row, {
        sourceField: "billing_active_plan",
        sourceValue: row.data["billing_active_plan"],
        reasonCode: "FIXED_PLAN_SUBSCRIPTION_EVIDENCE_REQUIRED",
        disposition: "disabled_configuration",
        targetTable: "billing_entitlements",
        targetId: entitlementId,
      });
    if (billingPriceDirty)
      disposition(context, hps!, {
        sourceField: "stripe_billing_price_dirty",
        sourceValue: hps!.data["stripe_billing_price_dirty"],
        reasonCode: "FIXED_PLAN_BILLING_PRICE_DIRTY",
        disposition: "disabled_configuration",
        targetTable: "billing_entitlements",
        targetId: entitlementId,
      });
    if (billingAmountMinor === null || activeRoomCount === null)
      disposition(context, hps ?? row, {
        sourceField: "fixed_plan_billing_price",
        sourceValue: { billingAmountMinor, activeRoomCount },
        reasonCode: "FIXED_PLAN_BILLING_PRICE_EVIDENCE_REQUIRED",
        disposition: "disabled_configuration",
        targetTable: "billing_entitlements",
        targetId: entitlementId,
      });
    else if (billingAmountMinor < 0 || activeRoomCount < 0)
      disposition(context, hps ?? row, {
        sourceField: "fixed_plan_billing_price",
        sourceValue: { billingAmountMinor, activeRoomCount },
        reasonCode: "INVALID_FIXED_PLAN_BILLING_EVIDENCE",
        disposition: "disabled_configuration",
        targetTable: "billing_entitlements",
        targetId: entitlementId,
      });
    else {
      const expectedAmountMinor = 3_000n + BigInt(Math.max(0, activeRoomCount - 1)) * 500n;
      if (BigInt(billingAmountMinor) !== expectedAmountMinor)
        disposition(context, hps ?? row, {
          sourceField: "stripe_billing_amount_cents",
          sourceValue: billingAmountMinor,
          reasonCode: "FIXED_PLAN_BILLING_AMOUNT_MISMATCH",
          disposition: "disabled_configuration",
          targetTable: "billing_entitlements",
          targetId: entitlementId,
        });
    }
  }
  records.push(
    record(
      row,
      "billing_entitlements",
      entitlementId,
      {
        id: entitlementId,
        organizationId,
        propertyId,
        product: "booking",
        entitlementKey: "direct-booking-finance",
        billingStatus: ownerActive && entitlementActivationReady ? "active" : "suspended",
        // A legacy Fixed plan has no trusted live provider binding after migration.
        // Keep the runtime baseline on Commission so the user can explicitly
        // re-select Commission or start a fresh Fixed checkout.
        planKey: "commission",
        seatCount: null,
        billingProvider: "manual",
        billingCustomerRef: null,
        billingSubscriptionRef: null,
        billingPeriodStart: null,
        billingPeriodEnd: null,
        startsAt: createdAt,
        expiresAt: null,
        sourceSystem: "booking",
        sourceEntitlementId: `billing:${hotelId}`,
        entitlementMetadata: {
          legacyPlan: plan,
          planSelectedAt: createdAt,
          planSelectedBy: "legacy-migration",
          fixedBaseFee,
          fixedRoomsIncluded,
          fixedPerExtraRoomFee,
          legacyBillingReferenceSha256,
          providerReentryRequired: legacyBillingReferenceSha256 !== null,
        },
        createdAt,
        updatedAt: hps ? latest(updatedAt, iso(hps.data["updated_at"], "updated_at")) : updatedAt,
        checkoutSessionRef: null,
        providerSubscriptionStatus: null,
        billingPeriodStartAt: null,
        billingPeriodEndAt: null,
        cancelAtPeriodEnd: false,
        billingAmountMinor,
        billingCurrency: billingAmountMinor === null ? null : "EUR",
        activeRoomCount,
        lastProviderEventCreatedAt: null,
        lastProviderEventId: null,
      },
      {
        sourceChecksum: sha256({ booking: row.data, pmsPaymentSettings: hps?.data ?? null }),
        sourceUpdatedAt: hps
          ? latest(updatedAt, iso(hps.data["updated_at"], "updated_at"))
          : updatedAt,
      },
    ),
  );
  if (hasBookingPayoutDestination(row)) {
    const payoutId = bookingPayoutSettingId(propertyId);
    const candidateProviderAccountId = hps ? configuredPropertyProviderId(hps, propertyId) : null;
    const plannedProviderAccountId =
      candidateProviderAccountId &&
      isPlannedTarget(context, "payment_provider_accounts", candidateProviderAccountId)
        ? candidateProviderAccountId
        : null;
    disposition(context, row, {
      sourceField: "payout_destination",
      sourceValue: sensitiveBookingPayoutFields(row),
      reasonCode: "SENSITIVE_PAYOUT_DESTINATION_REENTRY_REQUIRED",
      disposition: "target_reentry_required",
      targetTable: "payout_settings",
      targetId: payoutId,
    });
    if (candidateProviderAccountId && !plannedProviderAccountId)
      disposition(context, row, {
        sourceField: "property_provider_account_dependency",
        sourceValue: hps?.data["stripe_connect_account_id"] ?? null,
        reasonCode: "FINANCE_PARENT_RECORD_QUARANTINED",
        disposition: "disabled_configuration",
        targetTable: "payout_settings",
        targetId: payoutId,
      });
    records.push(
      record(row, "payout_settings", payoutId, {
        id: payoutId,
        propertyId,
        organizationId: null,
        propertyProviderAccountId: plannedProviderAccountId,
        organizationProviderAccountId: null,
        ownerScope: "property",
        payoutMethod: "bank_account",
        destinationCountryCode: null,
        defaultCurrency: currency(row.data["currency"]),
        status: "setup_incomplete",
        schedule: {},
        payoutPreferences: {
          legacyDestinationFingerprint: sha256(sensitiveBookingPayoutFields(row)),
          destinationRequiresReentry: true,
        },
        sensitiveDestinationRef: null,
        sourceSystem: "booking",
        sourceSettingsId: hotelId,
        createdAt,
        updatedAt,
      }),
    );
  }
  return records;
}

function commissionChangeRecords(
  context: FinanceBuildContext,
  row: IdentitySourceRow,
): FinanceTargetRecord[] {
  const id = sourceId(row);
  const hotelId = uuid(row.data["hotel_id"], "hotel_id");
  if (
    !sourceRows(context, "booking", "booking_hotels").some((hotel) => sourceId(hotel) === hotelId)
  )
    throw new Error(`booking hotel ${hotelId} is missing from the immutable source`);
  propertyFor(context, "booking", "booking_hotels", hotelId);
  const parentRuleId = commissionRuleId(hotelId);
  if (!isPlannedTarget(context, "commission_rules", parentRuleId)) {
    disposition(context, row, {
      sourceField: "*",
      sourceValue: row.data,
      reasonCode: "FINANCE_PARENT_RECORD_QUARANTINED",
      disposition: "omitted_row",
      targetTable: "commission_rate_changes",
      targetId: id,
    });
    return [];
  }
  const adminId = uuid(row.data["admin_user_id"], "admin_user_id");
  const changedAt = iso(row.data["changed_at"], "changed_at");
  return [
    record(row, "commission_rate_changes", id, {
      id,
      commissionRuleId: parentRuleId,
      changedByUserId: context.target.userIds.includes(adminId) ? adminId : null,
      previousPercentageRate: exactRate(row.data["old_value"], "old_value"),
      newPercentageRate: exactRate(row.data["new_value"], "new_value"),
      previousFixedAmount: null,
      newFixedAmount: null,
      currency: null,
      reason: optionalText(row.data["note"], "note"),
      effectiveAt: changedAt,
      changedAt,
      changeMetadata: context.target.userIds.includes(adminId)
        ? {}
        : { legacyAdminUserId: adminId },
    }),
  ];
}

function record(
  source: IdentitySourceRow,
  targetTable: string,
  targetId: string,
  row: Record<string, unknown>,
  override?: { sourceChecksum?: string; sourceUpdatedAt?: string },
): FinanceTargetRecord {
  const fallback = source.sourceTable === "affiliate_payout_settings" ? "user_id" : "id";
  return {
    targetProduct: "finance",
    targetTable,
    targetId,
    sourceDatabase: source.sourceDatabase as "booking" | "pms",
    sourceTable: source.sourceTable,
    sourceId: sourceId(source, fallback),
    sourceChecksum: override?.sourceChecksum ?? sha256(source.data),
    sourceUpdatedAt: override?.sourceUpdatedAt ?? financeTimestamp(source),
    mutable: targetTable !== "commission_rate_changes",
    row,
  };
}

function financeTimestamp(row: IdentitySourceRow): string {
  const value =
    row.data["updated_at"] ??
    row.data["changed_at"] ??
    row.data["created_at"] ??
    row.data["completed_at"];
  return iso(value, "source freshness");
}

function bookingHotelForProperty(
  context: FinanceBuildContext,
  propertyId: string,
): { currency: string; row: IdentitySourceRow } {
  const candidates = sourceRows(context, "booking", "booking_hotels").filter((row) => {
    try {
      return propertyFor(context, "booking", "booking_hotels", row.data["id"]) === propertyId;
    } catch {
      return false;
    }
  });
  if (candidates.length !== 1)
    throw new Error(`property ${propertyId} resolves to ${candidates.length} Booking hotels`);
  return { currency: currency(candidates[0]!.data["currency"]), row: candidates[0]! };
}

function agreedPaymentFlag(
  context: FinanceBuildContext,
  pms: IdentitySourceRow,
  booking: IdentitySourceRow,
  field: "online_card_payment" | "pay_at_property_enabled" | "bank_transfer",
): boolean {
  const pmsValue = bool(pms.data[field], field, false);
  const bookingValue = bool(booking.data[field], field, false);
  if (pmsValue !== bookingValue)
    disposition(context, pms, {
      sourceField: field,
      sourceValue: { pms: pmsValue, booking: bookingValue },
      reasonCode: "PAYMENT_SETTINGS_SOURCE_DISAGREEMENT",
      disposition: "disabled_configuration",
    });
  return pmsValue && bookingValue;
}

function payAtHotelMethods(value: unknown): string[] {
  const parsed = typeof value === "string" ? (JSON.parse(value) as unknown) : value;
  if (!Array.isArray(parsed) || !parsed.every((item) => item === "cash" || item === "card"))
    throw new Error("pay_at_hotel_methods must contain only cash or card");
  return [...new Set(parsed.map((item) => (item === "card" ? "manual_card" : item)))].sort();
}

function configuredPropertyProviderId(row: IdentitySourceRow, propertyId: string): string | null {
  const provider = normalizeProvider(row.data["payment_provider"]);
  const reference =
    provider === "stripe"
      ? optionalText(row.data["stripe_connect_account_id"], "stripe_connect_account_id")
      : null;
  if (provider === "stripe" && reference)
    return propertyProviderAccountId(propertyId, "stripe", reference);
  if (provider === "vayada") return propertyProviderAccountId(propertyId, "vayada", "vayada");
  return null;
}

function propertyProviderAccountId(
  propertyId: string,
  provider: "stripe" | "vayada",
  reference: string,
): string {
  return deterministicUuid(
    "production-finance",
    "property-provider",
    propertyId,
    provider,
    reference,
  );
}

function stripePropertyProviderId(row: IdentitySourceRow, propertyId: string): string | null {
  const reference = optionalText(
    row.data["stripe_connect_account_id"],
    "stripe_connect_account_id",
  );
  return reference ? propertyProviderAccountId(propertyId, "stripe", reference) : null;
}

function firstPaymentForStripeAccount(
  context: FinanceBuildContext,
  reference: string,
): string | null {
  const first = sourceRows(context, "pms", "payments").find(
    (payment) => optionalText(payment.data["stripe_account_id"], "stripe_account_id") === reference,
  );
  return first ? sourceId(first) : null;
}

function stripeReferenceIsSharedAcrossProperties(
  context: FinanceBuildContext,
  reference: string,
): boolean {
  const properties = new Set<string>();
  for (const payment of sourceRows(context, "pms", "payments")) {
    if (optionalText(payment.data["stripe_account_id"], "stripe_account_id") !== reference)
      continue;
    try {
      const bookingId = uuid(payment.data["booking_id"], "booking_id");
      const booking = context.pmsBookingById.get(bookingId);
      if (!booking) continue;
      const hotelId = uuid(booking.data["hotel_id"], "hotel_id");
      properties.add(propertyFor(context, "pms", "hotels", hotelId));
    } catch {
      // The payment transform records the source-row blocker.
    }
  }
  return properties.size > 1;
}

function affiliateProviderId(organizationId: string, reference: string): string {
  return deterministicUuid(
    "production-finance",
    "affiliate-provider",
    organizationId,
    "stripe",
    reference,
  );
}

function bookingPayoutSettingId(propertyId: string): string {
  return deterministicUuid("production-finance", "property-payout-setting", propertyId);
}

function hasPropertyPayoutSetting(context: FinanceBuildContext, propertyId: string): boolean {
  return sourceRows(context, "booking", "booking_hotels").some((row) => {
    try {
      return (
        propertyFor(context, "booking", "booking_hotels", row.data["id"]) === propertyId &&
        hasBookingPayoutDestination(row)
      );
    } catch {
      return false;
    }
  });
}

function commissionRuleId(hotelId: string): string {
  return deterministicUuid("production-finance", "booking-commission-rule", hotelId);
}

export function paymentStatus(value: unknown): string {
  const status = requiredText(value, "status").toLowerCase();
  const mapped: Record<string, string> = {
    pending: "pending",
    requires_action: "requires_action",
    authorized: "authorized",
    captured: "paid",
    cancelled: "canceled",
    refunded: "refunded",
    partially_refunded: "partially_refunded",
    failed: "failed",
  };
  if (!mapped[status]) throw new Error(`payment status ${status} is unsupported`);
  return mapped[status];
}

export function payoutStatus(value: unknown): string {
  const status = requiredText(value, "status").toLowerCase();
  const mapped: Record<string, string> = {
    scheduled: "scheduled",
    processing: "processing",
    completed: "paid",
    failed: "failed",
  };
  if (!mapped[status]) throw new Error(`payout status ${status} is unsupported`);
  return mapped[status];
}

function paymentMethod(value: unknown): string {
  const method = requiredText(value, "payment_method").toLowerCase();
  if (
    ![
      "card",
      "pay_at_property",
      "xendit",
      "cash",
      "bank_transfer",
      "manual_card",
      "other",
    ].includes(method)
  )
    throw new Error(`payment_method ${method} is unsupported`);
  return method;
}

function paymentKind(value: unknown): string {
  const purpose = requiredText(value, "payment_purpose").toLowerCase();
  const mapped: Record<string, string> = {
    booking: "full",
    deposit: "deposit",
    balance: "balance",
    arrival_charge: "adjustment",
  };
  if (!mapped[purpose]) throw new Error(`payment_purpose ${purpose} is unsupported`);
  return mapped[purpose];
}

function payoutMethod(value: unknown): string {
  const method = requiredText(value, "payment_method").toLowerCase();
  const normalized = method === "bank" ? "bank_account" : method;
  if (
    !["paypal", "stripe", "xendit", "bank_account", "wallet", "manual", "none"].includes(normalized)
  )
    throw new Error(`payment_method ${method} is unsupported`);
  return normalized;
}

function paymentMetadata(
  row: IdentitySourceRow,
  normalized: {
    refundedAt: string | null;
    refundCompletedAt: string | null;
    refundAmountMinor: string | null;
    refundCurrency: string | null;
  },
): Record<string, unknown> {
  return {
    reference: optionalText(row.data["reference"], "reference"),
    cardBrand: optionalText(row.data["card_brand"], "card_brand"),
    cardLastFour: optionalText(row.data["card_last_four"], "card_last_four"),
    stripeRefundId: optionalText(row.data["stripe_refund_id"], "stripe_refund_id"),
    stripeRefundStatus: optionalText(row.data["stripe_refund_status"], "stripe_refund_status"),
    refundedAt: normalized.refundedAt,
    stripeRefundCommandId: optionalText(
      row.data["stripe_refund_command_id"],
      "stripe_refund_command_id",
    ),
    stripeRefundTargetStatus: optionalText(
      row.data["stripe_refund_target_status"],
      "stripe_refund_target_status",
    ),
    stripeRefundTargetBookingStatus: optionalText(
      row.data["stripe_refund_target_booking_status"],
      "stripe_refund_target_booking_status",
    ),
    stripeRefundExpectedBookingStatus: optionalText(
      row.data["stripe_refund_expected_booking_status"],
      "stripe_refund_expected_booking_status",
    ),
    stripeRefundPercentage:
      row.data["stripe_refund_percentage"] == null
        ? null
        : exactRate(row.data["stripe_refund_percentage"], "stripe_refund_percentage"),
    stripeRefundAmountMinor: normalized.refundAmountMinor,
    stripeRefundCurrency: normalized.refundCurrency,
    stripeRefundPayoutsCancelledAt: optionalIso(
      row.data["stripe_refund_payouts_cancelled_at"],
      "stripe_refund_payouts_cancelled_at",
    ),
    stripeRefundChannexCancelledAt: optionalIso(
      row.data["stripe_refund_channex_cancelled_at"],
      "stripe_refund_channex_cancelled_at",
    ),
    stripeRefundAriHandoffCompletedAt: optionalIso(
      row.data["stripe_refund_ari_handoff_completed_at"],
      "stripe_refund_ari_handoff_completed_at",
    ),
    stripeRefundCompletedAt: normalized.refundCompletedAt,
  };
}

function optionalBigint(value: unknown): string | null {
  if (value === null || value === undefined || value === "") return null;
  const text = String(value);
  if (!/^\d+$/.test(text) || BigInt(text) > 9_223_372_036_854_775_807n)
    throw new Error("stripe_refund_amount_minor must be a non-negative bigint");
  return BigInt(text).toString();
}

function country(value: unknown): string | null {
  const text = optionalText(value, "bank_country");
  if (!text) return null;
  const result = text.toUpperCase();
  if (!/^[A-Z]{2}$/.test(result)) throw new Error("bank_country must be an ISO alpha-2 code");
  return result;
}

function sensitivePayoutFields(row: IdentitySourceRow): string[] {
  return [
    "paypal_email",
    "bank_iban",
    "bank_account_holder",
    "bank_swift_bic",
    "bank_name",
    "xendit_channel_code",
    "xendit_account_number",
    "xendit_account_holder_name",
  ]
    .map((field) => row.data[field])
    .filter((value): value is string => typeof value === "string" && value.trim().length > 0);
}

function sensitiveBookingPayoutFields(row: IdentitySourceRow): string[] {
  return [
    "payout_account_holder",
    "payout_iban",
    "payout_bank_name",
    "payout_swift",
    "payout_account_number",
  ]
    .map((field) => row.data[field])
    .filter((value): value is string => typeof value === "string" && value.trim().length > 0);
}

function hasBookingPayoutDestination(row: IdentitySourceRow): boolean {
  return sensitiveBookingPayoutFields(row).length > 0;
}

function latest(left: string, right: string): string {
  return Date.parse(left) >= Date.parse(right) ? left : right;
}

function safeId(row: IdentitySourceRow, field = "id"): string {
  try {
    return sourceId(row, field);
  } catch {
    return String(row.rowOrdinal);
  }
}
