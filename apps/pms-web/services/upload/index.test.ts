import { describe, expect, it } from "vitest";

import { pmsRoomMediaResource } from "./index";

describe("pmsRoomMediaResource", () => {
  it("uses the canonical property and room target", () => {
    expect(pmsRoomMediaResource("property_123", "room_type_456")).toEqual({
      product: "hotel_catalog",
      resourceType: "property",
      resourceId: "property_123",
      propertyId: "property_123",
      targetResourceId: "room_type_456",
    });
  });

  it("leaves the target empty while files are staged for a new room", () => {
    expect(pmsRoomMediaResource("property_123")).toEqual({
      product: "hotel_catalog",
      resourceType: "property",
      resourceId: "property_123",
      propertyId: "property_123",
    });
  });
});
