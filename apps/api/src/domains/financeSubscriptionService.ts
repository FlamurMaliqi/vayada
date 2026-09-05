import { createHash } from "node:crypto";

import type { RoomInventoryReadPort } from "@vayada/domain-pms";
import type { PmsPricingReadPort } from "@vayada/domain-pms";
import {
  FINANCE_FIXED_PLAN_CURRENCY,
  fixedPlanAmountMinor,
  type ActivateFixedPlanByInvoiceCommand,
  type CreateFixedPlanCheckoutCommand,
  type CreateFixedPlanCheckoutResult,
  type FinanceBillingDetails,
  type FinanceBillingOverview,
  type FinancePaymentCollectionMethod,
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
  pricing: Pick<PmsPricingReadPort, "getPropertyPricingCurrency">;
  returnBaseUrls: { bookingAdmin: string; pms?: string };
  now?: () => Date;
  afterPlanChange?: (propertyId: string) => Promise<void>;
}): FinanceSubscriptionService {
  const now = config.now ?? (() => new Date());

  const getPlanStatus = async (
    propertyId: string,
    store: Pick<FinanceSubscriptionStore, "getEntitlement"> = config.store,
  ): Promise<FinancePlanStatusReadModel> => {
    const [entitlement, inventory, pricing] = await Promise.all([
      store.getEntitlement(propertyId),
      config.roomInventory.getRoomInventorySnapshot(propertyId),
      config.pricing.getPropertyPricingCurrency(propertyId),
    ]);
    return planStatus(
      propertyId,
      entitlement,
      inventory?.activeRoomCount ?? 0,
      pricing?.currency ?? entitlement?.currency ?? FINANCE_FIXED_PLAN_CURRENCY,
      now(),
    );
  };

  const getBillingOverview = async (propertyId: string): Promise<FinanceBillingOverview> => {
    const [entitlement, plan] = await Promise.all([
      config.store.getEntitlement(propertyId),
      getPlanStatus(propertyId),
    ]);
    const metadata = object(entitlement?.metadata);
    const customerBilling =
      config.stripe && entitlement?.customerRef
        ? await config.stripe.getCustomerBilling(entitlement.customerRef)
        : { savedCard: null };
    const invoices =
      config.stripe && entitlement?.customerRef
        ? await config.stripe.listInvoices(entitlement.customerRef)
        : [];
    return {
      propertyId,
      planStatus: plan,
      paymentMethod: metadata["paymentMethod"] === "bank_transfer" ? "bank_transfer" : "card",
      savedCard: customerBilling.savedCard,
      billingDetails: billingDetails(metadata["billingDetails"]),
      invoices,
    };
  };

  const activateFixedPlan = async (
    command: ActivateFixedPlanByInvoiceCommand,
    paymentMethod: FinancePaymentCollectionMethod,
  ): Promise<FinanceSubscriptionCommandResult<FinanceBillingOverview>> => {
    if (!config.stripe) return stripeNotConfigured();
    const operation = paymentMethod === "card" ? "fixed-plan-card" : "fixed-plan-invoice";
    const outcome = await config.store.withPlanMutationLock(
      command.propertyId,
      async (store): Promise<FinanceSubscriptionCommandResult<FinanceBillingOverview>> => {
        const replay = await store.findReplay<FinanceBillingOverview>(operation, command);
        if (replay) {
          return "conflict" in replay
            ? failure("idempotency_conflict", 409, "This idempotency key was already used.")
            : { ok: true, status: "idempotent_replay", value: replay.result };
        }
        const [entitlement, inventory, pricing] = await Promise.all([
          store.getEntitlement(command.propertyId),
          config.roomInventory.getRoomInventorySnapshot(command.propertyId),
          config.pricing.getPropertyPricingCurrency(command.propertyId),
        ]);
        if (!inventory) {
          return failure("property_not_found", 404, "The property room inventory was not found.");
        }
        if (entitlement?.planKey === "fixed") {
          return failure("fixed_plan_already_active", 409, "The Fixed Plan is already active.");
        }
        if (entitlement?.checkoutSessionRef && isCheckoutPending(entitlement, now())) {
          try {
            await config.stripe!.expireFixedPlanCheckout({
              checkoutSessionId: entitlement.checkoutSessionRef,
              idempotencyKey: `fixed-plan-expire:${entitlement.checkoutSessionRef}:v1`,
            });
          } catch (error) {
            return providerFailure(error);
          }
        }
        if (
          !entitlement?.customerRef ||
          object(entitlement.metadata)["paymentMethod"] !== paymentMethod
        ) {
          return failure(
            "billing_configuration_missing",
            409,
            `Save billing details and select ${paymentMethod === "card" ? "card" : "bank transfer"} before switching plans.`,
          );
        }
        try {
          if (paymentMethod === "card") {
            const customer = await config.stripe!.getCustomerBilling(entitlement.customerRef);
            if (!customer.savedCard) {
              return failure(
                "billing_configuration_missing",
                409,
                "Add a card in the secure billing portal before switching plans.",
              );
            }
          }
          const currency = pricing?.currency ?? entitlement.currency ?? FINANCE_FIXED_PLAN_CURRENCY;
          const amountMinor = fixedPlanAmountOrNull(inventory.activeRoomCount, currency);
          if (amountMinor === null) {
            return failure(
              "billing_configuration_missing",
              409,
              `The Fixed Plan is not available in ${currency} yet.`,
            );
          }
          const current = await getBillingOverview(command.propertyId);
          const input = {
            propertyId: command.propertyId,
            organizationId: command.organizationId,
            customerId: entitlement.customerRef,
            activeRoomCount: inventory.activeRoomCount,
            currency,
            billingCycleAnchor: nextMonthlyBillingAnchor(now()).toISOString(),
            idempotencyKey: activationProviderIdempotencyKey(
              command.propertyId,
              paymentMethod,
              entitlement.updatedAt,
            ),
          };
          const snapshot =
            paymentMethod === "card"
              ? await config.stripe!.createFixedPlanCardSubscription(input)
              : await config.stripe!.createFixedPlanInvoiceSubscription(input);
          if (
            !snapshot.fixedPlanVerified ||
            snapshot.propertyId !== command.propertyId ||
            snapshot.organizationId !== command.organizationId ||
            snapshot.currency !== currency ||
            !["active", "trialing"].includes(snapshot.status)
          ) {
            throw new Error(
              "Stripe subscription does not match this property's active Fixed Plan.",
            );
          }
          const value: FinanceBillingOverview = {
            ...current,
            planStatus: {
              ...current.planStatus,
              plan: "fixed",
              status: "active",
              currency,
              activeRoomCount: inventory.activeRoomCount,
              amountMinor,
              currentPeriodStart: snapshot.currentPeriodStart,
              currentPeriodEnd: snapshot.currentPeriodEnd,
              nextBillingDate: snapshot.currentPeriodEnd,
              cancelAtPeriodEnd: false,
              checkoutPending: false,
              activatedAt: command.audit.requestedAt,
              updatedAt: command.audit.requestedAt,
            },
          };
          const recorded = await store.recordFixedActivation(
            command,
            snapshot,
            value,
            paymentMethod,
          );
          return { ok: true, status: recorded.status, value: recorded.result };
        } catch (error) {
          return providerFailure(error);
        }
      },
    );
    if (outcome.ok) await config.afterPlanChange?.(command.propertyId);
    return outcome;
  };

  return {
    getPlanStatus,
    getBillingOverview,

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
            const pricing = await config.pricing.getPropertyPricingCurrency(command.propertyId);
            const currency =
              pricing?.currency ?? entitlement?.currency ?? FINANCE_FIXED_PLAN_CURRENCY;
            const amountMinor = fixedPlanAmountOrNull(inventory.activeRoomCount, currency);
            if (amountMinor === null) {
              return failure(
                "billing_configuration_missing",
                409,
                `The Fixed Plan is not available in ${currency} yet.`,
              );
            }
            const returnBaseUrl =
              command.returnSurface === "pms"
                ? config.returnBaseUrls.pms
                : config.returnBaseUrls.bookingAdmin;
            if (!returnBaseUrl) throw new Error("PMS billing return origin is not configured.");
            const session = await config.stripe!.createFixedPlanCheckout({
              propertyId: command.propertyId,
              organizationId: command.organizationId,
              customerEmail: command.customerEmail,
              existingCustomerId: entitlement?.customerRef ?? null,
              activeRoomCount: inventory.activeRoomCount,
              currency,
              billingCycleAnchor: nextMonthlyBillingAnchor(now()).toISOString(),
              successUrl: billingReturnUrl(returnBaseUrl, command.returnSurface, "success"),
              cancelUrl: billingReturnUrl(returnBaseUrl, command.returnSurface, "canceled"),
              idempotencyKey: checkoutProviderIdempotencyKey(
                command.propertyId,
                command.idempotencyKey,
              ),
            });
            const value = {
              ...session,
              currency,
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

    activateFixedPlanByInvoice: (command) => activateFixedPlan(command, "bank_transfer"),

    activateFixedPlanByCard: (command) => activateFixedPlan(command, "card"),

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
        const returnBaseUrl =
          command.returnSurface === "pms"
            ? config.returnBaseUrls.pms
            : config.returnBaseUrls.bookingAdmin;
        if (!returnBaseUrl) throw new Error("PMS billing return origin is not configured.");
        const value = await config.stripe.createCustomerPortal({
          customerId: entitlement.customerRef,
          returnUrl: billingReturnUrl(returnBaseUrl, command.returnSurface),
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

    async switchToCommissionNow(command) {
      if (!config.stripe) return stripeNotConfigured();
      const outcome = await config.store.withPlanMutationLock(
        command.propertyId,
        async (store): Promise<FinanceSubscriptionCommandResult<FinanceBillingOverview>> => {
          const replay = await store.findReplay<FinanceBillingOverview>(
            "switch-commission-now",
            command,
          );
          if (replay) {
            return "conflict" in replay
              ? failure("idempotency_conflict", 409, "This idempotency key was already used.")
              : { ok: true as const, status: "idempotent_replay" as const, value: replay.result };
          }
          const entitlement = await store.getEntitlement(command.propertyId);
          if (entitlement?.planKey !== "fixed" || !entitlement.subscriptionRef) {
            return failure(
              "subscription_not_active",
              409,
              "The property does not have an active Fixed Plan subscription.",
            );
          }
          try {
            const current = await getBillingOverview(command.propertyId);
            const snapshot = await config.stripe!.cancelImmediately({
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
            const value = {
              ...current,
              planStatus: {
                ...current.planStatus,
                plan: "commission" as const,
                status: "commission" as const,
                currentPeriodStart: null,
                currentPeriodEnd: null,
                nextBillingDate: null,
                cancelAtPeriodEnd: false,
                checkoutPending: false,
                updatedAt: command.audit.requestedAt,
              },
            };
            const recorded = await store.recordImmediateCommission(command, snapshot, value);
            return { ok: true as const, status: recorded.status, value: recorded.result };
          } catch (error) {
            return providerFailure<FinanceBillingOverview>(error);
          }
        },
      );
      if (outcome.ok) await config.afterPlanChange?.(command.propertyId);
      return outcome.ok ? { ...outcome, value: { planStatus: outcome.value.planStatus } } : outcome;
    },

    async updateBillingDetails(command) {
      const replay = await config.store.findReplay<FinanceBillingOverview>(
        "billing-details",
        command,
      );
      if (replay) {
        return "conflict" in replay
          ? failure("idempotency_conflict", 409, "This idempotency key was already used.")
          : { ok: true, status: "idempotent_replay", value: replay.result };
      }
      try {
        const current = await getBillingOverview(command.propertyId);
        const entitlement = await config.store.getEntitlement(command.propertyId);
        const customer = config.stripe
          ? await config.stripe.upsertCustomer({
              customerId: entitlement?.customerRef ?? null,
              propertyId: command.propertyId,
              organizationId: command.organizationId,
              billingDetails: command.billingDetails,
              idempotencyKey: command.idempotencyKey,
            })
          : { customerId: entitlement?.customerRef ?? null };
        const value = {
          ...current,
          planStatus: {
            ...current.planStatus,
            customerPortalAvailable: Boolean(customer.customerId),
          },
          billingDetails: command.billingDetails,
        };
        const recorded = await config.store.recordBillingDetails(
          command,
          customer.customerId,
          value,
        );
        return { ok: true, status: recorded.status, value: recorded.result };
      } catch (error) {
        return providerFailure(error);
      }
    },

    async updatePaymentMethod(command) {
      const replay = await config.store.findReplay<FinanceBillingOverview>(
        "payment-method",
        command,
      );
      if (replay) {
        return "conflict" in replay
          ? failure("idempotency_conflict", 409, "This idempotency key was already used.")
          : { ok: true, status: "idempotent_replay", value: replay.result };
      }
      try {
        const entitlement = await config.store.getEntitlement(command.propertyId);
        if (entitlement?.planKey === "fixed" && entitlement.subscriptionRef) {
          if (!config.stripe) return stripeNotConfigured();
          if (command.paymentMethod === "card" && entitlement.customerRef) {
            const customer = await config.stripe.getCustomerBilling(entitlement.customerRef);
            if (!customer.savedCard) {
              return failure(
                "billing_configuration_missing",
                409,
                "Add a card in the secure billing portal before selecting card billing.",
              );
            }
          }
          const snapshot = await config.stripe.updateCollectionMethod({
            subscriptionId: entitlement.subscriptionRef,
            paymentMethod: command.paymentMethod,
            idempotencyKey: command.idempotencyKey,
          });
          if (
            !snapshot.fixedPlanVerified ||
            snapshot.propertyId !== command.propertyId ||
            snapshot.organizationId !== command.organizationId
          ) {
            throw new Error("Stripe subscription does not match this property's Fixed Plan.");
          }
        }
        const current = await getBillingOverview(command.propertyId);
        const value = { ...current, paymentMethod: command.paymentMethod };
        const recorded = await config.store.recordPaymentMethod(command, value);
        return { ok: true, status: recorded.status, value: recorded.result };
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
  currency: string,
  now: Date,
): FinancePlanStatusReadModel {
  const fixed = entitlement?.planKey === "fixed";
  const cancelAtPeriodEnd = fixed && Boolean(entitlement?.cancelAtPeriodEnd);
  const providerPastDue = ["past_due", "unpaid"].includes(
    entitlement?.providerSubscriptionStatus ?? "",
  );
  const checkoutPending = !fixed && isCheckoutPending(entitlement, now);
  const currentPeriodEnd = iso(entitlement?.periodEnd);
  const configuredAmount = fixedPlanAmountOrNull(activeRoomCount, currency);
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
    currency,
    activeRoomCount,
    amountMinor:
      fixed && entitlement?.amountMinor !== null
        ? (entitlement?.amountMinor ?? 0)
        : (configuredAmount ?? 0),
    fixedPlanAvailable: configuredAmount !== null,
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
    currency: entitlement.currency ?? FINANCE_FIXED_PLAN_CURRENCY,
    amountMinor:
      entitlement.amountMinor ??
      fixedPlanAmountOrNull(
        checkoutRoomCount,
        entitlement.currency ?? FINANCE_FIXED_PLAN_CURRENCY,
      ) ??
      0,
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

function fixedPlanAmountOrNull(activeRoomCount: number, currency: string): number | null {
  try {
    return fixedPlanAmountMinor(activeRoomCount, currency);
  } catch (error) {
    if (error instanceof RangeError) return null;
    throw error;
  }
}

function checkoutProviderIdempotencyKey(propertyId: string, attemptIdempotencyKey: string): string {
  const attemptHash = createHash("sha256").update(attemptIdempotencyKey).digest("hex");
  return `fixed-plan-checkout:${propertyId}:${attemptHash}:v1`;
}

function activationProviderIdempotencyKey(
  propertyId: string,
  paymentMethod: FinancePaymentCollectionMethod,
  entitlementUpdatedAt: Date | string,
): string {
  return `fixed-plan-${paymentMethod}:${createHash("sha256")
    .update(
      `${propertyId}:${paymentMethod}:${date(entitlementUpdatedAt, new Date(0)).toISOString()}`,
    )
    .digest("hex")}:v2`;
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

function billingReturnUrl(
  baseUrl: string,
  surface: "booking-admin" | "pms" | undefined,
  outcome?: "success" | "canceled",
): string {
  const url = new URL(surface === "pms" ? "/settings/billing" : "/settings", baseUrl);
  if (outcome) url.searchParams.set("billing", outcome);
  else url.searchParams.set("billing", "manage");
  return url.toString();
}

function nextMonthlyBillingAnchor(date: Date): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1));
}

function billingDetails(value: unknown): FinanceBillingDetails {
  const details = object(value);
  return {
    companyName: string(details["companyName"]) ?? "",
    billingEmail: string(details["billingEmail"]) ?? "",
    taxId: string(details["taxId"]),
  };
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
