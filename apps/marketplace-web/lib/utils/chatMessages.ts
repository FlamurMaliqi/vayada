export function isOwnChatMessage(
  senderSide: "creator" | "hotel" | null,
  myRole: "creator" | "hotel",
  legacy?: {
    adapted: boolean;
    senderName: string | null;
    partnerName: string;
  },
): boolean {
  if (senderSide) return senderSide === myRole;
  return legacy?.adapted === true && legacy.senderName !== legacy.partnerName;
}

export function isSystemChatMessage(message: {
  senderId: string | null;
  senderSide: string | null;
  senderName: string | null;
  contentType: string;
}): boolean {
  return (
    message.contentType === "system" ||
    message.senderSide === "system" ||
    message.senderSide === "platform_admin" ||
    message.senderName === "system" ||
    message.senderName === "platform_admin"
  );
}

export function getValidatedChatAttachmentUrl(
  metadata: Record<string, unknown> | null,
): string | null {
  if (
    metadata?.attachmentValidated !== true ||
    typeof metadata.mediaObjectId !== "string" ||
    typeof metadata.attachmentUrl !== "string"
  ) {
    return null;
  }
  try {
    const url = new URL(metadata.attachmentUrl);
    return url.protocol === "https:" ? url.toString() : null;
  } catch {
    return null;
  }
}
