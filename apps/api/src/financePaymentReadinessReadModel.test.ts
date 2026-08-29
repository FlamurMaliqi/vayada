import {
  FINANCE_PAYMENT_READINESS_CONTRACT_VERSION,
  type FinancePaymentReadinessMethod,
} from "@vayada/domain-finance";
import { PMS_PRICING_CONTRACT_VERSION, type PmsPricingReadPort } from "@vayada/domain-pms";
import { describe, expect, it } from "vitest";

import {
  createPgFinancePaymentReadinessReadModel,
  type FinancePaymentReadinessReadPool,
} from "./domains/financePaymentReadinessReadModel.js";

const organizationId = "123e4567-e89b-42d3-a456-426614174000";
const propertyId = "223e4567-e89b-42d3-a456-426614174000";
const providerAccountId = "323e4567-e89b-42d3-a456-426614174000";
const updatedAt = "2026-08-03T12:00:00.000Z";

function row(overrides: Record<string, unknown> = {}) {
  return {
    propertyId,
    contractVersion: FINANCE_PAYMENT_READINESS_CONTRACT_VERSION,
    paymentMethodsRevision: "3",
    sourcePricingCurrencyRevision: "7",
    currency: "EUR",
    acceptedMethods: ["pay_at_property", "card"],
    onlineCardCurrencyEligible: true,
    providerAccountId,
    provider: "stripe",
    providerAccountScope: "property",
    providerBindingActive: true,
    providerStatus: "active",
    providerOnboardingStatus: "completed",
    providerChargesEnabled: true,
    providerPayoutsEnabled: true,
    providerDetailsSubmitted: true,
    providerCardPaymentsStatus: "active",
    providerCapabilities: ["card_payments"],
    providerCardCapabilityRevision: "4",
    propertyReadinessRevision: "8",
    executionEvidenceContractVersion: null,
    executionEvidenceProviderAccountId: null,
    executionEvidenceCapabilityRevision: null,
    executionEvidencePropertyReadinessRevision: "8",
    executionEvidenceRevokedAt: null,
    updatedAt,
    ...overrides,
  };
}

function pricing(overrides: Record<string, unknown> = {}) {
  return {
    contractVersion: PMS_PRICING_CONTRACT_VERSION,
    propertyId,
    currency: "EUR",
    pricingCurrencyRevision: 7,
    createdAt: updatedAt,
    updatedAt,
    ...overrides,
  };
}

function dependencies(input: { rows?: unknown[]; current?: unknown } = {}) {
  const queries: Array<{ text: string; values?: readonly unknown[] }> = [];
  const pricingReads: string[] = [];
  let ended = 0;
  const pool = {
    async query(text: string, values?: readonly unknown[]) {
      queries.push({ text, values });
      return { rows: input.rows ?? [row()], rowCount: (input.rows ?? [row()]).length } as never;
    },
    async end() {
      ended += 1;
    },
  } satisfies FinancePaymentReadinessReadPool;
  const pricingReadPort = {
    async getPropertyPricingCurrency(requestedPropertyId: string) {
      pricingReads.push(requestedPropertyId);
      return (Object.hasOwn(input, "current") ? input.current : pricing()) as never;
    },
  } satisfies Pick<PmsPricingReadPort, "getPropertyPricingCurrency">;
  return { pool, pricingReadPort, queries, pricingReads, ended: () => ended };
}

function model(input: { rows?: unknown[]; current?: unknown } = {}) {
  const deps = dependencies(input);
  return {
    deps,
    readModel: createPgFinancePaymentReadinessReadModel({
      connectionString: "postgresql://unused",
      pool: deps.pool,
      pricingReadPort: deps.pricingReadPort,
    }),
  };
}

describe("Finance payment readiness read model", () => {
  it("derives method-level readiness from Finance configuration and typed PMS evidence", async () => {
    const { readModel, deps } = model();
    const snapshot = await readModel.getPaymentReadiness({
      organizationId: organizationId.toUpperCase(),
      propertyId: propertyId.toUpperCase(),
    });

    expect(snapshot).toMatchObject({
      propertyId,
      paymentMethodsRevision: 3,
      paymentsEnabled: true,
      bookingPaymentReady: true,
      pricingCurrency: { matchesCurrent: true },
      methods: [
        { method: "pay_at_property", selected: true, readiness: "ready" },
        {
          method: "card",
          selected: true,
          readiness: "unready",
          blockers: ["online_card_execution_unavailable"],
        },
        { method: "bank_transfer", selected: false, availability: "unavailable" },
      ],
    });
    expect(deps.pricingReads).toEqual([propertyId]);
    expect(deps.queries[0]?.values).toEqual([organizationId, propertyId]);
  });

  it("makes card ready only for matching accepted ONB-25A evidence", async () => {
    const { readModel } = model({
      rows: [
        row({
          acceptedMethods: ["card"],
          executionEvidenceContractVersion: "finance-online-card-execution-evidence.v1",
          executionEvidenceProviderAccountId: providerAccountId,
          executionEvidenceCapabilityRevision: "4",
        }),
      ],
    });
    const snapshot = await readModel.getPaymentReadiness({ organizationId, propertyId });
    expect(snapshot).toMatchObject({ bookingPaymentReady: true, readyMethodCount: 1 });
    expect(snapshot?.methods.find(({ method }) => method === "card")).toMatchObject({
      readiness: "ready",
      blockers: [],
    });
  });

  it("keeps matching execution evidence closed for a Finance-unsupported currency", async () => {
    const { readModel } = model({
      rows: [
        row({
          acceptedMethods: ["card"],
          currency: "KWD",
          onlineCardCurrencyEligible: false,
          executionEvidenceContractVersion: "finance-online-card-execution-evidence.v1",
          executionEvidenceProviderAccountId: providerAccountId,
          executionEvidenceCapabilityRevision: "4",
        }),
      ],
      current: pricing({ currency: "KWD" }),
    });
    const snapshot = await readModel.getPaymentReadiness({ organizationId, propertyId });
    expect(snapshot?.bookingPaymentReady).toBe(false);
    expect(snapshot?.methods.find(({ method }) => method === "card")).toMatchObject({
      blockers: ["online_card_currency_unsupported"],
      nextActions: ["edit_pricing"],
    });
  });

  it.each([
    ["stale capability revision", { executionEvidenceCapabilityRevision: "3" }],
    ["stale property revision", { executionEvidencePropertyReadinessRevision: "7" }],
    ["other account", { executionEvidenceProviderAccountId: organizationId }],
    ["lookalike contract", { executionEvidenceContractVersion: "lookalike.v1" }],
  ])("fails card closed for %s evidence", async (_label, evidenceOverride) => {
    const { readModel } = model({
      rows: [
        row({
          acceptedMethods: ["card"],
          executionEvidenceContractVersion: "finance-online-card-execution-evidence.v1",
          executionEvidenceProviderAccountId: providerAccountId,
          executionEvidenceCapabilityRevision: "4",
          ...evidenceOverride,
        }),
      ],
    });
    const snapshot = await readModel.getPaymentReadiness({ organizationId, propertyId });
    expect(snapshot?.methods.find(({ method }) => method === "card")?.blockers).toContain(
      "online_card_execution_unavailable",
    );
  });

  it.each([
    ["missing", null, "pricing_currency_unavailable"],
    ["revision drift", pricing({ pricingCurrencyRevision: 8 }), "pricing_currency_mismatch"],
    ["currency drift", pricing({ currency: "CHF" }), "pricing_currency_mismatch"],
  ])(
    "reports %s current pricing without changing the committed binding",
    async (_name, current, blocker) => {
      const { readModel } = model({ current });
      const snapshot = await readModel.getPaymentReadiness({ organizationId, propertyId });
      const payAtProperty = snapshot?.methods.find(({ method }) => method === "pay_at_property");
      expect(snapshot?.pricingCurrency.committed).toEqual({
        contractVersion: PMS_PRICING_CONTRACT_VERSION,
        currency: "EUR",
        pricingCurrencyRevision: 7,
      });
      expect(payAtProperty).toMatchObject({ readiness: "unready", blockers: [blocker] });
    },
  );

  it("returns null for unavailable or unconfigured scope without crossing to PMS", async () => {
    const { readModel, deps } = model({ rows: [] });
    await expect(readModel.getPaymentReadiness({ organizationId, propertyId })).resolves.toBeNull();
    expect(deps.pricingReads).toEqual([]);
  });

  it("keeps authorization in the Finance query and never reads PMS tables", async () => {
    const { readModel, deps } = model();
    await readModel.getPaymentReadiness({ organizationId, propertyId });
    const sql = deps.queries[0]!.text;
    expect(sql).toContain("organization.kind = 'hotel_group'");
    expect(sql).toContain("resource.relationship IN ('owner', 'operator', 'finance_manager')");
    expect(sql).toContain("entitlement.status = 'active'");
    expect(sql).toContain("entitlement.status = 'suspended'");
    expect(sql).toContain("finance.online_card_readiness");
    expect(sql).not.toMatch(/\bFROM\s+pms\./i);
    expect(sql).not.toMatch(/\bJOIN\s+pms\./i);
  });

  it.each([
    ["contract", { contractVersion: "lookalike.v1" }],
    ["revision", { paymentMethodsRevision: "0" }],
    ["pricing revision", { sourcePricingCurrencyRevision: "0" }],
    ["currency", { currency: "eur" }],
    ["method", { acceptedMethods: ["paypal"] }],
    ["duplicate method", { acceptedMethods: ["card", "card"] }],
    ["timestamp", { updatedAt: "secret-value" }],
    ["property", { propertyId: "323e4567-e89b-42d3-a456-426614174000" }],
  ])("fails closed on a malformed stored %s", async (_name, overrides) => {
    const { readModel, deps } = model({ rows: [row(overrides)] });
    await expect(readModel.getPaymentReadiness({ organizationId, propertyId })).rejects.toThrow(
      "Finance payment readiness row failed contract validation",
    );
    expect(deps.pricingReads).toEqual([]);
  });

  it("rejects malformed or cross-property PMS evidence", async () => {
    for (const current of [
      undefined,
      false,
      0,
      "",
      { providerSecret: "must-not-leak" },
      pricing({ propertyId: "323e4567-e89b-42d3-a456-426614174000" }),
    ]) {
      const { readModel } = model({ current });
      await expect(readModel.getPaymentReadiness({ organizationId, propertyId })).rejects.toThrow(
        "PMS pricing currency read escaped the Finance property scope",
      );
    }
  });

  it("validates scope and leaves injected pools open", async () => {
    const { readModel, deps } = model();
    await expect(
      readModel.getPaymentReadiness({ organizationId, propertyId: "not-a-uuid" }),
    ).rejects.toThrow("Finance payment readiness read scope is malformed");
    await readModel.close();
    expect(deps.ended()).toBe(0);
  });

  it("preserves canonical selected-method ordering", async () => {
    const selectedMethods: FinancePaymentReadinessMethod[] = ["card", "pay_at_property"];
    const { readModel } = model({ rows: [row({ acceptedMethods: selectedMethods })] });
    const snapshot = await readModel.getPaymentReadiness({ organizationId, propertyId });
    expect(
      snapshot?.methods.filter(({ selected }) => selected).map(({ method }) => method),
    ).toEqual(["pay_at_property", "card"]);
  });
});
