import { createElement } from "react";
import { act, create } from "react-test-renderer";
import { describe, expect, it, vi } from "vitest";

import { CalendarSection } from "./CalendarSection";

describe("room-packing calendar settings", () => {
  it("toggles the persisted setting without a confirmation step", () => {
    const onToggle = vi.fn();
    const view = create(
      createElement(CalendarSection, {
        enabled: true,
        loading: false,
        saving: false,
        loadError: "",
        onToggle,
        onRetry: vi.fn(),
      }),
    );
    const toggle = view.root.findByProps({ role: "switch" });
    expect(toggle.props["aria-checked"]).toBe(true);
    act(() => toggle.props.onClick());
    expect(onToggle).toHaveBeenCalledWith(false);
  });

  it("fails closed with an explicit retry when loading fails", () => {
    const onRetry = vi.fn();
    const view = create(
      createElement(CalendarSection, {
        enabled: false,
        loading: false,
        saving: false,
        loadError: "Couldn’t load settings.",
        onToggle: vi.fn(),
        onRetry,
      }),
    );
    expect(view.root.findAllByProps({ role: "switch" })).toHaveLength(0);
    expect(view.root.findByProps({ role: "alert" }).children.join("")).toContain(
      "Couldn’t load settings.",
    );
    act(() => view.root.findByType("button").props.onClick());
    expect(onRetry).toHaveBeenCalledOnce();
  });

  it("announces an in-progress save", () => {
    const view = create(
      createElement(CalendarSection, {
        enabled: true,
        loading: false,
        saving: true,
        loadError: "",
        onToggle: vi.fn(),
        onRetry: vi.fn(),
      }),
    );
    expect(view.root.findByProps({ role: "status" }).children.join("")).toBe("Saving…");
  });
});
