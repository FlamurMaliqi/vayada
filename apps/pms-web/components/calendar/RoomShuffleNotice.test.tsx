import { createElement } from "react";
import { act, create, type ReactTestInstance, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ list: vi.fn() }));
vi.mock("@/services/api/pmsPropertyClient", () => ({
  listPmsRoomShuffleHistory: mocks.list,
}));

import RoomShuffleNotice from "./RoomShuffleNotice";

const firstMove = {
  shuffleId: "shuffle-1",
  assignmentId: "assignment-1",
  guestBookingId: "booking-1",
  bookingReference: "PMS-101",
  roomTypeId: "type-1",
  fromRoom: { roomId: "room-1", label: "101" },
  toRoom: { roomId: "room-2", label: "102" },
  reason: "create" as const,
  actor: { kind: "system" as const },
  correlationId: "correlation-1",
  occurredAt: "2026-08-18T10:00:00.000Z",
};

function textContent(node: ReactTestInstance): string {
  return node.children
    .map((child) => (typeof child === "string" ? child : textContent(child)))
    .join("");
}

describe("room shuffle notice", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    mocks.list.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("shows the exact count for five seconds and stays silent for zero moves", () => {
    let visible!: ReactTestRenderer;
    act(() => {
      visible = create(createElement(RoomShuffleNotice, { bookingCount: 2, eventId: "command-1" }));
    });
    expect(textContent(visible.root.findByProps({ role: "status" }))).toContain(
      "2 bookings rearranged for optimal room usage",
    );
    act(() => {
      vi.advanceTimersByTime(4_999);
    });
    expect(visible.root.findAllByProps({ role: "status" })).toHaveLength(1);
    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(visible.root.findAllByProps({ role: "status" })).toHaveLength(0);

    act(() => {
      visible.update(createElement(RoomShuffleNotice, { bookingCount: 2, eventId: "command-2" }));
    });
    expect(visible.root.findAllByProps({ role: "status" })).toHaveLength(1);
    act(() => {
      visible.update(createElement(RoomShuffleNotice, { bookingCount: 3, eventId: "command-3" }));
    });
    act(() => {
      visible.update(createElement(RoomShuffleNotice, { bookingCount: 0, eventId: "command-4" }));
    });
    expect(visible.root.findAllByProps({ role: "status" })).toHaveLength(0);

    let silent!: ReactTestRenderer;
    act(() => {
      silent = create(
        createElement(RoomShuffleNotice, { bookingCount: 0, eventId: "command-zero" }),
      );
    });
    expect(silent.toJSON()).toBeNull();
  });

  it("retries a failed older page with its opaque cursor", async () => {
    mocks.list
      .mockResolvedValueOnce({ items: [firstMove], nextCursor: "opaque-next" })
      .mockRejectedValueOnce(new Error("temporary failure"))
      .mockResolvedValueOnce({
        items: [{ ...firstMove, shuffleId: "shuffle-2", bookingReference: null }],
        nextCursor: null,
      })
      .mockResolvedValueOnce({
        items: [{ ...firstMove, shuffleId: "shuffle-3", bookingReference: "PMS-202" }],
        nextCursor: null,
      });
    let view!: ReactTestRenderer;
    act(() => {
      view = create(
        createElement(RoomShuffleNotice, { bookingCount: 1, eventId: "command-history" }),
      );
    });

    await act(async () => {
      view.root.findByType("button").props.onClick();
    });
    expect(mocks.list).toHaveBeenCalledWith(50, undefined);
    expect(view.root.findByProps({ role: "dialog" }).props["aria-label"]).toBe("Room move history");
    expect(textContent(view.root.findAllByType("li")[0]!)).toContain("PMS-101");

    await act(async () => {
      view.root
        .findAllByType("button")
        .find((button) => button.children.join("") === "Load older moves")!
        .props.onClick();
    });
    expect(mocks.list).toHaveBeenLastCalledWith(50, "opaque-next");
    expect(view.root.findAllByProps({ role: "alert" })).toHaveLength(1);
    expect(
      view.root
        .findAllByType("button")
        .some((button) => button.children.join("") === "Load older moves"),
    ).toBe(false);

    await act(async () => {
      view.root
        .findAllByType("button")
        .find((button) => button.children.join("") === "Retry")!
        .props.onClick();
    });
    expect(mocks.list).toHaveBeenLastCalledWith(50, "opaque-next");
    expect(view.root.findAllByType("li")).toHaveLength(2);

    act(() => {
      view.root.findByProps({ "aria-label": "Close room move history" }).props.onClick();
      view.update(createElement(RoomShuffleNotice, { bookingCount: 1, eventId: "command-new" }));
    });
    await act(async () => {
      view.root.findByType("button").props.onClick();
    });
    expect(mocks.list).toHaveBeenNthCalledWith(4, 50, undefined);
    expect(textContent(view.root.findByType("li"))).toContain("PMS-202");
  });

  it("restores focus to a stable calendar target after the log closes", async () => {
    mocks.list.mockResolvedValue({ items: [], nextCursor: null });
    const documentMock = { activeElement: null as unknown };
    const returnTarget = {
      focus: vi.fn(() => {
        documentMock.activeElement = returnTarget;
      }),
    };
    const panel = {
      focus: vi.fn(() => {
        documentMock.activeElement = panel;
      }),
      querySelectorAll: () => [],
    };
    vi.stubGlobal("document", documentMock);
    let view!: ReactTestRenderer;
    await act(async () => {
      view = create(
        createElement(RoomShuffleNotice, { bookingCount: 1, eventId: "command-focus" }),
        {
          createNodeMock: (element) =>
            element.type === "span" && element.props.tabIndex === -1
              ? returnTarget
              : element.props.role === "dialog"
                ? panel
                : null,
        },
      );
    });

    await act(async () => {
      view.root.findByType("button").props.onClick();
    });
    expect(panel.focus).toHaveBeenCalledOnce();

    act(() => {
      view.root.findByProps({ "aria-label": "Close room move history" }).props.onClick();
    });
    expect(returnTarget.focus).toHaveBeenCalledTimes(2);
  });
});
