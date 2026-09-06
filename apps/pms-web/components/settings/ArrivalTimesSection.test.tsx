import { createElement } from "react";
import { act, create } from "react-test-renderer";
import { beforeEach, describe, expect, it, vi } from "vitest";
const api = vi.hoisted(() => ({ load: vi.fn(), preview: vi.fn(), save: vi.fn() }));
vi.mock("@/services/settings/arrivalTimes", () => ({ arrivalTimesService: api }));
import { ArrivalTimesSection } from "./ArrivalTimesSection";
const choices = {
  defaultGuestLanguage: "de",
  childrenEnabled: false,
  adultAgeThreshold: null,
  phoneRequired: true,
  arrivalTimeEnabled: false,
  specialRequestsEnabled: true,
  checkInTime: "15:00",
  checkOutTime: "11:00",
};
const setup = {
  propertyId: "property-1",
  current: { revision: 4, bundle: { choices, propertyTimeZone: "Europe/Berlin" } },
};
const ready = (value = choices) => ({
  outcome: "ready",
  bundle: {
    choices: value,
    sourceFingerprint: "source",
    propertyTimeZone: "Europe/Berlin",
    rates: [],
  },
});
async function render() {
  let view!: ReturnType<typeof create>;
  await act(async () => {
    view = create(createElement(ArrivalTimesSection));
  });
  return view;
}
describe("arrival policy editor", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    api.load.mockResolvedValue(setup);
    api.preview.mockImplementation((_id, value) => Promise.resolve(ready(value)));
    api.save.mockResolvedValue({});
  });
  it("preserves unrelated choices and requires review before saving the loaded revision", async () => {
    const view = await render();
    act(() =>
      view.root.findAllByProps({ type: "time" })[1]!.props.onChange({ target: { value: "23:00" } }),
    );
    await act(async () => view.root.findByType("form").props.onSubmit({ preventDefault() {} }));
    expect(api.preview).toHaveBeenCalledWith("property-1", { ...choices, checkInUntil: "23:00" });
    expect(api.save).not.toHaveBeenCalled();
    act(() =>
      view.root.findByProps({ type: "checkbox" }).props.onChange({ target: { checked: true } }),
    );
    await act(async () => view.root.findByType("form").props.onSubmit({ preventDefault() {} }));
    expect(api.save).toHaveBeenCalledWith(
      setup,
      ready({ ...choices, checkInUntil: "23:00" } as typeof choices),
      expect.stringContaining("arrival-times:"),
    );
    expect(api.load).toHaveBeenCalledTimes(2);
  });
  it("invalidates confirmation on edits and preserves entered times on a failed save", async () => {
    const view = await render();
    await act(async () => view.root.findByType("form").props.onSubmit({ preventDefault() {} }));
    act(() =>
      view.root.findByProps({ type: "checkbox" }).props.onChange({ target: { checked: true } }),
    );
    api.save.mockRejectedValueOnce(new Error("The policy changed. Reload saved values."));
    await act(async () => view.root.findByType("form").props.onSubmit({ preventDefault() {} }));
    expect(view.root.findByProps({ role: "alert" }).children.join("")).toContain("policy changed");
    act(() =>
      view.root.findAllByProps({ type: "time" })[0]!.props.onChange({ target: { value: "16:00" } }),
    );
    expect(view.root.findAllByProps({ type: "checkbox" })).toHaveLength(0);
    expect(view.root.findAllByProps({ type: "time" })[0]!.props.value).toBe("16:00");
  });
  it("cannot save fabricated defaults when policy loading fails or setup is absent", async () => {
    api.load.mockRejectedValueOnce(new Error("offline"));
    const view = await render();
    expect(view.root.findAllByType("form")).toHaveLength(0);
    expect(api.save).not.toHaveBeenCalled();
    api.load.mockResolvedValueOnce({ current: null, propertyId: "property-1" });
    await act(async () => view.root.findByType("button").props.onClick());
    expect(view.root.findAllByProps({ type: "time" })).toHaveLength(0);
  });
});
