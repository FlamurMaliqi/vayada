import { expect, it } from "vitest";

import { buildApp } from "./app.js";

const propertyId = "19710000-0000-4000-8000-000000000001";
const roomTypeId = "19710000-0000-4000-8000-000000000002";

it("mounts canonical room setup owners only below the non-overlapping setup prefix", async () => {
  const disabled = buildApp({ logger: false });
  expect(
    (
      await disabled.inject({
        method: "POST",
        url: `/api/pms/setup/properties/${propertyId}/room-types`,
      })
    ).statusCode,
  ).toBe(404);
  await disabled.close();

  const unavailable = async () => {
    throw new Error("unexpected owner call");
  };
  const enabled = buildApp({
    logger: false,
    pmsRoomSetup: {
      facts: {
        commandPort: {
          createRoomTypeFacts: unavailable,
          updateRoomTypeFacts: unavailable,
          safeDeleteRoomType: unavailable,
        },
        factsReadPort: {
          getRoomTypeFacts: unavailable,
          listRoomTypeFacts: unavailable,
        },
        bindingReadPort: { getDraftRoomTypeBinding: unavailable },
        unitReadPort: { listPhysicalRoomUnitIdentities: unavailable },
        capacityReadPort: { getRoomTypeCapacity: unavailable },
      },
      physicalUnits: {
        commandPort: { reconcilePhysicalRoomUnits: unavailable },
      },
    },
  });

  for (const [method, suffix] of [
    ["POST", "room-types"],
    ["GET", `room-types/${roomTypeId}/units`],
    ["PUT", `room-types/${roomTypeId}/physical-units/reconcile`],
  ] as const) {
    expect(
      (
        await enabled.inject({
          method,
          url: `/api/pms/setup/properties/${propertyId}/${suffix}`,
        })
      ).statusCode,
    ).toBe(401);
  }
  expect(
    (
      await enabled.inject({
        method: "POST",
        url: `/api/pms/properties/${propertyId}/room-types`,
      })
    ).statusCode,
  ).toBe(404);
  await enabled.close();
});
