import { buildApp } from "./app.js";
import { createPmsOperatingCalendarProductionRuntime } from "./domains/pmsOperatingCalendarProductionRuntime.js";
import { expect, it } from "vitest";

const propertyId = "19700000-0000-4000-8000-000000000001";

it("mounts the protected calendar and materialization routes only with the production runtime", async () => {
  const input = runtimeInput();
  expect(createPmsOperatingCalendarProductionRuntime({ ...input, enabled: false })).toBeNull();

  const runtime = createPmsOperatingCalendarProductionRuntime({ ...input, enabled: true });
  if (!runtime) throw new Error("Expected enabled operating-calendar runtime");
  expect(runtime.routes).toMatchObject({
    commandPort: { upsertOperatingCalendar: expect.any(Function) },
    impactPreviewPort: { previewOperatingCalendarImpact: expect.any(Function) },
    readPort: input.operatingCalendar,
    materializationPort: { materializeInventory: expect.any(Function) },
  });
  expect(runtime.inventory.getInventoryLaunchReadiness).toEqual(expect.any(Function));

  const disabled = buildApp({ logger: false });
  expect(
    (
      await disabled.inject({
        method: "POST",
        url: `/api/pms/properties/${propertyId}/inventory-materialization`,
      })
    ).statusCode,
  ).toBe(404);
  await disabled.close();

  const enabled = buildApp({ logger: false, pmsOperatingCalendar: runtime.routes });
  for (const [method, suffix] of [
    ["POST", "operating-calendar/impact-preview"],
    ["PUT", "operating-calendar"],
    ["POST", "inventory-materialization"],
  ] as const) {
    expect(
      (
        await enabled.inject({
          method,
          url: `/api/pms/properties/${propertyId}/${suffix}`,
        })
      ).statusCode,
    ).toBe(401);
  }
  await enabled.close();
  await runtime.close();
});

function runtimeInput() {
  const propertyProfileEvidence = {
    ownerDomain: "hotel_catalog" as const,
    registryVersion: "test.v1",
    isCanonicalIanaTimeZone: () => true,
    runWithPropertyProfileEvidence: async () => {
      throw new Error("unexpected property-profile read");
    },
  };
  return {
    enabled: true,
    connectionString: "postgresql://unused",
    confirmationSecret: "vay1300-operating-calendar-secret-32-bytes",
    authorizationPool: { query: async () => ({ rows: [], rowCount: 0 }) } as never,
    propertyProfileEvidence,
    roomEvidence: {
      roomFacts: { listRoomTypeFacts: async () => [] },
      roomCapacity: { getRoomTypeCapacity: async () => null },
    },
    operatingCalendar: {
      getCurrentOperatingCalendarConfiguration: async () => null,
      getOperatingCalendarConfigurationBySource: async () => null,
    },
  };
}
