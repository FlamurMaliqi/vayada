import { createElement } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import type { PropertySetupRouteReadModel } from "@vayada/domain-hotels";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type {
  AdaptiveHotelSetupControllerProps,
  AdaptiveSetupStepRenderContext,
} from "../AdaptiveHotelSetupController";

type CapturedControllerProps = AdaptiveHotelSetupControllerProps;

const mocks = vi.hoisted(() => ({
  controllerRender: vi.fn(),
  routeFetch: vi.fn(),
  controllerProps: null as CapturedControllerProps | null,
  activeRoomCallback: vi.fn<() => Promise<void>>(),
  saveSessionDraft: vi.fn<() => Promise<unknown>>(),
}));

vi.mock("../AdaptiveHotelSetupController", () => ({
  AdaptiveHotelSetupController: (props: CapturedControllerProps) => {
    mocks.controllerRender();
    mocks.routeFetch();
    mocks.controllerProps = props;
    return null;
  },
}));

vi.mock("./RoomAuthoringStep", () => ({
  RoomAuthoringStep: ({
    sessionStore,
  }: {
    sessionStore: { beforeLeave?: () => Promise<void> };
  }) => {
    sessionStore.beforeLeave = mocks.activeRoomCallback;
    return null;
  },
  saveRoomAuthoringSessionDraft: () => mocks.saveSessionDraft(),
}));

import { AdaptiveRoomAuthoringSetupController } from "./AdaptiveRoomAuthoringSetupController";

const organizationId = "11111111-1111-4111-8111-111111111111";
const propertyId = "22222222-2222-4222-8222-222222222222";

describe("AdaptiveRoomAuthoringSetupController", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.controllerProps = null;
    mocks.activeRoomCallback.mockResolvedValue(undefined);
    mocks.saveSessionDraft.mockResolvedValue(undefined);
  });

  it("composes exactly one existing controller and keeps non-room steps unrendered", async () => {
    let renderer: ReactTestRenderer | undefined;
    await act(async () => {
      renderer = create(
        createElement(AdaptiveRoomAuthoringSetupController, {
          propertyId,
          requestedStepId: "pricing",
          onExit: vi.fn(),
        }),
      );
    });

    expect(mocks.controllerRender).toHaveBeenCalledOnce();
    expect(mocks.routeFetch).toHaveBeenCalledOnce();

    const controller = capturedController();
    let stepRenderer: ReactTestRenderer | undefined;
    await act(async () => {
      stepRenderer = create(createElement(controller.StepForm!, stepContext("pricing")));
    });

    expect(stepRenderer?.toJSON()).toBeNull();
    await expect(controller.beforeLeave?.()).resolves.toBeUndefined();
    expect(mocks.activeRoomCallback).not.toHaveBeenCalled();
    expect(mocks.saveSessionDraft).not.toHaveBeenCalled();

    stepRenderer?.unmount();
    renderer?.unmount();
  });

  it("uses the current room callback for Back and Exit, then ignores it after leaving Rooms", async () => {
    let renderer: ReactTestRenderer | undefined;
    await act(async () => {
      renderer = create(
        createElement(AdaptiveRoomAuthoringSetupController, {
          propertyId,
          requestedStepId: "rooms",
          onExit: vi.fn(),
        }),
      );
    });
    const controller = capturedController();
    const StepForm = controller.StepForm!;
    let stepRenderer: ReactTestRenderer | undefined;

    await act(async () => {
      stepRenderer = create(createElement(StepForm, stepContext("rooms")));
    });
    const firstCallback = mocks.activeRoomCallback;
    await expect(controller.beforeLeave?.()).resolves.toBeUndefined();
    expect(firstCallback).toHaveBeenCalledOnce();

    const replacement = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);
    mocks.activeRoomCallback = replacement;
    await act(async () => {
      stepRenderer?.update(createElement(StepForm, stepContext("rooms")));
    });
    await expect(controller.beforeLeave?.()).resolves.toBeUndefined();
    expect(firstCallback).toHaveBeenCalledOnce();
    expect(replacement).toHaveBeenCalledOnce();

    await act(async () => {
      stepRenderer?.update(createElement(StepForm, stepContext("pricing")));
    });
    expect(stepRenderer?.toJSON()).toBeNull();
    await expect(controller.beforeLeave?.()).resolves.toBeUndefined();
    expect(replacement).toHaveBeenCalledOnce();
    expect(mocks.saveSessionDraft).not.toHaveBeenCalled();

    stepRenderer?.unmount();
    renderer?.unmount();
  });
});

function capturedController(): CapturedControllerProps {
  if (!mocks.controllerProps) throw new Error("Controller props were not captured.");
  return mocks.controllerProps;
}

function stepContext(stepId: "rooms" | "pricing"): AdaptiveSetupStepRenderContext {
  const route = setupRoute();
  return {
    route,
    step: route.steps.find((step) => step.stepId === stepId)!,
    interfaceLocale: "en",
    saveAndContinue: vi.fn().mockResolvedValue(undefined),
    refreshRoute: vi.fn().mockResolvedValue(undefined),
    reportRevisionConflict: vi.fn(),
  };
}

function setupRoute(): PropertySetupRouteReadModel {
  return {
    contractVersion: "property-setup-route.v1",
    scope: { organizationId, propertyId },
    selectedTracks: ["hotel_operations"],
    trackRevision: 3,
    sessionId: "33333333-3333-4333-8333-333333333333",
    sessionRevision: 7,
    resumeStepId: "rooms",
    progress: { complete: 0, total: 2 },
    steps: [
      {
        stepId: "rooms",
        position: 1,
        state: "not_started",
        sourceRevision: null,
        draft: null,
        blockers: [],
      },
      {
        stepId: "pricing",
        position: 2,
        state: "not_started",
        sourceRevision: null,
        draft: null,
        blockers: [],
      },
    ],
  };
}
