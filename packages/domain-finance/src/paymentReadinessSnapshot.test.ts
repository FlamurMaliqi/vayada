import { describe, expect, it } from "vitest";

import { createFinancePaymentReadinessSnapshot } from "./index.js";

const now = "2026-08-03T14:30:00.000Z";
const propertyId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

function snapshot(overrides: Record<string, unknown> = {}) {
  return createFinancePaymentReadinessSnapshot({
    propertyId,
    paymentMethodsRevision: 3,
    selectedMethods: ["pay_at_property", "card"],
    committedPricing: {
      contractVersion: "pms-pricing.v1",
      currency: "EUR",
      pricingCurrencyRevision: 4,
    },
    currentPricing: {
      contractVersion: "pms-pricing.v1",
      currency: "EUR",
      pricingCurrencyRevision: 4,
    },
    updatedAt: now,
    ...overrides,
  });
}

describe("Finance payment readiness derivation", () => {
  it("makes committed Pay at hotel ready without bank data", () => {
    const result = snapshot({ selectedMethods: ["pay_at_property"] });
    expect(result).toMatchObject({
      bookingPaymentReady: true,
      selectedMethodCount: 1,
      readyMethodCount: 1,
      pricingCurrency: { matchesCurrent: true },
    });
    expect(result.methods).toEqual([
      expect.objectContaining({
        method: "pay_at_property",
        selected: true,
        readiness: "ready",
        blockers: [],
      }),
      expect.objectContaining({ method: "card", selected: false, readiness: "unready" }),
      expect.objectContaining({
        method: "bank_transfer",
        selected: false,
        availability: "unavailable",
      }),
    ]);
    expect(JSON.stringify(result)).not.toMatch(/account|iban|swift|secret/i);
  });

  it("keeps a selected pending card as a warning when Pay at hotel is ready", () => {
    const result = snapshot();
    expect(result.bookingPaymentReady).toBe(true);
    expect(result.methods.find(({ method }) => method === "card")).toMatchObject({
      selected: true,
      availability: "available",
      readiness: "unready",
      consequence: "warning",
      blockers: ["online_card_execution_unavailable"],
    });
  });

  it("never makes a connected-card-shaped selection ready without execution evidence", () => {
    const result = snapshot({ selectedMethods: ["card"] });
    expect(result.bookingPaymentReady).toBe(false);
    expect(result.methods.find(({ method }) => method === "card")?.consequence).toBe("blocking");
  });

  it("keeps bank transfer unavailable and distinct from Pay at hotel", () => {
    const result = snapshot({ selectedMethods: ["bank_transfer"] });
    expect(result.bookingPaymentReady).toBe(false);
    expect(result.methods.find(({ method }) => method === "bank_transfer")).toMatchObject({
      availability: "unavailable",
      blockers: ["bank_transfer_contract_unavailable"],
    });
    expect(result.methods.find(({ method }) => method === "pay_at_property")?.selected).toBe(false);
  });

  it("fails only Pay at hotel closed when the pricing evidence moves", () => {
    const result = snapshot({
      currentPricing: {
        contractVersion: "pms-pricing.v1",
        currency: "CHF",
        pricingCurrencyRevision: 5,
      },
    });
    expect(result.bookingPaymentReady).toBe(false);
    expect(result.methods.find(({ method }) => method === "pay_at_property")).toMatchObject({
      readiness: "unready",
      blockers: ["pricing_currency_mismatch"],
    });
    expect(result.methods.find(({ method }) => method === "card")?.blockers).toEqual([
      "online_card_execution_unavailable",
    ]);
  });

  it("fails Pay at hotel closed when the PMS contract binding moves", () => {
    const result = snapshot({
      currentPricing: {
        contractVersion: "pms-pricing.v2",
        currency: "EUR",
        pricingCurrencyRevision: 4,
      },
    });
    expect(result.methods.find(({ method }) => method === "pay_at_property")?.blockers).toEqual([
      "pricing_currency_mismatch",
    ]);
  });

  it("uses only the owner revision and returns detached frozen values", () => {
    const first = snapshot();
    const second = snapshot({ selectedMethods: ["card", "pay_at_property"] });
    expect(first.paymentMethodsRevision).toBe(second.paymentMethodsRevision);
    expect(first).not.toHaveProperty("readinessRevision");
    expect(Object.isFrozen(first.methods)).toBe(true);
    expect(Object.isFrozen(first.methods[0]?.blockers)).toBe(true);
  });

  it("does not copy structurally wider or secret-shaped pricing evidence", () => {
    expect(() =>
      snapshot({
        currentPricing: {
          contractVersion: "pms-pricing.v1",
          currency: "EUR",
          pricingCurrencyRevision: 4,
          providerSecret: "must-not-cross",
        },
      }),
    ).toThrow("Finance payment readiness input is invalid");
  });
});
