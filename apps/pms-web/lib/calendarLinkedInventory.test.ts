import { beforeEach, expect, it, vi } from "vitest";

const get = vi.hoisted(() => vi.fn());

vi.mock("../services/api/pmsClient", () => ({
  pmsClient: {
    get,
    post: vi.fn(),
    patch: vi.fn(),
    delete: vi.fn(),
  },
}));

import { calendarService } from "../services/calendar";

beforeEach(() => get.mockReset());

it("projects linked room types as protected calendar blocks", async () => {
  get.mockImplementation(async (route: string) => {
    if (route === "/admin/linked-inventory-groups") {
      return [
        {
          groupId: "group-1",
          name: "Convertible room",
          memberRoomTypeIds: ["source-type", "target-type"],
        },
      ];
    }
    return {
      roomTypes: [
        { id: "source-type", name: "Superior King", totalRooms: 1 },
        { id: "target-type", name: "Double Room", totalRooms: 2 },
      ],
      rooms: [],
      bookings: [],
      blocks: [
        {
          id: "block-1",
          roomTypeId: "source-type",
          roomId: "room-1",
          roomNumber: "101",
          startDate: "2026-09-03",
          endDate: "2026-09-08",
          blockedCount: 1,
          reason: "Maintenance",
          createdAt: "2026-09-01T00:00:00.000Z",
        },
      ],
    };
  });

  const result = await calendarService.getCalendarData("2026-09-03", "2026-09-08");

  expect(result.blocks).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        roomTypeId: "target-type",
        startDate: "2026-09-03",
        endDate: "2026-09-08",
        blockedCount: 2,
        kind: "linked_manual_block",
        sourceRoomTypeName: "Superior King",
        sourceSummary: "Block: Maintenance · Superior King",
        protected: true,
      }),
    ]),
  );
});

it("fails the calendar load when linked inventory cannot be read", async () => {
  get.mockImplementation(async (route: string) => {
    if (route === "/admin/linked-inventory-groups") throw new Error("linked inventory unavailable");
    return { roomTypes: [], rooms: [], bookings: [], blocks: [] };
  });

  await expect(calendarService.getCalendarData("2026-09-03", "2026-09-08")).rejects.toThrow(
    "linked inventory unavailable",
  );
});

it("normalizes server linked blocks as protected during a mixed-version rollout", async () => {
  get.mockImplementation(async (route: string) => {
    if (route === "/admin/linked-inventory-groups") {
      return [
        {
          groupId: "group-1",
          name: "Convertible room",
          memberRoomTypeIds: ["source-type", "target-type"],
        },
      ];
    }
    return {
      roomTypes: [
        { id: "source-type", name: "Superior King", totalRooms: 1 },
        { id: "target-type", name: "Double Room", totalRooms: 2 },
      ],
      rooms: [],
      bookings: [],
      blocks: [
        {
          id: "linked-block-1",
          roomTypeId: "target-type",
          roomId: null,
          roomNumber: null,
          startDate: "2026-09-03",
          endDate: "2026-09-08",
          blockedCount: 1,
          reason: "Linked inventory",
          createdAt: "2026-09-01T00:00:00.000Z",
          kind: "linked_manual_block",
          sourceRoomTypeId: "source-type",
        },
      ],
    };
  });

  const result = await calendarService.getCalendarData("2026-09-03", "2026-09-08");

  expect(result.blocks).toHaveLength(1);
  expect(result.blocks[0]).toMatchObject({ protected: true, blockedCount: 2 });
});

it("gives split-stay linked periods unique synthetic ids", async () => {
  get.mockImplementation(async (route: string) => {
    if (route === "/admin/linked-inventory-groups") {
      return [
        {
          groupId: "group-1",
          name: "Convertible room",
          memberRoomTypeIds: ["source-type", "target-type"],
        },
      ];
    }
    const booking = {
      id: "booking-1",
      roomTypeId: "source-type",
      roomName: "Superior King",
      bookingReference: "VAY-1",
      roomPosition: 0,
    };
    return {
      roomTypes: [
        { id: "source-type", name: "Superior King", totalRooms: 1 },
        { id: "target-type", name: "Double Room", totalRooms: 2 },
      ],
      rooms: [],
      bookings: [
        { ...booking, checkIn: "2026-09-03", checkOut: "2026-09-05" },
        { ...booking, checkIn: "2026-09-06", checkOut: "2026-09-08" },
      ],
      blocks: [],
    };
  });

  const result = await calendarService.getCalendarData("2026-09-03", "2026-09-08");
  const linkedIds = result.blocks.map((block) => block.id);

  expect(linkedIds).toHaveLength(2);
  expect(new Set(linkedIds).size).toBe(2);
});
