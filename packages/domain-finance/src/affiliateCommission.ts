export const FINANCE_AFFILIATE_COMMISSION_CONTRACT_VERSION =
  "finance-affiliate-commission.v1" as const;

export const FINANCE_AFFILIATE_COMMISSION_ENDPOINTS = {
  propertyDefault: "/api/finance/properties/:propertyId/affiliate-commission",
  affiliateOverride: "/api/finance/properties/:propertyId/affiliates/:affiliateId/commission",
} as const;

export type FinanceAffiliateCommissionView = {
  contractVersion: typeof FINANCE_AFFILIATE_COMMISSION_CONTRACT_VERSION;
  propertyId: string;
  affiliateId: string | null;
  defaultPercentageRate: string;
  overridePercentageRate: string | null;
  effectivePercentageRate: string;
  updatedAt: string | null;
};

export type FinanceAffiliateCommissionCommand = {
  propertyId: string;
  affiliateId: string | null;
  commandId: string;
  idempotencyKey: string;
  percentageRate: string | null;
  actorUserId: string;
  occurredAt: string;
};

export type FinanceAffiliateCommissionResult =
  | {
      outcome: "applied" | "replayed";
      commandId: string;
      commission: FinanceAffiliateCommissionView;
    }
  | { outcome: "idempotency_conflict" };

export type FinanceAffiliateCommissionAccessStatus = "active" | "inactive" | "missing";

export interface FinanceAffiliateCommissionRepository {
  getCommission(
    propertyId: string,
    affiliateId?: string | null,
  ): Promise<FinanceAffiliateCommissionView>;
  setCommission(
    command: FinanceAffiliateCommissionCommand,
  ): Promise<FinanceAffiliateCommissionResult>;
  getBookingFinanceAccess(
    propertyId: string,
    organizationId: string,
  ): Promise<FinanceAffiliateCommissionAccessStatus>;
  close?(): Promise<void>;
}
