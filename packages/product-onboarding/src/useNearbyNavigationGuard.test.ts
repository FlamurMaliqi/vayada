import React from "react";
import TestRenderer, { act } from "react-test-renderer";
import { afterEach, expect, it, vi } from "vitest";
import { useNearbyHistoryGuard, useNearbyNavigationGuard } from "./useNearbyNavigationGuard";
afterEach(() => vi.unstubAllGlobals());
it("protects later navigation after an accepted refresh or same-route navigation", () => {
  const confirm = vi.fn().mockReturnValueOnce(true).mockReturnValue(false);
  vi.stubGlobal(
    "window",
    Object.assign(new EventTarget(), {
      confirm,
      location: { href: "https://admin.booking.localhost/settings/location" },
    }),
  );
  vi.stubGlobal("history", { state: {}, pushState: vi.fn(), replaceState: vi.fn(), go: vi.fn() });
  const refresh = vi.fn(),
    back = vi.fn(),
    push = vi.fn();
  const router = { refresh, back, push, replace: vi.fn(), forward: vi.fn() };
  function Guard() {
    useNearbyHistoryGuard(router);
    useNearbyNavigationGuard(true);
    return null;
  }
  let renderer: TestRenderer.ReactTestRenderer;
  act(() => {
    renderer = TestRenderer.create(React.createElement(Guard));
  });
  act(() => router.refresh());
  expect(refresh).toHaveBeenCalledOnce();
  act(() => router.back());
  expect(confirm).toHaveBeenCalledTimes(2);
  expect(back).not.toHaveBeenCalled();
  act(() => router.push("/settings/location"));
  expect(push).toHaveBeenCalledOnce();
  act(() => router.back());
  expect(confirm).toHaveBeenCalledTimes(3);
  expect(back).not.toHaveBeenCalled();
  act(() => renderer!.unmount());
});
