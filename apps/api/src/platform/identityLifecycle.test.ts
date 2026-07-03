import { describe, expect, it } from "vitest";

import { membershipPermissionGrantRows } from "./identityLifecycle.js";

describe("identity lifecycle writer", () => {
  it("maps membership permission keys to role grants", () => {
    expect(
      membershipPermissionGrantRows({
        organization: {
          kind: "hotel_group",
          name: "Alpenrose Hotel Group",
        },
        membership: {
          roleKey: "hotel_owner",
          permissionKeys: ["hotel_catalog.setup.read", "hotel_catalog.setup.manage"],
        },
      }),
    ).toEqual([
      {
        organizationKind: "hotel_group",
        roleKey: "hotel_owner",
        permissionKey: "hotel_catalog.setup.read",
      },
      {
        organizationKind: "hotel_group",
        roleKey: "hotel_owner",
        permissionKey: "hotel_catalog.setup.manage",
      },
    ]);
  });
});
