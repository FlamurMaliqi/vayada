export interface ChatMessageRetryAttempt {
  collaborationId: string;
  content: string;
  idempotencyKey: string;
}

export const CHAT_IMAGE_ACCEPTED_TYPES = [
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/gif",
] as const;
export const CHAT_IMAGE_MAX_BYTES = 20 * 1024 * 1024;

export function getChatImageValidationError(file: File): string | null {
  if (!(CHAT_IMAGE_ACCEPTED_TYPES as readonly string[]).includes(file.type)) {
    return "Please select an image (JPG, PNG, WebP, GIF)";
  }
  if (file.size > CHAT_IMAGE_MAX_BYTES) return "Image must be smaller than 20MB";
  return null;
}

export function resolveChatMessageRetryAttempt(
  previousAttempt: ChatMessageRetryAttempt | null,
  collaborationId: string,
  content: string,
  createIdempotencyKey: () => string,
): ChatMessageRetryAttempt {
  if (previousAttempt?.collaborationId === collaborationId && previousAttempt.content === content) {
    return previousAttempt;
  }

  return {
    collaborationId,
    content,
    idempotencyKey: createIdempotencyKey(),
  };
}

export function createChatSendLock(): { tryAcquire: () => (() => void) | null } {
  let locked = false;

  return {
    tryAcquire: () => {
      if (locked) return null;
      locked = true;

      let released = false;
      return () => {
        if (released) return;
        released = true;
        locked = false;
      };
    },
  };
}
