import {
  createFinancePaymentReadinessSnapshot,
  type FinancePaymentReadinessReadPort,
  type FinancePaymentReadinessSnapshot,
} from "@vayada/domain-finance";
import { isBookingLaunchOwnerEvidenceValid } from "@vayada/domain-booking";
import { PMS_PRICING_CONTRACT_VERSION } from "@vayada/domain-pms";
import { describe, expect, it } from "vitest";

import { createFinanceBookingLaunchEvidenceAdapter } from "./domains/financeBookingLaunchEvidence.js";

const organizationId = "123e4567-e89b-42d3-a456-426614174000";
const propertyId = "223e4567-e89b-42d3-a456-426614174000";
const request = { organizationId, propertyId };
const pricing = {
  contractVersion: PMS_PRICING_CONTRACT_VERSION,
  currency: "EUR",
  pricingCurrencyRevision: 7,
};

function snapshot(
  selectedMethods: Parameters<typeof createFinancePaymentReadinessSnapshot>[0]["selectedMethods"],
  overrides: Partial<Parameters<typeof createFinancePaymentReadinessSnapshot>[0]> = {},
) {
  return createFinancePaymentReadinessSnapshot({
    propertyId,
    paymentMethodsRevision: 4,
    selectedMethods,
    committedPricing: pricing,
    currentPricing: pricing,
    updatedAt: "2026-08-03T12:00:00.000Z",
    ...overrides,
  });
}

function adapter(value: FinancePaymentReadinessSnapshot | null) {
  const financeReadPort: FinancePaymentReadinessReadPort = {
    async getPaymentReadiness() {
      return value;
    },
  };
  return createFinanceBookingLaunchEvidenceAdapter({ financeReadPort });
}

describe("createFinanceBookingLaunchEvidenceAdapter", () => {
  it("emits one canonical Finance source with the accepted PMS currency binding", async () => {
    const result = await adapter(snapshot(["pay_at_property"])).getBookingLaunchEvidence(request);

    expect(result).toEqual({
      outcome: "evidence",
      port: "finance",
      organizationId,
      propertyId,
      sources: [
        {
          ownerDomain: "finance",
          entityType: "finance_payment_methods.v1",
          entityId: propertyId,
          revision: "4",
        },
      ],
      entities: [
        {
          groupId: "booking.payments",
          owningStepId: "payments",
          source: {
            ownerDomain: "finance",
            entityType: "finance_payment_methods.v1",
            entityId: propertyId,
            revision: "4",
          },
          blockers: [],
          bindings: [
            {
              expectedSource: {
                ownerDomain: "pms",
                entityType: "pms_property_pricing_currency.v1",
                entityId: propertyId,
                revision: "7",
              },
              mismatchBlocker: {
                code: "payment_currency_stale",
                scope: "launch_configuration",
                kind: "user_fixable",
              },
            },
          ],
        },
      ],
    });
    expect(isBookingLaunchOwnerEvidenceValid(result, request, "finance")).toBe(true);
  });

  it("keeps a selected card pending and an optional card warning non-blocking", async () => {
    const pending = await adapter(snapshot(["card"])).getBookingLaunchEvidence(request);
    const optional = await adapter(snapshot(["pay_at_property", "card"])).getBookingLaunchEvidence(
      request,
    );

    expect(pending).toMatchObject({
      entities: [
        {
          blockers: [
            {
              code: "online_card_execution_unavailable",
              kind: "external_pending",
            },
          ],
        },
      ],
    });
    expect(optional).toMatchObject({
      entities: [
        {
          blockers: [],
          advisories: [
            {
              code: "online_card_execution_unavailable",
              scope: "optional_external_pending",
            },
          ],
        },
      ],
    });
  });

  it("keeps a legacy-selected unavailable bank transfer blocking", async () => {
    const result = await adapter(
      snapshot(["pay_at_property", "bank_transfer"]),
    ).getBookingLaunchEvidence(request);

    expect(result).toMatchObject({
      entities: [
        {
          blockers: [
            {
              code: "bank_transfer_contract_unavailable",
              kind: "external_pending",
            },
          ],
        },
      ],
    });
    if (result.outcome === "evidence") expect(result.entities[0]).not.toHaveProperty("advisories");
  });

  it("lets the PMS source binding express a currency mismatch without a duplicate blocker", async () => {
    const result = await adapter(
      snapshot(["pay_at_property"], {
        currentPricing: { ...pricing, pricingCurrencyRevision: 8 },
      }),
    ).getBookingLaunchEvidence(request);

    expect(result).toMatchObject({
      entities: [
        {
          blockers: [],
          bindings: [
            {
              expectedSource: { revision: "7" },
              mismatchBlocker: { code: "payment_currency_stale" },
            },
          ],
        },
      ],
    });
  });

  it("returns explicit unavailable results for missing, invalid, or failed Finance reads", async () => {
    await expect(adapter(null).getBookingLaunchEvidence(request)).resolves.toEqual({
      outcome: "unavailable",
      port: "finance",
      errorSource: "provider",
    });

    const poisoned = {
      ...snapshot(["pay_at_property"]),
      providerSecret: "must-not-cross-booking-boundary",
    } as unknown as FinancePaymentReadinessSnapshot;
    const invalid = await adapter(poisoned).getBookingLaunchEvidence(request);
    expect(invalid).toEqual({ outcome: "unavailable", port: "finance", errorSource: "provider" });
    expect(JSON.stringify(invalid)).not.toContain("must-not-cross-booking-boundary");

    const failed = createFinanceBookingLaunchEvidenceAdapter({
      financeReadPort: {
        async getPaymentReadiness() {
          throw new Error("provider secret must stay private");
        },
      },
    });
    await expect(failed.getBookingLaunchEvidence(request)).resolves.toEqual({
      outcome: "unavailable",
      port: "finance",
      errorSource: "system",
    });
  });

  it("rejects mismatched Finance scope and non-PMS committed evidence", async () => {
    const wrongProperty = snapshot(["pay_at_property"], {
      propertyId: "323e4567-e89b-42d3-a456-426614174000",
    });
    const wrongContract = snapshot(["pay_at_property"], {
      committedPricing: { ...pricing, contractVersion: "lookalike-pricing.v1" },
    });

    await expect(adapter(wrongProperty).getBookingLaunchEvidence(request)).resolves.toMatchObject({
      outcome: "unavailable",
      errorSource: "provider",
    });
    await expect(adapter(wrongContract).getBookingLaunchEvidence(request)).resolves.toMatchObject({
      outcome: "unavailable",
      errorSource: "provider",
    });
  });
});
