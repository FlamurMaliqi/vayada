import { describe, expect, it } from "vitest";

import { setupPathForSelectedProperty } from "./SharedHotelSetupPage";

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
});
