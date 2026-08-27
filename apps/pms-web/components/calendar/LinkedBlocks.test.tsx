import { createElement } from "react";
import { act, create } from "react-test-renderer";
import { describe, expect, it, vi } from "vitest";

import type { CalendarBlock, CalendarRoom } from "@/services/calendar";
import BlockDetailModal from "./BlockDetailModal";
import MonthView from "./MonthView";

const linkedBlock: CalendarBlock = {
  id: "linked-block",
  version: "room-block-v1",
  roomTypeId: "type-1",
  roomId: "room-1",
  roomNumber: "101",
  startDate: "2026-09-10",
  endDate: "2026-09-11",
  blockedCount: 1,
  reason: "Linked inventory",
  createdAt: "2026-09-01T00:00:00.000Z",
  kind: "linked_booking",
  sourceRoomTypeId: "type-2",
  sourceRoomTypeName: "Alpine Suite",
  sourceSummary: "Booking VAY-42 · Alpine Suite",
  protected: true,
};

it("keeps protected block details view-only", () => {
  const onSave = vi.fn();
  const onDelete = vi.fn();
  const view = create(
    createElement(BlockDetailModal, {
      block: linkedBlock,
      roomTypes: [],
      onSave,
      onDelete,
      onClose: vi.fn(),
    }),
  );

  expect(view.root.findAllByType("button").map((button) => button.children.join(""))).toEqual([
    "Close",
  ]);
  expect(JSON.stringify(view.toJSON())).toContain("cannot be edited here");
  expect(onSave).not.toHaveBeenCalled();
  expect(onDelete).not.toHaveBeenCalled();
});

describe("month availability mode", () => {
  it("keeps protected blocks viewable while manual blocks stay disabled", () => {
    const room: CalendarRoom = {
      id: "room-1",
      roomTypeId: "type-1",
      roomTypeName: "Garden room",
      roomNumber: "101",
      floor: "1",
      status: "available",
      baseRate: 100,
      currency: "EUR",
      maxOccupancy: 2,
      size: 20,
    };
    const manualBlock: CalendarBlock = {
      ...linkedBlock,
      id: "manual-block",
      kind: "manual",
      sourceRoomTypeId: null,
      sourceRoomTypeName: null,
      sourceSummary: null,
      protected: false,
    };
    const onSelectBlock = vi.fn();
    const view = create(
      createElement(MonthView, {
        monthStart: new Date(2026, 8, 1),
        rooms: [room],
        roomTypeMap: { "type-1": { name: "Garden room", category: "" } },
        bookingsByRoom: {},
        unassignedBookings: [],
        blocksByRoom: { "room-1": [linkedBlock, manualBlock] },
        legacyBlocksByRoomType: {},
        roomIndexInType: { "room-1": 0 },
        onSelectBooking: vi.fn(),
        onSelectBlock,
        blockEditingAvailable: false,
      }),
    );
    const linked = view.root
      .findAllByType("button")
      .find((button) => button.props.title?.startsWith("Linked:"))!;
    const manual = view.root.findByProps({ title: "Block editing is not available yet" });

    expect(linked.props.disabled).toBe(false);
    expect(manual.props.disabled).toBe(true);
    act(() => linked.props.onClick());
    expect(onSelectBlock).toHaveBeenCalledWith(linkedBlock);
  });
});
