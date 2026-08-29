import { describe, expect, it } from "vitest";

import {
  createFinancePaymentReadinessSnapshot,
  parseFinancePaymentReadinessSnapshot,
  parseReplaceFinancePaymentMethodsResult,
} from "./index.js";

const now = "2026-08-03T14:30:00.000Z";

function snapshot() {
  return createFinancePaymentReadinessSnapshot({
    propertyId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    paymentMethodsRevision: 3,
    selectedMethods: ["pay_at_property"],
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
    onlineCardReadiness: "execution_unavailable",
    updatedAt: now,
  });
}

describe("Finance payment readiness trust-boundary parsing", () => {
  it("accepts the canonical derived snapshot and rejects fabricated readiness", () => {
    const paymentReadiness = snapshot();
    expect(
      parseFinancePaymentReadinessSnapshot(JSON.parse(JSON.stringify(paymentReadiness))),
    ).toEqual(paymentReadiness);
    expect(
      parseFinancePaymentReadinessSnapshot({
        ...paymentReadiness,
        bookingPaymentReady: false,
      }),
    ).toBeNull();
  });

  it("parses exact stored successes for byte-stable replay", () => {
    const paymentReadiness = snapshot();
    expect(
      parseReplaceFinancePaymentMethodsResult({
        ok: true,
        response: {
          contractVersion: "finance-payment-readiness.v1",
          outcome: "updated",
          paymentReadiness,
          acceptedAt: now,
        },
      }),
    ).toEqual({
      ok: true,
      response: {
        contractVersion: "finance-payment-readiness.v1",
        outcome: "updated",
        paymentReadiness,
        acceptedAt: now,
      },
    });
  });

  it("parses only the bounded error vocabulary", () => {
    expect(
      parseReplaceFinancePaymentMethodsResult({
        ok: false,
        error: { code: "payment_methods_revision_conflict", currentRevision: 0 },
      }),
    ).toEqual({
      ok: false,
      error: { code: "payment_methods_revision_conflict", currentRevision: 0 },
    });
    expect(
      parseReplaceFinancePaymentMethodsResult({
        ok: false,
        error: { code: "payment_method_unavailable", method: "card" },
      }),
    ).toBeNull();
    expect(
      parseReplaceFinancePaymentMethodsResult({
        ok: false,
        error: { code: "command_in_progress", unsafeMessage: "provider secret" },
      }),
    ).toBeNull();
  });
});
