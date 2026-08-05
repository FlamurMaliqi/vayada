import { describe, expect, it } from "vitest";

import {
  FINANCE_PAYMENT_READINESS_AUTHORIZATION,
  FINANCE_PAYMENT_READINESS_OUTBOX_DESTINATION,
  FINANCE_PAYMENT_READINESS_SOURCE_ENTITY_TYPE,
  FINANCE_PAYMENT_READINESS_SOURCE_OWNER_DOMAIN,
  createFinancePaymentMethodsSourceEntityRevision,
  parseReplaceFinancePaymentMethodsCommand,
  serializeFinancePaymentMethodsSourceRevision,
  serializeReplaceFinancePaymentMethodsFingerprint,
} from "./paymentReadiness.js";

const now = "2026-08-03T14:30:00.000Z";
const organizationId = "10000000-0000-4000-8000-000000000001";
const propertyId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const userId = "30000000-0000-4000-8000-000000000003";

function command(overrides: Record<string, unknown> = {}) {
  return {
    organizationId,
    propertyId,
    idempotencyKey: "replace-methods-1",
    expectedPaymentMethodsRevision: 2,
    expectedPricingCurrencyRevision: 4,
    selectedMethods: ["card", "pay_at_property"],
    audit: {
      actor: { kind: "user", userId },
      requestId: "request-1",
      correlationId: null,
      requestedAt: now,
    },
    ...overrides,
  };
}

describe("Finance payment-method command contract", () => {
  it("normalizes a non-empty selection and fingerprints only business inputs", () => {
    const parsed = parseReplaceFinancePaymentMethodsCommand(command());
    expect(parsed?.selectedMethods).toEqual(["pay_at_property", "card"]);
    expect(Object.isFrozen(parsed?.audit.actor)).toBe(true);
    expect(serializeReplaceFinancePaymentMethodsFingerprint(parsed!)).toBe(
      `{"organizationId":"${organizationId}","propertyId":"${propertyId}","expectedPaymentMethodsRevision":2,"expectedPricingCurrencyRevision":4,"selectedMethods":["pay_at_property","card"]}`,
    );
  });

  it.each([
    { selectedMethods: ["pay_at_property", "pay_at_property"] },
    { selectedMethods: ["paypal"] },
    { expectedPaymentMethodsRevision: -1 },
    { expectedPricingCurrencyRevision: 0 },
    { idempotencyKey: " key " },
    { organizationId: "not-a-uuid" },
    { audit: { ...command().audit, requestedAt: "2026-02-30T00:00:00Z" } },
    { unexpected: true },
  ])("rejects malformed or ambiguous commands %#", (invalid) => {
    expect(parseReplaceFinancePaymentMethodsCommand(command(invalid))).toBeNull();
  });

  it("allows deselecting the final method as an expected-versioned replacement", () => {
    const parsed = parseReplaceFinancePaymentMethodsCommand(command({ selectedMethods: [] }));
    expect(parsed?.selectedMethods).toEqual([]);
    expect(serializeReplaceFinancePaymentMethodsFingerprint(parsed!)).toContain(
      '"selectedMethods":[]',
    );
  });

  it("publishes the exact Finance write/read policy", () => {
    expect(FINANCE_PAYMENT_READINESS_AUTHORIZATION).toEqual({
      permission: "pms.finance.manage",
      entitlement: { product: "pms", key: "property-management" },
      resource: {
        product: "pms",
        resourceType: "pms_property",
        allowedRelationships: ["owner", "finance_manager"],
      },
    });
  });

  it("publishes one stable Finance aggregate identity with an opaque revision", () => {
    expect(FINANCE_PAYMENT_READINESS_SOURCE_OWNER_DOMAIN).toBe("finance");
    expect(FINANCE_PAYMENT_READINESS_SOURCE_ENTITY_TYPE).toBe("finance_payment_methods.v1");
    expect(FINANCE_PAYMENT_READINESS_OUTBOX_DESTINATION).toBe("booking.payment-source");
    expect(serializeFinancePaymentMethodsSourceRevision(3)).toBe("3");
    expect(createFinancePaymentMethodsSourceEntityRevision(propertyId, 3)).toEqual({
      ownerDomain: "finance",
      entityType: "finance_payment_methods.v1",
      entityId: propertyId,
      revision: "3",
    });
  });

  it.each([
    [propertyId, 0],
    [propertyId, Number.MAX_SAFE_INTEGER + 1],
    [propertyId, " 3 " as unknown as number],
    [propertyId.toUpperCase(), 3],
    [` ${propertyId}`, 3],
  ])("rejects a noncanonical source identity %#", (entityId, revision) => {
    expect(() => createFinancePaymentMethodsSourceEntityRevision(entityId, revision)).toThrow();
  });
});
