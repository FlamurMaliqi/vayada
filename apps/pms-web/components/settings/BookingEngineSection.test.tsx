import { createElement } from "react";
import { act, create } from "react-test-renderer";
import { describe, expect, it, vi } from "vitest";

import { BookingEngineSection } from "./BookingEngineSection";

vi.mock("./ArrivalTimesSection", () => ({ ArrivalTimesSection: () => null }));

vi.mock("@/lib/i18n", () => ({
  useTranslation: () => ({
    t: (key: string) =>
      ({
        "settings.bookingEngine.instant": "Accept bookings instantly",
        "settings.retry": "Retry",
      })[key] ?? key,
  }),
}));

function props() {
  return {
    instantBook: true,
    saving: false,
    loadError: "",
    onToggle: vi.fn(),
    onRetry: vi.fn(),
  };
}

describe("booking acceptance settings", () => {
  it("toggles instant booking directly", () => {
    const input = props();
    const view = create(createElement(BookingEngineSection, input));
    const toggle = view.root.findByProps({ "aria-label": "Accept bookings instantly" });

    expect(toggle.props["aria-checked"]).toBe(true);
    act(() => toggle.props.onClick());
    expect(input.onToggle).toHaveBeenCalledWith(false);
  });

  it("fails closed with retry when booking acceptance cannot be loaded", () => {
    const input = { ...props(), loadError: "Couldn’t load booking acceptance settings." };
    const view = create(createElement(BookingEngineSection, input));

    expect(view.root.findAllByProps({ "aria-label": "Accept bookings instantly" })).toHaveLength(0);
    expect(
      view.root
        .findAllByType("p")
        .some((paragraph) =>
          paragraph.children.join("").includes("Couldn’t load booking acceptance settings."),
        ),
    ).toBe(true);
    act(() => view.root.findByType("button").props.onClick());
    expect(input.onRetry).toHaveBeenCalledOnce();
  });
});
