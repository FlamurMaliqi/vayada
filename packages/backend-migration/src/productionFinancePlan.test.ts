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
    expect(plan.parity.sourcePaymentAmountsByCurrencyStatusOwner).toEqual({
      [`EUR:stripe:paid:${ORGANIZATION}`]: "123.45",
    });
    expect(plan.parity.targetPaymentAmountsByCurrencyStatusOwner).toEqual(
      plan.parity.sourcePaymentAmountsByCurrencyStatusOwner,
    );
    expect(plan.parity.sourcePaymentCountsByCurrencyStatusOwner).toEqual({
      [`EUR:stripe:paid:${ORGANIZATION}`]: 1,
    });
    expect(plan.parity.targetPaymentCountsByCurrencyStatusOwner).toEqual(
      plan.parity.sourcePaymentCountsByCurrencyStatusOwner,
    );
    expect(plan.parity.sourcePaymentFeesByCurrencyStatusOwner).toEqual({
      [`EUR:stripe:paid:${ORGANIZATION}`]: "3.45",
    });
    expect(plan.parity.targetPaymentFeesByCurrencyStatusOwner).toEqual(
      plan.parity.sourcePaymentFeesByCurrencyStatusOwner,
    );
    expect(plan.parity.sourcePaymentNetByCurrencyStatusOwner).toEqual({
      [`EUR:stripe:paid:${ORGANIZATION}`]: "120.00",
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
    });
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
    expect(plan.blockers.map((row) => row.code)).toContain(
      "SENSITIVE_PAYOUT_DESTINATION_REENTRY_REQUIRED",
    );
    expect(plan.blockers.map((row) => row.code)).toContain("PAYPAL_DESTINATION_REENTRY_REQUIRED");
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
    expect(plan.blockers.map((row) => row.code)).toContain(
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
    expect(plan.blockers.map((row) => row.code)).toContain("INVALID_FINANCE_SOURCE_ROW");
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
    expect(plan.blockers.map((row) => row.code)).toContain("MISSING_PAYMENT_PROVIDER_ACCOUNT_ID");
    expect(plan.blockers.map((row) => row.code)).toContain(
      "FINANCE_PAYMENT_MONETARY_PARITY_MISMATCH",
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

  it("blocks unsupported currencies and invalid fee allocations", () => {
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
    expect(plan.blockers.map((row) => row.code)).toContain("INVALID_FINANCE_SOURCE_ROW");
    expect(plan.blockers.map((row) => row.code)).toContain("INVALID_PAYMENT_FEE_ALLOCATION");
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
    expect(plan.blockers.map((row) => row.code)).toContain("INVALID_BOOKING_FINANCE_ALLOCATION");
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

    expect(plan.blockers.map((row) => row.code)).toEqual(
      expect.arrayContaining([
        "FIXED_PLAN_PROVIDER_REBIND_REQUIRED",
        "BILLING_PLAN_PROVIDER_STATE_DISAGREEMENT",
      ]),
    );
    expect(
      plan.records.find((row) => row.targetTable === "billing_entitlements")!.row["billingStatus"],
    ).toBe("suspended");
  });

  it("maps only the runtime-supported fixed plan contract", () => {
    const rows = sourceRows().filter((row) => row.sourceTable !== "payouts");
    const hotel = rows.find((row) => row.sourceTable === "booking_hotels")!;
    hotel.data["billing_active_plan"] = "fixed";
    const settings = rows.find((row) => row.sourceTable === "hotel_payment_settings")!;
    Object.assign(settings.data, {
      stripe_billing_customer_id: "cus_exact",
      stripe_billing_subscription_id: "sub_exact",
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
    expect(plan.blockers.map((row) => row.code)).toContain("FIXED_PLAN_PROVIDER_REBIND_REQUIRED");
    expect(plan.records.find((row) => row.targetTable === "commission_rules")!.row).toMatchObject({
      percentageRate: "5",
      status: "active",
    });
    expect(
      plan.records.find((row) => row.targetTable === "billing_entitlements")!.row[
        "billingCurrency"
      ],
    ).toBe("EUR");
    expect(
      plan.records.find((row) => row.targetTable === "billing_entitlements")!.row["billingStatus"],
    ).toBe("suspended");

    settings.data["stripe_billing_price_dirty"] = true;
    const dirty = buildProductionFinancePlan({
      sourceRunId: RUN,
      completedAt: "2026-08-30T00:00:00.000Z",
      rows,
      target: target(),
    });
    expect(dirty.blockers.map((row) => row.code)).toContain("FIXED_PLAN_BILLING_PRICE_DIRTY");
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
    expect(negative.blockers.map((row) => row.code)).toContain(
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
    expect(mismatched.blockers.map((row) => row.code)).toContain(
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
    expect(blocked.blockers.map((row) => row.code)).toContain("NONCANONICAL_FIXED_PLAN_PRICING");
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
    expect(plan.blockers.map((row) => row.code)).toContain("PAYMENT_SETTINGS_SOURCE_DISAGREEMENT");
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
    expect(plan.blockers.map((row) => row.code)).toContain("MISSING_PAYOUT_PROVIDER_ACCOUNT_ID");
    expect(plan.records.find((row) => row.targetTable === "payouts")!.row).toMatchObject({
      propertyProviderAccountId: null,
      organizationProviderAccountId: null,
    });
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
    identityEntitlements: [],
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
