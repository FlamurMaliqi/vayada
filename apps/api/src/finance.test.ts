import {
  createFakeVerifier,
  type IdentityRepository,
  type PermissionKey,
  type ProductEntitlement,
  type VerifiedSession,
} from "@vayada/backend-auth";
import { injectJson } from "@vayada/backend-test";
import type {
  CancellationPolicy,
  FinanceAffiliatePayoutSettingsPatchCommand,
  FinanceAffiliatePayoutSettingsPatchResult,
  FinanceAffiliatePayoutSettingsReadModel,
  FinanceCommandMeta,
  FinanceFinancialSummary,
  FinanceInvoiceDetail,
  FinanceInvoiceListItem,
  FinanceInvoiceListQuery,
  FinanceInvoicePayment,
  FinanceInvoiceStatusCounts,
  FinanceManualPaymentRecordCommand,
  FinanceManualPaymentRecordResult,
  FinancePaymentLedgerItem,
  FinancePaymentLedgerQuery,
  FinancePaymentSettingsPatchCommand,
  FinancePaymentSettingsPatchResult,
  FinancePaymentSettingsReadModel,
  FinancePayout,
  FinancePayoutListQuery,
  FinancePropertyPayoutDispatchCommand,
  FinancePropertyPayoutDispatchResult,
  FinanceReconciliationItem,
  FinanceReconciliationViewKind,
  FinanceReconciliationViewQuery,
  FinancePropertyReadRepository,
  FinanceProviderAccountCommandResult,
  FinanceStripeConnectProvider,
  CreateStripeProviderAccountCommand,
  IssueStripeOnboardingLinkCommand,
  FinanceXenditPayoutReconciliationCommand,
  FinanceXenditPayoutReconciliationResult,
} from "@vayada/domain-finance";
import { createHash } from "node:crypto";
import type { PublicBookabilityProfileProjection } from "@vayada/domain-distribution";
import { readFileSync } from "node:fs";
import type { QueryResultRow } from "pg";
import { afterEach, describe, expect, it } from "vitest";

import { buildApp } from "./app.js";
import type { PublicHotelProfileRepository } from "./routes/aiHotels.js";
import {
  createTargetFinancePropertySettingsRepository,
  type FinanceXenditBankValidator,
  type FinancePublicHotelPropertyResolver,
} from "./routes/finance.js";

const propertyId = "f3000000-0000-0000-0000-000000000686";
const affiliateId = "affiliate_finance_partner_686";
const affiliateOrganizationId = "f2000000-0000-0000-0000-000000000686";
const futureExpiry = Math.floor(Date.now() / 1000) + 3600;

const financeContractCases = JSON.parse(
  readFileSync(
    new URL("../../../engineering/fixtures/finance-route-contracts/cases.json", import.meta.url),
    "utf8",
  ),
) as {
  cases: Array<{
    caseId: string;
    request: {
      path: string;
      method?: string;
      query?: Record<string, string | number>;
      body?: Record<string, unknown>;
    };
    expected: {
      status: number;
      itemCount?: number;
      stableOrdering?: string;
      mustInclude?: string[];
      mustExclude?: string[];
      mustNotWrite?: string[];
      errorCode?: string;
      providerAccountId?: string;
      legacyDisposition?: string;
      rollbackRule?: string;
      job?: { jobType: string; idempotencyKey: string };
      commandMeta?: { sideEffects?: string[] };
      enums?: Record<string, string[]>;
    };
  }>;
};

const session: VerifiedSession = {
  workosUserId: "workos_finance_user",
  workosOrgId: "workos_finance_org",
  sessionId: "session_finance",
  expiresAt: futureExpiry,
};

const paymentSettings: FinancePaymentSettingsReadModel = {
  propertyId,
  paymentsEnabled: true,
  paymentProvider: "stripe",
  acceptedMethods: ["card", "pay_at_property", "bank_transfer"],
  defaultCurrency: "EUR",
  supportedCurrencies: ["EUR"],
  depositPolicy: {
    depositPercent: 25,
    summary: "25% deposit due at checkout.",
  },
  refundPolicy: {
    freeCancellationDays: 7,
    partialRefundPercent: 50,
    refundMethod: "original_payment",
    appliesTo: "direct_booking",
  },
  taxPolicy: { taxIncluded: true },
  statementDescriptor: "ALPENROSE",
  requiresManualReview: false,
  providerAccount: {
    providerAccountId: "acct_target_alpenrose",
    provider: "stripe",
    status: "active",
    onboardingStatus: "completed",
    chargesEnabled: true,
    payoutsEnabled: true,
    capabilities: ["card_payments", "transfers"],
  },
  sourceFreshness: {
    finance: "target",
    status: "fresh",
  },
  updatedAt: "2026-06-12T10:00:00.000Z",
};

const cancellationPolicy: CancellationPolicy = {
  freeCancellationDays: 7,
  partialRefundPercent: 50,
  refundMethod: "original_payment",
  appliesTo: "direct_booking",
  updatedAt: "2026-06-12T10:00:00.000Z",
};

const affiliatePayoutSettings: FinanceAffiliatePayoutSettingsReadModel = {
  affiliateId,
  marketplaceOrganizationId: "a6000000-0000-0000-0000-000000000686",
  payoutsEnabled: true,
  payoutProvider: "stripe",
  payoutCurrency: "EUR",
  payoutSchedule: "monthly",
  payoutThresholdAmount: null,
  providerAccount: {
    providerAccountId: "acct_affiliate_target",
    provider: "stripe",
    status: "active",
    onboardingStatus: "completed",
    payoutsEnabled: true,
  },
  sourceFreshness: {
    finance: "target",
    status: "fresh",
  },
  updatedAt: "2026-06-12T10:00:00.000Z",
};

const sourceFreshness = {
  finance: {
    status: "fresh",
    projectedAt: "2026-06-12T10:00:00.000Z",
  },
};

const invoicePayments: FinanceInvoicePayment[] = [
  {
    paymentId: "pay_manual_002",
    method: "cash",
    methodLabel: "Cash",
    amount: "100.00",
    currency: "EUR",
    reference: "front desk receipt 8814",
    status: "paid",
    recordedAt: "2026-06-12T10:08:00.000Z",
  },
  {
    paymentId: "pay_manual_001",
    method: "cash",
    methodLabel: "Cash",
    amount: "250.00",
    currency: "EUR",
    reference: "front desk receipt 8812",
    status: "paid",
    recordedAt: "2026-06-12T10:05:00.000Z",
  },
];

const invoiceListItems: FinanceInvoiceListItem[] = [
  {
    invoiceId: "inv_2026_abcd",
    invoiceNumber: "INV-2026-0002",
    guestBookingId: "f6000000-0000-0000-0000-000000000686",
    bookingReference: "B-FIN-686",
    guest: { displayName: "Fi Guest", email: "finance.guest@example.test" },
    stay: {
      checkIn: "2026-08-01",
      checkOut: "2026-08-05",
      roomName: "Alpine Suite",
      roomNumber: "201",
    },
    currency: "EUR",
    totalAmount: "1200.00",
    amountPaid: "350.00",
    balanceDue: "850.00",
    status: "partial",
    issuedAt: "2026-06-12T10:00:00.000Z",
  },
  {
    invoiceId: "inv_2026_wxyz",
    invoiceNumber: "INV-2026-0001",
    guestBookingId: "f6000000-0000-0000-0000-000000000687",
    bookingReference: "B-FIN-687",
    guest: { displayName: "Ana Ledger", email: "ledger@example.test" },
    stay: {
      checkIn: "2026-08-10",
      checkOut: "2026-08-12",
      roomName: "Garden Room",
      roomNumber: "102",
    },
    currency: "EUR",
    totalAmount: "500.00",
    amountPaid: "200.00",
    balanceDue: "300.00",
    status: "partial",
    issuedAt: "2026-06-12T09:00:00.000Z",
  },
];

const invoiceDetails: FinanceInvoiceDetail[] = [
  {
    ...invoiceListItems[0]!,
    guest: {
      ...invoiceListItems[0]!.guest,
      phone: "+15555550123",
    },
    nights: 4,
    charges: [{ description: "Stay", detail: "4 nights in Alpine Suite", amount: "1200.00" }],
    payments: invoicePayments,
    subtotal: "1200.00",
  },
  {
    ...invoiceListItems[1]!,
    guest: {
      ...invoiceListItems[1]!.guest,
      phone: null,
    },
    nights: 2,
    charges: [{ description: "Stay", detail: "2 nights in Garden Room", amount: "500.00" }],
    payments: [invoicePayments[1]!],
    subtotal: "500.00",
  },
];

const paymentLedgerItems: FinancePaymentLedgerItem[] = [
  {
    ...invoicePayments[0]!,
    invoiceId: "inv_2026_abcd",
    invoiceNumber: "INV-2026-0002",
    guestBookingId: "f6000000-0000-0000-0000-000000000686",
    bookingReference: "B-FIN-686",
    checkoutChargeId: "charge_checkout_002",
    provider: "manual",
    providerStatus: "paid",
    reconciliationStatus: "matched",
  },
  {
    ...invoicePayments[1]!,
    invoiceId: "inv_2026_abcd",
    invoiceNumber: "INV-2026-0002",
    guestBookingId: "f6000000-0000-0000-0000-000000000686",
    bookingReference: "B-FIN-686",
    checkoutChargeId: "charge_checkout_001",
    provider: "manual",
    providerStatus: "paid",
    reconciliationStatus: "matched",
  },
];

const payoutItems: FinancePayout[] = [
  {
    payoutId: "payout_2026_abcd",
    ownerScope: "property",
    propertyId,
    organizationId: null,
    relatedPropertyId: null,
    guestBookingId: invoiceListItems[0]!.guestBookingId,
    paymentId: paymentLedgerItems[0]!.paymentId,
    payoutStatus: "failed",
    amount: "1000.00",
    feeAmount: "25.00",
    netAmount: "975.00",
    currency: "EUR",
    provider: "stripe",
    providerPayoutId: "po_stripe_failed_686",
    scheduledAt: "2026-06-12T11:00:00.000Z",
    paidAt: null,
    failedAt: "2026-06-12T11:30:00.000Z",
    failureCode: "bank_account_restricted",
    retryCount: 2,
  },
];

const affiliatePayoutItems: FinancePayout[] = [
  {
    payoutId: "affiliate_payout_2026_06",
    ownerScope: "organization",
    propertyId: null,
    organizationId: "a6000000-0000-0000-0000-000000000686",
    relatedPropertyId: propertyId,
    guestBookingId: invoiceListItems[0]!.guestBookingId,
    paymentId: paymentLedgerItems[0]!.paymentId,
    payoutStatus: "scheduled",
    amount: "350.00",
    feeAmount: "0.00",
    netAmount: "350.00",
    currency: "EUR",
    provider: "stripe",
    providerPayoutId: null,
    scheduledAt: "2026-06-30T09:00:00.000Z",
    paidAt: null,
    failedAt: null,
    failureCode: null,
    retryCount: 0,
  },
];

const reconciliationSourceFreshness = {
  providerReceiptsFreshAt: "2026-06-12T11:32:00.000Z",
  jobsFreshAt: "2026-06-12T11:35:00.000Z",
  deadLettersFreshAt: "2026-06-12T11:36:00.000Z",
};

const reconciliationItems: Record<FinanceReconciliationViewKind, FinanceReconciliationItem[]> = {
  payments: [
    {
      subjectId: "pay_card_needs_review_686",
      subjectType: "payment",
      provider: "stripe",
      financeStatus: "pending",
      providerStatus: "requires_capture",
      latestReceiptStatus: "stale",
      jobStatus: "failed",
      recommendedAction: "enqueue_reconcile",
      lastReceiptAt: "2026-06-12T11:20:00.000Z",
      lastJobAt: "2026-06-12T11:25:00.000Z",
    },
  ],
  payouts: [
    {
      subjectId: payoutItems[0]!.payoutId,
      subjectType: "payout",
      provider: "stripe",
      financeStatus: "failed",
      providerStatus: "failed",
      latestReceiptStatus: "dead_lettered",
      jobStatus: "dead_lettered",
      recommendedAction: "manual_review",
      lastReceiptAt: "2026-06-12T11:32:00.000Z",
      lastJobAt: "2026-06-12T11:35:00.000Z",
    },
  ],
  "provider-accounts": [
    {
      subjectId: "acct_target_alpenrose",
      subjectType: "provider_account",
      provider: "stripe",
      financeStatus: "restricted",
      providerStatus: "currently_due",
      latestReceiptStatus: "stale",
      jobStatus: "queued",
      recommendedAction: "refresh_provider_state",
      lastReceiptAt: "2026-06-12T11:10:00.000Z",
      lastJobAt: "2026-06-12T11:15:00.000Z",
    },
  ],
};

const financialSummary: FinanceFinancialSummary = {
  currency: "EUR",
  periodStart: "2026-06-01",
  periodEnd: "2026-06-30",
  grossPaymentAmount: "1700.00",
  netPaymentAmount: "1650.00",
  payoutAmount: "1400.00",
  commissionAmount: "50.00",
  outstandingBalanceAmount: "1150.00",
  paymentCount: 2,
  payoutCount: 1,
  failedPaymentCount: 0,
  invoiceCounts: {
    draft: 0,
    sent: 0,
    paid: 0,
    partial: 2,
    overdue: 0,
    voided: 0,
  },
  paymentCounts: {
    requires_action: 0,
    authorized: 0,
    pending: 0,
    paid: 2,
    partially_refunded: 0,
    refunded: 0,
    failed: 0,
    canceled: 0,
    disputed: 0,
  },
  projectedAt: "2026-06-12T10:00:00.000Z",
};

let app: ReturnType<typeof buildApp> | null = null;

afterEach(async () => {
  await app?.close();
  app = null;
});

describe("finance route contracts", () => {
  it("passes F1b payment-settings read and public projection fixture cases in target mode", async () => {
    app = buildFinanceApp();

    for (const caseId of ["payment-settings-read", "public-payment-capability-projection"]) {
      const contractCase = financeContractCases.cases.find(
        (candidate) => candidate.caseId === caseId,
      );
      expect(contractCase, caseId).toBeDefined();

      const response = await injectJson<Record<string, unknown>>(app, {
        method: "GET",
        url: contractCase!.request.path,
        headers: caseId === "payment-settings-read" ? { authorization: "Bearer valid-token" } : {},
      });

      expect(response.statusCode, caseId).toBe(contractCase!.expected.status);
      assertIncludes(response.body, contractCase!.expected.mustInclude ?? [], caseId);
      assertExcludes(response.body, contractCase!.expected.mustExclude ?? [], caseId);
      assertEnums(response.body, contractCase!.expected.enums ?? {}, caseId);
    }
  });

  it("leaves obsolete PMS Financials routes unregistered", async () => {
    app = buildFinanceApp({ permissions: financeManagePermissions() });
    const prefix = `/api/finance/properties/${propertyId}`;
    const requests = [
      injectJson<Record<string, unknown>>(app, { method: "GET", url: `${prefix}/summary` }),
      injectJson<Record<string, unknown>>(app, { method: "GET", url: `${prefix}/invoices` }),
      injectJson<Record<string, unknown>>(app, {
        method: "GET",
        url: `${prefix}/invoices/export.csv`,
      }),
      injectJson<Record<string, unknown>>(app, {
        method: "GET",
        url: `${prefix}/invoices/inv_2026_abcd`,
      }),
      injectJson<Record<string, unknown>>(app, {
        method: "POST",
        url: `${prefix}/invoices/inv_2026_abcd/payments`,
      }),
      injectJson<Record<string, unknown>>(app, { method: "GET", url: `${prefix}/payments` }),
    ];

    for (const response of await Promise.all(requests)) {
      expect(response.statusCode).toBe(404);
      expect(response.body).toMatchObject({ statusCode: 404, error: "Not Found" });
      expect(response.body.message).toMatch(/^Route (GET|POST):\/api\/finance\/.+ not found$/);
    }
  });

  it("passes F1e payout and reconciliation fixture cases in target mode", async () => {
    app = buildFinanceApp();

    for (const caseId of [
      "payout-list-read",
      "payment-reconciliation-view",
      "payout-reconciliation-view",
      "provider-account-reconciliation-view",
    ]) {
      const contractCase = financeContractCases.cases.find(
        (candidate) => candidate.caseId === caseId,
      );
      expect(contractCase, caseId).toBeDefined();

      const response = await injectJson<Record<string, unknown>>(app, {
        method: "GET",
        url: contractCase!.request.path,
        query: queryStrings(contractCase!.request.query),
        headers: { authorization: "Bearer valid-token" },
      });

      expect(response.statusCode, caseId).toBe(contractCase!.expected.status);
      if (contractCase!.expected.itemCount !== undefined) {
        const list = caseId === "payout-list-read" ? response.body.payouts : response.body.items;
        expect(list, caseId).toHaveLength(contractCase!.expected.itemCount);
      }
      assertIncludes(response.body, contractCase!.expected.mustInclude ?? [], caseId);
      assertExcludes(response.body, contractCase!.expected.mustExclude ?? [], caseId);
      expect(JSON.stringify(response.body), caseId).not.toMatch(
        /providerPayloadRaw|accountNumber|accountHolderName|sensitiveDestinationRef|stripeSecretKey|xenditApiKey|processorSecret|guestEmail/,
      );
    }
  });

  it("passes F1f Stripe property and affiliate onboarding fixture cases without duplicate accounts", async () => {
    const propertyRepository = stripeProviderAccountRepository();
    app = buildFinanceApp({
      repository: propertyRepository,
      permissions: financeManagePermissions(),
    });
    const propertyCase = financeContractCases.cases.find(
      (candidate) => candidate.caseId === "stripe-property-onboarding-idempotent",
    );
    expect(propertyCase).toBeDefined();

    const first = await injectJson<Record<string, unknown>>(app, {
      method: "POST",
      url: propertyCase!.request.path,
      payload: propertyCase!.request.body,
      headers: { authorization: "Bearer valid-token" },
    });
    const replay = await injectJson<Record<string, unknown>>(app, {
      method: "POST",
      url: propertyCase!.request.path,
      payload: propertyCase!.request.body,
      headers: { authorization: "Bearer valid-token" },
    });

    expect(first.statusCode).toBe(propertyCase!.expected.status);
    expect(replay.statusCode).toBe(propertyCase!.expected.status);
    expect(first.body.providerAccountId).toBe(propertyCase!.expected.providerAccountId);
    expect(replay.body.providerAccountId).toBe(first.body.providerAccountId);
    expect(readContractPath(replay.body, "commandMeta.idempotencyKey")).toBe(
      "finance-stripe-property-f300686",
    );
    assertIncludes(first.body, propertyCase!.expected.mustInclude ?? [], propertyCase!.caseId);
    assertExcludes(first.body, propertyCase!.expected.mustExclude ?? [], propertyCase!.caseId);
    expect(propertyRepository.providerCreateCount).toBe(1);
    await app.close();
    app = null;

    const affiliateRepository = stripeProviderAccountRepository();
    app = buildAffiliateFinanceApp({ repository: affiliateRepository });
    const affiliateCase = financeContractCases.cases.find(
      (candidate) => candidate.caseId === "stripe-affiliate-onboarding-boundary",
    );
    expect(affiliateCase).toBeDefined();

    const affiliateResponse = await injectJson<Record<string, unknown>>(app, {
      method: "POST",
      url: affiliateCase!.request.path,
      payload: affiliateCase!.request.body,
      headers: { authorization: "Bearer valid-token" },
    });

    expect(affiliateResponse.statusCode).toBe(affiliateCase!.expected.status);
    expect(affiliateResponse.body.providerAccountId).toBe(
      affiliateCase!.expected.providerAccountId,
    );
    expect(JSON.stringify(affiliateResponse.body)).not.toMatch(
      /referralCode|booking_web_affiliates|stripeSecretKey/,
    );
    expect(affiliateRepository.providerCreateCount).toBe(1);
  });

  it("preserves the VAY-774 affiliate onboarding-link facade shape", async () => {
    const repository = stripeProviderAccountRepository();
    repository.seedAffiliateProviderAccount();
    app = buildAffiliateFinanceApp({ repository });

    const response = await injectJson<Record<string, unknown>>(app, {
      method: "POST",
      url: `/api/finance/affiliates/${affiliateId}/provider-accounts/f7100000-0000-0000-0000-000000000686/onboarding-link`,
      payload: {
        commandId: "cmd-stripe-affiliate-link-001",
        idempotencyKey: "finance-stripe-affiliate-link-686",
      },
      headers: { authorization: "Bearer valid-token" },
    });

    expect(response.statusCode).toBe(200);
    expect(response.body).toEqual({
      onboardingUrl: "https://connect.stripe.test/onboard/acct_affiliate_686/2",
    });
  });

  it("compensates when Stripe succeeds but the target provider-account write fails", async () => {
    const provider = fakeStripeConnectProvider();
    const target = targetStripeProviderAccountPool({ failInsert: true });
    const repository = createTargetFinancePropertySettingsRepository({
      connectionString: "postgresql://finance-target",
      pool: target.pool,
      stripeConnectProvider: provider,
    });

    const result = await repository.createStripeProviderAccount!(
      stripePropertyTargetCommand({
        idempotencyKey: "finance-stripe-property-compensation",
      }),
    );

    expect(result).toMatchObject({
      ok: false,
      statusCode: 500,
      code: "write_unavailable",
    });
    expect(provider.createAccountCount).toBe(1);
    expect(provider.compensationCount).toBe(1);
    expect(target.requiredCall("UPDATE platform.idempotency_keys").values?.[1]).toEqual(
      expect.stringContaining("compensation"),
    );
  });

  it("persists target Stripe provider accounts by owner scope and replays without duplicate provider accounts", async () => {
    const provider = fakeStripeConnectProvider();
    const target = targetStripeProviderAccountPool();
    const repository = createTargetFinancePropertySettingsRepository({
      connectionString: "postgresql://finance-target",
      pool: target.pool,
      stripeConnectProvider: provider,
    });

    const first = await repository.createStripeProviderAccount!(stripePropertyTargetCommand());
    target.existingAccount = {
      providerAccountId: first.ok ? first.response.providerAccountId : "",
      providerAccountRef: first.ok ? first.response.providerAccountRef : "",
      status: "setup_incomplete",
      onboardingStatus: "invited",
      onboardingUrl: first.ok ? first.response.onboardingUrl : null,
    };
    const replay = await repository.createStripeProviderAccount!(stripePropertyTargetCommand());

    expect(first.ok).toBe(true);
    expect(replay.ok).toBe(true);
    if (!first.ok || !replay.ok) throw new Error("Unexpected Stripe provider-account failure");
    expect(replay.response.providerAccountId).toBe(first.response.providerAccountId);
    expect(provider.createAccountCount).toBe(1);

    const idempotencyInsert = target.requiredCall("INSERT INTO platform.idempotency_keys");
    expect(idempotencyInsert.text).toMatch(/'finance'/);
    expect(idempotencyInsert.values?.[3]).toBe("property");
    const accountInsert = target.requiredCall("INSERT INTO finance.payment_provider_accounts");
    expect(accountInsert.values?.[0]).toBe(propertyId);
    expect(accountInsert.values?.[1]).toBeNull();
    expect(accountInsert.values?.[2]).toBe("property");
    expect(target.requiredCall("UPDATE finance.payment_settings").values).toEqual([
      propertyId,
      "stripe",
      first.response.providerAccountId,
      `settings-choice:${propertyId}:stripe`,
    ]);
  });

  it("issues target Stripe onboarding links when the client sends the provider account ref", async () => {
    const provider = fakeStripeConnectProvider();
    const target = targetStripeProviderAccountPool();
    const repository = createTargetFinancePropertySettingsRepository({
      connectionString: "postgresql://finance-target",
      pool: target.pool,
      stripeConnectProvider: provider,
    });
    target.existingAccount = {
      providerAccountId: "f7000000-0000-0000-0000-000000000686",
      providerAccountRef: "acct_target_property_686",
      status: "setup_incomplete",
      onboardingStatus: "invited",
      onboardingUrl: "https://connect.stripe.test/onboard/acct_target_property_686/1",
    };

    const result = await repository.issueStripeOnboardingLink!(
      stripePropertyOnboardingLinkTargetCommand("acct_target_property_686"),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("Unexpected Stripe onboarding-link failure");
    expect(result.response.providerAccountId).toBe("f7000000-0000-0000-0000-000000000686");
    expect(result.response.onboardingUrl).toBe(
      "https://connect.stripe.test/onboard/acct_target_property_686/2",
    );
  });

  it("passes F1i affiliate payout settings and payout ledger fixtures in target mode", async () => {
    app = buildFinanceApp({
      permissions: ["affiliate.payout.manage"],
      entitlements: [affiliatePayoutEntitlement()],
    });

    for (const caseId of [
      "affiliate-payout-settings-read",
      "affiliate-payout-settings-update",
      "affiliate-payout-list-read",
    ]) {
      const contractCase = financeContractCases.cases.find(
        (candidate) => candidate.caseId === caseId,
      );
      expect(contractCase, caseId).toBeDefined();
      const method = (contractCase!.request.method ?? "GET") as "GET" | "PATCH";

      const response = await injectJson<Record<string, unknown>>(app, {
        method,
        url: contractCase!.request.path,
        query: queryStrings(contractCase!.request.query),
        payload: contractCase!.request.body,
        headers: { authorization: "Bearer valid-token" },
      });

      expect(response.statusCode, caseId).toBe(contractCase!.expected.status);
      if (contractCase!.expected.itemCount !== undefined) {
        expect(response.body.payouts, caseId).toHaveLength(contractCase!.expected.itemCount);
      }
      assertIncludes(response.body, contractCase!.expected.mustInclude ?? [], caseId);
      assertExcludes(response.body, contractCase!.expected.mustExclude ?? [], caseId);
      expect(JSON.stringify(response.body), caseId).not.toMatch(
        /referralCode|affiliateProfileEmail|accountNumber|stripeSecretKey|providerSecret|xenditApiKey/,
      );
    }
  });

  it("denies affiliate payout settings without the affiliate resource link", async () => {
    app = buildFinanceApp({
      permissions: ["affiliate.payout.manage"],
      entitlements: [affiliatePayoutEntitlement()],
      linkedAffiliateId: null,
    });

    const response = await injectJson<Record<string, unknown>>(app, {
      method: "GET",
      url: `/api/finance/affiliates/${affiliateId}/payout-settings`,
      headers: { authorization: "Bearer valid-token" },
    });

    expect(response.statusCode).toBe(403);
    expect(response.body.code).toBe("missing_resource_access");
  });

  it("passes the F1g Xendit bank validation fixture without leaking raw bank data", async () => {
    const contractCase = financeContractCases.cases.find(
      (candidate) => candidate.caseId === "xendit-bank-validation",
    );
    expect(contractCase).toBeDefined();
    const validator: FinanceXenditBankValidator = {
      async validateBankAccount(input) {
        expect(input).toMatchObject({
          channelCode: "ID_BCA",
          accountNumber: "1234567890",
          accountHolderName: "Alpenrose Hotel GmbH",
          idempotencyKey: "finance-xendit-bank-validation-f300686",
        });
        return {
          status: "valid",
          accountHolderName: "Alpenrose Hotel GmbH",
          providerReference: "xbi_686",
        };
      },
    };
    app = buildFinanceApp({
      permissions: financeManagePermissions(),
      xenditBankValidator: validator,
    });

    const response = await injectJson<Record<string, unknown>>(app, {
      method: "POST",
      url: contractCase!.request.path,
      payload: contractCase!.request.body,
      headers: { authorization: "Bearer valid-token" },
    });

    expect(response.statusCode).toBe(contractCase!.expected.status);
    assertIncludes(response.body, contractCase!.expected.mustInclude ?? [], contractCase!.caseId);
    assertExcludes(response.body, contractCase!.expected.mustExclude ?? [], contractCase!.caseId);
    expect(response.body).toMatchObject({
      provider: "xendit",
      validation: {
        status: "valid",
        maskedAccountNumber: "******7890",
        accountHolderName: "Alpenrose Hotel GmbH",
      },
      commandMeta: {
        idempotencyKey: "finance-xendit-bank-validation-f300686",
        sideEffects: ["provider_validation", "audit_event"],
        jobs: [],
      },
    });
    expect(JSON.stringify(response.body)).not.toContain("1234567890");
  });

  it("passes the F1g Xendit payout reconciliation enqueue fixture idempotently", async () => {
    const contractCase = financeContractCases.cases.find(
      (candidate) => candidate.caseId === "payout-reconciliation-enqueues-job",
    );
    expect(contractCase).toBeDefined();
    const repository = xenditPayoutReconciliationRepository();
    app = buildFinanceApp({
      repository,
      permissions: financeManagePermissions(),
    });

    const first = await injectJson<Record<string, unknown>>(app, {
      method: "POST",
      url: contractCase!.request.path,
      payload: contractCase!.request.body,
      headers: { authorization: "Bearer valid-token" },
    });
    const replay = await injectJson<Record<string, unknown>>(app, {
      method: "POST",
      url: contractCase!.request.path,
      payload: contractCase!.request.body,
      headers: { authorization: "Bearer valid-token" },
    });

    expect(first.statusCode).toBe(contractCase!.expected.status);
    expect(replay.statusCode).toBe(contractCase!.expected.status);
    assertIncludes(first.body, contractCase!.expected.mustInclude ?? [], contractCase!.caseId);
    expect(first.body).toMatchObject({
      job: contractCase!.expected.job,
      legacyDisposition: contractCase!.expected.legacyDisposition,
      commandMeta: {
        idempotencyKey: "finance-reconcile-xendit-payouts-f300686-2026-06-12",
        sideEffects: ["reconciliation_job", "audit_event"],
        jobs: [{ status: "queued" }],
      },
    });
    expect(replay.body).toMatchObject({
      job: {
        idempotencyKey:
          "finance.reconcile-payout:property:f3000000-0000-0000-0000-000000000686:xendit-manual-2026-06-12:v1",
        status: "idempotent_replay",
      },
      commandMeta: {
        jobs: [{ status: "idempotent_replay" }],
      },
    });
    assertExcludes(first.body, contractCase!.expected.mustNotWrite ?? [], contractCase!.caseId);
    expect(repository.enqueueCount).toBe(1);
  });

  it("passes the F1h property payout dispatch fixture idempotently", async () => {
    const contractCase = financeContractCases.cases.find(
      (candidate) => candidate.caseId === "property-payout-dispatch-enqueues-job",
    );
    expect(contractCase).toBeDefined();
    const repository = propertyPayoutDispatchRepository();
    app = buildFinanceApp({
      repository,
      permissions: financeManagePermissions(),
    });

    const first = await injectJson<Record<string, unknown>>(app, {
      method: "POST",
      url: contractCase!.request.path,
      payload: contractCase!.request.body,
      headers: { authorization: "Bearer valid-token" },
    });
    const replay = await injectJson<Record<string, unknown>>(app, {
      method: "POST",
      url: contractCase!.request.path,
      payload: contractCase!.request.body,
      headers: { authorization: "Bearer valid-token" },
    });

    expect(first.statusCode).toBe(contractCase!.expected.status);
    expect(replay.statusCode).toBe(contractCase!.expected.status);
    assertIncludes(first.body, contractCase!.expected.mustInclude ?? [], contractCase!.caseId);
    expect(first.body).toMatchObject({
      job: contractCase!.expected.job,
      legacyDisposition: contractCase!.expected.legacyDisposition,
      rollbackRule: contractCase!.expected.rollbackRule,
      readiness: {
        reconciliationReady: true,
        legacySchedulerFrozen: true,
        activeLegacyTransferWindow: false,
        existingProviderPayoutId: null,
        blockingReasons: [],
      },
      commandMeta: {
        idempotencyKey: "finance-dispatch-property-payout-686-2026-06-13",
        sideEffects: ["payout_job", "audit_event"],
        jobs: [{ status: "queued" }],
      },
    });
    expect(replay.body).toMatchObject({
      job: {
        idempotencyKey:
          "finance.dispatch-property-payout:property:f3000000-0000-0000-0000-000000000686:payout:payout_2026_abcd:v1",
        status: "idempotent_replay",
      },
      commandMeta: {
        jobs: [{ status: "idempotent_replay" }],
      },
    });
    assertExcludes(first.body, contractCase!.expected.mustNotWrite ?? [], contractCase!.caseId);
    expect(repository.enqueueCount).toBe(1);
  });

  it("blocks property payout dispatch without reconciliation readiness", async () => {
    const repository = propertyPayoutDispatchRepository({
      readiness: {
        reconciliationReady: false,
        blockingReasons: ["reconciliation_not_ready"],
      },
    });
    app = buildFinanceApp({
      repository,
      permissions: financeManagePermissions(),
    });

    const response = await injectJson<Record<string, unknown>>(app, {
      method: "POST",
      url: `/api/finance/properties/${propertyId}/payouts/payout_2026_abcd/dispatch`,
      payload: propertyPayoutDispatchBody(),
      headers: { authorization: "Bearer valid-token" },
    });

    expect(response.statusCode).toBe(409);
    expect(response.body).toMatchObject({
      code: "reconciliation_not_ready",
      category: "conflict",
    });
    expect(repository.enqueueCount).toBe(0);
  });

  it("updates Finance payment settings and replays idempotency keys without duplicate writes", async () => {
    const repository = paymentSettingsWriteRepository();
    app = buildFinanceApp({
      repository,
      permissions: financeManagePermissions(),
    });
    const payload = {
      commandId: "cmd-payment-settings-001",
      idempotencyKey: "finance-payment-settings-f300686-001",
      paymentSettings: {
        paymentsEnabled: true,
        paymentProvider: "xendit",
        acceptedMethods: ["xendit", "bank_transfer"],
        defaultCurrency: "EUR",
        supportedCurrencies: ["EUR"],
        requiresManualReview: false,
      },
    };

    const first = await injectJson<Record<string, unknown>>(app, {
      method: "PATCH",
      url: `/api/finance/properties/${propertyId}/payment-settings`,
      payload,
      headers: { authorization: "Bearer valid-token" },
    });
    const replay = await injectJson<Record<string, unknown>>(app, {
      method: "PATCH",
      url: `/api/finance/properties/${propertyId}/payment-settings`,
      payload,
      headers: { authorization: "Bearer valid-token" },
    });

    expect(first.statusCode).toBe(200);
    expect(replay.statusCode).toBe(200);
    expect(first.body).toMatchObject({
      contractVersion: "finance-route-contracts.v1",
      propertyId,
      paymentSettings: {
        paymentsEnabled: true,
        paymentProvider: "xendit",
        acceptedMethods: ["xendit", "bank_transfer"],
        defaultCurrency: "EUR",
        supportedCurrencies: ["EUR"],
        requiresManualReview: false,
      },
      commandMeta: {
        idempotencyKey: "finance-payment-settings-f300686-001",
        sideEffects: ["audit_event"],
        outboxEvents: [],
        jobs: [],
      },
    });
    expect(replay.body).toMatchObject({
      paymentSettings: first.body.paymentSettings,
      commandMeta: first.body.commandMeta,
    });
    expect(repository.writeCount).toBe(1);
  });

  it("allows Booking owners to update payment settings through the Booking entitlement", async () => {
    const repository = paymentSettingsWriteRepository();
    app = buildFinanceApp({
      repository,
      permissions: ["booking.settings.manage"],
      entitlements: [directBookingFinanceEntitlement()],
    });

    const response = await injectJson<Record<string, unknown>>(app, {
      method: "PATCH",
      url: `/api/finance/properties/${propertyId}/payment-settings`,
      payload: {
        commandId: "cmd-booking-payment-settings-001",
        idempotencyKey: "booking-payment-settings-f300686-001",
        paymentSettings: {
          paymentsEnabled: true,
          paymentProvider: "manual",
          acceptedMethods: ["pay_at_property", "manual_card"],
          defaultCurrency: "EUR",
          supportedCurrencies: ["EUR"],
        },
      },
      headers: { authorization: "Bearer valid-token" },
    });

    expect(response.statusCode).toBe(200);
    expect(repository.writeCount).toBe(1);
  });

  it("rejects Finance payment settings writes without manage permission", async () => {
    app = buildFinanceApp();

    const response = await injectJson<Record<string, unknown>>(app, {
      method: "PATCH",
      url: `/api/finance/properties/${propertyId}/payment-settings`,
      payload: {
        commandId: "cmd-payment-settings-denied",
        idempotencyKey: "finance-payment-settings-denied",
        paymentSettings: {
          paymentsEnabled: true,
        },
      },
      headers: { authorization: "Bearer valid-token" },
    });

    expect(response.statusCode).toBe(403);
    expect(response.body.code).toBe("missing_permission");
  });

  it("validates strict Finance payment settings write payloads before repository writes", async () => {
    const repository = paymentSettingsWriteRepository();
    app = buildFinanceApp({
      repository,
      permissions: financeManagePermissions(),
    });

    const response = await injectJson<Record<string, unknown>>(app, {
      method: "PATCH",
      url: `/api/finance/properties/${propertyId}/payment-settings`,
      payload: {
        commandId: "cmd-payment-settings-invalid",
        idempotencyKey: "finance-payment-settings-invalid",
        paymentSettings: {
          acceptedMethods: ["card", "card"],
        },
      },
      headers: { authorization: "Bearer valid-token" },
    });

    expect(response.statusCode).toBe(400);
    expect(response.body.code).toBe("invalid_payment_method");
    expect(repository.writeCount).toBe(0);

    const nestedPolicyResponse = await injectJson<Record<string, unknown>>(app, {
      method: "PATCH",
      url: `/api/finance/properties/${propertyId}/payment-settings`,
      payload: {
        commandId: "cmd-payment-settings-invalid-policy",
        idempotencyKey: "finance-payment-settings-invalid-policy",
        paymentSettings: {
          refundPolicy: {
            rules: { freeCancellationDays: 7 },
          },
        },
      },
      headers: { authorization: "Bearer valid-token" },
    });

    expect(nestedPolicyResponse.statusCode).toBe(400);
    expect(nestedPolicyResponse.body.code).toBe("invalid_body");
    expect(repository.writeCount).toBe(0);
  });

  it.each([
    {
      name: "unaccepted commission",
      plan: undefined,
      guestContactAccepted: false,
      expectedEmail: "Hidden until you accept",
    },
    {
      name: "accepted commission",
      plan: undefined,
      guestContactAccepted: true,
      expectedEmail: "finance.guest@example.test",
    },
    {
      name: "fixed",
      plan: "fixed" as const,
      guestContactAccepted: false,
      expectedEmail: "finance.guest@example.test",
    },
  ])(
    "applies guest contact access to $name invoice reads",
    async ({ plan, guestContactAccepted, expectedEmail }) => {
      const queries: string[] = [];
      const repository = createTargetFinancePropertySettingsRepository({
        connectionString: "postgresql://finance-target",
        pool: {
          async query<T extends QueryResultRow = QueryResultRow>(text: string) {
            queries.push(text);
            if (text.includes("SELECT plan_key AS plan")) {
              return { rows: (plan ? [{ plan }] : []) as unknown as T[] };
            }
            if (text.includes("WITH invoice_base AS")) {
              return {
                rows: [financeInvoiceRowFixture({ guestContactAccepted })] as unknown as T[],
              };
            }
            if (text.includes("FROM finance.payments payment")) return { rows: [] as T[] };
            throw new Error(`Unexpected query: ${text}`);
          },
          async end() {},
        },
      });

      const list = await repository.listInvoices!(propertyId, {
        sort: "issuedAt",
        limit: 25,
        offset: 0,
      });
      expect(list.invoices[0]?.guest.email).toBe(expectedEmail);

      if (!plan && !guestContactAccepted) {
        const detail = await repository.getInvoice!(propertyId, "inv_2026_abcd");
        expect(detail?.invoice.guest).toMatchObject({
          displayName: "Fi Guest",
          email: "Hidden until you accept",
          phone: "Hidden until you accept",
        });
      }
      expect(queries.join("\n")).toContain('AS "guestContactAlways"');
      expect(queries.join("\n")).toContain("contact_event.actor_type = 'property_user'");
    },
  );

  it("preserves empty payout and reconciliation reads", async () => {
    app = buildFinanceApp({ repository: emptyFinanceRepository });

    const [payouts, reconciliation] = await Promise.all([
      injectJson(app, {
        method: "GET",
        url: `/api/finance/properties/${propertyId}/payouts`,
        headers: { authorization: "Bearer valid-token" },
      }),
      injectJson(app, {
        method: "GET",
        url: `/api/finance/properties/${propertyId}/reconciliation/payouts`,
        headers: { authorization: "Bearer valid-token" },
      }),
    ]);

    expect(payouts.body).toMatchObject({
      payouts: [],
      total: 0,
      sourceFreshness: { finance: { status: "empty" } },
    });
    expect(reconciliation.body).toMatchObject({
      items: [],
      total: 0,
      sourceFreshness: {
        providerReceiptsFreshAt: null,
        jobsFreshAt: null,
        deadLettersFreshAt: null,
      },
    });
  });

  it("returns cancellation policy reads from the Finance repository", async () => {
    app = buildFinanceApp();

    const response = await injectJson(app, {
      method: "GET",
      url: `/api/finance/properties/${propertyId}/cancellation-policy`,
      headers: { authorization: "Bearer valid-token" },
    });

    expect(response.statusCode).toBe(200);
    expect(response.body).toMatchObject({
      contractVersion: "finance-route-contracts.v1",
      propertyId,
      policy: {
        freeCancellationDays: 7,
        partialRefundPercent: 50,
        refundMethod: "original_payment",
        appliesTo: "direct_booking",
      },
    });
  });

  it("serves the public projection from the finance-specific target profile repository", async () => {
    app = buildFinanceApp({
      publicHotelProfileRepository: null,
      financePublicHotelProfileRepository: publicHotelProfileRepository,
    });

    const response = await injectJson(app, {
      method: "GET",
      url: "/api/booking-web/hotels/hotel-alpenrose/payment-settings",
    });

    expect(response.statusCode).toBe(200);
    expect(response.body).toMatchObject({
      paymentMethods: ["card", "pay_at_property", "bank_transfer"],
      defaultCurrency: "EUR",
    });
  });

  it("uses the canonical target property id for public finance settings reads", async () => {
    const requestedPropertyIds: string[] = [];
    app = buildFinanceApp({
      publicHotelProfileRepository: null,
      financePublicHotelProfileRepository: {
        async findProfileBySlug(slug) {
          if (slug !== "hotel-alpenrose") return null;
          return {
            hotel: {
              propertyId: "prop_distribution_alpenrose",
              slug: "hotel-alpenrose",
            },
          } as PublicBookabilityProfileProjection;
        },
      },
      financePublicHotelPropertyResolver: {
        async findPropertyIdBySlug(slug) {
          return slug === "hotel-alpenrose" ? propertyId : null;
        },
      },
      repository: {
        async getPaymentSettings(requestedPropertyId) {
          requestedPropertyIds.push(requestedPropertyId);
          return requestedPropertyId === propertyId ? paymentSettings : null;
        },
        async getCancellationPolicy(requestedPropertyId) {
          requestedPropertyIds.push(requestedPropertyId);
          return requestedPropertyId === propertyId ? cancellationPolicy : null;
        },
      },
    });

    const response = await injectJson(app, {
      method: "GET",
      url: "/api/booking-web/hotels/hotel-alpenrose/payment-settings",
    });

    expect(response.statusCode).toBe(200);
    expect(requestedPropertyIds).toEqual([propertyId, propertyId]);
    expect(JSON.stringify(response.body)).not.toContain("prop_distribution_alpenrose");
  });

  it("removes sensitive policy keys from the unauthenticated public projection", async () => {
    app = buildFinanceApp({
      repository: {
        async getPaymentSettings() {
          return {
            ...paymentSettings,
            depositPolicy: {
              depositPercent: 25,
              summary: "25% deposit due at checkout.",
              bankTransferInstructions: "IBAN PRIVATE",
              internalNotes: "Call finance before accepting.",
              providerSecret: "secret_ref",
            },
          };
        },
        async getCancellationPolicy() {
          return cancellationPolicy;
        },
      },
    });

    const response = await injectJson(app, {
      method: "GET",
      url: "/api/booking-web/hotels/hotel-alpenrose/payment-settings",
    });

    expect(response.statusCode).toBe(200);
    expect(response.body).toMatchObject({
      depositPolicy: {
        depositPercent: 25,
        summary: "25% deposit due at checkout.",
      },
    });
    expect(JSON.stringify(response.body)).not.toMatch(
      /bankTransferInstructions|IBAN PRIVATE|internalNotes|providerSecret|secret_ref/,
    );
  });

  it("serves the PMS compatibility payment-settings facade without bank secrets", async () => {
    app = buildFinanceApp();

    const response = await injectJson(app, {
      method: "GET",
      url: `/api/pms/properties/${propertyId}/payment-settings`,
      headers: { authorization: "Bearer valid-token" },
    });

    expect(response.statusCode).toBe(200);
    expect(response.body).toMatchObject({
      paymentSettings: {
        payAtPropertyEnabled: true,
        onlineCardPayment: true,
        bankTransfer: true,
        xenditPaymentsEnabled: false,
        defaultCurrency: "EUR",
      },
      cancellationPolicy: {
        freeCancellationDays: 7,
        partialRefundPct: 50,
      },
    });
    expect(JSON.stringify(response.body)).not.toContain("acct_target_alpenrose");
  });

  it("round-trips Vayada provider choices through the PMS compatibility facade", async () => {
    app = buildFinanceApp({
      repository: {
        async getPaymentSettings() {
          return {
            ...paymentSettings,
            paymentProvider: "vayada",
            acceptedMethods: ["card", "pay_at_property"],
            providerAccount: {
              ...paymentSettings.providerAccount,
              provider: "vayada",
              status: "active",
              onboardingStatus: "completed",
              chargesEnabled: true,
            },
          };
        },
        async getCancellationPolicy() {
          return cancellationPolicy;
        },
      },
    });

    const response = await injectJson(app, {
      method: "GET",
      url: `/api/pms/properties/${propertyId}/payment-settings`,
      headers: { authorization: "Bearer valid-token" },
    });

    expect(response.statusCode).toBe(200);
    expect(response.body).toMatchObject({
      paymentSettings: {
        paymentProvider: "vayada",
        onlineCardPayment: true,
        payAtPropertyEnabled: true,
        xenditPaymentsEnabled: false,
      },
    });
  });

  it("does not expose PMS compatibility online methods before the provider can charge", async () => {
    app = buildFinanceApp({
      repository: {
        async getPaymentSettings() {
          return {
            ...paymentSettings,
            paymentProvider: "xendit",
            acceptedMethods: ["xendit", "card", "pay_at_property", "bank_transfer"],
            providerAccount: {
              ...paymentSettings.providerAccount,
              provider: "xendit",
              status: "setup_incomplete",
              onboardingStatus: "not_started",
              chargesEnabled: false,
            },
          };
        },
        async getCancellationPolicy() {
          return cancellationPolicy;
        },
      },
    });

    const response = await injectJson(app, {
      method: "GET",
      url: `/api/pms/properties/${propertyId}/payment-settings`,
      headers: { authorization: "Bearer valid-token" },
    });

    expect(response.statusCode).toBe(200);
    expect(response.body).toMatchObject({
      paymentSettings: {
        paymentProvider: "xendit",
        payAtPropertyEnabled: true,
        bankTransfer: true,
        onlineCardPayment: false,
        xenditPaymentsEnabled: false,
      },
    });
  });

  it("does not expose PMS compatibility payment methods when payments are disabled", async () => {
    app = buildFinanceApp({
      repository: {
        async getPaymentSettings() {
          return {
            ...paymentSettings,
            paymentsEnabled: false,
          };
        },
        async getCancellationPolicy() {
          return cancellationPolicy;
        },
      },
    });

    const response = await injectJson(app, {
      method: "GET",
      url: `/api/pms/properties/${propertyId}/payment-settings`,
      headers: { authorization: "Bearer valid-token" },
    });

    expect(response.statusCode).toBe(200);
    expect(response.body).toMatchObject({
      paymentSettings: {
        payAtPropertyEnabled: false,
        onlineCardPayment: false,
        bankTransfer: false,
        xenditPaymentsEnabled: false,
      },
    });
  });

  it("reads requires_manual_review from the target payment settings row", async () => {
    const repository = createTargetFinancePropertySettingsRepository({
      connectionString: "postgresql://finance-target",
      pool: {
        async query<T extends QueryResultRow = QueryResultRow>(
          text: string,
          values?: readonly unknown[],
        ) {
          expect(text).toContain('settings.requires_manual_review AS "requiresManualReview"');
          expect(values).toEqual([propertyId]);
          return {
            rows: [
              {
                propertyId,
                paymentsEnabled: true,
                acceptedMethods: ["card"],
                defaultCurrency: "EUR",
                depositPolicy: {},
                refundPolicy: {},
                taxPolicy: {},
                statementDescriptor: "ALPENROSE",
                requiresManualReview: true,
                updatedAt: "2026-06-12T10:00:00.000Z",
                providerAccountId: "acct_target_alpenrose",
                provider: "stripe",
                providerStatus: "active",
                providerOnboardingStatus: "completed",
                chargesEnabled: true,
                payoutsEnabled: true,
                providerCapabilities: ["card_payments"],
              },
            ] as unknown as T[],
          };
        },
        async end() {},
      },
    });

    await expect(repository.getPaymentSettings(propertyId)).resolves.toMatchObject({
      requiresManualReview: true,
      providerAccount: { status: "active" },
    });
  });

  it("persists target payment provider choices with audit and idempotent replay", async () => {
    const target = targetPaymentSettingsPool();
    const repository = createTargetFinancePropertySettingsRepository({
      connectionString: "postgresql://finance-target",
      pool: target.pool,
    });
    const command = paymentSettingsTargetCommand({
      payload: {
        paymentsEnabled: true,
        paymentProvider: "vayada",
        acceptedMethods: ["card", "pay_at_property"],
        defaultCurrency: "EUR",
        supportedCurrencies: ["EUR"],
        requiresManualReview: false,
      },
    });
    const keyHash = sha256(command.idempotencyKey);

    const first = await repository.updatePaymentSettings!(command);
    const replay = await repository.updatePaymentSettings!(command);

    expect(first.ok).toBe(true);
    expect(replay.ok).toBe(true);
    if (!first.ok || !replay.ok) throw new Error("Unexpected payment settings write failure");
    expect(first.status).toBe("updated");
    expect(first.settings.paymentProvider).toBe("vayada");
    expect(first.settings.providerAccount).toMatchObject({
      provider: "vayada",
      status: "active",
      onboardingStatus: "completed",
      chargesEnabled: true,
    });
    expect(first.settings.requiresManualReview).toBe(false);
    expect(replay.status).toBe("idempotent_replay");
    expect(replay.settings.paymentProvider).toBe("vayada");
    expect(
      target.calls.filter((call) => call.text.includes("INSERT INTO finance.payment_settings")),
    ).toHaveLength(1);
    expect(
      target.calls.filter((call) =>
        call.text.includes("INSERT INTO platform.product_audit_events"),
      ),
    ).toHaveLength(1);

    const providerInsert = target.requiredCall("INSERT INTO finance.payment_provider_accounts");
    expect(providerInsert.values?.[1]).toBe("vayada");
    expect(providerInsert.values?.[2]).toBe(`settings-choice:${propertyId}:vayada`);
    expect(providerInsert.values?.[3]).toBe("active");
    expect(providerInsert.values?.[5]).toBe(true);

    const paymentSettingsUpsert = target.requiredCall("INSERT INTO finance.payment_settings");
    expect(paymentSettingsUpsert.values?.[9]).toBe(target.providerAccountId);
    expect(paymentSettingsUpsert.values?.[10]).toBe(true);

    const auditInsert = target.requiredCall("INSERT INTO platform.product_audit_events");
    expect(auditInsert.values?.[0]).toBe(
      `finance.payment-settings.audit.property.${propertyId}.key.${keyHash}.v1`,
    );
    expect(auditInsert.values?.[2]).toBe(propertyId);
  });

  it("maps property payouts from the target Finance payout read model without destination secrets", async () => {
    const queries: QueryCall[] = [];
    const repository = createTargetFinancePropertySettingsRepository({
      connectionString: "postgresql://finance-target",
      pool: {
        async query<T extends QueryResultRow = QueryResultRow>(
          text: string,
          values?: readonly unknown[],
        ) {
          queries.push({ text, values });
          expect(text).toContain("FROM finance.payouts payout");
          expect(text).toContain("LEFT JOIN finance.payment_provider_accounts account");
          expect(text).not.toMatch(/sensitive_destination_ref|account_number|raw_payload/i);
          expect(text).toContain("total_count AS");
          expect(text).not.toContain("count(*) OVER");
          expect(values).toEqual([propertyId, "failed", "stripe", 25, 0]);
          return {
            rows: [
              {
                payoutId: "payout_2026_abcd",
                ownerScope: "property",
                propertyId,
                organizationId: null,
                relatedPropertyId: null,
                guestBookingId: invoiceListItems[0]!.guestBookingId,
                paymentId: paymentLedgerItems[0]!.paymentId,
                payoutStatus: "failed",
                amount: "1000.00",
                feeAmount: "25.00",
                netAmount: "975.00",
                currency: "EUR",
                provider: "stripe",
                providerPayoutId: "po_stripe_failed_686",
                scheduledAt: "2026-06-12T11:00:00.000Z",
                paidAt: null,
                failedAt: "2026-06-12T11:30:00.000Z",
                failureCode: "bank_account_restricted",
                retryCount: 2,
                total: 1,
                sourceFreshness,
              },
            ] as unknown as T[],
          };
        },
        async end() {},
      },
    });

    await expect(
      repository.listPayouts!(propertyId, {
        status: "failed",
        provider: "stripe",
        limit: 25,
        offset: 0,
      }),
    ).resolves.toMatchObject({
      payouts: [
        {
          payoutId: "payout_2026_abcd",
          payoutStatus: "failed",
          provider: "stripe",
          retryCount: 2,
        },
      ],
      total: 1,
    });
    expect(queries).toHaveLength(1);
  });

  it("keeps payout totals stable for empty later pages", async () => {
    const queries: QueryCall[] = [];
    const repository = createTargetFinancePropertySettingsRepository({
      connectionString: "postgresql://finance-target",
      pool: {
        async query<T extends QueryResultRow = QueryResultRow>(
          text: string,
          values?: readonly unknown[],
        ) {
          queries.push({ text, values });
          if (values?.length === 3) {
            expect(text).toContain("SELECT count(*)::text AS total");
            expect(values).toEqual([propertyId, "failed", "stripe"]);
            return { rows: [{ total: "42" }] as unknown as T[] };
          }
          expect(text).toContain("total_count AS");
          expect(values).toEqual([propertyId, "failed", "stripe", 25, 50]);
          return { rows: [] as T[] };
        },
        async end() {},
      },
    });

    await expect(
      repository.listPayouts!(propertyId, {
        status: "failed",
        provider: "stripe",
        limit: 25,
        offset: 50,
      }),
    ).resolves.toMatchObject({
      payouts: [],
      total: 42,
      limit: 25,
      offset: 50,
    });
    expect(queries).toHaveLength(2);
  });

  it("maps payout reconciliation state from receipts, jobs, and dead letters", async () => {
    const repository = createTargetFinancePropertySettingsRepository({
      connectionString: "postgresql://finance-target",
      pool: {
        async query<T extends QueryResultRow = QueryResultRow>(
          text: string,
          values?: readonly unknown[],
        ) {
          expect(text).toContain("platform.external_webhook_events receipt");
          expect(text).toContain("platform.jobs job");
          expect(text).toContain("platform.dead_letter_events dead");
          expect(text).toContain("SELECT job.id");
          expect(text).toContain("receipt.normalized_domain_event_id");
          expect(text).toContain("receipt_event.resource_id = payout.provider_payout_id");
          expect(text).toContain("job.tenant_scope = 'external'");
          expect(text).toContain("job.resource_id = payout.provider_payout_id");
          expect(text).toContain("dead.job_id = job.id");
          expect(text).toContain("total_count AS");
          expect(text).not.toContain("count(*) OVER");
          expect(text).not.toContain("raw_payload");
          expect(values).toEqual([propertyId, "dead_lettered", "stripe", 50, 0]);
          return {
            rows: [
              {
                subjectId: "payout_2026_abcd",
                subjectType: "payout",
                provider: "stripe",
                financeStatus: "failed",
                providerStatus: "failed",
                latestReceiptStatus: "dead_lettered",
                jobStatus: "dead_lettered",
                recommendedAction: "manual_review",
                lastReceiptAt: "2026-06-12T11:32:00.000Z",
                lastJobAt: "2026-06-12T11:35:00.000Z",
                total: 1,
                sourceFreshness: reconciliationSourceFreshness,
              },
            ] as unknown as T[],
          };
        },
        async end() {},
      },
    });

    await expect(
      repository.listReconciliationItems!(propertyId, "payouts", {
        status: "dead_lettered",
        provider: "stripe",
        limit: 50,
        offset: 0,
      }),
    ).resolves.toMatchObject({
      items: [
        {
          subjectId: "payout_2026_abcd",
          subjectType: "payout",
          latestReceiptStatus: "dead_lettered",
          jobStatus: "dead_lettered",
          recommendedAction: "manual_review",
        },
      ],
      sourceFreshness: reconciliationSourceFreshness,
    });
  });

  it("matches provider-account reconciliation jobs using webhook job keys and provider object IDs", async () => {
    const repository = createTargetFinancePropertySettingsRepository({
      connectionString: "postgresql://finance-target",
      pool: {
        async query<T extends QueryResultRow = QueryResultRow>(
          text: string,
          values?: readonly unknown[],
        ) {
          expect(text).toContain("receipt.normalized_domain_event_id");
          expect(text).toContain("receipt_event.resource_id = account.provider_account_id");
          expect(text).toContain("SELECT job.id");
          expect(text).toContain("job.tenant_scope = 'external'");
          expect(text).toContain("job.resource_id = account.provider_account_id");
          expect(text).toContain("finance.reconcile-provider-account:provider_account:");
          expect(text).not.toContain("finance.provider-account.reconcile");
          expect(text).toContain("dead.job_id = job.id");
          expect(values).toEqual([propertyId, null, "stripe", 25, 0]);
          return {
            rows: [
              {
                subjectId: "acct_internal_686",
                subjectType: "provider_account",
                provider: "stripe",
                financeStatus: "active",
                providerStatus: "active",
                latestReceiptStatus: "matched",
                jobStatus: "queued",
                recommendedAction: "none",
                lastReceiptAt: "2026-06-12T11:32:00.000Z",
                lastJobAt: "2026-06-12T11:35:00.000Z",
                total: 1,
                sourceFreshness: reconciliationSourceFreshness,
              },
            ] as unknown as T[],
          };
        },
        async end() {},
      },
    });

    await expect(
      repository.listReconciliationItems!(propertyId, "provider-accounts", {
        provider: "stripe",
        limit: 25,
        offset: 0,
      }),
    ).resolves.toMatchObject({
      items: [
        {
          subjectId: "acct_internal_686",
          subjectType: "provider_account",
          latestReceiptStatus: "matched",
          jobStatus: "queued",
        },
      ],
      total: 1,
    });
  });

  it("enqueues Xendit payout reconciliation through platform jobs without legacy payout writes", async () => {
    const calls: QueryCall[] = [];
    const repository = createTargetFinancePropertySettingsRepository({
      connectionString: "postgresql://finance-target",
      pool: {
        async query<T extends QueryResultRow = QueryResultRow>(
          text: string,
          values?: readonly unknown[],
        ) {
          calls.push({ text, values });
          if (text === "BEGIN" || text === "COMMIT" || text === "ROLLBACK") {
            return { rows: [] as T[], rowCount: 0 };
          }
          if (text.includes("INSERT INTO platform.idempotency_keys")) {
            expect(text).toContain("'xendit_payout_reconciliation'");
            expect(text).toMatch(/'property',\s+NULL,\s+\$3::uuid/);
            expect(values?.[2]).toBe(propertyId);
            return {
              rows: [
                {
                  status: "completed",
                  requestFingerprintHash: values?.[1],
                },
              ] as unknown as T[],
              rowCount: 1,
            };
          }
          if (text.includes("INSERT INTO platform.jobs")) {
            expect(text).toContain("'finance-reconciliation'");
            expect(text).toContain("'finance.reconcile-payout'");
            expect(text).toMatch(/'property',\s+NULL,\s+\$2::uuid/);
            expect(values?.[0]).toBe(
              `finance.reconcile-payout:property:${propertyId}:xendit-manual-2026-06-12:v1`,
            );
            expect(values?.[1]).toBe(propertyId);
            return {
              rows: [{ jobId: "job_reconcile_xendit_686", replay: false }] as unknown as T[],
              rowCount: 1,
            };
          }
          if (text.includes("INSERT INTO platform.product_audit_events")) {
            expect(text).toContain("'finance.xendit_payouts.reconcile_requested'");
            expect(text).toMatch(/'property',\s+NULL,\s+\$3::uuid/);
            expect(values?.[2]).toBe(propertyId);
            return { rows: [] as T[], rowCount: 0 };
          }
          throw new Error(`Unexpected SQL: ${text}`);
        },
        async end() {},
      },
    });

    await expect(
      repository.enqueueXenditPayoutReconciliation!(
        xenditPayoutReconciliationCommand({
          requestedAt: "2026-06-12T12:00:00.000Z",
        }),
      ),
    ).resolves.toMatchObject({
      ok: true,
      job: {
        jobType: "finance.reconcile-payout",
        idempotencyKey:
          "finance.reconcile-payout:property:f3000000-0000-0000-0000-000000000686:xendit-manual-2026-06-12:v1",
        status: "queued",
      },
      legacyDisposition:
        "legacy /admin/xendit/reconcile-payouts disabled or proxied during rehearsal",
    });
    expect(calls.map((call) => call.text)).not.toEqual(
      expect.arrayContaining([expect.stringMatching(/UPDATE\s+payouts/i)]),
    );
  });

  it("enqueues property payout dispatch only after readiness and legacy freeze checks", async () => {
    const calls: QueryCall[] = [];
    const repository = createTargetFinancePropertySettingsRepository({
      connectionString: "postgresql://finance-target",
      pool: {
        async query<T extends QueryResultRow = QueryResultRow>(
          text: string,
          values?: readonly unknown[],
        ) {
          calls.push({ text, values });
          if (text === "BEGIN" || text === "COMMIT" || text === "ROLLBACK") {
            return { rows: [] as T[], rowCount: 0 };
          }
          if (text.includes("INSERT INTO platform.idempotency_keys")) {
            expect(text).toContain("'property_payout_dispatch'");
            expect(text).toMatch(/'property',\s+NULL,\s+\$3::uuid/);
            expect(values?.[2]).toBe(propertyId);
            return {
              rows: [
                {
                  status: "completed",
                  requestFingerprintHash: values?.[1],
                },
              ] as unknown as T[],
              rowCount: 1,
            };
          }
          if (text.includes("FROM finance.payouts payout")) {
            expect(text).toContain("job.job_type = 'finance.reconcile-payout'");
            expect(text).toContain("activeLegacyTransferWindow");
            expect(text).toContain("legacyPropertyPayoutSchedulerFrozenAt");
            expect(text).toContain("payout.source_payout_id = $2::text");
            expect(text).toContain("payout.payout_metadata ->> 'payoutId' = $2::text");
            expect(text).toContain("THEN $2::uuid");
            return {
              rows: [
                {
                  payoutId: "payout_2026_abcd",
                  provider: "stripe",
                  providerPayoutId: null,
                  reconciliationReadyAt: "2026-06-13T09:00:00.000Z",
                  legacySchedulerFrozenAt: "2026-06-13T08:00:00.000Z",
                  reconciliationBlockers: 0,
                  activeLegacyTransferWindow: false,
                },
              ] as unknown as T[],
              rowCount: 1,
            };
          }
          if (text.includes("INSERT INTO platform.jobs")) {
            expect(text).toContain("'finance-property-payout-dispatch'");
            expect(text).toContain("'finance.dispatch-property-payout'");
            expect(text).toMatch(/'property',\s+NULL,\s+\$2::uuid/);
            expect(values?.[0]).toBe(
              `finance.dispatch-property-payout:property:${propertyId}:payout:payout_2026_abcd:v1`,
            );
            expect(values?.[1]).toBe(propertyId);
            expect(values?.[2]).toBe("payout_2026_abcd");
            return {
              rows: [
                { jobId: "job_dispatch_property_payout_686", replay: false },
              ] as unknown as T[],
              rowCount: 1,
            };
          }
          if (text.includes("INSERT INTO platform.product_audit_events")) {
            expect(text).toContain("'finance.property_payout.dispatch_requested'");
            expect(values?.[2]).toBe(propertyId);
            expect(values?.[5]).toBe("payout_2026_abcd");
            return { rows: [] as T[], rowCount: 0 };
          }
          throw new Error(`Unexpected SQL: ${text}`);
        },
        async end() {},
      },
    });

    await expect(
      repository.enqueuePropertyPayoutDispatch!(
        propertyPayoutDispatchCommand({
          requestedAt: "2026-06-13T10:00:00.000Z",
        }),
      ),
    ).resolves.toMatchObject({
      ok: true,
      job: {
        jobType: "finance.dispatch-property-payout",
        idempotencyKey:
          "finance.dispatch-property-payout:property:f3000000-0000-0000-0000-000000000686:payout:payout_2026_abcd:v1",
        status: "queued",
      },
      readiness: {
        reconciliationReady: true,
        legacySchedulerFrozen: true,
        activeLegacyTransferWindow: false,
      },
      legacyDisposition:
        "legacy process_property_payouts disabled before target property payout dispatch",
    });
    const queryTexts = calls.map((call) => call.text);
    expect(
      queryTexts.findIndex((text) => text.includes("FROM finance.payouts payout")),
    ).toBeLessThan(queryTexts.findIndex((text) => text.includes("INSERT INTO platform.jobs")));
    expect(queryTexts).not.toEqual(
      expect.arrayContaining([expect.stringMatching(/UPDATE\s+payouts/i)]),
    );
  });

  it("updates affiliate payout settings through finance tables without PMS or marketplace writes", async () => {
    const calls: QueryCall[] = [];
    const repository = createTargetFinancePropertySettingsRepository({
      connectionString: "postgresql://finance-target",
      pool: {
        async query<T extends QueryResultRow = QueryResultRow>(
          text: string,
          values?: readonly unknown[],
        ) {
          calls.push({ text, values });
          if (text === "BEGIN" || text === "COMMIT" || text === "ROLLBACK") {
            return { rows: [] as T[], rowCount: 0 };
          }
          if (text.includes("FROM identity.organization_resource_links link")) {
            expect(text).toContain("link.product = 'affiliate'");
            expect(text).toContain("link.resource_type = 'affiliate'");
            if (text.includes("finance.payout_settings settings")) {
              return {
                rows: [
                  {
                    affiliateId,
                    marketplaceOrganizationId: "a6000000-0000-0000-0000-000000000686",
                    payoutsEnabled: true,
                    payoutProvider: "stripe",
                    payoutCurrency: "EUR",
                    payoutSchedule: { type: "monthly" },
                    payoutPreferences: {},
                    payoutThresholdAmount: null,
                    updatedAt: "2026-06-13T10:00:00.000Z",
                    providerAccountId: "acct_affiliate_target",
                    provider: "stripe",
                    providerStatus: "active",
                    providerOnboardingStatus: "completed",
                    providerPayoutsEnabled: true,
                    sourceFreshness: { finance: "target" },
                  },
                ] as unknown as T[],
                rowCount: 1,
              };
            }
            return {
              rows: [{ organizationId: "a6000000-0000-0000-0000-000000000686" }] as unknown as T[],
              rowCount: 1,
            };
          }
          if (text.includes("INSERT INTO platform.idempotency_keys")) {
            expect(text).toContain("'affiliate_payout_settings_update'");
            expect(text).toMatch(/'organization',\s+\$3::uuid,\s+NULL/);
            return {
              rows: [
                { status: "completed", requestFingerprintHash: values?.[1], inserted: true },
              ] as unknown as T[],
              rowCount: 1,
            };
          }
          if (text.includes("INSERT INTO finance.payout_settings")) {
            expect(text).toContain("owner_scope");
            expect(text).toContain("'organization'");
            return { rows: [] as T[], rowCount: 1 };
          }
          if (text.includes("INSERT INTO platform.product_audit_events")) {
            expect(text).toContain("'finance.affiliate_payout_settings.updated'");
            expect(text).toMatch(/'organization',\s+\$3::uuid,\s+NULL/);
            return { rows: [] as T[], rowCount: 1 };
          }
          throw new Error(`Unexpected SQL: ${text}`);
        },
        async end() {},
      },
    });

    await expect(
      repository.updateAffiliatePayoutSettings!(
        affiliatePayoutSettingsPatchCommand({
          requestedAt: "2026-06-13T10:00:00.000Z",
        }),
      ),
    ).resolves.toMatchObject({
      ok: true,
      settings: {
        affiliateId,
        payoutProvider: "stripe",
        payoutSchedule: "monthly",
      },
      commandMeta: {
        sideEffects: ["audit_event"],
        jobs: [],
      },
    });
    const queryTexts = calls.map((call) => call.text);
    expect(queryTexts).not.toEqual(
      expect.arrayContaining([
        expect.stringMatching(/INSERT\s+INTO\s+pms\./i),
        expect.stringMatching(/UPDATE\s+pms\./i),
        expect.stringMatching(/INSERT\s+INTO\s+marketplace\./i),
        expect.stringMatching(/UPDATE\s+marketplace\./i),
      ]),
    );
  });

  it("passes the Finance property read denial matrix", async () => {
    const cases: Array<{
      name: string;
      auth?: string;
      permissions?: PermissionKey[];
      entitlements?: ProductEntitlement[];
      linkedPropertyId?: string | null;
      linkedResourceType?: "pms_property" | "property";
      expectedStatus: number;
      expectedCode: string;
    }> = [
      {
        name: "missing auth",
        auth: undefined,
        expectedStatus: 401,
        expectedCode: "unauthenticated",
      },
      {
        name: "invalid auth",
        auth: "Bearer invalid-token",
        expectedStatus: 401,
        expectedCode: "unauthenticated",
      },
      {
        name: "missing permission",
        auth: "Bearer valid-token",
        permissions: ["pms.operations.read"],
        expectedStatus: 403,
        expectedCode: "missing_permission",
      },
      {
        name: "missing entitlement",
        auth: "Bearer valid-token",
        entitlements: [],
        expectedStatus: 403,
        expectedCode: "missing_entitlement",
      },
      {
        name: "inactive entitlement",
        auth: "Bearer valid-token",
        entitlements: [{ ...pmsFinanceEntitlement(), status: "suspended" }],
        expectedStatus: 403,
        expectedCode: "inactive_entitlement",
      },
      {
        name: "missing linked resource",
        auth: "Bearer valid-token",
        linkedPropertyId: null,
        expectedStatus: 403,
        expectedCode: "missing_resource_access",
      },
      {
        name: "allowed access",
        auth: "Bearer valid-token",
        expectedStatus: 200,
        expectedCode: "",
      },
      {
        name: "allowed canonical property access",
        auth: "Bearer valid-token",
        entitlements: [pmsFinanceEntitlement("property")],
        linkedResourceType: "property",
        expectedStatus: 200,
        expectedCode: "",
      },
      {
        name: "allowed direct-booking finance access",
        auth: "Bearer valid-token",
        entitlements: [directBookingFinanceEntitlement("property")],
        linkedResourceType: "property",
        expectedStatus: 200,
        expectedCode: "",
      },
    ];

    for (const matrixCase of cases) {
      app = buildFinanceApp({
        permissions: matrixCase.permissions,
        entitlements: matrixCase.entitlements,
        linkedPropertyId: matrixCase.linkedPropertyId,
        linkedResourceType: matrixCase.linkedResourceType,
      });
      const response = await injectJson<Record<string, unknown>>(app, {
        method: "GET",
        url: `/api/finance/properties/${propertyId}/payment-settings`,
        headers: matrixCase.auth ? { authorization: matrixCase.auth } : {},
      });
      await app.close();
      app = null;

      expect(response.statusCode, matrixCase.name).toBe(matrixCase.expectedStatus);
      if (matrixCase.expectedCode) {
        expect(response.body.code, matrixCase.name).toBe(matrixCase.expectedCode);
      }
    }
  });

  it("keeps the existing finance fixture authorization cases aligned", async () => {
    for (const caseId of [
      "authorization-denial-matrix-missing-permission",
      "authorization-denial-matrix-missing-resource",
    ]) {
      const contractCase = financeContractCases.cases.find(
        (candidate) => candidate.caseId === caseId,
      );
      expect(contractCase, caseId).toBeDefined();

      app = buildFinanceApp(
        caseId.endsWith("missing-permission")
          ? { permissions: ["pms.operations.read"] }
          : { linkedPropertyId: null },
      );
      const response = await injectJson<Record<string, unknown>>(app, {
        method: "GET",
        url: contractCase!.request.path,
        headers: { authorization: "Bearer valid-token" },
      });
      await app.close();
      app = null;

      expect(response.statusCode, caseId).toBe(contractCase!.expected.status);
      expect(response.body.code, caseId).toBe(contractCase!.expected.errorCode);
    }
  });
});

type QueryCall = {
  text: string;
  values?: readonly unknown[];
};

type FinanceInvoiceRowFixture = {
  invoiceId: string;
  invoiceNumber: string;
  guestBookingId: string;
  bookingReference: string;
  propertyName: string | null;
  guestDisplayName: string | null;
  guestEmail: string | null;
  guestPhone: string | null;
  guestContactAccepted: boolean;
  checkIn: string;
  checkOut: string;
  roomName: string | null;
  roomNumber: string | null;
  currency: string;
  totalAmount: string;
  amountPaid: string;
  balanceDue: string;
  status: string;
  issuedAt: string;
  total: number;
  counts: unknown;
  sourceFreshness: unknown;
};

function targetManualPaymentPool(
  options: {
    propertyId?: string;
    invoice?: Partial<FinanceInvoiceRowFixture>;
  } = {},
): {
  calls: QueryCall[];
  pool: {
    connect(): Promise<{
      query<T extends QueryResultRow = QueryResultRow>(
        text: string,
        values?: readonly unknown[],
      ): Promise<{ rows: T[]; rowCount: number }>;
      release(): void;
    }>;
    query<T extends QueryResultRow = QueryResultRow>(
      text: string,
      values?: readonly unknown[],
    ): Promise<{ rows: T[]; rowCount: number }>;
    end(): Promise<void>;
  };
  requiredCall(fragment: string): QueryCall;
} {
  const calls: QueryCall[] = [];
  const activePropertyId = options.propertyId ?? propertyId;
  const invoice = financeInvoiceRowFixture({
    ...options.invoice,
    guestBookingId:
      activePropertyId === propertyId
        ? invoiceDetails[0]!.guestBookingId
        : "f6000000-0000-0000-0000-000000000688",
  });

  const query = async <T extends QueryResultRow = QueryResultRow>(
    text: string,
    values?: readonly unknown[],
  ): Promise<{ rows: T[]; rowCount: number }> => {
    calls.push({ text, values });
    const rows = targetManualPaymentRows<T>(text, values, invoice);
    return { rows, rowCount: rows.length };
  };

  const client = {
    query,
    release() {},
  };
  const pool = {
    async connect() {
      return client;
    },
    query,
    async end() {},
  };

  return {
    calls,
    pool,
    requiredCall(fragment: string) {
      const call = calls.find((candidate) => candidate.text.includes(fragment));
      expect(call, fragment).toBeDefined();
      return call!;
    },
  };
}

function targetPaymentSettingsPool(): {
  calls: QueryCall[];
  providerAccountId: string;
  pool: {
    connect(): Promise<{
      query<T extends QueryResultRow = QueryResultRow>(
        text: string,
        values?: readonly unknown[],
      ): Promise<{ rows: T[]; rowCount: number }>;
      release(): void;
    }>;
    query<T extends QueryResultRow = QueryResultRow>(
      text: string,
      values?: readonly unknown[],
    ): Promise<{ rows: T[]; rowCount: number }>;
    end(): Promise<void>;
  };
  requiredCall(fragment: string): QueryCall;
} {
  const providerAccountId = "f7000000-0000-0000-0000-000000000899";
  const state: {
    calls: QueryCall[];
    idempotency: Map<string, string>;
    providerAccount: {
      id: string;
      provider: string;
      providerAccountRef: string;
      status: string;
      onboardingStatus: string;
      chargesEnabled: boolean;
      payoutsEnabled: boolean;
      capabilities: string[];
    } | null;
    settings: {
      paymentsEnabled: boolean;
      acceptedMethods: string[];
      defaultCurrency: string;
      depositPolicy: unknown;
      refundPolicy: unknown;
      taxPolicy: unknown;
      statementDescriptor: string | null;
      requiresManualReview: boolean;
      updatedAt: string;
    } | null;
  } = {
    calls: [],
    idempotency: new Map(),
    providerAccount: null,
    settings: null,
  };

  const query = async <T extends QueryResultRow = QueryResultRow>(
    text: string,
    values?: readonly unknown[],
  ): Promise<{ rows: T[]; rowCount: number }> => {
    state.calls.push({ text, values });
    if (text === "BEGIN" || text === "COMMIT" || text === "ROLLBACK") {
      return { rows: [] as T[], rowCount: 0 };
    }
    if (text.includes("FROM finance.payment_settings settings")) {
      const row = targetPaymentSettingsRow(state.settings, state.providerAccount);
      const rows = row ? [row as unknown as T] : [];
      return { rows, rowCount: rows.length };
    }
    if (text.includes("INSERT INTO platform.idempotency_keys")) {
      const idempotencyKey = String(values?.[0]);
      const fingerprint = String(values?.[1]);
      const previous = state.idempotency.get(idempotencyKey);
      const inserted = previous === undefined;
      if (inserted) state.idempotency.set(idempotencyKey, fingerprint);
      return {
        rows: [
          {
            inserted,
            requestFingerprintHash: previous ?? fingerprint,
          } as unknown as T,
        ],
        rowCount: 1,
      };
    }
    if (text.includes('SELECT id::text AS "providerAccountId"')) {
      const rows = state.providerAccount
        ? [{ providerAccountId: state.providerAccount.id } as unknown as T]
        : [];
      return { rows, rowCount: rows.length };
    }
    if (text.includes("INSERT INTO finance.payment_provider_accounts")) {
      state.providerAccount = {
        id: providerAccountId,
        provider: String(values?.[1]),
        providerAccountRef: String(values?.[2]),
        status: String(values?.[3]),
        onboardingStatus: String(values?.[4]),
        chargesEnabled: Boolean(values?.[5]),
        payoutsEnabled: false,
        capabilities: (values?.[7] as string[] | undefined) ?? [],
      };
      return {
        rows: [{ providerAccountId } as unknown as T],
        rowCount: 1,
      };
    }
    if (text.includes("INSERT INTO finance.payment_settings")) {
      state.settings = {
        paymentsEnabled: Boolean(values?.[1]),
        acceptedMethods: (values?.[2] as string[] | undefined) ?? [],
        defaultCurrency: String(values?.[3]),
        depositPolicy: JSON.parse(String(values?.[4] ?? "{}")),
        refundPolicy: JSON.parse(String(values?.[5] ?? "{}")),
        taxPolicy: JSON.parse(String(values?.[6] ?? "{}")),
        statementDescriptor: values?.[7] === undefined ? null : (values?.[7] as string | null),
        requiresManualReview: Boolean(values?.[8]),
        updatedAt: "2026-06-12T12:00:00.000Z",
      };
      return { rows: [] as T[], rowCount: 1 };
    }
    if (text.includes("INSERT INTO platform.product_audit_events")) {
      return { rows: [] as T[], rowCount: 1 };
    }
    return { rows: [] as T[], rowCount: 0 };
  };

  const client = { query, release() {} };
  return {
    get calls() {
      return state.calls;
    },
    providerAccountId,
    pool: {
      async connect() {
        return client;
      },
      query,
      async end() {},
    },
    requiredCall(fragment: string) {
      const call = state.calls.find((candidate) => candidate.text.includes(fragment));
      expect(call, fragment).toBeDefined();
      return call!;
    },
  };
}

function targetPaymentSettingsRow(
  settings: {
    paymentsEnabled: boolean;
    acceptedMethods: string[];
    defaultCurrency: string;
    depositPolicy: unknown;
    refundPolicy: unknown;
    taxPolicy: unknown;
    statementDescriptor: string | null;
    requiresManualReview: boolean;
    updatedAt: string;
  } | null,
  providerAccount: {
    provider: string;
    providerAccountRef: string;
    status: string;
    onboardingStatus: string;
    chargesEnabled: boolean;
    payoutsEnabled: boolean;
    capabilities: string[];
  } | null,
): Record<string, unknown> | null {
  if (!settings) return null;
  return {
    propertyId,
    paymentsEnabled: settings.paymentsEnabled,
    acceptedMethods: settings.acceptedMethods,
    defaultCurrency: settings.defaultCurrency,
    depositPolicy: settings.depositPolicy,
    refundPolicy: settings.refundPolicy,
    taxPolicy: settings.taxPolicy,
    statementDescriptor: settings.statementDescriptor,
    requiresManualReview: settings.requiresManualReview,
    updatedAt: settings.updatedAt,
    providerAccountId: providerAccount?.providerAccountRef ?? null,
    provider: providerAccount?.provider ?? null,
    providerStatus: providerAccount?.status ?? null,
    providerOnboardingStatus: providerAccount?.onboardingStatus ?? null,
    chargesEnabled: providerAccount?.chargesEnabled ?? null,
    payoutsEnabled: providerAccount?.payoutsEnabled ?? null,
    providerCapabilities: providerAccount?.capabilities ?? [],
  };
}

function targetManualPaymentRows<T extends QueryResultRow>(
  text: string,
  values: readonly unknown[] | undefined,
  invoice: FinanceInvoiceRowFixture,
): T[] {
  if (text === "BEGIN" || text === "COMMIT" || text === "ROLLBACK") return [];
  if (text.includes("WITH invoice_base AS")) return [invoice as unknown as T];
  if (text.includes("INSERT INTO finance.payments")) {
    return [{ paymentId: "f9000000-0000-0000-0000-000000000686", replay: false } as unknown as T];
  }
  if (text.includes('SELECT id::text AS "paymentId", true AS replay')) return [];
  if (text.includes("SELECT") && text.includes("FROM platform.idempotency_keys")) return [];
  if (text.includes("INSERT INTO platform.idempotency_keys")) {
    return [
      {
        status: "in_progress",
        requestFingerprintHash: String(values?.[1]),
      } as unknown as T,
    ];
  }
  if (text.includes("INSERT INTO platform.domain_events")) {
    return [{ eventId: "fa000000-0000-0000-0000-000000000686" } as unknown as T];
  }
  if (text.includes("INSERT INTO platform.outbox_events")) {
    return [
      {
        destination: "booking.projection-refresh",
        outboxEventId: "fb000000-0000-0000-0000-000000000686",
      },
      {
        destination: "pms.projection-refresh",
        outboxEventId: "fc000000-0000-0000-0000-000000000686",
      },
    ] as unknown as T[];
  }
  if (text.includes("INSERT INTO platform.jobs") && text.includes('"jobId", replay')) {
    return [{ jobId: "fd000000-0000-0000-0000-000000000686", replay: false } as unknown as T];
  }
  if (text.includes("INSERT INTO platform.jobs")) return [];
  if (text.includes("INSERT INTO platform.product_audit_events")) return [];
  if (text.includes("UPDATE platform.idempotency_keys")) return [];
  if (text.includes("FROM finance.payments payment")) {
    return [
      {
        paymentId: "f9000000-0000-0000-0000-000000000686",
        method: "cash",
        amount: "250.00",
        currency: "EUR",
        reference: "front desk receipt 8812",
        status: "paid",
        recordedAt: "2026-06-12T12:00:00.000Z",
      } as unknown as T,
    ];
  }
  return [];
}

function targetStripeProviderAccountPool(options: { failInsert?: boolean } = {}): {
  calls: QueryCall[];
  existingAccount: FinanceProviderAccountRowFixture | null;
  pool: {
    connect(): Promise<{
      query<T extends QueryResultRow = QueryResultRow>(
        text: string,
        values?: readonly unknown[],
      ): Promise<{ rows: T[]; rowCount: number }>;
      release(): void;
    }>;
    query<T extends QueryResultRow = QueryResultRow>(
      text: string,
      values?: readonly unknown[],
    ): Promise<{ rows: T[]; rowCount: number }>;
    end(): Promise<void>;
  };
  requiredCall(fragment: string): QueryCall;
} {
  const state: {
    calls: QueryCall[];
    existingAccount: FinanceProviderAccountRowFixture | null;
  } = {
    calls: [],
    existingAccount: null,
  };

  const query = async <T extends QueryResultRow = QueryResultRow>(
    text: string,
    values?: readonly unknown[],
  ): Promise<{ rows: T[]; rowCount: number }> => {
    state.calls.push({ text, values });
    if (text.includes("SELECT") && text.includes("FROM platform.idempotency_keys")) {
      return { rows: [] as T[], rowCount: 0 };
    }
    if (text.includes("FROM finance.payment_provider_accounts")) {
      const rows = state.existingAccount ? [state.existingAccount as unknown as T] : [];
      return { rows, rowCount: rows.length };
    }
    if (text.includes("INSERT INTO platform.idempotency_keys")) {
      return {
        rows: [{ requestFingerprintHash: String(values?.[2]) } as unknown as T],
        rowCount: 1,
      };
    }
    if (text.includes("INSERT INTO finance.payment_provider_accounts")) {
      if (options.failInsert) {
        throw new Error("simulated provider-account insert failure");
      }
      const account: FinanceProviderAccountRowFixture = {
        providerAccountId: "f7000000-0000-0000-0000-000000000686",
        providerAccountRef: "acct_target_property_686",
        status: "setup_incomplete",
        onboardingStatus: "invited",
        onboardingUrl: "https://connect.stripe.test/onboard/acct_target_property_686/1",
      };
      state.existingAccount = account;
      return { rows: [account as unknown as T], rowCount: 1 };
    }
    if (text.includes("UPDATE finance.payment_provider_accounts")) {
      return { rows: [] as T[], rowCount: 1 };
    }
    if (text.includes("UPDATE platform.idempotency_keys")) {
      return { rows: [] as T[], rowCount: 1 };
    }
    return { rows: [] as T[], rowCount: 0 };
  };

  const client = { query, release() {} };
  const result = {
    get calls() {
      return state.calls;
    },
    get existingAccount() {
      return state.existingAccount;
    },
    set existingAccount(account: FinanceProviderAccountRowFixture | null) {
      state.existingAccount = account;
    },
    pool: {
      async connect() {
        return client;
      },
      query,
      async end() {},
    },
    requiredCall(fragment: string) {
      const call = state.calls.find((candidate) => candidate.text.includes(fragment));
      expect(call, fragment).toBeDefined();
      return call!;
    },
  };
  return result;
}

type FinanceProviderAccountRowFixture = {
  providerAccountId: string;
  providerAccountRef: string;
  status: string;
  onboardingStatus: string;
  onboardingUrl: string | null;
};

function fakeStripeConnectProvider(): FinanceStripeConnectProvider & {
  createAccountCount: number;
  compensationCount: number;
} {
  let createAccountCount = 0;
  let compensationCount = 0;
  const provider: FinanceStripeConnectProvider & {
    createAccountCount: number;
    compensationCount: number;
  } = {
    get createAccountCount() {
      return createAccountCount;
    },
    get compensationCount() {
      return compensationCount;
    },
    async createAccount() {
      createAccountCount += 1;
      return {
        providerAccountRef: "acct_target_property_686",
        onboardingUrl: "https://connect.stripe.test/onboard/acct_target_property_686/1",
      };
    },
    async createOnboardingLink(request) {
      return `https://connect.stripe.test/onboard/${request.providerAccountRef}/2`;
    },
    async compensateAccountCreation() {
      compensationCount += 1;
    },
  };
  return provider;
}

function stripePropertyTargetCommand(
  options: { idempotencyKey?: string } = {},
): CreateStripeProviderAccountCommand {
  return {
    commandType: "finance.provider_account.stripe.create",
    commandId: "cmd-stripe-property-target",
    idempotencyKey: options.idempotencyKey ?? "finance-stripe-property-f300686",
    propertyId,
    audit: {
      actor: {
        kind: "user",
        userId: "f1000000-0000-0000-0000-000000000686",
        organizationId: affiliateOrganizationId,
      },
      requestId: "req_stripe_property_target",
      correlationId: "corr_stripe_property_target",
      reason: "Stripe property account target test",
      requestedAt: "2026-06-12T12:00:00.000Z",
    },
    payload: {
      email: "owner@example.test",
      country: "AT",
    },
  };
}

function stripePropertyOnboardingLinkTargetCommand(
  providerAccountId: string,
): IssueStripeOnboardingLinkCommand {
  return {
    commandType: "finance.provider_account.stripe.onboarding_link.issue",
    commandId: "cmd-stripe-property-link-target",
    idempotencyKey: "finance-stripe-property-link-target",
    propertyId,
    audit: {
      actor: {
        kind: "user",
        userId: "f1000000-0000-0000-0000-000000000686",
        organizationId: affiliateOrganizationId,
      },
      requestId: "req_stripe_property_link_target",
      correlationId: "corr_stripe_property_link_target",
      reason: "Stripe property onboarding-link target test",
      requestedAt: "2026-06-12T12:00:00.000Z",
    },
    payload: { providerAccountId },
  };
}

function financeInvoiceRowFixture(
  overrides: Partial<FinanceInvoiceRowFixture> = {},
): FinanceInvoiceRowFixture {
  return {
    invoiceId: "inv_2026_abcd",
    invoiceNumber: "INV-2026-0002",
    guestBookingId: invoiceDetails[0]!.guestBookingId,
    bookingReference: "B-FIN-686",
    propertyName: "Hotel Alpenrose",
    guestDisplayName: "Fi Guest",
    guestEmail: "finance.guest@example.test",
    guestPhone: "+15555550123",
    guestContactAccepted: false,
    checkIn: "2026-08-01",
    checkOut: "2026-08-05",
    roomName: "Alpine Suite",
    roomNumber: "201",
    currency: "EUR",
    totalAmount: "1200.00",
    amountPaid: "350.00",
    balanceDue: "850.00",
    status: "partial",
    issuedAt: "2026-06-12T10:00:00.000Z",
    total: 1,
    counts: { partial: 1 },
    sourceFreshness: {},
    ...overrides,
  };
}

function manualPaymentTargetCommand(
  options: {
    propertyId?: string;
    idempotencyKey?: string;
    payload?: Partial<FinanceManualPaymentRecordCommand["payload"]>;
  } = {},
): FinanceManualPaymentRecordCommand {
  const commandPropertyId = options.propertyId ?? propertyId;
  return {
    commandType: "finance.manual_payment.record",
    commandId: "cmd-manual-payment-target",
    idempotencyKey: options.idempotencyKey ?? "finance-manual-payment-inv-2026-abcd-001",
    propertyId: commandPropertyId,
    audit: {
      actor: {
        kind: "user",
        userId: "f1000000-0000-0000-0000-000000000686",
        organizationId: "f2000000-0000-0000-0000-000000000686",
      },
      requestId: "req_manual_payment_target",
      correlationId: "corr_manual_payment_target",
      reason: "Manual payment target test",
      requestedAt: "2026-06-12T12:00:00.000Z",
    },
    payload: {
      invoiceId: "inv_2026_abcd",
      amount: "250.00",
      currency: "EUR",
      paymentMethod: "cash",
      reference: "front desk receipt 8812",
      ...options.payload,
    },
  };
}

function paymentSettingsTargetCommand(
  options: {
    propertyId?: string;
    idempotencyKey?: string;
    payload?: FinancePaymentSettingsPatchCommand["payload"];
  } = {},
): FinancePaymentSettingsPatchCommand {
  const commandPropertyId = options.propertyId ?? propertyId;
  return {
    commandType: "finance.payment_settings.update",
    commandId: "cmd-payment-settings-target",
    idempotencyKey: options.idempotencyKey ?? "finance-payment-settings-target-f300686",
    propertyId: commandPropertyId,
    audit: {
      actor: {
        kind: "user",
        userId: "f1000000-0000-0000-0000-000000000686",
        organizationId: "f2000000-0000-0000-0000-000000000686",
      },
      requestId: "req_payment_settings_target",
      correlationId: "corr_payment_settings_target",
      reason: "Payment settings target test",
      requestedAt: "2026-06-12T12:00:00.000Z",
    },
    payload: options.payload ?? {
      paymentsEnabled: true,
      paymentProvider: "vayada",
      acceptedMethods: ["card", "pay_at_property"],
      defaultCurrency: "EUR",
      supportedCurrencies: ["EUR"],
      requiresManualReview: false,
    },
  };
}

function xenditPayoutReconciliationCommand(
  options: {
    propertyId?: string;
    idempotencyKey?: string;
    requestedAt?: string;
    payload?: Partial<FinanceXenditPayoutReconciliationCommand["payload"]>;
  } = {},
): FinanceXenditPayoutReconciliationCommand {
  const commandPropertyId = options.propertyId ?? propertyId;
  return {
    commandType: "finance.xendit_payouts.reconcile",
    commandId: "cmd-xendit-reconcile-target",
    idempotencyKey: options.idempotencyKey ?? "finance-reconcile-xendit-payouts-f300686-2026-06-12",
    propertyId: commandPropertyId,
    audit: {
      actor: {
        kind: "user",
        userId: "f1000000-0000-0000-0000-000000000686",
        organizationId: "f2000000-0000-0000-0000-000000000686",
      },
      requestId: "req_xendit_reconcile_target",
      correlationId: "corr_xendit_reconcile_target",
      reason: "Xendit payout reconciliation target test",
      requestedAt: options.requestedAt ?? "2026-06-12T12:00:00.000Z",
    },
    payload: {
      olderThanMinutes: 0,
      ...options.payload,
    },
  };
}

function propertyPayoutDispatchBody(
  overrides: Partial<FinancePropertyPayoutDispatchCommand["payload"]> & {
    commandId?: string;
    idempotencyKey?: string;
  } = {},
): Record<string, unknown> {
  return {
    commandId: overrides.commandId ?? "cmd-dispatch-property-payout-001",
    idempotencyKey: overrides.idempotencyKey ?? "finance-dispatch-property-payout-686-2026-06-13",
    legacySchedulerFrozenAt: overrides.legacySchedulerFrozenAt ?? "2026-06-13T08:00:00.000Z",
    reconciliationReadyAt: overrides.reconciliationReadyAt ?? "2026-06-13T09:00:00.000Z",
  };
}

function propertyPayoutDispatchCommand(
  options: {
    propertyId?: string;
    idempotencyKey?: string;
    requestedAt?: string;
    payload?: Partial<FinancePropertyPayoutDispatchCommand["payload"]>;
  } = {},
): FinancePropertyPayoutDispatchCommand {
  const commandPropertyId = options.propertyId ?? propertyId;
  return {
    commandType: "finance.property_payout.dispatch",
    commandId: "cmd-dispatch-property-payout-target",
    idempotencyKey: options.idempotencyKey ?? "finance-dispatch-property-payout-686-2026-06-13",
    propertyId: commandPropertyId,
    audit: {
      actor: {
        kind: "user",
        userId: "f1000000-0000-0000-0000-000000000686",
        organizationId: "f2000000-0000-0000-0000-000000000686",
      },
      requestId: "req_dispatch_property_payout_target",
      correlationId: "corr_dispatch_property_payout_target",
      reason: "Property payout dispatch target test",
      requestedAt: options.requestedAt ?? "2026-06-13T10:00:00.000Z",
    },
    payload: {
      payoutId: "payout_2026_abcd",
      legacySchedulerFrozenAt: "2026-06-13T08:00:00.000Z",
      reconciliationReadyAt: "2026-06-13T09:00:00.000Z",
      ...options.payload,
    },
  };
}

function affiliatePayoutSettingsPatchCommand(
  options: {
    requestedAt?: string;
    payload?: Partial<FinanceAffiliatePayoutSettingsPatchCommand["payload"]>;
  } = {},
): FinanceAffiliatePayoutSettingsPatchCommand {
  return {
    commandType: "finance.affiliate_payout_settings.update",
    commandId: "cmd-affiliate-payout-settings-001",
    idempotencyKey: "finance-affiliate-payout-settings-686-001",
    affiliateId,
    audit: {
      actor: {
        kind: "user",
        userId: "f1000000-0000-0000-0000-000000000686",
        organizationId: "a6000000-0000-0000-0000-000000000686",
      },
      requestId: "req_affiliate_payout_settings_target",
      correlationId: "corr_affiliate_payout_settings_target",
      reason: "Affiliate payout settings target test",
      requestedAt: options.requestedAt ?? "2026-06-13T10:00:00.000Z",
    },
    payload: {
      payoutsEnabled: true,
      payoutProvider: "stripe",
      payoutCurrency: "EUR",
      payoutSchedule: "monthly",
      ...options.payload,
    },
  };
}

function buildFinanceApp(
  options: {
    permissions?: PermissionKey[];
    entitlements?: ProductEntitlement[];
    linkedPropertyId?: string | null;
    linkedResourceType?: "pms_property" | "property";
    linkedAffiliateId?: string | null;
    repository?: FinancePropertyReadRepository;
    xenditBankValidator?: FinanceXenditBankValidator;
    publicHotelProfileRepository?: PublicHotelProfileRepository | null;
    financePublicHotelProfileRepository?: PublicHotelProfileRepository;
    financePublicHotelPropertyResolver?: FinancePublicHotelPropertyResolver;
  } = {},
): ReturnType<typeof buildApp> {
  return buildApp({
    logger: false,
    publicHotelProfileRepository:
      options.publicHotelProfileRepository === null
        ? undefined
        : (options.publicHotelProfileRepository ?? publicHotelProfileRepository),
    financePublicHotelProfileRepository: options.financePublicHotelProfileRepository,
    financePublicHotelPropertyResolver: options.financePublicHotelPropertyResolver,
    financeRepository: options.repository ?? financeRepository,
    financeXenditBankValidator: options.xenditBankValidator,
    auth: {
      verifier: createFakeVerifier(new Map([["valid-token", session]])),
      repository: identityRepository({
        linkedPropertyId: options.linkedPropertyId,
        linkedResourceType: options.linkedResourceType,
        linkedAffiliateId: options.linkedAffiliateId,
      }),
      rolePermissionRepository: {
        async findPermissionsForRole() {
          return options.permissions ?? ["pms.finance.read"];
        },
      },
      entitlementRepository: {
        async findEntitlementsForContext() {
          return options.entitlements ?? [pmsFinanceEntitlement()];
        },
      },
    },
  });
}

function buildAffiliateFinanceApp(options: {
  repository: FinancePropertyReadRepository;
}): ReturnType<typeof buildApp> {
  return buildApp({
    logger: false,
    financeRepository: options.repository,
    auth: {
      verifier: createFakeVerifier(new Map([["valid-token", session]])),
      repository: affiliateIdentityRepository(),
      rolePermissionRepository: {
        async findPermissionsForRole() {
          return ["affiliate.payout.manage"];
        },
      },
      entitlementRepository: {
        async findEntitlementsForContext() {
          return [
            {
              product: "affiliate",
              key: "affiliate-payouts",
              status: "active",
              resource: {
                product: "affiliate",
                resourceType: "affiliate",
                resourceId: affiliateId,
              },
            },
          ];
        },
      },
    },
  });
}

const publicHotelProfileRepository: PublicHotelProfileRepository = {
  async findProfileBySlug(slug) {
    if (slug !== "hotel-alpenrose") return null;
    return {
      hotel: {
        propertyId,
        slug: "hotel-alpenrose",
      },
    } as PublicBookabilityProfileProjection;
  },
};

const financeRepository: FinancePropertyReadRepository = {
  async getPaymentSettings(requestedPropertyId) {
    return requestedPropertyId === propertyId ? paymentSettings : null;
  },
  async getCancellationPolicy(requestedPropertyId) {
    return requestedPropertyId === propertyId ? cancellationPolicy : null;
  },
  async getFinancialSummary(requestedPropertyId) {
    if (requestedPropertyId !== propertyId) return null;
    return {
      summary: financialSummary,
      sourceFreshness,
    };
  },
  async listInvoices(requestedPropertyId, query) {
    const filtered = requestedPropertyId === propertyId ? filterInvoices(query) : [];
    return {
      invoices: filtered.slice(query.offset, query.offset + query.limit),
      total: filtered.length,
      counts: invoiceCounts(invoiceListItems),
      limit: query.limit,
      offset: query.offset,
      sourceFreshness,
    };
  },
  async getInvoice(requestedPropertyId, invoiceId) {
    if (requestedPropertyId !== propertyId) return null;
    const invoice = invoiceDetails.find((candidate) => candidate.invoiceId === invoiceId);
    return invoice ? { invoice, sourceFreshness } : null;
  },
  async listPayments(requestedPropertyId, query) {
    const filtered = requestedPropertyId === propertyId ? filterPayments(query) : [];
    return {
      payments: filtered.slice(query.offset, query.offset + query.limit),
      total: filtered.length,
      counts: {
        requires_action: 0,
        authorized: 0,
        pending: 0,
        paid: paymentLedgerItems.filter((item) => item.status === "paid").length,
        partially_refunded: 0,
        refunded: 0,
        failed: 0,
        canceled: 0,
        disputed: 0,
      },
      limit: query.limit,
      offset: query.offset,
      sourceFreshness,
    };
  },
  async listPayouts(requestedPropertyId, query) {
    const filtered = requestedPropertyId === propertyId ? filterPayouts(query) : [];
    return {
      payouts: filtered.slice(query.offset, query.offset + query.limit),
      total: filtered.length,
      limit: query.limit,
      offset: query.offset,
      sourceFreshness,
    };
  },
  async getAffiliatePayoutSettings(requestedAffiliateId) {
    return requestedAffiliateId === affiliateId ? affiliatePayoutSettings : null;
  },
  async listAffiliatePayouts(requestedAffiliateId, query) {
    if (requestedAffiliateId !== affiliateId) return null;
    const filtered = filterAffiliatePayouts(query);
    return {
      payouts: filtered.slice(query.offset, query.offset + query.limit),
      total: filtered.length,
      limit: query.limit,
      offset: query.offset,
      sourceFreshness,
    };
  },
  async updateAffiliatePayoutSettings(command) {
    if (command.affiliateId !== affiliateId) {
      return {
        ok: false,
        statusCode: 404,
        code: "affiliate_not_found",
        message: "Affiliate finance resource was not found.",
      };
    }
    return affiliatePayoutSettingsPatchResult(command, "updated");
  },
  async listReconciliationItems(requestedPropertyId, view, query) {
    const filtered =
      requestedPropertyId === propertyId ? filterReconciliationItems(view, query) : [];
    return {
      items: filtered.slice(query.offset, query.offset + query.limit),
      total: filtered.length,
      limit: query.limit,
      offset: query.offset,
      sourceFreshness: reconciliationSourceFreshness,
    };
  },
  async getInvoiceCsvExportDisposition(requestedPropertyId) {
    return {
      export: {
        status: "queued",
        disposition: "durable_export_job",
        filename: `finance-invoices-${requestedPropertyId}.csv`,
        contentType: "text/csv",
        downloadUrl: null,
        jobId: "job_finance_invoice_export_686",
        message: "Invoice CSV export runs through the Finance read-model export job.",
      },
      sourceFreshness,
    };
  },
};

function manualPaymentRepository(): FinancePropertyReadRepository & {
  writeCount: number;
  outboxEnqueueCount: number;
} {
  const records = new Map<string, FinanceManualPaymentRecordResult & { ok: true }>();
  const repository: FinancePropertyReadRepository & {
    writeCount: number;
    outboxEnqueueCount: number;
  } = {
    ...financeRepository,
    writeCount: 0,
    outboxEnqueueCount: 0,
    async recordManualPayment(command) {
      const validationError = manualPaymentValidationError(command);
      if (validationError) return validationError;

      if (command.propertyId !== propertyId || command.payload.invoiceId !== "inv_2026_abcd") {
        return {
          ok: false,
          statusCode: 404,
          code: "invoice_not_found",
          message: "Finance invoice was not found.",
        };
      }

      const existing = records.get(command.idempotencyKey);
      if (existing) {
        return {
          ...existing,
          status: "idempotent_replay",
          commandMeta: {
            ...existing.commandMeta,
            jobs: existing.commandMeta.jobs.map((job) => ({
              ...job,
              status: "idempotent_replay",
            })),
          },
        };
      }

      repository.writeCount += 1;
      repository.outboxEnqueueCount += 2;
      const commandMeta = manualPaymentCommandMeta(command, "queued");
      const result = {
        ok: true,
        status: "created",
        invoice: invoiceDetails[0]!,
        commandMeta,
      } satisfies FinanceManualPaymentRecordResult & { ok: true };
      records.set(command.idempotencyKey, result);
      return result;
    },
  };
  return repository;
}

function paymentSettingsWriteRepository(): FinancePropertyReadRepository & {
  writeCount: number;
} {
  const records = new Map<string, FinancePaymentSettingsPatchResult & { ok: true }>();
  const repository: FinancePropertyReadRepository & {
    writeCount: number;
  } = {
    ...financeRepository,
    writeCount: 0,
    async updatePaymentSettings(command) {
      if (command.propertyId !== propertyId) {
        return {
          ok: false,
          statusCode: 404,
          code: "property_not_found",
          message: "Finance property payment settings were not found.",
        };
      }

      const existing = records.get(command.idempotencyKey);
      if (existing) {
        return {
          ...existing,
          status: "idempotent_replay",
        };
      }

      repository.writeCount += 1;
      const result = paymentSettingsPatchResult(command, "updated");
      records.set(command.idempotencyKey, result);
      return result;
    },
  };
  return repository;
}

function stripeProviderAccountRepository(): FinancePropertyReadRepository & {
  providerCreateCount: number;
  seedAffiliateProviderAccount(): void;
} {
  const accounts = new Map<string, FinanceProviderAccountCommandResult & { ok: true }>();
  const repository: FinancePropertyReadRepository & {
    providerCreateCount: number;
    seedAffiliateProviderAccount(): void;
  } = {
    ...financeRepository,
    providerCreateCount: 0,
    seedAffiliateProviderAccount() {
      const command = stripeAffiliateCommand();
      const result = stripeProviderAccountResult(command, "f7100000-0000-0000-0000-000000000686");
      accounts.set("affiliate", result);
    },
    async createStripeProviderAccount(command) {
      const ownerKey = "propertyId" in command ? "property" : "affiliate";
      const existing = accounts.get(ownerKey);
      if (existing) {
        return {
          ...existing,
          status: "existing_owner_account",
          response: {
            ...existing.response,
            commandMeta: stripeProviderAccountCommandMeta(command),
          },
        };
      }
      repository.providerCreateCount += 1;
      const providerAccountId =
        ownerKey === "property"
          ? "f7000000-0000-0000-0000-000000000686"
          : "f7100000-0000-0000-0000-000000000686";
      const result = stripeProviderAccountResult(command, providerAccountId);
      accounts.set(ownerKey, result);
      return result;
    },
    async issueStripeOnboardingLink(command) {
      const ownerKey = "propertyId" in command ? "property" : "affiliate";
      const existing = accounts.get(ownerKey);
      if (!existing || existing.response.providerAccountId !== command.payload.providerAccountId) {
        return {
          ok: false,
          statusCode: 404,
          code: "provider_account_not_found",
          message: "Finance provider account was not found.",
        };
      }
      const providerAccountRef = existing.response.providerAccountRef;
      return {
        ok: true,
        status: "created",
        response: {
          ...existing.response,
          onboardingUrl: `https://connect.stripe.test/onboard/${providerAccountRef}/2`,
          commandMeta: stripeProviderAccountCommandMeta(command),
        },
      };
    },
  };
  return repository;
}

function xenditPayoutReconciliationRepository(): FinancePropertyReadRepository & {
  enqueueCount: number;
} {
  const records = new Map<string, FinanceXenditPayoutReconciliationResult & { ok: true }>();
  const repository: FinancePropertyReadRepository & { enqueueCount: number } = {
    ...financeRepository,
    enqueueCount: 0,
    async enqueueXenditPayoutReconciliation(command) {
      const existing = records.get(command.idempotencyKey);
      if (existing) {
        return {
          ...existing,
          status: "idempotent_replay",
          job: { ...existing.job, status: "idempotent_replay" },
          commandMeta: {
            ...existing.commandMeta,
            jobs: existing.commandMeta.jobs.map((job) => ({
              ...job,
              status: "idempotent_replay",
            })),
          },
        };
      }
      repository.enqueueCount += 1;
      const result = xenditPayoutReconciliationResult(command, "queued");
      records.set(command.idempotencyKey, result);
      return result;
    },
  };
  return repository;
}

function stripeProviderAccountResult(
  command: CreateStripeProviderAccountCommand,
  providerAccountId: string,
): FinanceProviderAccountCommandResult & { ok: true } {
  const providerAccountRef = "propertyId" in command ? "acct_property_686" : "acct_affiliate_686";
  return {
    ok: true,
    status: "created",
    response: {
      contractVersion: "finance-route-contracts.v1",
      providerAccountId,
      provider: "stripe",
      providerAccountRef,
      status: "setup_incomplete",
      onboardingStatus: "invited",
      onboardingUrl: `https://connect.stripe.test/onboard/${providerAccountRef}/1`,
      commandMeta: stripeProviderAccountCommandMeta(command),
    },
  };
}

function stripeProviderAccountCommandMeta(
  command: CreateStripeProviderAccountCommand | IssueStripeOnboardingLinkCommand,
): Extract<FinanceProviderAccountCommandResult, { ok: true }>["response"]["commandMeta"] {
  return {
    commandId: command.commandId,
    idempotencyKey: command.idempotencyKey,
    sideEffects: ["audit_event", "reconciliation_job"],
    outboxEvents: [],
    jobs: [],
  };
}

function stripeAffiliateCommand(): CreateStripeProviderAccountCommand {
  return {
    commandType: "finance.provider_account.stripe.create",
    commandId: "cmd-stripe-affiliate-001",
    idempotencyKey: "finance-stripe-affiliate-686",
    affiliateId,
    organizationId: affiliateOrganizationId,
    audit: {
      actor: {
        kind: "user",
        userId: "user_affiliate",
        organizationId: affiliateOrganizationId,
      },
      requestId: "req_stripe_affiliate",
      requestedAt: "2026-06-12T12:00:00.000Z",
      reason: "Affiliate Stripe Connect test",
    },
    payload: {
      email: "affiliate@example.test",
      country: "AT",
    },
  };
}

function propertyPayoutDispatchRepository(
  options: {
    readiness?: Partial<Extract<FinancePropertyPayoutDispatchResult, { ok: true }>["readiness"]>;
  } = {},
): FinancePropertyReadRepository & { enqueueCount: number } {
  const records = new Map<string, FinancePropertyPayoutDispatchResult & { ok: true }>();
  const repository: FinancePropertyReadRepository & { enqueueCount: number } = {
    ...financeRepository,
    enqueueCount: 0,
    async enqueuePropertyPayoutDispatch(command) {
      const readiness = {
        payoutId: command.payload.payoutId,
        reconciliationReady: true,
        legacySchedulerFrozen: true,
        activeLegacyTransferWindow: false,
        existingProviderPayoutId: null,
        provider: "stripe",
        blockingReasons: [],
        ...options.readiness,
      } satisfies Extract<FinancePropertyPayoutDispatchResult, { ok: true }>["readiness"];
      if (!readiness.reconciliationReady) {
        return {
          ok: false,
          statusCode: 409,
          code: "reconciliation_not_ready",
          message: "Property payout dispatch is blocked until payout reconciliation is ready.",
        };
      }
      if (!readiness.legacySchedulerFrozen) {
        return {
          ok: false,
          statusCode: 409,
          code: "legacy_scheduler_not_frozen",
          message:
            "Property payout dispatch is blocked until legacy process_property_payouts is frozen.",
        };
      }
      if (readiness.activeLegacyTransferWindow) {
        return {
          ok: false,
          statusCode: 409,
          code: "active_legacy_transfer_window",
          message: "Property payout dispatch is blocked by an active legacy transfer window.",
        };
      }
      if (readiness.existingProviderPayoutId) {
        return {
          ok: false,
          statusCode: 409,
          code: "payout_already_dispatched",
          message: "Property payout already has a provider payout id.",
        };
      }

      const existing = records.get(command.idempotencyKey);
      if (existing) {
        return {
          ...existing,
          status: "idempotent_replay",
          job: { ...existing.job, status: "idempotent_replay" },
          commandMeta: {
            ...existing.commandMeta,
            jobs: existing.commandMeta.jobs.map((job) => ({
              ...job,
              status: "idempotent_replay",
            })),
          },
        };
      }
      repository.enqueueCount += 1;
      const result = propertyPayoutDispatchResult(command, readiness, "queued");
      records.set(command.idempotencyKey, result);
      return result;
    },
  };
  return repository;
}

function xenditPayoutReconciliationResult(
  command: FinanceXenditPayoutReconciliationCommand,
  status: "queued" | "idempotent_replay",
): FinanceXenditPayoutReconciliationResult & { ok: true } {
  const job = {
    jobType: "finance.reconcile-payout",
    idempotencyKey:
      "finance.reconcile-payout:property:f3000000-0000-0000-0000-000000000686:xendit-manual-2026-06-12:v1",
    status,
  } as const;
  return {
    ok: true,
    status,
    job,
    legacyDisposition:
      "legacy /admin/xendit/reconcile-payouts disabled or proxied during rehearsal",
    commandMeta: {
      commandId: command.commandId,
      idempotencyKey: command.idempotencyKey,
      sideEffects: ["reconciliation_job", "audit_event"],
      outboxEvents: [],
      jobs: [job],
    },
  };
}

function propertyPayoutDispatchResult(
  command: FinancePropertyPayoutDispatchCommand,
  readiness: Extract<FinancePropertyPayoutDispatchResult, { ok: true }>["readiness"],
  status: "queued" | "idempotent_replay",
): FinancePropertyPayoutDispatchResult & { ok: true } {
  const job = {
    jobType: "finance.dispatch-property-payout",
    payoutId: command.payload.payoutId,
    provider: "stripe",
    idempotencyKey:
      "finance.dispatch-property-payout:property:f3000000-0000-0000-0000-000000000686:payout:payout_2026_abcd:v1",
    status,
  } as const;
  return {
    ok: true,
    status,
    job,
    readiness,
    legacyDisposition:
      "legacy process_property_payouts disabled before target property payout dispatch",
    rollbackRule:
      "Stop target dispatcher, reconcile provider transfer IDs, and re-enable legacy only for payouts with no successful target transfer.",
    commandMeta: {
      commandId: command.commandId,
      idempotencyKey: command.idempotencyKey,
      sideEffects: ["payout_job", "audit_event"],
      outboxEvents: [],
      jobs: [job],
    },
  };
}

function affiliatePayoutSettingsPatchResult(
  command: FinanceAffiliatePayoutSettingsPatchCommand,
  status: "updated" | "idempotent_replay",
): FinanceAffiliatePayoutSettingsPatchResult & { ok: true } {
  return {
    ok: true,
    status,
    settings: {
      ...affiliatePayoutSettings,
      payoutsEnabled: command.payload.payoutsEnabled ?? affiliatePayoutSettings.payoutsEnabled,
      payoutProvider: command.payload.payoutProvider ?? affiliatePayoutSettings.payoutProvider,
      payoutCurrency: command.payload.payoutCurrency ?? affiliatePayoutSettings.payoutCurrency,
      payoutSchedule: command.payload.payoutSchedule ?? affiliatePayoutSettings.payoutSchedule,
      payoutThresholdAmount:
        command.payload.payoutThresholdAmount !== undefined
          ? command.payload.payoutThresholdAmount
          : affiliatePayoutSettings.payoutThresholdAmount,
    },
    commandMeta: {
      commandId: command.commandId,
      idempotencyKey: command.idempotencyKey,
      sideEffects: ["audit_event"],
      outboxEvents: [],
      jobs: [],
    },
  };
}

function paymentSettingsPatchResult(
  command: FinancePaymentSettingsPatchCommand,
  status: "updated" | "idempotent_replay",
): FinancePaymentSettingsPatchResult & { ok: true } {
  return {
    ok: true,
    status,
    settings: {
      ...paymentSettings,
      paymentsEnabled: command.payload.paymentsEnabled ?? paymentSettings.paymentsEnabled,
      paymentProvider: command.payload.paymentProvider ?? paymentSettings.paymentProvider,
      acceptedMethods: command.payload.acceptedMethods ?? paymentSettings.acceptedMethods,
      defaultCurrency: command.payload.defaultCurrency ?? paymentSettings.defaultCurrency,
      supportedCurrencies:
        command.payload.supportedCurrencies ?? paymentSettings.supportedCurrencies,
      depositPolicy: command.payload.depositPolicy ?? paymentSettings.depositPolicy,
      refundPolicy: command.payload.refundPolicy ?? paymentSettings.refundPolicy,
      taxPolicy: command.payload.taxPolicy ?? paymentSettings.taxPolicy,
      statementDescriptor:
        command.payload.statementDescriptor !== undefined
          ? command.payload.statementDescriptor
          : paymentSettings.statementDescriptor,
      requiresManualReview:
        command.payload.requiresManualReview ?? paymentSettings.requiresManualReview,
      providerAccount:
        command.payload.paymentProvider === undefined
          ? paymentSettings.providerAccount
          : {
              ...paymentSettings.providerAccount,
              provider: command.payload.paymentProvider,
            },
    },
    commandMeta: {
      commandId: command.commandId,
      idempotencyKey: command.idempotencyKey,
      sideEffects: ["audit_event"],
      outboxEvents: [],
      jobs: [],
    },
  };
}

function manualPaymentValidationError(
  command: FinanceManualPaymentRecordCommand,
): Extract<FinanceManualPaymentRecordResult, { ok: false }> | null {
  if (command.payload.invoiceId === "inv_2026_paid") {
    return manualPaymentInvalidCommand("Paid invoices cannot accept manual payments.");
  }
  if (command.payload.invoiceId === "inv_2026_voided") {
    return manualPaymentInvalidCommand("Voided invoices cannot accept manual payments.");
  }
  if (command.payload.invoiceId === "inv_2026_paid_zero") {
    return manualPaymentInvalidCommand("Finance invoice has no outstanding balance.");
  }
  if (command.payload.currency !== "EUR") {
    return manualPaymentInvalidCommand("Manual payment currency must match the invoice currency.");
  }
  if (Number(command.payload.amount) > 850) {
    return manualPaymentInvalidCommand("Manual payment amount exceeds the invoice balance.");
  }
  return null;
}

function manualPaymentInvalidCommand(
  message: string,
): Extract<FinanceManualPaymentRecordResult, { ok: false }> {
  return {
    ok: false,
    statusCode: 400,
    code: "invalid_command",
    message,
  };
}

function manualPaymentCommandMeta(
  command: FinanceManualPaymentRecordCommand,
  jobStatus: "queued" | "idempotent_replay",
): FinanceCommandMeta {
  const keyHash = sha256(command.idempotencyKey);
  return {
    commandId: command.commandId,
    idempotencyKey: command.idempotencyKey,
    sideEffects: ["audit_event", "booking_projection_refresh", "pms_projection_refresh"],
    outboxEvents: [
      `finance.manual-payment.booking-projection.property.${command.propertyId}.key.${keyHash}.v1`,
      `finance.manual-payment.pms-projection.property.${command.propertyId}.key.${keyHash}.v1`,
    ],
    jobs: [
      {
        jobType: "booking.projection-refresh",
        idempotencyKey: `booking.projection-refresh:property:${command.propertyId}:booking:${invoiceDetails[0]!.guestBookingId}:finance-payment:${keyHash}:v1`,
        status: jobStatus,
      },
      {
        jobType: "pms.projection-refresh",
        idempotencyKey: `pms.projection-refresh:property:${command.propertyId}:booking:${invoiceDetails[0]!.guestBookingId}:finance-payment:${keyHash}:v1`,
        status: jobStatus,
      },
    ],
  };
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

const emptyFinanceRepository: FinancePropertyReadRepository = {
  async getPaymentSettings() {
    return null;
  },
  async getCancellationPolicy() {
    return null;
  },
};

function financeManagePermissions(): PermissionKey[] {
  return ["pms.finance.read", "pms.operations.manage"];
}

function filterInvoices(query: FinanceInvoiceListQuery): FinanceInvoiceListItem[] {
  const search = query.search?.toLowerCase();
  const filtered = invoiceListItems.filter((invoice) => {
    if (query.status && invoice.status !== query.status) return false;
    if (!search) return true;
    return [
      invoice.invoiceId,
      invoice.invoiceNumber,
      invoice.bookingReference,
      invoice.guest.displayName,
      invoice.guest.email ?? "",
    ].some((value) => value.toLowerCase().includes(search));
  });
  return filtered.toSorted((left, right) => {
    if (query.sort === "guest") {
      return left.guest.displayName.localeCompare(right.guest.displayName);
    }
    if (query.sort === "amount") {
      return Number(right.totalAmount) - Number(left.totalAmount);
    }
    return (
      right.issuedAt.localeCompare(left.issuedAt) ||
      left.invoiceNumber.localeCompare(right.invoiceNumber)
    );
  });
}

function filterPayments(query: FinancePaymentLedgerQuery): FinancePaymentLedgerItem[] {
  const search = query.search?.toLowerCase();
  return paymentLedgerItems.filter((payment) => {
    if (query.status && payment.status !== query.status) return false;
    if (query.provider && payment.provider !== query.provider) return false;
    if (query.method && payment.method !== query.method) return false;
    if (query.from && payment.recordedAt < query.from) return false;
    if (query.to && payment.recordedAt > query.to) return false;
    if (!search) return true;
    return [
      payment.paymentId,
      payment.invoiceId ?? "",
      payment.invoiceNumber ?? "",
      payment.bookingReference ?? "",
      payment.reference ?? "",
    ].some((value) => value.toLowerCase().includes(search));
  });
}

function filterPayouts(query: FinancePayoutListQuery): FinancePayout[] {
  return payoutItems.filter((payout) => {
    if (query.status && payout.payoutStatus !== query.status) return false;
    if (query.provider && payout.provider !== query.provider) return false;
    return true;
  });
}

function filterAffiliatePayouts(query: FinancePayoutListQuery): FinancePayout[] {
  return affiliatePayoutItems.filter((payout) => {
    if (query.status && payout.payoutStatus !== query.status) return false;
    if (query.provider && payout.provider !== query.provider) return false;
    return true;
  });
}

function filterReconciliationItems(
  view: FinanceReconciliationViewKind,
  query: FinanceReconciliationViewQuery,
): FinanceReconciliationItem[] {
  return reconciliationItems[view].filter((item) => {
    if (
      query.status &&
      item.latestReceiptStatus !== query.status &&
      item.jobStatus !== query.status
    ) {
      return false;
    }
    if (query.provider && item.provider !== query.provider) return false;
    return true;
  });
}

function invoiceCounts(invoices: FinanceInvoiceListItem[]): FinanceInvoiceStatusCounts {
  return {
    draft: invoices.filter((invoice) => invoice.status === "draft").length,
    sent: invoices.filter((invoice) => invoice.status === "sent").length,
    paid: invoices.filter((invoice) => invoice.status === "paid").length,
    partial: invoices.filter((invoice) => invoice.status === "partial").length,
    overdue: invoices.filter((invoice) => invoice.status === "overdue").length,
    voided: invoices.filter((invoice) => invoice.status === "voided").length,
  };
}

function queryStrings(query: unknown): Record<string, string> | undefined {
  if (!query || typeof query !== "object") return undefined;
  return Object.fromEntries(
    Object.entries(query as Record<string, unknown>).map(([key, value]) => [key, String(value)]),
  );
}

function pmsFinanceEntitlement(
  resourceType: "pms_property" | "property" = "pms_property",
): ProductEntitlement {
  return {
    product: "pms",
    key: "property-management",
    status: "active",
    resource: {
      product: "pms",
      resourceType,
      resourceId: propertyId,
    },
  };
}

function directBookingFinanceEntitlement(
  resourceType: "pms_property" | "property" = "pms_property",
): ProductEntitlement {
  return {
    product: "booking",
    key: "direct-booking-finance",
    status: "active",
    resource: {
      product: "pms",
      resourceType,
      resourceId: propertyId,
    },
  };
}

function affiliatePayoutEntitlement(
  status: ProductEntitlement["status"] = "active",
): ProductEntitlement {
  return {
    product: "affiliate",
    key: "affiliate-payouts",
    status,
    resource: {
      product: "affiliate",
      resourceType: "affiliate",
      resourceId: affiliateId,
    },
  };
}

function identityRepository(
  options: {
    linkedPropertyId?: string | null;
    linkedResourceType?: "pms_property" | "property";
    linkedAffiliateId?: string | null;
  } = {},
): IdentityRepository {
  return {
    async findUserByProviderUserId() {
      return {
        userId: "user_finance",
        email: "finance@example.com",
        status: "active",
      };
    },
    async findOrganizationByWorkosOrgId() {
      return {
        organizationId: "org_finance",
        workosOrgId: "workos_finance_org",
        kind: "hotel_group",
        status: "active",
      };
    },
    async findActiveMembership() {
      return {
        membershipId: "membership_finance",
        status: "active",
        roleKey: "finance_manager",
        workosMembershipId: "membership_workos_finance",
        workosRoleSlugs: ["finance_manager"],
      };
    },
    async findLinkedResources() {
      const resources = [];
      if (options.linkedPropertyId !== null) {
        resources.push({
          product: "pms",
          resourceType: options.linkedResourceType ?? "pms_property",
          resourceId: options.linkedPropertyId ?? propertyId,
          relationship: "finance_manager",
          status: "active",
        });
      }
      if (options.linkedAffiliateId !== null) {
        resources.push({
          product: "affiliate",
          resourceType: "affiliate",
          resourceId: options.linkedAffiliateId ?? affiliateId,
          relationship: "owner",
          status: "active",
        });
      }
      return [...resources];
    },
  };
}

function affiliateIdentityRepository(): IdentityRepository {
  return {
    async findUserByProviderUserId() {
      return {
        userId: "user_affiliate",
        email: "affiliate@example.test",
        status: "active",
      };
    },
    async findOrganizationByWorkosOrgId() {
      return {
        organizationId: affiliateOrganizationId,
        workosOrgId: "workos_finance_org",
        kind: "affiliate_partner",
        status: "active",
      };
    },
    async findActiveMembership() {
      return {
        membershipId: "membership_affiliate",
        status: "active",
        roleKey: "affiliate_owner",
        workosMembershipId: "membership_workos_affiliate",
        workosRoleSlugs: ["affiliate_owner"],
      };
    },
    async findLinkedResources() {
      return [
        {
          product: "affiliate",
          resourceType: "affiliate",
          resourceId: affiliateId,
          relationship: "owner",
          status: "active",
        },
      ];
    },
  };
}

function assertIncludes(body: unknown, paths: string[], caseId: string): void {
  for (const path of paths) {
    expect(readContractPath(body, path), `${caseId}: ${path}`).not.toBeUndefined();
  }
}

function assertExcludes(body: unknown, keys: string[], caseId: string): void {
  const serialized = JSON.stringify(body);
  for (const key of keys) {
    expect(serialized, `${caseId}: ${key}`).not.toContain(key);
  }
}

function assertEnums(body: unknown, enums: Record<string, string[]>, caseId: string): void {
  for (const [path, allowed] of Object.entries(enums)) {
    if (path.endsWith("[]")) {
      const value = readContractPath(body, path.slice(0, -2));
      expect(Array.isArray(value), `${caseId}: ${path}`).toBe(true);
      for (const entry of value as unknown[]) {
        expect(allowed, `${caseId}: ${path}`).toContain(entry);
      }
    }
  }
}

function readContractPath(value: unknown, path: string): unknown {
  return path.split(".").reduce<unknown>((current, segment) => {
    if (current === undefined || current === null) return undefined;
    const arrayMatch = /^(.+)\[(\d+)\]$/.exec(segment);
    if (arrayMatch) {
      const [, key, index] = arrayMatch;
      const arrayValue = (current as Record<string, unknown>)[key!];
      return Array.isArray(arrayValue) ? arrayValue[Number(index)] : undefined;
    }
    return (current as Record<string, unknown>)[segment];
  }, value);
}
