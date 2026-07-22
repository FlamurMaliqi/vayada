import { describe, expect, it, vi } from "vitest";

import {
  CHAT_IMAGE_MAX_BYTES,
  createChatSendLock,
  getChatImageValidationError,
  resolveChatMessageRetryAttempt,
} from "./chatSendGuard";

describe("chat send guard", () => {
  it("allows only one message send at a time", () => {
    const lock = createChatSendLock();
    const releaseFirst = lock.tryAcquire();

    expect(releaseFirst).not.toBeNull();
    expect(lock.tryAcquire()).toBeNull();

    releaseFirst?.();
    expect(lock.tryAcquire()).not.toBeNull();
  });

  it("reuses the idempotency key only for a retry of the same draft", () => {
    const createKey = vi.fn().mockReturnValueOnce("key-1").mockReturnValueOnce("key-2");
    const firstAttempt = resolveChatMessageRetryAttempt(
      null,
      "collaboration-1",
      "Hello",
      createKey,
    );

    expect(
      resolveChatMessageRetryAttempt(firstAttempt, "collaboration-1", "Hello", createKey),
    ).toBe(firstAttempt);
    expect(
      resolveChatMessageRetryAttempt(
        firstAttempt,
        "collaboration-1",
        "A different message",
        createKey,
      ).idempotencyKey,
    ).toBe("key-2");
    expect(createKey).toHaveBeenCalledTimes(2);
  });

  it("matches the backend chat-image type and size policy", () => {
    expect(
      getChatImageValidationError(new File(["image"], "photo.webp", { type: "image/webp" })),
    ).toBeNull();
    expect(
      getChatImageValidationError(new File(["image"], "photo.svg", { type: "image/svg+xml" })),
    ).toBe("Please select an image (JPG, PNG, WebP, GIF)");
    expect(
      getChatImageValidationError(
        new File([new Uint8Array(CHAT_IMAGE_MAX_BYTES + 1)], "large.jpg", {
          type: "image/jpeg",
        }),
      ),
    ).toBe("Image must be smaller than 20MB");
  });
});
