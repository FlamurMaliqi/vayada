import { createElement } from "react";
import { act, create, type ReactTestInstance, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  CreatorMatchingPreferencesTab,
  creatorMatchingPreferencesDraft,
  creatorMatchingPreferencesWrite,
} from "./CreatorMatchingPreferencesTab";

const savedPreferences = {
  contentCategories: { mode: "selected" as const, values: ["travel", "slow_travel"] },
  deliverableTypes: { mode: "no_preference" as const },
  compensationTypes: null,
  collaborationGoals: { mode: "selected" as const, values: ["ugc_creation" as const] },
  travel: { mode: "planned_trips" as const, flexibilityDaysBefore: 2, flexibilityDaysAfter: 4 },
  contractVersion: "marketplace-creator-matching-preferences.v1" as const,
  evidenceSource: "creator_declared" as const,
  revision: 1,
  updatedAt: "2026-09-03T08:00:00.000Z",
};

describe("CreatorMatchingPreferencesTab", () => {
  let renderer: ReactTestRenderer | undefined;

  afterEach(async () => {
    await act(async () => renderer?.unmount());
    renderer = undefined;
  });

  it("keeps empty profiles unanswered and preserves unknown stored category codes", () => {
    const empty = creatorMatchingPreferencesDraft(null);
    expect(empty.contentCategories).toEqual({ mode: "unknown", values: [] });
    expect(creatorMatchingPreferencesWrite(empty)).toEqual({ preferences: null, errors: {} });

    const existing = creatorMatchingPreferencesDraft(savedPreferences);
    expect(existing.contentCategories.values).toEqual(["travel", "slow_travel"]);
    expect(creatorMatchingPreferencesWrite(existing).preferences).toMatchObject({
      contentCategories: { mode: "selected", values: ["travel", "slow_travel"] },
      deliverableTypes: { mode: "no_preference" },
    });
  });

  it("validates selected groups and travel flexibility before saving", () => {
    const draft = creatorMatchingPreferencesDraft(null);
    draft.contentCategories = { mode: "selected", values: [] };
    draft.travelMode = "selected";
    draft.flexibilityDaysBefore = "-1";
    draft.flexibilityDaysAfter = "366";

    expect(creatorMatchingPreferencesWrite(draft).errors).toEqual({
      contentCategories: "Choose at least one content category.",
      travelMode: "Enter whole numbers from 0 to 365 days.",
    });
  });

  it("keeps changes after a failed save and retries successfully", async () => {
    const onSave = vi
      .fn()
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValueOnce({
        ...savedPreferences,
        contentCategories: { mode: "selected", values: ["travel"] },
      });

    await act(async () => {
      renderer = create(
        createElement(CreatorMatchingPreferencesTab, {
          initialPreferences: null,
          onSave,
          onManageTrips: vi.fn(),
        }),
      );
    });

    await act(async () =>
      radio(renderer!.root, "content-categories-mode", "selected").props.onChange(),
    );
    await act(async () => checkbox(renderer!.root, "travel").props.onChange());
    await act(async () => button(renderer!.root, "Save preferences").props.onClick());

    expect(onSave).toHaveBeenCalledOnce();
    expect(text(renderer!.root)).toContain("Your changes are still here");
    expect(checkbox(renderer!.root, "travel").props.checked).toBe(true);

    await act(async () => button(renderer!.root, "Try again").props.onClick());

    expect(onSave).toHaveBeenCalledTimes(2);
    expect(onSave).toHaveBeenLastCalledWith({
      contentCategories: { mode: "selected", values: ["travel"] },
      deliverableTypes: null,
      compensationTypes: null,
      collaborationGoals: null,
      travel: null,
    });
    expect(text(renderer!.root)).toContain("Preferences saved.");
  });

  it("locks preference controls while a save is in flight", async () => {
    let resolveSave: ((value: typeof savedPreferences) => void) | undefined;
    const onSave = vi.fn(
      () =>
        new Promise<typeof savedPreferences>((resolve) => {
          resolveSave = resolve;
        }),
    );

    await act(async () => {
      renderer = create(
        createElement(CreatorMatchingPreferencesTab, {
          initialPreferences: null,
          onSave,
          onManageTrips: vi.fn(),
        }),
      );
    });

    await act(async () =>
      radio(renderer!.root, "content-categories-mode", "selected").props.onChange(),
    );
    await act(async () => checkbox(renderer!.root, "travel").props.onChange());
    await act(async () => button(renderer!.root, "Save preferences").props.onClick());

    expect(renderer!.root.findByProps({ "aria-busy": true })).toBeDefined();
    expect(renderer!.root.findAllByType("input").every((input) => input.props.disabled)).toBe(true);
    expect(text(renderer!.root)).toContain("Saving…");

    await act(async () => resolveSave?.(savedPreferences));

    expect(renderer!.root.findByProps({ "aria-busy": false })).toBeDefined();
    expect(renderer!.root.findAllByType("input").every((input) => !input.props.disabled)).toBe(
      true,
    );
    expect(text(renderer!.root)).toContain("Preferences saved.");
  });

  it("renders existing custom preferences as removable saved options", async () => {
    await act(async () => {
      renderer = create(
        createElement(CreatorMatchingPreferencesTab, {
          initialPreferences: savedPreferences,
          onSave: vi.fn(),
          onManageTrips: vi.fn(),
        }),
      );
    });

    expect(text(renderer!.root)).toContain("Slow Travel (saved)");
    expect(checkbox(renderer!.root, "slow_travel").props.checked).toBe(true);
  });
});

function radio(root: ReactTestInstance, name: string, value: string): ReactTestInstance {
  return root.find(
    (node) => node.type === "input" && node.props.name === name && node.props.value === value,
  );
}

function checkbox(root: ReactTestInstance, value: string): ReactTestInstance {
  return root.find(
    (node) => node.type === "input" && node.props.type === "checkbox" && node.props.value === value,
  );
}

function button(root: ReactTestInstance, label: string): ReactTestInstance {
  return root.find((node) => node.type === "button" && text(node).includes(label));
}

function text(node: ReactTestInstance): string {
  return node.children.map((child) => (typeof child === "string" ? child : text(child))).join(" ");
}
