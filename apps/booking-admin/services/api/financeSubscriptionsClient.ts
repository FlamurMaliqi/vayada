import { apiClient, omitHotelContext, type ApiClient } from "./client";

type FinanceSubscriptionsApiClient = Pick<ApiClient, "get" | "post">;

export type FinancePlanStatus = {
  plan: "commission" | "fixed";
  status: "commission" | "checkout_pending" | "active" | "past_due" | "cancel_at_period_end";
  currency: "EUR";
  activeRoomCount: number;
  amountMinor: number;
  currentPeriodStart: string | null;
  currentPeriodEnd: string | null;
  nextBillingDate: string | null;
  cancelAtPeriodEnd: boolean;
  checkoutPending: boolean;
  customerPortalAvailable: boolean;
  activatedAt: string | null;
  updatedAt: string;
};

export type FinancePlanStatusResponse = {
  contractVersion: "finance-subscriptions.v1";
  propertyId: string;
  planStatus: FinancePlanStatus;
};

export async function getFinancePlanStatus(
  propertyId: string,
  client: FinanceSubscriptionsApiClient = apiClient,
): Promise<FinancePlanStatusResponse> {
  return client.get<FinancePlanStatusResponse>(
    endpoint(propertyId, "plan-status"),
    omitHotelContext,
  );
}

export async function createFixedPlanCheckout(
  input: { propertyId: string; commandId?: string },
  client: FinanceSubscriptionsApiClient = apiClient,
) {
  const commandId = input.commandId ?? newCommandId("fixed-plan-checkout");
  return client.post<{
    contractVersion: "finance-subscriptions.v1";
    propertyId: string;
    checkout: {
      checkoutSessionId: string;
      checkoutUrl: string;
      currency: "EUR";
      amountMinor: number;
      activeRoomCount: number;
    };
  }>(
    endpoint(input.propertyId, "fixed-plan/checkout"),
    { commandId, idempotencyKey: commandId },
    omitHotelContext,
  );
}

export async function openFinanceCustomerPortal(
  input: { propertyId: string; commandId?: string },
  client: FinanceSubscriptionsApiClient = apiClient,
) {
  const commandId = input.commandId ?? newCommandId("finance-customer-portal");
  return client.post<{
    contractVersion: "finance-subscriptions.v1";
    propertyId: string;
    customerPortal: { portalUrl: string };
  }>(
    endpoint(input.propertyId, "customer-portal"),
    { commandId, idempotencyKey: commandId },
    omitHotelContext,
  );
}

export async function switchToCommissionPlan(
  input: { propertyId: string; commandId?: string },
  client: FinanceSubscriptionsApiClient = apiClient,
): Promise<FinancePlanStatusResponse> {
  const commandId = input.commandId ?? newCommandId("switch-to-commission");
  return client.post<FinancePlanStatusResponse>(
    endpoint(input.propertyId, "switch-to-commission"),
    { commandId, idempotencyKey: commandId },
    omitHotelContext,
  );
}

function endpoint(propertyId: string, action: string): string {
  const normalizedPropertyId = propertyId.trim();
  if (!normalizedPropertyId) throw new Error("Finance property id is required.");
  return `/api/finance/properties/${encodeURIComponent(normalizedPropertyId)}/${action}`;
}

function newCommandId(prefix: string): string {
  const suffix =
    typeof crypto !== "undefined" && "randomUUID" in crypto
      ? crypto.randomUUID()
      : `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  return `${prefix}-${suffix}`;
}
