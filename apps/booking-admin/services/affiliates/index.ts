import { getBookingHotelPropertyLink } from "../api/bookingPropertyLinkClient";
import { requireSelectedBookingHotelId } from "../api/bookingHotelScope";
import { apiClient, omitHotelContext, type ApiClient } from "../api/client";

export type AffiliateLifecycleStatus = "pending" | "approved" | "rejected" | "suspended";
export type AffiliateLifecycleAction = "approve" | "reject" | "suspend" | "restore";

export interface Affiliate {
  contractVersion: "marketplace-affiliate-admin.v1";
  affiliateId: string;
  propertyId: string;
  referralCode: string;
  displayName: string | null;
  contactEmail: string | null;
  socialMedia: string | null;
  affiliateType: "guest" | "creator";
  lifecycleStatus: AffiliateLifecycleStatus;
  applicationSource: "public_registration" | "collaboration" | "migration";
  appliedAt: string;
  updatedAt: string;
}

export interface AffiliateListResponse {
  contractVersion: "marketplace-affiliate-admin.v1";
  affiliates: Affiliate[];
  total: number;
  limit: number;
  offset: number;
}

export interface AffiliateCommission {
  contractVersion: "finance-affiliate-commission.v1";
  propertyId: string;
  affiliateId: string | null;
  defaultPercentageRate: string;
  overridePercentageRate: string | null;
  effectivePercentageRate: string;
  updatedAt: string | null;
}

export interface AffiliateDetail {
  affiliate: Affiliate;
  commission: AffiliateCommission | null;
}

type LifecycleResult = {
  outcome: "applied" | "replayed";
  commandId: string;
  affiliate: Affiliate;
};

type CommissionResult = {
  outcome: "applied" | "replayed";
  commandId: string;
  commission: AffiliateCommission;
};

type AffiliateApiClient = Pick<ApiClient, "get" | "post" | "patch">;

export function createAffiliatesService(
  dependencies: {
    client?: AffiliateApiClient;
    resolvePropertyId?: () => Promise<string>;
    newCommandId?: (prefix: string) => string;
  } = {},
) {
  const client = dependencies.client ?? apiClient;
  const resolvePropertyId =
    dependencies.resolvePropertyId ??
    (async () => {
      const hotelId = requireSelectedBookingHotelId();
      return (await getBookingHotelPropertyLink({ hotelId }, client)).propertyId;
    });
  const newCommandId = dependencies.newCommandId ?? createCommandId;

  async function scope() {
    const propertyId = (await resolvePropertyId()).trim();
    if (!propertyId) throw new Error("Select a property before continuing.");
    return { propertyId, encodedPropertyId: encodeURIComponent(propertyId) };
  }

  return {
    async list(
      params: {
        status?: AffiliateLifecycleStatus;
        affiliateType?: "guest" | "creator";
        search?: string;
        limit?: number;
        offset?: number;
      } = {},
    ): Promise<AffiliateListResponse> {
      const { encodedPropertyId } = await scope();
      const query = new URLSearchParams();
      if (params.status) query.set("status", params.status);
      if (params.affiliateType) query.set("affiliateType", params.affiliateType);
      if (params.search?.trim()) query.set("search", params.search.trim());
      if (params.limit !== undefined) query.set("limit", String(params.limit));
      if (params.offset !== undefined) query.set("offset", String(params.offset));
      const suffix = query.size ? `?${query}` : "";
      return client.get<AffiliateListResponse>(
        `/api/marketplace/properties/${encodedPropertyId}/affiliates${suffix}`,
        omitHotelContext,
      );
    },

    async get(affiliateId: string): Promise<Affiliate> {
      const { encodedPropertyId } = await scope();
      const encodedAffiliateId = requiredAffiliateId(affiliateId);
      return client.get<Affiliate>(
        `/api/marketplace/properties/${encodedPropertyId}/affiliates/${encodedAffiliateId}`,
        omitHotelContext,
      );
    },

    async getCommission(affiliateId: string): Promise<AffiliateCommission> {
      const { encodedPropertyId } = await scope();
      return client.get<AffiliateCommission>(
        `/api/finance/properties/${encodedPropertyId}/affiliates/${requiredAffiliateId(affiliateId)}/commission`,
        omitHotelContext,
      );
    },

    async updateStatus(
      affiliateId: string,
      action: AffiliateLifecycleAction,
    ): Promise<LifecycleResult> {
      const { encodedPropertyId } = await scope();
      const commandId = newCommandId(`affiliate-${action}`);
      return client.post<LifecycleResult>(
        `/api/marketplace/properties/${encodedPropertyId}/affiliates/${requiredAffiliateId(affiliateId)}/lifecycle`,
        { commandId, idempotencyKey: commandId, action },
        omitHotelContext,
      );
    },

    async updateCommission(
      affiliateId: string,
      percentageRate: string | null,
    ): Promise<CommissionResult> {
      const { encodedPropertyId } = await scope();
      const commandId = newCommandId("affiliate-commission");
      return client.patch<CommissionResult>(
        `/api/finance/properties/${encodedPropertyId}/affiliates/${requiredAffiliateId(affiliateId)}/commission`,
        { commandId, idempotencyKey: commandId, percentageRate },
        omitHotelContext,
      );
    },

    async getDefaultCommission(): Promise<AffiliateCommission> {
      const { encodedPropertyId } = await scope();
      return client.get<AffiliateCommission>(
        `/api/finance/properties/${encodedPropertyId}/affiliate-commission`,
        omitHotelContext,
      );
    },

    async updateDefaultCommission(percentageRate: string): Promise<CommissionResult> {
      const { encodedPropertyId } = await scope();
      const commandId = newCommandId("affiliate-default-commission");
      return client.patch<CommissionResult>(
        `/api/finance/properties/${encodedPropertyId}/affiliate-commission`,
        { commandId, idempotencyKey: commandId, percentageRate },
        omitHotelContext,
      );
    },
  };
}

export const affiliatesService = createAffiliatesService();

function requiredAffiliateId(affiliateId: string): string {
  const normalized = affiliateId.trim();
  if (!normalized) throw new Error("Affiliate id is required.");
  return encodeURIComponent(normalized);
}

function createCommandId(prefix: string): string {
  const suffix =
    typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
      ? crypto.randomUUID()
      : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return `${prefix}-${suffix}`;
}
