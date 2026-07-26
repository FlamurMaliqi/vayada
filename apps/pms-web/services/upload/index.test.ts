import { describe, expect, it } from "vitest";

import { pmsRoomMediaResource } from "./index";

describe("pmsRoomMediaResource", () => {
  it("uses the PMS property scope granted by the authenticated session", () => {
    expect(pmsRoomMediaResource("property_123", "room_type_456")).toEqual({
      product: "pms",
      resourceType: "pms_property",
      resourceId: "property_123",
      targetResourceId: "room_type_456",
    });
  });

  it("allows media uploads while a room type is being created", () => {
    expect(pmsRoomMediaResource("property_123")).toMatchObject({
      resourceType: "pms_property",
      targetResourceId: "pending-room-type",
    });
  });
});
