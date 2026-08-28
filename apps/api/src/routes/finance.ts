import {
  FINANCE_PAYOUT_STATUSES,
  FINANCE_PROVIDER_ACCOUNT_COMMAND_SIDE_EFFECTS,
  FINANCE_PROVIDER_ACCOUNT_STATUSES,
  FINANCE_PROVIDER_ONBOARDING_STATUSES,
  FINANCE_RECONCILIATION_JOB_STATUSES,
  FINANCE_RECONCILIATION_RECEIPT_STATUSES,
  FINANCE_RECONCILIATION_SUBJECT_TYPES,
  FINANCE_ROUTE_CONTRACT_VERSION,
  FINANCE_ROUTE_PAYMENT_METHODS,
  FINANCE_ROUTE_PAYMENT_PROVIDERS,
  cancellationPolicyFromRefundPolicy,
  setupIncompleteAffiliatePayoutSettings,
  setupIncompletePaymentSettings,
  type FinanceAffiliatePayoutListResponse,
  type FinanceAffiliatePayoutProvider,
  type FinanceAffiliatePayoutSettingsPatchCommand,
  type FinanceAffiliatePayoutSettingsPatchResult,
  type FinanceAffiliatePayoutSettingsReadModel,
  type FinanceAffiliatePayoutSettingsResponse,
  type FinanceAffiliatePayoutSchedule,
  toFinanceCancellationPolicyResponse,
  toFinancePaymentSettingsResponse,
  toPublicPaymentCapabilityProjection,
  type CancellationPolicy,
  type CreateStripeProviderAccountCommand,
  type FinanceCommandAudit,
  type FinanceCommandMeta,
  type FinanceJsonObject,
  type FinanceJsonPolicy,
  type FinancePaymentSettingsPatchCommand,
  type FinancePaymentSettingsPatchResponse,
  type FinancePaymentSettingsPatchResult,
  type FinancePaymentSettingsPatchPayload,
  type FinancePaymentSettingsReadModel,
  type FinancePayout,
  type FinancePayoutListQuery,
  type FinancePayoutListResponse,
  type FinanceProviderAccountCommandMeta,
  type FinanceProviderAccountCommandResponse,
  type FinanceProviderAccountCommandResult,
  type FinancePropertyPayoutDispatchCommand,
  type FinancePropertyPayoutDispatchReadiness,
  type FinancePropertyPayoutDispatchResponse,
  type FinancePropertyPayoutDispatchResult,
  type FinancePropertyReadRepository,
  type FinanceProviderAccountStatus,
  type FinanceProviderOnboardingStatus,
  type FinanceStripeDashboardLoginLinkResult,
  type FinanceStripeProviderAccountReconciliationResponse,
  type FinanceStripeProviderAccountReconciliationResult,
  type FinanceReconciliationItem,
  type FinanceReconciliationJobStatus,
  type FinanceReconciliationRecommendedAction,
  type FinanceReconciliationReceiptStatus,
  type FinanceReconciliationViewKind,
  type FinanceReconciliationViewQuery,
  type FinanceReconciliationViewResponse,
  type FinanceRoutePaymentMethod,
  type FinanceRoutePaymentProvider,
  type FinanceStripeConnectProvider,
  type IssueStripeOnboardingLinkCommand,
  type ReconcileStripePropertyAccountCommand,
  StripeConnectAccountNotFoundError,
  type StripeConnectProviderAccountSnapshot,
  type FinanceXenditBankValidationCommand,
  type FinanceXenditBankValidationResponse,
  type FinanceXenditPayoutReconciliationCommand,
  type FinanceXenditPayoutReconciliationResult,
  type FinanceXenditPayoutReconciliationResponse,
} from "@vayada/domain-finance";
import { requireAuthContext, type RequestContext } from "@vayada/backend-auth";
import type { PublicBookabilityPublicationCommandPort } from "@vayada/domain-distribution";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import pg, { type QueryResult, type QueryResultRow } from "pg";

import type { PublicHotelProfileRepository } from "./aiHotels.js";
import {
  applyStripeProviderAccountSnapshot,
  type StripeProviderAccountReconciliationState,
} from "../domains/stripeProviderAccountReconciliation.js";
import { lockStripeProviderAccountReference } from "../domains/financeStripeProviderAccountReferenceLock.js";
import {
  applyFinanceOnlineCardReadinessLoss,
  loadFinanceOnlineCardReadinessState,
  lockFinanceOnlineCardReadinessProperty,
  type FinanceOnlineCardReadinessState,
  type FinanceOnlineCardReadinessChangeContext,
} from "../domains/financeOnlineCardReadinessTransition.js";
import { createFinancePlatformAffiliatePayoutMarkPaidRepository } from "./financePlatformAffiliatePayoutMarkPaid.js";
import { createFinancePlatformAffiliatePayoutReadRepository } from "./financePlatformAffiliatePayoutRepository.js";
import { registerFinancePlatformAffiliatePayoutRoutes } from "./financePlatformAffiliatePayoutRoutes.js";
import { createFinanceOnlineCardExecutionEvidenceRepository } from "./financeOnlineCardExecutionEvidenceRepository.js";
import { registerFinancePlatformOnlineCardExecutionEvidenceRoutes } from "./financePlatformOnlineCardExecutionEvidenceRoutes.js";
import { enforceRoutePolicy, type RouteAuthorizationPolicy } from "./policy.js";
import {
  FINANCE_STRIPE_ACCOUNT_COMPENSATION_JOB_TYPE,
  FINANCE_STRIPE_ACCOUNT_COMPENSATION_QUEUE,
} from "../jobs/financeStripeAccountCompensation.js";

const XENDIT_BANK_VALIDATION_SIDE_EFFECTS: FinanceCommandMeta["sideEffects"] = [
  "provider_validation",
  "audit_event",
];

const XENDIT_PAYOUT_RECONCILIATION_SIDE_EFFECTS: FinanceCommandMeta["sideEffects"] = [
  "reconciliation_job",
  "audit_event",
];

const PROPERTY_PAYOUT_DISPATCH_SIDE_EFFECTS: FinanceCommandMeta["sideEffects"] = [
  "payout_job",
  "audit_event",
];

const AFFILIATE_PAYOUT_SETTINGS_SIDE_EFFECTS: FinanceCommandMeta["sideEffects"] = ["audit_event"];
const PAYMENT_SETTINGS_SIDE_EFFECTS: FinanceCommandMeta["sideEffects"] = ["audit_event"];
const STRIPE_DASHBOARD_LINK_RATE_LIMIT = 10;
const STRIPE_DASHBOARD_LINK_RATE_WINDOW_MS = 60_000;

const XENDIT_PAYOUT_RECONCILIATION_LEGACY_DISPOSITION =
  "legacy /admin/xendit/reconcile-payouts disabled or proxied during rehearsal";

const PROPERTY_PAYOUT_DISPATCH_LEGACY_DISPOSITION =
  "legacy process_property_payouts disabled before target property payout dispatch";

const PROPERTY_PAYOUT_DISPATCH_ROLLBACK_RULE =
  "Stop target dispatcher, reconcile provider transfer IDs, and re-enable legacy only for payouts with no successful target transfer.";

type FinanceQueryExecutor = {
  query<T extends QueryResultRow = QueryResultRow>(
    text: string,
    values?: readonly unknown[],
  ): Promise<Pick<QueryResult<T>, "rows">>;
};

export type FinancePropertySettingsReadPool = FinanceQueryExecutor & {
  connect?(): Promise<FinancePropertySettingsWriteClient>;
  end(): Promise<void>;
};

export type FinancePropertySettingsWriteClient = {
  query<T extends QueryResultRow = QueryResultRow>(
    text: string,
    values?: readonly unknown[],
  ): Promise<Pick<QueryResult<T>, "rows" | "rowCount">>;
  release?(): void;
};

export type FinanceRoutesOptions = {
  repository: FinancePropertyReadRepository;
  publicBookabilityPublisher?: Pick<PublicBookabilityPublicationCommandPort, "publish">;
  xenditBankValidator?: FinanceXenditBankValidator;
  publicHotelPropertyResolver?: FinancePublicHotelPropertyResolver;
  publicHotelProfileRepository?: PublicHotelProfileRepository;
  closePublicHotelProfileRepository?: boolean;
};

export type PmsFinanceCompatibilityRoutesOptions = {
  repository: FinancePropertyReadRepository;
};

export type FinanceXenditBankValidator = {
  validateBankAccount(input: {
    channelCode: string;
    accountNumber: string;
    accountHolderName: string;
    idempotencyKey: string;
  }): Promise<{
    status: "valid" | "invalid" | "unknown";
    accountHolderName: string | null;
    providerReference: string | null;
  }>;
};

type FinanceXenditBankValidatorFetch = (
  input: string,
  init?: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
    signal?: AbortSignal;
  },
) => Promise<{
  ok: boolean;
  status: number;
  text(): Promise<string>;
  json(): Promise<unknown>;
}>;

export type FinancePublicHotelPropertyResolver = {
  findPropertyIdBySlug(slug: string): Promise<string | null>;
  close?(): Promise<void>;
};

type FinancePublicHotelPropertyRow = {
  propertyId: string;
};

type FinancePropertyParams = {
  propertyId: string;
};

type FinanceAffiliateParams = {
  affiliateId: string;
};

type FinanceProviderAccountParams = FinancePropertyParams & {
  providerAccountId: string;
};

type FinanceAffiliateProviderAccountParams = FinanceAffiliateParams & {
  providerAccountId: string;
};

type FinancePayoutParams = FinancePropertyParams & {
  payoutId: string;
};

type BookingWebHotelParams = {
  slug: string;
};

type FinancePaymentSettingsRow = {
  propertyId: string;
  paymentsEnabled: boolean | null;
  acceptedMethods: unknown;
  defaultCurrency: string | null;
  depositPolicy: unknown;
  refundPolicy: unknown;
  taxPolicy: unknown;
  statementDescriptor: string | null;
  requiresManualReview: boolean | null;
  updatedAt: Date | string | null;
  providerAccountId: string | null;
  provider: string | null;
  providerStatus: string | null;
  providerOnboardingStatus: string | null;
  chargesEnabled: boolean | null;
  payoutsEnabled: boolean | null;
  providerCapabilities: unknown;
};

type FinanceAffiliateResourceRow = {
  organizationId: string;
};

type FinanceAffiliatePayoutSettingsRow = {
  affiliateId: string;
  marketplaceOrganizationId: string | null;
  payoutsEnabled: boolean | null;
  payoutProvider: string | null;
  payoutCurrency: string | null;
  payoutSchedule: unknown;
  payoutPreferences: unknown;
  payoutThresholdAmount: string | null;
  updatedAt: Date | string | null;
  providerAccountId: string | null;
  provider: string | null;
  providerStatus: string | null;
  providerOnboardingStatus: string | null;
  providerPayoutsEnabled: boolean | null;
  sourceFreshness: unknown;
};

type FinancePayoutRow = {
  payoutId: string;
  ownerScope: string;
  propertyId: string | null;
  organizationId: string | null;
  relatedPropertyId: string | null;
  guestBookingId: string | null;
  paymentId: string | null;
  payoutStatus: string;
  amount: string;
  feeAmount: string;
  netAmount: string;
  currency: string;
  provider: string | null;
  providerPayoutId: string | null;
  scheduledAt: Date | string | null;
  paidAt: Date | string | null;
  failedAt: Date | string | null;
  failureCode: string | null;
  retryCount: number;
  total: string | number;
  sourceFreshness: unknown;
};

type FinanceReconciliationRow = {
  subjectId: string;
  subjectType: string;
  provider: string | null;
  financeStatus: string;
  providerStatus: string | null;
  latestReceiptStatus: string;
  jobStatus: string;
  recommendedAction: string;
  lastReceiptAt: Date | string | null;
  lastJobAt: Date | string | null;
  total: string | number;
  sourceFreshness: unknown;
};

type FinanceProviderAccountRow = {
  providerAccountId: string;
  providerAccountRef: string;
  status: string;
  onboardingStatus: string;
  onboardingUrl: string | null;
};

type StripeProviderAccountInsert = {
  account: FinanceProviderAccountRow;
  inserted: boolean;
};

type StripeProviderAccountOwnershipRow = FinanceProviderAccountRow & {
  accountScope: string;
  propertyId: string | null;
  organizationId: string | null;
  affiliateId: string | null;
};

type ConfiguredStripeProviderAccountRow = StripeProviderAccountReconciliationState & {
  providerAccountRef: string;
};

type FinanceRowsWithTotal<T extends { total: string | number }> = {
  rows: T[];
  total: number;
};

type FinanceIdempotencyRow = {
  status: string;
  requestFingerprintHash: string;
  idempotencyMetadata: unknown;
};

type FinancePropertyPayoutDispatchReadinessRow = {
  payoutId: string;
  provider: string | null;
  providerPayoutId: string | null;
  reconciliationReadyAt: string | null;
  legacySchedulerFrozenAt: string | null;
  reconciliationBlockers: string | number;
  activeLegacyTransferWindow: boolean | null;
};

type FinanceAccessError = {
  statusCode: 401 | 403;
  code:
    | "unauthenticated"
    | "missing_permission"
    | "missing_entitlement"
    | "inactive_entitlement"
    | "missing_resource_access";
  category: "authentication" | "authorization";
  message: string;
};

type FinanceValidationError = {
  statusCode: 400;
  code:
    | "invalid_query"
    | "invalid_provider"
    | "invalid_payment_method"
    | "invalid_date_range"
    | "invalid_body";
  category: "validation";
  message: string;
};

type FinanceCommandError = {
  statusCode: 400 | 404 | 409 | 429 | 500 | 501 | 502;
  code:
    | "invalid_command"
    | "affiliate_not_found"
    | "property_not_found"
    | "property_currency_conflict"
    | "invoice_not_found"
    | "provider_account_not_found"
    | "payout_not_found"
    | "reconciliation_not_ready"
    | "legacy_scheduler_not_frozen"
    | "active_legacy_transfer_window"
    | "payout_already_dispatched"
    | "idempotency_conflict"
    | "rate_limited"
    | "write_unavailable"
    | "provider_unavailable"
    | "provider_rejected";
  category: "validation" | "not_found" | "conflict" | "rate_limit" | "write_model" | "provider";
  message: string;
};

type StripeProviderAccountBody = {
  commandId?: unknown;
  idempotencyKey?: unknown;
  email?: unknown;
  country?: unknown;
  returnSurface?: unknown;
};

type OnboardingLinkBody = {
  commandId?: unknown;
  idempotencyKey?: unknown;
  returnSurface?: unknown;
};

type StripeProviderAccountReconciliationBody = {
  commandId?: unknown;
  idempotencyKey?: unknown;
};

type XenditBankValidationBody = {
  commandId?: unknown;
  idempotencyKey?: unknown;
  channelCode?: unknown;
  accountNumber?: unknown;
  accountHolderName?: unknown;
};

type XenditPayoutReconciliationBody = {
  commandId?: unknown;
  idempotencyKey?: unknown;
  olderThanMinutes?: unknown;
};

type PropertyPayoutDispatchBody = {
  commandId?: unknown;
  idempotencyKey?: unknown;
  legacySchedulerFrozenAt?: unknown;
  reconciliationReadyAt?: unknown;
};

type AffiliatePayoutSettingsPatchBody = {
  commandId?: unknown;
  idempotencyKey?: unknown;
  payoutsEnabled?: unknown;
  payoutProvider?: unknown;
  payoutCurrency?: unknown;
  payoutSchedule?: unknown;
  payoutThresholdAmount?: unknown;
};

type PaymentSettingsPatchBody = {
  commandId?: unknown;
  idempotencyKey?: unknown;
  paymentSettings?: unknown;
};

export async function registerFinanceRoutes(
  app: FastifyInstance,
  options: FinanceRoutesOptions,
): Promise<void> {
  const stripeDashboardLinkRateLimits = new Map<string, { count: number; resetAt: number }>();
  app.addHook("onClose", async () => {
    await options.repository.close?.();
    await options.publicHotelPropertyResolver?.close?.();
    if (options.closePublicHotelProfileRepository) {
      await options.publicHotelProfileRepository?.close?.();
    }
  });

  await registerFinancePlatformAffiliatePayoutRoutes(app, { repository: options.repository });
  await registerFinancePlatformOnlineCardExecutionEvidenceRoutes(app, {
    repository: options.repository,
  });

  app.get<{ Params: FinancePropertyParams }>(
    "/finance/properties/:propertyId/payment-settings",
    async (request, reply) => {
      const propertyId = request.params.propertyId;
      if (!enforceFinancePropertyReadPolicy(request, reply, propertyId)) return reply;

      const settings =
        (await options.repository.getPaymentSettings(propertyId)) ??
        setupIncompletePaymentSettings(propertyId, new Date().toISOString());
      return toFinancePaymentSettingsResponse(settings);
    },
  );

  app.patch<{ Params: FinancePropertyParams; Body: PaymentSettingsPatchBody }>(
    "/finance/properties/:propertyId/payment-settings",
    async (request, reply) => {
      const propertyId = request.params.propertyId;
      if (!enforceFinancePropertyWritePolicy(request, reply, propertyId)) return reply;

      if (!options.repository.updatePaymentSettings) {
        reply.code(501);
        return {
          statusCode: 501,
          code: "write_unavailable",
          category: "write_model",
          message: "Finance payment settings writes are not configured.",
        } satisfies FinanceCommandError;
      }

      const parsed = toPaymentSettingsPatchCommand(request, propertyId);
      if ("statusCode" in parsed) {
        reply.code(parsed.statusCode);
        return parsed;
      }

      const result = await options.repository.updatePaymentSettings(parsed);
      if (!result.ok) {
        const error = toFinanceCommandError(result);
        reply.code(error.statusCode);
        return error;
      }

      await options.publicBookabilityPublisher?.publish({ propertyId });

      return {
        ...toFinancePaymentSettingsResponse(result.settings),
        commandMeta: result.commandMeta,
      } satisfies FinancePaymentSettingsPatchResponse;
    },
  );

  app.get<{ Params: FinancePropertyParams }>(
    "/finance/properties/:propertyId/cancellation-policy",
    async (request, reply) => {
      const propertyId = request.params.propertyId;
      if (!enforceFinancePropertyReadPolicy(request, reply, propertyId)) return reply;

      const policy =
        (await options.repository.getCancellationPolicy(propertyId)) ??
        cancellationPolicyFromRefundPolicy({}, new Date().toISOString());
      return toFinanceCancellationPolicyResponse(propertyId, policy);
    },
  );

  app.post<{ Params: FinancePropertyParams; Body: StripeProviderAccountBody }>(
    "/finance/properties/:propertyId/provider-accounts/stripe",
    async (request, reply) => {
      const propertyId = request.params.propertyId;
      if (!enforceFinancePropertyWritePolicy(request, reply, propertyId)) return reply;

      if (!options.repository.createStripeProviderAccount) {
        reply.code(501);
        return {
          statusCode: 501,
          code: "write_unavailable",
          category: "write_model",
          message: "Finance Stripe provider-account writes are not configured.",
        } satisfies FinanceCommandError;
      }

      const parsed = toStripePropertyAccountCommand(request, propertyId);
      if ("statusCode" in parsed) {
        reply.code(parsed.statusCode);
        return parsed;
      }

      const result = await options.repository.createStripeProviderAccount(parsed);
      if (!result.ok) {
        const error = toFinanceCommandError(result);
        reply.code(error.statusCode);
        return error;
      }

      reply.code(200);
      return result.response;
    },
  );

  app.post<{ Params: FinanceProviderAccountParams; Body: OnboardingLinkBody }>(
    "/finance/properties/:propertyId/provider-accounts/:providerAccountId/onboarding-link",
    async (request, reply) => {
      const propertyId = request.params.propertyId;
      if (!enforceFinancePropertyWritePolicy(request, reply, propertyId)) return reply;

      if (!options.repository.issueStripeOnboardingLink) {
        reply.code(501);
        return {
          statusCode: 501,
          code: "write_unavailable",
          category: "write_model",
          message: "Finance Stripe onboarding-link writes are not configured.",
        } satisfies FinanceCommandError;
      }

      const parsed = toStripePropertyOnboardingLinkCommand(
        request,
        propertyId,
        request.params.providerAccountId,
      );
      if ("statusCode" in parsed) {
        reply.code(parsed.statusCode);
        return parsed;
      }

      const result = await options.repository.issueStripeOnboardingLink(parsed);
      if (!result.ok) {
        const error = toFinanceCommandError(result);
        reply.code(error.statusCode);
        return error;
      }

      return result.response;
    },
  );

  app.post<{
    Params: FinancePropertyParams;
    Body: StripeProviderAccountReconciliationBody;
  }>(
    "/finance/properties/:propertyId/provider-accounts/stripe/reconcile",
    async (request, reply) => {
      const propertyId = request.params.propertyId;
      if (!enforceFinancePropertyWritePolicy(request, reply, propertyId)) return reply;

      if (!options.repository.reconcileStripeProviderAccount) {
        reply.code(501);
        return {
          statusCode: 501,
          code: "write_unavailable",
          category: "write_model",
          message: "Finance Stripe reconciliation is not configured.",
        } satisfies FinanceCommandError;
      }

      const parsed = toStripePropertyAccountReconciliationCommand(request, propertyId);
      if ("statusCode" in parsed) {
        reply.code(parsed.statusCode);
        return parsed;
      }

      const result = await options.repository.reconcileStripeProviderAccount(parsed);
      if (!result.ok) {
        const error = toFinanceCommandError(result);
        reply.code(error.statusCode);
        return error;
      }

      reply.header("Cache-Control", "no-store");
      return result.response;
    },
  );

  app.post<{ Params: FinancePropertyParams }>(
    "/finance/properties/:propertyId/provider-accounts/stripe/dashboard-link",
    async (request, reply) => {
      const propertyId = request.params.propertyId;
      if (!enforceFinancePropertyWritePolicy(request, reply, propertyId)) return reply;

      const actorUserId = requireAuthContext(request).actor.internalUserId;
      const rateLimit = consumeStripeDashboardLinkRateLimit(
        stripeDashboardLinkRateLimits,
        `${actorUserId}:${propertyId}`,
      );
      if (!rateLimit.ok) {
        reply.code(429).header("Retry-After", String(rateLimit.retryAfterSeconds));
        return {
          statusCode: 429,
          code: "rate_limited",
          category: "rate_limit",
          message: "Too many Stripe Dashboard requests. Please try again shortly.",
        } satisfies FinanceCommandError;
      }

      if (!options.repository.issueStripeDashboardLoginLink) {
        reply.code(501);
        return {
          statusCode: 501,
          code: "write_unavailable",
          category: "write_model",
          message: "Finance Stripe dashboard links are not configured.",
        } satisfies FinanceCommandError;
      }

      const result = await options.repository.issueStripeDashboardLoginLink(propertyId);
      if (!result.ok) {
        reply.code(result.statusCode);
        return {
          statusCode: result.statusCode,
          code: result.code,
          category: result.statusCode === 404 ? "not_found" : "provider",
          message: result.message,
        } satisfies FinanceCommandError;
      }

      reply.header("Cache-Control", "no-store");
      return { url: result.url };
    },
  );

  app.post<{ Params: FinanceAffiliateParams; Body: StripeProviderAccountBody }>(
    "/finance/affiliates/:affiliateId/provider-accounts/stripe",
    async (request, reply) => {
      const affiliateId = request.params.affiliateId;
      const context = enforceFinanceAffiliateWritePolicy(request, reply, affiliateId);
      if (!context) return reply;

      if (!options.repository.createStripeProviderAccount) {
        reply.code(501);
        return {
          statusCode: 501,
          code: "write_unavailable",
          category: "write_model",
          message: "Finance Stripe affiliate provider-account writes are not configured.",
        } satisfies FinanceCommandError;
      }

      const parsed = toStripeAffiliateAccountCommand(request, affiliateId, context);
      if ("statusCode" in parsed) {
        reply.code(parsed.statusCode);
        return parsed;
      }

      const result = await options.repository.createStripeProviderAccount(parsed);
      if (!result.ok) {
        const error = toFinanceCommandError(result);
        reply.code(error.statusCode);
        return error;
      }

      reply.code(200);
      return result.response;
    },
  );

  app.post<{ Params: FinanceAffiliateProviderAccountParams; Body: OnboardingLinkBody }>(
    "/finance/affiliates/:affiliateId/provider-accounts/:providerAccountId/onboarding-link",
    async (request, reply) => {
      const affiliateId = request.params.affiliateId;
      const context = enforceFinanceAffiliateWritePolicy(request, reply, affiliateId);
      if (!context) return reply;

      if (!options.repository.issueStripeOnboardingLink) {
        reply.code(501);
        return {
          statusCode: 501,
          code: "write_unavailable",
          category: "write_model",
          message: "Finance Stripe affiliate onboarding-link writes are not configured.",
        } satisfies FinanceCommandError;
      }

      const parsed = toStripeAffiliateOnboardingLinkCommand(
        request,
        affiliateId,
        request.params.providerAccountId,
        context,
      );
      if ("statusCode" in parsed) {
        reply.code(parsed.statusCode);
        return parsed;
      }

      const result = await options.repository.issueStripeOnboardingLink(parsed);
      if (!result.ok) {
        const error = toFinanceCommandError(result);
        reply.code(error.statusCode);
        return error;
      }

      return { onboardingUrl: result.response.onboardingUrl };
    },
  );

  app.get<{ Params: FinancePropertyParams }>(
    "/finance/properties/:propertyId/payouts",
    async (request, reply) => {
      const propertyId = request.params.propertyId;
      if (!enforceFinancePropertyReadPolicy(request, reply, propertyId)) return reply;
      const query = parsePayoutListQuery(request.query);
      if ("statusCode" in query) {
        reply.code(query.statusCode);
        return query;
      }

      const result =
        (await options.repository.listPayouts?.(propertyId, query)) ?? emptyPayoutList(query);
      return {
        contractVersion: FINANCE_ROUTE_CONTRACT_VERSION,
        propertyId,
        ...result,
      } satisfies FinancePayoutListResponse;
    },
  );

  app.get<{ Params: FinanceAffiliateParams }>(
    "/finance/affiliates/:affiliateId/payout-settings",
    async (request, reply) => {
      const affiliateId = request.params.affiliateId;
      if (!enforceFinanceAffiliatePolicy(request, reply, affiliateId)) return reply;

      const settings = await options.repository.getAffiliatePayoutSettings?.(affiliateId);
      if (!settings) {
        reply.code(404);
        return {
          code: "affiliate_not_found",
          category: "not_found",
          message: "Affiliate finance resource was not found.",
        };
      }
      return toAffiliatePayoutSettingsResponse(settings);
    },
  );

  app.patch<{ Params: FinanceAffiliateParams; Body: AffiliatePayoutSettingsPatchBody }>(
    "/finance/affiliates/:affiliateId/payout-settings",
    async (request, reply) => {
      const affiliateId = request.params.affiliateId;
      if (!enforceFinanceAffiliatePolicy(request, reply, affiliateId)) return reply;
      if (!options.repository.updateAffiliatePayoutSettings) {
        reply.code(501);
        return {
          statusCode: 501,
          code: "write_unavailable",
          category: "write_model",
          message: "Affiliate payout settings writes are not configured.",
        } satisfies FinanceCommandError;
      }

      const parsed = toAffiliatePayoutSettingsPatchCommand(request, affiliateId);
      if ("statusCode" in parsed) {
        reply.code(parsed.statusCode);
        return parsed;
      }

      const result = await options.repository.updateAffiliatePayoutSettings(parsed);
      if (!result.ok) {
        const error = toFinanceCommandError(result);
        reply.code(error.statusCode);
        return error;
      }

      return {
        ...toAffiliatePayoutSettingsResponse(result.settings),
        commandMeta: result.commandMeta,
      };
    },
  );

  app.get<{ Params: FinanceAffiliateParams }>(
    "/finance/affiliates/:affiliateId/payouts",
    async (request, reply) => {
      const affiliateId = request.params.affiliateId;
      if (!enforceFinanceAffiliatePolicy(request, reply, affiliateId)) return reply;
      const query = parsePayoutListQuery(request.query);
      if ("statusCode" in query) {
        reply.code(query.statusCode);
        return query;
      }

      const result = await options.repository.listAffiliatePayouts?.(affiliateId, query);
      if (!result) {
        reply.code(404);
        return {
          code: "affiliate_not_found",
          category: "not_found",
          message: "Affiliate finance resource was not found.",
        };
      }
      return {
        contractVersion: FINANCE_ROUTE_CONTRACT_VERSION,
        affiliateId,
        ...result,
      } satisfies FinanceAffiliatePayoutListResponse;
    },
  );

  app.post<{ Params: FinancePayoutParams; Body: PropertyPayoutDispatchBody }>(
    "/finance/properties/:propertyId/payouts/:payoutId/dispatch",
    async (request, reply) => {
      const { propertyId } = request.params;
      if (!enforceFinancePropertyWritePolicy(request, reply, propertyId)) return reply;
      if (!options.repository.enqueuePropertyPayoutDispatch) {
        reply.code(501);
        return {
          statusCode: 501,
          code: "write_unavailable",
          category: "write_model",
          message: "Finance property payout dispatch writes are not configured.",
        } satisfies FinanceCommandError;
      }

      const parsed = toPropertyPayoutDispatchCommand(request, propertyId, request.params.payoutId);
      if ("statusCode" in parsed) {
        reply.code(parsed.statusCode);
        return parsed;
      }

      const result = await options.repository.enqueuePropertyPayoutDispatch(parsed);
      if (!result.ok) {
        const error = toFinanceCommandError(result);
        reply.code(error.statusCode);
        return error;
      }

      reply.code(202);
      return {
        contractVersion: FINANCE_ROUTE_CONTRACT_VERSION,
        propertyId,
        job: result.job,
        readiness: result.readiness,
        legacyDisposition: result.legacyDisposition,
        rollbackRule: result.rollbackRule,
        commandMeta: result.commandMeta,
      } satisfies FinancePropertyPayoutDispatchResponse;
    },
  );

  app.post<{ Params: FinancePropertyParams; Body: XenditBankValidationBody }>(
    "/finance/properties/:propertyId/provider-accounts/xendit/bank-validation",
    async (request, reply) => {
      const propertyId = request.params.propertyId;
      if (!enforceFinancePropertyWritePolicy(request, reply, propertyId)) return reply;
      if (!options.xenditBankValidator) {
        reply.code(501);
        return {
          statusCode: 501,
          code: "write_unavailable",
          category: "write_model",
          message: "Xendit bank validation is not configured.",
        } satisfies FinanceCommandError;
      }

      const parsed = toXenditBankValidationCommand(request, propertyId);
      if ("statusCode" in parsed) {
        reply.code(parsed.statusCode);
        return parsed;
      }

      let validation: Awaited<ReturnType<FinanceXenditBankValidator["validateBankAccount"]>>;
      try {
        validation = await options.xenditBankValidator.validateBankAccount({
          channelCode: parsed.payload.channelCode,
          accountNumber: parsed.payload.accountNumber,
          accountHolderName: parsed.payload.accountHolderName,
          idempotencyKey: parsed.idempotencyKey,
        });
      } catch (error) {
        reply.code(400);
        return {
          statusCode: 400,
          code: "invalid_command",
          category: "validation",
          message: error instanceof Error ? error.message : "Xendit bank validation failed.",
        } satisfies FinanceCommandError;
      }
      return {
        contractVersion: FINANCE_ROUTE_CONTRACT_VERSION,
        propertyId,
        provider: "xendit",
        validation: {
          status: validation.status,
          maskedAccountNumber: maskAccountNumber(parsed.payload.accountNumber),
          accountHolderName: validation.accountHolderName,
          providerReference: validation.providerReference,
        },
        commandMeta: {
          commandId: parsed.commandId,
          idempotencyKey: parsed.idempotencyKey,
          sideEffects: [...XENDIT_BANK_VALIDATION_SIDE_EFFECTS],
          outboxEvents: [],
          jobs: [],
        },
      } satisfies FinanceXenditBankValidationResponse;
    },
  );

  app.post<{ Params: FinancePropertyParams; Body: XenditPayoutReconciliationBody }>(
    "/finance/properties/:propertyId/reconciliation/xendit-payouts",
    async (request, reply) => {
      const propertyId = request.params.propertyId;
      if (!enforceFinancePropertyWritePolicy(request, reply, propertyId)) return reply;
      if (!options.repository.enqueueXenditPayoutReconciliation) {
        reply.code(501);
        return {
          statusCode: 501,
          code: "write_unavailable",
          category: "write_model",
          message: "Finance payout reconciliation writes are not configured.",
        } satisfies FinanceCommandError;
      }

      const parsed = toXenditPayoutReconciliationCommand(request, propertyId);
      if ("statusCode" in parsed) {
        reply.code(parsed.statusCode);
        return parsed;
      }

      const result = await options.repository.enqueueXenditPayoutReconciliation(parsed);
      if (!result.ok) {
        const error = toFinanceCommandError(result);
        reply.code(error.statusCode);
        return error;
      }

      reply.code(202);
      return {
        contractVersion: FINANCE_ROUTE_CONTRACT_VERSION,
        propertyId,
        job: result.job,
        legacyDisposition: result.legacyDisposition,
        commandMeta: result.commandMeta,
      } satisfies FinanceXenditPayoutReconciliationResponse;
    },
  );

  app.get<{ Params: FinancePropertyParams }>(
    "/finance/properties/:propertyId/reconciliation/payments",
    async (request, reply) => {
      return financeReconciliationView(request, reply, options.repository, "payments");
    },
  );

  app.get<{ Params: FinancePropertyParams }>(
    "/finance/properties/:propertyId/reconciliation/payouts",
    async (request, reply) => {
      return financeReconciliationView(request, reply, options.repository, "payouts");
    },
  );

  app.get<{ Params: FinancePropertyParams }>(
    "/finance/properties/:propertyId/reconciliation/provider-accounts",
    async (request, reply) => {
      return financeReconciliationView(request, reply, options.repository, "provider-accounts");
    },
  );

  app.get<{ Params: FinancePropertyParams }>(
    "/pms/properties/:propertyId/payment-settings",
    async (request, reply) => {
      return pmsPaymentSettingsFacade(request, reply, options.repository);
    },
  );

  app.get<{ Params: BookingWebHotelParams }>(
    "/booking-web/hotels/:slug/payment-settings",
    async (request, reply) => {
      const propertyId = await resolvePublicFinancePropertyId(options, request.params.slug);
      if (!propertyId) {
        reply.code(404);
        return {
          code: "hotel_not_found",
          message: "Booking Web hotel profile not found.",
        };
      }

      const settings =
        (await options.repository.getPaymentSettings(propertyId)) ??
        setupIncompletePaymentSettings(propertyId, new Date().toISOString());
      const policy =
        (await options.repository.getCancellationPolicy(propertyId)) ??
        cancellationPolicyFromRefundPolicy(settings.refundPolicy, settings.updatedAt);
      reply.header("Cache-Control", "public, max-age=60, stale-while-revalidate=300");
      reply.header("X-Vayada-RateLimit-Policy", "public-booking-web-payment-settings");
      reply.header("X-Robots-Tag", "noindex");
      return toPublicPaymentCapabilityProjection(settings, policy);
    },
  );
}

/**
 * Transitional, read-only Finance facade used by PMS Web while the broader
 * Finance target source remains behind its independent cutover flag.
 */
export async function registerPmsFinanceCompatibilityRoutes(
  app: FastifyInstance,
  options: PmsFinanceCompatibilityRoutesOptions,
): Promise<void> {
  app.addHook("onClose", async () => {
    await options.repository.close?.();
  });

  app.get<{ Params: FinancePropertyParams }>(
    "/pms/properties/:propertyId/payment-settings",
    async (request, reply) => {
      return pmsPaymentSettingsFacade(request, reply, options.repository);
    },
  );
}

async function pmsPaymentSettingsFacade(
  request: FastifyRequest<{ Params: FinancePropertyParams }>,
  reply: FastifyReply,
  repository: FinancePropertyReadRepository,
) {
  const propertyId = request.params.propertyId;
  if (!enforceFinancePropertyReadPolicy(request, reply, propertyId)) return reply;

  const settings =
    (await repository.getPaymentSettings(propertyId)) ??
    setupIncompletePaymentSettings(propertyId, new Date().toISOString());
  const policy =
    (await repository.getCancellationPolicy(propertyId)) ??
    cancellationPolicyFromRefundPolicy(settings.refundPolicy, settings.updatedAt);
  return toPmsPaymentSettingsFacade(settings, policy);
}

async function financeReconciliationView(
  request: FastifyRequest<{ Params: FinancePropertyParams }>,
  reply: FastifyReply,
  repository: FinancePropertyReadRepository,
  view: FinanceReconciliationViewKind,
): Promise<FinanceReconciliationViewResponse | FinanceValidationError | FastifyReply> {
  const propertyId = request.params.propertyId;
  if (!enforceFinancePropertyReadPolicy(request, reply, propertyId)) return reply;
  const query = parseReconciliationViewQuery(request.query);
  if ("statusCode" in query) {
    reply.code(query.statusCode);
    return query;
  }

  const result =
    (await repository.listReconciliationItems?.(propertyId, view, query)) ??
    emptyReconciliationView(query);
  return {
    contractVersion: FINANCE_ROUTE_CONTRACT_VERSION,
    propertyId,
    ...result,
  };
}

async function resolvePublicFinancePropertyId(
  options: FinanceRoutesOptions,
  slug: string,
): Promise<string | null> {
  const resolvedPropertyId = await options.publicHotelPropertyResolver?.findPropertyIdBySlug(slug);
  if (resolvedPropertyId) return resolvedPropertyId;

  const profile = await options.publicHotelProfileRepository?.findProfileBySlug(slug);
  return profile?.hotel.propertyId ?? null;
}

export function createTargetFinancePublicHotelPropertyResolver(config: {
  connectionString: string;
  max?: number;
  pool?: FinancePropertySettingsReadPool;
}): FinancePublicHotelPropertyResolver {
  const pool: FinancePropertySettingsReadPool =
    config.pool ??
    new pg.Pool({
      connectionString: config.connectionString,
      max: config.max ?? 5,
    });

  return {
    async findPropertyIdBySlug(slug) {
      const result = await pool.query<FinancePublicHotelPropertyRow>(
        `SELECT profile.property_id::text AS "propertyId"
         FROM distribution.public_hotel_bookability_profiles profile
         LEFT JOIN hotel_catalog.property_slugs slug_alias
           ON slug_alias.property_id = profile.property_id
          AND slug_alias.slug = lower($1)
          AND slug_alias.purpose = 'redirect'
          AND slug_alias.status = 'redirected'
         WHERE profile.canonical_slug = lower($1)
            OR slug_alias.property_id IS NOT NULL
         ORDER BY CASE WHEN profile.canonical_slug = lower($1) THEN 0 ELSE 1 END
         LIMIT 1`,
        [slug],
      );
      return result.rows[0]?.propertyId ?? null;
    },
    async close() {
      await pool.end();
    },
  };
}

export function createXenditBankValidator(config: {
  secretKey: string;
  endpoint?: string;
  timeoutMs?: number;
  fetch?: FinanceXenditBankValidatorFetch;
}): FinanceXenditBankValidator {
  const endpoint = config.endpoint ?? "https://api.xendit.co/bank_account_data/inquiries";
  const fetchImpl = config.fetch ?? globalThis.fetch;
  return {
    async validateBankAccount(input) {
      if (!config.secretKey.trim()) {
        throw new Error("XENDIT_SECRET_KEY is required for bank validation.");
      }
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), config.timeoutMs ?? 15_000);
      try {
        const response = await fetchImpl(endpoint, {
          method: "POST",
          headers: {
            Authorization: `Basic ${Buffer.from(`${config.secretKey}:`).toString("base64")}`,
            "Content-Type": "application/json",
            "Idempotency-Key": input.idempotencyKey,
          },
          body: JSON.stringify({
            bank_code: input.channelCode.replace(/^ID_/, ""),
            account_number: input.accountNumber,
          }),
          signal: controller.signal,
        });
        const responseText = await response.text();
        if (!response.ok) {
          throw new Error(`Xendit bank validation failed with status ${response.status}.`);
        }
        const data = parseJsonObject(responseText);
        return {
          status: xenditValidationStatus(optionalString(data, "status")),
          accountHolderName:
            optionalString(data, "account_holder") ?? optionalString(data, "accountHolder") ?? null,
          providerReference:
            optionalString(data, "id") ?? optionalString(data, "reference_id") ?? null,
        };
      } finally {
        clearTimeout(timeout);
      }
    },
  };
}

export function createTargetFinancePropertySettingsRepository(config: {
  connectionString: string;
  max?: number;
  pool?: FinancePropertySettingsReadPool;
  stripeConnectProvider?: FinanceStripeConnectProvider;
}): FinancePropertyReadRepository {
  const pool: FinancePropertySettingsReadPool =
    config.pool ??
    new pg.Pool({
      connectionString: config.connectionString,
      max: config.max ?? 5,
    });

  const platformAffiliatePayoutReads = createFinancePlatformAffiliatePayoutReadRepository({
    query: pool.query.bind(pool),
    connect: async () => {
      if (!pool.connect) throw new Error("Finance read transactions are unavailable.");
      const client = await pool.connect();
      if (!client.release) throw new Error("Finance read client cannot release transactions.");
      return {
        query: client.query.bind(client),
        release: client.release.bind(client),
      };
    },
  });
  const platformAffiliatePayoutWrites = createFinancePlatformAffiliatePayoutMarkPaidRepository({
    connect: pool.connect
      ? async () => {
          const client = await pool.connect!();
          if (!client.release) throw new Error("Finance write client cannot release transactions.");
          return {
            query: client.query.bind(client),
            release: client.release.bind(client),
          };
        }
      : undefined,
  });
  const onlineCardEvidenceRepository = pool.connect
    ? createFinanceOnlineCardExecutionEvidenceRepository({
        async connect() {
          const client = await pool.connect!();
          if (!client.release) throw new Error("Finance write client cannot release transactions.");
          return {
            query: client.query.bind(client),
            release: client.release.bind(client),
          };
        },
      })
    : null;
  // Acceptance remains unreachable in deployed API wiring until the sanctioned
  // ONB-25A runner and approval-attestation contract can be verified here.
  const onlineCardEvidenceWrites = onlineCardEvidenceRepository
    ? {
        revokeOnlineCardExecutionEvidence:
          onlineCardEvidenceRepository.revokeOnlineCardExecutionEvidence,
      }
    : {};

  return {
    ...platformAffiliatePayoutReads,
    ...platformAffiliatePayoutWrites,
    ...onlineCardEvidenceWrites,
    async getPaymentSettings(propertyId) {
      const row = await loadPaymentSettingsRow(pool, propertyId);
      return row ? toFinancePaymentSettingsReadModel(row) : null;
    },
    async getCancellationPolicy(propertyId) {
      const row = await loadPaymentSettingsRow(pool, propertyId);
      return row
        ? cancellationPolicyFromRefundPolicy(
            jsonPolicy(row.refundPolicy),
            utcDateTime(row.updatedAt, new Date().toISOString()),
          )
        : null;
    },
    async updatePaymentSettings(command) {
      const client = await checkoutFinanceWriteClient(pool);
      const ownsTransaction = typeof client.release === "function";
      if (!ownsTransaction) return paymentSettingsWriteUnavailable();
      try {
        await client.query("BEGIN");
        const result = await updatePaymentSettingsInClient(client, command);
        await client.query("COMMIT");
        return result;
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release?.();
      }
    },
    async listPayouts(propertyId, query) {
      const result = await loadPayoutRows(pool, propertyId, query);
      return toPayoutListResponseBody(result, query);
    },
    async getAffiliatePayoutSettings(affiliateId) {
      const resource = await resolveAffiliateResource(pool, affiliateId);
      if (!resource) return null;
      const row = await loadAffiliatePayoutSettingsRow(pool, affiliateId, resource.organizationId);
      if (row) return toAffiliatePayoutSettingsReadModel(row);
      return resource
        ? setupIncompleteAffiliatePayoutSettings(
            affiliateId,
            new Date().toISOString(),
            resource.organizationId,
          )
        : null;
    },
    async listAffiliatePayouts(affiliateId, query) {
      const resource = await resolveAffiliateResource(pool, affiliateId);
      if (!resource) return null;
      const result = await loadAffiliatePayoutRows(
        pool,
        affiliateId,
        resource.organizationId,
        query,
      );
      return toAffiliatePayoutListResponseBody(result, query);
    },
    async listReconciliationItems(propertyId, view, query) {
      const result = await loadReconciliationRows(pool, propertyId, view, query);
      return toReconciliationViewResponseBody(result, query);
    },
    async createStripeProviderAccount(command) {
      if (!config.stripeConnectProvider) {
        return {
          ok: false,
          statusCode: 502,
          code: "provider_unavailable",
          message: "Stripe Connect onboarding is not configured.",
        };
      }
      const client = await checkoutFinanceWriteClient(pool);
      const ownsTransaction = typeof client.release === "function";
      try {
        return await createStripeProviderAccountInClient(
          client,
          command,
          config.stripeConnectProvider,
          ownsTransaction,
        );
      } catch (error) {
        throw error;
      } finally {
        if (ownsTransaction) client.release?.();
      }
    },
    async issueStripeOnboardingLink(command) {
      if (!config.stripeConnectProvider) {
        return {
          ok: false,
          statusCode: 502,
          code: "provider_unavailable",
          message: "Stripe Connect onboarding is not configured.",
        };
      }
      const client = await checkoutFinanceWriteClient(pool);
      const ownsTransaction = typeof client.release === "function";
      try {
        return await issueStripeOnboardingLinkInClient(
          client,
          command,
          config.stripeConnectProvider,
          ownsTransaction,
        );
      } catch (error) {
        throw error;
      } finally {
        if (ownsTransaction) client.release?.();
      }
    },
    async reconcileStripeProviderAccount(command) {
      if (!config.stripeConnectProvider) {
        return {
          ok: false,
          statusCode: 502,
          code: "provider_unavailable",
          message: "Stripe account status is unavailable.",
        };
      }
      return reconcileStripeProviderAccount(pool, command, config.stripeConnectProvider);
    },
    async issueStripeDashboardLoginLink(propertyId) {
      if (!config.stripeConnectProvider) {
        return {
          ok: false,
          statusCode: 502,
          code: "provider_unavailable",
          message: "Stripe Dashboard is unavailable.",
        };
      }
      return issueStripeDashboardLoginLink(pool, propertyId, config.stripeConnectProvider);
    },
    async enqueueXenditPayoutReconciliation(command) {
      const client = await checkoutFinanceWriteClient(pool);
      const ownsTransaction = typeof client.release === "function";
      try {
        if (ownsTransaction) await client.query("BEGIN");
        const result = await enqueueXenditPayoutReconciliationInClient(client, command);
        if (ownsTransaction) await client.query("COMMIT");
        return result;
      } catch (error) {
        if (ownsTransaction) await client.query("ROLLBACK");
        throw error;
      } finally {
        if (ownsTransaction) client.release?.();
      }
    },
    async enqueuePropertyPayoutDispatch(command) {
      const client = await checkoutFinanceWriteClient(pool);
      const ownsTransaction = typeof client.release === "function";
      try {
        if (ownsTransaction) await client.query("BEGIN");
        const result = await enqueuePropertyPayoutDispatchInClient(client, command);
        if (ownsTransaction) await client.query("COMMIT");
        return result;
      } catch (error) {
        if (ownsTransaction) await client.query("ROLLBACK");
        throw error;
      } finally {
        if (ownsTransaction) client.release?.();
      }
    },
    async updateAffiliatePayoutSettings(command) {
      const client = await checkoutFinanceWriteClient(pool);
      const ownsTransaction = typeof client.release === "function";
      try {
        if (ownsTransaction) await client.query("BEGIN");
        const result = await updateAffiliatePayoutSettingsInClient(client, command);
        if (ownsTransaction) await client.query("COMMIT");
        return result;
      } catch (error) {
        if (ownsTransaction) await client.query("ROLLBACK");
        throw error;
      } finally {
        if (ownsTransaction) client.release?.();
      }
    },
    async close() {
      await pool.end();
    },
  };
}

async function checkoutFinanceWriteClient(
  pool: FinancePropertySettingsReadPool,
): Promise<FinancePropertySettingsWriteClient> {
  if (pool.connect) return pool.connect();
  return {
    async query<T extends QueryResultRow = QueryResultRow>(
      text: string,
      values?: readonly unknown[],
    ) {
      const result = await pool.query<T>(text, values);
      return { ...result, rowCount: result.rows.length };
    },
  };
}

async function inFinanceWriteTransaction<T>(
  client: FinancePropertySettingsWriteClient,
  transactional: boolean,
  work: () => Promise<T>,
): Promise<T> {
  if (!transactional) return work();
  await client.query("BEGIN");
  try {
    const result = await work();
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
}

async function updatePaymentSettingsInClient(
  client: FinancePropertySettingsWriteClient,
  command: FinancePaymentSettingsPatchCommand,
): Promise<FinancePaymentSettingsPatchResult> {
  await lockFinanceOnlineCardReadinessProperty(client, command.propertyId);
  const previousOnlineCardReadiness = await loadFinanceOnlineCardReadinessState(
    client,
    command.propertyId,
  );
  const currencyResult = await client.query<{ currency: string | null }>(
    `SELECT COALESCE(settings.default_currency, 'EUR') AS currency
       FROM hotel_catalog.properties property
       LEFT JOIN booking.booking_settings settings ON settings.property_id = property.id
      WHERE property.id = $1::uuid
      LIMIT 1`,
    [command.propertyId],
  );
  const canonicalCurrency = currencyCode(currencyResult.rows[0]?.currency);
  if (!currencyResult.rows[0]) {
    return {
      ok: false,
      statusCode: 404,
      code: "property_not_found",
      message: "The property currency could not be resolved.",
    };
  }
  if (
    (command.payload.defaultCurrency && command.payload.defaultCurrency !== canonicalCurrency) ||
    (command.payload.supportedCurrencies &&
      (command.payload.supportedCurrencies.length !== 1 ||
        command.payload.supportedCurrencies[0] !== canonicalCurrency))
  ) {
    return {
      ok: false,
      statusCode: 409,
      code: "property_currency_conflict",
      message: `Payment currency changed to ${canonicalCurrency}. Reload before saving.`,
    };
  }
  const existing = await loadPaymentSettingsRow(client, command.propertyId);
  const current = existing
    ? toFinancePaymentSettingsReadModel(existing)
    : setupIncompletePaymentSettings(command.propertyId, new Date().toISOString());
  const next = mergePaymentSettings(current, {
    ...command.payload,
    defaultCurrency: canonicalCurrency,
    supportedCurrencies: [canonicalCurrency],
  });
  const completenessError = paymentSettingsCompletenessError(next);
  if (completenessError) {
    return {
      ok: false,
      statusCode: 400,
      code: "invalid_command",
      message: completenessError,
    };
  }
  const keyHash = sha256(command.idempotencyKey);
  const fingerprint = sha256(
    stableJson({
      propertyId: command.propertyId,
      canonicalCurrency,
      payload: command.payload,
    }),
  );
  const commandMeta = buildPaymentSettingsCommandMeta(command);
  let readinessLost = false;

  const idempotency = await client.query<{
    inserted: boolean;
    requestFingerprintHash: string;
  }>(
    `INSERT INTO platform.idempotency_keys (
       operation_scope,
       operation,
       key_hash,
       request_fingerprint_hash,
       status,
       tenant_scope,
       property_id,
       response_status_code,
       response_body_hash,
       response_resource_product,
       response_resource_type,
       response_resource_id,
       correlation_id,
       expires_at,
       completed_at,
       idempotency_metadata
     )
     VALUES (
       'finance',
       'payment_settings_update',
       $1,
       $2,
       'completed',
       'property',
       $3::uuid,
       200,
       $4,
       'finance',
       'payment_settings',
       $3,
       $5,
       now() + interval '24 hours',
       now(),
       $6::jsonb
     )
     ON CONFLICT (operation_scope, operation, key_hash, scope_key)
     DO UPDATE SET last_seen_at = now()
     RETURNING (xmax = 0) AS inserted,
               request_fingerprint_hash AS "requestFingerprintHash"`,
    [
      keyHash,
      fingerprint,
      command.propertyId,
      sha256(stableJson(commandMeta)),
      command.audit.correlationId ?? command.audit.requestId,
      JSON.stringify({ commandMeta, commandId: command.commandId }),
    ],
  );

  const idempotencyRow = idempotency.rows[0];
  if (idempotencyRow && idempotencyRow.requestFingerprintHash !== fingerprint) {
    return {
      ok: false,
      statusCode: 409,
      code: "idempotency_conflict",
      message: "Idempotency key was already used with a different payment-settings payload.",
    };
  }

  if (idempotencyRow?.inserted) {
    await upsertPaymentSettings(client, command, next);
    readinessLost = await applyFinanceOnlineCardReadinessLoss(client, {
      propertyId: command.propertyId,
      previous: previousOnlineCardReadiness,
      context: onlineCardReadinessChangeContext(command.audit, command.commandId),
    });
    await recordPaymentSettingsAuditEvent(client, command, keyHash);
  }

  const stored = await loadPaymentSettingsRow(client, command.propertyId);
  const settings = stored ? toFinancePaymentSettingsReadModel(stored) : null;
  if (!settings) {
    return {
      ok: false,
      statusCode: 404,
      code: "property_not_found",
      message: "Finance property payment settings were not found.",
    };
  }

  return {
    ok: true,
    status: idempotencyRow?.inserted ? "updated" : "idempotent_replay",
    settings,
    commandMeta: readinessLost
      ? { ...commandMeta, outboxEvents: ["finance.online_card_readiness.changed"] }
      : commandMeta,
  };
}

function mergePaymentSettings(
  current: FinancePaymentSettingsReadModel,
  payload: FinancePaymentSettingsPatchPayload,
): FinancePaymentSettingsReadModel {
  const defaultCurrency =
    payload.defaultCurrency ?? payload.supportedCurrencies?.[0] ?? current.defaultCurrency;
  return {
    ...current,
    ...payload,
    defaultCurrency,
    supportedCurrencies: [defaultCurrency],
    depositPolicy: payload.depositPolicy
      ? { ...current.depositPolicy, ...payload.depositPolicy }
      : current.depositPolicy,
    updatedAt: new Date().toISOString(),
  };
}

function paymentSettingsCompletenessError(
  settings: FinancePaymentSettingsReadModel,
): string | null {
  if (!settings.paymentsEnabled || settings.acceptedMethods.length === 0) {
    return "Choose at least one payment method.";
  }
  if (
    settings.acceptedMethods.includes("pay_at_property") &&
    !settings.acceptedMethods.some((method) => method === "cash" || method === "manual_card")
  ) {
    return "Pay at Hotel requires cash, card, or both.";
  }
  if (settings.acceptedMethods.includes("bank_transfer")) {
    const requiredFields = [
      ["bankName", "bank name"],
      ["accountHolder", "account holder"],
      ["accountNumber", "account number or IBAN"],
      ["bankTransferInstructions", "bank transfer instructions"],
    ] as const;
    for (const [field, label] of requiredFields) {
      if (!policyText(settings.depositPolicy[field])) {
        return `Bank Transfer requires ${label}.`;
      }
    }
  }
  if (
    settings.acceptedMethods.includes("paypal") &&
    !validPaymentEmail(settings.depositPolicy["paypalEmail"])
  ) {
    return "PayPal requires a valid email address.";
  }
  return null;
}

function policyText(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function validPaymentEmail(value: unknown): boolean {
  return typeof value === "string" && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim());
}

async function upsertPaymentSettings(
  client: FinancePropertySettingsWriteClient,
  command: FinancePaymentSettingsPatchCommand,
  settings: FinancePaymentSettingsReadModel,
): Promise<void> {
  const hasProviderChoice = command.payload.paymentProvider !== undefined;
  const providerAccountId = hasProviderChoice
    ? await resolvePaymentSettingsProviderAccountId(client, command, settings.defaultCurrency)
    : null;
  await client.query(
    `INSERT INTO finance.payment_settings (
       property_id,
       provider_account_id,
       payments_enabled,
       accepted_methods,
       default_currency,
       deposit_policy,
       refund_policy,
       tax_policy,
       statement_descriptor,
       requires_manual_review,
       source_system,
       updated_at
     )
     VALUES (
       $1::uuid,
       $10::uuid,
       $2,
       $3::text[],
       $4,
       $5::jsonb,
       $6::jsonb,
       $7::jsonb,
       $8,
       $9,
       'finance',
       now()
     )
     ON CONFLICT (property_id) DO UPDATE SET
       provider_account_id = CASE
         WHEN $11::boolean THEN $10::uuid
         ELSE finance.payment_settings.provider_account_id
       END,
       payments_enabled = EXCLUDED.payments_enabled,
       accepted_methods = EXCLUDED.accepted_methods,
       default_currency = EXCLUDED.default_currency,
       deposit_policy = EXCLUDED.deposit_policy,
       refund_policy = EXCLUDED.refund_policy,
       tax_policy = EXCLUDED.tax_policy,
       statement_descriptor = EXCLUDED.statement_descriptor,
       requires_manual_review = EXCLUDED.requires_manual_review,
       source_system = 'finance',
       updated_at = now()`,
    [
      command.propertyId,
      settings.paymentsEnabled,
      settings.acceptedMethods,
      settings.defaultCurrency,
      JSON.stringify(settings.depositPolicy),
      JSON.stringify(settings.refundPolicy),
      JSON.stringify(settings.taxPolicy),
      settings.statementDescriptor,
      settings.requiresManualReview,
      providerAccountId,
      hasProviderChoice,
    ],
  );
}

async function resolvePaymentSettingsProviderAccountId(
  client: FinancePropertySettingsWriteClient,
  command: FinancePaymentSettingsPatchCommand,
  defaultCurrency: string,
): Promise<string | null> {
  const provider = command.payload.paymentProvider;
  if (!provider) return null;

  const existing = await client.query<{ providerAccountId: string }>(
    `SELECT id::text AS "providerAccountId"
     FROM finance.payment_provider_accounts
     WHERE property_id = $1::uuid
       AND account_scope = 'property'
       AND provider = $2
     ORDER BY
       CASE
         WHEN provider_account_id LIKE 'settings-choice:%' THEN 1
         ELSE 0
       END,
       updated_at DESC
     LIMIT 1`,
    [command.propertyId, provider],
  );
  if (existing.rows[0]) return existing.rows[0].providerAccountId;

  const placeholder = paymentSettingsProviderPlaceholder(provider);
  const result = await client.query<{ providerAccountId: string }>(
    `INSERT INTO finance.payment_provider_accounts (
       property_id,
       account_scope,
       provider,
       provider_account_id,
       status,
       onboarding_status,
       charges_enabled,
       payouts_enabled,
       default_currency,
       capabilities,
       account_metadata,
       created_at,
       updated_at
     )
     VALUES (
       $1::uuid,
       'property',
       $2,
       $3,
       $4,
       $5,
       $6,
       false,
       $7,
       $8::text[],
       $9::jsonb,
       now(),
       now()
     )
     ON CONFLICT (provider, provider_account_id) WHERE provider_account_id IS NOT NULL
     DO UPDATE SET
       property_id = EXCLUDED.property_id,
       account_scope = 'property',
       status = EXCLUDED.status,
       onboarding_status = EXCLUDED.onboarding_status,
       charges_enabled = EXCLUDED.charges_enabled,
       default_currency = EXCLUDED.default_currency,
       capabilities = EXCLUDED.capabilities,
       account_metadata = finance.payment_provider_accounts.account_metadata || EXCLUDED.account_metadata,
       updated_at = now()
     RETURNING id::text AS "providerAccountId"`,
    [
      command.propertyId,
      provider,
      `settings-choice:${command.propertyId}:${provider}`,
      placeholder.status,
      placeholder.onboardingStatus,
      placeholder.chargesEnabled,
      defaultCurrency,
      placeholder.capabilities,
      JSON.stringify({
        source: "payment_settings_choice",
        commandId: command.commandId,
      }),
    ],
  );
  return result.rows[0]?.providerAccountId ?? null;
}

function paymentSettingsProviderPlaceholder(
  provider: FinancePaymentSettingsPatchPayload["paymentProvider"],
): {
  status: string;
  onboardingStatus: string;
  chargesEnabled: boolean;
  capabilities: string[];
} {
  if (provider === "vayada" || provider === "manual" || provider === "bank_transfer") {
    return {
      status: "active",
      onboardingStatus: "completed",
      chargesEnabled: provider === "vayada",
      capabilities: provider === "vayada" ? ["card_payments"] : [],
    };
  }
  return {
    status: "setup_incomplete",
    onboardingStatus: "not_started",
    chargesEnabled: false,
    capabilities: [],
  };
}

async function recordPaymentSettingsAuditEvent(
  client: FinancePropertySettingsWriteClient,
  command: FinancePaymentSettingsPatchCommand,
  keyHash: string,
): Promise<void> {
  await client.query(
    `INSERT INTO platform.product_audit_events (
       audit_key,
       product,
       action,
       action_version,
       occurred_at,
       tenant_scope,
       organization_id,
       property_id,
       actor_type,
       actor_user_id,
       target_resource_product,
       target_resource_type,
       target_resource_id,
       correlation_id,
       causation_id,
       redacted_payload,
       private_payload,
       audit_metadata,
       retention_class,
       privacy_scope
     )
     VALUES (
       $1,
       'finance',
       'finance.payment_settings.updated',
       1,
       $2::timestamptz,
       'property',
       NULL,
       $3::uuid,
       $4,
       $5::uuid,
       'finance',
       'payment_settings',
       $3,
       $6,
       $7,
       $8::jsonb,
       '{}'::jsonb,
       $9::jsonb,
       'financial',
       'confidential'
     )
     ON CONFLICT (product, audit_key) DO NOTHING`,
    [
      `finance.payment-settings.audit.property.${command.propertyId}.key.${keyHash}.v1`,
      command.audit.requestedAt,
      command.propertyId,
      command.audit.actor.kind,
      command.audit.actor.kind === "user" ? command.audit.actor.userId : null,
      command.audit.correlationId ?? command.audit.requestId,
      command.commandId,
      JSON.stringify({
        propertyId: command.propertyId,
        changedFields: Object.keys(command.payload).sort(),
        paymentProvider: command.payload.paymentProvider ?? null,
        acceptedMethods: command.payload.acceptedMethods ?? null,
        paymentsEnabled: command.payload.paymentsEnabled ?? null,
      }),
      JSON.stringify({
        contractVersion: FINANCE_ROUTE_CONTRACT_VERSION,
        idempotencyKeyHash: keyHash,
        requestId: command.audit.requestId,
      }),
    ],
  );
}

function buildPaymentSettingsCommandMeta(
  command: FinancePaymentSettingsPatchCommand,
): FinanceCommandMeta {
  return {
    commandId: command.commandId,
    idempotencyKey: command.idempotencyKey,
    sideEffects: PAYMENT_SETTINGS_SIDE_EFFECTS,
    outboxEvents: [],
    jobs: [],
  };
}

async function createStripeProviderAccountInClient(
  client: FinancePropertySettingsWriteClient,
  command: CreateStripeProviderAccountCommand,
  provider: FinanceStripeConnectProvider,
  transactional: boolean,
): Promise<FinanceProviderAccountCommandResult> {
  if (!transactional) {
    return {
      ok: false,
      statusCode: 500,
      code: "write_unavailable",
      message: "Stripe provider-account creation requires a transactional database client.",
    };
  }
  if (!provider.compensateAccountCreation) {
    return {
      ok: false,
      statusCode: 502,
      code: "provider_unavailable",
      message: "Stripe provider-account creation requires compensation support.",
    };
  }
  const owner = financeProviderAccountOwner(command);
  const keyHash = sha256(command.idempotencyKey);
  const fingerprint = sha256(stableJson({ owner, payload: command.payload }));
  const existingIdempotency = await loadProviderAccountIdempotency(
    client,
    command,
    "stripe_provider_account_create",
    keyHash,
  );
  const replay = replayProviderAccountCommand(existingIdempotency, fingerprint);
  if (replay) return replay;

  const existingAccount = await loadStripeProviderAccountByOwner(client, owner);
  if (existingAccount) {
    return inFinanceWriteTransaction(client, transactional, async () => {
      let previousOnlineCardReadiness: FinanceOnlineCardReadinessState | null = null;
      if (owner.ownerScope === "property") {
        await lockFinanceOnlineCardReadinessProperty(client, owner.propertyId);
        previousOnlineCardReadiness = await loadFinanceOnlineCardReadinessState(
          client,
          owner.propertyId,
        );
      }
      const lockedAccount = await loadStripeProviderAccountById(
        client,
        existingAccount.providerAccountId,
        owner,
        true,
      );
      if (!lockedAccount) {
        return {
          ok: false,
          statusCode: 404,
          code: "provider_account_not_found",
          message: "Finance provider account was not found.",
        };
      }
      const idempotencyError = await reserveProviderAccountIdempotency(
        client,
        command,
        "stripe_provider_account_create",
        keyHash,
        fingerprint,
      );
      if (idempotencyError) return idempotencyError;
      const onboardingUrl = await provider.createOnboardingLink({
        owner,
        providerAccountRef: lockedAccount.providerAccountRef,
        idempotencyKey: stripeProviderIdempotencyKey(owner, keyHash, "onboarding-link"),
        returnSurface: command.payload.returnSurface,
      });
      await updateStripeProviderAccountOnboardingUrl(client, lockedAccount, owner, onboardingUrl);
      let readinessLost = false;
      if (owner.ownerScope === "property") {
        await relinkPaymentSettingsProviderAccount(
          client,
          owner.propertyId,
          "stripe",
          lockedAccount.providerAccountId,
        );
        readinessLost = await applyFinanceOnlineCardReadinessLoss(client, {
          propertyId: owner.propertyId,
          previous: previousOnlineCardReadiness,
          context: onlineCardReadinessChangeContext(command.audit, command.commandId),
        });
      }
      const response = providerAccountCommandResponse(
        { ...lockedAccount, onboardingStatus: "invited" },
        onboardingUrl,
        buildProviderAccountCommandMeta(command, keyHash, readinessLost),
      );
      await completeProviderAccountIdempotency(
        client,
        command,
        "stripe_provider_account_create",
        keyHash,
        fingerprint,
        response,
      );
      return { ok: true, status: "existing_owner_account", response };
    });
  }

  const idempotencyError = await reserveProviderAccountIdempotency(
    client,
    command,
    "stripe_provider_account_create",
    keyHash,
    fingerprint,
  );
  if (idempotencyError) return idempotencyError;

  const providerAccount = await provider.createAccount({
    owner,
    email: command.payload.email,
    country: command.payload.country,
    idempotencyKey: stripeProviderIdempotencyKey(owner, keyHash, "account"),
    returnSurface: command.payload.returnSurface,
  });

  let writeOutcome:
    | { kind: "created"; response: FinanceProviderAccountCommandResponse }
    | { kind: "existing"; account: FinanceProviderAccountRow }
    | { kind: "same_provider_account"; account: FinanceProviderAccountRow };
  try {
    writeOutcome = await inFinanceWriteTransaction(client, transactional, async () => {
      if (owner.ownerScope === "property") {
        await lockFinanceOnlineCardReadinessProperty(client, owner.propertyId);
        const winner = await loadStripeProviderAccountByOwner(client, owner);
        if (winner) return { kind: "existing" as const, account: winner };
      }

      const storedAccount = await insertStripeProviderAccount(client, command, providerAccount);
      if (!storedAccount.inserted) {
        return { kind: "same_provider_account" as const, account: storedAccount.account };
      }
      const insertedAccount = storedAccount.account;
      if (owner.ownerScope === "property") {
        await relinkPaymentSettingsProviderAccount(
          client,
          owner.propertyId,
          "stripe",
          insertedAccount.providerAccountId,
        );
      }
      const response = providerAccountCommandResponse(
        insertedAccount,
        providerAccount.onboardingUrl,
        buildProviderAccountCommandMeta(command, keyHash),
      );
      await completeProviderAccountIdempotency(
        client,
        command,
        "stripe_provider_account_create",
        keyHash,
        fingerprint,
        response,
      );
      return { kind: "created" as const, response };
    });
  } catch (error) {
    const durableAccount = await loadStripeProviderAccountByRef(
      client,
      providerAccount.providerAccountRef,
    );
    if (durableAccount) {
      if (!stripeProviderAccountOwnerMatches(durableAccount, owner)) {
        await markProviderAccountIdempotencyFailed(
          client,
          command,
          "stripe_provider_account_create",
          keyHash,
          {
            compensationStatus: "not_attempted",
            errorCode: "provider_account_owner_conflict",
          },
        );
        return {
          ok: false,
          statusCode: 502,
          code: "provider_rejected",
          message: "Stripe returned an account reference already assigned to another owner.",
        };
      }
      const committedIdempotency = await loadProviderAccountIdempotency(
        client,
        command,
        "stripe_provider_account_create",
        keyHash,
      );
      const committedReplay = replayProviderAccountCommand(committedIdempotency, fingerprint);
      if (committedReplay) return committedReplay;
      return {
        ok: false,
        statusCode: 500,
        code: "write_unavailable",
        message: "The Stripe account is durable, but command completion could not be confirmed.",
      };
    }
    if (error instanceof StripeProviderAccountOwnerConflictError) {
      await markProviderAccountIdempotencyFailed(
        client,
        command,
        "stripe_provider_account_create",
        keyHash,
        {
          compensationStatus: "not_attempted",
          errorCode: "provider_account_owner_conflict",
        },
      );
      return {
        ok: false,
        statusCode: 502,
        code: "provider_rejected",
        message: "Stripe returned an account reference already assigned to another owner.",
      };
    }
    let compensationJobKey: string | null = null;
    let compensationOutcome:
      | { kind: "compensated" }
      | { kind: "durably_owned"; account: StripeProviderAccountOwnershipRow }
      | null = null;
    try {
      compensationOutcome = await compensateStripeProviderAccountIfUnowned(
        client,
        provider as FinanceStripeConnectProvider & {
          compensateAccountCreation: NonNullable<
            FinanceStripeConnectProvider["compensateAccountCreation"]
          >;
        },
        {
          owner,
          providerAccountRef: providerAccount.providerAccountRef,
          reason: "db_write_failed",
          idempotencyKey: stripeProviderIdempotencyKey(owner, keyHash, "compensate"),
        },
      );
    } catch {
      compensationJobKey = await enqueueStripeAccountCompensation(
        client,
        command,
        owner,
        keyHash,
        providerAccount.providerAccountRef,
      );
    }
    if (compensationOutcome?.kind === "durably_owned") {
      if (!stripeProviderAccountOwnerMatches(compensationOutcome.account, owner)) {
        await markProviderAccountIdempotencyFailed(
          client,
          command,
          "stripe_provider_account_create",
          keyHash,
          {
            compensationStatus: "not_attempted",
            errorCode: "provider_account_owner_conflict",
          },
        );
        return {
          ok: false,
          statusCode: 502,
          code: "provider_rejected",
          message: "Stripe returned an account reference already assigned to another owner.",
        };
      }
      const committedIdempotency = await loadProviderAccountIdempotency(
        client,
        command,
        "stripe_provider_account_create",
        keyHash,
      );
      const committedReplay = replayProviderAccountCommand(committedIdempotency, fingerprint);
      if (committedReplay) return committedReplay;
      return {
        ok: false,
        statusCode: 500,
        code: "write_unavailable",
        message: "The Stripe account is durable, but command completion could not be confirmed.",
      };
    }
    await markProviderAccountIdempotencyFailed(
      client,
      command,
      "stripe_provider_account_create",
      keyHash,
      {
        compensationStatus: compensationJobKey ? "queued" : "completed",
        compensationJobKey,
        errorCode: "provider_account_write_failed",
      },
    );
    return {
      ok: false,
      statusCode: 500,
      code: "write_unavailable",
      message:
        "Finance provider-account write failed after Stripe account creation; compensation was attempted.",
    };
  }

  if (writeOutcome.kind === "created") {
    return { ok: true, status: "created", response: writeOutcome.response };
  }

  if (writeOutcome.kind === "same_provider_account") {
    const response = providerAccountCommandResponse(
      writeOutcome.account,
      providerAccount.onboardingUrl,
      buildProviderAccountCommandMeta(command, keyHash),
    );
    await completeProviderAccountIdempotency(
      client,
      command,
      "stripe_provider_account_create",
      keyHash,
      fingerprint,
      response,
    );
    return { ok: true, status: "existing_owner_account", response };
  }

  let loserCompensation:
    { kind: "compensated" } | { kind: "durably_owned"; account: StripeProviderAccountOwnershipRow };
  try {
    loserCompensation = await compensateStripeProviderAccountIfUnowned(
      client,
      provider as FinanceStripeConnectProvider & {
        compensateAccountCreation: NonNullable<
          FinanceStripeConnectProvider["compensateAccountCreation"]
        >;
      },
      {
        owner,
        providerAccountRef: providerAccount.providerAccountRef,
        reason: "db_write_failed",
        idempotencyKey: stripeProviderIdempotencyKey(owner, keyHash, "compensate"),
      },
    );
  } catch {
    const compensationJobKey = await enqueueStripeAccountCompensation(
      client,
      command,
      owner,
      keyHash,
      providerAccount.providerAccountRef,
    );
    await markProviderAccountIdempotencyFailed(
      client,
      command,
      "stripe_provider_account_create",
      keyHash,
      {
        compensationStatus: "queued",
        compensationJobKey,
        errorCode: "concurrent_provider_account_compensation_failed",
      },
    );
    return {
      ok: false,
      statusCode: 500,
      code: "write_unavailable",
      message: "A concurrent Stripe account won, but compensation of the duplicate failed.",
    };
  }

  if (loserCompensation.kind === "durably_owned") {
    const durableAccount = loserCompensation.account;
    if (!stripeProviderAccountOwnerMatches(durableAccount, owner)) {
      await markProviderAccountIdempotencyFailed(
        client,
        command,
        "stripe_provider_account_create",
        keyHash,
        {
          compensationStatus: "not_attempted",
          errorCode: "provider_account_owner_conflict",
        },
      );
      return {
        ok: false,
        statusCode: 502,
        code: "provider_rejected",
        message: "Stripe returned an account reference already assigned to another owner.",
      };
    }
    if (durableAccount.providerAccountId !== writeOutcome.account.providerAccountId) {
      await markProviderAccountIdempotencyFailed(
        client,
        command,
        "stripe_provider_account_create",
        keyHash,
        {
          compensationStatus: "not_attempted",
          errorCode: "concurrent_owner_provider_account_conflict",
        },
      );
      return {
        ok: false,
        statusCode: 500,
        code: "write_unavailable",
        message: "Concurrent Stripe account ownership could not be resolved safely.",
      };
    }
  }

  if (!writeOutcome.account.onboardingUrl) {
    await markProviderAccountIdempotencyFailed(
      client,
      command,
      "stripe_provider_account_create",
      keyHash,
      {
        compensationStatus: "completed",
        errorCode: "concurrent_owner_account_onboarding_url_missing",
      },
    );
    return providerAccountCommandConflict(
      "A Stripe account already exists for this property; retry onboarding with a new key.",
    );
  }
  const response = providerAccountCommandResponse(
    writeOutcome.account,
    writeOutcome.account.onboardingUrl,
    buildProviderAccountCommandMeta(command, keyHash),
  );
  await completeProviderAccountIdempotency(
    client,
    command,
    "stripe_provider_account_create",
    keyHash,
    fingerprint,
    response,
  );
  return { ok: true, status: "existing_owner_account", response };
}

async function issueStripeOnboardingLinkInClient(
  client: FinancePropertySettingsWriteClient,
  command: IssueStripeOnboardingLinkCommand,
  provider: FinanceStripeConnectProvider,
  transactional: boolean,
): Promise<FinanceProviderAccountCommandResult> {
  if (!transactional) {
    return {
      ok: false,
      statusCode: 500,
      code: "write_unavailable",
      message: "Stripe onboarding-link issuance requires a transactional database client.",
    };
  }
  const owner = financeProviderAccountOwner(command);
  const keyHash = sha256(command.idempotencyKey);
  const fingerprint = sha256(stableJson({ owner, payload: command.payload }));
  const existingIdempotency = await loadProviderAccountIdempotency(
    client,
    command,
    "stripe_onboarding_link_issue",
    keyHash,
  );
  const replay = replayProviderAccountCommand(existingIdempotency, fingerprint);
  if (replay) return replay;

  return inFinanceWriteTransaction(client, transactional, async () => {
    let previousOnlineCardReadiness: FinanceOnlineCardReadinessState | null = null;
    if (owner.ownerScope === "property") {
      await lockFinanceOnlineCardReadinessProperty(client, owner.propertyId);
      previousOnlineCardReadiness = await loadFinanceOnlineCardReadinessState(
        client,
        owner.propertyId,
      );
    }
    const account = await loadStripeProviderAccountById(
      client,
      command.payload.providerAccountId,
      owner,
      true,
    );
    if (!account) {
      return {
        ok: false,
        statusCode: 404,
        code: "provider_account_not_found",
        message: "Finance provider account was not found.",
      };
    }
    const idempotencyError = await reserveProviderAccountIdempotency(
      client,
      command,
      "stripe_onboarding_link_issue",
      keyHash,
      fingerprint,
    );
    if (idempotencyError) return idempotencyError;
    const onboardingUrl = await provider.createOnboardingLink({
      owner,
      providerAccountRef: account.providerAccountRef,
      idempotencyKey: stripeProviderIdempotencyKey(owner, keyHash, "onboarding-link"),
      returnSurface: command.payload.returnSurface,
    });
    await updateStripeProviderAccountOnboardingUrl(client, account, owner, onboardingUrl);
    const readinessLost =
      owner.ownerScope === "property"
        ? await applyFinanceOnlineCardReadinessLoss(client, {
            propertyId: owner.propertyId,
            previous: previousOnlineCardReadiness,
            context: onlineCardReadinessChangeContext(command.audit, command.commandId),
          })
        : false;
    const response = providerAccountCommandResponse(
      { ...account, onboardingStatus: "invited" },
      onboardingUrl,
      buildProviderAccountCommandMeta(command, keyHash, readinessLost),
    );
    await completeProviderAccountIdempotency(
      client,
      command,
      "stripe_onboarding_link_issue",
      keyHash,
      fingerprint,
      response,
    );
    return {
      ok: true,
      status: "created",
      response,
    };
  });
}

class StripeProviderAccountBindingChangedError extends Error {}

async function reconcileStripeProviderAccount(
  pool: FinancePropertySettingsReadPool,
  command: ReconcileStripePropertyAccountCommand,
  provider: FinanceStripeConnectProvider,
): Promise<FinanceStripeProviderAccountReconciliationResult> {
  const client = await checkoutFinanceWriteClient(pool);
  const ownsTransaction = typeof client.release === "function";
  if (!ownsTransaction) return stripeProviderAccountReconciliationWriteUnavailable();
  try {
    await client.query("BEGIN");
    const result = await reconcileStripeProviderAccountInClient(client, command, provider);
    await client.query(result.ok || result.code === "idempotency_conflict" ? "COMMIT" : "ROLLBACK");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    if (error instanceof StripeProviderAccountBindingChangedError) {
      return stripeProviderAccountNotFound();
    }
    return stripeProviderAccountReconciliationWriteUnavailable();
  } finally {
    client.release?.();
  }
}

async function reconcileStripeProviderAccountInClient(
  client: FinancePropertySettingsWriteClient,
  command: ReconcileStripePropertyAccountCommand,
  provider: FinanceStripeConnectProvider,
): Promise<FinanceStripeProviderAccountReconciliationResult> {
  if (!(await lockStripeProviderAccountReconciliationProperty(client, command.propertyId))) {
    return stripeProviderAccountNotFound();
  }
  const account = await loadConfiguredStripeProviderAccountReconciliationState(
    client,
    command.propertyId,
  );
  if (!account) return stripeProviderAccountNotFound();

  const { keyHash, fingerprint } = stripeProviderAccountReconciliationIdentity(command, account);
  const existing = await loadStripeProviderAccountReconciliationIdempotency(
    client,
    command.propertyId,
    keyHash,
  );
  if (existing) {
    if (existing.requestFingerprintHash !== fingerprint || existing.status !== "completed") {
      return stripeProviderAccountReconciliationConflict();
    }
    return {
      ok: true,
      status: "idempotent_replay",
      response: stripeProviderAccountReconciliationResponse(
        command,
        account,
        reconciliationEmittedReadinessLoss(existing),
      ),
    };
  }

  const reserved = await client.query<{ requestFingerprintHash: string }>(
    `INSERT INTO platform.idempotency_keys (
       operation_scope,
       operation,
       key_hash,
       request_fingerprint_hash,
       status,
       tenant_scope,
       property_id,
       correlation_id,
       first_seen_at,
       last_seen_at,
       expires_at,
       idempotency_metadata
     )
     VALUES (
       'finance',
       'stripe_provider_account_reconcile',
       $1,
       $2,
       'in_progress',
       'property',
       $3::uuid,
       $4,
       $5::timestamptz,
       $5::timestamptz,
       $5::timestamptz + interval '24 hours',
       $6::jsonb
     )
     ON CONFLICT (operation_scope, operation, key_hash, scope_key) DO NOTHING
     RETURNING request_fingerprint_hash AS "requestFingerprintHash"`,
    [
      keyHash,
      fingerprint,
      command.propertyId,
      command.audit.correlationId ?? command.audit.requestId,
      command.audit.requestedAt,
      JSON.stringify({ commandId: command.commandId, provider: "stripe" }),
    ],
  );
  if (!reserved.rows[0]) {
    const existing = await loadStripeProviderAccountReconciliationIdempotency(
      client,
      command.propertyId,
      keyHash,
    );
    if (existing?.requestFingerprintHash !== fingerprint || existing.status !== "completed") {
      return stripeProviderAccountReconciliationConflict();
    }
    return {
      ok: true,
      status: "idempotent_replay",
      response: stripeProviderAccountReconciliationResponse(
        command,
        account,
        reconciliationEmittedReadinessLoss(existing),
      ),
    };
  }

  let snapshot: StripeConnectProviderAccountSnapshot;
  try {
    snapshot = await provider.retrieveAccount({
      providerAccountRef: account.providerAccountRef,
    });
  } catch (error) {
    if (
      error instanceof StripeConnectAccountNotFoundError ||
      (error !== null &&
        typeof error === "object" &&
        "code" in error &&
        error.code === "stripe_connect_account_not_found")
    ) {
      return stripeProviderAccountNotFound();
    }
    return {
      ok: false,
      statusCode: 502,
      code: "provider_unavailable",
      message: "Stripe account status is unavailable.",
    };
  }
  if (snapshot.providerAccountRef !== account.providerAccountRef) {
    return {
      ok: false,
      statusCode: 502,
      code: "provider_unavailable",
      message: "Stripe account status is unavailable.",
    };
  }

  const state = await applyStripeProviderAccountSnapshot(client, {
    snapshot,
    propertyId: command.propertyId,
    providerAccountId: account.providerAccountId,
    metadata: { reconciledByCommandId: command.commandId },
    readinessChange: {
      occurredAt: command.audit.requestedAt,
      actorType: command.audit.actor.kind,
      actorUserId: command.audit.actor.kind === "user" ? command.audit.actor.userId : null,
      correlationId: command.audit.correlationId ?? command.audit.requestId,
      causationId: command.commandId,
    },
  });
  if (!state) throw new StripeProviderAccountBindingChangedError();

  const response = stripeProviderAccountReconciliationResponse(
    command,
    state,
    state.onlineCardReadinessLost,
  );
  await recordStripeProviderAccountReconciliationAudit(client, command, state, keyHash);
  await completeStripeProviderAccountReconciliationIdempotency(
    client,
    command,
    state.providerAccountId,
    keyHash,
    fingerprint,
    response,
  );
  return { ok: true, status: "reconciled", response };
}

async function lockStripeProviderAccountReconciliationProperty(
  client: FinanceQueryExecutor,
  propertyId: string,
): Promise<boolean> {
  const result = await client.query(
    `SELECT id
     FROM hotel_catalog.properties
     WHERE id = $1::uuid
     FOR UPDATE`,
    [propertyId],
  );
  return result.rows.length === 1;
}

async function loadConfiguredStripeProviderAccountReconciliationState(
  client: FinanceQueryExecutor,
  propertyId: string,
): Promise<ConfiguredStripeProviderAccountRow | null> {
  const result = await client.query<ConfiguredStripeProviderAccountRow>(
    `SELECT
       account.id::text AS "providerAccountId",
       account.provider_account_id AS "providerAccountRef",
       account.property_id::text AS "propertyId",
       CASE WHEN account.status = 'active' THEN 'active' ELSE 'setup_incomplete' END AS status,
       CASE
         WHEN account.onboarding_status = 'completed' THEN 'completed'
         ELSE 'invited'
       END AS "onboardingStatus",
       account.charges_enabled AS "chargesEnabled",
       account.payouts_enabled AS "payoutsEnabled",
       COALESCE(account.account_metadata ->> 'detailsSubmitted' = 'true', FALSE)
         AS "detailsSubmitted",
       account.account_metadata ->> 'cardPaymentsStatus' AS "cardPaymentsStatus",
       account.card_capability_revision::int AS "cardCapabilityRevision"
     FROM finance.payment_provider_accounts account
     JOIN finance.payment_settings settings
       ON settings.provider_account_id = account.id
      AND settings.property_id = account.property_id
     WHERE settings.property_id = $1::uuid
       AND account.account_scope = 'property'
       AND account.provider = 'stripe'
       AND account.provider_account_id NOT LIKE 'settings-choice:%'
     LIMIT 1
     FOR UPDATE OF account, settings`,
    [propertyId],
  );
  return result.rows[0] ?? null;
}

async function loadStripeProviderAccountReconciliationIdempotency(
  client: FinanceQueryExecutor,
  propertyId: string,
  keyHash: string,
): Promise<FinanceIdempotencyRow | null> {
  const result = await client.query<FinanceIdempotencyRow>(
    `SELECT status, request_fingerprint_hash AS "requestFingerprintHash",
            idempotency_metadata AS "idempotencyMetadata"
     FROM platform.idempotency_keys
     WHERE operation_scope = 'finance'
       AND operation = 'stripe_provider_account_reconcile'
       AND key_hash = $1
       AND tenant_scope = 'property'
       AND property_id = $2::uuid
     LIMIT 1`,
    [keyHash, propertyId],
  );
  return result.rows[0] ?? null;
}

function stripeProviderAccountReconciliationIdentity(
  command: ReconcileStripePropertyAccountCommand,
  account: Pick<ConfiguredStripeProviderAccountRow, "providerAccountId">,
): { keyHash: string; fingerprint: string } {
  return {
    keyHash: sha256(command.idempotencyKey),
    fingerprint: sha256(
      stableJson({ propertyId: command.propertyId, providerAccountId: account.providerAccountId }),
    ),
  };
}

function stripeProviderAccountReconciliationResponse(
  command: ReconcileStripePropertyAccountCommand,
  state: StripeProviderAccountReconciliationState,
  onlineCardReadinessLost = false,
): FinanceStripeProviderAccountReconciliationResponse {
  return {
    contractVersion: FINANCE_ROUTE_CONTRACT_VERSION,
    propertyId: command.propertyId,
    providerAccount: {
      provider: "stripe",
      status: state.status,
      onboardingStatus: state.onboardingStatus,
      chargesEnabled: state.chargesEnabled,
      payoutsEnabled: state.payoutsEnabled,
      detailsSubmitted: state.detailsSubmitted,
      cardPaymentsStatus: state.cardPaymentsStatus,
      ready: state.status === "active",
    },
    commandMeta: {
      commandId: command.commandId,
      idempotencyKey: command.idempotencyKey,
      sideEffects: ["provider_validation", "audit_event"],
      outboxEvents: onlineCardReadinessLost ? ["finance.online_card_readiness.changed"] : [],
      jobs: [],
    },
  };
}

function reconciliationEmittedReadinessLoss(row: FinanceIdempotencyRow): boolean {
  const metadata = plainRecord(row.idempotencyMetadata);
  const commandMeta = plainRecord(metadata?.["commandMeta"]);
  return (
    Array.isArray(commandMeta?.["outboxEvents"]) &&
    commandMeta["outboxEvents"].includes("finance.online_card_readiness.changed")
  );
}

async function recordStripeProviderAccountReconciliationAudit(
  client: FinancePropertySettingsWriteClient,
  command: ReconcileStripePropertyAccountCommand,
  state: StripeProviderAccountReconciliationState,
  keyHash: string,
): Promise<void> {
  await client.query(
    `INSERT INTO platform.product_audit_events (
       audit_key,
       product,
       action,
       action_version,
       occurred_at,
       tenant_scope,
       organization_id,
       property_id,
       actor_type,
       actor_user_id,
       target_resource_product,
       target_resource_type,
       target_resource_id,
       correlation_id,
       causation_id,
       redacted_payload,
       private_payload,
       audit_metadata,
       retention_class,
       privacy_scope
     )
     VALUES (
       $1,
       'finance',
       'finance.provider_account.stripe.reconciled',
       1,
       $2::timestamptz,
       'property',
       NULL,
       $3::uuid,
       $4,
       $5::uuid,
       'finance',
       'payment_provider_account',
       $6,
       $7,
       $8,
       $9::jsonb,
       '{}'::jsonb,
       $10::jsonb,
       'financial',
       'confidential'
     )`,
    [
      `finance.provider-account.stripe.reconcile.property.${command.propertyId}.key.${keyHash}.v1`,
      command.audit.requestedAt,
      command.propertyId,
      command.audit.actor.kind,
      command.audit.actor.kind === "user" ? command.audit.actor.userId : null,
      state.providerAccountId,
      command.audit.correlationId ?? command.audit.requestId,
      command.commandId,
      JSON.stringify({
        propertyId: command.propertyId,
        provider: "stripe",
        status: state.status,
        onboardingStatus: state.onboardingStatus,
        chargesEnabled: state.chargesEnabled,
        payoutsEnabled: state.payoutsEnabled,
        detailsSubmitted: state.detailsSubmitted,
        cardPaymentsStatus: state.cardPaymentsStatus,
        cardCapabilityRevision: state.cardCapabilityRevision,
      }),
      JSON.stringify({
        contractVersion: FINANCE_ROUTE_CONTRACT_VERSION,
        idempotencyKeyHash: keyHash,
        requestId: command.audit.requestId,
      }),
    ],
  );
}

async function completeStripeProviderAccountReconciliationIdempotency(
  client: FinancePropertySettingsWriteClient,
  command: ReconcileStripePropertyAccountCommand,
  providerAccountId: string,
  keyHash: string,
  fingerprint: string,
  response: FinanceStripeProviderAccountReconciliationResponse,
): Promise<void> {
  await client.query(
    `UPDATE platform.idempotency_keys
     SET status = 'completed',
         request_fingerprint_hash = $1,
         response_status_code = 200,
         response_resource_product = 'finance',
         response_resource_type = 'payment_provider_account',
         response_resource_id = $2,
         response_body_hash = $3,
         completed_at = $4::timestamptz,
         last_seen_at = $4::timestamptz,
         idempotency_metadata = idempotency_metadata || $5::jsonb
     WHERE operation_scope = 'finance'
       AND operation = 'stripe_provider_account_reconcile'
       AND key_hash = $6
       AND tenant_scope = 'property'
       AND property_id = $7::uuid`,
    [
      fingerprint,
      providerAccountId,
      sha256(stableJson(response)),
      command.audit.requestedAt,
      JSON.stringify({ commandMeta: response.commandMeta }),
      keyHash,
      command.propertyId,
    ],
  );
}

function stripeProviderAccountNotFound(): Extract<
  FinanceStripeProviderAccountReconciliationResult,
  { ok: false }
> {
  return {
    ok: false,
    statusCode: 404,
    code: "provider_account_not_found",
    message: "Finance provider account was not found.",
  };
}

function paymentSettingsWriteUnavailable(): Extract<
  FinancePaymentSettingsPatchResult,
  { ok: false }
> {
  return {
    ok: false,
    statusCode: 500,
    code: "write_unavailable",
    message: "Payment settings could not be saved.",
  };
}

function stripeProviderAccountReconciliationConflict(): Extract<
  FinanceStripeProviderAccountReconciliationResult,
  { ok: false }
> {
  return {
    ok: false,
    statusCode: 409,
    code: "idempotency_conflict",
    message: "Idempotency key is already in use for another Stripe reconciliation.",
  };
}

function stripeProviderAccountReconciliationWriteUnavailable(): Extract<
  FinanceStripeProviderAccountReconciliationResult,
  { ok: false }
> {
  return {
    ok: false,
    statusCode: 500,
    code: "write_unavailable",
    message: "Stripe account reconciliation could not be saved.",
  };
}

async function issueStripeDashboardLoginLink(
  client: FinanceQueryExecutor,
  propertyId: string,
  provider: FinanceStripeConnectProvider,
): Promise<FinanceStripeDashboardLoginLinkResult> {
  const account = await loadConfiguredStripeProviderAccount(client, propertyId);
  if (!account) {
    return {
      ok: false,
      statusCode: 404,
      code: "provider_account_not_found",
      message: "Finance provider account was not found.",
    };
  }

  try {
    return {
      ok: true,
      url: await provider.createLoginLink({ providerAccountRef: account.providerAccountRef }),
    };
  } catch (error) {
    if (
      error instanceof StripeConnectAccountNotFoundError ||
      (error !== null &&
        typeof error === "object" &&
        "code" in error &&
        error.code === "stripe_connect_account_not_found")
    ) {
      return {
        ok: false,
        statusCode: 404,
        code: "provider_account_not_found",
        message: "Finance provider account was not found.",
      };
    }
    return {
      ok: false,
      statusCode: 502,
      code: "provider_unavailable",
      message: "Stripe Dashboard is unavailable.",
    };
  }
}

async function loadConfiguredStripeProviderAccount(
  client: FinanceQueryExecutor,
  propertyId: string,
): Promise<FinanceProviderAccountRow | null> {
  const result = await client.query<FinanceProviderAccountRow>(
    `SELECT
       account.id::text AS "providerAccountId",
       account.provider_account_id AS "providerAccountRef",
       account.status,
       account.onboarding_status AS "onboardingStatus",
       account.account_metadata ->> 'onboardingUrl' AS "onboardingUrl"
     FROM finance.payment_provider_accounts account
     JOIN finance.payment_settings settings
       ON settings.provider_account_id = account.id
      AND settings.property_id = account.property_id
     WHERE settings.property_id = $1::uuid
       AND account.account_scope = 'property'
       AND account.provider = 'stripe'
       AND account.provider_account_id NOT LIKE 'settings-choice:%'
     LIMIT 1`,
    [propertyId],
  );
  return result.rows[0] ?? null;
}

function financeProviderAccountOwner(
  command: CreateStripeProviderAccountCommand | IssueStripeOnboardingLinkCommand,
): Parameters<FinanceStripeConnectProvider["createAccount"]>[0]["owner"] {
  if ("propertyId" in command) {
    return {
      ownerScope: "property",
      propertyId: command.propertyId,
      organizationId:
        command.audit.actor.kind === "user" ? command.audit.actor.organizationId : null,
    };
  }
  return {
    ownerScope: "affiliate",
    affiliateId: command.affiliateId,
    organizationId: command.organizationId,
  };
}

async function loadStripeProviderAccountByOwner(
  client: FinanceQueryExecutor,
  owner: Parameters<FinanceStripeConnectProvider["createAccount"]>[0]["owner"],
  forUpdate = false,
): Promise<FinanceProviderAccountRow | null> {
  if (owner.ownerScope === "property") {
    const result = await client.query<FinanceProviderAccountRow>(
      `SELECT
         id::text AS "providerAccountId",
         provider_account_id AS "providerAccountRef",
         status,
         onboarding_status AS "onboardingStatus",
         account_metadata ->> 'onboardingUrl' AS "onboardingUrl"
       FROM finance.payment_provider_accounts
       WHERE account_scope = 'property'
         AND provider = 'stripe'
         AND property_id = $1::uuid
         AND provider_account_id NOT LIKE 'settings-choice:%'
       ORDER BY created_at ASC
       LIMIT 1
       ${forUpdate ? "FOR UPDATE" : ""}`,
      [owner.propertyId],
    );
    return result.rows[0] ?? null;
  }

  const result = await client.query<FinanceProviderAccountRow>(
    `SELECT
       id::text AS "providerAccountId",
       provider_account_id AS "providerAccountRef",
       status,
       onboarding_status AS "onboardingStatus",
       account_metadata ->> 'onboardingUrl' AS "onboardingUrl"
     FROM finance.payment_provider_accounts
     WHERE account_scope = 'organization'
       AND provider = 'stripe'
       AND organization_id = $1::uuid
       AND account_metadata ->> 'affiliateId' = $2
     ORDER BY created_at ASC
     LIMIT 1
     ${forUpdate ? "FOR UPDATE" : ""}`,
    [owner.organizationId, owner.affiliateId],
  );
  return result.rows[0] ?? null;
}

async function loadStripeProviderAccountById(
  client: FinancePropertySettingsWriteClient,
  providerAccountId: string,
  owner: Parameters<FinanceStripeConnectProvider["createAccount"]>[0]["owner"],
  forUpdate = false,
): Promise<FinanceProviderAccountRow | null> {
  const ownerAccount = await loadStripeProviderAccountByOwner(client, owner, forUpdate);
  return ownerAccount?.providerAccountId === providerAccountId ||
    ownerAccount?.providerAccountRef === providerAccountId
    ? ownerAccount
    : null;
}

async function insertStripeProviderAccount(
  client: FinancePropertySettingsWriteClient,
  command: CreateStripeProviderAccountCommand,
  providerAccount: { providerAccountRef: string; onboardingUrl: string },
): Promise<StripeProviderAccountInsert> {
  const owner = financeProviderAccountOwner(command);
  await lockStripeProviderAccountReference(client, providerAccount.providerAccountRef);
  const accountMetadata =
    owner.ownerScope === "affiliate"
      ? {
          affiliateId: owner.affiliateId,
          commandId: command.commandId,
          onboardingUrl: providerAccount.onboardingUrl,
        }
      : {
          commandId: command.commandId,
          onboardingUrl: providerAccount.onboardingUrl,
        };
  const result = await client.query<FinanceProviderAccountRow>(
    `WITH inserted AS (
       INSERT INTO finance.payment_provider_accounts (
         property_id,
         organization_id,
         account_scope,
         provider,
         provider_account_id,
         status,
         onboarding_status,
         charges_enabled,
         payouts_enabled,
         default_currency,
         capabilities,
         account_metadata,
         created_at,
         updated_at
       )
       VALUES (
         $1::uuid,
         $2::uuid,
         $3,
         'stripe',
         $4,
         'setup_incomplete',
         'invited',
         false,
         false,
         upper($5),
         ARRAY['card_payments', 'transfers'],
         $6::jsonb,
         $7::timestamptz,
         $7::timestamptz
       )
       ON CONFLICT (provider, provider_account_id) WHERE provider_account_id IS NOT NULL
       DO NOTHING
       RETURNING
         id::text AS "providerAccountId",
         provider_account_id AS "providerAccountRef",
         status,
         onboarding_status AS "onboardingStatus",
         account_metadata ->> 'onboardingUrl' AS "onboardingUrl"
     )
     SELECT * FROM inserted`,
    [
      owner.ownerScope === "property" ? owner.propertyId : null,
      owner.ownerScope === "affiliate" ? owner.organizationId : null,
      owner.ownerScope === "property" ? "property" : "organization",
      providerAccount.providerAccountRef,
      command.payload.country,
      JSON.stringify(accountMetadata),
      command.audit.requestedAt,
    ],
  );
  const inserted = result.rows[0];
  if (inserted) return { account: inserted, inserted: true };

  const existing = await loadStripeProviderAccountByRef(client, providerAccount.providerAccountRef);
  if (!existing || !stripeProviderAccountOwnerMatches(existing, owner)) {
    throw new StripeProviderAccountOwnerConflictError();
  }
  return { account: existing, inserted: false };
}

async function loadStripeProviderAccountByRef(
  client: FinanceQueryExecutor,
  providerAccountRef: string,
): Promise<StripeProviderAccountOwnershipRow | null> {
  const result = await client.query<StripeProviderAccountOwnershipRow>(
    `SELECT id::text AS "providerAccountId",
            provider_account_id AS "providerAccountRef",
            status,
            onboarding_status AS "onboardingStatus",
            account_metadata ->> 'onboardingUrl' AS "onboardingUrl",
            account_scope AS "accountScope",
            property_id::text AS "propertyId",
            organization_id::text AS "organizationId",
            account_metadata ->> 'affiliateId' AS "affiliateId"
     FROM finance.payment_provider_accounts
     WHERE provider = 'stripe' AND provider_account_id = $1
     LIMIT 1`,
    [providerAccountRef],
  );
  return result.rows[0] ?? null;
}

async function compensateStripeProviderAccountIfUnowned(
  client: FinancePropertySettingsWriteClient,
  provider: FinanceStripeConnectProvider & {
    compensateAccountCreation: NonNullable<
      FinanceStripeConnectProvider["compensateAccountCreation"]
    >;
  },
  input: Parameters<NonNullable<FinanceStripeConnectProvider["compensateAccountCreation"]>>[0],
): Promise<
  { kind: "compensated" } | { kind: "durably_owned"; account: StripeProviderAccountOwnershipRow }
> {
  return inFinanceWriteTransaction(client, true, async () => {
    await lockStripeProviderAccountReference(client, input.providerAccountRef);
    const durableAccount = await loadStripeProviderAccountByRef(client, input.providerAccountRef);
    if (durableAccount) return { kind: "durably_owned" as const, account: durableAccount };
    await provider.compensateAccountCreation(input);
    return { kind: "compensated" as const };
  });
}

class StripeProviderAccountOwnerConflictError extends Error {}

function stripeProviderAccountOwnerMatches(
  account: {
    accountScope: string;
    propertyId: string | null;
    organizationId: string | null;
    affiliateId: string | null;
  },
  owner: Parameters<FinanceStripeConnectProvider["createAccount"]>[0]["owner"],
): boolean {
  return owner.ownerScope === "property"
    ? account.accountScope === "property" && account.propertyId === owner.propertyId
    : account.accountScope === "organization" &&
        account.organizationId === owner.organizationId &&
        account.affiliateId === owner.affiliateId;
}

async function relinkPaymentSettingsProviderAccount(
  client: FinancePropertySettingsWriteClient,
  propertyId: string,
  provider: FinanceRoutePaymentProvider,
  providerAccountId: string,
): Promise<void> {
  await client.query(
    `UPDATE finance.payment_settings settings
     SET provider_account_id = $3::uuid,
         updated_at = now()
     FROM finance.payment_provider_accounts placeholder
     WHERE settings.property_id = $1::uuid
       AND settings.provider_account_id = placeholder.id
       AND placeholder.property_id = settings.property_id
       AND placeholder.account_scope = 'property'
       AND placeholder.provider = $2
       AND placeholder.provider_account_id = $4`,
    [propertyId, provider, providerAccountId, `settings-choice:${propertyId}:${provider}`],
  );
}

async function updateStripeProviderAccountOnboardingUrl(
  client: FinancePropertySettingsWriteClient,
  account: FinanceProviderAccountRow,
  owner: Parameters<FinanceStripeConnectProvider["createAccount"]>[0]["owner"],
  onboardingUrl: string,
): Promise<void> {
  const updated = await client.query(
    `UPDATE finance.payment_provider_accounts
     SET onboarding_status = 'invited',
         account_metadata = account_metadata || $2::jsonb,
         updated_at = now()
     WHERE id = $1::uuid
       AND provider = 'stripe'
       AND provider_account_id = $3
       AND (($4 = 'property' AND account_scope = 'property' AND property_id = $5::uuid)
         OR ($4 = 'affiliate' AND account_scope = 'organization'
           AND organization_id = $6::uuid AND account_metadata ->> 'affiliateId' = $7))
     RETURNING id`,
    [
      account.providerAccountId,
      JSON.stringify({ onboardingUrl }),
      account.providerAccountRef,
      owner.ownerScope,
      owner.ownerScope === "property" ? owner.propertyId : null,
      owner.ownerScope === "affiliate" ? owner.organizationId : null,
      owner.ownerScope === "affiliate" ? owner.affiliateId : null,
    ],
  );
  if (updated.rowCount !== 1) throw new StripeProviderAccountOwnerConflictError();
}

async function loadProviderAccountIdempotency(
  client: FinancePropertySettingsWriteClient,
  command: CreateStripeProviderAccountCommand | IssueStripeOnboardingLinkCommand,
  operation: "stripe_provider_account_create" | "stripe_onboarding_link_issue",
  keyHash: string,
): Promise<FinanceIdempotencyRow | null> {
  const owner = financeProviderAccountOwner(command);
  const result = await client.query<FinanceIdempotencyRow>(
    `SELECT
       status,
       request_fingerprint_hash AS "requestFingerprintHash",
       idempotency_metadata AS "idempotencyMetadata"
     FROM platform.idempotency_keys
     WHERE operation_scope = 'finance'
       AND operation = $1
       AND key_hash = $2
       AND tenant_scope = $3
       AND (($3 = 'property' AND property_id = $4::uuid)
         OR ($3 = 'organization' AND organization_id = $5::uuid))
     LIMIT 1`,
    [
      operation,
      keyHash,
      owner.ownerScope === "property" ? "property" : "organization",
      owner.ownerScope === "property" ? owner.propertyId : null,
      owner.ownerScope === "affiliate" ? owner.organizationId : null,
    ],
  );
  return result.rows[0] ?? null;
}

async function reserveProviderAccountIdempotency(
  client: FinancePropertySettingsWriteClient,
  command: CreateStripeProviderAccountCommand | IssueStripeOnboardingLinkCommand,
  operation: "stripe_provider_account_create" | "stripe_onboarding_link_issue",
  keyHash: string,
  fingerprint: string,
): Promise<Extract<FinanceProviderAccountCommandResult, { ok: false }> | null> {
  const owner = financeProviderAccountOwner(command);
  const result = await client.query<{
    requestFingerprintHash: string;
  }>(
    `INSERT INTO platform.idempotency_keys (
       operation_scope,
       operation,
       key_hash,
       request_fingerprint_hash,
       status,
       tenant_scope,
       organization_id,
       property_id,
       correlation_id,
       first_seen_at,
       last_seen_at,
       expires_at,
       idempotency_metadata
     )
     VALUES (
       'finance',
       $1,
       $2,
       $3,
       'in_progress',
       $4,
       $5::uuid,
       $6::uuid,
       $7,
       $8::timestamptz,
       $8::timestamptz,
       $8::timestamptz + interval '24 hours',
       $9::jsonb
     )
     ON CONFLICT (operation_scope, operation, key_hash, scope_key) DO NOTHING
     RETURNING request_fingerprint_hash AS "requestFingerprintHash"`,
    [
      operation,
      keyHash,
      fingerprint,
      owner.ownerScope === "property" ? "property" : "organization",
      owner.ownerScope === "affiliate" ? owner.organizationId : null,
      owner.ownerScope === "property" ? owner.propertyId : null,
      command.audit.correlationId ?? command.audit.requestId,
      command.audit.requestedAt,
      JSON.stringify({
        commandId: command.commandId,
        owner,
        provider: "stripe",
      }),
    ],
  );
  if (!result.rows[0]) {
    return providerAccountCommandConflict(
      "This Stripe provider-account command is already in progress or completed.",
    );
  }
  return null;
}

async function completeProviderAccountIdempotency(
  client: FinancePropertySettingsWriteClient,
  command: CreateStripeProviderAccountCommand | IssueStripeOnboardingLinkCommand,
  operation: "stripe_provider_account_create" | "stripe_onboarding_link_issue",
  keyHash: string,
  fingerprint: string,
  response: FinanceProviderAccountCommandResponse,
): Promise<void> {
  const owner = financeProviderAccountOwner(command);
  await client.query(
    `UPDATE platform.idempotency_keys
     SET status = 'completed',
         request_fingerprint_hash = $1,
         response_status_code = 200,
         response_resource_product = 'finance',
         response_resource_type = 'payment_provider_account',
         response_resource_id = $2,
         response_body_hash = $3,
         completed_at = $4::timestamptz,
         last_seen_at = $4::timestamptz,
         idempotency_metadata = idempotency_metadata || $5::jsonb
     WHERE operation_scope = 'finance'
       AND operation = $6
       AND key_hash = $7
       AND tenant_scope = $8
       AND (($8 = 'property' AND property_id = $9::uuid)
         OR ($8 = 'organization' AND organization_id = $10::uuid))`,
    [
      fingerprint,
      response.providerAccountId,
      sha256(stableJson(response)),
      command.audit.requestedAt,
      JSON.stringify({
        response,
      }),
      operation,
      keyHash,
      owner.ownerScope === "property" ? "property" : "organization",
      owner.ownerScope === "property" ? owner.propertyId : null,
      owner.ownerScope === "affiliate" ? owner.organizationId : null,
    ],
  );
}

async function markProviderAccountIdempotencyFailed(
  client: FinancePropertySettingsWriteClient,
  command: CreateStripeProviderAccountCommand,
  operation: "stripe_provider_account_create",
  keyHash: string,
  result: {
    compensationStatus: "completed" | "queued" | "not_attempted";
    compensationJobKey?: string | null;
    errorCode: string;
  },
): Promise<void> {
  const owner = financeProviderAccountOwner(command);
  await client.query(
    `UPDATE platform.idempotency_keys
     SET status = 'failed',
         last_seen_at = $1::timestamptz,
         idempotency_metadata = idempotency_metadata || $2::jsonb
     WHERE operation_scope = 'finance'
       AND operation = $3
       AND key_hash = $4
       AND tenant_scope = $5
       AND (($5 = 'property' AND property_id = $6::uuid)
         OR ($5 = 'organization' AND organization_id = $7::uuid))`,
    [
      command.audit.requestedAt,
      JSON.stringify({
        compensationStatus: result.compensationStatus,
        compensationJobKey: result.compensationJobKey ?? null,
        errorCode: result.errorCode,
      }),
      operation,
      keyHash,
      owner.ownerScope === "property" ? "property" : "organization",
      owner.ownerScope === "property" ? owner.propertyId : null,
      owner.ownerScope === "affiliate" ? owner.organizationId : null,
    ],
  );
}

async function enqueueStripeAccountCompensation(
  client: FinancePropertySettingsWriteClient,
  command: CreateStripeProviderAccountCommand,
  owner: Parameters<FinanceStripeConnectProvider["createAccount"]>[0]["owner"],
  keyHash: string,
  providerAccountRef: string,
): Promise<string> {
  const ownerKey =
    owner.ownerScope === "property"
      ? `property.${owner.propertyId}`
      : `affiliate.${owner.affiliateId}.organization.${owner.organizationId}`;
  const jobKey = `finance.stripe-account-compensation.${ownerKey}.key.${keyHash}.v1`;
  const result = await client.query<{ jobKey: string }>(
    `INSERT INTO platform.jobs (
       job_key, queue_name, job_type, status, max_attempts,
       tenant_scope, organization_id, property_id,
       resource_product, resource_type, resource_id,
       correlation_id, idempotency_key_hash, payload, job_metadata, ai_visible
     ) VALUES (
       $1, $2, $3, 'pending', 8,
       $4, $5::uuid, $6::uuid,
       'finance', 'payment_provider_account_compensation', $7,
       $8, $9, $10::jsonb,
       '{"privacyScope":"restricted","containsProviderReference":true}'::jsonb,
       FALSE
     )
     ON CONFLICT (queue_name, job_key) DO UPDATE SET
       status = CASE WHEN platform.jobs.status = 'succeeded' THEN 'succeeded' ELSE 'pending' END,
       run_after = CASE WHEN platform.jobs.status = 'succeeded'
                        THEN platform.jobs.run_after ELSE now() END,
       finished_at = CASE WHEN platform.jobs.status = 'succeeded'
                          THEN platform.jobs.finished_at ELSE NULL END,
       locked_at = NULL,
       locked_by = NULL,
       updated_at = now()
     RETURNING job_key AS "jobKey"`,
    [
      jobKey,
      FINANCE_STRIPE_ACCOUNT_COMPENSATION_QUEUE,
      FINANCE_STRIPE_ACCOUNT_COMPENSATION_JOB_TYPE,
      owner.ownerScope === "property" ? "property" : "organization",
      owner.ownerScope === "affiliate" ? owner.organizationId : null,
      owner.ownerScope === "property" ? owner.propertyId : null,
      sha256(providerAccountRef),
      command.audit.correlationId ?? command.audit.requestId,
      keyHash,
      JSON.stringify({
        owner,
        providerAccountRef,
        idempotencyKey: stripeProviderIdempotencyKey(owner, keyHash, "compensate"),
      }),
    ],
  );
  const storedJobKey = result.rows[0]?.jobKey;
  if (!storedJobKey) throw new Error("Stripe account compensation could not be queued");
  return storedJobKey;
}

function buildProviderAccountCommandMeta(
  command: CreateStripeProviderAccountCommand | IssueStripeOnboardingLinkCommand,
  keyHash: string,
  readinessLost = false,
): FinanceProviderAccountCommandMeta {
  const owner = financeProviderAccountOwner(command);
  return {
    commandId: command.commandId,
    idempotencyKey: command.idempotencyKey,
    sideEffects: ["audit_event", "reconciliation_job"],
    outboxEvents: readinessLost ? ["finance.online_card_readiness.changed"] : [],
    jobs: [
      {
        jobType: "pms.projection-refresh",
        idempotencyKey: `finance.reconcile-provider-account:${owner.ownerScope}:${owner.ownerScope === "property" ? owner.propertyId : owner.affiliateId}:stripe:${keyHash}:v1`,
        status: "queued",
      },
    ],
  };
}

function providerAccountCommandResponse(
  account: FinanceProviderAccountRow,
  onboardingUrl: string,
  commandMeta: FinanceProviderAccountCommandMeta,
): FinanceProviderAccountCommandResponse {
  return {
    contractVersion: FINANCE_ROUTE_CONTRACT_VERSION,
    providerAccountId: account.providerAccountId,
    provider: "stripe",
    providerAccountRef: account.providerAccountRef,
    status: providerAccountStatus(account.status),
    onboardingStatus: providerOnboardingStatus(account.onboardingStatus),
    onboardingUrl,
    commandMeta,
  };
}

function replayProviderAccountCommand(
  existing: FinanceIdempotencyRow | null,
  fingerprint: string,
): FinanceProviderAccountCommandResult | null {
  if (!existing) return null;
  if (existing.requestFingerprintHash !== fingerprint) {
    return providerAccountCommandConflict(
      "Idempotency key was already used with a different Stripe provider-account payload.",
    );
  }
  if (existing.status !== "completed") {
    return providerAccountCommandConflict(
      existing.status === "in_progress"
        ? "This Stripe provider-account command is already in progress."
        : "This Stripe provider-account command did not complete; wait for cleanup before retrying.",
    );
  }

  const metadata = plainRecord(existing.idempotencyMetadata);
  const response = parseStoredProviderAccountResponse(metadata?.response);
  if (!response) {
    return providerAccountCommandConflict(
      "The completed Stripe provider-account command has no valid stored response.",
    );
  }
  return { ok: true, status: "idempotent_replay", response };
}

function parseStoredProviderAccountResponse(
  value: unknown,
): FinanceProviderAccountCommandResponse | null {
  const response = plainRecord(value);
  const commandMeta = plainRecord(response?.commandMeta);
  if (!response || !commandMeta) return null;

  const providerAccountId = nonEmptyString(response.providerAccountId);
  const providerAccountRef = nonEmptyString(response.providerAccountRef);
  const onboardingUrl = nonEmptyString(response.onboardingUrl);
  const commandId = nonEmptyString(commandMeta.commandId);
  const idempotencyKey = nonEmptyString(commandMeta.idempotencyKey);
  const status = optionalEnum(response.status, FINANCE_PROVIDER_ACCOUNT_STATUSES);
  const onboardingStatus = optionalEnum(
    response.onboardingStatus,
    FINANCE_PROVIDER_ONBOARDING_STATUSES,
  );
  const sideEffects = Array.isArray(commandMeta.sideEffects)
    ? commandMeta.sideEffects.map((entry) =>
        optionalEnum(entry, FINANCE_PROVIDER_ACCOUNT_COMMAND_SIDE_EFFECTS),
      )
    : [];
  const outboxEvents = Array.isArray(commandMeta.outboxEvents)
    ? commandMeta.outboxEvents.filter((entry): entry is string => typeof entry === "string")
    : [];
  const jobs = Array.isArray(commandMeta.jobs)
    ? commandMeta.jobs.map((entry) => {
        const job = plainRecord(entry);
        const jobIdempotencyKey = nonEmptyString(job?.idempotencyKey);
        if (
          job?.jobType !== "pms.projection-refresh" ||
          !jobIdempotencyKey ||
          (job.status !== "queued" && job.status !== "idempotent_replay")
        ) {
          return null;
        }
        return {
          jobType: "pms.projection-refresh" as const,
          idempotencyKey: jobIdempotencyKey,
          status: job.status,
        };
      })
    : [];

  if (
    response.contractVersion !== FINANCE_ROUTE_CONTRACT_VERSION ||
    response.provider !== "stripe" ||
    !providerAccountId ||
    !providerAccountRef ||
    !onboardingUrl ||
    !status ||
    !onboardingStatus ||
    !commandId ||
    !idempotencyKey ||
    sideEffects.length !== (commandMeta.sideEffects as unknown[] | undefined)?.length ||
    sideEffects.some((entry) => !entry) ||
    outboxEvents.length !== (commandMeta.outboxEvents as unknown[] | undefined)?.length ||
    jobs.length !== (commandMeta.jobs as unknown[] | undefined)?.length ||
    jobs.some((entry) => !entry)
  ) {
    return null;
  }

  return {
    contractVersion: FINANCE_ROUTE_CONTRACT_VERSION,
    providerAccountId,
    provider: "stripe",
    providerAccountRef,
    status,
    onboardingStatus,
    onboardingUrl,
    commandMeta: {
      commandId,
      idempotencyKey,
      sideEffects: sideEffects as FinanceProviderAccountCommandMeta["sideEffects"],
      outboxEvents,
      jobs: jobs as FinanceProviderAccountCommandMeta["jobs"],
    },
  };
}

function providerAccountCommandConflict(
  message: string,
): Extract<FinanceProviderAccountCommandResult, { ok: false }> {
  return {
    ok: false,
    statusCode: 409,
    code: "idempotency_conflict",
    message,
  };
}

function stripeProviderIdempotencyKey(
  owner: Parameters<FinanceStripeConnectProvider["createAccount"]>[0]["owner"],
  keyHash: string,
  purpose: "account" | "onboarding-link" | "compensate",
): string {
  const ownerKey =
    owner.ownerScope === "property"
      ? `property:${owner.propertyId}`
      : `affiliate:${owner.affiliateId}:organization:${owner.organizationId}`;
  return `finance.stripe-connect.${purpose}:${ownerKey}:key:${keyHash}:v1`;
}

async function enqueueXenditPayoutReconciliationInClient(
  client: FinancePropertySettingsWriteClient,
  command: FinanceXenditPayoutReconciliationCommand,
): Promise<FinanceXenditPayoutReconciliationResult> {
  if (command.payload.olderThanMinutes < 0 || command.payload.olderThanMinutes > 10080) {
    return {
      ok: false,
      statusCode: 400,
      code: "invalid_command",
      message: "olderThanMinutes must be between 0 and 10080.",
    };
  }

  const keyHash = sha256(command.idempotencyKey);
  const fingerprint = sha256(stableJson(command.payload));
  const requestedAt = command.audit.requestedAt;
  const jobKey = buildXenditPayoutReconciliationJobKey(command);
  const idempotency = await client.query<{
    status: string;
    requestFingerprintHash: string;
  }>(
    `INSERT INTO platform.idempotency_keys (
       operation_scope,
       operation,
       key_hash,
       request_fingerprint_hash,
       status,
       tenant_scope,
       organization_id,
       property_id,
       correlation_id,
       response_status_code,
       response_resource_product,
       response_resource_type,
       response_resource_id,
       completed_at,
       first_seen_at,
       last_seen_at,
       expires_at,
       idempotency_metadata
     )
     VALUES (
       'finance',
       'xendit_payout_reconciliation',
       $1,
       $2,
       'completed',
       'property',
       NULL,
       $3::uuid,
       $4,
       202,
       'finance',
       'payout',
       $6,
       $5::timestamptz,
       $5::timestamptz,
       $5::timestamptz,
       $5::timestamptz + interval '24 hours',
       $7::jsonb
     )
     ON CONFLICT (operation_scope, operation, key_hash, scope_key)
     DO UPDATE SET last_seen_at = EXCLUDED.last_seen_at
     RETURNING
       status,
       request_fingerprint_hash AS "requestFingerprintHash"`,
    [
      keyHash,
      fingerprint,
      command.propertyId,
      command.audit.correlationId ?? command.audit.requestId,
      requestedAt,
      command.propertyId,
      JSON.stringify({
        commandId: command.commandId,
        idempotencyKey: command.idempotencyKey,
        provider: "xendit",
        olderThanMinutes: command.payload.olderThanMinutes,
        legacyDisposition: XENDIT_PAYOUT_RECONCILIATION_LEGACY_DISPOSITION,
      }),
    ],
  );
  const idempotencyRow = idempotency.rows[0];
  if (idempotencyRow && idempotencyRow.requestFingerprintHash !== fingerprint) {
    return {
      ok: false,
      statusCode: 409,
      code: "idempotency_conflict",
      message: "Idempotency key was already used with a different reconciliation payload.",
    };
  }

  const job = await client.query<{ jobId: string; replay: boolean }>(
    `WITH inserted AS (
       INSERT INTO platform.jobs (
         job_key,
         queue_name,
         job_type,
         tenant_scope,
         organization_id,
         property_id,
         resource_product,
         resource_type,
         resource_id,
         correlation_id,
         idempotency_key_hash,
         payload,
         job_metadata
       )
       VALUES (
         $1,
         'finance-reconciliation',
         'finance.reconcile-payout',
         'property',
         NULL,
         $2::uuid,
         'finance',
         'payout',
         $2,
         $3,
         $4,
         $5::jsonb,
         $6::jsonb
       )
       ON CONFLICT (queue_name, job_key) DO NOTHING
       RETURNING id::text AS "jobId", false AS replay
     )
     SELECT "jobId", replay FROM inserted
     UNION ALL
     SELECT id::text AS "jobId", true AS replay
     FROM platform.jobs
     WHERE queue_name = 'finance-reconciliation'
       AND job_key = $1
     LIMIT 1`,
    [
      jobKey,
      command.propertyId,
      command.audit.correlationId ?? command.audit.requestId,
      keyHash,
      JSON.stringify({
        provider: "xendit",
        propertyId: command.propertyId,
        olderThanMinutes: command.payload.olderThanMinutes,
        requestedAt,
      }),
      JSON.stringify({
        commandId: command.commandId,
        legacyDisposition: XENDIT_PAYOUT_RECONCILIATION_LEGACY_DISPOSITION,
      }),
    ],
  );
  const replay = Boolean(job.rows[0]?.replay);
  const commandMeta = buildXenditPayoutReconciliationCommandMeta(command, replay);
  await recordXenditPayoutReconciliationAuditEvent(client, command, keyHash, jobKey, requestedAt);
  return {
    ok: true,
    status: replay ? "idempotent_replay" : "queued",
    job: commandMeta.jobs[0] as Extract<
      FinanceCommandMeta["jobs"][number],
      { jobType: "finance.reconcile-payout" }
    >,
    legacyDisposition: XENDIT_PAYOUT_RECONCILIATION_LEGACY_DISPOSITION,
    commandMeta,
  };
}

async function enqueuePropertyPayoutDispatchInClient(
  client: FinancePropertySettingsWriteClient,
  command: FinancePropertyPayoutDispatchCommand,
): Promise<FinancePropertyPayoutDispatchResult> {
  const keyHash = sha256(command.idempotencyKey);
  const fingerprint = sha256(stableJson(command.payload));
  const requestedAt = command.audit.requestedAt;
  const idempotency = await client.query<{
    status: string;
    requestFingerprintHash: string;
  }>(
    `INSERT INTO platform.idempotency_keys (
       operation_scope,
       operation,
       key_hash,
       request_fingerprint_hash,
       status,
       tenant_scope,
       organization_id,
       property_id,
       correlation_id,
       response_status_code,
       response_resource_product,
       response_resource_type,
       response_resource_id,
       completed_at,
       first_seen_at,
       last_seen_at,
       expires_at,
       idempotency_metadata
     )
     VALUES (
       'finance',
       'property_payout_dispatch',
       $1,
       $2,
       'completed',
       'property',
       NULL,
       $3::uuid,
       $4,
       202,
       'finance',
       'payout',
       $6,
       $5::timestamptz,
       $5::timestamptz,
       $5::timestamptz,
       $5::timestamptz + interval '24 hours',
       $7::jsonb
     )
     ON CONFLICT (operation_scope, operation, key_hash, scope_key)
     DO UPDATE SET last_seen_at = EXCLUDED.last_seen_at
     RETURNING
       status,
       request_fingerprint_hash AS "requestFingerprintHash"`,
    [
      keyHash,
      fingerprint,
      command.propertyId,
      command.audit.correlationId ?? command.audit.requestId,
      requestedAt,
      command.payload.payoutId,
      JSON.stringify({
        commandId: command.commandId,
        idempotencyKey: command.idempotencyKey,
        payoutId: command.payload.payoutId,
        legacyDisposition: PROPERTY_PAYOUT_DISPATCH_LEGACY_DISPOSITION,
      }),
    ],
  );
  const idempotencyRow = idempotency.rows[0];
  if (idempotencyRow && idempotencyRow.requestFingerprintHash !== fingerprint) {
    return {
      ok: false,
      statusCode: 409,
      code: "idempotency_conflict",
      message: "Idempotency key was already used with a different payout dispatch payload.",
    };
  }

  const readiness = await loadPropertyPayoutDispatchReadiness(client, command);
  if (!readiness) {
    return {
      ok: false,
      statusCode: 404,
      code: "payout_not_found",
      message: "Finance payout was not found for this property.",
    };
  }
  const blocker = propertyPayoutDispatchBlocker(readiness);
  if (blocker) return blocker;
  const provider =
    readiness.provider === "stripe" || readiness.provider === "xendit" ? readiness.provider : null;
  if (!provider) {
    return {
      ok: false,
      statusCode: 400,
      code: "invalid_command",
      message: "Property payout dispatch requires a Stripe or Xendit provider account.",
    };
  }

  const jobKey = buildPropertyPayoutDispatchJobKey(command);
  const job = await client.query<{ jobId: string; replay: boolean }>(
    `WITH inserted AS (
       INSERT INTO platform.jobs (
         job_key,
         queue_name,
         job_type,
         tenant_scope,
         organization_id,
         property_id,
         resource_product,
         resource_type,
         resource_id,
         correlation_id,
         idempotency_key_hash,
         payload,
         job_metadata
       )
       VALUES (
         $1,
         'finance-property-payout-dispatch',
         'finance.dispatch-property-payout',
         'property',
         NULL,
         $2::uuid,
         'finance',
         'payout',
         $3,
         $4,
         $5,
         $6::jsonb,
         $7::jsonb
       )
       ON CONFLICT (queue_name, job_key) DO NOTHING
       RETURNING id::text AS "jobId", false AS replay
     )
     SELECT "jobId", replay FROM inserted
     UNION ALL
     SELECT id::text AS "jobId", true AS replay
     FROM platform.jobs
     WHERE queue_name = 'finance-property-payout-dispatch'
       AND job_key = $1
     LIMIT 1`,
    [
      jobKey,
      command.propertyId,
      command.payload.payoutId,
      command.audit.correlationId ?? command.audit.requestId,
      keyHash,
      JSON.stringify({
        propertyId: command.propertyId,
        payoutId: command.payload.payoutId,
        provider,
        legacySchedulerFrozenAt: command.payload.legacySchedulerFrozenAt,
        reconciliationReadyAt: command.payload.reconciliationReadyAt,
      }),
      JSON.stringify({
        commandId: command.commandId,
        legacyDisposition: PROPERTY_PAYOUT_DISPATCH_LEGACY_DISPOSITION,
        rollbackRule: PROPERTY_PAYOUT_DISPATCH_ROLLBACK_RULE,
      }),
    ],
  );
  const replay = Boolean(job.rows[0]?.replay);
  const commandMeta = buildPropertyPayoutDispatchCommandMeta(command, provider, replay);
  await recordPropertyPayoutDispatchAuditEvent(client, command, keyHash, jobKey, provider);
  return {
    ok: true,
    status: replay ? "idempotent_replay" : "queued",
    job: commandMeta.jobs[0] as Extract<
      FinanceCommandMeta["jobs"][number],
      { jobType: "finance.dispatch-property-payout" }
    >,
    readiness,
    legacyDisposition: PROPERTY_PAYOUT_DISPATCH_LEGACY_DISPOSITION,
    rollbackRule: PROPERTY_PAYOUT_DISPATCH_ROLLBACK_RULE,
    commandMeta,
  };
}

async function updateAffiliatePayoutSettingsInClient(
  client: FinancePropertySettingsWriteClient,
  command: FinanceAffiliatePayoutSettingsPatchCommand,
): Promise<FinanceAffiliatePayoutSettingsPatchResult> {
  const affiliateResource = await resolveAffiliateResource(client, command.affiliateId);
  if (!affiliateResource) {
    return {
      ok: false,
      statusCode: 404,
      code: "affiliate_not_found",
      message: "Affiliate finance resource was not found.",
    };
  }

  const keyHash = sha256(command.idempotencyKey);
  const fingerprint = sha256(stableJson(command.payload));
  const requestedAt = command.audit.requestedAt;
  const idempotency = await client.query<FinanceIdempotencyRow & { inserted: boolean }>(
    `INSERT INTO platform.idempotency_keys (
       operation_scope,
       operation,
       key_hash,
       request_fingerprint_hash,
       status,
       tenant_scope,
       organization_id,
       property_id,
       correlation_id,
       response_status_code,
       response_resource_product,
       response_resource_type,
       response_resource_id,
       completed_at,
       first_seen_at,
       last_seen_at,
       expires_at,
       idempotency_metadata
     )
     VALUES (
       'finance',
       'affiliate_payout_settings_update',
       $1,
       $2,
       'completed',
       'organization',
       $3::uuid,
       NULL,
       $4,
       200,
       'finance',
       'affiliate_payout_settings',
       $6,
       $5::timestamptz,
       $5::timestamptz,
       $5::timestamptz,
       $5::timestamptz + interval '24 hours',
       $7::jsonb
     )
     ON CONFLICT (operation_scope, operation, key_hash, scope_key)
     DO UPDATE SET last_seen_at = EXCLUDED.last_seen_at
     RETURNING
       status,
       request_fingerprint_hash AS "requestFingerprintHash",
       (xmax = 0) AS inserted`,
    [
      keyHash,
      fingerprint,
      affiliateResource.organizationId,
      command.audit.correlationId ?? command.audit.requestId,
      requestedAt,
      command.affiliateId,
      JSON.stringify({
        commandId: command.commandId,
        idempotencyKey: command.idempotencyKey,
        affiliateId: command.affiliateId,
      }),
    ],
  );
  const idempotencyRow = idempotency.rows[0];
  if (
    idempotencyRow &&
    !idempotencyRow.inserted &&
    idempotencyRow.requestFingerprintHash !== fingerprint
  ) {
    return {
      ok: false,
      statusCode: 409,
      code: "idempotency_conflict",
      message:
        "Idempotency key was already used with a different affiliate payout settings payload.",
    };
  }
  if (idempotencyRow && !idempotencyRow.inserted) {
    const replaySettings = await loadAffiliatePayoutSettingsRow(
      client,
      command.affiliateId,
      affiliateResource.organizationId,
    );
    return {
      ok: true,
      status: "idempotent_replay",
      settings: replaySettings
        ? toAffiliatePayoutSettingsReadModel(replaySettings)
        : setupIncompleteAffiliatePayoutSettings(
            command.affiliateId,
            requestedAt,
            affiliateResource.organizationId,
            command.payload.payoutCurrency,
          ),
      commandMeta: buildAffiliatePayoutSettingsCommandMeta(command),
    };
  }

  await upsertAffiliatePayoutSettings(client, command, affiliateResource.organizationId);
  await recordAffiliatePayoutSettingsAuditEvent(
    client,
    command,
    affiliateResource.organizationId,
    keyHash,
  );
  const settingsRow = await loadAffiliatePayoutSettingsRow(
    client,
    command.affiliateId,
    affiliateResource.organizationId,
  );
  const settings = settingsRow
    ? toAffiliatePayoutSettingsReadModel(settingsRow)
    : setupIncompleteAffiliatePayoutSettings(
        command.affiliateId,
        requestedAt,
        affiliateResource.organizationId,
        command.payload.payoutCurrency,
      );
  return {
    ok: true,
    status: "updated",
    settings,
    commandMeta: buildAffiliatePayoutSettingsCommandMeta(command),
  };
}

async function upsertAffiliatePayoutSettings(
  client: FinancePropertySettingsWriteClient,
  command: FinanceAffiliatePayoutSettingsPatchCommand,
  organizationId: string,
): Promise<void> {
  const existing = await loadAffiliatePayoutSettingsRow(
    client,
    command.affiliateId,
    organizationId,
  );
  const current = existing
    ? toAffiliatePayoutSettingsReadModel(existing)
    : setupIncompleteAffiliatePayoutSettings(
        command.affiliateId,
        command.audit.requestedAt,
        organizationId,
        command.payload.payoutCurrency,
      );
  const nextProvider = command.payload.payoutProvider ?? current.payoutProvider;
  const nextCurrency = command.payload.payoutCurrency ?? current.payoutCurrency;
  const nextSchedule = command.payload.payoutSchedule ?? current.payoutSchedule;
  const nextThreshold =
    command.payload.payoutThresholdAmount !== undefined
      ? command.payload.payoutThresholdAmount
      : current.payoutThresholdAmount;
  const nextEnabled = command.payload.payoutsEnabled ?? current.payoutsEnabled;

  await client.query(
    `WITH existing AS (
       SELECT id
       FROM finance.payout_settings
       WHERE owner_scope = 'organization'
         AND organization_id = $1::uuid
         AND payout_preferences ->> 'affiliateId' = $8
       ORDER BY updated_at DESC, id
       LIMIT 1
     ),
     updated AS (
       UPDATE finance.payout_settings settings
       SET payout_method = $2,
           default_currency = $3,
           status = $4,
           schedule = $5::jsonb,
           payout_preferences = payout_preferences || $6::jsonb,
           source_system = 'finance',
           updated_at = $7::timestamptz
       FROM existing
       WHERE settings.id = existing.id
       RETURNING settings.id
     )
     INSERT INTO finance.payout_settings (
       organization_id,
       owner_scope,
       payout_method,
       default_currency,
       status,
       schedule,
       payout_preferences,
       source_system,
       created_at,
       updated_at
     )
     SELECT
       $1::uuid,
       'organization',
       $2,
       $3,
       $4,
       $5::jsonb,
       $6::jsonb,
       'finance',
       $7::timestamptz,
       $7::timestamptz
     WHERE NOT EXISTS (SELECT 1 FROM updated)`,
    [
      organizationId,
      payoutMethodValue(nextProvider),
      nextCurrency,
      nextEnabled ? "active" : "paused",
      JSON.stringify({
        type: nextSchedule,
        thresholdAmount: nextThreshold,
      }),
      JSON.stringify({
        payoutsEnabled: nextEnabled,
        affiliateId: command.affiliateId,
        updatedByCommandId: command.commandId,
      }),
      command.audit.requestedAt,
      command.affiliateId,
    ],
  );
}

async function recordAffiliatePayoutSettingsAuditEvent(
  client: FinancePropertySettingsWriteClient,
  command: FinanceAffiliatePayoutSettingsPatchCommand,
  organizationId: string,
  keyHash: string,
): Promise<void> {
  await client.query(
    `INSERT INTO platform.product_audit_events (
       audit_key,
       product,
       action,
       action_version,
       occurred_at,
       tenant_scope,
       organization_id,
       property_id,
       actor_type,
       actor_user_id,
       target_resource_product,
       target_resource_type,
       target_resource_id,
       correlation_id,
       causation_id,
       redacted_payload,
       private_payload,
       audit_metadata,
       retention_class,
       privacy_scope
     )
     VALUES (
       $1,
       'finance',
       'finance.affiliate_payout_settings.updated',
       1,
       $2::timestamptz,
       'organization',
       $3::uuid,
       NULL,
       $4,
       $5::uuid,
       'finance',
       'affiliate_payout_settings',
       $6,
       $7,
       $8,
       $9::jsonb,
       '{}'::jsonb,
       $10::jsonb,
       'financial',
       'confidential'
     )
     ON CONFLICT (product, audit_key) DO NOTHING`,
    [
      `finance.affiliate-payout-settings.audit.affiliate.${command.affiliateId}.key.${keyHash}.v1`,
      command.audit.requestedAt,
      organizationId,
      command.audit.actor.kind,
      command.audit.actor.kind === "user" ? command.audit.actor.userId : null,
      command.affiliateId,
      command.audit.correlationId ?? command.audit.requestId,
      command.commandId,
      JSON.stringify({
        affiliateId: command.affiliateId,
        changedFields: Object.keys(command.payload).sort(),
      }),
      JSON.stringify({
        contractVersion: FINANCE_ROUTE_CONTRACT_VERSION,
        ownershipBoundary: {
          affiliateIdentityOwner: "marketplace/affiliate",
          providerAccountOwner: "finance",
          settlementOwner: "finance",
        },
      }),
    ],
  );
}

async function loadPropertyPayoutDispatchReadiness(
  client: FinancePropertySettingsWriteClient,
  command: FinancePropertyPayoutDispatchCommand,
): Promise<FinancePropertyPayoutDispatchReadiness | null> {
  const result = await client.query<FinancePropertyPayoutDispatchReadinessRow>(
    `SELECT
       payout.id::text AS "payoutId",
       account.provider,
       payout.provider_payout_id AS "providerPayoutId",
       payout.payout_metadata ->> 'reconciliationReadyAt' AS "reconciliationReadyAt",
       payout.payout_metadata ->> 'legacyPropertyPayoutSchedulerFrozenAt'
         AS "legacySchedulerFrozenAt",
       COALESCE(reconciliation.blockers, 0)::int AS "reconciliationBlockers",
       COALESCE((payout.payout_metadata ->> 'activeLegacyTransferWindow')::boolean, false)
         AS "activeLegacyTransferWindow"
     FROM finance.payouts payout
     LEFT JOIN finance.payment_provider_accounts account
       ON account.id = payout.property_provider_account_id
      AND account.property_id = payout.property_id
      AND account.account_scope = 'property'
     LEFT JOIN LATERAL (
       SELECT COUNT(*) AS blockers
       FROM platform.jobs job
       WHERE job.tenant_scope = 'property'
         AND job.property_id = payout.property_id
         AND job.resource_product = 'finance'
         AND job.resource_type = 'payout'
         AND job.resource_id IN (
           payout.id::text,
           COALESCE(payout.provider_payout_id, ''),
           payout.property_id::text
         )
         AND job.job_type = 'finance.reconcile-payout'
         AND job.status IN ('pending', 'running', 'failed', 'dead_lettered')
     ) reconciliation ON TRUE
     WHERE payout.property_id = $1::uuid
       AND (
         payout.id = CASE
           WHEN $2::text ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
             THEN $2::uuid
           ELSE NULL
         END
         OR payout.source_payout_id = $2::text
         OR payout.payout_metadata ->> 'payoutId' = $2::text
       )
       AND payout.owner_scope = 'property'
     LIMIT 1`,
    [command.propertyId, command.payload.payoutId],
  );
  const row = result.rows[0];
  if (!row) return null;
  const reconciliationBlockers = Number(row.reconciliationBlockers);
  const targetReconciliationReadyAt = utcEvidenceString(row.reconciliationReadyAt);
  const targetLegacySchedulerFrozenAt = utcEvidenceString(row.legacySchedulerFrozenAt);
  const reconciliationReady =
    Boolean(targetReconciliationReadyAt) &&
    targetReconciliationReadyAt! <= command.payload.reconciliationReadyAt &&
    command.payload.reconciliationReadyAt <= command.audit.requestedAt &&
    reconciliationBlockers === 0;
  const legacySchedulerFrozen =
    Boolean(targetLegacySchedulerFrozenAt) &&
    targetLegacySchedulerFrozenAt! <= command.payload.legacySchedulerFrozenAt &&
    command.payload.legacySchedulerFrozenAt <= command.audit.requestedAt;
  const blockingReasons = [
    ...(!reconciliationReady ? ["reconciliation_not_ready"] : []),
    ...(!legacySchedulerFrozen ? ["legacy_scheduler_not_frozen"] : []),
    ...(row.activeLegacyTransferWindow ? ["active_legacy_transfer_window"] : []),
    ...(row.providerPayoutId ? ["payout_already_dispatched"] : []),
  ];
  return {
    payoutId: row.payoutId,
    reconciliationReady,
    legacySchedulerFrozen,
    activeLegacyTransferWindow: Boolean(row.activeLegacyTransferWindow),
    existingProviderPayoutId: row.providerPayoutId,
    provider: row.provider === "stripe" || row.provider === "xendit" ? row.provider : null,
    blockingReasons,
  };
}

function propertyPayoutDispatchBlocker(
  readiness: FinancePropertyPayoutDispatchReadiness,
): Extract<FinancePropertyPayoutDispatchResult, { ok: false }> | null {
  if (!readiness.reconciliationReady) {
    return {
      ok: false,
      statusCode: 409,
      code: "reconciliation_not_ready",
      message: "Property payout dispatch is blocked until payout reconciliation is ready.",
    };
  }
  if (!readiness.legacySchedulerFrozen) {
    return {
      ok: false,
      statusCode: 409,
      code: "legacy_scheduler_not_frozen",
      message:
        "Property payout dispatch is blocked until legacy process_property_payouts is frozen.",
    };
  }
  if (readiness.activeLegacyTransferWindow) {
    return {
      ok: false,
      statusCode: 409,
      code: "active_legacy_transfer_window",
      message: "Property payout dispatch is blocked by an active legacy transfer window.",
    };
  }
  if (readiness.existingProviderPayoutId) {
    return {
      ok: false,
      statusCode: 409,
      code: "payout_already_dispatched",
      message: "Property payout already has a provider payout id.",
    };
  }
  return null;
}

async function recordPropertyPayoutDispatchAuditEvent(
  client: FinancePropertySettingsWriteClient,
  command: FinancePropertyPayoutDispatchCommand,
  keyHash: string,
  jobKey: string,
  provider: "stripe" | "xendit",
): Promise<void> {
  await client.query(
    `INSERT INTO platform.product_audit_events (
       audit_key,
       product,
       action,
       action_version,
       occurred_at,
       tenant_scope,
       organization_id,
       property_id,
       actor_type,
       actor_user_id,
       target_resource_product,
       target_resource_type,
       target_resource_id,
       correlation_id,
       causation_id,
       redacted_payload,
       private_payload,
       audit_metadata,
       retention_class,
       privacy_scope
     )
     VALUES (
       $1,
       'finance',
       'finance.property_payout.dispatch_requested',
       1,
       $2::timestamptz,
       'property',
       NULL,
       $3::uuid,
       $4,
       $5::uuid,
       'finance',
       'payout',
       $6,
       $7,
       $8,
       $9::jsonb,
       '{}'::jsonb,
       $10::jsonb,
       'financial',
       'confidential'
     )
     ON CONFLICT (product, audit_key) DO NOTHING`,
    [
      `finance.property-payout-dispatch.audit.property.${command.propertyId}.payout.${command.payload.payoutId}.key.${keyHash}.v1`,
      command.audit.requestedAt,
      command.propertyId,
      command.audit.actor.kind,
      command.audit.actor.kind === "user" ? command.audit.actor.userId : null,
      command.payload.payoutId,
      command.audit.correlationId ?? command.audit.requestId,
      command.commandId,
      JSON.stringify({
        propertyId: command.propertyId,
        payoutId: command.payload.payoutId,
        provider,
        jobKey,
      }),
      JSON.stringify({
        contractVersion: FINANCE_ROUTE_CONTRACT_VERSION,
        legacyDisposition: PROPERTY_PAYOUT_DISPATCH_LEGACY_DISPOSITION,
        rollbackRule: PROPERTY_PAYOUT_DISPATCH_ROLLBACK_RULE,
      }),
    ],
  );
}

function buildXenditPayoutReconciliationCommandMeta(
  command: FinanceXenditPayoutReconciliationCommand,
  replay: boolean,
): FinanceCommandMeta {
  return {
    commandId: command.commandId,
    idempotencyKey: command.idempotencyKey,
    sideEffects: [...XENDIT_PAYOUT_RECONCILIATION_SIDE_EFFECTS],
    outboxEvents: [],
    jobs: [
      {
        jobType: "finance.reconcile-payout",
        idempotencyKey: buildXenditPayoutReconciliationJobKey(command),
        status: replay ? "idempotent_replay" : "queued",
      },
    ],
  };
}

function buildXenditPayoutReconciliationJobKey(
  command: FinanceXenditPayoutReconciliationCommand,
): string {
  return `finance.reconcile-payout:property:${command.propertyId}:xendit-manual-${xenditPayoutReconciliationWindow(command)}:v1`;
}

function buildPropertyPayoutDispatchCommandMeta(
  command: FinancePropertyPayoutDispatchCommand,
  provider: "stripe" | "xendit",
  replay: boolean,
): FinanceCommandMeta {
  return {
    commandId: command.commandId,
    idempotencyKey: command.idempotencyKey,
    sideEffects: [...PROPERTY_PAYOUT_DISPATCH_SIDE_EFFECTS],
    outboxEvents: [],
    jobs: [
      {
        jobType: "finance.dispatch-property-payout",
        payoutId: command.payload.payoutId,
        provider,
        idempotencyKey: buildPropertyPayoutDispatchJobKey(command),
        status: replay ? "idempotent_replay" : "queued",
      },
    ],
  };
}

function buildPropertyPayoutDispatchJobKey(command: FinancePropertyPayoutDispatchCommand): string {
  return `finance.dispatch-property-payout:property:${command.propertyId}:payout:${command.payload.payoutId}:v1`;
}

function buildAffiliatePayoutSettingsCommandMeta(
  command: FinanceAffiliatePayoutSettingsPatchCommand,
): FinanceCommandMeta {
  return {
    commandId: command.commandId,
    idempotencyKey: command.idempotencyKey,
    sideEffects: [...AFFILIATE_PAYOUT_SETTINGS_SIDE_EFFECTS],
    outboxEvents: [],
    jobs: [],
  };
}

function xenditPayoutReconciliationWindow(
  command: FinanceXenditPayoutReconciliationCommand,
): string {
  const dateMatch = /\b\d{4}-\d{2}-\d{2}\b/.exec(command.idempotencyKey);
  if (dateMatch) return dateMatch[0];
  return `key-${sha256(command.idempotencyKey).slice(0, 12)}`;
}

async function recordXenditPayoutReconciliationAuditEvent(
  client: FinancePropertySettingsWriteClient,
  command: FinanceXenditPayoutReconciliationCommand,
  keyHash: string,
  jobKey: string,
  recordedAt: string,
): Promise<void> {
  await client.query(
    `INSERT INTO platform.product_audit_events (
       audit_key,
       product,
       action,
       action_version,
       occurred_at,
       tenant_scope,
       organization_id,
       property_id,
       actor_type,
       actor_user_id,
       target_resource_product,
       target_resource_type,
       target_resource_id,
       correlation_id,
       causation_id,
       payload,
       audit_metadata,
       privacy_scope
     )
     VALUES (
       $1,
       'finance',
       'finance.xendit_payouts.reconcile_requested',
       1,
       $2::timestamptz,
       'property',
       NULL,
       $3::uuid,
       $4,
       $5::uuid,
       'finance',
       'payout',
       $3,
       $6,
       $7,
       $8::jsonb,
       $9::jsonb,
       'confidential'
     )
     ON CONFLICT (product, audit_key) DO NOTHING`,
    [
      `finance.xendit-payout-reconciliation.audit.property.${command.propertyId}.key.${keyHash}.v1`,
      recordedAt,
      command.propertyId,
      command.audit.actor.kind,
      command.audit.actor.kind === "user" ? command.audit.actor.userId : null,
      command.audit.correlationId ?? command.audit.requestId,
      command.commandId,
      JSON.stringify({
        propertyId: command.propertyId,
        provider: "xendit",
        olderThanMinutes: command.payload.olderThanMinutes,
        jobKey,
      }),
      JSON.stringify({
        contractVersion: FINANCE_ROUTE_CONTRACT_VERSION,
        legacyDisposition: XENDIT_PAYOUT_RECONCILIATION_LEGACY_DISPOSITION,
      }),
    ],
  );
}

async function loadPaymentSettingsRow(
  pool: FinanceQueryExecutor,
  propertyId: string,
): Promise<FinancePaymentSettingsRow | null> {
  const result = await pool.query<FinancePaymentSettingsRow>(
    `SELECT
       property.id::text AS "propertyId",
       COALESCE(settings.payments_enabled, FALSE) AS "paymentsEnabled",
       COALESCE(settings.accepted_methods, ARRAY[]::text[]) AS "acceptedMethods",
       COALESCE(booking_settings.default_currency, settings.default_currency, 'EUR') AS "defaultCurrency",
       COALESCE(settings.deposit_policy, '{}'::jsonb) AS "depositPolicy",
       COALESCE(settings.refund_policy, '{}'::jsonb) AS "refundPolicy",
       COALESCE(settings.tax_policy, '{}'::jsonb) AS "taxPolicy",
       settings.statement_descriptor AS "statementDescriptor",
       COALESCE(settings.requires_manual_review, TRUE) AS "requiresManualReview",
       COALESCE(settings.updated_at, booking_settings.updated_at, property.updated_at) AS "updatedAt",
       account.provider_account_id AS "providerAccountId",
       account.provider,
       account.status AS "providerStatus",
       account.onboarding_status AS "providerOnboardingStatus",
       account.charges_enabled AS "chargesEnabled",
       account.payouts_enabled AS "payoutsEnabled",
       account.capabilities AS "providerCapabilities"
     FROM hotel_catalog.properties property
     LEFT JOIN finance.payment_settings settings
       ON settings.property_id = property.id
     LEFT JOIN booking.booking_settings booking_settings
       ON booking_settings.property_id = property.id
     LEFT JOIN finance.payment_provider_accounts account
       ON account.id = settings.provider_account_id
      AND account.property_id = settings.property_id
      AND account.account_scope = 'property'
     WHERE property.id = $1::uuid
     LIMIT 1`,
    [propertyId],
  );
  return result.rows[0] ?? null;
}

async function resolveAffiliateResource(
  pool: FinanceQueryExecutor,
  affiliateId: string,
): Promise<FinanceAffiliateResourceRow | null> {
  const result = await pool.query<FinanceAffiliateResourceRow>(
    `SELECT link.organization_id::text AS "organizationId"
     FROM identity.organization_resource_links link
     JOIN identity.organizations organization
       ON organization.id = link.organization_id
      AND organization.kind = 'affiliate_partner'
      AND organization.status = 'active'
     WHERE link.product = 'affiliate'
       AND link.resource_type = 'affiliate'
       AND link.resource_id = $1
       AND link.status = 'active'
     ORDER BY link.updated_at DESC
     LIMIT 1`,
    [affiliateId],
  );
  return result.rows[0] ?? null;
}

async function loadAffiliatePayoutSettingsRow(
  pool: FinanceQueryExecutor,
  affiliateId: string,
  organizationId?: string,
): Promise<FinanceAffiliatePayoutSettingsRow | null> {
  const result = await pool.query<FinanceAffiliatePayoutSettingsRow>(
    `SELECT
       link.resource_id AS "affiliateId",
       link.organization_id::text AS "marketplaceOrganizationId",
       settings.status = 'active' AS "payoutsEnabled",
       settings.payout_method AS "payoutProvider",
       settings.default_currency AS "payoutCurrency",
       settings.schedule AS "payoutSchedule",
       settings.payout_preferences AS "payoutPreferences",
       settings.schedule ->> 'thresholdAmount' AS "payoutThresholdAmount",
       settings.updated_at AS "updatedAt",
       account.provider_account_id AS "providerAccountId",
       account.provider,
       account.status AS "providerStatus",
       account.onboarding_status AS "providerOnboardingStatus",
       account.payouts_enabled AS "providerPayoutsEnabled",
       COALESCE(visibility.source_freshness, '{}'::jsonb) AS "sourceFreshness"
     FROM identity.organization_resource_links link
     JOIN identity.organizations organization
       ON organization.id = link.organization_id
      AND organization.kind = 'affiliate_partner'
      AND organization.status = 'active'
     LEFT JOIN finance.payout_settings settings
       ON settings.organization_id = link.organization_id
      AND settings.owner_scope = 'organization'
      AND settings.payout_preferences ->> 'affiliateId' = link.resource_id
     LEFT JOIN finance.payment_provider_accounts account
       ON account.id = settings.organization_provider_account_id
      AND account.organization_id = settings.organization_id
      AND account.account_scope = 'organization'
     LEFT JOIN LATERAL (
       SELECT source_freshness
       FROM finance.finance_visibility_read_model visibility
       WHERE visibility.organization_id = link.organization_id
         AND visibility.visibility_scope = 'affiliate_payout'
         AND visibility.resource_type = 'affiliate'
         AND visibility.resource_id = link.resource_id
         AND visibility.required_permission_key = 'affiliate.payout.manage'
       ORDER BY visibility.projected_at DESC
       LIMIT 1
     ) visibility ON TRUE
     WHERE link.product = 'affiliate'
       AND link.resource_type = 'affiliate'
       AND link.resource_id = $1
       AND ($2::uuid IS NULL OR link.organization_id = $2::uuid)
       AND link.status = 'active'
     ORDER BY settings.updated_at DESC NULLS LAST
     LIMIT 1`,
    [affiliateId, organizationId ?? null],
  );
  return result.rows[0] ?? null;
}

async function loadPayoutRows(
  pool: FinanceQueryExecutor,
  propertyId: string,
  query: FinancePayoutListQuery,
): Promise<FinanceRowsWithTotal<FinancePayoutRow>> {
  const result = await pool.query<FinancePayoutRow>(
    `WITH payout_base AS (
       SELECT
         payout.id::text AS "payoutId",
         payout.owner_scope AS "ownerScope",
         payout.property_id::text AS "propertyId",
         payout.organization_id::text AS "organizationId",
         payout.related_property_id::text AS "relatedPropertyId",
         payout.guest_booking_id::text AS "guestBookingId",
         payout.payment_id::text AS "paymentId",
         payout.payout_status AS "payoutStatus",
         payout.amount::text AS amount,
         payout.fee_amount::text AS "feeAmount",
         payout.net_amount::text AS "netAmount",
         payout.currency,
         COALESCE(account.provider, 'manual') AS provider,
         payout.provider_payout_id AS "providerPayoutId",
         payout.scheduled_at AS "scheduledAt",
         payout.paid_at AS "paidAt",
         payout.failed_at AS "failedAt",
         payout.failure_code AS "failureCode",
         payout.retry_count AS "retryCount",
         COALESCE(visibility.source_freshness, '{}'::jsonb) AS "sourceFreshness",
         COALESCE(payout.scheduled_at, payout.paid_at, payout.failed_at, payout.created_at) AS "sortAt"
       FROM finance.payouts payout
       LEFT JOIN finance.payment_provider_accounts account
         ON account.id = payout.property_provider_account_id
        AND account.property_id = payout.property_id
       LEFT JOIN LATERAL (
         SELECT source_freshness
         FROM finance.finance_visibility_read_model visibility
         WHERE visibility.property_id = payout.property_id
           AND visibility.visibility_scope = 'property_finance'
           AND visibility.required_permission_key = 'pms.finance.read'
         ORDER BY visibility.projected_at DESC
         LIMIT 1
       ) visibility ON TRUE
       WHERE payout.property_id = $1::uuid
         AND payout.owner_scope = 'property'
     ),
     filtered AS (
       SELECT *
       FROM payout_base
       WHERE ($2::text IS NULL OR "payoutStatus" = $2::text)
         AND ($3::text IS NULL OR provider = $3::text)
	     ),
	     total_count AS (
	       SELECT count(*)::text AS total
	       FROM filtered
	     ),
	     page AS (
	       SELECT *
	       FROM filtered
	       ORDER BY "sortAt" DESC, "payoutId" ASC
	       LIMIT $4::integer OFFSET $5::integer
	     )
	     SELECT
	       page.*,
	       total_count.total
	     FROM page
	     CROSS JOIN total_count`,
    [propertyId, query.status ?? null, query.provider ?? null, query.limit, query.offset],
  );
  return {
    rows: result.rows,
    total: await totalForPossiblyEmptyPage(pool, result.rows, query.offset, {
      sql: payoutTotalSql(),
      values: [propertyId, query.status ?? null, query.provider ?? null],
    }),
  };
}

async function loadAffiliatePayoutRows(
  pool: FinanceQueryExecutor,
  affiliateId: string,
  organizationId: string,
  query: FinancePayoutListQuery,
): Promise<FinanceRowsWithTotal<FinancePayoutRow>> {
  const result = await pool.query<FinancePayoutRow>(
    `WITH payout_base AS (
       SELECT
         payout.id::text AS "payoutId",
         payout.owner_scope AS "ownerScope",
         payout.property_id::text AS "propertyId",
         payout.organization_id::text AS "organizationId",
         payout.related_property_id::text AS "relatedPropertyId",
         payout.guest_booking_id::text AS "guestBookingId",
         payout.payment_id::text AS "paymentId",
         payout.payout_status AS "payoutStatus",
         payout.amount::text AS amount,
         payout.fee_amount::text AS "feeAmount",
         payout.net_amount::text AS "netAmount",
         payout.currency,
         COALESCE(account.provider, 'manual') AS provider,
         payout.provider_payout_id AS "providerPayoutId",
         payout.scheduled_at AS "scheduledAt",
         payout.paid_at AS "paidAt",
         payout.failed_at AS "failedAt",
         payout.failure_code AS "failureCode",
         payout.retry_count AS "retryCount",
         COALESCE(visibility.source_freshness, '{}'::jsonb) AS "sourceFreshness",
         COALESCE(payout.scheduled_at, payout.paid_at, payout.failed_at, payout.created_at) AS "sortAt"
       FROM finance.payouts payout
       LEFT JOIN finance.payment_provider_accounts account
         ON account.id = payout.organization_provider_account_id
        AND account.organization_id = payout.organization_id
        AND account.account_scope = 'organization'
       LEFT JOIN LATERAL (
         SELECT source_freshness
         FROM finance.finance_visibility_read_model visibility
         WHERE visibility.organization_id = payout.organization_id
           AND visibility.visibility_scope = 'affiliate_payout'
           AND visibility.resource_type = 'affiliate'
           AND visibility.resource_id = $1
           AND visibility.required_permission_key = 'affiliate.payout.manage'
         ORDER BY visibility.projected_at DESC
         LIMIT 1
       ) visibility ON TRUE
       WHERE payout.organization_id = $2::uuid
         AND payout.owner_scope = 'organization'
         AND COALESCE(payout.payout_metadata ->> 'affiliateId', payout.payout_metadata ->> 'affiliate_id') = $1
     ),
     filtered AS (
       SELECT *
       FROM payout_base
       WHERE ($3::text IS NULL OR "payoutStatus" = $3::text)
         AND ($4::text IS NULL OR provider = $4::text)
     ),
     total_count AS (
       SELECT count(*)::text AS total
       FROM filtered
     ),
     page AS (
       SELECT *
       FROM filtered
       ORDER BY "sortAt" DESC, "payoutId" ASC
       LIMIT $5::integer OFFSET $6::integer
     )
     SELECT
       page.*,
       total_count.total
     FROM page
     CROSS JOIN total_count`,
    [
      affiliateId,
      organizationId,
      query.status ?? null,
      query.provider ?? null,
      query.limit,
      query.offset,
    ],
  );
  return {
    rows: result.rows,
    total: await totalForPossiblyEmptyPage(pool, result.rows, query.offset, {
      sql: affiliatePayoutTotalSql(),
      values: [affiliateId, organizationId, query.status ?? null, query.provider ?? null],
    }),
  };
}

async function loadReconciliationRows(
  pool: FinanceQueryExecutor,
  propertyId: string,
  view: FinanceReconciliationViewKind,
  query: FinanceReconciliationViewQuery,
): Promise<FinanceRowsWithTotal<FinanceReconciliationRow>> {
  const sql = reconciliationViewSql(view);
  const result = await pool.query<FinanceReconciliationRow>(sql, [
    propertyId,
    query.status ?? null,
    query.provider ?? null,
    query.limit,
    query.offset,
  ]);
  return {
    rows: result.rows,
    total: await totalForPossiblyEmptyPage(pool, result.rows, query.offset, {
      sql: reconciliationTotalSql(view),
      values: [propertyId, query.status ?? null, query.provider ?? null],
    }),
  };
}

function affiliatePayoutTotalSql(): string {
  return `WITH payout_base AS (
       SELECT
         payout.payout_status AS "payoutStatus",
         COALESCE(account.provider, 'manual') AS provider
       FROM finance.payouts payout
       LEFT JOIN finance.payment_provider_accounts account
         ON account.id = payout.organization_provider_account_id
        AND account.organization_id = payout.organization_id
        AND account.account_scope = 'organization'
       WHERE payout.organization_id = $2::uuid
         AND payout.owner_scope = 'organization'
         AND COALESCE(payout.payout_metadata ->> 'affiliateId', payout.payout_metadata ->> 'affiliate_id') = $1
     ),
     filtered AS (
       SELECT *
       FROM payout_base
       WHERE ($3::text IS NULL OR "payoutStatus" = $3::text)
         AND ($4::text IS NULL OR provider = $4::text)
     )
     SELECT count(*)::text AS total
     FROM filtered`;
}

function payoutTotalSql(): string {
  return `WITH payout_base AS (
       SELECT
         payout.id::text AS "payoutId",
         payout.payout_status AS "payoutStatus",
         COALESCE(account.provider, 'manual') AS provider
       FROM finance.payouts payout
       LEFT JOIN finance.payment_provider_accounts account
         ON account.id = payout.property_provider_account_id
        AND account.property_id = payout.property_id
       WHERE payout.property_id = $1::uuid
         AND payout.owner_scope = 'property'
     ),
     filtered AS (
       SELECT *
       FROM payout_base
       WHERE ($2::text IS NULL OR "payoutStatus" = $2::text)
         AND ($3::text IS NULL OR provider = $3::text)
     )
     SELECT count(*)::text AS total
     FROM filtered`;
}

function reconciliationTotalSql(view: FinanceReconciliationViewKind): string {
  return reconciliationViewSql(view, "total");
}

function reconciliationViewSql(
  view: FinanceReconciliationViewKind,
  mode: "page" | "total" = "page",
): string {
  switch (view) {
    case "payments":
      return reconciliationPaymentSql(mode);
    case "payouts":
      return reconciliationPayoutSql(mode);
    case "provider-accounts":
      return reconciliationProviderAccountSql(mode);
  }
}

function reconciliationPaymentSql(mode: "page" | "total"): string {
  return `WITH base AS (
       SELECT
         payment.id::text AS "subjectId",
         'payment' AS "subjectType",
         COALESCE(
           account.provider,
           CASE
             WHEN payment.payment_method = 'bank_transfer' THEN 'bank_transfer'
             WHEN payment.payment_method IN ('cash', 'manual_card', 'other', 'unknown') THEN 'manual'
             ELSE 'vayada'
           END
         ) AS provider,
         payment.status AS "financeStatus",
         COALESCE(payment.payment_metadata ->> 'providerStatus', payment.status) AS "providerStatus",
         receipt.delivery_status AS "receiptStatus",
         receipt.received_at AS "lastReceiptAt",
         job.status AS "rawJobStatus",
         COALESCE(job.finished_at, job.run_after, job.created_at) AS "lastJobAt",
         dead.created_at AS "deadLetteredAt"
       FROM finance.payments payment
       LEFT JOIN finance.payment_provider_accounts account
         ON account.id = payment.provider_account_id
        AND account.property_id = payment.property_id
	       LEFT JOIN LATERAL (
	         SELECT receipt.delivery_status, receipt.received_at
	         FROM platform.external_webhook_events receipt
	         JOIN platform.domain_events receipt_event
	           ON receipt_event.id = receipt.normalized_domain_event_id
	          AND receipt_event.source_system = 'external'
	          AND receipt_event.resource_product = 'finance'
	          AND receipt_event.resource_type = 'payment'
	         WHERE receipt.provider = COALESCE(account.provider, 'stripe')
	           AND receipt_event.resource_id IN (
	             payment.provider_transaction_id,
	             payment.provider_payment_intent_id
	           )
	         ORDER BY receipt.received_at DESC
	         LIMIT 1
	       ) receipt ON TRUE
	       LEFT JOIN LATERAL (
	         SELECT job.id, job.status, job.finished_at, job.run_after, job.created_at
	         FROM platform.jobs job
	         LEFT JOIN platform.domain_events job_event
	           ON job_event.id = job.source_domain_event_id
	          AND job_event.source_system = 'external'
	          AND job_event.resource_product = 'finance'
	          AND job_event.resource_type = 'payment'
	         WHERE job.resource_product = 'finance'
	           AND (
	             (
	               job.property_id = payment.property_id
	               AND job.resource_type = 'payment'
	               AND job.resource_id = payment.id::text
	             )
	             OR (
	               job.tenant_scope = 'external'
	               AND job.resource_type = 'payment'
	               AND job.resource_id IN (
	                 payment.provider_transaction_id,
	                 payment.provider_payment_intent_id
	               )
	             )
	             OR job_event.resource_id IN (
	               payment.provider_transaction_id,
	               payment.provider_payment_intent_id
	             )
	             OR job.job_key LIKE ('payment.reconcile-status:payment:' || payment.id::text || ':%')
	             OR (
	               payment.provider_transaction_id IS NOT NULL
	               AND job.job_key LIKE ('payment.reconcile-status:payment:' || payment.provider_transaction_id || ':%')
	             )
	             OR (
	               payment.provider_payment_intent_id IS NOT NULL
	               AND job.job_key LIKE ('payment.reconcile-status:payment:' || payment.provider_payment_intent_id || ':%')
	             )
	           )
	         ORDER BY job.created_at DESC
	         LIMIT 1
	       ) job ON TRUE
	       LEFT JOIN LATERAL (
	         SELECT dead.created_at
	         FROM platform.dead_letter_events dead
	         LEFT JOIN platform.jobs dead_job
	           ON dead_job.id = dead.job_id
	         LEFT JOIN platform.domain_events dead_domain_event
	           ON dead_domain_event.id = dead.domain_event_id
	         LEFT JOIN platform.domain_events dead_job_event
	           ON dead_job_event.id = dead_job.source_domain_event_id
	         LEFT JOIN platform.external_webhook_events dead_receipt
	           ON dead_receipt.id = dead.webhook_event_id
	         LEFT JOIN platform.domain_events dead_receipt_event
	           ON dead_receipt_event.id = dead_receipt.normalized_domain_event_id
	         WHERE dead.resource_product = 'finance'
	           AND (
	             (
	               dead.property_id = payment.property_id
	               AND dead.resource_type = 'payment'
	               AND dead.resource_id = payment.id::text
	             )
	             OR dead.job_id = job.id
	             OR (
	               dead.resource_type = 'payment'
	               AND dead.resource_id IN (
	                 payment.provider_transaction_id,
	                 payment.provider_payment_intent_id
	               )
	             )
	             OR dead_domain_event.resource_id IN (
	               payment.provider_transaction_id,
	               payment.provider_payment_intent_id
	             )
	             OR dead_job_event.resource_id IN (
	               payment.provider_transaction_id,
	               payment.provider_payment_intent_id
	             )
	             OR dead_receipt_event.resource_id IN (
	               payment.provider_transaction_id,
	               payment.provider_payment_intent_id
	             )
	           )
	         ORDER BY dead.created_at DESC
	         LIMIT 1
	       ) dead ON TRUE
       WHERE payment.property_id = $1::uuid
         AND payment.visibility_class IN ('pms_finance', 'migration')
     ),
     mapped AS (
       ${reconciliationMappedSelect()}
       FROM base
     ),
     filtered AS (
       ${reconciliationFilteredSelect()}
     )
	     ${reconciliationFinalSelect(mode)}`;
}

function reconciliationPayoutSql(mode: "page" | "total"): string {
  return `WITH base AS (
       SELECT
         payout.id::text AS "subjectId",
         'payout' AS "subjectType",
         COALESCE(account.provider, 'manual') AS provider,
         payout.payout_status AS "financeStatus",
         COALESCE(payout.payout_metadata ->> 'providerStatus', payout.payout_status) AS "providerStatus",
         receipt.delivery_status AS "receiptStatus",
         receipt.received_at AS "lastReceiptAt",
         job.status AS "rawJobStatus",
         COALESCE(job.finished_at, job.run_after, job.created_at) AS "lastJobAt",
         dead.created_at AS "deadLetteredAt"
       FROM finance.payouts payout
       LEFT JOIN finance.payment_provider_accounts account
         ON account.id = payout.property_provider_account_id
        AND account.property_id = payout.property_id
	       LEFT JOIN LATERAL (
	         SELECT receipt.delivery_status, receipt.received_at
	         FROM platform.external_webhook_events receipt
	         JOIN platform.domain_events receipt_event
	           ON receipt_event.id = receipt.normalized_domain_event_id
	          AND receipt_event.source_system = 'external'
	          AND receipt_event.resource_product = 'finance'
	          AND receipt_event.resource_type = 'payout'
	         WHERE receipt.provider = COALESCE(account.provider, 'stripe')
	           AND receipt_event.resource_id = payout.provider_payout_id
	         ORDER BY receipt.received_at DESC
	         LIMIT 1
	       ) receipt ON TRUE
	       LEFT JOIN LATERAL (
	         SELECT job.id, job.status, job.finished_at, job.run_after, job.created_at
	         FROM platform.jobs job
	         LEFT JOIN platform.domain_events job_event
	           ON job_event.id = job.source_domain_event_id
	          AND job_event.source_system = 'external'
	          AND job_event.resource_product = 'finance'
	          AND job_event.resource_type = 'payout'
	         WHERE job.resource_product = 'finance'
	           AND (
	             (
	               job.property_id = payout.property_id
	               AND job.resource_type = 'payout'
	               AND job.resource_id = payout.id::text
	             )
	             OR (
	               job.tenant_scope = 'external'
	               AND job.resource_type = 'payout'
	               AND job.resource_id = payout.provider_payout_id
	             )
	             OR job_event.resource_id = payout.provider_payout_id
	             OR job.job_key LIKE ('finance.reconcile-payout:payout:' || payout.id::text || ':%')
	             OR (
	               payout.provider_payout_id IS NOT NULL
               AND job.job_key LIKE ('finance.reconcile-payout:payout:' || payout.provider_payout_id || ':%')
             )
           )
         ORDER BY job.created_at DESC
         LIMIT 1
	       ) job ON TRUE
	       LEFT JOIN LATERAL (
	         SELECT dead.created_at
	         FROM platform.dead_letter_events dead
	         LEFT JOIN platform.jobs dead_job
	           ON dead_job.id = dead.job_id
	         LEFT JOIN platform.domain_events dead_domain_event
	           ON dead_domain_event.id = dead.domain_event_id
	         LEFT JOIN platform.domain_events dead_job_event
	           ON dead_job_event.id = dead_job.source_domain_event_id
	         LEFT JOIN platform.external_webhook_events dead_receipt
	           ON dead_receipt.id = dead.webhook_event_id
	         LEFT JOIN platform.domain_events dead_receipt_event
	           ON dead_receipt_event.id = dead_receipt.normalized_domain_event_id
	         WHERE dead.resource_product = 'finance'
	           AND (
	             (
	               dead.property_id = payout.property_id
	               AND dead.resource_type = 'payout'
	               AND dead.resource_id = payout.id::text
	             )
	             OR dead.job_id = job.id
	             OR (
	               dead.resource_type = 'payout'
	               AND dead.resource_id = payout.provider_payout_id
	             )
	             OR dead_domain_event.resource_id = payout.provider_payout_id
	             OR dead_job_event.resource_id = payout.provider_payout_id
	             OR dead_receipt_event.resource_id = payout.provider_payout_id
	           )
	         ORDER BY dead.created_at DESC
	         LIMIT 1
	       ) dead ON TRUE
       WHERE payout.property_id = $1::uuid
         AND payout.owner_scope = 'property'
     ),
     mapped AS (
       ${reconciliationMappedSelect()}
       FROM base
     ),
     filtered AS (
       ${reconciliationFilteredSelect()}
     )
	     ${reconciliationFinalSelect(mode)}`;
}

function reconciliationProviderAccountSql(mode: "page" | "total"): string {
  return `WITH base AS (
       SELECT
         account.id::text AS "subjectId",
         'provider_account' AS "subjectType",
         account.provider,
         account.status AS "financeStatus",
         account.account_metadata ->> 'providerStatus' AS "providerStatus",
         receipt.delivery_status AS "receiptStatus",
         receipt.received_at AS "lastReceiptAt",
         job.status AS "rawJobStatus",
         COALESCE(job.finished_at, job.run_after, job.created_at) AS "lastJobAt",
         dead.created_at AS "deadLetteredAt"
       FROM finance.payment_provider_accounts account
	       LEFT JOIN LATERAL (
	         SELECT receipt.delivery_status, receipt.received_at
	         FROM platform.external_webhook_events receipt
	         JOIN platform.domain_events receipt_event
	           ON receipt_event.id = receipt.normalized_domain_event_id
	          AND receipt_event.source_system = 'external'
	          AND receipt_event.resource_product = 'finance'
	          AND receipt_event.resource_type = 'provider_account'
	         WHERE receipt.provider = account.provider
	           AND receipt_event.resource_id = account.id::text
	         ORDER BY receipt.received_at DESC
	         LIMIT 1
	       ) receipt ON TRUE
	       LEFT JOIN LATERAL (
	         SELECT job.id, job.status, job.finished_at, job.run_after, job.created_at
	         FROM platform.jobs job
	         LEFT JOIN platform.domain_events job_event
	           ON job_event.id = job.source_domain_event_id
	          AND job_event.source_system = 'external'
	          AND job_event.resource_product = 'finance'
	          AND job_event.resource_type = 'provider_account'
	         WHERE job.resource_product = 'finance'
	           AND (
	             (
	               job.property_id = account.property_id
	               AND job.resource_type = 'provider_account'
	               AND job.resource_id = account.id::text
	             )
	             OR (
	               job.tenant_scope = 'external'
	               AND job.resource_type = 'provider_account'
	               AND job.resource_id = account.id::text
	             )
	             OR job_event.resource_id = account.id::text
	             OR job.job_key LIKE ('finance.reconcile-provider-account:provider_account:' || account.id::text || ':%')
	           )
	         ORDER BY job.created_at DESC
	         LIMIT 1
	       ) job ON TRUE
	       LEFT JOIN LATERAL (
	         SELECT dead.created_at
	         FROM platform.dead_letter_events dead
	         LEFT JOIN platform.jobs dead_job
	           ON dead_job.id = dead.job_id
	         LEFT JOIN platform.domain_events dead_domain_event
	           ON dead_domain_event.id = dead.domain_event_id
	         LEFT JOIN platform.domain_events dead_job_event
	           ON dead_job_event.id = dead_job.source_domain_event_id
	         LEFT JOIN platform.external_webhook_events dead_receipt
	           ON dead_receipt.id = dead.webhook_event_id
	         LEFT JOIN platform.domain_events dead_receipt_event
	           ON dead_receipt_event.id = dead_receipt.normalized_domain_event_id
	         WHERE dead.resource_product = 'finance'
	           AND (
	             (
	               dead.property_id = account.property_id
	               AND dead.resource_type = 'provider_account'
	               AND dead.resource_id = account.id::text
	             )
	             OR dead.job_id = job.id
	             OR (
	               dead.resource_type = 'provider_account'
	               AND dead.resource_id = account.id::text
	             )
	             OR dead_domain_event.resource_id = account.id::text
	             OR dead_job_event.resource_id = account.id::text
	             OR dead_receipt_event.resource_id = account.id::text
	           )
	         ORDER BY dead.created_at DESC
	         LIMIT 1
	       ) dead ON TRUE
       WHERE account.property_id = $1::uuid
         AND account.account_scope = 'property'
     ),
     mapped AS (
       ${reconciliationMappedSelect()}
       FROM base
     ),
     filtered AS (
       ${reconciliationFilteredSelect()}
     )
	     ${reconciliationFinalSelect(mode)}`;
}

function reconciliationMappedSelect(): string {
  return `SELECT
         "subjectId",
         "subjectType",
         provider,
         "financeStatus",
         "providerStatus",
         CASE
           WHEN "deadLetteredAt" IS NOT NULL OR "rawJobStatus" = 'dead_lettered' THEN 'dead_lettered'
           WHEN provider IN ('manual', 'bank_transfer', 'vayada') THEN 'not_applicable'
           WHEN "receiptStatus" IN ('promoted', 'normalized', 'succeeded') THEN 'matched'
           WHEN "receiptStatus" = 'dead_lettered' THEN 'dead_lettered'
           WHEN "receiptStatus" IS NULL THEN 'missing'
           ELSE 'stale'
         END AS "latestReceiptStatus",
         CASE
           WHEN "deadLetteredAt" IS NOT NULL OR "rawJobStatus" = 'dead_lettered' THEN 'dead_lettered'
           WHEN "rawJobStatus" IN ('pending') THEN 'queued'
           WHEN "rawJobStatus" = 'running' THEN 'running'
           WHEN "rawJobStatus" IN ('failed', 'canceled') THEN 'failed'
           ELSE 'idle'
         END AS "jobStatus",
         CASE
           WHEN "deadLetteredAt" IS NOT NULL OR "rawJobStatus" = 'dead_lettered' THEN 'manual_review'
           WHEN "rawJobStatus" IN ('failed', 'canceled') THEN 'enqueue_reconcile'
           WHEN provider IN ('manual', 'bank_transfer', 'vayada') THEN 'none'
           WHEN "receiptStatus" IS NULL THEN 'enqueue_reconcile'
           WHEN "receiptStatus" NOT IN ('promoted', 'normalized', 'succeeded') THEN 'refresh_provider_state'
           ELSE 'none'
         END AS "recommendedAction",
         "lastReceiptAt",
         "lastJobAt",
         jsonb_build_object(
           'providerReceiptsFreshAt', "lastReceiptAt",
           'jobsFreshAt', "lastJobAt",
           'deadLettersFreshAt', "deadLetteredAt"
         ) AS "sourceFreshness"`;
}

function reconciliationFilteredSelect(): string {
  return `SELECT *
       FROM mapped
       WHERE ($2::text IS NULL OR "latestReceiptStatus" = $2::text OR "jobStatus" = $2::text)
         AND ($3::text IS NULL OR provider = $3::text)`;
}

function reconciliationFinalSelect(mode: "page" | "total"): string {
  if (mode === "total") {
    return `SELECT count(*)::text AS total FROM filtered`;
  }
  return `, total_count AS (
	       SELECT count(*)::text AS total
	       FROM filtered
	     ),
	     page AS (
	       SELECT *
	       FROM filtered
	       ORDER BY
	         CASE "recommendedAction"
	           WHEN 'manual_review' THEN 0
	           WHEN 'enqueue_reconcile' THEN 1
	           WHEN 'refresh_provider_state' THEN 2
	           ELSE 3
	         END,
	         COALESCE("lastJobAt", "lastReceiptAt") DESC NULLS LAST,
	         "subjectId" ASC
	       LIMIT $4::integer OFFSET $5::integer
	     )
	     SELECT
	       page.*,
	       total_count.total
	     FROM page
	     CROSS JOIN total_count`;
}

function toFinancePaymentSettingsReadModel(
  row: FinancePaymentSettingsRow,
): FinancePaymentSettingsReadModel {
  const acceptedMethods = paymentMethods(row.acceptedMethods);
  const defaultCurrency = currencyCode(row.defaultCurrency);
  const providerStatus = providerAccountStatus(row.providerStatus);
  return {
    propertyId: row.propertyId,
    paymentsEnabled: row.paymentsEnabled ?? false,
    paymentProvider: paymentProvider(row.provider),
    acceptedMethods,
    defaultCurrency,
    supportedCurrencies: [defaultCurrency],
    depositPolicy: jsonPolicy(row.depositPolicy),
    refundPolicy: jsonPolicy(row.refundPolicy),
    taxPolicy: jsonPolicy(row.taxPolicy),
    statementDescriptor: row.statementDescriptor,
    requiresManualReview: (row.requiresManualReview ?? false) || providerStatus !== "active",
    providerAccount: {
      providerAccountId:
        row.providerAccountId?.startsWith("settings-choice:") === true
          ? null
          : row.providerAccountId,
      provider: row.provider ? paymentProvider(row.provider) : null,
      status: providerStatus,
      onboardingStatus: providerOnboardingStatus(row.providerOnboardingStatus),
      chargesEnabled: row.chargesEnabled ?? false,
      payoutsEnabled: row.payoutsEnabled ?? false,
      capabilities: stringArray(row.providerCapabilities),
    },
    sourceFreshness: {
      finance: "target",
      status: "fresh",
    },
    updatedAt: utcDateTime(row.updatedAt, new Date().toISOString()),
  };
}

function consumeStripeDashboardLinkRateLimit(
  windows: Map<string, { count: number; resetAt: number }>,
  key: string,
  now: number = Date.now(),
): { ok: true } | { ok: false; retryAfterSeconds: number } {
  const current = windows.get(key);
  if (!current || current.resetAt <= now) {
    windows.set(key, { count: 1, resetAt: now + STRIPE_DASHBOARD_LINK_RATE_WINDOW_MS });
    return { ok: true };
  }
  if (current.count >= STRIPE_DASHBOARD_LINK_RATE_LIMIT) {
    return {
      ok: false,
      retryAfterSeconds: Math.max(1, Math.ceil((current.resetAt - now) / 1_000)),
    };
  }
  current.count += 1;
  return { ok: true };
}

function toAffiliatePayoutSettingsReadModel(
  row: FinanceAffiliatePayoutSettingsRow,
): FinanceAffiliatePayoutSettingsReadModel {
  const provider = affiliatePayoutProvider(row.payoutProvider);
  const providerStatus = providerAccountStatus(row.providerStatus);
  return {
    affiliateId: row.affiliateId,
    marketplaceOrganizationId: row.marketplaceOrganizationId,
    payoutsEnabled: row.payoutsEnabled ?? false,
    payoutProvider: provider,
    payoutCurrency: currencyCode(row.payoutCurrency),
    payoutSchedule: affiliatePayoutSchedule(row.payoutSchedule),
    payoutThresholdAmount: row.payoutThresholdAmount
      ? decimalString(row.payoutThresholdAmount)
      : null,
    providerAccount: {
      providerAccountId: row.providerAccountId,
      provider: row.provider ? affiliatePayoutProvider(row.provider) : null,
      status: providerStatus,
      onboardingStatus: providerOnboardingStatus(row.providerOnboardingStatus),
      payoutsEnabled: row.providerPayoutsEnabled ?? false,
    },
    sourceFreshness: jsonPolicy(row.sourceFreshness),
    updatedAt: utcDateTime(row.updatedAt, new Date().toISOString()),
  };
}

function toAffiliatePayoutSettingsResponse(
  settings: FinanceAffiliatePayoutSettingsReadModel,
): FinanceAffiliatePayoutSettingsResponse {
  const {
    affiliateId,
    marketplaceOrganizationId,
    updatedAt: _updatedAt,
    ...payoutSettings
  } = settings;
  return {
    contractVersion: FINANCE_ROUTE_CONTRACT_VERSION,
    affiliateId,
    marketplaceOrganizationId,
    payoutSettings,
  };
}

function toPayoutListResponseBody(
  result: FinanceRowsWithTotal<FinancePayoutRow>,
  query: FinancePayoutListQuery,
): Omit<FinancePayoutListResponse, "contractVersion" | "propertyId"> {
  const rows = result.rows;
  return {
    payouts: rows.map(toPayout),
    total: result.total,
    limit: query.limit,
    offset: query.offset,
    sourceFreshness: financeJsonObject(rows[0]?.sourceFreshness),
  };
}

function toAffiliatePayoutListResponseBody(
  result: FinanceRowsWithTotal<FinancePayoutRow>,
  query: FinancePayoutListQuery,
): Omit<FinanceAffiliatePayoutListResponse, "contractVersion" | "affiliateId"> {
  const rows = result.rows;
  return {
    payouts: rows.map(toPayout),
    total: result.total,
    limit: query.limit,
    offset: query.offset,
    sourceFreshness: financeJsonObject(rows[0]?.sourceFreshness),
  };
}

function toPayout(row: FinancePayoutRow): FinancePayout {
  return {
    payoutId: row.payoutId,
    ownerScope: payoutOwnerScope(row.ownerScope),
    propertyId: row.propertyId,
    organizationId: row.organizationId,
    relatedPropertyId: row.relatedPropertyId,
    guestBookingId: row.guestBookingId,
    paymentId: row.paymentId,
    payoutStatus: payoutStatus(row.payoutStatus),
    amount: decimalString(row.amount),
    feeAmount: decimalString(row.feeAmount),
    netAmount: decimalString(row.netAmount),
    currency: currencyCode(row.currency),
    provider: paymentProvider(row.provider),
    providerPayoutId: row.providerPayoutId,
    scheduledAt: nullableUtcDateTime(row.scheduledAt),
    paidAt: nullableUtcDateTime(row.paidAt),
    failedAt: nullableUtcDateTime(row.failedAt),
    failureCode: row.failureCode,
    retryCount: row.retryCount,
  };
}

function toReconciliationViewResponseBody(
  result: FinanceRowsWithTotal<FinanceReconciliationRow>,
  query: FinanceReconciliationViewQuery,
): Omit<FinanceReconciliationViewResponse, "contractVersion" | "propertyId"> {
  const rows = result.rows;
  return {
    items: rows.map(toReconciliationItem),
    total: result.total,
    limit: query.limit,
    offset: query.offset,
    sourceFreshness: financeJsonObject(rows[0]?.sourceFreshness),
  };
}

function toReconciliationItem(row: FinanceReconciliationRow): FinanceReconciliationItem {
  return {
    subjectId: row.subjectId,
    subjectType: reconciliationSubjectType(row.subjectType),
    provider: paymentProvider(row.provider),
    financeStatus: row.financeStatus,
    providerStatus: row.providerStatus,
    latestReceiptStatus: reconciliationReceiptStatus(row.latestReceiptStatus),
    jobStatus: reconciliationJobStatus(row.jobStatus),
    recommendedAction: reconciliationRecommendedAction(row.recommendedAction),
    lastReceiptAt: nullableUtcDateTime(row.lastReceiptAt),
    lastJobAt: nullableUtcDateTime(row.lastJobAt),
  };
}

function emptyPayoutList(
  query: FinancePayoutListQuery,
): Omit<FinancePayoutListResponse, "contractVersion" | "propertyId"> {
  return {
    payouts: [],
    total: 0,
    limit: query.limit,
    offset: query.offset,
    sourceFreshness: { finance: { status: "empty" } },
  };
}

function emptyReconciliationView(
  query: FinanceReconciliationViewQuery,
): Omit<FinanceReconciliationViewResponse, "contractVersion" | "propertyId"> {
  return {
    items: [],
    total: 0,
    limit: query.limit,
    offset: query.offset,
    sourceFreshness: {
      providerReceiptsFreshAt: null,
      jobsFreshAt: null,
      deadLettersFreshAt: null,
    },
  };
}

function parsePayoutListQuery(query: unknown): FinancePayoutListQuery | FinanceValidationError {
  const params = queryRecord(query);
  const status = optionalEnum(params.status, FINANCE_PAYOUT_STATUSES);
  if (params.status && !status) {
    return invalidQuery("invalid_query", "Invalid payout status filter.");
  }
  const provider = optionalEnum(params.provider, FINANCE_ROUTE_PAYMENT_PROVIDERS);
  if (params.provider && !provider) {
    return invalidQuery("invalid_provider", "Invalid payout provider filter.");
  }
  return {
    status,
    provider,
    limit: clampLimit(params.limit),
    offset: parseOffset(params.offset),
  };
}

function parseReconciliationViewQuery(
  query: unknown,
): FinanceReconciliationViewQuery | FinanceValidationError {
  const params = queryRecord(query);
  const receiptStatus = optionalEnum(params.status, FINANCE_RECONCILIATION_RECEIPT_STATUSES);
  const jobStatus = optionalEnum(params.status, FINANCE_RECONCILIATION_JOB_STATUSES);
  if (params.status && !receiptStatus && !jobStatus) {
    return invalidQuery("invalid_query", "Invalid reconciliation status filter.");
  }
  const provider = optionalEnum(params.provider, FINANCE_ROUTE_PAYMENT_PROVIDERS);
  if (params.provider && !provider) {
    return invalidQuery("invalid_provider", "Invalid reconciliation provider filter.");
  }
  return {
    status: receiptStatus ?? jobStatus,
    provider,
    limit: clampLimit(params.limit),
    offset: parseOffset(params.offset),
  };
}

function toStripePropertyAccountCommand(
  request: FastifyRequest<{ Body: StripeProviderAccountBody }>,
  propertyId: string,
): CreateStripeProviderAccountCommand | FinanceValidationError {
  const body = request.body ?? {};
  const base = parseStripeProviderAccountBody(body);
  if ("statusCode" in base) return base;
  return {
    commandType: "finance.provider_account.stripe.create",
    commandId: base.commandId,
    idempotencyKey: base.idempotencyKey,
    propertyId,
    audit: financeCommandAudit(request, "Create or replay property Stripe Connect account"),
    payload: {
      email: base.email,
      country: base.country,
      returnSurface: base.returnSurface,
    },
  };
}

function toStripeAffiliateAccountCommand(
  request: FastifyRequest<{ Body: StripeProviderAccountBody }>,
  affiliateId: string,
  context: RequestContext,
): CreateStripeProviderAccountCommand | FinanceValidationError {
  const body = request.body ?? {};
  const base = parseStripeProviderAccountBody(body);
  if ("statusCode" in base) return base;
  return {
    commandType: "finance.provider_account.stripe.create",
    commandId: base.commandId,
    idempotencyKey: base.idempotencyKey,
    affiliateId,
    organizationId: context.selectedOrganization.organizationId,
    audit: financeCommandAudit(request, "Create or replay affiliate Stripe Connect account"),
    payload: {
      email: base.email,
      country: base.country,
      returnSurface: base.returnSurface,
    },
  };
}

function toStripePropertyOnboardingLinkCommand(
  request: FastifyRequest<{ Body: OnboardingLinkBody }>,
  propertyId: string,
  providerAccountId: string,
): IssueStripeOnboardingLinkCommand | FinanceValidationError {
  const body = request.body ?? {};
  const commandId = nonEmptyString(body.commandId);
  const idempotencyKey = nonEmptyString(body.idempotencyKey);
  if (!commandId || !idempotencyKey) {
    return invalidQuery(
      "invalid_body",
      "Stripe onboarding-link command requires commandId and idempotencyKey.",
    );
  }
  return {
    commandType: "finance.provider_account.stripe.onboarding_link.issue",
    commandId,
    idempotencyKey,
    propertyId,
    audit: financeCommandAudit(request, "Issue property Stripe Connect onboarding link"),
    payload: { providerAccountId, returnSurface: parseStripeReturnSurface(body.returnSurface) },
  };
}

function toStripePropertyAccountReconciliationCommand(
  request: FastifyRequest<{ Body: StripeProviderAccountReconciliationBody }>,
  propertyId: string,
): ReconcileStripePropertyAccountCommand | FinanceValidationError {
  const body = request.body ?? {};
  const commandId = nonEmptyString(body.commandId);
  const idempotencyKey = nonEmptyString(body.idempotencyKey);
  if (!commandId || !idempotencyKey) {
    return invalidQuery(
      "invalid_body",
      "Stripe reconciliation requires commandId and idempotencyKey.",
    );
  }
  return {
    commandType: "finance.provider_account.stripe.reconcile",
    commandId,
    idempotencyKey,
    propertyId,
    audit: financeCommandAudit(request, "Reconcile property Stripe Connect readiness"),
    payload: {},
  };
}

function toStripeAffiliateOnboardingLinkCommand(
  request: FastifyRequest<{ Body: OnboardingLinkBody }>,
  affiliateId: string,
  providerAccountId: string,
  context: RequestContext,
): IssueStripeOnboardingLinkCommand | FinanceValidationError {
  const body = request.body ?? {};
  const commandId = nonEmptyString(body.commandId);
  const idempotencyKey = nonEmptyString(body.idempotencyKey);
  if (!commandId || !idempotencyKey) {
    return invalidQuery(
      "invalid_body",
      "Stripe affiliate onboarding-link command requires commandId and idempotencyKey.",
    );
  }
  return {
    commandType: "finance.provider_account.stripe.onboarding_link.issue",
    commandId,
    idempotencyKey,
    affiliateId,
    organizationId: context.selectedOrganization.organizationId,
    audit: financeCommandAudit(request, "Issue affiliate Stripe Connect onboarding link"),
    payload: { providerAccountId, returnSurface: parseStripeReturnSurface(body.returnSurface) },
  };
}

function parseStripeProviderAccountBody(body: StripeProviderAccountBody):
  | {
      commandId: string;
      idempotencyKey: string;
      email: string;
      country: string;
      returnSurface?: "marketplace" | "booking_admin";
    }
  | FinanceValidationError {
  const commandId = nonEmptyString(body.commandId);
  const idempotencyKey = nonEmptyString(body.idempotencyKey);
  const email = emailBodyString(body.email);
  const country = countryBodyString(body.country);
  if (!commandId || !idempotencyKey || !email || !country) {
    return invalidQuery(
      "invalid_body",
      "Stripe provider-account command requires commandId, idempotencyKey, email, and country.",
    );
  }
  return {
    commandId,
    idempotencyKey,
    email,
    country,
    returnSurface: parseStripeReturnSurface(body.returnSurface),
  };
}

function parseStripeReturnSurface(value: unknown): "marketplace" | "booking_admin" | undefined {
  return value === "marketplace" || value === "booking_admin" ? value : undefined;
}

function financeCommandAudit(request: FastifyRequest, reason: string): FinanceCommandAudit {
  const now = new Date().toISOString();
  const authContext = request.authContext;
  return {
    actor: authContext
      ? {
          kind: "user",
          userId: authContext.actor.internalUserId,
          organizationId: authContext.selectedOrganization.organizationId,
        }
      : { kind: "system", service: "apps/api" },
    requestId: authContext?.audit.requestId ?? `req_${Date.now()}`,
    correlationId: authContext?.audit.correlationId,
    reason,
    requestedAt: authContext?.audit.receivedAt ?? now,
  };
}

function onlineCardReadinessChangeContext(
  audit: FinanceCommandAudit,
  causationId: string,
): FinanceOnlineCardReadinessChangeContext {
  return {
    occurredAt: audit.requestedAt,
    actorType: audit.actor.kind,
    actorUserId: audit.actor.kind === "user" ? audit.actor.userId : null,
    correlationId: audit.correlationId ?? audit.requestId,
    causationId,
  };
}

function emailBodyString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const email = value.trim().toLowerCase();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? email : undefined;
}

function countryBodyString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const country = value.trim().toUpperCase();
  return /^[A-Z]{2}$/.test(country) ? country : undefined;
}

function toXenditBankValidationCommand(
  request: FastifyRequest<{ Body: XenditBankValidationBody }>,
  propertyId: string,
): FinanceXenditBankValidationCommand | FinanceValidationError {
  const body = request.body ?? {};
  const commandId = nonEmptyString(body.commandId);
  const idempotencyKey = nonEmptyString(body.idempotencyKey);
  const channelCode = nonEmptyString(body.channelCode);
  const accountNumber = nonEmptyString(body.accountNumber);
  const accountHolderName = nonEmptyString(body.accountHolderName);

  if (!commandId || !idempotencyKey || !channelCode || !accountNumber || !accountHolderName) {
    return invalidQuery(
      "invalid_body",
      "Xendit bank validation requires commandId, idempotencyKey, channelCode, accountNumber, and accountHolderName.",
    );
  }
  if (!/^ID_[A-Z0-9_]{2,32}$/.test(channelCode)) {
    return invalidQuery("invalid_body", "Xendit channelCode must be an ID_* bank channel code.");
  }
  if (!/^[0-9]{4,34}$/.test(accountNumber)) {
    return invalidQuery("invalid_body", "Xendit accountNumber must contain 4 to 34 digits.");
  }

  const now = new Date().toISOString();
  const authContext = request.authContext;
  return {
    commandType: "finance.xendit_bank_account.validate",
    commandId,
    idempotencyKey,
    propertyId,
    audit: {
      actor: authContext
        ? {
            kind: "user",
            userId: authContext.actor.internalUserId,
            organizationId: authContext.selectedOrganization.organizationId,
          }
        : { kind: "system", service: "apps/api" },
      requestId: authContext?.audit.requestId ?? commandId,
      correlationId: authContext?.audit.correlationId,
      reason: "Validate Xendit payout bank destination",
      requestedAt: authContext?.audit.receivedAt ?? now,
    },
    payload: {
      channelCode,
      accountNumber,
      accountHolderName,
    },
  };
}

function toXenditPayoutReconciliationCommand(
  request: FastifyRequest<{ Body: XenditPayoutReconciliationBody }>,
  propertyId: string,
): FinanceXenditPayoutReconciliationCommand | FinanceValidationError {
  const body = request.body ?? {};
  const commandId = nonEmptyString(body.commandId);
  const idempotencyKey = nonEmptyString(body.idempotencyKey);
  const olderThanMinutes = integerBodyNumber(body.olderThanMinutes);

  if (!commandId || !idempotencyKey || olderThanMinutes === undefined) {
    return invalidQuery(
      "invalid_body",
      "Xendit payout reconciliation requires commandId, idempotencyKey, and olderThanMinutes.",
    );
  }

  const now = new Date().toISOString();
  const authContext = request.authContext;
  return {
    commandType: "finance.xendit_payouts.reconcile",
    commandId,
    idempotencyKey,
    propertyId,
    audit: {
      actor: authContext
        ? {
            kind: "user",
            userId: authContext.actor.internalUserId,
            organizationId: authContext.selectedOrganization.organizationId,
          }
        : { kind: "system", service: "apps/api" },
      requestId: authContext?.audit.requestId ?? commandId,
      correlationId: authContext?.audit.correlationId,
      reason: "Manually enqueue Xendit payout status reconciliation",
      requestedAt: authContext?.audit.receivedAt ?? now,
    },
    payload: {
      olderThanMinutes,
    },
  };
}

function toPropertyPayoutDispatchCommand(
  request: FastifyRequest<{ Body: PropertyPayoutDispatchBody }>,
  propertyId: string,
  payoutId: string,
): FinancePropertyPayoutDispatchCommand | FinanceValidationError {
  const body = request.body ?? {};
  const commandId = nonEmptyString(body.commandId);
  const idempotencyKey = nonEmptyString(body.idempotencyKey);
  const legacySchedulerFrozenAt = utcBodyString(body.legacySchedulerFrozenAt);
  const reconciliationReadyAt = utcBodyString(body.reconciliationReadyAt);

  if (!commandId || !idempotencyKey || !legacySchedulerFrozenAt || !reconciliationReadyAt) {
    return invalidQuery(
      "invalid_body",
      "Property payout dispatch requires commandId, idempotencyKey, legacySchedulerFrozenAt, and reconciliationReadyAt.",
    );
  }

  const now = new Date().toISOString();
  const authContext = request.authContext;
  return {
    commandType: "finance.property_payout.dispatch",
    commandId,
    idempotencyKey,
    propertyId,
    audit: {
      actor: authContext
        ? {
            kind: "user",
            userId: authContext.actor.internalUserId,
            organizationId: authContext.selectedOrganization.organizationId,
          }
        : { kind: "system", service: "apps/api" },
      requestId: authContext?.audit.requestId ?? commandId,
      correlationId: authContext?.audit.correlationId,
      reason: "Enqueue target property payout dispatch after reconciliation readiness",
      requestedAt: authContext?.audit.receivedAt ?? now,
    },
    payload: {
      payoutId,
      legacySchedulerFrozenAt,
      reconciliationReadyAt,
    },
  };
}

function toPaymentSettingsPatchCommand(
  request: FastifyRequest<{ Body: PaymentSettingsPatchBody }>,
  propertyId: string,
): FinancePaymentSettingsPatchCommand | FinanceValidationError {
  const body = plainRecord(request.body);
  if (!body) {
    return invalidQuery("invalid_body", "Payment settings update body must be an object.");
  }
  const commandId = nonEmptyString(body.commandId);
  const idempotencyKey = nonEmptyString(body.idempotencyKey);
  if (!commandId || !idempotencyKey) {
    return invalidQuery(
      "invalid_body",
      "Payment settings update requires commandId and idempotencyKey.",
    );
  }

  const bodyKeys = strictObjectKeys(body, ["commandId", "idempotencyKey", "paymentSettings"]);
  if (bodyKeys) return bodyKeys;
  const paymentSettings = plainRecord(body.paymentSettings);
  if (!paymentSettings) {
    return invalidQuery("invalid_body", "paymentSettings must be an object.");
  }
  const settingsKeys = strictObjectKeys(paymentSettings, [
    "paymentsEnabled",
    "paymentProvider",
    "acceptedMethods",
    "defaultCurrency",
    "supportedCurrencies",
    "depositPolicy",
    "refundPolicy",
    "taxPolicy",
    "statementDescriptor",
    "requiresManualReview",
  ]);
  if (settingsKeys) return settingsKeys;

  const payload: FinancePaymentSettingsPatchPayload = {};
  if (paymentSettings.paymentsEnabled !== undefined) {
    if (typeof paymentSettings.paymentsEnabled !== "boolean") {
      return invalidQuery("invalid_body", "paymentsEnabled must be a boolean.");
    }
    payload.paymentsEnabled = paymentSettings.paymentsEnabled;
  }
  if (paymentSettings.paymentProvider !== undefined) {
    const provider = optionalEnum(paymentSettings.paymentProvider, FINANCE_ROUTE_PAYMENT_PROVIDERS);
    if (!provider) return invalidQuery("invalid_provider", "Unsupported payment provider.");
    payload.paymentProvider = provider;
  }
  if (paymentSettings.acceptedMethods !== undefined) {
    const methods = paymentMethodArray(paymentSettings.acceptedMethods);
    if (!methods) return invalidQuery("invalid_payment_method", "acceptedMethods is invalid.");
    payload.acceptedMethods = methods;
  }
  if (paymentSettings.defaultCurrency !== undefined) {
    const currency = currencyBodyString(paymentSettings.defaultCurrency);
    if (!currency) return invalidQuery("invalid_body", "defaultCurrency must be an ISO-4217 code.");
    payload.defaultCurrency = currency;
  }
  if (paymentSettings.supportedCurrencies !== undefined) {
    const currencies = currencyArray(paymentSettings.supportedCurrencies);
    if (!currencies) {
      return invalidQuery("invalid_body", "supportedCurrencies must contain ISO-4217 codes.");
    }
    if (currencies.length !== 1) {
      return invalidQuery("invalid_body", "Only one supported currency is currently stored.");
    }
    payload.supportedCurrencies = currencies;
  }
  for (const key of ["depositPolicy", "refundPolicy", "taxPolicy"] as const) {
    if (paymentSettings[key] !== undefined) {
      const policy = jsonPolicyBody(paymentSettings[key], key);
      if (!policy.ok) return policy.error;
      payload[key] = policy.value;
    }
  }
  if (paymentSettings.statementDescriptor !== undefined) {
    if (paymentSettings.statementDescriptor !== null) {
      const descriptor = nonEmptyString(paymentSettings.statementDescriptor);
      if (!descriptor) {
        return invalidQuery("invalid_body", "statementDescriptor must be a string or null.");
      }
      payload.statementDescriptor = descriptor;
    } else {
      payload.statementDescriptor = null;
    }
  }
  if (paymentSettings.requiresManualReview !== undefined) {
    if (typeof paymentSettings.requiresManualReview !== "boolean") {
      return invalidQuery("invalid_body", "requiresManualReview must be a boolean.");
    }
    payload.requiresManualReview = paymentSettings.requiresManualReview;
  }
  if (Object.keys(payload).length === 0) {
    return invalidQuery("invalid_body", "Payment settings update has no changes.");
  }

  return {
    commandType: "finance.payment_settings.update",
    commandId,
    idempotencyKey,
    propertyId,
    audit: financeCommandAudit(request, "Update property payment settings"),
    payload,
  };
}

function strictObjectKeys(
  value: Record<string, unknown>,
  allowedKeys: readonly string[],
): FinanceValidationError | null {
  for (const key of Object.keys(value)) {
    if (!allowedKeys.includes(key)) {
      return invalidQuery("invalid_body", `${key} is not supported.`);
    }
  }
  return null;
}

function plainRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function paymentMethodArray(value: unknown): FinanceRoutePaymentMethod[] | null {
  if (!Array.isArray(value)) return null;
  const methods: FinanceRoutePaymentMethod[] = [];
  for (const entry of value) {
    const method = optionalEnum(entry, FINANCE_ROUTE_PAYMENT_METHODS);
    if (!method || methods.includes(method)) return null;
    methods.push(method);
  }
  return methods;
}

function currencyArray(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  const currencies = value.map(currencyBodyString);
  if (currencies.some((currency) => !currency)) return null;
  return currencies as string[];
}

type FinanceJsonPolicyBodyResult =
  { ok: true; value: FinanceJsonPolicy } | { ok: false; error: FinanceValidationError };

function jsonPolicyBody(value: unknown, name: string): FinanceJsonPolicyBodyResult {
  const record = plainRecord(value);
  if (!record) {
    return { ok: false, error: invalidQuery("invalid_body", `${name} must be an object.`) };
  }
  for (const [key, entry] of Object.entries(record)) {
    const valid =
      entry === null ||
      typeof entry === "string" ||
      typeof entry === "boolean" ||
      (typeof entry === "number" && Number.isFinite(entry));
    if (!valid) {
      return {
        ok: false,
        error: invalidQuery(
          "invalid_body",
          `${name}.${key} must be a string, number, boolean, or null.`,
        ),
      };
    }
  }
  return { ok: true, value: record as FinanceJsonPolicy };
}

function toAffiliatePayoutSettingsPatchCommand(
  request: FastifyRequest<{ Body: AffiliatePayoutSettingsPatchBody }>,
  affiliateId: string,
): FinanceAffiliatePayoutSettingsPatchCommand | FinanceValidationError {
  const body = request.body ?? {};
  const commandId = nonEmptyString(body.commandId);
  const idempotencyKey = nonEmptyString(body.idempotencyKey);
  if (!commandId || !idempotencyKey) {
    return invalidQuery(
      "invalid_body",
      "Affiliate payout settings update requires commandId and idempotencyKey.",
    );
  }

  const payload: FinanceAffiliatePayoutSettingsPatchCommand["payload"] = {};
  if (body.payoutsEnabled !== undefined) {
    if (typeof body.payoutsEnabled !== "boolean") {
      return invalidQuery("invalid_body", "payoutsEnabled must be a boolean.");
    }
    payload.payoutsEnabled = body.payoutsEnabled;
  }
  if (body.payoutProvider !== undefined) {
    const provider = affiliatePayoutProviderBody(body.payoutProvider);
    if (!provider)
      return invalidQuery("invalid_provider", "Unsupported affiliate payout provider.");
    payload.payoutProvider = provider;
  }
  if (body.payoutCurrency !== undefined) {
    const currency = currencyBodyString(body.payoutCurrency);
    if (!currency) return invalidQuery("invalid_body", "payoutCurrency must be an ISO-4217 code.");
    payload.payoutCurrency = currency;
  }
  if (body.payoutSchedule !== undefined) {
    const schedule = affiliatePayoutScheduleBody(body.payoutSchedule);
    if (!schedule) return invalidQuery("invalid_body", "Unsupported affiliate payout schedule.");
    payload.payoutSchedule = schedule;
  }
  if (body.payoutThresholdAmount !== undefined) {
    if (body.payoutThresholdAmount === null) {
      payload.payoutThresholdAmount = null;
    } else {
      const amount = decimalBodyString(body.payoutThresholdAmount);
      if (!amount) {
        return invalidQuery(
          "invalid_body",
          "payoutThresholdAmount must be a positive decimal string or null.",
        );
      }
      payload.payoutThresholdAmount = amount;
    }
  }
  if (Object.keys(payload).length === 0) {
    return invalidQuery("invalid_body", "Affiliate payout settings update has no changes.");
  }

  const now = new Date().toISOString();
  const authContext = request.authContext;
  return {
    commandType: "finance.affiliate_payout_settings.update",
    commandId,
    idempotencyKey,
    affiliateId,
    audit: {
      actor: authContext
        ? {
            kind: "user",
            userId: authContext.actor.internalUserId,
            organizationId: authContext.selectedOrganization.organizationId,
          }
        : { kind: "system", service: "apps/api" },
      requestId: authContext?.audit.requestId ?? commandId,
      correlationId: authContext?.audit.correlationId,
      reason: "Update affiliate payout settings",
      requestedAt: authContext?.audit.receivedAt ?? now,
    },
    payload,
  };
}

function integerBodyNumber(value: unknown): number | undefined {
  const numberValue =
    typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  if (!Number.isInteger(numberValue) || numberValue < 0 || numberValue > 10080) return undefined;
  return numberValue;
}

function utcBodyString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return undefined;
  if (!value.endsWith("Z")) return undefined;
  return parsed.toISOString();
}

function utcEvidenceString(value: unknown): string | null {
  if (value instanceof Date) return value.toISOString();
  if (typeof value !== "string") return null;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed.toISOString();
}

function decimalBodyString(value: unknown): string | undefined {
  if (typeof value !== "string" && typeof value !== "number") return undefined;
  const text = String(value).trim();
  if (numeric15Scale2Cents(text) === null) return undefined;
  return text;
}

function numeric15Scale2Cents(value: string, options: { allowZero?: boolean } = {}): bigint | null {
  const match = /^(\d+)(?:\.(\d{1,2}))?$/.exec(value.trim());
  if (!match) return null;

  const integerDigits = (match[1] ?? "").replace(/^0+/, "") || "0";
  if (integerDigits.length > 13) return null;

  const fractionalDigits = (match[2] ?? "").padEnd(2, "0");
  const cents = BigInt(integerDigits) * 100n + BigInt(fractionalDigits);
  const maxNumeric15Scale2Cents = 999_999_999_999_999n;
  if (cents > maxNumeric15Scale2Cents) return null;
  if (!options.allowZero && cents <= 0n) return null;
  return cents;
}

function currencyBodyString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const currency = value.trim().toUpperCase();
  return /^[A-Z]{3}$/.test(currency) ? currency : undefined;
}

function maskAccountNumber(accountNumber: string): string {
  const visibleTail = accountNumber.slice(-4);
  return `${"*".repeat(Math.max(0, accountNumber.length - 4))}${visibleTail}`;
}

function toFinanceCommandError(
  result:
    | Extract<FinanceProviderAccountCommandResult, { ok: false }>
    | Extract<FinanceStripeProviderAccountReconciliationResult, { ok: false }>
    | Extract<FinanceXenditPayoutReconciliationResult, { ok: false }>
    | Extract<FinancePropertyPayoutDispatchResult, { ok: false }>
    | Extract<FinancePaymentSettingsPatchResult, { ok: false }>
    | Extract<FinanceAffiliatePayoutSettingsPatchResult, { ok: false }>,
) {
  return {
    statusCode: result.statusCode,
    code: result.code,
    category:
      result.statusCode === 404
        ? "not_found"
        : result.statusCode === 409
          ? "conflict"
          : result.statusCode === 502
            ? "provider"
            : result.statusCode === 400
              ? "validation"
              : "write_model",
    message: result.message,
  } satisfies FinanceCommandError;
}

export function enforceFinancePropertyReadPolicy(
  request: FastifyRequest,
  reply: FastifyReply,
  propertyId: string,
): boolean {
  const policies = financePropertyReadPolicies(propertyId);
  try {
    enforceAnyFinancePropertyReadPolicy(request, policies);
    return true;
  } catch (error) {
    const accessError = toFinanceAccessError(error, request, propertyId);
    if (!accessError) throw error;
    reply.code(accessError.statusCode).send(accessError);
    return false;
  }
}

export function enforceFinancePropertyWritePolicy(
  request: FastifyRequest,
  reply: FastifyReply,
  propertyId: string,
): boolean {
  const policies = financePropertyWritePolicies(propertyId);
  try {
    enforceAnyFinancePropertyReadPolicy(request, policies);
    return true;
  } catch (error) {
    const accessError = toFinanceAccessError(error, request, propertyId);
    if (!accessError) throw error;
    reply.code(accessError.statusCode).send(accessError);
    return false;
  }
}

function enforceFinanceAffiliateWritePolicy(
  request: FastifyRequest,
  reply: FastifyReply,
  affiliateId: string,
): RequestContext | null {
  try {
    enforceRoutePolicy(request, {
      permission: "affiliate.payout.manage",
      entitlement: {
        product: "affiliate",
        key: "affiliate-payouts",
        resource: {
          product: "affiliate",
          resourceType: "affiliate",
          resourceId: affiliateId,
        },
      },
      resource: {
        product: "affiliate",
        resourceType: "affiliate",
        resourceId: affiliateId,
        allowedRelationships: ["owner", "finance_manager"],
      },
    });
    return requireAuthContext(request);
  } catch (error) {
    const accessError = toFinanceAccessError(error, request, affiliateId);
    if (!accessError) throw error;
    reply.code(accessError.statusCode).send(accessError);
    return null;
  }
}

function enforceFinanceAffiliatePolicy(
  request: FastifyRequest,
  reply: FastifyReply,
  affiliateId: string,
): boolean {
  const policy = financeAffiliatePolicy(affiliateId);
  try {
    enforceRoutePolicy(request, policy);
    return true;
  } catch (error) {
    const accessError = toFinanceAffiliateAccessError(error, request, affiliateId);
    if (!accessError) throw error;
    reply.code(accessError.statusCode).send(accessError);
    return false;
  }
}

function financePropertyReadPolicies(propertyId: string): RouteAuthorizationPolicy[] {
  const resourceTypes = ["pms_property", "property"] as const;
  return resourceTypes.flatMap((resourceType) => [
    {
      permission: "pms.finance.read",
      entitlement: {
        product: "pms",
        key: "property-management",
        resource: {
          product: "pms",
          resourceType,
          resourceId: propertyId,
        },
      },
      resource: {
        product: "pms",
        resourceType,
        resourceId: propertyId,
        allowedRelationships: ["owner", "operator", "finance_manager"],
      },
    },
    {
      permission: "pms.finance.read",
      entitlement: {
        product: "booking",
        key: "direct-booking-finance",
        resource: {
          product: "pms",
          resourceType,
          resourceId: propertyId,
        },
      },
      resource: {
        product: "pms",
        resourceType,
        resourceId: propertyId,
        allowedRelationships: ["owner", "operator", "finance_manager"],
      },
    },
  ]);
}

function financeAffiliatePolicy(affiliateId: string): RouteAuthorizationPolicy {
  return {
    permission: "affiliate.payout.manage",
    entitlement: {
      product: "affiliate",
      key: "affiliate-payouts",
      resource: {
        product: "affiliate",
        resourceType: "affiliate",
        resourceId: affiliateId,
      },
    },
    resource: {
      product: "affiliate",
      resourceType: "affiliate",
      resourceId: affiliateId,
      allowedRelationships: ["owner", "finance_manager"],
    },
  };
}

function financePropertyWritePolicies(propertyId: string): RouteAuthorizationPolicy[] {
  const resourceTypes = ["pms_property", "property"] as const;
  return resourceTypes.flatMap((resourceType) => [
    {
      permission: "pms.operations.manage",
      entitlement: {
        product: "pms",
        key: "property-management",
        resource: {
          product: "pms",
          resourceType,
          resourceId: propertyId,
        },
      },
      resource: {
        product: "pms",
        resourceType,
        resourceId: propertyId,
        allowedRelationships: ["owner", "finance_manager"],
      },
    },
    {
      permission: "booking.settings.manage",
      entitlement: {
        product: "booking",
        key: "direct-booking-finance",
        resource: {
          product: "pms",
          resourceType,
          resourceId: propertyId,
        },
      },
      resource: {
        product: "pms",
        resourceType,
        resourceId: propertyId,
        allowedRelationships: ["owner", "finance_manager"],
      },
    },
  ]);
}

function toFinanceAffiliateAccessError(
  error: unknown,
  request: FastifyRequest,
  affiliateId: string,
): FinanceAccessError | null {
  if (!isStatusError(error)) return null;

  if (error.statusCode === 401) {
    return {
      statusCode: 401,
      code: "unauthenticated",
      category: "authentication",
      message: "A valid access token is required.",
    };
  }

  if (error.statusCode !== 403) return null;

  const code = toFinanceAffiliateAuthorizationCode(error.message, request, affiliateId);
  return {
    statusCode: 403,
    code,
    category: "authorization",
    message: toFinanceAffiliateAuthorizationMessage(code),
  };
}

function toFinanceAffiliateAuthorizationCode(
  message: string,
  request: FastifyRequest,
  affiliateId: string,
): Exclude<FinanceAccessError["code"], "unauthenticated"> {
  const normalized = message.toLowerCase();
  if (normalized.includes("permission")) return "missing_permission";
  if (hasActiveFinanceAffiliateEntitlement(request, affiliateId)) return "missing_resource_access";
  if (hasInactiveFinanceAffiliateEntitlement(request, affiliateId)) return "inactive_entitlement";
  return "missing_entitlement";
}

function toFinanceAffiliateAuthorizationMessage(
  code: Exclude<FinanceAccessError["code"], "unauthenticated">,
): string {
  switch (code) {
    case "missing_permission":
      return "Missing required affiliate payout permission.";
    case "inactive_entitlement":
      return "Affiliate payout entitlement is not active.";
    case "missing_entitlement":
      return "Missing active affiliate payout entitlement.";
    case "missing_resource_access":
      return "Missing affiliate payout resource access.";
  }
}

function enforceAnyFinancePropertyReadPolicy(
  request: FastifyRequest,
  policies: RouteAuthorizationPolicy[],
): void {
  const errors: unknown[] = [];
  for (const policy of policies) {
    try {
      enforceRoutePolicy(request, policy);
      return;
    } catch (error) {
      errors.push(error);
      if (isStatusError(error) && error.statusCode === 401) throw error;
    }
  }
  throw errors[0] ?? new Error("Finance property read policy denied.");
}

function hasInactiveFinanceAffiliateEntitlement(
  request: FastifyRequest,
  affiliateId: string,
): boolean {
  return (
    request.authContext?.entitlements.some((entitlement) => {
      if (!isFinanceAffiliateEntitlement(entitlement.product, entitlement.key)) return false;
      if (entitlement.status === "active") return false;
      return entitlementAppliesToFinanceAffiliate(entitlement.resource, affiliateId);
    }) ?? false
  );
}

function hasActiveFinanceAffiliateEntitlement(
  request: FastifyRequest,
  affiliateId: string,
): boolean {
  return (
    request.authContext?.entitlements.some((entitlement) => {
      if (!isFinanceAffiliateEntitlement(entitlement.product, entitlement.key)) return false;
      if (entitlement.status !== "active") return false;
      return entitlementAppliesToFinanceAffiliate(entitlement.resource, affiliateId);
    }) ?? false
  );
}

function isFinanceAffiliateEntitlement(product: string, key: string): boolean {
  return product === "affiliate" && key === "affiliate-payouts";
}

function entitlementAppliesToFinanceAffiliate(
  resource: { product: string; resourceType: string; resourceId: string } | undefined,
  affiliateId: string,
): boolean {
  if (!resource) return true;
  return (
    resource.product === "affiliate" &&
    resource.resourceType === "affiliate" &&
    resource.resourceId === affiliateId
  );
}

function toFinanceAccessError(
  error: unknown,
  request: FastifyRequest,
  propertyId: string,
): FinanceAccessError | null {
  if (!isStatusError(error)) return null;

  if (error.statusCode === 401) {
    return {
      statusCode: 401,
      code: "unauthenticated",
      category: "authentication",
      message: "A valid access token is required.",
    };
  }

  if (error.statusCode !== 403) return null;

  const code = toFinanceAuthorizationCode(error.message, request, propertyId);
  return {
    statusCode: 403,
    code,
    category: "authorization",
    message: toFinanceAuthorizationMessage(code),
  };
}

function toFinanceAuthorizationCode(
  message: string,
  request: FastifyRequest,
  propertyId: string,
): Exclude<FinanceAccessError["code"], "unauthenticated"> {
  const normalized = message.toLowerCase();
  if (normalized.includes("permission")) return "missing_permission";
  if (hasActiveFinanceEntitlement(request, propertyId)) return "missing_resource_access";
  if (hasInactiveFinanceEntitlement(request, propertyId)) return "inactive_entitlement";
  return "missing_entitlement";
}

function toFinanceAuthorizationMessage(
  code: Exclude<FinanceAccessError["code"], "unauthenticated">,
): string {
  switch (code) {
    case "missing_permission":
      return "Missing required finance permission.";
    case "inactive_entitlement":
      return "Finance property-management entitlement is not active.";
    case "missing_entitlement":
      return "Missing active finance property-management entitlement.";
    case "missing_resource_access":
      return "Missing finance property access.";
  }
}

function hasInactiveFinanceEntitlement(request: FastifyRequest, propertyId: string): boolean {
  return (
    request.authContext?.entitlements.some((entitlement) => {
      if (!isFinancePropertyReadEntitlement(entitlement.product, entitlement.key)) return false;
      if (entitlement.status === "active") return false;
      return entitlementAppliesToFinanceProperty(entitlement.resource, propertyId);
    }) ?? false
  );
}

function hasActiveFinanceEntitlement(request: FastifyRequest, propertyId: string): boolean {
  return (
    request.authContext?.entitlements.some((entitlement) => {
      if (!isFinancePropertyReadEntitlement(entitlement.product, entitlement.key)) return false;
      if (entitlement.status !== "active") return false;
      return entitlementAppliesToFinanceProperty(entitlement.resource, propertyId);
    }) ?? false
  );
}

function isFinancePropertyReadEntitlement(product: string, key: string): boolean {
  return (
    (product === "pms" && key === "property-management") ||
    (product === "booking" && key === "direct-booking-finance")
  );
}

function entitlementAppliesToFinanceProperty(
  resource: { product: string; resourceType: string; resourceId: string } | undefined,
  propertyId: string,
): boolean {
  if (!resource) return true;
  return (
    resource.product === "pms" &&
    (resource.resourceType === "pms_property" || resource.resourceType === "property") &&
    resource.resourceId === propertyId
  );
}

function toPmsPaymentSettingsFacade(
  settings: FinancePaymentSettingsReadModel,
  policy: CancellationPolicy,
): {
  paymentSettings: {
    stripeConnectAccountId: null;
    stripeConnectOnboarded: boolean;
    platformFeeType: "none";
    platformFeeValue: 0;
    platformFeeWithAffiliate: 0;
    payAtPropertyEnabled: boolean;
    onlineCardPayment: boolean;
    bankTransfer: boolean;
    xenditPaymentsEnabled: boolean;
    paymentProvider: "stripe" | "xendit" | "vayada";
    xenditChannelCode: null;
    xenditAccountNumber: null;
    xenditAccountHolderName: null;
    defaultCurrency: string;
  };
  cancellationPolicy: {
    freeCancellationDays: number;
    partialRefundPct: number;
  };
} {
  const enabledMethods = settings.paymentsEnabled ? settings.acceptedMethods : [];
  const canChargeOnline = settings.paymentsEnabled && financeProviderCanCharge(settings);
  return {
    paymentSettings: {
      stripeConnectAccountId: null,
      stripeConnectOnboarded:
        settings.providerAccount.provider === "stripe" &&
        settings.providerAccount.onboardingStatus === "completed",
      platformFeeType: "none",
      platformFeeValue: 0,
      platformFeeWithAffiliate: 0,
      payAtPropertyEnabled: enabledMethods.includes("pay_at_property"),
      onlineCardPayment:
        enabledMethods.includes("card") && canChargeOnline && settings.paymentProvider !== "xendit",
      bankTransfer: enabledMethods.includes("bank_transfer"),
      xenditPaymentsEnabled:
        enabledMethods.includes("xendit") &&
        canChargeOnline &&
        settings.paymentProvider === "xendit",
      paymentProvider: pmsFacadePaymentProvider(settings.paymentProvider),
      xenditChannelCode: null,
      xenditAccountNumber: null,
      xenditAccountHolderName: null,
      defaultCurrency: settings.defaultCurrency,
    },
    cancellationPolicy: {
      freeCancellationDays: policy.freeCancellationDays,
      partialRefundPct: policy.partialRefundPercent,
    },
  };
}

function financeProviderCanCharge(settings: FinancePaymentSettingsReadModel): boolean {
  return (
    settings.providerAccount.status === "active" &&
    settings.providerAccount.onboardingStatus === "completed" &&
    settings.providerAccount.chargesEnabled
  );
}

function pmsFacadePaymentProvider(
  provider: FinanceRoutePaymentProvider,
): "stripe" | "xendit" | "vayada" {
  if (provider === "xendit" || provider === "vayada") return provider;
  return "stripe";
}

function isStatusError(error: unknown): error is Error & { statusCode: number } {
  return (
    error instanceof Error &&
    "statusCode" in error &&
    typeof (error as { statusCode?: unknown }).statusCode === "number"
  );
}

function paymentProvider(value: unknown): FinanceRoutePaymentProvider {
  if (
    value === "stripe" ||
    value === "xendit" ||
    value === "vayada" ||
    value === "manual" ||
    value === "bank_transfer"
  ) {
    return value;
  }
  return "manual";
}

function affiliatePayoutProvider(value: unknown): FinanceAffiliatePayoutProvider {
  if (value === "stripe" || value === "bank_transfer" || value === "manual") return value;
  if (value === "bank" || value === "bank_account") return "bank_transfer";
  return "manual";
}

function affiliatePayoutProviderBody(value: unknown): FinanceAffiliatePayoutProvider | undefined {
  if (value === "stripe" || value === "bank_transfer" || value === "manual") return value;
  return undefined;
}

function payoutMethodValue(value: FinanceAffiliatePayoutProvider): string {
  return value;
}

function affiliatePayoutSchedule(value: unknown): FinanceAffiliatePayoutSchedule {
  const scheduleType =
    value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)["type"]
      : value;
  if (scheduleType === "manual" || scheduleType === "monthly" || scheduleType === "threshold") {
    return scheduleType;
  }
  return "monthly";
}

function affiliatePayoutScheduleBody(value: unknown): FinanceAffiliatePayoutSchedule | undefined {
  if (value === "manual" || value === "monthly" || value === "threshold") return value;
  return undefined;
}

function paymentMethods(value: unknown): FinanceRoutePaymentMethod[] {
  return stringArray(value).map((method) => {
    switch (method) {
      case "card":
      case "pay_at_property":
      case "xendit":
      case "cash":
      case "bank_transfer":
      case "paypal":
      case "manual_card":
      case "wallet":
        return method;
      default:
        return "other";
    }
  });
}

function providerAccountStatus(value: unknown): FinanceProviderAccountStatus {
  if (
    value === "pending" ||
    value === "active" ||
    value === "restricted" ||
    value === "suspended" ||
    value === "disabled"
  ) {
    return value;
  }
  return "setup_incomplete";
}

function providerOnboardingStatus(value: unknown): FinanceProviderOnboardingStatus {
  if (
    value === "invited" ||
    value === "in_review" ||
    value === "completed" ||
    value === "requires_action"
  ) {
    return value;
  }
  return "not_started";
}

function currencyCode(value: unknown): string {
  return typeof value === "string" && /^[A-Z]{3}$/.test(value) ? value : "EUR";
}

function stringArray(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.filter((entry): entry is string => typeof entry === "string");
  }
  return [];
}

function jsonPolicy(value: unknown): FinanceJsonPolicy {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).filter(
      (entry): entry is [string, string | number | boolean | null] => {
        const [, policyValue] = entry;
        return (
          policyValue === null ||
          typeof policyValue === "string" ||
          typeof policyValue === "number" ||
          typeof policyValue === "boolean"
        );
      },
    ),
  );
}

function financeJsonObject(value: unknown): FinanceJsonObject {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).flatMap(([key, entry]) => {
      const jsonValue = toFinanceJsonValue(entry);
      return jsonValue === undefined ? [] : [[key, jsonValue]];
    }),
  );
}

function parseJsonObject(value: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function optionalString(value: Record<string, unknown>, key: string): string | undefined {
  const entry = value[key];
  return typeof entry === "string" && entry.trim() ? entry.trim() : undefined;
}

function xenditValidationStatus(value: string | undefined): "valid" | "invalid" | "unknown" {
  const normalized = value?.toLowerCase();
  if (normalized === "success" || normalized === "valid" || normalized === "found") return "valid";
  if (normalized === "failed" || normalized === "invalid" || normalized === "not_found") {
    return "invalid";
  }
  return "unknown";
}

function toFinanceJsonValue(value: unknown): FinanceJsonObject[string] | undefined {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return value;
  }
  if (Array.isArray(value)) {
    return value.flatMap((entry) => {
      const jsonValue = toFinanceJsonValue(entry);
      return jsonValue === undefined ? [] : [jsonValue];
    });
  }
  if (typeof value === "object") return financeJsonObject(value);
  return undefined;
}

function utcDateTime(value: unknown, fallback: string): string {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "string" && value.trim()) return value;
  return fallback;
}

function nullableUtcDateTime(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const timestamp = utcDateTime(value, "");
  return timestamp || null;
}

function decimalString(value: unknown): string {
  if (typeof value === "number" && Number.isFinite(value)) return value.toFixed(2);
  if (typeof value === "string" && value.trim()) return value;
  return "0.00";
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function stableJson(value: unknown): string {
  return JSON.stringify(sortJson(value));
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJson);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => [key, sortJson(entry)]),
  );
}

function payoutStatus(value: unknown): FinancePayout["payoutStatus"] {
  return optionalEnum(value, FINANCE_PAYOUT_STATUSES) ?? "pending";
}

function payoutOwnerScope(value: unknown): FinancePayout["ownerScope"] {
  if (value === "organization" || value === "platform") return value;
  return "property";
}

function reconciliationSubjectType(value: unknown): FinanceReconciliationItem["subjectType"] {
  return optionalEnum(value, FINANCE_RECONCILIATION_SUBJECT_TYPES) ?? "payment";
}

function reconciliationReceiptStatus(value: unknown): FinanceReconciliationReceiptStatus {
  return optionalEnum(value, FINANCE_RECONCILIATION_RECEIPT_STATUSES) ?? "missing";
}

function reconciliationJobStatus(value: unknown): FinanceReconciliationJobStatus {
  return optionalEnum(value, FINANCE_RECONCILIATION_JOB_STATUSES) ?? "idle";
}

function reconciliationRecommendedAction(value: unknown): FinanceReconciliationRecommendedAction {
  if (
    value === "enqueue_reconcile" ||
    value === "manual_review" ||
    value === "refresh_provider_state"
  ) {
    return value;
  }
  return "none";
}

function totalFromRows(rows: Array<{ total: string | number }>): number {
  if (rows.length === 0) return 0;
  const total = Number(rows[0]?.total ?? 0);
  return Number.isFinite(total) ? total : 0;
}

async function totalForPossiblyEmptyPage<T extends { total: string | number }>(
  pool: FinanceQueryExecutor,
  rows: T[],
  offset: number,
  fallback: { sql: string; values: readonly unknown[] },
): Promise<number> {
  const pageTotal = totalFromRows(rows);
  if (rows.length > 0 || offset === 0) return pageTotal;
  const result = await pool.query<{ total: string }>(fallback.sql, fallback.values);
  const total = Number(result.rows[0]?.total ?? 0);
  return Number.isFinite(total) ? total : 0;
}

function queryRecord(query: unknown): Record<string, string | undefined> {
  if (!query || typeof query !== "object") return {};
  return Object.fromEntries(
    Object.entries(query as Record<string, unknown>).flatMap(([key, value]) => {
      if (typeof value === "string") return [[key, value]];
      if (typeof value === "number") return [[key, String(value)]];
      return [];
    }),
  );
}

function optionalEnum<const T extends readonly string[]>(
  value: unknown,
  allowed: T,
): T[number] | undefined {
  if (typeof value !== "string") return undefined;
  return (allowed as readonly string[]).includes(value) ? (value as T[number]) : undefined;
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function likeSearch(value: string | undefined): string | null {
  return value ? `%${value.replaceAll("%", "\\%").replaceAll("_", "\\_")}%` : null;
}

function clampLimit(value: unknown): number {
  const parsed = typeof value === "string" ? Number(value) : NaN;
  if (!Number.isInteger(parsed)) return 50;
  return Math.min(500, Math.max(1, parsed));
}

function parseOffset(value: unknown): number {
  const parsed = typeof value === "string" ? Number(value) : NaN;
  if (!Number.isInteger(parsed) || parsed < 0) return 0;
  return parsed;
}

function invalidQuery(
  code: FinanceValidationError["code"],
  message: string,
): FinanceValidationError {
  return {
    statusCode: 400,
    code,
    category: "validation",
    message,
  };
}
