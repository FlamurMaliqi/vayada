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
});
