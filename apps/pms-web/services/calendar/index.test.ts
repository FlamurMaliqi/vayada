import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  get: vi.fn(),
  post: vi.fn(),
  patch: vi.fn(),
  delete: vi.fn(),
  resolvePropertyId: vi.fn(),
}));

vi.mock("../api/pmsOperationsClient", () => ({
  pmsOperationsClient: {
    get: mocks.get,
    post: mocks.post,
    patch: mocks.patch,
    delete: mocks.delete,
  },
  pmsOperationsRequestOptions: { headers: { "X-Vayada-Omit-Hotel-Context": "true" } },
}));

vi.mock("../api/pmsPropertyClient", () => ({
  resolveSelectedPmsPropertyId: mocks.resolvePropertyId,
  propertyEndpoint: (propertyId: string, path: string) =>
    `/api/pms/properties/${propertyId}/${path}`,
}));

import { calendarService } from ".";

const targetBlock = {
  blockId: "block-1",
  version: "room-block-v1",
  roomTypeId: "room-type-1",
  roomId: "room-1",
  startsOn: "2026-08-20",
  endsOn: "2026-08-22",
  blockedCount: 1,
  reason: "Maintenance",
  status: "active" as const,
};

const linkedBlock = {
  ...targetBlock,
  blockId: "linked-block-1",
  roomId: null,
  reason: "Linked inventory",
  kind: "linked_booking" as const,
  sourceRoomTypeId: "room-type-source",
  sourceRoomTypeName: "Alpine Suite",
  sourceSummary: "Booking VAY-42 · Alpine Suite",
  protected: true,
};

describe("calendarService room block commands", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.resolvePropertyId.mockResolvedValue("property-1");
    const response = {
      contractVersion: "pms-operations.v1",
      propertyId: "property-1",
      items: [targetBlock],
    };
    mocks.post.mockResolvedValue(response);
    mocks.patch.mockResolvedValue(response);
    mocks.delete.mockResolvedValue(response);
  });

  it("creates exact physical-room blocks with target-inclusive dates", async () => {
    const items = await calendarService.createRoomBlock({
      roomTypeId: "room-type-1",
      roomIds: ["room-1", "room-2"],
      startDate: "2026-08-20",
      endDate: "2026-08-23",
      reason: "Maintenance",
    });

    expect(mocks.post).toHaveBeenCalledWith(
      "/api/pms/properties/property-1/room-blocks",
      expect.objectContaining({
        commandId: expect.any(String),
        idempotencyKey: expect.stringMatching(/^pms-room-block:/),
        roomTypeId: "room-type-1",
        roomIds: ["room-1", "room-2"],
        startsOn: "2026-08-20",
        endsOn: "2026-08-22",
        reason: "Maintenance",
      }),
      { headers: { "X-Vayada-Omit-Hotel-Context": "true" } },
    );
    expect(items[0]).toMatchObject({
      id: "block-1",
      version: "room-block-v1",
      startDate: "2026-08-20",
      endDate: "2026-08-23",
    });
  });

  it("sends stale-write versions for updates and releases", async () => {
    await calendarService.updateRoomBlock("block-1", "room-block-v1", {
      startDate: "2026-08-21",
      endDate: "2026-08-25",
      reason: "Extended maintenance",
    });
    await calendarService.deleteRoomBlock("block-1", "room-block-v2");

    expect(mocks.patch).toHaveBeenCalledWith(
      "/api/pms/properties/property-1/room-blocks/block-1",
      expect.objectContaining({
        expectedVersion: "room-block-v1",
        startsOn: "2026-08-21",
        endsOn: "2026-08-24",
      }),
      { headers: { "X-Vayada-Omit-Hotel-Context": "true" } },
    );
    expect(mocks.delete).toHaveBeenCalledWith(
      "/api/pms/properties/property-1/room-blocks/block-1",
      expect.objectContaining({
        body: expect.stringContaining('"expectedVersion":"room-block-v2"'),
      }),
    );
  });

  it("preserves linked cause context for protected calendar blocks", async () => {
    mocks.post.mockResolvedValue({ items: [linkedBlock] });

    const [block] = await calendarService.createRoomBlock({
      roomTypeId: "room-type-1",
      roomIds: [],
      startDate: "2026-08-20",
      endDate: "2026-08-23",
      reason: "Linked inventory",
    });

    expect(block).toMatchObject({
      kind: "linked_booking",
      sourceRoomTypeName: "Alpine Suite",
      sourceSummary: "Booking VAY-42 · Alpine Suite",
      protected: true,
    });
  });
});

describe("calendarService room order command", () => {
  it("sends the complete room order to the target property route", async () => {
    vi.clearAllMocks();
    mocks.resolvePropertyId.mockResolvedValue("property-1");
    mocks.patch.mockResolvedValue({
      contractVersion: "pms-operations.v1",
      propertyId: "property-1",
      orderedRoomIds: ["room-2", "room-1"],
      orderVersion: "room-order-v2",
    });

    await expect(calendarService.reorderRooms(["room-2", "room-1"], "room-order-v1")).resolves.toBe(
      "room-order-v2",
    );

    expect(mocks.patch).toHaveBeenCalledWith(
      "/api/pms/properties/property-1/rooms/reorder",
      {
        commandId: expect.any(String),
        idempotencyKey: expect.stringMatching(/^pms-room-reorder:/),
        expectedVersion: "room-order-v1",
        orderedRoomIds: ["room-2", "room-1"],
      },
      { headers: { "X-Vayada-Omit-Hotel-Context": "true" } },
    );
  });
});

describe("calendarService manual-booking rates", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.resolvePropertyId.mockResolvedValue("property-1");
    mocks.get.mockImplementation(async (route: string) => {
      if (route.endsWith("/room-types"))
        return {
          items: [
            {
              roomTypeId: "room-type-1",
              name: "Suite",
              category: null,
              attributes: { size: { value: 38, unit: "sqm" } },
              occupancyLimits: { adults: 2, children: 0, total: 2 },
              baseRate: { amountDecimal: "100.00", currency: "EUR" },
              roomCount: 1,
              ratePlans: [
                {
                  ratePlanId: "legacy-plan",
                  pricingContractVersion: null,
                  name: "Legacy flexible",
                  rateType: "flexible",
                  baseRate: { amountDecimal: "100.00", currency: "EUR" },
                  active: true,
                },
                {
                  ratePlanId: "canonical-plan",
                  pricingContractVersion: "pms-pricing.v1",
                  name: "Flexible",
                  rateType: "flexible",
                  baseRate: { amountDecimal: "150.00", currency: "EUR" },
                  active: true,
                },
              ],
            },
          ],
        };
      if (route.includes("/reservations?"))
        return { items: [], pagination: { total: 0, limit: 500, offset: 0 } };
      if (route.endsWith("/rooms"))
        return {
          items: [
            {
              roomId: "room-1",
              roomTypeId: "room-type-1",
              roomNumber: "101",
              floor: "1",
              status: "available",
            },
          ],
          orderVersion: "room-order-v1",
        };
      return { items: [] };
    });
  });

  it("offers only the canonical flexible plan", async () => {
    const result = await calendarService.getCalendarData("2026-08-20", "2026-08-24");

    expect(result.roomTypes[0]?.ratePlans).toEqual([
      {
        id: "canonical-plan",
        name: "Flexible",
        rateType: "flexible",
        baseRate: 150,
      },
    ]);
    expect(result.rooms[0]?.size).toBe(38);
  });
});
