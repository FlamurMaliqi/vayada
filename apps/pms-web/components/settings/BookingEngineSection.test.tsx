import { createElement } from "react";
import { act, create } from "react-test-renderer";
import { describe, expect, it, vi } from "vitest";

import { BookingEngineSection } from "./BookingEngineSection";

function props() {
  return {
    instantBook: true,
    saving: false,
    loadError: "",
    onToggle: vi.fn(),
    onRetry: vi.fn(),
    sameDayEnabled: true,
    sameDayCutoffTime: "18:00",
    sameDayTimeZone: "Europe/Berlin",
    sameDayLoading: false,
    sameDaySaving: false,
    sameDayLoadError: "",
    onSameDayToggle: vi.fn(),
    onSameDayCutoffChange: vi.fn(),
    onSameDayRetry: vi.fn(),
  };
}

describe("same-day booking settings", () => {
  it("persists the property-level toggle and half-hour cutoff directly", () => {
    const input = props();
    const view = create(createElement(BookingEngineSection, input));
    const toggle = view.root.findByProps({ "aria-label": "Allow same-day bookings" });
    const cutoff = view.root.findByProps({ "aria-label": "Same-day booking cutoff" });

    expect(toggle.props["aria-checked"]).toBe(true);
    expect(cutoff.props.value).toBe("18:00");
    expect(cutoff.findAllByType("option")).toHaveLength(49);
    act(() => toggle.props.onClick());
    act(() => cutoff.props.onChange({ target: { value: "17:30" } }));

    expect(input.onSameDayToggle).toHaveBeenCalledWith(false);
    expect(input.onSameDayCutoffChange).toHaveBeenCalledWith("17:30");
  });

  it("fails closed with retry when the canonical setting cannot be loaded", () => {
    const input = { ...props(), sameDayLoadError: "Couldn’t load same-day booking settings." };
    const view = create(createElement(BookingEngineSection, input));

    expect(view.root.findAllByProps({ "aria-label": "Allow same-day bookings" })).toHaveLength(0);
    const alert = view.root.findByProps({ role: "alert" });
    expect(alert.findByType("span").children.join("")).toContain(
      "Couldn’t load same-day booking settings.",
    );
    act(() => alert.findByType("button").props.onClick());
    expect(input.onSameDayRetry).toHaveBeenCalledOnce();
  });
});
