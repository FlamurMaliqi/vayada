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

export type PmsInboxEmailReplyRoute =
  | { state: "ready"; channel: "email"; providerChannel: null; reasonCode: null }
  | {
      state: "held";
      channel: null;
      providerChannel: null;
      reasonCode:
        "guest_email_unavailable" | "approved_sender_unavailable" | "email_policy_disallowed";
    };

export type PmsInboxEmailReplyRouteReadPort = {
  resolveReplyRoutes(input: {
    propertyId: string;
    threads: readonly { threadId: string; guestEmail: string | null }[];
  }): Promise<
    readonly {
      propertyId: string;
      threadId: string;
      route: PmsInboxEmailReplyRoute;
    }[]
  >;
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

export type PmsInboxAttachment =
  | {
      id: string;
      availability: "available";
      mediaId: string;
      filename: string;
      contentType: string;
      size: number;
      accessPath: `/api/media/${string}`;
    }
  | {
      id: string;
      availability: "unavailable";
      mediaId: string | null;
      filename: string | null;
      contentType: string | null;
      size: number | null;
      accessPath: null;
    };

export type PmsInboxMessage = {
  id: string;
  direction: "inbound" | "outbound";
  sender: { type: "guest" | "property_user" | "channel" | "system"; name: string | null };
  text: string | null;
  occurredAt: string;
  readAt: string | null;
  attachments: PmsInboxAttachment[];
  delivery: null | {
    state: "queued" | "retrying" | "sent" | "held" | "failed";
    channel: "ota" | "email" | null;
    reasonCode: string | null;
    providerAcknowledgedAt: string | null;
  };
};

export type PmsInboxTimelineItem =
  | { kind: "message"; message: PmsInboxMessage }
  | {
      kind: "internal_note";
      note: {
        id: string;
        author: { membershipId: string; displayName: string };
        text: string;
        occurredAt: string;
      };
    };

export type PmsInboxReadError = {
  code: "invalid_cursor" | "thread_not_found";
  message: string;
};
export type PmsInboxPortResult<T> =
  { ok: true; value: T } | { ok: false; error: PmsInboxReadError };

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
  getThread(input: {
    propertyId: string;
    threadId: string;
    canReadGuestContact: boolean;
    messageLimit: number;
    before?: string;
  }): Promise<
    PmsInboxPortResult<{
      propertyId: string;
      thread: PmsInboxThreadSummary;
      availableProviderActions: readonly "booking_com_no_reply_needed"[];
      timeline: readonly { propertyId: string; threadId: string; item: PmsInboxTimelineItem }[];
      previousCursor: string | null;
    }>
  >;
  unreadCount(propertyId: string): Promise<{
    propertyId: string;
    threadCount: number;
    messageCount: number;
  }>;
  close?(): Promise<void>;
};

export type PmsInboxMarkReadPort = {
  markRead(input: {
    propertyId: string;
    threadId: string;
    organizationId: string;
    actorUserId: string;
    actorMembershipId: string;
    idempotencyKey: string;
    readThroughMessageId: string;
    audit: { requestId: string; correlationId: string; requestedAt: string };
  }): Promise<
    | {
        ok: true;
        value: {
          propertyId: string;
          threadId: string;
          readThroughMessageId: string;
          unreadCount: number;
        };
      }
    | {
        ok: false;
        error: {
          code: "validation_failed" | "thread_not_found" | "idempotency_conflict";
          message: string;
        };
      }
  >;
  close?(): Promise<void>;
};

export type PmsInboxTriageAction = "done" | "follow_up" | "reopen";

export type PmsInboxTriagePort = {
  transition(input: {
    propertyId: string;
    threadId: string;
    organizationId: string;
    actorUserId: string;
    actorMembershipId: string;
    action: PmsInboxTriageAction;
    idempotencyKey: string;
    expectedThreadVersion: number;
    followUpAt: string | null;
    audit: { requestId: string; correlationId: string; requestedAt: string };
  }): Promise<
    | {
        ok: true;
        value: {
          propertyId: string;
          threadId: string;
          attentionState: "needs_attention" | "follow_up" | "done";
          followUpAt: string | null;
          threadVersion: number;
        };
      }
    | {
        ok: false;
        error: {
          code:
            | "validation_failed"
            | "thread_not_found"
            | "thread_version_conflict"
            | "idempotency_conflict";
          message: string;
          currentVersion?: number;
        };
      }
  >;
  close?(): Promise<void>;
};

export type PmsInboxStaffCommandError = {
  code:
    "validation_failed" | "thread_not_found" | "thread_version_conflict" | "idempotency_conflict";
  message: string;
  currentVersion?: number;
};

export type PmsInboxStaffCommandPort = {
  assign(input: {
    propertyId: string;
    threadId: string;
    organizationId: string;
    actorUserId: string;
    actorMembershipId: string;
    idempotencyKey: string;
    expectedThreadVersion: number;
    assigneeMembershipId: string | null;
    audit: { requestId: string; correlationId: string; requestedAt: string };
  }): Promise<
    | {
        ok: true;
        value: {
          propertyId: string;
          threadId: string;
          assignedTo: null | { membershipId: string; displayName: string };
          threadVersion: number;
        };
      }
    | { ok: false; error: PmsInboxStaffCommandError }
  >;
  addNote(input: {
    propertyId: string;
    threadId: string;
    organizationId: string;
    actorUserId: string;
    actorMembershipId: string;
    idempotencyKey: string;
    expectedThreadVersion: number;
    text: string;
    audit: { requestId: string; correlationId: string; requestedAt: string };
  }): Promise<
    | {
        ok: true;
        value: {
          propertyId: string;
          threadId: string;
          note: Extract<PmsInboxTimelineItem, { kind: "internal_note" }>["note"];
          threadVersion: number;
        };
      }
    | { ok: false; error: PmsInboxStaffCommandError }
  >;
  close?(): Promise<void>;
};

export type PmsInboxQuickReply = {
  propertyId: string;
  id: string;
  name: string;
  text: string;
  approvedVariables: readonly string[];
  version: number;
  createdAt: string;
  updatedAt: string;
};

export type PmsInboxQuickReplyError = {
  code:
    | "validation_failed"
    | "quick_reply_not_found"
    | "quick_reply_version_conflict"
    | "quick_reply_name_conflict"
    | "thread_not_found"
    | "idempotency_conflict";
  message: string;
  currentVersion?: number;
};

type PmsInboxQuickReplyActor = {
  propertyId: string;
  organizationId: string;
  actorUserId: string;
  actorMembershipId: string;
  audit: { requestId: string; correlationId: string; requestedAt: string };
};

type PmsInboxQuickReplyMutation = PmsInboxQuickReplyActor & { idempotencyKey: string };

export type PmsInboxQuickReplyPort = {
  list(input: { propertyId: string }): Promise<readonly PmsInboxQuickReply[]>;
  create(
    input: PmsInboxQuickReplyMutation & {
      name: string;
      text: string;
      approvedVariables: readonly string[];
    },
  ): Promise<
    | { ok: true; value: { propertyId: string; quickReply: PmsInboxQuickReply } }
    | { ok: false; error: PmsInboxQuickReplyError }
  >;
  update(
    input: PmsInboxQuickReplyMutation & {
      quickReplyId: string;
      expectedVersion: number;
      name: string;
      text: string;
      approvedVariables: readonly string[];
    },
  ): Promise<
    | { ok: true; value: { propertyId: string; quickReply: PmsInboxQuickReply } }
    | { ok: false; error: PmsInboxQuickReplyError }
  >;
  archive(
    input: PmsInboxQuickReplyMutation & {
      quickReplyId: string;
      expectedVersion: number;
    },
  ): Promise<
    | {
        ok: true;
        value: {
          propertyId: string;
          quickReplyId: string;
          version: number;
          archivedAt: string;
        };
      }
    | { ok: false; error: PmsInboxQuickReplyError }
  >;
  preview(input: PmsInboxQuickReplyMutation & { quickReplyId: string; threadId: string }): Promise<
    | {
        ok: true;
        value: {
          propertyId: string;
          quickReplyId: string;
          threadId: string;
          renderedText: string;
          unresolvedVariables: readonly string[];
          composerUseAllowed: boolean;
        };
      }
    | { ok: false; error: PmsInboxQuickReplyError }
  >;
  close?(): Promise<void>;
};

export type PmsInboxReplyError = {
  code:
    | "validation_failed"
    | "thread_not_found"
    | "thread_version_conflict"
    | "idempotency_conflict"
    | "attachment_too_large"
    | "unsupported_attachment_type";
  message: string;
  currentVersion?: number;
};

export type PmsInboxReplyPort = {
  reply(input: {
    propertyId: string;
    threadId: string;
    organizationId: string;
    actorUserId: string;
    actorMembershipId: string;
    idempotencyKey: string;
    expectedThreadVersion: number;
    text: string | null;
    attachmentMediaIds: readonly string[];
    audit: {
      requestId: string;
      correlationId: string;
      requestedAt: string;
    };
  }): Promise<
    | {
        ok: true;
        value: {
          propertyId: string;
          threadId: string;
          messageId: string;
          threadVersion: number;
          delivery: NonNullable<PmsInboxMessage["delivery"]>;
          acceptedAt: string;
        };
      }
    | { ok: false; error: PmsInboxReplyError }
  >;
  close?(): Promise<void>;
};
