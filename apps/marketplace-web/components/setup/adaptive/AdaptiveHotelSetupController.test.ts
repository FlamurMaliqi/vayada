import { createElement, type ReactNode } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { buildPropertySetupRoute } from "@vayada/domain-hotels";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ApiErrorResponse } from "@/services/api/client";

type CapturedShellProps = {
  title: string;
  routeError?: string | null;
  onRetry?: (() => void) | null;
  staleDraftMessage?: string | null;
  onRefresh?: (() => void) | null;
  onBack?: (() => void) | null;
  onExit: () => void;
  children?: ReactNode;
};

const mocks = vi.hoisted(() => ({
  getRoute: vi.fn(),
  push: vi.fn(),
  replace: vi.fn(),
  searchParams: new URLSearchParams(),
  shellProps: null as CapturedShellProps | null,
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: mocks.push, replace: mocks.replace }),
  useSearchParams: () => mocks.searchParams,
}));

vi.mock("next/image", () => ({ default: () => null }));

vi.mock("@/services/api/propertySetupRouteClient", () => ({
  createPropertySetupRouteClient: () => ({ getRoute: mocks.getRoute }),
}));

vi.mock("@/services/api/targetClient", () => ({ targetApiClient: {} }));

vi.mock("./AdaptiveHotelSetupShell", () => ({
  AdaptiveHotelSetupShell: (props: CapturedShellProps) => {
    mocks.shellProps = props;
    return props.children ?? null;
  },
}));

import {
  AdaptiveHotelSetupController,
  type AdaptiveSetupStepRenderContext,
} from "./AdaptiveHotelSetupController";

const organizationId = "11111111-1111-4111-8111-111111111111";
const propertyId = "22222222-2222-4222-8222-222222222222";

describe("AdaptiveHotelSetupController", () => {
  beforeEach(() => {
    mocks.getRoute.mockReset();
    mocks.push.mockReset();
    mocks.replace.mockReset();
    mocks.shellProps = null;
    mocks.searchParams = setupSearchParams("pricing");
    mocks.getRoute.mockResolvedValue(operationsRoute("pricing"));
    vi.stubGlobal(
      "requestAnimationFrame",
      vi.fn(() => 1),
    );
    vi.stubGlobal("cancelAnimationFrame", vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("restores a failed browser-history transition and retries its step and URL together", async () => {
    const beforeLeave = vi
      .fn<() => Promise<void>>()
      .mockRejectedValueOnce(new Error("Draft save failed."))
      .mockResolvedValue(undefined);
    const onExit = vi.fn();
    let renderer: ReactTestRenderer | undefined;

    await act(async () => {
      renderer = create(
        createElement(AdaptiveHotelSetupController, {
          propertyId,
          requestedStepId: "pricing",
          onExit,
          beforeLeave,
        }),
      );
    });

    expect(currentShell().title).toBe("Set your room prices");
    expect(beforeLeave).not.toHaveBeenCalled();

    mocks.searchParams = setupSearchParams("calendar");
    await act(async () => {
      renderer?.update(
        createElement(AdaptiveHotelSetupController, {
          propertyId,
          requestedStepId: "calendar",
          onExit,
          beforeLeave,
        }),
      );
    });

    expect(beforeLeave).toHaveBeenCalledTimes(1);
    expect(currentShell().title).toBe("Set your room prices");
    expect(currentShell().routeError).toBe("Draft save failed.");
    expect(mocks.replace).toHaveBeenLastCalledWith(expect.stringContaining("step=pricing"), {
      scroll: false,
    });

    mocks.searchParams = setupSearchParams("pricing");
    await act(async () => {
      renderer?.update(
        createElement(AdaptiveHotelSetupController, {
          propertyId,
          requestedStepId: "pricing",
          onExit,
          beforeLeave,
        }),
      );
      currentShell().onRetry?.();
    });

    expect(beforeLeave).toHaveBeenCalledTimes(2);
    expect(currentShell().routeError).toBeNull();
    expect(currentShell().title).toBe("Open your calendar");
    expect(mocks.replace).toHaveBeenLastCalledWith(expect.stringContaining("step=calendar"), {
      scroll: false,
    });

    renderer?.unmount();
  });

  it("shows stale-draft recovery for revision conflicts and refreshes without retrying the write", async () => {
    const beforeLeave = vi
      .fn<() => Promise<void>>()
      .mockRejectedValueOnce(
        new ApiErrorResponse(409, {
          code: "draft_revision_conflict",
          detail: "The setup draft changed.",
        }),
      )
      .mockResolvedValue(undefined);
    let renderer: ReactTestRenderer | undefined;

    await act(async () => {
      renderer = create(
        createElement(AdaptiveHotelSetupController, {
          propertyId,
          requestedStepId: "pricing",
          onExit: vi.fn(),
          beforeLeave,
        }),
      );
    });

    mocks.searchParams = setupSearchParams("calendar");
    await act(async () => {
      renderer?.update(
        createElement(AdaptiveHotelSetupController, {
          propertyId,
          requestedStepId: "calendar",
          onExit: vi.fn(),
          beforeLeave,
        }),
      );
    });

    expect(currentShell().routeError).toBeNull();
    expect(currentShell().staleDraftMessage).toMatch(/changed in another tab or session/i);
    expect(beforeLeave).toHaveBeenCalledTimes(1);

    await act(async () => {
      currentShell().onRefresh?.();
    });

    expect(mocks.getRoute).toHaveBeenCalledTimes(2);
    expect(beforeLeave).toHaveBeenCalledTimes(1);
    expect(currentShell().staleDraftMessage).toBeNull();

    renderer?.unmount();
  });

  it("retries a failed post-save route refresh without repeating the draft write", async () => {
    const beforeLeave = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);
    let stepContext: AdaptiveSetupStepRenderContext | null = null;
    const StepForm = (context: AdaptiveSetupStepRenderContext) => {
      stepContext = context;
      return null;
    };
    mocks.getRoute
      .mockResolvedValueOnce(operationsRoute("pricing"))
      .mockRejectedValueOnce(new Error("The updated route could not be loaded."))
      .mockResolvedValueOnce(operationsRoute("pricing"));
    let renderer: ReactTestRenderer | undefined;

    await act(async () => {
      renderer = create(
        createElement(AdaptiveHotelSetupController, {
          propertyId,
          requestedStepId: "pricing",
          onExit: vi.fn(),
          beforeLeave,
          StepForm,
        }),
      );
    });

    await act(async () => {
      await stepContext?.saveAndContinue();
    });

    expect(beforeLeave).toHaveBeenCalledTimes(1);
    expect(currentShell().routeError).toBe("The updated route could not be loaded.");

    await act(async () => {
      currentShell().onRetry?.();
    });

    expect(beforeLeave).toHaveBeenCalledTimes(1);
    expect(mocks.getRoute).toHaveBeenCalledTimes(3);
    expect(mocks.push).toHaveBeenLastCalledWith(expect.stringContaining("step=calendar"), {
      scroll: false,
    });

    renderer?.unmount();
  });

  it("restores and coalesces repeated browser Back events until the draft is preserved", async () => {
    const beforeLeave = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);
    const browserBack = vi.fn();
    const browserForward = vi.fn();
    const browserGo = vi.fn();
    let popStateHandler: ((event: PopStateEvent) => void) | null = null;
    const historyState: Record<string, unknown> = {};
    vi.stubGlobal("window", {
      location: { href: `http://localhost/setup?${setupSearchParams("pricing").toString()}` },
      history: {
        state: historyState,
        pushState: vi.fn((state: Record<string, unknown>) => Object.assign(historyState, state)),
        back: browserBack,
        forward: browserForward,
        go: browserGo,
      },
      addEventListener: vi.fn((name: string, handler: (event: PopStateEvent) => void) => {
        if (name === "popstate") popStateHandler = handler;
      }),
      removeEventListener: vi.fn(),
    });
    let renderer: ReactTestRenderer | undefined;

    await act(async () => {
      renderer = create(
        createElement(AdaptiveHotelSetupController, {
          propertyId,
          requestedStepId: "pricing",
          onExit: vi.fn(),
          beforeLeave,
        }),
      );
    });

    await act(async () => {
      popStateHandler?.({ state: {} } as PopStateEvent);
      popStateHandler?.({ state: {} } as PopStateEvent);
      popStateHandler?.({ state: historyState } as PopStateEvent);
    });

    expect(beforeLeave).toHaveBeenCalledTimes(1);
    expect(browserBack).not.toHaveBeenCalled();
    expect(browserForward).toHaveBeenCalledTimes(2);
    expect(browserGo).toHaveBeenCalledOnce();
    expect(browserGo).toHaveBeenCalledWith(-2);

    await act(async () => renderer?.unmount());
  });
});

function currentShell(): CapturedShellProps {
  if (!mocks.shellProps) throw new Error("Adaptive setup shell has not rendered.");
  return mocks.shellProps;
}

function setupSearchParams(stepId: string): URLSearchParams {
  return new URLSearchParams({
    propertyId,
    entryProduct: "marketplace",
    step: stepId,
  });
}

function operationsRoute(resumeStepId: "pricing") {
  return {
    ...buildPropertySetupRoute({
      organizationId,
      propertyId,
      selectedTracks: ["hotel_operations"],
      trackRevision: 1,
      session: null,
      ownerFacts: [],
    }),
    resumeStepId,
  };
}
