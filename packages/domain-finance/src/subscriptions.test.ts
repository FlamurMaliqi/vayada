import { describe, expect, it } from "vitest";

import {
  FINANCE_FIXED_PLAN_INTERVAL_DAYS,
  fixedPlanAmountMinor,
  toFinancePlanStatusResponse,
} from "./subscriptions.js";

describe("fixed-plan subscription contracts", () => {
  it.each([
    [0, 3_000],
    [1, 3_000],
    [2, 3_500],
    [8, 6_500],
  ])("prices %i active rooms in EUR minor units", (activeRoomCount, amountMinor) => {
    expect(fixedPlanAmountMinor(activeRoomCount)).toBe(amountMinor);
  });

  it("uses an exact 30-day interval", () => {
    expect(FINANCE_FIXED_PLAN_INTERVAL_DAYS).toBe(30);
  });

  it.each([-1, 1.5, Number.NaN])("rejects invalid room counts", (activeRoomCount) => {
    expect(() => fixedPlanAmountMinor(activeRoomCount)).toThrow(TypeError);
  });

  it("keeps provider identifiers out of the plan-status response", () => {
    const response = toFinancePlanStatusResponse({
      propertyId: "property-1",
      plan: "fixed",
      status: "cancel_at_period_end",
      currency: "EUR",
      activeRoomCount: 4,
      amountMinor: 4_500,
      currentPeriodStart: "2026-08-11T12:00:00.000Z",
      currentPeriodEnd: "2026-09-10T12:00:00.000Z",
      nextBillingDate: null,
      cancelAtPeriodEnd: true,
      checkoutPending: false,
      customerPortalAvailable: true,
      activatedAt: "2026-08-11T12:00:00.000Z",
      updatedAt: "2026-08-11T12:01:00.000Z",
    });

    expect(response).toMatchObject({
      contractVersion: "finance-subscriptions.v1",
      propertyId: "property-1",
      planStatus: {
        plan: "fixed",
        status: "cancel_at_period_end",
        cancelAtPeriodEnd: true,
      },
    });
    expect(JSON.stringify(response)).not.toMatch(/customerId|subscriptionId|checkoutSessionId/);
  });
});
