import { createElement } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { describe, expect, it } from "vitest";

import { AdaptiveHotelSetupShell } from "./AdaptiveHotelSetupShell";

describe("AdaptiveHotelSetupShell", () => {
  it.each([
    { routeError: "The draft service is unavailable.", staleDraftMessage: null },
    { routeError: null, staleDraftMessage: "The setup draft changed." },
  ])("keeps the active form mounted while showing recovery", async (recovery) => {
    let renderer: ReactTestRenderer | undefined;
    await act(async () => {
      renderer = create(
        AdaptiveHotelSetupShell({
          brandMark: createElement("span", null, "Vayada"),
          currentStep: 1,
          totalSteps: 3,
          title: "Present your hotel",
          subtitle: "Give guests a clear first impression.",
          onExit: () => undefined,
          routeError: recovery.routeError,
          staleDraftMessage: recovery.staleDraftMessage,
          onRetry: () => undefined,
          onRefresh: () => undefined,
          children: createElement("textarea", {
            "aria-label": "Short hotel summary",
            defaultValue: "local",
          }),
        }),
      );
    });

    expect(renderer?.root.findByType("textarea").props.defaultValue).toBe("local");
    expect(renderer?.root.findByProps({ role: "alert" })).toBeDefined();
    renderer?.unmount();
  });
});
