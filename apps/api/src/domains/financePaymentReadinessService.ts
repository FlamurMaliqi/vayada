import {
  type FinancePaymentMethodsCommandPort,
  type FinancePricingCurrencyEvidence,
  type ReplaceFinancePaymentMethodsCommand,
  type ReplaceFinancePaymentMethodsResult,
} from "@vayada/domain-finance";
import {
  PMS_PRICING_CONTRACT_VERSION,
  type PmsPricingCurrencyDependencyGuardPort,
  type PmsPricingReadPort,
  type PropertyPricingCurrencySnapshot,
} from "@vayada/domain-pms";

export type FinancePaymentMethodsRepositoryPort = {
  replacePaymentMethods(input: {
    command: ReplaceFinancePaymentMethodsCommand;
    currentPricing: FinancePricingCurrencyEvidence | null;
  }): Promise<ReplaceFinancePaymentMethodsResult>;
};

export function createFinancePaymentReadinessService(dependencies: {
  pricingReadPort: Pick<PmsPricingReadPort, "getPropertyPricingCurrency">;
  pricingCurrencyDependencyGuard: PmsPricingCurrencyDependencyGuardPort;
  repository: FinancePaymentMethodsRepositoryPort;
}): FinancePaymentMethodsCommandPort {
  return {
    replacePaymentMethods(command) {
      return dependencies.pricingCurrencyDependencyGuard.runWithPricingCurrencyDependencyGuard(
        { propertyId: command.propertyId },
        async () => {
          const pricing = await dependencies.pricingReadPort.getPropertyPricingCurrency(
            command.propertyId,
          );
          return dependencies.repository.replacePaymentMethods({
            command,
            currentPricing: pricingEvidence(command.propertyId, pricing),
          });
        },
      );
    },
  };
}

function pricingEvidence(
  propertyId: string,
  pricing: PropertyPricingCurrencySnapshot | null,
): FinancePricingCurrencyEvidence | null {
  if (
    !pricing ||
    pricing.propertyId !== propertyId ||
    pricing.contractVersion !== PMS_PRICING_CONTRACT_VERSION
  )
    return null;
  return Object.freeze({
    contractVersion: pricing.contractVersion,
    currency: pricing.currency,
    pricingCurrencyRevision: pricing.pricingCurrencyRevision,
  });
}
