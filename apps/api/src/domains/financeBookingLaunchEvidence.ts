import {
  createFinancePaymentMethodsSourceEntityRevision,
  parseFinancePaymentReadinessSnapshot,
  type FinancePaymentReadinessBlocker,
  type FinancePaymentReadinessReadPort,
} from "@vayada/domain-finance";
import {
  type BookingLaunchFinanceEvidencePort,
  type BookingLaunchOwnerAdvisory,
  type BookingLaunchOwnerBlocker,
  type BookingLaunchOwnerEvidence,
} from "@vayada/domain-booking";
import {
  PMS_PRICING_CONTRACT_VERSION,
  PMS_PRICING_SOURCE_ENTITY_TYPES,
  serializePmsPricingSourceEntityRevision,
} from "@vayada/domain-pms";

const EXTERNAL_PENDING = new Set<FinancePaymentReadinessBlocker>([
  "online_card_execution_unavailable",
  "provider_capability_lost",
  "bank_transfer_contract_unavailable",
]);

export function createFinanceBookingLaunchEvidenceAdapter(dependencies: {
  financeReadPort: FinancePaymentReadinessReadPort;
}): BookingLaunchFinanceEvidencePort {
  return {
    bookingLaunchEvidencePort: "finance",
    async getBookingLaunchEvidence(request) {
      let value: unknown;
      try {
        value = await dependencies.financeReadPort.getPaymentReadiness(request);
      } catch {
        return unavailable("system");
      }
      const snapshot = value === null ? null : parseFinancePaymentReadinessSnapshot(value);
      if (!snapshot || snapshot.propertyId !== request.propertyId) return unavailable("provider");

      try {
        const financeSource = createFinancePaymentMethodsSourceEntityRevision(
          snapshot.propertyId,
          snapshot.paymentMethodsRevision,
        );
        const pricingSource = snapshot.pricingCurrency.committed
          ? pricingBindingSource(snapshot.propertyId, snapshot.pricingCurrency.committed)
          : null;
        if (snapshot.pricingCurrency.committed && !pricingSource) return unavailable("provider");

        const blockingCodes = snapshot.methods
          .filter(
            ({ method, consequence }) =>
              consequence === "blocking" || (consequence === "warning" && method !== "card"),
          )
          .flatMap(({ blockers }) => blockers);
        const blockers = ownerBlockers(blockingCodes, Boolean(pricingSource));
        if (!snapshot.bookingPaymentReady && blockers.length === 0 && blockingCodes.length === 0) {
          blockers.push(ownerBlocker("ready_payment_method_missing", "user_fixable"));
        }
        const advisories = ownerAdvisories(
          snapshot.methods
            .filter(({ method, consequence }) => method === "card" && consequence === "warning")
            .flatMap(({ blockers }) => blockers),
        );
        const evidence = {
          outcome: "evidence",
          port: "finance",
          organizationId: request.organizationId,
          propertyId: request.propertyId,
          sources: [financeSource],
          entities: [
            {
              groupId: "booking.payments",
              owningStepId: "payments",
              source: financeSource,
              blockers,
              ...(advisories.length > 0 ? { advisories } : {}),
              ...(pricingSource
                ? {
                    bindings: [
                      {
                        expectedSource: pricingSource,
                        mismatchBlocker: ownerBlocker("payment_currency_stale", "user_fixable"),
                      },
                    ],
                  }
                : {}),
            },
          ],
        } as const satisfies BookingLaunchOwnerEvidence<"finance">;
        return evidence;
      } catch {
        return unavailable("provider");
      }
    },
  };
}

function pricingBindingSource(
  propertyId: string,
  evidence: { contractVersion: string; pricingCurrencyRevision: number },
) {
  return evidence.contractVersion === PMS_PRICING_CONTRACT_VERSION
    ? serializePmsPricingSourceEntityRevision(
        PMS_PRICING_SOURCE_ENTITY_TYPES.propertyPricingCurrency,
        propertyId,
        evidence.pricingCurrencyRevision,
      )
    : null;
}

function ownerBlockers(
  codes: readonly FinancePaymentReadinessBlocker[],
  hasPricingBinding: boolean,
): BookingLaunchOwnerBlocker[] {
  return [...new Set(codes)]
    .filter((code) => code !== "pricing_currency_mismatch" || !hasPricingBinding)
    .map((code) =>
      ownerBlocker(code, EXTERNAL_PENDING.has(code) ? "external_pending" : "user_fixable"),
    );
}

function ownerAdvisories(
  codes: readonly FinancePaymentReadinessBlocker[],
): BookingLaunchOwnerAdvisory[] {
  return [...new Set(codes)].map((code) => ({
    code,
    scope: "optional_external_pending",
  }));
}

function ownerBlocker(
  code: string,
  kind: "user_fixable" | "external_pending",
): BookingLaunchOwnerBlocker {
  return { code, scope: "launch_configuration", kind };
}

function unavailable(errorSource: "provider" | "system") {
  return { outcome: "unavailable", port: "finance", errorSource } as const;
}
