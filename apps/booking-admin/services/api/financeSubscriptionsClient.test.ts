import { describe, expect, it, vi } from "vitest";

import {
  createFixedPlanCheckout,
  getFinancePlanStatus,
  openFinanceCustomerPortal,
  switchToCommissionPlan,
} from "./financeSubscriptionsClient";

describe("Finance subscriptions client", () => {
  it("uses target Finance routes and explicit command idempotency", async () => {
    const client = { get: vi.fn(), post: vi.fn() };
    client.get.mockResolvedValue({ planStatus: { plan: "commission" } });
    client.post.mockResolvedValue({});

    await getFinancePlanStatus("property-1", client as never);
    await createFixedPlanCheckout(
      { propertyId: "property-1", commandId: "checkout-1" },
      client as never,
    );
    await openFinanceCustomerPortal(
      { propertyId: "property-1", commandId: "portal-1" },
      client as never,
    );
    await switchToCommissionPlan(
      { propertyId: "property-1", commandId: "commission-1" },
      client as never,
    );

    expect(client.get).toHaveBeenCalledWith(
      "/api/finance/properties/property-1/plan-status",
      expect.objectContaining({ headers: { "X-Vayada-Omit-Hotel-Context": "true" } }),
    );
    expect(client.post.mock.calls.map(([url]) => url)).toEqual([
      "/api/finance/properties/property-1/fixed-plan/checkout",
      "/api/finance/properties/property-1/customer-portal",
      "/api/finance/properties/property-1/switch-to-commission",
    ]);
    expect(client.post.mock.calls.map(([, body]) => body)).toEqual([
      {
        commandId: "checkout-1",
        idempotencyKey: "checkout-1",
      },
      { commandId: "portal-1", idempotencyKey: "portal-1" },
      { commandId: "commission-1", idempotencyKey: "commission-1" },
    ]);
  });
});
