/**
 * domain-finance — Finance domain contracts.
 *
 * This package defines the target read models and commands for payment
 * settings, billing plan configuration, currency, payout split calculation,
 * and add-on pricing — the fields previously accessed by PMS API services via
 * a cross-domain `BookingEngineDatabase` pool.
 *
 * Owner: Finance domain.
 * Migration note: the authoritative data currently lives in `booking_hotels`
 * (payment flags, billing plan, fee percentages, currency, add-ons) and
 * `pms.hotel_payment_settings`.  After VAY-605 cutover, finance-owned tables
 * become the single source of truth and PMS must consume this package's ports.
 *
 * Rules:
 * - PMS target code must never open a BookingEngineDatabase pool to read
 *   payment or billing data.  Use the read ports defined here instead.
 * - Cross-domain writes to payment settings are expressed as commands with
 *   explicit idempotency keys and audit trails.
 * - Payout account numbers, IBAN, SWIFT, and payment-provider secrets are
 *   NOT part of any public or cross-domain read model — they are accessed only
 *   through permissioned finance services.
 */

import type { FinancePlatformAffiliatePayoutRepository } from "./platformAffiliatePayouts.js";
import { FINANCE_ONLINE_CARD_EXECUTION_EVIDENCE_CONTRACT_VERSION } from "./paymentReadiness.js";

export * from "./paymentReadiness.js";
export * from "./paymentReadinessParsing.js";
export * from "./paymentReadinessSnapshot.js";
export * from "./manualBookingSettlement.js";
export * from "./subscriptions.js";
export * from "./platformAffiliatePayouts.js";
export * from "./affiliateCommission.js";
export * from "./otaCommissionRules.js";
export * from "./financialExpenses.js";
export * from "./financialFolios.js";
export * from "./generatedExpenses.js";

// ---------------------------------------------------------------------------
// Scalar aliases
// ---------------------------------------------------------------------------

export type FinancePropertyId = string;
export type FinanceAffiliateId = string;
export type FinanceUtcDateTime = string;
export type FinanceCurrencyCode = string;
export type FinanceContractVersion = "finance-route-contracts.v1";

/** Decimal representation of a monetary amount, e.g. "150.00". */
export type FinanceDecimalAmount = string;

export const FINANCE_ROUTE_CONTRACT_VERSION =
  "finance-route-contracts.v1" as const satisfies FinanceContractVersion;

// ---------------------------------------------------------------------------
// Billing plan
// ---------------------------------------------------------------------------

export const FINANCE_BILLING_PLANS = ["fixed", "commission"] as const;

export type FinanceBillingPlan = (typeof FINANCE_BILLING_PLANS)[number];

export type PropertyFeatureLimits = {
  maxRoomPhotosPerType: number;
  maxAddons: number;
  guestContactAccess: "after_acceptance" | "always";
};

export const PROPERTY_FEATURE_LIMITS = {
  commission: {
    maxRoomPhotosPerType: 10,
    maxAddons: 3,
    guestContactAccess: "after_acceptance",
  },
  fixed: {
    maxRoomPhotosPerType: 15,
    maxAddons: 9,
    guestContactAccess: "always",
  },
} as const satisfies Record<FinanceBillingPlan, PropertyFeatureLimits>;

export type PropertyPlanReadModel = {
  propertyId: FinancePropertyId;
  plan: FinanceBillingPlan;
  limits: PropertyFeatureLimits;
};

export function propertyFeatureLimitsFor(plan: FinanceBillingPlan): PropertyFeatureLimits {
  return PROPERTY_FEATURE_LIMITS[plan];
}

// ---------------------------------------------------------------------------
// Payment method tokens
//
// These token strings correspond to the flags previously stored in
// `booking_hotels` (pay_at_property_enabled, online_card_payment,
// bank_transfer, paypal_enabled).  Finance owns which methods are enabled;
// booking/checkout reads this through the PaymentSettingsReadPort.
// ---------------------------------------------------------------------------

export const FINANCE_PAYMENT_METHODS = [
  "card",
  "pay_at_property",
  "bank_transfer",
  "paypal",
] as const;

export type FinancePaymentMethod = (typeof FINANCE_PAYMENT_METHODS)[number];

export const FINANCE_ROUTE_PAYMENT_PROVIDERS = [
  "stripe",
  "xendit",
  "vayada",
  "manual",
  "bank_transfer",
] as const;

export type FinanceRoutePaymentProvider = (typeof FINANCE_ROUTE_PAYMENT_PROVIDERS)[number];

export const FINANCE_PROVIDER_ACCOUNT_COMMAND_SIDE_EFFECTS = [
  "audit_event",
  "reconciliation_job",
  "provider_compensation",
] as const;

export type FinanceProviderAccountCommandSideEffect =
  (typeof FINANCE_PROVIDER_ACCOUNT_COMMAND_SIDE_EFFECTS)[number];

export const FINANCE_ROUTE_PAYMENT_METHODS = [
  "card",
  "pay_at_property",
  "xendit",
  "cash",
  "bank_transfer",
  "paypal",
  "manual_card",
  "wallet",
  "other",
] as const;

export type FinanceRoutePaymentMethod = (typeof FINANCE_ROUTE_PAYMENT_METHODS)[number];

export const FINANCE_PROVIDER_ACCOUNT_STATUSES = [
  "setup_incomplete",
  "pending",
  "active",
  "restricted",
  "suspended",
  "disabled",
] as const;

export type FinanceProviderAccountStatus = (typeof FINANCE_PROVIDER_ACCOUNT_STATUSES)[number];

export const FINANCE_PROVIDER_ONBOARDING_STATUSES = [
  "not_started",
  "invited",
  "in_review",
  "completed",
  "requires_action",
] as const;

export type FinanceProviderOnboardingStatus = (typeof FINANCE_PROVIDER_ONBOARDING_STATUSES)[number];

// ---------------------------------------------------------------------------
// Payment settings read model
//
// Replaces PMS reads of `booking_hotels.pay_at_property_enabled`,
// `online_card_payment`, `bank_transfer`, `paypal_enabled`, and
// `instant_book`.  Does NOT include account numbers, IBAN, or credentials —
// those stay behind permissioned finance read models.
// ---------------------------------------------------------------------------

export type PaymentSettingsReadModel = {
  propertyId: FinancePropertyId;
  /** Which payment methods are currently enabled for this property. */
  enabledPaymentMethods: FinancePaymentMethod[];
  /** Whether the booking engine shows an "instant book" CTA. */
  instantBook: boolean;
  /** Default transaction currency for this property. */
  defaultCurrency: FinanceCurrencyCode;
  /** All currencies the property accepts (includes defaultCurrency). */
  supportedCurrencies: FinanceCurrencyCode[];
  updatedAt: FinanceUtcDateTime;
};

export type FinanceJsonPolicy = Record<string, string | number | boolean | null>;
export type FinanceJsonObject = Record<string, FinanceJsonValue>;
export type FinanceJsonValue =
  string | number | boolean | null | FinanceJsonValue[] | { [key: string]: FinanceJsonValue };

export type FinanceProviderAccountReadModel = {
  providerAccountId: string | null;
  provider: FinanceRoutePaymentProvider | null;
  status: FinanceProviderAccountStatus;
  onboardingStatus: FinanceProviderOnboardingStatus;
  chargesEnabled: boolean;
  payoutsEnabled: boolean;
  capabilities: string[];
};

export type FinanceAffiliatePayoutProvider = "stripe" | "manual" | "bank_transfer";
export type FinanceAffiliatePayoutSchedule = "manual" | "monthly" | "threshold";

export type FinanceAffiliatePayoutSettingsReadModel = {
  affiliateId: FinanceAffiliateId;
  marketplaceOrganizationId: string | null;
  payoutsEnabled: boolean;
  payoutProvider: FinanceAffiliatePayoutProvider;
  payoutCurrency: FinanceCurrencyCode;
  payoutSchedule: FinanceAffiliatePayoutSchedule;
  payoutThresholdAmount: FinanceDecimalAmount | null;
  providerAccount: Pick<
    FinanceProviderAccountReadModel,
    "providerAccountId" | "status" | "onboardingStatus" | "payoutsEnabled"
  > & {
    provider: FinanceAffiliatePayoutProvider | null;
  };
  sourceFreshness: FinanceJsonPolicy;
  updatedAt: FinanceUtcDateTime;
};

export type FinanceAffiliatePayoutSettingsResponse = {
  contractVersion: FinanceContractVersion;
  affiliateId: FinanceAffiliateId;
  marketplaceOrganizationId: string | null;
  payoutSettings: Omit<
    FinanceAffiliatePayoutSettingsReadModel,
    "affiliateId" | "marketplaceOrganizationId" | "updatedAt"
  >;
};

export type FinancePaymentSettingsReadModel = {
  propertyId: FinancePropertyId;
  paymentsEnabled: boolean;
  paymentProvider: FinanceRoutePaymentProvider;
  acceptedMethods: FinanceRoutePaymentMethod[];
  defaultCurrency: FinanceCurrencyCode;
  supportedCurrencies: FinanceCurrencyCode[];
  depositPolicy: FinanceJsonPolicy;
  refundPolicy: FinanceJsonPolicy;
  taxPolicy: FinanceJsonPolicy;
  statementDescriptor: string | null;
  requiresManualReview: boolean;
  providerAccount: FinanceProviderAccountReadModel;
  sourceFreshness: FinanceJsonPolicy;
  updatedAt: FinanceUtcDateTime;
};

export type FinancePaymentSettingsResponse = {
  contractVersion: FinanceContractVersion;
  propertyId: FinancePropertyId;
  paymentSettings: Omit<FinancePaymentSettingsReadModel, "propertyId" | "updatedAt">;
};

export type FinancePaymentSettingsPatchPayload = Partial<
  Pick<
    FinancePaymentSettingsReadModel,
    | "paymentsEnabled"
    | "paymentProvider"
    | "acceptedMethods"
    | "defaultCurrency"
    | "supportedCurrencies"
    | "depositPolicy"
    | "refundPolicy"
    | "taxPolicy"
    | "statementDescriptor"
    | "requiresManualReview"
  >
>;

export type FinancePaymentSettingsPatchCommand = {
  commandType: "finance.payment_settings.update";
  commandId: string;
  idempotencyKey: string;
  propertyId: FinancePropertyId;
  audit: FinanceCommandAudit;
  payload: FinancePaymentSettingsPatchPayload;
};

export type FinancePaymentSettingsPatchResult =
  | {
      ok: true;
      status: "updated" | "idempotent_replay";
      settings: FinancePaymentSettingsReadModel;
      commandMeta: FinanceCommandMeta;
    }
  | {
      ok: false;
      statusCode: 400 | 404 | 409 | 500;
      code:
        | "invalid_command"
        | "property_not_found"
        | "property_currency_conflict"
        | "idempotency_conflict"
        | "write_unavailable";
      message: string;
    };

export type FinancePaymentSettingsPatchResponse = FinancePaymentSettingsResponse & {
  commandMeta: FinanceCommandMeta;
};

export type CancellationPolicy = {
  freeCancellationDays: number;
  partialRefundPercent: number;
  refundMethod: "original_payment" | "manual_review" | "property_discretion";
  appliesTo: "direct_booking" | "all_guest_bookings";
  updatedAt: FinanceUtcDateTime;
};

export type FinanceCancellationPolicyResponse = {
  contractVersion: FinanceContractVersion;
  propertyId: FinancePropertyId;
  policy: CancellationPolicy;
};

export type PublicPaymentCapabilityProjection = {
  paymentMethods: FinanceRoutePaymentMethod[];
  defaultCurrency: FinanceCurrencyCode;
  supportedCurrencies: FinanceCurrencyCode[];
  depositPolicy: FinanceJsonPolicy;
  cancellationPolicy: Omit<CancellationPolicy, "updatedAt">;
};

export const FINANCE_PAYOUT_STATUSES = [
  "pending",
  "scheduled",
  "processing",
  "paid",
  "failed",
  "canceled",
  "reversed",
] as const;

export type FinancePayoutStatus = (typeof FINANCE_PAYOUT_STATUSES)[number];

export const FINANCE_RECONCILIATION_RECEIPT_STATUSES = [
  "matched",
  "missing",
  "stale",
  "dead_lettered",
  "not_applicable",
] as const;

export type FinanceReconciliationReceiptStatus =
  (typeof FINANCE_RECONCILIATION_RECEIPT_STATUSES)[number];

export const FINANCE_RECONCILIATION_JOB_STATUSES = [
  "idle",
  "queued",
  "running",
  "failed",
  "dead_lettered",
] as const;

export type FinanceReconciliationJobStatus = (typeof FINANCE_RECONCILIATION_JOB_STATUSES)[number];

export const FINANCE_RECONCILIATION_RECOMMENDED_ACTIONS = [
  "none",
  "enqueue_reconcile",
  "manual_review",
  "refresh_provider_state",
] as const;

export type FinanceReconciliationRecommendedAction =
  (typeof FINANCE_RECONCILIATION_RECOMMENDED_ACTIONS)[number];

export const FINANCE_RECONCILIATION_SUBJECT_TYPES = [
  "payment",
  "payout",
  "provider_account",
] as const;

export type FinanceReconciliationSubjectType =
  (typeof FINANCE_RECONCILIATION_SUBJECT_TYPES)[number];

export type FinancePayout = {
  payoutId: string;
  ownerScope: "property" | "organization" | "platform";
  propertyId: string | null;
  organizationId: string | null;
  relatedPropertyId: string | null;
  guestBookingId: string | null;
  paymentId: string | null;
  payoutStatus: FinancePayoutStatus;
  amount: FinanceDecimalAmount;
  feeAmount: FinanceDecimalAmount;
  netAmount: FinanceDecimalAmount;
  currency: FinanceCurrencyCode;
  provider: FinanceRoutePaymentProvider;
  providerPayoutId: string | null;
  scheduledAt: FinanceUtcDateTime | null;
  paidAt: FinanceUtcDateTime | null;
  failedAt: FinanceUtcDateTime | null;
  failureCode: string | null;
  retryCount: number;
};

export type FinancePayoutListQuery = {
  status?: FinancePayoutStatus;
  provider?: FinanceRoutePaymentProvider;
  limit: number;
  offset: number;
};

export type FinancePayoutListResponse = {
  contractVersion: FinanceContractVersion;
  propertyId: FinancePropertyId;
  payouts: FinancePayout[];
  total: number;
  limit: number;
  offset: number;
  sourceFreshness: FinanceJsonObject;
};

export type FinanceAffiliatePayoutListResponse = {
  contractVersion: FinanceContractVersion;
  affiliateId: FinanceAffiliateId;
  payouts: FinancePayout[];
  total: number;
  limit: number;
  offset: number;
  sourceFreshness: FinanceJsonObject;
};

export type FinanceReconciliationItem = {
  subjectId: string;
  subjectType: FinanceReconciliationSubjectType;
  provider: FinanceRoutePaymentProvider;
  financeStatus: string;
  providerStatus: string | null;
  latestReceiptStatus: FinanceReconciliationReceiptStatus;
  jobStatus: FinanceReconciliationJobStatus;
  recommendedAction: FinanceReconciliationRecommendedAction;
  lastReceiptAt: FinanceUtcDateTime | null;
  lastJobAt: FinanceUtcDateTime | null;
};

export type FinanceReconciliationViewKind = "payments" | "payouts" | "provider-accounts";

export type FinanceReconciliationViewQuery = {
  status?: FinanceReconciliationReceiptStatus | FinanceReconciliationJobStatus;
  provider?: FinanceRoutePaymentProvider;
  limit: number;
  offset: number;
};

export type FinanceReconciliationViewResponse = {
  contractVersion: FinanceContractVersion;
  propertyId: FinancePropertyId;
  items: FinanceReconciliationItem[];
  total: number;
  limit: number;
  offset: number;
  sourceFreshness: FinanceJsonObject;
};

export const FINANCE_COMMAND_SIDE_EFFECTS = [
  "audit_event",
  "provider_validation",
  "reconciliation_job",
  "payout_job",
] as const;

export type FinanceCommandSideEffect = (typeof FINANCE_COMMAND_SIDE_EFFECTS)[number];

export type FinanceProviderAccountRefreshJob = {
  jobType: "pms.projection-refresh";
  idempotencyKey: string;
  status: "queued" | "idempotent_replay";
};

export type FinanceReconcilePayoutJob = {
  jobType: "finance.reconcile-payout";
  idempotencyKey: string;
  status: "queued" | "idempotent_replay";
};

export type FinanceDispatchPropertyPayoutJob = {
  jobType: "finance.dispatch-property-payout";
  payoutId: string;
  provider: FinanceRoutePaymentProvider;
  idempotencyKey: string;
  status: "queued" | "idempotent_replay";
};

export type FinanceDispatchAffiliatePayoutJob = {
  jobType: "finance.dispatch-affiliate-payout";
  payoutId: string;
  affiliateId: FinanceAffiliateId;
  provider: FinanceAffiliatePayoutProvider;
  idempotencyKey: string;
  status: "queued" | "idempotent_replay";
};

export type FinanceCommandJob =
  | FinanceProviderAccountRefreshJob
  | FinanceReconcilePayoutJob
  | FinanceDispatchPropertyPayoutJob
  | FinanceDispatchAffiliatePayoutJob;

export type FinanceCommandMeta = {
  commandId: string;
  idempotencyKey: string;
  sideEffects: FinanceCommandSideEffect[];
  outboxEvents: string[];
  jobs: FinanceCommandJob[];
};

export type FinanceProviderAccountCommandMeta = Omit<FinanceCommandMeta, "sideEffects"> & {
  sideEffects: FinanceProviderAccountCommandSideEffect[];
};

export type FinanceProviderAccountOwnerScope = "property" | "affiliate";

export type FinanceProviderAccountOwner =
  | {
      ownerScope: "property";
      propertyId: FinancePropertyId;
      organizationId: string | null;
    }
  | {
      ownerScope: "affiliate";
      affiliateId: string;
      organizationId: string;
    };

export type CreateStripeProviderAccountPayload = {
  email: string;
  country: string;
  returnSurface?: "marketplace" | "booking_admin";
};

export type CreateStripePropertyAccountCommand = FinanceCommandBase<
  "finance.provider_account.stripe.create",
  CreateStripeProviderAccountPayload
>;

export type CreateStripeAffiliateAccountCommand = Omit<
  FinanceCommandBase<"finance.provider_account.stripe.create", CreateStripeProviderAccountPayload>,
  "propertyId"
> & {
  affiliateId: string;
  organizationId: string;
};

export type CreateStripeProviderAccountCommand =
  CreateStripePropertyAccountCommand | CreateStripeAffiliateAccountCommand;

export type IssueStripeOnboardingLinkPayload = {
  providerAccountId: string;
  returnSurface?: "marketplace" | "booking_admin";
};

export type IssueStripePropertyOnboardingLinkCommand = FinanceCommandBase<
  "finance.provider_account.stripe.onboarding_link.issue",
  IssueStripeOnboardingLinkPayload
>;

export type IssueStripeAffiliateOnboardingLinkCommand = Omit<
  FinanceCommandBase<
    "finance.provider_account.stripe.onboarding_link.issue",
    IssueStripeOnboardingLinkPayload
  >,
  "propertyId"
> & {
  affiliateId: string;
  organizationId: string;
};

export type IssueStripeOnboardingLinkCommand =
  IssueStripePropertyOnboardingLinkCommand | IssueStripeAffiliateOnboardingLinkCommand;

export type ReconcileStripePropertyAccountCommand = FinanceCommandBase<
  "finance.provider_account.stripe.reconcile",
  Record<string, never>
>;

export type FinanceStripeProviderAccountReconciliationResponse = {
  contractVersion: FinanceContractVersion;
  propertyId: FinancePropertyId;
  providerAccount: {
    provider: "stripe";
    status: "active" | "setup_incomplete";
    onboardingStatus: "completed" | "invited";
    chargesEnabled: boolean;
    payoutsEnabled: boolean;
    detailsSubmitted: boolean;
    cardPaymentsStatus: string | null;
    ready: boolean;
  };
  commandMeta: FinanceCommandMeta;
};

export type FinanceStripeProviderAccountReconciliationResult =
  | {
      ok: true;
      status: "reconciled" | "idempotent_replay";
      response: FinanceStripeProviderAccountReconciliationResponse;
    }
  | {
      ok: false;
      statusCode: 404 | 409 | 500 | 502;
      code:
        | "provider_account_not_found"
        | "idempotency_conflict"
        | "write_unavailable"
        | "provider_unavailable";
      message: string;
    };

export type AcceptFinanceOnlineCardExecutionEvidenceCommand = FinanceCommandBase<
  "finance.online_card_execution_evidence.accept",
  {
    expectedCardCapabilityRevision: number;
    expectedPropertyReadinessRevision: number;
    evidenceFingerprintHash: string;
    executedAt: FinanceUtcDateTime;
  }
>;

export type RevokeFinanceOnlineCardExecutionEvidenceCommand = FinanceCommandBase<
  "finance.online_card_execution_evidence.revoke",
  { evidenceId: string }
>;

export type FinanceOnlineCardExecutionEvidenceResponse = {
  contractVersion: typeof FINANCE_ONLINE_CARD_EXECUTION_EVIDENCE_CONTRACT_VERSION;
  propertyId: FinancePropertyId;
  evidenceId: string;
  providerCapabilityRevision: number;
  propertyReadinessRevision: number;
  status: "accepted" | "revoked";
  acceptedAt: FinanceUtcDateTime;
  revokedAt: FinanceUtcDateTime | null;
  cardReady: boolean;
  commandMeta: FinanceCommandMeta;
};

export type FinanceOnlineCardExecutionEvidenceResult =
  | {
      ok: true;
      status: "accepted" | "revoked" | "idempotent_replay";
      response: FinanceOnlineCardExecutionEvidenceResponse;
    }
  | {
      ok: false;
      statusCode: 400 | 404 | 409 | 500;
      code:
        | "invalid_command"
        | "provider_account_not_found"
        | "provider_capability_revision_conflict"
        | "property_readiness_revision_conflict"
        | "provider_capability_unavailable"
        | "evidence_not_found"
        | "idempotency_conflict"
        | "write_unavailable";
      message: string;
    };

export type FinancePlatformOnlineCardExecutionEvidenceRepository = {
  acceptOnlineCardExecutionEvidence(
    command: AcceptFinanceOnlineCardExecutionEvidenceCommand,
  ): Promise<FinanceOnlineCardExecutionEvidenceResult>;
  revokeOnlineCardExecutionEvidence(
    command: RevokeFinanceOnlineCardExecutionEvidenceCommand,
  ): Promise<FinanceOnlineCardExecutionEvidenceResult>;
};

export type FinanceProviderAccountCommandResponse = {
  contractVersion: FinanceContractVersion;
  providerAccountId: string;
  provider: "stripe" | "xendit";
  providerAccountRef: string;
  status: FinanceProviderAccountStatus;
  onboardingStatus: FinanceProviderOnboardingStatus;
  onboardingUrl: string;
  commandMeta: FinanceProviderAccountCommandMeta;
};

export type FinanceProviderAccountCommandResult =
  | {
      ok: true;
      status: "created" | "idempotent_replay" | "existing_owner_account";
      response: FinanceProviderAccountCommandResponse;
    }
  | {
      ok: false;
      statusCode: 400 | 404 | 409 | 500 | 502;
      code:
        | "invalid_command"
        | "provider_account_not_found"
        | "idempotency_conflict"
        | "write_unavailable"
        | "provider_unavailable"
        | "provider_rejected";
      message: string;
    };

export type StripeConnectAccountCreateRequest = {
  owner: FinanceProviderAccountOwner;
  email: string;
  country: string;
  idempotencyKey: string;
  returnSurface?: "marketplace" | "booking_admin";
};

export type StripeConnectOnboardingLinkRequest = {
  owner: FinanceProviderAccountOwner;
  providerAccountRef: string;
  idempotencyKey: string;
  returnSurface?: "marketplace" | "booking_admin";
};

export type StripeConnectCompensationRequest = {
  owner: FinanceProviderAccountOwner;
  providerAccountRef: string;
  reason: "db_write_failed";
  idempotencyKey: string;
};

export type StripeConnectProviderAccount = {
  providerAccountRef: string;
  onboardingUrl: string;
};

export type StripeConnectProviderAccountSnapshot = {
  providerAccountRef: string;
  chargesEnabled: boolean;
  payoutsEnabled: boolean;
  detailsSubmitted: boolean;
  cardPaymentsStatus: string | null;
  defaultCurrency: string | null;
};

export class StripeConnectAccountNotFoundError extends Error {
  readonly code = "stripe_connect_account_not_found";
}

export type FinanceStripeDashboardLoginLinkResult =
  | { ok: true; url: string }
  | {
      ok: false;
      statusCode: 404 | 502;
      code: "provider_account_not_found" | "provider_unavailable";
      message: string;
    };

export type FinanceStripeConnectProvider = {
  createAccount(request: StripeConnectAccountCreateRequest): Promise<StripeConnectProviderAccount>;
  createOnboardingLink(request: StripeConnectOnboardingLinkRequest): Promise<string>;
  createLoginLink(request: { providerAccountRef: string }): Promise<string>;
  retrieveAccount(request: {
    providerAccountRef: string;
  }): Promise<StripeConnectProviderAccountSnapshot>;
  compensateAccountCreation?(request: StripeConnectCompensationRequest): Promise<void>;
};

export type XenditBankValidationPayload = {
  channelCode: string;
  accountNumber: string;
  accountHolderName: string;
};

export type FinanceXenditBankValidationCommand = FinanceCommandBase<
  "finance.xendit_bank_account.validate",
  XenditBankValidationPayload
>;

export type FinanceXenditBankValidationResponse = {
  contractVersion: FinanceContractVersion;
  propertyId: FinancePropertyId;
  provider: "xendit";
  validation: {
    status: "valid" | "invalid" | "unknown";
    maskedAccountNumber: string;
    accountHolderName: string | null;
    providerReference: string | null;
  };
  commandMeta: FinanceCommandMeta;
};

export type FinanceXenditPayoutReconciliationPayload = {
  olderThanMinutes: number;
};

export type FinanceXenditPayoutReconciliationCommand = FinanceCommandBase<
  "finance.xendit_payouts.reconcile",
  FinanceXenditPayoutReconciliationPayload
>;

export type FinanceXenditPayoutReconciliationResult =
  | {
      ok: true;
      status: "queued" | "idempotent_replay";
      job: Extract<FinanceCommandJob, { jobType: "finance.reconcile-payout" }>;
      legacyDisposition: string;
      commandMeta: FinanceCommandMeta;
    }
  | {
      ok: false;
      statusCode: 400 | 409 | 500;
      code: "invalid_command" | "idempotency_conflict" | "write_unavailable";
      message: string;
    };

export type FinanceXenditPayoutReconciliationResponse = {
  contractVersion: FinanceContractVersion;
  propertyId: FinancePropertyId;
  job: Extract<FinanceCommandJob, { jobType: "finance.reconcile-payout" }>;
  legacyDisposition: string;
  commandMeta: FinanceCommandMeta;
};

export type FinancePropertyPayoutDispatchPayload = {
  payoutId: string;
  legacySchedulerFrozenAt: FinanceUtcDateTime;
  reconciliationReadyAt: FinanceUtcDateTime;
};

export type FinancePropertyPayoutDispatchCommand = FinanceCommandBase<
  "finance.property_payout.dispatch",
  FinancePropertyPayoutDispatchPayload
>;

export type FinancePropertyPayoutDispatchReadiness = {
  payoutId: string;
  reconciliationReady: boolean;
  legacySchedulerFrozen: boolean;
  activeLegacyTransferWindow: boolean;
  existingProviderPayoutId: string | null;
  provider: FinanceRoutePaymentProvider | null;
  blockingReasons: string[];
};

export type FinancePropertyPayoutDispatchResult =
  | {
      ok: true;
      status: "queued" | "idempotent_replay";
      job: Extract<FinanceCommandJob, { jobType: "finance.dispatch-property-payout" }>;
      readiness: FinancePropertyPayoutDispatchReadiness;
      legacyDisposition: string;
      rollbackRule: string;
      commandMeta: FinanceCommandMeta;
    }
  | {
      ok: false;
      statusCode: 400 | 404 | 409 | 500;
      code:
        | "invalid_command"
        | "payout_not_found"
        | "reconciliation_not_ready"
        | "legacy_scheduler_not_frozen"
        | "active_legacy_transfer_window"
        | "payout_already_dispatched"
        | "idempotency_conflict"
        | "write_unavailable";
      message: string;
    };

export type FinancePropertyPayoutDispatchResponse = {
  contractVersion: FinanceContractVersion;
  propertyId: FinancePropertyId;
  job: Extract<FinanceCommandJob, { jobType: "finance.dispatch-property-payout" }>;
  readiness: FinancePropertyPayoutDispatchReadiness;
  legacyDisposition: string;
  rollbackRule: string;
  commandMeta: FinanceCommandMeta;
};

export type FinanceAffiliatePayoutSettingsPatchPayload = {
  payoutsEnabled?: boolean;
  payoutProvider?: FinanceAffiliatePayoutProvider;
  payoutCurrency?: FinanceCurrencyCode;
  payoutSchedule?: FinanceAffiliatePayoutSchedule;
  payoutThresholdAmount?: FinanceDecimalAmount | null;
};

export type FinanceAffiliatePayoutSettingsPatchCommand = {
  commandType: "finance.affiliate_payout_settings.update";
  commandId: string;
  idempotencyKey: string;
  affiliateId: FinanceAffiliateId;
  audit: FinanceCommandAudit;
  payload: FinanceAffiliatePayoutSettingsPatchPayload;
};

export type FinanceAffiliatePayoutSettingsPatchResult =
  | {
      ok: true;
      status: "updated" | "idempotent_replay";
      settings: FinanceAffiliatePayoutSettingsReadModel;
      commandMeta: FinanceCommandMeta;
    }
  | {
      ok: false;
      statusCode: 400 | 404 | 409 | 500;
      code:
        "invalid_command" | "affiliate_not_found" | "idempotency_conflict" | "write_unavailable";
      message: string;
    };

// ---------------------------------------------------------------------------
// Billing config read model
//
// Replaces PMS reads of `booking_hotels.billing_active_plan`,
// `booking_engine_fee_pct`, `channel_manager_fee_pct`, and
// `affiliate_platform_fee_pct` (currently used by payout_service.py).
// ---------------------------------------------------------------------------

export type BillingConfigReadModel = {
  propertyId: FinancePropertyId;
  activePlan: FinanceBillingPlan;
  /**
   * Platform fee percentage charged on direct bookings under a commission plan.
   * Zero on fixed plans unless an affiliate is involved.
   */
  bookingEngineFeePercent: number;
  /**
   * Platform fee percentage charged on OTA / channel-manager bookings under a
   * commission plan.
   */
  channelManagerFeePercent: number;
  /**
   * Extra platform fee charged on any booking that includes an affiliate
   * referral under a fixed plan.
   */
  affiliatePlatformFeePercent: number;
  updatedAt: FinanceUtcDateTime;
};

// ---------------------------------------------------------------------------
// Add-on read model
//
// Replaces PMS reads of `booking_addons` for price/currency display.
// Add-on configuration ownership stays in the Booking domain; Finance
// exposes the pricing surface consumed by checkout and PMS financial views.
// ---------------------------------------------------------------------------

export type AddOnPricingReadModel = {
  addOnId: string;
  propertyId: FinancePropertyId;
  /** Human-readable label in the property default locale. */
  name: string;
  price: FinanceDecimalAmount;
  currency: FinanceCurrencyCode;
  updatedAt: FinanceUtcDateTime;
};

// ---------------------------------------------------------------------------
// PMS checkout-charge settlement bridge
// ---------------------------------------------------------------------------

export type ManualCheckoutChargePaymentMethod =
  | "cash"
  | "card"
  | "pay_at_property"
  | "bank_transfer"
  | "paypal"
  | "manual_card"
  | "xendit"
  | "other";

export type SettleManualCheckoutChargePayload = {
  guestBookingId: string;
  checkoutChargeId: string;
  amount: FinanceDecimalAmount;
  currency: FinanceCurrencyCode;
  paymentMethod: ManualCheckoutChargePaymentMethod;
  reference?: string | null;
  markedPaidAt: FinanceUtcDateTime;
  operatorUserId: string;
  pmsCommandId: string;
};

// ---------------------------------------------------------------------------
// Payout split result
//
// Pure value type for the output of the billing split calculation.
// Replaces the ad-hoc dict returned by payout_service.calculate_split().
// ---------------------------------------------------------------------------

export type PayoutSplitResult = {
  /** Share retained by the Vayada platform. */
  platformFee: FinanceDecimalAmount;
  /** Commission paid to the affiliate referrer (0 when no affiliate). */
  affiliateCommission: FinanceDecimalAmount;
  /** Net amount transferred to the property. */
  propertyPayout: FinanceDecimalAmount;
};

// ---------------------------------------------------------------------------
// Payout split input
//
// Typed input for the deterministic split calculation, replacing the loose
// dict arguments in payout_service.calculate_split().
// ---------------------------------------------------------------------------

export const FINANCE_BOOKING_CHANNELS = ["direct", "channel"] as const;

export type FinanceBookingChannel = (typeof FINANCE_BOOKING_CHANNELS)[number];

export type PayoutSplitInput = {
  /** Total booking amount (pre-split). */
  totalAmount: FinanceDecimalAmount;
  currency: FinanceCurrencyCode;
  billingConfig: BillingConfigReadModel;
  /**
   * Channel that originated the booking.
   *
   * Mapping note: domain-pms uses the token `"direct_booking"` for the same
   * concept.  Adapters must translate `"direct_booking"` → `"direct"` before
   * passing a split input to this package.  The distinction is intentional:
   * domain-finance uses the shortest unambiguous token; domain-pms preserves
   * the legacy Channex-sourced channel name.
   */
  channel: FinanceBookingChannel;
  affiliate?: {
    affiliateId: string;
    /** Agreed commission rate for this affiliate in percent. */
    commissionPercent: number;
  } | null;
};

// ---------------------------------------------------------------------------
// Finance read ports
//
// TypeScript PMS code consumes these ports instead of querying the
// BookingEngineDatabase directly.
// ---------------------------------------------------------------------------

export type PaymentSettingsReadPort = {
  /**
   * Fetch payment settings for a property.
   * Returns null when the property has no finance configuration yet.
   */
  getPaymentSettings(propertyId: FinancePropertyId): Promise<PaymentSettingsReadModel | null>;
};

export type BillingConfigReadPort = {
  /**
   * Fetch billing plan and fee configuration for a property.
   * Returns null when no billing row exists (treat as configuration error
   * rather than silently applying defaults — callers must handle this case
   * explicitly and log it, as mis-billing is worse than an explicit error).
   */
  getBillingConfig(propertyId: FinancePropertyId): Promise<BillingConfigReadModel | null>;
};

export type AddOnPricingReadPort = {
  /**
   * List all add-ons for a property with current pricing.
   * Returns an empty array when the property has no add-ons.
   */
  listAddOnPricing(propertyId: FinancePropertyId): Promise<AddOnPricingReadModel[]>;
};

export type FinancePropertySettingsReadRepository = {
  /**
   * Fetch target Finance payment settings for a property.
   * Returns null when the property has no finance configuration yet.
   */
  getPaymentSettings(
    propertyId: FinancePropertyId,
  ): Promise<FinancePaymentSettingsReadModel | null>;

  /**
   * Fetch the cancellation policy derived from Finance-owned policy fields.
   * Returns null when the property has no finance configuration yet.
   */
  getCancellationPolicy(propertyId: FinancePropertyId): Promise<CancellationPolicy | null>;

  close?(): Promise<void>;
};

export type FinancePropertyOperationsReadRepository = {
  listPayouts(
    propertyId: FinancePropertyId,
    query: FinancePayoutListQuery,
  ): Promise<Omit<FinancePayoutListResponse, "contractVersion" | "propertyId">>;

  listReconciliationItems(
    propertyId: FinancePropertyId,
    view: FinanceReconciliationViewKind,
    query: FinanceReconciliationViewQuery,
  ): Promise<Omit<FinanceReconciliationViewResponse, "contractVersion" | "propertyId">>;
};

export type FinancePropertyCommandRepository = {
  updatePaymentSettings(
    command: FinancePaymentSettingsPatchCommand,
  ): Promise<FinancePaymentSettingsPatchResult>;

  createStripeProviderAccount(
    command: CreateStripeProviderAccountCommand,
  ): Promise<FinanceProviderAccountCommandResult>;

  issueStripeOnboardingLink(
    command: IssueStripeOnboardingLinkCommand,
  ): Promise<FinanceProviderAccountCommandResult>;
  issueStripeDashboardLoginLink(
    propertyId: FinancePropertyId,
  ): Promise<FinanceStripeDashboardLoginLinkResult>;
  reconcileStripeProviderAccount(
    command: ReconcileStripePropertyAccountCommand,
  ): Promise<FinanceStripeProviderAccountReconciliationResult>;
  enqueueXenditPayoutReconciliation(
    command: FinanceXenditPayoutReconciliationCommand,
  ): Promise<FinanceXenditPayoutReconciliationResult>;

  enqueuePropertyPayoutDispatch(
    command: FinancePropertyPayoutDispatchCommand,
  ): Promise<FinancePropertyPayoutDispatchResult>;

  updateAffiliatePayoutSettings(
    command: FinanceAffiliatePayoutSettingsPatchCommand,
  ): Promise<FinanceAffiliatePayoutSettingsPatchResult>;
};

export type FinanceAffiliateRepository = {
  getAffiliatePayoutSettings(
    affiliateId: FinanceAffiliateId,
  ): Promise<FinanceAffiliatePayoutSettingsReadModel | null>;

  listAffiliatePayouts(
    affiliateId: FinanceAffiliateId,
    query: FinancePayoutListQuery,
  ): Promise<Omit<FinanceAffiliatePayoutListResponse, "contractVersion" | "affiliateId"> | null>;
};

export type FinancePropertyReadRepository = FinancePropertySettingsReadRepository &
  Partial<FinancePropertyOperationsReadRepository> &
  Partial<FinanceAffiliateRepository> &
  Partial<FinancePlatformAffiliatePayoutRepository> &
  Partial<FinancePlatformOnlineCardExecutionEvidenceRepository> &
  Partial<FinancePropertyCommandRepository>;

export function toFinancePaymentSettingsResponse(
  settings: FinancePaymentSettingsReadModel,
): FinancePaymentSettingsResponse {
  const { propertyId, updatedAt: _updatedAt, ...paymentSettings } = settings;
  return {
    contractVersion: FINANCE_ROUTE_CONTRACT_VERSION,
    propertyId,
    paymentSettings,
  };
}

export function setupIncompletePaymentSettings(
  propertyId: FinancePropertyId,
  updatedAt: FinanceUtcDateTime,
  defaultCurrency: FinanceCurrencyCode = "EUR",
): FinancePaymentSettingsReadModel {
  return {
    propertyId,
    paymentsEnabled: false,
    paymentProvider: "manual",
    acceptedMethods: [],
    defaultCurrency,
    supportedCurrencies: [defaultCurrency],
    depositPolicy: {},
    refundPolicy: {},
    taxPolicy: {},
    statementDescriptor: null,
    requiresManualReview: true,
    providerAccount: {
      providerAccountId: null,
      provider: null,
      status: "setup_incomplete",
      onboardingStatus: "not_started",
      chargesEnabled: false,
      payoutsEnabled: false,
      capabilities: [],
    },
    sourceFreshness: {
      status: "setup_incomplete",
    },
    updatedAt,
  };
}

export function setupIncompleteAffiliatePayoutSettings(
  affiliateId: FinanceAffiliateId,
  updatedAt: FinanceUtcDateTime,
  marketplaceOrganizationId: string | null = null,
  defaultCurrency: FinanceCurrencyCode = "EUR",
): FinanceAffiliatePayoutSettingsReadModel {
  return {
    affiliateId,
    marketplaceOrganizationId,
    payoutsEnabled: false,
    payoutProvider: "manual",
    payoutCurrency: defaultCurrency,
    payoutSchedule: "monthly",
    payoutThresholdAmount: null,
    providerAccount: {
      providerAccountId: null,
      provider: null,
      status: "setup_incomplete",
      onboardingStatus: "not_started",
      payoutsEnabled: false,
    },
    sourceFreshness: {},
    updatedAt,
  };
}

export function toFinanceCancellationPolicyResponse(
  propertyId: FinancePropertyId,
  policy: CancellationPolicy,
): FinanceCancellationPolicyResponse {
  return {
    contractVersion: FINANCE_ROUTE_CONTRACT_VERSION,
    propertyId,
    policy,
  };
}

export function cancellationPolicyFromRefundPolicy(
  refundPolicy: FinanceJsonPolicy,
  updatedAt: FinanceUtcDateTime,
): CancellationPolicy {
  return {
    freeCancellationDays: nonNegativeInteger(refundPolicy["freeCancellationDays"], 0),
    partialRefundPercent: boundedPercent(refundPolicy["partialRefundPercent"], 0),
    refundMethod: refundMethod(refundPolicy["refundMethod"]),
    appliesTo: cancellationAppliesTo(refundPolicy["appliesTo"]),
    updatedAt,
  };
}

export function toPublicPaymentCapabilityProjection(
  settings: FinancePaymentSettingsReadModel,
  cancellationPolicy: CancellationPolicy,
): PublicPaymentCapabilityProjection {
  return {
    paymentMethods: publicPaymentMethods(settings),
    defaultCurrency: settings.defaultCurrency,
    supportedCurrencies: settings.supportedCurrencies,
    depositPolicy: publicDepositPolicy(settings.depositPolicy),
    cancellationPolicy: {
      freeCancellationDays: cancellationPolicy.freeCancellationDays,
      partialRefundPercent: cancellationPolicy.partialRefundPercent,
      refundMethod: cancellationPolicy.refundMethod,
      appliesTo: cancellationPolicy.appliesTo,
    },
  };
}

function publicPaymentMethods(
  settings: FinancePaymentSettingsReadModel,
): FinanceRoutePaymentMethod[] {
  if (!settings.paymentsEnabled) return [];
  const canChargeOnline = financeProviderCanCharge(settings);
  return settings.acceptedMethods.filter((method) => {
    if (method === "card" || method === "wallet") return canChargeOnline;
    if (method === "xendit") return canChargeOnline && settings.paymentProvider === "xendit";
    if (method === "bank_transfer") {
      return hasPublicPaymentInstruction(settings.depositPolicy["bankTransferInstructions"]);
    }
    if (method === "paypal") {
      return validPublicPaymentEmail(settings.depositPolicy["paypalEmail"]);
    }
    return true;
  });
}

function hasPublicPaymentInstruction(value: unknown): boolean {
  return typeof value === "string" && value.trim().length > 0;
}

function validPublicPaymentEmail(value: unknown): boolean {
  return typeof value === "string" && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim());
}

function financeProviderCanCharge(settings: FinancePaymentSettingsReadModel): boolean {
  return (
    settings.providerAccount.status === "active" &&
    settings.providerAccount.onboardingStatus === "completed" &&
    settings.providerAccount.chargesEnabled
  );
}

function publicDepositPolicy(policy: FinanceJsonPolicy): FinanceJsonPolicy {
  return copyPublicPolicyFields(policy, [
    "depositPercent",
    "depositAmount",
    "depositDue",
    "currency",
    "summary",
  ]);
}

function copyPublicPolicyFields(
  policy: FinanceJsonPolicy,
  fields: readonly string[],
): FinanceJsonPolicy {
  return Object.fromEntries(
    fields.flatMap((field) => {
      const value = policy[field];
      return value === undefined ? [] : [[field, value]];
    }),
  );
}

function nonNegativeInteger(value: unknown, fallback: number): number {
  if (typeof value === "number" && Number.isInteger(value) && value >= 0) return value;
  if (typeof value === "string" && /^\d+$/.test(value)) return Number(value);
  return fallback;
}

function boundedPercent(value: unknown, fallback: number): number {
  if (typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 100) {
    return value;
  }
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    if (Number.isFinite(parsed) && parsed >= 0 && parsed <= 100) return parsed;
  }
  return fallback;
}

function refundMethod(value: unknown): CancellationPolicy["refundMethod"] {
  if (
    value === "original_payment" ||
    value === "manual_review" ||
    value === "property_discretion"
  ) {
    return value;
  }
  return "manual_review";
}

function cancellationAppliesTo(value: unknown): CancellationPolicy["appliesTo"] {
  if (value === "direct_booking" || value === "all_guest_bookings") {
    return value;
  }
  return "direct_booking";
}

// ---------------------------------------------------------------------------
// Finance command types
//
// Cross-domain writes to finance-owned settings are expressed as commands with
// idempotency keys and audit trails, not as direct SQL writes from PMS code.
// ---------------------------------------------------------------------------

export type FinanceCommandActor =
  | { kind: "user"; userId: string; organizationId: string }
  | { kind: "system"; service: string }
  | { kind: "migration"; runId: string };

export type FinanceCommandAudit = {
  actor: FinanceCommandActor;
  requestId: string;
  correlationId?: string;
  reason: string;
  requestedAt: FinanceUtcDateTime;
};

export type FinanceCommandBase<TCommandType extends string, TPayload> = {
  commandType: TCommandType;
  commandId: string;
  idempotencyKey: string;
  propertyId: FinancePropertyId;
  audit: FinanceCommandAudit;
  payload: TPayload;
};

/** Update which payment methods are enabled. Owner: Finance. */
export type UpdatePaymentMethodsPayload = {
  enabledPaymentMethods: FinancePaymentMethod[];
};

export type UpdatePaymentMethodsCommand = FinanceCommandBase<
  "finance.payment.methods.update",
  UpdatePaymentMethodsPayload
>;

/** Enable or disable the instant-book flag. Owner: Finance/Booking. */
export type UpdateInstantBookPayload = {
  instantBook: boolean;
};

export type UpdateInstantBookCommand = FinanceCommandBase<
  "finance.payment.instant_book.update",
  UpdateInstantBookPayload
>;

/** Update billing plan. Owner: Finance/Platform-admin. */
export type UpdateBillingPlanPayload = {
  activePlan: FinanceBillingPlan;
  bookingEngineFeePercent: number;
  channelManagerFeePercent: number;
  affiliatePlatformFeePercent: number;
  /**
   * If set, the plan switch becomes effective on this date rather than
   * immediately.  The legacy Python path applied pending switches inline
   * during billing-config reads; the target Finance service should apply them
   * through a scheduled job.
   */
  effectiveDate?: FinanceUtcDateTime | null;
};

export type UpdateBillingPlanCommand = FinanceCommandBase<
  "finance.billing.plan.update",
  UpdateBillingPlanPayload
>;

/**
 * Update the price of a booking add-on. Owner: Finance.
 *
 * Replaces direct writes to `booking_addons` from
 * `hotel_identity_service.update_addon_price()`.  The command carries an
 * idempotency key so concurrent PMS saves cannot produce duplicate price rows.
 */
export type UpdateAddOnPricePayload = {
  addOnId: string;
  price: FinanceDecimalAmount;
  currency: FinanceCurrencyCode;
};

export type UpdateAddOnPriceCommand = FinanceCommandBase<
  "finance.add_on.price.update",
  UpdateAddOnPricePayload
>;

export type SettleManualCheckoutChargeCommand = FinanceCommandBase<
  "finance.checkout_charge.settle_manual",
  SettleManualCheckoutChargePayload
>;

export type FinanceCommand =
  | UpdatePaymentMethodsCommand
  | UpdateInstantBookCommand
  | UpdateBillingPlanCommand
  | UpdateAddOnPriceCommand
  | CreateStripeProviderAccountCommand
  | IssueStripeOnboardingLinkCommand
  | FinancePropertyPayoutDispatchCommand
  | FinanceAffiliatePayoutSettingsPatchCommand
  | SettleManualCheckoutChargeCommand;

export const financeCommandTypes = [
  "finance.payment.methods.update",
  "finance.payment.instant_book.update",
  "finance.billing.plan.update",
  "finance.add_on.price.update",
  "finance.provider_account.stripe.create",
  "finance.provider_account.stripe.onboarding_link.issue",
  "finance.property_payout.dispatch",
  "finance.affiliate_payout_settings.update",
  "finance.checkout_charge.settle_manual",
] as const satisfies readonly FinanceCommand["commandType"][];

export type FinanceCommandType = (typeof financeCommandTypes)[number];

// ---------------------------------------------------------------------------
// Finance command result
// ---------------------------------------------------------------------------

export type FinanceCommandResult = {
  status: "accepted" | "idempotent_replay";
  commandId: string;
  idempotencyKey: string;
  propertyId: FinancePropertyId;
};

export interface FinanceCommandBus {
  execute(command: FinanceCommand): Promise<FinanceCommandResult>;
}

// ---------------------------------------------------------------------------
// Payout split pure calculation
//
// Replaces the Python payout_service.calculate_split() function.
// This is a pure function — no side effects, no DB access.
// Amounts are rounded to 2 decimal places.
// ---------------------------------------------------------------------------

const KNOWN_DIRECT_CHANNELS: ReadonlySet<FinanceBookingChannel> = new Set(["direct"]);

/**
 * Calculate the billing split for a booking.
 *
 * Fee matrix:
 *   Fixed plan: 0% on non-affiliate bookings.
 *               affiliatePlatformFeePercent on affiliate bookings.
 *   Commission plan: bookingEngineFeePercent on direct bookings.
 *                    channelManagerFeePercent on OTA/channel bookings.
 *                    Affiliate bookings do NOT add affiliatePlatformFeePercent
 *                    (channel fee already covers the platform cut).
 *
 * Affiliate commission is additive — paid by the property on top of the
 * platform fee, regardless of plan.
 */
export function calculatePayoutSplit(input: PayoutSplitInput): PayoutSplitResult {
  const total = parseDecimalAmount(input.totalAmount);
  const isChannelBooking = !KNOWN_DIRECT_CHANNELS.has(input.channel);
  const config = input.billingConfig;

  let platformFeePct = 0;
  if (config.activePlan === "commission") {
    platformFeePct = isChannelBooking
      ? config.channelManagerFeePercent
      : config.bookingEngineFeePercent;
  } else if (input.affiliate) {
    platformFeePct = config.affiliatePlatformFeePercent;
  }
  platformFeePct = clampPercent(platformFeePct, "platformFeePct");

  const affiliateCommissionPct = input.affiliate
    ? clampPercent(input.affiliate.commissionPercent, "affiliate.commissionPercent")
    : 0;

  // Use integer-cent arithmetic to avoid floating-point accumulation errors.
  const centsTotal = Math.round(total * 100);
  const platformFeeCents = Math.round((centsTotal * platformFeePct) / 100);
  const affiliateCommissionCents = Math.round((centsTotal * affiliateCommissionPct) / 100);
  const propertyPayoutCents = centsTotal - platformFeeCents - affiliateCommissionCents;

  const platformFee = round2(platformFeeCents / 100);
  const affiliateCommission = round2(affiliateCommissionCents / 100);
  const propertyPayout = round2(propertyPayoutCents / 100);

  return {
    platformFee: String(platformFee),
    affiliateCommission: String(affiliateCommission),
    propertyPayout: String(propertyPayout),
  };
}

// ---------------------------------------------------------------------------
// Idempotency key helper
// ---------------------------------------------------------------------------

/**
 * Build a stable idempotency key for finance commands.
 * Format: `<commandType>:property:<propertyId>:<suffix>`.
 *
 * Example: `finance.billing.plan.update:property:prop_abc123:switch-to-commission-2026-07`
 */
export function financeCommandIdempotencyKey(
  commandType: FinanceCommandType,
  propertyId: FinancePropertyId,
  suffix: string,
): string {
  return `${commandType}:property:${propertyId}:${suffix}`;
}

/**
 * Build a stable idempotency key for UpdateAddOnPriceCommand.
 * Format: `finance.add_on.price.update:property:<propertyId>:add_on:<addOnId>`.
 *
 * Using the propertyId + addOnId pair as the natural key prevents duplicate
 * price-update commands when PMS retries a save after a transient failure.
 */
export function buildUpdateAddOnPriceIdempotencyKey(
  propertyId: FinancePropertyId,
  addOnId: string,
): string {
  return `finance.add_on.price.update:property:${propertyId}:add_on:${addOnId}`;
}

export function buildCheckoutChargeSettlementIdempotencyKey(input: {
  checkoutChargeId: string;
  pmsCommandId: string;
}): string {
  return `finance.checkout-charge-settlement:checkout_charge:${input.checkoutChargeId}:mark-paid:${input.pmsCommandId}:v1`;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function parseDecimalAmount(value: FinanceDecimalAmount): number {
  if (value.trim() === "") {
    throw new Error("Invalid decimal amount: empty string");
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    throw new Error(`Invalid decimal amount: ${value}`);
  }
  if (parsed < 0) {
    throw new Error(`Invalid decimal amount: negative value: ${value}`);
  }
  return parsed;
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

/**
 * Validate that a percentage value is a finite number in the range [0, 100].
 * Throws a descriptive error for NaN, non-finite, negative, or >100 values.
 */
function clampPercent(value: number, fieldName: string): number {
  if (!Number.isFinite(value) || Number.isNaN(value)) {
    throw new Error(`Invalid percent for ${fieldName}: must be a finite number, got ${value}`);
  }
  if (value < 0) {
    throw new Error(`Invalid percent for ${fieldName}: must be >= 0, got ${value}`);
  }
  if (value > 100) {
    throw new Error(`Invalid percent for ${fieldName}: must be <= 100, got ${value}`);
  }
  return value;
}
