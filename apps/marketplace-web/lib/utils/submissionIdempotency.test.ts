import { describe, expect, it, vi } from "vitest";

import {
  isDefiniteValidationSubmissionFailure,
  resolvePerWriteSubmissionIdempotencyState,
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

  it("rotates only the failed child key when that collaboration is edited", () => {
    const createKey = vi.fn((name: string) => `${name}-key-${createKey.mock.calls.length}`);
    const initial = resolvePerWriteSubmissionIdempotencyState(
      null,
      [
        { keyName: "trip", fingerprint: "trip-form" },
        { keyName: "child:success", fingerprint: "successful-child-form" },
        { keyName: "child:failed", fingerprint: "failed-child-form" },
      ],
      createKey,
    );

    const retry = resolvePerWriteSubmissionIdempotencyState(
      initial,
      [
        { keyName: "trip", fingerprint: "trip-form" },
        { keyName: "child:success", fingerprint: "successful-child-form" },
        { keyName: "child:failed", fingerprint: "edited-failed-child-form" },
      ],
      createKey,
    );

    expect(retry.keys.trip).toBe(initial.keys.trip);
    expect(retry.keys["child:success"]).toBe(initial.keys["child:success"]);
    expect(retry.keys["child:failed"]).not.toBe(initial.keys["child:failed"]);
    expect(createKey).toHaveBeenCalledTimes(4);
  });

  it("rotates only the trip key when saved trip details are edited", () => {
    const createKey = vi.fn((name: string) => `${name}-key-${createKey.mock.calls.length}`);
    const initial = resolvePerWriteSubmissionIdempotencyState(
      null,
      [
        { keyName: "trip", fingerprint: "original-trip-form" },
        { keyName: "child:failed", fingerprint: "failed-child-form" },
      ],
      createKey,
    );

    const retry = resolvePerWriteSubmissionIdempotencyState(
      initial,
      [
        { keyName: "trip", fingerprint: "edited-trip-form" },
        { keyName: "child:failed", fingerprint: "failed-child-form" },
      ],
      createKey,
    );

    expect(retry.keys.trip).not.toBe(initial.keys.trip);
    expect(retry.keys["child:failed"]).toBe(initial.keys["child:failed"]);
    expect(createKey).toHaveBeenCalledTimes(3);
  });

  it("keeps ambiguous child failures locked to their original retry key", () => {
    const createKey = vi.fn((name: string) => `${name}-key-${createKey.mock.calls.length}`);
    const initial = resolvePerWriteSubmissionIdempotencyState(
      null,
      [{ keyName: "child:ambiguous", fingerprint: "submitted-child-payload" }],
      createKey,
    );
    const replay = resolvePerWriteSubmissionIdempotencyState(
      initial,
      [{ keyName: "child:ambiguous", fingerprint: "submitted-child-payload" }],
      createKey,
    );

    expect(replay.keys["child:ambiguous"]).toBe(initial.keys["child:ambiguous"]);
    expect(createKey).toHaveBeenCalledTimes(1);
  });

  it("allows edits only after an explicit API validation failure", () => {
    expect(
      isDefiniteValidationSubmissionFailure({
        status: 400,
        data: { category: "validation", code: "invalid_request" },
      }),
    ).toBe(true);
    expect(
      isDefiniteValidationSubmissionFailure({
        status: 409,
        data: { category: "conflict", code: "idempotency_conflict" },
      }),
    ).toBe(false);
    expect(
      isDefiniteValidationSubmissionFailure({
        status: 500,
        data: { category: "write_model", code: "write_model_unavailable" },
      }),
    ).toBe(false);
    expect(isDefiniteValidationSubmissionFailure(new TypeError("Network request failed"))).toBe(
      false,
    );
  });
});
