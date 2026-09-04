import type {
  IdentityMigrationBlocker,
  IdentitySourceRow,
} from "./productionIdentityDisposition.js";
import type { ProductionMigrationSourceLink } from "./productionBookingTypes.js";

export type FinanceTargetRecord = {
  targetProduct: "finance";
  targetTable: string;
  targetId: string;
  sourceDatabase: "booking" | "pms";
  sourceTable: string;
  sourceId: string;
  sourceChecksum: string;
  sourceUpdatedAt: string;
  mutable: boolean;
  row: Record<string, unknown>;
};

export type ExistingFinanceTargetRecord = {
  targetProduct: "finance";
  targetTable: string;
  targetId: string;
  updatedAt: string;
  row: Record<string, unknown>;
};

export type ProductionFinanceDispositionReasonCode =
  | "INVALID_FINANCE_SOURCE_ROW"
  | "INVALID_BOOKING_FINANCE_ALLOCATION"
  | "BOOKING_FINANCE_ALLOCATION_EVIDENCE_REQUIRED"
  | "PAYMENT_CAPTURE_EVIDENCE_REQUIRED"
  | "MISSING_PAYMENT_PROVIDER_ACCOUNT_ID"
  | "LEGACY_PAYMENT_PROVIDER_REFERENCE_QUARANTINED"
  | "LEGACY_BILLING_PROVIDER_REFERENCE_QUARANTINED"
  | "FINANCE_PARENT_RECORD_QUARANTINED"
  | "MISSING_PROVIDER_ACCOUNT_ID"
  | "MISSING_PAYOUT_PROVIDER_ACCOUNT_ID"
  | "PAYMENT_SETTINGS_SOURCE_DISAGREEMENT"
  | "BANK_TRANSFER_DESTINATION_REENTRY_REQUIRED"
  | "PAYPAL_DESTINATION_REENTRY_REQUIRED"
  | "SENSITIVE_PAYOUT_DESTINATION_REENTRY_REQUIRED"
  | "PAYOUT_PAYMENT_ALLOCATION_EVIDENCE_REQUIRED"
  | "NONCANONICAL_BOOKING_ENGINE_FEE"
  | "NONCANONICAL_FIXED_PLAN_PRICING"
  | "FIXED_PLAN_PROVIDER_REBIND_REQUIRED"
  | "BILLING_PLAN_PROVIDER_STATE_DISAGREEMENT"
  | "FIXED_PLAN_SUBSCRIPTION_EVIDENCE_REQUIRED"
  | "FIXED_PLAN_BILLING_PRICE_DIRTY"
  | "FIXED_PLAN_BILLING_PRICE_EVIDENCE_REQUIRED"
  | "INVALID_FIXED_PLAN_BILLING_EVIDENCE"
  | "FIXED_PLAN_BILLING_AMOUNT_MISMATCH";

export type ProductionFinanceDisposition = {
  sourceDatabase: "booking" | "pms";
  sourceTable: string;
  sourceId: string;
  sourceField: string;
  sourceValueSha256: string;
  reasonCode: ProductionFinanceDispositionReasonCode;
  disposition:
    | "omitted_row"
    | "omitted_field"
    | "disabled_configuration"
    | "target_reentry_required"
    | "unbound_history";
  targetTable: string | null;
  targetId: string | null;
};

export type FinancePropertyLink = {
  sourceSystem: string;
  sourceTable: string;
  sourceId: string;
  propertyId: string;
  relationship: string;
  status: string;
  migrationRunId: string | null;
};

export type FinanceResourceLink = {
  organizationId: string;
  product: string;
  resourceType: string;
  resourceId: string;
  relationship: string;
  status: string;
};

export type FinanceGuestBooking = {
  id: string;
  propertyId: string;
  sourceBookingId: string;
  currency: string;
};

export type ProductionFinancePrerequisites = {
  propertyLinks: FinancePropertyLink[];
  resourceLinks: FinanceResourceLink[];
  guestBookings: FinanceGuestBooking[];
  userIds: string[];
  identityEntitlements: Array<{
    id: string;
    organizationId: string;
    product: string;
    resourceId: string | null;
  }>;
};

export type ProductionFinanceTargetState = ProductionFinancePrerequisites & {
  records: ExistingFinanceTargetRecord[];
  provenance: ProductionMigrationSourceLink[];
  blockers?: IdentityMigrationBlocker[];
};

export type FinanceBuildContext = {
  sourceRunId: string;
  completedAt: string;
  rows: IdentitySourceRow[];
  target: ProductionFinanceTargetState;
  blockers: IdentityMigrationBlocker[];
  dispositions: ProductionFinanceDisposition[];
  rowsBySource: Map<string, IdentitySourceRow[]>;
  propertyBySource: Map<string, string>;
  organizationByResource: Map<string, string>;
  guestBookingByPmsId: Map<string, FinanceGuestBooking>;
  pmsBookingById: Map<string, IdentitySourceRow>;
  pmsAffiliateById: Map<string, IdentitySourceRow>;
  pmsAffiliatesByUserId: Map<string, IdentitySourceRow[]>;
  pmsSettingsByProperty: Map<string, IdentitySourceRow>;
  plannedTargetIdsByTable: Map<string, Set<string>>;
  quarantinedSourceRows: Set<IdentitySourceRow>;
};

export type FinanceParity = {
  sourceTableCounts: Record<string, number>;
  targetTableCounts: Record<string, number>;
  dispositionCountsByReason: Record<string, number>;
  omittedSourceRowCounts: Record<string, number>;
  sourcePaymentAmountsByCurrencyStatusOwner: Record<string, string>;
  omittedPaymentAmountsByCurrencyStatusOwner: Record<string, string>;
  targetPaymentAmountsByCurrencyStatusOwner: Record<string, string>;
  sourcePaymentCountsByCurrencyStatusOwner: Record<string, number>;
  omittedPaymentCountsByCurrencyStatusOwner: Record<string, number>;
  targetPaymentCountsByCurrencyStatusOwner: Record<string, number>;
  sourcePaymentFeesByCurrencyStatusOwner: Record<string, string>;
  omittedPaymentFeesByCurrencyStatusOwner: Record<string, string>;
  targetPaymentFeesByCurrencyStatusOwner: Record<string, string>;
  sourcePaymentNetByCurrencyStatusOwner: Record<string, string>;
  omittedPaymentNetByCurrencyStatusOwner: Record<string, string>;
  targetPaymentNetByCurrencyStatusOwner: Record<string, string>;
  sourcePaymentRefundsByCurrencyStatusOwner: Record<string, string>;
  omittedPaymentRefundsByCurrencyStatusOwner: Record<string, string>;
  targetPaymentRefundsByCurrencyStatusOwner: Record<string, string>;
  sourcePayoutAmountsByCurrencyStatusOwner: Record<string, string>;
  omittedPayoutAmountsByCurrencyStatusOwner: Record<string, string>;
  targetPayoutAmountsByCurrencyStatusOwner: Record<string, string>;
  sourcePayoutCountsByCurrencyStatusOwner: Record<string, number>;
  omittedPayoutCountsByCurrencyStatusOwner: Record<string, number>;
  targetPayoutCountsByCurrencyStatusOwner: Record<string, number>;
  sourcePayoutNetByCurrencyStatusOwner: Record<string, string>;
  omittedPayoutNetByCurrencyStatusOwner: Record<string, string>;
  targetPayoutNetByCurrencyStatusOwner: Record<string, string>;
  sourcePayoutAllocationsByBookingOwner: Record<string, string>;
  targetPayoutAllocationsByBookingOwner: Record<string, string>;
};

export type ProductionFinancePlan = {
  sourceRunId: string;
  checksum: string;
  records: FinanceTargetRecord[];
  writes: FinanceTargetRecord[];
  provenance: ProductionMigrationSourceLink[];
  dispositions: ProductionFinanceDisposition[];
  blockers: IdentityMigrationBlocker[];
  parity: FinanceParity;
  counts: {
    sourceRows: number;
    plannedRecords: number;
    inserts: number;
    updates: number;
    unchanged: number;
    preservedNewerTarget: number;
    preservedTargetDeletions: number;
    dispositions: number;
    omittedSourceRows: number;
  };
};
