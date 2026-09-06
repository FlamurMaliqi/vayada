import React from "react";
import TestRenderer, { act } from "react-test-renderer";
import { expect, it, vi } from "vitest";
import type {
  NearbyCurationState,
  NearbyDiscoveryState,
  PropertyProfileResponse,
} from "@vayada/domain-hotels";
import type { NearbyApi } from "./nearbyApi";
import type { SharedHotelSetupApi } from "./sharedHotelSetupApi";
import { useNearbyEditor } from "./useNearbyEditor";

it("releases refresh state on reload and ignores the superseded refresh", async () => {
  const profile = {
    propertyId: "test",
    profileRevision: 1,
    profile: { location: {} },
  } as PropertyProfileResponse;
  const curation = {
    profileRevision: 1,
    curationRevision: 1,
    choices: [],
    customPlaces: [],
  } as unknown as NearbyCurationState;
  const current = { status: "empty", profileRevision: 1 } as NearbyDiscoveryState;
  let finish!: (value: NearbyDiscoveryState) => void;
  const pending = new Promise<NearbyDiscoveryState>((resolve) => {
    finish = resolve;
  });
  const api = {
    read: vi.fn().mockResolvedValue(curation),
    refresh: vi
      .fn()
      .mockResolvedValueOnce(current)
      .mockReturnValueOnce(pending)
      .mockResolvedValue(current),
  } as unknown as NearbyApi;
  const profileApi = {
    getPropertyProfile: vi.fn().mockResolvedValue(profile),
  } as unknown as SharedHotelSetupApi;
  let editor!: ReturnType<typeof useNearbyEditor>;
  function Probe() {
    editor = useNearbyEditor("test", api, profileApi);
    return null;
  }
  let renderer!: TestRenderer.ReactTestRenderer;
  try {
    await act(async () => {
      renderer = TestRenderer.create(React.createElement(Probe));
    });
    act(() => {
      void editor.refresh();
    });
    expect(editor.refreshing).toBe(true);
    await act(async () => {
      editor.reload();
    });
    expect(editor.refreshing).toBe(false);
    expect(editor.discovery).toBe(current);
    await act(async () => {
      finish({ ...current, status: "ready" });
    });
    expect(editor.refreshing).toBe(false);
    expect(editor.discovery).toBe(current);
  } finally {
    act(() => renderer.unmount());
  }
});
