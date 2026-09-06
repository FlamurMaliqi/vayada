export const MARKETPLACE_AFFILIATE_ADMIN_CONTRACT_VERSION =
  "marketplace-affiliate-admin.v1" as const;

export const MARKETPLACE_AFFILIATE_ADMIN_ENDPOINTS = {
  list: "/api/marketplace/properties/:propertyId/affiliates",
  detail: "/api/marketplace/properties/:propertyId/affiliates/:affiliateId",
  lifecycle: "/api/marketplace/properties/:propertyId/affiliates/:affiliateId/lifecycle",
} as const;

export const MARKETPLACE_AFFILIATE_LIFECYCLE_STATUSES = [
  "pending",
  "approved",
  "rejected",
  "suspended",
] as const;
export type MarketplaceAffiliateLifecycleStatus =
  (typeof MARKETPLACE_AFFILIATE_LIFECYCLE_STATUSES)[number];

export type MarketplaceAffiliateAdminRecord = {
  contractVersion: typeof MARKETPLACE_AFFILIATE_ADMIN_CONTRACT_VERSION;
  affiliateId: string;
  propertyId: string;
  referralCode: string;
  displayName: string | null;
  contactEmail: string | null;
  socialMedia: string | null;
  affiliateType: "guest" | "creator";
  lifecycleStatus: MarketplaceAffiliateLifecycleStatus;
  applicationSource: "public_registration" | "collaboration" | "migration";
  appliedAt: string;
  updatedAt: string;
};

export type MarketplaceAffiliateAdminListInput = {
  propertyId: string;
  status?: MarketplaceAffiliateLifecycleStatus;
  affiliateType?: "guest" | "creator";
  search?: string;
  limit: number;
  offset: number;
};

export interface MarketplaceAffiliateAdminRepository {
  listAffiliates(input: MarketplaceAffiliateAdminListInput): Promise<{
    affiliates: MarketplaceAffiliateAdminRecord[];
    total: number;
  }>;
  getAffiliate(
    propertyId: string,
    affiliateId: string,
  ): Promise<MarketplaceAffiliateAdminRecord | null>;
  close?(): Promise<void>;
}
