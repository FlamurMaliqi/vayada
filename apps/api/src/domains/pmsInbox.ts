export const NATIVE_GUEST_INBOX_CONTRACT_VERSION = "native-guest-inbox.v2" as const;

export type PmsInboxReplyRoute =
  | { state: "ready"; channel: "ota" | "email"; providerChannel: string | null; reasonCode: null }
  | {
      state: "held";
      channel: null;
      providerChannel: string | null;
      reasonCode:
        | "channel_connection_inactive"
        | "provider_conversation_unavailable"
        | "guest_email_unavailable"
        | "approved_sender_unavailable"
        | "email_policy_disallowed";
    };

export type PmsInboxConversationContext =
  | { state: "linked"; bookingId: string; reference: string }
  | {
      state: "inquiry";
      bookingId: null;
      sourceReference: string;
      arrivalDate: string | null;
      departureDate: string | null;
    }
  | { state: "unlinked"; bookingId: null; sourceReference: string | null };

export type PmsInboxThreadSummary = {
  id: string;
  version: number;
  attentionState: "needs_attention" | "follow_up" | "done";
  followUpAt: string | null;
  assignedTo: null | { membershipId: string; displayName: string };
  channel: "ota" | "email";
  providerChannel: string | null;
  guest: { displayName: string | null; email?: string; phone?: string };
  conversationContext: PmsInboxConversationContext;
  unreadCount: number;
  activityAt: string;
  lastMessage: { preview: string | null; at: string | null; hasAttachments: boolean };
  replyRoute: PmsInboxReplyRoute;
};

export type PmsInboxPortError = {
  code: "invalid_cursor";
  message: string;
};
export type PmsInboxPortResult<T> =
  { ok: true; value: T } | { ok: false; error: PmsInboxPortError };

export type PmsInboxReadPort = {
  listThreads(input: {
    propertyId: string;
    actorMembershipId: string;
    canReadGuestContact: boolean;
    attentionState?: "needs_attention" | "follow_up" | "done";
    unread?: boolean;
    channel?: "ota" | "email";
    assignee?: string;
    search?: string;
    limit: number;
    cursor?: string;
  }): Promise<
    PmsInboxPortResult<{
      propertyId: string;
      items: readonly { propertyId: string; thread: PmsInboxThreadSummary }[];
      nextCursor: string | null;
    }>
  >;
  unreadCount(propertyId: string): Promise<{
    propertyId: string;
    threadCount: number;
    messageCount: number;
  }>;
  close?(): Promise<void>;
};
