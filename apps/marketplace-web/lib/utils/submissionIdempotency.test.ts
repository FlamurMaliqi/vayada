import { describe, expect, it, vi } from "vitest";

import {
  resolveSubmissionIdempotencyState,
  type SubmissionIdempotencyState,
} from "./submissionIdempotency";

describe("calendar submission idempotency", () => {
  it("reuses stable, distinct trip and child keys after a timed-out submit", async () => {
    let state: SubmissionIdempotencyState | null = null;
    const createKey = vi.fn((name: string) => `${name}-key-${createKey.mock.calls.length}`);
    const send = vi
      .fn<(keys: Record<string, string>) => Promise<void>>()
      .mockRejectedValueOnce(new TypeError("Network request timed out"))
      .mockResolvedValueOnce(undefined);

    const submit = async () => {
      state = resolveSubmissionIdempotencyState(
        state,
        "unchanged-trip-form",
        ["trip", "child-a", "child-b"],
        createKey,
      );
      await send(state.keys);
    };

    await expect(submit()).rejects.toThrow("timed out");
    const firstKeys = { ...send.mock.calls[0]?.[0] };
    await expect(submit()).resolves.toBeUndefined();

    expect(send.mock.calls[1]?.[0]).toEqual(firstKeys);
    expect(new Set(Object.values(firstKeys))).toHaveLength(3);
    expect(createKey).toHaveBeenCalledTimes(3);
  });

  it("reuses a collaboration key after timeout and replaces it for a changed form", async () => {
    let state: SubmissionIdempotencyState | null = null;
    const createKey = vi.fn(() => `collaboration-key-${createKey.mock.calls.length}`);

    state = resolveSubmissionIdempotencyState(
      state,
      "original-collaboration-form",
      ["collaboration"],
      createKey,
    );
    const firstKey = state.keys.collaboration;
    state = resolveSubmissionIdempotencyState(
      state,
      "original-collaboration-form",
      ["collaboration"],
      createKey,
    );

    expect(state.keys.collaboration).toBe(firstKey);
    expect(createKey).toHaveBeenCalledTimes(1);

    state = resolveSubmissionIdempotencyState(
      state,
      "edited-collaboration-form",
      ["collaboration"],
      createKey,
    );

    expect(state.keys.collaboration).not.toBe(firstKey);
    expect(createKey).toHaveBeenCalledTimes(2);
  });
});
