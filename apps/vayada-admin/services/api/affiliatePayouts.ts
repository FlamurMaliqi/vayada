import { ApiErrorResponse, apiClient } from "./client";

export type AffiliatePayoutSummary = {
  affiliateId: string;
  organizationId: string;
  affiliateLifecycleStatus: "active" | "inactive";
  currency: string;
  payoutMethod: string;
  outstandingAmount: string;
  payableAmount: string;
  paidAmount: string;
  payoutCount: number;
  payableCount: number;
  lastPaidAt: string | null;
};

export type AffiliatePayoutLine = {
  payoutId: string;
  relatedPropertyId: string | null;
  guestBookingId: string | null;
  payoutStatus:
    | "pending"
    | "scheduled"
    | "processing"
    | "paid"
    | "failed"
    | "canceled"
    | "reversed";
  amount: string;
  feeAmount: string;
  netAmount: string;
  currency: string;
  payoutMethod: string;
  providerPayoutId: string | null;
  scheduledAt: string | null;
  paidAt: string | null;
  failedAt: string | null;
  failureCode: string | null;
  retryCount: number;
  manualMarkPaidEligible: boolean;
  paymentEvidenceId: string | null;
};

export type AffiliatePayoutEvidence = {
  evidenceId: string;
  affiliateId: string;
  organizationId: string;
  payoutIds: string[];
  amount: string;
  currency: string;
  paymentMethod: "manual" | "bank_transfer";
  externalReference: string;
  evidenceReference: string;
  note: string | null;
  paidAt: string;
  recordedAt: string;
};

export type AffiliatePayoutDetail = {
  contractVersion: "finance-platform-affiliate-payouts.v1";
  summary: AffiliatePayoutSummary;
  payouts: AffiliatePayoutLine[];
  history: AffiliatePayoutEvidence[];
};

export type MarkPaidRequest = {
  commandId: string;
  idempotencyKey: string;
  currency: string;
  payoutIds: string[];
  expectedAmount: string;
  paymentMethod: "manual" | "bank_transfer";
  externalReference: string;
  evidenceReference: string;
  paidAt: string;
  note?: string | null;
};

export type MarkPaidResponse = {
  contractVersion: "finance-platform-affiliate-payouts.v1";
  status: "updated" | "idempotent_replay";
  evidence: AffiliatePayoutEvidence;
};

type ListResponse = {
  contractVersion: "finance-platform-affiliate-payouts.v1";
  summaries: AffiliatePayoutSummary[];
  total: number;
  limit: number;
  offset: number;
};

export const affiliatePayoutsService = {
  list: () => request(loadAllPayoutSummaries),

  get: (affiliateId: string, currency: string) =>
    request(() =>
      apiClient.get<AffiliatePayoutDetail>(
        `/api/finance/platform/affiliate-payouts/${encodeURIComponent(affiliateId)}?currency=${encodeURIComponent(currency)}`,
      ),
    ),

  markPaid: (affiliateId: string, body: MarkPaidRequest) =>
    request(() =>
      apiClient.post<MarkPaidResponse>(
        `/api/finance/platform/affiliate-payouts/${encodeURIComponent(affiliateId)}/mark-paid`,
        body,
      ),
    ),
};

async function loadAllPayoutSummaries(): Promise<ListResponse> {
  const summaries: AffiliatePayoutSummary[] = [];
  let total = 0;
  do {
    const page = await apiClient.get<ListResponse>(
      `/api/finance/platform/affiliate-payouts?limit=500&offset=${summaries.length}`,
    );
    total = page.total;
    summaries.push(...page.summaries);
    if (page.summaries.length === 0) break;
  } while (summaries.length < total);
  return {
    contractVersion: "finance-platform-affiliate-payouts.v1",
    summaries,
    total,
    limit: 500,
    offset: 0,
  };
}

async function request<T>(call: () => Promise<T>): Promise<T> {
  try {
    return await call();
  } catch (error) {
    if (error instanceof ApiErrorResponse) {
      const message = (error.data as unknown as { message?: unknown }).message;
      if (typeof message === "string" && message) throw new Error(message);
    }
    throw error;
  }
}
