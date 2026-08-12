import { describe, expect, it } from "vitest";

import { createTargetPmsRoomInventoryReadPort } from "./pmsRoomInventoryReadModel.js";

describe("target PMS room inventory read port", () => {
  it("counts non-retired rooms on active room types", async () => {
    const queries: string[] = [];
    const port = createTargetPmsRoomInventoryReadPort({
      connectionString: "postgres://unused",
      pool: {
        async query(text) {
          queries.push(text);
          return {
            rows: [{ activeRoomCount: 4, capturedAt: "2026-08-11T12:00:00.000Z" }],
          } as never;
        },
      },
    });

    await expect(
      port.getRoomInventorySnapshot("00000000-0000-4000-8000-000000000001"),
    ).resolves.toEqual({
      propertyId: "00000000-0000-4000-8000-000000000001",
      activeRoomCount: 4,
      capturedAt: "2026-08-11T12:00:00.000Z",
    });
    expect(queries.join("\n")).toContain("room_type.active = TRUE");
    expect(queries.join("\n")).toContain("room.status <> 'retired'");
  });

  it("returns null for an unknown property", async () => {
    const port = createTargetPmsRoomInventoryReadPort({
      connectionString: "postgres://unused",
      pool: {
        async query() {
          return { rows: [] } as never;
        },
      },
    });
    await expect(port.getRoomInventorySnapshot("missing")).resolves.toBeNull();
  });
});
