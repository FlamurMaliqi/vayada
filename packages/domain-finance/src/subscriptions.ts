import type { FinanceCommandAudit, FinanceUtcDateTime } from "./index.js";

export const FINANCE_FIXED_PLAN_CURRENCY = "EUR" as const;
export const FINANCE_FIXED_PLAN_INTERVAL_DAYS = 30 as const;
export const FINANCE_FIXED_PLAN_BASE_AMOUNT_MINOR = 3_000 as const;
export const FINANCE_FIXED_PLAN_EXTRA_ROOM_AMOUNT_MINOR = 500 as const;

export type FinanceSubscriptionPlan = "commission" | "fixed";

export type FinanceSubscriptionLifecycleStatus =
  | "commission"
  | "checkout_pending"
  | "active"
  | "past_due"
  | "cancel_at_period_end";

export type FinancePlanStatusReadModel = {
  propertyId: string;
  plan: FinanceSubscriptionPlan;
  status: FinanceSubscriptionLifecycleStatus;
  currency: typeof FINANCE_FIXED_PLAN_CURRENCY;
  activeRoomCount: number;
  amountMinor: number;
  currentPeriodStart: FinanceUtcDateTime | null;
  currentPeriodEnd: FinanceUtcDateTime | null;
  nextBillingDate: FinanceUtcDateTime | null;
  cancelAtPeriodEnd: boolean;
  checkoutPending: boolean;
  customerPortalAvailable: boolean;
  activatedAt: FinanceUtcDateTime | null;
  updatedAt: FinanceUtcDateTime;
};

export type FinancePlanStatusResponse = {
  contractVersion: "finance-subscriptions.v1";
  propertyId: string;
  planStatus: Omit<FinancePlanStatusReadModel, "propertyId">;
};

export type FinanceSubscriptionCommandContext = {
  commandId: string;
  idempotencyKey: string;
  propertyId: string;
  organizationId: string;
  audit: FinanceCommandAudit;
};

export type CreateFixedPlanCheckoutCommand = FinanceSubscriptionCommandContext & {
  customerEmail: string;
};

export type CreateFixedPlanCheckoutResult = {
  checkoutSessionId: string;
  checkoutUrl: string;
  currency: typeof FINANCE_FIXED_PLAN_CURRENCY;
  amountMinor: number;
  activeRoomCount: number;
};

export type OpenFinanceCustomerPortalCommand = FinanceSubscriptionCommandContext;

export type OpenFinanceCustomerPortalResult = {
  portalUrl: string;
};

export type ScheduleCommissionPlanCommand = FinanceSubscriptionCommandContext;

export type ScheduleCommissionPlanResult = {
  planStatus: FinancePlanStatusReadModel;
};

export type SelectCommissionPlanCommand = FinanceSubscriptionCommandContext;

export type SelectCommissionPlanResult = {
  planStatus: FinancePlanStatusReadModel;
};

export type FinanceSubscriptionCommandError = {
  statusCode: 400 | 404 | 409 | 502 | 503;
  code:
    | "invalid_command"
    | "property_not_found"
    | "billing_configuration_missing"
    | "subscription_not_active"
    | "fixed_plan_already_active"
    | "idempotency_conflict"
    | "stripe_not_configured"
    | "stripe_unavailable";
  message: string;
};

export type FinanceSubscriptionCommandResult<T> =
  | { ok: true; status: "created" | "updated" | "idempotent_replay"; value: T }
  | ({ ok: false } & FinanceSubscriptionCommandError);

export type FinanceSubscriptionService = {
  getPlanStatus(propertyId: string): Promise<FinancePlanStatusReadModel>;
  createFixedPlanCheckout(
    command: CreateFixedPlanCheckoutCommand,
  ): Promise<FinanceSubscriptionCommandResult<CreateFixedPlanCheckoutResult>>;
  selectCommissionPlan(
    command: SelectCommissionPlanCommand,
  ): Promise<FinanceSubscriptionCommandResult<SelectCommissionPlanResult>>;
  openCustomerPortal(
    command: OpenFinanceCustomerPortalCommand,
  ): Promise<FinanceSubscriptionCommandResult<OpenFinanceCustomerPortalResult>>;
  scheduleCommissionPlan(
    command: ScheduleCommissionPlanCommand,
  ): Promise<FinanceSubscriptionCommandResult<ScheduleCommissionPlanResult>>;
  close?(): Promise<void>;
};

export type StripeFixedPlanCheckoutInput = {
  propertyId: string;
  organizationId: string;
  customerEmail: string;
  existingCustomerId: string | null;
  activeRoomCount: number;
  successUrl: string;
  cancelUrl: string;
  idempotencyKey: string;
};

export type StripeSubscriptionSnapshot = {
  subscriptionId: string;
  customerId: string;
  status: string;
  propertyId: string | null;
  organizationId: string | null;
  fixedPlanVerified: boolean;
  currentPeriodStart: FinanceUtcDateTime | null;
  currentPeriodEnd: FinanceUtcDateTime | null;
  cancelAtPeriodEnd: boolean;
  subscriptionItemId: string | null;
};

export type StripeFinanceSubscriptionProvider = {
  createFixedPlanCheckout(input: StripeFixedPlanCheckoutInput): Promise<{
    checkoutSessionId: string;
    checkoutUrl: string;
  }>;
  expireFixedPlanCheckout(input: {
    checkoutSessionId: string;
    idempotencyKey: string;
  }): Promise<void>;
  createCustomerPortal(input: {
    customerId: string;
    returnUrl: string;
    idempotencyKey: string;
  }): Promise<{ portalUrl: string }>;
  cancelAtPeriodEnd(input: {
    subscriptionId: string;
    idempotencyKey: string;
  }): Promise<StripeSubscriptionSnapshot>;
  retrieveSubscription(subscriptionId: string): Promise<StripeSubscriptionSnapshot>;
  updateRoomQuantity(input: {
    subscriptionId: string;
    subscriptionItemId: string;
    activeRoomCount: number;
    idempotencyKey: string;
  }): Promise<StripeSubscriptionSnapshot>;
};

export function fixedPlanAmountMinor(activeRoomCount: number): number {
  if (!Number.isInteger(activeRoomCount) || activeRoomCount < 0) {
    throw new TypeError("activeRoomCount must be a non-negative integer");
  }
  return (
    FINANCE_FIXED_PLAN_BASE_AMOUNT_MINOR +
    Math.max(activeRoomCount - 1, 0) * FINANCE_FIXED_PLAN_EXTRA_ROOM_AMOUNT_MINOR
  );
}

export function toFinancePlanStatusResponse(
  planStatus: FinancePlanStatusReadModel,
): FinancePlanStatusResponse {
  const { propertyId, ...status } = planStatus;
  return {
    contractVersion: "finance-subscriptions.v1",
    propertyId,
    planStatus: status,
  };
}
