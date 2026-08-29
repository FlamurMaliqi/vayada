import {
  createFinancePaymentReadinessSnapshot,
  type FinanceOnlineCardReadinessDecision,
} from "@vayada/domain-finance";
import { PMS_PRICING_CONTRACT_VERSION, parsePmsPricingCurrency } from "@vayada/domain-pms";
import { describe, expect, it, vi } from "vitest";

import { createPropertySetupFinanceStateProvider } from "./platform/propertySetupFinanceState.js";

const organizationId = "11111111-1111-4111-8111-111111111111";
const propertyId = "22222222-2222-4222-8222-222222222222";
const actorUserId = "33333333-3333-4333-8333-333333333333";

describe("property setup Finance owner state", () => {
  it("returns exact current payment-method and pricing manifests", async () => {
    const provider = createPropertySetupFinanceStateProvider({
      scope: authorizedScope(),
      finance: { getPaymentReadiness: vi.fn(async () => paymentReadiness(2, 4)) },
      pricing: { getPropertyPricingCurrency: vi.fn(async () => pricingCurrency(4)) },
    });

    await expect(provider.getOwnerState(request())).resolves.toMatchObject({
      outcome: "found",
      facts: [
        {
          stepId: "payments",
          state: "complete",
          sourceRevision: "payment-methods:2",
          currentBaseRevisions: {
            "finance.payment_methods": "payment-methods:2",
            "pms.pricing_settings": "pricing:4",
          },
        },
      ],
    });
  });

  it("represents truthful first-visit owner state without creating a draft", async () => {
    const provider = createPropertySetupFinanceStateProvider({
      scope: authorizedScope(),
      finance: { getPaymentReadiness: vi.fn(async () => null) },
      pricing: { getPropertyPricingCurrency: vi.fn(async () => pricingCurrency(4)) },
    });

    await expect(provider.getOwnerState(request())).resolves.toMatchObject({
      outcome: "found",
      facts: [
        {
          state: "not_started",
          currentBaseRevisions: {
            "finance.payment_methods": "payment-methods:0",
            "pms.pricing_settings": "pricing:4",
          },
        },
      ],
    });
  });

  it("keeps card-only setup blocked until current execution evidence and capability are ready", async () => {
    for (const testCase of [
      {
        selectedMethods: ["card"],
        readiness: "ready",
        state: "complete",
        blocker: null,
        message: null,
      },
      {
        selectedMethods: ["card"],
        readiness: "execution_unavailable",
        state: "blocked",
        blocker: "online_card_execution_unavailable",
        message: "Online card payments are waiting for verified execution evidence.",
      },
      {
        selectedMethods: ["card"],
        readiness: "provider_capability_lost",
        state: "blocked",
        blocker: "provider_capability_lost",
        message: "The payment provider withdrew card capability.",
      },
      {
        selectedMethods: ["bank_transfer"],
        readiness: "execution_unavailable",
        state: "blocked",
        blocker: "bank_transfer_contract_unavailable",
        message: "Bank transfer is waiting for a completed payout contract.",
      },
    ] as const) {
      const provider = createPropertySetupFinanceStateProvider({
        scope: authorizedScope(),
        finance: {
          getPaymentReadiness: vi.fn(async () =>
            paymentReadiness(2, 4, [...testCase.selectedMethods], testCase.readiness),
          ),
        },
        pricing: { getPropertyPricingCurrency: vi.fn(async () => pricingCurrency(4)) },
      });

      const result = await provider.getOwnerState(request());
      expect(result).toMatchObject({
        outcome: "found",
        facts: [
          {
            state: testCase.state,
            blockers: testCase.blocker
              ? [
                  {
                    code: testCase.blocker,
                    kind: "external_pending",
                    message: testCase.message,
                    sourceRevision: "payment-methods:2",
                  },
                ]
              : [],
          },
        ],
      });
    }
  });

  it("fails closed when card readiness changes between the confirmation reads", async () => {
    const provider = createPropertySetupFinanceStateProvider({
      scope: authorizedScope(),
      finance: {
        getPaymentReadiness: vi
          .fn()
          .mockResolvedValueOnce(paymentReadiness(2, 4, ["card"], "ready"))
          .mockResolvedValueOnce(paymentReadiness(2, 4, ["card"], "execution_unavailable")),
      },
      pricing: { getPropertyPricingCurrency: vi.fn(async () => pricingCurrency(4)) },
    });

    await expect(provider.getOwnerState(request())).resolves.toEqual({
      outcome: "provider_failure",
    });
  });

  it("fails closed on pricing mismatches, malformed facts, and revision races", async () => {
    const cases = [
      createPropertySetupFinanceStateProvider({
        scope: authorizedScope(),
        finance: { getPaymentReadiness: vi.fn(async () => paymentReadiness(2, 3)) },
        pricing: { getPropertyPricingCurrency: vi.fn(async () => pricingCurrency(4)) },
      }),
      createPropertySetupFinanceStateProvider({
        scope: authorizedScope(),
        finance: { getPaymentReadiness: vi.fn(async () => ({ unsafe: true }) as never) },
        pricing: { getPropertyPricingCurrency: vi.fn(async () => pricingCurrency(4)) },
      }),
      createPropertySetupFinanceStateProvider({
        scope: authorizedScope(),
        finance: {
          getPaymentReadiness: vi
            .fn()
            .mockResolvedValueOnce(paymentReadiness(2, 4))
            .mockResolvedValueOnce(paymentReadiness(2, 4, [])),
        },
        pricing: { getPropertyPricingCurrency: vi.fn(async () => pricingCurrency(4)) },
      }),
    ];
    for (const provider of cases) {
      await expect(provider.getOwnerState(request())).resolves.toEqual({
        outcome: "provider_failure",
      });
    }

    const deniedFinance = vi.fn(async () => null);
    const deniedPricing = vi.fn(async () => pricingCurrency(4));
    const denied = createPropertySetupFinanceStateProvider({
      scope: { hasPaymentOwnerScope: vi.fn(async () => false) },
      finance: { getPaymentReadiness: deniedFinance },
      pricing: { getPropertyPricingCurrency: deniedPricing },
    });
    await expect(denied.getOwnerState(request())).resolves.toEqual({
      outcome: "provider_failure",
    });
    expect(deniedFinance).not.toHaveBeenCalled();
    expect(deniedPricing).not.toHaveBeenCalled();
  });
});

function authorizedScope() {
  return { hasPaymentOwnerScope: vi.fn(async () => true) };
}

function request() {
  return {
    organizationId,
    propertyId,
    actorUserId,
    selectedTracks: ["hotel_operations"] as const,
    expectedTrackRevision: 3,
    stepIds: ["payments"] as const,
  };
}

function pricingCurrency(revision: number) {
  return {
    contractVersion: PMS_PRICING_CONTRACT_VERSION,
    propertyId,
    currency: parsePmsPricingCurrency("EUR")!,
    pricingCurrencyRevision: revision,
    createdAt: "2026-08-04T12:00:00.000Z",
    updatedAt: "2026-08-04T12:00:00.000Z",
  } as const;
}

function paymentReadiness(
  paymentMethodsRevision: number,
  pricingRevision: number,
  selectedMethods: Array<"pay_at_property" | "card" | "bank_transfer"> = ["pay_at_property"],
  onlineCardReadiness: FinanceOnlineCardReadinessDecision = "execution_unavailable",
) {
  const pricing = {
    contractVersion: PMS_PRICING_CONTRACT_VERSION,
    currency: "EUR",
    pricingCurrencyRevision: pricingRevision,
  };
  return createFinancePaymentReadinessSnapshot({
    propertyId,
    paymentMethodsRevision,
    selectedMethods,
    committedPricing: pricing,
    currentPricing: pricing,
    onlineCardReadiness,
    updatedAt: "2026-08-04T12:00:00.000Z",
  });
}
