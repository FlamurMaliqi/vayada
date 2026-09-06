import {
  readBankTransferDestination,
  type SavedBankTransferDestination,
} from "@vayada/product-onboarding/bankTransferDestination";
import { ApiErrorResponse, apiClient, omitHotelContext, type ApiClient } from "./client";

export type FinanceRoutePaymentProvider =
  | "stripe"
  | "xendit"
  | "vayada"
  | "manual"
  | "bank_transfer";

export type FinanceRoutePaymentMethod =
  | "card"
  | "pay_at_property"
  | "xendit"
  | "cash"
  | "bank_transfer"
  | "paypal"
  | "manual_card"
  | "wallet"
  | "other";

type FinancePaymentSettingsApiClient = Pick<ApiClient, "patch">;
type FinancePaymentSettingsReadApiClient = Pick<ApiClient, "get">;
type FinanceProviderAccountApiClient = Pick<ApiClient, "post">;

export type FinanceJsonPolicy = Record<string, string | number | boolean | null>;

export interface FinancePaymentSettingsPatchPayload {
  paymentsEnabled?: boolean;
  paymentProvider?: FinanceRoutePaymentProvider;
  acceptedMethods?: FinanceRoutePaymentMethod[];
  defaultCurrency?: string;
  supportedCurrencies?: string[];
  depositPolicy?: FinanceJsonPolicy;
  refundPolicy?: FinanceJsonPolicy;
  taxPolicy?: FinanceJsonPolicy;
  statementDescriptor?: string | null;
  requiresManualReview?: boolean;
}

export interface UpdateFinancePaymentSettingsBody {
  commandId: string;
  idempotencyKey: string;
  paymentSettings: FinancePaymentSettingsPatchPayload;
}

export interface UpdateFinancePaymentSettingsInput {
  propertyId: string;
  body: UpdateFinancePaymentSettingsBody;
}

export interface BookingAdminPaymentSettingsDraft {
  payAtPropertyEnabled: boolean;
  payAtHotelMethods?: string[];
  onlineCardPayment: boolean;
  bankTransfer: boolean;
  paypalEnabled?: boolean;
  paypalEmail?: string;
  paypalPaymentWindowHours?: number;
  payoutAccountHolder?: string;
  payoutAccountType?: "iban" | "account_number";
  payoutIban?: string;
  payoutAccountNumber?: string;
  payoutBankName?: string;
  payoutSwift?: string;
  paymentProvider: Extract<FinanceRoutePaymentProvider, "stripe" | "xendit" | "vayada">;
  defaultCurrency: string;
  requiresManualReview?: boolean;
  commandPrefix?: string;
}

export interface FinancePaymentSettingsPatchResponse {
  contractVersion: string;
  propertyId: string;
  paymentSettings: Record<string, unknown>;
  commandMeta: {
    commandId: string;
    idempotencyKey: string;
    sideEffects: string[];
    outboxEvents: string[];
    jobs: unknown[];
  };
}

export interface FinancePaymentSettingsResponse {
  bankDestination?: SavedBankTransferDestination | null;
  contractVersion: string;
  propertyId: string;
  paymentSettings: {
    paymentsEnabled: boolean;
    paymentProvider: FinanceRoutePaymentProvider;
    acceptedMethods: FinanceRoutePaymentMethod[];
    defaultCurrency: string;
    supportedCurrencies: string[];
    depositPolicy: FinanceJsonPolicy;
    requiresManualReview: boolean;
    providerAccount: {
      providerAccountId: string | null;
      provider: FinanceRoutePaymentProvider | null;
      status: string;
      onboardingStatus: string;
      chargesEnabled: boolean;
      payoutsEnabled: boolean;
      capabilities: string[];
    };
  };
}

export function payAtHotelMethodsFromFinance(
  acceptedMethods: readonly FinanceRoutePaymentMethod[],
): string[] {
  return [
    ...(acceptedMethods.includes("cash") ? ["cash"] : []),
    ...(acceptedMethods.includes("manual_card") ? ["card"] : []),
  ];
}

export interface FinanceStripeProviderAccountResponse {
  contractVersion: string;
  providerAccountId: string;
  provider: "stripe";
  providerAccountRef: string;
  status: string;
  onboardingStatus: string;
  onboardingUrl: string;
}

export interface FinanceStripeDashboardLinkResponse {
  url: string;
}

export interface FinanceStripeProviderAccountReconciliationResponse {
  contractVersion: string;
  propertyId: string;
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
}

export class FinancePaymentSettingsClientError extends Error {
  statusCode: number;
  code: string;
  category: string;
  detail: string;
  details?: unknown;

  constructor(input: {
    statusCode: number;
    code: string;
    category: string;
    detail: string;
    details?: unknown;
  }) {
    super(input.detail);
    this.name = "FinancePaymentSettingsClientError";
    this.statusCode = input.statusCode;
    this.code = input.code;
    this.category = input.category;
    this.detail = input.detail;
    this.details = input.details;
  }
}

export async function updateFinancePaymentSettings(
  input: UpdateFinancePaymentSettingsInput,
  client: FinancePaymentSettingsApiClient = apiClient,
): Promise<FinancePaymentSettingsPatchResponse> {
  try {
    return await client.patch<FinancePaymentSettingsPatchResponse>(
      buildFinancePaymentSettingsEndpoint(input),
      input.body,
      omitHotelContext,
    );
  } catch (error) {
    throw toFinancePaymentSettingsClientError(error);
  }
}

export async function getFinancePaymentSettings(
  input: { propertyId: string },
  client: FinancePaymentSettingsReadApiClient = apiClient,
): Promise<FinancePaymentSettingsResponse> {
  try {
    const response = await client.get<FinancePaymentSettingsResponse>(
      buildFinancePaymentSettingsEndpoint(input),
      omitHotelContext,
    );
    const bankDestination = await readBankTransferDestination(
      { get: (path) => client.get(path, omitHotelContext) },
      input.propertyId,
    );
    return { ...response, bankDestination };
  } catch (error) {
    throw toFinancePaymentSettingsClientError(error);
  }
}

export async function createFinanceStripeProviderAccount(
  input: {
    propertyId: string;
    email: string;
    country: string;
    commandPrefix?: string;
  },
  client: FinanceProviderAccountApiClient = apiClient,
): Promise<FinanceStripeProviderAccountResponse> {
  const commandId = newFinanceCommandId(input.commandPrefix ?? "finance-stripe-account");
  try {
    return await client.post<FinanceStripeProviderAccountResponse>(
      `${buildFinancePaymentSettingsBaseEndpoint(input)}/provider-accounts/stripe`,
      {
        commandId,
        idempotencyKey: commandId,
        email: input.email,
        country: input.country,
        returnSurface: "booking_admin",
      },
      omitHotelContext,
    );
  } catch (error) {
    throw toFinancePaymentSettingsClientError(error);
  }
}

export async function issueFinanceStripeOnboardingLink(
  input: {
    propertyId: string;
    providerAccountId: string;
    commandPrefix?: string;
  },
  client: FinanceProviderAccountApiClient = apiClient,
): Promise<FinanceStripeProviderAccountResponse> {
  const providerAccountId = input.providerAccountId.trim();
  if (!providerAccountId) {
    throw new FinancePaymentSettingsClientError({
      statusCode: 404,
      code: "not_found",
      category: "read_model",
      detail: "Finance provider account id is required.",
    });
  }

  const commandId = newFinanceCommandId(input.commandPrefix ?? "finance-stripe-onboarding");
  try {
    return await client.post<FinanceStripeProviderAccountResponse>(
      `${buildFinancePaymentSettingsBaseEndpoint(input)}/provider-accounts/${encodeURIComponent(providerAccountId)}/onboarding-link`,
      {
        commandId,
        idempotencyKey: commandId,
        returnSurface: "booking_admin",
      },
      omitHotelContext,
    );
  } catch (error) {
    throw toFinancePaymentSettingsClientError(error);
  }
}

export async function createFinanceStripeDashboardLink(
  input: { propertyId: string },
  client: FinanceProviderAccountApiClient = apiClient,
): Promise<FinanceStripeDashboardLinkResponse> {
  try {
    return await client.post<FinanceStripeDashboardLinkResponse>(
      `${buildFinancePaymentSettingsBaseEndpoint(input)}/provider-accounts/stripe/dashboard-link`,
      undefined,
      omitHotelContext,
    );
  } catch (error) {
    throw toFinancePaymentSettingsClientError(error);
  }
}

export async function reconcileFinanceStripeProviderAccount(
  input: { propertyId: string; commandId?: string; commandPrefix?: string },
  client: FinanceProviderAccountApiClient = apiClient,
): Promise<FinanceStripeProviderAccountReconciliationResponse> {
  const commandId =
    input.commandId?.trim() ||
    newFinanceCommandId(input.commandPrefix ?? "finance-stripe-reconcile");
  try {
    return await client.post<FinanceStripeProviderAccountReconciliationResponse>(
      `${buildFinancePaymentSettingsBaseEndpoint(input)}/provider-accounts/stripe/reconcile`,
      { commandId, idempotencyKey: commandId },
      omitHotelContext,
    );
  } catch (error) {
    throw toFinancePaymentSettingsClientError(error);
  }
}

export function buildFinancePaymentSettingsBody(
  draft: BookingAdminPaymentSettingsDraft,
): UpdateFinancePaymentSettingsBody {
  if (draft.payAtPropertyEnabled && !draft.payAtHotelMethods?.length) {
    throw new Error("Choose cash, card, or both for Pay at Hotel.");
  }
  if (draft.paypalEnabled && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmed(draft.paypalEmail) ?? "")) {
    throw new Error("PayPal email must be a valid email address.");
  }
  const commandId = newFinanceCommandId(draft.commandPrefix ?? "finance-payment-settings");
  const defaultCurrency = normalizeCurrencyCode(draft.defaultCurrency);
  const acceptedMethods = buildAcceptedPaymentMethods(draft);
  if (acceptedMethods.length === 0) {
    throw new Error("Choose at least one payment method.");
  }
  const paymentSettings: FinancePaymentSettingsPatchPayload = {
    paymentsEnabled: acceptedMethods.length > 0,
    ...(draft.onlineCardPayment ? { paymentProvider: draft.paymentProvider } : {}),
    acceptedMethods,
    defaultCurrency,
    supportedCurrencies: [defaultCurrency],
    requiresManualReview: draft.requiresManualReview ?? false,
  };
  paymentSettings.depositPolicy = {
    paypalEmail: draft.paypalEnabled ? (trimmed(draft.paypalEmail) ?? "") : "",
    paypalPaymentWindowHours: draft.paypalEnabled
      ? Math.max(1, Math.min(168, draft.paypalPaymentWindowHours ?? 24))
      : 24,
  };

  return {
    commandId,
    idempotencyKey: commandId,
    paymentSettings,
  };
}

export function buildFinancePaymentSettingsEndpoint(input: { propertyId: string }): string {
  return `${buildFinancePaymentSettingsBaseEndpoint(input)}/payment-settings`;
}

function buildFinancePaymentSettingsBaseEndpoint(input: { propertyId: string }): string {
  const propertyId = input.propertyId.trim();
  if (!propertyId) {
    throw new FinancePaymentSettingsClientError({
      statusCode: 404,
      code: "not_found",
      category: "read_model",
      detail: "Finance property id is required.",
    });
  }

  return `/api/finance/properties/${encodeURIComponent(propertyId)}`;
}

function buildAcceptedPaymentMethods(
  draft: BookingAdminPaymentSettingsDraft,
): FinanceRoutePaymentMethod[] {
  const methods = new Set<FinanceRoutePaymentMethod>();
  if (draft.payAtPropertyEnabled) {
    methods.add("pay_at_property");
    if (draft.payAtHotelMethods?.includes("cash")) methods.add("cash");
    if (draft.payAtHotelMethods?.includes("card")) methods.add("manual_card");
  }
  if (draft.onlineCardPayment) {
    methods.add(draft.paymentProvider === "xendit" ? "xendit" : "card");
  }
  if (draft.bankTransfer) methods.add("bank_transfer");
  if (draft.paypalEnabled) methods.add("paypal");
  return Array.from(methods);
}

function trimmed(value: string | undefined): string | null {
  const text = value?.trim() ?? "";
  return text || null;
}

function normalizeCurrencyCode(value: string): string {
  const normalized = value.trim().toUpperCase();
  return /^[A-Z]{3}$/.test(normalized) ? normalized : "EUR";
}

function newFinanceCommandId(prefix: string): string {
  const random =
    typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
      ? crypto.randomUUID()
      : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return `${prefix}-${random}`;
}

function toFinancePaymentSettingsClientError(error: unknown): FinancePaymentSettingsClientError {
  if (error instanceof FinancePaymentSettingsClientError) return error;

  if (error instanceof ApiErrorResponse) {
    const data = error.data as Partial<{
      statusCode: unknown;
      code: unknown;
      category: unknown;
      message: unknown;
      detail: unknown;
      details: unknown;
    }> | null;
    const detail =
      typeof data?.message === "string"
        ? data.message
        : typeof data?.detail === "string"
          ? data.detail
          : error.message;
    return new FinancePaymentSettingsClientError({
      statusCode: typeof data?.statusCode === "number" ? data.statusCode : error.status,
      code: typeof data?.code === "string" ? data.code : "write_model_unavailable",
      category: typeof data?.category === "string" ? data.category : "write_model",
      detail,
      details: data?.details,
    });
  }

  return new FinancePaymentSettingsClientError({
    statusCode: 500,
    code: "write_model_unavailable",
    category: "write_model",
    detail: error instanceof Error ? error.message : "Finance payment settings are unavailable.",
  });
}
