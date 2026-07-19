import { describe, expect, it } from "vitest";

import { handoffReturnToForOrganization, missingOrganizationHandoffLoginPath } from "./returnTo";

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
