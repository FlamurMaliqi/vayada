import type {
  ConversationResponse,
  DetailedCollaboration,
  MessageResponse,
} from "@/services/api/collaborations";

export function isCurrentChatSelection(
  requestedChatId: string,
  requestedGeneration: number,
  currentChatId: string | null,
  currentGeneration: number,
): boolean {
  return requestedChatId === currentChatId && requestedGeneration === currentGeneration;
}

export function createConversationSummary(
  selectedChatId: string | null,
  collaboration: DetailedCollaboration | null,
  myRole: string | null,
  latestMessage?: MessageResponse,
): ConversationResponse | null {
  if (
    !selectedChatId ||
    collaboration?.id !== selectedChatId ||
    (myRole !== "creator" && myRole !== "hotel")
  ) {
    return null;
  }

  const partner = myRole === "creator" ? collaboration.hotel : collaboration.creator;

  return {
    collaboration_id: selectedChatId,
    partner_name: partner?.name || (myRole === "creator" ? "Hotel" : "Creator"),
    partner_avatar:
      myRole === "creator"
        ? collaboration.hotel?.picture || null
        : collaboration.creator?.profilePicture || null,
    last_message_content: latestMessage?.content || null,
    last_message_at: latestMessage?.created_at || null,
    unread_count: 0,
    collaboration_status: collaboration.status,
    my_role: myRole,
    listing_name: collaboration.listingName || null,
  };
}

export function restoreConversationAfterFailedSend(
  conversations: ConversationResponse[],
  collaborationId: string,
  optimisticMessageAt: string,
  previousConversation: ConversationResponse | null,
  previousIndex: number,
): ConversationResponse[] {
  const optimisticIndex = conversations.findIndex(
    (conversation) => conversation.collaboration_id === collaborationId,
  );
  if (
    optimisticIndex === -1 ||
    conversations[optimisticIndex].last_message_at !== optimisticMessageAt
  ) {
    return conversations;
  }

  const withoutOptimistic = conversations.filter(
    (conversation) => conversation.collaboration_id !== collaborationId,
  );
  if (!previousConversation) return withoutOptimistic;

  const insertAt = Math.max(0, Math.min(previousIndex, withoutOptimistic.length));
  return [
    ...withoutOptimistic.slice(0, insertAt),
    previousConversation,
    ...withoutOptimistic.slice(insertAt),
  ];
}
