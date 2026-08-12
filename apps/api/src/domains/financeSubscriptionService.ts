import { createHash } from "node:crypto";

import type { RoomInventoryReadPort } from "@vayada/domain-pms";
import {
  FINANCE_FIXED_PLAN_CURRENCY,
  fixedPlanAmountMinor,
  type CreateFixedPlanCheckoutCommand,
  type CreateFixedPlanCheckoutResult,
  type FinancePlanStatusReadModel,
  type FinanceSubscriptionCommandError,
  type FinanceSubscriptionCommandResult,
  type FinanceSubscriptionService,
  type OpenFinanceCustomerPortalCommand,
  type OpenFinanceCustomerPortalResult,
  type ScheduleCommissionPlanCommand,
  type ScheduleCommissionPlanResult,
  type SelectCommissionPlanResult,
  type StripeFinanceSubscriptionProvider,
} from "@vayada/domain-finance";

import type {
  FinanceSubscriptionEntitlementRow,
  FinanceSubscriptionStore,
} from "./financeSubscriptionStore.js";

export function createFinanceSubscriptionService(config: {
  store: FinanceSubscriptionStore;
  roomInventory: RoomInventoryReadPort & { close?(): Promise<void> };
  stripe?: StripeFinanceSubscriptionProvider;
  bookingAdminBaseUrl: string;
  now?: () => Date;
  afterPlanChange?: (propertyId: string) => Promise<void>;
}): FinanceSubscriptionService {
  const now = config.now ?? (() => new Date());

  const getPlanStatus = async (
    propertyId: string,
    store: Pick<FinanceSubscriptionStore, "getEntitlement"> = config.store,
  ): Promise<FinancePlanStatusReadModel> => {
    const [entitlement, inventory] = await Promise.all([
      store.getEntitlement(propertyId),
      config.roomInventory.getRoomInventorySnapshot(propertyId),
    ]);
    return planStatus(propertyId, entitlement, inventory?.activeRoomCount ?? 0, now());
  };

  return {
    getPlanStatus,

    async selectCommissionPlan(command) {
      const outcome = await config.store.withPlanMutationLock(
        command.propertyId,
        async (store): Promise<FinanceSubscriptionCommandResult<SelectCommissionPlanResult>> => {
          const replay = await store.findReplay<SelectCommissionPlanResult>(
            "select-commission",
            command,
          );
          if (replay) {
            if ("conflict" in replay) {
              return failure("idempotency_conflict", 409, "This idempotency key was already used.");
            }
            return { ok: true, status: "idempotent_replay", value: replay.result };
          }
          const entitlement = await store.getEntitlement(command.propertyId);
          if (entitlement?.planKey === "fixed") {
            return failure(
              "fixed_plan_already_active",
              409,
              "Use Billing Settings to schedule a change from an active Fixed Plan.",
            );
          }
          if (entitlement?.checkoutSessionRef && isCheckoutPending(entitlement, now())) {
            if (!config.stripe) return stripeNotConfigured();
            try {
              await config.stripe.expireFixedPlanCheckout({
                checkoutSessionId: entitlement.checkoutSessionRef,
                idempotencyKey: `fixed-plan-expire:${entitlement.checkoutSessionRef}:v1`,
              });
            } catch (error) {
              return providerFailure(error);
            }
          }
          const current = await getPlanStatus(command.propertyId, store);
          const value = {
            planStatus: {
              ...current,
              plan: "commission" as const,
              status: "commission" as const,
              checkoutPending: false,
              updatedAt: command.audit.requestedAt,
            },
          };
          const recorded = await store.recordCommissionSelection(command, value);
          return { ok: true, status: recorded.status, value: recorded.result };
        },
      );
      if (outcome.ok) await config.afterPlanChange?.(command.propertyId);
      return outcome;
    },

    async createFixedPlanCheckout(command) {
      if (!config.stripe) return stripeNotConfigured();
      const outcome = await config.store.withPlanMutationLock(
        command.propertyId,
        async (store): Promise<FinanceSubscriptionCommandResult<CreateFixedPlanCheckoutResult>> => {
          const replay = await store.findReplay<CreateFixedPlanCheckoutResult>(
            "fixed-plan-checkout",
            command,
          );
          if (replay) {
            if ("conflict" in replay) {
              return failure("idempotency_conflict", 409, "This idempotency key was already used.");
            }
            return { ok: true, status: "idempotent_replay", value: replay.result };
          }

          const [entitlement, inventory] = await Promise.all([
            store.getEntitlement(command.propertyId),
            config.roomInventory.getRoomInventorySnapshot(command.propertyId),
          ]);
          if (!inventory) {
            return failure("property_not_found", 404, "The property room inventory was not found.");
          }
          if (entitlement?.planKey === "fixed") {
            return failure("fixed_plan_already_active", 409, "The Fixed Plan is already active.");
          }

          const resumableCheckout = pendingCheckout(entitlement, inventory.activeRoomCount, now());
          if (resumableCheckout) {
            return { ok: true, status: "idempotent_replay", value: resumableCheckout };
          }

          try {
            const amountMinor = fixedPlanAmountMinor(inventory.activeRoomCount);
            const session = await config.stripe!.createFixedPlanCheckout({
              propertyId: command.propertyId,
              organizationId: command.organizationId,
              customerEmail: command.customerEmail,
              existingCustomerId: entitlement?.customerRef ?? null,
              activeRoomCount: inventory.activeRoomCount,
              successUrl: billingReturnUrl(config.bookingAdminBaseUrl, "success"),
              cancelUrl: billingReturnUrl(config.bookingAdminBaseUrl, "canceled"),
              idempotencyKey: checkoutProviderIdempotencyKey(
                command.propertyId,
                command.idempotencyKey,
              ),
            });
            const value = {
              ...session,
              currency: FINANCE_FIXED_PLAN_CURRENCY,
              amountMinor,
              activeRoomCount: inventory.activeRoomCount,
            } satisfies CreateFixedPlanCheckoutResult;
            const recorded = await store.recordCheckout(command, value);
            return { ok: true, status: recorded.status, value: recorded.result };
          } catch (error) {
            return providerFailure(error);
          }
        },
      );
      if (outcome.ok) {
        try {
          await config.afterPlanChange?.(command.propertyId);
        } catch (error) {
          return providerFailure(error);
        }
      }
      return outcome;
    },

    async openCustomerPortal(command) {
      const replay = await config.store.findReplay<OpenFinanceCustomerPortalResult>(
        "customer-portal",
        command,
      );
      if (replay) {
        return "conflict" in replay
          ? failure("idempotency_conflict", 409, "This idempotency key was already used.")
          : { ok: true, status: "idempotent_replay", value: replay.result };
      }
      if (!config.stripe) return stripeNotConfigured();
      const entitlement = await config.store.getEntitlement(command.propertyId);
      if (!entitlement?.customerRef) {
        return failure(
          "subscription_not_active",
          409,
          "A Stripe billing customer is not available for this property.",
        );
      }
      try {
        const value = await config.stripe.createCustomerPortal({
          customerId: entitlement.customerRef,
          returnUrl: billingReturnUrl(config.bookingAdminBaseUrl),
          idempotencyKey: command.idempotencyKey,
        });
        const recorded = await config.store.recordPortal(command, value);
        return { ok: true, status: recorded.status, value: recorded.result };
      } catch (error) {
        return providerFailure(error);
      }
    },

    async scheduleCommissionPlan(command) {
      const replay = await config.store.findReplay<{ currentPeriodEnd: string | null }>(
        "schedule-commission",
        command,
      );
      if (replay && "conflict" in replay) {
        return failure("idempotency_conflict", 409, "This idempotency key was already used.");
      }
      if (replay) {
        return {
          ok: true,
          status: "idempotent_replay",
          value: { planStatus: await getPlanStatus(command.propertyId) },
        };
      }
      if (!config.stripe) return stripeNotConfigured();
      const entitlement = await config.store.getEntitlement(command.propertyId);
      if (entitlement?.planKey !== "fixed" || !entitlement.subscriptionRef) {
        return failure(
          "subscription_not_active",
          409,
          "The property does not have an active Fixed Plan subscription.",
        );
      }
      try {
        const snapshot = await config.stripe.cancelAtPeriodEnd({
          subscriptionId: entitlement.subscriptionRef,
          idempotencyKey: command.idempotencyKey,
        });
        if (
          !snapshot.fixedPlanVerified ||
          snapshot.propertyId !== command.propertyId ||
          snapshot.organizationId !== command.organizationId
        ) {
          throw new Error("Stripe subscription does not match this property's Fixed Plan.");
        }
        await config.store.recordCancellation(command, snapshot);
        await config.afterPlanChange?.(command.propertyId);
        return {
          ok: true,
          status: "updated",
          value: { planStatus: await getPlanStatus(command.propertyId) },
        };
      } catch (error) {
        return providerFailure(error);
      }
    },

    async close() {
      await config.store.close();
      await config.roomInventory.close?.();
    },
  };
}

function planStatus(
  propertyId: string,
  entitlement: FinanceSubscriptionEntitlementRow | null,
  activeRoomCount: number,
  now: Date,
): FinancePlanStatusReadModel {
  const fixed = entitlement?.planKey === "fixed";
  const cancelAtPeriodEnd = fixed && Boolean(entitlement?.cancelAtPeriodEnd);
  const providerPastDue = ["past_due", "unpaid"].includes(
    entitlement?.providerSubscriptionStatus ?? "",
  );
  const checkoutPending = !fixed && isCheckoutPending(entitlement, now);
  const currentPeriodEnd = iso(entitlement?.periodEnd);
  return {
    propertyId,
    plan: fixed ? "fixed" : "commission",
    status: fixed
      ? cancelAtPeriodEnd
        ? "cancel_at_period_end"
        : providerPastDue
          ? "past_due"
          : "active"
      : checkoutPending
        ? "checkout_pending"
        : "commission",
    currency: FINANCE_FIXED_PLAN_CURRENCY,
    activeRoomCount,
    amountMinor: fixedPlanAmountMinor(activeRoomCount),
    currentPeriodStart: iso(entitlement?.periodStart),
    currentPeriodEnd,
    nextBillingDate: fixed && !cancelAtPeriodEnd ? currentPeriodEnd : null,
    cancelAtPeriodEnd,
    checkoutPending,
    customerPortalAvailable: Boolean(entitlement?.customerRef),
    activatedAt: iso(entitlement?.startsAt),
    updatedAt: iso(entitlement?.updatedAt) ?? now.toISOString(),
  };
}

function pendingCheckout(
  entitlement: FinanceSubscriptionEntitlementRow | null,
  activeRoomCount: number,
  now: Date,
): CreateFixedPlanCheckoutResult | null {
  if (!entitlement?.checkoutSessionRef || !isCheckoutPending(entitlement, now)) return null;
  const metadata = object(entitlement.metadata);
  const checkoutUrl = string(metadata["checkoutUrl"]);
  if (!checkoutUrl) return null;
  const checkoutRoomCount = nonNegativeInteger(entitlement.activeRoomCount, activeRoomCount);
  return {
    checkoutSessionId: entitlement.checkoutSessionRef,
    checkoutUrl,
    currency: FINANCE_FIXED_PLAN_CURRENCY,
    amountMinor: entitlement.amountMinor ?? fixedPlanAmountMinor(checkoutRoomCount),
    activeRoomCount: checkoutRoomCount,
  };
}

function isCheckoutPending(
  entitlement: FinanceSubscriptionEntitlementRow | null,
  now: Date,
): boolean {
  if (["canceled", "incomplete_expired"].includes(entitlement?.providerSubscriptionStatus ?? "")) {
    return false;
  }
  return Boolean(
    entitlement?.checkoutSessionRef &&
    now.getTime() - date(entitlement.updatedAt, now).getTime() < 24 * 60 * 60 * 1_000,
  );
}

function checkoutProviderIdempotencyKey(propertyId: string, attemptIdempotencyKey: string): string {
  const attemptHash = createHash("sha256").update(attemptIdempotencyKey).digest("hex");
  return `fixed-plan-checkout:${propertyId}:${attemptHash}:v1`;
}

function failure<T>(
  code: FinanceSubscriptionCommandError["code"],
  statusCode: FinanceSubscriptionCommandError["statusCode"],
  message: string,
): FinanceSubscriptionCommandResult<T> {
  return { ok: false, code, statusCode, message };
}

function stripeNotConfigured<T>(): FinanceSubscriptionCommandResult<T> {
  return failure("stripe_not_configured", 503, "Stripe subscriptions are not configured.");
}

function providerFailure<T>(error: unknown): FinanceSubscriptionCommandResult<T> {
  if (
    error &&
    typeof error === "object" &&
    "code" in error &&
    error.code === "idempotency_conflict"
  ) {
    return failure("idempotency_conflict", 409, "This idempotency key was already used.");
  }
  return failure(
    "stripe_unavailable",
    502,
    error instanceof Error ? error.message : "Stripe subscriptions are unavailable.",
  );
}

function billingReturnUrl(baseUrl: string, outcome?: "success" | "canceled"): string {
  const url = new URL("/settings", baseUrl);
  if (outcome) url.searchParams.set("billing", outcome);
  else url.searchParams.set("billing", "manage");
  return url.toString();
}

function iso(value: Date | string | null | undefined): string | null {
  if (!value) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

function date(value: Date | string | null | undefined, fallback: Date): Date {
  const parsed = value ? new Date(value) : fallback;
  return Number.isNaN(parsed.getTime()) ? fallback : parsed;
}

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function string(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function nonNegativeInteger(value: unknown, fallback: number): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : fallback;
}
