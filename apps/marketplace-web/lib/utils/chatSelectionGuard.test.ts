import { describe, expect, it } from "vitest";

import type {
  ConversationResponse,
  DetailedCollaboration,
  MessageResponse,
} from "@/services/api/collaborations";
import {
  createConversationSummary,
  isCurrentChatSelection,
  restoreConversationAfterFailedSend,
} from "./chatSelectionGuard";

describe("chat selection guard", () => {
  it("accepts only the current chat generation", () => {
    expect(isCurrentChatSelection("chat-b", 2, "chat-b", 2)).toBe(true);
    expect(isCurrentChatSelection("chat-a", 1, "chat-b", 2)).toBe(false);
    expect(isCurrentChatSelection("chat-b", 1, "chat-b", 2)).toBe(false);
  });

  it("creates a deep-linked conversation summary from fetched details", () => {
    const collaboration = {
      id: "chat-deep-link",
      status: "accepted",
      listingName: "Lake House",
      hotel: { name: "Hotel Aurora", picture: "https://example.com/hotel.jpg" },
      creator: { name: "Maya Creator", profilePicture: "https://example.com/creator.jpg" },
    } as DetailedCollaboration;
    const latestMessage = {
      content: "See you in September",
      created_at: "2026-07-22T09:00:00.000Z",
    } as MessageResponse;

    expect(
      createConversationSummary("chat-deep-link", collaboration, "creator", latestMessage),
    ).toEqual({
      collaboration_id: "chat-deep-link",
      partner_name: "Hotel Aurora",
      partner_avatar: "https://example.com/hotel.jpg",
      last_message_content: "See you in September",
      last_message_at: "2026-07-22T09:00:00.000Z",
      unread_count: 0,
      collaboration_status: "accepted",
      my_role: "creator",
      listing_name: "Lake House",
    });
    expect(createConversationSummary("chat-deep-link", collaboration, "hotel")).toMatchObject({
      partner_name: "Maya Creator",
      partner_avatar: "https://example.com/creator.jpg",
      last_message_content: null,
      last_message_at: null,
      my_role: "hotel",
    });
    expect(createConversationSummary("other-chat", collaboration, "creator")).toBeNull();
    expect(createConversationSummary("chat-deep-link", collaboration, null)).toBeNull();
  });

  it("restores the failed chat summary without changing the currently selected chat", () => {
    const chatA = conversation({
      collaboration_id: "chat-a",
      last_message_content: "Previous message",
      last_message_at: "2026-07-22T08:00:00.000Z",
    });
    const chatB = conversation({ collaboration_id: "chat-b" });
    const optimisticAt = "2026-07-22T09:00:00.000Z";
    const optimistic = [
      { ...chatA, last_message_content: "Unsaved message", last_message_at: optimisticAt },
      chatB,
    ];

    const restored = restoreConversationAfterFailedSend(
      optimistic,
      "chat-a",
      optimisticAt,
      chatA,
      1,
    );

    expect(restored).toEqual([chatB, chatA]);
    expect(restored[0]).toBe(chatB);
  });

  it("does not roll back a newer conversation summary", () => {
    const newer = [
      conversation({
        collaboration_id: "chat-a",
        last_message_content: "Newer message",
        last_message_at: "2026-07-22T10:00:00.000Z",
      }),
    ];

    expect(
      restoreConversationAfterFailedSend(
        newer,
        "chat-a",
        "2026-07-22T09:00:00.000Z",
        conversation({ collaboration_id: "chat-a" }),
        0,
      ),
    ).toBe(newer);
  });
});

function conversation(overrides: Partial<ConversationResponse>): ConversationResponse {
  return {
    collaboration_id: "chat",
    partner_name: "Partner",
    partner_avatar: null,
    last_message_content: null,
    last_message_at: null,
    unread_count: 0,
    collaboration_status: "accepted",
    my_role: "creator",
    listing_name: null,
    ...overrides,
  };
}
