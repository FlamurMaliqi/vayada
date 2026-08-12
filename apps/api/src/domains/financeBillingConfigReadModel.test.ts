import { describe, expect, it } from "vitest";

import { createTargetFinanceBillingConfigReadPort } from "./financeBillingConfigReadModel.js";

describe("target Finance billing config read port", () => {
  it("maps the active plan and immutable commission inputs", async () => {
    let sql = "";
    const port = createTargetFinanceBillingConfigReadPort({
      connectionString: "postgres://unused",
      pool: {
        async query(text) {
          sql = text;
          return {
            rows: [
              {
                activePlan: "fixed",
                percentageRate: "5.0000",
                ruleMetadata: { channelManagerFeePercent: 7, affiliatePlatformFeePercent: 2 },
                updatedAt: "2026-08-11T12:00:00.000Z",
              },
            ],
          } as never;
        },
      },
    });

    await expect(port.getBillingConfig("property-1")).resolves.toEqual({
      propertyId: "property-1",
      activePlan: "fixed",
      bookingEngineFeePercent: 5,
      channelManagerFeePercent: 7,
      affiliatePlatformFeePercent: 2,
      updatedAt: "2026-08-11T12:00:00.000Z",
    });
    expect(sql.match(/FOR SHARE/g)).toHaveLength(2);
    expect(sql).toContain("billing_status IN ('trialing', 'active')");
    expect(sql).toContain("entitlement_metadata ->> 'planSelectedAt'");
    expect(sql).toContain("provider_subscription_status IN ('trialing', 'active')");
    expect(sql).toContain("source_rule_id = 'onboarding-booking:' || property.id::text");
    expect(sql).toContain("commission_type = 'percentage'");
    expect(sql).toContain("percentage_rate = 5");
  });

  it("does not invent commission terms for an unconfigured property", async () => {
    const port = createTargetFinanceBillingConfigReadPort({
      connectionString: "postgres://unused",
      pool: {
        async query() {
          return { rows: [] } as never;
        },
      },
    });
    await expect(port.getBillingConfig("property-1")).resolves.toBeNull();
  });
});
