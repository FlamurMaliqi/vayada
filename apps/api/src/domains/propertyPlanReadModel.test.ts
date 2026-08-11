import { describe, expect, it } from "vitest";

import { readPropertyPlan, type PropertyPlanQueryable } from "./propertyPlanReadModel.js";

describe("readPropertyPlan", () => {
  it("returns the fixed-plan limits for an active paid entitlement", async () => {
    const queryable: PropertyPlanQueryable = {
      async query<T>() {
        return { rows: [{ plan: "fixed" }] as T[] };
      },
    };

    await expect(
      readPropertyPlan(queryable, "d3000000-0000-0000-0000-000000000682"),
    ).resolves.toEqual({
      propertyId: "d3000000-0000-0000-0000-000000000682",
      plan: "fixed",
      limits: {
        maxRoomPhotosPerType: 15,
        maxAddons: 9,
        guestContactAccess: "always",
      },
    });
  });

  it("fails closed to commission when no current entitlement exists", async () => {
    const queries: Array<{ text: string; values?: unknown[] }> = [];
    const queryable: PropertyPlanQueryable = {
      async query<T>(text: string, values?: unknown[]) {
        queries.push({ text, values });
        return { rows: [] as T[] };
      },
    };

    const result = await readPropertyPlan(queryable, "d3000000-0000-0000-0000-000000000682");

    expect(result.plan).toBe("commission");
    expect(result.limits.maxAddons).toBe(3);
    expect(queries[0]?.text).toContain("entitlement_key = 'direct-booking-finance'");
    expect(queries[0]?.text).toContain("billing_status IN ('trialing', 'active', 'past_due')");
    expect(queries[0]?.values).toEqual(["d3000000-0000-0000-0000-000000000682"]);
  });

  it("rejects ambiguous active plan data", async () => {
    const queryable: PropertyPlanQueryable = {
      async query<T>() {
        return { rows: [{ plan: "fixed" }, { plan: "commission" }] as T[] };
      },
    };

    await expect(
      readPropertyPlan(queryable, "d3000000-0000-0000-0000-000000000682"),
    ).rejects.toThrow("Multiple active booking plan entitlements");
  });
});
