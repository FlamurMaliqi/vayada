import {
  FINANCE_PAYMENT_READINESS_CONTRACT_VERSION,
  type ReplaceFinancePaymentMethodsCommand,
  type ReplaceFinancePaymentMethodsResult,
} from "@vayada/domain-finance";
import {
  PMS_PRICING_CONTRACT_VERSION,
  parsePmsPricingCurrency,
  type PmsPricingCurrencyDependencyGuardPort,
  type PropertyPricingCurrencySnapshot,
} from "@vayada/domain-pms";
import { describe, expect, it, vi } from "vitest";

import {
  createFinancePaymentReadinessService,
  type FinancePaymentMethodsRepositoryPort,
} from "./domains/financePaymentReadinessService.js";

const propertyId = "123e4567-e89b-42d3-a456-426614174000";
const command: ReplaceFinancePaymentMethodsCommand = {
  organizationId: "223e4567-e89b-42d3-a456-426614174000",
  propertyId,
  idempotencyKey: "finance-payment-methods-1",
  expectedPaymentMethodsRevision: 0,
  expectedPricingCurrencyRevision: 4,
  selectedMethods: ["pay_at_property"],
  audit: {
    actor: { kind: "user", userId: "323e4567-e89b-42d3-a456-426614174000" },
    requestId: "request-1",
    correlationId: null,
    requestedAt: "2026-08-03T12:00:00.000Z",
  },
};

const accepted: ReplaceFinancePaymentMethodsResult = {
  ok: false,
  error: { code: "payment_methods_revision_conflict", currentRevision: 2 },
};

function pricing(
  overrides: Partial<PropertyPricingCurrencySnapshot> = {},
): PropertyPricingCurrencySnapshot {
  return {
    contractVersion: PMS_PRICING_CONTRACT_VERSION,
    propertyId,
    currency: parsePmsPricingCurrency("EUR")!,
    pricingCurrencyRevision: 4,
    createdAt: "2026-08-03T10:00:00.000Z",
    updatedAt: "2026-08-03T11:00:00.000Z",
    ...overrides,
  } satisfies PropertyPricingCurrencySnapshot;
}

function setup(value: PropertyPricingCurrencySnapshot | null = pricing()) {
  const order: string[] = [];
  const pricingReadPort = {
    getPropertyPricingCurrency: vi.fn(async () => {
      order.push("read");
      return value;
    }),
  };
  const repository: FinancePaymentMethodsRepositoryPort = {
    replacePaymentMethods: vi.fn(async () => {
      order.push("write");
      return accepted;
    }),
  };
  const pricingCurrencyDependencyGuard: PmsPricingCurrencyDependencyGuardPort = {
    async runWithPricingCurrencyDependencyGuard(input, guarded) {
      expect(input).toEqual({ propertyId });
      order.push("guard:start");
      const result = await guarded();
      order.push("guard:end");
      return result;
    },
  };
  return {
    order,
    pricingReadPort,
    repository,
    service: createFinancePaymentReadinessService({
      pricingReadPort,
      pricingCurrencyDependencyGuard,
      repository,
    }),
  };
}

describe("createFinancePaymentReadinessService", () => {
  it("holds the PMS dependency guard across the authoritative read and Finance write", async () => {
    const { order, pricingReadPort, repository, service } = setup();

    await expect(service.replacePaymentMethods(command)).resolves.toBe(accepted);

    expect(order).toEqual(["guard:start", "read", "write", "guard:end"]);
    expect(pricingReadPort.getPropertyPricingCurrency).toHaveBeenCalledWith(propertyId);
    expect(repository.replacePaymentMethods).toHaveBeenCalledWith({
      command,
      currentPricing: {
        contractVersion: PMS_PRICING_CONTRACT_VERSION,
        currency: "EUR",
        pricingCurrencyRevision: 4,
      },
    });
  });

  it("allowlists evidence and never forwards timestamps or additional source fields", async () => {
    const source = {
      ...pricing(),
      providerSecret: "must-not-cross-finance-boundary",
    } as unknown as PropertyPricingCurrencySnapshot;
    const { repository, service } = setup(source);

    await service.replacePaymentMethods(command);

    const input = vi.mocked(repository.replacePaymentMethods).mock.calls[0]?.[0];
    expect(Object.keys(input?.currentPricing ?? {})).toEqual([
      "contractVersion",
      "currency",
      "pricingCurrencyRevision",
    ]);
    expect(JSON.stringify(input)).not.toContain("must-not-cross-finance-boundary");
  });

  it.each([
    ["missing", null],
    ["wrong property", pricing({ propertyId: "423e4567-e89b-42d3-a456-426614174000" })],
    [
      "wrong contract",
      pricing({
        contractVersion:
          FINANCE_PAYMENT_READINESS_CONTRACT_VERSION as typeof PMS_PRICING_CONTRACT_VERSION,
      }),
    ],
  ])("fails %s PMS evidence closed", async (_label, value) => {
    const { repository, service } = setup(value);

    await service.replacePaymentMethods(command);

    expect(repository.replacePaymentMethods).toHaveBeenCalledWith({
      command,
      currentPricing: null,
    });
  });
});
