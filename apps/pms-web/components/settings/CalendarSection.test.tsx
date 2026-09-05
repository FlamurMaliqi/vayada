import { createElement } from "react";
import { act, create } from "react-test-renderer";
import { describe, expect, it, vi } from "vitest";

import { CalendarSection } from "./CalendarSection";

vi.mock("@/lib/i18n", () => ({
  useTranslation: () => ({
    t: (key: string) =>
      ({
        "settings.calendar.optimizeAssignments": "Optimize room assignments",
        "settings.calendar.allowSameDay": "Allow same-day bookings",
        "settings.calendar.sameDayCutoff": "Same-day booking cutoff",
        "common.saving": "Saving…",
        "settings.retry": "Retry",
      })[key] ?? key,
  }),
}));

function props() {
  return {
    enabled: true,
    loading: false,
    saving: false,
    loadError: "",
    onToggle: vi.fn(),
    onRetry: vi.fn(),
    sameDayEnabled: true,
    sameDayCutoffTime: "18:00",
    sameDayTimeZone: "America/New_York",
    sameDayLoading: false,
    sameDaySaving: false,
    sameDayLoadError: "",
    onSameDayToggle: vi.fn(),
    onSameDayCutoffChange: vi.fn(),
    onSameDayRetry: vi.fn(),
  };
}

describe("room-packing calendar settings", () => {
  it("toggles the persisted setting without a confirmation step", () => {
    const input = props();
    const view = create(createElement(CalendarSection, input));
    const toggle = view.root.findByProps({ "aria-label": "Optimize room assignments" });
    expect(toggle.props["aria-checked"]).toBe(true);
    act(() => toggle.props.onClick());
    expect(input.onToggle).toHaveBeenCalledWith(false);
  });

  it("fails closed with an explicit retry when loading fails", () => {
    const input = { ...props(), enabled: false, loadError: "Couldn’t load settings." };
    const view = create(createElement(CalendarSection, input));
    expect(view.root.findAllByProps({ "aria-label": "Optimize room assignments" })).toHaveLength(0);
    expect(view.root.findByProps({ role: "alert" }).children.join("")).toContain(
      "Couldn’t load settings.",
    );
    act(() => view.root.findAllByType("button")[0].props.onClick());
    expect(input.onRetry).toHaveBeenCalledOnce();
  });

  it("announces an in-progress save", () => {
    const view = create(createElement(CalendarSection, { ...props(), saving: true }));
    expect(view.root.findByProps({ role: "status" }).children.join("")).toBe("Saving…");
  });
});

describe("same-day booking calendar settings", () => {
  it("persists the property-level toggle and half-hour cutoff directly", () => {
    const input = props();
    const view = create(createElement(CalendarSection, input));
    const toggle = view.root.findByProps({ "aria-label": "Allow same-day bookings" });
    const cutoff = view.root.findByProps({ "aria-label": "Same-day booking cutoff" });

    expect(JSON.stringify(view.toJSON())).toContain("(America/New York)");

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
    const view = create(createElement(CalendarSection, input));

    expect(view.root.findAllByProps({ "aria-label": "Allow same-day bookings" })).toHaveLength(0);
    const alerts = view.root.findAllByProps({ role: "alert" });
    const alert = alerts[alerts.length - 1];
    expect(alert.findByType("span").children.join("")).toContain(
      "Couldn’t load same-day booking settings.",
    );
    act(() => alert.findByType("button").props.onClick());
    expect(input.onSameDayRetry).toHaveBeenCalledOnce();
  });
});
