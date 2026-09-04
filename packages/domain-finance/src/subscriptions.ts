import type { FinanceCommandAudit, FinanceUtcDateTime } from "./index.js";

export const FINANCE_FIXED_PLAN_CURRENCY = "EUR" as const;
export const FINANCE_FIXED_PLAN_INTERVAL_MONTHS = 1 as const;

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
  currency: string;
  activeRoomCount: number;
  amountMinor: number;
  fixedPlanAvailable: boolean;
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
  returnSurface?: "booking-admin" | "pms";
};

export type CreateFixedPlanCheckoutResult = {
  checkoutSessionId: string;
  checkoutUrl: string;
  currency: string;
  amountMinor: number;
  activeRoomCount: number;
};

export type ActivateFixedPlanByInvoiceCommand = FinanceSubscriptionCommandContext;

export type OpenFinanceCustomerPortalCommand = FinanceSubscriptionCommandContext;

export type OpenFinanceCustomerPortalResult = {
  portalUrl: string;
};

export type ScheduleCommissionPlanCommand = FinanceSubscriptionCommandContext;

export type ScheduleCommissionPlanResult = {
  planStatus: FinancePlanStatusReadModel;
};

export type FinancePaymentCollectionMethod = "card" | "bank_transfer";

export type FinanceBillingDetails = {
  companyName: string;
  billingEmail: string;
  taxId: string | null;
};

export type FinanceSavedCard = {
  brand: string;
  last4: string;
  expiryMonth: number;
  expiryYear: number;
};

export type FinanceBillingInvoice = {
  id: string;
  number: string;
  issuedAt: FinanceUtcDateTime;
  amountMinor: number;
  currency: string;
  status: "paid" | "pending" | "failed";
  pdfUrl: string | null;
};

export type FinanceBillingOverview = {
  propertyId: string;
  planStatus: FinancePlanStatusReadModel;
  paymentMethod: FinancePaymentCollectionMethod;
  savedCard: FinanceSavedCard | null;
  billingDetails: FinanceBillingDetails;
  invoices: FinanceBillingInvoice[];
};

export type UpdateFinanceBillingDetailsCommand = FinanceSubscriptionCommandContext & {
  billingDetails: FinanceBillingDetails;
};

export type UpdateFinancePaymentMethodCommand = FinanceSubscriptionCommandContext & {
  paymentMethod: FinancePaymentCollectionMethod;
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
  getBillingOverview(propertyId: string): Promise<FinanceBillingOverview>;
  createFixedPlanCheckout(
    command: CreateFixedPlanCheckoutCommand,
  ): Promise<FinanceSubscriptionCommandResult<CreateFixedPlanCheckoutResult>>;
  activateFixedPlanByInvoice(
    command: ActivateFixedPlanByInvoiceCommand,
  ): Promise<FinanceSubscriptionCommandResult<FinanceBillingOverview>>;
  activateFixedPlanByCard(
    command: ActivateFixedPlanByInvoiceCommand,
  ): Promise<FinanceSubscriptionCommandResult<FinanceBillingOverview>>;
  selectCommissionPlan(
    command: SelectCommissionPlanCommand,
  ): Promise<FinanceSubscriptionCommandResult<SelectCommissionPlanResult>>;
  openCustomerPortal(
    command: OpenFinanceCustomerPortalCommand & { returnSurface?: "booking-admin" | "pms" },
  ): Promise<FinanceSubscriptionCommandResult<OpenFinanceCustomerPortalResult>>;
  scheduleCommissionPlan(
    command: ScheduleCommissionPlanCommand,
  ): Promise<FinanceSubscriptionCommandResult<ScheduleCommissionPlanResult>>;
  switchToCommissionNow(
    command: ScheduleCommissionPlanCommand,
  ): Promise<FinanceSubscriptionCommandResult<ScheduleCommissionPlanResult>>;
  updateBillingDetails(
    command: UpdateFinanceBillingDetailsCommand,
  ): Promise<FinanceSubscriptionCommandResult<FinanceBillingOverview>>;
  updatePaymentMethod(
    command: UpdateFinancePaymentMethodCommand,
  ): Promise<FinanceSubscriptionCommandResult<FinanceBillingOverview>>;
  close?(): Promise<void>;
};

export type StripeFixedPlanCheckoutInput = {
  propertyId: string;
  organizationId: string;
  customerEmail: string;
  existingCustomerId: string | null;
  activeRoomCount: number;
  currency: string;
  billingCycleAnchor: FinanceUtcDateTime;
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
  currency: string;
};

export type StripeFinanceSubscriptionProvider = {
  createFixedPlanCheckout(input: StripeFixedPlanCheckoutInput): Promise<{
    checkoutSessionId: string;
    checkoutUrl: string;
  }>;
  createFixedPlanInvoiceSubscription(input: {
    propertyId: string;
    organizationId: string;
    customerId: string;
    activeRoomCount: number;
    currency: string;
    billingCycleAnchor: FinanceUtcDateTime;
    idempotencyKey: string;
  }): Promise<StripeSubscriptionSnapshot>;
  createFixedPlanCardSubscription(input: {
    propertyId: string;
    organizationId: string;
    customerId: string;
    activeRoomCount: number;
    currency: string;
    billingCycleAnchor: FinanceUtcDateTime;
    idempotencyKey: string;
  }): Promise<StripeSubscriptionSnapshot>;
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
  cancelImmediately(input: {
    subscriptionId: string;
    idempotencyKey: string;
  }): Promise<StripeSubscriptionSnapshot>;
  getCustomerBilling(customerId: string): Promise<{ savedCard: FinanceSavedCard | null }>;
  upsertCustomer(input: {
    customerId: string | null;
    propertyId: string;
    organizationId: string;
    billingDetails: FinanceBillingDetails;
    idempotencyKey: string;
  }): Promise<{ customerId: string }>;
  listInvoices(customerId: string): Promise<FinanceBillingInvoice[]>;
  updateCollectionMethod(input: {
    subscriptionId: string;
    paymentMethod: FinancePaymentCollectionMethod;
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

export function fixedPlanAmountMinor(
  activeRoomCount: number,
  currency: string = FINANCE_FIXED_PLAN_CURRENCY,
): number {
  if (!Number.isInteger(activeRoomCount) || activeRoomCount < 0) {
    throw new TypeError("activeRoomCount must be a non-negative integer");
  }
  const normalizedCurrency = currency.trim().toUpperCase();
  const price = FIXED_PLAN_PRICE_CATALOG[normalizedCurrency];
  if (!price) {
    throw new RangeError(`Fixed Plan pricing is not configured for ${normalizedCurrency}.`);
  }
  return price.baseAmountMinor + Math.max(activeRoomCount - 1, 0) * price.extraRoomAmountMinor;
}

const FIXED_PLAN_PRICE_CATALOG: Readonly<
  Record<string, { baseAmountMinor: number; extraRoomAmountMinor: number }>
> = Object.freeze({
  EUR: { baseAmountMinor: 3_000, extraRoomAmountMinor: 500 },
  USD: { baseAmountMinor: 3_000, extraRoomAmountMinor: 500 },
  IDR: { baseAmountMinor: 50_000_000, extraRoomAmountMinor: 8_000_000 },
});

export function stripeCurrencyHasZeroDecimals(currency: string): boolean {
  return ZERO_DECIMAL_CURRENCIES.has(currency.trim().toUpperCase());
}

const ZERO_DECIMAL_CURRENCIES = new Set([
  "BIF",
  "CLP",
  "DJF",
  "GNF",
  "JPY",
  "KMF",
  "KRW",
  "MGA",
  "PYG",
  "RWF",
  "UGX",
  "VND",
  "VUV",
  "XAF",
  "XOF",
  "XPF",
]);

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
