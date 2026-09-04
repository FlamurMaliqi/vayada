import { createElement } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  individualRoomsService,
  linkedInventoryGroupsService,
  roomsService,
  type LinkedInventoryGroup,
  type RoomType,
} from "@/services/rooms";
import LinkedInventoryGroupsPanel from "./LinkedInventoryGroupsPanel";
import RoomsPage from "./page";

vi.mock("@/lib/i18n", () => ({
  useTranslation: () => ({
    t: (key: string, params?: Record<string, string>) => {
      const messages: Record<string, string> = {
        "rooms.linkedAddGroup": "Add group",
        "rooms.linkedEditNamed": "Edit {name}",
        "rooms.linkedDeleteNamed": "Delete {name}",
        "rooms.linkedSaveGroup": "Save group",
      };
      let value = messages[key] ?? key;
      for (const [name, replacement] of Object.entries(params ?? {})) {
        value = value.replace(`{${name}}`, replacement);
      }
      return value;
    },
  }),
}));
vi.mock("next/link", () => ({ default: "a" }));

const roomTypes = [
  { id: "type-1", name: "One bedroom" },
  { id: "type-2", name: "Two bedrooms" },
  { id: "type-3", name: "Garden suite" },
  { id: "type-4", name: "Garden villa" },
] as RoomType[];
const group: LinkedInventoryGroup = {
  groupId: "group-1",
  name: "Garden rooms",
  revision: 4,
  memberRoomTypeIds: ["type-3", "type-4"],
};

function render(groups: LinkedInventoryGroup[] = [group], onChange = vi.fn()) {
  return {
    onChange,
    view: create(createElement(LinkedInventoryGroupsPanel, { groups, roomTypes, onChange })),
  };
}
function button(view: ReactTestRenderer, label: string) {
  return view.root
    .findAllByType("button")
    .find((item) => item.children.some((child) => String(child).includes(label)))!;
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("LinkedInventoryGroupsPanel", () => {
  it("creates a group while excluding room types assigned elsewhere", async () => {
    const createGroup = vi.spyOn(linkedInventoryGroupsService, "create").mockResolvedValue({
      groupId: "group-2",
      name: "Villa options",
      revision: 1,
      memberRoomTypeIds: ["type-1", "type-2"],
    });
    const { view, onChange } = render();
    act(() => button(view, "Add group").props.onClick());
    const inputs = view.root.findAllByType("input");
    const checkboxes = inputs.filter((input) => input.props.type === "checkbox");
    const disabled = checkboxes.map((checkbox) => checkbox.props.disabled);
    expect(disabled).toEqual([false, false, true, true]);
    act(() =>
      inputs
        .find((input) => input.props.type !== "checkbox")!
        .props.onChange({
          target: { value: "Villa options" },
        }),
    );
    act(() => checkboxes[0]!.props.onChange());
    act(() => view.root.findAllByProps({ type: "checkbox" })[1]!.props.onChange());
    await act(async () => button(view, "Save group").props.onClick());
    expect(createGroup).toHaveBeenCalledWith("Villa options", ["type-1", "type-2"]);
    expect(onChange.mock.calls[0]![0]([group])).toEqual([
      group,
      expect.objectContaining({ groupId: "group-2", revision: 1 }),
    ]);
  });

  it("updates state functionally and serializes deletes", async () => {
    const other = { ...group, groupId: "group-2", name: "Other rooms" };
    const update = vi.spyOn(linkedInventoryGroupsService, "update").mockResolvedValue({
      ...group,
      revision: 5,
    });
    let finishDelete!: () => void;
    const remove = vi
      .spyOn(linkedInventoryGroupsService, "delete")
      .mockImplementation(() => new Promise((resolve) => (finishDelete = resolve)));
    const confirm = vi.fn(() => true);
    vi.stubGlobal("window", { confirm });
    const { view, onChange } = render([group, other]);
    act(() => view.root.findByProps({ "aria-label": "Edit Garden rooms" }).props.onClick());
    await act(async () => button(view, "Save group").props.onClick());
    let deleting!: Promise<void>;
    act(() => {
      deleting = view.root.findByProps({ "aria-label": "Delete Garden rooms" }).props.onClick();
    });
    act(() => view.root.findByProps({ "aria-label": "Delete Other rooms" }).props.onClick());
    await act(async () => {
      finishDelete();
      await deleting;
    });
    expect(update).toHaveBeenCalledWith(group);
    expect(remove).toHaveBeenCalledWith(group);
    expect(onChange.mock.calls[0]![0]([group, other])).toEqual([{ ...group, revision: 5 }, other]);
    expect(onChange.mock.calls[1]![0]([group, other])).toEqual([other]);
  });

  it("keeps the draft open and surfaces mutation errors", async () => {
    vi.spyOn(linkedInventoryGroupsService, "update").mockRejectedValue(
      new Error("This linked group changed. Reload and try again."),
    );
    const { view, onChange } = render();
    act(() => view.root.findByProps({ "aria-label": "Edit Garden rooms" }).props.onClick());
    await act(async () => button(view, "Save group").props.onClick());
    expect(JSON.stringify(view.toJSON())).toContain(
      "This linked group changed. Reload and try again.",
    );
    expect(onChange).not.toHaveBeenCalled();
  });

  it("keeps core room data when linked groups fail to load", async () => {
    vi.spyOn(roomsService, "list").mockResolvedValue([roomTypes[0]!]);
    vi.spyOn(individualRoomsService, "list").mockResolvedValue([]);
    vi.spyOn(linkedInventoryGroupsService, "list").mockRejectedValue(new Error("unavailable"));
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    let view!: ReactTestRenderer;
    await act(async () => {
      view = create(createElement(RoomsPage));
    });
    expect(JSON.stringify(view.toJSON())).toContain("One bedroom");
    expect(view.root.findAllByType(LinkedInventoryGroupsPanel)).toHaveLength(0);
  });
});
