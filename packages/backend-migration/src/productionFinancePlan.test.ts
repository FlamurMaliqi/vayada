import { describe, expect, it } from "vitest";

import type { IdentitySourceRow } from "./productionIdentityDisposition.js";
import { buildProductionFinancePlan } from "./productionFinancePlan.js";
import type { ProductionFinanceTargetState } from "./productionFinanceTypes.js";

const RUN = "vay1351-0123456789abcdef01234567";
const HOTEL = "10000000-0000-4000-8000-000000000001";
const PROPERTY = "20000000-0000-4000-8000-000000000001";
const ORGANIZATION = "30000000-0000-4000-8000-000000000001";
const OTHER_ORGANIZATION = "31000000-0000-4000-8000-000000000001";
const BOOKING = "40000000-0000-4000-8000-000000000001";
const TARGET_BOOKING = "50000000-0000-4000-8000-000000000001";
const PAYMENT = "60000000-0000-4000-8000-000000000001";
const PAYOUT = "70000000-0000-4000-8000-000000000001";
const ADMIN = "80000000-0000-4000-8000-000000000001";
const CHANGE = "90000000-0000-4000-8000-000000000001";
const AT = "2026-08-29T10:00:00.000Z";

describe("production Finance plan", () => {
  it("maps exact Finance facts and reconciles monetary parity", () => {
    const plan = buildProductionFinancePlan({
      sourceRunId: RUN,
      completedAt: "2026-08-30T00:00:00.000Z",
      rows: sourceRows().filter((row) => row.sourceTable !== "payouts"),
      target: target(),
    });
    expect(plan.blockers).toEqual([]);
    expect(plan.records.map((row) => row.targetTable)).toEqual([
      "billing_entitlements",
      "commission_rate_changes",
      "commission_rules",
      "payment_provider_accounts",
      "payment_settings",
      "payments",
    ]);
    const paymentDimension = Object.keys(plan.parity.sourcePaymentAmountsByCurrencyStatusOwner)[0]!;
    expect(paymentDimension).toMatch(/^EUR:stripe:paid:owner_[0-9a-f]{16}$/);
    expect(plan.parity.sourcePaymentAmountsByCurrencyStatusOwner).toEqual({
      [paymentDimension]: "123.45",
    });
    expect(plan.parity.targetPaymentAmountsByCurrencyStatusOwner).toEqual(
      plan.parity.sourcePaymentAmountsByCurrencyStatusOwner,
    );
    expect(plan.parity.sourcePaymentCountsByCurrencyStatusOwner).toEqual({
      [paymentDimension]: 1,
    });
    expect(plan.parity.targetPaymentCountsByCurrencyStatusOwner).toEqual(
      plan.parity.sourcePaymentCountsByCurrencyStatusOwner,
    );
    expect(plan.parity.sourcePaymentFeesByCurrencyStatusOwner).toEqual({
      [paymentDimension]: "3.45",
    });
    expect(plan.parity.targetPaymentFeesByCurrencyStatusOwner).toEqual(
      plan.parity.sourcePaymentFeesByCurrencyStatusOwner,
    );
    expect(plan.parity.sourcePaymentNetByCurrencyStatusOwner).toEqual({
      [paymentDimension]: "120.00",
    });
    expect(plan.parity.targetPaymentNetByCurrencyStatusOwner).toEqual(
      plan.parity.sourcePaymentNetByCurrencyStatusOwner,
    );
    expect(plan.parity.targetPaymentRefundsByCurrencyStatusOwner).toEqual(
      plan.parity.sourcePaymentRefundsByCurrencyStatusOwner,
    );
    expect(plan.parity.sourcePayoutAmountsByCurrencyStatusOwner).toEqual({});
    expect(plan.parity.targetPayoutAmountsByCurrencyStatusOwner).toEqual(
      plan.parity.sourcePayoutAmountsByCurrencyStatusOwner,
    );
    const payment = plan.records.find((row) => row.targetTable === "payments")!;
    expect(payment.targetId).toBe(PAYMENT);
    expect(payment.row).toMatchObject({
      amount: "123.45",
      feeAmount: "3.45",
      netAmount: "120.00",
      refundedAmount: "0.00",
      providerPaymentIntentId: null,
      providerTransactionId: null,
      paymentMetadata: {
        migrationDisposition: "historical_bound",
        legacyProviderReferenceSha256: expect.stringMatching(/^[0-9a-f]{64}$/),
      },
    });
    expect(JSON.stringify(plan)).not.toContain("pi_exact");
  });

  it("leaves the trigger-owned Identity entitlement link out of post-write reconciliation", () => {
    const rows = sourceRows().filter((row) => row.sourceTable !== "payouts");
    const initial = buildProductionFinancePlan({
      sourceRunId: RUN,
      completedAt: "2026-08-30T00:00:00.000Z",
      rows,
      target: target(),
    });
    const billing = initial.records.find((row) => row.targetTable === "billing_entitlements")!;
    expect(billing.row).not.toHaveProperty("identityEntitlementId");

    const state = target();
    state.records = initial.records.map((record) => ({
      targetProduct: "finance",
      targetTable: record.targetTable,
      targetId: record.targetId,
      updatedAt: String(record.row["updatedAt"]),
      row:
        record.targetTable === "billing_entitlements"
          ? { ...record.row, identityEntitlementId: "a0000000-0000-4000-8000-000000000001" }
          : record.row,
    }));
    state.provenance = initial.provenance;

    const verified = buildProductionFinancePlan({
      sourceRunId: RUN,
      completedAt: "2026-08-30T00:00:00.000Z",
      rows,
      target: state,
    });

    expect(verified.blockers).toEqual([]);
    expect(verified.writes).toEqual([]);
    expect(verified.checksum).toBe(initial.checksum);
  });

  it("blocks folio fabrication and unsafe payout secret copying", () => {
    const rows = sourceRows();
    rows.splice(
      rows.findIndex((row) => row.sourceTable === "payouts"),
      1,
    );
    rows.push(
      source("pms", "booking_checkout_records", {
        id: "a0000000-0000-4000-8000-000000000001",
        booking_id: BOOKING,
        completed_at: AT,
      }),
    );
    const hotel = rows.find((row) => row.sourceTable === "booking_hotels")!;
    hotel.data["payout_iban"] = "DE02120300000000202051";
    hotel.data["paypal_enabled"] = true;
    hotel.data["paypal_email"] = "finance-secret@example.com";
    const plan = buildProductionFinancePlan({
      sourceRunId: RUN,
      completedAt: "2026-08-30T00:00:00.000Z",
      rows,
      target: target(),
    });
    expect(plan.blockers.map((row) => row.code)).toContain("FOLIO_RECIPIENT_EVIDENCE_REQUIRED");
    expect(plan.dispositions.map((row) => row.reasonCode)).toContain(
      "SENSITIVE_PAYOUT_DESTINATION_REENTRY_REQUIRED",
    );
    expect(plan.dispositions.map((row) => row.reasonCode)).toContain(
      "PAYPAL_DESTINATION_REENTRY_REQUIRED",
    );
    expect(JSON.stringify(plan)).not.toContain("DE02120300000000202051");
    expect(JSON.stringify(plan)).not.toContain("finance-secret@example.com");
  });

  it("never overwrites newer target economic state", () => {
    const first = buildProductionFinancePlan({
      sourceRunId: RUN,
      completedAt: "2026-08-30T00:00:00.000Z",
      rows: sourceRows(),
      target: target(),
    });
    const payment = first.records.find((row) => row.targetTable === "payments")!;
    const state = target();
    state.records = [
      {
        targetProduct: "finance",
        targetTable: "payments",
        targetId: PAYMENT,
        updatedAt: "2026-08-31T00:00:00.000Z",
        row: { ...payment.row, amount: "124.45" },
      },
    ];
    state.provenance = [
      {
        sourceDatabase: "pms",
        sourceTable: "payments",
        sourceId: PAYMENT,
        targetProduct: "finance",
        targetTable: "payments",
        targetId: PAYMENT,
        sourceChecksum: payment.sourceChecksum,
        sourceUpdatedAt: payment.sourceUpdatedAt,
        lastMigratedAt: "2026-08-30T00:00:00.000Z",
      },
    ];
    const plan = buildProductionFinancePlan({
      sourceRunId: RUN,
      completedAt: "2026-08-30T00:00:00.000Z",
      rows: sourceRows(),
      target: state,
    });
    expect(plan.blockers.map((row) => row.code)).toContain("FINANCE_ECONOMIC_TARGET_NEWER");
    expect(plan.writes.some((row) => row.targetId === PAYMENT)).toBe(false);
  });

  it("blocks a new child write when its previously migrated parent was deleted", () => {
    const rows = sourceRows().filter((row) => row.sourceTable !== "payouts");
    const first = buildProductionFinancePlan({
      sourceRunId: RUN,
      completedAt: "2026-08-30T00:00:00.000Z",
      rows,
      target: target(),
    });
    const provider = first.records.find((row) => row.targetTable === "payment_provider_accounts")!;
    const providerLink = first.provenance.find(
      (row) =>
        row.targetTable === "payment_provider_accounts" && row.targetId === provider.targetId,
    )!;
    const state = target();
    state.provenance = [providerLink];

    const plan = buildProductionFinancePlan({
      sourceRunId: RUN,
      completedAt: "2026-08-31T00:00:00.000Z",
      rows,
      target: state,
    });

    expect(plan.counts.preservedTargetDeletions).toBe(1);
    expect(plan.blockers.map((row) => row.code)).toContain("FINANCE_REFERENTIAL_CLOSURE_FAILED");
  });

  it("binds historical transactions to their provider and never re-enables suspended owners", () => {
    const rows = sourceRows().filter((row) => row.sourceTable !== "payouts");
    const settings = rows.find((row) => row.sourceTable === "hotel_payment_settings")!;
    settings.data["payment_provider"] = "xendit";
    settings.data["online_card_payment"] = false;
    rows.find((row) => row.sourceTable === "booking_hotels")!.data["online_card_payment"] = false;
    const state = target();
    for (const link of state.resourceLinks) link.status = "suspended";
    const plan = buildProductionFinancePlan({
      sourceRunId: RUN,
      completedAt: "2026-08-30T00:00:00.000Z",
      rows,
      target: state,
    });
    expect(plan.blockers).toEqual([]);
    const account = plan.records.find((row) => row.targetTable === "payment_provider_accounts")!;
    const payment = plan.records.find((row) => row.targetTable === "payments")!;
    expect(account.row).toMatchObject({ provider: "stripe", status: "disabled" });
    expect(payment.row["providerAccountId"]).toBe(account.targetId);
    expect(plan.records.find((row) => row.targetTable === "payment_settings")!.row).toMatchObject({
      paymentsEnabled: false,
      providerAccountId: null,
    });
    expect(plan.records.find((row) => row.targetTable === "commission_rules")!.row["status"]).toBe(
      "inactive",
    );
    expect(
      plan.records.find((row) => row.targetTable === "billing_entitlements")!.row["billingStatus"],
    ).toBe("suspended");
  });

  it("disables property payments when only the PMS operator is suspended", () => {
    const rows = sourceRows().filter((row) => row.sourceTable !== "payouts");
    const state = target();
    state.resourceLinks.find((link) => link.product === "pms")!.status = "suspended";
    const plan = buildProductionFinancePlan({
      sourceRunId: RUN,
      completedAt: "2026-08-30T00:00:00.000Z",
      rows,
      target: state,
    });

    expect(plan.blockers).toEqual([]);
    expect(
      plan.records.find((row) => row.targetTable === "payment_provider_accounts")!.row,
    ).toMatchObject({
      status: "disabled",
      chargesEnabled: false,
      payoutsEnabled: false,
    });
    expect(plan.records.find((row) => row.targetTable === "payment_settings")!.row).toMatchObject({
      paymentsEnabled: false,
    });
  });

  it("blocks Booking and PMS payment settings owned by different organizations", () => {
    const rows = sourceRows().filter((row) => row.sourceTable !== "payouts");
    const state = target();
    state.resourceLinks.find((link) => link.product === "pms")!.organizationId = OTHER_ORGANIZATION;
    const plan = buildProductionFinancePlan({
      sourceRunId: RUN,
      completedAt: "2026-08-30T00:00:00.000Z",
      rows,
      target: state,
    });

    expect(plan.blockers.map((row) => row.code)).toContain("PAYMENT_SETTINGS_OWNER_DISAGREEMENT");
    expect(
      plan.records.find((row) => row.targetTable === "payment_provider_accounts")!.row,
    ).toMatchObject({
      status: "disabled",
      chargesEnabled: false,
      payoutsEnabled: false,
    });
  });

  it("preserves safe Booking payment methods when PMS settings are absent", () => {
    const rows = sourceRows().filter(
      (row) => !["hotel_payment_settings", "payouts"].includes(row.sourceTable),
    );
    const plan = buildProductionFinancePlan({
      sourceRunId: RUN,
      completedAt: "2026-08-30T00:00:00.000Z",
      rows,
      target: target(),
    });

    expect(plan.blockers.map((row) => row.code)).toContain(
      "ONLINE_CARD_PROVIDER_EVIDENCE_REQUIRED",
    );
    expect(plan.records.find((row) => row.targetTable === "payment_settings")!.row).toMatchObject({
      providerAccountId: null,
      paymentsEnabled: true,
      acceptedMethods: ["pay_at_property", "cash", "manual_card"],
      requiresManualReview: true,
    });
  });

  it("blocks payout-to-payment allocation without explicit source evidence", () => {
    const rows = sourceRows();
    const second = {
      ...rows.find((row) => row.sourceTable === "payments")!,
      rowOrdinal: 2,
      data: {
        ...rows.find((row) => row.sourceTable === "payments")!.data,
        id: "61000000-0000-4000-8000-000000000001",
        stripe_payment_intent_id: "pi_second",
      },
    };
    rows.push(second);
    const plan = buildProductionFinancePlan({
      sourceRunId: RUN,
      completedAt: "2026-08-30T00:00:00.000Z",
      rows,
      target: target(),
    });
    expect(plan.dispositions.map((row) => row.reasonCode)).toContain(
      "PAYOUT_PAYMENT_ALLOCATION_EVIDENCE_REQUIRED",
    );
  });

  it("uses only canonical ownership relationships", () => {
    const state = target();
    state.propertyLinks[0]!.relationship = "operational_input";
    state.resourceLinks = state.resourceLinks.map((link) => ({
      ...link,
      relationship: "finance_manager",
    }));
    const plan = buildProductionFinancePlan({
      sourceRunId: RUN,
      completedAt: "2026-08-30T00:00:00.000Z",
      rows: sourceRows(),
      target: state,
    });
    expect(plan.blockers.map((row) => row.code)).toContain("FINANCE_PROPERTY_LINK_INVALID");
    expect(plan.dispositions.map((row) => row.reasonCode)).toContain("INVALID_FINANCE_SOURCE_ROW");
  });

  it("reports malformed affiliate user identities as source blockers", () => {
    const rows = sourceRows();
    rows.push(
      source("pms", "affiliates", {
        id: "a1000000-0000-4000-8000-000000000001",
        user_id: "not-a-uuid",
        stripe_connect_account_id: null,
      }),
    );

    const plan = buildProductionFinancePlan({
      sourceRunId: RUN,
      completedAt: "2026-08-30T00:00:00.000Z",
      rows,
      target: target(),
    });

    expect(plan.dispositions.map((row) => row.reasonCode)).toContain("INVALID_FINANCE_SOURCE_ROW");
  });

  it("never infers a Stripe payment account from current settings", () => {
    const rows = sourceRows();
    delete rows.find((row) => row.sourceTable === "payments")!.data["stripe_account_id"];
    const plan = buildProductionFinancePlan({
      sourceRunId: RUN,
      completedAt: "2026-08-30T00:00:00.000Z",
      rows,
      target: target(),
    });
    expect(plan.dispositions.map((row) => row.reasonCode)).toContain(
      "MISSING_PAYMENT_PROVIDER_ACCOUNT_ID",
    );
    expect(plan.blockers).toEqual([]);
    expect(plan.records.find((row) => row.targetTable === "payments")!.row).toMatchObject({
      providerAccountId: null,
      paymentMetadata: { migrationDisposition: "historical_unbound" },
    });
  });

  it("omits capture-incomplete payments with exact hash-only evidence", () => {
    const rows = sourceRows().filter((row) => row.sourceTable !== "payouts");
    const payment = rows.find((row) => row.sourceTable === "payments")!;
    payment.data["captured_at"] = null;
    const plan = buildProductionFinancePlan({
      sourceRunId: RUN,
      completedAt: "2026-08-30T00:00:00.000Z",
      rows,
      target: target(),
    });

    expect(plan.blockers).toEqual([]);
    expect(plan.records.some((row) => row.targetTable === "payments")).toBe(false);
    expect(plan.dispositions).toContainEqual(
      expect.objectContaining({
        reasonCode: "PAYMENT_CAPTURE_EVIDENCE_REQUIRED",
        disposition: "omitted_row",
        sourceValueSha256: expect.stringMatching(/^[0-9a-f]{64}$/),
      }),
    );
    expect(plan.parity.sourcePaymentAmountsByCurrencyStatusOwner).toEqual(
      plan.parity.omittedPaymentAmountsByCurrencyStatusOwner,
    );
    expect(Object.values(plan.parity.omittedPaymentAmountsByCurrencyStatusOwner)).toEqual([
      "123.45",
    ]);
    expect(plan.parity.targetPaymentAmountsByCurrencyStatusOwner).toEqual({});
  });

  it("keeps an omitted payment with missing ownership in the raw money ledger", () => {
    const rows = sourceRows().filter((row) => row.sourceTable !== "payouts");
    rows.find((row) => row.sourceTable === "payments")!.data["booking_id"] =
      "41000000-0000-4000-8000-000000000099";

    const plan = buildProductionFinancePlan({
      sourceRunId: RUN,
      completedAt: "2026-08-30T00:00:00.000Z",
      rows,
      target: target(),
    });

    expect(plan.blockers).toEqual([]);
    expect(Object.keys(plan.parity.sourcePaymentAmountsByCurrencyStatusOwner)[0]).toMatch(
      /^invalid_[0-9a-f]{16}$/,
    );
    expect(Object.values(plan.parity.sourcePaymentAmountsByCurrencyStatusOwner)).toEqual([
      "123.45",
    ]);
    expect(plan.parity.omittedPaymentAmountsByCurrencyStatusOwner).toEqual(
      plan.parity.sourcePaymentAmountsByCurrencyStatusOwner,
    );
    expect(plan.parity.targetPaymentAmountsByCurrencyStatusOwner).toEqual({});
    expect(plan.parity.omittedPaymentCountsByCurrencyStatusOwner).toEqual(
      plan.parity.sourcePaymentCountsByCurrencyStatusOwner,
    );
  });

  it("keeps an omitted payout with missing ownership in the raw money ledger", () => {
    const rows = sourceRows();
    const payout = rows.find((row) => row.sourceTable === "payouts")!;
    payout.data["recipient_type"] = "affiliate";
    payout.data["recipient_id"] = "a2000000-0000-4000-8000-000000000099";

    const plan = buildProductionFinancePlan({
      sourceRunId: RUN,
      completedAt: "2026-08-30T00:00:00.000Z",
      rows,
      target: target(),
    });

    expect(plan.blockers).toEqual([]);
    expect(Object.keys(plan.parity.sourcePayoutAmountsByCurrencyStatusOwner)[0]).toMatch(
      /^invalid_[0-9a-f]{16}$/,
    );
    expect(Object.values(plan.parity.sourcePayoutAmountsByCurrencyStatusOwner)).toEqual(["100.00"]);
    expect(plan.parity.omittedPayoutAmountsByCurrencyStatusOwner).toEqual(
      plan.parity.sourcePayoutAmountsByCurrencyStatusOwner,
    );
    expect(plan.parity.targetPayoutAmountsByCurrencyStatusOwner).toEqual({});
    expect(plan.parity.omittedPayoutCountsByCurrencyStatusOwner).toEqual(
      plan.parity.sourcePayoutCountsByCurrencyStatusOwner,
    );
  });

  it("blocks when an omitted economic amount cannot enter the raw ledger", () => {
    const rows = sourceRows().filter((row) => row.sourceTable !== "payouts");
    const payment = rows.find((row) => row.sourceTable === "payments")!;
    payment.data["booking_id"] = "41000000-0000-4000-8000-000000000099";
    payment.data["amount"] = "not-money";

    const plan = buildProductionFinancePlan({
      sourceRunId: RUN,
      completedAt: "2026-08-30T00:00:00.000Z",
      rows,
      target: target(),
    });

    expect(plan.blockers.map((row) => row.code)).toContain(
      "FINANCE_SOURCE_MONETARY_VALUE_UNREADABLE",
    );
  });

  it("keeps sensitive affiliate payout settings inactive until target re-entry", () => {
    const affiliateId = "a2000000-0000-4000-8000-000000000001";
    const affiliateUserId = "a3000000-0000-4000-8000-000000000001";
    const rows = sourceRows().filter((row) => row.sourceTable !== "payouts");
    rows.push(
      source("pms", "affiliates", {
        id: affiliateId,
        user_id: affiliateUserId,
        hotel_id: HOTEL,
        stripe_connect_account_id: "acct_affiliate",
        stripe_connect_onboarded: true,
        created_at: AT,
        updated_at: AT,
      }),
      source("pms", "affiliate_payout_settings", {
        user_id: affiliateUserId,
        payment_method: "stripe",
        bank_country: "DE",
        bank_iban: "sensitive-destination",
        created_at: AT,
        updated_at: AT,
      }),
    );
    const state = target();
    state.resourceLinks.push({
      organizationId: OTHER_ORGANIZATION,
      product: "affiliate",
      resourceType: "affiliate",
      resourceId: affiliateId,
      relationship: "owner",
      status: "active",
    });

    const plan = buildProductionFinancePlan({
      sourceRunId: RUN,
      completedAt: "2026-08-30T00:00:00.000Z",
      rows,
      target: state,
    });

    expect(plan.blockers).toEqual([]);
    expect(plan.records.find((row) => row.targetTable === "payout_settings")!.row).toMatchObject({
      status: "setup_incomplete",
      sensitiveDestinationRef: null,
      payoutPreferences: { destinationRequiresReentry: true },
    });
    expect(JSON.stringify(plan)).not.toContain("sensitive-destination");
  });

  it("does not bind an affiliate payout setting to a quarantined provider account", () => {
    const affiliateId = "a2000000-0000-4000-8000-000000000002";
    const affiliateUserId = "a3000000-0000-4000-8000-000000000002";
    const rows = sourceRows().filter((row) => row.sourceTable !== "payouts");
    rows.push(
      source("pms", "affiliates", {
        id: affiliateId,
        user_id: affiliateUserId,
        hotel_id: HOTEL,
        stripe_connect_account_id: "acct_invalid_affiliate",
        stripe_connect_onboarded: "not-a-boolean",
        created_at: AT,
        updated_at: AT,
      }),
      source("pms", "affiliate_payout_settings", {
        user_id: affiliateUserId,
        payment_method: "stripe",
        bank_country: "DE",
        created_at: AT,
        updated_at: AT,
      }),
    );
    const state = target();
    state.resourceLinks.push({
      organizationId: OTHER_ORGANIZATION,
      product: "affiliate",
      resourceType: "affiliate",
      resourceId: affiliateId,
      relationship: "owner",
      status: "active",
    });

    const plan = buildProductionFinancePlan({
      sourceRunId: RUN,
      completedAt: "2026-08-30T00:00:00.000Z",
      rows,
      target: state,
    });
    const affiliateSetting = plan.records.find(
      (row) =>
        row.targetTable === "payout_settings" && row.row["organizationId"] === OTHER_ORGANIZATION,
    )!;

    expect(plan.blockers).toEqual([]);
    expect(affiliateSetting.row).toMatchObject({
      organizationProviderAccountId: null,
      status: "setup_incomplete",
    });
    expect(plan.dispositions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          sourceTable: "affiliates",
          reasonCode: "INVALID_FINANCE_SOURCE_ROW",
          disposition: "omitted_row",
        }),
        expect.objectContaining({
          sourceTable: "affiliate_payout_settings",
          reasonCode: "FINANCE_PARENT_RECORD_QUARANTINED",
        }),
      ]),
    );
  });

  it("quarantines an affiliate payout method outside the target enum", () => {
    const affiliateId = "a2000000-0000-4000-8000-000000000003";
    const affiliateUserId = "a3000000-0000-4000-8000-000000000003";
    const rows = sourceRows().filter((row) => row.sourceTable !== "payouts");
    rows.push(
      source("pms", "affiliates", {
        id: affiliateId,
        user_id: affiliateUserId,
        hotel_id: HOTEL,
        stripe_connect_account_id: null,
      }),
      source("pms", "affiliate_payout_settings", {
        user_id: affiliateUserId,
        payment_method: "crypto",
        bank_country: "DE",
        created_at: AT,
        updated_at: AT,
      }),
    );
    const state = target();
    state.resourceLinks.push({
      organizationId: OTHER_ORGANIZATION,
      product: "affiliate",
      resourceType: "affiliate",
      resourceId: affiliateId,
      relationship: "owner",
      status: "active",
    });

    const plan = buildProductionFinancePlan({
      sourceRunId: RUN,
      completedAt: "2026-08-30T00:00:00.000Z",
      rows,
      target: state,
    });

    expect(
      plan.records.some(
        (row) =>
          row.targetTable === "payout_settings" && row.row["organizationId"] === OTHER_ORGANIZATION,
      ),
    ).toBe(false);
    expect(plan.dispositions).toContainEqual(
      expect.objectContaining({
        sourceTable: "affiliate_payout_settings",
        sourceField: "*",
        reasonCode: "INVALID_FINANCE_SOURCE_ROW",
        disposition: "omitted_row",
      }),
    );
  });

  it("never binds a property payout setting to a provider row that failed validation", () => {
    const rows = sourceRows().filter((row) => row.sourceTable !== "payouts");
    rows.find((row) => row.sourceTable === "hotel_payment_settings")!.data[
      "stripe_connect_onboarded"
    ] = "not-a-boolean";
    rows.find((row) => row.sourceTable === "booking_hotels")!.data["payout_iban"] =
      "sensitive-destination";

    const plan = buildProductionFinancePlan({
      sourceRunId: RUN,
      completedAt: "2026-08-30T00:00:00.000Z",
      rows,
      target: target(),
    });
    const propertySetting = plan.records.find(
      (row) => row.targetTable === "payout_settings" && row.row["propertyId"] === PROPERTY,
    )!;

    expect(propertySetting.row).toMatchObject({
      propertyProviderAccountId: null,
      status: "setup_incomplete",
    });
    expect(plan.blockers.map((row) => row.code)).not.toContain(
      "FINANCE_REFERENTIAL_CLOSURE_FAILED",
    );
    expect(plan.dispositions).toContainEqual(
      expect.objectContaining({
        sourceTable: "hotel_payment_settings",
        reasonCode: "INVALID_FINANCE_SOURCE_ROW",
        disposition: "omitted_row",
      }),
    );
    expect(JSON.stringify(plan)).not.toContain("sensitive-destination");
  });

  it("omits commission history whose current rule projection was quarantined", () => {
    const rows = sourceRows().filter((row) => row.sourceTable !== "payouts");
    rows.find((row) => row.sourceTable === "booking_hotels")!.data["billing_active_plan"] =
      "unsupported";

    const plan = buildProductionFinancePlan({
      sourceRunId: RUN,
      completedAt: "2026-08-30T00:00:00.000Z",
      rows,
      target: target(),
    });

    expect(plan.blockers).toEqual([]);
    expect(plan.records.some((row) => row.targetTable === "commission_rules")).toBe(false);
    expect(plan.records.some((row) => row.targetTable === "commission_rate_changes")).toBe(false);
    expect(plan.dispositions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          sourceTable: "booking_hotels",
          reasonCode: "INVALID_FINANCE_SOURCE_ROW",
          disposition: "omitted_row",
        }),
        expect.objectContaining({
          sourceTable: "commission_rate_changes",
          reasonCode: "FINANCE_PARENT_RECORD_QUARANTINED",
          disposition: "omitted_row",
        }),
      ]),
    );
  });

  it("quarantines all Booking hotel projections when an early projection field is invalid", () => {
    const rows = sourceRows().filter((row) => row.sourceTable !== "payouts");
    rows.find((row) => row.sourceTable === "booking_hotels")!.data["pay_at_hotel_methods"] = [
      "unsupported",
    ];

    const plan = buildProductionFinancePlan({
      sourceRunId: RUN,
      completedAt: "2026-08-30T00:00:00.000Z",
      rows,
      target: target(),
    });

    expect(plan.blockers).toEqual([]);
    expect(
      plan.records.some(
        (row) => row.sourceDatabase === "booking" && row.sourceTable === "booking_hotels",
      ),
    ).toBe(false);
    expect(plan.dispositions).toContainEqual(
      expect.objectContaining({
        sourceTable: "booking_hotels",
        sourceField: "*",
        reasonCode: "INVALID_FINANCE_SOURCE_ROW",
        disposition: "omitted_row",
      }),
    );
    expect(plan.blockers.map((row) => row.code)).not.toContain(
      "FINANCE_REFERENTIAL_CLOSURE_FAILED",
    );
  });

  it("binds rotated Stripe payments to their historical account", () => {
    const rows = sourceRows().filter((row) => row.sourceTable !== "payouts");
    rows.find((row) => row.sourceTable === "payments")!.data["stripe_account_id"] = "acct_old";
    const plan = buildProductionFinancePlan({
      sourceRunId: RUN,
      completedAt: "2026-08-30T00:00:00.000Z",
      rows,
      target: target(),
    });
    expect(plan.blockers).toEqual([]);
    const accounts = plan.records.filter(
      (record) => record.targetTable === "payment_provider_accounts",
    );
    expect(accounts).toHaveLength(2);
    const historical = accounts.find((record) => record.row["providerAccountId"] === "acct_old")!;
    expect(historical.row["status"]).toBe("disabled");
    expect(
      plan.records.find((record) => record.targetTable === "payments")!.row["providerAccountId"],
    ).toBe(historical.targetId);
  });

  it("quarantines invalid rows but still blocks unexplained fee allocations", () => {
    const rows = sourceRows();
    const payment = rows.find((row) => row.sourceTable === "payments")!;
    payment.data["currency"] = "ZZZ";
    payment.data["stripe_platform_fee_amount"] = "1.00";
    const plan = buildProductionFinancePlan({
      sourceRunId: RUN,
      completedAt: "2026-08-30T00:00:00.000Z",
      rows,
      target: target(),
    });
    expect(plan.dispositions.map((row) => row.reasonCode)).toContain("INVALID_FINANCE_SOURCE_ROW");
    expect(plan.blockers).toEqual([]);
    expect(plan.records.some((row) => row.targetId === PAYMENT)).toBe(false);

    payment.data["currency"] = "EUR";
    const invalidAllocation = buildProductionFinancePlan({
      sourceRunId: RUN,
      completedAt: "2026-08-30T00:00:00.000Z",
      rows,
      target: target(),
    });
    expect(invalidAllocation.blockers.map((row) => row.code)).toContain(
      "INVALID_PAYMENT_FEE_ALLOCATION",
    );
  });

  it("blocks booking allocations that do not reconcile exactly", () => {
    const rows = sourceRows();
    const booking = rows.find((row) => row.sourceTable === "bookings")!;
    Object.assign(booking.data, {
      total_amount: "123.45",
      platform_fee_amount: "3.45",
      affiliate_commission_amount: "20.00",
      property_payout_amount: "99.99",
    });
    const plan = buildProductionFinancePlan({
      sourceRunId: RUN,
      completedAt: "2026-08-30T00:00:00.000Z",
      rows,
      target: target(),
    });
    expect(plan.dispositions.map((row) => row.reasonCode)).toContain(
      "INVALID_BOOKING_FINANCE_ALLOCATION",
    );
    expect(plan.blockers).toEqual([]);
  });

  it("retains an unmatched valid booking payout estimate only as hash evidence", () => {
    const rows = sourceRows().filter((row) => row.sourceTable !== "payouts");
    Object.assign(rows.find((row) => row.sourceTable === "bookings")!.data, {
      total_amount: "103.45",
      platform_fee_amount: "3.45",
      affiliate_commission_amount: "0.00",
      property_payout_amount: "100.00",
    });

    const plan = buildProductionFinancePlan({
      sourceRunId: RUN,
      completedAt: "2026-08-30T00:00:00.000Z",
      rows,
      target: target(),
    });

    expect(plan.blockers).toEqual([]);
    expect(plan.records.some((row) => row.targetTable === "payouts")).toBe(false);
    expect(plan.dispositions).toContainEqual(
      expect.objectContaining({
        sourceTable: "bookings",
        sourceField: "property_payout_amount",
        sourceValueSha256: expect.stringMatching(/^[0-9a-f]{64}$/),
        reasonCode: "BOOKING_FINANCE_ALLOCATION_EVIDENCE_REQUIRED",
        disposition: "unbound_history",
      }),
    );
    expect(plan.parity.omittedPayoutAllocationsByBookingOwner).toEqual(
      plan.parity.sourcePayoutAllocationsByBookingOwner,
    );
    expect(Object.values(plan.parity.omittedPayoutAllocationsByBookingOwner)).toEqual(["100.00"]);
    expect(plan.parity.targetPayoutAllocationsByBookingOwner).toEqual({});
  });

  it("accepts an actual payout that exactly represents a valid booking allocation", () => {
    const rows = sourceRows();
    Object.assign(rows.find((row) => row.sourceTable === "bookings")!.data, {
      total_amount: "103.45",
      platform_fee_amount: "3.45",
      affiliate_commission_amount: "0.00",
      property_payout_amount: "100.00",
    });

    const plan = buildProductionFinancePlan({
      sourceRunId: RUN,
      completedAt: "2026-08-30T00:00:00.000Z",
      rows,
      target: target(),
    });

    expect(plan.blockers).toEqual([]);
    expect(plan.parity.omittedPayoutAllocationsByBookingOwner).toEqual({});
    expect(plan.parity.targetPayoutAllocationsByBookingOwner).toEqual(
      plan.parity.sourcePayoutAllocationsByBookingOwner,
    );
    expect(plan.dispositions.some((row) => row.sourceField === "property_payout_amount")).toBe(
      false,
    );
  });

  it("blocks conflicting actual payout evidence instead of omitting it", () => {
    const rows = sourceRows();
    Object.assign(rows.find((row) => row.sourceTable === "bookings")!.data, {
      total_amount: "103.45",
      platform_fee_amount: "3.45",
      affiliate_commission_amount: "0.00",
      property_payout_amount: "100.00",
    });
    rows.find((row) => row.sourceTable === "payouts")!.data["amount"] = "0.00";

    const plan = buildProductionFinancePlan({
      sourceRunId: RUN,
      completedAt: "2026-08-30T00:00:00.000Z",
      rows,
      target: target(),
    });

    expect(plan.blockers.map((row) => row.code)).toContain(
      "FINANCE_PAYOUT_ALLOCATION_PARITY_MISMATCH",
    );
    expect(plan.parity.omittedPayoutAllocationsByBookingOwner).toEqual({});
    expect(plan.dispositions.some((row) => row.sourceField === "property_payout_amount")).toBe(
      false,
    );
  });

  it("counts represented and omitted booking owners independently", () => {
    const affiliateId = "a2000000-0000-4000-8000-000000000004";
    const rows = sourceRows();
    Object.assign(rows.find((row) => row.sourceTable === "bookings")!.data, {
      total_amount: "110.00",
      platform_fee_amount: "0.00",
      affiliate_commission_amount: "10.00",
      property_payout_amount: "100.00",
      affiliate_id: affiliateId,
    });
    rows.push(
      source("pms", "affiliates", {
        id: affiliateId,
        stripe_connect_account_id: null,
      }),
    );
    const state = target();
    state.resourceLinks.push({
      organizationId: OTHER_ORGANIZATION,
      product: "affiliate",
      resourceType: "affiliate",
      resourceId: affiliateId,
      relationship: "owner",
      status: "active",
    });

    const plan = buildProductionFinancePlan({
      sourceRunId: RUN,
      completedAt: "2026-08-30T00:00:00.000Z",
      rows,
      target: state,
    });

    expect(plan.blockers).toEqual([]);
    expect(Object.values(plan.parity.sourcePayoutAllocationsByBookingOwner).sort()).toEqual([
      "10.00",
      "100.00",
    ]);
    expect(Object.values(plan.parity.targetPayoutAllocationsByBookingOwner)).toEqual(["100.00"]);
    expect(Object.values(plan.parity.omittedPayoutAllocationsByBookingOwner)).toEqual(["10.00"]);
    expect(plan.dispositions).toContainEqual(
      expect.objectContaining({
        sourceField: "affiliate_commission_amount",
        reasonCode: "BOOKING_FINANCE_ALLOCATION_EVIDENCE_REQUIRED",
        disposition: "unbound_history",
      }),
    );
  });

  it("blocks commission pricing while a legacy fixed subscription is active", () => {
    const rows = sourceRows().filter((row) => row.sourceTable !== "payouts");
    const settings = rows.find((row) => row.sourceTable === "hotel_payment_settings")!;
    Object.assign(settings.data, {
      stripe_billing_customer_id: "cus_stale_fixed",
      stripe_billing_subscription_id: "sub_stale_fixed",
      stripe_billing_status: "active",
      stripe_billing_amount_cents: 3000,
      stripe_billing_room_count: 1,
    });
    const plan = buildProductionFinancePlan({
      sourceRunId: RUN,
      completedAt: "2026-08-30T00:00:00.000Z",
      rows,
      target: target(),
    });

    expect(plan.dispositions.map((row) => row.reasonCode)).toEqual(
      expect.arrayContaining([
        "FIXED_PLAN_PROVIDER_REBIND_REQUIRED",
        "BILLING_PLAN_PROVIDER_STATE_DISAGREEMENT",
      ]),
    );
    expect(
      plan.records.find((row) => row.targetTable === "billing_entitlements")!.row["billingStatus"],
    ).toBe("suspended");
  });

  it("suspends and quarantines partial legacy billing provider state", () => {
    const rows = sourceRows().filter((row) => row.sourceTable !== "payouts");
    const settings = rows.find((row) => row.sourceTable === "hotel_payment_settings")!;
    Object.assign(settings.data, {
      stripe_billing_customer_id: null,
      stripe_billing_subscription_id: "sub_partial",
      stripe_billing_status: "active",
    });
    const plan = buildProductionFinancePlan({
      sourceRunId: RUN,
      completedAt: "2026-08-30T00:00:00.000Z",
      rows,
      target: target(),
    });
    const entitlement = plan.records.find((row) => row.targetTable === "billing_entitlements")!;

    expect(plan.dispositions.map((row) => row.reasonCode)).toEqual(
      expect.arrayContaining([
        "LEGACY_BILLING_PROVIDER_REFERENCE_QUARANTINED",
        "FIXED_PLAN_PROVIDER_REBIND_REQUIRED",
      ]),
    );
    expect(entitlement.row).toMatchObject({
      billingStatus: "suspended",
      planKey: "commission",
      billingProvider: "manual",
      billingCustomerRef: null,
      billingSubscriptionRef: null,
      checkoutSessionRef: null,
      providerSubscriptionStatus: null,
    });
    expect(JSON.stringify(plan)).not.toContain("sub_partial");
  });

  it("maps only the runtime-supported fixed plan contract", () => {
    const rows = sourceRows().filter((row) => row.sourceTable !== "payouts");
    const hotel = rows.find((row) => row.sourceTable === "booking_hotels")!;
    hotel.data["billing_active_plan"] = "fixed";
    const settings = rows.find((row) => row.sourceTable === "hotel_payment_settings")!;
    Object.assign(settings.data, {
      stripe_billing_customer_id: "cus_exact",
      stripe_billing_subscription_id: "sub_exact",
      stripe_billing_checkout_session_id: "cs_exact",
      stripe_billing_status: "active",
      stripe_billing_amount_cents: 3000,
      stripe_billing_room_count: 1,
    });
    const plan = buildProductionFinancePlan({
      sourceRunId: RUN,
      completedAt: "2026-08-30T00:00:00.000Z",
      rows,
      target: target(),
    });
    expect(plan.dispositions.map((row) => row.reasonCode)).toContain(
      "FIXED_PLAN_PROVIDER_REBIND_REQUIRED",
    );
    expect(plan.records.find((row) => row.targetTable === "commission_rules")!.row).toMatchObject({
      percentageRate: "5",
      status: "active",
    });
    const entitlement = plan.records.find((row) => row.targetTable === "billing_entitlements")!;
    expect(entitlement.row).toMatchObject({
      billingStatus: "suspended",
      planKey: "commission",
      billingProvider: "manual",
      billingCustomerRef: null,
      billingSubscriptionRef: null,
      checkoutSessionRef: null,
      providerSubscriptionStatus: null,
      billingCurrency: "EUR",
      entitlementMetadata: {
        legacyBillingReferenceSha256: expect.stringMatching(/^[0-9a-f]{64}$/),
        providerReentryRequired: true,
      },
    });
    expect(JSON.stringify(plan)).not.toContain("cus_exact");
    expect(JSON.stringify(plan)).not.toContain("sub_exact");
    expect(JSON.stringify(plan)).not.toContain("cs_exact");

    settings.data["stripe_billing_price_dirty"] = true;
    const dirty = buildProductionFinancePlan({
      sourceRunId: RUN,
      completedAt: "2026-08-30T00:00:00.000Z",
      rows,
      target: target(),
    });
    expect(dirty.dispositions.map((row) => row.reasonCode)).toContain(
      "FIXED_PLAN_BILLING_PRICE_DIRTY",
    );
    expect(
      dirty.records.find((row) => row.targetTable === "billing_entitlements")!.row["billingStatus"],
    ).toBe("suspended");

    settings.data["stripe_billing_price_dirty"] = false;
    settings.data["stripe_billing_room_count"] = -1;
    settings.data["stripe_billing_amount_cents"] = -1;
    const negative = buildProductionFinancePlan({
      sourceRunId: RUN,
      completedAt: "2026-08-30T00:00:00.000Z",
      rows,
      target: target(),
    });
    expect(negative.dispositions.map((row) => row.reasonCode)).toContain(
      "INVALID_FIXED_PLAN_BILLING_EVIDENCE",
    );

    settings.data["stripe_billing_room_count"] = 1;
    settings.data["stripe_billing_amount_cents"] = 3500;
    const mismatched = buildProductionFinancePlan({
      sourceRunId: RUN,
      completedAt: "2026-08-30T00:00:00.000Z",
      rows,
      target: target(),
    });
    expect(mismatched.dispositions.map((row) => row.reasonCode)).toContain(
      "FIXED_PLAN_BILLING_AMOUNT_MISMATCH",
    );

    settings.data["stripe_billing_amount_cents"] = 3000;
    hotel.data["fixed_base_fee"] = "31.00";
    const blocked = buildProductionFinancePlan({
      sourceRunId: RUN,
      completedAt: "2026-08-30T00:00:00.000Z",
      rows,
      target: target(),
    });
    expect(blocked.dispositions.map((row) => row.reasonCode)).toContain(
      "NONCANONICAL_FIXED_PLAN_PRICING",
    );
  });

  it("never activates a canonicalized commission rule when the legacy fee differs", () => {
    const rows = sourceRows().filter((row) => row.sourceTable !== "payouts");
    rows.find((row) => row.sourceTable === "booking_hotels")!.data["booking_engine_fee_pct"] =
      "7.00";
    const plan = buildProductionFinancePlan({
      sourceRunId: RUN,
      completedAt: "2026-08-30T00:00:00.000Z",
      rows,
      target: target(),
    });

    expect(plan.blockers).toEqual([]);
    expect(plan.dispositions.map((row) => row.reasonCode)).toContain(
      "NONCANONICAL_BOOKING_ENGINE_FEE",
    );
    expect(plan.records.find((row) => row.targetTable === "commission_rules")!.row).toMatchObject({
      percentageRate: "5",
      status: "inactive",
    });
    expect(
      plan.records.find((row) => row.targetTable === "billing_entitlements")!.row["billingStatus"],
    ).toBe("suspended");
  });

  it("fails closed when Booking and PMS payment settings disagree", () => {
    const rows = sourceRows();
    rows.find((row) => row.sourceTable === "booking_hotels")!.data["online_card_payment"] = false;
    const plan = buildProductionFinancePlan({
      sourceRunId: RUN,
      completedAt: "2026-08-30T00:00:00.000Z",
      rows,
      target: target(),
    });
    expect(plan.dispositions.map((row) => row.reasonCode)).toContain(
      "PAYMENT_SETTINGS_SOURCE_DISAGREEMENT",
    );
    expect(
      plan.records.find((row) => row.targetTable === "payment_settings")!.row["acceptedMethods"],
    ).not.toContain("card");
  });

  it("blocks contradictory refunds and preserves immutable history", () => {
    const rows = sourceRows().filter((row) => row.sourceTable !== "payouts");
    const paymentSource = rows.find((row) => row.sourceTable === "payments")!;
    paymentSource.data["status"] = "refunded";
    paymentSource.data["refund_amount"] = null;
    const refundPlan = buildProductionFinancePlan({
      sourceRunId: RUN,
      completedAt: "2026-08-30T00:00:00.000Z",
      rows,
      target: target(),
    });
    expect(refundPlan.blockers.map((row) => row.code)).toContain(
      "PAYMENT_REFUND_STATE_INCONSISTENT",
    );
    expect(refundPlan.blockers.map((row) => row.code)).toContain(
      "PAYMENT_REFUND_COMPLETION_EVIDENCE_REQUIRED",
    );

    paymentSource.data["status"] = "captured";
    const initial = buildProductionFinancePlan({
      sourceRunId: RUN,
      completedAt: "2026-08-30T00:00:00.000Z",
      rows,
      target: target(),
    });
    const change = initial.records.find((row) => row.targetTable === "commission_rate_changes")!;
    const state = target();
    state.records = [
      {
        targetProduct: "finance",
        targetTable: change.targetTable,
        targetId: change.targetId,
        updatedAt: "2026-08-01T00:00:00.000Z",
        row: { ...change.row, newPercentageRate: "6" },
      },
    ];
    const immutable = buildProductionFinancePlan({
      sourceRunId: RUN,
      completedAt: "2026-08-30T00:00:00.000Z",
      rows,
      target: state,
    });
    expect(immutable.blockers.map((row) => row.code)).toContain("FINANCE_IMMUTABLE_CONFLICT");
  });

  it("blocks active, mismatched, and failed Stripe refund workflows", () => {
    const rows = sourceRows().filter((row) => row.sourceTable !== "payouts");
    const payment = rows.find((row) => row.sourceTable === "payments")!;
    Object.assign(payment.data, {
      status: "refunded",
      refund_amount: "123.45",
      refunded_at: AT,
      stripe_refund_id: "re_exact",
      stripe_refund_status: "pending",
      stripe_refund_target_status: "refunded",
    });
    const active = buildProductionFinancePlan({
      sourceRunId: RUN,
      completedAt: "2026-08-30T00:00:00.000Z",
      rows,
      target: target(),
    });
    expect(active.blockers.map((row) => row.code)).toContain("ACTIVE_STRIPE_REFUND_WORKFLOW");

    Object.assign(payment.data, {
      stripe_refund_status: "succeeded",
      stripe_refund_target_status: "partially_refunded",
      stripe_refund_completed_at: AT,
      stripe_refund_payouts_cancelled_at: AT,
      stripe_refund_channex_cancelled_at: AT,
      stripe_refund_ari_handoff_completed_at: AT,
    });
    const mismatched = buildProductionFinancePlan({
      sourceRunId: RUN,
      completedAt: "2026-08-30T00:00:00.000Z",
      rows,
      target: target(),
    });
    expect(mismatched.blockers.map((row) => row.code)).toContain(
      "STRIPE_REFUND_TARGET_STATUS_MISMATCH",
    );

    payment.data["stripe_refund_status"] = "failed";
    const failed = buildProductionFinancePlan({
      sourceRunId: RUN,
      completedAt: "2026-08-30T00:00:00.000Z",
      rows,
      target: target(),
    });
    expect(failed.blockers.map((row) => row.code)).toContain("FINAL_REFUND_WITH_FAILED_WORKFLOW");
  });

  it("never fabricates a completed payout timestamp", () => {
    const rows = sourceRows();
    const payout = rows.find((row) => row.sourceTable === "payouts")!;
    payout.data["status"] = "completed";
    payout.data["completed_at"] = null;
    const plan = buildProductionFinancePlan({
      sourceRunId: RUN,
      completedAt: "2026-08-30T00:00:00.000Z",
      rows,
      target: target(),
    });

    expect(plan.blockers.map((row) => row.code)).toContain("PAYOUT_COMPLETION_EVIDENCE_REQUIRED");
    expect(plan.records.find((row) => row.targetTable === "payouts")!.row["paidAt"]).toBeNull();
  });

  it("blocks ambiguous PaymentIntents and provider payouts without account evidence", () => {
    const rows = sourceRows();
    rows.find((row) => row.sourceTable === "payouts")!.data["stripe_transfer_id"] = "tr_exact";
    const first = rows.find((row) => row.sourceTable === "payments")!;
    rows.push({
      ...first,
      rowOrdinal: 2,
      data: { ...first.data, id: "61000000-0000-4000-8000-000000000001" },
    });
    const plan = buildProductionFinancePlan({
      sourceRunId: RUN,
      completedAt: "2026-08-30T00:00:00.000Z",
      rows,
      target: target(),
    });
    expect(plan.blockers.map((row) => row.code)).toContain("DUPLICATE_PROVIDER_PAYMENT_INTENT_ID");
    expect(plan.dispositions.map((row) => row.reasonCode)).toContain(
      "MISSING_PAYOUT_PROVIDER_ACCOUNT_ID",
    );
    expect(plan.records.find((row) => row.targetTable === "payouts")!.row).toMatchObject({
      propertyProviderAccountId: null,
      organizationProviderAccountId: null,
      providerPayoutId: null,
      payoutMetadata: {
        migrationDisposition: "historical_unbound",
        legacyProviderPayoutReferenceSha256: expect.stringMatching(/^[0-9a-f]{64}$/),
      },
    });
    expect(JSON.stringify(plan)).not.toContain("tr_exact");
  });

  it("blocks a Stripe account reference shared across properties", () => {
    const hotelTwo = "11000000-0000-4000-8000-000000000001";
    const propertyTwo = "21000000-0000-4000-8000-000000000001";
    const organizationTwo = "31000000-0000-4000-8000-000000000002";
    const bookingTwo = "41000000-0000-4000-8000-000000000001";
    const targetBookingTwo = "51000000-0000-4000-8000-000000000001";
    const paymentTwo = "61000000-0000-4000-8000-000000000001";
    const rows = sourceRows().filter((row) => row.sourceTable !== "payouts");
    const bookingHotel = rows.find((row) => row.sourceTable === "booking_hotels")!;
    const settings = rows.find((row) => row.sourceTable === "hotel_payment_settings")!;
    const booking = rows.find((row) => row.sourceTable === "bookings")!;
    const payment = rows.find((row) => row.sourceTable === "payments")!;
    payment.data["stripe_account_id"] = "acct_shared";
    rows.push(
      { ...bookingHotel, rowOrdinal: 2, data: { ...bookingHotel.data, id: hotelTwo } },
      {
        ...settings,
        rowOrdinal: 2,
        data: {
          ...settings.data,
          id: "b1000000-0000-4000-8000-000000000001",
          hotel_id: hotelTwo,
          stripe_connect_account_id: "acct_second",
        },
      },
      {
        ...booking,
        rowOrdinal: 2,
        data: { ...booking.data, id: bookingTwo, hotel_id: hotelTwo },
      },
      {
        ...payment,
        rowOrdinal: 2,
        data: {
          ...payment.data,
          id: paymentTwo,
          booking_id: bookingTwo,
          stripe_payment_intent_id: "pi_shared_second",
        },
      },
    );
    const state = target();
    state.propertyLinks.push(
      { ...state.propertyLinks[0]!, sourceId: hotelTwo, propertyId: propertyTwo },
      { ...state.propertyLinks[1]!, sourceId: hotelTwo, propertyId: propertyTwo },
    );
    state.resourceLinks.push(
      {
        ...state.resourceLinks[0]!,
        organizationId: organizationTwo,
        resourceId: hotelTwo,
      },
      {
        ...state.resourceLinks[1]!,
        organizationId: organizationTwo,
        resourceId: hotelTwo,
      },
    );
    state.guestBookings.push({
      id: targetBookingTwo,
      propertyId: propertyTwo,
      sourceBookingId: bookingTwo,
      currency: "EUR",
    });

    const plan = buildProductionFinancePlan({
      sourceRunId: RUN,
      completedAt: "2026-08-30T00:00:00.000Z",
      rows,
      target: state,
    });

    expect(plan.blockers.map((row) => row.code)).toContain(
      "SHARED_PAYMENT_PROVIDER_ACCOUNT_REFERENCE",
    );
    expect(
      plan.records
        .filter((row) => row.targetTable === "payments")
        .map((row) => row.row["providerAccountId"]),
    ).toEqual([null, null]);
  });
});

function target(): ProductionFinanceTargetState {
  return {
    propertyLinks: [
      {
        sourceSystem: "booking",
        sourceTable: "booking_hotels",
        sourceId: HOTEL,
        propertyId: PROPERTY,
        relationship: "canonical_input",
        status: "active",
        migrationRunId: RUN,
      },
      {
        sourceSystem: "pms",
        sourceTable: "hotels",
        sourceId: HOTEL,
        propertyId: PROPERTY,
        relationship: "operational_input",
        status: "active",
        migrationRunId: RUN,
      },
    ],
    resourceLinks: [
      {
        organizationId: ORGANIZATION,
        product: "booking",
        resourceType: "booking_hotel",
        resourceId: HOTEL,
        relationship: "owner",
        status: "active",
      },
      {
        organizationId: ORGANIZATION,
        product: "pms",
        resourceType: "pms_hotel",
        resourceId: HOTEL,
        relationship: "operator",
        status: "active",
      },
    ],
    guestBookings: [
      { id: TARGET_BOOKING, propertyId: PROPERTY, sourceBookingId: BOOKING, currency: "EUR" },
    ],
    userIds: [ADMIN],
    records: [],
    provenance: [],
  };
}

function sourceRows(): IdentitySourceRow[] {
  return [
    source("booking", "booking_hotels", {
      id: HOTEL,
      currency: "EUR",
      billing_active_plan: "commission",
      billing_commission_rate: "5.0000",
      booking_engine_fee_pct: "5.00",
      channel_manager_fee_pct: "3.00",
      affiliate_platform_fee_pct: "2.00",
      fixed_base_fee: "30.00",
      fixed_rooms_included: 1,
      fixed_per_extra_room_fee: "5.00",
      payout_account_holder: "",
      payout_iban: "",
      payout_bank_name: "",
      payout_swift: "",
      payout_account_number: "",
      online_card_payment: true,
      pay_at_property_enabled: true,
      pay_at_hotel_methods: ["cash", "card"],
      bank_transfer: false,
      paypal_enabled: false,
      paypal_email: "",
      created_at: AT,
      updated_at: AT,
    }),
    source("booking", "commission_rate_changes", {
      id: CHANGE,
      hotel_id: HOTEL,
      admin_user_id: ADMIN,
      old_value: "4.0000",
      new_value: "5.0000",
      note: "reviewed",
      changed_at: AT,
    }),
    source("pms", "hotel_payment_settings", {
      id: "b0000000-0000-4000-8000-000000000001",
      hotel_id: HOTEL,
      payment_provider: "stripe",
      stripe_connect_account_id: "acct_exact",
      stripe_connect_onboarded: true,
      online_card_payment: true,
      pay_at_property_enabled: true,
      bank_transfer: false,
      xendit_payments_enabled: false,
      stripe_billing_customer_id: null,
      stripe_billing_checkout_session_id: null,
      stripe_billing_subscription_id: null,
      stripe_billing_status: null,
      stripe_billing_current_period_end: null,
      stripe_billing_cancel_at_period_end: false,
      stripe_billing_room_count: null,
      stripe_billing_amount_cents: null,
      stripe_billing_price_dirty: false,
      created_at: AT,
      updated_at: AT,
    }),
    source("pms", "bookings", {
      id: BOOKING,
      hotel_id: HOTEL,
      created_at: AT,
      updated_at: AT,
    }),
    source("pms", "payments", {
      id: PAYMENT,
      booking_id: BOOKING,
      amount: "123.45",
      currency: "EUR",
      status: "captured",
      payment_method: "card",
      payment_purpose: "booking",
      stripe_application_fee_amount: "3.45",
      stripe_platform_fee_amount: "2.00",
      stripe_affiliate_commission_amount: "1.45",
      refund_amount: null,
      stripe_payment_intent_id: "pi_exact",
      stripe_account_id: "acct_exact",
      xendit_invoice_id: null,
      reference: "payment-ref",
      card_brand: "visa",
      card_last_four: "4242",
      stripe_refund_id: null,
      stripe_refund_status: null,
      captured_at: AT,
      created_at: AT,
      updated_at: AT,
    }),
    source("pms", "payouts", {
      id: PAYOUT,
      booking_id: BOOKING,
      recipient_type: "hotel",
      recipient_id: HOTEL,
      amount: "100.00",
      currency: "EUR",
      status: "scheduled",
      stripe_transfer_id: null,
      xendit_payout_id: null,
      scheduled_for: AT,
      completed_at: null,
      retry_count: 0,
      last_error: null,
      payment_method: "bank",
      external_reference: null,
      notes: null,
      paid_by_user_id: null,
      created_at: AT,
      updated_at: AT,
    }),
  ];
}

function source(
  sourceDatabase: "booking" | "pms",
  sourceTable: string,
  data: Record<string, unknown>,
): IdentitySourceRow {
  return { sourceDatabase, sourceTable, rowOrdinal: 1, data };
}
