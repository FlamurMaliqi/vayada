import { describe, expect, it } from "vitest";

import {
  buildProductHandoffUrl,
  handoffReturnToForOrganization,
  missingOrganizationHandoffLoginPath,
  organizationSelectionLoginPath,
} from "./returnTo";

describe("buildProductHandoffUrl", () => {
  it("carries product setup and hotel-group context between apps", () => {
    expect(
      buildProductHandoffUrl(
        "https://pms.vayada.com",
        "property_1",
        "organization_1",
        "org_workos_1",
        "/setup?entryProduct=pms&propertyId=property_1",
      ),
    ).toBe(
      "https://pms.vayada.com/handoff?redirect=%2Fsetup%3FentryProduct%3Dpms%26propertyId%3Dproperty_1#property_id=property_1&organization_id=organization_1&workos_organization_id=org_workos_1",
    );
  });
});

describe("handoffReturnToForOrganization", () => {
  it("rewrites organization hints while preserving the property and redirect", () => {
    expect(
      handoffReturnToForOrganization(
        "/handoff?redirect=%2Fsetup%3Fmode%3Dadd#organization_id=stale&property_id=property_1",
        {
          organizationId: "organization_2",
          workosOrganizationId: "org_workos_2",
        },
      ),
    ).toBe(
      "/handoff?redirect=%2Fsetup%3Fmode%3Dadd#organization_id=organization_2&property_id=property_1&workos_organization_id=org_workos_2",
    );
  });

  it("leaves non-handoff and unsafe return targets unchanged", () => {
    const organization = {
      organizationId: "organization_2",
      workosOrganizationId: "org_workos_2",
    };
    expect(handoffReturnToForOrganization("/dashboard", organization)).toBe("/dashboard");
    expect(handoffReturnToForOrganization("https://example.com/handoff", organization)).toBe(
      "https://example.com/handoff",
    );
  });

  it("builds a terminal login error for handoffs that cannot identify the WorkOS organization", () => {
    const path = new URL(missingOrganizationHandoffLoginPath(), "https://vayada.local");

    expect(path.pathname).toBe("/login");
    expect(path.searchParams.has("returnTo")).toBe(false);
    expect(path.searchParams.get("auth_error")).toContain("missing hotel-group context");
  });
});

describe("organizationSelectionLoginPath", () => {
  it("preserves handoff context while dropping credentials and unknown hash values", () => {
    const path = new URL(
      organizationSelectionLoginPath(
        "/handoff",
        "?redirect=%2Fsetup%3Fmode%3Dadd",
        "#token=secret&organization_id=organization_1&workos_organization_id=org_workos_1&property_id=property_1&hotel_id=hotel_1&user=private",
      ),
      "https://vayada.local",
    );

    expect(path.pathname).toBe("/login");
    expect(path.searchParams.get("auth")).toBe("callback");
    expect(path.searchParams.get("returnTo")).toBe(
      "/handoff?redirect=%2Fsetup%3Fmode%3Dadd#organization_id=organization_1&workos_organization_id=org_workos_1&property_id=property_1&hotel_id=hotel_1",
    );
  });

  it("returns a callback to the current path when there is no safe hash context", () => {
    const path = new URL(
      organizationSelectionLoginPath("/handoff", "", "#token=secret"),
      "https://vayada.local",
    );

    expect(path.searchParams.get("returnTo")).toBe("/handoff");
  });
});
