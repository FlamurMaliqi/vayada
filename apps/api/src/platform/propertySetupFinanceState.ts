import { createHash } from "node:crypto";

import {
  parseFinancePaymentReadinessSnapshot,
  type FinancePaymentReadinessReadPort,
} from "@vayada/domain-finance";
import { parsePropertyPricingCurrencySnapshot, type PmsPricingReadPort } from "@vayada/domain-pms";

import type { PropertySetupFinanceOwnerScopePort } from "../domains/propertySetupFinanceOwnerScope.js";
import type {
  PropertySetupOwnerStateProviderPort,
  PropertySetupOwnerStateRequest,
  PropertySetupOwnerStateResult,
} from "./propertySetupRouteState.js";

export function createPropertySetupFinanceStateProvider(options: {
  scope: PropertySetupFinanceOwnerScopePort;
  finance: FinancePaymentReadinessReadPort;
  pricing: Pick<PmsPricingReadPort, "getPropertyPricingCurrency">;
}): PropertySetupOwnerStateProviderPort {
  return {
    async getOwnerState(request) {
      if (request.stepIds.length !== 1 || request.stepIds[0] !== "payments") return failure();
      try {
        const first = await snapshot(options, request);
        const confirmed = await snapshot(options, request);
        if (!first || !confirmed || first.identity !== confirmed.identity) return failure();
        return found({
          organizationId: request.organizationId,
          propertyId: request.propertyId,
          stepId: "payments",
          product: "finance",
          ownerDomain: "finance",
          state:
            first.paymentMethodsRevision === 0
              ? "not_started"
              : first.selectedMethodCount > 0
                ? "complete"
                : "saved",
          sourceRevision: `payment-methods:${first.paymentMethodsRevision}`,
          currentBaseRevisions: first.currentBaseRevisions,
          blockers: [],
        });
      } catch {
        return failure();
      }
    },
  };
}

async function snapshot(
  options: {
    scope: PropertySetupFinanceOwnerScopePort;
    finance: FinancePaymentReadinessReadPort;
    pricing: Pick<PmsPricingReadPort, "getPropertyPricingCurrency">;
  },
  request: PropertySetupOwnerStateRequest,
) {
  const [authorized, rawFinance, rawPricing] = await Promise.all([
    options.scope.hasPaymentOwnerScope({
      organizationId: request.organizationId,
      propertyId: request.propertyId,
    }),
    options.finance.getPaymentReadiness({
      organizationId: request.organizationId,
      propertyId: request.propertyId,
    }),
    options.pricing.getPropertyPricingCurrency(request.propertyId),
  ]);
  if (!authorized) return null;
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
  return Object.freeze({
    paymentMethodsRevision,
    selectedMethodCount: finance?.selectedMethodCount ?? 0,
    currentBaseRevisions,
    identity: createHash("sha256").update(JSON.stringify(currentBaseRevisions)).digest("hex"),
  });
}

function found(
  fact: Extract<PropertySetupOwnerStateResult, { outcome: "found" }>["facts"][number],
): PropertySetupOwnerStateResult {
  return { outcome: "found", facts: Object.freeze([Object.freeze(fact)]) };
}

function failure(): PropertySetupOwnerStateResult {
  return { outcome: "provider_failure" };
}
