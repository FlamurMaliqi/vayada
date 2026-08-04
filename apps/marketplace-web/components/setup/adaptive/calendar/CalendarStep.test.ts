import { createElement } from "react";
import { act, create, type ReactTestInstance, type ReactTestRenderer } from "react-test-renderer";
import type {
  PropertySetupRouteReadModel,
  PropertySetupStepDraft,
  SavePropertySetupDraftReceipt,
} from "@vayada/domain-hotels";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ApiErrorResponse } from "@/services/api/client";
import type { CalendarWorkspace } from "./calendarState";

const mocks = vi.hoisted(() => ({
  loadWorkspace: vi.fn(),
  saveDraft: vi.fn(),
}));

vi.mock("@/services/api/calendarApiClient", () => ({ calendarApi: mocks }));

import { CalendarStep } from "./CalendarStep";

const organizationId = "11111111-1111-4111-8111-111111111111";
const propertyId = "22222222-2222-4222-8222-222222222222";
const roomTypeId = "33333333-3333-4333-8333-333333333333";

describe("CalendarStep", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.loadWorkspace.mockResolvedValue(workspace());
    mocks.saveDraft.mockResolvedValue(draftReceipt());
  });

  afterEach(() => vi.unstubAllGlobals());

  it("fails closed without the exact VAY-1049 manifest", async () => {
    const route = calendarRoute(null);
    const controller = controllerContext(route);
    let renderer: ReactTestRenderer | undefined;

    await act(async () => {
      renderer = create(createElement(CalendarStep, controller.props));
    });

    expect(JSON.stringify(renderer?.toJSON())).toContain("Calendar setup data is unavailable");
    expect(mocks.loadWorkspace).not.toHaveBeenCalled();
    expect(mocks.saveDraft).not.toHaveBeenCalled();
    expect(renderer!.root.findAllByType("input")).toHaveLength(0);

    const refresh = button(renderer!.root, "Refresh setup");
    await act(async () => refresh.props.onClick());
    expect(controller.refreshRoute).toHaveBeenCalledOnce();
    renderer?.unmount();
  });

  it("renders an explicit first visit and saves bounded incomplete draft input only", async () => {
    const route = calendarRoute(emptyCalendarDraft());
    const controller = controllerContext(route);
    let renderer: ReactTestRenderer | undefined;

    await act(async () => {
      renderer = create(createElement(CalendarStep, controller.props));
    });

    expect(mocks.loadWorkspace).toHaveBeenCalledWith(propertyId, {
      signal: expect.any(AbortSignal),
      cache: "no-store",
    });
    const modes = renderer!.root.findAll(
      (node) => node.type === "input" && node.props.name === "calendar-mode",
    );
    expect(modes).toHaveLength(2);
    expect(modes.every((node) => node.props.checked === false)).toBe(true);
    expect(button(renderer!.root, "Save and continue").props.disabled).toBe(true);
    expect(JSON.stringify(renderer!.toJSON())).toContain(
      "Calendar impact confirmation is not available yet",
    );
    expect(JSON.stringify(renderer!.toJSON())).toContain("Available Garden Suite rooms");

    const minimumStay = input(renderer!.root, "calendar-minimum-stay");
    await act(async () => minimumStay.props.onChange({ target: { value: "" } }));
    await act(async () => {
      button(renderer!.root, "Save draft").props.onClick();
      await Promise.resolve();
    });

    expect(mocks.saveDraft).toHaveBeenCalledOnce();
    expect(mocks.saveDraft).toHaveBeenCalledWith(
      propertyId,
      expect.objectContaining({
        stepId: "calendar",
        expectedBaseRevisions: exactManifest,
        payload: expect.objectContaining({
          "rate.minimum_stay": null,
          "rate.initial_availability": expect.objectContaining({ confirmed: false }),
        }),
      }),
    );
    expect(controller.saveAndContinue).not.toHaveBeenCalled();
    expect(controller.beforeLeave).toBeTypeOf("function");
    await act(async () => renderer?.unmount());
    expect(controller.dispose).toHaveBeenCalledOnce();
  });

  it("retains edits made during a save and advances revisions on the next draft save", async () => {
    const firstSave = deferred<SavePropertySetupDraftReceipt>();
    mocks.saveDraft
      .mockReturnValueOnce(firstSave.promise)
      .mockResolvedValueOnce(draftReceipt({ sessionRevision: 9, draftRevision: 6 }));
    const route = calendarRoute(emptyCalendarDraft());
    const controller = controllerContext(route);
    let renderer: ReactTestRenderer | undefined;

    await act(async () => {
      renderer = create(createElement(CalendarStep, controller.props));
    });
    await act(async () => {
      input(renderer!.root, "calendar-minimum-stay").props.onChange({ target: { value: "2" } });
    });
    await act(async () => button(renderer!.root, "Save draft").props.onClick());

    await act(async () => {
      input(renderer!.root, "calendar-minimum-stay").props.onChange({ target: { value: "3" } });
    });
    let leave!: Promise<void>;
    await act(async () => {
      leave = controller.beforeLeave!();
      await Promise.resolve();
    });
    await act(async () => {
      firstSave.resolve(draftReceipt());
      await leave;
    });

    expect(mocks.saveDraft).toHaveBeenCalledTimes(2);
    expect(mocks.saveDraft.mock.calls[0]?.[1]).toMatchObject({
      expectedSessionRevision: 7,
      expectedDraftRevision: 4,
      payload: { "rate.minimum_stay": 2 },
    });
    expect(mocks.saveDraft.mock.calls[1]?.[1]).toMatchObject({
      expectedSessionRevision: 8,
      expectedDraftRevision: 5,
      payload: { "rate.minimum_stay": 3 },
    });
    expect(button(renderer!.root, "Save draft").props.disabled).toBe(true);
    renderer?.unmount();
  });

  it("reports stale draft conflicts, rejects before-leave, and retains local input", async () => {
    mocks.saveDraft.mockRejectedValueOnce(
      new ApiErrorResponse(409, {
        code: "draft_revision_conflict",
        detail: "The draft changed in another session.",
      }),
    );
    const route = calendarRoute(emptyCalendarDraft());
    const controller = controllerContext(route);
    let renderer: ReactTestRenderer | undefined;

    await act(async () => {
      renderer = create(createElement(CalendarStep, controller.props));
    });
    await act(async () => {
      input(renderer!.root, "calendar-minimum-stay").props.onChange({ target: { value: "2" } });
    });

    await expect(act(async () => controller.beforeLeave?.())).rejects.toBeInstanceOf(
      ApiErrorResponse,
    );
    expect(controller.reportRevisionConflict).toHaveBeenCalledWith(
      expect.stringContaining("changed in another tab or session"),
    );
    expect(input(renderer!.root, "calendar-minimum-stay").props.value).toBe("2");
    expect(JSON.stringify(renderer!.toJSON())).toContain("The draft changed in another session.");
    renderer?.unmount();
  });

  it("uses direct legends and stable keyboard targets for recurring periods", async () => {
    vi.stubGlobal(
      "requestAnimationFrame",
      vi.fn((callback: FrameRequestCallback) => {
        callback(0);
        return 1;
      }),
    );
    vi.stubGlobal("document", { getElementById: vi.fn(() => null) });
    const route = calendarRoute(emptyCalendarDraft());
    const controller = controllerContext(route);
    let renderer: ReactTestRenderer | undefined;

    await act(async () => {
      renderer = create(createElement(CalendarStep, controller.props));
    });
    await act(async () =>
      renderer!.root.findByProps({ id: "calendar-mode-recurring" }).props.onChange(),
    );

    const periodFieldset = renderer!.root
      .findAllByType("fieldset")
      .find((fieldset) =>
        fieldset.findAllByType("legend").some((item) => textOf(item).includes("Open period 1")),
      );
    expect(periodFieldset).toBeDefined();
    expect(periodFieldset!.children[0]).toMatchObject({ type: "legend" });
    expect(renderer!.root.findByProps({ id: "calendar-add-period" }).props.disabled).toBe(false);
    expect(renderer!.root.findByProps({ id: "calendar-confirmation" }).props.type).toBe("checkbox");
    renderer?.unmount();
  });
});

const exactManifest = {
  "pms.operating_calendar": "calendar:0",
  "pms.inventory": "inventory:1",
  "pms.room_types": "types:2",
  "hotel_catalog.location": "location:3",
};

function controllerContext(route: PropertySetupRouteReadModel) {
  const dispose = vi.fn<() => void>();
  const refreshRoute = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);
  const reportRevisionConflict = vi.fn<(message?: string) => void>();
  const saveAndContinue = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);
  const controller: {
    beforeLeave?: () => Promise<void>;
    dispose: typeof dispose;
    refreshRoute: typeof refreshRoute;
    reportRevisionConflict: typeof reportRevisionConflict;
    saveAndContinue: typeof saveAndContinue;
    props: Parameters<typeof CalendarStep>[0];
  } = {
    dispose,
    refreshRoute,
    reportRevisionConflict,
    saveAndContinue,
    props: null as never,
  };
  controller.props = {
    propertyId,
    route,
    step: route.steps[0]!,
    interfaceLocale: "en",
    saveAndContinue: controller.saveAndContinue,
    refreshRoute: controller.refreshRoute,
    reportRevisionConflict: controller.reportRevisionConflict,
    registerBeforeLeave(callback) {
      controller.beforeLeave = callback;
      return controller.dispose;
    },
  };
  return controller;
}

function calendarRoute(draft: PropertySetupStepDraft | null): PropertySetupRouteReadModel {
  return {
    contractVersion: "property-setup-route.v1",
    scope: { organizationId, propertyId },
    selectedTracks: ["hotel_operations"],
    trackRevision: 3,
    sessionId: "44444444-4444-4444-8444-444444444444",
    sessionRevision: 7,
    resumeStepId: "calendar",
    progress: { complete: 0, total: 1 },
    steps: [
      {
        stepId: "calendar",
        position: 6,
        state: draft ? "draft" : "not_started",
        sourceRevision: null,
        draft,
        blockers: [],
      },
    ],
  };
}

function emptyCalendarDraft(): Extract<PropertySetupStepDraft, { stepId: "calendar" }> {
  return {
    stepId: "calendar",
    payload: {},
    dirtyFields: [],
    baseRevisions: exactManifest,
    piiClassification: "potential_incidental_pii",
    retentionExpiresAt: "2026-11-02T12:00:00.000Z",
    revision: 4,
    updatedAt: "2026-08-04T12:00:00.000Z",
  };
}

function workspace(): CalendarWorkspace {
  return {
    propertyProfileRevision: 3,
    propertyTimeZone: "Europe/Berlin",
    rooms: [
      {
        roomTypeId,
        name: "Garden Suite",
        roomFactsRevision: 2,
        roomUnitsRevision: 3,
        physicalCapacityCount: 4,
      },
    ],
    current: null,
  };
}

function draftReceipt(
  overrides: Partial<SavePropertySetupDraftReceipt> = {},
): SavePropertySetupDraftReceipt {
  return {
    contractVersion: "property-setup-draft.v1",
    sessionId: "44444444-4444-4444-8444-444444444444",
    stepId: "calendar",
    selectedTracks: ["hotel_operations"],
    trackRevision: 3,
    sessionRevision: 8,
    draftRevision: 5,
    retentionExpiresAt: "2026-11-02T12:00:00.000Z",
    updatedAt: "2026-08-04T12:05:00.000Z",
    replayed: false,
    ...overrides,
  };
}

function button(root: ReactTestInstance, label: string): ReactTestInstance {
  return root.find(
    (node) => node.type === "button" && node.children.some((child) => child === label),
  );
}

function input(root: ReactTestInstance, id: string): ReactTestInstance {
  return root.find((node) => node.type === "input" && node.props.id === id);
}

function textOf(node: ReactTestInstance): string {
  return node.children.filter((child): child is string => typeof child === "string").join("");
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
