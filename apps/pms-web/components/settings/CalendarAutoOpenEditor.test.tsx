import { createElement } from "react";
import { act, create } from "react-test-renderer";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApiErrorResponse } from "@/services/api/client";

const mocks = vi.hoisted(() => ({ load: vi.fn(), save: vi.fn() }));
vi.mock("@/services/api/pmsPropertyClient", () => ({
  getPmsCalendarAutoOpen: mocks.load,
  updatePmsCalendarAutoOpen: mocks.save,
}));

import { CalendarAutoOpenEditor } from "./CalendarAutoOpenEditor";

const response = (revision = 3, enabled = false) => ({
  contractVersion: "pms-calendar-auto-open.v1" as const,
  setting: {
    contractVersion: "pms-calendar-auto-open.v1" as const,
    propertyId: "property-1",
    revision,
    enabled,
    mode: "rolling" as const,
    rollingMonths: 18 as const,
    fixedEndMonth: null,
    updatedAt: "2026-09-03T08:00:00.000Z",
  },
  horizon: {
    propertyTimeZone: "Europe/Berlin",
    propertyLocalDate: "2026-09-03",
    targetOpenThrough: enabled ? "2028-03-31" : null,
  },
  warnings: [],
});

describe("calendar auto-open editor", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.load.mockResolvedValue(response());
    mocks.save.mockResolvedValue(response(4, true));
  });

  it("shows a retry when the canonical setting cannot be loaded", async () => {
    mocks.load.mockRejectedValueOnce(new Error("offline")).mockResolvedValueOnce(response());
    let view!: ReturnType<typeof create>;
    await act(async () => {
      view = create(createElement(CalendarAutoOpenEditor));
    });
    const alert = view.root.findByProps({ role: "alert" });
    expect(alert.findByType("span").children.join("")).toContain("couldn’t load");
    await act(async () => alert.findByType("button").props.onClick());
    expect(view.root.findByProps({ "aria-label": "Auto-open future calendar" })).toBeTruthy();
  });

  it("loads and saves one canonical rolling configuration", async () => {
    let view!: ReturnType<typeof create>;
    await act(async () => {
      view = create(createElement(CalendarAutoOpenEditor));
    });

    const toggle = view.root.findByProps({ "aria-label": "Auto-open future calendar" });
    act(() => toggle.props.onClick());
    const months = view.root.findByProps({ id: "calendar-auto-open-months" });
    act(() => months.props.onChange({ target: { value: "24" } }));
    await act(async () => view.root.findByProps({ children: "Save auto-open" }).props.onClick());

    expect(mocks.save).toHaveBeenCalledWith(
      expect.objectContaining({
        revision: 3,
        enabled: true,
        mode: "rolling",
        rollingMonths: 24,
        fixedEndMonth: null,
      }),
    );
    expect(view.root.findByProps({ role: "status" }).children.join("")).toContain("Saved.");
  });

  it("uses a native fixed-month input and displays typed missing-rate warnings", async () => {
    mocks.load.mockResolvedValue({
      ...response(3, true),
      warnings: [
        {
          code: "missing_rate",
          roomTypeId: "alpine-suite",
          from: "2027-01-01",
          through: "2027-01-31",
        },
      ],
    });
    let view!: ReturnType<typeof create>;
    await act(async () => {
      view = create(createElement(CalendarAutoOpenEditor));
    });

    const fixed = view.root.findByProps({ value: "fixed" });
    act(() => fixed.props.onChange());
    const month = view.root.findByProps({ id: "calendar-auto-open-fixed-month" });
    expect(month.props.type).toBe("month");
    expect(month.props.min).toBe("2026-09");
    expect(month.props.max).toBe("2028-09");
    expect(view.root.findByProps({ role: "alert" }).children.join("")).toContain("alpine-suite");
  });

  it("can disable a stored historical fixed month without replacing it", async () => {
    mocks.load.mockResolvedValue({
      ...response(3, true),
      setting: {
        ...response(3, true).setting,
        mode: "fixed",
        rollingMonths: null,
        fixedEndMonth: "2026-08",
      },
      horizon: { ...response(3, true).horizon, targetOpenThrough: "2026-08-31" },
    });
    let view!: ReturnType<typeof create>;
    await act(async () => {
      view = create(createElement(CalendarAutoOpenEditor));
    });

    act(() => view.root.findByProps({ "aria-label": "Auto-open future calendar" }).props.onClick());
    await act(async () => view.root.findByProps({ children: "Save auto-open" }).props.onClick());

    expect(mocks.save).toHaveBeenCalledWith(
      expect.objectContaining({ enabled: false, mode: "fixed", fixedEndMonth: "2026-08" }),
    );
  });

  it("reloads canonical state after a stale-revision conflict", async () => {
    mocks.save.mockRejectedValueOnce(
      new ApiErrorResponse(409, {
        code: "calendar_auto_open_revision_conflict",
      }),
    );
    mocks.load.mockResolvedValueOnce(response()).mockResolvedValueOnce(response(4, true));
    let view!: ReturnType<typeof create>;
    await act(async () => {
      view = create(createElement(CalendarAutoOpenEditor));
    });
    act(() => view.root.findByProps({ "aria-label": "Auto-open future calendar" }).props.onClick());
    await act(async () => view.root.findByProps({ children: "Save auto-open" }).props.onClick());

    expect(mocks.load).toHaveBeenCalledTimes(2);
    expect(
      view.root.findByProps({ "aria-label": "Auto-open future calendar" }).props["aria-checked"],
    ).toBe(true);
    expect(view.root.findByProps({ role: "alert" }).findByType("span").children.join("")).toContain(
      "changed in another session",
    );
  });
});
