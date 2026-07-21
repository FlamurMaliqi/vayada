import { describe, expect, it } from "vitest";

import {
  getValidatedChatAttachmentUrl,
  isOwnChatMessage,
  isSystemChatMessage,
} from "./chatMessages";

describe("chat message presentation", () => {
  it("uses sender side instead of display names to place messages", () => {
    expect(isOwnChatMessage("creator", "creator")).toBe(true);
    expect(isOwnChatMessage("hotel", "creator")).toBe(false);
    expect(isOwnChatMessage("creator", "hotel")).toBe(false);
    expect(
      isOwnChatMessage(null, "creator", {
        adapted: false,
        senderName: "platform_admin",
        partnerName: "Hotel Alpenrose",
      }),
    ).toBe(false);
    expect(
      isOwnChatMessage(null, "creator", {
        adapted: true,
        senderName: "Me",
        partnerName: "Hotel Alpenrose",
      }),
    ).toBe(true);
  });

  it("does not center participant messages merely because sender ID is unavailable", () => {
    expect(
      isSystemChatMessage({
        senderId: null,
        senderSide: "creator",
        senderName: "creator",
        contentType: "text",
      }),
    ).toBe(false);
    expect(
      isSystemChatMessage({
        senderId: null,
        senderSide: "hotel",
        senderName: "hotel",
        contentType: "text",
      }),
    ).toBe(false);
    expect(
      isSystemChatMessage({
        senderId: "admin-user",
        senderSide: "platform_admin",
        senderName: "platform_admin",
        contentType: "text",
      }),
    ).toBe(true);
    expect(
      isSystemChatMessage({
        senderId: null,
        senderSide: null,
        senderName: null,
        contentType: "system",
      }),
    ).toBe(true);
  });

  it("renders only target-validated HTTPS attachment URLs", () => {
    expect(
      getValidatedChatAttachmentUrl({
        attachmentValidated: true,
        mediaObjectId: "media-001",
        attachmentUrl: "https://signed.example/chat.jpg?signature=short-lived",
      }),
    ).toBe("https://signed.example/chat.jpg?signature=short-lived");
    expect(
      getValidatedChatAttachmentUrl({
        mediaObjectId: "media-001",
        attachmentUrl: "https://tracking.example/untrusted.jpg",
      }),
    ).toBeNull();
    expect(
      getValidatedChatAttachmentUrl({
        attachmentValidated: true,
        mediaObjectId: "media-001",
        attachmentUrl: "javascript:alert(1)",
      }),
    ).toBeNull();
  });
});
