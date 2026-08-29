import { createHash } from "node:crypto";

import {
  parseFinancePaymentReadinessSnapshot,
  type FinancePaymentReadinessBlocker,
  type FinancePaymentReadinessReadPort,
  type FinancePaymentReadinessSnapshot,
} from "@vayada/domain-finance";
import { parsePropertyPricingCurrencySnapshot, type PmsPricingReadPort } from "@vayada/domain-pms";

import type { PropertySetupFinanceOwnerScopePort } from "../domains/propertySetupFinanceOwnerScope.js";
import type {
  PropertySetupOwnerStateProviderPort,
  PropertySetupOwnerStateRequest,
  PropertySetupOwnerStateResult,
} from "./propertySetupRouteState.js";

export type PropertySetupFinanceStateOptions = Readonly<{
  scope: PropertySetupFinanceOwnerScopePort;
  finance: FinancePaymentReadinessReadPort;
  pricing: Pick<PmsPricingReadPort, "getPropertyPricingCurrency">;
}>;

const EXTERNAL_PENDING_BLOCKERS = new Set<FinancePaymentReadinessBlocker>([
  "online_card_execution_unavailable",
  "provider_capability_lost",
  "bank_transfer_contract_unavailable",
]);

const PAYMENT_BLOCKER_MESSAGES: Partial<Record<SetupPaymentBlockerCode, string>> = {
  online_card_execution_unavailable:
    "Online card payments are waiting for verified execution evidence.",
  provider_capability_lost: "The payment provider withdrew card capability.",
  bank_transfer_contract_unavailable: "Bank transfer is waiting for a completed payout contract.",
};

type SetupPaymentBlockerCode = FinancePaymentReadinessBlocker | "ready_payment_method_missing";

export function createPropertySetupFinanceStateProvider(
  options: PropertySetupFinanceStateOptions,
): PropertySetupOwnerStateProviderPort {
  return {
    async getOwnerState(request) {
      if (request.stepIds.length !== 1 || request.stepIds[0] !== "payments") return failure();
      try {
        const first = await snapshot(options, request);
        const confirmed = await snapshot(options, request);
        if (!first || !confirmed || first.identity !== confirmed.identity) return failure();
        const sourceRevision = `payment-methods:${first.paymentMethodsRevision}`;
        return found({
          organizationId: request.organizationId,
          propertyId: request.propertyId,
          stepId: "payments",
          product: "finance",
          ownerDomain: "finance",
          state:
            first.paymentMethodsRevision === 0
              ? "not_started"
              : first.selectedMethodCount === 0
                ? "saved"
                : first.bookingPaymentReady
                  ? "complete"
                  : "blocked",
          sourceRevision,
          currentBaseRevisions: first.currentBaseRevisions,
          blockers: first.blockingCodes.map((code) => paymentBlocker(code, sourceRevision)),
        });
      } catch {
        return failure();
      }
    },
  };
}

async function snapshot(
  options: PropertySetupFinanceStateOptions,
  request: PropertySetupOwnerStateRequest,
) {
  const authorized = await options.scope.hasPaymentOwnerScope({
    organizationId: request.organizationId,
    propertyId: request.propertyId,
  });
  if (!authorized) return null;
  const [rawFinance, rawPricing] = await Promise.all([
    options.finance.getPaymentReadiness({
      organizationId: request.organizationId,
      propertyId: request.propertyId,
    }),
    options.pricing.getPropertyPricingCurrency(request.propertyId),
  ]);
  const finance = rawFinance === null ? null : parseFinancePaymentReadinessSnapshot(rawFinance);
  const pricing = rawPricing === null ? null : parsePropertyPricingCurrencySnapshot(rawPricing);
  if (
    (rawFinance !== null && !finance) ||
    (rawPricing !== null && !pricing) ||
    (finance && finance.propertyId !== request.propertyId) ||
    (pricing && pricing.propertyId !== request.propertyId)
  ) {
    return null;
  }
  const pricingRevision = pricing?.pricingCurrencyRevision ?? 0;
  if (
    finance &&
    (finance.pricingCurrency.current?.pricingCurrencyRevision ?? 0) !== pricingRevision
  ) {
    return null;
  }
  const paymentMethodsRevision = finance?.paymentMethodsRevision ?? 0;
  const currentBaseRevisions = Object.freeze({
    "finance.payment_methods": `payment-methods:${paymentMethodsRevision}`,
    "pms.pricing_settings": `pricing:${pricingRevision}`,
  });
  const payload = {
    paymentMethodsRevision,
    selectedMethodCount: finance?.selectedMethodCount ?? 0,
    bookingPaymentReady: finance?.bookingPaymentReady ?? false,
    blockingCodes: blockingPaymentCodes(finance),
    currentBaseRevisions,
  };
  return Object.freeze({
    ...payload,
    identity: createHash("sha256").update(JSON.stringify(payload)).digest("hex"),
  });
}

function blockingPaymentCodes(
  finance: FinancePaymentReadinessSnapshot | null,
): SetupPaymentBlockerCode[] {
  if (!finance || finance.bookingPaymentReady || finance.selectedMethodCount === 0) return [];
  const blockers = [
    ...new Set(
      finance.methods
        .filter(({ selected, readiness }) => selected && readiness === "unready")
        .flatMap(({ blockers }) => blockers),
    ),
  ];
  return blockers.length > 0 ? blockers : ["ready_payment_method_missing"];
}

function paymentBlocker(code: SetupPaymentBlockerCode, sourceRevision: string) {
  return {
    code,
    product: "finance" as const,
    ownerDomain: "finance" as const,
    owningStepId: "payments" as const,
    message: PAYMENT_BLOCKER_MESSAGES[code] ?? "Complete at least one ready payment method.",
    kind:
      code !== "ready_payment_method_missing" && EXTERNAL_PENDING_BLOCKERS.has(code)
        ? ("external_pending" as const)
        : ("user_fixable" as const),
    sourceRevision,
  };
}

function found(
  fact: Extract<PropertySetupOwnerStateResult, { outcome: "found" }>["facts"][number],
): PropertySetupOwnerStateResult {
  return { outcome: "found", facts: Object.freeze([Object.freeze(fact)]) };
}

function failure(): PropertySetupOwnerStateResult {
  return { outcome: "provider_failure" };
}
