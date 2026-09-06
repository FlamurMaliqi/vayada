import { describe, expect, it } from "vitest";

import {
  productHandoffReturnTo,
  setupPathForSelectedProperty,
  setupExitPathForContext,
} from "./SharedHotelSetupPage";

describe("setupPathForSelectedProperty", () => {
  it("persists the selected property and leaves add-property mode", () => {
    expect(
      setupPathForSelectedProperty(
        "mode=add&entryProduct=marketplace&returnTo=%2Fmarketplace",
        "property-1",
      ),
    ).toBe("/setup?entryProduct=marketplace&returnTo=%2Fmarketplace&propertyId=property-1");
  });

  it("replaces a stale property without dropping the setup return context", () => {
    expect(
      setupPathForSelectedProperty(
        "entryProduct=pms&returnProduct=booking&propertyId=old-property",
        "new-property",
      ),
    ).toBe("/setup?entryProduct=pms&returnProduct=booking&propertyId=new-property");
  });

  it.each(["return", "refresh"] as const)(
    "replaces a tampered Stripe %s property without leaving Payments",
    (stripe) => {
      expect(
        setupPathForSelectedProperty(
          `propertyId=foreign-property&step=payments&stripe=${stripe}`,
          "authorized-property",
        ),
      ).toBe(`/setup?propertyId=authorized-property&step=payments&stripe=${stripe}`);
    },
  );
});

describe("productHandoffReturnTo", () => {
  it("preserves the property and hotel-group context across target-app reauthentication", () => {
    expect(
      productHandoffReturnTo("/dashboard?setup=incomplete&propertyId=property-1", "property-1", {
        organizationId: "organization-1",
        workosOrganizationId: "workos-organization-1",
      }),
    ).toBe(
      "/handoff?redirect=%2Fdashboard%3Fsetup%3Dincomplete%26propertyId%3Dproperty-1#property_id=property-1&organization_id=organization-1&workos_organization_id=workos-organization-1",
    );
  });

  it("routes a no-property setup exit through PMS handoff with hotel-group context", () => {
    expect(
      productHandoffReturnTo("/choose-property?setup=incomplete", null, {
        organizationId: "organization-1",
        workosOrganizationId: "workos-organization-1",
      }),
    ).toBe(
      "/handoff?redirect=%2Fchoose-property%3Fsetup%3Dincomplete#organization_id=organization-1&workos_organization_id=workos-organization-1",
    );
  });
});

describe("calendar recovery exit", () => {
  it("returns to calendar settings after repair without an incomplete marker", () => {
    expect(
      setupExitPathForContext(
        "recovery=pms-calendar&returnProduct=pms&returnTo=%2Fsettings%23calendar",
        "property-1",
      ),
    ).toBe("/settings#calendar");
  });
  it("rejects an external return destination", () => {
    expect(
      setupExitPathForContext(
        "recovery=pms-calendar&returnProduct=pms&returnTo=https%3A%2F%2Fevil.example",
        "property-1",
      ),
    ).toBe("/settings#calendar");
  });
  it("preserves the ordinary incomplete-setup exit", () => {
    expect(setupExitPathForContext("returnProduct=pms", "property-1")).toBe(
      "/dashboard?setup=incomplete&propertyId=property-1",
    );
  });
});
