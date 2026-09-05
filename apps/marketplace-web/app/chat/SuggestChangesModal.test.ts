import { createElement } from "react";
import { act, create } from "react-test-renderer";
import { expect, it, vi } from "vitest";
import SuggestChangesModal from "./SuggestChangesModal";

it("requires correcting expired dates before sending an edit", () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-09-01T00:30:00Z"));
  const onSubmit = vi.fn();
  const view = create(
    createElement(SuggestChangesModal, {
      isOpen: true,
      onClose: vi.fn(),
      onSubmit,
      propertyTimezone: "Europe/Vienna",
      initialCheckIn: "2026-02-01",
      initialCheckOut: "2026-02-03",
      initialPlatformDeliverables: [],
    }),
  );
  try {
    const dates = view.root.findAllByProps({ type: "date" });
    const submit = () =>
      view.root
        .findAllByType("button")
        .find((button) => button.children.includes("Send Counter-Offer"))!;
    expect(dates.map((date) => date.props.min)).toEqual(["2026-09-01", "2026-09-01"]);
    expect(view.root.findByProps({ role: "alert" }).children).toContain(
      "Collaboration dates cannot be in the past.",
    );
    expect(submit().props.disabled).toBe(true);
    act(() => submit().props.onClick());
    expect(onSubmit).not.toHaveBeenCalled();
    act(() => dates[0]!.props.onChange({ target: { value: "2026-09-01" } }));
    expect(submit().props.disabled).toBe(true);
    act(() => dates[1]!.props.onChange({ target: { value: "2026-09-03" } }));
    expect(submit().props.disabled).toBe(false);
    act(() => submit().props.onClick());
    expect(onSubmit).toHaveBeenCalledWith(
      expect.objectContaining({ travel_date_from: "2026-09-01", travel_date_to: "2026-09-03" }),
    );
  } finally {
    view.unmount();
    vi.useRealTimers();
  }
});
