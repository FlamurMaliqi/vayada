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
  rowsBySource: Map<string, IdentitySourceRow[]>;
  propertyBySource: Map<string, string>;
  organizationByResource: Map<string, string>;
  guestBookingByPmsId: Map<string, FinanceGuestBooking>;
  pmsBookingById: Map<string, IdentitySourceRow>;
  pmsAffiliateById: Map<string, IdentitySourceRow>;
  pmsAffiliatesByUserId: Map<string, IdentitySourceRow[]>;
  pmsSettingsByProperty: Map<string, IdentitySourceRow>;
};

export type FinanceParity = {
  sourceTableCounts: Record<string, number>;
  targetTableCounts: Record<string, number>;
  sourcePaymentAmountsByCurrencyStatusOwner: Record<string, string>;
  targetPaymentAmountsByCurrencyStatusOwner: Record<string, string>;
  sourcePaymentCountsByCurrencyStatusOwner: Record<string, number>;
  targetPaymentCountsByCurrencyStatusOwner: Record<string, number>;
  sourcePaymentFeesByCurrencyStatusOwner: Record<string, string>;
  targetPaymentFeesByCurrencyStatusOwner: Record<string, string>;
  sourcePaymentNetByCurrencyStatusOwner: Record<string, string>;
  targetPaymentNetByCurrencyStatusOwner: Record<string, string>;
  sourcePaymentRefundsByCurrencyStatusOwner: Record<string, string>;
  targetPaymentRefundsByCurrencyStatusOwner: Record<string, string>;
  sourcePayoutAmountsByCurrencyStatusOwner: Record<string, string>;
  targetPayoutAmountsByCurrencyStatusOwner: Record<string, string>;
  sourcePayoutCountsByCurrencyStatusOwner: Record<string, number>;
  targetPayoutCountsByCurrencyStatusOwner: Record<string, number>;
  sourcePayoutNetByCurrencyStatusOwner: Record<string, string>;
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
  };
};
